import { DataSource } from 'typeorm';
import { PartitionEventStore1760000070000 } from '../../database/migrations/1760000070000-PartitionEventStore';
import { CreateIndexerCheckpoints1760000090000 } from '../../database/migrations/1760000090000-CreateIndexerCheckpoints';
import { CreateMultiContractIndexerTables1760000080000 } from '../../database/migrations/1760000080000-CreateMultiContractIndexerTables';

/**
 * Real-PostgreSQL integration support. Set TEST_DATABASE_URL to an admin
 * connection string (for example
 * postgres://postgres:postgres@localhost:5432/postgres). Every spec gets its
 * own throwaway database, built the way production is: the legacy
 * event_logs table, then the partitioning migration, then the BE-005
 * migration. When the variable is unset the DB specs are skipped, so a plain
 * `pnpm test` never needs a database.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const LEGACY_EVENT_LOGS = `
  CREATE TABLE "event_logs" (
    "id" SERIAL NOT NULL,
    "eventId" character varying NOT NULL,
    "pagingToken" character varying NOT NULL,
    "contractId" character varying(64) NOT NULL,
    "topic0" character varying(64),
    "eventType" character varying(50) NOT NULL,
    "ledger" bigint NOT NULL,
    "txHash" character varying(64) NOT NULL,
    "txOrder" integer NOT NULL,
    "eventData" jsonb NOT NULL,
    "timestamp" TIMESTAMP NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT "PK_event_logs" PRIMARY KEY ("id", "ledger")
  )`;

export interface TestDb {
  dataSource: DataSource;
  url: string;
  drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const adminUrl = TEST_DATABASE_URL as string;
  const name = `backit_it_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  const admin = new DataSource({ type: 'postgres', url: adminUrl });
  await admin.initialize();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.destroy();

  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const url = u.toString();

  const dataSource = new DataSource({ type: 'postgres', url, entities: [] });
  await dataSource.initialize();
  const qr = dataSource.createQueryRunner();
  await qr.connect();
  await qr.query(LEGACY_EVENT_LOGS);
  await new PartitionEventStore1760000070000().up(qr);
  await new CreateMultiContractIndexerTables1760000080000().up(qr);
  await new CreateIndexerCheckpoints1760000090000().up(qr);
  await qr.release();

  return {
    dataSource,
    url,
    async drop() {
      await dataSource.destroy();
      const a = new DataSource({ type: 'postgres', url: adminUrl });
      await a.initialize();
      await a.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await a.destroy();
    },
  };
}
