//go:build tools

// Package tools pins code generators in go.mod so scripts/gen-schema.sh runs a fixed version.
package tools

import _ "github.com/atombender/go-jsonschema"
