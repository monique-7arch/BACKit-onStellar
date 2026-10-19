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
import { IndexerLeaseService } from './indexer-lease.service';
import { IndexerSyncService } from './indexer-sync.service';
import {
  CHECKPOINT_MULTI_CONTRACT,
  LedgerCheckpointService,
} from './ledger-checkpoint.service';
import { MultiContractIndexerService } from './multi-contract-indexer.service';
import { RawIndexerEvent } from './multi-contract-events';
import {
  CONTRACT_IDS,
  USER_A,
  addr,
  buildEvent,
  i128,
} from './__fixtures__/multi-contract-events.fixtures';
import {
  TestDb,
  TEST_DATABASE_URL,
  createTestDb,
} from './testing/pg-test-harness';
import {
  TEST_REDIS_URL,
  fakeConfig,
  sleep,
  waitFor,
} from './testing/redis-test-harness';
import { DataSource } from 'typeorm';

const bothAvailable = Boolean(TEST_DATABASE_URL && TEST_REDIS_URL);
const describeBoth = bothAvailable ? describe : describe.skip;

/** A scripted chain shared by every node, recording who fetched what. */
class FakeChain {
  head = 0;
  events: RawIndexerEvent[] = [];
  fetches: Array<{ nodeId: string; startLedger: number | undefined }> = [];

  rpcFor(nodeId: string): SorobanRpc.Server {
    return {
      getLatestLedger: async () => ({ sequence: this.head }),
      getEvents: async (req: { startLedger?: number }) => {
        this.fetches.push({ nodeId, startLedger: req.startLedger });
        const start = req.startLedger ?? 0;
        return {
          latestLedger: this.head,
          events: this.events
            .filter((e) => e.ledger >= start && e.ledger <= this.head)
            .map((e) => ({
              id: e.id,
              pagingToken: e.pagingToken,
              ledger: e.ledger,
              ledgerClosedAt: e.ledgerClosedAt,
              contractId: { contractId: () => e.contractId },
              txHash: e.txHash,
              topic: e.topic.map((t) => xdr.ScVal.fromXDR(t, 'base64')),
              value: xdr.ScVal.fromXDR(e.value, 'base64'),
              inSuccessfulContractCall: true,
              type: 'contract',
            })),
        };
      },
    } as unknown as SorobanRpc.Server;
  }

  deposit(ledger: number, amount: string) {
    const e = buildEvent(
      'lending',
      'Deposited',
      [addr(USER_A), i128(amount), i128(amount)],
      { ledger, txOrder: 1 },
    );
    this.events.push(e);
    return e;
  }
}

class Node {
  readonly lease: IndexerLeaseService;
  readonly multi: MultiContractIndexerService;
  readonly sync: IndexerSyncService;
  private loop: NodeJS.Timeout | null = null;
  readonly checkpoints: LedgerCheckpointService;

  constructor(
    readonly id: string,
    redisKey: string,
    chain: FakeChain,
    ds: DataSource,
    leaseTtlMs: number,
    leaseTickMs: number,
  ) {
    this.lease = new IndexerLeaseService(
      fakeConfig({
        REDIS_URL: TEST_REDIS_URL as string,
        INDEXER_LEASE_KEY: redisKey,
        INDEXER_LEASE_TTL_MS: String(leaseTtlMs),
        INDEXER_LEASE_TICK_MS: String(leaseTickMs),
        INDEXER_NODE_ID: id,
      }),
    );
    this.checkpoints = new LedgerCheckpointService(ds);
    this.multi = new MultiContractIndexerService(ds, chain.rpcFor(id));
    this.sync = new IndexerSyncService(
      this.lease,
      this.checkpoints,
      this.multi,
      chain.rpcFor(id),
    );
  }

  async start() {
    await this.lease.start();
    this.loop = setInterval(() => void this.sync.scheduledTick(), 80);
  }

  /** Simulate the pod being killed: no release, no more ticks. */
  async crash() {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
    await this.lease.crashForTesting();
  }

  async stop() {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
    await this.lease.stop();
  }
}

describeBoth('indexer leader failover (PostgreSQL + Redis)', () => {
  let db: TestDb;
  let chain: FakeChain;
  let seq = 0;
  const nodes: Node[] = [];
  const q = (sql: string, p: unknown[] = []) => db.dataSource.query(sql, p);
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    db = await createTestDb();
    process.env.LENDING_POOL_CONTRACT_ID = CONTRACT_IDS.lending;
    process.env.INDEXER_START_LEDGER = '100';
  }, 60_000);

  afterAll(async () => {
    process.env = savedEnv;
    await db?.drop();
  });

  beforeEach(async () => {
    chain = new FakeChain();
    await q(`TRUNCATE event_logs, lending_positions, indexer_checkpoints`);
  });

  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((n) => n.stop().catch(() => 0)));
  });

  const redisKey = () => `test:failover:${process.pid}:${Date.now()}:${seq++}`;

  async function startNodes(key: string, ttl: number, tick: number) {
    const a = new Node('node-a', key, chain, db.dataSource, ttl, tick);
    const b = new Node('node-b', key, chain, db.dataSource, ttl, tick);
    nodes.push(a, b);
    await a.start();
    await b.start();
    return [a, b] as const;
  }

  const checkpoint = async () =>
    new LedgerCheckpointService(db.dataSource).get(CHECKPOINT_MULTI_CONTRACT);

  it('only the leader indexes, and the survivor resumes from the exact checkpoint', async () => {
    chain.head = 103;
    [101, 102, 103].forEach((l) => chain.deposit(l, '10'));

    const [a, b] = await startNodes(redisKey(), 1500, 200);
    await waitFor(async () => (await checkpoint()) === 103, 8_000);

    const leader = a.lease.isLeader() ? a : b;
    const standby = leader === a ? b : a;
    expect(standby.lease.isLeader()).toBe(false);
    // every fetch so far was made by the leader and none by the standby
    expect(new Set(chain.fetches.map((f) => f.nodeId))).toEqual(
      new Set([leader.id]),
    );
    expect(chain.fetches[0].startLedger).toBe(100); // INDEXER_START_LEDGER

    // new events arrive while the leader is dying
    await leader.crash();
    [104, 105, 106].forEach((l) => chain.deposit(l, '10'));
    chain.head = 106;
    const fetchesBefore = chain.fetches.length;

    await waitFor(async () => (await checkpoint()) === 106, 10_000);

    const after = chain.fetches.slice(fetchesBefore);
    expect(after.length).toBeGreaterThan(0);
    expect(new Set(after.map((f) => f.nodeId))).toEqual(new Set([standby.id]));
    // resumed exactly after the last committed ledger, not from the start
    expect(after[0].startLedger).toBe(104);

    // 6 events, each logged and applied exactly once
    const [{ n }] = await q(`SELECT count(*)::int n FROM event_logs`);
    const [{ d }] = await q(
      `SELECT count(DISTINCT "dedupeKey")::int d FROM event_logs`,
    );
    expect([n, d]).toEqual([6, 6]);
    const [pos] = await q(
      `SELECT "totalDeposited","lpShares" FROM lending_positions`,
    );
    expect(pos).toEqual({ totalDeposited: '60', lpShares: '60' });
  }, 40_000);

  it('applies nothing twice when the leader died after committing but before checkpointing', async () => {
    chain.head = 105;
    [101, 102, 103, 104, 105].forEach((l) => chain.deposit(l, '10'));
    const key = redisKey();
    const [a, b] = await startNodes(key, 1500, 200);
    await waitFor(async () => (await checkpoint()) === 105, 8_000);
    const leader = a.lease.isLeader() ? a : b;

    // Rewind the checkpoint to simulate "events committed, checkpoint write
    // lost with the crashed leader". Events 104 and 105 are already stored.
    await q(`UPDATE indexer_checkpoints SET "lastLedger"=103 WHERE name=$1`, [
      CHECKPOINT_MULTI_CONTRACT,
    ]);
    await leader.crash();

    // survivor takes over, refetches from 104 and must treat both as duplicates
    await waitFor(async () => {
      const [{ n }] = await q(`SELECT count(*)::int n FROM event_logs`);
      return (await checkpoint()) === 105 && n === 5;
    }, 10_000);
    await sleep(500);

    const [{ n }] = await q(`SELECT count(*)::int n FROM event_logs`);
    expect(n).toBe(5);
    const [pos] = await q(`SELECT "totalDeposited" FROM lending_positions`);
    expect(pos.totalDeposited).toBe('50'); // not 70
  }, 40_000);

  it('does not let a standby touch the database while the leader is healthy', async () => {
    chain.head = 101;
    chain.deposit(101, '10');
    const [a, b] = await startNodes(redisKey(), 1500, 200);
    await waitFor(async () => (await checkpoint()) === 101, 8_000);
    await sleep(1_500); // several more ticks on both nodes
    const fetchers = new Set(chain.fetches.map((f) => f.nodeId));
    expect(fetchers.size).toBe(1);
    expect(fetchers.has((a.lease.isLeader() ? a : b).id)).toBe(true);
  }, 20_000);
});
