#!/usr/bin/env bash
# scripts/start.sh
# Container entrypoint. Ensures the data directory exists, runs DB migrations
# implicitly (agent/main.js calls migrate() on boot), and execs the Node
# process as PID 1 so it receives SIGTERM directly from the platform.
set -euo pipefail

echo "[start.sh] AI Browser Agent booting…"
echo "[start.sh] NODE_ENV=${NODE_ENV:-production}"
echo "[start.sh] AI_PROVIDER=${AI_PROVIDER:-stub}"

mkdir -p "${DATA_DIR:-/data}"

exec node agent/main.js
