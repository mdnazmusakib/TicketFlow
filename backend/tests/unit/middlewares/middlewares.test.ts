import express, { type Express } from 'express';
import request from 'supertest';
import { z } from 'zod';
import { InvalidTransitionError } from '../../../src/domain/lifecycle/bookingStateMachine';
import { createErrorHandler, notFoundHandler } from '../../../src/middlewares/errorHandler';
import { createRateLimiter } from '../../../src/middlewares/rateLimiter';
import { requestId } from '../../../src/middlewares/requestId';
import { getValidated, validate } from '../../../src/middlewares/validate';
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../../../src/shared/errors/AppError';
import { buildPaginationMeta, sendSuccess } from '../../../src/shared/http/apiResponse';
import { captureLogger } from '../../helpers/testApp';

function buildApp(configure: (app: Express) => void, exposeStack = false) {
  const { logger, lines } = captureLogger();
  const app = express();
  app.use(requestId);
  app.use(express.json({ limit: '1kb' }));
  configure(app);
  app.use(notFoundHandler);
  app.use(createErrorHandler(logger, { exposeStack }));
  return { app, lines };
}

describe('requestId', () => {
  it('generates an id and echoes a safe upstream id', async () => {
    const { app } = buildApp((a) => a.get('/x', (req, res) => res.json({ id: req.id })));
    const generated = await request(app).get('/x');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(generated.body.id).toBe(generated.headers['x-request-id']);

    const forwarded = await request(app).get('/x').set('X-Request-Id', 'upstream-req-12345');
    expect(forwarded.headers['x-request-id']).toBe('upstream-req-12345');
  });

  it('replaces unsafe upstream ids (log injection)', async () => {
    const { app } = buildApp((a) => a.get('/x', (_req, res) => res.end()));
    const response = await request(app).get('/x').set('X-Request-Id', 'bad id\twith<script>');
    expect(response.headers['x-request-id']).not.toContain('script');
  });
});

describe('validate', () => {
  const schemas = {
    params: z.object({ id: z.uuid() }),
    query: z.object({ page: z.coerce.number().int().min(1).default(1) }),
    body: z.object({ name: z.string().min(2) }).strict(),
  };

  const { app } = buildApp((a) =>
    a.post('/items/:id', validate(schemas), (req, res) => {
      const data = getValidated<{ query: { page: number }; params: { id: string }; body: unknown }>(req);
      res.json({ query: data.query, params: data.params, body: req.body });
    }),
  );

  it('passes parsed and coerced data through', async () => {
    const id = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const response = await request(app).post(`/items/${id}?page=3`).send({ name: 'ok' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ query: { page: 3 }, params: { id }, body: { name: 'ok' } });
  });

  it('collects issues from every request part in one 400 response', async () => {
    const response = await request(app).post('/items/not-a-uuid?page=0').send({ name: 'x', extra: true });
    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    const paths = (response.body.error.details as { path: string }[]).map((d) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['params.id', 'query.page', 'body.name']));
    expect(paths.some((p) => p.startsWith('body'))).toBe(true);
  });

  it('getValidated throws when validate() did not run', () => {
    expect(() => getValidated({})).toThrow('validate() middleware must run');
  });
});

describe('errorHandler', () => {
  const { app, lines } = buildApp((a) => {
    a.get('/unauthorized', () => {
      throw new UnauthorizedError();
    });
    a.get('/conflict', () => {
      throw new ConflictError('Seat already held');
    });
    a.get('/transition', () => {
      throw new InvalidTransitionError('booking', 'EXPIRED', 'CONFIRMED');
    });
    a.get('/zod', () => {
      z.object({ a: z.string() }).parse({});
    });
    a.get('/pg-unique', () => {
      throw Object.assign(new Error('duplicate key value'), { code: '23505', constraint: 'idx_active_seat_per_event' });
    });
    a.get('/unavailable', () => {
      throw new ServiceUnavailableError('Payment provider unavailable');
    });
    a.get('/boom', async () => {
      throw new Error('db password is hunter2');
    });
    a.post('/echo', (req, res) => res.json(req.body));
  });

  it('maps AppErrors to their status and code', async () => {
    const response = await request(app).get('/unauthorized');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required', requestId: expect.any(String) },
    });
    expect((await request(app).get('/conflict')).body.error).toMatchObject({ code: 'CONFLICT', message: 'Seat already held' });
  });

  it('maps domain transition errors to 409', async () => {
    const response = await request(app).get('/transition');
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('maps raw ZodErrors to 400 validation errors', async () => {
    const response = await request(app).get('/zod');
    expect(response.status).toBe(400);
    expect(response.body.error.details[0].path).toBe('a');
  });

  it('maps PostgreSQL unique violations to 409 without leaking SQL', async () => {
    const response = await request(app).get('/pg-unique');
    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('idx_active_seat_per_event');
    expect(response.body.error.message).not.toContain('duplicate key');
  });

  it('keeps intentional 503 messages', async () => {
    const response = await request(app).get('/unavailable');
    expect(response.status).toBe(503);
    expect(response.body.error.message).toBe('Payment provider unavailable');
  });

  it('hides unexpected error details and stack, and logs them server-side', async () => {
    const response = await request(app).get('/boom');
    expect(response.status).toBe(500);
    expect(response.body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: response.headers['x-request-id'],
    });
    expect(JSON.stringify(response.body)).not.toContain('hunter2');
    expect(lines().some((line) => line.level === 50 && line.msg === 'Request failed')).toBe(true);
  });

  it('handles malformed JSON and oversized bodies', async () => {
    const malformed = await request(app).post('/echo').set('Content-Type', 'application/json').send('{"a":');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('INVALID_JSON');

    const large = await request(app).post('/echo').send({ data: 'x'.repeat(5_000) });
    expect(large.status).toBe(413);
    expect(large.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const response = await request(app).get('/nope');
    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Route GET /nope not found' });
  });

  it('exposes stacks only when configured (development)', async () => {
    const dev = buildApp((a) => {
      a.get('/boom', () => {
        throw new NotFoundError();
      });
    }, true);
    const response = await request(dev.app).get('/boom');
    expect(response.body.error.stack).toContain('NotFoundError');
  });
});

describe('createRateLimiter', () => {
  it('returns 429 in the standard error shape once the limit is hit', async () => {
    const { app } = buildApp((a) => {
      a.use(createRateLimiter({ windowMs: 60_000, max: 2, skip: (req) => req.path === '/free' }));
      a.get('/limited', (_req, res) => res.json({ ok: true }));
      a.get('/free', (_req, res) => res.json({ ok: true }));
    });

    expect((await request(app).get('/limited')).status).toBe(200);
    const second = await request(app).get('/limited');
    expect(second.status).toBe(200);
    expect(second.headers.ratelimit).toBeDefined();
    const blocked = await request(app).get('/limited');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect((await request(app).get('/free')).status).toBe(200);
  });
});

describe('apiResponse helpers', () => {
  it('wraps data with optional meta', async () => {
    const { app } = buildApp((a) => {
      a.get('/plain', (_req, res) => sendSuccess(res, { a: 1 }));
      a.get('/paged', (_req, res) => sendSuccess(res, [1, 2], 200, buildPaginationMeta(2, 2, 5)));
      a.post('/created', (_req, res) => sendSuccess(res, { id: 'x' }, 201));
    });
    expect((await request(app).get('/plain')).body).toEqual({ success: true, data: { a: 1 } });
    expect((await request(app).get('/paged')).body.meta).toEqual({ page: 2, pageSize: 2, total: 5, totalPages: 3 });
    expect((await request(app).post('/created')).status).toBe(201);
    expect(buildPaginationMeta(1, 20, 0).totalPages).toBe(0);
  });
});
