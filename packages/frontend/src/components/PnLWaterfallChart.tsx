'use client';

export interface WaterfallItem {
  label: string;
  value: number;
  type?: 'positive' | 'negative' | 'total';
}

interface Props {
  items: WaterfallItem[];
  currency?: string;
}

export default function PnLWaterfallChart({ items, currency = 'USD' }: Props) {
  const total = items.reduce((sum, item) => {
    if (item.type === 'total') return item.value;
    return sum + item.value;
  }, 0);

  let running = 0;
  const withRunning = items.map(item => {
    if (item.type === 'total') {
      running = item.value;
    } else {
      running += item.value;
    }
    return { ...item, running };
  });

  const maxAbs = Math.max(...withRunning.map(i => Math.abs(i.running)), 1);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <h3 className="mb-4 text-lg font-semibold text-gray-900">PnL Waterfall</h3>
      <div className="space-y-3">
        {withRunning.map((item, idx) => {
          const isPositive = item.value >= 0 && item.type !== 'negative';
          const isNegative = item.type === 'negative' || item.value < 0;
          const widthPct = (Math.abs(item.running) / maxAbs) * 100;
          return (
            <div key={idx} className="space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-gray-700">{item.label}</span>
                <span className={`font-medium ${isNegative ? 'text-red-600' : 'text-green-600'}`}>
                  {item.value >= 0 ? '+' : ''}
                  {item.value.toFixed(2)} {currency}
                </span>
              </div>
              <div className="h-2 w-full rounded-full bg-gray-100">
                <div
                  className={`h-2 rounded-full ${isNegative ? 'bg-red-500' : item.type === 'total' ? 'bg-blue-500' : 'bg-green-500'}`}
                  style={{ width: `${Math.min(100, widthPct)}%` }}
                />
              </div>
              <div className="text-xs text-gray-500">Running: {item.running.toFixed(2)} {currency}</div>
            </div>
          );
        })}
      </div>
      <div className="mt-4 border-t pt-3 text-sm">
        <div className="flex justify-between font-semibold">
          <span>Total PnL</span>
          <span className={total >= 0 ? 'text-green-600' : 'text-red-600'}>
            {total >= 0 ? '+' : ''}
            {total.toFixed(2)} {currency}
          </span>
        </div>
      </div>
    </div>
  );
}