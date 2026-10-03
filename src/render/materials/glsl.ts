/** Shared GLSL snippets. */

export const GLSL_COMMON = /* glsl */ `
float h11(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float h31(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
}
float fbm2(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}
// Tangent-space normal (xy, strength) to view space using screen derivatives (no tangents needed).
vec3 perturbNormalUV(vec3 eyePos, vec3 N, vec2 uv, vec2 tn, float strength) {
  vec3 q0 = dFdx(eyePos), q1 = dFdy(eyePos);
  vec2 st0 = dFdx(uv), st1 = dFdy(uv);
  vec3 q1perp = cross(q1, N), q0perp = cross(N, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float sc = det == 0.0 ? 0.0 : inversesqrt(det);
  vec2 t = tn * strength;
  vec3 mapN = vec3(t, sqrt(max(0.0, 1.0 - dot(t, t))));
  return normalize(T * (mapN.x * sc) + B * (mapN.y * sc) + N * mapN.z);
}
`;

/** Vertex snippet: collapse vertices of destroyed elements (state texture). */
export const GLSL_ELEM_VERTEX_DECL = /* glsl */ `
attribute float aElem;
uniform sampler2D uElemTex;
uniform int uElemW;
varying float vOpen;
vec2 elemState() {
  int e = int(aElem + 0.5);
  return texelFetch(uElemTex, ivec2(e % uElemW, e / uElemW), 0).rg;
}
`;
export const GLSL_ELEM_VERTEX_MAIN = /* glsl */ `
{ vec2 es = elemState(); vOpen = 1.0 - es.g; if (es.r < 0.5) gl_Position = vec4(0.0, 0.0, 0.0, 0.0); }
`;
