#!/usr/bin/env bash
set -euo pipefail

RPC_URL="${RPC_URL:-http://validator:8899}"
PORT="${PORT:-8787}"
ADMIN_KEYPAIR="${ADMIN_KEYPAIR:-/workspace/.docker/keys/admin.json}"

mkdir -p "$(dirname "${ADMIN_KEYPAIR}")" /workspace/.app-wallets /workspace/.run

if [ ! -f "${ADMIN_KEYPAIR}" ]; then
  ADMIN_KEYPAIR="${ADMIN_KEYPAIR}" node -e '
    const fs = require("fs");
    const path = require("path");
    const { Keypair } = require("@solana/web3.js");

    const out = process.env.ADMIN_KEYPAIR;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const kp = Keypair.generate();
    fs.writeFileSync(out, JSON.stringify(Array.from(kp.secretKey)));
    console.log(`[docker] generated admin keypair at ${out}`);
  '
fi

echo "[docker] waiting for RPC: ${RPC_URL}"
RPC_URL="${RPC_URL}" node -e '
  const rpcUrl = process.env.RPC_URL;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" });
  const headers = { "content-type": "application/json" };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  (async () => {
    for (let i = 0; i < 90; i += 1) {
      try {
        const res = await fetch(rpcUrl, { method: "POST", headers, body });
        if (res.ok) {
          process.exit(0);
        }
      } catch (_e) {}
      await sleep(1000);
    }
    console.error(`[docker] RPC not ready: ${rpcUrl}`);
    process.exit(1);
  })();
'

export RPC_URL PORT ADMIN_KEYPAIR
exec npm run app:dev
