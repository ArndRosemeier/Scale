/**
 * Sky occlusion: sunlight and sky ambient must not reach deep into caves.
 * Shadow maps only cover a limited range, so every lit material in Norgo is
 * patched to scale sun + sky/hemisphere lighting by a "sky visibility" factor
 * (0 = deep underground, 1 = open sky). Point lights (torches, spells) are not
 * affected.
 *
 * Modes:
 *  - 'attribute': per-vertex `skyVis` float attribute (terrain, instanced flora)
 *  - 'uniform':   per-material uniform `uSkyVis` (characters, creatures, props)
 *  - 'varying':   the vertex shader of the patched material already writes `vSkyVis`
 */
import * as THREE from 'three';
import { WEBGPU, gpuKit } from './gpuMode';

export type SkyVisMode = 'attribute' | 'uniform' | 'varying';

/** Global underground ambient (bluish, very dim) applied where sky visibility is 0. */
export const caveAmbient = { value: new THREE.Color(0.018, 0.02, 0.028) };

export interface SkyVisPatch {
  uniform?: { value: number };
}

/**
 * Patch a material's shader source to use sky visibility. Call before first render.
 * Chains with existing onBeforeCompile hooks.
 */
export function patchSkyOcclusion(material: THREE.Material, mode: SkyVisMode, init = 1): SkyVisPatch {
  // Node materials (WebGPU): the same through their lighting model (webgpu/skyOcclusion.ts).
  if (WEBGPU && (material as { isNodeMaterial?: boolean }).isNodeMaterial) return gpuKit().patchSkyOcclusionNode(material, mode, init);
  const patch: SkyVisPatch = {};
  if (mode === 'uniform') patch.uniform = { value: init };
  const prev = material.onBeforeCompile?.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    shader.uniforms.uCaveAmbient = caveAmbient;
    if (patch.uniform) shader.uniforms.uSkyVis = patch.uniform;
    if (mode === 'attribute') {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float skyVis;\nvarying float vSkyVis;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSkyVis = skyVis;');
    }
    let fragHead = 'uniform vec3 uCaveAmbient;\n';
    if (mode === 'uniform') fragHead += 'uniform float uSkyVis;\n#define vSkyVis uSkyVis\n';
    else fragHead += 'varying float vSkyVis;\n';
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + fragHead);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_begin>',
      THREE.ShaderChunk.lights_fragment_begin
        .replace('getSunLightInfo( sunLight, directLight );', 'getSunLightInfo( sunLight, directLight );\n\t\tdirectLight.color *= vSkyVis;')
        .replace('getDirectionalLightInfo( directionalLight, directLight );', 'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= vSkyVis;')
        .replace(
          'vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );',
          'vec3 irradiance = getAmbientLightIrradiance( ambientLightColor ) * vSkyVis + uCaveAmbient;',
        )
        .replace(
          /irradiance \+= getHemisphereLightIrradiance\( hemisphereLights\[ i \], geometryNormal \);/,
          'irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal ) * vSkyVis;',
        ),
    );
    // Environment reflections are sky reflections too.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_maps>',
      '#include <lights_fragment_maps>\n#if defined( RE_IndirectSpecular )\n\tradiance *= vSkyVis;\n#endif\n#if defined( RE_IndirectDiffuse )\n\tiblIrradiance *= vSkyVis;\n#endif',
    );
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|sky:' + mode;
  return patch;
}

/**
 * CPU estimate of sky visibility for a dynamic object at (x,y,z): 1 above the
 * 2D surface, fading to 0 a few meters below it, and 0 in the underworld.
 * `surfaceY` should come from WorldGenerator.heightAt.
 */
export function estimateSkyVis(y: number, surfaceY: number, openAbove = false): number {
  if (openAbove) return 1;
  const depth = surfaceY - y;
  if (depth < 1.5) return 1;
  const t = Math.min(1, (depth - 1.5) / 10);
  return 1 - t * t * (3 - 2 * t);
}
