/**
 * The sight test for markers over people (render/screen.ts `setSight`): someone is seen from the
 * camera when both are on the same side of the ground (street or underground: no tags of a sewer
 * crew through the pavement, none of the street from a sewer) and, out in the open, no building,
 * landmark or hill stands between them. From inside a building, or underground, only the first
 * test (the building prisms and the tunnels are not what blocks the view in there).
 *
 * The sides come from the game's own underground test (the sewers and stations), not from the
 * depth under the street: a shallow sewer runs less than a metre under it.
 */
import type * as THREE from 'three';
import type { WorldIndex } from '../world/WorldIndex';
import type { Sight } from '../render/screen';

/** `viewerUnder`: the camera is down there (the camera rig's own flag). `feetUnder`: someone standing there is underground. */
export function makeSight(world: WorldIndex, viewerUnder: () => boolean, feetUnder: (x: number, feet: number, z: number) => boolean): Sight {
  return (x: number, feet: number, z: number, cam: THREE.Camera): boolean => {
    const camUnder = viewerUnder();
    if (camUnder !== feetUnder(x, feet, z)) return false;
    if (camUnder) return true;
    const c = cam.position;
    const b = world.buildingAt(c.x, c.z);
    if (b && c.y < b.top && c.y > b.low) return true;
    const y = feet + 1.2;
    const dx = x - c.x, dy = y - c.y, dz = z - c.z, d = Math.hypot(dx, dy, dz);
    if (d < 2) return true;
    const hit = world.raycast(c.x, c.y, c.z, dx / d, dy / d, dz / d, d - 1, Math.max(0.5, d / 40));
    return hit.t >= d - 1.5;
  };
}
