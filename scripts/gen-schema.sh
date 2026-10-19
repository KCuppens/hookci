#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

echo "==> Validating JSON Schema syntax..."
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1]))' schema/zeroci.schema.json

echo "==> Generating Go types into agent/internal/config..."
mkdir -p agent/internal/config
cp schema/zeroci.schema.json agent/internal/config/zeroci.schema.json
(cd agent && go run github.com/atombender/go-jsonschema@v0.24.1 \
    --package config \
    --output internal/config/types_gen.go \
    --tags json,yaml \
    --struct-name-from-title \
    ../schema/zeroci.schema.json)

echo "==> Generating TypeScript types into hub/src..."
mkdir -p hub/src
(cd hub && npx json-schema-to-typescript ../schema/zeroci.schema.json -o src/schema.d.ts --unreachableDefinitions)

echo "gen-schema: ok"
