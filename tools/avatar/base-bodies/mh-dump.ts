/**
 * Dumps the MakeHuman base mesh at reference macro settings (gender 0 and 1,
 * everything else average) for conform.py. Usage:
 *   npx tsx tools/avatar/base-bodies/mh-dump.ts <outdir>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseHumanAssets } from '../../../src/humanoid/assets';
import { morphPositions, morphTriangles } from '../../../src/humanoid/bodyBuild';
import type { HumanManifest } from '../../../src/humanoid/assetFormat';
import type { ShapeParams } from '../../../src/humanoid/shape';

const out = process.argv[2] ?? '.';
const dir = 'public/assets/human/';
const manifest = JSON.parse(readFileSync(dir + 'manifest.json', 'utf8')) as HumanManifest;
const b = readFileSync(dir + manifest.file);
const as = parseHumanAssets(manifest, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const shape = (gender: number): ShapeParams => ({
  macro: { gender, age: 0.5, muscle: 0.5, weight: 0.5, height: 0.5, proportions: 0.5, african: 1 / 3, asian: 1 / 3, caucasian: 1 / 3, breastSize: 0.5, breastFirmness: 0.5 },
  targets: new Map(), bones: {}, headScale: 1, earTip: 0, earSideways: 0, scale: 1,
});
const w = (name: string, a: ArrayBufferView) => writeFileSync(`${out}/${name}`, new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
w('mh_female.f32', morphPositions(as, shape(0)));
w('mh_male.f32', morphPositions(as, shape(1)));
w('mh_tris.u32', morphTriangles(as));
w('mh_skinidx.u8', as.skinIdx);
w('mh_skinw.u8', as.skinW);
writeFileSync(`${out}/mh_meta.json`, JSON.stringify({
  realVerts: manifest.realVerts, morphVerts: manifest.morphVerts, groups: manifest.groups,
  bones: manifest.bones, submeshes: manifest.submeshes,
}));
