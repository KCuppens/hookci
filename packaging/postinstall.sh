#!/bin/sh
# Runs after the hookci .deb or .rpm is installed or upgraded.
set -eu

if ! id hookci-run >/dev/null 2>&1; then
	useradd --system --no-create-home --shell /usr/sbin/nologin hookci-run
fi
if ! id hookci-deploy >/dev/null 2>&1; then
	useradd --system --no-create-home --shell /usr/sbin/nologin hookci-deploy
fi
# Deploys run docker compose as hookci-deploy (hookci doctor check deploy.user).
if getent group docker >/dev/null 2>&1; then
	usermod -aG docker hookci-deploy
fi
# Job users must traverse the state root to their run dirs; 0711 also fixes
# the 0700 root older packages left, which made the agent refuse every job.
mkdir -p /var/lib/hookci
chmod 0711 /var/lib/hookci
if [ -d /run/systemd/system ]; then
	systemctl daemon-reload
	systemctl try-restart 'hookci-agent@*.service'
fi
