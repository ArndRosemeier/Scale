/**
 * Texture synthesis core: periodic (tileable) noise, periodic Worley cells, wrapped blurs and
 * the final packing of albedo/roughness/height/normal/AO into RGBA8 layers.
 *
 * Coordinate convention used by every generator (see index.ts):
 *   pixel (i, j) -> u = (i + 0.5) / size, v = (j + 0.5) / size, meters x = u * W, y = v * W.
 *   Row j = 0 is v = 0 (BOTTOM of the tile, "down" on a facade). +y / +v is "up".
 * Pure TS, no DOM, no three.js: runs in a worker and in Node.
 */
import { hash2i, hash32, hashToFloat } from '../../core/rng';
import { saturate as clamp01, lerp as mix, smoothstep as smooth } from '../../core/math';
export { clamp01, mix, smooth };

/** Hash of (seed, a, b) to [0,1). */
export const rnd = (seed: number, a: number, b = 0): number => hashToFloat(hash2i(seed, a, b));
/** Wrapped signed difference a-b on a period p (result in [-p/2, p/2)). */
export function wrapd(d: number, p: number): number {
  d -= Math.floor(d / p + 0.5) * p;
  return d;
}
export function wrap(x: number, p: number): number {
  x %= p;
  return x < 0 ? x + p : x;
}

// ---------------------------------------------------------------------------------------------
// Periodic gradient noise
// ---------------------------------------------------------------------------------------------
const GX = new Float64Array(32), GY = new Float64Array(32);
for (let k = 0; k < 32; k++) {
  const a = (k / 32) * Math.PI * 2 + 0.21;
  GX[k] = Math.cos(a);
  GY[k] = Math.sin(a);
}

/** Periodic gradient (Perlin-style) noise: lattice period px x py, output ~[-1, 1]. */
export function pgrad(seed: number, x: number, y: number, px: number, py: number): number {
  const xf = Math.floor(x), yf = Math.floor(y);
  const fx = x - xf, fy = y - yf;
  let x0 = xf % px; if (x0 < 0) x0 += px;
  let y0 = yf % py; if (y0 < 0) y0 += py;
  const x1 = x0 + 1 === px ? 0 : x0 + 1;
  const y1 = y0 + 1 === py ? 0 : y0 + 1;
  const h00 = hash2i(seed, x0, y0) & 31, h10 = hash2i(seed, x1, y0) & 31;
  const h01 = hash2i(seed, x0, y1) & 31, h11 = hash2i(seed, x1, y1) & 31;
  const n00 = GX[h00] * fx + GY[h00] * fy;
  const n10 = GX[h10] * (fx - 1) + GY[h10] * fy;
  const n01 = GX[h01] * fx + GY[h01] * (fy - 1);
  const n11 = GX[h11] * (fx - 1) + GY[h11] * (fy - 1);
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = n00 + (n10 - n00) * u, b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 1.45;
}

/** Periodic value noise in [0,1) (blocky-smooth; good for per-area masks). */
export function pvalue(seed: number, x: number, y: number, px: number, py: number): number {
  const xf = Math.floor(x), yf = Math.floor(y);
  const fx = x - xf, fy = y - yf;
  let x0 = xf % px; if (x0 < 0) x0 += px;
  let y0 = yf % py; if (y0 < 0) y0 += py;
  const x1 = x0 + 1 === px ? 0 : x0 + 1;
  const y1 = y0 + 1 === py ? 0 : y0 + 1;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = rnd(seed, x0, y0), b = rnd(seed, x1, y0), c = rnd(seed, x0, y1), d = rnd(seed, x1, y1);
  return mix(mix(a, b, u), mix(c, d, u), v);
}

/** Permutation-table gradient noise (fast path for TNoise), periodic in px, py. */
function tgrad(P: Uint16Array, x: number, y: number, px: number, py: number): number {
  const xf = Math.floor(x), yf = Math.floor(y);
  const fx = x - xf, fy = y - yf;
  let x0 = xf % px; if (x0 < 0) x0 += px;
  let y0 = yf % py; if (y0 < 0) y0 += py;
  const x1 = x0 + 1 === px ? 0 : x0 + 1;
  const y1 = y0 + 1 === py ? 0 : y0 + 1;
  const a0 = P[x0 & 1023], a1 = P[x1 & 1023];
  const h00 = P[(a0 + y0) & 1023] & 31, h10 = P[(a1 + y0) & 1023] & 31;
  const h01 = P[(a0 + y1) & 1023] & 31, h11 = P[(a1 + y1) & 1023] & 31;
  const n00 = GX[h00] * fx + GY[h00] * fy;
  const n10 = GX[h10] * (fx - 1) + GY[h10] * fy;
  const n01 = GX[h01] * fx + GY[h01] * (fy - 1);
  const n11 = GX[h11] * (fx - 1) + GY[h11] * (fy - 1);
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = n00 + (n10 - n00) * u, b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 1.45;
}

/**
 * Tileable noise source bound to a tile. All sampling functions take tile coordinates
 * u, v (one tile = [0,1)) and a wavelength in meters; frequencies are rounded to integer
 * cycles per tile so everything wraps seamlessly.
 */
export class TNoise {
  private tabs: Uint16Array[] = [];
  constructor(readonly seed: number, readonly W: number) {}
  private tab(k: number): Uint16Array {
    let t = this.tabs[k];
    if (!t) {
      t = new Uint16Array(1024);
      for (let i = 0; i < 1024; i++) t[i] = i;
      for (let i = 1023; i > 0; i--) {
        const j = hash2i(this.seed, k, i) % (i + 1);
        const tmp = t[i]; t[i] = t[j]; t[j] = tmp;
      }
      this.tabs[k] = t;
    }
    return t;
  }
  /** cycles per tile for a wavelength in meters */
  f(lambda: number): number {
    return Math.max(1, Math.round(this.W / lambda));
  }
  /** single octave, wavelengths may differ per axis (anisotropic) */
  n(u: number, v: number, lx: number, ly = lx): number {
    const fx = this.f(lx), fy = this.f(ly);
    return tgrad(this.tab(0), u * fx, v * fy, fx, fy);
  }
  /** fBm, ~[-1,1] */
  fbm(u: number, v: number, lx: number, oct: number, gain = 0.5, ly = lx): number {
    let fx = this.f(lx), fy = this.f(ly);
    let sum = 0, amp = 1, norm = 0;
    for (let k = 0; k < oct; k++) {
      sum += amp * tgrad(this.tab(k), u * fx + k * 0.31, v * fy + k * 0.17, fx, fy);
      norm += amp;
      amp *= gain;
      fx *= 2;
      fy *= 2;
    }
    return sum / norm;
  }
  /** ridged fBm in [0,1] (sharp crests = 1) */
  ridged(u: number, v: number, lx: number, oct: number, gain = 0.5, ly = lx): number {
    let fx = this.f(lx), fy = this.f(ly);
    let sum = 0, amp = 1, norm = 0;
    for (let k = 0; k < oct; k++) {
      const r = 1 - Math.abs(tgrad(this.tab(16 + k), u * fx, v * fy, fx, fy));
      sum += amp * r * r;
      norm += amp;
      amp *= gain;
      fx *= 2;
      fy *= 2;
    }
    return sum / norm;
  }
  /** turbulence (abs fBm) in [0,1] */
  turb(u: number, v: number, lx: number, oct: number, gain = 0.5, ly = lx): number {
    let fx = this.f(lx), fy = this.f(ly);
    let sum = 0, amp = 1, norm = 0;
    for (let k = 0; k < oct; k++) {
      sum += amp * Math.abs(tgrad(this.tab(32 + k), u * fx, v * fy, fx, fy));
      norm += amp;
      amp *= gain;
      fx *= 2;
      fy *= 2;
    }
    return sum / norm;
  }
}

// ---------------------------------------------------------------------------------------------
// Periodic Worley / Voronoi
// ---------------------------------------------------------------------------------------------
export interface Cell {
  f1: number;
  f2: number;
  /** distance to the Voronoi border of the nearest cell (exact bisector distance), lattice units */
  edge: number;
  /** stable hash of the nearest cell (wrapped coordinates) */
  id: number;
  /** nearest feature point (unwrapped lattice coords, near x,y) */
  px: number;
  py: number;
}
export const newCell = (): Cell => ({ f1: 0, f2: 0, edge: 0, id: 0, px: 0, py: 0 });

/**
 * Periodic Worley noise on a px x py lattice (x,y in lattice units). With `edge`, also computes
 * the true distance to the cell border (IQ's two-pass method).
 */
export function worley(seed: number, x: number, y: number, px: number, py: number, jitter: number, out: Cell, edge = false): Cell {
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 1e9, f2 = 1e9, bx = 0, by = 0, bid = 0, bcx = 0, bcy = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const cy = yi + dy;
    let wy = cy % py; if (wy < 0) wy += py;
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx;
      let wx = cx % px; if (wx < 0) wx += px;
      const h = hash2i(seed, wx, wy);
      const fx = cx + 0.5 + (hashToFloat(h) - 0.5) * jitter;
      const fy = cy + 0.5 + (hashToFloat(hash32(h)) - 0.5) * jitter;
      const ddx = fx - x, ddy = fy - y;
      const d = ddx * ddx + ddy * ddy;
      if (d < f1) { f2 = f1; f1 = d; bx = fx; by = fy; bid = h; bcx = cx; bcy = cy; } else if (d < f2) f2 = d;
    }
  }
  out.f1 = Math.sqrt(f1);
  out.f2 = Math.sqrt(f2);
  out.id = bid;
  out.px = bx;
  out.py = by;
  if (edge) {
    let md = 1e9;
    for (let dy = -2; dy <= 2; dy++) {
      const cy = bcy + dy;
      let wy = cy % py; if (wy < 0) wy += py;
      for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dy === 0) continue;
        const cx = bcx + dx;
        let wx = cx % px; if (wx < 0) wx += px;
        const h = hash2i(seed, wx, wy);
        const fx = cx + 0.5 + (hashToFloat(h) - 0.5) * jitter;
        const fy = cy + 0.5 + (hashToFloat(hash32(h)) - 0.5) * jitter;
        const nx = fx - bx, ny = fy - by;
        const nl = Math.sqrt(nx * nx + ny * ny);
        if (nl < 1e-6) continue;
        const d = ((bx + fx) * 0.5 - x) * (nx / nl) + ((by + fy) * 0.5 - y) * (ny / nl);
        if (d < md) md = d;
      }
    }
    out.edge = md;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Texture working buffers
// ---------------------------------------------------------------------------------------------
export interface TexLayer {
  albedo: Uint8Array;
  normal: Uint8Array;
}

export class Tex {
  readonly n: number;
  /** meters per pixel */
  readonly ps: number;
  /** albedo in sRGB 0..1 */
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  readonly rough: Float32Array;
  /** height in meters (relief) */
  readonly h: Float32Array;
  constructor(readonly size: number, readonly W: number) {
    this.n = size * size;
    this.ps = W / size;
    this.r = new Float32Array(this.n);
    this.g = new Float32Array(this.n);
    this.b = new Float32Array(this.n);
    this.rough = new Float32Array(this.n);
    this.h = new Float32Array(this.n);
  }
  /** Calls fn for every pixel with tile coords u,v in [0,1) and meters x,y. */
  each(fn: (u: number, v: number, x: number, y: number, idx: number, i: number, j: number) => void): void {
    const s = this.size, W = this.W;
    for (let j = 0; j < s; j++) {
      const v = (j + 0.5) / s;
      for (let i = 0; i < s; i++) {
        const u = (i + 0.5) / s;
        fn(u, v, u * W, v * W, j * s + i, i, j);
      }
    }
  }
  set(idx: number, r: number, g: number, b: number, rough: number, h: number): void {
    this.r[idx] = r; this.g[idx] = g; this.b[idx] = b; this.rough[idx] = rough; this.h[idx] = h;
  }
}

/** Separable wrapped box blur (radius in pixels, integer >= 1). */
function boxBlur(src: Float32Array, dst: Float32Array, tmp: Float32Array, s: number, r: number): void {
  const inv = 1 / (2 * r + 1);
  for (let j = 0; j < s; j++) {
    const row = j * s;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + ((k % s) + s) % s];
    for (let i = 0; i < s; i++) {
      tmp[row + i] = acc * inv;
      acc += src[row + (i + r + 1) % s] - src[row + ((i - r) % s + s) % s];
    }
  }
  for (let i = 0; i < s; i++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[(((k % s) + s) % s) * s + i];
    for (let j = 0; j < s; j++) {
      dst[j * s + i] = acc * inv;
      acc += tmp[((j + r + 1) % s) * s + i] - tmp[(((j - r) % s + s) % s) * s + i];
    }
  }
}

/** Approximate gaussian blur (3 box passes), wrapped; sigma in pixels. */
export function blur(src: Float32Array, s: number, sigma: number): Float32Array {
  const out = new Float32Array(src.length), tmp = new Float32Array(src.length);
  const r = Math.max(1, Math.round(sigma * 0.95));
  boxBlur(src, out, tmp, s, r);
  boxBlur(out, out, tmp, s, r);
  boxBlur(out, out, tmp, s, r);
  return out;
}

export interface FinishOpts {
  /** normal exaggeration over the physical slope of the height field (1 = physical) */
  normal?: number;
  /** AO cavity radii in meters (small, large) */
  aoR?: [number, number];
  /** AO strength per meter of cavity depth (ao = exp(-k * cavity)) */
  aoK?: number;
}

/** Packs the working buffers into the final RGBA8 layer pair. */
export function finish(t: Tex, o: FinishOpts = {}): TexLayer {
  const s = t.size, n = t.n, h = t.h;
  const albedo = new Uint8Array(n * 4), normal = new Uint8Array(n * 4);
  const ns = (o.normal ?? 1) / (8 * t.ps);
  const [r1, r2] = o.aoR ?? [0.01, 0.04];
  const k = o.aoK ?? 40;
  const b1 = blur(h, s, Math.max(1, r1 / t.ps));
  const b2 = blur(h, s, Math.max(1.5, r2 / t.ps));
  let hmin = 1e9, hmax = -1e9;
  for (let i = 0; i < n; i++) { if (h[i] < hmin) hmin = h[i]; if (h[i] > hmax) hmax = h[i]; }
  const hs = hmax > hmin ? 255 / (hmax - hmin) : 0;
  for (let j = 0; j < s; j++) {
    const jm = ((j - 1 + s) % s) * s, j0 = j * s, jp = ((j + 1) % s) * s;
    for (let i = 0; i < s; i++) {
      const im = (i - 1 + s) % s, ip = (i + 1) % s;
      // Sobel; +x = increasing i, +y = increasing j (= +v, up)
      const gx = (h[jm + ip] + 2 * h[j0 + ip] + h[jp + ip]) - (h[jm + im] + 2 * h[j0 + im] + h[jp + im]);
      const gy = (h[jp + im] + 2 * h[jp + i] + h[jp + ip]) - (h[jm + im] + 2 * h[jm + i] + h[jm + ip]);
      let nx = -gx * ns, ny = -gy * ns;
      const l = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= l; ny *= l;
      const idx = j0 + i, o4 = idx * 4;
      const cav = Math.max(0, b1[idx] - h[idx]) * 0.55 + Math.max(0, b2[idx] - h[idx]) * 0.45;
      const ao = Math.exp(-k * cav);
      normal[o4] = Math.round((nx * 0.5 + 0.5) * 255);
      normal[o4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normal[o4 + 2] = Math.round((h[idx] - hmin) * hs);
      normal[o4 + 3] = Math.round(clamp01(ao) * 255);
      albedo[o4] = Math.round(Math.min(0.95, Math.max(0.025, t.r[idx])) * 255);
      albedo[o4 + 1] = Math.round(Math.min(0.95, Math.max(0.025, t.g[idx])) * 255);
      albedo[o4 + 2] = Math.round(Math.min(0.95, Math.max(0.025, t.b[idx])) * 255);
      albedo[o4 + 3] = Math.round(Math.min(1, Math.max(0.02, t.rough[idx])) * 255);
    }
  }
  return { albedo, normal };
}

/** sRGB 0..255 triple to 0..1 */
export type RGB = [number, number, number];
export const rgb = (r: number, g: number, b: number): RGB => [r / 255, g / 255, b / 255];
