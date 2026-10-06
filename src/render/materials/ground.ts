/**
 * Ground materials: urban surfaces (texture array by layer), natural terrain
 * (slope/height blended grass, dirt, rock, sand) and water.
 */
import * as THREE from 'three';
import type { MaterialArrays } from '../TextureLibrary';
import { G } from './globals';
import { GLSL_COMMON } from './glsl';
import { landGlsl, parcelParams } from '../../world/landuse';

export function createGroundMaterial(arrays: MaterialArrays): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const uniforms = {
    uAlb: { value: arrays.albedo },
    uNrm: { value: arrays.normal },
    uTile: { value: arrays.tileMeters.slice(0, 16).concat(new Array(Math.max(0, 16 - arrays.tileMeters.length)).fill(2)) },
    uNight: G.uNight,
    uWet: G.uWet,
    // Open manholes and metro entrances cut through the street's surfaces too.
    uHoleA: terrainHoles.uHoleA, uHoleB: terrainHoles.uHoleB, uHoleN: terrainHoles.uHoleN,
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float aLayer;\nvarying vec2 vMUv; varying float vLayer; varying vec2 vHPos;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\nvMUv = uv; vLayer = aLayer;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\nvHPos = (modelMatrix * vec4(transformed, 1.0)).xz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2DArray uAlb; uniform sampler2DArray uNrm; uniform float uTile[16];
varying vec2 vMUv; varying float vLayer; varying vec2 vHPos;
uniform float uWet;
uniform vec4 uHoleA[16]; uniform vec4 uHoleB[16]; uniform int uHoleN;
${GLSL_COMMON}
vec4 gAR; vec4 gNH; vec2 gTuv; float gPud;`,
      )
      .replace(
        '#include <map_fragment>',
        `for (int i = 0; i < 16; i++) {
  if (i >= uHoleN) break;
  vec2 hd = vHPos - uHoleA[i].xy;
  float hu = dot(hd, uHoleA[i].zw), hv = -hd.x * uHoleA[i].w + hd.y * uHoleA[i].z;
  if (abs(hu) < uHoleB[i].y && abs(hv) < uHoleB[i].x) discard;
}
int layer = int(vLayer + 0.5);
gTuv = vMUv / uTile[layer];
// Break up tiling with a large-scale rotation/offset per 37 m cell for natural layers.
gAR = texture(uAlb, vec3(gTuv, vLayer));
gNH = texture(uNrm, vec3(gTuv, vLayer));
float macroV = fbm2(vMUv * 0.035);
vec3 alb = gAR.rgb * mix(0.86, 1.1, macroV);
if (layer == 3) alb *= mix(vec3(0.92, 0.95, 0.85), vec3(1.05, 1.0, 1.02), fbm2(vMUv * 0.11));
diffuseColor.rgb = alb * mix(1.0, gNH.a, 0.85);`,
      )
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = gAR.a;
gPud = 0.0;
if (uWet > 0.001) {
  // Wet: darker and glossier (hard surfaces more than grass, gravel and dirt); puddles in the
  // hollows of the paving and in large shallow dips once it is properly wet.
  bool hard = layer != 3 && layer != 6 && layer != 11;
  float dip = fbm2(vMUv * 0.21 + 7.3) + (1.0 - gNH.a) * 0.35;
  gPud = hard ? smoothstep(0.7, 0.76, dip + uWet * 0.2 - 0.14) * smoothstep(0.45, 0.9, uWet) : 0.0;
  diffuseColor.rgb *= mix(1.0, hard ? 0.62 : 0.78, uWet) * (1.0 - 0.35 * gPud);
  roughnessFactor = mix(roughnessFactor, hard ? roughnessFactor * 0.38 : roughnessFactor * 0.8, uWet);
  roughnessFactor = mix(roughnessFactor, 0.06, gPud);
}`)
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace('#include <normal_fragment_maps>', 'normal = perturbNormalUV(-vViewPosition, normal, gTuv, gNH.xy * 2.0 - 1.0, 1.0 - 0.9 * gPud);')
      // Wet sheen: puddles (and a wet street, less) mirror the grey sky at grazing angles (the
      // fog colour stands in for the sky there; the environment map alone is too faint for it).
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
#ifdef USE_FOG
if (uWet > 0.001) {
  float nv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
  float fres = pow(1.0 - nv, 4.0);
  totalEmissiveRadiance += fogColor * (gPud * (0.02 + 0.3 * fres) + uWet * 0.08 * fres);
}
#endif`);
  };
  mat.customProgramCacheKey = () => 'ground-v3';
  return mat;
}

/** Natural terrain outside the urban surfaces. */
/**
 * Up to 16 street holes (metro entrances, open manholes) that the terrain must not cover, and
 * whether the camera is below the ground (the tiles' skirts are hidden then: see uUnder).
 */
export const terrainHoles = {
  uHoleA: { value: Array.from({ length: 16 }, () => new THREE.Vector4(0, 0, 1, 0)) },
  uHoleB: { value: Array.from({ length: 16 }, () => new THREE.Vector4(0, 0, 0, 0)) },
  uHoleN: { value: 0 },
  /**
   * 1 while the camera is underground. The skirts that hide cracks between terrain tiles hang
   * metres below the surface along every tile edge; seen from a sewer or the metro they stood
   * across the tunnels as walls one walked through.
   */
  uUnder: { value: 0 },
};

/**
 * With a world seed, the terrain also shows the countryside land use from the tiles' aLand
 * attribute (forest floor / canopy, crop parcels with rows and tramlines, meadows, green
 * banks), soft at every distance.
 */
export function createTerrainMaterial(arrays: MaterialArrays, seed?: number): THREE.MeshStandardMaterial {
  const land = seed !== undefined;
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  const uniforms = {
    ...terrainHoles,
    uWet: G.uWet,
    uAlb: { value: arrays.albedo },
    uNrm: { value: arrays.normal },
    uTile: { value: arrays.tileMeters.slice(0, 16).concat(new Array(Math.max(0, 16 - arrays.tileMeters.length)).fill(2)) },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vMUv; varying vec3 vWPos; varying vec3 vWNrm;${land ? '\nattribute vec4 aLand; varying vec4 vLand;' : ''}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\nvMUv = uv;${land ? ' vLand = aLand;' : ''}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vWNrm = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2DArray uAlb; uniform sampler2DArray uNrm; uniform float uTile[16];
uniform vec4 uHoleA[16]; uniform vec4 uHoleB[16]; uniform int uHoleN; uniform float uUnder; uniform float uWet;
varying vec2 vMUv; varying vec3 vWPos; varying vec3 vWNrm;
${GLSL_COMMON}
float gRough; vec2 gTn; vec2 gTuv;
${land ? 'varying vec4 vLand;\n' + landGlsl(parcelParams(seed!)) + LAND_FRAG : ''}`,
      )
      .replace(
        '#include <map_fragment>',
        `// Skirts (vertical, the only faces with a level normal) are not drawn from below the ground.
if (uUnder > 0.5 && vWNrm.y < 0.02) discard;
for (int i = 0; i < 16; i++) {
  if (i >= uHoleN) break;
  vec2 d = vWPos.xz - uHoleA[i].xy;
  float u = dot(d, uHoleA[i].zw), v = -d.x * uHoleA[i].w + d.y * uHoleA[i].z;
  if (abs(u) < uHoleB[i].y && abs(v) < uHoleB[i].x) discard;
}
float slope = 1.0 - clamp(vWNrm.y, 0.0, 1.0);
float n = fbm2(vMUv * 0.02);
vec2 tg = vMUv / uTile[3], td = vMUv / uTile[11], tr = vMUv / uTile[12], ts = vMUv / uTile[6];
vec4 g = texture(uAlb, vec3(tg, 3.0)), d = texture(uAlb, vec3(td, 11.0)), r = texture(uAlb, vec3(tr, 12.0)), sa = texture(uAlb, vec3(ts, 6.0));
vec4 gn = texture(uNrm, vec3(tg, 3.0)), dn = texture(uNrm, vec3(td, 11.0)), rn = texture(uNrm, vec3(tr, 12.0)), sn = texture(uNrm, vec3(ts, 6.0));
float wDirt = smoothstep(0.12, 0.3, slope + (n - 0.5) * 0.25);
float wRock = smoothstep(0.38, 0.6, slope);
float wSand = 1.0 - smoothstep(0.6, 2.2, vWPos.y);
vec4 a = mix(g, d, wDirt); vec4 nn = mix(gn, dn, wDirt);
a = mix(a, r, wRock); nn = mix(nn, rn, wRock);
${land ? 'landUse(a, nn, g, d, gn, dn, n, wRock);' : ''}
a = mix(a, sa * vec4(1.15, 1.08, 0.9, 1.0), wSand); nn = mix(nn, sn, wSand);
gRough = a.a; gTn = nn.xy * 2.0 - 1.0; gTuv = tg;
diffuseColor.rgb = a.rgb * mix(0.85, 1.1, n) * mix(1.0, nn.a, 0.8);`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough * (1.0 - 0.25 * uWet);\ndiffuseColor.rgb *= 1.0 - 0.25 * uWet;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace('#include <normal_fragment_maps>', 'normal = perturbNormalUV(-vViewPosition, normal, gTuv, gTn, 1.0);');
  };
  mat.customProgramCacheKey = () => 'terrain-v5' + (land ? '-' + seed : '');
  return mat;
}

const srgb = (r: number, g: number, b: number) => `vec3(${[r, g, b].map((c) => Math.pow(c, 2.2).toFixed(4)).join(', ')})`;

/** Countryside colouring of the terrain (after the slope blend, before the beach sand). */
const LAND_FRAG = /* glsl */ `
vec3 cropColor(float crop) {
  return crop < 0.5 ? ${srgb(0.66, 0.56, 0.3)} : crop < 1.5 ? ${srgb(0.72, 0.66, 0.42)} : crop < 2.5 ? ${srgb(0.37, 0.49, 0.18)}
    : crop < 3.5 ? ${srgb(0.25, 0.37, 0.13)} : crop < 4.5 ? ${srgb(0.38, 0.29, 0.2)} : crop < 5.5 ? ${srgb(0.4, 0.5, 0.22)}
    : crop < 6.5 ? ${srgb(0.8, 0.74, 0.2)} : ${srgb(0.64, 0.58, 0.4)};
}
// Share of the ground the crop covers between its rows (pasture: closed sward).
float cropCover(float crop) {
  return crop < 0.5 ? 0.9 : crop < 1.5 ? 0.88 : crop < 2.5 ? 0.7 : crop < 3.5 ? 0.6 : crop < 4.5 ? 0.5 : crop < 5.5 ? 1.0 : crop < 6.5 ? 0.85 : 0.8;
}
// Row spacing (m): drilled cereals are fine, maize wide, ploughed land has furrows.
float rowPeriod(float crop) {
  return crop < 1.5 ? 0.17 : crop < 2.5 ? 0.22 : crop < 3.5 ? 0.75 : crop < 4.5 ? 0.6 : crop < 6.5 ? 0.35 : 0.2;
}
void landUse(inout vec4 a, inout vec4 nn, vec4 g, vec4 d, vec4 gn, vec4 dn, float n, float wRock) {
  float rural = vLand.x + vLand.y + vLand.z;
  if (rural < 0.003) return;
  float camD = length(vWPos - cameraPosition);
  // Ground footprint of a pixel (m): decides what can still be resolved.
  float foot = length(fwidth(vWPos.xz));
  vec3 lumW = vec3(0.3, 0.59, 0.11);
  float gDet = clamp(dot(g.rgb, lumW) / max(1e-4, dot(textureLod(uAlb, vec3(0.5, 0.5, 3.0), 10.0).rgb, lumW)), 0.55, 1.5);
  float dDet = clamp(dot(d.rgb, lumW) / max(1e-4, dot(textureLod(uAlb, vec3(0.5, 0.5, 11.0), 10.0).rgb, lumW)), 0.55, 1.5);
  // The detail textures' tiling shows as a dot grid from afar: let it fade.
  float far = smoothstep(25.0, 160.0, camD);
  gDet = mix(gDet, 1.0, far); dDet = mix(dDet, 1.0, far);
  float big = fbm2(vWPos.xz * 0.0021 + 3.7);
  // Meadow: the grass, lusher or drier in large patches; banks lush.
  vec3 meadow = g.rgb * mix(vec3(1.08, 1.02, 0.72), vec3(0.86, 1.08, 0.82), big);
  // From afar the grass texture averages out far darker than the crops round it (clearings round
  // villages and farms read as smudged shadows): ease towards a pasture green.
  meadow = mix(meadow, ${srgb(0.4, 0.5, 0.22)} * mix(0.88, 1.08, big), smoothstep(40.0, 320.0, camD) * 0.85);
  vec3 bank = meadow * vec3(0.9, 1.04, 0.86);
  // Forest: litter and moss up close, canopy colour from afar.
  float moss = smoothstep(0.35, 0.65, fbm2(vWPos.xz * 0.09 + 11.0) + (n - 0.5) * 0.4);
  vec3 floorC = mix(d.rgb * vec3(0.6, 0.5, 0.38), g.rgb * vec3(0.62, 0.78, 0.42), moss);
  vec3 canopy = ${srgb(0.2, 0.29, 0.12)} * mix(0.75, 1.2, fbm2(vWPos.xz * 0.013)) * mix(0.9, 1.08, big);
  vec3 forest = mix(floorC, canopy, smoothstep(120.0, 700.0, camD));
  // Fields: the parcel patchwork, crop rows (fading out before they alias), tramlines, grass margins.
  float crop;
  vec4 pc = parcelAt(vWPos.xz, crop);
  vec3 cc = cropColor(crop) * mix(0.86, 1.12, pc.y) * mix(0.93, 1.05, big);
  bool pasture = crop > 4.5 && crop < 5.5, ploughed = crop > 3.5 && crop < 4.5;
  if (pasture) cc = meadow * mix(0.92, 1.1, pc.y);
  vec3 soil = ${srgb(0.34, 0.27, 0.19)} * dDet;
  float rowM = pc.z / rowPeriod(crop);
  float rows = 1.0 - smoothstep(0.2, 0.55, fwidth(rowM));
  float stripe = 0.5 + 0.5 * sin(rowM * 6.2831853);
  float cover = cropCover(crop);
  float soilShare = mix(1.0 - cover, mix(1.0 - cover, smoothstep(cover - 0.15, cover + 0.15, stripe), 0.75), rows);
  vec3 field = ploughed ? cc * dDet * mix(1.0, 0.78 + 0.4 * stripe, rows) : mix(cc * gDet, soil, soilShare);
  if (!pasture && !ploughed) {
    float tm = abs(fract(pc.z / 18.0) - 0.5) * 18.0;
    float fwT = fwidth(pc.z);
    field = mix(field, soil * 1.05, (1.0 - smoothstep(0.35, 0.35 + fwT * 1.5, tm)) * (1.0 - smoothstep(0.3, 1.2, fwT)) * 0.8);
  }
  float fwB = fwidth(pc.x);
  field = mix(field, meadow * 0.95, (1.0 - smoothstep(1.1, 1.1 + fwB * 1.5, pc.x)) * (1.0 - smoothstep(2.0, 8.0, fwB)));
  // Too far to resolve the parcels: their average colour.
  field = mix(field, ${srgb(0.5, 0.52, 0.27)} * mix(0.85, 1.1, big), smoothstep(25.0, 70.0, foot));
  vec3 c = (vLand.x * forest + vLand.y * field + vLand.z * meadow) / rural;
  c = mix(c, bank, clamp(vLand.w / rural, 0.0, 1.0));
  float wl = rural * (1.0 - wRock * 0.6);
  a.rgb = mix(a.rgb, c, wl);
  a.a = mix(a.a, 0.92, wl);
  float soilN = (vLand.y * (ploughed ? 1.0 : soilShare) + vLand.x * 0.4) / rural;
  nn = mix(nn, mix(gn, dn, soilN), wl * 0.85);
}
`;

/** Animated water: procedural normal waves, fresnel reflection of the environment, depth tint. */
export function createWaterMaterial(murky = false): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x1d3b44,
    roughness: 0.06,
    metalness: 0.0,
    clearcoat: 0.0,
    envMapIntensity: 1.0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const uniforms = { uTime: G.uTime };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uTime; varying vec3 vWPos;\n${GLSL_COMMON}
vec2 waveGrad(vec2 p, float t) {
  vec2 g = vec2(0.0);
  float a = 0.5;
  vec2 dir = vec2(1.0, 0.3);
  for (int i = 0; i < 5; i++) {
    vec2 q = p * (0.35 * pow(1.9, float(i))) + dir * t * (0.6 + 0.25 * float(i));
    float e = 0.07;
    float h0 = vnoise(q), hx = vnoise(q + vec2(e, 0.0)), hz = vnoise(q + vec2(0.0, e));
    g += a * vec2(hx - h0, hz - h0) / e;
    a *= 0.55;
    dir = vec2(dir.y, -dir.x) * 1.1;
  }
  return g;
}`)
      .replace(
        '#include <normal_fragment_maps>',
        `vec2 wg = waveGrad(vWPos.xz, uTime) * 0.16;
vec3 nW = normalize(vec3(-wg.x, 1.0, -wg.y));
normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);`,
      )
      .replace(
        '#include <map_fragment>',
        `float dist = length(cameraPosition - vWPos);
diffuseColor.rgb = ${murky ? 'mix(vec3(0.045, 0.04, 0.025), vec3(0.08, 0.07, 0.04), fbm2(vWPos.xz * 0.3 + vec2(uTime * 0.4, 0.0)))' : 'mix(vec3(0.05, 0.13, 0.14), vec3(0.11, 0.2, 0.2), fbm2(vWPos.xz * 0.01))'};`,
      );
  };
  mat.customProgramCacheKey = () => 'water-v1' + (murky ? '-m' : '');
  return mat;
}
