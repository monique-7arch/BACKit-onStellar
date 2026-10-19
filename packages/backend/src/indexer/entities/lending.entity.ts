import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { I128_COLUMN, U64_COLUMN } from './numeric-columns';

/**
 * Per-depositor LendingPool position, maintained with in-database `numeric`
 * arithmetic so concurrent and replayed batches cannot lose precision.
 */
@Entity('lending_positions')
export class LendingPosition {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  user: string;

  @Column({ ...I128_COLUMN, default: '0' })
  lpShares: string;

  @Column({ ...I128_COLUMN, default: '0' })
  totalDeposited: string;

  @Column({ ...I128_COLUMN, default: '0' })
  totalWithdrawn: string;

  @Column({ type: 'bigint' })
  lastLedger: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

/**
 * Capital the pool allocated to a market position (`CapitalAllocated`) and,
 * once harvested, the realised result (`YieldHarvested`, which is per call).
 */
@Entity('lending_allocations')
export class LendingAllocation {
  @PrimaryColumn(U64_COLUMN)
  callId: string;

  /** 1 = UP, 2 = DOWN, as emitted by the contract. */
  @PrimaryColumn({ type: 'integer' })
  position: number;

  @Column({ type: 'varchar', length: 64 })
  marketAddress: string;

  @Column({ ...I128_COLUMN, default: '0' })
  allocatedAmount: string;

  @Column({ type: 'boolean', default: false })
  harvested: boolean;

  @Column({ type: 'boolean', nullable: true })
  won: boolean | null;

  @Column({ ...I128_COLUMN, nullable: true })
  grossChange: string | null;

  @Column({ ...I128_COLUMN, nullable: true })
  protocolFee: string | null;

  @Column({ ...I128_COLUMN, nullable: true })
  netYield: string | null;

  @Column({ type: 'bigint' })
  lastLedger: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
