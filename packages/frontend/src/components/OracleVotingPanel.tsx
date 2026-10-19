'use client';

import { useState } from 'react';

export interface Vote {
  proposalId: string;
  option: string;
  weight?: number;
}

interface Proposal {
  id: string;
  title: string;
  description: string;
  options: string[];
  endsAt: string | number;
}

interface Props {
  proposals: Proposal[];
  onVote?: (vote: Vote) => void;
}

export default function OracleVotingPanel({ proposals, onVote }: Props) {
  const [selected, setSelected] = useState<Record<string, string>>({});

  const handleVote = (proposalId: string) => {
    const option = selected[proposalId];
    if (option && onVote) {
      onVote({ proposalId, option });
    }
  };

  const isExpired = (endsAt: string | number) => {
    const end = typeof endsAt === 'string' ? new Date(endsAt).getTime() : endsAt;
    return end < Date.now();
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <h3 className="mb-3 text-lg font-semibold text-gray-900">Oracle Voting</h3>
      <div className="space-y-4">
        {proposals.length === 0 ? (
          <p className="text-sm text-gray-500">No active proposals</p>
        ) : (
          proposals.map(p => {
            const expired = isExpired(p.endsAt);
            return (
              <div key={p.id} className="rounded border border-gray-200 p-3">
                <div className="mb-2 flex justify-between">
                  <h4 className="text-sm font-semibold text-gray-900">{p.title}</h4>
                  {expired && <span className="text-xs text-gray-500">Ended</span>}
                </div>
                <p className="mb-3 text-xs text-gray-600">{p.description}</p>
                <div className="mb-3 space-y-1">
                  {p.options.map(opt => (
                    <label key={opt} className="flex items-center gap-2 text-xs">
                      <input
                        type="radio"
                        name={`p-${p.id}`}
                        value={opt}
                        checked={selected[p.id] === opt}
                        onChange={e => setSelected(prev => ({ ...prev, [p.id]: e.target.value }))}
                        disabled={expired}
                      />
                      <span>{opt}</span>
                    </label>
                  ))}
                </div>
                <button onClick={() => handleVote(p.id)} disabled={!selected[p.id] || expired} className="w-full rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300">
                  Vote
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}