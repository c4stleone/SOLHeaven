#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${ROOT_DIR}/.run"
LEDGER_DIR="${ROOT_DIR}/.localnet/ledger"

VALIDATOR_PID_FILE="${RUN_DIR}/validator.pid"
APP_PID_FILE="${RUN_DIR}/app.pid"

STACK_NS="${STACK_NS:-outcome_escrow}"
VALIDATOR_SESSION="${STACK_NS}_validator"
APP_SESSION="${STACK_NS}_app"

stop_pid_file() {
  local name="$1"
  local file="$2"
  if [ -f "$file" ]; then
    local pid
    pid="$(cat "$file")"
    if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
      echo "[stop] ${name} pid=${pid}"
      kill "$pid" >/dev/null 2>&1 || true
    fi
    rm -f "$file"
  fi
}

if command -v screen >/dev/null 2>&1; then
  screen -S "$APP_SESSION" -X quit >/dev/null 2>&1 || true
  screen -S "$VALIDATOR_SESSION" -X quit >/dev/null 2>&1 || true
fi

stop_pid_file "app" "$APP_PID_FILE"
stop_pid_file "validator" "$VALIDATOR_PID_FILE"

# Fallback stop by pattern.
pkill -f "tsx app/server.ts" >/dev/null 2>&1 || true
pkill -f "solana-test-validator.*${LEDGER_DIR}" >/dev/null 2>&1 || true

echo "[done] stack stopped"

