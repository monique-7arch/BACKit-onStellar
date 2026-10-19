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
import {
  BulkEventLoaderService,
  EventLogRow,
} from './bulk-event-loader.service';
import { MultiContractIndexerService } from './multi-contract-indexer.service';
import {
  CONTRACT_MAP,
  account,
  addr,
  buildEvent,
  i128,
} from './__fixtures__/multi-contract-events.fixtures';
import { TestDb, createTestDb } from './testing/pg-test-harness';

/**
 * Throughput benchmark. Opt in with RUN_BENCH=true and TEST_DATABASE_URL.
 * Numbers depend on the machine and on PostgreSQL, so treat the asserted
 * floor (2,000 events/sec) as the acceptance bar and the logged figures as
 * the evidence.
 */
const enabled =
  process.env.RUN_BENCH === 'true' && !!process.env.TEST_DATABASE_URL;
const describeBench = enabled ? describe : describe.skip;

const TOTAL = Number(process.env.BENCH_EVENTS ?? 100_000);
const BATCH = 5_000;

function row(i: number): EventLogRow {
  const id = `${String(i).padStart(19, '0')}-0000000000`;
  return {
    eventId: id,
    dedupeKey: id,
    pagingToken: id,
    contractId: 'C'.padEnd(56, 'A'),
    topic0: 'Deposited',
    eventType: 'lending_deposited',
    ledger: 2_000_000 + Math.floor(i / 50),
    txHash: 'ab'.repeat(32),
    txOrder: i % 50,
    eventData: {
      contract: 'lending',
      namespace: 'lending_pool',
      event: 'Deposited',
      fields: {
        user: 'G'.padEnd(56, 'B'),
        amount: '123456789012345678901234567890',
        lpSharesMinted: String(i),
      },
      extra: [],
    },
    timestamp: '2026-10-17T12:00:00.000Z',
  };
}

describeBench('bulk loader benchmark (PostgreSQL)', () => {
  let db: TestDb;
  const q = (sql: string) => db.dataSource.query(sql);

  beforeAll(async () => {
    db = await createTestDb();
    // pre-create the partitions the run touches, as production maintenance does
    for (
      let ledger = 2_000_000;
      ledger < 2_000_000 + TOTAL / 50 + 1;
      ledger += 100_000
    ) {
      await q(`SELECT event_logs_create_partition(${ledger})`);
    }
  }, 120_000);
  afterAll(async () => db?.drop());
  beforeEach(async () => q(`TRUNCATE event_logs, lending_positions`));

  const report: Record<string, unknown>[] = [];
  afterAll(() => {
    // eslint-disable-next-line no-console
    console.table(report);
  });

  for (const strategy of ['copy', 'insert'] as const) {
    it(`loader only, ${strategy}: ${TOTAL} rows in ${BATCH}-row batches`, async () => {
      process.env.BULK_LOADER_STRATEGY = strategy;
      const svc = new BulkEventLoaderService(db.dataSource);
      delete process.env.BULK_LOADER_STRATEGY;

      const rows: EventLogRow[] = [];
      for (let i = 0; i < TOTAL; i++) rows.push(row(i));

      const started = process.hrtime.bigint();
      for (let i = 0; i < rows.length; i += BATCH) {
        await svc.insertBatch(rows.slice(i, i + BATCH));
      }
      const secs = Number(process.hrtime.bigint() - started) / 1e9;
      const rate = Math.round(TOTAL / secs);

      const [{ n }] = await q(`SELECT count(*)::int n FROM event_logs`);
      expect(n).toBe(TOTAL);
      report.push({
        scenario: `loader ${strategy}`,
        events: TOTAL,
        seconds: Number(secs.toFixed(2)),
        eventsPerSec: rate,
      });
      if (strategy === 'copy') expect(rate).toBeGreaterThan(2_000);
    }, 300_000);
  }

  it('re-running the whole load is idempotent and still fast', async () => {
    const svc = new BulkEventLoaderService(db.dataSource);
    const rows = Array.from({ length: 20_000 }, (_, i) => row(i));
    for (let i = 0; i < rows.length; i += BATCH)
      await svc.insertBatch(rows.slice(i, i + BATCH));
    const started = process.hrtime.bigint();
    let inserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      inserted += (await svc.insertBatch(rows.slice(i, i + BATCH))).inserted
        .size;
    }
    const secs = Number(process.hrtime.bigint() - started) / 1e9;
    expect(inserted).toBe(0);
    const [{ n }] = await q(`SELECT count(*)::int n FROM event_logs`);
    expect(n).toBe(20_000);
    report.push({
      scenario: 'duplicate replay (all conflicts)',
      events: 20_000,
      seconds: Number(secs.toFixed(2)),
      eventsPerSec: Math.round(20_000 / secs),
    });
  }, 120_000);

  it('FULL pipeline (decode + event log + lending projection)', async () => {
    const n = Math.min(TOTAL, 40_000);
    const events = Array.from({ length: n }, (_, i) =>
      buildEvent(
        'lending',
        'Deposited',
        [addr(account((i % 200) + 1)), i128('1000'), i128('1000')],
        {
          ledger: 2_000_000 + Math.floor(i / 50),
          txOrder: (i % 50) + 1,
          index: Math.floor(i / 50) % 1000,
        },
      ),
    );
    // event ids must be unique: fold the batch index into the tx order
    events.forEach((e, i) => {
      const id = `${String(i).padStart(19, '0')}-0000000000`;
      e.id = id;
      e.pagingToken = id;
    });
    const svc = new MultiContractIndexerService(
      db.dataSource,
      {} as SorobanRpc.Server,
    );

    const started = process.hrtime.bigint();
    let inserted = 0;
    for (let i = 0; i < events.length; i += BATCH) {
      const res = await svc.ingestBatch(
        events.slice(i, i + BATCH),
        CONTRACT_MAP,
      );
      inserted += res.inserted;
      expect(res.failed).toEqual([]);
    }
    const secs = Number(process.hrtime.bigint() - started) / 1e9;
    expect(inserted).toBe(n);
    const [{ total }] = await q(
      `SELECT sum("totalDeposited")::text total FROM lending_positions`,
    );
    expect(total).toBe(String(n * 1000));
    const rate = Math.round(n / secs);
    report.push({
      scenario: 'full pipeline (per-event projection)',
      events: n,
      seconds: Number(secs.toFixed(2)),
      eventsPerSec: rate,
    });
    expect(rate).toBeGreaterThan(2_000);
  }, 300_000);

  it('streams a long run with bounded memory', async () => {
    const gc = (global as { gc?: () => void }).gc;
    const svc = new BulkEventLoaderService(db.dataSource);
    const stream = svc.createRowStream();
    const total = Math.min(TOTAL * 3, 300_000);

    gc?.();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const started = process.hrtime.bigint();
    for (let i = 0; i < total; i++) {
      const wait = stream.push(row(i));
      if (wait) await wait;
      if (i % 20_000 === 0)
        peak = Math.max(peak, process.memoryUsage().heapUsed);
    }
    await stream.close();
    const secs = Number(process.hrtime.bigint() - started) / 1e9;
    gc?.();
    const after = process.memoryUsage().heapUsed;

    const [{ n }] = await q(`SELECT count(*)::int n FROM event_logs`);
    expect(n).toBe(total);
    expect(stream.pending).toBe(0);
    report.push({
      scenario: 'buffered stream soak',
      events: total,
      seconds: Number(secs.toFixed(2)),
      eventsPerSec: Math.round(total / secs),
      heapBeforeMB: Math.round(before / 1048576),
      heapPeakMB: Math.round(peak / 1048576),
      heapAfterMB: Math.round(after / 1048576),
    });
    if (gc) expect((after - before) / 1048576).toBeLessThan(40);
  }, 300_000);
});
