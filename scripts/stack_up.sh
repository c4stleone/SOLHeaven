#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${ROOT_DIR}/.run"
LOCALNET_DIR="${ROOT_DIR}/.localnet"
LEDGER_DIR="${LOCALNET_DIR}/ledger"
VALIDATOR_LOG="${LOCALNET_DIR}/validator.log"
APP_LOG="${RUN_DIR}/app.log"
FRONTEND_DIR="${ROOT_DIR}/frontend"
FRONTEND_DIST_DIR="${FRONTEND_DIR}/dist"
FRONTEND_INDEX_FILE="${FRONTEND_DIST_DIR}/index.html"

VALIDATOR_PID_FILE="${RUN_DIR}/validator.pid"
APP_PID_FILE="${RUN_DIR}/app.pid"

RPC_URL="${RPC_URL:-http://127.0.0.1:8899}"
APP_URL="${APP_URL:-http://127.0.0.1:8787}"
RESET_LEDGER="${RESET_LEDGER:-1}"
SKIP_DEPLOY="${SKIP_DEPLOY:-0}"
STACK_NS="${STACK_NS:-outcome_escrow}"
VALIDATOR_SESSION="${STACK_NS}_validator"
APP_SESSION="${STACK_NS}_app"

export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

cd "$ROOT_DIR"
mkdir -p "$RUN_DIR" "$LOCALNET_DIR"

has_screen() {
  command -v screen >/dev/null 2>&1
}

has_screen_session() {
  local session_name="$1"
  screen -ls 2>/dev/null | grep -q "[[:digit:]]\\+\\.${session_name}[[:space:]]"
}

wait_for_rpc() {
  local i
  for i in $(seq 1 60); do
    if curl -sf "$RPC_URL" \
      -H "content-type: application/json" \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' >/dev/null 2>&1; then
      echo "[localnet] rpc ready: $RPC_URL"
      return 0
    fi
    sleep 1
  done
  echo "[error] validator rpc not reachable at $RPC_URL"
  return 1
}

wait_for_app() {
  local i
  for i in $(seq 1 40); do
    if curl -sf "$APP_URL/api/health" >/dev/null 2>&1; then
      echo "[app] api ready: $APP_URL/api/health"
      return 0
    fi
    sleep 1
  done
  echo "[error] app api not reachable at $APP_URL/api/health"
  return 1
}

wait_for_frontend() {
  local i
  for i in $(seq 1 40); do
    if curl -sf "$APP_URL/" >/dev/null 2>&1; then
      echo "[frontend] ready: ${APP_URL}/"
      return 0
    fi
    sleep 1
  done
  echo "[error] frontend not reachable at ${APP_URL}/"
  return 1
}

start_validator() {
  local reset_flag=""
  if [ "$RESET_LEDGER" = "1" ]; then
    reset_flag="--reset"
  fi

  if pgrep -f "solana-test-validator.*${LEDGER_DIR}" >/dev/null 2>&1; then
    echo "[localnet] validator process already running"
    return
  fi

  if has_screen; then
    if has_screen_session "$VALIDATOR_SESSION"; then
      echo "[localnet] validator screen session already running (${VALIDATOR_SESSION})"
    else
      echo "[localnet] starting validator in screen session (${VALIDATOR_SESSION})..."
      screen -dmS "$VALIDATOR_SESSION" bash -lc \
        "cd '${ROOT_DIR}' && export PATH='${PATH}' && exec solana-test-validator ${reset_flag} --ledger '${LEDGER_DIR}' >> '${VALIDATOR_LOG}' 2>&1"
    fi
  else
    if pgrep -f "solana-test-validator.*${LEDGER_DIR}" >/dev/null 2>&1; then
      echo "[localnet] validator already running"
    else
      echo "[localnet] starting validator (nohup fallback)..."
      nohup solana-test-validator ${reset_flag} --ledger "$LEDGER_DIR" \
        >> "$VALIDATOR_LOG" 2>&1 &
      echo "$!" > "$VALIDATOR_PID_FILE"
    fi
  fi
}

start_app() {
  if pgrep -f "tsx app/server.ts" >/dev/null 2>&1; then
    echo "[app] app process already running"
    return
  fi

  if has_screen; then
    if has_screen_session "$APP_SESSION"; then
      echo "[app] app screen session already running (${APP_SESSION})"
    else
      echo "[app] starting app in screen session (${APP_SESSION})..."
      screen -dmS "$APP_SESSION" bash -lc \
        "cd '${ROOT_DIR}' && exec npm run app:dev >> '${APP_LOG}' 2>&1"
    fi
  else
    if pgrep -f "tsx app/server.ts" >/dev/null 2>&1; then
      echo "[app] server already running"
    else
      echo "[app] starting server (nohup fallback)..."
      nohup npm run app:dev >> "$APP_LOG" 2>&1 &
      echo "$!" > "$APP_PID_FILE"
    fi
  fi
}

if [ ! -f "$HOME/.config/solana/id.json" ]; then
  mkdir -p "$HOME/.config/solana"
  solana-keygen new --no-bip39-passphrase -f -o "$HOME/.config/solana/id.json"
fi

solana config set --url localhost >/dev/null

start_validator
wait_for_rpc

solana airdrop 100 >/dev/null || true

if [ ! -d "${ROOT_DIR}/node_modules" ]; then
  echo "[npm] installing dependencies..."
  npm install
fi

if [ ! -f "${FRONTEND_DIR}/package.json" ]; then
  echo "[error] missing frontend package.json at ${FRONTEND_DIR}"
  exit 1
fi

echo "[frontend] installing dependencies..."
npm --prefix frontend install

echo "[frontend] build"
npm --prefix frontend run build
if [ ! -f "$FRONTEND_INDEX_FILE" ]; then
  echo "[error] frontend build output missing: ${FRONTEND_INDEX_FILE}"
  exit 1
fi

if [ "$SKIP_DEPLOY" = "1" ]; then
  echo "[anchor] SKIP_DEPLOY=1 -> skip build/deploy"
else
  echo "[anchor] build"
  anchor build
  echo "[anchor] deploy"
  anchor deploy
fi

start_app
wait_for_app
wait_for_frontend

echo "[done] stack is up"
echo "  frontend: ${APP_URL}"
echo "  buyer   : ${APP_URL}/buyer"
echo "  operator: ${APP_URL}/operator"
echo "  ops     : ${APP_URL}/ops"
echo "  backend : ${APP_URL}/api/health"
echo "  rpc     : ${RPC_URL}"
echo "  logs    : ${APP_LOG}, ${VALIDATOR_LOG}"
if has_screen; then
  echo "  screen  : ${VALIDATOR_SESSION}, ${APP_SESSION}"
fi
