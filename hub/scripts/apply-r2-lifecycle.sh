#!/usr/bin/env bash
# Applies the 14-day log retention rule (hub/r2-lifecycle.json) to an R2 bucket.
# A human runs it once per bucket: scripts/apply-r2-lifecycle.sh <bucket>.
set -euo pipefail

if [ "$#" -ne 1 ]; then
	echo "usage: $0 <bucket>" >&2
	exit 2
fi

npx wrangler r2 bucket lifecycle add "$1" hookci-log-retention --expire-days 14 --prefix logs/
npx wrangler r2 bucket lifecycle list "$1"
