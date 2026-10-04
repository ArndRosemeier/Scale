/**
 * Meshes of the deep realm (pure, runs in the deep worker): the rock surface of a chunk by naive
 * surface nets over the field, and the decor standing in it, with light baked into the vertices.
 *
 *  - Rock: one vertex per grid cell the surface crosses (the average of its edge crossings),
 *    quads across every crossed edge; a chunk owns the edges whose base point lies in it, so
 *    neighbours meet without seams. Normals from the field's gradient.
 *  - Colour: rock by region (warm grey in the Glow with moss on the floors, dark violet-black with
 *    red seams in the Deep), lighter floors, darker vaults, banded strata.
 *  - Light ("glow", added as emission × albedo by the cave material): every light source in reach
 *    (fungus, dwellings, crystals, the Heart …) with a soft falloff and facing, a faint ambient per
 *    region, and occlusion sampled from the field along the normal.
 *  - Decor: lit parts (stems, domes, stones, cones) join the rock mesh; glowing parts (caps,
 *    crystals, strands, veins, doorways) go to a second, unlit mesh.
 */
import { DeepField } from './field';
import type { DeepPlan, Decor } from './plan';

export const CHUNK = 24;
export const VOX = 1;
const N = CHUNK / VOX;

export interface ChunkData {
  key: string;
  /** Lit mesh: positions, normals, colours (albedo), baked light. */
  pos: Float32Array; nor: Float32Array; col: Float32Array; glow: Float32Array; idx: Uint32Array;
  /** Glowing mesh: positions, colours. */
  epos: Float32Array; ecol: Float32Array; eidx: Uint32Array;
}

/** Regions with no glow nearby still show their rock faintly (r, g, b of light). */
const AMBIENT: [number, number, number][] = [[0.035, 0.04, 0.045], [0.05, 0.085, 0.09], [0.045, 0.07, 0.08], [0.09, 0.025, 0.035]];
const ROCK: [number, number, number][] = [[0.42, 0.36, 0.3], [0.44, 0.4, 0.36], [0.4, 0.38, 0.36], [0.2, 0.15, 0.18]];
export const LUMEN_COL: [number, number, number][] = [[0.15, 1.0, 0.75], [0.45, 1.0, 0.3], [0.2, 0.65, 1.0], [1.0, 0.8, 0.35]];
export const MURK_COL: [number, number, number][] = [[1.0, 0.07, 0.09], [0.72, 0.05, 0.46], [1.0, 0.3, 0.05]];

/** Boxes where the realm opens into a chamber: no rock faces drawn inside them. */
export interface SkipBox { cx: number; cz: number; y0: number; y1: number; ux: number; uz: number; hu: number; hv: number }

/** Light sources bucketed by chunk column for fast lookup. */
class Lights {
  private cells = new Map<number, number[]>();
  constructor(readonly g: number[]) {
    for (let i = 0; i < g.length; i += 7) {
      const r = g[i + 6];
      for (let a = Math.floor((g[i] - r) / CHUNK); a <= Math.floor((g[i] + r) / CHUNK); a++) for (let b = Math.floor((g[i + 2] - r) / CHUNK); b <= Math.floor((g[i + 2] + r) / CHUNK); b++) {
        const k = (a + 4096) * 8192 + (b + 4096);
        let l = this.cells.get(k);
        if (!l) this.cells.set(k, (l = []));
        l.push(i);
      }
    }
  }
  near(i: number, k: number): number[] { return this.cells.get((i + 4096) * 8192 + (k + 4096)) ?? []; }
}

export class Mesher {
  readonly field: DeepField;
  private lights: Lights;
  private decorByChunk = new Map<string, Decor[]>();
  private veinsByChunk = new Map<string, number[][]>();

  constructor(readonly plan: DeepPlan, readonly skip: SkipBox[]) {
    this.field = new DeepField(plan.prims, plan.seed);
    this.lights = new Lights(plan.glows);
    for (const d of plan.decor) {
      const key = keyOf(Math.floor(d.x / CHUNK), Math.floor(d.y / CHUNK), Math.floor(d.z / CHUNK));
      let l = this.decorByChunk.get(key);
      if (!l) this.decorByChunk.set(key, (l = []));
      l.push(d);
    }
    for (const v of plan.veins) for (let i = 0; i + 5 < v.length; i += 3) {
      const key = keyOf(Math.floor(v[i] / CHUNK), Math.floor(v[i + 1] / CHUNK), Math.floor(v[i + 2] / CHUNK));
      let l = this.veinsByChunk.get(key);
      if (!l) this.veinsByChunk.set(key, (l = []));
      l.push([v[i], v[i + 1], v[i + 2], v[i + 3], v[i + 4], v[i + 5]]);
    }
  }

  /** Chunks (i, j, k) the surface may pass through or decor stands in. */
  chunks(): [number, number, number][] {
    const b = this.field.bounds, F = this.field;
    const out: [number, number, number][] = [];
    const half = (CHUNK / 2) * Math.sqrt(3) + 4.5;
    for (let i = Math.floor((b[0] - 4) / CHUNK); i <= Math.floor((b[3] + 4) / CHUNK); i++)
      for (let j = Math.floor((b[1] - 4) / CHUNK); j <= Math.floor((b[4] + 4) / CHUNK); j++)
        for (let k = Math.floor((b[2] - 4) / CHUNK); k <= Math.floor((b[5] + 4) / CHUNK); k++) {
          const d = F.sdf((i + 0.5) * CHUNK, (j + 0.5) * CHUNK, (k + 0.5) * CHUNK);
          if (Math.abs(d) < half || this.decorByChunk.has(keyOf(i, j, k))) out.push([i, j, k]);
        }
    return out;
  }

  build(i: number, j: number, k: number): ChunkData {
    const lit = new Geo(), emis = new Geo();
    this.rock(i, j, k, lit);
    for (const d of this.decorByChunk.get(keyOf(i, j, k)) ?? []) decor(d, lit, emis);
    for (const s of this.veinsByChunk.get(keyOf(i, j, k)) ?? []) vein(s, emis);
    this.light(lit);
    return {
      key: keyOf(i, j, k),
      pos: new Float32Array(lit.pos), nor: new Float32Array(lit.nor), col: new Float32Array(lit.col), glow: new Float32Array(lit.glow), idx: new Uint32Array(lit.idx),
      epos: new Float32Array(emis.pos), ecol: new Float32Array(emis.col), eidx: new Uint32Array(emis.idx),
    };
  }

  /** Surface nets over the chunk. */
  private rock(ci: number, cj: number, ck: number, g: Geo): void {
    const F = this.field;
    const x0 = ci * CHUNK, y0 = cj * CHUNK, z0 = ck * CHUNK;
    // Samples at grid points −1 … N+1 per axis.
    const S = N + 3;
    const v = new Float32Array(S * S * S);
    let pos = 0, neg = 0;
    for (let c = 0; c < S; c++) for (let b = 0; b < S; b++) for (let a = 0; a < S; a++) {
      const d = F.sdf(x0 + (a - 1) * VOX, y0 + (b - 1) * VOX, z0 + (c - 1) * VOX);
      v[a + S * (b + S * c)] = d;
      if (d > 0) pos++; else neg++;
    }
    if (!pos || !neg) return;
    // Cells −1 … N (index a = cell + 1): vertex per crossed cell.
    const C = N + 2;
    const vid = new Int32Array(C * C * C).fill(-1);
    const at = (a: number, b: number, c: number) => v[a + S * (b + S * c)];
    const n = { x: 0, y: 0, z: 0 };
    for (let c = 0; c < C; c++) for (let b = 0; b < C; b++) for (let a = 0; a < C; a++) {
      // Corners of the cell at sample (a, b, c).
      let sx = 0, sy = 0, sz = 0, cnt = 0, mask = 0;
      for (let q = 0; q < 8; q++) if (at(a + (q & 1), b + ((q >> 1) & 1), c + ((q >> 2) & 1)) > 0) mask |= 1 << q;
      if (mask === 0 || mask === 255) continue;
      for (const [p, q] of EDGES) {
        const da = at(a + (p & 1), b + ((p >> 1) & 1), c + ((p >> 2) & 1)), db = at(a + (q & 1), b + ((q >> 1) & 1), c + ((q >> 2) & 1));
        if ((da > 0) === (db > 0)) continue;
        const t = da / (da - db);
        sx += (p & 1) + ((q & 1) - (p & 1)) * t;
        sy += ((p >> 1) & 1) + (((q >> 1) & 1) - ((p >> 1) & 1)) * t;
        sz += ((p >> 2) & 1) + (((q >> 2) & 1) - ((p >> 2) & 1)) * t;
        cnt++;
      }
      const x = x0 + (a - 1 + sx / cnt) * VOX, y = y0 + (b - 1 + sy / cnt) * VOX, z = z0 + (c - 1 + sz / cnt) * VOX;
      F.normal(x, y, z, n, 0.3);
      vid[a + C * (b + C * c)] = g.vert(x, y, z, n.x, n.y, n.z, 0, 0, 0);
    }
    // Quads: edges from sample (a, b, c) along each axis, base points 1 … N (grid 0 … N−1 of the chunk).
    const sk = this.skip;
    for (let c = 1; c <= N; c++) for (let b = 1; b <= N; b++) for (let a = 1; a <= N; a++) {
      const d0 = at(a, b, c);
      for (let axis = 0; axis < 3; axis++) {
        const d1 = axis === 0 ? at(a + 1, b, c) : axis === 1 ? at(a, b + 1, c) : at(a, b, c + 1);
        if ((d0 > 0) === (d1 > 0)) continue;
        // The four cells round the edge (cell index = sample index − 1 + 1: cells are offset by the −1 sample).
        let q0: number, q1: number, q2: number, q3: number;
        const cell = (aa: number, bb: number, cc: number) => vid[aa + C * (bb + C * cc)];
        if (axis === 0) { q0 = cell(a, b - 1, c - 1); q1 = cell(a, b, c - 1); q2 = cell(a, b, c); q3 = cell(a, b - 1, c); }
        else if (axis === 1) { q0 = cell(a - 1, b, c - 1); q1 = cell(a - 1, b, c); q2 = cell(a, b, c); q3 = cell(a, b, c - 1); }
        else { q0 = cell(a - 1, b - 1, c); q1 = cell(a, b - 1, c); q2 = cell(a, b, c); q3 = cell(a - 1, b, c); }
        if (q0 < 0 || q1 < 0 || q2 < 0 || q3 < 0) continue;
        if (sk.length) {
          const mx = x0 + (a - 1 + (axis === 0 ? 0.5 : 0)) * VOX, my = y0 + (b - 1 + (axis === 1 ? 0.5 : 0)) * VOX, mz = z0 + (c - 1 + (axis === 2 ? 0.5 : 0)) * VOX;
          if (sk.some((s) => inSkip(s, mx, my, mz))) continue;
        }
        // Wind so the face looks into the air (d0 > 0: rock at the base point).
        if (d0 > 0) g.quad(q0, q1, q2, q3); else g.quad(q0, q3, q2, q1);
      }
    }
    // Colours: rock by region, floors / walls / vaults, strata.
    const P = g.pos, Nn = g.nor;
    for (let vi = 0; vi < g.count; vi++) {
      const x = P[vi * 3], y = P[vi * 3 + 1], z = P[vi * 3 + 2], ny = Nn[vi * 3 + 1];
      F.sdf(x - Nn[vi * 3] * 0.4, y - ny * 0.4, z - Nn[vi * 3 + 2] * 0.4);
      const reg = F.regionOfLast();
      const base = ROCK[reg];
      const strata = 0.88 + 0.12 * Math.sin(y * 1.7 + Math.sin(x * 0.11 + z * 0.07) * 2.5);
      const grain = 0.9 + 0.1 * hash3(Math.floor(x * 2), Math.floor(y * 2), Math.floor(z * 2));
      let r = base[0] * strata * grain, gg = base[1] * strata * grain, bb = base[2] * strata * grain;
      if (ny > 0.65) { r *= 1.12; gg *= 1.12; bb *= 1.1; }
      else if (ny < -0.4) { r *= 0.8; gg *= 0.8; bb *= 0.82; }
      // Moss on the floors of the Glow; red seams in the Deep.
      if (reg === 1 && ny > 0.6) {
        const m = Math.max(0, Math.sin(x * 0.31 + Math.sin(z * 0.23) * 2) * Math.sin(z * 0.27 + x * 0.05) - 0.15);
        r = r * (1 - m) + 0.18 * m; gg = gg * (1 - m) + 0.42 * m; bb = bb * (1 - m) + 0.3 * m;
      }
      if (reg === 3) {
        const s = Math.max(0, Math.sin(x * 0.4 + y * 0.9 + Math.sin(z * 0.3) * 3) - 0.965) * 25;
        r += s * 0.32; gg += s * 0.03; bb += s * 0.04;
      }
      g.setCol(vi, r, gg, bb);
    }
  }

  /** Baked light for every lit vertex (rock and decor alike). */
  private light(g: Geo): void {
    const F = this.field, L = this.lights.g;
    const P = g.pos, Nn = g.nor;
    for (let vi = 0; vi < g.count; vi++) {
      const x = P[vi * 3], y = P[vi * 3 + 1], z = P[vi * 3 + 2], nx = Nn[vi * 3], ny = Nn[vi * 3 + 1], nz = Nn[vi * 3 + 2];
      // Occlusion: how open the air is along the normal.
      const o1 = Math.max(0, Math.min(1, -F.sdf(x + nx * 1.5, y + ny * 1.5, z + nz * 1.5) / 1.5));
      const o2 = Math.max(0, Math.min(1, -F.sdf(x + nx * 4.5, y + ny * 4.5, z + nz * 4.5) / 4.5));
      const reg = F.regionOfLast();
      const ao = 0.25 + 0.75 * (o1 * 0.5 + o2 * 0.5);
      const amb = AMBIENT[reg];
      let r = amb[0] * ao, gg = amb[1] * ao, b = amb[2] * ao;
      for (const li of this.lights.near(Math.floor(x / CHUNK), Math.floor(z / CHUNK))) {
        const dx = L[li] - x, dy = L[li + 1] - y, dz = L[li + 2] - z, R = L[li + 6];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= R * R) continue;
        const d = Math.sqrt(d2) || 1;
        const fall = (1 - d / R) ** 2;
        const facing = Math.max(0.12, (dx * nx + dy * ny + dz * nz) / d * 0.88 + 0.12);
        const k = fall * facing * (0.55 + 0.45 * ao) * 1.8;
        r += L[li + 3] * k; gg += L[li + 4] * k; b += L[li + 5] * k;
      }
      g.setGlow(vi, r, gg, b);
    }
  }
}

function inSkip(s: SkipBox, x: number, y: number, z: number): boolean {
  if (y < s.y0 - 0.3 || y > s.y1 + 0.3) return false;
  const dx = x - s.cx, dz = z - s.cz;
  return Math.abs(dx * s.ux + dz * s.uz) < s.hu + 0.05 && Math.abs(-dx * s.uz + dz * s.ux) < s.hv + 0.05;
}

export function keyOf(i: number, j: number, k: number): string { return `${i},${j},${k}`; }

const EDGES: [number, number][] = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

function hash3(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A growing vertex / index buffer (positions, normals, colours, light). */
class Geo {
  pos: number[] = []; nor: number[] = []; col: number[] = []; glow: number[] = []; idx: number[] = [];
  count = 0;
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, r: number, g: number, b: number): number {
    this.pos.push(x, y, z); this.nor.push(nx, ny, nz); this.col.push(r, g, b); this.glow.push(0, 0, 0);
    return this.count++;
  }
  setCol(i: number, r: number, g: number, b: number): void { this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b; }
  setGlow(i: number, r: number, g: number, b: number): void { this.glow[i * 3] = r; this.glow[i * 3 + 1] = g; this.glow[i * 3 + 2] = b; }
  tri(a: number, b: number, c: number): void { this.idx.push(a, b, c); }
  quad(a: number, b: number, c: number, d: number): void { this.idx.push(a, b, c, a, c, d); }
}

// ------------------------------------------------------------------ decor shapes

type C3 = [number, number, number];

/**
 * A surface of revolution: profile (radius, height) pairs from bottom to top, `seg` sides, with a
 * transform (position, yaw, tilt about the local x axis, scale) and a colour per ring.
 */
function lathe(g: Geo, x: number, y: number, z: number, yaw: number, tilt: number, prof: [number, number][], seg: number, col: (ring: number, side: number) => C3): void {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
  const tf = (px: number, py: number, pz: number): C3 => {
    // Tilt about x, then yaw about y.
    const y1 = py * ct - pz * st, z1 = py * st + pz * ct;
    return [x + px * cy + z1 * sy, y + y1, z + -px * sy + z1 * cy];
  };
  const base = g.count;
  for (let r = 0; r < prof.length; r++) {
    const [rad, h] = prof[r];
    // Normal from the profile's slope.
    const p0 = prof[Math.max(0, r - 1)], p1 = prof[Math.min(prof.length - 1, r + 1)];
    const dr = p1[0] - p0[0], dh = p1[1] - p0[1];
    const nl = Math.hypot(dr, dh) || 1;
    const nR = dh / nl, nY = -dr / nl;
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const P = tf(ca * rad, h, sa * rad);
      const Q = tf(ca * nR, nY, sa * nR);
      const N0 = [Q[0] - x, Q[1] - y, Q[2] - z];
      const c = col(r, s);
      g.vert(P[0], P[1], P[2], N0[0], N0[1], N0[2], c[0], c[1], c[2]);
    }
  }
  for (let r = 0; r + 1 < prof.length; r++) for (let s = 0; s < seg; s++) {
    const a = base + r * (seg + 1) + s, b = a + seg + 1;
    g.quad(a, b, b + 1, a + 1);
  }
}

function boxAt(g: Geo, x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw: number, c: C3): void {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const faces: [C3, C3, C3][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  const H = [hx, hy, hz];
  for (const [n, u, v] of faces) {
    const base = g.count;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const lx = n[0] * H[0] + u[0] * su * H[0] + v[0] * sv * H[0];
      const ly = n[1] * H[1] + u[1] * su * H[1] + v[1] * sv * H[1];
      const lz = n[2] * H[2] + u[2] * su * H[2] + v[2] * sv * H[2];
      g.vert(x + lx * cy + lz * sy, y + ly, z - lx * sy + lz * cy, n[0] * cy + n[2] * sy, n[1], -n[0] * sy + n[2] * cy, c[0], c[1], c[2]);
    }
    g.quad(base, base + 1, base + 2, base + 3);
  }
}

const sc = (c: C3, s: number): C3 => [c[0] * s, c[1] * s, c[2] * s];

function decor(d: Decor, lit: Geo, emis: Geo): void {
  const rnd = mulberry(Math.floor(d.x * 13.1) ^ Math.floor(d.z * 7.7) ^ Math.floor(d.y * 3.3));
  const rockC = (d.reg === 3 ? [0.22, 0.16, 0.19] : [0.43, 0.38, 0.33]) as C3;
  const L = LUMEN_COL[d.c % LUMEN_COL.length], M = MURK_COL[d.c % 2];
  switch (d.k) {
    case 'dwelling': {
      // A dome of tiles and bottle caps (pastel, speckled), a dark doorway with warm light, glowing caps round the foot.
      const prof: [number, number][] = [];
      for (let i = 0; i <= 6; i++) { const a = (i / 6) * Math.PI / 2; prof.push([Math.cos(a) * d.s + 0.001, Math.sin(a) * d.h]); }
      const caps: C3[] = [[0.82, 0.3, 0.25], [0.9, 0.78, 0.35], [0.3, 0.5, 0.82], [0.86, 0.86, 0.82], [0.35, 0.65, 0.4], [0.75, 0.72, 0.66]];
      lathe(lit, d.x, d.y - 0.05, d.z, d.yaw, 0, prof, 14, (r, s) => (r > 0 && (r * 7 + s * 3) % 5 === 0 ? caps[(r + s) % caps.length] : [0.72, 0.68, 0.62]));
      const fx = Math.sin(d.yaw), fz = Math.cos(d.yaw);
      // Doorway: a dark arch on the side facing the Hall, a warm glow inside it.
      const dh = Math.min(d.h * 0.62, 1.4), dw = Math.min(d.s * 0.42, 0.75);
      const ex = d.x + fx * d.s * 0.97, ez = d.z + fz * d.s * 0.97;
      archQuad(emis, ex, d.y, ez, fx, fz, dw, dh, [0.03, 0.02, 0.015]);
      archQuad(emis, ex - fx * 0.05, d.y, ez - fz * 0.05, fx, fz, dw * 0.8, dh * 0.85, [1.0, 0.62, 0.28]);
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2 + d.yaw;
        if (Math.abs(Math.atan2(Math.sin(a - d.yaw), Math.cos(a - d.yaw))) < 0.35) continue;
        const cx = d.x + Math.sin(a) * (d.s + 0.08), cz = d.z + Math.cos(a) * (d.s + 0.08);
        boxAt(emis, cx, d.y + 0.03, cz, 0.05, 0.02, 0.05, a, sc(L, 0.9));
      }
      break;
    }
    case 'mushroom': {
      const stemR = d.s * 0.16, capY = d.h;
      lathe(lit, d.x, d.y - 0.1, d.z, d.yaw, d.tilt ?? 0, [[stemR * 1.5, 0], [stemR, capY * 0.2], [stemR * 0.85, capY * 0.75], [stemR * 0.95, capY]], 9, (r) => (r === 0 ? [0.4, 0.38, 0.34] : [0.58, 0.55, 0.49]));
      const tilt = d.tilt ?? 0;
      const top: [number, number][] = [[0.001, -0.02], [d.s * 0.92, 0.05 * d.s], [d.s, 0.12 * d.s], [d.s * 0.8, 0.38 * d.s], [d.s * 0.45, 0.55 * d.s], [0.001, 0.6 * d.s]];
      const ct = Math.cos(tilt), st = Math.sin(tilt);
      const cx = d.x + Math.sin(d.yaw) * capY * st, cz = d.z + Math.cos(d.yaw) * capY * st;
      lathe(emis, cx, d.y - 0.1 + capY * ct, cz, d.yaw, tilt, top, 16, (r, s) => (r <= 1 ? sc(L, 0.45) : (s + r) % 7 === 0 ? [1, 1, 0.9] : sc(L, 0.95 + 0.1 * Math.sin(s))));
      break;
    }
    case 'fungus': {
      const n = 3 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) {
        const a = rnd() * 6.28, r = rnd() * d.s, h = d.h * (0.4 + rnd() * 0.7);
        const x = d.x + Math.cos(a) * r, z = d.z + Math.sin(a) * r;
        lathe(lit, x, d.y - 0.02, z, 0, (rnd() - 0.5) * 0.3, [[0.018, 0], [0.012, h]], 4, () => [0.8, 0.77, 0.68]);
        const cr = 0.05 + h * 0.12;
        lathe(emis, x, d.y - 0.02 + h, z, 0, 0, [[0.001, -0.01], [cr, 0.0], [cr * 0.6, cr * 0.5], [0.001, cr * 0.6]], 7, () => sc(L, 0.9));
      }
      break;
    }
    case 'stalag': lathe(lit, d.x, d.y, d.z, d.yaw, 0, [[d.s, 0], [d.s * 0.6, d.h * 0.4], [d.s * 0.25, d.h * 0.8], [0.02, d.h]], 7, () => rockC); break;
    case 'stalac': lathe(lit, d.x, d.y - d.h, d.z, d.yaw, 0, [[0.02, 0], [d.s * 0.3, d.h * 0.25], [d.s * 0.65, d.h * 0.65], [d.s, d.h]], 7, () => sc(rockC, 0.92)); break;
    case 'crystal': case 'murkCrystal': {
      // Deep, gem-like: dark at the foot, glowing towards the tip (bright pastel washes out).
      const c = d.k === 'crystal' ? sc(L, 0.55) : sc(M, 0.6);
      const tip = d.k === 'crystal' ? sc(L, 1.1) : [1.0, 0.32, 0.18] as C3;
      lathe(emis, d.x, d.y - 0.2, d.z, d.yaw, d.tilt ?? 0, [[d.s * 0.9, 0], [d.s, d.h * 0.15], [d.s * 0.92, d.h * 0.78], [0.01, d.h]], 6, (r, side) => (r === 3 ? tip : sc(c, (0.25 + r * 0.22) * (side % 2 ? 0.75 : 1))));
      break;
    }
    case 'shelf': {
      // A bracket fungus: a flat half-disc sticking out of the column.
      const ca = Math.cos(d.yaw), sa = Math.sin(d.yaw);
      const base = emis.count;
      emis.vert(d.x - ca * 0.4, d.y, d.z - sa * 0.4, 0, 1, 0, L[0] * 0.5, L[1] * 0.5, L[2] * 0.5);
      for (let i = 0; i <= 8; i++) {
        const a = d.yaw - Math.PI / 2 + (i / 8) * Math.PI;
        emis.vert(d.x + Math.cos(a) * d.s, d.y + 0.08 * Math.sin((i / 8) * Math.PI), d.z + Math.sin(a) * d.s, 0, 1, 0, L[0], L[1], L[2]);
      }
      for (let i = 0; i < 8; i++) { emis.tri(base, base + 1 + i, base + 2 + i); emis.tri(base, base + 2 + i, base + 1 + i); }
      break;
    }
    case 'stone': lathe(lit, d.x, d.y - 0.1, d.z, d.yaw, 0, [[d.s, 0], [d.s * 0.9, d.h * 0.6], [d.s * 0.6, d.h], [0.01, d.h + 0.05]], 6, () => [0.5, 0.48, 0.44]); break;
    case 'strand': {
      // A thin hanging strand, brightest at its end, with a bead.
      const base = emis.count;
      for (let i = 0; i <= 6; i++) {
        const t = i / 6, y = d.y - d.h * t, w = 0.035 * (1 - t * 0.5);
        const c = sc(L, 0.25 + t * 0.85);
        emis.vert(d.x - w, y, d.z, 0, 0, 1, c[0], c[1], c[2]);
        emis.vert(d.x + w, y, d.z, 0, 0, 1, c[0], c[1], c[2]);
        emis.vert(d.x, y, d.z - w, 1, 0, 0, c[0], c[1], c[2]);
        emis.vert(d.x, y, d.z + w, 1, 0, 0, c[0], c[1], c[2]);
      }
      for (let i = 0; i < 6; i++) {
        const a = base + i * 4, b = a + 4;
        emis.quad(a, a + 1, b + 1, b); emis.quad(a, b, b + 1, a + 1);
        emis.quad(a + 2, a + 3, b + 3, b + 2); emis.quad(a + 2, b + 2, b + 3, a + 3);
      }
      lathe(emis, d.x, d.y - d.h - 0.07, d.z, 0, 0, [[0.001, 0], [0.06, 0.06], [0.001, 0.12]], 6, () => sc(L, 1.1));
      break;
    }
    case 'hive': {
      // A ribbed mound, dark, with glowing slits between the ribs.
      const prof: [number, number][] = [];
      for (let i = 0; i <= 7; i++) { const t = i / 7; prof.push([d.s * Math.sin((1 - t) * Math.PI / 2 + 0.001) * (1 - 0.15 * Math.sin(t * Math.PI * 3)), d.h * t]); }
      lathe(lit, d.x, d.y - 0.1, d.z, d.yaw, 0, prof, 18, (r, s) => (s % 3 === 0 ? [0.12, 0.08, 0.1] : [0.24, 0.17, 0.2]));
      for (let i = 0; i < 6; i++) {
        const a = d.yaw + (i / 6) * Math.PI * 2;
        const fx = Math.sin(a), fz = Math.cos(a);
        archQuad(emis, d.x + fx * d.s * 0.9, d.y + d.h * 0.05, d.z + fz * d.s * 0.9, fx, fz, 0.12, d.h * 0.45, sc(M, 0.9));
      }
      break;
    }
    case 'pen': {
      // A cage of hardened slime bars curving in over a ring.
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        for (let k = 0; k < 6; k++) {
          const t0 = k / 6, t1 = (k + 1) / 6;
          const r0 = d.s * Math.cos(t0 * 1.2), r1 = d.s * Math.cos(t1 * 1.2);
          const y0 = d.y + Math.sin(t0 * 1.2) * d.h, y1 = d.y + Math.sin(t1 * 1.2) * d.h;
          beam(lit, d.x + ca * r0, y0, d.z + sa * r0, d.x + ca * r1, y1, d.z + sa * r1, 0.07, [0.2, 0.12, 0.16]);
        }
      }
      lathe(lit, d.x, d.y - 0.05, d.z, 0, 0, [[d.s + 0.2, 0], [d.s + 0.15, 0.2], [d.s - 0.15, 0.22], [d.s - 0.2, 0]], 18, () => [0.18, 0.12, 0.15]);
      break;
    }
    case 'post': {
      lathe(lit, d.x, d.y - 0.1, d.z, 0, 0, [[d.s * 1.4, 0], [d.s, 0.4], [d.s * 0.8, d.h * 0.8], [d.s * 0.5, d.h]], 7, () => [0.35, 0.5, 0.45]);
      lathe(emis, d.x, d.y + d.h, d.z, 0, 0, [[0.001, -0.05], [0.18, 0.05], [0.001, 0.22]], 7, () => sc(LUMEN_COL[0], 1));
      break;
    }
    case 'cans': for (let i = 0; i < 5; i++) { const a = rnd() * 6.28, r = rnd() * 0.35 * d.s; const x = d.x + Math.cos(a) * r, z = d.z + Math.sin(a) * r; lathe(lit, x, d.y, z, 0, 0, [[0.033, 0], [0.033, 0.12]], 7, () => [0.5 + rnd() * 0.4, 0.4 + rnd() * 0.3, 0.3 + rnd() * 0.3]); } break;
    case 'phone': {
      boxAt(lit, d.x, d.y + 0.006, d.z, 0.04, 0.006, 0.075, d.yaw, [0.1, 0.1, 0.11]);
      boxAt(emis, d.x, d.y + 0.013, d.z, 0.034, 0.001, 0.066, d.yaw, rnd() < 0.5 ? [0.35, 0.55, 0.9] : [0.12, 0.12, 0.14]);
      break;
    }
    case 'keys': for (let i = 0; i < 3; i++) boxAt(lit, d.x + (rnd() - 0.5) * 0.1, d.y + 0.004, d.z + (rnd() - 0.5) * 0.1, 0.012, 0.003, 0.03, rnd() * 6.28, [0.75, 0.68, 0.4]); break;
    case 'wheel': {
      // A bicycle wheel lying flat: rim and spokes.
      for (let i = 0; i < 16; i++) {
        const a0 = (i / 16) * Math.PI * 2, a1 = ((i + 1) / 16) * Math.PI * 2;
        beam(lit, d.x + Math.cos(a0) * 0.33, d.y + 0.02, d.z + Math.sin(a0) * 0.33, d.x + Math.cos(a1) * 0.33, d.y + 0.02, d.z + Math.sin(a1) * 0.33, 0.015, [0.2, 0.2, 0.22]);
        if (i % 2 === 0) beam(lit, d.x, d.y + 0.02, d.z, d.x + Math.cos(a0) * 0.32, d.y + 0.02, d.z + Math.sin(a0) * 0.32, 0.003, [0.7, 0.7, 0.72]);
      }
      break;
    }
    case 'egg': lathe(emis, d.x, d.y - 0.02, d.z, d.yaw, 0, [[0.001, 0], [d.s * 0.8, d.s * 0.2], [d.s, d.s * 0.6], [d.s * 0.75, d.s * 1.05], [0.001, d.s * 1.3]], 10, (r) => sc(LUMEN_COL[d.c % 3], 0.35 + r * 0.12)); break;
    case 'bone': for (let i = 0; i < 6; i++) { const a = rnd() * 6.28, r = rnd() * d.s; boxAt(lit, d.x + Math.cos(a) * r, d.y + 0.08, d.z + Math.sin(a) * r, 0.1 + rnd() * 0.2, 0.06 + rnd() * 0.08, 0.08 + rnd() * 0.15, rnd() * 6.28, [0.45, 0.42, 0.4]); } break;
  }
}

/** A thin round-ish beam between two points (four sides). */
function beam(g: Geo, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, c: C3): void {
  const dx = bx - ax, dy = by - ay, dz = bz - az, L = Math.hypot(dx, dy, dz) || 1;
  // Two axes across the beam.
  let ux = -dz, uy = 0, uz = dx;
  let ul = Math.hypot(ux, uy, uz);
  if (ul < 1e-4) { ux = 1; uy = 0; uz = 0; ul = 1; }
  ux /= ul; uy /= ul; uz /= ul;
  const vx = (dy * uz - dz * uy) / L, vy = (dz * ux - dx * uz) / L, vz = (dx * uy - dy * ux) / L;
  const base = g.count;
  for (let s = 0; s < 4; s++) {
    const a = (s / 4) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    const ox = (ux * ca + vx * sa) * r, oy = (uy * ca + vy * sa) * r, oz = (uz * ca + vz * sa) * r;
    g.vert(ax + ox, ay + oy, az + oz, ox / r, oy / r, oz / r, c[0], c[1], c[2]);
    g.vert(bx + ox, by + oy, bz + oz, ox / r, oy / r, oz / r, c[0], c[1], c[2]);
  }
  for (let s = 0; s < 4; s++) {
    const a = base + s * 2, b = base + ((s + 1) % 4) * 2;
    g.quad(a, b, b + 1, a + 1);
  }
}

/** An upright arch-topped quad facing (fx, fz), both sides. */
function archQuad(g: Geo, x: number, y: number, z: number, fx: number, fz: number, hw: number, h: number, c: C3): void {
  const sx = -fz, sz = fx;
  const base = g.count;
  g.vert(x, y + h * 0.5, z, fx, 0, fz, c[0], c[1], c[2]);
  const n = 8;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // Round the outline: straight sides, a half-round top.
    const a = Math.PI * t;
    const lx = -Math.cos(a) * hw, ly = h - hw + Math.sin(a) * hw;
    g.vert(x + sx * lx, y + Math.max(0, ly), z + sz * lx, fx, 0, fz, c[0], c[1], c[2]);
  }
  g.vert(x + sx * hw, y, z + sz * hw, fx, 0, fz, c[0], c[1], c[2]);
  g.vert(x - sx * hw, y, z - sz * hw, fx, 0, fz, c[0], c[1], c[2]);
  const last = base + n + 1;
  for (let i = 0; i < n; i++) { g.tri(base, base + 1 + i, base + 2 + i); g.tri(base, base + 2 + i, base + 1 + i); }
  for (const [p, q] of [[last, base + 1], [base + n + 1, last + 1], [last + 1, last + 2]]) { g.tri(base, p, q); g.tri(base, q, p); }
}

/** A glowing vein segment lying on the floor. */
function vein(s: number[], g: Geo): void {
  const [ax, ay, az, bx, by, bz] = s;
  const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1;
  const w = 0.09, px = (-dz / L) * w, pz = (dx / L) * w;
  const c = MURK_COL[0];
  const base = g.count;
  g.vert(ax + px, ay, az + pz, 0, 1, 0, c[0] * 0.8, c[1], c[2]);
  g.vert(ax - px, ay, az - pz, 0, 1, 0, c[0] * 0.8, c[1], c[2]);
  g.vert(bx - px, by, bz - pz, 0, 1, 0, c[0] * 0.8, c[1], c[2]);
  g.vert(bx + px, by, bz + pz, 0, 1, 0, c[0] * 0.8, c[1], c[2]);
  g.quad(base, base + 3, base + 2, base + 1);
}

function mulberry(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
