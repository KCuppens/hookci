package daemon

import (
	"log/slog"
	"slices"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/store"
)

func TestSkipByPaths(t *testing.T) {
	checks := &config.ResolvedChecks{Jobs: []config.ResolvedJob{
		{Name: "web", Paths: []string{"apps/web/**", "package-lock.json"}},
		{Name: "ext", Paths: []string{"apps/extension/**"}},
		{Name: "all"},
	}}
	skip := skipByPaths(checks, []string{"apps/web/src/a.ts"})
	check := store.Run{Kind: "check"}
	for _, c := range []struct {
		job  string
		run  store.Run
		want bool
	}{
		{"web", check, false},
		{"ext", check, true},
		{"all", check, false},
		{"ext", store.Run{Kind: kindDeploy}, false},
	} {
		if _, got := skip(c.run, c.job); got != c.want {
			t.Errorf("skip(%s, kind %s) = %v, want %v", c.job, c.run.Kind, got, c.want)
		}
	}
	if _, got := skipByPaths(checks, []string{"package-lock.json"})(check, "web"); got {
		t.Error("lockfile change must run web")
	}
}

func TestSkipSetupSteps(t *testing.T) {
	checks := &config.ResolvedChecks{Setup: []config.SetupStep{
		{Run: "install"},
		{Run: "rust", Paths: []string{"crates/**", ".hookci.yml"}},
	}}
	log := slog.New(slog.DiscardHandler)
	runs := func(files ...string) []string {
		var out []string
		for _, s := range skipSetupSteps(checks, files, log, "r").Setup {
			out = append(out, s.Run)
		}
		return out
	}
	if got := runs("docs/a.md"); !slices.Equal(got, []string{"install"}) {
		t.Errorf("docs change keeps %v, want [install]", got)
	}
	if got := runs("docs/a.md", "crates/x/lib.rs"); !slices.Equal(got, []string{"install", "rust"}) {
		t.Errorf("crate change keeps %v, want both", got)
	}
	if len(checks.Setup) != 2 {
		t.Error("input checks were modified")
	}
}

func TestSkipDeferredSetup(t *testing.T) {
	checks := &config.ResolvedChecks{
		Setup: []config.SetupStep{{Run: "warm", For: []string{"rust"}, Paths: []string{"crates/**"}}},
		Jobs: []config.ResolvedJob{
			{Name: "rust", Paths: []string{"crates/**"}},
			{Name: "web", Paths: []string{"apps/web/**"}},
		},
	}
	check := store.Run{Kind: "check"}
	if _, skip := skipByPaths(checks, []string{"apps/web/a.ts"})(check, "setup-1"); !skip {
		t.Error("web-only change must skip the rust warm-up")
	}
	if _, skip := skipByPaths(checks, []string{"crates/a.rs"})(check, "setup-1"); skip {
		t.Error("crate change must run the warm-up")
	}
	if got := skipSetupSteps(checks, []string{"apps/web/a.ts"}, slog.New(slog.DiscardHandler), "r"); len(got.Setup) != 1 {
		t.Error("a step with for is settled as a job, not dropped")
	}
}
