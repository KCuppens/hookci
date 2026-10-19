#!/bin/sh
# ZeroCI agent installer, served by the hub at __HUB_ORIGIN__/install
# (hub __HUB_VERSION__).
#
#   curl -fsSL __HUB_ORIGIN__/install | sh
#
# Environment:
#   ZEROCI_VERSION          release tag to install, "latest" (default) or vX.Y.Z
#   ZEROCI_INSTALL_DRY_RUN  when set, print the privileged steps instead of running them
#   ZEROCI_RELEASE_BASE     where release assets live (a file:// base is copied)
#   ZEROCI_PREFIX           install prefix, the binary goes to $ZEROCI_PREFIX/bin
set -eu

# Releases are cut locally with goreleaser; SHA256SUMS is signed with the
# maintainer's cosign keyless identity (agent/internal/selfupdate/verify.go).
ZEROCI_COSIGN_IDENTITY="${ZEROCI_COSIGN_IDENTITY:-kobecuppens@hotmail.com}"
ZEROCI_COSIGN_ISSUER="${ZEROCI_COSIGN_ISSUER:-https://github.com/login/oauth}"

ZEROCI_VERSION="${ZEROCI_VERSION:-latest}"
ZEROCI_INSTALL_DRY_RUN="${ZEROCI_INSTALL_DRY_RUN:-}"
ZEROCI_RELEASE_BASE="${ZEROCI_RELEASE_BASE:-https://github.com/KCuppens/zerocideploy/releases/download}"
ZEROCI_PREFIX="${ZEROCI_PREFIX:-/usr/local}"
HUB_ORIGIN="__HUB_ORIGIN__"

die() {
	code=$1
	shift
	echo "zeroci install: $*" >&2
	exit "$code"
}

run() { if [ -n "$ZEROCI_INSTALL_DRY_RUN" ]; then echo "+ $*"; else "$@"; fi; }

have() { command -v "$1" >/dev/null 2>&1; }

# fetch URL DEST copies a file:// URL and downloads anything else.
fetch() {
	case $1 in
	file://*) cp "${1#file://}" "$2" ;;
	*)
		if have curl; then
			curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"
		else
			wget -q -O "$2" "$1"
		fi
		;;
	esac
}

[ "$(uname -s)" = Linux ] || die 2 "unsupported OS $(uname -s): the agent runs on Linux"
machine="${ZEROCI_TEST_UNAME_M:-$(uname -m)}"
case $machine in
x86_64 | amd64) arch=amd64 ;;
aarch64 | arm64) arch=arm64 ;;
*) die 2 "unsupported architecture $machine: want x86_64 or aarch64" ;;
esac

have curl || have wget || die 1 "need curl or wget"
have tar || die 1 "need tar"
if have sha256sum; then
	sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif have shasum; then
	sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
	die 1 "need sha256sum or shasum"
fi

tag=$ZEROCI_VERSION
if [ "$tag" = latest ]; then
	have curl || die 1 "resolving the latest release needs curl: set ZEROCI_VERSION=vX.Y.Z"
	latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "${ZEROCI_RELEASE_BASE%/download}/latest") ||
		die 1 "cannot resolve the latest release"
	tag=${latest##*/}
fi
case $tag in
v*) ;;
*) die 1 "ZEROCI_VERSION must be latest or vX.Y.Z, got $tag" ;;
esac
asset="zeroci_${tag#v}_linux_${arch}.tar.gz"
url="$ZEROCI_RELEASE_BASE/$tag"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading $asset ($tag)"
fetch "$url/$asset" "$tmp/$asset" || die 1 "download failed: $url/$asset"
fetch "$url/SHA256SUMS" "$tmp/SHA256SUMS" || die 1 "download failed: $url/SHA256SUMS"

want=$(awk -v a="$asset" '$2 == a || $2 == "*" a { print $1; exit }' "$tmp/SHA256SUMS")
[ -n "$want" ] || die 3 "checksum mismatch for $asset: not listed in SHA256SUMS"
[ "$(sha256 "$tmp/$asset")" = "$want" ] || die 3 "checksum mismatch for $asset"

if have cosign; then
	fetch "$url/SHA256SUMS.sigstore.json" "$tmp/SHA256SUMS.sigstore.json" ||
		die 4 "download failed: $url/SHA256SUMS.sigstore.json"
	cosign verify-blob --certificate-identity "$ZEROCI_COSIGN_IDENTITY" \
		--certificate-oidc-issuer "$ZEROCI_COSIGN_ISSUER" \
		--bundle "$tmp/SHA256SUMS.sigstore.json" "$tmp/SHA256SUMS" >/dev/null 2>&1 ||
		die 4 "signature verification failed for SHA256SUMS"
	echo "Signature verified"
else
	echo "cosign not found: checksum verified, signature not verified"
fi

tar -xzf "$tmp/$asset" -C "$tmp" zeroci || die 1 "$asset has no zeroci binary"

# BEGIN packaging/zeroci.slice (scripts/gen-install.sh)
cat >"$tmp/zeroci.slice" <<'EOF'
[Unit]
Description=ZeroCI agents and their jobs
Before=slices.target
EOF
# END packaging/zeroci.slice

# BEGIN packaging/zeroci-agent@.service (scripts/gen-install.sh)
cat >"$tmp/zeroci-agent@.service" <<'EOF'
[Unit]
Description=ZeroCI agent (installation %i)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/zeroci agent --installation %i
Restart=always
RestartSec=5
Slice=zeroci.slice
StateDirectory=zeroci/%i
NoNewPrivileges=no

[Install]
WantedBy=multi-user.target
EOF
# END packaging/zeroci-agent@.service

sudo=
if [ "$(id -u)" != 0 ]; then
	sudo=sudo
fi

run $sudo install -D -m 0755 -o root -g root "$tmp/zeroci" "$ZEROCI_PREFIX/bin/zeroci"
if ! id zeroci-run >/dev/null 2>&1; then
	run $sudo useradd --system --no-create-home --shell /usr/sbin/nologin zeroci-run
fi
run $sudo install -m 0644 -o root -g root "$tmp/zeroci.slice" /etc/systemd/system/zeroci.slice
run $sudo install -m 0644 -o root -g root "$tmp/zeroci-agent@.service" /etc/systemd/system/zeroci-agent@.service
run $sudo mkdir -p /var/lib/zeroci
run $sudo chmod 0700 /var/lib/zeroci
run $sudo systemctl daemon-reload

echo
echo "Installed zeroci $tag. Next, pair this machine with the token from Slack App Home ($HUB_ORIGIN):"
echo "  sudo zeroci connect <pair-token>"
