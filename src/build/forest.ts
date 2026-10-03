/**
 * Countryside trees of one square tile, from the land-use field (worker side, no three.js).
 *
 * Tiles of 256 m hold the real trees: forests, river-bank rows, solitary trees in meadows and
 * hedgerows along some parcel borders. Bigger (far) tiles hold a constant number of canopy
 * clumps (`spread` > 1: each stands for a patch of forest), so a far tile costs the same as a
 * near one whatever its size.
 *
 * Record (FOREST_STRIDE floats): x, y, z, scale, yaw, kind (index into FOREST_KINDS), spread.
 */
import { Noise } from '../core/noise';
import { deriveSeed, hash2i, hash32, hashToFloat } from '../core/rng';
import { smoothstep } from '../core/math';
import { distPointPolyEdge, pointInPoly, polyBounds } from '../core/geom2';
import { hedgeOnCol, hedgeOnRow, newLandSample, parcelToWorld, type LandUse } from '../world/landuse';
import type { MacroPlan } from '../plan/types';
import { TERRAIN_DROP } from './terrainMesh';

export const FOREST_STRIDE = 7;
/** Tiles of this size and smaller hold real trees. */
export const FOREST_DETAIL = 256;

export interface ForestKind {
  /** Tree species name (see props/vegetation TreeSpecies) or 'shrub'. */
  species: string;
  variant: number;
  /** Approximate crown radius and height of the model at scale 1 (m), for the far clumps. */
  crown: number;
  height: number;
  conifer: boolean;
}

export const FOREST_KINDS: ForestKind[] = [
  { species: 'oak', variant: 0, crown: 7, height: 14.2, conifer: false },
  { species: 'oak', variant: 1, crown: 6.5, height: 14.7, conifer: false },
  { species: 'linden', variant: 0, crown: 4.8, height: 16.7, conifer: false },
  { species: 'linden', variant: 1, crown: 4.4, height: 14.4, conifer: false },
  { species: 'maple', variant: 0, crown: 5.7, height: 13.3, conifer: false },
  { species: 'maple', variant: 1, crown: 6.1, height: 14.6, conifer: false },
  { species: 'birch', variant: 0, crown: 3.4, height: 15.2, conifer: false },
  { species: 'birch', variant: 1, crown: 3.4, height: 16.3, conifer: false },
  { species: 'chestnut', variant: 0, crown: 5.9, height: 15.7, conifer: false },
  { species: 'pine', variant: 0, crown: 4.5, height: 15.2, conifer: true },
  { species: 'pine', variant: 1, crown: 3.2, height: 14.8, conifer: true },
  { species: 'cypress', variant: 0, crown: 1.6, height: 13.5, conifer: true },
  { species: 'shrub', variant: 0, crown: 1.6, height: 2.2, conifer: false },
  { species: 'shrub', variant: 1, crown: 1.6, height: 2.2, conifer: false },
  { species: 'plane', variant: 0, crown: 6.7, height: 15.2, conifer: false },
];

const DECIDUOUS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 1, 14];
const CONIFER = [9, 10, 9, 10, 6];
const WARM = [9, 10, 11, 0, 9];
const BANK = [6, 7, 2, 3, 0, 4];
const HEDGE = [0, 1, 4, 2, 12, 13, 12, 13, 12];
const SOLO = [0, 1, 2, 8, 4, 14, 0];

/**
 * Where the city's streets and blocks reach: trees and hedges keep off cells near the outline
 * and off arterial roads (with their sidewalks).
 */
class CityMask {
  private bucket = new Map<number, { poly: number[]; road: number }[]>();
  private static B = 256;
  constructor(macro: MacroPlan, land: LandUse) {
    const add = (poly: number[], road: number) => {
      const b = polyBounds(poly);
      const m = road + 4;
      for (let i = Math.floor((b[0] - m) / CityMask.B); i <= Math.floor((b[2] + m) / CityMask.B); i++) {
        for (let j = Math.floor((b[1] - m) / CityMask.B); j <= Math.floor((b[3] + m) / CityMask.B); j++) {
          const k = (i + 4096) * 8192 + (j + 4096);
          let l = this.bucket.get(k);
          if (!l) this.bucket.set(k, (l = []));
          l.push({ poly, road });
        }
      }
    };
    const nearEdge = (pts: number[]) => { for (let i = 0; i < pts.length; i += 2) if (land.edge(pts[i], pts[i + 1]) > -250) return true; return false; };
    for (const c of macro.cells) if (nearEdge(c.poly)) add(c.poly, 0);
    for (const e of macro.edges) if (nearEdge(e.pts)) add(e.pts, e.width / 2 + e.sidewalk + 3);
  }
  /** Is (x, z) on the city's ground (within `margin` of a cell, or on a road)? */
  has(x: number, z: number, margin: number): boolean {
    const l = this.bucket.get((Math.floor(x / CityMask.B) + 4096) * 8192 + (Math.floor(z / CityMask.B) + 4096));
    if (!l) return false;
    for (const it of l) {
      if (it.road > 0) {
        const p = it.poly;
        for (let i = 0; i + 3 < p.length; i += 2) {
          const ax = p[i], az = p[i + 1], dx = p[i + 2] - ax, dz = p[i + 3] - az, l2 = dx * dx + dz * dz;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
          if (Math.hypot(ax + dx * t - x, az + dz * t - z) < it.road) return true;
        }
      } else if (pointInPoly(it.poly, x, z) || distPointPolyEdge(it.poly, x, z) < margin) return true;
    }
    return false;
  }
}

export class ForestGen {
  private noise: Noise;
  private seed: number;
  private mask: CityMask;
  private ls = newLandSample();
  private warm: number;

  constructor(readonly land: LandUse, macro: MacroPlan) {
    const p = land.terrain.profile;
    this.seed = deriveSeed(p.seed, 'forest');
    this.noise = new Noise(this.seed);
    this.mask = new CityMask(macro, land);
    this.warm = p.warmth;
  }

  /** Tree records of the tile [x0, x0+size) × [z0, z0+size). */
  tile(x0: number, z0: number, size: number): Float32Array {
    const out: number[] = [];
    const detail = size <= FOREST_DETAIL;
    const n = detail ? Math.round(size / 7) : 40;
    const sp = size / n;
    const spread = detail ? 1 : sp / 7;
    const T = this.land.terrain, ls = this.ls, nz = this.noise;
    const gi0 = Math.round(x0 / sp), gj0 = Math.round(z0 / sp);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const h = hash2i(this.seed, gi0 + i, gj0 + j);
      const r0 = hashToFloat(h), r1 = hashToFloat(hash32(h + 701)), r2 = hashToFloat(hash32(h + 1305)), r3 = hashToFloat(hash32(h + 3109));
      const x = x0 + (i + r1) * sp, z = z0 + (j + r2) * sp;
      if (this.land.edge(x, z) < -40) continue;
      this.land.sample(x, z, ls, detail ? -1 : T.slope(x, z, sp * 0.5));
      if (ls.rural <= 0.05 || ls.water < 1.5) continue;
      if (T.profile.coastal && T.coastDistance(x, z) < 6) continue;
      // Acceptance: forest, the green bank strip along rivers, solitary trees in the meadows.
      const bankRow = ls.water < 22 ? 0.42 * (1 - smoothstep(14, 22, ls.water)) : 0;
      let p = ls.rural * ls.forest * 0.95 + ls.rural * bankRow * (1 - ls.forest);
      let pal = DECIDUOUS;
      if (detail) {
        const clump = smoothstep(0.5, 0.8, nz.fbm2(x / 260 + 7.7, z / 260, 2) * 0.5 + 0.5);
        const near = 1 - smoothstep(0, 500, ls.edge);
        p += ls.rural * ls.meadow * (0.006 + 0.05 * clump + 0.02 * near) * (1 - bankRow);
      }
      if (r0 >= p) continue;
      if (ls.edge < 260 && this.mask.has(x, z, 6)) continue;
      // Species: conifer stands by region (and up the hills), warm-climate mix, river-bank trees.
      if (ls.forest > 0.5) {
        const con = nz.fbm2(x / 1700 - 31, z / 1700 + 12, 3) * 0.5 + 0.5 + (this.warm < 0.3 ? 0.15 : 0);
        pal = this.warm > 0.75 ? WARM : con > 0.58 ? CONIFER : con > 0.52 && r3 < 0.5 ? CONIFER : DECIDUOUS;
      } else if (bankRow > 0) pal = BANK;
      else pal = this.warm > 0.75 ? WARM : SOLO;
      const solo = ls.forest < 0.5;
      // Undergrowth: some forest spots get a shrub instead of a tree.
      const under = detail && !solo && hashToFloat(hash32(h + 4111)) < 0.14;
      const kind = under ? 12 + (h & 1) : pal[Math.floor(r3 * pal.length) % pal.length];
      const scale = under ? 0.9 + r3 * 0.6 : (solo ? 0.95 : 0.66) + hashToFloat(hash32(h + 1703)) * (solo ? 0.35 : 0.5);
      const y = T.height(x, z) - TERRAIN_DROP - 0.15;
      out.push(x, y, z, scale, hashToFloat(hash32(h + 2307)) * Math.PI * 2, kind, spread);
    }
    if (detail) this.hedges(x0, z0, size, out);
    return Float32Array.from(out);
  }

  /** Hedgerows (trees and shrubs) along some parcel borders between fields. */
  private hedges(x0: number, z0: number, size: number, out: number[]): void {
    const P = this.land.parcels, T = this.land.terrain, ls = this.ls;
    // Tile corners in parcel coordinates (ignoring the warp, plus a margin for it).
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of [[x0, z0], [x0 + size, z0], [x0, z0 + size], [x0 + size, z0 + size]]) {
      const u = x * P.cos + z * P.sin, v = -x * P.sin + z * P.cos;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const m = P.warp + 10;
    u0 -= m; u1 += m; v0 -= m; v1 += m;
    const STEP = 7;
    const place = (u: number, v: number, salt: number) => {
      // Parcel space → world: undo the rotation, then the warp (fixed point).
      const [px, pz] = parcelToWorld(P, u, v);
      let x = px, z = pz;
      for (let k = 0; k < 3; k++) { x = px - P.warp * Math.sin(z / 730 + P.ph1); z = pz - P.warp * Math.sin(x / 910 + P.ph2); }
      if (x < x0 || x >= x0 + size || z < z0 || z >= z0 + size) return;
      const h = hash2i(this.seed ^ 0x6e1, Math.round(u * 3), Math.round(v * 3) + salt);
      const r = hashToFloat(h);
      if (r > 0.82) return; // gaps
      this.land.sample(x, z, ls);
      if (ls.rural < 0.9 || ls.field < 0.5 || ls.water < 4) return;
      if (ls.edge < 260 && this.mask.has(x, z, 6)) return;
      const kind = HEDGE[Math.floor(hashToFloat(hash32(h + 501)) * HEDGE.length) % HEDGE.length];
      const shrub = FOREST_KINDS[kind].species === 'shrub';
      const jx = (hashToFloat(hash32(h + 1102)) - 0.5) * 1.6, jz = (hashToFloat(hash32(h + 1304)) - 0.5) * 1.6;
      const y = T.height(x + jx, z + jz) - TERRAIN_DROP - 0.1;
      out.push(x + jx, y, z + jz, (shrub ? 1.1 : 0.8) + hashToFloat(hash32(h + 703)) * 0.4, hashToFloat(hash32(h + 309)) * Math.PI * 2, kind, 1);
    };
    for (let j = Math.floor(v0 / P.sv); j <= Math.ceil(v1 / P.sv); j++) {
      const v = j * P.sv;
      // Row border (between rows j-1 and j), split by the cells of row j.
      const off = hashToFloat(hash2i(P.seed, 7, j)) * P.su;
      for (let u = Math.floor(u0 / STEP) * STEP; u <= u1; u += STEP) {
        if (hedgeOnRow(P, Math.floor((u + off) / P.su), j)) place(u, v, 0);
      }
      // Cell borders across row j.
      for (let i = Math.floor((u0 + off) / P.su); i <= Math.ceil((u1 + off) / P.su); i++) {
        if (!hedgeOnCol(P, i, j)) continue;
        const u = i * P.su - off;
        for (let vv = v + STEP * 0.5; vv < v + P.sv; vv += STEP) if (vv >= v0 && vv <= v1) place(u, vv, 1);
      }
    }
  }
}
