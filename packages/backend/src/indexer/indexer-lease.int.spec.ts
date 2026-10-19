/* eslint-disable
  @typescript-eslint/require-await,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-misused-promises
  -- test doubles, mocked async functions and raw SQL rows are intentionally loosely typed */
import Redis from 'ioredis';
import { IndexerLeaseService } from './indexer-lease.service';
import {
  TEST_REDIS_URL,
  describeRedis,
  fakeConfig,
  sleep,
  waitFor,
} from './testing/redis-test-harness';

describeRedis('IndexerLeaseService (Redis)', () => {
  let admin: Redis;
  let keySeq = 0;
  const nodes: IndexerLeaseService[] = [];

  beforeAll(() => {
    admin = new Redis(TEST_REDIS_URL as string);
  });
  afterAll(async () => {
    await admin.quit();
  });
  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((n) => n.stop().catch(() => 0)));
  });

  /** Each test gets its own key so tests never see each other's lease. */
  function newKey() {
    return `test:lease:${process.pid}:${Date.now()}:${keySeq++}`;
  }

  async function node(
    key: string,
    id: string,
    ttlMs: number,
    tickMs: number,
  ): Promise<IndexerLeaseService> {
    const svc = new IndexerLeaseService(
      fakeConfig({
        REDIS_URL: TEST_REDIS_URL as string,
        INDEXER_LEASE_KEY: key,
        INDEXER_LEASE_TTL_MS: String(ttlMs),
        INDEXER_LEASE_TICK_MS: String(tickMs),
        INDEXER_NODE_ID: id,
      }),
    );
    nodes.push(svc);
    await svc.start();
    return svc;
  }

  const leaders = (all: IndexerLeaseService[]) =>
    all.filter((n) => n.isLeader());

  it('elects exactly one leader among three nodes and keeps it stable', async () => {
    const key = newKey();
    const all = [
      await node(key, 'n1', 1500, 300),
      await node(key, 'n2', 1500, 300),
      await node(key, 'n3', 1500, 300),
    ];
    expect(leaders(all)).toHaveLength(1);
    const first = leaders(all)[0].nodeId;

    // Run well past one TTL, sampling continuously: never two leaders and
    // the same node keeps leading because it renews.
    const samples: number[] = [];
    const until = Date.now() + 4_000;
    while (Date.now() < until) {
      samples.push(leaders(all).length);
      await sleep(40);
    }
    expect(Math.max(...samples)).toBe(1);
    expect(Math.min(...samples)).toBe(1);
    expect(leaders(all)[0].nodeId).toBe(first);
  }, 15_000);

  it('hands over after a hard crash within 15s using the real 10s lease', async () => {
    const key = newKey();
    const a = await node(key, 'a', 10_000, 2_000);
    const b = await node(key, 'b', 10_000, 2_000);
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);

    const crashedAt = Date.now();
    await a.crashForTesting(); // no release: the key must expire on its own

    // while the dead leader's key is alive the standby must NOT lead
    await sleep(1_500);
    expect(b.isLeader()).toBe(false);

    await waitFor(() => b.isLeader(), 14_000, 100);
    const handoverMs = Date.now() - crashedAt;
    // eslint-disable-next-line no-console
    console.log(`crash failover took ${handoverMs} ms`);
    expect(handoverMs).toBeLessThan(15_000);
    expect(handoverMs).toBeGreaterThan(5_000); // proves it waited for expiry
  }, 30_000);

  it('hands over almost instantly when the leader shuts down cleanly', async () => {
    const key = newKey();
    const a = await node(key, 'a', 10_000, 300);
    const b = await node(key, 'b', 10_000, 300);
    expect(a.isLeader()).toBe(true);

    const t0 = Date.now();
    await a.stop(); // releases the lock
    await waitFor(() => b.isLeader(), 3_000, 25);
    expect(Date.now() - t0).toBeLessThan(2_000);
  }, 15_000);

  it('demotes immediately when the lease key disappears (renewal fails)', async () => {
    const key = newKey();
    const a = await node(key, 'a', 3_000, 200);
    expect(a.isLeader()).toBe(true);
    await admin.del(key); // e.g. Redis restart or eviction
    await waitFor(() => !a.isLeader(), 2_000, 25);
    // it then reacquires on a later tick, as the only candidate
    await waitFor(() => a.isLeader(), 2_000, 25);
    expect(a.getStatus().transitions).toBeGreaterThanOrEqual(3);
  }, 15_000);

  it('stops acting as leader once its local expiry passes even without a renewal', async () => {
    const key = newKey();
    // tick much slower than the ttl: renewal cannot happen in time, so the
    // node must demote itself from the local expiry alone
    const a = await node(key, 'a', 500, 60_000);
    expect(a.isLeader()).toBe(true);
    await waitFor(() => !a.isLeader(), 2_000, 25);
  }, 10_000);

  it('publishes who leads, and clears it on clean release', async () => {
    const key = newKey();
    const a = await node(key, 'leader-a', 10_000, 300);
    await waitFor(
      async () => (await a.getCluster()).holder === 'leader-a',
      2_000,
    );
    const cluster = await a.getCluster();
    expect(cluster.redis).toBe('connected');
    expect(cluster.ttlRemainingMs).toBeGreaterThan(0);

    const watcher = await node(key, 'watcher', 10_000, 300);
    await a.stop();
    await waitFor(() => watcher.isLeader(), 3_000, 25);
    await waitFor(
      async () => (await watcher.getCluster()).holder === 'watcher',
      2_000,
    );
  }, 15_000);
});
