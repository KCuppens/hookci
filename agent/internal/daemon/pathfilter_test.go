package daemon

import (
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
