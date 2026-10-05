/**
 * Group uniforms (VILLAINS_PLAN §2, "Look"): members dress in their group's colours so they can be
 * recognised before they act. The gang: a cap in the group colour, a top or jacket in it, jeans and
 * sneakers. The Syndicate: dark suits, a shirt in the accent colour. Seeded per person (small shade
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
  const v = (primary: C3, secondary: C3, material = 'plain') => ({ shape: 'cloth', seed: r.nextU32(), primary, secondary, accent: A, material, glow: 0 });
  const dark: C3 = [0.06, 0.06, 0.07];
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
