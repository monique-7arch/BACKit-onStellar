import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import { MicroBatcher } from './micro-batcher';

/**
 * Bulk loading of `event_logs` for fast historical sync (BE-007).
 *
 * Two strategies, both idempotent (`ON CONFLICT DO NOTHING` on the unique
 * `(dedupeKey, ledger)` key from BE-005, so a retried batch is a no-op):
 *
 *   copy    COPY the rows into a TEMP staging table over the wire protocol,
 *           then one `INSERT ... SELECT ... ON CONFLICT DO NOTHING`. COPY
 *           cannot express ON CONFLICT itself, hence the staging table. Best
 *           for large batches.
 *   insert  Chunked multi-row `INSERT ... VALUES ... ON CONFLICT DO NOTHING`.
 *           Lower fixed cost, best for the handful of events of a live tick.
 *
 * `auto` (default) picks copy from `copyThreshold` rows upward.
 *
 * COPY uses the text format, not binary: binary needs a per-type encoder for
 * every column (jsonb, bigint, timestamp) and measured gains are small next
 * to the index maintenance that dominates, so text keeps the code auditable.
 */

export type BulkStrategy = 'auto' | 'copy' | 'insert';

export interface EventLogRow {
  eventId: string;
  dedupeKey: string;
  pagingToken: string;
  contractId: string;
  topic0: string | null;
  eventType: string;
  ledger: number;
  txHash: string;
  txOrder: number;
  eventData: unknown;
  /** ISO-8601, stored as a UTC wall-clock `timestamp`. */
  timestamp: string;
}

export interface BulkInsertResult {
  /** Dedupe keys that were really inserted (conflicts are excluded). */
  inserted: Set<string>;
  skipped: number;
  durationMs: number;
  strategy: 'copy' | 'insert';
}

export interface BulkLoaderOptions {
  strategy: BulkStrategy;
  maxBatch: number;
  maxLatencyMs: number;
  copyThreshold: number;
}

export function loadBulkLoaderOptions(
  env: Record<string, string | undefined> = process.env,
): BulkLoaderOptions {
  const num = (name: string, fallback: number) => {
    const n = Number(env[name]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const strategy = env.BULK_LOADER_STRATEGY;
  return {
    strategy:
      strategy === 'copy' || strategy === 'insert' || strategy === 'auto'
        ? strategy
        : 'auto',
    maxBatch: num('BULK_LOADER_MAX_BATCH', 5_000),
    maxLatencyMs: num('BULK_LOADER_MAX_LATENCY_MS', 500),
    copyThreshold: num('BULK_LOADER_COPY_THRESHOLD', 200),
  };
}

const COLUMNS = [
  'eventId',
  'dedupeKey',
  'pagingToken',
  'contractId',
  'topic0',
  'eventType',
  'ledger',
  'txHash',
  'txOrder',
  'eventData',
  'timestamp',
] as const;

const COLUMN_LIST = COLUMNS.map((c) => `"${c}"`).join(',');
const STAGE = '_event_logs_stage';

/** The slice of the native `pg` client that COPY needs. */
interface CopyCapableClient {
  query(copyStream: ReturnType<typeof copyFrom>): Writable;
}

/** 11 columns per row; 4,000 rows is 44,000 parameters (limit 65,535). */
const INSERT_CHUNK = 4_000;
/** Rows serialised per stream chunk, so COPY is fed incrementally. */
const COPY_CHUNK = 1_000;

/** Escape one value for COPY text format. NULL is `\N`. */
export function copyEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '\\N';
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

export function toCopyLine(row: EventLogRow): string {
  return (
    [
      row.eventId,
      row.dedupeKey,
      row.pagingToken,
      row.contractId,
      row.topic0,
      row.eventType,
      row.ledger,
      row.txHash,
      row.txOrder,
      JSON.stringify(row.eventData),
      row.timestamp,
    ]
      .map(copyEscape)
      .join('\t') + '\n'
  );
}

@Injectable()
export class BulkEventLoaderService implements OnModuleDestroy {
  private readonly logger = new Logger(BulkEventLoaderService.name);
  private readonly options: BulkLoaderOptions = loadBulkLoaderOptions();
  private readonly streams = new Set<MicroBatcher<EventLogRow>>();

  constructor(private readonly dataSource: DataSource) {}

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      [...this.streams].map((s) => s.close().catch(() => undefined)),
    );
    this.streams.clear();
  }

  getOptions(): BulkLoaderOptions {
    return { ...this.options };
  }

  /**
   * Insert rows idempotently. Pass the caller's transaction `manager` to
   * make this part of a larger atomic unit; without one it runs in its own.
   */
  async insertBatch(
    rows: EventLogRow[],
    manager?: EntityManager,
  ): Promise<BulkInsertResult> {
    if (rows.length === 0) {
      return {
        inserted: new Set(),
        skipped: 0,
        durationMs: 0,
        strategy: 'insert',
      };
    }
    if (!manager) {
      return this.dataSource.transaction((m) => this.insertBatch(rows, m));
    }

    const strategy = this.pickStrategy(rows.length);
    const started = process.hrtime.bigint();
    const inserted =
      strategy === 'copy'
        ? await this.insertViaCopy(manager, rows)
        : await this.insertViaValues(manager, rows);
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;

    return {
      inserted,
      skipped: rows.length - inserted.size,
      durationMs,
      strategy,
    };
  }

  /**
   * A buffered stream of rows: flushed at `maxBatch` rows or `maxLatencyMs`,
   * whichever comes first, each flush an idempotent bulk upsert in its own
   * transaction. Await the promise `push` may return for backpressure, and
   * `flush()`/`close()` when finished.
   */
  createRowStream(
    onBatchFailed?: (rows: EventLogRow[], error: Error) => void,
  ): MicroBatcher<EventLogRow> {
    const batcher = new MicroBatcher<EventLogRow>({
      maxItems: this.options.maxBatch,
      maxLatencyMs: this.options.maxLatencyMs,
      flush: async (rows) => {
        const res = await this.insertBatch(rows);
        this.logger.debug({
          msg: 'bulk_loader.flushed',
          rows: rows.length,
          inserted: res.inserted.size,
          skipped: res.skipped,
          strategy: res.strategy,
          durationMs: Math.round(res.durationMs),
        });
      },
      onBatchFailed: (rows, error) => {
        this.logger.error({
          msg: 'bulk_loader.batch_failed',
          rows: rows.length,
          error: error.message,
        });
        onBatchFailed?.(rows, error);
      },
    });
    this.streams.add(batcher);
    return batcher;
  }

  private pickStrategy(rowCount: number): 'copy' | 'insert' {
    const { strategy, copyThreshold } = this.options;
    if (strategy === 'copy' || strategy === 'insert') return strategy;
    return rowCount >= copyThreshold ? 'copy' : 'insert';
  }

  private async insertViaValues(
    manager: EntityManager,
    rows: EventLogRow[],
  ): Promise<Set<string>> {
    const inserted = new Set<string>();
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      const params: unknown[] = [];
      const tuples = chunk.map((r) => {
        const base = params.length;
        params.push(
          r.eventId,
          r.dedupeKey,
          r.pagingToken,
          r.contractId,
          r.topic0,
          r.eventType,
          r.ledger,
          r.txHash,
          r.txOrder,
          JSON.stringify(r.eventData),
          r.timestamp,
        );
        const p = (n: number) => `$${base + n}`;
        return `(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)}::jsonb,${p(11)}::timestamp)`;
      });
      const res: Array<{ dedupeKey: string }> = await manager.query(
        `INSERT INTO "event_logs" (${COLUMN_LIST})
         VALUES ${tuples.join(',')}
         ON CONFLICT ("dedupeKey","ledger") DO NOTHING
         RETURNING "dedupeKey"`,
        params,
      );
      for (const row of res) inserted.add(row.dedupeKey);
    }
    return inserted;
  }

  private async insertViaCopy(
    manager: EntityManager,
    rows: EventLogRow[],
  ): Promise<Set<string>> {
    await manager.query(
      `CREATE TEMP TABLE IF NOT EXISTS "${STAGE}" (
         "eventId" character varying NOT NULL,
         "dedupeKey" character varying(80),
         "pagingToken" character varying NOT NULL,
         "contractId" character varying(64) NOT NULL,
         "topic0" character varying(64),
         "eventType" character varying(50) NOT NULL,
         "ledger" bigint NOT NULL,
         "txHash" character varying(64) NOT NULL,
         "txOrder" integer NOT NULL,
         "eventData" jsonb NOT NULL,
         "timestamp" TIMESTAMP NOT NULL
       ) ON COMMIT DROP`,
    );
    // A second call in the same transaction reuses the table.
    await manager.query(`TRUNCATE "${STAGE}"`);

    // The transaction's own connection, so COPY is part of it.
    const client = (await manager.queryRunner!.connect()) as CopyCapableClient;
    const copyStream = client.query(
      copyFrom(`COPY "${STAGE}" (${COLUMN_LIST}) FROM STDIN`),
    );
    await pipeline(
      Readable.from(this.copyChunks(rows), { objectMode: false }),
      copyStream,
    );

    const res: Array<{ dedupeKey: string }> = await manager.query(
      `INSERT INTO "event_logs" (${COLUMN_LIST})
       SELECT ${COLUMN_LIST} FROM "${STAGE}"
        ORDER BY "ledger", "txOrder", "eventId"
       ON CONFLICT ("dedupeKey","ledger") DO NOTHING
       RETURNING "dedupeKey"`,
    );
    return new Set(res.map((r) => r.dedupeKey));
  }

  private *copyChunks(rows: EventLogRow[]): Generator<string> {
    for (let i = 0; i < rows.length; i += COPY_CHUNK) {
      let text = '';
      const end = Math.min(i + COPY_CHUNK, rows.length);
      for (let j = i; j < end; j++) text += toCopyLine(rows[j]);
      yield text;
    }
  }
}
