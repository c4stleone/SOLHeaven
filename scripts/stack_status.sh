#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${ROOT_DIR}/.run"
LEDGER_DIR="${ROOT_DIR}/.localnet/ledger"

VALIDATOR_PID_FILE="${RUN_DIR}/validator.pid"
APP_PID_FILE="${RUN_DIR}/app.pid"

RPC_URL="${RPC_URL:-http://127.0.0.1:8899}"
APP_URL="${APP_URL:-http://127.0.0.1:8787}"
STACK_NS="${STACK_NS:-outcome_escrow}"
VALIDATOR_SESSION="${STACK_NS}_validator"
APP_SESSION="${STACK_NS}_app"

print_pid_status() {
  local name="$1"
  local file="$2"
  if [ -f "$file" ]; then
    local pid
    pid="$(cat "$file")"
    if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
      echo "[pid] ${name}: running (pid=${pid})"
    else
      echo "[pid] ${name}: stale pid file (${pid})"
    fi
  else
    echo "[pid] ${name}: no pid file"
  fi
}

if command -v screen >/dev/null 2>&1; then
  if screen -ls 2>/dev/null | grep -q "[[:digit:]]\\+\\.${VALIDATOR_SESSION}[[:space:]]"; then
    echo "[screen] validator session: found (${VALIDATOR_SESSION})"
  else
    echo "[screen] validator session: not found (${VALIDATOR_SESSION})"
  fi
  if screen -ls 2>/dev/null | grep -q "[[:digit:]]\\+\\.${APP_SESSION}[[:space:]]"; then
    echo "[screen] app session: found (${APP_SESSION})"
  else
    echo "[screen] app session: not found (${APP_SESSION})"
  fi
else
  echo "[screen] not installed"
fi

print_pid_status "validator" "$VALIDATOR_PID_FILE"
print_pid_status "app" "$APP_PID_FILE"

if pgrep -f "solana-test-validator.*${LEDGER_DIR}" >/dev/null 2>&1; then
  echo "[proc] validator: running"
else
  echo "[proc] validator: not running"
fi

if pgrep -f "tsx app/server.ts" >/dev/null 2>&1; then
  echo "[proc] app: running"
else
  echo "[proc] app: not running"
fi

if curl -sf "$RPC_URL" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' >/dev/null 2>&1; then
  echo "[health] rpc: ok (${RPC_URL})"
else
  echo "[health] rpc: fail (${RPC_URL})"
fi

if curl -sf "$APP_URL/api/health" >/dev/null 2>&1; then
  echo "[health] app: ok (${APP_URL}/api/health)"
else
  echo "[health] app: fail (${APP_URL}/api/health)"
fi
