package isolation

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/execx"
	"github.com/KCuppens/hookci/agent/internal/testutil"
)

func fullSpec() Spec {
	return Spec{
		RunID: "01HXRUN",
		Job:   "lint",
		Argv:  []string{"/bin/sh", "-ec", "npm run lint"},
		Dir:   "/var/lib/hookci/runs/01HXRUN/src",
		Env:   []string{"PATH=/usr/bin:/bin", "CI=true"},
		Limits: Limits{
			CPUs:        1.5,
			MemoryBytes: 2 << 30,
			Tasks:       512,
			Timeout:     90500 * time.Millisecond,
		},
		NetNSPath:      "/run/netns/hci-01HXRUN",
		ReadWritePaths: []string{"/var/lib/hookci/runs/01HXRUN"},
		Hide:           "/var/lib/hookci/runs",
	}
}

func goldenArgv(argv []string) []byte {
	return []byte(strings.Join(argv, "\n") + "\n")
}

func TestBuildSystemdRunArgvFull(t *testing.T) {
	argv := BuildSystemdRunArgv("systemd-run", "hookci.slice", fullSpec())
	for _, want := range []string{"IPAddressDeny=any", "IPAddressAllow=localhost", "NetworkNamespacePath=/run/netns/hci-01HXRUN"} {
		if !slices.Contains(argv, want) {
			t.Errorf("argv lacks %q", want)
		}
	}
	testutil.Golden(t, "systemd_argv_full", goldenArgv(argv))
}

func TestBuildSystemdRunArgvNoNetNS(t *testing.T) {
	spec := fullSpec()
	spec.NetNSPath = ""
	argv := BuildSystemdRunArgv("systemd-run", "hookci.slice", spec)
	for _, d := range []string{"localhost", "link-local", "multicast", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"} {
		if want := "IPAddressDeny=" + d; !slices.Contains(argv, want) {
			t.Errorf("argv lacks %q:\n%s", want, goldenArgv(argv))
		}
	}
	for _, a := range argv {
		if strings.HasPrefix(a, "NetworkNamespacePath=") || strings.HasPrefix(a, "IPAddressAllow=") {
			t.Errorf("argv has %q without a netns", a)
		}
	}
}

// TestBuildSystemdRunArgvHidesOtherRuns pins the /proc and run dir masking:
// only this run's ReadWritePaths stay visible under Hide.
func TestBuildSystemdRunArgvHidesOtherRuns(t *testing.T) {
	spec := fullSpec()
	spec.ReadWritePaths = []string{"/var/lib/hookci/runs/01HXRUN/src", "/var/lib/hookci/runs/01HXRUN/home"}
	argv := BuildSystemdRunArgv("systemd-run", "hookci.slice", spec)
	for _, want := range []string{
		"ProtectProc=invisible",
		"ProcSubset=pid",
		"TemporaryFileSystem=/var/lib/hookci/runs:ro",
		"BindPaths=/var/lib/hookci/runs/01HXRUN/src /var/lib/hookci/runs/01HXRUN/home",
	} {
		if !slices.Contains(argv, want) {
			t.Errorf("argv lacks %q:\n%s", want, goldenArgv(argv))
		}
	}
	if slices.Contains(argv, "--collect") {
		t.Error("argv has --collect, which can unload the unit before its Result is read")
	}

	spec.Hide = ""
	for _, a := range BuildSystemdRunArgv("systemd-run", "hookci.slice", spec) {
		if strings.HasPrefix(a, "TemporaryFileSystem=") || strings.HasPrefix(a, "BindPaths=") {
			t.Errorf("argv has %q without Hide", a)
		}
	}
}

// networkProps returns the network properties passed with -p, in order.
func networkProps(argv []string) []string {
	var props []string
	for i := 1; i < len(argv); i++ {
		p := argv[i]
		if argv[i-1] == "-p" && (strings.HasPrefix(p, "IPAddress") || strings.HasPrefix(p, "NetworkNamespacePath=")) {
			props = append(props, p)
		}
	}
	return props
}

// TestBuildSystemdRunArgvNetNS pins the network properties for netns mode
// (netns.ModeNetns sets NetNSPath to netns.Network.NSPath) and for the deny
// fallback (netns.ModeDeny leaves NetNSPath empty).
func TestBuildSystemdRunArgvNetNS(t *testing.T) {
	for _, tc := range []struct {
		name      string
		netNSPath string
		want      []string
	}{
		{"netns", "/run/netns/hci-01hxrun", []string{
			"IPAddressDeny=any",
			"IPAddressAllow=localhost",
			"NetworkNamespacePath=/run/netns/hci-01hxrun",
		}},
		{"deny", "", []string{
			"IPAddressDeny=localhost",
			"IPAddressDeny=link-local",
			"IPAddressDeny=multicast",
			"IPAddressDeny=0.0.0.0/8",
			"IPAddressDeny=10.0.0.0/8",
			"IPAddressDeny=100.64.0.0/10",
			"IPAddressDeny=172.16.0.0/12",
			"IPAddressDeny=192.0.0.0/24",
			"IPAddressDeny=192.168.0.0/16",
			"IPAddressDeny=198.18.0.0/15",
			"IPAddressDeny=240.0.0.0/4",
			"IPAddressDeny=::/128",
			"IPAddressDeny=fc00::/7",
			"IPAddressDeny=fec0::/10",
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			spec := fullSpec()
			spec.NetNSPath = tc.netNSPath
			got := networkProps(BuildSystemdRunArgv("systemd-run", "hookci.slice", spec))
			if !slices.Equal(got, tc.want) {
				t.Errorf("network properties = %q, want %q", got, tc.want)
			}
		})
	}
}

// systemd expands $VAR and $$ in a unit's command line, so every "$" in the
// job script must reach systemd-run doubled for sh to see the original text.
func TestBuildSystemdRunArgvEscapesDollarSigns(t *testing.T) {
	spec := fullSpec()
	spec.Argv = []string{"/bin/sh", "-ec", `for f in *; do echo "${HOME}/${f}"; done; echo $$ $1 100%`}
	argv := BuildSystemdRunArgv("systemd-run", "hookci.slice", spec)
	sep := slices.Index(argv, "--")
	want := []string{"/bin/sh", "-ec", `for f in *; do echo "$${HOME}/$${f}"; done; echo $$$$ $$1 100%`}
	if sep < 0 || !slices.Equal(argv[sep+1:], want) {
		t.Errorf("command = %q, want %q", argv[sep+1:], want)
	}
	if spec.Argv[2] == want[2] {
		t.Error("BuildSystemdRunArgv changed spec.Argv in place")
	}
}

func TestEscapeCommand(t *testing.T) {
	for _, tc := range []struct{ in, want []string }{
		{nil, nil},
		{[]string{"/bin/true"}, []string{"/bin/true"}},
		{[]string{"sh", "-c", "echo ${A:-b} $$"}, []string{"sh", "-c", "echo $${A:-b} $$$$"}},
		{[]string{"sh", "-c", "no dollars, 50% off"}, []string{"sh", "-c", "no dollars, 50% off"}},
	} {
		if got := EscapeCommand(tc.in); !slices.Equal(got, tc.want) {
			t.Errorf("EscapeCommand(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestBuildSystemdRunArgvOmitsZeroLimits(t *testing.T) {
	spec := Spec{
		RunID:          "01HXRUN",
		Job:            "setup",
		Argv:           []string{"/bin/sh", "-ec", "npm ci"},
		Dir:            "/var/lib/hookci/runs/01HXRUN/src",
		ReadWritePaths: []string{"/var/lib/hookci/runs/01HXRUN"},
		Hide:           "/var/lib/hookci/runs",
	}
	argv := BuildSystemdRunArgv("systemd-run", "hookci.slice", spec)
	for _, a := range argv {
		for _, banned := range []string{"CPUQuota=", "MemoryMax=", "TasksMax=", "RuntimeMaxSec=", "IOWeight"} {
			if strings.HasPrefix(a, banned) {
				t.Errorf("argv has %q with zero limits", a)
			}
		}
	}
	for _, want := range []string{"Nice=10", "User=hookci-run", "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes", "PrivateDevices=yes", "ProtectProc=invisible", "ProcSubset=pid"} {
		if !slices.Contains(argv, want) {
			t.Errorf("argv lacks %q", want)
		}
	}
	testutil.Golden(t, "systemd_argv_minimal", goldenArgv(argv))
}

func TestFormatCPUQuota(t *testing.T) {
	for cpus, want := range map[float64]string{0.5: "50%", 1: "100%", 2: "200%", 1.25: "125%"} {
		if got := formatCPUQuota(cpus); got != want {
			t.Errorf("formatCPUQuota(%v) = %q, want %q", cpus, got, want)
		}
	}
}

func TestCeilSeconds(t *testing.T) {
	for d, want := range map[time.Duration]string{
		90500 * time.Millisecond: "91",
		90 * time.Second:         "90",
		time.Millisecond:         "1",
		10 * time.Minute:         "600",
	} {
		if got := ceilSeconds(d); got != want {
			t.Errorf("ceilSeconds(%v) = %q, want %q", d, got, want)
		}
	}
}

// A failed job's unit stays loaded until its Result is read, then
// reset-failed unloads it.
func TestSystemdRunUsesRunner(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("systemd-run", nil, execx.FakeResponse{Code: 3, Stderr: "secret job output"})
	fake.On("systemctl", []string{"show"}, execx.FakeResponse{Stdout: "exit-code\n"})
	fake.On("systemctl", []string{"reset-failed"}, execx.FakeResponse{})
	s := &Systemd{Runner: fake}
	spec := fullSpec()

	res, err := s.Run(context.Background(), spec)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.ExitCode != 3 || res.TimedOut || res.Cancelled {
		t.Errorf("Result = %+v, want exit 3 only", res)
	}
	want := BuildSystemdRunArgv("systemd-run", "hookci.slice", spec)
	got := fake.Calls[0]
	if got.Name != want[0] || !slices.Equal(got.Args, want[1:]) {
		t.Errorf("call = %s %q, want %q", got.Name, got.Args, want)
	}
	var rest []string
	for _, c := range fake.Calls[1:] {
		rest = append(rest, c.Name+" "+strings.Join(c.Args, " "))
	}
	wantRest := []string{
		"systemctl show -p Result --value hookci-run-01HXRUN-lint.service",
		"systemctl reset-failed hookci-run-01HXRUN-lint.service",
	}
	if !slices.Equal(rest, wantRest) {
		t.Errorf("calls after systemd-run = %q, want %q", rest, wantRest)
	}
}

func TestSystemdRunSuccessSkipsResetFailed(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("systemd-run", nil, execx.FakeResponse{})
	if _, err := (&Systemd{Runner: fake}).Run(context.Background(), fullSpec()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(fake.Calls) != 1 {
		t.Errorf("calls = %+v, want systemd-run only", fake.Calls)
	}
}

func TestSystemdRunTimeoutDetected(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("systemd-run", nil, execx.FakeResponse{Code: 1})
	fake.On("systemctl", []string{"show", "-p", "Result", "--value", "hookci-run-01HXRUN-lint.service"}, execx.FakeResponse{Stdout: "timeout\n"})
	fake.On("systemctl", []string{"reset-failed", "hookci-run-01HXRUN-lint.service"}, execx.FakeResponse{})
	res, err := (&Systemd{Runner: fake}).Run(context.Background(), fullSpec())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.TimedOut || res.ExitCode != 1 {
		t.Errorf("Result = %+v, want TimedOut with exit 1", res)
	}
}

func TestSystemdRunCancelStopsUnit(t *testing.T) {
	stopped := make(chan struct{})
	started := make(chan struct{})
	fake := &execx.Fake{}
	fake.On("systemd-run", nil, execx.FakeResponse{Code: 143, Fn: func(execx.Cmd) error {
		close(started)
		<-stopped
		return nil
	}})
	fake.On("systemctl", []string{"stop", "hookci-run-01HXRUN-lint.service"}, execx.FakeResponse{Fn: func(execx.Cmd) error {
		close(stopped)
		return nil
	}})
	fake.On("systemctl", []string{"reset-failed", "hookci-run-01HXRUN-lint.service"}, execx.FakeResponse{})

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-started
		cancel()
	}()
	res, err := (&Systemd{Runner: fake}).Run(ctx, fullSpec())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.Cancelled || res.TimedOut {
		t.Errorf("Result = %+v, want Cancelled", res)
	}
	if !fake.Called("systemctl", "stop", "hookci-run-01HXRUN-lint.service") {
		t.Error("cancel did not run systemctl stop hookci-run-01HXRUN-lint.service")
	}
	if !fake.Called("systemctl", "reset-failed", "hookci-run-01HXRUN-lint.service") {
		t.Error("cancel did not run systemctl reset-failed hookci-run-01HXRUN-lint.service")
	}
}

func TestSystemdListUnitsParses(t *testing.T) {
	const out = "hookci-run-01HX-lint.service loaded active running hookci job\n" +
		"hookci-run-01HX-setup.service loaded failed failed hookci job\n"
	fake := &execx.Fake{}
	fake.On("systemctl", []string{"list-units", "--plain", "--no-legend", "--all", "hookci-run-01HX-*"}, execx.FakeResponse{Stdout: out})
	units, err := (&Systemd{Runner: fake}).ListUnits(context.Background(), "hookci-run-01HX-")
	if err != nil {
		t.Fatalf("ListUnits: %v", err)
	}
	want := []Unit{{Name: "hookci-run-01HX-lint", Active: "active"}, {Name: "hookci-run-01HX-setup", Active: "failed"}}
	if !slices.Equal(units, want) {
		t.Errorf("units = %+v, want %+v", units, want)
	}
}

func TestSystemdStopNotLoadedIsNotError(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("systemctl", []string{"stop"}, execx.FakeResponse{Code: 5})
	if err := (&Systemd{Runner: fake}).Stop(context.Background(), "hookci-run-01HX-lint"); err != nil {
		t.Errorf("Stop of unloaded unit: %v", err)
	}
	if fake.Called("systemctl", "reset-failed") {
		t.Error("Stop ran reset-failed on a unit that is not loaded")
	}
}

// Recovery stops orphaned units through Stop, so a unit that failed while
// the agent was down is unloaded too.
func TestSystemdStopResetsFailed(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("systemctl", nil, execx.FakeResponse{})
	if err := (&Systemd{Runner: fake}).Stop(context.Background(), "hookci-run-01HX-lint"); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	var got []string
	for _, c := range fake.Calls {
		got = append(got, c.Name+" "+strings.Join(c.Args, " "))
	}
	want := []string{"systemctl stop hookci-run-01HX-lint.service", "systemctl reset-failed hookci-run-01HX-lint.service"}
	if !slices.Equal(got, want) {
		t.Errorf("calls = %q, want %q", got, want)
	}
}

var (
	_ CPUResizer = (*Systemd)(nil)
	_ CPUResizer = (*None)(nil)
)

func TestSystemdSetCPUs(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("systemctl", nil, execx.FakeResponse{})
	if err := (&Systemd{Runner: fake}).SetCPUs(context.Background(), "01HXRUN", "lint", 3.5); err != nil {
		t.Fatalf("SetCPUs: %v", err)
	}
	if len(fake.Calls) != 1 {
		t.Fatalf("calls = %+v, want one systemctl", fake.Calls)
	}
	got := fake.Calls[0]
	want := []string{"set-property", "--runtime", "hookci-run-01HXRUN-lint.service", "CPUQuota=350%"}
	if got.Name != "systemctl" || !slices.Equal(got.Args, want) {
		t.Errorf("call = %s %q, want systemctl %q", got.Name, got.Args, want)
	}
}

func TestSystemdSetCPUsReportsFailure(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("systemctl", nil, execx.FakeResponse{Code: 1})
	if err := (&Systemd{Runner: fake}).SetCPUs(context.Background(), "01HXRUN", "lint", 2); err == nil {
		t.Error("SetCPUs hid a systemctl failure")
	}
}

func TestNoneSetCPUsIsNoop(t *testing.T) {
	if err := (&None{}).SetCPUs(context.Background(), "01HXRUN", "lint", 2); err != nil {
		t.Errorf("SetCPUs: %v", err)
	}
}
