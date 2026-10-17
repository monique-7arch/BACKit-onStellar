#![no_std]

mod errors;
mod events;
pub mod pause;
pub mod rbac;
mod storage;
pub mod timelock;
mod types;

#[cfg(test)]
mod test;

use errors::GovernanceError;
use events::{
    emit_delegation, emit_pause_changed, emit_proposal_created, emit_proposal_executed,
    emit_role_granted, emit_role_revoked, emit_vote_cast, emit_withdrawal_cancelled,
    emit_withdrawal_executed, emit_withdrawal_proposed,
};
use rbac::Role;
use soroban_sdk::{contract, contractimpl, token, Address, Env, Symbol, Vec};
use timelock::{WithdrawalProposal, MIN_TIMELOCK_SECS};
use storage::*;
use types::{GovernanceConfig, Proposal, Vote};

const VOTING_POWER_DENOM: i128 = 1_000_000;

#[contract]
pub struct Governance;

#[contractimpl]
impl Governance {
    pub fn initialize(
        env: Env,
        admin: Address,
        proposal_threshold_calls: u32,
        threshold_accuracy_bps: u32,
        voting_period_ledgers: u32,
        quorum_bps: u32,
        pass_threshold_bps: u32,
    ) -> Result<(), GovernanceError> {
        if get_config(&env).is_some() {
            return Err(GovernanceError::AlreadyInitialized);
        }
        admin.require_auth();
        rbac::grant(&env, Role::Admin, &admin);
        let config = GovernanceConfig {
            admin,
            proposal_threshold_calls,
            threshold_accuracy_bps,
            voting_period_ledgers,
            quorum_bps,
            pass_threshold_bps,
        };
        set_config(&env, &config);
        backit_shared::ttl::extend_instance(&env);
        Ok(())
    }

    pub fn propose_change(
        env: Env,
        proposer: Address,
        target_contract: Address,
        function_name: Symbol,
    ) -> Result<u64, GovernanceError> {
        proposer.require_auth();
        let config = get_config(&env).ok_or(GovernanceError::NotInitialized)?;
        pause::when_not_paused(&env, pause::PAUSE_CREATION)?;

        let reputation = Self::get_user_reputation(&env, &proposer);
        let accuracy = reputation.0;
        let _total_staked = reputation.1;

        if accuracy < config.proposal_threshold_calls || accuracy == 0 {
            return Err(GovernanceError::InsufficientReputation);
        }

        let id = next_proposal_id(&env);
        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            target_contract,
            function_name: function_name.clone(),
            for_votes: 0,
            against_votes: 0,
            created_ledger: env.ledger().sequence(),
            executed: false,
        };
        set_proposal(&env, id, &proposal);
        emit_proposal_created(&env, id, &proposer, &proposal.target_contract, &function_name);
        Ok(id)
    }

    pub fn vote(
        env: Env,
        voter: Address,
        proposal_id: u64,
        support: bool,
    ) -> Result<(), GovernanceError> {
        voter.require_auth();
        let config = get_config(&env).ok_or(GovernanceError::NotInitialized)?;
        let mut proposal = get_proposal(&env, proposal_id).ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.executed {
            return Err(GovernanceError::AlreadyExecuted);
        }

        let current_ledger = env.ledger().sequence();
        if current_ledger > proposal.created_ledger + config.voting_period_ledgers {
            return Err(GovernanceError::VotingPeriodEnded);
        }

        let delegate = get_delegate(&env, &voter);
        let effective_voter = delegate.unwrap_or_else(|| voter.clone());

        let mut votes = get_votes(&env, proposal_id);
        for i in 0..votes.len() {
            if votes.get(i).unwrap().voter == effective_voter {
                let mut v = votes.get(i).unwrap();
                v.support = support;
                let power = v.power;
                votes.set(i, v);
                set_votes(&env, proposal_id, &votes);
                emit_vote_cast(&env, proposal_id, &effective_voter, support, power);
                return Ok(());
            }
        }

        let reputation = Self::get_user_reputation(&env, &effective_voter);
        let accuracy_bps = reputation.0;
        let total_staked = reputation.1;

        let power = (accuracy_bps as i128 * VOTING_POWER_DENOM) + total_staked / 1_000_000;
        let vote = Vote {
            voter: effective_voter.clone(),
            support,
            power,
        };
        votes.push_back(vote);
        set_votes(&env, proposal_id, &votes);

        if support {
            proposal.for_votes = proposal.for_votes.checked_add(power).ok_or(GovernanceError::ProposalInactive)?;
        } else {
            proposal.against_votes = proposal.against_votes.checked_add(power).ok_or(GovernanceError::ProposalInactive)?;
        }
        set_proposal(&env, proposal_id, &proposal);

        emit_vote_cast(&env, proposal_id, &effective_voter, support, power);
        Ok(())
    }

    pub fn execute_proposal(env: Env, caller: Address, proposal_id: u64) -> Result<(), GovernanceError> {
        caller.require_auth();
        let config = get_config(&env).ok_or(GovernanceError::NotInitialized)?;
        pause::when_not_paused(&env, pause::PAUSE_SETTLEMENT)?;
        let mut proposal = get_proposal(&env, proposal_id).ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.executed {
            return Err(GovernanceError::AlreadyExecuted);
        }

        let current_ledger = env.ledger().sequence();
        if current_ledger <= proposal.created_ledger + config.voting_period_ledgers {
            return Err(GovernanceError::ProposalInactive);
        }

        let total_power = proposal.for_votes + proposal.against_votes;
        let quorum = (get_possible_voting_power(&env) * config.quorum_bps as i128) / 10000;
        if total_power < quorum {
            return Err(GovernanceError::QuorumNotMet);
        }

        let pass_threshold = (total_power * config.pass_threshold_bps as i128) / 10000;
        if proposal.for_votes <= pass_threshold {
            return Err(GovernanceError::ProposalNotPassed);
        }

        proposal.executed = true;
        set_proposal(&env, proposal_id, &proposal);

        env.invoke_contract::<()>(
            &proposal.target_contract,
            &proposal.function_name,
            soroban_sdk::vec![&env],
        );

        emit_proposal_executed(&env, proposal_id);
        Ok(())
    }

    pub fn delegate_votes(
        env: Env,
        delegator: Address,
        delegate: Address,
    ) -> Result<(), GovernanceError> {
        delegator.require_auth();
        if delegator == delegate {
            return Err(GovernanceError::SelfDelegation);
        }
        set_delegate(&env, &delegator, &delegate);
        emit_delegation(&env, &delegator, &delegate);
        Ok(())
    }

    pub fn get_proposal_view(env: Env, proposal_id: u64) -> Result<Proposal, GovernanceError> {
        get_proposal(&env, proposal_id).ok_or(GovernanceError::ProposalNotFound)
    }

    pub fn get_active_proposals(env: Env) -> Vec<Proposal> {
        let config = match get_config(&env) {
            Some(c) => c,
            None => return Vec::new(&env),
        };
        let ids = get_proposal_ids(&env);
        let current = env.ledger().sequence();
        let mut result = Vec::new(&env);
        for i in 0..ids.len() {
            let id = ids.get(i).unwrap();
            if let Some(p) = get_proposal(&env, id) {
                if !p.executed && current <= p.created_ledger + config.voting_period_ledgers {
                    result.push_back(p);
                }
            }
        }
        result
    }

    pub fn get_voting_power(env: Env, user: Address) -> i128 {
        let rep = Self::get_user_reputation(&env, &user);
        (rep.0 as i128 * VOTING_POWER_DENOM) + rep.1 / 1_000_000
    }

    pub fn get_delegate(env: Env, address: Address) -> Option<Address> {
        storage::get_delegate(&env, &address)
    }

    pub fn set_reputation(
        env: Env,
        admin: Address,
        user: Address,
        resolved_calls: u32,
        total_staked: i128,
    ) -> Result<(), GovernanceError> {
        admin.require_auth();
        let config = get_config(&env).ok_or(GovernanceError::NotInitialized)?;
        if admin != config.admin {
            return Err(GovernanceError::Unauthorized);
        }
        set_user_reputation(&env, &user, resolved_calls, total_staked);
        Ok(())
    }

    // ── Roles (SC-034) ─────────────────────────────────────────────────────

    /// Grant `role` to `account`. Only an Admin may do this; a role can have many holders.
    pub fn grant_role(env: Env, caller: Address, role: Role, account: Address) -> Result<(), GovernanceError> {
        rbac::require_role(&env, Role::Admin, &caller)?;
        rbac::grant(&env, role, &account);
        backit_shared::ttl::extend_instance(&env);
        emit_role_granted(&env, role, &account, &caller);
        Ok(())
    }

    /// Revoke `role` from `account`. Only an Admin may do this; an Admin cannot
    /// revoke their own Admin role (use [`Self::transfer_role`]).
    pub fn revoke_role(env: Env, caller: Address, role: Role, account: Address) -> Result<(), GovernanceError> {
        rbac::require_role(&env, Role::Admin, &caller)?;
        if role == Role::Admin && account == caller {
            return Err(GovernanceError::CannotRevokeOwnAdmin);
        }
        rbac::revoke(&env, role, &account);
        emit_role_revoked(&env, role, &account, &caller);
        Ok(())
    }

    /// Move `role` from the caller to `to`. The caller must hold it and authorises the move.
    pub fn transfer_role(env: Env, from: Address, role: Role, to: Address) -> Result<(), GovernanceError> {
        rbac::require_role(&env, role, &from)?;
        rbac::grant(&env, role, &to);
        if from != to {
            rbac::revoke(&env, role, &from);
        }
        emit_role_revoked(&env, role, &from, &from);
        emit_role_granted(&env, role, &to, &from);
        Ok(())
    }

    pub fn has_role(env: Env, role: Role, account: Address) -> bool {
        rbac::has_role(&env, role, &account)
    }

    // ── Circuit breaker (SC-035) ───────────────────────────────────────────

    /// Replace the pause bitmask. Only a Pauser may do this; `0` unpauses everything.
    pub fn set_paused(env: Env, caller: Address, flags: u32) -> Result<(), GovernanceError> {
        rbac::require_role(&env, Role::Pauser, &caller)?;
        pause::set_flags(&env, flags & pause::PAUSE_ALL);
        emit_pause_changed(&env, flags & pause::PAUSE_ALL, &caller);
        Ok(())
    }

    pub fn paused_flags(env: Env) -> u32 {
        pause::flags(&env)
    }

    // ── Timelocked treasury withdrawals (SC-033) ───────────────────────────

    /// Propose moving `amount` of `token` out of this contract's treasury. It can
    /// be executed no sooner than 48 hours later and cancelled until then.
    pub fn propose_withdrawal(
        env: Env,
        proposer: Address,
        token: Address,
        amount: i128,
        recipient: Address,
    ) -> Result<u64, GovernanceError> {
        rbac::require_role(&env, Role::Admin, &proposer)?;
        if amount <= 0 {
            return Err(GovernanceError::InvalidAmount);
        }
        let now = env.ledger().timestamp();
        let executable_at = now + MIN_TIMELOCK_SECS;
        let id = timelock::next_id(&env);
        timelock::set(
            &env,
            &WithdrawalProposal {
                id,
                token: token.clone(),
                amount,
                recipient: recipient.clone(),
                proposer,
                proposed_at: now,
                executable_at,
                executed: false,
                cancelled: false,
            },
        );
        backit_shared::ttl::extend_instance(&env);
        emit_withdrawal_proposed(&env, id, &token, amount, &recipient, executable_at);
        Ok(id)
    }

    /// Execute a withdrawal once the timelock has elapsed.
    pub fn execute_withdrawal(env: Env, caller: Address, id: u64) -> Result<(), GovernanceError> {
        rbac::require_role(&env, Role::Admin, &caller)?;
        let mut w = timelock::get(&env, id).ok_or(GovernanceError::WithdrawalNotFound)?;
        if w.executed || w.cancelled {
            return Err(GovernanceError::WithdrawalClosed);
        }
        if env.ledger().timestamp() < w.executable_at {
            return Err(GovernanceError::TimelockNotElapsed);
        }
        w.executed = true;
        timelock::set(&env, &w);
        token::Client::new(&env, &w.token).transfer(&env.current_contract_address(), &w.recipient, &w.amount);
        emit_withdrawal_executed(&env, id);
        Ok(())
    }

    /// Cancel a pending withdrawal. Any Admin may cancel, so a malicious proposal
    /// can be stopped by a single honest signer during the timelock.
    pub fn cancel_withdrawal(env: Env, caller: Address, id: u64) -> Result<(), GovernanceError> {
        rbac::require_role(&env, Role::Admin, &caller)?;
        let mut w = timelock::get(&env, id).ok_or(GovernanceError::WithdrawalNotFound)?;
        if w.executed || w.cancelled {
            return Err(GovernanceError::WithdrawalClosed);
        }
        w.cancelled = true;
        timelock::set(&env, &w);
        emit_withdrawal_cancelled(&env, id, &caller);
        Ok(())
    }

    pub fn get_withdrawal(env: Env, id: u64) -> Result<WithdrawalProposal, GovernanceError> {
        timelock::get(&env, id).ok_or(GovernanceError::WithdrawalNotFound)
    }

    fn get_user_reputation(env: &Env, user: &Address) -> (u32, i128) {
        storage::get_user_reputation(env, user)
    }
}

fn get_possible_voting_power(env: &Env) -> i128 {
    100_000_000_000
}
