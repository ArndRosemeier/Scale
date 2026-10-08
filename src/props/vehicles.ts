/**
 * Procedural vehicle library.
 *
 * Every vehicle is built in code from lofted cross-sections:
 *  - a lower body loft (bumper to bumper) with tumblehome, a shoulder line,
 *    wheel arches cut into the side (well + flared lip), door seams and
 *    plan-view rounded nose/tail caps,
 *  - a greenhouse loft (windshield, A/B/C pillars, side glass, roof, rear
 *    window) sitting on the belt line,
 *  - inset/raised detail patches projected onto the nose/tail surfaces
 *    (head/tail lights, indicators, grille, plates, intakes),
 *  - small add-ons (mirrors, handles, roof sign, light bar, rails, spoiler,
 *    exhausts, cargo box, chassis ...).
 *
 * Each vertex carries a float `aPart` (VPart) that the shared vehicle
 * material uses to pick paint / glass / chrome / lights etc., so a whole car
 * is ONE draw call (plus one for the wheels) and can be instanced.
 *
 * Conventions: metres, origin at the centre of the footprint on the road,
 * forward = -Z, right = +X, up = +Y. Deterministic (variants via Rng).
 */
import * as THREE from 'three';
import { Rng } from '../core/rng';
import { buildArmyTruck, buildApc, buildTank } from './military';
import { WEBGPU, gpuKit } from '../render/gpuMode';
import { clamp, lerp, v3sub as sub } from '../core/math';

// ---------------------------------------------------------------- public API

export type VehicleKind =
  | 'sedan' | 'hatch' | 'wagon' | 'suv' | 'van' | 'pickup' | 'taxi' | 'police' | 'sports' | 'bus' | 'truck' | 'delivery' | 'shuttle' | 'swat'
  | 'army_truck' | 'apc' | 'tank'
  | 'ambulance' | 'firetruck' | 'crane' | 'flatbed';

export const VEHICLE_KINDS: VehicleKind[] = [
  'sedan', 'hatch', 'wagon', 'suv', 'van', 'pickup', 'taxi', 'police', 'sports', 'bus', 'truck', 'delivery', 'shuttle', 'swat',
  'army_truck', 'apc', 'tank',
  'ambulance', 'firetruck', 'crane', 'flatbed',
];

export interface VehicleModel {
  kind: VehicleKind;
  /** Dimensions in meters. Origin: centre of the footprint at ground level (y=0 is the road). Front points to -Z. */
  length: number;
  width: number;
  height: number;
  /** Body without wheels; indexed BufferGeometry with position, normal, uv and float attribute `aPart`. */
  body: THREE.BufferGeometry;
  /** One wheel (tyre + rim + hub) centred at the origin, axle along +X (outer face towards +X), radius = wheelRadius. */
  wheel: THREE.BufferGeometry;
  wheelRadius: number;
  /** Wheel centre positions in body space — 4 for cars, 6 for buses/trucks (dual rear). x<0 wheels are to be mirrored (scale x = -1). */
  wheels: [number, number, number][];
  /** Mass in kg. */
  mass: number;
  /** Driver seat (hip point) in body space. Left-hand drive (driver at x<0). */
  driverSeat: [number, number, number];
  /**
   * A turret (the tank): its geometry turns about Y round `pivot` (body space); the gun pitches about X
   * round `gunPivot` (turret space) and recoils along +Z. See props/military.ts.
   */
  turret?: { geo: THREE.BufferGeometry; pivot: [number, number, number]; gun: THREE.BufferGeometry; gunPivot: [number, number, number] };
}

export const enum VPart {
  Paint = 0, Glass = 1, Chrome = 2, Rubber = 3, Plastic = 4, Headlight = 5, Taillight = 6, Interior = 7,
  Indicator = 8, Plate = 9, Undercarriage = 10, Roofsign = 11, Lightbar = 12,
  /** Secondary livery colour (police stripes) – derived from the paint in the shader. */
  Livery = 13,
  /** Cargo box panels (off-white ribbed aluminium). */
  Cargo = 14,
  /** Painted/machined alloy rims. */
  Alloy = 15,
  /** Turquoise automated-driving marker lamps (SAE J3134), always lit on driverless vehicles. */
  AdsLamp = 16,
  /** Military paint: the paint colour, matte and dusty (army vehicles, aircraft). */
  Matte = 17,
  /** Canvas covers and sandbags: the paint colour, cloth-rough with folds. */
  Canvas = 18,
}

// ---------------------------------------------------------------- math helpers

type V2 = [number, number];
type V3 = [number, number, number];

const PI = Math.PI;
const sq = (v: number) => v * v;

/** Monotone cubic (Fritsch–Carlson) interpolation through keypoints (sorted by x). */
function mono(pts: [number, number][]): (x: number) => number {
  const P = pts.slice().sort((a, b) => a[0] - b[0]).filter((p, i, arr) => i === 0 || p[0] > arr[i - 1][0] + 1e-6);
  const n = P.length;
  if (n === 1) return () => P[0][1];
  const xs = P.map((p) => p[0]);
  const ys = P.map((p) => p[1]);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

function cross(a: V3, b: V3): V3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a: V3, b: V3) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(a: V3): V3 { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function addS(a: V3, b: V3, s: number): V3 { return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]; }
function mx(p: V3, side: number): V3 { return side > 0 ? p : [-p[0], p[1], p[2]]; }

// ---------------------------------------------------------------- triangle soup builder

class Geo {
  pos: number[] = [];
  uv: number[] = [];
  part: number[] = [];

  tri(a: V3, b: V3, c: V3, ta: V2, tb: V2, tc: V2, part: number, flip = false) {
    if (flip) { const t = b; b = c; c = t; const u = tb; tb = tc; tc = u; }
    const n = cross(sub(b, a), sub(c, a));
    if (dot(n, n) < 1e-13) return;
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.uv.push(ta[0], ta[1], tb[0], tb[1], tc[0], tc[1]);
    this.part.push(part, part, part);
  }
  /** Triangle oriented so that its normal agrees with `n`. */
  triN(a: V3, b: V3, c: V3, ta: V2, tb: V2, tc: V2, part: number, n: V3) {
    const f = cross(sub(b, a), sub(c, a));
    this.tri(a, b, c, ta, tb, tc, part, dot(f, n) < 0);
  }
  quad(a: V3, b: V3, c: V3, d: V3, ta: V2, tb: V2, tc: V2, td: V2, part: number, flip = false) {
    this.tri(a, b, c, ta, tb, tc, part, flip);
    this.tri(a, c, d, ta, tc, td, part, flip);
  }
  quadN(a: V3, b: V3, c: V3, d: V3, ta: V2, tb: V2, tc: V2, td: V2, part: number, n: V3) {
    this.triN(a, b, c, ta, tb, tc, part, n);
    this.triN(a, c, d, ta, tc, td, part, n);
  }
}

/** Creased (angle-weighted) normals + vertex welding → indexed BufferGeometry. */
function finalize(g: Geo, creaseDeg: number): THREE.BufferGeometry {
  const P = g.pos, nT = P.length / 9, nV = nT * 3;
  const fn = new Float32Array(nT * 3);
  const ang = new Float32Array(nV);
  const v = (i: number): V3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  for (let t = 0; t < nT; t++) {
    const a = v(t * 3), b = v(t * 3 + 1), c = v(t * 3 + 2);
    const n = norm(cross(sub(b, a), sub(c, a)));
    fn[t * 3] = n[0]; fn[t * 3 + 1] = n[1]; fn[t * 3 + 2] = n[2];
    const corners: [V3, V3, V3][] = [[a, b, c], [b, c, a], [c, a, b]];
    for (let k = 0; k < 3; k++) {
      const [p, q, r] = corners[k];
      const e1 = norm(sub(q, p)), e2 = norm(sub(r, p));
      ang[t * 3 + k] = Math.acos(clamp(dot(e1, e2), -1, 1));
    }
  }
  const groups = new Map<string, number[]>();
  const Q = 2e4;
  const keys: string[] = new Array(nV);
  for (let i = 0; i < nV; i++) {
    const k = `${Math.round(P[i * 3] * Q)},${Math.round(P[i * 3 + 1] * Q)},${Math.round(P[i * 3 + 2] * Q)}`;
    keys[i] = k;
    let l = groups.get(k);
    if (!l) { l = []; groups.set(k, l); }
    l.push(i);
  }
  const cosT = Math.cos((creaseDeg * PI) / 180);
  const N = new Float32Array(nV * 3);
  for (const list of groups.values()) {
    for (const i of list) {
      const f = (i / 3) | 0;
      let sx = 0, sy = 0, sz = 0;
      for (const j of list) {
        const h = (j / 3) | 0;
        const d = fn[f * 3] * fn[h * 3] + fn[f * 3 + 1] * fn[h * 3 + 1] + fn[f * 3 + 2] * fn[h * 3 + 2];
        if (d >= cosT) { const w = ang[j]; sx += fn[h * 3] * w; sy += fn[h * 3 + 1] * w; sz += fn[h * 3 + 2] * w; }
      }
      const l = Math.hypot(sx, sy, sz) || 1;
      N[i * 3] = sx / l; N[i * 3 + 1] = sy / l; N[i * 3 + 2] = sz / l;
    }
  }
  // weld
  const map = new Map<string, number>();
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], part: number[] = [], idx: number[] = [];
  for (let i = 0; i < nV; i++) {
    const k = `${keys[i]}|${Math.round(N[i * 3] * 500)},${Math.round(N[i * 3 + 1] * 500)},${Math.round(N[i * 3 + 2] * 500)}|${Math.round(g.uv[i * 2] * 2000)},${Math.round(g.uv[i * 2 + 1] * 2000)}|${g.part[i]}`;
    let id = map.get(k);
    if (id === undefined) {
      id = pos.length / 3;
      map.set(k, id);
      pos.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
      nrm.push(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]);
      uv.push(g.uv[i * 2], g.uv[i * 2 + 1]);
      part.push(g.part[i]);
    }
    idx.push(id);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  geo.setIndex(idx);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** Emit a loft between consecutive rings (right half rings, mirrored to the left). */
function loft(g: Geo, rings: V3[][], partFn: (i: number, j: number, side: number) => number, sides: number[] = [1, -1]) {
  const arcs = rings.map((r) => {
    const a = [0];
    for (let j = 1; j < r.length; j++) a.push(a[j - 1] + Math.hypot(r[j][0] - r[j - 1][0], r[j][1] - r[j - 1][1]));
    return a;
  });
  for (let i = 0; i < rings.length - 1; i++) {
    const A = rings[i], B = rings[i + 1];
    for (let j = 0; j < A.length - 1; j++) {
      for (const side of sides) {
        const part = partFn(i, j, side);
        if (part < 0) continue;
        g.quad(
          mx(A[j], side), mx(A[j + 1], side), mx(B[j + 1], side), mx(B[j], side),
          [A[j][2], arcs[i][j]], [A[j + 1][2], arcs[i][j + 1]], [B[j + 1][2], arcs[i + 1][j + 1]], [B[j][2], arcs[i + 1][j]],
          part, side < 0,
        );
      }
    }
  }
}

const sp = (x: number, e: number) => Math.sign(x) * Math.pow(Math.abs(x), e);

/** Superellipsoid blob (rounded box / ellipsoid). partFn gets the unit direction from the centre. */
function blob(g: Geo, c: V3, r: V3, nu: number, nv: number, e: number, partFn: (d: V3) => number, side = 1) {
  const pts: V3[][] = [];
  const dirs: V3[][] = [];
  for (let iv = 0; iv <= nv; iv++) {
    const v = -PI / 2 + (PI * iv) / nv;
    const row: V3[] = [], drow: V3[] = [];
    for (let iu = 0; iu <= nu; iu++) {
      const u = -PI + (2 * PI * iu) / nu + PI / nu;
      const d: V3 = [sp(Math.cos(v), e) * sp(Math.cos(u), e), sp(Math.sin(v), e), sp(Math.cos(v), e) * sp(Math.sin(u), e)];
      row.push(mx([c[0] + r[0] * d[0], c[1] + r[1] * d[1], c[2] + r[2] * d[2]], side));
      drow.push(mx(d, side));
    }
    pts.push(row);
    dirs.push(drow);
  }
  for (let iv = 0; iv < nv; iv++) {
    for (let iu = 0; iu < nu; iu++) {
      const a = pts[iv][iu], b = pts[iv][iu + 1], cc = pts[iv + 1][iu + 1], d = pts[iv + 1][iu];
      const dc = norm([
        (dirs[iv][iu][0] + dirs[iv + 1][iu + 1][0]) / (r[0] * r[0]),
        (dirs[iv][iu][1] + dirs[iv + 1][iu + 1][1]) / (r[1] * r[1]),
        (dirs[iv][iu][2] + dirs[iv + 1][iu + 1][2]) / (r[2] * r[2]),
      ]);
      const dd = norm([dirs[iv][iu][0] + dirs[iv + 1][iu + 1][0], dirs[iv][iu][1] + dirs[iv + 1][iu + 1][1], dirs[iv][iu][2] + dirs[iv + 1][iu + 1][2]]);
      const part = partFn(mx(dd, side));
      g.quadN(a, b, cc, d, [iu / nu, iv / nv], [(iu + 1) / nu, iv / nv], [(iu + 1) / nu, (iv + 1) / nv], [iu / nu, (iv + 1) / nv], part, dc);
    }
  }
}

/**
 * Rounded box extruded along Z (cross-section = rounded rectangle in XY), with flat end caps.
 * Centred on x = cx. partFn gets (outward normal, centroid).
 */
function rbox(g: Geo, cx: number, hx: number, y0: number, y1: number, z0: number, z1: number, r: number,
  partFn: (n: V3, p: V3) => number, segs = 3) {
  r = Math.min(r, hx * 0.999, (y1 - y0) / 2 * 0.999);
  const ring: V2[] = [];
  // full ring counter-clockwise seen from +z: start bottom middle
  const arc = (ccx: number, ccy: number, a0: number) => {
    for (let k = 0; k <= segs; k++) { const a = a0 + (k / segs) * (PI / 2); ring.push([ccx + r * Math.cos(a), ccy + r * Math.sin(a)]); }
  };
  arc(hx - r, y0 + r, -PI / 2);
  arc(hx - r, y1 - r, 0);
  arc(-hx + r, y1 - r, PI / 2);
  arc(-hx + r, y0 + r, PI);
  const n = ring.length;
  const cyy = (y0 + y1) / 2;
  for (let k = 0; k < n; k++) {
    const p = ring[k], q = ring[(k + 1) % n];
    const a: V3 = [cx + p[0], p[1], z0], b: V3 = [cx + q[0], q[1], z0], c: V3 = [cx + q[0], q[1], z1], d: V3 = [cx + p[0], p[1], z1];
    const mxp = (p[0] + q[0]) / 2, myp = (p[1] + q[1]) / 2;
    // outward normal of this edge
    const nn = norm([q[1] - p[1], -(q[0] - p[0]), 0]);
    const out: V3 = dot(nn, [mxp, myp - cyy, 0]) < 0 ? [-nn[0], -nn[1], 0] : nn;
    g.quadN(a, b, c, d, [z0, k / n], [z0, (k + 1) / n], [z1, (k + 1) / n], [z1, k / n], partFn(out, [cx + mxp, myp, (z0 + z1) / 2]), out);
  }
  for (const [z, dz] of [[z0, -1], [z1, 1]] as [number, number][]) {
    const cc: V3 = [cx, cyy, z];
    const nrm: V3 = [0, 0, dz];
    const part = partFn(nrm, cc);
    for (let k = 0; k < n; k++) {
      const p = ring[k], q = ring[(k + 1) % n];
      g.triN(cc, [cx + p[0], p[1], z], [cx + q[0], q[1], z], [0.5, 0.5], [0.5 + p[0], p[1]], [0.5 + q[0], q[1]], part, nrm);
    }
  }
}

/** Cylinder along Z (exhaust pipes, etc.). Open front end shows a dark inner disc. */
function tubeZ(g: Geo, c: V3, r: number, len: number, n: number, part: number, endPart: number, side: number) {
  const z0 = c[2] - len / 2, z1 = c[2] + len / 2;
  for (let k = 0; k < n; k++) {
    const a0 = (2 * PI * k) / n, a1 = (2 * PI * (k + 1)) / n;
    const p0: V3 = [c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0), 0];
    const p1: V3 = [c[0] + r * Math.cos(a1), c[1] + r * Math.sin(a1), 0];
    const nn: V3 = [Math.cos((a0 + a1) / 2), Math.sin((a0 + a1) / 2), 0];
    g.quadN(mx([p0[0], p0[1], z0], side), mx([p1[0], p1[1], z0], side), mx([p1[0], p1[1], z1], side), mx([p0[0], p0[1], z1], side),
      [0, 0], [1, 0], [1, 1], [0, 1], part, mx(nn, side));
    const zi = z1 - 0.02;
    g.triN(mx([c[0], c[1], zi], side), mx([p0[0] * 0.92 + c[0] * 0.08, p0[1] * 0.92 + c[1] * 0.08, zi], side),
      mx([p1[0] * 0.92 + c[0] * 0.08, p1[1] * 0.92 + c[1] * 0.08, zi], side), [0, 0], [0, 0], [0, 0], endPart, [0, 0, 1]);
    // lip
    g.quadN(mx([p0[0], p0[1], z1], side), mx([p1[0], p1[1], z1], side),
      mx([p1[0] * 0.92 + c[0] * 0.08, p1[1] * 0.92 + c[1] * 0.08, zi], side), mx([p0[0] * 0.92 + c[0] * 0.08, p0[1] * 0.92 + c[1] * 0.08, zi], side),
      [0, 0], [1, 0], [1, 1], [0, 1], part, [0, 0, 1]);
  }
}

// ---------------------------------------------------------------- body definition

interface Patch {
  /** Surface parameter along the end contour: 0..1 flat face (fraction of half-width), 1..2 corner arc, >2 metres along the side. */
  u0: number; u1: number;
  /** bottom edge y at u0/u1, top edge y at u0/u1 */
  yb0: number; yb1: number; yt0: number; yt1: number;
  part: number;
  frame?: number; framePart?: number;
  lift?: number; nx?: number; ny?: number;
  centered?: boolean; skirt?: boolean;
  /** extra top-edge bow (m) */
  bow?: number;
}

interface EndDef {
  rc: number;
  ext: [number, number][];
  topRound: number;
  botRound: number;
  capLow: number;
  patches: Patch[];
}

interface Axle { z: number; R: number; tw: number; rimR: number; dual: boolean; arch: boolean; Ra: number; flare: number; x: number }

interface GHDef {
  zA: number; zB: number; zC: number; zD: number;
  roofF: [number, number][];
  roofH: number;
  inset: number; tumble: number; topDrop: number; crown: number; bow: number;
  sideStart: number; sideEnd: number;
  pillars: { z: number; w: number; part: number }[];
  trim: number; aPillar: number; roofPart: number; cPillar: number;
  extraZ: number[];
  override?: (zm: number, j: number, side: number, ym: number) => number;
}

interface BodyDef {
  zF: number; zR: number;
  bottom: (z: number) => number;
  top: (z: number) => number;
  halfW: (z: number) => number;
  crown: number;
  shoulderDrop: number;
  rockerIn: number;
  tumbleLow: number;
  step: number;
  front: EndDef;
  rear: EndDef;
  axles: Axle[];
  seams: number[];
  topSeams: number[];
  cuts: number[];
  cladding: boolean;
  bed?: { z0: number; z1: number; railY: number; floorY: number };
  override?: (zm: number, j: number, side: number, ym: number) => number;
  gh: GHDef | null;
}

interface EndCtx { z0: number; dir: number; inner: number; X: (y: number) => number; ext: (y: number) => number }

interface BodyCtx {
  B: BodyDef;
  lowerAt: (z: number) => V3[];
  sideX: (z: number, y: number) => number;
  topY: (z: number, x: number) => number;
  ghAt: ((z: number) => V3[]) | null;
  roofY: (z: number, x: number) => number;
  front: EndCtx;
  rear: EndCtx;
}

const SEAM = 0.007;

function sideProfile(B: BodyDef, w: number, yLow: number, ySh: number, y: number) {
  const t = clamp((y - yLow) / Math.max(0.05, ySh - yLow), 0, 1), tm = 0.38;
  return t < tm ? w - B.rockerIn * sq((tm - t) / tm) : w - B.tumbleLow * sq((t - tm) / (1 - tm));
}

/** Lower body half ring (16 points, x ≥ 0): bottom centre → side → top centre. */
function lowerRing(B: BodyDef, z: number, arch: { aY: number; wellX: number; flare: number } | null, bed: boolean): V3[] {
  const w = B.halfW(z), yb = B.bottom(z);
  const yTop = bed && B.bed ? B.bed.railY : B.top(z);
  const cr = bed ? 0 : B.crown;
  const ySh = yTop - B.shoulderDrop, yLow = yb + 0.1;
  const xs = (y: number) => sideProfile(B, w, yLow, ySh, y);
  const P: V2[] = [[0, yb], [w - 0.15, yb], [w - 0.045, yb + 0.035]];
  if (!arch) {
    for (let k = 0; k < 8; k++) { const y = yLow + ((ySh - yLow) * k) / 7; P.push([xs(y), y]); }
  } else {
    const aY = Math.min(arch.aY, ySh - 0.07);
    const xl = xs(aY) + arch.flare;
    P[1] = [arch.wellX, yb];
    P[2] = [arch.wellX, yb + 0.03];
    P.push([arch.wellX, aY - 0.06], [xl - 0.045, aY - 0.016], [xl, aY]);
    for (let k = 1; k <= 5; k++) {
      const y = aY + ((ySh - aY) * k) / 5;
      P.push([xs(y) + arch.flare * Math.max(0, 1 - (y - aY) / 0.09), y]);
    }
  }
  const x11 = xs(ySh) - 0.014;
  P.push([x11, ySh + 0.035]);
  if (bed && B.bed) {
    const r = B.bed.railY;
    P.push([x11 - 0.045, r], [x11 - 0.08, r - 0.035], [x11 - 0.085, B.bed.floorY], [0, B.bed.floorY]);
  } else {
    const x12 = x11 - 0.05;
    for (const x of [x12, w * 0.6, w * 0.3, 0]) P.push([x, yTop + cr * (1 - sq(x / w))]);
  }
  return P.map((p) => [p[0], p[1], z] as V3);
}

function topAt(ring: V3[], x: number): number {
  for (let k = 10; k < ring.length - 1; k++) {
    const a = ring[k], b = ring[k + 1];
    if (x <= a[0] && x >= b[0]) { const t = (a[0] - x) / Math.max(1e-6, a[0] - b[0]); return lerp(a[1], b[1], t); }
  }
  return x > ring[10][0] ? ring[10][1] : ring[ring.length - 1][1];
}

function sideAt(ring: V3[], y: number): number {
  if (y <= ring[2][1]) return ring[2][0];
  for (let k = 2; k < 12; k++) {
    const a = ring[k], b = ring[k + 1];
    if (y >= a[1] && y <= b[1]) { const t = (y - a[1]) / Math.max(1e-6, b[1] - a[1]); return lerp(a[0], b[0], t); }
  }
  return ring[12][0];
}

/** Greenhouse half ring (9 points). */
function ghRing(B: BodyDef, G: GHDef, fF: (z: number) => number, z: number): V3[] {
  const low = lowerRing(B, z, null, false);
  const w = B.halfW(z);
  const gb = w - G.inset, gt = gb - G.tumble;
  const yBase = topAt(low, gb) - 0.004;
  const yR = G.roofH - G.crown;
  const f = clamp(fF(z), 0, 1);
  const yg0 = yBase + 0.035, yg1 = yR - G.topDrop;
  const full: V2[] = [[gb, yBase], [gb - 0.012, yg0]];
  for (const t of [0.4, 0.78, 1]) {
    full.push([lerp(gb - 0.012, gt, t) + G.bow * Math.sin(PI * t) * (1 - t * 0.5), lerp(yg0, yg1, t)]);
  }
  const x6 = gt - 0.1;
  full.push([gt - 0.022, yR - G.topDrop * 0.4], [x6, yR - 0.004 + G.crown * (1 - sq(x6 / gt))], [gt * 0.5, yR + G.crown * 0.75], [0, yR + G.crown]);
    const bx = [gb, gb - 0.012, gb - 0.02, gb - 0.03, gb - 0.04, gb - 0.06, Math.min(gb - 0.11, x6 + (gb - gt) * 0.45), gt * 0.5 + (gb - gt) * 0.3, 0];
  return full.map((p, i) => {
    const x0 = bx[i], y0 = topAt(low, x0) - 0.004;
    return [lerp(x0, p[0], f), lerp(y0, p[1], f), z] as V3;
  });
}

function uniqSorted(zs: number[], eps: number): number[] {
  const s = zs.slice().sort((a, b) => a - b);
  const out: number[] = [];
  for (const z of s) if (!out.length || z - out[out.length - 1] > eps) out.push(z);
  return out;
}

/** Build the body (lower loft, caps, greenhouse) and return context for details. */
function buildBody(g: Geo, B: BodyDef): BodyCtx {
  const maxExt = (e: [number, number][]) => Math.max(...e.map((p) => p[1]));
  const zF0 = B.zF + maxExt(B.front.ext);
  const zR0 = B.zR - maxExt(B.rear.ext);
  const archs = B.axles.filter((a) => a.arch && a.z - a.Ra > zF0 + 0.05 && a.z + a.Ra < zR0 - 0.05);
  const inArch = (z: number, m: number) => archs.some((a) => Math.abs(z - a.z) < a.Ra + m);
  const bed = B.bed;
  const bedAt = (z: number) => !!bed && z > bed.z0 + 1e-5 && z < bed.z1 - 1e-5;

  // important cuts
  const imp: number[] = [...B.cuts];
  for (const s of B.seams) imp.push(s - SEAM / 2, s + SEAM / 2);
  for (const s of B.topSeams) imp.push(s - SEAM / 2, s + SEAM / 2);
  const impF = imp.filter((z) => z > zF0 + 0.01 && z < zR0 - 0.01 && !inArch(z, 0.015));
  const n = Math.max(2, Math.ceil((zR0 - zF0) / B.step));
  const grid: number[] = [];
  for (let i = 0; i <= n; i++) {
    const z = zF0 + ((zR0 - zF0) * i) / n;
    if (i === 0 || i === n) { grid.push(z); continue; }
    if (inArch(z, 0.06)) continue;
    if (impF.some((c) => Math.abs(c - z) < 0.07)) continue;
    if (bed && (Math.abs(z - bed.z0) < 0.07 || Math.abs(z - bed.z1) < 0.07)) continue;
    grid.push(z);
  }
  const cuts = uniqSorted([...grid, ...impF], 0.002);

  type St = { ring: V3[]; arch: boolean; bed: boolean; z: number };
  const st: St[] = [];
  const ev: { z: number; a?: Axle; bedEdge?: 0 | 1 }[] = cuts.map((z) => ({ z }));
  for (const a of archs) ev.push({ z: a.z - a.Ra, a });
  if (bed) { ev.push({ z: bed.z0, bedEdge: 0 }, { z: bed.z1, bedEdge: 1 }); }
  ev.sort((p, q) => p.z - q.z);
  for (const e of ev) {
    if (e.a) {
      const a = e.a, nA = 8;
      const wellX = a.x - (a.dual ? a.tw * 1.5 + 0.02 : a.tw / 2) - 0.05;
      const b0 = bedAt(a.z - a.Ra);
      st.push({ ring: lowerRing(B, a.z - a.Ra, null, b0), arch: false, bed: b0, z: a.z - a.Ra });
      for (let k = 0; k <= nA; k++) {
        const z = a.z - a.Ra * Math.cos((PI * k) / nA);
        const dz = z - a.z;
        const aY = a.R + Math.sqrt(Math.max(0, a.Ra * a.Ra - dz * dz));
        const bb = bedAt(z);
        st.push({ ring: lowerRing(B, z, { aY, wellX, flare: a.flare }, bb), arch: true, bed: bb, z });
      }
      const b1 = bedAt(a.z + a.Ra);
      st.push({ ring: lowerRing(B, a.z + a.Ra, null, b1), arch: false, bed: b1, z: a.z + a.Ra });
    } else if (e.bedEdge === 0) {
      st.push({ ring: lowerRing(B, e.z, null, false), arch: false, bed: false, z: e.z });
      st.push({ ring: lowerRing(B, e.z, null, true), arch: false, bed: true, z: e.z });
    } else if (e.bedEdge === 1) {
      st.push({ ring: lowerRing(B, e.z, null, true), arch: false, bed: true, z: e.z });
      st.push({ ring: lowerRing(B, e.z, null, false), arch: false, bed: false, z: e.z });
    } else {
      const bb = bedAt(e.z);
      st.push({ ring: lowerRing(B, e.z, null, bb), arch: false, bed: bb, z: e.z });
    }
  }

  // end rounding
  const endCtx = (ring: V3[], z0: number, dir: number, E: EndDef): EndCtx => {
    const Wmax = Math.max(...ring.map((p) => p[0]));
    return { z0, dir, inner: Wmax - E.rc, X: (y: number) => sideAt(ring, y), ext: mono(E.ext) };
  };
  const fr = endCtx(st[0].ring, st[0].z, -1, B.front);
  const rr = endCtx(st[st.length - 1].ring, st[st.length - 1].z, 1, B.rear);
  const roundRing = (ring: V3[], E: EndDef, C: EndCtx, th: number): V3[] => {
    const c = Math.cos(th), s = Math.sin(th);
    return ring.map((p, idx) => {
      const inn = Math.min(p[0], C.inner), d = p[0] - inn;
      let y = p[1];
      if (idx >= 11) y -= E.topRound * (1 - c);
      if (idx <= 2) y += E.botRound * (1 - c);
      return [inn + d * c, y, C.z0 + C.dir * C.ext(p[1]) * s] as V3;
    });
  };
  const ths = [90, 72, 54, 36, 18].map((d) => (d * PI) / 180);
  const frontRings = ths.map((t) => roundRing(st[0].ring, B.front, fr, t));
  const rearRings = ths.slice().reverse().map((t) => roundRing(st[st.length - 1].ring, B.rear, rr, t));
  const rings: V3[][] = [...frontRings, ...st.map((s) => s.ring), ...rearRings];
  const meta = [...frontRings.map(() => ({ arch: false, bed: false, end: true })), ...st.map((s) => ({ arch: s.arch, bed: s.bed, end: false })),
    ...rearRings.map(() => ({ arch: false, bed: false, end: true }))];

  const inSeam = (z: number, list: number[]) => list.some((s) => Math.abs(z - s) < SEAM / 2 + 1e-4);
  loft(g, rings, (i, j, side) => {
    const A = rings[i], Bn = rings[i + 1];
    const zm = (A[j][2] + A[j + 1][2] + Bn[j][2] + Bn[j + 1][2]) / 4;
    const ym = (A[j][1] + A[j + 1][1] + Bn[j][1] + Bn[j + 1][1]) / 4;
    const ma = meta[i], mb = meta[i + 1];
    const well = ma.arch && mb.arch;
    const wall = Math.abs(A[5][2] - Bn[5][2]) < 1e-6 && ma.arch !== mb.arch;
    if (B.override) { const r = B.override(zm, j, side, ym); if (r >= 0) return r; }
    if (j === 0) return VPart.Undercarriage;
    if ((well || wall) && j <= 3) return VPart.Undercarriage;
    if (j === 1) return VPart.Plastic;
    if ((ma.end || mb.end) && j === 2) return VPart.Plastic;
    if (well && j === 4) return B.cladding ? VPart.Plastic : VPart.Paint;
    if (B.cladding && (j === 2 || (well && j <= 6))) return VPart.Plastic;
    if (j >= 12 && (ma.bed || mb.bed)) return VPart.Plastic;
    if (!ma.end && !mb.end && j >= 2 && j <= 10 && inSeam(zm, B.seams)) return VPart.Rubber;
    if (!ma.end && !mb.end && j >= 11 && inSeam(zm, B.topSeams)) return VPart.Rubber;
    return VPart.Paint;
  });

  // caps
  const cap = (ring: V3[], dir: number, E: EndDef) => {
    const nrm: V3 = [0, 0, dir];
    const C = (k: number): V3 => [0, ring[k][1], ring[k][2]];
    const pp = (y: number) => (y < E.capLow ? VPart.Plastic : VPart.Paint);
    for (const side of [1, -1]) {
      const n2 = mx(nrm, side);
      for (let k = 1; k < 11; k++) {
        const a = C(k), b = ring[k], c = ring[k + 1], d = C(k + 1);
        const part = pp((a[1] + d[1]) / 2);
        g.quadN(mx(a, side), mx(b, side), mx(c, side), mx(d, side), [a[0], a[1]], [b[0], b[1]], [c[0], c[1]], [d[0], d[1]], part, n2);
      }
      const c11 = C(11);
      for (let k = 11; k < 15; k++) {
        g.triN(mx(c11, side), mx(ring[k], side), mx(ring[k + 1], side), [0, c11[1]], [ring[k][0], ring[k][1]], [ring[k + 1][0], ring[k + 1][1]], VPart.Paint, n2);
      }
    }
  };
  cap(frontRings[0], -1, B.front);
  cap(rearRings[rearRings.length - 1], 1, B.rear);

  const lowerAt = (z: number) => lowerRing(B, z, null, bedAt(z));
  const ctx: BodyCtx = {
    B, lowerAt,
    sideX: (z, y) => sideAt(lowerAt(z), y),
    topY: (z, x) => topAt(lowerAt(z), x),
    ghAt: null,
    roofY: (z, x) => topAt(lowerAt(z), x),
    front: fr, rear: rr,
  };

  // greenhouse
  const G = B.gh;
  if (G) {
    const fF = mono(G.roofF);
    const zs: number[] = [G.zA, G.zB, G.zC, G.zD, G.sideStart, G.sideEnd, ...G.extraZ];
    for (const p of G.pillars) zs.push(p.z - p.w / 2, p.z + p.w / 2);
    for (const t of [0.1, 0.25, 0.42, 0.6, 0.77, 0.9]) zs.push(lerp(G.zA, G.zB, t));
    for (const t of [0.12, 0.3, 0.5, 0.72, 0.88]) zs.push(lerp(G.zC, G.zD, t));
    const nr = Math.max(1, Math.round((G.zC - G.zB) / 0.45));
    for (let i = 1; i < nr; i++) zs.push(lerp(G.zB, G.zC, i / nr));
    const imp = new Set([G.zA, G.zB, G.zC, G.zD, G.sideStart, G.sideEnd, ...G.extraZ, ...G.pillars.flatMap((p) => [p.z - p.w / 2, p.z + p.w / 2])]);
    const sorted = zs.filter((z) => z >= G.zA - 1e-6 && z <= G.zD + 1e-6).sort((a, b) => a - b);
    const gz: number[] = [];
    for (const z of sorted) {
      if (!gz.length) { gz.push(z); continue; }
      const last = gz[gz.length - 1];
      if (z - last > 0.03) gz.push(z);
      else if (imp.has(z) && !imp.has(last)) gz[gz.length - 1] = z;
      else if (z - last > 0.004 && imp.has(z)) gz.push(z);
    }
    const grings = gz.map((z) => ghRing(B, G, fF, z));
    const inP = (z: number) => G.pillars.find((p) => Math.abs(z - p.z) < p.w / 2);
    loft(g, grings, (i, j, side) => {
      const A = grings[i], Bn = grings[i + 1];
      const zm = (A[0][2] + Bn[0][2]) / 2;
      const ym = (A[j][1] + A[j + 1][1] + Bn[j][1] + Bn[j + 1][1]) / 4;
      if (G.override) { const r = G.override(zm, j, side, ym); if (r >= 0) return r; }
      const ws = zm < G.zB, rw = zm > G.zC;
      if (j === 0) return G.trim;
      if (j <= 3) {
        if (zm > G.sideStart && zm < G.sideEnd) { const p = inP(zm); return p ? p.part : VPart.Glass; }
        return ws ? G.aPillar : G.cPillar;
      }
      if (j <= 5) return ws ? G.aPillar : rw ? G.cPillar : G.roofPart === VPart.Glass ? VPart.Paint : G.roofPart;
      return ws || rw ? VPart.Glass : G.roofPart;
    });
    ctx.ghAt = (z: number) => ghRing(B, G, fF, z);
    ctx.roofY = (z: number, x: number) => {
      const r = ghRing(B, G, fF, z);
      for (let k = 4; k < r.length - 1; k++) {
        const a = r[k], b = r[k + 1];
        if (x <= a[0] && x >= b[0]) return lerp(a[1], b[1], (a[0] - x) / Math.max(1e-6, a[0] - b[0]));
      }
      return r[r.length - 1][1];
    };
  }
  return ctx;
}

// ---------------------------------------------------------------- end-surface detail patches

function endSurf(E: EndCtx, u: number, y: number): { p: V3; o: V3 } {
  const X = E.X(y), inner = Math.max(0.02, E.inner), a = Math.max(0.002, X - inner), b = E.ext(y);
  let x: number, f: number, o: V3;
  if (u <= 1) { x = u * inner; f = b; o = [0, 0, 1]; }
  else if (u <= 2) { const ph = (u - 1) * (PI / 2); x = inner + a * Math.sin(ph); f = b * Math.cos(ph); o = norm([Math.sin(ph) / a, 0, Math.cos(ph) / b]); }
  else { x = X; f = -(u - 2); o = [1, 0, 0]; }
  return { p: [x, y, E.z0 + E.dir * f], o: [o[0], 0, o[2] * E.dir] };
}

function endNormal(E: EndCtx, u: number, y: number): V3 {
  const e = 0.004;
  const pu = sub(endSurf(E, u + e, y).p, endSurf(E, Math.max(0, u - e), y).p);
  const py = sub(endSurf(E, u, y + e).p, endSurf(E, u, y - e).p);
  let n = norm(cross(pu, py));
  const o = endSurf(E, u, y).o;
  if (dot(n, o) < 0) n = [-n[0], -n[1], -n[2]];
  return n;
}

function endPatch(g: Geo, E: EndCtx, P: Patch) {
  const lift = P.lift ?? 0.006;
  const nx = P.nx ?? Math.max(2, Math.min(8, Math.ceil(Math.abs(P.u1 - P.u0) * 3.5)));
  const ny = P.ny ?? 1;
  const fr = P.frame ?? 0;
  const us: number[] = [], vs: number[] = [];
  if (fr > 0) {
    if (!P.centered) us.push(0);
    for (let i = 0; i <= nx; i++) us.push(P.centered ? lerp(0, 1 - fr, i / nx) : lerp(fr, 1 - fr, i / nx));
    us.push(1);
    vs.push(0);
    for (let i = 0; i <= ny; i++) vs.push(lerp(fr * 2, 1 - fr * 2, i / ny));
    vs.push(1);
  } else {
    for (let i = 0; i <= nx; i++) us.push(i / nx);
    for (let i = 0; i <= ny; i++) vs.push(i / ny);
  }
  const at = (uu: number, vv: number, l: number): { p: V3; n: V3 } => {
    const u = lerp(P.u0, P.u1, uu);
    const yb = lerp(P.yb0, P.yb1, uu), yt = lerp(P.yt0, P.yt1, uu) + (P.bow ?? 0) * Math.sin(PI * uu);
    const y = lerp(yb, yt, vv);
    const n = endNormal(E, u, y);
    return { p: addS(endSurf(E, u, y).p, n, l), n };
  };
  for (const side of [1, -1]) {
    const grid = us.map((uu) => vs.map((vv) => at(uu, vv, lift)));
    for (let i = 0; i < us.length - 1; i++) {
      for (let j = 0; j < vs.length - 1; j++) {
        const isFrame = fr > 0 && ((!P.centered && i === 0) || i === us.length - 2 || j === 0 || j === vs.length - 2);
        const part = isFrame ? (P.framePart ?? VPart.Chrome) : P.part;
        const U = (uu: number) => (P.centered ? (side * E.dir > 0 ? 0.5 + 0.5 * uu : 0.5 - 0.5 * uu) : uu);
        const a = grid[i][j], b = grid[i + 1][j], c = grid[i + 1][j + 1], d = grid[i][j + 1];
        const nn = norm([a.n[0] + c.n[0], a.n[1] + c.n[1], a.n[2] + c.n[2]]);
        g.quadN(mx(a.p, side), mx(b.p, side), mx(c.p, side), mx(d.p, side),
          [U(us[i]), vs[j]], [U(us[i + 1]), vs[j]], [U(us[i + 1]), vs[j + 1]], [U(us[i]), vs[j + 1]], part, mx(nn, side));
      }
    }
    if (P.skirt) {
      const sk = P.framePart ?? VPart.Plastic;
      const edge: [number, number][] = [];
      for (let i = 0; i < us.length; i++) edge.push([i, 0]);
      for (let j = 1; j < vs.length; j++) edge.push([us.length - 1, j]);
      for (let i = us.length - 2; i >= 0; i--) edge.push([i, vs.length - 1]);
      if (!P.centered) for (let j = vs.length - 2; j >= 0; j--) edge.push([0, j]);
      const cen = at(0.5, 0.5, 0).p;
      for (let k = 0; k < edge.length - 1; k++) {
        const [i0, j0] = edge[k], [i1, j1] = edge[k + 1];
        const a = grid[i0][j0], b = grid[i1][j1];
        const a2 = at(us[i0], vs[j0], -0.012).p, b2 = at(us[i1], vs[j1], -0.012).p;
        const mid: V3 = [(a.p[0] + b.p[0]) / 2, (a.p[1] + b.p[1]) / 2, (a.p[2] + b.p[2]) / 2];
        g.quadN(mx(a.p, side), mx(b.p, side), mx(b2, side), mx(a2, side), [0, 0], [1, 0], [1, 1], [0, 1], sk, mx(sub(mid, cen), side));
      }
    }
  }
}

// ---------------------------------------------------------------- wheels

type WheelStyle = 'five' | 'six' | 'twin' | 'multi' | 'cap' | 'steel' | 'mesh';

const wheelCache = new Map<string, THREE.BufferGeometry>();

function buildWheel(R: number, tw: number, rimR: number, style: WheelStyle): THREE.BufferGeometry {
  const key = `${R.toFixed(3)}|${tw.toFixed(3)}|${rimR.toFixed(3)}|${style}`;
  const hit = wheelCache.get(key);
  if (hit) return hit;
  const g = new Geo();
  const N = 18;
  const hw = tw / 2;
  const s = R / 0.33;
  const at = (x: number, r: number, a: number): V3 => [x, r * Math.cos(a), r * Math.sin(a)];
  type Seg = { a: V2; b: V2; part: number; n: V2; tread?: boolean };
  const sideR = rimR + 0.48 * (R - rimR);
  const segs: Seg[] = [
    { a: [-hw + 0.012, rimR + 0.006], b: [-hw, R - 0.045 * s], part: VPart.Rubber, n: [-1, 0] },
    { a: [-hw, R - 0.045 * s], b: [-hw + 0.03 * s, R - 0.003], part: VPart.Rubber, n: [-0.7, 0.7] },
    { a: [-hw + 0.03 * s, R - 0.003], b: [hw - 0.03 * s, R - 0.003], part: VPart.Rubber, n: [0, 1], tread: true },
    { a: [hw - 0.03 * s, R - 0.003], b: [hw + 0.004, R - 0.045 * s], part: VPart.Rubber, n: [0.7, 0.7] },
    { a: [hw + 0.004, R - 0.045 * s], b: [hw + 0.007, sideR], part: VPart.Rubber, n: [1, 0.1] },
    { a: [hw + 0.007, sideR], b: [hw - 0.003, rimR + 0.01], part: VPart.Rubber, n: [1, -0.1] },
  ];
  const rimPart = style === 'steel' || style === 'cap' ? VPart.Alloy : VPart.Alloy;
  segs.push(
    { a: [hw - 0.003, rimR + 0.01], b: [hw - 0.006, rimR - 0.012], part: rimPart, n: [1, 0.2] },
    { a: [hw - 0.006, rimR - 0.012], b: [hw - 0.03, rimR - 0.022], part: rimPart, n: [0.4, -1] },
    { a: [hw - 0.03, rimR - 0.022], b: [hw - 0.11, rimR - 0.024], part: VPart.Plastic, n: [0, -1] },
  );
  for (const sg of segs) {
    for (let k = 0; k < N; k++) {
      const a0 = (2 * PI * k) / N, a1 = (2 * PI * (k + 1)) / N, am = (a0 + a1) / 2;
      const n: V3 = [sg.n[0], sg.n[1] * Math.cos(am), sg.n[1] * Math.sin(am)];
      const ua = sg.tread ? -2 : 5, ub = sg.tread ? -1 : 5;
      g.quadN(at(sg.a[0], sg.a[1], a0), at(sg.a[0], sg.a[1], a1), at(sg.b[0], sg.b[1], a1), at(sg.b[0], sg.b[1], a0),
        [k / N, ua], [(k + 1) / N, ua], [(k + 1) / N, ub], [k / N, ub], sg.part, n);
    }
  }
  // brake disc / back plate
  const xb = hw - 0.11;
  for (let k = 0; k < N; k++) {
    const a0 = (2 * PI * k) / N, a1 = (2 * PI * (k + 1)) / N;
    g.triN([xb, 0, 0], at(xb, rimR - 0.024, a0), at(xb, rimR - 0.024, a1), [0, 5], [0, 5], [0, 5], VPart.Undercarriage, [1, 0, 0]);
  }
  const xF = hw - 0.028, xH = hw - 0.012;
  const rH = 0.058 * s, rR = rimR - 0.018;
  const spoke = (al: number, wh: number, wr: number, depth = 0.03) => {
    const P = (r: number, t: number, x: number): V3 => [x, r * Math.cos(al) - t * Math.sin(al), r * Math.sin(al) + t * Math.cos(al)];
    const L0 = P(rH, -wh / 2, xH), L1 = P(rR, -wr / 2, xF), M0 = P(rH, 0, xH + 0.006), M1 = P(rR * 0.97, 0, xF + 0.006);
    const R0 = P(rH, wh / 2, xH), R1 = P(rR, wr / 2, xF);
    const uv: V2 = [0, 5];
    g.quadN(L0, L1, M1, M0, uv, uv, uv, uv, VPart.Alloy, [1, 0, 0]);
    g.quadN(M0, M1, R1, R0, uv, uv, uv, uv, VPart.Alloy, [1, 0, 0]);
    const tn: V3 = [0, -Math.sin(al), Math.cos(al)];
    const back = (p: V3): V3 => [p[0] - depth, p[1], p[2]];
    g.quadN(L0, L1, back(L1), back(L0), uv, uv, uv, uv, VPart.Alloy, [-tn[0], -tn[1], -tn[2]]);
    g.quadN(R0, R1, back(R1), back(R0), uv, uv, uv, uv, VPart.Alloy, tn);
  };
  const disc = (prof: V2[], part: number, segsN = N) => {
    for (let i = 0; i < prof.length - 1; i++) {
      for (let k = 0; k < segsN; k++) {
        const a0 = (2 * PI * k) / segsN, a1 = (2 * PI * (k + 1)) / segsN;
        const A = prof[i], Bp = prof[i + 1];
        g.quadN(at(A[0], A[1], a0), at(A[0], A[1], a1), at(Bp[0], Bp[1], a1), at(Bp[0], Bp[1], a0), [0, 5], [0, 5], [0, 5], [0, 5], part, [1, 0, 0]);
      }
    }
  };
  switch (style) {
    case 'five': for (let i = 0; i < 5; i++) spoke((2 * PI * i) / 5, 0.085 * s, 0.06 * s); break;
    case 'six': for (let i = 0; i < 6; i++) spoke((2 * PI * i) / 6, 0.07 * s, 0.045 * s); break;
    case 'twin': for (let i = 0; i < 5; i++) { const a = (2 * PI * i) / 5; spoke(a - 0.13, 0.035 * s, 0.03 * s); spoke(a + 0.13, 0.035 * s, 0.03 * s); } break;
    case 'multi': for (let i = 0; i < 8; i++) spoke((2 * PI * i) / 8, 0.05 * s, 0.032 * s); break;
    case 'mesh': for (let i = 0; i < 10; i++) spoke((2 * PI * i) / 10, 0.04 * s, 0.022 * s, 0.02); break;
    case 'cap':
      disc([[hw - 0.02, rimR - 0.016], [hw - 0.006, rimR * 0.78], [hw + 0.002, rimR * 0.45], [hw + 0.006, rH]], VPart.Alloy, 16);
      for (let i = 0; i < 8; i++) spoke((2 * PI * i) / 8 + 0.2, 0.03 * s, 0.05 * s, 0.006);
      break;
    case 'steel':
      disc([[hw - 0.03, rimR - 0.02], [hw - 0.03, rimR * 0.72], [hw - 0.005, rimR * 0.55], [hw - 0.005, rH * 1.2]], VPart.Alloy, 14);
      break;
  }
  // hub cap
  const xc = style === 'cap' ? hw + 0.008 : style === 'steel' ? hw + 0.0 : xH + 0.008;
  const hn = 8;
  for (let k = 0; k < hn; k++) {
    const a0 = (2 * PI * k) / hn, a1 = (2 * PI * (k + 1)) / hn;
    g.triN([xc + 0.004, 0, 0], at(xc, rH * 0.85, a0), at(xc, rH * 0.85, a1), [0, 5], [0, 5], [0, 5], VPart.Chrome, [1, 0, 0]);
    g.quadN(at(xc, rH * 0.85, a0), at(xc, rH * 0.85, a1), at(xc - 0.02, rH * 1.05, a1), at(xc - 0.02, rH * 1.05, a0),
      [0, 5], [0, 5], [0, 5], [0, 5], VPart.Chrome, [0.3, Math.cos((a0 + a1) / 2), Math.sin((a0 + a1) / 2)]);
  }
  const geo = finalize(g, 50);
  wheelCache.set(key, geo);
  return geo;
}

// ---------------------------------------------------------------- per-kind definitions

interface CarP {
  L: number; W: number;
  zFront?: number; zRear?: number;
  R: number; tw: number; rimR: number; fo: number; wb: number; dualRear?: boolean; Ra?: number; flare?: number; rearArch?: boolean;
  yb: number; ybF: number; ybR: number;
  hoodF: number; cowl: number; belt: number; deck: number; tailTop: number; deckZ?: number; hoodMid?: number;
  wF: number; wR: number;
  crown: number; shoulderDrop: number; rockerIn?: number; tumbleLow?: number;
  noseExt: [number, number][]; rcF: number; topRoundF: number; tailExt: [number, number][]; rcR: number; topRoundR: number; botRound?: number;
  capLowF: number; capLowR: number;
  gh: GHDef | null;
  seams: number[]; topSeams: number[];
  cladding?: boolean;
  step?: number;
  bed?: { z0: number; z1: number; railY: number; floorY: number };
  override?: (zm: number, j: number, side: number, ym: number) => number;
  cuts?: number[];
}

function makeBody(p: CarP): { B: BodyDef; axles: Axle[] } {
  const zF = p.zFront ?? -p.L / 2, zR = p.zRear ?? p.L / 2;
  const zF0 = zF + Math.max(...p.noseExt.map((e) => e[1]));
  const zR0 = zR - Math.max(...p.tailExt.map((e) => e[1]));
  const za = zF + p.fo, zb = za + p.wb;
  const G = p.gh;
  const zA = G ? G.zA : lerp(zF0, zR0, 0.35);
  const zD = G ? G.zD : lerp(zF0, zR0, 0.7);
  const deckZ = p.deckZ ?? Math.min(zR0 - 0.02, zD + 0.12);
  const topK: [number, number][] = [
    [zF0, p.hoodF],
    [lerp(zF0, zA, 0.5), p.hoodMid ?? lerp(p.hoodF, p.cowl, 0.66)],
    [zA, p.cowl],
    [zA + 0.22, p.belt],
  ];
  if (zD - 0.1 > zA + 0.3) topK.push([zD - 0.1, lerp(p.belt, p.deck, 0.25)]);
  if (deckZ > zD - 0.1 + 0.02) topK.push([deckZ, p.deck]);
  if (zR0 > deckZ + 0.03) topK.push([zR0, p.tailTop]);
  const filtered: [number, number][] = [];
  for (const k of topK) if (!filtered.length || k[0] > filtered[filtered.length - 1][0] + 0.01) filtered.push(k);
  const halfW = mono([[zF0, (p.W / 2) * p.wF], [lerp(zF0, za, 0.6), (p.W / 2) * lerp(p.wF, 1, 0.85)], [za, p.W / 2], [zb, (p.W / 2) * 0.997], [lerp(zb, zR0, 0.5), (p.W / 2) * lerp(1, p.wR, 0.6)], [zR0, (p.W / 2) * p.wR]]);
  const bottom = mono([[zF0, p.ybF], [za - 0.1, p.yb], [zb + 0.1, p.yb], [zR0, p.ybR]]);
  const Ra = p.Ra ?? p.R + 0.065;
  const mkAxle = (z: number, dual: boolean, arch: boolean): Axle => {
    const w = halfW(z);
    return { z, R: p.R, tw: p.tw, rimR: p.rimR, dual, arch, Ra: dual ? Ra + 0.02 : Ra, flare: p.flare ?? 0.012, x: w - p.tw / 2 - 0.022 };
  };
  const axles = [mkAxle(za, false, true), mkAxle(zb, !!p.dualRear, p.rearArch ?? true)];
  const B: BodyDef = {
    zF, zR,
    bottom, top: mono(filtered), halfW,
    crown: p.crown, shoulderDrop: p.shoulderDrop, rockerIn: p.rockerIn ?? 0.035, tumbleLow: p.tumbleLow ?? 0.035,
    step: p.step ?? 0.38,
    front: { rc: p.rcF, ext: p.noseExt, topRound: p.topRoundF, botRound: p.botRound ?? 0.05, capLow: p.capLowF, patches: [] },
    rear: { rc: p.rcR, ext: p.tailExt, topRound: p.topRoundR, botRound: p.botRound ?? 0.05, capLow: p.capLowR, patches: [] },
    axles, seams: p.seams, topSeams: p.topSeams, cuts: p.cuts ?? [], cladding: !!p.cladding, bed: p.bed, override: p.override, gh: G,
  };
  return { B, axles };
}

export interface Built {
  body: THREE.BufferGeometry;
  wheel: THREE.BufferGeometry;
  wheelRadius: number;
  wheels: [number, number, number][];
  mass: number;
  driverSeat: [number, number, number];
  turret?: VehicleModel['turret'];
}

/** Mirror, handles and the usual car details that depend on the body context. */
function addMirrors(g: Geo, ctx: BodyCtx, zM: number, size = 1, armLen = 0.0) {
  if (!ctx.ghAt) return;
  const r = ctx.ghAt(zM);
  const base = r[0];
  for (const side of [1, -1]) {
    const c: V3 = [base[0] + 0.115 * size + armLen, base[1] + 0.085 * size, zM + 0.05];
    blob(g, c, [0.085 * size, 0.052 * size, 0.05 * size], 8, 4, 0.7, (d) => (d[2] > 0.45 ? VPart.Chrome : d[0] * side > 0.75 && d[2] < 0.1 ? VPart.Indicator : VPart.Paint), side);
    blob(g, [base[0] + 0.025 + armLen * 0.5, base[1] + 0.045 * size, zM + 0.05], [0.045 + armLen * 0.5, 0.02, 0.028], 4, 2, 0.6, () => VPart.Plastic, side);
  }
}

function addHandles(g: Geo, ctx: BodyCtx, zs: number[], dy = 0.085) {
  for (const z of zs) {
    const y = ctx.B.top(z) - ctx.B.shoulderDrop - dy;
    const x = ctx.sideX(z, y);
    for (const side of [1, -1]) {
      blob(g, [x + 0.004, y, z], [0.011, 0.014, 0.068], 6, 3, 0.5, () => VPart.Chrome, side);
    }
  }
}

function v3(a: number, b: number, c: number): [number, number, number] { return [a, b, c]; }

function finishCar(kind: VehicleKind, g: Geo, ctx: BodyCtx, axles: Axle[], style: WheelStyle, mass: number, seat: V3): Built {
  for (const p of ctx.B.front.patches) endPatch(g, ctx.front, p);
  for (const p of ctx.B.rear.patches) endPatch(g, ctx.rear, p);
  const body = finalize(g, 38);
  const a0 = axles[0];
  const wheel = buildWheel(a0.R, a0.tw, a0.rimR, style);
  const wheels: [number, number, number][] = [];
  for (const a of axles) {
    wheels.push(v3(a.x, a.R, a.z), v3(-a.x, a.R, a.z));
    if (a.dual) { const xi = a.x - a.tw - 0.02; wheels.push(v3(xi, a.R, a.z), v3(-xi, a.R, a.z)); }
  }
  void kind;
  return { body, wheel, wheelRadius: a0.R, wheels, mass, driverSeat: v3(seat[0], seat[1], seat[2]) };
}

// ---------------- the classic passenger car family (sedan / hatch / wagon / suv / taxi / police / sports)

interface FamilyOpts {
  kind: VehicleKind;
  variant: number;
  rng: Rng;
}

function lightsCar(p: { innerF: number; innerR: number; hY: number; tY: number; plateRearY: number; grilleTop: number; grilleW: number; chromeGrille: boolean;
  intakeY: number; fog: boolean; headStyle: number; tailWrap: number; tailStyle: number; low: number }): { f: Patch[]; r: Patch[] } {
  const f: Patch[] = [];
  const r: Patch[] = [];
  const hY = p.hY;
  const plateF = 0.26 / p.innerF, plateR = 0.26 / p.innerR;
  // headlights
  if (p.headStyle === 0) {
    f.push({ u0: 0.6, u1: 1.85, yb0: hY - 0.06, yb1: hY - 0.02, yt0: hY + 0.05, yt1: hY + 0.055, part: VPart.Headlight, frame: 0.07, framePart: VPart.Plastic, skirt: true, nx: 6 });
  } else if (p.headStyle === 1) {
    // slim swept LED
    f.push({ u0: 0.55, u1: 1.85, yb0: hY - 0.035, yb1: hY + 0.0, yt0: hY + 0.04, yt1: hY + 0.05, part: VPart.Headlight, frame: 0.06, framePart: VPart.Chrome, skirt: true, nx: 7 });
  } else {
    // tall, upright (older / boxy)
    f.push({ u0: 0.58, u1: 1.6, yb0: hY - 0.06, yb1: hY - 0.06, yt0: hY + 0.05, yt1: hY + 0.05, part: VPart.Headlight, frame: 0.08, framePart: VPart.Chrome, skirt: true, nx: 5 });
  }
  f.push({ u0: p.headStyle === 2 ? 1.6 : 1.85, u1: p.headStyle === 2 ? 1.92 : 1.98, yb0: hY - (p.headStyle === 2 ? 0.06 : 0.0), yb1: hY - (p.headStyle === 2 ? 0.06 : 0.0), yt0: hY + 0.04, yt1: hY + 0.04, part: VPart.Indicator, nx: 2, lift: 0.007 });
  // grille
  f.push({ u0: 0, u1: p.grilleW, yb0: hY - 0.13, yb1: hY - 0.11, yt0: p.grilleTop, yt1: p.grilleTop - 0.01, part: VPart.Plastic, frame: p.chromeGrille ? 0.1 : 0.05, framePart: p.chromeGrille ? VPart.Chrome : VPart.Plastic, centered: true, nx: 3, ny: 2 });
  // lower intake
  f.push({ u0: 0, u1: 0.78, yb0: p.low + 0.04, yb1: p.low + 0.07, yt0: p.intakeY, yt1: p.intakeY - 0.02, part: VPart.Plastic, centered: true, nx: 3 });
  if (p.fog) f.push({ u0: 0.82, u1: 1.02, yb0: p.low + 0.07, yb1: p.low + 0.08, yt0: p.low + 0.13, yt1: p.low + 0.13, part: VPart.Headlight, frame: 0.12, framePart: VPart.Plastic, nx: 2 });
  // front plate
  f.push({ u0: 0, u1: plateF, yb0: p.intakeY + 0.012, yb1: p.intakeY + 0.012, yt0: p.intakeY + 0.122, yt1: p.intakeY + 0.122, part: VPart.Plate, centered: true, nx: 1, lift: 0.012 });
  // taillights
  const tY = p.tY;
  if (p.tailStyle === 0) {
    r.push({ u0: 0.52, u1: 2 + p.tailWrap, yb0: tY - 0.03, yb1: tY - 0.045, yt0: tY + 0.06, yt1: tY + 0.06, part: VPart.Taillight, skirt: true, nx: 6 });
    r.push({ u0: 0.52, u1: 1.5, yb0: tY - 0.07, yb1: tY - 0.07, yt0: tY - 0.035, yt1: tY - 0.05, part: VPart.Indicator, nx: 3 });
  } else if (p.tailStyle === 1) {
    // full-width light bar
    r.push({ u0: 0, u1: 2 + p.tailWrap, yb0: tY - 0.015, yb1: tY - 0.04, yt0: tY + 0.03, yt1: tY + 0.05, part: VPart.Taillight, centered: true, skirt: true, nx: 7 });
    r.push({ u0: 1.2, u1: 2 + p.tailWrap, yb0: tY - 0.07, yb1: tY - 0.08, yt0: tY - 0.025, yt1: tY - 0.045, part: VPart.Indicator, nx: 3 });
  } else {
    // vertical corner lamps
    r.push({ u0: 0.78, u1: 2 + p.tailWrap, yb0: tY - 0.2, yb1: tY - 0.2, yt0: tY + 0.08, yt1: tY + 0.08, part: VPart.Taillight, skirt: true, nx: 5, ny: 2 });
    r.push({ u0: 0.78, u1: 2 + p.tailWrap, yb0: tY - 0.27, yb1: tY - 0.27, yt0: tY - 0.215, yt1: tY - 0.215, part: VPart.Indicator, nx: 3 });
  }
  r.push({ u0: 0, u1: plateR, yb0: p.plateRearY, yb1: p.plateRearY, yt0: p.plateRearY + 0.11, yt1: p.plateRearY + 0.11, part: VPart.Plate, centered: true, nx: 1, lift: 0.012 });
  return { f, r };
}

function buildPassenger(o: FamilyOpts): Built {
  const { kind, variant: v, rng } = o;
  const g = new Geo();
  const j = (a: number) => 1 + rng.range(-a, a);
  const base = kind === 'taxi' || kind === 'police' ? 'sedan' : kind;

  // ---- dimensions per family
  let L: number, W: number, H: number, R: number, tw: number, rimR: number, fo: number, wb: number;
  let yb: number, belt: number, hoodF: number, cowl: number, deck: number, tailTop: number;
  let zAf: number, wsLen: number, roofEndF: number, rwLen: number, sideEndF: number;
  let tumble = 0.17, inset = 0.1, topDrop = 0.09, ghCrown = 0.03, crown = 0.035;
  let rcF = 0.34, rcR = 0.3;
  let noseExt: [number, number][], tailExt: [number, number][];
  let style: WheelStyle = (['five', 'multi', 'twin', 'cap'] as WheelStyle[])[v % 4];
  let mass = 1500;
  let cladding = false;
  let bPillarPart: number = VPart.Plastic;
  let trim: number = VPart.Plastic;
  let headStyle = v % 3, tailStyle = v % 2;
  let roofPart: number = VPart.Paint;
  let twoDoor = false;
  let extraPillar: { z: number; w: number; part: number } | null = null;
  let tailWrap = 0.1;

  switch (base) {
    case 'hatch':
      L = 4.12 * j(0.03); W = 1.78 * j(0.015); H = 1.47 * j(0.025); R = 0.315; tw = 0.205; rimR = 0.195;
      fo = 0.83; wb = 2.6 * j(0.02);
      yb = 0.15; belt = 0.98; hoodF = 0.78; cowl = 0.955; deck = belt + 0.01; tailTop = belt;
      zAf = 0.235; wsLen = 0.76; roofEndF = 0.86; rwLen = 0.4; sideEndF = 0.73;
      noseExt = [[0.15, 0.27], [0.3, 0.33], [0.45, 0.35], [0.6, 0.33], [0.72, 0.27], [0.82, 0.2]];
      tailExt = [[0.18, 0.08], [0.35, 0.13], [0.6, 0.14], [0.85, 0.12], [1.0, 0.08]];
      rcR = 0.3; mass = 1200; tailStyle = v === 1 ? 1 : 2; tailWrap = 0.07;
      if (v === 1) { twoDoor = true; }
      if (v === 2) { H += 0.08; belt += 0.03; }
      if (v === 3) { H -= 0.03; style = 'twin'; R = 0.32; rimR = 0.215; }
      break;
    case 'wagon':
      L = 4.86 * j(0.02); W = 1.85 * j(0.015); H = 1.49 * j(0.02); R = 0.33; tw = 0.225; rimR = 0.215;
      fo = 0.92; wb = 2.84 * j(0.015);
      yb = 0.16; belt = 1.0; hoodF = 0.79; cowl = 0.965; deck = 1.0; tailTop = 0.99;
      zAf = 0.27; wsLen = 0.8; roofEndF = 0.9; rwLen = 0.3; sideEndF = 0.86;
      noseExt = [[0.15, 0.28], [0.3, 0.36], [0.45, 0.38], [0.6, 0.36], [0.72, 0.3], [0.82, 0.22]];
      tailExt = [[0.2, 0.12], [0.4, 0.17], [0.7, 0.17], [0.9, 0.13], [1.02, 0.08]];
      mass = 1600; tailStyle = 2; tailWrap = 0.1;
      extraPillar = { z: 0, w: 0.09, part: VPart.Paint };
      if (v === 2) { roofEndF = 0.84; rwLen = 0.4; sideEndF = 0.8; }
      if (v === 3) { headStyle = 2; trim = VPart.Chrome; style = 'cap'; }
      break;
    case 'suv':
      L = 4.72 * j(0.03); W = 1.92 * j(0.015); H = 1.72 * j(0.03); R = 0.37; tw = 0.245; rimR = 0.245;
      fo = 0.92; wb = 2.82 * j(0.02);
      yb = 0.21; belt = 1.14; hoodF = 0.98; cowl = 1.11; deck = 1.13; tailTop = 1.12;
      zAf = 0.27; wsLen = 0.72; roofEndF = 0.9; rwLen = 0.3; sideEndF = 0.83;
      noseExt = [[0.25, 0.22], [0.45, 0.3], [0.6, 0.32], [0.78, 0.3], [0.9, 0.24], [1.0, 0.16]];
      tailExt = [[0.25, 0.1], [0.45, 0.15], [0.8, 0.16], [1.05, 0.12], [1.15, 0.07]];
      rcF = 0.4; rcR = 0.32; tumble = 0.15; mass = 2000; cladding = v !== 1; tailStyle = 2; tailWrap = 0.12;
      style = (['six', 'five', 'multi', 'twin'] as WheelStyle[])[v];
      extraPillar = { z: 0, w: 0.09, part: VPart.Paint };
      if (v === 1) { H += 0.08; headStyle = 2; tumble = 0.1; wsLen = 0.55; }
      if (v === 2) { roofEndF = 0.76; rwLen = 0.6; sideEndF = 0.72; H -= 0.06; extraPillar = null; } // coupé SUV
      if (v === 3) { roofPart = VPart.Glass; }
      break;
    case 'sports':
      L = 4.45 * j(0.03); W = 1.9 * j(0.015); H = 1.24 * j(0.03); R = 0.34; tw = 0.255; rimR = 0.245;
      fo = 0.98; wb = 2.55 * j(0.02);
      yb = 0.11; belt = 0.86; hoodF = 0.6; cowl = 0.83; deck = 0.9; tailTop = 0.9;
      zAf = 0.39; wsLen = 0.66; roofEndF = 0.55; rwLen = 0.85; sideEndF = 0.655;
      noseExt = [[0.1, 0.3], [0.22, 0.38], [0.35, 0.4], [0.48, 0.37], [0.58, 0.3], [0.66, 0.22]];
      tailExt = [[0.15, 0.2], [0.3, 0.26], [0.55, 0.27], [0.78, 0.23], [0.92, 0.12]];
      tumble = 0.24; crown = 0.02; rcF = 0.48; rcR = 0.4; mass = 1450; twoDoor = true; headStyle = 1; tailStyle = v % 2;
      style = (['five', 'mesh', 'twin', 'six'] as WheelStyle[])[v];
      if (v === 1) { roofEndF = 0.6; rwLen = 0.8; }
      if (v === 3) { H += 0.03; deck = 0.93; }
      break;
    default: // sedan
      L = 4.72 * j(0.03); W = 1.84 * j(0.015); H = 1.45 * j(0.02); R = 0.33; tw = 0.225; rimR = 0.215;
      fo = 0.93; wb = 2.8 * j(0.02);
      yb = 0.165; belt = 0.99; hoodF = 0.79; cowl = 0.965; deck = 1.035; tailTop = 1.03;
      zAf = 0.325; wsLen = 0.78; roofEndF = 0.7; rwLen = 0.56; sideEndF = 0.76;
      noseExt = [[0.15, 0.28], [0.3, 0.36], [0.45, 0.38], [0.6, 0.36], [0.72, 0.3], [0.82, 0.22]];
      tailExt = [[0.2, 0.22], [0.4, 0.28], [0.6, 0.29], [0.85, 0.26], [1.05, 0.16]];
      mass = 1550;
      if (v === 1) { L += 0.15; deck -= 0.01; roofEndF = 0.68; }
      if (v === 2) { roofEndF = 0.66; rwLen = 0.7; sideEndF = 0.74; deck = 1.02; tailStyle = 1; } // fastback-ish
      if (v === 3) { headStyle = 2; trim = VPart.Chrome; style = 'cap'; tumble = 0.13; wsLen = 0.68; H += 0.03; tailStyle = 0; }
      if (kind === 'taxi') { style = 'cap'; }
      if (kind === 'police') { style = 'steel'; mass = 1700; }
      break;
  }
  if (base === 'sedan' && kind === 'taxi') H = Math.max(H, 1.46);

  const zF = -L / 2, zR = L / 2;
  const fx = (t: number) => zF + t * L;
  const zA = fx(zAf), zB = zA + wsLen;
  const zD0 = base === 'sedan' || base === 'sports' ? zB + (roofEndF - zAf) * L - wsLen + rwLen : 0;
  void zD0;
  let zC: number, zD: number;
  if (base === 'sedan' || base === 'sports') {
    zC = fx(roofEndF);
    zD = zC + rwLen;
  } else {
    zC = fx(roofEndF);
    zD = Math.min(zR - Math.max(...tailExt.map((e) => e[1])) - 0.01, zC + rwLen);
  }
  const sideEnd = fx(sideEndF);
  const bZ = lerp(zB, sideEnd, base === 'sports' ? 0.95 : twoDoor ? 0.62 : 0.43);
  const pillars: { z: number; w: number; part: number }[] = [];
  if (!twoDoor) pillars.push({ z: bZ, w: 0.095, part: bPillarPart });
  if (extraPillar) pillars.push({ z: lerp(bZ, sideEnd, 0.62), w: 0.1, part: VPart.Paint });
  // roof line
  let roofF: [number, number][];
  const ramp = (za: number, zb: number): [number, number][] => [[za, 0], [lerp(za, zb, 0.22), 0.32], [lerp(za, zb, 0.5), 0.66], [lerp(za, zb, 0.8), 0.92], [zb, 0.975]];
  if (base === 'sedan' || base === 'sports') {
    roofF = [...ramp(zA, zB), [zB + 0.3, 1], [zC - 0.35, 0.995], [zC, 0.95], [lerp(zC, zD, 0.3), 0.76], [lerp(zC, zD, 0.65), 0.42], [zD, 0]];
  } else {
    roofF = [...ramp(zA, zB), [zB + 0.3, 1], [zC - 0.3, 0.99], [zC, 0.955], [lerp(zC, zD, 0.5), 0.6], [zD, 0]];
    if (base === 'suv' && v === 2) roofF = [...ramp(zA, zB), [zB + 0.3, 1], [zC - 0.3, 0.985], [zC, 0.93], [lerp(zC, zD, 0.5), 0.62], [zD, 0]];
  }
  const roofH = H;
  const zFront0 = zF + Math.max(...noseExt.map((e) => e[1]));
  const zRear0 = zR - Math.max(...tailExt.map((e) => e[1]));
  const za = zF + fo, zb = za + wb;
  // door seams
  const seams: number[] = [zA + 0.04];
  if (!twoDoor) { seams.push(bZ); seams.push(Math.min(zb - (R + 0.065) - 0.04, sideEnd - 0.06)); }
  else seams.push(Math.min(sideEnd - 0.04, zb - (R + 0.065) - 0.04));
  const topSeams: number[] = [];
  if (base === 'sedan' || base === 'sports') topSeams.push(zD + 0.05);
  const gh: GHDef = {
    zA, zB, zC, zD, roofF, roofH, inset, tumble, topDrop, crown: ghCrown, bow: 0.012,
    sideStart: zA, sideEnd, pillars, trim, aPillar: VPart.Paint, roofPart, cPillar: VPart.Paint, extraZ: [],
  };
  if (kind === 'police') {
    const z0 = zA - 0.25, z1 = zb - 0.5;
    const ref = { z0, z1 };
    const prevOverride = undefined;
    void prevOverride;
    void ref;
  }
  const p: CarP = {
    L, W, R, tw, rimR, fo, wb, yb, ybF: yb + 0.1, ybR: yb + 0.12,
    hoodF, cowl, belt, deck, tailTop,
    wF: 0.955, wR: 0.975, crown, shoulderDrop: 0.075,
    noseExt, rcF, topRoundF: 0.035, tailExt, rcR, topRoundR: 0.03,
    capLowF: yb + 0.1, capLowR: yb + 0.17,
    gh, seams, topSeams, cladding, flare: base === 'suv' || base === 'sports' ? 0.02 : 0.012,
    deckZ: base === 'sedan' || base === 'sports' ? zD + 0.14 : undefined,
  };
  if (base === 'sports') { p.wR = 1.0; p.shoulderDrop = 0.06; p.ybF = yb + 0.06; p.ybR = yb + 0.12; }
  if (base === 'suv') { p.capLowF = yb + 0.16; p.capLowR = yb + 0.22; }
  if (kind === 'police') {
    const z0 = zA - 0.35, z1 = zb - R - 0.12;
    p.override = (zm, jj, _side, _ym) => (zm > z0 && zm < z1 && jj >= 5 && jj <= 8 ? VPart.Livery : -1);
    p.cuts = [z0, z1];
  }
  const { B, axles } = makeBody(p);
  const ctx = buildBody(g, B);
  const innerF = ctx.front.inner, innerR = ctx.rear.inner;
  const hY = lerp(p.hoodF, p.cowl, 0.05) - 0.1;
  const tYbase = base === 'sedan' || base === 'sports' ? tailTop - 0.11 : base === 'suv' ? belt - 0.08 : belt - 0.06;
  const lights = lightsCar({
    innerF, innerR, hY, tY: tYbase, plateRearY: base === 'sedan' || base === 'sports' ? tYbase - 0.32 : tYbase - 0.42,
    grilleTop: hY + 0.03, grilleW: base === 'suv' ? 0.62 : base === 'sports' ? 0.4 : 0.55, chromeGrille: v === 3 || (base === 'suv' && v === 1),
    intakeY: Math.max(p.ybF + 0.12, hY - 0.24), fog: v === 1 || base === 'suv', headStyle, tailWrap, tailStyle, low: p.ybF,
  });
  B.front.patches.push(...lights.f);
  B.rear.patches.push(...lights.r);

  addMirrors(g, ctx, lerp(zA, zB, 0.2));
  const handles = [bZ - 0.2];
  if (!twoDoor) handles.push(seams[2] - 0.17);
  if (twoDoor) handles[0] = seams[1] - 0.22;
  addHandles(g, ctx, handles);

  // exhaust(s)
  const exY = p.ybR + 0.06, exZ = zRear0 + 0.12;
  if (base === 'sports') { for (const s of [1, -1]) { tubeZ(g, [0.42, exY, exZ], 0.045, 0.3, 10, VPart.Chrome, VPart.Undercarriage, s); tubeZ(g, [0.3, exY, exZ], 0.045, 0.3, 10, VPart.Chrome, VPart.Undercarriage, s); } }
  else tubeZ(g, [0.45, exY - 0.02, exZ - 0.04], 0.03, 0.28, 8, VPart.Chrome, VPart.Undercarriage, 1);

  // roof add-ons
  const roofMidZ = lerp(zB, zC, 0.5);
  if (ctx.ghAt) {
    if (kind === 'taxi') {
      const y0 = ctx.roofY(roofMidZ - 0.1, 0) - 0.01;
      rbox(g, 0, 0.32, y0, y0 + 0.17, roofMidZ - 0.16, roofMidZ + 0.06, 0.04, (n, c) => (n[1] < -0.5 || c[1] < y0 + 0.03 ? VPart.Plastic : VPart.Roofsign));
    }
    if (kind === 'police') {
      const zz = lerp(zB, zC, 0.3);
      const y0 = ctx.roofY(zz, 0) - 0.012;
      rbox(g, 0, 0.62, y0 + 0.035, y0 + 0.12, zz - 0.13, zz + 0.13, 0.03, (n, c) => (n[1] < -0.5 ? VPart.Plastic : Math.abs(c[0]) < 0.09 && n[2] !== 0 ? VPart.Plastic : VPart.Lightbar));
      for (const s of [-0.45, 0.45]) rbox(g, s, 0.05, y0 - 0.01, y0 + 0.04, zz - 0.1, zz + 0.1, 0.01, () => VPart.Plastic);
      // push bumper
      const fz = zF + 0.02;
      rbox(g, 0, 0.42, p.ybF + 0.12, p.ybF + 0.42, fz - 0.06, fz + 0.04, 0.025, () => VPart.Plastic);
    }
    if ((base === 'wagon' && v === 1) || (base === 'suv' && v !== 2)) {
      const z0 = zB + 0.12, z1 = zC - 0.05;
      const r = ctx.ghAt(lerp(z0, z1, 0.5));
      const xr = r[5][0] - 0.02;
      const y0 = ctx.roofY(lerp(z0, z1, 0.5), xr);
      for (const s of [1, -1]) rbox(g, s * xr, 0.022, y0 - 0.02, y0 + 0.045, z0, z1, 0.015, () => (base === 'suv' && v === 3 ? VPart.Chrome : VPart.Plastic));
    }
    if ((base === 'sports' && v !== 1) || (base === 'hatch' && v === 3)) {
      if (base === 'sports') {
        const zw = zRear0 + 0.1;
        const yd = ctx.topY(zw, 0.3) + (v === 2 ? 0.16 : 0.03);
        rbox(g, 0, W / 2 - 0.12, yd, yd + 0.03, zw - 0.12, zw + 0.12, 0.012, (n) => (n[1] < -0.5 ? VPart.Plastic : VPart.Paint));
        if (v === 2) for (const s of [1, -1]) rbox(g, s * 0.5, 0.012, yd - 0.17, yd + 0.01, zw - 0.06, zw + 0.04, 0.005, () => VPart.Plastic);
      } else {
        const zz = zD - 0.06;
        const yr = ctx.roofY(zz - 0.05, 0);
        rbox(g, 0, W / 2 - 0.18, yr - 0.02, yr + 0.01, zz - 0.12, zz + 0.05, 0.012, () => VPart.Paint);
      }
    }
  }
  const seat: V3 = [-W * 0.2, yb + 0.33, lerp(zB, bZ, 0.55)];
  return finishCar(kind, g, ctx, axles, style, mass, seat);
}

// ---------------- van (one-box MPV / minibus with sliding door)

function buildVan(variant: number, rng: Rng): Built {
  const g = new Geo();
  const L = 4.95 * (1 + rng.range(-0.02, 0.02) + (variant === 2 ? 0.08 : 0)), W = 1.92, H = variant === 3 ? 2.05 : 1.95;
  const R = 0.34, tw = 0.225, rimR = 0.215;
  const zF = -L / 2, zR = L / 2;
  const fo = 0.92, wb = variant === 2 ? 3.4 : 3.0;
  const yb = 0.18, belt = 1.08;
  const noseExt: [number, number][] = [[0.2, 0.22], [0.4, 0.3], [0.6, 0.32], [0.8, 0.28], [0.95, 0.2], [1.05, 0.12]];
  const tailExt: [number, number][] = [[0.2, 0.08], [0.4, 0.1], [0.8, 0.1], [1.05, 0.07]];
  const zF0 = zF + 0.32, zR0 = zR - 0.1;
  const zA = zF0 + 0.12, zB = zA + 0.82;
  const zC = zR0 - 0.15, zD = zR0 - 0.02;
  const za = zF + fo, zb = za + wb;
  const bZ = za + R + 0.45;
  const slideEnd = bZ + 1.0;
  const sideEnd = zD - 0.12;
  const pillars = [{ z: bZ, w: 0.1, part: VPart.Plastic }, { z: slideEnd, w: 0.1, part: VPart.Plastic }];
  if (variant !== 2) pillars.push({ z: lerp(slideEnd, sideEnd, 0.55), w: 0.12, part: VPart.Plastic });
  const gh: GHDef = {
    zA, zB, zC, zD, roofF: [[zA, 0], [lerp(zA, zB, 0.25), 0.36], [lerp(zA, zB, 0.55), 0.72], [lerp(zA, zB, 0.85), 0.95], [zB, 0.985], [zB + 0.3, 1], [zC - 0.2, 0.995], [zC, 0.96], [zD, 0]],
    roofH: H, inset: 0.07, tumble: 0.1, topDrop: 0.12, crown: 0.035, bow: 0.012,
    sideStart: zA, sideEnd, pillars, trim: VPart.Plastic, aPillar: VPart.Paint, roofPart: VPart.Paint, cPillar: VPart.Paint, extraZ: [],
  };
  const seams = [zA + 0.05, bZ, slideEnd];
  const p: CarP = {
    L, W, R, tw, rimR, fo, wb, yb, ybF: yb + 0.12, ybR: yb + 0.14,
    hoodF: 0.88, cowl: 1.03, belt, deck: belt, tailTop: belt - 0.01, hoodMid: 0.97,
    wF: 0.95, wR: 0.985, crown: 0.03, shoulderDrop: 0.07, tumbleLow: 0.03,
    noseExt, rcF: 0.36, topRoundF: 0.04, tailExt, rcR: 0.25, topRoundR: 0.02,
    capLowF: yb + 0.14, capLowR: yb + 0.18,
    gh, seams, topSeams: [], flare: 0.012,
  };
  const { B, axles } = makeBody(p);
  // sliding door rail (dark seam along the window line behind the sliding door)
  const ctx = buildBody(g, B);
  const hY = 0.82;
  const L2 = lightsCar({
    innerF: ctx.front.inner, innerR: ctx.rear.inner, hY, tY: belt - 0.05, plateRearY: belt - 0.45, grilleTop: hY + 0.02, grilleW: 0.6,
    chromeGrille: variant === 1, intakeY: 0.42, fog: variant === 1, headStyle: variant === 3 ? 2 : 0, tailWrap: 0.08, tailStyle: 2, low: p.ybF,
  });
  B.front.patches.push(...L2.f);
  B.rear.patches.push(...L2.r);
  addMirrors(g, ctx, lerp(zA, zB, 0.28), 1.15);
  addHandles(g, ctx, [bZ - 0.2, slideEnd - 0.12]);
  // sliding door rail
  {
    const z0 = slideEnd + 0.02, z1 = zD - 0.25;
    const y = belt + 0.01;
    const x = ctx.sideX((z0 + z1) / 2, belt - 0.08);
    rbox(g, x - 0.01, 0.012, y - 0.012, y + 0.008, z0, z1, 0.004, () => VPart.Plastic);
  }
  if (variant === 1 && ctx.ghAt) {
    const z0 = zB + 0.15, z1 = zC - 0.1;
    const xr = ctx.ghAt((z0 + z1) / 2)[5][0] - 0.02;
    const y0 = ctx.roofY((z0 + z1) / 2, xr);
    for (const s of [1, -1]) rbox(g, s * xr, 0.022, y0 - 0.02, y0 + 0.045, z0, z1, 0.015, () => VPart.Plastic);
  }
  tubeZ(g, [0.5, p.ybR + 0.04, zR0 + 0.04], 0.03, 0.25, 8, VPart.Chrome, VPart.Undercarriage, 1);
  void zb;
  return finishCar('van', g, ctx, axles, variant === 3 ? 'steel' : (['five', 'six', 'multi'] as WheelStyle[])[variant % 3], 2100, [-0.42, 0.62, lerp(zA, bZ, 0.62)]);
}

// ---------------- pickup

function buildPickup(variant: number, rng: Rng): Built {
  const g = new Geo();
  const crew = variant !== 1;
  const L = (crew ? 5.6 : 5.25) * (1 + rng.range(-0.02, 0.02)), W = 2.0, H = 1.86 + (variant === 3 ? 0.06 : 0);
  const R = 0.4, tw = 0.265, rimR = variant === 2 ? 0.27 : 0.25;
  const zF = -L / 2, zR = L / 2;
  const fo = 0.95, wb = crew ? 3.55 : 3.2;
  const yb = 0.26, belt = 1.27;
  const noseExt: [number, number][] = [[0.3, 0.17], [0.5, 0.24], [0.75, 0.25], [1.0, 0.24], [1.15, 0.2]];
  const tailExt: [number, number][] = [[0.35, 0.07], [0.6, 0.09], [1.0, 0.09], [1.25, 0.07]];
  const zF0 = zF + 0.25, zR0 = zR - 0.09;
  const zA = zF0 + 1.12, zB = zA + 0.62;
  const cabLen = crew ? 1.75 : 1.05;
  const zD = zB + cabLen + 0.05, zC = zD - 0.07;
  const bed = { z0: zD + 0.04, z1: zR0 - 0.06, railY: belt + 0.01, floorY: 0.92 };
  const bZ = crew ? lerp(zB, zC, 0.42) : zC + 0.2;
  const pillars = crew ? [{ z: bZ, w: 0.1, part: VPart.Plastic }] : [];
  const gh: GHDef = {
    zA, zB, zC, zD, roofF: [[zA, 0], [lerp(zA, zB, 0.25), 0.36], [lerp(zA, zB, 0.55), 0.72], [lerp(zA, zB, 0.85), 0.95], [zB, 0.985], [zB + 0.25, 1], [zC - 0.1, 0.995], [zC, 0.94], [zD, 0]],
    roofH: H, inset: 0.085, tumble: 0.13, topDrop: 0.1, crown: 0.025, bow: 0.01,
    sideStart: zA, sideEnd: zC - 0.12, pillars, trim: variant === 3 ? VPart.Chrome : VPart.Plastic, aPillar: VPart.Paint, roofPart: VPart.Paint, cPillar: VPart.Paint, extraZ: [],
  };
  const seams = crew ? [zA + 0.05, bZ, zC - 0.04] : [zA + 0.05, zC - 0.04];
  const p: CarP = {
    L, W, R, tw, rimR, fo, wb, yb, ybF: yb + 0.12, ybR: yb + 0.1,
    hoodF: 1.12, cowl: 1.235, belt, deck: belt + 0.01, tailTop: belt + 0.01, hoodMid: 1.19,
    wF: 0.96, wR: 0.99, crown: 0.025, shoulderDrop: 0.07, tumbleLow: 0.02,
    noseExt, rcF: 0.24, topRoundF: 0.03, tailExt, rcR: 0.12, topRoundR: 0.01,
    capLowF: yb + 0.2, capLowR: yb + 0.22,
    gh, seams, topSeams: [], cladding: variant === 0 || variant === 2, flare: 0.03, Ra: R + 0.07,
    bed, deckZ: zD + 0.03, cuts: [],
  };
  const { B, axles } = makeBody(p);
  const ctx = buildBody(g, B);
  const hY = 0.98;
  const iF = ctx.front.inner;
  B.front.patches.push(
    { u0: 0.64, u1: 1.75, yb0: hY - 0.06, yb1: hY - 0.05, yt0: hY + 0.06, yt1: hY + 0.065, part: VPart.Headlight, frame: 0.08, framePart: VPart.Chrome, skirt: true, nx: 5 },
    { u0: 1.75, u1: 2.04, yb0: hY - 0.04, yb1: hY - 0.03, yt0: hY + 0.03, yt1: hY + 0.03, part: VPart.Indicator, nx: 2 },
    { u0: 0, u1: 0.62, yb0: 0.66, yb1: 0.68, yt0: 1.06, yt1: 1.06, part: VPart.Plastic, frame: 0.08, framePart: variant === 1 ? VPart.Plastic : VPart.Chrome, centered: true, nx: 3, ny: 3 },
    { u0: 0, u1: 0.26 / iF, yb0: 0.5, yb1: 0.5, yt0: 0.61, yt1: 0.61, part: VPart.Plate, centered: true, nx: 1, lift: 0.016 },
  );
  // front bumper bar
  rbox(g, 0, W / 2 - 0.05, yb + 0.12, yb + 0.33, zF - 0.02, zF + 0.16, 0.05, () => (variant === 3 ? VPart.Chrome : VPart.Plastic));
  B.rear.patches.push(
    { u0: 1.55, u1: 2.06, yb0: 0.86, yb1: 0.86, yt0: 1.2, yt1: 1.2, part: VPart.Taillight, skirt: true, nx: 3, ny: 2 },
    { u0: 1.55, u1: 2.06, yb0: 0.8, yb1: 0.8, yt0: 0.855, yt1: 0.855, part: VPart.Indicator, nx: 2 },
  );
  // rear step bumper + plate
  const zr = zR - 0.02;
  rbox(g, 0, W / 2 - 0.05, yb + 0.1, yb + 0.3, zr - 0.2, zr + 0.02, 0.04, () => (variant === 3 || variant === 1 ? VPart.Chrome : VPart.Plastic));
  {
    const y0 = yb + 0.15;
    const quad = (z: number) => {
      const a: V3 = [-0.26, y0, z], b: V3 = [0.26, y0, z], c: V3 = [0.26, y0 + 0.11, z], d: V3 = [-0.26, y0 + 0.11, z];
      g.quadN(a, b, c, d, [0, 0], [1, 0], [1, 1], [0, 1], VPart.Plate, [0, 0, 1]);
    };
    quad(zr + 0.025);
  }
  addMirrors(g, ctx, lerp(zA, zB, 0.22), 1.25, 0.03);
  addHandles(g, ctx, crew ? [bZ - 0.2, zC - 0.2] : [zC - 0.22]);
  tubeZ(g, [0.55, yb + 0.05, zR - 0.15], 0.035, 0.3, 8, VPart.Chrome, VPart.Undercarriage, 1);
  if (variant === 3) {
    // roll bar / sport bar
    const y0 = belt + 0.0, z = bed.z0 + 0.2;
    for (const s of [1, -1]) rbox(g, s * (W / 2 - 0.2), 0.03, y0 - 0.05, y0 + 0.42, z - 0.03, z + 0.03, 0.02, () => VPart.Plastic);
    rbox(g, 0, W / 2 - 0.17, y0 + 0.38, y0 + 0.44, z - 0.03, z + 0.03, 0.02, () => VPart.Plastic);
  }
  return finishCar('pickup', g, ctx, axles, (['six', 'steel', 'five', 'multi'] as WheelStyle[])[variant], 2300, [-0.45, 0.85, lerp(zA, zB, 0.95) + 0.35]);
}

// ---------------- city bus

function buildBus(variant: number, rng: Rng): Built {
  const g = new Geo();
  const L = variant === 2 ? 10.6 : 12.0, W = 2.55, H = 3.0;
  const R = 0.5, tw = 0.28, rimR = 0.29;
  const zF = -L / 2, zR = L / 2;
  const fo = 2.7, wb = variant === 2 ? 4.9 : 5.9;
  const yb = 0.3, belt = 1.06;
  const noseExt: [number, number][] = [[0.3, 0.1], [0.6, 0.12], [1.0, 0.1], [1.15, 0.06]];
  const tailExt: [number, number][] = [[0.3, 0.07], [0.6, 0.09], [1.0, 0.08], [1.15, 0.06]];
  const zF0 = zF + 0.12, zR0 = zR - 0.09;
  const zA = zF0 + 0.02, zB = zA + 0.2;
  const zD = zR0 - 0.02, zC = zD - 0.08;
  const za = zF + fo, zb = za + wb;
  const d1: [number, number] = [zF0 + 0.25, zF0 + 1.45];
  const d2: [number, number] = [lerp(za, zb, 0.5) - 0.65, lerp(za, zb, 0.5) + 0.65];
  const doors: [number, number][] = [d1, d2];
  if (variant !== 2) doors.push([zb + R + 0.2, zb + R + 1.4]);
  const inDoor = (z: number) => doors.find((d) => z > d[0] && z < d[1]);
  const doorPart = (z: number) => {
    const d = inDoor(z);
    if (!d) return -1;
    const mid = (d[0] + d[1]) / 2;
    if (z < d[0] + 0.05 || z > d[1] - 0.05 || Math.abs(z - mid) < 0.015) return VPart.Rubber;
    return VPart.Glass;
  };
  // window pillars
  const pillars: { z: number; w: number; part: number }[] = [];
  const winStart = zB + 0.15, winEnd = zC - 0.25;
  const nWin = Math.round((winEnd - winStart) / 1.35);
  for (let i = 0; i <= nWin; i++) pillars.push({ z: lerp(winStart, winEnd, i / nWin), w: 0.09, part: VPart.Plastic });
  const extra: number[] = [];
  for (const d of doors) { extra.push(d[0], d[0] + 0.05, (d[0] + d[1]) / 2 - 0.015, (d[0] + d[1]) / 2 + 0.015, d[1] - 0.05, d[1]); }
  const gh: GHDef = {
    zA, zB, zC, zD, roofF: [[zA, 0], [lerp(zA, zB, 0.3), 0.4], [lerp(zA, zB, 0.7), 0.85], [zB, 0.97], [zB + 0.25, 1], [zC - 0.2, 1], [zC, 0.98], [zD, 0]],
    roofH: H, inset: 0.035, tumble: 0.05, topDrop: 0.3, crown: 0.04, bow: 0.0,
    sideStart: zA + 0.1, sideEnd: zC - 0.05, pillars, trim: VPart.Plastic, aPillar: VPart.Plastic, roofPart: VPart.Paint, cPillar: VPart.Paint, extraZ: extra,
    override: (zm, jj, side, ym) => {
      if (zm < zB && jj >= 4) {
        if (ym > H - 0.32) return jj >= 5 ? VPart.Roofsign : VPart.Plastic;
        return VPart.Glass;
      }
      if (zm > zC && jj >= 4) return ym > 2.15 && ym < H - 0.3 && jj >= 6 ? VPart.Glass : VPart.Paint;
      if (side > 0 && jj <= 3) { const d = doorPart(zm); if (d >= 0) return d; }
      return -1;
    },
  };
  const p: CarP = {
    L, W, R, tw, rimR, fo, wb, dualRear: true, Ra: R + 0.07, flare: 0.004,
    yb, ybF: yb + 0.04, ybR: yb + 0.06,
    hoodF: 0.98, cowl: belt - 0.02, belt, deck: belt, tailTop: belt, hoodMid: belt - 0.04,
    wF: 0.985, wR: 0.99, crown: 0.0, shoulderDrop: 0.06, rockerIn: 0.012, tumbleLow: 0.008,
    noseExt, rcF: 0.22, topRoundF: 0.01, tailExt, rcR: 0.2, topRoundR: 0.01, botRound: 0.03,
    capLowF: yb + 0.12, capLowR: yb + 0.12,
    gh, seams: [], topSeams: [], step: 0.9, cuts: doors.flatMap((d) => [d[0], d[0] + 0.05, (d[0] + d[1]) / 2 - 0.015, (d[0] + d[1]) / 2 + 0.015, d[1] - 0.05, d[1]]),
    override: (zm, jj, side, _ym) => {
      if (side > 0 && jj >= 2 && jj <= 10) { const d = doorPart(zm); if (d >= 0) return d; }
      if (jj >= 3 && jj <= 4 && !inDoor(zm)) return VPart.Plastic; // skirt line
      return -1;
    },
  };
  const { B, axles } = makeBody(p);
  const ctx = buildBody(g, B);
  B.front.patches.push(
    { u0: 0.62, u1: 1.6, yb0: 0.5, yb1: 0.5, yt0: 0.64, yt1: 0.64, part: VPart.Headlight, frame: 0.08, framePart: VPart.Plastic, skirt: true, nx: 4 },
    { u0: 1.6, u1: 2.03, yb0: 0.5, yb1: 0.5, yt0: 0.6, yt1: 0.6, part: VPart.Indicator, nx: 2 },
    { u0: 0, u1: 0.26 / ctx.front.inner, yb0: 0.42, yb1: 0.42, yt0: 0.53, yt1: 0.53, part: VPart.Plate, centered: true, nx: 1, lift: 0.01 },
    { u0: 0, u1: 0.5, yb0: 0.72, yb1: 0.72, yt0: 0.92, yt1: 0.92, part: VPart.Plastic, centered: true, nx: 2 },
  );
  B.rear.patches.push(
    { u0: 1.55, u1: 2.04, yb0: 0.55, yb1: 0.55, yt0: 1.0, yt1: 1.0, part: VPart.Taillight, skirt: true, nx: 2, ny: 2 },
    { u0: 1.55, u1: 2.04, yb0: 1.02, yb1: 1.02, yt0: 1.12, yt1: 1.12, part: VPart.Indicator, nx: 2 },
    { u0: 0, u1: 0.26 / ctx.rear.inner, yb0: 0.55, yb1: 0.55, yt0: 0.66, yt1: 0.66, part: VPart.Plate, centered: true, nx: 1, lift: 0.01 },
    { u0: 0, u1: 0.7, yb0: 1.35, yb1: 1.35, yt0: 1.95, yt1: 1.95, part: VPart.Plastic, centered: true, nx: 2 },
  );
  // roof AC pod
  const roofTop = H;
  rbox(g, 0, 0.85, roofTop - 0.04, roofTop + 0.2, -1.2, 1.2, 0.08, (n) => (n[1] < -0.5 ? VPart.Undercarriage : VPart.Paint), 2);
  rbox(g, 0, 0.6, roofTop - 0.04, roofTop + 0.13, zR0 - 1.9, zR0 - 0.2, 0.06, (n) => (n[1] < -0.5 ? VPart.Undercarriage : VPart.Paint), 2);
  // mirrors on arms
  for (const s of [1, -1]) {
    const x = W / 2 + 0.12, z = zF - 0.1;
    rbox(g, s * (W / 2 - 0.05), 0.12, 2.2, 2.24, z - 0.02, z + 0.02, 0.01, () => VPart.Plastic);
    blob(g, [x, 1.95, z], [0.05, 0.22, 0.06], 6, 4, 0.4, (d) => (d[2] > 0.5 ? VPart.Chrome : VPart.Plastic), s);
  }
  // bumpers
  rbox(g, 0, W / 2 - 0.02, yb + 0.02, yb + 0.2, zF - 0.02, zF + 0.1, 0.04, () => VPart.Plastic);
  rbox(g, 0, W / 2 - 0.02, yb + 0.02, yb + 0.2, zR - 0.1, zR + 0.02, 0.04, () => VPart.Plastic);
  return finishCar('bus', g, ctx, axles, 'steel', 12500, [-0.75, 1.15, zF + 0.95]);
}

// ---------------- driverless shuttle

/**
 * Autonomous shuttle pod: a short, symmetric box with glass at both ends and big side windows,
 * a sliding double door on the right, no mirrors (sensor stalks instead), a lidar puck on the
 * roof and turquoise automated-driving marker lamps along both ends. v1/v3 are a little longer.
 */
function buildShuttle(variant: number, rng: Rng): Built {
  const g = new Geo();
  const L = (variant % 2 ? 5.2 : 4.7) * (1 + rng.range(-0.01, 0.01)), W = 2.06, H = 2.62;
  const R = 0.36, tw = 0.235, rimR = 0.24;
  const zF = -L / 2, zR = L / 2;
  const fo = 0.8, wb = L - 1.6;
  const yb = 0.24, belt = 0.92;
  const noseExt: [number, number][] = [[0.3, 0.1], [0.6, 0.13], [1.0, 0.12], [1.15, 0.08]];
  const tailExt = noseExt;
  const zF0 = zF + 0.14, zR0 = zR - 0.14;
  const zA = zF0 + 0.03, zB = zA + 0.28;
  const zD = zR0 - 0.03, zC = zD - 0.28;
  const mid = 0;
  const door: [number, number] = [mid - 0.7, mid + 0.7];
  const inDoor = (z: number) => z > door[0] && z < door[1];
  const doorPart = (z: number) => {
    if (!inDoor(z)) return -1;
    if (z < door[0] + 0.05 || z > door[1] - 0.05 || Math.abs(z - mid) < 0.015) return VPart.Rubber;
    return VPart.Glass;
  };
  const pillars: { z: number; w: number; part: number }[] = [];
  const winStart = zB + 0.1, winEnd = zC - 0.1;
  const nWin = Math.max(2, Math.round((winEnd - winStart) / 1.15));
  for (let i = 0; i <= nWin; i++) pillars.push({ z: lerp(winStart, winEnd, i / nWin), w: 0.12, part: VPart.Plastic });
  const cuts = [door[0], door[0] + 0.05, mid - 0.015, mid + 0.015, door[1] - 0.05, door[1]];
  const ends = (ym: number) => (ym > H - 0.2 ? VPart.AdsLamp : ym > belt + 0.12 ? VPart.Glass : -1);
  const gh: GHDef = {
    zA, zB, zC, zD,
    roofF: [[zA, 0], [lerp(zA, zB, 0.3), 0.45], [lerp(zA, zB, 0.7), 0.88], [zB, 0.98], [zB + 0.25, 1], [zC - 0.25, 1], [zC, 0.98], [lerp(zC, zD, 0.3), 0.88], [lerp(zC, zD, 0.7), 0.45], [zD, 0]],
    roofH: H, inset: 0.04, tumble: 0.05, topDrop: 0.22, crown: 0.05, bow: 0.0,
    sideStart: zA + 0.08, sideEnd: zD - 0.08, pillars, trim: VPart.Plastic, aPillar: VPart.Plastic, roofPart: VPart.Paint, cPillar: VPart.Plastic, extraZ: cuts,
    override: (zm, jj, side, ym) => {
      if ((zm < zB || zm > zC) && jj >= 4) return ends(ym);
      if (side > 0 && jj <= 3) { const d = doorPart(zm); if (d >= 0) return d; }
      return -1;
    },
  };
  const p: CarP = {
    L, W, R, tw, rimR, fo, wb, flare: 0.004,
    yb, ybF: yb + 0.04, ybR: yb + 0.04,
    hoodF: belt - 0.04, cowl: belt - 0.02, belt, deck: belt, tailTop: belt, hoodMid: belt - 0.03,
    wF: 0.97, wR: 0.97, crown: 0.0, shoulderDrop: 0.05, rockerIn: 0.012, tumbleLow: 0.01,
    noseExt, rcF: 0.3, topRoundF: 0.02, tailExt, rcR: 0.3, topRoundR: 0.02, botRound: 0.04,
    capLowF: yb + 0.1, capLowR: yb + 0.1,
    gh, seams: [], topSeams: [], step: 0.6, cuts,
    override: (zm, jj, side, _ym) => {
      if (side > 0 && jj >= 2 && jj <= 10) { const d = doorPart(zm); if (d >= 0) return d; }
      if (jj >= 3 && jj <= 4 && !inDoor(zm)) return VPart.Plastic; // skirt line
      return -1;
    },
  };
  const { B, axles } = makeBody(p);
  const ctx = buildBody(g, B);
  // Thin LED head / tail light bands and a turquoise ADS band low on both ends.
  B.front.patches.push(
    { u0: 0.15, u1: 1.85, yb0: 0.6, yb1: 0.6, yt0: 0.66, yt1: 0.66, part: VPart.Headlight, skirt: true, nx: 6 },
    { u0: 0, u1: 0.26 / ctx.front.inner, yb0: 0.38, yb1: 0.38, yt0: 0.49, yt1: 0.49, part: VPart.Plate, centered: true, nx: 1, lift: 0.01 },
  );
  B.rear.patches.push(
    { u0: 0.15, u1: 1.85, yb0: 0.6, yb1: 0.6, yt0: 0.67, yt1: 0.67, part: VPart.Taillight, skirt: true, nx: 6 },
    { u0: 0, u1: 0.26 / ctx.rear.inner, yb0: 0.38, yb1: 0.38, yt0: 0.49, yt1: 0.49, part: VPart.Plate, centered: true, nx: 1, lift: 0.01 },
  );
  // Roof: sensor module with a spinning-lidar puck, corner sensor stalks.
  rbox(g, 0, 0.42, H - 0.03, H + 0.09, -0.45, 0.45, 0.06, (n) => (n[1] < -0.5 ? VPart.Undercarriage : VPart.Paint), 2);
  blob(g, [0, H + 0.17, 0], [0.13, 0.08, 0.13], 10, 6, 0.6, (d) => (Math.abs(d[1]) < 0.4 ? VPart.Glass : VPart.Plastic));
  for (const sx of [1, -1]) for (const z of [zF + 0.25, zR - 0.25]) blob(g, [sx * (W / 2 - 0.02), H - 0.35, z], [0.05, 0.07, 0.05], 6, 4, 0.5, () => VPart.Plastic, 1);
  // Bumpers.
  rbox(g, 0, W / 2 - 0.03, yb + 0.02, yb + 0.18, zF - 0.02, zF + 0.1, 0.04, () => VPart.Plastic);
  rbox(g, 0, W / 2 - 0.03, yb + 0.02, yb + 0.18, zR - 0.1, zR + 0.02, 0.04, () => VPart.Plastic);
  return finishCar('shuttle', g, ctx, axles, 'cap', 3200, [-0.6, 0.85, 0]);
}

// ---------------- box truck

/**
 * Box truck; the city's service trucks share its cab and chassis (the aftermath, src/game/aftermath):
 * 'fire' — an equipment body with lockers, a ladder on the roof and light bars; 'crane' — a mobile
 * crane (a flat deck, outriggers; its cab and boom turn and lift as the model's turret and gun);
 * 'flat' — a flatbed with low sides (the cleanup crews cart the carcass away on them).
 */
type TruckStyle = 'box' | 'fire' | 'crane' | 'flat';

function buildTruck(variant: number, rng: Rng, style: TruckStyle = 'box'): Built {
  const g = new Geo();
  const L = (variant === 1 ? 7.2 : 8.2) * (1 + rng.range(-0.01, 0.01)), W = 2.5, H = 3.5;
  const cabW = 2.3;
  const R = 0.46, tw = 0.26, rimR = 0.27;
  const zF = -L / 2, zR = L / 2;
  const cabLen = 2.05;
  const zCabR = zF + cabLen;
  const fo = 1.3, wb = variant === 1 ? 3.8 : 4.6;
  const yb = 0.5, belt = 1.7, cabH = variant === 2 ? 3.15 : 2.85;
  const noseExt: [number, number][] = [[0.5, 0.12], [0.9, 0.14], [1.4, 0.13], [1.7, 0.08]];
  const tailExt: [number, number][] = [[0.5, 0.04], [1.0, 0.05], [1.7, 0.04]];
  const zF0 = zF + 0.14, zR0 = zCabR - 0.05;
  const zA = zF0 + 0.06, zB = zA + 0.3;
  const zD = zR0 - 0.02, zC = zD - 0.06;
  const za = zF + fo;
  const gh: GHDef = {
    zA, zB, zC, zD, roofF: [[zA, 0], [lerp(zA, zB, 0.3), 0.4], [lerp(zA, zB, 0.7), 0.85], [zB, 0.97], [zB + 0.25, 1], [zC - 0.1, 1], [zC, 0.98], [zD, 0]],
    roofH: cabH, inset: 0.04, tumble: 0.06, topDrop: variant === 2 ? 0.45 : 0.18, crown: 0.04, bow: 0.0,
    sideStart: zA + 0.02, sideEnd: zC - 0.55, pillars: [], trim: VPart.Plastic, aPillar: VPart.Plastic, roofPart: VPart.Paint, cPillar: VPart.Paint, extraZ: [],
  };
  const p: CarP = {
    L: cabLen, W: cabW, zFront: zF, zRear: zCabR, R, tw, rimR, fo, wb, Ra: R + 0.09, flare: 0.01, rearArch: false,
    yb, ybF: yb + 0.05, ybR: yb,
    hoodF: 1.55, cowl: belt - 0.02, belt, deck: belt, tailTop: belt, hoodMid: belt - 0.06,
    wF: 0.98, wR: 1.0, crown: 0.0, shoulderDrop: 0.06, rockerIn: 0.015, tumbleLow: 0.01,
    noseExt, rcF: 0.2, topRoundF: 0.01, tailExt, rcR: 0.12, topRoundR: 0.0, botRound: 0.02,
    capLowF: yb + 0.12, capLowR: yb + 0.0,
    gh, seams: [zA + 0.08, zC - 0.5], topSeams: [], step: 0.5,
  };
  const { B, axles } = makeBody(p);
  // rear axle (dual, no arch in cab) — override position: wheels at full width of the box
  axles[1].z = za + wb;
  axles[1].x = W / 2 - tw / 2 - 0.08;
  axles[1].dual = true;
  const ctx = buildBody(g, B);
  const iF = ctx.front.inner;
  B.front.patches.push(
    { u0: 0.68, u1: 1.55, yb0: 0.72, yb1: 0.72, yt0: 0.86, yt1: 0.86, part: VPart.Headlight, frame: 0.08, framePart: VPart.Plastic, skirt: true, nx: 3 },
    { u0: 1.55, u1: 2.02, yb0: 0.72, yb1: 0.72, yt0: 0.82, yt1: 0.82, part: VPart.Indicator, nx: 2 },
    { u0: 0, u1: 0.62, yb0: 0.95, yb1: 0.95, yt0: 1.5, yt1: 1.5, part: VPart.Plastic, frame: 0.06, framePart: variant === 1 ? VPart.Chrome : VPart.Plastic, centered: true, nx: 3, ny: 3 },
    { u0: 0, u1: 0.26 / iF, yb0: 0.6, yb1: 0.6, yt0: 0.71, yt1: 0.71, part: VPart.Plate, centered: true, nx: 1, lift: 0.04 },
  );
  // bumper
  rbox(g, 0, cabW / 2 - 0.02, yb - 0.02, yb + 0.3, zF - 0.04, zF + 0.2, 0.05, () => VPart.Plastic);
  // cargo box (or the service body)
  const bz0 = zCabR + 0.08, bz1 = zR;
  const by0 = 1.18;
  if (style === 'box') rbox(g, 0, W / 2, by0, H, bz0, bz1, 0.05, (n) => (n[1] < -0.5 ? VPart.Undercarriage : VPart.Cargo), 2);
  else serviceBody(g, style, W, cabH, by0, bz0, bz1, zA, zB);
  // box bottom rail
  rbox(g, 0, W / 2 + 0.01, by0 - 0.12, by0 + 0.02, bz0 + 0.02, bz1 + 0.01, 0.01, () => VPart.Plastic, 1);
  // chassis rails
  for (const s of [1, -1]) rbox(g, s * 0.45, 0.06, 0.72, 0.98, zCabR - 0.6, zR - 0.15, 0.01, () => VPart.Undercarriage, 1);
  // fuel tank + side guards + mudguards
  const zr = za + wb;
  rbox(g, -(W / 2 - 0.35), 0.24, 0.5, 0.95, zCabR + 0.2, zCabR + 1.0, 0.18, () => VPart.Chrome, 2);
  for (const s of [1, -1]) {
    rbox(g, s * (W / 2 - 0.03), 0.02, 0.55, 0.65, zCabR + (s > 0 ? 0.2 : 1.1), zr - R - 0.25, 0.01, () => VPart.Plastic, 1);
    rbox(g, s * (W / 2 - 0.3), 0.32, R * 2 + 0.06, R * 2 + 0.1, zr - R - 0.2, zr + R + 0.25, 0.02, () => VPart.Plastic, 1);
  }
  // rear underride bar + rear lights
  rbox(g, 0, W / 2 - 0.1, 0.48, 0.62, zR - 0.1, zR - 0.02, 0.02, () => VPart.Plastic, 1);
  for (const s of [1, -1]) {
    rbox(g, s * (W / 2 - 0.25), 0.16, 1.0, 1.1, zR - 0.02, zR + 0.03, 0.01, (n) => (n[2] > 0.5 ? VPart.Taillight : VPart.Plastic), 1);
    rbox(g, s * (W / 2 - 0.5), 0.08, 1.0, 1.1, zR - 0.02, zR + 0.03, 0.01, (n) => (n[2] > 0.5 ? VPart.Indicator : VPart.Plastic), 1);
  }
  {
    const y0 = 0.98;
    const zq = zR + 0.03;
    g.quadN([-0.26, y0, zq], [0.26, y0, zq], [0.26, y0 + 0.11, zq], [-0.26, y0 + 0.11, zq], [0, 0], [1, 0], [1, 1], [0, 1], VPart.Plate, [0, 0, 1]);
  }
  // marker lights on box top front corners
  if (style === 'box') for (const s of [1, -1]) rbox(g, s * (W / 2 - 0.12), 0.05, H - 0.02, H + 0.02, bz0 - 0.01, bz0 + 0.06, 0.01, () => VPart.Indicator, 1);
  // mirrors on arms
  for (const s of [1, -1]) {
    const z = zA + 0.25;
    rbox(g, s * (cabW / 2 + 0.08), 0.1, 2.0, 2.03, z - 0.02, z + 0.02, 0.01, () => VPart.Plastic, 1);
    blob(g, [cabW / 2 + 0.2, 1.85, z], [0.05, 0.2, 0.06], 6, 4, 0.4, (d) => (d[2] > 0.5 ? VPart.Chrome : VPart.Plastic), s);
  }
  // steps
  for (const s of [1, -1]) rbox(g, s * (cabW / 2 - 0.12), 0.12, 0.62, 0.66, zCabR - 0.75, zCabR - 0.35, 0.01, () => VPart.Plastic, 1);
  addHandles(g, ctx, [zC - 0.6], 0.0);
  const built = finishCar('truck', g, ctx, axles, 'steel', style === 'crane' ? 16000 : style === 'fire' ? 14000 : 7500, [-0.6, 1.45, zA + 0.75]);
  if (style === 'crane') built.turret = { geo: craneCab(), pivot: [0, by0 + 0.12, (bz0 + bz1) / 2 + 0.6], gun: craneBoom(), gunPivot: CRANE_BOOM_PIVOT };
  return built;
}

/** The crane's boom pivot (in the cab's frame) and length; the hook hangs from its tip. */
export const CRANE_BOOM_PIVOT: [number, number, number] = [0, 1.55, 0.9];
export const CRANE_BOOM_LEN = 15.5;

/** A service truck's body behind the cab: fire engine, crane deck, flatbed. */
function serviceBody(g: Geo, style: TruckStyle, W: number, cabH: number, by0: number, bz0: number, bz1: number, zA: number, zB: number): void {
  if (style === 'fire') {
    // Equipment body with roller-shutter lockers, a hose reel at the back, the ladder on top.
    const top = cabH + 0.15;
    rbox(g, 0, W / 2, by0, top, bz0, bz1, 0.06, (n) => (n[1] < -0.5 ? VPart.Undercarriage : VPart.Paint), 2);
    const seg = (bz1 - bz0 - 0.5) / 3;
    for (const sx of [-1, 1]) for (let k = 0; k < 3; k++) {
      const z0 = bz0 + 0.25 + k * seg, z1 = z0 + seg - 0.12;
      rbox(g, sx * (W / 2 + 0.005), 0.012, by0 + 0.25, top - 0.25, z0, z1, 0.005, () => VPart.Chrome, 1);
      rbox(g, sx * (W / 2 + 0.02), 0.012, by0 + 0.8, by0 + 0.86, z0 + 0.1, z0 + 0.35, 0.005, () => VPart.Plastic, 1);
    }
    for (const sx of [-1, 1]) rbox(g, sx * (W / 2 - 0.02), 0.03, by0 + 0.05, by0 + 0.18, bz0, bz1, 0.01, () => VPart.Indicator, 1);
    tubeZ(g, [0, by0 + 0.75, bz1 + 0.12], 0.42, 0.22, 14, VPart.Plastic, VPart.Chrome, 1);
    // Ladder: two rails with rungs, resting on the roof from the cab back.
    for (const sx of [-1, 1]) rbox(g, sx * 0.48, 0.035, top + 0.1, top + 0.24, zA + 0.2, bz1 + 0.6, 0.01, () => VPart.Chrome, 1);
    for (let z = zA + 0.35; z < bz1 + 0.5; z += 0.38) rbox(g, 0, 0.47, top + 0.15, top + 0.19, z, z + 0.04, 0.01, () => VPart.Chrome, 1);
    // Light bars: over the cab and at the back.
    for (const [zz, y0] of [[zB + 0.35, cabH - 0.02], [bz1 - 0.2, top]] as [number, number][]) {
      rbox(g, 0, 0.8, y0, y0 + 0.12, zz - 0.15, zz + 0.15, 0.03, (n, c) => (n[1] < -0.5 ? VPart.Plastic : Math.abs(c[0]) < 0.1 && n[2] !== 0 ? VPart.Plastic : VPart.Lightbar));
    }
  } else if (style === 'crane') {
    // A flat steel deck with the slewing ring; outriggers down at the corners; a counterweight.
    rbox(g, 0, W / 2, by0, by0 + 0.12, bz0, bz1, 0.03, () => VPart.Undercarriage, 1);
    for (const sx of [-1, 1]) for (const zz of [bz0 + 0.3, bz1 - 0.3]) {
      rbox(g, sx * (W / 2 + 0.25), 0.3, by0 - 0.25, by0 + 0.05, zz - 0.18, zz + 0.18, 0.03, () => VPart.Paint, 1);
      rbox(g, sx * (W / 2 + 0.5), 0.2, 0.0, by0 - 0.25, zz - 0.2, zz + 0.2, 0.03, () => VPart.Undercarriage, 1);
      rbox(g, sx * (W / 2 + 0.5), 0.05, by0 - 0.24, by0 - 0.18, zz - 0.21, zz + 0.21, 0.01, () => VPart.Indicator, 1);
    }
    rbox(g, 0, W / 2 - 0.15, by0 + 0.12, by0 + 0.95, bz1 - 0.9, bz1 - 0.05, 0.08, () => VPart.Paint, 2);
  } else {
    // Flatbed: a deck, low drop sides, a headboard; amber beacons on the cab.
    rbox(g, 0, W / 2, by0, by0 + 0.14, bz0, bz1, 0.03, () => VPart.Undercarriage, 1);
    for (const sx of [-1, 1]) rbox(g, sx * (W / 2 - 0.04), 0.04, by0 + 0.14, by0 + 0.62, bz0 + 0.05, bz1 - 0.05, 0.02, () => VPart.Paint, 1);
    rbox(g, 0, W / 2 - 0.04, by0 + 0.14, by0 + 1.1, bz0 + 0.02, bz0 + 0.1, 0.02, () => VPart.Paint, 1);
    rbox(g, 0, W / 2 - 0.04, by0 + 0.14, by0 + 0.62, bz1 - 0.1, bz1 - 0.02, 0.02, () => VPart.Paint, 1);
    for (const sx of [-1, 1]) rbox(g, sx * (W / 2 - 0.15), 0.08, cabH - 0.02, cabH + 0.08, zB + 0.25, zB + 0.45, 0.02, () => VPart.Indicator, 1);
  }
}

/** The crane's slewing cab (an operator's window) on the deck; it turns about its centre. */
function craneCab(): THREE.BufferGeometry {
  const g = new Geo();
  rbox(g, 0, 1.05, 0.0, 0.55, -1.3, 1.7, 0.06, () => VPart.Paint, 2);
  rbox(g, 0.55, 0.42, 0.55, 2.1, -1.2, 0.2, 0.06, (n) => (n[2] < -0.5 || Math.abs(n[0]) > 0.5 ? VPart.Glass : VPart.Paint), 2);
  rbox(g, -0.45, 0.5, 0.55, 1.75, 0.0, 1.6, 0.06, () => VPart.Paint, 2);
  rbox(g, 0, 0.9, 0.55, 1.2, 1.1, 1.75, 0.06, () => VPart.Undercarriage, 1);
  return finalize(g, 38);
}

/** The boom: a tapering box along −Z from the pivot, the sheave at the tip (it pitches up). */
function craneBoom(): THREE.BufferGeometry {
  const g = new Geo();
  const L = CRANE_BOOM_LEN;
  rbox(g, 0, 0.42, -0.4, 0.4, -L * 0.55, 0.6, 0.05, () => VPart.Paint, 2);
  rbox(g, 0, 0.32, -0.3, 0.3, -L, -L * 0.5, 0.05, () => VPart.Paint, 2);
  rbox(g, 0, 0.2, -0.42, 0.22, -L - 0.25, -L + 0.15, 0.04, () => VPart.Plastic, 1);
  tubeZ(g, [0, -0.62, -2.2], 0.14, 4.2, 8, VPart.Chrome, VPart.Plastic, 1);
  return finalize(g, 38);
}

// ---------------- delivery van (high-roof panel van); the police tactical (SWAT) van is one with a
// light bar on the cab roof, a push bumper and running boards

function buildDelivery(variant: number, rng: Rng, swat = false, ambulance = false): Built {
  const g = new Geo();
  const L = (variant === 1 ? 5.3 : variant === 2 ? 6.6 : 5.93) * (1 + rng.range(-0.01, 0.01)), W = 2.02;
  const H = variant === 1 ? 2.45 : variant === 3 ? 2.3 : 2.68;
  const R = 0.36, tw = 0.235, rimR = 0.2;
  const zF = -L / 2, zR = L / 2;
  const fo = 1.0, wb = variant === 1 ? 3.25 : variant === 2 ? 4.3 : 3.66;
  const yb = 0.2, belt = 1.2;
  const noseExt: [number, number][] = [[0.25, 0.27], [0.45, 0.33], [0.65, 0.34], [0.85, 0.3], [1.0, 0.24], [1.08, 0.18]];
  const tailExt: [number, number][] = [[0.25, 0.05], [0.5, 0.06], [1.0, 0.06], [1.2, 0.05]];
  const zF0 = zF + 0.34, zR0 = zR - 0.06;
  const zA = zF0 + 0.25, zB = zA + 0.72;
  const zD = zR0 - 0.02, zC = zD - 0.07;
  const za = zF + fo;
  const bZ = zB + 0.38;
  const slide0 = bZ + 0.06, slide1 = slide0 + 1.3;
  const gh: GHDef = {
    zA, zB, zC, zD, roofF: [[zA, 0], [lerp(zA, zB, 0.25), 0.3], [lerp(zA, zB, 0.55), 0.6], [lerp(zA, zB, 0.85), 0.88], [zB, 0.95], [zB + 0.35, 1], [zC - 0.1, 1], [zC, 0.985], [zD, 0]],
    roofH: H, inset: 0.07, tumble: 0.08, topDrop: H - 2.0, crown: 0.04, bow: 0.008,
    sideStart: zA, sideEnd: bZ - 0.05, pillars: [], trim: VPart.Plastic, aPillar: VPart.Paint, roofPart: VPart.Paint, cPillar: VPart.Paint,
    extraZ: [slide0, slide0 + SEAM, slide1 - SEAM, slide1],
    override: (zm, jj, side, ym) => {
      if (zm > zC && jj >= 6) return ym > 1.55 && ym < H - 0.35 ? VPart.Glass : Math.abs(zm) > 0 && ym < 1.55 ? VPart.Paint : VPart.Paint;
      if (side > 0 && jj <= 3 && ((zm > slide0 && zm < slide0 + SEAM) || (zm > slide1 - SEAM && zm < slide1))) return VPart.Rubber;
      if (variant === 3 && side > 0 && jj >= 1 && jj <= 3 && zm > slide0 + 0.1 && zm < slide1 - 0.1) return VPart.Glass;
      return -1;
    },
  };
  const p: CarP = {
    L, W, R, tw, rimR, fo, wb, yb, ybF: yb + 0.12, ybR: yb + 0.12,
    hoodF: 0.92, cowl: 1.16, belt, deck: belt, tailTop: belt, hoodMid: 1.06,
    wF: 0.95, wR: 0.99, crown: 0.03, shoulderDrop: 0.07, tumbleLow: 0.02, rockerIn: 0.025,
    noseExt, rcF: 0.36, topRoundF: 0.04, tailExt, rcR: 0.1, topRoundR: 0.01,
    capLowF: yb + 0.16, capLowR: yb + 0.16,
    gh, seams: [zA + 0.06, bZ], topSeams: [], flare: 0.014, step: 0.4,
    cuts: [slide0, slide0 + SEAM, slide1 - SEAM, slide1, zR0 - 0.02],
    override: (zm, jj, side, _ym) => {
      if (side > 0 && jj >= 2 && jj <= 10 && ((zm > slide0 && zm < slide0 + SEAM) || (zm > slide1 - SEAM && zm < slide1))) return VPart.Rubber;
      return -1;
    },
  };
  const { B, axles } = makeBody(p);
  const ctx = buildBody(g, B);
  const hY = 0.9;
  const iF = ctx.front.inner;
  B.front.patches.push(
    { u0: 0.62, u1: 1.85, yb0: hY - 0.06, yb1: hY - 0.01, yt0: hY + 0.06, yt1: hY + 0.09, part: VPart.Headlight, frame: 0.07, framePart: VPart.Plastic, skirt: true, nx: 5 },
    { u0: 1.85, u1: 2.05, yb0: hY - 0.02, yb1: hY - 0.0, yt0: hY + 0.06, yt1: hY + 0.07, part: VPart.Indicator, nx: 2 },
    { u0: 0, u1: 0.6, yb0: 0.66, yb1: 0.68, yt0: 0.86, yt1: 0.88, part: VPart.Plastic, frame: 0.08, framePart: VPart.Chrome, centered: true, nx: 3, ny: 2 },
    { u0: 0, u1: 0.8, yb0: 0.36, yb1: 0.38, yt0: 0.5, yt1: 0.48, part: VPart.Plastic, centered: true, nx: 3 },
    { u0: 0, u1: 0.26 / iF, yb0: 0.52, yb1: 0.52, yt0: 0.63, yt1: 0.63, part: VPart.Plate, centered: true, nx: 1, lift: 0.012 },
  );
  B.rear.patches.push(
    { u0: 1.55, u1: 2.04, yb0: 0.55, yb1: 0.55, yt0: 0.98, yt1: 0.98, part: VPart.Taillight, skirt: true, nx: 2, ny: 2 },
    { u0: 1.55, u1: 2.04, yb0: 0.48, yb1: 0.48, yt0: 0.545, yt1: 0.545, part: VPart.Indicator, nx: 2 },
    { u0: 0, u1: 0.26 / ctx.rear.inner, yb0: 0.42, yb1: 0.42, yt0: 0.53, yt1: 0.53, part: VPart.Plate, centered: true, nx: 1, lift: 0.012 },
  );
  // rear door split + bumper + third brake light
  rbox(g, 0, 0.006, 0.45, H - 0.15, zR - 0.02, zR + 0.005, 0.002, () => VPart.Rubber, 1);
  rbox(g, 0, W / 2 - 0.03, yb + 0.06, yb + 0.26, zR - 0.12, zR + 0.04, 0.04, () => VPart.Plastic);
  rbox(g, 0, 0.18, H - 0.1, H - 0.05, zR - 0.03, zR + 0.0, 0.01, (n) => (n[2] > 0.5 ? VPart.Taillight : VPart.Plastic), 1);
  addMirrors(g, ctx, lerp(zA, zB, 0.22), 1.35, 0.04);
  addHandles(g, ctx, [bZ - 0.2, slide0 + 0.12]);
  tubeZ(g, [0.5, yb + 0.05, zR - 0.25], 0.03, 0.25, 8, VPart.Chrome, VPart.Undercarriage, 1);
  if (ambulance) {
    // Light bars over the cab and at the back corners, a livery band along the sides, a rear step.
    const zz = zB + 0.25, y0 = H - 0.01;
    rbox(g, 0, 0.85, y0, y0 + 0.12, zz - 0.15, zz + 0.15, 0.03, (n, c) => (n[1] < -0.5 ? VPart.Plastic : Math.abs(c[0]) < 0.1 && n[2] !== 0 ? VPart.Plastic : VPart.Lightbar));
    for (const sx of [-1, 1]) {
      rbox(g, sx * (W / 2 - 0.12), 0.1, y0, y0 + 0.1, zR - 0.3, zR - 0.1, 0.02, (n) => (n[1] < -0.5 ? VPart.Plastic : VPart.Lightbar), 1);
      rbox(g, sx * (W / 2 + 0.004), 0.008, 0.98, 1.22, zA + 0.35, zR - 0.08, 0.004, () => VPart.Livery, 1);
    }
    rbox(g, 0, 0.6, yb + 0.05, yb + 0.12, zR - 0.05, zR + 0.32, 0.02, () => VPart.Plastic, 1);
  }
  if (swat) {
    // Light bar over the windscreen, a push bumper, running boards along both sides.
    const zz = zB + 0.25, y0 = H - 0.01;
    rbox(g, 0, 0.7, y0, y0 + 0.11, zz - 0.14, zz + 0.14, 0.03, (n, c) => (n[1] < -0.5 ? VPart.Plastic : Math.abs(c[0]) < 0.1 && n[2] !== 0 ? VPart.Plastic : VPart.Lightbar));
    rbox(g, 0, 0.55, yb + 0.25, yb + 0.62, zF - 0.1, zF + 0.02, 0.03, () => VPart.Plastic);
    for (const sx of [-1, 1]) rbox(g, sx * (W / 2 - 0.02), 0.08, yb + 0.12, yb + 0.17, zA + 0.2, zR - 0.9, 0.02, () => VPart.Plastic);
  }
  void za;
  return finishCar(swat ? 'swat' : ambulance ? 'ambulance' : 'delivery', g, ctx, axles, variant === 0 || variant === 2 ? 'steel' : 'cap', swat ? 3600 : ambulance ? 3400 : 2800, [-0.5, 0.9, zA + 0.72]);
}

// ---------------------------------------------------------------- model cache / API

const modelCache = new Map<string, VehicleModel>();

/** Body width without mirrors: max |x| of vertices below `yMax`. */
function bodyWidth(g: THREE.BufferGeometry, yMax: number): number {
  const p = g.getAttribute('position');
  let m = 0;
  for (let i = 0; i < p.count; i++) if (p.getY(i) < yMax) m = Math.max(m, Math.abs(p.getX(i)));
  return m * 2;
}

/** Build (and cache) a model. `variant` (0..3) changes proportions/details within the kind. */
export function vehicleModel(kind: VehicleKind, variant = 0): VehicleModel {
  const v = ((variant | 0) % 4 + 4) % 4;
  const key = `${kind}:${v}`;
  const hit = modelCache.get(key);
  if (hit) return hit;
  const rng = Rng.from('vehicle', kind, v);
  let b: Built;
  switch (kind) {
    case 'van': b = buildVan(v, rng); break;
    case 'pickup': b = buildPickup(v, rng); break;
    case 'bus': b = buildBus(v, rng); break;
    case 'truck': b = buildTruck(v, rng); break;
    case 'delivery': b = buildDelivery(v, rng); break;
    case 'swat': b = buildDelivery(v === 1 ? 0 : v, rng, true); break;
    case 'shuttle': b = buildShuttle(v, rng); break;
    case 'army_truck': b = buildArmyTruck(); break;
    case 'apc': b = buildApc(); break;
    case 'tank': b = buildTank(); break;
    case 'ambulance': b = buildDelivery(v === 1 ? 0 : v, rng, false, true); break;
    case 'firetruck': b = buildTruck(v === 1 ? 0 : v, rng, 'fire'); break;
    case 'crane': b = buildTruck(0, rng, 'crane'); break;
    case 'flatbed': b = buildTruck(v === 1 ? 1 : 0, rng, 'flat'); break;
    default: b = buildPassenger({ kind, variant: v, rng }); break;
  }
  const bb = b.body.boundingBox!;
  const m: VehicleModel = {
    kind,
    length: bb.max.z - bb.min.z,
    width: bodyWidth(b.body, b.wheelRadius * 2 + 0.1),
    height: bb.max.y,
    body: b.body,
    wheel: b.wheel,
    wheelRadius: b.wheelRadius,
    wheels: b.wheels,
    mass: b.mass,
    driverSeat: b.driverSeat,
    turret: b.turret,
  };
  modelCache.set(key, m);
  return m;
}

/**
 * Clone a model geometry for an InstancedMesh: shares all vertex attributes and adds the per-instance
 * attributes `iPaint` (vec3, sRGB) and `iState` (vec4) sized for `count` instances.
 */
export function createInstancedVehicleGeometry(base: THREE.BufferGeometry, count: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const name of Object.keys(base.attributes)) g.setAttribute(name, base.attributes[name]);
  g.setIndex(base.index);
  g.boundingBox = base.boundingBox;
  g.boundingSphere = base.boundingSphere;
  const paint = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(0.8), 3);
  const state = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
  paint.setUsage(THREE.DynamicDrawUsage);
  state.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('iPaint', paint);
  g.setAttribute('iState', state);
  return g;
}

// ---------------------------------------------------------------- material

export const vehicleUniforms: { uTime: { value: number }; uNight: { value: number } } = {
  uTime: { value: 0 },
  uNight: { value: 0 },
};

const VERT_PARS = /* glsl */ `
attribute float aPart;
varying float vPart;
varying vec3 vObjPos;
varying vec3 vPaint;
varying vec4 vState;
varying float vMirror;
varying vec2 vVUv;
#ifdef VEHICLE_INSTANCED
attribute vec3 iPaint;
attribute vec4 iState;
#else
uniform vec3 uPaint;
uniform vec4 uState;
#endif
vec3 vhToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
`;

const VERT_MAIN = /* glsl */ `
vPart = aPart;
vObjPos = position;
vVUv = uv;
#ifdef VEHICLE_INSTANCED
vPaint = vhToLinear(clamp(iPaint, 0.0, 1.0));
vState = iState;
#else
vPaint = vhToLinear(clamp(uPaint, 0.0, 1.0));
vState = uState;
#endif
vMirror = 1.0;
#ifdef USE_INSTANCING
vMirror = determinant(mat3(instanceMatrix)) < 0.0 ? -1.0 : 1.0;
#endif
`;

const FRAG_PARS = /* glsl */ `
uniform float uTime;
uniform float uNight;
varying float vPart;
varying vec3 vObjPos;
varying vec3 vPaint;
varying vec4 vState;
varying float vMirror;
varying vec2 vVUv;
float vhHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vhNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(vhHash(i), vhHash(i + vec3(1,0,0)), f.x), mix(vhHash(i + vec3(0,1,0)), vhHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(vhHash(i + vec3(0,0,1)), vhHash(i + vec3(1,0,1)), f.x), mix(vhHash(i + vec3(0,1,1)), vhHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float vhCells(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); float d1 = 8.0, d2 = 8.0;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 r = o + vec3(vhHash(i + o), vhHash(i + o + 7.1), vhHash(i + o + 13.7)) - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
  }
  return sqrt(d2) - sqrt(d1);
}
`;

const FRAG_SURFACE = /* glsl */ `
int vp = int(vPart + 0.5);
float vhRough = 0.5, vhMetal = 0.0, vhCC = 0.0, vhCCR = 0.08;
vec3 vhEmis = vec3(0.0);
vec3 vhCol = vec3(0.5);
float dmg = clamp(vState.w, 0.0, 1.0);
float head = clamp(vState.x, 0.0, 1.0);
float brake = clamp(vState.y, 0.0, 1.0);
float ind = vState.z;
float sideX = vObjPos.x < 0.0 ? -1.0 : 1.0;
float blink = step(0.5, fract(uTime * 1.45));
float lightsAlive = 1.0 - step(0.72, dmg);
if (vp == 0 || vp == 13) {
  vec3 pc = vPaint;
  if (vp == 13) {
    float l0 = dot(pc, vec3(0.2126, 0.7152, 0.0722));
    pc = l0 > 0.2 ? vec3(0.006, 0.03, 0.17) : vec3(0.82);
  }
  float l = dot(pc, vec3(0.2126, 0.7152, 0.0722));
  float mxc = max(pc.r, max(pc.g, pc.b)), mnc = min(pc.r, min(pc.g, pc.b));
  float sat = (mxc - mnc) / max(mxc, 1e-3);
  vhMetal = sat < 0.25 ? ((l > 0.05 && l < 0.62) ? 0.5 : 0.12) : 0.3;
  vhRough = 0.3; vhCC = 1.0; vhCCR = 0.03;
  float dirt = smoothstep(0.6, 0.12, vObjPos.y) * (0.35 + 0.65 * vhNoise(vObjPos * 3.0));
  pc = mix(pc, vec3(0.045, 0.04, 0.035), dirt * 0.35);
  vhRough = mix(vhRough, 0.6, dirt * 0.5);
  float dn = vhNoise(vObjPos * 9.0 + 3.1) * 0.6 + vhNoise(vObjPos * 31.0) * 0.4;
  float scr = smoothstep(0.5, 0.8, dn) * dmg;
  pc = mix(pc, pc * 0.3 + vec3(0.025, 0.022, 0.02), scr);
  vhRough = mix(vhRough, 0.85, scr); vhCC *= 1.0 - 0.85 * dmg;
  vhCol = pc;
} else if (vp == 1) {
  vhCol = vec3(0.004, 0.006, 0.007); vhRough = 0.05; vhMetal = 0.0; vhCC = 1.0; vhCCR = 0.02;
  if (dmg > 0.45) {
    float c = 1.0 - smoothstep(0.0, 0.06, vhCells(vObjPos * 9.0));
    float k = smoothstep(0.45, 0.9, dmg);
    vhCol = mix(vhCol, vec3(0.35, 0.37, 0.38), c * k);
    vhRough = mix(vhRough, 0.5, c * k);
  }
} else if (vp == 2) {
  vhCol = vec3(0.92); vhMetal = 1.0; vhRough = 0.07;
} else if (vp == 15) {
  vhCol = vec3(0.6, 0.61, 0.63); vhMetal = 1.0; vhRough = 0.26;
} else if (vp == 3) {
  vhCol = vec3(0.022); vhRough = 0.86;
  if (vVUv.y < -0.5) {
    float t = vVUv.y + 2.0;
    float zig = fract(vVUv.x * 70.0 + abs(t - 0.5) * 1.6);
    float groove = step(0.86, zig) * step(0.1, t) * step(t, 0.9) + step(abs(fract(t * 2.0) - 0.5), 0.05);
    vhCol *= 1.0 - 0.6 * clamp(groove, 0.0, 1.0);
    vhRough = mix(0.8, 0.95, clamp(groove, 0.0, 1.0));
  }
} else if (vp == 4) {
  vhCol = vec3(0.018); vhRough = 0.55;
} else if (vp == 5) {
  vhCol = vec3(0.75); vhMetal = 0.85; vhRough = 0.1; vhCC = 1.0;
  float on = head * lightsAlive;
  float drl = 0.35 * (1.0 - uNight) * lightsAlive;
  vhEmis = vec3(1.0, 0.95, 0.86) * (drl + 9.0 * on);
} else if (vp == 6) {
  vhCol = vec3(0.22, 0.006, 0.006); vhMetal = 0.2; vhRough = 0.12; vhCC = 1.0;
  vhEmis = vec3(1.0, 0.02, 0.01) * (0.02 + 0.7 * head + 2.6 * brake) * lightsAlive;
} else if (vp == 8) {
  vhCol = vec3(0.42, 0.18, 0.01); vhMetal = 0.2; vhRough = 0.12; vhCC = 1.0;
  float a = abs(ind);
  float act = (a > 1.5 && a < 2.5) ? 1.0 : step(0.5, ind * sideX);
  if (a > 2.5) act = 1.0;
  vhEmis = vec3(1.0, 0.42, 0.02) * 10.0 * act * blink * lightsAlive;
} else if (vp == 7) {
  vhCol = vec3(0.035); vhRough = 0.8;
} else if (vp == 9) {
  vec2 pu = vVUv;
  float border = step(pu.x, 0.025) + step(0.975, pu.x) + step(pu.y, 0.07) + step(0.93, pu.y);
  float cx = pu.x * 9.0; float ci = floor(cx); vec2 f = vec2(fract(cx), (pu.y - 0.2) / 0.6);
  float chars = 0.0;
  if (ci >= 1.0 && ci <= 7.5 && f.y > 0.0 && f.y < 1.0 && ci != 3.0) {
    float h = vhHash(vec3(ci, 3.7, floor(vObjPos.z * 3.0)));
    float stroke = 0.16;
    float vert = step(abs(f.x - 0.2), stroke * 0.5) * step(h, 0.7) + step(abs(f.x - 0.8), stroke * 0.5) * step(0.25, h);
    float hor = step(0.15, f.x) * step(f.x, 0.85) * (step(abs(f.y - 0.06), 0.06) + step(abs(f.y - 0.5), 0.06) * step(0.4, h) + step(abs(f.y - 0.94), 0.06));
    chars = clamp(vert + hor, 0.0, 1.0);
  }
  vhCol = mix(vec3(0.78, 0.78, 0.74), vec3(0.02), clamp(border + chars, 0.0, 1.0));
  if (pu.x < 0.085) vhCol = vec3(0.01, 0.04, 0.3);
  vhRough = 0.4;
  vhEmis = vhCol * 0.25 * head * uNight;
} else if (vp == 10) {
  vhCol = vec3(0.02); vhRough = 0.92;
} else if (vp == 11) {
  vhCol = vec3(0.9, 0.82, 0.45); vhRough = 0.3; vhCC = 1.0;
  vhEmis = vec3(1.0, 0.82, 0.4) * (0.15 + 2.8 * uNight) * lightsAlive;
} else if (vp == 12) {
  vec3 lc = sideX < 0.0 ? vec3(1.0, 0.02, 0.01) : vec3(0.02, 0.12, 1.0);
  vhCol = lc * 0.25; vhRough = 0.1; vhCC = 1.0;
  if (abs(ind) > 2.5) {
    float ph = fract(uTime * 1.6);
    float on = sideX < 0.0 ? step(ph, 0.5) : step(0.5, ph);
    float strobe = step(0.45, fract(uTime * 9.0));
    vhEmis = lc * 16.0 * on * strobe * lightsAlive;
  }
} else if (vp == 16) {
  vhCol = vec3(0.05, 0.35, 0.33); vhRough = 0.1; vhCC = 1.0;
  vhEmis = vec3(0.1, 1.0, 0.85) * (0.9 + 3.5 * uNight) * lightsAlive;
} else if (vp == 14) {
  float rib = smoothstep(0.42, 0.5, abs(fract(vObjPos.z / 0.31) - 0.5));
  vhCol = vec3(0.8, 0.8, 0.78) * (1.0 - 0.12 * rib);
  float dirt = smoothstep(2.0, 1.1, vObjPos.y) * 0.25 + 0.1 * vhNoise(vObjPos * 2.0);
  vhCol = mix(vhCol, vec3(0.3, 0.28, 0.25), dirt);
  vhRough = 0.45; vhMetal = 0.2;
}
if (vp == 17 || vp == 18) {
  // Military paint and canvas: matte, dusty low down, mottled; canvas in folds; scorched when hit.
  vec3 pc = vp == 18 ? vPaint * 0.85 + vec3(0.03, 0.028, 0.0) : vPaint;
  float dirt = smoothstep(1.4, 0.2, vObjPos.y) * (0.4 + 0.6 * vhNoise(vObjPos * 2.5));
  pc = mix(pc, vec3(0.1, 0.085, 0.06), dirt * 0.5);
  pc *= 0.86 + 0.28 * vhNoise(vObjPos * 5.0 + 1.7);
  if (vp == 18) pc *= 1.0 - 0.2 * smoothstep(0.3, 0.5, abs(fract(vObjPos.z / 0.85 + vObjPos.x * 0.3) - 0.5));
  float scr = smoothstep(0.45, 0.8, vhNoise(vObjPos * 7.0 + 3.1) * 0.6 + vhNoise(vObjPos * 23.0) * 0.4) * dmg;
  pc = mix(pc, pc * 0.25 + vec3(0.02, 0.018, 0.016), scr);
  vhCol = pc; vhRough = vp == 18 ? 0.95 : 0.7; vhMetal = vp == 18 ? 0.0 : 0.12; vhCC = 0.0;
}
diffuseColor.rgb = vhCol;
`;

function patchFragmentNormal(): string {
  return THREE.ShaderChunk.normal_fragment_begin.replace(
    'float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;',
    'float faceDirection = (gl_FrontFacing ? 1.0 : - 1.0) * vMirror;',
  ) + /* glsl */ `
if (dmg > 0.01 && (vp == 0 || vp == 13 || vp == 14 || vp == 17)) {
  vec3 q = vObjPos * 3.5;
  vec3 dn = vec3(vhNoise(q), vhNoise(q + 11.3), vhNoise(q + 27.1)) - 0.5;
  normal = normalize(normal + dn * dmg * 1.1);
  nonPerturbedNormal = normal;
}
`;
}

function setupVehicleMaterial(mat: THREE.MeshPhysicalMaterial, instanced: boolean) {
  mat.defines = mat.defines || {};
  if (instanced) mat.defines.VEHICLE_INSTANCED = '';
  const own = {
    uPaint: { value: new THREE.Vector3(0.8, 0.8, 0.8) },
    uState: { value: new THREE.Vector4(0, 0, 0, 0) },
  };
  mat.userData.uPaint = own.uPaint;
  mat.userData.uState = own.uState;
  mat.onBeforeCompile = (s) => {
    s.uniforms.uTime = vehicleUniforms.uTime;
    s.uniforms.uNight = vehicleUniforms.uNight;
    s.uniforms.uPaint = own.uPaint;
    s.uniforms.uState = own.uState;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_MAIN);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_SURFACE)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vhRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vhMetal;')
      .replace('#include <normal_fragment_begin>', patchFragmentNormal())
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = vhEmis;')
      .replace('#include <lights_physical_fragment>', /* glsl */ `#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
material.clearcoat = vhCC;
material.clearcoatRoughness = min(max(vhCCR, 0.0525) + geometryRoughness, 1.0);
#endif`);
  };
  mat.customProgramCacheKey = () => `scale-vehicle-${instanced ? 1 : 0}`;
}

/**
 * One material for all vehicles. Instanced: reads per-instance `iPaint` (vec3 sRGB) and `iState`
 * (vec4: headlights, brake, indicator, damage). Non-instanced: values come from
 * `material.userData.uPaint` (Vector3) / `material.userData.uState` (Vector4) — see setVehicleMaterialState.
 * iState.z: -1 left / +1 right indicator, ±2 hazard lights, ±3 emergency (police light bar + hazards).
 * The material is double sided and corrects lighting for mirrored instances (scale x = -1).
 */
export function createVehicleMaterial(instanced: boolean): THREE.MeshPhysicalMaterial {
  if (WEBGPU) return gpuKit().createVehicleNodeMaterial(instanced, vehicleUniforms) as unknown as THREE.MeshPhysicalMaterial;
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.5, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, side: THREE.DoubleSide,
  });
  mat.name = instanced ? 'vehicle-instanced' : 'vehicle';
  setupVehicleMaterial(mat, instanced);
  return mat;
}

/** Set paint (sRGB 0..1) and state for a non-instanced vehicle material. */
export function setVehicleMaterialState(mat: THREE.Material, paint: [number, number, number], state?: [number, number, number, number]) {
  const p = mat.userData.uPaint as { value: THREE.Vector3 } | undefined;
  const s = mat.userData.uState as { value: THREE.Vector4 } | undefined;
  if (p) p.value.set(paint[0], paint[1], paint[2]);
  if (s && state) s.value.set(state[0], state[1], state[2], state[3]);
}

// ---------------------------------------------------------------- paint colours

function hsl(h: number, s: number, l: number): [number, number, number] {
  const c = new THREE.Color();
  c.setHSL(((h % 1) + 1) % 1, clamp(s, 0, 1), clamp(l, 0, 1), THREE.SRGBColorSpace);
  // setHSL with SRGBColorSpace stores linear internally; convert back to sRGB components
  const out = c.clone().convertLinearToSRGB();
  return [out.r, out.g, out.b];
}

/** Random but realistic paint colour (sRGB 0..1). Deterministic for (kind, seed). */
export function paintColor(kind: VehicleKind, seed: number): [number, number, number] {
  const r = Rng.from('paint', kind, seed);
  const v = (a: number) => r.range(-a, a);
  if (kind === 'taxi') {
    return r.chance(0.7) ? hsl(0.13 + v(0.01), 0.92, 0.52 + v(0.03)) : hsl(0.12, 0.35, 0.86 + v(0.02)); // yellow cab or ivory
  }
  if (kind === 'police') {
    const style = r.int(0, 3);
    if (style === 0) return [0.93, 0.93, 0.94];
    if (style === 1) return hsl(0.62, 0.65, 0.17);
    if (style === 2) return [0.72, 0.74, 0.76];
    return [0.04, 0.04, 0.045];
  }
  if (kind === 'bus') {
    return r.pick([hsl(0.13, 0.85, 0.5), [0.92, 0.92, 0.9] as [number, number, number], hsl(0.0, 0.72, 0.42), hsl(0.6, 0.6, 0.35), hsl(0.36, 0.55, 0.32), hsl(0.55, 0.5, 0.55)]);
  }
  // Military: olive drab in a few shades (a desert-sand tank now and then).
  if (kind === 'army_truck' || kind === 'apc' || kind === 'tank') return kind === 'tank' && r.chance(0.25) ? hsl(0.1, 0.28, 0.42 + v(0.03)) : hsl(0.2 + v(0.02), 0.26 + v(0.04), 0.2 + v(0.025));
  if (kind === 'swat') return r.pick([[0.05, 0.055, 0.065], hsl(0.62, 0.45, 0.12)] as [number, number, number][]);
  // City services: ambulances white (a navy livery band), fire engines red, cranes yellow, the
  // cleanup flatbeds municipal orange.
  if (kind === 'ambulance') return [0.94, 0.94, 0.92];
  if (kind === 'firetruck') return hsl(0.0, 0.8, 0.38 + v(0.02));
  if (kind === 'crane') return hsl(0.12, 0.9, 0.48 + v(0.02));
  if (kind === 'flatbed') return hsl(0.07, 0.85, 0.48 + v(0.02));
  if (kind === 'shuttle') {
    // Operator liveries: white, warm grey, a few city-transit colours.
    return r.pick([[0.93, 0.93, 0.92], [0.93, 0.93, 0.92], [0.78, 0.77, 0.74], hsl(0.5, 0.45, 0.42), hsl(0.6, 0.45, 0.35)] as [number, number, number][]);
  }
  if (kind === 'truck' || kind === 'delivery') {
    const t = r.float();
    if (t < 0.55) return [0.92 + v(0.02), 0.92 + v(0.02), 0.91 + v(0.02)];
    if (t < 0.65) return hsl(0.13, 0.9, 0.5);
    if (t < 0.72) return hsl(0.08, 0.45, 0.25);
    if (t < 0.8) return hsl(0.0, 0.75, 0.42);
    if (t < 0.9) return hsl(0.6, 0.6, 0.32);
    return [0.55, 0.56, 0.58];
  }
  const t = r.float();
  if (t < 0.24) return [0.93 + v(0.02), 0.93 + v(0.02), 0.92 + v(0.02)]; // white
  if (t < 0.43) { const l = 0.035 + r.float() * 0.03; return [l, l, l * 1.05]; } // black
  if (t < 0.56) { const l = 0.62 + r.float() * 0.14; return [l, l + 0.005, l + 0.015]; } // silver
  if (t < 0.7) { const l = 0.24 + r.float() * 0.2; return [l, l + 0.005, l + 0.012]; } // grey
  if (t < 0.8) return hsl(0.6 + v(0.03), 0.55 + v(0.2), 0.25 + v(0.1)); // blue
  if (t < 0.88) return hsl(0.995 + v(0.012), 0.72 + v(0.15), 0.36 + v(0.08)); // red
  if (t < 0.91) return hsl(0.38 + v(0.05), 0.4, 0.2 + v(0.05)); // dark green
  if (t < 0.94) return hsl(0.08 + v(0.02), 0.35, 0.3 + v(0.12)); // brown / beige
  if (t < 0.96) return hsl(0.07 + v(0.04), 0.85, 0.5); // orange / yellow
  if (kind === 'sports' && r.chance(0.5)) return hsl(r.float(), 0.85, 0.48);
  return hsl(r.float(), 0.45, 0.4); // rare others
}

// Builders shared with the military models (props/military.ts).
export { Geo, rbox, blob, tubeZ, finalize, buildWheel, v3 };
export type { V3 };
