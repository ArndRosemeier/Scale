/**
 * Fire engines (THREATS_PLAN §2 level 2 "fire trucks hosing burning facades", §3 aftermath "fire
 * trucks still around for a while"): when facades burn near the player and it is safe to get there
 * (not right by the monster, not in a strike zone counting down), an engine comes with its siren,
 * parks in the nearest street, two firefighters get out and hose the fire down (a water jet, the
 * fire dies: FacadeFires.douse). With nothing left burning they stay a while, then drive off.
 * At most two engines; no real lights (light bars and the jet are emissive / particles).
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import type { Aftermath } from './Aftermath';
import { Rng, deriveSeed, hash32 } from '../../core/rng';
import { VState, type Vehicle } from '../../sim/Traffic';
import type { PedAgent } from '../../sim/Pedestrians';
import { attach, makeActor, stand, lookAt, setState, AFTERMATH_OWNER } from '../../sim/actors/Actor';
import type { EquipmentVisuals } from '../../items/types';
import { BeamStyle } from '../powers/ElementFx';
import type { FacadeFire } from '../threats/FacadeFires';
import { parked } from './park';

export const FIRE_CREW = { max: 2, reach: 420, hoseR: 34, douse: 6, stayS: 90 };

interface Engine { car: Vehicle; crew: PedAgent[]; fire: FacadeFire | null; idleT: number; sprayT: number; loop: ReturnType<Game['audio']['loop']> }

const SPRAY = new THREE.Color(0.75, 0.85, 1.0), SPRAY_END = new THREE.Color(0.55, 0.62, 0.7);

export class FireCrew {
  private engines: Engine[] = [];
  private callT = 0;
  private rng: Rng;
  stats = { sent: 0, doused: 0 };

  constructor(private g: Game, private A: Aftermath) { this.rng = new Rng(deriveSeed(g.settings.seed, 'fire-crew')); }

  update(dt: number): void {
    const g = this.g, p = g.player.pos, fires = g.threats.fires.list;
    // A call for the nearest fire not covered yet.
    this.callT -= dt;
    if (this.callT <= 0 && this.engines.length < FIRE_CREW.max) {
      this.callT = 5;
      let best: FacadeFire | null = null, bd = FIRE_CREW.reach;
      for (const f of fires) {
        if (this.A.danger(f.x, f.z) || this.engines.some((e) => e.fire && Math.hypot(e.fire.x - f.x, e.fire.z - f.z) < 40)) continue;
        const d = Math.hypot(f.x - p.x, f.z - p.z);
        if (d < bd) { bd = d; best = f; }
      }
      if (best) this.send(best);
    }
    for (let i = this.engines.length - 1; i >= 0; i--) {
      const E = this.engines[i], car = E.car;
      if (!car.alive || car.state >= VState.Wreck) { this.dismiss(E); this.engines.splice(i, 1); continue; }
      // Its fire out (or gone): the nearest other one within reach of the hose, else stand by, then leave.
      if (!E.fire || !fires.includes(E.fire)) E.fire = fires.find((f) => Math.hypot(f.x - car.x, f.z - car.z) < FIRE_CREW.hoseR + 10 && !this.A.danger(f.x, f.z)) ?? null;
      const there = parked(car, dt);
      if (there && car.siren) { car.siren = false; car.fear = 0.5; this.crewOut(E); }
      E.loop?.set(car.x, car.y + 1.6, car.z, car.siren ? 0.8 : 0);
      if (!there) continue;
      if (!E.fire) { E.idleT += dt; if (E.idleT > FIRE_CREW.stayS) { this.dismiss(E); this.engines.splice(i, 1); } continue; }
      E.idleT = 0;
      this.spray(E, dt);
    }
  }

  private send(f: FacadeFire): void {
    const g = this.g, net = g.net;
    const ne = net.nearestEdge(f.x + f.nx * 12, f.z + f.nz * 12, 60);
    if (!ne) return;
    const o = { x: 0, z: 0, dx: 0, dz: 0 };
    net.pointAt(net.edges[ne.e], ne.s, 0, o);
    const a = this.rng.range(0, Math.PI * 2);
    const car = g.traffic.spawnVehicle('firetruck', o.x + Math.cos(a) * 280, o.z + Math.sin(a) * 280, 120, o);
    if (!car) return;
    car.task = { x: o.x, z: o.z, arrived: false };
    car.siren = true; car.fear = 0; car.state = VState.Drive; car.vmax = 17;
    g.traffic.sendTo(car, o.x, o.z);
    this.engines.push({ car, crew: [], fire: f, idleT: 0, sprayT: 0, loop: g.audio.loop('siren_loop', 30) });
    this.stats.sent++;
    this.A.note('a fire engine is on its way');
  }

  private crewOut(E: Engine): void {
    const g = this.g, car = E.car;
    for (let i = 0; i < 2; i++) {
      const c = g.population.synthetic(hash32(car.id * 977 + i * 31 + 11) || 1);
      const a = g.peds.spawnAt(c, car.x + Math.cos(car.yaw) * (i ? 1.6 : -1.6), car.z - Math.sin(car.yaw) * (i ? 1.6 : -1.6), car.yaw, false);
      if (!a) break;
      attach(a, makeActor('worker', AFTERMATH_OWNER, { outfit: firefighterOutfit(c.seed), mood: 'focused', held: null }));
      E.crew.push(a);
    }
  }

  /** The hose: from the nearest firefighter (or the truck) at the fire, dousing it. */
  private spray(E: Engine, dt: number): void {
    const g = this.g, f = E.fire!, fx = g.elements.fx;
    const nozzle = E.crew.find((a) => a.alive) ?? null;
    const ox = nozzle ? nozzle.x : E.car.x, oy = (nozzle ? nozzle.y : E.car.y) + 1.3, oz = nozzle ? nozzle.z : E.car.z;
    for (const a of E.crew) {
      const act = a.actor;
      if (!a.alive || !act) continue;
      const tx = f.x + f.nx * 9 + (a === nozzle ? 0 : 1.5), tz = f.z + f.nz * 9;
      if (Math.hypot(tx - a.x, tz - a.z) > 2 && Math.hypot(f.x - a.x, f.z - a.z) > 8) { g.crime.police.chase(a, { x: tx, z: tz }, 2.2); continue; }
      stand(act); setState(act, 'fight'); lookAt(act, f.x, f.y, f.z);
    }
    const d = Math.hypot(f.x - ox, f.z - oz);
    if (d > FIRE_CREW.hoseR) return;
    // The jet: a bright core arcing up to the flames, spray where it lands.
    const mx = (ox + f.x) / 2, my = Math.max(oy, f.y) + d * 0.12, mz = (oz + f.z) / 2;
    fx.seg(ox, oy, oz, mx, my, mz, 0.35, 0.6, 0.75, 1.1, 0.8, BeamStyle.Water);
    fx.seg(mx, my, mz, f.x, f.y, f.z, 0.5, 0.6, 0.75, 1.1, 0.7, BeamStyle.Water);
    E.sprayT -= dt;
    if (E.sprayT <= 0) {
      E.sprayT = 0.5;
      for (let k = 0; k < 3; k++) fx.soft(f.x + f.nx * 0.6, f.y, f.z + f.nz * 0.6, f.nx * 2 + (Math.random() - 0.5) * 2, 1 + Math.random() * 2, f.nz * 2 + (Math.random() - 0.5) * 2, 1.4, 0.6, 2.6, SPRAY, SPRAY_END, 0.45, 1.2, 2);
      if (g.threats.fires.douse(f.x, f.y, f.z, 4, FIRE_CREW.douse)) this.stats.doused++;
    }
  }

  private dismiss(E: Engine): void {
    const g = this.g, car = E.car;
    for (const a of E.crew) a.alive = false;
    E.crew.length = 0;
    E.loop?.stop();
    if (!car.alive) return;
    car.siren = false; car.fear = 0;
    car.task = undefined;
    car.state = VState.Drive;
    if (!g.crime.visible(car.x, car.y + 1, car.z)) car.alive = false;
  }

  status(): Record<string, unknown> {
    return { engines: this.engines.map((e) => ({ at: [Math.round(e.car.x), Math.round(e.car.z)], arrived: !!e.car.task?.arrived, fire: !!e.fire, crew: e.crew.length })), ...this.stats };
  }
}

/** Firefighters: dark turnout gear with yellow bands, a helmet. */
function firefighterOutfit(seed: number): EquipmentVisuals {
  const navy: [number, number, number] = [0.08, 0.09, 0.12], band: [number, number, number] = [0.9, 0.85, 0.15];
  const v = (p: [number, number, number], s: [number, number, number], k: number) => ({ shape: 'cloth', seed: seed + k, primary: p, secondary: s, accent: band, material: 'plain', glow: 0 });
  return {
    chest: { defId: 'shirt', visual: v(navy, navy, 1) },
    back: { defId: 'jacket', visual: v(navy, band, 2) },
    legs: { defId: 'trousers', visual: v(navy, band, 3) },
    feet: { defId: 'boots', visual: v([0.05, 0.05, 0.05], [0, 0, 0], 4) },
    head: { defId: 'helmet', visual: v([0.85, 0.82, 0.75], [0.85, 0.82, 0.75], 5) },
  } as unknown as EquipmentVisuals;
}
