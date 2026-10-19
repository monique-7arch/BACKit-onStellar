import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Durable "last fully processed ledger" per named indexer stream. This is the
 * resume point a standby node reads when it takes over the lease, so it lives
 * in PostgreSQL (the same store as the data) and not in Redis, which is only
 * used for the mutex.
 */
@Entity('indexer_checkpoints')
export class IndexerCheckpoint {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  name: string;

  @Column({ type: 'bigint' })
  lastLedger: string;

  /** Node id of the writer, for diagnostics. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  ownerId: string | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
