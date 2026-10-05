/**
 * Crime director (PLAYGROUND_PLAN §2.1, decision 6). Every 4 s of play it rolls the "crime weather"
 * for the player's district: a slot roll `deriveSeed(seed, 'crime', day, hour, slot, cell)` against
 * the district's rate (CrimeIndex.crimesPerMinute: index × hour × setting) decides whether a crime
 * starts now and which kind; the same seed, day, hour and district give the same rolls. Where it
 * happens and how it ends is live (real passers-by, the player). Sites lie in a ring 120–450 m
 * around the player, never on top of them.
 *
 * Villain groups (VILLAINS_PLAN §3.2): where a group holds the player's cell, its archetype weights
 * the kinds (the gang mugs, the Syndicate robs); cells nobody holds keep the district's own mix.
 *
 * Pacing: at most `SETTING_MAX` crimes at once (budget 3), a cooldown after each one ends, and a
 * minimum gap between starts. The roll's seed seeds the crime's own Rng.
 */
import { deriveSeed, hashToFloat, hash32 } from '../../core/rng';
import type { District } from '../../plan/types';
import { crimesPerMinute, SETTING_MAX, type CrimeSetting } from './CrimeIndex';
import { GROUP_KINDS, type CrimeKind } from './Crime';

export const DIRECTOR = { tick: 4, cooldown: { off: 0, calm: 60, normal: 25, chaos: 6 } as Record<CrimeSetting, number>, minGap: 20 };

export interface CrimeRoll { slot: number; kind: CrimeKind; seed: number }

/** Relative weights of the kinds in a district at an hour. */
export function kindWeights(d: District, hour: number): Record<CrimeKind, number> {
  const h = ((hour % 24) + 24) % 24;
  const night = h >= 21 || h < 5;
  const evening = h >= 18 && h < 21;
  const shopsOpen = h >= 8 && h < 22;
  const busy = d === 'downtown' || d === 'commercial' || d === 'oldtown';
  const rough = d === 'industrial' || d === 'port' || d === 'apartments' || d === 'park';
  return {
    snatch: (busy ? 1.4 : 0.8) * (night ? 0.35 : 1),
    mugging: (rough ? 1.2 : 0.5) * (night ? 2.5 : evening ? 1.4 : 0.6),
    robbery: shopsOpen ? (busy ? 0.55 : d === 'apartments' || d === 'rowhouses' ? 0.35 : 0.2) : 0.08,
    // Group operations (only where a group holds the cell, see groupWeights).
    racket: shopsOpen ? (busy || d === 'apartments' || d === 'rowhouses' ? 0.5 : 0.3) : 0.04,
    tagging: (night ? 0.7 : evening ? 0.5 : 0.25) * (rough ? 1.2 : 0.8),
    // Rare: a madman with a bag of bombs where the crowds are.
    bomber: busy ? 0.09 : 0.05,
  };
}

/**
 * The district's mix weighted by a group's operations; in nobody's turf (null) the group-only kinds
 * (racket, tagging) drop out and the rest stays as it is.
 */
export function groupWeights(w: Record<CrimeKind, number>, ops: Record<CrimeKind, number> | null): Record<CrimeKind, number> {
  const out = { ...w };
  if (!ops) { for (const k of GROUP_KINDS) out[k] = 0; return out; }
  for (const k of Object.keys(out) as CrimeKind[]) out[k] *= ops[k] ?? 1;
  return out;
}

/** Pick a kind from a [0, 1) number by weight. */
export function pickKind(w: Record<CrimeKind, number>, u: number): CrimeKind {
  const ks = Object.keys(w) as CrimeKind[];
  const total = ks.reduce((s, k) => s + w[k], 0);
  let t = u * total;
  for (const k of ks) { t -= w[k]; if (t < 0) return k; }
  return ks[ks.length - 1];
}

/**
 * One slot's roll (pure): a crime of a kind with a seed, or null. `slot` counts director ticks
 * within the game hour.
 */
export function rollSlot(seed: number, day: number, hour: number, slot: number, cell: number, index: number, district: District, setting: CrimeSetting, ops: Record<CrimeKind, number> | null = null): CrimeRoll | null {
  const h = deriveSeed(seed, 'crime', day, Math.floor(hour), slot, cell);
  const p = crimesPerMinute(index, district, hour, setting) * (DIRECTOR.tick / 60);
  if (hashToFloat(h) >= p) return null;
  return { slot, kind: pickKind(groupWeights(kindWeights(district, hour), ops), hashToFloat(hash32(h ^ 0x51f15e))), seed: hash32(h + 0x2545f491) };
}

/** Every roll of an hour for a district (headless test: same input → same list). */
export function planHour(seed: number, day: number, hour: number, cell: number, index: number, district: District, setting: CrimeSetting, slots = 45, ops: Record<CrimeKind, number> | null = null): CrimeRoll[] {
  const out: CrimeRoll[] = [];
  for (let s = 0; s < slots; s++) { const r = rollSlot(seed, day, hour + 0.5, s, cell, index, district, setting, ops); if (r) out.push(r); }
  return out;
}

export interface DirectorHost {
  /** Absolute game time in hours (day × 24 + hour). */
  hoursAbs(): number;
  /** Macro cell under the player, its district, crime index and the holding group's operations (null: outside the city). */
  playerCell(): { cell: number; district: District; index: number; ops?: Record<CrimeKind, number> | null } | null;
  activeCount(): number;
  /** Try to start a crime; false when no site fits right now. */
  start(roll: CrimeRoll): boolean;
}

export class CrimeDirector {
  setting: CrimeSetting = 'normal';
  private acc = 0;
  private hourKey = -1;
  private slot = 0;
  private cooldown = 30;
  private sinceStart = 999;
  /** Rolled but no site yet: retried for a few ticks. */
  private pending: { roll: CrimeRoll; tries: number } | null = null;
  /** Statistics (window.dev): rolls, starts, failed site searches, ms per tick. */
  stats = { ticks: 0, rolls: 0, started: 0, noSite: 0, ms: 0, last: '' };

  constructor(readonly seed: number, private host: DirectorHost) {}

  /** A crime ended: wait before the next one. */
  ended(): void { this.cooldown = Math.max(this.cooldown, DIRECTOR.cooldown[this.setting]); }

  update(dt: number): void {
    this.cooldown -= dt;
    this.sinceStart += dt;
    this.acc += dt;
    if (this.acc < DIRECTOR.tick) return;
    this.acc -= DIRECTOR.tick;
    const t0 = performance.now();
    this.tick();
    this.stats.ms = performance.now() - t0;
  }

  private tick(): void {
    this.stats.ticks++;
    const H = this.host;
    const abs = H.hoursAbs();
    const key = Math.floor(abs);
    if (key !== this.hourKey) { this.hourKey = key; this.slot = 0; }
    const slot = this.slot++;
    if (this.setting === 'off') { this.pending = null; return; }
    const cell = H.playerCell();
    if (!cell) return;
    const max = SETTING_MAX[this.setting];
    const room = H.activeCount() < max && this.cooldown <= 0 && this.sinceStart > DIRECTOR.minGap / (this.setting === 'chaos' ? 3 : 1);
    if (this.pending) {
      if (!room) return;
      if (H.start(this.pending.roll)) { this.began(this.pending.roll); this.pending = null; }
      else if (--this.pending.tries <= 0) { this.stats.noSite++; this.pending = null; }
      return;
    }
    const day = Math.floor(abs / 24), hour = abs - day * 24;
    const roll = rollSlot(this.seed, day, hour, slot, cell.cell, cell.index, cell.district, this.setting, cell.ops ?? null);
    if (!roll) return;
    this.stats.rolls++;
    if (!room) return;
    if (H.start(roll)) this.began(roll);
    else this.pending = { roll, tries: 3 };
  }

  private began(r: CrimeRoll): void {
    this.stats.started++;
    this.stats.last = r.kind;
    this.sinceStart = 0;
  }
}
