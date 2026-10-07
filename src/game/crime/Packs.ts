/**
 * The Beast-masters' dog packs in the game (crime/DogPack is the pure simulation): one pack per
 * eco-radical caster with the whistle, drawn with the deeds' dog model (run cycle by speed), hit
 * by the hero's blows and powers (Game.strike, the powers' `swarm` hook), the whistle routed from
 * VillainCasts. A pack goes when its dogs have all run off.
 */
import type { Game } from '../Game';
import type { Crime, PlayerView } from './Crime';
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';
import { subdued } from '../../sim/actors/Actor';
import { DogPack, DOGS, type PackWorld } from './DogPack';
import { makeDog, type Critter } from '../deeds/critters';
import type { HitEffect } from '../threats/brood/BroodSim';
import type { HurtKind } from '../PlayerHealth';

interface Pack { pack: DogPack; by: PedAgent; crime: Crime; models: Critter[] }

export class Packs {
  readonly list: Pack[] = [];
  private readonly world: PackWorld;
  private t = 0;

  constructor(private g: Game, view: PlayerView, hurtPlayer: (d: number, k: HurtKind, fx: number, fz: number) => void) {
    this.world = {
      player: view,
      ground: (x, z) => g.world.groundHeight(x, z),
      blocked: (x, z) => !!g.world.buildingAt(x, z),
      hurtPlayer: (d, fx, fz) => hurtPlayer(d, 'punch', fx, fz),
      sound: (id, x, y, z, gain, pitch) => g.audio.play(id, x, g.world.groundHeight(x, z) + y, z, gain, pitch, 30, g.renderer.camera.position),
      random: Math.random,
    };
  }

  /** A Beast-master's pack (once per handler). */
  give(c: Crime, by: PedAgent): DogPack {
    const have = this.of(by);
    if (have) return have;
    const act = by.actor;
    const seed = (by.cit.seed ^ 0xd06) >>> 0;
    const n = DOGS.n[0] + (seed % (DOGS.n[1] - DOGS.n[0] + 1));
    const pack = new DogPack(this.world, {
      get x() { return by.x; },
      get z() { return by.z; },
      fighting: () => !!act && (act.state === 'fight' || (act.hostile && act.memo.choice === 1)),
      beaten: () => !by.alive || !act || by.actor !== act || subdued(act) || by.state === PState.Down || !c.active,
    }, n, seed);
    const models = pack.dogs.map((d) => { const m = makeDog(d.seed % 997); this.g.renderer.scene.add(m.object); return m; });
    this.list.push({ pack, by, crime: c, models });
    return pack;
  }

  of(by: PedAgent): DogPack | null { return this.list.find((p) => p.by === by)?.pack ?? null; }

  /** The whistle: the pack lunges at the point. False: no pack (or no dog left in it). */
  sic(by: PedAgent, x: number, z: number): boolean { return (this.of(by)?.sic(x, z) ?? 0) > 0; }

  update(dt: number): void {
    this.t += dt;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const P = this.list[i];
      P.pack.update(dt);
      P.pack.dogs.forEach((d, k) => {
        const m = P.models[k], o = m.object;
        o.visible = d.state !== 'gone';
        if (!o.visible) return;
        o.position.set(d.x, d.y, d.z);
        o.rotation.set(0, d.heading, d.state === 'down' ? Math.PI / 2 : 0);
        if (d.state === 'down') o.position.y += 0.15;
        m.update(dt, d.frozen > 0 || d.state === 'down' ? 0 : Math.hypot(d.vx, d.vz), this.t + k);
      });
      if (P.pack.done) { this.drop(P); this.list.splice(i, 1); }
    }
  }

  /** A blow or a power round a point: dogs in reach take it. Their positions (for effects). */
  hit(x: number, y: number, z: number, r: number, effect: HitEffect, dmg: number, fling: number): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = [];
    for (const P of this.list) {
      if (Math.hypot(P.by.x - x, P.by.z - z) > DOGS.leash + r + 10) continue;
      for (const d of P.pack.hit(x, y, z, r, effect, dmg, fling)) out.push({ x: d.x, y: d.y + 0.4, z: d.z });
    }
    return out;
  }

  /** Dogs in the fight (the actor budget, tests). */
  get dogs(): number { let n = 0; for (const P of this.list) n += P.pack.active.length; return n; }

  snapshot(): { handler: number; dogs: ReturnType<DogPack['snapshot']>; stats: DogPack['stats'] }[] {
    return this.list.map((P) => ({ handler: P.by.id, dogs: P.pack.snapshot(), stats: P.pack.stats }));
  }

  dispose(): void {
    for (const P of this.list) this.drop(P);
    this.list.length = 0;
  }

  private drop(P: Pack): void {
    for (const m of P.models) this.g.renderer.scene.remove(m.object);
  }
}
