/**
 * Motion-captured clips (the Quaternius Universal Animation Library, CC0, from the Actors pack,
 * see actors/clips.ts) played exactly as Actors plays them: Actors' `Retargeter` samples each clip
 * on the character's own fitted skeleton (every bone, fingers included), clips are blended as
 * quaternions (`PoseMixer`, `Locomotion`), and only the finished pose is handed to the animator.
 *
 * The animator still poses the MakeHuman-named proxy skeleton (actors/rig.ts) in its Euler pose
 * space, so the Actors pose is turned into that exactly: each proxy bone takes the rotation of the
 * Actors bone it stands for (PROXY_FROM_ACTOR), which puts the proxy joints on the Actors joints,
 * and `RigBridge.sync` gives back the very pose Actors sampled. No corrections are added: if a
 * clip looks wrong, it gets fixed in Actors.
 */
import * as THREE from 'three';
import { actors, HEADLESS } from '../../actors/service';
import { actorClipLibrary, type ClipLibraryData, type ClipMeta } from '../../actors/clips';
import { PROXY_FROM_ACTOR } from '../../actors/rig';
import { type Clip, type FittedSkeleton, type Pose as ActorPose, Locomotion, PoseMixer, Retargeter, createPose, poseWorld } from '@actors/core';
import type { Character } from '../Character';
import type { BoneMap } from './pose';
import { Pose } from './pose';

export type { ClipMeta } from '../../actors/clips';
/** The clip library (see actors/clips.ts): Actors clips by the animator's names. */
export type ClipLibrary = ClipLibraryData;

/**
 * Clips on/off (for comparing with the purely procedural animation): `?clips=0` in the URL or
 * `norgoAnimClips(false)` in the console.
 */
export const clipSettings = { enabled: !/[?&]clips=0(&|$)/.test((globalThis as { location?: { search?: string } }).location?.search ?? '') };
(globalThis as { norgoAnimClips?: (on: boolean) => void }).norgoAnimClips = (on: boolean) => { clipSettings.enabled = on; };

let lib: ClipLibrary | null = null;
let loading: Promise<ClipLibrary | null> | null = null;

/** The clip library once loaded (null before, or when it failed to load: animators stay procedural). */
export function clipLibrary(): ClipLibrary | null {
  if (!lib && !loading) loading = loadLibrary();
  return lib;
}

/** Resolves once the library has loaded (or failed: null). */
export function clipLibraryReady(): Promise<ClipLibrary | null> {
  clipLibrary();
  return loading ?? Promise.resolve(lib);
}

async function loadLibrary(): Promise<ClipLibrary | null> {
  if (HEADLESS) return null;
  try {
    const [lead] = await actors.ready();
    lib = await actorClipLibrary(lead.human.runtime);
    return lib;
  } catch (e) {
    console.warn('[anim] clip library unavailable, procedural only', e);
    return null;
  }
}

/** A clip ready to play on one character. */
export interface RigClip {
  meta: ClipMeta;
  clip: Clip;
  retargeter: Retargeter;
}

/** Ground speed bands (m/s) of the standing gaits: full weight inside, cross-faded between. */
const GAITS: [string, number, number][] = [['Walk_Loop', 0, 1.9], ['Jog_Fwd_Loop', 3.6, 5.6], ['Sprint_Loop', 7.6, 1e9]];

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();

/** Per-character clip playback through Actors, handed to one animator's pose space. */
export class ClipRig {
  /** Pose bones clips drive (pose indices, parents first). */
  readonly bones: number[] = [];
  /** Per pose bone: 1 when clips drive it. */
  readonly driven: Float32Array;
  /** The fitted skeleton the clips are retargeted onto (a new one after a shape change: rebuild the rig). */
  readonly fitted: FittedSkeleton;
  /** Standing gaits by speed, and the crouch walk. */
  readonly stand: Locomotion | null;
  readonly crouch: Locomotion | null;
  readonly mixer: PoseMixer;
  private clips = new Map<string, RigClip | null>();
  /** Pose bone → Actors bone (-1: rigid with its parent). */
  private from: Int32Array;
  private parentOf: Int32Array;
  private bindInv: THREE.Quaternion[];
  private pelvis: number;
  private worldR: Float64Array;
  private worldH: Float64Array;
  private model: THREE.Quaternion[];
  private scratch: ActorPose;

  constructor(
    private ch: Character,
    private map: BoneMap,
    private lib: ClipLibrary,
    private neutral: (THREE.Quaternion | null)[],
    private parentNeutral: (THREE.Quaternion | null)[],
  ) {
    const fitted = ch.actor.actor.fittedSkeleton;
    if (!fitted) throw new Error('clips: the actor has no fitted skeleton yet');
    this.fitted = fitted;
    const names = fitted.names, n = names.length;
    this.driven = new Float32Array(map.count);
    this.from = new Int32Array(map.count).fill(-1);
    this.parentOf = new Int32Array(map.count).fill(-1);
    for (let b = 0; b < map.count; b++) {
      const name = ch.bones[b].name;
      const src = PROXY_FROM_ACTOR[name];
      if (!src) continue;
      const p = ch.bones.indexOf(ch.bones[b].parent as THREE.Bone);
      if (src !== 'follow') {
        const a = names.indexOf(src);
        if (a < 0) continue;
        this.from[b] = a;
      } else if (p < 0 || !this.driven[p]) continue;
      this.parentOf[b] = p;
      this.bones.push(b);
      this.driven[b] = 1;
    }
    this.bindInv = fitted.worldRotations.map((m) => {
      // Mat3 is column-major (three's Matrix3 layout).
      const m4 = new THREE.Matrix4().setFromMatrix3(new THREE.Matrix3().fromArray(Array.from(m)));
      return new THREE.Quaternion().setFromRotationMatrix(m4).invert();
    });
    this.pelvis = names.indexOf('pelvis');
    this.worldR = new Float64Array(n * 4);
    this.worldH = new Float64Array(n * 3);
    this.model = Array.from({ length: map.count }, () => new THREE.Quaternion());
    this.scratch = createPose(n, Math.max(0, this.pelvis));
    this.mixer = new PoseMixer(n);
    const gait = (list: [string, number, number][]) => {
      const have = list.filter(([name]) => lib.clips.has(name));
      return have.length === list.length ? new Locomotion(fitted, have.map(([name, from, to]) => ({ clip: lib.clips.get(name)!.clip, from, to }))) : null;
    };
    this.stand = gait(GAITS);
    this.crouch = gait([['Crouch_Fwd_Loop', 0, 1e9]]);
  }

  /** A fresh Actors pose buffer for this character's skeleton. */
  pose(): ActorPose {
    return createPose(this.fitted.names.length, Math.max(0, this.pelvis));
  }

  /** The clip set up for this character (lazily; null if the library lacks it). */
  clip(name: string): RigClip | null {
    let c = this.clips.get(name);
    if (c === undefined) {
      const e = this.lib.clips.get(name);
      c = e ? { meta: e.meta, clip: e.clip, retargeter: new Retargeter(this.fitted, e.clip, { inPlace: 'drift' }) } : null;
      this.clips.set(name, c);
    }
    return c;
  }

  /** Samples a clip at normalized time u (0..1; loops wrap) into an Actors pose. */
  sample(c: RigClip, u: number, out: ActorPose): ActorPose {
    const x = c.meta.loop ? ((u % 1) + 1) % 1 : Math.min(1, Math.max(0, u));
    return c.retargeter.sampleInto(x * c.meta.dur, out);
  }

  /** out += w · clip at u, in the animator's pose space (driven bones only; the caller normalizes). */
  accumulate(c: RigClip, u: number, w: number, out: Pose) {
    if (w <= 0) return;
    this.toPose(this.sample(c, u, this.scratch), w, out);
  }

  /**
   * An Actors pose into the animator's pose space, accumulated with weight w (out += w · pose) on
   * the driven bones. Exact: the proxy takes each Actors bone's model-space turn from its bind,
   * and the animator's apply() and RigBridge.sync() undo this conversion step by step.
   */
  toPose(src: ActorPose, w: number, out: Pose) {
    const R = this.worldR, H = this.worldH, f = this.fitted;
    poseWorld(f, src, R, H);
    const Q = this.model, r = out.rot, order = this.map.order;
    for (const b of this.bones) {
      const a = this.from[b], p = this.parentOf[b];
      if (a >= 0) {
        // Turn since bind, in Actors object space, then flipped into Scale's (half turn about Y).
        _q.set(R[a * 4], R[a * 4 + 1], R[a * 4 + 2], R[a * 4 + 3]).multiply(this.bindInv[a]);
        Q[b].set(-_q.x, _q.y, -_q.z, _q.w);
      } else Q[b].copy(Q[p]);
      // Local rotation, then into pose space: E = pn · q · n⁻¹ · pn⁻¹ (inverse of Animator.apply).
      if (p >= 0) _q.copy(Q[p]).invert().multiply(Q[b]);
      else _q.copy(Q[b]);
      const n = this.neutral[b];
      if (n) _q.multiply(_q2.copy(n).invert());
      const pn = this.parentNeutral[b];
      if (pn) _q.premultiply(pn).multiply(_q2.copy(pn).invert());
      _e.setFromQuaternion(_q, order[b]);
      const i = b * 3;
      r[i] += _e.x * w; r[i + 1] += _e.y * w; r[i + 2] += _e.z * w;
    }
    if (this.pelvis >= 0) {
      const h = f.heads[this.pelvis], o = this.pelvis * 3;
      out.root.x += -(H[o] - h[0]) * w;
      out.root.y += (H[o + 1] - h[1]) * w;
      out.root.z += -(H[o + 2] - h[2]) * w;
    }
  }
}
