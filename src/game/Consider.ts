/**
 * Consideration ("con", PLAYGROUND_PLAN §0 decision 13): how dangerous a target is for the player
 * right now, EverQuest / City of Heroes style. The target's fighting strength (role, weapon,
 * friends nearby, health; later its powers) against the player's (super strength, size, health,
 * combat powers) gives a ratio, and the ratio a colour:
 *
 *   trivial grey · easy green · even yellow · tough orange · dangerous red · deadly purple
 *
 * Pure functions (headless-testable).
 */
import type { PedAgent } from '../sim/Pedestrians';
import { Role } from '../sim/Population';

export type ConLevel = 'trivial' | 'easy' | 'even' | 'tough' | 'dangerous' | 'deadly';

export const CON_COLOR: Record<ConLevel, string> = {
  trivial: '#9aa3ad',
  easy: '#5fc46b',
  even: '#f2d14b',
  tough: '#f29a3b',
  dangerous: '#e8483b',
  deadly: '#b562ff',
};

/** Ratio thresholds (target / player) between the levels. */
const STEPS: [number, ConLevel][] = [[0.35, 'trivial'], [0.75, 'easy'], [1.3, 'even'], [2.0, 'tough'], [3.4, 'dangerous'], [Infinity, 'deadly']];

export function conLevel(ratio: number): ConLevel {
  for (const [r, l] of STEPS) if (ratio < r) return l;
  return 'deadly';
}

/** Fighting strength of a person (1 = an average adult who can fight a bit). */
export function personStrength(a: PedAgent, friends = 0): number {
  const act = a.actor;
  const r = a.cit.role;
  let s = act ? act.strength : r === Role.Child ? 0.25 : r === Role.Senior ? 0.45 : 0.6;
  if (act) {
    if (act.armed === 'knife') s += 0.8;
    else if (act.armed === 'bat') s += 0.6;
    // Hurt people are less of a threat; the KO'd or cuffed none at all.
    s *= 0.4 + 0.6 * Math.max(0, act.hp / Math.max(1, act.maxHp));
    if (act.state === 'ko' || act.state === 'arrested' || act.state === 'surrender') s *= 0.1;
  }
  // A group fights together.
  return s * (1 + 0.55 * friends);
}

/** The player's fighting strength: super strength, size (k = height / 1.8), health, combat powers. */
export function playerStrength(strengthRank: number, k: number, healthFrac: number, combatPowers: number): number {
  const base = 1 + 0.9 * strengthRank + 0.25 * Math.min(6, combatPowers);
  return base * Math.pow(Math.max(0.05, k), 1.5) * (0.45 + 0.55 * Math.max(0, Math.min(1, healthFrac)));
}

export function con(targetStrength: number, playerStr: number): ConLevel {
  return conLevel(targetStrength / Math.max(1e-3, playerStr));
}
