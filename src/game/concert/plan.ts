/**
 * The stadium concert, the pure part (no three.js: runs in the self test).
 *
 *  - When: every evening (game time) the stadium has a show. Doors open at DOORS (the pit and the
 *    stands fill up), the band plays from SHOW until SHOW_END (the song playing then is finished),
 *    and the crowd goes home until OUT. `concertAt(hoursAbs)` says where in that evening it is.
 *  - Where: `concertPlan(lm)` lays the show out in the stadium's bowl (plan/landmarkParts
 *    stadiumBowl): the stage at the +u end of the field facing down the pitch, the band's marks on
 *    the deck, the standing pit in front of the stage (front rows first), seats in the stands
 *    (facing the stage, those behind the stage left empty) and the way out through the gate at
 *    the far end.
 *  - The set: `setList(seed, day, songs, budget, gap)`: the opener first, the closer last, the rest
 *    shuffled per night, as many of them as fit the evening (songs run their real length, longer
 *    than the game hours allow for all of them at the usual time scale).
 *
 * Headings use the Pedestrians convention (atan2(-dx, -dz): the way one faces).
 */
import { Rng, deriveSeed } from '../../core/rng';
import { siteToWorld, worldToSite, type Landmark } from '../../plan/landmarks';
import { stadiumBowl } from '../../plan/landmarkParts';

/** Game hours of the evening (of every day): doors, show, last song, crowd gone. */
export const DOORS = 18, SHOW = 19, SHOW_END = 23, OUT = 23.75;

export type ConcertPhase = 'none' | 'doors' | 'show' | 'out';

/** Where in the evening a moment is (hoursAbs: game hours since day 0, 00:00). */
export function concertAt(hoursAbs: number): { phase: ConcertPhase; day: number; t: number } {
  const day = Math.floor(hoursAbs / 24), h = hoursAbs - day * 24;
  if (h < DOORS || h >= OUT) return { phase: 'none', day, t: 0 };
  if (h < SHOW) return { phase: 'doors', day, t: (h - DOORS) / (SHOW - DOORS) };
  if (h < SHOW_END) return { phase: 'show', day, t: (h - SHOW) / (SHOW_END - SHOW) };
  return { phase: 'out', day, t: (h - SHOW_END) / (OUT - SHOW_END) };
}

/** Deck height, depth (along the pitch) and width of the stage (m). */
export const STAGE = { h: 1.8, d: 12, w: 24, roof: 13 };

/** Who stands where on the stage (u, v on the deck: u from the back wall towards the crowd). */
export type BandRole = 'singer' | 'guitar' | 'bass' | 'keys' | 'drums';
export const BAND: { role: BandRole; u: number; v: number }[] = [
  { role: 'singer', u: 9.6, v: 0 },
  { role: 'guitar', u: 7.6, v: -5.4 },
  { role: 'bass', u: 7.4, v: 5.2 },
  { role: 'keys', u: 4.4, v: -8.2 },
  { role: 'drums', u: 3.4, v: 0 },
];

export interface Spot { x: number; y: number; z: number; heading: number }

export interface ConcertPlan {
  lm: Landmark;
  /** Stage: back wall centre and front edge centre (world), the way the band faces, the deck's top. */
  stage: { x: number; z: number; fx: number; fz: number; heading: number; deckY: number; u0: number; u1: number };
  /** World point of a stage spot (u from the back wall, v across). */
  onStage(u: number, v: number): [number, number];
  /** The band's marks. */
  band: { role: BandRole; x: number; z: number; heading: number }[];
  /** Standing places in the pit, nearest the stage first. */
  pit: Spot[];
  /** Seats in the stands (a share of them, seeded), facing the stage. */
  seats: Spot[];
  /** The way out: inside the far gate, and outside it on the apron. */
  gateIn: [number, number];
  gateOut: [number, number];
  /** Floor under a point: the stage deck, the field, else null (not ours). */
  floor(x: number, z: number): number | null;
}

/** Half-width (along v) of the field at u. */
function halfWidth(ia: number, ib: number, n: number, u: number): number {
  const q = Math.abs(u) / ia;
  return q >= 1 ? 0 : ib * Math.pow(1 - Math.pow(q, n), 1 / n);
}

/** Most seats filled (the renderer draws each as one figure). */
export const SEAT_CAP = 1800;
/** Most pit places planned (the system fills the nearest ones it has room for). */
export const PIT_CAP = 420;

export function concertPlan(lm: Landmark, seed: number): ConcertPlan {
  const P = lm.p, bowl = stadiumBowl(lm);
  const { n } = bowl;
  const ia = P.ia, ib = P.ib;
  // The stage's back as far down the +u end as leaves it room for its width.
  let ub = ia - 2;
  while (ub > 20 && halfWidth(ia, ib, n, ub + 1) < STAGE.w / 2 + 2) ub -= 1;
  const u0 = ub, u1 = ub - STAGE.d;
  const deckY = bowl.field + STAGE.h;
  const W = (u: number, v: number) => siteToWorld(lm, u, v);
  const [sx, sz] = W(u0, 0), [fx, fz] = W(u1, 0);
  const heading = Math.atan2(-(fx - sx), -(fz - sz));
  const onStage = (du: number, v: number) => W(u0 - du, v);
  const band = BAND.map((b) => {
    const [x, z] = onStage(b.u, b.v);
    const [tx, tz] = W(u1 - 30, b.v * 0.3);
    return { role: b.role, x, z, heading: Math.atan2(-(tx - x), -(tz - z)) };
  });
  const rng = new Rng(deriveSeed(seed, 'concert', lm.id));
  // The pit: a crush barrier 2.5 m off the stage, then ranks of people towards the far end.
  const pit: (Spot & { d: number })[] = [];
  const front = u1 - 2.5;
  const [aimX, aimZ] = W(u1 + 2, 0);
  for (let u = front; u > -ia + 12; u -= 1.05) {
    const hw = halfWidth(ia, ib, n, u) - 3;
    if (hw < 3) continue;
    const back = front - u;
    // Dense at the front, thinning out towards the back.
    const keep = back < 22 ? 1 : back < 45 ? 0.75 : 0.35;
    for (let v = -hw; v <= hw; v += 0.95) {
      if (!rng.chance(keep)) { rng.float(); rng.float(); continue; }
      const uu = u + (rng.float() - 0.5) * 0.45, vv = v + (rng.float() - 0.5) * 0.4;
      const [x, z] = W(uu, vv);
      pit.push({ x, y: bowl.field, z, heading: Math.atan2(-(aimX - x), -(aimZ - z)), d: back + Math.abs(vv) * 0.35 });
    }
  }
  pit.sort((p, q) => p.d - q.d);
  // Seats: each row of each stand segment, a seat every 0.62 m, a share of them filled (not behind the stage).
  const seats: Spot[] = [];
  const all: Spot[] = [];
  const [cx, cz] = W(u1, 0);
  for (let i = 0; i < bowl.N; i++) {
    if (bowl.gate(i)) continue;
    const p0 = bowl.ring[i], p1 = bowl.ring[i + 1];
    const mu = (p0.u + p1.u) / 2, mv = (p0.v + p1.v) / 2;
    if (mu > u1 - 4 && Math.abs(mv) < STAGE.w / 2 + 14) continue;
    for (let tr = 0; tr < P.tiers; tr++) {
      for (let r = 0; r < bowl.rows; r++) {
        const o = tr * P.depth + (r + 0.55) * bowl.rowD;
        const y = bowl.tierY(tr) + (r + 1) * bowl.rise;
        const a0u = p0.u + p0.nu * o, a0v = p0.v + p0.nv * o, a1u = p1.u + p1.nu * o, a1v = p1.v + p1.nv * o;
        const L = Math.hypot(a1u - a0u, a1v - a0v), k = Math.max(1, Math.floor(L / 0.62));
        for (let s = 0; s < k; s++) {
          const f = (s + 0.5) / k;
          const [x, z] = W(a0u + (a1u - a0u) * f, a0v + (a1v - a0v) * f);
          all.push({ x, y, z, heading: Math.atan2(-(cx - x), -(cz - z)) });
        }
      }
    }
  }
  const share = Math.min(0.55, SEAT_CAP / Math.max(1, all.length));
  for (const s of all) if (rng.chance(share)) seats.push(s);
  const [gix, giz] = W(-ia + 3, 0), [gox, goz] = W(-ia - P.tiers * P.depth - 8, 0);
  return {
    lm,
    stage: { x: sx, z: sz, fx, fz, heading, deckY, u0, u1 },
    onStage,
    band,
    pit: pit.slice(0, PIT_CAP).map(({ x, y, z, heading: h }) => ({ x, y, z, heading: h })),
    seats,
    gateIn: [gix, giz],
    gateOut: [gox, goz],
    floor: (x, z) => {
      const [u, v] = worldToSite(lm, x, z);
      if (u <= u0 + 0.3 && u >= u1 - 0.05 && Math.abs(v) <= STAGE.w / 2) return deckY;
      if (Math.abs(v) < halfWidth(ia, ib, n, u) - 0.3) return bowl.field;
      // The gate's passage at the far end (out to the apron).
      if (u < 0 && Math.abs(v) < 4 && u > -ia - P.tiers * P.depth - 10) return bowl.field;
      return null;
    },
  };
}

/** One song of the act (public/music/live.json). */
export interface LiveSong { id: string; title: string; file: string; seconds: number; bpm: number; beat0: number; opener?: boolean; closer?: boolean }

/**
 * The night's running order: the opener first, the closer last, the others shuffled by night, as
 * many as fit `budget` seconds (each song costs its length plus `gap`; opener and closer always play).
 */
export function setList(seed: number, day: number, songs: readonly LiveSong[], budget = Infinity, gap = 0): LiveSong[] {
  const first = songs.filter((s) => s.opener), last = songs.filter((s) => s.closer && !s.opener);
  const mid = songs.filter((s) => !s.opener && !s.closer);
  const r = new Rng(deriveSeed(seed, 'setlist', day));
  for (let i = mid.length - 1; i > 0; i--) { const j = r.int(0, i); [mid[i], mid[j]] = [mid[j], mid[i]]; }
  let left = budget;
  for (const s of [...first, ...last]) left -= s.seconds + gap;
  const play = mid.filter((s) => (left >= s.seconds + gap ? ((left -= s.seconds + gap), true) : false));
  return [...first, ...play, ...last];
}

/** Parse public/music/live.json (missing parts: empty). */
export function parseLive(o: unknown): { act: string; songs: LiveSong[]; bands: Record<string, string> } {
  const j = (o ?? {}) as { act?: unknown; songs?: unknown; bands?: unknown };
  const songs: LiveSong[] = [];
  if (Array.isArray(j.songs)) for (const s of j.songs as Partial<LiveSong>[]) {
    if (typeof s?.id !== 'string' || typeof s.file !== 'string' || !(Number(s.seconds) > 0)) continue;
    songs.push({ id: s.id, title: String(s.title ?? s.id), file: s.file, seconds: Number(s.seconds), bpm: Number(s.bpm) > 0 ? Number(s.bpm) : 120, beat0: Number(s.beat0) || 0, opener: !!s.opener, closer: !!s.closer });
  }
  const bands: Record<string, string> = {};
  if (j.bands && typeof j.bands === 'object') for (const [k, v] of Object.entries(j.bands as Record<string, unknown>)) if (typeof v === 'string') bands[k] = v;
  return { act: typeof j.act === 'string' ? j.act : 'VELA', songs, bands };
}
