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
