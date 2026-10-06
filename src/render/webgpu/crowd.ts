// @ts-nocheck -- three's TSL typings infer swizzles and vector widths poorly; checked by rendering (docs/WEBGPU_PLAN.md).
/**
 * The crowd's vertex-animation material (sim/CrowdRenderer.ts, VAT_DECL / patchVat) as a node
 * material: positions and normals from the baked VAT textures (two frames blended), the colour
 * of the vertex's slot from the per-instance colours.
 *
 * Positions and normals replace the geometry's ahead of three's instancing (`setupPosition`), as
 * the GLSL did at begin_vertex / beginnormal_vertex. The shadow pass has no customDepthMaterial
 * and applies `castShadowPositionNode` after instancing, so that node does the instance
 * transform itself, from its own view of the instance matrices (`material.userData.instanceBuffer`,
 * marked for upload by CrowdRenderer together with `instanceMatrix`).
 */
import * as THREE from 'three/webgpu';
import {
  Fn, int, ivec2, vec4, mix, normalize, max, fract, floor, mod, select, attribute, varying, textureLoad, positionLocal, normalLocal,
  mat4, instancedDynamicBufferAttribute,
} from 'three/tsl';
import { setDiffuse } from './ground';

export function createCrowdNodeMaterial(vatPos: THREE.Texture, vatNrm: THREE.Texture, instanceMatrix: THREE.InstancedBufferAttribute): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
  const aVid = attribute('aVid', 'float'), aSlot = attribute('aSlot', 'float');
  const iAnim = attribute('iAnim', 'vec4'); // clip start row, frames, phase 0..1, blend to idle (unused)
  const iC = [0, 1, 2, 3, 4, 5].map((c) => attribute('iC' + c, 'vec3'));

  // vatSample() / vatNormal(): the two frames around the phase, blended.
  const vatSample = (tex: THREE.Texture) => Fn(() => {
    const frames = max(iAnim.y, 1.0).toVar();
    const fr = fract(iAnim.z).mul(frames).toVar();
    const f0 = floor(fr).toVar();
    const f1 = mod(f0.add(1.0), frames);
    const v = int(aVid.add(0.5)).toVar();
    const p0 = textureLoad(tex, ivec2(v, int(iAnim.x.add(f0)))).xyz;
    const p1 = textureLoad(tex, ivec2(v, int(iAnim.x.add(f1)))).xyz;
    return mix(p0, p1, fr.sub(f0));
  })();
  const gVatPos = vatSample(vatPos);
  const vatNormal = normalize(vatSample(vatNrm).add(1e-5));

  const base = mat.setupPosition;
  mat.setupPosition = function (builder) {
    // vec3 objectNormal = vatNormal(); vec3 transformed = gVatPos;
    normalLocal.assign(vatNormal);
    positionLocal.assign(gVatPos);
    return base.call(this, builder);
  };

  // Shadow pass: instance matrix × VAT position (positionNode-style, applied after instancing).
  const ib = new THREE.InstancedInterleavedBuffer(instanceMatrix.array as Float32Array, 16, 1);
  ib.setUsage(THREE.DynamicDrawUsage);
  const M = mat4(
    instancedDynamicBufferAttribute(ib, 'vec4', 16, 0),
    instancedDynamicBufferAttribute(ib, 'vec4', 16, 4),
    instancedDynamicBufferAttribute(ib, 'vec4', 16, 8),
    instancedDynamicBufferAttribute(ib, 'vec4', 16, 12),
  );
  mat.castShadowPositionNode = M.mul(vec4(gVatPos, 1.0)).xyz;
  mat.userData.instanceBuffer = ib;

  // vCrowdCol: the colour of the vertex's slot.
  const sl = int(aSlot.add(0.5));
  const vCrowdCol = varying(select(sl.equal(0), iC[0], select(sl.equal(1), iC[1], select(sl.equal(2), iC[2], select(sl.equal(3), iC[3], select(sl.equal(4), iC[4], iC[5]))))), 'vCrowdCol');
  setDiffuse(mat, () => vCrowdCol);
  return mat;
}
