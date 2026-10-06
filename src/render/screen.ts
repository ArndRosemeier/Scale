/**
 * World point → screen, the one way every overlay that follows something in the world (health
 * tags, target brackets, speech bubbles, weak-spot rings, picking by screen distance) finds where
 * it is on screen and whether it is in front of the camera at all.
 *
 * Why not `vector.project(camera)` and a `z > 1` test: the renderer runs with a reversed depth
 * buffer where the GPU supports it (Renderer.ts), and then the camera's projection maps depth to
 * 1 (near) … 0 (far), and a point BEHIND the camera comes out with z < 0 — it passes `z > 1`,
 * with x and y mirrored, so things behind the player were drawn in front of him too. Here the
 * side of the camera comes from the view-space depth, which doesn't depend on the depth
 * convention. (tools/selftest.ts fails if `.project(` shows up anywhere else in src.)
 *
 * Markers over people (`markerOnScreen`: health tags, speech bubbles) also need the person in
 * sight: not behind a building or a hill, and on the same side of the ground as the camera (no
 * sewer crews' tags seen from the street). The game sets that test once (`setSight`).
 */
import * as THREE from 'three';

export interface ScreenPoint {
  /** Normalised device coordinates: -1 … 1 left → right, bottom → top (mirrored when behind). */
  x: number;
  y: number;
  /** Distance in front of the camera along its view axis (metres); ≤ near when behind it. */
  depth: number;
  /** In front of the camera (past its near plane). */
  front: boolean;
}

const _v = new THREE.Vector3();

export function screenPoint(): ScreenPoint {
  return { x: 0, y: 0, depth: 0, front: false };
}

/** Project a world point; `out` is filled and returned. */
export function toScreen(x: number, y: number, z: number, cam: THREE.Camera, out: ScreenPoint): ScreenPoint {
  _v.set(x, y, z).applyMatrix4(cam.matrixWorldInverse);
  out.depth = -_v.z;
  const near = (cam as THREE.PerspectiveCamera).near ?? 0;
  out.front = out.depth > Math.max(near, 1e-4);
  _v.applyMatrix4(cam.projectionMatrix);
  out.x = _v.x;
  out.y = _v.y;
  return out;
}

/** `toScreen` for a vector. */
export function vecToScreen(p: THREE.Vector3, cam: THREE.Camera, out: ScreenPoint): ScreenPoint {
  return toScreen(p.x, p.y, p.z, cam, out);
}

/** In front of the camera and inside the view, give or take `margin` (NDC; 1 = the screen edge). */
export function onScreen(s: ScreenPoint, margin = 1): boolean {
  return s.front && Math.abs(s.x) <= margin && Math.abs(s.y) <= margin;
}

/** NDC → CSS pixels in a `w` × `h` view. */
export function pxX(s: ScreenPoint, w: number): number { return (s.x * 0.5 + 0.5) * w; }
export function pxY(s: ScreenPoint, h: number): number { return (-s.y * 0.5 + 0.5) * h; }

/** Whether a point (a body, not its marker) can be seen from the camera; set by the game. */
export type Sight = (x: number, y: number, z: number, cam: THREE.Camera) => boolean;
let sight: Sight | null = null;

export function setSight(fn: Sight | null): void { sight = fn; }

/**
 * A marker over someone: the marker point (x, y, z) projected into `out`; true when it is on screen
 * (give or take `margin`) and the body at (x, bodyY, z) is in sight of the camera.
 */
export function markerOnScreen(x: number, y: number, z: number, bodyY: number, cam: THREE.Camera, out: ScreenPoint, margin = 1): boolean {
  if (!onScreen(toScreen(x, y, z, cam, out), margin)) return false;
  return !sight || sight(x, bodyY, z, cam);
}
