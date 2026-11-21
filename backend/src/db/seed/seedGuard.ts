import type { AppConfig } from '../../config/env';

/** Demo accounts have public passwords: refuse to seed production unless explicitly allowed. */
export function assertSeedAllowed(config: Pick<AppConfig, 'isProduction' | 'allowSeed'>): void {
  if (config.isProduction && !config.allowSeed) {
    throw new Error('Refusing to seed demo data in production. Set ALLOW_SEED=true to override.');
  }
}
