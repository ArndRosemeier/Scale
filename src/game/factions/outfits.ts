/**
 * Group uniforms (VILLAINS_PLAN §2, "Look"): members dress in their group's colours so they can be
 * recognised before they act. The gang: a cap in the group colour, a top or jacket in it, jeans and
 * sneakers. The Syndicate: dark suits, a shirt in the accent colour. The techno-cult: grey work
 * clothes, boots and a helmet or beanie, a faintly lit seam in its colour. The elemental cult: long
 * dark coats like robes with glowing trim, a dark beanie for a hood. Seeded per person (small shade
 * variations), the same person always dressed the same.
 */
import { Rng } from '../../core/rng';
import type { EquipmentVisuals } from '../../items/types';
import type { Faction } from './Factions';

type C3 = [number, number, number];

const shade = (c: C3, k: number): C3 => [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];

export function factionOutfit(f: Faction, seed: number): EquipmentVisuals {
  const r = new Rng(seed ^ 0x6a7e);
  const P = f.palette.primary, A = f.palette.accent;
  const v = (primary: C3, secondary: C3, material = 'plain', glow = 0) => ({ shape: 'cloth', seed: r.nextU32(), primary, secondary, accent: A, material, glow, ...(glow ? { glowColor: A } : {}) });
  const dark: C3 = [0.06, 0.06, 0.07];
  if (f.archetype === 'techno') {
    const grey = shade(P, 0.8 + r.float() * 0.4);
    return {
      chest: { defId: r.chance(0.6) ? 'sweater' : 'tshirt', visual: v(r.chance(0.6) ? dark : shade(grey, 0.6), A) },
      back: { defId: 'jacket', visual: v(grey, A, r.chance(0.3) ? 'leather' : 'plain', 0.55) },
      legs: { defId: 'trousers', visual: v(shade(grey, 0.6), shade(grey, 0.6)) },
      feet: { defId: 'boots', visual: v(dark, dark) },
      head: { defId: r.chance(0.5) ? 'helmet' : 'beanie', visual: v(r.chance(0.5) ? shade(A, 0.8) : dark, A) },
    } as unknown as EquipmentVisuals;
  }
  if (f.archetype === 'cult') {
    const robe = shade(P, 0.8 + r.float() * 0.4);
    return {
      chest: { defId: 'sweater', visual: v(robe, robe) },
      back: { defId: 'coat', visual: v(robe, A, 'plain', 0.5) },
      legs: { defId: 'trousers', visual: v(robe, robe) },
      feet: { defId: r.chance(0.5) ? 'boots' : 'shoes', visual: v(dark, dark) },
      head: { defId: 'beanie', visual: v(shade(robe, 0.8), A) },
    } as unknown as EquipmentVisuals;
  }
  if (f.archetype === 'syndicate') {
    const suit = shade(P, 0.85 + r.float() * 0.3);
    return {
      chest: { defId: 'shirt', visual: v(r.chance(0.5) ? shade(A, 0.95) : [0.92, 0.92, 0.93], A) },
      back: { defId: 'suitjacket', visual: v(suit, suit) },
      legs: { defId: 'trousers', visual: v(suit, suit) },
      feet: { defId: 'shoes', visual: v(dark, dark) },
    } as unknown as EquipmentVisuals;
  }
  const denim: C3 = r.pick([[0.12, 0.16, 0.3], [0.08, 0.09, 0.12], [0.2, 0.24, 0.36]] as C3[]);
  const top = r.weighted(['tshirt', 'sweater'], (t) => (t === 'tshirt' ? 2 : 1));
  const jacket = r.chance(0.55);
  return {
    chest: { defId: top, visual: v(jacket ? r.pick([dark, [0.85, 0.85, 0.85]] as C3[]) : shade(P, 0.9 + r.float() * 0.25), A) },
    ...(jacket ? { back: { defId: 'jacket', visual: v(shade(P, 0.85 + r.float() * 0.3), dark, r.chance(0.3) ? 'leather' : 'plain') } } : {}),
    legs: { defId: 'jeans', visual: v(denim, denim) },
    feet: { defId: 'sneakers', visual: v(r.chance(0.5) ? A : [0.9, 0.9, 0.9], [1, 1, 1]) },
    head: { defId: r.chance(0.8) ? 'cap' : 'beanie', visual: v(A, P) },
  } as unknown as EquipmentVisuals;
}

/**
 * A lieutenant (Phase 3): the group's uniform with a glowing accent, so the one with powers stands
 * out of the crowd before they cast — the gang's Brute in a leather jacket, the Syndicate's
 * Enforcer with lit seams on the suit, the cults' Technomancer and Invoker brightly lit.
 */
export function lieutenantOutfit(f: Faction, seed: number): EquipmentVisuals {
  const o = factionOutfit(f, seed) as unknown as Record<string, { defId: string; visual: { primary: C3; secondary: C3; accent: C3; material: string; glow: number; glowColor?: C3 } }>;
  const A = f.palette.accent;
  if (f.archetype === 'techno' || f.archetype === 'cult') {
    o.back.visual = { ...o.back.visual, glow: 0.7, glowColor: A };
  } else if (f.archetype !== 'syndicate') {
    o.back = { defId: 'jacket', visual: { ...(o.chest.visual), primary: shade(f.palette.primary, 0.7), secondary: A, accent: A, material: 'leather', glow: 0.6, glowColor: A } };
  } else if (o.back) {
    o.back.visual = { ...o.back.visual, accent: A, glow: 0.6, glowColor: A };
  }
  o.chest.visual = { ...o.chest.visual, glow: 0.4, glowColor: A };
  return o as unknown as EquipmentVisuals;
}

/** A group's boss (Phase 4): the lieutenant's look, fully lit — the one everyone else makes way for. */
export function bossOutfit(f: Faction, seed: number): EquipmentVisuals {
  const o = lieutenantOutfit(f, seed) as unknown as Record<string, { defId: string; visual: { glow: number; glowColor?: C3 } }>;
  const A = f.palette.accent;
  for (const k of ['back', 'chest', 'head']) if (o[k]) o[k].visual = { ...o[k].visual, glow: k === 'back' ? 1 : 0.6, glowColor: A };
  return o as unknown as EquipmentVisuals;
}
