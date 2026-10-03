/**
 * Where powers go when nothing is targeted: through the mouse cursor (it is always visible),
 * or the screen centre while looking around / with the cursor off the view.
 */
import * as THREE from 'three';

let cursor: () => { x: number; y: number } | null = () => null;
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();

/** Game wires the cursor source (Input.cursorNdc). */
export function setAimCursor(fn: () => { x: number; y: number } | null): void { cursor = fn; }

/** Unit direction of the aim ray from the camera. */
export function aimDir(cam: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
  const c = cursor();
  if (!c) return cam.getWorldDirection(out);
  _ray.setFromCamera(_ndc.set(c.x, c.y), cam);
  return out.copy(_ray.ray.direction);
}
