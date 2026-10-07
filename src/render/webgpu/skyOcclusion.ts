// @ts-nocheck -- three's TSL typings infer swizzles and vector widths poorly; checked by rendering (docs/WEBGPU_PLAN.md).
/**
 * Sky occlusion (render/skyOcclusion.ts) for node materials: sun + sky/hemisphere/ambient light and
 * environment reflections scaled by a sky visibility factor, plus the dim cave ambient.
 *
 * The GLSL version rewrites `lights_fragment_begin`; node materials have no chunks, so the
 * material's lighting model (a fresh PhysicalLightingModel per build) is wrapped instead:
 *  - `direct()` of directional lights gets `lightColor * vis` (point/spot lights untouched),
 *  - `indirect()` first scales what the light nodes accumulated in the lighting context:
 *    `irradiance` (ambient + hemisphere lights) `* vis + caveAmbient`, `radiance` and
 *    `iblIrradiance` (environment) `* vis`.
 * Same as the GLSL except: light probes and light maps (none on the patched materials) are also
 * scaled, as they land in the same `irradiance` sum.
 */
import { uniform, attribute, varyingProperty } from 'three/tsl';
import { caveAmbient, type SkyVisMode, type SkyVisPatch } from '../skyOcclusion';
import { shared } from './common';

type LightingModelHook = (lm: Record<string, unknown>, builder: unknown) => void;

/**
 * Run `hook` on the lighting model each time the material is built (before it is used). Hooks
 * chain: a later hook sees (and may wrap) the methods a former one replaced.
 */
export function onLightingModel(mat: { setupLightingModel: (b: unknown) => unknown }, hook: LightingModelHook): void {
  const base = mat.setupLightingModel;
  mat.setupLightingModel = function (builder) {
    const lm = base.call(this, builder);
    if (lm) hook(lm, builder);
    return lm;
  };
}

/** A float uniform node following a `{ value }` object (per material). */
export function follow(u: { value: number }) {
  return uniform(u.value).onObjectUpdate(() => u.value);
}

const SKY = Symbol('skyVis');

/** A clone sharing a 'uniform'-mode material's graph gets its own sky value through this. */
export function ownSkyPatch(clone, source): SkyVisPatch {
  const patch: SkyVisPatch = { uniform: { value: source[SKY]?.uniform?.value ?? 1 } };
  clone[SKY] = patch;
  return patch;
}

/**
 * Node-material version of `patchSkyOcclusion`. Modes as in the GLSL version; for 'varying' the
 * material provides the node as `material.skyVisNode` (else the varying `vSkyVis` is read).
 */
export function patchSkyOcclusionNode(material, mode: SkyVisMode, init = 1): SkyVisPatch {
  const patch: SkyVisPatch = {};
  let vis;
  if (mode === 'uniform') {
    patch.uniform = { value: init };
    material[SKY] = patch;
    // The drawn material's own value, so clones sharing this graph keep theirs (`ownSkyPatch`).
    vis = uniform(init).onObjectUpdate(({ material: m }) => (m?.[SKY] ?? patch).uniform.value);
  } else if (mode === 'attribute') {
    vis = attribute('skyVis', 'float');
  } else {
    vis = material.skyVisNode ?? varyingProperty('float', 'vSkyVis');
  }
  const cave = shared(caveAmbient);
  onLightingModel(material, (lm) => {
    const direct = lm.direct.bind(lm);
    const indirect = lm.indirect.bind(lm);
    // directLight.color *= vSkyVis (sun / directional lights only)
    lm.direct = (data, builder) => direct(data.lightNode?.light?.isDirectionalLight ? { ...data, lightColor: data.lightColor.mul(vis) } : data, builder);
    lm.indirect = (builder) => {
      const { irradiance, radiance, iblIrradiance } = builder.context;
      // irradiance = ambient * vSkyVis + uCaveAmbient; hemisphere lights * vSkyVis
      irradiance.assign(irradiance.mul(vis).add(cave));
      // Environment reflections are sky reflections too.
      radiance.mulAssign(vis);
      iblIrradiance.mulAssign(vis);
      indirect(builder);
    };
  });
  return patch;
}
