import { type OrderbookLevel } from '@/lib/orderbook-utils';

interface Props {
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  onPriceClick?: (price: number) => void;
}

export default function OrderLadder({ bids, asks, onPriceClick }: Props) {
  const handleClick = (price: number) => {
    if (onPriceClick) {
      onPriceClick(price);
    }
  };

  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <h4 className="mb-2 text-sm font-semibold text-green-700">Bids</h4>
        <div className="space-y-1">
          {bids.map((level, i) => (
            <div
              key={`${level.price}-${i}`}
              className="flex cursor-pointer items-center justify-between rounded bg-green-50 px-2 py-1 text-xs hover:bg-green-100"
              onClick={() => handleClick(level.price)}
            >
              <span>{level.price.toFixed(4)}</span>
              <span className="text-gray-600">{level.total.toFixed(2)}</span>
            </div>
          ))}
          {bids.length === 0 && <div className="text-xs text-gray-500">No bids</div>}
        </div>
      </div>
      <div>
        <h4 className="mb-2 text-sm font-semibold text-red-700">Asks</h4>
        <div className="space-y-1">
          {asks.map((level, i) => (
            <div
              key={`${level.price}-${i}`}
              className="flex cursor-pointer items-center justify-between rounded bg-red-50 px-2 py-1 text-xs hover:bg-red-100"
              onClick={() => handleClick(level.price)}
            >
              <span>{level.price.toFixed(4)}</span>
              <span className="text-gray-600">{level.total.toFixed(2)}</span>
            </div>
          ))}
          {asks.length === 0 && <div className="text-xs text-gray-500">No asks</div>}
        </div>
      </div>
    </div>
  );
}