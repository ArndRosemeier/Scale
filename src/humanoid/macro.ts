/**
 * MakeHuman 1.1 macro modifier weighting, re-implemented exactly.
 *
 * MakeHuman's "macro" sliders (gender, age, muscle, weight, height,
 * proportions, ethnicity, breast size/firmness) do not map to one target each.
 * Instead every macro target file name encodes a combination of discrete
 * variable values (e.g. `universal-female-young-maxmuscle-averageweight`), and
 * its weight is the product of the interpolation factors of those values.
 * This module computes those factors from the continuous 0..1 parameters and
 * the per-target weights. It is shared by the Node asset converter (which
 * evaluates it to build the compressed PCA basis) and the runtime (which uses
 * the same weights to compute PCA coefficients through the per-target
 * projection matrix), so both sides agree bit-for-bit on the weighting.
 *
 * Pure TS, no DOM/three.js: safe in workers and Node.
 */

/** Continuous macro parameters, all 0..1 (MakeHuman conventions). */
export interface MacroParams {
  gender: number;
  /** 0 = 1 year, 0.1875 = 11, 0.5 = 25, 1 = 90. */
  age: number;
  muscle: number;
  weight: number;
  height: number;
  proportions: number;
  african: number;
  asian: number;
  caucasian: number;
  /** Breast size (cup), 0.5 = average. */
  breastSize: number;
  /** Breast firmness, 0.5 = average. */
  breastFirmness: number;
}

/** Discrete variable values that may appear in a macro target name. */
export type MacroVar =
  | 'female' | 'male'
  | 'baby' | 'child' | 'young' | 'old'
  | 'minmuscle' | 'averagemuscle' | 'maxmuscle'
  | 'minweight' | 'averageweight' | 'maxweight'
  | 'minheight' | 'maxheight'
  | 'idealproportions' | 'uncommonproportions'
  | 'african' | 'asian' | 'caucasian'
  | 'mincup' | 'averagecup' | 'maxcup'
  | 'minfirmness' | 'averagefirmness' | 'maxfirmness';

export const MACRO_VARS: readonly MacroVar[] = [
  'female', 'male', 'baby', 'child', 'young', 'old',
  'minmuscle', 'averagemuscle', 'maxmuscle', 'minweight', 'averageweight', 'maxweight',
  'minheight', 'maxheight', 'idealproportions', 'uncommonproportions',
  'african', 'asian', 'caucasian', 'mincup', 'averagecup', 'maxcup',
  'minfirmness', 'averagefirmness', 'maxfirmness',
];

/** Factor value per discrete variable for a parameter set. */
export type MacroFactors = Record<MacroVar, number>;

/** Three-way min/average/max split used by muscle, weight, cup and firmness. */
function tri(v: number): [number, number, number] {
  if (v < 0.5) {
    const mn = 1 - v * 2;
    return [mn, 1 - mn, 0];
  }
  const mx = v * 2 - 1;
  return [0, 1 - mx, mx];
}

/** Compute MakeHuman's interpolation factors (human.py `_set*Vals`). */
export function macroFactors(p: MacroParams, out?: MacroFactors): MacroFactors {
  const f = out ?? ({} as MacroFactors);
  f.male = p.gender;
  f.female = 1 - p.gender;

  // Age: baby (1y) — child (11y) — young (25y) — old (90y) at 0, 0.1875, 0.5, 1.
  const a = p.age;
  if (a < 0.5) {
    f.old = 0;
    f.baby = Math.max(0, 1 - a * 5.333);
    f.young = Math.max(0, (a - 0.1875) * 3.2);
    f.child = Math.max(0, Math.min(1, 5.333 * a) - f.young);
  } else {
    f.child = 0;
    f.baby = 0;
    f.old = Math.max(0, a * 2 - 1);
    f.young = 1 - f.old;
  }

  [f.minmuscle, f.averagemuscle, f.maxmuscle] = tri(p.muscle);
  [f.minweight, f.averageweight, f.maxweight] = tri(p.weight);
  [f.mincup, f.averagecup, f.maxcup] = tri(p.breastSize);
  [f.minfirmness, f.averagefirmness, f.maxfirmness] = tri(p.breastFirmness);

  // Height & proportions have no "average" target: average is the zero shape.
  if (p.height < 0.5) {
    f.minheight = 1 - p.height * 2;
    f.maxheight = 0;
  } else {
    f.minheight = 0;
    f.maxheight = p.height * 2 - 1;
  }
  if (p.proportions < 0.5) {
    f.uncommonproportions = 1 - p.proportions * 2;
    f.idealproportions = 0;
  } else {
    f.uncommonproportions = 0;
    f.idealproportions = p.proportions * 2 - 1;
  }

  // Ethnic weights are normalized to sum 1 like MakeHuman's EthnicModifier.
  const s = p.african + p.asian + p.caucasian;
  const inv = s > 1e-6 ? 1 / s : 0;
  f.african = s > 1e-6 ? p.african * inv : 1 / 3;
  f.asian = s > 1e-6 ? p.asian * inv : 1 / 3;
  f.caucasian = s > 1e-6 ? p.caucasian * inv : 1 / 3;
  return f;
}

/** Parse a macro target file stem ("universal-female-young-maxmuscle-averageweight") into its variables. */
export function parseMacroTargetName(stem: string): MacroVar[] {
  const vars: MacroVar[] = [];
  for (const part of stem.split('-')) {
    if (part === 'universal') continue;
    if (!(MACRO_VARS as readonly string[]).includes(part)) throw new Error(`unknown macro variable "${part}" in ${stem}`);
    vars.push(part as MacroVar);
  }
  return vars;
}

/** Variable indices per target, compact form stored in the asset manifest. */
export type MacroTargetVars = number[][];

/** Encode variable lists as indices into MACRO_VARS. */
export function encodeMacroVars(names: string[]): MacroTargetVars {
  return names.map((n) => parseMacroTargetName(n).map((v) => MACRO_VARS.indexOf(v)));
}

/**
 * Weight of every macro target for a parameter set (product of its variable
 * factors). `out` must have one entry per target.
 */
export function macroTargetWeights(p: MacroParams, targets: MacroTargetVars, out: Float64Array): Float64Array {
  const f = macroFactors(p);
  const fv = MACRO_VARS.map((v) => f[v]);
  for (let t = 0; t < targets.length; t++) {
    let w = 1;
    const vars = targets[t];
    for (let i = 0; i < vars.length; i++) w *= fv[vars[i]];
    out[t] = w;
  }
  return out;
}
