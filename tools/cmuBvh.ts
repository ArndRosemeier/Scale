/**
 * BVH parsing and retargeting of CMU motion capture (the cgspeed BVH conversion of the CMU
 * Graphics Lab Motion Capture Database) onto the body bones of the clip library
 * (public/assets/anim/clips.json: a Rigify T-pose skeleton in Norgo axes, see
 * tools/build-anim-clips.ts). Used by tools/cmu-bvh.ts and the self test.
 *
 * The library stores model-space bone rotations Q and the hips offset; the runtime
 * (src/humanoid/client/anim/clips.ts) retargets those onto each MakeHuman body through
 * Δ = Q · rest⁻¹. So here the job is to find, per frame, the library Δ that reproduces the
 * captured pose. Three kinds of bones:
 *
 *   torso, collarbones (rest-relative): Δ = W_cmu. Both skeletons stand upright with relaxed
 *     collarbones in their rest poses, so the rotation away from rest carries over as is.
 *   long limb bones (segment-aligned): Δ = W_cmu · A, A turning the library's rest segment
 *     (joint → next joint) onto the CMU rest segment. The CMU rest pose stands with the legs
 *     spread ~20° (its ASF bone directions); the library's legs hang straight. Matching the
 *     segments makes the posed limbs point where the captured ones do.
 *   feet, toes (parent-relative): Δ = Δ_parent · W_cmu,parent⁻¹ · W_cmu. They keep the
 *     captured joint angle against their parent: the two skeletons' foot segments (ankle → ball)
 *     sit at different angles (the CMU foot is a flatter line), and matching them would lift the toes.
 *   hands (follow): Δ = Δ_forearm; the captured wrists are mostly noise.
 *
 * W_cmu is a joint's world rotation relative to its BVH rest (BVH rests have zero rotations, so it
 * is the plain world rotation), turned into Norgo axes (the CMU actor faces +Z with the left side
 * on +X; Norgo faces −Z with the left side on −X: a half turn about Y).
 */
import * as THREE from 'three';

export interface BvhJoint {
  name: string;
  parent: number;
  /** Offset from the parent joint (BVH units, CMU axes). */
  offset: THREE.Vector3;
  channels: string[];
  /** Index of the joint's first channel in a frame row. */
  ch: number;
  /** End site offset (leaf joints), else null. */
  end: THREE.Vector3 | null;
}

export interface Bvh {
  joints: BvhJoint[];
  frames: number;
  /** Seconds per frame. */
  dt: number;
  /** Channels per frame. */
  nch: number;
  data: Float32Array;
}

export function parseBvh(text: string): Bvh {
  const tok = text.split(/\s+/).filter((s) => s.length > 0);
  let i = 0;
  const next = () => tok[i++];
  const joints: BvhJoint[] = [];
  let nch = 0;
  const stack: number[] = [];
  if (next() !== 'HIERARCHY') throw new Error('not a BVH file');
  let pendingEnd = false;
  for (;;) {
    const t = next();
    if (t === undefined) throw new Error('BVH: unexpected end of hierarchy');
    if (t === 'MOTION') break;
    if (t === 'ROOT' || t === 'JOINT') {
      const name = next();
      joints.push({ name, parent: stack.length ? stack[stack.length - 1] : -1, offset: new THREE.Vector3(), channels: [], ch: nch, end: null });
      stack.push(joints.length - 1);
    } else if (t === 'End') {
      next(); // "Site"
      pendingEnd = true;
    } else if (t === '{') {
      // opened by ROOT / JOINT / End Site (already pushed or flagged)
    } else if (t === '}') {
      if (pendingEnd) pendingEnd = false;
      else stack.pop();
    } else if (t === 'OFFSET') {
      const v = new THREE.Vector3(+next(), +next(), +next());
      const j = joints[stack[stack.length - 1]];
      if (pendingEnd) j.end = v;
      else j.offset.copy(v);
    } else if (t === 'CHANNELS') {
      const n = +next();
      const j = joints[stack[stack.length - 1]];
      j.ch = nch;
      for (let k = 0; k < n; k++) j.channels.push(next());
      nch += n;
    } else throw new Error('BVH: unexpected token ' + t);
  }
  if (next() !== 'Frames:') throw new Error('BVH: Frames missing');
  const frames = +next();
  if (next() !== 'Frame' || next() !== 'Time:') throw new Error('BVH: Frame Time missing');
  const dt = +next();
  const data = new Float32Array(frames * nch);
  for (let k = 0; k < frames * nch; k++) {
    const v = tok[i++];
    if (v === undefined) throw new Error(`BVH: motion data ends early (${k} of ${frames * nch} values)`);
    data[k] = +v;
  }
  return { joints, frames, dt, nch, data };
}

const AX = { X: new THREE.Vector3(1, 0, 0), Y: new THREE.Vector3(0, 1, 0), Z: new THREE.Vector3(0, 0, 1) } as const;
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();

/** CMU axes → Norgo axes: a half turn about Y. */
export const flipV = (v: THREE.Vector3) => v.set(-v.x, v.y, -v.z);
export const flipQ = (q: THREE.Quaternion) => q.set(-q.x, q.y, -q.z, q.w);

/**
 * Forward kinematics of frame f (fractional frames interpolate): world rotations and joint
 * positions in Norgo axes, BVH units.
 */
export function bvhPose(b: Bvh, f: number, rot: THREE.Quaternion[], pos: THREE.Vector3[]) {
  const f0 = Math.max(0, Math.min(b.frames - 1, Math.floor(f))), f1 = Math.min(b.frames - 1, f0 + 1), k = f - f0;
  const local = new THREE.Quaternion(), lp = new THREE.Vector3();
  b.joints.forEach((j, ji) => {
    const sample = (fr: number) => {
      const row = fr * b.nch + j.ch;
      const q = new THREE.Quaternion();
      const p = j.offset.clone();
      j.channels.forEach((c, ci) => {
        const v = b.data[row + ci];
        if (c.endsWith('rotation')) q.multiply(_qa.setFromAxisAngle(AX[c[0] as 'X' | 'Y' | 'Z'], (v * Math.PI) / 180));
        else if (c === 'Xposition') p.x = j.offset.x + v;
        else if (c === 'Yposition') p.y = j.offset.y + v;
        else if (c === 'Zposition') p.z = j.offset.z + v;
      });
      return { q, p };
    };
    const a = sample(f0);
    if (k > 0 && f1 !== f0) {
      const c = sample(f1);
      if (a.q.dot(c.q) < 0) c.q.set(-c.q.x, -c.q.y, -c.q.z, -c.q.w);
      a.q.slerp(c.q, k);
      a.p.lerp(c.p, k);
    }
    local.copy(a.q);
    lp.copy(a.p);
    if (j.parent < 0) {
      rot[ji] = flipQ(local.clone());
      pos[ji] = flipV(lp.clone());
    } else {
      rot[ji] = rot[j.parent].clone().multiply(flipQ(local.clone()));
      pos[ji] = pos[j.parent].clone().add(flipV(lp.clone()).applyQuaternion(rot[j.parent]));
    }
  });
}

/** The clip library's skeleton (from clips.json). */
export interface LibSkeleton {
  bones: string[];
  rest: THREE.Quaternion[];
  restHead: THREE.Vector3[];
  restTip: (THREE.Vector3 | null)[];
}

export function libSkeleton(j: { bones: string[]; rest: number[][]; restHead: number[][]; restTip: (number[] | null)[] }): LibSkeleton {
  return {
    bones: j.bones,
    rest: j.rest.map((q) => new THREE.Quaternion(q[0], q[1], q[2], q[3]).normalize()),
    restHead: j.restHead.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
    restTip: j.restTip.map((p) => (p ? new THREE.Vector3(p[0], p[1], p[2]) : null)),
  };
}

type Mode = 'rest' | 'segment' | 'parent' | 'follow';
/** Library bone ← CMU joint(s) [a, b, t: slerp], how it is retargeted, and the segment end joint. */
interface MapEntry { src: [string, string?, number?]; mode: Mode; segEnd?: string }
export const CMU_MAP: Record<string, MapEntry> = {
  hips: { src: ['Hips'], mode: 'rest' },
  'spine.001': { src: ['LowerBack'], mode: 'rest' },
  'spine.002': { src: ['Spine'], mode: 'rest' },
  'spine.003': { src: ['Spine1'], mode: 'rest' },
  neck: { src: ['Neck', 'Neck1', 0.5], mode: 'rest' },
  head: { src: ['Head'], mode: 'rest' },
};
for (const [s, S] of [['L', 'Left'], ['R', 'Right']] as const) {
  Object.assign(CMU_MAP, {
    [`shoulder.${s}`]: { src: [`${S}Shoulder`], mode: 'rest' },
    [`upper_arm.${s}`]: { src: [`${S}Arm`], mode: 'segment', segEnd: `${S}ForeArm` },
    [`forearm.${s}`]: { src: [`${S}ForeArm`], mode: 'segment', segEnd: `${S}Hand` },
    // The CMU hands carry little and noisy data (a marker or two): they follow the forearm, and the
    // animator gives them their relaxed wrist and finger curl.
    [`hand.${s}`]: { src: [`${S}Hand`], mode: 'follow' },
    [`thigh.${s}`]: { src: [`${S}UpLeg`], mode: 'segment', segEnd: `${S}Leg` },
    [`shin.${s}`]: { src: [`${S}Leg`], mode: 'segment', segEnd: `${S}Foot` },
    [`foot.${s}`]: { src: [`${S}Foot`], mode: 'parent' },
    [`toe.${s}`]: { src: [`${S}ToeBase`], mode: 'parent' },
  } satisfies Record<string, MapEntry>);
}
/** Parent of each library bone (for the parent-relative bones). */
const LIB_PARENT: Record<string, string> = {};
for (const s of ['L', 'R']) Object.assign(LIB_PARENT, { [`hand.${s}`]: `forearm.${s}`, [`foot.${s}`]: `shin.${s}`, [`toe.${s}`]: `foot.${s}` });

export interface RetargetFrame {
  /** Library model-space rotations (Δ · rest), per library bone. */
  q: THREE.Quaternion[];
  /** Library hips (head of the hips bone) position, library units, before grounding. */
  hips: THREE.Vector3;
  /** Ankles (L, R), library units, before grounding. */
  ankles: [THREE.Vector3, THREE.Vector3];
}

/** Retargets frames of one CMU BVH onto the library skeleton. */
export class CmuRetarget {
  /** BVH units → library metres (matched on the hip joint → ankle leg length). */
  readonly scale: number;
  private jIdx = new Map<string, number>();
  private align: THREE.Quaternion[] = [];
  private srcA: number[] = [];
  private srcB: number[] = [];
  private srcT: number[] = [];
  private mode: Mode[] = [];
  private parentLib: number[] = [];
  /** Library hips head relative to the midpoint of the hip joints (rest). */
  private hipsFromJoints: THREE.Vector3;
  private rot: THREE.Quaternion[] = [];
  private pos: THREE.Vector3[] = [];

  constructor(readonly bvh: Bvh, readonly lib: LibSkeleton) {
    bvh.joints.forEach((j, i) => this.jIdx.set(j.name, i));
    const J = (n: string) => {
      const i = this.jIdx.get(n);
      if (i === undefined) throw new Error('BVH joint missing: ' + n);
      return i;
    };
    // Rest joint positions of the BVH (Norgo axes).
    const restPos: THREE.Vector3[] = [];
    bvh.joints.forEach((j, i) => { restPos[i] = flipV(j.offset.clone()).add(j.parent >= 0 ? restPos[j.parent] : new THREE.Vector3()); });
    const legC = (s: string) => restPos[J(`${s}Foot`)].distanceTo(restPos[J(`${s}Leg`)]) + restPos[J(`${s}Leg`)].distanceTo(restPos[J(`${s}UpLeg`)]);
    const li = (n: string) => lib.bones.indexOf(n);
    const legL = (s: string) => lib.restHead[li(`foot.${s}`)].distanceTo(lib.restHead[li(`shin.${s}`)]) + lib.restHead[li(`shin.${s}`)].distanceTo(lib.restHead[li(`thigh.${s}`)]);
    this.scale = (legL('L') + legL('R')) / (legC('Left') + legC('Right'));
    lib.bones.forEach((name, b) => {
      const m = CMU_MAP[name];
      if (!m) throw new Error('no CMU mapping for library bone ' + name);
      this.srcA[b] = J(m.src[0]);
      this.srcB[b] = m.src[1] ? J(m.src[1]) : this.srcA[b];
      this.srcT[b] = m.src[2] ?? 0;
      this.mode[b] = m.mode;
      this.parentLib[b] = LIB_PARENT[name] ? li(LIB_PARENT[name]) : -1;
      this.align[b] = new THREE.Quaternion();
      if (m.mode === 'segment') {
        const tip = lib.restTip[b];
        if (!tip) throw new Error('library bone without a rest segment: ' + name);
        const ds = tip.clone().sub(lib.restHead[b]).normalize();
        const dc = restPos[J(m.segEnd!)].clone().sub(restPos[this.srcA[b]]).normalize();
        this.align[b].setFromUnitVectors(ds, dc);
      }
    });
    const mid = lib.restHead[li('thigh.L')].clone().add(lib.restHead[li('thigh.R')]).multiplyScalar(0.5);
    this.hipsFromJoints = lib.restHead[li('hips')].clone().sub(mid);
  }

  /** Retargeted pose at BVH frame f (fractional: interpolated). */
  frame(f: number): RetargetFrame {
    const { bvh, lib } = this;
    bvhPose(bvh, f, this.rot, this.pos);
    const W = this.rot;
    const B = lib.bones.length;
    const delta: THREE.Quaternion[] = new Array(B);
    for (let b = 0; b < B; b++) {
      const a = this.srcA[b];
      let d: THREE.Quaternion;
      if (this.mode[b] === 'follow') {
        d = delta[this.parentLib[b]].clone();
      } else if (this.mode[b] === 'parent') {
        const p = this.parentLib[b];
        const pa = this.srcA[p];
        d = delta[p].clone().multiply(_qb.copy(W[pa]).invert()).multiply(W[a]);
      } else {
        d = W[a].clone();
        if (this.srcB[b] !== a && this.srcT[b] > 0) {
          const c = W[this.srcB[b]].clone();
          if (d.dot(c) < 0) c.set(-c.x, -c.y, -c.z, -c.w);
          d.slerp(c, this.srcT[b]);
        }
        d.multiply(this.align[b]);
      }
      delta[b] = d.normalize();
    }
    const q = delta.map((d, b) => d.clone().multiply(lib.rest[b]).normalize());
    const J = (n: string) => this.jIdx.get(n)!;
    const s = this.scale;
    const mid = this.pos[J('LeftUpLeg')].clone().add(this.pos[J('RightUpLeg')]).multiplyScalar(0.5 * s);
    const hips = mid.add(this.hipsFromJoints.clone().applyQuaternion(delta[0]));
    const ankles: [THREE.Vector3, THREE.Vector3] = [this.pos[J('LeftFoot')].clone().multiplyScalar(s), this.pos[J('RightFoot')].clone().multiplyScalar(s)];
    return { q, hips, ankles };
  }
}

/** Parent bone of each library bone (the Rigify hierarchy). */
export const LIB_HIERARCHY: Record<string, string> = { 'spine.001': 'hips', 'spine.002': 'spine.001', 'spine.003': 'spine.002', neck: 'spine.003', head: 'neck' };
for (const s of ['L', 'R']) {
  Object.assign(LIB_HIERARCHY, {
    [`shoulder.${s}`]: 'spine.003', [`upper_arm.${s}`]: `shoulder.${s}`, [`forearm.${s}`]: `upper_arm.${s}`, [`hand.${s}`]: `forearm.${s}`,
    [`thigh.${s}`]: 'hips', [`shin.${s}`]: `thigh.${s}`, [`foot.${s}`]: `shin.${s}`, [`toe.${s}`]: `foot.${s}`,
  });
}

/**
 * Joint positions of a library pose (model-space rotations q, hips head at `hips`): every bone's
 * head is its parent's head plus the parent's rest offset turned by the parent's Δ.
 */
export function libJoints(lib: LibSkeleton, q: THREE.Quaternion[], hips: THREE.Vector3): THREE.Vector3[] {
  const P: THREE.Vector3[] = [];
  const delta = q.map((x, b) => x.clone().multiply(_qa.copy(lib.rest[b]).invert()));
  lib.bones.forEach((n, i) => {
    if (i === 0) { P[0] = hips.clone(); return; }
    const p = lib.bones.indexOf(LIB_HIERARCHY[n]);
    P[i] = P[p].clone().add(lib.restHead[i].clone().sub(lib.restHead[p]).applyQuaternion(delta[p]));
  });
  return P;
}

/** Mirror a library pose left ↔ right (model space, about the x = 0 plane). */
export function mirrorFrame(lib: LibSkeleton, fr: RetargetFrame): RetargetFrame {
  const B = lib.bones.length;
  const q: THREE.Quaternion[] = new Array(B);
  for (let b = 0; b < B; b++) {
    const n = lib.bones[b];
    const o = n.endsWith('.L') ? lib.bones.indexOf(n.slice(0, -1) + 'R') : n.endsWith('.R') ? lib.bones.indexOf(n.slice(0, -1) + 'L') : b;
    // Δ of the opposite bone, mirrored (reflection across x: (x, −y, −z, w)), onto this bone's rest.
    const d = fr.q[o].clone().multiply(_qa.copy(lib.rest[o]).invert());
    d.set(d.x, -d.y, -d.z, d.w);
    q[b] = d.multiply(lib.rest[b]).normalize();
  }
  const m = (v: THREE.Vector3) => new THREE.Vector3(-v.x, v.y, v.z);
  return { q, hips: m(fr.hips), ankles: [m(fr.ankles[1]), m(fr.ankles[0])] };
}
