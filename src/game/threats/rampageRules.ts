/**
 * The army against a rampaging giant player (THREATS_PLAN §5 question 2, PLAYGROUND_PLAN §0
 * decision 19: "Army vs the player: yes, without a cap — a rampaging, low-reputation player gets the
 * full response ladder, after a clear warning sequence"). Pure rules: no three.js, no game — the
 * game's `HostilePlayer` (threats/PlayerRampage.ts) and the headless checks (tools/selftest.ts) share them.
 *
 *  - Fury: a decaying meter of the player's own destruction (buildings brought down, facades
 *    smashed, people knocked down, cars wrecked, officers and soldiers attacked).
 *  - The watch (`RampageWatch`): a giant (≥ RAMPAGE.minHeight) with a low reputation whose fury
 *    climbs is warned, then warned a last time, then the city treats them as a major threat — the
 *    response ladder from patrol cars to the army, the air and, rarely, the last resort. Standing
 *    down (no destruction for a while, or human-sized again) ends it; a relapse soon after brings the
 *    army back without new warnings.
 *  - The player's body as the army sees it (`PLAYER_ZONES`, RAMPAGE.hp): army damage points are
 *    turned into the player's health.
 *  - `simulatePlayerBattle`: the battle model (BattleModel) against a giant standing in the street or
 *    walking away — the army rings it, follows it, and wears a passive one down in a bounded time.
 */
import { Rng } from '../../core/rng';
import { ARMY, FORCE, levelSquads, regroup, stepForces, type MonsterView, type PathView, type Squad, type ZoneView } from '../response/forces/BattleModel';

export const RAMPAGE = {
  /** A giant: the player at least this tall (m; THREATS_PLAN size tier T2 and up). */
  minHeight: 6,
  /** Reputation at or below this (feared): the city takes a giant on the loose for a threat. */
  rep: -40,
  /** What the player's own destruction adds to the fury; it halves every `half` s. */
  fury: { collapse: 3, perStorey: 0.35, facade: 0.25, person: 0.6, car: 0.4, officer: 1.2, half: 75 },
  /** The first warning at `warn`; the last one `gap` s later (still above `warn`); the army `gap` s after that (still above `act`). */
  warn: 6, act: 9, gap: 20,
  /** Below this share of `warn` while being warned: they stopped, the warnings lapse. */
  lapse: 0.5,
  /**
   * Standing down: no destruction for `quietT` s, or human-sized (under minHeight) for `smallT` s (the fury is spent
   * then) — never before `minHostile` s: once mobilised, the Guard and the army get there and keep the giant covered.
   */
  quietT: 45, smallT: 20, minHostile: 240,
  /** The army's units come in this far from the player (m; nearer than a monster's 720: they are sent where the player is). */
  spawnR: 420,
  /** A relapse within this long (s) of the last warning brings the army back without new warnings. */
  memory: 300,
  /** Army damage points (before armour) a full health bar is worth. */
  hp: 500,
  /** The incident's radius: this + the player's height × `radiusK` (m). */
  radius: 40, radiusK: 2,
  /** Units holding out of reach of a moving player go again after this long (s). */
  regroupT: 5,
};

/** What a ledger entry of the player's adds to the fury. */
export interface FuryEntry {
  target: string;
  effect: string;
  /** A collapse: storeys that came down. */
  size?: number;
  /** A person hit: their role (police, soldier, criminal …). */
  role?: string;
}

export function furyOf(e: FuryEntry): number {
  const F = RAMPAGE.fury;
  if (e.target === 'building') return e.effect === 'collapse' ? F.collapse + Math.min(12, e.size ?? 1) * F.perStorey : F.facade;
  if (e.target === 'person') {
    // Criminals are fair game; officers and soldiers count double.
    if (e.role === 'criminal') return 0;
    if (e.role === 'police' || e.role === 'soldier') return F.officer;
    return e.effect === 'wet' || e.effect === 'stall' ? 0 : F.person;
  }
  if (e.target === 'car') return e.effect === 'wreck' ? F.car : 0;
  return 0;
}

export type WatchState = 'calm' | 'warned' | 'final' | 'hostile';
export type WatchSignal = 'warn' | 'final' | 'hostile' | 'lapse' | 'standDown';

/** The warning sequence and the hostile state, step by step. */
export class RampageWatch {
  fury = 0;
  state: WatchState = 'calm';
  /** Seconds in the current state, since the last destruction, while human-sized; the watch's own clock. */
  t = 0;
  quiet = 0;
  small = 0;
  now = 0;
  /** When the last warning was given (−∞: never). */
  warnedAt = -1e9;
  stats = { warnings: 0, finals: 0, hostile: 0, lapsed: 0, stoodDown: 0 };

  /**
   * One step: the fury added since the last one, the player's height and reputation. Returns what
   * changed (the game shows it), or null.
   */
  step(dt: number, added: number, height: number, rep: number): WatchSignal | null {
    const R = RAMPAGE;
    this.now += dt;
    this.t += dt;
    this.fury = this.fury * Math.pow(0.5, dt / R.fury.half) + added;
    this.quiet = added > 0 ? 0 : this.quiet + dt;
    this.small = height < R.minHeight ? this.small + dt : 0;
    const giant = height >= R.minHeight, eligible = giant && rep <= R.rep;
    switch (this.state) {
      case 'calm':
        if (!eligible || this.fury < R.warn) return null;
        // Warned not long ago: no more warnings.
        if (this.now - this.warnedAt < R.memory) return this.go('hostile');
        this.warnedAt = this.now;
        this.stats.warnings++;
        return this.go('warned');
      case 'warned':
      case 'final':
        if (this.fury < R.warn * R.lapse || !giant) { this.stats.lapsed++; this.go('calm'); return 'lapse'; }
        if (this.t < R.gap) return null;
        if (this.state === 'warned' && this.fury >= R.warn) { this.warnedAt = this.now; this.stats.finals++; return this.go('final'); }
        if (this.state === 'final' && this.fury >= R.act && eligible) return this.go('hostile');
        return null;
      case 'hostile':
        if (this.t >= R.minHostile && (this.quiet >= R.quietT || this.small >= R.smallT)) { this.stats.stoodDown++; this.reset(); return 'standDown'; }
        return null;
    }
  }

  private go(s: WatchState): WatchSignal | null {
    this.state = s;
    this.t = 0;
    if (s === 'hostile') this.stats.hostile++;
    return s === 'warned' ? 'warn' : s === 'final' ? 'final' : s === 'hostile' ? 'hostile' : null;
  }

  /** Dev: the army comes now (no warnings). */
  force(): WatchSignal {
    this.warnedAt = this.now;
    this.fury = Math.max(this.fury, RAMPAGE.act);
    this.quiet = 0;
    this.go('hostile');
    return 'hostile';
  }

  /** It is over (brought down, the strike): the fury is spent, the warnings stay remembered. */
  reset(): void {
    this.fury = 0;
    this.state = 'calm';
    this.t = 0;
    this.quiet = 0;
  }
}

/** The player's body zones as the army sees them (no weak spots: a hero has none to show). */
export const PLAYER_ZONES: { id: string; name: string; armour: number; weak: false; at: number; r: number }[] = [
  /** `at`: height share of the centre; `r`: radius as a share of the height. */
  { id: 'head', name: 'head', armour: 0.2, weak: false, at: 0.9, r: 0.1 },
  { id: 'torso', name: 'body', armour: 0.35, weak: false, at: 0.62, r: 0.2 },
  { id: 'legs', name: 'legs', armour: 0.3, weak: false, at: 0.25, r: 0.22 },
];

/** Damage after the zone's armour (army points). */
export function playerDamage(zoneArmour: number, amount: number): number {
  return Math.max(0, amount) * (1 - zoneArmour);
}

/**
 * The route the army plans along for the player: from the city centre's side to where the player
 * stands (its end), so the battle model rings them ("downtown": the end of the route) and units come
 * in from the city. Kept at least `min` m long; rewritten in place as the player moves.
 */
export function playerPath(out: PathView & { start: { x: number; z: number }; end: { x: number; z: number } }, cx: number, cz: number, px: number, pz: number, min = 1000): void {
  let dx = px - cx, dz = pz - cz;
  const l = Math.hypot(dx, dz);
  if (l < 1) { dx = 1; dz = 0; } else { dx /= l; dz /= l; }
  const L = Math.max(min, l);
  const sx = px - dx * L, sz = pz - dz * L;
  out.pts.length = 0; out.pts.push(sx, sz, px, pz);
  out.s.length = 0; out.s.push(0, L);
  out.length = L;
  out.start.x = sx; out.start.z = sz;
  out.end.x = px; out.end.z = pz;
}

/** Where the army's units come from for the player: `dist` m from them on the city's side, spread round it. */
export function playerSpawn(cx: number, cz: number, px: number, pz: number, k: number, dist = RAMPAGE.spawnR): { x: number; z: number } {
  const base = Math.hypot(cx - px, cz - pz) < 1 ? 0 : Math.atan2(cz - pz, cx - px);
  const a = base + ((k * 2.399) % 1.8) - 0.9;
  return { x: px + Math.cos(a) * dist, z: pz + Math.sin(a) * dist };
}

// ================================================================== the headless check

export interface PlayerBattleResult {
  /** Seconds until a passive player's health was gone (−1: never within the run). */
  koT: number;
  /** Army damage points after armour, by kind; volleys fired. */
  dealtBy: Record<string, number>;
  fired: number;
  /** Ground units holding: the nearest and farthest from the player (m). */
  nearest: number; farthest: number;
  /** Ground units that were holding near the player after it walked away (its last position). */
  followed: number;
  /** Damage the ground units (rifles, APCs, tanks) did in the second half of the run (the walk, with `walk`). */
  late: number;
  peak: Record<string, number>;
  hash: number;
}

/**
 * The battle model against a giant player: levels 3 and (after `l4At` s) 4 arrive from the city's
 * side; the player stands at (0, 0) — or, with `walk`, walks away at that speed (m/s) for the
 * second half of the run. Deterministic per seed.
 */
export function simulatePlayerBattle(seed: number, opts: { maxT?: number; dt?: number; l4At?: number; height?: number; walk?: number; hp?: number } = {}): PlayerBattleResult {
  const rng = new Rng(seed);
  const dt = opts.dt ?? 0.5, maxT = opts.maxT ?? 400, l4At = opts.l4At ?? 55, height = opts.height ?? 20;
  const fire = rng.fork('fire');
  const cx = -1500, cz = 300;
  const P = { x: 0, z: 0 };
  let hp = opts.hp ?? RAMPAGE.hp;
  const zones = PLAYER_ZONES.map((z) => ({ id: z.id, armour: z.armour, weak: false, exposed: false }));
  const dealtBy: Record<string, number> = {};
  const peak: Record<string, number> = {};
  let fired = 0, hash = 2166136261, koT = -1, late = 0;
  const path = { pts: [] as number[], s: [] as number[], length: 0, start: { x: 0, z: 0 }, end: { x: 0, z: 0 } };
  playerPath(path, cx, cz, P.x, P.z);
  const view: MonsterView = {
    get x() { return P.x; }, get z() { return P.z; }, get s() { return path.length; }, mode: 'rampage', zones,
    get head() { return { x: P.x, z: P.z, y: height * 0.9 }; },
    damage(z: ZoneView, amount: number) { const d = playerDamage(z.armour, amount); hp = Math.max(0, hp - d); return d; },
  };
  const squads: Squad[] = [];
  const spawn = (k: number) => playerSpawn(cx, cz, P.x, P.z, k);
  squads.push(...levelSquads(3, spawn));
  let l4 = false;
  let t = 0;
  for (t = 0; t < maxT; t += dt) {
    if (!l4 && t >= l4At) { l4 = true; squads.push(...levelSquads(4, spawn)); }
    if (opts.walk && t > maxT / 2) { P.x += opts.walk * dt; playerPath(path, cx, cz, P.x, P.z); }
    regroup(squads, view, RAMPAGE.regroupT);
    stepForces(squads, view, path, dt, fire, (u, d) => { dealtBy[u.kind] = (dealtBy[u.kind] ?? 0) + d; if (t > maxT / 2 && (u.kind === 'rifles' || u.kind === 'apc' || u.kind === 'tank')) late += d; });
    if (hp <= 0 && koT < 0) { koT = t; if (!opts.walk) break; hp = opts.hp ?? RAMPAGE.hp; }
    const now: Record<string, number> = {};
    for (const q of squads) for (const u of q.units) if (u.task !== 'dead' && u.task !== 'leave') now[u.kind] = (now[u.kind] ?? 0) + (u.kind === 'rifles' ? u.crew : 1);
    for (const k in now) peak[k] = Math.max(peak[k] ?? 0, now[k]);
    hash = Math.imul(hash ^ Math.round(hp * 10), 16777619) >>> 0;
  }
  let nearest = Infinity, farthest = 0, followed = 0;
  for (const q of squads) {
    fired += q.fired;
    for (const u of q.units) {
      if (u.task !== 'hold' || u.mounted || u.kind === 'heli' || u.kind === 'jet' || u.kind === 'artillery') continue;
      const d = Math.hypot(u.x - P.x, u.z - P.z);
      nearest = Math.min(nearest, d); farthest = Math.max(farthest, d);
      if (d < (FORCE[u.kind].weapon?.range ?? 400)) followed++;
    }
  }
  return {
    koT, dealtBy: Object.fromEntries(Object.entries(dealtBy).map(([k, v]) => [k, Math.round(v)])), fired,
    nearest: Number.isFinite(nearest) ? Math.round(nearest) : -1, farthest: Math.round(farthest), followed, late: Math.round(late), peak, hash,
  };
}
