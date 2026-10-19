#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

node -e 'JSON.parse(require("fs").readFileSync(process.argv[1]))' schema/zeroci.schema.json

echo "gen-schema: stub, see M0-03"
