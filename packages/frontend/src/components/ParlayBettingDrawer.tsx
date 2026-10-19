'use client';

import { Dialog, Transition } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { Fragment, useState, useMemo } from 'react';
import { calculateParlay, type ParlayLeg } from '@/lib/parlay-calc';

interface MarketOption {
  marketId: string;
  name: string;
  odds: number;
  expiresAt?: number | string;
  maxStake?: number;
  available: boolean;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  markets: MarketOption[];
  onSubmit?: (legs: ParlayLeg[], stake: number) => void | Promise<void>;
}

export default function ParlayBettingDrawer({ isOpen, onClose, markets, onSubmit }: Props) {
  const [legs, setLegs] = useState<ParlayLeg[]>([]);
  const [stake, setStake] = useState<number>(100);

  const availableMarkets = markets.filter(m => m.available && !legs.find(l => l.marketId === m.marketId));

  const calculation = useMemo(() => {
    return calculateParlay(legs, stake);
  }, [legs, stake]);

  const addLeg = (market: MarketOption, outcome: 'YES' | 'NO') => {
    setLegs(prev => [...prev, { marketId: market.marketId, outcome, odds: market.odds, expiresAt: market.expiresAt, maxStake: market.maxStake }]);
  };

  const removeLeg = (index: number) => {
    setLegs(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    if (calculation.isValid && onSubmit) {
      await onSubmit(legs, stake);
    }
  };

  const fade = {
    enter: 'ease-in-out duration-300',
    enterFrom: 'opacity-0',
    enterTo: 'opacity-100',
    leave: 'ease-in-out duration-300',
    leaveFrom: 'opacity-100',
    leaveTo: 'opacity-0',
  };

  const slide = {
    enter: 'transform transition ease-in-out duration-300',
    enterFrom: 'translate-y-full',
    enterTo: 'translate-y-0',
    leave: 'transform transition ease-in-out duration-300',
    leaveFrom: 'translate-y-0',
    leaveTo: 'translate-y-full',
  };

  return (
    <Transition.Root show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onClose}>
        <Transition.Child as={Fragment} {...fade}>
          <div className="fixed inset-0 bg-gray-500 bg-opacity-75" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-hidden">
          <div className="absolute inset-0 overflow-hidden">
            <div className="pointer-events-none fixed inset-x-0 bottom-0 flex max-h-[85vh] sm:inset-y-0 sm:left-auto sm:inset-x-auto sm:right-0 sm:w-full sm:max-w-md">
              <Transition.Child as={Fragment} {...slide}>
                <Dialog.Panel className="pointer-events-auto relative w-full overflow-y-auto bg-white shadow-xl sm:rounded-l-xl">
                  <div className="sticky top-0 flex items-center justify-between border-b bg-white px-4 py-3 sm:px-6">
                    <Dialog.Title className="text-lg font-semibold text-gray-900">Parlay Builder</Dialog.Title>
                    <button type="button" className="text-gray-400 hover:text-gray-500" onClick={onClose}>
                      <span className="sr-only">Close panel</span>
                      <XMarkIcon className="h-6 w-6" />
                    </button>
                  </div>

                  <div className="px-4 py-4 sm:px-6">
                    <div className="mb-6">
                      <h3 className="mb-2 text-sm font-medium text-gray-700">Selected Legs ({legs.length}/10)</h3>
                      {legs.length === 0 && <p className="text-sm text-gray-500">Add legs from available markets below</p>}
                      <div className="space-y-2">
                        {legs.map((leg, i) => (
                          <div key={`${leg.marketId}-${i}`} className="flex items-center justify-between rounded-md border border-gray-200 bg-gray-50 p-2 text-xs">
                            <div>
                              <div className="font-medium">{leg.marketId}</div>
                              <div className="text-gray-600">{leg.outcome} @ {leg.odds.toFixed(2)}</div>
                            </div>
                            <button onClick={() => removeLeg(i)} className="text-red-600 hover:text-red-700">Remove</button>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="mb-6">
                      <h3 className="mb-2 text-sm font-medium text-gray-700">Available Markets</h3>
                      <div className="space-y-2">
                        {availableMarkets.length === 0 ? (
                          <p className="text-sm text-gray-500">No more markets available</p>
                        ) : (
                          availableMarkets.map(m => (
                            <div key={m.marketId} className="flex items-center justify-between rounded-md border border-gray-200 p-2 text-xs">
                              <div>
                                <div className="font-medium">{m.name}</div>
                                <div className="text-gray-600">Odds: {m.odds.toFixed(2)}</div>
                              </div>
                              <div className="flex gap-1">
                                <button onClick={() => addLeg(m, 'YES')} className="rounded bg-green-100 px-2 py-1 text-green-700 hover:bg-green-200">YES</button>
                                <button onClick={() => addLeg(m, 'NO')} className="rounded bg-red-100 px-2 py-1 text-red-700 hover:bg-red-200">NO</button>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    <div className="mb-6 rounded-md bg-gray-50 p-4">
                      <div className="mb-3">
                        <label className="mb-1 block text-xs font-medium text-gray-700">Stake Amount</label>
                        <input
                          type="number"
                          value={stake}
                          onChange={e => setStake(Number(e.target.value))}
                          className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                          min="0"
                        />
                      </div>
                      <div className="space-y-1 text-xs">
                        <div className="flex justify-between">
                          <span className="text-gray-600">Multiplier</span>
                          <span className="font-medium">{calculation.multiplier.toFixed(2)}x</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-600">Potential Payout</span>
                          <span className="font-medium">{calculation.potentialPayout.toFixed(2)}</span>
                        </div>
                        {calculation.errors.map((err, i) => (
                          <div key={i} className="text-red-600">{err}</div>
                        ))}
                      </div>
                    </div>

                    <button
                      onClick={handleSubmit}
                      disabled={!calculation.isValid || legs.length < 2}
                      className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                    >
                      Place Parlay {calculation.isValid && legs.length >= 2 ? `(${calculation.potentialPayout.toFixed(2)})` : ''}
                    </button>
                  </div>
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
        </div>
      </Dialog>
    </Transition.Root>
  );
}