/**
 * Leo Lightly, the man who can't land (pure part: no three.js, used by the selftest).
 *
 * A crystal earlier this year left Leo floating about a metre off the ground. He is no hero and no
 * villain, just a friendly accountant everyone in town knows. By day his kids Mia and Ben tow him
 * round his home park on a string, like a balloon. On windy days a gust can tear the string out of
 * Mia's hand and blow him onto a roof; then the fire brigade comes with the ladder (or the hero
 * fetches him down).
 *
 * Here: where he lives (a park near the core), when the family is out, where they are in each
 * slot when nobody is looking, the gust rule, and the string's pull (a tether with a hover spring).
 */
import type { MacroPlan } from '../../../plan/types';
import { deriveSeed, hash32, hashToFloat } from '../../../core/rng';
import { clamp } from '../../../core/math';

export const FLOATER = {
  /** Hover height of his feet over whatever is under him (m). */
  hover: 1.05,
  /** String length (m), from Mia's hand to his ankle. */
  string: 2.4,
  /** Out from … to (hours of the day). */
  from: 9.5, to: 18.5,
  /** Minutes per slot: each slot the family is at (or walking to) one spot of the park. */
  slotMin: 6,
  /** Wind (weather's 0..1) from which gusts can blow him off, and the chance per minute at full gale. */
  gustWind: 0.4, gustPerMin: 0.5,
  /** Real seconds without a gust after one (and at the start). */
  gustCalm: 300,
  /** Rain above which the family stays home. */
  rain: 0.3,
  /** Home spots within this of the home anchor (m). */
  homeR: 240,
};

/** The anchor of his patch: the park cell nearest the core (else the nearest homely cell). */
export function floaterHome(macro: MacroPlan): { x: number; z: number; cell: number } {
  const [cx, cz] = macro.core;
  let best: { x: number; z: number; cell: number } | null = null, bd = Infinity;
  for (const pass of [['park'], ['oldtown', 'apartments', 'rowhouses'], null] as (string[] | null)[]) {
    for (const c of macro.cells) {
      if (pass && !pass.includes(c.district)) continue;
      if (c.district === 'water') continue;
      const d = Math.hypot(c.centroid[0] - cx, c.centroid[1] - cz);
      if (d < bd) { bd = d; best = { x: c.centroid[0], z: c.centroid[1], cell: c.id }; }
    }
    if (best) return best;
  }
  return { x: cx, z: cz, cell: -1 };
}

/** Is the family out at this time (absolute game hours)? Some days they stay in. */
export function outingAt(seed: number, hoursAbs: number, rain: number): boolean {
  const day = Math.floor(hoursAbs / 24), h = hoursAbs - day * 24;
  if (rain > FLOATER.rain) return false;
  // One day in six they stay at home.
  if (hashToFloat(hash32(deriveSeed(seed, 'floater-day', day))) < 1 / 6) return false;
  // Each day a slightly different start and end.
  const j = hashToFloat(hash32(deriveSeed(seed, 'floater-hours', day)));
  return h >= FLOATER.from + j * 1.0 && h < FLOATER.to - (1 - j) * 1.0;
}

/** The slot number of a time (game hours). */
export function slotOf(hoursAbs: number): number {
  return Math.floor((hoursAbs * 60) / FLOATER.slotMin);
}

/** Which of `n` spots the family is at in a slot (never the same two slots running). */
export function spotOf(seed: number, slot: number, n: number): number {
  if (n <= 1) return 0;
  const h = (s: number) => hash32(deriveSeed(seed, 'floater-spot', s));
  if (n === 2) return (slot + h(0)) & 1;
  // Even slots pick freely; an odd slot picks among the spots its two neighbours did not.
  const even = (s: number) => h(s) % n;
  if ((slot & 1) === 0) return even(slot);
  const a = even(slot - 1), b = even(slot + 1);
  const free: number[] = [];
  for (let k = 0; k < n; k++) if (k !== a && k !== b) free.push(k);
  return free[h(slot) % free.length];
}

/**
 * The chance of a gust tearing him loose in `dt` s at this wind (0..1), out on the string. No gust
 * below FLOATER.gustWind; at a full gale about FLOATER.gustPerMin per minute.
 */
export function gustChance(wind: number, dt: number): number {
  const k = clamp((wind - FLOATER.gustWind) / (1 - FLOATER.gustWind), 0, 1);
  return 1 - Math.exp(-((k * k * FLOATER.gustPerMin) / 60) * dt);
}

export interface Body3 { x: number; y: number; z: number; vx: number; vy: number; vz: number }

/**
 * One step of his body on a string: drag in the air, a soft spring to his hover height `hoverY`,
 * the wind's push, and the string, which never lets the ankle (`ankle` m under his centre) get
 * farther than `len` from the hand. Returns the string's pull (m/s taken off the outward speed).
 */
export function tetherStep(b: Body3, hand: { x: number; y: number; z: number } | null, len: number, hoverY: number, wind: { x: number; z: number }, dt: number, ankle = 0.1): number {
  const drag = Math.exp(-1.6 * dt);
  b.vx = b.vx * drag + wind.x * dt;
  b.vz = b.vz * drag + wind.z * dt;
  b.vy = b.vy * Math.exp(-3 * dt) + (hoverY - b.y) * 6 * dt;
  b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
  if (b.y < hoverY - 0.5) { b.y = hoverY - 0.5; if (b.vy < 0) b.vy = 0; }
  if (!hand) return 0;
  const dx = b.x - hand.x, dy = b.y - ankle - hand.y, dz = b.z - hand.z;
  const d = Math.hypot(dx, dy, dz);
  if (d <= len || d < 1e-6) return 0;
  const nx = dx / d, ny = dy / d, nz = dz / d;
  b.x -= nx * (d - len); b.y -= ny * (d - len); b.z -= nz * (d - len);
  const out = b.vx * nx + b.vy * ny + b.vz * nz;
  if (out > 0) { b.vx -= nx * out; b.vy -= ny * out; b.vz -= nz * out; }
  return Math.max(0, out);
}
