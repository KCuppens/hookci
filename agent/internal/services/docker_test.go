package services

import (
	"context"
	"errors"
	"os/exec"
	"slices"
	"strings"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

func dockerCalls(fake *execx.Fake) []string {
	var calls []string
	for _, c := range fake.Calls {
		calls = append(calls, c.Name+" "+strings.Join(c.Args, " "))
	}
	return calls
}

func TestRemoveByLabel(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("docker", []string{"ps"}, execx.FakeResponse{Stdout: "id1\nid2\n"})
	fake.On("docker", []string{"rm", "-f"}, execx.FakeResponse{})
	if err := (Docker{Runner: fake}).RemoveByLabel(context.Background(), LabelRun); err != nil {
		t.Fatalf("RemoveByLabel: %v", err)
	}
	want := []string{"docker ps -aq --filter label=zeroci.run", "docker rm -f id1 id2"}
	if got := dockerCalls(fake); !slices.Equal(got, want) {
		t.Errorf("calls = %q, want %q", got, want)
	}

	empty := &execx.Fake{}
	empty.On("docker", []string{"ps"}, execx.FakeResponse{})
	if err := (Docker{Runner: empty}).RemoveByLabel(context.Background(), LabelRun+"=r1"); err != nil {
		t.Fatalf("RemoveByLabel with no containers: %v", err)
	}
	if want := []string{"docker ps -aq --filter label=zeroci.run=r1"}; !slices.Equal(dockerCalls(empty), want) {
		t.Errorf("calls = %q, want %q (no rm)", dockerCalls(empty), want)
	}
}

func TestRemoveByLabelDockerMissing(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("docker", nil, execx.FakeResponse{Err: &exec.Error{Name: "docker", Err: exec.ErrNotFound}})
	if err := (Docker{Runner: fake}).RemoveByLabel(context.Background(), LabelRun); !errors.Is(err, ErrDockerMissing) {
		t.Errorf("err = %v, want ErrDockerMissing", err)
	}
}

func TestDockerBin(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("/usr/local/bin/docker", []string{"ps"}, execx.FakeResponse{Stdout: "id1\n"})
	ids, err := (Docker{Runner: fake, Bin: "/usr/local/bin/docker"}).ListByLabel(context.Background(), LabelRun)
	if err != nil || !slices.Equal(ids, []string{"id1"}) {
		t.Errorf("ListByLabel = %v, %v; want [id1]", ids, err)
	}
}
