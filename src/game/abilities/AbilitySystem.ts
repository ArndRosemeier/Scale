/**
 * Runs the player's powers: applies ranks to the existing mechanics (Player flight, size and
 * super speed, Interactions punch and blast), owns the energy pool and cooldowns, and routes
 * input — digits 1–9, 0 trigger (and select) hotbar slots, Space drives the super jump, F toggles flight.
 *
 * Trigger kinds: tap powers go off on the press (cooldown, energy); held powers (laser eyes,
 * ice path, hydrokinesis) run while the key or button is held and drain energy per second;
 * super speed is a toggle on foot (a press in flight dashes). The super jump takes off on the
 * press and keeps climbing while Space is held, up to the rank's height.
 *
 * Call order per frame: `preUpdate` before Player.update (gates Space / F, sets the running
 * speed), `postUpdate` after the in-world panels had their look at the digit keys. The
 * elemental effects themselves run in Elements (it reads `channel`).
 */
import * as THREE from 'three';
import type { Player } from '../../player/Player';
import type { Interactions } from '../Interactions';
import type { Input } from '../Input';
import type { Progress } from './Progress';
import { ABILITY, HOTBAR_SLOTS, type AbilityId } from './defs';
import {
  ENERGY, PUNCH_IMPULSE, SMASH_MUL, JUMP_HEIGHT, JUMP, DASH, DASH_DIST, DASH_COOLDOWN, SHOCK_IMPULSE, SHOCK_RANGE,
  SHOCK_COST, SHOCK_COOLDOWN, FLIGHT_SPEED, FLIGHT_BOOST_MUL, SIZE_RANGE, SPEED_TOP, LASER, ICE, HYDRO, FIRE, FIRE_COOLDOWN, FIREBALL, FIREBALL_COOLDOWN, NOVA, NOVA_COOLDOWN,
  BOLT, BOLT_COOLDOWN, QUAKE, QUAKE_COOLDOWN, GUST, GUST_COOLDOWN, SHRINK, SHRINK_COOLDOWN, GIANT, sizeUpkeep,
} from './tuning';

export interface AbilityHooks {
  sound?: (id: string, gain: number, pitch: number) => void;
  /** Feedback for a failed use (locked, no energy, cooldown). */
  deny?: (msg: string) => void;
  /** A dash starts: direction (unit), duration (s) and rank (trail, whoosh, camera kick, shoves). */
  dashFx?: (dx: number, dy: number, dz: number, dur: number, rank: number) => void;
  /** Super jump take-off with charge strength 0..1. */
  leapFx?: (strength: number) => void;
}

/** The elemental layer: tap powers go off through it (true: it went off). */
export interface PowerEffects {
  fire(id: AbilityId, rank: number): boolean;
  /** The held power did nothing last frame (a target out of sight / reach): no energy for it. */
  readonly idle?: boolean;
}

const DIGITS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];
const NUMPAD = ['Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5', 'Numpad6', 'Numpad7', 'Numpad8', 'Numpad9', 'Numpad0'];

/** Tap powers of the elemental layer: energy and cooldown by rank. */
const TAP: Partial<Record<AbilityId, { cost: number; cd: number[] }>> = {
  fireWave: { cost: FIRE.cost, cd: FIRE_COOLDOWN },
  fireball: { cost: FIREBALL.cost, cd: FIREBALL_COOLDOWN },
  frostNova: { cost: NOVA.cost, cd: NOVA_COOLDOWN },
  lightning: { cost: BOLT.cost, cd: BOLT_COOLDOWN },
  stomp: { cost: QUAKE.cost, cd: QUAKE_COOLDOWN },
  gust: { cost: GUST.cost, cd: GUST_COOLDOWN },
  shrink: { cost: SHRINK.cost, cd: SHRINK_COOLDOWN },
};

/** Held powers: energy per second (super speed runs for free, like flight). */
const DRAIN: Partial<Record<AbilityId, number>> = { laser: LASER.drain, icePath: ICE.drain, hydro: HYDRO.drain };

export class AbilitySystem {
  energy = 0;
  selected = 0;
  /** Cooldown left per ability (s) and its full length (for the HUD sweep). */
  readonly cooldown = new Map<AbilityId, { left: number; full: number }>();
  /** Super jump climb 0..1 (share of the rank's height gained) while Space is held (-1: not climbing). */
  charge = -1;
  private chargeSrc: string | null = null;
  /** The climbing super jump: take-off height, highest point allowed, height paid for, seconds. */
  private ascent = { y0: 0, top: 0, paid: 0, t: 0, lastY: 0 };
  /** Super speed switched on (a toggle; it runs on foot, flight ignores it). */
  speedOn = false;
  /** The held power this frame (laser, ice path, hydrokinesis): id, rank, seconds held. */
  channel: { id: AbilityId; rank: number; t: number } | null = null;
  private channelSrc: string | null = null;
  hooks: AbilityHooks = {};
  /** The elemental layer (set by the game). */
  effects: PowerEffects | null = null;
  /** Tap powers the game runs itself (the slime call): energy, cooldowns and a handler (true: it went off). */
  special: Partial<Record<AbilityId, { cost: number; cd: number[]; run: (rank: number) => boolean }>> = {};
  /** Input disabled (UI open, free camera). */
  enabled = true;
  /** Out of energy as a giant: the body shrinks back to GIANT.fallback and stays capped there until
   *  the pool is back to GIANT.recover of max. */
  exhausted = false;
  /** Net energy change per second from regeneration and size upkeep last frame (for the HUD). */
  energyRate = 0;

  constructor(readonly progress: Progress, readonly player: Player, private interactions: Interactions, private cam: THREE.Camera) {
    this.energy = this.maxEnergy;
  }

  get maxEnergy(): number { return this.progress.sandbox ? ENERGY.sandboxMax : ENERGY.max + this.progress.bonusMax; }
  get regen(): number { return this.progress.sandbox ? ENERGY.sandboxRegen : ENERGY.regen + this.progress.bonusRegen; }
  rank(id: AbilityId): number { return this.progress.rank(id); }

  /** Is this power in use right now (held, running, flying, charging)? For the HUD. */
  active(id: AbilityId): boolean {
    if (this.channel?.id === id) return true;
    return (id === 'flight' && this.player.flying) || (id === 'superJump' && this.charge >= 0) || (id === 'speed' && this.speedOn);
  }

  /** Before Player.update: apply ranks to the mechanics and take over Space / F where needed. */
  preUpdate(dt: number, input: Input): void {
    const p = this.player, i = this.interactions;
    const rs = this.rank('strength'), rz = this.rank('size'), rf = this.rank('flight');
    i.punchImpulse = PUNCH_IMPULSE[rs];
    i.smashMul = SMASH_MUL[rs];
    i.debugBlast = this.progress.sandbox;
    p.flightAllowed = rf > 0;
    p.flightSpeed = FLIGHT_SPEED[rf] || 1;
    p.flightBoost = FLIGHT_BOOST_MUL[rf] || FLIGHT_BOOST_MUL[FLIGHT_BOOST_MUL.length - 1];
    [p.minHeight, p.maxHeight] = SIZE_RANGE[rz];
    for (const [id, c] of this.cooldown) { c.left -= dt; if (c.left <= 0) this.cooldown.delete(id); }
    this.updateEnergy(dt);
    // F without flight: a hint instead of nothing.
    if (input.hit('KeyF') && rf === 0 && this.enabled) this.hooks.deny?.('Flight is locked — press P to see your powers');
    // Super jump on Space: takes off on the press, climbs while held.
    const sj = this.rank('superJump') > 0;
    p.jumpOnSpace = !sj;
    if (this.rank('speed') <= 0) this.speedOn = false;
    if (!this.enabled) { this.cancelCharge(); this.endChannel(); p.speedTop = 0; return; }
    if (sj && !p.flying && input.hit('Space') && p.grounded && this.charge < 0) this.beginCharge('Space');
    this.updateCharge(dt, input);
    this.updateChannel(dt, input);
    p.speedTop = this.speedOn && !p.flying ? SPEED_TOP[this.rank('speed')] : 0;
  }

  /** Regeneration (none in flight) minus the upkeep of a giant body; an empty pool shrinks a giant. */
  private updateEnergy(dt: number): void {
    const p = this.player;
    if (this.progress.sandbox || p.sizeOverride) {
      this.exhausted = false;
      this.energyRate = this.regen;
      this.energy = Math.min(this.maxEnergy, this.energy + this.regen * dt);
      return;
    }
    // Exhausted, the body pays only part of its upkeep, so a giant back at 10 m (which otherwise
    // just holds even) refills to GIANT.recover instead of sitting at zero.
    const gain = (p.flying ? 0 : this.regen) - sizeUpkeep(p.height) * (this.exhausted ? GIANT.exhaustedUpkeep : 1);
    this.energyRate = gain;
    this.energy = Math.max(0, Math.min(this.maxEnergy, this.energy + gain * dt));
    if (!this.exhausted && this.energy <= 0 && p.height > GIANT.fallback && gain < 0) {
      this.exhausted = true;
      this.hooks.deny?.('Out of energy — you shrink back');
    }
    if (this.exhausted && this.energy >= this.maxEnergy * GIANT.recover) this.exhausted = false;
    if (this.exhausted) {
      // Shrink smoothly (not a snap) and keep the size cap at the current height on the way down.
      if (p.height > GIANT.fallback) {
        p.height = Math.max(GIANT.fallback, p.height * Math.exp(-GIANT.shrinkRate * dt));
        p.events.onSizeChange?.(p.height, -1);
      }
      p.maxHeight = Math.min(p.maxHeight, Math.max(GIANT.fallback, p.height));
    }
  }

  /** After the panels consumed their digits: hotbar keys. */
  postUpdate(input: Input): void {
    if (!this.enabled) return;
    for (let s = 0; s < HOTBAR_SLOTS; s++) {
      const src = input.hit(DIGITS[s]) ? DIGITS[s] : input.hit(NUMPAD[s]) ? NUMPAD[s] : null;
      if (!src) continue;
      this.selected = s;
      this.press(s, src);
    }
  }

  /** A hotbar slot clicked or touched (held powers run until the button or finger is released). */
  click(slot: number): void {
    if (!this.enabled) return;
    this.selected = slot;
    this.slotHeld = true;
    const up = () => { this.slotHeld = false; window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    this.press(slot, 'Mouse0');
  }
  private slotHeld = false;

  private isHeld(src: string, input: Input): boolean {
    return src === 'Mouse0' ? this.slotHeld : input.down(src);
  }

  private press(slot: number, src: string): void {
    const id = this.progress.slots[slot];
    if (!id) return;
    if (!this.progress.unlocked(id)) { this.hooks.deny?.(`${ABILITY[id].name} is locked`); return; }
    if (id === 'superJump') {
      if (this.player.flying) return;
      if (!this.player.grounded) return;
      this.beginCharge(src);
      return;
    }
    if (id === 'speed' && !this.player.flying) { this.speedOn = !this.speedOn; return; }
    if (ABILITY[id].trigger === 'hold') { this.beginChannel(id, src); return; }
    this.use(id);
  }

  /** Use an active power now (tap / toggle). */
  use(id: AbilityId): boolean {
    const r = this.rank(id);
    if (r <= 0) return false;
    const cd = this.cooldown.get(id);
    if (cd) { this.hooks.deny?.(`${ABILITY[id].name} is recharging`); return false; }
    const p = this.player;
    switch (id) {
      case 'flight':
        p.toggleFlight();
        return true;
      case 'punch':
        return this.interactions.punch();
      case 'speed':
        return this.dash(r);
      case 'shockwave': {
        if (this.energy < SHOCK_COST[r]) { this.hooks.deny?.('Not enough energy'); return false; }
        if (!this.interactions.blastAtView(SHOCK_RANGE[r] * Math.max(1, Math.sqrt(p.k)), SHOCK_IMPULSE[r], true)) return false;
        this.energy -= SHOCK_COST[r];
        this.startCooldown(id, SHOCK_COOLDOWN[r]);
        p.action = { id: 'cast_forward', t0: p.animClock, dur: 0.6 };
        return true;
      }
      default: {
        const sp = this.special[id];
        if (sp) {
          if (this.energy < sp.cost) { this.hooks.deny?.('Not enough energy'); return false; }
          if (!sp.run(r)) return false;
          this.energy -= sp.cost;
          this.startCooldown(id, sp.cd[r] ?? sp.cd[sp.cd.length - 1]);
          return true;
        }
        const tap = TAP[id];
        if (!tap || !this.effects) return false;
        if (this.energy < tap.cost) { this.hooks.deny?.('Not enough energy'); return false; }
        if (!this.effects.fire(id, r)) return false;
        this.energy -= tap.cost;
        this.startCooldown(id, tap.cd[r]);
        return true;
      }
    }
  }

  /** Super speed pressed in flight: a dash burst where you look. */
  private dash(r: number): boolean {
    if (this.cooldown.get('speed')) { this.hooks.deny?.('Dash is recharging'); return false; }
    if (!this.spend(DASH.cost)) return false;
    const p = this.player;
    const dir = new THREE.Vector3();
    this.cam.getWorldDirection(dir);
    if (!p.flying) { dir.y = 0; if (dir.lengthSq() < 1e-6) dir.set(-Math.sin(p.yaw), 0, -Math.cos(p.yaw)); }
    dir.normalize();
    // Distance ∝ size, duration ∝ √size (like every motion of the body): a giant's dash
    // covers as many body lengths, in its own slow motion, instead of teleporting.
    const k = p.k, dur = DASH.time * Math.max(0.6, Math.sqrt(k));
    p.dash(dir.x, dir.y, dir.z, (DASH_DIST[r] * k) / dur, dur);
    this.startCooldown('speed', DASH_COOLDOWN[r]);
    this.hooks.dashFx?.(dir.x, p.flying ? dir.y : 0, dir.z, dur, r);
    return true;
  }

  private spend(cost: number): boolean {
    if (this.energy < cost) { this.hooks.deny?.('Not enough energy'); return false; }
    this.energy -= cost;
    return true;
  }

  private startCooldown(id: AbilityId, s: number): void {
    if (this.progress.sandbox) s *= 0.25;
    if (s > 0) this.cooldown.set(id, { left: s, full: s });
  }

  // ---- held powers
  private beginChannel(id: AbilityId, src: string): void {
    if (this.channel) this.endChannel();
    const drain = DRAIN[id] ?? 0;
    if (drain > 0 && this.energy < drain * 0.25) { this.hooks.deny?.('Not enough energy'); return; }
    this.channel = { id, rank: this.rank(id), t: 0 };
    this.channelSrc = src;
  }

  private endChannel(): void {
    this.channel = null;
    this.channelSrc = null;
  }

  private updateChannel(dt: number, input: Input): void {
    const c = this.channel;
    if (!c || !this.channelSrc) return;
    if (!this.isHeld(this.channelSrc, input) || this.rank(c.id) <= 0) { this.endChannel(); return; }
    c.t += dt;
    c.rank = this.rank(c.id);
    const drain = DRAIN[c.id] ?? 0;
    if (drain > 0 && !this.effects?.idle) {
      if (this.energy < drain * dt) { this.hooks.deny?.('Out of energy'); this.channel = null; this.channelSrc = null; return; }
      this.energy -= drain * dt;
    }
  }

  // ---- super jump: take off on the press, climb while held
  private beginCharge(src: string): void {
    const p = this.player, r = this.rank('superJump');
    if (this.cooldown.get('superJump') || p.seat || p.downT > 0 || p.ragdoll || p.puppet) return;
    const normalH = (p.jumpSpeed * p.jumpSpeed) / (2 * 9.81);
    const a = this.ascent;
    a.y0 = a.lastY = p.pos.y;
    a.top = p.pos.y + Math.max(normalH, JUMP_HEIGHT[r] * p.k);
    a.paid = 0;
    a.t = 0;
    this.charge = 0;
    this.chargeSrc = src;
    p.superLaunch(p.jumpSpeed, 0.05);
    this.startCooldown('superJump', JUMP.cooldown);
    this.hooks.sound?.('whoosh_takeoff', 0.4, 1.15);
    this.hooks.leapFx?.(0.35);
  }

  private cancelCharge(): void {
    this.charge = -1;
    this.chargeSrc = null;
    this.player.jumpCharge = -1;
  }

  /**
   * While Space is held the body climbs (full height in about a second and a half, at any rank)
   * and eases off near the top so the arc peaks at the rank's height; on release the climb is cut
   * to a short coast, so the height is where one lets go. Energy is paid for the height gained
   * (JUMP.cost for the full height).
   */
  private updateCharge(dt: number, input: Input): void {
    if (this.charge < 0 || !this.chargeSrc) return;
    const p = this.player, a = this.ascent, g = 9.81;
    if (p.flying) { this.cancelCharge(); return; }
    const sk = Math.sqrt(p.k);
    if (!this.isHeld(this.chargeSrc, input)) { p.vel.y = Math.min(p.vel.y, 5 * sk); this.cancelCharge(); return; }
    a.t += dt;
    // Landed again (a ceiling, a low roof) or stuck under one: the climb is over.
    if ((p.grounded && a.t > 0.1) || (a.t > 0.15 && p.pos.y - a.lastY < 1e-3 && p.vel.y <= 0.01)) { this.cancelCharge(); return; }
    a.lastY = p.pos.y;
    const span = a.top - a.y0, gained = Math.max(0, p.pos.y - a.y0);
    // Pay for the height gained so far.
    const owe = JUMP.cost * Math.min(1, gained / span) - a.paid;
    if (owe > 0) {
      if (this.energy < owe) { this.hooks.deny?.('Not enough energy'); this.cancelCharge(); return; }
      this.energy -= owe;
      a.paid += owe;
    }
    const vUp = Math.max(8 * sk, span / 1.2);
    const vCap = Math.min(vUp, Math.sqrt(2 * g * Math.max(0, a.top - p.pos.y)));
    // Thrust against gravity (Player.update subtracts g·dt afterwards).
    if (p.vel.y < vCap) p.vel.y = Math.min(vCap + g * dt, p.vel.y + (vUp / 0.3 + g) * dt);
    p.grounded = false;
    this.charge = Math.min(1, gained / span);
    p.leap = Math.max(p.leap, 0.05, this.charge);
  }
}
