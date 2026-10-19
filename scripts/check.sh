#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

sh scripts/gen-schema.sh
git diff --exit-code -- agent/internal/config/types_gen.go agent/internal/config/zeroci.schema.json hub/src/schema.d.ts >/dev/null || {
	echo "Error: Generated types are out of sync with schema/zeroci.schema.json. Run 'make schema' and commit the changes." >&2
	exit 1
}

(cd agent && fmt_out=$(gofmt -l .) && [ -z "$fmt_out" ] || { echo "$fmt_out" >&2; exit 1; })
(cd agent && go vet ./... && go test ./...)
(cd hub && npm ci && npm test && npx wrangler deploy --dry-run --outdir dist)

echo "check: ok"
