package cli

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/clock"
	"github.com/KCuppens/zerocideploy/agent/internal/doctor"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

// runDoctorCLI runs zeroci doctor against an empty host whose hub is srv,
// and returns the origin doctor was given.
func runDoctorCLI(t *testing.T, srv *httptest.Server, args ...string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := MainWithDeps(append([]string{"doctor"}, args...), &stdout, &stderr, func(g Globals, w io.Writer) Deps {
		d := DefaultDeps(g, w)
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
			}
		}
		return d
	})
	return code, stdout.String(), stderr.String()
}

func TestDoctorJSON(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	code, stdout, stderr := runDoctorCLI(t, srv, "--json", "--hub", srv.URL)
	if code != ExitRunFailed {
		t.Fatalf("exit = %d, want 1 (no git, no state dir); stderr:\n%s", code, stderr)
	}
	var rs []map[string]any
	if err := json.Unmarshal([]byte(stdout), &rs); err != nil {
		t.Fatalf("stdout is not a JSON array: %v\n%s", err, stdout)
	}
	if len(rs) != len(doctor.Default()) {
		t.Fatalf("got %d results, want %d", len(rs), len(doctor.Default()))
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
	if s := byID["git_present"]["status"]; s != "fail" {
		t.Errorf("git_present status = %v, want fail", s)
	}
	if s := byID["ws_upgrade"]["status"]; s != "pass" {
		t.Errorf("ws_upgrade status = %v, want pass against a 401 hub", s)
	}
}

func TestDoctorTable(t *testing.T) {
	srv := httptest.NewTLSServer(http.NotFoundHandler())
	defer srv.Close()
	code, out, _ := runDoctorCLI(t, srv, "--hub", srv.URL)
	if code != ExitRunFailed || !strings.Contains(out, "STATUS") || !strings.Contains(out, "fix:") {
		t.Errorf("exit = %d, table:\n%s", code, out)
	}
}

func TestDoctorUsage(t *testing.T) {
	if code, _, _ := runDoctorCLI(t, nil, "extra"); code != ExitUsage {
		t.Errorf("exit = %d, want %d", code, ExitUsage)
	}
}
