/**
 * A big monster's anger and the hero's credit (docs/CONVENTIONS.md "Threats"). The aggro table maps
 * who hurt it ('player', a squad or unit id) to how much, decaying over time; everything that reads it
 * or decides who stopped a threat goes through here, so the monsters agree.
 */
import type { Cause } from '../Stimuli';

export type AggroTable = Map<string, number>;

export function bookAggro(m: AggroTable, key: string, amount: number): void {
  m.set(key, (m.get(key) ?? 0) + amount);
}

/** Anger fades with time constant `tau` seconds; under 1 it is forgotten. */
export function decayAggro(m: AggroTable, dt: number, tau: number): void {
  const k = Math.exp(-dt / tau);
  for (const [key, v] of m) { const nv = v * k; if (nv < 1) m.delete(key); else m.set(key, nv); }
}

/** Whom it is angriest with (above `min`), or null. */
export function topAggro(m: ReadonlyMap<string, number>, min = 0): { key: string; v: number } | null {
  let best: { key: string; v: number } | null = null;
  for (const [key, v] of m) if (v > min && (!best || v > best.v)) best = { key, v };
  return best;
}

/** The hero earned the win: it was angriest with the hero, or the hero did at least `share` of all it remembers. */
export function heroEarned(m: ReadonlyMap<string, number>, share = 0.25): boolean {
  let tot = 0;
  for (const v of m.values()) tot += v;
  return tot > 0 && ((m.get('player') ?? 0) >= tot * share || topAggro(m)?.key === 'player');
}

/** Who brought a machine down: its last attacker if that blow was at most `window` seconds ago. */
export function lastHitBy(lastBy: Cause | null | undefined, lastT: number, now: number, window = 6): Cause | 'other' {
  return lastBy && now - lastT <= window ? lastBy : 'other';
}

/**
 * Damage through a zone's armour. An exposed weak spot ignores most of it (`weakArmour`) and multiplies
 * by `weakMul`; anything else loses its zone's armour share.
 */
export function zoneDealt(amount: number, armour: number, weak: boolean, weakMul: number, weakArmour = 0.05): number {
  return amount * (1 - (weak ? weakArmour : armour)) * (weak ? weakMul : 1);
}
