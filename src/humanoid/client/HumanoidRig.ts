/**
 * A complete animated person for one entity: asynchronous build of its Actors character (with a
 * lightweight placeholder until it is dressed), Character + Animator + EquipmentRig, Actors'
 * detail levels by camera distance and update throttling for distant characters. Used by the
 * player, the crowd's near people, the hero statue and the shader warm-up.
 */
import { frameWork } from '../../core/frameWork';
import * as THREE from 'three';
import type { AnimState, Vec3 } from '../../shared/types';
import { EntFlag } from '../../shared/types';
import type { EquipmentVisuals } from '../../items/types';
import { Character } from './Character';
import { Animator, type GroundFn } from './anim/Animator';
import { EquipmentRig } from './equipment';
import { isActorLook, lookTraits, type Look } from '../actors/config';
import { HEADLESS } from '../actors/service';

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
  /** Fixed detail level (previews, statues); otherwise chosen from camera distance. */
  fixedLod?: number;
  /** Renderer for a photographic skin (the hero). */
  renderer?: unknown;
}

/** Cumulative main-thread cost of finishing characters, by step (diagnostics, ms). */
export const rigBuildStats = { builds: 0, character: 0, rig: 0, equipment: 0 };
if (typeof window !== 'undefined') (window as unknown as { scaleRigStats?: typeof rigBuildStats }).scaleRigStats = rigBuildStats;
const _p = new THREE.Vector3();

/** Key of a look's body (a change rebuilds the character; colours and outfit don't). */
function lookKey(l: Look): string {
  if (isActorLook(l)) {
    const c = l.actor;
    return JSON.stringify([c.body, c.details, c.robot, c.robotLook, c.race, c.race2, c.raceMix, c.raceSize, c.skin, c.skinColor, c.skinTone, c.skinPattern, c.patternColor, c.patternStrength, c.eyes, c.eyeColor, c.eyeGlow, c.pupil, c.hair, c.hairColor, c.beard, c.stubble, c.brows, c.horns, c.hornSize, c.hornColor, c.tusks, c.tail, c.tailLength, c.seed]);
  }
  return JSON.stringify(l);
}

export class HumanoidRig {
  readonly object = new THREE.Group();
  char: Character | null = null;
  animator: Animator | null = null;
  equipment: EquipmentRig | null = null;
  readonly ready: Promise<void>;
  /** Resolves once the first build is dressed and shown (the warm-up waits for the hero's). */
  readonly whenDressed: Promise<void>;
  private markDressed: () => void = () => undefined;
  private placeholder: THREE.Mesh | null = null;
  private pendingEq: EquipmentVisuals | undefined;
  private skyVis = 1;
  private visible = true;
  private accum = 0;
  private frame = 0;
  private lastCombat = -100;
  private disposed = false;
  private key: string;
  height = 1.8;

  constructor(public app: Look, private opts: RigOptions = {}) {
    this.object.name = 'humanoid-rig';
    this.key = lookKey(app);
    this.makePlaceholder();
    this.whenDressed = new Promise<void>((r) => { this.markDressed = r; });
    this.ready = this.build();
  }

  private makePlaceholder() {
    const t = lookTraits(this.app);
    const h = 1.72 * t.scale * (isActorLook(this.app) ? 0.88 + (this.app.actor.body?.height ?? 0.5) * 0.24 : 0.88 + this.app.height * 0.24);
    this.height = h;
    const r = 0.17 * t.scale * (0.85 + t.weight * 0.4);
    const geo = new THREE.CapsuleGeometry(r, Math.max(0.1, h - r * 2), 4, 10);
    geo.translate(0, h / 2, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0x8a7a6e, roughness: 0.8, transparent: true, opacity: 0.55 });
    this.placeholder = new THREE.Mesh(geo, mat);
    this.placeholder.castShadow = false;
    this.object.add(this.placeholder);
  }

  private async build() {
    if (HEADLESS) return;
    let ch: Character;
    try {
      ch = await Character.load(this.app, this.pendingEq, { castShadow: this.opts.castShadow, priority: this.opts.priority, renderer: this.opts.renderer });
    } catch (e) {
      console.warn('[humanoid] character build failed', e);
      return;
    }
    if (this.disposed) { ch.dispose(); return; }
    // Wiring the character up runs in a frame-budgeted slot (see core/frameWork).
    await new Promise<void>((done) => frameWork.run(() => {
      try {
        this.finish(ch, this.key);
      } finally {
        done();
      }
    }, this.opts.priority ?? 1, 'character'));
  }

  private finish(ch: Character, key: string) {
    if (this.disposed || key !== this.key) { ch.dispose(); return; }
    const T = rigBuildStats;
    let t = performance.now();
    const old = this.char, oldEq = this.equipment;
    oldEq?.dispose();
    old?.dispose();
    this.char = ch;
    this.animator = new Animator(ch);
    this.equipment = new EquipmentRig(ch);
    T.rig += performance.now() - t;
    this.height = ch.height;
    // Hidden (the placeholder stays) until dressed: nobody pops in undressed.
    ch.object.visible = false;
    this.object.add(ch.object);
    ch.setSkyVis(this.skyVis);
    if (this.opts.fixedLod !== undefined) ch.setLod(this.opts.fixedLod);
    T.builds++;
    const prio = this.opts.priority ?? 1;
    t = performance.now();
    this.equipment.set(this.pendingEq, (job, label) => frameWork.run(() => {
      const t0 = performance.now();
      job();
      T.equipment += performance.now() - t0;
    }, prio, label), () => {
      if (this.disposed || this.char !== ch) return;
      this.equipment?.setSkyVis(this.skyVis);
      ch.object.visible = this.visible;
      this.markDressed();
      if (this.placeholder) {
        this.placeholder.removeFromParent();
        this.placeholder.geometry.dispose();
        (this.placeholder.material as THREE.Material).dispose();
        this.placeholder = null;
      }
    });
  }

  /** Change the look: a new body is built (the old one stays until the new one is dressed). */
  async setAppearance(app: Look) {
    const key = lookKey(app);
    this.app = app;
    if (key === this.key && this.char) return;
    this.key = key;
    if (HEADLESS) return;
    let ch: Character;
    try {
      ch = await Character.load(app, this.pendingEq, { castShadow: this.opts.castShadow, priority: 0, renderer: this.opts.renderer });
    } catch (e) {
      console.warn('[humanoid] character build failed', e);
      return;
    }
    frameWork.run(() => this.finish(ch, key), this.opts.priority ?? 1, 'character (new look)');
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
   * Per-frame update. `camPos` picks the detail level (Actors' levels: full, medium, crowd);
   * distant characters animate at a reduced rate (their dt accumulates).
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
      const d = _p.set(s.pos[0], s.pos[1] + 1, s.pos[2]).distanceTo(camPos) / Math.max(0.6, ch.traits.scale * sc);
      const levels = ch.actor.lods;
      const cur = ch.lod;
      // The pack's switch distances, with hysteresis against flicker at the thresholds.
      lod = 0;
      for (let l = 1; l < levels.length; l++) if (d > levels[l].distance + (l <= cur ? -1.5 : 1.5)) lod = l;
      if (lod !== cur) ch.setLod(lod);
    }
    // Throttle animation far away.
    this.frame++;
    this.accum += dt;
    const every = lod >= 2 ? 3 : lod === 1 ? 2 : 1;
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
    ch.sync();
    ch.update(step);
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
