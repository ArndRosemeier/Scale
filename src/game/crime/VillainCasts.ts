/**
 * Villain powers in the world (VILLAINS_PLAN §3.4, Phase 3): what a lieutenant's cast looks like
 * and does. The decisions (what, when, the fixed aim, the wind-up) are the caster core's
 * (powers/Caster) and the crime's (Crime.usePowers); this draws the tells and the effects with the
 * powers' own pools (ElementFx beams, particles, decals; blastFx), so a villain's bolt reads like
 * the hero's, and applies them: the player through PlayerHealth (size, invulnerability), people
 * through Reactions.knockDown, and a frost chill / a stun on the player itself.
 *
 *   bolt      a jagged arc along the fixed aim; hits what stands on the line
 *   fireball  an orb flies to where the target stood and bursts (a step aside gets clear)
 *   frost     an icy ray along the aim for a moment: a little damage, chilled (slow) for 3 s
 *   gust      a cone of wind: shoves, barely hurts
 *   quake     a crack runs along the ground to past the target; who stands on it goes down
 *   dash      dust at the start and along the rush (the charge itself is the crime's)
 *   shield    a shimmering bubble while it holds (Combat lets blows barely through)
 *   stun      a grenade lobbed to the aim, a short fuse, a white flash: the target goes down
 *   smoke     a thick grey cloud at the caster's feet to slip away in
 *
 * At most CASTERS.maxCasting casts in their wind-up or flight city-wide; nothing here is booked
 * to the player (no collateral), and nothing costs anything when no villain casts.
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';
import type { HurtKind } from '../PlayerHealth';
import { BeamStyle, DecalKind } from '../powers/ElementFx';
import { fireBurst } from '../powers/blastFx';
import { VILLAIN_POWERS, CASTERS, segDist, type VillainPower } from '../powers/Caster';
import type { CastStage, OpLook } from './Crime';

interface Orb { kind: 'fire' | 'stun'; x: number; y: number; z: number; ax: number; ay: number; az: number; bx: number; by: number; bz: number; t: number; T: number; arc: number; fuse: number; by_: PedAgent }
interface Crack { ax: number; az: number; dx: number; dz: number; L: number; s: number; y: number; hitPlayer: boolean; hit: Set<PedAgent>; by_: PedAgent }
interface Ray { power: 'bolt' | 'frost'; ax: number; ay: number; az: number; bx: number; by: number; bz: number; life: number; t: number; seed: number }
interface Cloud { x: number; y: number; z: number; t: number }

const C = (r: number, g: number, b: number) => new THREE.Color(r, g, b);
const FIRE = C(3, 1.3, 0.3), FIRE_END = C(0.8, 0.15, 0.02);
const ICE = C(1.5, 2.0, 2.6), ICE_END = C(0.5, 0.75, 1.0);
const DUST = C(0.55, 0.5, 0.44), DUST_END = C(0.45, 0.42, 0.38);
const WHITE = C(5, 5, 5), WHITE_END = C(1.2, 1.2, 1.3);
const SMOKE = C(0.42, 0.42, 0.44), SMOKE_END = C(0.6, 0.6, 0.62);
const WIND = C(1.2, 1.25, 1.3), WIND_END = C(0.3, 0.32, 0.35);
const EMP = C(1.2, 2.2, 4.5), EMP_END = C(0.2, 0.4, 1.2);
const HACK = C(0.4, 2.4, 3.2), HACK_END = C(0.05, 0.5, 0.8);
const STORM = C(1.7, 1.5, 3.8), STORM_END = C(0.35, 0.25, 0.9);
/** A ritual's colours by element. */
const RITE = { fire: [FIRE, FIRE_END], frost: [ICE, ICE_END], storm: [STORM, STORM_END] } as const;
/** A completed ritual's burst: reach (m), damage to the player, the knock on people. */
export const RITE_BURST = { radius: 9, dmg: 12, knock: 6 };
const _c0 = new THREE.Color(), _c1 = new THREE.Color();

export class VillainCasts {
  /** Casters in their wind-up (or with something in flight), by agent: the city-wide slots. */
  private casting = new Map<PedAgent, number>();
  private orbs: Orb[] = [];
  private cracks: Crack[] = [];
  private rays: Ray[] = [];
  private clouds: Cloud[] = [];
  private nb: PedAgent[] = [];
  private time = 0;
  /** The player is hurt through here (CrimeSystem: PlayerHealth and its sound). */
  hurtPlayer: ((dmg: number, kind: HurtKind, fromX: number, fromZ: number) => void) | null = null;
  stats = { casts: 0, released: 0, atPlayer: 0, knocked: 0, refused: 0 };

  constructor(private g: Game) {}

  /** Casts in their wind-up right now (dev). */
  get active(): number { this.prune(); return this.casting.size; }

  /** A stage of a cast (CrimeWorld.cast). */
  cast(by: PedAgent, power: VillainPower, stage: CastStage, tx: number, ty: number, tz: number): boolean {
    switch (stage) {
      case 'begin': {
        this.prune();
        if (!this.casting.has(by) && this.casting.size >= CASTERS.maxCasting) { this.stats.refused++; return false; }
        this.casting.set(by, this.time);
        this.stats.casts++;
        return true;
      }
      case 'tell': this.casting.set(by, this.time); this.tell(by, power, tx, tz); return true;
      case 'release': this.casting.delete(by); this.stats.released++; this.release(by, power, tx, ty, tz); return true;
      case 'hold': this.hold(by, power); return true;
      case 'end': this.casting.delete(by); return true;
    }
  }

  /** Slots held by casters that stopped calling (crime ended, despawned). */
  private prune(): void {
    for (const [a, t] of this.casting) if (!a.alive || this.time - t > 1) this.casting.delete(a);
  }

  private hand(by: PedAgent): { x: number; y: number; z: number } {
    // In front of the chest, a little to the right: where the hands are in the cast pose.
    const h = by.heading;
    return { x: by.x - Math.sin(h) * 0.45 - Math.cos(h) * 0.15, y: by.y + 1.35, z: by.z - Math.cos(h) * 0.45 + Math.sin(h) * 0.15 };
  }

  private near(x: number, z: number, r = 260): boolean {
    const c = this.g.renderer.camera.position;
    return Math.hypot(c.x - x, c.z - z) < r;
  }

  /** The wind-up: glow gathering at the hands (or dust at the feet for a stomp), a hint of where it goes. */
  private tell(by: PedAgent, power: VillainPower, tx: number, tz: number): void {
    if (!this.near(by.x, by.z)) return;
    const fx = this.g.elements.fx, P = VILLAIN_POWERS[power];
    _c0.setRGB(P.tell[0], P.tell[1], P.tell[2]);
    _c1.setRGB(P.tell[0] * 0.3, P.tell[1] * 0.3, P.tell[2] * 0.3);
    if (power === 'quake') {
      // Dust kicking up round the feet, and a faint ripple along the line it will run.
      for (let i = 0; i < 2; i++) { const a = Math.random() * Math.PI * 2; fx.soft(by.x + Math.sin(a) * 0.8, by.y + 0.1, by.z + Math.cos(a) * 0.8, Math.sin(a) * 1.2, 0.8, Math.cos(a) * 1.2, 0.6, 0.3, 0.9, DUST, DUST_END, 0.5, 1.5, 0); }
      if (Math.random() < 0.5) {
        const u = Math.random(), x = by.x + (tx - by.x) * u, z = by.z + (tz - by.z) * u;
        fx.soft(x, this.g.world.groundHeight(x, z) + 0.05, z, 0, 0.6, 0, 0.5, 0.2, 0.5, DUST, DUST_END, 0.35, 1, 0);
      }
      return;
    }
    if (power === 'dash') {
      for (let i = 0; i < 2; i++) fx.soft(by.x + (Math.random() - 0.5), by.y + 0.1, by.z + (Math.random() - 0.5), 0, 0.7, 0, 0.5, 0.25, 0.7, DUST, DUST_END, 0.4, 1.5, 0);
      return;
    }
    const H = this.hand(by);
    for (let i = 0; i < 2; i++) {
      const a = Math.random() * Math.PI * 2, r = 0.25 + Math.random() * 0.2;
      // Motes drawn in to the hand.
      fx.glow(H.x + Math.sin(a) * r, H.y + (Math.random() - 0.5) * r, H.z + Math.cos(a) * r, -Math.sin(a) * r * 3, 0, -Math.cos(a) * r * 3, 0.22, 0.12, 0.04, _c0, _c1, 1, 1, 0);
    }
    fx.glow(H.x, H.y, H.z, 0, 0, 0, 0.06, 0.28, 0.22, _c0, _c1, 0.8, 1, 0);
  }

  /** Lasting powers on the caster: the shield's bubble, the dash's dust trail. */
  private hold(by: PedAgent, power: VillainPower): void {
    if (!this.near(by.x, by.z)) return;
    const fx = this.g.elements.fx;
    if (power === 'shield') {
      const P = VILLAIN_POWERS.shield;
      _c0.setRGB(P.tell[0] * 0.6, P.tell[1] * 0.6, P.tell[2] * 0.6); _c1.setRGB(0.2, 0.35, 0.6);
      for (let i = 0; i < 5; i++) {
        const a = Math.random() * Math.PI * 2, u = Math.random() * 2 - 1, s = Math.sqrt(1 - u * u), R = P.radius;
        fx.glow(by.x + Math.cos(a) * s * R, by.y + 1 + u * R * 1.1, by.z + Math.sin(a) * s * R, 0, 0, 0, 0.3, 0.16, 0.1, _c0, _c1, 0.6, 1, 0);
      }
    } else if (power === 'dash') {
      fx.soft(by.x, by.y + 0.2, by.z, (Math.random() - 0.5) * 2, 1, (Math.random() - 0.5) * 2, 0.6, 0.4, 1.1, DUST, DUST_END, 0.45, 1.5, 0);
    }
  }

  private release(by: PedAgent, power: VillainPower, tx: number, ty: number, tz: number): void {
    const g = this.g, P = VILLAIN_POWERS[power], H = this.hand(by);
    // Aim direction (fixed during the wind-up), out to the power's reach.
    const dx = tx - H.x, dy = ty - H.y, dz = tz - H.z, l = Math.hypot(dx, dy, dz) || 1;
    const reach = Math.max(l, Math.min(P.max, l + 4));
    const ex = H.x + (dx / l) * reach, ey = H.y + (dy / l) * reach, ez = H.z + (dz / l) * reach;
    switch (power) {
      case 'bolt':
      case 'frost': {
        this.rays.push({ power, ax: H.x, ay: H.y, az: H.z, bx: ex, by: ey, bz: ez, life: power === 'bolt' ? 0.4 : P.hold, t: 0, seed: (Math.random() * 1e6) | 0 });
        this.lineHits(by, power, H.x, H.z, ex, ez, P.radius, H.y, ey);
        if (power === 'frost' && this.near(ex, ez)) g.elements.fx.decal(DecalKind.Frost, ex, g.world.groundHeight(ex, ez) + 0.03, ez, 0, 1, 0, 2.4, 2.4, Math.random() * 6, 20);
        break;
      }
      case 'fireball':
      case 'stun': {
        const fire = power === 'fireball';
        const gy = g.world.groundHeight(tx, tz);
        const T = fire ? Math.max(0.25, l / CASTERS.orbSpeed) : Math.min(1.1, Math.max(0.5, l / 13));
        this.orbs.push({ kind: fire ? 'fire' : 'stun', x: H.x, y: H.y, z: H.z, ax: H.x, ay: H.y, az: H.z, bx: tx, by: fire ? ty : gy + 0.1, bz: tz, t: 0, T, arc: fire ? 0 : 1 + l * 0.18, fuse: fire ? 0 : 0.7, by_: by });
        this.casting.set(by, this.time);
        break;
      }
      case 'gust': this.gust(by, dx / l, dz / l); break;
      case 'quake': {
        const hx = tx - by.x, hz = tz - by.z, hl = Math.hypot(hx, hz) || 1;
        this.cracks.push({ ax: by.x, az: by.z, dx: hx / hl, dz: hz / hl, L: Math.min(P.max + 2, hl + 3), s: 0.6, y: by.y, hitPlayer: false, hit: new Set(), by_: by });
        g.stimuli.emit('gunfire', by.x, by.y, by.z, 3, 40);
        break;
      }
      case 'dash': {
        if (this.near(by.x, by.z)) for (let i = 0; i < 8; i++) { const a = Math.random() * Math.PI * 2; g.elements.fx.soft(by.x, by.y + 0.15, by.z, Math.sin(a) * 3, 0.8, Math.cos(a) * 3, 0.8, 0.4, 1.4, DUST, DUST_END, 0.5, 2, 0); }
        break;
      }
      case 'emp': this.emp(by, tx, ty, tz); break;
      case 'shield': break;
      case 'smoke': this.clouds.push({ x: by.x, y: by.y, z: by.z, t: 0 }); g.stimuli.emit('gunfire', by.x, by.y, by.z, 2, 25); break;
    }
  }

  /** People on a beam's line (from the hand to its end): the player hurt (frost chills), others knocked down. */
  private lineHits(by: PedAgent, power: 'bolt' | 'frost', ax: number, az: number, bx: number, bz: number, w: number, ay: number, ey: number): void {
    const g = this.g, P = VILLAIN_POWERS[power], p = g.player;
    const pd = segDist(p.pos.x, p.pos.z, ax, az, bx, bz);
    const yAt = ay + (ey - ay) * Math.min(1, Math.hypot(p.pos.x - ax, p.pos.z - az) / (Math.hypot(bx - ax, bz - az) || 1));
    if (pd < w + p.height * 0.08 && yAt > p.pos.y - 0.3 && yAt < p.pos.y + p.height + 0.3) {
      this.stats.atPlayer++;
      this.hurtPlayer?.(P.dmg * (0.85 + 0.3 * Math.random()), 'power', ax, az);
      if (power === 'frost') { p.chillT = CASTERS.chill; p.chillSpeed = CASTERS.chillSpeed; }
    }
    const mx = (ax + bx) / 2, mz = (az + bz) / 2, R = Math.hypot(bx - ax, bz - az) / 2 + w;
    for (const a of g.peds.neighbours(mx, mz, R, this.nb)) {
      if (a === by || !a.alive || a.inside || a.state === PState.Down || segDist(a.x, a.z, ax, az, bx, bz) > w) continue;
      if (power === 'bolt') { g.reactions.knockDown(a, ax, az, 3.5, 'other'); this.stats.knocked++; }
      else { a.fear = Math.min(2, a.fear + 1); a.fearX = ax; a.fearZ = az; a.state = PState.Flee; a.stateT = 0; }
    }
  }

  /** An EMP at the aim: a blue ring, cars in it stall, drones drop, the hero gets a jolt and is slowed. */
  private emp(by: PedAgent, x: number, y: number, z: number): void {
    const g = this.g, P = VILLAIN_POWERS.emp, R = P.radius, p = g.player;
    const ground = g.world.groundHeight(x, z);
    if (this.near(x, z, 500)) {
      const fx = g.elements.fx;
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        fx.glow(x, ground + 0.4, z, Math.cos(a) * R * 2.6, 0.3, Math.sin(a) * R * 2.6, 0.38, 0.35, 0.15, EMP, EMP_END, 1, 1, 0);
      }
      fx.glow(x, ground + 1, z, 0, 0, 0, 0.18, 1.2, 4, EMP, EMP_END, 1, 1, 0);
      this.rays.push({ power: 'bolt', ax: by.x, ay: by.y + 2.2, az: by.z, bx: x, by: ground + 1, bz: z, life: 0.25, t: 0, seed: (Math.random() * 1e6) | 0 });
    }
    const pd = Math.hypot(p.pos.x - x, p.pos.z - z);
    if (pd < R + p.height * 0.1 && Math.abs(p.pos.y - y) < 4) {
      this.stats.atPlayer++;
      this.hurtPlayer?.(P.dmg, 'power', x, z);
      p.chillT = Math.max(p.chillT, 1.5); p.chillSpeed = CASTERS.chillSpeed;
    }
    for (const list of [g.traffic.vehicles, g.parkedCars]) for (const v of list) {
      if (Math.hypot(v.x - x, v.z - z) > R + v.length * 0.4) continue;
      v.speed = 0; v.fear = 2;
    }
    for (const d of g.future.drones.list) {
      if (!d.alive || Math.hypot(d.x - x, d.z - z) > R * 1.5 || d.y - ground > 30) continue;
      g.future.drones.knock(d, 0, -20, 0);
    }
    for (const a of g.peds.neighbours(x, z, R, this.nb)) {
      if (a === by || !a.alive || a.inside || a.state === PState.Down) continue;
      a.fear = 2; a.fearX = x; a.fearZ = z; a.state = PState.Flee; a.stateT = 0;
    }
    g.stimuli.emit('gunfire', x, y, z, 3, 60);
  }

  /** A cone of wind from the caster: shoves the player and the people in it. */
  private gust(by: PedAgent, ux: number, uz: number): void {
    const g = this.g, P = VILLAIN_POWERS.gust, p = g.player, fx = g.elements.fx;
    const inCone = (x: number, z: number) => {
      const vx = x - by.x, vz = z - by.z, d = Math.hypot(vx, vz);
      return d < P.max + 1 && d > 0.2 && (vx * ux + vz * uz) / d > 0.8;
    };
    if (inCone(p.pos.x, p.pos.z) && Math.abs(p.pos.y - by.y) < 3) {
      this.stats.atPlayer++;
      this.hurtPlayer?.(P.dmg, 'power', by.x, by.z);
      const push = 9 / Math.max(1, Math.sqrt(p.k));
      p.vel.x += ux * push; p.vel.z += uz * push; p.vel.y += 2.5 / Math.max(1, Math.sqrt(p.k));
    }
    for (const a of g.peds.neighbours(by.x, by.z, P.max + 1, this.nb)) {
      if (a === by || !a.alive || a.inside || a.state === PState.Down || !inCone(a.x, a.z)) continue;
      g.reactions.knockDown(a, by.x, by.z, 4, 'other');
      this.stats.knocked++;
    }
    g.props.hit(by.x + ux * 4, by.y + 0.8, by.z + uz * 4, 3, ux * 300, 120, uz * 300);
    if (this.near(by.x, by.z)) for (let i = 0; i < 40; i++) {
      const s = 0.5 + Math.random() * P.max, j = (Math.random() - 0.5) * 0.7;
      const vx = ux * Math.cos(j) - uz * Math.sin(j), vz = ux * Math.sin(j) + uz * Math.cos(j);
      // A thick, fast stream of dust and grit, with streaks of air.
      fx.soft(by.x + vx * s * 0.3, by.y + 0.3 + Math.random() * 1.6, by.z + vz * s * 0.3, vx * 16, 0.6, vz * 16, 0.7, 0.35, 1.4, DUST, DUST_END, 0.7, 2, 0);
      if (i % 3 === 0) fx.glow(by.x + vx, by.y + 0.6 + Math.random() * 1.2, by.z + vz, vx * 20, 0, vz * 20, 0.35, 0.12, 0.05, WIND, WIND_END, 0.5, 1.5, 0);
    }
  }

  // ------------------------------------------------------------------ channelled operations

  /** A frame of a hack or a ritual (CrimeWorld.opFx): `share` of the work done, the ones at it. */
  opFx(look: OpLook, x: number, z: number, share: number, workers: readonly PedAgent[]): void {
    if (!this.near(x, z, 300)) return;
    const g = this.g, fx = g.elements.fx, y = g.world.groundHeight(x, z), t = this.time;
    if (look === 'drill') {
      // A thermal lance at the vault door: a white-hot point, a shower of orange sparks, smoke.
      for (const w of workers) {
        const hx = w.x - Math.sin(w.heading) * 0.55, hz = w.z - Math.cos(w.heading) * 0.55, hy = w.y + 0.95;
        fx.glow(hx, hy, hz, 0, 0, 0, 0.06, 0.12 + share * 0.08, 0.08, WHITE, FIRE, 1, 1, 0);
        for (let i = 0; i < 3; i++) fx.glow(hx, hy, hz, (Math.random() - 0.5) * 4, 1 + Math.random() * 3, (Math.random() - 0.5) * 4, 0.5, 0.04, 0.01, FIRE, FIRE_END, 1, 1, -9);
        if (Math.random() < 0.15) fx.soft(hx, hy + 0.3, hz, 0, 0.6, 0, 1.4, 0.3, 1.2, SMOKE, SMOKE_END, 0.35, 0.5, -0.1);
      }
      // The door glowing as the cut goes round.
      const a = t * 0.8;
      fx.glow(x + Math.cos(a) * 0.5, y + 1 + Math.sin(a) * 0.5, z, 0, 0, 0, 0.3, 0.1, 0.05, FIRE, FIRE_END, 0.4 + share * 0.6, 1, 0);
      return;
    }
    if (look === 'riot') {
      // A burning barrel in the middle of the street, sparks and dust where the wreckers hammer.
      for (let i = 0; i < 2; i++) fx.glow(x + (Math.random() - 0.5) * 0.4, y + 0.9, z + (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, 1.6 + Math.random() * 1.5, (Math.random() - 0.5) * 0.4, 0.55, 0.35, 0.12, FIRE, FIRE_END, 0.9, 1.5, 1);
      if (Math.random() < 0.3) fx.soft(x, y + 1.6, z, 0, 1.2, 0, 3, 0.6, 2, SMOKE, SMOKE_END, 0.45, 0.4, -0.05);
      for (const w of workers) {
        if (Math.random() > 0.08) continue;
        const hx = w.x - Math.sin(w.heading) * 0.7, hz = w.z - Math.cos(w.heading) * 0.7;
        g.debris.chipBurst(hx, w.y + 0.6, hz, 4, 2.5, 0, 1, 0, DUST, 0.03, 0.8);
        fx.glow(hx, w.y + 0.6, hz, 0, 1.5, 0, 0.25, 0.05, 0.01, FIRE, FIRE_END, 1, 1, -9);
      }
      return;
    }
    if (look === 'hack') {
      // Sparks and a crackle from the hackers' hands to the robot's port; a cyan glow on it.
      for (const w of workers) {
        const hx = w.x - Math.sin(w.heading) * 0.4, hz = w.z - Math.cos(w.heading) * 0.4;
        if (Math.random() < 0.12 + share * 0.25) this.arc(hx, w.y + 0.85, hz, x, y + 0.55, z, (Math.random() * 1e6) | 0, 0.25 + share * 0.5);
        if (Math.random() < 0.5) fx.glow(hx, w.y + 0.85, hz, (Math.random() - 0.5) * 2, 1 + Math.random(), (Math.random() - 0.5) * 2, 0.35, 0.05, 0.01, HACK, HACK_END, 1, 1, -6);
      }
      fx.glow(x, y + 0.6, z, 0, 0, 0, 0.08, 0.35 + share * 0.5, 0.3, HACK, HACK_END, 0.6, 1, 0);
      // A holo glyph turning above it, rising as the hack goes on.
      const a = t * 3, r = 0.5;
      fx.glow(x + Math.cos(a) * r, y + 1.2 + share * 1.2, z + Math.sin(a) * r, 0, 0.2, 0, 0.4, 0.12, 0.05, HACK, HACK_END, 0.8, 1, 0);
      return;
    }
    const [c0, c1] = RITE[look], R = 2.3 * 0.8;
    // The rune ring on the ground (a flicker of motes along it), and a glyph turning inside it.
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      fx.glow(x + Math.cos(a) * R, y + 0.06, z + Math.sin(a) * R, 0, 0.05, 0, 0.7, 0.24, 0.16, c0, c1, 0.65 + share * 0.35, 1, 0);
    }
    // Six runes on the ring, pulsing in turn, and a spoke of light from each to the centre now and then.
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2, rx = x + Math.cos(a) * R, rz = z + Math.sin(a) * R;
      const pulse = 0.5 + 0.5 * Math.sin(t * 3 - k * 1.05);
      fx.glow(rx, y + 0.1, rz, 0, 0.1, 0, 0.12, 0.45 + 0.35 * pulse, 0.4, c0, c1, 0.6 + 0.4 * pulse, 1, 0);
      if (Math.random() < 0.05 + share * 0.15) fx.seg(rx, y + 0.08, rz, x, y + 0.08, z, 0.08, c0.r * 0.4, c0.g * 0.4, c0.b * 0.4, 0.8 + share, BeamStyle.Laser);
    }
    for (let k = 0; k < 5; k++) {
      const a = t * 1.2 + (k / 5) * Math.PI * 2;
      fx.glow(x + Math.cos(a) * 1.1, y + 0.08, z + Math.sin(a) * 1.1, 0, 0, 0, 0.15, 0.22, 0.2, c0, c1, 0.5 + share * 0.4, 1, 0);
    }
    // A column of the element rising from the centre, taller and brighter as it goes on.
    const n = 1 + Math.round(share * 3);
    for (let i = 0; i < n; i++) {
      const j = 0.35 * (1 - share * 0.5);
      if (look === 'fire') fx.glow(x + (Math.random() - 0.5) * j, y + 0.2, z + (Math.random() - 0.5) * j, 0, 2 + share * 5, 0, 0.5 + share * 0.6, 0.35, 0.1, c0, c1, 0.9, 1.5, 1);
      else fx.glow(x + (Math.random() - 0.5) * j, y + 0.2, z + (Math.random() - 0.5) * j, 0, 1.5 + share * 4, 0, 0.6 + share * 0.7, 0.25, 0.18, c0, c1, 0.8, 1, 0);
    }
    // Glow in the raised hands; a storm crackles from the column to them.
    for (const w of workers) {
      if (Math.random() < 0.4) fx.glow(w.x, w.y + 2.05, w.z, (x - w.x) * 0.3, 0.3, (z - w.z) * 0.3, 0.4, 0.15, 0.05, c0, c1, 0.9, 1, 0);
      if (look === 'storm' && Math.random() < 0.04 + share * 0.08) this.arc(w.x, w.y + 2.05, w.z, x, y + 1.5 + share * 3, z, (Math.random() * 1e6) | 0, 0.5 + share * 0.5);
    }
  }

  /** A completed ritual: a burst of the element from the circle that knocks back whoever stands near (not the circle). */
  ritualBurst(circle: readonly PedAgent[], x: number, z: number, element: 'fire' | 'frost' | 'storm'): void {
    const g = this.g, p = g.player, B = RITE_BURST, y = g.world.groundHeight(x, z);
    const cam = g.renderer.camera.position;
    if (this.near(x, z, 700)) {
      const fx = g.elements.fx, [c0, c1] = RITE[element];
      if (element === 'fire') fireBurst(fx, g.debris, g.dust, x, y + 1, z, 1.1, y, 0.6);
      for (let i = 0; i < 36; i++) {
        const a = (i / 36) * Math.PI * 2;
        fx.glow(x, y + 0.4, z, Math.cos(a) * B.radius * 2.4, 0.4, Math.sin(a) * B.radius * 2.4, 0.45, 0.45, 0.2, c0, c1, 1, 1, 0);
      }
      for (let i = 0; i < 14; i++) fx.glow(x, y + 0.5, z, (Math.random() - 0.5) * 2, 8 + Math.random() * 10, (Math.random() - 0.5) * 2, 1.2, 0.5, 0.2, c0, c1, 1, 1.5, 2);
      if (element === 'frost') fx.decal(DecalKind.Frost, x, y + 0.03, z, 0, 1, 0, B.radius * 1.4, B.radius * 1.4, 0, 30);
      else fx.decal(DecalKind.Scorch, x, y + 0.03, z, 0, 1, 0, B.radius, B.radius, 0, 30);
      if (element === 'storm') for (let i = 0; i < 3; i++) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * 4;
        this.rays.push({ power: 'bolt', ax: x + Math.cos(a) * r, ay: y + 40, az: z + Math.sin(a) * r, bx: x, by: y + 0.5, bz: z, life: 0.35, t: 0, seed: (Math.random() * 1e6) | 0 });
      }
    }
    g.audio.play(element === 'storm' ? 'thunder_near' : element === 'frost' ? 'shrink_whoosh' : 'explosion', x, y + 1, z, 0.9, element === 'fire' ? 0.8 : 0.9, 40, cam);
    const pd = Math.hypot(p.pos.x - x, p.pos.z - z);
    if (pd < B.radius && Math.abs(p.pos.y - y) < 5) {
      this.stats.atPlayer++;
      this.hurtPlayer?.(B.dmg * (1 - 0.5 * pd / B.radius), 'power', x, z);
      if (element === 'frost') { p.chillT = Math.max(p.chillT, CASTERS.chill); p.chillSpeed = CASTERS.chillSpeed; }
      else if (!p.flying) { const push = 8 / Math.max(1, Math.sqrt(p.k)), l = pd || 1; p.vel.x += ((p.pos.x - x) / l) * push; p.vel.z += ((p.pos.z - z) / l) * push; p.vel.y += 3 / Math.max(1, Math.sqrt(p.k)); }
      g.camRig.addShake(0.3);
    }
    for (const a of g.peds.neighbours(x, z, B.radius, this.nb)) {
      if (circle.includes(a) || !a.alive || a.inside || a.state === PState.Down) continue;
      const f = 1 - Math.hypot(a.x - x, a.z - z) / B.radius;
      if (f <= 0) continue;
      g.reactions.knockDown(a, x, z, 2 + B.knock * f, 'other');
      this.stats.knocked++;
    }
    g.props.hit(x, y + 1, z, B.radius * 0.6, 0, 400, 0);
    g.stimuli.emit('gunfire', x, y + 1, z, 4, 90);
  }

  update(dt: number): void {
    this.time += dt;
    if (!this.orbs.length && !this.cracks.length && !this.rays.length && !this.clouds.length) return;
    this.updateRays(dt);
    this.updateOrbs(dt);
    this.updateCracks(dt);
    this.updateClouds(dt);
  }

  private updateRays(dt: number): void {
    const fx = this.g.elements.fx;
    for (let i = this.rays.length - 1; i >= 0; i--) {
      const r = this.rays[i];
      r.t += dt;
      if (r.t >= r.life) { this.rays.splice(i, 1); continue; }
      const fade = 1 - r.t / r.life;
      if (r.power === 'frost') {
        fx.seg(r.ax, r.ay, r.az, r.bx, r.by, r.bz, 0.22, 0.6, 0.85, 1.3, 2.2 * fade, BeamStyle.Laser);
        if (Math.random() < 0.8) { const u = Math.random(); fx.glow(r.ax + (r.bx - r.ax) * u, r.ay + (r.by - r.ay) * u, r.az + (r.bz - r.az) * u, (Math.random() - 0.5), -0.5, (Math.random() - 0.5), 0.5, 0.12, 0.04, ICE, ICE_END, 0.9, 1, -2); }
      } else this.arc(r.ax, r.ay, r.az, r.bx, r.by, r.bz, r.seed + Math.floor(r.t * 30), fade);
    }
  }

  /** A jagged lightning arc (the hero's chain lightning look). */
  private arc(ax: number, ay: number, az: number, bx: number, by: number, bz: number, seed: number, I: number): void {
    const fx = this.g.elements.fx;
    const L = Math.hypot(bx - ax, by - ay, bz - az);
    const n = Math.max(4, Math.min(14, Math.round(L / 1.3)));
    const amp = Math.min(1.6, L * 0.08);
    let px = ax, py = ay, pz = az, rs = seed;
    const rnd = () => { rs = (rs * 9301 + 49297) % 233280; return rs / 233280 - 0.5; };
    for (let i = 1; i <= n; i++) {
      const u = i / n, e = i === n ? 0 : amp * Math.sin(u * Math.PI);
      const x = ax + (bx - ax) * u + rnd() * e, y = ay + (by - ay) * u + rnd() * e, z = az + (bz - az) * u + rnd() * e;
      fx.seg(px, py, pz, x, y, z, 0.3, 0.55, 0.7, 1.4, I * 1.8, BeamStyle.Bolt);
      px = x; py = y; pz = z;
    }
  }

  private updateOrbs(dt: number): void {
    const g = this.g, fx = g.elements.fx, p = g.player;
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const o = this.orbs[i];
      if (o.t < o.T) {
        o.t += dt;
        const u = Math.min(1, o.t / o.T);
        o.x = o.ax + (o.bx - o.ax) * u; o.z = o.az + (o.bz - o.az) * u;
        o.y = o.ay + (o.by - o.ay) * u + o.arc * 4 * u * (1 - u);
        this.casting.set(o.by_, this.time);
        if (o.kind === 'fire') {
          if (this.near(o.x, o.z)) {
            fx.glow(o.x, o.y, o.z, 0, 0, 0, 0.08, 0.7, 0.5, FIRE, FIRE_END, 1, 1, 0);
            for (let k = 0; k < 3; k++) fx.glow(o.x, o.y, o.z, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2 + 0.5, (Math.random() - 0.5) * 2, 0.3, 0.45, 0.15, FIRE, FIRE_END, 0.9, 1.5, 1);
          }
          // Straight into the hero on the way: it bursts there.
          const hit = Math.hypot(p.pos.x - o.x, p.pos.z - o.z) < 1.1 && o.y > p.pos.y - 0.2 && o.y < p.pos.y + p.height + 0.2;
          if (u >= 1 || hit) { this.orbs.splice(i, 1); this.fireBurst(o); }
        } else {
          if (this.near(o.x, o.z)) fx.glow(o.x, o.y + 0.08, o.z, (Math.random() - 0.5), 1, (Math.random() - 0.5), 0.15, 0.08, 0.02, WHITE, WHITE_END, 1, 1, -4);
        }
        continue;
      }
      // A stun grenade on its fuse, then the flash.
      o.fuse -= dt;
      if (this.near(o.x, o.z) && Math.random() < 0.6) fx.glow(o.x, o.y + 0.1, o.z, (Math.random() - 0.5) * 1.5, 1.5, (Math.random() - 0.5) * 1.5, 0.15, 0.07, 0.02, WHITE, WHITE_END, 1, 1, -5);
      if (o.fuse <= 0) { this.orbs.splice(i, 1); this.flash(o); }
    }
  }

  private fireBurst(o: Orb): void {
    const g = this.g, P = VILLAIN_POWERS.fireball, R = P.radius, p = g.player;
    const ground = g.world.groundHeight(o.x, o.z);
    if (this.near(o.x, o.z, 700)) fireBurst(g.elements.fx, g.debris, g.dust, o.x, o.y, o.z, 0.85, ground, 0.5);
    g.audio.play('explosion', o.x, o.y, o.z, 0.7, 1.25, 25, g.renderer.camera.position);
    const pd = Math.hypot(p.pos.x - o.x, p.pos.z - o.z);
    if (pd < R && o.y > p.pos.y - 1.5 && o.y < p.pos.y + p.height + 1.5) {
      this.stats.atPlayer++;
      this.hurtPlayer?.(P.dmg * (1 - 0.6 * pd / R), 'power', o.x, o.z);
    }
    for (const a of g.peds.neighbours(o.x, o.z, R, this.nb)) {
      if (a === o.by_ || !a.alive || a.inside || a.state === PState.Down || Math.abs(a.y - o.y) > R) continue;
      const f = 1 - Math.hypot(a.x - o.x, a.z - o.z) / R;
      if (f <= 0) continue;
      g.reactions.knockDown(a, o.x, o.z, 2 + 6 * f, 'other');
      this.stats.knocked++;
      if (f > 0.5) g.elements.ignite({ kind: 'person', obj: a }, 1.5 + 2 * f);
    }
    g.props.hit(o.x, o.y, o.z, R * 0.7, 0, 500, 0);
    g.stimuli.emit('gunfire', o.x, o.y, o.z, 4, 90);
  }

  private flash(o: Orb): void {
    const g = this.g, P = VILLAIN_POWERS.stun, R = P.radius, p = g.player;
    if (this.near(o.x, o.z, 600)) {
      const fx = g.elements.fx;
      for (let i = 0; i < 3; i++) fx.glow(o.x, o.y + 0.5, o.z, 0, 0, 0, 0.12 + i * 0.05, 1.5, 5.5, WHITE, WHITE_END, 1, 1, 0);
      for (let i = 0; i < 6; i++) fx.soft(o.x, o.y + 0.3, o.z, (Math.random() - 0.5) * 3, 1 + Math.random(), (Math.random() - 0.5) * 3, 2, 0.6, 2.2, SMOKE, SMOKE_END, 0.4, 0.8, -0.4);
    }
    g.audio.play('explosion', o.x, o.y, o.z, 0.55, VILLAIN_POWERS.stun.pitch ?? 1.9, 20, g.renderer.camera.position);
    const pd = Math.hypot(p.pos.x - o.x, p.pos.z - o.z);
    if (pd < R + p.height * 0.1 && Math.abs(p.pos.y - o.y) < 4) {
      this.stats.atPlayer++;
      this.hurtPlayer?.(P.dmg, 'power', o.x, o.z);
      if (!p.flying) p.downT = Math.max(p.downT, CASTERS.stunDown * (1 - 0.5 * pd / R));
      g.camRig.addShake(0.25);
    }
    for (const a of g.peds.neighbours(o.x, o.z, R, this.nb)) {
      if (a === o.by_ || !a.alive || a.inside || a.state === PState.Down) continue;
      a.fear = 2; a.fearX = o.x; a.fearZ = o.z; a.state = PState.Flee; a.stateT = 0;
    }
    g.stimuli.emit('gunfire', o.x, o.y, o.z, 4, 70);
  }

  private updateCracks(dt: number): void {
    const g = this.g, fx = g.elements.fx, p = g.player, P = VILLAIN_POWERS.quake;
    for (let i = this.cracks.length - 1; i >= 0; i--) {
      const k = this.cracks[i];
      const s0 = k.s;
      k.s = Math.min(k.L, k.s + CASTERS.crackSpeed * dt);
      const x0 = k.ax + k.dx * s0, z0 = k.az + k.dz * s0, x1 = k.ax + k.dx * k.s, z1 = k.az + k.dz * k.s;
      const y1 = g.world.groundHeight(x1, z1);
      if (this.near(x1, z1)) {
        fx.decal(DecalKind.Crack, (x0 + x1) / 2, y1 + 0.03, (z0 + z1) / 2, 0, 1, 0, Math.max(0.5, k.s - s0) * 1.3, 0.9, Math.atan2(k.dx, k.dz), 25);
        for (let n = 0; n < 2; n++) fx.soft(x1 + (Math.random() - 0.5), y1 + 0.2, z1 + (Math.random() - 0.5), (Math.random() - 0.5) * 2, 2 + Math.random() * 2, (Math.random() - 0.5) * 2, 0.9, 0.4, 1.3, DUST, DUST_END, 0.55, 1.5, -3);
        g.debris.chipBurst(x1, y1 + 0.1, z1, 2, 3, 0, 1, 0, DUST, 0.04, 1.2);
      }
      // The front passes the hero (on the ground): down they go.
      if (!k.hitPlayer && !p.flying && Math.abs(p.pos.y - y1) < 1.2 && segDist(p.pos.x, p.pos.z, x0, z0, x1, z1) < P.radius) {
        k.hitPlayer = true;
        this.stats.atPlayer++;
        this.hurtPlayer?.(P.dmg, 'power', x1, z1);
        p.downT = Math.max(p.downT, 1.1);
        g.camRig.addShake(0.35);
      }
      for (const a of g.peds.neighbours(x1, z1, P.radius + 0.5, this.nb)) {
        if (a === k.by_ || k.hit.has(a) || !a.alive || a.inside || a.state === PState.Down) continue;
        k.hit.add(a);
        g.reactions.knockDown(a, x0, z0, 3, 'other');
        this.stats.knocked++;
      }
      if (k.s >= k.L) this.cracks.splice(i, 1);
    }
  }

  private updateClouds(dt: number): void {
    const fx = this.g.elements.fx, R = VILLAIN_POWERS.smoke.radius;
    for (let i = this.clouds.length - 1; i >= 0; i--) {
      const c = this.clouds[i];
      c.t += dt;
      if (c.t > 3) { this.clouds.splice(i, 1); continue; }
      if (!this.near(c.x, c.z)) continue;
      // Billowing out for three seconds; each puff hangs for a while.
      const n = c.t < 0.4 ? 6 : 2;
      for (let k = 0; k < n; k++) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * R * 0.5;
        fx.soft(c.x + Math.sin(a) * r, c.y + 0.3 + Math.random() * 1.5, c.z + Math.cos(a) * r, Math.sin(a) * 1.4, 0.3 + Math.random() * 0.4, Math.cos(a) * 1.4, 5 + Math.random() * 2, 1.4, 3.6, SMOKE, SMOKE_END, 0.75, 0.5, -0.05);
      }
    }
  }
}
