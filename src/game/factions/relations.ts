/**
 * Factions and how they feel about each other (Arnd 2026-10-09, thread "faction system"): one table
 * for "who is hostile to whom", instead of every system deciding it on its own.
 *
 *   civilians   every ordinary person, the city's machines, cars and street props (its property)
 *   police, army  the city's forces: friendly to the civilians
 *   hero        the player (and the player's own rampaging giant body); sidekick: the hero's companion
 *   crooks      street criminals of no group; gang … necro: the city's villain groups (factions/archetypes)
 *   lumen, murk the slimes of the deep (always at war)
 *   wardens, teens  the aliens; monsters: the big threats; machines: robots, bots and drones gone rogue
 *
 * A relation is a number, `REL.min` … `REL.max` (the reputation scale): how `a` feels about `b`,
 * hostile at or below `REL.hostile`. Most are fixed for now; the number leaves room for relations that
 * move (Arnd: "better fine control for later"). A pair can be bound to a live value instead: the
 * civilians' feeling about the hero IS the reputation (Game binds it), unbounded above like it.
 *
 * Pure (no three.js), usable in headless tests. See docs/CONVENTIONS.md "Factions".
 */
import { ARCHETYPES, type ArchetypeId } from './archetypes';

export type FactionId =
  | 'civilians' | 'police' | 'army' | 'hero' | 'sidekick' | 'crooks' | ArchetypeId
  | 'lumen' | 'murk' | 'wardens' | 'teens' | 'monsters' | 'machines';

export const FACTIONS: readonly FactionId[] = [
  'civilians', 'police', 'army', 'hero', 'sidekick', 'crooks', ...(Object.keys(ARCHETYPES) as ArchetypeId[]),
  'lumen', 'murk', 'wardens', 'teens', 'monsters', 'machines',
];

export const REL = {
  min: -100, max: 100,
  /** At or below this, `a` is hostile to `b` (fights it on sight; the hero may hit it for free). */
  hostile: -50,
  /** The seeded values (`defaultRelations`). */
  ally: 100, friendly: 60, neutral: 0, wary: -30, rival: -80, enemy: -100,
};

export class Relations {
  private v = new Map<string, number>();
  private bound = new Map<string, () => number>();
  /** Relation for a pair nobody set. */
  fallback = REL.neutral;

  /** How `a` feels about `b` (a faction about itself: REL.max). */
  get(a: FactionId, b: FactionId): number {
    if (a === b) return REL.max;
    const k = a + '>' + b;
    const f = this.bound.get(k);
    return f ? f() : this.v.get(k) ?? this.fallback;
  }

  /** Is `a` hostile to `b`? */
  hostile(a: FactionId, b: FactionId): boolean {
    return this.get(a, b) <= REL.hostile;
  }

  /** Set how `a` feels about `b` (clamped to REL.min … REL.max). */
  set(a: FactionId, b: FactionId, v: number): void {
    this.v.set(a + '>' + b, Math.max(REL.min, Math.min(REL.max, v)));
  }

  /** Set both directions. */
  setBoth(a: FactionId, b: FactionId, v: number): void {
    this.set(a, b, v);
    this.set(b, a, v);
  }

  /** Move how `a` feels about `b` by `d` (a bound pair is moved by its owner, not here). */
  shift(a: FactionId, b: FactionId, d: number): void {
    this.set(a, b, this.get(a, b) + d);
  }

  /** Read `a`'s feeling about `b` from a live value (the reputation) instead of the table. */
  bind(a: FactionId, b: FactionId, read: () => number): void {
    this.bound.set(a + '>' + b, read);
  }
}

const VILLAINS = Object.keys(ARCHETYPES) as ArchetypeId[];

/** The seeded table: today's rules as numbers. */
export function defaultRelations(): Relations {
  const R = new Relations();
  const city: FactionId[] = ['civilians', 'police', 'army'];
  for (const a of city) for (const b of city) if (a !== b) R.set(a, b, REL.friendly);
  // The hero, the sidekick and the city like each other (the civilians' feeling about the hero is the
  // reputation once Game binds it; neutral until then).
  for (const c of city) { R.set('hero', c, REL.friendly); R.set('sidekick', c, REL.friendly); }
  R.set('police', 'hero', REL.friendly); R.set('army', 'hero', REL.friendly);
  R.setBoth('hero', 'sidekick', REL.ally);
  for (const c of city) R.set(c, 'sidekick', REL.friendly);
  // Everything that preys on the city, and the city's forces, are enemies of each other and of the hero.
  const preys: FactionId[] = ['crooks', ...VILLAINS, 'murk', 'monsters', 'machines'];
  for (const p of preys) for (const s of [...city, 'hero', 'sidekick'] as FactionId[]) R.setBoth(p, s, REL.enemy);
  // The beasts (monsters, the Murk, machines gone rogue) go for every person, crooks included, and the
  // crooks want nothing to do with them (they run: Crime.lookRound).
  const beasts: FactionId[] = ['murk', 'monsters', 'machines'];
  for (const b of beasts) for (const c of ['crooks', ...VILLAINS] as FactionId[]) R.setBoth(b, c, REL.enemy);
  // The villain groups: rivals at war (archetypes' `rivals`, either way round), the rest wary.
  for (const a of VILLAINS) for (const b of VILLAINS) {
    if (a === b) continue;
    const rival = ARCHETYPES[a].rivals.includes(b) || ARCHETYPES[b].rivals.includes(a);
    R.set(a, b, rival ? REL.rival : REL.wary);
  }
  // The slimes: Lumen and Murk at war forever; the Lumen shy of the hero (their own trust decides more).
  R.setBoth('lumen', 'murk', REL.enemy);
  R.setBoth('lumen', 'hero', REL.neutral);
  // The aliens: the Wardens never meddle; their runaway teens are fair game for the hero.
  for (const f of FACTIONS) if (f !== 'wardens') { R.set('wardens', f, REL.neutral); R.set(f, 'wardens', REL.neutral); }
  R.set('wardens', 'teens', REL.wary);
  R.setBoth('hero', 'teens', REL.rival);
  return R;
}

// ---------------------------------------------------------------------------------------------
// The hero's standings (phase 2): what every faction feels about the hero is read live from the
// system that already keeps it, so the table is the one place to ask. Nothing is stored twice.
//
//   civilians → hero   the reputation (−100 … open-ended above)
//   police → hero      wanted (or a rampage): hostile, the more the higher the level; a suspect
//                      (reputation ≤ −50): wary; else friendly
//   army → hero        a rampaging giant: hostile; else friendly
//   villain group → hero   its notoriety (Bosses.ts): hunted (60) is the hostile line
//   lumen → hero       the Lumen's trust (deep/Trust.ts, −100 … 100)
//   wardens → hero     their regard: each problem handed over is worth `REGARD_STEP`

/** Live readers of the hero's standings (Game supplies them; tests pass fakes). */
export interface HeroStandings {
  rep(): number;
  wanted(): number;
  /** Reputation at or below the police's suspect line. */
  suspect(): boolean;
  /** The army is fighting the hero's rampaging giant body. */
  rampage(): boolean;
  /** A villain group's notoriety (0 … 100), undefined: not in this city. */
  notoriety(group: ArchetypeId): number | undefined;
  lumenTrust(): number;
  wardenRegard(): number;
}

/** Notoriety at which a group hunts the hero (Bosses NOTORIETY.hunted): maps to REL.hostile. */
export const HUNTED_AT = 60;
/** Warden regard per problem handed over. */
export const REGARD_STEP = 10;

const clampRel = (v: number) => Math.max(REL.min, Math.min(REL.max, v));

/** The police's feeling about the hero. */
export function policeStanding(wanted: number, suspect: boolean, rampage: boolean): number {
  if (wanted > 0 || rampage) return clampRel(REL.hostile - 15 * Math.max(1, rampage ? 3 : wanted));
  return suspect ? REL.wary : REL.friendly;
}

/** The army's feeling about the hero. */
export function armyStanding(rampage: boolean): number {
  return rampage ? REL.min + 5 : REL.friendly;
}

/** A villain group's feeling about the hero from its notoriety: hunted is the hostile line. */
export function groupStanding(notoriety: number): number {
  return clampRel(-Math.max(0, notoriety) * -REL.hostile / HUNTED_AT);
}

/** The Wardens' feeling about the hero from their regard. */
export function wardenStanding(regard: number): number {
  return clampRel(regard * REGARD_STEP);
}

/** Bind every faction's feeling about the hero to the live standings. */
export function bindHero(R: Relations, s: HeroStandings): void {
  R.bind('civilians', 'hero', () => s.rep());
  R.bind('police', 'hero', () => policeStanding(s.wanted(), s.suspect(), s.rampage()));
  R.bind('army', 'hero', () => armyStanding(s.rampage()));
  for (const a of VILLAINS) {
    const seeded = R.get(a, 'hero');
    R.bind(a, 'hero', () => { const n = s.notoriety(a); return n === undefined ? seeded : groupStanding(n); });
  }
  R.bind('lumen', 'hero', () => clampRel(s.lumenTrust()));
  R.bind('wardens', 'hero', () => wardenStanding(s.wardenRegard()));
}

/** The table as rows (dev console): each faction's feeling about every other, rounded. */
export function relationTable(R: Relations, ids: readonly FactionId[] = FACTIONS): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const a of ids) { const row: Record<string, number> = {}; for (const b of ids) row[b] = Math.round(R.get(a, b)); out[a] = row; }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Phase 3: who runs from whom. A crew at work drops everything and scatters when a threat its
// faction is hostile to comes near (a monster, the Murk, a runaway saucer): the bigger it is, the
// farther off they go.

export const SCATTER = {
  /** Reach (m) at which a crew runs from a menace: `near` + `perHeight` × its height, at most `max`. */
  near: 18, perHeight: 3, max: 140,
  /** Seconds between looks round. */
  check: 0.5,
  /** Safe again (m beyond the reach) once out of sight; always this far (m). */
  clear: 40, far: 300,
  /** Not when it is this much farther above or below than its own height (the deep realm under a sewer den). */
  vertical: 20,
};

/** Something to run from: a threat body (ThreatActor). */
export interface Menace { x: number; y: number; z: number; height: number; faction?: FactionId; self?: boolean }

/** How close a menace of this height has to come before a crew runs. */
export function scatterReach(height: number): number {
  return Math.min(SCATTER.max, SCATTER.near + SCATTER.perHeight * Math.max(0, height));
}

/**
 * The nearest menace within its scatter reach of (x, z) that faction `from` is hostile to, or null.
 * `sameSide` (street vs underground) leaves out the ones on the other side of the ground.
 */
export function menaceNear(R: Relations, from: FactionId, x: number, y: number, z: number, list: Iterable<Menace>, sameSide?: (m: Menace) => boolean): Menace | null {
  let best: Menace | null = null, bd = Infinity;
  for (const m of list) {
    const d = Math.hypot(m.x - x, m.z - z);
    if (d > scatterReach(m.height) || d >= bd || Math.abs(m.y - y) > m.height + SCATTER.vertical) continue;
    if (!R.hostile(from, bodyFaction(m))) continue;
    if (sameSide && !sameSide(m)) continue;
    best = m; bd = d;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Threat bodies and events: whose side they are on.

/** A threat body's faction: the player's own (rampaging) body is the hero's, else its own, else a monster. */
export function bodyFaction(a: { readonly self?: boolean; readonly faction?: FactionId }): FactionId {
  return a.self ? 'hero' : a.faction ?? 'monsters';
}

/** A threat event's faction, from its bodies (none: a monster). */
export function eventFaction(ev: { readonly actors?: readonly { readonly self?: boolean; readonly faction?: FactionId }[] }): FactionId {
  const a = ev.actors?.[0];
  return a ? bodyFaction(a) : 'monsters';
}

// ---------------------------------------------------------------------------------------------
// Phase 4: relations between the villain groups move by themselves, once per game hour.
//
//   a feud deepens    each turf brawl between two groups (FEUD.brawl, both ways)
//   a common enemy    while both are hunting the hero, they draw together (FEUD.united a game hour):
//                     rivals can end up in a truce (no more brawls or border clashes) — against you
//   time heals        every game hour each pair moves FEUD.back of the way back to its seeded value
//                     (a truce wears off once they stop hunting you; an old feud cools)
//
// Saved with the villain groups (only the pairs that differ from the seeded table).

export const FEUD = { brawl: -8, united: 6, back: 0.05 };

/** A pair of groups that crossed the hostile line (`war`: now at war; else a truce). */
export interface GroupShift { a: ArchetypeId; b: ArchetypeId; war: boolean }

/** Both groups' feelings for each other move by `d` (clamped). */
export function feud(R: Relations, a: ArchetypeId, b: ArchetypeId, d: number): void {
  if (a === b) return;
  R.shift(a, b, d); R.shift(b, a, d);
}

/**
 * Game hours passing for the groups in this city: a common enemy draws them together, time pulls
 * every pair back to the seeded value. Returns the pairs that crossed the hostile line.
 */
export function driftGroups(R: Relations, base: Relations, groups: readonly ArchetypeId[], hunting: (a: ArchetypeId) => boolean, hours: number): GroupShift[] {
  const out: GroupShift[] = [];
  for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
    const a = groups[i], b = groups[j];
    const was = R.hostile(a, b) || R.hostile(b, a);
    const together = hunting(a) && hunting(b);
    for (let h = 0; h < hours; h++) for (const [x, y] of [[a, b], [b, a]] as const) {
      let v = R.get(x, y);
      v += (base.get(x, y) - v) * FEUD.back;
      if (together) v += FEUD.united;
      R.set(x, y, v);
    }
    const now = R.hostile(a, b) || R.hostile(b, a);
    if (now !== was) out.push({ a, b, war: now });
  }
  return out;
}

/** The group pairs whose feelings differ from the seeded table (a save). */
export function saveGroupRelations(R: Relations, base: Relations): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of VILLAINS) for (const b of VILLAINS) {
    if (a === b) continue;
    const v = R.get(a, b);
    if (Math.abs(v - base.get(a, b)) > 0.05) out[`${a}>${b}`] = Math.round(v * 10) / 10;
  }
  return out;
}

/** Put saved group feelings back (anything else, or null: the seeded table). */
export function restoreGroupRelations(R: Relations, base: Relations, raw: unknown): void {
  for (const a of VILLAINS) for (const b of VILLAINS) if (a !== b) R.set(a, b, base.get(a, b));
  if (!raw || typeof raw !== 'object') return;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const [a, b] = k.split('>') as [ArchetypeId, ArchetypeId];
    if (a !== b && VILLAINS.includes(a) && VILLAINS.includes(b) && typeof v === 'number' && Number.isFinite(v)) R.set(a, b, v);
  }
}
