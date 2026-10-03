/**
 * The near-future layer of the city (PLAYGROUND_PLAN §0 decision 16): sidewalk delivery
 * robots, drones, animated signage and holographic kiosks. One object for the game to
 * construct, update and forward strikes to; it listens to world stimuli (giant footsteps,
 * collapses, crashes, blasts) itself.
 */
import * as THREE from 'three';
import { createFurnitureMaterial } from '../props/furniture';
import { hitch } from '../debug/HitchLog';
import type { Stimuli } from '../game/Stimuli';
import { Robots } from './Robots';
import { Drones, DKind } from './Drones';
import { Signs } from './Signs';
import type { FutureCtx, PlayerProbe } from './ctx';

export type { FutureCtx, PlayerProbe } from './ctx';

type Loop = { set(x: number, y: number, z: number, gain: number, rate?: number): void; stop(): void };

export class NearFuture {
  readonly group = new THREE.Group();
  readonly robots: Robots;
  readonly drones: Drones;
  readonly signs: Signs;
  private buzz: Loop | null = null;
  private buzzTry = 0;
  /** Positional loop factory (Audio.loop), optional. */
  loop: ((id: string, refDist?: number) => Loop | null) | null = null;
  private px = 0;
  private pz = 0;
  private playerH = 1.8;
  stats = { ms: 0 };

  constructor(ctx: FutureCtx, stimuli: Stimuli) {
    // Same program as the street furniture (shared cache key), so nothing new to compile.
    const mat = createFurnitureMaterial();
    this.robots = new Robots(ctx, mat);
    this.drones = new Drones(ctx, mat);
    this.signs = new Signs(ctx, mat);
    this.group.add(this.robots.group, this.drones.group, this.signs.group);
    stimuli.on((s) => {
      switch (s.kind) {
        case 'stomp': {
          // A giant's foot flattens robots (and parcels' carriers) under it.
          if (this.playerH > 2.5) this.robots.crush(s.x, s.z, Math.max(0.6, this.playerH * 0.09));
          break;
        }
        case 'collapse': {
          const r = Math.min(40, Math.max(8, s.radius * 0.04));
          this.robots.crush(s.x, s.z, r);
          this.signs.impact(s.x, s.y, s.z, r, true);
          this.drones.incident(DKind.News, s.x, s.z, this.px, this.pz);
          break;
        }
        case 'blast': {
          this.signs.impact(s.x, s.y, s.z, 14, true);
          for (const r of this.robots.list) {
            const dx = r.x - s.x, dz = r.z - s.z, d = Math.hypot(dx, dz);
            if (d < 14 && d > 1e-3) this.robots.knock(r, (dx / d) * 3000 / Math.max(1, d), 800, (dz / d) * 3000 / Math.max(1, d));
          }
          this.drones.hit(s.x, s.y, s.z, 12, 0, 400, 0);
          break;
        }
        case 'crash': this.drones.incident(DKind.Police, s.x, s.z, this.px, this.pz); break;
        case 'impact': case 'glass': this.signs.impact(s.x, s.y, s.z, 3, false); break;
        default: break;
      }
    });
  }

  update(dt: number, hours: number, focus: THREE.Vector3, player: PlayerProbe, cam: THREE.Camera): void {
    const t0 = performance.now();
    this.px = focus.x; this.pz = focus.z; this.playerH = player.height;
    hitch.measure('future:robots', () => this.robots.update(dt, hours, focus.x, focus.z, player, cam));
    hitch.measure('future:drones', () => this.drones.update(dt, hours, focus.x, focus.z, player, cam));
    hitch.measure('future:signs', () => this.signs.update(dt, cam));
    this.updateBuzz(dt, cam);
    this.stats.ms = this.stats.ms * 0.95 + (performance.now() - t0) * 0.05;
  }

  /** The nearest drone's rotors (one positional loop is enough: they are quiet beyond ~40 m). */
  private updateBuzz(dt: number, cam: THREE.Camera): void {
    const c = cam.position;
    const n = this.drones.nearest(c.x, c.y, c.z);
    if (!this.buzz) {
      this.buzzTry -= dt;
      if (n.d > 60 || !this.loop || this.buzzTry > 0) return;
      this.buzzTry = 2;
      this.buzz = this.loop('drone_buzz', 4);
      if (!this.buzz) return;
    }
    if (!n.drone || n.d > 70) { this.buzz.set(c.x, c.y, c.z, 0); return; }
    const d = n.drone;
    const sp = Math.hypot(d.vx, d.vy, d.vz);
    this.buzz.set(d.x, d.y, d.z, Math.min(1, 1.2 - n.d / 70), 0.92 + sp * 0.012 + d.phase * 0.08);
  }

  /** A physical strike (punch, swat, thrown thing): robots, drones, signs and kiosks near it. */
  hit(x: number, y: number, z: number, r: number, jx: number, jy: number, jz: number): void {
    this.robots.hit(x, y, z, r, jx, jy, jz);
    this.drones.hit(x, y, z, r, jx, jy, jz);
    const J = Math.hypot(jx, jy, jz);
    if (J > 1200) this.signs.impact(x, y, z, r + 0.8, J > 3500);
  }

  /** Short debug summary (window.game.future.report()). */
  report(): string {
    const r = this.robots.stats, d = this.drones.stats, s = this.signs.stats;
    return `robots ${r.robots}/${r.target} (hubs ${r.hubs}, drawn ${r.drawn}, knocked ${r.knocked}, broken ${r.broken}) · drones ${d.drones}/${d.target} (drawn ${d.drawn}, swatted ${d.swatted}) · signs ${s.signs} in ${s.cells} cells (drawn ${s.drawn}, broken ${s.broken}), kiosks ${s.kiosks} · ${this.stats.ms.toFixed(2)} ms`;
  }

}
