package netns

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

const (
	pastaPollInterval = 20 * time.Millisecond
	pastaStderrLimit  = 4096
)

// VERIFY ON VM: the pasta flag set (especially --splice-only with --netns
// <path> and the -T direction) must be confirmed against the installed
// pasta version in M0-20; TestNetnsEgressIntegration is the proof.
//
// PastaArgv returns the pasta argv for a run. --splice-only creates no tap
// device, so the namespace has no outbound route; -t/-u/-U none forward
// nothing into the namespace; -T forwards namespace port InNSProxyPort to
// the egress proxy on the host loopback.
func PastaArgv(nsPath string, hostProxyPort int, pidFile string) []string {
	return []string{
		"pasta",
		"--foreground",
		"--quiet",
		"--splice-only",
		"--no-map-gw",
		"-t", "none",
		"-u", "none",
		"-U", "none",
		"-T", strconv.Itoa(InNSProxyPort) + ":" + strconv.Itoa(hostProxyPort),
		"--pid", pidFile,
		"--netns", nsPath,
	}
}

// startPasta starts pasta for nsPath and waits until it has written a
// non-empty pidFile. On any failure pasta is stopped before returning.
func (m *Manager) startPasta(ctx context.Context, nsPath string, hostProxyPort int, pidFile string) (*execx.Group, error) {
	if err := os.Remove(pidFile); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("netns: remove stale pasta pid file: %w", err)
	}
	start := m.Start
	if start == nil {
		start = execx.StartGroup
	}
	stderr := &tailBuffer{}
	g, err := start(ctx, execx.Cmd{Name: "pasta", Args: PastaArgv(nsPath, hostProxyPort, pidFile)[1:], Stderr: stderr})
	if err != nil {
		return nil, fmt.Errorf("netns: start pasta: %w", err)
	}

	exited := make(chan struct{})
	var code int
	var waitErr error
	go func() {
		code, waitErr = g.Wait()
		close(exited)
	}()

	timeout := m.ReadyTimeout
	if timeout <= 0 {
		timeout = defaultReadyTimeout
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	tick := time.NewTicker(pastaPollInterval)
	defer tick.Stop()
	for {
		if pidFileReady(pidFile) {
			return g, nil
		}
		select {
		case <-exited:
			if waitErr != nil {
				return nil, fmt.Errorf("netns: pasta exited before ready: %w", waitErr)
			}
			return nil, fmt.Errorf("netns: pasta exited before ready: %w", &execx.ExitError{Code: code, Stderr: stderr.String()})
		case <-deadline.C:
			_ = g.Terminate(pastaGrace)
			return nil, fmt.Errorf("netns: pasta not ready after %s", timeout)
		case <-ctx.Done():
			_ = g.Terminate(pastaGrace)
			return nil, fmt.Errorf("netns: waiting for pasta: %w", ctx.Err())
		case <-tick.C:
		}
	}
}

func pidFileReady(path string) bool {
	b, err := os.ReadFile(path)
	return err == nil && len(bytes.TrimSpace(b)) > 0
}

// tailBuffer keeps the last pastaStderrLimit bytes of pasta's stderr for the
// early-exit error.
type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if over := len(t.buf) - pastaStderrLimit; over > 0 {
		t.buf = t.buf[over:]
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}
