//go:build integration

package doctor

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/clock"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/systemd"
	"github.com/KCuppens/zerocideploy/agent/internal/testutil"
)

// TestInstallerThenDoctor runs the real installer on a disposable VM (root,
// systemd, network) and checks the host it leaves behind.
// ZEROCI_INSTALL_VERSION picks the release to install.
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
	cmd.Env = append(os.Environ(), "ZEROCI_VERSION="+os.Getenv("ZEROCI_INSTALL_VERSION"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("install.sh: %v\n%s", err, out)
	}
	for _, f := range []string{"/usr/local/bin/zeroci", "/etc/systemd/system/zeroci.slice", "/etc/systemd/system/zeroci-agent@.service"} {
		if _, err := os.Stat(f); err != nil {
			t.Errorf("installer left no %s: %v", f, err)
		}
	}

	env := Env{
		StateRoot: "/var/lib/zeroci",
		HubOrigin: "https://ci.webuno.io",
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
