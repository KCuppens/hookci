#!/bin/sh
# Runs after the zeroci .deb or .rpm is installed or upgraded.
set -eu

if ! id zeroci-run >/dev/null 2>&1; then
	useradd --system --no-create-home --shell /usr/sbin/nologin zeroci-run
fi
mkdir -p /var/lib/zeroci
chmod 0700 /var/lib/zeroci
if [ -d /run/systemd/system ]; then
	systemctl daemon-reload
	systemctl try-restart 'zeroci-agent@*.service'
fi
