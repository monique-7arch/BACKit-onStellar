import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hostname } from 'os';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import Redlock, { Lock } from 'redlock';

export interface IndexerLeaseOptions {
  redisUrl: string;
  key: string;
  /** Lease time to live. The acceptance target is a 10 second lease. */
  ttlMs: number;
  /** How often the leader renews and a standby tries to acquire. */
  tickMs: number;
  nodeId: string;
  /** Single-process development: skip Redis and always act as leader. */
  disabled: boolean;
}

export interface LeaseStatus {
  nodeId: string;
  isLeader: boolean;
  leaseDisabled: boolean;
  /** Epoch ms when this node's lease lapses, or null when not leader. */
  expiresAt: number | null;
  acquiredAt: number | null;
  lastRenewedAt: number | null;
  transitions: number;
  lastError: string | null;
}

export interface LeaseCluster {
  redis: 'connected' | 'unreachable';
  /** Node id of the current holder, when known. */
  holder: string | null;
  /** Remaining lease time in Redis, or null when no one holds it. */
  ttlRemainingMs: number | null;
}

export function loadLeaseOptions(
  config: Pick<ConfigService, 'get'>,
): IndexerLeaseOptions {
  const num = (name: string, fallback: number) => {
    const raw = config.get<string>(name);
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    redisUrl: config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
    key: config.get<string>('INDEXER_LEASE_KEY') ?? 'backit:indexer:lease',
    ttlMs: num('INDEXER_LEASE_TTL_MS', 10_000),
    tickMs: num('INDEXER_LEASE_TICK_MS', 2_000),
    nodeId:
      config.get<string>('INDEXER_NODE_ID') ??
      `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`,
    disabled: config.get<string>('INDEXER_LEASE_DISABLED') === 'true',
  };
}

/**
 * Cluster-wide single-leader lease for the indexer, built on Redlock.
 *
 * Behaviour
 *   - Exactly one node holds the lock and is `isLeader()`. Others are standby
 *     and try to acquire every `tickMs`.
 *   - The leader renews every `tickMs` with a fresh `ttlMs`. If the leader
 *     dies, its key expires and a standby takes over within roughly
 *     `ttlMs + tickMs` (12 s with the defaults, inside the 15 s target).
 *   - A clean shutdown releases the lock, so a standby takes over on its next
 *     tick (about `tickMs`) instead of waiting for expiry.
 *
 * Safety
 *   - `isLeader()` is also false once the locally known expiry has passed, so
 *     a process that was paused (GC, SIGSTOP, VM stall) stops acting as
 *     leader even if it never got to run a renewal.
 *   - Any failed renewal demotes the node immediately. A needless demotion is
 *     cheap (it re-acquires next tick); two leaders is not.
 *   - A lease cannot rule out a leader that stalls between its check and its
 *     write. That is why ingestion is also idempotent (unique event key) and
 *     checkpoints only ever move forward.
 */
@Injectable()
export class IndexerLeaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IndexerLeaseService.name);
  private readonly options: IndexerLeaseOptions;

  private redis: Redis | null = null;
  private redlock: Redlock | null = null;
  private lock: Lock | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  private acquiredAt: number | null = null;
  private lastRenewedAt: number | null = null;
  private transitions = 0;
  private lastError: string | null = null;
  private lastRedisErrorLogAt = 0;

  constructor(config: ConfigService) {
    this.options = loadLeaseOptions(config);
  }

  get nodeId(): string {
    return this.options.nodeId;
  }

  async onModuleInit(): Promise<void> {
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async start(): Promise<void> {
    if (this.options.disabled) {
      this.logger.warn({
        msg: 'indexer_lease.disabled',
        nodeId: this.nodeId,
        note: 'INDEXER_LEASE_DISABLED=true, this node always acts as leader. Never use with more than one replica.',
      });
      return;
    }

    this.stopped = false;
    this.redis = new Redis(this.options.redisUrl, {
      // Fail fast instead of queueing commands while Redis is down, so a
      // renewal that cannot reach Redis demotes the node quickly.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      retryStrategy: (times) => Math.min(times * 200, 2_000),
    });
    this.redis.on('error', (err) => this.logRedisError(err));

    this.redlock = new Redlock([this.redis], {
      retryCount: 0, // one attempt per tick, the tick itself is the retry
      driftFactor: 0.01,
    });
    // Redlock emits per-client errors here; they are surfaced via lastError.
    this.redlock.on('error', () => undefined);

    // With the offline queue disabled, a command sent before the socket is
    // ready fails at once. Wait (bounded) so the first acquire can succeed.
    await this.waitUntilReady(this.redis, 3_000);

    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.tickMs);
    this.timer.unref?.();
  }

  private waitUntilReady(redis: Redis, timeoutMs: number): Promise<void> {
    if (redis.status === 'ready') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        redis.off('ready', done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      redis.once('ready', done);
    });
  }

  /** Release the lease (if held) and disconnect. Enables instant failover. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;

    const lock = this.lock;
    this.lock = null;
    if (lock) {
      try {
        await this.redis?.del(this.holderKey);
        await lock.release();
        this.logger.log({ msg: 'indexer_lease.released', nodeId: this.nodeId });
      } catch (err) {
        this.logger.warn({
          msg: 'indexer_lease.release_failed',
          nodeId: this.nodeId,
          error: (err as Error).message,
        });
      }
    }
    await this.disconnect();
  }

  /**
   * Test support: behave like a crashed process. Stops renewing and drops the
   * connection WITHOUT releasing, so the key must expire naturally.
   */
  async crashForTesting(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.lock = null;
    await this.disconnect();
  }

  private async disconnect(): Promise<void> {
    const redis = this.redis;
    this.redis = null;
    this.redlock = null;
    if (redis) {
      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
    }
  }

  isLeader(): boolean {
    if (this.options.disabled) return true;
    return this.lock !== null && this.lock.expiration > Date.now();
  }

  getStatus(): LeaseStatus {
    const leader = this.isLeader();
    return {
      nodeId: this.nodeId,
      isLeader: leader,
      leaseDisabled: this.options.disabled,
      expiresAt: leader && this.lock ? this.lock.expiration : null,
      acquiredAt: this.acquiredAt,
      lastRenewedAt: this.lastRenewedAt,
      transitions: this.transitions,
      lastError: this.lastError,
    };
  }

  /** What Redis says about the lease right now (for /health/indexer). */
  async getCluster(): Promise<LeaseCluster> {
    if (this.options.disabled || !this.redis) {
      return {
        redis: this.options.disabled ? 'connected' : 'unreachable',
        holder: this.options.disabled ? this.nodeId : null,
        ttlRemainingMs: null,
      };
    }
    try {
      const [holder, pttl] = await Promise.all([
        this.redis.get(this.holderKey),
        this.redis.pttl(this.options.key),
      ]);
      return {
        redis: 'connected',
        holder,
        ttlRemainingMs: pttl > 0 ? pttl : null,
      };
    } catch {
      return { redis: 'unreachable', holder: null, ttlRemainingMs: null };
    }
  }

  private get holderKey(): string {
    return `${this.options.key}:holder`;
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped || !this.redlock) return;
    this.ticking = true;
    try {
      if (this.lock) {
        await this.renew();
      } else {
        await this.tryAcquire();
      }
    } finally {
      this.ticking = false;
    }
  }

  private async renew(): Promise<void> {
    try {
      this.lock = await this.lock!.extend(this.options.ttlMs);
      this.lastRenewedAt = Date.now();
      this.lastError = null;
      void this.publishHolder();
    } catch (err) {
      // Demote immediately. See the class comment for why.
      this.lock = null;
      this.transitions++;
      this.lastError = (err as Error).message;
      this.logger.error({
        msg: 'indexer_lease.lost',
        nodeId: this.nodeId,
        error: this.lastError,
      });
    }
  }

  private async tryAcquire(): Promise<void> {
    try {
      this.lock = await this.redlock!.acquire(
        [this.options.key],
        this.options.ttlMs,
      );
      this.acquiredAt = Date.now();
      this.lastRenewedAt = this.acquiredAt;
      this.lastError = null;
      this.transitions++;
      this.logger.log({
        msg: 'indexer_lease.acquired',
        nodeId: this.nodeId,
        ttlMs: this.options.ttlMs,
      });
      void this.publishHolder();
    } catch (err) {
      // Normal for a standby: someone else holds it.
      this.lastError = (err as Error).message;
    }
  }

  /** Best effort: lets /health/indexer show WHO leads. Not used for safety. */
  private async publishHolder(): Promise<void> {
    try {
      await this.redis?.set(
        this.holderKey,
        this.nodeId,
        'PX',
        this.options.ttlMs,
      );
    } catch {
      // informational only
    }
  }

  private logRedisError(err: Error): void {
    const now = Date.now();
    if (now - this.lastRedisErrorLogAt < 10_000) return;
    this.lastRedisErrorLogAt = now;
    this.logger.error({
      msg: 'indexer_lease.redis_error',
      nodeId: this.nodeId,
      error: err.message,
    });
  }
}
