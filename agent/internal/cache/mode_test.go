package cache

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

func TestDetectModeEnvOverride(t *testing.T) {
	for _, m := range []Mode{ModeReflink, ModeOverlay, ModeCopy} {
		t.Setenv(ModeEnv, string(m))
		if got := DetectMode(t.TempDir()); got != m {
			t.Errorf("%s=%s: DetectMode = %q", ModeEnv, m, got)
		}
		fake := &execx.Fake{}
		c, err := New(Options{Root: t.TempDir(), Runner: fake})
		if err != nil {
			t.Fatal(err)
		}
		if c.Mode() != m {
			t.Errorf("%s=%s: New mode = %q", ModeEnv, m, c.Mode())
		}
		if len(fake.Calls) != 0 {
			t.Errorf("%s=%s: probe ran: %v", ModeEnv, m, fake.Calls)
		}
	}
}

func TestDetectModeProbe(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("probe runs on linux only")
	}
	t.Setenv(ModeEnv, "bogus")
	root := t.TempDir()

	ok := &execx.Fake{}
	ok.On("cp", []string{"--reflink=always"}, execx.FakeResponse{})
	if got := detectMode(context.Background(), root, ok); got != ModeReflink {
		t.Errorf("cp succeeds: mode = %q, want reflink", got)
	}
	call := ok.Calls[0]
	if want := []string{"--reflink=always", ".probe-src", ".probe-dst"}; call.Dir != root || !slices.Equal(call.Args, want) {
		t.Errorf("probe = %+v", call)
	}
	for _, f := range []string{".probe-src", ".probe-dst"} {
		if _, err := os.Lstat(filepath.Join(root, f)); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s left behind: %v", f, err)
		}
	}

	if os.Geteuid() == 0 {
		t.Skip("root may pick overlay")
	}
	fail := &execx.Fake{}
	fail.On("cp", nil, execx.FakeResponse{Code: 1})
	if got := detectMode(context.Background(), root, fail); got != ModeCopy {
		t.Errorf("cp fails: mode = %q, want copy", got)
	}
}

func TestOverlayInKernel(t *testing.T) {
	path := filepath.Join(t.TempDir(), "filesystems")
	writeFile(t, path, "nodev\tsysfs\n\text4\nnodev\toverlay\n", 0o644)
	if !overlayInKernel(path) {
		t.Error("overlay not found")
	}
	writeFile(t, path, "nodev\tsysfs\n\text4\nnodev\toverlayfs-not\n", 0o644)
	if overlayInKernel(path) {
		t.Error("overlay found in a list without it")
	}
	if overlayInKernel(filepath.Join(t.TempDir(), "absent")) {
		t.Error("overlay found in a missing file")
	}
}

func TestNewRejectsUnknownMode(t *testing.T) {
	if _, err := New(Options{Root: t.TempDir(), Mode: "zfs"}); err == nil {
		t.Fatal("unknown mode accepted")
	}
}
