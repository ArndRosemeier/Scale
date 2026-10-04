/**
 * Event bus of things that happen in the world, consumed by NPC perception,
 * traffic, audio and camera effects.
 */
/** 'power': a frightening elemental power in use (beams, flames, bolts, quakes, vortices) — people flee, nothing breaks by itself.
 *  'cry': someone calls for help (a crime victim) — people stop, turn, film or back off. 'alarm': a shop alarm bell.
 *  'siren': a police car responding — traffic yields, people look; with `evac` a civil-defence siren: people
 *  near it leave for the nearest metro entrance (evacuate, not panic).
 *  'threat': hostile machines at work (rogue robots ramming, drones diving) — people near it flee.
 *  'roar': a monster's roar — people flee (the far ones stop, turn and film), drivers panic, birds flush.
 *  'tremor': the ground shaking (a giant's steps far off, an omen) — birds flush, people stop and look round.
 *  'thunder': a close thunderclap (render/Weather) — people flinch a little and look up, birds lift. */
export type StimulusKind = 'impact' | 'glass' | 'collapse' | 'blast' | 'stomp' | 'giant' | 'flyby' | 'crash' | 'scream' | 'horn' | 'sonic' | 'power' | 'cry' | 'alarm' | 'siren' | 'threat' | 'roar' | 'tremor' | 'thunder';

/** Who caused something (THREATS_PLAN §4: stimuli and the collateral ledger carry it; 'military': the army, later). */
export type Cause = 'player' | 'threat' | 'police' | 'military';

export interface Stimulus {
  kind: StimulusKind;
  x: number; y: number; z: number;
  /** Rough loudness/danger 0..∞ (≈ log10 of energy in J for physical events). */
  intensity: number;
  /** Radius in m within which it is noticed. */
  radius: number;
  time: number;
  /** Emission order (consumers that poll take what came after the last one they saw). */
  seq: number;
  /** Civil-defence siren: evacuate (kind 'siren'). */
  evac?: boolean;
  cause?: Cause;
  /**
   * Height (m) of the body behind it (footsteps, landings, roars): a stomp crushes cars and people by
   * the size of whoever made it (the player, a monster), not the player's (THREATS_PLAN §4.2).
   */
  size?: number;
}

export interface StimulusExtra { evac?: boolean; cause?: Cause; size?: number }

export class Stimuli {
  private list: Stimulus[] = [];
  time = 0;
  /** Sequence number of the last emitted stimulus. */
  seq = 0;
  private listeners: ((s: Stimulus) => void)[] = [];

  emit(kind: StimulusKind, x: number, y: number, z: number, intensity: number, radius: number, extra?: StimulusExtra): void {
    const s: Stimulus = { kind, x, y, z, intensity, radius, time: this.time, seq: ++this.seq, ...extra };
    this.list.push(s);
    for (const l of this.listeners) l(s);
  }

  on(fn: (s: Stimulus) => void): void {
    this.listeners.push(fn);
  }

  update(dt: number): void {
    this.time += dt;
    // Keep recent events for 6 s (perception queries).
    while (this.list.length && this.time - this.list[0].time > 6) this.list.shift();
  }

  near(x: number, z: number, out: Stimulus[] = []): Stimulus[] {
    out.length = 0;
    for (const s of this.list) if (Math.hypot(s.x - x, s.z - z) < s.radius) out.push(s);
    return out;
  }

  get recent(): readonly Stimulus[] {
    return this.list;
  }
}

/** Notice radius for an energy (J): louder events are noticed farther. */
export function noticeRadius(energyJ: number): number {
  return Math.min(3000, 15 + Math.sqrt(Math.max(0, energyJ)) * 0.4);
}
