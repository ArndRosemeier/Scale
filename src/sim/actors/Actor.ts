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

export type ActorRole = 'criminal' | 'victim' | 'police' | 'shopkeeper' | 'owner' | 'bystander';
export type ActorState = 'idle' | 'walk' | 'run' | 'fight' | 'cower' | 'surrender' | 'stagger' | 'down' | 'ko' | 'arrested' | 'point' | 'cheer' | 'gone';
export type Armed = 'none' | 'knife' | 'bat';
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
  /** Not despawned by distance while set. */
  pinned: boolean;
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
  /** Free slot for the owner's FSM. */
  memo: Record<string, number>;
}

export function makeActor(role: ActorRole, owner: number, o: Partial<Actor> = {}): Actor {
  return {
    role, state: 'idle', stateT: 0, hp: 40, maxHp: 40, strength: 1, armed: 'none', hostile: false,
    goal: null, speed: 0, face: null, route: null, wp: 0, replanT: 0, action: null, move: null, mood: 'neutral',
    pinned: true, owner, upT: 0, staggerT: 0, attackT: 0, hitByPlayer: false, koByPlayer: false, memo: {},
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
