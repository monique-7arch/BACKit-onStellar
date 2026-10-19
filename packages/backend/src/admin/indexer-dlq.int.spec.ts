/* eslint-disable
  @typescript-eslint/require-await,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-misused-promises
  -- test doubles, mocked async functions and raw SQL rows are intentionally loosely typed */
import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';
import { Test, TestingModule } from '@nestjs/testing';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { SorobanRpc } from '@stellar/stellar-sdk';
import {
  IndexerDlqService,
  QUEUE_INDEXER_DLQ,
  QUEUE_INDEXER_EVENTS,
} from './indexer-dlq.service';
import { IndexerDlqModule } from './indexer-dlq.module';
import { IndexerEventsProcessor } from '../indexer/indexer-events.processor';
import {
  INDEXER_FAILURE_SINK,
  MultiContractIndexerService,
} from '../indexer/multi-contract-indexer.service';
import {
  CONTRACT_IDS,
  USER_A,
  addr,
  buildEvent,
  i128,
  u32,
  u64,
} from '../indexer/__fixtures__/multi-contract-events.fixtures';
import { xdr } from '@stellar/stellar-sdk';
import {
  TestDb,
  TEST_DATABASE_URL,
  createTestDb,
} from '../indexer/testing/pg-test-harness';
import { TEST_REDIS_URL, waitFor } from '../indexer/testing/redis-test-harness';

const available = Boolean(TEST_DATABASE_URL && TEST_REDIS_URL);
const describeBoth = available ? describe : describe.skip;

describeBoth('Indexer DLQ end to end (Redis + PostgreSQL + webhook)', () => {
  let db: TestDb;
  let moduleRef: TestingModule;
  let multi: MultiContractIndexerService;
  let dlq: IndexerDlqService;
  let hooks: Server;
  const received: Array<{ path: string; body: Record<string, string> }> = [];
  let hookStatus = 200;
  const saved = { ...process.env };
  const q = (sql: string, p: unknown[] = []) => db.dataSource.query(sql, p);
  const dlqCount = async () => (await dlq.list(100, 0)).total;

  beforeAll(async () => {
    Logger.overrideLogger(false); // the pipeline logs a stack per failure
    db = await createTestDb();

    hooks = createServer((req: IncomingMessage, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        received.push({ path: req.url ?? '', body: JSON.parse(raw || '{}') });
        res.statusCode = hookStatus;
        res.end('ok');
      });
    });
    await new Promise<void>((r) => hooks.listen(0, '127.0.0.1', r));
    const port = (hooks.address() as AddressInfo).port;

    process.env.INDEXER_QUEUE_BACKOFF_MS = '20';
    process.env.INDEXER_DLQ_ALERT_WEBHOOK_URL = `http://127.0.0.1:${port}/slack`;
    process.env.LENDING_POOL_CONTRACT_ID = CONTRACT_IDS.lending;
    process.env.PARLAY_CONTRACT_ID = CONTRACT_IDS.parlay;

    moduleRef = await Test.createTestingModule({
      imports: [
        BullModule.forRoot({
          connection: { url: TEST_REDIS_URL as string },
          prefix: `test-dlq-${process.pid}-${Date.now()}`,
        }),
        IndexerDlqModule,
      ],
      providers: [
        IndexerEventsProcessor,
        {
          provide: MultiContractIndexerService,
          inject: [IndexerDlqService],
          useFactory: (sink: IndexerDlqService) =>
            new MultiContractIndexerService(
              db.dataSource,
              {} as SorobanRpc.Server,
              sink,
            ),
        },
        { provide: INDEXER_FAILURE_SINK, useExisting: IndexerDlqService },
      ],
    }).compile();
    await moduleRef.init();
    multi = moduleRef.get(MultiContractIndexerService);
    dlq = moduleRef.get(IndexerDlqService);
  }, 60_000);

  afterAll(async () => {
    await moduleRef?.close();
    await new Promise<void>((r) => hooks.close(() => r()));
    process.env = saved;
    await db?.drop();
  });

  beforeEach(async () => {
    // Isolate every test: wipe both queues (active jobs included).
    for (const name of [QUEUE_INDEXER_EVENTS, QUEUE_INDEXER_DLQ]) {
      await moduleRef
        .get<Queue>(getQueueToken(name))
        .obliterate({ force: true });
    }
    jest.restoreAllMocks();
    process.env.INDEXER_QUEUE_BACKOFF_MS = '20';
    received.length = 0;
    hookStatus = 200;
    await q(`TRUNCATE event_logs, parlays, parlay_legs, lending_positions`);
  });

  /** A parlay whose leg count is out of range: fails at persist, every time. */
  const poison = (id = 99, ledger = 7000, tx = 1) =>
    buildEvent(
      'parlay',
      'created',
      [u64(id), addr(USER_A), i128('1'), u32(1_000_000)],
      { ledger, txOrder: tx },
    );
  const healthy = (ledger = 7000, tx = 2) =>
    buildEvent('lending', 'Deposited', [addr(USER_A), i128('10'), i128('10')], {
      ledger,
      txOrder: tx,
    });

  it('retries 5 times with exponential backoff, then dead-letters with stack and raw XDR', async () => {
    // A larger base delay than the other tests, so the exponential growth
    // clearly dominates the variable cost of each database attempt.
    process.env.INDEXER_QUEUE_BACKOFF_MS = '150';
    const attempts: number[] = [];
    const real = multi.ingestBatch.bind(multi);
    const spy = jest
      .spyOn(multi, 'ingestBatch')
      .mockImplementation(async (events, contracts, options) => {
        if (options?.reportFailures === false) attempts.push(Date.now());
        return real(events, contracts, options);
      });

    const bad = poison();
    const res = await multi.ingestBatch([bad, healthy()]);

    // the consumer was not blocked by the poison event
    expect(res.inserted).toBe(1);
    expect(
      (await q(`SELECT "totalDeposited" FROM lending_positions`))[0]
        .totalDeposited,
    ).toBe('10');

    await waitFor(async () => (await dlqCount()) === 1, 20_000, 50);
    spy.mockRestore();

    // exactly 5 attempts through the retry queue
    expect(attempts).toHaveLength(5);
    // exponential: delays are 150, 300, 600, 1200 ms plus per-attempt work
    const gaps = attempts.slice(1).map((t, i) => t - attempts[i]);
    expect(gaps[0]).toBeGreaterThanOrEqual(140);
    expect(gaps[1]).toBeGreaterThan(gaps[0]);
    expect(gaps[2]).toBeGreaterThan(gaps[1]);
    expect(gaps[3]).toBeGreaterThan(gaps[2]);
    expect(gaps[3]).toBeGreaterThan(gaps[0] * 3);

    const entry = await dlq.get(bad.id);
    expect(entry).toMatchObject({
      id: bad.id,
      stage: 'persist',
      attempts: 5,
      redriveCount: 0,
      edited: false,
    });
    expect(entry.error.message).toMatch(/leg count 1000000 exceeds/);
    expect(entry.error.stack).toContain('ScValDecodeError');
    expect(entry.event.topic).toEqual(bad.topic); // raw XDR preserved
    expect(entry.event.value).toBe(bad.value);

    // nothing partial was written for the poison event
    expect(await q(`SELECT count(*)::int n FROM parlays`)).toEqual([{ n: 0 }]);
  }, 30_000);

  it('alerts the webhook on DLQ entry (Slack format by default)', async () => {
    await multi.ingestBatch([poison(98, 7100)]);
    await waitFor(() => received.length >= 1, 15_000, 50);
    expect(received).toHaveLength(1);
    expect(received[0].path).toBe('/slack');
    expect(Object.keys(received[0].body)).toEqual(['text']);
    expect(received[0].body.text).toMatch(
      /Indexer DLQ: event .* failed after 5 attempts/,
    );
    expect(received[0].body.text).toContain('Ledger 7100');
    expect(received[0].body.text).toContain('/admin/indexer/dlq/retry');
  }, 30_000);

  it('still dead-letters when the webhook is failing', async () => {
    hookStatus = 500;
    const bad = poison(97, 7200);
    await multi.ingestBatch([bad]);
    await waitFor(async () => (await dlqCount()) >= 1, 15_000, 50);
    expect((await dlq.get(bad.id)).id).toBe(bad.id);
  }, 30_000);

  it('lets an admin edit the raw event and re-drive it into PostgreSQL', async () => {
    const bad = poison(96, 7300);
    await multi.ingestBatch([bad]);
    await waitFor(async () => (await dlqCount()) >= 1, 15_000, 50);

    // an invalid edit is rejected and the entry stays parked
    await expect(
      dlq.retry({ ids: [bad.id], patch: { value: 'not-xdr' } }),
    ).rejects.toThrow(/invalid ScVal XDR/);
    expect((await dlq.get(bad.id)).id).toBe(bad.id);

    // fix the leg count in the raw payload
    const fixed = xdr.ScVal.scvVec([
      u64(96),
      addr(USER_A),
      i128('5'),
      u32(3),
    ]).toXDR('base64');
    const out = await dlq.retry({ ids: [bad.id], patch: { value: fixed } });
    expect(out).toEqual({ requeued: [bad.id], notFound: [] });

    await waitFor(
      async () => (await q(`SELECT count(*)::int n FROM parlays`))[0].n === 1,
      10_000,
      50,
    );
    const [p] = await q(`SELECT "legCount", "initialStake" FROM parlays`);
    expect(p).toEqual({ legCount: 3, initialStake: '5' });
    expect(await q(`SELECT count(*)::int n FROM parlay_legs`)).toEqual([
      { n: 3 },
    ]);
    await waitFor(async () => (await dlqCount()) === 0, 5_000, 50);
  }, 40_000);

  it('re-driving an unchanged event that still fails returns it to the DLQ with a higher count', async () => {
    const bad = poison(95, 7400);
    await multi.ingestBatch([bad]);
    await waitFor(async () => (await dlqCount()) >= 1, 15_000, 50);

    await dlq.retry({ ids: [bad.id] });
    await waitFor(
      async () => {
        const list = await dlq.list(100, 0);
        return list.items.some((e) => e.id === bad.id && e.redriveCount === 1);
      },
      15_000,
      50,
    );
    expect((await dlq.get(bad.id)).redriveCount).toBe(1);
  }, 40_000);

  it('retry all drains the queue; unknown ids are reported, not fatal', async () => {
    await multi.ingestBatch([poison(80, 7500, 1), poison(81, 7500, 2)]);
    await waitFor(async () => (await dlqCount()) >= 2, 20_000, 50);

    const missing = await dlq.retry({ ids: ['does-not-exist'] });
    expect(missing).toEqual({ requeued: [], notFound: ['does-not-exist'] });

    const out = await dlq.retry({ all: true });
    expect(out.requeued).toHaveLength(2);
    // both still fail, so both come back with redriveCount 1
    await waitFor(
      async () => {
        const list = await dlq.list(100, 0);
        return (
          list.items.length >= 2 &&
          list.items.every((e) => e.redriveCount === 1)
        );
      },
      20_000,
      50,
    );
  }, 60_000);

  it('does not dead-letter an event that succeeds on a later attempt', async () => {
    const real = multi.ingestBatch.bind(multi);
    let queueCalls = 0;
    const spy = jest
      .spyOn(multi, 'ingestBatch')
      .mockImplementation(async (events, contracts, options) => {
        if (options?.reportFailures === false && ++queueCalls < 3) {
          return {
            received: 1,
            inserted: 0,
            duplicates: 0,
            ignored: 0,
            failed: [
              {
                event: events[0],
                stage: 'persist',
                error: new Error('transient'),
              },
            ],
          };
        }
        return real(events, contracts, options);
      });
    const dep = healthy(7600, 1);
    // hand it to the sink as the adapter would after a first failure
    await dlq.handleFailure({
      event: dep,
      stage: 'persist',
      error: new Error('first failure'),
    });
    await waitFor(
      async () =>
        (await q(`SELECT count(*)::int n FROM lending_positions`))[0].n === 1,
      10_000,
      50,
    );
    spy.mockRestore();
    expect(queueCalls).toBe(3);
    expect(await dlqCount()).toBe(0);
  }, 30_000);

  it('rejects bad retry requests before touching the queue', async () => {
    await expect(dlq.retry({})).rejects.toThrow(/either ids or all/);
    await expect(dlq.retry({ ids: ['a'], all: true })).rejects.toThrow(
      /either ids or all/,
    );
    await expect(
      dlq.retry({ ids: ['a', 'b'], patch: { value: 'AAAA' } }),
    ).rejects.toThrow(/exactly one id/);
    await expect(dlq.get('nope')).rejects.toThrow(/not found/);
  });

  it('exposes the queue names it uses', () => {
    expect([QUEUE_INDEXER_EVENTS, QUEUE_INDEXER_DLQ]).toEqual([
      'indexer-events',
      'indexer-dlq',
    ]);
  });
});
