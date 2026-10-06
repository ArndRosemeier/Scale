/**
 * Body builder: appearance → morphed, grounded, proportioned body with a
 * skeleton fitted to it, socket frames and fit measurements.
 *
 * Pipeline (all on typed arrays, no three.js — runs in the body worker):
 *  1. MakeHuman macro morph via the PCA basis (coefficients from the exact
 *     MakeHuman macro weights through the per-target projection matrix), then
 *     the offsets onto the Woman / Man base bodies (conform.bin).
 *  2. Local targets (face/body modifiers, race shaping, seeded micro detail).
 *  3. Procedural ear-tip elongation (elves, goblins).
 *  4. Bone proportion pass: per-bone length/girth scaling applied by linear
 *     blend skinning in the rest pose (dwarf legs, goblin heads...), so the
 *     result stays smooth at joints.
 *  5. Feet to y = 0, uniform race scale, normals, skeleton joints from the
 *     morphed virtual vertices, sockets & BodyFit.
 */
import type { HumanAssets } from './assets';
import { macroTargetWeights } from './macro';
import type { HumanoidAppearance } from './types';
import { computeShape, type ShapeParams } from './shape';
import type { BoneGroup } from './races';
import type { BodyFit, Socket } from '../items/wearable';

export interface SocketFrame {
  bone: number;
  /** Rest-pose model-space origin. */
  pos: [number, number, number];
  /** Rest-pose model-space basis columns X, Y, Z (may be a reflection, see items' socket convention). */
  basis: [number, number, number, number, number, number, number, number, number];
}

export interface BodyData {
  /** Morph-space positions/normals (N*3), meters, feet at y = 0, final scale applied. */
  pos: Float32Array;
  normal: Float32Array;
  /** Bone heads / tails in rest model space (B*3). */
  heads: Float32Array;
  tails: Float32Array;
  /** Eyeball centres & radii: [xL,yL,zL,rL, xR,yR,zR,rR]. */
  eyes: Float32Array;
  fit: BodyFit;
  sockets: Record<string, SocketFrame>;
  /** Head sphere (for hair/hats): centre xyz + radius. */
  headSphere: [number, number, number, number];
  /** Scale of the face relative to the MakeHuman base (expression deltas are multiplied by it). */
  faceScale: number;
  /** Top of the head (m above feet). */
  height: number;
}

// ------------------------------------------------------------------ morph

const _w = new Map<number, Float64Array>();

/** Apply macro PCA + local targets to the base positions. */
export function morphPositions(as: HumanAssets, shape: ShapeParams, out?: Float32Array): Float32Array {
  const m = as.manifest;
  const N = m.morphVerts, L = N * 3;
  const pos = out ?? new Float32Array(L);
  pos.set(as.basePos);
  // ---- macro PCA
  const T = m.pca.targets.length, K = m.pca.components, K16 = m.pca.int16Components;
  let w = _w.get(T);
  if (!w) { w = new Float64Array(T); _w.set(T, w); }
  macroTargetWeights(shape.macro, m.pca.vars, w);
  const ms = m.pca.meanScale, mean = as.pcaMean;
  for (let i = 0; i < L; i++) pos[i] += mean[i] * ms;
  const proj = as.pcaProj;
  for (let k = 0; k < K; k++) {
    let c = -m.pca.meanProj[k];
    for (let t = 0; t < T; t++) { const wt = w[t]; if (wt) c += wt * proj[t * K + k]; }
    const s = c * m.pca.scales[k];
    if (Math.abs(s) < 1e-12) continue;
    if (k < K16) {
      const B = as.pcaBasis16, o = k * L;
      for (let i = 0; i < L; i++) pos[i] += s * B[o + i];
    } else {
      const B = as.pcaBasis8, o = (k - K16) * L;
      for (let i = 0; i < L; i++) pos[i] += s * B[o + i];
    }
  }
  // ---- Woman / Man base bodies (by gender; children keep MakeHuman's shape)
  const cf = as.conform;
  if (cf) {
    const a = shape.macro.age;
    const k = cf.scale * Math.min(1, Math.max(0, (a - 0.1875) / 0.1875));
    const g = Math.min(1, Math.max(0, shape.macro.gender));
    const kf = k * (1 - g), km = k * g;
    if (k > 0) for (let i = 0; i < L; i++) pos[i] += kf * cf.female[i] + km * cf.male[i];
  }
  // ---- local targets
  for (const [name, wt] of shape.targets) {
    const def = as.localByName.get(name);
    if (!def || !wt) continue;
    const idx = def.bits === 8 ? as.localIdx8 : as.localIdx16;
    const del = def.bits === 8 ? as.localDelta8 : as.localDelta16;
    const s = wt * def.scale;
    const end = def.start + def.count;
    for (let e = def.start; e < end; e++) {
      const v = idx[e] * 3, d = e * 3;
      pos[v] += s * del[d];
      pos[v + 1] += s * del[d + 1];
      pos[v + 2] += s * del[d + 2];
    }
  }
  return pos;
}

/** Normalized per-vertex magnitude of a local target (0..1), e.g. to find ear or lip vertices. */
export function targetMask(as: HumanAssets, name: string): Float32Array {
  const N = as.manifest.morphVerts;
  const out = new Float32Array(N);
  const def = as.localByName.get(name);
  if (!def) return out;
  const idx = def.bits === 8 ? as.localIdx8 : as.localIdx16;
  const del = def.bits === 8 ? as.localDelta8 : as.localDelta16;
  let mx = 0;
  for (let e = def.start; e < def.start + def.count; e++) {
    const m = Math.hypot(del[e * 3], del[e * 3 + 1], del[e * 3 + 2]);
    out[idx[e]] = m;
    mx = Math.max(mx, m);
  }
  if (mx > 0) for (let i = 0; i < N; i++) out[i] /= mx;
  return out;
}

// ------------------------------------------------------------------ ears

const earCache = new WeakMap<HumanAssets, { mask: Float32Array; side: Int8Array }>();
function earInfo(as: HumanAssets) {
  let e = earCache.get(as);
  if (!e) {
    const l = targetMask(as, 'l-ear-scale-incr'), r = targetMask(as, 'r-ear-scale-incr');
    const mask = new Float32Array(l.length);
    const side = new Int8Array(l.length);
    for (let i = 0; i < l.length; i++) {
      if (l[i] > r[i]) { mask[i] = l[i]; side[i] = -1; } else if (r[i] > 0) { mask[i] = r[i]; side[i] = 1; }
    }
    e = { mask, side };
    earCache.set(as, e);
  }
  return e;
}

/**
 * Elongate the upper ear into a tip. `sideways` 0 sweeps up/back (elf),
 * 1 sticks out to the side (goblin).
 */
function applyEarTips(as: HumanAssets, pos: Float32Array, amount: number, sideways: number) {
  if (amount <= 0.01) return;
  const { mask, side } = earInfo(as);
  const REAL = as.manifest.realVerts;
  for (const s of [-1, 1]) {
    // Weighted centre & vertical extent of this ear.
    let cx = 0, cy = 0, cz = 0, sw = 0, top = -1e9, bot = 1e9;
    for (let i = 0; i < REAL; i++) if (side[i] === s && mask[i] > 0.15) {
      const m = mask[i];
      cx += pos[i * 3] * m; cy += pos[i * 3 + 1] * m; cz += pos[i * 3 + 2] * m; sw += m;
      top = Math.max(top, pos[i * 3 + 1]);
      bot = Math.min(bot, pos[i * 3 + 1]);
    }
    if (sw === 0) continue;
    cx /= sw; cy /= sw; cz /= sw;
    const half = Math.max(0.01, (top - bot) / 2);
    const len = 0.05 * amount; // tip gain in meters at full strength
    // Lateral direction: Norgo character's left is −X ("l-" targets).
    const outX = s < 0 ? -1 : 1;
    const ux = outX * (0.25 + 0.75 * sideways), uy = 1 - 0.75 * sideways, uz = 0.55 - 0.35 * sideways; // +Z = back
    const ul = Math.hypot(ux, uy, uz);
    for (let i = 0; i < REAL; i++) {
      if (side[i] !== s || mask[i] <= 0) continue;
      const rx = pos[i * 3] - cx, ry = pos[i * 3 + 1] - cy, rz = pos[i * 3 + 2] - cz;
      // Tip coordinate: how far along the tip direction (up/back or out) the vertex lies.
      const along = (rx * ux + ry * uy + rz * uz) / ul / half;
      const tt = Math.max(0, Math.min(1.4, along - 0.05));
      if (tt <= 0) continue;
      const k = Math.pow(tt, 2.2) * Math.min(1, mask[i] * 1.6) * len;
      pos[i * 3] += (ux / ul) * k;
      pos[i * 3 + 1] += (uy / ul) * k;
      pos[i * 3 + 2] += (uz / ul) * k;
    }
  }
}

// ------------------------------------------------------------------ bones & proportion pass

const GROUP_BONES: Record<BoneGroup, RegExp> = {
  legs: /^(upperleg0[12]|lowerleg0[12])\./,
  thighs: /^upperleg0[12]\./,
  shins: /^lowerleg0[12]\./,
  arms: /^(upperarm0[12]|lowerarm0[12])\./,
  upperarms: /^upperarm0[12]\./,
  forearms: /^lowerarm0[12]\./,
  hands: /^wrist\./,
  fingers: /^finger/,
  feet: /^(foot|toes)\./,
  spine: /^spine0[1-5]$/,
  neck: /^neck0[1-3]$/,
  head: /^(head|jaw)$/,
  clavicles: /^(clavicle|shoulder01)\./,
  pelvis: /^pelvis\./,
};

/** Per-bone 3x3 linear map: girth*I + (len-girth)*d*dᵀ (or uniform for the head). */
function boneMatrices(as: HumanAssets, pos: Float32Array, shape: ShapeParams): Float64Array | null {
  const bones = as.manifest.bones;
  const len = new Float64Array(bones.length).fill(1);
  const girth = new Float64Array(bones.length).fill(1);
  let any = Math.abs(shape.headScale - 1) > 1e-4;
  for (const [grp, sc] of Object.entries(shape.bones) as [BoneGroup, { len: number; girth: number }][]) {
    const re = GROUP_BONES[grp];
    bones.forEach((b, i) => {
      if (re.test(b.name)) { len[i] *= sc.len; girth[i] *= sc.girth; any = true; }
    });
  }
  if (!any) return null;
  const M = new Float64Array(bones.length * 9);
  bones.forEach((b, i) => {
    const hx = pos[b.head * 3], hy = pos[b.head * 3 + 1], hz = pos[b.head * 3 + 2];
    let dx = pos[b.tail * 3] - hx, dy = pos[b.tail * 3 + 1] - hy, dz = pos[b.tail * 3 + 2] - hz;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    let l = len[i], g = girth[i];
    if (b.name === 'head' || b.name === 'jaw') { l *= shape.headScale; g *= shape.headScale; }
    const k = l - g, o = i * 9;
    M[o] = g + k * dx * dx; M[o + 1] = k * dx * dy; M[o + 2] = k * dx * dz;
    M[o + 3] = k * dy * dx; M[o + 4] = g + k * dy * dy; M[o + 5] = k * dy * dz;
    M[o + 6] = k * dz * dx; M[o + 7] = k * dz * dy; M[o + 8] = g + k * dz * dz;
  });
  return M;
}

/** Apply the bone proportion pass in place (rest-pose LBS with per-bone linear maps). */
function proportionPass(as: HumanAssets, pos: Float32Array, M: Float64Array) {
  const bones = as.manifest.bones;
  const B = bones.length;
  const h = new Float64Array(B * 3), hn = new Float64Array(B * 3);
  bones.forEach((b, i) => { h[i * 3] = pos[b.head * 3]; h[i * 3 + 1] = pos[b.head * 3 + 1]; h[i * 3 + 2] = pos[b.head * 3 + 2]; });
  const mul = (o: number, x: number, y: number, z: number, out: number[]) => {
    out[0] = M[o] * x + M[o + 1] * y + M[o + 2] * z;
    out[1] = M[o + 3] * x + M[o + 4] * y + M[o + 5] * z;
    out[2] = M[o + 6] * x + M[o + 7] * y + M[o + 8] * z;
  };
  const tmp = [0, 0, 0];
  for (let i = 0; i < B; i++) {
    const p = bones[i].parent;
    if (p < 0) { hn[i * 3] = h[i * 3]; hn[i * 3 + 1] = h[i * 3 + 1]; hn[i * 3 + 2] = h[i * 3 + 2]; continue; }
    mul(p * 9, h[i * 3] - h[p * 3], h[i * 3 + 1] - h[p * 3 + 1], h[i * 3 + 2] - h[p * 3 + 2], tmp);
    hn[i * 3] = hn[p * 3] + tmp[0]; hn[i * 3 + 1] = hn[p * 3 + 1] + tmp[1]; hn[i * 3 + 2] = hn[p * 3 + 2] + tmp[2];
  }
  const REAL = as.manifest.realVerts;
  const si = as.skinIdx, sw = as.skinW;
  for (let v = 0; v < REAL; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    let ox = 0, oy = 0, oz = 0;
    for (let k = 0; k < 4; k++) {
      const wgt = sw[v * 4 + k];
      if (!wgt) continue;
      const b = si[v * 4 + k], wf = wgt / 255;
      mul(b * 9, x - h[b * 3], y - h[b * 3 + 1], z - h[b * 3 + 2], tmp);
      ox += wf * (hn[b * 3] + tmp[0]); oy += wf * (hn[b * 3 + 1] + tmp[1]); oz += wf * (hn[b * 3 + 2] + tmp[2]);
    }
    pos[v * 3] = ox; pos[v * 3 + 1] = oy; pos[v * 3 + 2] = oz;
  }
  // Virtual vertices: heads move with their bone, tails follow the bone's map.
  const done = new Set<number>();
  bones.forEach((b, i) => {
    pos[b.head * 3] = hn[i * 3]; pos[b.head * 3 + 1] = hn[i * 3 + 1]; pos[b.head * 3 + 2] = hn[i * 3 + 2];
    done.add(b.head);
  });
  bones.forEach((b, i) => {
    if (done.has(b.tail)) return;
    mul(i * 9, pos[b.tail * 3] - h[i * 3], pos[b.tail * 3 + 1] - h[i * 3 + 1], pos[b.tail * 3 + 2] - h[i * 3 + 2], tmp);
    pos[b.tail * 3] = hn[i * 3] + tmp[0]; pos[b.tail * 3 + 1] = hn[i * 3 + 1] + tmp[1]; pos[b.tail * 3 + 2] = hn[i * 3 + 2] + tmp[2];
  });
}

// ------------------------------------------------------------------ normals

let triCache: { as: HumanAssets; tris: Uint32Array } | null = null;
/** All render triangles mapped to morph vertex indices (welded across UV seams). */
export function morphTriangles(as: HumanAssets): Uint32Array {
  if (triCache?.as === as) return triCache.tris;
  const idx = as.index, src = as.renderSrc;
  const tris = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) tris[i] = src[idx[i]];
  triCache = { as, tris };
  return tris;
}

export function computeNormals(as: HumanAssets, pos: Float32Array, out?: Float32Array): Float32Array {
  const n = out ?? new Float32Array(pos.length);
  n.fill(0);
  const t = morphTriangles(as);
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
    n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
    n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

// ------------------------------------------------------------------ measurements

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mulS = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Mean radial distance of the vertices dominated by `bones` from the axis head→tail (mid section only). */
function limbRadius(as: HumanAssets, pos: Float32Array, bones: number[], head: V3, tail: V3): number {
  const axis = sub(tail, head);
  const len2 = dot3(axis, axis) || 1;
  let s = 0, n = 0;
  const set = new Set(bones);
  for (let v = 0; v < as.manifest.realVerts; v++) {
    if (!set.has(as.skinIdx[v * 4]) || as.skinW[v * 4] < 180) continue;
    const p: V3 = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
    const r = sub(p, head);
    const t = dot3(r, axis) / len2;
    if (t < 0.2 || t > 0.8) continue;
    const perp = sub(r, mulS(axis, t));
    s += Math.hypot(perp[0], perp[1], perp[2]);
    n++;
  }
  return n ? s / n : 0.05;
}

const BODY_FORWARD: V3 = [0, 0, -1];
const BODY_LEFT: V3 = [-1, 0, 0];
const UP: V3 = [0, 1, 0];

/**
 * Socket basis per the items module's socket convention (items/client/wear/fit.ts):
 * Y along `y` (or up), Z toward `zPref` (orthogonalized), X toward `xPref`.
 * X is chosen by preference, not by handedness, so some frames are reflections.
 */
function basis(y: V3 | null, zPref: V3, xPref: V3): SocketFrame['basis'] {
  const Y = y ? norm(y) : UP;
  let Z = sub(zPref, mulS(Y, dot3(zPref, Y)));
  if (Math.hypot(Z[0], Z[1], Z[2]) < 1e-4) Z = sub(xPref, mulS(Y, dot3(xPref, Y)));
  Z = norm(Z);
  let X = norm(cross(Y, Z));
  if (dot3(X, xPref) < 0) X = mulS(X, -1);
  return [X[0], X[1], X[2], Y[0], Y[1], Y[2], Z[0], Z[1], Z[2]];
}

/** Build a complete body for an appearance. */
export function buildBody(as: HumanAssets, app: HumanoidAppearance): BodyData {
  const m = as.manifest;
  const shape = computeShape(app);
  const pos = morphPositions(as, shape);
  applyEarTips(as, pos, shape.earTip, shape.earSideways);
  const M = boneMatrices(as, pos, shape);
  if (M) proportionPass(as, pos, M);

  // ---- ground & scale: lowest body vertex at y = 0
  const BODY = m.groups.tongue[0];
  let minY = Infinity;
  for (let v = 0; v < BODY; v++) minY = Math.min(minY, pos[v * 3 + 1]);
  const sc = shape.scale;
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] *= sc;
    pos[i + 1] = (pos[i + 1] - minY) * sc;
    pos[i + 2] *= sc;
  }
  const normal = computeNormals(as, pos);

  // ---- skeleton
  const B = m.bones.length;
  const heads = new Float32Array(B * 3), tails = new Float32Array(B * 3);
  m.bones.forEach((b, i) => {
    heads.set(pos.subarray(b.head * 3, b.head * 3 + 3), i * 3);
    tails.set(pos.subarray(b.tail * 3, b.tail * 3 + 3), i * 3);
  });
  const bi = (n: string) => as.boneByName.get(n)!;
  const H = (n: string): V3 => { const i = bi(n) * 3; return [heads[i], heads[i + 1], heads[i + 2]]; };
  const Tl = (n: string): V3 => { const i = bi(n) * 3; return [tails[i], tails[i + 1], tails[i + 2]]; };

  // ---- eyes
  const eyes = new Float32Array(8);
  const eyeFit = (g: [number, number], src: ArrayLike<number>) => {
    let x = 0, y = 0, z = 0;
    for (let v = g[0]; v < g[0] + g[1]; v++) { x += src[v * 3]; y += src[v * 3 + 1]; z += src[v * 3 + 2]; }
    const c: V3 = [x / g[1], y / g[1], z / g[1]];
    let r = 0;
    for (let v = g[0]; v < g[0] + g[1]; v++) r += Math.hypot(src[v * 3] - c[0], src[v * 3 + 1] - c[1], src[v * 3 + 2] - c[2]);
    return { c, r: r / g[1] };
  };
  const eL = eyeFit(m.groups.eyeL, pos), eR = eyeFit(m.groups.eyeR, pos);
  eyes.set([...eL.c, eL.r, ...eR.c, eR.r]);
  const b0L = eyeFit(m.groups.eyeL, as.basePos), b0R = eyeFit(m.groups.eyeR, as.basePos);
  const ipd = Math.hypot(eL.c[0] - eR.c[0], eL.c[1] - eR.c[1], eL.c[2] - eR.c[2]);
  const ipd0 = Math.hypot(b0L.c[0] - b0R.c[0], b0L.c[1] - b0R.c[1], b0L.c[2] - b0R.c[2]);

  // ---- ears & head
  const { mask: earMask, side: earSide } = earInfo(as);
  const earC = (s: number): V3 => {
    let x = 0, y = 0, z = 0, w = 0;
    for (let v = 0; v < BODY; v++) if (earSide[v] === s && earMask[v] > 0.5) { x += pos[v * 3]; y += pos[v * 3 + 1]; z += pos[v * 3 + 2]; w++; }
    return w ? [x / w, y / w, z / w] : H('head');
  };
  const earMid = mulS(add(earC(-1), earC(1)), 0.5);
  const headBone = bi('head');
  let hr = 0, hn = 0, top = 0;
  for (let v = 0; v < BODY; v++) {
    top = Math.max(top, pos[v * 3 + 1]);
    if (as.skinIdx[v * 4] !== headBone || as.skinW[v * 4] < 230) continue;
    if (pos[v * 3 + 1] < earMid[1] + 0.01) continue;
    hr += Math.hypot(pos[v * 3] - earMid[0], pos[v * 3 + 1] - earMid[1], pos[v * 3 + 2] - earMid[2]);
    hn++;
  }
  const headRadius = hn ? hr / hn : 0.1;

  // ---- fit measurements
  const sides = ['L', 'R'] as const;
  const avgSides = (f: (s: 'L' | 'R') => number) => (f('L') + f('R')) / 2;
  const radius = (bones: string[], a: V3, b: V3) => limbRadius(as, pos, bones.map(bi), a, b);
  const upperArmRadius = avgSides((s) => radius([`upperarm01.${s}`, `upperarm02.${s}`], H(`upperarm01.${s}`), H(`lowerarm01.${s}`)));
  const forearmRadius = avgSides((s) => radius([`lowerarm01.${s}`, `lowerarm02.${s}`], H(`lowerarm01.${s}`), H(`wrist.${s}`)));
  const thighRadius = avgSides((s) => radius([`upperleg01.${s}`, `upperleg02.${s}`], H(`upperleg01.${s}`), H(`lowerleg01.${s}`)));
  const shinRadius = avgSides((s) => radius([`lowerleg01.${s}`, `lowerleg02.${s}`], H(`lowerleg01.${s}`), H(`foot.${s}`)));
  const neckRadius = radius(['neck01', 'neck02', 'neck03'], H('neck01'), H('head'));
  const handLength = avgSides((s) => Math.hypot(...sub(Tl(`finger3-3.${s}`), H(`wrist.${s}`))));
  // Torso: depth of the chest ring and mean radius of the waist ring.
  const chestY = H('spine01')[1], waistY = H('spine04')[1];
  let cMinZ = Infinity, cMaxZ = -Infinity, wr = 0, wn = 0;
  const spineSet = new Set(['spine01', 'spine02', 'spine03', 'spine04', 'spine05', 'root'].map(bi));
  for (let v = 0; v < BODY; v++) {
    const y = pos[v * 3 + 1];
    if (!spineSet.has(as.skinIdx[v * 4])) continue;
    if (Math.abs(y - chestY) < 0.02 * sc && Math.abs(pos[v * 3]) < 0.12 * sc) { cMinZ = Math.min(cMinZ, pos[v * 3 + 2]); cMaxZ = Math.max(cMaxZ, pos[v * 3 + 2]); }
    if (Math.abs(y - waistY) < 0.02 * sc) { wr += Math.hypot(pos[v * 3], pos[v * 3 + 2] - H('spine04')[2]); wn++; }
  }
  const chestDepth = isFinite(cMaxZ) ? cMaxZ - cMinZ : 0.24 * sc;
  const waistRadius = wn ? wr / wn : 0.15 * sc;
  const shoulderWidth = Math.hypot(...sub(H('upperarm01.L'), H('upperarm01.R'))) + upperArmRadius * 1.6;
  const footLength = avgSides((s) => {
    const dir = norm([Tl(`toes.${s}`)[0] - H(`foot.${s}`)[0], 0, Tl(`toes.${s}`)[2] - H(`foot.${s}`)[2]]);
    const fb = new Set([bi(`foot.${s}`), bi(`toes.${s}`)]);
    let mn = Infinity, mx = -Infinity;
    for (let v = 0; v < BODY; v++) if (fb.has(as.skinIdx[v * 4])) {
      const d = pos[v * 3] * dir[0] + pos[v * 3 + 2] * dir[2];
      mn = Math.min(mn, d); mx = Math.max(mx, d);
    }
    return isFinite(mx) ? mx - mn : 0.26 * sc;
  });
  const fit: BodyFit = {
    height: top, headRadius, neckRadius, shoulderWidth, chestDepth, waistRadius, upperArmRadius, forearmRadius,
    handLength, thighRadius, shinRadius, footLength,
    earPoint: Math.max(0, app.face.earPoint) + shape.earTip * 0.5,
    hasHorns: app.horns.style !== 'none' && app.horns.size > 0.05,
  };

  // ---- sockets (rest pose)
  const sockets: Record<string, SocketFrame> = {};
  const put = (name: string, bone: string, p: V3, b: SocketFrame['basis']) => { sockets[name] = { bone: bi(bone), pos: p, basis: b }; };
  const bodyAligned = basis(null, BODY_FORWARD, BODY_LEFT);
  put('head', 'head', earMid, bodyAligned);
  put('neck', 'spine01', H('neck01'), bodyAligned);
  put('chest', 'spine01', H('spine01'), bodyAligned);
  put('spine', 'spine03', H('spine03'), bodyAligned);
  put('pelvis', 'root', mulS(add(H('upperleg01.L'), H('upperleg01.R')), 0.5), bodyAligned);
  put('back', 'spine01', add(H('spine01'), [0, 0, chestDepth * 0.5]), bodyAligned);
  for (const s of sides) {
    put(`shoulder.${s}`, `shoulder01.${s}`, H(`upperarm01.${s}`), bodyAligned);
    put(`hip.${s}`, 'root', H(`upperleg01.${s}`), bodyAligned);
    put(`upperarm.${s}`, `upperarm01.${s}`, H(`upperarm01.${s}`), basis(sub(H(`lowerarm01.${s}`), H(`upperarm01.${s}`)), BODY_FORWARD, BODY_LEFT));
    put(`forearm.${s}`, `lowerarm01.${s}`, H(`lowerarm01.${s}`), basis(sub(H(`wrist.${s}`), H(`lowerarm01.${s}`)), BODY_FORWARD, BODY_LEFT));
    put(`thigh.${s}`, `upperleg01.${s}`, H(`upperleg01.${s}`), basis(sub(H(`lowerleg01.${s}`), H(`upperleg01.${s}`)), BODY_FORWARD, BODY_LEFT));
    put(`shin.${s}`, `lowerleg01.${s}`, H(`lowerleg01.${s}`), basis(sub(H(`foot.${s}`), H(`lowerleg01.${s}`)), BODY_FORWARD, BODY_LEFT));
    put(`foot.${s}`, `foot.${s}`, H(`foot.${s}`), basis(sub(Tl(`toes.${s}`), H(`foot.${s}`)), UP, BODY_LEFT));
    // Hand: +Y toward the fingers, +Z dorsal, +X toward the thumb.
    const wrist = H(`wrist.${s}`);
    const fingerDir = norm(sub(H(`finger3-1.${s}`), wrist));
    const across = norm(sub(H(`finger2-1.${s}`), H(`finger5-1.${s}`))); // pinky → index (thumb side)
    const sgn = s === 'L' ? -1 : 1;
    const dorsal = norm(mulS(cross(fingerDir, across), sgn));
    put(`hand.${s}`, `wrist.${s}`, wrist, basis(fingerDir, dorsal, across));
    // Grip (internal, for held items): item +Y out of the thumb side of the fist,
    // item +Z (edge) along the knuckles, origin inside the closed fist.
    const gy = norm(sub(across, mulS(fingerDir, dot3(across, fingerDir))));
    const gz = fingerDir;
    const gx = cross(gy, gz);
    const palm = mulS(dorsal, -1);
    const gripPos = add(add(wrist, mulS(fingerDir, handLength * 0.42)), mulS(palm, forearmRadius * 0.55));
    sockets[`grip.${s}`] = { bone: bi(`wrist.${s}`), pos: gripPos, basis: [gx[0], gx[1], gx[2], gy[0], gy[1], gy[2], gz[0], gz[1], gz[2]] };
  }
  // Mouth (speech/eat FX) and tail root.
  const lip = targetMask(as, 'mouth-upperlip-volume-incr');
  let mx = 0, my = 0, mz = 0, mw = 0;
  for (let v = 0; v < BODY; v++) if (lip[v] > 0.4) { mx += pos[v * 3]; my += pos[v * 3 + 1]; mz += pos[v * 3 + 2]; mw++; }
  const mouth: V3 = mw ? [mx / mw, my / mw - 0.008 * sc, mz / mw] : add(H('jaw'), [0, 0, -0.08]);
  put('mouth', 'head', mouth, bodyAligned);
  put('tail', 'root', add(H('spine05'), [0, -0.03 * sc, waistRadius * 0.9]), bodyAligned);

  return {
    pos, normal, heads, tails, eyes, fit, sockets,
    headSphere: [earMid[0], earMid[1] + headRadius * 0.12, earMid[2] - headRadius * 0.08, headRadius],
    faceScale: ipd / (ipd0 || 1),
    height: top,
  };
}

/** Stable cache key of the parts of an appearance that affect the body mesh. */
export function bodyKey(a: HumanoidAppearance): string {
  const r = (v: number) => Math.round(v * 1000);
  return [
    a.race, a.race2 ?? '-', r(a.raceMix), a.seed, r(a.gender), r(a.age), r(a.muscle), r(a.weight), r(a.height), r(a.proportions),
    r(a.african), r(a.asian), r(a.caucasian), r(a.scale),
    ...Object.values(a.face).map(r), ...Object.values(a.body).map(r),
  ].join(',');
}
