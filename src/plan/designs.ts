/**
 * The designs walkable landmarks were built from (interior/design: walls, rooms with their
 * furniture, lights; local u, v), kept per landmark for the checks and for anyone asking what is
 * inside. Set when the landmark's parts are made (plan/landmarkParts).
 */
import type { Landmark } from './landmarks';
import type { Design, DRoom } from '../interior/design/types';

const designs = new WeakMap<Landmark, Design>();

export function setDesign(lm: Landmark, D: Design): void { designs.set(lm, D); }
/** A landmark's design (after its parts were made), or null. */
export function landmarkDesign(lm: Landmark): Design | null { return designs.get(lm) ?? null; }
/** Its rooms, or null. */
export function landmarkRooms(lm: Landmark): DRoom[] | null { return designs.get(lm)?.rooms ?? null; }
