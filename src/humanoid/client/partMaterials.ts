/**
 * Materials for the non-skin parts of a humanoid: procedural eyes (iris
 * with fibres, limbal ring, pupil shapes, glow, refraction parallax, wet
 * clearcoat cornea, lid shadow), strand-card hair with Kajiya–Kay dual
 * highlights, sylvan leaf hair, keratin horns/tusks, lashes, teeth, tongue.
 * All patched for sky occlusion ('uniform'); `setSky` updates every patch.
 */
import * as THREE from 'three';
import { patchSkyOcclusion, type SkyVisPatch } from '../../render/skyOcclusion';
import { GLSL_NOISE } from './glsl';
import { WEBGPU, gpuKit } from '../../render/gpuMode';
import { strandTexture, leafTexture } from './textures';

export interface PatchedMaterial<U = Record<string, { value: unknown }>> {
  material: THREE.Material;
  uniforms: U;
  sky: SkyVisPatch;
}

const lin = (c: [number, number, number]) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);

// ------------------------------------------------------------------ eyes

export interface EyeUniforms {
  uIris: { value: THREE.Color };
  uPupil: { value: THREE.Vector4 }; // x shape (0 round,1 slit,2 goat,3 none), y dilation, z glow, w seed
  uScleraTint: { value: THREE.Color };
}

const EYE_FRAG = /* glsl */ `
uniform vec3 uIris;
uniform vec4 uPupil;
uniform vec3 uScleraTint;
varying vec3 vEyeP;
${GLSL_NOISE}
vec3 ey_albedo; vec3 ey_emit; float ey_rough;
void eyeEval() {
  vec3 p = normalize(vEyeP);
  // Forward is −Z. Parallax: the iris sits behind the cornea, shift by view direction.
  vec3 vdir = normalize(vViewPosition);
  vec2 q = p.xy - vdir.xy * 0.035 * smoothstep(0.7, 0.95, -p.z);
  float r = length(q);
  float ang = atan(q.y, q.x);
  float irisR = 0.47;
  float iris = 1.0 - smoothstep(irisR - 0.015, irisR + 0.01, r);
  iris *= step(0.0, -p.z);
  float pr = 0.16 + uPupil.y * 0.08;
  float pupil;
  if (uPupil.x < 0.5) pupil = 1.0 - smoothstep(pr - 0.012, pr + 0.008, r);
  else if (uPupil.x < 1.5) pupil = 1.0 - smoothstep(0.9, 1.05, length(vec2(q.x / (pr * 0.28), q.y / (pr * 2.2))));
  else if (uPupil.x < 2.5) pupil = (1.0 - smoothstep(0.9, 1.05, abs(q.x) / (pr * 1.7))) * (1.0 - smoothstep(0.9, 1.05, abs(q.y) / (pr * 0.45)));
  else pupil = 0.0;
  // Iris fibres, crypts, collarette and limbal ring.
  float fib = h_noise2(vec2(ang * 9.0, r * 12.0) + uPupil.w * 10.0) * 0.6 + h_noise2(vec2(ang * 40.0, r * 3.0)) * 0.4;
  float crypt = smoothstep(0.55, 0.7, h_noise2(vec2(ang * 6.0, r * 20.0) + 3.0));
  float collar = smoothstep(0.03, 0.0, abs(r - pr * 1.9)) * 0.5;
  vec3 ic = uIris * (0.55 + 0.75 * fib) * (1.0 - 0.35 * crypt);
  ic = mix(ic, uIris * 1.6 + 0.05, collar);
  ic = mix(ic, ic * 0.55 + uIris * 0.2 * vec3(0.9, 0.8, 0.6), smoothstep(pr * 2.6, pr * 1.2, r) * 0.25);
  float limbal = smoothstep(irisR - 0.12, irisR, r);
  ic *= 1.0 - 0.65 * limbal;
  // Sclera: off-white, veins toward the corners, darker at the back.
  float veins = smoothstep(0.62, 0.68, h_noise3(p * 14.0 + uPupil.w)) * smoothstep(0.3, 0.9, length(p.xy)) * 0.5;
  vec3 sc = uScleraTint * mix(vec3(0.82, 0.8, 0.78), vec3(0.75, 0.38, 0.35), veins);
  sc *= mix(1.0, 0.55, smoothstep(0.3, 0.95, length(p.xy)));
  vec3 col = mix(sc, ic, iris);
  col = mix(col, vec3(0.006), pupil * iris);
  // Upper lid shadow & ambient occlusion in the socket.
  col *= mix(1.0, 0.45, smoothstep(0.15, 0.6, p.y));
  col *= mix(1.0, 0.75, smoothstep(0.6, 1.0, abs(p.x)));
  ey_albedo = col;
  ey_emit = uIris * iris * (1.0 - pupil) * uPupil.z * (0.6 + 0.8 * fib) * 2.5;
  ey_rough = mix(0.35, 0.2, iris);
}
`;

export function createEyeMaterial(): PatchedMaterial<EyeUniforms> {
  if (WEBGPU) return gpuKit().createEyeNodeMaterial() as unknown as PatchedMaterial<EyeUniforms>;
  const material = new THREE.MeshPhysicalMaterial({ roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.03, ior: 1.376, specularIntensity: 0.6 });
  const uniforms: EyeUniforms = {
    uIris: { value: new THREE.Color(0.2, 0.12, 0.05) },
    uPupil: { value: new THREE.Vector4(0, 0.5, 0, 0.3) },
    uScleraTint: { value: new THREE.Color(1, 1, 1) },
  };
  material.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEyeP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEyeP = position;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\n' + EYE_FRAG)
      .replace('#include <color_fragment>', '#include <color_fragment>\neyeEval();\ndiffuseColor.rgb = ey_albedo;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = ey_rough;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += ey_emit;');
  };
  material.customProgramCacheKey = () => 'norgo-eye';
  const sky = patchSkyOcclusion(material, 'uniform');
  return { material, uniforms, sky };
}

/** Eyeball geometry (unit radius scaled by caller) with a cornea bulge toward −Z. */
let eyeGeo: THREE.BufferGeometry | null = null;
export function eyeGeometry(): THREE.BufferGeometry {
  if (eyeGeo) return eyeGeo;
  const g = new THREE.SphereGeometry(1, 32, 24);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i);
    if (z < -0.82) {
      // Cornea dome: bulge forward over the iris.
      const k = (-z - 0.82) / 0.18;
      p.setZ(i, z - 0.09 * Math.sin(k * Math.PI * 0.5));
    }
  }
  g.computeVertexNormals();
  eyeGeo = g;
  return g;
}

// ------------------------------------------------------------------ hair

export interface HairUniforms {
  uColor: { value: THREE.Color };
  uTip: { value: THREE.Color };
  uSpec: { value: THREE.Vector4 }; // x primary, y secondary, z shift, w leaf mode
}

const HAIR_VERT_HEAD = /* glsl */ `
attribute vec3 hairTangent;
attribute vec2 hairAux;
varying vec3 vHairT;
varying vec2 vHairAux;
`;
const HAIR_FRAG_HEAD = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uTip;
uniform vec4 uSpec;
varying vec3 vHairT;
varying vec2 vHairAux;
vec3 hairT;
float hairShift;
`;

function hairLightChunk(): string {
  let c = THREE.ShaderChunk.lights_physical_pars_fragment;
  const target = 'reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;';
  if (!c.includes(target)) return c;
  c = c.replace(target, /* glsl */ `{
    // Kajiya–Kay: primary (white, shifted to the root) and secondary (tinted, shifted to the tip) lobes.
    vec3 Hh = normalize( directLight.direction + geometryViewDir );
    float tA = dot( normalize( hairT + geometryNormal * ( 0.12 + hairShift ) ), Hh );
    float tB = dot( normalize( hairT - geometryNormal * ( 0.18 - hairShift ) ), Hh );
    float s1 = pow( max( 0.0, sqrt( max( 0.0, 1.0 - tA * tA ) ) ), 90.0 ) * uSpec.x;
    float s2 = pow( max( 0.0, sqrt( max( 0.0, 1.0 - tB * tB ) ) ), 22.0 ) * uSpec.y;
    float nl = saturate( dot( geometryNormal, directLight.direction ) * 0.5 + 0.5 );
    reflectedLight.directSpecular += directLight.color * nl * ( vec3( s1 ) + s2 * material.diffuseContribution * 2.0 );
  }`);
  // Softer, wrapped diffuse for hair volumes.
  c = c.replace(
    'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );',
    'reflectedLight.directDiffuse += directLight.color * saturate( ( dot( geometryNormal, directLight.direction ) + 0.35 ) / 1.35 ) * BRDF_Lambert( material.diffuseContribution );',
  );
  return c;
}
let hairChunk: string | null = null;

export function createHairMaterial(leaf: boolean): PatchedMaterial<HairUniforms> {
  if (WEBGPU) return gpuKit().createHairNodeMaterial(leaf) as unknown as PatchedMaterial<HairUniforms>;
  const tex = leaf ? leafTexture() : strandTexture();
  const material = new THREE.MeshPhysicalMaterial({
    roughness: 0.55,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaMap: tex,
    alphaTest: leaf ? 0.5 : 0.38,
    specularIntensity: leaf ? 0.4 : 0,
    sheen: leaf ? 0.2 : 0,
    envMapIntensity: leaf ? 0.5 : 0.15,
  });
  const uniforms: HairUniforms = {
    uColor: { value: new THREE.Color(0.1, 0.07, 0.05) },
    uTip: { value: new THREE.Color(0.14, 0.1, 0.07) },
    uSpec: { value: new THREE.Vector4(0.45, 0.6, 0, leaf ? 1 : 0) },
  };
  material.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms, { uStrands: { value: tex } });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\n' + HAIR_VERT_HEAD)
      .replace('#include <skinnormal_vertex>', `#include <skinnormal_vertex>
        vec3 ht = hairTangent;
        #ifdef USE_SKINNING
          ht = ( skinMatrix * vec4( ht, 0.0 ) ).xyz;
        #endif
        vHairT = normalize( ( modelViewMatrix * vec4( ht, 0.0 ) ).xyz );
        vHairAux = hairAux;`);
    hairChunk ??= hairLightChunk();
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\n' + HAIR_FRAG_HEAD + '\nuniform sampler2D uStrands;')
      .replace('#include <lights_physical_pars_fragment>', leaf ? '#include <lights_physical_pars_fragment>' : hairChunk)
      // Mip-aware alpha boost: thin strands average out in lower mips and would
      // fall below the alpha test (cards thinning/sparkling with distance).
      .replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
        {
          vec2 dd = fwidth( vAlphaMapUv * vec2( 256.0, 512.0 ) );
          float mipLevel = max( 0.0, log2( max( max( dd.x, dd.y ), 1e-4 ) ) );
          diffuseColor.a *= 1.0 + mipLevel * 0.3;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec4 st = texture2D( uStrands, vAlphaMapUv );
        hairT = normalize( vHairT );
        hairShift = ( st.b - 0.5 ) * 0.25;
        if ( uSpec.w > 0.5 ) {
          // Leaves: per-leaf hue jitter, darker veins, autumn tint toward the tips.
          vec3 c = mix( uColor, uTip, st.b * 0.6 + vHairAux.y * 0.3 );
          diffuseColor.rgb = c * ( 0.55 + 0.6 * st.r ) * ( 0.8 + 0.4 * vHairAux.x );
        } else {
          float rootDark = mix( 0.5, 1.0, smoothstep( 0.0, 0.35, vHairAux.y ) );
          vec3 c = mix( uColor, uTip, smoothstep( 0.3, 1.0, vHairAux.y ) );
          diffuseColor.rgb = c * ( 0.82 + 0.3 * st.r ) * ( 0.9 + 0.2 * vHairAux.x ) * rootDark;
        }`);
  };
  material.customProgramCacheKey = () => `norgo-hair-${leaf ? 1 : 0}`;
  const sky = patchSkyOcclusion(material, 'uniform');
  return { material, uniforms, sky };
}

export function applyHairColor(u: HairUniforms, hair: [number, number, number], leaf: boolean, accent?: [number, number, number]) {
  const c = lin(hair);
  u.uColor.value.copy(c);
  if (leaf) u.uTip.value.copy(accent ? lin(accent) : c.clone().multiply(new THREE.Color(1.3, 0.9, 0.5)));
  else u.uTip.value.copy(c.clone().multiplyScalar(1.25).lerp(new THREE.Color(0.6, 0.5, 0.35), 0.06));
  // Dark hair shows a cooler, stronger primary highlight; blond a softer one.
  const l = c.r * 0.3 + c.g * 0.6 + c.b * 0.1;
  // Light hair already scatters most light: keep its highlights soft.
  const dark = 1 - Math.min(1, l * 2.2);
  u.uSpec.value.x = 0.025 + dark * 0.06;
  u.uSpec.value.y = 0.05 + dark * 0.06;
}

// ------------------------------------------------------------------ horns / tusks / fins

export interface HornUniforms { uBase: { value: THREE.Color }; uTipC: { value: THREE.Color }; uRidge: { value: number } }

export function createHornMaterial(): PatchedMaterial<HornUniforms> {
  if (WEBGPU) return gpuKit().createHornNodeMaterial() as unknown as PatchedMaterial<HornUniforms>;
  const material = new THREE.MeshPhysicalMaterial({ roughness: 0.45, clearcoat: 0.3, clearcoatRoughness: 0.4 });
  const uniforms: HornUniforms = {
    uBase: { value: new THREE.Color(0.3, 0.26, 0.2) },
    uTipC: { value: new THREE.Color(0.85, 0.8, 0.7) },
    uRidge: { value: 1 },
  };
  material.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vHornUv;\nvarying vec3 vHornP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHornUv = uv;\nvHornP = position;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uBase; uniform vec3 uTipC; uniform float uRidge;
        varying vec2 vHornUv; varying vec3 vHornP;
        ${GLSL_NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float t = vHornUv.y;
        float streak = h_noise2( vec2( vHornUv.x * 30.0, t * 4.0 ) );
        float rings = 0.5 + 0.5 * sin( t * 70.0 * uRidge + streak * 2.0 );
        diffuseColor.rgb = mix( uBase, uTipC, smoothstep( 0.1, 0.95, t ) ) * ( 0.8 + 0.25 * streak ) * ( 0.9 + 0.1 * rings );`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float hgt = sin( vHornUv.y * 70.0 * uRidge ) * 0.00025 * uRidge;
          vec3 sx = dFdx( -vViewPosition ), sy = dFdy( -vViewPosition );
          vec3 r1 = cross( sy, normal ), r2 = cross( normal, sx );
          float det = dot( sx, r1 ) * faceDirection;
          normal = normalize( abs( det ) * normal - sign( det ) * ( dFdx( hgt ) * r1 + dFdy( hgt ) * r2 ) );
        }`);
  };
  material.customProgramCacheKey = () => 'norgo-horn';
  const sky = patchSkyOcclusion(material, 'uniform');
  return { material, uniforms, sky };
}

export function simpleMaterial(color: THREE.ColorRepresentation, opts: THREE.MeshPhysicalMaterialParameters = {}): PatchedMaterial<Record<string, never>> {
  if (WEBGPU) return gpuKit().simpleNodeMaterial(color, opts as Record<string, unknown>) as unknown as PatchedMaterial<Record<string, never>>;
  const material = new THREE.MeshPhysicalMaterial({ color, ...opts });
  const sky = patchSkyOcclusion(material, 'uniform');
  return { material, uniforms: {}, sky };
}

/** Eyelash cards: strand texture along the lid. */
export function createLashMaterial(): PatchedMaterial<{ uColor: { value: THREE.Color } }> {
  if (WEBGPU) return gpuKit().createLashNodeMaterial() as unknown as PatchedMaterial<{ uColor: { value: THREE.Color } }>;
  const tex = strandTexture();
  const material = new THREE.MeshStandardMaterial({ color: 0x0a0806, roughness: 0.6, side: THREE.DoubleSide, alphaMap: tex, alphaTest: 0.55, envMapIntensity: 0 });
  // Lower lashes (negative u = below the eye centre) are sparser and shorter.
  material.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vLashUv;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvLashUv = uv;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vLashUv;')
      .replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\nif (vLashUv.x < 0.0) diffuseColor.a *= 0.55 * (1.0 - smoothstep(0.5, 0.9, vLashUv.y));');
  };
  material.customProgramCacheKey = () => 'norgo-lash';
  const sky = patchSkyOcclusion(material, 'uniform');
  return { material, uniforms: { uColor: { value: material.color } }, sky };
}
