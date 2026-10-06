/**
 * One-shot action poses for all humanoid ActionAnim ids (see
 * docs/ARCHITECTURE.md). Each action writes an absolute pose (relative to
 * the arms-down neutral) for progress t ∈ [0,1] and declares which body
 * parts it drives (`mask`), so locomotion keeps running underneath upper-body
 * actions. Weapon actions adapt to the held item (grip class).
 *
 * Motion is phrased as anticipation → action → follow-through → recovery
 * with eased keys (`kf`), which is what makes procedural motion read as
 * weighty rather than robotic.
 */
import { kf, type Pose } from './pose';

export type GripClass = 'none' | 'blade' | 'dagger' | 'axe' | 'blunt' | 'twohand' | 'polearm' | 'staff' | 'bow' | 'crossbow' | 'shield' | 'torch' | 'tool' | 'wand' | 'thrown' | 'item';

export interface ActionCtx {
  main: GripClass;
  off: GripClass;
  /** Alternates per action start (left/right swings, variety). */
  variant: number;
  /** Seconds since action start. */
  elapsed: number;
  dur: number;
  /** Aim pitch (radians, + up) for casts/shots. */
  aimPitch: number;
}

/**
 * A library clip (anim/clips.ts) that plays the action when available: the [from, to] part
 * of the clip (normalized) is stretched over the action's duration; loops play in real time.
 */
export interface ClipUse {
  name: string;
  from?: number;
  to?: number;
}

/** Which parts an action drives: upper (spine/arms/head), full (everything), arms only. */
export type ActionMask = 'upper' | 'full' | 'arms' | 'rightArm' | 'face';

export interface ActionDef {
  mask: ActionMask;
  /** Blend in/out times as fractions of the duration. */
  blendIn: number;
  blendOut: number;
  pose(p: Pose, t: number, c: ActionCtx): void;
  /** Mood override during the action (facial). */
  mood?: string;
  /** Loops over its duration (channel, dance...). */
  loop?: boolean;
  /** Motion-captured clip for this action (the pose function is the fallback / other variants). */
  clip?: (c: ActionCtx) => ClipUse | null;
  /**
   * Hands placed by IK on named anchors of a worn prop (a guitar's neck and strings), over the
   * authored pose (which sets the elbow direction). Without the anchor the pose stays as authored.
   */
  reach?: (c: ActionCtx) => Partial<Record<'L' | 'R', HandReach>>;
  /** Finger curl per hand while the action plays (0 open … 1.5 fist), over the grip default. */
  curl?: Partial<Record<'L' | 'R', number>>;
}

/** Where a hand's grip point goes: an offset (m) in the frame of the named anchor object. */
export interface HandReach {
  anchor: string;
  x: number;
  y: number;
  z: number;
  /** Which way the elbow points: outward (away from the body for this arm), up, forward. */
  pole?: [number, number, number];
}

const PI = Math.PI;

/** Right arm swing variants for one-handed weapons. */
function swing1h(p: Pose, t: number, c: ActionCtx) {
  const heavy = c.main === 'axe' || c.main === 'blunt';
  const fast = c.main === 'dagger';
  const back = c.variant % 2 === 1;
  if (heavy) {
    // Overhead diagonal chop.
    const raise = kf(t, [[0, 0], [0.32, 1], [0.5, -0.2], [0.72, -0.35], [1, 0]]);
    p.arm('R', 0.6 + raise * 1.9, 0.35 + raise * 0.3, -0.3, 1.6 - raise * 0.6 + kf(t, [[0, 0], [0.5, -1.1], [0.75, -0.9], [1, 0]]), 0.2, kf(t, [[0, 0], [0.3, 0.6], [0.55, -0.5], [1, 0]]));
    p.spine(kf(t, [[0, 0], [0.32, 0.18], [0.55, -0.42], [0.8, -0.25], [1, 0]]), kf(t, [[0, 0], [0.32, 0.45], [0.55, -0.35], [1, 0]]), kf(t, [[0, 0], [0.3, 0.1], [0.55, -0.12], [1, 0]]));
  } else if (back) {
    // Backhand slash: left-to-right across the body.
    const a = kf(t, [[0, 0], [0.28, 1], [0.52, -1], [0.75, -1.1], [1, 0]]);
    p.arm('R', 1.25 + Math.abs(a) * 0.2, 0.35 - a * 0.9, 0.5 * a, 1.0 - Math.abs(a) * 0.55, -0.6, 0.2 * a, 0.5 * a);
    p.spine(-0.12, -a * 0.55, 0);
  } else {
    // Forehand slash: wind up behind the shoulder, cut diagonally down across.
    const a = kf(t, [[0, 0], [fast ? 0.2 : 0.3, 1], [fast ? 0.42 : 0.52, -0.9], [0.75, -1.05], [1, 0]]);
    p.arm('R', 1.0 + a * 0.6, 0.6 + a * 0.75, -0.6 * a, 1.2 - Math.abs(a) * 0.65, 0.3, kf(t, [[0, 0], [0.3, 0.5], [0.52, -0.6], [1, 0]]), -0.5 * a);
    p.spine(kf(t, [[0, 0], [0.3, 0.05], [0.55, -0.2], [1, 0]]), a * 0.6, -a * 0.08);
  }
  p.neck(0, 0, 0);
  p.leg('L', kf(t, [[0, 0], [0.45, 0.25], [1, 0]]), 0, 0, kf(t, [[0, 0], [0.45, 0.35], [1, 0]]));
  p.leg('R', kf(t, [[0, 0], [0.45, -0.15], [1, 0]]), 0, 0, kf(t, [[0, 0], [0.45, 0.25], [1, 0]]));
}

function swing2h(p: Pose, t: number, c: ActionCtx) {
  const overhead = c.main === 'blunt' || c.main === 'axe' || c.variant % 2 === 1;
  if (overhead) {
    const r = kf(t, [[0, 0], [0.38, 1], [0.58, -0.35], [0.8, -0.4], [1, 0]]);
    for (const s of ['R', 'L'] as const) {
      const m = s === 'R' ? 1 : 0.85;
      p.arm(s, 0.9 + r * 1.7 * m, s === 'R' ? 0.2 : -0.1, 0, 1.2 - r * 0.5, 0.4, kf(t, [[0, 0], [0.38, 0.8], [0.6, -0.4], [1, 0]]));
    }
    p.spine(kf(t, [[0, 0], [0.38, 0.25], [0.6, -0.6], [0.82, -0.45], [1, 0]]), kf(t, [[0, 0], [0.38, 0.3], [0.6, -0.15], [1, 0]]));
    p.leg('L', kf(t, [[0, 0], [0.55, 0.35], [1, 0]]), 0, 0, kf(t, [[0, 0], [0.55, 0.55], [1, 0]]));
    p.leg('R', kf(t, [[0, 0], [0.55, -0.25], [1, 0]]), 0, 0, kf(t, [[0, 0], [0.55, 0.45], [1, 0]]));
    p.root.y += kf(t, [[0, 0], [0.38, 0.02], [0.6, -0.1], [1, 0]]);
  } else {
    // Wide horizontal sweep with the whole torso.
    const a = kf(t, [[0, 0], [0.38, 1], [0.62, -1], [0.82, -1.1], [1, 0]]);
    p.arm('R', 1.2, 0.5 + a * 0.7, -0.4 * a, 0.9 - Math.abs(a) * 0.4, 0.3, 0, -0.4 * a);
    p.arm('L', 1.25, -0.2 - a * 0.5, 0.2 * a, 1.1 - Math.abs(a) * 0.4, 0.3, 0, 0.3 * a);
    p.spine(-0.15, a * 0.9, -a * 0.1);
    p.add('root', 0, a * 0.35, 0);
    p.leg('L', 0.2, 0.1, 0, 0.35);
    p.leg('R', -0.1, 0.1, 0, 0.3);
    p.root.y -= 0.05;
  }
}

function stab(p: Pose, t: number, c: ActionCtx) {
  const two = c.main === 'polearm' || c.main === 'staff' || c.main === 'twohand';
  const th = kf(t, [[0, 0], [0.3, -1], [0.48, 1], [0.7, 0.9], [1, 0]]);
  p.arm('R', 1.1 + th * 0.35, 0.25, -0.2, 1.4 - Math.max(0, th) * 1.25 + Math.max(0, -th) * 0.5, 0.5, 0.1);
  if (two) p.arm('L', 1.0 + th * 0.4, -0.25, 0.2, 1.3 - Math.max(0, th) * 0.6, 0.3);
  p.spine(-Math.max(0, th) * 0.25, -th * 0.25, 0);
  p.leg('L', Math.max(0, th) * 0.45, 0, 0, Math.max(0, th) * 0.45);
  p.leg('R', -Math.max(0, th) * 0.25, 0, 0, 0.2);
  p.root.z -= Math.max(0, th) * 0.12;
  p.root.y -= Math.max(0, th) * 0.04;
}

function slam(p: Pose, t: number) {
  const r = kf(t, [[0, 0], [0.4, 1], [0.6, -0.5], [0.85, -0.5], [1, 0]]);
  for (const s of ['R', 'L'] as const) p.arm(s, 1.0 + r * 1.9, 0.1, 0, 1.0 - r * 0.6, 0.3, 0.3 * r);
  p.spine(kf(t, [[0, 0], [0.4, 0.3], [0.6, -0.75], [0.85, -0.6], [1, 0]]));
  const crouch = kf(t, [[0, 0], [0.4, 0.1], [0.62, 0.8], [0.85, 0.7], [1, 0]]);
  p.leg('L', crouch * 0.7, 0.1, 0, crouch * 1.1, crouch * 0.4);
  p.leg('R', crouch * 0.5, 0.1, 0, crouch * 0.9, crouch * 0.4);
  p.root.y -= crouch * 0.18;
}

function punch(p: Pose, t: number, c: ActionCtx) {
  const side = c.variant % 2 ? 'L' : 'R';
  const other = side === 'R' ? 'L' : 'R';
  const h = kf(t, [[0, 0], [0.25, -0.3], [0.45, 1], [0.6, 1], [1, 0]]);
  p.arm(side, 0.9 + h * 0.65, 0.15, 0.3, 1.9 - Math.max(0, h) * 1.75, 1.2);
  p.arm(other, 0.9, 0.2, 0.2, 2.0, 1.0);
  p.spine(-0.1, (side === 'R' ? -1 : 1) * h * 0.35);
  p.leg('L', 0.25, 0.05, 0, 0.35);
  p.leg('R', -0.15, 0.05, 0, 0.3);
}

function kick(p: Pose, t: number) {
  const k = kf(t, [[0, 0], [0.3, 0.6], [0.5, 1], [0.65, 0.9], [1, 0]]);
  const ext = kf(t, [[0, 0], [0.3, 0], [0.5, 1], [0.65, 1], [0.85, 0], [1, 0]]);
  p.leg('R', k * 1.35, 0, 0, 1.6 * (1 - ext) * Math.min(1, k * 2) + 0.1, -0.3 * ext);
  p.leg('L', 0, 0, 0, k * 0.25);
  p.spine(k * 0.35);
  p.arm('L', 0.3, 0.5 * k, 0, 1.2);
  p.arm('R', -0.3 * k, 0.4 * k, 0, 0.9);
}

function block(p: Pose, t: number, c: ActionCtx) {
  const b = kf(t, [[0, 0], [0.15, 1], [0.85, 1], [1, 0]]);
  if (c.off === 'shield') {
    p.arm('L', 1.15 * b, 0.25 * b, 0.6 * b, 1.6 * b, 1.2 * b);
    p.arm('R', 0.6 * b, 0.3 * b, 0, 1.4 * b);
  } else if (c.main !== 'none') {
    // Weapon held horizontally across the body.
    p.arm('R', 1.4 * b, 0.45 * b, -0.6 * b, 1.6 * b, 0.9 * b, 0, -0.6 * b);
    if (c.main === 'twohand' || c.main === 'polearm' || c.main === 'staff') p.arm('L', 1.3 * b, 0.1 * b, 0.4 * b, 1.7 * b, 0.6 * b);
  } else {
    p.arm('R', 1.3 * b, 0.1 * b, 0, 2.2 * b, 1.2 * b);
    p.arm('L', 1.3 * b, 0.1 * b, 0, 2.2 * b, 1.2 * b);
  }
  p.spine(-0.15 * b);
  p.neck(-0.15 * b);
  p.leg('L', 0.3 * b, 0.05, 0, 0.45 * b);
  p.leg('R', -0.1 * b, 0.05, 0, 0.4 * b);
  p.root.y -= 0.05 * b;
}

function shootBow(p: Pose, t: number, c: ActionCtx) {
  const draw = kf(t, [[0, 0], [0.15, 0.3], [0.55, 1], [0.7, 1], [0.72, 0.2], [1, 0]]);
  const raise = kf(t, [[0, 0], [0.18, 1], [0.85, 1], [1, 0]]);
  const ap = c.aimPitch;
  // Bow arm (left) extended toward the target, string hand draws to the cheek.
  p.arm('L', (1.45 + ap) * raise, -0.15 * raise, 0.9 * raise, 0.05, 0.4 * raise);
  p.arm('R', (1.45 + ap) * raise, 0.55 * raise + draw * 0.3, -0.4 * raise, (0.6 + draw * 1.75) * raise, 0.6 * raise, 0, 0, 0.1 * draw);
  p.spine(0, 1.0 * raise, 0);
  p.neck(ap * 0.5 * raise, -0.95 * raise, 0);
}

function throwAct(p: Pose, t: number) {
  const a = kf(t, [[0, 0], [0.35, 1], [0.55, -0.6], [0.75, -0.5], [1, 0]]);
  p.arm('R', 1.2 + a * 1.4, 0.6 - Math.max(0, a) * 0.3, -0.5 * a, 1.3 + a * 0.4, 0.3, -0.4 * a);
  p.arm('L', 1.0 - a * 0.5, 0.3, 0, 0.6);
  p.spine(-Math.max(0, -a) * 0.3 + Math.max(0, a) * 0.1, a * 0.55, 0);
  p.leg('L', Math.max(0, -a) * 0.4, 0, 0, Math.max(0, -a) * 0.4);
}

function cast(p: Pose, t: number, c: ActionCtx, kind: 'forward' | 'up' | 'ground' | 'self') {
  const gather = kf(t, [[0, 0], [0.35, 1], [0.5, 0.2], [1, 0]]);
  const release = kf(t, [[0, 0], [0.35, 0], [0.5, 1], [0.8, 1], [1, 0]]);
  // Gather: hands come together in front of the chest.
  p.arm('R', 1.0 * gather, -0.2 * gather, 0.4 * gather, 1.8 * gather, 1.0 * gather);
  p.arm('L', 1.0 * gather, -0.2 * gather, 0.4 * gather, 1.8 * gather, 1.0 * gather);
  p.spine(0.08 * gather);
  if (kind === 'forward') {
    p.arm('R', (1.5 + c.aimPitch) * release, 0.2 * release, -0.4 * release, 0.15 * release, 0.6 * release, -0.9 * release);
    p.arm('L', 0.4 * release, 0.25 * release, 0, 1.0 * release);
    p.spine(-0.2 * release, -0.25 * release);
    p.leg('L', 0.35 * release, 0, 0, 0.4 * release);
  } else if (kind === 'up') {
    p.arm('R', 2.9 * release, 0.25 * release, 0, 0.2 * release);
    p.arm('L', 2.9 * release, 0.25 * release, 0, 0.2 * release);
    p.spine(0.2 * release);
    p.neck(0.45 * release);
  } else if (kind === 'ground') {
    p.arm('R', 0.9 * release, 0.4 * release, 0, 0.2 * release, 0, -1.0 * release);
    p.arm('L', 0.9 * release, 0.4 * release, 0, 0.2 * release, 0, -1.0 * release);
    p.spine(-0.55 * release);
    p.neck(-0.3 * release);
    p.leg('L', 0.6 * release, 0.1, 0, 1.2 * release, 0.5 * release);
    p.leg('R', 0.4 * release, 0.1, 0, 1.0 * release, 0.4 * release);
    p.root.y -= 0.22 * release;
  } else {
    // Self: hands to the heart, head bows, then opens.
    p.arm('R', 0.9 * release, -0.55 * release, 0.6 * release, 2.0 * release, 0.8 * release);
    p.arm('L', 0.9 * release, -0.55 * release, 0.6 * release, 2.0 * release, 0.8 * release);
    p.neck(-0.35 * release);
  }
}

function channel(p: Pose, t: number, c: ActionCtx) {
  const w = Math.min(1, c.elapsed * 3);
  const s = Math.sin(c.elapsed * 3.1) * 0.08;
  p.arm('R', (1.35 + c.aimPitch) * w, 0.25 * w + s, -0.3, 0.35 * w, 0.8 * w, -0.6 * w);
  p.arm('L', (1.25 + c.aimPitch) * w, 0.35 * w - s, -0.3, 0.45 * w, 0.8 * w, -0.6 * w);
  p.spine(-0.08 * w, 0, s * 0.3);
  p.leg('L', 0.25 * w, 0.05, 0, 0.35 * w);
  p.leg('R', -0.1 * w, 0.05, 0, 0.3 * w);
  void t;
}

/** A soldier aiming a rifle (held while firing): both arms forward, the head down to the sights, a slight recoil. */
function aimRifle(p: Pose, t: number, c: ActionCtx) {
  const w = Math.min(1, c.elapsed * 5);
  const kick = Math.max(0, Math.sin(c.elapsed * 31)) * 0.04;
  const ap = c.aimPitch;
  p.arm('R', (1.25 + ap) * w, 0.55 * w, -0.5 * w, 1.55 * w, 0.6 * w, 0, 0, kick);
  p.arm('L', (1.4 + ap) * w, -0.1 * w, 0.4 * w, 0.55 * w, 0.8 * w);
  p.spine(0.04 * w, 0.35 * w, 0);
  p.neck((ap * 0.6 + 0.12) * w, -0.3 * w, 0.1 * w);
  void t;
}

/** Aiming a pistol in both hands (officers, an armed robber): arms out straight, pitched to the target, a little recoil. */
function aimPistol(p: Pose, t: number, c: ActionCtx) {
  const w = Math.min(1, c.elapsed * 5);
  const kick = Math.max(0, Math.sin(c.elapsed * 23)) * 0.05;
  const ap = c.aimPitch;
  p.arm('R', (1.5 + ap) * w, 0.12 * w, -0.25 * w, (0.18 + kick) * w, 0.9 * w, -0.15 * w);
  p.arm('L', (1.45 + ap) * w, -0.32 * w, 0.3 * w, 0.42 * w, 0.9 * w, -0.1 * w);
  p.spine(0.02 * w, 0.12 * w, 0);
  p.neck((ap * 0.5 + 0.05) * w, -0.1 * w, 0);
  void t;
}

/** Repeating two-handed tool strokes (dig, chop, mine, hammer). */
function toolStroke(p: Pose, t: number, c: ActionCtx, kind: 'dig' | 'chop' | 'mine' | 'hammer' | 'saw') {
  const cycles = kind === 'hammer' ? Math.max(1, Math.round(c.dur / 0.6)) : kind === 'saw' ? Math.max(1, Math.round(c.dur / 0.7)) : 1;
  const u = (t * cycles) % 1;
  const env = kf(t, [[0, 0], [0.08, 1], [0.92, 1], [1, 0]]);
  if (kind === 'saw') {
    const a = Math.sin(u * PI * 2);
    p.arm('R', 0.9 + a * 0.25, 0.2, 0, 1.3 - a * 0.55, 0.6);
    p.arm('L', 0.7, 0.1, 0, 1.0, 0, 0, 0);
    p.spine(-0.45 * env, 0.15, 0);
    p.leg('L', 0.4 * env, 0, 0, 0.5 * env);
    p.root.y -= 0.06 * env;
    return;
  }
  if (kind === 'dig') {
    const a = kf(u, [[0, 0], [0.3, -0.4], [0.5, 0.9], [0.75, 0.4], [1, 0]]);
    p.arm('R', 0.9 + a * 0.6, 0.2, 0, 1.0 - a * 0.3, 0.4);
    p.arm('L', 0.6 + a * 0.5, -0.1, 0, 0.8, 0.2);
    p.spine(-0.5 + a * 0.35, 0.2, 0);
    p.leg('L', 0.5, 0.1, 0, 0.7, 0.3);
    p.leg('R', 0.1, 0.1, 0, 0.5, 0.2);
    p.root.y -= 0.1 * env;
    return;
  }
  // chop / mine / hammer: raise and strike.
  const r = kf(u, [[0, 0], [0.42, 1], [0.6, -0.3], [0.78, -0.25], [1, 0]]);
  const low = kind === 'mine' ? -0.25 : kind === 'chop' ? 0 : -0.5;
  const two = kind !== 'hammer';
  p.arm('R', 0.9 + r * 1.8 + low * 0.5, 0.25, -0.2, 1.3 - r * 0.5, 0.3, 0.5 * r);
  if (two) p.arm('L', 0.8 + r * 1.6 + low * 0.5, -0.05, 0.2, 1.3 - r * 0.4, 0.3, 0.4 * r);
  else p.arm('L', 0.8, 0.2, 0, 1.5, 0.6);
  p.spine((kind === 'chop' ? -0.1 : -0.3) + r * 0.25 - Math.max(0, -r) * 0.4, kind === 'chop' ? 0.35 * r : 0.15, 0);
  p.leg('L', 0.3, 0.1, 0, 0.4);
  p.leg('R', -0.1, 0.1, 0, 0.3);
  p.root.y -= 0.04 * env;
}

function harvest(p: Pose, t: number) {
  const d = kf(t, [[0, 0], [0.25, 1], [0.8, 1], [1, 0]]);
  const pick = Math.sin(t * PI * 6) * 0.15 * d;
  p.leg('L', 1.25 * d, 0.15, 0, 2.0 * d, 0.7 * d);
  p.leg('R', 0.5 * d, 0.15, 0, 2.3 * d, 0.2 * d, 0.6 * d);
  p.spine(-0.55 * d);
  p.neck(-0.3 * d);
  p.arm('R', (0.9 + pick) * d, 0.1, 0, 0.6 * d, 0.5);
  p.arm('L', 0.5 * d, 0.1, 0, 0.9 * d);
  p.root.y -= 0.5 * d;
}

function pickup(p: Pose, t: number) {
  const d = kf(t, [[0, 0], [0.45, 1], [0.6, 1], [1, 0]]);
  p.spine(-0.9 * d);
  p.neck(-0.2 * d);
  p.leg('L', 0.9 * d, 0, 0, 1.4 * d, 0.5 * d);
  p.leg('R', 0.8 * d, 0, 0, 1.3 * d, 0.5 * d);
  p.arm('R', 1.0 * d, 0.1, 0, 0.3 * d);
  p.arm('L', 0.3 * d, 0.2, 0, 0.5 * d);
  p.root.y -= 0.32 * d;
}

function eatDrink(p: Pose, t: number, drink: boolean) {
  const lift = kf(t, [[0, 0], [0.25, 1], [0.85, 1], [1, 0]]);
  const chew = drink ? 0 : Math.sin(t * 40) * 0.08 * lift;
  p.arm('R', 0.65 * lift + chew, -0.45 * lift, 0.6 * lift, 2.25 * lift, 0.9 * lift, drink ? -0.3 * lift : 0);
  p.neck(drink ? kf(t, [[0, 0], [0.3, 0], [0.5, 0.45], [0.8, 0.45], [1, 0]]) : -0.1 * lift);
}

function wave(p: Pose, t: number) {
  const up = kf(t, [[0, 0], [0.2, 1], [0.85, 1], [1, 0]]);
  const w = Math.sin(t * PI * 8) * 0.35 * up;
  p.arm('R', 0.6 * up, 1.9 * up, 0.9 * up, 1.4 * up + w * 0.3, 1.0 * up, 0, w);
  p.spine(0, 0, 0.06 * up);
  p.neck(0.05 * up, 0, -0.08 * up);
}

function point(p: Pose, t: number, c: ActionCtx) {
  const u = kf(t, [[0, 0], [0.25, 1], [0.8, 1], [1, 0]]);
  p.arm('R', (1.5 + c.aimPitch) * u, 0.25 * u, 0, 0.1 * u, 0.8 * u);
  p.neck(c.aimPitch * 0.3 * u);
}

function shrug(p: Pose, t: number) {
  const u = kf(t, [[0, 0], [0.3, 1], [0.7, 1], [1, 0]]);
  p.arm('R', 0.4 * u, 0.35 * u, -0.9 * u, 1.5 * u, -1.0 * u, 0, 0, 0.25 * u);
  p.arm('L', 0.4 * u, 0.35 * u, -0.9 * u, 1.5 * u, -1.0 * u, 0, 0, 0.25 * u);
  p.neck(0, 0, 0.18 * u);
}

function bowAct(p: Pose, t: number) {
  const b = kf(t, [[0, 0], [0.35, 1], [0.65, 1], [1, 0]]);
  p.spine(-0.85 * b);
  p.neck(-0.3 * b);
  p.arm('R', 0.6 * b, -0.4 * b, 0.4 * b, 1.8 * b, 0.6 * b);
  p.arm('L', -0.3 * b, 0.05, 0, 0.2 * b);
  p.leg('L', 0.3 * b, 0, 0, 0.15 * b);
  p.leg('R', 0.3 * b, 0, 0, 0.15 * b);
}

function talk(p: Pose, t: number, c: ActionCtx) {
  // Conversational gestures: hands open and close, slight head nods.
  const e = c.elapsed;
  const g = 0.5 + 0.5 * Math.sin(e * 2.3);
  const h = 0.5 + 0.5 * Math.sin(e * 1.7 + 1.3);
  p.arm('R', 0.5 + g * 0.35, 0.15 + g * 0.2, 0.6, 1.3 + g * 0.3, 1.0, 0, 0.2 * g);
  p.arm('L', 0.35 + h * 0.3, 0.12 + h * 0.15, 0.6, 1.1 + h * 0.3, 1.0, 0, 0.2 * h);
  p.neck(Math.sin(e * 3.1) * 0.05, Math.sin(e * 0.9) * 0.12);
  void t;
}

function pray(p: Pose, t: number) {
  const k = kf(t, [[0, 0], [0.2, 1], [0.85, 1], [1, 0]]);
  // Kneel on both knees, hands together.
  p.leg('L', 0.1 * k, 0.05, 0, 2.3 * k, 0.9 * k);
  p.leg('R', 0.1 * k, 0.05, 0, 2.3 * k, 0.9 * k);
  p.spine(-0.15 * k);
  p.neck(-0.45 * k);
  p.arm('R', 0.8 * k, -0.6 * k, 0.6 * k, 2.1 * k, 0.4 * k, 0.4 * k);
  p.arm('L', 0.8 * k, -0.6 * k, 0.6 * k, 2.1 * k, 0.4 * k, 0.4 * k);
  p.root.y -= 0.42 * k;
  p.root.z += 0.12 * k;
}

function sitAct(p: Pose, t: number) {
  const k = kf(t, [[0, 0], [0.25, 1], [0.9, 1], [1, 1]]);
  sitPose(p, k);
}

/** Sitting on the ground, knees up, forearms resting on the knees. */
export function sitPose(p: Pose, k: number) {
  // Thighs ~35° above horizontal, shins down to the ground, feet flat.
  p.leg('L', 2.15 * k, 0.22 * k, 0.25 * k, 1.95 * k, 0.2 * k);
  p.leg('R', 2.15 * k, 0.22 * k, 0.25 * k, 1.95 * k, 0.2 * k);
  p.spine(-0.25 * k);
  p.neck(-0.15 * k);
  // Forearms resting on the knees.
  p.arm('R', 0.75 * k, 0.12 * k, 0.2 * k, 1.1 * k, 0.6 * k, -0.4 * k);
  p.arm('L', 0.75 * k, 0.12 * k, 0.2 * k, 1.1 * k, 0.6 * k, -0.4 * k);
}

function dance(p: Pose, t: number, c: ActionCtx) {
  const e = c.elapsed * 2.2 * PI;
  const s = Math.sin(e), s2 = Math.sin(e * 2);
  p.root.y += Math.abs(s2) * 0.05 - 0.04;
  p.add('root', 0, s * 0.25, s * 0.05);
  p.spine(0.05, -s * 0.3, s * 0.15);
  p.neck(0, s * 0.2, -s * 0.15);
  p.arm('R', 0.8 + s * 0.6, 0.6 + s2 * 0.3, 0, 1.2 + s * 0.4, 0.4);
  p.arm('L', 0.8 - s * 0.6, 0.6 - s2 * 0.3, 0, 1.2 - s * 0.4, 0.4);
  p.leg('L', Math.max(0, s) * 0.6, 0.1, 0, Math.max(0, s) * 1.0 + 0.15);
  p.leg('R', Math.max(0, -s) * 0.6, 0.1, 0, Math.max(0, -s) * 1.0 + 0.15);
  void t;
}

function cheer(p: Pose, t: number) {
  const u = kf(t, [[0, 0], [0.2, 1], [0.85, 1], [1, 0]]);
  const pump = Math.sin(t * PI * 6) * 0.25 * u;
  p.arm('R', (2.6 + pump) * u, 0.35 * u, 0, (0.6 - pump) * u, 1.0 * u);
  p.arm('L', (2.6 - pump) * u, 0.35 * u, 0, (0.6 + pump) * u, 1.0 * u);
  p.neck(0.3 * u);
  p.root.y += Math.max(0, Math.sin(t * PI * 6)) * 0.06 * u;
}

function flinch(p: Pose, t: number) {
  const f = kf(t, [[0, 0], [0.12, 1], [0.4, 0.8], [1, 0]]);
  p.spine(-0.3 * f, 0.15 * f, 0);
  p.neck(-0.35 * f, 0.25 * f);
  p.arm('R', 1.0 * f, 0.2 * f, 0.4 * f, 1.9 * f, 1.0 * f);
  p.arm('L', 1.2 * f, 0.2 * f, 0.4 * f, 2.0 * f, 1.0 * f);
  p.leg('L', 0.2 * f, 0, 0, 0.35 * f);
  p.leg('R', 0.15 * f, 0, 0, 0.3 * f);
}

/** Forward roll (fallback for the Roll clip): tuck, turn over the shoulders, come up. */
function roll(p: Pose, t: number) {
  const tuck = kf(t, [[0, 0], [0.2, 1], [0.75, 1], [1, 0]]);
  const turn = kf(t, [[0, 0], [0.15, 0], [0.75, 1], [1, 1]]);
  p.add('root', -PI * 2 * turn, 0, 0);
  p.root.y -= 0.45 * tuck;
  p.spine(-0.8 * tuck);
  p.neck(-0.6 * tuck);
  for (const s of ['L', 'R'] as const) {
    p.arm(s, 1.2 * tuck, 0.3 * tuck, 0, 1.4 * tuck);
    p.leg(s, 1.6 * tuck, 0.1 * tuck, 0, 2.2 * tuck, 0.4 * tuck);
  }
}

function stagger(p: Pose, t: number, c: ActionCtx) {
  const f = kf(t, [[0, 0], [0.15, 1], [0.5, 0.7], [1, 0]]);
  const wob = Math.sin(c.elapsed * 9) * 0.12 * f;
  p.spine(0.35 * f, wob, 0.2 * f);
  p.neck(0.3 * f, 0, -0.2 * f);
  p.arm('R', 0.4 * f, 0.9 * f, 0, 0.5 * f);
  p.arm('L', 0.7 * f, 1.1 * f, 0, 0.4 * f);
  p.leg('L', -0.35 * f, 0.15 * f, 0, 0.5 * f);
  p.leg('R', 0.45 * f, 0.1 * f, 0, 0.9 * f);
  p.root.z += 0.12 * f;
  p.root.y -= 0.06 * f;
}

/** Hands up (surrender, held at gunpoint): long plateau, so a long `dur` holds the pose. */
function handsUp(p: Pose, t: number) {
  const u = kf(t, [[0, 0], [0.04, 1], [0.97, 1], [1, 0]]);
  p.arm('R', 2.45 * u, 0.55 * u, 0, 1.5 * u, 0.6 * u);
  p.arm('L', 2.45 * u, 0.55 * u, 0, 1.5 * u, 0.6 * u);
  p.neck(-0.1 * u);
}

/** Cowering: crouched, head down, arms up over the head. */
function cower(p: Pose, t: number) {
  const u = kf(t, [[0, 0], [0.08, 1], [0.95, 1], [1, 0]]);
  p.leg('L', 1.1 * u, 0.05, 0, 1.9 * u, 0.75 * u);
  p.leg('R', 1.0 * u, 0.05, 0, 1.8 * u, 0.7 * u);
  p.spine(0.55 * u);
  p.neck(0.45 * u);
  p.arm('R', 2.0 * u, 0.3 * u, 0.3 * u, 2.0 * u, 1.0 * u);
  p.arm('L', 2.0 * u, 0.3 * u, 0.3 * u, 2.0 * u, 1.0 * u);
  p.root.y -= 0.42 * u;
  p.root.z += 0.08 * u;
}

// ------------------------------------------------------------------ street characters (game/street)

/**
 * Strumming a guitar slung across the chest (humanoid/client/streetwear.ts): the left hand wraps
 * the neck and moves between chord positions, the right hand strums across the strings over the
 * sound hole. The arms are posed to set the elbows (left forward under the neck, right resting
 * on the upper edge of the body); `reach` puts the hands on the guitar's anchors by IK.
 */
function playGuitar(p: Pose, _t: number, c: ActionCtx) {
  const e = c.elapsed;
  const strum = Math.sin(e * PI * 4.2);
  p.arm('L', 1.0, 0.45, 0.2, 1.45, 0.3, -0.35, 0.25);
  p.arm('R', 0.55, 0.8, 0, 1.5 + strum * 0.06, -0.5, -0.4 + strum * 0.3, 0.1);
  p.spine(-0.06, 0.08, Math.sin(e * 2.1) * 0.03);
  p.neck(-0.3 + Math.abs(Math.sin(e * PI * 2.1)) * 0.07, 0.2);
}

/** Chord positions up the neck (anchor-frame y, m), changed every two bars. */
const GUITAR_CHORDS = [0, -0.07, 0.05, -0.03];

function guitarReach(c: ActionCtx): Partial<Record<'L' | 'R', HandReach>> {
  const e = c.elapsed;
  const bar = e / 1.9;
  const i = Math.floor(bar), f = bar - i;
  // Slide quickly to the next chord at the end of each bar, hold it otherwise.
  const a = GUITAR_CHORDS[i % GUITAR_CHORDS.length], b = GUITAR_CHORDS[(i + 1) % GUITAR_CHORDS.length];
  const fret = a + (b - a) * kf(f, [[0, 0], [0.88, 0], [1, 1]]);
  // Down-up strokes across the strings (x), the hand just in front of them (z).
  const strum = Math.sin(e * PI * 4.2);
  return {
    L: { anchor: 'reach:fret', x: 0.03, y: fret, z: -0.012, pole: [0.5, -1, 0.1] },
    R: { anchor: 'reach:strum', x: strum * 0.065, y: 0, z: 0.045 - Math.abs(strum) * 0.01, pole: [1, 0.5, 1] },
  };
}

/** The doomsayer: a finger to the sky, arms flung wide, a finger at the crowd (a 7 s cycle). */
function preach(p: Pose, _t: number, c: ActionCtx) {
  const u = (c.elapsed % 7) / 7;
  const sky = kf(u, [[0, 0], [0.06, 1], [0.32, 1], [0.38, 0], [1, 0]]);
  const wide = kf(u, [[0.32, 0], [0.4, 1], [0.62, 1], [0.68, 0]]);
  const at = kf(u, [[0.62, 0], [0.7, 1], [0.94, 1], [1, 0]]);
  const shake = Math.sin(c.elapsed * 9) * 0.05;
  p.arm('R', 2.75 * sky + 1.15 * wide + 1.45 * at + shake, 0.25 * sky + 1.25 * wide + 0.2 * at, 0, 0.12 * sky + 0.3 * wide + 0.1 * at, 0.8 * at);
  p.arm('L', 0.65 * sky + 1.15 * wide + 0.35 * at, 0.35 * sky + 1.25 * wide + 0.15 * at, 0.4 * sky, 1.1 * sky + 0.3 * wide + 1.3 * at, 0.9 * sky);
  p.spine(0.1 * sky - 0.08 * at, 0, 0);
  p.neck(0.35 * sky + 0.1 * wide - 0.05 * at, 0, 0);
}

/** A mime in an invisible box: palms on the front wall, then the side, then the ceiling (a 9 s cycle). */
function mimeBox(p: Pose, _t: number, c: ActionCtx) {
  const e = c.elapsed, u = (e % 9) / 9;
  const front = kf(u, [[0, 1], [0.3, 1], [0.38, 0], [0.92, 0], [1, 1]]);
  const side = kf(u, [[0.3, 0], [0.38, 1], [0.6, 1], [0.68, 0]]);
  const top = kf(u, [[0.6, 0], [0.68, 1], [0.9, 1], [0.97, 0]]);
  // Palms flat on the glass, sliding along it.
  const sl = Math.sin(e * 1.7) * 0.18, sr = Math.sin(e * 1.7 + 1.9) * 0.18;
  p.arm('L', (1.3 + sl) * front + 1.1 * side + 2.55 * top, 0.12 * front + 0.2 * side + 0.35 * top, -0.2 * front, 0.65 * front + 0.9 * side + 0.55 * top, 1.0 * front + 1.0 * side, -1.05 * (front + side + top), 0);
  p.arm('R', (1.3 + sr) * front + 0.2 * side + 2.55 * top, 0.12 * front + 1.45 * side + 0.35 * top, -0.2 * front - 0.3 * side, 0.65 * front + 0.4 * side + 0.55 * top, 1.0 * front + 0.6 * side, -1.05 * (front + side + top), 0.6 * side);
  p.spine(0.02 * front, -0.25 * side, 0);
  p.neck(0.25 * top - 0.05 * front, -0.55 * side, 0.08 * Math.sin(e * 0.8));
}

/** Juggling a cascade: forearms forward, hands tossing in turn, eyes up on the balls. */
function juggle(p: Pose, _t: number, c: ActionCtx) {
  const e = c.elapsed * PI * 2 * 1.25;
  const l = Math.max(0, Math.sin(e)), r = Math.max(0, Math.sin(e + PI));
  p.arm('L', 0.55 + l * 0.18, 0.12, 0.35, 1.45 - l * 0.35, 1.3, -0.2 + l * 0.4);
  p.arm('R', 0.55 + r * 0.18, 0.12, 0.35, 1.45 - r * 0.35, 1.3, -0.2 + r * 0.4);
  p.neck(0.3, Math.sin(e * 0.5) * 0.06);
}

/** A living statue, frozen: one arm pointing at the horizon, the other hand on the hip. */
function statueSalute(p: Pose) {
  p.arm('R', 2.05, 0.25, 0, 0.08, 0.6);
  p.arm('L', -0.15, 0.55, -0.7, 1.75, 0.2, 0.3);
  p.leg('L', 0.25, 0.04, 0, 0.12);
  p.leg('R', -0.12, 0.04);
  p.spine(0.05, -0.15);
  p.neck(0.22, -0.25);
}

/** A living statue, frozen: the thinker, chin on the hand, standing. */
function statueThinker(p: Pose) {
  p.arm('R', 1.25, -0.15, 0.55, 2.3, 0.6, 0.25);
  p.arm('L', 0.3, 0.05, 1.0, 1.75, 0.5);
  p.leg('L', 0.15, 0.02, 0, 0.08);
  p.leg('R', -0.08, 0.02);
  p.spine(-0.12);
  p.neck(-0.3, 0.1);
}

/** Scattering crumbs from a bag held at the belly. */
function feedBirds(p: Pose, _t: number, c: ActionCtx) {
  const u = (c.elapsed % 2.6) / 2.6;
  const reach = kf(u, [[0, 0], [0.3, 0], [0.5, 1], [0.62, 1], [0.85, 0], [1, 0]]);
  p.arm('L', 0.5, 0.05, 0.4, 1.65, 1.0);
  p.arm('R', 0.45 + reach * 0.7, 0.05 + reach * 0.5, 0.4, 1.4 - reach * 1.05, 0.9 - reach * 0.5, reach * -0.4);
  p.spine(-0.18 - reach * 0.08);
  p.neck(-0.35);
}

/** Sleepwalking: both arms out in front, wrists limp, the head lolling. */
function sleepwalk(p: Pose, _t: number, c: ActionCtx) {
  const e = c.elapsed;
  p.arm('L', 1.45 + Math.sin(e * 1.1) * 0.05, 0.1, 0, 0.12, 0.3, 0.55);
  p.arm('R', 1.45 + Math.sin(e * 1.1 + 1) * 0.05, 0.1, 0, 0.12, 0.3, 0.55);
  p.neck(0.12, Math.sin(e * 0.5) * 0.15, 0.22 + Math.sin(e * 0.7) * 0.06);
}

/** Holding a big map open in front of the chest, looking down at it (now and then up and around). */
function readMap(p: Pose, _t: number, c: ActionCtx) {
  const u = (c.elapsed % 8) / 8;
  const up = kf(u, [[0, 0], [0.7, 0], [0.76, 1], [0.92, 1], [1, 0]]);
  p.arm('L', 0.95, 0.42, 0.35, 1.25, 0.35, 0.2);
  p.arm('R', 0.95, 0.42, 0.35, 1.25, 0.35, 0.2);
  p.neck(-0.45 + up * 0.5, up * Math.sin(c.elapsed * 0.9) * 0.7);
}

/** Holding something out to a passer-by (a flyer). */
function offer(p: Pose, t: number) {
  const u = kf(t, [[0, 0], [0.2, 1], [0.8, 1], [1, 0]]);
  p.arm('R', 1.25 * u, 0.15 * u, 0.4 * u, 0.3 * u, 0.4 * u);
  p.spine(-0.05 * u, -0.1 * u);
}

/** A press photographer: the camera up at the eye in both hands (a 3 s cycle: down a moment, up, shoot). */
function takePhoto(p: Pose, _t: number, c: ActionCtx) {
  const u = (c.elapsed % 3) / 3;
  const up = kf(u, [[0, 0.35], [0.12, 1], [0.85, 1], [1, 0.35]]);
  p.arm('R', 1.45 * up, -0.35 * up, 0.3 * up, 1.9 * up, 0.5 * up);
  p.arm('L', 1.3 * up, -0.8 * up, -0.2 * up, 1.6 * up, -0.2 * up);
  p.neck(-0.05 * up, 0, 0);
}

/** A camera operator: the TV camera on the right shoulder, the left hand on the lens. */
function shoulderCam(p: Pose, _t: number, c: ActionCtx) {
  const sway = Math.sin(c.elapsed * 0.9) * 0.04;
  p.arm('R', 1.05 + sway, 0.75, -0.6, 2.35, 0.6, 0.2);
  p.arm('L', 1.45 + sway, -0.05, 0.4, 1.0, -0.4, 0.1);
  p.neck(0, 0.12, 0);
}

/** A TV reporter: the microphone held out to whoever speaks, the other hand talking. */
function interview(p: Pose, _t: number, c: ActionCtx) {
  const e = c.elapsed, g = 0.5 + 0.5 * Math.sin(e * 2.1);
  p.arm('R', 1.2, 0.2, -0.2, 0.9, 0.9, 0.3);
  p.arm('L', 0.4 + g * 0.3, 0.15 + g * 0.15, 0.6, 1.2 + g * 0.3, 1.0, 0, 0.2 * g);
  p.neck(Math.sin(e * 2.7) * 0.05, Math.sin(e * 0.8) * 0.1);
}

/** A protester: the placard up high in the right hand (as the raised torch), the left fist pumping. */
function chant(p: Pose, _t: number, c: ActionCtx) {
  const e = c.elapsed, beat = Math.max(0, Math.sin(e * PI * 1.6));
  p.arm('R', 1.7 + beat * 0.12, 0.5, -0.4, 0.45 - beat * 0.1, 0.3, -0.9, -0.4);
  p.arm('L', 1.9 + beat * 0.6, 0.3, 0, 1.6 - beat * 0.9, 0.6);
  p.neck(0.15 + beat * 0.1, 0, 0);
  p.root.y += beat * 0.03;
}

/** The hero's statue: chest out, one fist raised to the sky, the other on the hip, a stride. */
function heroPose(p: Pose) {
  p.arm('R', 2.75, 0.35, 0, 0.15, 0.6);
  p.arm('L', -0.1, 0.65, -0.9, 1.9, 0.2, 0.3);
  p.leg('L', 0.3, 0.06, 0, 0.15);
  p.leg('R', -0.15, 0.06);
  p.spine(-0.08, 0.1);
  p.neck(0.3, -0.15);
}

export const ACTIONS: Record<string, ActionDef> = {
  hands_up: { mask: 'upper', blendIn: 0.15, blendOut: 0.2, pose: handsUp, mood: 'afraid' },
  cower: { mask: 'full', blendIn: 0.2, blendOut: 0.25, pose: cower, mood: 'afraid' },
  // Forehand cuts use the sword clip; backhands and heavy chops stay procedural for variety.
  swing_1h: { mask: 'upper', blendIn: 0.05, blendOut: 0.15, pose: swing1h, mood: 'angry', clip: (c) => (c.variant % 2 === 0 && c.main !== 'axe' && c.main !== 'blunt' ? { name: 'Sword_Attack', from: 0.12, to: 0.72 } : null) },
  swing_2h: { mask: 'full', blendIn: 0.05, blendOut: 0.15, pose: swing2h, mood: 'angry' },
  stab: { mask: 'full', blendIn: 0.05, blendOut: 0.15, pose: stab, mood: 'focused' },
  slam: { mask: 'full', blendIn: 0.06, blendOut: 0.15, pose: slam, mood: 'angry' },
  punch: { mask: 'upper', blendIn: 0.05, blendOut: 0.15, pose: punch, mood: 'angry', clip: (c) => (c.main === 'none' ? { name: c.variant % 2 ? 'Punch_Cross' : 'Punch_Jab' } : null) },
  kick: { mask: 'full', blendIn: 0.06, blendOut: 0.15, pose: kick, mood: 'angry' },
  block: { mask: 'upper', blendIn: 0.08, blendOut: 0.1, pose: block, mood: 'focused' },
  shoot_bow: { mask: 'upper', blendIn: 0.08, blendOut: 0.12, pose: shootBow, mood: 'focused' },
  throw: { mask: 'upper', blendIn: 0.05, blendOut: 0.15, pose: throwAct },
  cast_forward: { mask: 'upper', blendIn: 0.08, blendOut: 0.15, pose: (p, t, c) => cast(p, t, c, 'forward'), mood: 'focused', clip: (c) => (c.main === 'none' || c.main === 'wand' ? { name: 'Spell_Simple_Shoot' } : null) },
  cast_up: { mask: 'upper', blendIn: 0.08, blendOut: 0.15, pose: (p, t, c) => cast(p, t, c, 'up'), mood: 'focused' },
  cast_ground: { mask: 'full', blendIn: 0.08, blendOut: 0.15, pose: (p, t, c) => cast(p, t, c, 'ground'), mood: 'focused' },
  cast_self: { mask: 'upper', blendIn: 0.08, blendOut: 0.15, pose: (p, t, c) => cast(p, t, c, 'self'), mood: 'focused' },
  aim_rifle: { mask: 'upper', blendIn: 0.08, blendOut: 0.1, pose: aimRifle, mood: 'focused', loop: true },
  aim_pistol: { mask: 'upper', blendIn: 0.1, blendOut: 0.12, pose: aimPistol, mood: 'focused', loop: true },
  channel: { mask: 'upper', blendIn: 0.1, blendOut: 0.1, pose: channel, mood: 'focused', loop: true, clip: (c) => (c.main === 'none' || c.main === 'wand' ? { name: 'Spell_Simple_Idle_Loop' } : null) },
  dig: { mask: 'full', blendIn: 0.08, blendOut: 0.1, pose: (p, t, c) => toolStroke(p, t, c, 'dig'), mood: 'focused' },
  chop: { mask: 'upper', blendIn: 0.08, blendOut: 0.1, pose: (p, t, c) => toolStroke(p, t, c, 'chop'), mood: 'focused' },
  mine: { mask: 'upper', blendIn: 0.08, blendOut: 0.1, pose: (p, t, c) => toolStroke(p, t, c, 'mine'), mood: 'focused' },
  harvest: { mask: 'full', blendIn: 0.1, blendOut: 0.12, pose: harvest },
  pickup: { mask: 'full', blendIn: 0.1, blendOut: 0.15, pose: pickup },
  eat: { mask: 'arms', blendIn: 0.1, blendOut: 0.15, pose: (p, t) => eatDrink(p, t, false), mood: 'happy' },
  drink: { mask: 'upper', blendIn: 0.1, blendOut: 0.15, pose: (p, t) => eatDrink(p, t, true) },
  gesture_wave: { mask: 'arms', blendIn: 0.1, blendOut: 0.15, pose: wave, mood: 'happy' },
  gesture_point: { mask: 'arms', blendIn: 0.1, blendOut: 0.15, pose: point },
  gesture_shrug: { mask: 'upper', blendIn: 0.12, blendOut: 0.15, pose: shrug, mood: 'surprised' },
  bow: { mask: 'full', blendIn: 0.12, blendOut: 0.15, pose: bowAct },
  talk: { mask: 'arms', blendIn: 0.15, blendOut: 0.15, pose: talk, loop: true, clip: (c) => (c.main === 'none' && c.off === 'none' ? { name: 'Idle_Talking_Loop' } : null) },
  work_hammer: { mask: 'upper', blendIn: 0.1, blendOut: 0.1, pose: (p, t, c) => toolStroke(p, t, c, 'hammer'), mood: 'focused' },
  work_saw: { mask: 'upper', blendIn: 0.1, blendOut: 0.1, pose: (p, t, c) => toolStroke(p, t, c, 'saw'), mood: 'focused' },
  pray: { mask: 'full', blendIn: 0.12, blendOut: 0.12, pose: pray, mood: 'sad' },
  sit: { mask: 'full', blendIn: 0.15, blendOut: 0.1, pose: sitAct },
  sleep: { mask: 'full', blendIn: 0.15, blendOut: 0.1, pose: () => {} },
  dance: { mask: 'full', blendIn: 0.1, blendOut: 0.1, pose: dance, mood: 'happy', loop: true, clip: () => ({ name: 'Dance_Loop' }) },
  cheer: { mask: 'upper', blendIn: 0.08, blendOut: 0.15, pose: cheer, mood: 'happy' },
  flinch: { mask: 'upper', blendIn: 0.02, blendOut: 0.3, pose: flinch, mood: 'pain', clip: (c) => ({ name: c.variant % 2 ? 'Hit_Head' : 'Hit_Chest' }) },
  stagger: { mask: 'full', blendIn: 0.03, blendOut: 0.3, pose: stagger, mood: 'pain', clip: () => ({ name: 'Hit_Chest' }) },
  roll: { mask: 'full', blendIn: 0.05, blendOut: 0.15, pose: roll, clip: () => ({ name: 'Roll', from: 0.04, to: 0.8 }) },
  die: { mask: 'full', blendIn: 0.02, blendOut: 0, pose: () => {}, mood: 'pain' },
  // Street characters (game/street).
  play_guitar: { mask: 'upper', blendIn: 0.15, blendOut: 0.15, pose: playGuitar, mood: 'happy', loop: true, reach: guitarReach, curl: { L: 1.0, R: 0.75 } },
  preach: { mask: 'upper', blendIn: 0.12, blendOut: 0.15, pose: preach, mood: 'angry', loop: true },
  mime_box: { mask: 'upper', blendIn: 0.12, blendOut: 0.15, pose: mimeBox, mood: 'surprised', loop: true },
  juggle: { mask: 'upper', blendIn: 0.12, blendOut: 0.15, pose: juggle, mood: 'focused', loop: true },
  statue_salute: { mask: 'full', blendIn: 0.1, blendOut: 0.1, pose: statueSalute, loop: true },
  statue_thinker: { mask: 'full', blendIn: 0.1, blendOut: 0.1, pose: statueThinker, loop: true },
  feed_birds: { mask: 'upper', blendIn: 0.15, blendOut: 0.15, pose: feedBirds, mood: 'happy', loop: true },
  sleepwalk: { mask: 'upper', blendIn: 0.15, blendOut: 0.15, pose: sleepwalk, loop: true },
  read_map: { mask: 'upper', blendIn: 0.15, blendOut: 0.15, pose: readMap, loop: true },
  offer: { mask: 'arms', blendIn: 0.12, blendOut: 0.15, pose: offer, mood: 'happy' },
  take_photo: { mask: 'upper', blendIn: 0.1, blendOut: 0.12, pose: takePhoto, mood: 'focused', loop: true },
  shoulder_cam: { mask: 'upper', blendIn: 0.12, blendOut: 0.15, pose: shoulderCam, mood: 'focused', loop: true },
  interview: { mask: 'arms', blendIn: 0.12, blendOut: 0.15, pose: interview, mood: 'happy', loop: true },
  chant: { mask: 'upper', blendIn: 0.12, blendOut: 0.15, pose: chant, mood: 'angry', loop: true },
  hero_pose: { mask: 'full', blendIn: 0.1, blendOut: 0.1, pose: heroPose, mood: 'happy', loop: true },
};
