/* eslint-disable
  @typescript-eslint/require-await,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-misused-promises
  -- test doubles, mocked async functions and raw SQL rows are intentionally loosely typed */
import { ValidationPipe } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { ListIndexerDlqDto, RetryIndexerDlqDto } from './dto/indexer-dlq.dto';

describe('AdminController indexer DLQ endpoints', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const run = <T>(type: new () => T, value: object) =>
    pipe.transform(value, { type: 'query', metatype: type, data: '' });

  describe('DTO validation', () => {
    it('coerces and bounds list paging', async () => {
      await expect(
        run(ListIndexerDlqDto, { limit: '25', offset: '5' }),
      ).resolves.toMatchObject({
        limit: 25,
        offset: 5,
      });
      await expect(run(ListIndexerDlqDto, { limit: '0' })).rejects.toThrow();
      await expect(run(ListIndexerDlqDto, { limit: '101' })).rejects.toThrow();
      await expect(run(ListIndexerDlqDto, { offset: '-1' })).rejects.toThrow();
    });

    it('accepts ids, all, and a nested patch', async () => {
      await expect(
        run(RetryIndexerDlqDto, { ids: ['a'], patch: { value: 'AAAA' } }),
      ).resolves.toBeTruthy();
      await expect(
        run(RetryIndexerDlqDto, { all: true }),
      ).resolves.toBeTruthy();
    });

    it('rejects wrong types, oversized id lists and unknown fields', async () => {
      await expect(run(RetryIndexerDlqDto, { ids: 'a' })).rejects.toThrow();
      await expect(run(RetryIndexerDlqDto, { ids: [1] })).rejects.toThrow();
      await expect(
        run(RetryIndexerDlqDto, {
          ids: Array.from({ length: 101 }, (_, i) => `${i}`),
        }),
      ).rejects.toThrow();
      await expect(
        run(RetryIndexerDlqDto, { ids: ['a'], hack: true }),
      ).rejects.toThrow();
      await expect(
        run(RetryIndexerDlqDto, { ids: ['a'], patch: { value: 5 } }),
      ).rejects.toThrow();
    });
  });

  describe('delegation', () => {
    const dlq = {
      list: jest.fn(async () => ({ total: 0, items: [] })),
      get: jest.fn(async () => ({ id: 'x' })),
      retry: jest.fn(async () => ({ requeued: ['x'], notFound: [] })),
    };
    const controller = new AdminController({} as never, dlq as never);

    it('GET list passes paging through', async () => {
      await controller.listIndexerDlq({ limit: 10, offset: 20 });
      expect(dlq.list).toHaveBeenCalledWith(10, 20);
    });

    it('GET :id inspects one entry', async () => {
      await expect(controller.getIndexerDlqEntry('x')).resolves.toEqual({
        id: 'x',
      });
    });

    it('POST retry passes the body through', async () => {
      const body = { ids: ['x'], patch: { value: 'AAAA' } };
      await expect(controller.retryIndexerDlq(body)).resolves.toEqual({
        requeued: ['x'],
        notFound: [],
      });
      expect(dlq.retry).toHaveBeenCalledWith(body);
    });
  });
});
