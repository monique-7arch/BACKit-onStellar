/* eslint-disable
  @typescript-eslint/require-await,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-misused-promises
  -- test doubles, mocked async functions and raw SQL rows are intentionally loosely typed */
import { SorobanRpc } from '@stellar/stellar-sdk';
import { IndexerLeaseService } from './indexer-lease.service';
import { IndexerSyncService } from './indexer-sync.service';
import {
  CHECKPOINT_MULTI_CONTRACT,
  LedgerCheckpointService,
} from './ledger-checkpoint.service';
import {
  IngestResult,
  MultiContractIndexerService,
} from './multi-contract-indexer.service';

function ingestResult(over: Partial<IngestResult> = {}): IngestResult {
  return {
    received: 0,
    inserted: 0,
    duplicates: 0,
    ignored: 0,
    failed: [],
    ...over,
  };
}

describe('IndexerSyncService', () => {
  let leader: boolean;
  let checkpoint: number | null;
  let hasSink: boolean;
  let contracts: Map<string, string>;
  let multi: jest.Mocked<
    Pick<
      MultiContractIndexerService,
      'getContractMap' | 'fetchEventsSince' | 'ingestBatch' | 'hasFailureSink'
    >
  >;
  let checkpoints: { get: jest.Mock; advance: jest.Mock };
  let rpc: { getLatestLedger: jest.Mock };
  let service: IndexerSyncService;

  beforeEach(() => {
    leader = true;
    checkpoint = null;
    hasSink = true;
    contracts = new Map([['C1', 'lending']]);
    multi = {
      getContractMap: jest.fn(() => contracts),
      fetchEventsSince: jest.fn(async () => ({
        events: [],
        latestLedger: 500,
      })),
      ingestBatch: jest.fn(async () => ingestResult()),
      hasFailureSink: jest.fn(() => hasSink),
    } as never;
    checkpoints = {
      get: jest.fn(async () => checkpoint),
      advance: jest.fn(async (_n: string, l: number) => l),
    };
    rpc = { getLatestLedger: jest.fn(async () => ({ sequence: 500 })) };
    const lease = {
      isLeader: () => leader,
      nodeId: 'node-x',
    } as unknown as IndexerLeaseService;
    service = new IndexerSyncService(
      lease,
      checkpoints as unknown as LedgerCheckpointService,
      multi as unknown as MultiContractIndexerService,
      rpc as unknown as SorobanRpc.Server,
    );
    delete process.env.INDEXER_START_LEDGER;
  });

  it('does nothing at all on a standby node', async () => {
    leader = false;
    expect(await service.tick()).toEqual({ status: 'standby' });
    expect(rpc.getLatestLedger).not.toHaveBeenCalled();
    expect(checkpoints.get).not.toHaveBeenCalled();
    expect(multi.fetchEventsSince).not.toHaveBeenCalled();
  });

  it('skips quietly when no contract ids are configured', async () => {
    contracts = new Map();
    expect(await service.tick()).toEqual({ status: 'unconfigured' });
    expect(rpc.getLatestLedger).not.toHaveBeenCalled();
  });

  it('resumes at checkpoint + 1', async () => {
    checkpoint = 420;
    await service.tick();
    expect(multi.fetchEventsSince).toHaveBeenCalledWith(421);
  });

  it('on a first run starts at INDEXER_START_LEDGER, else at the current ledger', async () => {
    process.env.INDEXER_START_LEDGER = '250';
    await service.tick();
    expect(multi.fetchEventsSince).toHaveBeenLastCalledWith(250);
    delete process.env.INDEXER_START_LEDGER;
    await service.tick();
    expect(multi.fetchEventsSince).toHaveBeenLastCalledWith(500);
  });

  it('is a no-op when already caught up', async () => {
    checkpoint = 500;
    expect(await service.tick()).toEqual({
      status: 'caught_up',
      checkpoint: 500,
    });
    expect(multi.fetchEventsSince).not.toHaveBeenCalled();
  });

  it('advances the checkpoint only after the batch is ingested', async () => {
    checkpoint = 10;
    const order: string[] = [];
    multi.ingestBatch.mockImplementation(async () => {
      order.push('ingest');
      return ingestResult({ inserted: 3 });
    });
    checkpoints.advance.mockImplementation(async (_n, l) => {
      order.push('checkpoint');
      return l;
    });
    const out = await service.tick();
    expect(order).toEqual(['ingest', 'checkpoint']);
    expect(checkpoints.advance).toHaveBeenCalledWith(
      CHECKPOINT_MULTI_CONTRACT,
      500,
      'node-x',
    );
    expect(out).toMatchObject({
      status: 'synced',
      advanced: true,
      inserted: 3,
    });
  });

  it('holds the checkpoint when events failed and nothing durable owns them', async () => {
    checkpoint = 10;
    hasSink = false;
    multi.ingestBatch.mockResolvedValue(
      ingestResult({ failed: [{} as never] }),
    );
    const out = await service.tick();
    expect(checkpoints.advance).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      status: 'synced',
      advanced: false,
      checkpoint: 10,
    });
  });

  it('moves past failures once a dead-letter sink owns them', async () => {
    checkpoint = 10;
    hasSink = true;
    multi.ingestBatch.mockResolvedValue(
      ingestResult({ failed: [{} as never] }),
    );
    const out = await service.tick();
    expect(checkpoints.advance).toHaveBeenCalled();
    expect(out).toMatchObject({ advanced: true });
  });

  it('abandons the run and writes no checkpoint if the lease is lost mid-run', async () => {
    checkpoint = 10;
    multi.fetchEventsSince.mockImplementation(async () => {
      leader = false; // lease lapses while fetching
      return { events: [], latestLedger: 500, complete: true };
    });
    expect(await service.tick()).toEqual({ status: 'lease_lost' });
    expect(multi.ingestBatch).not.toHaveBeenCalled();
    expect(checkpoints.advance).not.toHaveBeenCalled();

    leader = true;
    multi.fetchEventsSince.mockResolvedValue({
      events: [],
      latestLedger: 500,
      complete: true,
    });
    multi.ingestBatch.mockImplementation(async () => {
      leader = false; // lapses while ingesting
      return ingestResult();
    });
    expect(await service.tick()).toEqual({ status: 'lease_lost' });
    expect(checkpoints.advance).not.toHaveBeenCalled();
  });

  it('never runs two syncs at once on the same node', async () => {
    checkpoint = 10;
    let release!: () => void;
    multi.fetchEventsSince.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ events: [], latestLedger: 500, complete: true });
        }),
    );
    const first = service.tick();
    await new Promise((r) => setImmediate(r));
    expect(await service.tick()).toEqual({ status: 'standby' });
    release();
    await first;
    expect(multi.fetchEventsSince).toHaveBeenCalledTimes(1);
  });

  it('scheduledTick swallows errors so the cron keeps running', async () => {
    rpc.getLatestLedger.mockRejectedValue(new Error('rpc down'));
    await expect(service.scheduledTick()).resolves.toBeUndefined();
  });

  it('does not skip unfetched events when the page cap cuts the fetch short', async () => {
    checkpoint = 10;
    const ev = (ledger: number) => ({ ledger }) as never;
    multi.fetchEventsSince.mockResolvedValueOnce({
      events: [ev(20), ev(30), ev(40)],
      latestLedger: 500,
      complete: false,
    });
    await service.tick();
    // the FIRST write stops just before the last event's ledger, not at 500
    expect(checkpoints.advance.mock.calls[0]).toEqual([
      CHECKPOINT_MULTI_CONTRACT,
      39,
      'node-x',
    ]);
  });

  it('keeps catching up in one run while there is more history', async () => {
    let stored = 10;
    checkpoints.get.mockImplementation(async () => stored);
    checkpoints.advance.mockImplementation(async (_n: string, l: number) => {
      stored = l;
      return l;
    });
    const ev = (ledger: number) => ({ ledger }) as never;
    multi.fetchEventsSince
      .mockResolvedValueOnce({
        events: [ev(100)],
        latestLedger: 500,
        complete: false,
      })
      .mockResolvedValueOnce({
        events: [ev(300)],
        latestLedger: 500,
        complete: false,
      })
      .mockResolvedValueOnce({
        events: [ev(450)],
        latestLedger: 500,
        complete: true,
      });
    const out = await service.tick();
    expect(multi.fetchEventsSince.mock.calls.map((c) => c[0])).toEqual([
      11, 100, 300,
    ]);
    expect(stored).toBe(500);
    expect(out).toMatchObject({ status: 'synced', more: false });
  });

  it('stops catching up as soon as the lease is lost', async () => {
    checkpoint = 10;
    const ev = (ledger: number) => ({ ledger }) as never;
    multi.fetchEventsSince.mockResolvedValue({
      events: [ev(100)],
      latestLedger: 500,
      complete: false,
    });
    checkpoints.advance.mockImplementation(async (_n: string, l: number) => {
      leader = false; // lease lapses right after the first checkpoint
      return l;
    });
    await service.tick();
    expect(multi.fetchEventsSince).toHaveBeenCalledTimes(1);
  });
});
