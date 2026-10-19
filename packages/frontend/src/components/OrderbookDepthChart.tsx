'use client';

import { useState } from 'react';
import { type OrderbookState } from '@/lib/orderbook-utils';
import OrderLadder from './OrderLadder';

interface Props {
  orderbook: OrderbookState;
  onLimitOrder?: (price: number, size: number, side: 'buy' | 'sell') => void;
  onMarketOrder?: (size: number, side: 'buy' | 'sell') => void;
}

export default function OrderbookDepthChart({ orderbook, onLimitOrder, onMarketOrder }: Props) {
  const [price, setPrice] = useState<string>('');
  const [size, setSize] = useState<string>('');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');

  const handlePriceClick = (p: number) => {
    setPrice(p.toFixed(4));
  };

  const handleLimitSubmit = () => {
    const p = parseFloat(price);
    const s = parseFloat(size);
    if (!isNaN(p) && !isNaN(s) && onLimitOrder) {
      onLimitOrder(p, s, side);
    }
  };

  const handleMarketSubmit = () => {
    const s = parseFloat(size);
    if (!isNaN(s) && onMarketOrder) {
      onMarketOrder(s, side);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <h3 className="mb-3 text-lg font-semibold text-gray-900">Orderbook</h3>
      <OrderLadder bids={orderbook.bids} asks={orderbook.asks} onPriceClick={handlePriceClick} />

      <div className="mt-4 space-y-3">
        <div className="flex gap-2">
          <button onClick={() => setSide('buy')} className={`flex-1 rounded px-3 py-2 text-sm font-medium ${side === 'buy' ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-700'}`}>
            Buy
          </button>
          <button onClick={() => setSide('sell')} className={`flex-1 rounded px-3 py-2 text-sm font-medium ${side === 'sell' ? 'bg-red-600 text-white' : 'bg-gray-100 text-gray-700'}`}>
            Sell
          </button>
        </div>

        <div>
          <label className="mb-1 block text-xs text-gray-600">Price</label>
          <input value={price} onChange={e => setPrice(e.target.value)} type="number" step="0.0001" className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
        </div>

        <div>
          <label className="mb-1 block text-xs text-gray-600">Size</label>
          <input value={size} onChange={e => setSize(e.target.value)} type="number" step="0.01" className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
        </div>

        <div className="flex gap-2">
          <button onClick={handleLimitSubmit} className="flex-1 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">Limit Order</button>
          <button onClick={handleMarketSubmit} className="flex-1 rounded bg-purple-600 px-3 py-2 text-sm font-medium text-white hover:bg-purple-700">Market Order</button>
        </div>
      </div>
    </div>
  );
}