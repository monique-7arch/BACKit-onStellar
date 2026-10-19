/**
 * Size-or-latency micro batching for high-throughput loading (BE-007).
 *
 * Items are buffered and flushed when EITHER `maxItems` have accumulated OR
 * `maxLatencyMs` has passed since the first buffered item, whichever happens
 * first. That gives bulk-insert efficiency under load and bounded delay when
 * traffic is slow.
 *
 * Guarantees
 *   - Flushes run strictly one at a time, in order, so a slow database
 *     applies backpressure instead of piling up concurrent transactions.
 *   - `push` returns a promise only when the pending count is at or above
 *     `maxPendingItems`; awaiting it throttles a fast producer. Memory is
 *     therefore bounded by roughly `maxPendingItems` plus one batch.
 *   - A failing flush is retried (the loaders are idempotent, so a retry
 *     after a partial or ambiguous failure is safe). Items of a batch that
 *     still fails are handed to `onBatchFailed`, never silently dropped, and
 *     the error is rethrown by the next `flush()`/`close()`.
 *   - No timer outlives `close()`, and flushed items are released at once.
 */
export interface MicroBatcherOptions<T> {
  maxItems: number;
  maxLatencyMs: number;
  /** Backpressure threshold. Defaults to 4 batches. */
  maxPendingItems?: number;
  flush: (items: T[]) => Promise<void>;
  /** Extra attempts after the first failure. Default 3. */
  retries?: number;
  /** Base delay for exponential backoff between attempts. Default 100 ms. */
  retryDelayMs?: number;
  onBatchFailed?: (items: T[], error: Error) => void | Promise<void>;
}

export interface MicroBatcherStats {
  pending: number;
  flushedBatches: number;
  flushedItems: number;
  failedBatches: number;
  retries: number;
}

export class MicroBatcher<T> {
  private buffer: T[] = [];
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private inFlightItems = 0;
  private closed = false;
  private firstError: Error | null = null;
  private waiters: Array<() => void> = [];

  private flushedBatches = 0;
  private flushedItems = 0;
  private failedBatches = 0;
  private retryCount = 0;

  private readonly maxPending: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(private readonly options: MicroBatcherOptions<T>) {
    if (options.maxItems < 1) throw new Error('maxItems must be >= 1');
    if (options.maxLatencyMs < 1) throw new Error('maxLatencyMs must be >= 1');
    this.maxPending = options.maxPendingItems ?? options.maxItems * 4;
    this.retries = options.retries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 100;
  }

  get pending(): number {
    return this.buffer.length + this.inFlightItems;
  }

  stats(): MicroBatcherStats {
    return {
      pending: this.pending,
      flushedBatches: this.flushedBatches,
      flushedItems: this.flushedItems,
      failedBatches: this.failedBatches,
      retries: this.retryCount,
    };
  }

  /**
   * Buffer one item. If the batcher is saturated this returns a promise that
   * resolves once there is room again; await it to apply backpressure.
   */
  push(item: T): Promise<void> | undefined {
    if (this.closed) throw new Error('MicroBatcher is closed');
    this.buffer.push(item);

    if (this.buffer.length >= this.options.maxItems) {
      this.scheduleFlush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.scheduleFlush();
      }, this.options.maxLatencyMs);
    }

    if (this.pending >= this.maxPending) {
      return new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return undefined;
  }

  /** Flush everything buffered and wait for all in-flight work. */
  async flush(): Promise<void> {
    this.clearTimer();
    while (this.buffer.length > 0) this.scheduleFlush();
    await this.chain;
    this.throwFirstError();
  }

  /** Flush, stop accepting items and release the timer. */
  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.flush();
    } finally {
      this.clearTimer();
      this.release();
    }
  }

  private scheduleFlush(): void {
    this.clearTimer();
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.options.maxItems);
    this.inFlightItems += batch.length;
    this.chain = this.chain.then(() => this.run(batch));
    // Items left over after splice get their own latency timer.
    if (this.buffer.length > 0 && !this.timer && !this.closed) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.scheduleFlush();
      }, this.options.maxLatencyMs);
    }
  }

  private async run(batch: T[]): Promise<void> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        await this.options.flush(batch);
        this.flushedBatches++;
        this.flushedItems += batch.length;
        lastError = null;
        break;
      } catch (err) {
        lastError = err as Error;
        if (attempt < this.retries) {
          this.retryCount++;
          await new Promise((r) =>
            setTimeout(r, this.retryDelayMs * 2 ** attempt),
          );
        }
      }
    }

    if (lastError) {
      this.failedBatches++;
      this.firstError ??= lastError;
      try {
        await this.options.onBatchFailed?.(batch, lastError);
      } catch {
        // the failure hook must not break the flush chain
      }
    }

    this.inFlightItems -= batch.length;
    this.release();
  }

  private release(): void {
    if (this.pending < this.maxPending && this.waiters.length > 0) {
      const waiting = this.waiters;
      this.waiters = [];
      for (const resolve of waiting) resolve();
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private throwFirstError(): void {
    if (this.firstError) {
      const err = this.firstError;
      this.firstError = null;
      throw err;
    }
  }
}
