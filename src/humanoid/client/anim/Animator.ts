/**
 * Procedural humanoid animator.
 *
 * Layers (evaluated every frame, no clips):
 *  1. Locomotion families (ground gait, swim, climb, air, sit, sleep, dead,
 *     stunned) cross-faded by weight. The ground gait is one continuous
 *     function of speed (idle → walk → run → sprint, plus crouch) with the
 *     phase advanced by distance travelled / stride length, so feet never
 *     slide; hips turn toward the movement direction for strafing and the
 *     cycle runs backwards when backpedalling.
 *  2. Stance overlay: weapon-ready/relaxed carry poses per held item, idle
 *     personalities (arms crossed, hands on hips...).
 *  3. One-shot actions (actions.ts) masked to upper body / arms / full body.
 *  4. Additive: breathing, look-at (spine→neck→head→eyes), hit-reaction
 *     springs, acceleration lean.
 *  5. Two-bone leg IK on terrain with pelvis drop and foot alignment.
 *  6. Face: blinking, mood expressions, lip/jaw flap while talking, eye
 *     saccades, plus finger curl for grips.
 */
import * as THREE from 'three';
import type { Character } from '../Character';
import type { AnimState, MoveState, ActionAnim, Vec3 } from '../../../shared/types';
import { Pose, makeBoneMap, kf, clamp, smooth, approach, wrapPi, type BoneMap, type Side } from './pose';
import { ACTIONS, sitPose, type ActionCtx, type GripClass, type ActionDef } from './actions';
import { hash32 } from '../../../core/rng';
import { ClipRig, clipLibrary, clipSettings } from './clips';

export type GroundFn = (x: number, y: number, z: number) => number | null;

export interface AnimInput {
  anim: AnimState;
  /** World velocity (m/s). */
  vel: Vec3;
  /** Facing yaw (rad). */
  yaw: number;
  /** Server time (s) — action progress uses it. */
  time: number;
  main: GripClass;
  off: GripClass;
  combat: boolean;
  sneaking: boolean;
}

type Family = 'ground' | 'swim' | 'climb' | 'air' | 'glide' | 'sit' | 'sleep' | 'dead' | 'stunned';
const FAMILIES: Family[] = ['ground', 'swim', 'climb', 'air', 'glide', 'sit', 'sleep', 'dead', 'stunned'];
function familyOf(m: MoveState): Family {
  switch (m) {
    case 'swim': return 'swim';
    case 'climb': return 'climb';
    case 'jump': case 'fall': return 'air';
    case 'glide': case 'fly': return 'glide';
    case 'sit': return 'sit';
    case 'sleep': return 'sleep';
    case 'dead': case 'knockdown': return 'dead';
    case 'stunned': return 'stunned';
    default: return 'ground';
  }
}

const MOODS: Record<string, [string, number][]> = {
  neutral: [],
  happy: [['mouth-corner-puller', 0.75], ['mouth-upward-retraction', 0.15], ['eye-left-slit', 0.25], ['eye-right-slit', 0.25], ['eyebrows-left-up', 0.1], ['eyebrows-right-up', 0.1]],
  angry: [['eyebrows-left-down', 0.9], ['eyebrows-right-down', 0.9], ['nose-left-elevation', 0.35], ['nose-right-elevation', 0.35], ['mouth-compression', 0.45], ['eye-left-slit', 0.25], ['eye-right-slit', 0.25], ['neck-platysma', 0.2]],
  sad: [['eyebrows-left-inner-up', 0.9], ['eyebrows-right-inner-up', 0.9], ['mouth-depression', 0.6], ['eye-left-slit', 0.15], ['eye-right-slit', 0.15], ['mouth-pursing', 0.1]],
  afraid: [['eyebrows-left-inner-up', 0.7], ['eyebrows-right-inner-up', 0.7], ['eyebrows-left-up', 0.45], ['eyebrows-right-up', 0.45], ['eye-left-opened-up', 0.7], ['eye-right-opened-up', 0.7], ['mouth-retraction', 0.45], ['mouth-open', 0.15], ['neck-platysma', 0.35]],
  surprised: [['eyebrows-left-up', 1], ['eyebrows-right-up', 1], ['eye-left-opened-up', 0.85], ['eye-right-opened-up', 0.85], ['mouth-open', 0.45]],
  disgusted: [['nose-left-elevation', 0.8], ['nose-right-elevation', 0.8], ['mouth-upward-retraction', 0.5], ['eyebrows-left-down', 0.4], ['eyebrows-right-down', 0.4], ['eye-left-slit', 0.3], ['eye-right-slit', 0.3], ['mouth-depression', 0.2]],
  focused: [['eyebrows-left-down', 0.35], ['eyebrows-right-down', 0.35], ['eye-left-slit', 0.2], ['eye-right-slit', 0.2], ['mouth-compression', 0.2]],
  pain: [['eye-left-closure', 0.55], ['eye-right-closure', 0.55], ['eyebrows-left-down', 0.5], ['eyebrows-right-down', 0.5], ['eyebrows-left-inner-up', 0.4], ['eyebrows-right-inner-up', 0.4], ['mouth-retraction', 0.7], ['mouth-open', 0.2], ['nose-left-elevation', 0.4], ['nose-right-elevation', 0.4], ['neck-platysma', 0.5]],
};

const _e = new THREE.Euler();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3();

interface FingerRig { bones: THREE.Bone[]; axis: THREE.Vector3[]; thumb: boolean }

/** Raised-torch arm pose (Pose.arm params), tuned so the shaft points straight up at head height. */
const TORCH_RAISED = [1.7, 0.5, -0.4, 0.45, 0.3, -0.9, -0.4] as const;

export class Animator {
  readonly map: BoneMap;
  private base: Pose;
  private fam: Pose;
  private act: Pose;
  private out: Pose;
  private famW = new Map<Family, number>(FAMILIES.map((f) => [f, f === 'ground' ? 1 : 0]));
  private masks: Record<string, Float32Array>;
  private phase = 0;
  /** Gait cycle phase 0..1: left heel strike at 0.25, right at 0.75 (for footstep sounds). */
  get gaitPhase(): number { return this.phase; }
  private speed = 0;
  private hipYaw = 0;
  private lean = new THREE.Vector2();
  private prevVel = new THREE.Vector3();
  /** Low-passed planar velocity: acceleration (lean) is taken from this, not from raw frame-to-frame
   *  velocity, whose differences are mostly noise (collisions, ground steps, frame timing) and made
   *  the torso and arms tremble. */
  private smVel = new THREE.Vector3();
  /** Rest → neutral corrections (arms hanging straight, palms toward the thighs). */
  private neutral: (THREE.Quaternion | null)[] = [];
  private parentNeutral: (THREE.Quaternion | null)[] = [];
  private hipH = 0.9;
  private legLen = 0.85;
  private fingers: Record<Side, FingerRig[]> = { L: [], R: [] };
  private exprIdx = new Map<string, number>();
  private expr: Float32Array;
  private exprTarget: Float32Array;
  // Look-at state
  private look = new THREE.Vector2();
  private eyeLook = new THREE.Vector2();
  private glance = new THREE.Vector2();
  private glanceT = 0;
  private saccade = new THREE.Vector2();
  private saccadeT = 0;
  // Face
  private blinkT = 2;
  private blink = 0;
  private talkPhase = 0;
  private jaw = 0;
  // Reactions
  private hit = new THREE.Vector2();
  private hitV = new THREE.Vector2();
  private pain = 0;
  // Death
  private deadT = -1;
  private deadDir = 1;
  // Actions
  private lastActionKey = '';
  private actionVariant = 0;
  private actionW = 0;
  private lastAction: { def: ActionDef; id: string; t0: number; dur: number; aim?: Vec3 } | null = null;
  private idleStyle: number;
  private time = 0;
  /** Per-foot ground offsets from the last IK pass. */
  private footOff = [0, 0];
  private pelvisOff = 0;
  readonly seed: number;
  private tailBones = 0;
  // Clip locomotion (anim/clips.ts): rig once the library is loaded, blend state.
  private clipRig: ClipRig | null = null;
  private clipPose: Pose;
  private clipOn = 0;
  private crouchS = 0;
  private armClip = { L: 1, R: 1 };
  private idleClipT = 0;
  private talkS = 0;
  private swimU = 0;
  // Air and landing (clip families): time in the air, whether it began with a jump, landing.
  private prevFam: Family = 'ground';
  private airT = 0;
  private airJump = false;
  private landT = 9;
  private landK = 0;
  /** Sandbox: show this library clip on its own (u = normalized time, < 0 plays in real time). */
  preview: { name: string; u: number } | null = null;

  constructor(readonly ch: Character) {
    this.map = makeBoneMap(ch.bones.map((b) => b.name));
    this.base = new Pose(this.map);
    this.fam = new Pose(this.map);
    this.act = new Pose(this.map);
    this.out = new Pose(this.map);
    this.clipPose = new Pose(this.map);
    this.seed = ch.app.seed >>> 0;
    this.idleStyle = hash32(this.seed ^ 0x1d1e) % 7;
    this.computeNeutral();
    this.tailBones = ch.bones.filter((b) => b.name.startsWith('tail')).length;
    this.hipH = (ch.rest[this.map.idx('upperleg01.L')].y + ch.rest[this.map.idx('upperleg01.R')].y) / 2;
    this.legLen = this.hipH - ch.rest[this.map.idx('foot.L')].y + 0.05;
    // Masks.
    const B = this.map.count;
    const mk = (f: (n: string) => number) => {
      const m = new Float32Array(B);
      ch.bones.forEach((b, i) => (m[i] = f(b.name)));
      return m;
    };
    const isArm = (n: string) => /^(clavicle|shoulder01|upperarm|lowerarm|wrist|finger)/.test(n);
    this.masks = {
      full: mk(() => 1),
      upper: mk((n) => (isArm(n) || /^(neck|head|jaw)/.test(n) ? 1 : n === 'spine01' || n === 'spine02' ? 1 : n === 'spine03' ? 0.8 : n === 'spine04' ? 0.5 : n === 'spine05' ? 0.3 : 0)),
      arms: mk((n) => (isArm(n) ? 1 : 0)),
      rightArm: mk((n) => (isArm(n) && n.endsWith('.R') ? 1 : 0)),
      face: mk(() => 0),
    };
    // Finger rigs: curl axis = fingerDir × palmNormal (rest, model axes = local axes).
    for (const s of ['L', 'R'] as const) {
      const hb = ch.geo.build.body.sockets[`hand.${s}`].basis;
      const palm = new THREE.Vector3(-hb[6], -hb[7], -hb[8]);
      for (let f = 1; f <= 5; f++) {
        const bones: THREE.Bone[] = [], axis: THREE.Vector3[] = [];
        for (let k = 1; k <= 3; k++) {
          const i = this.map.idx(`finger${f}-${k}.${s}`);
          const next = k < 3 ? this.map.idx(`finger${f}-${k + 1}.${s}`) : -1;
          const h = ch.rest[i];
          const t = next >= 0 ? ch.rest[next] : h.clone().add(h.clone().sub(ch.rest[this.map.idx(`finger${f}-${k - 1}.${s}`)]));
          const d = t.clone().sub(h).normalize();
          const n = f === 1 ? palm.clone().add(new THREE.Vector3(0, 0, 0)) : palm;
          bones.push(ch.bones[i]);
          axis.push(new THREE.Vector3().crossVectors(d, n).normalize());
        }
        this.fingers[s].push({ bones, axis, thumb: f === 1 });
      }
    }
    // Expression unit indices.
    const names = ch.geo.st.exprNames;
    names.forEach((n, i) => this.exprIdx.set(n, i));
    this.expr = new Float32Array(names.length);
    this.exprTarget = new Float32Array(names.length);
  }

  /** Damage/hit impulse in world space (direction the hit pushes the body). */
  onHit(dirX: number, dirZ: number, strength: number) {
    // Into character space.
    const yaw = this.facingYaw;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const lx = c * dirX - s * dirZ, lz = s * dirX + c * dirZ;
    const k = clamp(strength, 0.2, 1.5);
    this.hitV.x += lz * 6 * k; // pitch: pushed backward (+z) leans back
    this.hitV.y += -lx * 5 * k;
    this.pain = Math.min(1, this.pain + 0.6 * k);
  }

  /** World facing of the character (the yaw lives on the rig root, not on ch.object). */
  private facingYaw = 0;

  update(inp: AnimInput, dt: number, lod: number, ground: GroundFn | null) {
    this.facingYaw = inp.yaw;
    dt = Math.min(dt, 0.1);
    this.time += dt;
    const a = inp.anim;
    const fam = familyOf(a.move);
    for (const f of FAMILIES) {
      const target = f === fam ? 1 : 0;
      const rate = f === 'dead' || fam === 'dead' ? 9 : 7;
      this.famW.set(f, approach(this.famW.get(f)!, target, rate, dt));
    }
    if (fam === 'dead' && this.deadT < 0) { this.deadT = 0; this.deadDir = hash32(this.seed + Math.floor(inp.time)) % 3 === 0 ? -1 : 1; }
    if (fam !== 'dead') this.deadT = -1; else this.deadT += dt;
    if (fam === 'air' && this.prevFam !== 'air') { this.airT = 0; this.airJump = inp.vel[1] > 1; }
    if (fam === 'air') this.airT += dt;
    // Landing after a real fall or jump (not a stumble off a step).
    if (fam === 'ground' && this.prevFam === 'air' && this.airT > 0.3) { this.landT = 0; this.landK = smooth(0.3, 1.0, this.airT); }
    this.landT += dt;
    this.prevFam = fam;

    // ---- velocity in character space
    const yaw = inp.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const vx = inp.vel[0], vz = inp.vel[2];
    const vf = vx * fx + vz * fz, vr = vx * rx + vz * rz;
    const hs = Math.hypot(vx, vz);
    this.speed = approach(this.speed, hs, 10, dt);
    // Acceleration lean.
    this.smVel.x = approach(this.smVel.x, vx, 6, dt);
    this.smVel.z = approach(this.smVel.z, vz, 6, dt);
    const ax = (this.smVel.x - this.prevVel.x) / Math.max(dt, 1e-3), az = (this.smVel.z - this.prevVel.z) / Math.max(dt, 1e-3);
    this.prevVel.set(this.smVel.x, inp.vel[1], this.smVel.z);
    const af = ax * fx + az * fz, ar = ax * rx + az * rz;
    this.lean.x = approach(this.lean.x, clamp(-af * 0.03, -0.2, 0.2), 4, dt);
    this.lean.y = approach(this.lean.y, clamp(ar * 0.025, -0.15, 0.15), 4, dt);

    // ---- base pose: blend families
    const base = this.base.clear();
    let wsum = 0;
    for (const f of FAMILIES) {
      const w = this.famW.get(f)!;
      if (w < 0.002) continue;
      this.fam.clear();
      this.familyPose(f, this.fam, inp, vf, vr, hs, dt);
      wsum += w;
      base.addScaled(this.fam, w);
    }
    if (wsum > 0 && Math.abs(wsum - 1) > 1e-3) {
      const k = 1 / wsum;
      for (let i = 0; i < base.rot.length; i++) base.rot[i] *= k;
      base.root.multiplyScalar(k);
    }

    // ---- actions
    const out = this.out.copy(base);
    let actionMood: string | undefined;
    const action = this.currentAction(a.action, inp.time);
    if (action) {
      const { def, elapsed, t } = action;
      const ctx: ActionCtx = { main: inp.main, off: inp.off, variant: this.actionVariant, elapsed, dur: this.lastAction!.dur, aimPitch: this.aimPitch(this.lastAction!.aim) };
      this.act.copy(base);
      // Actions author absolute arm/spine angles over the neutral; start from base for unmasked parts.
      const mask = this.masks[def.mask];
      const actPose = this.fam.clear();
      // Motion-captured clip when the action has one for this situation, else the authored pose.
      const use = this.clipRig && clipSettings.enabled ? def.clip?.(ctx) : null;
      const clip = use ? this.clipRig!.clip(use.name) : null;
      if (clip) {
        const u = def.loop ? elapsed / clip.meta.dur : (use!.from ?? 0) + ((use!.to ?? 1) - (use!.from ?? 0)) * t;
        this.clipRig!.accumulate(clip, u, 1, actPose);
      } else def.pose(actPose, t, ctx);
      for (let b = 0; b < this.map.count; b++) {
        const m = mask[b];
        if (m <= 0) continue;
        const i = b * 3;
        // Masked bones: action replaces locomotion (but keep a little of the gait on the spine).
        this.act.rot[i] = this.act.rot[i] * (1 - m) + actPose.rot[i] * m + (def.mask === 'upper' && b < 6 ? base.rot[i] * 0.3 * m : 0);
        this.act.rot[i + 1] = this.act.rot[i + 1] * (1 - m) + actPose.rot[i + 1] * m;
        this.act.rot[i + 2] = this.act.rot[i + 2] * (1 - m) + actPose.rot[i + 2] * m;
      }
      // Clips carry the absolute hips offset; authored poses add to the locomotion's.
      if (def.mask === 'full') {
        if (clip) this.act.root.copy(actPose.root);
        else this.act.root.copy(base.root).add(actPose.root);
      }
      // Blend weight with ease in/out (loops hold full weight).
      const tin = def.blendIn, tout = def.blendOut;
      let w = def.loop ? Math.min(1, elapsed / Math.max(0.05, this.lastAction!.dur * tin + 0.1)) : smooth(0, tin, t) * (1 - smooth(1 - tout, 1, t));
      if (a.action?.id === 'die' || fam === 'dead') w = 0;
      this.actionW = w;
      out.blend(this.act, w);
      if (w > 0.3) actionMood = def.mood;
    } else this.actionW = approach(this.actionW, 0, 10, dt);

    // ---- sandbox clip preview (whole body from one clip)
    const pv = this.preview && this.clipRig?.clip(this.preview.name);
    if (pv) {
      out.clear();
      this.clipRig!.accumulate(pv, this.preview!.u >= 0 ? this.preview!.u : this.time / pv.meta.dur, 1, out);
    }

    // ---- additive layers
    this.additives(out, inp, dt, fam);

    // ---- apply
    this.apply(out);
    this.fingerPose(inp, action?.def, dt);
    // ---- IK & face (near only)
    if (lod === 0 && ground && (fam === 'ground' || fam === 'sit' || fam === 'stunned') && this.famW.get('ground')! > 0.5) this.footIK(ground, dt);
    else { this.footOff[0] = this.footOff[1] = 0; this.pelvisOff = approach(this.pelvisOff, 0, 8, dt); }
    if (lod === 0) {
      this.face(inp, actionMood, fam, dt);
      this.eyes(inp, dt);
    } else this.ch.exprW.fill(0);
  }

  // ------------------------------------------------------------------ families

  private familyPose(f: Family, p: Pose, inp: AnimInput, vf: number, vr: number, hs: number, dt: number) {
    this.familyProcedural(f, p, inp, vf, vr, hs, dt);
    // Clip families replace the procedural pose on the bones clips drive (cross-faded by clipOn).
    const rig = this.clipRig;
    if (!rig || this.clipOn < 0.002 || f === 'ground') return;
    const c = this.clipPose.clear();
    if (!this.familyClip(f, c, inp, hs, dt)) return;
    const w = this.clipOn;
    for (const b of rig.bones) {
      const i = b * 3;
      p.rot[i] += wrapPi(c.rot[i] - p.rot[i]) * w;
      p.rot[i + 1] += wrapPi(c.rot[i + 1] - p.rot[i + 1]) * w;
      p.rot[i + 2] += wrapPi(c.rot[i + 2] - p.rot[i + 2]) * w;
    }
    p.root.lerp(c.root, w);
  }

  /**
   * Clip poses for swimming, sitting, the air and death (false: no clip for this family).
   * Heights are matched to the procedural poses, which are tuned to the water line, seats and
   * the ground.
   */
  private familyClip(f: Family, p: Pose, inp: AnimInput, hs: number, dt: number): boolean {
    const rig = this.clipRig!;
    const k = this.hipH / 0.9;
    switch (f) {
      case 'swim': {
        const fwd = rig.clip('Swim_Fwd_Loop'), tread = rig.clip('Swim_Idle_Loop');
        if (!fwd || !tread) return false;
        const moving = smooth(0.2, 0.8, hs);
        this.swimU += (dt / fwd.meta.dur) * (0.7 + 0.3 * Math.min(2, hs / 2.6));
        rig.accumulate(fwd, this.swimU, moving, p);
        rig.accumulate(tread, this.time / tread.meta.dur, 1 - moving, p);
        p.root.y += (0.09 * moving - 0.23 * (1 - moving)) * k;
        return true;
      }
      case 'sit': {
        const idle = rig.clip('Sitting_Idle_Loop'), talk = rig.clip('Sitting_Talking_Loop');
        if (!idle || !talk) return false;
        this.talkS = approach(this.talkS, inp.anim.talking ? 1 : 0, 3, dt);
        rig.accumulate(idle, this.time / idle.meta.dur, 1 - this.talkS, p);
        rig.accumulate(talk, this.time / talk.meta.dur, this.talkS, p);
        p.root.y -= 0.19 * k;
        return true;
      }
      case 'air': {
        const start = rig.clip('Jump_Start'), loop = rig.clip('Jump_Loop');
        if (!start || !loop) return false;
        // A jump plays its take-off (from the moment the feet leave the ground), then the
        // airborne loop; falling off something goes straight to the loop.
        const u = 0.28 + this.airT / start.meta.dur;
        const ws = this.airJump ? 1 - smooth(0.85, 1, u) : 0;
        if (ws > 0) rig.accumulate(start, Math.min(1, u), ws, p);
        rig.accumulate(loop, this.airT / loop.meta.dur, 1 - ws, p);
        // The physics moves the body; the clip's hips height would lift it off the capsule.
        p.root.set(0, 0, 0);
        return true;
      }
      case 'dead': {
        if (inp.anim.move !== 'dead') return false; // knockdowns stay procedural (they get up)
        const die = rig.clip('Death01');
        if (!die) return false;
        rig.accumulate(die, Math.max(0, this.deadT) / die.meta.dur, 1, p);
        return true;
      }
      default:
        return false;
    }
  }

  private familyProcedural(f: Family, p: Pose, inp: AnimInput, vf: number, vr: number, hs: number, dt: number) {
    switch (f) {
      case 'ground': return this.ground(p, inp, vf, vr, hs, dt);
      case 'swim': return this.swim(p, hs, dt);
      case 'climb': return this.climb(p, inp.vel[1], dt);
      case 'air': return this.air(p, inp.vel[1]);
      case 'glide': return this.glide(p, inp.anim.move === 'fly');
      case 'sit': {
        sitPose(p, 1);
        p.root.y -= this.hipH - 0.13 * (this.hipH / 0.9);
        p.root.z += 0.08;
        p.spine(0.02 * Math.sin(this.time * 1.6));
        return;
      }
      case 'sleep': return this.lying(p, 1, false);
      case 'dead': return this.dead(p);
      case 'stunned': {
        this.ground(p, inp, 0, 0, 0, dt);
        const w = this.time;
        p.neck(-0.35 + Math.sin(w * 1.7) * 0.15, Math.sin(w * 1.1) * 0.35, Math.sin(w * 2.3) * 0.2);
        p.spine(-0.15, Math.sin(w * 0.9) * 0.2, Math.sin(w * 1.3) * 0.08);
        p.arm('L', 0.1, 0.15, 0, 0.3);
        p.arm('R', 0.1, 0.15, 0, 0.3);
        p.leg('L', 0.2, 0.05, 0, 0.45);
        p.leg('R', 0.15, 0.05, 0, 0.4);
        p.root.y -= 0.06;
        p.root.x += Math.sin(w * 1.4) * 0.03;
        return;
      }
    }
  }

  private ground(p: Pose, inp: AnimInput, vf: number, vr: number, hs: number, dt: number) {
    const crouch = inp.anim.move === 'crouch' || inp.sneaking ? 1 : 0;
    const sp = this.speed;
    // Gait style weights by speed.
    // Wide fade: walking into standing over a broad speed range (a narrow one snapped the arms
    // from mid-swing into the idle pose in a few frames).
    const moving = smooth(0.05, 0.8, sp);
    const run = smooth(2.6, 4.0, sp);
    const sprint = smooth(5.2, 7.0, sp);
    // Stride (full cycle) length scales with the legs.
    const L = this.legLen;
    let cycle = L * (crouch ? 1.15 : 1.45 + run * 1.15 + sprint * 0.6) * (0.85 + 0.15 * Math.min(1.5, sp / 1.5));
    const gait = this.clipGait(inp, crouch, moving, dt);
    if (gait) cycle = gait.cycle;
    // Movement direction relative to facing: hips turn toward it; backpedal reverses the cycle.
    let ang = Math.atan2(vr, vf);
    let dir = 1;
    if (Math.abs(ang) > 1.9) { ang = ang - Math.sign(ang) * Math.PI; dir = -1; }
    this.hipYaw = approach(this.hipYaw, hs > 0.3 ? clamp(ang, -1.1, 1.1) * 0.75 : 0, 6, dt);
    // The cycle runs on with the (smoothed) speed, so a stop finishes the swing as it fades
    // instead of freezing the limbs mid-stride.
    this.phase = (this.phase + (dir * Math.max(hs, sp) * dt) / Math.max(0.3, cycle) + 1) % 1;
    const ph = this.phase;
    const A = (0.3 + run * 0.28 + sprint * 0.15) * moving * (crouch ? 0.8 : 1);
    const armA = (0.28 + run * 0.35 + sprint * 0.2) * moving;
    let bob = 0;
    for (const s of ['L', 'R'] as const) {
      const phi = ph + (s === 'R' ? 0.5 : 0);
      const th = phi * Math.PI * 2;
      // Swing progress: leg moves forward while cos(th) > 0.
      const swingU = (((phi + 0.25) % 1) + 1) % 1 * 2; // 0..1 during swing, 1..2 stance
      const inSwing = swingU < 1;
      const swingBump = inSwing ? Math.sin(Math.PI * Math.pow(swingU, 0.8)) : 0;
      const stanceU = inSwing ? 0 : swingU - 1;
      const flex = A * Math.sin(th);
      const kneeSwing = (0.9 + run * 0.8 + sprint * 0.4) * swingBump * moving;
      const kneeStance = (0.08 + run * 0.35) * Math.sin(Math.PI * stanceU) * moving;
      const toeOff = Math.exp(-Math.pow((stanceU - 0.92) / 0.08, 2)) * (0.35 + run * 0.25) * moving;
      const ankle = -0.18 * swingBump * moving + toeOff + (inSwing ? 0 : -0.08 * Math.sin(Math.PI * stanceU) * moving);
      const knee = 0.05 + kneeSwing + kneeStance + crouch * 0.95;
      p.leg(s, flex + crouch * 0.75 + 0.02, -0.06 + crouch * 0.08, 0, knee, ankle - crouch * 0.25, -toeOff * 0.8);
      // Arms swing opposite to the legs.
      const armSwing = -armA * Math.sin(th);
      const elbow = 0.18 + run * 1.15 + sprint * 0.2 + Math.max(0, armSwing) * 0.5 + crouch * 0.4;
      // A raised torch stays up: that arm only sways slightly with the stride.
      const torchArm = s === 'L' ? inp.off === 'torch' : inp.main === 'torch';
      // (Keeps the standing base offsets TORCH_RAISED was tuned with.)
      if (torchArm) p.arm(s, armSwing * 0.12 + 0.04, 0.04, 0.15, 0.18, 0.5, 0.1, 0, Math.abs(armSwing) * 0.05);
      else p.arm(s, armSwing + 0.04 + crouch * 0.25, 0.04 + run * 0.08, 0.15, elbow, 0.5 + run * 0.4, 0.1, 0);
      if (s === 'L') bob = Math.cos(2 * th);
      // Pelvis turns with the swinging leg, shoulders counter-rotate.
      if (s === 'L') {
        const twist = -0.22 * A * Math.sin(th) * (1 - run * 0.3);
        p.add('root', 0, twist, 0);
        p.spine(0, -twist * 1.6, 0);
        p.root.x += 0.018 * Math.cos(th) * moving * (1 - run * 0.6);
        p.add('root', 0, 0, 0.035 * Math.sin(th) * moving * (1 - run));
      }
    }
    // Vertical bob: walking peaks at mid-stance, running peaks in flight.
    p.root.y += (0.022 * (1 - run) * bob - 0.045 * run * bob) * moving - run * 0.03 - crouch * this.legLen * 0.3;
    // Forward lean with speed; crouch hunches.
    p.spine(-0.06 * moving - run * 0.12 - sprint * 0.16 - crouch * 0.35, 0, 0);
    p.add('root', -(run * 0.06 + sprint * 0.1 + crouch * 0.15), 0, 0);
    p.neck(run * 0.12 + sprint * 0.12 + crouch * 0.4);
    // Clip locomotion replaces the procedural gait (arms holding something keep theirs).
    if (gait) {
      this.applyClipGait(p, gait.w);
      this.landing(p, gait.w);
    }
    // Hips toward movement direction, torso keeps facing forward.
    p.add('root', 0, -this.hipYaw, 0);
    p.spine(0, this.hipYaw * 0.85, 0);

    // ---- idle life: breathing, weight shift, personality
    const idle = 1 - moving;
    if (idle > 0.01) {
      const t = this.time;
      // (The idle clip shifts its weight itself.)
      const life = idle * (1 - this.clipOn);
      const shift = Math.sin(t * 0.37 + this.seed) * 0.5 + Math.sin(t * 0.13) * 0.5;
      p.root.x += shift * 0.025 * life;
      p.add('root', 0, 0, -shift * 0.03 * life);
      p.spine(0, 0, shift * 0.04 * life);
      p.leg('L', 0, 0.03 * life, -0.05 * life, (0.06 + Math.max(0, -shift) * 0.12) * life);
      p.leg('R', 0, 0.03 * life, -0.05 * life, (0.06 + Math.max(0, shift) * 0.12) * life);
      const combat = inp.combat && inp.main !== 'none';
      if (!combat && inp.main === 'none' && inp.off === 'none' && !crouch) this.idlePersonality(p, idle);
    }
    this.carryPose(p, inp, moving, run, crouch);
  }

  /**
   * Clip locomotion: idle / walk / jog / sprint (or crouch idle / crouch walk) weighted by speed,
   * all moving clips in step (normalized phase aligned on the left footfall). Accumulates the
   * blended clip pose into clipPose; returns the blended stride length for the phase, or null
   * while clips are off or not loaded.
   */
  private clipGait(inp: AnimInput, crouch: number, moving: number, dt: number): { cycle: number; w: number } | null {
    if (!this.clipRig) {
      const lib = clipLibrary();
      if (lib) this.clipRig = new ClipRig(this.ch, this.map, lib, this.neutral, this.parentNeutral, this.legLen);
    }
    this.clipOn = approach(this.clipOn, this.clipRig && clipSettings.enabled ? 1 : 0, 4, dt);
    const rig = this.clipRig;
    if (!rig || this.clipOn < 0.002) return null;
    const idle = rig.clip('Idle_Loop'), walk = rig.clip('Walk_Loop'), jog = rig.clip('Jog_Fwd_Loop'), sprint = rig.clip('Sprint_Loop');
    const cIdle = rig.clip('Crouch_Idle_Loop'), cWalk = rig.clip('Crouch_Fwd_Loop');
    if (!idle || !walk || !jog || !sprint || !cIdle || !cWalk) return null;
    this.crouchS = approach(this.crouchS, crouch, 8, dt);
    this.talkS = approach(this.talkS, inp.anim.talking ? 1 : 0, 3, dt);
    const talkIdle = rig.clip('Idle_Talking_Loop');
    const sp = this.speed, cr = this.crouchS;
    const jogT = smooth(1.9, 3.6, sp), sprT = smooth(5.6, 7.6, sp);
    const stand = 1 - cr;
    const talk = talkIdle ? this.talkS : 0;
    const ws = [
      [idle, (1 - moving) * stand * (1 - talk)],
      [talkIdle ?? idle, (1 - moving) * stand * talk],
      [walk, moving * (1 - jogT) * stand],
      [jog, moving * jogT * (1 - sprT) * stand],
      [sprint, moving * jogT * sprT * stand],
      [cIdle, (1 - moving) * cr],
      [cWalk, moving * cr],
    ] as const;
    // Stride of the blend (moving clips only): the phase advances by distance / stride.
    let cyc = 0, cw = 0;
    for (const [c, w] of ws) if (c.speed > 0.05 && w > 0) { cyc += c.cycle * w; cw += w; }
    const cycle = cw > 1e-4 ? cyc / cw : walk.cycle;
    // Accumulate (the phase is advanced by the caller with this cycle; one frame of lag is fine).
    const out = this.clipPose.clear();
    this.idleClipT += dt;
    let sum = 0;
    for (const [c, w] of ws) {
      if (w < 0.002) continue;
      // Procedural phase: left leg furthest forward at 0.25. Clip: at its sync point.
      const u = c.speed > 0.05 ? this.phase - 0.25 + c.meta.sync : this.idleClipT / c.meta.dur;
      rig.accumulate(c, u, w, out);
      sum += w;
    }
    if (sum <= 0) return null;
    const k = 1 / sum;
    for (const b of rig.bones) { const i = b * 3; out.rot[i] *= k; out.rot[i + 1] *= k; out.rot[i + 2] *= k; }
    out.root.multiplyScalar(k);
    // Arms holding something stay procedural (carry poses are authored over the neutral).
    const ready = inp.combat;
    const two = inp.main === 'twohand' || inp.main === 'polearm' || inp.main === 'staff';
    const oneHand = !two && inp.main !== 'bow' && inp.main !== 'crossbow' && inp.main !== 'torch';
    const rFree = inp.main === 'none' || (oneHand && !ready);
    const lFree = inp.off === 'none' && !(two && ready) && inp.main !== 'bow';
    this.armClip.R = approach(this.armClip.R, rFree ? 1 : 0, 8, dt);
    this.armClip.L = approach(this.armClip.L, lFree ? 1 : 0, 8, dt);
    return { cycle, w: this.clipOn };
  }

  /** Landing from a jump or fall: the landing clip's knee bend, faded out when running on. */
  private landing(p: Pose, w: number) {
    const T = 0.75;
    if (this.landT >= T) return;
    const rig = this.clipRig!, c = rig.clip('Jump_Land');
    if (!c) return;
    const k = w * this.landK * smooth(0, 0.06, this.landT) * (1 - smooth(0.4, T, this.landT)) * (1 - smooth(0.8, 3, this.speed));
    if (k < 0.002) return;
    const src = this.clipPose.clear();
    rig.accumulate(c, 0.04 + (0.5 * this.landT) / T, 1, src);
    for (const b of rig.bones) {
      const i = b * 3;
      p.rot[i] += wrapPi(src.rot[i] - p.rot[i]) * k;
      p.rot[i + 1] += wrapPi(src.rot[i + 1] - p.rot[i + 1]) * k;
      p.rot[i + 2] += wrapPi(src.rot[i + 2] - p.rot[i + 2]) * k;
    }
    p.root.lerp(src.root, k);
  }

  private applyClipGait(p: Pose, w: number) {
    const rig = this.clipRig!, src = this.clipPose, armM = this.masks.arms;
    for (const b of rig.bones) {
      let m = w;
      if (armM[b] > 0) m *= this.ch.bones[b].name.endsWith('.L') ? this.armClip.L : this.armClip.R;
      if (m <= 0) continue;
      const i = b * 3;
      p.rot[i] += wrapPi(src.rot[i] - p.rot[i]) * m;
      p.rot[i + 1] += wrapPi(src.rot[i + 1] - p.rot[i + 1]) * m;
      p.rot[i + 2] += wrapPi(src.rot[i + 2] - p.rot[i + 2]) * m;
    }
    p.root.lerp(src.root, w);
  }

  private idlePersonality(p: Pose, w: number) {
    switch (this.idleStyle) {
      case 1: // arms crossed (negative twist = internal rotation)
        p.arm('L', 0.3 * w, -0.15 * w, -1.05 * w, 1.35 * w, 0.4 * w);
        p.arm('R', 0.27 * w, -0.1 * w, -1.1 * w, 1.45 * w, 0.4 * w);
        break;
      case 2: // hands loosely folded in front of the belly (upper arms slightly forward:
        // negative fwd = shoulder extension would put the hands behind the back)
        p.arm('L', 0.32 * w, 0.06 * w, -0.85 * w, 1.05 * w, 0.3 * w, -0.2 * w);
        p.arm('R', 0.32 * w, 0.06 * w, -0.85 * w, 1.05 * w, 0.3 * w, -0.2 * w);
        break;
      default:
        p.arm('L', 0.04 * w, 0.02 * w, 0.1 * w, 0.18 * w, 0.4 * w);
        p.arm('R', 0.04 * w, 0.02 * w, 0.1 * w, 0.18 * w, 0.4 * w);
    }
  }

  /** How held items are carried (relaxed or combat-ready). */
  private carryPose(p: Pose, inp: AnimInput, moving: number, run: number, crouch: number) {
    const main = inp.main, off = inp.off;
    const ready = inp.combat ? 1 : 0;
    const keep = 1 - run * 0.5;
    if (main !== 'none') {
      const two = main === 'twohand' || main === 'polearm' || main === 'staff';
      if (two) {
        if (ready) {
          p.arm('R', 0.75 * keep, 0.3, -0.3, 1.25, 0.6, 0.2);
          p.arm('L', 0.85 * keep, -0.25, 0.4, 1.35, 0.6, 0.2);
        } else if (main === 'staff' || main === 'polearm') {
          // Staff held upright like a walking stick.
          p.arm('R', 0.35, 0.2, 0.3, 1.25, 0.9, -0.2);
        } else {
          // Greatsword/axe rested on the shoulder.
          p.arm('R', 0.55, 0.35, -0.2, 2.0, 0.8, 0.4);
        }
      } else if (main === 'bow' || main === 'crossbow') {
        p.arm('R', 0.15, 0.08, 0, 0.35, 0.6);
      } else if (main === 'torch') {
        p.arm('R', TORCH_RAISED[0], TORCH_RAISED[1], TORCH_RAISED[2], TORCH_RAISED[3], TORCH_RAISED[4], TORCH_RAISED[5], TORCH_RAISED[6]);
      } else {
        // One-handed: relaxed at the side, or raised guard.
        // Guard: forearm forward, thumb (blade) up. Relaxed: blade angled down-forward.
        if (ready) p.arm('R', 0.85 * keep, 0.3, -0.2, 1.45, 0.1, 0.25);
        else p.arm('R', 0.12, 0.06, 0.1, 0.45 + run * 0.6, 0.05, -0.7);
      }
    }
    if (off === 'shield') {
      if (ready) p.arm('L', 0.95 * keep, 0.3, 0.5, 1.55, 1.1);
      else p.arm('L', 0.1, 0.15, 0.4, 0.9, 1.0);
    } else if (off === 'torch') {
      // Torch raised high beside the head, elbow bent, shaft upright.
      const t = TORCH_RAISED;
      p.arm('L', t[0], t[1], t[2], t[3], t[4], t[5], t[6]);
    } else if (off === 'item' || off === 'tool') {
      p.arm('L', 0.45 * keep, 0.12, 0, 1.45, 0.8, -0.3);
    } else if (off === 'bow' || main === 'bow') {
      p.arm('L', 0.25, 0.1, 0.4, 0.55, 0.8);
    }
    if (ready) {
      p.leg('L', 0.2 * (1 - moving), 0.12 * (1 - moving), 0, 0.3 * (1 - moving));
      p.leg('R', -0.1 * (1 - moving), 0.12 * (1 - moving), 0, 0.3 * (1 - moving));
      p.root.y -= 0.04 * (1 - moving);
      p.spine(-0.08, 0.1 * (1 - moving), 0);
    }
    void crouch;
  }

  private swim(p: Pose, hs: number, dt: number) {
    const moving = smooth(0.2, 0.8, hs);
    this.phase = (this.phase + dt * (0.35 + hs * 0.35)) % 1;
    const th = this.phase * Math.PI * 2;
    // Front crawl when moving, treading water otherwise.
    p.add('root', -1.25 * moving - 0.15, 0, Math.sin(th) * 0.12 * moving);
    p.neck(0.85 * moving + 0.1, 0, 0);
    for (const s of ['L', 'R'] as const) {
      const a = th + (s === 'R' ? Math.PI : 0);
      const stroke = (a % (Math.PI * 2)) / (Math.PI * 2);
      const fwd = kf(stroke, [[0, 3.0], [0.5, 0.2], [0.55, 0.1], [1, 3.0]]);
      const out = kf(stroke, [[0, 0.2], [0.5, 0.1], [0.75, 0.9], [1, 0.2]]);
      const tread = { fwd: 0.7 + Math.sin(th * 2 + (s === 'R' ? 1 : 0)) * 0.25, out: 0.55 + Math.sin(th * 2) * 0.35 };
      p.arm(s, fwd * moving + tread.fwd * (1 - moving), out * moving + tread.out * (1 - moving), 0, kf(stroke, [[0, 0.2], [0.5, 0.6], [0.8, 1.4], [1, 0.2]]) * moving + 0.8 * (1 - moving), 0.6);
      const kick = Math.sin(a * 2) * 0.28;
      p.leg(s, kick * moving + Math.sin(a) * 0.45 * (1 - moving), 0.08, 0, 0.25 + Math.max(0, -kick) * 0.6 + (1 - moving) * Math.max(0, Math.cos(a)) * 0.9, 0.5 * moving);
    }
    p.root.y -= 0.3 * this.hipH * (1 - moving) + 0.15 * moving;
  }

  private climb(p: Pose, vy: number, dt: number) {
    this.phase = (this.phase + dt * Math.min(1.5, Math.abs(vy) / 0.7 + 0.05) * Math.sign(vy || 1)) % 1;
    const th = (this.phase + 1) * Math.PI * 2;
    for (const s of ['L', 'R'] as const) {
      const a = th + (s === 'R' ? Math.PI : 0);
      p.arm(s, 2.45 + 0.45 * Math.sin(a), 0.35, 0, 0.6 + 0.6 * Math.max(0, -Math.sin(a)), 0.6, -0.3);
      p.leg(s, 0.45 + 0.55 * Math.max(0, Math.sin(a + Math.PI)), 0.15, 0, 0.7 + 0.8 * Math.max(0, Math.sin(a + Math.PI)), 0.3);
    }
    p.spine(-0.12, 0, 0);
    p.neck(0.25);
    p.root.z += 0.05;
  }

  private air(p: Pose, vy: number) {
    const rising = smooth(-1, 2, vy);
    const t = this.time;
    const flail = 1 - smooth(-6, -2, vy) * 0 - rising;
    for (const s of ['L', 'R'] as const) {
      const o = s === 'R' ? 1.3 : 0;
      p.arm(s, 0.7 * rising + (0.5 + 0.4 * Math.sin(t * 5 + o)) * flail, 0.5 * rising + (1.0 + 0.3 * Math.sin(t * 7 + o)) * flail, 0, 0.8);
      p.leg(s, 0.55 * rising + (0.3 + 0.2 * Math.sin(t * 4 + o)) * flail, 0.05, 0, 0.9 * rising + 0.5 * flail, 0.2);
    }
    p.spine(-0.08 * rising + 0.05 * flail);
    p.neck(-0.1 * flail);
  }

  private glide(p: Pose, fly: boolean) {
    const t = this.time;
    const s = Math.sin(t * 1.3) * 0.05;
    if (fly) {
      // Levitation: upright, arms slightly out, legs dangling.
      p.arm('L', 0.15, 0.55 + s, 0, 0.3);
      p.arm('R', 0.15, 0.55 - s, 0, 0.3);
      p.leg('L', 0.15 + s, 0.05, 0, 0.35, -0.5);
      p.leg('R', 0.05 - s, 0.05, 0, 0.25, -0.5);
      return;
    }
    p.add('root', -0.95, 0, s);
    p.arm('L', 0.15, 1.45 + s, 0, 0.1);
    p.arm('R', 0.15, 1.45 - s, 0, 0.1);
    p.leg('L', -0.15, 0.1, 0, 0.25, -0.5);
    p.leg('R', -0.2, 0.1, 0, 0.3, -0.5);
    p.neck(0.9);
  }

  /** Lying on the back (sleep) or the death pose. */
  private lying(p: Pose, k: number, limp: boolean) {
    const s = limp ? this.deadDir : 1;
    p.add('root', (Math.PI / 2) * k * s, 0, 0);
    p.root.y -= (this.hipH - 0.11) * k;
    p.root.z += 0.0;
    p.neck(0, 0.45 * k, 0);
    p.arm('L', 0.1, (limp ? 0.9 : 0.15) * k, 0.3, (limp ? 0.6 : 0.4) * k);
    p.arm('R', limp ? -0.2 : 0.1, (limp ? 0.4 : 0.15) * k, 0.3, (limp ? 1.2 : 0.4) * k);
    p.leg('L', (limp ? 0.1 : 0.1) * k, 0.1 * k, 0, (limp ? 0.7 : 0.25) * k);
    p.leg('R', 0, 0.06 * k, 0, 0.1 * k);
    if (!limp) p.spine(0.02 * Math.sin(this.time * 1.1));
  }

  private dead(p: Pose) {
    const t = Math.max(0, this.deadT);
    if (this.deadT < 0 || t > 1.4) return this.lying(p, 1, true);
    // Knees buckle, then the body topples with gravity-like ease-in and a small bounce.
    const buckle = kf(t, [[0, 0], [0.35, 1], [0.9, 0.3], [1.4, 0]]);
    const fall = t < 0.3 ? 0 : Math.min(1, Math.pow((t - 0.3) / 0.6, 2));
    const bounce = t > 0.9 ? Math.sin(Math.min(1, (t - 0.9) / 0.4) * Math.PI) * 0.08 * (1 - (t - 0.9) / 0.5) : 0;
    this.lying(p, fall, true);
    p.leg('L', 0.6 * buckle, 0, 0, 1.3 * buckle, 0.3 * buckle);
    p.leg('R', 0.5 * buckle, 0, 0, 1.1 * buckle, 0.3 * buckle);
    p.spine(-0.35 * buckle * this.deadDir);
    p.neck(-0.4 * buckle);
    p.root.y -= this.hipH * 0.3 * buckle * (1 - fall);
    p.add('root', -bounce * this.deadDir, 0, 0);
  }

  // ------------------------------------------------------------------ actions

  private currentAction(a: ActionAnim | undefined, now: number): { def: ActionDef; t: number; elapsed: number } | null {
    if (a && ACTIONS[a.id]) {
      const key = `${a.id}@${a.t0}`;
      if (key !== this.lastActionKey) {
        this.lastActionKey = key;
        this.actionVariant = (this.actionVariant + 1) % 4;
        this.lastAction = { def: ACTIONS[a.id], id: a.id, t0: a.t0, dur: Math.max(0.1, a.dur), aim: a.aim };
      }
    }
    const la = this.lastAction;
    if (!la) return null;
    const elapsed = now - la.t0;
    if (elapsed < -0.2) return null;
    if (!la.def.loop && elapsed > la.dur) { this.lastAction = null; return null; }
    if (la.def.loop && (!a || a.id !== la.id) && elapsed > la.dur) { this.lastAction = null; return null; }
    const t = la.def.loop ? (elapsed % la.dur) / la.dur : clamp(elapsed / la.dur, 0, 1);
    return { def: la.def, t, elapsed: Math.max(0, elapsed) };
  }

  private aimPitch(aim?: Vec3): number {
    if (!aim) return 0;
    const h = Math.hypot(aim[0], aim[2]);
    return clamp(Math.atan2(aim[1], h || 1e-3), -0.9, 0.9);
  }

  // ------------------------------------------------------------------ additive layers

  private additives(p: Pose, inp: AnimInput, dt: number, fam: Family) {
    const t = this.time;
    const alive = fam !== 'dead' && fam !== 'sleep';
    // Breathing (faster after running).
    const br = 1.4 + Math.min(1.5, this.speed * 0.2);
    const b = Math.sin(t * br * 1.6);
    p.add('spine02', 0.012 * b);
    p.add('spine01', 0.018 * b);
    p.addS('clavicle', 'L', 0, 0, -0.012 * b);
    p.addS('clavicle', 'R', 0, 0, -0.012 * b);
    // Acceleration lean.
    p.add('root', this.lean.x, 0, -this.lean.y);
    // Tail: travelling sway wave, livelier when moving; droops when dead or asleep.
    if (this.tailBones > 0) {
      const sp = Math.min(1, this.speed / 4);
      for (let k = 0; k < this.tailBones; k++) {
        const ph = t * (1.6 + sp * 3) - k * 0.7;
        const amp = (0.06 + 0.05 * k) * (0.6 + sp) * (alive ? 1 : 0.15);
        p.add(`tail${k}`, (alive ? -0.04 + 0.06 * Math.sin(ph * 0.5) : 0.12) - this.lean.x * 0.5, Math.sin(ph) * amp - this.hipYaw * 0.15, 0);
      }
    }
    // Hit reaction spring (critically damped-ish).
    const k = 90, d = 12;
    this.hitV.x += (-k * this.hit.x - d * this.hitV.x) * dt;
    this.hitV.y += (-k * this.hit.y - d * this.hitV.y) * dt;
    this.hit.x += this.hitV.x * dt;
    this.hit.y += this.hitV.y * dt;
    p.spine(this.hit.x * 0.5, 0, this.hit.y * 0.5);
    p.neck(this.hit.x * 0.7, 0, this.hit.y * 0.4);
    this.pain = Math.max(0, this.pain - dt * 1.2);

    // Look-at: yaw/pitch toward the target distributed over spine, neck and head.
    let ty = 0, tp = 0;
    const look = inp.anim.lookAt;
    if (look && alive) {
      const head = this.ch.bone('head');
      head.getWorldPosition(_v);
      _v2.set(look[0], look[1], look[2]).sub(_v);
      // Into character space (object yaw only).
      const yaw = this.facingYaw;
      const c = Math.cos(-yaw), s = Math.sin(-yaw);
      const lx = c * _v2.x + s * _v2.z, lz = -s * _v2.x + c * _v2.z;
      ty = Math.atan2(-lx, -lz);
      tp = Math.atan2(_v2.y, Math.hypot(lx, lz));
      if (Math.abs(ty) > 2.2) { ty = 0; tp = 0; }
      ty = clamp(ty, -1.25, 1.25);
      tp = clamp(tp, -0.7, 0.6);
    } else if (alive) {
      // Idle glances.
      this.glanceT -= dt;
      if (this.glanceT <= 0) {
        const h = hash32(this.seed + Math.floor(t * 10));
        this.glanceT = 1.5 + (h % 1000) / 250;
        const r = ((h >>> 10) % 1000) / 1000;
        this.glance.set(r < 0.45 ? 0 : (r - 0.7) * 1.6, (((h >>> 20) % 100) / 100 - 0.55) * 0.25);
      }
      ty = this.glance.x * (1 - smooth(0.5, 2, this.speed));
      tp = this.glance.y;
    }
    this.look.x = approach(this.look.x, ty, 5, dt);
    this.look.y = approach(this.look.y, tp, 5, dt);
    const ly = this.look.x, lp = this.look.y;
    p.add('spine01', lp * 0.1, ly * 0.18, 0);
    p.add('spine02', 0, ly * 0.1, 0);
    p.neck(lp * 0.75, ly * 0.7, 0);
    p.add('head', lp * 0.2, 0, 0);
    this.eyeLook.set(ty - ly, tp - lp);
  }

  /**
   * The MakeHuman rest pose is an A-pose with the forearms bent forward and palms down.
   * Neutral = arms hanging along the body, elbows nearly straight, palms facing the thighs;
   * all authored poses are relative to it.
   */
  private computeNeutral() {
    const ch = this.ch;
    this.neutral = ch.bones.map(() => null);
    const R = (n: string) => ch.rest[this.map.idx(n)];
    for (const s of ['L', 'R'] as const) {
      const sg = s === 'L' ? -1 : 1;
      const sh = R(`shoulder01.${s}`), el = R(`lowerarm01.${s}`), wr = R(`wrist.${s}`);
      // Collarbones slightly forward (relaxed shoulders sit a little in front of the spine line;
      // the rest pose had them pulled back, so the arms hung from behind the chest).
      const C = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), sg * 0.22);
      const Ci = C.clone().invert();
      this.neutral[this.map.idx(`clavicle.${s}`)] = C;
      const u = el.clone().sub(sh).applyQuaternion(C).normalize();
      // Relaxed arms hang slightly forward (forward is -z).
      const t = new THREE.Vector3(sg * Math.sin(0.16), -Math.cos(0.16), -0.05).normalize();
      const qA = new THREE.Quaternion().setFromUnitVectors(u, t);
      const half = new THREE.Quaternion().slerp(qA, 0.5);
      // Split over shoulder and upper arm, expressed in the collarbone's (rotated) frame.
      const halfLocal = Ci.clone().multiply(half).multiply(C);
      this.neutral[this.map.idx(`shoulder01.${s}`)] = halfLocal;
      this.neutral[this.map.idx(`upperarm01.${s}`)] = halfLocal.clone();
      // World rotation of the upper arm in the neutral pose.
      const W = qA.clone().multiply(C);
      // Forearm: nearly straight, a slight natural bend forward.
      const f1 = wr.clone().sub(el).normalize().applyQuaternion(W);
      const t2 = t.clone().add(new THREE.Vector3(0, 0, -0.16)).normalize();
      const qB = new THREE.Quaternion().setFromUnitVectors(f1, t2);
      const Wi = W.clone().invert();
      this.neutral[this.map.idx(`lowerarm01.${s}`)] = Wi.clone().multiply(qB).multiply(W);
      // Twist so the palm faces the thigh (thumb forward).
      const hb = ch.geo.build.body.sockets[`hand.${s}`].basis;
      const qT = qB.clone().multiply(W);
      const n1 = new THREE.Vector3(-hb[6], -hb[7], -hb[8]).applyQuaternion(qT);
      const want = new THREE.Vector3(-sg, 0, 0.15);
      const proj = (v: THREE.Vector3) => v.clone().sub(t2.clone().multiplyScalar(v.dot(t2))).normalize();
      const a = proj(n1), b = proj(want);
      const ang = Math.atan2(new THREE.Vector3().crossVectors(a, b).dot(t2), a.dot(b));
      const qC = new THREE.Quaternion().setFromAxisAngle(t2, ang);
      const qTi = qT.clone().invert();
      this.neutral[this.map.idx(`lowerarm02.${s}`)] = qTi.multiply(qC).multiply(qT);
    }
    // World rotation of each bone's parent in the neutral pose: pose angles are conjugated by it
    // so they always rotate about body-aligned axes (e.g. "fwd" swings the arm straight forward).
    this.parentNeutral = ch.bones.map(() => null);
    const world: (THREE.Quaternion | null)[] = [];
    ch.bones.forEach((b, i) => {
      const pi = ch.bones.indexOf(b.parent as THREE.Bone);
      const pw = pi >= 0 ? world[pi] : null;
      this.parentNeutral[i] = pw;
      const n = this.neutral[i];
      world[i] = pw && n ? pw.clone().multiply(n) : pw ? pw : n ? n.clone() : null;
    });
  }

  // ------------------------------------------------------------------ application

  private apply(p: Pose) {
    const bones = this.ch.bones, order = this.map.order;
    const r = p.rot;
    const neutral = this.neutral;
    for (let i = 0; i < bones.length; i++) {
      _e.set(r[i * 3], r[i * 3 + 1], r[i * 3 + 2], order[i]);
      const q = bones[i].quaternion.setFromEuler(_e);
      const pn = this.parentNeutral[i];
      if (pn) q.premultiply(_q3.copy(pn).invert()).multiply(pn);
      const n = neutral[i];
      if (n) q.multiply(n);
    }
    const root = bones[0];
    const rest = this.ch.rest[0];
    root.position.set(rest.x + p.root.x, rest.y + p.root.y + this.pelvisOff, rest.z + p.root.z);
  }

  private fingerPose(inp: AnimInput, def: ActionDef | undefined, dt: number) {
    const relaxed = 0.28;
    const grip = (g: GripClass) => (g === 'none' ? relaxed : g === 'shield' ? 1.0 : 1.25);
    let cR = grip(inp.main), cL = grip(inp.off);
    if (inp.main === 'bow' || inp.main === 'crossbow') { cL = 1.25; cR = 0.5; }
    if (inp.main === 'twohand' || inp.main === 'polearm' || inp.main === 'staff') cL = 1.25;
    if (def && inp.main === 'none' && (def === ACTIONS.punch || def === ACTIONS.block)) { cR = 1.5; cL = 1.5; }
    if (def === ACTIONS.gesture_wave || def === ACTIONS.cast_forward || def === ACTIONS.channel) cR = 0.1;
    if (def === ACTIONS.gesture_point) cR = 1.3;
    for (const s of ['L', 'R'] as const) {
      const c = s === 'L' ? cL : cR;
      this.fingers[s].forEach((f, fi) => {
        const spread = (fi - 2.5) * 0.02;
        f.bones.forEach((b, k) => {
          let amt = c * (k === 0 ? 0.75 : 1) * (f.thumb ? 0.45 : 1);
          if (def === ACTIONS.gesture_point && fi === 1) amt = 0.05;
          b.quaternion.setFromAxisAngle(f.axis[k], amt + spread * (k === 0 ? 1 : 0));
        });
      });
    }
    void dt;
  }

  // ------------------------------------------------------------------ IK

  private footIK(ground: GroundFn, dt: number) {
    const ch = this.ch;
    ch.object.updateMatrixWorld(true);
    // World-space feet level: the character object is parented under the rig's root,
    // so its local position is not the ground reference.
    const baseY = ch.object.getWorldPosition(_v).y;
    // Work in the character's own units: a giant (or tiny) player is a scaled human, and the
    // reach limits below are human proportions, not world metres.
    const sc = Math.max(1e-4, ch.object.getWorldScale(_v5).y);
    const offs = [0, 0];
    const sides = ['L', 'R'] as const;
    for (let k = 0; k < 2; k++) {
      const foot = ch.bone(`foot.${sides[k]}`);
      foot.getWorldPosition(_v);
      const g = ground(_v.x, baseY + 0.6 * sc, _v.z);
      offs[k] = g === null ? 0 : clamp((g - baseY) / sc, -0.45, 0.45);
    }
    for (let k = 0; k < 2; k++) this.footOff[k] = approach(this.footOff[k], offs[k], 14, dt);
    // Lower the pelvis to reach the lower foot.
    const drop = Math.min(0, Math.min(this.footOff[0], this.footOff[1]));
    this.pelvisOff = approach(this.pelvisOff, drop, 10, dt);
    ch.bones[0].position.y += this.pelvisOff;
    ch.bones[0].updateMatrixWorld(true);
    for (let k = 0; k < 2; k++) {
      const s = sides[k];
      const hip = ch.bone(`upperleg01.${s}`), knee = ch.bone(`lowerleg01.${s}`), foot = ch.bone(`foot.${s}`);
      foot.getWorldPosition(_v);
      const target = _v3.copy(_v);
      target.y += (this.footOff[k] - this.pelvisOff) * sc;
      if (Math.abs(this.footOff[k] - this.pelvisOff) < 0.004) continue;
      this.twoBone(hip, knee, foot, target);
    }
  }

  /** Two-bone IK: bend the knee to the needed angle, then aim the hip at the target. */
  private twoBone(hip: THREE.Bone, knee: THREE.Bone, end: THREE.Bone, target: THREE.Vector3) {
    const pa = hip.getWorldPosition(new THREE.Vector3());
    const pb = knee.getWorldPosition(new THREE.Vector3());
    const pc = end.getWorldPosition(new THREE.Vector3());
    const lab = pa.distanceTo(pb), lcb = pb.distanceTo(pc);
    const lat = clamp(pa.distanceTo(target), 0.01, lab + lcb - 0.002);
    const acCur = pa.distanceTo(pc);
    // Current & desired interior knee angles.
    const ang = (a: number, b: number, c: number) => Math.acos(clamp((a * a + b * b - c * c) / (2 * a * b), -1, 1));
    const cur = ang(lab, lcb, acCur), want = ang(lab, lcb, lat);
    _v.subVectors(pa, pb); _v2.subVectors(pc, pb);
    const axis = _v4.crossVectors(_v2, _v);
    if (axis.lengthSq() < 1e-10) hip.getWorldQuaternion(_q).normalize(), axis.set(1, 0, 0).applyQuaternion(_q);
    axis.normalize();
    this.rotateWorld(knee, axis, cur - want);
    knee.updateMatrixWorld(true);
    end.getWorldPosition(pc);
    _v.subVectors(pc, pa).normalize();
    _v2.subVectors(target, pa).normalize();
    _q.setFromUnitVectors(_v, _v2);
    this.rotateWorldQ(hip, _q);
    hip.updateMatrixWorld(true);
  }

  private rotateWorld(bone: THREE.Bone, axis: THREE.Vector3, angle: number) {
    _q2.setFromAxisAngle(axis, angle);
    this.rotateWorldQ(bone, _q2);
  }

  private rotateWorldQ(bone: THREE.Bone, qw: THREE.Quaternion) {
    bone.getWorldQuaternion(_q3);
    const parentQ = bone.parent!.getWorldQuaternion(new THREE.Quaternion());
    // newLocal = parent⁻¹ · qw · world
    _q3.premultiply(qw);
    bone.quaternion.copy(parentQ.invert().multiply(_q3));
  }

  // ------------------------------------------------------------------ face

  private face(inp: AnimInput, actionMood: string | undefined, fam: Family, dt: number) {
    const tgt = this.exprTarget.fill(0);
    const set = (n: string, w: number) => { const i = this.exprIdx.get(n); if (i !== undefined) tgt[i] = Math.max(tgt[i], w); };
    const mood = this.pain > 0.3 ? 'pain' : actionMood ?? inp.anim.mood ?? 'neutral';
    for (const [n, w] of MOODS[mood] ?? []) set(n, w);
    if (this.pain > 0) for (const [n, w] of MOODS.pain) set(n, w * this.pain);
    const dead = fam === 'dead', asleep = fam === 'sleep';
    // Blinking.
    this.blinkT -= dt;
    if (this.blinkT <= 0) {
      this.blink = 1;
      this.blinkT = 1.8 + (hash32(this.seed + Math.floor(this.time * 7)) % 4000) / 1000;
    }
    this.blink = Math.max(0, this.blink - dt * 7);
    const lid = dead ? 0.8 : asleep ? 1 : Math.sin(Math.min(1, this.blink) * Math.PI);
    set('eye-left-closure', lid);
    set('eye-right-closure', lid);
    // Talking: syllable envelope drives jaw & lip shapes.
    let jawT = dead ? 0.25 : 0;
    if (inp.anim.talking && !dead && !asleep) {
      this.talkPhase += dt * (9 + 3 * Math.sin(this.time * 1.7));
      const syl = Math.max(0, Math.sin(this.talkPhase)) * (0.55 + 0.45 * Math.sin(this.talkPhase * 0.37 + 1));
      jawT = syl * 0.18;
      const v = Math.sin(this.talkPhase * 0.53);
      set('mouth-open', syl * 0.45);
      set('mouth-pursing', Math.max(0, v) * 0.35 * syl);
      set('mouth-retraction', Math.max(0, -v) * 0.35 * syl);
      set('eyebrows-left-up', Math.max(0, Math.sin(this.talkPhase * 0.21)) * 0.25);
      set('eyebrows-right-up', Math.max(0, Math.sin(this.talkPhase * 0.21)) * 0.25);
    }
    if (inp.anim.action?.id === 'eat' && this.actionW > 0.5) jawT = Math.max(0, Math.sin(this.time * 12)) * 0.12;
    this.jaw = approach(this.jaw, jawT, 18, dt);
    const jb = this.ch.bone('jaw');
    jb.quaternion.multiply(_q.setFromAxisAngle(_v.set(1, 0, 0), -this.jaw));
    // Smooth toward targets (blinks fast).
    const ew = this.ch.exprW;
    for (let i = 0; i < tgt.length; i++) {
      const rate = tgt[i] > this.expr[i] ? 14 : 8;
      this.expr[i] = approach(this.expr[i], tgt[i], rate, dt);
      ew[i] = this.expr[i];
    }
    const li = this.exprIdx.get('eye-left-closure'), ri = this.exprIdx.get('eye-right-closure');
    if (li !== undefined) ew[li] = Math.max(this.expr[li], lid);
    if (ri !== undefined) ew[ri] = Math.max(this.expr[ri], lid);
  }

  private eyes(inp: AnimInput, dt: number) {
    this.saccadeT -= dt;
    if (this.saccadeT <= 0) {
      const h = hash32(this.seed * 31 + Math.floor(this.time * 13));
      this.saccadeT = 0.4 + (h % 1500) / 1000;
      this.saccade.set(((h >>> 8) % 100) / 100 - 0.5, ((h >>> 16) % 100) / 100 - 0.5).multiplyScalar(0.12);
    }
    const yaw = clamp(this.eyeLook.x + this.saccade.x, -0.5, 0.5);
    const pitch = clamp(this.eyeLook.y + this.saccade.y, -0.35, 0.3);
    for (const e of this.ch.eyes) {
      e.rotation.set(pitch, yaw, 0, 'YXZ');
    }
    void inp;
  }

  /** Current world-space aim helpers for views (e.g. projectile origin). */
  handWorld(side: Side, out: THREE.Vector3) {
    return this.ch.bone(`wrist.${side}`).getWorldPosition(out);
  }
}

