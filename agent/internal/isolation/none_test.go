//go:build unix

package isolation

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestNoneRunExitCode(t *testing.T) {
	n := &None{}
	res, err := n.Run(context.Background(), Spec{RunID: "r1", Job: "exit", Argv: []string{"sh", "-c", "exit 7"}})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.ExitCode != 7 || res.TimedOut || res.Cancelled {
		t.Errorf("Result = %+v, want exit 7", res)
	}
}

func TestNoneTimeoutKillsGroup(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "child.pid")
	n := &None{Grace: 200 * time.Millisecond}
	start := time.Now()
	res, err := n.Run(context.Background(), Spec{
		RunID:  "r1",
		Job:    "sleep",
		Argv:   []string{"sh", "-c", `sleep 30 & echo $! > "$1"; sleep 30`, "sh", pidFile},
		Limits: Limits{Timeout: 200 * time.Millisecond},
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("Run took %v, want under 2s", elapsed)
	}
	if !res.TimedOut {
		t.Errorf("Result = %+v, want TimedOut", res)
	}

	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatalf("read child pid: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatalf("parse child pid %q: %v", raw, err)
	}
	// The killed child may linger as a zombie until init reaps it; ESRCH
	// means it is fully gone.
	deadline := time.Now().Add(2 * time.Second)
	for {
		err := syscall.Kill(pid, 0)
		if errors.Is(err, syscall.ESRCH) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("background child %d still alive (kill -0: %v)", pid, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if units, _ := n.ListUnits(context.Background(), UnitPrefix); len(units) != 0 {
		t.Errorf("finished group still listed: %v", units)
	}
}

func TestNoneWarnsOnce(t *testing.T) {
	var warnings []string
	n := &None{Warn: func(msg string) { warnings = append(warnings, msg) }}
	for range 2 {
		if _, err := n.Run(context.Background(), Spec{RunID: "r1", Job: "ok", Argv: []string{"sh", "-c", "true"}}); err != nil {
			t.Fatalf("Run: %v", err)
		}
	}
	if len(warnings) != 1 || warnings[0] != NoneWarning {
		t.Errorf("warnings = %q, want exactly one %q", warnings, NoneWarning)
	}
}

func TestNoneStopAndListUnits(t *testing.T) {
	n := &None{Grace: 200 * time.Millisecond}
	done := make(chan Result, 1)
	go func() {
		res, _ := n.Run(context.Background(), Spec{RunID: "r1", Job: "long", Argv: []string{"sh", "-c", "sleep 30"}})
		done <- res
	}()

	unit := UnitName("r1", "long")
	deadline := time.Now().Add(2 * time.Second)
	for {
		units, _ := n.ListUnits(context.Background(), "hookci-run-r1-")
		if len(units) == 1 && units[0] == (Unit{Name: unit, Active: "active"}) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("ListUnits = %v, want the running unit", units)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := n.Stop(context.Background(), unit); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	select {
	case res := <-done:
		if res.ExitCode == 0 {
			t.Errorf("stopped job exited 0: %+v", res)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after Stop")
	}
	if err := n.Stop(context.Background(), unit); err != nil {
		t.Errorf("Stop of a finished unit: %v", err)
	}
}

func TestNoneRunEnvIsExact(t *testing.T) {
	t.Setenv("HOOKCI_AGENT_ONLY", "agent-secret")
	out := &strings.Builder{}
	_, err := (&None{}).Run(context.Background(), Spec{
		RunID:  "r1",
		Job:    "env",
		Argv:   []string{"/usr/bin/env"},
		Env:    []string{"ONLY=1"},
		Stdout: out,
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := strings.TrimSpace(out.String()); got != "ONLY=1" {
		t.Errorf("job env = %q, want only ONLY=1", got)
	}
}
