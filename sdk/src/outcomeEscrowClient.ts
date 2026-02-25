import { createHash } from "crypto";
import * as anchor from "@coral-xyz/anchor";
import {
  ConfirmOptions,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import idlJson from "../idl/outcome_escrow_anchor.json";

const CONFIG_SEED = Buffer.from("config");
const JOB_SEED = Buffer.from("job");
const DEFAULT_CONFIRM_OPTIONS: ConfirmOptions = {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
};

export const JOB_STATUS = {
  CREATED: 0,
  FUNDED: 1,
  SUBMITTED: 2,
  DISPUTED: 3,
  SETTLED: 4,
} as const;

export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

export type CreateJobInput = {
  buyer: Keypair;
  operator: PublicKey;
  jobId: number | bigint | anchor.BN;
  rewardLamports: number | bigint | anchor.BN;
  feeBps: number;
  deadlineAt: number | bigint | anchor.BN;
};

export type ResolveDisputeInput = {
  ops: Keypair;
  buyer: PublicKey;
  operator: PublicKey;
  jobId: number | bigint | anchor.BN;
  payoutLamports: number | bigint | anchor.BN;
  reason: string;
};

export type BuildCreateJobTxInput = {
  buyer: PublicKey;
  operator: PublicKey;
  jobId: number | bigint | anchor.BN;
  rewardLamports: number | bigint | anchor.BN;
  feeBps: number;
  deadlineAt: number | bigint | anchor.BN;
};

export type WalletMap = {
  admin: Keypair;
  ops: Keypair;
  buyer: Keypair;
  operator: Keypair;
  treasury: Keypair;
};

function bn(v: number | bigint | anchor.BN): anchor.BN {
  if (anchor.BN.isBN(v)) {
    return v;
  }
  return new anchor.BN(v.toString());
}

function toHashBytes(input: string): number[] {
  return Array.from(createHash("sha256").update(input).digest());
}

function walletFromKeypair(keypair: Keypair): anchor.Wallet {
  return {
    payer: keypair,
    publicKey: keypair.publicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(
      tx: T
    ): Promise<T> => {
      if (tx instanceof Transaction) {
        tx.partialSign(keypair);
      } else {
        tx.sign([keypair]);
      }
      return tx;
    },
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(
      txs: T[]
    ): Promise<T[]> => {
      txs.forEach((tx) => {
        if (tx instanceof Transaction) {
          tx.partialSign(keypair);
        } else {
          tx.sign([keypair]);
        }
      });
      return txs;
    },
  };
}

export class OutcomeEscrowClient {
  readonly provider: anchor.AnchorProvider;
  readonly program: anchor.Program;

  constructor(provider: anchor.AnchorProvider, program: anchor.Program) {
    this.provider = provider;
    this.program = program;
  }

  static fromKeypair(
    rpcUrl: string,
    payer: Keypair,
    opts: ConfirmOptions = DEFAULT_CONFIRM_OPTIONS
  ): OutcomeEscrowClient {
    const connection = new Connection(rpcUrl, opts.commitment ?? "confirmed");
    const provider = new anchor.AnchorProvider(
      connection,
      walletFromKeypair(payer),
      opts
    );
    const program = new anchor.Program(idlJson as anchor.Idl, provider);
    return new OutcomeEscrowClient(provider, program);
  }

  get programId(): PublicKey {
    return this.program.programId;
  }

  private get accounts(): any {
    return this.program.account as any;
  }

  get configPda(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [CONFIG_SEED],
      this.program.programId
    )[0];
  }

  jobPda(buyer: PublicKey, jobId: number | bigint | anchor.BN): PublicKey {
    const jobIdBn = bn(jobId);
    return PublicKey.findProgramAddressSync(
      [JOB_SEED, buyer.toBuffer(), jobIdBn.toArrayLike(Buffer, "le", 8)],
      this.program.programId
    )[0];
  }

  associatedTokenAddress(
    mint: PublicKey,
    owner: PublicKey,
    allowOwnerOffCurve = false
  ): PublicKey {
    return getAssociatedTokenAddressSync(
      mint,
      owner,
      allowOwnerOffCurve,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
  }

  private stableMintFromConfig(config: any): PublicKey {
    if (!config?.stableMint) {
      throw new Error("config.stableMint is missing");
    }
    return config.stableMint as PublicKey;
  }

  async airdrop(pubkey: PublicKey, sol = 2): Promise<string> {
    const sig = await this.provider.connection.requestAirdrop(
      pubkey,
      sol * anchor.web3.LAMPORTS_PER_SOL
    );
    await this.provider.connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  async fetchConfig() {
    return this.accounts.config.fetchNullable(this.configPda);
  }

  async fetchJob(buyer: PublicKey, jobId: number | bigint | anchor.BN) {
    return this.accounts.job.fetch(this.jobPda(buyer, jobId));
  }

  async initializeConfig(
    admin: Keypair,
    ops: PublicKey,
    treasury: PublicKey,
    stableMint: PublicKey
  ) {
    return this.program.methods
      .initializeConfig(ops, treasury)
      .accounts({
        config: this.configPda,
        admin: admin.publicKey,
        stableMint,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();
  }

  async ensureConfig(
    admin: Keypair,
    ops: PublicKey,
    treasury: PublicKey,
    stableMint: PublicKey
  ) {
    const exists = await this.fetchConfig();
    if (exists) {
      return null;
    }
    return this.initializeConfig(admin, ops, treasury, stableMint);
  }

  async updateOps(admin: Keypair, newOps: PublicKey) {
    return this.program.methods
      .updateOps(newOps)
      .accounts({
        config: this.configPda,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();
  }

  async createJob(input: CreateJobInput) {
    const job = this.jobPda(input.buyer.publicKey, input.jobId);
    const signature = await this.program.methods
      .createJob(
        bn(input.jobId),
        input.operator,
        bn(input.rewardLamports),
        input.feeBps,
        bn(input.deadlineAt)
      )
      .accounts({
        config: this.configPda,
        job,
        buyer: input.buyer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([input.buyer])
      .rpc();

    return { signature, job };
  }

  async buildCreateJobTx(input: BuildCreateJobTxInput) {
    const job = this.jobPda(input.buyer, input.jobId);
    const tx = await this.program.methods
      .createJob(
        bn(input.jobId),
        input.operator,
        bn(input.rewardLamports),
        input.feeBps,
        bn(input.deadlineAt)
      )
      .accounts({
        config: this.configPda,
        job,
        buyer: input.buyer,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    return { tx, job };
  }

  async fundJob(buyer: Keypair, jobId: number | bigint | anchor.BN) {
    const config = await this.fetchConfig();
    if (!config) {
      throw new Error("config is not initialized");
    }
    const stableMint = this.stableMintFromConfig(config);
    const job = this.jobPda(buyer.publicKey, jobId);
    const buyerToken = this.associatedTokenAddress(stableMint, buyer.publicKey);
    const jobVault = this.associatedTokenAddress(stableMint, job, true);
    const fundIx = await this.program.methods
      .fundJob()
      .accounts({
        config: this.configPda,
        job,
        buyer: buyer.publicKey,
        buyerToken,
        jobVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        buyer.publicKey,
        buyerToken,
        buyer.publicKey,
        stableMint
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        buyer.publicKey,
        jobVault,
        job,
        stableMint
      ),
      fundIx
    );
    await this.hydrateTransaction(tx, buyer.publicKey);

    const signature = await sendAndConfirmTransaction(
      this.provider.connection,
      tx,
      [buyer],
      {
        commitment: "confirmed",
        preflightCommitment: "confirmed",
        skipPreflight: false,
      }
    );
    return { signature, job, buyerToken, jobVault, stableMint };
  }

  async buildFundJobTx(buyer: PublicKey, jobId: number | bigint | anchor.BN) {
    const config = await this.fetchConfig();
    if (!config) {
      throw new Error("config is not initialized");
    }
    const stableMint = this.stableMintFromConfig(config);
    const job = this.jobPda(buyer, jobId);
    const buyerToken = this.associatedTokenAddress(stableMint, buyer);
    const jobVault = this.associatedTokenAddress(stableMint, job, true);
    const fundIx = await this.program.methods
      .fundJob()
      .accounts({
        config: this.configPda,
        job,
        buyer,
        buyerToken,
        jobVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        buyer,
        buyerToken,
        buyer,
        stableMint
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        buyer,
        jobVault,
        job,
        stableMint
      ),
      fundIx
    );
    return { tx, job, buyerToken, jobVault, stableMint };
  }

  async submitResult(
    buyer: PublicKey,
    operator: Keypair,
    jobId: number | bigint | anchor.BN,
    submission: string
  ) {
    const job = this.jobPda(buyer, jobId);
    const signature = await this.program.methods
      .submitResult(toHashBytes(submission))
      .accounts({
        job,
        operator: operator.publicKey,
      })
      .signers([operator])
      .rpc();
    return { signature, job };
  }

  async reviewJob(
    buyer: Keypair,
    operator: PublicKey,
    jobId: number | bigint | anchor.BN,
    approve: boolean,
    treasury?: PublicKey
  ) {
    const config = await this.fetchConfig();
    const treasuryPk = treasury ?? config?.treasury;
    if (!config || !treasuryPk) {
      throw new Error("config is not initialized");
    }
    const stableMint = this.stableMintFromConfig(config);

    const job = this.jobPda(buyer.publicKey, jobId);
    const buyerToken = this.associatedTokenAddress(stableMint, buyer.publicKey);
    const operatorToken = this.associatedTokenAddress(stableMint, operator);
    const treasuryToken = this.associatedTokenAddress(stableMint, treasuryPk);
    const jobVault = this.associatedTokenAddress(stableMint, job, true);
    const reviewIx = await this.program.methods
      .reviewJob(approve)
      .accounts({
        config: this.configPda,
        job,
        buyer: buyer.publicKey,
        operator,
        jobVault,
        buyerToken,
        operatorToken,
        treasuryToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        buyer.publicKey,
        buyerToken,
        buyer.publicKey,
        stableMint
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        buyer.publicKey,
        operatorToken,
        operator,
        stableMint
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        buyer.publicKey,
        treasuryToken,
        treasuryPk,
        stableMint
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        buyer.publicKey,
        jobVault,
        job,
        stableMint
      ),
      reviewIx
    );
    await this.hydrateTransaction(tx, buyer.publicKey);

    const signature = await sendAndConfirmTransaction(
      this.provider.connection,
      tx,
      [buyer],
      {
        commitment: "confirmed",
        preflightCommitment: "confirmed",
        skipPreflight: false,
      }
    );
    return {
      signature,
      job,
      buyerToken,
      operatorToken,
      treasuryToken,
      jobVault,
      stableMint,
    };
  }

  async buildReviewJobTx(
    buyer: PublicKey,
    operator: PublicKey,
    jobId: number | bigint | anchor.BN,
    approve: boolean,
    treasury?: PublicKey
  ) {
    const config = await this.fetchConfig();
    const treasuryPk = treasury ?? config?.treasury;
    if (!config || !treasuryPk) {
      throw new Error("config is not initialized");
    }
    const stableMint = this.stableMintFromConfig(config);

    const job = this.jobPda(buyer, jobId);
    const buyerToken = this.associatedTokenAddress(stableMint, buyer);
    const operatorToken = this.associatedTokenAddress(stableMint, operator);
    const treasuryToken = this.associatedTokenAddress(stableMint, treasuryPk);
    const jobVault = this.associatedTokenAddress(stableMint, job, true);
    const reviewIx = await this.program.methods
      .reviewJob(approve)
      .accounts({
        config: this.configPda,
        job,
        buyer,
        operator,
        jobVault,
        buyerToken,
        operatorToken,
        treasuryToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        buyer,
        buyerToken,
        buyer,
        stableMint
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        buyer,
        operatorToken,
        operator,
        stableMint
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        buyer,
        treasuryToken,
        treasuryPk,
        stableMint
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        buyer,
        jobVault,
        job,
        stableMint
      ),
      reviewIx
    );
    return {
      tx,
      job,
      buyerToken,
      operatorToken,
      treasuryToken,
      jobVault,
      stableMint,
    };
  }

  async triggerTimeout(
    actor: Keypair,
    buyer: PublicKey,
    jobId: number | bigint | anchor.BN
  ) {
    const job = this.jobPda(buyer, jobId);
    const signature = await this.program.methods
      .triggerTimeout()
      .accounts({
        config: this.configPda,
        job,
        actor: actor.publicKey,
      })
      .signers([actor])
      .rpc();
    return { signature, job };
  }

  async buildTriggerTimeoutTx(
    actor: PublicKey,
    buyer: PublicKey,
    jobId: number | bigint | anchor.BN
  ) {
    const job = this.jobPda(buyer, jobId);
    const tx = await this.program.methods
      .triggerTimeout()
      .accounts({
        config: this.configPda,
        job,
        actor,
      })
      .transaction();
    return { tx, job };
  }

  async resolveDispute(input: ResolveDisputeInput) {
    const config = await this.fetchConfig();
    if (!config) {
      throw new Error("config is not initialized");
    }
    const stableMint = this.stableMintFromConfig(config);

    const job = this.jobPda(input.buyer, input.jobId);
    const buyerToken = this.associatedTokenAddress(stableMint, input.buyer);
    const operatorToken = this.associatedTokenAddress(
      stableMint,
      input.operator
    );
    const treasuryToken = this.associatedTokenAddress(
      stableMint,
      config.treasury
    );
    const jobVault = this.associatedTokenAddress(stableMint, job, true);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        input.ops.publicKey,
        buyerToken,
        input.buyer,
        stableMint
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        input.ops.publicKey,
        operatorToken,
        input.operator,
        stableMint
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        input.ops.publicKey,
        treasuryToken,
        config.treasury,
        stableMint
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        input.ops.publicKey,
        jobVault,
        job,
        stableMint
      ),
      await this.program.methods
        .resolveDispute(bn(input.payoutLamports), input.reason)
        .accounts({
          config: this.configPda,
          job,
          ops: input.ops.publicKey,
          buyer: input.buyer,
          operator: input.operator,
          jobVault,
          buyerToken,
          operatorToken,
          treasuryToken,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction()
    );
    await this.hydrateTransaction(tx, input.ops.publicKey);

    const signature = await sendAndConfirmTransaction(
      this.provider.connection,
      tx,
      [input.ops],
      {
        commitment: "confirmed",
        preflightCommitment: "confirmed",
        skipPreflight: false,
      }
    );

    return {
      signature,
      job,
      buyerToken,
      operatorToken,
      treasuryToken,
      jobVault,
      stableMint,
    };
  }

  async parseEvents(signature: string) {
    let tx = null;
    for (let i = 0; i < 20; i += 1) {
      tx = await this.provider.connection.getTransaction(signature, {
        commitment: i < 10 ? "confirmed" : "finalized",
        maxSupportedTransactionVersion: 0,
      });
      if (tx?.meta?.logMessages?.length) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    const logs = tx?.meta?.logMessages ?? [];
    const parser = new anchor.EventParser(
      this.program.programId,
      this.program.coder
    );
    return [...parser.parseLogs(logs)];
  }

  async hydrateTransaction(
    tx: Transaction,
    feePayer: PublicKey
  ): Promise<Transaction> {
    const latest = await this.provider.connection.getLatestBlockhash(
      "confirmed"
    );
    tx.feePayer = feePayer;
    tx.recentBlockhash = latest.blockhash;
    return tx;
  }
}
