/**
 * The sight test for markers over people (render/screen.ts `setSight`): a body is seen from the
 * camera when both are on the same side of the ground (street or underground: no tags of a sewer
 * crew through the pavement, none of the street from a sewer) and, out in the open, no building,
 * landmark or hill stands between them. From inside a building, or underground, only the first
 * test (the building prisms and the tunnels are not what blocks the view in there).
 */
import type * as THREE from 'three';
import type { WorldIndex } from '../world/WorldIndex';
import type { Sight } from '../render/screen';

/** Below the ground there by more than this: underground. */
const UNDER = 1.0;

export function makeSight(world: WorldIndex): Sight {
  const T = world.terrain;
  return (x: number, y: number, z: number, cam: THREE.Camera): boolean => {
    const c = cam.position;
    const camUnder = c.y < T.height(c.x, c.z) - UNDER, under = y < T.height(x, z) - UNDER;
    if (camUnder !== under) return false;
    if (camUnder) return true;
    const b = world.buildingAt(c.x, c.z);
    if (b && c.y < b.top && c.y > b.low) return true;
    const dx = x - c.x, dy = y - c.y, dz = z - c.z, d = Math.hypot(dx, dy, dz);
    if (d < 2) return true;
    const hit = world.raycast(c.x, c.y, c.z, dx / d, dy / d, dz / d, d - 1, Math.max(0.5, d / 40));
    return hit.t >= d - 1.5;
  };
}
