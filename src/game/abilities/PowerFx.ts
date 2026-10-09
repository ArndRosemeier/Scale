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

interface Ghost { group: THREE.Group; mats: THREE.MeshBasicMaterial[]; skels: THREE.Skeleton[]; t: number; life: number; a0: number }

const GHOST_COLOR = new THREE.Color(0.55, 0.78, 1.0);
const ENERGY = new THREE.Color(0.6, 0.82, 1.0).multiplyScalar(2.2);
const GROUND = new THREE.Color(0.62, 0.6, 0.56);
const SPRAY = new THREE.Color(0.85, 0.9, 0.95);

export class PowerFx {
  private ghosts: Ghost[] = [];
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
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const g = this.ghosts[i];
      g.t += dt;
      const u = g.t / g.life;
      if (u >= 1) { this.dispose(g); this.ghosts.splice(i, 1); continue; }
      const a = g.a0 * (1 - u) * (1 - u);
      for (const m of g.mats) m.opacity = a;
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

  /** Freeze the body's current pose as a fading, glowing copy. */
  private spawnGhost(life: number, alpha: number, back = 0): void {
    const root = this.player.rig.object;
    root.updateMatrixWorld(true);
    const group = new THREE.Group();
    // (One material for the whole copy: super speed leaves one every 70 ms.)
    const mat = new THREE.MeshBasicMaterial({ color: GHOST_COLOR, transparent: true, opacity: alpha, blending: THREE.AdditiveBlending, depthWrite: false, fog: true });
    const g: Ghost = { group, mats: [mat], skels: [], t: 0, life, a0: alpha };
    root.traverseVisible((o) => {
      const src = o as THREE.SkinnedMesh;
      if (!(o as THREE.Mesh).isMesh || (o as THREE.InstancedMesh).isInstancedMesh) return;
      let m: THREE.Mesh;
      if (src.isSkinnedMesh && src.skeleton) {
        // Same geometry, a frozen copy of the bone matrices (Skeleton.update made a no-op).
        const skel = new THREE.Skeleton(src.skeleton.bones, src.skeleton.boneInverses);
        skel.update();
        skel.update = () => {};
        const sm = new THREE.SkinnedMesh(src.geometry, mat);
        // Attached binding with the source's world matrix reproduces its bind inverse exactly.
        sm.bind(skel, src.bindMatrix);
        sm.bindMode = src.bindMode;
        g.skels.push(skel);
        m = sm;
      } else m = new THREE.Mesh(src.geometry, mat);
      m.matrixAutoUpdate = false;
      m.matrix.copy(src.matrixWorld);
      m.frustumCulled = false;
      m.renderOrder = 9;
      group.add(m);
    });
    if (!group.children.length) { mat.dispose(); return; }
    // Shifted back toward where the body was `back` (0..1) of a frame ago.
    group.position.subVectors(this.last, this.player.pos).multiplyScalar(back);
    this.scene.add(group);
    this.ghosts.push(g);
  }

  private dispose(g: Ghost): void {
    this.scene.remove(g.group);
    for (const m of g.mats) m.dispose();
    for (const s of g.skels) s.dispose();
  }
}
