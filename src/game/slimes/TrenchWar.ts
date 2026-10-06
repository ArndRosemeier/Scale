/**
 * The trench war in the Warrens' mouth, at the foot of the Throat (`SlimeRealm`), while the Lumen hold
 * their line and the player is near: it never stops.
 *
 *  - Pushes: every few seconds a handful of Murk come out of the Warrens, gather at their berm and go
 *    over, across no-man's land at the trench's gaps. The sentries lob bolts at them, the
 *    thorn wire holds them up, the gaps are fought hand to hand; few get far. (The war's strength
 *    is not touched by these: only the raids decide the line. The Murk the player kills still count.)
 *  - Relief: Lumen fallen in the trench are replaced from behind, one at a time.
 *  - Flares: the Lumen send glowing flares up over no-man's land; they hang and sink slowly.
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import type { Factions } from '../../underground/deep/Factions';
import type { DeepPlan } from '../../underground/deep/plan';
import type { DeepField } from '../../underground/deep/field';

export const TRENCH = {
  /** Seconds between pushes, Murk in one (more as the Murk grow), most alive at once. */
  gap: [6, 13] as [number, number], size: [2, 4] as [number, number], most: 9,
  /** A brute now and then, once the Murk are strong. */
  brute: 0.1, bruteMurk: 0.6,
  /** Seconds between reliefs, between flares; how long a flare burns. */
  relief: 7, flare: [3.5, 7] as [number, number], burn: 7,
};

interface Flare { s: THREE.Sprite; x: number; y: number; z: number; vx: number; vy: number; vz: number; t: number; top: number }

export class TrenchWar {
  readonly group = new THREE.Group();
  private pushT = 3;
  private reliefT = TRENCH.relief;
  private flareT = 1.5;
  private flares: Flare[] = [];
  private mat: THREE.SpriteMaterial;
  /** Statistics (dev console, tests). */
  stats = { pushes: 0, murk: 0, relieved: 0, flares: 0 };

  constructor(private g: Game | null, private F: Factions, private P: DeepPlan, private field: DeepField) {
    this.mat = new THREE.SpriteMaterial({ color: new THREE.Color(0.75, 1.0, 0.92), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, map: typeof document !== 'undefined' ? flareTexture() : null });
    this.group.name = 'trench-flares';
  }

  /** How many sentries the line has at this state of the war (the trench's spots and its gaps). */
  static sentries(P: DeepPlan, lumen: number, front: number): number {
    return Math.min(P.trench.posts.length, Math.max(3, Math.round(12 * lumen * (1 - front))));
  }

  /**
   * Per frame. `on`: the Lumen hold the line, the trench is populated and the player is near; `raid`:
   * a raid is on (no pushes of its own then); `murk`, `lumen`, `front`: the war's state.
   */
  update(dt: number, on: boolean, raid: boolean, murk: number, lumen: number, front: number): void {
    this.flareTick(dt, on);
    if (!on) return;
    const F = this.F, P = this.P;
    // Pushes.
    this.pushT -= dt;
    if (this.pushT <= 0 && !raid) {
      this.pushT = TRENCH.gap[0] + Math.random() * (TRENCH.gap[1] - TRENCH.gap[0]);
      const alive = F.blobs.filter((b) => b.area === 'push' && b.mode !== 'dead').length;
      const n = Math.min(TRENCH.most - alive, TRENCH.size[0] + Math.floor(Math.random() * (TRENCH.size[1] - TRENCH.size[0] + 1 + murk * 1.5)));
      if (n > 0) this.push(n, murk >= TRENCH.bruteMurk && Math.random() < TRENCH.brute);
    }
    // Relief for the fallen.
    this.reliefT -= dt;
    if (this.reliefT <= 0) {
      this.reliefT = TRENCH.relief;
      const T = P.trench, spots = [...T.gapPosts, ...T.posts.slice(0, TrenchWar.sentries(P, lumen, front))];
      const held = F.blobs.filter((b) => b.role === 'sentry' && b.mode !== 'dead' && b.den);
      const free = spots.find((q) => !held.some((b) => Math.hypot(b.den!.x - q.x, b.den!.z - q.z) < 0.3));
      const from = P.places.bottom;
      if (free && from) {
        const b = F.spawn('lumen', 'sentry', from.x + (Math.random() - 0.5) * 3, from.y, from.z + (Math.random() - 0.5) * 3, 'trench');
        b.den = { ...free };
        this.stats.relieved++;
      }
    }
  }

  /** A push: Murk out of the Warrens, over their berm, at the gaps. */
  push(n: number, brute = false): void {
    const F = this.F, P = this.P, T = P.trench;
    const line = P.nodes.find((q) => q.name === 'murkLine');
    const gaps = P.nodes.filter((q) => q.name.startsWith('trench'));
    const back = P.nodes.find((q) => q.name === 'bottom');
    if (!line || !gaps.length) return;
    for (let i = 0; i < n; i++) {
      const role = i === 0 && brute ? 'brute' : Math.random() < 0.6 ? 'raider' : 'drone';
      // Out of sight behind the berm, where the Warrens open.
      const s = T.murkS + 8 + Math.random() * 6, l = (Math.random() - 0.5) * 10;
      const x = T.x + T.ax * s + T.cx * l, z = T.z + T.az * s + T.cz * l;
      const y = this.field.floorAt(x, T.y + 3, z, 8) ?? line.y;
      const b = F.spawn('murk', role, x, y, z, 'push');
      b.wait = i * (0.4 + Math.random() * 0.6);
      b.ttl = 160;
      F.goTo(b, line.id);
      const gap = gaps[Math.floor(Math.random() * gaps.length)];
      b.path.push(...F.route(line.id, gap.id));
      if (back) b.path.push(...F.route(gap.id, back.id));
    }
    this.stats.pushes++;
    this.stats.murk += n;
    this.g?.audio.play('murk_growl', line.x, line.y, line.z, 0.8, 0.7 + Math.random() * 0.3, 30, this.g.renderer.camera.position);
  }

  private flareTick(dt: number, on: boolean): void {
    if (on && this.g) {
      this.flareT -= dt;
      if (this.flareT <= 0) { this.flareT = TRENCH.flare[0] + Math.random() * (TRENCH.flare[1] - TRENCH.flare[0]); this.launch(); }
    }
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i];
      f.t += dt;
      // Up fast, then hanging under its glow, sinking and drifting.
      if (f.vy > -0.45) f.vy -= 9.8 * dt; else f.vy = -0.45;
      if (f.y > f.top && f.vy > 0) f.vy = 0;
      f.vx *= 1 - Math.min(1, dt * 0.6); f.vz *= 1 - Math.min(1, dt * 0.6);
      f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
      const fade = Math.min(1, f.t * 3) * Math.max(0, 1 - Math.max(0, f.t - TRENCH.burn + 1.5) / 1.5);
      const flick = 0.8 + 0.2 * Math.sin(f.t * 31) * Math.sin(f.t * 17);
      f.s.position.set(f.x, f.y, f.z);
      const sz = (f.vy > 0 ? 0.8 : 2.6) * flick;
      f.s.scale.set(sz, sz, 1);
      (f.s.material as THREE.SpriteMaterial).opacity = fade;
      if (f.t > TRENCH.burn) { f.s.removeFromParent(); (f.s.material as THREE.Material).dispose(); this.flares.splice(i, 1); }
    }
  }

  private launch(): void {
    const T = this.P.trench, g = this.g!;
    const from = T.posts[Math.floor(Math.random() * T.posts.length)];
    if (!from) return;
    const s = T.noMans[0] + Math.random() * (T.noMans[1] - T.noMans[0]), l = (Math.random() - 0.5) * 10;
    const tx = T.x + T.ax * s + T.cx * l, tz = T.z + T.az * s + T.cz * l;
    const ceil = this.field.ceilingAt(tx, T.y + 2, tz, 30);
    const top = Math.min(T.y + 8.5, (Number.isFinite(ceil) ? ceil : T.y + 12) - 1.5);
    const up = Math.max(4, top - from.y), vy = Math.sqrt(2 * 9.8 * up), t = vy / 9.8;
    const s0 = new THREE.Sprite(this.mat.clone());
    s0.renderOrder = 8;
    this.group.add(s0);
    this.flares.push({ s: s0, x: from.x, y: from.y + 1.2, z: from.z, vx: (tx - from.x) / t, vy, vz: (tz - from.z) / t, t: 0, top });
    this.stats.flares++;
    g.audio.play('membrane', from.x, from.y + 1, from.z, 0.35, 1.8, 12, g.renderer.camera.position);
  }

  dispose(): void {
    for (const f of this.flares) { f.s.removeFromParent(); (f.s.material as THREE.Material).dispose(); }
    this.flares.length = 0;
    this.mat.dispose();
  }
}

function flareTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.12, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
