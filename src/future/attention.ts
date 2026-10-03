/**
 * How pedestrians notice the near-future layer (cheap: only on events, one neighbour query):
 * glances at a drone passing low or lowering a parcel, a small crowd that stops to gawk at (or
 * film) a knocked-over robot or a drone falling out of the sky.
 */
import { PState, GAWK_CROWD, canGawk, gawkersNear, type Pedestrians, type PedAgent } from '../sim/Pedestrians';
import { hash32 } from '../core/rng';

const nb: PedAgent[] = [];

/** Free to look: out on the street, walking or standing, not frightened. */
function free(a: PedAgent): boolean {
  return !a.inside && a.fear < 0.3 && (a.state === PState.Walk || a.state === PState.Wait || a.state === PState.Idle);
}

/**
 * Something passes by (a low drone): a share of the people within r glance at it for a
 * moment while they walk on; those already glancing follow it.
 */
export function glanceAt(peds: Pedestrians, x: number, y: number, z: number, r: number, share: number, salt: number): void {
  for (const a of peds.neighbours(x, z, r, nb)) {
    if (!free(a)) continue;
    if ((a.glance ?? 0) > 0) { a.lookX = x; a.lookY = y; a.lookZ = z; continue; }
    const h = hash32(a.id * 2654435761 + salt);
    if ((h % 1000) / 1000 > share) continue;
    a.glance = 1.2 + ((h >>> 10) % 100) / 50;
    a.lookX = x; a.lookY = y; a.lookZ = z;
  }
}

/**
 * Something happened (a robot knocked over, a drone crashing): the curious stop and gawk, the
 * most curious film it, others just look as they pass. `pull` scales how many stop (0..1).
 */
export function gawkAt(peds: Pedestrians, x: number, y: number, z: number, r: number, pull: number): number {
  let n = 0;
  // At most GAWK_CROWD standing around it (those already looking count); the rest glance.
  let room = GAWK_CROWD - gawkersNear(peds, x, z, r, nb);
  for (const a of peds.neighbours(x, z, r, nb)) {
    if (!free(a)) continue;
    const d = Math.hypot(a.x - x, a.z - z);
    if (d > r) continue;
    const c = a.cit.curiosity * pull * (1.15 - (d / r) * 0.5);
    a.lookX = x; a.lookY = y; a.lookZ = z;
    if (c > 0.42 && room > 0 && canGawk(a)) { a.state = c > 0.62 ? PState.Film : PState.Gawk; a.stateT = 0; n++; room--; }
    else a.glance = 1.5 + a.cit.curiosity * 2;
  }
  return n;
}
