package config

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// decodeDeployFixture decodes testdata/deploy/<name> into the generated root
// type after the schema accepts it, without running the semantic checks.
func decodeDeployFixture(t *testing.T, name string) *ZeroCIConfig {
	t.Helper()
	raw, lines, diags := decodeYAML([]byte(readFixture(t, filepath.Join("deploy", name))))
	if diags.HasErrors() {
		t.Fatalf("%s: %s", name, diags.Format(name))
	}
	if diags := validateSchema(raw, lines); diags.HasErrors() {
		t.Fatalf("%s fails the schema:\n%s", name, diags.Format(name))
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	var cfg ZeroCIConfig
	if err := json.Unmarshal(encoded, &cfg); err != nil {
		t.Fatal(err)
	}
	return &cfg
}

func errorStrings(errs []ValidationError) string {
	var b strings.Builder
	for _, e := range errs {
		b.WriteString(e.Error() + "\n")
	}
	return b.String()
}

func TestValidateDeployments_ValidPlanExample(t *testing.T) {
	if errs := ValidateDeployments(decodeDeployFixture(t, "valid_bluegreen.yml")); len(errs) > 0 {
		t.Fatalf("unexpected errors:\n%s", errorStrings(errs))
	}
	cfg, diags := parseString(t, readFixture(t, "deploy/valid_bluegreen.yml"), ParseOptions{})
	if diags.HasErrors() || len(diags) > 0 {
		t.Fatalf("unexpected diagnostics:\n%s", diags.Format("valid_bluegreen.yml"))
	}
	d := cfg.Deployments["production"]
	if d.Verify == nil || d.Verify.Window != "60s" || d.Verify.Interval != "5s" {
		t.Errorf("verify = %+v, want the defaults 60s and 5s", d.Verify)
	}
	if d.Retain == nil || d.Retain.Images != 5 {
		t.Errorf("retain = %+v, want the default 5 images", d.Retain)
	}
	if d.Compose.File != "docker-compose.yml" {
		t.Errorf("compose.file = %q, want the default docker-compose.yml", d.Compose.File)
	}
	if d.On.After != DeploymentOnAfterChecks || d.On.Push != "main" {
		t.Errorf("on = %+v", d.On)
	}
	if d.Route.UpstreamHost != "127.0.0.1" || d.Health.Retries != 40 || d.Health.Expect != 200 {
		t.Errorf("route = %+v, health = %+v", d.Route, d.Health)
	}
}

func TestValidateDeployments_MissingPort(t *testing.T) {
	errs := ValidateDeployments(decodeDeployFixture(t, "missing_port.yml"))
	if len(errs) != 1 {
		t.Fatalf("got %d errors, want 1:\n%s", len(errs), errorStrings(errs))
	}
	if msg := errs[0].Error(); !strings.HasPrefix(msg, "deployments.production.health.url:") || !strings.Contains(msg, "{port}") {
		t.Errorf("error = %q", msg)
	}
}

func TestValidateDeployments_NeedsCycle(t *testing.T) {
	errs := ValidateDeployments(decodeDeployFixture(t, "needs_cycle.yml"))
	if len(errs) != 1 {
		t.Fatalf("got %d errors, want 1:\n%s", len(errs), errorStrings(errs))
	}
	if e := errs[0]; e.Path != "deployments.staging.needs" || e.Msg != "cycle: production -> staging -> production" {
		t.Errorf("error = %+v", e)
	}

	cfg := &ZeroCIConfig{Deployments: ZeroCIConfigDeployments{
		"production": {Strategy: DeploymentStrategyScript, Run: new("./deploy.sh"), Needs: []string{"production", "qa"}},
	}}
	got := errorStrings(ValidateDeployments(cfg))
	for _, want := range []string{
		`deployments.production.needs[0]: environment "production" cannot need itself`,
		`deployments.production.needs[1]: unknown environment "qa"; known environments: production`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("errors do not contain %q:\n%s", want, got)
		}
	}
}

func TestValidateDeployments_Script(t *testing.T) {
	if errs := ValidateDeployments(decodeDeployFixture(t, "valid_script.yml")); len(errs) > 0 {
		t.Fatalf("unexpected errors:\n%s", errorStrings(errs))
	}
	cfg := decodeDeployFixture(t, "valid_script.yml")
	d := cfg.Deployments["production"]
	d.Run = nil
	cfg.Deployments["production"] = d
	errs := ValidateDeployments(cfg)
	if len(errs) != 1 || errs[0].Path != "deployments.production.run" {
		t.Errorf("without run: errors =\n%s", errorStrings(errs))
	}
}

func TestValidateDeployments_RequiredByStrategy(t *testing.T) {
	cfg := &ZeroCIConfig{Deployments: ZeroCIConfigDeployments{
		"production": {Strategy: DeploymentStrategyComposeBluegreen, Rollback: new("./undo.sh")},
		"staging":    {Strategy: DeploymentStrategyComposeInplace},
	}}
	var got []string
	for _, e := range ValidateDeployments(cfg) {
		got = append(got, e.Path)
	}
	want := []string{
		"deployments.production.compose", "deployments.production.route", "deployments.production.health", "deployments.production.rollback",
		"deployments.staging.compose", "deployments.staging.health",
	}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("paths = %v, want %v", got, want)
	}
}

func TestValidateDeployments_RelativePaths(t *testing.T) {
	errs := ValidateDeployments(decodeDeployFixture(t, "relative_route.yml"))
	if len(errs) != 1 || errs[0].Path != "deployments.production.route.file" || !strings.Contains(errs[0].Msg, "must be an absolute path") {
		t.Fatalf("errors =\n%s", errorStrings(errs))
	}

	cfg := decodeDeployFixture(t, "valid_bluegreen.yml")
	d := cfg.Deployments["production"]
	d.EnvFile = new("timeuno.env")
	d.Compose.Marker = new("./.active-color")
	cfg.Deployments["production"] = d
	got := errorStrings(ValidateDeployments(cfg))
	for _, want := range []string{
		`deployments.production.env_file: env_file "timeuno.env" must be an absolute path; use a path that starts with /, for example /etc/zeroci/production.env`,
		`deployments.production.compose.marker: compose.marker "./.active-color" must be an absolute path`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("errors do not contain %q:\n%s", want, got)
		}
	}
}

func TestValidateDeployments_ComposeFileStaysInRepo(t *testing.T) {
	for file, wantErr := range map[string]bool{
		"../compose.yml": true, "deploy/../../compose.yml": true, "deploy/..": true,
		"compose.yml": false, "deploy/compose..yml": false,
	} {
		cfg := decodeDeployFixture(t, "valid_bluegreen.yml")
		d := cfg.Deployments["production"]
		d.Compose.File = file
		cfg.Deployments["production"] = d
		got := errorStrings(ValidateDeployments(cfg))
		if hasErr := strings.Contains(got, "deployments.production.compose.file: "); hasErr != wantErr {
			t.Errorf("compose.file %q: errors =\n%s\nwant a compose.file error: %v", file, got, wantErr)
		}
	}
}

func TestValidateDeployments_Durations(t *testing.T) {
	cfg := decodeDeployFixture(t, "valid_bluegreen.yml")
	d := cfg.Deployments["production"]
	d.Health.Interval = "2"
	d.Verify = &DeploymentVerify{Window: "10s", Interval: "30s"}
	cfg.Deployments["production"] = d
	got := errorStrings(ValidateDeployments(cfg))
	for _, want := range []string{
		`deployments.production.health.interval: duration "2": `,
		`deployments.production.verify.interval: interval 30s is longer than window 10s`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("errors do not contain %q:\n%s", want, got)
		}
	}

	d.Verify = &DeploymentVerify{Window: "0s", Interval: "-1s"}
	cfg.Deployments["production"] = d
	got = errorStrings(ValidateDeployments(cfg))
	for _, want := range []string{
		`deployments.production.verify.window: duration "0s": must be greater than zero`,
		`deployments.production.verify.interval: duration "-1s": must be greater than zero`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("errors do not contain %q:\n%s", want, got)
		}
	}
}

func TestValidateDeployments_HealthURL(t *testing.T) {
	for _, tc := range []struct {
		strategy DeploymentStrategy
		url      string
		want     []string
	}{
		{DeploymentStrategyComposeBluegreen, "http://127.0.0.1:{port}/health", nil},
		{DeploymentStrategyComposeInplace, "http://localhost:{port}/", nil},
		{DeploymentStrategyScript, "http://127.0.0.1:8000/health", nil},
		{DeploymentStrategyComposeBluegreen, "http://127.0.0.1:8000/health", []string{"must contain {port}"}},
		{DeploymentStrategyScript, "https://example.com/health", []string{`must use http, got "https"`, `must point at 127.0.0.1 or localhost, got "example.com"`, "needs an explicit port"}},
		{DeploymentStrategyScript, "http://127.0.0.1:70000/", []string{`port "70000" is out of range`}},
		{DeploymentStrategyScript, "not a url", []string{"is not a valid URL"}},
		{DeploymentStrategyScript, "http://127.0.0.1:{port}/health", []string{"{port} is only filled in by the compose strategies"}},
		{DeploymentStrategyComposeInplace, "http://127.0.0.1:{port}/{port}", []string{"{port} may only stand for the port"}},
		{DeploymentStrategyScript, "http://localhost:8000/health?x=1", nil},
		{DeploymentStrategyScript, "http://10.0.0.5:8000/health", []string{"must point at 127.0.0.1 or localhost"}},
		{DeploymentStrategyScript, "http://localhost:0/health", []string{"out of range"}},
		{DeploymentStrategyScript, "127.0.0.1:8000/health", []string{"is not a valid URL"}},
		{DeploymentStrategyComposeInplace, "http://{port}:80/", []string{"must point at 127.0.0.1 or localhost", "{port} may only stand for the port"}},
		{DeploymentStrategyScript, "http://127.0.0.1:8000/{port}", []string{"{port} may only stand for the port"}},
	} {
		errs := validateHealthURL(tc.url, isCompose(tc.strategy), "health.url")
		if len(errs) != len(tc.want) {
			t.Errorf("%s %s: errors =\n%s", tc.strategy, tc.url, errorStrings(errs))
			continue
		}
		for i, want := range tc.want {
			if !strings.Contains(errs[i].Msg, want) {
				t.Errorf("%s %s: error %d = %q, want %q", tc.strategy, tc.url, i, errs[i].Msg, want)
			}
		}
	}
}

// TestValidateDeployments runs the migrate.before fixtures through the full
// parse pipeline. A missing migrate.run is a schema error there; the
// semantic check behind it is covered by TestValidateDeployments_MigrateBefore.
func TestValidateDeployments(t *testing.T) {
	for _, tc := range []struct {
		fixture string
		path    string // "" means no diagnostics
		msg     string
	}{
		{"migrate_before_ok.yml", "", ""},
		{"migrate_before_relative_dir.yml", "deployments.production.migrate.before.output_dir", "must be an absolute path other than /"},
		{"migrate_before_script.yml", "deployments.production.migrate.before", "not supported by strategy: script"},
		{"migrate_before_no_run.yml", "deployments.production.migrate", "run"},
	} {
		t.Run(tc.fixture, func(t *testing.T) {
			_, diags := parseString(t, readFixture(t, "deploy/"+tc.fixture), ParseOptions{})
			if tc.path == "" {
				if len(diags) > 0 {
					t.Fatalf("unexpected diagnostics:\n%s", diags.Format(tc.fixture))
				}
				return
			}
			if len(diags) != 1 {
				t.Fatalf("got %d diagnostics, want 1:\n%s", len(diags), diags.Format(tc.fixture))
			}
			d := findDiag(t, diags, tc.path)
			if d.Severity != SeverityError || !strings.Contains(d.Message, tc.msg) {
				t.Errorf("diagnostic = %+v, want an error containing %q", d, tc.msg)
			}
		})
	}
}

func TestValidateDeployments_MigrateBefore(t *testing.T) {
	before := func() *DeploymentMigrateBefore {
		return &DeploymentMigrateBefore{Run: "pg_dump", OutputDir: new("/var/backups/app")}
	}
	for _, tc := range []struct {
		name     string
		strategy DeploymentStrategy
		migrate  DeploymentMigrate
		want     []string
	}{
		{"ok", DeploymentStrategyComposeInplace,
			DeploymentMigrate{Run: "./migrate", Paths: []string{"db/**/*.sql"}, Before: before()}, nil},
		{"no run", DeploymentStrategyComposeInplace,
			DeploymentMigrate{Before: before()}, []string{"deployments.production.migrate.run"}},
		{"script", DeploymentStrategyScript,
			DeploymentMigrate{Run: "./migrate", Before: before()}, []string{"deployments.production.migrate.before"}},
		{"missing dir", DeploymentStrategyComposeInplace,
			DeploymentMigrate{Run: "./migrate", Before: &DeploymentMigrateBefore{Run: "pg_dump"}},
			[]string{"deployments.production.migrate.before.output_dir"}},
		{"root dir", DeploymentStrategyComposeInplace,
			DeploymentMigrate{Run: "./migrate", Before: &DeploymentMigrateBefore{Run: "pg_dump", OutputDir: new("/backups/..")}},
			[]string{"deployments.production.migrate.before.output_dir"}},
		{"bad glob", DeploymentStrategyComposeInplace,
			DeploymentMigrate{Run: "./migrate", Paths: []string{"db/**", "db/[migrations"}},
			[]string{"deployments.production.migrate.paths[1]"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			errs := validateMigrate("deployments.production.migrate", tc.strategy, tc.migrate)
			var got []string
			for _, e := range errs {
				got = append(got, e.Path)
			}
			if strings.Join(got, ",") != strings.Join(tc.want, ",") {
				t.Fatalf("paths = %v, want %v:\n%s", got, tc.want, errorStrings(errs))
			}
		})
	}
	errs := validateMigrate("m", DeploymentStrategyScript, DeploymentMigrate{Run: "x", Before: before()})
	if len(errs) != 1 || errs[0].Fix != "use run/needs steps for script deployments" {
		t.Fatalf("script errors =\n%s", errorStrings(errs))
	}
}

func TestSchema_RejectsUnknownStrategy(t *testing.T) {
	_, diags := parseString(t, readFixture(t, "deploy/bad_strategy.yml"), ParseOptions{})
	d := findDiag(t, diags, "deployments.production.strategy")
	if d.Severity != SeverityError || !strings.Contains(d.Message, `got "kubernetes"`) {
		t.Errorf("diagnostic = %+v", d)
	}
}

func TestParseDuration(t *testing.T) {
	valid := map[string]time.Duration{
		"90s":   90 * time.Second,
		"10m":   10 * time.Minute,
		"1h":    time.Hour,
		"1.5h":  90 * time.Minute,
		"1h30m": 90 * time.Minute,
		"500ms": 500 * time.Millisecond,
	}
	for in, want := range valid {
		got, err := ParseDuration("timeout", in)
		if err != nil || got != want {
			t.Errorf("ParseDuration(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	for _, in := range []string{"10", "1d", "-5m", "0s", "", "99999999999999h"} {
		got, err := ParseDuration("timeout", in)
		var ve ValidationError
		if err == nil || !errors.As(err, &ve) || ve.Path != "timeout" || ve.Fix == "" {
			t.Errorf("ParseDuration(%q) = %v, %v; want a ValidationError at timeout", in, got, err)
		}
	}
}
