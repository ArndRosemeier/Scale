#!/usr/bin/env node
/**
 * Fetches the Actors asset pack that matches the installed @actors/generator version into
 * public/packs (git-ignored; the build copies it into dist). Only the human pack is kept, and of
 * its CMU motion capture library (about 200 MB) only the index: Scale plays the pack's own
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
execFileSync(process.execPath, [bin, dest, ...process.argv.slice(2)], { stdio: 'inherit' });
for (const d of readdirSync(dest, { withFileTypes: true })) if (d.isDirectory() && d.name !== 'human') rmSync(join(dest, d.name), { recursive: true, force: true });
const KEEP = new Set(['index.json']);
const cmu = join(dest, 'human/clips/cmu');
if (existsSync(cmu)) for (const f of readdirSync(cmu)) if (!KEEP.has(f)) rmSync(join(cmu, f), { force: true });
