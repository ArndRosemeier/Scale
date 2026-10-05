/**
 * Named bosses and notoriety (VILLAINS_PLAN §3.5, Phase 4 part 1). Every group has a boss with a
 * seeded name and a title of its kind (the gang's Kingpin, the Syndicate's Chairman, …), the group's
 * lieutenant powers and one of its own. The boss leads an operation now and then once the group
 * has noticed the hero, and stands at the hideout door when they are hunting them. Their record
 * is kept per city: beaten, escaped, jailed until a game hour (then a breakout).
 *
 * Notoriety (0..100) is how much a group has it in for the hero: it rises with every member
 * knocked out, every operation stopped, a stash busted, the boss beaten; it fades by itself each
 * game hour. Never a manhunt — it shapes what the group does where it already operates:
 *
 *   wary (≥ NOTORIETY.wary)     more lieutenants on its operations, an extra guard at the hideout,
 *                               now and then the boss leads an operation
 *   hunted (≥ NOTORIETY.hunted) members stand and fight instead of running, the boss guards the
 *                               hideout
 *
 * A group whose boss is behind bars and whose stash was busted collapses: no operations until one
 * of the two is over. Pure (no DOM, no three.js); CrimeSystem applies it.
 */
import { Rng, deriveSeed } from '../../core/rng';
import type { VillainPower } from '../powers/Caster';
import type { ArchetypeId } from './archetypes';
import type { FactionMap } from './Factions';

export const NOTORIETY = {
  wary: 25, hunted: 60, max: 100,
  /** Gained for … */
  ko: 3, lieutenant: 6, boss: 15, stopped: 5, bust: 20, escaped: 10,
  /** Lost per game hour. */
  fade: 1.5,
  /** Lieutenant chance added while wary (and twice that while hunted); boss chance per operation. */
  ltBonus: 0.15, bossWary: 0.12, bossHunted: 0.25,
};

export const BOSS = {
  /** Over a lieutenant's (which is already ×1.8 / ×1.35 over a member). */
  hp: 1.7, strength: 1.2,
  /** Game hours behind bars after an arrest (and a little more each time). */
  jail: 72, jailMore: 24,
};

export interface BossKind { title: string; /** The boss's own power on top of the lieutenant's. */ power: VillainPower; first: string[]; last: string[] }

export const BOSS_KINDS: Record<ArchetypeId, BossKind> = {
  gang: { title: 'Kingpin', power: 'gust', first: ['Rook', 'Dice', 'Jax', 'Mags', 'Tiny', 'Vee', 'Knuckles', 'Rae'], last: ['Malone', 'Okafor', 'Rourke', 'Varga', 'Diaz', 'Kowalski', 'Brannigan'] },
  syndicate: { title: 'Chairman', power: 'bolt', first: ['Victor', 'Helena', 'Augustin', 'Marguerite', 'Silas', 'Ines', 'Conrad'], last: ['Gilt', 'Ashworth', 'Castellane', 'Morrow', 'Vance', 'Sterling', 'Holloway'] },
  techno: { title: 'Architect', power: 'stun', first: ['Nyx', 'Ada', 'Kade', 'Iris', 'Zero', 'Tamsin', 'Orrin'], last: ['Halden', 'Voss', 'Kerrigan', 'Lindqvist', 'Mercer', 'Ishikawa'] },
  cult: { title: 'High Invoker', power: 'quake', first: ['Mordecai', 'Sable', 'Ezra', 'Lilith', 'Caspian', 'Wren', 'Thaddeus'], last: ['Vale', 'Ashgrove', 'Thorne', 'Blackwood', 'Crane', 'Mourne'] },
};

export interface Boss {
  faction: number;
  name: string;
  /** Behind bars until this game hour (absolute; -1: free). */
  jailedUntil: number;
  /** Times the hero beat them (a KO), they got away, they were jailed. */
  beaten: number;
  escapes: number;
  jailed: number;
}

/** One boss per group, seeded by the city and the group's kind (the same city, the same bosses). */
export function planBosses(F: FactionMap, seed: number): Boss[] {
  return F.factions.map((f) => {
    const K = BOSS_KINDS[f.archetype], r = new Rng(deriveSeed(seed, 'boss', f.archetype));
    return { faction: f.id, name: `${r.pick(K.first)} ${r.pick(K.last)}`, jailedUntil: -1, beaten: 0, escapes: 0, jailed: 0 };
  });
}

/** "Rook Malone, the Kingpin". */
export function bossLabel(F: FactionMap, b: Boss): string {
  return `${b.name}, the ${BOSS_KINDS[F.factions[b.faction].archetype].title}`;
}

/** The boss's powers: the group's lieutenant set and the boss's own. */
export function bossPowers(lt: readonly VillainPower[], arch: ArchetypeId): VillainPower[] {
  const p = BOSS_KINDS[arch].power;
  return lt.includes(p) ? [...lt] : [...lt, p];
}

export type Heat = 'calm' | 'wary' | 'hunted';

export function heatOf(n: number): Heat {
  return n >= NOTORIETY.hunted ? 'hunted' : n >= NOTORIETY.wary ? 'wary' : 'calm';
}

/** Notoriety up (clamped); returns the heat it crossed into, or null. */
export function raise(not: number[], f: number, n: number): Heat | null {
  if (f < 0 || f >= not.length) return null;
  const before = heatOf(not[f]);
  not[f] = Math.max(0, Math.min(NOTORIETY.max, not[f] + n));
  const after = heatOf(not[f]);
  return after !== before && n > 0 ? after : null;
}

/** Game hours passed: notoriety fades. */
export function fade(not: number[], hours: number): void {
  for (let i = 0; i < not.length; i++) not[i] = Math.max(0, not[i] - NOTORIETY.fade * hours);
}

/** Lieutenant chance for an operation with the group's heat. */
export function ltChance(base: number, n: number): number {
  const h = heatOf(n);
  return Math.min(0.95, base + (h === 'hunted' ? 2 : h === 'wary' ? 1 : 0) * NOTORIETY.ltBonus);
}

/** Chance the boss leads an operation (free and the group wary of the hero). */
export function bossChance(b: Boss | undefined, n: number, now: number): number {
  if (!b || b.jailedUntil > now) return 0;
  const h = heatOf(n);
  return h === 'hunted' ? NOTORIETY.bossHunted : h === 'wary' ? NOTORIETY.bossWary : 0;
}

/** Arrested: behind bars a while (longer each time). Returns the hour they come out. */
export function jail(b: Boss, now: number): number {
  b.jailed++;
  b.jailedUntil = now + BOSS.jail + BOSS.jailMore * (b.jailed - 1);
  return b.jailedUntil;
}

export interface SavedBoss { archetype: string; name: string; jailedUntil: number; beaten: number; escapes: number; jailed: number; notoriety: number }

export function saveBosses(F: FactionMap, bosses: readonly Boss[], not: readonly number[]): SavedBoss[] {
  return bosses.map((b) => ({ archetype: F.factions[b.faction].archetype, name: b.name, jailedUntil: b.jailedUntil, beaten: b.beaten, escapes: b.escapes, jailed: b.jailed, notoriety: Math.round(not[b.faction] ?? 0) }));
}

/** Put saved records back (matched by group kind; unknown or broken entries are skipped). */
export function restoreBosses(F: FactionMap, bosses: Boss[], not: number[], raw: unknown): void {
  if (!Array.isArray(raw)) return;
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Partial<SavedBoss>;
    const f = F.factions.find((x) => x.archetype === o.archetype);
    const b = f ? bosses[f.id] : undefined;
    if (!f || !b) continue;
    b.jailedUntil = n(o.jailedUntil, -1);
    b.beaten = Math.max(0, Math.round(n(o.beaten, 0)));
    b.escapes = Math.max(0, Math.round(n(o.escapes, 0)));
    b.jailed = Math.max(0, Math.round(n(o.jailed, 0)));
    not[f.id] = Math.max(0, Math.min(NOTORIETY.max, n(o.notoriety, 0)));
  }
}
