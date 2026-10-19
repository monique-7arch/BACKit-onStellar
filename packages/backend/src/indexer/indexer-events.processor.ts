import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  IndexerDlqService,
  IndexerEventJob,
  QUEUE_INDEXER_EVENTS,
} from '../admin/indexer-dlq.service';
import { MultiContractIndexerService } from './multi-contract-indexer.service';

/**
 * Consumer of the indexer retry queue (BE-008).
 *
 * One job at a time keeps retried events roughly in order. A job that throws
 * is retried by BullMQ with exponential backoff; when the final attempt
 * fails it is parked on the dead-letter queue. Nothing here can crash the
 * worker: errors become job failures, and a failing DLQ write is logged.
 */
@Processor(QUEUE_INDEXER_EVENTS, { concurrency: 1 })
export class IndexerEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(IndexerEventsProcessor.name);

  constructor(
    private readonly indexer: MultiContractIndexerService,
    private readonly dlq: IndexerDlqService,
  ) {
    super();
  }

  async process(job: Job<IndexerEventJob>) {
    const result = await this.indexer.ingestBatch([job.data.event], undefined, {
      reportFailures: false,
    });
    if (result.failed.length > 0) throw result.failed[0].error;
    return {
      inserted: result.inserted,
      duplicates: result.duplicates,
      ignored: result.ignored,
    };
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<IndexerEventJob> | undefined, error: Error) {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      this.logger.warn({
        msg: 'indexer_events.retrying',
        eventId: job.data.event.id,
        attempt: job.attemptsMade,
        of: maxAttempts,
        error: error.message,
      });
      return;
    }
    try {
      await this.dlq.capture(job, error);
    } catch (err) {
      this.logger.error({
        msg: 'indexer_events.dlq_capture_failed',
        eventId: job.data.event.id,
        error: (err as Error).message,
      });
    }
  }
}
