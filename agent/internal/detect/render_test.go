package detect

import (
	"reflect"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/testutil"
)

func renderResult(t *testing.T) *Result {
	t.Helper()
	eslint := config.JobAnnotateEslint
	timeout := "10m"
	cfg, diags := config.FromRoot(config.HookCIConfig{
		Version: 1,
		Checks: &config.Checks{
			Setup: []config.SetupStep{
				{Run: "npm ci", Cache: &config.SetupStepCache{Key: []string{"package-lock.json"}, Paths: []string{"node_modules"}}},
				{Run: "go mod download"},
			},
			Jobs: config.ChecksJobs{
				"zeta":  {Run: "echo 'quoted: yes' && exit 0", Needs: []string{"alpha"}, Timeout: &timeout},
				"alpha": {Run: "npm run lint", Annotate: &eslint},
				"mid":   {Run: "true"},
			},
			Services: &config.ChecksServices{Postgres: &config.ChecksServicesPostgres{Image: "postgres:16-alpine", Tmpfs: true}},
		},
	})
	if diags.HasErrors() {
		t.Fatalf("FromRoot: %s", diags.Format("test"))
	}
	return &Result{Config: cfg, Notes: []string{"package manager: npm (package-lock.json)", "second note"}}
}

func TestRenderGolden(t *testing.T) {
	out, err := Render(renderResult(t))
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	testutil.Golden(t, "render", out)
}

func TestRenderRoundTrip(t *testing.T) {
	r := renderResult(t)
	out, err := Render(r)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	parsed, diags := config.Parse(out, config.ParseOptions{})
	if diags.HasErrors() {
		t.Fatalf("Parse: %s\n%s", diags.Format("render"), out)
	}
	if !reflect.DeepEqual(parsed.HookCIConfig, r.Config.HookCIConfig) {
		t.Errorf("parsed config differs from rendered one:\n got %+v\nwant %+v", parsed.HookCIConfig, r.Config.HookCIConfig)
	}
	if !reflect.DeepEqual(parsed.Checks(), r.Config.Checks()) {
		t.Errorf("resolved checks differ after round trip")
	}
}

func TestRenderNoNotes(t *testing.T) {
	r := renderResult(t)
	r.Notes = nil
	out, err := Render(r)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if out[0] == '#' {
		t.Errorf("output without notes starts with a comment:\n%s", out)
	}
}

func TestRenderNil(t *testing.T) {
	if _, err := Render(nil); err == nil {
		t.Error("Render(nil) succeeded")
	}
	if _, err := Render(&Result{}); err == nil {
		t.Error("Render without a config succeeded")
	}
}
