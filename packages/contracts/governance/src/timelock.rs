//! Timelocked treasury withdrawals (SC-033).
//!
//! A withdrawal is proposed, waits at least [`MIN_TIMELOCK_SECS`] (48 hours),
//! and only then can be executed. Any Admin can cancel it while it is pending.
use backit_shared::ttl::{self, Retention};
use soroban_sdk::{contracttype, Address, Env};

/// Minimum delay between proposing and executing a withdrawal: 48 hours.
pub const MIN_TIMELOCK_SECS: u64 = 48 * 60 * 60;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawalProposal {
    pub id: u64,
    pub token: Address,
    pub amount: i128,
    pub recipient: Address,
    pub proposer: Address,
    pub proposed_at: u64,
    pub executable_at: u64,
    pub executed: bool,
    pub cancelled: bool,
}

#[contracttype]
enum TimelockKey {
    Counter,
    Withdrawal(u64),
}

pub fn next_id(env: &Env) -> u64 {
    let id: u64 = env.storage().instance().get(&TimelockKey::Counter).unwrap_or(0) + 1;
    env.storage().instance().set(&TimelockKey::Counter, &id);
    id
}

pub fn get(env: &Env, id: u64) -> Option<WithdrawalProposal> {
    env.storage().persistent().get(&TimelockKey::Withdrawal(id))
}

pub fn set(env: &Env, proposal: &WithdrawalProposal) {
    let key = TimelockKey::Withdrawal(proposal.id);
    env.storage().persistent().set(&key, proposal);
    ttl::extend_persistent(env, &key, Retention::Config);
}
