'use client';

import { useState } from 'react';

interface Props {
  currentLimit: number;
  maxLimit?: number;
  onSave?: (limit: number) => void;
  currency?: string;
}

export default function StakingLimitSettings({ currentLimit, maxLimit = 100000, onSave, currency = 'USD' }: Props) {
  const [limit, setLimit] = useState<number>(currentLimit);

  const handleSave = () => {
    if (onSave && limit >= 0 && limit <= maxLimit) {
      onSave(limit);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <h3 className="mb-3 text-lg font-semibold text-gray-900">Staking Limit Settings</h3>
      <div className="mb-3">
        <label className="mb-1 block text-sm font-medium text-gray-700">Daily Staking Limit ({currency})</label>
        <input
          type="number"
          value={limit}
          onChange={e => setLimit(parseFloat(e.target.value) || 0)}
          min="0"
          max={maxLimit}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
        />
        <p className="mt-1 text-xs text-gray-500">Max: {maxLimit.toLocaleString()} {currency}</p>
      </div>
      <div className="mb-3 flex justify-between text-sm">
        <span className="text-gray-600">Current</span>
        <span className="font-medium">{currentLimit.toLocaleString()} {currency}</span>
      </div>
      <button onClick={handleSave} className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">Save Settings</button>
    </div>
  );
}