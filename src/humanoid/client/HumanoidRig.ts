/**
 * A complete animated humanoid for one entity: asynchronous body build
 * (with a lightweight placeholder until ready), Character + Animator +
 * EquipmentRig, LOD switching by camera distance and update throttling for
 * distant characters. Used by HumanoidViews, HumanoidPreview and the sandbox.
 */
import { frameWork } from '../../core/frameWork';
import * as THREE from 'three';
import type { HumanoidAppearance } from '../types';
import type { AnimState, Vec3 } from '../../shared/types';
import { EntFlag } from '../../shared/types';
import type { EquipmentVisuals } from '../../items/types';
import { BodyService, geometryKey } from './BodyService';
import { Character } from './Character';
import { Animator, type GroundFn } from './anim/Animator';
import { EquipmentRig } from './equipment';

export interface RigSnap {
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  anim: AnimState;
  flags: number;
  equipment?: EquipmentVisuals;
  scale?: number;
}

export interface RigOptions {
  /** Build priority (lower = sooner), e.g. distance to the camera. */
  priority?: number;
  castShadow?: boolean;
  ground?: GroundFn | null;
  /** Weapons always in hand (players, previews). */
  alwaysDrawn?: boolean;
  /** Fixed LOD (previews); otherwise chosen from camera distance. */
  fixedLod?: number;
}

const LOD_DIST = [11, 32];

/** Cumulative main-thread cost of finishing characters, by step (diagnostics, ms). */
export const rigBuildStats = { builds: 0, character: 0, rig: 0, add: 0, equipment: 0 };
if (typeof window !== 'undefined') (window as unknown as { norgoRigStats?: typeof rigBuildStats }).norgoRigStats = rigBuildStats;
const _p = new THREE.Vector3();

export class HumanoidRig {
  readonly object = new THREE.Group();
  char: Character | null = null;
  animator: Animator | null = null;
  equipment: EquipmentRig | null = null;
  readonly ready: Promise<void>;
  private placeholder: THREE.Mesh | null = null;
  private pendingEq: EquipmentVisuals | undefined;
  private skyVis = 1;
  private visible = true;
  private accum = 0;
  private frame = 0;
  private lastCombat = -100;
  private disposed = false;
  private geoKey: string;
  height = 1.8;

  constructor(public app: HumanoidAppearance, private opts: RigOptions = {}) {
    this.object.name = 'humanoid-rig';
    this.geoKey = geometryKey(app);
    this.makePlaceholder();
    this.ready = this.build();
  }

  private makePlaceholder() {
    const a = this.app;
    const h = 1.72 * a.scale * (0.88 + a.height * 0.24) * (a.age < 0.3 ? 0.6 + a.age : 1);
    this.height = h;
    const r = 0.17 * a.scale * (0.85 + a.weight * 0.4);
    const geo = new THREE.CapsuleGeometry(r, Math.max(0.1, h - r * 2), 4, 10);
    geo.translate(0, h / 2, 0);
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(a.skinTone[0], a.skinTone[1], a.skinTone[2], THREE.SRGBColorSpace), roughness: 0.8, transparent: true, opacity: 0.55 });
    this.placeholder = new THREE.Mesh(geo, mat);
    this.placeholder.castShadow = false;
    this.object.add(this.placeholder);
  }

  private async build() {
    const svc = BodyService.get();
    const geo = await svc.geometry(this.app, this.opts.priority ?? 0);
    if (this.disposed) return;
    // The expensive main-thread part runs in a frame-budgeted slot (see core/frameWork).
    await new Promise<void>((done) => frameWork.run(() => {
      try {
        this.finishBuild(geo);
      } finally {
        done();
      }
    }, this.opts.priority ?? 1, 'character'));
  }

  private finishBuild(geo: Awaited<ReturnType<BodyService['geometry']>>) {
    if (this.disposed) return;
    const T = rigBuildStats;
    let t = performance.now();
    const ch = new Character(geo, this.app, { castShadow: this.opts.castShadow });
    T.character += performance.now() - t;
    this.char = ch;
    t = performance.now();
    this.animator = new Animator(ch);
    this.equipment = new EquipmentRig(ch);
    T.rig += performance.now() - t;
    this.height = geo.build.body.height;
    t = performance.now();
    // Hidden (placeholder stays) until dressed: the outfit is built piece by piece over the
    // next frames (see EquipmentRig.set), and nobody should pop in undressed.
    ch.object.visible = false;
    this.object.add(ch.object);
    T.add += performance.now() - t;
    ch.setSkyVis(this.skyVis);
    if (this.opts.fixedLod !== undefined) ch.setLod(this.opts.fixedLod);
    T.builds++;
    const prio = this.opts.priority ?? 1;
    this.equipment.set(this.pendingEq, (job, label) => frameWork.run(() => {
      const t0 = performance.now();
      job();
      T.equipment += performance.now() - t0;
    }, prio, label), () => {
      if (this.disposed || this.char !== ch) return;
      this.equipment?.setSkyVis(this.skyVis);
      ch.object.visible = true;
      if (this.placeholder) {
        this.placeholder.removeFromParent();
        this.placeholder.geometry.dispose();
        (this.placeholder.material as THREE.Material).dispose();
        this.placeholder = null;
      }
    });
  }

  /** Change appearance: recolours in place, rebuilds geometry if the shape changed. */
  async setAppearance(app: HumanoidAppearance) {
    const key = geometryKey(app);
    this.app = app;
    if (key === this.geoKey && this.char) {
      this.char.recolor(app);
      return;
    }
    this.geoKey = key;
    const svc = BodyService.get();
    const geo = await svc.geometry(app, 0);
    if (this.disposed || this.geoKey !== key) return;
    // Finishing a character (materials, skeleton, clothing) is the expensive main-thread
    // part: run it in a frame-budgeted slot, so bodies arriving together don't freeze a frame.
    frameWork.run(() => this.finish(geo, app, key), this.opts.priority ?? 1, 'character (new look)');
  }

  private finish(geo: Awaited<ReturnType<BodyService['geometry']>>, app: HumanoidAppearance, key: string) {
    if (this.disposed || this.geoKey !== key) return;
    const old = this.char, oldEq = this.equipment;
    const svc = BodyService.get();
    const ch = new Character(geo, app, { castShadow: this.opts.castShadow });
    oldEq?.dispose();
    old?.dispose();
    this.char = ch;
    this.animator = new Animator(ch);
    this.equipment = new EquipmentRig(ch);
    this.height = geo.build.body.height;
    this.object.add(ch.object);
    ch.object.visible = this.visible;
    ch.setSkyVis(this.skyVis);
    this.equipment.set(this.pendingEq);
    this.equipment.setSkyVis(this.skyVis);
    if (this.opts.fixedLod !== undefined) ch.setLod(this.opts.fixedLod);
    svc.collect();
  }

  /** What it wears now (the last setEquipment). */
  get outfit(): EquipmentVisuals | undefined { return this.pendingEq; }

  /** Dressed: the body built and the outfit on (the placeholder capsule gone). */
  get dressed(): boolean { return !!this.char && !this.placeholder; }

  setEquipment(eq: EquipmentVisuals | undefined) {
    this.pendingEq = eq;
    this.equipment?.set(eq);
  }

  /**
   * Per-frame update. `camPos` selects the LOD; distant characters animate at a
   * reduced rate (their dt accumulates).
   */
  update(s: RigSnap, dt: number, time: number, camPos?: THREE.Vector3) {
    this.object.position.set(s.pos[0], s.pos[1], s.pos[2]);
    this.object.rotation.y = s.yaw;
    const sc = s.scale ?? 1;
    this.object.scale.setScalar(sc);
    if ('equipment' in s) this.setEquipment(s.equipment);
    const ch = this.char, an = this.animator;
    if (!ch || !an) return;
    let lod = this.opts.fixedLod ?? 0;
    if (this.opts.fixedLod === undefined && camPos) {
      const d = _p.set(s.pos[0], s.pos[1] + 1, s.pos[2]).distanceTo(camPos) / Math.max(0.6, this.app.scale * sc);
      const cur = ch.lod;
      // Hysteresis avoids LOD flicker at the thresholds.
      lod = d < LOD_DIST[0] - (cur === 0 ? -1 : 1) ? 0 : d < LOD_DIST[1] - (cur === 1 ? -2 : 2) ? 1 : 2;
      if (lod !== cur) ch.setLod(lod);
    }
    // Throttle animation far away.
    this.frame++;
    this.accum += dt;
    const every = lod === 2 ? 3 : lod === 1 ? 2 : 1;
    if (this.frame % every !== 0) return;
    const step = this.accum;
    this.accum = 0;
    const eq = this.equipment!;
    const combat = (s.flags & EntFlag.InCombat) !== 0 || (s.flags & EntFlag.Hostile) !== 0;
    if (s.anim.action) this.lastCombat = time;
    eq.setDrawn(!!this.opts.alwaysDrawn || combat || time - this.lastCombat < 6);
    an.update(
      { anim: s.anim, vel: s.vel, yaw: s.yaw, time, main: eq.drawn ? eq.main : (eq.main === 'torch' ? 'torch' : 'none'), off: eq.drawn ? eq.off : (eq.off === 'torch' ? 'torch' : 'none'), combat, sneaking: (s.flags & EntFlag.Sneaking) !== 0 },
      step,
      lod,
      lod === 0 ? this.opts.ground ?? null : null,
    );
    eq.update(time);
  }

  onHit(fromX: number, fromZ: number, amount: number) {
    if (!this.animator) return;
    const dx = this.object.position.x - fromX, dz = this.object.position.z - fromZ;
    const l = Math.hypot(dx, dz) || 1;
    this.animator.onHit(dx / l, dz / l, amount);
  }

  getSocket(name: string): THREE.Object3D | null {
    if (!this.char) return null;
    const alias: Record<string, string> = { 'hand.R': 'grip.R', 'hand.L': 'grip.L' };
    return this.char.sockets.get(alias[name] ?? name) ?? this.char.sockets.get(name) ?? null;
  }

  setSkyVis(v: number) {
    this.skyVis = v;
    this.char?.setSkyVis(v);
    this.equipment?.setSkyVis(v);
  }

  setVisible(v: boolean) {
    this.visible = v;
    this.object.visible = v;
  }

  dispose() {
    this.disposed = true;
    this.equipment?.dispose();
    this.char?.dispose();
    if (this.placeholder) {
      this.placeholder.geometry.dispose();
      (this.placeholder.material as THREE.Material).dispose();
    }
    this.object.removeFromParent();
  }
}
