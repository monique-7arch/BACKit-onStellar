/* eslint-disable
  @typescript-eslint/require-await,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-misused-promises
  -- test doubles, mocked async functions and raw SQL rows are intentionally loosely typed */
import { of, throwError } from 'rxjs';
import { Job } from 'bullmq';
import {
  INDEXER_EVENT_ATTEMPTS,
  IndexerDlqService,
  IndexerEventJob,
  alertBody,
  backoffDelayMs,
} from './indexer-dlq.service';
import { RawIndexerEvent } from '../indexer/multi-contract-events';

const event = (over: Partial<RawIndexerEvent> = {}): RawIndexerEvent => ({
  id: '0000000000000000001-0000000000',
  pagingToken: 'p',
  ledger: 42,
  ledgerClosedAt: '2026-10-17T12:00:00.000Z',
  contractId: 'C'.padEnd(56, 'A'),
  txHash: 'ab'.repeat(32),
  topic: ['AAAA', 'BBBB'],
  value: 'CCCC',
  ...over,
});

describe('alertBody', () => {
  it('uses the Slack shape by default and for slack urls', () => {
    expect(
      alertBody('https://hooks.slack.com/services/x', 'hi', undefined),
    ).toEqual({
      text: 'hi',
    });
  });
  it('detects Discord from the url', () => {
    expect(
      alertBody('https://discord.com/api/webhooks/1/x', 'hi', undefined),
    ).toEqual({
      content: 'hi',
    });
    expect(
      alertBody('https://discordapp.com/api/webhooks/1/x', 'hi', undefined),
    ).toEqual({
      content: 'hi',
    });
  });
  it('lets the explicit format win', () => {
    expect(alertBody('https://example.com/h', 'hi', 'discord')).toEqual({
      content: 'hi',
    });
    expect(alertBody('https://discord.com/h', 'hi', 'slack')).toEqual({
      text: 'hi',
    });
  });
});

describe('backoffDelayMs', () => {
  it('defaults to 1s and accepts an override', () => {
    expect(backoffDelayMs({})).toBe(1000);
    expect(backoffDelayMs({ INDEXER_QUEUE_BACKOFF_MS: '250' })).toBe(250);
    expect(backoffDelayMs({ INDEXER_QUEUE_BACKOFF_MS: 'x' })).toBe(1000);
  });
});

describe('IndexerDlqService', () => {
  let events: { add: jest.Mock };
  let dlq: {
    add: jest.Mock;
    getJob: jest.Mock;
    getJobs: jest.Mock;
    getWaitingCount: jest.Mock;
  };
  let http: { post: jest.Mock };
  let service: IndexerDlqService;
  const saved = { ...process.env };

  beforeEach(() => {
    events = { add: jest.fn(async () => undefined) };
    dlq = {
      add: jest.fn(async () => undefined),
      getJob: jest.fn(async () => undefined),
      getJobs: jest.fn(async () => []),
      getWaitingCount: jest.fn(async () => 0),
    };
    http = { post: jest.fn(() => of({ status: 200 })) };
    service = new IndexerDlqService(
      events as never,
      dlq as never,
      http as never,
    );
    delete process.env.INDEXER_DLQ_ALERT_WEBHOOK_URL;
    delete process.env.INDEXER_DLQ_ALERT_FORMAT;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  describe('handleFailure', () => {
    it('queues the event with 5 exponential attempts, keyed by event id', async () => {
      await service.handleFailure({
        event: event(),
        stage: 'persist',
        error: new Error('conflict'),
      });
      const [name, data, opts] = events.add.mock.calls[0];
      expect(name).toBe('ingest');
      expect(data).toMatchObject({
        stage: 'persist',
        firstError: 'conflict',
        redrive: 0,
      });
      expect(opts).toMatchObject({
        jobId: event().id,
        attempts: INDEXER_EVENT_ATTEMPTS,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnFail: true,
      });
      expect(INDEXER_EVENT_ATTEMPTS).toBe(5);
    });
  });

  describe('capture', () => {
    const job = (over: Partial<IndexerEventJob> = {}) =>
      ({
        attemptsMade: 5,
        data: {
          event: event(),
          stage: 'decode',
          firstError: 'x',
          redrive: 0,
          ...over,
        },
      }) as unknown as Job<IndexerEventJob>;

    it('parks the entry with full stack and raw XDR', async () => {
      const err = new Error('bad xdr');
      await service.capture(job(), err);
      const [, entry, opts] = dlq.add.mock.calls[0];
      expect(entry).toMatchObject({
        id: event().id,
        stage: 'decode',
        attempts: 5,
        redriveCount: 0,
        edited: false,
        error: { name: 'Error', message: 'bad xdr' },
      });
      expect(entry.error.stack).toContain('bad xdr');
      expect(entry.event.topic).toEqual(['AAAA', 'BBBB']);
      expect(entry.event.value).toBe('CCCC');
      expect(opts).toMatchObject({ jobId: event().id, removeOnFail: false });
    });

    it('posts a Slack alert when a webhook is configured', async () => {
      process.env.INDEXER_DLQ_ALERT_WEBHOOK_URL =
        'https://hooks.slack.com/services/T/B/x';
      await service.capture(job(), new Error('boom'));
      const [url, body, cfg] = http.post.mock.calls[0];
      expect(url).toBe('https://hooks.slack.com/services/T/B/x');
      expect(body.text).toContain('boom');
      expect(body.text).toContain('Ledger 42');
      expect(cfg).toMatchObject({ timeout: 5000 });
    });

    it('posts a Discord alert, truncated under Discord limits', async () => {
      process.env.INDEXER_DLQ_ALERT_WEBHOOK_URL =
        'https://discord.com/api/webhooks/1/x';
      await service.capture(job(), new Error('x'.repeat(5000)));
      const body = http.post.mock.calls[0][1];
      expect(Object.keys(body)).toEqual(['content']);
      expect(body.content.length).toBeLessThanOrEqual(1500);
    });

    it('sends no alert when no webhook is configured', async () => {
      await service.capture(job(), new Error('boom'));
      expect(http.post).not.toHaveBeenCalled();
    });

    it('never throws when the webhook or the queue fails', async () => {
      process.env.INDEXER_DLQ_ALERT_WEBHOOK_URL = 'https://example.com/hook';
      http.post.mockReturnValue(throwError(() => new Error('ECONNREFUSED')));
      dlq.add.mockRejectedValue(new Error('redis down'));
      await expect(
        service.capture(job(), new Error('boom')),
      ).resolves.toBeUndefined();
    });

    it('does not put the secret webhook url in any log', async () => {
      process.env.INDEXER_DLQ_ALERT_WEBHOOK_URL =
        'https://example.com/SECRET-TOKEN';
      http.post.mockReturnValue(throwError(() => new Error('down')));
      const logs: string[] = [];
      jest
        .spyOn(service['logger'], 'warn')
        .mockImplementation((m: unknown) => void logs.push(JSON.stringify(m)));
      await service.capture(job(), new Error('boom'));
      expect(logs.join('')).not.toContain('SECRET-TOKEN');
    });
  });

  describe('list and get', () => {
    it('clamps paging and returns entries', async () => {
      dlq.getWaitingCount.mockResolvedValue(3);
      dlq.getJobs.mockResolvedValue([
        { data: { id: 'a' } },
        { data: { id: 'b' } },
      ]);
      const res = await service.list(9999, -5);
      expect(dlq.getJobs).toHaveBeenCalledWith(['waiting'], 0, 99, true);
      expect(res).toMatchObject({ total: 3, limit: 100, offset: 0 });
      expect(res.items.map((e) => e.id)).toEqual(['a', 'b']);
    });

    it('404s for an unknown entry', async () => {
      await expect(service.get('nope')).rejects.toThrow(/not found/);
    });
  });

  describe('retry validation', () => {
    it('needs exactly one of ids / all', async () => {
      await expect(service.retry({})).rejects.toThrow(/either ids or all/);
      await expect(service.retry({ ids: [], all: false })).rejects.toThrow(
        /either ids or all/,
      );
      await expect(service.retry({ ids: ['a'], all: true })).rejects.toThrow(
        /either ids or all/,
      );
    });

    it('only allows a patch on a single id', async () => {
      await expect(
        service.retry({ ids: ['a', 'b'], patch: { value: 'AAAA' } }),
      ).rejects.toThrow(/exactly one id/);
      await expect(
        service.retry({ all: true, patch: { value: 'AAAA' } }),
      ).rejects.toThrow(/either ids or all|exactly one id/);
    });

    it('rejects malformed patches', () => {
      expect(() => service.validatePatch({ topic: ['AAAA'] })).toThrow(
        /at least 2/,
      );
      expect(() => service.validatePatch({ value: 'zzz' })).toThrow(
        /invalid ScVal XDR/,
      );
      expect(() => service.validatePatch({ contractId: 'GABC' })).toThrow(
        /valid contract id/,
      );
      expect(() => service.validatePatch({ value: 123 as never })).toThrow(
        /base64/,
      );
    });
  });
});
