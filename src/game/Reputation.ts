/**
 * Reputation (PLAYGROUND_PLAN §0 decision 4, §2.6): what the city thinks of the player, −100 … +100,
 * kept per city (seed, size) and mode in localStorage. Stopped crimes, returned property and small
 * kindnesses raise it; hurting bystanders, attacking the police and wrecking things in front of
 * witnesses lower it. It shapes the world rather than gating anything:
 *
 *   ≥ +30  people cheer when the player stops a crime, wave as they pass, film from closer
 *   ≤ −40  people step out of the player's way and flee when they come close
 *   ≤ −50  the police treat the player as a suspect: wanted at the first offence they see
 */
import type { GameMode } from './mode';

export const REP = {
  min: -100, max: 100,
  cheerAt: 30,
  fearAt: -40,
  suspectAt: -50,
};

export type RepListener = (delta: number, value: number, reason: string) => void;

export class Reputation {
  private v = 0;
  private readonly key: string;
  private listeners: RepListener[] = [];
  /** Statistics: crimes stopped, criminals knocked out, arrests, items returned, small deeds, bystanders hurt. */
  stats = { stopped: 0, kos: 0, arrests: 0, returned: 0, deeds: 0, hurt: 0, busted: 0 };

  constructor(seed: number, size: number, readonly mode: GameMode) {
    this.key = `scale.rep.v1.${mode}.${seed}.${size.toFixed(2)}`;
    try {
      const o = JSON.parse(localStorage.getItem(this.key) ?? 'null') as { v?: number; stats?: Partial<Reputation['stats']> } | null;
      if (o && Number.isFinite(o.v)) this.v = Math.max(REP.min, Math.min(REP.max, Number(o.v)));
      if (o?.stats) for (const k of Object.keys(this.stats) as (keyof Reputation['stats'])[]) this.stats[k] = Number(o.stats[k]) || 0;
    } catch { /* storage unavailable */ }
  }

  get value(): number { return this.v; }

  on(fn: RepListener): void { this.listeners.push(fn); }

  add(delta: number, reason: string): void {
    const before = this.v;
    this.v = Math.max(REP.min, Math.min(REP.max, Math.round((this.v + delta) * 10) / 10));
    const d = this.v - before;
    if (d === 0) return;
    this.save();
    for (const f of this.listeners) f(d, this.v, reason);
  }

  count(k: keyof Reputation['stats'], n = 1): void {
    this.stats[k] += n;
    this.save();
  }

  /** −1 (feared) … +1 (loved): crowd attitude. */
  get attitude(): number { return this.v / 100; }
  get cheers(): boolean { return this.v >= REP.cheerAt; }
  get feared(): boolean { return this.v <= REP.fearAt; }
  get suspect(): boolean { return this.v <= REP.suspectAt; }

  /** Short words for the HUD title / P screen. */
  label(): string {
    const v = this.v;
    return v >= 70 ? 'City hero' : v >= 35 ? 'Well liked' : v >= 10 ? 'Known for good deeds' : v > -10 ? 'Unknown' : v > -35 ? 'Troublemaker' : v > -70 ? 'Feared' : 'Public menace';
  }

  /** Saves: the value and the statistics. */
  serialize(): { v: number; stats: Reputation['stats'] } {
    return { v: this.v, stats: { ...this.stats } };
  }

  /** Saves: take a saved value (written back to the per-city store; no listeners fire). */
  restore(o: { v?: number; stats?: Partial<Record<string, number>> } | null): void {
    if (!o) return;
    if (Number.isFinite(o.v)) this.v = Math.max(REP.min, Math.min(REP.max, Number(o.v)));
    if (o.stats) for (const k of Object.keys(this.stats) as (keyof Reputation['stats'])[]) this.stats[k] = Number(o.stats[k]) || 0;
    this.save();
  }

  reset(): void {
    this.v = 0;
    for (const k of Object.keys(this.stats) as (keyof Reputation['stats'])[]) this.stats[k] = 0;
    this.save();
  }

  private save(): void {
    try { localStorage.setItem(this.key, JSON.stringify({ v: this.v, stats: this.stats })); } catch { /* storage unavailable */ }
  }
}
