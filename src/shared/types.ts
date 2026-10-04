/** Core shared types used by protocol, server and client. */
import type { Vec3 } from '../core/math';
export type { Vec3 };

export type EntityId = number;

export type EntityKind = 'player' | 'npc' | 'creature' | 'item' | 'projectile' | 'effect';

/** Locomotion state, drives animation on clients. */
export type MoveState =
  | 'idle' | 'walk' | 'run' | 'sprint' | 'crouch' | 'swim' | 'fly' | 'fall' | 'jump' | 'climb' | 'glide'
  | 'sit' | 'sleep' | 'dead' | 'stunned' | 'knockdown';

/** A one-shot action currently playing (attack, cast, gesture, work...). */
export interface ActionAnim {
  /** Animation id, e.g. "swing_1h", "cast_forward", "gesture_wave", "work_hammer", "eat", "roar". */
  id: string;
  /** Server time (s) the action started. */
  t0: number;
  /** Duration (s). */
  dur: number;
  /** Optional aim direction for casts/shots. */
  aim?: Vec3;
}

export interface AnimState {
  move: MoveState;
  action?: ActionAnim;
  /** Facial expression hint for humanoids (dialog, combat). */
  mood?: 'neutral' | 'happy' | 'angry' | 'sad' | 'afraid' | 'surprised' | 'disgusted' | 'focused' | 'pain';
  /** True while speaking (lip flap). */
  talking?: boolean;
  /** Look-at target position. */
  lookAt?: Vec3;
  /** Superpower body layer (the player): jump charge, leap, dash. */
  power?: PowerAnim;
}

/** Superpower poses layered over locomotion (see Animator.powerLayer). */
export interface PowerAnim {
  /** Super jump charge 0..1 while held, < 0 when not charging. */
  charge: number;
  /** Strength 0..1 of the super jump in progress (0: none); cleared on landing. */
  leap: number;
  /** Animation-clock seconds since the super jump's take-off. */
  leapT: number;
  /** 1 while dashing (fades out after). */
  dash: number;
  /** Flight (the body is pitched and banked by the player, see Player.updateRig): body tilt 0 (upright
   *  hover) .. 1 (horizontal), bank (rad, the roll into a turn), boost 0/1 while boosting. */
  fly?: { tilt: number; bank: number; boost: number };
}

/** Bitflags on snapshots. */
export const enum EntFlag {
  Hostile = 1 << 0,
  Sneaking = 1 << 1,
  InCombat = 1 << 2,
  Talkable = 1 << 3,
  Merchant = 1 << 4,
  Invisible = 1 << 5,
  Glowing = 1 << 6,
  Tamed = 1 << 7,
  Questgiver = 1 << 8,
  Burning = 1 << 9,
  Frozen = 1 << 10,
  Levitating = 1 << 11,
  Sleeping = 1 << 12,
  Swimming = 1 << 13,
  /** Boss creature (bigger, named, persistent); the client's music escalates against it. */
  Boss = 1 << 14,
}

export type FactionId = string;

/** Damage types shared by combat, abilities, items and resistances. */
export type DamageType =
  | 'slash' | 'pierce' | 'blunt' | 'fire' | 'frost' | 'shock' | 'force' | 'poison' | 'radiant' | 'shadow' | 'psychic' | 'fall';

export interface Speech {
  text: string;
  /** Server time when it disappears. */
  until: number;
  /** For bark bubbles: 'say' | 'shout' | 'whisper' | 'think'. */
  style?: 'say' | 'shout' | 'whisper' | 'think';
}

export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'storm' | 'snow' | 'fog' | 'ashfall' | 'sporefall';

export interface WeatherState {
  kind: WeatherKind;
  /** 0..1 */
  intensity: number;
  windX: number;
  windZ: number;
}
