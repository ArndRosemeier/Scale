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
import { chaikin, resample, polylineLength, reversePoly } from '../core/geom2';
import { smoothstep, clamp, lerp } from '../core/math';
import type { WorldProfile } from './settings';
import { makeBoundary, terrainExtent } from './boundary';
import { pickAirfield, airfieldEdge, AIRFIELD_BLEND, type Airfield } from './airfield';

/**
 * A countryside lake: a lobed, stretched blob with a level surface, carved into the terrain
 * (a gently shelving bowl inside, a shore band blending out into the land around it).
 */
export interface Lake {
  x: number;
  z: number;
  /** Mean radius (m) along the long axis. */
  r: number;
  /** Long axis angle and aspect (long / short, ≥ 1). */
  angle: number;
  aspect: number;
  /** Shore lobes: amplitude, phase per harmonic 2, 3, 5, 8. */
  lobes: number[];
  /** Water level (absolute y). */
  level: number;
  /** Depth at the middle below the level (m). */
  depth: number;
  /** Width of the shore band where the land blends down to the water (m). */
  shore: number;
  /** Bounding radius of the lake and its shore band. */
  reach: number;
}

export interface LakeQuery {
  /** Lake index (-1 none). */
  lake: number;
  /** Signed distance to the shoreline (m, negative on the water). */
  e: number;
  level: number;
}

const LAKE_CELL = 1024;
const LAKE_HARM = [2, 3, 5, 8];

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
  /**
   * Width wobble key: river index and arc-length offset. A countryside continuation uses its
   * parent's key so the width runs on seamlessly across the junction.
   */
  wobR: number;
  wobS: number;
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
/** Countryside rivers are indexed only this far beyond their banks (keeps the hash small). */
const COUNTRY_RANGE = 320;
/** Width of the band beyond the protected city zone where the countryside valley raster takes over. */
const BLEND_BAND = 900;

export class Terrain {
  readonly profile: WorldProfile;
  readonly noise: Noise;
  readonly noise2: Noise;
  readonly rivers: River[] = [];
  /** Sea level is always 0. */
  readonly seaLevel = 0;
  /** Extent of the precomputed rasters (half size). */
  readonly extent: number;
  /**
   * Rivers generated for the city (the first `baseRivers` entries). The rest continue them
   * through the countryside to the edge of the world and add a few streams; those never come
   * near the city, and inside the protected zone around it the terrain is computed from the
   * city rivers alone, exactly as without them.
   */
  readonly baseRivers: number;
  /** Half size of the streamed world (terrain tiles, countryside rivers, sea). */
  readonly worldExtent: number;
  /** Radius of the protected zone (city boundary plus a margin). */
  readonly protectR: number;
  private protectSq: number;

  private segHash = new Map<number, ArrayLike<number>>(); // key -> [river, idx, ...]
  private raster!: Float32Array; // per cell: d, level, halfWidth
  private rasterN = 0;
  /** Coarse raster over the whole world with every river (countryside valleys). */
  private outer!: Float32Array;
  private outerN = 0;
  private outerCell = 0;
  /** Hash cells holding countryside river segments (there the nearest bank wins, see waterMixed). */
  private mixed = new Set<number>();
  /**
   * The airfield of a big city (world/airfield): levelled by `height`, outside the protected
   * zone. Null for smaller cities (and while it is being picked from the natural terrain).
   */
  airfield: Airfield | null = null;
  private afReach = 0;
  /** Countryside lakes (beyond the protected zone and its blend band). */
  readonly lakes: Lake[] = [];
  private lakeHash = new Map<number, number[]>();

  constructor(profile: WorldProfile, countryRivers = true) {
    this.profile = profile;
    this.noise = new Noise(deriveSeed(profile.seed, 'terrain'));
    this.noise2 = new Noise(deriveSeed(profile.seed, 'terrain2'));
    this.extent = profile.radius * 1.6 + 2000;
    const boundary = makeBoundary(profile);
    this.protectR = Math.max(...boundary) + 500;
    this.protectSq = this.protectR * this.protectR;
    this.worldExtent = terrainExtent(boundary) + 1500;
    this.makeRivers();
    this.baseRivers = this.rivers.length;
    if (countryRivers) this.extendRivers();
    this.buildIndex();
    const af = pickAirfield(this);
    if (af) { this.afReach = Math.hypot(af.hu, af.hv) + AIRFIELD_BLEND; this.airfield = af; }
    if (countryRivers) this.pickLakes();
  }

  // ------------------------------------------------------------------ lakes

  /**
   * Lakes out in the country: on a jittered grid, where the land is open and fairly level, away
   * from the city (beyond the blend band, so its terrain stays bit for bit the same), the rivers,
   * the coast, the airfield and each other. The level sits just below the lowest point of the rim.
   */
  private pickLakes(): void {
    const p = this.profile;
    const rng = new Rng(deriveSeed(p.seed, 'lakes'));
    const G = 3400, W = this.worldExtent;
    const n = Math.floor(W / G);
    const rim: number[] = [];
    for (let j = -n; j < n; j++) for (let i = -n; i < n; i++) {
      const r = rng.fork(i, j);
      if (!r.chance(0.5)) continue;
      const x = (i + r.range(0.15, 0.85)) * G, z = (j + r.range(0.15, 0.85)) * G;
      const big = r.chance(0.15);
      const rad = big ? r.range(420, 780) : 90 + 330 * r.float() * r.float();
      // Never round: stretched, with bays and points (no lobe set left near zero).
      const aspect = r.range(1.25, big ? 2.3 : 1.9), angle = r.range(0, Math.PI);
      const lobes = LAKE_HARM.flatMap((_, k) => [r.range(0.07, 0.17) / (k + 1), r.range(0, Math.PI * 2)]);
      const reach = rad * 1.45 + 60 + rad * 0.3;
      if (Math.hypot(x, z) < this.protectR + BLEND_BAND + reach + 300) continue;
      if (Math.max(Math.abs(x), Math.abs(z)) > W - reach - 1500) continue;
      if (p.coastal && this.coastDistance(x, z) < reach + 500) continue;
      this.sampleRaster(x, z, this.rtmp);
      if (this.rtmp[0] - this.rtmp[2] < reach + 220) continue;
      const af = this.airfield;
      if (af && airfieldEdge(af, x, z) < reach + 300) continue;
      if (this.lakes.some((L) => Math.hypot(L.x - x, L.z - z) < L.reach + reach + 300)) continue;
      // Rim: fairly level all round, no hill in the middle.
      rim.length = 0;
      const c = Math.cos(angle), s = Math.sin(angle);
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const rr = this.lakeRadius({ r: rad, lobes } as Lake, a) * 1.12;
        const u = Math.cos(a) * rr, v = (Math.sin(a) * rr) / aspect;
        rim.push(this.height(x + u * c - v * s, z + u * s + v * c));
      }
      const lo = Math.min(...rim), hi = Math.max(...rim);
      if (hi - lo > 5 + rad * 0.025) continue;
      const level = lo - 0.9;
      if (this.height(x, z) > level + 14) continue;
      const lake: Lake = { x, z, r: rad, angle, aspect, lobes, level, depth: 2.5 + rad * 0.014, shore: 45 + rad * 0.3, reach };
      const k = this.lakes.length;
      this.lakes.push(lake);
      for (let cx = Math.floor((x - reach) / LAKE_CELL); cx <= Math.floor((x + reach) / LAKE_CELL); cx++) {
        for (let cz = Math.floor((z - reach) / LAKE_CELL); cz <= Math.floor((z + reach) / LAKE_CELL); cz++) {
          const key = (cx + 32768) * 65536 + (cz + 32768);
          let b = this.lakeHash.get(key);
          if (!b) this.lakeHash.set(key, (b = []));
          b.push(k);
        }
      }
    }
  }

  /** Shoreline radius of a lake in its stretched frame at angle a. */
  private lakeRadius(L: Lake, a: number): number {
    let f = 1;
    for (let k = 0; k < LAKE_HARM.length; k++) f += L.lobes[k * 2] * Math.cos(LAKE_HARM[k] * a + L.lobes[k * 2 + 1]);
    return L.r * f;
  }

  private lq: LakeQuery = { lake: -1, e: Infinity, level: 0 };

  /** Nearest lake shore at (x, z) (within a lake's reach; lake -1 and e Infinity elsewhere). */
  lakeAt(x: number, z: number, out: LakeQuery = this.lq): LakeQuery {
    out.lake = -1;
    out.e = Infinity;
    if (!this.lakes.length) return out;
    const b = this.lakeHash.get((Math.floor(x / LAKE_CELL) + 32768) * 65536 + (Math.floor(z / LAKE_CELL) + 32768));
    if (!b) return out;
    for (const k of b) {
      const L = this.lakes[k];
      const dx = x - L.x, dz = z - L.z;
      if (dx * dx + dz * dz > L.reach * L.reach) continue;
      const c = Math.cos(L.angle), s = Math.sin(L.angle);
      const u = dx * c + dz * s, v = (-dx * s + dz * c) * L.aspect;
      const d = Math.hypot(u, v);
      const rr = this.lakeRadius(L, Math.atan2(v, u));
      // Distances in the stretched frame shrink by up to the aspect across the long axis.
      const e = (d - rr) / (1 + (L.aspect - 1) * (Math.abs(v) / (d || 1)));
      if (e < out.e) { out.e = e; out.lake = k; out.level = L.level; }
    }
    return out;
  }

  /** A lake's water outline (closed polygon, `margin` m beyond the shoreline). */
  lakePolygon(k: number, margin = 3, n = 128): number[] {
    const L = this.lakes[k];
    const c = Math.cos(L.angle), s = Math.sin(L.angle);
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = this.lakeRadius(L, a);
      const u = Math.cos(a) * (rr + margin), v = (Math.sin(a) * (rr + margin * L.aspect)) / L.aspect;
      out.push(L.x + u * c - v * s, L.z + u * s + v * c);
    }
    return out;
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
    const len0 = polylineLength(main);
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

  private makeRiver(pts: number[], level0: number, level1: number, width0: number, width1: number, joins: number, wobR = this.rivers.length, wobS = 0): River {
    const n = pts.length >> 1;
    const s = new Float64Array(n);
    for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
    return { pts: Float64Array.from(pts), s, length: s[n - 1], level0, level1, width0, width1, joins, wobR, wobS };
  }

  // ------------------------------------------------------- countryside rivers

  /**
   * Continue the city's rivers beyond its terrain to the edge of the world (meandering on with
   * the same gradient and width) and add a few streams joining them out in the country.
   */
  private extendRivers(): void {
    const p = this.profile;
    const rng = new Rng(deriveSeed(p.seed, 'rivers', 'country'));
    const reach = this.worldExtent + 1500;
    for (let r = 0; r < this.baseRivers; r++) {
      const R = this.rivers[r];
      const g = Math.max(0.0005, (R.level0 - R.level1) / Math.max(1, R.length));
      // Upstream: from the edge of the world down to the river's source end.
      const up = this.continuation(rng.fork('up', r), R, true, reach);
      if (up) {
        const L = polylineLength(up);
        this.rivers.push(this.makeRiver(reversePoly(up), R.level0 + g * L, R.level0, R.width0 * 0.55, R.width0, r, R.wobR, R.wobS - L));
      }
      // Downstream (a river ending in the sea or in another river stops there).
      if (r === 0 && !p.coastal) {
        const dn = this.continuation(rng.fork('down', r), R, false, reach);
        if (dn) {
          const L = polylineLength(dn);
          this.rivers.push(this.makeRiver(dn, R.level1, Math.max(1, R.level1 - g * L), R.width1, R.width1 * 1.2, -1, R.wobR, R.wobS + R.length));
        }
      }
    }
    // Streams: smaller rivers from the hills down to a confluence, out in the country.
    const want = Math.max(2, Math.round((this.worldExtent / 9000) * 2.5));
    const keepOut = this.protectR + BLEND_BAND + 1500;
    const hosts = this.rivers.length;
    const mouths: number[] = [];
    for (let k = 0, tries = 0; k < want && tries < 80; tries++) {
      const sr = rng.fork('stream', tries);
      const hi = sr.int(0, hosts - 1);
      const H = this.rivers[hi];
      const n = H.pts.length >> 1;
      if (n < 8) continue;
      const i = sr.int(2, n - 3);
      const cx = H.pts[i * 2], cz = H.pts[i * 2 + 1];
      if (Math.hypot(cx, cz) < keepOut + 1000 || Math.max(Math.abs(cx), Math.abs(cz)) > this.worldExtent * 0.85) continue;
      if (p.coastal && this.coastDistance(cx, cz) < 400) continue;
      // Spread them out: one confluence per few kilometres.
      let crowded = false;
      for (let q = 0; q < mouths.length; q += 2) if (Math.hypot(mouths[q] - cx, mouths[q + 1] - cz) < Math.min(3500, this.worldExtent * 0.25)) crowded = true;
      if (crowded) continue;
      let tx = H.pts[i * 2 + 2] - H.pts[i * 2 - 2], tz = H.pts[i * 2 + 3] - H.pts[i * 2 - 1];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      // Leave from the bank facing away from the city.
      let nx = -tz, nz = tx;
      if (nx * cx + nz * cz < 0) { nx = -nx; nz = -nz; }
      const a = sr.range(-0.6, 0.6);
      const dx = nx * Math.cos(a) - nz * Math.sin(a), dz = nx * Math.sin(a) + nz * Math.cos(a);
      const hw = this.riverHalfWidthAt(hi, H.s[i]);
      const sx = cx + nx * (hw + 1), sz = cz + nz * (hw + 1);
      const L = sr.range(3000, 8000);
      let pts = this.wander(sr, [sx, sz], [sx + dx * L, sz + dz * L], 230, sr.range(50, 120), 0);
      // Cut where it would approach the city, the sea, the world's edge or another river.
      for (let q = 0; q < pts.length; q += 2) {
        const x = pts[q], z = pts[q + 1];
        if (Math.hypot(x, z) < keepOut || Math.max(Math.abs(x), Math.abs(z)) > reach || (p.coastal && this.coastDistance(x, z) < 250)
          || this.nearRiver(x, z, q < 100 ? hi : -1, 500)) { pts = pts.slice(0, q); break; }
      }
      if (pts.length < 8 || polylineLength(pts) < 1500) continue;
      const rev = reversePoly(pts);
      const lvl = this.riverLevelAt(hi, H.s[i]) + 0.2;
      const w1 = sr.range(9, 16);
      this.rivers.push(this.makeRiver(rev, lvl + polylineLength(rev) * 0.0018, lvl, w1 * 0.45, w1, hi));
      mouths.push(cx, cz);
      k++;
    }
  }

  /** Is (x,z) within d of any river other than `except`? (Coarse: every 4th point.) */
  private nearRiver(x: number, z: number, except: number, d: number): boolean {
    const d2 = d * d;
    for (let r = 0; r < this.rivers.length; r++) {
      if (r === except) continue;
      const P = this.rivers[r].pts;
      for (let k = 0; k < P.length; k += 8) if ((P[k] - x) ** 2 + (P[k + 1] - z) ** 2 < d2) return true;
    }
    return false;
  }

  /** Meandering continuation of a river from one of its ends, outward to `reach`. */
  private continuation(rng: Rng, R: River, atStart: boolean, reach: number): number[] | null {
    const n = R.pts.length >> 1;
    if (n < 4) return null;
    const ei = atStart ? 0 : n - 1, bi = atStart ? Math.min(n - 1, 20) : Math.max(0, n - 21);
    const ex = R.pts[ei * 2], ez = R.pts[ei * 2 + 1];
    if (this.profile.coastal && this.coastDistance(ex, ez) < 300) return null;
    let dx = ex - R.pts[bi * 2], dz = ez - R.pts[bi * 2 + 1];
    let l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    const lead: [number, number] = [dx, dz];
    // Lean outward so it never turns back towards the city.
    const el = Math.hypot(ex, ez) || 1;
    dx += (ex / el) * 0.5; dz += (ez / el) * 0.5;
    l = Math.hypot(dx, dz);
    dx /= l; dz /= l;
    let L = 0;
    while (Math.max(Math.abs(ex + dx * L), Math.abs(ez + dz * L)) < reach && L < reach * 3) L += 200;
    if (L < 400) return null;
    const a = rng.range(-0.3, 0.3);
    const tx = dx * Math.cos(a) - dz * Math.sin(a), tz = dx * Math.sin(a) + dz * Math.cos(a);
    const step = Math.max(350, this.profile.riverWidth * 4.5);
    let pts = this.wander(rng, [ex, ez], [ex + tx * L, ez + tz * L], step, 90 + this.profile.riverWidth * 2.2 + rng.range(0, 200), step, lead);
    for (let q = 2; q < pts.length; q += 2) {
      const x = pts[q], z = pts[q + 1];
      if ((this.profile.coastal && this.coastDistance(x, z) < 250) || Math.hypot(x, z) < this.protectR + BLEND_BAND + 300) { pts = pts.slice(0, q); break; }
    }
    return pts.length >= 8 ? pts : null;
  }

  /**
   * Meandering polyline from a to b (resampled to 12 m). With `lead`, the first control point
   * continues along it (no kink at a junction); the meander amplitude ramps up from a.
   */
  private wander(rng: Rng, a: [number, number], b: [number, number], step: number, amp: number, leadLen: number, lead?: [number, number]): number[] {
    const ctrl: number[] = [a[0], a[1]];
    let sx = a[0], sz = a[1];
    if (lead && leadLen > 0) { sx += lead[0] * leadLen; sz += lead[1] * leadLen; ctrl.push(sx, sz); }
    const n = Math.max(2, Math.round(Math.hypot(b[0] - sx, b[1] - sz) / step));
    for (let i = 1; i <= n; i++) ctrl.push(sx + ((b[0] - sx) * i) / n, sz + ((b[1] - sz) * i) / n);
    const ph = rng.range(0, 100);
    const m = ctrl.length >> 1, fixed = lead ? 2 : 1;
    const out: number[] = [];
    for (let i = 0; i < m; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(m - 1, i + 1);
      let dx = ctrl[i1 * 2] - ctrl[i0 * 2], dz = ctrl[i1 * 2 + 1] - ctrl[i0 * 2 + 1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      const w = i < fixed ? 0 : Math.min(1, (i - fixed + 1) / 2);
      const off = this.noise2.fbm2(i * 0.3 + ph, ph * 0.5 + 41, 2) * amp * 2.2 * w;
      out.push(ctrl[i * 2] - dz * off, ctrl[i * 2 + 1] + dx * off);
    }
    const pts = resample(chaikin(out, 4), 12);
    pts[0] = a[0]; pts[1] = a[1];
    return pts;
  }

  riverLevelAt(r: number, s: number): number {
    const R = this.rivers[r];
    return lerp(R.level0, R.level1, clamp(s / R.length, 0, 1));
  }
  riverHalfWidthAt(r: number, s: number): number {
    const R = this.rivers[r];
    const t = clamp(s / R.length, 0, 1);
    // Gentle width variation along the course.
    const wob = 1 + 0.12 * this.noise2.n2((s + R.wobS) * 0.0025 + R.wobR * 31, 7.3);
    return 0.5 * lerp(R.width0, R.width1, t) * wob;
  }

  private buildIndex(): void {
    for (let r = 0; r < this.rivers.length; r++) {
      const R = this.rivers[r];
      const pts = R.pts;
      const country = r >= this.baseRivers;
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const range = country ? this.riverHalfWidthAt(r, R.s[i >> 1]) + COUNTRY_RANGE : NEAR_RANGE;
        const x0 = Math.min(pts[i], pts[i + 2]) - range, x1 = Math.max(pts[i], pts[i + 2]) + range;
        const z0 = Math.min(pts[i + 1], pts[i + 3]) - range, z1 = Math.max(pts[i + 1], pts[i + 3]) + range;
        for (let cx = Math.floor(x0 / HASH_CELL); cx <= Math.floor(x1 / HASH_CELL); cx++) {
          for (let cz = Math.floor(z0 / HASH_CELL); cz <= Math.floor(z1 / HASH_CELL); cz++) {
            const key = (cx + 32768) * 65536 + (cz + 32768);
            let b = this.segHash.get(key) as number[] | undefined;
            if (!b) this.segHash.set(key, (b = []));
            b.push(r, i >> 1);
            if (country) this.mixed.add(key);
          }
        }
      }
    }
    // Compact buckets (every worker holds a copy).
    for (const [k, b] of this.segHash) this.segHash.set(k, Int32Array.from(b as number[]));
    // Coarse raster of (distance, level, halfWidth) for valley shaping far from the water.
    const N = Math.ceil((this.extent * 2) / RASTER_CELL) + 1;
    this.rasterN = N;
    this.raster = new Float32Array(N * N * 3);
    const step = 4; // check every 4th point: plenty at 160 m cells
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = -this.extent + i * RASTER_CELL, z = -this.extent + j * RASTER_CELL;
        let best = Infinity, bl = 0, bw = 0;
        for (let r = 0; r < this.baseRivers; r++) {
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
    this.buildOuterRaster();
  }

  /**
   * (distance, level, halfWidth) of the nearest river over the whole world, coarse, by jump
   * flooding from points along every river (exact enough at this cell size, and fast).
   */
  private buildOuterRaster(): void {
    const W = this.worldExtent;
    const C = Math.max(160, (W * 2) / 220);
    const N = Math.ceil((W * 2) / C) + 1;
    this.outerCell = C;
    this.outerN = N;
    const sx: number[] = [], sz: number[] = [], sl: number[] = [], sw: number[] = [];
    const near = new Int32Array(N * N).fill(-1);
    const dist2 = (q: number, i: number, j: number) => { const dx = sx[q] - (-W + i * C), dz = sz[q] - (-W + j * C); return dx * dx + dz * dz; };
    const every = Math.max(1, Math.floor(C / 40));
    for (let r = 0; r < this.rivers.length; r++) {
      const R = this.rivers[r];
      const n = R.pts.length >> 1;
      for (let k = 0; k < n; k += every) {
        const x = R.pts[k * 2], z = R.pts[k * 2 + 1];
        const i = Math.round((x + W) / C), j = Math.round((z + W) / C);
        if (i < 0 || j < 0 || i >= N || j >= N) continue;
        const q = sx.length;
        sx.push(x); sz.push(z); sl.push(this.riverLevelAt(r, R.s[k])); sw.push(this.riverHalfWidthAt(r, R.s[k]));
        const o = j * N + i;
        if (near[o] < 0 || dist2(q, i, j) < dist2(near[o], i, j)) near[o] = q;
      }
    }
    if (sx.length) {
      let step = 1;
      while (step * 2 < N) step *= 2;
      // Jump flooding, then one extra pass at step 1 (JFA+1) to fix the rare misses.
      const steps: number[] = [];
      for (let s = step; s >= 1; s >>= 1) steps.push(s);
      steps.push(1);
      for (const st of steps) {
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
          const o = j * N + i;
          let b = near[o], bd = b >= 0 ? dist2(b, i, j) : Infinity;
          for (let dj = -st; dj <= st; dj += st) for (let di = -st; di <= st; di += st) {
            const ii = i + di, jj = j + dj;
            if ((di === 0 && dj === 0) || ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
            const q = near[jj * N + ii];
            if (q < 0 || q === b) continue;
            const d = dist2(q, i, j);
            if (d < bd) { bd = d; b = q; }
          }
          near[o] = b;
        }
      }
    }
    this.outer = new Float32Array(N * N * 3);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const o = j * N + i, q = near[o];
      this.outer[o * 3] = q >= 0 ? Math.sqrt(dist2(q, i, j)) : 1e5;
      this.outer[o * 3 + 1] = q >= 0 ? sl[q] : this.profile.baseElevation;
      this.outer[o * 3 + 2] = q >= 0 ? sw[q] : 0;
    }
  }

  private btmp: [number, number, number] = [0, 0, 0];

  private sampleRaster(x: number, z: number, out: [number, number, number]): void {
    const r2 = x * x + z * z;
    if (r2 < this.protectSq) { this.sampleGrid(this.raster, this.rasterN, this.extent, RASTER_CELL, x, z, out); return; }
    // Countryside: the raster with every river, blended in beyond the protected zone.
    this.sampleGrid(this.outer, this.outerN, this.worldExtent, this.outerCell, x, z, out);
    const t = smoothstep(this.protectR, this.protectR + BLEND_BAND, Math.sqrt(r2));
    if (t >= 1) return;
    const a = this.btmp;
    this.sampleGrid(this.raster, this.rasterN, this.extent, RASTER_CELL, x, z, a);
    for (let c = 0; c < 3; c++) out[c] = lerp(a[c], out[c], t);
  }

  private sampleGrid(r: Float32Array, N: number, ext: number, cell: number, x: number, z: number, out: [number, number, number]): void {
    const fx = clamp((x + ext) / cell, 0, N - 1.001);
    const fz = clamp((z + ext) / cell, 0, N - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
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
    if (this.mixed.has(key)) return this.waterMixed(x, z, b, out);
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

  /**
   * Nearest river where countryside rivers are indexed: the river whose bank is nearest wins,
   * so a narrow stream never claims the water of the wide river it flows into.
   */
  private waterMixed(x: number, z: number, b: ArrayLike<number>, out: WaterQuery): WaterQuery {
    let bestM = Infinity;
    for (let k = 0; k < b.length; k += 2) {
      const r = b[k], i = b[k + 1];
      const R = this.rivers[r];
      const pts = R.pts;
      const ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[i * 2 + 2], bz = pts[i * 2 + 3];
      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
      const s = R.s[i] + Math.sqrt(l2) * t;
      // Cheap bound first: the width wobbles at most ±12% around its linear course.
      if (d - 0.5 * lerp(R.width0, R.width1, clamp(s / R.length, 0, 1)) * 1.13 > bestM) continue;
      const hw = this.riverHalfWidthAt(r, s);
      if (d - hw < bestM) {
        bestM = d - hw;
        out.river = r; out.s = s; out.d = d; out.halfWidth = hw;
      }
    }
    if (out.river >= 0) out.level = this.riverLevelAt(out.river, out.s);
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
    // Lakes: a shelving bowl below the level, the shore band easing the land down to it.
    if (this.lakes.length) {
      const q = this.lakeAt(x, z);
      if (q.lake >= 0) {
        const L = this.lakes[q.lake];
        if (q.e < L.shore) {
          // (The terrain mesh is drawn TERRAIN_DROP lower: the drawn shore meets the water a few metres in.)
          const top = L.level + 0.5;
          // Inside, the bed drops off from the shoreline at once (no flat lip the water would
          // cross in jagged steps on the coarse far terrain), then levels out.
          const t = Math.min(1, -q.e / clamp(L.r * 0.3, 12, 90));
          h = q.e >= 0 ? lerp(top, h, smoothstep(0, L.shore, q.e)) : top - (0.5 + L.depth) * t * (2 - t);
        }
      }
    }
    // The airfield: level, with an embankment band blending into the natural ground.
    const af = this.airfield;
    if (af && Math.abs(x - af.x) < this.afReach && Math.abs(z - af.z) < this.afReach) {
      const dx = x - af.x, dz = z - af.z, c = Math.cos(af.angle), s = Math.sin(af.angle);
      const e = Math.max(Math.abs(dx * c + dz * s) - af.hu, Math.abs(-dx * s + dz * c) - af.hv);
      if (e < AIRFIELD_BLEND) h = lerp(af.level, h, smoothstep(0, AIRFIELD_BLEND, e));
    }

    return h;
  }

  /** Water surface height at (x,z) or -Infinity when dry. */
  waterLevel(x: number, z: number): number {
    const p = this.profile;
    if (p.coastal && this.coastDistance(x, z) < 0) return 0;
    const w = this.water(x, z);
    if (w.river >= 0 && w.d < w.halfWidth + 0.5) return w.level;
    const q = this.lakeAt(x, z);
    if (q.lake >= 0 && q.e < 3 && this.height(x, z) < q.level) return q.level;
    return -Infinity;
  }

  /** True when (x,z) is in the river or the sea (with optional margin in m). */
  isWater(x: number, z: number, margin = 0): boolean {
    const p = this.profile;
    if (p.coastal && this.coastDistance(x, z) < margin) return true;
    const w = this.water(x, z);
    if (w.river >= 0 && w.d < w.halfWidth + margin) return true;
    return this.lakeAt(x, z).e < margin;
  }

  /** Gradient magnitude (slope) by central differences. */
  slope(x: number, z: number, e = 4): number {
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    return Math.hypot(hx, hz) / (2 * e);
  }
}

