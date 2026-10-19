import { Address, StrKey, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import {
  CONTRACT_NAMESPACES,
  ContractKind,
  ContractMap,
  RawIndexerEvent,
} from '../multi-contract-events';

/** Deterministic StrKey addresses (no randomness, stable across runs). */
export const account = (n: number): string =>
  StrKey.encodeEd25519PublicKey(Buffer.alloc(32, n));
export const contract = (n: number): string =>
  StrKey.encodeContract(Buffer.alloc(32, n));

export const CONTRACT_IDS: Record<ContractKind, string> = {
  factory: contract(1),
  orderbook: contract(2),
  parlay: contract(3),
  lending: contract(4),
};

export const CONTRACT_MAP: ContractMap = new Map(
  (Object.keys(CONTRACT_IDS) as ContractKind[]).map((k) => [
    CONTRACT_IDS[k],
    k,
  ]),
);

export const U64_MAX = '18446744073709551615';
export const I128_MAX = '170141183460469231731687303715884105727';
export const I128_MIN = '-170141183460469231731687303715884105728';
/** Not exactly representable as a JS number (> 2^53). */
export const BIG_U64 = '9007199254740993';

// Typed SCVal constructors mirroring the Soroban Rust types
export const u32 = (v: number) => nativeToScVal(v, { type: 'u32' });
export const u64 = (v: string | bigint | number) =>
  nativeToScVal(BigInt(v), { type: 'u64' });
export const i128 = (v: string | bigint | number) =>
  nativeToScVal(BigInt(v), { type: 'i128' });
export const bool = (v: boolean) => xdr.ScVal.scvBool(v);
export const addr = (a: string) => Address.fromString(a).toScVal();
export const sym = (s: string) => xdr.ScVal.scvSymbol(s);

/** Soroban event id: TOID(ledger, tx order, op 0) + event index. */
export function eventId(ledger: number, txOrder: number, index = 0): string {
  const toid = (BigInt(ledger) << BigInt(32)) | (BigInt(txOrder) << BigInt(12));
  return `${toid.toString().padStart(19, '0')}-${String(index).padStart(10, '0')}`;
}

export interface BuildOpts {
  ledger?: number;
  txOrder?: number;
  index?: number;
  contractId?: string;
  inSuccessfulContractCall?: boolean;
}

/** Build a raw event exactly as the Rust `env.events().publish(topics, data)` shapes it. */
export function buildEvent(
  kind: ContractKind,
  name: string,
  data: xdr.ScVal[],
  opts: BuildOpts = {},
): RawIndexerEvent {
  const ledger = opts.ledger ?? 1000;
  const txOrder = opts.txOrder ?? 1;
  const id = eventId(ledger, txOrder, opts.index ?? 0);
  return {
    id,
    pagingToken: id,
    ledger,
    ledgerClosedAt: '2026-10-17T12:00:00.000Z',
    contractId: opts.contractId ?? CONTRACT_IDS[kind],
    txHash: `${'ab'.repeat(31)}${String(txOrder).padStart(2, '0')}`,
    topic: [sym(CONTRACT_NAMESPACES[kind]), sym(name)].map((t) =>
      t.toXDR('base64'),
    ),
    value: xdr.ScVal.scvVec(data).toXDR('base64'),
    inSuccessfulContractCall: opts.inSuccessfulContractCall ?? true,
  };
}

export const USER_A = account(11);
export const USER_B = account(12);
export const MARKET = contract(20);
export const TOKEN = contract(21);

/** One event of every type, ordered so parents precede children. */
export function allEventsFixture(): RawIndexerEvent[] {
  let tx = 0;
  const t = (extra: BuildOpts = {}) => ({
    ledger: 2000,
    txOrder: ++tx,
    ...extra,
  });
  return [
    buildEvent('factory', 'initialized', [addr(USER_A), addr(USER_B)], t()),
    buildEvent(
      'factory',
      'MarketDeployed',
      [u64(BIG_U64), addr(MARKET), addr(USER_A), addr(TOKEN), u64(1893456000)],
      t(),
    ),
    buildEvent(
      'factory',
      'StrategyCreated',
      [u64(7), addr(USER_A), i128(I128_MAX)],
      t(),
    ),
    buildEvent(
      'factory',
      'StrategyExecuted',
      [u64(7), u32(3), i128('5000000')],
      t(),
    ),
    buildEvent('factory', 'StrategyCancelled', [u64(8)], t()),

    buildEvent(
      'orderbook',
      'OrderPlaced',
      [u64(U64_MAX), addr(USER_A), u64(BIG_U64), u32(1), bool(true)],
      t(),
    ),
    buildEvent(
      'orderbook',
      'OrderPlaced',
      [u64(2), addr(USER_B), u64(BIG_U64), u32(2), bool(false)],
      t(),
    ),
    buildEvent('orderbook', 'OrderCancelled', [u64(2)], t()),
    buildEvent(
      'orderbook',
      'OrderExecuted',
      [
        addr(USER_A),
        addr(USER_B),
        u64(BIG_U64),
        u32(1),
        i128('123456789012345678901234567890'),
        u32(6500),
      ],
      t(),
    ),

    buildEvent(
      'parlay',
      'created',
      [u64(5), addr(USER_A), i128('10000000'), u32(3)],
      t(),
    ),
    buildEvent('parlay', 'leg_resolved', [u64(5), u32(0), bool(true)], t()),
    buildEvent('parlay', 'leg_resolved', [u64(5), u32(1), bool(false)], t()),
    buildEvent('parlay', 'completed', [u64(5), i128('0')], t()),
    buildEvent(
      'parlay',
      'created',
      [u64(6), addr(USER_B), i128('2'), u32(2)],
      t(),
    ),
    buildEvent('parlay', 'voided', [u64(6), sym('expired')], t()),

    buildEvent(
      'lending',
      'Deposited',
      [addr(USER_A), i128(I128_MAX), i128('1000')],
      t(),
    ),
    buildEvent(
      'lending',
      'Withdrawn',
      [addr(USER_A), i128('400'), i128('450')],
      t(),
    ),
    buildEvent(
      'lending',
      'CapitalAllocated',
      [u64(BIG_U64), addr(MARKET), u32(1), i128('750')],
      t(),
    ),
    buildEvent(
      'lending',
      'YieldHarvested',
      [u64(BIG_U64), bool(true), i128('-30'), i128('5'), i128('25')],
      t(),
    ),
  ];
}
