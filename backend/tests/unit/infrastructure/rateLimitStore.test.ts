import express from 'express';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import request from 'supertest';
import { RedisRateLimitStore } from '../../../src/infrastructure/redis/RedisRateLimitStore';
import { createRateLimiter } from '../../../src/middlewares/rateLimiter';

describe('RedisRateLimitStore', () => {
  let redis: Redis;
  beforeEach(() => {
    redis = new RedisMock({ keyPrefix: `rl${Date.now()}${Math.random()}:` }) as unknown as Redis;
  });
  afterEach(() => redis.disconnect());

  it('counts hits per client within the window and resets keys', async () => {
    const store = new RedisRateLimitStore(redis, 'api');
    store.init({ windowMs: 60_000 } as never);
    expect((await store.increment('1.2.3.4')).totalHits).toBe(1);
    const second = await store.increment('1.2.3.4');
    expect(second.totalHits).toBe(2);
    expect(second.resetTime!.getTime()).toBeGreaterThan(Date.now());
    expect((await store.increment('5.6.7.8')).totalHits).toBe(1);
    await store.decrement('1.2.3.4');
    expect((await store.increment('1.2.3.4')).totalHits).toBe(2);
    await store.resetKey('1.2.3.4');
    expect((await store.increment('1.2.3.4')).totalHits).toBe(1);
  });

  it('two app instances sharing Redis share one budget', async () => {
    const build = () => {
      const app = express();
      app.use(
        createRateLimiter({
          windowMs: 60_000,
          max: 3,
          store: new RedisRateLimitStore(redis, 'shared'),
        }),
      );
      app.get('/', (_req, res) => {
        res.json({ ok: true });
      });
      app.use(
        (
          err: { statusCode?: number },
          _req: express.Request,
          res: express.Response,
          _next: express.NextFunction,
        ) => {
          res.status(err.statusCode ?? 500).end();
        },
      );
      return app;
    };
    const [a, b] = [build(), build()];
    await request(a).get('/').expect(200);
    await request(b).get('/').expect(200);
    await request(a).get('/').expect(200);
    await request(b).get('/').expect(429);
  });
});
