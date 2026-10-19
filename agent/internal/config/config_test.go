package config

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParseValidYAML(t *testing.T) {
	yamlContent := `
version: 1
checks:
  setup:
    - run: npm ci
      cache:
        key: [package-lock.json]
        paths: [node_modules]
  jobs:
    lint:
      run: npm run lint
      annotate: eslint
    test:
      run: npm test
      needs: [lint]
      timeout: 5m
  services:
    postgres:
      image: postgres:15-alpine
  egress:
    - registry.npmjs.org
    - "*.githubusercontent.com:443"
deployments:
  production:
    strategy: restart
    env_file: /etc/app/env
`
	cfg, err := Parse([]byte(yamlContent))
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}
	if cfg.Version != 1 {
		t.Errorf("expected version 1, got %d", cfg.Version)
	}
	setup := cfg.Checks.Setup
	if len(setup) != 1 || setup[0].Run != "npm ci" || setup[0].Cache == nil ||
		!reflect.DeepEqual(setup[0].Cache.Key, []string{"package-lock.json"}) ||
		!reflect.DeepEqual(setup[0].Cache.Paths, []string{"node_modules"}) {
		t.Errorf("unexpected setup: %+v", setup)
	}
	if len(cfg.Checks.Jobs) != 2 {
		t.Errorf("expected 2 jobs, got %d", len(cfg.Checks.Jobs))
	}
	if a := cfg.Checks.Jobs["lint"].Annotate; a == nil || *a != JobAnnotateEslint {
		t.Errorf("lint annotate = %v, want eslint", a)
	}
	if pg := cfg.Checks.Services.Postgres; pg == nil || pg.Image != "postgres:15-alpine" {
		t.Errorf("unexpected postgres service: %+v", pg)
	}
	if len(cfg.Checks.Egress) != 2 {
		t.Errorf("unexpected egress: %v", cfg.Checks.Egress)
	}
	if d, ok := cfg.Deployments["production"]; !ok || d.Strategy == nil || *d.Strategy != DeploymentStrategyRestart {
		t.Errorf("unexpected deployment: %+v", d)
	}

	order, err := cfg.TopologicalSort()
	if err != nil {
		t.Fatalf("TopologicalSort failed: %v", err)
	}
	if want := []string{"lint", "test"}; !reflect.DeepEqual(order, want) {
		t.Errorf("expected order %v, got %v", want, order)
	}
}

func TestParseFillsSchemaDefaults(t *testing.T) {
	cfg, err := Parse([]byte(`
version: 1
checks:
  on:
    push: {}
  jobs:
    lint:
      run: echo ok
  services:
    postgres: {}
deployments:
  production:
    health: {}
`))
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}
	c := cfg.Checks
	if c.Trust != ChecksTrustCollaborators || c.Forks != ChecksForksGated {
		t.Errorf("trust, forks = %q, %q; want collaborators, gated", c.Trust, c.Forks)
	}
	if !c.On.PullRequest || !reflect.DeepEqual(c.On.Push.Branches, []string{"main"}) {
		t.Errorf("on = %+v / %+v; want pull_request true, push.branches [main]", c.On, c.On.Push)
	}
	if pg := c.Services.Postgres; pg.Image != "postgres:16-alpine" || !pg.Tmpfs {
		t.Errorf("postgres = %+v; want postgres:16-alpine on tmpfs", pg)
	}
	d := cfg.Deployments["production"]
	if d.Rollback != DeploymentRollbackAuto || d.Approve || d.Health.ExpectStatus != 200 {
		t.Errorf("deployment = %+v, health %+v; want rollback auto, approve false, expect_status 200", d, d.Health)
	}
}

func TestParseEmptyConfig(t *testing.T) {
	for _, in := range []string{"", "   \n\t  "} {
		if _, err := Parse([]byte(in)); !errors.Is(err, ErrEmptyConfig) {
			t.Errorf("Parse(%q) = %v, want ErrEmptyConfig", in, err)
		}
	}
}

func TestParseInvalidSchema(t *testing.T) {
	tests := []struct {
		name string
		yaml string
	}{
		{"version 2", "version: 2\nchecks:\n  jobs:\n    lint:\n      run: echo ok\n"},
		{"missing version", "checks:\n  jobs:\n    lint:\n      run: echo ok\n"},
		{"missing run in job", "version: 1\nchecks:\n  jobs:\n    lint:\n      needs: []\n"},
		{"extra property at root", "version: 1\nunknown_key: true\nchecks:\n  jobs:\n    lint:\n      run: echo ok\n"},
		{"empty jobs", "version: 1\nchecks:\n  jobs: {}\n"},
		{"job name with spaces", "version: 1\nchecks:\n  jobs:\n    \"bad name\":\n      run: echo ok\n"},
		{"duplicate needs", "version: 1\nchecks:\n  jobs:\n    a:\n      run: echo a\n    b:\n      run: echo b\n      needs: [a, a]\n"},
		{"unknown annotate", "version: 1\nchecks:\n  jobs:\n    lint:\n      run: echo ok\n      annotate: pylint\n"},
		{"empty setup run", "version: 1\nchecks:\n  setup:\n    - run: \"\"\n  jobs:\n    lint:\n      run: echo ok\n"},
		{"cache without paths", "version: 1\nchecks:\n  setup:\n    - run: npm ci\n      cache:\n        key: [package-lock.json]\n  jobs:\n    lint:\n      run: echo ok\n"},
		{"egress url", "version: 1\nchecks:\n  egress: [\"https://github.com\"]\n  jobs:\n    lint:\n      run: echo ok\n"},
		{"zero cpus", "version: 1\nchecks:\n  limits:\n    cpus: 0\n  jobs:\n    lint:\n      run: echo ok\n"},
		{"memory without unit", "version: 1\nchecks:\n  limits:\n    memory: \"4096\"\n  jobs:\n    lint:\n      run: echo ok\n"},
		{"tasks below 16", "version: 1\nchecks:\n  limits:\n    tasks: 8\n  jobs:\n    lint:\n      run: echo ok\n"},
		{"timeout in days", "version: 1\nchecks:\n  jobs:\n    lint:\n      run: echo ok\n      timeout: 1d\n"},
		{"unknown service", "version: 1\nchecks:\n  services:\n    redis: {}\n  jobs:\n    lint:\n      run: echo ok\n"},
		{"relative env_file", "version: 1\ndeployments:\n  production:\n    env_file: app.env\n"},
		{"uppercase environment", "version: 1\ndeployments:\n  Production:\n    strategy: restart\n"},
		{"slack channel with spaces", "version: 1\nnotify:\n  slack:\n    channel: \"my channel\"\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Parse([]byte(tt.yaml))
			if !errors.Is(err, ErrSchemaValidation) {
				t.Errorf("expected ErrSchemaValidation, got %v", err)
			}
		})
	}
}

func TestParseSemanticErrors(t *testing.T) {
	tests := []struct {
		name    string
		yaml    string
		target  error
		contain string
	}{
		{
			name:   "no checks",
			yaml:   "version: 1\n",
			target: ErrNoChecks,
		},
		{
			name:    "blank setup command",
			yaml:    "version: 1\nchecks:\n  setup:\n    - run: \"   \"\n  jobs:\n    lint:\n      run: echo ok\n",
			contain: "setup step [0]: command cannot be empty",
		},
		{
			name:    "blank job run command",
			yaml:    "version: 1\nchecks:\n  jobs:\n    lint:\n      run: \"   \"\n",
			contain: "check job \"lint\": run command cannot be empty",
		},
		{
			name:   "job self dependency",
			yaml:   "version: 1\nchecks:\n  jobs:\n    lint:\n      run: echo ok\n      needs: [lint]\n",
			target: ErrCyclicDependency,
		},
		{
			name:   "undefined job dependency",
			yaml:   "version: 1\nchecks:\n  jobs:\n    test:\n      run: echo ok\n      needs: [build]\n",
			target: ErrUnknownJob,
		},
		{
			name:   "two-node cycle",
			yaml:   "version: 1\nchecks:\n  jobs:\n    a:\n      run: echo a\n      needs: [b]\n    b:\n      run: echo b\n      needs: [a]\n",
			target: ErrCyclicDependency,
		},
		{
			name:   "three-node cycle",
			yaml:   "version: 1\nchecks:\n  jobs:\n    a:\n      run: echo a\n      needs: [c]\n    b:\n      run: echo b\n      needs: [a]\n    c:\n      run: echo c\n      needs: [b]\n",
			target: ErrCyclicDependency,
		},
		{
			name:   "absolute cache path",
			yaml:   "version: 1\nchecks:\n  setup:\n    - run: npm ci\n      cache:\n        key: [package-lock.json]\n        paths: [/var/cache]\n  jobs:\n    test:\n      run: echo ok\n",
			target: ErrInvalidPath,
		},
		{
			name:   "path traversal cache path",
			yaml:   "version: 1\nchecks:\n  setup:\n    - run: npm ci\n      cache:\n        key: [package-lock.json]\n        paths: [../../etc]\n  jobs:\n    test:\n      run: echo ok\n",
			target: ErrInvalidPath,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Parse([]byte(tt.yaml))
			if err == nil {
				t.Fatalf("expected error, got nil")
			}
			if tt.target != nil && !errors.Is(err, tt.target) {
				t.Errorf("expected error wrapping %v, got %v", tt.target, err)
			}
			if tt.contain != "" && !strings.Contains(err.Error(), tt.contain) {
				t.Errorf("expected error containing %q, got %v", tt.contain, err)
			}
		})
	}
}

func TestValidateSemanticsRejectsBadJobName(t *testing.T) {
	cfg := &Config{ZeroCIConfig: ZeroCIConfig{
		Version: 1,
		Checks:  &Checks{Jobs: ChecksJobs{"Bad Name": {Run: "echo ok"}}},
	}}
	if err := ValidateSemantics(cfg); !errors.Is(err, ErrInvalidIdentifier) {
		t.Errorf("expected ErrInvalidIdentifier, got %v", err)
	}
}

func TestTopologicalSortDiamond(t *testing.T) {
	cfg, err := Parse([]byte(`
version: 1
checks:
  jobs:
    build:
      run: echo build
    test-unit:
      run: echo unit
      needs: [build]
    test-e2e:
      run: echo e2e
      needs: [build]
    deploy:
      run: echo deploy
      needs: [test-unit, test-e2e]
`))
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}
	order, err := cfg.TopologicalSort()
	if err != nil {
		t.Fatalf("TopologicalSort failed: %v", err)
	}
	pos := make(map[string]int)
	for i, name := range order {
		pos[name] = i
	}
	for _, edge := range [][2]string{{"build", "test-unit"}, {"build", "test-e2e"}, {"test-unit", "deploy"}, {"test-e2e", "deploy"}} {
		if pos[edge[0]] >= pos[edge[1]] {
			t.Errorf("%s must come before %s in %v", edge[0], edge[1], order)
		}
	}
}

func TestLoadFile(t *testing.T) {
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, ".zeroci.yml")
	if err := os.WriteFile(configPath, []byte("version: 1\nchecks:\n  jobs:\n    lint:\n      run: npm run lint\n"), 0o600); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}
	cfg, err := Load(configPath)
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if cfg.Checks.Jobs["lint"].Run != "npm run lint" {
		t.Errorf("unexpected jobs: %+v", cfg.Checks.Jobs)
	}
	if _, err := Load(filepath.Join(tmpDir, "does-not-exist.yml")); err == nil {
		t.Errorf("expected error loading non-existent file, got nil")
	}
}
