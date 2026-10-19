import { Injectable, Logger } from '@nestjs/common';

export interface PriceSource {
  name: string;
  url?: string;
  symbol: string;
}

export interface PriceData {
  symbol: string;
  price: number;
  timestamp: number;
  source: string;
}

@Injectable()
export class PriceIngestionService {
  private readonly logger = new Logger(PriceIngestionService.name);
  private prices: Map<string, PriceData> = new Map();

  ingestPrice(
    symbol: string,
    price: number,
    source: string,
  ): Promise<PriceData> {
    const data: PriceData = {
      symbol,
      price,
      timestamp: Date.now(),
      source,
    };
    this.prices.set(`${symbol}:${source}`, data);
    this.logger.log(`Ingested ${symbol}=${price} from ${source}`);
    return Promise.resolve(data);
  }

  getLatestPrice(symbol: string): PriceData | null {
    const entries = Array.from(this.prices.values()).filter(
      (p) => p.symbol === symbol,
    );
    if (entries.length === 0) return null;
    return entries.sort((a, b) => b.timestamp - a.timestamp)[0];
  }

  getAllPrices(): PriceData[] {
    return Array.from(this.prices.values());
  }

  fetchFromSource(source: PriceSource): Promise<PriceData | null> {
    this.logger.log(`Fetching price for ${source.symbol} from ${source.name}`);
    return Promise.resolve(null);
  }
}
