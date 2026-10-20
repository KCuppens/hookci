#!/usr/bin/env bash
# Runs the M2 deploy integration suite (agent/internal/deploy/integration)
# against examples/compose-app with real docker, compose, caddy and
# systemd-run. Needs root on a disposable Linux host. Extra arguments go to
# go test, e.g. -run TestIntegration_ZeroDowntime.
set -euo pipefail

fail() {
	echo "integration-m2: $*" >&2
	exit 1
}

[ "$(uname -s)" = Linux ] || fail "needs Linux"
[ "$(id -u)" -eq 0 ] || fail "run as root: sudo $0"
command -v go >/dev/null 2>&1 || fail "go is not in PATH"
command -v systemd-run >/dev/null 2>&1 || fail "systemd-run is not in PATH"
command -v docker >/dev/null 2>&1 || fail "docker is not installed"
docker info >/dev/null 2>&1 || fail "the docker daemon is not reachable"
compose=$(docker compose version --short 2>/dev/null) || fail "the docker compose plugin is not installed"
compose=${compose#v}
major=${compose%%.*}
rest=${compose#*.}
minor=${rest%%.*}
case "$major$minor" in
'' | *[!0-9]*) fail "cannot parse the docker compose version \"$compose\"" ;;
esac
if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 24 ]; }; then
	fail "docker compose $compose is too old: 2.24 or newer is required"
fi
command -v caddy >/dev/null 2>&1 || fail "caddy is not installed"
# Deploy builds set DOCKER_BUILDKIT=1, which needs the buildx plugin.
docker buildx version >/dev/null 2>&1 || fail "docker buildx is not installed (docker-buildx-plugin, or docker-buildx on Ubuntu)"

cd "$(dirname "$0")/../agent"
ZEROCI_INTEGRATION=1 go test -tags integration -count=1 -timeout 60m ./internal/deploy/integration/... "$@"
