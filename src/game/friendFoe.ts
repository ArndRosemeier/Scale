/**
 * Friend or foe: who the player's friend/foe sense spares (a per-power upgrade, Progress.hasSense).
 *
 * Arnd's rule (2026-10-08): a power with the sense harms nothing that would cost the player
 * reputation. So a foe is only what Justice lets the hero hit for free: a criminal who has not given
 * up or been cuffed, a monster or one of the Murk (every Target of kind `threat`), a machine gone
 * rogue. Everyone and everything else is spared: bystanders, the sidekick, police and soldiers
 * (always an offence), ordinary machines, every car and street prop; the powers themselves also
 * leave walls, windows and signs alone (Elements.wrecks).
 *
 * No three.js: usable in headless tests.
 */
import type { Target } from './Targeting';
import type { Actor } from '../sim/actors/Actor';
import { subdued } from '../sim/actors/Actor';

export interface FoeWorld {
  /** A machine (robot, service bot, drone) gone rogue (ThreatDirector.isHostile). */
  hostileThing(ref: object): boolean;
}

/** A criminal fighting right now: hostile and not knocked out, cuffed, surrendering or gone. */
export function fightingCrook(act: Actor | null | undefined): boolean {
  return !!act && act.role === 'criminal' && act.hostile && !subdued(act);
}

/** May the player hurt this target without it costing reputation (the sense's foe)? */
export function isFoe(t: Target, w: FoeWorld): boolean {
  switch (t.kind) {
    case 'threat': return !t.obj.self;
    case 'person': {
      const act = t.obj.actor;
      return !!act && act.role === 'criminal' && !subdued(act);
    }
    case 'robot': case 'bot': case 'drone': return w.hostileThing(t.obj);
    case 'car': case 'prop': return false;
  }
}

/**
 * Does the friend/foe sense spare this target? Everyone and everything that is not a foe: people,
 * machines, every car and every street prop (wrecking any of them would cost reputation).
 */
export function spared(t: Target, w: FoeWorld): boolean {
  return !isFoe(t, w);
}
