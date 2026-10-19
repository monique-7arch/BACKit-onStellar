import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { IndexerLeaseService } from './indexer-lease.service';
import { LedgerCheckpointService } from './ledger-checkpoint.service';

/**
 * Lease and checkpoint, kept in a small module of their own so that the
 * health module can read indexer status without importing the whole indexer
 * (RPC client, parsers, notifications).
 */
@Module({
  imports: [ConfigModule],
  providers: [IndexerLeaseService, LedgerCheckpointService],
  exports: [IndexerLeaseService, LedgerCheckpointService],
})
export class IndexerCoordinationModule {}
