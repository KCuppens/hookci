#!/bin/sh
# Writes the SLSA v1 provenance of the goreleaser build in dist/ to
# dist/hookci_<ver>.intoto.jsonl and signs it with cosign attest-blob.
#
#   scripts/provenance.sh vX.Y.Z
set -eu
cd "$(dirname "$0")/.."

tag=${1:?usage: scripts/provenance.sh vX.Y.Z}
ver=${tag#v}
sums=dist/SHA256SUMS
[ -f "$sums" ] || {
	echo "provenance: $sums not found; run goreleaser first" >&2
	exit 1
}

commit=$(git rev-parse HEAD)
repo=https://github.com/KCuppens/hookci
goreleaser_version=$(goreleaser --version 2>/dev/null | awk '/^GitVersion:/ { print $2 }')
go_version=$(go env GOVERSION)
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
out=dist/hookci_${ver}.intoto.jsonl

subjects=$(awk '{ printf "%s{\"name\":\"%s\",\"digest\":{\"sha256\":\"%s\"}}", (NR > 1 ? "," : ""), $2, $1 }' "$sums")

predicate="{\
\"buildDefinition\":{\
\"buildType\":\"https://goreleaser.com/local-build/v1\",\
\"externalParameters\":{\"tag\":\"$tag\",\"config\":\".goreleaser.yaml\"},\
\"internalParameters\":{\"goreleaser_version\":\"$goreleaser_version\",\"go_version\":\"$go_version\"},\
\"resolvedDependencies\":[{\"uri\":\"git+$repo@refs/tags/$tag\",\"digest\":{\"gitCommit\":\"$commit\"}}]},\
\"runDetails\":{\
\"builder\":{\"id\":\"$repo/scripts/release.sh\"},\
\"metadata\":{\"invocationId\":\"$tag\",\"startedOn\":\"$started\"}}}"

printf '{"_type":"https://in-toto.io/Statement/v1","subject":[%s],"predicateType":"https://slsa.dev/provenance/v1","predicate":%s}\n' \
	"$subjects" "$predicate" >"$out"

# cosign attests SHA256SUMS, whose digests cover every artifact.
pred=$(mktemp)
trap 'rm -f "$pred"' EXIT INT TERM
printf '%s\n' "$predicate" >"$pred"
cosign attest-blob --yes --type slsaprovenance1 --predicate "$pred" \
	--bundle "$out.sigstore.json" "$sums"
echo "provenance: wrote $out and $out.sigstore.json"
