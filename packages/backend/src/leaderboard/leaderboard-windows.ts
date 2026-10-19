/**
 * BE-030 — Multi-window Redis sorted-set keys.
 * leaderboard:volume:24h | leaderboard:profit:7d | leaderboard:brier:all | …
 */

export type MetricWindow = '24h' | '7d' | '30d' | 'all';
export type LeaderboardMetric = 'volume' | 'profit' | 'brier' | 'composite';

export function redisBoardKey(metric: LeaderboardMetric, window: MetricWindow): string {
  return `leaderboard:${metric}:${window}`;
}

export const ALL_WINDOWS: MetricWindow[] = ['24h', '7d', '30d', 'all'];
export const ALL_METRICS: LeaderboardMetric[] = ['volume', 'profit', 'brier', 'composite'];
