/* eslint-disable
  @typescript-eslint/require-await,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-misused-promises
  -- test doubles, mocked async functions and raw SQL rows are intentionally loosely typed */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { IndexerDlqService } from './indexer-dlq.service';
import { AdminGuard } from '../auth/guards/admin.guard';

describe('/admin/indexer/dlq over HTTP', () => {
  const dlq = {
    list: jest.fn(async (limit = 20, offset = 0) => ({
      total: 1,
      limit,
      offset,
      items: [{ id: 'evt-1' }],
    })),
    get: jest.fn(async (id: string) => ({ id })),
    retry: jest.fn(async () => ({ requeued: ['evt-1'], notFound: [] })),
  };

  async function appWith(opts: { allow: boolean }) {
    let builder = Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: AdminService, useValue: {} },
        { provide: IndexerDlqService, useValue: dlq },
      ],
    });
    if (opts.allow) {
      builder = builder
        .overrideGuard(AdminGuard)
        .useValue({ canActivate: () => true });
    }
    const moduleRef = await builder.compile();
    const app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    return app;
  }

  describe('with an admin caller', () => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await appWith({ allow: true });
    });
    afterAll(async () => app.close());
    beforeEach(() => jest.clearAllMocks());

    it('GET /admin/indexer/dlq/list is routed to list, not to :id', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/indexer/dlq/list?limit=10&offset=5')
        .expect(200);
      expect(res.body).toMatchObject({ total: 1, limit: 10, offset: 5 });
      expect(dlq.list).toHaveBeenCalledWith(10, 5);
      expect(dlq.get).not.toHaveBeenCalled();
    });

    it('rejects out-of-range paging with 400', async () => {
      await request(app.getHttpServer())
        .get('/admin/indexer/dlq/list?limit=1000')
        .expect(400);
      expect(dlq.list).not.toHaveBeenCalled();
    });

    it('GET /admin/indexer/dlq/:id inspects one entry', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/indexer/dlq/0000000000000000001-0000000000')
        .expect(200);
      expect(res.body).toEqual({ id: '0000000000000000001-0000000000' });
    });

    it('POST /admin/indexer/dlq/retry re-drives and returns the outcome', async () => {
      const body = { ids: ['evt-1'], patch: { value: 'AAAA' } };
      const res = await request(app.getHttpServer())
        .post('/admin/indexer/dlq/retry')
        .send(body)
        .expect(201);
      expect(res.body).toEqual({ requeued: ['evt-1'], notFound: [] });
      expect(dlq.retry).toHaveBeenCalledWith(body);
    });

    it('POST retry validates the body', async () => {
      await request(app.getHttpServer())
        .post('/admin/indexer/dlq/retry')
        .send({ ids: 'not-an-array' })
        .expect(400);
      await request(app.getHttpServer())
        .post('/admin/indexer/dlq/retry')
        .send({ ids: ['a'], extra: 1 })
        .expect(400);
      expect(dlq.retry).not.toHaveBeenCalled();
    });
  });

  describe('without admin rights', () => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await appWith({ allow: false });
    });
    afterAll(async () => app.close());

    it('is closed to anonymous callers on every route', async () => {
      const server = app.getHttpServer();
      await request(server).get('/admin/indexer/dlq/list').expect(401);
      await request(server).get('/admin/indexer/dlq/x').expect(401);
      await request(server)
        .post('/admin/indexer/dlq/retry')
        .send({ all: true })
        .expect(401);
      expect(dlq.list).not.toHaveBeenCalled();
      expect(dlq.retry).not.toHaveBeenCalled();
    });
  });
});
