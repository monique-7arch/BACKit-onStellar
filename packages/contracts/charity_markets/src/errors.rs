use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum CharityError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    InvalidCharity = 4,
    AlreadyResolved = 5,
    CharitySplitExceedsMax = 6,
    CallNotFound = 7,
    InvalidOutcome = 8,
    InvalidStakeAmount = 9,
    InvalidCallId = 10,
    ZeroPool = 11,
    CharitySplitTooLow = 12,
    CharityNotWhitelisted = 13,
}
