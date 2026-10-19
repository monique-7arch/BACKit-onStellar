import { Address, scValToBigInt, xdr } from '@stellar/stellar-sdk';

/**
 * Exact-precision Soroban SCVal decoding (BE-005).
 *
 * Design rules
 *   - Integers wider than 32 bits are NEVER converted to a JS `number`. They
 *     are returned as base-10 strings produced from `BigInt`, so a u64, i128
 *     or u256 survives the trip into JSONB and `numeric` columns unchanged.
 *   - u32/i32 are small enough to be plain numbers.
 *   - Bytes are lower-case hex; addresses are their StrKey form (G... / C...).
 *   - Text containing NUL is sanitised because PostgreSQL JSONB rejects
 *     `\u0000`. This is the only lossy transform and it affects only free
 *     text (symbols/strings), never numbers or bytes.
 *
 * Two layers are exposed:
 *   - `decodeScVal`: lenient, generic, never loses a field (used to keep any
 *     trailing payload we do not have a typed schema for).
 *   - `readU32 / readU64 / readI128 / readBool / readAddress / readSymbol`:
 *     strict, used by the typed event decoders. A wrong wire type throws a
 *     `ScValDecodeError` instead of silently producing a wrong number.
 */

export type DecodedScVal =
  | null
  | boolean
  | number
  | string
  | DecodedScVal[]
  | { [key: string]: DecodedScVal };

export class ScValDecodeError extends Error {
  constructor(
    message: string,
    readonly path: string = '',
  ) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'ScValDecodeError';
  }
}

function textOf(value: string | Uint8Array): string {
  const text =
    typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
  return text.split('\u0000').join('\uFFFD');
}

function typeName(scv: xdr.ScVal): string {
  return scv.switch().name;
}

const BIG_INT_TYPES = new Set([
  'scvU64',
  'scvI64',
  'scvU128',
  'scvI128',
  'scvU256',
  'scvI256',
]);

/** Generic decode of any supported SCVal into a JSON-safe value. */
export function decodeScVal(scv: xdr.ScVal, path = '$'): DecodedScVal {
  const type = typeName(scv);

  if (BIG_INT_TYPES.has(type)) {
    return scValToBigInt(scv).toString();
  }

  switch (type) {
    case 'scvBool':
      return scv.b();
    case 'scvVoid':
      return null;
    case 'scvU32':
      return scv.u32();
    case 'scvI32':
      return scv.i32();
    case 'scvTimepoint':
      return scv.timepoint().toString();
    case 'scvDuration':
      return scv.duration().toString();
    case 'scvBytes':
      return Buffer.from(scv.bytes()).toString('hex');
    case 'scvString':
      return textOf(scv.str());
    case 'scvSymbol':
      return textOf(scv.sym());
    case 'scvAddress':
      return Address.fromScVal(scv).toString();
    case 'scvVec':
      return (scv.vec() ?? []).map((item, i) =>
        decodeScVal(item, `${path}[${i}]`),
      );
    case 'scvMap': {
      const entries = (scv.map() ?? []).map((entry, i) => ({
        key: decodeScVal(entry.key(), `${path}{${i}}.key`),
        value: decodeScVal(entry.val(), `${path}{${i}}.value`),
      }));
      const allTextKeys = entries.every((e) => typeof e.key === 'string');
      if (allTextKeys) {
        return Object.fromEntries(
          entries.map((e) => [e.key as string, e.value]),
        );
      }
      return entries.map((e) => [e.key, e.value]);
    }
    default:
      throw new ScValDecodeError(`unsupported SCVal type ${type}`, path);
  }
}

function expect(scv: xdr.ScVal, wanted: string, path: string): void {
  const got = typeName(scv);
  if (got !== wanted) {
    throw new ScValDecodeError(`expected ${wanted}, got ${got}`, path);
  }
}

export function readU32(scv: xdr.ScVal, path = '$'): number {
  expect(scv, 'scvU32', path);
  return scv.u32();
}

/** Exact decimal string of a u64. */
export function readU64(scv: xdr.ScVal, path = '$'): string {
  expect(scv, 'scvU64', path);
  return scValToBigInt(scv).toString();
}

/** Exact decimal string of an i128 (sign preserved, full 128-bit range). */
export function readI128(scv: xdr.ScVal, path = '$'): string {
  expect(scv, 'scvI128', path);
  return scValToBigInt(scv).toString();
}

export function readBool(scv: xdr.ScVal, path = '$'): boolean {
  expect(scv, 'scvBool', path);
  return scv.b();
}

export function readAddress(scv: xdr.ScVal, path = '$'): string {
  expect(scv, 'scvAddress', path);
  return Address.fromScVal(scv).toString();
}

export function readSymbol(scv: xdr.ScVal, path = '$'): string {
  expect(scv, 'scvSymbol', path);
  return textOf(scv.sym());
}

/** Parse a base64 XDR string into an SCVal, wrapping parse failures. */
export function parseScValXdr(base64: string, path = '$'): xdr.ScVal {
  try {
    return xdr.ScVal.fromXDR(base64, 'base64');
  } catch (err) {
    throw new ScValDecodeError(
      `invalid ScVal XDR: ${(err as Error).message}`,
      path,
    );
  }
}
