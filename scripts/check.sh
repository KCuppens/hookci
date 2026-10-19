#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

(cd agent && fmt_out=$(gofmt -l .) && [ -z "$fmt_out" ] || { echo "$fmt_out" >&2; exit 1; })
(cd agent && go vet ./... && go test ./...)
(cd hub && npm ci && npm test && npx wrangler deploy --dry-run --outdir dist)

echo "check: ok"
