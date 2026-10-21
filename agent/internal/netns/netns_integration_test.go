//go:build integration

package netns

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/egress"
	"github.com/KCuppens/hookci/agent/internal/execx"
	"github.com/KCuppens/hookci/agent/internal/ids"
	"github.com/KCuppens/hookci/agent/internal/testutil"
)

const integrationPATH = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// nsCurl runs curl inside the namespace with env and returns its stdout.
func nsCurl(ctx context.Context, n *Network, env []string, args ...string) (string, error) {
	var stdout, stderr bytes.Buffer
	argv := append([]string{"netns", "exec", n.NSName, "curl", "-sS", "--max-time", "15"}, args...)
	err := execx.OS{}.Run(ctx, execx.Cmd{Name: "ip", Args: argv, Env: env, Stdout: &stdout, Stderr: &stderr})
	if err != nil {
		err = errors.Join(err, errors.New(strings.TrimSpace(stderr.String())))
	}
	return strings.TrimSpace(stdout.String()), err
}

// TestNetnsEgressIntegration needs Linux, root, ip, pasta, curl and network
// access to registry.npmjs.org. It proves that the namespace reaches the
// internet only through the egress proxy.
func TestNetnsEgressIntegration(t *testing.T) {
	testutil.RequireIntegration(t)
	m := &Manager{}
	if ok, reason := m.Available(); !ok {
		t.Skipf("netns unavailable: %s", reason)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	runID := ids.NewRunID()
	allow, _, err := egress.NewAllowList(false, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy, err := egress.Start(ctx, egress.Options{RunID: runID, Allow: allow, Resolver: egress.NetResolver{}})
	if err != nil {
		t.Fatalf("start proxy: %v", err)
	}
	defer func() { _ = proxy.Close() }()

	pidFile := filepath.Join(t.TempDir(), "pasta.pid")
	n, err := m.Setup(ctx, runID, ModeNetns, proxy.Port(), pidFile)
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	tornDown := false
	defer func() {
		if !tornDown {
			_ = m.Teardown(context.Background(), n)
		}
	}()

	proxied := append([]string{integrationPATH}, n.Env()...)
	direct := []string{integrationPATH}

	// An allow-listed registry is reachable through the proxy.
	if code, err := nsCurl(ctx, n, proxied, "-o", "/dev/null", "-w", "%{http_code}", "https://registry.npmjs.org/"); err != nil || code != "200" {
		t.Errorf("registry via proxy: code %q, err %v; want 200", code, err)
	}
	// A host off the allow-list is refused by the proxy with 403.
	if code, err := nsCurl(ctx, n, proxied, "-o", "/dev/null", "-w", "%{http_connect}", "https://example.com/"); err == nil || code != "403" {
		t.Errorf("example.com via proxy: CONNECT code %q, err %v; want a 403 failure", code, err)
	}
	// There is no route out of the namespace except the proxy.
	if _, err := nsCurl(ctx, n, direct, "--noproxy", "*", "--max-time", "5", "https://1.1.1.1/"); err == nil {
		t.Error("direct https://1.1.1.1/ succeeded; want no route")
	}
	// The metadata endpoint is unreachable directly and through the proxy.
	if _, err := nsCurl(ctx, n, direct, "--noproxy", "*", "--max-time", "5", "http://169.254.169.254/"); err == nil {
		t.Error("direct http://169.254.169.254/ succeeded; want no route")
	}
	if _, err := nsCurl(ctx, n, proxied, "-f", "--max-time", "5", "http://169.254.169.254/"); err == nil {
		t.Error("http://169.254.169.254/ via proxy succeeded; want refusal")
	}

	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatalf("read pasta pid file: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatalf("parse pasta pid %q: %v", raw, err)
	}

	tornDown = true
	if err := m.Teardown(ctx, n); err != nil {
		t.Fatalf("Teardown: %v", err)
	}
	if _, err := os.Stat(n.NSPath); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("%s still exists after Teardown (stat err %v)", n.NSPath, err)
	}
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Errorf("pasta pid %d still exists after Teardown (kill 0 err %v)", pid, err)
	}
}
