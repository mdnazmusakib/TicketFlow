#!/usr/bin/env node
/**
 * Fails when credentials could reach the public web app: scans the frontend sources and,
 * when present, the production build (frontend/dist) for demo account emails/passwords
 * and hard-coded password literals. Run after `npm run build` (CI does).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['frontend/src', 'frontend/index.html', 'frontend/public', 'frontend/dist'].map(
  (p) => path.join(root, p),
);
const patterns = [
  /[a-z0-9._-]+\.demo@example\.com/i,
  /Admin@12345|Organizer@123|Customer@123/,
  // A password-like literal without spaces, e.g. password: 'Secret123' (messages have spaces).
  /\bpassword\s*[:=]\s*['"`][^'"`\s]{6,}['"`]/i,
];

function* files(target) {
  if (!existsSync(target)) return;
  if (statSync(target).isFile()) {
    yield target;
    return;
  }
  for (const entry of readdirSync(target)) yield* files(path.join(target, entry));
}

const findings = [];
for (const target of targets) {
  for (const file of files(target)) {
    if (!/\.(html|js|mjs|cjs|ts|tsx|json|css|map|txt)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (match) findings.push(`${path.relative(root, file)}: matches ${pattern}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`Possible public credentials found:\n${findings.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('No public credentials found in frontend sources or build.\n');
