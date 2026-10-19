/* eslint-disable
  @typescript-eslint/require-await,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-misused-promises
  -- test doubles, mocked async functions and raw SQL rows are intentionally loosely typed */
import { MicroBatcher } from './micro-batcher';

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('MicroBatcher', () => {
  afterEach(() => jest.useRealTimers());

  it('flushes when maxItems is reached, without waiting for the timer', async () => {
    const batches: number[][] = [];
    const b = new MicroBatcher<number>({
      maxItems: 3,
      maxLatencyMs: 60_000,
      flush: async (items) => {
        batches.push(items);
      },
    });
    [1, 2, 3, 4, 5, 6, 7].forEach((n) => b.push(n));
    await tick();
    expect(batches).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    await b.close();
    expect(batches).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });

  it('flushes a partial batch after maxLatencyMs', async () => {
    jest.useFakeTimers();
    const batches: number[][] = [];
    const b = new MicroBatcher<number>({
      maxItems: 5000,
      maxLatencyMs: 500,
      flush: async (items) => {
        batches.push(items);
      },
    });
    b.push(1);
    b.push(2);
    await jest.advanceTimersByTimeAsync(499);
    expect(batches).toEqual([]);
    await jest.advanceTimersByTimeAsync(2);
    expect(batches).toEqual([[1, 2]]);
    // a later item starts a fresh latency window
    b.push(3);
    await jest.advanceTimersByTimeAsync(500);
    expect(batches).toEqual([[1, 2], [3]]);
    await b.close();
  });

  it('runs flushes one at a time, in order', async () => {
    let running = 0;
    let maxRunning = 0;
    const order: number[] = [];
    const b = new MicroBatcher<number>({
      maxItems: 2,
      maxLatencyMs: 60_000,
      maxPendingItems: 1_000,
      flush: async (items) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 5));
        order.push(...items);
        running--;
      },
    });
    for (let i = 0; i < 10; i++) b.push(i);
    await b.close();
    expect(maxRunning).toBe(1);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('applies backpressure so pending items stay bounded', async () => {
    let peak = 0;
    const b = new MicroBatcher<number>({
      maxItems: 10,
      maxLatencyMs: 60_000,
      maxPendingItems: 30,
      flush: async () => {
        await new Promise((r) => setTimeout(r, 2));
      },
    });
    for (let i = 0; i < 2_000; i++) {
      const wait = b.push(i);
      peak = Math.max(peak, b.pending);
      if (wait) await wait;
    }
    await b.close();
    expect(peak).toBeLessThanOrEqual(31);
    expect(b.stats().flushedItems).toBe(2_000);
    expect(b.pending).toBe(0);
  });

  it('retries a failing flush and succeeds, which is safe because loads are idempotent', async () => {
    let calls = 0;
    const b = new MicroBatcher<number>({
      maxItems: 2,
      maxLatencyMs: 60_000,
      retryDelayMs: 1,
      flush: async () => {
        if (++calls < 3) throw new Error('transient');
      },
    });
    b.push(1);
    b.push(2);
    await b.close();
    expect(calls).toBe(3);
    expect(b.stats()).toMatchObject({
      flushedBatches: 1,
      retries: 2,
      failedBatches: 0,
    });
  });

  it('never drops items of a batch that keeps failing: reports them and rethrows', async () => {
    const failed: number[][] = [];
    const b = new MicroBatcher<number>({
      maxItems: 2,
      maxLatencyMs: 60_000,
      retries: 1,
      retryDelayMs: 1,
      flush: async () => {
        throw new Error('db down');
      },
      onBatchFailed: (items) => {
        failed.push(items);
      },
    });
    b.push(1);
    b.push(2);
    await expect(b.close()).rejects.toThrow('db down');
    expect(failed).toEqual([[1, 2]]);
    expect(b.stats().failedBatches).toBe(1);
  });

  it('continues with later batches after one fails', async () => {
    const ok: number[][] = [];
    let first = true;
    const b = new MicroBatcher<number>({
      maxItems: 1,
      maxLatencyMs: 60_000,
      retries: 0,
      flush: async (items) => {
        if (first) {
          first = false;
          throw new Error('boom');
        }
        ok.push(items);
      },
    });
    b.push(1);
    b.push(2);
    await expect(b.flush()).rejects.toThrow('boom');
    expect(ok).toEqual([[2]]);
    await b.close();
  });

  it('leaves no timer behind and rejects pushes after close', async () => {
    jest.useFakeTimers();
    const b = new MicroBatcher<number>({
      maxItems: 100,
      maxLatencyMs: 500,
      flush: async () => undefined,
    });
    b.push(1);
    expect(jest.getTimerCount()).toBe(1);
    const closing = b.close();
    await jest.runAllTimersAsync();
    await closing;
    expect(jest.getTimerCount()).toBe(0);
    expect(() => b.push(2)).toThrow(/closed/);
  });

  it('does not retain flushed items (long run, bounded heap)', async () => {
    const b = new MicroBatcher<{ payload: string }>({
      maxItems: 5_000,
      maxLatencyMs: 500,
      flush: async () => undefined,
    });
    const gc = (global as { gc?: () => void }).gc;
    gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 400_000; i++) {
      const wait = b.push({ payload: 'x'.repeat(200) + i });
      if (wait) await wait;
    }
    await b.close();
    expect(b.pending).toBe(0);
    if (gc) {
      gc();
      const grown = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
      expect(grown).toBeLessThan(30);
    }
  }, 60_000);
});
