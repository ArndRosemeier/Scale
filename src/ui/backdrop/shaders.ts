/**
 * The start screen backdrop's four shaders (sky, ground, buildings, lights). Plain WebGL 2, no
 * textures: windows, streets and stars are drawn from coordinates. They share the sky colour, the
 * fog and the tone curve below, so the city sits in the same dusk air as its sky.
 */

const COMMON = /* glsl */ `#version 300 es
precision highp float;
uniform float u_time;
uniform vec3 u_cam;
uniform vec3 u_sun;
uniform float u_fade;

float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float hash31(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }

// Dusk: deep blue overhead, a warm band low towards the set sun, the city's own glow at the horizon.
vec3 sky(vec3 d) {
  float h = d.y;
  vec2 dh = normalize(d.xz + 1e-5);
  float toSun = dot(dh, normalize(u_sun.xz)) * 0.5 + 0.5;
  vec3 zen = vec3(0.012, 0.026, 0.075);
  vec3 mid = vec3(0.075, 0.13, 0.26);
  vec3 hor = mix(vec3(0.14, 0.13, 0.22), vec3(1.05, 0.50, 0.22), toSun * toSun * toSun);
  float t = max(h, 0.0);
  vec3 c = mix(hor, mid, smoothstep(0.0, 0.2, t));
  c = mix(c, zen, smoothstep(0.16, 0.75, t));
  float g = max(dot(d, u_sun), 0.0);
  c += vec3(1.0, 0.42, 0.16) * (pow(g, 10.0) * 0.55 + pow(g, 90.0) * 0.8);
  c += vec3(0.30, 0.15, 0.07) * exp(-t * 14.0) * 0.35;
  return c;
}

vec3 fog(vec3 col, vec3 p) {
  vec3 v = p - u_cam;
  float d = length(v);
  float f = 1.0 - exp(-pow(d / 2300.0, 1.6));
  // Haze gathers low over the streets.
  f = max(f, (1.0 - exp(-d / 3200.0)) * exp(-max(p.y, 0.0) / 60.0) * 0.5);
  return mix(col, sky(v / d), clamp(f, 0.0, 1.0));
}

vec3 tone(vec3 x) {
  x *= 1.05;
  x = clamp(x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  return pow(x, vec3(1.0 / 2.2)) * u_fade;
}

vec4 finish(vec3 col) {
  // A little noise against banding in the long gradients.
  return vec4(tone(col) + (hash21(gl_FragCoord.xy + fract(u_time) * 61.0) - 0.5) / 255.0, 1.0);
}
`;

export const SKY_VS = /* glsl */ `#version 300 es
// A full-screen triangle; each corner carries its view ray (forward plus scaled right and up).
uniform vec3 u_fwd;
uniform vec3 u_right;
uniform vec3 u_up;
out vec3 v_dir;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  v_dir = u_fwd + p.x * u_right + p.y * u_up;
  gl_Position = vec4(p, 1.0, 1.0);
}`;

export const SKY_FS = COMMON + /* glsl */ `
in vec3 v_dir;
out vec4 o;

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  vec3 d = normalize(v_dir);
  vec3 c = sky(d);
  float h = d.y;
  if (h > 0.0) {
    // Thin clouds, lit from below on the sunset side.
    vec2 q = d.xz / (h + 0.12) * 1.6 + vec2(u_time * 0.006, u_time * 0.002);
    float n = noise(q) * 0.55 + noise(q * 2.1 + 3.7) * 0.28 + noise(q * 4.3 + 7.1) * 0.17;
    float cl = smoothstep(0.52, 0.8, n) * smoothstep(0.0, 0.08, h) * (1.0 - smoothstep(0.35, 0.7, h));
    float lit = pow(max(dot(normalize(d.xz + 1e-5), normalize(u_sun.xz)), 0.0), 2.0);
    vec3 cc = mix(vec3(0.16, 0.13, 0.20), vec3(0.95, 0.42, 0.30), lit * 0.85);
    c = mix(c, cc, cl * 0.75);
    // Stars come out higher up.
    vec2 s = d.xz / (h + 0.35) * 220.0;
    vec2 cell = floor(s);
    float r = hash21(cell);
    if (r > 0.985) {
      vec2 off = vec2(hash21(cell + 17.0), hash21(cell + 31.0)) * 0.6 + 0.2;
      float st = smoothstep(0.16, 0.0, length(fract(s) - off));
      float tw = 0.65 + 0.35 * sin(u_time * (1.5 + r * 40.0) + r * 300.0);
      c += vec3(0.85, 0.9, 1.0) * st * tw * smoothstep(0.12, 0.5, h) * (1.0 - cl) * ((r - 0.985) * 120.0);
    }
  }
  o = finish(c);
}`;

export const GROUND_VS = /* glsl */ `#version 300 es
uniform mat4 u_viewProj;
in vec2 a_pos;
out vec3 v_world;
void main() {
  v_world = vec3(a_pos.x, 0.0, a_pos.y);
  gl_Position = u_viewProj * vec4(v_world, 1.0);
}`;

export const GROUND_FS = (pitch: number, half: number, reach: number) => COMMON + /* glsl */ `
in vec3 v_world;
out vec4 o;
const float PITCH = ${pitch.toFixed(1)};
const float HALF = ${half.toFixed(1)};
const float REACH = ${((reach + 0.5) * pitch).toFixed(1)};

void main() {
  vec2 p = v_world.xz;
  vec2 l = p - PITCH * floor(p / PITCH + 0.5);
  vec2 a = abs(l);
  float inCity = step(max(abs(p.x), abs(p.y)), REACH);
  float street = max(step(HALF, a.x), step(HALF, a.y));
  float walk = (1.0 - street) * max(step(HALF - 3.0, a.x), step(HALF - 3.0, a.y));
  vec3 c = mix(vec3(0.05, 0.05, 0.055), vec3(0.11, 0.105, 0.10), walk);
  c = mix(c, vec3(0.035, 0.036, 0.04), street);
  // Street lamps along the kerbs: warm pools, faded where they get smaller than a pixel.
  vec2 sl = mod(p + 12.0, 24.0) - 12.0;
  vec2 kerb = vec2(abs(a.x - HALF - 1.0), abs(a.y - HALF - 1.0));
  float pool = exp(-(kerb.x * kerb.x + sl.y * sl.y) / 30.0) + exp(-(kerb.y * kerb.y + sl.x * sl.x) / 30.0);
  float px = length(fwidth(p));
  vec3 lamp = vec3(1.0, 0.58, 0.25);
  c += lamp * mix(pool * 0.5, 0.05, smoothstep(2.0, 6.0, px)) * inCity;
  // Wet-looking asphalt picks up a hint of sky.
  c += sky(reflect(normalize(v_world - u_cam), vec3(0, 1, 0))) * 0.06 * street;
  c = mix(vec3(0.03, 0.035, 0.04), c, inCity);
  o = finish(fog(c, v_world));
}`;

export const BUILDING_VS = /* glsl */ `#version 300 es
uniform mat4 u_viewProj;
in vec3 a_pos;
in vec3 a_norm;
in vec4 a_box;   // centre x, centre z, width, depth
in vec4 a_box2;  // base y, height, style, seed
out vec3 v_world;
out vec3 v_norm;
flat out vec4 v_box;
flat out vec4 v_box2;
void main() {
  vec3 w = vec3(a_box.x + a_pos.x * a_box.z, a_box2.x + a_pos.y * a_box2.y, a_box.y + a_pos.z * a_box.w);
  v_world = w;
  v_norm = a_norm;
  v_box = a_box;
  v_box2 = a_box2;
  gl_Position = u_viewProj * vec4(w, 1.0);
}`;

export const BUILDING_FS = COMMON + /* glsl */ `
in vec3 v_world;
in vec3 v_norm;
flat in vec4 v_box;
flat in vec4 v_box2;
out vec4 o;

// Per style: wall colour, window spacing (x) and floor height (y), window size within the cell (zw).
const vec3 WALL[6] = vec3[6](vec3(0.30, 0.15, 0.11), vec3(0.50, 0.41, 0.30), vec3(0.34, 0.34, 0.35), vec3(0.05, 0.08, 0.11), vec3(0.06, 0.06, 0.07), vec3(0.62, 0.62, 0.60));
const vec4 WIN[6] = vec4[6](vec4(3.4, 3.3, 0.45, 0.55), vec4(3.6, 3.4, 0.42, 0.58), vec4(3.0, 3.3, 0.6, 0.45), vec4(1.6, 3.6, 0.92, 0.78), vec4(2.4, 3.6, 0.55, 0.7), vec4(4.2, 3.6, 0.7, 0.6));

void main() {
  int style = int(v_box2.z + 0.5);
  float seed = v_box2.w;
  vec3 n = normalize(v_norm);
  vec3 view = normalize(v_world - u_cam);
  vec3 wall = WALL[min(style, 5)] * (0.8 + 0.4 * hash11(seed * 91.0));
  // Light: the last of the sun from low in the west, the sky from above, the streets' glow from below.
  float sunL = max(dot(n, normalize(vec3(u_sun.x, 0.25, u_sun.z))), 0.0);
  vec3 amb = mix(vec3(0.035, 0.045, 0.085), vec3(0.07, 0.08, 0.14), n.y * 0.5 + 0.5);
  vec3 light = amb + vec3(1.0, 0.45, 0.2) * sunL * 0.32 + vec3(0.7, 0.36, 0.15) * exp(-v_world.y / 18.0) * 0.4;
  vec3 c;
  if (style == 6) {
    // Park: clumps of trees in the dusk, a few path lamps.
    vec2 q = v_world.xz / 5.0;
    float tree = hash21(floor(q)) * 0.6 + hash21(floor(q * 0.5) + 7.0) * 0.4;
    c = vec3(0.025, 0.05, 0.03) * (0.4 + tree) * (light * 3.0);
    vec2 lp = fract(v_world.xz / 26.0) - 0.5;
    c += vec3(1.0, 0.6, 0.3) * exp(-dot(lp, lp) * 900.0) * 0.6;
  } else if (n.y > 0.5) {
    // Roof: dark tar, a lighter parapet.
    vec2 r = abs(v_world.xz - v_box.xy) / (v_box.zw * 0.5);
    float edge = step(1.0 - 1.2 / min(v_box.z, v_box.w) * 2.0, max(r.x, r.y));
    c = mix(vec3(0.07, 0.07, 0.075), wall * 1.1, edge) * light;
  } else {
    vec4 win = WIN[style];
    float u = abs(n.x) > 0.5 ? v_world.z * sign(n.x) : -v_world.x * sign(n.z);
    float v = v_world.y;
    vec2 g = vec2(u / win.x, v / win.y);
    vec2 cell = floor(g);
    vec2 f = fract(g) - 0.5;
    vec2 aa = fwidth(g) * 1.5;
    vec2 m2 = smoothstep(win.zw * 0.5 + aa, win.zw * 0.5 - aa, abs(f));
    float mask = m2.x * m2.y;
    // Glass curtain walls show their floors as bands.
    if (style == 3) mask *= 0.85 + 0.15 * step(0.38, abs(f.y));
    // Which windows are lit changes now and then, each on its own clock.
    float side = dot(n, vec3(1.0, 2.0, 3.0));
    float id = hash31(vec3(cell, side + seed * 57.0));
    float epoch = floor(u_time / (22.0 + id * 40.0) + id * 9.0);
    float share = 0.08 + 0.32 * hash11(seed * 13.0);
    float on = step(hash31(vec3(cell + epoch * 7.0, seed * 19.0 + side)), share);
    float k = hash11(id * 77.0);
    vec3 lit = k < 0.7 ? vec3(1.0, 0.6, 0.28) : k < 0.93 ? vec3(0.85, 0.82, 0.72) : vec3(0.45, 0.6, 1.0) * (0.75 + 0.25 * sin(u_time * 7.0 + id * 40.0));
    lit *= 0.8 + id * 1.1;
    vec3 glass = sky(reflect(view, n)) * 0.12 + vec3(0.004, 0.006, 0.01);
    vec3 winC = mix(glass, lit, on);
    // Shops along the ground floor of the street walls.
    if (v_box2.x < 0.5 && v < 4.2) {
      float shop = step(0.8, v) * step(hash31(vec3(cell.x, side, seed)), 0.6);
      winC = mix(glass, vec3(1.0, 0.75, 0.45) * 1.6, shop);
      mask = smoothstep(0.5, 0.45, abs(f.x)) * step(0.8, v) * step(v, 3.4);
    }
    // Far away the grid is finer than a pixel: show its average instead of flicker.
    float far = smoothstep(0.35, 0.9, max(aa.x, aa.y));
    vec3 avg = mix(wall * light, glass * 0.6 + lit * share * 0.8, win.z * win.w);
    c = mix(mix(wall * light, winC, mask), avg, far);
    // Darker where the walls meet the street.
    if (v_box2.x < 0.5) c *= mix(0.55, 1.0, smoothstep(0.0, 10.0, v));
    // Lit crowns on the tall towers.
    float top = v_box2.x + v_box2.y;
    if (top > 110.0 && style >= 3) {
      float band = smoothstep(top - 4.0, top - 3.2, v) * smoothstep(top - 0.4, top - 1.0, v);
      vec3 cc = hash11(seed * 5.0) < 0.5 ? vec3(1.0, 0.72, 0.38) : vec3(0.55, 0.8, 1.0);
      c += cc * band * 1.4;
    }
  }
  o = finish(fog(c, v_world));
}`;

export const LIGHT_VS = /* glsl */ `#version 300 es
precision highp float;
uniform mat4 u_viewProj;
uniform float u_time;
uniform vec3 u_cam;
uniform float u_pxScale;
uniform float u_fade;
in vec4 a_p;
in vec4 a_q;
out vec3 v_col;

float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }

void main() {
  int kind = int(a_p.w + 0.5);
  vec3 pos;
  vec3 col;
  float size;
  if (kind == 0) {
    // Car: a lane along x (a_p.x = 0) or z; start, signed speed, street length.
    float s = mod(a_q.x + a_q.y * u_time, a_q.z) - a_q.z * 0.5;
    pos = a_p.x < 0.5 ? vec3(s, a_p.y, a_p.z) : vec3(a_p.z, a_p.y, s);
    vec3 dir = a_p.x < 0.5 ? vec3(sign(a_q.y), 0.0, 0.0) : vec3(0.0, 0.0, sign(a_q.y));
    float toward = dot(dir, normalize(u_cam - pos));
    col = toward > 0.0 ? vec3(1.0, 0.9, 0.7) * 1.6 : vec3(1.0, 0.12, 0.06) * 1.1;
    size = toward > 0.0 ? 3.0 : 2.4;
  } else if (kind == 1) {
    // Beacon: a slow red pulse.
    pos = a_p.xyz;
    float b = pow(max(sin(u_time * 1.9 + a_q.x), 0.0), 6.0);
    col = vec3(1.0, 0.08, 0.04) * (0.25 + 2.2 * b);
    size = 7.0;
  } else if (kind == 2) {
    // Aircraft: wide circles high up, a white strobe.
    float a = a_q.x + u_time * a_q.y;
    pos = vec3(cos(a) * a_q.z, a_p.y, sin(a) * a_q.z);
    float strobe = step(0.93, fract(u_time * 0.8 + a_q.w * 0.37));
    col = mix(vec3(1.0, 0.15, 0.1) * 0.8, vec3(1.6), strobe);
    size = 14.0;
  } else {
    // The hero: a golden streak past the towers every so often, its trail a moment behind.
    const float PERIOD = 17.0;
    const float FLIGHT = 6.5;
    float tt = u_time - a_q.x * 0.9;
    float k = floor(tt / PERIOD);
    float u = (tt - k * PERIOD) / FLIGHT;
    float h = hash11(k * 3.7 + a_q.y);
    float ang = h * 6.2832;
    vec2 dirH = vec2(cos(ang), sin(ang));
    vec2 side = vec2(-dirH.y, dirH.x);
    vec2 c = a_p.xz + side * (hash11(k + 9.1) - 0.5) * 300.0;
    vec2 xz = c + dirH * (u - 0.5) * 1700.0 + side * sin(u * 3.1416) * 160.0 * (h - 0.5);
    float alt = 120.0 + hash11(k + 2.3) * 140.0 + sin(u * 3.1416) * 70.0;
    pos = vec3(xz.x, alt, xz.y);
    float fadeT = 1.0 - a_q.x;
    col = mix(vec3(1.0, 0.25, 0.08), vec3(1.0, 0.85, 0.5), fadeT * fadeT) * (a_q.x < 0.01 ? 4.0 : 1.6 * fadeT);
    size = a_q.x < 0.01 ? 16.0 : 10.0 * (0.4 + 0.6 * fadeT);
    if (u < 0.0 || u > 1.0) col = vec3(0.0);
  }
  vec4 clip = u_viewProj * vec4(pos, 1.0);
  float px = size * u_pxScale / max(clip.w, 1.0);
  float d = length(pos - u_cam);
  float att = exp(-d / 2400.0);
  // Smaller than about two pixels: keep two pixels, dim instead.
  float dim = min(px / 2.0, 1.0);
  gl_PointSize = clamp(px, 2.0, 96.0);
  v_col = col * att * dim * dim * u_fade;
  gl_Position = clip;
}`;

export const LIGHT_FS = /* glsl */ `#version 300 es
precision mediump float;
in vec3 v_col;
out vec4 o;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = exp(-r * r * 5.0) + 0.25 * exp(-r * r * 1.5) - 0.06;
  o = vec4(v_col * max(a, 0.0), 1.0);
}`;

/** Saucers (u_mode 0) and their beams (u_mode 1): one instance per saucer, poses from uniforms (ufos.ts). */
export const UFO_VS = (max: number) => /* glsl */ `#version 300 es
uniform mat4 u_viewProj;
uniform vec4 u_ufo[${max}];   // x, y, z, spin
uniform vec4 u_ufo2[${max}];  // tilt axis * angle (x, z), radius, beam
uniform float u_mode;
in vec3 a_pos;
in vec3 a_norm;
out vec3 v_world;
out vec3 v_norm;
out vec3 v_local;
flat out vec4 v_u;
flat out vec4 v_u2;

vec3 rot(vec3 v, vec3 k, float a) {
  return v * cos(a) + cross(k, v) * sin(a) + k * dot(k, v) * (1.0 - cos(a));
}

void main() {
  vec4 u = u_ufo[gl_InstanceID];
  vec4 u2 = u_ufo2[gl_InstanceID];
  vec3 p, n;
  if (u_mode > 0.5) {
    // Beam: from under the saucer down to the street, widening.
    p = vec3(a_pos.x * a_norm.x * u2.z, a_pos.y * (u.y - 2.0) - u2.z * 0.2, a_pos.z * a_norm.x * u2.z);
    n = normalize(vec3(a_pos.x, 0.0, a_pos.z));
  } else {
    float ta = length(u2.xy);
    vec3 k = ta > 1e-4 ? vec3(u2.x, 0.0, u2.y) / ta : vec3(1.0, 0.0, 0.0);
    p = rot(a_pos * u2.z, k, ta);
    n = rot(a_norm, k, ta);
  }
  v_local = a_pos;
  v_world = u.xyz + p;
  v_norm = n;
  v_u = u;
  v_u2 = u2;
  gl_Position = u_viewProj * vec4(v_world, 1.0);
}`;

export const UFO_FS = COMMON + /* glsl */ `
in vec3 v_world;
in vec3 v_norm;
in vec3 v_local;
flat in vec4 v_u;
flat in vec4 v_u2;
out vec4 o;
void main() {
  vec3 n = normalize(v_norm);
  vec3 view = normalize(v_world - u_cam);
  if (dot(n, view) > 0.0) n = -n;
  float y = v_local.y, r = length(v_local.xz);
  vec3 env = sky(reflect(view, n));
  float fres = pow(1.0 - abs(dot(n, view)), 3.0);
  float sunL = max(dot(n, normalize(vec3(u_sun.x, 0.3, u_sun.z))), 0.0);
  vec3 h = normalize(normalize(vec3(u_sun.x, 0.3, u_sun.z)) - view);
  float spec = pow(max(dot(n, h), 0.0), 40.0);
  // The belly is dark, worn metal (it would mirror the bright horizon otherwise); the top is polished.
  float top = smoothstep(-0.03, 0.03, y);
  vec3 c = vec3(0.28, 0.29, 0.32) * mix(0.25, 1.0, top) * (0.18 + 0.6 * sunL) + env * mix(0.06 + 0.2 * fres, 0.45 + 0.8 * fres, top) + vec3(1.0, 0.6, 0.35) * spec * 0.8 * top;
  // Glass dome with something green glowing inside.
  if (y > 0.165) c = mix(c, vec3(0.25, 0.95, 0.65) * (0.7 + 0.3 * sin(u_time * 3.0 + v_u.w)), 0.65) + env * 0.25;
  // Running lights round the rim.
  float ang = atan(v_local.z, v_local.x) + v_u.w;
  float cell = ang * 14.0 / 6.2832;
  float id = mod(floor(cell), 2.0);
  float dotm = smoothstep(0.32, 0.12, abs(fract(cell) - 0.5)) * smoothstep(0.05, 0.0, abs(y - 0.005));
  vec3 lc = id < 0.5 ? vec3(1.0, 0.55, 0.15) : vec3(0.3, 0.9, 1.0);
  c += lc * dotm * 4.0;
  // The belly glows.
  if (y < -0.05) {
    c += vec3(0.35, 1.0, 0.6) * smoothstep(0.55, 0.0, r) * (1.4 + 0.5 * sin(u_time * 5.0 + v_u.w));
    // A ring of pulsing ports round the belly.
    float port = smoothstep(0.3, 0.1, abs(fract(atan(v_local.z, v_local.x) * 8.0 / 6.2832 - v_u.w * 0.3) - 0.5)) * smoothstep(0.08, 0.0, abs(r - 0.68));
    c += vec3(1.0, 0.35, 0.2) * port * (2.0 + 1.5 * sin(u_time * 9.0));
  }
  o = finish(fog(c, v_world));
}`;

export const BEAM_FS = COMMON + /* glsl */ `
in vec3 v_world;
in vec3 v_norm;
in vec3 v_local;
flat in vec4 v_u;
flat in vec4 v_u2;
out vec4 o;
void main() {
  vec3 view = normalize(v_world - u_cam);
  float edge = pow(abs(dot(normalize(v_norm), view)), 1.4);
  float along = 1.0 + v_local.y;  // 1 at the saucer, 0 on the street
  float rings = 0.75 + 0.25 * sin(v_local.y * 60.0 + u_time * 8.0);
  float a = v_u2.w * edge * (0.12 + 0.5 * along * along) * rings;
  vec3 c = vec3(0.35, 1.0, 0.65) * a * exp(-length(v_world - u_cam) / 2600.0);
  o = vec4(c * u_fade, 1.0);
}`;
