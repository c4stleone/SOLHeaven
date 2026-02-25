#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
BUYER_KEYPAIR_PATH="${BUYER_KEYPAIR_PATH:-.app-wallets/buyer.json}"
OPS_KEYPAIR_PATH="${OPS_KEYPAIR_PATH:-.app-wallets/ops.json}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[error] jq is required" >&2
  exit 1
fi

if [ ! -f "$BUYER_KEYPAIR_PATH" ]; then
  echo "[error] missing buyer keypair: $BUYER_KEYPAIR_PATH" >&2
  exit 1
fi

if [ ! -f "$OPS_KEYPAIR_PATH" ]; then
  echo "[error] missing ops keypair: $OPS_KEYPAIR_PATH" >&2
  exit 1
fi

PASS_COUNT=0

log() {
  echo "[verify] $*"
}

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "[pass] $*"
}

get_json() {
  local path="$1"
  curl -sS "$BASE_URL$path"
}

post_json() {
  local path="$1"
  local payload="$2"
  curl -sS -H 'content-type: application/json' -d "$payload" "$BASE_URL$path"
}

assert_ok() {
  local label="$1"
  local body="$2"
  if ! echo "$body" | jq -e '.ok == true' >/dev/null 2>&1; then
    echo "[fail] $label"
    echo "$body" | jq . || echo "$body"
    exit 1
  fi
  pass "$label"
}

sign_tx_base64() {
  local tx_base64="$1"
  local keypair_path="$2"
  node -e '
    const fs = require("fs");
    const { Transaction, Keypair } = require("@solana/web3.js");
    const txBase64 = process.argv[1];
    const keypairPath = process.argv[2];
    const tx = Transaction.from(Buffer.from(txBase64, "base64"));
    const secret = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8")));
    const kp = Keypair.fromSecretKey(secret);
    tx.partialSign(kp);
    process.stdout.write(Buffer.from(tx.serialize()).toString("base64"));
  ' "$tx_base64" "$keypair_path"
}

send_signed_tx() {
  local signed_base64="$1"
  post_json "/api/tx/send" "$(jq -cn --arg s "$signed_base64" '{signedTxBase64:$s}')"
}

calc_half() {
  local value="$1"
  node -e 'const v = BigInt(process.argv[1]); console.log((v / 2n).toString());' "$value"
}

create_spec_for_job() {
  local buyer="$1"
  local job_id="$2"
  local service_id="$3"
  local service_title="$4"
  local task_title="$5"
  local task_brief="$6"

  post_json "/api/jobs/spec" "$(jq -cn \
    --arg buyer "$buyer" \
    --arg jobId "$job_id" \
    --arg serviceId "$service_id" \
    --arg serviceTitle "$service_title" \
    --arg taskTitle "$task_title" \
    --arg taskBrief "$task_brief" \
    '{buyer:$buyer, jobId:$jobId, serviceId:$serviceId, serviceTitle:$serviceTitle, taskTitle:$taskTitle, taskBrief:$taskBrief, criteria:{minPages:2,minSourceLinks:3,minTrustedDomainRatio:70,requireTableOrChart:true,requiredFormat:"PDF",requiredQuestions:["핵심 요약","근거 출처"],extraNotes:"api smoke test"}}')"
}

log "starting API verification against $BASE_URL"

health="$(get_json /api/health)"
assert_ok "GET /api/health" "$health"

wallets="$(get_json /api/wallets)"
assert_ok "GET /api/wallets" "$wallets"
BUYER="$(echo "$wallets" | jq -r '.roles.buyer')"

config="$(get_json /api/config)"
assert_ok "GET /api/config" "$config"

bootstrap="$(post_json /api/bootstrap '{}')"
assert_ok "POST /api/bootstrap" "$bootstrap"

catalog_get="$(get_json /api/operator/catalog)"
assert_ok "GET /api/operator/catalog" "$catalog_get"

catalog_post="$(post_json /api/operator/catalog '{"id":"api-smoke-service","title":"API Smoke Service","summary":"service from api verification","category":"qa","outputFormat":"Markdown","agentPriceLamports":"1100000"}')"
assert_ok "POST /api/operator/catalog" "$catalog_post"

mcp_get="$(get_json /api/operator/mcp)"
assert_ok "GET /api/operator/mcp" "$mcp_get"

mcp_post="$(post_json /api/operator/mcp "$(jq -cn --arg name "api-smoke-mcp" --arg url "$BASE_URL" --arg path "/api/health" --arg price "1100000" '{name:$name,serverUrl:$url,healthPath:$path,priceLamports:$price}')")"
assert_ok "POST /api/operator/mcp" "$mcp_post"

mcp_test="$(post_json /api/operator/mcp/test "$(jq -cn --arg name "api-smoke-mcp" --arg url "$BASE_URL" --arg path "/api/health" --arg price "1100000" '{persist:true,name:$name,serverUrl:$url,healthPath:$path,priceLamports:$price}')")"
assert_ok "POST /api/operator/mcp/test" "$mcp_test"
if ! echo "$mcp_test" | jq -e '.test.ok == true' >/dev/null 2>&1; then
  echo "[fail] /api/operator/mcp/test returned test.ok=false"
  echo "$mcp_test" | jq .
  exit 1
fi
pass "MCP health check success"

spec_by_id="$(get_json "/api/jobs/spec/1?buyer=$BUYER")"
assert_ok "GET /api/jobs/spec/:jobId (existing/non-existing allowed)" "$spec_by_id"

requests_all="$(get_json /api/operator/requests)"
assert_ok "GET /api/operator/requests" "$requests_all"

requests_pending="$(get_json '/api/operator/requests?status=pending')"
assert_ok "GET /api/operator/requests?status=pending" "$requests_pending"

airdrop="$(post_json /api/airdrop '{"role":"buyer","sol":1}')"
assert_ok "POST /api/airdrop" "$airdrop"

token_faucet="$(post_json /api/token/faucet "$(jq -cn --arg owner "$BUYER" '{owner:$owner,amountUnits:"1000000"}')")"
assert_ok "POST /api/token/faucet" "$token_faucet"

# Custodial flow A: approve path
create_a="$(post_json /api/jobs/create '{"serviceId":"api-smoke-service","deadlineSeconds":7200}')"
assert_ok "POST /api/jobs/create (A)" "$create_a"
job_a="$(echo "$create_a" | jq -r '.jobId')"
reward_a="$(echo "$create_a" | jq -r '.job.reward')"
buyer_a="$(echo "$create_a" | jq -r '.job.buyer')"

spec_a="$(create_spec_for_job "$buyer_a" "$job_a" "api-smoke-service" "API Smoke Service" "A-job" "approve flow")"
assert_ok "POST /api/jobs/spec (A)" "$spec_a"

decision_a="$(post_json /api/operator/requests/decision "$(jq -cn --arg buyer "$buyer_a" --arg jobId "$job_a" '{buyer:$buyer,jobId:$jobId,decision:"approved",reason:"smoke approve"}')")"
assert_ok "POST /api/operator/requests/decision approve (A)" "$decision_a"

fund_a="$(post_json /api/jobs/fund "$(jq -cn --arg jobId "$job_a" '{jobId:$jobId}')")"
assert_ok "POST /api/jobs/fund (A)" "$fund_a"

submit_a="$(post_json /api/jobs/submit "$(jq -cn --arg jobId "$job_a" --arg buyer "$buyer_a" '{jobId:$jobId,buyer:$buyer,submission:"result A"}')")"
assert_ok "POST /api/jobs/submit (A)" "$submit_a"

review_a="$(post_json /api/jobs/review "$(jq -cn --arg jobId "$job_a" '{jobId:$jobId,approve:true}')")"
assert_ok "POST /api/jobs/review approve=true (A)" "$review_a"

job_get_a="$(get_json "/api/jobs/$job_a?buyer=$buyer_a")"
assert_ok "GET /api/jobs/:jobId (A)" "$job_get_a"

# Custodial flow B: dispute then ops approve
create_b="$(post_json /api/jobs/create '{"serviceId":"api-smoke-service","deadlineSeconds":7200}')"
assert_ok "POST /api/jobs/create (B)" "$create_b"
job_b="$(echo "$create_b" | jq -r '.jobId')"
buyer_b="$(echo "$create_b" | jq -r '.job.buyer')"
reward_b="$(echo "$create_b" | jq -r '.job.reward')"

spec_b="$(create_spec_for_job "$buyer_b" "$job_b" "api-smoke-service" "API Smoke Service" "B-job" "dispute then approve")"
assert_ok "POST /api/jobs/spec (B)" "$spec_b"

decision_b="$(post_json /api/operator/requests/decision "$(jq -cn --arg buyer "$buyer_b" --arg jobId "$job_b" '{buyer:$buyer,jobId:$jobId,decision:"approved",reason:"smoke approve"}')")"
assert_ok "POST /api/operator/requests/decision approve (B)" "$decision_b"

fund_b="$(post_json /api/jobs/fund "$(jq -cn --arg jobId "$job_b" '{jobId:$jobId}')")"
assert_ok "POST /api/jobs/fund (B)" "$fund_b"

submit_b="$(post_json /api/jobs/submit "$(jq -cn --arg jobId "$job_b" --arg buyer "$buyer_b" '{jobId:$jobId,buyer:$buyer,submission:"result B"}')")"
assert_ok "POST /api/jobs/submit (B)" "$submit_b"

review_b="$(post_json /api/jobs/review "$(jq -cn --arg jobId "$job_b" '{jobId:$jobId,approve:false}')")"
assert_ok "POST /api/jobs/review approve=false (B)" "$review_b"

resolve_b="$(post_json /api/jobs/resolve "$(jq -cn --arg jobId "$job_b" --arg buyer "$buyer_b" --arg payout "$reward_b" '{jobId:$jobId,buyer:$buyer,payoutLamports:$payout,reason:"ops_approve_smoke"}')")"
assert_ok "POST /api/jobs/resolve full payout (B)" "$resolve_b"

# Custodial flow C: dispute then ops reject(partial refund)
create_c="$(post_json /api/jobs/create '{"serviceId":"api-smoke-service","deadlineSeconds":7200}')"
assert_ok "POST /api/jobs/create (C)" "$create_c"
job_c="$(echo "$create_c" | jq -r '.jobId')"
buyer_c="$(echo "$create_c" | jq -r '.job.buyer')"
reward_c="$(echo "$create_c" | jq -r '.job.reward')"

spec_c="$(create_spec_for_job "$buyer_c" "$job_c" "api-smoke-service" "API Smoke Service" "C-job" "dispute then reject")"
assert_ok "POST /api/jobs/spec (C)" "$spec_c"

decision_c="$(post_json /api/operator/requests/decision "$(jq -cn --arg buyer "$buyer_c" --arg jobId "$job_c" '{buyer:$buyer,jobId:$jobId,decision:"approved",reason:"smoke approve"}')")"
assert_ok "POST /api/operator/requests/decision approve (C)" "$decision_c"

fund_c="$(post_json /api/jobs/fund "$(jq -cn --arg jobId "$job_c" '{jobId:$jobId}')")"
assert_ok "POST /api/jobs/fund (C)" "$fund_c"

submit_c="$(post_json /api/jobs/submit "$(jq -cn --arg jobId "$job_c" --arg buyer "$buyer_c" '{jobId:$jobId,buyer:$buyer,submission:"result C"}')")"
assert_ok "POST /api/jobs/submit (C)" "$submit_c"

review_c="$(post_json /api/jobs/review "$(jq -cn --arg jobId "$job_c" '{jobId:$jobId,approve:false}')")"
assert_ok "POST /api/jobs/review approve=false (C)" "$review_c"

payout_c="$(calc_half "$reward_c")"
resolve_c="$(post_json /api/jobs/resolve "$(jq -cn --arg jobId "$job_c" --arg buyer "$buyer_c" --arg payout "$payout_c" '{jobId:$jobId,buyer:$buyer,payoutLamports:$payout,reason:"ops_reject_partial_refund_smoke"}')")"
assert_ok "POST /api/jobs/resolve partial payout (C)" "$resolve_c"

# Timeout flow (custodial): create -> fund -> submit -> wait deadline -> timeout
create_t="$(post_json /api/jobs/create '{"serviceId":"api-smoke-service","deadlineSeconds":2}')"
assert_ok "POST /api/jobs/create timeout-flow" "$create_t"
job_t="$(echo "$create_t" | jq -r '.jobId')"
buyer_t="$(echo "$create_t" | jq -r '.job.buyer')"

fund_t="$(post_json /api/jobs/fund "$(jq -cn --arg jobId "$job_t" '{jobId:$jobId}')")"
assert_ok "POST /api/jobs/fund timeout-flow" "$fund_t"

submit_t="$(post_json /api/jobs/submit "$(jq -cn --arg jobId "$job_t" --arg buyer "$buyer_t" '{jobId:$jobId,buyer:$buyer,submission:"timeout result"}')")"
assert_ok "POST /api/jobs/submit timeout-flow" "$submit_t"

sleep 3
timeout_t="$(post_json /api/jobs/timeout "$(jq -cn --arg jobId "$job_t" --arg buyer "$buyer_t" '{jobId:$jobId,buyer:$buyer,actorRole:"ops"}')")"
assert_ok "POST /api/jobs/timeout" "$timeout_t"

# Tx build/sign/send flow
build_tx_create="$(post_json /api/tx/create "$(jq -cn --arg buyer "$BUYER" '{buyer:$buyer,serviceId:"api-smoke-service",deadlineSeconds:3600}')")"
assert_ok "POST /api/tx/create" "$build_tx_create"

tx_job_id="$(echo "$build_tx_create" | jq -r '.jobId')"
unsigned_create="$(echo "$build_tx_create" | jq -r '.txBase64')"
signed_create="$(sign_tx_base64 "$unsigned_create" "$BUYER_KEYPAIR_PATH")"
sent_create="$(send_signed_tx "$signed_create")"
assert_ok "POST /api/tx/send (create tx)" "$sent_create"

event_sig="$(echo "$sent_create" | jq -r '.signature')"

build_tx_fund="$(post_json /api/tx/fund "$(jq -cn --arg buyer "$BUYER" --arg jobId "$tx_job_id" '{buyer:$buyer,jobId:$jobId}')")"
assert_ok "POST /api/tx/fund" "$build_tx_fund"
unsigned_fund="$(echo "$build_tx_fund" | jq -r '.txBase64')"
signed_fund="$(sign_tx_base64 "$unsigned_fund" "$BUYER_KEYPAIR_PATH")"
sent_fund="$(send_signed_tx "$signed_fund")"
assert_ok "POST /api/tx/send (fund tx)" "$sent_fund"

submit_tx_flow="$(post_json /api/jobs/submit "$(jq -cn --arg jobId "$tx_job_id" --arg buyer "$BUYER" '{jobId:$jobId,buyer:$buyer,submission:"tx review flow result"}')")"
assert_ok "POST /api/jobs/submit (tx flow)" "$submit_tx_flow"

build_tx_review="$(post_json /api/tx/review "$(jq -cn --arg buyer "$BUYER" --arg jobId "$tx_job_id" '{buyer:$buyer,jobId:$jobId,approve:false}')")"
assert_ok "POST /api/tx/review" "$build_tx_review"
unsigned_review="$(echo "$build_tx_review" | jq -r '.txBase64')"
signed_review="$(sign_tx_base64 "$unsigned_review" "$BUYER_KEYPAIR_PATH")"
sent_review="$(send_signed_tx "$signed_review")"
assert_ok "POST /api/tx/send (review tx)" "$sent_review"

review_sig="$(echo "$sent_review" | jq -r '.signature')"
events_review="$(get_json "/api/events/$review_sig")"
assert_ok "GET /api/events/:signature" "$events_review"

# tx timeout flow using ops actor:
# tx create -> tx fund -> custodial submit -> wait deadline -> tx timeout
build_tx_timeout_create="$(post_json /api/tx/create "$(jq -cn --arg buyer "$BUYER" '{buyer:$buyer,serviceId:"api-smoke-service",deadlineSeconds:2}')")"
assert_ok "POST /api/tx/create timeout-flow" "$build_tx_timeout_create"

tx_timeout_job_id="$(echo "$build_tx_timeout_create" | jq -r '.jobId')"
unsigned_timeout_create="$(echo "$build_tx_timeout_create" | jq -r '.txBase64')"
signed_timeout_create="$(sign_tx_base64 "$unsigned_timeout_create" "$BUYER_KEYPAIR_PATH")"
sent_timeout_create="$(send_signed_tx "$signed_timeout_create")"
assert_ok "POST /api/tx/send (timeout create tx)" "$sent_timeout_create"

build_tx_timeout_fund="$(post_json /api/tx/fund "$(jq -cn --arg buyer "$BUYER" --arg jobId "$tx_timeout_job_id" '{buyer:$buyer,jobId:$jobId}')")"
assert_ok "POST /api/tx/fund timeout-flow" "$build_tx_timeout_fund"
unsigned_timeout_fund="$(echo "$build_tx_timeout_fund" | jq -r '.txBase64')"
signed_timeout_fund="$(sign_tx_base64 "$unsigned_timeout_fund" "$BUYER_KEYPAIR_PATH")"
sent_timeout_fund="$(send_signed_tx "$signed_timeout_fund")"
assert_ok "POST /api/tx/send (timeout fund tx)" "$sent_timeout_fund"

submit_timeout="$(post_json /api/jobs/submit "$(jq -cn --arg jobId "$tx_timeout_job_id" --arg buyer "$BUYER" '{jobId:$jobId,buyer:$buyer,submission:"timeout tx flow result"}')")"
assert_ok "POST /api/jobs/submit timeout-flow (tx)" "$submit_timeout"

sleep 3
build_tx_timeout="$(post_json /api/tx/timeout "$(jq -cn --arg actor "$(jq -r '.roles.ops' <<<"$wallets")" --arg buyer "$BUYER" --arg jobId "$tx_timeout_job_id" '{actor:$actor,buyer:$buyer,jobId:$jobId}')")"
assert_ok "POST /api/tx/timeout" "$build_tx_timeout"
unsigned_timeout="$(echo "$build_tx_timeout" | jq -r '.txBase64')"
signed_timeout="$(sign_tx_base64 "$unsigned_timeout" "$OPS_KEYPAIR_PATH")"
sent_timeout="$(send_signed_tx "$signed_timeout")"
assert_ok "POST /api/tx/send (timeout tx)" "$sent_timeout"

# operator decision reject path (off-chain decision endpoint)
create_r="$(post_json /api/jobs/create '{"serviceId":"api-smoke-service","deadlineSeconds":7200}')"
assert_ok "POST /api/jobs/create (reject decision test)" "$create_r"
job_r="$(echo "$create_r" | jq -r '.jobId')"
buyer_r="$(echo "$create_r" | jq -r '.job.buyer')"
spec_r="$(create_spec_for_job "$buyer_r" "$job_r" "api-smoke-service" "API Smoke Service" "R-job" "reject decision")"
assert_ok "POST /api/jobs/spec (reject decision test)" "$spec_r"

decision_r="$(post_json /api/operator/requests/decision "$(jq -cn --arg buyer "$buyer_r" --arg jobId "$job_r" '{buyer:$buyer,jobId:$jobId,decision:"rejected",reason:"smoke reject"}')")"
assert_ok "POST /api/operator/requests/decision reject" "$decision_r"

log "all checks passed ($PASS_COUNT assertions)"
