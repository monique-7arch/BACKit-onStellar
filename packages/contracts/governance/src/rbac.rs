//! Role-based access control (SC-034).
//!
//! Roles are stored per `(role, account)` pair, so a role can have any number
//! of holders. Records are persistent and renewed on every write using the
//! project's `Config` retention class.
use backit_shared::ttl::{self, Retention};
use soroban_sdk::{contracttype, Address, Env};

use crate::errors::GovernanceError;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Role {
    Admin,
    Oracle,
    Pauser,
    FeeManager,
}

#[contracttype]
enum RoleKey {
    Member(Role, Address),
}

pub fn has_role(env: &Env, role: Role, account: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&RoleKey::Member(role, account.clone()))
        .unwrap_or(false)
}

pub fn grant(env: &Env, role: Role, account: &Address) {
    let key = RoleKey::Member(role, account.clone());
    env.storage().persistent().set(&key, &true);
    ttl::extend_persistent(env, &key, Retention::Config);
}

pub fn revoke(env: &Env, role: Role, account: &Address) {
    env.storage()
        .persistent()
        .remove(&RoleKey::Member(role, account.clone()));
}

/// Authenticate `caller` and require that it holds `role`.
pub fn require_role(env: &Env, role: Role, caller: &Address) -> Result<(), GovernanceError> {
    caller.require_auth();
    if has_role(env, role, caller) {
        Ok(())
    } else {
        Err(GovernanceError::MissingRole)
    }
}
