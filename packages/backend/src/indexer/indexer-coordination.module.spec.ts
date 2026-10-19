/* eslint-disable
  @typescript-eslint/require-await,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-misused-promises
  -- test doubles, mocked async functions and raw SQL rows are intentionally loosely typed */
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { IndexerCoordinationModule } from './indexer-coordination.module';
import { IndexerLeaseService } from './indexer-lease.service';
import { LedgerCheckpointService } from './ledger-checkpoint.service';

describe('IndexerCoordinationModule (DI bootstrap)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('resolves the lease and checkpoint providers and shuts down cleanly', async () => {
    process.env.INDEXER_LEASE_DISABLED = 'true'; // no Redis needed here
    process.env.INDEXER_NODE_ID = 'di-test';

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        IndexerCoordinationModule,
      ],
    })
      .useMocker((token) =>
        token === DataSource ? { query: jest.fn() } : undefined,
      )
      .compile();

    await moduleRef.init(); // runs onModuleInit
    const lease = moduleRef.get(IndexerLeaseService);
    expect(lease.nodeId).toBe('di-test');
    expect(lease.isLeader()).toBe(true); // disabled mode: single process leader
    expect(lease.getStatus().leaseDisabled).toBe(true);
    expect(moduleRef.get(LedgerCheckpointService)).toBeInstanceOf(
      LedgerCheckpointService,
    );
    await moduleRef.close(); // runs onModuleDestroy
  });
});
