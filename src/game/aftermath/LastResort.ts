/**
 * The last resort (THREATS_PLAN §2 ladder level 5; PLAYGROUND_PLAN §0 decision 19 as amended): the
 * army has failed against a major threat deep in the city, so a small tactical nuke is prepared.
 * Shown, never told:
 *
 *  - the civil-defence sirens change their tone (the fast "attack" wail), the evacuation widens to
 *    the strike zone and beyond; traffic heads out of it (cars sent to the far side of the ring);
 *    the army pulls out — convoys leaving; the monster stays in downtown;
 *  - the screens across the city show the countdown: a hazard symbol and the minutes and seconds
 *    left, no words; the map, the minimap and the compass show the strike zone's ring;
 *  - the player can beat the clock: drive the monster off or bring it down before zero — the strike
 *    is called off (the sirens wind down, an all-clear pictogram, big karma and reputation);
 *  - at zero: a flash far over downtown, the shock wave levelling the district (buildings by their
 *    distance, a few a frame; dust rolling out; the boom arriving later), a mushroom cloud, the
 *    monster gone. The district stays levelled (the aftermath keeps the zone; saves keep it), people
 *    left in it are trapped or injured — never dead —, the player inside the ring is knocked out and
 *    comes round at its edge. The city lost: karma and reputation fall; the news shows it for hours.
 *
 * Against a rampaging giant player (threats/PlayerRampage) the same: the army failing, the roll —
 * but the strike zone follows the player through the countdown (it is the player the strike is
 * for), and standing down (no more destruction, or human-sized again) or being brought down calls it
 * off. A player caught at zero is knocked out by the blast like anyone else — unless underground.
 *
 * The decision (`lastResortDue`), the shock wave (`ShockWave`) and the tuning (LAST_RESORT) are the
 * pure rules in rules.ts. Rare: a seeded roll per incident (× the City events setting); forced with
 * dev.lastResort.force() / dev.response.level(5).
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import type { Aftermath } from './Aftermath';
import type { Incident } from '../response/ResponseDirector';
import { Strider } from '../threats/Strider';
import { PlayerRampage } from '../threats/PlayerRampage';
import { VState, type Vehicle } from '../../sim/Traffic';
import type { BuildingRef } from '../../world/WorldIndex';
import { LAST_RESORT, lastResortDue, lastResortRoll, ShockWave } from './rules';
import { strikeCasualties } from './Casualties';
import type { SmokeColumn } from './SmokeColumns';

export type LastResortState = 'idle' | 'countdown' | 'calledOff' | 'strike';

const FIRE_A = new THREE.Color(4, 3.2, 2.2), FIRE_B = new THREE.Color(1.6, 0.45, 0.08);
const DUST = new THREE.Color(0.5, 0.47, 0.43);

export class LastResort {
  state: LastResortState = 'idle';
  /** Seconds left on the clock. */
  left = 0;
  /** Ground zero and the strike radius. */
  x = 0; z = 0; r = LAST_RESORT.radius;
  /** Dev: the next level-4 incident goes to level 5 at once. */
  forced = false;
  private inc: Incident | null = null;
  private mon: Strider | null = null;
  /** The target is a rampaging giant player (instead of a monster). */
  private hostile: PlayerRampage | null = null;
  private t = 0;
  private sirenGain = 0;
  private siren: ReturnType<Game['audio']['loop']> = null;
  private convoy = new Set<Vehicle>();
  private convoyT = 0;
  private wave: ShockWave | null = null;
  private refs: BuildingRef[] = [];
  private cars: Vehicle[] = [];
  private mushroom: SmokeColumn | null = null;
  private flash: HTMLDivElement;
  private flashK = 0;
  private koT = -1;
  private wake: { x: number; z: number } | null = null;
  private dustT = 0;
  stats = { countdowns: 0, calledOff: 0, strikes: 0, levelled: 0, cars: 0, people: 0, playerKO: 0, msLevel: 0 };

  constructor(private g: Game, private A: Aftermath) {
    this.flash = document.createElement('div');
    this.flash.id = 'nukeflash';
    document.body.appendChild(this.flash);
    g.response.registerLevel(5, {
      when: (inc) => this.due(inc),
      up: (inc) => this.start(inc),
      step: (inc, dt) => this.step(inc, dt),
      down: () => this.stop(),
    });
  }

  /** What the ladder asks: time for level 5? */
  private due(inc: Incident): boolean {
    const ev = inc.ev;
    if (!(ev instanceof Strider || ev instanceof PlayerRampage) || !this.g.forces.enabled) return false;
    const F = this.g.forces;
    const lost = Object.values(F.stats.lost).reduce((a, b) => a + b, 0);
    // (A rampaging player is wherever they are: the city itself.)
    const player = ev instanceof PlayerRampage;
    return lastResortDue({
      major: ev.tier === 'major', level: inc.level, levelT: inc.levelT, strength: ev.strength(), downtown: player || (ev as Strider).mode === 'rampage',
      progress: player ? 1 : (ev as Strider).s / Math.max(1, (ev as Strider).route.length), broken: F.squads.filter((q) => q.broke > 0 || q.routed).length, lost,
      roll: lastResortRoll(this.g.settings.seed, ev.id), setting: this.g.threats.setting, forced: this.forced,
    });
  }

  // ================================================================== the countdown

  private start(inc: Incident): void {
    const ev = inc.ev;
    if (!(ev instanceof Strider || ev instanceof PlayerRampage)) return;
    this.forced = false;
    this.inc = inc;
    this.mon = ev instanceof Strider ? ev : null;
    this.hostile = ev instanceof PlayerRampage ? ev : null;
    this.state = 'countdown';
    this.left = LAST_RESORT.countdown;
    this.t = 0;
    // Ground zero: where it is now (it stays in downtown from now on).
    this.x = ev.x; this.z = ev.z; this.r = LAST_RESORT.radius;
    if (this.mon) this.mon.stay = true;
    // The sirens change their tone; the evacuation widens past the strike zone.
    inc.tone = 'nuke_siren';
    inc.evacR = this.r * 1.6;
    // The army pulls out: convoys leaving.
    this.g.forces.withdraw();
    this.stats.countdowns++;
    this.A.note(`last resort: countdown ${LAST_RESORT.countdown} s at ${Math.round(this.x)},${Math.round(this.z)}`);
  }

  private step(inc: Incident, dt: number): void {
    this.t += dt;
    const g = this.g, S = this.mon, Hp = this.hostile;
    if (this.state === 'countdown' && Hp) {
      // The player: the zone follows them; standing down or brought down calls it off.
      this.left -= dt;
      if (!Hp.active) this.callOff(false);
      else if (this.left <= 0) this.strike();
      else {
        this.x = Hp.x; this.z = Hp.z;
        this.traffic(dt);
        g.future.signs.countdown(this.x, this.z, 6000, this.left, 1);
      }
    } else if (this.state === 'countdown' && S) {
      this.left -= dt;
      // Beaten in time: driven off or brought down.
      if (S.mode === 'retreat' || S.mode === 'sink' || S.mode === 'gone' || S.defeated) this.callOff(true);
      else if (this.left <= 0) this.strike();
      else {
        this.traffic(dt);
        // The screens all over the city.
        g.future.signs.countdown(this.x, this.z, 6000, this.left, 1);
      }
    }
    void inc;
  }

  /** Cars inside the zone are sent out of it (a stream of traffic leaving), at most a few a second. */
  private traffic(dt: number): void {
    this.convoyT -= dt;
    if (this.convoyT > 0) return;
    this.convoyT = 0.5;
    const g = this.g, R = this.r * 1.5;
    let n = 0;
    for (const v of g.traffic.vehicles) {
      if (n >= 3) break;
      if (v.state !== VState.Drive || v.task || v.siren || this.convoy.has(v) || v.kind === 'tank' || v.kind === 'apc' || v.kind === 'army_truck') continue;
      const dx = v.x - this.x, dz = v.z - this.z, d = Math.hypot(dx, dz);
      if (d > R) continue;
      const k = (R + 260) / Math.max(1, d);
      const tx = this.x + dx * k, tz = this.z + dz * k;
      v.task = { x: tx, z: tz, arrived: false };
      v.fear = 0;
      v.vmax = Math.max(v.vmax, 17);
      if (g.traffic.sendTo(v, tx, tz)) { this.convoy.add(v); n++; } else v.task = undefined;
    }
    // Out of the zone (or stuck at the end): back to ordinary driving, or gone where nobody sees it.
    for (const v of this.convoy) {
      if (!v.alive) { this.convoy.delete(v); continue; }
      const d = Math.hypot(v.x - this.x, v.z - this.z);
      if (d > R + 150 || v.task?.arrived) {
        this.convoy.delete(v);
        v.task = undefined;
        if (!g.crime.visible(v.x, v.y + 1, v.z)) v.alive = false;
      }
    }
  }

  /** Beaten in time (or the incident ended otherwise): the strike is off. */
  private callOff(beaten: boolean): void {
    if (this.state !== 'countdown') return;
    this.state = 'calledOff';
    this.t = 0;
    const g = this.g, S = this.mon;
    if (S) S.stay = false;
    if (this.inc) { this.inc.tone = undefined; this.inc.evacR = undefined; }
    g.future.signs.countdown(this.x, this.z, 0, 0, 0);
    this.stats.calledOff++;
    this.releaseConvoy();
    if (beaten && S) {
      // The player's doing (the most damage, or a good share of it): the city was saved.
      let tot = 0;
      for (const v of S.aggro.values()) tot += v;
      const mine = S.aggro.get('player') ?? 0;
      if (tot > 0 && (mine >= tot * 0.25 || S.topAggro()?.key === 'player')) {
        g.progress.addKarma(LAST_RESORT.karma.saved, 'stopped it in time — the strike is called off');
        g.crime.rep.add(LAST_RESORT.rep.saved, 'saved the city');
        g.crime.cheer();
      }
      this.A.news(2);
    }
    // The siren winds down (see update).
    this.A.note(`last resort: called off (${beaten ? 'beaten in time' : 'over'})`);
  }

  // ================================================================== the strike

  private strike(): void {
    const g = this.g, S = this.mon;
    this.state = 'strike';
    this.t = 0;
    this.stats.strikes++;
    g.future.signs.countdown(this.x, this.z, 0, 0, 0);
    this.releaseConvoy();
    const cam = g.renderer.camera.position, p = g.player.pos;
    const d = Math.hypot(cam.x - this.x, cam.z - this.z);
    // The flash: the sky and everything lit up, a white veil over the view (weaker far off).
    this.flashK = Math.max(0.35, Math.min(1, 1.6 - d / 2500));
    this.flash.style.transition = 'none';
    this.flash.style.opacity = this.flashK.toFixed(2);
    g.weather.glare(1.6);
    // The boom arrives later (343 m/s, at most ~12 s), the ground shakes with the wave.
    const delay = Math.min(12, d / 343);
    g.later.after(delay, () => g.audio.play2d('blast_rumble', Math.max(0.35, 1 - d / 6000), 0.95));
    g.camRig.addShake(Math.min(1.2, 900 / Math.max(200, d)));
    // The fireball, then the mushroom cloud.
    const y0 = g.terrain.height(this.x, this.z);
    const fx = g.elements.fx;
    for (let i = 0; i < 26; i++) fx.glow(this.x + (Math.random() - 0.5) * 60, y0 + 40 + Math.random() * 120, this.z + (Math.random() - 0.5) * 60, (Math.random() - 0.5) * 20, 18 + Math.random() * 20, (Math.random() - 0.5) * 20, 3 + Math.random() * 4, 60, 150, FIRE_A, FIRE_B, 1, 0.4, -2);
    this.mushroom = { x: this.x, y: y0, z: this.z, height: 1100, width: 420, density: 0.85, fire: 0.6, mushroom: 1, growth: 0, seed: 777 };
    this.A.addColumn(this.mushroom);
    // The monster is gone (and any carcass lying in the district with it); a rampage is over.
    S?.obliterate();
    this.hostile?.obliterate();
    for (const b of [...g.threats.remains]) if (Math.hypot(b.x - this.x, b.z - this.z) < this.r) { g.threats.removeRemains(b); b.rig.cut = null; }
    // The buildings the wave will level (those loaded; the rest are levelled as they stream in).
    const seen = new Set<BuildingRef>();
    this.refs = [];
    for (const ref of g.world.buildingsIn(this.x - this.r, this.z - this.r, this.x + this.r, this.z + this.r)) {
      if (seen.has(ref) || !ref.alive) continue;
      seen.add(ref);
      const cx = (ref.bounds[0] + ref.bounds[2]) / 2, cz = (ref.bounds[1] + ref.bounds[3]) / 2;
      if (Math.hypot(cx - this.x, cz - this.z) < this.r) this.refs.push(ref);
    }
    this.wave = new ShockWave(this.refs.map((ref) => Math.hypot((ref.bounds[0] + ref.bounds[2]) / 2 - this.x, (ref.bounds[1] + ref.bounds[3]) / 2 - this.z)));
    this.cars = [...g.traffic.vehicles, ...g.parkedCars].filter((v) => Math.hypot(v.x - this.x, v.z - this.z) < this.r);
    this.A.addZone(this.x, this.z, this.r);
    // People still in the district: never dead — trapped under the rubble or injured, found by the crews (and the player).
    let left = 0;
    for (const a of g.peds.agents) {
      if (!a.alive || a.actor?.role === 'soldier' || Math.hypot(a.x - this.x, a.z - this.z) > this.r) continue;
      if (a.inside || g.underground.feetUnder(a.x, a.y, a.z)) continue;
      left++;
      a.alive = false;
    }
    // (And those who sheltered in the buildings instead of leaving: a few per hectare.)
    left += Math.round(Math.PI * this.r * this.r * LAST_RESORT.stayedPerM2);
    const cas = strikeCasualties(left);
    this.stats.people = left;
    this.A.strikeCasualties(this.x, this.z, this.r, cas.trapped, cas.injured);
    // The player inside the ring (not underground) is knocked out and comes round at its edge.
    const dp = Math.hypot(p.x - this.x, p.z - this.z);
    if (dp < this.r * LAST_RESORT.koK && !g.underground.feetUnder(p.x, p.y, p.z)) {
      this.stats.playerKO++;
      const k = (this.r * 1.2 + 25) / Math.max(1, dp);
      this.wake = { x: this.x + (p.x - this.x) * k, z: this.z + (p.z - this.z) * k };
      this.koT = 4.5;
    }
    // The city lost.
    g.progress.addKarma(LAST_RESORT.karma.lost, 'the city was struck');
    this.A.news(1);
    this.A.note(`last resort: STRIKE — ${this.refs.length} buildings, ${this.cars.length} cars, ${left} people in the zone`);
  }

  private releaseConvoy(): void {
    for (const v of this.convoy) if (v.alive && v.task && !v.task.arrived) v.task = undefined;
    this.convoy.clear();
  }

  // ================================================================== every frame (also after the incident)

  update(dt: number): void {
    const g = this.g;
    // The attack siren: on during the countdown, winding down after (lower and slower), off.
    const want = this.state === 'countdown' ? 1 : 0;
    this.sirenGain += (want - this.sirenGain) * Math.min(1, dt * (want ? 0.8 : 0.22));
    if (this.sirenGain > 0.01 && !this.siren) this.siren = g.audio.loop('nuke_siren', 90);
    if (this.siren) {
      const y = g.terrain.height(this.x, this.z) + 30;
      this.siren.set(this.x, y, this.z, this.sirenGain, 0.7 + 0.3 * this.sirenGain);
      if (this.sirenGain < 0.01 && !want) { this.siren.stop(); this.siren = null; }
    }
    // The flash fades.
    if (this.flashK > 0) {
      this.flashK = Math.max(0, this.flashK - dt * 0.55);
      this.flash.style.opacity = this.flashK.toFixed(3);
    }
    if (this.state === 'strike') this.strikeStep(dt);
    if (this.koT >= 0) this.knockout(dt);
    // The zone on the map and the compass (while it counts down).
    this.A.zoneMarker(this.state === 'countdown' ? { x: this.x, z: this.z, r: this.r, left: this.left } : null);
    if (this.state === 'calledOff' && this.t > 30) this.state = 'idle';
    this.t += this.state === 'calledOff' ? dt : 0;
  }

  /** The shock wave: buildings by distance (a few a frame), cars crushed as it passes, dust rolling out; the cloud grows. */
  private strikeStep(dt: number): void {
    const g = this.g, W = this.wave;
    this.t += dt;
    if (this.mushroom) { this.mushroom.growth = Math.min(1, this.t / 26); this.A.smoke.grow(this.mushroom); }
    if (W) {
      const t0 = performance.now();
      for (const k of W.step(dt)) { this.A.level(this.refs[k], true); this.stats.levelled++; }
      this.stats.msLevel = Math.max(this.stats.msLevel, performance.now() - t0);
      const f = W.front;
      for (let i = this.cars.length - 1; i >= 0; i--) {
        const v = this.cars[i];
        if (Math.hypot(v.x - this.x, v.z - this.z) > f) continue;
        this.cars.splice(i, 1);
        if (v.alive && v.state !== VState.Crushed) { g.traffic.crush(v); this.stats.cars++; }
      }
      // Dust rolling out at the front.
      this.dustT -= dt;
      if (this.dustT <= 0 && f < this.r * 1.15) {
        this.dustT = 0.12;
        for (let k = 0; k < 6; k++) {
          const a = Math.random() * Math.PI * 2, x = this.x + Math.cos(a) * f, z = this.z + Math.sin(a) * f;
          g.dust.burst(x, g.terrain.height(x, z) + 4, z, 4, 12, 10, 6, 10, DUST, 0.3, 0.6);
        }
        const dp = Math.hypot(g.player.pos.x - this.x, g.player.pos.z - this.z);
        if (Math.abs(dp - f) < 60) g.camRig.addShake(0.6);
      }
      if (W.done && f > this.r * 1.2) {
        // (Street furniture went with each building — Aftermath.level; one big crush or collapse
        // stimulus here cost 30–50 ms in a frame.) Far off, the ground shook: people look round.
        this.wave = null;
        g.stimuli.emit('tremor', this.x, g.terrain.height(this.x, this.z) + 10, this.z, 6, 2500, { cause: 'military' });
      }
    }
    if (this.t > 40 && !this.wave) {
      // The cloud drifts into a long column (the aftermath's smoke keeps the district smoking).
      if (this.mushroom) { this.A.removeColumn(this.mushroom); this.mushroom = null; }
      this.state = 'idle';
    }
  }

  /** Knocked out by the blast: a fade, then waking at the edge of the ruins. */
  private knockout(dt: number): void {
    const g = this.g, P = g.player;
    const was = this.koT;
    this.koT -= dt;
    if (was > 4.0 && this.koT <= 4.0) {
      // Thrown off their feet by the blast (a ragdoll) …
      const dx = P.pos.x - this.x, dz = P.pos.z - this.z, l = Math.hypot(dx, dz) || 1;
      P.vel.set((dx / l) * 9, 5, (dz / l) * 9);
      P.downT = Math.max(P.downT, 8);
    }
    // … and the view fades out.
    if (was > 2.0 && this.koT <= 2.0) g.crime.hud.fade(true);
    if (was > 0 && this.koT <= 0 && this.wake) {
      // Coming round at the edge of the ruins (lying there a moment, then up).
      g.ragdolls.release(P);
      P.downT = 0;
      g.map.placeSafely(this.wake.x, this.wake.z);
      P.vel.set(0, 0, 0);
      if (P.flying) P.toggleFlight();
      g.crime.health.hp = Math.max(1, g.crime.health.max * 0.35);
      this.wake = null;
      this.koT = -1;
      g.later.after(3.5, () => { g.crime.hud.fade(false); P.downT = 1.2; });
    }
  }

  /** Down from level 5 (the incident is over): whatever is left of the countdown ends. */
  private stop(): void {
    if (this.state === 'countdown') this.callOff(false);
    if (this.inc) { this.inc.tone = undefined; this.inc.evacR = undefined; }
    this.inc = null;
    this.hostile = null;
  }

  /** Dev: the clock (seconds left), or skip to the strike. */
  setLeft(s: number): number { if (this.state === 'countdown') this.left = Math.max(0, s); return this.left; }

  status(): Record<string, unknown> {
    return {
      state: this.state, left: +this.left.toFixed(1), at: { x: Math.round(this.x), z: Math.round(this.z), r: this.r }, forced: this.forced,
      monster: this.mon ? { mode: this.mon.mode, hp: Math.round(this.mon.hp), stay: this.mon.stay } : null,
      player: this.hostile ? { active: this.hostile.active, outcome: this.hostile.outcome } : null,
      wave: this.wave ? { front: Math.round(this.wave.front), left: this.wave.left } : null, convoy: this.convoy.size, ...this.stats,
    };
  }
}
