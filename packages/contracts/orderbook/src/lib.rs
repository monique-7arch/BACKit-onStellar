#![no_std]

mod errors;
mod events;
mod storage;
mod types;

#[cfg(test)]
mod test;

pub use types::{Order, OrderbookConfig, OrderSide};

use errors::OrderbookError;
use events::{emit_order_cancelled, emit_order_executed, emit_order_placed};
use soroban_sdk::{contract, contractimpl, token, Address, Env, Vec};
use storage::*;

const MAX_MATCHES_PER_ORDER: u32 = 20;
const PROTOCOL_FEE_BPS: u32 = 25;
const LP_FEE_BPS: u32 = 5;

/// Collateral for `shares` at `price_bps` (10_000 bps = 1 collateral unit/share).
fn cost(shares: i128, price_bps: u32) -> Result<i128, OrderbookError> {
    shares
        .checked_mul(price_bps as i128)
        .map(|v| v / 10_000)
        .ok_or(OrderbookError::Overflow)
}

#[contract]
pub struct Orderbook;

#[contractimpl]
impl Orderbook {
    pub fn initialize(env: Env, admin: Address) -> Result<(), OrderbookError> {
        if get_config(&env).is_some() {
            return Err(OrderbookError::AlreadyInitialized);
        }
        admin.require_auth();

        let config = OrderbookConfig {
            admin,
            fee_bps: 30,
            protocol_fee_bps: PROTOCOL_FEE_BPS,
            lp_fee_bps: LP_FEE_BPS,
        };
        set_config(&env, &config);
        Ok(())
    }

    /// Set the collateral token (SAC) used for escrow (admin only).
    pub fn set_token(env: Env, token: Address) -> Result<(), OrderbookError> {
        let config = get_config(&env).ok_or(OrderbookError::NotInitialized)?;
        config.admin.require_auth();
        storage::set_token(&env, &token);
        Ok(())
    }

    /// Mint `amount` outcome shares by locking `amount` collateral 1:1.
    pub fn mint_shares(
        env: Env,
        user: Address,
        call_id: u64,
        outcome: u32,
        amount: i128,
    ) -> Result<(), OrderbookError> {
        user.require_auth();
        if amount <= 0 {
            return Err(OrderbookError::InvalidAmount);
        }
        let token = get_token(&env).ok_or(OrderbookError::TokenNotSet)?;
        token::Client::new(&env, &token).transfer(&user, &env.current_contract_address(), &amount);
        let bal = get_shares(&env, &user, call_id, outcome)
            .checked_add(amount)
            .ok_or(OrderbookError::Overflow)?;
        set_shares(&env, &user, call_id, outcome, bal);
        Ok(())
    }

    pub fn get_share_balance(env: Env, user: Address, call_id: u64, outcome: u32) -> i128 {
        get_shares(&env, &user, call_id, outcome)
    }

    /// Place a limit bid for `amount` shares at `price_bps`; the worst-case
    /// cost is escrowed up front and any price improvement is refunded.
    pub fn place_bid(
        env: Env,
        user: Address,
        call_id: u64,
        outcome: u32,
        amount: i128,
        price_bps: u32,
    ) -> Result<u64, OrderbookError> {
        Self::place(env, user, call_id, outcome, amount, price_bps, OrderSide::Bid)
    }

    /// Place a limit ask selling `share_amount` shares at `price_bps`; the
    /// shares are moved into escrow.
    pub fn place_ask(
        env: Env,
        user: Address,
        call_id: u64,
        outcome: u32,
        share_amount: i128,
        price_bps: u32,
    ) -> Result<u64, OrderbookError> {
        Self::place(env, user, call_id, outcome, share_amount, price_bps, OrderSide::Ask)
    }

    fn place(
        env: Env,
        user: Address,
        call_id: u64,
        outcome: u32,
        amount: i128,
        price_bps: u32,
        side: OrderSide,
    ) -> Result<u64, OrderbookError> {
        user.require_auth();
        if amount <= 0 {
            return Err(OrderbookError::InvalidAmount);
        }
        if price_bps == 0 || price_bps > 10000 {
            return Err(OrderbookError::InvalidPrice);
        }
        let token = get_token(&env).ok_or(OrderbookError::TokenNotSet)?;
        let is_bid = matches!(side, OrderSide::Bid);

        let mut escrow = 0i128;
        if is_bid {
            escrow = cost(amount, price_bps)?;
            token::Client::new(&env, &token).transfer(&user, &env.current_contract_address(), &escrow);
        } else {
            let bal = get_shares(&env, &user, call_id, outcome);
            if bal < amount {
                return Err(OrderbookError::InsufficientShares);
            }
            set_shares(&env, &user, call_id, outcome, bal - amount);
        }

        let order_id = next_order_id(&env);
        let order = Order {
            id: order_id,
            user: user.clone(),
            call_id,
            outcome,
            side,
            amount,
            price_bps,
            filled: 0,
            created_at: env.ledger().timestamp(),
            active: true,
            escrow,
        };
        set_order(&env, order_id, &order);
        add_user_order(&env, &user, order_id);
        add_to_book(&env, call_id, outcome, order_id, is_bid);
        emit_order_placed(&env, order_id, &user, call_id, outcome, is_bid);

        Self::match_orders(&env, order_id)?;
        Ok(order_id)
    }

    pub fn cancel_order(env: Env, user: Address, order_id: u64) -> Result<(), OrderbookError> {
        user.require_auth();

        let mut order = get_order(&env, order_id).ok_or(OrderbookError::OrderNotFound)?;
        if order.user != user {
            return Err(OrderbookError::Unauthorized);
        }
        if !order.active {
            return Err(OrderbookError::OrderNotFound);
        }

        Self::release(&env, &mut order)?;
        order.active = false;
        set_order(&env, order_id, &order);
        emit_order_cancelled(&env, order_id);

        Ok(())
    }

    /// Return whatever an order still has in escrow to its owner.
    fn release(env: &Env, order: &mut Order) -> Result<(), OrderbookError> {
        if matches!(order.side, OrderSide::Bid) {
            if order.escrow > 0 {
                let token = get_token(env).ok_or(OrderbookError::TokenNotSet)?;
                token::Client::new(env, &token).transfer(
                    &env.current_contract_address(),
                    &order.user,
                    &order.escrow,
                );
                order.escrow = 0;
            }
        } else {
            let left = order.amount - order.filled;
            if left > 0 {
                let bal = get_shares(env, &order.user, order.call_id, order.outcome)
                    .checked_add(left)
                    .ok_or(OrderbookError::Overflow)?;
                set_shares(env, &order.user, order.call_id, order.outcome, bal);
            }
        }
        Ok(())
    }

    /// Match the incoming order against the opposite side in price-time
    /// priority: best price first, earliest order first among equals. Fills
    /// execute at the resting (maker) price; collateral and shares move in
    /// the same call, so a fill is atomic.
    fn match_orders(env: &Env, taker_order_id: u64) -> Result<(), OrderbookError> {
        let mut taker = get_order(env, taker_order_id).ok_or(OrderbookError::OrderNotFound)?;
        let is_taker_bid = matches!(taker.side, OrderSide::Bid);
        let token = get_token(env).ok_or(OrderbookError::TokenNotSet)?;
        let tc = token::Client::new(env, &token);
        let me = env.current_contract_address();
        let book_ids = get_book_ids(env, taker.call_id, taker.outcome, !is_taker_bid);

        let mut matches_count: u32 = 0;
        while matches_count < MAX_MATCHES_PER_ORDER && taker.filled < taker.amount {
            // Pick the best compatible resting order (first wins ties).
            let mut best: Option<Order> = None;
            for i in 0..book_ids.len() {
                let id = book_ids.get(i).unwrap();
                let m = match get_order(env, id) {
                    Some(o) => o,
                    None => continue,
                };
                if !m.active || m.user == taker.user || m.filled >= m.amount {
                    continue;
                }
                let compatible = if is_taker_bid {
                    m.price_bps <= taker.price_bps
                } else {
                    m.price_bps >= taker.price_bps
                };
                if !compatible {
                    continue;
                }
                let better = match &best {
                    None => true,
                    Some(b) => {
                        if is_taker_bid {
                            m.price_bps < b.price_bps
                        } else {
                            m.price_bps > b.price_bps
                        }
                    }
                };
                if better {
                    best = Some(m);
                }
            }
            let mut maker = match best {
                Some(m) => m,
                None => break,
            };

            let fill = core::cmp::min(taker.amount - taker.filled, maker.amount - maker.filled);
            let exec_price = maker.price_bps;
            let pay = cost(fill, exec_price)?;

            let (buyer, seller) = if is_taker_bid {
                (&mut taker, &mut maker)
            } else {
                (&mut maker, &mut taker)
            };
            // Buyer: pays from escrow, receives shares.
            buyer.escrow -= pay;
            let bal = get_shares(env, &buyer.user, buyer.call_id, buyer.outcome)
                .checked_add(fill)
                .ok_or(OrderbookError::Overflow)?;
            set_shares(env, &buyer.user, buyer.call_id, buyer.outcome, bal);
            // Seller: shares were escrowed at placement; receives collateral.
            if pay > 0 {
                tc.transfer(&me, &seller.user, &pay);
            }
            buyer.filled += fill;
            seller.filled += fill;

            for o in [&mut *buyer, &mut *seller] {
                if o.filled >= o.amount {
                    o.active = false;
                }
            }
            // A finished bid gets back its price-improvement leftover.
            if !buyer.active {
                Self::release(env, buyer)?;
            }
            set_order(env, buyer.id, buyer);
            set_order(env, seller.id, seller);

            emit_order_executed(env, &maker.user, &taker.user, taker.call_id, taker.outcome, fill, exec_price);
            matches_count += 1;
        }

        set_order(env, taker.id, &taker);
        Ok(())
    }

    pub fn get_orderbook(
        env: Env,
        call_id: u64,
        outcome: u32,
    ) -> (Vec<Order>, Vec<Order>) {
        let bid_ids = get_book_ids(&env, call_id, outcome, true);
        let ask_ids = get_book_ids(&env, call_id, outcome, false);

        let mut bids = Vec::new(&env);
        let mut asks = Vec::new(&env);

        for i in 0..bid_ids.len() {
            if let Some(order) = get_order(&env, bid_ids.get(i).unwrap()) {
                if order.active {
                    bids.push_back(order);
                }
            }
        }

        for i in 0..ask_ids.len() {
            if let Some(order) = get_order(&env, ask_ids.get(i).unwrap()) {
                if order.active {
                    asks.push_back(order);
                }
            }
        }

        (bids, asks)
    }

    pub fn get_user_orders(env: Env, user: Address) -> Vec<Order> {
        let ids = get_user_order_ids(&env, &user);
        let mut result = Vec::new(&env);
        for i in 0..ids.len() {
            if let Some(order) = get_order(&env, ids.get(i).unwrap()) {
                result.push_back(order);
            }
        }
        result
    }

    pub fn get_config_view(env: Env) -> Result<OrderbookConfig, OrderbookError> {
        get_config(&env).ok_or(OrderbookError::NotInitialized)
    }
}
