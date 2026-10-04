/**
 * Self test of the CMU BVH parser and retargeting (tools/cmuBvh.ts), run by tools/selftest.ts:
 * a synthetic CMU-named BVH built on the library's own rest skeleton must map its rest pose onto
 * the library rest exactly; posed limbs must point where the BVH's do; rotations stay unit
 * length, bone lengths are kept, and mirroring twice gives the pose back.
 */
import * as THREE from 'three';
import { readFileSync } from 'fs';
import { parseBvh, bvhPose, CmuRetarget, libSkeleton, libJoints, mirrorFrame, type LibSkeleton } from './cmuBvh';

/** CMU joint → the library joint it sits on (null: same place as its parent). */
const AT: [string, string | null, string | null][] = [
  // [joint, parent, library bone whose head it sits on]
  ['Hips', null, 'hips'],
  ['LowerBack', 'Hips', null], ['Spine', 'LowerBack', 'spine.002'], ['Spine1', 'Spine', 'spine.003'],
  ['Neck', 'Spine1', null], ['Neck1', 'Neck', 'neck'], ['Head', 'Neck1', 'head'],
];
for (const [s, S] of [['L', 'Left'], ['R', 'Right']] as const) {
  AT.push(
    [`${S}Shoulder`, 'Spine1', null], [`${S}Arm`, `${S}Shoulder`, `upper_arm.${s}`], [`${S}ForeArm`, `${S}Arm`, `forearm.${s}`], [`${S}Hand`, `${S}ForeArm`, `hand.${s}`],
    [`${s === 'L' ? 'LHipJoint' : 'RHipJoint'}`, 'Hips', null], [`${S}UpLeg`, s === 'L' ? 'LHipJoint' : 'RHipJoint', `thigh.${s}`],
    [`${S}Leg`, `${S}UpLeg`, `shin.${s}`], [`${S}Foot`, `${S}Leg`, `foot.${s}`], [`${S}ToeBase`, `${S}Foot`, `toe.${s}`],
  );
}

/** A BVH (CMU axes: Norgo turned half about Y) on the library skeleton; `rot` sets joint Z/Y/X angles (deg). */
function syntheticBvh(lib: LibSkeleton, frames: Record<string, [number, number, number]>[]): string {
  const pos = new Map<string, THREE.Vector3>();
  for (const [j, p, at] of AT) pos.set(j, at ? lib.restHead[lib.bones.indexOf(at)].clone() : pos.get(p!)!.clone());
  const cmu = (v: THREE.Vector3) => `${(-v.x).toFixed(6)} ${v.y.toFixed(6)} ${(-v.z).toFixed(6)}`;
  const kids = (p: string | null) => AT.filter((a) => a[1] === p).map((a) => a[0]);
  const order: string[] = [];
  const emit = (j: string, depth: number): string => {
    order.push(j);
    const pad = '\t'.repeat(depth);
    const parent = AT.find((a) => a[0] === j)![1];
    const off = parent ? pos.get(j)!.clone().sub(pos.get(parent)!) : pos.get(j)!;
    const ch = parent ? 'CHANNELS 3 Zrotation Yrotation Xrotation' : 'CHANNELS 6 Xposition Yposition Zposition Zrotation Yrotation Xrotation';
    const c = kids(j);
    const body = c.length ? c.map((k) => emit(k, depth + 1)).join('') : `${pad}\tEnd Site\n${pad}\t{\n${pad}\t\tOFFSET 0 0.05 0\n${pad}\t}\n`;
    return `${pad}${parent ? 'JOINT' : 'ROOT'} ${j}\n${pad}{\n${pad}\tOFFSET ${parent ? cmu(off) : '0 0 0'}\n${pad}\t${ch}\n${body}${pad}}\n`;
  };
  const h = emit('Hips', 0);
  const rows = frames.map((fr) => order.map((j) => {
    const r = fr[j] ?? [0, 0, 0];
    return j === 'Hips' ? `${cmu(pos.get('Hips')!)} ${r.join(' ')}` : r.join(' ');
  }).join(' '));
  return `HIERARCHY\n${h}MOTION\nFrames: ${frames.length}\nFrame Time: 0.0083333\n${rows.join('\n')}\n`;
}

export function cmuBvhChecks(check: (ok: boolean, msg: string) => void) {
  const lib = libSkeleton(JSON.parse(readFileSync('public/assets/anim/clips.json', 'utf8')));
  const text = syntheticBvh(lib, [{}, { LeftArm: [-70, 20, 15], LeftForeArm: [0, 30, 40], LeftHand: [10, 50, 0], RightUpLeg: [5, -10, 35], RightLeg: [0, 0, -50], Spine: [8, 12, -6] }]);
  const bvh = parseBvh(text);
  check(bvh.frames === 2 && bvh.joints.length === AT.length && bvh.nch === 6 + 3 * (AT.length - 1), `cmu bvh: parsed ${bvh.joints.length} joints, ${bvh.nch} channels, ${bvh.frames} frames`);
  const rt = new CmuRetarget(bvh, lib);
  check(Math.abs(rt.scale - 1) < 1e-4, `cmu bvh: leg-length scale of a same-size skeleton is 1 (${rt.scale.toFixed(5)})`);
  // Rest maps to rest.
  const r0 = rt.frame(0);
  let worst = 0;
  r0.q.forEach((q, b) => { worst = Math.max(worst, q.angleTo(lib.rest[b])); });
  check(worst < 1e-3, `cmu bvh: rest pose retargets to the library rest (worst ${(worst * 180 / Math.PI).toFixed(4)}°)`);
  check(r0.hips.distanceTo(lib.restHead[0]) < 1e-4, 'cmu bvh: rest hips at the library rest hips');
  // Posed: unit quaternions, kept bone lengths, limb segments along the BVH's.
  const r1 = rt.frame(1);
  check(r1.q.every((q) => Math.abs(q.length() - 1) < 1e-6), 'cmu bvh: retargeted rotations are unit quaternions');
  const P = libJoints(lib, r1.q, r1.hips), R = libJoints(lib, lib.rest, lib.restHead[0]);
  let len = 0;
  for (const [a, c] of [['upper_arm.L', 'forearm.L'], ['forearm.L', 'hand.L'], ['thigh.R', 'shin.R'], ['shin.R', 'foot.R'], ['spine.002', 'spine.003']]) {
    const i = lib.bones.indexOf(a), k = lib.bones.indexOf(c);
    len = Math.max(len, Math.abs(P[i].distanceTo(P[k]) - R[i].distanceTo(R[k])));
  }
  check(len < 1e-5, `cmu bvh: bone lengths kept (worst ${(len * 1000).toFixed(4)} mm)`);
  const rot: THREE.Quaternion[] = [], pos: THREE.Vector3[] = [];
  bvhPose(bvh, 1, rot, pos);
  const J = (n: string) => bvh.joints.findIndex((j) => j.name === n);
  let dir = 0;
  for (const [a, c, la, lc] of [['LeftArm', 'LeftForeArm', 'upper_arm.L', 'forearm.L'], ['LeftForeArm', 'LeftHand', 'forearm.L', 'hand.L'], ['RightUpLeg', 'RightLeg', 'thigh.R', 'shin.R'], ['RightLeg', 'RightFoot', 'shin.R', 'foot.R']]) {
    const d1 = pos[J(c)].clone().sub(pos[J(a)]).normalize();
    const d2 = P[lib.bones.indexOf(lc)].clone().sub(P[lib.bones.indexOf(la)]).normalize();
    dir = Math.max(dir, d1.angleTo(d2));
  }
  check(dir < 1e-3, `cmu bvh: posed limbs point along the captured ones (worst ${(dir * 180 / Math.PI).toFixed(4)}°)`);
  // The wrist's twist moves onto the forearm (the hand follows it).
  const fa = lib.bones.indexOf('forearm.L'), hd = lib.bones.indexOf('hand.L');
  const df = r1.q[fa].clone().multiply(lib.rest[fa].clone().invert()), dh = r1.q[hd].clone().multiply(lib.rest[hd].clone().invert());
  check(df.angleTo(dh) < 1e-4, 'cmu bvh: hands follow the forearm');
  // Mirror twice = identity.
  const mm = mirrorFrame(lib, mirrorFrame(lib, r1));
  let mw = 0;
  mm.q.forEach((q, b) => { mw = Math.max(mw, q.angleTo(r1.q[b])); });
  check(mw < 1e-4 && mm.hips.distanceTo(r1.hips) < 1e-6, `cmu bvh: mirroring twice gives the pose back (${mw.toExponential(1)})`);
  // The clip library carries the motion-captured idles.
  const clips = JSON.parse(readFileSync('public/assets/anim/clips.json', 'utf8')).clips as { name: string; loop: boolean; frames: number }[];
  const idles = clips.filter((c) => /^CMU_Idle_\d$/.test(c.name));
  check(idles.length >= 1 && idles.every((c) => c.loop && c.frames > 60), `cmu bvh: library has the CMU idle loops (${idles.map((c) => c.name).join(', ')})`);
}
