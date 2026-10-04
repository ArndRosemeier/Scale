/**
 * Landmarks: the special buildings that make a city recognisable, planned once for the whole
 * city from the seed (pure data, part of the macro plan).
 *
 *  * Town hall: at the historic core, a civic square in front (clock tower, dome or belfry).
 *  * Stadium: at the edge of the centre (oval or rectangular, open, canopied or closed, 1–3 tiers).
 *  * Attractions: 1–4 by city size, picked from a weighted pool that depends on the place
 *    (lighthouse only on a coast, fortress only where there is a hill, cathedral more likely in
 *    old-world cities, …) and parameterised so no two cities share the same one.
 *  * Airport: big cities only, out on the levelled airfield (world/airfield) with a road into town.
 *
 * Every in-city landmark reserves an oriented rectangle (its site) inside one cell, clear of the
 * arterials and their sidewalks (so of the sewer manholes too). The cell planner keeps local streets,
 * lots and street furniture out of it and lays its ground (square, lawn, car park) and its own
 * props (plan/cell.ts). The structure itself is described by plan/landmarkParts.ts and meshed by
 * build/landmarks.ts; collision uses the same parts (world/LandmarkSolids.ts).
 */
import { Rng, deriveSeed } from '../core/rng';
import { clamp } from '../core/math';
import { type Poly, polyBounds, pointInPoly, polyCentroid, minAreaRect, segIntersect, distPointPolyEdge, ensureCCW } from '../core/geom2';
import { offset } from '../core/clip';
import type { Terrain } from '../world/terrain';
import type { CellInfo, MacroPlan } from './types';
import type { CityField } from './macro';
import { ROOTS, cityName } from './names';
import { CURB_H } from '../build/ground';

export type AttractionKind = 'tower' | 'cathedral' | 'wheel' | 'monument' | 'museum' | 'lighthouse' | 'fortress' | 'glasshouse';
export type LandmarkKind = 'townhall' | 'stadium' | 'airport' | AttractionKind;

export const ATTRACTION_KINDS: AttractionKind[] = ['tower', 'cathedral', 'wheel', 'monument', 'museum', 'lighthouse', 'fortress', 'glasshouse'];

/** What a landmark is, in words (map tooltips). */
export const LANDMARK_KIND_NAME: Record<LandmarkKind, string> = {
  townhall: 'town hall', stadium: 'stadium', airport: 'airport', tower: 'observation tower', cathedral: 'cathedral', wheel: 'big wheel',
  monument: 'monument', museum: 'museum', lighthouse: 'lighthouse', fortress: 'fortress', glasshouse: 'botanical garden',
};

export interface Landmark {
  id: number;
  kind: LandmarkKind;
  name: string;
  /** Host cell (-1: outside the city — the airport). */
  cell: number;
  /**
   * Site: an oriented rectangle around (x, z), local axes u = (cos angle, sin angle) and
   * v = (-sin, cos), half sizes hu along u and hv along v. The front (entrance, square) faces -v.
   */
  x: number;
  z: number;
  angle: number;
  hu: number;
  hv: number;
  /** Site outline (CCW). */
  site: Poly;
  /** Floor level of the structure (highest ground under the site plus the curb) and the lowest ground. */
  base: number;
  low: number;
  /** Variation seed of the details (plan/landmarkParts). */
  seed: number;
  /** Kind-specific variant and parameters (see plan/landmarkParts for their meaning). */
  style: number;
  p: Record<string, number>;
  /** Access road (x, z, …) from the city's arterials (the airport). */
  road?: number[];
}

/** Ground of a site part: square paving, lawn, or asphalt (car parks, aprons). */
export type ZoneKind = 'plaza' | 'park' | 'paved';
export interface SiteZone { kind: ZoneKind; poly: Poly }

/** Margin kept between a site and local streets (half a street plus its sidewalk, and a bit). */
export const SITE_STREET_CLEAR = 9.5;

/** World point of local site coordinates. */
export function siteToWorld(lm: Pick<Landmark, 'x' | 'z' | 'angle'>, u: number, v: number): [number, number] {
  const c = Math.cos(lm.angle), s = Math.sin(lm.angle);
  return [lm.x + u * c - v * s, lm.z + u * s + v * c];
}

/** Local site coordinates of a world point. */
export function worldToSite(lm: Pick<Landmark, 'x' | 'z' | 'angle'>, x: number, z: number): [number, number] {
  const c = Math.cos(lm.angle), s = Math.sin(lm.angle), dx = x - lm.x, dz = z - lm.z;
  return [dx * c + dz * s, -dx * s + dz * c];
}

/** Oriented rectangle (CCW) in local coordinates [u0, v0] – [u1, v1] of a site frame. */
export function siteRect(lm: Pick<Landmark, 'x' | 'z' | 'angle'>, u0: number, v0: number, u1: number, v1: number): Poly {
  return [...siteToWorld(lm, u0, v0), ...siteToWorld(lm, u1, v0), ...siteToWorld(lm, u1, v1), ...siteToWorld(lm, u0, v1)];
}

export function inSite(lm: Landmark, x: number, z: number, m = 0): boolean {
  const [u, v] = worldToSite(lm, x, z);
  return Math.abs(u) < lm.hu + m && Math.abs(v) < lm.hv + m;
}

export function landmarksOfCell(macro: MacroPlan, cell: number): Landmark[] {
  return (macro.landmarks ?? []).filter((l) => l.cell === cell);
}

/** How many attractions a city of this radius gets (1–4). */
export function attractionCount(radius: number, r: Rng): number {
  if (radius < 1300) return 1;
  if (radius < 1800) return r.int(1, 2);
  if (radius < 3200) return r.int(2, 3);
  if (radius < 6000) return r.int(3, 4);
  return 4;
}

// ------------------------------------------------------------------ site fitting

interface FitOpts {
  /** Largest height difference allowed under the site (m). */
  maxRange: number;
  /** Preferred point (default: the middle of the cell). */
  target?: (c: CellInfo) => [number, number];
  /** Extra test of a candidate (centre, angle). */
  accept?: (x: number, z: number) => boolean;
  /** Prefer spots whose front (-v) lies on the cell's outline (a square opening onto the street). */
  front?: boolean;
}

interface Fit { cell: CellInfo; x: number; z: number; angle: number; base: number; low: number }

class SiteFitter {
  constructor(readonly plan: MacroPlan, readonly terrain: Terrain, readonly placed: Landmark[]) {}

  /** Clearance from the cell outline: the widest bounding arterial's half width and sidewalk. */
  private clearance(c: CellInfo): number {
    let m = 0;
    for (const eid of c.edges) {
      const e = this.plan.edges[eid];
      if (e) m = Math.max(m, e.width / 2 + e.sidewalk);
    }
    return m + 3.5;
  }

  /** Is the oriented rectangle inside the polygon (corners inside, no outline edge crossing it)? */
  private rectIn(rect: Poly, poly: Poly): boolean {
    for (let k = 0; k < 8; k += 2) if (!pointInPoly(poly, rect[k], rect[k + 1])) return false;
    const n = poly.length >> 1;
    for (let k = 0; k < 4; k++) {
      const a = k * 2, b = ((k + 1) % 4) * 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (segIntersect(rect[a], rect[a + 1], rect[b], rect[b + 1], poly[i * 2], poly[i * 2 + 1], poly[j * 2], poly[j * 2 + 1])) return false;
      }
    }
    return true;
  }

  /** Clear of the other landmarks' sites (with a gap). */
  private clearOfOthers(x: number, z: number, hu: number, hv: number): boolean {
    const r = Math.hypot(hu, hv);
    for (const o of this.placed) if (Math.hypot(o.x - x, o.z - z) < r + Math.hypot(o.hu, o.hv) + 30) return false;
    return true;
  }

  /** Ground under the site: [highest, lowest], or null over water / too uneven. */
  private ground(x: number, z: number, angle: number, hu: number, hv: number, maxRange: number): [number, number] | null {
    const T = this.terrain, c = Math.cos(angle), s = Math.sin(angle);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
      const u = (i / 4 - 0.5) * 2 * hu, v = (j / 4 - 0.5) * 2 * hv;
      const px = x + u * c - v * s, pz = z + u * s + v * c;
      if (T.isWater(px, pz, 4)) return null;
      const h = T.height(px, pz);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    return hi - lo <= maxRange ? [hi, lo] : null;
  }

  /**
   * First cell (in the given order) that takes the site; within it the spot nearest the target,
   * turned so the front (-v) faces the nearest street.
   */
  fit(cells: CellInfo[], hu: number, hv: number, o: FitOpts): Fit | null {
    const used = new Set(this.placed.map((l) => l.cell));
    for (const c of cells) {
      if (used.has(c.id) || c.district === 'water') continue;
      const clear = this.clearance(c);
      for (const sh of offset([c.poly], -clear, 'miter')) {
        const piece = ensureCCW(sh.outer);
        const obb = minAreaRect(piece);
        if (Math.min(obb.hu, obb.hv) < Math.min(hu, hv) || Math.max(obb.hu, obb.hv) < Math.max(hu, hv)) continue;
        const [x0, z0, x1, z1] = polyBounds(piece);
        const [tx, tz] = o.target ? o.target(c) : polyCentroid(piece);
        const step = clamp(Math.min(hu, hv) / 2.5, 5, 18);
        const pts: [number, number, number][] = [];
        for (let x = x0 + step / 2; x < x1; x += step) for (let z = z0 + step / 2; z < z1; z += step) {
          if (pointInPoly(piece, x, z) && distPointPolyEdge(piece, x, z) >= Math.min(hu, hv) * 0.95) pts.push([x, z, Math.hypot(x - tx, z - tz)]);
        }
        pts.sort((a, b) => a[2] - b[2]);
        const angles = [obb.angle, c.gridAngle];
        // With a street front wanted: the best of the first fits by distance plus front gap.
        let pick: Fit | null = null, pickScore = Infinity, fits = 0;
        for (const [x, z, dt] of pts.slice(0, 260)) {
          if (pick && (!o.front || fits >= 30 || dt > pickScore)) break;
          if (!this.clearOfOthers(x, z, hu, hv) || (o.accept && !o.accept(x, z))) continue;
          let best: { angle: number; d: number } | null = null;
          for (const a0 of angles) for (let k = 0; k < 4; k++) {
            const angle = a0 + (k * Math.PI) / 2;
            const fr = { x, z, angle };
            if (!this.rectIn(siteRect(fr, -hu, -hv, hu, hv), piece)) continue;
            // Front edge middle: as close to the cell outline (a street) as possible.
            const [fx, fz] = siteToWorld(fr, 0, -hv);
            const d = distPointPolyEdge(c.poly, fx, fz);
            if (!best || d < best.d - 0.5) best = { angle, d };
          }
          if (!best) continue;
          const g = this.ground(x, z, best.angle, hu, hv, o.maxRange);
          if (!g) continue;
          fits++;
          const score = dt + (o.front ? best.d * 2.5 : 0);
          if (score < pickScore) { pickScore = score; pick = { cell: c, x, z, angle: best.angle, base: g[0] + CURB_H, low: g[1] }; }
        }
        if (pick) return pick;
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------- designs

/** A landmark's variant, parameters and site half sizes (before it is placed). */
interface Design { style: number; p: Record<string, number>; hu: number; hv: number; maxRange: number }

/** Shrink a design for a tight spot (k < 1); null when it cannot shrink further. */
type Designer = (r: Rng, k: number) => Design | null;

function townhallDesign(terrain: Terrain): Designer {
  const pr = terrain.profile, a = pr.arch;
  return (r, k) => {
    if (k < 0.55) return null;
    // 0 classical (portico, dome), 1 gothic (steep roofs, belfry), 2 baroque (clock tower, mansard), 3 modern (slab, campanile).
    const style = r.weighted([0, 1, 2, 3], (s) => [0.4 + a.american, 0.3 + a.oldWorld * (1 - a.warm), 0.3 + a.oldWorld, 0.15 + a.modern * 0.8][s]);
    const big = clamp(pr.radius / 4000, 0.4, 1.6);
    const w = Math.round(r.range(34, 48) * (0.8 + 0.25 * big) * k);
    const d = Math.round(r.range(20, 28) * k);
    const sq = Math.round(r.range(26, 44) * k);
    const wings = style !== 3 && r.chance(0.55) ? 1 : 0;
    const wingD = wings ? Math.round(r.range(10, 18) * k) : 0;
    const tower = style === 0 ? (r.chance(0.75) ? 2 : 1) : style === 3 ? r.int(0, 1) : 1;
    return {
      style, hu: w / 2 + 6, hv: (d + sq + wingD) / 2 + 4, maxRange: 7,
      p: { w, d, sq, wings, wingD, tower, floors: r.int(3, 4), towerH: Math.round(r.range(28, 52) * (0.85 + 0.15 * big)), wall: r.int(0, 3), roof: r.int(0, 2) },
    };
  };
}

function stadiumDesign(terrain: Terrain): Designer {
  const R = terrain.profile.radius;
  return (r, k) => {
    // k < 1: one tier less per step, then no car parks.
    const tiers0 = R < 1800 ? 1 : R < 4000 ? 2 : 3;
    const tiers = tiers0 - Math.round((1 - k) / 0.15);
    if (tiers < 1) return null;
    const shape = r.chance(0.5) ? 1 : 0;
    const track = shape === 0 && r.chance(0.35) ? 1 : 0;
    const ia = track ? 88 : r.range(60, 66), ib = track ? 52 : r.range(41, 46);
    const depth = r.range(11, 14);
    const roof = tiers0 === 1 ? r.weighted([0, 1], (v) => [0.5, 0.5][v]) : r.weighted([0, 1, 2, 3], (v) => [0.25, 0.25, 0.35, 0.15][v]);
    const park = k > 0.8 ? 1 : 0;
    const oa = ia + tiers * depth, ob = ib + tiers * depth;
    return {
      style: shape, hu: oa + 12 + (park ? 34 : 0), hv: ob + 14, maxRange: 4.5,
      p: { shape, tiers, ia, ib, depth, roof, track, park, seatA: r.int(0, 7), seatB: r.int(0, 7), wall: r.int(0, 2), lights: roof === 3 ? 0 : 1 },
    };
  };
}

function attractionDesign(kind: AttractionKind, terrain: Terrain): Designer {
  const pr = terrain.profile;
  const big = clamp(pr.radius / 4000, 0.3, 2);
  switch (kind) {
    case 'tower': return (r, k) => {
      if (k < 0.7) return null;
      // 0 concrete TV tower (pod), 1 steel lattice tower, 2 slender glass observation tower.
      const style = r.weighted([0, 1, 2], (s) => [1.2, 0.6 + pr.arch.oldWorld * 0.6, 0.4 + pr.arch.modern][s]);
      const h = Math.round(r.range(110, 170) * Math.sqrt(big) * (style === 1 ? 0.9 : 1));
      const half = style === 1 ? h * 0.13 + 8 : 26;
      return { style, hu: half * k, hv: half * k + 8, maxRange: 8, p: { h, pod: r.range(0.6, 0.78), r: r.range(4.5, 7), podR: r.range(12, 18), tiers: r.int(1, 3), colour: r.int(0, 3) } };
    };
    case 'cathedral': return (r, k) => {
      if (k < 0.65) return null;
      // 0 gothic twin towers, 1 gothic single spire, 2 domed (renaissance / byzantine).
      const style = r.weighted([0, 1, 2], (s) => [1, 0.8, 0.5 + pr.arch.warm][s]);
      const L = Math.round(r.range(62, 96) * k), W = Math.round(r.range(20, 28) * k);
      return { style, hu: W / 2 + 18 * k, hv: L / 2 + 16, maxRange: 6, p: { L, W, H: r.range(20, 30), towerH: r.range(60, 105), transept: r.range(1.6, 2.1), wall: r.int(0, 3), roof: r.int(0, 2) } };
    };
    case 'wheel': return (r, k) => {
      const D = Math.round(r.range(42, 70) * Math.sqrt(big) * k);
      if (D < 30) return null;
      return { style: r.int(0, 1), hu: D / 2 + 16, hv: 26, maxRange: 4, p: { D, n: 2 * Math.round(r.range(8, 18)), colour: r.int(0, 5), w: r.range(6, 9) } };
    };
    case 'monument': return (r, k) => {
      if (k < 0.6) return null;
      // 0 obelisk, 1 column with a figure, 2 triumphal arch, 3 statue on a pedestal.
      const style = r.int(0, 3);
      const R = Math.round(r.range(26, 38) * k);
      return { style, hu: R, hv: R, maxRange: 4, p: { h: r.range(22, 48), R, stone: r.int(0, 2), ring: r.int(0, 1) } };
    };
    case 'museum': return (r, k) => {
      if (k < 0.6) return null;
      // 0 neoclassical with a colonnade, 1 modern with a glass pyramid in its forecourt.
      const style = r.weighted([0, 1], (s) => [1 + pr.arch.oldWorld, 0.5 + pr.arch.modern][s]);
      const w = Math.round(r.range(56, 84) * k), d = Math.round(r.range(30, 42) * k), fc = Math.round(r.range(26, 36) * k);
      return { style, hu: w / 2 + 8, hv: (d + fc) / 2 + 5, maxRange: 5, p: { w, d, fc, h: r.range(15, 21), cols: 2 * r.int(4, 7), dome: r.chance(0.45) ? 1 : 0, wall: r.int(0, 2) } };
    };
    case 'lighthouse': return (r) => ({ style: r.int(0, 2), hu: 22, hv: 22, maxRange: 6, p: { h: r.range(26, 42), r: r.range(3.6, 5), stripes: r.int(0, 2), colour: r.int(0, 2) } });
    case 'fortress': return (r, k) => {
      const R = Math.round(r.range(34, 52) * k);
      if (R < 26) return null;
      return { style: r.chance(0.6) ? 1 : 0, hu: R + 12, hv: R + 12, maxRange: 40, p: { sides: r.int(4, 6), R, wallH: r.range(8, 13), keepH: r.range(22, 34), stone: r.int(0, 2) } };
    };
    case 'glasshouse': return (r, k) => {
      if (k < 0.6) return null;
      // 0 palm house (vaulted wings, a dome), 1 a single great dome, 2 three parallel vaults.
      const style = r.int(0, 2);
      const L = Math.round(r.range(60, 90) * k), W = Math.round(r.range(20, 30) * k);
      return { style, hu: L / 2 + 22, hv: W / 2 + 26, maxRange: 4, p: { L, W, H: r.range(14, 22), frame: r.int(0, 2) } };
    };
  }
}

// ------------------------------------------------------------------------- names

const SAINTS = ['Mary', 'Peter', 'Paul', 'Stephen', 'James', 'John', 'Mark', 'Nicholas', 'Michael', 'Catherine', 'Andrew', 'Lawrence', 'Bartholomew', 'Clement'];

function landmarkName(kind: LandmarkKind, style: number, r: Rng, city: string, american: boolean): string {
  const root = r.pick(ROOTS);
  switch (kind) {
    case 'townhall': return american ? 'City Hall' : r.chance(0.5) ? 'Town Hall' : `${city} Town Hall`;
    case 'stadium': return r.pick([`${root} Stadium`, `${city} Arena`, `${root} Park`, `${root} Field`, 'Municipal Stadium', `${root} Bowl`]);
    case 'tower': return style === 1 ? r.pick([`${root} Tower`, `${city} Lattice Tower`, 'Iron Tower']) : style === 0 ? r.pick([`${city} TV Tower`, 'Telecom Tower', `${root} Tower`]) : r.pick([`${city} Sky Tower`, `${root} Observation Tower`, 'The Needle']);
    case 'cathedral': return `${r.chance(0.8) ? 'St ' + r.pick(SAINTS) + "'s" : 'Holy Trinity'} ${style === 2 ? r.pick(['Basilica', 'Cathedral']) : 'Cathedral'}`;
    case 'wheel': return r.pick([`${city} Eye`, `${root} Wheel`, 'The Big Wheel', `${root} Observation Wheel`]);
    case 'monument': return [`${root} Obelisk`, r.pick(['Victory Column', `${root} Column`]), r.pick([`${root} Gate`, 'Triumphal Arch']), r.pick([`Statue of ${r.pick(['Liberty', 'the Founder', 'Concord', 'the Republic'])}`, `${root} Memorial`])][style];
    case 'museum': return r.pick([`${city} Museum of Art`, 'Museum of Natural History', 'National Gallery', `${root} Museum`, 'Science Museum', 'City Museum']);
    case 'lighthouse': return `${root} Point Lighthouse`;
    case 'fortress': return style === 1 ? r.pick([`${root} Castle ruin`, 'Old Fort', `${root} Citadel ruin`]) : r.pick([`${root} Castle`, `${city} Citadel`, `${root} Fortress`]);
    case 'glasshouse': return r.pick(['Botanical Garden', `${root} Palm House`, `${city} Conservatory`, `${root} Glasshouse`]);
    case 'airport': return r.chance(0.6) ? `${city} International Airport` : `${root} Field Airport`;
  }
}

// ---------------------------------------------------------------------- planning

/** Plan the city's landmarks (deterministic in the seed). */
export function planLandmarks(plan: MacroPlan, field: CityField, terrain: Terrain): Landmark[] {
  const pr = terrain.profile;
  const rng = new Rng(deriveSeed(pr.seed, 'landmarks'));
  const city = cityName(pr.seed);
  const american = pr.arch.american > pr.arch.oldWorld;
  const out: Landmark[] = [];
  const fitter = new SiteFitter(plan, terrain, out);
  const c0 = plan.centres[0];
  const dist = (c: CellInfo, x: number, z: number) => Math.hypot(c.centroid[0] - x, c.centroid[1] - z);
  const land = plan.cells.filter((c) => c.district !== 'water');

  const fronted = new Set<LandmarkKind>(['townhall', 'museum', 'cathedral', 'monument']);
  const add = (kind: LandmarkKind, des: Designer, cells: CellInfo[], target?: FitOpts['target'], accept?: FitOpts['accept']): Landmark | null => {
    const r = rng.fork(kind);
    for (const k of [1, 0.85, 0.7, 0.55]) {
      const d = des(r.fork(k * 100), k);
      if (!d) break;
      const f = fitter.fit(cells, d.hu, d.hv, { maxRange: d.maxRange, target, accept, front: fronted.has(kind) });
      if (!f) continue;
      const lm: Landmark = {
        id: out.length, kind, name: landmarkName(kind, d.style, r.fork('name'), city, american), cell: f.cell.id,
        x: f.x, z: f.z, angle: f.angle, hu: d.hu, hv: d.hv, site: [], base: f.base, low: f.low,
        seed: r.nextU32(), style: d.style, p: d.p,
      };
      lm.site = siteRect(lm, -lm.hu, -lm.hv, lm.hu, lm.hv);
      out.push(lm);
      return lm;
    }
    return null;
  };

  // --- Town hall: the old core (its square in front).
  {
    const [cx, cz] = plan.core;
    const cells = land.filter((c) => c.district !== 'industrial' && c.district !== 'port' && c.district !== 'park')
      .sort((a, b) => dist(a, cx, cz) - dist(b, cx, cz)).slice(0, 30);
    add('townhall', townhallDesign(terrain), cells, () => [cx, cz]);
  }
  // --- Stadium: around the edge of the centre, on open or industrial land rather than in the core.
  {
    const want = clamp(pr.radius * 0.36, 350, 2400);
    const pref: Record<string, number> = { park: -150, industrial: -120, suburban: -60, apartments: -40, rowhouses: -20, commercial: 40, port: 60, downtown: 260, oldtown: 400 };
    const cells = land.slice().sort((a, b) => (Math.abs(dist(a, c0.x, c0.z) - want) + (pref[a.district] ?? 0) - a.area / 2000) - (Math.abs(dist(b, c0.x, c0.z) - want) + (pref[b.district] ?? 0) - b.area / 2000)).slice(0, 40);
    add('stadium', stadiumDesign(terrain), cells);
  }
  // --- Attractions: a weighted pick from the pool of what suits this place.
  {
    const r = rng.fork('attractions');
    const n = attractionCount(pr.radius, r);
    const coastal = pr.coastal;
    // Relief: the highest land cell above the city's typical ground.
    const hs = land.map((c) => terrain.height(c.centroid[0], c.centroid[1])).sort((a, b) => a - b);
    const median = hs[hs.length >> 1] ?? 0;
    const hill = Math.max(0, ...land.map((c) => terrain.height(c.centroid[0], c.centroid[1]) - median));
    const weight: Record<AttractionKind, number> = {
      tower: 1.0 + pr.arch.modern * 0.6,
      cathedral: 0.5 + pr.arch.oldWorld * 1.2,
      wheel: 0.7 + (coastal ? 0.4 : 0),
      monument: 0.9,
      museum: 1.0,
      lighthouse: coastal ? 1.6 : 0,
      fortress: hill > 14 ? 1.4 : hill > 7 ? 0.5 : 0,
      glasshouse: 0.7 + pr.warmth * 0.3,
    };
    const pool = ATTRACTION_KINDS.slice();
    const near = (x: number, z: number, d: number) => (c: CellInfo) => Math.hypot(c.centroid[0] - x, c.centroid[1] - z) < d;
    const byDist = (x: number, z: number) => (a: CellInfo, b: CellInfo) => dist(a, x, z) - dist(b, x, z);
    let placed = 0;
    while (placed < n && pool.some((k) => weight[k] > 0)) {
      const kind = r.weighted(pool, (k) => weight[k]);
      weight[kind] = 0;
      let cells: CellInfo[];
      let target: FitOpts['target'];
      let accept: FitOpts['accept'];
      const central = pr.radius * 0.45;
      switch (kind) {
        case 'cathedral':
          cells = land.filter((c) => c.district === 'oldtown' || c.district === 'downtown' || c.district === 'commercial' || c.district === 'apartments').sort(byDist(plan.core[0], plan.core[1]));
          break;
        case 'museum': case 'monument':
          cells = land.filter((c) => c.district !== 'industrial' && c.district !== 'port' && c.district !== 'suburban').sort(byDist(c0.x, c0.z));
          if (kind === 'monument') cells = cells.filter(near(c0.x, c0.z, central));
          break;
        case 'tower': {
          // On high ground near the middle (a park, if there is one).
          const score = (c: CellInfo) => dist(c, c0.x, c0.z) / central - (terrain.height(c.centroid[0], c.centroid[1]) - median) / 25 - (c.district === 'park' ? 0.4 : 0);
          cells = land.filter((c) => c.district !== 'industrial' && c.district !== 'port').sort((a, b) => score(a) - score(b));
          break;
        }
        case 'wheel': {
          // By the water (river or sea) or in a park, not too far out.
          const score = (c: CellInfo) => {
            const w = terrain.water(c.centroid[0], c.centroid[1]);
            const wd = Math.min(w.river >= 0 ? w.d - w.halfWidth : 1e4, coastal ? terrain.coastDistance(c.centroid[0], c.centroid[1]) : 1e4);
            return Math.min(wd, 600) / 300 + dist(c, c0.x, c0.z) / central - (c.district === 'park' ? 0.7 : 0);
          };
          cells = land.filter((c) => c.district !== 'industrial').sort((a, b) => score(a) - score(b));
          break;
        }
        case 'lighthouse':
          cells = land.filter((c) => terrain.coastDistance(c.centroid[0], c.centroid[1]) < 450).sort((a, b) => terrain.coastDistance(a.centroid[0], a.centroid[1]) - terrain.coastDistance(b.centroid[0], b.centroid[1]));
          // As close to the shore as the cell allows.
          target = (c) => {
            const p = c.poly;
            let bx = c.centroid[0], bz = c.centroid[1], bd = Infinity;
            for (let i = 0; i < p.length; i += 2) { const d = terrain.coastDistance(p[i], p[i + 1]); if (d < bd) { bd = d; bx = p[i]; bz = p[i + 1]; } }
            return [bx, bz];
          };
          accept = (x, z) => terrain.coastDistance(x, z) < 160;
          break;
        case 'fortress': {
          const h = (c: CellInfo) => terrain.height(c.centroid[0], c.centroid[1]);
          cells = land.filter((c) => h(c) - median > hill * 0.5).sort((a, b) => h(b) - h(a));
          // On the hilltop of the cell.
          target = (c) => {
            const [x0, z0, x1, z1] = polyBounds(c.poly);
            let bx = c.centroid[0], bz = c.centroid[1], bh = -Infinity;
            for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
              const x = x0 + (x1 - x0) * i / 8, z = z0 + (z1 - z0) * j / 8;
              if (!pointInPoly(c.poly, x, z)) continue;
              const y = terrain.height(x, z);
              if (y > bh) { bh = y; bx = x; bz = z; }
            }
            return [bx, bz];
          };
          break;
        }
        case 'glasshouse': {
          const score = (c: CellInfo) => dist(c, c0.x, c0.z) / central - (c.district === 'park' ? 1 : c.district === 'suburban' ? 0.3 : 0);
          cells = land.filter((c) => c.district !== 'industrial' && c.district !== 'port' && c.district !== 'downtown').sort((a, b) => score(a) - score(b));
          break;
        }
      }
      if (add(kind, attractionDesign(kind, terrain), cells.slice(0, 40), target, accept)) placed++;
    }
    void field;
  }
  // --- Airport: on the airfield the terrain levelled, with a road from the nearest arterial node.
  const af = terrain.airfield;
  if (af) {
    const r = rng.fork('airport');
    const lm: Landmark = {
      id: out.length, kind: 'airport', name: landmarkName('airport', 0, r.fork('name'), city, american), cell: -1,
      x: af.x, z: af.z, angle: af.angle, hu: af.hu, hv: af.hv, site: [], base: af.level + 0.02, low: af.level,
      seed: r.nextU32(), style: r.int(0, 2),
      p: { runways: af.runways, len: af.runwayLen, side: af.side, gates: r.int(4, 8), planes: r.int(4, 9), tw: r.range(260, 420), hangars: r.int(2, 4) },
    };
    // The terminal faces the city: turn the frame so that side is -v (the front).
    if (af.side > 0) lm.angle += Math.PI;
    lm.site = siteRect(lm, -lm.hu, -lm.hv, lm.hu, lm.hv);
    lm.road = airportRoad(plan, terrain, lm);
    out.push(lm);
  }
  return out;
}

/** Access road: from the landside of the terminal to the nearest outer arterial node it reaches dry-shod. */
function airportRoad(plan: MacroPlan, terrain: Terrain, lm: Landmark): number[] | undefined {
  const [sx, sz] = siteToWorld(lm, 0, -lm.hv);
  const cands = plan.nodes.map((n, i) => ({ i, d: Math.hypot(n.x - sx, n.z - sz) })).sort((a, b) => a.d - b.d).slice(0, 12);
  for (const { i } of cands) {
    const n = plan.nodes[i];
    const L = Math.hypot(n.x - sx, n.z - sz);
    let wet = false;
    for (let s = 0; s <= L && !wet; s += 15) {
      const t = s / L;
      if (terrain.isWater(sx + (n.x - sx) * t, sz + (n.z - sz) * t, 6)) wet = true;
    }
    if (wet) continue;
    // Straight from the field's front edge, then on to the node.
    const [ax, az] = siteToWorld(lm, 0, -lm.hv - 60);
    return [...siteToWorld(lm, 0, -lm.hv + 20), sx, sz, ax, az, n.x, n.z];
  }
  return undefined;
}

// --------------------------------------------------------------- ground zones

/**
 * Ground of a site, split into zones (disjoint): the rest of the site is the landmark's
 * default ground (first zone kind wins where several touch is avoided by construction).
 */
export function siteZones(lm: Landmark): { base: ZoneKind; zones: SiteZone[] } {
  const P = lm.p;
  const R = (u0: number, v0: number, u1: number, v1: number) => siteRect(lm, u0, v0, u1, v1);
  switch (lm.kind) {
    case 'townhall': return { base: 'plaza', zones: [] };
    case 'stadium': {
      const oa = P.ia + P.tiers * P.depth, zones: SiteZone[] = [];
      // Car parks at both ends (when designed with them), the apron around the bowl paved.
      if (P.park) for (const s of [-1, 1]) zones.push({ kind: 'paved', poly: R(s < 0 ? -lm.hu + 2 : oa + 10, -lm.hv + 3, s < 0 ? -oa - 10 : lm.hu - 2, lm.hv - 3) });
      return { base: 'plaza', zones };
    }
    case 'tower': case 'monument': case 'museum': return { base: 'plaza', zones: [] };
    case 'cathedral': return { base: 'plaza', zones: [] };
    case 'lighthouse': return { base: 'park', zones: [] };
    case 'wheel': case 'fortress': case 'glasshouse': return { base: 'park', zones: [] };
    case 'airport': return { base: 'paved', zones: [] };
  }
}
