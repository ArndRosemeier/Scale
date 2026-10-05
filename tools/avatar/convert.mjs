#!/usr/bin/env node
/**
 * Convert a character (FBX, glTF/GLB, OBJ, DAE, .blend) into a GLB for the game,
 * using headless Blender.
 *
 *   npm run avatar -- <model> [anim files...] [--out file.glb]
 *
 * Default output: public/avatars/<model name>.glb (+ .json report).
 * Blender: $BLENDER_BIN, else AssetGenerator's pinned install
 * (../AssetGenerator/tools/.blender_path), else `blender` on PATH.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

function findBlender() {
  if (process.env.BLENDER_BIN && existsSync(process.env.BLENDER_BIN)) return process.env.BLENDER_BIN;
  const ag = resolve(root, '..', 'AssetGenerator', 'tools', '.blender_path');
  if (existsSync(ag)) {
    const p = readFileSync(ag, 'utf8').trim();
    if (existsSync(p)) return p;
  }
  return 'blender';
}

const argv = process.argv.slice(2);
let out = null;
const inputs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') out = argv[++i];
  else inputs.push(resolve(argv[i]));
}
if (!inputs.length) {
  console.error('usage: npm run avatar -- <model> [anim files...] [--out file.glb]');
  process.exit(2);
}
for (const f of inputs) if (!existsSync(f)) { console.error(`not found: ${f}`); process.exit(2); }
out = resolve(out ?? join(root, 'public', 'avatars', basename(inputs[0], extname(inputs[0])) + '.glb'));

const blender = findBlender();
console.log(`[avatar] blender: ${blender}`);
// Rigs can print thousands of harmless driver messages: allow a big log.
const r = spawnSync(blender, ['-b', '--factory-startup', '-P', join(here, 'convert_avatar.py'), '--', out, ...inputs], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
const log = (r.stdout ?? '') + (r.stderr ?? '');
for (const line of log.split(/\r?\n/)) if (line.includes('[avatar]') || /^Error:|Traceback/.test(line)) console.log(line);
if (r.status !== 0 || !existsSync(out)) {
  // Exit code 2: the converter refused the model (reason printed above), no file written.
  console.error(r.status === 2 ? '[avatar] not converted: the model would not work in the game' : `[avatar] conversion failed (exit ${r.status})`);
  if (!log.includes('[avatar]')) console.error(log.slice(-2000));
  process.exit(1);
}
console.log(`[avatar] wrote ${out}`);
