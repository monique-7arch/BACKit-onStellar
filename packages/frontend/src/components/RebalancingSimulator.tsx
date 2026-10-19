'use client';

import { useState, useMemo } from 'react';

export interface AssetAllocation {
  asset: string;
  currentWeight: number;
  targetWeight: number;
}

interface Props {
  allocations: AssetAllocation[];
  totalValue: number;
  onSimulate?: (trades: Trade[]) => void;
}

export interface Trade {
  asset: string;
  action: 'buy' | 'sell';
  amount: number;
  value: number;
}

export default function RebalancingSimulator({ allocations, totalValue, onSimulate }: Props) {
  const [tolerance, setTolerance] = useState<number>(0.5);

  const trades = useMemo(() => {
    const result: Trade[] = [];
    for (const alloc of allocations) {
      const currentValue = (alloc.currentWeight / 100) * totalValue;
      const targetValue = (alloc.targetWeight / 100) * totalValue;
      const diff = targetValue - currentValue;
      if (Math.abs(diff) > (tolerance / 100) * totalValue) {
        result.push({
          asset: alloc.asset,
          action: diff > 0 ? 'buy' : 'sell',
          amount: Math.abs(diff) / (targetValue > 0 || currentValue > 0 ? 1 : 1),
          value: Math.abs(diff),
        });
      }
    }
    return result;
  }, [allocations, totalValue, tolerance]);

  const handleSimulate = () => {
    if (onSimulate) {
      onSimulate(trades);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <h3 className="mb-3 text-lg font-semibold text-gray-900">Rebalancing Simulator</h3>
      <div className="mb-4">
        <label className="mb-1 block text-sm font-medium text-gray-700">Tolerance (%)</label>
        <input type="number" value={tolerance} onChange={e => setTolerance(parseFloat(e.target.value) || 0)} min="0" step="0.1" className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
      </div>
      <div className="mb-4 space-y-2">
        <h4 className="text-sm font-medium text-gray-700">Allocations</h4>
        {allocations.map((a, i) => (
          <div key={i} className="grid grid-cols-3 gap-2 rounded bg-gray-50 p-2 text-xs">
            <span>{a.asset}</span>
            <span>Current: {a.currentWeight.toFixed(1)}%</span>
            <span>Target: {a.targetWeight.toFixed(1)}%</span>
          </div>
        ))}
      </div>
      <div className="mb-4">
        <h4 className="mb-2 text-sm font-medium text-gray-700">Suggested Trades</h4>
        {trades.length === 0 ? (
          <p className="text-xs text-gray-500">No rebalancing needed</p>
        ) : (
          <div className="space-y-1">
            {trades.map((t, i) => (
              <div key={i} className={`flex justify-between rounded p-2 text-xs ${t.action === 'buy' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                <span>{t.action.toUpperCase()} {t.asset}</span>
                <span>${t.value.toFixed(2)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <button onClick={handleSimulate} disabled={trades.length === 0} className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300">Simulate Rebalance</button>
    </div>
  );
}