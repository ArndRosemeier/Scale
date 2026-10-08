/**
 * What each power does to opponents, per rank, for the help's power table: health a person
 * loses and points a giant creature takes (before its armour). Computed from the numbers the
 * game itself uses (tuning.ts POWER_HIT and the rank tables, Combat's COMBAT, the threats'
 * DAMAGE_PER_IMPULSE), for a hero of normal size (1.8 m).
 */
import {
  PUNCH_IMPULSE, SHOCK_IMPULSE, LASER_DOSE, FIRE_RANGE, FIRE_HEAT, FIREBALL_BLAST, NOVA_FREEZE,
  BOLT_JUMPS, BOLT_STUN, QUAKE_IMPULSE, GUST_LIFT, HYDRO_FORCE, SHRINK_CAP, SHRINK_DEALT, SLIME_COUNT, SLIME_HOLD,
  POWER_HIT as H,
} from './tuning';
import type { AbilityId } from './defs';
import { COMBAT } from '../Combat';
import { DAMAGE_PER_IMPULSE } from '../threats/ThreatEvent';

export interface PowerDamage {
  /** Health a person loses (or what happens to them). */
  people: string;
  /** Points a giant creature takes, before armour. */
  creatures: string;
}

/** A typical walking pace (Pedestrians: 1.25–1.6 m/s) for the ice path's slips. */
const WALK = 1.4;

const n = (v: number) => (v >= 10000 ? `${Math.round(v / 1000)}k` : v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
/** Health a knock-down at fling speed `power` costs (Combat.knocked). */
const fall = (power: number) => COMBAT.knockBase + COMBAT.knockPerSpeed * power;
/** Health an impulse of J N·s costs (Combat.hitActor, a standing, unshielded adult). */
const blow = (J: number) => J * COMBAT.dmgPerNs;
const creature = (J: number) => J * DAMAGE_PER_IMPULSE;
const punchJ = (r: number) => PUNCH_IMPULSE[r] * Math.hypot(1, H.punchLift);

/** A power's damage at rank r (1-based; the punch row is rank 0 of super strength). null: no table row. */
export function powerDamage(id: AbilityId, r: number): PowerDamage | null {
  switch (id) {
    case 'punch': return { people: `${n(blow(punchJ(0)))} per punch`, creatures: `${n(creature(punchJ(0)))} per punch` };
    case 'strength': return { people: `${n(blow(punchJ(r)))} per punch`, creatures: `${n(creature(punchJ(r)))} per punch` };
    case 'shockwave': {
      const J = SHOCK_IMPULSE[r] * H.blastShare;
      return { people: `${n(blow(J))} to everyone in the blast`, creatures: `${n(creature(J))}` };
    }
    case 'speed': {
      const p = Math.min(H.dashKnockMax, H.dashKnock + H.dashKnockPerRank * r);
      return { people: `dash: ${n(fall(p))} · running past: none (they stumble)`, creatures: 'none' };
    }
    case 'laser': return { people: `${n(fall(H.laserKnock))} each time they fall`, creatures: `${n(creature(LASER_DOSE[r]))} / s` };
    case 'fireWave': return {
      people: `${n(fall(H.fireKnock))} within ${n(FIRE_RANGE[r] * H.fireKnockReach)} m; farther: they burn and run`,
      creatures: `${n(creature(FIRE_HEAT[r]) * H.fireCreatureMul)}`,
    };
    case 'fireball': return {
      people: `${n(fall(H.fireballKnock))} at the rim … ${n(fall(H.fireballKnock + H.fireballKnockCentre))} at the centre`,
      creatures: `${n(creature(FIREBALL_BLAST[r]) * H.fireballCreatureMul)}`,
    };
    case 'frostNova': return { people: 'none: frozen solid (the next blow breaks the ice)', creatures: `${n(NOVA_FREEZE[r] * H.frostCreature)} at a leg` };
    case 'icePath': return { people: `${n(fall(H.iceSlipKnock + WALK * H.iceSlipPerSpeed))} when someone walking slips, more at a run`, creatures: 'none' };
    case 'lightning': return { people: `${n(fall(H.boltKnock))} each; the bolt strikes up to ${1 + BOLT_JUMPS[r]} targets`, creatures: `${n(BOLT_STUN[r] * H.boltCreature)}` };
    case 'stomp': {
      const J = QUAKE_IMPULSE[r];
      return { people: `${n(fall(Math.min(H.quakeKnockMax, H.quakeKnock + J * H.quakeKnockPerNs)))}`, creatures: `${n(creature(J) * H.quakeCreatureMul)} at the legs` };
    }
    case 'gust': return { people: `up to ${n(fall(H.gustKnock * GUST_LIFT[r]))}, again every ${H.gustEveryPerson} s inside`, creatures: `up to ${n(H.gustCreature * GUST_LIFT[r])}, again every ${H.gustEvery} s` };
    case 'hydro': {
      const tick = HYDRO_FORCE[r] * H.hydroTick;
      const acc = Math.floor(H.hydroKnockAt / tick + 1) * tick;
      const p = Math.min(H.hydroKnockMax, H.hydroKnock + acc * H.hydroKnockPerNs);
      return { people: `${n(fall(p))} when they fall (after ${n(acc / HYDRO_FORCE[r])} s)`, creatures: `${n(creature(HYDRO_FORCE[r]) * H.hydroCreatureMul)} / s` };
    }
    case 'shrink': return {
      people: `none; while shrunk they deal ${n(SHRINK_DEALT[r] * 100)} % damage`,
      creatures: `none; up to ${SHRINK_CAP[r]} m smaller, dealing ${n(SHRINK_DEALT[r] * 100)} % damage`,
    };
    case 'slimeCall': return { people: `none: held down for ${SLIME_HOLD[r]} s`, creatures: `${H.lumenCreature} / s per Lumen on it (up to ${n(H.lumenCreature * SLIME_COUNT[r])} / s)` };
    case 'superJump': case 'size': return { people: 'none at normal size; as a giant, your landings and steps knock over people at your feet', creatures: 'none at normal size; a giant\'s feet hurt them' };
    case 'flight': return { people: 'none', creatures: 'none' };
    default: return null;
  }
}
