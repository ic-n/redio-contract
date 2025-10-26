use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked},
};

declare_id!("CFQoHeX28aKhpgsLCSGM2zpou6RkRrwRoHVToWS2B6tQ");

#[program]
pub mod redio_contract {
    use super::*;

    /// Initialize a merchant pool with escrow account
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        pool_id: String,
        commission_rate: u16,
        initial_deposit: u64,
    ) -> Result<()> {
        require!(
            pool_id.len() > 0 && pool_id.len() <= 32,
            ErrorCode::InvalidPoolId
        );
        require!(commission_rate <= 10000, ErrorCode::InvalidCommissionRate);
        require!(initial_deposit > 0, ErrorCode::InvalidAmount);

        let pool = &mut ctx.accounts.merchant_pool;
        pool.merchant = ctx.accounts.merchant.key();
        pool.pool_id = pool_id.clone();
        pool.usdc_mint = ctx.accounts.usdc_mint.key();
        pool.commission_rate = commission_rate;
        pool.total_volume = 0;
        pool.total_commissions_paid = 0;
        pool.is_active = true;
        pool.bump = ctx.bumps.merchant_pool;
        pool.escrow_bump = ctx.bumps.escrow_authority;
        pool.created_at = Clock::get()?.unix_timestamp;

        if initial_deposit > 0 {
            let decimals = ctx.accounts.usdc_mint.decimals;
            token_interface::transfer_checked(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.merchant_usdc.to_account_info(),
                        mint: ctx.accounts.usdc_mint.to_account_info(),
                        to: ctx.accounts.escrow_usdc.to_account_info(),
                        authority: ctx.accounts.merchant.to_account_info(),
                    },
                ),
                initial_deposit,
                decimals,
            )?;
        }

        emit!(PoolInitialized {
            pool: pool.key(),
            merchant: pool.merchant,
            pool_id,
            commission_rate,
            initial_deposit,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Update commission rate for a specific pool
    pub fn update_pool_commission(
        ctx: Context<UpdatePoolCommission>,
        new_commission_rate: u16,
    ) -> Result<()> {
        require!(
            new_commission_rate <= 10000,
            ErrorCode::InvalidCommissionRate
        );

        let pool = &mut ctx.accounts.merchant_pool;
        let old_rate = pool.commission_rate;
        pool.commission_rate = new_commission_rate;

        emit!(PoolCommissionUpdated {
            pool: pool.key(),
            merchant: pool.merchant,
            pool_id: pool.pool_id.clone(),
            old_rate,
            new_rate: new_commission_rate,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Deactivate a pool
    pub fn deactivate_pool(ctx: Context<DeactivatePool>) -> Result<()> {
        let pool = &mut ctx.accounts.merchant_pool;
        pool.is_active = false;

        emit!(PoolDeactivated {
            pool: pool.key(),
            merchant: pool.merchant,
            pool_id: pool.pool_id.clone(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Add an affiliate to the merchant's pool
    pub fn add_affiliate(ctx: Context<AddAffiliate>, ref_id: String) -> Result<()> {
        require!(
            ref_id.len() > 0 && ref_id.len() <= 32,
            ErrorCode::InvalidRefId
        );

        let pool = &ctx.accounts.merchant_pool;
        require!(pool.is_active, ErrorCode::PoolInactive);

        let affiliate = &mut ctx.accounts.affiliate_account;
        affiliate.pool = ctx.accounts.merchant_pool.key();
        affiliate.wallet = ctx.accounts.affiliate_wallet.key();
        affiliate.ref_id = ref_id.clone();
        affiliate.total_earned = 0;
        affiliate.sales_count = 0;
        affiliate.is_active = true;
        affiliate.bump = ctx.bumps.affiliate_account;
        affiliate.created_at = Clock::get()?.unix_timestamp;

        emit!(AffiliateAdded {
            pool: affiliate.pool,
            pool_id: pool.pool_id.clone(),
            affiliate: affiliate.key(),
            wallet: affiliate.wallet,
            ref_id,
            timestamp: affiliate.created_at,
        });

        Ok(())
    }

    /// Process a sale and pay commission to affiliate
    pub fn process_sale(ctx: Context<ProcessSale>, sale_amount: u64) -> Result<()> {
        require!(sale_amount > 0, ErrorCode::InvalidAmount);

        let pool = &mut ctx.accounts.merchant_pool;
        require!(pool.is_active, ErrorCode::PoolInactive);

        let affiliate = &mut ctx.accounts.affiliate_account;
        require!(affiliate.is_active, ErrorCode::AffiliateInactive);

        // Calculate commission with checked arithmetic
        let commission_rate_u64 = pool.commission_rate as u64;
        let commission = sale_amount
            .checked_mul(commission_rate_u64)
            .ok_or(ErrorCode::ArithmeticOverflow)?
            .checked_div(10000)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        require!(commission > 0, ErrorCode::CommissionTooSmall);

        // Check escrow balance
        ctx.accounts.escrow_usdc.reload()?;
        require!(
            ctx.accounts.escrow_usdc.amount >= commission,
            ErrorCode::InsufficientEscrowBalance
        );

        // Transfer commission to affiliate
        let decimals = ctx.accounts.usdc_mint.decimals;
        let pool_key = pool.key();
        let seeds = &[b"escrow_authority", pool_key.as_ref(), &[pool.escrow_bump]];
        let signer_seeds = &[&seeds[..]];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.escrow_usdc.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.affiliate_usdc.to_account_info(),
                    authority: ctx.accounts.escrow_authority.to_account_info(),
                },
                signer_seeds,
            ),
            commission,
            decimals,
        )?;

        // Update statistics
        affiliate.total_earned = affiliate
            .total_earned
            .checked_add(commission)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        affiliate.sales_count = affiliate
            .sales_count
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        pool.total_volume = pool
            .total_volume
            .checked_add(sale_amount)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        pool.total_commissions_paid = pool
            .total_commissions_paid
            .checked_add(commission)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        emit!(SaleProcessed {
            pool: pool.key(),
            pool_id: pool.pool_id.clone(),
            affiliate: affiliate.key(),
            affiliate_wallet: affiliate.wallet,
            sale_amount,
            commission,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Remove (deactivate) an affiliate
    pub fn remove_affiliate(ctx: Context<RemoveAffiliate>) -> Result<()> {
        let affiliate = &mut ctx.accounts.affiliate_account;
        affiliate.is_active = false;

        let pool = &ctx.accounts.merchant_pool;

        emit!(AffiliateRemoved {
            pool: pool.key(),
            pool_id: pool.pool_id.clone(),
            affiliate: affiliate.key(),
            wallet: affiliate.wallet,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Deposit additional USDC to escrow
    pub fn deposit_escrow(ctx: Context<DepositEscrow>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);

        let pool = &ctx.accounts.merchant_pool;
        require!(pool.is_active, ErrorCode::PoolInactive);

        let decimals = ctx.accounts.usdc_mint.decimals;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.merchant_usdc.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.escrow_usdc.to_account_info(),
                    authority: ctx.accounts.merchant.to_account_info(),
                },
            ),
            amount,
            decimals,
        )?;

        emit!(EscrowDeposited {
            pool: pool.key(),
            pool_id: pool.pool_id.clone(),
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Withdraw unused USDC from escrow
    pub fn withdraw_escrow(ctx: Context<WithdrawEscrow>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);

        let pool = &ctx.accounts.merchant_pool;

        ctx.accounts.escrow_usdc.reload()?;
        require!(
            ctx.accounts.escrow_usdc.amount >= amount,
            ErrorCode::InsufficientEscrowBalance
        );

        let decimals = ctx.accounts.usdc_mint.decimals;
        let pool_key = pool.key();
        let seeds = &[b"escrow_authority", pool_key.as_ref(), &[pool.escrow_bump]];
        let signer_seeds = &[&seeds[..]];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.escrow_usdc.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.merchant_usdc.to_account_info(),
                    authority: ctx.accounts.escrow_authority.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            decimals,
        )?;

        emit!(EscrowWithdrawn {
            pool: pool.key(),
            pool_id: pool.pool_id.clone(),
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct MerchantPool {
    pub merchant: Pubkey,
    #[max_len(32)]
    pub pool_id: String,
    pub usdc_mint: Pubkey,
    pub commission_rate: u16,
    pub total_volume: u64,
    pub total_commissions_paid: u64,
    pub is_active: bool,
    pub bump: u8,
    pub escrow_bump: u8,
    pub created_at: i64,
}

#[account]
#[derive(InitSpace)]
pub struct AffiliateAccount {
    pub pool: Pubkey,
    pub wallet: Pubkey,
    #[max_len(32)]
    pub ref_id: String,
    pub total_earned: u64,
    pub sales_count: u64,
    pub is_active: bool,
    pub bump: u8,
    pub created_at: i64,
}

#[derive(Accounts)]
#[instruction(pool_id: String)]
pub struct InitializePool<'info> {
    #[account(
        init,
        payer = merchant,
        space = 8 + MerchantPool::INIT_SPACE,
        seeds = [
            b"pool",
            merchant.key().as_ref(),
            pool_id.as_bytes()
        ],
        bump
    )]
    pub merchant_pool: Account<'info, MerchantPool>,

    #[account(
        seeds = [b"escrow_authority", merchant_pool.key().as_ref()],
        bump
    )]
    pub escrow_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub merchant: Signer<'info>,

    #[account(
        mut,
        constraint = merchant_usdc.owner == merchant.key(),
        constraint = merchant_usdc.mint == usdc_mint.key()
    )]
    pub merchant_usdc: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = merchant,
        associated_token::mint = usdc_mint,
        associated_token::authority = escrow_authority,
        associated_token::token_program = token_program,
    )]
    pub escrow_usdc: InterfaceAccount<'info, TokenAccount>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePoolCommission<'info> {
    #[account(
        mut,
        constraint = merchant_pool.merchant == merchant.key() @ ErrorCode::Unauthorized
    )]
    pub merchant_pool: Account<'info, MerchantPool>,

    pub merchant: Signer<'info>,
}

#[derive(Accounts)]
pub struct DeactivatePool<'info> {
    #[account(
        mut,
        constraint = merchant_pool.merchant == merchant.key() @ ErrorCode::Unauthorized
    )]
    pub merchant_pool: Account<'info, MerchantPool>,

    pub merchant: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(ref_id: String)]
pub struct AddAffiliate<'info> {
    #[account(
        constraint = merchant_pool.merchant == merchant.key() @ ErrorCode::Unauthorized
    )]
    pub merchant_pool: Account<'info, MerchantPool>,

    #[account(
        init,
        payer = merchant,
        space = 8 + AffiliateAccount::INIT_SPACE,
        seeds = [
            b"affiliate",
            merchant_pool.key().as_ref(),
            affiliate_wallet.key().as_ref()
        ],
        bump
    )]
    pub affiliate_account: Account<'info, AffiliateAccount>,

    pub affiliate_wallet: UncheckedAccount<'info>,

    #[account(mut)]
    pub merchant: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProcessSale<'info> {
    #[account(mut)]
    pub merchant_pool: Account<'info, MerchantPool>,

    #[account(
        mut,
        seeds = [
            b"affiliate",
            merchant_pool.key().as_ref(),
            affiliate_wallet.key().as_ref()
        ],
        bump = affiliate_account.bump,
        constraint = affiliate_account.pool == merchant_pool.key() @ ErrorCode::InvalidAffiliate
    )]
    pub affiliate_account: Account<'info, AffiliateAccount>,
    #[account(mut)]
    pub affiliate_wallet: UncheckedAccount<'info>,

    #[account(
        seeds = [b"escrow_authority", merchant_pool.key().as_ref()],
        bump = merchant_pool.escrow_bump
    )]
    pub escrow_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = escrow_usdc.owner == escrow_authority.key(),
        constraint = escrow_usdc.mint == usdc_mint.key()
    )]
    pub escrow_usdc: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = usdc_mint,
        associated_token::authority = affiliate_wallet,
        associated_token::token_program = token_program,
    )]
    pub affiliate_usdc: InterfaceAccount<'info, TokenAccount>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveAffiliate<'info> {
    #[account(
        constraint = merchant_pool.merchant == merchant.key() @ ErrorCode::Unauthorized
    )]
    pub merchant_pool: Account<'info, MerchantPool>,

    #[account(
        mut,
        seeds = [
            b"affiliate",
            merchant_pool.key().as_ref(),
            affiliate_wallet.key().as_ref()
        ],
        bump = affiliate_account.bump
    )]
    pub affiliate_account: Account<'info, AffiliateAccount>,
    #[account(mut)]
    pub affiliate_wallet: UncheckedAccount<'info>,

    pub merchant: Signer<'info>,
}

#[derive(Accounts)]
pub struct DepositEscrow<'info> {
    #[account(
        constraint = merchant_pool.merchant == merchant.key() @ ErrorCode::Unauthorized
    )]
    pub merchant_pool: Account<'info, MerchantPool>,

    #[account(mut)]
    pub merchant: Signer<'info>,

    #[account(
        mut,
        constraint = merchant_usdc.owner == merchant.key(),
        constraint = merchant_usdc.mint == usdc_mint.key()
    )]
    pub merchant_usdc: InterfaceAccount<'info, TokenAccount>,

    #[account(
        seeds = [b"escrow_authority", merchant_pool.key().as_ref()],
        bump = merchant_pool.escrow_bump
    )]
    pub escrow_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = escrow_usdc.owner == escrow_authority.key(),
        constraint = escrow_usdc.mint == usdc_mint.key()
    )]
    pub escrow_usdc: InterfaceAccount<'info, TokenAccount>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawEscrow<'info> {
    #[account(
        constraint = merchant_pool.merchant == merchant.key() @ ErrorCode::Unauthorized
    )]
    pub merchant_pool: Account<'info, MerchantPool>,

    #[account(mut)]
    pub merchant: Signer<'info>,

    #[account(
        mut,
        constraint = merchant_usdc.owner == merchant.key(),
        constraint = merchant_usdc.mint == usdc_mint.key()
    )]
    pub merchant_usdc: InterfaceAccount<'info, TokenAccount>,

    #[account(
        seeds = [b"escrow_authority", merchant_pool.key().as_ref()],
        bump = merchant_pool.escrow_bump
    )]
    pub escrow_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = escrow_usdc.owner == escrow_authority.key(),
        constraint = escrow_usdc.mint == usdc_mint.key()
    )]
    pub escrow_usdc: InterfaceAccount<'info, TokenAccount>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub merchant: Pubkey,
    pub pool_id: String,
    pub commission_rate: u16,
    pub initial_deposit: u64,
    pub timestamp: i64,
}

#[event]
pub struct PoolCommissionUpdated {
    pub pool: Pubkey,
    pub merchant: Pubkey,
    pub pool_id: String,
    pub old_rate: u16,
    pub new_rate: u16,
    pub timestamp: i64,
}

#[event]
pub struct PoolDeactivated {
    pub pool: Pubkey,
    pub merchant: Pubkey,
    pub pool_id: String,
    pub timestamp: i64,
}

#[event]
pub struct AffiliateAdded {
    pub pool: Pubkey,
    pub pool_id: String,
    pub affiliate: Pubkey,
    pub wallet: Pubkey,
    pub ref_id: String,
    pub timestamp: i64,
}

#[event]
pub struct SaleProcessed {
    pub pool: Pubkey,
    pub pool_id: String,
    pub affiliate: Pubkey,
    pub affiliate_wallet: Pubkey,
    pub sale_amount: u64,
    pub commission: u64,
    pub timestamp: i64,
}

#[event]
pub struct AffiliateRemoved {
    pub pool: Pubkey,
    pub pool_id: String,
    pub affiliate: Pubkey,
    pub wallet: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct EscrowDeposited {
    pub pool: Pubkey,
    pub pool_id: String,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct EscrowWithdrawn {
    pub pool: Pubkey,
    pub pool_id: String,
    pub amount: u64,
    pub timestamp: i64,
}

// Error codes
#[error_code]
pub enum ErrorCode {
    #[msg("Invalid commission rate (must be <= 10000 basis points)")]
    InvalidCommissionRate,
    #[msg("Amount must be greater than 0")]
    InvalidAmount,
    #[msg("Pool ID must be between 1-32 characters")]
    InvalidPoolId,
    #[msg("Reference ID must be between 1-32 characters")]
    InvalidRefId,
    #[msg("Pool is not active")]
    PoolInactive,
    #[msg("Affiliate is not active")]
    AffiliateInactive,
    #[msg("Arithmetic overflow occurred")]
    ArithmeticOverflow,
    #[msg("Calculated commission is too small")]
    CommissionTooSmall,
    #[msg("Insufficient balance in escrow")]
    InsufficientEscrowBalance,
    #[msg("Unauthorized: Only merchant can perform this action")]
    Unauthorized,
    #[msg("Invalid affiliate account")]
    InvalidAffiliate,
}
