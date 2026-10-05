/**
 * Facade material: walls, roofs and structures of buildings and bridges.
 *
 * Wall surfaces come from a texture array (procedural PBR). Windows, doors,
 * shop fronts, curtain walls and dormers are drawn procedurally from per-vertex
 * facade parameters (bay width, floor height, ground floor height, flags), with
 * interior mapping behind the glass and night lighting per window.
 */
import * as THREE from 'three';
import type { MaterialArrays } from '../TextureLibrary';
import { G, aliveTexture } from './globals';
import { GLSL_COMMON, GLSL_ELEM_VERTEX_DECL, GLSL_ELEM_VERTEX_MAIN } from './glsl';

const FRAG_DECL = /* glsl */ `
uniform sampler2DArray uAlb;
uniform sampler2DArray uNrm;
uniform float uTile[24];
uniform float uNight;
uniform float uDayLight;
uniform float uLitFrac;
uniform float uShopLit;
uniform float uEatLit;
uniform float uTime;
varying vec2 vMUv;
varying float vLayer;
varying vec3 vTint;
varying vec4 vFacade;
varying float vSeed;
varying vec3 vWPos;
varying vec3 vWNrm;
${GLSL_COMMON}

struct Surf { vec3 albedo; float rough; float metal; vec2 tn; float nStr; vec3 emis; float ao; float glass; float door; };
varying float vOpen;

// Interior mapping: ray from the window into a box room behind the facade.
vec3 interiorRoom(vec2 local, vec2 room, float id, vec3 vt, bool office, out float depthT) {
  // local: position in the room's facade rectangle (0..room.x, 0..room.y); vt: view ray in facade space (z into the building)
  float depth = mix(3.5, 7.5, h11(id * 3.1));
  vec3 o = vec3(local, 0.0);
  vec3 d = normalize(vt);
  float tx = d.x > 0.0 ? (room.x - o.x) / d.x : -o.x / min(d.x, -1e-4);
  float ty = d.y > 0.0 ? (room.y - o.y) / d.y : -o.y / min(d.y, -1e-4);
  float tz = depth / max(d.z, 1e-4);
  float t = min(tx, min(ty, tz));
  depthT = t;
  vec3 hit = o + d * t;
  float hue = h11(id * 7.7);
  vec3 wall = office ? vec3(0.78, 0.79, 0.8) : mix(vec3(0.85, 0.80, 0.70), vec3(0.75, 0.82, 0.86), hue) * mix(0.75, 1.0, h11(id * 1.3));
  vec3 col;
  if (t == tz) {
    col = wall;
    // furniture silhouettes against the back wall
    float fx = hit.x / room.x;
    if (!office && hit.y < 0.9 && fx > 0.15 + 0.3 * h11(id) && fx < 0.55 + 0.3 * h11(id)) col = mix(vec3(0.35, 0.25, 0.18), vec3(0.5, 0.45, 0.4), h11(id * 9.0));
    if (!office && hit.y > 1.3 && hit.y < 2.0 && abs(fx - 0.5) < 0.12 && h11(id * 4.0) > 0.4) col = mix(vec3(0.6, 0.2, 0.15), vec3(0.2, 0.35, 0.55), h11(id * 5.0)); // picture
    if (office && hit.y < 1.1 && hit.y > 0.72) col = vec3(0.55, 0.55, 0.57); // desks
  } else if (t == ty) {
    if (d.y > 0.0) {
      col = vec3(0.92);
      if (office && fract(hit.z * 0.5) < 0.12) col = vec3(1.4); // ceiling light strips
    } else {
      col = office ? vec3(0.42, 0.43, 0.46) : mix(vec3(0.45, 0.3, 0.18), vec3(0.6, 0.55, 0.48), h11(id * 2.2)); // floor
    }
  } else {
    col = wall * 0.82;
  }
  // Rooms get darker deeper inside.
  col *= exp(-t * 0.07);
  return col;
}

Surf facadeSurface(vec2 uv, vec4 fp, int flags, float layerF, vec3 eyeDirW, vec3 nW) {
  Surf s;
  int layer = int(layerF + 0.5);
  vec2 tuv = uv / uTile[layer];
  vec4 ar = texture(uAlb, vec3(tuv, layerF));
  vec4 nh = texture(uNrm, vec3(tuv, layerF));
  s.albedo = ar.rgb * vTint;
  s.rough = ar.a;
  s.metal = 0.0;
  s.tn = nh.xy * 2.0 - 1.0;
  s.nStr = 1.0;
  s.ao = mix(1.0, nh.a, 0.8);
  s.emis = vec3(0.0);
  s.glass = 0.0;
  s.door = 0.0;
  if (layer == 10) { s.metal = 0.6; }
  // Stained glass: daylight shines through it (a faint glow at night, lit from inside).
  if ((flags & 4096) != 0) { s.emis = s.albedo * (0.06 + 0.5 * uDayLight); s.rough = 0.12; s.ao = 1.0; return s; }
  if ((flags & 1) == 0 || (flags & 64) != 0) return s;

  bool roof = (flags & 128) != 0;
  bool curtain = (flags & 4) != 0;
  bool shop = (flags & 2) != 0;
  bool front = (flags & 256) != 0;
  bool eatery = (flags & 2048) != 0;
  bool arched = (flags & 8) != 0;
  bool shutters = (flags & 32) != 0;
  bool balcony = (flags & 16) != 0;
  float bay = max(fp.x, 0.5), fH = max(fp.y, 2.0), gH = max(fp.z, 2.0);
  float seedB = floor(vSeed * 1000.0 + 0.5);

  // Pixel footprint: fade the pattern out when windows become sub-pixel (no moiré at distance).
  float px = max(length(fwidth(uv)), 1e-4);
  float detail = 1.0 - smoothstep(bay * 0.12, bay * 0.35, px);

  float f, ly, fh;
  if (roof) { f = 90.0; ly = uv.y; fh = fH; }
  else if (uv.y < gH) { f = 0.0; ly = uv.y; fh = gH; }
  else { float t = (uv.y - gH) / fH; f = 1.0 + floor(t); ly = fract(t) * fH; fh = fH; }
  float bi = floor(uv.x / bay);
  float lx = uv.x - bi * bay;
  float winId = h21(vec2(bi + seedB, f + seedB * 0.37));

  // Window rectangle for this floor.
  float ww, wh, wy0;
  bool isShopFloor = f == 0.0 && shop;
  bool isDoor = false;
  if (curtain) { ww = bay; wh = fh - 0.95; wy0 = 0.9; }
  else if (roof) { ww = min(1.1, bay * 0.5); wh = 1.25; wy0 = 0.95; if (fract(bi * 0.5) > 0.1) return s; }
  else if (isShopFloor) { ww = bay - 0.35; wh = fh - 1.25; wy0 = 0.3; }
  else {
    ww = bay * mix(0.42, 0.6, h11(seedB + 1.0));
    wh = fh * mix(0.5, 0.62, h11(seedB + 2.0));
    wy0 = fh * 0.3;
    if (f == 0.0) { wy0 = max(0.9, fh - wh - 0.7); }
  }
  // Entrance door on the front facade (non-shop ground floor or within shop bays).
  float doorBi = float((flags >> 9) & 3);
  if (front && f == 0.0 && bi == doorBi && !curtain) {
    isDoor = true;
    ww = min(1.3, bay * 0.62);
    wh = min(2.45, fh - 0.35);
    wy0 = 0.0;
  }
  float wx0 = (bay - ww) * 0.5;
  vec2 p = vec2(lx - wx0, ly - wy0);
  bool inRect = p.x > 0.0 && p.x < ww && p.y > 0.0 && p.y < wh;
  // An open entrance is a real opening (a door leaf mesh takes over, see Interiors).
  if (isDoor && inRect) s.door = 1.0;
  if (arched && !isDoor && !curtain && inRect) {
    float r = ww * 0.5;
    if (p.y > wh - r) { vec2 c = vec2(r, wh - r); inRect = length(p - c) < r; }
  }

  // Curtain wall: glass everywhere except spandrels and mullions.
  if (curtain) {
    float mull = 0.06;
    bool spandrel = ly < wy0 || ly > fh - 0.05;
    bool mullion = lx < mull * 0.5 || lx > bay - mull * 0.5;
    if (mullion || spandrel) {
      s.albedo = spandrel ? vTint * 0.25 + 0.05 : vec3(0.5, 0.52, 0.55);
      s.metal = mullion ? 0.8 : 0.4;
      s.rough = mullion ? 0.35 : 0.25;
      s.tn = vec2(0.0);
      return s;
    }
    // glass
    vec3 T = normalize(vec3(-nW.z, 0.0, nW.x));
    vec3 vt = vec3(dot(-eyeDirW, T), dot(-eyeDirW, vec3(0, 1, 0)), dot(-eyeDirW, -nW));
    float dT;
    vec3 room = interiorRoom(vec2(lx, ly), vec2(bay * 2.0, fh), winId, vt, true, dT);
    bool lit = h11(winId * 13.0) < uLitFrac * 1.4;
    vec3 inside = room * (lit ? vec3(1.0, 0.97, 0.9) * 1.2 : vec3(uDayLight * 0.1 + 0.01));
    s.albedo = mix(vec3(0.02), vTint * 0.12, 0.5);
    s.metal = 0.55;
    s.rough = 0.04;
    s.tn = vec2(0.0);
    s.emis = inside * 0.45 * detail + (lit ? vec3(0.35, 0.33, 0.3) * (1.0 - detail) * 0.4 : vec3(0.0));
    s.glass = 1.0;
    return s;
  }

  if (!inRect) {
    if (detail > 0.01) {
      // Sill below and lintel above the opening; reveal shadow around it.
      float dx = min(p.x, ww - p.x);
      bool inX = p.x > -0.1 && p.x < ww + 0.1;
      if (!isDoor && !isShopFloor && inX && p.y < 0.0 && p.y > -0.11) {
        s.albedo = mix(s.albedo, vec3(0.78, 0.76, 0.72), 0.75 * detail);
        s.tn = mix(s.tn, vec2(0.0, -0.6), detail);
        s.rough = 0.6;
      } else if (!isShopFloor && inX && p.y > wh && p.y < wh + 0.22 && !arched) {
        s.albedo = mix(s.albedo, s.albedo * 1.08, detail);
        s.tn = mix(s.tn, vec2(0.0, p.y > wh + 0.18 ? 0.5 : 0.0), detail);
      }
      // Shutters beside the window.
      if (shutters && !isShopFloor && !isDoor && f > 0.0 && p.y > 0.0 && p.y < wh && (p.x < 0.0 && p.x > -ww * 0.5 || p.x > ww && p.x < ww * 1.5)) {
        vec3 sc = mix(vec3(0.25, 0.4, 0.3), vec3(0.45, 0.25, 0.2), h11(seedB + 9.0));
        sc = mix(sc, vec3(0.3, 0.42, 0.55), step(0.66, h11(seedB + 8.0)));
        float slat = fract(p.y * 10.0);
        s.albedo = mix(s.albedo, sc * (0.8 + 0.2 * slat), detail);
        s.tn = mix(s.tn, vec2(0.0, (slat - 0.5) * 0.8), detail);
        s.rough = 0.7;
      }
      // Shop sign band above the display windows.
      if (isShopFloor && !eatery && ly > wy0 + wh + 0.15 && ly < fh - 0.15) {
        float sid = h11(seedB + bi * 0.0 + 21.0);
        vec3 sc = 0.15 + 0.7 * vec3(h11(sid * 3.0), h11(sid * 5.0), h11(sid * 7.0));
        float letters = step(0.45, vnoise(vec2(uv.x * 3.0, ly * 6.0) + sid * 10.0)) * step(abs(ly - (wy0 + wh + 0.15 + fh - 0.15) * 0.5), 0.18);
        s.albedo = mix(s.albedo, mix(sc, vec3(0.95), letters), detail);
        s.rough = 0.4;
        s.emis += uShopLit * uNight * (sc * 0.3 + letters * vec3(1.0, 0.9, 0.7)) * 1.2;
      }
      // Wrought iron balcony rail across the lower part of tall windows (floors 2 and 5).
      if (balcony && (f == 2.0 || f == 5.0) && ly > wy0 - 0.15 && ly < wy0 + 0.95) {
        float bar = step(0.85, fract(uv.x * 8.0)) + step(abs(ly - wy0 - 0.9), 0.04) + step(abs(ly - wy0 - 0.05), 0.04);
        s.albedo = mix(s.albedo, vec3(0.06), min(1.0, bar) * detail);
        s.metal = mix(s.metal, 0.6, min(1.0, bar) * detail);
      }
      // reveal shading just outside the opening
      float outside = max(max(-p.x, p.x - ww), max(-p.y, p.y - wh));
      s.ao *= mix(1.0, 0.75 + 0.25 * smoothstep(0.0, 0.08, outside), detail);
    }
    return s;
  }

  // Inside the opening.
  float frW = isShopFloor ? 0.08 : 0.065;
  float ex = min(p.x, ww - p.x), ey = min(p.y, wh - p.y);
  float edge = min(ex, ey);
  // Recess: inner reveal (wall return) visible as a darker band.
  float reveal = 0.07;
  vec3 frameCol = mix(vec3(0.93, 0.92, 0.9), mix(vec3(0.15, 0.15, 0.16), vec3(0.35, 0.22, 0.14), h11(seedB + 3.0)), step(0.55, h11(seedB + 4.0)));
  if (edge < reveal) {
    s.albedo = mix(s.albedo, s.albedo * 0.55, detail);
    s.tn = mix(s.tn, ex < ey ? vec2(p.x < ww * 0.5 ? 0.7 : -0.7, 0.0) : vec2(0.0, p.y < wh * 0.5 ? 0.7 : -0.7), detail * 0.7);
    return s;
  }
  vec2 q = p - reveal;
  vec2 qs = vec2(ww, wh) - 2.0 * reveal;
  float qe = min(min(q.x, qs.x - q.x), min(q.y, qs.y - q.y));
  // Muntins: old styles get divided panes; doors get panels.
  bool muntin = false;
  if (isDoor) {
    bool glassPart = q.y > qs.y * 0.62 && qe > 0.12;
    if (!glassPart) {
      vec3 dc = mix(vec3(0.28, 0.16, 0.09), mix(vec3(0.08, 0.2, 0.15), vec3(0.45, 0.08, 0.06), h11(seedB + 11.0)), step(0.5, h11(seedB + 12.0)));
      float panel = step(0.12, min(min(q.x, qs.x - q.x), abs(q.y - qs.y * 0.3)));
      s.albedo = mix(s.albedo, dc * (0.85 + 0.15 * panel), detail);
      s.tn = mix(s.tn, panel > 0.5 ? vec2(0.0) : vec2(0.3, 0.3), detail);
      s.rough = 0.5;
      // knob
      if (length(q - vec2(qs.x * 0.85, qs.y * 0.45)) < 0.035) { s.albedo = vec3(0.7, 0.6, 0.35); s.metal = 1.0; s.rough = 0.3; }
      return s;
    }
  } else if (!isShopFloor && !roof) {
    float panesX = ww > 1.0 ? 2.0 : 1.0;
    float panesY = h11(seedB + 6.0) < 0.5 ? 2.0 : 3.0;
    vec2 g = q / qs * vec2(panesX, panesY);
    vec2 gd = min(fract(g), 1.0 - fract(g)) * qs / vec2(panesX, panesY);
    muntin = h11(seedB + 7.0) < 0.6 && min(gd.x, gd.y) < 0.022;
  }
  if (qe < frW || muntin) {
    s.albedo = mix(s.albedo, frameCol, detail);
    s.rough = 0.45;
    s.metal = 0.0;
    s.tn = mix(s.tn, qe < frW ? vec2(0.0) : vec2(0.0), detail);
    s.ao *= 0.9;
    return s;
  }
  // Glass with the room behind it.
  vec3 T = normalize(vec3(-nW.z, 0.0, nW.x));
  vec3 vt = vec3(dot(-eyeDirW, T), dot(-eyeDirW, vec3(0, 1, 0)), dot(-eyeDirW, -nW));
  float dT;
  bool office = (flags & 4) != 0;
  vec3 room = interiorRoom(vec2(lx, ly), vec2(bay * (isShopFloor ? 2.0 : 1.6), fh), winId + f * 0.13, vt, office || (isShopFloor && !eatery), dT);
  // Blinds / curtains: per window fraction drawn down from the top.
  float blind = h11(winId * 17.0);
  blind = blind < 0.45 ? 0.0 : (blind - 0.45) * 1.4;
  if (!isShopFloor && q.y > qs.y * (1.0 - blind)) {
    vec3 bc = mix(vec3(0.92, 0.9, 0.85), vec3(0.75, 0.62, 0.5), h11(winId * 19.0));
    float stripe = 0.5 + 0.5 * sin(q.y * 140.0);
    float saa = clamp(1.0 - fwidth(q.y) * 30.0, 0.0, 1.0);
    room = bc * (0.82 + 0.18 * mix(0.5, stripe, saa));
  }
  bool lit;
  vec3 lightCol;
  if (eatery && (isShopFloor || isDoor)) { lit = h11(winId * 5.0) < uEatLit; lightCol = vec3(1.0, 0.64, 0.34) * (1.2 + 0.3 * uNight); } // cafés: warm, open late
  else if (isShopFloor || isDoor) { lit = h11(winId * 5.0) < uShopLit; lightCol = vec3(1.0, 0.92, 0.78) * 1.6; }
  else { lit = h11(winId * 13.0) < uLitFrac; lightCol = mix(vec3(1.0, 0.82, 0.58), vec3(0.85, 0.9, 1.0), step(0.8, h11(winId * 23.0))) * 1.3; }
  vec3 inside = room * (lit ? lightCol : vec3(uDayLight * 0.13 + 0.004));
  s.albedo = mix(s.albedo, vec3(0.015), detail);
  s.rough = mix(s.rough, 0.05, detail);
  s.metal = mix(s.metal, 0.0, detail);
  s.tn = mix(s.tn, vec2(0.0), detail);
  s.ao = 1.0;
  s.emis = inside * detail * 0.9 + (lit ? lightCol * 0.12 * (1.0 - detail) : vec3(0.0));
  s.glass = isDoor ? 0.0 : 1.0;
  return s;
}
`;

export function createFacadeMaterial(arrays: MaterialArrays, elemTex: THREE.Texture | null, elemW = 1, backPlaster = true): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, side: THREE.DoubleSide, shadowSide: THREE.DoubleSide });
  const uniforms = {
    uAlb: { value: arrays.albedo },
    uNrm: { value: arrays.normal },
    uTile: { value: arrays.tileMeters.slice(0, 24).concat(new Array(Math.max(0, 24 - arrays.tileMeters.length)).fill(2)) },
    uElemTex: { value: elemTex ?? aliveTexture() },
    uElemW: { value: elemTex ? elemW : 1 },
    uNight: G.uNight,
    uDayLight: G.uDayLight,
    uLitFrac: G.uLitFrac,
    uShopLit: G.uShopLit,
    uEatLit: G.uEatLit,
    uTime: G.uTime,
    uWet: G.uWet,
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aLayer; attribute vec3 aTint; attribute vec4 aFacade; attribute float aSeed;
varying vec2 vMUv; varying float vLayer; varying vec3 vTint; varying vec4 vFacade; varying float vSeed; varying vec3 vWPos; varying vec3 vWNrm;
${GLSL_ELEM_VERTEX_DECL}`,
      )
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
vMUv = uv; vLayer = aLayer; vTint = aTint; vFacade = aFacade; vSeed = aSeed;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNrm = normalize(mat3(modelMatrix) * objectNormal);`,
      )
      .replace('#include <fog_vertex>', `#include <fog_vertex>\n${GLSL_ELEM_VERTEX_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n#define BACK_PLASTER ${backPlaster ? 'true' : 'false'}\n${FRAG_DECL}\nuniform float uWet;\nSurf gS;`)
      .replace(
        '#include <map_fragment>',
        `vec3 eyeDirW = normalize(cameraPosition - vWPos);
gS = facadeSurface(vMUv, vFacade, int(vFacade.w + 0.5), vLayer, eyeDirW, normalize(vWNrm));
if ((gS.glass > 0.5 || gS.door > 0.5) && vOpen > 0.5) discard;
if (!gl_FrontFacing && BACK_PLASTER) {
  // Inside of the shell: plastered interior walls; glass seen from inside is dark (or open).
  if (gS.glass > 0.5) { gS.albedo = vec3(0.03); gS.emis = vec3(0.25, 0.3, 0.35) * uDayLight; }
  else { gS.albedo = vec3(0.82, 0.8, 0.76) * (0.9 + 0.1 * vnoise(vMUv * 2.0)); gS.emis = vec3(0.0); }
  gS.tn = vec2(0.0); gS.rough = 0.9; gS.metal = 0.0; gS.ao = 0.8;
}
if (uWet > 0.001 && gl_FrontFacing && gS.glass < 0.5) {
  // Rain-darkened walls, in streaks and patches.
  float wW = uWet * (0.55 + 0.45 * vnoise(vec2(vWPos.x + vWPos.z, vWPos.y * 0.25) * 0.6));
  gS.albedo *= 1.0 - 0.25 * wW;
  gS.rough *= 1.0 - 0.35 * wW;
}
diffuseColor.rgb = gS.albedo * gS.ao;`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gS.rough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = gS.metal;')
      .replace(
        '#include <normal_fragment_maps>',
        `normal = perturbNormalUV(-vViewPosition, normal, vMUv / uTile[int(vLayer + 0.5)], gS.tn, gS.nStr);`,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gS.emis;')
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= gS.ao;');
  };
  mat.customProgramCacheKey = () => 'facade-v3' + (backPlaster ? '' : '-nb');
  return mat;
}

/** Shadow depth material honouring destroyed elements (collapsed vertices cast no shadow). */
export function createElemDepthMaterial(elemTex: THREE.Texture | null, elemW = 1): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  const uniforms = { uElemTex: { value: elemTex ?? aliveTexture() }, uElemW: { value: elemTex ? elemW : 1 } };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${GLSL_ELEM_VERTEX_DECL}`)
      .replace('#include <clipping_planes_vertex>', `#include <clipping_planes_vertex>\n${GLSL_ELEM_VERTEX_MAIN}`);
  };
  mat.customProgramCacheKey = () => 'elem-depth-v1';
  return mat;
}
