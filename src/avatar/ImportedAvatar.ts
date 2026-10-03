/**
 * An imported character model shown as the player.
 *
 * Mode 'retarget' (humanoid rigs): the regular MakeHuman rig keeps running invisibly as a
 * puppet (locomotion, foot IK, flight pose, punches, idle styles, scaling) and every frame
 * its bone motion is copied onto the model's skeleton:
 *
 *   targetWorld = puppetWorld · puppetRestWorld⁻¹ · align · targetRestWorld
 *
 * all in the rig's local frame. `align` turns each target limb's rest direction onto the
 * puppet's (T-pose vs A-pose rigs), so at rest the model takes the puppet's pose and from
 * there follows its motion. The hips also take the puppet's displacement, scaled by leg
 * length. MakeHuman bones have translation-only rest frames, so puppetRestWorld is the
 * identity in the character's frame.
 *
 * Mode 'clips' (rigs we cannot map, e.g. stylised robots or animals): the model plays its
 * own animation clips, chosen by movement state.
 *
 * The model is a child of the rig's object, so position, facing, flight tilt and player
 * size scaling apply to it unchanged.
 */
import * as THREE from 'three';
import type { HumanoidRig } from '../humanoid/client/HumanoidRig';
import { mapHumanoid, type HumanBone, type HumanoidMapping } from './HumanoidMap';

/** Puppet (MakeHuman) bone whose world rotation drives each standard bone. */
const PUPPET: Record<HumanBone, string> = {
  hips: 'root', spine: 'spine05', chest: 'spine03', upperChest: 'spine01', neck: 'neck03', head: 'head',
  leftShoulder: 'clavicle.L', leftUpperArm: 'upperarm02.L', leftLowerArm: 'lowerarm02.L', leftHand: 'wrist.L',
  rightShoulder: 'clavicle.R', rightUpperArm: 'upperarm02.R', rightLowerArm: 'lowerarm02.R', rightHand: 'wrist.R',
  leftUpperLeg: 'upperleg02.L', leftLowerLeg: 'lowerleg02.L', leftFoot: 'foot.L', leftToes: 'toes.L',
  rightUpperLeg: 'upperleg02.R', rightLowerLeg: 'lowerleg02.R', rightFoot: 'foot.R', rightToes: 'toes.R',
};
/** Rest position (bone head) of the puppet joint that starts each standard bone's segment. */
const PUPPET_HEAD: Partial<Record<HumanBone, string>> = {
  leftUpperArm: 'upperarm01.L', rightUpperArm: 'upperarm01.R', leftLowerArm: 'lowerarm01.L', rightLowerArm: 'lowerarm01.R',
  leftUpperLeg: 'upperleg01.L', rightUpperLeg: 'upperleg01.R', leftLowerLeg: 'lowerleg01.L', rightLowerLeg: 'lowerleg01.R',
};
/** Limb segments whose rest direction is aligned (bone → next joint). */
const SEGMENTS: [HumanBone, HumanBone][] = [
  ['leftShoulder', 'leftUpperArm'], ['rightShoulder', 'rightUpperArm'],
  ['leftUpperArm', 'leftLowerArm'], ['rightUpperArm', 'rightLowerArm'],
  ['leftLowerArm', 'leftHand'], ['rightLowerArm', 'rightHand'],
  ['leftUpperLeg', 'leftLowerLeg'], ['rightUpperLeg', 'rightLowerLeg'],
  ['leftLowerLeg', 'leftFoot'], ['rightLowerLeg', 'rightFoot'],
  ['leftFoot', 'leftToes'], ['rightFoot', 'rightToes'],
];

interface Driven {
  key: HumanBone;
  bone: THREE.Bone;
  src: THREE.Bone;
  /** align · targetRestWorld (rig frame). */
  restA: THREE.Quaternion;
}

export type AvatarMode = 'retarget' | 'clips' | 'static';

export interface LoadedModel {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
  json?: unknown;
  associations?: Map<unknown, { nodes?: number }>;
}

export class ImportedAvatar {
  /** Wrapper inside the rig's object (facing correction, scale, ground offset). */
  readonly root = new THREE.Group();
  readonly mode: AvatarMode;
  readonly mapping: HumanoidMapping;
  private driven: Driven[] = [];
  private hips: { bone: THREE.Bone; src: THREE.Bone; restPos: THREE.Vector3; srcRest: THREE.Vector3; k: number } | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private hidden: THREE.Object3D[] = [];
  /** Inverse of the puppet bones' common rest rotation in the rig frame (the character model's). */
  private pRestInv = new THREE.Quaternion();

  constructor(private model: LoadedModel, private rig: HumanoidRig, forceClips = false) {
    this.mapping = mapHumanoid(model.scene, model.json, model.associations);
    this.mode = this.mapping.ok && !forceClips ? 'retarget' : model.animations.length ? 'clips' : 'static';
    this.root.name = 'imported-avatar';
    this.root.add(model.scene);
    model.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; }
    });
  }

  /** Attach to the rig (after `rig.ready`): hide the puppet's body, fit and bind the model. */
  attach(): void {
    const rig = this.rig, ch = rig.char;
    rig.object.add(this.root);
    // Hide the puppet's visible parts (bones keep animating underneath).
    if (ch) ch.object.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.visible) { o.visible = false; this.hidden.push(o); } });
    rig.object.updateMatrixWorld(true);
    if (this.mode === 'retarget' && ch) this.bindRetarget();
    else this.fitBySize();
    if (this.mode === 'clips') this.setupClips();
  }

  detach(): void {
    for (const o of this.hidden) o.visible = true;
    this.hidden = [];
    this.root.removeFromParent();
    this.mixer?.stopAllAction();
  }

  dispose(): void {
    this.detach();
    this.model.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
    });
  }

  /** The puppet's body, clothes and held items stay invisible (equipment can be re-added any time). */
  private hidePuppet(): void {
    for (const c of this.rig.object.children) {
      if (c === this.root) continue;
      c.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.visible) { o.visible = false; this.hidden.push(o); } });
    }
  }

  // ------------------------------------------------------------ retarget

  private rigLocalQuat(o: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion {
    o.getWorldQuaternion(out);
    return out.premultiply(this.rig.object.getWorldQuaternion(_qr).invert());
  }

  private rigLocalPos(o: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
    o.getWorldPosition(out);
    return this.rig.object.worldToLocal(out);
  }

  private bindRetarget(): void {
    const ch = this.rig.char!, M = this.mapping.bones;
    const pb = (n: string) => { const i = ch.boneIndex.get(n); return i === undefined ? null : ch.bones[i]; };
    // Puppet rest positions (rig frame): bones have translation-only rest frames.
    const restOf = new Map<string, THREE.Vector3>();
    const modelToRig = new THREE.Matrix4().copy(this.rig.object.matrixWorld).invert().multiply(ch.model.matrixWorld);
    ch.bones.forEach((b, i) => restOf.set(b.name, ch.rest[i].clone().applyMatrix4(modelToRig)));
    const pRest = (k: HumanBone) => restOf.get(PUPPET_HEAD[k] ?? PUPPET[k]);
    this.pRestInv.copy(this.rigLocalQuat(ch.model, new THREE.Quaternion())).invert();

    // 1. Facing from anatomy, not names: toes point forward (fallback: hip line).
    this.root.updateMatrixWorld(true);
    const tp = (b: THREE.Bone | undefined) => (b ? this.rigLocalPos(b, new THREE.Vector3()) : null);
    const footFwd = (fl: THREE.Vector3 | null | undefined, tl: THREE.Vector3 | null | undefined, fr: THREE.Vector3 | null | undefined, tr: THREE.Vector3 | null | undefined) => {
      const v = new THREE.Vector3();
      if (fl && tl) v.add(tl.clone().sub(fl));
      if (fr && tr) v.add(tr.clone().sub(fr));
      v.y = 0;
      return v.lengthSq() > 1e-8 ? v.normalize() : null;
    };
    const hipFwd = (l: THREE.Vector3, r: THREE.Vector3) => { const lat = r.clone().sub(l); return new THREE.Vector3(lat.z, 0, -lat.x).normalize(); };
    const fP = footFwd(pRest('leftFoot'), pRest('leftToes'), pRest('rightFoot'), pRest('rightToes')) ?? hipFwd(pRest('leftUpperLeg')!, pRest('rightUpperLeg')!);
    const fT = footFwd(tp(M.leftFoot), tp(M.leftToes), tp(M.rightFoot), tp(M.rightToes)) ?? hipFwd(tp(M.leftUpperLeg)!, tp(M.rightUpperLeg)!);
    this.model.scene.rotation.y += Math.atan2(fP.x, fP.z) - Math.atan2(fT.x, fT.z);
    this.root.updateMatrixWorld(true);
    // Sides from anatomy too: the model's "left" bones must be where the puppet's left is.
    // Otherwise its left/right naming is mirrored: swap the mapping.
    const side = (l: THREE.Vector3, r: THREE.Vector3) => Math.sign(new THREE.Vector3().crossVectors(fP, new THREE.Vector3(0, 1, 0)).dot(r.clone().sub(l)));
    if (side(tp(M.leftUpperLeg)!, tp(M.rightUpperLeg)!) !== side(pRest('leftUpperLeg')!, pRest('rightUpperLeg')!)) {
      const swapped: typeof M = {};
      for (const [k, v] of Object.entries(M) as [HumanBone, THREE.Bone][]) {
        const k2 = (k.startsWith('left') ? 'right' + k.slice(4) : k.startsWith('right') ? 'left' + k.slice(5) : k) as HumanBone;
        swapped[k2] = v;
      }
      for (const k of Object.keys(M) as HumanBone[]) delete M[k];
      Object.assign(M, swapped);
    }
    // 2. Scale: same leg length (hips → feet) as the puppet; 3. feet on the puppet's ground.
    this.root.updateMatrixWorld(true);
    const tPos = (k: HumanBone) => this.rigLocalPos(M[k]!, new THREE.Vector3());
    const legT = tPos('hips').y - (tPos('leftFoot').y + tPos('rightFoot').y) / 2;
    const legP = pRest('hips')!.y - (pRest('leftFoot')!.y + pRest('rightFoot')!.y) / 2;
    const s = legP / Math.max(1e-4, legT);
    this.model.scene.scale.multiplyScalar(s);
    this.root.updateMatrixWorld(true);
    const footT = (tPos('leftFoot').y + tPos('rightFoot').y) / 2, footP = (pRest('leftFoot')!.y + pRest('rightFoot')!.y) / 2;
    this.root.position.y += footP - footT;
    this.root.updateMatrixWorld(true);

    // 4. Rest alignment per bone and driving order (parents first).
    const align = new Map<HumanBone, THREE.Quaternion>();
    for (const [a, b] of SEGMENTS) {
      if (!M[a] || !M[b] || !pRest(a) || !pRest(b)) continue;
      const dT = tPos(b).sub(tPos(a)).normalize();
      const dP = pRest(b)!.clone().sub(pRest(a)!).normalize();
      if (dT.lengthSq() < 0.5 || dP.lengthSq() < 0.5) continue;
      align.set(a, new THREE.Quaternion().setFromUnitVectors(dT, dP));
    }
    const keys = (Object.keys(M) as HumanBone[]).filter((k) => pb(PUPPET[k]));
    keys.sort((x, y) => depthOf(M[x]!) - depthOf(M[y]!));
    for (const k of keys) {
      const restA = this.rigLocalQuat(M[k]!, new THREE.Quaternion());
      const a = align.get(k);
      if (a) restA.premultiply(a);
      this.driven.push({ key: k, bone: M[k]!, src: pb(PUPPET[k])!, restA });
    }
    const hipsSrc = pb(PUPPET.hips);
    if (M.hips && hipsSrc) this.hips = { bone: M.hips, src: hipsSrc, restPos: tPos('hips'), srcRest: pRest('hips')!.clone(), k: 1 };
  }

  /** Clip / static models: same height as the player, feet on the ground, facing forward. */
  private fitBySize(): void {
    const box = new THREE.Box3().setFromObject(this.model.scene);
    const h = Math.max(1e-3, box.max.y - box.min.y);
    const target = this.rig.height || 1.8;
    const s = target / h;
    this.model.scene.scale.multiplyScalar(s);
    this.root.updateMatrixWorld(true);
    const b2 = new THREE.Box3().setFromObject(this.model.scene);
    const rigY = this.rig.object.getWorldPosition(new THREE.Vector3()).y;
    this.root.position.y += rigY - b2.min.y;
  }

  // ------------------------------------------------------------ clips

  private setupClips(): void {
    this.mixer = new THREE.AnimationMixer(this.model.scene);
    for (const clip of this.model.animations) {
      // In-place: drop horizontal root motion (the player controller moves the body).
      for (const t of clip.tracks) {
        if (!t.name.endsWith('.position')) continue;
        const v = t.values;
        const x0 = v[0], z0 = v[2];
        for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 2] = z0; }
        break;
      }
      this.actions.set(clip.name.toLowerCase(), this.mixer.clipAction(clip));
    }
  }

  private pick(state: string): THREE.AnimationAction | null {
    const want: Record<string, RegExp[]> = {
      idle: [/idle/, /stand/, /breath/],
      walk: [/walk/],
      run: [/run/, /jog/, /walk/],
      sprint: [/sprint/, /run/, /jog/],
      jump: [/jump/],
      fall: [/fall/, /jump/],
      fly: [/fly/, /flying/, /fall/, /jump/],
      swim: [/swim/, /idle/],
      punch: [/punch/, /attack/, /hit/, /strike/],
    };
    for (const re of want[state] ?? [/idle/]) for (const [name, a] of this.actions) if (re.test(name)) return a;
    return this.actions.values().next().value ?? null;
  }

  // ------------------------------------------------------------ per frame

  /** After the puppet's update (and flight pose). dt: the rig's (size-scaled) step. */
  update(dt: number, state: string, speed: number, punching: boolean): void {
    this.hidePuppet();
    if (this.mode === 'retarget') this.retarget();
    else if (this.mode === 'clips' && this.mixer) {
      const a = this.pick(punching ? 'punch' : state);
      if (a && a !== this.current) {
        a.reset().play();
        if (this.current) a.crossFadeFrom(this.current, 0.25, false);
        this.current = a;
      }
      if (a) a.timeScale = state === 'walk' ? THREE.MathUtils.clamp(speed / 1.4, 0.5, 1.6) : state === 'run' || state === 'sprint' ? THREE.MathUtils.clamp(speed / 3.5, 0.6, 1.8) : 1;
      this.mixer.update(dt);
    }
  }

  private retarget(): void {
    const ch = this.rig.char;
    if (!ch) return;
    ch.object.updateMatrixWorld(true);
    for (const d of this.driven) {
      // Puppet rotation (rig frame) is its change from rest (identity rest rotations).
      const pw = this.rigLocalQuat(d.src, _qb);
      const tw = _qc.copy(pw).multiply(this.pRestInv).multiply(d.restA);
      // To the bone's local space: parent's current rig-frame rotation.
      const parentQ = d.bone.parent ? this.rigLocalQuat(d.bone.parent, _qa) : _qa.identity();
      d.bone.quaternion.copy(parentQ.invert().multiply(tw));
      d.bone.updateMatrixWorld(true);
    }
    if (this.hips) {
      const h = this.hips;
      const p = this.rigLocalPos(h.src, _va).sub(h.srcRest).add(h.restPos);
      // Back to the hips' parent space.
      const parent = h.bone.parent!;
      parent.updateMatrixWorld(true);
      this.rig.object.localToWorld(p);
      parent.worldToLocal(p);
      h.bone.position.copy(p);
      h.bone.updateMatrixWorld(true);
    }
  }
}

function depthOf(o: THREE.Object3D): number { let d = 0; for (let p = o.parent; p; p = p.parent) d++; return d; }

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion(), _qr = new THREE.Quaternion();
const _va = new THREE.Vector3();
