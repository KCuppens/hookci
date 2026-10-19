#!/bin/sh
# Tests hub/static/install.sh in dry-run against the file:// fixtures in
# examples/install-fixtures. Nothing privileged runs.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
script="$root/hub/static/install.sh"
fixtures="$root/examples/install-fixtures"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# bin holds only the tools the installer needs, so a host cosign never leaks in.
bin="$work/bin"
mkdir -p "$bin" "$work/tmp" "$work/home" "$work/cwd"
for tool in sh uname mktemp cp awk sha256sum cut tar gzip cat rm id; do
	ln -s "$(command -v "$tool")" "$bin/$tool"
done
ln -s "$(command -v curl || command -v wget)" "$bin/$(basename "$(command -v curl || command -v wget)")"

failures=0
fail() {
	echo "FAIL: $*" >&2
	failures=$((failures + 1))
}

# install BASE [ENV...] runs the installer and sets $code and $out.
install() {
	base=$1
	shift
	set +e
	out=$(cd "$work/cwd" && env -i PATH="$bin" HOME="$work/home" TMPDIR="$work/tmp" \
		ZEROCI_INSTALL_DRY_RUN=1 ZEROCI_VERSION=v0.0.0-test ZEROCI_TEST_UNAME_M=x86_64 \
		ZEROCI_RELEASE_BASE="file://$fixtures/$base" ZEROCI_PREFIX="$work/prefix" \
		"$@" sh "$script" 2>&1)
	code=$?
	set -e
}

expect_code() {
	[ "$code" = "$1" ] || fail "$2: exit $code, want $1; output:
$out"
}

expect_out() {
	case $out in
	*"$1"*) ;;
	*) fail "$2: output lacks '$1':
$out" ;;
	esac
}

install good
expect_code 0 "good checksums"
for step in "useradd --system" "zeroci.slice" "zeroci-agent@.service" "systemctl daemon-reload" "sudo zeroci connect <pair-token>"; do
	expect_out "$step" "dry-run plan"
done
expect_out "cosign not found: checksum verified, signature not verified" "no cosign"
expect_out "+ " "dry-run prefix"
left=$(find "$work/tmp" "$work/home" "$work/cwd" -mindepth 1)
if [ -n "$left" ] || [ -e "$work/prefix" ]; then
	fail "dry run left files outside its mktemp -d: $left"
fi

install bad
expect_code 3 "bad checksums"
expect_out "checksum mismatch for zeroci_0.0.0-test_linux_amd64.tar.gz" "bad checksums"

install good ZEROCI_TEST_UNAME_M=mips
expect_code 2 "mips"

printf '#!/bin/sh\nexit 1\n' >"$bin/cosign"
chmod +x "$bin/cosign"
install good
expect_code 4 "failing cosign"

# cosign succeeds only for the SHA256SUMS bundle signed by the pinned identity.
cat >"$bin/cosign" <<'EOF'
#!/bin/sh
case "$*" in
"verify-blob --certificate-identity kobecuppens@hotmail.com --certificate-oidc-issuer https://github.com/login/oauth --bundle "*/SHA256SUMS.sigstore.json" "*/SHA256SUMS) exit 0 ;;
esac
exit 1
EOF
install good
expect_code 0 "passing cosign"
expect_out "Signature verified" "passing cosign"
rm "$bin/cosign"

# gen-install.sh --check fails when the embedded unit drifts from packaging/.
drift="$work/drift"
mkdir -p "$drift/scripts" "$drift/hub/static"
cp "$root/scripts/gen-install.sh" "$drift/scripts/"
cp -R "$root/packaging" "$drift/packaging"
cp "$script" "$drift/hub/static/install.sh"
if ! "$drift/scripts/gen-install.sh" --check >/dev/null 2>&1; then
	fail "gen-install --check fails on the committed copy"
fi
echo "LimitNOFILE=4096" >>"$drift/packaging/zeroci-agent@.service"
if "$drift/scripts/gen-install.sh" --check >/dev/null 2>&1; then
	fail "gen-install --check passes with a drifted unit"
fi
"$drift/scripts/gen-install.sh" >/dev/null
if ! grep -q '^LimitNOFILE=4096$' "$drift/hub/static/install.sh"; then
	fail "gen-install did not embed the changed unit"
fi

if [ "$failures" -ne 0 ]; then
	echo "test-install: $failures failure(s)" >&2
	exit 1
fi
echo "test-install: ok"
