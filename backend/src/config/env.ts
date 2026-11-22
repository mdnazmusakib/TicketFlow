import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const urlWithProtocols = (protocols: readonly string[]) =>
  z
    .string()
    .min(1)
    .refine(
      (value) => {
        try {
          return protocols.includes(new URL(value).protocol);
        } catch {
          return false;
        }
      },
      { message: `must be a valid URL using ${protocols.join(' or ')}` },
    );

const csvList = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    CORS_ORIGINS: csvList.pipe(
      z.array(urlWithProtocols(['http:', 'https:'])).min(1, 'at least one origin is required'),
    ),
    TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),

    DATABASE_URL: urlWithProtocols(['postgres:', 'postgresql:']),
    DATABASE_SSL: booleanString.default(true),
    /** Optional path to the Supabase root CA (PEM). When set, the server certificate is verified. */
    DATABASE_SSL_CA_PATH: z.string().min(1).optional(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),

    REDIS_URL: urlWithProtocols(['redis:', 'rediss:']),
    REDIS_KEY_PREFIX: z
      .string()
      .regex(/^[a-z0-9_-]+:$/, 'must be lowercase and end with ":"')
      .default('ticketflow:'),

    JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_EXPIRES_IN: z
      .string()
      .regex(/^\d+[smhd]$/, 'must look like 15m, 1h or 7d')
      .default('1h'),
    BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
    TEST_BYPASS_OTP: booleanString.default(false),
    AUTH_COOKIE_NAME: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,40}$/)
      .default('tf_session'),
    /** Defaults to true in production. Can only be disabled outside production (plain-http localhost). */
    COOKIE_SECURE: booleanString.optional(),
    COOKIE_SAMESITE: z.enum(['lax', 'strict']).default('lax'),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
    OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(10).max(600).default(60),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),

    EMAIL_TRANSPORT: z.enum(['console', 'smtp']).default('console'),
    EMAIL_FROM: z.string().min(3).default('TicketFlow <no-reply@ticketflow.local>'),
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_SECURE: booleanString.default(false),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASS: z.string().min(1).optional(),

    MAX_TICKETS_PER_USER_PER_EVENT: z.coerce.number().int().min(1).max(50).default(6),
    SEAT_HOLD_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
    /** How often the background worker releases expired holds. */
    BOOKING_EXPIRY_INTERVAL_MS: z.coerce.number().int().min(1000).max(600000).default(15000),
    /** Hold/checkout/cancel requests per window per IP. */
    BOOKING_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(60),
    DEFAULT_CURRENCY: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default('BDT'),

    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(900000),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),

    ALLOW_SEED: booleanString.default(false),
  })
  .superRefine((env, ctx) => {
    if (env.EMAIL_TRANSPORT === 'smtp' && !env.SMTP_HOST) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_HOST'],
        message: 'is required when EMAIL_TRANSPORT=smtp',
      });
    }
    if (env.NODE_ENV !== 'production') return;
    if (env.EMAIL_TRANSPORT !== 'smtp') {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_TRANSPORT'],
        message: 'must be smtp in production (console transport prints OTPs)',
      });
    }
    if (env.COOKIE_SECURE === false) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'must be true in production',
      });
    }
    if (env.TEST_BYPASS_OTP) {
      ctx.addIssue({
        code: 'custom',
        path: ['TEST_BYPASS_OTP'],
        message: 'must be false in production',
      });
    }
    if (!env.DATABASE_SSL) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_SSL'],
        message: 'must be true in production',
      });
    }
    if (env.CORS_ORIGINS.some((origin) => new URL(origin).protocol !== 'https:')) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'production origins must use https',
      });
    }
    if (/replace-with|changeme|secret/i.test(env.JWT_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'looks like a placeholder; generate a random secret',
      });
    }
  });

type ParsedEnv = z.output<typeof envSchema>;

export interface AppConfig {
  nodeEnv: ParsedEnv['NODE_ENV'];
  isProduction: boolean;
  isTest: boolean;
  port: number;
  logLevel: ParsedEnv['LOG_LEVEL'];
  corsOrigins: string[];
  trustProxy: number;
  database: {
    url: string;
    ssl: boolean;
    sslCaPath: string | undefined;
    poolMax: number;
    statementTimeoutMs: number;
  };
  redis: {
    url: string;
    keyPrefix: string;
  };
  auth: {
    jwtSecret: string;
    jwtExpiresIn: string;
    bcryptSaltRounds: number;
    /** OTP is bypassed when running tests or when explicitly enabled outside production. */
    otpBypass: boolean;
    otpTtlSeconds: number;
    otpMaxAttempts: number;
    otpResendCooldownSeconds: number;
    rateLimitMax: number;
    cookie: {
      name: string;
      secure: boolean;
      sameSite: 'lax' | 'strict';
    };
  };
  email: {
    transport: 'console' | 'smtp';
    from: string;
    smtp?: { host: string; port: number; secure: boolean; user?: string; pass?: string };
  };
  booking: {
    maxTicketsPerUserPerEvent: number;
    seatHoldTtlSeconds: number;
    defaultCurrency: string;
    expiryIntervalMs: number;
    rateLimitMax: number;
  };
  rateLimit: {
    windowMs: number;
    max: number;
  };
  allowSeed: boolean;
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validates raw environment variables and maps them to a typed, frozen config.
 * Error messages name the variable and the rule only — never the value — so
 * secrets cannot leak into logs on misconfiguration.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const key = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      const topLevelKey = issue.path[0];
      const missing =
        issue.code !== 'custom' &&
        typeof topLevelKey === 'string' &&
        source[topLevelKey] === undefined;
      return `${key}: ${missing ? 'is required' : issue.message}`;
    });
    throw new ConfigError(issues);
  }

  const env = result.data;
  const isTest = env.NODE_ENV === 'test';

  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    isTest,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    corsOrigins: env.CORS_ORIGINS,
    trustProxy: env.TRUST_PROXY,
    database: {
      url: env.DATABASE_URL,
      ssl: env.DATABASE_SSL,
      sslCaPath: env.DATABASE_SSL_CA_PATH,
      poolMax: env.DATABASE_POOL_MAX,
      statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    },
    redis: {
      url: env.REDIS_URL,
      keyPrefix: env.REDIS_KEY_PREFIX,
    },
    auth: {
      jwtSecret: env.JWT_SECRET,
      jwtExpiresIn: env.JWT_EXPIRES_IN,
      bcryptSaltRounds: env.BCRYPT_SALT_ROUNDS,
      // Never bypassed in production (TEST_BYPASS_OTP is rejected there as well).
      otpBypass: env.NODE_ENV !== 'production' && (isTest || env.TEST_BYPASS_OTP),
      otpTtlSeconds: 300,
      otpMaxAttempts: env.OTP_MAX_ATTEMPTS,
      otpResendCooldownSeconds: env.OTP_RESEND_COOLDOWN_SECONDS,
      rateLimitMax: env.AUTH_RATE_LIMIT_MAX,
      cookie: {
        name: env.AUTH_COOKIE_NAME,
        secure: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
        sameSite: env.COOKIE_SAMESITE,
      },
    },
    email: {
      transport: env.EMAIL_TRANSPORT,
      from: env.EMAIL_FROM,
      ...(env.EMAIL_TRANSPORT === 'smtp' && env.SMTP_HOST
        ? {
            smtp: {
              host: env.SMTP_HOST,
              port: env.SMTP_PORT,
              secure: env.SMTP_SECURE,
              ...(env.SMTP_USER ? { user: env.SMTP_USER } : {}),
              ...(env.SMTP_PASS ? { pass: env.SMTP_PASS } : {}),
            },
          }
        : {}),
    },
    booking: {
      maxTicketsPerUserPerEvent: env.MAX_TICKETS_PER_USER_PER_EVENT,
      seatHoldTtlSeconds: env.SEAT_HOLD_TTL_SECONDS,
      defaultCurrency: env.DEFAULT_CURRENCY,
      expiryIntervalMs: env.BOOKING_EXPIRY_INTERVAL_MS,
      rateLimitMax: env.BOOKING_RATE_LIMIT_MAX,
    },
    rateLimit: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
    },
    allowSeed: env.ALLOW_SEED,
  });
}
