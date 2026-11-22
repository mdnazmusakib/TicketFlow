#!/usr/bin/env node
/* eslint-disable no-console -- CLI report printed to the terminal (no secrets are printed). */
/**
 * Schema consistency check: compares the live database (DATABASE_URL from
 * backend/.env, read via dotenv and never printed) with a fresh database built
 * from the migrations (embedded PostgreSQL), and both with DATABASE_DESIGN.md.
 *
 * Usage: node scripts/schema-report.js
 * Exit code 1 when anything differs.
 */
const path = require('node:path');
const fs = require('node:fs');
const { createServer } = require('node:net');
const { Pool } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const SIGNATURE_SQL = {
  columns: `SELECT table_name || '.' || column_name || ' ' || data_type ||
              CASE WHEN character_maximum_length IS NOT NULL THEN '(' || character_maximum_length || ')' ELSE '' END ||
              CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END ||
              COALESCE(' DEFAULT ' || column_default, '') AS s
            FROM information_schema.columns WHERE table_schema = 'public'`,
  constraints: `SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS s
                FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype <> 'n'`,
  indexes: `SELECT tablename || ' ' || indexname || ' ' || indexdef AS s FROM pg_indexes WHERE schemaname = 'public'`,
  triggers: `SELECT event_object_table || ' ' || trigger_name || ' ' || action_timing || ' ' || event_manipulation AS s
             FROM information_schema.triggers WHERE trigger_schema = 'public'`,
  functions: `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS s
              FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace`,
  rls: `SELECT relname || ' rls=' || relrowsecurity AS s FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`,
};

async function signature(pool) {
  const out = {};
  for (const [key, sql] of Object.entries(SIGNATURE_SQL)) {
    const { rows } = await pool.query(sql);
    // PG17 vs PG18 print extension operator classes with/without their schema.
    out[key] = rows.map((r) => r.s.replace(/extensions\./g, '')).sort();
  }
  return out;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Tables and columns documented in DATABASE_DESIGN.md §4 (`### 4.x \`table\`` + `| \`col\` |` rows). */
function documentedColumns() {
  const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'DATABASE_DESIGN.md'), 'utf8');
  const tables = new Map();
  let current = null;
  for (const line of doc.split('\n')) {
    const heading = /^### 4\.\d+ `([a-z_]+)`/.exec(line);
    if (heading) {
      current = heading[1];
      tables.set(current, new Set());
      continue;
    }
    if (/^#{2,3} /.test(line)) current = null;
    if (!current) continue;
    const cell = /^\| ([^|]+) \|/.exec(line);
    if (!cell) continue;
    for (const name of cell[1].matchAll(/`([a-z_]+)`/g)) tables.get(current).add(name[1]);
  }
  return tables;
}

async function run() {
  const live = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 2,
  });
  const liveSig = await signature(live);
  await live.end();

  const EmbeddedPostgres = require('embedded-postgres').default;
  const port = await freePort();
  const dir = path.join(__dirname, '..', '.embedded-pg', `schema-${process.pid}`);
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    postgresFlags: ['-c', 'io_method=sync'],
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  let freshSig;
  try {
    const fresh = new Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
      max: 2,
    });
    // Apply the SQL migrations in order (same files the Migrator applies).
    const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
    for (const file of fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      await fresh.query(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    }
    freshSig = await signature(fresh);
    await fresh.end();
  } finally {
    await pg.stop();
  }

  let problems = 0;
  // Supabase-managed roles/extensions add nothing in "public"; the migration bookkeeping table
  // is created by the Migrator itself, so ignore it in the fresh copy comparison.
  const ignore = (s) => s.startsWith('schema_migrations') || s.includes('schema_migrations');
  for (const key of Object.keys(SIGNATURE_SQL)) {
    const a = new Set(liveSig[key].filter((s) => !ignore(s)));
    const b = new Set(freshSig[key].filter((s) => !ignore(s)));
    const onlyLive = [...a].filter((s) => !b.has(s));
    const onlyMigrations = [...b].filter((s) => !a.has(s));
    console.log(`${key}: live=${a.size} migrations=${b.size}`);
    for (const s of onlyLive) console.log(`  only in live DB:    ${s}`);
    for (const s of onlyMigrations) console.log(`  only in migrations: ${s}`);
    problems += onlyLive.length + onlyMigrations.length;
  }

  // Documentation vs actual columns.
  const actual = new Map();
  for (const entry of liveSig.columns) {
    const [qualified] = entry.split(' ');
    const [table, column] = qualified.split('.');
    if (!actual.has(table)) actual.set(table, new Set());
    actual.get(table).add(column);
  }
  const documented = documentedColumns();
  for (const [table, columns] of actual) {
    const doc = documented.get(table);
    if (!doc) {
      console.log(`doc: table ${table} is not documented`);
      problems += 1;
      continue;
    }
    for (const column of columns) {
      if (!doc.has(column)) {
        console.log(`doc: ${table}.${column} is not documented`);
        problems += 1;
      }
    }
  }
  for (const [table, columns] of documented) {
    if (!actual.has(table)) {
      console.log(`doc: documented table ${table} does not exist`);
      problems += 1;
      continue;
    }
    for (const column of columns) {
      if (!actual.get(table).has(column) && !/^(uq|idx|chk|fk|pk)_/.test(column)) {
        console.log(`doc: documented column ${table}.${column} does not exist`);
        problems += 1;
      }
    }
  }
  console.log(problems === 0 ? 'Schema consistent.' : `${problems} difference(s).`);
  process.exit(problems === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
