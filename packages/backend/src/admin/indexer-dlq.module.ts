import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import {
  IndexerDlqService,
  QUEUE_INDEXER_DLQ,
  QUEUE_INDEXER_EVENTS,
} from './indexer-dlq.service';

/**
 * The indexer retry queue, its dead-letter queue and the service that owns
 * them. Separate from AdminModule so the indexer can use it as its failure
 * sink without depending on the admin controllers.
 */
@Module({
  imports: [
    HttpModule,
    BullModule.registerQueue({ name: QUEUE_INDEXER_EVENTS }),
    BullModule.registerQueue({ name: QUEUE_INDEXER_DLQ }),
  ],
  providers: [IndexerDlqService],
  exports: [IndexerDlqService, BullModule],
})
export class IndexerDlqModule {}
