package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestSchemaJSONEmbedded(t *testing.T) {
	if len(SchemaJSON) == 0 {
		t.Fatal("expected SchemaJSON to be non-empty")
	}
	var m map[string]any
	if err := json.Unmarshal(SchemaJSON, &m); err != nil {
		t.Fatalf("failed to parse embedded SchemaJSON: %v", err)
	}
	if id, ok := m["$id"].(string); !ok || id != "https://ci.webuno.io/schema/zeroci.schema.json" {
		t.Fatalf("unexpected $id in embedded schema: %v", m["$id"])
	}
}

func TestConfigTypes(t *testing.T) {
	raw := `{
		"version": 1,
		"setup": ["npm ci"],
		"checks": {
			"lint": {
				"run": "npm run lint"
			},
			"test": {
				"run": "npm test",
				"needs": ["lint"]
			}
		}
	}`
	var cfg Config
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		t.Fatalf("failed to unmarshal Config: %v", err)
	}
	if cfg.Version != 1 {
		t.Fatalf("expected version 1, got %d", cfg.Version)
	}
	if len(cfg.Setup) != 1 || cfg.Setup[0] != "npm ci" {
		t.Fatalf("unexpected setup: %v", cfg.Setup)
	}
	if len(cfg.Checks) != 2 {
		t.Fatalf("expected 2 checks, got %d", len(cfg.Checks))
	}
	lint, ok := cfg.Checks["lint"]
	if !ok || lint.Run != "npm run lint" {
		t.Fatalf("unexpected lint check: %+v", lint)
	}
	testJob, ok := cfg.Checks["test"]
	if !ok || testJob.Run != "npm test" || len(testJob.Needs) != 1 || testJob.Needs[0] != "lint" {
		t.Fatalf("unexpected test check: %+v", testJob)
	}
}

func TestParseValidYAML(t *testing.T) {
	yamlContent := `
version: 1
setup:
  - npm ci
checks:
  lint:
    run: npm run lint
  test:
    run: npm test
    needs: [lint]
caches:
  pnpm:
    path: .pnpm-store
    key: "pnpm-lock.yaml"
services:
  postgres:
    image: postgres:16-alpine
egress:
  - registry.npmjs.org
`
	cfg, err := Parse([]byte(yamlContent))
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}
	if cfg.Version != 1 {
		t.Errorf("expected version 1, got %d", cfg.Version)
	}
	if len(cfg.Setup) != 1 || cfg.Setup[0] != "npm ci" {
		t.Errorf("unexpected setup: %v", cfg.Setup)
	}
	if len(cfg.Checks) != 2 {
		t.Errorf("expected 2 checks, got %d", len(cfg.Checks))
	}
	if len(cfg.Caches) != 1 {
		t.Errorf("expected 1 cache, got %d", len(cfg.Caches))
	}
	if len(cfg.Services) != 1 {
		t.Errorf("expected 1 service, got %d", len(cfg.Services))
	}
	if len(cfg.Egress) != 1 || cfg.Egress[0] != "registry.npmjs.org" {
		t.Errorf("unexpected egress: %v", cfg.Egress)
	}

	order, err := cfg.TopologicalSort()
	if err != nil {
		t.Fatalf("TopologicalSort failed: %v", err)
	}
	expected := []string{"lint", "test"}
	if !reflect.DeepEqual(order, expected) {
		t.Errorf("expected order %v, got %v", expected, order)
	}
}

func TestParseEmptyConfig(t *testing.T) {
	_, err := Parse([]byte(""))
	if !errors.Is(err, ErrEmptyConfig) {
		t.Errorf("expected ErrEmptyConfig, got %v", err)
	}

	_, err = Parse([]byte("   \n\t  "))
	if !errors.Is(err, ErrEmptyConfig) {
		t.Errorf("expected ErrEmptyConfig, got %v", err)
	}
}

func TestParseInvalidSchema(t *testing.T) {
	tests := []struct {
		name    string
		yaml    string
		wantErr string
	}{
		{
			name: "version 2",
			yaml: `
version: 2
checks:
  lint:
    run: echo ok
`,
			wantErr: "schema validation failed",
		},
		{
			name: "missing version",
			yaml: `
checks:
  lint:
    run: echo ok
`,
			wantErr: "schema validation failed",
		},
		{
			name: "missing run in check",
			yaml: `
version: 1
checks:
  lint:
    needs: []
`,
			wantErr: "schema validation failed",
		},
		{
			name: "extra property at root",
			yaml: `
version: 1
unknown_key: true
checks:
  lint:
    run: echo ok
`,
			wantErr: "schema validation failed",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Parse([]byte(tt.yaml))
			if err == nil {
				t.Fatalf("expected error, got nil")
			}
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
			name: "no checks",
			yaml: `
version: 1
setup:
  - echo hello
`,
			target: ErrNoChecks,
		},
		{
			name: "empty setup command",
			yaml: `
version: 1
setup:
  - "   "
checks:
  lint:
    run: echo ok
`,
			contain: "setup step [0]: command cannot be empty",
		},
		{
			name: "empty check run command",
			yaml: `
version: 1
checks:
  lint:
    run: "   "
`,
			contain: "check job \"lint\": run command cannot be empty",
		},
		{
			name: "invalid check name",
			yaml: `
version: 1
checks:
  "invalid name with spaces":
    run: echo ok
`,
			target: ErrInvalidIdentifier,
		},
		{
			name: "job self dependency",
			yaml: `
version: 1
checks:
  lint:
    run: echo ok
    needs: [lint]
`,
			target: ErrCyclicDependency,
		},
		{
			name: "undefined job dependency",
			yaml: `
version: 1
checks:
  test:
    run: echo ok
    needs: [build]
`,
			target: ErrUnknownJob,
		},
		{
			name: "two-node cyclic dependency",
			yaml: `
version: 1
checks:
  a:
    run: echo a
    needs: [b]
  b:
    run: echo b
    needs: [a]
`,
			target: ErrCyclicDependency,
		},
		{
			name: "three-node cyclic dependency",
			yaml: `
version: 1
checks:
  a:
    run: echo a
    needs: [c]
  b:
    run: echo b
    needs: [a]
  c:
    run: echo c
    needs: [b]
`,
			target: ErrCyclicDependency,
		},
		{
			name: "undefined service reference",
			yaml: `
version: 1
checks:
  test:
    run: echo ok
    services: [redis]
`,
			target: ErrUnknownService,
		},
		{
			name: "empty service image",
			yaml: `
version: 1
services:
  db:
    image: "   "
checks:
  test:
    run: echo ok
`,
			contain: "service \"db\": image cannot be empty",
		},
		{
			name: "empty cache key",
			yaml: `
version: 1
caches:
  pnpm:
    path: .store
    key: "   "
checks:
  test:
    run: echo ok
`,
			contain: "cache \"pnpm\": key cannot be empty",
		},
		{
			name: "absolute cache path",
			yaml: `
version: 1
caches:
  pnpm:
    path: /var/cache
    key: hash
checks:
  test:
    run: echo ok
`,
			target: ErrInvalidPath,
		},
		{
			name: "path traversal cache path",
			yaml: `
version: 1
caches:
  pnpm:
    path: ../../etc
    key: hash
checks:
  test:
    run: echo ok
`,
			target: ErrInvalidPath,
		},
		{
			name: "invalid egress url instead of hostname",
			yaml: `
version: 1
egress:
  - https://github.com
checks:
  test:
    run: echo ok
`,
			contain: "must be a bare hostname or domain, not a URL",
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

func TestTopologicalSortDiamond(t *testing.T) {
	yamlContent := `
version: 1
checks:
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
`
	cfg, err := Parse([]byte(yamlContent))
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

	if pos["build"] >= pos["test-unit"] {
		t.Errorf("build must come before test-unit")
	}
	if pos["build"] >= pos["test-e2e"] {
		t.Errorf("build must come before test-e2e")
	}
	if pos["test-unit"] >= pos["deploy"] {
		t.Errorf("test-unit must come before deploy")
	}
	if pos["test-e2e"] >= pos["deploy"] {
		t.Errorf("test-e2e must come before deploy")
	}
}

func TestLoadFile(t *testing.T) {
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, ".zeroci.yml")

	validYAML := `
version: 1
checks:
  lint:
    run: npm run lint
`
	if err := os.WriteFile(configPath, []byte(validYAML), 0o600); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	cfg, err := Load(configPath)
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if cfg.Version != 1 {
		t.Errorf("expected version 1, got %d", cfg.Version)
	}

	// Non-existent file
	_, err = Load(filepath.Join(tmpDir, "does-not-exist.yml"))
	if err == nil {
		t.Errorf("expected error loading non-existent file, got nil")
	}
}
