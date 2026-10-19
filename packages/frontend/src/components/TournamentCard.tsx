import { type Matchup } from '@/lib/tournament-utils';

interface Props {
  matchup: Matchup;
  onPick?: (matchId: string, winner: string) => void;
  userPick?: string;
}

export default function TournamentCard({ matchup, onPick, userPick }: Props) {
  const { team1, team2, winner } = matchup;

  const handlePick = (team: string) => {
    if (onPick && !winner) {
      onPick(matchup.id, team);
    }
  };

  return (
    <div className="w-48 rounded border border-gray-200 bg-white p-2 text-xs shadow-sm">
      <div className="mb-1 font-medium text-gray-700">R{matchup.round + 1} M{matchup.matchNumber + 1}</div>
      <div className="space-y-1">
        <div
          onClick={() => team1 && handlePick(team1)}
          className={`cursor-pointer rounded px-2 py-1 ${winner === team1 ? 'bg-blue-100 font-semibold' : userPick === team1 ? 'bg-blue-50' : 'hover:bg-gray-50'} ${!winner && team1 ? '' : ''}`}
        >
          {team1 || 'TBD'}
          {winner === team1 && <span className="ml-1 text-blue-600">✓</span>}
        </div>
        <div
          onClick={() => team2 && handlePick(team2)}
          className={`cursor-pointer rounded px-2 py-1 ${winner === team2 ? 'bg-blue-100 font-semibold' : userPick === team2 ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
        >
          {team2 || 'TBD'}
          {winner === team2 && <span className="ml-1 text-blue-600">✓</span>}
        </div>
      </div>
      {winner && <div className="mt-2 text-[10px] text-gray-600">Winner: {winner}</div>}
    </div>
  );
}