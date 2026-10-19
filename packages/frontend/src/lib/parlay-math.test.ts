import { describe, it, expect } from 'vitest';
import { calculateParlay } from './parlay-calc';

describe('parlay math', () => {
  it('calculates multiplier correctly for multiple legs', () => {
    const result = calculateParlay(
      [
        { marketId: 'm1', outcome: 'YES', odds: 2.0 },
        { marketId: 'm2', outcome: 'NO', odds: 1.5 },
      ],
      100
    );
    expect(result.multiplier).toBe(3.0);
    expect(result.isValid).toBe(true);
  });

  it('rejects parlays with less than 2 legs', () => {
    const result = calculateParlay([{ marketId: 'm1', outcome: 'YES', odds: 2.0 }], 100);
    expect(result.isValid).toBe(false);
  });

  it('rejects parlays with more than 10 legs', () => {
    const legs = Array.from({ length: 11 }, (_, i) => ({ marketId: `m${i}`, outcome: 'YES' as const, odds: 1.1 }));
    const result = calculateParlay(legs, 100);
    expect(result.isValid).toBe(false);
  });

  it('rejects expired markets', () => {
    const past = Date.now() - 10000;
    const result = calculateParlay(
      [
        { marketId: 'm1', outcome: 'YES', odds: 2.0, expiresAt: past },
        { marketId: 'm2', outcome: 'NO', odds: 1.5 },
      ],
      100
    );
    expect(result.isValid).toBe(false);
  });

  it('rejects invalid odds', () => {
    const result = calculateParlay(
      [
        { marketId: 'm1', outcome: 'YES', odds: 0.5 },
        { marketId: 'm2', outcome: 'NO', odds: 1.5 },
      ],
      100
    );
    expect(result.isValid).toBe(false);
  });
});