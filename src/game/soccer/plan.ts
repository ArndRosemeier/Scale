/**
 * Soccer in the stadium, the pure part around the match (no three.js: runs in the self test).
 *
 *  - When: by day (game time) the stadium has matches, one after another from FIRST until the
 *    last that ends before LAST (the evening is the concert's). `soccerAt` says whether one may
 *    kick off now.
 *  - Who: the city's clubs (`clubs(seed)`): names, kits, a level each and a squad of eleven who
 *    stay the same from match to match (each with a strength and a weakness: match.ts). Each
 *    match pairs two of them (`fixture`); an away side in colours too close to the home side's
 *    plays in its change kit.
 *  - Where: `soccerPlan(lm)` maps the pitch frame (match.ts: x along the pitch, y across) onto the
 *    stadium's site, the field's height, the tunnel's mouth, the scoreboard's face and the seats.
 */
import { Rng, deriveSeed } from '../../core/rng';
import { siteToWorld, worldToSite, type Landmark } from '../../plan/landmarks';
import { stadiumBowl } from '../../plan/landmarkParts';
import { ROOTS } from '../../plan/names';
import { standSeats, type Spot } from '../concert/plan';
import { HALF, HALF_TIME, AFTER, PITCH, type Kit } from './match';

/** Game hours: the first kick-off, and the last match is over by then. */
export const FIRST = 10, LAST = 17.25;
/** Real seconds a match takes, roughly (walk out, halves, half time, stoppages, walk off), and the break after one. */
export const MATCH_S = 40 + 2 * HALF + HALF_TIME + 70 + AFTER, BREAK_S = 75;
/** Clubs in a city. */
export const CLUBS = 6;

/** May a match kick off at this moment (hoursAbs, the clock's time scale: game s per real s)? */
export function soccerAt(hoursAbs: number, timeScale: number): { open: boolean; day: number } {
  const day = Math.floor(hoursAbs / 24), h = hoursAbs - day * 24;
  const len = (MATCH_S * Math.max(1, timeScale)) / 3600;
  return { open: h >= FIRST && h + len <= LAST, day };
}

export interface Club {
  name: string;
  short: string;
  kit: Kit;
  /** Change kit (when the colours clash). */
  away: Kit;
  /** How good (0…1). */
  level: number;
  /** A women's side. */
  women: boolean;
  seed: number;
}

type C3 = [number, number, number];
const COLOURS: C3[] = [
  [0.78, 0.08, 0.1], [0.08, 0.2, 0.62], [0.95, 0.78, 0.1], [0.06, 0.45, 0.2], [0.92, 0.92, 0.9], [0.45, 0.08, 0.42],
  [0.95, 0.42, 0.06], [0.1, 0.1, 0.12], [0.35, 0.65, 0.92], [0.55, 0.1, 0.12], [0.2, 0.6, 0.55],
];
const SUFFIX = ['Rovers', 'United', 'Athletic', 'Wanderers', 'City', 'Albion', 'Rangers', 'Town', 'Dynamo', 'Sporting', 'Olympic', 'Harriers'];

const near = (a: C3, b: C3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.45;

/** The city's clubs (the same every time for a seed). */
export function clubs(seed: number): Club[] {
  const r = new Rng(deriveSeed(seed, 'soccer', 'clubs'));
  const out: Club[] = [];
  const roots = new Set<string>(), sfx = new Set<string>();
  for (let i = 0; i < CLUBS; i++) {
    let root = r.pick(ROOTS);
    for (let k = 0; k < 20 && roots.has(root); k++) root = r.pick(ROOTS);
    roots.add(root);
    let s = r.pick(SUFFIX);
    for (let k = 0; k < 20 && sfx.has(s); k++) s = r.pick(SUFFIX);
    sfx.add(s);
    const form = r.int(0, 5);
    const name = form === 0 ? `FC ${root}` : form === 1 ? `${root} FC` : `${root} ${s}`;
    const shirt = COLOURS[(i * 3 + r.int(0, 2)) % COLOURS.length];
    let trim = r.pick(COLOURS);
    for (let k = 0; k < 10 && near(trim, shirt); k++) trim = r.pick(COLOURS);
    const pattern = r.weighted(['plain', 'stripes', 'checks'] as const, (p) => (p === 'plain' ? 3 : p === 'stripes' ? 1.4 : 0.4));
    const shorts: C3 = r.chance(0.5) ? [0.94, 0.94, 0.92] : r.chance(0.5) ? [0.08, 0.08, 0.1] : shirt;
    const keeper: C3 = r.pick([[0.2, 0.85, 0.3], [0.95, 0.85, 0.1], [0.95, 0.4, 0.75], [0.55, 0.25, 0.75], [0.4, 0.9, 0.9]] as C3[]);
    const awayShirt: C3 = near(shirt, [0.92, 0.92, 0.9]) ? [0.1, 0.1, 0.12] : [0.94, 0.94, 0.92];
    out.push({
      name, short: root.slice(0, 3).toUpperCase(),
      kit: { shirt, trim, pattern, shorts, keeper },
      away: { shirt: awayShirt, trim: shirt, pattern: 'plain', shorts: awayShirt, keeper: r.pick([[0.95, 0.55, 0.1], [0.5, 0.2, 0.7]] as C3[]) },
      level: r.range(0.15, 0.95), women: i % 3 === 2, seed: deriveSeed(seed, 'soccer', 'club', i),
    });
  }
  // Short names apart.
  const used = new Set<string>();
  for (const c of out) { let s = c.short, k = 0; while (used.has(s)) s = c.short.slice(0, 2) + String.fromCharCode(65 + k++); c.short = s; used.add(s); }
  return out;
}

/** The two clubs of a day's k-th match (home, away; women play women) and whether the away side changes kit. */
export function fixture(seed: number, day: number, k: number, all: Club[]): { home: number; away: number; change: boolean; seed: number } {
  const r = new Rng(deriveSeed(seed, 'soccer', 'fixture', day, k));
  const home = r.int(0, all.length - 1);
  const pool = all.map((_, i) => i).filter((i) => i !== home && all[i].women === all[home].women);
  const away = pool.length ? r.pick(pool) : (home + 1) % all.length;
  const change = near(all[home].kit.shirt, all[away].kit.shirt) || near(all[home].kit.keeper, all[away].kit.shirt);
  return { home, away, change, seed: deriveSeed(seed, 'soccer', 'match', day, k) };
}

export interface SoccerPlan {
  lm: Landmark;
  /** Height of the grass. */
  field: number;
  /** World point of a pitch point (match.ts frame: x along the pitch, y across). */
  toWorld(x: number, y: number): [number, number];
  /** Pitch point of a world point. */
  toPitch(x: number, z: number): [number, number];
  /** World direction angle of a pitch-frame angle (both atan2(dz, dx) style). */
  angle: number;
  /** The tunnel's mouth (pitch x): the gate at the -u end. */
  tunnelX: number;
  /** The scoreboard's face: centre (world), facing (Pedestrians-style heading of its normal), width, height. */
  board: { x: number; y: number; z: number; nx: number; nz: number; w: number; h: number };
  /** Seats facing the pitch (a share of them, seeded). */
  seats: Spot[];
  /** Is a world point on the pitch (inside its lines, a step to spare)? */
  onPitch(x: number, z: number, m?: number): boolean;
}

export function soccerPlan(lm: Landmark, seed: number): SoccerPlan {
  const P = lm.p, bowl = stadiumBowl(lm);
  const W = (u: number, v: number) => siteToWorld(lm, u, v);
  let topY = lm.base;
  for (let t = 0; t < P.tiers; t++) topY = Math.max(topY, bowl.tierY(t) + P.depth * 0.52);
  // (plan/landmarkParts stadium: the scoreboard box over the gate at the -u end, 2 m deep; the
  // screen hangs in front of its lower part, under the roof's rim.)
  const bu = -(P.ia + P.depth * P.tiers * 0.6) + 1.05;
  const [bx, bz] = W(bu, 0);
  const rng = new Rng(deriveSeed(seed, 'soccer', 'seats', lm.id));
  const all = standSeats(lm, (u, v) => [u * 0.55, v * 0.15]);
  const share = Math.min(0.5, 1500 / Math.max(1, all.length));
  const seats = all.filter(() => rng.chance(share)).map(({ x, y, z, heading }) => ({ x, y, z, heading }));
  return {
    lm, field: bowl.field,
    toWorld: (x, y) => W(x, y),
    toPitch: (x, z) => worldToSite(lm, x, z),
    angle: lm.angle,
    tunnelX: -(P.ia - 1.5),
    board: { x: bx, y: topY + 1.6, z: bz, nx: Math.cos(lm.angle), nz: Math.sin(lm.angle), w: 14, h: 5.4 },
    seats,
    onPitch: (x, z, m = 1.5) => { const [u, v] = worldToSite(lm, x, z); return Math.abs(u) < PITCH.L + m && Math.abs(v) < PITCH.W + m; },
  };
}
