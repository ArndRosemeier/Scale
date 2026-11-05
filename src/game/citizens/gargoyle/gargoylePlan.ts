/**
 * The cathedral gargoyle's plan (pure, headless-tested): where it lives (its ledge on the cathedral
 * and its spot on the square below), its hours (stone by day, down on the square at night, back up
 * before dawn), when the night tours start, and which sights a tour visits.
 */
import { siteToWorld, type Landmark } from '../../../plan/landmarks';
import type { LmInterior, LmPerch } from '../../../plan/landmarkParts';
import { hashToFloat, deriveSeed } from '../../../core/rng';

export const GARGOYLE_PLAN = {
  /** It wakes (h) and is back on its ledge by (h). */
  wake: 20.5, sleep: 5.0,
  /** Night tours start at these hours; announced this long before (h). */
  tours: [22, 0, 2], announce: 0.2,
  /** Sights within this of the cathedral (m), at most this many per tour. */
  stopR: 650, maxStops: 3,
  /** Its spot on the square: this far to the side of the steps' foot, and out onto the square (m). */
  aside: 5, out: 4,
};

export interface GargoyleHome {
  /** The cathedral. */
  lm: Landmark;
  perch: LmPerch;
  /** Its night spot on the square (ground height filled in by the owner) and the way it faces. */
  spot: { x: number; z: number; h: number };
}

/**
 * Its home: the city's first cathedral with a ledge (else the town hall's roof edge), the ledge
 * picked by the seed, the spot on the square beside the foot of the steps on that side. Null: no
 * such building (no gargoyle).
 */
export function gargoyleHome(seed: number, landmarks: readonly Landmark[], interiorOf: (lm: Landmark) => LmInterior | null): GargoyleHome | null {
  const order = [...landmarks.filter((l) => l.kind === 'cathedral'), ...landmarks.filter((l) => l.kind === 'townhall')];
  for (const lm of order) {
    const ins = interiorOf(lm);
    if (!ins?.perches.length) continue;
    const i = Math.floor(hashToFloat(deriveSeed(seed, 'gargoyle-perch')) * ins.perches.length) % ins.perches.length;
    const perch = ins.perches[i];
    // The foot of the steps: the end of the way out of the west door.
    const ex = ins.exits[0];
    let fx: number, fz: number;
    if (ex && ex.pts.length >= 3) { fx = ex.pts[ex.pts.length - 3]; fz = ex.pts[ex.pts.length - 1]; } else [fx, fz] = siteToWorld(lm, 0, -lm.hv + 6);
    // Aside toward the perch's side, facing out over the square (−v).
    const ux = Math.cos(lm.angle), uz = Math.sin(lm.angle);
    const side = (perch.x - lm.x) * ux + (perch.z - lm.z) * uz >= 0 ? 1 : -1;
    const vx = -Math.sin(lm.angle), vz = Math.cos(lm.angle);
    const x = fx + ux * side * GARGOYLE_PLAN.aside - vx * GARGOYLE_PLAN.out, z = fz + uz * side * GARGOYLE_PLAN.aside - vz * GARGOYLE_PLAN.out;
    // Heading (PedAgent convention: forward = (−sin h, −cos h)) facing −v.
    return { lm, perch, spot: { x, z, h: Math.atan2(vx, vz) } };
  }
  return null;
}

/** Awake at this hour (down on the square)? */
export function awakeAt(hour: number): boolean {
  const P = GARGOYLE_PLAN;
  return hour >= P.wake || hour < P.sleep;
}

/** Hours from `a` forward to `b` on the clock (0 … 24). */
const ahead = (a: number, b: number) => ((b - a) % 24 + 24) % 24;

/** The tour starting now (its hour) given the clock's last and current hour, or null. */
export function tourStarting(prev: number, hour: number): number | null {
  for (const t of GARGOYLE_PLAN.tours) if (crossed(prev, hour, t)) return t;
  return null;
}

/** The tour to announce now (its hour), or null. */
export function tourAnnounce(prev: number, hour: number): number | null {
  for (const t of GARGOYLE_PLAN.tours) if (crossed(prev, hour, (t - GARGOYLE_PLAN.announce + 24) % 24)) return t;
  return null;
}

/** Did the clock pass `t` going from prev to hour (a small step forward)? */
function crossed(prev: number, hour: number, t: number): boolean {
  const step = ahead(prev, hour);
  return step > 0 && step < 2 && ahead(prev, t) <= step && ahead(prev, t) > 0;
}

export interface TourStop { kind: string; name: string; x: number; z: number; look: { x: number; z: number } }

/**
 * The sights of a tour: the cathedral first (from its spot), then the nearest landmarks within
 * stopR, each next one the nearest to the last (a stop in front of it, looking at it), and back.
 * `extra`: other sights (a cemetery, a metro station) as kind / name / point.
 */
export function tourStops(home: GargoyleHome, landmarks: readonly Landmark[], extra: TourStop[] = []): TourStop[] {
  const P = GARGOYLE_PLAN, s = home.spot;
  const out: TourStop[] = [{ kind: 'church', name: home.lm.name, x: s.x, z: s.z, look: { x: home.lm.x, z: home.lm.z } }];
  const cands: TourStop[] = [...extra];
  for (const lm of landmarks) {
    if (lm === home.lm || lm.kind === 'airport' || lm.cell < 0) continue;
    const [fx, fz] = siteToWorld(lm, 0, -lm.hv + 3);
    cands.push({ kind: lm.kind, name: lm.name, x: fx, z: fz, look: { x: lm.x, z: lm.z } });
  }
  const near = cands.filter((c) => Math.hypot(c.x - s.x, c.z - s.z) < P.stopR);
  let at = { x: s.x, z: s.z };
  while (out.length <= P.maxStops && near.length) {
    let bi = 0, bd = Infinity;
    near.forEach((c, i) => { const d = Math.hypot(c.x - at.x, c.z - at.z); if (d < bd) { bd = d; bi = i; } });
    const c = near.splice(bi, 1)[0];
    out.push(c);
    at = c;
  }
  return out;
}
