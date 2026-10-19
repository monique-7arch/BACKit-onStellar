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
  copyEscape,
  loadBulkLoaderOptions,
  toCopyLine,
} from './bulk-event-loader.service';

describe('COPY text escaping', () => {
  it('escapes the characters COPY treats specially', () => {
    expect(copyEscape('a\tb')).toBe('a\\tb');
    expect(copyEscape('a\nb')).toBe('a\\nb');
    expect(copyEscape('a\rb')).toBe('a\\rb');
    expect(copyEscape('back\\slash')).toBe('back\\\\slash');
    // backslash first, so we do not double-escape our own escapes
    expect(copyEscape('\\t')).toBe('\\\\t');
  });

  it('writes NULL as \\N and numbers as text', () => {
    expect(copyEscape(null)).toBe('\\N');
    expect(copyEscape(undefined)).toBe('\\N');
    expect(copyEscape(42)).toBe('42');
  });

  it('keeps a JSON payload with tabs, newlines and backslashes on one line', () => {
    const line = toCopyLine({
      eventId: 'id',
      dedupeKey: 'id',
      pagingToken: 'p',
      contractId: 'C',
      topic0: null,
      eventType: 't',
      ledger: 7,
      txHash: 'h',
      txOrder: 1,
      eventData: { text: 'tab\there\nnewline \\ slash "quote"' },
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toMatch(/\n|\r/);
    expect(line.split('\t')).toHaveLength(11);
    expect(line.split('\t')[4]).toBe('\\N');
  });
});

describe('loadBulkLoaderOptions', () => {
  it('defaults to 5,000 items, 500 ms, auto', () => {
    expect(loadBulkLoaderOptions({})).toEqual({
      strategy: 'auto',
      maxBatch: 5000,
      maxLatencyMs: 500,
      copyThreshold: 200,
    });
  });

  it('reads overrides and ignores invalid values', () => {
    expect(
      loadBulkLoaderOptions({
        BULK_LOADER_STRATEGY: 'copy',
        BULK_LOADER_MAX_BATCH: '100',
        BULK_LOADER_MAX_LATENCY_MS: 'abc',
      }),
    ).toMatchObject({ strategy: 'copy', maxBatch: 100, maxLatencyMs: 500 });
    expect(
      loadBulkLoaderOptions({ BULK_LOADER_STRATEGY: 'nope' }).strategy,
    ).toBe('auto');
  });
});
