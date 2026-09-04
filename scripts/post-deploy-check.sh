#!/usr/bin/env bash
# scripts/post-deploy-check.sh
# Post-deploy smoke test: hits /healthz and /api/tasks on the deployed URL and
# fails (non-zero exit) if either doesn't respond as expected.
#
# Usage:
#   ./scripts/post-deploy-check.sh https://your-app.fly.dev
set -euo pipefail

URL="${1:-}"
if [ -z "$URL" ]; then
  echo "Usage: $0 <base-url>"
  exit 1
fi

echo "[post-deploy-check] checking $URL/healthz"
HEALTH=$(curl -fsS "$URL/healthz")
echo "  -> $HEALTH"
echo "$HEALTH" | grep -q '"ok":true' || { echo "healthz did not report ok:true"; exit 1; }

echo "[post-deploy-check] checking $URL/api/tasks (may require basic auth)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$URL/api/tasks")
if [ "$CODE" != "200" ] && [ "$CODE" != "401" ]; then
  echo "unexpected status code from /api/tasks: $CODE"
  exit 1
fi

echo "[post-deploy-check] OK — service is responding."
