#!/bin/sh
# Runs after the hookci .deb or .rpm is installed or upgraded.
set -eu

if ! id hookci-run >/dev/null 2>&1; then
	useradd --system --no-create-home --shell /usr/sbin/nologin hookci-run
fi
mkdir -p /var/lib/hookci
chmod 0700 /var/lib/hookci
if [ -d /run/systemd/system ]; then
	systemctl daemon-reload
	systemctl try-restart 'hookci-agent@*.service'
fi
