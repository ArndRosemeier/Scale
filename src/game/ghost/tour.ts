/**
 * The ghost tour's pure parts (no three.js, testable headless): when tours run, whether a leg of
 * the tour goes through a building (the ghost glides straight through, his group walks round), and
 * where each tourist stands at a stop.
 */

/** Tours run from dusk to the small hours (sky hours, 0..24). */
export const TOUR_FROM = 19, TOUR_TO = 3.5;

export function tourHours(hours: number): boolean {
  const h = ((hours % 24) + 24) % 24;
  return h >= TOUR_FROM || h < TOUR_TO;
}

/** Hours of night left for a tour (0 outside tour hours). */
export function nightLeft(hours: number): number {
  const h = ((hours % 24) + 24) % 24;
  if (!tourHours(h)) return 0;
  return h >= TOUR_FROM ? 24 - h + TOUR_TO : TOUR_TO - h;
}

/**
 * Does the straight line from a to b run through a building? `inside(x, z)` says whether a point is
 * in one; sampled every `step` m (not the ends: a stop is outside).
 */
export function crossesBuilding(ax: number, az: number, bx: number, bz: number, inside: (x: number, z: number) => boolean, step = 1.2): boolean {
  const d = Math.hypot(bx - ax, bz - az);
  const n = Math.floor(d / step);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (inside(ax + (bx - ax) * t, az + (bz - az) * t)) return true;
  }
  return false;
}

/**
 * Where tourist `i` of `n` stands at a stop: an arc in front of the guide (who stands at gx, gz and
 * faces `face`, a heading: the model's front is −Z), 2.4 … 3.4 m away.
 */
export function tourSlot(gx: number, gz: number, face: number, i: number, n: number): { x: number; z: number } {
  const fx = -Math.sin(face), fz = -Math.cos(face);
  const spread = Math.min(1.8, 0.45 * Math.max(1, n - 1));
  const u = n > 1 ? i / (n - 1) - 0.5 : 0;
  const ang = Math.atan2(fx, fz) + u * spread;
  const r = 2.4 + (i % 2) * 0.9;
  return { x: gx + Math.sin(ang) * r, z: gz + Math.cos(ang) * r };
}

/** The heading that faces from (x, z) towards (tx, tz) (model front is −Z). */
export function headingTo(x: number, z: number, tx: number, tz: number): number {
  return Math.atan2(-(tx - x), -(tz - z));
}

/** A cemetery piece the tour can stop at (from the props: graves, headstones, the monument). */
export interface GravePiece { x: number; z: number; yaw: number }

/** A stop: where he stands, the heading he faces, and the point he talks about. */
export interface GraveStop { x: number; z: number; face: number; px: number; pz: number }

/**
 * The cemetery part of a tour: in front of the main tomb first (it faces the gate), then up to
 * `n` graves within `r` m, each at least `gap` m from the others; he stands beside each, facing
 * the way its front faces (the gate). `shuffle` orders the candidates (a seeded shuffle).
 */
export function cemeteryStops(tomb: GravePiece, pieces: readonly GravePiece[], shuffle: <T>(a: T[]) => T[], n = 3, r = 38, gap = 9): GraveStop[] {
  const nx = -Math.sin(tomb.yaw), nz = -Math.cos(tomb.yaw);
  const out: GraveStop[] = [{ x: tomb.x + nx * 5.5, z: tomb.z + nz * 5.5, face: tomb.yaw, px: tomb.x, pz: tomb.z }];
  const near = pieces.filter((p) => Math.hypot(p.x - out[0].x, p.z - out[0].z) < r);
  for (const p of shuffle(near.slice())) {
    if (out.length > n) break;
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), sx = Math.cos(p.yaw), sz = -Math.sin(p.yaw);
    const s = { x: p.x + fx * 1.4 + sx * 0.9, z: p.z + fz * 1.4 + sz * 0.9, face: p.yaw, px: p.x, pz: p.z };
    if (out.some((o) => Math.hypot(o.x - s.x, o.z - s.z) < gap)) continue;
    out.push(s);
  }
  return out;
}
