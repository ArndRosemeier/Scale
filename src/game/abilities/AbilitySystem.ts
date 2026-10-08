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
import type { Target } from '../Targeting';
import { ABILITY, HOTBAR_SLOTS, type AbilityId } from './defs';
import {
  ENERGY, PUNCH_IMPULSE, SMASH_MUL, JUMP_HEIGHT, JUMP, DASH, DASH_DIST, SHOCK_IMPULSE, SHOCK_RANGE,
  SHOCK_COST, FLIGHT_SPEED, FLIGHT_BOOST_MUL, SIZE_RANGE, SPEED_TOP, LASER, ICE, HYDRO, FIRE, FIREBALL, NOVA,
  BOLT, QUAKE, GUST, SHRINK, GIANT, sizeUpkeep, TAP_DEBOUNCE, PHASE, SEEKER, FOCUS, SENSE,
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
  /** A charged power is let go with `charge` 0..1 (true: it went off; false gives the energy back). */
  release?(id: AbilityId, rank: number, charge: number): boolean;
  /** The held power did nothing last frame (a target out of sight / reach): no energy for it. */
  readonly idle?: boolean;
}

const DIGITS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];
const NUMPAD = ['Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5', 'Numpad6', 'Numpad7', 'Numpad8', 'Numpad9', 'Numpad0'];

/** Tap powers of the elemental layer: their energy (they are balanced by cost, not cooldowns). */
const TAP: Partial<Record<AbilityId, number>> = {
  fireWave: FIRE.cost, fireball: FIREBALL.cost, frostNova: NOVA.cost, lightning: BOLT.cost,
  stomp: QUAKE.cost, gust: GUST.cost, shrink: SHRINK.cost, phase: PHASE.cost, seeker: SEEKER.cost,
};

/** Charged powers (held to gather, fired on release): `base` energy on the press, up to `cost` in
 *  all while it gathers for `time` s. */
const CHARGED: Partial<Record<AbilityId, { base: number; cost: number; time: number }>> = {
  focus: { base: FOCUS.base, cost: FOCUS.cost, time: FOCUS.charge },
};

/** Held powers: energy per second (super speed runs for free, like flight). */
const DRAIN: Partial<Record<AbilityId, number>> = { laser: LASER.drain, icePath: ICE.drain, hydro: HYDRO.drain };

export class AbilitySystem {
  energy = 0;
  selected = 0;
  /** Debounce left per ability (s) and its full length: the short technical wait after a tap
   *  power or a jump goes off (TAP_DEBOUNCE, JUMP.debounce); there are no gameplay cooldowns. */
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
  /** A charged power gathering (focus beam): share 0..1 and the energy paid for it so far. */
  private gathered = { share: 0, paid: 0 };
  hooks: AbilityHooks = {};
  /** The elemental layer (set by the game). */
  effects: PowerEffects | null = null;
  /** The friend/foe sense's test (friendFoe.spared), set by the game: the shockwave uses it here. */
  spared: ((t: Target) => boolean) | null = null;
  /** Tap powers the game runs itself (the slime call): energy by rank and a handler (true: it went off). */
  special: Partial<Record<AbilityId, { cost: number[]; run: (rank: number) => boolean }>> = {};
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

  /** Energy one use of a tap power costs at its current rank (0: not a paid tap power). */
  cost(id: AbilityId): number {
    const r = Math.max(1, this.rank(id));
    const ch = CHARGED[id];
    if (ch) return ch.base;
    if (id === 'shockwave') return SHOCK_COST[r];
    if (id === 'speed') return this.player.flying ? DASH.cost : 0;
    const sp = this.special[id];
    if (sp) return sp.cost[r] ?? sp.cost[sp.cost.length - 1];
    return TAP[id] ?? 0;
  }

  /** Does this power's friend/foe sense work right now? Bought, and the body is not a giant's. */
  senseOn(id: AbilityId): boolean {
    return this.progress.hasSense(id) && this.player.height <= SENSE.maxHeight;
  }

  /** A charged power gathering: how far 0..1 (-1: none). The HUD shows it in the charge bar. */
  get gathering(): number { return this.channel && CHARGED[this.channel.id] ? this.gathered.share : -1; }

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
    if (!this.enabled) { this.cancelCharge(); this.endChannel(false); p.speedTop = 0; return; }
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
    // The debounce only swallows a double press; it says nothing.
    if (this.cooldown.get(id)) return false;
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
        const spare = this.senseOn('shockwave') ? this.spared ?? undefined : undefined;
        if (!this.interactions.blastAtView(SHOCK_RANGE[r] * Math.max(1, Math.sqrt(p.k)), SHOCK_IMPULSE[r], true, spare)) return false;
        this.energy -= SHOCK_COST[r];
        this.debounce(id, TAP_DEBOUNCE);
        p.action = { id: 'cast_forward', t0: p.animClock, dur: 0.6 };
        return true;
      }
      default: {
        const sp = this.special[id];
        if (sp) {
          const cost = this.cost(id);
          if (this.energy < cost) { this.hooks.deny?.('Not enough energy'); return false; }
          if (!sp.run(r)) return false;
          this.energy -= cost;
          this.debounce(id, TAP_DEBOUNCE);
          return true;
        }
        const cost = TAP[id];
        if (cost === undefined || !this.effects) return false;
        if (this.energy < cost) { this.hooks.deny?.('Not enough energy'); return false; }
        if (!this.effects.fire(id, r)) return false;
        this.energy -= cost;
        this.debounce(id, TAP_DEBOUNCE);
        return true;
      }
    }
  }

  /** Super speed pressed in flight: a dash burst where you look. */
  private dash(r: number): boolean {
    if (this.cooldown.get('speed')) return false;
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
    this.debounce('speed', TAP_DEBOUNCE);
    this.hooks.dashFx?.(dir.x, p.flying ? dir.y : 0, dir.z, dur, r);
    return true;
  }

  private spend(cost: number): boolean {
    if (this.energy < cost) { this.hooks.deny?.('Not enough energy'); return false; }
    this.energy -= cost;
    return true;
  }

  private debounce(id: AbilityId, s: number): void {
    if (s > 0) this.cooldown.set(id, { left: s, full: s });
  }

  // ---- held powers
  private beginChannel(id: AbilityId, src: string): void {
    if (this.channel) this.endChannel(false);
    const drain = DRAIN[id] ?? 0;
    if (drain > 0 && this.energy < drain * 0.25) { this.hooks.deny?.('Not enough energy'); return; }
    const ch = CHARGED[id];
    if (ch) {
      if (this.cooldown.get(id)) return;
      if (!this.spend(ch.base)) return;
      this.gathered.share = 0;
      this.gathered.paid = ch.base;
    }
    this.channel = { id, rank: this.rank(id), t: 0 };
    this.channelSrc = src;
  }

  /** The held power ends. A charged one fires on release (`fire`) or gives its energy back. */
  private endChannel(fire = true): void {
    const c = this.channel;
    this.channel = null;
    this.channelSrc = null;
    if (!c || !CHARGED[c.id]) return;
    const g = this.gathered;
    const went = fire && !!this.effects?.release?.(c.id, c.rank, g.share);
    if (went) this.debounce(c.id, TAP_DEBOUNCE);
    else this.energy = Math.min(this.maxEnergy, this.energy + g.paid);
    g.share = 0; g.paid = 0;
  }

  private updateChannel(dt: number, input: Input): void {
    const c = this.channel;
    if (!c || !this.channelSrc) return;
    if (!this.isHeld(this.channelSrc, input) || this.rank(c.id) <= 0) { this.endChannel(this.rank(c.id) > 0); return; }
    c.t += dt;
    c.rank = this.rank(c.id);
    const ch = CHARGED[c.id];
    if (ch) {
      // Gathering: pay for the share gained; with too little energy it stops growing (and holds).
      const g = this.gathered;
      const want = Math.min(1, g.share + dt / ch.time);
      const owe = ch.base + (ch.cost - ch.base) * want - g.paid;
      if (owe > 0 && this.energy >= owe) { this.energy -= owe; g.paid += owe; g.share = want; }
      else if (owe <= 0) g.share = want;
      return;
    }
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
    this.debounce('superJump', JUMP.debounce);
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
