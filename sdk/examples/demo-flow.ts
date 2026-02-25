import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { Keypair } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { loadKeypairFromFile, OutcomeEscrowClient } from "../src";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";

function loadOrCreateKeypair(path: string): Keypair {
  if (existsSync(path)) {
    const bytes = Uint8Array.from(JSON.parse(readFileSync(path, "utf-8")));
    return Keypair.fromSecretKey(bytes);
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

async function main() {
  const adminPath = join(homedir(), ".config/solana/id.json");
  const admin = loadKeypairFromFile(adminPath);

  const walletDir = resolve(process.cwd(), ".app-wallets");
  mkdirSync(walletDir, { recursive: true });

  const ops = loadOrCreateKeypair(join(walletDir, "ops.json"));
  const buyer = loadOrCreateKeypair(join(walletDir, "buyer.json"));
  const operator = loadOrCreateKeypair(join(walletDir, "operator.json"));
  const treasury = loadOrCreateKeypair(join(walletDir, "treasury.json"));

  const client = OutcomeEscrowClient.fromKeypair(RPC_URL, admin);

  await client.airdrop(admin.publicKey, 2);
  await client.airdrop(ops.publicKey, 2);
  await client.airdrop(buyer.publicKey, 2);
  await client.airdrop(operator.publicKey, 2);
  await client.airdrop(treasury.publicKey, 2);

  const stableMint = await createMint(
    client.provider.connection,
    admin,
    admin.publicKey,
    null,
    6
  );

  const buyerToken = await getOrCreateAssociatedTokenAccount(
    client.provider.connection,
    admin,
    stableMint,
    buyer.publicKey
  );
  await getOrCreateAssociatedTokenAccount(
    client.provider.connection,
    admin,
    stableMint,
    operator.publicKey
  );
  await getOrCreateAssociatedTokenAccount(
    client.provider.connection,
    admin,
    stableMint,
    treasury.publicKey
  );
  await mintTo(
    client.provider.connection,
    admin,
    stableMint,
    buyerToken.address,
    admin,
    BigInt(2_000_000_000)
  );

  await client.ensureConfig(
    admin,
    ops.publicKey,
    treasury.publicKey,
    stableMint
  );

  const jobId = new anchor.BN(Math.floor(Date.now() / 1000));
  const deadlineAt = new anchor.BN(Math.floor(Date.now() / 1000) + 1800);

  const created = await client.createJob({
    buyer,
    operator: operator.publicKey,
    jobId,
    rewardLamports: new anchor.BN(1_000_000),
    feeBps: 100,
    deadlineAt,
  });
  console.log("createJob", created.signature, created.job.toBase58());

  const funded = await client.fundJob(buyer, jobId);
  console.log("fundJob", funded.signature);

  const submitted = await client.submitResult(
    buyer.publicKey,
    operator,
    jobId,
    "demo outcome payload"
  );
  console.log("submitResult", submitted.signature);

  const reviewed = await client.reviewJob(
    buyer,
    operator.publicKey,
    jobId,
    true
  );
  console.log("reviewJob", reviewed.signature);

  const job = await client.fetchJob(buyer.publicKey, jobId);
  console.log("job.status", job.status);
  console.log("job.payout", job.payout.toString());
  console.log("job.operatorReceive", job.operatorReceive.toString());
  console.log("job.feeAmount", job.feeAmount.toString());
  console.log("stableMint", stableMint.toBase58());

  const events = await client.parseEvents(reviewed.signature);
  console.log(
    "events",
    events.map((e) => ({
      name: e.name,
      data: e.data,
    }))
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
