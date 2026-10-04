// Before every push: raise the version by 0.001 (src/version.ts) and open its section in
// CHANGELOG.md (the entries are written by hand under it). Prints the new version.
//   node tools/release.mjs            bump and add "## <version> — <date>"
//   node tools/release.mjs --check    exit 1 if CHANGELOG.md has no section for the current version
import { readFileSync, writeFileSync } from 'node:fs';

const vFile = new URL('../src/version.ts', import.meta.url);
const cFile = new URL('../CHANGELOG.md', import.meta.url);
const src = readFileSync(vFile, 'utf8');
const m = /VERSION = '(\d+\.\d{3})'/.exec(src);
if (!m) throw new Error('VERSION not found in src/version.ts');
const log = readFileSync(cFile, 'utf8');

if (process.argv.includes('--check')) {
  const ok = log.includes(`## ${m[1]} `);
  console.log(ok ? `CHANGELOG.md has ${m[1]}` : `CHANGELOG.md is missing a section for ${m[1]}`);
  process.exit(ok ? 0 : 1);
}

const next = (Math.round(Number(m[1]) * 1000) + 1) / 1000;
const ver = next.toFixed(3);
writeFileSync(vFile, src.replace(m[0], `VERSION = '${ver}'`));
const date = new Date().toISOString().slice(0, 10);
const i = log.indexOf('\n## ');
const head = `\n## ${ver} — ${date}\n\n`;
writeFileSync(cFile, i < 0 ? log + head : log.slice(0, i) + head + log.slice(i + 1));
console.log(ver);
