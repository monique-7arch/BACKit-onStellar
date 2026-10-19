/* eslint-disable
  @typescript-eslint/require-await,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-misused-promises
  -- test doubles, mocked async functions and raw SQL rows are intentionally loosely typed */
import {
  CONTRACT_NAMESPACES,
  DecodedContractEvent,
  EVENT_SPECS,
  RawIndexerEvent,
  compareEventIds,
  decodeContractEvent,
  loadContractMap,
  txOrderOf,
} from './multi-contract-events';
import { ScValDecodeError } from './scval-decoder';
import {
  BIG_U64,
  CONTRACT_IDS,
  CONTRACT_MAP,
  I128_MAX,
  MARKET,
  TOKEN,
  U64_MAX,
  USER_A,
  USER_B,
  addr,
  allEventsFixture,
  buildEvent,
  contract,
  eventId,
  i128,
  sym,
  u32,
  u64,
} from './__fixtures__/multi-contract-events.fixtures';
import { EventType } from './event-log.entity';
import { xdr } from '@stellar/stellar-sdk';

function decode(raw: RawIndexerEvent): DecodedContractEvent {
  const out = decodeContractEvent(raw, CONTRACT_MAP);
  if (out.status !== 'decoded') throw new Error(`ignored: ${out.reason}`);
  return out.event;
}

describe('decodeContractEvent', () => {
  it('has a fixture for every registered event schema', () => {
    const covered = new Set(
      allEventsFixture().map((e) => {
        const d = decode(e);
        return `${d.namespace}:${d.name}`;
      }),
    );
    for (const s of EVENT_SPECS) {
      expect(covered).toContain(`${s.namespace}:${s.name}`);
    }
  });

  describe('PredictionMarketFactory', () => {
    it('decodes MarketDeployed with an exact u64 call id', () => {
      const e = decode(
        buildEvent('factory', 'MarketDeployed', [
          u64(BIG_U64),
          addr(MARKET),
          addr(USER_A),
          addr(TOKEN),
          u64(1893456000),
        ]),
      );
      expect(e.eventType).toBe(EventType.MARKET_DEPLOYED);
      expect(e.fields).toEqual({
        callId: BIG_U64,
        marketAddress: MARKET,
        creator: USER_A,
        stakeToken: TOKEN,
        endTs: '1893456000',
      });
    });

    it('decodes strategy lifecycle events', () => {
      expect(
        decode(
          buildEvent('factory', 'StrategyCreated', [
            u64(7),
            addr(USER_A),
            i128(I128_MAX),
          ]),
        ).fields,
      ).toEqual({ strategyId: '7', user: USER_A, escrowAmount: I128_MAX });
      expect(
        decode(
          buildEvent('factory', 'StrategyExecuted', [
            u64(7),
            u32(3),
            i128('9'),
          ]),
        ).fields,
      ).toEqual({ strategyId: '7', actionsExecuted: 3, keeperReward: '9' });
      expect(
        decode(buildEvent('factory', 'StrategyCancelled', [u64(8)])).fields,
      ).toEqual({ strategyId: '8' });
    });
  });

  describe('Orderbook', () => {
    it('decodes bid and ask placements', () => {
      const bid = decode(
        buildEvent('orderbook', 'OrderPlaced', [
          u64(U64_MAX),
          addr(USER_A),
          u64(1),
          u32(1),
          xdr.ScVal.scvBool(true),
        ]),
      );
      expect(bid.fields).toEqual({
        orderId: U64_MAX,
        user: USER_A,
        callId: '1',
        outcome: 1,
        isBid: true,
      });
      const ask = decode(
        buildEvent('orderbook', 'OrderPlaced', [
          u64(2),
          addr(USER_B),
          u64(1),
          u32(2),
          xdr.ScVal.scvBool(false),
        ]),
      );
      expect(ask.fields.isBid).toBe(false);
    });

    it('decodes OrderExecuted amounts without precision loss', () => {
      const amount = '123456789012345678901234567890';
      const e = decode(
        buildEvent('orderbook', 'OrderExecuted', [
          addr(USER_A),
          addr(USER_B),
          u64(1),
          u32(1),
          i128(amount),
          u32(6500),
        ]),
      );
      expect(e.fields.amount).toBe(amount);
      expect(e.fields.priceBps).toBe(6500);
    });
  });

  describe('ParlayBetting', () => {
    it('decodes created, leg_resolved, completed and voided', () => {
      expect(
        decode(
          buildEvent('parlay', 'created', [
            u64(5),
            addr(USER_A),
            i128('10'),
            u32(3),
          ]),
        ).fields,
      ).toEqual({
        parlayId: '5',
        user: USER_A,
        initialStake: '10',
        legCount: 3,
      });
      expect(
        decode(
          buildEvent('parlay', 'leg_resolved', [
            u64(5),
            u32(1),
            xdr.ScVal.scvBool(false),
          ]),
        ).fields,
      ).toEqual({ parlayId: '5', legIndex: 1, won: false });
      expect(
        decode(buildEvent('parlay', 'completed', [u64(5), i128('77')])).fields,
      ).toEqual({ parlayId: '5', totalPayout: '77' });
      expect(
        decode(buildEvent('parlay', 'voided', [u64(5), sym('expired')])).fields,
      ).toEqual({ parlayId: '5', reason: 'expired' });
    });
  });

  describe('LendingPool', () => {
    it('decodes deposits, withdrawals, allocations and harvests', () => {
      expect(
        decode(
          buildEvent('lending', 'Deposited', [
            addr(USER_A),
            i128(I128_MAX),
            i128('1'),
          ]),
        ).fields,
      ).toEqual({ user: USER_A, amount: I128_MAX, lpSharesMinted: '1' });
      expect(
        decode(
          buildEvent('lending', 'Withdrawn', [
            addr(USER_A),
            i128('4'),
            i128('5'),
          ]),
        ).fields,
      ).toEqual({ user: USER_A, lpSharesBurned: '4', amountOut: '5' });
      expect(
        decode(
          buildEvent('lending', 'CapitalAllocated', [
            u64(3),
            addr(MARKET),
            u32(2),
            i128('100'),
          ]),
        ).fields,
      ).toEqual({
        callId: '3',
        marketAddress: MARKET,
        position: 2,
        amount: '100',
      });
      expect(
        decode(
          buildEvent('lending', 'YieldHarvested', [
            u64(3),
            xdr.ScVal.scvBool(false),
            i128('-30'),
            i128('5'),
            i128('-35'),
          ]),
        ).fields,
      ).toEqual({
        callId: '3',
        won: false,
        grossChange: '-30',
        protocolFee: '5',
        netYield: '-35',
      });
    });
  });

  describe('routing and safety', () => {
    it('ignores events from unconfigured contracts (spoofing guard)', () => {
      const spoof = buildEvent('orderbook', 'OrderCancelled', [u64(1)], {
        contractId: contract(99),
      });
      expect(decodeContractEvent(spoof, CONTRACT_MAP)).toEqual({
        status: 'ignored',
        reason: 'unconfigured_contract',
      });
    });

    it('ignores a configured contract emitting another contract namespace', () => {
      const e = buildEvent('orderbook', 'OrderCancelled', [u64(1)], {
        contractId: CONTRACT_IDS.lending,
      });
      expect(decodeContractEvent(e, CONTRACT_MAP)).toMatchObject({
        status: 'ignored',
        reason: 'namespace_mismatch',
      });
    });

    it('ignores unknown event names and failed contract calls', () => {
      expect(
        decodeContractEvent(
          buildEvent('orderbook', 'Mystery', []),
          CONTRACT_MAP,
        ),
      ).toMatchObject({ status: 'ignored', reason: 'unknown_event' });
      expect(
        decodeContractEvent(
          buildEvent('orderbook', 'OrderCancelled', [u64(1)], {
            inSuccessfulContractCall: false,
          }),
          CONTRACT_MAP,
        ),
      ).toMatchObject({ status: 'ignored', reason: 'failed_contract_call' });
    });

    it('throws (so it can be dead-lettered) on malformed payloads', () => {
      // wrong type: callId as i128 instead of u64
      expect(() =>
        decode(buildEvent('factory', 'StrategyCancelled', [i128('1')])),
      ).toThrow(ScValDecodeError);
      // too few fields
      expect(() =>
        decode(buildEvent('orderbook', 'OrderExecuted', [addr(USER_A)])),
      ).toThrow(/at least 6 data fields/);
      // data is not a tuple
      const notVec = buildEvent('orderbook', 'OrderCancelled', []);
      notVec.value = u64(1).toXDR('base64');
      expect(() => decode(notVec)).toThrow(/expected data to be a tuple/);
      // missing topics
      const noTopics = buildEvent('orderbook', 'OrderCancelled', [u64(1)]);
      noTopics.topic = [noTopics.topic[0]];
      expect(() => decode(noTopics)).toThrow(/expected 2 topics/);
      // garbage XDR
      const garbage = buildEvent('orderbook', 'OrderCancelled', [u64(1)]);
      garbage.value = 'AAAA';
      expect(() => decode(garbage)).toThrow(ScValDecodeError);
    });

    it('keeps unknown trailing data fields for forward compatibility', () => {
      const e = decode(
        buildEvent('factory', 'StrategyCancelled', [
          u64(8),
          u32(5),
          sym('new'),
        ]),
      );
      expect(e.fields).toEqual({ strategyId: '8' });
      expect(e.extra).toEqual([5, 'new']);
    });
  });

  describe('contract map and ids', () => {
    it('loads the routing table from the environment', () => {
      const map = loadContractMap({
        FACTORY_CONTRACT_ID: ' CFACT ',
        LENDING_POOL_CONTRACT_ID: 'CLEND',
      });
      expect([...map.entries()]).toEqual([
        ['CFACT', 'factory'],
        ['CLEND', 'lending'],
      ]);
    });

    it('orders events by TOID then index and extracts tx order', () => {
      const a = eventId(10, 1, 0);
      const b = eventId(10, 1, 1);
      const c = eventId(10, 2, 0);
      const d = eventId(11, 0, 0);
      const sorted = [d, c, b, a].sort(compareEventIds);
      expect(sorted).toEqual([a, b, c, d]);
      expect(txOrderOf(c)).toBe(2);
      expect(() => compareEventIds('xyz', a)).toThrow(ScValDecodeError);
    });

    it('uses the namespaces the Rust contracts publish', () => {
      expect(CONTRACT_NAMESPACES).toEqual({
        factory: 'prediction_market_factory',
        orderbook: 'orderbook',
        parlay: 'parlay_betting',
        lending: 'lending_pool',
      });
    });
  });
});
