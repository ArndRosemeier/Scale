/**
 * Ground materials: urban surfaces (texture array by layer), natural terrain
 * (slope/height blended grass, dirt, rock, sand) and water.
 */
import * as THREE from 'three';
import type { MaterialArrays } from '../TextureLibrary';
import { G } from './globals';
import { GLSL_COMMON } from './glsl';

export function createGroundMaterial(arrays: MaterialArrays): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const uniforms = {
    uAlb: { value: arrays.albedo },
    uNrm: { value: arrays.normal },
    uTile: { value: arrays.tileMeters.slice(0, 16).concat(new Array(Math.max(0, 16 - arrays.tileMeters.length)).fill(2)) },
    uNight: G.uNight,
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float aLayer;\nvarying vec2 vMUv; varying float vLayer;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\nvMUv = uv; vLayer = aLayer;`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2DArray uAlb; uniform sampler2DArray uNrm; uniform float uTile[16];
varying vec2 vMUv; varying float vLayer;
${GLSL_COMMON}
vec4 gAR; vec4 gNH; vec2 gTuv;`,
      )
      .replace(
        '#include <map_fragment>',
        `int layer = int(vLayer + 0.5);
gTuv = vMUv / uTile[layer];
// Break up tiling with a large-scale rotation/offset per 37 m cell for natural layers.
gAR = texture(uAlb, vec3(gTuv, vLayer));
gNH = texture(uNrm, vec3(gTuv, vLayer));
float macroV = fbm2(vMUv * 0.035);
vec3 alb = gAR.rgb * mix(0.86, 1.1, macroV);
if (layer == 3) alb *= mix(vec3(0.92, 0.95, 0.85), vec3(1.05, 1.0, 1.02), fbm2(vMUv * 0.11));
diffuseColor.rgb = alb * mix(1.0, gNH.a, 0.85);`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gAR.a;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace('#include <normal_fragment_maps>', 'normal = perturbNormalUV(-vViewPosition, normal, gTuv, gNH.xy * 2.0 - 1.0, 1.0);');
  };
  mat.customProgramCacheKey = () => 'ground-v1';
  return mat;
}

/** Natural terrain outside the urban surfaces. */
/** Up to 16 street holes (metro entrances, open manholes) that the terrain must not cover. */
export const terrainHoles = {
  uHoleA: { value: Array.from({ length: 16 }, () => new THREE.Vector4(0, 0, 1, 0)) },
  uHoleB: { value: Array.from({ length: 16 }, () => new THREE.Vector4(0, 0, 0, 0)) },
  uHoleN: { value: 0 },
};

export function createTerrainMaterial(arrays: MaterialArrays): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  const uniforms = {
    ...terrainHoles,
    uAlb: { value: arrays.albedo },
    uNrm: { value: arrays.normal },
    uTile: { value: arrays.tileMeters.slice(0, 16).concat(new Array(Math.max(0, 16 - arrays.tileMeters.length)).fill(2)) },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vMUv; varying vec3 vWPos; varying vec3 vWNrm;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\nvMUv = uv;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vWNrm = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2DArray uAlb; uniform sampler2DArray uNrm; uniform float uTile[16];
uniform vec4 uHoleA[16]; uniform vec4 uHoleB[16]; uniform int uHoleN;
varying vec2 vMUv; varying vec3 vWPos; varying vec3 vWNrm;
${GLSL_COMMON}
float gRough; vec2 gTn; vec2 gTuv;`,
      )
      .replace(
        '#include <map_fragment>',
        `for (int i = 0; i < 16; i++) {
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
a = mix(a, sa * vec4(1.15, 1.08, 0.9, 1.0), wSand); nn = mix(nn, sn, wSand);
gRough = a.a; gTn = nn.xy * 2.0 - 1.0; gTuv = tg;
diffuseColor.rgb = a.rgb * mix(0.85, 1.1, n) * mix(1.0, nn.a, 0.8);`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace('#include <normal_fragment_maps>', 'normal = perturbNormalUV(-vViewPosition, normal, gTuv, gTn, 1.0);');
  };
  mat.customProgramCacheKey = () => 'terrain-v2';
  return mat;
}

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
