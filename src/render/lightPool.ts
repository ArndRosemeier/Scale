/**
 * The scene's only point lights and spot light: one small shared pool that every system borrows
 * from, frame by frame.
 *
 * Every lit shader carries the lighting maths once per light in the scene, written out light by
 * light, and the light count is part of every program. With each system keeping its own lamps (15
 * point lights, 2 spots, though rarely more than a handful lit at once) a skinned clothing shader
 * grew so large that Windows' shader compiler spent seconds on it. Now the count is fixed and
 * small: systems say which lamps they would like lit (`want`), the nearest ones to the camera get
 * a light, the rest stay dark.
 */
import * as THREE from 'three';

/** Point lights in the pool. */
export const POOL_POINTS = 6;

interface Want { x: number; y: number; z: number; color: number; intensity: number; distance: number; decay: number; rank: number }
interface SpotWant extends Want { tx: number; ty: number; tz: number; angle: number; penumbra: number }

class LightPool {
  readonly points: THREE.PointLight[] = [];
  readonly spot = new THREE.SpotLight(0xffffff, 0, 30, 0.7, 0.5, 1.5);
  private wants: Want[] = [];
  private spots: SpotWant[] = [];

  constructor() {
    for (let i = 0; i < POOL_POINTS; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.name = 'pool-light';
      this.points.push(l);
    }
    this.spot.name = 'pool-spot';
  }

  /** Puts the lights into the scene (once, before anything compiles: the count never changes). */
  attach(scene: THREE.Object3D): void {
    scene.add(...this.points, this.spot, this.spot.target);
  }

  /**
   * Ask for a point light this frame. The nearest wishes to the camera win; `bias` (metres) counts
   * a wish as that much farther (lamps that matter less) or nearer (negative).
   */
  want(x: number, y: number, z: number, color: number, intensity: number, distance: number, decay: number, bias = 0): void {
    if (intensity > 0) this.wants.push({ x, y, z, color, intensity, distance, decay, rank: bias });
  }

  /** Ask for the spot light this frame (the nearest wish gets it). */
  wantSpot(x: number, y: number, z: number, tx: number, ty: number, tz: number, color: number, intensity: number, distance: number, angle: number, penumbra: number, decay: number, bias = 0): void {
    if (intensity > 0) this.spots.push({ x, y, z, tx, ty, tz, color, intensity, distance, angle, penumbra, decay, rank: bias });
  }

  /** Hands out the lights, nearest the camera first (after every system has asked, before rendering). */
  assign(cam: THREE.Vector3): void {
    const W = this.wants;
    for (const w of W) w.rank += Math.hypot(w.x - cam.x, w.y - cam.y, w.z - cam.z);
    for (const w of this.spots) w.rank += Math.hypot(w.x - cam.x, w.y - cam.y, w.z - cam.z);
    W.sort((a, b) => a.rank - b.rank);
    this.points.forEach((l, i) => {
      const w = W[i];
      if (!w) { l.intensity = 0; return; }
      l.position.set(w.x, w.y, w.z);
      l.color.setHex(w.color);
      l.intensity = w.intensity;
      l.distance = w.distance;
      l.decay = w.decay;
    });
    const S = this.spots.sort((a, b) => a.rank - b.rank)[0], l = this.spot;
    if (!S) l.intensity = 0;
    else {
      l.position.set(S.x, S.y, S.z);
      l.target.position.set(S.tx, S.ty, S.tz);
      l.color.setHex(S.color);
      l.intensity = S.intensity; l.distance = S.distance; l.angle = S.angle; l.penumbra = S.penumbra; l.decay = S.decay;
    }
    W.length = 0;
    this.spots.length = 0;
  }
}

export const lightPool = new LightPool();
