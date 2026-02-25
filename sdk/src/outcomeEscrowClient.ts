import { createHash } from "crypto";
import * as anchor from "@coral-xyz/anchor";
import {
  ConfirmOptions,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import idlJson from "../idl/outcome_escrow_anchor.json";

const CONFIG_SEED = Buffer.from("config");
const JOB_SEED = Buffer.from("job");

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
    opts: ConfirmOptions = anchor.AnchorProvider.defaultOptions()
  ): OutcomeEscrowClient {
    const connection = new Connection(rpcUrl, opts.commitment ?? "confirmed");
    const provider = new anchor.AnchorProvider(connection, walletFromKeypair(payer), opts);
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
    return PublicKey.findProgramAddressSync([CONFIG_SEED], this.program.programId)[0];
  }

  jobPda(buyer: PublicKey, jobId: number | bigint | anchor.BN): PublicKey {
    const jobIdBn = bn(jobId);
    return PublicKey.findProgramAddressSync(
      [JOB_SEED, buyer.toBuffer(), jobIdBn.toArrayLike(Buffer, "le", 8)],
      this.program.programId
    )[0];
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

  async initializeConfig(admin: Keypair, ops: PublicKey, treasury: PublicKey) {
    return this.program.methods
      .initializeConfig(ops, treasury)
      .accounts({
        config: this.configPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();
  }

  async ensureConfig(admin: Keypair, ops: PublicKey, treasury: PublicKey) {
    const exists = await this.fetchConfig();
    if (exists) {
      return null;
    }
    return this.initializeConfig(admin, ops, treasury);
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
    const job = this.jobPda(buyer.publicKey, jobId);
    const signature = await this.program.methods
      .fundJob()
      .accounts({
        job,
        buyer: buyer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();
    return { signature, job };
  }

  async buildFundJobTx(buyer: PublicKey, jobId: number | bigint | anchor.BN) {
    const job = this.jobPda(buyer, jobId);
    const tx = await this.program.methods
      .fundJob()
      .accounts({
        job,
        buyer,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    return { tx, job };
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
    if (!treasuryPk) {
      throw new Error("config is not initialized");
    }

    const job = this.jobPda(buyer.publicKey, jobId);
    const signature = await this.program.methods
      .reviewJob(approve)
      .accounts({
        config: this.configPda,
        job,
        buyer: buyer.publicKey,
        operator,
        treasury: treasuryPk,
      })
      .signers([buyer])
      .rpc();
    return { signature, job };
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
    if (!treasuryPk) {
      throw new Error("config is not initialized");
    }

    const job = this.jobPda(buyer, jobId);
    const tx = await this.program.methods
      .reviewJob(approve)
      .accounts({
        config: this.configPda,
        job,
        buyer,
        operator,
        treasury: treasuryPk,
      })
      .transaction();
    return { tx, job };
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

    const job = this.jobPda(input.buyer, input.jobId);
    const signature = await this.program.methods
      .resolveDispute(bn(input.payoutLamports), input.reason)
      .accounts({
        config: this.configPda,
        job,
        ops: input.ops.publicKey,
        buyer: input.buyer,
        operator: input.operator,
        treasury: config.treasury,
      })
      .signers([input.ops])
      .rpc();
    return { signature, job };
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
    const parser = new anchor.EventParser(this.program.programId, this.program.coder);
    return [...parser.parseLogs(logs)];
  }

  async hydrateTransaction(tx: Transaction, feePayer: PublicKey): Promise<Transaction> {
    const latest = await this.provider.connection.getLatestBlockhash("confirmed");
    tx.feePayer = feePayer;
    tx.recentBlockhash = latest.blockhash;
    return tx;
  }
}
