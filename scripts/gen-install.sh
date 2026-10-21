#!/bin/sh
# Embeds packaging/hookci.slice and packaging/hookci-agent@.service into
# hub/static/install.sh between its "# BEGIN packaging/<file>" and
# "# END packaging/<file>" markers. With --check, fails instead when the
# embedded copies differ from packaging/.
set -eu
cd "$(dirname "$0")/.."

script=hub/static/install.sh
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT INT TERM

awk '
/^# BEGIN packaging\// {
	print
	f = $3
	name = f
	sub(/^packaging\//, "", name)
	printf "cat >\"$tmp/%s\" <<'"'"'EOF'"'"'\n", name
	while ((getline line < f) > 0) print line
	close(f)
	print "EOF"
	skip = 1
	next
}
/^# END packaging\// { skip = 0 }
!skip { print }
' "$script" >"$tmp"

if [ "${1:-}" = "--check" ]; then
	if ! cmp -s "$tmp" "$script"; then
		diff -u "$script" "$tmp" >&2 || true
		echo "gen-install: $script differs from packaging/; run scripts/gen-install.sh" >&2
		exit 1
	fi
	echo "gen-install: ok"
	exit 0
fi
cat "$tmp" >"$script"
echo "gen-install: wrote $script"
