#!/usr/bin/env bash
set -euo pipefail

echo "[docker] starting validator..."
docker compose up -d validator

echo "[docker] deploying program..."
docker compose run --rm deployer

echo "[docker] starting app..."
docker compose up -d app

echo "[docker] done"
echo "  frontend: http://127.0.0.1:8787"
echo "  backend : http://127.0.0.1:8787/api/health"
echo "  rpc     : http://127.0.0.1:8899"
