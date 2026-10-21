/**
 * Scale's humanoid rig on top of an Actors character.
 *
 * Everything in Scale that moves people (the procedural Animator and its clips, foot IK, ragdolls,
 * the get-up, the manhole climb, first person, imported avatars) works on MakeHuman's "default"
 * skeleton names (spine05..01, upperarm01.L, …) with rest frames that carry no rotation (model
 * axes: +Y up, the character faces −Z, its left is −X). Actors characters use the game-engine
 * rig instead (pelvis, spine_01, upperarm_l, …; glTF axes, facing +Z; bone rolls as in Blender).
 *
 * So each character gets a *proxy* skeleton with the Scale names whose joints sit exactly on the
 * Actors joints (extra MakeHuman joints such as upperarm02 halfway between two of them), and
 * every frame `RigBridge.sync` turns the proxy pose into the Actors bones:
 *
 *   actor bone (object space) = R⁻¹ · Δ · R · bind,   Δ = the driving proxy bone's model-space rotation,
 *
 * R being the half turn between the two facings, then swung so the bone points from its proxy
 * joint to the next one (joints stay where the animator put them, e.g. hands on IK goals, even
 * where one Actors bone stands for two proxy bones). The pelvis takes the proxy root's position.
 */
import * as THREE from 'three';

/** Scale's proxy skeleton: [name, parent], parents first (MakeHuman "default" rig without the twist helpers). */
export const SCALE_BONES: [string, string | null][] = (() => {
  const out: [string, string | null][] = [
    ['root', null], ['spine05', 'root'], ['spine04', 'spine05'], ['spine03', 'spine04'], ['spine02', 'spine03'], ['spine01', 'spine02'],
    ['neck01', 'spine01'], ['neck02', 'neck01'], ['neck03', 'neck02'], ['head', 'neck03'], ['jaw', 'head'],
  ];
  for (const s of ['L', 'R']) {
    out.push([`clavicle.${s}`, 'spine01'], [`shoulder01.${s}`, `clavicle.${s}`], [`upperarm01.${s}`, `shoulder01.${s}`], [`upperarm02.${s}`, `upperarm01.${s}`],
      [`lowerarm01.${s}`, `upperarm02.${s}`], [`lowerarm02.${s}`, `lowerarm01.${s}`], [`wrist.${s}`, `lowerarm02.${s}`]);
    for (let f = 1; f <= 5; f++) for (let k = 1; k <= 3; k++) out.push([`finger${f}-${k}.${s}`, k === 1 ? `wrist.${s}` : `finger${f}-${k - 1}.${s}`]);
  }
  for (const s of ['L', 'R']) {
    out.push([`pelvis.${s}`, 'root'], [`upperleg01.${s}`, `pelvis.${s}`], [`upperleg02.${s}`, `upperleg01.${s}`], [`lowerleg01.${s}`, `upperleg02.${s}`],
      [`lowerleg02.${s}`, `lowerleg01.${s}`], [`foot.${s}`, `lowerleg02.${s}`], [`toes.${s}`, `foot.${s}`]);
  }
  return out;
})();

/** MakeHuman finger number → game-engine finger name. */
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];

/** Actors bone → [driving proxy bone, aim from, aim to] (aim: the proxy joints the bone spans). */
const DRIVE: Record<string, [string, string?, string?]> = {
  pelvis: ['root'],
  spine_01: ['spine04', 'spine05', 'spine03'],
  spine_02: ['spine02', 'spine03', 'spine01'],
  spine_03: ['spine01', 'spine01', 'neck01'],
  neck_01: ['neck03', 'neck01', 'head'],
  head: ['head'],
};
for (const [s, a] of [['L', 'l'], ['R', 'r']]) {
  Object.assign(DRIVE, {
    [`clavicle_${a}`]: [`shoulder01.${s}`, `clavicle.${s}`, `upperarm01.${s}`],
    [`upperarm_${a}`]: [`upperarm02.${s}`, `upperarm01.${s}`, `lowerarm01.${s}`],
    [`lowerarm_${a}`]: [`lowerarm02.${s}`, `lowerarm01.${s}`, `wrist.${s}`],
    [`hand_${a}`]: [`wrist.${s}`],
    [`thigh_${a}`]: [`upperleg02.${s}`, `upperleg01.${s}`, `lowerleg01.${s}`],
    [`calf_${a}`]: [`lowerleg02.${s}`, `lowerleg01.${s}`, `foot.${s}`],
    [`foot_${a}`]: [`foot.${s}`, `foot.${s}`, `toes.${s}`],
    [`ball_${a}`]: [`toes.${s}`],
  });
  FINGERS.forEach((f, i) => {
    for (let k = 1; k <= 3; k++) DRIVE[`${f}_0${k}_${a}`] = k < 3 ? [`finger${i + 1}-${k}.${s}`, `finger${i + 1}-${k}.${s}`, `finger${i + 1}-${k + 1}.${s}`] : [`finger${i + 1}-${k}.${s}`];
  });
}

/**
 * Proxy bone → the Actors bone whose rotation it carries when a pose comes from Actors (the
 * reverse of DRIVE): every proxy bone standing for part of one Actors bone takes that bone's
 * rotation, so the proxy joints land on the Actors joints and `RigBridge.sync` hands the pose
 * back unchanged. 'follow': rigid with its parent.
 */
export const PROXY_FROM_ACTOR: Record<string, string> = {
  root: 'pelvis', spine05: 'spine_01', spine04: 'spine_01', spine03: 'spine_02', spine02: 'spine_02', spine01: 'spine_03',
  neck01: 'neck_01', neck02: 'neck_01', neck03: 'neck_01', head: 'head',
};
for (const [s, a] of [['L', 'l'], ['R', 'r']]) {
  Object.assign(PROXY_FROM_ACTOR, {
    [`clavicle.${s}`]: `clavicle_${a}`, [`shoulder01.${s}`]: `clavicle_${a}`,
    [`upperarm01.${s}`]: `upperarm_${a}`, [`upperarm02.${s}`]: `upperarm_${a}`,
    [`lowerarm01.${s}`]: `lowerarm_${a}`, [`lowerarm02.${s}`]: `lowerarm_${a}`, [`wrist.${s}`]: `hand_${a}`,
    [`pelvis.${s}`]: 'follow', [`upperleg01.${s}`]: `thigh_${a}`, [`upperleg02.${s}`]: `thigh_${a}`,
    [`lowerleg01.${s}`]: `calf_${a}`, [`lowerleg02.${s}`]: `calf_${a}`, [`foot.${s}`]: `foot_${a}`, [`toes.${s}`]: `ball_${a}`,
  });
  FINGERS.forEach((f, i) => { for (let k = 1; k <= 3; k++) PROXY_FROM_ACTOR[`finger${i + 1}-${k}.${s}`] = `${f}_0${k}_${a}`; });
}

/** Actors space ↔ Scale model space: a half turn about +Y (x and z flip sign). */
const flipV = (v: THREE.Vector3) => v.set(-v.x, v.y, -v.z);
const flipQ = (q: THREE.Quaternion) => q.set(-q.x, q.y, -q.z, q.w);

/** Bind pose of an Actors skeleton in the actor's object space: heads and rotations per bone. */
export interface ActorBind {
  heads: THREE.Vector3[];
  rots: THREE.Quaternion[];
}

export function actorBind(skeleton: THREE.Skeleton): ActorBind {
  const heads: THREE.Vector3[] = [], rots: THREE.Quaternion[] = [];
  const m = new THREE.Matrix4(), s = new THREE.Vector3();
  for (const inv of skeleton.boneInverses) {
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    m.copy(inv).invert().decompose(p, q, s);
    heads.push(p);
    rots.push(q);
  }
  return { heads, rots };
}

/**
 * Rest heads of the proxy bones in Scale model space (feet at y = 0 when `ground` is the actor's
 * ground offset), plus tails (the next joint, or a continuation for end bones).
 */
export function proxyRest(skeleton: THREE.Skeleton, bind: ActorBind, ground: number): { heads: THREE.Vector3[]; tails: THREE.Vector3[]; extra: { name: string; parent: string; head: THREE.Vector3 }[] } {
  const idx = new Map(skeleton.bones.map((b, i) => [b.name, i]));
  const H = (n: string) => {
    const i = idx.get(n);
    if (i === undefined) throw new Error(`actors rig: no bone ${n}`);
    return flipV(bind.heads[i].clone()).setY(bind.heads[i].y + ground);
  };
  const mid = (a: string, b: string, t = 0.5) => H(a).lerp(H(b), t);
  const at: Record<string, THREE.Vector3> = {
    root: H('pelvis'), spine05: H('spine_01'), spine04: mid('spine_01', 'spine_02'), spine03: H('spine_02'), spine02: mid('spine_02', 'spine_03'), spine01: H('spine_03'),
    neck01: H('neck_01'), neck02: mid('neck_01', 'head', 1 / 3), neck03: mid('neck_01', 'head', 2 / 3), head: H('head'),
  };
  const headLen = H('head').distanceTo(H('neck_01'));
  at.jaw = H('head').add(new THREE.Vector3(0, -0.35 * headLen, -0.4 * headLen));
  for (const [s, a] of [['L', 'l'], ['R', 'r']]) {
    Object.assign(at, {
      [`clavicle.${s}`]: H(`clavicle_${a}`), [`shoulder01.${s}`]: mid(`clavicle_${a}`, `upperarm_${a}`, 0.6),
      [`upperarm01.${s}`]: H(`upperarm_${a}`), [`upperarm02.${s}`]: mid(`upperarm_${a}`, `lowerarm_${a}`),
      [`lowerarm01.${s}`]: H(`lowerarm_${a}`), [`lowerarm02.${s}`]: mid(`lowerarm_${a}`, `hand_${a}`), [`wrist.${s}`]: H(`hand_${a}`),
      [`pelvis.${s}`]: H('pelvis'), [`upperleg01.${s}`]: H(`thigh_${a}`), [`upperleg02.${s}`]: mid(`thigh_${a}`, `calf_${a}`),
      [`lowerleg01.${s}`]: H(`calf_${a}`), [`lowerleg02.${s}`]: mid(`calf_${a}`, `foot_${a}`), [`foot.${s}`]: H(`foot_${a}`), [`toes.${s}`]: H(`ball_${a}`),
    });
    FINGERS.forEach((f, i) => { for (let k = 1; k <= 3; k++) at[`finger${i + 1}-${k}.${s}`] = H(`${f}_0${k}_${a}`); });
  }
  const heads = SCALE_BONES.map(([n]) => at[n]);
  const tails = SCALE_BONES.map(([n], i) => {
    const child = SCALE_BONES.findIndex(([, p], j) => p === n && j > i && !/^(clavicle|pelvis)/.test(SCALE_BONES[j][0]));
    if (n === 'root') return at.spine05.clone();
    if (n === 'spine01') return at.neck01.clone();
    if (n === 'wrist.L' || n === 'wrist.R') return at[`finger3-1.${n.slice(-1)}`].clone();
    if (child >= 0) return heads[child].clone();
    if (n === 'head') return heads[i].clone().add(new THREE.Vector3(0, headLen * 1.4, 0));
    // End bones (toes, finger tips, jaw): continue the parent's direction.
    const p = SCALE_BONES.findIndex(([m]) => m === SCALE_BONES[i][1]);
    const d = heads[i].clone().sub(heads[p]);
    return heads[i].clone().addScaledVector(d, n.startsWith('toes') ? 0.6 : 0.8);
  });
  // Bones Actors adds for generated parts (the tail chain), after the pack's own: proxies named
  // tail0, tail1, … (the animator's tail sway drives them), under the proxy of their parent.
  const extra: { name: string; parent: string; head: THREE.Vector3 }[] = [];
  skeleton.bones.forEach((b, i) => {
    if (b.name in DRIVE || b.name === 'Root') return;
    const parent = b.parent as THREE.Bone;
    const pName = parent.name in DRIVE ? DRIVE[parent.name][0] : proxyName(parent.name, skeleton);
    extra.push({ name: proxyName(b.name, skeleton), parent: pName, head: flipV(bind.heads[i].clone()).setY(bind.heads[i].y + ground) });
  });
  return { heads, tails, extra };
}

/** Proxy name of an Actors bone that is not part of the pack's skeleton (tail bones: tail0, tail1, …). */
function proxyName(actorBone: string, skeleton: THREE.Skeleton): string {
  const extras = skeleton.bones.filter((b) => !(b.name in DRIVE) && b.name !== 'Root');
  return `tail${extras.findIndex((b) => b.name === actorBone)}`;
}

interface Link {
  bone: THREE.Bone;
  parent: number;
  drive: number;
  /** Proxy bone whose scale the bone takes (first person folds the head and forearms away). */
  scaleFrom: number;
  aimA: number;
  aimB: number;
  /** Bind rotation and head in the actor's object space. */
  bindQ: THREE.Quaternion;
  bindP: THREE.Vector3;
  /** Bind direction toward the aim joint (object space). */
  restDir: THREE.Vector3 | null;
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

/** Copies a proxy pose onto an Actors skeleton (see the file comment). */
export class RigBridge {
  private links: Link[] = [];
  private pelvis = -1;
  private modelQ: THREE.Quaternion[];
  private modelP: THREE.Vector3[];
  private parents: number[];

  /** `rest`: the proxy's rest heads in model space (see proxyRest). */
  constructor(private proxy: THREE.Bone[], rest: THREE.Vector3[], readonly skeleton: THREE.Skeleton, bind: ActorBind, private ground: () => number) {
    const pIdx = new Map(proxy.map((b, i) => [b.name, i]));
    this.parents = proxy.map((b) => proxy.indexOf(b.parent as THREE.Bone));
    this.modelQ = proxy.map(() => new THREE.Quaternion());
    this.modelP = proxy.map(() => new THREE.Vector3());
    const bones = skeleton.bones;
    bones.forEach((bone, i) => {
      const d = DRIVE[bone.name] ?? (bone.name !== 'Root' ? [proxyName(bone.name, skeleton)] : null);
      const link: Link = {
        bone, parent: bones.indexOf(bone.parent as THREE.Bone), drive: d ? pIdx.get(d[0]) ?? -1 : -1,
        aimA: d?.[1] ? pIdx.get(d[1])! : -1, aimB: d?.[2] ? pIdx.get(d[2])! : -1, scaleFrom: d ? pIdx.get(d[1] ?? d[0]) ?? -1 : -1,
        bindQ: bind.rots[i].clone(), bindP: bind.heads[i].clone(), restDir: null,
      };
      if (link.aimA >= 0 && link.aimB >= 0) {
        // Proxy rest joints are the actor's (flipped), so the rest direction comes from them.
        link.restDir = flipV(rest[link.aimB].clone().sub(rest[link.aimA])).normalize();
      }
      if (bone.name === 'pelvis') this.pelvis = i;
      this.links.push(link);
    });
  }

  /** Proxy pose → Actors bones (local rotations; the pelvis position). */
  sync(): void {
    const proxy = this.proxy, Q = this.modelQ, P = this.modelP;
    for (let i = 0; i < proxy.length; i++) {
      const b = proxy[i], p = this.parents[i];
      if (p < 0) {
        Q[i].copy(b.quaternion);
        P[i].copy(b.position);
      } else {
        Q[i].multiplyQuaternions(Q[p], b.quaternion);
        P[i].copy(b.position).applyQuaternion(Q[p]).add(P[p]);
      }
    }
    const links = this.links;
    const world: THREE.Quaternion[] = (this._world ??= links.map(() => new THREE.Quaternion()));
    for (let i = 0; i < links.length; i++) {
      const L = links[i], A = world[i];
      if (L.drive >= 0) A.multiplyQuaternions(flipQ(_q.copy(Q[L.drive])), L.bindQ);
      else A.copy(L.bindQ);
      if (L.restDir) {
        // Swing onto the joints the animator placed.
        const cur = _v.copy(L.restDir);
        if (L.drive >= 0) cur.applyQuaternion(flipQ(_q.copy(Q[L.drive])));
        const want = flipV(_v2.copy(P[L.aimB]).sub(P[L.aimA]));
        const len = want.length();
        if (len > 1e-6) {
          want.multiplyScalar(1 / len);
          A.premultiply(_q2.setFromUnitVectors(cur, want));
        }
      }
      const parentA = L.parent >= 0 ? world[L.parent] : null;
      if (parentA) L.bone.quaternion.copy(parentA).invert().multiply(A);
      else L.bone.quaternion.copy(A);
      if (L.scaleFrom >= 0) L.bone.scale.copy(proxy[L.scaleFrom].scale);
    }
    if (this.pelvis >= 0) {
      const L = this.links[this.pelvis];
      // Target head in object space: the proxy root, less the actor's ground offset.
      const t = flipV(_v.copy(P[0])).setY(P[0].y - this.ground());
      const parentA = L.parent >= 0 ? world[L.parent] : null;
      const parentP = L.parent >= 0 ? this.links[L.parent].bindP : _v2.set(0, 0, 0);
      t.sub(parentP);
      if (parentA) t.applyQuaternion(_q.copy(parentA).invert());
      L.bone.position.copy(t);
    }
  }

  private _world?: THREE.Quaternion[];
}
