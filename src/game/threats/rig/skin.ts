/**
 * The continuous skin of a segmented creature (THREATS_PLAN §4.3) — pure geometry, no three.js,
 * headless-testable. A creature is a few CLOSED surfaces that overlap where they meet, skinned to
 * the rig's bones (linear blend, ≤ 4 influences, weights summing to 1), so no pose can open a gap:
 *
 *  - the body: one tube lofted from the snout over the skull, the neck, the trunk and the tail to
 *    its tip (Catmull-Rom through the bind joints, cross-sections that change along it — a flat
 *    palate under the skull, brow ridges, shoulders and hips, a deep belly, a crest), weights
 *    blended across every joint;
 *  - the lower jaw, hinged under the skull (its back end tucked into the throat), teeth on both;
 *  - legs: thigh → knee → shin lofted from inside the trunk to the ankle, a columnar foot with
 *    toes and curved claws; eyes under the brow, horns at the back of the skull;
 *  - dorsal plates (jagged, thick in the middle, thin at the edge) in a staggered double row on
 *    the trunk and tail, a single row on the neck.
 *
 * Everything is built around the rig's BIND pose: `frames` (a bone's world frame there, 16 floats
 * column-major, X = Y × Z) and its joints. Bone 0 carries no geometry (the renderer passes per-
 * creature glow parameters through it). Per vertex: colour (dark hide, paler banded belly, mouth,
 * teeth, claws, bone-coloured plates), `glow` (plate mask, plate order tail → head, throat mask,
 * eye mask) and uv (square scales: around a tube a fixed number of tiles, along it by girth).
 */
import type { RigDef } from './CreatureRig';
import { lerp, saturate as clamp01, smoothstep as sstep, v3norm as norm, v3add as add, v3sub as sub, v3scale as mul, v3dot as dot, v3cross as cross, v3len as len, v3madd as madd, v3lerp as lerp3 } from '../../../core/math';

export type V3 = [number, number, number];

export interface BoneLayout {
  /** Bones in all (bone 0: parameters). */
  count: number;
  spine: number; neck: number; tail: number; head: number; jaw: number;
  /** Leg i: legs + 3i (upper), + 1 (lower), + 2 (foot). */
  legs: number;
}

export function boneLayout(def: RigDef): BoneLayout {
  let b = 1;
  const spine = b; b += def.spine.length;
  const neck = b; b += def.neck.length;
  const tail = b; b += def.tail.length;
  const head = b++;
  const jaw = b++;
  const legs = b; b += def.legs.length * 3;
  return { count: b, spine, neck, tail, head, jaw, legs };
}

/** The jaw's hinge in the head frame, as fractions of the head's height (down) and length (forward). */
export const JAW_HINGE = { down: 0.1, fwd: 0.06 };

export interface BindPose {
  /** 16 floats per bone (column-major, X = Y × Z), from CreatureRig.boneFrames. */
  frames: Float32Array;
  spine: Float64Array; neck: Float64Array; tail: Float64Array;
  legs: { hip: { x: number; y: number; z: number }; knee: { x: number; y: number; z: number }; ankle: { x: number; y: number; z: number } }[];
}

export interface SkinPart { name: string; v0: number; v1: number; i0: number; i1: number }

export interface SkinData {
  position: Float32Array; normal: Float32Array; uv: Float32Array; color: Float32Array;
  glow: Float32Array; skinIndex: Uint16Array; skinWeight: Float32Array; index: Uint32Array;
  /** Closed surfaces (vertex and index ranges): tests check each is watertight and outward. */
  parts: SkinPart[];
}

// ------------------------------------------------------------------ small vector helpers

const P = (o: { x: number; y: number; z: number }): V3 => [o.x, o.y, o.z];
const joint = (c: Float64Array, i: number): V3 => [c[i * 3], c[i * 3 + 1], c[i * 3 + 2]];

/** Piecewise-linear keyframes [[t, v], …] (smoothstepped between keys). */
function keys(k: [number, number][], t: number): number {
  if (t <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) if (t <= k[i][0]) return lerp(k[i - 1][1], k[i][1], sstep(k[i - 1][0], k[i][0], t));
  return k[k.length - 1][1];
}

/** Hash noise 0..1 on a lattice (baked colour mottling). */
function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}
/** Smooth value noise 0..1 (trilinear over hash3). */
function vnoise(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  let r = 0;
  for (let c = 0; c < 8; c++) {
    const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
    r += hash3(ix + dx, iy + dy, iz + dz) * (dx ? ux : 1 - ux) * (dy ? uy : 1 - uy) * (dz ? uz : 1 - uz);
  }
  return r;
}

interface Frame { o: V3; x: V3; y: V3; z: V3 }
function frameOf(F: Float32Array, b: number): Frame {
  const o = b * 16;
  return { x: [F[o], F[o + 1], F[o + 2]], y: [F[o + 4], F[o + 5], F[o + 6]], z: [F[o + 8], F[o + 9], F[o + 10]], o: [F[o + 12], F[o + 13], F[o + 14]] };
}
/** A frame-local point in world (bind) space. */
const toW = (f: Frame, l: V3): V3 => [
  f.o[0] + f.x[0] * l[0] + f.y[0] * l[1] + f.z[0] * l[2],
  f.o[1] + f.x[1] * l[0] + f.y[1] * l[1] + f.z[1] * l[2],
  f.o[2] + f.x[2] * l[0] + f.y[2] * l[1] + f.z[2] * l[2],
];
const dirW = (f: Frame, l: V3): V3 => [
  f.x[0] * l[0] + f.y[0] * l[1] + f.z[0] * l[2],
  f.x[1] * l[0] + f.y[1] * l[1] + f.z[1] * l[2],
  f.x[2] * l[0] + f.y[2] * l[1] + f.z[2] * l[2],
];

/** Catmull-Rom point and tangent on the segment p1 → p2. */
function cr(p0: V3, p1: V3, p2: V3, p3: V3, t: number): { p: V3; d: V3 } {
  const t2 = t * t, t3 = t2 * t;
  const p: V3 = [0, 0, 0], d: V3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    p[i] = 0.5 * (2 * p1[i] + (-p0[i] + p2[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3);
    d[i] = 0.5 * ((-p0[i] + p2[i]) + 2 * (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t + 3 * (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t2);
  }
  return { p, d };
}

// ------------------------------------------------------------------ colours (linear RGB)

const HIDE_D: V3 = [0.016, 0.019, 0.017], HIDE_S: V3 = [0.03, 0.031, 0.025], BELLY: V3 = [0.058, 0.054, 0.045];
const MOUTH: V3 = [0.035, 0.008, 0.008], TONGUE: V3 = [0.07, 0.018, 0.016], TOOTH: V3 = [0.42, 0.38, 0.3];
const CLAW: V3 = [0.022, 0.02, 0.018], BONE: V3 = [0.11, 0.1, 0.085], EYE: V3 = [0.9, 0.55, 0.12];

/** Scale-texture tiles round the body and round limbs (10 scales a tile). */
const SC_BODY = 15, SC_LIMB = 9;

export type Weights = number[]; // [bone, w, bone, w, …]
export type Glow = [number, number, number, number];
const NO_GLOW: Glow = [0, 0, 0, 0];

// ------------------------------------------------------------------ builder

/** Collects the skin's vertices, closed parts and triangles (the Burrower's skin builds with it too). */
export class Builder {
  pos: number[] = []; uv: number[] = []; col: number[] = []; glow: number[] = []; si: number[] = []; sw: number[] = []; idx: number[] = [];
  parts: SkinPart[] = [];
  private v0 = 0; private i0 = 0;

  begin(): void { this.v0 = this.pos.length / 3; this.i0 = this.idx.length; }
  end(name: string): void { this.parts.push({ name, v0: this.v0, v1: this.pos.length / 3, i0: this.i0, i1: this.idx.length }); }

  vert(p: V3, u: number, v: number, c: V3, g: Glow, w: Weights): number {
    const n = this.pos.length / 3;
    this.pos.push(p[0], p[1], p[2]);
    this.uv.push(u, v);
    this.col.push(c[0], c[1], c[2]);
    this.glow.push(g[0], g[1], g[2], g[3]);
    // Up to four influences, the strongest, normalised.
    const pairs: [number, number][] = [];
    for (let k = 0; k < w.length; k += 2) {
      if (!(w[k + 1] > 1e-4)) continue;
      const e = pairs.find((q) => q[0] === w[k]);
      if (e) e[1] += w[k + 1]; else pairs.push([w[k], w[k + 1]]);
    }
    pairs.sort((a, b) => b[1] - a[1]);
    pairs.length = Math.min(4, pairs.length);
    let s = 0;
    for (const q of pairs) s += q[1];
    for (let k = 0; k < 4; k++) {
      const q = pairs[k];
      this.si.push(q ? q[0] : 0);
      this.sw.push(q ? q[1] / s : 0);
    }
    return n;
  }

  tri(a: number, b: number, c: number): void { this.idx.push(a, b, c); }

  /**
   * A tube of rings (each `n` points round + a seam duplicate for the uv), triangles facing out,
   * closed at both ends by a fan to `capA` / `capB` (points beyond the first / last ring).
   */
  tube(rings: { pts: V3[]; u: number; vs: number[]; col: V3[]; glow: Glow[]; w: Weights }[], capA: { p: V3; col: V3; glow: Glow } | null, capB: { p: V3; col: V3; glow: Glow } | null): void {
    const n = rings[0].pts.length;
    const base: number[] = [];
    for (const r of rings) {
      base.push(this.pos.length / 3);
      for (let j = 0; j <= n; j++) this.vert(r.pts[j % n], r.u, r.vs[j], r.col[j % n], r.glow[j % n], r.w);
    }
    for (let k = 0; k + 1 < rings.length; k++) {
      const a = base[k], b = base[k + 1];
      for (let j = 0; j < n; j++) { this.tri(a + j, b + j, a + j + 1); this.tri(a + j + 1, b + j, b + j + 1); }
    }
    if (capA) {
      const r = rings[0], c = this.vert(capA.p, r.u, 0, capA.col, capA.glow, r.w);
      for (let j = 0; j < n; j++) this.tri(c, base[0] + j, base[0] + j + 1);
    }
    if (capB) {
      const k = rings.length - 1, r = rings[k], c = this.vert(capB.p, r.u, 0, capB.col, capB.glow, r.w);
      for (let j = 0; j < n; j++) this.tri(c, base[k] + j + 1, base[k] + j);
    }
  }

  /** Smooth normals: area-weighted per closed part, equal positions in a part share one (seams, caps). */
  normals(): Float32Array {
    const P = this.pos, I = this.idx, N = new Float32Array(P.length);
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const e1: V3 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], e2: V3 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
      const f = cross(e1, e2);
      for (const v of [a, b, c]) { N[v] += f[0]; N[v + 1] += f[1]; N[v + 2] += f[2]; }
    }
    for (const part of this.parts) {
      const groups = new Map<string, number[]>();
      for (let v = part.v0; v < part.v1; v++) {
        const key = `${Math.round(P[v * 3] * 1e4)},${Math.round(P[v * 3 + 1] * 1e4)},${Math.round(P[v * 3 + 2] * 1e4)}`;
        const g = groups.get(key);
        if (g) g.push(v); else groups.set(key, [v]);
      }
      for (const g of groups.values()) {
        if (g.length < 2) continue;
        let x = 0, y = 0, z = 0;
        for (const v of g) { x += N[v * 3]; y += N[v * 3 + 1]; z += N[v * 3 + 2]; }
        for (const v of g) { N[v * 3] = x; N[v * 3 + 1] = y; N[v * 3 + 2] = z; }
      }
    }
    for (let v = 0; v < N.length; v += 3) {
      const l = Math.hypot(N[v], N[v + 1], N[v + 2]) || 1;
      N[v] /= l; N[v + 1] /= l; N[v + 2] /= l;
    }
    return N;
  }
}

// ------------------------------------------------------------------ cross-sections

/** A cross-section: half width, height above / depth below the centre, superellipse exponents, crest. */
interface Section { w: number; ht: number; hb: number; nt: number; nb: number; crest: number; brow: number }

/**
 * Offset (side, up) of the section's outline at angle θ (0 on top, π/2 on the right, π underneath).
 * Flatter (bigger exponent) below for a palate or a belly, a dorsal crest, brow ridges.
 */
function outline(s: Section, th: number): [number, number] {
  const sn = Math.sin(th), cs = Math.cos(th);
  const n = cs >= 0 ? s.nt : s.nb;
  let x = s.w * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / n);
  let y = (cs >= 0 ? s.ht : s.hb) * Math.sign(cs) * Math.pow(Math.abs(cs), 2 / n);
  const tw = Math.atan2(sn, cs); // −π..π
  if (s.crest) y += s.crest * Math.exp(-((tw / 0.2) ** 2));
  if (s.brow) {
    const b = s.brow * Math.exp(-(((Math.abs(tw) - 0.27 * Math.PI) / (0.13 * Math.PI)) ** 2));
    y += b * 0.8; x += Math.sign(sn) * b * 0.5;
  }
  return [x, y];
}

/** Ellipse perimeter (Ramanujan) of a section: scales stay square along a tube. */
function girth(s: Section): number {
  const a = s.w, b = (s.ht + s.hb) / 2;
  const h = ((a - b) / (a + b)) ** 2;
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

// ------------------------------------------------------------------ the creature

export function buildCreatureSkin(def: RigDef, L: BoneLayout, bind: BindPose): SkinData {
  const B = new Builder();
  const F = bind.frames;
  const fr = (b: number) => frameOf(F, b);
  const nS = def.spine.length, nN = def.neck.length, nT = def.tail.length;
  const head = fr(L.head);
  const H = def.head, J = def.jaw;
  const NB = 40; // points round the body

  // ---- the body path: snout → skull back → neck joints → trunk → tail tip; a bone per span.
  const nodes: V3[] = [toW(head, [0, 0, H.len]), [...head.o] as V3];
  const spanBone: number[] = [L.head];
  for (let i = nN - 1; i >= 0; i--) { nodes.push(joint(bind.neck, i)); spanBone.push(L.neck + i); }
  for (let i = 1; i <= nS; i++) { nodes.push(joint(bind.spine, i)); spanBone.push(L.spine + i - 1); }
  for (let i = 1; i <= nT; i++) { nodes.push(joint(bind.tail, i)); spanBone.push(L.tail + i - 1); }
  const spans = spanBone.length;
  // Region per span: 0 head, 1 neck, 2 trunk, 3 tail; the radius at every node.
  const region = (k: number) => (k === 0 ? 0 : k <= nN ? 1 : k <= nN + nS ? 2 : 3);
  const nodeR: number[] = [0, def.neckR[nN - 1]];
  for (let i = nN - 1; i >= 1; i--) nodeR.push((def.neckR[i] + def.neckR[i - 1]) / 2);
  nodeR.push((def.neckR[0] + def.spineR[0]) / 2);
  for (let i = 1; i < nS; i++) nodeR.push((def.spineR[i - 1] + def.spineR[i]) / 2);
  nodeR.push((def.spineR[nS - 1] + def.tailR[0]) / 2);
  for (let i = 1; i < nT; i++) nodeR.push((def.tailR[i - 1] + def.tailR[i]) / 2);
  nodeR.push(def.tailR[nT - 1] * 0.35);
  // Where the legs join the trunk (shoulders, hips): distance along the path from each.
  const spanLen = spanBone.map((_, k) => len(sub(nodes[k + 1], nodes[k])));
  const along: number[] = [0];
  for (let k = 0; k < spans; k++) along.push(along[k] + spanLen[k]);
  const shoulderS = along[1 + nN + 1], hipS = along[1 + nN + nS];

  /** Skin weights at span k, fraction u: the span's bone, blended half-and-half at each joint. */
  const spanWeights = (k: number, u: number): Weights => {
    const bw = k === 0 ? 0.12 : Math.min(0.4, 3 / spanLen[k]);
    const wp = k === 0 ? 0 : 0.5 * (1 - sstep(0, bw, u));
    const wn = k === 0 ? 0.5 * sstep(1 - bw, 1, u) : k + 1 < spans ? 0.5 * sstep(1 - Math.min(0.4, 3 / spanLen[k]), 1, u) : 0;
    const w: Weights = [spanBone[k], 1 - wp - wn];
    if (wp > 0) w.push(spanBone[k - 1], wp);
    if (wn > 0) w.push(spanBone[k + 1], wn);
    return w;
  };
  /** The dorsal direction a bone gives its skin: segments their Z (up the back), the head its Y. */
  const dorsalOf = (b: number): V3 => (b === L.head ? head.y : fr(b).z);

  /** The body's section at span k, fraction u (and its global position along the path). */
  const neckSec = (R: number): Section => ({ w: R, ht: R, hb: R * 1.1, nt: 2.2, nb: 2.2, crest: R * 0.05, brow: 0 });
  const bodySec = (k: number, u: number, s: number): Section => {
    const reg = region(k);
    if (reg === 0) return headSec(1 - u);
    const R = lerp(nodeR[k], nodeR[k + 1], sstep(0, 1, u));
    // Continuous region weights (neck → trunk → tail).
    const c = k - 1 + u; // 0 at the skull back
    const wTrunk = sstep(nN - 0.6, nN + 0.4, c) * (1 - sstep(nN + nS - 0.3, nN + nS + 0.5, c));
    const wTail = sstep(nN + nS - 0.3, nN + nS + 0.5, c);
    const wNeck = 1 - wTrunk - wTail;
    const bulge = 0.12 * Math.exp(-(((s - shoulderS) / 5) ** 2)) + 0.1 * Math.exp(-(((s - hipS) / 6) ** 2));
    const mix = (n: number, t: number, l: number) => n * wNeck + t * wTrunk + l * wTail;
    return {
      w: R * (mix(1.0, 1.1, 0.95) + bulge), ht: R * mix(1.0, 0.95, 1.05), hb: R * (mix(1.1, 1.14, 1.0) + bulge * 0.4),
      nt: mix(2.2, 2.3, 2.1), nb: mix(2.2, 2.6, 2.1), crest: R * mix(0.05, 0.05, 0.1), brow: 0,
    };
  };
  /** The skull at k (0 back of the skull … 1 snout): flat palate below, brow ridges, cheeks. */
  const rN = nodeR[1], hw = H.w / 2, hh = H.h / 2;
  const n0 = neckSec(rN);
  function headSec(k: number): Section {
    const w = keys([[0, n0.w], [0.18, hw * 0.94], [0.3, hw], [0.5, hw * 0.9], [0.75, hw * 0.7], [0.9, hw * 0.55], [1, hw * 0.42]], k);
    const ht = keys([[0, n0.ht], [0.15, hh * 0.9], [0.35, hh * 0.86], [0.55, hh * 0.7], [0.8, hh * 0.55], [1, hh * 0.4]], k);
    const hb = keys([[0, n0.hb], [0.1, n0.hb * 0.95], [0.22, hh * 0.4], [0.3, hh * 0.25], [1, hh * 0.2]], k);
    const tip = k > 0.86 ? Math.sqrt(Math.max(0.02, 1 - ((k - 0.86) / 0.145) ** 2)) : 1;
    return { w: w * tip, ht: ht * tip, hb: hb * tip, nt: 2.4, nb: lerp(2.2, 5, sstep(0.14, 0.3, k)), crest: lerp(n0.crest, 0, sstep(0, 0.2, k)), brow: 0.42 * hh * Math.exp(-(((k - 0.37) / 0.09) ** 2)) };
  }

  // ---- the body tube
  const rings: Parameters<Builder['tube']>[0] = [];
  let uAcc = 0, lastS = 0;
  for (let k = 0; k < spans; k++) {
    const p0 = nodes[Math.max(0, k - 1)], p1 = nodes[k], p2 = nodes[k + 1], p3 = nodes[Math.min(nodes.length - 1, k + 2)];
    const step = k === 0 ? 0.55 : region(k) === 3 ? 0.9 : 1.0;
    const m = Math.max(2, Math.ceil(spanLen[k] / step));
    for (let q = 0; q < m || (k === spans - 1 && q === m); q++) {
      let u = q / m;
      if (k === 0 && q === 0) u = 0.012; // the snout tip itself is the cap
      if (k === spans - 1 && q === m) u = 0.985;
      const { p, d } = cr(p0, p1, p2, p3, u);
      const T = norm(d);
      const s = along[k] + spanLen[k] * u;
      const w = spanWeights(k, u);
      let D: V3 = [0, 0, 0];
      for (let i = 0; i < w.length; i += 2) D = madd(D, dorsalOf(w[i]), w[i + 1]);
      D = norm(madd(D, T, -dot(D, T)));
      const S = cross(D, T);
      const sec = bodySec(k, u, s);
      uAcc += ((s - lastS) * SC_BODY) / girth(sec);
      lastS = s;
      const kh = k === 0 ? 1 - u : -1; // position along the skull (head span only)
      const throatW = k === 0 ? 1 - sstep(0.18, 0.32, kh) : k === 1 ? sstep(0.2, 1, u) : 0;
      const pts: V3[] = [], vs: number[] = [], col: V3[] = [], glow: Glow[] = [];
      for (let j = 0; j <= NB; j++) {
        const th = (j / NB) * Math.PI * 2;
        vs.push((j / NB) * SC_BODY);
        if (j === NB) continue;
        const [x, y] = outline(sec, th);
        const pt = add(p, add(mul(S, x), mul(D, y)));
        pts.push(pt);
        const tw = Math.abs(Math.atan2(Math.sin(th), Math.cos(th)));
        const belly = sstep(0.56 * Math.PI, 0.8 * Math.PI, tw);
        const dors = 1 - sstep(0.1 * Math.PI, 0.5 * Math.PI, tw);
        const mott = 0.78 + 0.44 * vnoise(pt[0] * 0.35, pt[1] * 0.35, pt[2] * 0.35);
        const bands = 0.86 + 0.14 * sstep(-0.35, 0.35, Math.sin((s * Math.PI * 2) / 1.25));
        let c: V3 = lerp3(lerp3(HIDE_S, HIDE_D, dors), mul(BELLY, bands), belly * (region(k) === 0 ? 0.6 : 1));
        c = mul(c, mott);
        let g: Glow = NO_GLOW;
        if (k === 0 && kh > 0.12 && tw > 0.66 * Math.PI) {
          // Under the skull: the palate and the back of the mouth (dark, lit from within when charging).
          c = MOUTH;
          g = [0, 0, 0.4 * (1 - sstep(0.3, 0.9, kh)), 0];
        } else if (throatW > 0) g = [0, 0, sstep(0.72 * Math.PI, 0.95 * Math.PI, tw) * throatW * (0.6 + 0.4 * vnoise(pt[0] * 0.8, pt[1] * 0.8, pt[2] * 0.8)), 0];
        col.push(c);
        glow.push(g);
      }
      rings.push({ pts, u: uAcc, vs, col, glow, w });
    }
  }
  const snout = madd(toW(head, [0, -hh * 0.05, H.len]), head.z, 0.15);
  const tipDir = norm(sub(nodes[nodes.length - 1], nodes[nodes.length - 2]));
  B.begin();
  B.tube(rings, { p: snout, col: HIDE_S, glow: NO_GLOW }, { p: madd(joint(bind.tail, nT), tipDir, 0.25), col: HIDE_D, glow: NO_GLOW });
  B.end('body');

  /** Which span of the body path (and where on it) a chain's segment fraction is (for plates). */
  const spanAt = (chain: 'spine' | 'neck' | 'tail', seg: number, t: number): { k: number; u: number } =>
    chain === 'neck' ? { k: 1 + (nN - 1 - seg), u: 1 - t } : chain === 'spine' ? { k: 1 + nN + seg, u: t } : { k: 1 + nN + nS + seg, u: t };

  // ---- lower jaw: in the head frame, hinged under the skull's back; tucked into the throat.
  {
    const hingeZ = JAW_HINGE.fwd * H.len;
    const z0 = hingeZ - 0.12 * H.len, z1 = 0.95 * H.len;
    const jw = J.w / 2, jd = J.h / 3.2;
    const NJ = 28;
    const jr: Parameters<Builder['tube']>[0] = [];
    const m = 26;
    let u = 0;
    for (let q = 0; q <= m; q++) {
      const kj = q / m, z = lerp(z0, z1, kj), ks = Math.max(0, z / H.len);
      const sk = headSec(ks);
      // The mouth floor just under the palate (and no higher than the palate's level further back).
      const yTop = Math.min(-hh * 0.2 - 0.04, -sk.hb - 0.04);
      const depth = jd * keys([[0, 2.2], [0.15, 2.5], [0.35, 2.3], [0.65, 1.65], [0.88, 1.05], [1, 0.45]], kj);
      const tip = kj > 0.9 ? Math.sqrt(Math.max(0.04, 1 - ((kj - 0.9) / 0.105) ** 2)) : 1;
      const w = Math.min(sk.w * 0.95, jw * 1.25) * tip;
      const sec: Section = { w, ht: 0.12 * tip, hb: Math.max(0.15, depth - 0.12) * tip, nt: 6, nb: 2.3, crest: 0, brow: 0 };
      const cY = yTop - 0.12;
      u += (((z1 - z0) / m) * SC_LIMB) / girth(sec);
      const pts: V3[] = [], vs: number[] = [], col: V3[] = [], glow: Glow[] = [];
      for (let j = 0; j <= NJ; j++) {
        const th = (j / NJ) * Math.PI * 2;
        vs.push((j / NJ) * SC_LIMB);
        if (j === NJ) continue;
        const [x, y] = outline(sec, th);
        pts.push(toW(head, [x, cY + y, z]));
        const tw = Math.abs(Math.atan2(Math.sin(th), Math.cos(th)));
        if (tw < 0.42 * Math.PI) {
          // The mouth floor and the tongue down its middle.
          col.push(lerp3(MOUTH, TONGUE, 1 - sstep(0.05, 0.25, tw / Math.PI)));
          glow.push([0, 0, 0.35 * (1 - kj * 0.7), 0]);
        } else {
          const belly = sstep(0.6 * Math.PI, 0.9 * Math.PI, tw);
          col.push(mul(lerp3(HIDE_S, BELLY, belly * 0.55), 0.85 + 0.3 * hash3(q, j, 7)));
          glow.push([0, 0, belly * 0.5 * (1 - sstep(0.05, 0.25, kj)), 0]);
        }
      }
      jr.push({ pts, u, vs, col, glow, w: [L.jaw, 1] });
    }
    B.begin();
    B.tube(jr, { p: toW(head, [0, -hh * 0.6, z0 - 0.3]), col: HIDE_S, glow: NO_GLOW }, { p: toW(head, [0, -hh * 0.35, z1 + 0.2]), col: HIDE_S, glow: NO_GLOW });
    B.end('jaw');
    // Teeth: upper ones along the palate's edge pointing down, lower ones on the jaw pointing up.
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 9; i++) {
        const kt = 0.33 + i * 0.075, sk = headSec(kt);
        const sz = (0.5 + 0.5 * Math.sin(Math.PI * (i + 1) / 10)) * hh * 0.3;
        const x = side * (sk.w * 0.86), y = -sk.hb, z = kt * H.len;
        cone(B, toW(head, [x, y + 0.15, z]), dirW(head, [side * -0.08, -1, 0.12]), sz * 0.24, sz, 6, TOOTH, [L.head, 1], 'tooth');
        const kl = kt + 0.037;
        if (kl > 0.92) continue;
        const sl = headSec(kl), zl = kl * H.len;
        cone(B, toW(head, [side * Math.min(sl.w * 0.95, jw * 1.25) * 0.8, -sl.hb - 0.2, zl]), dirW(head, [side * -0.06, 1, 0.1]), sz * 0.2, sz * 0.8, 6, TOOTH, [L.jaw, 1], 'tooth');
      }
    }
  }

  // ---- eyes under the brow, horns at the back of the skull
  for (let side = -1; side <= 1; side += 2) {
    const ke = 0.38, sk = headSec(ke);
    const [ex, ey] = outline(sk, side * 0.36 * Math.PI);
    const re = hh * 0.16;
    sphere(B, toW(head, [ex * 0.93, ey * 0.93, ke * H.len]), re, EYE, [0, 0, 0, 1], [L.head, 1]);
    const kh = 0.1, sh = headSec(kh);
    const [hx, hy] = outline(sh, side * 0.2 * Math.PI);
    const hdir = norm(dirW(head, [side * 0.35, 0.55, -1]));
    horn(B, toW(head, [hx * 0.85, hy * 0.85, kh * H.len]), hdir, dirW(head, [0, 1, 0]), hh * 0.24, H.len * 0.46, [L.head, 1]);
  }

  // ---- legs: from inside the trunk to the ankle; a columnar foot with toes and claws.
  def.legs.forEach((d, li) => {
    const lb = L.legs + li * 3;
    const bl = bind.legs[li];
    const hip = P(bl.hip), knee = P(bl.knee), ankle = P(bl.ankle);
    const up = norm(sub(knee, hip));
    const top = madd(hip, up, -d.r[0] * 1.1);
    const body = d.at === 'front' ? L.spine + 1 : L.spine + nS - 1;
    const ln = [top, hip, knee, ankle];
    const segL = [len(sub(hip, top)), len(sub(knee, hip)), len(sub(ankle, knee))];
    const fUp = fr(lb), fLo = fr(lb + 1);
    const NL = 24;
    const lr: Parameters<Builder['tube']>[0] = [];
    let u = 0;
    const r0 = d.r[0], r1 = d.r[1], r2 = d.r[2];
    const kneeFront = d.knee > 0 ? 1 : -1;
    for (let k = 0; k < 3; k++) {
      const m = k === 0 ? 3 : Math.max(5, Math.ceil(segL[k] / 0.9));
      for (let q = 0; q < m || (k === 2 && q === m); q++) {
        const t = q / m;
        const { p, d: dd } = cr(ln[Math.max(0, k - 1)], ln[k], ln[k + 1], ln[Math.min(3, k + 2)], t);
        const T = norm(dd);
        const g = k + t; // 0 top, 1 hip, 2 knee, 3 ankle
        const R = keys([[0, r0 * 1.12], [1, r0 * 1.15], [1.5, r0 * 1.05], [2, r1 * 1.02], [2.45, r1 * 1.1], [3, r2 * 1.15]], g);
        const deep = keys([[0, 1.1], [1.5, 1.14], [2, 1.0], [3, 1.02]], g);
        // Weights: the trunk at the top, the thigh, a blend over the knee, the shin.
        let w: Weights;
        if (g < 1) w = [lb, 0.5 + 0.5 * g, body, 0.5 - 0.5 * g];
        else if (g < 1.7) w = [lb, 1];
        else if (g < 2.3) { const b = sstep(1.7, 2.3, g); w = [lb, 1 - b, lb + 1, b]; }
        else w = [lb + 1, 1];
        let D: V3 = madd(mul(fUp.z, 1 - sstep(1.7, 2.3, g)), fLo.z, sstep(1.7, 2.3, g));
        D = norm(madd(D, T, -dot(D, T)));
        const S = cross(D, T);
        const sec: Section = { w: R, ht: R * deep, hb: R * deep, nt: 2.2, nb: 2.2, crest: 0, brow: 0 };
        // The kneecap (forward on hind legs, the elbow back on forelegs).
        const kb = 0.16 * r1 * Math.exp(-(((g - 2) / 0.18) ** 2));
        u += (segL[k] / m) * SC_LIMB / girth(sec);
        const pts: V3[] = [], vs: number[] = [], col: V3[] = [], glow: Glow[] = [];
        for (let j = 0; j <= NL; j++) {
          const th = (j / NL) * Math.PI * 2;
          vs.push((j / NL) * SC_LIMB);
          if (j === NL) continue;
          let [x, y] = outline(sec, th);
          const front = Math.cos(th) * kneeFront;
          if (front > 0) y += Math.sign(y) * kb * front * front;
          const pt = add(p, add(mul(S, x), mul(D, y)));
          pts.push(pt);
          col.push(mul(lerp3(HIDE_S, HIDE_D, 0.4), 0.8 + 0.4 * vnoise(pt[0] * 0.4, pt[1] * 0.4, pt[2] * 0.4)));
          glow.push(NO_GLOW);
        }
        lr.push({ pts, u, vs, col, glow, w });
      }
    }
    B.begin();
    B.tube(lr, { p: madd(top, up, -0.3), col: HIDE_S, glow: NO_GLOW }, { p: madd(ankle, norm(sub(ankle, knee)), 0.3), col: HIDE_S, glow: NO_GLOW });
    B.end('leg');
    foot(B, fr(lb + 2), ankle, d.foot, r2, lb, li);
  });

  // ---- dorsal plates
  {
    const list: { at: V3; T: V3; D: V3; S: V3; h: number; len: number; w: Weights; ord: number; tilt: number }[] = [];
    for (const pd of def.plates) {
      const c = pd.chain === 'spine' ? bind.spine : pd.chain === 'neck' ? bind.neck : bind.tail;
      const R = (pd.chain === 'spine' ? def.spineR : pd.chain === 'neck' ? def.neckR : def.tailR)[pd.seg];
      const a = joint(c, pd.seg), b = joint(c, pd.seg + 1);
      const rows = pd.chain === 'neck' ? [0] : [-1, 1];
      for (const side of rows) {
        const dt = side * 0.16 * (pd.len / Math.max(1e-3, len(sub(b, a))));
        const tt = Math.min(1, Math.max(0, pd.t + dt));
        const at0 = lerp3(a, b, tt);
        let T = norm(sub(b, a));
        if (pd.chain === 'neck') T = mul(T, -1);
        const at1 = spanAt(pd.chain, pd.seg, tt);
        const w = spanWeights(at1.k, at1.u);
        let D: V3 = [0, 0, 0];
        for (let i = 0; i < w.length; i += 2) D = madd(D, dorsalOf(w[i]), w[i + 1]);
        D = norm(madd(D, T, -dot(D, T)));
        const S = cross(D, T);
        const lat = side * R * 0.2;
        const at = add(at0, add(mul(D, R * 0.78), mul(S, lat)));
        const sc = rows.length > 1 ? 0.92 : 1;
        list.push({ at, T, D, S, h: pd.h * sc, len: pd.len * sc, w, ord: 0, tilt: side * 0.14 });
      }
    }
    // Glow order: from the tail (0) to the head (1), by position along the body.
    const head0 = head.o;
    const dist = list.map((p) => len(sub(p.at, head0)));
    const dMax = Math.max(...dist), dMin = Math.min(...dist);
    list.forEach((p, i) => { p.ord = 1 - (dist[i] - dMin) / Math.max(1e-3, dMax - dMin); });
    for (const p of list) plate(B, p);
  }

  const normal = B.normals();
  return {
    position: Float32Array.from(B.pos), normal, uv: Float32Array.from(B.uv), color: Float32Array.from(B.col), glow: Float32Array.from(B.glow),
    skinIndex: Uint16Array.from(B.si), skinWeight: Float32Array.from(B.sw), index: Uint32Array.from(B.idx), parts: B.parts,
  };
}

// ------------------------------------------------------------------ parts

/** A closed cone (base cap inside whatever it grows from). */
function cone(B: Builder, base: V3, dir: V3, r: number, h: number, n: number, c: V3, w: Weights, name: string): void {
  const T = norm(dir);
  const hint: V3 = Math.abs(T[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const D = norm(madd(hint, T, -dot(hint, T)));
  const S = cross(D, T);
  const ring = (at: V3, rr: number) => {
    const pts: V3[] = [], vs: number[] = [], col: V3[] = [], glow: Glow[] = [];
    for (let j = 0; j <= n; j++) {
      vs.push(j / n);
      if (j === n) continue;
      const a = (j / n) * Math.PI * 2;
      pts.push(add(at, add(mul(S, Math.sin(a) * rr), mul(D, Math.cos(a) * rr))));
      col.push(c); glow.push(NO_GLOW);
    }
    return { pts, vs, col, glow };
  };
  const r0 = ring(base, r), r1 = ring(madd(base, T, h * 0.45), r * 0.62);
  B.begin();
  B.tube([{ ...r0, u: 0, w }, { ...r1, u: 0.5, w }], { p: madd(base, T, -r * 0.3), col: c, glow: NO_GLOW }, { p: madd(base, T, h), col: c, glow: NO_GLOW });
  B.end(name);
}

/** A curved horn: sweeps back along `dir`, curling towards `curl`. */
function horn(B: Builder, base: V3, dir: V3, curl: V3, r: number, h: number, w: Weights): void {
  const n = 10, m = 8;
  const rings: Parameters<Builder['tube']>[0] = [];
  const pathAt = (t: number): V3 => madd(madd(base, dir, h * t), curl, h * 0.18 * t * t);
  for (let q = 0; q <= m; q++) {
    const t = q / m * 0.94;
    const p = pathAt(t), T = norm(sub(pathAt(t + 0.01), p));
    const D = norm(madd(curl, T, -dot(curl, T)));
    const S = cross(D, T);
    const rr = r * (1 - t) ** 0.8;
    const pts: V3[] = [], vs: number[] = [], col: V3[] = [], glow: Glow[] = [];
    for (let j = 0; j <= n; j++) {
      vs.push((j / n) * 2);
      if (j === n) continue;
      const a = (j / n) * Math.PI * 2;
      pts.push(add(p, add(mul(S, Math.sin(a) * rr), mul(D, Math.cos(a) * rr))));
      col.push(lerp3(HIDE_D, BONE, t)); glow.push(NO_GLOW);
    }
    rings.push({ pts, u: t * 4, vs, col, glow, w });
  }
  B.begin();
  B.tube(rings, { p: madd(base, dir, -r * 0.5), col: HIDE_D, glow: NO_GLOW }, { p: pathAt(1), col: BONE, glow: NO_GLOW });
  B.end('horn');
}

/** A closed uv sphere (an eye). */
function sphere(B: Builder, c: V3, r: number, col: V3, g: Glow, w: Weights): void {
  const n = 12, m = 8;
  const rings: Parameters<Builder['tube']>[0] = [];
  for (let q = 1; q < m; q++) {
    const phi = (q / m) * Math.PI;
    const pts: V3[] = [], vs: number[] = [], cs: V3[] = [], gs: Glow[] = [];
    for (let j = 0; j <= n; j++) {
      vs.push(j / n);
      if (j === n) continue;
      const a = (j / n) * Math.PI * 2;
      // Rings from +Y down to −Y; seen from +Y the angle runs clockwise, so faces point out.
      pts.push([c[0] + Math.sin(phi) * Math.sin(a) * r, c[1] + Math.cos(phi) * r, c[2] + Math.sin(phi) * Math.cos(a) * r]);
      cs.push(col); gs.push(g);
    }
    rings.push({ pts, u: q / m, vs, col: cs, glow: gs, w });
  }
  B.begin();
  B.tube(rings, { p: [c[0], c[1] + r, c[2]], col, glow: g }, { p: [c[0], c[1] - r, c[2]], col, glow: g });
  B.end('eye');
}

/**
 * A foot in its bone's frame (origin on the ground under the heel, Y up, Z towards the toes): a
 * flared column from above the ankle down to a flat sole, four toes ending in curved claws.
 */
function foot(B: Builder, f: Frame, ankleW: V3, fl: number, r2: number, lb: number, li: number): void {
  // The ankle in the foot's frame (the column stands under it).
  const rel = sub(ankleW, f.o);
  const ax = dot(rel, f.x), az = dot(rel, f.z);
  const cx = ax, cz = az + fl * 0.04;
  const n = 26;
  const levels: [number, number, number][] = [[0.02, 1.36, 1.5], [0.22, 1.46, 1.62], [0.6, 1.38, 1.5], [1.0, 1.22, 1.3], [1.45, 1.12, 1.14], [1.85, 1.08, 1.08]];
  const rings: Parameters<Builder['tube']>[0] = [];
  // Built from the top down (Y up, rings going down: the tube's "T" is −Y).
  for (let q = levels.length - 1; q >= 0; q--) {
    const [yy, rx, rz] = levels[q];
    const y = yy * r2;
    const w: Weights = yy > 1.2 ? [lb + 2, 0.5 + 0.5 * (1.85 - yy) / 0.65, lb + 1, 0.5 - 0.5 * (1.85 - yy) / 0.65] : [lb + 2, 1];
    const pts: V3[] = [], vs: number[] = [], col: V3[] = [], glow: Glow[] = [];
    for (let j = 0; j <= n; j++) {
      vs.push((j / n) * 6);
      if (j === n) continue;
      const a = (j / n) * Math.PI * 2;
      // T = −Y, D = +Z (front), S = D × T = +X … the outline: S·sin, D·cos.
      const front = Math.cos(a) > 0 ? 1.08 : 1;
      const p = toW(f, [cx + Math.sin(a) * rx * r2, y, cz + Math.cos(a) * rz * r2 * front]);
      pts.push(p);
      col.push(mul(lerp3(HIDE_S, HIDE_D, 0.5), 0.75 + 0.5 * hash3(q, j, li)));
      glow.push(NO_GLOW);
    }
    rings.push({ pts, u: (1.85 - yy) * 1.5, vs, col, glow, w });
  }
  B.begin();
  B.tube(rings, { p: toW(f, [cx, 2.05 * r2, cz]), col: HIDE_S, glow: NO_GLOW }, { p: toW(f, [cx, 0, cz]), col: HIDE_D, glow: NO_GLOW });
  B.end('foot');
  // Toes and claws.
  const spread = [-0.62, -0.2, 0.2, 0.62];
  spread.forEach((phi, ti) => {
    const outer = ti === 0 || ti === 3;
    const tl = fl * (outer ? 0.24 : 0.3), tr = r2 * (outer ? 0.32 : 0.38);
    const dir: V3 = [Math.sin(phi), -0.18, Math.cos(phi)];
    const b0: V3 = [cx + Math.sin(phi) * 1.0 * r2, 0.42 * r2, cz + Math.cos(phi) * 1.1 * r2];
    const rings2: Parameters<Builder['tube']>[0] = [];
    const nt = 10, m = 5;
    const dn = norm(dir);
    const hint: V3 = [0, 1, 0];
    const D = norm(madd(hint, dn, -dot(hint, dn)));
    const S = cross(D, dn);
    for (let q = 0; q <= m; q++) {
      const t = q / m;
      const c = madd(b0, dn, tl * t);
      const rr = tr * (1 - 0.35 * t);
      const pts: V3[] = [], vs: number[] = [], col: V3[] = [], glow: Glow[] = [];
      for (let j = 0; j <= nt; j++) {
        vs.push((j / nt) * 2);
        if (j === nt) continue;
        const a = (j / nt) * Math.PI * 2;
        pts.push(toW(f, add(c, add(mul(S, Math.sin(a) * rr), mul(D, Math.cos(a) * rr * 0.8)))));
        col.push(mul(HIDE_S, 0.8 + 0.3 * hash3(ti, j, q)));
        glow.push(NO_GLOW);
      }
      rings2.push({ pts, u: t * 2, vs, col, glow, w: [lb + 2, 1] });
    }
    const end = madd(b0, dn, tl);
    B.begin();
    B.tube(rings2, { p: toW(f, madd(b0, dn, -tr)), col: HIDE_S, glow: NO_GLOW }, { p: toW(f, madd(end, dn, tr * 0.4)), col: HIDE_S, glow: NO_GLOW });
    B.end('toe');
    // The claw: from the toe's tip, forward and down to the ground, a curved tapering hook.
    const cl = fl * (outer ? 0.16 : 0.2), cr0 = tr * 0.62;
    const tipL: V3 = [end[0] + Math.sin(phi) * cl, 0.03 * r2, end[2] + Math.cos(phi) * cl];
    const start = madd(end, dn, -tr * 0.2);
    const mid: V3 = [lerp(start[0], tipL[0], 0.55), start[1] + cl * 0.12, lerp(start[2], tipL[2], 0.55)];
    const crings: Parameters<Builder['tube']>[0] = [];
    const nc = 8, mc = 6;
    const at = (t: number): V3 => { const a = lerp3(start, mid, t), b = lerp3(mid, tipL, t); return lerp3(a, b, t); };
    for (let q = 0; q <= mc; q++) {
      const t = (q / mc) * 0.93;
      const c = at(t), T = norm(sub(at(t + 0.01), c));
      const Dc = norm(madd([0, 1, 0], T, -dot([0, 1, 0], T)));
      const Sc = cross(Dc, T);
      const rr = cr0 * (1 - t) ** 0.75;
      const pts: V3[] = [], vs: number[] = [], col: V3[] = [], glow: Glow[] = [];
      for (let j = 0; j <= nc; j++) {
        vs.push(j / nc);
        if (j === nc) continue;
        const a = (j / nc) * Math.PI * 2;
        pts.push(toW(f, add(c, add(mul(Sc, Math.sin(a) * rr * 0.75), mul(Dc, Math.cos(a) * rr)))));
        col.push(CLAW); glow.push(NO_GLOW);
      }
      crings.push({ pts, u: t, vs, col, glow, w: [lb + 2, 1] });
    }
    B.begin();
    B.tube(crings, { p: toW(f, madd(start, dn, -cr0)), col: CLAW, glow: NO_GLOW }, { p: toW(f, at(1)), col: CLAW, glow: NO_GLOW });
    B.end('claw');
  });
}

/** Outline of a dorsal plate (z back along the body, y up; −0.5…0.5 × 0…1): jagged edges, leaning back. */
const PLATE: [number, number][] = [
  [-0.5, -0.12], [-0.47, 0.18], [-0.38, 0.33], [-0.42, 0.42], [-0.28, 0.58], [-0.31, 0.67], [-0.14, 0.84], [-0.13, 0.92], [0.06, 1.0],
  [0.07, 0.9], [0.2, 0.78], [0.15, 0.7], [0.3, 0.56], [0.26, 0.47], [0.4, 0.33], [0.37, 0.25], [0.5, 0.1], [0.5, -0.12],
];

/** A thick plate: two faces bulging from a thin edge, an edge strip all round (closed). */
function plate(B: Builder, p: { at: V3; T: V3; D: V3; S: V3; h: number; len: number; w: Weights; ord: number; tilt: number }): void {
  // Tilted outwards (staggered rows lean apart).
  const ct = Math.cos(p.tilt), st = Math.sin(p.tilt);
  const D = norm(add(mul(p.D, ct), mul(p.S, st))), S = norm(sub(mul(p.S, ct), mul(p.D, st)));
  const T = p.T;
  const th = p.len * 0.085;
  const at = (z: number, y: number, x: number): V3 => add(p.at, add(mul(T, z * p.len), add(mul(D, y * p.h), mul(S, x))));
  const cz = 0, cy = 0.36;
  const n = PLATE.length;
  const glowAt = (y: number, edge: number): Glow => [Math.min(1, sstep(0.18, 0.8, y) * (0.7 + 0.3 * edge)), p.ord, 0, 0];
  const colAt = (y: number, edge: number, k: number): V3 => mul(lerp3(HIDE_D, BONE, sstep(0.05, 0.6, y) * (0.75 + 0.25 * edge)), 0.85 + 0.3 * hash3(k, y * 20, p.ord * 50));
  const uvOf = (z: number, y: number): [number, number] => [z * p.len * 0.5, y * p.h * 0.17];
  B.begin();
  const sides: number[][] = [];
  for (const sgn of [1, -1]) {
    const c = B.vert(at(cz, cy, sgn * th * 0.5), ...uvOf(cz, cy), colAt(cy, 0, 0), glowAt(cy, 0), p.w);
    const mid: number[] = [], out: number[] = [];
    for (let i = 0; i < n; i++) {
      const [z, y] = PLATE[i];
      const mz = cz + (z - cz) * 0.55, my = cy + (y - cy) * 0.55;
      mid.push(B.vert(at(mz, my, sgn * th * 0.36), ...uvOf(mz, my), colAt(my, 0.3, i), glowAt(my, 0.3), p.w));
      out.push(B.vert(at(z, y, sgn * th * 0.05), ...uvOf(z, y), colAt(y, 1, i), glowAt(y, 1), p.w));
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      // Outline order runs counter-clockwise seen from +S: keep that face's triangles CCW.
      if (sgn > 0) { B.tri(c, mid[i], mid[j]); B.tri(mid[i], out[i], out[j]); B.tri(mid[i], out[j], mid[j]); }
      else { B.tri(c, mid[j], mid[i]); B.tri(mid[i], out[j], out[i]); B.tri(mid[i], mid[j], out[j]); }
    }
    sides.push(out);
  }
  // The edge: (+, −) strips between the two outlines.
  const [po, mo] = sides;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    B.tri(po[i], mo[i], po[j]);
    B.tri(po[j], mo[i], mo[j]);
  }
  B.end('plate');
}
