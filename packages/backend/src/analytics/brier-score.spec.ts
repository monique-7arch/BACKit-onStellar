import {
  binaryBrierScore,
  multiOutcomeBrierScore,
  meanBrier,
  binaryLogLoss,
  calibrationCurve,
  clampProbability,
} from './brier-score';

describe('Brier score (BE-029)', () => {
  it('perfect prediction scores 0', () => {
    expect(binaryBrierScore(1, 1)).toBeCloseTo(0, 10);
    expect(binaryBrierScore(0, 0)).toBeCloseTo(0, 10);
  });

  it('worst prediction scores 1', () => {
    expect(binaryBrierScore(1, 0)).toBeCloseTo(1, 10);
    expect(binaryBrierScore(0, 1)).toBeCloseTo(1, 10);
  });

  it('0.5 always scores 0.25', () => {
    expect(binaryBrierScore(0.5, 1)).toBeCloseTo(0.25, 10);
    expect(binaryBrierScore(0.5, 0)).toBeCloseTo(0.25, 10);
  });

  it('mean Brier matches classic formula', () => {
    // N=2: p=0.8 o=1 → 0.04; p=0.3 o=0 → 0.09; mean = 0.065
    const scores = [binaryBrierScore(0.8, 1), binaryBrierScore(0.3, 0)];
    expect(meanBrier(scores)).toBeCloseTo(0.065, 10);
  });

  it('multi-outcome uniform is  (K-1)/K^2  when correct', () => {
    // K=3, p=[1,0,0], outcome 0 → 0
    expect(multiOutcomeBrierScore([1, 0, 0], 0)).toBeCloseTo(0, 10);
    // uniform [1/3]*3 outcome 0: each wrong gets (1/3)^2, correct (1/3-1)^2
    const u = 1 / 3;
    const expected = ((u - 1) ** 2 + u ** 2 + u ** 2) / 3;
    expect(multiOutcomeBrierScore([u, u, u], 0)).toBeCloseTo(expected, 10);
  });

  it('log loss is finite and ordered', () => {
    expect(binaryLogLoss(0.9, 1)).toBeLessThan(binaryLogLoss(0.1, 1));
    expect(binaryLogLoss(0.01, 0)).toBeLessThan(1);
  });

  it('calibration curve buckets observations', () => {
    const pairs = [
      { probability: 0.1, outcome: 0 as const },
      { probability: 0.1, outcome: 0 as const },
      { probability: 0.9, outcome: 1 as const },
      { probability: 0.9, outcome: 1 as const },
    ];
    const curve = calibrationCurve(pairs, 10);
    expect(curve.some((c) => c.count > 0)).toBe(true);
    const high = curve.find((c) => c.avgPredicted > 0.5);
    expect(high?.avgObserved).toBeCloseTo(1, 5);
  });

  it('clamps invalid probabilities', () => {
    expect(clampProbability(2)).toBeLessThan(1);
    expect(clampProbability(-1)).toBeGreaterThan(0);
  });
});
