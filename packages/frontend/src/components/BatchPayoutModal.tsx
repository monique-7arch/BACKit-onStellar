'use client';

import { Dialog, Transition } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { Fragment, useState } from 'react';

export interface PayoutRecipient {
  address: string;
  amount: number;
  memo?: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSubmit?: (recipients: PayoutRecipient[]) => void | Promise<void>;
  maxBatchSize?: number;
}

export default function BatchPayoutModal({ isOpen, onClose, onSubmit, maxBatchSize = 50 }: Props) {
  const [recipients, setRecipients] = useState<PayoutRecipient[]>([{ address: '', amount: 0 }]);

  const addRecipient = () => {
    if (recipients.length < maxBatchSize) {
      setRecipients(prev => [...prev, { address: '', amount: 0 }]);
    }
  };

  const removeRecipient = (index: number) => {
    setRecipients(prev => prev.filter((_, i) => i !== index));
  };

  const updateRecipient = (index: number, field: keyof PayoutRecipient, value: any) => {
    setRecipients(prev => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  };

  const total = recipients.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);

  const handleSubmit = async () => {
    if (onSubmit) {
      await onSubmit(recipients.filter(r => r.address.trim()));
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
    enterFrom: 'translate-y-full sm:translate-x-full',
    enterTo: 'translate-y-0 sm:translate-x-0',
    leave: 'transform transition ease-in-out duration-300',
    leaveFrom: 'translate-y-0 sm:translate-x-0',
    leaveTo: 'translate-y-full sm:translate-x-full',
  };

  return (
    <Transition.Root show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onClose}>
        <Transition.Child as={Fragment} {...fade}>
          <div className="fixed inset-0 bg-gray-500 bg-opacity-75" />
        </Transition.Child>
        <div className="fixed inset-0 overflow-hidden">
          <div className="absolute inset-0 overflow-hidden">
            <div className="pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-10">
              <Transition.Child as={Fragment} {...slide}>
                <Dialog.Panel className="pointer-events-auto w-screen max-w-lg">
                  <div className="flex h-full flex-col overflow-y-scroll bg-white shadow-xl">
                    <div className="bg-blue-600 px-4 py-6 sm:px-6">
                      <div className="flex items-center justify-between">
                        <Dialog.Title className="text-base font-semibold leading-6 text-white">Batch Payout</Dialog.Title>
                        <button onClick={onClose} className="text-white hover:text-gray-200">
                          <XMarkIcon className="h-6 w-6" />
                        </button>
                      </div>
                    </div>
                    <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">
                      <div className="space-y-4">
                        {recipients.map((r, i) => (
                          <div key={i} className="rounded border border-gray-200 p-3">
                            <div className="mb-2 flex justify-between">
                              <span className="text-sm font-medium">Recipient {i + 1}</span>
                              {recipients.length > 1 && (
                                <button onClick={() => removeRecipient(i)} className="text-xs text-red-600">Remove</button>
                              )}
                            </div>
                            <div className="space-y-2">
                              <input value={r.address} onChange={e => updateRecipient(i, 'address', e.target.value)} placeholder="Stellar address" className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
                              <input type="number" value={r.amount} onChange={e => updateRecipient(i, 'amount', parseFloat(e.target.value) || 0)} placeholder="Amount" className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
                              <input value={r.memo || ''} onChange={e => updateRecipient(i, 'memo', e.target.value)} placeholder="Memo (optional)" className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
                            </div>
                          </div>
                        ))}
                        <button onClick={addRecipient} disabled={recipients.length >= maxBatchSize} className="w-full rounded border border-dashed border-gray-300 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">Add Recipient</button>
                      </div>
                    </div>
                    <div className="border-t border-gray-200 px-4 py-4 sm:px-6">
                      <div className="mb-2 flex justify-between text-sm">
                        <span>Total</span>
                        <span className="font-semibold">{total.toFixed(2)}</span>
                      </div>
                      <button onClick={handleSubmit} className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">Submit Batch Payout</button>
                    </div>
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