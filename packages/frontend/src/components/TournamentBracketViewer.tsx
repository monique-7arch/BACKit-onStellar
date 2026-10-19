'use client';

import { useState } from 'react';
import { type Tournament, type Matchup } from '@/lib/tournament-utils';
import TournamentCard from './TournamentCard';

interface Props {
  tournament: Tournament;
  onPick?: (matchId: string, winner: string) => void;
  userPicks?: Record<string, string>;
  userTeam?: string;
}

export default function TournamentBracketViewer({ tournament, onPick, userPicks = {}, userTeam }: Props) {
  const [scale, setScale] = useState<number>(1);

  const handleZoomIn = () => setScale(s => Math.min(s + 0.1, 2));
  const handleZoomOut = () => setScale(s => Math.max(s - 0.1, 0.5));
  const handleReset = () => setScale(1);

  const matchupsByRound = tournament.matchups.reduce((acc, m) => {
    if (!acc[m.round]) acc[m.round] = [];
    acc[m.round].push(m);
    return acc;
  }, {} as Record<number, Matchup[]>);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">{tournament.name}</h3>
        <div className="flex gap-2">
          <button onClick={handleZoomOut} className="rounded bg-gray-100 px-2 py-1 text-sm hover:bg-gray-200">-</button>
          <button onClick={handleReset} className="rounded bg-gray-100 px-2 py-1 text-sm hover:bg-gray-200">Reset</button>
          <button onClick={handleZoomIn} className="rounded bg-gray-100 px-2 py-1 text-sm hover:bg-gray-200">+</button>
        </div>
      </div>

      <div className="overflow-auto">
        <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }} className="flex min-w-max gap-6">
          {Object.keys(matchupsByRound).map(round => {
            const roundNum = parseInt(round);
            const matches = matchupsByRound[roundNum];
            return (
              <div key={round} className="flex flex-col justify-around gap-4">
                <div className="text-center text-sm font-medium text-gray-600">Round {roundNum + 1}</div>
                {matches.map(m => (
                  <TournamentCard
                    key={m.id}
                    matchup={m}
                    onPick={onPick}
                    userPick={userPicks[m.id]}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {userTeam && <div className="mt-4 text-sm text-gray-600">Tracking team: {userTeam}</div>}
    </div>
  );
}