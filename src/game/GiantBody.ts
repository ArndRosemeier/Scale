/**
 * GiantBody (THREATS_PLAN §4.1): what every walking body shares, whatever its size — the player
 * from 10 cm to 100 m and the monsters (the Strider, later tripods and mechs).
 *
 * Scaling laws (k = height / 1.8 m, see Player.ts):
 *   mass ∝ k³ · walking speed ∝ √k (Froude similarity) · cadence ∝ 1/√k
 *   footstep energy = ½ · mass · (¼ g · height)  (the body's fall onto the leading leg)
 *
 * `GiantSteps` turns footsteps and landings into the world's reactions: camera shake (the player's
 * own steps as a short thud, anyone else's by distance from the camera), dust, a `stomp` stimulus
 * carrying the body's size and cause (people and cars under the foot are crushed by *its* size and
 * booked to whoever made it — Game, Reactions and the near-future layer read `size` / `cause`),
 * the sound, and a destruction impact under a heavy foot.
 */
import * as THREE from 'three';
import type { Dust } from '../destruction/Dust';
import type { Destruction } from '../destruction/Destruction';
import type { CameraRig } from '../player/CameraRig';
import { noticeRadius, type Cause, type Stimuli } from './Stimuli';

export const GRAVITY = 9.81;
/** Reference body height (m): k = height / HUMAN_HEIGHT. */
export const HUMAN_HEIGHT = 1.8;

/** Mass of a body `height` m tall (kg): a human's 80 kg × k³ × a build factor (a bulky creature > 1). */
export function bodyMass(height: number, build = 1): number {
  return 80 * build * (height / HUMAN_HEIGHT) ** 3;
}

/** Energy of one footfall (J). */
export function stepEnergy(mass: number, height: number): number {
  return 0.5 * mass * (0.25 * GRAVITY * height);
}

/** Walking speed (m/s) of a body `height` m tall whose 1.8 m equivalent walks at `base` m/s (Froude similarity). */
export function walkSpeed(height: number, base = 1.45): number {
  return base * Math.sqrt(height / HUMAN_HEIGHT);
}

/** Gait time scale (animation seconds per real second): cadence ∝ 1/√k. */
export function gaitRate(height: number): number {
  return 1 / Math.sqrt(height / HUMAN_HEIGHT);
}

export interface StepOpts {
  /** Who made it (stimulus and ledger): the player by default. */
  cause?: Cause;
  /** The player's own body: the camera rides on it (a short thud, not shake by distance). */
  own?: boolean;
  /** Sound clip and its reference distance (m). */
  sound?: string;
  ref?: number;
  /** Cap on the stomp stimulus radius (m): a monster's every step must not panic a whole city. */
  maxR?: number;
  /** Size of the foot (m, impact radius); default from the height. */
  foot?: number;
  /** Break what is under the foot (default true; a monster spends its own destruction budget instead). */
  impact?: boolean;
}

export interface GiantWorld {
  camera: THREE.Camera;
  camRig: CameraRig;
  dust: Dust;
  destruction: Destruction;
  stimuli: Stimuli;
  /** The player's position (own steps: the camera's distance from the body). */
  playerPos: THREE.Vector3;
}

const STEP_DUST = new THREE.Color(0.55, 0.52, 0.48);
const LAND_DUST = new THREE.Color(0.58, 0.55, 0.5);

export class GiantSteps {
  /** Clip at a point (id, position, gain, pitch, reference distance). */
  sound: ((id: string, x: number, y: number, z: number, gain: number, pitch: number, ref?: number) => void) | null = null;
  readonly stats = { steps: 0, lands: 0, broken: 0 };

  constructor(private w: GiantWorld) {}

  /** Camera shake from a far body's footfall: strong close by, fading with distance in body heights. */
  private shakeAt(x: number, y: number, z: number, energy: number, h: number): number {
    const c = this.w.camera.position;
    const d = Math.hypot(c.x - x, c.y - y, c.z - z);
    const base = Math.max(0, Math.min(1, Math.log10(Math.max(1, energy)) / 9 - 0.3));
    return base * Math.min(1, 1 / (1 + (d / (h * 2.5)) ** 2) * 1.6);
  }

  /**
   * A footstep of a body `h` m tall with `energy` J: shake, dust, the stomp stimulus (size and cause),
   * the sound and, under a heavy foot, a destruction impact. Returns the panels broken.
   */
  footstep(x: number, y: number, z: number, energy: number, h: number, o: StepOpts = {}): number {
    const W = this.w, cause = o.cause ?? 'player', own = o.own ?? cause === 'player';
    this.stats.steps++;
    if (h <= 4) {
      this.sound?.('step_concrete', x, y, z, Math.min(1, 0.25 + h * 0.15), Math.min(2.5, 1 / Math.pow(h / 1.8, 0.35)), o.ref);
      if (h > 2.5) W.stimuli.emit('giant', x, y, z, h, h * 30, { cause, size: h });
      return 0;
    }
    // Footsteps of a heavy body shake the ground and break what is under the foot.
    if (own) {
      const shake = Math.min(1, Math.log10(energy) / 9 - 0.3);
      const d = W.camera.position.distanceTo(W.playerPos) / h;
      // One's own steps: a short thud per step, not a shake that builds up over the walk.
      W.camRig.addShake(Math.min(0.3, Math.max(0, shake) * Math.max(0.2, 1 - d * 0.05)));
    } else W.camRig.addShake(Math.min(0.45, this.shakeAt(x, y, z, energy, h)));
    W.dust.burst(x, y + 0.2, z, Math.min(16, Math.round(h * 0.5)), h * 0.08, h * 0.12, h * 0.06 + 0.4, 4, STEP_DUST, 0.1, 0.35);
    W.stimuli.emit('stomp', x, y, z, Math.log10(energy), Math.min(o.maxR ?? Infinity, noticeRadius(energy)), { cause, size: h });
    this.sound?.(o.sound ?? 'step_giant', x, y, z, Math.min(1, h / 30), Math.max(0.4, 1.4 - h / 80), o.ref);
    let n = 0;
    if (h > 8 && o.impact !== false) n = W.destruction.impact(x, y + h * 0.05, z, o.foot ?? h * 0.08, Math.sqrt(energy) * 80, 0, -1, 0, 'stomp');
    this.stats.broken += n;
    return n;
  }

  /** Landing (a jump, a fall, a monster's forefeet coming down from rearing). Returns the panels broken. */
  land(x: number, y: number, z: number, energy: number, h: number, o: StepOpts = {}): number {
    const W = this.w, cause = o.cause ?? 'player', own = o.own ?? cause === 'player';
    if (energy < 2000 * (h / 1.8)) { this.sound?.('land_thud', x, y, z, 0.5, 1, o.ref); return 0; }
    this.stats.lands++;
    W.camRig.addShake(own ? Math.min(1.2, Math.log10(energy) / 8) : Math.min(0.9, this.shakeAt(x, y, z, energy, h) * 1.6));
    const r = h * 0.35 + Math.cbrt(energy) * 0.01;
    W.dust.burst(x, y + 0.3, z, 30, r, r * 1.5, r * 0.5 + 1, 6, LAND_DUST, 0.15, 0.5);
    const n = W.destruction.impact(x, y + 1, z, o.foot ?? r, Math.sqrt(energy) * 60, 0, -1, 0, 'stomp');
    W.stimuli.emit('stomp', x, y, z, Math.log10(energy), Math.min(o.maxR ?? Infinity, noticeRadius(energy)), { cause, size: h });
    this.sound?.(o.sound ?? (h > 6 ? 'step_giant' : 'land_thud'), x, y, z, 1, Math.max(0.4, 1.2 - h / 100), o.ref);
    this.stats.broken += n;
    return n;
  }
}
