/**
 * GPU-only data: drop the CPU copy of a geometry or data texture once three has uploaded it.
 * For data that is never read back or changed on the CPU (city meshes, baked crowd animation,
 * the material texture arrays): the CPU copy is otherwise kept for the whole session, in the
 * tab's own memory, next to the GPU copy.
 *
 * Both use three's documented upload hooks (BufferAttribute.onUpload, Texture.onUpdate), which
 * the WebGL renderer calls after the upload. (The WebGPU renderer calls Texture.onUpdate too but
 * not BufferAttribute.onUpload: geometry keeps its copy there.) Never use it on data that gets
 * `needsUpdate` again later: the next upload would find no data.
 */
import type * as THREE from 'three';

/** Free the CPU copy of a geometry once it is on the GPU (its bounds must be set beforehand). */
export function releaseAfterUpload(g: THREE.BufferGeometry): void {
  const drop = function (this: THREE.BufferAttribute) {
    (this as unknown as { array: unknown }).array = null;
    g.userData.onGpu = true;
  };
  for (const k in g.attributes) (g.attributes[k] as THREE.BufferAttribute).onUpload(drop);
  g.index?.onUpload(drop);
}

/** A geometry given to releaseAfterUpload is on the GPU (and its CPU copy gone). */
export const onGpu = (g: THREE.BufferGeometry): boolean => g.userData.onGpu === true;

/**
 * three uploads a geometry the first time it draws it, so a mesh that stays hidden (a far cell's
 * detailed facade, a near cell's LOD) keeps its CPU copy for as long as it is loaded. The primer
 * gives such meshes one empty draw each (draw range 0, no frustum culling) in an ordinary frame:
 * three uploads the buffers and draws nothing. One mesh per frame (an upload can be tens of MB).
 */
export class UploadPrimer {
  /** Off on the WebGPU renderer (it never calls onUpload, nothing would be freed). */
  enabled = true;
  private wait: THREE.Mesh[] = [];
  private live: { m: THREE.Mesh; visible: boolean; culled: boolean; count: number } | null = null;

  add(m: THREE.Mesh): void { if (this.enabled) this.wait.push(m); }

  /** Each frame first thing (before the owner changes visibility): undoes last frame's priming. */
  settle(): void {
    const l = this.live;
    if (l) {
      l.m.visible = l.visible;
      l.m.frustumCulled = l.culled;
      l.m.geometry.drawRange.count = l.count;
      this.live = null;
      // Not drawn after all (its group hidden, its shader still compiling): try again later.
      if (!onGpu(l.m.geometry)) this.wait.push(l.m);
    }
  }

  /** Each frame last thing before rendering: primes the next mesh. `keep` false drops one (unloaded). */
  prime(keep: (m: THREE.Mesh) => boolean): void {
    while (this.enabled && this.wait.length) {
      const m = this.wait.shift()!;
      if (!keep(m) || onGpu(m.geometry)) continue;
      this.live = { m, visible: m.visible, culled: m.frustumCulled, count: m.geometry.drawRange.count };
      m.visible = true;
      m.frustumCulled = false;
      m.geometry.drawRange.count = 0;
      break;
    }
  }
}

/** Free the pixel data of a DataTexture / DataArrayTexture once it is on the GPU. */
export function releaseTextureAfterUpload(t: THREE.DataTexture | THREE.DataArrayTexture): void {
  t.onUpdate = () => {
    (t.image as { data: unknown }).data = null;
    t.onUpdate = null;
  };
}
