use crate::types::{Order, OrderbookConfig};
use soroban_sdk::{contracttype, Address, Env, Vec};

#[contracttype]
pub enum DataKey {
    Config,
    OrderCounter,
    Order(u64),
    UserOrders(Address),
    OrderbookBids(u64, u32),
    OrderbookAsks(u64, u32),
    Token,
    Shares(Address, u64, u32),
}

pub fn set_config(env: &Env, config: &OrderbookConfig) {
    env.storage().instance().set(&DataKey::Config, config);
}

pub fn get_config(env: &Env) -> Option<OrderbookConfig> {
    env.storage().instance().get(&DataKey::Config)
}

pub fn next_order_id(env: &Env) -> u64 {
    let counter: u64 = env
        .storage()
        .instance()
        .get(&DataKey::OrderCounter)
        .unwrap_or(0);
    let next_id = counter + 1;
    env.storage()
        .instance()
        .set(&DataKey::OrderCounter, &next_id);
    next_id
}

pub fn set_order(env: &Env, id: u64, order: &Order) {
    env.storage().instance().set(&DataKey::Order(id), order);
}

pub fn get_order(env: &Env, id: u64) -> Option<Order> {
    env.storage().instance().get(&DataKey::Order(id))
}

pub fn add_user_order(env: &Env, user: &Address, order_id: u64) {
    let key = DataKey::UserOrders(user.clone());
    let mut list: Vec<u64> = env
        .storage()
        .instance()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));
    list.push_back(order_id);
    env.storage().instance().set(&key, &list);
}

pub fn get_user_order_ids(env: &Env, user: &Address) -> Vec<u64> {
    let key = DataKey::UserOrders(user.clone());
    env.storage()
        .instance()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn add_to_book(env: &Env, call_id: u64, outcome: u32, order_id: u64, is_bid: bool) {
    let key = if is_bid {
        DataKey::OrderbookBids(call_id, outcome)
    } else {
        DataKey::OrderbookAsks(call_id, outcome)
    };
    let mut list: Vec<u64> = env
        .storage()
        .instance()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));
    list.push_back(order_id);
    env.storage().instance().set(&key, &list);
}

pub fn get_book_ids(env: &Env, call_id: u64, outcome: u32, is_bid: bool) -> Vec<u64> {
    let key = if is_bid {
        DataKey::OrderbookBids(call_id, outcome)
    } else {
        DataKey::OrderbookAsks(call_id, outcome)
    };
    env.storage()
        .instance()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn set_token(env: &Env, token: &Address) {
    env.storage().instance().set(&DataKey::Token, token);
}

pub fn get_token(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Token)
}

pub fn get_shares(env: &Env, user: &Address, call_id: u64, outcome: u32) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::Shares(user.clone(), call_id, outcome))
        .unwrap_or(0)
}

pub fn set_shares(env: &Env, user: &Address, call_id: u64, outcome: u32, amount: i128) {
    env.storage()
        .instance()
        .set(&DataKey::Shares(user.clone(), call_id, outcome), &amount);
}
