//! Granular circuit breaker (SC-035).
//!
//! A bitmask in instance storage selects which operations are paused. The
//! `Pauser` role sets it; operations call [`when_not_paused`] with their flag.
//! User withdrawals are deliberately never gated.
use soroban_sdk::{contracttype, Env};

use crate::errors::GovernanceError;

pub const PAUSE_CREATION: u32 = 1;
pub const PAUSE_STAKING: u32 = 2;
pub const PAUSE_SETTLEMENT: u32 = 4;
pub const PAUSE_ALL: u32 = PAUSE_CREATION | PAUSE_STAKING | PAUSE_SETTLEMENT;

#[contracttype]
enum PauseKey {
    Flags,
}

pub fn flags(env: &Env) -> u32 {
    env.storage().instance().get(&PauseKey::Flags).unwrap_or(0)
}

pub fn set_flags(env: &Env, flags: u32) {
    env.storage().instance().set(&PauseKey::Flags, &flags);
}

/// Fails with [`GovernanceError::Paused`] if `flag` (or everything) is paused.
pub fn when_not_paused(env: &Env, flag: u32) -> Result<(), GovernanceError> {
    if flags(env) & flag != 0 {
        Err(GovernanceError::Paused)
    } else {
        Ok(())
    }
}
