#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_LOG="${ROOT_DIR}/.run/app.log"
VALIDATOR_LOG="${ROOT_DIR}/.localnet/validator.log"

mkdir -p "${ROOT_DIR}/.run" "${ROOT_DIR}/.localnet"
touch "$APP_LOG" "$VALIDATOR_LOG"

echo "[logs] app: $APP_LOG"
echo "[logs] validator: $VALIDATOR_LOG"
echo
tail -n 80 -f "$APP_LOG" "$VALIDATOR_LOG"

