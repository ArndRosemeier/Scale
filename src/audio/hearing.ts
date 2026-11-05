/**
 * How far a sound carries: the one place every positioned sound (clips, loops, streams, synth
 * powers) gets its distance behaviour from.
 *
 * - Loudness falls with distance (Web Audio's inverse model: ref / distance).
 * - Each sound has an audible range that follows from its loudness and reference distance: where
 *   its level would drop below HEARING.floor it is not heard at all (a one-shot out of range is
 *   not even started), with a soft fade over the last stretch so loops don't cut off.
 * - Far sounds lose their high end (air and the city in between): a lowpass that closes with
 *   distance, so a far horn is a dull hoot, not a clean beep.
 */
import * as THREE from 'three';
import { clamp, smoothstep } from '../core/math';

export const HEARING = {
  /** Level (after distance) below which a sound is not heard (≈ −34 dB, under the city's ambience). */
  floor: 0.02,
  /** The fade to silence starts at this share of the audible range. */
  fadeFrom: 0.6,
  /** Metres before the air starts to dull a sound, and how quickly it does. */
  airFrom: 20,
  airScale: 50,
  /** The lowpass never closes below this (Hz). */
  minCutoff: 900,
};

/** Where the listener is (the camera); Audio.updateListener keeps it current. */
export const listenerPos = new THREE.Vector3();

/** Metres at which a sound of `level` (its gain before distance) drops below HEARING.floor. */
export function audibleRange(level: number, ref: number, rolloff = 1): number {
  const r = level / HEARING.floor;
  return r <= 1 ? ref * r : ref + (ref * (r - 1)) / Math.max(0.01, rolloff);
}

/** Extra gain on top of the inverse fall: 1 well inside the range, 0 at its end and beyond. */
export function farGain(d: number, range: number): number {
  if (range <= 0) return 0;
  return 1 - smoothstep(range * HEARING.fadeFrom, range, d);
}

/** Lowpass cutoff (Hz) for a sound `d` metres away. */
export function airCutoff(d: number): number {
  return clamp(20000 / (1 + Math.max(0, d - HEARING.airFrom) / HEARING.airScale), HEARING.minCutoff, 20000);
}

export function listenerDist(x: number, y: number, z: number): number {
  return Math.hypot(x - listenerPos.x, y - listenerPos.y, z - listenerPos.z);
}

/** Can a sound of `level` at (x, y, z) be heard at all now? */
export function heard(x: number, y: number, z: number, level: number, ref: number, rolloff = 1): boolean {
  return listenerDist(x, y, z) < audibleRange(level, ref, rolloff);
}

/**
 * A positioned output: source → `input` → far fade → air lowpass → panner → `out`.
 * `place` moves it and sets fade and lowpass for the sound's current level (smoothly unless `now`).
 */
export class Spot {
  readonly input: GainNode;
  private lp: BiquadFilterNode;
  readonly pan: PannerNode;

  constructor(private ctx: BaseAudioContext, out: AudioNode, private ref: number, private rolloff = 1, model: PanningModelType = 'HRTF') {
    this.input = ctx.createGain();
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.Q.value = 0.5;
    this.lp.frequency.value = 20000;
    this.pan = ctx.createPanner();
    this.pan.panningModel = model;
    this.pan.distanceModel = 'inverse';
    this.pan.refDistance = ref;
    this.pan.rolloffFactor = rolloff;
    this.pan.maxDistance = 20000;
    this.input.connect(this.lp).connect(this.pan).connect(out);
  }

  /** Move it; `level` is the sound's gain before distance (decides how far it carries). */
  place(x: number, y: number, z: number, level: number, now = false, tc = 0.05): void {
    const d = listenerDist(x, y, z);
    const fade = farGain(d, audibleRange(level, this.ref, this.rolloff)), cut = airCutoff(d);
    const p = this.pan, t = this.ctx.currentTime;
    if (now) {
      p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z;
      this.input.gain.value = fade;
      this.lp.frequency.value = cut;
    } else {
      p.positionX.setTargetAtTime(x, t, tc); p.positionY.setTargetAtTime(y, t, tc); p.positionZ.setTargetAtTime(z, t, tc);
      this.input.gain.setTargetAtTime(fade, t, 0.15);
      this.lp.frequency.setTargetAtTime(cut, t, 0.2);
    }
  }

  disconnect(): void { this.input.disconnect(); this.lp.disconnect(); this.pan.disconnect(); }
}
