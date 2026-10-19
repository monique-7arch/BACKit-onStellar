use soroban_sdk::{contracttype, Address};

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum OrderSide {
    Bid,
    Ask,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Order {
    pub id: u64,
    pub user: Address,
    pub call_id: u64,
    pub outcome: u32,
    pub side: OrderSide,
    pub amount: i128,
    pub price_bps: u32,
    pub filled: i128,
    pub created_at: u64,
    pub active: bool,
    /// Collateral still escrowed for an open bid (0 for asks).
    pub escrow: i128,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct OrderbookConfig {
    pub admin: Address,
    pub fee_bps: u32,
    pub protocol_fee_bps: u32,
    pub lp_fee_bps: u32,
}
