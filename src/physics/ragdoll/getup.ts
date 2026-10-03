/**
 * Procedural get-up: key poses from lying (on the back or face down) to standing, in the
 * animator's Pose conventions (pose.ts), interpolated with smoothstep easing.
 *
 *  - From the back: lying → propped on the elbows → sitting, knees pulled up, a hand behind →
 *    a deep squat with the weight over the feet → rising → standing.
 *  - Face down: lying → push-up → all fours → kneeling on one knee → rising → standing.
 *
 * Angles follow the leg geometry so feet and knees stay on the ground: a thigh's world pitch
 * is root + flex, a shin's root + flex − knee, a foot's root + flex − knee − ankle. Heights
 * and offsets are for a 0.94 m hip height and scale with the character's (`q`).
 *
 * The model origin stays where the pelvis lay; standing up moves the body over the feet
 * (root.z), `END_Z` tells the caller how far forward it ends (model units × q).
 */
import { Pose, smooth, type BoneMap } from '../../humanoid/client/anim/pose';

type Key = (p: Pose, q: number) => void;
const HIP = 0.94;
const PI2 = Math.PI / 2;

const UP_KEYS: [number, Key][] = [
  [0, (p, q) => { // lying on the back
    p.add('root', PI2);
    p.root.y = -(HIP - 0.1) * q;
    p.arm('L', 0.1, 0.55, 0, 0.35); p.arm('R', 0.1, 0.55, 0, 0.35);
    p.leg('L', 0, 0.08, 0, 0.1, 0.3); p.leg('R', 0, 0.06, 0, 0.05, 0.3);
  }],
  [0.2, (p, q) => { // propped on the elbows, chin to the chest
    p.add('root', 1.0);
    p.root.y = -(HIP - 0.11) * q;
    p.spine(-0.35); p.neck(-0.5);
    p.arm('L', -0.95, 0.35, 0, 1.45); p.arm('R', -0.95, 0.35, 0, 1.45);
    p.leg('L', 0.6, 0.08, 0, 0.5, 0.2); p.leg('R', 0.55, 0.06, 0, 0.1, 0.2);
  }],
  [0.42, (p, q) => { // sitting, knees up, right hand behind on the ground
    p.add('root', 0.35);
    p.root.y = -(HIP - 0.13) * q;
    p.spine(-0.5); p.neck(-0.25);
    p.arm('R', -0.75, 0.4, 0, 0.15, 0, 0.6); p.arm('L', 0.95, 0.2, 0, 0.7);
    p.leg('L', 1.95, 0.1, 0, 2.05, -0.1); p.leg('R', 1.85, 0.12, 0, 1.75, -0.1);
  }],
  [0.66, (p, q) => { // deep squat, weight forward over the feet, arms out front
    p.add('root', -0.45);
    p.root.y = -(HIP - 0.47) * q;
    p.root.z = -0.13 * q;
    p.spine(-0.45); p.neck(0.45);
    p.arm('L', 1.0, 0.25, 0, 0.5); p.arm('R', 0.9, 0.25, 0, 0.6);
    p.leg('L', 2.0, 0.12, 0, 1.87, -0.3); p.leg('R', 2.0, 0.12, 0, 1.87, -0.3);
  }],
  [0.84, (p, q) => { // rising
    p.add('root', -0.25);
    p.root.y = -0.19 * q;
    p.root.z = -0.21 * q;
    p.spine(-0.25); p.neck(0.25);
    p.arm('L', 0.45, 0.2, 0, 0.4); p.arm('R', 0.4, 0.2, 0, 0.45);
    p.leg('L', 1.15, 0.06, 0, 1.15, -0.25); p.leg('R', 1.15, 0.06, 0, 1.15, -0.25);
  }],
  [1, (p, q) => { p.root.z = END_Z_UP * q; }],
];

const DOWN_KEYS: [number, Key][] = [
  [0, (p, q) => { // face down, hands under the shoulders
    p.add('root', -PI2);
    p.root.y = -(HIP - 0.1) * q;
    p.neck(0.2, 0.5);
    p.arm('L', 0.6, 0.75, 0, 1.6); p.arm('R', 0.6, 0.75, 0, 1.6);
    p.leg('L', 0, 0.08, 0, 0.1, -0.6); p.leg('R', 0, 0.06, 0, 0.05, -0.6);
  }],
  [0.24, (p, q) => { // push-up, chest off the ground
    p.add('root', -1.15);
    p.root.y = -(HIP - 0.15) * q;
    p.spine(0.35); p.neck(0.3);
    p.arm('L', 1.2, 0.35, 0, 0.35); p.arm('R', 1.2, 0.35, 0, 0.35);
    p.leg('L', -0.2, 0.08, 0, 0.35, -0.5); p.leg('R', -0.25, 0.06, 0, 0.3, -0.5);
  }],
  [0.46, (p, q) => { // all fours
    p.add('root', -1.42);
    p.root.y = -(HIP - 0.49) * q;
    p.spine(0.1); p.neck(0.6);
    p.arm('L', 1.42, 0.12, 0, 0.1); p.arm('R', 1.42, 0.12, 0, 0.1);
    p.leg('L', 1.42, 0.1, 0, 1.57, 0); p.leg('R', 1.42, 0.1, 0, 1.57, 0);
  }],
  [0.68, (p, q) => { // kneeling on the right knee, left foot planted, hand on the knee
    p.add('root', -0.3);
    p.root.y = -(HIP - 0.49) * q;
    p.spine(-0.1); p.neck(0.1);
    p.arm('L', 0.8, 0.2, 0, 0.6); p.arm('R', 0.2, 0.2, 0, 0.3);
    p.leg('L', 1.87, 0.08, 0, 1.57, 0); p.leg('R', 0.3, 0.06, 0, 1.57, -0.57);
  }],
  [0.85, (p, q) => { // rising over the left foot
    p.add('root', -0.2);
    p.root.y = -0.1 * q;
    p.root.z = -0.27 * q;
    p.spine(-0.05);
    p.arm('L', 0.45, 0.2, 0, 0.5); p.arm('R', 0.25, 0.2, 0, 0.3);
    p.leg('L', 0.8, 0.06, 0, 0.8, -0.2); p.leg('R', 0.3, 0.06, 0, 1.0, -0.3);
  }],
  [1, (p, q) => { p.root.z = END_Z_DOWN * q; }],
];

const END_Z_UP = -0.42, END_Z_DOWN = -0.38;

/** How far forward (model −Z, units × q) the body ends up standing. */
export function getupEndZ(faceUp: boolean): number { return faceUp ? END_Z_UP : END_Z_DOWN; }

export class GetUpPoser {
  private a: Pose;
  private b: Pose;
  constructor(map: BoneMap) {
    this.a = new Pose(map);
    this.b = new Pose(map);
  }

  /** The get-up pose at progress u (0: lying … 1: standing) into p; q = hip height / 0.94 m. */
  pose(p: Pose, faceUp: boolean, u: number, q: number): void {
    const keys = faceUp ? UP_KEYS : DOWN_KEYS;
    let k = 1;
    while (k < keys.length - 1 && u > keys[k][0]) k++;
    const [t0, f0] = keys[k - 1], [t1, f1] = keys[k];
    const w = smooth(t0, t1, u);
    f0(this.a.clear(), q);
    f1(this.b.clear(), q);
    p.copy(this.a).blend(this.b, w);
  }
}
