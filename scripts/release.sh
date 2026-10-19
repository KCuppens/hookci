#!/bin/sh
# Cuts a signed agent release from the tagged, clean HEAD. Run by a
# maintainer; cosign signs keyless with the maintainer's OIDC identity.
#
#   git tag v0.2.0 && scripts/release.sh
set -eu
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
	echo "release: working tree is not clean" >&2
	exit 1
fi
tag=$(git describe --tags --exact-match HEAD 2>/dev/null) || {
	echo "release: HEAD has no tag; tag it vX.Y.Z first" >&2
	exit 1
}
case $tag in
v[0-9]*.[0-9]*.[0-9]*) ;;
*)
	echo "release: tag $tag is not vX.Y.Z" >&2
	exit 1
	;;
esac
for tool in goreleaser cosign go; do
	command -v "$tool" >/dev/null 2>&1 || {
		echo "release: $tool not found" >&2
		exit 1
	}
done

goreleaser release --clean
scripts/provenance.sh "$tag"
echo "release: $tag is a draft; upload dist/zeroci_${tag#v}.intoto.jsonl and its .sigstore.json, then publish it"
