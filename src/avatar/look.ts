/**
 * A created character: a configuration from the Actors character generator (body, face, skin,
 * hair, outfit and colours; plain JSON), stored in the browser and in saves, rebuilt identically.
 *
 * Characters saved by earlier versions (Scale's own appearance + outfit spec) are converted on
 * load (`normalizeLook`).
 */
import type { CharacterPatch } from '@actors/generator';
import type { HumanoidAppearance } from '../humanoid/types';
import type { EquipmentVisuals, ItemVisual } from '../items/types';
import { appearancePatch } from '../humanoid/actors/config';
import { dressPlan } from '../humanoid/actors/outfit';
import { randomAppearance } from '../humanoid/appearance';

export type RGB = [number, number, number];

export interface CharacterLook {
  /** The Actors character configuration (see @actors/generator CharacterConfig). */
  actor: CharacterPatch;
}

/** Outfit of a look saved before the Actors generator (garment ids and colours). */
interface LegacyOutfit {
  top: string; topColor: RGB; topColor2: RGB; topPattern: string;
  outer: string; outerColor: RGB; outerLeather: boolean;
  bottom: string; bottomColor: RGB;
  shoes: string; shoesColor: RGB;
  hat: string; hatColor: RGB;
  seed: number;
  underwear?: boolean;
  suit?: string; suitColor?: RGB; suitColor2?: RGB; suitDesign?: string;
  gloves?: string;
  mask?: string; maskColor?: RGB;
}

const LEGACY_DEFAULT: LegacyOutfit = {
  top: 'tshirt', topColor: [0.85, 0.85, 0.82], topColor2: [0.3, 0.3, 0.32], topPattern: 'plain', outer: 'none', outerColor: [0.2, 0.22, 0.3], outerLeather: false,
  bottom: 'jeans', bottomColor: [0.18, 0.25, 0.42], shoes: 'sneakers', shoesColor: [0.9, 0.9, 0.9], hat: 'none', hatColor: [0.12, 0.13, 0.16], seed: 1,
};

function vis(seed: number, primary: RGB, secondary: RGB, pattern = 'plain'): ItemVisual {
  return { shape: 'cloth', seed, primary, secondary, accent: secondary, material: pattern, glow: 0, glowColor: [0, 0, 0], wear: 0.15, style: 'human' };
}

/** A legacy outfit spec as the wardrobe's equipment (garment ids per slot). */
function legacyVisuals(o: LegacyOutfit): EquipmentVisuals {
  const s = o.seed >>> 0;
  const eq: EquipmentVisuals = {};
  if (o.top && o.top !== 'none') eq.chest = { defId: o.top, visual: vis(s, o.topColor, o.topColor2, o.topPattern) };
  if (o.top !== 'dress' && o.bottom && o.bottom !== 'none') eq.legs = { defId: o.bottom, visual: vis(s + 1, o.bottomColor, o.bottomColor) };
  if (o.outer && o.outer !== 'none') eq.back = { defId: o.outer, visual: vis(s + 2, o.outerColor, o.outerColor, o.outerLeather ? 'leather' : 'plain') };
  if (o.shoes && o.shoes !== 'none') eq.feet = { defId: o.shoes, visual: vis(s + 3, o.shoesColor, [1, 1, 1]) };
  if (o.hat === 'cap') eq.head = { defId: 'cap', visual: vis(s + 4, o.hatColor, o.hatColor) };
  if (o.suit === 'tights') {
    const c = o.suitColor ?? [0.12, 0.24, 0.62];
    eq.shoulders = { defId: 'tights', visual: vis(s + 6, c, o.suitColor2 ?? c) };
    if (o.gloves && o.gloves !== 'none') eq.hands = { defId: 'gloves', visual: vis(s + 7, o.gloves === 'accent' ? o.suitColor2 ?? c : c, c) };
  }
  if (o.underwear === false) eq.waist = { defId: 'no-underwear', visual: vis(s + 5, [0, 0, 0], [0, 0, 0]) };
  return eq;
}

/** A city person's appearance and outfit as a created look (e.g. the default hero, to edit in the creator). */
export function lookFromAppearance(app: HumanoidAppearance, eq: EquipmentVisuals | undefined): CharacterLook {
  const plan = dressPlan(eq, app.gender < 0.5, null);
  return { actor: { ...appearancePatch(app, null), skin: 'photo', outfit: plan.garments, garmentColors: plan.colors } };
}

/** A stored look in the current format (older records are converted; bad ones throw). */
export function normalizeLook(l: unknown): CharacterLook {
  const o = l as { actor?: CharacterPatch; appearance?: HumanoidAppearance; outfit?: LegacyOutfit } | null;
  if (o?.actor && typeof o.actor === 'object') return { actor: o.actor };
  if (o?.appearance && typeof o.appearance === 'object') {
    // Fields an old record lacks come from the person its seed describes.
    const a = o.appearance;
    const base = randomAppearance('human', a.seed ?? 1, { gender: a.gender });
    const app: HumanoidAppearance = { ...base, ...a, face: { ...base.face, ...a.face }, body: { ...base.body, ...a.body }, horns: { ...base.horns, ...a.horns }, tail: { ...base.tail, ...a.tail } };
    const outfit = o.outfit && typeof o.outfit === 'object' ? { ...LEGACY_DEFAULT, ...o.outfit } : null;
    return lookFromAppearance(app, outfit ? legacyVisuals(outfit) : undefined);
  }
  throw new Error('not a character look');
}
