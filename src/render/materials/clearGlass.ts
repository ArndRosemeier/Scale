/**
 * Clear glass of the landmarks (the glazed walkway of a helix tower, glass orbs, domes and
 * balustrades): transparent and glossy, reflecting the environment, a faint tint and a little
 * glow at night (lit insides behind it). One material shared by all of them, and one per
 * breakable landmark that follows its element state (broken pieces vanish).
 */
import * as THREE from 'three';
import { G } from './globals';
import { WEBGPU, gpuKit } from '../gpuMode';
import { GLSL_ELEM_VERTEX_DECL, GLSL_ELEM_VERTEX_MAIN } from './glsl';

let mat: THREE.MeshPhysicalMaterial | null = null;

export function clearGlassMaterial(): THREE.MeshPhysicalMaterial {
  if (WEBGPU) return gpuKit().clearGlassNodeMaterial() as unknown as THREE.MeshPhysicalMaterial;
  return (mat ??= make());
}

/** Clear glass whose elements (aElem) follow a state texture, like the facade material. */
export function clearGlassElemMaterial(elemTex: THREE.Texture, elemW: number): THREE.MeshPhysicalMaterial {
  if (WEBGPU) return gpuKit().clearGlassElemNodeMaterial(elemTex, elemW) as unknown as THREE.MeshPhysicalMaterial;
  const m = make();
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uElemTex = { value: elemTex };
    sh.uniforms.uElemW = { value: elemW };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${GLSL_ELEM_VERTEX_DECL}`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>\n${GLSL_ELEM_VERTEX_MAIN}`);
  };
  m.customProgramCacheKey = () => 'clearGlassElem';
  return m;
}

function make(): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xcfe6f0, roughness: 0.06, metalness: 0.05, transparent: true, opacity: 0.22,
    side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 1.4, specularIntensity: 1,
    emissive: new THREE.Color(0xffe2b0), emissiveIntensity: 0,
  });
  const m = mat;
  // Warm glow at night (G.uNight is shared by every city material).
  m.onBeforeRender = () => { m.emissiveIntensity = G.uNight.value * 0.12; };
  return m;
}
