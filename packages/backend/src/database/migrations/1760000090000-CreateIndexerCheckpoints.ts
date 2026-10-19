import { MigrationInterface, QueryRunner } from 'typeorm';

/** Durable per-stream ledger checkpoints for the indexer lease (BE-006). */
export class CreateIndexerCheckpoints1760000090000 implements MigrationInterface {
  name = 'CreateIndexerCheckpoints1760000090000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "indexer_checkpoints" (
        "name"       character varying(64) NOT NULL,
        "lastLedger" bigint NOT NULL,
        "ownerId"    character varying(128),
        "updatedAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_indexer_checkpoints" PRIMARY KEY ("name")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "indexer_checkpoints"`);
  }
}
