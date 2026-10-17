use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum GovernanceError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    ProposalNotFound = 4,
    AlreadyVoted = 5,
    ProposalInactive = 6,
    VotingPeriodEnded = 7,
    InsufficientReputation = 8,
    AlreadyExecuted = 9,
    ProposalNotPassed = 10,
    QuorumNotMet = 11,
    AlreadyDelegated = 12,
    SelfDelegation = 13,
    /// The caller does not hold the role the function requires.
    MissingRole = 14,
    /// The operation is currently paused by the circuit breaker.
    Paused = 15,
    WithdrawalNotFound = 16,
    /// `execute_withdrawal` was called before the timelock elapsed.
    TimelockNotElapsed = 17,
    /// The withdrawal was already executed or cancelled.
    WithdrawalClosed = 18,
    InvalidAmount = 19,
    /// A role holder tried to revoke their own Admin role; use `transfer_role`.
    CannotRevokeOwnAdmin = 20,
}
