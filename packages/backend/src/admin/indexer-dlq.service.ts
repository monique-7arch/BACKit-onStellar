import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { StrKey } from '@stellar/stellar-sdk';
import { firstValueFrom } from 'rxjs';
import {
  IndexerFailureSink,
  IngestFailure,
  IngestStage,
} from '../indexer/multi-contract-indexer.service';
import { RawIndexerEvent } from '../indexer/multi-contract-events';
import { parseScValXdr } from '../indexer/scval-decoder';

export const QUEUE_INDEXER_EVENTS = 'indexer-events';
export const QUEUE_INDEXER_DLQ = 'indexer-dlq';

/** Total attempts the retry queue makes before an event is dead-lettered. */
export const INDEXER_EVENT_ATTEMPTS = 5;

/** Discord rejects messages over 2,000 characters; Slack is more lenient. */
const ALERT_MAX_CHARS = 1_500;

export interface IndexerEventJob {
  event: RawIndexerEvent;
  stage: IngestStage;
  /** The error from the original in-batch failure. */
  firstError: string;
  /** How many times an admin has re-driven this event. */
  redrive: number;
  edited?: boolean;
}

export interface IndexerDlqEntry {
  id: string;
  event: RawIndexerEvent;
  stage: IngestStage;
  error: { name: string; message: string; stack: string };
  /** Attempts made by the retry queue before giving up. */
  attempts: number;
  failedAt: string;
  redriveCount: number;
  edited: boolean;
}

export interface IndexerDlqPatch {
  /** Replacement topics, base64 XDR ScVal each. */
  topic?: string[];
  /** Replacement data value, base64 XDR ScVal. */
  value?: string;
  contractId?: string;
}

export interface RetryRequest {
  ids?: string[];
  /** Re-drive the oldest entries, up to RETRY_ALL_LIMIT. */
  all?: boolean;
  patch?: IndexerDlqPatch;
}

export interface RetryResult {
  requeued: string[];
  notFound: string[];
}

const RETRY_ALL_LIMIT = 500;
const LIST_MAX = 100;

export function backoffDelayMs(env = process.env): number {
  const n = Number(env.INDEXER_QUEUE_BACKOFF_MS);
  return Number.isFinite(n) && n > 0 ? n : 1_000;
}

/** Slack and Discord both accept a JSON webhook but name the field differently. */
export function alertBody(
  url: string,
  text: string,
  format: string | undefined,
): Record<string, string> {
  const kind =
    format === 'slack' || format === 'discord'
      ? format
      : /discord(app)?\.com/i.test(url)
        ? 'discord'
        : 'slack';
  return kind === 'discord' ? { content: text } : { text };
}

/**
 * Dead-letter pipeline for indexer events (BE-008).
 *
 * Flow
 *   1. An event that cannot be decoded or persisted is handed to
 *      `handleFailure` (this class is the adapter's failure sink). The
 *      consumer carries on with the healthy events.
 *   2. The event is queued on `indexer-events`, retried up to
 *      `INDEXER_EVENT_ATTEMPTS` times with exponential backoff.
 *   3. After the last attempt `capture` parks it on `indexer-dlq` with the
 *      full stack trace and the raw event XDR, and alerts the webhook.
 *   4. An admin lists, inspects, optionally edits and re-drives it.
 *
 * Re-driving is safe: ingestion is idempotent on the Soroban event id.
 */
@Injectable()
export class IndexerDlqService implements IndexerFailureSink {
  private readonly logger = new Logger(IndexerDlqService.name);

  constructor(
    @InjectQueue(QUEUE_INDEXER_EVENTS) private readonly events: Queue,
    @InjectQueue(QUEUE_INDEXER_DLQ) private readonly dlq: Queue,
    private readonly http: HttpService,
  ) {}

  // ─── Producer side ────────────────────────────────────────────────────────

  async handleFailure(failure: IngestFailure): Promise<void> {
    const data: IndexerEventJob = {
      event: failure.event,
      stage: failure.stage,
      firstError: failure.error.message,
      redrive: 0,
    };
    await this.enqueue(data, failure.event.id);
  }

  private async enqueue(data: IndexerEventJob, jobId: string): Promise<void> {
    await this.events.add('ingest', data, {
      jobId,
      attempts: INDEXER_EVENT_ATTEMPTS,
      backoff: { type: 'exponential', delay: backoffDelayMs() },
      removeOnComplete: { age: 60 * 60 },
      // The DLQ entry is the durable record, so the failed job can go.
      removeOnFail: true,
    });
  }

  // ─── Capture ──────────────────────────────────────────────────────────────

  /** Park a job that exhausted its retries, then alert. Never throws. */
  async capture(job: Job<IndexerEventJob>, error: Error): Promise<void> {
    const entry: IndexerDlqEntry = {
      id: job.data.event.id,
      event: job.data.event,
      stage: job.data.stage,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack ?? '',
      },
      attempts: job.attemptsMade,
      failedAt: new Date().toISOString(),
      redriveCount: job.data.redrive,
      edited: job.data.edited ?? false,
    };

    // Full stack and the raw XDR, as required, so the failure can be
    // reproduced from the log alone.
    this.logger.error({
      msg: 'indexer_dlq.captured',
      eventId: entry.id,
      ledger: entry.event.ledger,
      contractId: entry.event.contractId,
      txHash: entry.event.txHash,
      stage: entry.stage,
      attempts: entry.attempts,
      error: entry.error.message,
      stack: entry.error.stack,
      rawTopicXdr: entry.event.topic,
      rawValueXdr: entry.event.value,
    });

    try {
      await this.dlq.add('dead-event', entry, {
        jobId: entry.id,
        removeOnComplete: false,
        removeOnFail: false,
      });
    } catch (err) {
      this.logger.error({
        msg: 'indexer_dlq.park_failed',
        eventId: entry.id,
        error: (err as Error).message,
      });
    }

    await this.alert(entry);
  }

  private async alert(entry: IndexerDlqEntry): Promise<void> {
    const url = process.env.INDEXER_DLQ_ALERT_WEBHOOK_URL;
    if (!url) return;
    const text = [
      `Indexer DLQ: event ${entry.id} failed after ${entry.attempts} attempts.`,
      `Ledger ${entry.event.ledger}, contract ${entry.event.contractId}, stage ${entry.stage}.`,
      `Error: ${entry.error.message}`,
      'Inspect: GET /admin/indexer/dlq/list. Re-drive: POST /admin/indexer/dlq/retry.',
    ]
      .join('\n')
      .slice(0, ALERT_MAX_CHARS);
    try {
      await firstValueFrom(
        this.http.post(
          url,
          alertBody(url, text, process.env.INDEXER_DLQ_ALERT_FORMAT),
          { timeout: 5_000 },
        ),
      );
    } catch (err) {
      // An unreachable webhook must not affect the pipeline. The URL is a
      // secret, so it is deliberately not logged.
      this.logger.warn({
        msg: 'indexer_dlq.alert_failed',
        eventId: entry.id,
        error: (err as Error).message,
      });
    }
  }

  // ─── Admin API ────────────────────────────────────────────────────────────

  async list(limit = 20, offset = 0) {
    const take = Math.min(Math.max(Math.floor(limit) || 20, 1), LIST_MAX);
    const skip = Math.max(Math.floor(offset) || 0, 0);
    const [total, jobs] = await Promise.all([
      this.dlq.getWaitingCount(),
      this.dlq.getJobs(['waiting'], skip, skip + take - 1, true),
    ]);
    return {
      total,
      limit: take,
      offset: skip,
      items: jobs.map((j) => j.data as IndexerDlqEntry),
    };
  }

  async get(id: string): Promise<IndexerDlqEntry> {
    const job = await this.dlq.getJob(id);
    if (!job) throw new NotFoundException(`DLQ entry ${id} not found`);
    return job.data as IndexerDlqEntry;
  }

  /** Validate an admin edit before it can reach the queue. */
  validatePatch(patch: IndexerDlqPatch): void {
    if (patch.topic !== undefined) {
      if (!Array.isArray(patch.topic) || patch.topic.length < 2) {
        throw new BadRequestException('patch.topic needs at least 2 entries');
      }
      patch.topic.forEach((t, i) => this.assertXdr(t, `patch.topic[${i}]`));
    }
    if (patch.value !== undefined) this.assertXdr(patch.value, 'patch.value');
    if (
      patch.contractId !== undefined &&
      !StrKey.isValidContract(patch.contractId)
    ) {
      throw new BadRequestException(
        'patch.contractId is not a valid contract id',
      );
    }
  }

  private assertXdr(value: unknown, field: string): void {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a base64 XDR string`);
    }
    try {
      parseScValXdr(value, field);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  async retry(request: RetryRequest): Promise<RetryResult> {
    const hasIds = Array.isArray(request.ids) && request.ids.length > 0;
    if (hasIds === Boolean(request.all)) {
      throw new BadRequestException('Provide either ids or all=true');
    }
    if (request.patch) {
      if (!hasIds || request.ids!.length !== 1) {
        throw new BadRequestException(
          'A patch can only be applied to exactly one id',
        );
      }
      this.validatePatch(request.patch);
    }

    let ids = request.ids ?? [];
    if (request.all) {
      const jobs = await this.dlq.getJobs(
        ['waiting'],
        0,
        RETRY_ALL_LIMIT - 1,
        true,
      );
      ids = jobs.map((j) => (j.data as IndexerDlqEntry).id);
    }

    const result: RetryResult = { requeued: [], notFound: [] };
    for (const id of new Set(ids)) {
      const job = await this.dlq.getJob(id);
      if (!job) {
        result.notFound.push(id);
        continue;
      }
      const entry = job.data as IndexerDlqEntry;
      const event: RawIndexerEvent = { ...entry.event };
      if (request.patch?.topic) event.topic = request.patch.topic;
      if (request.patch?.value) event.value = request.patch.value;
      if (request.patch?.contractId)
        event.contractId = request.patch.contractId;

      const redrive = entry.redriveCount + 1;
      // A fresh job id: the original may still be remembered by the queue.
      await this.enqueue(
        {
          event,
          stage: entry.stage,
          firstError: entry.error.message,
          redrive,
          edited: entry.edited || Boolean(request.patch),
        },
        `${entry.id}-r${redrive}`,
      );
      await job.remove();
      result.requeued.push(id);
      this.logger.log({
        msg: 'indexer_dlq.redriven',
        eventId: id,
        redrive,
        edited: Boolean(request.patch),
      });
    }
    return result;
  }
}
