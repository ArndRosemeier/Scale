/**
 * Race definitions and procedural appearance generation (used by NPC
 * spawning and the character creator).
 *
 * `randomAppearance(race, seed)` is fully deterministic: the same race + seed
 * always yields the same individual on every client and on the server. Every
 * aspect draws from its own forked RNG stream, so adding a new attribute
 * never changes existing individuals' other features.
 */
import { Rng, deriveSeed } from '../core/rng';
import type { HumanoidAppearance, RaceId } from './types';
import { RACE_IDS } from './types';
import { RACE_STYLES, type RGB, type RaceStyle } from './races';

export interface RaceDef {
  id: RaceId;
  name: string;
  plural: string;
  description: string;
  /** Typical lifespan (years) — used to map NPC ages. */
  lifespan: number;
  /** Starting skill bonuses. */
  skillBonus: Record<string, number>;
  /** Innate stat modifiers. */
  statMods: Record<string, number>;
  /** Age (years) at which the race reaches adulthood. */
  adultAge?: number;
  /** Typical adult height range in meters (for UI). */
  heightM?: [number, number];
  /** Innate traits shown in the character creator. */
  traits?: string[];
  /** Whether the race can be chosen by players. */
  playable?: boolean;
}

export const RACES: Record<RaceId, RaceDef> = {
  human: {
    id: 'human', name: 'Human', plural: 'Humans', lifespan: 80, adultAge: 18, heightM: [1.55, 1.95], playable: true,
    description: 'Adaptable and ambitious, humans settle every climate and trade with every people. What they lack in innate gifts they make up for with sheer versatility.',
    skillBonus: { trading: 5, persuasion: 5, blades: 3, crafting: 3 },
    statMods: { xpGain: 0.05, maxStamina: 5 },
    traits: ['Versatile: +5% experience', 'Quick learner'],
  },
  elf: {
    id: 'elf', name: 'Elf', plural: 'Elves', lifespan: 650, adultAge: 100, heightM: [1.7, 2.0], playable: true,
    description: 'Long-lived and graceful, elves remember the world before the cities. Keen senses and an old bond with the weave of magic make them peerless archers and enchanters.',
    skillBonus: { archery: 8, enchanting: 5, stealth: 4, herbalism: 3 },
    statMods: { maxMana: 15, maxHp: -5, perception: 2, 'resist.psychic': 0.1 },
    traits: ['Keen sight', 'Arcane affinity', 'Slender build'],
  },
  dwarf: {
    id: 'dwarf', name: 'Dwarf', plural: 'Dwarves', lifespan: 280, adultAge: 40, heightM: [1.25, 1.45], playable: true,
    description: 'Stout delvers of stone and metal. Dwarven clans measure wealth in craft and grudges alike; their smiths are legend and their stubbornness more so.',
    skillBonus: { smithing: 8, mining: 8, axes: 4, blunt: 3 },
    statMods: { maxHp: 15, carry: 20, 'resist.poison': 0.15, moveSpeed: -0.05, darkvision: 1 },
    traits: ['Stonesight', 'Poison resistance', 'Heavy lifter'],
  },
  orc: {
    id: 'orc', name: 'Orc', plural: 'Orcs', lifespan: 60, adultAge: 14, heightM: [1.8, 2.1], playable: true,
    description: 'Fierce, proud and tribal, orcs value strength and honour above gold. Their war-chants carry for miles and their blood runs hot in battle.',
    skillBonus: { twohanded: 8, blunt: 5, intimidation: 6, survival: 3 },
    statMods: { maxHp: 20, damage: 0.08, maxMana: -10, 'resist.frost': 0.1 },
    traits: ['Battle fury', 'Thick hide', 'Tusked'],
  },
  halfling: {
    id: 'halfling', name: 'Halfling', plural: 'Halflings', lifespan: 130, adultAge: 30, heightM: [0.95, 1.15], playable: true,
    description: 'Small, cheerful and far braver than they look. Halflings love good food and quiet hills, yet their luck and nimble fingers take them into every adventure.',
    skillBonus: { stealth: 8, lockpicking: 6, cooking: 6, throwing: 4 },
    statMods: { luck: 3, maxHp: -10, evasion: 0.05, 'resist.fear': 0.25 },
    traits: ['Lucky', 'Small and nimble', 'Fearless'],
  },
  goblin: {
    id: 'goblin', name: 'Goblin', plural: 'Goblins', lifespan: 50, adultAge: 10, heightM: [0.85, 1.05], playable: true,
    description: 'Wiry, clever and endlessly inventive, goblins scavenge, tinker and haggle. Big ears miss nothing; long noses smell every opportunity.',
    skillBonus: { tinkering: 8, stealth: 6, trading: 4, alchemy: 4 },
    statMods: { maxHp: -15, moveSpeed: 0.06, perception: 3, 'resist.poison': 0.1 },
    traits: ['Scavenger', 'Sharp ears', 'Quick feet'],
  },
  sylvan: {
    id: 'sylvan', name: 'Sylvan', plural: 'Sylvans', lifespan: 450, adultAge: 50, heightM: [1.7, 1.95], playable: true,
    description: 'Children of the old forests, sylvans have bark-patterned skin and hair of living leaves that turns with their seasons. They speak with trees and heal with sap and song.',
    skillBonus: { herbalism: 8, druidism: 8, survival: 4, healing: 3 },
    statMods: { hpRegen: 0.5, 'resist.poison': 0.1, 'resist.fire': -0.15, 'resist.nature': 0.2 },
    traits: ['Photosynthesis: regenerate in sunlight', 'Woodland stride', 'Flammable'],
  },
  drakeborn: {
    id: 'drakeborn', name: 'Drakeborn', plural: 'Drakeborn', lifespan: 160, adultAge: 16, heightM: [1.8, 2.05], playable: true,
    description: 'Scaled descendants of dragon-blood, horned and tailed, with slit-pupiled eyes that glow like embers. Proud warriors and fire-callers.',
    skillBonus: { pyromancy: 8, polearms: 5, intimidation: 4, blades: 3 },
    statMods: { armor: 5, 'resist.fire': 0.25, 'resist.frost': -0.1, maxHp: 10 },
    traits: ['Draconic scales', 'Fire-blooded', 'Horns & tail'],
  },
  umbral: {
    id: 'umbral', name: 'Umbral', plural: 'Umbrals', lifespan: 220, adultAge: 25, heightM: [1.65, 1.9], playable: true,
    description: 'Pale dwellers of the underworld whose veins shimmer with captured shadow. Their glowing eyes pierce darkness and their whispers bend minds.',
    skillBonus: { shadowcraft: 8, stealth: 6, illusion: 5, daggers: 3 },
    statMods: { darkvision: 1, maxMana: 10, 'resist.shadow': 0.25, 'resist.radiant': -0.15 },
    traits: ['Darkvision', 'Shadow-veined', 'Sunlight sensitivity'],
  },
  giantkin: {
    id: 'giantkin', name: 'Giantkin', plural: 'Giantkin', lifespan: 320, adultAge: 35, heightM: [2.6, 3.2], playable: true,
    description: 'Towering folk with giant blood, slow to anger and terrible when roused. Their skin often bears the hue of the mountains they came from.',
    skillBonus: { twohanded: 6, blunt: 6, mining: 4, intimidation: 5 },
    statMods: { maxHp: 40, carry: 60, damage: 0.12, moveSpeed: -0.08, stealth: -10 },
    traits: ['Colossal', 'Mountain-born', 'Hard to hide'],
  },
};

// ------------------------------------------------------------------ helpers

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
function pickW<T>(rng: Rng, list: [T, number][]): T {
  return rng.weighted(list, (e) => e[1])[0];
}
function jitterColor(rng: Rng, c: RGB, amt: number): RGB {
  const l = rng.gaussian(0, amt);
  return [clamp01(c[0] * (1 + l) + rng.gaussian(0, amt * 0.35)), clamp01(c[1] * (1 + l) + rng.gaussian(0, amt * 0.35)), clamp01(c[2] * (1 + l) + rng.gaussian(0, amt * 0.35))];
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpC = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const lum = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Ages in MakeHuman's age parameter for (young adult .. elder) per race-agnostic look. */
export function ageParamFromYears(years: number, race: RaceId): number {
  const def = RACES[race];
  // Normalize into human-equivalent years: adulthood maps to 18, lifespan to 85.
  const adult = def.adultAge ?? 18;
  let h: number;
  if (years <= adult) h = (years / adult) * 18;
  else h = 18 + ((years - adult) / Math.max(1, def.lifespan - adult)) * 67;
  // MakeHuman: 1y → 0, 11y → 0.1875, 25y → 0.5, 90y → 1.
  if (h < 1) return 0;
  if (h < 11) return ((h - 1) / 10) * 0.1875;
  if (h < 25) return 0.1875 + ((h - 11) / 14) * 0.3125;
  return clamp01(0.5 + ((h - 25) / 65) * 0.5);
}

/** Mixed heritage: numeric blend of two style values. */
type Mix = <K extends keyof RaceStyle>(k: K) => [RaceStyle[K], RaceStyle[K]];

// ------------------------------------------------------------------ generator

export interface AppearanceOptions {
  gender?: number;
  age?: number;
  race2?: RaceId | null;
  /** Blend weight of race2 (default: random 0.25..0.6 when race2 is set). */
  raceMix?: number;
}

/** Deterministic random appearance for a race. */
export function randomAppearance(race: RaceId, seed: number, opts: AppearanceOptions = {}): HumanoidAppearance {
  const base = new Rng(deriveSeed(seed >>> 0, 'humanoid', race));
  const race2 = opts.race2 && opts.race2 !== race ? opts.race2 : null;
  const mix = race2 ? clamp(opts.raceMix ?? base.fork('mix').range(0.25, 0.6), 0, 1) : 0;
  const A = RACE_STYLES[race];
  const B = race2 ? RACE_STYLES[race2] : A;
  const both: Mix = (k) => [A[k], B[k]];
  /** Pick from race1 or race2 list (per-feature inheritance). */
  const inherit = <T>(rng: Rng, a: T, b: T): T => (race2 && rng.chance(mix) ? b : a);
  const rangeMix = (rng: Rng, k: 'height' | 'weight' | 'muscle' | 'proportions' | 'scale' | 'patternStrength' | 'eyeGlow' | 'tusks' | 'hornSize' | 'tailLength') => {
    const [ra, rb] = both(k);
    const lo = lerp(ra[0], rb[0], mix), hi = lerp(ra[1], rb[1], mix);
    return rng.normalIn(lo, hi);
  };

  // ---- macro body
  const rb = base.fork('body');
  const gender = opts.gender ?? (rb.chance(0.5) ? rb.range(0.82, 1) : rb.range(0, 0.18));
  const male = gender > 0.5;
  // Adults mostly; elders and young adults common, avoid children unless asked.
  const age = opts.age ?? rb.weighted([[0.42, 0.52], [0.5, 0.62], [0.62, 0.8], [0.8, 0.98]], (_, i) => [3, 4, 2.5, 1.2][i]).reduce((a, b) => rb.range(a, b));
  const genderPull = (male ? 0.08 : -0.08);
  const muscle = clamp01(rangeMix(rb, 'muscle') + genderPull);
  const weight = clamp01(rangeMix(rb, 'weight') + (age > 0.65 ? 0.08 : 0));
  const height = clamp01(rangeMix(rb, 'height') + (male ? 0.05 : -0.05));
  const proportions = clamp01(rangeMix(rb, 'proportions'));
  const scale = rangeMix(rb, 'scale');

  const re = base.fork('ethnic');
  const eth = inherit(re, pickW(re, A.ethnic), pickW(re, B.ethnic));
  const ej = [eth[0] + re.range(0, 0.25), eth[1] + re.range(0, 0.25), eth[2] + re.range(0, 0.25)];
  const es = ej[0] + ej[1] + ej[2];
  const [african, asian, caucasian] = [ej[0] / es, ej[1] / es, ej[2] / es];

  // ---- face & body local modifiers: race bias + individual variation
  const rf = base.fork('face');
  const fieldsF = ['jaw', 'chin', 'cheekbones', 'noseSize', 'noseWidth', 'noseBridge', 'browRidge', 'eyeSize', 'eyeSpacing', 'mouthWidth', 'lipFullness', 'earSize', 'earPoint', 'headRound', 'foreheadSlope'] as const;
  const face = {} as HumanoidAppearance['face'];
  for (const f of fieldsF) {
    const bias = lerp(A.face[f] ?? 0, B.face[f] ?? 0, mix);
    let v = bias + rf.gaussian(0, 0.28);
    if (f === 'earPoint') v = bias > 0.2 ? bias + rf.gaussian(0, 0.12) : Math.min(v, 0.25);
    if (f === 'jaw' || f === 'browRidge') v += male ? 0.15 : -0.15;
    face[f] = clamp(v, -1, f === 'earPoint' ? 1.3 : 1);
  }
  // Cheeks, face width and the resting expression (their own stream: everyone keeps the rest of
  // their face). Fuller cheeks with more weight; most people look neutral to friendly, a few stern.
  const rf2 = base.fork('face2');
  face.cheekFullness = clamp((weight - 0.5) * 0.9 + rf2.gaussian(0, 0.25), -1, 1);
  face.faceWidth = clamp(rf2.gaussian(0, 0.22), -1, 1);
  face.smile = clamp(rf2.gaussian(0.12, 0.3), -0.7, 0.8);
  const rbd = base.fork('bodymods');
  const fieldsB = ['shoulders', 'chest', 'waist', 'hips', 'armLength', 'legLength', 'neck', 'hands', 'feet', 'belly'] as const;
  const body = {} as HumanoidAppearance['body'];
  for (const f of fieldsB) {
    const bias = lerp(A.body[f] ?? 0, B.body[f] ?? 0, mix);
    let v = bias + rbd.gaussian(0, f === 'armLength' || f === 'legLength' ? 0.15 : 0.25);
    if (f === 'shoulders') v += male ? 0.2 : -0.2;
    if (f === 'hips') v += male ? -0.15 : 0.2;
    if (f === 'belly') v += (weight - 0.5) * 0.8 + (age > 0.6 && male ? 0.15 : 0);
    body[f] = clamp(v, -1, 1);
  }

  // ---- colouring
  const rs = base.fork('skin');
  let skinTone: RGB;
  const humanLike = (r: RaceId) => r === 'human' || r === 'halfling' || r === 'dwarf';
  const skinFor = (style: RaceStyle, r: RaceId): RGB => {
    if (humanLike(r) || r === 'elf') {
      // Pick tone by "melanin" correlated with the ethnic base shape.
      const sorted = style.skin.map((e) => e[0]).sort((a, b) => lum(b) - lum(a));
      const m = clamp01(african * 0.9 + asian * 0.35 + caucasian * 0.08 + rs.gaussian(0, 0.12));
      const fi = m * (sorted.length - 1);
      const i0 = Math.floor(fi), i1 = Math.min(sorted.length - 1, i0 + 1);
      return lerpC(sorted[i0], sorted[i1], fi - i0);
    }
    return pickW(rs, style.skin);
  };
  const s1 = skinFor(A, race);
  skinTone = race2 ? lerpC(s1, skinFor(B, race2), mix * 0.6) : s1;
  skinTone = jitterColor(rs, skinTone, 0.05);
  const accentSrc = inherit(rs, A.accent, B.accent);
  let skinAccent: RGB;
  if (accentSrc === 'darker') skinAccent = [skinTone[0] * 0.55, skinTone[1] * 0.45, skinTone[2] * 0.4];
  else if (accentSrc === 'lighter') skinAccent = [clamp01(skinTone[0] * 1.35 + 0.08), clamp01(skinTone[1] * 1.3 + 0.06), clamp01(skinTone[2] * 1.25 + 0.05)];
  else skinAccent = jitterColor(rs, pickW(rs, accentSrc), 0.08);
  const skinPattern = inherit(rs, pickW(rs, A.pattern), pickW(rs, B.pattern));
  const patternStrength = skinPattern === 'none' ? 0 : rangeMix(rs, 'patternStrength');

  const ry = base.fork('eyes');
  const eyeColor = jitterColor(ry, inherit(ry, pickW(ry, A.eyes), pickW(ry, B.eyes)), 0.08);
  const eyeGlow = clamp01(rangeMix(ry, 'eyeGlow'));
  const pupil = inherit(ry, pickW(ry, A.pupil), pickW(ry, B.pupil));

  const rh = base.fork('hair');
  let hairColor = jitterColor(rh, inherit(rh, pickW(rh, A.hair), pickW(rh, B.hair)), 0.07);
  const greying = lerp(A.greying, B.greying, mix);
  if (greying > 0 && age > 0.6) {
    const g = clamp01((age - 0.6) / 0.35) * greying * rh.range(0.6, 1.1);
    const grey: RGB = [0.72, 0.71, 0.69];
    hairColor = lerpC(hairColor, grey, clamp01(g));
  }
  const hairList = male ? inherit(rh, A.hairStylesMale, B.hairStylesMale) : inherit(rh, A.hairStylesFemale, B.hairStylesFemale);
  let hairStyle = pickW(rh, hairList);
  // Elder men bald more often.
  if (male && age > 0.7 && (race === 'human' || race === 'dwarf') && rh.chance(0.3)) hairStyle = rh.chance(0.5) ? 'tonsure' : 'bald';
  const beardChance = lerp(A.beardChance[male ? 0 : 1], B.beardChance[male ? 0 : 1], mix);
  const beardStyle = age > 0.36 && rh.chance(beardChance) ? pickW(rh, inherit(rh, A.beardStyles, B.beardStyles)) : 'none';
  const browStyle = pickW(rh, inherit(rh, A.browStyles, B.browStyles));

  // ---- add-ons
  const ra = base.fork('addons');
  const tuskChance = lerp(A.tuskChance, B.tuskChance, mix);
  const tusks = ra.chance(tuskChance) ? clamp01(rangeMix(ra, 'tusks') * (race2 ? lerp(1, 0.6, mix) : 1) * (male ? 1 : 0.9)) : 0;
  const hornStyle = inherit(ra, pickW(ra, A.horns), pickW(ra, B.horns));
  const horns: HumanoidAppearance['horns'] = {
    style: hornStyle,
    size: hornStyle === 'none' ? 0 : clamp01(rangeMix(ra, 'hornSize') * (male ? 1 : 0.8)),
    color: jitterColor(ra, inherit(ra, pickW(ra, A.hornColors), pickW(ra, B.hornColors)), 0.06),
  };
  const tailStyle = inherit(ra, pickW(ra, A.tail), pickW(ra, B.tail));
  const tail: HumanoidAppearance['tail'] = { style: tailStyle, length: tailStyle === 'none' ? 0 : rangeMix(ra, 'tailLength') };

  const rm = base.fork('marks');
  const marks: string[] = [];
  const markChance = lerp(A.markChance, B.markChance, mix);
  if (rm.chance(markChance)) {
    marks.push(pickW(rm, inherit(rm, A.marks, B.marks)));
    if (rm.chance(0.3)) {
      const m2 = pickW(rm, inherit(rm, A.marks, B.marks));
      if (!marks.includes(m2)) marks.push(m2);
    }
  }

  return {
    race, race2, raceMix: mix, seed: seed >>> 0,
    gender, age, muscle, weight, height, proportions, african, asian, caucasian,
    face, body,
    skinTone, skinAccent, skinPattern, patternStrength,
    eyeColor, eyeGlow, pupil,
    hairColor, hairStyle, beardStyle, browStyle,
    tusks, horns, tail, marks, scale,
  };
}

/** All hair styles understood by the renderer (for the character creator). */
export const HAIR_STYLES = ['bald', 'shaved', 'buzz', 'short', 'crop', 'tousled', 'slick', 'undercut', 'shoulder', 'long', 'ponytail', 'braid', 'braids', 'bun', 'topknot', 'mohawk', 'dreadlocks', 'wild', 'tonsure', 'leaves', 'crest'];
export const BEARD_STYLES = ['none', 'stubble', 'short', 'full', 'long', 'braided', 'forked', 'goatee', 'mustache', 'mutton', 'chinstrap'];
export const BROW_STYLES = ['none', 'thin', 'normal', 'thick', 'bushy', 'arched', 'unibrow', 'scaled'];
export const MARK_IDS = ['scar_cheek', 'scar_brow', 'scar_lip', 'scar_eye', 'scar_chin', 'tattoo_face', 'warpaint_stripes', 'warpaint_mask', 'freckle_patch'];

/** Every race id (convenience re-export for UI). */
export const ALL_RACES: RaceId[] = RACE_IDS;
