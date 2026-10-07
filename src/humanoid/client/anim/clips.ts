/**
 * Motion-captured-style animation clips (Quaternius Universal Animation Library, CC0; built by
 * tools/build-anim-clips.ts) and motion capture (CMU_* clips: CMU Graphics Lab Motion Capture
 * Database, appended by tools/cmu-bvh.ts) retargeted onto MakeHuman characters.
 *
 * The library stores model-space bone rotations of a 22-bone Rigify body in Norgo axes. Each
 * character bakes the clips it uses into the animator's own pose space (Euler angles relative
 * to its neutral, see pose.ts), so clips blend with the procedural layers like any other pose:
 *
 *   target world(t) = Δsrc(t) · A,  Δsrc(t) = src world(t) · src rest⁻¹,
 *
 * where A turns the target's rest limb segment (joint → next joint) onto the source's (the
 * source rests in a T-pose, MakeHuman in an A-pose); torso bones stand alike in both (A = 1). Spine and neck chains with more target
 * than source bones interpolate Δ; second segments of limbs share the twist of the first.
 */
import * as THREE from 'three';
import { humanAssetUrl } from '../../assets';
import type { Character } from '../Character';
import type { BoneMap } from './pose';
import { Pose, wrapPi } from './pose';

interface ClipMeta { name: string; frames: number; loop: boolean; dur: number; offset: number; speed: number; sync: number }
interface LibraryJson {
  version: number;
  fps: number;
  bones: string[];
  rest: number[][];
  restHead: number[][];
  restTip: (number[] | null)[];
  legLen: number;
  stride: number;
  clips: ClipMeta[];
}

export interface ClipLibrary {
  fps: number;
  bones: string[];
  restQ: THREE.Quaternion[];
  /** Rest limb segments (joint → next joint), null for torso bones. */
  restSeg: (THREE.Vector3 | null)[];
  legLen: number;
  stride: number;
  clips: Map<string, ClipMeta>;
  data: Int16Array;
}

/**
 * Clips on/off (for comparing with the purely procedural animation): `?clips=0` in the URL or
 * `norgoAnimClips(false)` in the console.
 */
export const clipSettings = { enabled: !/[?&]clips=0(&|$)/.test((globalThis as { location?: { search?: string } }).location?.search ?? '') };
(globalThis as { norgoAnimClips?: (on: boolean) => void }).norgoAnimClips = (on: boolean) => { clipSettings.enabled = on; };

let lib: ClipLibrary | null = null;
let loading: Promise<ClipLibrary | null> | null = null;

/** The clip library once loaded (null before, or when it failed to load: animators stay procedural). */
export function clipLibrary(): ClipLibrary | null {
  if (!lib && !loading) loading = loadLibrary();
  return lib;
}

/** Resolves once the library has loaded (or failed: null). */
export function clipLibraryReady(): Promise<ClipLibrary | null> {
  clipLibrary();
  return loading ?? Promise.resolve(lib);
}

async function loadLibrary(): Promise<ClipLibrary | null> {
  try {
    const url = (f: string) => humanAssetUrl(`../anim/${f}`);
    const j = (await (await fetch(url('clips.json'))).json()) as LibraryJson;
    const buf = await (await fetch(url('clips.bin'))).arrayBuffer();
    lib = {
      fps: j.fps,
      bones: j.bones,
      restQ: j.rest.map((q) => new THREE.Quaternion(q[0], q[1], q[2], q[3])),
      restSeg: j.restTip.map((t, i) => (t ? new THREE.Vector3(t[0] - j.restHead[i][0], t[1] - j.restHead[i][1], t[2] - j.restHead[i][2]).normalize() : null)),
      legLen: j.legLen,
      stride: j.stride,
      clips: new Map(j.clips.map((c) => [c.name, c])),
      data: new Int16Array(buf),
    };
    return lib;
  } catch (e) {
    console.warn('[anim] clip library unavailable, procedural only', e);
    return null;
  }
}

/** Target bone ← source bone(s): [a, b, t] = slerp(Δa, Δb, t); 'follow' = rigid with its parent. */
type Src = [string, string?, number?] | 'follow';
const MAP: Record<string, Src> = {
  root: ['hips'],
  spine05: ['spine.001'], spine04: ['spine.001', 'spine.002', 0.5], spine03: ['spine.002'],
  spine02: ['spine.002', 'spine.003', 0.5], spine01: ['spine.003'],
  neck01: ['neck'], neck02: ['neck', 'head', 0.3], neck03: ['neck', 'head', 0.6], head: ['head'],
};
for (const s of ['L', 'R']) {
  Object.assign(MAP, {
    [`clavicle.${s}`]: [`shoulder.${s}`],
    [`shoulder01.${s}`]: [`shoulder.${s}`, `upper_arm.${s}`, 0.5],
    [`upperarm01.${s}`]: [`upper_arm.${s}`],
    [`upperarm02.${s}`]: 'follow',
    [`lowerarm01.${s}`]: [`forearm.${s}`],
    [`lowerarm02.${s}`]: 'follow',
    [`wrist.${s}`]: [`hand.${s}`],
    [`pelvis.${s}`]: 'follow',
    [`upperleg01.${s}`]: [`thigh.${s}`],
    [`upperleg02.${s}`]: 'follow',
    [`lowerleg01.${s}`]: [`shin.${s}`],
    [`lowerleg02.${s}`]: 'follow',
    [`foot.${s}`]: [`foot.${s}`],
    [`toes.${s}`]: [`toe.${s}`],
  });
}
/** Target limb bone → the joint ending its segment (head of that bone; toes: own tail). */
const SEG_END: Record<string, string> = {
  clavicle: 'upperarm01', shoulder01: 'lowerarm01', upperarm01: 'lowerarm01', lowerarm01: 'wrist', wrist: 'finger3-1',
  upperleg01: 'lowerleg01', lowerleg01: 'foot', foot: 'toes', toes: '',
};

/** Limb twist shared between the two segments: [first, second]. */
const TWIST_PAIRS = ['upperarm', 'lowerarm', 'upperleg', 'lowerleg'].flatMap((b) => ['L', 'R'].map((s) => [`${b}01.${s}`, `${b}02.${s}`]));

export interface BakedClip {
  meta: ClipMeta;
  frames: number;
  /** frames × bones × 3 Euler angles (pose space); only `bones` are meaningful. */
  rot: Float32Array;
  /** frames × 3 root offset (m). */
  root: Float32Array;
  /** Natural ground speed and cycle length for this character (m/s, m). */
  speed: number;
  cycle: number;
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();

/** Per-character retargeting of the clip library into one animator's pose space. */
export class ClipRig {
  /** Target bones driven by clips (pose indices). */
  readonly bones: number[] = [];
  /** Per pose bone: 1 when clips drive it. */
  readonly driven: Float32Array;
  private srcA: number[] = [];
  private srcB: number[] = [];
  private srcT: number[] = [];
  private align: THREE.Quaternion[] = [];
  private parentOf: number[] = [];
  private twist = new Map<number, { second: number; axis: THREE.Vector3 }>();
  private baked = new Map<string, BakedClip>();
  private scale: number;
  /** Collarbones: extra lowering about the parent's forward axis (see the constructor). */
  private depress: (THREE.Quaternion | null)[] = [];
  /** shoulder01 gets its collarbone's correction too, so the shoulder joint moves as one. */
  private corrFrom: number[] = [];

  constructor(
    private ch: Character,
    private map: BoneMap,
    private lib: ClipLibrary,
    private neutral: (THREE.Quaternion | null)[],
    private parentNeutral: (THREE.Quaternion | null)[],
    legLen: number,
  ) {
    this.driven = new Float32Array(map.count);
    this.scale = legLen / lib.legLen;
    const body = ch.geo.build.body;
    const srcIdx = (n: string) => {
      const i = lib.bones.indexOf(n);
      if (i < 0) throw new Error('clip bone missing: ' + n);
      return i;
    };
    // Bones in hierarchy order (parents first: manifest order is topological).
    for (let b = 0; b < map.count; b++) {
      const name = ch.bones[b].name;
      const src = MAP[name];
      if (!src) continue;
      this.bones.push(b);
      this.driven[b] = 1;
      this.parentOf[b] = ch.bones.indexOf(ch.bones[b].parent as THREE.Bone);
      const sm = /^shoulder01\.([LR])$/.exec(name);
      this.corrFrom[b] = sm ? map.idx(`clavicle.${sm[1]}`) : -1;
      if (src === 'follow') {
        this.srcA[b] = -1;
        continue;
      }
      const a = srcIdx(src[0]), c = src[1] ? srcIdx(src[1]) : a;
      this.srcA[b] = a;
      this.srcB[b] = c;
      this.srcT[b] = src[2] ?? 0;
      // Limbs: line the rest segments up. Torso: identity.
      const m = /^(.*)\.([LR])$/.exec(name);
      const end = m ? SEG_END[m[1]] : undefined;
      const ds = lib.restSeg[a];
      if (end === undefined || !ds) {
        this.align[b] = new THREE.Quaternion();
        continue;
      }
      const head = ch.rest[b];
      const tip = end ? ch.rest[map.idx(`${end}.${m![2]}`)] : new THREE.Vector3(body.tails[b * 3], body.tails[b * 3 + 1], body.tails[b * 3 + 2]);
      const dt = tip.clone().sub(head).normalize();
      this.align[b] = new THREE.Quaternion().setFromUnitVectors(dt, ds);
      // Collarbones: the source's shoulder bone points up, out and back more steeply than
      // MakeHuman's collarbone, so lining the segments up shrugged the shoulders and pulled them
      // behind the chest in every clip. Bring them forward and down (shoulder01 rides along, see
      // corrFrom); the arms keep the clip's world rotation.
      if (m![1] === 'clavicle') {
        const sg = m![2] === 'L' ? -1 : 1;
        this.depress[b] = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), sg * 0.9)
          .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -sg * 0.5));
      }
    }
    for (const [first, second] of TWIST_PAIRS) {
      const f = map.idx(first), s = map.idx(second);
      if (f < 0 || s < 0) continue;
      const side = first.slice(-1);
      const end = map.idx(`${SEG_END[first.slice(0, -2)]}.${side}`);
      const axis = ch.rest[end].clone().sub(ch.rest[f]).normalize();
      this.twist.set(f, { second: s, axis });
    }
  }

  /** The clip baked for this character (lazily; null if the library lacks it). */
  clip(name: string): BakedClip | null {
    const hit = this.baked.get(name);
    if (hit) return hit;
    const meta = this.lib.clips.get(name);
    if (!meta) return null;
    const b = this.bake(meta);
    this.baked.set(name, b);
    return b;
  }

  private bake(meta: ClipMeta): BakedClip {
    const { lib, map } = this;
    const B = map.count, F = meta.frames, S = lib.bones.length;
    const rot = new Float32Array(F * B * 3);
    const root = new Float32Array(F * 3);
    const delta = Array.from({ length: S }, () => new THREE.Quaternion());
    const world: THREE.Quaternion[] = Array.from({ length: B }, () => new THREE.Quaternion());
    const local: THREE.Quaternion[] = Array.from({ length: B }, () => new THREE.Quaternion());
    const corr: THREE.Quaternion[] = Array.from({ length: B }, () => new THREE.Quaternion());
    const d = lib.data;
    for (let f = 0; f < F; f++) {
      const o = meta.offset + f * lib.stride;
      for (let s = 0; s < S; s++) {
        _q.set(d[o + s * 4] / 32767, d[o + s * 4 + 1] / 32767, d[o + s * 4 + 2] / 32767, d[o + s * 4 + 3] / 32767).normalize();
        delta[s].copy(_q).multiply(_q2.copy(lib.restQ[s]).invert());
      }
      for (const b of this.bones) {
        const p = this.parentOf[b];
        const pw = p >= 0 ? world[p] : _q3.identity();
        if (this.srcA[b] < 0) {
          world[b].copy(pw);
          local[b].identity();
          continue;
        }
        const a = this.srcA[b], c = this.srcB[b], t = this.srcT[b];
        const w = world[b].copy(delta[a]);
        if (c !== a && t > 0) w.slerp(delta[c], t);
        w.multiply(this.align[b]);
        const dep = this.depress[b];
        if (dep) w.premultiply(corr[b].copy(pw).multiply(dep).multiply(_q.copy(pw).invert()));
        const cb = this.corrFrom[b];
        if (cb >= 0) w.premultiply(corr[cb]);
        local[b].copy(pw).invert().multiply(w);
      }
      // Limb twist: split the first segment's twist about its axis with the second segment.
      for (const [first, { second, axis }] of this.twist) {
        const q = local[first];
        // Swing-twist decomposition: twist = projection of q onto the axis.
        const dot = q.x * axis.x + q.y * axis.y + q.z * axis.z;
        _q.set(axis.x * dot, axis.y * dot, axis.z * dot, q.w);
        if (_q.lengthSq() < 1e-10) continue;
        _q.normalize();
        const half = _q2.identity().slerp(_q, 0.5);
        // first = swing · twist½ and second = twist½ · second: the second segment's world rotation
        // (and everything below it) is unchanged, only the twist is shared out.
        q.multiply(_q3.copy(half).invert());
        local[second].premultiply(half);
      }
      // Into pose space: E = pn · q · n⁻¹ · pn⁻¹ (inverse of Animator.apply).
      for (const b of this.bones) {
        _q.copy(local[b]);
        const n = this.neutral[b];
        if (n) _q.multiply(_q2.copy(n).invert());
        const pn = this.parentNeutral[b];
        if (pn) _q.premultiply(pn).multiply(_q2.copy(pn).invert());
        const ord = map.order[b];
        _e.setFromQuaternion(_q, ord);
        const i = (f * B + b) * 3;
        rot[i] = _e.x; rot[i + 1] = _e.y; rot[i + 2] = _e.z;
        // Principal Euler solution (|middle| ≤ π/2): what procedural poses use, so clips blend
        // with them the short way. Near gimbal lock (rolls) frames may switch branch; see
        // accumulate().
      }
      const hi = o + S * 4;
      root[f * 3] = (d[hi] / 1000) * this.scale;
      root[f * 3 + 1] = (d[hi + 1] / 1000) * this.scale;
      root[f * 3 + 2] = (d[hi + 2] / 1000) * this.scale;
    }
    const speed = meta.speed * this.scale;
    return { meta, frames: F, rot, root, speed, cycle: speed * meta.dur };
  }

  /**
   * Sample a clip at normalized time u (0..1; loops wrap) into `out` for the driven bones,
   * accumulating with weight w (out = Σ w·clip; caller normalizes).
   */
  accumulate(c: BakedClip, u: number, w: number, out: Pose) {
    if (w <= 0) return;
    const F = c.frames, B = this.map.count;
    let x: number;
    if (c.meta.loop) x = (((u % 1) + 1) % 1) * F;
    else x = Math.min(1, Math.max(0, u)) * (F - 1);
    const f0 = Math.floor(x), k = x - f0;
    const f1 = c.meta.loop ? (f0 + 1) % F : Math.min(F - 1, f0 + 1);
    const r = out.rot, s = c.rot;
    for (const b of this.bones) {
      const i0 = (f0 * B + b) * 3, i1 = (f1 * B + b) * 3, j = b * 3;
      const d0 = wrapPi(s[i1] - s[i0]), d1 = wrapPi(s[i1 + 1] - s[i0 + 1]), d2 = wrapPi(s[i1 + 2] - s[i0 + 2]);
      if (Math.abs(d0) + Math.abs(d1) + Math.abs(d2) > 1.2) {
        // The two frames sit on different Euler branches (a full turn through gimbal lock):
        // interpolating would pass through unrelated orientations, so take the nearer frame.
        const n = k < 0.5 ? i0 : i1;
        r[j] += s[n] * w; r[j + 1] += s[n + 1] * w; r[j + 2] += s[n + 2] * w;
        continue;
      }
      r[j] += (s[i0] + d0 * k) * w;
      r[j + 1] += (s[i0 + 1] + d1 * k) * w;
      r[j + 2] += (s[i0 + 2] + d2 * k) * w;
    }
    _v.set(c.root[f0 * 3], c.root[f0 * 3 + 1], c.root[f0 * 3 + 2]).lerp(new THREE.Vector3(c.root[f1 * 3], c.root[f1 * 3 + 1], c.root[f1 * 3 + 2]), k);
    out.root.addScaledVector(_v, w);
  }
}
