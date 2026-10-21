package config

import (
	_ "embed"
)

// SchemaJSON contains the embedded canonical HookCI JSON schema.
//
//go:embed hookci.schema.json
var SchemaJSON []byte
