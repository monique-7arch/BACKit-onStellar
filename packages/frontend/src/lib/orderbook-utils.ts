export interface Order {
  id: string;
  price: number;
  size: number;
  side: 'buy' | 'sell';
  timestamp: number;
}

export interface OrderbookLevel {
  price: number;
  size: number;
  total: number;
  count: number;
}

export interface OrderbookState {
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  maxTotal: number;
}

export function buildOrderbook(orders: Order[], depth = 10): OrderbookState {
  const bids = orders.filter(o => o.side === 'buy');
  const asks = orders.filter(o => o.side === 'sell');

  const bidMap = new Map<number, number>();
  for (const b of bids) {
    bidMap.set(b.price, (bidMap.get(b.price) || 0) + b.size);
  }

  const askMap = new Map<number, number>();
  for (const a of asks) {
    askMap.set(a.price, (askMap.get(a.price) || 0) + a.size);
  }

  const bidLevels = Array.from(bidMap.entries())
    .sort((a, b) => b[0] - a[0])
    .slice(0, depth)
    .reduce((acc, [price, size], i) => {
      const total = i === 0 ? size : acc[i - 1].total + size;
      acc.push({ price, size, total, count: 1 });
      return acc;
    }, [] as OrderbookLevel[]);

  const askLevels = Array.from(askMap.entries())
    .sort((a, b) => a[0] - b[0])
    .slice(0, depth)
    .reduce((acc, [price, size], i) => {
      const total = i === 0 ? size : acc[i - 1].total + size;
      acc.push({ price, size, total, count: 1 });
      return acc;
    }, [] as OrderbookLevel[]);

  const maxTotal = Math.max(bidLevels[bidLevels.length - 1]?.total || 0, askLevels[askLevels.length - 1]?.total || 0, 0);

  return { bids: bidLevels, asks: askLevels, maxTotal };
}