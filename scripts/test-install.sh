#!/bin/sh
# Tests hub/static/install.sh in dry-run against the file:// fixtures in
# examples/install-fixtures. Nothing privileged runs.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
script="$root/hub/static/install.sh"
fixtures="$root/examples/install-fixtures"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# A bin dir holds only the tools the installer needs, so a host cosign never
# leaks in. mkbin DIR DOWNLOADER links them and the given curl or wget.
mkbin() {
	mkdir -p "$1"
	for tool in sh uname mktemp cp awk sha256sum cut tar gzip cat rm id "$2"; do
		ln -s "$(command -v "$tool")" "$1/$tool"
	done
}
mkdir -p "$work/tmp" "$work/home" "$work/cwd"
bin="$work/bin"
if command -v curl >/dev/null 2>&1; then
	mkbin "$bin" curl
else
	mkbin "$bin" wget
fi

failures=0
fail() {
	echo "FAIL: $*" >&2
	failures=$((failures + 1))
}

# install BASE [ENV...] runs $installer with the tools in $path and sets $code
# and $out.
path=$bin
installer=$script
install() {
	base=$1
	shift
	set +e
	out=$(cd "$work/cwd" && env -i PATH="$path" HOME="$work/home" TMPDIR="$work/tmp" \
		HOOKCI_INSTALL_DRY_RUN=1 HOOKCI_VERSION=v0.0.0-test HOOKCI_TEST_UNAME_M=x86_64 HOOKCI_TEST_SYSTEMD_DIR="$work/units" \
		HOOKCI_RELEASE_BASE="file://$fixtures/$base" HOOKCI_PREFIX="$work/prefix" \
		"$@" sh "$installer" 2>&1)
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
for step in "useradd --system" "hookci.slice" "hookci-agent@.service" "systemctl daemon-reload" "sudo hookci connect <pair-token>"; do
	expect_out "$step" "dry-run plan"
done
expect_out "cosign not found: checksum verified, signature not verified" "no cosign"
expect_out "+ " "dry-run prefix"
expect_out "ExecStart=$work/prefix/bin/hookci agent --installation %i" "unit runs the binary under HOOKCI_PREFIX"
expect_out "RestartPreventExitStatus=3 4" "unit stays down when revoked or too old"
left=$(find "$work/tmp" "$work/home" "$work/cwd" -mindepth 1)
if [ -n "$left" ] || [ -e "$work/prefix" ]; then
	fail "dry run left files outside its mktemp -d: $left"
fi
case $out in
*zeroci* | *MIGRATING*) fail "no legacy install, yet the installer mentioned zeroci: $out" ;;
esac

# A host with a ZeroCI unit gets a zeroci symlink to the new binary and one notice.
mkdir -p "$work/legacy-units"
: >"$work/legacy-units/zeroci-agent@.service"
install good HOOKCI_TEST_SYSTEMD_DIR="$work/legacy-units"
expect_code 0 "legacy unit"
expect_out "ln -sf hookci $work/prefix/bin/zeroci" "legacy unit symlink"
expect_out "https://github.com/KCuppens/hookci/blob/main/MIGRATING.md" "legacy unit notice"

# The ZEROCI_ spellings still drive the installer.
out=$(cd "$work/cwd" && env -i PATH="$path" HOME="$work/home" TMPDIR="$work/tmp" \
	ZEROCI_INSTALL_DRY_RUN=1 ZEROCI_VERSION=v0.0.0-test HOOKCI_TEST_UNAME_M=x86_64 HOOKCI_TEST_SYSTEMD_DIR="$work/units" \
	ZEROCI_RELEASE_BASE="file://$fixtures/good" ZEROCI_PREFIX="$work/prefix" sh "$script" 2>&1) || fail "ZEROCI_ env: exit $?: $out"
expect_out "ExecStart=$work/prefix/bin/hookci agent --installation %i" "ZEROCI_ env"

install bad
expect_code 3 "bad checksums"
expect_out "checksum mismatch for hookci_0.0.0-test_linux_amd64.tar.gz" "bad checksums"

install good HOOKCI_TEST_UNAME_M=mips
expect_code 2 "mips"

for prefix in relative/prefix "/opt/zero ci" '/opt/$HOME' '/opt/%i'; do
	install good HOOKCI_PREFIX="$prefix"
	expect_code 1 "HOOKCI_PREFIX=$prefix"
	expect_out "HOOKCI_PREFIX" "HOOKCI_PREFIX=$prefix"
done

# Downloads refuse plain http whichever downloader is present.
for downloader in curl wget; do
	command -v "$downloader" >/dev/null 2>&1 || continue
	path="$work/bin-$downloader"
	mkbin "$path" "$downloader"
	install good HOOKCI_RELEASE_BASE=http://127.0.0.1:1/download
	expect_code 1 "$downloader over http"
	expect_out "refusing to download http://127.0.0.1:1/download/" "$downloader over http"
	path=$bin
done
if command -v curl >/dev/null 2>&1; then
	install good HOOKCI_VERSION=latest HOOKCI_RELEASE_BASE=http://127.0.0.1:1/download
	expect_code 1 "latest over http"
	expect_out 'Protocol "http"' "latest over http"
fi

# A download cut off inside the script runs none of it.
awk '{ print } /install -D/ { exit }' "$script" >"$work/partial.sh"
installer="$work/partial.sh"
install good
installer=$script
case $out in
*Downloading* | *"+ "*) fail "truncated installer ran: $out" ;;
esac

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
install good HOOKCI_COSIGN_IDENTITY=attacker@example.com HOOKCI_COSIGN_ISSUER=https://attacker.example
expect_code 0 "cosign identity ignores the environment"
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
echo "LimitNOFILE=4096" >>"$drift/packaging/hookci-agent@.service"
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
