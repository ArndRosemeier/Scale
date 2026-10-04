/**
 * Service vehicles (ambulances, fire engines, the cleanup's flatbeds) driving to a spot: the traffic
 * model calls them arrived within ~16 m of a point on the road; one held up close to its spot (a
 * parked car, its route ending at the kerb) parks where it is after a couple of seconds.
 */
import type { Vehicle } from '../../sim/Traffic';

const waits = new WeakMap<Vehicle, number>();

/** True once the vehicle has arrived (or has been made to park close to its spot). */
export function parked(car: Vehicle, dt: number, near = 28): boolean {
  const T = car.task;
  if (!T) return false;
  if (T.arrived || T.hold) return true;
  // (Held up close to it, or circling round it — the street network may not run right past the spot.)
  if (Math.hypot(car.x - T.x, car.z - T.z) < near) {
    const w = (waits.get(car) ?? 0) + dt;
    waits.set(car, w);
    if ((w > 2 && car.speed < 0.3) || (w > 5 && car.speed < 3)) { T.arrived = true; car.speed = 0; return true; }
  } else waits.delete(car);
  return false;
}
