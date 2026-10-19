import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventLog, EventType } from './event-log.entity';
import { IndexerService } from './indexer.service';
import { EventParser } from './event-parser';
import { IndexerLeaseService } from './indexer-lease.service';
import {
  CHECKPOINT_PLATFORM_SETTINGS,
  LedgerCheckpointService,
} from './ledger-checkpoint.service';

@Injectable()
export class PlatformSettingsService implements OnModuleInit {
  private readonly logger = new Logger(PlatformSettingsService.name);
  private lastProcessedLedger: number = 0;
  private readonly contractId: string;
  /** True until this node has (re)loaded its resume point as leader. */
  private needsResync = true;

  constructor(
    private readonly indexerService: IndexerService,
    private readonly eventParser: EventParser,
    @InjectRepository(EventLog)
    private readonly eventLogRepository: Repository<EventLog>,
    private readonly lease: IndexerLeaseService,
    private readonly checkpoints: LedgerCheckpointService,
  ) {
    this.contractId = process.env.STELLAR_CONTRACT_ID || '';
  }

  async onModuleInit() {
    await this.loadResumePoint();

    this.logger.log(
      `Platform Settings Service initialized. Last processed ledger: ${this.lastProcessedLedger}`,
    );
  }

  /**
   * Resume point = the furthest of the durable checkpoint and the latest
   * stored admin event. Read from PostgreSQL every time this node becomes
   * leader, so a standby that takes over continues from what the previous
   * leader committed, not from stale in-memory state.
   */
  private async loadResumePoint(): Promise<void> {
    try {
      const latestEvent = await this.eventLogRepository.findOne({
        where: { eventType: EventType.ADMIN_PARAMS_CHANGED },
        order: { ledger: 'DESC' },
      });
      const checkpoint = await this.checkpoints.get(
        CHECKPOINT_PLATFORM_SETTINGS,
      );
      this.lastProcessedLedger = Math.max(
        latestEvent ? Number(latestEvent.ledger) : 0,
        checkpoint ?? 0,
      );
      this.needsResync = false;
    } catch (error) {
      this.logger.warn(
        `Failed to initialize last processed ledger from database: ${(error as Error).message}`,
      );
    }
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async syncPlatformSettings() {
    try {
      // Only the lease holder indexes. A standby must not fetch or write.
      if (!this.lease.isLeader()) {
        this.needsResync = true;
        return;
      }
      if (this.needsResync) {
        await this.loadResumePoint();
        if (this.needsResync) return; // could not read it, try next tick
      }

      if (!this.contractId) {
        this.logger.warn('Contract ID not configured, skipping sync');
        return;
      }

      const latestLedger = await this.indexerService.getLatestLedger();
      const startLedger = this.lastProcessedLedger + 1;

      if (startLedger > latestLedger.sequence) {
        return; // No new ledgers to process
      }

      this.logger.debug(
        `Syncing platform settings from ledger ${startLedger} to ${latestLedger.sequence}`,
      );

      const eventsResponse = await this.indexerService.fetchContractEvents(
        this.contractId,
        startLedger,
      );

      for (const event of eventsResponse.events) {
        // Stop mid-batch if the lease lapsed: the new leader owns it now.
        if (!this.lease.isLeader()) {
          this.needsResync = true;
          return;
        }
        const parsedEvent = this.eventParser.parseEvent(event);

        if (
          parsedEvent &&
          parsedEvent.eventType === EventType.ADMIN_PARAMS_CHANGED
        ) {
          // Save event to database
          const eventLog = this.eventLogRepository.create({
            eventId: `${event.ledger}-${event.id}`,
            pagingToken: event.pagingToken,
            contractId: parsedEvent.contractId,
            eventType: parsedEvent.eventType,
            ledger: parsedEvent.ledger,
            txHash: parsedEvent.txHash,
            txOrder: Number(parsedEvent.txOrder),
            eventData: parsedEvent.eventData as Record<string, unknown>,
            timestamp: parsedEvent.timestamp,
          });

          await this.eventLogRepository.save(eventLog);

          // Update platform settings
          const { paramName, newValue } = parsedEvent.eventData as {
            paramName: string;
            newValue: number;
          };
          await this.indexerService.updatePlatformSettings(
            paramName,
            newValue,
            parsedEvent.txHash,
            parsedEvent.ledger,
          );

          this.logger.log(
            `Updated platform setting: ${paramName} = ${newValue} (ledger: ${parsedEvent.ledger})`,
          );
        }
      }

      this.lastProcessedLedger = latestLedger.sequence;
      await this.checkpoints.advance(
        CHECKPOINT_PLATFORM_SETTINGS,
        latestLedger.sequence,
        this.lease.nodeId,
      );
    } catch (error) {
      this.logger.error('Failed to sync platform settings', error);
    }
  }
}
