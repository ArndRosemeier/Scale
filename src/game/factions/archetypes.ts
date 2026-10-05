/**
 * Villain group archetypes (VILLAINS_PLAN §2). The archetypes are fixed; a city's groups get their
 * name, colours and emblem from the seed (factions/Factions.ts). Phase 1 brought the street gang and
 * the Syndicate; Phase 3 gives each its lieutenants with powers.
 *
 * Pure data: no three.js, usable in headless tests.
 */
import type { District } from '../../plan/types';
import type { CrimeKind } from '../crime/Crime';
import type { VillainPower } from '../powers/Caster';

export type ArchetypeId = 'gang' | 'syndicate';

type C3 = [number, number, number];

/** A colour scheme: `map` tints the turf and alerts; `primary` / `accent` dress the members. */
export interface Palette { name: string; map: string; primary: C3; accent: C3 }

export interface Archetype {
  id: ArchetypeId;
  /** What the target frame calls the group's kind when nothing else fits. */
  noun: string;
  /** How much the group wants a district (0: never holds it). */
  affinity: Record<District, number>;
  /** Turf favours rough cells (crime index) — or rich, dense ones. */
  rough: number;
  /** Home favours dense cells (the city's real centre over a downtown-zoned outskirt). */
  dense: number;
  /** Turf reach around its home, as a share of the city radius. */
  reach: number;
  /** The group's operations: today's crime kinds, weighted against the district's own mix. */
  kinds: Record<CrimeKind, number>;
  /** Archetypes it is at war with (turf brawls, pressure on shared borders); any other group: wary. */
  rivals: ArchetypeId[];
  /**
   * Its lieutenants (Phase 3): what they are called, their powers (powers/Caster), and the chance
   * that one leads an operation of a kind (one per operation; in a brawl, one per side at most).
   */
  lieutenant: { title: string; powers: VillainPower[]; chance: Partial<Record<CrimeKind, number>> };
  palettes: Palette[];
  emblems: string[];
  /** Name patterns: `{a}` and `{b}` are picked from `a` and `b`. */
  names: string[];
  a: string[];
  b: string[];
  /** Places by district for `{a}` (a gang from the docks calls itself after them). */
  places?: Partial<Record<District, string[]>>;
}

const none = { downtown: 0, commercial: 0, oldtown: 0, apartments: 0, rowhouses: 0, suburban: 0, industrial: 0, port: 0, park: 0, water: 0 } as Record<District, number>;

export const ARCHETYPES: Record<ArchetypeId, Archetype> = {
  gang: {
    id: 'gang',
    noun: 'Gang member',
    affinity: { ...none, apartments: 1, port: 0.95, rowhouses: 0.8, industrial: 0.6, park: 0.45, oldtown: 0.35, commercial: 0.15, suburban: 0.05 },
    rough: 1,
    dense: 0,
    reach: 0.42,
    kinds: { snatch: 1, mugging: 1.7, robbery: 0.8, racket: 1.6, tagging: 1.5, bomber: 1.5, brawl: 1.5, hideout: 0 },
    rivals: ['syndicate'],
    // The Brute: a shoulder charge and a stomp that splits the pavement.
    lieutenant: { title: 'Brute', powers: ['dash', 'quake'], chance: { brawl: 0.4, hideout: 0.6, racket: 0.25, mugging: 0.12, robbery: 0.2 } },
    palettes: [
      { name: 'red', map: '#e5484d', primary: [0.62, 0.08, 0.08], accent: [0.85, 0.12, 0.1] },
      { name: 'purple', map: '#9b5de5', primary: [0.32, 0.12, 0.5], accent: [0.55, 0.25, 0.85] },
      { name: 'teal', map: '#12b5a5', primary: [0.04, 0.42, 0.4], accent: [0.08, 0.7, 0.65] },
      { name: 'orange', map: '#f97316', primary: [0.8, 0.32, 0.04], accent: [0.95, 0.45, 0.08] },
    ],
    emblems: ['♛', '✖', '⚡', '☠', '♠'],
    names: ['the {a} {b}', 'the {a} {b}', '{a} {b}'],
    a: ['Eastside', 'Northside', 'Ninth Street', 'Low Road', 'Backstreet', 'Southside', 'Westend', 'Crosstown'],
    b: ['Kings', 'Vipers', 'Saints', 'Dogs', 'Crowns', 'Wolves', 'Jackals', 'Ravens'],
    places: { port: ['Harbour', 'Dockside', 'Pier'], industrial: ['Foundry', 'Rail Yard', 'Smokestack'], apartments: ['Tower Block', 'Estate', 'Blockside'] },
  },
  syndicate: {
    id: 'syndicate',
    noun: 'Syndicate',
    affinity: { ...none, downtown: 1, commercial: 0.9, oldtown: 0.45, port: 0.25, apartments: 0.1 },
    rough: -0.6,
    dense: 1.5,
    reach: 0.34,
    kinds: { snatch: 0.4, mugging: 0.35, robbery: 2.6, racket: 0, tagging: 0, bomber: 0, brawl: 0.6, hideout: 0 },
    rivals: ['gang'],
    // The Enforcer: gadgets — a stun grenade, a frost gun, a shield projector, smoke to get away in.
    lieutenant: { title: 'Enforcer', powers: ['stun', 'frost', 'shield', 'smoke'], chance: { robbery: 0.35, hideout: 0.6, brawl: 0.4, snatch: 0.05 } },
    palettes: [
      { name: 'gold', map: '#d4a72c', primary: [0.07, 0.07, 0.08], accent: [0.85, 0.66, 0.18] },
      { name: 'emerald', map: '#0f9d63', primary: [0.06, 0.08, 0.07], accent: [0.08, 0.55, 0.32] },
      { name: 'steel', map: '#3f6db3', primary: [0.08, 0.09, 0.12], accent: [0.32, 0.45, 0.68] },
    ],
    emblems: ['◆', '♦', '✦'],
    names: ['{a} & Co.', 'the {a} Syndicate', '{a} Holdings', 'the {a} Group'],
    a: ['Gilt', 'Argent', 'Sable', 'Marlow', 'Vance', 'Crane', 'Halcyon', 'Sterling', 'Ashgrove'],
    b: [],
  },
};

/** The archetypes a city gets in Phase 1, in seeding order. */
export const PHASE1: ArchetypeId[] = ['gang', 'syndicate'];
