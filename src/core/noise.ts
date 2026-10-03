/**
 * Seeded gradient noise (simplex 2D/3D), cellular noise and fractal helpers.
 * Hot path for world generation: keep allocation free.
 */
import { Rng, hash2i, hash3i, hashToFloat } from './rng';

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3;
const G3 = 1 / 6;

const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

// 2D: 12 gradients on the unit circle for better isotropy than the classic 8.
const GRAD2 = new Float32Array(24);
for (let i = 0; i < 12; i++) {
  const a = (i / 12) * Math.PI * 2 + 0.13;
  GRAD2[i * 2] = Math.cos(a);
  GRAD2[i * 2 + 1] = Math.sin(a);
}

export class Noise {
  private perm = new Uint8Array(512);
  private perm12 = new Uint8Array(512);
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    const rng = new Rng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.float() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.perm12[i] = this.perm[i] % 12;
    }
  }

  /** Simplex noise 2D, output roughly in [-1, 1]. */
  n2(xin: number, yin: number): number {
    const perm = this.perm;
    const p12 = this.perm12;
    let n0 = 0, n1 = 0, n2 = 0;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    let i1: number, j1: number;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = p12[ii + perm[jj]] * 2;
      t0 *= t0;
      n0 = t0 * t0 * (GRAD2[g] * x0 + GRAD2[g + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = p12[ii + i1 + perm[jj + j1]] * 2;
      t1 *= t1;
      n1 = t1 * t1 * (GRAD2[g] * x1 + GRAD2[g + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = p12[ii + 1 + perm[jj + 1]] * 2;
      t2 *= t2;
      n2 = t2 * t2 * (GRAD2[g] * x2 + GRAD2[g + 1] * y2);
    }
    return 99.2 * (n0 + n1 + n2);
  }

  /**
   * Simplex noise 2D with analytic derivatives: writes [value, d/dx, d/dy] into `out`
   * (value identical to n2).
   */
  n2d(xin: number, yin: number, out: Float64Array | number[]): void {
    const perm = this.perm;
    const p12 = this.perm12;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
    const ii = i & 255, jj = j & 255;
    let v = 0, dx = 0, dy = 0;
    const corner = (cx: number, cy: number, gi: number) => {
      const tt = 0.5 - cx * cx - cy * cy;
      if (tt <= 0) return;
      const g = gi * 2;
      const gd = GRAD2[g] * cx + GRAD2[g + 1] * cy;
      const t2 = tt * tt, t4 = t2 * t2;
      v += t4 * gd;
      const k = -8 * t2 * tt * gd;
      dx += k * cx + t4 * GRAD2[g];
      dy += k * cy + t4 * GRAD2[g + 1];
    };
    corner(x0, y0, p12[ii + perm[jj]]);
    corner(x0 - i1 + G2, y0 - j1 + G2, p12[ii + i1 + perm[jj + j1]]);
    corner(x0 - 1 + 2 * G2, y0 - 1 + 2 * G2, p12[ii + 1 + perm[jj + 1]]);
    out[0] = 99.2 * v;
    out[1] = 99.2 * dx;
    out[2] = 99.2 * dy;
  }

  /**
   * Inigo Quilez's terrain fBm (iquilezles.org/articles/morenoise): each octave is damped
   * by the slope accumulated so far, so detail fades on steep flanks and gathers on
   * flats and crests — eroded-looking ranges without the fins of ridged/abs noise.
   * Octaves are rotated against each other to avoid grid alignment. Result ≈ [-1, 1].
   * `damp` scales how strongly slope suppresses later octaves.
   */
  iqFbm2(x: number, y: number, octaves: number, gain = 0.5, damp = 0.35): number {
    const o = this.iqTmp;
    let a = 0, b = 1, norm = 0, dx = 0, dy = 0, px = x, py = y;
    for (let k = 0; k < octaves; k++) {
      this.n2d(px + k * 19.1, py - k * 7.3, o);
      dx += o[1] * damp;
      dy += o[2] * damp;
      a += (b * o[0]) / (1 + dx * dx + dy * dy);
      norm += b;
      b *= gain;
      // p = m·p with m = [[1.6, -1.2], [1.2, 1.6]] (×2 and a ~37° rotation).
      const nx = 1.6 * px - 1.2 * py, ny = 1.2 * px + 1.6 * py;
      px = nx;
      py = ny;
    }
    return a / norm;
  }
  private iqTmp = new Float64Array(3);

  /** Simplex noise 3D, output roughly in [-1, 1]. */
  n3(xin: number, yin: number, zin: number): number {
    const perm = this.perm;
    const p12 = this.perm12;
    let n0 = 0, n1 = 0, n2 = 0, n3 = 0;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const g = p12[ii + perm[jj + perm[kk]]] * 3;
      t0 *= t0;
      n0 = t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const g = p12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
      t1 *= t1;
      n1 = t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const g = p12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
      t2 *= t2;
      n2 = t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const g = p12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
      t3 *= t3;
      n3 = t3 * t3 * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3);
    }
    return 32 * (n0 + n1 + n2 + n3);
  }

  /** Fractal Brownian motion 2D. Result roughly in [-1,1]. */
  fbm2(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let sum = 0, amp = 1, norm = 0, f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.n2(x * f + o * 17.31, y * f - o * 9.17);
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }

  fbm3(x: number, y: number, z: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let sum = 0, amp = 1, norm = 0, f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.n3(x * f + o * 17.31, y * f - o * 9.17, z * f + o * 5.71);
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal 2D in [0,1]: sharp crests, good for mountain ranges. */
  ridged2(x: number, y: number, octaves: number, lacunarity = 2.0, gain = 0.5, sharpness = 2): number {
    let sum = 0, amp = 1, norm = 0, f = 1, weight = 1;
    for (let o = 0; o < octaves; o++) {
      let n = 1 - Math.abs(this.n2(x * f + o * 31.7, y * f + o * 11.3));
      n = Math.pow(n, sharpness);
      n *= weight;
      weight = Math.min(1, Math.max(0, n * 1.6));
      sum += n * amp;
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }

  /**
   * Ridged multifractal for terrain, in [0,1]. Unlike ridged2, crests are rounded
   * (1 − |n| has a V-shaped crease; here |n| is softened by `round`) and finer octaves
   * add less steepness (amplitude × frequency shrinks per octave), so mountain ranges
   * get sharp silhouettes without rows of near-vertical creases.
   */
  ridgedTerrain2(x: number, y: number, octaves: number, sharpness = 1.6, round = 0.14, lacunarity = 2.05, gain = 0.42): number {
    let sum = 0, amp = 1, norm = 0, f = 1, weight = 1;
    const r2 = round * round;
    for (let o = 0; o < octaves; o++) {
      const v = this.n2(x * f + o * 31.7, y * f + o * 11.3);
      let n = 1 + round - Math.sqrt(v * v + r2);
      n = Math.pow(Math.max(0, n / (1 + round - round)), sharpness);
      n *= weight;
      weight = Math.min(1, Math.max(0, n * 1.6));
      sum += n * amp;
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }

  ridged3(x: number, y: number, z: number, octaves: number, lacunarity = 2.0, gain = 0.5): number {
    let sum = 0, amp = 1, norm = 0, f = 1;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.n3(x * f + o * 31.7, y * f, z * f + o * 11.3));
      sum += n * n * amp;
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }

  /** Billow noise in [0,1]: puffy shapes (dunes, clouds). */
  billow2(x: number, y: number, octaves: number): number {
    let sum = 0, amp = 1, norm = 0, f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += Math.abs(this.n2(x * f + o * 7.7, y * f + o * 3.3)) * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return sum / norm;
  }
}

export interface CellResult {
  /** distance to nearest feature point */
  f1: number;
  /** distance to second nearest */
  f2: number;
  /** integer cell coordinates of nearest feature */
  cx: number;
  cy: number;
  cz: number;
  /** hash of nearest cell (stable id) */
  id: number;
  /** nearest feature point position */
  px: number;
  py: number;
  pz: number;
}

/** Worley / cellular noise. Jitter in [0,1]. */
export function cellular2(seed: number, x: number, y: number, jitter = 1, out?: CellResult): CellResult {
  const r = out ?? { f1: 0, f2: 0, cx: 0, cy: 0, cz: 0, id: 0, px: 0, py: 0, pz: 0 };
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 1e9, f2 = 1e9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const h = hash2i(seed, cx, cy);
      const fx = cx + 0.5 + (hashToFloat(h) - 0.5) * jitter;
      const fy = cy + 0.5 + (hashToFloat(h * 2654435761) - 0.5) * jitter;
      const ddx = fx - x, ddy = fy - y;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        r.cx = cx; r.cy = cy; r.cz = 0; r.id = h; r.px = fx; r.py = fy; r.pz = 0;
      } else if (d < f2) f2 = d;
    }
  }
  r.f1 = f1;
  r.f2 = f2;
  return r;
}

export function cellular3(seed: number, x: number, y: number, z: number, jitter = 1, out?: CellResult): CellResult {
  const r = out ?? { f1: 0, f2: 0, cx: 0, cy: 0, cz: 0, id: 0, px: 0, py: 0, pz: 0 };
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let f1 = 1e9, f2 = 1e9;
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx, cy = yi + dy, cz = zi + dz;
        const h = hash3i(seed, cx, cy, cz);
        const fx = cx + 0.5 + (hashToFloat(h) - 0.5) * jitter;
        const fy = cy + 0.5 + (hashToFloat(Math.imul(h, 2654435761)) - 0.5) * jitter;
        const fz = cz + 0.5 + (hashToFloat(Math.imul(h, 2246822519)) - 0.5) * jitter;
        const ddx = fx - x, ddy = fy - y, ddz = fz - z;
        const d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
        if (d < f1) {
          f2 = f1;
          f1 = d;
          r.cx = cx; r.cy = cy; r.cz = cz; r.id = h; r.px = fx; r.py = fy; r.pz = fz;
        } else if (d < f2) f2 = d;
      }
  r.f1 = f1;
  r.f2 = f2;
  return r;
}
