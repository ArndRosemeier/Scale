/**
 * A colour key over the day: grade values at sun heights, blended between them. Pure (no three.js),
 * so a setting can carry its keys as data; feed the result into GRADE each frame.
 */
export type Rgb = readonly [number, number, number];

export interface GradeKey {
  /** Sun height (sin of its elevation, -1..1) this key belongs to. */
  readonly at: number;
  /** Per-channel gain (the grade's slope): above 1 warms or cools that channel. */
  readonly slope: Rgb;
  /** 1 leaves saturation as it is. */
  readonly saturation: number;
}

/** The grade at sun height `sun`: smooth between the two nearest keys (sorted by `at`), held past the ends. */
export function gradeAt(keys: readonly GradeKey[], sun: number): { slope: [number, number, number]; saturation: number } {
  if (!keys.length) return { slope: [1, 1, 1], saturation: 1 };
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1]!.at <= sun) i++;
  const a = keys[i]!, b = keys[Math.min(i + 1, keys.length - 1)]!;
  const span = b.at - a.at;
  const x = span > 0 ? Math.min(1, Math.max(0, (sun - a.at) / span)) : 0;
  const t = x * x * (3 - 2 * x);
  const mix = (p: number, q: number): number => p + (q - p) * t;
  return { slope: [mix(a.slope[0], b.slope[0]), mix(a.slope[1], b.slope[1]), mix(a.slope[2], b.slope[2])], saturation: mix(a.saturation, b.saturation) };
}
