/**
 * Small arms (police pistols, SWAT rifles, a robber's gun): what a shot is, whether it may be
 * fired, and what it looks and sounds like.
 *
 *  - Specs per gun (GUNS): range, cadence, damage per round to people, to rogue machines (their
 *    impulse hit points: a punch is 200, a robot has 600), to a drone's plating and to the player.
 *    Deliberately modest: a pair of officers needs some seconds for a drone and keeps wearing a
 *    robot down; the player's powers do it at once.
 *  - The rules (combat/shot.ts): every shooter here has a chosen target, so a round is only fired
 *    with a clear line (`los`: the shared line of sight, combat/sight — buildings, terrain, cars)
 *    and then it hits (no stray rounds; the damage per round is what a round used to do on
 *    average, so the time to bring something down is as before); nobody in the line either —
 *    officers hold fire when a person stands in it or right by a target on the ground (`clear`).
 *  - The look: a muzzle flash (the powers' particle pool), a short faint tracer streak (its beam
 *    ribbons, a pooled list — no allocation per shot), sparks where a round hits a machine, a
 *    `gunfire` stimulus (bystanders run, the farther ones duck and look; throttled), the sound.
 *
 * The specs and `hitRate` are pure (headless tests); the class needs the game.
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';
import { BeamStyle } from '../powers/ElementFx';
import type { Cause } from '../Stimuli';
import { COMBAT } from '../Combat';

export type GunId = 'pistol' | 'rifle' | 'crook';

export interface GunSpec {
  /** Held item (wardrobe) and the aiming action (anim/actions). */
  item: string;
  aim: string;
  /** Effective range (m). */
  range: number;
  /** Seconds between trigger pulls; rounds per pull (a burst) and their spacing (s). */
  gap: number;
  burst: number;
  burstGap: number;
  /** Damage per round (every round fired hits): a person (hp), a ground machine (RogueMachines hp: impulse points), a drone's plating, the player (before size). */
  person: number;
  machine: number;
  drone: number;
  player: number;
  sound: string;
  gain: number;
}

export const GUNS: Record<GunId, GunSpec> = {
  // (Was: 20/40/34 hp at 50–60 % hits on the ground, ~35 % in the air. Every round hits now: the
  // same damage a second. Against the player: officers at wanted level 3 only — PlayerHealth
  // regenerates 7 hp/s out of a fight.)
  pistol: { item: 'pistol', aim: 'aim_pistol', range: 38, gap: 0.75, burst: 1, burstGap: 0, person: 10, machine: 22, drone: 12, player: 2, sound: 'gun_pistol', gain: 0.8 },
  rifle: { item: 'rifle', aim: 'aim_rifle', range: 55, gap: 1.35, burst: 3, burstGap: 0.09, person: 12, machine: 9, drone: 6, player: 0.8, sound: 'gun_rifle', gain: 0.85 },
  crook: { item: 'pistol', aim: 'aim_pistol', range: 26, gap: 2.8, burst: 1, burstGap: 0, person: 7, machine: 15, drone: 10, player: 3.5, sound: 'gun_pistol', gain: 0.8 },
};

/** A hostile drone's plating: pistol rounds to bring it down ≈ 3, rifle rounds ≈ 4. */
export const DRONE_PLATING = 100;

/** Muzzle height when standing / kneeling (m above the feet). */
export const MUZZLE_Y = { stand: 1.42, kneel: 1.0 };

/** The impulse (N·s) a round carries into Combat.hitActor to do `dmg` damage to a person. */
export function gunJ(dmg: number): number { return dmg / COMBAT.dmgPerNs; }

/** Hits a second of `shooters` firing this gun with a clear line (every round hits; tuning, tests). */
export function hitRate(s: GunSpec, shooters: number): number {
  return shooters * (s.burst / s.gap);
}

const TRACER_CAP = 64;
interface Tracer { ax: number; ay: number; az: number; dx: number; dy: number; dz: number; L: number; s: number; on: boolean }

const FLASH = new THREE.Color(4, 2.7, 1.2), FLASH_END = new THREE.Color(1.1, 0.4, 0.05);
const SPARK = new THREE.Color(4, 2.4, 0.8);
const DUST = new THREE.Color(0.5, 0.48, 0.44);

export class Firearms {
  private tracers: Tracer[] = [];
  private nb: PedAgent[] = [];
  private stimT = 0;
  private stimX = 0;
  private stimZ = 0;
  private time = 0;
  stats = { shots: 0, hits: 0, heldFire: 0, noLos: 0, losRays: 0, tracers: 0, peakTracers: 0, msAvg: 0, atPlayer: 0, atGiant: 0 };

  constructor(private g: Game) {
    for (let i = 0; i < TRACER_CAP; i++) this.tracers.push({ ax: 0, ay: 0, az: 0, dx: 0, dy: 0, dz: 0, L: 0, s: 0, on: false });
  }

  /**
   * A clear line from a to b, ending `pad` m short of b (the target's own body): the shared line
   * of sight (combat/sight — buildings with their holes, terrain, cars parked and moving).
   * `skip`: the shooter's own car (cover), a target that is a car.
   */
  los(ax: number, ay: number, az: number, bx: number, by: number, bz: number, pad = 0.7, skip: object | null = null, skip2: object | null = null): boolean {
    this.stats.losRays++;
    if (this.g.sight.clear(ax, ay, az, bx, by, bz, pad, skip, skip2)) return true;
    this.stats.noLos++;
    return false;
  }

  /**
   * Nobody in the line of fire: no person (other than the shooter and the target) within 0.8 m of
   * the line from 1 m out to the target, below the line (a round passing well over their heads to a
   * drone is fine); for a target on the ground nobody right beside it or just beyond it either.
   * The player counts as a person (`playerTarget`: the player is who is being shot at).
   */
  clear(shooter: PedAgent, ax: number, ay: number, az: number, bx: number, by: number, bz: number, target: PedAgent | null, ground: boolean, playerTarget = false): boolean {
    const dx = bx - ax, dz = bz - az, Lh = Math.hypot(dx, dz);
    if (Lh < 0.5) return true;
    const ux = dx / Lh, uz = dz / Lh;
    // Ground targets: misses carry on a few metres past.
    const reach = Lh + (ground ? 6 : 0);
    const cx = ax + ux * reach * 0.5, cz = az + uz * reach * 0.5;
    // The player is a person in the way too (unless that is who they are shooting at).
    const P = this.g.player;
    if (!playerTarget && P.height < 6) {
      const px = P.pos.x - ax, pz = P.pos.z - az, along = px * ux + pz * uz;
      if (along > 1 && along < reach) {
        const side = Math.abs(px * uz - pz * ux);
        const y = ay + (by - ay) * Math.min(1, along / Lh);
        if ((ground && Math.hypot(P.pos.x - bx, P.pos.z - bz) < 1.6 + P.radius) || (side < 0.8 + P.radius && y < P.pos.y + P.height + 0.3 && y > P.pos.y - 0.3)) { this.stats.heldFire++; return false; }
      }
    }
    for (const a of this.g.peds.neighbours(cx, cz, reach * 0.5 + 1.2, this.nb)) {
      if (a === shooter || a === target || !a.alive || a.inside) continue;
      const px = a.x - ax, pz = a.z - az;
      const along = px * ux + pz * uz;
      if (along < 1 || along > reach) continue;
      const side = Math.abs(px * uz - pz * ux);
      // Beside a target on the ground (a robot going for someone): never.
      if (ground && Math.hypot(a.x - bx, a.z - bz) < 1.6) { this.stats.heldFire++; return false; }
      if (side > 0.8) continue;
      // The line's height there: a round to a drone overhead passes above the crowd.
      const k = Math.min(1, along / Lh), y = ay + (by - ay) * k;
      const h = a.state === PState.Down ? 0.5 : 2.0;
      if (y > a.y + h + 0.3) continue;
      this.stats.heldFire++;
      return false;
    }
    return true;
  }

  /**
   * One trigger pull from `shooter` at a point: `hits` of the burst's rounds land (sparks on a
   * machine; with a clear line all of them do), any others fly past. Effects only — the caller deals the damage.
   */
  fire(shooter: PedAgent, s: GunSpec, mx: number, my: number, mz: number, tx: number, ty: number, tz: number, hits: number, onMachine: boolean, ground: boolean, cause: Cause | undefined): void {
    const g = this.g, fx = g.elements.fx, cam = g.renderer.camera.position;
    const dx = tx - mx, dy = ty - my, dz = tz - mz, L = Math.hypot(dx, dy, dz) || 1;
    const ux = dx / L, uy = dy / L, uz = dz / L;
    this.stats.shots += s.burst;
    this.stats.hits += hits;
    const near = Math.hypot(cam.x - mx, cam.z - mz) < 260;
    if (near) {
      for (let k = 0; k < s.burst; k++) {
        const hit = k < hits;
        // A miss: on past the target (into the sky, or the street just beyond), a little off line.
        let ex = tx, ey = ty, ez = tz;
        if (hit) { ex += (Math.random() - 0.5) * 0.25; ey += (Math.random() - 0.5) * 0.25; ez += (Math.random() - 0.5) * 0.25; }
        else if (ground) { const r = 0.8 + Math.random() * 2.5, a = Math.random() * Math.PI * 2; ex = tx + ux * r * 2 + Math.cos(a) * r * 0.5; ez = tz + uz * r * 2 + Math.sin(a) * r * 0.5; ey = g.floorAt(ex, ty - 1, ez) + 0.15; }
        else { ex = tx + ux * 30 + (Math.random() - 0.5) * 4; ey = ty + uy * 30 + (Math.random() - 0.3) * 4; ez = tz + uz * 30 + (Math.random() - 0.5) * 4; }
        this.tracer(mx, my, mz, ex, ey, ez, k * s.burstGap);
        if (hit && onMachine) g.debris.chipBurst(ex, ey, ez, 4, 3.5, -ux, -uy + 0.3, -uz, SPARK, 0.02, 0.35);
        else if (!hit && ground) g.debris.chipBurst(ex, ey, ez, 2, 1.5, 0, 1, 0, DUST, 0.03, 0.4);
      }
      fx.glow(mx, my, mz, ux * 2, uy * 2, uz * 2, 0.05, 0.12, 0.3, FLASH, FLASH_END, 1, 4, 0);
      g.audio.play(s.sound, mx, my, mz, s.gain, 0.94 + Math.random() * 0.12, 12, cam);
      if (hits > 0 && onMachine) g.audio.play('gun_ricochet', tx, ty, tz, 0.35, 0.85 + Math.random() * 0.3, 6, cam);
    }
    // People round about hear it (one stimulus for a spot at a time).
    if (this.time - this.stimT > 0.4 || Math.hypot(mx - this.stimX, mz - this.stimZ) > 25) {
      this.stimT = this.time; this.stimX = mx; this.stimZ = mz;
      g.stimuli.emit('gunfire', mx, my, mz, 3, 55, cause ? { cause } : undefined);
    }
    void shooter;
  }

  /** A faint short streak flying from a to b (pooled). */
  private tracer(ax: number, ay: number, az: number, bx: number, by: number, bz: number, delay: number): void {
    let t: Tracer | null = null;
    for (const q of this.tracers) if (!q.on) { t = q; break; }
    if (!t) return;
    const dx = bx - ax, dy = by - ay, dz = bz - az, L = Math.hypot(dx, dy, dz) || 1;
    t.ax = ax; t.ay = ay; t.az = az; t.dx = dx / L; t.dy = dy / L; t.dz = dz / L; t.L = L; t.s = -delay * TRACER_V; t.on = true;
  }

  update(dt: number): void {
    this.time += dt;
    const fx = this.g.elements.fx;
    let n = 0;
    for (const t of this.tracers) {
      if (!t.on) continue;
      t.s += TRACER_V * dt;
      if (t.s - TRACER_LEN > t.L) { t.on = false; continue; }
      n++;
      if (t.s <= 0) continue;
      const h = Math.min(t.s, t.L), tl = Math.max(0, t.s - TRACER_LEN);
      fx.seg(t.ax + t.dx * tl, t.ay + t.dy * tl, t.az + t.dz * tl, t.ax + t.dx * h, t.ay + t.dy * h, t.az + t.dz * h, 0.035, 2.6, 1.6, 0.6, 1.2, BeamStyle.Laser);
    }
    this.stats.tracers = n;
    if (n > this.stats.peakTracers) this.stats.peakTracers = n;
  }
}

const TRACER_V = 360, TRACER_LEN = 2.4;
