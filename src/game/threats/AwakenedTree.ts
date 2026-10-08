/**
 * The awakened tree (VILLAINS_PLAN §3.8): the eco-radicals' Elder has sung a real street or park
 * tree awake (crime/BossOp 'treewake'). Its prop leaves the street, roots tear up the pavement,
 * and the tree stands up on three root legs: the trunk is its body, two branches its arms, the
 * crown its head — the same tree model as before, so it looks like the tree it was.
 *
 * It goes for **anything technical**: cars (swept aside or crushed), delivery robots, street lamps
 * and traffic lights. People it ignores — unless they hurt it: whoever does (the hero, the police,
 * the army) becomes its target until they back off (the aggro table, decaying).
 *
 *   sweep   a branch swings across: what it meets is thrown (cars wrecked, robots knocked over,
 *           lamps toppled, people knocked down, the hero flung)
 *   slam    it rears up — the glowing heart in its trunk shows (the weak spot) — and brings both
 *           arms down: everything round the spot is crushed, the ground cracks
 *
 * Fighting it: weak to fire (it burns, panics and flails, and the flames keep eating at it);
 * frost slows it; lightning does little; blows on the exposed heart count three times. Beaten, it
 * roots where it stands and turns back into an old, gnarled tree that stays as a landmark of the
 * fight (for the session; at most a few). A major threat event: the full city response.
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import type { Cause } from '../Stimuli';
import type { DamageResult, DamageSource, ThreatActor, ThreatEvent, ThreatOutcome, ThreatTarget, ThreatZone } from './ThreatEvent';
import { DAMAGE_PER_IMPULSE } from './ThreatEvent';
import { treeModel, createBarkMaterial, createLeafMaterial, applyVegetationShadow, type TreeSpecies } from '../../props/vegetation';
import type { StreetProp } from '../../props/PropRenderer';
import { twoBone, type Vec3 } from './rig/chain';
import { PState, type PedAgent } from '../../sim/Pedestrians';
import { VState, type Vehicle } from '../../sim/Traffic';
import { RState } from '../../future/Robots';
import { DecalKind } from '../powers/ElementFx';
import type { Obstacle } from '../../world/Collision';

let EVENT_ID = 9000;

export const TREE = {
  hp: 1000,
  /** Its legs are this share of the tree's height (m, clamped). */
  legShare: 0.3, legMin: 2.2, legMax: 4.4,
  /** Walking speed (m/s), panicking (burning), and the share left while frozen. */
  walk: 2.1, panic: 3.4, slowK: 0.45,
  /** Seconds to tear itself out of the ground. */
  riseT: 5,
  /** It looks for machines this far round it (m), every so often (s). */
  sight: 65, scanEvery: 1,
  /** A sweep: duration (s), when it lands, the area it hits (m), cooldown. */
  sweepT: 1.15, sweepHit: 0.62, sweepR: 2.8, sweepCd: 2.2,
  /** A slam: the rear (heart shows), the blow, the area (m), cooldown. */
  rearT: 1.5, slamT: 2.5, slamHit: 1.75, slamR: 6.5, slamCd: 8,
  /** Damage to the player (before size) and how far they are thrown. */
  sweepDmg: 16, sweepFling: 9, slamDmg: 24, slamFling: 7,
  /** Element multipliers on the powers' damage, burn damage per second, panic once alight this long. */
  fire: 2.5, frost: 1, shock: 0.3, burnDps: 22, panicAt: 1.2,
  /** An exposed heart takes this many times the damage. */
  heartMul: 3,
  /** Aggro under this is forgotten (it goes back to the machines). */
  aggroMin: 25,
  /** Karma for the hero who beats it, and for a hit on the heart; reputation for beating it (like the strider). */
  karma: { beaten: 120, weak: 3 },
  rep: 12,
  /** Gnarled trees kept standing after fights (the oldest goes). */
  keep: 3,
  /** Seconds to root (beaten). */
  rootT: 3.5,
};

const ZONES: { id: string; name: string; armour: number; weak: boolean }[] = [
  { id: 'trunk', name: 'trunk', armour: 0.55, weak: false },
  { id: 'crown', name: 'crown', armour: 0.3, weak: false },
  { id: 'roots', name: 'roots', armour: 0.45, weak: false },
  { id: 'arms', name: 'branches', armour: 0.35, weak: false },
  { id: 'heart', name: 'heart', armour: 0, weak: true },
];

type Mode = 'rise' | 'roam' | 'panic' | 'rooting' | 'rooted';
type Act = 'sweep' | 'slam' | null;

interface Cap { ax: number; ay: number; az: number; bx: number; by: number; bz: number; r: number; zone: string }
interface Leg { ang: number; hip: Vec3; knee: Vec3; foot: Vec3; plant: Vec3; from: Vec3; to: Vec3; sw: number; upper: THREE.Mesh; lower: THREE.Mesh; claw: THREE.Mesh }
interface Arm { side: 1 | -1; sh: Vec3; el: Vec3; hand: Vec3; upper: THREE.Mesh; lower: THREE.Mesh; twigs: THREE.Group }
interface Tgt { kind: 'car' | 'robot' | 'prop' | 'player' | 'point'; x: number; z: number; ref?: unknown }

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);
const v3 = (): Vec3 => ({ x: 0, y: 0, z: 0 });
const FIRE_A = new THREE.Color(3, 1.3, 0.3), FIRE_B = new THREE.Color(0.8, 0.15, 0.02);
const SMOKE_A = new THREE.Color(0.3, 0.3, 0.3), SMOKE_B = new THREE.Color(0.5, 0.5, 0.5);
const DUST_A = new THREE.Color(0.55, 0.5, 0.44), DUST_B = new THREE.Color(0.45, 0.42, 0.38);
const LEAF_A = new THREE.Color(0.22, 0.42, 0.1), LEAF_B = new THREE.Color(0.3, 0.32, 0.12);
const MOSS_A = new THREE.Color(0.55, 1.7, 0.35), MOSS_B = new THREE.Color(0.1, 0.35, 0.05);
const EARTH = new THREE.Color(0.2, 0.15, 0.1);

/** Gnarled trees left after fights (kept for the session). */
const GROVE: AwakenedTree[] = [];

/** Shared geometry (unit tapered cylinder along +Y from 0 to 1, a claw cone). */
let LIMB: THREE.CylinderGeometry | null = null, CLAW: THREE.ConeGeometry | null = null;

export class AwakenedTree implements ThreatEvent, ThreatActor {
  readonly id = EVENT_ID++;
  readonly archetype = 'tree';
  readonly tier = 'major' as const;
  readonly engageOnFoot = false;
  readonly actors: ThreatActor[] = [this];
  readonly name = 'Awakened tree';
  readonly title = 'Awakened tree — it smashes anything with a motor or a plug';
  readonly radius = 70;
  readonly maxHp = TREE.hp;
  readonly zones: ThreatZone[];
  readonly aggro = new Map<string, number>();
  readonly height: number;
  hp = TREE.hp;
  x: number; y = 0; z: number;
  yaw: number;
  t = 0;
  active = true;
  outcome: ThreatOutcome | null = null;
  hurt = 0;
  mode: Mode = 'rise';
  act: Act = null;
  /** Burning (s left), frozen / slowed (s left). */
  burning = 0;
  slowT = 0;
  readonly stats = { cars: 0, robots: 0, props: 0, knocked: 0, sweeps: 0, slams: 0, playerHits: 0, damage: 0, fire: 0, weakHits: 0 };
  /** The body in the scene (kept after the fight as a gnarled tree). */
  readonly group = new THREE.Group();
  /** At the tree's foot, turned with it (the limbs are placed in world space, beside it in `group`). */
  private readonly body = new THREE.Group();
  private readonly pelvis = new THREE.Group();
  private readonly trunk = new THREE.Group();
  private readonly heart: THREE.Mesh;
  private readonly heartMat: THREE.MeshStandardMaterial;
  private readonly eyeMat: THREE.MeshStandardMaterial;
  private readonly legs: Leg[] = [];
  private readonly arms: Arm[] = [];
  private readonly caps: Cap[] = [];
  private readonly treeH: number;
  private readonly trunkR: number;
  private readonly legLen: number;
  private readonly armLen: number;
  private readonly bark: THREE.MeshStandardMaterial;
  /** The legs' and arms' bark (plain: the vegetation shader wants instanced meshes). */
  private readonly limbMat: THREE.MeshStandardMaterial;
  private readonly leafMat: THREE.MeshStandardMaterial;
  private riseK = 0;
  private actT = 0;
  private cool = { sweep: 1.5, slam: 4, scan: 0 };
  private target: Tgt | null = null;
  private lastSrc = new Map<string, { x: number; z: number }>();
  private lean = 0;
  private sway = 0;
  private walkPhase = 0;
  private stepLeg = 0;
  private rootK = 0;
  private side: 1 | -1 = 1;
  private hitDone = false;
  private crackT = 0;
  private stimT = 0;

  constructor(private g: Game, readonly prop: StreetProp, readonly seed: number) {
    this.x = prop.x; this.z = prop.z;
    this.yaw = Math.atan2(prop.x - g.player.pos.x, prop.z - g.player.pos.z);
    this.treeH = Math.max(5, prop.height);
    this.trunkR = Math.max(0.2, prop.radius);
    this.legLen = Math.min(TREE.legMax, Math.max(TREE.legMin, this.treeH * TREE.legShare));
    this.armLen = Math.max(2.4, this.treeH * 0.42);
    this.height = this.treeH + this.legLen * 0.85;
    this.zones = ZONES.map((z) => ({ ...z, exposed: false, x: 0, y: 0, z: 0, r: 1, recent: 0 }));
    // The tree itself: its own model (wood and leaves) on the trunk, as it stood.
    const [, sp, variant] = prop.kind.split(':');
    const m = treeModel(sp as TreeSpecies, Number(variant) || 0);
    this.bark = createBarkMaterial();
    this.leafMat = createLeafMaterial(sp as TreeSpecies);
    this.limbMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.95 });
    // (The vegetation shaders read the instance matrix: single-instance meshes, as a toppled tree's.)
    const inst = new THREE.Matrix4().compose(new THREE.Vector3(), _q.setFromAxisAngle(_up, prop.yaw - this.yaw), new THREE.Vector3().setScalar(prop.scale));
    for (const [geo, mat] of [[m.wood, this.bark], [m.leaves, this.leafMat]] as const) {
      const o = new THREE.InstancedMesh(geo, mat, 1);
      o.setMatrixAt(0, inst);
      o.castShadow = true;
      applyVegetationShadow(o);
      o.frustumCulled = false;
      this.trunk.add(o);
    }
    // A glowing knot in the trunk (the heart) and two eyes under the crown.
    this.heartMat = new THREE.MeshStandardMaterial({ color: 0x2a3a10, emissive: new THREE.Color(0.9, 1.4, 0.3), emissiveIntensity: 0.4, roughness: 0.5 });
    this.heart = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.35, this.trunkR * 1.1), 12, 10), this.heartMat);
    this.heart.position.set(0, this.treeH * 0.2, -this.trunkR * 0.75);
    this.eyeMat = new THREE.MeshStandardMaterial({ color: 0x101a05, emissive: new THREE.Color(0.7, 1.6, 0.3), emissiveIntensity: 1.2 });
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.09, this.trunkR * 0.3), 8, 6), this.eyeMat);
      e.position.set(s * this.trunkR * 0.45, this.treeH * 0.34, -this.trunkR * 0.85);
      this.trunk.add(e);
    }
    this.trunk.add(this.heart);
    this.pelvis.add(this.trunk);
    this.body.add(this.pelvis);
    this.group.add(this.body);
    // Root legs and branch arms (bark-skinned tapered cylinders).
    LIMB ??= (() => { const c = new THREE.CylinderGeometry(0.62, 1, 1, 8, 1); c.translate(0, 0.5, 0); return c; })();
    CLAW ??= new THREE.ConeGeometry(1, 1, 5);
    const mesh = (geo: THREE.BufferGeometry) => { const o = new THREE.Mesh(geo, this.limbMat); o.castShadow = true; o.frustumCulled = false; this.group.add(o); return o; };
    const angs = [-Math.PI * 0.72, Math.PI * 0.72, 0];
    for (const ang of angs) {
      const L: Leg = { ang, hip: v3(), knee: v3(), foot: v3(), plant: v3(), from: v3(), to: v3(), sw: -1, upper: mesh(LIMB), lower: mesh(LIMB), claw: mesh(CLAW) };
      this.legs.push(L);
    }
    for (const side of [-1, 1] as const) {
      const twigs = new THREE.Group();
      for (let k = 0; k < 4; k++) {
        const c = new THREE.Mesh(CLAW, this.limbMat);
        c.scale.set(0.09 * this.armLen, 0.32 * this.armLen, 0.09 * this.armLen);
        c.rotation.set(Math.PI + (k - 1.5) * 0.35, 0, (k % 2 ? 0.3 : -0.3));
        twigs.add(c);
      }
      this.group.add(twigs);
      this.arms.push({ side, sh: v3(), el: v3(), hand: v3(), upper: mesh(LIMB), lower: mesh(LIMB), twigs });
    }
    g.renderer.scene.add(this.group);
    // The street tree is gone from its spot: this is it now.
    g.props.uproot(prop);
    this.y = g.world.groundHeight(this.x, this.z);
    this.place(0);
    for (const L of this.legs) { L.plant = { ...this.legHome(L) }; L.foot = { ...L.plant }; }
    // Roots tear up the pavement.
    const fx = g.elements.fx;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.random() * 0.5;
      fx.decal(DecalKind.Crack, this.x + Math.cos(a) * 2.5, this.y + 0.03, this.z + Math.sin(a) * 2.5, 0, 1, 0, 4 + Math.random() * 3, 1, Math.atan2(Math.cos(a), Math.sin(a)), 600);
    }
    g.audio.play('tree_crack_fall', this.x, this.y + 2, this.z, 1, 0.6, 60, g.renderer.camera.position);
    g.audio.play('grow_rumble', this.x, this.y, this.z, 1, 0.7, 80, g.renderer.camera.position);
  }

  get defeated(): boolean { return this.mode === 'rooting' || this.mode === 'rooted'; }
  get targetable(): boolean { return !this.defeated && this.riseK > 0.3; }

  zone(id: string): ThreatZone { return this.zones.find((z) => z.id === id) ?? this.zones[0]; }

  // ================================================================== body: pose, capsules

  /** Hip anchors and where a leg's foot belongs (world). */
  private legHome(L: Leg): Vec3 {
    const a = this.yaw + L.ang, r = this.trunkR * 1.4 + this.legLen * 0.55;
    const x = this.x - Math.sin(a) * r, z = this.z - Math.cos(a) * r;
    return { x, y: this.g.world.groundHeight(x, z), z };
  }

  /** Pose the body for a frame: trunk lean and sway, legs stepping (IK), arms by the act. */
  private place(dt: number): void {
    const g = this.g, gy = this.y;
    // Rise: it comes up out of the ground; rooting: it sinks a little and leans.
    const up = this.mode === 'rise' ? this.riseK * this.riseK * (3 - 2 * this.riseK) : 1;
    const sink = this.rootK * 0.8;
    const bob = Math.abs(Math.sin(this.walkPhase * Math.PI)) * 0.25;
    const pelvisY = this.legLen * (0.25 + 0.6 * up) - sink + (this.mode === 'roam' || this.mode === 'panic' ? bob : 0);
    this.body.position.set(this.x, gy, this.z);
    this.body.rotation.y = this.yaw;
    this.pelvis.position.set(0, pelvisY, 0);
    this.trunk.rotation.set(this.lean, 0, this.sway);
    this.group.updateMatrixWorld(true);
    // Legs: hips round the trunk's foot; feet planted, stepping one at a time towards home.
    for (let i = 0; i < this.legs.length; i++) {
      const L = this.legs[i];
      const a = L.ang;
      _v.set(-Math.sin(a) * this.trunkR * 1.1, 0.15, -Math.cos(a) * this.trunkR * 1.1);
      this.pelvis.localToWorld(_v);
      L.hip.x = _v.x; L.hip.y = _v.y; L.hip.z = _v.z;
      if (L.sw >= 0) {
        L.sw = Math.min(1, L.sw + dt / 0.45);
        const s = L.sw * L.sw * (3 - 2 * L.sw);
        L.foot.x = L.from.x + (L.to.x - L.from.x) * s; L.foot.z = L.from.z + (L.to.z - L.from.z) * s;
        L.foot.y = L.from.y + (L.to.y - L.from.y) * s + Math.sin(s * Math.PI) * this.legLen * 0.3;
        if (L.sw >= 1) { L.sw = -1; L.plant = { ...L.to }; this.footfall(L.to.x, L.to.y, L.to.z); }
      } else if (this.mode !== 'rooted') {
        L.foot = { ...L.plant };
        const H = this.legHome(L);
        // Rising: the feet come out of the ground under it.
        if (this.mode === 'rise') { L.plant = H; L.foot = { ...H }; }
        else if (i === this.stepLeg && Math.hypot(H.x - L.plant.x, H.z - L.plant.z) > this.legLen * 0.45 && this.legs.every((o) => o.sw < 0)) {
          L.sw = 0; L.from = { ...L.plant }; L.to = H;
          this.stepLeg = (this.stepLeg + 1) % this.legs.length;
        } else if (Math.hypot(H.x - L.plant.x, H.z - L.plant.z) <= this.legLen * 0.45 && i === this.stepLeg) this.stepLeg = (this.stepLeg + 1) % this.legs.length;
      }
      const pole = { x: -Math.sin(this.yaw + a), y: 0.6, z: -Math.cos(this.yaw + a) };
      const knee = v3(), foot = v3();
      twoBone(L.hip, L.foot, this.legLen * 0.55, this.legLen * 0.62, pole, knee, foot);
      L.knee = knee;
      this.limb(L.upper, L.hip, knee, this.trunkR * 0.75);
      this.limb(L.lower, knee, foot, this.trunkR * 0.55);
      L.claw.position.set(foot.x, foot.y + 0.1, foot.z);
      L.claw.scale.set(this.trunkR * 0.6, 0.35, this.trunkR * 0.6);
    }
    // Arms: shoulders on the trunk, the hands by the act (raised for a slam, swung in a sweep, hanging).
    for (const A of this.arms) {
      _v.set(A.side * this.trunkR * 1.05, this.treeH * 0.42, 0);
      this.trunk.localToWorld(_v);
      A.sh.x = _v.x; A.sh.y = _v.y; A.sh.z = _v.z;
      const hand = this.handTarget(A);
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      const pole = { x: A.side * Math.cos(this.yaw) * 0.6 - fx * 0.6, y: -0.4, z: -A.side * Math.sin(this.yaw) * 0.6 - fz * 0.6 };
      const el = v3(), h = v3();
      twoBone(A.sh, hand, this.armLen * 0.5, this.armLen * 0.55, pole, el, h);
      A.el = el; A.hand = h;
      this.limb(A.upper, A.sh, el, this.trunkR * 0.5);
      this.limb(A.lower, el, h, this.trunkR * 0.36);
      A.twigs.position.set(h.x, h.y, h.z);
      A.twigs.quaternion.setFromUnitVectors(_up, _v.set(h.x - el.x, h.y - el.y, h.z - el.z).normalize().negate());
    }
    // The heart: dim, or blazing while it rears (exposed).
    const exposed = this.act === 'slam' && this.actT < TREE.slamHit && this.actT > 0.25;
    this.zone('heart').exposed = exposed;
    const glow = this.defeated ? 0 : exposed ? 3 + Math.sin(this.t * 14) * 1 : 0.4 + 0.2 * Math.sin(this.t * 3);
    this.heartMat.emissiveIntensity += (glow - this.heartMat.emissiveIntensity) * Math.min(1, dt * 8 + (dt === 0 ? 1 : 0));
    this.eyeMat.emissiveIntensity = this.defeated ? Math.max(0, 1.2 * (1 - this.rootK * 2)) : 1.2;
    this.capsules();
    void g;
  }

  /** Where a hand goes this frame. */
  private handTarget(A: Arm): Vec3 {
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw), rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const L = this.armLen, S = A.sh;
    if (this.defeated) {
      // Rooted: the branches droop and spread, like a gnarled old tree's.
      return { x: S.x + rx * A.side * L * 0.7, y: S.y + L * 0.25, z: S.z + rz * A.side * L * 0.7 };
    }
    if (this.act === 'slam') {
      const u = this.actT;
      if (u < TREE.rearT) { const k = Math.min(1, u / 0.6); return { x: S.x + rx * A.side * L * 0.3 - fx * L * 0.2, y: S.y + L * (0.3 + 0.6 * k), z: S.z + rz * A.side * L * 0.3 - fz * L * 0.2 }; }
      const k = Math.min(1, (u - TREE.rearT) / 0.25);
      return { x: S.x + fx * L * (0.2 + 0.75 * k) + rx * A.side * L * 0.2, y: S.y + L * (0.9 - 1.6 * k), z: S.z + fz * L * (0.2 + 0.75 * k) + rz * A.side * L * 0.2 };
    }
    if (this.act === 'sweep' && A.side === this.side) {
      const u = this.actT / TREE.sweepT;
      // Drawn back to the side, then across the front to the other side.
      const a = u < 0.45 ? (u / 0.45) * 1.2 : 1.2 - Math.min(1, (u - 0.45) / 0.25) * 2.6;
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = fx * ca + rx * A.side * sa, dz = fz * ca + rz * A.side * sa;
      return { x: S.x + dx * L * 0.95, y: S.y - L * 0.35, z: S.z + dz * L * 0.95 };
    }
    // Walking: hanging and swinging a little.
    const sw = Math.sin(this.walkPhase * Math.PI + (A.side > 0 ? 0 : Math.PI)) * 0.3;
    const panic = this.mode === 'panic' ? Math.sin(this.t * 9 + A.side) * 0.8 : 0;
    return { x: S.x + rx * A.side * L * 0.45 + fx * L * (0.15 + sw), y: S.y - L * (0.7 - Math.abs(panic) * 0.9), z: S.z + rz * A.side * L * 0.45 + fz * L * (0.15 + sw) };
  }

  /** A tapered limb mesh from a to b. */
  private limb(m: THREE.Mesh, a: Vec3, b: Vec3, r: number): void {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, L = Math.hypot(dx, dy, dz) || 1e-3;
    m.position.set(a.x, a.y, a.z);
    m.quaternion.setFromUnitVectors(_up, _v.set(dx / L, dy / L, dz / L));
    m.scale.set(r, L, r);
  }

  /** The body's capsules for hits (world), and the zones' centres. */
  private capsules(): void {
    const C = this.caps;
    C.length = 0;
    _v.set(0, 0, 0); this.trunk.localToWorld(_v);
    const bx = _v.x, by = _v.y, bz = _v.z;
    _v.set(0, this.treeH * 0.55, 0); this.trunk.localToWorld(_v);
    C.push({ ax: bx, ay: by, az: bz, bx: _v.x, by: _v.y, bz: _v.z, r: this.trunkR * 1.6, zone: 'trunk' });
    _v.set(0, this.treeH * 0.72, 0); this.trunk.localToWorld(_v);
    const cr = this.treeH * 0.28;
    C.push({ ax: _v.x, ay: _v.y - cr * 0.3, az: _v.z, bx: _v.x, by: _v.y + cr * 0.3, bz: _v.z, r: cr, zone: 'crown' });
    for (const L of this.legs) {
      C.push({ ax: L.hip.x, ay: L.hip.y, az: L.hip.z, bx: L.knee.x, by: L.knee.y, bz: L.knee.z, r: this.trunkR * 0.8, zone: 'roots' });
      C.push({ ax: L.knee.x, ay: L.knee.y, az: L.knee.z, bx: L.foot.x, by: L.foot.y, bz: L.foot.z, r: this.trunkR * 0.6, zone: 'roots' });
    }
    for (const A of this.arms) {
      C.push({ ax: A.sh.x, ay: A.sh.y, az: A.sh.z, bx: A.el.x, by: A.el.y, bz: A.el.z, r: this.trunkR * 0.6, zone: 'arms' });
      C.push({ ax: A.el.x, ay: A.el.y, az: A.el.z, bx: A.hand.x, by: A.hand.y, bz: A.hand.z, r: this.trunkR * 0.5 + 0.3, zone: 'arms' });
    }
    this.heart.getWorldPosition(_v);
    const hr = Math.max(0.5, this.trunkR * 1.3);
    C.push({ ax: _v.x, ay: _v.y, az: _v.z, bx: _v.x, by: _v.y, bz: _v.z, r: hr, zone: 'heart' });
    // Zone centres (markers, area effects).
    for (const Z of this.zones) {
      const c = C.find((k) => k.zone === Z.id);
      if (c) { Z.x = (c.ax + c.bx) / 2; Z.y = (c.ay + c.by) / 2; Z.z = (c.az + c.bz) / 2; Z.r = c.r; }
    }
    // The event centre: the middle of the trunk.
    this.y = this.g.world.groundHeight(this.x, this.z);
  }

  // ================================================================== ThreatActor

  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): { t: number; zone: ThreatZone } | null {
    if (!this.targetable) return null;
    let best: { t: number; zone: ThreatZone } | null = null;
    for (const c of this.caps) {
      // The heart only counts while it shows (else the trunk takes it).
      if (c.zone === 'heart' && !this.zone('heart').exposed) continue;
      const t = rayCapsule(ox, oy, oz, dx, dy, dz, maxT, c);
      if (t >= 0 && (!best || t < best.t || (c.zone === 'heart' && t < best.t + 0.6))) best = { t, zone: this.zone(c.zone) };
    }
    return best;
  }

  zoneAt(x: number, y: number, z: number): { zone: ThreatZone; d: number } | null {
    let best: { zone: ThreatZone; d: number } | null = null;
    for (const c of this.caps) {
      if (c.zone === 'heart' && !this.zone('heart').exposed) continue;
      const d = segDist3(x, y, z, c) - c.r;
      if (!best || d < best.d) best = { zone: this.zone(c.zone), d };
    }
    return best;
  }

  damage(zone: ThreatZone | string | null, amount: number, src: DamageSource): DamageResult {
    if (this.defeated || amount <= 0 || this.riseK < 0.3) return { dealt: 0, zone: null, weak: false };
    let Z: ThreatZone;
    if (typeof zone === 'string') Z = this.zone(zone);
    else if (zone) Z = zone;
    else Z = (src.x !== undefined ? this.zoneAt(src.x, src.y ?? this.y + 3, src.z ?? this.z)?.zone : null) ?? this.zone('trunk');
    if (Z.id === 'heart' && !Z.exposed) Z = this.zone('trunk');
    const weak = Z.weak && Z.exposed;
    const dealt = amount * (1 - Z.armour) * (weak ? TREE.heartMul : 1);
    this.hp = Math.max(0, this.hp - dealt);
    Z.recent += dealt;
    this.stats.damage += dealt;
    if (weak) this.stats.weakHits++;
    const key = src.key ?? src.cause;
    this.aggro.set(key, (this.aggro.get(key) ?? 0) + dealt + (src.aggro ?? 0));
    if (src.x !== undefined && src.z !== undefined) this.lastSrc.set(key, { x: src.x, z: src.z });
    if (src.cause === 'player' && weak && dealt > 15) this.g.progress.addKarma(TREE.karma.weak, 'hit the awakened tree in its heart');
    if (this.hp <= 0) this.startRooting(src.cause === 'player');
    return { dealt, zone: Z, weak };
  }

  blow(x: number, y: number, z: number, r: number, jx: number, jy: number, jz: number, src: DamageSource): DamageResult | null {
    if (!this.targetable) return null;
    const n = this.zoneAt(x, y, z);
    if (!n || n.d > r + 0.5) return null;
    const J = Math.hypot(jx, jy, jz);
    return this.damage(n.zone, J * DAMAGE_PER_IMPULSE, { ...src, x: src.x ?? x, y: src.y ?? y, z: src.z ?? z });
  }

  /**
   * A power's element on it (powers/Elements): fire sets it alight (it burns on, panics, takes
   * more); frost slows it; lightning barely bothers it. Returns the multiplier on the power's damage.
   */
  onElement(el: 'fire' | 'frost' | 'shock', dur: number): number {
    if (this.defeated) return 0;
    if (el === 'fire') { this.burning = Math.max(this.burning, Math.min(10, this.burning + dur * 1.5)); this.stats.fire++; return TREE.fire; }
    if (el === 'frost') { this.slowT = Math.max(this.slowT, dur * 1.5); this.burning = 0; return TREE.frost; }
    return TREE.shock;
  }

  conStrength(): number { return 120 * Math.sqrt(Math.max(0.05, this.hp / this.maxHp)); }

  // ================================================================== ThreatEvent

  strength(): number { return this.active ? this.hp / this.maxHp : 0; }
  targetsNear(_x: number, _z: number, _r: number): ThreatTarget[] { return []; }
  strike(_t: ThreatTarget, _jx: number, _jy: number, _jz: number, _cause: Cause): void { /* out of an officer's reach */ }

  /** The response gives up on it: it roots where it stands (the city cordons it off). */
  shutdown(): void {
    if (!this.defeated) this.startRooting(false, 'retreated');
  }

  /** The body stays (a gnarled tree) when it was beaten; it is gone otherwise. */
  dispose(): void {
    if (this.mode === 'rooted') {
      if (!GROVE.includes(this)) GROVE.push(this);
      while (GROVE.length > TREE.keep) { const old = GROVE.shift()!; old.remove(); }
      return;
    }
    this.remove();
  }

  /** Off the scene for good. */
  remove(): void {
    this.g.renderer.scene.remove(this.group);
    this.heart.geometry.dispose();
    this.heartMat.dispose(); this.eyeMat.dispose(); this.limbMat.dispose(); this.bark.dispose(); this.leafMat.dispose();
    const i = GROVE.indexOf(this);
    if (i >= 0) GROVE.splice(i, 1);
  }

  /** Gnarled trees standing in the city after fights (the threat director's obstacles). */
  static grove(): readonly AwakenedTree[] { return GROVE; }

  /** Its trunk stands in the player's way (and a rooted one stays). */
  obstacles(x0: number, z0: number, x1: number, z1: number, out: (o: Obstacle) => void): void {
    const r = this.trunkR * 1.5;
    if (this.x + r < x0 || this.x - r > x1 || this.z + r < z0 || this.z - r > z1) return;
    out({ cyl: true, x: this.x, z: this.z, r, hx: 0, hz: 0, ux: 1, uz: 0, y0: this.y, y1: this.y + this.height });
  }

  snapshot(): Record<string, unknown> {
    return {
      id: this.id, archetype: this.archetype, t: +this.t.toFixed(1), active: this.active, outcome: this.outcome, mode: this.mode, act: this.act,
      x: Math.round(this.x), z: Math.round(this.z), hp: Math.round(this.hp), height: +this.height.toFixed(1), burning: +this.burning.toFixed(1), slow: +this.slowT.toFixed(1),
      target: this.target ? { kind: this.target.kind, x: Math.round(this.target.x), z: Math.round(this.target.z) } : null,
      aggro: Object.fromEntries([...this.aggro].map(([k, v]) => [k, Math.round(v)])), ...this.stats,
    };
  }

  // ================================================================== frame

  update(dt: number): void {
    this.t += dt;
    for (const [k, v] of this.aggro) { const nv = v * Math.exp(-dt / 20); if (nv < 1) this.aggro.delete(k); else this.aggro.set(k, nv); }
    for (const Z of this.zones) Z.recent *= Math.exp(-dt / 4);
    this.cool.sweep -= dt; this.cool.slam -= dt; this.cool.scan -= dt;
    if (this.slowT > 0) this.slowT -= dt;
    if (this.mode === 'rooted') { this.place(dt); return; }
    if (this.mode === 'rooting') { this.rooting(dt); this.place(dt); return; }
    if (this.mode === 'rise') {
      this.riseK = Math.min(1, this.riseK + dt / TREE.riseT);
      this.risingFx(dt);
      if (this.riseK >= 1) { this.mode = 'roam'; this.g.audio.play('maw_roar', this.x, this.y + this.height * 0.7, this.z, 0.9, 0.55, 120, this.g.renderer.camera.position); }
      this.place(dt);
      return;
    }
    this.burn(dt);
    if (this.mode === 'rooting' as Mode) { this.place(dt); return; }
    this.mode = this.burning > TREE.panicAt ? 'panic' : 'roam';
    if (this.act) this.doAct(dt);
    else this.decide(dt);
    this.place(dt);
    this.surroundings(dt);
  }

  /** Coming up out of the ground: earth and stones thrown up, the ground shaking. */
  private risingFx(dt: number): void {
    const g = this.g, fx = g.elements.fx;
    this.crackT -= dt;
    if (this.crackT > 0) return;
    this.crackT = 0.12;
    const a = Math.random() * Math.PI * 2, r = 1 + Math.random() * 3.5;
    const x = this.x + Math.cos(a) * r, z = this.z + Math.sin(a) * r;
    g.debris.chipBurst(x, this.y + 0.2, z, 4, 4, 0, 1, 0, EARTH, 0.08, 2.5);
    fx.soft(x, this.y + 0.4, z, Math.cos(a) * 2, 2 + Math.random() * 2, Math.sin(a) * 2, 1.4, 0.6, 1.8, DUST_A, DUST_B, 0.6, 1.2, -2);
    if (Math.random() < 0.3) g.camRig.addShake(0.05);
    if (Math.random() < 0.15) g.stimuli.emit('tremor', this.x, this.y, this.z, 4, 300, { cause: 'threat' });
  }

  /** On fire: the flames eat at it, it panics and flails; it burns out after a while. */
  private burn(dt: number): void {
    if (this.burning <= 0) return;
    this.burning = Math.max(0, this.burning - dt);
    const dealt = TREE.burnDps * dt;
    this.hp = Math.max(0, this.hp - dealt);
    this.stats.damage += dealt;
    this.aggro.set('player', (this.aggro.get('player') ?? 0) + dealt * 0.5);
    const fx = this.g.elements.fx;
    if (Math.hypot(this.g.renderer.camera.position.x - this.x, this.g.renderer.camera.position.z - this.z) < 400) {
      for (let i = 0; i < 4; i++) {
        _v.set((Math.random() - 0.5) * this.treeH * 0.4, this.treeH * (0.5 + Math.random() * 0.4), (Math.random() - 0.5) * this.treeH * 0.4);
        this.trunk.localToWorld(_v);
        fx.glow(_v.x, _v.y, _v.z, (Math.random() - 0.5), 2 + Math.random() * 2, (Math.random() - 0.5), 0.7, 0.9, 0.3, FIRE_A, FIRE_B, 0.9, 1.5, 1);
      }
      if (Math.random() < 0.3) fx.soft(_v.x, _v.y + 1, _v.z, 0, 2, 0, 3, 1.5, 4, SMOKE_A, SMOKE_B, 0.4, 0.4, -0.1);
    }
    if (this.hp <= 0) this.startRooting(true);
  }

  // ---------------------------------------------------------------- choosing

  private decide(dt: number): void {
    if (this.mode === 'panic') {
      // Burning: it blunders about, arms flailing (no aim).
      if (!this.target || Math.random() < dt * 0.5) { const a = Math.random() * Math.PI * 2; this.target = { kind: 'point', x: this.x + Math.cos(a) * 25, z: this.z + Math.sin(a) * 25 }; }
      this.walk(dt, TREE.panic);
      return;
    }
    if (this.cool.scan <= 0 || !this.target || !this.valid(this.target)) { this.cool.scan = TREE.scanEvery; this.target = this.pick(); }
    const T = this.target;
    if (!T) return;
    if (T.kind === 'player') { const p = this.g.player.pos; T.x = p.x; T.z = p.z; }
    const d = Math.hypot(T.x - this.x, T.z - this.z);
    const reach = this.armLen * 0.95 + this.trunkR;
    if (T.kind !== 'point' && d < reach) {
      // Facing it: a slam when it is hurt, or on a clump of cars; else a sweep.
      this.face(T.x, T.z, dt);
      const ahead = Math.abs(angDiff(Math.atan2(this.x - T.x, this.z - T.z), this.yaw)) < 0.6;
      if (!ahead) return;
      const cluster = this.carsNear(T.x, T.z, 6) >= 2;
      if (this.cool.slam <= 0 && (T.kind === 'player' || cluster || Math.random() < 0.35)) this.begin('slam');
      else if (this.cool.sweep <= 0) {
        // The arm on the side the target is on.
        const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
        this.side = (T.x - this.x) * rx + (T.z - this.z) * rz >= 0 ? 1 : -1;
        this.begin('sweep');
      }
      return;
    }
    if (T.kind === 'point' && d < 3) { this.target = null; return; }
    this.walk(dt, TREE.walk);
  }

  /** What to go for: whoever hurt it most (while they still count), else the nearest machine, else a stroll. */
  private pick(): Tgt | null {
    const g = this.g, p = g.player.pos;
    let top: [string, number] | null = null;
    for (const e of this.aggro) if (e[1] > TREE.aggroMin && (!top || e[1] > top[1])) top = e;
    if (top) {
      if (top[0] === 'player' && Math.hypot(p.x - this.x, p.z - this.z) < 90 && g.player.pos.y < this.y + this.height) return { kind: 'player', x: p.x, z: p.z };
      const s = this.lastSrc.get(top[0]);
      if (s && Math.hypot(s.x - this.x, s.z - this.z) < 90) {
        // Officers or soldiers: their cars and vehicles are machines too.
        const car = this.nearestCar(s.x, s.z, 25);
        if (car) return car;
        return { kind: 'point', x: s.x, z: s.z };
      }
    }
    let best: Tgt | null = null, bd = TREE.sight;
    const consider = (t: Tgt) => { const d = Math.hypot(t.x - this.x, t.z - this.z); if (d < bd) { bd = d; best = t; } };
    const car = this.nearestCar(this.x, this.z, TREE.sight);
    if (car) consider(car);
    for (const r of g.future.robots.list) if (r.alive && r.state < RState.Down) consider({ kind: 'robot', x: r.x, z: r.z, ref: r });
    g.props.query(this.x, this.z, 40, (pr) => { if (!pr.broken && /lamp|signal|stopSign/.test(pr.kind)) consider({ kind: 'prop', x: pr.x, z: pr.z, ref: pr }); });
    if (best) return best;
    // Nothing about: on down the street.
    const a = this.yaw + (Math.random() - 0.5) * 1.6;
    return { kind: 'point', x: this.x - Math.sin(a) * 30, z: this.z - Math.cos(a) * 30 };
  }

  private nearestCar(x: number, z: number, r: number): Tgt | null {
    let best: Tgt | null = null, bd = r;
    for (const list of [this.g.traffic.vehicles, this.g.parkedCars]) for (const v of list) {
      if (v.state === VState.Wreck || v.state === VState.Crushed) continue;
      const d = Math.hypot(v.x - x, v.z - z);
      if (d < bd) { bd = d; best = { kind: 'car', x: v.x, z: v.z, ref: v }; }
    }
    return best;
  }

  private carsNear(x: number, z: number, r: number): number {
    let n = 0;
    for (const list of [this.g.traffic.vehicles, this.g.parkedCars]) for (const v of list) if (v.state !== VState.Wreck && v.state !== VState.Crushed && Math.hypot(v.x - x, v.z - z) < r) n++;
    return n;
  }

  /** Is a target still worth it (a car not wrecked yet, a robot standing, a lamp up)? Follows moving ones. */
  private valid(T: Tgt): boolean {
    if (T.kind === 'car') { const v = T.ref as Vehicle; T.x = v.x; T.z = v.z; return v.state !== VState.Wreck && v.state !== VState.Crushed; }
    if (T.kind === 'robot') { const r = T.ref as { alive: boolean; state: number; x: number; z: number }; T.x = r.x; T.z = r.z; return r.alive && r.state < RState.Down; }
    if (T.kind === 'prop') return !(T.ref as StreetProp).broken;
    if (T.kind === 'player') return (this.aggro.get('player') ?? 0) > TREE.aggroMin;
    return true;
  }

  // ---------------------------------------------------------------- moving

  private face(x: number, z: number, dt: number): void {
    const want = Math.atan2(this.x - x, this.z - z);
    this.yaw += Math.max(-dt * 1.2, Math.min(dt * 1.2, angDiff(want, this.yaw)));
  }

  /** Walk towards the target (turning first), round buildings. */
  private walk(dt: number, speed: number): void {
    const T = this.target;
    if (!T) return;
    this.face(T.x, T.z, dt);
    if (Math.abs(angDiff(Math.atan2(this.x - T.x, this.z - T.z), this.yaw)) > 1.0 && this.mode !== 'panic') return;
    const k = this.slowT > 0 ? TREE.slowK : 1;
    let fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const W = this.g.world, look = this.trunkR + 3;
    if (W.buildingAt(this.x + fx * look, this.z + fz * look)) {
      // A wall ahead: try a little to either side.
      let ok = false;
      for (const da of [0.6, -0.6, 1.2, -1.2]) {
        const a = this.yaw + da, ax = -Math.sin(a), az = -Math.cos(a);
        if (!W.buildingAt(this.x + ax * look, this.z + az * look)) { fx = ax; fz = az; this.yaw += da * dt * 2; ok = true; break; }
      }
      if (!ok) { this.target = null; return; }
    }
    const v = speed * k * dt;
    this.x += fx * v; this.z += fz * v;
    this.y = this.g.world.groundHeight(this.x, this.z);
    this.walkPhase += v / Math.max(1, this.legLen * 0.9);
    this.sway = Math.sin(this.walkPhase * Math.PI) * 0.05 + (this.mode === 'panic' ? Math.sin(this.t * 7) * 0.08 : 0);
    this.lean += (0.06 - this.lean) * Math.min(1, dt * 3);
    // Cars and people in its path: shoved (it does not walk round them).
    this.trample(fx, fz);
  }

  private trample(fx: number, fz: number): void {
    const g = this.g, R = this.trunkR + this.legLen * 0.6;
    for (const a of g.peds.neighbours(this.x, this.z, R, [])) {
      if (a.state === PState.Down || a.inside || Math.hypot(a.x - this.x, a.z - this.z) > R) continue;
      this.knock(a, this.x - fx, this.z - fz, 3);
    }
  }

  private footfall(x: number, y: number, z: number): void {
    const g = this.g;
    g.audio.play('step_giant', x, y, z, 0.45, 1.3, 40, g.renderer.camera.position);
    g.dust.burst(x, y + 0.2, z, 6, 1.5, 2, 2, 1.5, DUST_A, -0.2, 0.6);
    if (Math.random() < 0.4) g.elements.fx.decal(DecalKind.Crack, x, y + 0.03, z, 0, 1, 0, 2, 0.8, Math.random() * 6, 200);
    g.props.crush(x, z, this.trunkR * 0.8);
  }

  // ---------------------------------------------------------------- acts

  private begin(a: Act): void {
    this.act = a;
    this.actT = 0;
    this.hitDone = false;
    if (a === 'sweep') { this.cool.sweep = TREE.sweepCd; this.stats.sweeps++; this.g.audio.play('tree_crack_fall', this.x, this.y + 4, this.z, 0.5, 1.2, 50, this.g.renderer.camera.position); }
    else { this.cool.slam = TREE.slamCd; this.stats.slams++; this.g.audio.play('grow_rumble', this.x, this.y + 4, this.z, 0.9, 0.9, 80, this.g.renderer.camera.position); }
  }

  private doAct(dt: number): void {
    this.actT += dt;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    if (this.act === 'sweep') {
      if (!this.hitDone && this.actT / TREE.sweepT >= TREE.sweepHit) {
        this.hitDone = true;
        const A = this.arms.find((a) => a.side === this.side)!;
        // The swing passes through the front: what stands there goes flying to the other side.
        const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
        const hx = this.x + fx * this.armLen * 0.85, hz = this.z + fz * this.armLen * 0.85;
        this.hitArea(hx, hz, TREE.sweepR + this.armLen * 0.25, -rx * this.side, -rz * this.side, 'sweep');
        void A;
      }
      if (this.actT >= TREE.sweepT) this.act = null;
      return;
    }
    // Slam: rear up (heart shows), then bring both arms down in front.
    if (this.actT < TREE.rearT) this.lean += (-0.32 - this.lean) * Math.min(1, dt * 4);
    else this.lean += (0.4 - this.lean) * Math.min(1, dt * 14);
    if (!this.hitDone && this.actT >= TREE.slamHit) {
      this.hitDone = true;
      const hx = this.x + fx * this.armLen * 0.9, hz = this.z + fz * this.armLen * 0.9;
      this.hitArea(hx, hz, TREE.slamR, 0, 0, 'slam');
    }
    if (this.actT >= TREE.slamT) { this.act = null; }
  }

  /**
   * A blow over an area: cars wrecked and thrown (or crushed by a slam), robots knocked over, lamps
   * and signals toppled, people knocked down, the hero hurt and flung. (dx, dz): the throw for a sweep.
   */
  private hitArea(x: number, z: number, r: number, dx: number, dz: number, kind: 'sweep' | 'slam'): void {
    const g = this.g, y = g.world.groundHeight(x, z), slam = kind === 'slam';
    for (const list of [g.traffic.vehicles, g.parkedCars]) for (const v of [...list]) {
      if (v.state === VState.Wreck || v.state === VState.Crushed || Math.hypot(v.x - x, v.z - z) > r + v.length * 0.3) continue;
      const ax = v.x - x, az = v.z - z, al = Math.hypot(ax, az) || 1;
      const jx = slam ? (ax / al) * 4000 : dx * 16000 + (ax / al) * 3000, jz = slam ? (az / al) * 4000 : dz * 16000 + (az / al) * 3000;
      g.traffic.wreckIt(v);
      g.vehicles.makeWreck(v, v.x, v.y + 0.8, v.z, jx, slam ? -9000 : 7000, jz);
      v.damage = Math.max(v.damage, slam ? 0.85 : 0.55);
      g.consequences.record('tree', 'car', 'wreck', v.x, v.z, v, 'threat');
      this.stats.cars++;
    }
    for (const rb of g.future.robots.list) {
      if (!rb.alive || rb.state >= RState.Down || Math.hypot(rb.x - x, rb.z - z) > r) continue;
      g.future.robots.knock(rb, (slam ? rb.x - x : dx * 8) * 300, 400, (slam ? rb.z - z : dz * 8) * 300);
      this.stats.robots++;
    }
    let n = 0;
    g.props.query(x, z, r, (p) => { if (!p.broken && !p.tree) n++; });
    if (n) { if (slam) g.props.crush(x, z, r * 0.8); else g.props.hit(x, y + 1.5, z, r, dx * 6000, 800, dz * 6000); this.stats.props += n; }
    for (const a of g.peds.neighbours(x, z, r, [])) {
      if (a.inside || a.state === PState.Down) continue;
      this.knock(a, slam ? x : a.x - dx, slam ? z : a.z - dz, slam ? 7 : 6);
    }
    const p = g.player.pos, pd = Math.hypot(p.x - x, p.z - z);
    if (pd < r + g.player.radius && p.y < y + 4) this.hurtPlayer(slam ? TREE.slamDmg : TREE.sweepDmg, slam ? x : p.x - dx, slam ? z : p.z - dz, y, slam ? TREE.slamFling : TREE.sweepFling);
    // The ground: dust, cracks, a thud.
    const cam = g.renderer.camera.position;
    g.dust.burst(x, y + 0.5, z, slam ? 30 : 12, slam ? 5 : 3, 4, 4, 3, DUST_A, -0.2, 0.7);
    for (let i = 0; i < (slam ? 20 : 8); i++) { const a = Math.random() * Math.PI * 2; g.elements.fx.soft(x, y + 2, z, Math.cos(a) * 5, 2 + Math.random() * 3, Math.sin(a) * 5, 2, 0.12, 0.08, LEAF_A, LEAF_B, 0.9, 1.2, 2); }
    if (slam) {
      for (let i = 0; i < 5; i++) { const a = Math.random() * Math.PI * 2; g.elements.fx.decal(DecalKind.Crack, x + Math.cos(a) * 2, y + 0.03, z + Math.sin(a) * 2, 0, 1, 0, 5, 1, Math.atan2(Math.cos(a), Math.sin(a)), 400); }
      g.camRig.addShake(Math.max(0, 0.6 - Math.hypot(cam.x - x, cam.z - z) / 150));
      g.stimuli.emit('tremor', x, y, z, 5, 400, { cause: 'threat' });
      g.audio.play('murk_slam', x, y, z, 1, 0.6, 80, cam);
    } else g.audio.play('car_crash', x, y + 1, z, 0.8, 0.8, 60, cam);
    g.stimuli.emit('gunfire', x, y + 1, z, 4, 120);
  }

  private knock(a: PedAgent, fx: number, fz: number, power: number): void {
    if (a.inside || a.state === PState.Down) return;
    this.g.reactions.knockDown(a, fx, fz, power, 'threat');
    this.g.consequences.record('tree', 'person', 'knockdown', a.x, a.z, a, 'threat');
    this.hurt++;
    this.stats.knocked++;
  }

  /** Hurt and fling the player (sized: a giant hero shrugs off more). */
  private hurtPlayer(dmg: number, fromX: number, fromZ: number, fromY: number, fling: number): void {
    const g = this.g, P = g.player;
    const rel = Math.min(1, Math.pow(this.height / Math.max(1, P.height), 0.8));
    const d = g.crime.health.damage(dmg * Math.max(0.15, rel), 'monster', fromX, fromZ, fromY);
    this.stats.playerHits++;
    if (d <= 0 && !g.crime.health.invulnerable) return;
    const dx = P.pos.x - fromX, dz = P.pos.z - fromZ, l = Math.hypot(dx, dz) || 1, f = fling * rel;
    if (f > 2 && !P.flying) {
      P.vel.x += (dx / l) * f; P.vel.z += (dz / l) * f; P.vel.y = Math.max(P.vel.y, f * 0.45);
      P.grounded = false;
      if (rel > 0.5) P.downT = Math.max(P.downT, 1.2);
    }
    g.camRig.addShake(0.35);
  }

  /** People keep away, drivers turn round, a far stimulus. */
  private surroundings(dt: number): void {
    const g = this.g;
    this.stimT -= dt;
    if (this.stimT > 0) return;
    this.stimT = 1.5;
    g.stimuli.emit('threat', this.x, this.y + this.height * 0.5, this.z, 5, 120, { cause: 'threat' });
    for (const v of g.traffic.vehicles) if (v.state === VState.Drive && !v.task && Math.hypot(v.x - this.x, v.z - this.z) < 90) v.fear = Math.max(v.fear, 1);
    // Leaves drifting off the crown as it moves.
    if (Math.hypot(g.renderer.camera.position.x - this.x, g.renderer.camera.position.z - this.z) < 300) {
      for (let i = 0; i < 6; i++) {
        _v.set((Math.random() - 0.5) * this.treeH * 0.5, this.treeH * (0.55 + Math.random() * 0.35), (Math.random() - 0.5) * this.treeH * 0.5);
        this.trunk.localToWorld(_v);
        g.elements.fx.soft(_v.x, _v.y, _v.z, (Math.random() - 0.5) * 2, -0.5, (Math.random() - 0.5) * 2, 4, 0.12, 0.08, LEAF_A, LEAF_B, 0.9, 1, 0.8);
      }
    }
  }

  // ---------------------------------------------------------------- beaten

  private startRooting(byPlayer: boolean, outcome: ThreatOutcome = 'defeated'): void {
    if (this.defeated) return;
    this.mode = 'rooting';
    this.act = null;
    this.burning = 0;
    this.rootK = 0;
    this.outcome = outcome;
    const g = this.g, cam = g.renderer.camera.position;
    g.audio.play('tree_crack_fall', this.x, this.y + 4, this.z, 1, 0.45, 100, cam);
    g.audio.play('grow_rumble', this.x, this.y, this.z, 0.9, 0.5, 80, cam);
    if (byPlayer && outcome === 'defeated') {
      g.progress.addKarma(TREE.karma.beaten, 'stopped the awakened tree');
      g.crime.rep.add(TREE.rep, 'awakened tree stopped');
      g.crime.rep.count('stopped');
      g.powerHud.toast('The tree <b>roots where it stands</b> — an old, gnarled tree again', 'info');
    }
  }

  private rooting(dt: number): void {
    this.rootK = Math.min(1, this.rootK + dt / TREE.rootT);
    this.lean += (0.12 - this.lean) * Math.min(1, dt * 2);
    this.sway += (0.08 * Math.sign(Math.sin(this.seed)) - this.sway) * Math.min(1, dt * 2);
    // The feet spread and sink, moss creeps over the roots.
    if (Math.random() < dt * 3) {
      const g = this.g, a = Math.random() * Math.PI * 2, r = this.trunkR + Math.random() * this.legLen;
      g.elements.fx.glow(this.x + Math.cos(a) * r, this.y + 0.3, this.z + Math.sin(a) * r, 0, 0.5, 0, 1, 0.3, 0.1, MOSS_A, MOSS_B, 0.7, 1, 0);
    }
    if (this.rootK >= 1) {
      this.mode = 'rooted';
      this.active = false;
      // Gnarled and old: the leaves darken.
      this.leafMat.color.multiplyScalar(0.55);
      this.bark.color.multiplyScalar(0.7);
      this.limbMat.color.multiplyScalar(0.7);
      const g = this.g;
      for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; g.elements.fx.decal(DecalKind.Moss, this.x + Math.cos(a) * 2.5, this.y + 0.03, this.z + Math.sin(a) * 2.5, 0, 1, 0, 4, 3, a, 3600); }
    }
  }

  /** Dev: get it to the hero's side at once (skip the rise). */
  devReady(): void { this.riseK = 1; this.mode = 'roam'; }
}

/** Distance from a point to a capsule's segment. */
function segDist3(x: number, y: number, z: number, c: Cap): number {
  const ux = c.bx - c.ax, uy = c.by - c.ay, uz = c.bz - c.az, L2 = ux * ux + uy * uy + uz * uz;
  const t = L2 > 1e-9 ? Math.max(0, Math.min(1, ((x - c.ax) * ux + (y - c.ay) * uy + (z - c.az) * uz) / L2)) : 0;
  return Math.hypot(x - c.ax - ux * t, y - c.ay - uy * t, z - c.az - uz * t);
}

/** Ray against a capsule: the distance along the ray where it first comes within the radius (−1: misses). */
function rayCapsule(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, c: Cap): number {
  // Closest points between the ray segment and the capsule's axis, then step back to the surface.
  const ux = c.bx - c.ax, uy = c.by - c.ay, uz = c.bz - c.az;
  const wx = ox - c.ax, wy = oy - c.ay, wz = oz - c.az;
  const a = dx * dx + dy * dy + dz * dz, b = dx * ux + dy * uy + dz * uz, cc = ux * ux + uy * uy + uz * uz;
  const d = dx * wx + dy * wy + dz * wz, e = ux * wx + uy * wy + uz * wz;
  const den = a * cc - b * b;
  let s = den > 1e-9 ? (b * e - cc * d) / den : 0;
  s = Math.max(0, Math.min(maxT, s));
  let t = cc > 1e-9 ? (b * s + e) / cc : 0;
  t = Math.max(0, Math.min(1, t));
  // Re-solve s for the clamped t.
  s = Math.max(0, Math.min(maxT, (dx * (c.ax + ux * t - ox) + dy * (c.ay + uy * t - oy) + dz * (c.az + uz * t - oz)) / (a || 1)));
  const px = ox + dx * s - (c.ax + ux * t), py = oy + dy * s - (c.ay + uy * t), pz = oz + dz * s - (c.az + uz * t);
  const dist = Math.hypot(px, py, pz);
  if (dist > c.r) return -1;
  return Math.max(0, s - Math.sqrt(Math.max(0, c.r * c.r - dist * dist)) / Math.sqrt(a || 1));
}

function angDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

