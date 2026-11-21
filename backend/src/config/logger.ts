import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import type { AppConfig } from './env';

/**
 * Paths removed from every log line. Covers request/response headers and the
 * common places secrets show up in bodies and error objects.
 */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  ...[
    'password',
    'passwordHash',
    'password_hash',
    'newPassword',
    'currentPassword',
    'token',
    'accessToken',
    'refreshToken',
    'authorization',
    'cookie',
    'otp',
    'secret',
    'jwtSecret',
    'apiKey',
    'cardNumber',
    'cvv',
    'cvc',
    'pan',
    'storePassword',
    'store_passwd',
    'connectionString',
    'databaseUrl',
    'redisUrl',
  ].flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
];

export function createLogger(
  config: Pick<AppConfig, 'logLevel' | 'isProduction' | 'nodeEnv'>,
  destination?: DestinationStream,
): Logger {
  const options: LoggerOptions = {
    level: config.logLevel,
    base: { service: 'ticketflow-api', env: config.nodeEnv },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  if (!destination && config.nodeEnv === 'development') {
    options.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
    };
  }

  return destination ? pino(options, destination) : pino(options);
}
