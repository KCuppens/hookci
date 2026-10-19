package systemd

import (
	"context"
	"slices"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

func TestSystemctl(t *testing.T) {
	ctx := context.Background()
	ex := &execx.Fake{}
	ex.On("systemctl", []string{"cat", "--", "zeroci-agent@42.service"}, execx.FakeResponse{})
	ex.On("systemctl", []string{"cat", "--", "zeroci-agent@7.service"}, execx.FakeResponse{Code: 1})
	ex.On("systemctl", []string{"enable", "--now", "--", "zeroci-agent@42.service"}, execx.FakeResponse{})
	ex.On("systemctl", []string{"show", "-p", "ActiveState", "--value", "--", "zeroci-agent@42.service"}, execx.FakeResponse{Stdout: "active\n"})
	ex.On("systemctl", []string{"try-restart", "--", "zeroci-agent@*.service"}, execx.FakeResponse{})
	s := Systemctl{Runner: ex}

	if ok, err := s.UnitExists(ctx, AgentUnit(42)); !ok || err != nil {
		t.Errorf("UnitExists(42) = %v, %v; want true", ok, err)
	}
	if ok, err := s.UnitExists(ctx, AgentUnit(7)); ok || err != nil {
		t.Errorf("UnitExists(7) = %v, %v; want false, nil", ok, err)
	}
	if err := s.EnableNow(ctx, AgentUnit(42)); err != nil {
		t.Errorf("EnableNow = %v", err)
	}
	if st, err := s.ActiveState(ctx, AgentUnit(42)); st != "active" || err != nil {
		t.Errorf("ActiveState = %q, %v", st, err)
	}
	if err := s.TryRestart(ctx, AllAgentUnits); err != nil {
		t.Errorf("TryRestart = %v", err)
	}
	if !slices.ContainsFunc(ex.Calls, func(c execx.Cmd) bool {
		return slices.Equal(c.Args, []string{"try-restart", "--", "zeroci-agent@*.service"})
	}) {
		t.Error("no systemctl try-restart call")
	}
	if !slices.ContainsFunc(ex.Calls, func(c execx.Cmd) bool {
		return slices.Equal(c.Args, []string{"enable", "--now", "--", "zeroci-agent@42.service"})
	}) {
		t.Error("no systemctl enable --now call")
	}
}
