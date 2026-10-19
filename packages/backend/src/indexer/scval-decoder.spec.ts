/* eslint-disable
  @typescript-eslint/require-await,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-misused-promises
  -- test doubles, mocked async functions and raw SQL rows are intentionally loosely typed */
import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import {
  ScValDecodeError,
  decodeScVal,
  parseScValXdr,
  readI128,
  readU32,
  readU64,
} from './scval-decoder';
import {
  BIG_U64,
  I128_MAX,
  I128_MIN,
  U64_MAX,
  USER_A,
  addr,
  i128,
  u32,
  u64,
} from './__fixtures__/multi-contract-events.fixtures';

describe('scval-decoder', () => {
  describe('exact integer handling', () => {
    it('keeps u64 values above 2^53 exact', () => {
      expect(Number(BIG_U64).toString()).not.toBe(BIG_U64); // JS would corrupt it
      expect(readU64(u64(BIG_U64))).toBe(BIG_U64);
      expect(readU64(u64(U64_MAX))).toBe(U64_MAX);
    });

    it('keeps full-range i128 exact, including the sign and both limbs', () => {
      expect(readI128(i128(I128_MAX))).toBe(I128_MAX);
      expect(readI128(i128(I128_MIN))).toBe(I128_MIN);
      expect(readI128(i128('-1'))).toBe('-1');
      expect(readI128(i128('0'))).toBe('0');
      // high limb non-zero, low limb non-zero
      const v = '123456789012345678901234567890';
      expect(readI128(i128(v))).toBe(v);
    });

    it('decodes u256 and i256 generically without loss', () => {
      const big = (BigInt(1) << BigInt(200)) + BigInt(12345);
      expect(decodeScVal(nativeToScVal(big, { type: 'u256' }))).toBe(
        big.toString(),
      );
      expect(decodeScVal(nativeToScVal(-big, { type: 'i256' }))).toBe(
        (-big).toString(),
      );
    });

    it('returns u32/i32 as numbers and 64-bit types as strings', () => {
      expect(decodeScVal(u32(4294967295))).toBe(4294967295);
      expect(decodeScVal(nativeToScVal(-5, { type: 'i32' }))).toBe(-5);
      expect(decodeScVal(nativeToScVal(-5n, { type: 'i64' }))).toBe('-5');
      expect(typeof decodeScVal(u64('1'))).toBe('string');
    });
  });

  describe('generic decode', () => {
    it('decodes scalars, addresses, bytes and nested containers', () => {
      expect(decodeScVal(xdr.ScVal.scvBool(true))).toBe(true);
      expect(decodeScVal(xdr.ScVal.scvVoid())).toBeNull();
      expect(decodeScVal(addr(USER_A))).toBe(USER_A);
      expect(
        decodeScVal(xdr.ScVal.scvBytes(Buffer.from([0xde, 0xad, 0xbe, 0xef]))),
      ).toBe('deadbeef');
      expect(
        decodeScVal(xdr.ScVal.scvVec([u32(1), xdr.ScVal.scvVec([u64('2')])])),
      ).toEqual([1, ['2']]);
    });

    it('turns text-keyed maps into objects and other maps into pairs', () => {
      const textMap = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('a'),
          val: u32(1),
        }),
      ]);
      expect(decodeScVal(textMap)).toEqual({ a: 1 });

      const numMap = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: u32(1), val: u32(2) }),
      ]);
      expect(decodeScVal(numMap)).toEqual([[1, 2]]);
    });

    it('does not let a "__proto__" map key pollute the prototype', () => {
      const m = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('__proto__'),
          val: u32(1),
        }),
      ]);
      const out = decodeScVal(m) as Record<string, unknown>;
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('replaces NUL in text so JSONB accepts the value', () => {
      const out = decodeScVal(xdr.ScVal.scvString('a\u0000b')) as string;
      expect(out).toBe('a\uFFFDb');
      expect(() => JSON.parse(JSON.stringify({ out }))).not.toThrow();
    });

    it('rejects unsupported types with a path', () => {
      expect(() =>
        decodeScVal(xdr.ScVal.scvLedgerKeyContractInstance()),
      ).toThrow(ScValDecodeError);
    });
  });

  describe('strict readers', () => {
    it('throw on a wrong wire type instead of coercing', () => {
      expect(() => readU64(i128('1'), 'f')).toThrow(/f: expected scvU64/);
      expect(() => readI128(u64('1'))).toThrow(ScValDecodeError);
      expect(() => readU32(u64('1'))).toThrow(ScValDecodeError);
    });

    it('wraps malformed XDR', () => {
      expect(() => parseScValXdr('not-xdr', 'topic[0]')).toThrow(
        /topic\[0\]: invalid ScVal XDR/,
      );
    });
  });
});
