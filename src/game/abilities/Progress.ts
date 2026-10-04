/**
 * The player's progression, persisted per city (seed, size) and mode in localStorage:
 * karma (earned by good deeds, spent on powers), power ranks, hotbar slots and
 * collected power cores. Sandbox keeps everything at max rank and only stores slots.
 *
 * Deeds report through `addKarma(amount, reason)` (negative amounts are the hook for
 * misdeeds later; they never take the balance below zero).
 */
import { ABILITIES, ABILITY, HOTBAR_SLOTS, LEGACY_IDS, type AbilityId } from './defs';
import { KARMA, KARMA_COST } from './tuning';
import type { GameMode } from '../mode';

export interface ProgressData {
  v: 1;
  karma: number;
  /** Lifetime karma earned (statistics). */
  earned: number;
  deeds: number;
  ranks: Partial<Record<AbilityId, number>>;
  slots: (AbilityId | null)[];
  /** Collected and discovered power core ids. */
  cores: number[];
  seen: number[];
  bonusMax: number;
  bonusRegen: number;
}

export type KarmaListener = (amount: number, reason: string, balance: number) => void;

/** v2: ten slots and the elemental roster (v1 held eight, with dash). */
const SANDBOX_SLOTS_KEY = 'scale.sandbox.slots.v2';
/** Super jump (Space) and flight (F) have their own keys, so the sandbox bar starts with the rest. */
const DEFAULT_SANDBOX_SLOTS: (AbilityId | null)[] = ['punch', 'speed', 'laser', 'lightning', 'fireWave', 'frostNova', 'icePath', 'stomp', 'gust', 'hydro'];

function fresh(): ProgressData {
  const slots: (AbilityId | null)[] = new Array(HOTBAR_SLOTS).fill(null);
  slots[0] = 'punch';
  return { v: 1, karma: KARMA.start, earned: 0, deeds: 0, ranks: {}, slots, cores: [], seen: [], bonusMax: 0, bonusRegen: 0 };
}

/** Punch used to be the left mouse button: hotbars saved before get it in the first free slot. */
function withPunch(slots: (AbilityId | null)[]): (AbilityId | null)[] {
  if (!slots.includes('punch')) {
    const free = slots.indexOf(null);
    if (free >= 0) slots[free] = 'punch';
  }
  return slots;
}

export class Progress {
  private d: ProgressData;
  private readonly key: string;
  private listeners: KarmaListener[] = [];
  /** Any change (ranks, slots, karma, cores): UI refresh. */
  onChange: (() => void)[] = [];

  constructor(readonly seed: number, readonly size: number, readonly mode: GameMode) {
    this.key = `scale.progress.v1.${seed}.${size.toFixed(2)}`;
    this.d = this.load();
  }

  get sandbox(): boolean { return this.mode === 'sandbox'; }
  get karma(): number { return this.d.karma; }
  get earned(): number { return this.d.earned; }
  get deeds(): number { return this.d.deeds; }
  get slots(): readonly (AbilityId | null)[] { return this.d.slots; }
  get bonusMax(): number { return this.d.bonusMax; }
  get bonusRegen(): number { return this.d.bonusRegen; }

  rank(id: AbilityId): number {
    // Robust for ids that are not (or no longer) abilities: an old save, a renamed power.
    const def = ABILITY[(LEGACY_IDS[id] ?? id) as AbilityId];
    if (!def) return 0;
    if (def.id === 'punch') return 1;
    const r = this.d.ranks[def.id];
    return this.sandbox ? (r ?? def.maxRank) : (r ?? 0);
  }
  unlocked(id: AbilityId): boolean { return this.rank(id) > 0; }

  onKarma(fn: KarmaListener): void { this.listeners.push(fn); }

  /** Award (or, later, deduct) karma for a deed. */
  addKarma(amount: number, reason: string): void {
    if (this.sandbox) return;
    amount = Math.round(amount);
    this.d.karma = Math.max(0, this.d.karma + amount);
    if (amount > 0) { this.d.earned += amount; this.d.deeds++; }
    this.save();
    for (const f of this.listeners) f(amount, reason, this.d.karma);
    this.changed();
  }

  /** Karma price of the next rank (null: maxed). */
  nextCost(id: AbilityId): number | null {
    const def = ABILITY[id];
    const r = this.rank(id);
    if (!def || r >= def.maxRank) return null;
    return KARMA_COST[id]?.[r] ?? null;
  }

  canBuy(id: AbilityId): boolean {
    const c = this.nextCost(id);
    return !this.sandbox && c !== null && this.d.karma >= c;
  }

  /** Spend karma on the next rank; a newly unlocked active goes to the first free slot. */
  buy(id: AbilityId): boolean {
    const c = this.nextCost(id);
    if (this.sandbox || c === null || this.d.karma < c) return false;
    this.d.karma -= c;
    const r = this.rank(id) + 1;
    this.d.ranks[id] = r;
    if (r === 1 && ABILITY[id].kind === 'active' && !this.d.slots.includes(id)) {
      const free = this.d.slots.indexOf(null);
      if (free >= 0) this.d.slots[free] = id;
    }
    this.save();
    this.changed();
    return true;
  }

  /** Sandbox: try any rank (0 … max). */
  setRank(id: AbilityId, r: number): void {
    if (!this.sandbox) return;
    if (!ABILITY[id]) return;
    this.d.ranks[id] = Math.max(0, Math.min(ABILITY[id].maxRank, r));
    this.changed();
  }

  assign(slot: number, id: AbilityId | null): void {
    if (slot < 0 || slot >= HOTBAR_SLOTS) return;
    if (id && ABILITY[id]?.kind !== 'active') return;
    // An ability lives in one slot at a time: move it (swap with what was there).
    const from = id ? this.d.slots.indexOf(id) : -1;
    if (from >= 0) this.d.slots[from] = this.d.slots[slot];
    this.d.slots[slot] = id;
    this.save();
    this.changed();
  }

  // ---- power cores
  hasCore(id: number): boolean { return this.d.cores.includes(id); }
  seenCore(id: number): boolean { return this.d.seen.includes(id); }
  markSeen(id: number): void {
    if (this.d.seen.includes(id)) return;
    this.d.seen.push(id);
    this.save();
  }
  collectCore(id: number, loot: { max?: number; regen?: number }): void {
    if (this.d.cores.includes(id)) return;
    this.d.cores.push(id);
    this.d.bonusMax += loot.max ?? 0;
    this.d.bonusRegen += loot.regen ?? 0;
    this.save();
    this.changed();
  }
  get coresCollected(): number { return this.d.cores.length; }

  /** Saves: a copy of the whole state. */
  serialize(): ProgressData {
    return JSON.parse(JSON.stringify(this.d)) as ProgressData;
  }

  /**
   * Saves: take a saved state (sanitised like a stored one) as the session's progress; it is
   * written back to the per-city store, so the city's progress follows the save that was loaded.
   */
  restore(o: unknown): void {
    const d = parseProgress(o);
    if (!d) return;
    // Sandbox ranks are only what was tried out (unset: max); the hotbar is the saved one.
    this.d = d;
    this.save();
    this.changed();
  }

  /** Normal: start over (karma, powers, cores). Sandbox: default ranks and hotbar. */
  reset(): void {
    this.d = fresh();
    if (this.sandbox) this.d.slots = DEFAULT_SANDBOX_SLOTS.slice();
    this.save();
    this.changed();
  }

  private changed(): void {
    for (const f of this.onChange) f();
  }

  private load(): ProgressData {
    const d = fresh();
    try {
      if (this.sandbox) {
        const s = JSON.parse(localStorage.getItem(SANDBOX_SLOTS_KEY) ?? 'null');
        d.slots = Array.isArray(s) ? withPunch(sanitizeSlots(s)) : DEFAULT_SANDBOX_SLOTS.slice();
        return d;
      }
      const raw = localStorage.getItem(this.key);
      if (!raw) return d;
      return parseProgress(JSON.parse(raw)) ?? d;
    } catch { return d; }
  }

  save(): void {
    try {
      if (this.sandbox) localStorage.setItem(SANDBOX_SLOTS_KEY, JSON.stringify(this.d.slots));
      else localStorage.setItem(this.key, JSON.stringify(this.d));
    } catch { /* storage unavailable */ }
  }
}

/** A stored / saved progress object, sanitised (null: not a progress object). */
function parseProgress(raw: unknown): ProgressData | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<ProgressData>;
  if (o.v !== 1) return null;
  const ranks: Partial<Record<AbilityId, number>> = {};
  for (const a of ABILITIES) {
    const r = Number(o.ranks?.[a.id] ?? 0);
    if (r > 0) ranks[a.id] = Math.min(a.maxRank, Math.floor(r));
  }
  // Powers that were folded into another (dash -> super speed): the rank carries over
  // (the higher one wins), so no karma that was spent is lost.
  for (const [old, now] of Object.entries(LEGACY_IDS)) {
    const r = Number((o.ranks as Record<string, number> | undefined)?.[old] ?? 0);
    if (r > 0) ranks[now] = Math.min(ABILITY[now].maxRank, Math.max(ranks[now] ?? 0, Math.floor(r)));
  }
  const nums = (a: unknown) => (Array.isArray(a) ? a.filter(Number.isFinite) : []);
  return {
    v: 1, karma: Math.max(0, Number(o.karma) || 0), earned: Number(o.earned) || 0, deeds: Number(o.deeds) || 0, ranks,
    slots: withPunch(sanitizeSlots(Array.isArray(o.slots) ? o.slots : [])), cores: nums(o.cores), seen: nums(o.seen),
    bonusMax: Number(o.bonusMax) || 0, bonusRegen: Number(o.bonusRegen) || 0,
  };
}

function sanitizeSlots(s: unknown[]): (AbilityId | null)[] {
  const out: (AbilityId | null)[] = new Array(HOTBAR_SLOTS).fill(null);
  for (let i = 0; i < HOTBAR_SLOTS; i++) {
    const id = (LEGACY_IDS[s[i] as string] ?? s[i]) as AbilityId;
    if (id && ABILITY[id]?.kind === 'active' && !out.includes(id)) out[i] = id;
  }
  return out;
}
