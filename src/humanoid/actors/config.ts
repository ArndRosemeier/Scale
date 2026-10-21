/**
 * What a person looks like, as an Actors character configuration.
 *
 * City people keep Scale's own seeded generator (`randomAppearance`: age, ancestry, race,
 * colouring, hair and beard per citizen, the same on every run); `appearancePatch` translates
 * such an appearance into an Actors `CharacterConfig`. The hero's look comes from the Actors
 * character generator and is already one (`ActorLook`).
 */
import type { CharacterConfig, CharacterPatch } from '@actors/generator';
import type { HumanoidAppearance } from '../types';
import { hex } from './outfit';

/** A look made in the Actors character generator (the hero's): its whole configuration, outfit included. */
export interface ActorLook {
  actor: CharacterPatch;
}

/** Either kind of look a rig can show. */
export type Look = HumanoidAppearance | ActorLook;

export const isActorLook = (l: Look): l is ActorLook => 'actor' in l;

/** What the animator and the rig need to know about a look, whatever its kind. */
export interface LookTraits {
  seed: number;
  gender: number;
  /** 0..1 */
  weight: number;
  /** Resting expression −1 (stern) … 1 (friendly). */
  smile: number;
  /** Overall size factor (giantkin, halflings): placeholders and LOD distances. */
  scale: number;
}

export function lookTraits(l: Look): LookTraits {
  if (isActorLook(l)) {
    const c = l.actor;
    return { seed: Math.floor((c.seed ?? 0.5) * 0x7fffffff), gender: c.body?.gender ?? 0.5, weight: c.body?.weight ?? 0.5, smile: 0, scale: 1 };
  }
  return { seed: l.seed >>> 0, gender: l.gender, weight: l.weight, smile: l.face.smile ?? 0, scale: l.scale };
}

/** MakeHuman age value (0 = 1 y, 0.1875 = 11 y, 0.5 = 25 y, 1 = 90 y) → years. */
export function ageYears(age: number): number {
  if (age < 0.1875) return 1 + (age / 0.1875) * 10;
  if (age < 0.5) return 11 + ((age - 0.1875) / 0.3125) * 14;
  return 25 + ((age - 0.5) / 0.5) * 65;
}

/** Scale face / body slider → Actors detail sliders (MakeHuman modifiers), with a weight each. */
const DETAILS: Record<string, [string, number][]> = {
  jaw: [['chin/chin-bones-decr-incr', 0.8]],
  chin: [['chin/chin-prominent-decr-incr', 0.8]],
  cheekbones: [['cheek/cheek-bones-decr-incr', 0.8]],
  noseSize: [['nose/nose-volume-decr-incr', 0.7]],
  noseWidth: [['nose/nose-scale-horiz-decr-incr', 0.7]],
  noseBridge: [['nose/nose-hump-decr-incr', 0.7]],
  browRidge: [['eyebrows/eyebrows-trans-backward-forward', 0.6]],
  eyeSize: [['eyes/eye-scale-decr-incr', 0.5]],
  eyeSpacing: [['eyes/eye-trans-in-out', 0.5]],
  mouthWidth: [['mouth/mouth-scale-horiz-decr-incr', 0.6]],
  lipFullness: [['mouth/mouth-upperlip-volume-decr-incr', 0.6], ['mouth/mouth-lowerlip-volume-decr-incr', 0.6]],
  earSize: [['ears/ear-scale-decr-incr', 0.6]],
  headRound: [['head/head-round', 0.5]],
  foreheadSlope: [['forehead/forehead-trans-backward-forward', 0.6]],
  cheekFullness: [['cheek/cheek-volume-decr-incr', 0.7]],
  faceWidth: [['head/head-scale-horiz-decr-incr', 0.5]],
  shoulders: [['torso/measure-shoulder-dist-decr-incr', 0.6]],
  chest: [['torso/torso-scale-depth-decr-incr', 0.4]],
  waist: [['torso/measure-waist-circ-decr-incr', 0.5]],
  hips: [['torso/measure-hips-circ-decr-incr', 0.5]],
  armLength: [['arms/measure-upperarm-length-decr-incr', 0.5], ['arms/measure-lowerarm-length-decr-incr', 0.5]],
  legLength: [['legs/upperlegs-height-decr-incr', 0.5], ['legs/lowerlegs-height-decr-incr', 0.5]],
  neck: [['neck/measure-neck-height-decr-incr', 0.5]],
  hands: [['hands/hand-scale-decr-incr', 0.5]],
  feet: [['feet/foot-scale-decr-incr', 0.5]],
  belly: [['stomach/stomach-pregnant-decr-incr', 0.35]],
};

/** Scale hairstyle → Actors hair meshes, best first (CC0 ones first: city people never need a credit). */
const HAIR: Record<string, string[]> = {
  bald: [], shaved: [],
  buzz: ['hair-short04'],
  short: ['hair-short02', 'hair-short03'],
  crop: ['hair-short03', 'hair-short02'],
  tousled: ['hair-short-messy', 'hair-short02'],
  slick: ['hair-short-slick', 'hair-short03'],
  undercut: ['hair-short-swept', 'hair-short03'],
  shoulder: ['hair-bob02', 'hair-bob01'],
  long: ['hair-long01'],
  ponytail: ['hair-ponytail01'],
  braid: ['hair-braid01'],
  braids: ['hair-double-braid', 'hair-braid01'],
  bun: ['hair-bun', 'hair-ponytail01'],
  topknot: ['hair-braid-bun-high', 'hair-ponytail01'],
  mohawk: ['hair-short-maxwell', 'hair-short04'],
  dreadlocks: ['hair-cornrows', 'hair-afro01'],
  wild: ['hair-jungle', 'hair-afro01'],
  tonsure: ['hair-short04'],
  leaves: ['leaves'], crest: ['crest'],
};

const BROWS: Record<string, string | null> = {
  none: null, thin: 'brows-eyebrow003', normal: 'brows-eyebrow001', thick: 'brows-eyebrow009', bushy: 'brows-eyebrow009',
  arched: 'brows-eyebrow006', unibrow: 'brows-eyebrow011', scaled: 'painted',
};

const BEARDS = new Set(['short', 'full', 'long', 'braided', 'forked', 'goatee', 'mustache', 'mutton', 'chinstrap']);

/**
 * An appearance as an Actors configuration (no outfit). `hair`: hair ids the character may use
 * (its catalog), so a style missing from it falls back to the next candidate.
 */
export function appearancePatch(a: HumanoidAppearance, hair: Set<string> | null): CharacterPatch {
  const details: Record<string, number> = {};
  const add = (key: string, v: number | undefined) => {
    if (!v) return;
    for (const [id, w] of DETAILS[key] ?? []) details[id] = Math.max(-1, Math.min(1, (details[id] ?? 0) + v * w));
  };
  for (const [k, v] of Object.entries(a.face)) if (k !== 'smile' && k !== 'earPoint') add(k, v as number);
  for (const [k, v] of Object.entries(a.body)) add(k, v as number);
  if (a.face.earPoint > 0.2) details['ears/ear-shape-pointed-triangle'] = -Math.min(1, a.face.earPoint);
  const style = (HAIR[a.hairStyle] ?? HAIR.short).find((h) => !hair || hair.has(h)) ?? null;
  const old = a.age > 0.75;
  return {
    race: a.race,
    race2: a.race2,
    raceMix: a.raceMix,
    // Scale's per-race size spread (0.5 = typical) from its scale factor around the race's mean.
    raceSize: 0.5,
    body: {
      gender: a.gender,
      // Adults only: Actors never builds a younger body (children show as young adults).
      ageYears: Math.max(18, ageYears(a.age)),
      muscle: a.muscle, weight: a.weight, height: a.height, proportions: a.proportions,
      cupSize: 0.5 + (a.body.chest ?? 0) * 0.3, firmness: old ? 0.35 : 0.55,
      african: a.african, asian: a.asian, caucasian: a.caucasian,
    },
    details,
    skin: 'procedural',
    skinColor: hex(a.skinTone),
    skinPattern: a.skinPattern,
    patternStrength: a.patternStrength,
    patternColor: a.skinPattern === 'none' ? null : hex(a.skinAccent),
    eyeColor: hex(a.eyeColor),
    eyeGlow: a.eyeGlow,
    pupil: a.pupil,
    seed: ((a.seed >>> 0) % 100000) / 100000,
    hair: style,
    hairColor: hex(a.hairColor),
    beard: (BEARDS.has(a.beardStyle) ? a.beardStyle : 'none') as CharacterConfig['beard'],
    stubble: a.beardStyle === 'stubble' ? 0.8 : a.gender > 0.6 && a.age > 0.4 ? 0.25 : 0,
    brows: BROWS[a.browStyle] ?? 'brows-eyebrow001',
    horns: a.horns.style,
    hornSize: a.horns.size,
    hornColor: a.horns.style === 'none' ? null : hex(a.horns.color),
    tusks: a.tusks,
    tail: a.tail.style,
    tailLength: a.tail.length,
  };
}

/** Settings every in-game character shares (the game animates them; no clip, no own blinking). */
export const GAME_PATCH: CharacterPatch = { animation: null, blink: false, anatomy: false, expression: 'neutral', expressionIntensity: 0, detail: 'high' };
