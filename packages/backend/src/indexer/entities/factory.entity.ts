import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { I128_COLUMN, U64_COLUMN } from './numeric-columns';

/** A market deployed by PredictionMarketFactory (`MarketDeployed`). */
@Entity('factory_markets')
@Index('IDX_factory_markets_creator', ['creator'])
export class FactoryMarket {
  @PrimaryColumn(U64_COLUMN)
  callId: string;

  @Column({ type: 'varchar', length: 64 })
  marketAddress: string;

  @Column({ type: 'varchar', length: 64 })
  creator: string;

  @Column({ type: 'varchar', length: 64 })
  stakeToken: string;

  @Column(U64_COLUMN)
  endTs: string;

  @Column({ type: 'varchar', length: 64 })
  factoryContractId: string;

  @Column({ type: 'bigint' })
  ledger: string;

  @Column({ type: 'varchar', length: 64 })
  txHash: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

export type FactoryStrategyStatus = 'created' | 'executed' | 'cancelled';

/** A conditional strategy lifecycle (`StrategyCreated/Executed/Cancelled`). */
@Entity('factory_strategies')
@Index('IDX_factory_strategies_user', ['user'])
export class FactoryStrategy {
  @PrimaryColumn(U64_COLUMN)
  strategyId: string;

  @Column({ type: 'varchar', length: 64 })
  user: string;

  @Column(I128_COLUMN)
  escrowAmount: string;

  @Column({ type: 'varchar', length: 16, default: 'created' })
  status: FactoryStrategyStatus;

  @Column({ type: 'integer', nullable: true })
  actionsExecuted: number | null;

  @Column({ ...I128_COLUMN, nullable: true })
  keeperReward: string | null;

  @Column({ type: 'bigint' })
  createdLedger: string;

  @Column({ type: 'bigint' })
  updatedLedger: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
