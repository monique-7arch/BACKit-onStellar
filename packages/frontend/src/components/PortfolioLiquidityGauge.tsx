'use client';

interface Props {
  totalLiquidity: number;
  availableLiquidity: number;
  utilizedLiquidity?: number;
  currency?: string;
}

export default function PortfolioLiquidityGauge({
  totalLiquidity,
  availableLiquidity,
  utilizedLiquidity,
  currency = 'USD',
}: Props) {
  const utilized = utilizedLiquidity !== undefined ? utilizedLiquidity : totalLiquidity - availableLiquidity;
  const utilizationPct = totalLiquidity > 0 ? Math.min(100, (utilized / totalLiquidity) * 100) : 0;
  const availablePct = totalLiquidity > 0 ? Math.min(100, (availableLiquidity / totalLiquidity) * 100) : 0;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <h3 className="mb-3 text-lg font-semibold text-gray-900">Liquidity</h3>
      <div className="mb-2 flex justify-between text-sm text-gray-600">
        <span>Utilization</span>
        <span>{utilizationPct.toFixed(1)}%</span>
      </div>
      <div className="mb-3 h-2 w-full rounded-full bg-gray-200">
        <div className="h-2 rounded-full bg-blue-600 transition-all" style={{ width: `${utilizationPct}%` }} />
      </div>
      <div className="space-y-1 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-600">Total</span>
          <span className="font-medium">
            {totalLiquidity.toFixed(2)} {currency}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-600">Available</span>
          <span className="font-medium text-green-600">
            {availableLiquidity.toFixed(2)} {currency}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-600">Utilized</span>
          <span className="font-medium text-orange-600">
            {utilized.toFixed(2)} {currency}
          </span>
        </div>
      </div>
    </div>
  );
}