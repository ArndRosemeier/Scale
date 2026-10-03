/**
 * Terrain and water as pure functions of world position.
 *
 * Height is composed of: the river valley (the city sits in it), regional
 * hills (seed decides how many), the sea (coastal seeds) and the carved river
 * channels. Everything is deterministic and cheap enough to evaluate millions
 * of times in workers.
 */
import { Noise } from '../core/noise';
import { Rng, deriveSeed } from '../core/rng';
import { chaikin, resample } from '../core/geom2';
import { smoothstep, clamp, lerp } from '../core/math';
import type { WorldProfile } from './settings';

export interface River {
  /** Centerline, resampled ~12 m. */
  pts: Float64Array;
  /** Arc length at each point. */
  s: Float64Array;
  length: number;
  /** Water level at start / end. */
  level0: number;
  level1: number;
  /** Width at start / end. */
  width0: number;
  width1: number;
  /** Index of the river this one flows into (-1 none). */
  joins: number;
}

export interface WaterQuery {
  /** Distance to nearest river centerline. */
  d: number;
  /** Arc length on that river. */
  s: number;
  river: number;
  halfWidth: number;
  level: number;
}

const HASH_CELL = 128;
const NEAR_RANGE = 700;
const RASTER_CELL = 160;

export class Terrain {
  readonly profile: WorldProfile;
  readonly noise: Noise;
  readonly noise2: Noise;
  readonly rivers: River[] = [];
  /** Sea level is always 0. */
  readonly seaLevel = 0;
  /** Extent of the precomputed rasters (half size). */
  readonly extent: number;

  private segHash = new Map<number, number[]>(); // key -> [river, idx, ...]
  private raster!: Float32Array; // per cell: d, level, halfWidth
  private rasterN = 0;

  constructor(profile: WorldProfile) {
    this.profile = profile;
    this.noise = new Noise(deriveSeed(profile.seed, 'terrain'));
    this.noise2 = new Noise(deriveSeed(profile.seed, 'terrain2'));
    this.extent = profile.radius * 1.6 + 2000;
    this.makeRivers();
    this.buildIndex();
  }

  // ---------------------------------------------------------------- rivers

  private makeRivers(): void {
    const p = this.profile;
    const rng = new Rng(deriveSeed(p.seed, 'rivers'));
    const R = this.extent * 1.05;
    // Main river: enters on the land side, passes near the centre, exits towards the sea.
    let exitAng: number;
    if (p.coastal) exitAng = Math.atan2(p.seaDir[1], p.seaDir[0]) + rng.range(-0.5, 0.5);
    else exitAng = rng.range(0, Math.PI * 2);
    const entryAng = exitAng + Math.PI + rng.range(-0.9, 0.9);
    const passR = p.radius * rng.range(0.04, 0.3);
    const passA = rng.range(0, Math.PI * 2);
    const main = this.meander(
      rng,
      [Math.cos(entryAng) * R, Math.sin(entryAng) * R],
      [Math.cos(passA) * passR, Math.sin(passA) * passR],
      [Math.cos(exitAng) * R, Math.sin(exitAng) * R],
      p.coastal ? this.coastClip.bind(this) : null,
    );
    const len0 = this.lengthOf(main);
    const drop = Math.max(2, Math.min(18, len0 * 0.00035));
    const endLevel = p.coastal ? 0.2 : Math.max(2, p.baseElevation - drop * 0.5);
    this.rivers.push(this.makeRiver(main, endLevel + drop, endLevel, p.riverWidth * 0.8, p.riverWidth * 1.2, -1));

    for (let k = 1; k < p.rivers; k++) {
      // Tributary: from the boundary to a confluence on the main river.
      const r0 = this.rivers[0];
      const ci = Math.floor(r0.pts.length / 2 * rng.range(0.35, 0.7)) * 2;
      const cx = r0.pts[ci], cz = r0.pts[ci + 1];
      const ang = rng.range(0, Math.PI * 2);
      const trib = this.meander(rng, [Math.cos(ang) * R, Math.sin(ang) * R], [cx * 0.5 + Math.cos(ang) * p.radius * 0.3, cz * 0.5 + Math.sin(ang) * p.radius * 0.3], [cx, cz], null);
      const lvl = this.riverLevelAt(0, r0.s[ci / 2]);
      this.rivers.push(this.makeRiver(trib, lvl + drop * 0.7, lvl, p.riverWidth * 0.35, p.riverWidth * 0.55, 0));
    }
  }

  private coastClip(x: number, z: number): boolean {
    return this.coastDistance(x, z) < -200;
  }

  private meander(rng: Rng, a: [number, number], m: [number, number], b: [number, number], stop: ((x: number, z: number) => boolean) | null): number[] {
    // Coarse control polyline through a -> m -> b, then sinuous perturbation.
    const ctrl: number[] = [];
    // Natural meander wavelength is ~10-14 channel widths.
    const ctrlStep = Math.max(350, this.profile.riverWidth * 4.5);
    const legs: [number, number][][] = [[a, m], [m, b]];
    for (const [p0, p1] of legs) {
      const n = Math.max(2, Math.round(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / ctrlStep));
      for (let i = 0; i < n; i++) {
        const t = i / n;
        ctrl.push(p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t);
      }
    }
    ctrl.push(b[0], b[1]);
    // Perpendicular sinuous offset (meanders), amplitude scales with width.
    const amp = 90 + this.profile.riverWidth * 2.2 + rng.range(0, 200);
    const ph = rng.range(0, 100);
    const out: number[] = [];
    const n = ctrl.length >> 1;
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      let dx = ctrl[i1 * 2] - ctrl[i0 * 2], dz = ctrl[i1 * 2 + 1] - ctrl[i0 * 2 + 1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      const edge = Math.min(i, n - 1 - i) / 3;
      const w = Math.min(1, edge);
      const off = this.noise2.fbm2(i * 0.3 + ph, ph * 0.5, 2) * amp * 2.2 * w;
      out.push(ctrl[i * 2] - dz * off, ctrl[i * 2 + 1] + dx * off);
    }
    let pts = resample(chaikin(out, 4), 12);
    if (stop) {
      // Cut the river where it is well into the sea.
      for (let i = 0; i < pts.length; i += 2) {
        if (stop(pts[i], pts[i + 1])) { pts = pts.slice(0, Math.max(4, i + 2)); break; }
      }
    }
    return pts;
  }

  private lengthOf(pts: number[]): number {
    let s = 0;
    for (let i = 2; i < pts.length; i += 2) s += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    return s;
  }

  private makeRiver(pts: number[], level0: number, level1: number, width0: number, width1: number, joins: number): River {
    const n = pts.length >> 1;
    const s = new Float64Array(n);
    for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
    return { pts: Float64Array.from(pts), s, length: s[n - 1], level0, level1, width0, width1, joins };
  }

  riverLevelAt(r: number, s: number): number {
    const R = this.rivers[r];
    return lerp(R.level0, R.level1, clamp(s / R.length, 0, 1));
  }
  riverHalfWidthAt(r: number, s: number): number {
    const R = this.rivers[r];
    const t = clamp(s / R.length, 0, 1);
    // Gentle width variation along the course.
    const wob = 1 + 0.12 * this.noise2.n2(s * 0.0025 + r * 31, 7.3);
    return 0.5 * lerp(R.width0, R.width1, t) * wob;
  }

  private buildIndex(): void {
    for (let r = 0; r < this.rivers.length; r++) {
      const pts = this.rivers[r].pts;
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const x0 = Math.min(pts[i], pts[i + 2]) - NEAR_RANGE, x1 = Math.max(pts[i], pts[i + 2]) + NEAR_RANGE;
        const z0 = Math.min(pts[i + 1], pts[i + 3]) - NEAR_RANGE, z1 = Math.max(pts[i + 1], pts[i + 3]) + NEAR_RANGE;
        for (let cx = Math.floor(x0 / HASH_CELL); cx <= Math.floor(x1 / HASH_CELL); cx++) {
          for (let cz = Math.floor(z0 / HASH_CELL); cz <= Math.floor(z1 / HASH_CELL); cz++) {
            const key = (cx + 32768) * 65536 + (cz + 32768);
            let b = this.segHash.get(key);
            if (!b) this.segHash.set(key, (b = []));
            b.push(r, i >> 1);
          }
        }
      }
    }
    // Coarse raster of (distance, level, halfWidth) for valley shaping far from the water.
    const N = Math.ceil((this.extent * 2) / RASTER_CELL) + 1;
    this.rasterN = N;
    this.raster = new Float32Array(N * N * 3);
    const step = 4; // check every 4th point: plenty at 160 m cells
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = -this.extent + i * RASTER_CELL, z = -this.extent + j * RASTER_CELL;
        let best = Infinity, bl = 0, bw = 0;
        for (let r = 0; r < this.rivers.length; r++) {
          const R = this.rivers[r];
          const pts = R.pts;
          for (let k = 0; k < pts.length; k += 2 * step) {
            const d = (pts[k] - x) * (pts[k] - x) + (pts[k + 1] - z) * (pts[k + 1] - z);
            if (d < best) { best = d; bl = this.riverLevelAt(r, R.s[k >> 1]); bw = this.riverHalfWidthAt(r, R.s[k >> 1]); }
          }
        }
        const o = (j * N + i) * 3;
        this.raster[o] = Math.sqrt(best);
        this.raster[o + 1] = bl;
        this.raster[o + 2] = bw;
      }
    }
  }

  private sampleRaster(x: number, z: number, out: [number, number, number]): void {
    const N = this.rasterN;
    const fx = clamp((x + this.extent) / RASTER_CELL, 0, N - 1.001);
    const fz = clamp((z + this.extent) / RASTER_CELL, 0, N - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const r = this.raster;
    for (let c = 0; c < 3; c++) {
      const a = r[(j * N + i) * 3 + c], b = r[(j * N + i + 1) * 3 + c];
      const d = r[((j + 1) * N + i) * 3 + c], e = r[((j + 1) * N + i + 1) * 3 + c];
      out[c] = lerp(lerp(a, b, tx), lerp(d, e, tx), tz);
    }
  }

  private wq: WaterQuery = { d: Infinity, s: 0, river: -1, halfWidth: 0, level: 0 };

  /** Exact nearest-river query (valid within NEAR_RANGE; d=Infinity beyond). Reuses the result object. */
  water(x: number, z: number, out: WaterQuery = this.wq): WaterQuery {
    out.d = Infinity;
    out.river = -1;
    const key = (Math.floor(x / HASH_CELL) + 32768) * 65536 + (Math.floor(z / HASH_CELL) + 32768);
    const b = this.segHash.get(key);
    if (!b) return out;
    let best = Infinity;
    for (let k = 0; k < b.length; k += 2) {
      const r = b[k], i = b[k + 1];
      const pts = this.rivers[r].pts;
      const ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[i * 2 + 2], bz = pts[i * 2 + 3];
      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + dx * t - x, qz = az + dz * t - z;
      const d = qx * qx + qz * qz;
      // Weight by river width so a wide river "wins" near a confluence.
      if (d < best) {
        best = d;
        out.river = r;
        out.s = this.rivers[r].s[i] + Math.sqrt(l2) * t;
      }
    }
    if (out.river >= 0) {
      out.d = Math.sqrt(best);
      out.halfWidth = this.riverHalfWidthAt(out.river, out.s);
      out.level = this.riverLevelAt(out.river, out.s);
    }
    return out;
  }

  // ------------------------------------------------------------------- sea

  /** Signed distance inland from the coastline (negative = sea). Infinity if not coastal. */
  coastDistance(x: number, z: number): number {
    const p = this.profile;
    if (!p.coastal) return Infinity;
    const along = x * p.seaDir[0] + z * p.seaDir[1];
    const warp = this.noise.fbm2(x / 2600 + 11, z / 2600 - 7, 3) * p.radius * 0.18 + this.noise.fbm2(x / 520, z / 520, 2) * 40;
    return p.coastOffset - along + warp;
  }

  // ---------------------------------------------------------------- height

  private rtmp: [number, number, number] = [0, 0, 0];

  /**
   * Natural ground height (before urban grading). Hot path.
   */
  height(x: number, z: number): number {
    const p = this.profile;
    this.sampleRaster(x, z, this.rtmp);
    const dFar = this.rtmp[0];
    const farLevel = this.rtmp[1];
    // Valley: rises away from the river, flattening into a plateau.
    const valleyRise = (14 + p.hilliness * 45) * (1 - Math.exp(-Math.max(0, dFar - 60) / 1600));
    let h = farLevel + 2.8 + valleyRise;
    // Rolling hills, suppressed close to the river.
    const hs = p.hillScale;
    const hillMask = smoothstep(80, 700, dFar);
    const n1 = this.noise.fbm2(x / hs, z / hs, 4);
    const n2 = this.noise.ridgedTerrain2(x / (hs * 0.55) + 3.1, z / (hs * 0.55) - 1.7, 3);
    const hills = p.hilliness * (55 * (n1 * 0.5 + 0.5) + 22 * n2 * p.hilliness);
    h += hills * hillMask;
    // Small-scale undulation everywhere (keeps streets from being perfectly flat).
    h += this.noise.fbm2(x / 260, z / 260, 2) * (0.6 + 2.2 * p.hilliness);

    // River channel and banks (exact, near the water only).
    if (dFar < NEAR_RANGE + 200) {
      const w = this.water(x, z);
      if (w.river >= 0) {
        const hw = w.halfWidth;
        const bankTop = w.level + 2.8;
        // Pull the immediate valley floor to bank height.
        const vb = smoothstep(hw + 10, hw + 160, w.d);
        h = lerp(bankTop, Math.max(h, bankTop), vb);
        // Urban banks are quays (near vertical); natural banks slope gently.
        const rr = Math.hypot(x, z);
        const bankW = lerp(0.8, 12, smoothstep(p.radius * 0.95, p.radius * 1.25, rr));
        if (w.d < hw + bankW) {
          // Bank slope from the water's edge to bank top.
          const t = clamp((w.d - hw) / bankW, 0, 1);
          h = lerp(w.level - 0.4, bankTop, t * t * (3 - 2 * t));
        }
        if (w.d < hw) {
          const depth = 2.5 + hw * 0.06;
          const q = w.d / hw;
          h = w.level - 0.4 - depth * (1 - q * q);
        }
      }
    }
    // Sea.
    if (p.coastal) {
      const c = this.coastDistance(x, z);
      const shore = 1.2;
      const land = smoothstep(-10, 900, c);
      h = lerp(shore + Math.max(0, c) * 0.004, h, land);
      if (c < 0) h = Math.min(h, shore - Math.min(28, -c * 0.06 + 1.5));
    }

    return h;
  }

  /** Water surface height at (x,z) or -Infinity when dry. */
  waterLevel(x: number, z: number): number {
    const p = this.profile;
    if (p.coastal && this.coastDistance(x, z) < 0) return 0;
    const w = this.water(x, z);
    if (w.river >= 0 && w.d < w.halfWidth + 0.5) return w.level;
    return -Infinity;
  }

  /** True when (x,z) is in the river or the sea (with optional margin in m). */
  isWater(x: number, z: number, margin = 0): boolean {
    const p = this.profile;
    if (p.coastal && this.coastDistance(x, z) < margin) return true;
    const w = this.water(x, z);
    return w.river >= 0 && w.d < w.halfWidth + margin;
  }

  /** Gradient magnitude (slope) by central differences. */
  slope(x: number, z: number, e = 4): number {
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    return Math.hypot(hx, hz) / (2 * e);
  }
}
