/**
 * Visual effects of the movement powers:
 *  - dash: afterimages — translucent, frozen copies of the body's current pose left along the
 *    path (each visible skinned mesh of the rig is re-drawn with a frozen copy of its bone
 *    matrices, so it works for the built-in human and imported avatars alike), plus dust
 *    kicked up at the feet;
 *  - super jump charge: energy motes gathering at the feet (rank 3+), ground dust pushed out
 *    by the pressure (rank 4+);
 *  - super speed: a trail of afterimages, dust (or spray, running on water) at the feet.
 */
import * as THREE from 'three';
import type { Player } from '../../player/Player';
import type { Dust } from '../../destruction/Dust';

/** An afterimage: a copy of the rig's meshes with its own material and frozen skeletons (pooled, see spawnGhost). */
interface Ghost { group: THREE.Group; mat: THREE.MeshBasicMaterial; skels: THREE.Skeleton[]; t: number; life: number; a0: number; on: boolean }

/** Afterimages kept ready (super speed leaves one every 70 ms for 0.3 s; a dash up to 5). */
const GHOST_POOL = 8;

const GHOST_COLOR = new THREE.Color(0.55, 0.78, 1.0);
const ENERGY = new THREE.Color(0.6, 0.82, 1.0).multiplyScalar(2.2);
const GROUND = new THREE.Color(0.62, 0.6, 0.56);
const SPRAY = new THREE.Color(0.85, 0.9, 0.95);

export class PowerFx {
  private ghosts: Ghost[] = [];
  /** The rig meshes the pooled afterimages copy (rebuilt when they change: an outfit, a new avatar). */
  private ghostSrc: THREE.Mesh[] = [];
  private readonly srcScratch: THREE.Mesh[] = [];
  private dashLeft = 0;
  private dashEvery = 0;
  private dashNext = 0;
  private ghostsLeft = 0;
  private chargeT = 0;
  private dustT = 0;
  private speedT = 0;
  /** Body position at the previous frame (afterimages due in between are placed along the path). */
  private readonly last = new THREE.Vector3();

  constructor(private scene: THREE.Scene, private dust: Dust, private player: Player) {}

  /** A dash starts: afterimages over its duration (3 … 5 by rank). */
  dash(dur: number, rank: number): void {
    this.ghostsLeft = 3 + Math.round(Math.min(2, (rank - 1) / 2));
    this.dashLeft = dur;
    this.dashEvery = dur / this.ghostsLeft;
    this.dashNext = 0;
    this.last.copy(this.player.pos);
  }

  /** Per frame: charge = super jump charge 0..1 (< 0: none), jumpRank for its effects. */
  update(dt: number, charge: number, jumpRank: number): void {
    const p = this.player, h = p.height, sk = Math.sqrt(p.k);
    // ---- dash afterimages and kicked-up dust
    if (this.ghostsLeft > 0) {
      this.dashLeft -= dt;
      this.dashNext -= dt;
      // Every afterimage due this frame (several at low frame rates), spaced along the frame's path.
      while (this.ghostsLeft > 0 && (this.dashNext <= 0 || !p.dashing)) {
        const back = Math.max(0, Math.min(1, -this.dashNext / Math.max(1e-3, dt)));
        this.dashNext += this.dashEvery;
        this.ghostsLeft--;
        this.spawnGhost(0.36 * Math.max(0.6, sk), 0.42, back);
      }
    }
    this.last.copy(p.pos);
    // ---- super speed: afterimages and kicked-up dust / spray
    const hs = Math.hypot(p.vel.x, p.vel.z);
    if (p.speeding && hs > 10 * sk) {
      this.speedT -= dt;
      if (this.speedT <= 0) {
        this.speedT = 0.07;
        this.spawnGhost(0.3 * Math.max(0.6, sk), 0.3);
        if (p.grounded) this.dust.burst(p.pos.x, p.pos.y + 0.05 * h, p.pos.z, 3, 0.25 * h, 0.6 * h, 0.14 * h + 0.05, 1, p.onWater ? SPRAY : GROUND, 0.1, p.onWater ? 0.5 : 0.3);
      }
    }
    if (p.dashing && p.grounded) {
      this.dustT -= dt;
      if (this.dustT <= 0) {
        this.dustT = 0.03;
        this.dust.burst(p.pos.x, p.pos.y + 0.05 * h, p.pos.z, 2, 0.2 * h, 0.5 * h, 0.12 * h + 0.05, 0.9, GROUND, 0.1, 0.3);
      }
    }
    for (const g of this.ghosts) {
      if (!g.on) continue;
      g.t += dt;
      const u = g.t / g.life;
      if (u >= 1) { g.on = false; g.group.visible = false; continue; }
      g.mat.opacity = g.a0 * (1 - u) * (1 - u);
    }
    // ---- super jump charge
    if (charge >= 0 && jumpRank >= 3 && !p.flying) {
      this.chargeT -= dt;
      if (this.chargeT <= 0) {
        this.chargeT = 0.05;
        const n = 1 + (jumpRank >= 5 ? 2 : 1) + Math.round(charge * 2);
        // Motes start around the feet and drift in (negative outward speed) while rising a little.
        this.dust.burst(p.pos.x, p.pos.y + 0.04 * h, p.pos.z, n, 0.6 * h, -(0.5 + 1.2 * charge) * h, 0.035 * h, 0.5, ENERGY, 0.9, 0.25 + 0.35 * charge);
        if (jumpRank >= 4 && charge > 0.4 && Math.random() < 0.5) this.dust.burst(p.pos.x, p.pos.y + 0.02 * h, p.pos.z, 2, 0.25 * h, 0.5 * h * charge, 0.1 * h, 0.8, GROUND, 0.05, 0.25);
      }
    } else this.chargeT = 0;
  }

  /**
   * Freeze the body's current pose as a fading, glowing copy. The copies are pooled: made once
   * (meshes sharing the rig's geometry, one material and one frozen skeleton each) and posed
   * again on reuse. (A new copy every 70 ms, with its materials, skinned meshes and bone
   * textures, made super speed render at 20–30 fps with stops of up to 300 ms on a PC that
   * draws the same street at 60 fps without them.)
   */
  private spawnGhost(life: number, alpha: number, back = 0): void {
    const root = this.player.rig.object;
    root.updateMatrixWorld(true);
    const src = this.srcScratch;
    src.length = 0;
    root.traverseVisible((o) => {
      if ((o as THREE.Mesh).isMesh && !(o as THREE.InstancedMesh).isInstancedMesh) src.push(o as THREE.Mesh);
    });
    if (!src.length) return;
    if (src.length !== this.ghostSrc.length || src.some((m, i) => m !== this.ghostSrc[i] || m.geometry !== this.ghosts[0]?.group.children[i]?.userData.geo)) this.rebuildGhosts(src);
    // A free copy, else the oldest one.
    let g = this.ghosts.find((q) => !q.on);
    if (!g) g = this.ghosts.reduce((a, q) => (q.t > a.t ? q : a));
    // The pose now: each frozen skeleton recomputed from the rig's bones (three's own update; the
    // copy's per-frame update is a no-op so it holds the pose).
    for (const sk of g.skels) THREE.Skeleton.prototype.update.call(sk);
    src.forEach((m, i) => {
      const c = g.group.children[i];
      c.matrix.copy(m.matrixWorld);
      c.matrixWorldNeedsUpdate = true;
    });
    // Shifted back toward where the body was `back` (0..1) of a frame ago.
    g.group.position.subVectors(this.last, this.player.pos).multiplyScalar(back);
    g.group.visible = true;
    g.on = true;
    g.t = 0;
    g.life = life;
    g.a0 = alpha;
    g.mat.opacity = alpha;
  }

  /** New pooled copies of these rig meshes. */
  private rebuildGhosts(src: THREE.Mesh[]): void {
    for (const g of this.ghosts) this.dispose(g);
    this.ghosts = [];
    this.ghostSrc = src.slice();
    for (let n = 0; n < GHOST_POOL; n++) {
      const group = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: GHOST_COLOR, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: true });
      const g: Ghost = { group, mat, skels: [], t: 0, life: 1, a0: 0, on: false };
      // The body and everything worn share one skeleton: so does the copy.
      const frozen = new Map<THREE.Skeleton, THREE.Skeleton>();
      for (const s of src) {
        const ss = s as THREE.SkinnedMesh;
        let m: THREE.Mesh;
        if (ss.isSkinnedMesh && ss.skeleton) {
          let skel = frozen.get(ss.skeleton);
          if (!skel) {
            skel = new THREE.Skeleton(ss.skeleton.bones, ss.skeleton.boneInverses);
            skel.update = () => {};
            frozen.set(ss.skeleton, skel);
            g.skels.push(skel);
          }
          const sm = new THREE.SkinnedMesh(ss.geometry, mat);
          // Attached binding with the source's world matrix reproduces its bind inverse exactly.
          sm.bind(skel, ss.bindMatrix);
          sm.bindMode = ss.bindMode;
          m = sm;
        } else m = new THREE.Mesh(s.geometry, mat);
        m.userData.geo = s.geometry;
        m.matrixAutoUpdate = false;
        m.frustumCulled = false;
        m.renderOrder = 9;
        group.add(m);
      }
      group.visible = false;
      this.scene.add(group);
      this.ghosts.push(g);
    }
  }

  private dispose(g: Ghost): void {
    this.scene.remove(g.group);
    g.mat.dispose();
    for (const s of g.skels) s.dispose();
  }
}
