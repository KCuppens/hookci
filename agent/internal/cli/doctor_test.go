package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/KCuppens/hookci/agent/internal/clock"
	"github.com/KCuppens/hookci/agent/internal/doctor"
	"github.com/KCuppens/hookci/agent/internal/execx"
	"github.com/KCuppens/hookci/agent/internal/store"
)

// runDoctorCLI runs hookci doctor in wd, a fresh temp dir when empty,
// against an empty host whose hub is srv.
func runDoctorCLI(t *testing.T, srv *httptest.Server, wd string, args ...string) (int, string, string) {
	t.Helper()
	return runDoctorCLIOn(t, srv, wd, fstest.MapFS{}, nil, args...)
}

// runDoctorCLIOn is runDoctorCLI on a host with files hostFS whose
// installations ran the repositories repos says.
func runDoctorCLIOn(t *testing.T, srv *httptest.Server, wd string, hostFS fstest.MapFS, repos map[string][]store.RepoConfig, args ...string) (int, string, string) {
	t.Helper()
	if wd == "" {
		wd = t.TempDir()
	}
	var stdout, stderr bytes.Buffer
	code := MainWithDeps(append([]string{"doctor"}, args...), &stdout, &stderr, func(g Globals, w io.Writer) Deps {
		d := DefaultDeps(g, w)
		d.Getwd = func() (string, error) { return wd, nil }
		d.Doctor = func(stateRoot, hubOrigin string) doctor.Env {
			return doctor.Env{
				StateRoot: stateRoot,
				HubOrigin: hubOrigin,
				HTTP:      srv.Client(),
				Clock:     clock.NewFake(time.Now()),
				Exec:      &execx.Fake{},
				FS:        hostFS,
				Systemd:   &fakeServices{},
				DiskFree:  func(string) (uint64, error) { return 10 << 30, nil },
				Writable:  func(string) error { return nil },
				RepoConfigs: func(_ context.Context, stateDir string) ([]store.RepoConfig, error) {
					return repos[stateDir], nil
				},
			}
		}
		return d
	})
	return code, stdout.String(), stderr.String()
}

func TestDoctorForkTrust(t *testing.T) {
	srv := httptest.NewTLSServer(http.NotFoundHandler())
	defer srv.Close()
	host := fstest.MapFS{
		"var/lib/hookci/42":            {Mode: fs.ModeDir | 0o700},
		"var/lib/hookci/42/agent.json": {Data: []byte(`{"hub_url":"` + srv.URL + `","agent_id":"agt_1","credential":"hci_agent_x","installation_id":42}`), Mode: 0o600},
	}
	const open = "trust: all lets any fork PR run on this machine without approval"
	const ignored = " and is ignored by the hub because deployments are configured"
	tests := []struct {
		name  string
		repos []store.RepoConfig
		want  []string
	}{
		{"trust all", []store.RepoConfig{{Repo: "acme/web", Trust: "all"}}, []string{"repo acme/web: " + open + "\n"}},
		{"trust all with deployments", []store.RepoConfig{{Repo: "acme/web", Trust: "all", HasDeployments: true}}, []string{"repo acme/web: " + open + ignored + "\n"}},
		{"one line per repo", []store.RepoConfig{
			{Repo: "acme/api", Trust: "all", HasDeployments: true},
			{Repo: "acme/docs", Trust: "collaborators"},
			{Repo: "acme/web", Trust: "all"},
		}, []string{"repo acme/api: " + open + ignored + "\n", "repo acme/web: " + open + "\n"}},
		{"collaborators", []store.RepoConfig{{Repo: "acme/web", Trust: "collaborators", HasDeployments: true}}, nil},
		{"no repos", nil, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, out, stderr := runDoctorCLIOn(t, srv, "", host, map[string][]store.RepoConfig{"/var/lib/hookci/42": tc.repos}, "--hub", srv.URL)
			var got []string
			for _, line := range strings.SplitAfter(out, "\n") {
				if strings.Contains(line, "fork trust") {
					got = append(got, line)
				}
			}
			if len(got) != len(tc.want) {
				t.Fatalf("fork trust lines = %q, want %d; stderr:\n%s", got, len(tc.want), stderr)
			}
			for i, line := range got {
				if !strings.HasPrefix(line, "warn ") || !strings.HasSuffix(line, tc.want[i]) {
					t.Errorf("line %d = %q, want a warn ending %q", i, line, tc.want[i])
				}
			}
		})
	}
}

// doctorJSON runs hookci doctor --json in wd and indexes the results by id.
func doctorJSON(t *testing.T, wd string) map[string]map[string]any {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	code, stdout, stderr := runDoctorCLI(t, srv, wd, "--json", "--hub", srv.URL)
	if code != ExitRunFailed {
		t.Fatalf("exit = %d, want 1 (no git, no state dir); stderr:\n%s", code, stderr)
	}
	var rs []map[string]any
	if err := json.Unmarshal([]byte(stdout), &rs); err != nil {
		t.Fatalf("stdout is not a JSON array: %v\n%s", err, stdout)
	}
	if want := len(doctor.Default()) + len(doctor.DeployChecks(doctor.DeployCheckDeps{})); len(rs) != want {
		t.Fatalf("got %d results, want %d", len(rs), want)
	}
	byID := map[string]map[string]any{}
	for _, r := range rs {
		for _, k := range []string{"id", "title", "status", "detail", "fix"} {
			if _, ok := r[k]; !ok {
				t.Errorf("result %v lacks %q", r, k)
			}
		}
		byID[r["id"].(string)] = r
	}
	return byID
}

func TestDoctorJSON(t *testing.T) {
	byID := doctorJSON(t, "")
	for id, want := range map[string]string{
		"git_present":     "fail",
		"ws_upgrade":      "pass",
		"deploy.docker":   "fail",
		"deploy.caddy":    "skip",
		"deploy.env_file": "skip",
	} {
		if s := byID[id]["status"]; s != want {
			t.Errorf("%s status = %v, want %s", id, s, want)
		}
	}
}

func TestDoctorDeployChecksReadCheckout(t *testing.T) {
	top := t.TempDir()
	route := filepath.Join(top, "routes", "web.caddy")
	mkFile(t, filepath.Join(top, ".git", "HEAD"), "ref: refs/heads/main\n")
	mkFile(t, filepath.Join(top, ".hookci.yml"), "version: 1\nchecks:\n  jobs:\n    test:\n      run: go test ./...\n"+
		"deployments:\n  staging:\n    on: { push: main }\n    strategy: compose-bluegreen\n"+
		"    compose: { project: web, service: web }\n"+
		"    route: { kind: caddy, file: "+route+" }\n"+
		"    health: { url: \"http://127.0.0.1:{port}/healthz\" }\n")

	byID := doctorJSON(t, filepath.Join(top, "sub"))
	for id, want := range map[string]string{
		"deploy.caddy":      "fail",
		"deploy.route_file": "fail",
		"deploy.env_file":   "skip",
	} {
		if s := byID[id]["status"]; s != want {
			t.Errorf("%s status = %v (%v), want %s", id, s, byID[id]["detail"], want)
		}
	}

	mkFile(t, filepath.Join(top, ".hookci.yml"), "version: 1\ndeployments: 3\n")
	byID = doctorJSON(t, top)
	if r := byID["deploy.caddy"]; r["status"] != "fail" || !strings.Contains(r["detail"].(string), ".hookci.yml") {
		t.Errorf("deploy.caddy = %v, want a config error", r)
	}
}

func TestDoctorTable(t *testing.T) {
	srv := httptest.NewTLSServer(http.NotFoundHandler())
	defer srv.Close()
	code, out, _ := runDoctorCLI(t, srv, "", "--hub", srv.URL)
	if code != ExitRunFailed || !strings.Contains(out, "STATUS") || !strings.Contains(out, "fix:") {
		t.Errorf("exit = %d, table:\n%s", code, out)
	}
}

func TestDoctorUsage(t *testing.T) {
	if code, _, _ := runDoctorCLI(t, nil, "", "extra"); code != ExitUsage {
		t.Errorf("exit = %d, want %d", code, ExitUsage)
	}
}
