import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const hardLimit = 600;
const target = 500;
const explicitExceptions = new Set(['prisma/schema.prisma']);
const excludedDirs = new Set(['node_modules', 'dist', 'coverage', '.git', 'migrations']);
const excludedExt = new Set(['.lock', '.md', '.docx', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.svg']);
const maintainedRoots = ['src', 'tests', 'scripts', 'prisma'];
const files = [];

function walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirs.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else files.push(path);
  }
}
for (const dir of maintainedRoots) walk(join(root, dir));
if (existsSync(join(root, 'prisma/schema.prisma'))) files.push(join(root, 'prisma/schema.prisma'));

const overTarget = [];
const overHard = [];
for (const path of files) {
  const rel = relative(root, path).replaceAll('\\', '/');
  if (explicitExceptions.has(rel) || excludedExt.has(rel.slice(rel.lastIndexOf('.')))) continue;
  const content = readFileSync(path, 'utf8');
  const lineParts = content.split(/\r?\n/);
  if (lineParts.at(-1) === '') lineParts.pop();
  const lines = lineParts.length;
  if (lines > target) overTarget.push(`${lines}\t${rel}`);
  if (lines > hardLimit) overHard.push(`${lines}\t${rel}`);
}
for (const item of overTarget.sort((a, b) => Number(b.split('\t')[0]) - Number(a.split('\t')[0]))) console.warn(`FILE_SIZE_TARGET ${item}`);
if (overHard.length) {
  console.error('Maintained files exceed the 600-line limit:');
  for (const item of overHard.sort()) console.error(`FILE_SIZE_HARD ${item}`);
  process.exit(1);
}
