/**
 * Malfunctioning machines (THREATS_PLAN §1 #11, Phase A "Robot malfunction"): the state a delivery
 * or cleaning robot, a humanoid service robot or a drone carries while it glitches (an omen of
 * what is coming) or has turned hostile, and the controller the threat layer plugs in. The
 * machine classes stay as they are: they hand a malfunctioning unit's step to the controller,
 * report knocks on it, keep it loaded farther out and draw its status lights in the mode's
 * colours (furniture shader LED modes 3 hostile red, 4 glitching flicker, 2 dark).
 */
import type { Robot } from './Robots';
import type { ServiceBot } from './ServiceBots';
import type { Drone } from './Drones';
import type { PlayerProbe } from './ctx';

/** glitch: an omen (stops, spins, flickers, then carries on); hostile: attacks; off: shut down. */
export type MalMode = 'glitch' | 'hostile' | 'off';

export interface Malfunction {
  mode: MalMode;
  /** Seconds in the current mode. */
  t: number;
  /** While hostile: impulse (N·s) it can still take before it breaks. */
  hp: number;
  maxHp: number;
  /** Attack swing 0..1 (service robots' arms), set by the controller. */
  swing: number;
}

export type MalKind = 'robot' | 'bot' | 'drone';

export interface MalfunctionCtl {
  /** A malfunctioning delivery / cleaning robot's step: true when the controller moved it. */
  robot(r: Robot, dt: number, player: PlayerProbe): boolean;
  /** A malfunctioning service robot's step: true when the controller moved it. */
  bot(b: ServiceBot, dt: number, player: PlayerProbe): boolean;
  /**
   * A malfunctioning drone in flight: the controller sets its plan (or moves it itself and
   * returns true); false lets the ordinary flight model fly the plan.
   */
  drone(d: Drone, dt: number, player: PlayerProbe): boolean;
  /** A knock (impulse N·s) on a malfunctioning machine, before it topples / breaks. */
  hit(kind: MalKind, unit: Robot | ServiceBot | Drone, J: number): void;
}

/** Status light mode (furniture shader iState.w) for a malfunction. */
export function malLed(m: Malfunction): number {
  return m.mode === 'hostile' ? 3 : m.mode === 'glitch' ? 4 : 2;
}

/** Paint (iColor, sRGB) of a rogue machine's livery parts: lid stripe, shoulder caps, drone shell. */
export const ROGUE_RED: [number, number, number] = [0.78, 0.05, 0.04];

/** Malfunctioning machines stay loaded this far from the player (m). */
export const MAL_KEEP_R = 720;
