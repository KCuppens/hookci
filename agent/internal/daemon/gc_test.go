package daemon

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

func TestRecordGCTargets(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	deps := map[string]config.Deployment{
		"prod":    {Compose: &config.DeploymentCompose{Project: "web"}, Retain: &config.DeploymentRetain{Images: 3}},
		"staging": {Compose: &config.DeploymentCompose{Project: "web-staging"}},
		"script":  {},
	}
	load := recordGCTargets(st, Options{}, func(_ context.Context, run store.DeployRun) (config.Deployment, error) {
		return deps[run.Env], nil
	})
	for _, env := range []string{"prod", "staging", "script"} {
		dep, err := load(ctx, store.DeployRun{RunID: "dep_" + env, Repo: "acme/web", Env: env})
		if err != nil {
			t.Fatalf("load %s: %v", env, err)
		}
		if (dep.Compose == nil) != (deps[env].Compose == nil) {
			t.Errorf("load %s returned %+v, want the loaded config", env, dep)
		}
	}

	targets, err := st.ListGCTargets(ctx)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]store.GCTarget{}
	for _, tg := range targets {
		got[tg.Env] = tg
	}
	if len(got) != 2 || got["prod"].Project != "web" || got["prod"].RetainImages != 3 ||
		got["staging"].Project != "web-staging" || got["staging"].RetainImages != 0 {
		t.Errorf("targets = %+v, want prod (web, 3) and staging (web-staging, default)", targets)
	}
}
