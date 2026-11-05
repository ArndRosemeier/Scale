#!/usr/bin/env node
/**
 * Fetches the Actors asset pack that matches the installed @actors/generator version into
 * public/packs (git-ignored; the build copies it into dist). Only the human pack is kept, and of
 * its CMU motion capture library (about 200 MB) only the index and the few takes in CMU_KEEP: Scale plays the pack's own
 * clips (src/humanoid/actors/clips.ts).
 *
 *   npm run packs            (also runs after npm install)
 *   npm run packs -- --force
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'node_modules/@actors/generator/bin/actors-packs.mjs');
if (!existsSync(bin)) {
  console.log('actors-packs: @actors/generator is not installed yet, skipped');
  process.exit(0);
}
const dest = join(root, 'public/packs');
/** CMU takes the game plays (the files of CMU_CLIPS in src/humanoid/actors/clips.ts; selftest checks they match). */
const CMU_KEEP = ['82_05.bin', '111_06.bin', '111_37.bin'];
const KEEP = new Set(['index.json', ...CMU_KEEP]);
const cmu = join(dest, 'human/clips/cmu');
const args = process.argv.slice(2);
// A pack trimmed before a take was added lacks its file: fetch the pack again.
if (existsSync(join(cmu, 'index.json')) && !args.includes('--force') && CMU_KEEP.some((f) => !existsSync(join(cmu, f)))) args.push('--force');
execFileSync(process.execPath, [bin, dest, ...args], { stdio: 'inherit' });
for (const d of readdirSync(dest, { withFileTypes: true })) if (d.isDirectory() && d.name !== 'human') rmSync(join(dest, d.name), { recursive: true, force: true });
if (existsSync(cmu)) for (const f of readdirSync(cmu)) if (!KEEP.has(f)) rmSync(join(cmu, f), { force: true });
