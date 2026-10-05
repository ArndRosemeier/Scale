#!/usr/bin/env node
/**
 * Package the Windows avatar converter for download from the start screen:
 * public/converter/ScaleAvatarConverter.zip (Convert.bat, convert.ps1, README.txt and the
 * shared tools/avatar/convert_avatar.py). Run: npm run build-converter
 */
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const stage = join(tmpdir(), 'ScaleAvatarConverter');
const out = join(root, 'public', 'converter', 'ScaleAvatarConverter.zip');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of ['Convert.bat', 'convert.ps1', 'README.txt']) cpSync(join(here, 'converter-package', f), join(stage, f));
cpSync(join(here, 'convert_avatar.py'), join(stage, 'convert_avatar.py'));
mkdirSync(dirname(out), { recursive: true });
rmSync(out, { force: true });
const r = process.platform === 'win32'
  ? spawnSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${stage}\*' -DestinationPath '${out}' -Force`], { stdio: 'inherit' })
  : spawnSync('python3', ['-c', 'import shutil, sys; shutil.make_archive(sys.argv[1][:-4], "zip", sys.argv[2], "ScaleAvatarConverter")', out, dirname(stage)], { stdio: 'inherit' });
if (r.status !== 0 || !existsSync(out)) { console.error('packaging failed'); process.exit(1); }
console.log(`wrote ${out}`);
