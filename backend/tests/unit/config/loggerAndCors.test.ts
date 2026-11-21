import { Writable } from 'node:stream';
import { buildCorsOptions } from '../../../src/config/cors';
import { createLogger, REDACT_PATHS } from '../../../src/config/logger';
import { ForbiddenError } from '../../../src/shared/errors/AppError';

function memoryStream(): { stream: Writable; output: () => string } {
  const chunks: string[] = [];
  return {
    stream: new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    }),
    output: () => chunks.join(''),
  };
}

describe('createLogger redaction', () => {
  it('censors secrets at the top level and when nested', () => {
    const { stream, output } = memoryStream();
    const logger = createLogger(
      { logLevel: 'info', isProduction: true, nodeEnv: 'production' },
      stream,
    );

    logger.info(
      {
        password: 'hunter2-password',
        otp: '123456',
        user: { email: 'a@b.co', passwordHash: '$2b$12$hashhash', token: 'jwt.token.value' },
        payment: { card: { cardNumber: '4111111111111111', cvv: '123' } },
        req: { headers: { authorization: 'Bearer abc.def', cookie: 'tf_session=xyz' } },
      },
      'sensitive payload',
    );

    const line = output();
    for (const secret of [
      'hunter2-password',
      '123456',
      '$2b$12$hashhash',
      'jwt.token.value',
      '4111111111111111',
      'Bearer abc.def',
      'tf_session=xyz',
    ]) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain('[REDACTED]');
    expect(line).toContain('a@b.co');
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toMatchObject({ level: 'info', service: 'ticketflow-api', env: 'production' });
  });

  it('keeps error codes (not treated as secrets)', () => {
    expect(REDACT_PATHS).not.toContain('code');
  });

  it('uses pretty transport only in development without explicit destination', () => {
    expect(() =>
      createLogger({ logLevel: 'silent', isProduction: false, nodeEnv: 'test' }),
    ).not.toThrow();
  });
});

describe('buildCorsOptions', () => {
  const options = buildCorsOptions(['http://localhost:5173', 'https://app.example.com/']);
  const origin = options.origin as (
    o: string | undefined,
    cb: (err: Error | null, allow?: boolean) => void,
  ) => void;

  const check = (value: string | undefined) =>
    new Promise<{ error: Error | null; allow?: boolean }>((resolve) => {
      origin(value, (error, allow) => resolve({ error, allow }));
    });

  it('allows listed origins (trailing slash normalised) and origin-less requests', async () => {
    await expect(check('http://localhost:5173')).resolves.toEqual({ error: null, allow: true });
    await expect(check('https://app.example.com')).resolves.toEqual({ error: null, allow: true });
    await expect(check(undefined)).resolves.toEqual({ error: null, allow: true });
  });

  it('rejects unknown origins with a 403 CORS error', async () => {
    const { error } = await check('https://evil.example.com');
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).code).toBe('CORS_ORIGIN_DENIED');
  });

  it('allows credentials and the Idempotency-Key header', () => {
    expect(options.credentials).toBe(true);
    expect(options.allowedHeaders).toContain('Idempotency-Key');
  });
});
