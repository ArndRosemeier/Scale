/**
 * A created character: a human appearance plus a city outfit, both plain JSON so they can
 * be stored in the browser and rebuilt identically. The outfit is a small editable spec
 * (garment ids + colours) that turns into the EquipmentVisuals the wardrobe renders.
 */
import type { HumanoidAppearance } from '../humanoid/types';
import type { EquipmentVisuals, ItemVisual } from '../items/types';
import { randomAppearance } from '../humanoid/appearance';
import { cityOutfit } from '../humanoid/client/wardrobe';
import { Rng } from '../core/rng';

export type RGB = [number, number, number];

export const TOPS = ['tshirt', 'shirt', 'sweater', 'dress'] as const;
export const OUTERS = ['none', 'jacket', 'suitjacket', 'coat'] as const;
export const BOTTOMS = ['jeans', 'trousers', 'shorts', 'skirt'] as const;
export const SHOES = ['sneakers', 'shoes', 'boots'] as const;
export const HATS = ['none', 'cap', 'beanie'] as const;
export const PATTERNS = ['plain', 'stripes', 'checks'] as const;

export interface OutfitSpec {
  top: (typeof TOPS)[number];
  topColor: RGB;
  /** Trim / pattern colour of the top. */
  topColor2: RGB;
  topPattern: string;
  outer: (typeof OUTERS)[number];
  outerColor: RGB;
  outerLeather: boolean;
  /** Ignored when the top is a dress. */
  bottom: (typeof BOTTOMS)[number];
  bottomColor: RGB;
  shoes: (typeof SHOES)[number];
  shoesColor: RGB;
  hat: (typeof HATS)[number];
  hatColor: RGB;
  /** Fine detail (skirt / dress length, sleeves). */
  seed: number;
}

export interface CharacterLook {
  appearance: HumanoidAppearance;
  outfit: OutfitSpec;
}

function vis(seed: number, primary: RGB, secondary: RGB, pattern = 'plain'): ItemVisual {
  return { shape: 'cloth', seed, primary, secondary, accent: secondary, material: pattern, glow: 0, glowColor: [0, 0, 0], wear: 0.15, style: 'human' };
}

/** Outfit spec → what the wardrobe renders. */
export function outfitVisuals(o: OutfitSpec): EquipmentVisuals {
  const s = o.seed >>> 0;
  const eq: EquipmentVisuals = {};
  eq.chest = { defId: o.top, visual: vis(s, o.topColor, o.topColor2, o.topPattern) };
  if (o.top !== 'dress') eq.legs = { defId: o.bottom, visual: vis(s + 1, o.bottomColor, o.bottomColor, 'plain') };
  if (o.outer !== 'none') eq.back = { defId: o.outer, visual: vis(s + 2, o.outerColor, o.outerColor.map((c) => c * 0.8) as RGB, o.outerLeather && o.outer === 'jacket' ? 'leather' : 'plain') };
  eq.feet = { defId: o.shoes, visual: vis(s + 3, o.shoesColor, [1, 1, 1]) };
  if (o.hat !== 'none') eq.head = { defId: o.hat, visual: vis(s + 4, o.hatColor, o.hatColor) };
  return eq;
}

/** Best-effort spec from generated visuals (cityOutfit), for Randomize. */
export function outfitFromVisuals(eq: EquipmentVisuals, seed: number): OutfitSpec {
  const pick = <T extends string>(list: readonly T[], v: string | undefined, d: T): T => (list.includes(v as T) ? (v as T) : d);
  const chest = eq.chest, legs = eq.legs, back = eq.back, feet = eq.feet, head = eq.head;
  const grey: RGB = [0.3, 0.3, 0.32];
  return {
    top: pick(TOPS, chest?.defId, 'tshirt'),
    topColor: chest?.visual.primary ?? [0.85, 0.85, 0.82],
    topColor2: chest?.visual.secondary ?? grey,
    topPattern: pick(PATTERNS, chest?.visual.material, 'plain'),
    outer: pick(OUTERS, back?.defId, 'none'),
    outerColor: back?.visual.primary ?? [0.2, 0.22, 0.3],
    outerLeather: back?.visual.material === 'leather',
    bottom: pick(BOTTOMS, legs?.defId, 'jeans'),
    bottomColor: legs?.visual.primary ?? [0.18, 0.25, 0.42],
    shoes: pick(SHOES, feet?.defId, 'sneakers'),
    shoesColor: feet?.visual.primary ?? [0.9, 0.9, 0.9],
    hat: pick(HATS, head?.defId, 'none'),
    hatColor: head?.visual.primary ?? [0.12, 0.13, 0.16],
    seed: seed >>> 0,
  };
}

/** A random adult human in everyday clothes (gender: 0 female … 1 male, random if omitted). */
export function randomLook(seed: number, gender?: number): CharacterLook {
  const r = new Rng(seed ^ 0x2c1b);
  const g = gender ?? (r.chance(0.5) ? r.range(0.02, 0.15) : r.range(0.85, 0.98));
  const appearance = randomAppearance('human', seed, { gender: g, age: r.range(0.45, 0.68) });
  const outfit = outfitFromVisuals(cityOutfit(seed, appearance.gender, appearance.age, r.range(0, 0.5), r.range(0, 0.6)), seed);
  return { appearance, outfit };
}

/** Fill fields that may be missing in a record saved by an older version. */
export function normalizeLook(l: CharacterLook): CharacterLook {
  const base = randomLook(l.appearance?.seed ?? 1, l.appearance?.gender);
  const a = { ...base.appearance, ...l.appearance };
  // (Cheeks, face width and expression came later: a character saved before keeps its face — 0, not a random value.)
  a.face = { ...base.appearance.face, cheekFullness: 0, faceWidth: 0, smile: 0, ...l.appearance?.face };
  a.body = { ...base.appearance.body, ...l.appearance?.body };
  return { appearance: a, outfit: { ...base.outfit, ...l.outfit } };
}
