/**
 * The animator's clip library (anim/clips.ts) from the Actors pack: the Quaternius Universal
 * Animation Library clips Actors ships (CC0) and three calm standing idles cut from the CMU motion
 * capture takes it carries (113_21, also mirrored, and 77_02).
 *
 * Actors stores per bone the world-space rotation change since the source's reference pose and
 * the bone's reference direction, root motion in hip heights; that is what the library holds too
 * (a 22-bone body: rotation change Δ per bone, limb rest segments to line up with the target's,
 * the hips' offset), here turned into Scale's axes (facing −Z).
 */
import * as THREE from 'three';
import type { ActorRuntime, Clip } from '@actors/core';

export interface ClipMeta { name: string; frames: number; loop: boolean; dur: number; offset: number; speed: number; sync: number }

export interface ClipLibraryData {
  fps: number;
  bones: string[];
  restQ: THREE.Quaternion[];
  restSeg: (THREE.Vector3 | null)[];
  legLen: number;
  stride: number;
  clips: Map<string, ClipMeta>;
  data: Int16Array;
}

/** The library's body bones ← Actors bones. */
const BONES: [string, string][] = [
  ['hips', 'pelvis'], ['spine.001', 'spine_01'], ['spine.002', 'spine_02'], ['spine.003', 'spine_03'], ['neck', 'neck_01'], ['head', 'head'],
  ['shoulder.L', 'clavicle_l'], ['upper_arm.L', 'upperarm_l'], ['forearm.L', 'lowerarm_l'], ['hand.L', 'hand_l'],
  ['shoulder.R', 'clavicle_r'], ['upper_arm.R', 'upperarm_r'], ['forearm.R', 'lowerarm_r'], ['hand.R', 'hand_r'],
  ['thigh.L', 'thigh_l'], ['shin.L', 'calf_l'], ['foot.L', 'foot_l'], ['toe.L', 'ball_l'],
  ['thigh.R', 'thigh_r'], ['shin.R', 'calf_r'], ['foot.R', 'foot_r'], ['toe.R', 'ball_r'],
];
/** Torso bones: no rest segment (the animator lines up limbs only). */
const TORSO = new Set(['hips', 'spine.001', 'spine.002', 'spine.003', 'neck', 'head']);

/**
 * The animator's clip names ← Actors clip names, with each motion's natural ground speed (in leg
 * lengths per second) and where in the loop the left foot strikes (0..1), measured on the source.
 */
const CLIPS: Record<string, [string, number, number]> = {
  Crouch_Fwd_Loop: ['crouch walk', 0.6705, 0], Crouch_Idle_Loop: ['crouch', 0, 0.5], Dance_Loop: ['dance', 0.0387, 0.433], Death01: ['death', 0, 0],
  Fixing_Kneeling: ['repair (kneeling)', 0, 0], Hit_Chest: ['hit to chest', 0, 0], Hit_Head: ['hit to head', 0, 0], Idle_Loop: ['idle', 0.0011, 0.787],
  Idle_Talking_Loop: ['talk', 0.0011, 0.727], Idle_Torch_Loop: ['hold torch', 0.0011, 0.553], Interact: ['interact', 0, 0], Jog_Fwd_Loop: ['jog', 5.7092, 0.964],
  Jump_Land: ['jump land', 0, 0], Jump_Loop: ['jump', 0.0034, 0.893], Jump_Start: ['jump start', 0, 0], PickUp_Table: ['pick up', 0, 0],
  Punch_Cross: ['punch cross', 0, 0], Punch_Enter: ['fight stance', 0, 0], Punch_Jab: ['punch jab', 0, 0], Push_Loop: ['push', 0.2835, 0.887],
  Roll: ['roll', 0, 0], Sitting_Enter: ['sit down', 0, 0], Sitting_Exit: ['stand up', 0, 0], Sitting_Idle_Loop: ['sit', 0, 0],
  Sitting_Talking_Loop: ['sit and talk', 0, 0], Spell_Simple_Enter: ['spell raise', 0, 0], Spell_Simple_Exit: ['spell lower', 0, 0],
  Spell_Simple_Idle_Loop: ['spell ready', 0, 0], Spell_Simple_Shoot: ['spell cast', 0, 0], Sprint_Loop: ['sprint', 6.3604, 0.85],
  Swim_Fwd_Loop: ['swim', 0, 0.85], Swim_Idle_Loop: ['tread water', 0.485, 0.11], Sword_Attack: ['sword attack', 0, 0], Sword_Idle: ['sword idle', 0, 0],
  Walk_Formal_Loop: ['walk formal', 1.1942, 0], Walk_Loop: ['walk', 1.1942, 0],
};

/** Standing idles cut from CMU takes: [from, to] seconds, the loop's cross-fade, mirrored, head motion kept. */
const IDLES: { name: string; take: string; from: number; to: number; fade: number; mirror?: boolean; head: number }[] = [
  { name: 'CMU_Idle_1', take: 'cmu 113_21', from: 1, to: 10.8, fade: 0.8, head: 0.45 },
  { name: 'CMU_Idle_2', take: 'cmu 113_21', from: 1, to: 10.8, fade: 0.8, head: 0.45, mirror: true },
  { name: 'CMU_Idle_3', take: 'cmu 77_02', from: 1, to: 7.5, fade: 0.8, head: 0.6 },
];

const FPS = 30;
/** Relaxed upright chest tilt of the standing idles (rad, about the lateral axis). */
const POSTURE = -0.04;
const UPPER = new Set(['spine.002', 'spine.003', 'neck', 'head', 'shoulder.L', 'shoulder.R']);
const S = BONES.length;
const STRIDE = S * 4 + 3;

interface Frames { q: THREE.Quaternion[][]; root: THREE.Vector3[] }

/**
 * A clip's frames for the library's bones, in Scale axes (half turn about +Y: x and z flip).
 * Each clip's rotations are changes from its own reference pose; limbs are re-expressed against
 * the library's rest segments `seg` (a mocap take's reference stands with spread legs, the
 * Quaternius rig in a T-pose): Δ · swing(library segment → the clip's).
 */
function framesOf(clip: Clip, seg: (THREE.Vector3 | null)[]): Frames {
  const def = clip.def, n = def.frameCount, stride = def.bones.length * 4 + 3, d = clip.data;
  const idx = BONES.map(([, a]) => def.bones.indexOf(a));
  const own = restSegs(clip);
  const fix = BONES.map((_, b) => (seg[b] && own[b] ? new THREE.Quaternion().setFromUnitVectors(seg[b]!, own[b]!) : null));
  const q: THREE.Quaternion[][] = [], root: THREE.Vector3[] = [];
  for (let f = 0; f < n; f++) {
    const o = f * stride;
    q.push(idx.map((k, b) => {
      if (k < 0) return new THREE.Quaternion();
      const r = new THREE.Quaternion(-d[o + k * 4], d[o + k * 4 + 1], -d[o + k * 4 + 2], d[o + k * 4 + 3]).normalize();
      return fix[b] ? r.multiply(fix[b]!) : r;
    }));
    const r = o + def.bones.length * 4;
    root.push(new THREE.Vector3(-d[r], d[r + 1], -d[r + 2]));
  }
  return { q, root };
}

/** Rest segment (unit, Scale axes) of the library's limb bones from a clip's reference directions. */
function restSegs(clip: Clip): (THREE.Vector3 | null)[] {
  return BONES.map(([name, a]) => {
    const k = clip.def.bones.indexOf(a);
    if (TORSO.has(name) || k < 0) return null;
    const r = clip.def.refDirs;
    return new THREE.Vector3(-r[k * 3], r[k * 3 + 1], -r[k * 3 + 2]).normalize();
  });
}

/** Left ↔ right: tracks swapped, rotations and offsets reflected in the body's mid plane (x → −x). */
function mirror(fr: Frames): Frames {
  const swap = BONES.map(([n]) => BONES.findIndex(([m]) => m === (n.endsWith('.L') ? n.replace('.L', '.R') : n.endsWith('.R') ? n.replace('.R', '.L') : n)));
  return {
    q: fr.q.map((qs) => swap.map((j) => new THREE.Quaternion(qs[j].x, -qs[j].y, -qs[j].z, qs[j].w))),
    root: fr.root.map((r) => new THREE.Vector3(-r.x, r.y, r.z)),
  };
}

/** A standing idle from a mocap take: cut, looped with a cross-fade, faced to −Z, the head calmed, the hips centred. */
function cutIdle(src: Frames, fps: number, t: (typeof IDLES)[number]): Frames {
  const n = Math.round((t.to - t.from) * FPS), nf = Math.round(t.fade * FPS);
  const at = (outF: number) => Math.min(src.q.length - 1, Math.max(0, Math.round((t.from + outF / FPS) * fps)));
  const q = Array.from({ length: n }, (_, f) => src.q[at(f)].map((x) => x.clone()));
  const root = Array.from({ length: n }, (_, f) => src.root[at(f)].clone());
  // Loop: the last nf frames cross-fade into the nf frames before the start.
  for (let k = 0; k < nf; k++) {
    const f = n - nf + k, lead = at(-nf + k);
    const u = (k + 1) / (nf + 1), w = u * u * (3 - 2 * u);
    q[f].forEach((x, b) => {
      const c = src.q[lead][b].clone();
      if (x.dot(c) < 0) c.set(-c.x, -c.y, -c.z, -c.w);
      x.slerp(c, w);
    });
    root[f].lerp(src.root[lead], w);
  }
  // The head's motion against the chest: centred on its mean and scaled down; the neck takes half
  // of it (the captured heads look about a lot, which repeated in a loop reads as a twitch).
  const chest = BONES.findIndex(([m]) => m === 'spine.003'), neck = BONES.findIndex(([m]) => m === 'neck'), head = BONES.findIndex(([m]) => m === 'head');
  const rel = q.map((x) => x[chest].clone().invert().multiply(x[head]));
  const acc = new THREE.Vector4();
  for (const r of rel) { const sg = r.dot(rel[0]) < 0 ? -1 : 1; acc.x += r.x * sg; acc.y += r.y * sg; acc.z += r.z * sg; acc.w += r.w * sg; }
  const meanInv = new THREE.Quaternion(acc.x, acc.y, acc.z, acc.w).normalize().invert();
  const id = new THREE.Quaternion();
  q.forEach((x, f) => {
    const l = id.clone().slerp(meanInv.clone().multiply(rel[f]), t.head);
    x[head].copy(x[chest]).multiply(l).normalize();
    x[neck].copy(x[chest]).multiply(id.clone().slerp(l, 0.5)).normalize();
  });
  // Facing: the hips' mean heading turned to −Z.
  let sx = 0, sz = 0;
  const fwd = new THREE.Vector3();
  for (const x of q) {
    fwd.set(0, 0, -1).applyQuaternion(x[0]);
    const l = Math.hypot(fwd.x, fwd.z) || 1;
    sx += fwd.x / l; sz += fwd.z / l;
  }
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.atan2(-sx, -sz));
  for (const x of q) for (const b of x) b.premultiply(turn);
  for (const r of root) r.applyQuaternion(turn);
  // Posture: the chest's mean forward tilt brought to a relaxed upright by turning the upper body
  // (mid spine up, collarbones included) about the lateral axis; the arms hang as captured.
  const e = new THREE.Euler();
  let tilt = 0;
  for (const x of q) tilt += e.setFromQuaternion(x[chest], 'YXZ').x;
  const straighten = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), POSTURE - tilt / n);
  const upper = BONES.flatMap(([m], i) => (UPPER.has(m) ? [i] : []));
  for (const x of q) for (const b of upper) x[b].premultiply(straighten);
  // Hips: sway around the cut's mean; standing height at the median.
  const mean3 = root.reduce((a, r) => a.add(r), new THREE.Vector3()).divideScalar(n);
  const ys = root.map((r) => r.y).sort((a, b) => a - b);
  const y0 = ys[Math.floor(ys.length / 2)];
  for (const r of root) r.set(r.x - mean3.x, r.y - y0, r.z - mean3.z);
  return { q, root };
}

/** Loops play in place: the hips' horizontal drift over the cycle taken out. */
function inPlace(fr: Frames, loop: boolean): Frames {
  if (!loop || fr.root.length < 2) return fr;
  const n = fr.root.length - 1; // the last frame repeats the first
  const drift = fr.root[n].clone().sub(fr.root[0]).setY(0);
  return { q: fr.q.slice(0, n), root: fr.root.slice(0, n).map((r, f) => r.clone().addScaledVector(drift, -f / n)) };
}

/** Loads the animator's clip library from an Actors runtime (the human pack). */
export async function actorClipLibrary(runtime: ActorRuntime): Promise<ClipLibraryData> {
  const chunks: { meta: ClipMeta; fr: Frames }[] = [];
  const have = new Set(runtime.manifest.clips?.map((c) => c.name) ?? []);
  // The library's rest segments: the Quaternius rig's (its idle).
  if (!have.has('idle')) throw new Error('the pack has no idle clip');
  const seg = restSegs(await runtime.loadClip('idle'));
  await Promise.all(Object.entries(CLIPS).filter(([, [a]]) => have.has(a)).map(async ([name, [a, speed, sync]]) => {
    const clip = await runtime.loadClip(a);
    const fr = inPlace(framesOf(clip, seg), clip.def.loop);
    const frames = fr.q.length;
    chunks.push({ meta: { name, frames, loop: clip.def.loop, dur: clip.def.loop ? frames / clip.def.fps : (frames - 1) / clip.def.fps, offset: 0, speed, sync }, fr });
  }));
  // The standing idles (optional: the animator falls back to Idle_Loop without them).
  try {
    if (runtime.manifest.clipLibraries?.some((l) => l.name === 'cmu')) {
      await runtime.loadClipLibrary('cmu');
      const takes = new Map<string, Clip>();
      for (const t of IDLES) {
        let clip = takes.get(t.take);
        if (!clip) takes.set(t.take, (clip = await runtime.loadClip(t.take)));
        const src = framesOf(clip, seg);
        const fr = cutIdle(t.mirror ? mirror(src) : src, clip.def.fps, t);
        chunks.push({ meta: { name: t.name, frames: fr.q.length, loop: true, dur: fr.q.length / FPS, offset: 0, speed: 0, sync: 0 }, fr });
      }
    }
  } catch (e) {
    console.warn('[anim] mocap idles unavailable', e);
  }
  const total = chunks.reduce((a, c) => a + c.fr.q.length, 0);
  const data = new Int16Array(total * STRIDE);
  const clips = new Map<string, ClipMeta>();
  let offset = 0;
  for (const { meta, fr } of chunks) {
    meta.offset = offset;
    let prev: THREE.Quaternion[] | null = null;
    fr.q.forEach((qs, f) => {
      const o = offset + f * STRIDE;
      qs.forEach((q, b) => {
        // Consistent hemisphere frame to frame (cleaner interpolation).
        if (prev && prev[b].dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        data[o + b * 4] = Math.round(q.x * 32767);
        data[o + b * 4 + 1] = Math.round(q.y * 32767);
        data[o + b * 4 + 2] = Math.round(q.z * 32767);
        data[o + b * 4 + 3] = Math.round(q.w * 32767);
      });
      prev = qs;
      // Hips offset in thousandths of a leg length (the library's leg length is 1).
      const r = fr.root[f];
      data[o + S * 4] = Math.round(r.x * 1000);
      data[o + S * 4 + 1] = Math.round(r.y * 1000);
      data[o + S * 4 + 2] = Math.round(r.z * 1000);
    });
    offset += fr.q.length * STRIDE;
    clips.set(meta.name, meta);
  }
  return {
    fps: FPS, bones: BONES.map(([n]) => n), restQ: BONES.map(() => new THREE.Quaternion()), restSeg: seg,
    legLen: 1, stride: STRIDE, clips, data,
  };
}
