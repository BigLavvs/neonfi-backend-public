// Neonfi backend — singleton guard (Build Guide §3.4).
//
// Fails loudly if any file OUTSIDE src/lib/ constructs `new PrismaClient(` or a
// new Redis client (`new Redis(` / `new IORedis(`). The Prisma and Redis clients
// must be instantiated once in src/lib/{prisma,redis}.ts and imported everywhere.
// Wired into `npm run build` so a violation blocks the build / CI.
//
// (prisma/ tooling — seed.ts, run-hypertable.ts — is intentionally NOT scanned:
//  the hypertable runner legitimately needs a dedicated DIRECT_URL client, and
//  these are one-shot CLI scripts, not request-path code.)

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const scanDir = join(root, 'src');
const allowDir = join(root, 'src', 'lib') + sep;

const patterns = [
  { re: /new\s+PrismaClient\s*\(/, what: 'new PrismaClient()' },
  { re: /new\s+(IORedis|Redis)\s*\(/, what: 'new Redis()' },
];

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const violations = [];
for (const file of walk(scanDir)) {
  if (file.startsWith(allowDir)) continue; // src/lib/ is the allowed home
  const text = readFileSync(file, 'utf8');
  for (const { re, what } of patterns) {
    if (re.test(text)) {
      violations.push(`  - ${relative(root, file)}: constructs ${what}`);
    }
  }
}

if (violations.length > 0) {
  console.error(
    `\n[check:singletons] Client construction is only allowed in src/lib/. Violations:\n${violations.join(
      '\n',
    )}\n\nImport the shared singleton from src/lib/prisma.ts or src/lib/redis.ts instead.\n`,
  );
  process.exit(1);
}

console.log('[check:singletons] OK — no Prisma/Redis client constructed outside src/lib/.');
