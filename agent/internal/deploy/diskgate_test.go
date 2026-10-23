package deploy

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/execx"
	"github.com/KCuppens/hookci/agent/internal/store"
)

const gib = 1 << 30

func statfsMap(free map[string]uint64) StatfsFunc {
	return func(path string) (uint64, error) {
		f, ok := free[path]
		if !ok {
			return 0, errors.New("no such file or directory")
		}
		return f, nil
	}
}

func TestCheckDiskHeadroom_Below(t *testing.T) {
	statfs := statfsMap(map[string]uint64{"/var/lib/docker": 1 * gib, "/var/lib/hookci": 50 * gib})
	err := CheckDiskHeadroom([]string{"/var/lib/hookci", "/var/lib/docker"}, 5*gib, statfs)
	want := "gc.min_free_bytes: free disk 1073741824 on /var/lib/docker below 5368709120; run hookci gc or raise the limit"
	if err == nil || err.Error() != want {
		t.Fatalf("err = %v, want %q", err, want)
	}
}

func TestCheckDiskHeadroom_OK(t *testing.T) {
	statfs := statfsMap(map[string]uint64{"/var/lib/docker": 5 * gib, "/var/lib/hookci": 50 * gib})
	if err := CheckDiskHeadroom([]string{"/var/lib/docker", "/var/lib/hookci"}, 5*gib, statfs); err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if err := CheckDiskHeadroom([]string{"/var/lib/docker"}, 0, statfsMap(map[string]uint64{"/var/lib/docker": 0})); err != nil {
		t.Fatalf("min 0: err = %v, want nil", err)
	}
}

func TestCheckDiskHeadroom_StatfsError(t *testing.T) {
	err := CheckDiskHeadroom([]string{"/missing"}, 1, statfsMap(nil))
	want := "deploy: statfs /missing: no such file or directory"
	if err == nil || err.Error() != want {
		t.Fatalf("err = %v, want %q", err, want)
	}
}

func TestMinFreeBytes(t *testing.T) {
	if got := MinFreeBytes(config.AgentConfig{}); got != 5368709120 {
		t.Errorf("default = %d, want 5368709120", got)
	}
	if got := MinFreeBytes(config.AgentConfig{Gc: &config.AgentConfigGc{MinFreeBytes: 42}}); got != 42 {
		t.Errorf("set = %d, want 42", got)
	}
}

func TestDiskPreflight_ChecksDockerRootAndStateDir(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("docker", []string{"info", "--format", "{{.DockerRootDir}}"}, execx.FakeResponse{Stdout: "/data/docker\n"})
	var asked []string
	statfs := func(path string) (uint64, error) {
		asked = append(asked, path)
		if path == "/state" {
			return 1 * gib, nil
		}
		return 10 * gib, nil
	}
	err := DiskPreflight(fake, "/state", 2*gib, statfs)(context.Background(), store.DeployRun{})
	want := "gc.min_free_bytes: free disk 1073741824 on /state below 2147483648; run hookci gc or raise the limit"
	if err == nil || err.Error() != want {
		t.Fatalf("err = %v, want %q", err, want)
	}
	if !slices.Equal(asked, []string{"/data/docker", "/state"}) {
		t.Errorf("statfs paths = %v, want docker root then state dir", asked)
	}
}

func TestDockerRootDir_Empty(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("docker", []string{"info"}, execx.FakeResponse{Stdout: "\n"})
	if _, err := DockerRootDir(context.Background(), fake); err == nil {
		t.Fatal("DockerRootDir accepted empty output")
	}
}
