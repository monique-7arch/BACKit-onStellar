use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum OrderbookError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    InvalidAmount = 4,
    InvalidPrice = 5,
    OrderNotFound = 6,
    InsufficientBalance = 7,
    SelfTrading = 8,
    MaxMatchesReached = 9,
    TokenNotSet = 10,
    InsufficientShares = 11,
    Overflow = 12,
}
