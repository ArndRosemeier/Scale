/**
 * Ragdoll body plan for the MakeHuman rig: 14 parts, their driver bones, shapes, mass shares
 * and joint limits.
 *
 * Every part's rigid-body frame is the rig's model frame at rest (+Y up, the character faces
 * −Z, its left is −X): MakeHuman bones have translation-only rest frames, so at rest every
 * body has the same orientation and a body's rotation *is* its driver bone's world rotation.
 * The body origin is the driver bone's head (the joint to its parent part), so joint anchors
 * are simply rest offsets between bone heads, and joint limits are angles away from the rest
 * pose about the model axes (X: flex/swing forward, Y: twist, Z: sideways).
 *
 * Bones inside a part (`sub`) are held at their rest rotation while the ragdoll drives the rig.
 */

export const enum Part { Pelvis, Abdomen, Chest, Head, UArmL, LArmL, UArmR, LArmR, ThighL, ShinL, FootL, ThighR, ShinR, FootR }
export const PART_COUNT = 14;

export type Vec3 = [number, number, number];

export interface PartDef {
  name: string;
  parent: number;
  /** Driver bone: its head is the body origin; its world rotation is the body's. */
  bone: string;
  /** Bone whose world rotation seeds the body from an animated pose (the end of the part's chain). */
  seed: string;
  /** Bones inside the part, held at rest rotation while ragdolled. */
  sub: string[];
  /** Share of the body mass. */
  mass: number;
  /** Joint to the parent: 'ball' with [xmin, xmax, ymin, ymax, zmin, zmax], 'hinge' with [min, max]. */
  joint: 'ball' | 'hinge' | 'none';
  limits: number[];
  /**
   * Relaxed joint angles (ball: x, y, z; hinge: one) that a faint muscle tone pulls toward:
   * a limp body still folds at the knees and elbows instead of locking straight.
   */
  relax: number[];
  /** Limb collider group (arms do not collide with other ragdoll parts). */
  arm?: boolean;
}

// Left-side limits; the right side mirrors Y and Z (negated and swapped).
const SPINE = [-0.6, 0.35, -0.4, 0.4, -0.35, 0.35];
const NECK = [-0.75, 0.6, -1.0, 1.0, -0.5, 0.5];
const SHOULDER_L = [-0.9, 2.3, -1.0, 1.0, -1.7, 0.75];
const HIP_L = [-0.55, 1.95, -0.5, 0.5, -0.85, 0.25];
const ANKLE = [-0.7, 0.6, -0.2, 0.2, -0.3, 0.3];
const mirror = (l: number[]) => [l[0], l[1], -l[3], -l[2], -l[5], -l[4]];

export const PARTS: PartDef[] = [
  { name: 'pelvis', parent: -1, bone: 'root', seed: 'root', sub: ['spine05', 'pelvis.L', 'pelvis.R'], relax: [], mass: 0.15, joint: 'none', limits: [] },
  { name: 'abdomen', parent: Part.Pelvis, bone: 'spine04', seed: 'spine03', sub: ['spine03'], relax: [-0.08, 0, 0], mass: 0.11, joint: 'ball', limits: SPINE },
  { name: 'chest', parent: Part.Abdomen, bone: 'spine02', seed: 'spine01', sub: ['spine01', 'clavicle.L', 'shoulder01.L', 'clavicle.R', 'shoulder01.R'], relax: [-0.08, 0, 0], mass: 0.2, joint: 'ball', limits: SPINE },
  { name: 'head', parent: Part.Chest, bone: 'neck01', seed: 'neck03', sub: ['neck02', 'neck03', 'head'], relax: [-0.15, 0, 0], mass: 0.08, joint: 'ball', limits: NECK },
  { name: 'upperarm.L', parent: Part.Chest, bone: 'upperarm01.L', seed: 'upperarm02.L', sub: ['upperarm02.L'], relax: [0.15, 0, 0.35], mass: 0.028, joint: 'ball', limits: SHOULDER_L, arm: true },
  { name: 'forearm.L', parent: Part.UArmL, bone: 'lowerarm01.L', seed: 'lowerarm02.L', sub: ['lowerarm02.L', 'wrist.L'], relax: [0.45], mass: 0.022, joint: 'hinge', limits: [-0.7, 1.75], arm: true },
  { name: 'upperarm.R', parent: Part.Chest, bone: 'upperarm01.R', seed: 'upperarm02.R', sub: ['upperarm02.R'], relax: [0.15, 0, -0.35], mass: 0.028, joint: 'ball', limits: mirror(SHOULDER_L), arm: true },
  { name: 'forearm.R', parent: Part.UArmR, bone: 'lowerarm01.R', seed: 'lowerarm02.R', sub: ['lowerarm02.R', 'wrist.R'], relax: [0.45], mass: 0.022, joint: 'hinge', limits: [-0.7, 1.75], arm: true },
  { name: 'thigh.L', parent: Part.Pelvis, bone: 'upperleg01.L', seed: 'upperleg02.L', sub: ['upperleg02.L'], relax: [0.25, 0, 0], mass: 0.1, joint: 'ball', limits: HIP_L },
  { name: 'shin.L', parent: Part.ThighL, bone: 'lowerleg01.L', seed: 'lowerleg02.L', sub: ['lowerleg02.L'], relax: [-0.6], mass: 0.047, joint: 'hinge', limits: [-2.45, 0.03] },
  { name: 'foot.L', parent: Part.ShinL, bone: 'foot.L', seed: 'foot.L', sub: ['toes.L'], relax: [0.2, 0, 0], mass: 0.014, joint: 'ball', limits: ANKLE },
  { name: 'thigh.R', parent: Part.Pelvis, bone: 'upperleg01.R', seed: 'upperleg02.R', sub: ['upperleg02.R'], relax: [0.25, 0, 0], mass: 0.1, joint: 'ball', limits: mirror(HIP_L) },
  { name: 'shin.R', parent: Part.ThighR, bone: 'lowerleg01.R', seed: 'lowerleg02.R', sub: ['lowerleg02.R'], relax: [-0.6], mass: 0.047, joint: 'hinge', limits: [-2.45, 0.03] },
  { name: 'foot.R', parent: Part.ShinR, bone: 'foot.R', seed: 'foot.R', sub: ['toes.R'], relax: [0.2, 0, 0], mass: 0.014, joint: 'ball', limits: mirror(ANKLE) },
];

/**
 * Rest bone heads (model space, m) of a typical 1.76 m rig: the fallback for agents without a
 * built rig (instanced crowd people), scaled to their size. Left side; the right mirrors X.
 */
const REST_L: Record<string, Vec3> = {
  root: [0, 0.938, 0.061], spine05: [0, 0.949, -0.008], spine04: [0, 1.035, 0.027], spine03: [0, 1.104, 0.016], spine02: [0, 1.17, 0.022],
  spine01: [0, 1.312, 0.041], neck01: [0, 1.514, -0.011], neck03: [0, 1.563, -0.027], head: [0, 1.601, -0.045],
  'upperarm01.L': [-0.182, 1.412, -0.02], 'lowerarm01.L': [-0.355, 1.216, -0.02], 'wrist.L': [-0.489, 1.086, -0.208], 'finger3-1.L': [-0.538, 1.03, -0.296],
  'upperleg01.L': [-0.107, 0.941, 0.003], 'lowerleg01.L': [-0.151, 0.514, -0.032], 'foot.L': [-0.195, 0.07, -0.016], 'toes.L': [-0.206, 0.027, -0.149],
};
export const REST_HEIGHT = 1.76;

export function defaultRest(name: string): Vec3 | null {
  const r = REST_L[name];
  if (r) return r;
  if (name.endsWith('.R')) {
    const l = REST_L[name.slice(0, -2) + '.L'];
    if (l) return [-l[0], l[1], l[2]];
  }
  return null;
}

/** Collider of one part in its body frame (model axes, origin at the driver bone head), model units. */
export interface PartShape {
  kind: 'capsule' | 'box' | 'ball';
  /** capsule: segment ends; box/ball: centre (a). */
  a: Vec3;
  b: Vec3;
  r: number;
  /** box half extents. */
  half: Vec3;
}

/** Body plan of one character: part origins (model space) and shapes, in model units. */
export interface RagDims {
  origin: Vec3[];
  shape: PartShape[];
  /** Hinge axes (forearms: perpendicular to the rest arm plane; knees: model X). */
  hinge: Vec3[];
  /** Hip height and stature (model units), for poses and settling thresholds. */
  hipH: number;
  height: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Body plan from rest bone heads (a rig's `Character.rest`, or the defaults scaled). */
export function makeDims(rest: (name: string) => Vec3 | null): RagDims {
  const R = (n: string): Vec3 => rest(n) ?? defaultRest(n)!;
  const height = R('head')[1] + 0.16 * (R('head')[1] / 1.6);
  const f = height / REST_HEIGHT;
  const origin = PARTS.map((p) => R(p.bone));
  const shape: PartShape[] = [];
  const hinge: Vec3[] = [];
  const cap = (o: Vec3, from: Vec3, to: Vec3, r: number, trimA = 0.5, trimB = 0.4): PartShape => {
    const d = sub(to, from), l = len(d) || 1;
    const ta = Math.min(0.3, (r * trimA) / l), tb = Math.min(0.3, (r * trimB) / l);
    return { kind: 'capsule', a: sub(lerp3(from, to, ta), o), b: sub(lerp3(from, to, 1 - tb), o), r, half: [0, 0, 0] };
  };
  for (let i = 0; i < PART_COUNT; i++) {
    const p = PARTS[i], o = origin[i];
    const side = p.bone.endsWith('.R') ? 'R' : 'L';
    hinge.push([1, 0, 0]);
    switch (i) {
      case Part.Pelvis: {
        const hl = R('upperleg01.L'), hr = R('upperleg01.R');
        const y = (hl[1] + hr[1]) / 2 - 0.01 * f, z = (hl[2] + hr[2]) / 2;
        const r = 0.11 * f, hw = Math.max(0.02, Math.abs(hl[0] - hr[0]) / 2 - 0.035 * f);
        shape.push({ kind: 'capsule', a: sub([-hw, y, z], o), b: sub([hw, y, z], o), r, half: [0, 0, 0] });
        break;
      }
      case Part.Abdomen: {
        const top = R('spine02'), hy = (top[1] - o[1]) / 2 + 0.015 * f;
        shape.push({ kind: 'box', a: sub([0, (o[1] + top[1]) / 2, (o[2] + top[2]) / 2 - 0.005 * f], o), b: [0, 0, 0], r: 0.03 * f, half: [0.125 * f, hy, 0.085 * f] });
        break;
      }
      case Part.Chest: {
        const top = R('neck01'), hy = (top[1] - o[1]) / 2 - 0.01 * f;
        shape.push({ kind: 'box', a: sub([0, (o[1] + top[1]) / 2 - 0.005 * f, (o[2] + top[2]) / 2 - 0.005 * f], o), b: [0, 0, 0], r: 0.04 * f, half: [0.135 * f, hy, 0.095 * f] });
        break;
      }
      case Part.Head: {
        const h = R('head');
        shape.push({ kind: 'ball', a: sub([0, h[1] + 0.07 * f, h[2] + 0.015 * f], o), b: [0, 0, 0], r: 0.1 * f, half: [0, 0, 0] });
        break;
      }
      case Part.UArmL: case Part.UArmR:
        shape.push(cap(o, o, R('lowerarm01.' + side), 0.047 * f, 0.8, 0.4));
        break;
      case Part.LArmL: case Part.LArmR: {
        const hand = R('finger3-1.' + side);
        shape.push(cap(o, o, hand, 0.04 * f, 0.4, -0.2));
        // Elbow hinge: perpendicular to the plane of the rest upper arm and forearm.
        const u = sub(o, R('upperarm01.' + side)), w = sub(hand, o);
        const c: Vec3 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const cl = len(c);
        hinge[i] = cl > 1e-4 ? [c[0] / cl, c[1] / cl, c[2] / cl] : [1, 0, 0];
        break;
      }
      case Part.ThighL: case Part.ThighR:
        shape.push(cap(o, o, R('lowerleg01.' + side), 0.07 * f, 1.2, 0.3));
        break;
      case Part.ShinL: case Part.ShinR:
        shape.push(cap(o, o, R('foot.' + side), 0.05 * f, 0.3, 0.6));
        break;
      default: {
        // Foot: a box from behind the ankle to the toe tips, sole on the rest ground (y = 0).
        const t = R('toes.' + side);
        const heel = o[2] + 0.06 * f, tip = t[2] - 0.07 * f, top = Math.max(0.05 * f, o[1] + 0.01 * f);
        shape.push({ kind: 'box', a: sub([(o[0] + t[0]) / 2, top / 2, (heel + tip) / 2], o), b: [0, 0, 0], r: 0.012 * f, half: [0.045 * f, top / 2, (heel - tip) / 2] });
        break;
      }
    }
  }
  return { origin, shape, hinge, hipH: (R('upperleg01.L')[1] + R('upperleg01.R')[1]) / 2, height };
}

let defaultDims: RagDims | null = null;
/** The default body plan (1.76 m); scale it with the ragdoll's size factor. */
export function defaultBodyDims(): RagDims {
  return defaultDims ??= makeDims(() => null);
}
