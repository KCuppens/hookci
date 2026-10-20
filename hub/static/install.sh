#!/bin/sh
# HookCI agent installer, served by the hub at __HUB_ORIGIN__/install
# (hub __HUB_VERSION__).
#
#   curl -fsSL __HUB_ORIGIN__/install | sh
#   curl -fsSL __HUB_ORIGIN__/install | sh -s -- <pair-token>
#
# With a pair token the installer also runs `hookci connect` to pair this
# machine with the hub.
#
# Environment:
#   HOOKCI_VERSION          release tag to install, "latest" (default) or vX.Y.Z
#   HOOKCI_INSTALL_DRY_RUN  when set, print the privileged steps instead of running them
#   HOOKCI_RELEASE_BASE     where release assets live (a file:// base is copied)
#   HOOKCI_PREFIX           absolute install prefix, the binary goes to $HOOKCI_PREFIX/bin
#   HOOKCI_ALLOW_UNSIGNED   set to 1 to install without cosign, checking only the checksum
set -eu

# Releases are cut locally with goreleaser; SHA256SUMS is signed with the
# maintainer's cosign keyless identity (agent/internal/selfupdate/verify.go).
HOOKCI_COSIGN_IDENTITY="kobecuppens@hotmail.com"
HOOKCI_COSIGN_ISSUER="https://github.com/login/oauth"

HOOKCI_VERSION="${HOOKCI_VERSION:-latest}"
HOOKCI_INSTALL_DRY_RUN="${HOOKCI_INSTALL_DRY_RUN:-}"
HOOKCI_ALLOW_UNSIGNED="${HOOKCI_ALLOW_UNSIGNED:-}"
HOOKCI_RELEASE_BASE="${HOOKCI_RELEASE_BASE:-https://github.com/KCuppens/hookci/releases/download}"
HOOKCI_PREFIX="${HOOKCI_PREFIX:-/usr/local}"
HUB_ORIGIN="__HUB_ORIGIN__"

die() {
	code=$1
	shift
	echo "hookci install: $*" >&2
	exit "$code"
}

run() { if [ -n "$HOOKCI_INSTALL_DRY_RUN" ]; then echo "+ $*"; else "$@"; fi; }

have() { command -v "$1" >/dev/null 2>&1; }

# fetch URL DEST copies a file:// URL and downloads an https:// one with curl,
# whose --proto '=https' also refuses a redirect to another scheme. wget has no
# such switch for single downloads, so the installer needs curl.
fetch() {
	case $1 in
	file://*) cp "${1#file://}" "$2" ;;
	https://*) curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1" ;;
	*) die 1 "refusing to download $1: not an https:// or file:// URL" ;;
	esac
}

# write_units writes the systemd units from packaging/ into $tmp.
write_units() {
# BEGIN packaging/hookci.slice (scripts/gen-install.sh)
cat >"$tmp/hookci.slice" <<'EOF'
[Unit]
Description=HookCI agents and their jobs
Before=slices.target
EOF
# END packaging/hookci.slice

# BEGIN packaging/hookci-agent@.service (scripts/gen-install.sh)
cat >"$tmp/hookci-agent@.service" <<'EOF'
[Unit]
Description=HookCI agent (installation %i)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/hookci agent --installation %i
Restart=always
# Exit 3 is a revoked agent or no usable agent.json, 4 is agent_too_old
# (agent/internal/cli/exit.go); restarting cannot fix either.
RestartPreventExitStatus=3 4
RestartSec=5
Slice=hookci.slice
StateDirectory=hookci/%i
NoNewPrivileges=no

[Install]
WantedBy=multi-user.target
EOF
# END packaging/hookci-agent@.service
}

# The whole install runs from main, so a download cut off mid-transfer
# defines functions but runs nothing.
main() {
	[ $# -le 1 ] || die 1 "usage: curl -fsSL $HUB_ORIGIN/install | sh -s -- [pair-token]"
	token=${1:-}
	case $token in
	"" | hci_pair_?*) ;;
	*) die 1 "the argument must be a pair token: hci_pair_ then letters, digits, _ or -" ;;
	esac
	case $token in
	*[!A-Za-z0-9_-]*) die 1 "the argument must be a pair token: hci_pair_ then letters, digits, _ or -" ;;
	esac

	[ "$(uname -s)" = Linux ] || die 2 "unsupported OS $(uname -s): the agent runs on Linux"
	machine="${HOOKCI_TEST_UNAME_M:-$(uname -m)}"
	case $machine in
	x86_64 | amd64) arch=amd64 ;;
	aarch64 | arm64) arch=arm64 ;;
	*) die 2 "unsupported architecture $machine: want x86_64 or aarch64" ;;
	esac

	# The prefix lands in the unit's ExecStart, where whitespace, quotes,
	# backslashes, % and $ have systemd meanings.
	case $HOOKCI_PREFIX in
	/*) ;;
	*) die 1 "HOOKCI_PREFIX must be an absolute path, got $HOOKCI_PREFIX" ;;
	esac
	case $HOOKCI_PREFIX in
	*[!A-Za-z0-9/._-]*) die 1 "HOOKCI_PREFIX may only contain letters, digits and / . _ -, got $HOOKCI_PREFIX" ;;
	esac

	have curl || die 1 "need curl"
	have tar || die 1 "need tar"
	if have sha256sum; then
		sha256() { sha256sum "$1" | cut -d' ' -f1; }
	elif have shasum; then
		sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
	else
		die 1 "need sha256sum or shasum"
	fi

	tag=$HOOKCI_VERSION
	if [ "$tag" = latest ]; then
		latest=$(curl -fsSLI --proto '=https' --tlsv1.2 -o /dev/null -w '%{url_effective}' "${HOOKCI_RELEASE_BASE%/download}/latest") ||
			die 1 "cannot resolve the latest release"
		tag=${latest##*/}
		case $tag in
		v*) ;;
		*) die 1 "no published release found at ${HOOKCI_RELEASE_BASE%/download}/latest: set HOOKCI_VERSION=vX.Y.Z" ;;
		esac
	fi
	case $tag in
	v*) ;;
	*) die 1 "HOOKCI_VERSION must be latest or vX.Y.Z, got $tag" ;;
	esac
	asset="hookci_${tag#v}_linux_${arch}.tar.gz"
	url="$HOOKCI_RELEASE_BASE/$tag"

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
		cosign verify-blob --certificate-identity "$HOOKCI_COSIGN_IDENTITY" \
			--certificate-oidc-issuer "$HOOKCI_COSIGN_ISSUER" \
			--bundle "$tmp/SHA256SUMS.sigstore.json" "$tmp/SHA256SUMS" >/dev/null 2>&1 ||
			die 4 "signature verification failed for SHA256SUMS"
		echo "Signature verified"
	elif [ "$HOOKCI_ALLOW_UNSIGNED" = 1 ]; then
		echo "cosign not found and HOOKCI_ALLOW_UNSIGNED=1: checksum verified, signature not verified" >&2
	else
		# The checksum comes from the same release as the binary, so only the
		# signature shows who built it.
		die 4 "cosign not found: install cosign (https://docs.sigstore.dev/cosign/system_config/installation/) to verify the release signature, or set HOOKCI_ALLOW_UNSIGNED=1 to install with only the checksum checked"
	fi

	tar -xzf "$tmp/$asset" -C "$tmp" hookci || die 1 "$asset has no hookci binary"

	write_units
	awk -v bin="$HOOKCI_PREFIX/bin/hookci" '
	sub(/^ExecStart=\/usr\/local\/bin\/hookci /, "ExecStart=" bin " ") { n++ }
	{ print }
	END { exit n != 1 }
	' "$tmp/hookci-agent@.service" >"$tmp/agent.service" ||
		die 1 "hookci-agent@.service has no ExecStart=/usr/local/bin/hookci line"

	sudo=
	if [ "$(id -u)" != 0 ]; then
		sudo=sudo
	fi

	run $sudo install -D -m 0755 -o root -g root "$tmp/hookci" "$HOOKCI_PREFIX/bin/hookci"
	if ! id hookci-run >/dev/null 2>&1; then
		run $sudo useradd --system --no-create-home --shell /usr/sbin/nologin hookci-run
	fi
	if ! id hookci-deploy >/dev/null 2>&1; then
		run $sudo useradd --system --no-create-home --shell /usr/sbin/nologin hookci-deploy
	fi
	# Deploys run docker compose as hookci-deploy (hookci doctor check deploy.user).
	if getent group docker >/dev/null 2>&1; then
		run $sudo usermod -aG docker hookci-deploy
	fi
	run $sudo install -m 0644 -o root -g root "$tmp/hookci.slice" /etc/systemd/system/hookci.slice
	run $sudo install -m 0644 -o root -g root "$tmp/agent.service" /etc/systemd/system/hookci-agent@.service
	if [ -n "$HOOKCI_INSTALL_DRY_RUN" ]; then
		cat "$tmp/agent.service"
	fi
	run $sudo mkdir -p /var/lib/hookci
	run $sudo chmod 0700 /var/lib/hookci
	run $sudo systemctl daemon-reload

	echo
	if [ -n "$token" ]; then
		echo "Installed hookci $tag. Pairing this machine with $HUB_ORIGIN"
		run $sudo "$HOOKCI_PREFIX/bin/hookci" connect --hub "$HUB_ORIGIN" "$token" ||
			die 1 "pairing failed: get a new pair token from Slack App Home ($HUB_ORIGIN) and run: sudo hookci connect --hub $HUB_ORIGIN <pair-token>"
	else
		echo "Installed hookci $tag. Next, pair this machine with the token from Slack App Home ($HUB_ORIGIN):"
		echo "  sudo hookci connect --hub $HUB_ORIGIN <pair-token>"
	fi
}

main "$@"
