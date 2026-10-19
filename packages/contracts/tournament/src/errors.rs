use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum TournamentError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    TournamentNotFound = 4,
    TournamentAlreadyFinalized = 5,
    TournamentNotFinalized = 6,
    InvalidTimeRange = 7,
    InvalidWeights = 8,
    MarketAlreadyEntered = 9,
    TournamentNotActive = 10,
    InvalidPrizePool = 11,
    InvalidTopN = 12,
    ParticipantNotFound = 13,
    BracketNotFound = 14,
    BracketAlreadyExists = 15,
    BracketLocked = 16,
    BracketAlreadySubmitted = 17,
    InvalidBracket = 18,
    RoundOutOfOrder = 19,
    NotAllRoundsResolved = 20,
    TooManyEntrants = 21,
}
