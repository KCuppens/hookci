package config

import (
	"encoding/json"
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
	testCheck, ok := cfg.Checks["test"]
	if !ok {
		t.Fatal("missing 'test' check")
	}
	if testCheck.Run != "npm test" {
		t.Fatalf("expected 'npm test', got %s", testCheck.Run)
	}
	if len(testCheck.Needs) != 1 || testCheck.Needs[0] != "lint" {
		t.Fatalf("expected needs ['lint'], got %v", testCheck.Needs)
	}
}
