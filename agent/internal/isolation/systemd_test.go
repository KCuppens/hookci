package isolation

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/testutil"
)

func fullSpec() Spec {
	return Spec{
		RunID: "01HXRUN",
		Job:   "lint",
		Argv:  []string{"/bin/sh", "-ec", "npm run lint"},
		Dir:   "/var/lib/zeroci/runs/01HXRUN/src",
		Env:   []string{"PATH=/usr/bin:/bin", "CI=true"},
		Limits: Limits{
			CPUs:        1.5,
			MemoryBytes: 2 << 30,
			Tasks:       512,
			Timeout:     90500 * time.Millisecond,
			IOReadBps:   50 << 20,
			IOWriteBps:  20 << 20,
		},
		NetNSPath:      "/run/netns/zc-01HXRUN",
		ReadWritePaths: []string{"/var/lib/zeroci/runs/01HXRUN"},
	}
}

func goldenArgv(argv []string) []byte {
	return []byte(strings.Join(argv, "\n") + "\n")
}

func TestBuildSystemdRunArgvFull(t *testing.T) {
	argv := BuildSystemdRunArgv("systemd-run", "zeroci.slice", fullSpec())
	for _, want := range []string{"IPAddressDeny=any", "IPAddressAllow=localhost", "NetworkNamespacePath=/run/netns/zc-01HXRUN"} {
		if !slices.Contains(argv, want) {
			t.Errorf("argv lacks %q", want)
		}
	}
	testutil.Golden(t, "systemd_argv_full", goldenArgv(argv))
}

func TestBuildSystemdRunArgvNoNetNS(t *testing.T) {
	spec := fullSpec()
	spec.NetNSPath = ""
	argv := BuildSystemdRunArgv("systemd-run", "zeroci.slice", spec)
	const deny = "IPAddressDeny=localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16"
	if !slices.Contains(argv, deny) {
		t.Errorf("argv lacks %q:\n%s", deny, goldenArgv(argv))
	}
	for _, a := range argv {
		if strings.HasPrefix(a, "NetworkNamespacePath=") || strings.HasPrefix(a, "IPAddressAllow=") {
			t.Errorf("argv has %q without a netns", a)
		}
	}
}

func TestBuildSystemdRunArgvOmitsZeroLimits(t *testing.T) {
	spec := Spec{
		RunID:          "01HXRUN",
		Job:            "setup",
		Argv:           []string{"/bin/sh", "-ec", "npm ci"},
		Dir:            "/var/lib/zeroci/runs/01HXRUN/src",
		ReadWritePaths: []string{"/var/lib/zeroci/runs/01HXRUN"},
	}
	argv := BuildSystemdRunArgv("systemd-run", "zeroci.slice", spec)
	for _, a := range argv {
		for _, banned := range []string{"CPUQuota=", "MemoryMax=", "TasksMax=", "RuntimeMaxSec=", "IOReadBandwidthMax=", "IOWriteBandwidthMax=", "IOWeight"} {
			if strings.HasPrefix(a, banned) {
				t.Errorf("argv has %q with zero limits", a)
			}
		}
	}
	for _, want := range []string{"Nice=10", "User=zeroci-run", "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes", "PrivateDevices=yes"} {
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

func TestSystemdRunUsesRunner(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("systemd-run", nil, execx.FakeResponse{Code: 3, Stderr: "secret job output"})
	fake.On("systemctl", []string{"show"}, execx.FakeResponse{Stdout: "exit-code\n"})
	s := &Systemd{Runner: fake}
	spec := fullSpec()

	res, err := s.Run(context.Background(), spec)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.ExitCode != 3 || res.TimedOut || res.Cancelled {
		t.Errorf("Result = %+v, want exit 3 only", res)
	}
	want := BuildSystemdRunArgv("systemd-run", "zeroci.slice", spec)
	got := fake.Calls[0]
	if got.Name != want[0] || !slices.Equal(got.Args, want[1:]) {
		t.Errorf("call = %s %q, want %q", got.Name, got.Args, want)
	}
}

func TestSystemdRunTimeoutDetected(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("systemd-run", nil, execx.FakeResponse{Code: 1})
	fake.On("systemctl", []string{"show", "-p", "Result", "--value", "zeroci-run-01HXRUN-lint.service"}, execx.FakeResponse{Stdout: "timeout\n"})
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
	fake.On("systemctl", []string{"stop", "zeroci-run-01HXRUN-lint.service"}, execx.FakeResponse{Fn: func(execx.Cmd) error {
		close(stopped)
		return nil
	}})

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
	if !fake.Called("systemctl", "stop", "zeroci-run-01HXRUN-lint.service") {
		t.Error("cancel did not run systemctl stop zeroci-run-01HXRUN-lint.service")
	}
}

func TestSystemdListUnitsParses(t *testing.T) {
	const out = "zeroci-run-01HX-lint.service loaded active running zeroci job\n" +
		"zeroci-run-01HX-setup.service loaded failed failed zeroci job\n"
	fake := &execx.Fake{}
	fake.On("systemctl", []string{"list-units", "--plain", "--no-legend", "--all", "zeroci-run-01HX-*"}, execx.FakeResponse{Stdout: out})
	units, err := (&Systemd{Runner: fake}).ListUnits(context.Background(), "zeroci-run-01HX-")
	if err != nil {
		t.Fatalf("ListUnits: %v", err)
	}
	want := []Unit{{Name: "zeroci-run-01HX-lint", Active: "active"}, {Name: "zeroci-run-01HX-setup", Active: "failed"}}
	if !slices.Equal(units, want) {
		t.Errorf("units = %+v, want %+v", units, want)
	}
}

func TestSystemdStopNotLoadedIsNotError(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("systemctl", []string{"stop"}, execx.FakeResponse{Code: 5})
	if err := (&Systemd{Runner: fake}).Stop(context.Background(), "zeroci-run-01HX-lint"); err != nil {
		t.Errorf("Stop of unloaded unit: %v", err)
	}
}
