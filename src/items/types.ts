/**
 * Items, inventory and equipment model (shared by server & client).
 * Item *definitions* (bases) are static or generated per world; item
 * *instances* carry rolled properties (material, quality, affixes, visuals).
 */
import type { DamageType } from '../shared/types';

export type EquipSlot =
  | 'head' | 'face' | 'neck' | 'shoulders' | 'chest' | 'back' | 'wrists' | 'hands' | 'waist' | 'legs' | 'feet'
  | 'ring1' | 'ring2' | 'mainhand' | 'offhand' | 'trinket';

export const EQUIP_SLOTS: EquipSlot[] = [
  'head', 'face', 'neck', 'shoulders', 'chest', 'back', 'wrists', 'hands', 'waist', 'legs', 'feet', 'ring1', 'ring2', 'mainhand', 'offhand', 'trinket',
];

export type ItemCategory =
  | 'weapon' | 'armor' | 'clothing' | 'jewelry' | 'tool' | 'consumable' | 'material' | 'reagent' | 'food' | 'book' | 'key' | 'quest' | 'trinket' | 'ammo' | 'light';

/** Stat bonuses. Keys are stat ids defined by the gameplay module (e.g. "maxHp", "resist.fire", "skill.pyromancy"). */
export type StatMods = Record<string, number>;

export interface ItemAffix {
  id: string;
  /** Display, e.g. "of the Ember Fox" / "Gleaming". */
  name: string;
  prefix: boolean;
  mods: StatMods;
  /** Optional granted ability id (e.g. "ench.flame_strike"). */
  grants?: string;
}

/**
 * Visual description of an item, enough for any client to build its mesh or
 * clothing layer deterministically.
 */
export interface ItemVisual {
  /** Shape family, e.g. "sword.long", "axe.bearded", "helm.nasal", "robe.long", "boots.tall", "staff.gnarled". */
  shape: string;
  /** Seed for procedural detail. */
  seed: number;
  /** Primary/secondary/accent colors (sRGB 0..1). */
  primary: [number, number, number];
  secondary: [number, number, number];
  accent: [number, number, number];
  /** Material family for shading: metal, wood, leather, cloth, bone, crystal, chitin, fur, silk, stone, glass. */
  material: string;
  /** 0..1 emissive enchantment glow. */
  glow: number;
  glowColor: [number, number, number];
  /** Wear/dirt 0..1. */
  wear: number;
  /** Cultural style hint ("human", "elf", "dwarf", ...) for ornament motifs. */
  style: string;
}

export interface ItemDef {
  id: string;
  name: string;
  category: ItemCategory;
  /** Allowed slots when equipped (empty = not equippable). */
  slots: EquipSlot[];
  /** Occupies both hands. */
  twoHanded?: boolean;
  weight: number;
  baseValue: number;
  stackable: boolean;
  maxStack: number;
  /** Weapon properties. */
  weapon?: {
    damage: number;
    type: DamageType;
    speed: number;
    reach: number;
    /** Governing skill id, e.g. "blades", "axes", "archery". */
    skill: string;
    ranged?: boolean;
  };
  armor?: { armor: number; coverage: number; /** heavy armor hinders casting & stealth */ heaviness: number };
  /** Tool use: mining, woodcutting, digging, fishing, etc. */
  tool?: { kind: 'pick' | 'axe' | 'shovel' | 'sickle' | 'rod' | 'hammer' | 'lockpick' | 'knife'; power: number };
  consumable?: { effects: { id: string; magnitude: number; duration: number }[] };
  light?: { radius: number; color: [number, number, number]; fuel?: number };
  baseMods?: StatMods;
  description: string;
  visual: Omit<ItemVisual, 'seed'> & { seed?: number };
  /** Skill requirement to use effectively. */
  requires?: Record<string, number>;
  tags?: string[];
  /** Which material class instances may be rolled in (metal, wood, leather, cloth, bone, stone, crystal, glass, gem). Absent = fixed material. */
  matClass?: MatClass;
  /** Default material id when none is rolled. */
  baseMaterial?: string;
  /** Base item tier 0..6 (rough power band; loot level ~ tier * 5). */
  tier?: number;
  /** Ammunition fired by this ranged weapon / ammunition kind of this item. */
  ammo?: 'arrow' | 'bolt' | 'stone';
  /** Books: lore text is generated; skill books grant XP once; recipe books teach a recipe. */
  book?: { kind: 'lore' | 'skill' | 'recipe' | 'journal'; skill?: string; recipe?: string };
  /** Consumables with charges (waterskin) are not used up; durability counts the charges. */
  charges?: number;
  /** Ability id usable while this item is equipped/used (scrolls cast it once). */
  ability?: string;
}

export type MatClass = 'metal' | 'wood' | 'leather' | 'cloth' | 'bone' | 'stone' | 'crystal' | 'glass' | 'gem';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'unique';

export interface ItemInstance {
  /** Unique id (server assigned). */
  uid: string;
  defId: string;
  count: number;
  /** Display name after affixes. */
  name: string;
  rarity: Rarity;
  /** 0..1 craftsmanship quality, scales stats. */
  quality: number;
  /** Material id ("iron", "steel", "mithril", "obsidian", "bone", "ironwood", ...). */
  material: string;
  affixes: ItemAffix[];
  /** Final stat mods (base + material + affixes), computed by the item system. */
  mods: StatMods;
  durability: number;
  maxDurability: number;
  visual: ItemVisual;
  /** Lore / flavour text, possibly generated. */
  lore?: string;
  /** Who made it / where it was found. */
  origin?: string;
  value: number;
  /** Item level the instance was rolled at (scales affix tiers). */
  level?: number;
  /** Final weapon stats after material, quality and affixes (melee/ranged/thrown weapons). */
  weapon?: { damage: number; type: import('../shared/types').DamageType; speed: number; reach: number; skill: string; ranged?: boolean };
  /** Final tool stats after material & quality. */
  tool?: { kind: NonNullable<ItemDef['tool']>['kind']; power: number };
  /** Free-form per-instance data (key target, book read flag, quest id, charges...). JSON-safe. */
  data?: Record<string, string | number | boolean>;
}

export interface Inventory {
  items: ItemInstance[];
  /** Carry capacity in weight units. */
  capacity: number;
  coins: number;
  /** Crafting recipes learned from recipe folios (ids from src/items/data/recipes.ts). */
  knownRecipes?: string[];
}

export type Equipment = Partial<Record<EquipSlot, ItemInstance>>;

/** What clients need to render someone's gear. */
export type EquipmentVisuals = Partial<Record<EquipSlot, { defId: string; visual: ItemVisual }>>;
