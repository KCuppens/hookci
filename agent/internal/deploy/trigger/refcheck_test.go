package trigger

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// github serves one canned response for path and records each request.
type github struct {
	t      *testing.T
	path   string // expected escaped request path, query included
	status int
	body   string
	hits   int
}

func (g *github) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	g.hits++
	if got := r.URL.RequestURI(); got != g.path {
		g.t.Errorf("request %s, want %s", got, g.path)
	}
	if got := r.Header.Get("Authorization"); got != "Bearer tok-acme/web" {
		g.t.Errorf("Authorization = %q, want the repo's bearer token", got)
	}
	w.WriteHeader(g.status)
	fmt.Fprint(w, g.body)
}

func newChecker(t *testing.T, g *github) *GitHubRefChecker {
	t.Helper()
	g.t = t
	srv := httptest.NewServer(g)
	t.Cleanup(srv.Close)
	return &GitHubRefChecker{
		BaseURL: srv.URL,
		HTTP:    srv.Client(),
		Token:   func(_ context.Context, repo string) (string, error) { return "tok-" + repo, nil },
	}
}

func TestGitHubRefChecker_IsProtected(t *testing.T) {
	for _, tc := range []struct {
		name   string
		branch string
		path   string
		status int
		body   string
		want   bool
		err    string
	}{
		{name: "protected", branch: "main", path: "/repos/acme/web/branches/main", status: 200, body: `{"name":"main","protected":true}`, want: true},
		{name: "unprotected", branch: "main", path: "/repos/acme/web/branches/main", status: 200, body: `{"name":"main","protected":false}`},
		{name: "unknown branch", branch: "main", path: "/repos/acme/web/branches/main", status: 404, body: `{"message":"Branch not found"}`},
		{name: "slashed branch keeps its slash", branch: "release/v1+x", path: "/repos/acme/web/branches/release/v1+x", status: 200, body: `{"protected":true}`, want: true},
		{name: "server error", branch: "main", path: "/repos/acme/web/branches/main", status: 502, err: "github /repos/acme/web/branches/main: 502"},
		{name: "forbidden", branch: "main", path: "/repos/acme/web/branches/main", status: 403, err: "github /repos/acme/web/branches/main: 403"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := &github{path: tc.path, status: tc.status, body: tc.body}
			got, err := newChecker(t, g).IsProtected(context.Background(), "acme/web", tc.branch)
			checkResult(t, got, tc.want, err, tc.err)
		})
	}
}

func TestGitHubRefChecker_ContainsSHA(t *testing.T) {
	const path = "/repos/acme/web/compare/main...abc123"
	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   bool
		err    string
	}{
		{name: "identical", status: 200, body: `{"status":"identical"}`, want: true},
		{name: "behind", status: 200, body: `{"status":"behind","behind_by":3}`, want: true},
		{name: "ahead", status: 200, body: `{"status":"ahead","ahead_by":1}`},
		{name: "diverged", status: 200, body: `{"status":"diverged"}`},
		{name: "unknown sha", status: 404, body: `{"message":"No commit found"}`},
		{name: "server error", status: 500, err: "github " + path + ": 500"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := &github{path: path, status: tc.status, body: tc.body}
			got, err := newChecker(t, g).ContainsSHA(context.Background(), "acme/web", "main", "abc123")
			checkResult(t, got, tc.want, err, tc.err)
		})
	}
}

func TestGitHubRefChecker_ChangedFiles(t *testing.T) {
	const path = "/repos/acme/web/compare/old...new"
	for _, tc := range []struct {
		name          string
		n             int
		wantTruncated bool
	}{
		{name: "few files", n: 2},
		{name: "just under the cap", n: 299},
		{name: "at the cap is truncated", n: 300, wantTruncated: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			type file struct {
				Filename string `json:"filename"`
				Status   string `json:"status"`
			}
			files := make([]file, tc.n)
			for i := range files {
				files[i] = file{Filename: fmt.Sprintf("dir/f%03d.go", i), Status: "modified"}
			}
			body, _ := json.Marshal(map[string]any{"status": "ahead", "files": files})
			g := &github{path: path, status: 200, body: string(body)}
			got, truncated, err := newChecker(t, g).ChangedFiles(context.Background(), "acme/web", "old", "new")
			if err != nil {
				t.Fatalf("ChangedFiles: %v", err)
			}
			if len(got) != tc.n || truncated != tc.wantTruncated {
				t.Fatalf("ChangedFiles = %d files, truncated %v; want %d, %v", len(got), truncated, tc.n, tc.wantTruncated)
			}
			if got[0] != "dir/f000.go" {
				t.Errorf("first file = %q, want dir/f000.go", got[0])
			}
		})
	}
	for _, status := range []int{404, 500} {
		t.Run(fmt.Sprintf("status %d", status), func(t *testing.T) {
			g := &github{path: path, status: status}
			_, _, err := newChecker(t, g).ChangedFiles(context.Background(), "acme/web", "old", "new")
			if want := fmt.Sprintf("github %s: %d", path, status); err == nil || err.Error() != want {
				t.Fatalf("ChangedFiles err = %v, want %q", err, want)
			}
		})
	}
}

func TestGitHubRefChecker_SendsGitHubHeaders(t *testing.T) {
	var accept string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		accept = r.Header.Get("Accept")
		fmt.Fprint(w, `{"protected":true}`)
	}))
	t.Cleanup(srv.Close)
	g := &GitHubRefChecker{BaseURL: srv.URL + "/", HTTP: srv.Client(), Token: func(context.Context, string) (string, error) { return "t", nil }}
	if _, err := g.IsProtected(context.Background(), "acme/web", "main"); err != nil {
		t.Fatal(err)
	}
	if accept != "application/vnd.github+json" {
		t.Errorf("Accept = %q, want application/vnd.github+json", accept)
	}
}

func TestGitHubRefChecker_TokenError(t *testing.T) {
	boom := errors.New("hub revoked")
	g := &github{path: "/repos/acme/web/branches/main", status: 200}
	c := newChecker(t, g)
	c.Token = func(context.Context, string) (string, error) { return "", boom }
	if _, err := c.IsProtected(context.Background(), "acme/web", "main"); !errors.Is(err, boom) {
		t.Fatalf("IsProtected err = %v, want %v", err, boom)
	}
	if g.hits != 0 {
		t.Errorf("GitHub was called %d times without a token", g.hits)
	}
}

func TestGitHubRefChecker_LoadConfig(t *testing.T) {
	const (
		sha  = "0123456789abcdef0123456789abcdef01234567"
		path = "/repos/acme/web/contents/.zeroci.yml?ref=" + sha
	)
	valid := `version: 1
checks:
  jobs:
    test:
      run: go test ./...
deployments:
  production:
    on: { push: main }
    strategy: script
    run: ./deploy.sh
`
	for _, tc := range []struct {
		name    string
		status  int
		body    string
		wantEnv bool
		err     string
	}{
		{name: "valid", status: 200, body: valid, wantEnv: true},
		{name: "no config at the commit", status: 404, body: `{"message":"Not Found"}`},
		{name: "invalid", status: 200, body: "version: 1\ndeployments:\n  production:\n    strategy: nope\n", err: ".zeroci.yml at 0123456 is invalid"},
		{name: "server error", status: 503, err: "github " + path + ": 503"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var accept string
			g := &github{path: path, status: tc.status, body: tc.body}
			g.t = t
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				accept = r.Header.Get("Accept")
				g.ServeHTTP(w, r)
			}))
			t.Cleanup(srv.Close)
			c := &GitHubRefChecker{BaseURL: srv.URL, HTTP: srv.Client(),
				Token: func(_ context.Context, repo string) (string, error) { return "tok-" + repo, nil }}
			cfg, err := c.LoadConfig(context.Background(), "acme/web", sha)
			if tc.err != "" {
				if err == nil || !strings.Contains(err.Error(), tc.err) {
					t.Fatalf("LoadConfig err = %v, want it to contain %q", err, tc.err)
				}
				return
			}
			if err != nil {
				t.Fatalf("LoadConfig: %v", err)
			}
			if accept != "application/vnd.github.raw+json" {
				t.Errorf("Accept = %q, want the raw media type", accept)
			}
			dep, ok := cfg.Deployments["production"]
			if ok != tc.wantEnv {
				t.Fatalf("production defined = %v, want %v", ok, tc.wantEnv)
			}
			if ok && dep.On.Push != "main" {
				t.Errorf("production on.push = %q, want main", dep.On.Push)
			}
		})
	}
}

func checkResult(t *testing.T, got, want bool, err error, wantErr string) {
	t.Helper()
	if wantErr != "" {
		if err == nil || err.Error() != wantErr {
			t.Fatalf("err = %v, want %q", err, wantErr)
		}
		return
	}
	if err != nil || got != want {
		t.Fatalf("got %v, %v; want %v", got, err, want)
	}
}
