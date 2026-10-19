import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SorobanRpc } from '@stellar/stellar-sdk';
import { IndexerLeaseService } from './indexer-lease.service';
import {
  CHECKPOINT_MULTI_CONTRACT,
  LedgerCheckpointService,
} from './ledger-checkpoint.service';
import { MultiContractIndexerService } from './multi-contract-indexer.service';

/** Longest a single scheduled run may keep catching up. */
const MAX_RUN_MS = 20_000;

export type SyncOutcome =
  | { status: 'standby' }
  | { status: 'unconfigured' }
  | { status: 'caught_up'; checkpoint: number }
  | { status: 'lease_lost' }
  | {
      status: 'synced';
      checkpoint: number;
      advanced: boolean;
      /** More history is waiting; the caller should run again at once. */
      more: boolean;
      inserted: number;
      failed: number;
    };

/**
 * Scheduled multi-contract sync, run ONLY by the node that holds the lease.
 *
 * Resume rule: the next run starts at `checkpoint + 1`, where the checkpoint
 * is the durable PostgreSQL value, so a standby that takes over continues
 * exactly where the previous leader committed. On the very first run (no
 * checkpoint) it starts at INDEXER_START_LEDGER, or at the current ledger.
 *
 * Exactly-once effect: the checkpoint is advanced only after the batch is
 * committed. If a leader dies between commit and checkpoint, the successor
 * re-fetches the same ledgers and the unique event key turns every repeat
 * into a no-op, so nothing is processed twice.
 */
@Injectable()
export class IndexerSyncService {
  private readonly logger = new Logger(IndexerSyncService.name);
  private running = false;

  constructor(
    private readonly lease: IndexerLeaseService,
    private readonly checkpoints: LedgerCheckpointService,
    private readonly multiContract: MultiContractIndexerService,
    private readonly rpcServer: SorobanRpc.Server,
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async scheduledTick(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      this.logger.error({
        msg: 'indexer_sync.tick_failed',
        nodeId: this.lease.nodeId,
        error: (err as Error).message,
      });
    }
  }

  async tick(): Promise<SyncOutcome> {
    if (!this.lease.isLeader()) return { status: 'standby' };
    if (this.multiContract.getContractMap().size === 0) {
      return { status: 'unconfigured' };
    }
    if (this.running) return { status: 'standby' };
    this.running = true;
    try {
      // While far behind (historical catch-up) keep going instead of idling
      // until the next cron tick, but stay inside a time budget and stop at
      // once if the lease is lost.
      const deadline = Date.now() + MAX_RUN_MS;
      let outcome = await this.syncOnce();
      while (
        outcome.status === 'synced' &&
        outcome.more &&
        outcome.advanced &&
        this.lease.isLeader() &&
        Date.now() < deadline
      ) {
        outcome = await this.syncOnce();
      }
      return outcome;
    } finally {
      this.running = false;
    }
  }

  private async syncOnce(): Promise<SyncOutcome> {
    const latest = await this.rpcServer.getLatestLedger();
    const last = await this.checkpoints.get(CHECKPOINT_MULTI_CONTRACT);

    const configuredStart = Number(process.env.INDEXER_START_LEDGER);
    const start =
      last !== null
        ? last + 1
        : Number.isFinite(configuredStart) && configuredStart > 0
          ? configuredStart
          : latest.sequence;

    if (start > latest.sequence) {
      return { status: 'caught_up', checkpoint: last ?? latest.sequence };
    }

    const fetched = await this.multiContract.fetchEventsSince(start);
    if (!this.lease.isLeader()) return this.leaseLost('after_fetch');

    const result = await this.multiContract.ingestBatch(fetched.events);
    if (!this.lease.isLeader()) return this.leaseLost('after_ingest');

    // Failed events are safe to move past only when something durable owns
    // them (the dead-letter sink). Without one, hold the checkpoint so the
    // next run retries them; successful events dedupe, so this is harmless.
    const holdForFailures =
      result.failed.length > 0 && !this.multiContract.hasFailureSink();

    // Only claim ledgers we actually fetched. If the fetch hit its page cap,
    // stop just before the last event's ledger: that ledger may have more
    // events on the next page, and re-reading it is harmless (idempotent).
    const complete = fetched.complete !== false;
    const lastEventLedger = fetched.events.length
      ? Math.max(...fetched.events.map((e) => e.ledger))
      : start;
    const target = complete
      ? Math.max(fetched.latestLedger, latest.sequence)
      : Math.max(start - 1, lastEventLedger - 1);
    let checkpoint = last ?? start - 1;
    if (!holdForFailures) {
      checkpoint = await this.checkpoints.advance(
        CHECKPOINT_MULTI_CONTRACT,
        target,
        this.lease.nodeId,
      );
    } else {
      this.logger.warn({
        msg: 'indexer_sync.checkpoint_held',
        nodeId: this.lease.nodeId,
        failed: result.failed.length,
        checkpoint,
      });
    }

    this.logger.log({
      msg: 'indexer_sync.synced',
      nodeId: this.lease.nodeId,
      fromLedger: start,
      toLedger: target,
      events: fetched.events.length,
      inserted: result.inserted,
      duplicates: result.duplicates,
      failed: result.failed.length,
      checkpoint,
    });

    return {
      status: 'synced',
      checkpoint,
      advanced: !holdForFailures,
      more: !complete,
      inserted: result.inserted,
      failed: result.failed.length,
    };
  }

  private leaseLost(where: string): SyncOutcome {
    this.logger.warn({
      msg: 'indexer_sync.lease_lost_mid_run',
      nodeId: this.lease.nodeId,
      where,
    });
    return { status: 'lease_lost' };
  }
}
