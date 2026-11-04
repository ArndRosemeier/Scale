#!/usr/bin/env node
/**
 * Vendors packages from AssetGenerator (github.com/ArndRosemeier/AssetGenerator, `packages/`: the
 * shared TypeScript of the futuremagic games) into vendor/futuremagic/<name>, at a pinned commit.
 * They are TypeScript source (no build step); package.json depends on them with `file:`.
 *
 *   node tools/futuremagic.mjs <commit> <package…>       e.g. node tools/futuremagic.mjs b34dda6 stage
 *   node tools/futuremagic.mjs --from <checkout> <package…>   (a local AssetGenerator checkout at its HEAD)
 *
 * Then `npm install`. vendor/futuremagic/COMMIT records the commit.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let src, commit, tmp;
if (args[0] === '--from') {
  src = args[1];
  args.splice(0, 2);
  commit = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} else {
  commit = args.shift();
  if (!commit || !args.length) { console.error('usage: node tools/futuremagic.mjs <commit> <package…>'); process.exit(1); }
  tmp = src = mkdtempSync(join(tmpdir(), 'futuremagic-'));
  const git = (...a) => execFileSync('git', ['-C', src, ...a], { stdio: 'inherit', env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' } });
  git('init', '-q');
  git('remote', 'add', 'origin', 'https://github.com/ArndRosemeier/AssetGenerator');
  git('fetch', '-q', '--depth', '1', 'origin', commit);
  git('checkout', '-q', 'FETCH_HEAD');
  commit = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}
const out = join(root, 'vendor/futuremagic');
for (const name of args) {
  const from = join(src, 'packages', name);
  if (!existsSync(join(from, 'package.json'))) { console.error(`no package ${name} in AssetGenerator`); process.exit(1); }
  const to = join(out, name);
  rmSync(to, { recursive: true, force: true });
  for (const f of ['package.json', 'README.md', 'src']) if (existsSync(join(from, f))) cpSync(join(from, f), join(to, f), { recursive: true });
  console.log(`vendor/futuremagic/${name} ← AssetGenerator ${commit.slice(0, 7)}`);
}
writeFileSync(join(out, 'COMMIT'), `${commit}\n`);
if (tmp) rmSync(tmp, { recursive: true, force: true });
