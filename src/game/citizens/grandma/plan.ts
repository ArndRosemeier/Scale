/**
 * The magnetic grandma (game/citizens/grandma): the pure, seeded parts. Where in this city she
 * lives and does her shopping, when she is out, and where on her body a thing that flew to her
 * sticks. No three.js scene, no game: usable in the self test.
 *
 * She is one woman per city. An old crystal made her magnetic, and she has taken it cheerfully:
 * forks, tins, keys and now and then a bicycle stick to her while she does her rounds of the shops.
 */
import { Rng, deriveSeed, hash32 } from '../../../core/rng';
import type { MacroPlan, District } from '../../../plan/types';

/** Districts she might live in: shops on the ground floors, pavements to walk. */
const HOME_DISTRICTS: readonly District[] = ['oldtown', 'commercial', 'downtown', 'apartments', 'rowhouses'];

export interface GrandmaHome {
  /** Macro cell of her neighbourhood and its centre (world). */
  cell: number;
  x: number;
  z: number;
  district: District;
}

/**
 * Her neighbourhood: one of the cells nearest the main centre in a shopping district (oldtown and
 * commercial first), picked by the city seed. Null only for a city with no such cell at all.
 */
export function grandmaHome(macro: MacroPlan, seed: number): GrandmaHome | null {
  const main = macro.centres.length ? macro.centres.reduce((a, b) => (b.weight > a.weight ? b : a)) : { x: macro.core[0], z: macro.core[1] };
  const cands = macro.cells
    .filter((c) => HOME_DISTRICTS.includes(c.district) && c.area > 4000)
    .map((c) => {
      const d = Math.hypot(c.centroid[0] - main.x, c.centroid[1] - main.z);
      // Shops are where she wants to be: old town and the shopping streets weigh in closer.
      const bias = c.district === 'oldtown' || c.district === 'commercial' ? 0.6 : c.district === 'downtown' ? 0.85 : 1;
      return { c, k: d * bias };
    })
    .sort((a, b) => a.k - b.k || a.c.id - b.c.id)
    .slice(0, 6);
  if (!cands.length) return null;
  const pick = cands[hash32(deriveSeed(seed, 'grandma-home')) % cands.length].c;
  return { cell: pick.id, x: pick.centroid[0], z: pick.centroid[1], district: pick.district };
}

/** Her day: out shopping in the morning and the afternoon, home for lunch and at night. */
export const GRANDMA_HOURS: readonly [number, number][] = [[8.5, 12.5], [14, 18.5]];

/** Is she out at this time of day (hours 0–24)? */
export function grandmaOut(hour: number): boolean {
  const h = ((hour % 24) + 24) % 24;
  return GRANDMA_HOURS.some(([a, b]) => h >= a && h < b);
}

/** Her hours as text for the tracker ("8:30–12:30 and 14:00–18:30"). */
export function grandmaHoursText(): string {
  const t = (h: number) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
  return GRANDMA_HOURS.map(([a, b]) => `${t(a)}–${t(b)}`).join(' and ');
}

/** The day number of an absolute hour (for "gone for today"). */
export const dayOf = (hoursAbs: number): number => Math.floor(hoursAbs / 24);

// ------------------------------------------------------------------ where things stick

/** Body sizes the spots are fitted to (humanoid BodyFit's fields). */
export interface FitLike {
  height: number;
  shoulderWidth: number;
  chestDepth: number;
  waistRadius: number;
  upperArmRadius: number;
  forearmRadius: number;
  thighRadius: number;
  shinRadius: number;
  bones?: { upperArm: number; forearm: number; thigh: number; shin: number; spine: number; chest: number };
}

export type SpotSocket = 'chest' | 'spine' | 'pelvis' | 'back' | 'upperarm.L' | 'upperarm.R' | 'forearm.L' | 'forearm.R' | 'thigh.L' | 'thigh.R' | 'shin.L' | 'shin.R';

/** Where a thing sits on her: in socket space (see humanoid sockets), and the outward normal. */
export interface Spot {
  /** ('back' spots ride on the chest socket, round the back: the humanoid's back socket stands off it.) */
  socket: SpotSocket;
  pos: [number, number, number];
  normal: [number, number, number];
  /** Turn about the normal (radians). */
  roll: number;
}

/** Sockets by how much room they offer (a few weighted picks: most land on the coat). */
const SOCKETS: readonly [SpotSocket, number][] = [
  ['chest', 3], ['spine', 3], ['pelvis', 3], ['back', 2],
  ['upperarm.L', 1], ['upperarm.R', 1], ['forearm.L', 1.2], ['forearm.R', 1.2],
  ['thigh.L', 1], ['thigh.R', 1], ['shin.L', 0.5], ['shin.R', 0.5],
];

/** Clothes and a coat over the skin (m). */
const CLOTH = 0.035;

/**
 * A spot on the body's surface for a stuck thing. Trunk sockets: +Y up, +Z forward, the chest one
 * on the spine at the back (the ribs curve round forward of it). Limb sockets: origin at the joint,
 * +Y along the limb. The trunk is an ellipse round a centre; a limb a cylinder.
 */
export function spotFor(fit: FitLike, rng: Rng, socket?: SpotSocket): Spot {
  const s = socket ?? rng.weighted(SOCKETS, ([, w]) => w)[0];
  const B = fit.bones ?? { upperArm: fit.height * 0.17, forearm: fit.height * 0.15, thigh: fit.height * 0.245, shin: fit.height * 0.25, spine: fit.height * 0.1, chest: fit.height * 0.12 };
  const ell = (cz: number, rx: number, rz: number, y0: number, y1: number, a0: number, a1: number): Spot => {
    // Round the ellipse (angle 0 = straight ahead, ±π/2 the sides).
    const a = rng.range(a0, a1);
    const sx = Math.sin(a), cz2 = Math.cos(a);
    const x = sx * (rx + CLOTH), z = cz + cz2 * (rz + CLOTH);
    const nx = sx / rx, nz = cz2 / rz, n = Math.hypot(nx, nz) || 1;
    return { socket: s === 'back' ? 'chest' : s, pos: [x, rng.range(y0, y1), z], normal: [nx / n, 0, nz / n], roll: rng.range(-1.6, 1.6) };
  };
  const limb = (r: number, len: number, t0: number, t1: number): Spot => {
    const a = rng.range(-Math.PI, Math.PI);
    const nx = Math.sin(a), nz = Math.cos(a);
    return { socket: s, pos: [nx * (r + CLOTH * 0.7), len * rng.range(t0, t1), nz * (r + CLOTH * 0.7)], normal: [nx, 0, nz], roll: rng.range(-1.6, 1.6) };
  };
  const w = fit.shoulderWidth * 0.3, d = fit.chestDepth * 0.5, wr = fit.waistRadius;
  switch (s) {
    // (The chest socket is on the spine near the back: the front of the chest is ~0.7 of its depth ahead.)
    case 'chest': return ell(d * 0.6, w, d * 0.8, -fit.height * 0.13, -0.01, -1.2, 1.2);
    case 'back': return ell(d * 0.6, w, d * 0.8, -fit.height * 0.13, -0.02, Math.PI - 0.9, Math.PI + 0.9);
    case 'spine': return ell(wr * 0.15, wr * 1.05, wr * 0.95, 0.0, B.spine * 0.8, -1.4, 1.4);
    case 'pelvis': return ell(0, wr * 1.25, wr * 1.05, -0.08, 0.06, -2.4, 2.4);
    case 'upperarm.L': case 'upperarm.R': return limb(fit.upperArmRadius, B.upperArm, 0.3, 0.8);
    case 'forearm.L': case 'forearm.R': return limb(fit.forearmRadius, B.forearm, 0.25, 0.8);
    case 'thigh.L': case 'thigh.R': return limb(fit.thighRadius, B.thigh, 0.25, 0.75);
    case 'shin.L': case 'shin.R': return limb(fit.shinRadius, B.shin, 0.2, 0.6);
  }
}

/** Two spots too close to both hold something (m, socket space). */
export function spotsClash(a: Spot, b: Spot, r = 0.075): boolean {
  if (a.socket !== b.socket) return false;
  return Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]) < r;
}

/** A free spot (null after a few tries: she is full there). */
export function freeSpot(fit: FitLike, rng: Rng, taken: readonly Spot[], socket?: SpotSocket): Spot | null {
  for (let k = 0; k < 10; k++) {
    const s = spotFor(fit, rng, socket);
    if (!taken.some((t) => spotsClash(s, t))) return s;
  }
  return null;
}

/** Her name and title (the citizen's own first name). */
export const grandmaTitle = 'Magnetic grandma';
export const grandmaName = (first: string): string => `Grandma ${first}`;

/** A fresh rng for one moment of hers (no Math.random in game code). */
export const momentRng = (seed: number, n: number): Rng => new Rng(deriveSeed(seed, 'grandma', n));
