/**
 * Street life, the pure part: where eccentric street characters turn up (sites from the cell plan)
 * and who is there when (a seeded roll per site and hour slot). No three.js: runs in the self test.
 *
 * Sites: open spots on plazas, beside park paths, next to metro entrances and on wide sidewalks
 * (between the walking corridor and the facades), all clear of the walking lines, the carriageway,
 * doors, building footprints and street furniture (the rules of plan/terrace.ts).
 *
 * Cast: `streetCast(seed, site, district, hoursAbs)` — per site and SLOT_H-hour slot, whether
 * someone performs there and who (busker by day and evening, sleepwalker at night, the doomsayer
 * where the crowds are, the pigeon lady in the park …). Same seed + site + slot → same character.
 */
import { deriveSeed, hash32, hashToFloat } from '../../core/rng';
import { pointInPoly, polyArea, polyBounds, polyCentroid, closestOnPolyline } from '../../core/geom2';
import { clearOfWalk, frontDoor, streetBoxes } from '../../plan/terrace';
import { RoadClass, type District } from '../../plan/types';
import type { CellPlan } from '../../plan/cell';

export type StreetKind =
  | 'preacher' | 'busker' | 'band' | 'statue' | 'mime' | 'juggler' | 'dancer' | 'mascot' | 'conspiracy'
  | 'pigeons' | 'sleepwalker' | 'tourist' | 'jogger';

export const enum SiteKind { Plaza = 0, Park = 1, Metro = 2, Sidewalk = 3 }

export interface StreetSite {
  /** Stable id (cell id × 4096 + index). */
  key: number;
  kind: SiteKind;
  x: number; z: number;
  /** Heading (Pedestrians convention: atan2(-dx, -dz)) a performer faces: the passers-by. */
  face: number;
  cell: number;
}

export interface KindSpec {
  /** Shown on the target frame. */
  title: string;
  sites: readonly SiteKind[];
  /** Hours of the day [from, to) (to may pass midnight: 22 → 26). */
  hours: readonly (readonly [number, number])[];
  weight: number;
  /** Stays out in the rain. */
  rainproof?: boolean;
}

export const STREET_KINDS: Record<StreetKind, KindSpec> = {
  preacher: { title: 'Doomsayer', sites: [SiteKind.Plaza, SiteKind.Metro, SiteKind.Sidewalk], hours: [[9, 20.5]], weight: 1, rainproof: true },
  busker: { title: 'Busker', sites: [SiteKind.Plaza, SiteKind.Metro, SiteKind.Park, SiteKind.Sidewalk], hours: [[10, 23]], weight: 1.6 },
  band: { title: 'Street band', sites: [SiteKind.Plaza, SiteKind.Park, SiteKind.Metro], hours: [[11, 22.5]], weight: 0.8 },
  statue: { title: 'Living statue', sites: [SiteKind.Plaza, SiteKind.Sidewalk], hours: [[10, 18.5]], weight: 0.9 },
  mime: { title: 'Mime', sites: [SiteKind.Plaza, SiteKind.Sidewalk], hours: [[10, 18]], weight: 0.8 },
  juggler: { title: 'Juggler', sites: [SiteKind.Plaza, SiteKind.Park], hours: [[11, 19]], weight: 0.9 },
  dancer: { title: 'Street dancer', sites: [SiteKind.Plaza, SiteKind.Metro, SiteKind.Park], hours: [[14, 23.5]], weight: 1 },
  mascot: { title: 'Chicken mascot', sites: [SiteKind.Sidewalk, SiteKind.Plaza], hours: [[9, 18]], weight: 0.8 },
  conspiracy: { title: 'Conspiracy theorist', sites: [SiteKind.Metro, SiteKind.Sidewalk, SiteKind.Plaza], hours: [[8, 23]], weight: 0.9, rainproof: true },
  pigeons: { title: 'Pigeon lady', sites: [SiteKind.Park, SiteKind.Plaza], hours: [[7, 17]], weight: 1 },
  sleepwalker: { title: 'Sleepwalker', sites: [SiteKind.Sidewalk, SiteKind.Park], hours: [[0.5, 4.5]], weight: 1, rainproof: true },
  tourist: { title: 'Lost tourist', sites: [SiteKind.Plaza, SiteKind.Sidewalk, SiteKind.Metro], hours: [[9, 19]], weight: 1 },
  jogger: { title: 'Jogger', sites: [SiteKind.Park, SiteKind.Sidewalk], hours: [[6, 9.5], [17, 20.5]], weight: 0.9, rainproof: true },
};
export const STREET_KIND_LIST = Object.keys(STREET_KINDS) as StreetKind[];

/** Hours per cast slot: a character keeps their spot this long (game time). */
export const SLOT_H = 1.5;
/** Chance a site has somebody, by site kind and by district. */
const SITE_OCC: Record<SiteKind, number> = { [SiteKind.Plaza]: 0.75, [SiteKind.Park]: 0.5, [SiteKind.Metro]: 0.6, [SiteKind.Sidewalk]: 0.16 };
const DISTRICT_OCC: Record<District, number> = { downtown: 1, commercial: 0.95, oldtown: 1.1, apartments: 0.6, rowhouses: 0.45, suburban: 0.3, industrial: 0.2, port: 0.3, park: 0.85, water: 0 };

/** Does a kind work at this hour of the day? */
export function kindAt(k: StreetKind, hour: number): boolean {
  const h = ((hour % 24) + 24) % 24;
  return STREET_KINDS[k].hours.some(([a, b]) => (h >= a && h < b) || (h + 24 >= a && h + 24 < b));
}

export interface StreetCast { kind: StreetKind; seed: number; slot: number; from: number; to: number }

/**
 * Who is at a site in the slot containing `hoursAbs` (null: nobody). Pure: same seed, site and slot
 * give the same character. The hour that decides the line-up is the slot's middle.
 */
export function streetCast(seed: number, site: { key: number; kind: SiteKind }, district: District, hoursAbs: number): StreetCast | null {
  const slot = Math.floor(hoursAbs / SLOT_H);
  const h = deriveSeed(seed, 'street', site.key, slot);
  const hour = (slot + 0.5) * SLOT_H;
  const night = ((hour % 24) + 24) % 24 < 6;
  // Quieter at night (only the night people are about).
  const occ = SITE_OCC[site.kind] * (DISTRICT_OCC[district] ?? 0.5) * (night ? 0.6 : 1);
  if (hashToFloat(h) >= occ) return null;
  let total = 0;
  for (const k of STREET_KIND_LIST) if (STREET_KINDS[k].sites.includes(site.kind) && kindAt(k, hour)) total += STREET_KINDS[k].weight;
  if (total <= 0) return null;
  let r = hashToFloat(hash32(h + 0x9e37)) * total;
  for (const k of STREET_KIND_LIST) {
    const s = STREET_KINDS[k];
    if (!s.sites.includes(site.kind) || !kindAt(k, hour)) continue;
    r -= s.weight;
    if (r < 0) return { kind: k, seed: hash32(h ^ 0x5a17c0de) >>> 0, slot, from: slot * SLOT_H, to: (slot + 1) * SLOT_H };
  }
  return null;
}

// ------------------------------------------------------------------ sites

/** Clearance of a site (m): props, doors, footprints. */
const SITE_R = 0.8;
const PROP_CLEAR = 1.6;
const DOOR_CLEAR = 3;
/** Sidewalk sites at least this far apart along a street (m), and the narrowest sidewalk used. */
const SIDEWALK_STEP = 55;
const SIDEWALK_MIN = 3.6;

/**
 * Candidate sites of a cell plan (deterministic for the plan). A handful per cell: plazas get two
 * or three, parks a few along their paths, metro entrances one beside the stairs, wide sidewalks
 * one every SIDEWALK_STEP m or so.
 */
export function streetSites(plan: CellPlan): StreetSite[] {
  const out: StreetSite[] = [];
  const boxes = streetBoxes(plan.streets);
  const P = plan.props;
  const doors = plan.buildings.map((b) => frontDoor(b));
  const bb = plan.buildings.map((b) => polyBounds(b.poly));
  const free = (x: number, z: number, r = SITE_R): boolean => {
    if (!clearOfWalk(plan.streets, x, z, r, false, boxes)) return false;
    for (let i = 0; i < P.length; i += 6) { const dx = P[i + 1] - x, dz = P[i + 2] - z; if (dx * dx + dz * dz < PROP_CLEAR * PROP_CLEAR) return false; }
    for (const d of doors) if (Math.hypot(d.x - x, d.z - z) < DOOR_CLEAR) return false;
    for (let i = 0; i < bb.length; i++) {
      const q = bb[i];
      if (x < q[0] - r || x > q[2] + r || z < q[1] - r || z > q[3] + r) continue;
      if (pointInPoly(plan.buildings[i].poly, x, z)) return false;
    }
    // Not too close to another site.
    for (const s of out) if (Math.hypot(s.x - x, s.z - z) < 14) return false;
    return true;
  };
  const add = (kind: SiteKind, x: number, z: number, fx: number, fz: number) => {
    out.push({ key: plan.id * 4096 + out.length, kind, x, z, face: Math.atan2(-(fx - x), -(fz - z)), cell: plan.id });
  };
  const h0 = deriveSeed(plan.id, 'street-sites');
  // Plazas: spots inside, facing the middle.
  plan.plazas.forEach((s, k) => {
    const A = Math.abs(polyArea(s.outer));
    if (A < 120) return;
    const [x0, z0, x1, z1] = polyBounds(s.outer);
    const c = polyCentroid(s.outer);
    const want = A > 1500 ? 3 : A > 500 ? 2 : 1;
    let got = 0;
    for (let t = 0; t < 24 && got < want; t++) {
      const h = hash32(h0 + k * 977 + t * 131);
      const x = x0 + hashToFloat(h) * (x1 - x0), z = z0 + hashToFloat(hash32(h + 1)) * (z1 - z0);
      if (!pointInPoly(s.outer, x, z) || s.holes.some((hp) => pointInPoly(hp, x, z))) continue;
      if (!free(x, z)) continue;
      const far = Math.hypot(c[0] - x, c[1] - z) > 3;
      add(SiteKind.Plaza, x, z, far ? c[0] : x + 1, far ? c[1] : z);
      got++;
    }
  });
  // Parks: on the lawns of the small ones (facing their middle), beside the paths of the big ones.
  let parkN = 0;
  plan.parks.forEach((s, k) => {
    const A = Math.abs(polyArea(s.outer));
    if (A < 200 || parkN >= 4) return;
    const [x0, z0, x1, z1] = polyBounds(s.outer);
    const c = polyCentroid(s.outer);
    for (let t = 0; t < 12; t++) {
      const h = hash32(h0 + 5003 + k * 389 + t * 71);
      const x = x0 + hashToFloat(h) * (x1 - x0), z = z0 + hashToFloat(hash32(h + 1)) * (z1 - z0);
      if (!pointInPoly(s.outer, x, z) || s.holes.some((hp) => pointInPoly(hp, x, z)) || !free(x, z)) continue;
      const far = Math.hypot(c[0] - x, c[1] - z) > 3;
      add(SiteKind.Park, x, z, far ? c[0] : x + 1, far ? c[1] : z);
      parkN++;
      break;
    }
  });
  plan.streets.forEach((st, k) => {
    if (st.cls !== RoadClass.Path || parkN >= 4) return;
    const n = st.pts.length / 2;
    if (n < 2) return;
    const h = hash32(h0 + 7001 + k * 31);
    const i = Math.min(n - 2, Math.floor(hashToFloat(h) * (n - 1)));
    const ax = st.pts[i * 2], az = st.pts[i * 2 + 1], bx = st.pts[i * 2 + 2], bz = st.pts[i * 2 + 3];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 4) return;
    const u = 0.3 + hashToFloat(hash32(h + 1)) * 0.4, side = hash32(h + 2) & 1 ? 1 : -1;
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    const px = ax + (bx - ax) * u, pz = az + (bz - az) * u;
    const off = st.width / 2 + 0.4 + SITE_R + 0.35;
    const x = px - uz * off * side, z = pz + ux * off * side;
    if (!free(x, z)) return;
    add(SiteKind.Park, x, z, px, pz);
    parkN++;
  });
  // Metro entrances: beside the stairwell.
  for (let i = 0; i < plan.entrances.length; i += 6) {
    const cx = plan.entrances[i], cz = plan.entrances[i + 1], ux = plan.entrances[i + 2], uz = plan.entrances[i + 3];
    for (const side of [1, -1]) {
      const x = cx - uz * side * 3.2 + ux * 1.5, z = cz + ux * side * 3.2 + uz * 1.5;
      if (!free(x, z)) continue;
      add(SiteKind.Metro, x, z, cx + ux * 4, cz + uz * 4);
      break;
    }
  }
  // Wide sidewalks: between the walking corridor and the facades, facing the street.
  plan.streets.forEach((st, k) => {
    if (st.cls === RoadClass.Path || st.sidewalk < SIDEWALK_MIN) return;
    const n = st.pts.length / 2;
    let len = 0;
    const cum = [0];
    for (let i = 1; i < n; i++) { len += Math.hypot(st.pts[i * 2] - st.pts[i * 2 - 2], st.pts[i * 2 + 1] - st.pts[i * 2 - 1]); cum.push(len); }
    const d = st.width / 2 + st.sidewalk / 2 + 1.0 + SITE_R + 0.15;
    if (d > st.width / 2 + st.sidewalk - 0.3) return;
    for (let s = 20 + hashToFloat(hash32(h0 + 9001 + k)) * 20; s < len - 20; s += SIDEWALK_STEP) {
      let i = 1;
      while (i < n - 1 && cum[i] < s) i++;
      const ax = st.pts[i * 2 - 2], az = st.pts[i * 2 - 1], bx = st.pts[i * 2], bz = st.pts[i * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az) || 1, t = (s - cum[i - 1]) / L;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      const px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
      const side = hash32(h0 + k * 17 + Math.floor(s)) & 1 ? 1 : -1;
      const x = px - uz * d * side, z = pz + ux * d * side;
      // (The nearest street must be this one: not across a junction on another sidewalk.)
      if (closestOnPolyline(st.pts, x, z).d < d - 0.05 || !free(x, z)) continue;
      add(SiteKind.Sidewalk, x, z, px, pz);
    }
  });
  return out;
}
