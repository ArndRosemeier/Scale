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
 * Who is hostile comes from the faction table (factions/relations.ts): a foe is a target of a faction
 * the hero is hostile to, still in the fight (`factionOf` says which faction a target belongs to).
 *
 * No three.js: usable in headless tests.
 */
import type { Target } from './Targeting';
import type { Actor } from '../sim/actors/Actor';
import { subdued, SIDEKICK_OWNER } from '../sim/actors/Actor';
import { defaultRelations, type FactionId, type Relations } from './factions/relations';

export interface FoeWorld {
  /** A machine (robot, service bot, drone) gone rogue (ThreatDirector.isHostile). */
  hostileThing(ref: object): boolean;
  /** The faction table (Game.relations); default: the seeded one. */
  relations?: Relations;
  /** The faction of a villain group (an actor's `faction`, a FactionMap id). */
  group?(id: number): FactionId | undefined;
}

const SEEDED = defaultRelations();

/** A criminal fighting right now: hostile and not knocked out, cuffed, surrendering or gone. */
export function fightingCrook(act: Actor | null | undefined): boolean {
  return !!act && act.role === 'criminal' && act.hostile && !subdued(act);
}

/** The faction an actor belongs to (none: an ordinary civilian). */
export function actorFaction(act: Actor | null | undefined, group?: (id: number) => FactionId | undefined): FactionId {
  if (!act) return 'civilians';
  if (act.owner === SIDEKICK_OWNER && act.role === 'bystander') return 'sidekick';
  switch (act.role) {
    case 'criminal': return (act.faction !== undefined ? group?.(act.faction) : undefined) ?? 'crooks';
    case 'police': return 'police';
    case 'soldier': return 'army';
    default: return 'civilians';
  }
}

/** The faction a target belongs to. */
export function factionOf(t: Target, w: FoeWorld): FactionId {
  switch (t.kind) {
    case 'threat': return t.obj.self ? 'hero' : t.obj.faction ?? 'monsters';
    case 'person': return actorFaction(t.obj.actor, w.group);
    case 'robot': case 'bot': case 'drone': return w.hostileThing(t.obj) ? 'machines' : 'civilians';
    case 'car': case 'prop': return 'civilians';
  }
}

/** May the player hurt this target without it costing reputation (the sense's foe)? */
export function isFoe(t: Target, w: FoeWorld): boolean {
  if (t.kind === 'person' && (!t.obj.actor || subdued(t.obj.actor))) return false;
  return (w.relations ?? SEEDED).hostile('hero', factionOf(t, w));
}

/**
 * Does the friend/foe sense spare this target? Everyone and everything that is not a foe: people,
 * machines, every car and every street prop (wrecking any of them would cost reputation).
 */
export function spared(t: Target, w: FoeWorld): boolean {
  return !isFoe(t, w);
}
