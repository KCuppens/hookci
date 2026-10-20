package doctor

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"syscall"
	"testing"
	"testing/fstest"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/clock"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/version"
)

var now = time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)

const agentJSON = `{"hub_url":"https://hub","agent_id":"agt_1","credential":"zc_agent_x","name":"b","installation_id":42}`

// fakeHub serves /healthz with a Date header dateOffset from now and
// /v1/agent/connect the way the hub does: 426 without Upgrade, else 401.
func fakeHub(t *testing.T, dateOffset time.Duration, healthStatus int, tls bool) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Date", now.Add(dateOffset).Format(http.TimeFormat))
		w.WriteHeader(healthStatus)
	})
	mux.HandleFunc("GET /v1/agent/connect", func(w http.ResponseWriter, r *http.Request) {
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			w.WriteHeader(http.StatusUpgradeRequired)
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
	})
	srv := httptest.NewUnstartedServer(mux)
	// The untrusted-certificate case makes the server log a handshake error.
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	if tls {
		srv.StartTLS()
	} else {
		srv.Start()
	}
	t.Cleanup(srv.Close)
	return srv
}

func healthyFS() fstest.MapFS {
	return fstest.MapFS{
		"var/lib/zeroci":               {Mode: fs.ModeDir | 0o700, Sys: &syscall.Stat_t{Uid: 0}},
		"var/lib/zeroci/42":            {Mode: fs.ModeDir | 0o700},
		"var/lib/zeroci/42/agent.json": {Data: []byte(agentJSON), Mode: 0o600},
		"etc/passwd":                   {Data: []byte("root:x:0:0::/root:/bin/sh\nzeroci-run:x:998:998::/nonexistent:/usr/sbin/nologin\n")},
	}
}

type fakeSystemd struct {
	state string
	err   error
}

func (f fakeSystemd) UnitExists(context.Context, string) (bool, error) { return true, nil }
func (f fakeSystemd) EnableNow(context.Context, string) error          { return nil }
func (f fakeSystemd) TryRestart(context.Context, string) error         { return nil }
func (f fakeSystemd) ActiveState(_ context.Context, unit string) (string, error) {
	return f.state, f.err
}

func healthyExec() *execx.Fake {
	ex := &execx.Fake{}
	ex.On("zeroci", []string{"version"}, execx.FakeResponse{Stdout: version.String() + "\n"})
	ex.On("git", []string{"--version"}, execx.FakeResponse{Stdout: "git version 2.39.2\n"})
	return ex
}

// healthyEnv passes every check against srv.
func healthyEnv(srv *httptest.Server) Env {
	return Env{
		StateRoot: "/var/lib/zeroci",
		HubOrigin: srv.URL,
		HTTP:      srv.Client(),
		Clock:     clock.NewFake(now),
		Exec:      healthyExec(),
		FS:        healthyFS(),
		Systemd:   fakeSystemd{state: "active"},
		DiskFree:  func(string) (uint64, error) { return 10 << 30, nil },
	}
}

func runOne(t *testing.T, c Check, env Env) Result {
	t.Helper()
	rs := Run(context.Background(), env, []Check{c})
	if len(rs) != 1 || rs[0].ID != c.ID() {
		t.Fatalf("Run = %+v", rs)
	}
	return rs[0]
}

func TestDefaultAllPassOnHealthyHost(t *testing.T) {
	srv := fakeHub(t, 0, http.StatusOK, true)
	rs := Run(context.Background(), healthyEnv(srv), Default())
	want := []string{"version", "systemd_unit", "state_dir_perms", "credential_present", "zeroci_run_user", "git_present", "disk_space", "hub_reachable", "hub_tls", "clock_skew", "ws_upgrade"}
	if len(rs) != len(want) {
		t.Fatalf("got %d results, want %d", len(rs), len(want))
	}
	for i, r := range rs {
		if r.ID != want[i] {
			t.Errorf("result %d id = %q, want %q", i, r.ID, want[i])
		}
		if r.Status != Pass {
			t.Errorf("%s = %s (%s), want pass", r.ID, r.Status, r.Detail)
		}
	}
	var out bytes.Buffer
	if Render(&out, rs) {
		t.Errorf("Render reported a failure:\n%s", out.String())
	}
}

func TestChecksWarnOrFail(t *testing.T) {
	tlsHub := fakeHub(t, 0, http.StatusOK, true)
	tests := []struct {
		name   string
		check  Check
		mutate func(*Env)
		want   Status
		detail string
	}{
		{"version mismatch", versionCheck{}, func(e *Env) {
			ex := &execx.Fake{}
			ex.On("zeroci", []string{"version"}, execx.FakeResponse{Stdout: "zeroci v0.0.1\n"})
			e.Exec = ex
		}, Warn, "zeroci v0.0.1"},
		{"version missing", versionCheck{}, func(e *Env) { e.Exec = &execx.Fake{} }, Fail, "zeroci version"},
		{"unit failed", systemdUnitCheck{}, func(e *Env) { e.Systemd = fakeSystemd{state: "failed"} }, Fail, "zeroci-agent@42.service is failed"},
		{"unit unpaired", systemdUnitCheck{}, func(e *Env) { delete(e.FS.(fstest.MapFS), "var/lib/zeroci/42/agent.json") }, Warn, "no paired installation"},
		{"state dir mode", stateDirPermsCheck{}, func(e *Env) {
			e.FS.(fstest.MapFS)["var/lib/zeroci"] = &fstest.MapFile{Mode: fs.ModeDir | 0o755, Sys: &syscall.Stat_t{Uid: 0}}
		}, Fail, "mode 0755"},
		{"state dir owner", stateDirPermsCheck{}, func(e *Env) {
			e.FS.(fstest.MapFS)["var/lib/zeroci"] = &fstest.MapFile{Mode: fs.ModeDir | 0o700, Sys: &syscall.Stat_t{Uid: 1000}}
		}, Fail, "uid 1000"},
		{"state dir missing", stateDirPermsCheck{}, func(e *Env) { e.StateRoot = "/nope" }, Fail, "/nope"},
		{"credential missing", credentialCheck{}, func(e *Env) { delete(e.FS.(fstest.MapFS), "var/lib/zeroci/42/agent.json") }, Fail, "no agent.json"},
		{"credential empty", credentialCheck{}, func(e *Env) {
			e.FS.(fstest.MapFS)["var/lib/zeroci/42/agent.json"] = &fstest.MapFile{Data: []byte(`{"agent_id":"agt_1","installation_id":42}`)}
		}, Fail, "has no credential"},
		{"credential readable by others", credentialCheck{}, func(e *Env) {
			e.FS.(fstest.MapFS)["var/lib/zeroci/42/agent.json"].Mode = 0o644
		}, Fail, "/var/lib/zeroci/42/agent.json has mode 0644, want 0600"},
		{"run user missing", runUserCheck{}, func(e *Env) {
			e.FS.(fstest.MapFS)["etc/passwd"] = &fstest.MapFile{Data: []byte("root:x:0:0::/root:/bin/sh\n")}
		}, Fail, "no zeroci-run user"},
		{"git old", gitCheck{}, func(e *Env) {
			ex := &execx.Fake{}
			ex.On("git", []string{"--version"}, execx.FakeResponse{Stdout: "git version 2.29.9"})
			e.Exec = ex
		}, Fail, "older than 2.30"},
		{"git missing", gitCheck{}, func(e *Env) { e.Exec = &execx.Fake{} }, Fail, "git --version"},
		{"disk low", diskSpaceCheck{}, func(e *Env) { e.DiskFree = func(string) (uint64, error) { return 1 << 30, nil } }, Warn, "1.0 GiB free"},
		{"disk unknown", diskSpaceCheck{}, func(e *Env) { e.DiskFree = func(string) (uint64, error) { return 0, errors.New("statfs") } }, Warn, "statfs"},
		{"hub 503", hubReachableCheck{}, func(e *Env) {
			srv := fakeHub(t, 0, http.StatusServiceUnavailable, true)
			e.HubOrigin, e.HTTP = srv.URL, srv.Client()
		}, Fail, "answered 503"},
		{"hub down", hubReachableCheck{}, func(e *Env) { e.HubOrigin = "https://127.0.0.1:1" }, Fail, "127.0.0.1:1"},
		{"tls untrusted", hubTLSCheck{}, func(e *Env) { e.HTTP = &http.Client{} }, Fail, "certificate"},
		{"tls plain http", hubTLSCheck{}, func(e *Env) {
			srv := fakeHub(t, 0, http.StatusOK, false)
			e.HubOrigin, e.HTTP = srv.URL, srv.Client()
		}, Warn, "not HTTPS"},
		{"tls expiring", hubTLSCheck{}, func(e *Env) { e.Clock = clock.NewFake(tlsHub.Certificate().NotAfter.Add(-time.Hour)) }, Warn, "expires"},
		{"ws upgrade stripped", wsUpgradeCheck{}, func(e *Env) {
			// A proxy that drops Upgrade turns the handshake into a plain GET.
			e.HTTP = &http.Client{Transport: dropUpgrade{e.HTTP.Transport}}
		}, Fail, "426"},
		{"ws hub down", wsUpgradeCheck{}, func(e *Env) { e.HubOrigin = "https://127.0.0.1:1" }, Fail, "127.0.0.1:1"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			env := healthyEnv(tlsHub)
			tc.mutate(&env)
			r := runOne(t, tc.check, env)
			if r.Status != tc.want || !strings.Contains(r.Detail, tc.detail) {
				t.Errorf("%s = %s %q, want %s containing %q", tc.check.ID(), r.Status, r.Detail, tc.want, tc.detail)
			}
			if r.Fix == "" {
				t.Errorf("%s %s has no fix", tc.check.ID(), r.Status)
			}
		})
	}
}

// dropUpgrade is a proxy transport that strips the WebSocket upgrade.
type dropUpgrade struct{ next http.RoundTripper }

func (d dropUpgrade) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Del("Upgrade")
	r.Header.Del("Connection")
	return d.next.RoundTrip(r)
}

func TestClockSkewThresholds(t *testing.T) {
	tests := []struct {
		offset time.Duration
		want   Status
	}{
		{0, Pass},
		{30 * time.Second, Pass},
		{31 * time.Second, Warn},
		{-31 * time.Second, Warn},
		{300 * time.Second, Warn},
		{301 * time.Second, Fail},
		{-301 * time.Second, Fail},
	}
	for _, tc := range tests {
		srv := fakeHub(t, tc.offset, http.StatusOK, true)
		r := runOne(t, clockSkewCheck{}, healthyEnv(srv))
		if r.Status != tc.want {
			t.Errorf("skew %s = %s (%s), want %s", tc.offset, r.Status, r.Detail, tc.want)
		}
	}
}

func TestRenderTable(t *testing.T) {
	var out bytes.Buffer
	failed := Render(&out, []Result{
		{ID: "git_present", Title: "git", Status: Pass, Detail: "git version 2.39.2"},
		{ID: "disk_space", Title: "disk space", Status: Warn, Detail: "1.0 GiB free", Fix: "free space"},
		{ID: "hub_reachable", Title: "hub reachable", Status: Fail, Detail: "refused", Fix: "check DNS"},
		{ID: "deploy.caddy", Title: "caddy", Status: Skip, Detail: "no deployment routes through caddy"},
	})
	if !failed {
		t.Error("Render = false with a failed check")
	}
	want := "STATUS  CHECK          DETAIL\n" +
		"pass    git            git version 2.39.2\n" +
		"warn    disk space     1.0 GiB free\n" +
		"                       fix: free space\n" +
		"fail    hub reachable  refused\n" +
		"                       fix: check DNS\n" +
		"skip    caddy          no deployment routes through caddy\n"
	if out.String() != want {
		t.Errorf("table =\n%s\nwant\n%s", out.String(), want)
	}
	if Render(&bytes.Buffer{}, []Result{{Status: Warn}, {Status: Skip}}) {
		t.Error("Render = true with only a warning and a skip")
	}
}
