// Deterministic test environment. Never loads a developer's .env file.
const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  CORS_ORIGINS: 'http://localhost:5173',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/postgres',
  DATABASE_SSL: 'false',
  REDIS_URL: 'redis://127.0.0.1:6379',
  JWT_SECRET: 'test-only-jwt-key-0123456789abcdefghijklmnop',
  BCRYPT_SALT_ROUNDS: '10',
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
process.env.NODE_ENV = 'test';
