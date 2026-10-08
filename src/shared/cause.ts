import type { Cause } from '../game/Stimuli';
import type { DownCause } from '../sim/Pedestrians';
import type { DamageCause } from '../destruction/Destruction';

/** Who a knock-down is booked to, from a stimulus's or blow's cause (none given: the player).
 * The one place the two vocabularies meet: police and army stomps stay theirs, never the hero's. */
export function downCauseOf(c: Cause | undefined): DownCause {
  return c === undefined ? 'player' : c === 'world' ? 'other' : c;
}

/** Who the ledger books a broken building to: a fire spreading on its own counts as the threat's. */
export function harmCauseOf(c: DamageCause): Cause {
  return c === 'fire' ? 'threat' : c;
}
