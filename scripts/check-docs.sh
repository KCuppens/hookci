#!/usr/bin/env bash
# Checks docs/self-host.md against the zeroci-hub CLI: every SetupError code
# thrown in hub/cli/*.ts needs a "### `code`" troubleshooting entry, and every
# option parsed in hub/cli/index.ts must appear as `option` in the doc.
set -euo pipefail

cd "$(dirname "$0")/.."

doc=docs/self-host.md
missing=()

codes=$(grep -ohE 'SetupError\("[a-z_]+"' hub/cli/*.ts | grep -oE '"[a-z_]+"' | tr -d '"' | sort -u)
[ -n "$codes" ] || { echo "check-docs: found no SetupError codes in hub/cli/*.ts" >&2; exit 1; }
for code in $codes; do
	grep -qxF "### \`$code\`" "$doc" || missing+=("SetupError code $code (needs a '### \`$code\`' entry)")
done

flags=$(grep -oE 'arg === "-[-a-z]+"' hub/cli/index.ts | grep -oE '"-[-a-z]+"' | tr -d '"' | sort -u)
[ -n "$flags" ] || { echo "check-docs: found no options in hub/cli/index.ts" >&2; exit 1; }
for flag in $flags; do
	grep -qE "\`$flag[\` ]" "$doc" || missing+=("zeroci-hub option $flag")
done

if [ ${#missing[@]} -gt 0 ]; then
	echo "check-docs: $doc is missing:" >&2
	printf '  %s\n' "${missing[@]}" >&2
	exit 1
fi
echo "check-docs: ok"
