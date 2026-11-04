// @ts-nocheck -- three's TSL typings infer vector widths poorly; the class itself is checked by test/origin.test.ts.
/**
 * A floating origin: the scene is drawn relative to a point near the camera, so float32 stays exact however
 * far from zero the world goes. The game keeps world coordinates everywhere (object positions, its camera,
 * its simulation); only what the GPU sees is shifted:
 *
 *  - the scene's root stands at minus the origin, so every object's matrixWorld is relative to it, and
 *  - the renderer draws with a copy of the game's camera placed relative to it (`view`).
 *
 * The origin moves in steps of `grain` metres (y stays 0), once the camera strays `reach` from it. A step changes
 * one uniform and the root's position: no shader is built again, and nothing on screen moves.
 *
 * Shaders: positionWorld and cameraPosition are then relative. Differences of the two (view rays, distances)
 * stay as they are; a pattern, noise or mask read at a world point takes `worldPosition(origin)` instead (the
 * same float32 value as before, so nothing shifts at a step). Geometry placed on the GPU (no matrix of its own)
 * is `pin`ned, so its matrixWorld is the identity, and writes origin-relative positions.
 */
import { Vector3, type Camera, type Object3D } from 'three/webgpu';
import { cameraPosition, positionWorld, renderGroup, uniform } from 'three/tsl';

export interface OriginOptions {
  /** The origin is a multiple of this (m). Default 1024. */
  grain?: number;
  /** The origin moves once the camera is farther than this from it, on either axis (m). Default `grain`. */
  reach?: number;
}

export class FloatingOrigin {
  /** The origin (world, m; y is always 0). Read it, never write it: `moveTo`. */
  readonly at = new Vector3();
  /** The origin as a shader uniform (its value is `at`), shared by every material (the render group, not each object's). */
  readonly node = uniform(this.at).setGroup(renderGroup);
  readonly grain: number;
  readonly reach: number;
  /** How many times it has moved (a game can tell a step from its last frame). */
  steps = 0;
  private scene: Object3D | null = null;
  private readonly pinned = new Set<Object3D>();
  private readonly moved: ((dx: number, dz: number) => void)[] = [];

  constructor(opts: OriginOptions = {}) {
    this.grain = opts.grain ?? 1024;
    this.reach = opts.reach ?? this.grain;
    if (!(this.grain > 0) || !(this.reach >= this.grain / 2)) throw new Error('FloatingOrigin: grain > 0 and reach >= grain / 2');
  }

  /** The scene whose root follows the origin (its position is set to minus the origin from now on). */
  attach(scene: Object3D): void {
    this.scene = scene;
    this.place();
  }

  /** Keeps `o` (a direct child of the scene, placed on the GPU) at the identity: its position follows the origin. */
  pin(o: Object3D): void {
    this.pinned.add(o);
    o.position.copy(this.at);
    o.updateMatrix();
  }

  unpin(o: Object3D): void { this.pinned.delete(o); }

  /** Called after every step with how far the origin moved (to drop cached origin-relative data). */
  onMove(f: (dx: number, dz: number) => void): void { this.moved.push(f); }

  /** The grain point nearest (x, z). */
  snap(x: number, z: number): [number, number] {
    const g = this.grain;
    // `+ 0` turns -0 into 0 (a -0 origin would compare equal but print oddly).
    return [Math.round(x / g) * g + 0, Math.round(z / g) * g + 0];
  }

  /** Moves the origin once (x, z) is more than `reach` from it; true if it moved. */
  follow(x: number, z: number): boolean {
    if (Math.abs(x - this.at.x) <= this.reach && Math.abs(z - this.at.z) <= this.reach) return false;
    const [ox, oz] = this.snap(x, z);
    return this.moveTo(ox, oz);
  }

  /** Puts the origin at the grain point nearest (x, z) (at the start, or after a jump); true if it moved. */
  moveTo(x: number, z: number): boolean {
    const [ox, oz] = this.snap(x, z);
    const dx = ox - this.at.x, dz = oz - this.at.z;
    if (dx === 0 && dz === 0) return false;
    this.at.set(ox, 0, oz);
    this.steps++;
    this.place();
    for (const f of this.moved) f(dx, dz);
    return true;
  }

  /** World to origin-relative (in place). */
  toRender<T extends { x: number; y: number; z: number }>(v: T): T { v.x -= this.at.x; v.z -= this.at.z; return v; }

  /** Origin-relative (a matrixWorld's position, say) to world (in place). */
  toWorld<T extends { x: number; y: number; z: number }>(v: T): T { v.x += this.at.x; v.z += this.at.z; return v; }

  /**
   * `out` becomes `camera` (a camera in world space, without a parent) as drawn: the same lens and turn, placed
   * relative to the origin. Call once a frame, after the game has moved its camera.
   */
  view<C extends Camera>(camera: C, out: C): C {
    // The renderer sets up the camera it draws (reversed depth, its coordinate system) and builds its projection
    // for that; the game's camera is never drawn, so it takes the same set-up here, or the copy would bring back
    // a projection for the wrong depth (WebGL 2 drew the land through itself).
    const c = camera as unknown as { _reversedDepth: boolean; coordinateSystem: number; updateProjectionMatrix?: () => void };
    const d = out as unknown as { _reversedDepth: boolean; coordinateSystem: number };
    if (c._reversedDepth !== d._reversedDepth || c.coordinateSystem !== d.coordinateSystem) {
      c._reversedDepth = d._reversedDepth;
      c.coordinateSystem = d.coordinateSystem;
      c.updateProjectionMatrix?.();
    }
    camera.updateMatrixWorld();
    out.copy(camera, false);
    out.position.x -= this.at.x;
    out.position.z -= this.at.z;
    out.updateMatrixWorld(true);
    return out;
  }

  private place(): void {
    if (this.scene) {
      this.scene.position.set(-this.at.x, 0, -this.at.z);
      this.scene.updateMatrixWorld();
    }
    for (const o of this.pinned) { o.position.copy(this.at); o.updateMatrix(); }
  }
}

/** Where the fragment (or vertex) is in the world: positionWorld plus the origin, for patterns, noise and masks. */
export function worldPosition(origin: FloatingOrigin) {
  return positionWorld.add(origin.node);
}

/** Where the camera is in the world, for patterns that follow it (clouds overhead). */
export function worldCamera(origin: FloatingOrigin) {
  return cameraPosition.add(origin.node);
}
