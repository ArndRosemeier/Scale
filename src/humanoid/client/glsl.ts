/**
 * GLSL helper snippets shared by the humanoid materials (skin, eyes, hair,
 * garments): hashing, value/gradient noise, fbm, Voronoi cells. Kept small
 * and branch-free; all functions are prefixed `h_` to avoid clashes with
 * three.js chunks.
 */
export const GLSL_NOISE = /* glsl */ `
float h_hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
vec3 h_hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float h_hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 h_hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float h_noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float a = h_hash13(i), b = h_hash13(i + vec3(1, 0, 0)), c = h_hash13(i + vec3(0, 1, 0)), d = h_hash13(i + vec3(1, 1, 0));
  float e = h_hash13(i + vec3(0, 0, 1)), f1 = h_hash13(i + vec3(1, 0, 1)), g = h_hash13(i + vec3(0, 1, 1)), h = h_hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, f1, u.x), mix(g, h, u.x), u.y), u.z);
}
float h_noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h_hash12(i), h_hash12(i + vec2(1, 0)), u.x), mix(h_hash12(i + vec2(0, 1)), h_hash12(i + vec2(1, 1)), u.x), u.y);
}
float h_fbm3(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * h_noise3(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
float h_fbm2(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * h_noise2(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
/** Voronoi: x = F1 distance, y = F2 distance, z = cell id hash. */
vec3 h_voronoi3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0, id = 0.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 o = h_hash33(i + g);
    vec3 r = g + o - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = h_hash13(i + g + 7.7); } else if (d < d2) { d2 = d; }
  }
  return vec3(sqrt(d1), sqrt(d2), id);
}
vec3 h_voronoi2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = h_hash22(i + g);
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = h_hash12(i + g + 7.7); } else if (d < d2) { d2 = d; }
  }
  return vec3(sqrt(d1), sqrt(d2), id);
}
vec3 h_srgbToLinear(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }
`;
