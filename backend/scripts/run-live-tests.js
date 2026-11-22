#!/usr/bin/env node
/**
 * Runs the live connectivity suites against the real Supabase PostgreSQL and
 * Redis configured in backend/.env. Values are passed to Jest through the
 * environment only; nothing is printed or written to disk.
 *
 * Usage: npm run test:live          (project "live")
 *        npm run test:concurrency   (project "concurrency": embedded PostgreSQL + real Redis)
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const missing = ['DATABASE_URL', 'REDIS_URL'].filter((key) => !process.env[key]);
if (missing.length > 0) {
  process.stderr.write(`Missing in backend/.env: ${missing.join(', ')}\n`);
  process.exit(1);
}

const env = {
  ...process.env,
  NODE_ENV: 'test',
  LIVE_DATABASE_URL: process.env.DATABASE_URL,
  TEST_REDIS_URL: process.env.REDIS_URL,
};

const project = process.argv[2] === 'concurrency' ? 'concurrency' : 'live';
const result = spawnSync(
  process.execPath,
  [require.resolve('jest/bin/jest'), '--selectProjects', project, '--runInBand'],
  { cwd: path.join(__dirname, '..'), env, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
