/**
 * Runs the player's powers: applies ranks to the existing mechanics (Player flight and
 * size, Interactions punch and blast), owns the energy pool and cooldowns, and routes
 * input — digits 1–8 trigger (and select) hotbar slots, right mouse uses the selected
 * slot, Space charges the super jump, F toggles flight.
 *
 * Call order per frame: `preUpdate` before Player.update (gates Space / F), `postUpdate`
 * after the in-world panels had their look at the digit keys.
 */
import * as THREE from 'three';
import type { Player } from '../../player/Player';
import type { Interactions } from '../Interactions';
import type { Input } from '../Input';
import type { Progress } from './Progress';
import { ABILITY, HOTBAR_SLOTS, type AbilityId } from './defs';
import {
  ENERGY, PUNCH_IMPULSE, SMASH_MUL, JUMP_HEIGHT, JUMP, DASH, DASH_DIST, DASH_COOLDOWN, SHOCK_IMPULSE, SHOCK_RANGE,
  SHOCK_COST, SHOCK_COOLDOWN, FLIGHT_SPEED, SIZE_RANGE,
} from './tuning';

export interface AbilityHooks {
  sound?: (id: string, gain: number, pitch: number) => void;
  /** Feedback for a failed use (locked, no energy, cooldown). */
  deny?: (msg: string) => void;
  dashFx?: (x: number, y: number, z: number) => void;
}

const DIGITS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8'];

export class AbilitySystem {
  energy = 0;
  selected = 0;
  /** Cooldown left per ability (s) and its full length (for the HUD sweep). */
  readonly cooldown = new Map<AbilityId, { left: number; full: number }>();
  /** Super jump charge 0..1 while held (-1: not charging). */
  charge = -1;
  private chargeT = 0;
  private chargeSrc: string | null = null;
  private slotHeld: string | null = null;
  hooks: AbilityHooks = {};
  /** Input disabled (UI open, free camera). */
  enabled = true;

  constructor(readonly progress: Progress, readonly player: Player, private interactions: Interactions, private cam: THREE.Camera) {
    this.energy = this.maxEnergy;
  }

  get maxEnergy(): number { return this.progress.sandbox ? ENERGY.sandboxMax : ENERGY.max + this.progress.bonusMax; }
  get regen(): number { return this.progress.sandbox ? ENERGY.sandboxRegen : ENERGY.regen + this.progress.bonusRegen; }
  rank(id: AbilityId): number { return this.progress.rank(id); }

  /** Before Player.update: apply ranks to the mechanics and take over Space / F where needed. */
  preUpdate(dt: number, input: Input): void {
    const p = this.player, i = this.interactions;
    const rs = this.rank('strength'), rz = this.rank('size'), rf = this.rank('flight');
    i.punchImpulse = PUNCH_IMPULSE[rs];
    i.smashMul = SMASH_MUL[rs];
    i.debugBlast = this.progress.sandbox;
    p.flightAllowed = rf > 0;
    p.flightSpeed = FLIGHT_SPEED[rf] || 1;
    [p.minHeight, p.maxHeight] = SIZE_RANGE[rz];
    for (const [id, c] of this.cooldown) { c.left -= dt; if (c.left <= 0) this.cooldown.delete(id); }
    this.energy = Math.min(this.maxEnergy, this.energy + this.regen * dt);
    // F without flight: a hint instead of nothing.
    if (input.hit('KeyF') && rf === 0 && this.enabled) this.hooks.deny?.('Flight is locked — press P to see your powers');
    // Super jump on Space: tap = normal jump, hold = charge.
    const sj = this.rank('superJump') > 0;
    p.jumpOnSpace = !sj;
    if (!this.enabled) { this.cancelCharge(); return; }
    if (sj && !p.flying) {
      if (input.hit('Space') && p.grounded && this.charge < 0) this.beginCharge('Space');
    }
    this.updateCharge(dt, input);
  }

  /** After the panels consumed their digits: hotbar keys and right mouse. */
  postUpdate(input: Input): void {
    if (!this.enabled) return;
    for (let s = 0; s < HOTBAR_SLOTS; s++) {
      if (!input.hit(DIGITS[s]) && !input.hit(`Numpad${s + 1}`)) continue;
      this.selected = s;
      this.press(s, input.hit(DIGITS[s]) ? DIGITS[s] : `Numpad${s + 1}`);
    }
    if (input.clicked & 4) this.press(this.selected, 'Mouse2');
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
      case 'dash': {
        if (!this.spend(DASH.cost, id)) return false;
        const dir = new THREE.Vector3();
        this.cam.getWorldDirection(dir);
        if (!p.flying) { dir.y = 0; if (dir.lengthSq() < 1e-6) dir.set(-Math.sin(p.yaw), 0, -Math.cos(p.yaw)); }
        dir.normalize();
        const k = p.k;
        p.dash(dir.x, dir.y, dir.z, (DASH_DIST[r] * k) / DASH.time, DASH.time);
        this.startCooldown(id, DASH_COOLDOWN[r]);
        this.hooks.sound?.('whoosh_takeoff', 0.6, 1.5);
        this.hooks.dashFx?.(p.pos.x, p.pos.y, p.pos.z);
        return true;
      }
      case 'shockwave': {
        if (this.energy < SHOCK_COST[r]) { this.hooks.deny?.('Not enough energy'); return false; }
        if (!this.interactions.blastAtView(SHOCK_RANGE[r] * Math.max(1, Math.sqrt(p.k)), SHOCK_IMPULSE[r], true)) return false;
        this.energy -= SHOCK_COST[r];
        this.startCooldown(id, SHOCK_COOLDOWN[r]);
        p.action = { id: 'cast_forward', t0: p.animClock, dur: 0.6 };
        return true;
      }
      default:
        return false;
    }
  }

  private spend(cost: number, _id: AbilityId): boolean {
    if (this.energy < cost) { this.hooks.deny?.('Not enough energy'); return false; }
    this.energy -= cost;
    return true;
  }

  private startCooldown(id: AbilityId, s: number): void {
    if (this.progress.sandbox) s *= 0.25;
    if (s > 0) this.cooldown.set(id, { left: s, full: s });
  }

  // ---- super jump charge
  private beginCharge(src: string): void {
    if (this.cooldown.get('superJump')) return;
    this.charge = 0;
    this.chargeT = 0;
    this.chargeSrc = src;
  }

  private cancelCharge(): void {
    this.charge = -1;
    this.chargeSrc = null;
  }

  private updateCharge(dt: number, input: Input): void {
    if (this.charge < 0 || !this.chargeSrc) return;
    const p = this.player;
    if (p.flying) { this.cancelCharge(); return; }
    this.chargeT += dt;
    this.charge = Math.min(1, Math.max(0, (this.chargeT - JUMP.tapTime) / JUMP.chargeTime));
    const held = this.chargeSrc === 'Mouse2' ? (input.buttons & 4) !== 0 : input.down(this.chargeSrc);
    if (held) return;
    // Released: a tap is an ordinary jump; a charge leaps (energy permitting).
    const f = this.charge, t = this.chargeT;
    this.cancelCharge();
    if (!p.grounded) return;
    const r = this.rank('superJump');
    if (t < JUMP.tapTime || f <= 0.02) { p.launch(p.jumpSpeed); return; }
    const cost = JUMP.cost * f;
    if (this.energy < cost) { this.hooks.deny?.('Not enough energy'); p.launch(p.jumpSpeed); return; }
    this.energy -= cost;
    const normalH = (p.jumpSpeed * p.jumpSpeed) / (2 * 9.81);
    const h = normalH + (JUMP_HEIGHT[r] * p.k - normalH) * f;
    p.launch(Math.sqrt(2 * 9.81 * h));
    this.startCooldown('superJump', JUMP.cooldown);
    this.hooks.sound?.('whoosh_takeoff', 0.35 + f * 0.4, 1.2 - f * 0.3);
  }
}
