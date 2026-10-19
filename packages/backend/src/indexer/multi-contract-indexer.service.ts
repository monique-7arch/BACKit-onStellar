import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { SorobanRpc } from '@stellar/stellar-sdk';
import { retryWithBackoff } from '../utils/retry';
import {
  ContractMap,
  DecodedContractEvent,
  RawIndexerEvent,
  compareEventIds,
  decodeContractEvent,
  loadContractMap,
  toRawIndexerEvent,
  txOrderOf,
} from './multi-contract-events';
import { ScValDecodeError } from './scval-decoder';
import {
  BulkEventLoaderService,
  EventLogRow,
} from './bulk-event-loader.service';
import { MicroBatcher } from './micro-batcher';

/** Largest leg count we will seed rows for. The contract itself caps at 10. */
const MAX_PARLAY_LEGS = 100;

/** Soroban RPC page size for getEvents. */
const RPC_PAGE_LIMIT = 200;

export const INDEXER_FAILURE_SINK = Symbol('INDEXER_FAILURE_SINK');

export type IngestStage = 'decode' | 'persist';

export interface IngestFailure {
  event: RawIndexerEvent;
  stage: IngestStage;
  error: Error;
}

/**
 * Receives events that could not be ingested (malformed payload, projection
 * conflict). The dead-letter pipeline (BE-008) implements this; without a
 * sink, failures are logged and returned to the caller.
 */
export interface IndexerFailureSink {
  handleFailure(failure: IngestFailure): Promise<void>;
}

export interface IngestOptions {
  /** Hand failures to the failure sink. Default true. */
  reportFailures?: boolean;
}

export interface IngestResult {
  received: number;
  /** Rows newly written to event_logs and projected. */
  inserted: number;
  /** Already ingested (idempotent replay), skipped without side effects. */
  duplicates: number;
  /** Not for us: unconfigured contract, unknown event, failed call. */
  ignored: number;
  failed: IngestFailure[];
}

export interface FetchedEvents {
  events: RawIndexerEvent[];
  latestLedger: number;
  /**
   * False when the page cap was reached with more events still waiting. The
   * caller must then NOT treat everything up to `latestLedger` as fetched.
   */
  complete: boolean;
}

interface DecodedItem {
  raw: RawIndexerEvent;
  decoded: DecodedContractEvent;
}

interface PersistStats {
  inserted: number;
  duplicates: number;
}

@Injectable()
export class MultiContractIndexerService {
  private readonly logger = new Logger(MultiContractIndexerService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly rpcServer: SorobanRpc.Server,
    @Optional()
    @Inject(INDEXER_FAILURE_SINK)
    private readonly failureSink?: IndexerFailureSink,
    @Optional()
    bulkLoader?: BulkEventLoaderService,
  ) {
    this.bulkLoader = bulkLoader ?? new BulkEventLoaderService(dataSource);
  }

  private readonly bulkLoader: BulkEventLoaderService;

  /** True when failed events are handed to a durable dead-letter sink. */
  hasFailureSink(): boolean {
    return this.failureSink !== undefined;
  }

  /** Contract ids this adapter listens to (from the environment). */
  getContractMap(): Map<string, string> {
    return loadContractMap() as Map<string, string>;
  }

  // ─── Fetching ─────────────────────────────────────────────────────────────

  /**
   * Fetch every event for the configured contracts from `startLedger`
   * onwards, following the RPC cursor. Returns the raw (XDR) events.
   */
  async fetchEventsSince(
    startLedger: number,
    maxPages = 50,
  ): Promise<FetchedEvents> {
    const contractIds = [...loadContractMap().keys()];
    if (contractIds.length === 0) {
      return { events: [], latestLedger: 0, complete: true };
    }

    const filters = [{ type: 'contract' as const, contractIds }];
    const events: RawIndexerEvent[] = [];
    let latestLedger = 0;
    let cursor: string | undefined;
    let complete = false;

    for (let page = 0; page < maxPages; page++) {
      const response = await retryWithBackoff(
        () =>
          this.rpcServer.getEvents(
            cursor
              ? { filters, cursor, limit: RPC_PAGE_LIMIT }
              : { filters, startLedger, limit: RPC_PAGE_LIMIT },
          ),
        4,
        1000,
        'multiContract.getEvents',
      );
      latestLedger = response.latestLedger;
      for (const e of response.events) events.push(toRawIndexerEvent(e));
      if (response.events.length < RPC_PAGE_LIMIT) {
        complete = true;
        break;
      }
      cursor = response.events[response.events.length - 1].pagingToken;
    }

    return { events, latestLedger, complete };
  }

  // ─── Ingestion ────────────────────────────────────────────────────────────

  /**
   * Decode and persist a batch.
   *
   * Atomicity: the whole batch is written in ONE transaction, event log rows
   * and every relational projection together. If any statement fails, nothing
   * from the batch is committed. The batch is then retried one event at a
   * time (each in its own transaction) so a single poison event cannot block
   * the rest; the poison event is reported in `failed`.
   *
   * Idempotency: event_logs rows are inserted with ON CONFLICT DO NOTHING on
   * the Soroban event id. Only events that were really inserted are
   * projected, so replaying a batch cannot double-count anything.
   */
  async ingestBatch(
    events: RawIndexerEvent[],
    contracts: ContractMap = loadContractMap(),
    options: IngestOptions = {},
  ): Promise<IngestResult> {
    const result: IngestResult = {
      received: events.length,
      inserted: 0,
      duplicates: 0,
      ignored: 0,
      failed: [],
    };

    const items = new Map<string, DecodedItem>();
    for (const raw of events) {
      try {
        const outcome = decodeContractEvent(raw, contracts);
        if (outcome.status === 'ignored') {
          result.ignored++;
          continue;
        }
        // Same event delivered twice in one batch: keep the first copy.
        if (!items.has(raw.id)) {
          items.set(raw.id, { raw, decoded: outcome.event });
        } else {
          result.duplicates++;
        }
      } catch (err) {
        result.failed.push({
          event: raw,
          stage: 'decode',
          error: err as Error,
        });
      }
    }

    const ordered = [...items.values()].sort((a, b) =>
      compareEventIds(a.raw.id, b.raw.id),
    );

    if (ordered.length > 0) {
      await this.persistWithFallback(ordered, result);
    }

    // The retry-queue consumer sets reportFailures=false: it already owns
    // the failure, and reporting it again would re-queue it forever.
    if (options.reportFailures !== false) {
      for (const failure of result.failed) {
        await this.reportFailure(failure);
      }
    }

    this.logger.log({
      msg: 'multi_contract.batch_ingested',
      received: result.received,
      inserted: result.inserted,
      duplicates: result.duplicates,
      ignored: result.ignored,
      failed: result.failed.length,
    });

    return result;
  }

  private async persistWithFallback(
    ordered: DecodedItem[],
    result: IngestResult,
  ): Promise<void> {
    try {
      const stats = await this.dataSource.transaction((manager) =>
        this.persist(manager, ordered),
      );
      result.inserted += stats.inserted;
      result.duplicates += stats.duplicates;
      return;
    } catch (batchError) {
      if (ordered.length === 1) {
        result.failed.push({
          event: ordered[0].raw,
          stage: 'persist',
          error: batchError as Error,
        });
        return;
      }
      this.logger.warn({
        msg: 'multi_contract.batch_rolled_back_retrying_per_event',
        events: ordered.length,
        error: (batchError as Error).message,
      });
    }

    for (const item of ordered) {
      try {
        const stats = await this.dataSource.transaction((manager) =>
          this.persist(manager, [item]),
        );
        result.inserted += stats.inserted;
        result.duplicates += stats.duplicates;
      } catch (err) {
        result.failed.push({
          event: item.raw,
          stage: 'persist',
          error: err as Error,
        });
      }
    }
  }

  private async reportFailure(failure: IngestFailure): Promise<void> {
    this.logger.error({
      msg: 'multi_contract.event_failed',
      eventId: failure.event.id,
      ledger: failure.event.ledger,
      contractId: failure.event.contractId,
      txHash: failure.event.txHash,
      stage: failure.stage,
      error: failure.error.message,
      malformed: failure.error instanceof ScValDecodeError,
    });
    if (!this.failureSink) return;
    try {
      await this.failureSink.handleFailure(failure);
    } catch (sinkError) {
      // A broken sink must never stop ingestion of the healthy events.
      this.logger.error({
        msg: 'multi_contract.failure_sink_error',
        eventId: failure.event.id,
        error: (sinkError as Error).message,
      });
    }
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private async persist(
    manager: EntityManager,
    items: DecodedItem[],
  ): Promise<PersistStats> {
    const insertedKeys = await this.insertEventLogs(manager, items);

    let inserted = 0;
    let duplicates = 0;
    for (const item of items) {
      if (!insertedKeys.has(item.raw.id)) {
        duplicates++;
        continue;
      }
      await this.project(manager, item);
      inserted++;
    }
    return { inserted, duplicates };
  }

  /**
   * Write the event log rows through the bulk loader (COPY for large
   * batches, multi-row INSERT for small ones), inside the caller's
   * transaction. Returns the dedupe keys that were really inserted;
   * conflicts are skipped, which is what makes replays harmless.
   */
  private async insertEventLogs(
    manager: EntityManager,
    items: DecodedItem[],
  ): Promise<Set<string>> {
    const rows: EventLogRow[] = items.map(({ raw, decoded }) => ({
      eventId: raw.id,
      dedupeKey: raw.id,
      pagingToken: raw.pagingToken,
      contractId: raw.contractId,
      topic0: decoded.name,
      eventType: decoded.eventType,
      ledger: raw.ledger,
      txHash: raw.txHash,
      txOrder: txOrderOf(raw.id),
      eventData: {
        contract: decoded.kind,
        namespace: decoded.namespace,
        event: decoded.name,
        fields: decoded.fields,
        extra: decoded.extra,
      },
      timestamp: new Date(raw.ledgerClosedAt).toISOString(),
    }));
    const result = await this.bulkLoader.insertBatch(rows, manager);
    return result.inserted;
  }

  /**
   * A buffered ingestion stream: events are flushed through `ingestBatch`
   * at the loader's batch size or latency, whichever comes first. Use it
   * from producers that emit events one at a time.
   */
  createIngestStream(): MicroBatcher<RawIndexerEvent> {
    const { maxBatch, maxLatencyMs } = this.bulkLoader.getOptions();
    return new MicroBatcher<RawIndexerEvent>({
      maxItems: maxBatch,
      maxLatencyMs,
      flush: async (events) => {
        await this.ingestBatch(events);
      },
    });
  }

  // ─── Relational projections ───────────────────────────────────────────────

  private async project(
    manager: EntityManager,
    { raw, decoded }: DecodedItem,
  ): Promise<void> {
    const f = decoded.fields;
    const ledger = raw.ledger;
    const contractId = raw.contractId;

    switch (`${decoded.kind}:${decoded.name}`) {
      // PredictionMarketFactory
      case 'factory:initialized':
        // Recorded in event_logs only, nothing relational to project.
        return;

      case 'factory:MarketDeployed':
        await manager.query(
          `INSERT INTO "factory_markets"
             ("callId","marketAddress","creator","stakeToken","endTs",
              "factoryContractId","ledger","txHash")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT ("callId") DO NOTHING`,
          [
            f.callId,
            f.marketAddress,
            f.creator,
            f.stakeToken,
            f.endTs,
            contractId,
            ledger,
            raw.txHash,
          ],
        );
        return;

      case 'factory:StrategyCreated':
        await manager.query(
          `INSERT INTO "factory_strategies"
             ("strategyId","user","escrowAmount","status","createdLedger","updatedLedger")
           VALUES ($1,$2,$3,'created',$4,$4)
           ON CONFLICT ("strategyId") DO NOTHING`,
          [f.strategyId, f.user, f.escrowAmount, ledger],
        );
        return;

      case 'factory:StrategyExecuted':
        await this.updateExpectingRow(
          manager,
          decoded,
          `UPDATE "factory_strategies"
              SET "status"='executed', "actionsExecuted"=$2, "keeperReward"=$3,
                  "updatedLedger"=$4, "updatedAt"=now()
            WHERE "strategyId"=$1`,
          [f.strategyId, f.actionsExecuted, f.keeperReward, ledger],
        );
        return;

      case 'factory:StrategyCancelled':
        await this.updateExpectingRow(
          manager,
          decoded,
          `UPDATE "factory_strategies"
              SET "status"='cancelled', "updatedLedger"=$2, "updatedAt"=now()
            WHERE "strategyId"=$1`,
          [f.strategyId, ledger],
        );
        return;

      // Orderbook
      case 'orderbook:OrderPlaced':
        await manager.query(
          `INSERT INTO "orderbook_orders"
             ("orderId","user","callId","outcome","side","status",
              "orderbookContractId","placedLedger","placedTxHash")
           VALUES ($1,$2,$3,$4,$5,'open',$6,$7,$8)
           ON CONFLICT ("orderId") DO NOTHING`,
          [
            f.orderId,
            f.user,
            f.callId,
            f.outcome,
            f.isBid ? 'bid' : 'ask',
            contractId,
            ledger,
            raw.txHash,
          ],
        );
        return;

      case 'orderbook:OrderCancelled':
        await this.updateExpectingRow(
          manager,
          decoded,
          `UPDATE "orderbook_orders"
              SET "status"='cancelled', "cancelledLedger"=$2, "updatedAt"=now()
            WHERE "orderId"=$1`,
          [f.orderId, ledger],
        );
        return;

      case 'orderbook:OrderExecuted':
        await manager.query(
          `INSERT INTO "orderbook_trades"
             ("eventId","maker","taker","callId","outcome","amount","priceBps",
              "orderbookContractId","ledger","txHash","executedAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT ("eventId") DO NOTHING`,
          [
            raw.id,
            f.maker,
            f.taker,
            f.callId,
            f.outcome,
            f.amount,
            f.priceBps,
            contractId,
            ledger,
            raw.txHash,
            new Date(raw.ledgerClosedAt).toISOString(),
          ],
        );
        return;

      // ParlayBetting
      case 'parlay:created': {
        const legCount = f.legCount as number;
        if (legCount > MAX_PARLAY_LEGS) {
          throw new ScValDecodeError(
            `leg count ${legCount} exceeds the supported maximum of ${MAX_PARLAY_LEGS}`,
            'created.legCount',
          );
        }
        await manager.query(
          `INSERT INTO "parlays"
             ("parlayId","user","initialStake","legCount","status",
              "parlayContractId","createdLedger","updatedLedger")
           VALUES ($1,$2,$3,$4,'active',$5,$6,$6)
           ON CONFLICT ("parlayId") DO NOTHING`,
          [f.parlayId, f.user, f.initialStake, legCount, contractId, ledger],
        );
        // One pending leg row per leg, so the multi-leg shape exists from
        // the start and `leg_resolved` only has to fill in the outcome.
        await manager.query(
          `INSERT INTO "parlay_legs" ("parlayId","legIndex")
           SELECT $1, g FROM generate_series(0, $2::int - 1) AS g
           ON CONFLICT ("parlayId","legIndex") DO NOTHING`,
          [f.parlayId, legCount],
        );
        return;
      }

      case 'parlay:leg_resolved': {
        // Only the first resolution of a leg counts: the WHERE clause makes
        // a repeated resolution a no-op, so counters are never inflated.
        const firstResolution: unknown[] = await manager.query(
          `INSERT INTO "parlay_legs" ("parlayId","legIndex","won","resolvedLedger")
           VALUES ($1,$2,$3,$4)
           ON CONFLICT ("parlayId","legIndex") DO UPDATE
             SET "won"=EXCLUDED."won", "resolvedLedger"=EXCLUDED."resolvedLedger"
           WHERE "parlay_legs"."won" IS NULL
           RETURNING 1`,
          [f.parlayId, f.legIndex, f.won, ledger],
        );
        if (firstResolution.length > 0) {
          await this.updateExpectingRow(
            manager,
            decoded,
            `UPDATE "parlays"
                SET "legsResolved"="legsResolved"+1,
                    "legsWon"="legsWon" + CASE WHEN $2::boolean THEN 1 ELSE 0 END,
                    "updatedLedger"=$3, "updatedAt"=now()
              WHERE "parlayId"=$1`,
            [f.parlayId, f.won, ledger],
          );
        }
        return;
      }

      case 'parlay:completed':
        await this.updateExpectingRow(
          manager,
          decoded,
          `UPDATE "parlays"
              SET "status"='completed', "totalPayout"=$2,
                  "updatedLedger"=$3, "updatedAt"=now()
            WHERE "parlayId"=$1`,
          [f.parlayId, f.totalPayout, ledger],
        );
        return;

      case 'parlay:voided':
        await this.updateExpectingRow(
          manager,
          decoded,
          `UPDATE "parlays"
              SET "status"='voided', "voidReason"=$2,
                  "updatedLedger"=$3, "updatedAt"=now()
            WHERE "parlayId"=$1`,
          [f.parlayId, f.reason, ledger],
        );
        return;

      // LendingPool: all arithmetic happens in the database on numeric(39,0)
      case 'lending:Deposited':
        await manager.query(
          `INSERT INTO "lending_positions"
             ("user","lpShares","totalDeposited","totalWithdrawn","lastLedger")
           VALUES ($1,$3::numeric,$2::numeric,0,$4)
           ON CONFLICT ("user") DO UPDATE SET
             "lpShares"="lending_positions"."lpShares"+EXCLUDED."lpShares",
             "totalDeposited"="lending_positions"."totalDeposited"+EXCLUDED."totalDeposited",
             "lastLedger"=GREATEST("lending_positions"."lastLedger",EXCLUDED."lastLedger"),
             "updatedAt"=now()`,
          [f.user, f.amount, f.lpSharesMinted, ledger],
        );
        return;

      case 'lending:Withdrawn':
        await manager.query(
          `INSERT INTO "lending_positions"
             ("user","lpShares","totalDeposited","totalWithdrawn","lastLedger")
           VALUES ($1,0-$2::numeric,0,$3::numeric,$4)
           ON CONFLICT ("user") DO UPDATE SET
             "lpShares"="lending_positions"."lpShares"+EXCLUDED."lpShares",
             "totalWithdrawn"="lending_positions"."totalWithdrawn"+EXCLUDED."totalWithdrawn",
             "lastLedger"=GREATEST("lending_positions"."lastLedger",EXCLUDED."lastLedger"),
             "updatedAt"=now()`,
          [f.user, f.lpSharesBurned, f.amountOut, ledger],
        );
        return;

      case 'lending:CapitalAllocated':
        await manager.query(
          `INSERT INTO "lending_allocations"
             ("callId","position","marketAddress","allocatedAmount","lastLedger")
           VALUES ($1,$2,$3,$4::numeric,$5)
           ON CONFLICT ("callId","position") DO UPDATE SET
             "allocatedAmount"="lending_allocations"."allocatedAmount"+EXCLUDED."allocatedAmount",
             "marketAddress"=EXCLUDED."marketAddress",
             "lastLedger"=GREATEST("lending_allocations"."lastLedger",EXCLUDED."lastLedger"),
             "updatedAt"=now()`,
          [f.callId, f.position, f.marketAddress, f.amount, ledger],
        );
        return;

      case 'lending:YieldHarvested':
        await this.updateExpectingRow(
          manager,
          decoded,
          `UPDATE "lending_allocations"
              SET "harvested"=true, "won"=$2, "grossChange"=$3, "protocolFee"=$4,
                  "netYield"=$5,
                  "lastLedger"=GREATEST("lastLedger",$6::bigint), "updatedAt"=now()
            WHERE "callId"=$1`,
          [f.callId, f.won, f.grossChange, f.protocolFee, f.netYield, ledger],
        );
        return;

      default:
        throw new ScValDecodeError(
          `no projection for ${decoded.kind}:${decoded.name}`,
        );
    }
  }

  /**
   * Run an UPDATE that should hit a row. If the parent row is missing (the
   * indexer started mid-history), warn and carry on: the event is still in
   * event_logs and the projection can be rebuilt from it.
   */
  private async updateExpectingRow(
    manager: EntityManager,
    decoded: DecodedContractEvent,
    sql: string,
    params: unknown[],
  ): Promise<void> {
    const res = await manager.queryRunner!.query(sql, params, true);
    if (!res.affected) {
      this.logger.warn({
        msg: 'multi_contract.projection_target_missing',
        event: `${decoded.kind}:${decoded.name}`,
        fields: decoded.fields,
      });
    }
  }
}
