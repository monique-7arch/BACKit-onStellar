use crate::rbac::Role;
use soroban_sdk::{Address, Env, Symbol};

pub fn emit_proposal_created(env: &Env, id: u64, proposer: &Address, target: &Address, function_name: &Symbol) {
    env.events().publish(
        ("governance", "ProposalCreated"),
        (id, proposer.clone(), target.clone(), function_name.clone()),
    );
}

pub fn emit_vote_cast(env: &Env, proposal_id: u64, voter: &Address, support: bool, power: i128) {
    env.events().publish(
        ("governance", "VoteCast"),
        (proposal_id, voter.clone(), support, power),
    );
}

pub fn emit_proposal_executed(env: &Env, id: u64) {
    env.events().publish(("governance", "ProposalExecuted"), (id,));
}

pub fn emit_delegation(env: &Env, delegator: &Address, delegate: &Address) {
    env.events().publish(
        ("governance", "DelegationChanged"),
        (delegator.clone(), delegate.clone()),
    );
}

pub fn emit_role_granted(env: &Env, role: Role, account: &Address, by: &Address) {
    env.events()
        .publish(("governance", "RoleGranted"), (role, account.clone(), by.clone()));
}

pub fn emit_role_revoked(env: &Env, role: Role, account: &Address, by: &Address) {
    env.events()
        .publish(("governance", "RoleRevoked"), (role, account.clone(), by.clone()));
}

pub fn emit_pause_changed(env: &Env, flags: u32, by: &Address) {
    env.events()
        .publish(("governance", "PauseChanged"), (flags, by.clone()));
}

pub fn emit_withdrawal_proposed(
    env: &Env,
    id: u64,
    token: &Address,
    amount: i128,
    recipient: &Address,
    executable_at: u64,
) {
    env.events().publish(
        ("governance", "WithdrawalProposed"),
        (id, token.clone(), amount, recipient.clone(), executable_at),
    );
}

pub fn emit_withdrawal_executed(env: &Env, id: u64) {
    env.events().publish(("governance", "WithdrawalExecuted"), (id,));
}

pub fn emit_withdrawal_cancelled(env: &Env, id: u64, by: &Address) {
    env.events()
        .publish(("governance", "WithdrawalCancelled"), (id, by.clone()));
}
