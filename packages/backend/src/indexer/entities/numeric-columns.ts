/**
 * Column shapes for Soroban integers. `pg` returns `numeric` as a string, so
 * values stay exact end to end (no JS `number` round trip).
 *
 *   u64  max 18446744073709551615            (20 digits)
 *   i128 range +/-170141183460469231731687303715884105727 (39 digits)
 */
export const U64_COLUMN = {
  type: 'numeric',
  precision: 20,
  scale: 0,
} as const;

export const I128_COLUMN = {
  type: 'numeric',
  precision: 39,
  scale: 0,
} as const;
