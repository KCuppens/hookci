package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/agentconf"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

const (
	deployHeadSHA = "1111111111111111111111111111111111111111"
	deployLastSHA = "2222222222222222222222222222222222222222"
)

// deployRig is a checkout of acme/web with a staging blue-green deployment
// and the state dir of an agent paired with hubURL.
type deployRig struct {
	top, route string
	d          Deps
}

func newDeployRig(t *testing.T, healthURL, hubURL string) *deployRig {
	t.Helper()
	root := t.TempDir()
	r := &deployRig{top: filepath.Join(root, "web"), route: filepath.Join(root, "routes", "web.caddy")}
	zeroci := "version: 1\nchecks:\n  jobs:\n    test:\n      run: go test ./...\n" +
		"deployments:\n  staging:\n    on: { push: main }\n    strategy: compose-bluegreen\n" +
		"    compose: { project: web, service: web }\n" +
		"    route: { kind: caddy, file: " + r.route + " }\n" +
		"    health: { url: \"" + healthURL + "\" }\n"
	files := map[string]string{
		".zeroci.yml":          zeroci,
		"docker-compose.yml":   "services:\n  web:\n    build: .\n    ports:\n      - \"8080\"\n",
		".git/HEAD":            "ref: refs/heads/main\n",
		".git/refs/heads/main": deployHeadSHA + "\n",
		".git/config":          "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = git@github.com:acme/web.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n",
	}
	for name, body := range files {
		mkFile(t, filepath.Join(r.top, name), body)
	}
	r.d, _ = testDeps(t, filepath.Join(r.top, "sub"))
	if hubURL != "" {
		if err := os.MkdirAll(r.d.Globals.StateDir, 0o700); err != nil {
			t.Fatal(err)
		}
		err := agentconf.Save(r.d.Globals.StateDir, &agentconf.AgentConfig{
			HubURL: hubURL, AgentID: "agt_1", Credential: testCredential, Name: "web-host", InstallationID: 42,
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	return r
}

func mkFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (r *deployRig) run(args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := cmdDeploy(context.Background(), r.d, args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

// renderHub answers /v1/render with text and keeps the last request.
type renderHub struct {
	srv  *httptest.Server
	req  atomic.Pointer[protocol.RenderRequest]
	auth atomic.Pointer[string]
}

func newRenderHub(t *testing.T, text string) *renderHub {
	t.Helper()
	h := &renderHub{}
	h.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/render" {
			http.NotFound(w, r)
			return
		}
		auth := r.Header.Get("Authorization")
		h.auth.Store(&auth)
		var req protocol.RenderRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		h.req.Store(&req)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(protocol.RenderResponse{V: 1, Text: text, Blocks: []protocol.RenderResponseBlocksElem{}})
	}))
	t.Cleanup(h.srv.Close)
	return h
}

const validHealth = "http://127.0.0.1:{port}/health"

func TestDeployCommand_HubRender(t *testing.T) {
	const text = "staging deploy of acme/web 1111111 queued: 0/8 steps"
	hub := newRenderHub(t, text)
	r := newDeployRig(t, validHealth, hub.srv.URL)

	code, stdout, stderr := r.run("staging", "--dry-run")
	if code != ExitOK {
		t.Fatalf("exit %d, stderr:\n%s", code, stderr)
	}
	lines := strings.Split(strings.TrimSuffix(stdout, "\n"), "\n")
	if got := lines[len(lines)-1]; got != "badge: "+text {
		t.Errorf("last line %q, want the hub's badge text", got)
	}

	// Sections come in deploy order.
	order := []string{
		"deploy staging (dry run): compose-bluegreen\n",
		"  1. build\n",
		"active color: none\ntarget color: blue\ntarget port: 20000\n",
		"image: web:1111111\n",
		"override:\n",
		"route diff:\n",
		"+reverse_proxy 127.0.0.1:20000\n",
		"badge: ",
	}
	at := 0
	for _, want := range order {
		i := strings.Index(stdout[at:], want)
		if i < 0 {
			t.Fatalf("output lacks %q after offset %d:\n%s", want, at, stdout)
		}
		at += i + len(want)
	}

	req := hub.req.Load()
	if req == nil {
		t.Fatal("hub got no render request")
	}
	if *hub.auth.Load() != "Bearer "+testCredential {
		t.Errorf("Authorization %q, want the agent credential", *hub.auth.Load())
	}
	steps := len(regexp.MustCompile(`(?m)^  \d+\. `).FindAllString(stdout, -1))
	if req.V != 1 || req.Kind != "deploy_badge" || req.Repo != "acme/web" || req.Env != "staging" ||
		req.Sha != deployHeadSHA || req.State != protocol.RenderRequestStateQueued ||
		req.StepsTotal == nil || *req.StepsTotal != steps {
		t.Errorf("render request %+v, want a queued deploy_badge of acme/web staging at HEAD with %d steps", req, steps)
	}
	if _, err := os.Stat(filepath.Join(r.d.Globals.StateDir, "agent.db")); !os.IsNotExist(err) {
		t.Errorf("dry run created the state store: %v", err)
	}
}

func TestDeployCommand_HubOffline(t *testing.T) {
	hub := httptest.NewServer(http.NotFoundHandler())
	hubURL := hub.URL
	hub.Close()
	r := newDeployRig(t, validHealth, hubURL)

	code, stdout, stderr := r.run("staging", "--dry-run")
	if code != ExitOK {
		t.Fatalf("exit %d, stderr:\n%s", code, stderr)
	}
	if !strings.HasPrefix(stdout, "deploy staging (dry run): compose-bluegreen\n") {
		t.Errorf("preview missing when the hub is offline:\n%s", stdout)
	}
	if !strings.HasSuffix(stdout, "badge preview unavailable: hub offline\n") {
		t.Errorf("stdout does not end with the offline note:\n%s", stdout)
	}
}

func TestDeployCommand_NoDryRun(t *testing.T) {
	hub := newRenderHub(t, "unused")
	r := newDeployRig(t, validHealth, hub.srv.URL)

	code, stdout, stderr := r.run("staging")
	if code != ExitUsage {
		t.Errorf("exit %d, want %d", code, ExitUsage)
	}
	if want := "deploy: only --dry-run is supported; deploys start from a push or zeroci retry\n"; stderr != want {
		t.Errorf("stderr %q, want %q", stderr, want)
	}
	if stdout != "" || hub.req.Load() != nil {
		t.Errorf("printed %q or asked the hub without --dry-run", stdout)
	}
}

func TestDeployCommand_InvalidConfig(t *testing.T) {
	r := newDeployRig(t, "http://127.0.0.1:8000/health", "")

	code, stdout, stderr := r.run("staging", "--dry-run")
	if code != ExitUsage {
		t.Errorf("exit %d, want %d", code, ExitUsage)
	}
	if want := "deployments.staging.health.url: must contain {port}; add {port} to the health URL\n"; !strings.Contains(stderr, want) {
		t.Errorf("stderr %q lacks %q", stderr, want)
	}
	if stdout != "" {
		t.Errorf("printed a preview of an invalid config:\n%s", stdout)
	}
}

// Without --sha the preview shows the commit last deployed to the env, and
// --sha overrides it.
func TestDeployCommand_SHADefaultsToLastDeployed(t *testing.T) {
	hub := newRenderHub(t, "badge")
	r := newDeployRig(t, validHealth, hub.srv.URL)
	db := openState(t, r.d)
	if err := db.SetDeployState(context.Background(), store.DeployState{Repo: "acme/web", Env: "staging", LastSuccessSHA: deployLastSHA}); err != nil {
		t.Fatal(err)
	}

	if code, stdout, stderr := r.run("staging", "--dry-run"); code != ExitOK || !strings.Contains(stdout, "image: web:2222222\n") {
		t.Fatalf("exit %d, stdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	if got := hub.req.Load().Sha; got != deployLastSHA {
		t.Errorf("badge sha %s, want last_success_sha %s", got, deployLastSHA)
	}

	const pinned = "3333333333333333333333333333333333333333"
	if code, _, stderr := r.run("--sha", pinned, "staging", "--dry-run"); code != ExitOK {
		t.Fatalf("exit %d, stderr:\n%s", code, stderr)
	}
	if got := hub.req.Load().Sha; got != pinned {
		t.Errorf("badge sha %s, want --sha %s", got, pinned)
	}
}

func TestDeployCommand_RepoFromFlagOrOrigin(t *testing.T) {
	hub := newRenderHub(t, "badge")
	r := newDeployRig(t, validHealth, hub.srv.URL)

	if code, _, stderr := r.run("staging", "--dry-run", "--repo", "acme/other"); code != ExitOK {
		t.Fatalf("exit %d, stderr:\n%s", code, stderr)
	}
	if got := hub.req.Load().Repo; got != "acme/other" {
		t.Errorf("repo %q, want --repo acme/other", got)
	}

	mkFile(t, filepath.Join(r.top, ".git/config"), "[core]\n\tbare = false\n")
	code, _, stderr := r.run("staging", "--dry-run")
	if code != ExitUsage || !strings.Contains(stderr, "pass --repo owner/name") {
		t.Errorf("exit %d, stderr %q; want usage error asking for --repo", code, stderr)
	}
}

// HEAD resolves through packed-refs, and a linked worktree's .git file
// leads to its git dir and the main repository's refs.
func TestHeadSHA_PackedRefsAndWorktree(t *testing.T) {
	root := t.TempDir()
	main := filepath.Join(root, "repo")
	mkFile(t, filepath.Join(main, ".git/HEAD"), "ref: refs/heads/main\n")
	mkFile(t, filepath.Join(main, ".git/packed-refs"),
		"# pack-refs with: peeled fully-peeled sorted\n"+deployLastSHA+" refs/heads/dev\n"+deployHeadSHA+" refs/heads/main\n")
	wt := filepath.Join(root, "wt")
	mkFile(t, filepath.Join(wt, ".git"), "gitdir: "+filepath.Join(main, ".git/worktrees/wt")+"\n")
	mkFile(t, filepath.Join(main, ".git/worktrees/wt/HEAD"), "ref: refs/heads/dev\n")
	mkFile(t, filepath.Join(main, ".git/worktrees/wt/commondir"), "../..\n")

	for _, tc := range []struct{ dir, want string }{{main, deployHeadSHA}, {wt, deployLastSHA}} {
		_, gitDir, err := gitCheckout(tc.dir)
		if err != nil {
			t.Fatalf("gitCheckout(%s): %v", tc.dir, err)
		}
		got, err := headSHA(gitDir)
		if err != nil || got != tc.want {
			t.Errorf("headSHA(%s) = %q, %v; want %s", gitDir, got, err, tc.want)
		}
	}
}
