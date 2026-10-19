/* eslint-disable
  @typescript-eslint/require-await,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-misused-promises
  -- test doubles, mocked async functions and raw SQL rows are intentionally loosely typed */
import { SorobanRpc, xdr } from '@stellar/stellar-sdk';
import { MultiContractIndexerService } from './multi-contract-indexer.service';
import { RawIndexerEvent, decodeContractEvent } from './multi-contract-events';
import {
  BIG_U64,
  CONTRACT_MAP,
  I128_MAX,
  MARKET,
  U64_MAX,
  USER_A,
  USER_B,
  addr,
  allEventsFixture,
  buildEvent,
  i128,
  u32,
  u64,
} from './__fixtures__/multi-contract-events.fixtures';
import { TestDb, createTestDb, describeDb } from './testing/pg-test-harness';
import { CreateMultiContractIndexerTables1760000080000 } from '../database/migrations/1760000080000-CreateMultiContractIndexerTables';

describeDb('MultiContractIndexerService (PostgreSQL)', () => {
  let db: TestDb;
  let service: MultiContractIndexerService;
  const q = (sql: string, p: unknown[] = []) => db.dataSource.query(sql, p);

  beforeAll(async () => {
    db = await createTestDb();
    service = new MultiContractIndexerService(
      db.dataSource,
      {} as SorobanRpc.Server,
    );
  }, 60_000);

  afterAll(async () => db?.drop());

  beforeEach(async () => {
    await q(
      `TRUNCATE event_logs, factory_markets, factory_strategies, orderbook_orders,
         orderbook_trades, parlays, parlay_legs, lending_positions, lending_allocations`,
    );
  });

  it('persists every event type across all four contracts in one batch', async () => {
    const events = allEventsFixture();
    const res = await service.ingestBatch(events, CONTRACT_MAP);

    expect(res.failed).toEqual([]);
    expect(res.inserted).toBe(events.length);
    expect(res.duplicates).toBe(0);

    const logs = await q(
      `SELECT "eventType", "dedupeKey", "txOrder" FROM event_logs ORDER BY "dedupeKey"`,
    );
    expect(logs).toHaveLength(events.length);
    // 19 events, 16 distinct types (OrderPlaced, parlay created and
    // leg_resolved each appear twice in the fixture)
    expect(new Set(logs.map((l: any) => l.eventType)).size).toBe(16);

    const [market] = await q(`SELECT * FROM factory_markets`);
    expect(market.callId).toBe(BIG_U64);
    expect(market.marketAddress).toBe(MARKET);

    const strategies = await q(
      `SELECT "strategyId", status, "keeperReward", "escrowAmount", "actionsExecuted"
         FROM factory_strategies ORDER BY "strategyId"`,
    );
    // strategy 7 executed; strategy 8 was cancelled with no create (no row)
    expect(strategies).toEqual([
      {
        strategyId: '7',
        status: 'executed',
        keeperReward: '5000000',
        escrowAmount: I128_MAX,
        actionsExecuted: 3,
      },
    ]);

    const orders = await q(
      `SELECT "orderId", side, status FROM orderbook_orders ORDER BY "orderId"`,
    );
    expect(orders).toEqual([
      { orderId: '2', side: 'ask', status: 'cancelled' },
      { orderId: U64_MAX, side: 'bid', status: 'open' },
    ]);
    const [trade] = await q(`SELECT amount, "priceBps" FROM orderbook_trades`);
    expect(trade).toEqual({
      amount: '123456789012345678901234567890',
      priceBps: 6500,
    });

    const parlays = await q(
      `SELECT "parlayId", status, "legCount", "legsResolved", "legsWon",
              "totalPayout", "voidReason" FROM parlays ORDER BY "parlayId"`,
    );
    expect(parlays).toEqual([
      {
        parlayId: '5',
        status: 'completed',
        legCount: 3,
        legsResolved: 2,
        legsWon: 1,
        totalPayout: '0',
        voidReason: null,
      },
      {
        parlayId: '6',
        status: 'voided',
        legCount: 2,
        legsResolved: 0,
        legsWon: 0,
        totalPayout: null,
        voidReason: 'expired',
      },
    ]);
    const legs = await q(
      `SELECT "legIndex", won FROM parlay_legs WHERE "parlayId"=5 ORDER BY "legIndex"`,
    );
    expect(legs).toEqual([
      { legIndex: 0, won: true },
      { legIndex: 1, won: false },
      { legIndex: 2, won: null }, // still pending
    ]);

    const [pos] = await q(`SELECT * FROM lending_positions WHERE "user"=$1`, [
      USER_A,
    ]);
    expect(pos.totalDeposited).toBe(I128_MAX);
    expect(pos.lpShares).toBe('600'); // 1000 minted - 400 burned
    expect(pos.totalWithdrawn).toBe('450');

    const [alloc] = await q(`SELECT * FROM lending_allocations`);
    expect(alloc).toMatchObject({
      callId: BIG_U64,
      position: 1,
      allocatedAmount: '750',
      harvested: true,
      won: true,
      grossChange: '-30',
      protocolFee: '5',
      netYield: '25',
    });
  });

  it('is idempotent: replaying the same batch changes nothing', async () => {
    const events = allEventsFixture();
    await service.ingestBatch(events, CONTRACT_MAP);
    const snapshot = async () => ({
      logs: await q(`SELECT count(*)::int AS n FROM event_logs`),
      pos: await q(`SELECT * FROM lending_positions ORDER BY "user"`),
      parlays: await q(`SELECT * FROM parlays ORDER BY "parlayId"`),
      alloc: await q(`SELECT * FROM lending_allocations`),
    });
    const before = await snapshot();

    const again = await service.ingestBatch(events, CONTRACT_MAP);
    expect(again.inserted).toBe(0);
    expect(again.duplicates).toBe(events.length);
    expect(again.failed).toEqual([]);

    const after = await snapshot();
    // updatedAt never moves because no projection ran
    expect(after).toEqual(before);
  });

  it('does not double count when the same event is repeated inside a batch', async () => {
    const dep = buildEvent('lending', 'Deposited', [
      addr(USER_B),
      i128('100'),
      i128('100'),
    ]);
    const res = await service.ingestBatch([dep, dep, dep], CONTRACT_MAP);
    expect(res.inserted).toBe(1);
    const [pos] = await q(`SELECT "lpShares" FROM lending_positions`);
    expect(pos.lpShares).toBe('100');
  });

  it('applies events in chain order regardless of input order', async () => {
    const events = allEventsFixture().reverse();
    const res = await service.ingestBatch(events, CONTRACT_MAP);
    expect(res.failed).toEqual([]);
    const [p] = await q(
      `SELECT status, "legsResolved" FROM parlays WHERE "parlayId"=5`,
    );
    expect(p).toEqual({ status: 'completed', legsResolved: 2 });
  });

  it('keeps 128-bit math exact across accumulating deposits', async () => {
    const half = (BigInt(I128_MAX) / BigInt(2)).toString();
    const a = buildEvent(
      'lending',
      'Deposited',
      [addr(USER_B), i128(half), i128(half)],
      { ledger: 3000, txOrder: 1 },
    );
    const b = buildEvent(
      'lending',
      'Deposited',
      [addr(USER_B), i128(half), i128(half)],
      { ledger: 3000, txOrder: 2 },
    );
    await service.ingestBatch([a, b], CONTRACT_MAP);
    const [pos] = await q(`SELECT "totalDeposited" FROM lending_positions`);
    expect(pos.totalDeposited).toBe((BigInt(half) * BigInt(2)).toString());
  });

  describe('atomicity', () => {
    it('rolls the whole batch back when a projection fails, then isolates the poison event', async () => {
      // Build a properly typed poison event: a parlay with an out-of-range leg count
      const poison = buildEvent(
        'parlay',
        'created',
        [u64(99), addr(USER_A), i128('1'), u32(1_000_000)],
        { ledger: 4000, txOrder: 2 },
      );
      const ok = buildEvent(
        'lending',
        'Deposited',
        [addr(USER_A), i128('10'), i128('10')],
        { ledger: 4000, txOrder: 1 },
      );

      const failures: string[] = [];
      const sinkService = new MultiContractIndexerService(
        db.dataSource,
        {} as SorobanRpc.Server,
        {
          handleFailure: async (f) => {
            failures.push(`${f.stage}:${f.event.id}`);
          },
        },
      );
      const res = await sinkService.ingestBatch([ok, poison], CONTRACT_MAP);

      // healthy event committed, poison one reported to the sink
      expect(res.inserted).toBe(1);
      expect(res.failed).toHaveLength(1);
      expect(res.failed[0].stage).toBe('persist');
      expect(failures).toEqual([`persist:${poison.id}`]);
      expect(await q(`SELECT count(*)::int n FROM lending_positions`)).toEqual([
        { n: 1 },
      ]);
      // the poison event left NO trace: no event log, no parlay
      expect(
        await q(`SELECT count(*)::int n FROM event_logs WHERE "dedupeKey"=$1`, [
          poison.id,
        ]),
      ).toEqual([{ n: 0 }]);
      expect(await q(`SELECT count(*)::int n FROM parlays`)).toEqual([
        { n: 0 },
      ]);
    });

    it('commits nothing from a single multi-event transaction that fails midway', async () => {
      const a = buildEvent(
        'lending',
        'Deposited',
        [addr(USER_A), i128('10'), i128('10')],
        { ledger: 5000, txOrder: 1 },
      );
      const b = buildEvent(
        'parlay',
        'created',
        [u64(98), addr(USER_A), i128('1'), u32(1_000_000)],
        { ledger: 5000, txOrder: 2 },
      );
      // call the transactional core directly so there is no per-event fallback
      const items = [a, b].map((raw) => ({
        raw,
        decoded: (() => {
          const out = decodeContractEvent(raw, CONTRACT_MAP);
          if (out.status !== 'decoded') throw new Error('not decoded');
          return out.event;
        })(),
      }));
      await expect(
        db.dataSource.transaction((m) => (service as any).persist(m, items)),
      ).rejects.toThrow(/leg count/);
      expect(await q(`SELECT count(*)::int n FROM event_logs`)).toEqual([
        { n: 0 },
      ]);
      expect(await q(`SELECT count(*)::int n FROM lending_positions`)).toEqual([
        { n: 0 },
      ]);
    });
  });

  describe('failure handling', () => {
    it('reports undecodable events without blocking the rest', async () => {
      const bad: RawIndexerEvent = {
        ...buildEvent('orderbook', 'OrderCancelled', [u64(1)]),
        value: 'AAAA',
      };
      const ok = buildEvent('orderbook', 'OrderPlaced', [
        u64(1),
        addr(USER_A),
        u64(1),
        u32(1),
        xdr.ScVal.scvBool(true),
      ]);
      const res = await service.ingestBatch([bad, ok], CONTRACT_MAP);
      expect(res.inserted).toBe(1);
      expect(res.failed.map((f) => f.stage)).toEqual(['decode']);
    });
  });

  describe('event_logs schema', () => {
    it('still accepts legacy rows with NULL dedupeKey, unlimited duplicates', async () => {
      for (let i = 0; i < 2; i++) {
        await q(
          `INSERT INTO event_logs ("eventId","pagingToken","contractId","topic0","eventType",
             "ledger","txHash","txOrder","eventData","timestamp")
           VALUES ('same','p','C','t','initialized',10,'h',0,'{}', now())`,
        );
      }
      expect(await q(`SELECT count(*)::int n FROM event_logs`)).toEqual([
        { n: 2 },
      ]);
    });

    it('keeps the unique key working after new partitions are created', async () => {
      await q(`SELECT event_logs_create_partition(250000)`);
      const e = buildEvent('orderbook', 'OrderCancelled', [u64(1)], {
        ledger: 250_001,
      });
      const first = await service.ingestBatch([e], CONTRACT_MAP);
      const second = await service.ingestBatch([e], CONTRACT_MAP);
      expect(first.inserted).toBe(1);
      expect(second.duplicates).toBe(1);
      const [row] = await q(
        `SELECT tableoid::regclass::text AS part FROM event_logs WHERE "dedupeKey"=$1`,
        [e.id],
      );
      expect(row.part).toBe('event_logs_p0000002');
    });
  });

  describe('migration', () => {
    it('down() reverses cleanly and up() can be re-applied', async () => {
      const qr = db.dataSource.createQueryRunner();
      await qr.connect();
      const m = new CreateMultiContractIndexerTables1760000080000();
      await m.down(qr);
      const tables = await qr.query(
        `SELECT count(*)::int n FROM information_schema.tables
          WHERE table_name IN ('parlays','lending_positions','factory_markets')`,
      );
      const col = await qr.query(
        `SELECT count(*)::int n FROM information_schema.columns
          WHERE table_name='event_logs' AND column_name='dedupeKey'`,
      );
      expect([tables[0].n, col[0].n]).toEqual([0, 0]);
      await m.up(qr);
      await qr.release();
      const res = await service.ingestBatch(allEventsFixture(), CONTRACT_MAP);
      expect(res.failed).toEqual([]);
    });
  });
});
