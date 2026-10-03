/**
 * Procedural add-on geometry generated in the body worker from a built body:
 * hair (strand cards in ~20 styles incl. braids, buns, mohawks, dreadlocks,
 * sylvan leaves, drakeborn crests), beards, horns, tusks and tails.
 *
 * Hair is grown as guide strands from roots sampled on the morphed scalp
 * (the same face-coordinate scalp/beard regions the skin shader paints),
 * bent by gravity, combing targets, part lines and curl, kept out of the
 * head (sphere) and torso, then turned into camera-agnostic ribbon cards
 * with shading normals pointing away from the head (smooth, volumetric
 * lighting instead of flat cards). Every vertex is skinned (head for scalp
 * hair blending into the upper spine for long hair; nearest body vertex for
 * beards), so parts share the body skeleton.
 *
 * Pure TS, deterministic from appearance.seed.
 */
import { Rng, deriveSeed } from '../core/rng';
import type { HumanAssets } from './assets';
import type { BodyData } from './bodyBuild';
import { morphTriangles } from './bodyBuild';
import type { HumanoidAppearance } from './types';
import { beardCoverage, scalpCoverage, BEARD_IDS, smoothstep } from './client/faceRegions';
import { RACE_STYLES } from './races';

export type PartMaterial = 'hair' | 'leaf' | 'horn' | 'tusk' | 'tail' | 'fin';

export interface PartGeo {
  name: string;
  material: PartMaterial;
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  /** Strand tangent (hair highlight direction). */
  tangent: Float32Array;
  /** Per-vertex card random (colour variation) and v (root→tip). */
  aux: Float32Array;
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  index: Uint32Array;
}

/** Extra bones appended to the skeleton (tail chain). */
export interface ExtraBone { name: string; parent: number; head: [number, number, number] }

export interface PartsResult {
  parts: PartGeo[];
  /** Painted scalp shading strength (shaved / buzz / undercut sides). */
  shavedScalp: number;
  extraBones: ExtraBone[];
}

type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const UP: V3 = [0, 1, 0], DOWN: V3 = [0, -1, 0], FWD: V3 = [0, 0, -1], BACK: V3 = [0, 0, 1];

// ------------------------------------------------------------------ mesh builder

class Builder {
  pos: number[] = []; nrm: number[] = []; uv: number[] = []; tan: number[] = []; aux: number[] = [];
  si: number[] = []; sw: number[] = []; idx: number[] = [];
  get count() { return this.pos.length / 3; }
  vert(p: V3, n: V3, u: number, v: number, t: V3, rnd: number, w: [number, number][]) {
    this.pos.push(...p); this.nrm.push(...n); this.uv.push(u, v); this.tan.push(...t); this.aux.push(rnd, v);
    for (let k = 0; k < 4; k++) { this.si.push(w[k]?.[0] ?? 0); this.sw.push(w[k]?.[1] ?? 0); }
  }
  build(name: string, material: PartMaterial): PartGeo {
    return {
      name, material,
      position: Float32Array.from(this.pos), normal: Float32Array.from(this.nrm), uv: Float32Array.from(this.uv),
      tangent: Float32Array.from(this.tan), aux: Float32Array.from(this.aux),
      skinIndex: Uint16Array.from(this.si), skinWeight: Float32Array.from(this.sw), index: Uint32Array.from(this.idx),
    };
  }
}

// ------------------------------------------------------------------ body sampling

interface Ctx {
  as: HumanAssets;
  body: BodyData;
  app: HumanoidAppearance;
  rng: Rng;
  C: V3; R: number;
  face: Float32Array; // face coords per morph vertex (neutral mesh)
  bone: (n: string) => number;
  head: (n: string) => V3;
  grid: Map<number, number[]>;
  cell: number;
}

const faceCache = new WeakMap<HumanAssets, Float32Array>();
/** Face coordinates of every morph vertex on the neutral mesh (same frame as staticData). */
function faceCoords(as: HumanAssets): Float32Array {
  let f = faceCache.get(as);
  if (f) return f;
  const m = as.manifest, b = as.basePos;
  const c = (g: [number, number]): V3 => {
    let x = 0, y = 0, z = 0;
    for (let v = g[0]; v < g[0] + g[1]; v++) { x += b[v * 3]; y += b[v * 3 + 1]; z += b[v * 3 + 2]; }
    return [x / g[1], y / g[1], z / g[1]];
  };
  const eL = c(m.groups.eyeL), eR = c(m.groups.eyeR);
  const mid = mul(add(eL, eR), 0.5), ipd = len(sub(eL, eR));
  f = new Float32Array(m.morphVerts * 3);
  for (let v = 0; v < m.morphVerts; v++) {
    f[v * 3] = (b[v * 3] - mid[0]) / ipd;
    f[v * 3 + 1] = (b[v * 3 + 1] - mid[1]) / ipd;
    f[v * 3 + 2] = (mid[2] - b[v * 3 + 2]) / ipd;
  }
  faceCache.set(as, f);
  return f;
}

/** Area-weighted random surface samples on body triangles where `weight(faceCoord)` > 0. */
function sampleSurface(ctx: Ctx, count: number, weight: (x: number, y: number, z: number, v: number) => number): { p: V3; n: V3; f: V3 }[] {
  const { as, body, face, rng } = ctx;
  const tris = morphTriangles(as);
  const bodyTris = as.manifest.submeshes.find((s) => s.name === 'body')!.count;
  const pos = body.pos, nrm = body.normal;
  const cdf: number[] = [], ids: number[] = [];
  let total = 0;
  for (let t = 0; t < bodyTris; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    const w = (weight(face[a * 3], face[a * 3 + 1], face[a * 3 + 2], a) + weight(face[b * 3], face[b * 3 + 1], face[b * 3 + 2], b) + weight(face[c * 3], face[c * 3 + 1], face[c * 3 + 2], c)) / 3;
    if (w <= 0.02) continue;
    const pa: V3 = [pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]];
    const ab = sub([pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]], pa), ac = sub([pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2]], pa);
    total += (len(cross(ab, ac)) / 2) * w;
    cdf.push(total);
    ids.push(t);
  }
  const out: { p: V3; n: V3; f: V3 }[] = [];
  if (!ids.length) return out;
  for (let i = 0; i < count; i++) {
    const r = rng.float() * total;
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < r) lo = mid + 1; else hi = mid; }
    const t = ids[lo];
    let u = rng.float(), v = rng.float();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const w0 = 1 - u - v;
    const vs = [tris[t], tris[t + 1], tris[t + 2]];
    const ws = [w0, u, v];
    const p: V3 = [0, 0, 0], n: V3 = [0, 0, 0], f: V3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) {
      p[j] += pos[vs[k] * 3 + j] * ws[k];
      n[j] += nrm[vs[k] * 3 + j] * ws[k];
      f[j] += face[vs[k] * 3 + j] * ws[k];
    }
    out.push({ p, n: norm(n), f });
  }
  return out;
}

/** Skin weights of the nearest body vertex. */
function nearestWeights(ctx: Ctx, p: V3): [number, number][] {
  const { cell, grid, body, as } = ctx;
  const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
  let best = -1, bd = Infinity;
  for (let r = 1; r <= 3 && best < 0; r++) {
    for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) for (let z = cz - r; z <= cz + r; z++) {
      const list = grid.get((x * 73856093) ^ (y * 19349663) ^ (z * 83492791));
      if (!list) continue;
      for (const v of list) {
        const d = (body.pos[v * 3] - p[0]) ** 2 + (body.pos[v * 3 + 1] - p[1]) ** 2 + (body.pos[v * 3 + 2] - p[2]) ** 2;
        if (d < bd) { bd = d; best = v; }
      }
    }
  }
  if (best < 0) return [[ctx.bone('head'), 1]];
  const out: [number, number][] = [];
  for (let k = 0; k < 4; k++) if (as.skinW[best * 4 + k]) out.push([as.skinIdx[best * 4 + k], as.skinW[best * 4 + k] / 255]);
  return out;
}

/** Scalp-hair weights: rigid to the head, blending into neck/upper spine for long hair hanging below the jaw. */
function hairWeights(ctx: Ctx, p: V3): [number, number][] {
  const neckTop = ctx.head('head')[1], neckBase = ctx.head('neck01')[1], chest = ctx.head('spine02')[1];
  const y = p[1];
  if (y >= neckTop) return [[ctx.bone('head'), 1]];
  if (y >= neckBase) { const t = (neckTop - y) / Math.max(0.01, neckTop - neckBase); return [[ctx.bone('head'), 1 - t * 0.6], [ctx.bone('neck01'), t * 0.6]]; }
  const t = Math.min(1, (neckBase - y) / Math.max(0.02, neckBase - chest));
  return [[ctx.bone('head'), 0.4 * (1 - t)], [ctx.bone('neck01'), 0.6 * (1 - t)], [ctx.bone('spine01'), t]];
}

// ------------------------------------------------------------------ strands → cards

interface StrandOpts {
  segs: number;
  length: number;
  gravity: number;
  /** How long the strand follows its root normal before bending (0..1). */
  stiff: number;
  /** Extra clearance above the head sphere at the tip (m). */
  volume: number;
  curl: number;
  curlFreq: number;
  /** Direction field at a point: where combing pulls the strand. */
  comb: (p: V3, t: number) => V3 | null;
  combK: number;
  noise: number;
  collideHead: boolean;
}

function growStrand(ctx: Ctx, root: V3, n: V3, o: StrandOpts, rng: Rng): V3[] {
  const pts: V3[] = [add(root, mul(n, -0.0008))];
  // Hair leaves the scalp at a shallow angle: mostly along the combing direction,
  // lifted by the style's stiffness.
  let c0 = o.comb(root, 0);
  if (!c0) c0 = norm(cross(n, norm([rng.gaussian(0, 1), rng.gaussian(0, 1), rng.gaussian(0, 1)])));
  const c0t = sub(norm(c0), mul(n, dot(norm(c0), n)));
  let dir = norm(add(mul(n, 0.2 + 0.7 * o.stiff), len(c0t) > 1e-4 ? norm(c0t) : n));
  const seg = o.length / o.segs;
  const ph = rng.range(0, Math.PI * 2);
  const side = norm(cross(n, Math.abs(n[1]) > 0.9 ? FWD : UP));
  const neckY = ctx.head('neck01')[1];
  const neckTop = ctx.head('head');
  const shoulderY = (ctx.head('upperarm01.L')[1] + ctx.head('upperarm01.R')[1]) / 2;
  const spine = ctx.head('spine02');
  const cz = spine[2] - ctx.body.fit.chestDepth * 0.2;
  const torsoR = ctx.body.fit.chestDepth * 0.62, torsoW = ctx.body.fit.shoulderWidth * 0.5;
  const neckR = ctx.body.fit.neckRadius * 1.5;
  // Layering: a strand never dips below the radius of its own root, so crown hair lies over the rest.
  const rootR = Math.max(ctx.R * 1.03, len(sub(root, ctx.C)) + 0.0025);
  for (let i = 1; i <= o.segs; i++) {
    const t = i / o.segs;
    const g = o.gravity * Math.min(1, t / Math.max(0.05, o.stiff));
    dir = norm(add(dir, mul(DOWN, g * 0.35)));
    const c = o.comb(pts[i - 1], t);
    if (c) dir = norm(lerp3(dir, norm(c), o.combK));
    if (o.noise) dir = norm(add(dir, [rng.gaussian(0, o.noise), rng.gaussian(0, o.noise * 0.5), rng.gaussian(0, o.noise)]));
    let p = add(pts[i - 1], mul(dir, seg));
    if (o.curl) {
      const cw = Math.sin(ph + t * o.curlFreq * Math.PI * 2) * o.curl * Math.min(1, t * 3);
      p = add(p, mul(side, cw * seg));
    }
    if (o.collideHead) {
      const rel = sub(p, ctx.C);
      const d = len(rel);
      const minR = rootR + o.volume * Math.min(1, t * 2);
      if (d < minR) p = add(ctx.C, mul(rel, minR / d));
    }
    // Body: an elliptic cylinder for the torso below the shoulders, blending into a
    // neck cylinder above them, so long hair drapes over shoulders and back.
    if (p[1] < neckY + 0.02) {
      const k = smoothstep(shoulderY + 0.06, shoulderY - 0.02, p[1]);
      const ax = neckTop[0] + (spine[0] - neckTop[0]) * k, az = neckTop[2] + (cz - neckTop[2]) * k;
      const rw = neckR + (torsoW - neckR) * k, rd = neckR + (torsoR - neckR) * k;
      const dx = p[0] - ax, dz = p[2] - az;
      const e = Math.hypot(dx / rw, dz / rd);
      if (e < 1.06) { const q = 1.06 / Math.max(e, 1e-3); p = [ax + dx * q, p[1], az + dz * q]; }
    }
    dir = norm(sub(p, pts[i - 1]));
    pts.push(p);
  }
  return pts;
}

/** Turn a polyline into a ribbon card. `outward(p)` orients the card face and the shading normal. */
function card(b: Builder, pts: V3[], width: (t: number) => number, uOff: number, uSpan: number, rnd: number, weights: (p: V3) => [number, number][], outward: (p: V3) => V3, twist = 0) {
  const base = b.count;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const tan = norm(sub(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]));
    const out = outward(pts[i]);
    let s = norm(cross(tan, out));
    if (twist) {
      const a = twist * t;
      const o2 = norm(cross(s, tan));
      s = norm(add(mul(s, Math.cos(a)), mul(o2, Math.sin(a))));
    }
    const w = width(t) / 2;
    const nn = norm(add(out, mul(cross(s, tan), 0.0)));
    const wgt = weights(pts[i]);
    b.vert(add(pts[i], mul(s, -w)), nn, uOff, t, tan, rnd, wgt);
    b.vert(add(pts[i], mul(s, w)), nn, uOff + uSpan, t, tan, rnd, wgt);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = base + i * 2;
    b.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
}

// ------------------------------------------------------------------ hair styles

interface HairStyle {
  count: number;
  length: [number, number];
  segs: number;
  width: number;
  gravity: number;
  stiff: number;
  volume: number;
  curl: number;
  curlFreq: number;
  noise: number;
  combK: number;
  /** Root filter in face coords + head-local position. */
  region?: (f: V3, local: V3) => number;
  comb: 'back' | 'part' | 'down' | 'up' | 'gather' | 'random' | 'side';
  gather?: 'nape' | 'crown' | 'top' | 'back';
  /** Tail/bundle after the gather point. */
  tail?: { kind: 'tail' | 'braid' | 'bun' | 'knot' | 'braids'; length: number; count: number; width: number };
  shaved: number;
  leaf?: boolean;
  dreads?: boolean;
  recede?: boolean;
}

const STYLES: Record<string, HairStyle | null> = {
  bald: null,
  shaved: null,
  buzz: null,
  short: { count: 1400, length: [0.04, 0.07], segs: 4, width: 0.012, gravity: 0.3, stiff: 0.15, volume: 0.01, curl: 0.1, curlFreq: 1, noise: 0.06, combK: 0.4, comb: 'back', shaved: 0.6 },
  crop: { count: 1500, length: [0.022, 0.035], segs: 3, width: 0.01, gravity: 0.15, stiff: 0.25, volume: 0.006, curl: 0, curlFreq: 1, noise: 0.08, combK: 0.35, comb: 'back', shaved: 0.8 },
  tousled: { count: 1300, length: [0.06, 0.1], segs: 5, width: 0.014, gravity: 0.4, stiff: 0.3, volume: 0.02, curl: 0.35, curlFreq: 1.2, noise: 0.25, combK: 0.2, comb: 'random', shaved: 0.5 },
  slick: { count: 1100, length: [0.1, 0.14], segs: 6, width: 0.014, gravity: 0.3, stiff: 0.15, volume: 0.004, curl: 0, curlFreq: 1, noise: 0.02, combK: 0.75, comb: 'back', shaved: 0.6 },
  undercut: { count: 900, length: [0.09, 0.13], segs: 6, width: 0.014, gravity: 0.35, stiff: 0.3, volume: 0.01, curl: 0.05, curlFreq: 1, noise: 0.04, combK: 0.6, comb: 'side', region: (f) => smoothstep(1.4, 1.7, f[1]) * (1 - smoothstep(0.55, 0.75, Math.abs(f[0]))), shaved: 0.9 },
  shoulder: { count: 1500, length: [0.2, 0.26], segs: 9, width: 0.016, gravity: 1, stiff: 0.15, volume: 0.012, curl: 0.12, curlFreq: 1.5, noise: 0.03, combK: 0.45, comb: 'part', shaved: 0.5 },
  long: { count: 1700, length: [0.36, 0.48], segs: 12, width: 0.017, gravity: 1, stiff: 0.12, volume: 0.012, curl: 0.1, curlFreq: 2, noise: 0.025, combK: 0.4, comb: 'part', shaved: 0.5 },
  wild: { count: 1400, length: [0.12, 0.22], segs: 8, width: 0.018, gravity: 0.85, stiff: 0.25, volume: 0.022, curl: 0.45, curlFreq: 2.2, noise: 0.1, combK: 0.25, comb: 'part', shaved: 0.5 },
  ponytail: { count: 1200, length: [0.25, 0.25], segs: 7, width: 0.014, gravity: 0, stiff: 0.1, volume: 0.003, curl: 0, curlFreq: 1, noise: 0.01, combK: 0.85, comb: 'gather', gather: 'back', tail: { kind: 'tail', length: 0.32, count: 160, width: 0.022 }, shaved: 0.6 },
  braid: { count: 1200, length: [0.25, 0.25], segs: 7, width: 0.014, gravity: 0, stiff: 0.1, volume: 0.003, curl: 0, curlFreq: 1, noise: 0.01, combK: 0.85, comb: 'gather', gather: 'nape', tail: { kind: 'braid', length: 0.42, count: 1, width: 0.05 }, shaved: 0.6 },
  braids: { count: 1200, length: [0.25, 0.25], segs: 7, width: 0.014, gravity: 0, stiff: 0.1, volume: 0.003, curl: 0, curlFreq: 1, noise: 0.01, combK: 0.85, comb: 'gather', gather: 'nape', tail: { kind: 'braids', length: 0.38, count: 2, width: 0.04 }, shaved: 0.6 },
  bun: { count: 1200, length: [0.25, 0.25], segs: 7, width: 0.014, gravity: 0, stiff: 0.1, volume: 0.003, curl: 0, curlFreq: 1, noise: 0.01, combK: 0.85, comb: 'gather', gather: 'back', tail: { kind: 'bun', length: 0.05, count: 70, width: 0.03 }, shaved: 0.6 },
  topknot: { count: 800, length: [0.2, 0.2], segs: 6, width: 0.014, gravity: 0, stiff: 0.1, volume: 0.003, curl: 0, curlFreq: 1, noise: 0.01, combK: 0.85, comb: 'gather', gather: 'crown', region: (f) => smoothstep(1.35, 1.6, f[1]), tail: { kind: 'knot', length: 0.16, count: 70, width: 0.024 }, shaved: 0.9 },
  mohawk: { count: 700, length: [0.1, 0.16], segs: 5, width: 0.016, gravity: 0.05, stiff: 0.9, volume: 0.02, curl: 0, curlFreq: 1, noise: 0.05, combK: 0.5, comb: 'up', region: (f) => 1 - smoothstep(0.18, 0.28, Math.abs(f[0])), shaved: 1 },
  dreadlocks: { count: 110, length: [0.24, 0.36], segs: 9, width: 0.02, gravity: 1, stiff: 0.15, volume: 0.02, curl: 0.05, curlFreq: 1, noise: 0.03, combK: 0.35, comb: 'part', dreads: true, shaved: 0.6 },
  tonsure: { count: 900, length: [0.03, 0.05], segs: 3, width: 0.012, gravity: 0.3, stiff: 0.3, volume: 0.006, curl: 0, curlFreq: 1, noise: 0.05, combK: 0.4, comb: 'down', region: (f) => 1 - smoothstep(1.7, 1.95, f[1]), shaved: 0.4 },
  leaves: { count: 260, length: [0.09, 0.16], segs: 4, width: 0.05, gravity: 0.35, stiff: 0.5, volume: 0.02, curl: 0.15, curlFreq: 0.8, noise: 0.25, combK: 0.25, comb: 'back', leaf: true, shaved: 0 },
  crest: null,
};

/** Head-local coordinates: x (character right +), y up, z forward. */
function headLocal(ctx: Ctx, p: V3): V3 {
  return [(p[0] - ctx.C[0]) / ctx.R, (p[1] - ctx.C[1]) / ctx.R, (ctx.C[2] - p[2]) / ctx.R];
}

function buildScalpHair(ctx: Ctx, style: HairStyle, lod: number, b: Builder) {
  const { rng, C, R, app } = ctx;
  const recede = app.gender > 0.5 ? Math.max(0, app.age - 0.6) * 1.6 : 0;
  const count = Math.round(style.count * (lod === 0 ? 1.7 : 0.45));
  const widthMul = lod === 0 ? 1 : 1.75;
  const roots = sampleSurface(ctx, count, (x, y, z) => scalpCoverage(x, y, z, recede) * (style.region ? style.region([x, y, z], [0, 0, 0]) : 1));
  const partX = rng.chance(0.5) ? rng.range(-0.35, 0.35) : 0;
  const gatherPt: V3 =
    style.gather === 'crown' ? add(C, [0, R * 1.05, R * 0.05]) :
    style.gather === 'top' ? add(C, [0, R * 0.95, R * 0.4]) :
    style.gather === 'nape' ? add(C, [0, -R * 0.55, R * 0.95]) :
    add(C, [0, R * 0.05, R * 1.02]);
  const comb = (root: V3, local: V3) => (p: V3, t: number): V3 | null => {
    switch (style.comb) {
      case 'back': return norm(add(mul(BACK, 1), mul(DOWN, 0.35 + t * 0.6 + Math.max(0, -local[2]) * 0.2)));
      case 'down': return DOWN;
      case 'up': return norm(add(UP, mul(BACK, 0.35 + local[2] * -0.2)));
      case 'random': return null;
      case 'side': return norm(add(add(mul([1, 0, 0], partX >= 0 ? -1 : 1), mul(DOWN, 0.4 + t)), mul(BACK, 0.3)));
      case 'part': {
        const s = Math.sign(local[0] - partX * 0.3) || 1;
        const lateral: V3 = [s * (1 - t) * 0.35, 0, 0];
        return norm(add(add(lateral, mul(DOWN, 0.3 + t * 1.6)), mul(BACK, 0.55 + Math.max(0, local[2]) * 0.5)));
      }
      case 'gather': return sub(gatherPt, p);
    }
    return null;
  };
  // Races with prominent ears (elves, goblins, umbrals...) wear their hair tucked
  // behind the ears so the ears stay visible: strands passing in front of the ear
  // are combed back and down.
  const A = RACE_STYLES[app.race], B = app.race2 ? RACE_STYLES[app.race2] : A;
  const earTip = A.earTip * (1 - app.raceMix) + B.earTip * app.raceMix;
  const tuck = earTip * Math.max(0, app.face.earPoint) > 0.25 && style.comb !== 'gather';
  const tucked = (base: (p: V3, t: number) => V3 | null) => (p: V3, t: number): V3 | null => {
    const l = headLocal(ctx, p);
    if (Math.abs(l[0]) > 0.55 && l[1] < 0.35 && l[1] > -1.0 && l[2] > -0.45) return norm(add(mul(BACK, 1), mul(DOWN, 0.5)));
    return base(p, t);
  };
  for (const r of roots) {
    const local = headLocal(ctx, r.p);
    const L = rng.range(style.length[0], style.length[1]) * (ctx.app.scale > 1.3 ? 1.2 : 1);
    let strandLen = L;
    if (style.comb === 'gather') strandLen = len(sub(gatherPt, r.p)) * 1.05;
    const opts: StrandOpts = {
      segs: style.segs, length: strandLen, gravity: style.gravity, stiff: style.stiff, volume: style.volume, curl: style.curl, curlFreq: style.curlFreq,
      comb: tuck ? tucked(comb(r.p, local)) : comb(r.p, local), combK: tuck ? Math.max(style.combK, 0.65) : style.combK, noise: style.noise, collideHead: true,
    };
    const pts = growStrand(ctx, r.p, r.n, opts, rng);
    const rnd = rng.float();
    const outward = (p: V3) => norm(sub(p, C));
    if (style.leaf) {
      card(b, pts, (t) => style.width * widthMul * (0.4 + 0.6 * Math.sin(Math.min(1, t * 1.2) * Math.PI * 0.9 + 0.2)), rng.range(0, 0.75), 0.5, rnd, (p) => hairWeights(ctx, p), outward, rng.range(-1, 1));
    } else if (style.dreads) {
      // Dreadlock = two crossed cards with a thick, slowly tapering width.
      const w = (t: number) => style.width * (1 - t * 0.35);
      card(b, pts, w, rng.range(0, 0.7), 0.15, rnd, (p) => hairWeights(ctx, p), outward);
      card(b, pts, w, rng.range(0, 0.7), 0.15, rnd, (p) => hairWeights(ctx, p), (p) => norm(cross(norm(sub(p, C)), UP)));
    } else {
      const w = style.width * widthMul * rng.range(0.75, 1.25);
      card(b, pts, (t) => w * (0.35 + 0.65 * smoothstep(0, 0.15, t)) * (1 - t * 0.55), rng.range(0, 0.75), 0.25, rnd, (p) => hairWeights(ctx, p), outward);
    }
  }
  if (style.tail) buildHairTail(ctx, style, gatherPt, lod, b);
}

/** Ponytails, braids, buns and knots hanging from the gather point. */
function buildHairTail(ctx: Ctx, style: HairStyle, g: V3, lod: number, b: Builder) {
  const tail = style.tail!;
  const { rng, C } = ctx;
  const back = norm(sub(g, C));
  const lenScale = ctx.app.scale > 1.3 ? 1.2 : 1;
  if (tail.kind === 'tail' || tail.kind === 'knot') {
    const n = Math.round(tail.count * (lod === 0 ? 1 : 0.4));
    for (let i = 0; i < n; i++) {
      const off: V3 = [rng.gaussian(0, 0.008), rng.gaussian(0, 0.008), rng.gaussian(0, 0.008)];
      const root = add(g, off);
      const L = tail.length * rng.range(0.75, 1.05) * lenScale;
      const up = tail.kind === 'knot';
      const opts: StrandOpts = {
        segs: up ? 6 : 10, length: L, gravity: up ? 0.6 : 1, stiff: up ? 0.5 : 0.08, volume: 0.01, curl: 0.15, curlFreq: 1.5, noise: 0.04,
        comb: () => (up ? norm(add(UP, mul(BACK, 0.4))) : norm(add(back, DOWN))), combK: up ? 0.6 : 0.2, collideHead: true,
      };
      const dir0 = up ? UP : norm(add(back, mul(DOWN, 0.3)));
      const pts = growStrand(ctx, root, dir0, opts, rng);
      const w = tail.width * (lod === 0 ? 1 : 1.6) * rng.range(0.7, 1.2);
      // Bundle narrows below the tie then fans slightly.
      card(b, pts, (t) => w * (0.45 + 0.55 * Math.sin(Math.min(1, t * 1.3) * Math.PI * 0.8 + 0.3)), rng.range(0, 0.75), 0.25, rng.float(), (p) => hairWeights(ctx, p), (p) => norm(sub(p, C)));
    }
    return;
  }
  if (tail.kind === 'bun') {
    const r = 0.045 * lenScale;
    const center = add(g, mul(back, r * 0.8));
    const n = Math.round(tail.count * (lod === 0 ? 1 : 0.5));
    for (let i = 0; i < n; i++) {
      // Strands wrapped around the bun sphere along random great circles.
      const axis = norm([rng.gaussian(0, 1), rng.gaussian(0, 1), rng.gaussian(0, 1)]);
      const ref = norm(cross(axis, Math.abs(axis[1]) > 0.8 ? FWD : UP));
      const ref2 = cross(axis, ref);
      const a0 = rng.range(0, Math.PI * 2);
      const pts: V3[] = [];
      for (let k = 0; k <= 8; k++) {
        const a = a0 + (k / 8) * Math.PI * 1.3;
        pts.push(add(center, add(mul(ref, Math.cos(a) * r), mul(ref2, Math.sin(a) * r))));
      }
      card(b, pts, () => tail.width * (lod === 0 ? 1 : 1.5), rng.range(0, 0.75), 0.25, rng.float(), (p) => hairWeights(ctx, p), (p) => norm(sub(p, center)));
    }
    return;
  }
  // Braids: chain of interleaved lobes (three strands crossing) as stacked crossed cards.
  const braids = tail.kind === 'braid' ? 1 : tail.count;
  for (let k = 0; k < braids; k++) {
    const lateral = braids === 1 ? 0 : (k === 0 ? -1 : 1) * ctx.R * 0.55;
    const start = add(g, [lateral, 0, 0]);
    const L = tail.length * lenScale;
    const opts: StrandOpts = {
      segs: 16, length: L, gravity: 1, stiff: 0.05, volume: 0.015, curl: 0, curlFreq: 1, noise: 0, collideHead: true,
      comb: () => norm(add(mul(back, 0.6), DOWN)), combK: 0.3,
    };
    const spine = growStrand(ctx, start, norm(add(back, DOWN)), opts, rng);
    const W = tail.width;
    for (let s = 0; s < 3; s++) {
      const pts: V3[] = spine.map((p, i) => {
        const t = i / (spine.length - 1);
        const ph = t * 14 + (s * Math.PI * 2) / 3;
        const tan = norm(sub(spine[Math.min(spine.length - 1, i + 1)], spine[Math.max(0, i - 1)]));
        const sideV = norm(cross(tan, norm(sub(p, C))));
        return add(p, mul(sideV, Math.sin(ph) * W * 0.3 * (1 - t * 0.4)));
      });
      const taper = (t: number) => W * 0.55 * (t > 0.9 ? 1.4 - (t - 0.9) * 4 : 1 - t * 0.35);
      card(b, pts, taper, 0.05 + s * 0.3, 0.25, 0.3 + s * 0.2, (p) => hairWeights(ctx, p), (p) => norm(sub(p, C)), s * 1.1);
      card(b, pts, taper, 0.05 + s * 0.3, 0.25, 0.3 + s * 0.2, (p) => hairWeights(ctx, p), (p) => norm(cross(norm(sub(p, C)), UP)), s * 1.1);
    }
  }
}

/** Drakeborn crest: a row of tapering fins along the skull midline. */
function buildCrest(ctx: Ctx, b: Builder) {
  const { C, R, rng } = ctx;
  const n = 9;
  for (let i = 0; i < n; i++) {
    const a = -0.35 + (i / (n - 1)) * 2.1; // forehead → nape
    const dir: V3 = [0, Math.cos(a), -Math.sin(a) * -1];
    const base = add(C, mul(norm([0, Math.cos(a), Math.sin(a)]), R * 1.0));
    const h = R * (0.35 + 0.35 * Math.sin((i / (n - 1)) * Math.PI)) * rng.range(0.85, 1.15);
    const out = norm(sub(base, C));
    const tip = add(add(base, mul(out, h)), mul(BACK, h * 0.6));
    const pts: V3[] = [base, lerp3(base, tip, 0.5), tip];
    void dir;
    card(b, pts, (t) => R * 0.32 * (1 - t), 0.1, 0.8, rng.float(), () => [[ctx.bone('head'), 1]], () => [1, 0, 0]);
  }
}

// ------------------------------------------------------------------ beards

function buildBeard(ctx: Ctx, a: HumanoidAppearance, lod: number, b: Builder) {
  const style = a.beardStyle;
  // Stubble is painted; short beards and chinstraps are fur shells only (client/hairShells.ts).
  if (style === 'none' || style === 'stubble' || style === 'short' || style === 'chinstrap') return;
  const id = BEARD_IDS[style] ?? 0;
  const lenMap: Record<string, [number, number]> = {
    short: [0.012, 0.02], full: [0.03, 0.05], long: [0.09, 0.16], braided: [0.08, 0.13], forked: [0.08, 0.14],
    goatee: [0.03, 0.06], mustache: [0.02, 0.035], mutton: [0.02, 0.035], chinstrap: [0.01, 0.018],
  };
  const L = lenMap[style] ?? [0.03, 0.05];
  const count = Math.round((style === 'short' || style === 'chinstrap' ? 1800 : 1400) * (lod === 0 ? 1 : 0.35));
  const roots = sampleSurface(ctx, count, (x, y, z) => beardCoverage(id, x, y, z));
  const { rng } = ctx;
  const chin = ctx.body.sockets.mouth.pos as V3;
  const scaleK = a.scale > 1.3 ? 1.25 : a.scale < 0.9 ? 0.8 : 1;
  const forkSide = (p: V3) => (p[0] - chin[0] >= 0 ? 1 : -1);
  for (const r of roots) {
    const isMust = r.f[1] > -1.12 && Math.abs(r.f[0]) < 0.62 && r.f[1] < -0.75;
    let Ls = rng.range(L[0], L[1]) * scaleK;
    // Long beards: shorter on the cheeks, longest at the chin.
    const chinW = 1 - smoothstep(0.3, 1.1, Math.abs(r.f[0]));
    if (Ls > 0.06) Ls *= 0.35 + 0.65 * chinW;
    if (isMust) Ls = rng.range(0.02, style === 'mustache' ? 0.045 : 0.03) * scaleK;
    const opts: StrandOpts = {
      segs: Ls > 0.06 ? 8 : 4, length: Ls, gravity: isMust ? 0.5 : 1, stiff: 0.25, volume: 0, curl: 0.15, curlFreq: 1.5, noise: 0.05,
      comb: (p, t) => {
        if (isMust) return norm([Math.sign(p[0] - chin[0]) * 0.8, -0.6, -0.2]);
        if (style === 'forked' && t > 0.4) return norm([forkSide(p) * 0.35, -1, -0.1]);
        return norm([0, -1, -0.15]);
      },
      combK: 0.4, collideHead: false,
    };
    const pts = growStrand(ctx, r.p, r.n, opts, rng);
    const wgt = nearestWeights(ctx, r.p);
    const w = (lod === 0 ? 0.0055 : 0.012) * rng.range(0.8, 1.3) * scaleK * (isMust ? 0.8 : 1);
    card(b, pts, (t) => w * (1 - t * 0.5), rng.range(0, 0.75), 0.25, rng.float(), () => wgt, () => r.n);
  }
  if (style === 'braided') {
    // A braid hanging from the chin.
    const start = add(chin, [0, -0.07 * scaleK, -0.01]);
    const opts: StrandOpts = { segs: 10, length: 0.14 * scaleK, gravity: 1, stiff: 0.05, volume: 0, curl: 0, curlFreq: 1, noise: 0, comb: () => DOWN, combK: 0.5, collideHead: false };
    const spine = growStrand(ctx, start, DOWN, opts, rng);
    const wgt = nearestWeights(ctx, add(chin, [0, -0.04, 0]));
    for (let s = 0; s < 3; s++) {
      const pts = spine.map((p, i) => add(p, [Math.sin(i * 1.6 + s * 2.1) * 0.006, 0, Math.cos(i * 1.6 + s * 2.1) * 0.004]));
      card(b, pts, (t) => 0.022 * scaleK * (1 - t * 0.3), 0.1 + s * 0.3, 0.25, 0.5, () => wgt, () => FWD, s);
    }
  }
}

// ------------------------------------------------------------------ horns, tusks, tail

/** Tube along a curve with radius profile; rings get keratin ridges. */
function tube(b: Builder, pts: V3[], radius: (t: number) => number, radial: number, weights: (p: V3, t: number) => [number, number][], ridges: number) {
  const base = b.count;
  const n = pts.length;
  let ref: V3 = Math.abs(norm(sub(pts[1], pts[0]))[1]) > 0.9 ? FWD : UP;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const tan = norm(sub(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]));
    const s1 = norm(cross(tan, ref));
    const s2 = cross(s1, tan);
    ref = s2;
    const rr = radius(t) * (1 + (ridges ? 0.06 * Math.sin(t * ridges * Math.PI * 2) : 0));
    const w = weights(pts[i], t);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const dir = add(mul(s1, Math.cos(a)), mul(s2, Math.sin(a)));
      b.vert(add(pts[i], mul(dir, rr)), dir, j / radial, t, tan, 0, w);
    }
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < radial; j++) {
    const a = base + i * (radial + 1) + j, c = a + radial + 1;
    b.idx.push(a, c, a + 1, a + 1, c, c + 1);
  }
}

function buildHorns(ctx: Ctx, a: HumanoidAppearance, b: Builder) {
  const { C, R } = ctx;
  const style = a.horns.style, size = a.horns.size * (a.scale > 1.3 ? 1.2 : 1);
  if (style === 'none' || size < 0.05) return;
  const headW = (): [number, number][] => [[ctx.bone('head'), 1]];
  const sides = [-1, 1];
  const S = R * (0.8 + size * 1.2);
  for (const s of sides) {
    const curve: V3[] = [];
    const steps = 18;
    // Root on the upper forehead/temple surface.
    const root = add(C, mul(norm([s * 0.55, 0.62, -0.45]), R * 0.97));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      let p: V3;
      switch (style) {
        case 'ram': {
          // Spiral backwards and around beside the ear.
          const ang = t * Math.PI * 1.55;
          const rr = S * 0.42 * (1 - t * 0.35);
          const center = add(root, [s * S * 0.12, -S * 0.12, S * 0.3]);
          p = add(center, [s * (S * 0.2 * t), Math.cos(ang + 0.6) * rr * 1.1, Math.sin(ang + 0.6) * rr * -1 + S * 0.1]);
          if (i === 0) p = root;
          break;
        }
        case 'straight':
          p = add(root, add(mul(norm([s * 0.25, 1, 0.35]), S * t * 0.95), [0, 0, 0]));
          break;
        case 'antler': {
          p = add(root, [s * S * 0.45 * t, S * 0.95 * t, S * 0.25 * t * t]);
          break;
        }
        case 'crown':
          p = add(root, mul(norm([s * 0.3, 1, -0.1]), S * 0.35 * t));
          break;
        default: { // swept: back along the skull then up
          p = add(root, [s * S * 0.18 * t, S * (0.15 * t + 0.35 * t * t * t), S * 1.0 * t]);
        }
      }
      curve.push(p);
    }
    const base = R * (0.12 + size * 0.08);
    tube(b, curve, (t) => base * Math.pow(1 - t, 0.75) + 0.0015, 10, headW, style === 'ram' ? 9 : style === 'straight' ? 6 : 4);
    if (style === 'antler') {
      // Two forward tines.
      for (const ft of [0.45, 0.72]) {
        const o = curve[Math.round(ft * steps)];
        const tine: V3[] = [];
        for (let i = 0; i <= 6; i++) tine.push(add(o, mul(norm([s * 0.2, 0.8, -0.6]), S * 0.32 * (i / 6))));
        tube(b, tine, (t) => base * 0.5 * (1 - t) + 0.001, 7, headW, 0);
      }
    }
  }
  if (style === 'crown') {
    // Ring of smaller spikes around the brow line.
    for (let k = -3; k <= 3; k++) {
      if (k === 0) continue;
      const ang = k * 0.32;
      const root = add(C, mul(norm([Math.sin(ang), 0.7, -Math.cos(ang) * 0.75]), R));
      const tip = add(root, mul(norm(sub(root, C)), R * 0.3 * size + 0.01));
      tube(b, [root, lerp3(root, tip, 0.5), tip], (t) => R * 0.06 * (1 - t) + 0.001, 7, headW, 0);
    }
  }
}

function buildTusks(ctx: Ctx, a: HumanoidAppearance, b: Builder) {
  if (a.tusks < 0.05) return;
  const mouth = ctx.body.sockets.mouth.pos as V3;
  const jaw = ctx.bone('jaw');
  const k = (0.022 + a.tusks * 0.03) * (a.scale > 1.3 ? 1.2 : 1);
  const ipd = Math.abs(ctx.body.eyes[0] - ctx.body.eyes[4]);
  for (const s of [-1, 1]) {
    // Rooted just in front of the lower lip so they always clear it.
    const root = add(mouth, [s * ipd * 0.42, -0.017, -0.011]);
    const pts: V3[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      pts.push(add(root, [s * k * 0.12 * t, k * t, -k * 0.25 * t - k * 0.2 * t * t]));
    }
    tube(b, pts, (t) => k * 0.22 * Math.pow(1 - t, 0.8) + 0.0008, 8, () => [[jaw, 1]], 0);
  }
}

function buildTail(ctxA: Ctx, a: HumanoidAppearance, boneBase: number, b: Builder): ExtraBone[] {
  if (a.tail.style === 'none' || a.tail.length < 0.05) return [];
  const sock = ctxA.body.sockets.tail;
  const root = sock.pos as V3;
  const H = ctxA.body.height;
  const L = a.tail.length * H * 0.62;
  const N = 6;
  const pts: V3[] = [];
  const segs = 24;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // Out backwards, drooping, curling slightly up at the end (resting pose).
    pts.push(add(root, [0, -L * (0.45 * t - 0.12 * t * t * t), L * t * 0.95]));
  }
  const bones: ExtraBone[] = [];
  for (let k = 0; k < N; k++) {
    const p = pts[Math.round((k / N) * segs)];
    bones.push({ name: `tail${k}`, parent: k === 0 ? ctxA.bone('root') : boneBase + k - 1, head: p });
  }
  const r0 = a.tail.style === 'thin' ? 0.022 : a.tail.style === 'furred' ? 0.05 : 0.065 * (H / 1.8);
  tube(b, pts, (t) => r0 * (1 - t * 0.92) + 0.003, 12, (_p, t) => {
    const f = Math.min(N - 1e-3, t * N);
    const i0 = Math.floor(f), w1 = f - i0;
    const i1 = Math.min(N - 1, i0 + 1);
    if (i0 === 0 && w1 < 0.5) return [[boneBase, 0.5 + w1], [ctxA.bone('root'), 0.5 - w1]];
    return [[boneBase + i0, 1 - w1], [boneBase + i1, w1]];
  }, 0);
  return bones;
}

// ------------------------------------------------------------------ entry

const gridCache = new WeakMap<Float32Array, { grid: Map<number, number[]>; cell: number }>();

export function buildParts(as: HumanAssets, body: BodyData, a: HumanoidAppearance, lod: number): PartsResult {
  const rng = new Rng(deriveSeed(a.seed >>> 0, 'hair', a.hairStyle, a.beardStyle, lod));
  const bone = (n: string) => as.boneByName.get(n)!;
  let g = gridCache.get(body.pos);
  if (!g) {
    const cell = 0.03 * Math.max(0.5, a.scale);
    const grid = new Map<number, number[]>();
    const BODY = as.manifest.groups.tongue[0];
    for (let v = 0; v < BODY; v++) {
      const k = (Math.floor(body.pos[v * 3] / cell) * 73856093) ^ (Math.floor(body.pos[v * 3 + 1] / cell) * 19349663) ^ (Math.floor(body.pos[v * 3 + 2] / cell) * 83492791);
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push(v);
    }
    g = { grid, cell };
    gridCache.set(body.pos, g);
  }
  const hs = body.headSphere;
  const ctx: Ctx = {
    as, body, app: a, rng,
    C: [hs[0], hs[1], hs[2]], R: hs[3],
    face: faceCoords(as), bone,
    head: (n) => { const i = bone(n) * 3; return [body.heads[i], body.heads[i + 1], body.heads[i + 2]]; },
    grid: g.grid, cell: g.cell,
  };
  const parts: PartGeo[] = [];
  const style = a.hairStyle in STYLES ? STYLES[a.hairStyle] : STYLES.short;
  let shaved = a.hairStyle === 'shaved' ? 0.55 : a.hairStyle === 'buzz' ? 0.95 : a.hairStyle === 'bald' || a.hairStyle === 'crest' ? 0 : 0.6;
  if (style) {
    shaved = style.shaved;
    const hb = new Builder();
    buildScalpHair(ctx, style, lod, hb);
    if (hb.count) parts.push(hb.build('hair', style.leaf ? 'leaf' : 'hair'));
  }
  if (a.hairStyle === 'crest') {
    const cb = new Builder();
    buildCrest(ctx, cb);
    parts.push(cb.build('crest', 'fin'));
  }
  const bb = new Builder();
  buildBeard(ctx, a, lod, bb);
  if (bb.count) parts.push(bb.build('beard', 'hair'));
  if (lod === 0 || lod === 1) {
    const horn = new Builder();
    buildHorns(ctx, a, horn);
    if (horn.count) parts.push(horn.build('horns', 'horn'));
    const tusk = new Builder();
    buildTusks(ctx, a, tusk);
    if (tusk.count) parts.push(tusk.build('tusks', 'tusk'));
  }
  const tb = new Builder();
  const extraBones = buildTail(ctx, a, as.manifest.bones.length, tb);
  if (tb.count) parts.push(tb.build('tail', 'tail'));
  return { parts, shavedScalp: shaved, extraBones };
}
