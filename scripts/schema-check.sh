#!/usr/bin/env bash
# Regenerates every file scripts/gen-schema.sh owns into a temp dir and diffs
# each one against the copy in the repo. Exits non-zero on any drift.
set -euo pipefail

cd "$(dirname "$0")/.."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

scripts/gen-schema.sh "$tmp" >/dev/null

status=0
while IFS= read -r f; do
	diff -u "$f" "$tmp/$f" || status=1
done < <(cd "$tmp" && find . -type f | sed 's|^\./||' | sort)

if [ "$status" -ne 0 ]; then
	echo "schema-check: generated files differ from schema/zeroci.schema.json; run 'make schema'" >&2
	exit 1
fi
echo "schema-check: ok"
