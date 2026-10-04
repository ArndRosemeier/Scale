/**
 * The war under the city (pure, saved): the Lumen hold the Murk back at the Front; the Murk, fed
 * by the Heart, keep pushing. It runs on game time whether or not anyone watches.
 *
 *  - `murk` (0..1): the Murk's strength — grows by the hour from the Heart (not while the Maw is
 *    down), falls with every Murk killed.
 *  - `lumen` (0..1): the Lumen's strength — regrows slowly, falls in lost raids, rises when
 *    captives come home.
 *  - `front` (0..1): where the line is. 0: the barricade holds; 0.5: the Murk hold the Front;
 *    1: they are in the Hall. It moves with the raids.
 *  - Raids every few hours: decided by strength alone when the player is elsewhere; fought out
 *    with agents (and the player) when they are there — `raid` is then live until it ends.
 *  - Breaking out: the Murk in the Hall and strong — now and then at night some come up into the
 *    city through the sewers (the game starts a threat event).
 *  - The Maw: brought down, it is gone for days, the Heart dims and the Murk's strength stops
 *    growing; then it grows again.
 */
export interface WarState {
  v: 1;
  murk: number;
  lumen: number;
  front: number;
  /** Game hours (absolute) of the last update, the next raid, the Maw's return (0: it is there). */
  at: number;
  nextRaid: number;
  mawBack: number;
  /** A raid being fought now (live agents): started at, how many Murk came, how many are left, Lumen lost. */
  raid: { t0: number; n: number; left: number; lost: number } | null;
  /** Lumen held in the Murk's pens (per pen). */
  captives: number[];
  /** Hours (absolute) when the Murk may next break out into the city. */
  nextBreach: number;
  /** Statistics: raids won / lost, Murk killed by the player, captives freed, Maw brought down. */
  stats: { won: number; lost: number; kills: number; freed: number; maw: number; breaches: number };
}

export const WAR = {
  /** Strength the Murk gain per game hour (from the Heart) and the Lumen regain. */
  murkGrow: 0.022, lumenGrow: 0.012,
  /** Hours between raids. */
  raidGap: [2.5, 5.5] as [number, number],
  /** Front shift of a raid won / lost (by the Murk). */
  push: 0.22, pushBack: 0.12,
  /** Strength a Murk killed takes off the Murk. */
  perKill: 0.006,
  /** The Maw stays down this many game hours (two days). */
  mawDown: 48,
  /** Breaking out: front and strength needed, hours between. */
  breachFront: 0.85, breachMurk: 0.62, breachGap: [10, 20] as [number, number],
  /** Most captives in a pen. */
  penMax: 5,
};

export function freshWar(at: number, pens: number, rnd: () => number = Math.random): WarState {
  return {
    v: 1, murk: 0.45, lumen: 0.7, front: 0.08, at, nextRaid: at + 1.5 + rnd() * 2, mawBack: 0, raid: null,
    captives: Array.from({ length: pens }, () => 2 + Math.floor(rnd() * 3)), nextBreach: at + 24, stats: { won: 0, lost: 0, kills: 0, freed: 0, maw: 0, breaches: 0 },
  };
}

export interface WarEvents {
  /** A raid starts (live: the game spawns raiders at the Throat and fights it out). */
  raid?(live: boolean): void;
  /** A raid decided off-screen: who won. */
  resolved?(murkWon: boolean): void;
  /** The Murk break out into the city. */
  breach?(): void;
  /** The Maw has re-formed. */
  mawBack?(): void;
}

/**
 * Advance the war to game hour `now`. `live`: the player is near the Front (raids are fought out
 * by agents and end through `endRaid`); `night`: breakouts happen at night.
 */
export function stepWar(w: WarState, now: number, live: boolean, night: boolean, ev: WarEvents = {}, rnd: () => number = Math.random): void {
  // Long gaps (a loaded save, time skipped) are stepped an hour at a time.
  let guard = 0;
  while (w.at < now && guard++ < 24 * 30) {
    const h = Math.min(1, now - w.at);
    w.at += h;
    const mawDown = w.mawBack > w.at;
    if (!mawDown && w.mawBack > 0) { w.mawBack = 0; ev.mawBack?.(); }
    w.murk = clamp01(w.murk + (mawDown ? -0.01 : WAR.murkGrow) * h);
    w.lumen = clamp01(w.lumen + WAR.lumenGrow * h * (1 - w.front * 0.5));
    // The line drifts back towards the barricade while the Lumen are the stronger.
    if (w.lumen > w.murk) w.front = clamp01(w.front - 0.01 * h);
    if (w.raid) continue;
    if (w.at >= w.nextRaid) {
      w.nextRaid = w.at + WAR.raidGap[0] + rnd() * (WAR.raidGap[1] - WAR.raidGap[0]);
      if (mawDown && rnd() < 0.6) continue;
      if (live && w.at >= now - 1) {
        const n = raidSize(w);
        w.raid = { t0: w.at, n, left: n, lost: 0 };
        ev.raid?.(true);
      } else {
        // Decided by strength: the stronger usually wins.
        const p = w.murk * (0.8 + w.front * 0.4) / (w.murk + w.lumen + 1e-6);
        const murkWon = rnd() < p;
        applyOutcome(w, murkWon, rnd);
        ev.resolved?.(murkWon);
      }
    }
    if (night && w.front >= WAR.breachFront && w.murk >= WAR.breachMurk && w.at >= w.nextBreach && w.at >= now - 1) {
      w.nextBreach = w.at + WAR.breachGap[0] + rnd() * (WAR.breachGap[1] - WAR.breachGap[0]);
      w.stats.breaches++;
      ev.breach?.();
    }
  }
}

/** How many raiders come: more as the Murk grow. */
export function raidSize(w: WarState): number {
  return Math.round(4 + w.murk * 9);
}

function applyOutcome(w: WarState, murkWon: boolean, rnd: () => number): void {
  if (murkWon) {
    w.front = clamp01(w.front + WAR.push);
    w.lumen = clamp01(w.lumen - 0.12);
    w.stats.lost++;
    // Lumen taken: into the pens.
    for (let i = 0; i < 2 && w.captives.length; i++) {
      const p = Math.floor(rnd() * w.captives.length);
      w.captives[p] = Math.min(WAR.penMax, w.captives[p] + 1);
    }
  } else {
    w.front = clamp01(w.front - WAR.pushBack);
    w.murk = clamp01(w.murk - 0.05);
    w.stats.won++;
  }
}

/** A live raid: one raider down (by anyone). */
export function raiderDown(w: WarState, byPlayer: boolean): void {
  if (w.raid) w.raid.left = Math.max(0, w.raid.left - 1);
  w.murk = clamp01(w.murk - WAR.perKill);
  if (byPlayer) w.stats.kills++;
}

/** Any other Murk killed (in the Warrens, the Heart's guard). */
export function murkDown(w: WarState, byPlayer: boolean): void {
  w.murk = clamp01(w.murk - WAR.perKill * 0.6);
  if (byPlayer) w.stats.kills++;
}

/** A live raid ends: Murk won (they broke through: some got past the line) or not. */
export function endRaid(w: WarState, murkWon: boolean, rnd: () => number = Math.random): void {
  if (!w.raid) return;
  w.raid = null;
  applyOutcome(w, murkWon, rnd);
}

/** A pen broken open: its captives go home. Returns how many. */
export function freePen(w: WarState, pen: number): number {
  const n = w.captives[pen] ?? 0;
  if (!n) return 0;
  w.captives[pen] = 0;
  w.lumen = clamp01(w.lumen + 0.04 * n);
  w.stats.freed += n;
  return n;
}

/** The Maw brought down. */
export function mawDown(w: WarState): void {
  w.mawBack = w.at + WAR.mawDown;
  w.murk = clamp01(w.murk - 0.35);
  w.front = clamp01(w.front - 0.4);
  w.stats.maw++;
}

/** Saves: a sanitised copy (null: not a war state). */
export function parseWar(o: unknown, pens: number, at: number): WarState | null {
  if (!o || typeof o !== 'object') return null;
  const s = o as Partial<WarState>;
  if (s.v !== 1) return null;
  const n = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const st = (s.stats ?? {}) as Partial<WarState['stats']>;
  const caps = Array.isArray(s.captives) ? s.captives.map((c) => Math.max(0, Math.min(WAR.penMax, Math.floor(n(c, 0))))) : [];
  while (caps.length < pens) caps.push(2);
  return {
    v: 1, murk: clamp01(n(s.murk, 0.45)), lumen: clamp01(n(s.lumen, 0.7)), front: clamp01(n(s.front, 0.08)),
    at: n(s.at, at), nextRaid: n(s.nextRaid, at + 2), mawBack: n(s.mawBack, 0), raid: null, captives: caps.slice(0, pens),
    nextBreach: n(s.nextBreach, at + 24),
    stats: { won: n(st.won, 0), lost: n(st.lost, 0), kills: n(st.kills, 0), freed: n(st.freed, 0), maw: n(st.maw, 0), breaches: n(st.breaches, 0) },
  };
}

function clamp01(v: number): number { return Math.max(0, Math.min(1, v)); }
