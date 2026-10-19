import { SorobanRpc, xdr } from '@stellar/stellar-sdk';
import { EventType } from './event-log.entity';
import {
  DecodedScVal,
  ScValDecodeError,
  decodeScVal,
  parseScValXdr,
  readAddress,
  readBool,
  readI128,
  readSymbol,
  readU32,
  readU64,
} from './scval-decoder';

/**
 * Event schemas for the four contracts handled by BE-005.
 *
 * Each schema mirrors the Rust emitter in `packages/contracts/<contract>/src/events.rs`:
 *   topics = (namespace: Symbol, event_name: Symbol)
 *   data   = a positional tuple, i.e. an SCVal Vec
 */

export type ContractKind = 'factory' | 'orderbook' | 'parlay' | 'lending';

export type FieldType = 'u32' | 'u64' | 'i128' | 'bool' | 'address' | 'symbol';

export interface FieldSpec {
  name: string;
  type: FieldType;
}

export interface EventSpec {
  kind: ContractKind;
  /** First topic, the contract namespace symbol. */
  namespace: string;
  /** Second topic, the event name symbol. */
  name: string;
  eventType: EventType;
  fields: FieldSpec[];
}

const f = (name: string, type: FieldType): FieldSpec => ({ name, type });

export const CONTRACT_NAMESPACES: Record<ContractKind, string> = {
  factory: 'prediction_market_factory',
  orderbook: 'orderbook',
  parlay: 'parlay_betting',
  lending: 'lending_pool',
};

const FACTORY = CONTRACT_NAMESPACES.factory;
const ORDERBOOK = CONTRACT_NAMESPACES.orderbook;
const PARLAY = CONTRACT_NAMESPACES.parlay;
const LENDING = CONTRACT_NAMESPACES.lending;

export const EVENT_SPECS: EventSpec[] = [
  // PredictionMarketFactory
  {
    kind: 'factory',
    namespace: FACTORY,
    name: 'initialized',
    eventType: EventType.INITIALIZED,
    fields: [f('admin', 'address'), f('outcomeManager', 'address')],
  },
  {
    kind: 'factory',
    namespace: FACTORY,
    name: 'MarketDeployed',
    eventType: EventType.MARKET_DEPLOYED,
    fields: [
      f('callId', 'u64'),
      f('marketAddress', 'address'),
      f('creator', 'address'),
      f('stakeToken', 'address'),
      f('endTs', 'u64'),
    ],
  },
  {
    kind: 'factory',
    namespace: FACTORY,
    name: 'StrategyCreated',
    eventType: EventType.STRATEGY_CREATED,
    fields: [
      f('strategyId', 'u64'),
      f('user', 'address'),
      f('escrowAmount', 'i128'),
    ],
  },
  {
    kind: 'factory',
    namespace: FACTORY,
    name: 'StrategyExecuted',
    eventType: EventType.STRATEGY_EXECUTED,
    fields: [
      f('strategyId', 'u64'),
      f('actionsExecuted', 'u32'),
      f('keeperReward', 'i128'),
    ],
  },
  {
    kind: 'factory',
    namespace: FACTORY,
    name: 'StrategyCancelled',
    eventType: EventType.STRATEGY_CANCELLED,
    fields: [f('strategyId', 'u64')],
  },

  // Orderbook
  {
    kind: 'orderbook',
    namespace: ORDERBOOK,
    name: 'OrderPlaced',
    eventType: EventType.ORDER_PLACED,
    fields: [
      f('orderId', 'u64'),
      f('user', 'address'),
      f('callId', 'u64'),
      f('outcome', 'u32'),
      f('isBid', 'bool'),
    ],
  },
  {
    kind: 'orderbook',
    namespace: ORDERBOOK,
    name: 'OrderCancelled',
    eventType: EventType.ORDER_CANCELLED,
    fields: [f('orderId', 'u64')],
  },
  {
    kind: 'orderbook',
    namespace: ORDERBOOK,
    name: 'OrderExecuted',
    eventType: EventType.ORDER_EXECUTED,
    fields: [
      f('maker', 'address'),
      f('taker', 'address'),
      f('callId', 'u64'),
      f('outcome', 'u32'),
      f('amount', 'i128'),
      f('priceBps', 'u32'),
    ],
  },

  // ParlayBetting
  {
    kind: 'parlay',
    namespace: PARLAY,
    name: 'created',
    eventType: EventType.PARLAY_CREATED,
    fields: [
      f('parlayId', 'u64'),
      f('user', 'address'),
      f('initialStake', 'i128'),
      f('legCount', 'u32'),
    ],
  },
  {
    kind: 'parlay',
    namespace: PARLAY,
    name: 'leg_resolved',
    eventType: EventType.PARLAY_LEG_RESOLVED,
    fields: [f('parlayId', 'u64'), f('legIndex', 'u32'), f('won', 'bool')],
  },
  {
    kind: 'parlay',
    namespace: PARLAY,
    name: 'completed',
    eventType: EventType.PARLAY_COMPLETED,
    fields: [f('parlayId', 'u64'), f('totalPayout', 'i128')],
  },
  {
    kind: 'parlay',
    namespace: PARLAY,
    name: 'voided',
    eventType: EventType.PARLAY_VOIDED,
    fields: [f('parlayId', 'u64'), f('reason', 'symbol')],
  },

  // LendingPool
  {
    kind: 'lending',
    namespace: LENDING,
    name: 'Deposited',
    eventType: EventType.LENDING_DEPOSITED,
    fields: [
      f('user', 'address'),
      f('amount', 'i128'),
      f('lpSharesMinted', 'i128'),
    ],
  },
  {
    kind: 'lending',
    namespace: LENDING,
    name: 'Withdrawn',
    eventType: EventType.LENDING_WITHDRAWN,
    fields: [
      f('user', 'address'),
      f('lpSharesBurned', 'i128'),
      f('amountOut', 'i128'),
    ],
  },
  {
    kind: 'lending',
    namespace: LENDING,
    name: 'CapitalAllocated',
    eventType: EventType.CAPITAL_ALLOCATED,
    fields: [
      f('callId', 'u64'),
      f('marketAddress', 'address'),
      f('position', 'u32'),
      f('amount', 'i128'),
    ],
  },
  {
    kind: 'lending',
    namespace: LENDING,
    name: 'YieldHarvested',
    eventType: EventType.YIELD_HARVESTED,
    fields: [
      f('callId', 'u64'),
      f('won', 'bool'),
      f('grossChange', 'i128'),
      f('protocolFee', 'i128'),
      f('netYield', 'i128'),
    ],
  },
];

const SPEC_INDEX = new Map<string, EventSpec>(
  EVENT_SPECS.map((s) => [`${s.namespace}:${s.name}`, s]),
);

/**
 * JSON-serialisable event as fetched from Soroban RPC. Topics and value stay
 * as base64 XDR so the exact bytes survive queueing (BullMQ) and the DLQ.
 */
export interface RawIndexerEvent {
  id: string;
  pagingToken: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  txHash: string;
  topic: string[];
  value: string;
  inSuccessfulContractCall?: boolean;
}

export function toRawIndexerEvent(
  event: SorobanRpc.Api.EventResponse,
): RawIndexerEvent {
  const contractId = event.contractId?.contractId();
  if (!contractId) {
    throw new ScValDecodeError(`event ${event.id} has no contract id`);
  }
  return {
    id: event.id,
    pagingToken: event.pagingToken,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    contractId,
    txHash: event.txHash,
    topic: event.topic.map((t) => t.toXDR('base64')),
    value: event.value.toXDR('base64'),
    inSuccessfulContractCall: event.inSuccessfulContractCall,
  };
}

export type DecodedFieldValue = string | number | boolean;

export interface DecodedContractEvent {
  kind: ContractKind;
  namespace: string;
  name: string;
  eventType: EventType;
  /** Typed fields. 64-bit and wider integers are exact decimal strings. */
  fields: Record<string, DecodedFieldValue>;
  /** Trailing data items beyond the schema (forward compatibility). */
  extra: DecodedScVal[];
}

export type DecodeOutcome =
  | { status: 'decoded'; event: DecodedContractEvent }
  | { status: 'ignored'; reason: string };

/** contractId (StrKey) to the kind of contract it is. Authoritative routing. */
export type ContractMap = ReadonlyMap<string, ContractKind>;

const ENV_BY_KIND: Record<ContractKind, string> = {
  factory: 'FACTORY_CONTRACT_ID',
  orderbook: 'ORDERBOOK_CONTRACT_ID',
  parlay: 'PARLAY_CONTRACT_ID',
  lending: 'LENDING_POOL_CONTRACT_ID',
};

/**
 * Build the contract routing table from the environment. Routing is by
 * contract id, never by topic alone: any contract can emit a topic called
 * `OrderPlaced`, so trusting the topic would let a foreign contract write
 * into our tables.
 */
export function loadContractMap(
  env: Record<string, string | undefined> = process.env,
): Map<string, ContractKind> {
  const map = new Map<string, ContractKind>();
  for (const kind of Object.keys(ENV_BY_KIND) as ContractKind[]) {
    const id = env[ENV_BY_KIND[kind]]?.trim();
    if (id) map.set(id, kind);
  }
  return map;
}

function readField(scv: xdr.ScVal, spec: FieldSpec, path: string) {
  switch (spec.type) {
    case 'u32':
      return readU32(scv, path);
    case 'u64':
      return readU64(scv, path);
    case 'i128':
      return readI128(scv, path);
    case 'bool':
      return readBool(scv, path);
    case 'address':
      return readAddress(scv, path);
    case 'symbol':
      return readSymbol(scv, path);
  }
}

/**
 * Decode one raw event. Returns `ignored` for events that are simply not for
 * us (unknown contract, failed call, unknown event name) and throws
 * `ScValDecodeError` for events that ARE for us but are malformed, so the
 * caller can route them to the dead-letter path instead of dropping them.
 */
export function decodeContractEvent(
  raw: RawIndexerEvent,
  contracts: ContractMap,
): DecodeOutcome {
  if (raw.inSuccessfulContractCall === false) {
    return { status: 'ignored', reason: 'failed_contract_call' };
  }

  const kind = contracts.get(raw.contractId);
  if (!kind) return { status: 'ignored', reason: 'unconfigured_contract' };

  if (raw.topic.length < 2) {
    throw new ScValDecodeError(
      `expected 2 topics, got ${raw.topic.length}`,
      `event ${raw.id}`,
    );
  }

  const namespace = readSymbol(
    parseScValXdr(raw.topic[0], 'topic[0]'),
    'topic[0]',
  );
  if (namespace !== CONTRACT_NAMESPACES[kind]) {
    return { status: 'ignored', reason: 'namespace_mismatch' };
  }
  const name = readSymbol(parseScValXdr(raw.topic[1], 'topic[1]'), 'topic[1]');

  const spec = SPEC_INDEX.get(`${namespace}:${name}`);
  if (!spec) return { status: 'ignored', reason: 'unknown_event' };

  const data = parseScValXdr(raw.value, 'data');
  if (data.switch().name !== 'scvVec') {
    throw new ScValDecodeError(
      `expected data to be a tuple (Vec), got ${data.switch().name}`,
      `${name}.data`,
    );
  }
  const items = data.vec() ?? [];
  if (items.length < spec.fields.length) {
    throw new ScValDecodeError(
      `expected at least ${spec.fields.length} data fields, got ${items.length}`,
      `${name}.data`,
    );
  }

  const fields: Record<string, DecodedFieldValue> = {};
  spec.fields.forEach((field, i) => {
    fields[field.name] = readField(items[i], field, `${name}.${field.name}`);
  });
  const extra = items
    .slice(spec.fields.length)
    .map((item, i) => decodeScVal(item, `${name}.extra[${i}]`));

  return {
    status: 'decoded',
    event: {
      kind,
      namespace,
      name,
      eventType: spec.eventType,
      fields,
      extra,
    },
  };
}

/** Soroban event id: `<TOID, 19 digits>-<event index, 10 digits>`. */
export function parseEventId(id: string): { toid: bigint; index: number } {
  const [toidPart, indexPart] = id.split('-');
  try {
    return {
      toid: BigInt(toidPart),
      index: indexPart ? Number.parseInt(indexPart, 10) : 0,
    };
  } catch {
    throw new ScValDecodeError(`malformed event id "${id}"`);
  }
}

/**
 * Transaction application order within the ledger. TOID layout is
 * ledger(32) | tx order(20) | operation index(12), so this fits an int.
 */
export function txOrderOf(id: string): number {
  return Number((parseEventId(id).toid >> BigInt(12)) & BigInt(0xfffff));
}

/** Total order across events: by TOID, then by event index. */
export function compareEventIds(a: string, b: string): number {
  const pa = parseEventId(a);
  const pb = parseEventId(b);
  if (pa.toid !== pb.toid) return pa.toid < pb.toid ? -1 : 1;
  return pa.index - pb.index;
}
