/**
 * Body measurements and equipment sockets of an Actors character, in Scale's model space
 * (feet at y = 0, facing −Z, left −X; see rig.ts): what rigid wearables (hats, masks, a sandwich
 * board), held items and the animator need from a body.
 */
import * as THREE from 'three';
import type { BodyFit } from '../../items/wearable';
import { SCALE_BONES } from './rig';
import { v3sub as sub, v3add as add, v3scale as mul, v3dot as dot, v3cross as cross, v3norm as norm } from '../../core/math';

export interface SocketFrame {
  /** Proxy bone index (SCALE_BONES order). */
  bone: number;
  /** Rest-pose model-space origin. */
  pos: [number, number, number];
  /** Rest-pose model-space basis columns X, Y, Z (may be a reflection, see items' socket convention). */
  basis: [number, number, number, number, number, number, number, number, number];
}

export interface BodyData {
  /** Proxy bone heads / tails in rest model space (B*3). */
  heads: Float32Array;
  tails: Float32Array;
  /** Eyeball centres & radii: [xL,yL,zL,rL, xR,yR,zR,rR]. */
  eyes: Float32Array;
  fit: BodyFit;
  sockets: Record<string, SocketFrame>;
  /** Head sphere (for hair/hats): centre xyz + radius. */
  headSphere: [number, number, number, number];
  /** Size of the face relative to a plain human's (eye distance). */
  faceScale: number;
  /** Top of the head (m above the feet). */
  height: number;
}

type V3 = [number, number, number];
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const BODY_FORWARD: V3 = [0, 0, -1];
const BODY_LEFT: V3 = [-1, 0, 0];
const UP: V3 = [0, 1, 0];

/** Socket basis: Y along `y` (or up), Z toward `zPref` (orthogonalized), X toward `xPref` (by preference, so some frames are reflections). */
function basis(y: V3 | null, zPref: V3, xPref: V3): SocketFrame['basis'] {
  const Y = y ? norm(y) : UP;
  let Z = sub(zPref, mul(Y, dot(zPref, Y)));
  if (Math.hypot(Z[0], Z[1], Z[2]) < 1e-4) Z = sub(xPref, mul(Y, dot(xPref, Y)));
  Z = norm(Z);
  let X = norm(cross(Y, Z));
  if (dot(X, xPref) < 0) X = mul(X, -1);
  return [X[0], X[1], X[2], Y[0], Y[1], Y[2], Z[0], Z[1], Z[2]];
}

/** Vertices of a skinned mesh in Scale model space, with their strongest bone (by Actors bone name). */
interface Cloud {
  pos: Float32Array;
  bone: string[];
  weight: Float32Array;
}

function cloud(mesh: THREE.SkinnedMesh, ground: number): Cloud {
  const g = mesh.geometry;
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const si = g.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
  const sw = g.getAttribute('skinWeight') as THREE.BufferAttribute | undefined;
  const n = p.count;
  const pos = new Float32Array(n * 3), weight = new Float32Array(n);
  const bone: string[] = new Array(n);
  const names = mesh.skeleton?.bones.map((b) => b.name) ?? [];
  for (let i = 0; i < n; i++) {
    pos[i * 3] = -p.getX(i);
    pos[i * 3 + 1] = p.getY(i) + ground;
    pos[i * 3 + 2] = -p.getZ(i);
    let best = 0, bw = -1;
    if (si && sw) for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
    bone[i] = names[best] ?? '';
    weight[i] = Math.max(0, bw);
  }
  return { pos, bone, weight };
}

/**
 * Measures a body. `body`: the Actors body mesh (full or base detail), `eyes`: its eye mesh,
 * `heads`/`tails`: the proxy rest joints (model space), `ground`: the actor's ground offset.
 */
export function measureBody(body: THREE.SkinnedMesh, eyesMesh: THREE.SkinnedMesh | undefined, heads: THREE.Vector3[], tails: THREE.Vector3[], ground: number, extra: { earPoint: number; hasHorns: boolean }): BodyData {
  const B = SCALE_BONES.length;
  const bi = new Map(SCALE_BONES.map(([n], i) => [n, i]));
  const H = (n: string): V3 => { const v = heads[bi.get(n)!]; return [v.x, v.y, v.z]; };
  const T = (n: string): V3 => { const v = tails[bi.get(n)!]; return [v.x, v.y, v.z]; };
  const c = cloud(body, ground);
  const n = c.pos.length / 3;
  const P = (i: number): V3 => [c.pos[i * 3], c.pos[i * 3 + 1], c.pos[i * 3 + 2]];
  let top = 0;
  for (let i = 0; i < n; i++) top = Math.max(top, c.pos[i * 3 + 1]);

  // ---- eyes: the two halves of the eye mesh
  const eyes = new Float32Array(8);
  if (eyesMesh) {
    const e = cloud(eyesMesh, ground);
    for (const [k, side] of [[0, -1], [1, 1]] as const) {
      let x = 0, y = 0, z = 0, w = 0;
      for (let i = 0; i < e.pos.length / 3; i++) if (e.pos[i * 3] * side > 0) { x += e.pos[i * 3]; y += e.pos[i * 3 + 1]; z += e.pos[i * 3 + 2]; w++; }
      const ctr: V3 = w ? [x / w, y / w, z / w] : add(H('head'), [0.032 * side, 0.06, -0.08]);
      let r = 0;
      for (let i = 0; i < e.pos.length / 3; i++) if (e.pos[i * 3] * side > 0) r += dist([e.pos[i * 3], e.pos[i * 3 + 1], e.pos[i * 3 + 2]], ctr);
      eyes.set([...ctr, w ? r / w : 0.012], k * 4);
    }
  } else eyes.set([...add(H('head'), [-0.032, 0.06, -0.08]), 0.012, ...add(H('head'), [0.032, 0.06, -0.08]), 0.012]);
  const ipd = Math.hypot(eyes[0] - eyes[4], eyes[1] - eyes[5], eyes[2] - eyes[6]);

  // ---- ears (the widest points of the head) and head radius
  const headV: number[] = [];
  for (let i = 0; i < n; i++) if (c.bone[i] === 'head' && c.weight[i] > 0.9) headV.push(i);
  let minX = Infinity, maxX = -Infinity;
  for (const i of headV) { minX = Math.min(minX, c.pos[i * 3]); maxX = Math.max(maxX, c.pos[i * 3]); }
  const side = (s: number): V3 => {
    let x = 0, y = 0, z = 0, w = 0;
    const lim = s < 0 ? minX * 0.85 : maxX * 0.85;
    for (const i of headV) if (s < 0 ? c.pos[i * 3] < lim : c.pos[i * 3] > lim) { x += c.pos[i * 3]; y += c.pos[i * 3 + 1]; z += c.pos[i * 3 + 2]; w++; }
    return w ? [x / w, y / w, z / w] : add(H('head'), [0.07 * s, 0.05, 0]);
  };
  const earMid = mul(add(side(-1), side(1)), 0.5);
  let hr = 0, hn = 0;
  for (const i of headV) if (c.pos[i * 3 + 1] >= earMid[1] + 0.01) { hr += dist(P(i), earMid); hn++; }
  const headRadius = hn ? hr / hn : 0.1;

  // ---- limb radii: mean distance of the dominated vertices from the bone segment
  const limb = (bones: string[], a: V3, b: V3) => {
    const set = new Set(bones);
    const ab = sub(b, a), l2 = Math.max(1e-6, dot(ab, ab));
    let r = 0, k = 0;
    for (let i = 0; i < n; i++) {
      if (!set.has(c.bone[i]) || c.weight[i] < 0.7) continue;
      const ap = sub(P(i), a);
      const t = Math.min(1, Math.max(0, dot(ap, ab) / l2));
      r += dist(P(i), add(a, mul(ab, t)));
      k++;
    }
    return k ? r / k : 0.05;
  };
  const avg = (f: (s: 'L' | 'R', a: 'l' | 'r') => number) => (f('L', 'l') + f('R', 'r')) / 2;
  const upperArmRadius = avg((s, a) => limb([`upperarm_${a}`], H(`upperarm01.${s}`), H(`lowerarm01.${s}`)));
  const forearmRadius = avg((s, a) => limb([`lowerarm_${a}`], H(`lowerarm01.${s}`), H(`wrist.${s}`)));
  const thighRadius = avg((s, a) => limb([`thigh_${a}`], H(`upperleg01.${s}`), H(`lowerleg01.${s}`)));
  const shinRadius = avg((s, a) => limb([`calf_${a}`], H(`lowerleg01.${s}`), H(`foot.${s}`)));
  const neckRadius = limb(['neck_01'], H('neck01'), H('head'));
  const handLength = avg((s) => dist(T(`finger3-3.${s}`), H(`wrist.${s}`)));
  const chestY = H('spine01')[1], waistY = H('spine04')[1];
  let cMinZ = Infinity, cMaxZ = -Infinity, wr = 0, wn = 0;
  const torso = new Set(['spine_01', 'spine_02', 'spine_03', 'pelvis']);
  const sc = top / 1.75;
  for (let i = 0; i < n; i++) {
    if (!torso.has(c.bone[i])) continue;
    const y = c.pos[i * 3 + 1];
    if (Math.abs(y - chestY) < 0.02 * sc && Math.abs(c.pos[i * 3]) < 0.12 * sc) { cMinZ = Math.min(cMinZ, c.pos[i * 3 + 2]); cMaxZ = Math.max(cMaxZ, c.pos[i * 3 + 2]); }
    if (Math.abs(y - waistY) < 0.02 * sc) { wr += Math.hypot(c.pos[i * 3], c.pos[i * 3 + 2] - H('spine04')[2]); wn++; }
  }
  const chestDepth = isFinite(cMaxZ) ? cMaxZ - cMinZ : 0.24 * sc;
  const waistRadius = wn ? wr / wn : 0.15 * sc;
  const shoulderWidth = dist(H('upperarm01.L'), H('upperarm01.R')) + upperArmRadius * 1.6;
  const footLength = avg((s, a) => {
    const dir = norm([T(`toes.${s}`)[0] - H(`foot.${s}`)[0], 0, T(`toes.${s}`)[2] - H(`foot.${s}`)[2]]);
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < n; i++) if (c.bone[i] === `foot_${a}` || c.bone[i] === `ball_${a}`) {
      const d = c.pos[i * 3] * dir[0] + c.pos[i * 3 + 2] * dir[2];
      mn = Math.min(mn, d); mx = Math.max(mx, d);
    }
    return isFinite(mx) ? mx - mn : 0.26 * sc;
  });
  const fit: BodyFit = {
    height: top, headRadius, neckRadius, shoulderWidth, chestDepth, waistRadius, upperArmRadius, forearmRadius,
    handLength, thighRadius, shinRadius, footLength, earPoint: extra.earPoint, hasHorns: extra.hasHorns,
  };
  const hipMid = mul(add(H('upperleg01.L'), H('upperleg01.R')), 0.5);
  fit.bones = {
    upperArm: dist(H('upperarm01.L'), H('lowerarm01.L')), forearm: dist(H('lowerarm01.L'), H('wrist.L')),
    thigh: dist(H('upperleg01.L'), H('lowerleg01.L')), shin: dist(H('lowerleg01.L'), H('foot.L')),
    neck: earMid[1] - H('neck01')[1], chest: H('spine01')[1] - H('spine03')[1], spine: H('spine03')[1] - hipMid[1],
  };

  // ---- sockets (rest pose)
  const sockets: Record<string, SocketFrame> = {};
  const put = (name: string, bone: string, p: V3, b: SocketFrame['basis']) => { sockets[name] = { bone: bi.get(bone)!, pos: p, basis: b }; };
  const bodyAligned = basis(null, BODY_FORWARD, BODY_LEFT);
  put('head', 'head', earMid, bodyAligned);
  put('neck', 'spine01', H('neck01'), bodyAligned);
  put('chest', 'spine01', H('spine01'), bodyAligned);
  put('spine', 'spine03', H('spine03'), bodyAligned);
  put('pelvis', 'root', hipMid, bodyAligned);
  put('back', 'spine01', add(H('spine01'), [0, 0, chestDepth * 0.5]), bodyAligned);
  for (const s of ['L', 'R'] as const) {
    put(`shoulder.${s}`, `shoulder01.${s}`, H(`upperarm01.${s}`), bodyAligned);
    put(`hip.${s}`, 'root', H(`upperleg01.${s}`), bodyAligned);
    put(`upperarm.${s}`, `upperarm01.${s}`, H(`upperarm01.${s}`), basis(sub(H(`lowerarm01.${s}`), H(`upperarm01.${s}`)), BODY_FORWARD, BODY_LEFT));
    put(`forearm.${s}`, `lowerarm01.${s}`, H(`lowerarm01.${s}`), basis(sub(H(`wrist.${s}`), H(`lowerarm01.${s}`)), BODY_FORWARD, BODY_LEFT));
    put(`thigh.${s}`, `upperleg01.${s}`, H(`upperleg01.${s}`), basis(sub(H(`lowerleg01.${s}`), H(`upperleg01.${s}`)), BODY_FORWARD, BODY_LEFT));
    put(`shin.${s}`, `lowerleg01.${s}`, H(`lowerleg01.${s}`), basis(sub(H(`foot.${s}`), H(`lowerleg01.${s}`)), BODY_FORWARD, BODY_LEFT));
    put(`foot.${s}`, `foot.${s}`, H(`foot.${s}`), basis(sub(T(`toes.${s}`), H(`foot.${s}`)), UP, BODY_LEFT));
    // Hand: +Y toward the fingers, +Z dorsal, +X toward the thumb.
    const wrist = H(`wrist.${s}`);
    const fingerDir = norm(sub(H(`finger3-1.${s}`), wrist));
    const across = norm(sub(H(`finger2-1.${s}`), H(`finger5-1.${s}`)));
    const sgn = s === 'L' ? -1 : 1;
    const dorsal = norm(mul(cross(fingerDir, across), sgn));
    put(`hand.${s}`, `wrist.${s}`, wrist, basis(fingerDir, dorsal, across));
    // Grip (held items): item +Y out of the thumb side of the fist, +Z along the knuckles, origin inside the fist.
    const gy = norm(sub(across, mul(fingerDir, dot(across, fingerDir))));
    const gz = fingerDir;
    const gx = cross(gy, gz);
    const palm = mul(dorsal, -1);
    const gripPos = add(add(wrist, mul(fingerDir, handLength * 0.42)), mul(palm, forearmRadius * 0.55));
    sockets[`grip.${s}`] = { bone: bi.get(`wrist.${s}`)!, pos: gripPos, basis: [gx[0], gx[1], gx[2], gy[0], gy[1], gy[2], gz[0], gz[1], gz[2]] };
  }
  // Mouth (speech / eat effects) below the eyes, and the tail root.
  const eyeMid: V3 = [(eyes[0] + eyes[4]) / 2, (eyes[1] + eyes[5]) / 2, (eyes[2] + eyes[6]) / 2];
  put('mouth', 'head', add(eyeMid, [0, -0.075 * (ipd / 0.064), -0.012]), bodyAligned);
  put('tail', 'root', add(H('spine05'), [0, -0.03 * sc, waistRadius * 0.9]), bodyAligned);

  const heads32 = new Float32Array(B * 3), tails32 = new Float32Array(B * 3);
  heads.slice(0, B).forEach((v, i) => heads32.set([v.x, v.y, v.z], i * 3));
  tails.slice(0, B).forEach((v, i) => tails32.set([v.x, v.y, v.z], i * 3));
  return {
    heads: heads32, tails: tails32, eyes, fit, sockets,
    headSphere: [earMid[0], earMid[1] + headRadius * 0.12, earMid[2] - headRadius * 0.08, headRadius],
    faceScale: ipd / 0.064,
    height: top,
  };
}
