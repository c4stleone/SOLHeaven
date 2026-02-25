use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("vnvjfF6x58KeioKHSszX7PW4PTu2QburPetZVjNL1od");

const CONFIG_SEED: &[u8] = b"config";
const JOB_SEED: &[u8] = b"job";
const MAX_FEE_BPS: u16 = 10_000;
const MAX_REASON_LEN: usize = 160;

#[program]
pub mod outcome_escrow_anchor {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        ops: Pubkey,
        treasury: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.ops = ops;
        config.treasury = treasury;
        config.bump = ctx.bumps.config;
        emit!(ConfigInitialized {
            admin: config.admin,
            ops,
            treasury,
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn update_ops(ctx: Context<UpdateOps>, new_ops: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let old_ops = config.ops;
        config.ops = new_ops;
        emit!(OpsUpdated {
            admin: ctx.accounts.admin.key(),
            old_ops,
            new_ops,
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn create_job(
        ctx: Context<CreateJob>,
        job_id: u64,
        operator: Pubkey,
        reward: u64,
        fee_bps: u16,
        deadline_at: i64,
    ) -> Result<()> {
        require!(reward > 0, ErrorCode::InvalidReward);
        require!(fee_bps <= MAX_FEE_BPS, ErrorCode::InvalidFeeBps);

        let now = Clock::get()?.unix_timestamp;
        if deadline_at > 0 {
            require!(deadline_at > now, ErrorCode::InvalidDeadline);
        }

        let job_key = ctx.accounts.job.key();
        let job = &mut ctx.accounts.job;
        job.job_id = job_id;
        job.buyer = ctx.accounts.buyer.key();
        job.operator = operator;
        job.reward = reward;
        job.fee_bps = fee_bps;
        job.deadline_at = deadline_at;
        job.status = JobStatus::Created as u8;
        job.submission_hash = [0; 32];
        job.submission_set = false;
        job.payout = 0;
        job.fee_amount = 0;
        job.operator_receive = 0;
        job.buyer_refund = 0;
        job.created_at = now;
        job.updated_at = now;
        job.bump = ctx.bumps.job;
        emit!(JobCreated {
            job: job_key,
            job_id,
            buyer: job.buyer,
            operator,
            reward,
            fee_bps,
            deadline_at,
            ts: now,
        });
        Ok(())
    }

    pub fn fund_job(ctx: Context<FundJob>) -> Result<()> {
        let job_ai = ctx.accounts.job.to_account_info();
        let job_key = ctx.accounts.job.key();
        let job = &mut ctx.accounts.job;
        require!(job.status == JobStatus::Created as u8, ErrorCode::InvalidStatus);

        let cpi_accounts = Transfer {
            from: ctx.accounts.buyer.to_account_info(),
            to: job_ai,
        };
        transfer(
            CpiContext::new(ctx.accounts.system_program.to_account_info(), cpi_accounts),
            job.reward,
        )?;

        job.status = JobStatus::Funded as u8;
        let ts = Clock::get()?.unix_timestamp;
        job.updated_at = ts;
        emit!(JobFunded {
            job: job_key,
            buyer: ctx.accounts.buyer.key(),
            reward: job.reward,
            ts,
        });
        Ok(())
    }

    pub fn submit_result(ctx: Context<SubmitResult>, submission_hash: [u8; 32]) -> Result<()> {
        let job = &mut ctx.accounts.job;
        require!(
            job.status == JobStatus::Funded as u8 || job.status == JobStatus::Submitted as u8,
            ErrorCode::InvalidStatus
        );

        job.submission_hash = submission_hash;
        job.submission_set = true;
        job.status = JobStatus::Submitted as u8;
        let ts = Clock::get()?.unix_timestamp;
        job.updated_at = ts;
        emit!(ResultSubmitted {
            job: ctx.accounts.job.key(),
            operator: ctx.accounts.operator.key(),
            submission_hash,
            ts,
        });
        Ok(())
    }

    pub fn review_job(ctx: Context<ReviewJob>, approve: bool) -> Result<()> {
        let job_ai = ctx.accounts.job.to_account_info();
        let buyer_ai = ctx.accounts.buyer.to_account_info();
        let operator_ai = ctx.accounts.operator.to_account_info();
        let treasury_ai = ctx.accounts.treasury.to_account_info();
        let job_key = ctx.accounts.job.key();

        let job = &mut ctx.accounts.job;
        require!(job.status == JobStatus::Submitted as u8, ErrorCode::InvalidStatus);
        require!(job.submission_set, ErrorCode::SubmissionMissing);

        if approve {
            settle_job(
                job,
                &job_ai,
                &buyer_ai,
                &operator_ai,
                &treasury_ai,
                job.reward,
                SettlementReason::BuyerApprove as u8,
            )?;
        } else {
            job.status = JobStatus::Disputed as u8;
            let ts = Clock::get()?.unix_timestamp;
            job.updated_at = ts;
            emit!(JobDisputed {
                job: job_key,
                buyer: job.buyer,
                operator: job.operator,
                by: ctx.accounts.buyer.key(),
                reason: DisputeReason::BuyerReject as u8,
                ts,
            });
        }
        Ok(())
    }

    pub fn trigger_timeout(ctx: Context<TriggerTimeout>) -> Result<()> {
        let job_key = ctx.accounts.job.key();
        let job = &mut ctx.accounts.job;
        require!(job.status == JobStatus::Submitted as u8, ErrorCode::InvalidStatus);

        let actor = ctx.accounts.actor.key();
        let is_authorized_actor = actor == job.buyer || actor == ctx.accounts.config.ops;
        require!(is_authorized_actor, ErrorCode::UnauthorizedActor);

        if job.deadline_at > 0 {
            let now = Clock::get()?.unix_timestamp;
            require!(now > job.deadline_at, ErrorCode::DeadlineNotReached);
        }

        job.status = JobStatus::Disputed as u8;
        let ts = Clock::get()?.unix_timestamp;
        job.updated_at = ts;
        emit!(JobDisputed {
            job: job_key,
            buyer: job.buyer,
            operator: job.operator,
            by: actor,
            reason: DisputeReason::Timeout as u8,
            ts,
        });
        Ok(())
    }

    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        payout: u64,
        reason: String,
    ) -> Result<()> {
        require!(reason.len() <= MAX_REASON_LEN, ErrorCode::ReasonTooLong);
        let job_ai = ctx.accounts.job.to_account_info();
        let buyer_ai = ctx.accounts.buyer.to_account_info();
        let operator_ai = ctx.accounts.operator.to_account_info();
        let treasury_ai = ctx.accounts.treasury.to_account_info();

        let job = &mut ctx.accounts.job;
        require!(job.status == JobStatus::Disputed as u8, ErrorCode::InvalidStatus);

        settle_job(
            job,
            &job_ai,
            &buyer_ai,
            &operator_ai,
            &treasury_ai,
            payout,
            SettlementReason::DisputeResolved as u8,
        )?;
        emit!(DisputeResolved {
            job: ctx.accounts.job.key(),
            ops: ctx.accounts.ops.key(),
            payout,
            reason,
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }
}

fn settle_job(
    job: &mut Account<Job>,
    job_ai: &AccountInfo,
    buyer_ai: &AccountInfo,
    operator_ai: &AccountInfo,
    treasury_ai: &AccountInfo,
    payout: u64,
    settlement_reason: u8,
) -> Result<()> {
    require!(payout <= job.reward, ErrorCode::InvalidPayout);

    let fee_amount = payout
        .checked_mul(job.fee_bps as u64)
        .ok_or(ErrorCode::MathOverflow)?
        / (MAX_FEE_BPS as u64);
    let operator_receive = payout
        .checked_sub(fee_amount)
        .ok_or(ErrorCode::MathOverflow)?;
    let buyer_refund = job
        .reward
        .checked_sub(payout)
        .ok_or(ErrorCode::MathOverflow)?;

    let total_out = operator_receive
        .checked_add(fee_amount)
        .and_then(|v| v.checked_add(buyer_refund))
        .ok_or(ErrorCode::MathOverflow)?;
    require!(total_out == job.reward, ErrorCode::MathOverflow);
    require!(job_ai.lamports() >= job.reward, ErrorCode::InsufficientVaultBalance);

    transfer_lamports(job_ai, operator_ai, operator_receive)?;
    transfer_lamports(job_ai, treasury_ai, fee_amount)?;
    transfer_lamports(job_ai, buyer_ai, buyer_refund)?;

    job.status = JobStatus::Settled as u8;
    job.payout = payout;
    job.fee_amount = fee_amount;
    job.operator_receive = operator_receive;
    job.buyer_refund = buyer_refund;
    let ts = Clock::get()?.unix_timestamp;
    job.updated_at = ts;
    emit!(JobSettled {
        job: *job_ai.key,
        buyer: job.buyer,
        operator: job.operator,
        treasury: *treasury_ai.key,
        payout,
        fee_amount,
        operator_receive,
        buyer_refund,
        reason: settlement_reason,
        ts,
    });
    Ok(())
}

fn transfer_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let from_balance = from.lamports();
    let to_balance = to.lamports();
    let from_next = from_balance
        .checked_sub(amount)
        .ok_or(ErrorCode::InsufficientVaultBalance)?;
    let to_next = to_balance.checked_add(amount).ok_or(ErrorCode::MathOverflow)?;
    **from.try_borrow_mut_lamports()? = from_next;
    **to.try_borrow_mut_lamports()? = to_next;
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Config::SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateOps<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(job_id: u64)]
pub struct CreateJob<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = buyer,
        space = 8 + Job::SPACE,
        seeds = [JOB_SEED, buyer.key().as_ref(), &job_id.to_le_bytes()],
        bump
    )]
    pub job: Account<'info, Job>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundJob<'info> {
    #[account(mut, has_one = buyer)]
    pub job: Account<'info, Job>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitResult<'info> {
    #[account(mut, has_one = operator)]
    pub job: Account<'info, Job>,
    pub operator: Signer<'info>,
}

#[derive(Accounts)]
pub struct ReviewJob<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = buyer)]
    pub job: Account<'info, Job>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: checked against job.operator
    #[account(mut, address = job.operator)]
    pub operator: UncheckedAccount<'info>,
    /// CHECK: checked against config.treasury
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct TriggerTimeout<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub job: Account<'info, Job>,
    pub actor: Signer<'info>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = ops, has_one = treasury)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = buyer, has_one = operator)]
    pub job: Account<'info, Job>,
    pub ops: Signer<'info>,
    /// CHECK: checked by has_one
    #[account(mut)]
    pub buyer: UncheckedAccount<'info>,
    /// CHECK: checked by has_one
    #[account(mut)]
    pub operator: UncheckedAccount<'info>,
    /// CHECK: checked by has_one
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
}

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub ops: Pubkey,
    pub treasury: Pubkey,
    pub bump: u8,
}

impl Config {
    pub const SPACE: usize = 32 + 32 + 32 + 1;
}

#[account]
pub struct Job {
    pub job_id: u64,
    pub buyer: Pubkey,
    pub operator: Pubkey,
    pub reward: u64,
    pub fee_bps: u16,
    pub deadline_at: i64,
    pub status: u8,
    pub submission_hash: [u8; 32],
    pub submission_set: bool,
    pub payout: u64,
    pub fee_amount: u64,
    pub operator_receive: u64,
    pub buyer_refund: u64,
    pub created_at: i64,
    pub updated_at: i64,
    pub bump: u8,
}

impl Job {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 2 + 8 + 1 + 32 + 1 + 8 + 8 + 8 + 8 + 8 + 8 + 1;
}

#[repr(u8)]
pub enum JobStatus {
    Created = 0,
    Funded = 1,
    Submitted = 2,
    Disputed = 3,
    Settled = 4,
}

#[repr(u8)]
pub enum DisputeReason {
    BuyerReject = 1,
    Timeout = 2,
}

#[repr(u8)]
pub enum SettlementReason {
    BuyerApprove = 1,
    DisputeResolved = 2,
}

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub ops: Pubkey,
    pub treasury: Pubkey,
    pub ts: i64,
}

#[event]
pub struct OpsUpdated {
    pub admin: Pubkey,
    pub old_ops: Pubkey,
    pub new_ops: Pubkey,
    pub ts: i64,
}

#[event]
pub struct JobCreated {
    pub job: Pubkey,
    pub job_id: u64,
    pub buyer: Pubkey,
    pub operator: Pubkey,
    pub reward: u64,
    pub fee_bps: u16,
    pub deadline_at: i64,
    pub ts: i64,
}

#[event]
pub struct JobFunded {
    pub job: Pubkey,
    pub buyer: Pubkey,
    pub reward: u64,
    pub ts: i64,
}

#[event]
pub struct ResultSubmitted {
    pub job: Pubkey,
    pub operator: Pubkey,
    pub submission_hash: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct JobDisputed {
    pub job: Pubkey,
    pub buyer: Pubkey,
    pub operator: Pubkey,
    pub by: Pubkey,
    pub reason: u8,
    pub ts: i64,
}

#[event]
pub struct JobSettled {
    pub job: Pubkey,
    pub buyer: Pubkey,
    pub operator: Pubkey,
    pub treasury: Pubkey,
    pub payout: u64,
    pub fee_amount: u64,
    pub operator_receive: u64,
    pub buyer_refund: u64,
    pub reason: u8,
    pub ts: i64,
}

#[event]
pub struct DisputeResolved {
    pub job: Pubkey,
    pub ops: Pubkey,
    pub payout: u64,
    pub reason: String,
    pub ts: i64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid status for this instruction.")]
    InvalidStatus,
    #[msg("Fee bps must be between 0 and 10000.")]
    InvalidFeeBps,
    #[msg("Reward must be greater than zero.")]
    InvalidReward,
    #[msg("Payout must be <= reward.")]
    InvalidPayout,
    #[msg("Math overflow.")]
    MathOverflow,
    #[msg("Insufficient vault balance.")]
    InsufficientVaultBalance,
    #[msg("Submission is missing.")]
    SubmissionMissing,
    #[msg("Deadline is not reached.")]
    DeadlineNotReached,
    #[msg("Unauthorized actor.")]
    UnauthorizedActor,
    #[msg("Deadline must be in the future or zero.")]
    InvalidDeadline,
    #[msg("Dispute reason is too long.")]
    ReasonTooLong,
}
