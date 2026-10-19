import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  ALL_METRICS,
  ALL_WINDOWS,
  LeaderboardMetric,
  MetricWindow,
  redisBoardKey,
} from './leaderboard-windows';

export interface RankPage {
  entries: { member: string; score: number; rank: number }[];
  total: number;
}

/**
 * Real-time multi-window leaderboards on Redis sorted sets (BE-030).
 * Atomic ZADD on stake/settlement; ZREVRANGE + ZREVRANK for queries.
 */
@Injectable()
export class RedisLeaderboardService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisLeaderboardService.name);
  private readonly redis: Redis;

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
    this.redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }

  /** Upsert score for a user in one board. */
  async setScore(
    metric: LeaderboardMetric,
    window: MetricWindow,
    member: string,
    score: number,
  ): Promise<void> {
    const key = redisBoardKey(metric, window);
    // Invert brier so lower Brier ranks higher (ZREVRANGE is high-to-low)
    const redisScore = metric === 'brier' ? -score : score;
    await this.redis.zadd(key, redisScore, member);
  }

  /** Atomic multi-metric update after settlement. */
  async onSettlement(update: {
    address: string;
    volumeDelta?: number;
    profitDelta?: number;
    brierScore?: number;
  }): Promise<void> {
    const pipe = this.redis.pipeline();
    for (const window of ALL_WINDOWS) {
      if (update.volumeDelta !== undefined) {
        pipe.zincrby(
          redisBoardKey('volume', window),
          update.volumeDelta,
          update.address,
        );
      }
      if (update.profitDelta !== undefined) {
        pipe.zincrby(
          redisBoardKey('profit', window),
          update.profitDelta,
          update.address,
        );
      }
      if (update.brierScore !== undefined) {
        pipe.zadd(
          redisBoardKey('brier', window),
          -update.brierScore,
          update.address,
        );
      }
    }
    await pipe.exec();
  }

  async getPage(
    metric: LeaderboardMetric,
    window: MetricWindow,
    offset = 0,
    limit = 50,
  ): Promise<RankPage> {
    const key = redisBoardKey(metric, window);
    const end = offset + limit - 1;
    const [raw, total] = await Promise.all([
      this.redis.zrevrange(key, offset, end, 'WITHSCORES'),
      this.redis.zcard(key),
    ]);
    const entries: RankPage['entries'] = [];
    for (let i = 0; i < raw.length; i += 2) {
      let score = Number(raw[i + 1]);
      if (metric === 'brier') score = -score;
      entries.push({
        member: raw[i],
        score,
        rank: offset + entries.length + 1,
      });
    }
    return { entries, total };
  }

  async getRank(
    metric: LeaderboardMetric,
    window: MetricWindow,
    member: string,
  ): Promise<{ rank: number | null; score: number | null }> {
    const key = redisBoardKey(metric, window);
    const [rank0, scoreRaw] = await Promise.all([
      this.redis.zrevrank(key, member),
      this.redis.zscore(key, member),
    ]);
    if (rank0 === null || scoreRaw === null) {
      return { rank: null, score: null };
    }
    let score = Number(scoreRaw);
    if (metric === 'brier') score = -score;
    return { rank: rank0 + 1, score };
  }

  /** Remove flagged (Sybil) accounts from all public boards. */
  async excludeMember(member: string): Promise<void> {
    const pipe = this.redis.pipeline();
    for (const metric of ALL_METRICS) {
      for (const window of ALL_WINDOWS) {
        pipe.zrem(redisBoardKey(metric, window), member);
      }
    }
    await pipe.exec();
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}
