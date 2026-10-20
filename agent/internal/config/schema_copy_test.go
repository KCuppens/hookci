package config

import (
	"bytes"
	"os"
	"testing"
)

func TestEmbeddedSchemaMatchesSource(t *testing.T) {
	src, err := os.ReadFile("../../../schema/hookci.schema.json")
	if err != nil {
		t.Fatalf("read source schema: %v", err)
	}
	local, err := os.ReadFile("hookci.schema.json")
	if err != nil {
		t.Fatalf("read embedded copy: %v", err)
	}
	if !bytes.Equal(src, local) {
		t.Fatal("agent/internal/config/hookci.schema.json differs from schema/hookci.schema.json; run make schema")
	}
	if !bytes.Equal(SchemaJSON, src) {
		t.Fatal("embedded SchemaJSON differs from schema/hookci.schema.json")
	}
}
