#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

(cd schema && npm ci && npm test)
scripts/schema-check.sh

(cd agent && fmt_out=$(gofmt -l .) && [ -z "$fmt_out" ] || { echo "$fmt_out" >&2; exit 1; })
(cd agent && go vet ./... && go test ./...)
scripts/gen-install.sh --check
scripts/test-install.sh
node scripts/gen-manifests.mjs --check

(
	cd hub
	npm ci
	npm test
	npm run typecheck
	npx wrangler deploy --dry-run --env "" --outdir /tmp/zeroci-dry
	npx wrangler deploy --dry-run --env staging --outdir /tmp/zeroci-dry-staging
)

echo "check: ok"
