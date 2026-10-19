'use client';

import { useEffect, useState } from 'react';
import { getDutchAuctionState, type DutchAuctionParams } from '@/lib/dutch-auction-utils';

interface Props {
  params: DutchAuctionParams;
  onBid?: (price: number) => void | Promise<void>;
  showBidButton?: boolean;
}

export default function DutchAuctionVisualizer({ params, onBid, showBidButton = true }: Props) {
  const [currentTime, setCurrentTime] = useState<number>(Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const state = getDutchAuctionState(params, currentTime);
  const priceDeltaPerMin = params.duration > 0 ? ((params.initialPrice - params.floorPrice) / (params.duration / 60000)) : 0;

  const handleBid = async () => {
    if (onBid) {
      await onBid(state.currentPrice);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <h3 className="mb-3 text-lg font-semibold text-gray-900">Dutch Auction</h3>
      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-gray-600">Current Price</span>
          <span className="font-semibold text-blue-600">${state.currentPrice.toFixed(4)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-600">Floor</span>
          <span className="text-gray-600">${params.floorPrice.toFixed(4)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-600">Initial</span>
          <span className="text-gray-600">${params.initialPrice.toFixed(4)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-600">Progress</span>
          <span className="text-gray-600">{(state.progress * 100).toFixed(1)}%</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-600">Remaining</span>
          <span className="text-gray-600">{Math.max(0, Math.floor(state.remaining / 1000))}s</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-600">Price Δ/min</span>
          <span className="text-gray-600">{priceDeltaPerMin > 0 ? priceDeltaPerMin.toFixed(4) : 'N/A'}</span>
        </div>
      </div>
      {showBidButton && !state.isEnded && (
        <button
          onClick={handleBid}
          className="mt-4 w-full rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
        >
          Bid at ${state.currentPrice.toFixed(4)}
        </button>
      )}
      {state.isEnded && <div className="mt-4 rounded-md bg-gray-100 p-2 text-center text-sm text-gray-600">Auction ended</div>}
    </div>
  );
}