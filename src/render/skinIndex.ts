/**
 * The one way to make a `skinIndex` vertex attribute.
 *
 * WebGL: plain floats. Chrome on Windows draws WebGL through ANGLE on Direct3D 11, which links
 * every program for float vertex inputs. Bone indices stored as Uint16 (read as float without
 * normalising) have no matching D3D vertex format, so ANGLE builds a second variant of the vertex
 * shader that converts them, synchronously, on the first draw of each skinned program. For a
 * skinned MeshPhysical garment that HLSL compile took seconds on Arnd's PC: frames where the main
 * thread idled 1-7 s waiting for the GPU process ("other" in the freeze log) with no new
 * three.js programs. Floats match the linked variant, so nothing compiles at draw time.
 *
 * WebGPU: three's node skinning reads `skinIndex` as uvec4, which needs integer data.
 */
import * as THREE from 'three';
import { WEBGPU } from './gpuMode';

export function skinIndexAttribute(indices: ArrayLike<number>): THREE.BufferAttribute {
  return WEBGPU ? new THREE.Uint16BufferAttribute(indices, 4) : new THREE.Float32BufferAttribute(indices, 4);
}
