export interface Matchup {
  id: string;
  team1?: string;
  team2?: string;
  winner?: string;
  score1?: number;
  score2?: number;
  round: number;
  matchNumber: number;
}

export interface Tournament {
  id: string;
  name: string;
  teams: string[];
  rounds: number;
  matchups: Matchup[];
}

export function generateBracket(teams: string[]): Tournament {
  const numTeams = teams.length;
  const rounds = Math.ceil(Math.log2(numTeams));
  const matchups: Matchup[] = [];

  for (let r = 0; r < rounds; r++) {
    const matchesInRound = Math.pow(2, rounds - r - 1);
    for (let m = 0; m < matchesInRound; m++) {
      matchups.push({
        id: `r${r}-m${m}`,
        round: r,
        matchNumber: m,
      });
    }
  }

  // Seed first round
  const firstRoundMatches = matchups.filter(m => m.round === 0);
  for (let i = 0; i < firstRoundMatches.length; i++) {
    const idx = i * 2;
    firstRoundMatches[i].team1 = teams[idx];
    firstRoundMatches[i].team2 = teams[idx + 1];
  }

  return {
    id: 'tournament',
    name: 'Tournament',
    teams,
    rounds,
    matchups,
  };
}

export function getNextMatchup(matchups: Matchup[], currentMatchId: string): Matchup | undefined {
  const current = matchups.find(m => m.id === currentMatchId);
  if (!current || !current.winner) return undefined;

  const nextRound = current.round + 1;
  const nextMatch = Math.floor(current.matchNumber / 2);
  return matchups.find(m => m.round === nextRound && m.matchNumber === nextMatch);
}

export function getUserPath(matchups: Matchup[], userTeam: string): string[] {
  const path: string[] = [];
  let currentTeam = userTeam;

  for (let r = 0; r < 10; r++) {
    const match = matchups.find(m => m.round === r && (m.team1 === currentTeam || m.team2 === currentTeam));
    if (!match) break;
    path.push(match.id);
    if (match.winner !== currentTeam) break;
    currentTeam = match.winner;
  }
  return path;
}