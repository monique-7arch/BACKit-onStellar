import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export const CHECKPOINT_MULTI_CONTRACT = 'multi-contract';
export const CHECKPOINT_PLATFORM_SETTINGS = 'platform-settings';

export interface CheckpointStatus {
  name: string;
  lastLedger: number;
  ownerId: string | null;
  updatedAt: string;
}

/**
 * Reads and advances the durable ledger checkpoint.
 *
 * `advance` is monotonic (GREATEST) so a late write from a node that has just
 * lost the lease can never move the checkpoint backwards.
 */
@Injectable()
export class LedgerCheckpointService {
  constructor(private readonly dataSource: DataSource) {}

  async get(name: string): Promise<number | null> {
    const rows: Array<{ lastLedger: string }> = await this.dataSource.query(
      `SELECT "lastLedger" FROM "indexer_checkpoints" WHERE "name" = $1`,
      [name],
    );
    return rows.length ? Number(rows[0].lastLedger) : null;
  }

  async advance(
    name: string,
    ledger: number,
    ownerId: string | null = null,
  ): Promise<number> {
    const rows: Array<{ lastLedger: string }> = await this.dataSource.query(
      `INSERT INTO "indexer_checkpoints" ("name","lastLedger","ownerId")
       VALUES ($1,$2,$3)
       ON CONFLICT ("name") DO UPDATE SET
         "lastLedger" = GREATEST("indexer_checkpoints"."lastLedger", EXCLUDED."lastLedger"),
         "ownerId"    = EXCLUDED."ownerId",
         "updatedAt"  = now()
       RETURNING "lastLedger"`,
      [name, ledger, ownerId],
    );
    return Number(rows[0].lastLedger);
  }

  async getStatus(name: string): Promise<CheckpointStatus | null> {
    const rows: Array<{
      lastLedger: string;
      ownerId: string | null;
      updatedAt: Date;
    }> = await this.dataSource.query(
      `SELECT "lastLedger","ownerId","updatedAt"
         FROM "indexer_checkpoints" WHERE "name" = $1`,
      [name],
    );
    if (!rows.length) return null;
    return {
      name,
      lastLedger: Number(rows[0].lastLedger),
      ownerId: rows[0].ownerId,
      updatedAt: new Date(rows[0].updatedAt).toISOString(),
    };
  }
}
