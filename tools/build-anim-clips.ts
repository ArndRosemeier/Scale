/**
 * Builds public/assets/anim/clips.{json,bin} from the Quaternius Universal Animation Library
 * (CC0, https://github.com/J-Ponzo/gltf-universal-animation-library, glTF "Godot Standard").
 *
 *   npx tsx tools/build-anim-clips.ts [path/to/AnimationLibrary_Godot_Standard.gltf]
 *
 * Every clip is sampled at FPS and stored as model-space (world) rotations of the body bones in
 * Norgo axes (+Y up, facing −Z, character's left = −X; the source faces +Z) plus the hips
 * position. Retargeting onto a MakeHuman skeleton happens at runtime (anim/clips.ts), because it
 * depends on each character's proportions. Loops also get their natural ground speed (from the
 * planted foot) and the phase of the left footfall, so gaits can be blended in step.
 *
 * (Copied from the Norgo project with the human pipeline.) The library also carries
 * motion-captured CMU clips (CMU_*: the standing idles), appended by tools/cmu-bvh.ts: this tool
 * rewrites the library from the Quaternius source alone, so run tools/cmu-bvh.ts after it.
 */
import * as THREE from 'three';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const SRC = process.argv[2] ?? 'C:/Projekte/City/assets/humans/animations/quaternius/AnimationLibrary_Godot_Standard.gltf';
const OUT = 'public/assets/anim';
const FPS = 30;

/** Source bones kept (fingers stay procedural). */
const BONES = [
  'DEF-hips', 'DEF-spine.001', 'DEF-spine.002', 'DEF-spine.003', 'DEF-neck', 'DEF-head',
  'DEF-shoulder.L', 'DEF-upper_arm.L', 'DEF-forearm.L', 'DEF-hand.L',
  'DEF-shoulder.R', 'DEF-upper_arm.R', 'DEF-forearm.R', 'DEF-hand.R',
  'DEF-thigh.L', 'DEF-shin.L', 'DEF-foot.L', 'DEF-toe.L',
  'DEF-thigh.R', 'DEF-shin.R', 'DEF-foot.R', 'DEF-toe.R',
];
/** Clips left out: firearms, vehicles, the T-pose and the root-motion duplicates. */
const SKIP = /^(Pistol_|Driving_|A_TPose|.*_RM$)/;

const g = JSON.parse(readFileSync(SRC, 'utf8'));
const bin = readFileSync(SRC.replace(/\.gltf$/, '.bin'));
const accessor = (i: number) => {
  const a = g.accessors[i], bv = g.bufferViews[a.bufferView];
  const n = ({ SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 } as Record<string, number>)[a.type];
  if (a.componentType !== 5126) throw new Error('only float accessors supported');
  return new Float32Array(bin.buffer.slice(bin.byteOffset + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0)), 0, a.count * n);
};
const N = g.nodes.length;
const parent: number[] = new Array(N).fill(-1);
g.nodes.forEach((n: { children?: number[] }, i: number) => (n.children ?? []).forEach((c) => (parent[c] = i)));
const nodeIdx = (name: string) => {
  const i = g.nodes.findIndex((n: { name: string }) => n.name === name);
  if (i < 0) throw new Error('missing node ' + name);
  return i;
};
const boneNodes = BONES.map(nodeIdx);

interface TRS { t: THREE.Vector3; r: THREE.Quaternion; s: THREE.Vector3 }
const restTRS = (): TRS[] => g.nodes.map((n: { translation?: number[]; rotation?: number[]; scale?: number[] }) => ({
  t: new THREE.Vector3(...((n.translation ?? [0, 0, 0]) as [number, number, number])),
  r: new THREE.Quaternion(...((n.rotation ?? [0, 0, 0, 1]) as [number, number, number, number])),
  s: new THREE.Vector3(...((n.scale ?? [1, 1, 1]) as [number, number, number])),
}));

/** Source (+Z facing) → Norgo (−Z facing): half turn about Y. */
const FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const FLIPM = new THREE.Matrix4().makeRotationFromQuaternion(FLIP);

function worlds(trs: TRS[]): THREE.Matrix4[] {
  const out: THREE.Matrix4[] = new Array(N);
  const get = (i: number): THREE.Matrix4 => {
    if (out[i]) return out[i];
    const m = new THREE.Matrix4().compose(trs[i].t, trs[i].r, trs[i].s);
    out[i] = parent[i] >= 0 ? get(parent[i]).clone().multiply(m) : FLIPM.clone().multiply(m);
    return out[i];
  };
  for (let i = 0; i < N; i++) get(i);
  return out;
}
const rotOf = (m: THREE.Matrix4) => {
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  return q;
};
const posOf = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixPosition(m);

// ---- rest (bind) pose: a T-pose
const rest = worlds(restTRS());
const restQ = boneNodes.map((i) => rotOf(rest[i]));
const restHead = boneNodes.map((i) => posOf(rest[i]));
const hipsRest = restHead[0];
/**
 * Rest segment end of each limb bone: the next joint (used to line the target's A-pose limbs
 * up with the source's T-pose). Torso bones need none (both skeletons stand upright).
 */
const TIP: Record<string, string> = {
  'DEF-shoulder': 'DEF-upper_arm', 'DEF-upper_arm': 'DEF-forearm', 'DEF-forearm': 'DEF-hand', 'DEF-hand': 'DEF-f_middle.01',
  'DEF-thigh': 'DEF-shin', 'DEF-shin': 'DEF-foot', 'DEF-foot': 'DEF-toe',
};
const restTip = BONES.map((b, k) => {
  const m = /^(.*)\.([LR])$/.exec(b);
  if (!m) return null;
  if (m[1] === 'DEF-toe') return restHead[k].clone().add(new THREE.Vector3(0, 0.06, 0).applyQuaternion(restQ[k]));
  const t = TIP[m[1]];
  return t ? posOf(rest[nodeIdx(`${t}.${m[2]}`)]) : null;
});
const footY = (posOf(rest[nodeIdx('DEF-foot.L')]).y + posOf(rest[nodeIdx('DEF-foot.R')]).y) / 2;
const legLen = posOf(rest[nodeIdx('DEF-thigh.L')]).y - footY + 0.05;

// ---- sampling
function sampleChannel(s: { input: number; output: number; interpolation: string }, path: string, t: number): number[] {
  const times = accessor(s.input), vals = accessor(s.output);
  const w = path === 'rotation' ? 4 : 3;
  const cubic = s.interpolation === 'CUBICSPLINE';
  const stride = cubic ? w * 3 : w;
  const at = (k: number) => Array.from(vals.subarray(k * stride + (cubic ? w : 0), k * stride + (cubic ? w : 0) + w));
  if (t <= times[0]) return at(0);
  const n = times.length;
  if (t >= times[n - 1]) return at(n - 1);
  let k = 0;
  while (k < n - 2 && times[k + 1] <= t) k++;
  if (s.interpolation === 'STEP') return at(k);
  const u = (t - times[k]) / (times[k + 1] - times[k]);
  const a = at(k), b = at(k + 1);
  if (path === 'rotation') {
    const q = new THREE.Quaternion(...(a as [number, number, number, number])).slerp(new THREE.Quaternion(...(b as [number, number, number, number])), u);
    return [q.x, q.y, q.z, q.w];
  }
  return a.map((v, i) => v + (b[i] - v) * u);
}

interface ClipOut { name: string; frames: number; loop: boolean; dur: number; offset: number; speed: number; sync: number }
const clips: ClipOut[] = [];
const chunks: Int16Array[] = [];
let offset = 0;
const PER = BONES.length * 4 + 3;

for (const anim of g.animations as { name: string; channels: { sampler: number; target: { node: number; path: string } }[]; samplers: { input: number; output: number; interpolation: string }[] }[]) {
  if (SKIP.test(anim.name)) continue;
  let dur = 0;
  for (const s of anim.samplers) {
    const t = accessor(s.input);
    dur = Math.max(dur, t[t.length - 1]);
  }
  const loop = /_Loop$/.test(anim.name);
  // Loops: the last key repeats the first, so it is not stored.
  const frames = Math.max(1, loop ? Math.round(dur * FPS) : Math.round(dur * FPS) + 1);
  const quats: THREE.Quaternion[][] = [];
  const hips: THREE.Vector3[] = [];
  const feet: THREE.Vector3[][] = [];
  for (let f = 0; f < frames; f++) {
    const t = Math.min(dur, f / FPS);
    const trs = restTRS();
    for (const c of anim.channels) {
      const v = sampleChannel(anim.samplers[c.sampler], c.target.path, t);
      const x = trs[c.target.node];
      if (c.target.path === 'rotation') x.r.set(v[0], v[1], v[2], v[3]);
      else if (c.target.path === 'translation') x.t.set(v[0], v[1], v[2]);
      else if (c.target.path === 'scale') x.s.set(v[0], v[1], v[2]);
    }
    const w = worlds(trs);
    quats.push(boneNodes.map((i) => rotOf(w[i])));
    hips.push(posOf(w[boneNodes[0]]));
    feet.push([posOf(w[nodeIdx('DEF-foot.L')]), posOf(w[nodeIdx('DEF-foot.R')])]);
  }
  // Loops play in place: remove any horizontal drift of the hips over the cycle.
  if (loop && frames > 1) {
    const end = hips[0].clone(); // the cycle closes on the first frame
    const drift = new THREE.Vector3(0, 0, 0);
    // Estimate drift as (position one frame past the end − first): sample t = dur.
    const trs = restTRS();
    for (const c of anim.channels) {
      const v = sampleChannel(anim.samplers[c.sampler], c.target.path, dur);
      const x = trs[c.target.node];
      if (c.target.path === 'rotation') x.r.set(v[0], v[1], v[2], v[3]);
      else if (c.target.path === 'translation') x.t.set(v[0], v[1], v[2]);
    }
    drift.copy(posOf(worlds(trs)[boneNodes[0]])).sub(end);
    drift.y = 0;
    hips.forEach((h, f) => h.addScaledVector(drift, -f / frames));
    feet.forEach((p, f) => p.forEach((v) => v.addScaledVector(drift, -f / frames)));
  }
  // Natural ground speed: the planted (lowest) foot slides back under the hips at walking speed.
  let speed = 0, sync = 0;
  if (loop && frames > 4) {
    const vs: number[] = [];
    let best = -Infinity;
    // A foot is planted while it is within 3 cm of its lowest point (runs have flight phases).
    const minY = [0, 1].map((k) => Math.min(...feet.map((p) => p[k].y)));
    for (let f = 0; f < frames; f++) {
      const n = (f + 1) % frames;
      for (let k = 0; k < 2; k++) {
        if (feet[f][k].y > minY[k] + 0.03 || feet[n][k].y > minY[k] + 0.03) continue;
        // Forward = −Z; the planted foot moves backward (+Z) relative to the hips.
        const dz = (feet[n][k].z - hips[n].z) - (feet[f][k].z - hips[f].z);
        vs.push(dz * FPS);
      }
      // Footfall of the left foot: where it reaches furthest forward relative to the hips.
      const fwd = -(feet[f][0].z - hips[f].z);
      if (fwd > best) { best = fwd; sync = f / frames; }
    }
    vs.sort((a, b) => a - b);
    speed = vs.length ? Math.max(0, vs[Math.floor(vs.length / 2)]) : 0;
  }
  const data = new Int16Array(frames * PER);
  for (let f = 0; f < frames; f++) {
    const o = f * PER;
    quats[f].forEach((q, b) => {
      // Keep a consistent hemisphere frame to frame (cleaner interpolation).
      if (f > 0 && quats[f - 1][b].dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      data[o + b * 4] = Math.round(q.x * 32767);
      data[o + b * 4 + 1] = Math.round(q.y * 32767);
      data[o + b * 4 + 2] = Math.round(q.z * 32767);
      data[o + b * 4 + 3] = Math.round(q.w * 32767);
    });
    const h = hips[f];
    // Hips offset from the rest (T-pose) hips, in millimetres.
    data[o + BONES.length * 4] = Math.round((h.x - hipsRest.x) * 1000);
    data[o + BONES.length * 4 + 1] = Math.round((h.y - hipsRest.y) * 1000);
    data[o + BONES.length * 4 + 2] = Math.round((h.z - hipsRest.z) * 1000);
  }
  clips.push({ name: anim.name, frames, loop, dur: +dur.toFixed(4), offset, speed: +speed.toFixed(3), sync: +sync.toFixed(3) });
  chunks.push(data);
  offset += data.length;
}

const all = new Int16Array(offset);
let o = 0;
for (const c of chunks) { all.set(c, o); o += c.length; }
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/clips.bin`, Buffer.from(all.buffer));
writeFileSync(`${OUT}/clips.json`, JSON.stringify({
  version: 1,
  source: 'Quaternius Universal Animation Library (CC0) — https://github.com/J-Ponzo/gltf-universal-animation-library',
  fps: FPS,
  bones: BONES.map((b) => b.replace(/^DEF-/, '')),
  rest: restQ.map((q) => [q.x, q.y, q.z, q.w].map((v) => +v.toFixed(6))),
  restHead: restHead.map((p) => [p.x, p.y, p.z].map((v) => +v.toFixed(5))),
  restTip: restTip.map((p) => (p ? [p.x, p.y, p.z].map((v) => +v.toFixed(5)) : null)),
  legLen: +legLen.toFixed(4),
  stride: PER,
  clips,
}, null, 1));
console.log(`${clips.length} clips, ${(all.byteLength / 1024).toFixed(0)} KB`);
for (const c of clips) if (c.loop) console.log(c.name.padEnd(24), c.frames, 'frames', c.speed, 'm/s', 'sync', c.sync);
