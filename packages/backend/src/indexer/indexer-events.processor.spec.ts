/* eslint-disable
  @typescript-eslint/require-await,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-misused-promises
  -- test doubles, mocked async functions and raw SQL rows are intentionally loosely typed */
import { Job } from 'bullmq';
import { IndexerEventsProcessor } from './indexer-events.processor';
import { IndexerEventJob } from '../admin/indexer-dlq.service';

const job = (attemptsMade: number, attempts = 5) =>
  ({
    attemptsMade,
    opts: { attempts },
    data: {
      event: { id: 'evt-1' },
      stage: 'persist',
      firstError: 'x',
      redrive: 0,
    },
  }) as unknown as Job<IndexerEventJob>;

describe('IndexerEventsProcessor', () => {
  let indexer: { ingestBatch: jest.Mock };
  let dlq: { capture: jest.Mock };
  let processor: IndexerEventsProcessor;

  beforeEach(() => {
    indexer = {
      ingestBatch: jest.fn(async () => ({
        received: 1,
        inserted: 1,
        duplicates: 0,
        ignored: 0,
        failed: [],
      })),
    };
    dlq = { capture: jest.fn(async () => undefined) };
    processor = new IndexerEventsProcessor(indexer as never, dlq as never);
  });

  it('ingests without re-reporting failures (no re-queue loop)', async () => {
    const out = await processor.process(job(0));
    expect(indexer.ingestBatch).toHaveBeenCalledWith(
      [{ id: 'evt-1' }],
      undefined,
      { reportFailures: false },
    );
    expect(out).toEqual({ inserted: 1, duplicates: 0, ignored: 0 });
  });

  it('throws the underlying error so BullMQ retries', async () => {
    indexer.ingestBatch.mockResolvedValue({
      received: 1,
      inserted: 0,
      duplicates: 0,
      ignored: 0,
      failed: [{ error: new Error('conflict') }],
    });
    await expect(processor.process(job(0))).rejects.toThrow('conflict');
  });

  it('does not dead-letter while attempts remain', async () => {
    await processor.onFailed(job(3), new Error('x'));
    expect(dlq.capture).not.toHaveBeenCalled();
  });

  it('dead-letters on the final attempt', async () => {
    const err = new Error('final');
    const j = job(5);
    await processor.onFailed(j, err);
    expect(dlq.capture).toHaveBeenCalledWith(j, err);
  });

  it('survives a failing DLQ write and an undefined job', async () => {
    dlq.capture.mockRejectedValue(new Error('redis down'));
    await expect(
      processor.onFailed(job(5), new Error('x')),
    ).resolves.toBeUndefined();
    await expect(
      processor.onFailed(undefined, new Error('x')),
    ).resolves.toBeUndefined();
  });
});
