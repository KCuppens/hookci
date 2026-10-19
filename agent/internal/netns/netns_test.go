package netns

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

const noSuchNS = `Cannot remove namespace file "/run/netns/zc-01j9z3": No such file or directory`

// fakePasta stands in for Manager.Start. It records the pasta command,
// optionally writes the pid file, and returns a real "sleep 30" group so
// Terminate is exercised.
type fakePasta struct {
	t        *testing.T
	writePID bool
	cmds     []execx.Cmd
	groups   []*execx.Group
}

func (f *fakePasta) start(ctx context.Context, c execx.Cmd) (*execx.Group, error) {
	f.cmds = append(f.cmds, c)
	if f.writePID {
		i := slices.Index(c.Args, "--pid")
		if i < 0 || i+1 >= len(c.Args) {
			f.t.Fatalf("pasta args lack --pid: %q", c.Args)
		}
		if err := os.WriteFile(c.Args[i+1], []byte("4242\n"), 0o600); err != nil {
			f.t.Fatal(err)
		}
	}
	g, err := execx.StartGroup(ctx, execx.Cmd{Name: "sleep", Args: []string{"30"}})
	if err != nil {
		return nil, err
	}
	f.groups = append(f.groups, g)
	f.t.Cleanup(func() { _ = g.Terminate(0) })
	return g, nil
}

// waitTerminated asserts that g has exited from SIGTERM.
func waitTerminated(t *testing.T, g *execx.Group) {
	t.Helper()
	done := make(chan int, 1)
	go func() {
		code, _ := g.Wait()
		done <- code
	}()
	select {
	case code := <-done:
		if code != 128+15 {
			t.Errorf("pasta group exit code = %d, want 143 (SIGTERM)", code)
		}
	case <-time.After(time.Second):
		t.Fatal("pasta group still running")
	}
}

func callLines(f *execx.Fake) []string {
	lines := make([]string, len(f.Calls))
	for i, c := range f.Calls {
		lines[i] = c.Name + " " + strings.Join(c.Args, " ")
	}
	return lines
}

func TestNSName(t *testing.T) {
	valid := regexp.MustCompile(`^[a-z0-9-]+$`)
	got := NSName("01J9Z3")
	if got != "zc-01j9z3" {
		t.Errorf("NSName(01J9Z3) = %q, want zc-01j9z3", got)
	}
	if !strings.HasPrefix(got, "zc-") || !valid.MatchString(got) {
		t.Errorf("NSName(01J9Z3) = %q, want zc- prefix and only [a-z0-9-]", got)
	}
	if again := NSName("01J9Z3"); again != got {
		t.Errorf("NSName not stable: %q then %q", got, again)
	}
	if got := NSName("Run_1.x:y/é"); !strings.HasPrefix(got, "zc-") || !valid.MatchString(got) {
		t.Errorf("NSName sanitizes to %q, want only [a-z0-9-]", got)
	}

	// Two run IDs from the same millisecond differ only in the random tail.
	a, b := NSName("01jabcdefg0000000000000001"), NSName("01jabcdefg0000000000000002")
	if len(a) > 15 || len(b) > 15 {
		t.Errorf("NSName too long: %q (%d), %q (%d)", a, len(a), b, len(b))
	}
	if a == b {
		t.Errorf("NSName collides for distinct run IDs: %q", a)
	}
}

func TestDecide(t *testing.T) {
	for _, tc := range []struct {
		iso                string
		trusted, available bool
		want               Mode
		warn               string
		err                error
	}{
		{"none", true, true, ModeHost, "", nil},
		{"none", false, false, ModeHost, "", nil},
		{"systemd", true, true, ModeNetns, "", nil},
		{"systemd", true, false, ModeDeny, "pasta", nil},
		{"systemd", false, true, ModeNetns, "", nil},
		{"systemd", false, false, "", "", ErrNetnsRequired},
	} {
		mode, warn, err := Decide(tc.iso, tc.trusted, tc.available)
		if !errors.Is(err, tc.err) {
			t.Errorf("Decide(%s, %v, %v) err = %v, want %v", tc.iso, tc.trusted, tc.available, err, tc.err)
		}
		if mode != tc.want {
			t.Errorf("Decide(%s, %v, %v) mode = %q, want %q", tc.iso, tc.trusted, tc.available, mode, tc.want)
		}
		if (tc.warn == "") != (warn == "") || !strings.Contains(warn, tc.warn) {
			t.Errorf("Decide(%s, %v, %v) warning = %q, want one containing %q", tc.iso, tc.trusted, tc.available, warn, tc.warn)
		}
	}
}

func TestAvailable(t *testing.T) {
	lookPath := func(missing string) func(string) (string, error) {
		return func(name string) (string, error) {
			if name == missing {
				return "", errors.New(name + ": not found")
			}
			return "/usr/bin/" + name, nil
		}
	}
	for _, tc := range []struct {
		name    string
		missing string
		euid    int
		ok      bool
		reason  string
	}{
		{"all present", "", 0, true, ""},
		{"ip missing", "ip", 0, false, "ip not found"},
		{"pasta missing", "pasta", 0, false, "pasta not found"},
		{"non-root", "", 1000, false, "not running as root"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := &Manager{LookPath: lookPath(tc.missing), euid: func() int { return tc.euid }}
			ok, reason := m.Available()
			if ok != tc.ok {
				t.Errorf("Available ok = %v, want %v (reason %q)", ok, tc.ok, reason)
			}
			if tc.reason == "" && reason != "" || !strings.Contains(reason, tc.reason) {
				t.Errorf("Available reason = %q, want one naming %q", reason, tc.reason)
			}
		})
	}
}

func TestPastaArgv(t *testing.T) {
	got := PastaArgv("/run/netns/zc-01j9z3", 41234, "/var/lib/zeroci/runs/01j9z3/pasta.pid")
	want := []string{
		"pasta", "--foreground", "--quiet", "--splice-only", "--no-map-gw",
		"-t", "none", "-u", "none", "-U", "none",
		"-T", "3128:41234",
		"--pid", "/var/lib/zeroci/runs/01j9z3/pasta.pid",
		"--netns", "/run/netns/zc-01j9z3",
	}
	if !slices.Equal(got, want) {
		t.Errorf("PastaArgv =\n%q\nwant\n%q", got, want)
	}
}

func TestSetupNetnsCommands(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("ip", nil, execx.FakeResponse{})
	pasta := &fakePasta{t: t, writePID: true}
	m := &Manager{Runner: fake, Start: pasta.start}
	pidFile := filepath.Join(t.TempDir(), "pasta.pid")

	n, err := m.Setup(context.Background(), "01j9z3", ModeNetns, 41234, pidFile)
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	t.Cleanup(func() { _ = m.Teardown(context.Background(), n) })

	wantCalls := []string{"ip netns add zc-01j9z3", "ip -n zc-01j9z3 link set lo up"}
	if got := callLines(fake); !slices.Equal(got, wantCalls) {
		t.Errorf("ip calls = %q, want %q", got, wantCalls)
	}
	if len(pasta.cmds) != 1 {
		t.Fatalf("pasta started %d times, want 1", len(pasta.cmds))
	}
	argv := PastaArgv("/run/netns/zc-01j9z3", 41234, pidFile)
	if c := pasta.cmds[0]; c.Name != argv[0] || !slices.Equal(c.Args, argv[1:]) {
		t.Errorf("pasta cmd = %s %q, want %q", c.Name, c.Args, argv)
	}
	if n.Mode != ModeNetns || n.NSName != "zc-01j9z3" || n.NSPath != "/run/netns/zc-01j9z3" || n.HostProxyPort != 41234 {
		t.Errorf("Network = %+v", n)
	}
	if got, want := n.Env(), ProxyEnv(3128); !slices.Equal(got, want) {
		t.Errorf("Env = %q, want %q", got, want)
	}
}

func TestSetupLoUpFailureCleansUp(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("ip", []string{"netns", "add"}, execx.FakeResponse{})
	fake.On("ip", []string{"-n"}, execx.FakeResponse{Code: 2, Stderr: "RTNETLINK answers: Operation not permitted"})
	fake.On("ip", []string{"netns", "delete"}, execx.FakeResponse{})
	pasta := &fakePasta{t: t, writePID: true}
	m := &Manager{Runner: fake, Start: pasta.start}

	n, err := m.Setup(context.Background(), "01j9z3", ModeNetns, 41234, filepath.Join(t.TempDir(), "pasta.pid"))
	if err == nil || n != nil {
		t.Fatalf("Setup = %+v, %v; want error", n, err)
	}
	want := []string{"ip netns add zc-01j9z3", "ip -n zc-01j9z3 link set lo up", "ip netns delete zc-01j9z3"}
	if got := callLines(fake); !slices.Equal(got, want) {
		t.Errorf("ip calls = %q, want %q", got, want)
	}
	if len(pasta.cmds) != 0 {
		t.Errorf("pasta started after loopback failure")
	}
}

func TestSetupPastaNotReady(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("ip", nil, execx.FakeResponse{})
	pasta := &fakePasta{t: t}
	m := &Manager{Runner: fake, Start: pasta.start, ReadyTimeout: 100 * time.Millisecond}
	// A pid file left by an earlier attempt must not count as ready.
	pidFile := filepath.Join(t.TempDir(), "pasta.pid")
	if err := os.WriteFile(pidFile, []byte("999\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	n, err := m.Setup(context.Background(), "01j9z3", ModeNetns, 41234, pidFile)
	if err == nil || !strings.Contains(err.Error(), "not ready") {
		t.Fatalf("Setup = %+v, %v; want a not ready error", n, err)
	}
	if len(pasta.groups) != 1 {
		t.Fatalf("pasta started %d times, want 1", len(pasta.groups))
	}
	waitTerminated(t, pasta.groups[0])
	if !fake.Called("ip", "netns", "delete", "zc-01j9z3") {
		t.Errorf("namespace not deleted; calls %q", callLines(fake))
	}
}

func TestSetupPastaExitsEarly(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("ip", nil, execx.FakeResponse{})
	start := func(ctx context.Context, c execx.Cmd) (*execx.Group, error) {
		return execx.StartGroup(ctx, execx.Cmd{Name: "sh", Args: []string{"-c", "echo 'pasta: bad option' >&2; exit 3"}, Stderr: c.Stderr})
	}
	m := &Manager{Runner: fake, Start: start}

	_, err := m.Setup(context.Background(), "01j9z3", ModeNetns, 41234, filepath.Join(t.TempDir(), "pasta.pid"))
	var exitErr *execx.ExitError
	if !errors.As(err, &exitErr) || exitErr.Code != 3 || !strings.Contains(exitErr.Stderr, "bad option") {
		t.Fatalf("Setup err = %v; want pasta's exit error (code 3, stderr)", err)
	}
	if !fake.Called("ip", "netns", "delete", "zc-01j9z3") {
		t.Errorf("namespace not deleted; calls %q", callLines(fake))
	}
}

func TestSetupNonNetnsModesNoSideEffects(t *testing.T) {
	for _, mode := range []Mode{ModeDeny, ModeHost} {
		t.Run(string(mode), func(t *testing.T) {
			fake := &execx.Fake{}
			m := &Manager{Runner: fake, Start: func(context.Context, execx.Cmd) (*execx.Group, error) {
				t.Error("pasta started")
				return nil, errors.New("unexpected start")
			}}
			n, err := m.Setup(context.Background(), "01j9z3", mode, 41234, filepath.Join(t.TempDir(), "pasta.pid"))
			if err != nil {
				t.Fatalf("Setup: %v", err)
			}
			if n.Mode != mode || n.NSName != "" || n.NSPath != "" || n.HostProxyPort != 0 {
				t.Errorf("Network = %+v", n)
			}
			if env := n.Env(); env != nil {
				t.Errorf("Env = %q, want nil", env)
			}
			if err := m.Teardown(context.Background(), n); err != nil {
				t.Errorf("Teardown: %v", err)
			}
			if len(fake.Calls) != 0 {
				t.Errorf("commands issued: %q", callLines(fake))
			}
		})
	}
}

func TestTeardownIdempotent(t *testing.T) {
	deletes := 0
	fake := &execx.Fake{}
	fake.On("ip", []string{"netns", "delete"}, execx.FakeResponse{Fn: func(execx.Cmd) error {
		deletes++
		if deletes > 1 {
			return &execx.ExitError{Code: 1, Stderr: noSuchNS}
		}
		return nil
	}})
	fake.On("ip", nil, execx.FakeResponse{})
	pasta := &fakePasta{t: t, writePID: true}
	m := &Manager{Runner: fake, Start: pasta.start}
	ctx := context.Background()

	n, err := m.Setup(ctx, "01j9z3", ModeNetns, 41234, filepath.Join(t.TempDir(), "pasta.pid"))
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	for i := range 2 {
		if err := m.Teardown(ctx, n); err != nil {
			t.Fatalf("Teardown #%d: %v", i+1, err)
		}
	}
	waitTerminated(t, pasta.groups[0])
	if deletes != 2 {
		t.Errorf("ip netns delete ran %d times, want 2", deletes)
	}
	if err := m.Teardown(ctx, nil); err != nil {
		t.Errorf("Teardown(nil): %v", err)
	}
}

func TestRemoveNamespaceReportsOtherErrors(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("ip", []string{"netns", "delete"}, execx.FakeResponse{Code: 1, Stderr: "Cannot remove namespace file: Device or resource busy"})
	err := (&Manager{Runner: fake}).RemoveNamespace(context.Background(), "zc-01j9z3")
	if err == nil || !strings.Contains(err.Error(), "busy") {
		t.Errorf("RemoveNamespace err = %v, want the busy error", err)
	}
}

func TestListNamespaces(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"zc-b", "other", "zc-a"} {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	got, err := (&Manager{NetnsDir: dir}).ListNamespaces()
	if err != nil {
		t.Fatalf("ListNamespaces: %v", err)
	}
	if want := []string{"zc-a", "zc-b"}; !slices.Equal(got, want) {
		t.Errorf("ListNamespaces = %q, want %q", got, want)
	}

	got, err = (&Manager{NetnsDir: filepath.Join(dir, "missing")}).ListNamespaces()
	if err != nil || len(got) != 0 {
		t.Errorf("ListNamespaces(missing dir) = %q, %v; want empty, nil", got, err)
	}
}
