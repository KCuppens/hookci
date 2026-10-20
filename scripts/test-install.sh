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
mkbin "$bin" curl

failures=0
fail() {
	echo "FAIL: $*" >&2
	failures=$((failures + 1))
}

# install BASE [ENV...] runs $installer with the tools in $path and the
# argument in $arg, if any, and sets $code and $out. Runs allow an unsigned
# install unless they pass ZEROCI_ALLOW_UNSIGNED=.
path=$bin
installer=$script
arg=
install() {
	base=$1
	shift
	set +e
	out=$(cd "$work/cwd" && env -i PATH="$path" HOME="$work/home" TMPDIR="$work/tmp" \
		ZEROCI_INSTALL_DRY_RUN=1 ZEROCI_VERSION=v0.0.0-test ZEROCI_TEST_UNAME_M=x86_64 \
		ZEROCI_RELEASE_BASE="file://$fixtures/$base" ZEROCI_PREFIX="$work/prefix" ZEROCI_ALLOW_UNSIGNED=1 \
		"$@" sh "$installer" ${arg:+"$arg"} 2>&1)
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
for step in "useradd --system" "zeroci.slice" "zeroci-agent@.service" "systemctl daemon-reload" "sudo zeroci connect --hub __HUB_ORIGIN__ <pair-token>"; do
	expect_out "$step" "dry-run plan"
done
expect_out "cosign not found and ZEROCI_ALLOW_UNSIGNED=1: checksum verified, signature not verified" "unsigned allowed"
case $out in
*"zeroci connect --hub __HUB_ORIGIN__ zc_pair_"*) fail "paired without a pair token: $out" ;;
esac
expect_out "+ " "dry-run prefix"
expect_out "ExecStart=$work/prefix/bin/zeroci agent --installation %i" "unit runs the binary under ZEROCI_PREFIX"
expect_out "RestartPreventExitStatus=3 4" "unit stays down when revoked or too old"
left=$(find "$work/tmp" "$work/home" "$work/cwd" -mindepth 1)
if [ -n "$left" ] || [ -e "$work/prefix" ]; then
	fail "dry run left files outside its mktemp -d: $left"
fi
case $out in
*"usermod -aG docker zeroci-deploy"*) fail "added zeroci-deploy to a docker group the host lacks: $out" ;;
esac

# With a docker group, zeroci-deploy joins it; the installer never creates it.
printf '#!/bin/sh\n[ "$1 $2" = "group docker" ]\n' >"$bin/getent"
chmod +x "$bin/getent"
install good
expect_code 0 "docker group"
expect_out "usermod -aG docker zeroci-deploy" "deploy user joins the docker group"
case $out in
*groupadd*) fail "installer created a group: $out" ;;
esac
rm "$bin/getent"

# Without cosign the installer refuses unless the user allows an unsigned install.
install good ZEROCI_ALLOW_UNSIGNED=
expect_code 4 "no cosign"
expect_out "cosign not found: install cosign" "no cosign"
case $out in
*"+ "*) fail "unsigned install ran privileged steps: $out" ;;
esac

# A pair token argument pairs the machine after the install.
arg=zc_pair_Test-token_1
install good
expect_code 0 "pair token"
expect_out "$work/prefix/bin/zeroci connect --hub __HUB_ORIGIN__ zc_pair_Test-token_1" "pair token"
case $out in
*"<pair-token>"*) fail "pair token run still prints the manual connect hint: $out" ;;
esac
for arg in --force "zc_pair_a;b" zc_pair_ "ghp_x"; do
	install good
	expect_code 1 "argument $arg"
	expect_out "the argument must be a pair token" "argument $arg"
done
arg=

install bad
expect_code 3 "bad checksums"
expect_out "checksum mismatch for zeroci_0.0.0-test_linux_amd64.tar.gz" "bad checksums"

install good ZEROCI_TEST_UNAME_M=mips
expect_code 2 "mips"

for prefix in relative/prefix "/opt/zero ci" '/opt/$HOME' '/opt/%i'; do
	install good ZEROCI_PREFIX="$prefix"
	expect_code 1 "ZEROCI_PREFIX=$prefix"
	expect_out "ZEROCI_PREFIX" "ZEROCI_PREFIX=$prefix"
done

# Downloads refuse plain http, also through a redirect, so the installer needs
# curl: wget follows a redirect from https to http.
install good ZEROCI_RELEASE_BASE=http://127.0.0.1:1/download
expect_code 1 "curl over http"
expect_out "refusing to download http://127.0.0.1:1/download/" "curl over http"
if command -v wget >/dev/null 2>&1; then
	path="$work/bin-wget"
	mkbin "$path" wget
	install good
	expect_code 1 "wget only"
	expect_out "need curl" "wget only"
	path=$bin
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
install good ZEROCI_COSIGN_IDENTITY=attacker@example.com ZEROCI_COSIGN_ISSUER=https://attacker.example
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
