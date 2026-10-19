import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { I128_COLUMN, U64_COLUMN } from './numeric-columns';

export type OrderSide = 'bid' | 'ask';
export type OrderStatus = 'open' | 'cancelled';

/**
 * An order placement (`OrderPlaced`). The on-chain event carries side, owner,
 * call and outcome only. Amount and price are not part of the event, so they
 * are intentionally not columns here: fills are recorded in `orderbook_trades`
 * from `OrderExecuted`, which does carry them.
 */
@Entity('orderbook_orders')
@Index('IDX_orderbook_orders_book', ['callId', 'outcome', 'side', 'status'])
@Index('IDX_orderbook_orders_user', ['user'])
export class OrderbookOrder {
  @PrimaryColumn(U64_COLUMN)
  orderId: string;

  @Column({ type: 'varchar', length: 64 })
  user: string;

  @Column(U64_COLUMN)
  callId: string;

  @Column({ type: 'integer' })
  outcome: number;

  @Column({ type: 'varchar', length: 3 })
  side: OrderSide;

  @Column({ type: 'varchar', length: 16, default: 'open' })
  status: OrderStatus;

  @Column({ type: 'varchar', length: 64 })
  orderbookContractId: string;

  @Column({ type: 'bigint' })
  placedLedger: string;

  @Column({ type: 'varchar', length: 64 })
  placedTxHash: string;

  @Column({ type: 'bigint', nullable: true })
  cancelledLedger: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

/** One executed fill (`OrderExecuted`). Keyed by the event id for idempotency. */
@Entity('orderbook_trades')
@Index('IDX_orderbook_trades_market', ['callId', 'outcome', 'ledger'])
@Index('IDX_orderbook_trades_maker', ['maker'])
@Index('IDX_orderbook_trades_taker', ['taker'])
export class OrderbookTrade {
  @PrimaryColumn({ type: 'varchar', length: 80 })
  eventId: string;

  @Column({ type: 'varchar', length: 64 })
  maker: string;

  @Column({ type: 'varchar', length: 64 })
  taker: string;

  @Column(U64_COLUMN)
  callId: string;

  @Column({ type: 'integer' })
  outcome: number;

  @Column(I128_COLUMN)
  amount: string;

  @Column({ type: 'integer' })
  priceBps: number;

  @Column({ type: 'varchar', length: 64 })
  orderbookContractId: string;

  @Column({ type: 'bigint' })
  ledger: string;

  @Column({ type: 'varchar', length: 64 })
  txHash: string;

  @Column({ type: 'timestamptz' })
  executedAt: Date;
}
