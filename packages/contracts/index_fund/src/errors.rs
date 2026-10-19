use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum IndexFundError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    InsufficientLiquidity = 4,
    InvalidAmount = 5,
    RebalanceTooFrequent = 6,
    MarketNotFound = 7,
    NavCalculationError = 8,
    ZeroSupply = 9,
    FeeTooHigh = 10,
    IndexFull = 11,
    MarketNotResolved = 12,
    TransferFailed = 13,
    DuplicateMarket = 14,
}
