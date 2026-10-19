/* eslint-disable
  @typescript-eslint/require-await,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-misused-promises
  -- test doubles, mocked async functions and raw SQL rows are intentionally loosely typed */
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';
import { IndexerLeaseService } from '../indexer/indexer-lease.service';
import { LedgerCheckpointService } from '../indexer/ledger-checkpoint.service';

describe('HealthController GET /health/indexer', () => {
  const leaseStatus = (over = {}) => ({
    nodeId: 'node-1',
    isLeader: false,
    leaseDisabled: false,
    expiresAt: null,
    acquiredAt: null,
    lastRenewedAt: null,
    transitions: 0,
    lastError: null,
    ...over,
  });

  function build(opts: {
    status?: object;
    cluster?: object;
    checkpoint?: () => Promise<unknown>;
  }) {
    const lease = {
      getStatus: () => leaseStatus(opts.status),
      getCluster: async () => ({
        redis: 'connected',
        holder: 'node-0',
        ttlRemainingMs: 7000,
        ...opts.cluster,
      }),
    } as unknown as IndexerLeaseService;
    const checkpoints = {
      getStatus:
        opts.checkpoint ??
        (async () => ({
          name: 'multi-contract',
          lastLedger: 99,
          ownerId: 'node-0',
          updatedAt: '2026-01-01T00:00:00.000Z',
        })),
    } as unknown as LedgerCheckpointService;
    return new HealthController(
      {} as never,
      {} as never,
      {} as never,
      lease,
      checkpoints,
    );
  }

  it('reports a healthy standby as 200', async () => {
    const res = await build({}).indexer();
    expect(res).toMatchObject({
      status: 'ok',
      role: 'standby',
      leaseHolder: 'node-0',
      leaderless: false,
      checkpoint: { lastLedger: 99 },
    });
  });

  it('reports the leader role and expiry', async () => {
    const res = await build({
      status: { isLeader: true, expiresAt: Date.parse('2026-01-01T00:00:10Z') },
      cluster: { holder: 'node-1' },
    }).indexer();
    expect(res).toMatchObject({
      role: 'leader',
      leaseExpiresAt: '2026-01-01T00:00:10.000Z',
    });
  });

  it('flags a leaderless cluster without failing the probe', async () => {
    const res = await build({
      cluster: { holder: null, ttlRemainingMs: null },
    }).indexer();
    expect(res).toMatchObject({ status: 'ok', leaderless: true });
  });

  it('returns 503 when Redis is unreachable', async () => {
    await expect(
      build({ cluster: { redis: 'unreachable', holder: null } }).indexer(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('degrades (still 200) when the checkpoint cannot be read', async () => {
    const res = await build({
      checkpoint: async () => {
        throw new Error('db down');
      },
    }).indexer();
    expect(res).toMatchObject({
      status: 'degraded',
      checkpoint: null,
      checkpointError: 'db down',
    });
  });
});
