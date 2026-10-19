#![cfg(test)]

extern crate std;

use crate::{Orderbook, OrderbookClient};
use soroban_sdk::{
    testutils::Address as AddressTest,
    Address, Env,
};

#[test]
fn initialize_orderbook() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(Orderbook, ());
    let client = OrderbookClient::new(&env, &contract_id);
    client.initialize(&admin);

    let config = client.get_config_view();
    assert_eq!(config.admin, admin);
    assert_eq!(config.fee_bps, 30);
}

// ── CLOB matching ────────────────────────────────────────────────────────────

use crate::errors::OrderbookError;
use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};

struct Book<'a> {
    env: Env,
    client: OrderbookClient<'a>,
    token: Address,
}

fn book<'a>() -> Book<'a> {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(Orderbook, ());
    let client = OrderbookClient::new(&env, &id);
    client.initialize(&admin);
    let token = env.register_stellar_asset_contract_v2(admin).address();
    client.set_token(&token);
    Book { env, client, token }
}

fn funded(b: &Book, amount: i128) -> Address {
    let u = Address::generate(&b.env);
    StellarAssetClient::new(&b.env, &b.token).mint(&u, &amount);
    u
}

fn bal(b: &Book, who: &Address) -> i128 {
    TokenClient::new(&b.env, &b.token).balance(who)
}

#[test]
fn crossing_orders_fill_at_the_resting_price_and_refund_improvement() {
    let b = book();
    let seller = funded(&b, 1_000);
    let buyer = funded(&b, 1_000);
    b.client.mint_shares(&seller, &1, &1, &100);
    b.client.place_ask(&seller, &1, &1, &100, &4_000); // 0.40
    // Buyer is willing to pay 0.60 but fills at 0.40.
    b.client.place_bid(&buyer, &1, &1, &100, &6_000);

    assert_eq!(b.client.get_share_balance(&buyer, &1, &1), 100);
    assert_eq!(bal(&b, &seller), 900 + 40);
    assert_eq!(bal(&b, &buyer), 1_000 - 40);
    // Contract holds only the 100 collateral backing the minted shares.
    assert_eq!(bal(&b, &b.client.address), 100);
    let (bids, asks) = b.client.get_orderbook(&1, &1);
    assert_eq!((bids.len(), asks.len()), (0, 0));
}

#[test]
fn partial_fills_leave_the_remainder_resting() {
    let b = book();
    let seller = funded(&b, 1_000);
    let buyer = funded(&b, 1_000);
    b.client.mint_shares(&seller, &1, &1, &100);
    b.client.place_ask(&seller, &1, &1, &100, &5_000);
    b.client.place_bid(&buyer, &1, &1, &40, &5_000);

    let (bids, asks) = b.client.get_orderbook(&1, &1);
    assert_eq!(bids.len(), 0);
    assert_eq!(asks.len(), 1);
    let rest = asks.get(0).unwrap();
    assert_eq!((rest.amount, rest.filled), (100, 40));

    // A partly filled resting bid keeps the escrow for what is left.
    b.client.place_bid(&buyer, &1, &1, &100, &5_000); // takes 60, 40 remain
    let (bids, _) = b.client.get_orderbook(&1, &1);
    let r = bids.get(0).unwrap();
    assert_eq!((r.filled, r.escrow), (60, 20));
}

#[test]
fn best_price_then_earliest_order_is_matched_first() {
    let b = book();
    let s1 = funded(&b, 1_000);
    let s2 = funded(&b, 1_000);
    let s3 = funded(&b, 1_000);
    let buyer = funded(&b, 1_000);
    for s in [&s1, &s2, &s3] {
        b.client.mint_shares(s, &1, &1, &10);
    }
    let a1 = b.client.place_ask(&s1, &1, &1, &10, &6_000);
    let a2 = b.client.place_ask(&s2, &1, &1, &10, &5_000);
    let a3 = b.client.place_ask(&s3, &1, &1, &10, &5_000);
    b.client.place_bid(&buyer, &1, &1, &10, &7_000);

    let orders = |id: u64| {
        let (_, asks) = b.client.get_orderbook(&1, &1);
        asks.iter().any(|o| o.id == id)
    };
    assert!(orders(a1) && orders(a3) && !orders(a2)); // a2: best price, earliest
}

#[test]
fn cancelling_returns_escrowed_collateral_and_shares() {
    let b = book();
    let user = funded(&b, 1_000);
    let bid = b.client.place_bid(&user, &1, &1, &100, &3_000);
    assert_eq!(bal(&b, &user), 1_000 - 30);
    b.client.cancel_order(&user, &bid);
    assert_eq!(bal(&b, &user), 1_000);

    b.client.mint_shares(&user, &1, &1, &50);
    let ask = b.client.place_ask(&user, &1, &1, &50, &3_000);
    assert_eq!(b.client.get_share_balance(&user, &1, &1), 0);
    b.client.cancel_order(&user, &ask);
    assert_eq!(b.client.get_share_balance(&user, &1, &1), 50);
}

#[test]
fn asks_require_shares_and_self_trades_are_skipped() {
    let b = book();
    let user = funded(&b, 1_000);
    assert_eq!(
        b.client.try_place_ask(&user, &1, &1, &10, &5_000),
        Err(Ok(OrderbookError::InsufficientShares))
    );
    b.client.mint_shares(&user, &1, &1, &10);
    b.client.place_ask(&user, &1, &1, &10, &5_000);
    b.client.place_bid(&user, &1, &1, &10, &5_000);
    let (bids, asks) = b.client.get_orderbook(&1, &1);
    assert_eq!((bids.len(), asks.len()), (1, 1));
}
