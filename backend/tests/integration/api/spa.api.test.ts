import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApiHarness, type ApiHarness } from '../../helpers/apiHarness';
import { createFrontendRouter } from '../../../src/middlewares/spa';

describe('single-host deployment: API serves the built web app', () => {
  let h: ApiHarness;
  const dist = mkdtempSync(path.join(tmpdir(), 'tf-dist-'));

  beforeAll(async () => {
    mkdirSync(path.join(dist, 'assets'));
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'console.info(1)');
    writeFileSync(path.join(dist, '.env'), 'SECRET=1');
    h = await createApiHarness({ env: { FRONTEND_DIST_DIR: dist } });
  });

  afterAll(async () => {
    await h.close();
    rmSync(dist, { recursive: true, force: true });
  });

  it('serves index.html for client routes with a strict page CSP', async () => {
    const res = await request(h.app).get('/events/123').set('Accept', 'text/html').expect(200);
    expect(res.text).toContain('id="root"');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('caches hashed assets, hides dotfiles, and keeps API 404s as JSON', async () => {
    const asset = await request(h.app).get('/assets/index-abc123.js').expect(200);
    expect(asset.headers['cache-control']).toContain('immutable');
    const dot = await request(h.app).get('/.env').set('Accept', 'text/html');
    expect(dot.text).not.toContain('SECRET');
    const api = await request(h.app).get('/api/nope').set('Accept', 'text/html').expect(404);
    expect(api.body.error.code).toBe('NOT_FOUND');
    await request(h.app).get('/api/health/live').expect(200);
  });

  it('refuses to start without a build', () => {
    expect(() => createFrontendRouter(path.join(dist, 'missing'))).toThrow('index.html');
  });
});
