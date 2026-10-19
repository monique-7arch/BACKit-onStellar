import {
  Controller,
  Get,
  ServiceUnavailableException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiResponse,
} from '@nestjs/swagger';
import { ShutdownService } from './shutdown.service';
import { IndexerLeaseService } from '../indexer/indexer-lease.service';
import {
  CHECKPOINT_MULTI_CONTRACT,
  LedgerCheckpointService,
} from '../indexer/ledger-checkpoint.service';

@ApiTags('health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  private readonly rpcUrl: string;

  constructor(
    private readonly dataSource: DataSource,
    private readonly httpService: HttpService,
    private readonly shutdownService: ShutdownService,
    private readonly indexerLease: IndexerLeaseService,
    private readonly ledgerCheckpoints: LedgerCheckpointService,
  ) {
    this.rpcUrl =
      process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
  }

  @Get()
  @ApiOperation({
    summary: 'Health check',
    description:
      'Checks PostgreSQL, Stellar RPC, and process memory. Returns 200 only if all critical subsystems are healthy.',
  })
  @ApiOkResponse({
    description: 'All subsystems healthy',
    schema: {
      example: {
        status: 'ok',
        database: 'connected',
        stellar_rpc: 'reachable',
        memory_heap_mb: 42,
        timestamp: '2024-01-26T10:30:00.000Z',
      },
    },
  })
  @ApiResponse({
    status: 503,
    description: 'One or more subsystems are unhealthy',
    schema: {
      example: {
        status: 'error',
        database: 'disconnected',
        stellar_rpc: 'unreachable',
        memory_heap_mb: 42,
        timestamp: '2024-01-26T10:30:00.000Z',
      },
    },
  })
  async check() {
    const [database, stellar_rpc] = await Promise.all([
      this.checkDatabase(),
      this.checkStellarRpc(),
    ]);
    const memory_heap_mb = this.checkMemory();

    const status =
      database === 'connected' && stellar_rpc === 'reachable' ? 'ok' : 'error';

    const payload = {
      status,
      version: process.env.npm_package_version ?? '1.0.0',
      apiVersion: 'v1',
      database,
      stellar_rpc,
      memory_heap_mb,
      timestamp: new Date().toISOString(),
    };

    // Return 503 so load balancers and uptime monitors react correctly
    if (status === 'error') {
      throw new ServiceUnavailableException(payload);
    }

    return payload;
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Returns 200 when the application is ready to serve traffic. ' +
      'Returns 503 during graceful shutdown so load balancers stop routing new requests.',
  })
  @ApiOkResponse({ description: 'Application is ready' })
  @ApiResponse({ status: 503, description: 'Application is shutting down' })
  ready() {
    if (this.shutdownService.isShuttingDown()) {
      throw new ServiceUnavailableException({ status: 'shutting_down' });
    }
    return { status: 'ready' };
  }

  @Get('indexer')
  @ApiOperation({
    summary: 'Indexer leadership and checkpoint status',
    description:
      'Reports whether this node is the indexer leader or a standby, who holds the Redis lease, ' +
      'and the last committed ledger checkpoint. A standby is healthy: it returns 200. ' +
      'Returns 503 only when Redis (the lease store) is unreachable.',
  })
  @ApiOkResponse({
    description: 'Indexer coordination is working',
    schema: {
      example: {
        status: 'ok',
        role: 'standby',
        nodeId: 'indexer-1',
        leaseHolder: 'indexer-0',
        leaseTtlRemainingMs: 7400,
        leaderless: false,
        checkpoint: {
          name: 'multi-contract',
          lastLedger: 1234567,
          ownerId: 'indexer-0',
          updatedAt: '2024-01-26T10:30:00.000Z',
        },
        timestamp: '2024-01-26T10:30:00.000Z',
      },
    },
  })
  @ApiResponse({ status: 503, description: 'Redis lease store unreachable' })
  async indexer() {
    const [cluster, checkpoint] = await Promise.all([
      this.indexerLease.getCluster(),
      this.ledgerCheckpoints
        .getStatus(CHECKPOINT_MULTI_CONTRACT)
        .then((value) => ({ value, error: null as string | null }))
        .catch((err: Error) => ({ value: null, error: err.message })),
    ]);
    const lease = this.indexerLease.getStatus();

    const payload = {
      status:
        cluster.redis === 'unreachable'
          ? 'error'
          : checkpoint.error
            ? 'degraded'
            : 'ok',
      role: lease.isLeader ? 'leader' : 'standby',
      nodeId: lease.nodeId,
      leaseDisabled: lease.leaseDisabled,
      redis: cluster.redis,
      leaseHolder: cluster.holder,
      leaseTtlRemainingMs: cluster.ttlRemainingMs,
      // No holder while Redis is up means a failover is in progress (or no
      // node is running the indexer). Informational, not a failure.
      leaderless: cluster.redis === 'connected' && cluster.holder === null,
      leaseExpiresAt: lease.expiresAt
        ? new Date(lease.expiresAt).toISOString()
        : null,
      transitions: lease.transitions,
      checkpoint: checkpoint.value,
      checkpointError: checkpoint.error,
      timestamp: new Date().toISOString(),
    };

    if (payload.status === 'error') {
      throw new ServiceUnavailableException(payload);
    }
    return payload;
  }

  // ─── Private Checks ───────────────────────────────────────────────────────

  private async checkDatabase(): Promise<'connected' | 'disconnected'> {
    try {
      await this.dataSource.query('SELECT 1');
      return 'connected';
    } catch {
      return 'disconnected';
    }
  }

  private async checkStellarRpc(): Promise<'reachable' | 'unreachable'> {
    try {
      const { status } = await firstValueFrom(
        this.httpService.post(
          this.rpcUrl,
          { jsonrpc: '2.0', id: 1, method: 'getHealth', params: [] },
          { timeout: 5000 },
        ),
      );
      return status === 200 ? 'reachable' : 'unreachable';
    } catch {
      return 'unreachable';
    }
  }

  private checkMemory(): number {
    const bytes = process.memoryUsage().heapUsed;
    return Math.round(bytes / 1024 / 1024);
  }
}
