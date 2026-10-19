'use client';

import { Dialog, Transition } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { Fragment, useState } from 'react';

export interface SearchFilters {
  query: string;
  category: string;
  status: string;
  minAmount?: number;
  maxAmount?: number;
  dateFrom?: string;
  dateTo?: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSearch?: (filters: SearchFilters) => void;
  categories?: string[];
}

export default function AdvancedSearchModal({ isOpen, onClose, onSearch, categories = [] }: Props) {
  const [filters, setFilters] = useState<SearchFilters>({
    query: '',
    category: '',
    status: '',
  });

  const handleChange = (field: keyof SearchFilters, value: any) => {
    setFilters(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = () => {
    if (onSearch) {
      onSearch(filters);
    }
    onClose();
  };

  const handleReset = () => {
    setFilters({ query: '', category: '', status: '' });
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
    enterFrom: 'translate-y-full sm:translate-y-0 sm:scale-95',
    enterTo: 'translate-y-0 sm:scale-100',
    leave: 'transform transition ease-in-out duration-300',
    leaveFrom: 'translate-y-0 sm:scale-100',
    leaveTo: 'translate-y-full sm:translate-y-0 sm:scale-95',
  };

  return (
    <Transition.Root show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onClose}>
        <Transition.Child as={Fragment} {...fade}>
          <div className="fixed inset-0 bg-gray-500 bg-opacity-75" />
        </Transition.Child>
        <div className="fixed inset-0 z-10 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4 text-center sm:p-0">
            <Transition.Child as={Fragment} {...slide}>
              <Dialog.Panel className="relative w-full transform overflow-hidden rounded-lg bg-white px-4 pb-4 pt-5 text-left shadow-xl transition-all sm:my-8 sm:w-full sm:max-w-lg sm:p-6">
                <div className="absolute right-0 top-0 pr-4 pt-4">
                  <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
                    <XMarkIcon className="h-6 w-6" />
                  </button>
                </div>
                <div className="sm:flex sm:items-start">
                  <div className="mt-3 w-full text-center sm:mt-0 sm:text-left">
                    <Dialog.Title className="text-lg font-semibold leading-6 text-gray-900">Advanced Search</Dialog.Title>
                    <div className="mt-4 space-y-4">
                      <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Query</label>
                        <input value={filters.query} onChange={e => handleChange('query', e.target.value)} className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Category</label>
                        <select value={filters.category} onChange={e => handleChange('category', e.target.value)} className="w-full rounded border border-gray-300 px-3 py-2 text-sm">
                          <option value="">All</option>
                          {categories.map(c => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Status</label>
                        <select value={filters.status} onChange={e => handleChange('status', e.target.value)} className="w-full rounded border border-gray-300 px-3 py-2 text-sm">
                          <option value="">All</option>
                          <option value="active">Active</option>
                          <option value="resolved">Resolved</option>
                          <option value="closed">Closed</option>
                        </select>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="mb-1 block text-sm font-medium text-gray-700">Min Amount</label>
                          <input type="number" value={filters.minAmount || ''} onChange={e => handleChange('minAmount', parseFloat(e.target.value) || undefined)} className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
                        </div>
                        <div>
                          <label className="mb-1 block text-sm font-medium text-gray-700">Max Amount</label>
                          <input type="number" value={filters.maxAmount || ''} onChange={e => handleChange('maxAmount', parseFloat(e.target.value) || undefined)} className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="mt-5 flex gap-2 sm:mt-4 sm:flex-row-reverse">
                  <button onClick={handleSubmit} className="inline-flex w-full justify-center rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 sm:w-auto">Search</button>
                  <button onClick={handleReset} className="inline-flex w-full justify-center rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 sm:w-auto">Reset</button>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition.Root>
  );
}