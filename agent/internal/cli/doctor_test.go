package cli

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/clock"
	"github.com/KCuppens/zerocideploy/agent/internal/doctor"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

// runDoctorCLI runs zeroci doctor in wd, a fresh temp dir when empty,
// against an empty host whose hub is srv.
func runDoctorCLI(t *testing.T, srv *httptest.Server, wd string, args ...string) (int, string, string) {
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
				FS:        fstest.MapFS{},
				Systemd:   &fakeServices{},
				DiskFree:  func(string) (uint64, error) { return 10 << 30, nil },
				Writable:  func(string) error { return nil },
			}
		}
		return d
	})
	return code, stdout.String(), stderr.String()
}

// doctorJSON runs zeroci doctor --json in wd and indexes the results by id.
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
	mkFile(t, filepath.Join(top, ".zeroci.yml"), "version: 1\nchecks:\n  jobs:\n    test:\n      run: go test ./...\n"+
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

	mkFile(t, filepath.Join(top, ".zeroci.yml"), "version: 1\ndeployments: 3\n")
	byID = doctorJSON(t, top)
	if r := byID["deploy.caddy"]; r["status"] != "fail" || !strings.Contains(r["detail"].(string), ".zeroci.yml") {
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
