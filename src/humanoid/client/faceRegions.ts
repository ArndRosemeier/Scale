/**
 * Facial region functions in *face coordinates* (inter-pupil-distance
 * units, origin between the eyes of the neutral mesh: x lateral, y up,
 * z forward). The same definitions exist in GLSL (`GLSL_FACE`) for painted
 * features in the skin shader and in TS for placing hair/beard card roots,
 * so painted stubble and 3D beard hair always agree.
 */

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Beard style ids shared by shader and generator. */
export const BEARD_IDS: Record<string, number> = {
  none: -1, stubble: 0, short: 0, full: 0, long: 0, braided: 0, forked: 0, goatee: 1, mustache: 2, mutton: 3, chinstrap: 4,
};

/** Coverage (0..1) of facial hair for a style id at face coordinate (x,y,z). */
export function beardCoverage(style: number, x: number, y: number, z: number): number {
  if (style < 0) return 0;
  const ax = Math.abs(x);
  // Upper boundary: cheek line rising toward the sideburns; lower: under the jaw onto the neck.
  const cheek = -0.82 + 0.62 * smoothstep(0.35, 1.25, ax);
  const upper = 1 - smoothstep(cheek - 0.06, cheek + 0.06, y);
  const side = smoothstep(-1.45, -1.05, z); // not behind the ears
  const neck = smoothstep(-2.25, -1.95, y + 0.25 * ax) * (1 - smoothstep(1.3, 1.6, ax));
  const front = upper * side * neck;
  // The lips themselves stay bare.
  const lipZone = smoothstep(0.38, 0.5, Math.hypot(x / 1.1, (y + 1.18) / 0.36));
  const mustache = (1 - smoothstep(0.5, 0.62, ax)) * smoothstep(-1.12, -1.02, y) * (1 - smoothstep(-0.86, -0.78, y));
  const chin = (1 - smoothstep(0.42, 0.56, ax)) * (1 - smoothstep(-1.36, -1.28, y)) * smoothstep(-2.1, -1.95, y);
  switch (style) {
    case 0: return Math.max(front * lipZone, mustache);
    case 1: return Math.max(chin, mustache) * side;
    case 2: return mustache;
    case 3: return front * smoothstep(0.5, 0.75, ax) * lipZone;
    case 4: return front * smoothstep(-1.75, -1.6, -y - 0.18 * ax) * lipZone;
  }
  return 0;
}

/** Scalp hair coverage (1 = scalp). `recede` 0..1 pushes the hairline back (age). */
export function scalpCoverage(x: number, y: number, z: number, recede: number): number {
  const ax = Math.abs(x);
  const hairline = 1.05 + 0.18 * ax * ax + recede * (0.45 + 0.4 * smoothstep(0.2, 0.8, ax));
  const front = smoothstep(hairline - 0.08, hairline + 0.08, y);
  // Above/behind the ears and the nape at the back.
  const sides = smoothstep(-0.55, -0.85, z) * smoothstep(-0.05, 0.25, y + 0.35 * smoothstep(-1.2, -2.0, z));
  const nape = smoothstep(-1.05, -1.35, z) * smoothstep(-2.2, -1.8, y);
  return Math.min(1, Math.max(front, sides, nape)) * (y > -2.6 ? 1 : 0);
}

export const GLSL_FACE = /* glsl */ `
float h_beardCoverage(float style, vec3 f) {
  if (style < 0.0) return 0.0;
  float ax = abs(f.x);
  float cheek = -0.82 + 0.62 * smoothstep(0.35, 1.25, ax);
  float upper = 1.0 - smoothstep(cheek - 0.06, cheek + 0.06, f.y);
  float side = smoothstep(-1.45, -1.05, f.z);
  float neck = smoothstep(-2.25, -1.95, f.y + 0.25 * ax) * (1.0 - smoothstep(1.3, 1.6, ax));
  float front = upper * side * neck;
  float mouthGap = smoothstep(0.38, 0.5, length(vec2(f.x / 1.1, (f.y + 1.18) / 0.36)));
  float mustache = (1.0 - smoothstep(0.5, 0.62, ax)) * smoothstep(-1.12, -1.02, f.y) * (1.0 - smoothstep(-0.86, -0.78, f.y));
  float chin = (1.0 - smoothstep(0.42, 0.56, ax)) * (1.0 - smoothstep(-1.36, -1.28, f.y)) * smoothstep(-2.1, -1.95, f.y);
  if (style < 0.5) return max(front * mouthGap, mustache);
  if (style < 1.5) return max(chin, mustache) * side;
  if (style < 2.5) return mustache;
  if (style < 3.5) return front * smoothstep(0.5, 0.75, ax) * mouthGap;
  return front * smoothstep(-1.75, -1.6, -f.y - 0.18 * ax) * mouthGap;
}
float h_scalpCoverage(vec3 f, float recede) {
  float ax = abs(f.x);
  float hairline = 1.05 + 0.18 * ax * ax + recede * (0.45 + 0.4 * smoothstep(0.2, 0.8, ax));
  float front = smoothstep(hairline - 0.08, hairline + 0.08, f.y);
  float sides = smoothstep(-0.55, -0.85, f.z) * smoothstep(-0.05, 0.25, f.y + 0.35 * smoothstep(-1.2, -2.0, f.z));
  float nape = smoothstep(-1.05, -1.35, f.z) * smoothstep(-2.2, -1.8, f.y);
  return min(1.0, max(front, max(sides, nape))) * step(-2.6, f.y);
}
/** Eyebrow: x = coverage, y = along-brow coordinate (0 inner..1 outer). br = (thickness, arch, unibrow, density). */
vec2 h_brow(vec3 f, vec4 br) {
  float ax = abs(f.x);
  float u = (ax - 0.17) / 0.86;
  float uc = clamp(u, 0.0, 1.0);
  float cy = 0.2 + br.y * 0.1 * sin(uc * 2.7) - 0.09 * uc * uc;
  float th = br.x * mix(0.085, 0.05, uc);
  float d = abs(f.y - cy) / max(th, 1e-3);
  float m = (1.0 - smoothstep(0.55, 1.05, d)) * smoothstep(-0.12, 0.04, u) * (1.0 - smoothstep(0.88, 1.05, u));
  m = max(m, br.z * (1.0 - smoothstep(0.12, 0.2, ax)) * (1.0 - smoothstep(0.5, 1.0, abs(f.y - 0.19) / 0.07)));
  m *= smoothstep(-0.55, -0.3, f.z);
  return vec2(m, u);
}
`;
