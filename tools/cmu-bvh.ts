/**
 * Appends motion-captured clips from the CMU Graphics Lab Motion Capture Database
 * (http://mocap.cs.cmu.edu; the cgspeed BVH conversion, mirrored at
 * https://github.com/Shriinivas/cmubvh) to public/assets/anim/clips.{json,bin}, retargeted onto
 * the library's body bones (tools/cmuBvh.ts). Existing clips are kept; clips of the same name
 * are replaced, so the tool can be re-run (also after tools/build-anim-clips.ts rebuilt the
 * library from the Quaternius source).
 *
 *   npx tsx tools/cmu-bvh.ts <dir with the BVH files>            all TAKES below
 *   npx tsx tools/cmu-bvh.ts <dir> Name=140_07@1.2-8.5[~0.8][h0.6][m]   extra / trial cuts
 *
 * BVH files: Sequence-XXX-YYY/<subject>/Data/<subject>_<trial>.zip in the cmubvh repository,
 * e.g. https://raw.githubusercontent.com/Shriinivas/cmubvh/main/Sequence-113-128/113/Data/113_21.zip
 * (CMU_Idle_1/2) and .../Sequence-076-080/77/Data/77_02.zip (CMU_Idle_3).
 *
 * Every take is cut to [from, to] seconds, smoothed lightly (CMU marker jitter), resampled to the
 * library's 30 fps and turned to face −Z (the mean heading of the hips). The hips keep their
 * captured sway (weight shifts) around the cut's mean position, with the horizontal drift taken
 * out; the height is measured from the standing ankles, so straight legs give the library's rest
 * height. Loops close with a cross-fade: the last `fade` seconds blend into the frames just
 * before the cut's start, so the last frame runs straight into the first. `m` mirrors the take
 * (left ↔ right), which makes a distinct variant from the same capture. Two clean-ups for a
 * calm, repeatable idle: the head's motion against the chest is centred and scaled down
 * (calmHead), and the upper body's mean forward tilt is set to a relaxed upright (straighten).
 *
 * Credit (public/assets/anim/LICENSE.txt): the data was obtained from mocap.cs.cmu.edu; the
 * database was created with funding from NSF EIA-0196217. BVH conversion by B. Hahne
 * (cgspeed.com). CMU places no restrictions on use; the conversion adds none.
 */
import * as THREE from 'three';
import { readFileSync, writeFileSync } from 'fs';
import { parseBvh, CmuRetarget, libSkeleton, mirrorFrame, type RetargetFrame } from './cmuBvh';

const OUT = 'public/assets/anim';

interface Take {
  name: string;
  file: string;
  from: number;
  to: number;
  fade: number;
  mirror?: boolean;
  /** Share of the captured head motion (against the chest) kept, its mean taken out (default 0.6). */
  head?: number;
}
/**
 * The standing idles (see docs/ARCHITECTURE.md, humanoid animation). Picked from the CMU "idle",
 * "wait" and "standing still" takes for calm weight shifts, relaxed hanging arms and no gestures
 * that would stand out when repeated.
 */
export const TAKES: Take[] = [
  { name: 'CMU_Idle_1', file: '113_21', from: 1, to: 10.8, fade: 0.8, head: 0.45 },
  { name: 'CMU_Idle_2', file: '113_21', from: 1, to: 10.8, fade: 0.8, head: 0.45, mirror: true },
  { name: 'CMU_Idle_3', file: '77_02', from: 1, to: 7.5, fade: 0.8 },
];

const dir = process.argv[2];
if (!dir) {
  console.error('usage: npx tsx tools/cmu-bvh.ts <bvh dir> [Name=subj_trial@from-to[~fade][hHeadShare][m] ...]');
  process.exit(1);
}
const takes = TAKES.slice();
for (const a of process.argv.slice(3)) {
  const m = /^(\w+)=(\w+)@([\d.]+)-([\d.]+)(?:~([\d.]+))?(?:h([\d.]+))?(m?)$/.exec(a);
  if (!m) throw new Error('bad take ' + a);
  const t: Take = { name: m[1], file: m[2], from: +m[3], to: +m[4], fade: m[5] ? +m[5] : 0.8, head: m[6] ? +m[6] : undefined, mirror: m[7] === 'm' };
  const i = takes.findIndex((k) => k.name === t.name);
  if (i >= 0) takes[i] = t; else takes.push(t);
}

const json = JSON.parse(readFileSync(`${OUT}/clips.json`, 'utf8'));
const binBuf = readFileSync(`${OUT}/clips.bin`);
const bin = new Int16Array(binBuf.buffer.slice(binBuf.byteOffset, binBuf.byteOffset + binBuf.byteLength));
const lib = libSkeleton(json);
const FPS: number = json.fps;
const PER: number = json.stride;
const B = lib.bones.length;
if (PER !== B * 4 + 3) throw new Error('unexpected clip stride');
const hipsRest = lib.restHead[0];
const ankleRest = (lib.restHead[lib.bones.indexOf('foot.L')].y + lib.restHead[lib.bones.indexOf('foot.R')].y) / 2;

/** Gaussian-weighted quaternion average over neighbouring source frames (σ in frames). */
function smoothQ(seq: THREE.Quaternion[], i: number, sigma: number): THREE.Quaternion {
  const r = Math.ceil(sigma * 2.5);
  const ref = seq[i];
  const acc = new THREE.Vector4(0, 0, 0, 0);
  for (let k = -r; k <= r; k++) {
    const q = seq[Math.min(seq.length - 1, Math.max(0, i + k))];
    const w = Math.exp(-(k * k) / (2 * sigma * sigma)) * (q.dot(ref) < 0 ? -1 : 1);
    acc.x += q.x * w; acc.y += q.y * w; acc.z += q.z * w; acc.w += q.w * w;
  }
  return new THREE.Quaternion(acc.x, acc.y, acc.z, acc.w).normalize();
}

/**
 * The captured heads look about a lot (the actors were watching the session) and some hold a
 * turn or tilt throughout; repeated in a loop, and under the game's own look-at, that reads as
 * a stiff neck or a twitch. Head motion against the chest is centred on its mean and scaled by
 * k; the neck takes half of it.
 */
function calmHead(frames: RetargetFrame[], k: number) {
  const C = lib.bones.indexOf('spine.003'), N = lib.bones.indexOf('neck'), H = lib.bones.indexOf('head');
  const inv = (b: number) => lib.rest[b].clone().invert();
  const local = frames.map((fr) => fr.q[C].clone().multiply(inv(C)).invert().multiply(fr.q[H].clone().multiply(inv(H))));
  const acc = new THREE.Vector4(0, 0, 0, 0);
  for (const q of local) {
    const s = q.dot(local[0]) < 0 ? -1 : 1;
    acc.x += q.x * s; acc.y += q.y * s; acc.z += q.z * s; acc.w += q.w * s;
  }
  const meanInv = new THREE.Quaternion(acc.x, acc.y, acc.z, acc.w).normalize().invert();
  const id = new THREE.Quaternion();
  frames.forEach((fr, f) => {
    const chest = fr.q[C].clone().multiply(inv(C));
    const l = id.clone().slerp(meanInv.clone().multiply(local[f]), k);
    fr.q[H] = chest.clone().multiply(l).multiply(lib.rest[H]).normalize();
    fr.q[N] = chest.clone().multiply(id.clone().slerp(l, 0.5)).multiply(lib.rest[N]).normalize();
  });
}

/**
 * Posture: actors lean back or hunch a little, and in a loop that becomes the character's
 * build. The chest's mean forward tilt is brought to POSTURE by turning the upper body (from the
 * mid spine up, collarbones included) about the lateral axis; the arms keep hanging as captured.
 */
const POSTURE = -0.04;
const UPPER = ['spine.002', 'spine.003', 'neck', 'head', 'shoulder.L', 'shoulder.R'];
function straighten(frames: RetargetFrame[]) {
  const C = lib.bones.indexOf('spine.003');
  const e = new THREE.Euler();
  let sum = 0;
  for (const fr of frames) sum += e.setFromQuaternion(fr.q[C].clone().multiply(lib.rest[C].clone().invert()), 'YXZ').x;
  const fix = POSTURE - sum / frames.length;
  const r = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), fix);
  for (const fr of frames) for (const n of UPPER) fr.q[lib.bones.indexOf(n)].premultiply(r);
  return fix;
}

function buildTake(t: Take): Int16Array {
  const bvh = parseBvh(readFileSync(`${dir}/${t.file}.bvh`, 'utf8'));
  const rt = new CmuRetarget(bvh, lib);
  const src = 1 / bvh.dt;
  const n = Math.round((t.to - t.from) * FPS);
  const nf = Math.round(t.fade * FPS);
  // Source frames needed: the fade lead-in before `from` through `to` (+ the smoothing margin).
  // Frame 0 of the CMU takes is the calibration T-pose: never used.
  const first = Math.round((t.from - t.fade) * src) - 8;
  const last = Math.round(t.to * src) + 8;
  if (first < 1 || last >= bvh.frames) throw new Error(`${t.name}: cut ${t.from}-${t.to} (fade ${t.fade}) is outside ${t.file} (${(bvh.frames * bvh.dt).toFixed(2)} s)`);
  const raw: RetargetFrame[] = [];
  for (let f = first; f <= last; f++) {
    const fr = rt.frame(f);
    raw.push(t.mirror ? mirrorFrame(lib, fr) : fr);
  }
  const perBone = Array.from({ length: B }, (_, b) => raw.map((r) => r.q[b]));
  const sample = (outF: number): RetargetFrame => {
    // Output frame outF (may be negative: the fade lead-in) → source frame index in raw.
    const sf = Math.round((t.from + outF / FPS) * src) - first;
    return { q: perBone.map((seq) => smoothQ(seq, sf, 2)), hips: raw[sf].hips.clone(), ankles: [raw[sf].ankles[0].clone(), raw[sf].ankles[1].clone()] };
  };
  const frames: RetargetFrame[] = [];
  for (let f = 0; f < n; f++) frames.push(sample(f));
  // Loop: the last nf frames cross-fade into the nf frames before the start.
  for (let k = 0; k < nf; k++) {
    const f = n - nf + k;
    const lead = sample(-nf + k);
    const u = (k + 1) / (nf + 1);
    const w = u * u * (3 - 2 * u);
    const a = frames[f];
    a.q.forEach((q, b) => {
      const c = lead.q[b];
      if (q.dot(c) < 0) c.set(-c.x, -c.y, -c.z, -c.w);
      q.slerp(c, w);
    });
    a.hips.lerp(lead.hips, w);
    a.ankles[0].lerp(lead.ankles[0], w);
    a.ankles[1].lerp(lead.ankles[1], w);
  }
  calmHead(frames, t.head ?? 0.6);
  // Facing: the mean heading of the hips turned to −Z.
  let sx = 0, sz = 0;
  const fwd = new THREE.Vector3();
  for (const fr of frames) {
    fwd.set(0, 0, -1).applyQuaternion(fr.q[0].clone().multiply(lib.rest[0].clone().invert()));
    const l = Math.hypot(fwd.x, fwd.z) || 1;
    sx += fwd.x / l; sz += fwd.z / l;
  }
  const yaw = Math.atan2(-sx, -sz);
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
  for (const fr of frames) {
    fr.q.forEach((q) => q.premultiply(turn));
    fr.hips.applyQuaternion(turn);
    fr.ankles.forEach((a) => a.applyQuaternion(turn));
  }
  straighten(frames);
  // Hips: sway around the cut's mean, height above the standing ankles.
  const mean = new THREE.Vector3();
  frames.forEach((fr) => mean.add(fr.hips));
  mean.divideScalar(n);
  const lows = frames.map((fr) => Math.min(fr.ankles[0].y, fr.ankles[1].y)).sort((a, b) => a - b);
  const ground = lows[Math.floor(lows.length / 2)];
  const data = new Int16Array(n * PER);
  let prev: THREE.Quaternion[] | null = null;
  let sway = 0;
  frames.forEach((fr, f) => {
    const o = f * PER;
    fr.q.forEach((q, b) => {
      if (prev && prev[b].dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      data[o + b * 4] = Math.round(q.x * 32767);
      data[o + b * 4 + 1] = Math.round(q.y * 32767);
      data[o + b * 4 + 2] = Math.round(q.z * 32767);
      data[o + b * 4 + 3] = Math.round(q.w * 32767);
    });
    prev = fr.q;
    const x = fr.hips.x - mean.x, z = fr.hips.z - mean.z;
    sway = Math.max(sway, Math.hypot(x, z));
    // Hips offset from the rest hips, in millimetres (as tools/build-anim-clips.ts stores it).
    data[o + B * 4] = Math.round(x * 1000);
    data[o + B * 4 + 1] = Math.round((fr.hips.y - ground + ankleRest - hipsRest.y) * 1000);
    data[o + B * 4 + 2] = Math.round(z * 1000);
  });
  const ys = frames.map((fr) => fr.hips.y - ground + ankleRest - hipsRest.y);
  console.log(`${t.name.padEnd(14)} ${t.file} ${t.from}-${t.to} s${t.mirror ? ' mirrored' : ''}: ${n} frames, facing ${((yaw * 180) / Math.PI).toFixed(0)}°, sway ≤ ${(sway * 100).toFixed(1)} cm, hips ${(Math.min(...ys) * 100).toFixed(1)}..${(Math.max(...ys) * 100).toFixed(1)} cm (scale ${rt.scale.toFixed(4)})`);
  return data;
}

// Rebuild the binary: kept clips first (in order), then the new ones.
interface ClipMeta { name: string; frames: number; loop: boolean; dur: number; offset: number; speed: number; sync: number }
const names = new Set(takes.map((t) => t.name));
const kept = (json.clips as ClipMeta[]).filter((c) => !names.has(c.name));
const chunks: Int16Array[] = [];
const clips: ClipMeta[] = [];
let offset = 0;
for (const c of kept) {
  chunks.push(bin.subarray(c.offset, c.offset + c.frames * PER));
  clips.push({ ...c, offset });
  offset += c.frames * PER;
}
for (const t of takes) {
  const d = buildTake(t);
  const frames = d.length / PER;
  chunks.push(d);
  clips.push({ name: t.name, frames, loop: true, dur: +(frames / FPS).toFixed(4), offset, speed: 0, sync: 0 });
  offset += d.length;
}
const all = new Int16Array(offset);
let o = 0;
for (const c of chunks) { all.set(c, o); o += c.length; }
json.clips = clips;
json.source = 'Quaternius Universal Animation Library (CC0) — https://github.com/J-Ponzo/gltf-universal-animation-library; ' +
  'CMU Graphics Lab Motion Capture Database (mocap.cs.cmu.edu, cgspeed BVH conversion) for the CMU_ clips';
writeFileSync(`${OUT}/clips.bin`, Buffer.from(all.buffer));
writeFileSync(`${OUT}/clips.json`, JSON.stringify(json, null, 1));
console.log(`${clips.length} clips, ${(all.byteLength / 1024).toFixed(0)} KB`);
