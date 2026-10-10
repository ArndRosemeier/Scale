/**
 * Actor layer (PLAYGROUND_PLAN §2.3): a role and a controller on top of a pedestrian agent.
 *
 * A `PedAgent` with `actor` set is driven by its owner (a crime, the police, a small deed)
 * instead of its day plan. The owner sets a movement goal and speed, a facing point, a
 * held item and a one-shot animation each frame; `Pedestrians.step` keeps doing the
 * physics (steering with separation, ground, knock-downs). Actors are not despawned by
 * distance while `pinned`, and ordinary perception (Reactions) leaves them to their owner.
 *
 * States: Idle / Walk / Run (flee or chase, with route replanning), Fight, Cower,
 * Surrender, Stagger, KO, Arrested, plus staging poses (Point, Shout, Cheer, Film).
 *
 * Pure data and small helpers: no three.js, usable in headless tests.
 */
import type { PedAgent } from '../Pedestrians';
import type { MoveState } from '../../shared/types';
import type { EquipmentVisuals } from '../../items/types';

export type ActorRole = 'criminal' | 'victim' | 'police' | 'shopkeeper' | 'owner' | 'bystander' | 'soldier' | 'medic' | 'worker';

/** Owner id of the aftermath's actors (src/game/aftermath: medics, the injured, the trapped, cleanup crews): their own budget. */
export const AFTERMATH_OWNER = -2;
/** Owner id of the street characters (src/game/street: buskers, the doomsayer, living statues …): their own budget. */
export const STREET_OWNER = -3;
/** Owner id of the people fame brings (src/game/fame: photographers, a TV crew, fans, protesters): their own budget. */
export const FAME_OWNER = -4;
/** Owner id of the metro's commuters (src/game/metro: on the stairs, the platforms and in the trains): their own budget. */
export const METRO_OWNER = -5;
/** Owner id of game/people's actors (someone talking to you, a passer-by helping someone up, pointing, waving): their own budget. */
export const PEOPLE_OWNER = -6;
/** Owner id of game/sidekick's actors (the person taking the shard, the sidekick): their own budget. */
export const SIDEKICK_OWNER = -7;
/** Owner id of the stadium concert's people (src/game/concert: the band, the audience in the pit): their own budget. */
export const CONCERT_OWNER = -8;
/** Owner id of the stadium's soccer players and referee (src/game/soccer): their own budget. */
export const SOCCER_OWNER = -9;
export type ActorState = 'idle' | 'walk' | 'run' | 'fight' | 'cower' | 'surrender' | 'stagger' | 'down' | 'ko' | 'arrested' | 'point' | 'cheer' | 'gone';
export type Armed = 'none' | 'knife' | 'bat' | 'gun';
export type Mood = 'neutral' | 'happy' | 'angry' | 'sad' | 'afraid' | 'surprised' | 'pain' | 'focused';

export interface ActorAction {
  /** Animation id (punch, stab, gesture_point, cheer, pickup, hands_up, cower, pray …). */
  id: string;
  /** Seconds since it started. */
  age: number;
  dur: number;
}

export interface Actor {
  role: ActorRole;
  state: ActorState;
  /** Seconds in the current state. */
  stateT: number;
  hp: number;
  maxHp: number;
  /** Fighting strength relative to an average adult (1). Drives damage dealt and the con colour. */
  strength: number;
  armed: Armed;
  /** Hostile to the player (attacks / runs from them): con colour and Tab priority. */
  hostile: boolean;
  /** Movement for this frame: walk / run towards goal at speed (m/s); null = stand. */
  goal: { x: number; z: number } | null;
  speed: number;
  /** Turn to face this point while standing (and look at it). */
  face: { x: number; y: number; z: number } | null;
  /** Route being followed (x, z, flag triples, as Pedestrians.buildRoute) and the next waypoint. */
  route: Float32Array | null;
  wp: number;
  /** Seconds until the route may be replanned. */
  replanT: number;
  /** One-shot (or long held) animation. */
  action: ActorAction | null;
  /** Animation move override (crouch, knockdown, …). */
  move: MoveState | null;
  mood: Mood;
  /** Held item override: undefined = the citizen's own, null = empty hand, else an item id. */
  held?: string | null;
  /** Outfit override (police uniform). */
  outfit?: EquipmentVisuals;
  /** The villain group it belongs to (factions/Factions id); undefined: none. */
  faction?: number;
  /** Name on the target frame (street characters: "Busker"); else the role's, if any. */
  title?: string;
  /** Not despawned by distance while set. */
  pinned: boolean;
  /** One of a crowd (a concert's audience): no priority for a full rig over ordinary people. */
  crowd?: boolean;
  /** Owner id (crime / deed / police) for bookkeeping. */
  owner: number;
  /** Knocked down (not out): seconds until they get up again. */
  upT: number;
  /** Seconds of stagger left (slow, can't attack). */
  staggerT: number;
  /** Attack cooldown (s). */
  attackT: number;
  /** The player hit this actor at least once (rewards, wanted ledger). */
  hitByPlayer: boolean;
  /** Last damage source was the player. */
  koByPlayer: boolean;
  /**
   * Seconds this actor has wanted to move (a goal farther than STUCK.near, a speed) without getting
   * anywhere (kept by Pedestrians.step through `watchProgress`): owners re-plan or give up on it.
   */
  stuckT: number;
  /** Free slot for the owner's FSM. */
  memo: Record<string, number>;
}

export function makeActor(role: ActorRole, owner: number, o: Partial<Actor> = {}): Actor {
  return {
    role, state: 'idle', stateT: 0, hp: 40, maxHp: 40, strength: 1, armed: 'none', hostile: false,
    goal: null, speed: 0, face: null, route: null, wp: 0, replanT: 0, action: null, move: null, mood: 'neutral',
    pinned: true, owner, upT: 0, staggerT: 0, attackT: 0, hitByPlayer: false, koByPlayer: false, stuckT: 0, memo: {},
    ...o,
  };
}

/** Attach an actor to an agent (a converted walker or a spawned citizen). */
export function attach(a: PedAgent, act: Actor): Actor {
  a.actor = act;
  return act;
}

/**
 * Hand an agent back to the ordinary population: it rebuilds a route to where it was going
 * (via the Flee → Walk transition in Pedestrians) and may despawn by distance again.
 */
export function release(a: PedAgent): void {
  if (!a.actor) return;
  a.actor = undefined;
  if (a.state !== 5 /* Down */) { a.state = 4 /* Flee */; a.fear = 0; a.fearX = a.x; a.fearZ = a.z; a.stateT = 0; }
}

export function setState(act: Actor, s: ActorState): void {
  if (act.state === s) return;
  act.state = s;
  act.stateT = 0;
}

export function play(act: Actor, id: string, dur: number): void {
  act.action = { id, age: 0, dur };
}

/**
 * Keep a looping action (aiming) going without restarting it: started once, then its end is kept
 * `dur` s ahead (the animator blends a loop in over a tenth of the duration it first sees, so a
 * short one; restarting it every few seconds made the arms dip).
 */
export function hold(act: Actor, id: string, dur = 1.4): void {
  if (act.action?.id !== id) act.action = { id, age: 0, dur };
  else act.action.dur = act.action.age + dur;
}

/** Is the actor out of the fight (KO, arrested, gone)? */
export function subdued(act: Actor): boolean {
  return act.state === 'ko' || act.state === 'arrested' || act.state === 'surrender' || act.state === 'gone';
}

/** Per-frame timers (called by the owner system once per frame for each actor). */
export function tickActor(act: Actor, dt: number): void {
  act.stateT += dt;
  act.replanT -= dt;
  act.attackT -= dt;
  if (act.staggerT > 0) act.staggerT = Math.max(0, act.staggerT - dt);
  if (act.memo.stagCd > 0) act.memo.stagCd -= dt;
  if (act.action) { act.action.age += dt; if (act.action.age > act.action.dur) act.action = null; }
}

/**
 * Follow `act.route`: aim at the next waypoint, advancing within 1.2 m. Returns false when
 * the route is used up (or missing).
 */
export function followRoute(a: PedAgent, act: Actor, speed: number): boolean {
  const R = act.route;
  if (!R) return false;
  const n = R.length / 3;
  while (act.wp < n) {
    const tx = R[act.wp * 3], tz = R[act.wp * 3 + 1];
    if (Math.hypot(tx - a.x, tz - a.z) > 1.2) {
      act.goal = { x: tx, z: tz };
      act.speed = speed;
      a.onRoad = R[act.wp * 3 + 2] > 0.5;
      return true;
    }
    act.wp++;
  }
  act.goal = null;
  act.speed = 0;
  return false;
}

/** Straight-line goal (short range: chases, closing in). */
export function goTo(act: Actor, x: number, z: number, speed: number): void {
  act.goal = { x, z };
  act.speed = speed;
  act.route = null;
}

export function stand(act: Actor): void {
  act.goal = null;
  act.speed = 0;
}

export function lookAt(act: Actor, x: number, y: number, z: number): void {
  act.face = { x, y, z };
}

/**
 * No-progress watch (running in place: a goal that flips back and forth, a crowd or the player in
 * the way, a target that cannot be reached): moving less than `move` m within `window` s while
 * wanting to go somewhere more than `near` m away counts as stuck.
 */
export const STUCK = { window: 2.5, move: 0.9, near: 1.6, minSpeed: 0.8 };

/**
 * Called once a step for an actor (Pedestrians.step): advances `act.stuckT` while it wants to move
 * and does not get anywhere, resets it as soon as it has covered `STUCK.move` m. Returns stuckT.
 * (Anchor kept in the memo: pgX, pgZ, pgT.)
 */
export function watchProgress(a: { x: number; z: number }, act: Actor, dt: number): number {
  const m = act.memo;
  const g = act.goal;
  const wants = !!g && act.speed > STUCK.minSpeed && (g.x - a.x) * (g.x - a.x) + (g.z - a.z) * (g.z - a.z) > STUCK.near * STUCK.near;
  if (!wants || m.pgT === undefined || (a.x - m.pgX) * (a.x - m.pgX) + (a.z - m.pgZ) * (a.z - m.pgZ) > STUCK.move * STUCK.move) {
    m.pgX = a.x; m.pgZ = a.z; m.pgT = 0;
    if (!wants || act.stuckT > 0) act.stuckT = 0;
    return act.stuckT;
  }
  m.pgT += dt;
  act.stuckT = m.pgT > STUCK.window ? m.pgT - STUCK.window + 1e-3 : 0;
  return act.stuckT;
}

/** Start the no-progress watch afresh (a new goal / plan). */
export function resetProgress(act: Actor): void {
  act.stuckT = 0;
  act.memo.pgT = 0;
}

/**
 * Pursuit bookkeeping for owners (police after a target): seconds of being stuck while going for
 * it, give-ups. `pursue` returns 'go' (keep at it), 'replan' (stuck once: plan a new way / spot) or
 * 'give_up' (stuck again after a re-plan, or at it for longer than `maxT`: treat as unreachable).
 */
export function pursue(act: Actor, dt: number, maxT = Infinity): 'go' | 'replan' | 'give_up' {
  const m = act.memo;
  m.puT = (m.puT ?? 0) + dt;
  if (m.puT > maxT) { endPursuit(act); return 'give_up'; }
  if (act.stuckT <= 0) return 'go';
  if (!m.puRe) { m.puRe = 1; resetProgress(act); return 'replan'; }
  endPursuit(act);
  return 'give_up';
}

/** Pursuit over (reached, switched target, gave up). */
export function endPursuit(act: Actor): void {
  act.memo.puT = 0; act.memo.puRe = 0;
  resetProgress(act);
}
