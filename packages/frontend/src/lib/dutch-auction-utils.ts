export interface DutchAuctionParams {
  initialPrice: number;
  floorPrice: number;
  startTime: number;
  endTime: number;
  duration: number;
}

export interface DutchAuctionState {
  currentPrice: number;
  elapsed: number;
  remaining: number;
  progress: number;
  isEnded: boolean;
}

export function calculateDutchAuctionPrice(params: DutchAuctionParams, currentTime: number): number {
  const { initialPrice, floorPrice, startTime, endTime, duration } = params;
  if (currentTime >= endTime) {
    return floorPrice;
  }
  if (currentTime <= startTime) {
    return initialPrice;
  }
  const elapsed = currentTime - startTime;
  const progress = Math.min(elapsed / duration, 1);
  const price = initialPrice - progress * (initialPrice - floorPrice);
  return Math.max(price, floorPrice);
}

export function getDutchAuctionState(params: DutchAuctionParams, currentTime: number): DutchAuctionState {
  const elapsed = Math.max(0, currentTime - params.startTime);
  const remaining = Math.max(0, params.endTime - currentTime);
  const duration = params.duration;
  const progress = duration > 0 ? Math.min(elapsed / duration, 1) : 1;
  const currentPrice = calculateDutchAuctionPrice(params, currentTime);
  const isEnded = currentTime >= params.endTime;
  return { currentPrice, elapsed, remaining, progress, isEnded };
}