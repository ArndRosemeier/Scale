// @ts-nocheck -- three's TSL typings infer swizzles and vector widths poorly; checked by rendering (docs/WEBGPU_PLAN.md).
/**
 * Garment layering (humanoid/client/Character.ts) for node materials: an Actors clothing layer is
 * drawn with its view-space position scaled toward the camera instead of a polygon offset, so it
 * keeps its screen position and sits a fixed fraction of the distance nearer (on the reversed
 * float depth buffer the offset's slope term lost fragments of thin seam triangles).
 *
 * The GLSL version rewrites `project_vertex`; here the material's clip-space output is replaced.
 * Skinning still runs first (it moves `positionLocal`, which `positionView` reads).
 */
import { cameraProjectionMatrix, positionView, vec4 } from 'three/tsl';

export function viewSpaceLayerNode(material, scale: number): void {
  material.polygonOffset = false;
  material.vertexNode = cameraProjectionMatrix.mul(vec4(positionView.mul(scale), 1));
  material.needsUpdate = true;
}
