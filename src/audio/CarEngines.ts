/**
 * Quiet engine sounds for the traffic: a few positional engine loops that follow the cars
 * nearest the listener. A car idles softly at a light and hums a little louder and higher as it
 * speeds up; beyond ENGINE.range nothing is heard. Kept well below the city ambience on purpose
 * (Arnd: "car engine sound should not be loud").
 */
import type * as THREE from 'three';
import type { Audio } from './Audio';
import { VState, type Vehicle } from '../sim/Traffic';

export const ENGINE = {
  /** Positional loops at most (the nearest cars). */
  voices: 4,
  /** Metres: cars farther from the listener are silent. */
  range: 40,
  /** Distance at which a loop plays at its full level (Web Audio inverse model). */
  refDist: 3,
  /** Level of a car cruising right next to the listener (before the clip's manifest gain). */
  gain: 0.28,
  /** Share of that level when idling (standing at a light). */
  idle: 0.35,
  /** Seconds between re-picking the nearest cars. */
  pickEvery: 0.3,
};

type Handle = NonNullable<ReturnType<Audio['loop']>>;
interface Slot { h: Handle | null; car: Vehicle | null; level: number }

/** Electric shuttles make no engine noise; big diesels rumble lower. */
function voiceOf(v: Vehicle): { rate: number; gain: number } | null {
  switch (v.kind) {
    case 'shuttle': return null;
    case 'bus': case 'truck': case 'firetruck': case 'crane': case 'flatbed': case 'army_truck': return { rate: 0.72, gain: 1.25 };
    case 'tank': case 'apc': return { rate: 0.6, gain: 1.4 };
    case 'van': case 'delivery': case 'ambulance': case 'swat': case 'pickup': case 'suv': return { rate: 0.88, gain: 1.05 };
    case 'sports': return { rate: 1.15, gain: 1.1 };
    default: return { rate: 1, gain: 1 };
  }
}

function running(v: Vehicle): boolean {
  return v.alive && (v.state === VState.Drive || v.state === VState.Stopped || v.state === VState.Fleeing);
}

export class CarEngines {
  private slots: Slot[] = [];
  private pickT = 0;
  private tryT = 0;

  constructor(private audio: Audio) {
    for (let i = 0; i < ENGINE.voices; i++) this.slots.push({ h: null, car: null, level: 0 });
  }

  /**
   * Every frame. `lists`: the moving vehicles (traffic, response cars…); `shut` 0…1 muffles
   * them indoors and underground.
   */
  update(dt: number, cam: THREE.Vector3, lists: readonly (readonly Vehicle[])[], shut: number): void {
    this.pickT -= dt;
    if (this.pickT <= 0) { this.pickT = ENGINE.pickEvery; this.pick(cam, lists); }
    this.tryT -= dt;
    const R = ENGINE.range;
    for (const s of this.slots) {
      const v = s.car;
      if (!s.h) {
        if (!v || this.tryT > 0) continue;
        s.h = this.audio.loop('car_idle', ENGINE.refDist);
        if (!s.h) { this.tryT = 1; continue; }
      }
      const voice = v && running(v) ? voiceOf(v) : null;
      if (!v || !voice) { s.h.set(cam.x, cam.y, cam.z, 0); s.level = 0; continue; }
      const d = Math.hypot(v.x - cam.x, v.y - cam.y, v.z - cam.z);
      const edge = Math.min(1, Math.max(0, (R - d) / (R * 0.3)));
      const sp = Math.min(1, Math.abs(v.speed) / 14);
      const level = ENGINE.gain * voice.gain * (ENGINE.idle + (1 - ENGINE.idle) * sp) * edge * shut;
      // Each car its own pitch (by id), higher with the speed.
      const rate = voice.rate * (0.92 + ((v.id * 37) % 17) / 100) * (0.85 + 0.35 * sp);
      s.h.set(v.x, v.y + 0.6, v.z, level, rate);
      s.level = level;
    }
  }

  /** Give the slots to the nearest running cars; a car keeps its slot while it stays near. */
  private pick(cam: THREE.Vector3, lists: readonly (readonly Vehicle[])[]): void {
    const R2 = ENGINE.range * ENGINE.range;
    const near: { v: Vehicle; d: number }[] = [];
    for (const list of lists) for (const v of list) {
      if (!running(v) || !voiceOf(v)) continue;
      const d = (v.x - cam.x) ** 2 + (v.z - cam.z) ** 2 + (v.y - cam.y) ** 2;
      if (d < R2) near.push({ v, d });
    }
    near.sort((a, b) => a.d - b.d);
    const want = new Set(near.slice(0, ENGINE.voices).map((n) => n.v));
    for (const s of this.slots) if (s.car && !want.has(s.car)) s.car = null;
    for (const s of this.slots) want.delete(s.car as Vehicle);
    for (const v of want) {
      const s = this.slots.find((x) => !x.car);
      if (!s) break;
      s.car = v;
    }
  }

  /** How many engines are audible now (tests, debug). */
  audible(): number { return this.slots.filter((s) => s.level > 0.001).length; }

  dispose(): void {
    for (const s of this.slots) { s.h?.stop(); s.h = null; s.car = null; }
  }
}
