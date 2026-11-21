import { ConfigError, loadConfig } from '../../../src/config/env';

const base: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  CORS_ORIGINS: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/ticketflow',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a'.repeat(48),
};

const production: NodeJS.ProcessEnv = {
  ...base,
  NODE_ENV: 'production',
  CORS_ORIGINS: 'https://ticketflow.example.com',
  JWT_SECRET: 'Zq8vN3kL0pR7tX2wY5bC9dF4gH6jK1mQzA0sD8fG3hJ',
};

function issuesOf(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error('expected ConfigError');
}

describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      nodeEnv: 'development',
      isProduction: false,
      isTest: false,
      port: 4000,
      corsOrigins: ['http://localhost:5173'],
      database: { ssl: true, poolMax: 10, statementTimeoutMs: 15000, sslCaPath: undefined },
      redis: { keyPrefix: 'ticketflow:' },
      auth: { bcryptSaltRounds: 12, jwtExpiresIn: '1h', otpBypass: false },
      booking: { maxTicketsPerUserPerEvent: 6, seatHoldTtlSeconds: 300, defaultCurrency: 'BDT' },
      allowSeed: false,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('coerces numbers, booleans and comma-separated lists', () => {
    const config = loadConfig({
      ...base,
      PORT: '8080',
      DATABASE_SSL: 'false',
      CORS_ORIGINS: ' http://localhost:5173 , https://app.example.com ,',
      MAX_TICKETS_PER_USER_PER_EVENT: '4',
      ALLOW_SEED: '1',
    });
    expect(config.port).toBe(8080);
    expect(config.database.ssl).toBe(false);
    expect(config.corsOrigins).toEqual(['http://localhost:5173', 'https://app.example.com']);
    expect(config.booking.maxTicketsPerUserPerEvent).toBe(4);
    expect(config.allowSeed).toBe(true);
  });

  it('reports every missing required variable by name', () => {
    const issues = issuesOf({});
    expect(issues).toEqual(
      expect.arrayContaining([
        'CORS_ORIGINS: is required',
        'DATABASE_URL: is required',
        'REDIS_URL: is required',
        'JWT_SECRET: is required',
      ]),
    );
  });

  it('rejects malformed values without echoing them', () => {
    const secretLookingUrl = 'mysql://root:SuperSecret@db';
    const issues = issuesOf({ ...base, DATABASE_URL: secretLookingUrl, JWT_SECRET: 'short', PORT: '99999' });
    expect(issues.some((issue) => issue.startsWith('DATABASE_URL:'))).toBe(true);
    expect(issues.some((issue) => issue.startsWith('JWT_SECRET:'))).toBe(true);
    expect(issues.some((issue) => issue.startsWith('PORT:'))).toBe(true);
    expect(issues.join(' ')).not.toContain('SuperSecret');
  });

  it('rejects wildcard or non-URL CORS origins', () => {
    expect(issuesOf({ ...base, CORS_ORIGINS: '*' }).join()).toContain('CORS_ORIGINS');
    expect(issuesOf({ ...base, CORS_ORIGINS: '' }).join()).toContain('CORS_ORIGINS');
  });

  it('rejects a Redis URL with the wrong scheme and invalid key prefix', () => {
    const issues = issuesOf({ ...base, REDIS_URL: 'http://localhost', REDIS_KEY_PREFIX: 'Bad Prefix' });
    expect(issues.join()).toContain('REDIS_URL');
    expect(issues.join()).toContain('REDIS_KEY_PREFIX');
  });

  it('enables the OTP bypass in test mode or with TEST_BYPASS_OTP outside production', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'test' }).auth.otpBypass).toBe(true);
    expect(loadConfig({ ...base, TEST_BYPASS_OTP: 'true' }).auth.otpBypass).toBe(true);
    expect(loadConfig(base).auth.otpBypass).toBe(false);
  });

  it('accepts a hardened production configuration', () => {
    const config = loadConfig(production);
    expect(config.isProduction).toBe(true);
    expect(config.auth.otpBypass).toBe(false);
  });

  it('enforces production safety rules', () => {
    const issues = issuesOf({
      ...production,
      TEST_BYPASS_OTP: 'true',
      DATABASE_SSL: 'false',
      CORS_ORIGINS: 'http://insecure.example.com',
      JWT_SECRET: 'replace-with-at-least-32-random-characters-xxxxxxxx',
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        'TEST_BYPASS_OTP: must be false in production',
        'DATABASE_SSL: must be true in production',
        'CORS_ORIGINS: production origins must use https',
        'JWT_SECRET: looks like a placeholder; generate a random secret',
      ]),
    );
  });

  it('ConfigError message lists the issues', () => {
    expect(() => loadConfig({})).toThrow(/Invalid environment configuration:\n {2}- /);
  });
});
