import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SorobanRpc } from '@stellar/stellar-sdk';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IndexerService } from './indexer.service';
import { IndexerController } from './indexer.controller';
import { EventLog } from './event-log.entity';
import { EventParser } from './event-parser';
import { PlatformSettings } from './entities/platform-settings.entity';
import { PlatformSettingsService } from './platform-settings.service';
import { PlatformConfigModule } from '../config/config.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PayoutsModule } from '../payouts/payouts.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { FailedTransaction } from './entities/failed-transaction.entity';
import { DiagnosticParserService } from './diagnostic-parser.service';
import {
  INDEXER_FAILURE_SINK,
  MultiContractIndexerService,
} from './multi-contract-indexer.service';
import { IndexerEventsProcessor } from './indexer-events.processor';
import { IndexerDlqModule } from '../admin/indexer-dlq.module';
import { IndexerDlqService } from '../admin/indexer-dlq.service';
import { BulkEventLoaderService } from './bulk-event-loader.service';
import { IndexerCoordinationModule } from './indexer-coordination.module';
import { IndexerSyncService } from './indexer-sync.service';
import { IndexerCheckpoint } from './entities/indexer-checkpoint.entity';
import { FactoryMarket, FactoryStrategy } from './entities/factory.entity';
import { OrderbookOrder, OrderbookTrade } from './entities/orderbook.entity';
import { Parlay, ParlayLeg } from './entities/parlay.entity';
import { LendingAllocation, LendingPosition } from './entities/lending.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      EventLog,
      PlatformSettings,
      FailedTransaction,
      FactoryMarket,
      FactoryStrategy,
      OrderbookOrder,
      OrderbookTrade,
      Parlay,
      ParlayLeg,
      LendingPosition,
      LendingAllocation,
      IndexerCheckpoint,
    ]),
    ScheduleModule.forRoot(),
    IndexerCoordinationModule,
    IndexerDlqModule,
    PlatformConfigModule,
    NotificationsModule,
    PayoutsModule,
    TreasuryModule,
  ],
  controllers: [IndexerController],
  providers: [
    IndexerService,
    EventParser,
    PlatformSettingsService,
    DiagnosticParserService,
    BulkEventLoaderService,
    MultiContractIndexerService,
    IndexerSyncService,
    IndexerEventsProcessor,
    // Failed events go to the retry queue and, after 5 attempts, the DLQ.
    { provide: INDEXER_FAILURE_SINK, useExisting: IndexerDlqService },
    {
      provide: SorobanRpc.Server,
      useFactory: () => {
        return new SorobanRpc.Server(
          process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
        );
      },
    },
  ],
  exports: [
    IndexerService,
    DiagnosticParserService,
    BulkEventLoaderService,
    MultiContractIndexerService,
  ],
})
export class IndexerModule {}
