/* eslint-disable
  @typescript-eslint/require-await,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-misused-promises
  -- test doubles, mocked async functions and raw SQL rows are intentionally loosely typed */
import { LedgerCheckpointService } from './ledger-checkpoint.service';
import { TestDb, createTestDb, describeDb } from './testing/pg-test-harness';

describeDb('LedgerCheckpointService (PostgreSQL)', () => {
  let db: TestDb;
  let svc: LedgerCheckpointService;

  beforeAll(async () => {
    db = await createTestDb();
    svc = new LedgerCheckpointService(db.dataSource);
  }, 60_000);
  afterAll(async () => db?.drop());

  it('returns null before the first checkpoint', async () => {
    expect(await svc.get('fresh')).toBeNull();
    expect(await svc.getStatus('fresh')).toBeNull();
  });

  it('advances forward and never moves backwards', async () => {
    expect(await svc.advance('s', 100, 'a')).toBe(100);
    expect(await svc.advance('s', 150, 'a')).toBe(150);
    // a stale write from a node that just lost the lease
    expect(await svc.advance('s', 120, 'zombie')).toBe(150);
    expect(await svc.get('s')).toBe(150);
  });

  it('tracks streams independently and records the writer', async () => {
    await svc.advance('one', 5, 'node-1');
    await svc.advance('two', 9, 'node-2');
    expect(await svc.get('one')).toBe(5);
    expect(await svc.getStatus('two')).toMatchObject({
      lastLedger: 9,
      ownerId: 'node-2',
    });
  });

  it('survives concurrent advances without losing the maximum', async () => {
    await Promise.all(
      [10, 900, 40, 300, 700, 20].map((l) => svc.advance('race', l, 'n')),
    );
    expect(await svc.get('race')).toBe(900);
  });
});
