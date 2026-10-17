#![cfg(test)]

extern crate std;

use crate::{Governance, GovernanceClient};
use soroban_sdk::{
    testutils::Address as _,
    Address, Env, Symbol,
};

#[test]
fn test_initialize() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    let contract_id = env.register(Governance, ());
    let client = GovernanceClient::new(&env, &contract_id);
    client.initialize(&admin, &10, &5000, &1000, &1000, &5000);

    let result = client.try_initialize(&admin, &10, &5000, &1000, &1000, &5000);
    assert!(result.is_err());
}

#[test]
fn test_propose_and_vote() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let proposer = Address::generate(&env);
    let voter = Address::generate(&env);
    let target = Address::generate(&env);

    let contract_id = env.register(Governance, ());
    let client = GovernanceClient::new(&env, &contract_id);
    client.initialize(&admin, &1, &1000, &1000, &1000, &5000);

    client.set_reputation(&admin, &proposer, &5, &1_000_000_000);
    client.set_reputation(&admin, &voter, &3, &500_000_000);

    let pid = client.propose_change(&proposer, &target, &Symbol::new(&env, "set_param"));
    assert_eq!(pid, 1);

    client.vote(&voter, &pid, &true);

    let proposal = client.get_proposal_view(&1);
    assert!(proposal.for_votes > 0);
}

// ── SC-033 / SC-034 / SC-035 ──────────────────────────────────────────────

use crate::errors::GovernanceError;
use crate::pause::{PAUSE_ALL, PAUSE_CREATION, PAUSE_SETTLEMENT};
use crate::rbac::Role;
use crate::timelock::MIN_TIMELOCK_SECS;
use soroban_sdk::testutils::Ledger;

fn setup() -> (Env, GovernanceClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(Governance, ());
    let client = GovernanceClient::new(&env, &contract_id);
    client.initialize(&admin, &1, &1000, &1000, &1000, &5000);
    (env, client, admin)
}

#[test]
fn initialize_makes_the_admin_an_admin_role_holder() {
    let (_env, client, admin) = setup();
    assert!(client.has_role(&Role::Admin, &admin));
}

#[test]
fn admin_can_grant_and_revoke_roles_for_multiple_holders() {
    let (env, client, admin) = setup();
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    client.grant_role(&admin, &Role::Pauser, &a);
    client.grant_role(&admin, &Role::Pauser, &b);
    assert!(client.has_role(&Role::Pauser, &a));
    assert!(client.has_role(&Role::Pauser, &b));

    client.revoke_role(&admin, &Role::Pauser, &a);
    assert!(!client.has_role(&Role::Pauser, &a));
    assert!(client.has_role(&Role::Pauser, &b));
}

#[test]
fn non_admin_cannot_grant_or_revoke_roles() {
    let (env, client, admin) = setup();
    let stranger = Address::generate(&env);
    let target = Address::generate(&env);

    assert_eq!(
        client.try_grant_role(&stranger, &Role::Oracle, &target),
        Err(Ok(GovernanceError::MissingRole))
    );
    client.grant_role(&admin, &Role::Oracle, &target);
    assert_eq!(
        client.try_revoke_role(&stranger, &Role::Oracle, &target),
        Err(Ok(GovernanceError::MissingRole))
    );
    assert!(client.has_role(&Role::Oracle, &target));
}

#[test]
fn a_role_does_not_imply_other_roles() {
    let (env, client, admin) = setup();
    let fee_manager = Address::generate(&env);
    client.grant_role(&admin, &Role::FeeManager, &fee_manager);

    assert_eq!(
        client.try_grant_role(&fee_manager, &Role::FeeManager, &fee_manager),
        Err(Ok(GovernanceError::MissingRole))
    );
    assert_eq!(
        client.try_set_paused(&fee_manager, &PAUSE_ALL),
        Err(Ok(GovernanceError::MissingRole))
    );
}

#[test]
fn role_transfer_moves_the_role() {
    let (env, client, admin) = setup();
    let successor = Address::generate(&env);

    client.transfer_role(&admin, &Role::Admin, &successor);

    assert!(client.has_role(&Role::Admin, &successor));
    assert!(!client.has_role(&Role::Admin, &admin));
    // The old admin has lost its powers.
    assert_eq!(
        client.try_grant_role(&admin, &Role::Oracle, &admin),
        Err(Ok(GovernanceError::MissingRole))
    );
}

#[test]
fn admin_cannot_revoke_their_own_admin_role() {
    let (_env, client, admin) = setup();
    assert_eq!(
        client.try_revoke_role(&admin, &Role::Admin, &admin),
        Err(Ok(GovernanceError::CannotRevokeOwnAdmin))
    );
    assert!(client.has_role(&Role::Admin, &admin));
}

#[test]
fn pauser_pauses_selected_operations_and_unpauses() {
    let (env, client, admin) = setup();
    let pauser = Address::generate(&env);
    let proposer = Address::generate(&env);
    let target = Address::generate(&env);
    client.grant_role(&admin, &Role::Pauser, &pauser);
    client.set_reputation(&admin, &proposer, &5, &1_000_000_000);

    client.set_paused(&pauser, &PAUSE_CREATION);
    assert_eq!(client.paused_flags(), PAUSE_CREATION);
    assert_eq!(
        client.try_propose_change(&proposer, &target, &Symbol::new(&env, "set_param")),
        Err(Ok(GovernanceError::Paused))
    );

    client.set_paused(&pauser, &0);
    assert_eq!(client.paused_flags(), 0);
    client.propose_change(&proposer, &target, &Symbol::new(&env, "set_param"));
}

#[test]
fn pausing_settlement_blocks_execution_but_not_creation() {
    let (env, client, admin) = setup();
    let proposer = Address::generate(&env);
    let target = Address::generate(&env);
    client.set_reputation(&admin, &proposer, &5, &1_000_000_000);
    client.grant_role(&admin, &Role::Pauser, &admin);

    client.set_paused(&admin, &PAUSE_SETTLEMENT);

    let pid = client.propose_change(&proposer, &target, &Symbol::new(&env, "set_param"));
    assert_eq!(
        client.try_execute_proposal(&admin, &pid),
        Err(Ok(GovernanceError::Paused))
    );
}

#[test]
fn only_pausers_can_change_the_pause_flags() {
    let (env, client, admin) = setup();
    let stranger = Address::generate(&env);
    assert_eq!(
        client.try_set_paused(&stranger, &PAUSE_ALL),
        Err(Ok(GovernanceError::MissingRole))
    );
    // Not even an Admin, without the Pauser role.
    assert_eq!(
        client.try_set_paused(&admin, &PAUSE_ALL),
        Err(Ok(GovernanceError::MissingRole))
    );
    assert_eq!(client.paused_flags(), 0);
}

fn funded_treasury(env: &Env, client: &GovernanceClient<'static>, amount: i128) -> Address {
    let issuer = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let token = sac.address();
    soroban_sdk::token::StellarAssetClient::new(env, &token).mint(&client.address, &amount);
    token
}

#[test]
fn withdrawal_cannot_execute_before_the_timelock() {
    let (env, client, admin) = setup();
    env.ledger().set_timestamp(1_000);
    let token = funded_treasury(&env, &client, 1_000);
    let recipient = Address::generate(&env);

    let id = client.propose_withdrawal(&admin, &token, &400, &recipient);
    assert_eq!(client.get_withdrawal(&id).executable_at, 1_000 + MIN_TIMELOCK_SECS);

    env.ledger().set_timestamp(1_000 + MIN_TIMELOCK_SECS - 1);
    assert_eq!(
        client.try_execute_withdrawal(&admin, &id),
        Err(Ok(GovernanceError::TimelockNotElapsed))
    );
}

#[test]
fn withdrawal_executes_after_48_hours_exactly_once() {
    let (env, client, admin) = setup();
    env.ledger().set_timestamp(1_000);
    let token = funded_treasury(&env, &client, 1_000);
    let recipient = Address::generate(&env);
    let tc = soroban_sdk::token::Client::new(&env, &token);

    let id = client.propose_withdrawal(&admin, &token, &400, &recipient);
    env.ledger().set_timestamp(1_000 + MIN_TIMELOCK_SECS);
    client.execute_withdrawal(&admin, &id);

    assert_eq!(tc.balance(&recipient), 400);
    assert_eq!(tc.balance(&client.address), 600);
    assert!(client.get_withdrawal(&id).executed);
    assert_eq!(
        client.try_execute_withdrawal(&admin, &id),
        Err(Ok(GovernanceError::WithdrawalClosed))
    );
}

#[test]
fn an_admin_can_cancel_a_pending_withdrawal() {
    let (env, client, admin) = setup();
    env.ledger().set_timestamp(1_000);
    let token = funded_treasury(&env, &client, 1_000);
    let recipient = Address::generate(&env);
    let second_admin = Address::generate(&env);
    client.grant_role(&admin, &Role::Admin, &second_admin);

    let id = client.propose_withdrawal(&admin, &token, &400, &recipient);
    client.cancel_withdrawal(&second_admin, &id);

    env.ledger().set_timestamp(1_000 + MIN_TIMELOCK_SECS);
    assert_eq!(
        client.try_execute_withdrawal(&admin, &id),
        Err(Ok(GovernanceError::WithdrawalClosed))
    );
    assert_eq!(soroban_sdk::token::Client::new(&env, &token).balance(&recipient), 0);
}

#[test]
fn only_admins_can_propose_execute_or_cancel_withdrawals() {
    let (env, client, admin) = setup();
    env.ledger().set_timestamp(1_000);
    let token = funded_treasury(&env, &client, 1_000);
    let recipient = Address::generate(&env);
    let stranger = Address::generate(&env);

    assert_eq!(
        client.try_propose_withdrawal(&stranger, &token, &400, &recipient),
        Err(Ok(GovernanceError::MissingRole))
    );
    let id = client.propose_withdrawal(&admin, &token, &400, &recipient);
    assert_eq!(
        client.try_cancel_withdrawal(&stranger, &id),
        Err(Ok(GovernanceError::MissingRole))
    );
    env.ledger().set_timestamp(1_000 + MIN_TIMELOCK_SECS);
    assert_eq!(
        client.try_execute_withdrawal(&stranger, &id),
        Err(Ok(GovernanceError::MissingRole))
    );
}

#[test]
fn withdrawal_amount_must_be_positive() {
    let (env, client, admin) = setup();
    let token = funded_treasury(&env, &client, 1_000);
    let recipient = Address::generate(&env);
    assert_eq!(
        client.try_propose_withdrawal(&admin, &token, &0, &recipient),
        Err(Ok(GovernanceError::InvalidAmount))
    );
}
