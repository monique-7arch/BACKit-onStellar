/* eslint-disable
  @typescript-eslint/require-await,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-misused-promises
  -- test doubles, mocked async functions and raw SQL rows are intentionally loosely typed */
import {
  BulkEventLoaderService,
  EventLogRow,
} from './bulk-event-loader.service';
import { TestDb, createTestDb, describeDb } from './testing/pg-test-harness';
import { sleep } from './testing/redis-test-harness';

function row(i: number, over: Partial<EventLogRow> = {}): EventLogRow {
  const id = `${String(i).padStart(19, '0')}-0000000000`;
  return {
    eventId: id,
    dedupeKey: id,
    pagingToken: id,
    contractId: 'C'.padEnd(56, 'A'),
    topic0: 'Deposited',
    eventType: 'lending_deposited',
    ledger: 1_000_000 + Math.floor(i / 50),
    txHash: 'ab'.repeat(32),
    txOrder: i % 50,
    eventData: { n: i, user: 'G'.padEnd(56, 'B'), amount: String(i) },
    timestamp: '2026-10-17T12:00:00.000Z',
    ...over,
  };
}
const rowsOf = (from: number, count: number) =>
  Array.from({ length: count }, (_, k) => row(from + k));

describeDb('BulkEventLoaderService (PostgreSQL)', () => {
  let db: TestDb;
  let copy: BulkEventLoaderService;
  let insert: BulkEventLoaderService;
  const q = (sql: string, p: unknown[] = []) => db.dataSource.query(sql, p);
  const count = async () =>
    (await q(`SELECT count(*)::int n FROM event_logs`))[0].n as number;

  beforeAll(async () => {
    db = await createTestDb();
    process.env.BULK_LOADER_STRATEGY = 'copy';
    copy = new BulkEventLoaderService(db.dataSource);
    process.env.BULK_LOADER_STRATEGY = 'insert';
    insert = new BulkEventLoaderService(db.dataSource);
    delete process.env.BULK_LOADER_STRATEGY;
  }, 60_000);
  afterAll(async () => db?.drop());
  beforeEach(async () => q(`TRUNCATE event_logs`));

  describe.each([
    ['copy', () => copy],
    ['insert', () => insert],
  ])('%s strategy', (strategy, svc) => {
    it('inserts every row', async () => {
      const res = await svc().insertBatch(rowsOf(0, 1_000));
      expect(res.strategy).toBe(strategy);
      expect(res.inserted.size).toBe(1_000);
      expect(res.skipped).toBe(0);
      expect(await count()).toBe(1_000);
    });

    it('is idempotent: retrying the same batch inserts nothing', async () => {
      const rows = rowsOf(0, 500);
      await svc().insertBatch(rows);
      const again = await svc().insertBatch(rows);
      expect(again.inserted.size).toBe(0);
      expect(again.skipped).toBe(500);
      expect(await count()).toBe(500);
    });

    it('only reports the genuinely new rows of an overlapping batch', async () => {
      await svc().insertBatch(rowsOf(0, 300));
      const res = await svc().insertBatch(rowsOf(200, 300)); // 200..499
      expect(res.inserted.size).toBe(200);
      expect(res.skipped).toBe(100);
      expect(await count()).toBe(500);
    });

    it('collapses duplicates inside one batch', async () => {
      const r = row(1);
      const res = await svc().insertBatch([r, r, r, row(2)]);
      expect(res.inserted.size).toBe(2);
      expect(await count()).toBe(2);
    });

    it('stores awkward payloads byte for byte', async () => {
      const nasty = {
        tab: 'a\tb',
        newline: 'a\nb',
        cr: 'a\r\nb',
        slash: 'C:\\path\\to\\file',
        quote: 'say "hi" and \'bye\'',
        unicode: 'naïve ☃ 日本語 😀',
        escapedLike: '\\n \\t \\\\ \\N',
        bigNumberAsString: '170141183460469231731687303715884105727',
        nested: { arr: [1, 'two', null, { deep: '\t' }] },
      };
      await svc().insertBatch([row(1, { eventData: nasty })]);
      const [out] = await q(`SELECT "eventData" FROM event_logs`);
      expect(out.eventData).toEqual(nasty);
    });

    it('keeps NULL topic0 and stores the timestamp as UTC wall time', async () => {
      await svc().insertBatch([row(1, { topic0: null })]);
      const [r] = await q(
        `SELECT "topic0", to_char("timestamp",'YYYY-MM-DD"T"HH24:MI:SS') AS ts FROM event_logs`,
      );
      expect(r).toEqual({ topic0: null, ts: '2026-10-17T12:00:00' });
    });

    it('routes rows to the right partitions across ledger ranges', async () => {
      await q(`SELECT event_logs_create_partition(250000)`);
      await svc().insertBatch([
        row(1, { ledger: 10 }),
        row(2, { ledger: 250_001 }),
      ]);
      const parts = await q(
        `SELECT tableoid::regclass::text p FROM event_logs ORDER BY "ledger"`,
      );
      expect(parts.map((p: { p: string }) => p.p)).toEqual([
        'event_logs_p0000000',
        'event_logs_p0000002',
      ]);
    });

    it('is atomic inside the caller transaction: a rollback leaves nothing', async () => {
      await expect(
        db.dataSource.transaction(async (m) => {
          await svc().insertBatch(rowsOf(0, 400), m);
          throw new Error('later step failed');
        }),
      ).rejects.toThrow('later step failed');
      expect(await count()).toBe(0);
    });

    it('can be called twice in one transaction (staging table is reused)', async () => {
      await db.dataSource.transaction(async (m) => {
        await svc().insertBatch(rowsOf(0, 100), m);
        await svc().insertBatch(rowsOf(100, 100), m);
      });
      expect(await count()).toBe(200);
    });

    it('rejects the whole batch on a bad row and commits nothing', async () => {
      const bad = row(5, { txOrder: null as unknown as number });
      await expect(
        svc().insertBatch([...rowsOf(0, 50), bad]),
      ).rejects.toThrow();
      expect(await count()).toBe(0);
    });
  });

  it('copy and insert produce identical rows', async () => {
    const rows = rowsOf(0, 400);
    await copy.insertBatch(rows);
    const viaCopy = await q(
      `SELECT "eventId","topic0","ledger","txOrder","eventData","timestamp" FROM event_logs ORDER BY "eventId"`,
    );
    await q(`TRUNCATE event_logs`);
    await insert.insertBatch(rows);
    const viaInsert = await q(
      `SELECT "eventId","topic0","ledger","txOrder","eventData","timestamp" FROM event_logs ORDER BY "eventId"`,
    );
    expect(viaInsert).toEqual(viaCopy);
  });

  it('auto picks insert below the threshold and copy at or above it', async () => {
    const auto = new BulkEventLoaderService(db.dataSource);
    const small = await auto.insertBatch(rowsOf(0, 10));
    const large = await auto.insertBatch(rowsOf(1000, 300));
    expect(small.strategy).toBe('insert');
    expect(large.strategy).toBe('copy');
  });

  describe('buffered stream', () => {
    it('flushes at the item limit', async () => {
      process.env.BULK_LOADER_MAX_BATCH = '100';
      process.env.BULK_LOADER_MAX_LATENCY_MS = '60000';
      const svc = new BulkEventLoaderService(db.dataSource);
      delete process.env.BULK_LOADER_MAX_BATCH;
      delete process.env.BULK_LOADER_MAX_LATENCY_MS;
      const stream = svc.createRowStream();
      rowsOf(0, 250).forEach((r) => stream.push(r));
      await sleep(400);
      expect(await count()).toBe(200); // two full batches, 50 still buffered
      await stream.close();
      expect(await count()).toBe(250);
    });

    it('flushes a partial batch within the latency bound', async () => {
      process.env.BULK_LOADER_MAX_BATCH = '5000';
      process.env.BULK_LOADER_MAX_LATENCY_MS = '200';
      const svc = new BulkEventLoaderService(db.dataSource);
      delete process.env.BULK_LOADER_MAX_BATCH;
      delete process.env.BULK_LOADER_MAX_LATENCY_MS;
      const stream = svc.createRowStream();
      rowsOf(0, 7).forEach((r) => stream.push(r));
      expect(await count()).toBe(0);
      await sleep(700);
      expect(await count()).toBe(7);
      await stream.close();
    });

    it('survives a duplicate batch retry with no double inserts', async () => {
      const svc = new BulkEventLoaderService(db.dataSource);
      const stream = svc.createRowStream();
      const rows = rowsOf(0, 300);
      rows.forEach((r) => stream.push(r));
      await stream.flush();
      rows.forEach((r) => stream.push(r)); // the same batch delivered again
      await stream.close();
      expect(await count()).toBe(300);
    });

    it('drains buffered rows on module destroy', async () => {
      const svc = new BulkEventLoaderService(db.dataSource);
      const stream = svc.createRowStream();
      rowsOf(0, 30).forEach((r) => stream.push(r));
      await svc.onModuleDestroy();
      expect(await count()).toBe(30);
    });
  });
});
