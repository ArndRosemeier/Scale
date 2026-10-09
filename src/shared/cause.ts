import type { Cause } from '../game/Stimuli';
import type { DownCause } from '../sim/Pedestrians';
import type { DamageCause } from '../destruction/Destruction';

/** Who a knock-down is booked to, from a stimulus's or blow's cause (none given: the player).
 * The one place the two vocabularies meet: police and army stomps stay theirs, never the hero's. */
export function downCauseOf(c: Cause | undefined): DownCause {
  return c === undefined ? 'player' : c === 'world' ? 'other' : c;
}

/** Tallest hero (m) whose bumps into people are only a stumble ('brush': a stern word, no reputation). */
export const BRUSH_MAX_H = 3;
/** A footfall or a landing crushes cars only from a body taller than this (m): a giant's foot, never
 *  a hero of about human size coming down from a super jump onto a car. */
export const CAR_CRUSH_H = 6;

/** Who is booked for a stomp's knock-down: a hero of about human size landing on someone (a super
 * jump coming down beside them) only makes them stumble, like a super speed runner brushing past. */
export function stompDownCause(c: Cause | undefined, size: number): DownCause {
  const d = downCauseOf(c);
  return d === 'player' && size < BRUSH_MAX_H ? 'brush' : d;
}

/** Who the ledger books a broken building to: a fire spreading on its own counts as the threat's. */
export function harmCauseOf(c: DamageCause): Cause {
  return c === 'fire' ? 'threat' : c;
}
