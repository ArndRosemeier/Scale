/**
 * Good deeds (interim, before crimes): helping people up who were knocked down — by
 * cars, collapses or a small everyday accident — earns karma. People the player knocked
 * down personally earn nothing. Every 50–110 s someone near the player trips and falls
 * (Normal mode), so there is always a way to do good. People who need help show on the
 * minimap; standing next to one, E helps them up and they wave thanks (and the city's reputation
 * rises a little).
 */
import type { Pedestrians, PedAgent } from '../sim/Pedestrians';
import { PState } from '../sim/Pedestrians';
import type { Reactions } from '../sim/Reactions';
import type { Player } from '../player/Player';
import type { Progress } from './abilities/Progress';
import type { MapMarker } from '../ui/map/GameMap';
import { ACCIDENTS, KARMA } from './abilities/tuning';

export interface DeedHooks {
  toast?: (html: string, kind?: 'karma' | 'info' | 'warn') => void;
  sound?: (id: string, x: number, y: number, z: number, gain: number) => void;
  markers?: (m: MapMarker[]) => void;
  /** Can the player get to this person (not indoors, not in the water, lying on a real surface)? */
  reachable?: (a: PedAgent) => boolean;
  /** The city's reputation (helping someone up raises it a little). */
  rep?: (amount: number, reason: string) => void;
}

export class Deeds {
  hooks: DeedHooks = {};
  private accidentT: number;
  private markT = 0;
  private markerKey = '';
  /** Accidents happen (Normal mode). */
  accidents = true;
  /** No new accidents for now (the hero is down, being rescued). */
  quiet = false;
  /** Someone was just helped up (game/people: they remember it). */
  onHelped: ((a: PedAgent) => void) | null = null;

  constructor(private peds: Pedestrians, private reactions: Reactions, private player: Player, private progress: Progress) {
    this.accidentT = 25;
  }

  /** The person next to the player who can be helped up, if any. */
  helpable(): PedAgent | null {
    const p = this.player;
    if (p.flying || p.height > 4) return null;
    const reach = p.radius + 1.6;
    let best: PedAgent | null = null, bd = reach;
    for (const a of this.peds.neighbours(p.pos.x, p.pos.z, reach, [])) {
      if (a.state !== PState.Down || !a.alive || a.actor || a.stateT < 0.8 || Math.abs(a.y - p.pos.y) > 1.5) continue;
      const d = Math.hypot(a.x - p.pos.x, a.z - p.pos.z);
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }

  hint(): string | null {
    return this.helpable() ? 'Someone is hurt — press <b>E</b> to help them up' : null;
  }

  /** E next to someone down: help them up. Returns true when E was used. */
  help(): boolean {
    const a = this.helpable();
    if (!a) return false;
    const p = this.player;
    a.state = PState.Idle;
    a.stateT = 0;
    a.fear = 0;
    a.vx = a.vy = a.vz = 0;
    a.speed = 0;
    a.helped = true;
    a.heading = Math.atan2(-(p.pos.x - a.x), -(p.pos.z - a.z));
    p.action = { id: 'pickup', t0: p.animClock, dur: 0.9 };
    const cause = a.downBy ?? 'other';
    a.downBy = undefined;
    if (!this.progress.sandbox) {
      if (cause === 'player' || cause === 'brush') this.hooks.toast?.('You helped them up — no karma for someone <b>you</b> knocked down', 'info');
      else this.progress.addKarma(cause === 'collapse' ? KARMA.helpUpCollapse : KARMA.helpUp, 'helped someone up');
    }
    if (cause !== 'player' && cause !== 'brush') this.hooks.rep?.(KARMA.helpUpRep, 'helped someone up');
    this.onHelped?.(a);
    // (Not '': with nobody left to mark the new key is '' too, and the old marker stayed.)
    this.markerKey = '#stale';
    return true;
  }

  update(dt: number): void {
    const p = this.player;
    // Everyday accidents near the player.
    if (this.accidents && !this.quiet && !this.progress.sandbox) {
      this.accidentT -= dt;
      if (this.accidentT <= 0) {
        this.accidentT = ACCIDENTS.minGap + Math.random() * (ACCIDENTS.maxGap - ACCIDENTS.minGap);
        const c = this.peds.agents.filter((a) => a.alive && !a.inside && !a.actor && a.state === PState.Walk && a.onRoad === false && inRing(a, p.pos.x, p.pos.z));
        const pool = c.length ? c : this.peds.agents.filter((a) => a.alive && !a.inside && !a.actor && a.state === PState.Walk && inRing(a, p.pos.x, p.pos.z));
        if (pool.length) {
          const a = pool[Math.floor(Math.random() * pool.length)];
          this.reactions.knockDown(a, a.x + Math.sin(a.heading), a.z + Math.cos(a.heading), 1.2, 'accident');
          a.fear = 0;
          this.hooks.sound?.('scream_single', a.x, a.y + 1.5, a.z, 0.45);
          this.hooks.toast?.('Someone fell nearby — find them and help them up', 'warn');
        } else this.accidentT = 10;
      }
    }
    // People who need help, on the minimap.
    this.markT -= dt;
    if (this.markT > 0) return;
    this.markT = 0.5;
    const list: MapMarker[] = [];
    for (const a of this.peds.agents) {
      if (a.state !== PState.Down || !a.alive || a.actor || a.downBy === 'player' || a.downBy === 'brush' || a.downBy === undefined) continue;
      if (Math.hypot(a.x - p.pos.x, a.z - p.pos.z) > 160) continue;
      // Out of reach (indoors, in the river, stuck at a height where nobody can get to them): no
      // marker that leads nowhere — they are looked after by someone else and leave.
      if (!a.ragdoll && a.stateT > 3 && this.hooks.reachable && !this.hooks.reachable(a)) { a.alive = false; continue; }
      list.push({ x: a.x, z: a.z, color: '#ff9f43', kind: 'alert', title: 'Someone fell — help them up (E)' });
    }
    const key = list.map((m) => `${m.x.toFixed(0)},${m.z.toFixed(0)}`).join(';');
    if (key !== this.markerKey) { this.markerKey = key; this.hooks.markers?.(list); }
  }
}

function inRing(a: PedAgent, x: number, z: number): boolean {
  const d = Math.hypot(a.x - x, a.z - z);
  return d > ACCIDENTS.near && d < ACCIDENTS.far;
}
