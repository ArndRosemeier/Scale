/**
 * Appearance → body shape parameters.
 *
 * Maps the normalized `HumanoidAppearance` to (a) MakeHuman macro
 * parameters, (b) weights of the local MakeHuman targets (face/body
 * modifiers, race shaping and seed-driven micro variation so no two faces
 * are alike), and (c) per-bone proportion scales for races whose skeletons
 * differ from humans (dwarves, goblins, halflings...). Pure TS.
 */
import { Rng, deriveSeed } from '../core/rng';
import type { MacroParams } from './macro';
import type { HumanoidAppearance } from './types';
import { RACE_STYLES, type BoneGroup, type BoneScale } from './races';

export interface ShapeParams {
  macro: MacroParams;
  /** Local target name → weight (≥ 0; negative directions use the partner target). */
  targets: Map<string, number>;
  bones: Partial<Record<BoneGroup, Required<BoneScale>>>;
  headScale: number;
  earTip: number;
  earSideways: number;
  /** Final uniform scale (appearance.scale). */
  scale: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Opposing target names for a signed modifier. */
const SIGNED: [string, string][] = [['decr', 'incr'], ['down', 'up'], ['in', 'out'], ['backward', 'forward'], ['concave', 'convex']];

class TargetSet {
  readonly map = new Map<string, number>();
  add(name: string, w: number) {
    if (!w) return;
    const sides = name.includes('%') ? [name.replace('%', 'l'), name.replace('%', 'r')] : [name];
    for (const n of sides) this.map.set(n, (this.map.get(n) ?? 0) + w);
  }
  /** Signed modifier: base name without suffix, v in -1..1 picks the pair member. */
  signed(base: string, v: number, pair: 0 | 1 | 2 | 3 | 4 = 0, gain = 1) {
    if (!v) return;
    const [neg, pos] = SIGNED[pair];
    this.add(`${base}-${v < 0 ? neg : pos}`, Math.abs(v) * gain);
  }
  /** Symmetric with a little asymmetry (faces are never perfectly symmetric). */
  signedLR(base: string, v: number, pair: 0 | 1 | 2 | 3 | 4, asym: number) {
    const [neg, pos] = SIGNED[pair];
    for (const [s, k] of [['l', 1 + asym], ['r', 1 - asym]] as const) {
      const w = v * k;
      if (w) this.add(`${base.replace('%', s)}-${w < 0 ? neg : pos}`, Math.abs(w));
    }
  }
}

/**
 * Collapse opposing pairs (e.g. both nose-hump-decr and -incr present) into
 * their net effect so extrapolation stays well-behaved.
 */
function netPairs(map: Map<string, number>) {
  for (const [neg, pos] of SIGNED) {
    for (const [name, w] of map) {
      if (!name.endsWith('-' + neg)) continue;
      const other = name.slice(0, -neg.length) + pos;
      const wo = map.get(other);
      if (wo === undefined) continue;
      const net = wo - w;
      map.delete(name);
      map.delete(other);
      if (net > 0) map.set(other, net);
      else if (net < 0) map.set(name, -net);
    }
  }
}

export function computeShape(a: HumanoidAppearance): ShapeParams {
  const A = RACE_STYLES[a.race];
  const B = a.race2 ? RACE_STYLES[a.race2] : A;
  const mix = a.race2 ? a.raceMix : 0;
  const male = a.gender;
  const f = a.face, b = a.body;
  const t = new TargetSet();

  // ---- macro
  const breastSize = clamp(0.5 + (1 - male) * (b.chest * 0.45 + (a.weight - 0.5) * 0.3), 0, 1);
  const breastFirmness = clamp(0.75 - Math.max(0, a.age - 0.5) * 1.1 + a.muscle * 0.1, 0, 1);
  const macro: MacroParams = {
    gender: a.gender, age: a.age, muscle: a.muscle, weight: a.weight, height: a.height, proportions: a.proportions,
    african: a.african, asian: a.asian, caucasian: a.caucasian, breastSize, breastFirmness,
  };

  // ---- appearance face modifiers
  t.signed('chin-bones', f.jaw);
  t.signed('chin-width', f.jaw, 0, 0.6);
  t.signed('chin-prominent', f.chin);
  t.signed('chin-height', f.chin, 0, 0.35);
  t.signed('%-cheek-bones', f.cheekbones);
  t.signed('nose-scale-vert', f.noseSize);
  t.signed('nose-scale-depth', f.noseSize, 0, 0.6);
  t.signed('nose-volume', f.noseSize, 0, 0.3);
  t.signed('nose-scale-horiz', f.noseWidth);
  t.signed('nose-nostrils-width', f.noseWidth, 0, 0.6);
  t.signed('nose-hump', f.noseBridge);
  t.signed('eyebrows-trans', f.browRidge, 3, 0.8);
  t.signed('forehead-nubian', f.browRidge, 0, 0.5);
  t.signed('%-eye-scale', f.eyeSize);
  t.signed('%-eye-trans', f.eyeSpacing, 2);
  t.signed('mouth-scale-horiz', f.mouthWidth);
  t.signed('mouth-upperlip-volume', f.lipFullness);
  t.signed('mouth-lowerlip-volume', f.lipFullness);
  t.signed('%-ear-scale', f.earSize);
  if (f.earPoint > 0) t.add('%-ear-shape-pointed', Math.min(1, f.earPoint));
  else t.add('%-ear-shape-round', -f.earPoint);
  if (f.headRound > 0) t.add('head-round', f.headRound * 0.8);
  else t.add('head-rectangular', -f.headRound * 0.8);
  t.signed('forehead-trans', -f.foreheadSlope, 3);

  // ---- appearance body modifiers
  t.signed('measure-shoulder-dist', b.shoulders);
  if (male > 0.5) t.signed('torso-muscle-pectoral', b.chest * male);
  t.signed('measure-bust-circ', b.chest, 0, 0.35);
  t.signed('measure-waist-circ', b.waist);
  t.signed('measure-hips-circ', b.hips);
  t.signed('hip-scale-horiz', b.hips, 0, 0.35);
  t.signed('measure-upperarm-length', b.armLength);
  t.signed('measure-lowerarm-length', b.armLength);
  t.signed('measure-upperleg-height', b.legLength);
  t.signed('measure-lowerleg-height', b.legLength);
  t.signed('measure-neck-circ', b.neck);
  t.signed('neck-scale-depth', b.neck, 0, 0.5);
  t.signed('%-hand-scale', b.hands);
  t.signed('%-foot-scale', b.feet);
  t.signed('stomach-pregnant', b.belly, 0, 0.8);
  // Muscle definition on the limbs follows the macro muscle a little more strongly.
  const mus = (a.muscle - 0.5) * 0.6;
  t.signed('%-upperarm-muscle', mus);
  t.signed('%-lowerarm-muscle', mus * 0.7);
  t.signed('%-upperleg-muscle', mus * 0.7);
  t.signed('%-lowerleg-muscle', mus * 0.5);
  // Ageing face.
  if (a.age > 0.55) t.add('head-age-incr', Math.min(1, (a.age - 0.55) * 2.2));
  if (a.age < 0.45) t.add('head-age-decr', Math.min(1, (0.45 - a.age) * 2.5));

  // ---- race shaping (blended for mixed heritage)
  for (const [name, w] of Object.entries(A.targets)) t.add(name, w * (1 - mix));
  if (a.race2) for (const [name, w] of Object.entries(B.targets)) t.add(name, w * mix);

  // ---- per-individual micro variation (seeded): makes every face unique
  const r = new Rng(deriveSeed(a.seed >>> 0, 'face-detail'));
  const g = (s: number) => clamp(r.gaussian(0, s), -1, 1);
  const asym = () => r.gaussian(0, 0.08);
  t.signed('nose-point', g(0.35), 1);
  t.signed('nose-curve', g(0.3), 4);
  t.signed('nose-flaring', g(0.35));
  t.signed('nose-point-width', g(0.35));
  t.signed('nose-greek', g(0.3));
  t.signed('nose-trans', g(0.2), 1);
  t.signed('nose-septumangle', g(0.3));
  t.signed('mouth-angles', g(0.3), 1);
  t.signed('mouth-cupidsbow', g(0.4));
  t.signed('mouth-upperlip-height', g(0.35));
  t.signed('mouth-lowerlip-height', g(0.35));
  t.signed('mouth-trans', g(0.25), 3);
  t.signed('mouth-dimples', g(0.25), 2);
  t.signed('mouth-laugh-lines', g(0.3) + Math.max(0, a.age - 0.55), 2);
  t.signed('mouth-scale-vert', g(0.25));
  t.signedLR('%-eye-corner1', g(0.35), 1, asym());
  t.signedLR('%-eye-corner2', g(0.35), 1, asym());
  t.signedLR('%-eye-epicanthus', g(0.25) + a.asian * 0.6, 2, asym() * 0.5);
  t.signedLR('%-eye-eyefold-angle', g(0.35), 1, asym());
  t.signedLR('%-eye-bag', g(0.3) + Math.max(0, a.age - 0.6) * 1.5, 0, asym());
  t.signedLR('%-eye-height2', g(0.3), 0, asym());
  t.signedLR('%-eye-eyefold', g(0.3), 4, asym() * 0.5);
  t.signedLR('%-eye-trans', g(0.2), 1, asym());
  t.signedLR('%-ear-lobe', g(0.4), 0, asym());
  t.signedLR('%-ear-rot', g(0.3), 3, asym());
  t.signedLR('%-ear-flap', g(0.35), 0, asym());
  t.signedLR('%-ear-wing', g(0.35), 0, asym());
  t.signedLR('%-ear-trans', g(0.2), 1, asym());
  t.signedLR('%-cheek-volume', g(0.35) + (a.weight - 0.5) * 0.5, 0, asym());
  t.signedLR('%-cheek-inner', g(0.3), 0, asym());
  t.signed('chin-jaw-drop', g(0.25));
  t.signed('chin-prognathism', g(0.2));
  if (r.chance(0.15)) t.add('chin-cleft-incr', r.range(0.3, 0.9));
  t.signed('forehead-scale-vert', g(0.35));
  t.signed('forehead-temple', g(0.3));
  t.signed('eyebrows-angle', g(0.35), 1);
  t.signed('eyebrows-trans', g(0.2), 1);
  t.signed('head-scale-depth', g(0.2));
  t.signed('head-scale-horiz', g(0.2));
  t.signed('head-scale-vert', g(0.2));
  t.signed('head-fat', g(0.25) + (a.weight - 0.5) * 0.6);
  const shapes = ['head-oval', 'head-triangular', 'head-invertedtriangular', 'head-diamond', 'head-square'];
  t.add(r.pick(shapes), r.range(0, 0.45));
  t.signed('neck-scale-vert', g(0.25));
  t.signed('measure-neck-height', g(0.25));
  t.signed('torso-vshape', g(0.25) + (male - 0.5) * 0.3 + (a.muscle - 0.5) * 0.4);
  t.signed('buttocks-volume', g(0.3) + (0.5 - male) * 0.3);
  t.signed('hip-waist', g(0.25), 1);
  t.signed('%-hand-fingers-length', g(0.3));
  t.signed('%-hand-fingers-diameter', g(0.25) + (a.weight - 0.5) * 0.4);
  // A body-shape archetype adds overall silhouette variety.
  const shapeSet = male > 0.5 ? ['man-trapezoid', 'man-invert-triangle', 'man-apple', 'man-lean-column'] : ['fem-full-hourglass', 'fem-triangle', 'fem-lean-column', 'fem-apple'];
  t.add(`bodyshapes-elvs-${r.pick(shapeSet)}`, r.range(0.1, 0.55));

  netPairs(t.map);

  // ---- bones
  const bones: ShapeParams['bones'] = {};
  const groups = new Set<BoneGroup>([...Object.keys(A.bones), ...Object.keys(B.bones)] as BoneGroup[]);
  for (const grp of groups) {
    const sa = A.bones[grp] ?? {}, sb = B.bones[grp] ?? {};
    bones[grp] = { len: lerp(sa.len ?? 1, sb.len ?? 1, mix), girth: lerp(sa.girth ?? 1, sb.girth ?? 1, mix) };
  }
  // Muscle/weight thicken the neck and limbs a touch beyond MakeHuman's own morphs for heroic builds.
  const earBoost = Math.max(0, f.earPoint - 0.6) * 0.8;
  return {
    macro,
    targets: t.map,
    bones,
    headScale: lerp(A.headScale, B.headScale, mix),
    earTip: Math.max(lerp(A.earTip, B.earTip, mix), 0) * clamp(f.earPoint, 0, 1.3) + earBoost,
    earSideways: lerp(A.earSideways, B.earSideways, mix),
    scale: a.scale,
  };
}
