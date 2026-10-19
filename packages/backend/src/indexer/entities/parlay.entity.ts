import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { I128_COLUMN, U64_COLUMN } from './numeric-columns';

export type ParlayStatus = 'active' | 'completed' | 'voided';

/** A multi-leg parlay (`created`, then `completed` or `voided`). */
@Entity('parlays')
@Index('IDX_parlays_user', ['user'])
@Index('IDX_parlays_status', ['status'])
export class Parlay {
  @PrimaryColumn(U64_COLUMN)
  parlayId: string;

  @Column({ type: 'varchar', length: 64 })
  user: string;

  @Column(I128_COLUMN)
  initialStake: string;

  @Column({ type: 'integer' })
  legCount: number;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status: ParlayStatus;

  @Column({ type: 'integer', default: 0 })
  legsResolved: number;

  @Column({ type: 'integer', default: 0 })
  legsWon: number;

  @Column({ ...I128_COLUMN, nullable: true })
  totalPayout: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  voidReason: string | null;

  @Column({ type: 'varchar', length: 64 })
  parlayContractId: string;

  @Column({ type: 'bigint' })
  createdLedger: string;

  @Column({ type: 'bigint' })
  updatedLedger: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

/**
 * One leg of a parlay. Rows are created pending (`won` NULL) when the parlay
 * is created, using the leg count from the event, then resolved by
 * `leg_resolved`.
 */
@Entity('parlay_legs')
export class ParlayLeg {
  @PrimaryColumn(U64_COLUMN)
  parlayId: string;

  @PrimaryColumn({ type: 'integer' })
  legIndex: number;

  @Column({ type: 'boolean', nullable: true })
  won: boolean | null;

  @Column({ type: 'bigint', nullable: true })
  resolvedLedger: string | null;
}
