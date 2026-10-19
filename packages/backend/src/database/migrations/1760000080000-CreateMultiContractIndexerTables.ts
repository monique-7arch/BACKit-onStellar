import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Relational projections for the multi-contract ingestion adapter (BE-005):
 * PredictionMarketFactory, Orderbook, ParlayBetting and LendingPool.
 *
 * It also adds an idempotency key to the partitioned `event_logs` table:
 *
 *   "dedupeKey"  nullable, holds the Soroban event id for rows written by the
 *                multi-contract pipeline.
 *   UNIQUE ("dedupeKey", "ledger")  the ledger is in the key because
 *                PostgreSQL requires the partition key in every unique
 *                constraint of a partitioned table.
 *
 * The column is nullable on purpose. Rows written by the older indexers keep
 * NULL, and NULLs never collide in a unique index, so their behaviour is
 * unchanged. Adding a nullable column with no default is a metadata-only
 * change, so it does not rewrite the table.
 *
 * Integer widths: u64 ids are numeric(20,0) and i128 amounts are numeric(39,0)
 * so no value can lose precision. Plain bigint cannot hold a full u64.
 */
export class CreateMultiContractIndexerTables1760000080000 implements MigrationInterface {
  name = 'CreateMultiContractIndexerTables1760000080000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "event_logs" ADD COLUMN IF NOT EXISTS "dedupeKey" character varying(80)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_event_logs_dedupeKey_ledger"
         ON "event_logs" ("dedupeKey", "ledger")`,
    );

    // PredictionMarketFactory
    await queryRunner.query(`
      CREATE TABLE "factory_markets" (
        "callId"            numeric(20,0) NOT NULL,
        "marketAddress"     character varying(64) NOT NULL,
        "creator"           character varying(64) NOT NULL,
        "stakeToken"        character varying(64) NOT NULL,
        "endTs"             numeric(20,0) NOT NULL,
        "factoryContractId" character varying(64) NOT NULL,
        "ledger"            bigint NOT NULL,
        "txHash"            character varying(64) NOT NULL,
        "createdAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_factory_markets" PRIMARY KEY ("callId")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_factory_markets_creator" ON "factory_markets" ("creator")`,
    );

    await queryRunner.query(`
      CREATE TABLE "factory_strategies" (
        "strategyId"      numeric(20,0) NOT NULL,
        "user"            character varying(64) NOT NULL,
        "escrowAmount"    numeric(39,0) NOT NULL,
        "status"          character varying(16) NOT NULL DEFAULT 'created',
        "actionsExecuted" integer,
        "keeperReward"    numeric(39,0),
        "createdLedger"   bigint NOT NULL,
        "updatedLedger"   bigint NOT NULL,
        "createdAt"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_factory_strategies" PRIMARY KEY ("strategyId")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_factory_strategies_user" ON "factory_strategies" ("user")`,
    );

    // Orderbook
    await queryRunner.query(`
      CREATE TABLE "orderbook_orders" (
        "orderId"             numeric(20,0) NOT NULL,
        "user"                character varying(64) NOT NULL,
        "callId"              numeric(20,0) NOT NULL,
        "outcome"             integer NOT NULL,
        "side"                character varying(3) NOT NULL,
        "status"              character varying(16) NOT NULL DEFAULT 'open',
        "orderbookContractId" character varying(64) NOT NULL,
        "placedLedger"        bigint NOT NULL,
        "placedTxHash"        character varying(64) NOT NULL,
        "cancelledLedger"     bigint,
        "createdAt"           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_orderbook_orders" PRIMARY KEY ("orderId"),
        CONSTRAINT "CHK_orderbook_orders_side" CHECK ("side" IN ('bid', 'ask'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_orderbook_orders_book"
         ON "orderbook_orders" ("callId", "outcome", "side", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orderbook_orders_user" ON "orderbook_orders" ("user")`,
    );

    await queryRunner.query(`
      CREATE TABLE "orderbook_trades" (
        "eventId"             character varying(80) NOT NULL,
        "maker"               character varying(64) NOT NULL,
        "taker"               character varying(64) NOT NULL,
        "callId"              numeric(20,0) NOT NULL,
        "outcome"             integer NOT NULL,
        "amount"              numeric(39,0) NOT NULL,
        "priceBps"            integer NOT NULL,
        "orderbookContractId" character varying(64) NOT NULL,
        "ledger"              bigint NOT NULL,
        "txHash"              character varying(64) NOT NULL,
        "executedAt"          TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_orderbook_trades" PRIMARY KEY ("eventId")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_orderbook_trades_market"
         ON "orderbook_trades" ("callId", "outcome", "ledger")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orderbook_trades_maker" ON "orderbook_trades" ("maker")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orderbook_trades_taker" ON "orderbook_trades" ("taker")`,
    );

    // ParlayBetting
    await queryRunner.query(`
      CREATE TABLE "parlays" (
        "parlayId"         numeric(20,0) NOT NULL,
        "user"             character varying(64) NOT NULL,
        "initialStake"     numeric(39,0) NOT NULL,
        "legCount"         integer NOT NULL,
        "status"           character varying(16) NOT NULL DEFAULT 'active',
        "legsResolved"     integer NOT NULL DEFAULT 0,
        "legsWon"          integer NOT NULL DEFAULT 0,
        "totalPayout"      numeric(39,0),
        "voidReason"       character varying(32),
        "parlayContractId" character varying(64) NOT NULL,
        "createdLedger"    bigint NOT NULL,
        "updatedLedger"    bigint NOT NULL,
        "createdAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_parlays" PRIMARY KEY ("parlayId")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_parlays_user" ON "parlays" ("user")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_parlays_status" ON "parlays" ("status")`,
    );

    await queryRunner.query(`
      CREATE TABLE "parlay_legs" (
        "parlayId"       numeric(20,0) NOT NULL,
        "legIndex"       integer NOT NULL,
        "won"            boolean,
        "resolvedLedger" bigint,
        CONSTRAINT "PK_parlay_legs" PRIMARY KEY ("parlayId", "legIndex")
      )
    `);

    // LendingPool
    await queryRunner.query(`
      CREATE TABLE "lending_positions" (
        "user"           character varying(64) NOT NULL,
        "lpShares"       numeric(39,0) NOT NULL DEFAULT '0',
        "totalDeposited" numeric(39,0) NOT NULL DEFAULT '0',
        "totalWithdrawn" numeric(39,0) NOT NULL DEFAULT '0',
        "lastLedger"     bigint NOT NULL,
        "createdAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_lending_positions" PRIMARY KEY ("user")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "lending_allocations" (
        "callId"          numeric(20,0) NOT NULL,
        "position"        integer NOT NULL,
        "marketAddress"   character varying(64) NOT NULL,
        "allocatedAmount" numeric(39,0) NOT NULL DEFAULT '0',
        "harvested"       boolean NOT NULL DEFAULT false,
        "won"             boolean,
        "grossChange"     numeric(39,0),
        "protocolFee"     numeric(39,0),
        "netYield"        numeric(39,0),
        "lastLedger"      bigint NOT NULL,
        "createdAt"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_lending_allocations" PRIMARY KEY ("callId", "position")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'lending_allocations',
      'lending_positions',
      'parlay_legs',
      'parlays',
      'orderbook_trades',
      'orderbook_orders',
      'factory_strategies',
      'factory_markets',
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}"`);
    }
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_event_logs_dedupeKey_ledger"`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_logs" DROP COLUMN IF EXISTS "dedupeKey"`,
    );
  }
}
