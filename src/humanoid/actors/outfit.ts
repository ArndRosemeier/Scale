/**
 * Scale's outfits (`EquipmentVisuals`: a garment id and colours per slot, from the city wardrobe,
 * factions, costumes and the hero's look) on Actors characters.
 *
 * Soft clothes become Actors garments (MakeHuman's CC0 wardrobe, fitted to every body),
 * recoloured to the outfit's colours. Everything else stays Scale's own: rigid pieces (caps,
 * helmets, masks, a sandwich board, the raised dead's bones) and held items hang on the rig's
 * sockets (see equipment.ts).
 */
import type { EquipmentVisuals, EquipSlot, ItemVisual } from '../../items/types';

export type RGB = [number, number, number];

/** sRGB 0..1 → "#rrggbb". */
export function hex(c: RGB): string {
  const h = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

/** What an outfit puts on an Actors character. */
export interface DressPlan {
  /** Actors garment ids. */
  garments: string[];
  /** Garment colours (sRGB hex) by garment id. */
  colors: Record<string, string>;
  /** Slots left for Scale's own pieces (rigid parts, held items, masks). */
  rest: EquipmentVisuals;
  /** The outfit had clothes of its own (else a look's own outfit stays on, e.g. the hero's). */
  soft: boolean;
}

const pick = <T>(list: T[], seed: number): T => list[(seed >>> 0) % list.length];

/** Soft garments Scale's wardrobe knows (the rest are rigid pieces or costumes). */
const SOFT = new Set(['tshirt', 'shirt', 'sweater', 'dress', 'jacket', 'coat', 'suitjacket', 'jeans', 'trousers', 'shorts', 'skirt', 'sneakers', 'shoes', 'boots', 'gloves', 'tights']);

/**
 * Turns an outfit into Actors garments. `female`: the body leans female (gender < 0.5) — some
 * garments come in a cut for each. `available`: garment ids the character may wear (its catalog;
 * null: any).
 */
export function dressPlan(eq: EquipmentVisuals | undefined, female: boolean, available: Set<string> | null): DressPlan {
  const has = (id: string) => !available || available.has(id);
  eq ??= {};
  const garments: string[] = [];
  const colors: Record<string, string> = {};
  const rest: EquipmentVisuals = {};
  const wear = (id: string | undefined, color?: RGB | null) => {
    if (!id || !has(id) || garments.includes(id)) return false;
    garments.push(id);
    if (color) colors[id] = hex(color);
    return true;
  };
  /** First available of several cuts. */
  const first = (ids: string[]) => ids.find(has);
  const item = (slot: EquipSlot) => eq![slot];
  let soft = false;
  for (const [slot, it] of Object.entries(eq) as [EquipSlot, { defId: string; visual: ItemVisual }][]) {
    if (it && !SOFT.has(it.defId)) rest[slot] = it;
    else if (it) soft = true;
  }
  const top = item('chest'), legs = item('legs'), back = item('back'), feet = item('feet'), head = item('head'), hands = item('hands');
  const v = (it: { visual: ItemVisual } | undefined) => it?.visual.primary ?? null;
  const seed = (it: { visual: ItemVisual } | undefined) => it?.visual.seed ?? 0;
  const bare = Object.values(eq).some((x) => x?.defId === 'no-underwear');
  let topDone = false, legsDone = false;

  // Suits and jacket outfits come as one garment (top and trousers).
  if (back?.defId === 'suitjacket') {
    const skirt = legs?.defId === 'skirt';
    const id = female ? first(skirt ? ['suit-female-2', 'suit-female'] : ['suit-female', 'suit-female-double']) : first([pick(['suit-tie', 'suit-3', 'suit-double', 'suit-bowtie'], seed(back)), 'suit-tie']);
    if (wear(id, v(back))) topDone = legsDone = true;
  } else if (back?.defId === 'jacket' && !female && (legs?.defId === 'jeans' || legs?.defId === 'trousers')) {
    // Leather or denim jacket over jeans (its own colours: one tint would dye the jeans too).
    if (wear(first(['jacket-jeans']))) topDone = legsDone = true;
  }
  if (!topDone && top?.defId === 'dress' && female) {
    if (wear(first([pick(['shift-dress', 'halter-knee', 'keyhole-dress', 'tiered-dress', 'halter-midi'], seed(top)), 'shift-dress']), v(top))) topDone = legsDone = true;
  }
  if (!topDone) {
    // A coat or jacket is the outermost top: Actors has no open outer layers, so it stands in for the top.
    const outer = back && (back.defId === 'coat' || back.defId === 'jacket') ? back : null;
    const t = outer ?? top;
    const id = !t ? undefined
      : outer ? first(outer.defId === 'coat' ? ['fisherman-sweater', 'longsleeve'] : ['longsleeve'])
      : t.defId === 'tshirt' ? first(female ? [pick(['fitted-tshirt', 'tshirt', 'tank-top'], seed(t)), 'tshirt'] : [pick(['tshirt', 'loose-tshirt', 'polo'], seed(t)), 'tshirt'])
      : t.defId === 'shirt' ? first([pick(['longsleeve', 'polo'], seed(t)), 'longsleeve'])
      : t.defId === 'sweater' ? first(['fisherman-sweater', 'longsleeve'])
      : t.defId === 'dress' ? first(['longsleeve'])
      : undefined;
    if (wear(id, v(t))) topDone = true;
  }
  if (!legsDone && legs) {
    const s = seed(legs);
    const id = legs.defId === 'jeans' ? first(['jeans', 'cargo-pants'])
      : legs.defId === 'trousers' ? first([pick(['wool-pants', 'cargo-pants'], s), 'wool-pants', 'jeans'])
      : legs.defId === 'shorts' ? first([pick(['shorts', 'denim-shorts'], s), 'shorts'])
      : legs.defId === 'skirt' ? first(female ? [pick(['skirt', 'skirt-mini', 'skirt-tiered', 'skirt-mini-2'], s), 'skirt'] : ['shorts'])
      : undefined;
    if (wear(id, v(legs))) legsDone = true;
  }
  if (feet) {
    const s = seed(feet);
    const id = feet.defId === 'sneakers' ? first([pick(['sneakers', 'canvas-sneakers', 'trainers'], s), 'sneakers'])
      : feet.defId === 'shoes' ? first(female ? [pick(['ballet-flats', 't-bar-shoes', 'black-shoes'], s), 'black-shoes'] : [pick(['leather-shoes', 'black-shoes'], s), 'leather-shoes'])
      : feet.defId === 'boots' ? first([pick(['work-boots', 'ankle-boots', 'biker-boots'], s), 'work-boots'])
      : undefined;
    if (wear(id, v(feet)) && !/flats|t-bar/.test(id!)) wear(first(['socks', 'low-socks']));
  }
  // Caps and helmets from the wardrobe when it has them (else Scale's own rigid ones stay in `rest`).
  if (head?.defId === 'cap' && wear(first(['newsboy-cap']), v(head))) delete rest.head;
  else if (head?.defId === 'helmet' && wear(first(['army-helmet', 'motorcycle-helmet']), v(head))) delete rest.head;
  if (hands?.defId === 'gloves') wear(first(['gloves-short']), v(hands));
  // Hero tights: under everything (Actors has hosiery, not a bodysuit; the arms take a long-sleeved top if nothing covers them).
  const suit = item('shoulders');
  if (suit?.defId === 'tights') {
    wear(first(['tights']), suit.visual.primary);
    if (!topDone) wear(first(['longsleeve']), suit.visual.primary);
  }
  if (!bare) {
    wear(first(['briefs']), null);
    if (female) wear(first(['bra']), null);
  }
  return { garments, colors, rest, soft };
}
