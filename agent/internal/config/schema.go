package config

import (
	_ "embed"
)

// SchemaJSON contains the embedded canonical ZeroCI JSON schema.
//
//go:embed zeroci.schema.json
var SchemaJSON []byte
