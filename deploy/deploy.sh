#!/usr/bin/env bash
# deploy/deploy.sh
# Linux/macOS deploy helper (Windows users: see scripts/one-shot-deploy.ps1).
# Usage: ./deploy/deploy.sh fly|render
set -euo pipefail

TARGET="${1:-fly}"

case "$TARGET" in
  fly)
    command -v flyctl >/dev/null || { echo "flyctl not found. Install: https://fly.io/docs/flyctl/install/"; exit 1; }
    flyctl deploy --config deploy/fly.toml --local-only
    ;;
  render)
    echo "Render deploys via git push (autoDeploy: true in deploy/render.yaml) or the Render dashboard."
    echo "Ensure deploy/render.yaml is committed, then: git push"
    ;;
  *)
    echo "Usage: $0 fly|render"
    exit 1
    ;;
esac

read -rp "Enter deployed base URL to smoke-test (blank to skip): " URL
if [ -n "${URL:-}" ]; then
  ./scripts/post-deploy-check.sh "$URL"
fi
