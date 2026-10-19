import { Injectable, Logger } from '@nestjs/common';

export interface PricePoint {
  price: number;
  timestamp: number;
}

@Injectable()
export class TwapFilterService {
  private readonly logger = new Logger(TwapFilterService.name);

  calculateTwap(prices: PricePoint[], windowMs: number): number {
    if (prices.length === 0) return 0;
    const now = Date.now();
    const validPrices = prices.filter((p) => now - p.timestamp <= windowMs);
    if (validPrices.length === 0) return prices[prices.length - 1]?.price || 0;
    const sum = validPrices.reduce((acc, p) => acc + p.price, 0);
    return sum / validPrices.length;
  }

  filterOutliers(prices: number[], threshold: number = 3): number[] {
    if (prices.length === 0) return prices;
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance =
      prices.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / prices.length;
    const stdDev = Math.sqrt(variance);
    const upper = mean + threshold * stdDev;
    const lower = mean - threshold * stdDev;
    return prices.filter((p) => p >= lower && p <= upper);
  }
}
