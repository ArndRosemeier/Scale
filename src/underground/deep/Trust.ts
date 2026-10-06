/**
 * What the Lumen think of the player (−100 … +100), kept per city (seed, size) and mode like the
 * city's reputation. It is earned slowly — patience, defending them, freeing their own — and lost
 * quickly by hurting them.
 *
 *   < −30  Shunned:   they flee and hide
 *   < 10   Stranger:  shy; they hide in their domes when the player comes close
 *   ≥ 10   Noticed:   they no longer hide; they keep their distance
 *   ≥ 30   Welcome:   they greet the player, children follow, the lift runs, glow pebbles
 *   ≥ 55   Ally:      Slime call (rank 1): they answer from the sewers
 *   ≥ 80   Kin:       Slime call rank 2 (more of them, longer), a mosaic of the player
 *   = 100  …and rank 3 when the Maw has been brought down at least once
 */
export const TRUST = { min: -100, max: 100, noticed: 10, welcome: 30, ally: 55, kin: 80 };

export type TrustTier = 'Shunned' | 'Stranger' | 'Noticed' | 'Welcome' | 'Ally' | 'Kin';

export type TrustListener = (delta: number, value: number, reason: string, tierUp: TrustTier | null) => void;

export interface TrustData {
  v: number;
  /** Colonies whose brave one gave the player a pebble (once each). */
  gifts: number[];
  /** Firsts already counted (met in the Glow, the Heart seen …). */
  marks: string[];
}

export function tierOf(v: number): TrustTier {
  return v >= TRUST.kin ? 'Kin' : v >= TRUST.ally ? 'Ally' : v >= TRUST.welcome ? 'Welcome' : v >= TRUST.noticed ? 'Noticed' : v > -30 ? 'Stranger' : 'Shunned';
}

/** Slime call rank the trust gives (the Maw brought down: rank 3 at full trust). */
export function callRank(v: number, mawDowned: boolean): number {
  return v >= 99.5 && mawDowned ? 3 : v >= TRUST.kin ? 2 : v >= TRUST.ally ? 1 : 0;
}

export class Trust {
  private d: TrustData = { v: 0, gifts: [], marks: [] };
  private readonly key: string;
  private listeners: TrustListener[] = [];

  constructor(seed: number, size: number, mode: string, private readonly sandbox = false) {
    this.key = `scale.lumen.v1.${mode}.${seed}.${size.toFixed(2)}`;
    try { this.d = parseTrust(JSON.parse(localStorage.getItem(this.key) ?? 'null')) ?? this.d; } catch { /* storage unavailable */ }
    if (sandbox) this.d.v = TRUST.max;
  }

  get value(): number { return this.d.v; }
  get tier(): TrustTier { return tierOf(this.d.v); }

  on(fn: TrustListener): void { this.listeners.push(fn); }

  add(delta: number, reason: string): void {
    if (this.sandbox) return;
    const before = this.d.v;
    this.d.v = Math.max(TRUST.min, Math.min(TRUST.max, Math.round((before + delta) * 10) / 10));
    const d = this.d.v - before;
    if (d === 0) return;
    this.save();
    const t0 = tierOf(before), t1 = tierOf(this.d.v);
    for (const f of this.listeners) f(d, this.d.v, reason, t1 !== t0 && d > 0 ? t1 : null);
  }

  /** Once-only things (returns true the first time). */
  mark(id: string): boolean {
    if (this.d.marks.includes(id)) return false;
    this.d.marks.push(id);
    this.save();
    return true;
  }
  has(id: string): boolean { return this.d.marks.includes(id); }

  gifted(colony: number): boolean { return this.d.gifts.includes(colony); }
  addGift(colony: number): void { if (!this.d.gifts.includes(colony)) { this.d.gifts.push(colony); this.save(); } }

  serialize(): TrustData { return JSON.parse(JSON.stringify(this.d)) as TrustData; }
  restore(o: unknown): void {
    const d = parseTrust(o);
    if (!d) return;
    this.d = d;
    if (this.sandbox) this.d.v = TRUST.max;
    this.save();
  }
  reset(): void { this.d = { v: this.sandbox ? TRUST.max : 0, gifts: [], marks: [] }; this.save(); }

  private save(): void {
    try { localStorage.setItem(this.key, JSON.stringify(this.d)); } catch { /* storage unavailable */ }
  }
}

export function parseTrust(o: unknown): TrustData | null {
  if (!o || typeof o !== 'object') return null;
  const s = o as Partial<TrustData>;
  const v = Number(s.v);
  if (!Number.isFinite(v)) return null;
  return {
    v: Math.max(TRUST.min, Math.min(TRUST.max, v)),
    gifts: Array.isArray(s.gifts) ? s.gifts.filter(Number.isFinite) : [],
    marks: Array.isArray(s.marks) ? s.marks.filter((m): m is string => typeof m === 'string') : [],
  };
}
