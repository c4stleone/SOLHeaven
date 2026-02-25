const anchor = require("@coral-xyz/anchor");
const { assert } = require("chai");
const { homedir } = require("os");
const { join } = require("path");
const {
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} = require("@solana/spl-token");

if (!process.env.ANCHOR_WALLET) {
  process.env.ANCHOR_WALLET = join(homedir(), ".config/solana/id.json");
}

describe("outcome-escrow-anchor", () => {
  const provider = anchor.AnchorProvider.local();
  anchor.setProvider(provider);

  const program =
    anchor.workspace.OutcomeEscrowAnchor ??
    anchor.workspace.outcomeEscrowAnchor;
  const connection = provider.connection;

  const admin = provider.wallet.payer;
  const ops = admin;
  const treasury = anchor.web3.Keypair.generate();
  const buyer = anchor.web3.Keypair.generate();
  const operator = anchor.web3.Keypair.generate();
  const attacker = anchor.web3.Keypair.generate();

  let configPda;
  let stableMint;
  let buyerToken;
  let operatorToken;
  let treasuryToken;

  async function airdrop(pubkey, lamports = 5 * anchor.web3.LAMPORTS_PER_SOL) {
    const sig = await connection.requestAirdrop(pubkey, lamports);
    await connection.confirmTransaction(sig, "confirmed");
  }

  function jobPda(buyerPubkey, jobIdBn) {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("job"),
        buyerPubkey.toBuffer(),
        jobIdBn.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];
  }

  function jobVaultAta(job) {
    return getAssociatedTokenAddressSync(stableMint, job, true);
  }

  async function tokenAmount(tokenAddress) {
    const account = await getAccount(connection, tokenAddress);
    return account.amount;
  }

  async function createFundedSubmittedJob(jobId, deadlineOffsetSeconds = 3600) {
    const deadline = new anchor.BN(
      Math.floor(Date.now() / 1000) + deadlineOffsetSeconds
    );
    const reward = new anchor.BN(1_000_000);
    const feeBps = 100;
    const job = jobPda(buyer.publicKey, jobId);
    const jobVault = jobVaultAta(job);

    await program.methods
      .createJob(jobId, operator.publicKey, reward, feeBps, deadline)
      .accounts({
        config: configPda,
        job,
        buyer: buyer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      stableMint,
      job,
      true
    );

    await program.methods
      .fundJob()
      .accounts({
        config: configPda,
        job,
        buyer: buyer.publicKey,
        buyerToken: buyerToken.address,
        jobVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    await program.methods
      .submitResult(Array.from(Buffer.alloc(32, 7)))
      .accounts({
        job,
        operator: operator.publicKey,
      })
      .signers([operator])
      .rpc();

    return { job, reward, feeBps, jobVault };
  }

  async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function expectFail(promise, label) {
    let failed = false;
    try {
      await promise;
    } catch (_e) {
      failed = true;
    }
    assert.isTrue(failed, label || "expected transaction to fail");
  }

  before(async () => {
    [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    await airdrop(treasury.publicKey);
    await airdrop(buyer.publicKey);
    await airdrop(operator.publicKey);
    await airdrop(attacker.publicKey);

    stableMint = await createMint(connection, admin, admin.publicKey, null, 6);
    buyerToken = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      stableMint,
      buyer.publicKey
    );
    operatorToken = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      stableMint,
      operator.publicKey
    );
    treasuryToken = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      stableMint,
      treasury.publicKey
    );
    await mintTo(
      connection,
      admin,
      stableMint,
      buyerToken.address,
      admin,
      BigInt(10_000_000_000)
    );

    const configInfo = await connection.getAccountInfo(configPda);
    if (!configInfo) {
      await program.methods
        .initializeConfig(ops.publicKey, treasury.publicKey)
        .accounts({
          config: configPda,
          admin: admin.publicKey,
          stableMint,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    }
  });

  it("approves and settles full payout", async () => {
    const jobId = new anchor.BN(1);
    const { job, jobVault } = await createFundedSubmittedJob(jobId);

    const operatorBefore = await tokenAmount(operatorToken.address);
    const treasuryBefore = await tokenAmount(treasuryToken.address);

    await program.methods
      .reviewJob(true)
      .accounts({
        config: configPda,
        job,
        buyer: buyer.publicKey,
        operator: operator.publicKey,
        jobVault,
        buyerToken: buyerToken.address,
        operatorToken: operatorToken.address,
        treasuryToken: treasuryToken.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    const account = await program.account.job.fetch(job);
    assert.strictEqual(account.status, 4); // Settled
    assert.strictEqual(account.payout.toNumber(), 1_000_000);
    assert.strictEqual(account.feeAmount.toNumber(), 10_000);
    assert.strictEqual(account.operatorReceive.toNumber(), 990_000);
    assert.strictEqual(account.buyerRefund.toNumber(), 0);

    const operatorAfter = await tokenAmount(operatorToken.address);
    const treasuryAfter = await tokenAmount(treasuryToken.address);
    assert.strictEqual(operatorAfter - operatorBefore, BigInt(990_000));
    assert.strictEqual(treasuryAfter - treasuryBefore, BigInt(10_000));
  });

  it("opens dispute and resolves partial payout", async () => {
    const jobId = new anchor.BN(2);
    const { job, jobVault } = await createFundedSubmittedJob(jobId);

    await program.methods
      .reviewJob(false)
      .accounts({
        config: configPda,
        job,
        buyer: buyer.publicKey,
        operator: operator.publicKey,
        jobVault,
        buyerToken: buyerToken.address,
        operatorToken: operatorToken.address,
        treasuryToken: treasuryToken.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    const disputed = await program.account.job.fetch(job);
    assert.strictEqual(disputed.status, 3); // Disputed

    await program.methods
      .resolveDispute(new anchor.BN(600_000), "manual_partial")
      .accounts({
        config: configPda,
        job,
        ops: ops.publicKey,
        buyer: buyer.publicKey,
        operator: operator.publicKey,
        jobVault,
        buyerToken: buyerToken.address,
        operatorToken: operatorToken.address,
        treasuryToken: treasuryToken.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const settled = await program.account.job.fetch(job);
    assert.strictEqual(settled.status, 4); // Settled
    assert.strictEqual(settled.payout.toNumber(), 600_000);
    assert.strictEqual(settled.feeAmount.toNumber(), 6_000);
    assert.strictEqual(settled.operatorReceive.toNumber(), 594_000);
    assert.strictEqual(settled.buyerRefund.toNumber(), 400_000);
  });

  it("enforces role checks", async () => {
    const jobId = new anchor.BN(3);
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
    const reward = new anchor.BN(100_000);
    const job = jobPda(buyer.publicKey, jobId);
    const jobVault = jobVaultAta(job);

    await program.methods
      .createJob(jobId, operator.publicKey, reward, 100, deadline)
      .accounts({
        config: configPda,
        job,
        buyer: buyer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      stableMint,
      job,
      true
    );

    await expectFail(
      program.methods
        .fundJob()
        .accounts({
          config: configPda,
          job,
          buyer: operator.publicKey,
          buyerToken: operatorToken.address,
          jobVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([operator])
        .rpc(),
      "operator should not fund"
    );

    await program.methods
      .fundJob()
      .accounts({
        config: configPda,
        job,
        buyer: buyer.publicKey,
        buyerToken: buyerToken.address,
        jobVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    await program.methods
      .submitResult(Array.from(Buffer.alloc(32, 9)))
      .accounts({
        job,
        operator: operator.publicKey,
      })
      .signers([operator])
      .rpc();

    await program.methods
      .reviewJob(false)
      .accounts({
        config: configPda,
        job,
        buyer: buyer.publicKey,
        operator: operator.publicKey,
        jobVault,
        buyerToken: buyerToken.address,
        operatorToken: operatorToken.address,
        treasuryToken: treasuryToken.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    await expectFail(
      program.methods
        .resolveDispute(new anchor.BN(0), "unauthorized")
        .accounts({
          config: configPda,
          job,
          ops: buyer.publicKey,
          buyer: buyer.publicKey,
          operator: operator.publicKey,
          jobVault,
          buyerToken: buyerToken.address,
          operatorToken: operatorToken.address,
          treasuryToken: treasuryToken.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([buyer])
        .rpc(),
      "non-ops should not resolve dispute"
    );
  });

  it("handles timeout disputes and reason length guard", async () => {
    const jobId = new anchor.BN(4);
    const { job, jobVault } = await createFundedSubmittedJob(jobId, 1);

    await expectFail(
      program.methods
        .triggerTimeout()
        .accounts({
          config: configPda,
          job,
          actor: attacker.publicKey,
        })
        .signers([attacker])
        .rpc(),
      "unauthorized actor should not trigger timeout"
    );

    await sleep(2200);

    await program.methods
      .triggerTimeout()
      .accounts({
        config: configPda,
        job,
        actor: buyer.publicKey,
      })
      .signers([buyer])
      .rpc();

    const disputed = await program.account.job.fetch(job);
    assert.strictEqual(disputed.status, 3); // Disputed

    const longReason = "x".repeat(300);
    await expectFail(
      program.methods
        .resolveDispute(new anchor.BN(0), longReason)
        .accounts({
          config: configPda,
          job,
          ops: ops.publicKey,
          buyer: buyer.publicKey,
          operator: operator.publicKey,
          jobVault,
          buyerToken: buyerToken.address,
          operatorToken: operatorToken.address,
          treasuryToken: treasuryToken.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc(),
      "oversized reason should fail"
    );

    await program.methods
      .resolveDispute(new anchor.BN(0), "timeout_refund")
      .accounts({
        config: configPda,
        job,
        ops: ops.publicKey,
        buyer: buyer.publicKey,
        operator: operator.publicKey,
        jobVault,
        buyerToken: buyerToken.address,
        operatorToken: operatorToken.address,
        treasuryToken: treasuryToken.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const settled = await program.account.job.fetch(job);
    assert.strictEqual(settled.status, 4); // Settled
    assert.strictEqual(settled.payout.toNumber(), 0);
    assert.strictEqual(settled.buyerRefund.toNumber(), 1_000_000);
  });
});
