/**
 * Static parts drawn as WebGPU render bundles: three records the draws of a BundleGroup's children once (per
 * camera: the view's and each shadow camera's) and replays them, which takes a fraction of the main-thread time
 * of drawing them one by one (packages/stage/test/bench: 4000 objects, 12.6 ms to 1.5 ms on WebGPU). On three's
 * WebGL 2 backend a BundleGroup is an ordinary group: same picture, no gain.
 *
 * What a recording holds is fixed until it is recorded again: which children are visible, and which were in the
 * camera's frustum when it was recorded. So children are drawn without per-object frustum culling (the GPU drops
 * what is off screen), and `recordIfChanged` (or `changed`) records again when a child was added, removed, shown or
 * hidden. A moved child is fine (three refreshes its matrix on replay), but best for parts that rarely change.
 */
import { BundleGroup, type Object3D } from 'three/webgpu';

export class StaticBundle extends BundleGroup {
  /**
   * How many shader and pipeline builds have finished (the Stage sets it to its monitor's count). A draw whose shader
   * or pipeline was not ready while recording is left out of the recording (three skips it), so a finished build
   * records every bundle again once.
   */
  static builds: () => number = () => 0;
  /** Read by the Stage's renderer hooks (patches.ts `fixedBundleUniforms`). */
  readonly isStaticBundle = true;
  private sig = '';

  constructor(name?: string) {
    super();
    if (name) this.name = name;
  }

  /** Records again on the next frame (a child moved or changed its geometry or material). */
  changed(): void {
    this.needsUpdate = true;
  }

  /**
   * Once a frame before drawing: records again if the visible children differ from the last recording (or a shader
   * finished building since: `builds`), and turns
   * per-object culling off on new ones. Cheap next to drawing them (a walk over the children, no allocation per
   * unchanged child beyond the signature string).
   */
  recordIfChanged(): boolean {
    let n = 0, h = 0;
    const stack: Object3D[] = [this];
    for (let o = stack.pop(); o; o = stack.pop()) {
      for (const c of o.children) {
        if (!c.visible) continue;
        if (c.frustumCulled) c.frustumCulled = false;
        n++;
        h = (Math.imul(h, 31) + c.id) | 0;
        stack.push(c);
      }
    }
    const sig = `${n}:${h}:${StaticBundle.builds()}`;
    if (sig === this.sig) return false;
    this.sig = sig;
    this.needsUpdate = true;
    return true;
  }
}
