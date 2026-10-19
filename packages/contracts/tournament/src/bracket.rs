//! 16-team single-elimination bracket contest layered on the tournament
//! contract: entrants pay a pooled fee, pick every game winner up front, and
//! are scored as rounds are resolved on-chain.
//!
//! A bracket is 15 picks in round-major order: indices 0..8 are the
//! round-of-16 winners (game `g` is between teams `2g` and `2g+1`), 8..12 the
//! quarterfinal winners, 12..14 the semifinal winners and 14 the champion.
//! A pick must be one of the two teams the entrant themselves advanced into
//! that game.

use soroban_sdk::{contractimpl, contracttype, token, Address, Env, Vec};

use crate::errors::TournamentError;
use crate::storage::get_admin;
#[allow(unused_imports)]
use crate::{TournamentContract, TournamentContractArgs, TournamentContractClient};

const GAMES: u32 = 15;
const ROUND_START: [u32; 5] = [0, 8, 12, 14, 15];
/// Points per correct pick, by round (R16, QF, SF, Final).
const ROUND_POINTS: [i128; 4] = [1, 2, 4, 8];
const MAX_ENTRANTS: u32 = 64;
/// Prize split of 1st / 2nd / 3rd, in percent.
const PRIZE_SHARES: [i128; 3] = [50, 30, 20];

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BracketContest {
    pub token: Address,
    pub entry_fee: i128,
    pub lock_ts: u64,
    pub pool: i128,
    /// Winners of games resolved so far, same layout as a bracket.
    pub results: Vec<u32>,
    pub finalized: bool,
}

#[contracttype]
enum BracketKey {
    Contest(u64),
    Entrants(u64),
    Picks(u64, Address),
}

fn fail(env: &Env, e: TournamentError) -> ! {
    soroban_sdk::panic_with_error!(env, e)
}

fn contest(env: &Env, id: u64) -> BracketContest {
    env.storage()
        .persistent()
        .get(&BracketKey::Contest(id))
        .unwrap_or_else(|| fail(env, TournamentError::BracketNotFound))
}

fn save(env: &Env, id: u64, c: &BracketContest) {
    env.storage().persistent().set(&BracketKey::Contest(id), c);
}

fn entrants(env: &Env, id: u64) -> Vec<Address> {
    env.storage()
        .persistent()
        .get(&BracketKey::Entrants(id))
        .unwrap_or_else(|| Vec::new(env))
}

fn picks_of(env: &Env, id: u64, user: &Address) -> Vec<u32> {
    env.storage()
        .persistent()
        .get(&BracketKey::Picks(id, user.clone()))
        .unwrap_or_else(|| fail(env, TournamentError::ParticipantNotFound))
}

fn round_of(game: u32) -> usize {
    ROUND_START.iter().rposition(|s| *s <= game).unwrap()
}

/// The two teams that can play game `game` given earlier winners `w`.
fn participants(w: &Vec<u32>, game: u32) -> (u32, u32) {
    if game < 8 {
        (2 * game, 2 * game + 1)
    } else {
        // Game g (round r>=1) is fed by the two games before it in round r-1.
        let r = round_of(game);
        let idx = game - ROUND_START[r];
        let feed = ROUND_START[r - 1] + 2 * idx;
        (w.get(feed).unwrap(), w.get(feed + 1).unwrap())
    }
}

/// `true` if every pick in `w` is a legal winner of its game.
fn consistent(w: &Vec<u32>) -> bool {
    for game in 0..w.len() {
        let (a, b) = participants(w, game);
        let p = w.get(game).unwrap();
        if p != a && p != b {
            return false;
        }
    }
    true
}

fn score(picks: &Vec<u32>, results: &Vec<u32>) -> i128 {
    let mut total = 0i128;
    for g in 0..results.len() {
        if picks.get(g) == results.get(g) {
            total += ROUND_POINTS[round_of(g)];
        }
    }
    total
}

#[contractimpl]
impl TournamentContract {
    /// Open a bracket contest for `tournament_id` (admin only).
    pub fn init_bracket(env: Env, tournament_id: u64, token: Address, entry_fee: i128, lock_ts: u64) {
        let admin = get_admin(&env).unwrap_or_else(|| fail(&env, TournamentError::NotInitialized));
        admin.require_auth();
        if entry_fee <= 0 {
            fail(&env, TournamentError::InvalidPrizePool);
        }
        if env.storage().persistent().has(&BracketKey::Contest(tournament_id)) {
            fail(&env, TournamentError::BracketAlreadyExists);
        }
        save(
            &env,
            tournament_id,
            &BracketContest { token, entry_fee, lock_ts, pool: 0, results: Vec::new(&env), finalized: false },
        );
    }

    /// Submit a full 15-pick bracket and pay the entry fee into the pool.
    pub fn submit_bracket(env: Env, user: Address, tournament_id: u64, picks: Vec<u32>) {
        user.require_auth();
        let mut c = contest(&env, tournament_id);
        if env.ledger().timestamp() >= c.lock_ts {
            fail(&env, TournamentError::BracketLocked);
        }
        if picks.len() != GAMES || picks.iter().any(|p| p >= 16) || !consistent(&picks) {
            fail(&env, TournamentError::InvalidBracket);
        }
        let key = BracketKey::Picks(tournament_id, user.clone());
        if env.storage().persistent().has(&key) {
            fail(&env, TournamentError::BracketAlreadySubmitted);
        }
        let mut list = entrants(&env, tournament_id);
        if list.len() >= MAX_ENTRANTS {
            fail(&env, TournamentError::TooManyEntrants);
        }

        token::Client::new(&env, &c.token).transfer(&user, &env.current_contract_address(), &c.entry_fee);
        c.pool = c.pool.checked_add(c.entry_fee).unwrap_or_else(|| fail(&env, TournamentError::InvalidPrizePool));
        save(&env, tournament_id, &c);
        env.storage().persistent().set(&key, &picks);
        list.push_back(user);
        env.storage().persistent().set(&BracketKey::Entrants(tournament_id), &list);
    }

    /// Record the winners of the next round (admin only). Rounds must be
    /// resolved in order and each winner must be a legal participant.
    pub fn resolve_round(env: Env, tournament_id: u64, winners: Vec<u32>) {
        let admin = get_admin(&env).unwrap_or_else(|| fail(&env, TournamentError::NotInitialized));
        admin.require_auth();
        let mut c = contest(&env, tournament_id);
        if c.results.len() >= GAMES {
            fail(&env, TournamentError::RoundOutOfOrder);
        }
        let r = round_of(c.results.len());
        let size = ROUND_START[r + 1] - ROUND_START[r];
        if winners.len() != size {
            fail(&env, TournamentError::InvalidBracket);
        }
        for w in winners.iter() {
            c.results.push_back(w);
        }
        if !consistent(&c.results) || c.results.iter().any(|p| p >= 16) {
            fail(&env, TournamentError::InvalidBracket);
        }
        save(&env, tournament_id, &c);
    }

    /// Points a bracket has earned against the rounds resolved so far.
    pub fn bracket_score(env: Env, tournament_id: u64, user: Address) -> i128 {
        let c = contest(&env, tournament_id);
        score(&picks_of(&env, tournament_id, &user), &c.results)
    }

    pub fn get_bracket_pool(env: Env, tournament_id: u64) -> i128 {
        contest(&env, tournament_id).pool
    }

    /// After the final, pay the pool 50/30/20 to the top three brackets
    /// (renormalised when fewer than three entered). Ranking: score, then a
    /// correct champion pick, then earliest submission. Rounding dust goes
    /// to first place, so exactly `pool` is paid out.
    pub fn finalize_bracket(env: Env, tournament_id: u64) {
        let mut c = contest(&env, tournament_id);
        if c.finalized {
            fail(&env, TournamentError::TournamentAlreadyFinalized);
        }
        if c.results.len() != GAMES {
            fail(&env, TournamentError::NotAllRoundsResolved);
        }
        let list = entrants(&env, tournament_id);
        let champion = c.results.get(14).unwrap();

        // (score, champion correct, submission order) for each entrant.
        let n = list.len();
        let mut order: Vec<u32> = Vec::new(&env);
        let mut keys: Vec<(i128, bool)> = Vec::new(&env);
        for i in 0..n {
            let p = picks_of(&env, tournament_id, &list.get(i).unwrap());
            keys.push_back((score(&p, &c.results), p.get(14).unwrap() == champion));
            order.push_back(i);
        }
        // Insertion sort; stable, so equal keys keep submission order.
        for i in 1..n {
            let mut j = i;
            while j > 0 {
                let (a, b) = (order.get(j - 1).unwrap(), order.get(j).unwrap());
                if keys.get(b).unwrap() > keys.get(a).unwrap() {
                    order.set(j - 1, b);
                    order.set(j, a);
                    j -= 1;
                } else {
                    break;
                }
            }
        }

        let k = n.min(3) as usize;
        if k > 0 {
            let total: i128 = PRIZE_SHARES[..k].iter().sum();
            let mut paid = 0i128;
            let mut prizes = [0i128; 3];
            for i in 0..k {
                prizes[i] = c.pool * PRIZE_SHARES[i] / total;
                paid += prizes[i];
            }
            prizes[0] += c.pool - paid; // dust to the winner
            let t = token::Client::new(&env, &c.token);
            for i in 0..k {
                let who = list.get(order.get(i as u32).unwrap()).unwrap();
                t.transfer(&env.current_contract_address(), &who, &prizes[i]);
            }
        }
        c.finalized = true;
        save(&env, tournament_id, &c);
    }
}
