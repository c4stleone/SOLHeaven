#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

cd "$ROOT_DIR"
mkdir -p .localnet

if [ ! -f "$HOME/.config/solana/id.json" ]; then
  mkdir -p "$HOME/.config/solana"
  solana-keygen new --no-bip39-passphrase -f -o "$HOME/.config/solana/id.json"
fi

solana config set --url localhost >/dev/null

if ! pgrep -f "solana-test-validator.*${ROOT_DIR}/.localnet/ledger" >/dev/null 2>&1; then
  echo "[localnet] starting validator..."
  nohup solana-test-validator --reset --ledger "${ROOT_DIR}/.localnet/ledger" \
    > "${ROOT_DIR}/.localnet/validator.log" 2>&1 &
  sleep 3
fi

echo "[localnet] validator running"
solana airdrop 100 >/dev/null || true

echo "[anchor] build"
anchor build

echo "[anchor] deploy"
anchor deploy

echo "[anchor] test"
anchor test --skip-local-validator

echo "[done] local deploy + test complete"
