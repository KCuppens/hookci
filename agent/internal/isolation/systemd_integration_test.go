//go:build integration

package isolation

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/execx"
	"github.com/KCuppens/hookci/agent/internal/testutil"
)

// integrationRunDir makes a run dir outside /tmp and /var/tmp, which
// PrivateTmp hides from the unit, and lets the runner user write to it.
func integrationRunDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/run", "hookci-itest-")
	if err != nil {
		t.Fatalf("make run dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatalf("chmod run dir: %v", err)
	}
	return dir
}

func integrationSystemd(t *testing.T) (*Systemd, string) {
	t.Helper()
	testutil.RequireIntegration(t)
	if os.Geteuid() != 0 {
		t.Skip("systemd isolation needs root")
	}
	testutil.EnsureUser(t, DefaultUser)
	return &Systemd{}, integrationRunDir(t)
}

func integrationSpec(dir, job string, argv ...string) Spec {
	return Spec{
		RunID:          "itest" + strings.ReplaceAll(time.Now().Format("150405.000"), ".", ""),
		Job:            job,
		Argv:           argv,
		Dir:            dir,
		Env:            []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/tmp"},
		ReadWritePaths: []string{dir},
	}
}

func TestSystemdIntegrationTrue(t *testing.T) {
	s, dir := integrationSystemd(t)
	res, err := s.Run(context.Background(), integrationSpec(dir, "true", "/bin/true"))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.ExitCode != 0 || res.TimedOut || res.Cancelled {
		t.Errorf("Result = %+v, want clean exit 0", res)
	}
}

// TestSystemdIntegrationDollarSigns checks that the job script reaches sh
// unchanged: systemd would otherwise expand ${x} to "" and $$ to "$".
func TestSystemdIntegrationDollarSigns(t *testing.T) {
	s, dir := integrationSystemd(t)
	spec := integrationSpec(dir, "dollar", "/bin/sh", "-ec", `x=1; echo "${x} ${HOME} $1"; [ "$$" -gt 1 ] && echo pid 100%`, "argv0", "one")
	var out bytes.Buffer
	spec.Stdout = &out
	res, err := s.Run(context.Background(), spec)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("Result = %+v, want exit 0", res)
	}
	if got, want := out.String(), "1 /tmp one\npid 100%\n"; got != want {
		t.Errorf("output = %q, want %q", got, want)
	}
}

func TestSystemdIntegrationProperties(t *testing.T) {
	s, dir := integrationSystemd(t)
	spec := integrationSpec(dir, "props", "/bin/sleep", "30")
	spec.Limits = Limits{CPUs: 1, MemoryBytes: 256 << 20, Tasks: 64, Timeout: time.Minute}
	unit := UnitName(spec.RunID, spec.Job)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan Result, 1)
	go func() {
		res, _ := s.Run(ctx, spec)
		done <- res
	}()
	defer func() {
		cancel()
		<-done
	}()

	want := map[string]string{
		"User":            DefaultUser,
		"NoNewPrivileges": "yes",
		"ProtectSystem":   "strict",
		"ProtectHome":     "yes",
		"PrivateTmp":      "yes",
		"PrivateDevices":  "yes",
		"ProtectProc":     "invisible",
		"ProcSubset":      "pid",
		"MemoryMax":       "268435456",
		"TasksMax":        "64",
		"Nice":            "10",
	}
	props := make([]string, 0, len(want))
	for k := range want {
		props = append(props, k)
	}
	deadline := time.Now().Add(10 * time.Second)
	var got map[string]string
	for {
		var out bytes.Buffer
		err := execx.OS{}.Run(context.Background(), execx.Cmd{
			Name:   "systemctl",
			Args:   []string{"show", "-p", strings.Join(props, ","), unit + ".service"},
			Stdout: &out,
		})
		got = map[string]string{}
		for line := range strings.Lines(out.String()) {
			if k, v, ok := strings.Cut(strings.TrimSpace(line), "="); ok {
				got[k] = v
			}
		}
		if err == nil && got["User"] != "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("unit %s never showed up: %v", unit, err)
		}
		time.Sleep(100 * time.Millisecond)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
}

func TestSystemdIntegrationMemoryHog(t *testing.T) {
	s, dir := integrationSystemd(t)
	// tail buffers its whole newline-free input, so it grows past MemoryMax.
	spec := integrationSpec(dir, "memhog", "/bin/sh", "-c", "head -c 1G /dev/zero | tail >/dev/null")
	spec.Limits = Limits{MemoryBytes: 64 << 20, Timeout: time.Minute}
	res, err := s.Run(context.Background(), spec)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.ExitCode == 0 {
		t.Errorf("memory hog exited 0 under MemoryMax=64M: %+v", res)
	}
}
