/**
 * BE-029 — Brier score & probabilistic calibration.
 *
 * Binary Brier: (p - o)^2 where o ∈ {0,1}, p ∈ [0,1]
 * Multi-outcome: (1/K) Σ_k (p_k - o_k)^2  with Σ p_k = 1, one-hot o
 * Mean Brier over N predictions: (1/N) Σ_i Brier_i
 * Log loss (binary): -(o log p + (1-o) log(1-p))
 */

const EPS = 1e-15;

export function clampProbability(p: number): number {
  if (Number.isNaN(p) || !Number.isFinite(p)) return 0.5;
  return Math.min(1 - EPS, Math.max(EPS, p));
}

/** Single binary prediction Brier score. Perfect = 0, worst = 1. */
export function binaryBrierScore(probability: number, outcome: 0 | 1): number {
  const p = clampProbability(probability);
  const d = p - outcome;
  return d * d;
}

/**
 * Multi-outcome Brier score.
 * `probabilities` length K, `outcomeIndex` in [0, K).
 */
export function multiOutcomeBrierScore(
  probabilities: number[],
  outcomeIndex: number,
): number {
  if (probabilities.length === 0) return 1;
  const k = probabilities.length;
  let sum = 0;
  for (let i = 0; i < k; i++) {
    const p = clampProbability(probabilities[i]);
    const o = i === outcomeIndex ? 1 : 0;
    sum += (p - o) * (p - o);
  }
  return sum / k;
}

export function meanBrier(scores: number[]): number {
  if (scores.length === 0) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/** Binary logarithmic loss. */
export function binaryLogLoss(probability: number, outcome: 0 | 1): number {
  const p = clampProbability(probability);
  if (outcome === 1) return -Math.log(p);
  return -Math.log(1 - p);
}

/**
 * Reliability diagram buckets: average predicted vs observed frequency.
 * Returns points for a calibration curve.
 */
export function calibrationCurve(
  pairs: { probability: number; outcome: 0 | 1 }[],
  buckets = 10,
): { bin: number; avgPredicted: number; avgObserved: number; count: number }[] {
  const edges = Array.from({ length: buckets }, () => ({
    sumP: 0,
    sumO: 0,
    count: 0,
  }));
  for (const { probability, outcome } of pairs) {
    const p = clampProbability(probability);
    let idx = Math.floor(p * buckets);
    if (idx >= buckets) idx = buckets - 1;
    edges[idx].sumP += p;
    edges[idx].sumO += outcome;
    edges[idx].count += 1;
  }
  return edges.map((e, bin) => ({
    bin,
    avgPredicted: e.count ? e.sumP / e.count : 0,
    avgObserved: e.count ? e.sumO / e.count : 0,
    count: e.count,
  }));
}

/** Rolling window mean (e.g. last 30 daily points). */
export function rollingMean(values: number[], window: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1);
    out.push(meanBrier(slice));
  }
  return out;
}
