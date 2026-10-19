import { useEffect, useState } from 'react';
import { buildOrderbook, type Order, type OrderbookState } from '@/lib/orderbook-utils';

interface UseOrderbookLiveOptions {
  initialOrders?: Order[];
  updateInterval?: number;
}

export function useOrderbookLive({ initialOrders = [], updateInterval = 500 }: UseOrderbookLiveOptions = {}) {
  const [orders, setOrders] = useState<Order[]>(initialOrders);
  const [orderbook, setOrderbook] = useState<OrderbookState>(() => buildOrderbook(initialOrders));

  useEffect(() => {
    setOrderbook(buildOrderbook(orders));
  }, [orders]);

  useEffect(() => {
    if (updateInterval <= 0) return;
    const interval = setInterval(() => {
      setOrders(prev => prev);
    }, updateInterval);
    return () => clearInterval(interval);
  }, [updateInterval]);

  const addOrder = (order: Order) => {
    setOrders(prev => [...prev, order]);
  };

  const cancelOrder = (orderId: string) => {
    setOrders(prev => prev.filter(o => o.id !== orderId));
  };

  const clear = () => {
    setOrders([]);
  };

  return { orders, orderbook, addOrder, cancelOrder, clear, setOrders };
}

export default useOrderbookLive;