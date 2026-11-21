import { Writable } from 'node:stream';
import pino from 'pino';
import { loadConfig, type AppConfig } from '../../src/config/env';

/** Config for tests, with optional env overrides. */
export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...process.env, ...overrides });
}

/** Silent logger that also captures lines for assertions. */
export function captureLogger(): { logger: pino.Logger; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const logger = pino({ level: 'trace' }, stream);
  return {
    logger,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
