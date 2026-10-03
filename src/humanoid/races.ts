/**
 * Visual race data: parameter distributions used by `randomAppearance`, and
 * the fixed body shaping (extra MakeHuman targets, bone proportion scaling,
 * add-ons) applied by the body builder. Kept separate from `RACES`
 * (gameplay-facing definitions in appearance.ts) so the worker-side body
 * builder can import it without UI/gameplay data.
 *
 * All colours are sRGB 0..1.
 */
import type { HumanoidAppearance, RaceId } from './types';

export type RGB = [number, number, number];
type Range = [number, number];
type Weighted<T> = [T, number][];

/** Per-bone proportion scaling applied after morphing (len along the bone, girth across). */
export interface BoneScale { len?: number; girth?: number }

/** Bone groups used by race shaping (expanded to concrete bones by the builder). */
export type BoneGroup = 'legs' | 'thighs' | 'shins' | 'arms' | 'upperarms' | 'forearms' | 'hands' | 'fingers' | 'feet' | 'spine' | 'neck' | 'head' | 'clavicles' | 'pelvis';

export interface RaceStyle {
  // ---- distributions (randomAppearance)
  height: Range;
  weight: Range;
  muscle: Range;
  proportions: Range;
  scale: Range;
  /** Ethnic base-shape presets [african, asian, caucasian] with weights. */
  ethnic: Weighted<RGB>;
  /** Skin palette; tones are jittered around the picked entry. */
  skin: Weighted<RGB>;
  /** Accent (pattern) colour derivation: 'darker' | 'lighter' | explicit palette. */
  accent: Weighted<RGB> | 'darker' | 'lighter';
  pattern: Weighted<HumanoidAppearance['skinPattern']>;
  patternStrength: Range;
  hair: Weighted<RGB>;
  /** Probability that hair greys with age (0 = never, e.g. sylvan leaves). */
  greying: number;
  eyes: Weighted<RGB>;
  eyeGlow: Range;
  pupil: Weighted<HumanoidAppearance['pupil']>;
  hairStylesMale: Weighted<string>;
  hairStylesFemale: Weighted<string>;
  beardStyles: Weighted<string>;
  /** Probability of a beard for males / females. */
  beardChance: [number, number];
  browStyles: Weighted<string>;
  tusks: Range;
  /** Chance of tusks at all (orcs always, mixed blood sometimes). */
  tuskChance: number;
  horns: Weighted<HumanoidAppearance['horns']['style']>;
  hornSize: Range;
  hornColors: Weighted<RGB>;
  tail: Weighted<HumanoidAppearance['tail']['style']>;
  tailLength: Range;
  /** Typical face modifier biases (added to random variation). */
  face: Partial<HumanoidAppearance['face']>;
  body: Partial<HumanoidAppearance['body']>;
  /** Chance of scars / warpaint / tattoos marks. */
  marks: Weighted<string>;
  markChance: number;

  // ---- fixed shaping (body builder)
  /** Extra local target weights (MakeHuman target names, l/r expanded via '%'). */
  targets: Record<string, number>;
  bones: Partial<Record<BoneGroup, BoneScale>>;
  /** Uniform head scale relative to the body (halflings, goblins > 1, giants < 1). */
  headScale: number;
  /** Procedural ear-tip elongation (elves, goblins), 0..1.5. */
  earTip: number;
  /** Ear tip direction: 0 = up/back (elf), 1 = sideways (goblin). */
  earSideways: number;
}

const HUMAN_HAIR: Weighted<RGB> = [
  [[0.035, 0.03, 0.028], 3], [[0.09, 0.06, 0.04], 4], [[0.2, 0.13, 0.075], 4], [[0.36, 0.25, 0.15], 3], [[0.52, 0.4, 0.25], 2],
  [[0.74, 0.62, 0.42], 1.5], [[0.86, 0.8, 0.66], 0.4], [[0.42, 0.14, 0.06], 0.8], [[0.62, 0.3, 0.12], 0.8], [[0.3, 0.11, 0.06], 0.8],
];
const HUMAN_EYES: Weighted<RGB> = [
  [[0.25, 0.14, 0.06], 5], [[0.12, 0.07, 0.04], 4], [[0.42, 0.32, 0.14], 2], [[0.28, 0.42, 0.24], 1.5], [[0.28, 0.44, 0.66], 2],
  [[0.46, 0.52, 0.56], 1], [[0.58, 0.4, 0.14], 0.5],
];
const MALE_HAIR: Weighted<string> = [
  ['short', 6], ['crop', 4], ['tousled', 3], ['buzz', 3], ['slick', 2], ['shoulder', 1.5], ['long', 1.2], ['ponytail', 1.5], ['bald', 2],
  ['shaved', 1.5], ['undercut', 1.2], ['braids', 0.6], ['topknot', 0.6], ['dreadlocks', 0.6], ['mohawk', 0.3], ['tonsure', 0.3], ['wild', 0.6], ['bun', 0.4],
];
const FEMALE_HAIR: Weighted<string> = [
  ['long', 5], ['shoulder', 4], ['ponytail', 4], ['braid', 3], ['bun', 3], ['braids', 2], ['short', 1.5], ['crop', 1], ['tousled', 1.5],
  ['topknot', 0.8], ['dreadlocks', 0.6], ['wild', 0.8], ['undercut', 0.4], ['shaved', 0.15], ['mohawk', 0.15],
];
const BEARDS: Weighted<string> = [
  ['stubble', 5], ['short', 4], ['full', 3], ['goatee', 2], ['mustache', 1.5], ['long', 1], ['mutton', 0.7], ['chinstrap', 0.7], ['braided', 0.4], ['forked', 0.3],
];
const BROWS: Weighted<string> = [['normal', 6], ['thin', 2], ['thick', 3], ['arched', 2], ['bushy', 1], ['unibrow', 0.3]];
const NO: Weighted<'none'> = [['none', 1]];
const MARKS: Weighted<string> = [['scar_cheek', 2], ['scar_brow', 2], ['scar_lip', 1], ['scar_eye', 1], ['scar_chin', 1], ['tattoo_face', 0.5], ['warpaint_stripes', 0.3], ['freckle_patch', 1]];

const BASE: Omit<RaceStyle, 'skin' | 'hair' | 'eyes'> = {
  height: [0.25, 0.75], weight: [0.2, 0.8], muscle: [0.25, 0.75], proportions: [0.35, 0.75], scale: [1, 1],
  ethnic: [[[0.1, 0.1, 0.8], 3], [[0.8, 0.05, 0.15], 2], [[0.05, 0.85, 0.1], 2], [[0.34, 0.33, 0.33], 2]],
  accent: 'darker',
  pattern: [['none', 8], ['freckles', 2]],
  patternStrength: [0.2, 0.7],
  greying: 1,
  eyeGlow: [0, 0],
  pupil: [['round', 1]],
  hairStylesMale: MALE_HAIR,
  hairStylesFemale: FEMALE_HAIR,
  beardStyles: BEARDS,
  beardChance: [0.55, 0],
  browStyles: BROWS,
  tusks: [0, 0],
  tuskChance: 0,
  horns: NO,
  hornSize: [0, 0],
  hornColors: [[[0.78, 0.74, 0.64], 1]],
  tail: NO,
  tailLength: [0, 0],
  face: {},
  body: {},
  marks: MARKS,
  markChance: 0.25,
  targets: {},
  bones: {},
  headScale: 1,
  earTip: 0,
  earSideways: 0,
};

export const RACE_STYLES: Record<RaceId, RaceStyle> = {
  human: {
    ...BASE,
    skin: [
      [[0.95, 0.8, 0.7], 2], [[0.91, 0.73, 0.61], 3], [[0.86, 0.66, 0.52], 3], [[0.77, 0.57, 0.42], 3], [[0.7, 0.53, 0.37], 2],
      [[0.6, 0.43, 0.3], 2], [[0.48, 0.33, 0.23], 2], [[0.36, 0.24, 0.16], 2], [[0.26, 0.17, 0.12], 1.5],
    ],
    hair: HUMAN_HAIR,
    eyes: HUMAN_EYES,
  },
  elf: {
    ...BASE,
    height: [0.6, 0.95], weight: [0.08, 0.4], muscle: [0.2, 0.55], proportions: [0.7, 1], scale: [1.02, 1.08],
    ethnic: [[[0.05, 0.25, 0.7], 3], [[0.15, 0.55, 0.3], 2], [[0.5, 0.2, 0.3], 1]],
    skin: [[[0.95, 0.85, 0.77], 3], [[0.9, 0.78, 0.66], 3], [[0.84, 0.86, 0.92], 1.2], [[0.74, 0.58, 0.42], 2], [[0.55, 0.4, 0.3], 1], [[0.8, 0.72, 0.6], 2]],
    accent: 'lighter',
    pattern: [['none', 8], ['freckles', 1], ['tattoos', 1.2]],
    hair: [[[0.92, 0.88, 0.78], 3], [[0.82, 0.84, 0.88], 2], [[0.8, 0.64, 0.32], 3], [[0.05, 0.045, 0.05], 2], [[0.4, 0.16, 0.08], 1.5], [[0.75, 0.8, 0.92], 1], [[0.3, 0.2, 0.12], 1]],
    greying: 0.15,
    eyes: [[[0.3, 0.55, 0.8], 3], [[0.35, 0.6, 0.35], 3], [[0.7, 0.55, 0.2], 2], [[0.5, 0.35, 0.72], 1.5], [[0.6, 0.66, 0.7], 1.5], [[0.3, 0.2, 0.1], 1]],
    eyeGlow: [0, 0.15],
    hairStylesMale: [['long', 6], ['shoulder', 3], ['ponytail', 3], ['braid', 2], ['topknot', 1.5], ['braids', 1.5], ['short', 1], ['slick', 1]],
    hairStylesFemale: [['long', 7], ['braid', 3], ['braids', 3], ['bun', 2], ['ponytail', 2], ['shoulder', 2], ['topknot', 1]],
    beardChance: [0.05, 0],
    browStyles: [['thin', 4], ['arched', 4], ['normal', 2]],
    face: { cheekbones: 0.5, chin: 0.25, noseWidth: -0.35, jaw: -0.3, eyeSize: 0.15, earSize: 0.25, earPoint: 1 },
    body: { neck: -0.3, waist: -0.2, legLength: 0.25 },
    markChance: 0.15,
    marks: [['tattoo_face', 2], ['scar_cheek', 0.5], ['scar_brow', 0.5]],
    targets: { 'head-oval': 0.5, '%-cheek-bones-incr': 0.4, 'nose-point-width-decr': 0.4, 'chin-width-decr': 0.35, 'neck-scale-vert-incr': 0.35, '%-eye-corner2-up': 0.35, 'eyebrows-angle-up': 0.4 },
    bones: { legs: { len: 1.04, girth: 0.95 }, arms: { girth: 0.94 }, neck: { len: 1.12, girth: 0.92 }, spine: { girth: 0.96 } },
    headScale: 0.98,
    earTip: 1.0,
    earSideways: 0.15,
  },
  dwarf: {
    ...BASE,
    height: [0, 0.2], weight: [0.5, 0.95], muscle: [0.6, 1], proportions: [0.3, 0.6], scale: [0.8, 0.86],
    ethnic: [[[0.05, 0.05, 0.9], 4], [[0.3, 0.1, 0.6], 1], [[0.1, 0.5, 0.4], 1]],
    skin: [[[0.92, 0.72, 0.6], 3], [[0.86, 0.62, 0.5], 3], [[0.76, 0.54, 0.4], 2], [[0.6, 0.42, 0.3], 1.5], [[0.45, 0.3, 0.22], 1]],
    hair: [[[0.42, 0.14, 0.06], 3], [[0.62, 0.3, 0.12], 2], [[0.09, 0.06, 0.04], 3], [[0.2, 0.13, 0.075], 3], [[0.62, 0.5, 0.3], 1.5], [[0.03, 0.03, 0.03], 2]],
    eyes: [[[0.25, 0.14, 0.06], 4], [[0.28, 0.44, 0.66], 2], [[0.46, 0.52, 0.56], 2], [[0.3, 0.42, 0.25], 1]],
    hairStylesMale: [['long', 3], ['braids', 3], ['bald', 3], ['shoulder', 2], ['topknot', 1], ['wild', 2], ['tonsure', 1], ['short', 1]],
    hairStylesFemale: [['braids', 5], ['braid', 3], ['bun', 2], ['long', 2], ['wild', 1]],
    beardStyles: [['long', 5], ['braided', 5], ['forked', 3], ['full', 4], ['short', 1]],
    beardChance: [0.97, 0.12],
    browStyles: [['bushy', 6], ['thick', 4]],
    face: { browRidge: 0.4, noseSize: 0.35, noseWidth: 0.4, jaw: 0.35, cheekbones: 0.2, earSize: 0.1 },
    body: { shoulders: 0.5, chest: 0.3, belly: 0.2, hands: 0.3, neck: 0.5 },
    targets: { 'head-square': 0.5, 'nose-volume-incr': 0.35, 'neck-scale-horiz-incr': 0.5, 'torso-scale-horiz-incr': 0.3, '%-cheek-volume-incr': 0.3 },
    bones: { legs: { len: 0.8, girth: 1.14 }, arms: { len: 0.92, girth: 1.12 }, spine: { girth: 1.12 }, hands: { len: 1.05, girth: 1.12 }, feet: { girth: 1.1 }, clavicles: { len: 1.1 } },
    headScale: 1.08,
    markChance: 0.35,
    marks: [['scar_cheek', 2], ['scar_brow', 2], ['scar_eye', 1], ['tattoo_face', 1], ['scar_lip', 1]],
  },
  orc: {
    ...BASE,
    height: [0.6, 0.95], weight: [0.55, 0.9], muscle: [0.75, 1], proportions: [0.25, 0.6], scale: [1.05, 1.12],
    ethnic: [[[0.6, 0.1, 0.3], 2], [[0.3, 0.3, 0.4], 2], [[0.2, 0.6, 0.2], 1]],
    // Unmistakably orcish: saturated greens, olives and grey-greens, never pale.
    skin: [[[0.36, 0.52, 0.22], 3], [[0.44, 0.54, 0.26], 3], [[0.4, 0.47, 0.28], 2], [[0.3, 0.42, 0.2], 2], [[0.42, 0.48, 0.34], 1.5], [[0.26, 0.36, 0.19], 2], [[0.5, 0.5, 0.26], 1.5]],
    pattern: [['none', 4], ['spots', 3], ['tattoos', 2]],
    hair: [[[0.035, 0.03, 0.028], 6], [[0.09, 0.06, 0.04], 3], [[0.3, 0.28, 0.26], 1]],
    eyes: [[[0.65, 0.12, 0.05], 3], [[0.7, 0.45, 0.1], 3], [[0.75, 0.65, 0.12], 2], [[0.25, 0.14, 0.06], 2]],
    eyeGlow: [0, 0.2],
    hairStylesMale: [['mohawk', 4], ['topknot', 3], ['bald', 3], ['braids', 2], ['shaved', 2], ['wild', 2], ['dreadlocks', 2], ['undercut', 1]],
    hairStylesFemale: [['braids', 4], ['mohawk', 2], ['topknot', 3], ['wild', 2], ['dreadlocks', 2], ['ponytail', 2], ['undercut', 2]],
    beardStyles: [['stubble', 4], ['short', 2], ['goatee', 2], ['braided', 1]],
    beardChance: [0.35, 0],
    browStyles: [['thick', 4], ['bushy', 3], ['none', 1]],
    tusks: [0.6, 1], tuskChance: 1,
    face: { browRidge: 0.8, jaw: 0.75, chin: 0.2, noseWidth: 0.6, noseSize: 0.15, noseBridge: -0.4, mouthWidth: 0.4, lipFullness: 0.2, earPoint: 0.6, earSize: 0.05, cheekbones: 0.4 },
    body: { shoulders: 0.6, neck: 0.8, chest: 0.4, hands: 0.3 },
    marks: [['warpaint_stripes', 3], ['warpaint_mask', 2], ['scar_cheek', 2], ['scar_eye', 1.5], ['scar_lip', 1.5], ['tattoo_face', 1]],
    markChance: 0.7,
    targets: {
      'chin-prognathism-incr': 0.6, 'chin-bones-incr': 0.4, 'forehead-nubian-incr': 0.6, 'nose-point-up': 0.5, 'nose-flaring-incr': 0.6, 'torso-vshape-incr': 0.5,
      'neck-scale-horiz-incr': 0.6, 'head-square': 0.5, 'forehead-trans-backward': 0.5, '%-eye-scale-decr': 0.3, 'mouth-lowerlip-volume-incr': 0.3,
    },
    bones: { arms: { len: 1.04, girth: 1.12 }, spine: { girth: 1.08 }, neck: { len: 0.85, girth: 1.2 }, hands: { len: 1.05, girth: 1.15 }, clavicles: { len: 1.08 } },
    headScale: 1.0,
    earTip: 0.35,
    earSideways: 0.4,
  },
  halfling: {
    ...BASE,
    height: [0, 0.25], weight: [0.35, 0.75], muscle: [0.2, 0.5], proportions: [0.3, 0.6], scale: [0.64, 0.7],
    skin: [[[0.95, 0.8, 0.7], 3], [[0.91, 0.73, 0.61], 3], [[0.86, 0.66, 0.52], 2], [[0.74, 0.55, 0.4], 1.5], [[0.55, 0.38, 0.27], 1]],
    pattern: [['none', 5], ['freckles', 3]],
    hair: [[[0.36, 0.25, 0.15], 4], [[0.2, 0.13, 0.075], 4], [[0.52, 0.4, 0.25], 3], [[0.62, 0.3, 0.12], 2], [[0.74, 0.62, 0.42], 1.5]],
    eyes: HUMAN_EYES,
    hairStylesMale: [['tousled', 6], ['short', 3], ['wild', 3], ['shoulder', 1.5], ['crop', 1]],
    hairStylesFemale: [['tousled', 2], ['long', 3], ['braid', 3], ['bun', 2], ['shoulder', 3], ['braids', 1]],
    beardChance: [0.15, 0],
    beardStyles: [['mutton', 3], ['stubble', 2], ['short', 1]],
    face: { cheekbones: -0.2, noseSize: -0.1, eyeSize: 0.3, earPoint: 0.45, earSize: 0.2, headRound: 0.4, lipFullness: 0.2 },
    body: { belly: 0.25, feet: 0.6, hands: -0.1 },
    targets: { 'head-round': 0.5, '%-cheek-volume-incr': 0.5, 'nose-point-up': 0.35, 'chin-height-decr': 0.3, 'head-fat-incr': 0.3 },
    bones: { legs: { len: 0.86, girth: 1.06 }, feet: { len: 1.25, girth: 1.15 }, arms: { len: 0.95 }, neck: { len: 0.85 } },
    headScale: 1.14,
    earTip: 0.4,
    earSideways: 0.1,
    markChance: 0.1,
  },
  goblin: {
    ...BASE,
    height: [0, 0.2], weight: [0.05, 0.35], muscle: [0.25, 0.6], proportions: [0, 0.3], scale: [0.56, 0.64],
    skin: [[[0.45, 0.6, 0.28], 3], [[0.62, 0.62, 0.3], 2], [[0.48, 0.52, 0.4], 2], [[0.5, 0.5, 0.28], 2], [[0.36, 0.46, 0.22], 2], [[0.7, 0.66, 0.4], 1]],
    pattern: [['none', 3], ['spots', 3], ['stripes', 1], ['tattoos', 1]],
    hair: [[[0.035, 0.03, 0.028], 4], [[0.09, 0.06, 0.04], 2], [[0.42, 0.14, 0.06], 1.5], [[0.85, 0.85, 0.82], 1]],
    eyes: [[[0.8, 0.7, 0.1], 4], [[0.7, 0.15, 0.05], 3], [[0.85, 0.45, 0.08], 2]],
    eyeGlow: [0.05, 0.35],
    pupil: [['round', 2], ['slit', 1]],
    hairStylesMale: [['bald', 5], ['wild', 3], ['mohawk', 2], ['topknot', 2], ['tonsure', 1]],
    hairStylesFemale: [['wild', 3], ['topknot', 2], ['braids', 2], ['bald', 1], ['ponytail', 1]],
    beardChance: [0.1, 0],
    beardStyles: [['goatee', 2], ['stubble', 1]],
    browStyles: [['thin', 2], ['none', 3], ['bushy', 1]],
    face: { noseSize: 0.9, noseBridge: 0.5, earSize: 0.9, earPoint: 1, chin: 0.5, jaw: -0.4, mouthWidth: 0.6, eyeSize: 0.35, cheekbones: 0.5, lipFullness: -0.4 },
    body: { hands: 0.5, feet: 0.4, belly: 0.2, neck: -0.4 },
    markChance: 0.4,
    marks: [['warpaint_stripes', 2], ['scar_cheek', 2], ['scar_eye', 1], ['tattoo_face', 1]],
    targets: {
      '%-ear-wing-incr': 1, 'nose-trans-forward': 1.0, 'nose-point-down': 0.8, 'nose-scale-depth-incr': 1.3, 'nose-scale-vert-incr': 0.6, 'nose-point-width-decr': 0.6, 'head-invertedtriangular': 0.8, 'chin-width-decr': 0.6,
      'mouth-angles-down': 0.3, 'forehead-scale-vert-incr': 0.4, '%-eye-trans-out': 0.3,
    },
    bones: { arms: { len: 1.1, girth: 0.88 }, hands: { len: 1.2, girth: 0.95 }, fingers: { len: 1.2 }, legs: { len: 0.9, girth: 0.9 }, feet: { len: 1.15 }, spine: { girth: 0.92 }, neck: { len: 0.9, girth: 0.85 } },
    headScale: 1.3,
    earTip: 1.3,
    earSideways: 0.95,
  },
  sylvan: {
    ...BASE,
    height: [0.5, 0.9], weight: [0.1, 0.45], muscle: [0.3, 0.6], proportions: [0.5, 0.9], scale: [1.0, 1.08],
    skin: [[[0.44, 0.33, 0.23], 3], [[0.8, 0.78, 0.68], 2], [[0.42, 0.5, 0.3], 3], [[0.56, 0.34, 0.22], 1.5], [[0.56, 0.54, 0.48], 1.5], [[0.62, 0.52, 0.36], 1.5]],
    accent: [[[0.22, 0.16, 0.1], 3], [[0.3, 0.42, 0.18], 3], [[0.45, 0.4, 0.3], 1]],
    pattern: [['bark', 6], ['spots', 1], ['veins', 1]],
    patternStrength: [0.45, 0.95],
    hair: [[[0.25, 0.45, 0.15], 4], [[0.75, 0.4, 0.1], 2], [[0.6, 0.15, 0.08], 1.5], [[0.8, 0.65, 0.2], 1.5], [[0.3, 0.38, 0.15], 2], [[0.9, 0.62, 0.72], 1]],
    greying: 0,
    eyes: [[[0.7, 0.55, 0.15], 3], [[0.3, 0.6, 0.25], 3], [[0.85, 0.7, 0.2], 2], [[0.5, 0.75, 0.4], 1]],
    eyeGlow: [0.1, 0.45],
    hairStylesMale: [['leaves', 7], ['bald', 1], ['wild', 1]],
    hairStylesFemale: [['leaves', 8], ['wild', 1]],
    beardChance: [0.25, 0],
    beardStyles: [['long', 2], ['full', 2], ['short', 1]],
    browStyles: [['thin', 2], ['normal', 2], ['none', 1]],
    face: { cheekbones: 0.6, chin: 0.3, earPoint: 0.6, earSize: 0.2, noseBridge: 0.3, noseWidth: -0.2 },
    body: { neck: -0.2, waist: -0.2 },
    markChance: 0,
    targets: { 'head-oval': 0.4, '%-cheek-bones-incr': 0.4, 'chin-width-decr': 0.2, 'neck-scale-vert-incr': 0.25 },
    bones: { legs: { len: 1.04, girth: 0.92 }, arms: { len: 1.03, girth: 0.92 }, fingers: { len: 1.12 }, neck: { len: 1.08 } },
    headScale: 0.98,
    earTip: 0.6,
    earSideways: 0.3,
  },
  drakeborn: {
    ...BASE,
    height: [0.55, 0.95], weight: [0.3, 0.7], muscle: [0.55, 0.95], proportions: [0.45, 0.85], scale: [1.04, 1.12],
    skin: [[[0.55, 0.16, 0.12], 2], [[0.62, 0.42, 0.22], 2], [[0.75, 0.58, 0.25], 1.5], [[0.18, 0.42, 0.28], 2], [[0.15, 0.14, 0.16], 1.5], [[0.22, 0.35, 0.55], 1.5], [[0.85, 0.8, 0.68], 1], [[0.65, 0.35, 0.22], 2]],
    accent: 'lighter',
    pattern: [['scales', 1]],
    patternStrength: [0.6, 1],
    hair: [[[0.035, 0.03, 0.028], 3], [[0.3, 0.1, 0.08], 1], [[0.2, 0.2, 0.22], 1]],
    greying: 0,
    eyes: [[[0.85, 0.65, 0.12], 4], [[0.8, 0.35, 0.06], 3], [[0.7, 0.1, 0.05], 2], [[0.4, 0.75, 0.25], 1.5], [[0.4, 0.7, 0.9], 1]],
    eyeGlow: [0.15, 0.55],
    pupil: [['slit', 1]],
    hairStylesMale: [['bald', 8], ['crest', 4], ['topknot', 1]],
    hairStylesFemale: [['bald', 5], ['crest', 4], ['braid', 1]],
    beardChance: [0, 0],
    browStyles: [['scaled', 1]],
    horns: [['swept', 4], ['ram', 3], ['straight', 2], ['crown', 2]],
    hornSize: [0.65, 1],
    hornColors: [[[0.85, 0.8, 0.68], 3], [[0.3, 0.26, 0.22], 2], [[0.12, 0.1, 0.1], 2], [[0.6, 0.5, 0.38], 2]],
    tail: [['reptile', 1]],
    tailLength: [0.7, 1.1],
    face: { noseBridge: -0.4, noseWidth: -0.2, browRidge: 0.6, cheekbones: 0.6, earSize: -0.6, earPoint: 0.3, lipFullness: -0.5, jaw: 0.3, chin: 0.3 },
    body: { shoulders: 0.3, neck: 0.3 },
    marks: [['scar_cheek', 1], ['scar_eye', 1]],
    markChance: 0.2,
    targets: { 'nose-flaring-incr': 0.5, 'nose-scale-depth-decr': 0.4, 'forehead-nubian-incr': 0.4, '%-ear-scale-decr': 0.5, 'neck-scale-vert-incr': 0.2, 'mouth-scale-horiz-incr': 0.3 },
    bones: { neck: { len: 1.1, girth: 1.08 }, spine: { girth: 1.04 }, hands: { len: 1.05 } },
    headScale: 1.0,
  },
  umbral: {
    ...BASE,
    height: [0.35, 0.8], weight: [0.05, 0.4], muscle: [0.2, 0.55], proportions: [0.5, 0.95], scale: [0.98, 1.04],
    skin: [[[0.82, 0.82, 0.86], 3], [[0.72, 0.66, 0.8], 3], [[0.55, 0.48, 0.62], 2], [[0.35, 0.28, 0.45], 1.5], [[0.7, 0.76, 0.86], 2], [[0.4, 0.42, 0.5], 1.5]],
    accent: [[[0.55, 0.2, 0.85], 3], [[0.25, 0.4, 0.95], 2], [[0.85, 0.2, 0.4], 1]],
    pattern: [['veins', 5], ['none', 1], ['tattoos', 1]],
    patternStrength: [0.35, 0.8],
    hair: [[[0.92, 0.92, 0.95], 3], [[0.7, 0.72, 0.78], 2], [[0.035, 0.03, 0.04], 3], [[0.4, 0.25, 0.55], 2], [[0.12, 0.14, 0.28], 1.5]],
    greying: 0,
    eyes: [[[0.65, 0.4, 0.95], 3], [[0.9, 0.92, 1.0], 2], [[0.5, 0.75, 1.0], 2], [[0.95, 0.25, 0.3], 1.5]],
    eyeGlow: [0.55, 1],
    pupil: [['round', 2], ['none', 2], ['slit', 1]],
    hairStylesMale: [['long', 4], ['slick', 3], ['shaved', 2], ['ponytail', 2], ['undercut', 2], ['topknot', 1]],
    hairStylesFemale: [['long', 5], ['braid', 2], ['bun', 2], ['undercut', 1], ['shoulder', 2]],
    beardChance: [0.08, 0],
    beardStyles: [['goatee', 2], ['short', 1]],
    browStyles: [['thin', 4], ['arched', 3], ['none', 1]],
    face: { cheekbones: 0.7, earPoint: 0.45, chin: 0.2, noseWidth: -0.3, eyeSize: 0.2, jaw: -0.2 },
    body: { waist: -0.2, neck: -0.2 },
    marks: [['tattoo_face', 3], ['scar_cheek', 1]],
    markChance: 0.3,
    targets: { 'head-oval': 0.4, '%-cheek-bones-incr': 0.5, 'nose-point-width-decr': 0.4, '%-eye-corner2-up': 0.25, '%-cheek-volume-decr': 0.5 },
    bones: { arms: { girth: 0.93 }, legs: { girth: 0.94, len: 1.03 }, fingers: { len: 1.1 }, neck: { len: 1.06 } },
    headScale: 1.0,
    earTip: 0.5,
    earSideways: 0.3,
  },
  giantkin: {
    ...BASE,
    height: [0.8, 1], weight: [0.5, 0.95], muscle: [0.65, 1], proportions: [0.2, 0.6], scale: [1.6, 1.9],
    ethnic: [[[0.3, 0.2, 0.5], 2], [[0.6, 0.1, 0.3], 1], [[0.1, 0.3, 0.6], 1]],
    skin: [[[0.58, 0.58, 0.56], 2], [[0.5, 0.56, 0.64], 2], [[0.6, 0.48, 0.38], 2], [[0.82, 0.86, 0.9], 1], [[0.42, 0.42, 0.42], 1], [[0.78, 0.6, 0.48], 2], [[0.55, 0.4, 0.3], 1]],
    pattern: [['none', 3], ['crystals', 2], ['spots', 1], ['tattoos', 1.5], ['stripes', 0.5]],
    hair: [[[0.88, 0.88, 0.86], 2], [[0.55, 0.54, 0.52], 2], [[0.42, 0.14, 0.06], 2], [[0.035, 0.03, 0.028], 2], [[0.75, 0.85, 0.95], 1], [[0.62, 0.3, 0.12], 1]],
    eyes: [[[0.6, 0.8, 0.95], 3], [[0.46, 0.52, 0.56], 2], [[0.58, 0.4, 0.14], 2], [[0.25, 0.14, 0.06], 1]],
    eyeGlow: [0, 0.3],
    hairStylesMale: [['wild', 4], ['long', 3], ['braids', 3], ['bald', 2], ['topknot', 1]],
    hairStylesFemale: [['braids', 4], ['long', 3], ['wild', 2], ['braid', 2]],
    beardStyles: [['long', 3], ['full', 3], ['braided', 3], ['forked', 1]],
    beardChance: [0.8, 0],
    browStyles: [['bushy', 4], ['thick', 3]],
    face: { browRidge: 0.6, jaw: 0.6, noseSize: 0.3, noseWidth: 0.4, chin: 0.3 },
    body: { hands: 0.4, feet: 0.3, shoulders: 0.5, neck: 0.6 },
    marks: [['tattoo_face', 2], ['scar_cheek', 2], ['scar_brow', 2], ['warpaint_stripes', 1]],
    markChance: 0.4,
    targets: { 'chin-bones-incr': 0.5, 'forehead-nubian-incr': 0.4, 'nose-volume-incr': 0.4, 'neck-scale-horiz-incr': 0.5, 'head-square': 0.4 },
    bones: { hands: { len: 1.12, girth: 1.12 }, arms: { len: 1.04, girth: 1.08 }, spine: { girth: 1.06 }, neck: { len: 0.9, girth: 1.12 } },
    headScale: 0.9,
  },
};
