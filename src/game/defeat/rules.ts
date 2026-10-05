/**
 * Defeat rules (pure, tested by tools/selftest): who gets the rescue drones, which building is the
 * hospital, the drones' flight there, and the revival ward's layout.
 */
import { hash32 } from '../../core/rng';
import { clamp, smoothstep } from '../../core/math';
import { pointInPoly, type Poly } from '../../core/geom2';

/** Reputation the city needs to think well enough of the hero to send the drones (else: game over). */
export const RESCUE_MIN_REP = 0;

export const DEFEAT = {
  /** Lying there before the drones take off from the hospital (s). */
  downTime: 2.2,
  /** The drones come in from this far and high (m). */
  inboundDist: 70, inboundUp: 30,
  /** Their approach (s). */
  inboundTime: 4.2,
  /** Tethers on, the body lifted to under the drones (s). */
  liftTime: 2.6,
  /** Body under the drones (m). */
  hang: 3.1,
  /** The flight: speed (m/s) and its bounds (s). */
  flightSpeed: 48, flightMin: 6, flightMax: 14,
  /** Over the roof before the fade (s). */
  arriveTime: 1.4,
  /** Game over: lying there this long before the screen (s). */
  overDelay: 3.2,
  /** How deep under the hospital the ward is kept (m below the ground). */
  wardDepth: 420,
};

export function rescueAllowed(rep: number): boolean {
  return rep >= RESCUE_MIN_REP;
}

const NAMES = ['Helix Medical Center', 'Asclepion Regeneration Clinic', 'Meridian MedTech Hospital', 'Vitalis Medical Center', 'Aurora Life Hospital', 'Lazarus Institute'];

/** The city's hospital brand (one per city). */
export function hospitalName(seed: number): string {
  return NAMES[hash32(seed * 31 + 7) % NAMES.length];
}

/** A loaded building as the hospital choice sees it. */
export interface HospitalCandidate {
  id: number;
  x: number; z: number;
  /** Ground and roof height (m). */
  base: number; top: number;
  area: number;
  use: string;
  roof: string;
  alive: boolean;
}

/** Could this building be a hospital (a solid, flat-roofed, mid-rise block)? */
export function hospitalFit(b: HospitalCandidate): boolean {
  const h = b.top - b.base;
  return b.alive && b.roof === 'flat' && h >= 14 && h <= 110 && b.area >= 380 && (b.use === 'office' || b.use === 'civic' || b.use === 'mixed');
}

/**
 * The hospital for a defeat at (x, z): one of the city's hospital buildings (about one fitting
 * block in five, fixed by the seed, so the same ones every time), the nearest that is not right
 * here; failing that any fitting block, failing that any standing building. -1: none loaded.
 */
export function pickHospital(c: HospitalCandidate[], x: number, z: number, seed: number): number {
  const dist = (b: HospitalCandidate) => Math.hypot(b.x - x, b.z - z);
  const best = (ok: (b: HospitalCandidate) => boolean) => {
    let bi = -1, bd = Infinity;
    for (let i = 0; i < c.length; i++) {
      const b = c[i];
      if (!ok(b)) continue;
      // Not the building one went down beside: the drones should fly somewhere.
      const d = dist(b);
      const score = d < 50 ? d + 2000 : d;
      if (score < bd) { bd = score; bi = i; }
    }
    return bi;
  };
  const flagged = (b: HospitalCandidate) => hospitalFit(b) && hash32(seed ^ Math.imul(b.id, 0x9e3779b1)) % 5 === 0;
  let i = best(flagged);
  if (i < 0) i = best(hospitalFit);
  if (i < 0) i = best((b) => b.alive && b.top - b.base > 6);
  return i;
}

/** Something standing on a roof (a circle round it: x, z, radius). */
export interface RoofBlock { x: number; z: number; r: number }

/**
 * Where the landing pad goes on a roof (polygon `top`, flat [x, z, …]): the spot farthest from the
 * roof's edges and from what stands on it (water tanks, HVAC units, housings), on a 1 m grid; ties
 * go to the spot nearest (cx, cz). `clear`: room round it (m).
 */
export function padSpot(top: Poly, items: RoofBlock[], cx: number, cz: number): { x: number; z: number; clear: number } {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < top.length; i += 2) { x0 = Math.min(x0, top[i]); x1 = Math.max(x1, top[i]); z0 = Math.min(z0, top[i + 1]); z1 = Math.max(z1, top[i + 1]); }
  const n = top.length / 2;
  let best = { x: cx, z: cz, clear: -1 }, bestScore = -Infinity;
  const step = Math.max(1, Math.max(x1 - x0, z1 - z0) / 60);
  for (let x = x0 + step / 2; x < x1; x += step) for (let z = z0 + step / 2; z < z1; z += step) {
    if (!pointInPoly(top, x, z)) continue;
    let c = Infinity;
    for (let i = 0; i < n; i++) {
      const ax = top[i * 2], az = top[i * 2 + 1], bx = top[((i + 1) % n) * 2], bz = top[((i + 1) % n) * 2 + 1];
      const ex = bx - ax, ez = bz - az, L = ex * ex + ez * ez || 1;
      const t = clamp(((x - ax) * ex + (z - az) * ez) / L, 0, 1);
      c = Math.min(c, Math.hypot(x - ax - ex * t, z - az - ez * t));
    }
    for (const it of items) c = Math.min(c, Math.hypot(x - it.x, z - it.z) - it.r);
    // Room counts up to a full pad and some air (6.5 m); beyond that, the middle of the roof is nicer.
    const score = Math.min(c, 6.5) - Math.hypot(x - cx, z - cz) * 0.02;
    if (score > bestScore) { bestScore = score; best = { x, z, clear: c }; }
  }
  return best;
}

/** The drones' flight: a cubic Bézier from over the body to over the roof pad, cruising high. */
export interface FlightPlan {
  p: [number, number, number][];
  dur: number;
}

/**
 * From (a) the lifted body to (b) the pad on the hospital roof; `clear` is the highest roof in
 * between (the flight stays well above it).
 */
export function planFlight(a: [number, number, number], b: [number, number, number], clear: number): FlightPlan {
  const dx = b[0] - a[0], dz = b[2] - a[2], d = Math.hypot(dx, dz);
  const cruise = Math.max(a[1], b[1], clear) + clamp(25 + d * 0.04, 25, 70);
  // Straight up first, over the roofs, straight down onto the pad (the controls stand over the
  // ends; a little above cruise so the middle of the curve reaches it).
  const top = cruise + (cruise - Math.min(a[1], b[1])) * 0.33;
  const p: [number, number, number][] = [
    [a[0], a[1], a[2]],
    [a[0] + dx * 0.04, top, a[2] + dz * 0.04],
    [b[0] - dx * 0.04, top, b[2] - dz * 0.04],
    [b[0], b[1], b[2]],
  ];
  const len = d + (cruise - a[1]) + (cruise - b[1]);
  return { p, dur: clamp(len / DEFEAT.flightSpeed, DEFEAT.flightMin, DEFEAT.flightMax) };
}

/** Position on the flight at time t (eased in and out); `out` gets x, y, z. */
export function flightAt(f: FlightPlan, t: number, out: [number, number, number]): [number, number, number] {
  const u = smoothstep(0, 1, clamp(t / f.dur, 0, 1));
  const v = 1 - u, P = f.p;
  const w0 = v * v * v, w1 = 3 * v * v * u, w2 = 3 * v * u * u, w3 = u * u * u;
  for (let k = 0; k < 3; k++) out[k] = P[0][k] * w0 + P[1][k] * w1 + P[2][k] * w2 + P[3][k] * w3;
  return out;
}

/**
 * The revival ward (local coordinates, x across, z along, y up from the floor): a long white room,
 * the revival machine near the back wall, the exit doors at the front.
 */
export const WARD = {
  /** Half width (x) and half length (z), height (m). */
  hx: 7, hz: 11, h: 4.4,
  /** The revival machine (centre of the bed). */
  pod: { x: 0, z: -5.2, len: 2.5, w: 1.2, top: 0.95 },
  /** Where the hero stands up (at the foot of the machine, clear of it), facing the doors (+z). */
  stand: { x: 1.35, z: -3.3 },
  /** The exit: doors in the front wall (z = +hz), this wide; walking through leaves the ward. */
  door: { half: 1.6, open: 3.2 },
};

/** Inside the ward's walls (local x, z), kept r from them. */
export function wardInside(x: number, z: number, r = 0): boolean {
  return Math.abs(x) <= WARD.hx - r && Math.abs(z) <= WARD.hz - r;
}

/** Walked out through the doors (local)? */
export function wardExit(x: number, z: number): boolean {
  return Math.abs(x) < WARD.door.half && z > WARD.hz - 0.45;
}
