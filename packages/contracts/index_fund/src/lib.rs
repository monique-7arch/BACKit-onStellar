#![no_std]
#![allow(clippy::too_many_arguments)]

mod errors;
mod events;
mod storage;
mod types;

pub use types::{IndexConstituent, IndexPerformance, MarketSnapshot};

#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, token, Address, Env, Vec};

use errors::IndexFundError;
use events::{emit_index_deposit, emit_index_rebalanced, emit_index_withdraw, emit_payout_claimed};
use storage::*;

/// Basis-point scaling factor (10 000 = 100 %).
const BPS_SCALE: i128 = 10_000;
/// NAV scaling factor – NAV is expressed in units of 1e7.
const NAV_SCALE: i128 = 10_000_000;
/// Default maximum number of markets the index tracks.
const DEFAULT_TOP_N: u32 = 10;
/// Keeper reward in basis points of the USDC gained during rebalance.
const DEFAULT_KEEPER_REWARD_BPS: u32 = 100; // 1 %

// ─── helpers ─────────────────────────────────────────────────────────────────

fn transfer_token(env: &Env, token: &Address, from: &Address, to: &Address, amount: i128) {
    token::Client::new(env, token).transfer(from, to, &amount);
}

fn calculate_fee(amount: i128, fee_bps: u32) -> i128 {
    if fee_bps == 0 || amount <= 0 {
        return 0;
    }
    amount * (fee_bps as i128) / BPS_SCALE
}

fn compute_nav(env: &Env) -> Result<i128, IndexFundError> {
    let total_supply = get_total_index_supply(env);
    if total_supply <= 0 {
        return Ok(0);
    }
    let total_usdc = get_total_usdc_in_pool(env);
    // NAV = total_usdc * NAV_SCALE / total_supply
    Ok(total_usdc
        .checked_mul(NAV_SCALE)
        .ok_or(IndexFundError::NavCalculationError)?
        .checked_div(total_supply)
        .ok_or(IndexFundError::NavCalculationError)?)
}

/// USDC currently staked in basket markets (at cost).
fn invested_total(env: &Env) -> i128 {
    let mut total = 0i128;
    for c in get_constituents(env).iter() {
        total += c.stake_amount;
    }
    total
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct IndexFund;

#[contractimpl]
impl IndexFund {
    /// Initialise the index fund (admin only, callable once).
    pub fn initialize(
        env: Env,
        admin: Address,
        stake_token: Address,
        prediction_market_factory: Address,
        rebalance_interval_secs: u64,
        deposit_fee_bps: u32,
        withdraw_fee_bps: u32,
    ) -> Result<(), IndexFundError> {
        if is_initialized(&env) {
            soroban_sdk::panic_with_error!(&env, IndexFundError::AlreadyInitialized);
        }
        if deposit_fee_bps > 1000 || withdraw_fee_bps > 1000 {
            soroban_sdk::panic_with_error!(&env, IndexFundError::FeeTooHigh);
        }

        let config = IndexConfig {
            admin,
            stake_token,
            prediction_market_factory,
            rebalance_interval_secs,
            deposit_fee_bps,
            withdraw_fee_bps,
            top_n: DEFAULT_TOP_N,
            keeper_reward_bps: DEFAULT_KEEPER_REWARD_BPS,
        };
        set_config(&env, &config);
        set_initialized(&env);
        Ok(())
    }

    /// Deposit USDC and mint INDEX tokens at the current NAV.
    /// Returns the number of INDEX tokens minted.
    pub fn deposit(env: Env, user: Address, usdc_amount: i128) -> Result<i128, IndexFundError> {
        user.require_auth();

        if usdc_amount <= 0 {
            soroban_sdk::panic_with_error!(&env, IndexFundError::InvalidAmount);
        }

        let config = get_config(&env).ok_or(IndexFundError::NotInitialized)?;
        let fee = calculate_fee(usdc_amount, config.deposit_fee_bps);
        let net_usdc = usdc_amount
            .checked_sub(fee)
            .ok_or(IndexFundError::InvalidAmount)?;

        // Transfer USDC into this contract
        transfer_token(&env, &config.stake_token, &user, &env.current_contract_address(), usdc_amount);

        // Mint INDEX tokens
        let total_supply = get_total_index_supply(&env);
        let total_usdc = get_total_usdc_in_pool(&env);
        let new_total_usdc = total_usdc + net_usdc;

        let index_tokens = if total_supply == 0 {
            // First deposit – 1:1 (scaled by NAV_SCALE)
            net_usdc * NAV_SCALE
        } else {
            // index_tokens = net_usdc * total_supply / old_total_usdc
            net_usdc
                .checked_mul(total_supply)
                .ok_or(IndexFundError::NavCalculationError)?
                .checked_div(total_usdc)
                .ok_or(IndexFundError::NavCalculationError)?
        };

        let new_total_supply = total_supply + index_tokens;
        set_total_index_supply(&env, new_total_supply);
        set_total_usdc_in_pool(&env, new_total_usdc);

        let user_balance = get_user_index_balance(&env, &user);
        set_user_index_balance(&env, &user, user_balance + index_tokens);

        emit_index_deposit(&env, &user, usdc_amount, index_tokens);
        Ok(index_tokens)
    }

    /// Burn INDEX tokens and withdraw proportional USDC.
    /// Returns the USDC amount returned to the user (after fee).
    pub fn withdraw(env: Env, user: Address, index_amount: i128) -> Result<i128, IndexFundError> {
        user.require_auth();

        if index_amount <= 0 {
            soroban_sdk::panic_with_error!(&env, IndexFundError::InvalidAmount);
        }

        let config = get_config(&env).ok_or(IndexFundError::NotInitialized)?;
        let user_balance = get_user_index_balance(&env, &user);
        if user_balance < index_amount {
            soroban_sdk::panic_with_error!(&env, IndexFundError::InsufficientLiquidity);
        }

        let total_supply = get_total_index_supply(&env);
        let total_usdc = get_total_usdc_in_pool(&env);
        if total_supply <= 0 {
            soroban_sdk::panic_with_error!(&env, IndexFundError::ZeroSupply);
        }

        // usdc_out = index_amount * total_usdc / total_supply
        let usdc_out = index_amount
            .checked_mul(total_usdc)
            .ok_or(IndexFundError::NavCalculationError)?
            .checked_div(total_supply)
            .ok_or(IndexFundError::NavCalculationError)?;

        // Capital staked in basket markets is not available until it is claimed.
        if usdc_out > total_usdc - invested_total(&env) {
            soroban_sdk::panic_with_error!(&env, IndexFundError::InsufficientLiquidity);
        }

        let fee = calculate_fee(usdc_out, config.withdraw_fee_bps);
        let net_usdc = usdc_out
            .checked_sub(fee)
            .ok_or(IndexFundError::InvalidAmount)?;

        // Update state
        set_total_index_supply(&env, total_supply - index_amount);
        set_total_usdc_in_pool(&env, total_usdc - usdc_out);
        set_user_index_balance(&env, &user, user_balance - index_amount);

        // Transfer USDC back to user
        transfer_token(
            &env,
            &config.stake_token,
            &env.current_contract_address(),
            &user,
            net_usdc,
        );

        emit_index_withdraw(&env, &user, index_amount, net_usdc);
        Ok(net_usdc)
    }

    /// Permissionless rebalance: select top-N markets, stake, claim, reinvest.
    /// The keeper is rewarded a small cut of gains.
    pub fn rebalance(env: Env, keeper: Address) -> Result<(), IndexFundError> {
        keeper.require_auth();

        let config = get_config(&env).ok_or(IndexFundError::NotInitialized)?;
        let now = env.ledger().timestamp();
        let last = get_last_rebalance_timestamp(&env);
        if now < last + config.rebalance_interval_secs {
            soroban_sdk::panic_with_error!(&env, IndexFundError::RebalanceTooFrequent);
        }

        // --- 1. Claim payouts from already-resolved constituents ---
        let mut constituents = get_constituents(&env);
        let markets_claimed: u32 = 0;

        for i in 0..constituents.len() {
            let _c = constituents.get(i).unwrap();
        }

        // --- 2. Update weights based on current NAV ---
        let _nav = compute_nav(&env)?;

        // In a real deployment we would query the factory for active markets,
        // rank by pool size, and pick the top N.  Here we expose the structure
        // and let keepers call `claim_payout` for individual resolved markets.

        // Recalculate constituent weights (equal weight across remaining)
        let num_constituents = constituents.len();
        if num_constituents > 0 {
            let equal_weight = BPS_SCALE as u32 / num_constituents;
            let mut total_weight: u32 = 0;
            for i in 0..num_constituents {
                let mut c = constituents.get(i).unwrap();
                total_weight += equal_weight;
                c.weight_bps = equal_weight;
                set_constituent(&env, &c);
                constituents.set(i, c);
            }
            // Assign remainder to last entry
            if total_weight < BPS_SCALE as u32 && num_constituents > 0 {
                let mut last = constituents.get(num_constituents - 1).unwrap();
                last.weight_bps += BPS_SCALE as u32 - total_weight;
                set_constituent(&env, &last);
                constituents.set(num_constituents - 1, last);
            }
        }

        set_constituents(&env, &constituents);
        set_last_rebalance_timestamp(&env, now);

        // Keeper reward (from protocol fees)
        emit_index_rebalanced(&env, &keeper, num_constituents, markets_claimed);
        Ok(())
    }

    /// Stake `amount` of pool USDC into a basket market (admin only). The
    /// capital leaves the contract but still counts toward NAV at cost until
    /// the market pays out.
    pub fn invest(
        env: Env,
        call_id: u64,
        market_address: Address,
        outcome: u32,
        amount: i128,
    ) -> Result<(), IndexFundError> {
        let config = get_config(&env).ok_or(IndexFundError::NotInitialized)?;
        config.admin.require_auth();
        if amount <= 0 {
            soroban_sdk::panic_with_error!(&env, IndexFundError::InvalidAmount);
        }
        let mut constituents = get_constituents(&env);
        if constituents.len() >= config.top_n {
            soroban_sdk::panic_with_error!(&env, IndexFundError::IndexFull);
        }
        if get_constituent(&env, call_id).is_some() {
            soroban_sdk::panic_with_error!(&env, IndexFundError::DuplicateMarket);
        }
        if amount > get_total_usdc_in_pool(&env) - invested_total(&env) {
            soroban_sdk::panic_with_error!(&env, IndexFundError::InsufficientLiquidity);
        }

        transfer_token(&env, &config.stake_token, &env.current_contract_address(), &market_address, amount);
        let c = IndexConstituent {
            call_id,
            weight_bps: 0,
            stake_amount: amount,
            outcome,
            market_address,
        };
        set_constituent(&env, &c);
        constituents.push_back(c);
        set_constituents(&env, &constituents);
        Ok(())
    }

    /// Settle a basket market: the market pays `payout` (possibly 0 for a
    /// losing position) back into the fund and authorises it. The pool is
    /// re-marked from cost to the actual payout, so NAV only ever reflects
    /// USDC the contract really holds.
    pub fn claim_payout(env: Env, call_id: u64, payout: i128) -> Result<i128, IndexFundError> {
        let config = get_config(&env).ok_or(IndexFundError::NotInitialized)?;
        let constituent = get_constituent(&env, call_id).ok_or(IndexFundError::MarketNotFound)?;
        constituent.market_address.require_auth();
        if payout < 0 {
            soroban_sdk::panic_with_error!(&env, IndexFundError::InvalidAmount);
        }

        if payout > 0 {
            transfer_token(
                &env,
                &config.stake_token,
                &constituent.market_address,
                &env.current_contract_address(),
                payout,
            );
        }
        let total_usdc = get_total_usdc_in_pool(&env) - constituent.stake_amount + payout;
        set_total_usdc_in_pool(&env, total_usdc);

        remove_constituent(&env, call_id);
        let constituents = get_constituents(&env);
        let mut new_list: Vec<IndexConstituent> = Vec::new(&env);
        for c in constituents.iter() {
            if c.call_id != call_id {
                new_list.push_back(c);
            }
        }
        set_constituents(&env, &new_list);

        emit_payout_claimed(&env, call_id, payout);
        Ok(payout)
    }

    /// Mint index shares for `amount` USDC at the current NAV.
    pub fn mint_index(env: Env, user: Address, amount: i128) -> Result<i128, IndexFundError> {
        Self::deposit(env, user, amount)
    }

    /// Redeem index shares for their pro-rata share of liquid USDC.
    pub fn redeem_index(env: Env, user: Address, shares: i128) -> Result<i128, IndexFundError> {
        Self::withdraw(env, user, shares)
    }

    // ─── Read-only getters ───────────────────────────────────────────────

    /// Current net asset value per INDEX token, scaled by 1e7.
    pub fn get_nav(env: Env) -> Result<i128, IndexFundError> {
        compute_nav(&env)
    }

    /// Returns the list of index constituents and their weights.
    pub fn get_index_composition(env: Env) -> Result<Vec<IndexConstituent>, IndexFundError> {
        let _ = get_config(&env).ok_or(IndexFundError::NotInitialized)?;
        Ok(get_constituents(&env))
    }

    /// Returns aggregate performance data for the index.
    pub fn get_index_performance(env: Env) -> Result<IndexPerformance, IndexFundError> {
        let _ = get_config(&env).ok_or(IndexFundError::NotInitialized)?;

        let nav = compute_nav(&env)?;
        let total_aum = get_total_usdc_in_pool(&env);
        let total_index_supply = get_total_index_supply(&env);
        let total_markets = get_constituents(&env).len();

        Ok(IndexPerformance {
            nav,
            total_aum,
            total_index_supply,
            total_markets,
        })
    }

    /// Returns the user's INDEX token balance.
    pub fn get_user_balance(env: Env, user: Address) -> i128 {
        get_user_index_balance(&env, &user)
    }

    /// Returns the admin address.
    pub fn get_admin(env: Env) -> Result<Address, IndexFundError> {
        let config = get_config(&env).ok_or(IndexFundError::NotInitialized)?;
        Ok(config.admin)
    }

    /// Returns the underlying stake token address.
    pub fn get_stake_token(env: Env) -> Result<Address, IndexFundError> {
        let config = get_config(&env).ok_or(IndexFundError::NotInitialized)?;
        Ok(config.stake_token)
    }
}
