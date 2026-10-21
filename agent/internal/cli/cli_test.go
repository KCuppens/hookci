package cli

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/version"
)

// TestSecondSignalKills: the first SIGINT cancels the command context; a
// later one kills a process whose teardown hangs. The child is this test
// binary run again with HOOKCI_TEST_SIGNAL_CHILD set.
func TestSecondSignalKills(t *testing.T) {
	if os.Getenv("HOOKCI_TEST_SIGNAL_CHILD") == "1" {
		ctx, stop := signalContext()
		defer stop()
		fmt.Println("ready")
		<-ctx.Done()
		fmt.Println("cancelled")
		time.Sleep(time.Minute)
		os.Exit(0)
	}

	cmd := exec.Command(os.Args[0], "-test.run=^TestSecondSignalKills$")
	cmd.Env = append(os.Environ(), "HOOKCI_TEST_SIGNAL_CHILD=1")
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	lines := bufio.NewScanner(out)
	expect := func(want string) {
		t.Helper()
		if !lines.Scan() || lines.Text() != want {
			_ = cmd.Process.Kill()
			t.Fatalf("child said %q, want %q (%v)", lines.Text(), want, lines.Err())
		}
	}
	expect("ready")
	if err := cmd.Process.Signal(os.Interrupt); err != nil {
		t.Fatal(err)
	}
	expect("cancelled")
	go func() { exited <- cmd.Wait() }()

	// The default handler comes back just after the context ends, so keep
	// signalling until it takes over.
	deadline := time.After(10 * time.Second)
	for {
		_ = cmd.Process.Signal(os.Interrupt)
		select {
		case <-exited:
			ws, _ := cmd.ProcessState.Sys().(syscall.WaitStatus)
			if !ws.Signaled() || ws.Signal() != syscall.SIGINT {
				t.Errorf("child ended with %v, want killed by SIGINT", cmd.ProcessState)
			}
			return
		case <-deadline:
			_ = cmd.Process.Kill()
			<-exited
			t.Fatal("a second SIGINT did not kill the process")
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func TestMainVersion(t *testing.T) {
	var stdout, stderr bytes.Buffer

	code := Main([]string{"version"}, &stdout, &stderr)

	if code != ExitOK {
		t.Fatalf("exit code = %d, want %d", code, ExitOK)
	}
	if !strings.Contains(stdout.String(), "hookci dev") {
		t.Fatalf("stdout = %q, want to contain %q", stdout.String(), "hookci dev")
	}
}

func TestMainVersionFlag(t *testing.T) {
	old := version.Version
	version.Version, version.Commit = "1.2.3", "abcdef0"
	t.Cleanup(func() { version.Version, version.Commit = old, "" })
	var stdout, stderr bytes.Buffer
	if code := Main([]string{"--version"}, &stdout, &stderr); code != ExitOK {
		t.Fatalf("exit = %d; stderr %q", code, stderr.String())
	}
	if got, want := stdout.String(), "hookci 1.2.3 (abcdef0)\n"; got != want {
		t.Fatalf("stdout = %q, want %q", got, want)
	}
}

func TestMainUnknownCommand(t *testing.T) {
	var stdout, stderr bytes.Buffer

	code := Main([]string{"nope"}, &stdout, &stderr)

	if code != ExitUsage {
		t.Fatalf("exit code = %d, want %d", code, ExitUsage)
	}
	if !strings.Contains(stderr.String(), "unknown command") {
		t.Fatalf("stderr = %q, want to contain %q", stderr.String(), "unknown command")
	}
}

func TestMainHelp(t *testing.T) {
	cases := []struct {
		name string
		args []string
	}{
		{"no args", nil},
		{"help", []string{"help"}},
		{"-h", []string{"-h"}},
		{"--help", []string{"--help"}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer

			code := Main(tc.args, &stdout, &stderr)

			if code != ExitOK {
				t.Fatalf("exit code = %d, want %d", code, ExitOK)
			}
			if !strings.Contains(stdout.String(), "version") {
				t.Fatalf("stdout = %q, want to contain %q", stdout.String(), "version")
			}
		})
	}
}
