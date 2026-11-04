// @ts-nocheck -- three's TSL typings infer swizzles and vector widths poorly; checked by rendering (docs/WEBGPU_PLAN.md).
/**
 * Garment layering (humanoid/client/Character.ts) for node materials: an Actors clothing layer is
 * drawn with its view-space position moved toward the camera instead of a polygon offset, so it
 * keeps its screen position and sits a fixed distance (`pull` metres) nearer (on the reversed
 * float depth buffer the offset's slope term lost fragments of thin seam triangles).
 *
 * The GLSL version rewrites `project_vertex`; here the material's clip-space output is replaced.
 * Skinning still runs first (it moves `positionLocal`, which `positionView` reads).
 */
import { cameraProjectionMatrix, float, length, max, positionView, vec4 } from 'three/tsl';

/** One node per pull distance: three keys shader builds by node identity, so materials (every
 * person's garments) that got their own node each built their own shader. */
const byPull = new Map<number, unknown>();

export function viewSpaceLayerNode(material, pull: number): void {
  material.polygonOffset = false;
  let node = byPull.get(pull);
  if (!node) {
    const k = max(float(1).sub(float(pull).div(max(length(positionView), 1e-3))), 0.5);
    byPull.set(pull, (node = cameraProjectionMatrix.mul(vec4(positionView.mul(k), 1))));
  }
  material.vertexNode = node;
  material.needsUpdate = true;
}
