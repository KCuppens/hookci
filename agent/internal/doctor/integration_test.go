//go:build integration

package doctor

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/clock"
	"github.com/KCuppens/hookci/agent/internal/execx"
	"github.com/KCuppens/hookci/agent/internal/systemd"
	"github.com/KCuppens/hookci/agent/internal/testutil"
)

// TestInstallerThenDoctor runs the real installer on a disposable VM (root,
// systemd, network) and checks the host it leaves behind.
// HOOKCI_INSTALL_VERSION picks the release to install. The installer needs
// cosign on PATH, or HOOKCI_ALLOW_UNSIGNED=1 in the environment.
func TestInstallerThenDoctor(t *testing.T) {
	testutil.RequireIntegration(t)
	if os.Geteuid() != 0 {
		t.Skip("the installer test needs root on a disposable VM")
	}
	script, err := filepath.Abs("../../../hub/static/install.sh")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sh", script)
	cmd.Env = append(os.Environ(), "HOOKCI_VERSION="+os.Getenv("HOOKCI_INSTALL_VERSION"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("install.sh: %v\n%s", err, out)
	}
	for _, f := range []string{"/usr/local/bin/hookci", "/etc/systemd/system/hookci.slice", "/etc/systemd/system/hookci-agent@.service"} {
		if _, err := os.Stat(f); err != nil {
			t.Errorf("installer left no %s: %v", f, err)
		}
	}

	env := Env{
		StateRoot: "/var/lib/hookci",
		HubOrigin: "https://ci.hookci.com",
		HTTP:      &http.Client{},
		Clock:     clock.Real{},
		Exec:      execx.OS{},
		FS:        os.DirFS("/"),
		Systemd:   systemd.Systemctl{Runner: execx.OS{}},
		DiskFree:  HostDiskFree,
	}
	for _, r := range Run(context.Background(), env, []Check{runUserCheck{}, stateDirPermsCheck{}, gitCheck{}, diskSpaceCheck{}}) {
		if r.Status == Fail {
			t.Errorf("%s failed after install: %s", r.ID, r.Detail)
		}
	}
}
