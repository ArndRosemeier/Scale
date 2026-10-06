/**
 * Going down a manhole and coming back up, played out instead of a jump cut:
 *
 *  down: walk to the lid, squat, lift its edge and drag it aside, turn the back to the hole,
 *        lower oneself over the edge onto the ladder and climb down to the walkway;
 *  up:   walk to the foot of the ladder, climb, push the lid up and aside if it is on, climb
 *        out over the edge onto the street and stand up.
 *
 * The body is the player's puppet: the scene sets its place and facing, poses it through the
 * animator's override and puts hands and feet on rungs, the street and the lid (Animator.limbs).
 * The camera follows in the street, looks down the shaft from above while the hero is in it and
 * watches from inside the sewer below the vault.
 *
 * Geometry (shaft, ladder, lid place) comes from the underground's manholes (layout.ts):
 * `lat` across the trunk on the shaft's side, `ds` along it, heights over the walkway.
 */
import * as THREE from 'three';
import type { Player } from '../player/Player';
import type { CameraRig } from '../player/CameraRig';
import type { Input } from './Input';
import type { Underground } from '../underground/Underground';
import { shaftPoint, LID_LAT, LADDER_LAT, LADDER_HW, RUNG, SEWER_HW, SHAFT_IN, type ManholeSpot } from '../underground/layout';
import { kf, smooth, clamp, type Pose } from '../humanoid/client/anim/pose';
import type { LimbGoals } from '../humanoid/client/anim/Animator';
import { manholeCoverMap } from '../props/furniture';

export interface ManholeHost {
  player: Player;
  camRig: CameraRig;
  camera: THREE.PerspectiveCamera;
  input: Input;
  underground: Underground;
  /** Where the loose lids lie. */
  scene: THREE.Object3D;
  /** The street's lid prop goes (the scene draws its own, moving one). */
  hideLid: (x: number, z: number) => void;
  sound: (id: string, x: number, y: number, z: number, gain: number, pitch: number) => void;
}

type CamMode = 'orbit' | 'shaft' | 'tube';

interface Segment {
  dur: number;
  /** u: 0..1 through the segment. */
  run: (u: number, dt: number) => void;
}

const LID_R = 0.33, LID_T = 0.04;
/** Climbing speed on the ladder (m/s at 1.8 m, × √k like every gait). */
const CLIMB_V = 0.95;
/** Two rungs: a limb's step (hands and feet leapfrog in pairs). */
const STEP = 2 * RUNG;
/** Where the hero stands on the street beside the hole (across the trunk, past the ladder's wall). */
const STREET_LAT = SEWER_HW + 0.42;
/** Where an opened lid ends up: beside the hole on the street. */
const LID_DEST_LAT = LID_LAT + 0.15, LID_DEST_DS = 0.98;

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(0, 1, 0), _z = new THREE.Vector3();
const Z_AXIS = new THREE.Vector3(0, 0, 1);

export class ManholeClimb {
  /** The scene in progress (null: none). */
  private spot: ManholeSpot | null = null;
  private dir: 'down' | 'up' = 'down';
  private segs: Segment[] = [];
  private seg = 0;
  private segT = 0;
  /** Street level over the walkway at this manhole, the hero's scale, rest hip height (world). */
  private G = 4.6;
  private k = 1;
  private hipW = 0.93;
  /** Hands and feet on the rungs (false: a tiny hero just shows the climbing gait). */
  private ik = true;
  private readonly goals: LimbGoals = {
    L: { p: new THREE.Vector3(), w: 0, pole: [0.7, -1, -0.3] }, R: { p: new THREE.Vector3(), w: 0, pole: [0.7, -1, -0.3] },
    footL: { p: new THREE.Vector3(), w: 0, pole: [0.2, 0.2, 1] }, footR: { p: new THREE.Vector3(), w: 0, pole: [0.2, 0.2, 1] },
    curl: { L: 1.2, R: 1.2 }, curlW: 0,
  };
  /** The authored pose for this frame (drawn into the animator's override). */
  private poseFn: ((p: Pose) => void) | null = null;
  private overW = 0;
  // Camera
  private cam: CamMode = 'orbit';
  private camFrom = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
  private camBlend = 1;
  private camBlendDur = 0.5;
  private readonly camPos = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();
  private camDs = 2.4;
  // Lids
  private lidGeo: THREE.BufferGeometry | null = null;
  private lidMats: THREE.Material[] | null = null;
  /** The lid in the scene (moving), and the ones left lying beside their holes. */
  private lid: THREE.Mesh | null = null;
  private readonly loose: THREE.Object3D[] = [];
  private lidOpened = false;
  /** The limbs' swing last frame (a click on the rung as each one takes its new hold). */
  private lastSwing = [0, 0, 0, 0];

  constructor(private h: ManholeHost) {}

  get active(): boolean { return this.spot !== null; }

  /** Can the hero use this manhole (size)? */
  static fits(height: number): boolean { return height < 2.4; }

  /** Start going down (from the street) or up (from the sewer). */
  start(spot: ManholeSpot, dir: 'down' | 'up'): void {
    const P = this.h.player;
    this.spot = spot;
    this.dir = dir;
    this.G = this.h.underground.groundAt(spot.x, spot.z) - spot.floor;
    this.k = P.height / 1.8;
    this.ik = P.height >= 1.2;
    this.hipW = P.rig.animator?.hipWorld() ?? 0.52 * P.height;
    this.lidOpened = this.h.underground.isOpen(spot);
    this.seg = 0;
    this.segT = 0;
    this.camBlend = 1;
    this.cam = 'orbit';
    this.camDs = this.pickCamDs();
    P.autoMove = false;
    P.seat = null;
    P.puppet = 'idle';
    this.segs = dir === 'down' ? this.planDown() : this.planUp();
  }

  /** Stop at once (knocked down, defeated …): the body is let go where it is sensible. */
  abort(): void {
    const s = this.spot;
    if (!s) return;
    const P = this.h.player;
    // Below the street: onto the walkway at the ladder's foot; else beside the hole.
    if (P.pos.y < s.floor + this.G - 0.8) this.place(this.ladderLat(), 0, 0);
    else this.place(STREET_LAT, 0, this.G);
    this.finish();
    this.h.camRig.snap();
  }

  /** Every frame while active, instead of the player's controls and the camera rig. */
  update(dt: number): void {
    if (!this.spot) return;
    const P = this.h.player;
    if (P.ragdoll || P.downT > 0) { this.abort(); return; }
    this.goals.L!.w = this.goals.R!.w = this.goals.footL!.w = this.goals.footR!.w = 0;
    this.goals.curlW = 0;
    this.poseFn = null;
    this.overW = 1;
    P.puppetVel.set(0, 0, 0);
    // Run the segments (a short one may end within the frame).
    let left = dt;
    while (this.seg < this.segs.length) {
      const sg = this.segs[this.seg];
      const step = Math.min(left, sg.dur - this.segT);
      this.segT += step;
      left -= step;
      sg.run(clamp(this.segT / sg.dur, 0, 1), dt);
      if (this.segT < sg.dur - 1e-6) break;
      this.seg++;
      this.segT = 0;
      if (left <= 1e-6) break;
    }
    const an = P.rig.animator;
    if (an) {
      const fn = this.poseFn as ((p: Pose) => void) | null, w = this.overW;
      an.override = fn ? (p: Pose) => { fn(p); return w; } : null;
      an.limbs = this.ik ? this.goals : null;
    }
    P.update(dt, this.h.input, this.h.camRig.yaw, this.h.camRig.pitch);
    this.updateCamera(dt);
    if (this.seg >= this.segs.length) this.finish();
  }

  // ------------------------------------------------------------------ plans

  private planDown(): Segment[] {
    const s = this.spot!, P = this.h.player, G = this.G;
    const holeYaw = this.yawAcross(-1);
    const out: Segment[] = [];
    // Walk to the lid's side (opposite the ladder's wall: the hero turns their back to the hole there).
    out.push(this.walkTo(STREET_LAT, 0, G, holeYaw));
    // Lift the lid and drag it aside.
    out.push({ dur: 2.6, run: (u) => this.lidFromStreet(u) });
    // Turn round, the back to the hole.
    out.push({
      dur: 0.7, run: (u) => {
        this.place(STREET_LAT, 0, G);
        P.yaw = holeYaw + Math.PI * smooth(0, 1, u) * (s.side > 0 ? 1 : -1);
        P.puppet = 'idle';
        this.poseFn = null;
        this.overW = 0;
      },
    });
    // Over the edge onto the ladder.
    const hTop = this.hTop();
    out.push({ dur: 1.9, run: (u) => { this.rim(1 - u); this.setCam('shaft', 0.9); } });
    // Down the ladder.
    out.push(this.ladder(hTop, 0));
    // Off the ladder: the camera back behind the hero.
    out.push({
      dur: 0.45, run: (u) => {
        this.climbAt(0, false);
        // (On the ladder the knees stay bent: the body straightens onto the walkway.)
        P.pos.y += (s.floor - P.pos.y) * smooth(0, 1, u);
        this.overW = 1 - smooth(0, 1, u);
        this.fadeGoals(1 - u);
        this.setCam('orbit', 0.45);
      },
    });
    return out;
  }

  private planUp(): Segment[] {
    const P = this.h.player;
    const wallYaw = this.yawAcross(1);
    const out: Segment[] = [];
    out.push(this.walkTo(this.ladderLat(), 0, 0, wallYaw));
    // Onto the ladder: hands and feet find the rungs.
    out.push({ dur: 0.4, run: (u) => { this.climbAt(0, true); this.overW = smooth(0, 1, u); this.fadeGoals(u); } });
    const hTop = this.hTop();
    if (!this.lidOpened) {
      const hPush = this.hPush();
      out.push(this.ladder(0, hPush));
      out.push({ dur: 1.6, run: (u) => this.lidFromBelow(u, hPush) });
      out.push(this.ladder(hPush, hTop));
    } else out.push(this.ladder(0, hTop));
    out.push({ dur: 1.9, run: (u) => { this.rim(u); this.setCam(u < 0.75 ? 'shaft' : 'orbit', u < 0.75 ? 0.6 : 0.8); } });
    // Standing: the pose eases back into the body's own.
    out.push({
      dur: 0.35, run: (u) => {
        this.place(STREET_LAT, 0, this.G);
        P.yaw = wallYaw;
        this.poseFn = null;
        this.overW = 0;
        void u;
        this.setCam('orbit', 0.6);
      },
    });
    return out;
  }

  // ------------------------------------------------------------------ segments

  /** Walk (gait from the puppet's velocity) to a point of the frame, then turn to `yaw`. */
  private walkTo(lat: number, ds: number, y: number, yaw: number): Segment {
    const P = this.h.player;
    const from = P.pos.clone(), fromYaw = P.yaw;
    const to = this.at(lat, ds, y, new THREE.Vector3());
    const d = Math.hypot(to.x - from.x, to.z - from.z);
    const v = 1.3 * Math.sqrt(this.k);
    const walkT = d / v;
    const dur = Math.max(0.35, walkT + 0.35);
    const heading = Math.atan2(-(to.x - from.x), -(to.z - from.z));
    return {
      dur, run: (u) => {
        const t = u * dur;
        const f = walkT > 0 ? clamp(t / walkT, 0, 1) : 1;
        P.pos.lerpVectors(from, to, f);
        if (f < 1) {
          P.puppet = 'walk';
          P.puppetVel.set(to.x - from.x, 0, to.z - from.z).normalize().multiplyScalar(v);
          P.yaw = turn(fromYaw, heading, smooth(0, 0.25, t));
        } else {
          P.puppet = 'idle';
          P.yaw = turn(d > 0.05 ? heading : fromYaw, yaw, smooth(walkT, dur, t));
        }
        this.poseFn = null;
        this.overW = 0;
        this.setCam('orbit', 0.5);
      },
    };
  }

  /** The ladder from h0 to h1 (feet height over the walkway). */
  private ladder(h0: number, h1: number): Segment {
    const dur = Math.max(0.3, Math.abs(h1 - h0) / (CLIMB_V * Math.sqrt(this.k)));
    return {
      dur, run: (u) => {
        const hh = h0 + (h1 - h0) * u;
        this.climbAt(hh, h1 > h0);
        // The camera: from above while the head is in the shaft, from the sewer below the vault.
        const head = this.h.player.pos.y + this.h.player.height * 0.9 - this.spot!.floor;
        this.setCam(head > 2.55 ? 'shaft' : 'tube', 0);
      },
    };
  }

  /**
   * On the ladder at height h (feet over the walkway): hands and feet leapfrog in pairs (left
   * hand with right foot, then the right hand with the left foot), each moving two rungs while
   * the body rises one; the body is pushed up by the lower foot.
   */
  private climbAt(h: number, up: boolean): void {
    const P = this.h.player, k = this.k;
    const sdR = -this.spot!.side; // the hero's right, along the trunk, facing the wall
    const handOff = Math.round((1.2 * k) / RUNG) * RUNG;
    const top = this.topRung();
    const g = this.goals;
    let minFoot = Infinity;
    const limbs: [keyof LimbGoals, number, number, boolean][] = [
      ['footR', 0, sdR, false], ['footL', 0.5, -sdR, false], ['L', 0, -sdR, true], ['R', 0.5, sdR, true],
    ];
    limbs.forEach(([key, o, side, hand], li) => {
      const x = h / STEP - o, n = Math.floor(x), fr = x - n;
      const a = smooth(0, 0.5, fr), swing = fr < 0.5 ? Math.sin(Math.PI * a) : 0;
      const y0 = Math.max(0, n * STEP), y1 = Math.max(0, (n + 1) * STEP);
      const y = y0 + (y1 - y0) * a;
      const goal = g[key] as { p: THREE.Vector3; w: number };
      if (hand) {
        this.handPoint(y0 + handOff, side, top, _v);
        this.handPoint(y1 + handOff, side, top, _w);
        goal.p.lerpVectors(_v, _w, a);
        // On the street (the top): a flat palm, else gripping a rung.
        const street = (a < 0.5 ? y0 : y1) + handOff > top + 0.01;
        g.curl![key as 'L' | 'R'] = street ? 0.15 : 1.25;
      } else {
        this.at(LADDER_LAT - 0.11 * k, side * 0.11, y + 0.075 * k, goal.p);
        minFoot = Math.min(minFoot, y);
      }
      // The moving limb comes off the ladder a little.
      this.toward(goal.p, -(hand ? 0.1 : 0.14) * swing, (hand ? 0.04 : 0.06) * swing);
      goal.w = 1;
      // A click on the rung as the limb takes its new hold.
      if (this.lastSwing[li] > 0 && swing === 0) this.click(goal.p, hand);
      this.lastSwing[li] = swing;
    });
    g.curlW = 1;
    const hipY = minFoot + 0.8 * k;
    this.placeHips(this.ladderLat(), 0, hipY);
    P.yaw = this.yawAcross(1);
    P.puppet = this.ik ? 'idle' : 'climb';
    if (!this.ik) P.puppetVel.set(0, up ? CLIMB_V : -CLIMB_V, 0);
    const look = up ? 0.3 : -0.35;
    this.poseFn = (p) => {
      p.spine(-0.12);
      p.neck(look);
      for (const s of ['L', 'R'] as const) {
        p.arm(s, 2.2, 0.3, 0, 1.0, 0.5);
        p.leg(s, 1.0, 0.12, 0, 1.4, -0.3);
      }
    };
    this.overW = this.ik ? 1 : 0;
  }

  /**
   * Between the ladder's top (u = 0) and standing on the street beside the hole (u = 1): hands
   * pressing on the street's edge, the body pushed up, the right foot onto the edge, then the
   * left, standing up. Going down plays it backwards.
   */
  private rim(u: number): void {
    const k = this.k, G = this.G, g = this.goals, hT = this.hTop();
    const sdR = -this.spot!.side;
    const lb = this.ladderLat(), hipC = hT + 0.8 * k;
    const lat = kf(u, [[0, lb], [0.3, lb + 0.06], [0.55, SEWER_HW - 0.1], [0.85, STREET_LAT - 0.15], [1, STREET_LAT]]);
    const hip = kf(u, [[0, hipC], [0.3, hT + 0.86 * k], [0.55, G + 0.4 * k], [0.85, G + this.hipW * 0.96], [1, G + this.hipW]]);
    this.placeHips(lat, 0, hip);
    this.h.player.yaw = this.yawAcross(1);
    this.h.player.puppet = 'idle';
    // Hands flat on the street past the edge until the body is up.
    const hw = 1 - smooth(0.62, 0.8, u);
    for (const [key, sd] of [['L', -sdR], ['R', sdR]] as const) {
      this.at(SEWER_HW + 0.1, sd * 0.2, G + 0.03, g[key]!.p);
      g[key]!.w = hw;
      g.curl![key] = 0.15;
    }
    g.curlW = hw;
    // Feet: on the top rungs, the right one onto the street's edge, then the left.
    const footRung = (sd: number, out: THREE.Vector3) => this.at(LADDER_LAT - 0.11 * k, sd * 0.11, hT + 0.075 * k, out);
    const footStreet = (sd: number, la: number, out: THREE.Vector3) => this.at(la, sd * 0.13, G + 0.08 * k, out);
    const rUp = smooth(0.3, 0.5, u), lUp = smooth(0.58, 0.8, u);
    footRung(sdR, _v); footStreet(sdR, SEWER_HW + 0.14, _w);
    g.footR!.p.lerpVectors(_v, _w, rUp);
    this.toward(g.footR!.p, -0.15 * Math.sin(Math.PI * rUp), 0.12 * Math.sin(Math.PI * rUp));
    footRung(-sdR, _v); footStreet(-sdR, STREET_LAT - 0.05, _w);
    g.footL!.p.lerpVectors(_v, _w, lUp);
    this.toward(g.footL!.p, -0.12 * Math.sin(Math.PI * lUp), 0.15 * Math.sin(Math.PI * lUp));
    // The left foot leaves its rung when the body is too high for it; both fade as the hero stands.
    const stand = 1 - smooth(0.85, 1, u);
    g.footR!.w = stand;
    g.footL!.w = stand * (lUp > 0 ? 1 : 1 - smooth(0.4, 0.55, u) * 0.6);
    this.poseFn = (p) => {
      p.spine(kf(u, [[0, -0.12], [0.3, -0.5], [0.55, -0.8], [0.85, -0.25], [1, 0]]));
      p.neck(kf(u, [[0, 0.3], [0.55, 0.35], [1, 0]]));
      const af = kf(u, [[0, 2.2], [0.3, 1.0], [0.55, 0.6], [0.85, 0.2], [1, 0]]), ae = kf(u, [[0, 1.0], [0.3, 0.25], [0.55, 0.15], [1, 0]]);
      for (const s of ['L', 'R'] as const) p.arm(s, af, 0.25 * (1 - u), 0, ae, 0.4 * (1 - u));
      p.leg('R', kf(u, [[0, 1.0], [0.3, 0.4], [0.45, 1.9], [0.6, 1.7], [0.85, 0.3], [1, 0]]), 0.1, 0, kf(u, [[0, 1.4], [0.3, 0.3], [0.45, 2.2], [0.6, 1.8], [0.85, 0.3], [1, 0]]));
      p.leg('L', kf(u, [[0, 1.0], [0.3, 0.4], [0.58, 0.2], [0.7, 1.5], [0.85, 0.3], [1, 0]]), 0.1, 0, kf(u, [[0, 1.4], [0.3, 0.3], [0.58, 0.4], [0.7, 1.7], [0.85, 0.3], [1, 0]]));
    };
    this.overW = 1;
  }

  /** Squat beside the lid, lift its near edge and drag it off the hole onto the street. */
  private lidFromStreet(u: number): void {
    const P = this.h.player, s = this.spot!, G = this.G, g = this.goals;
    const lid = this.ensureLid();
    if (u > 0 && !this.lidOpened) {
      this.lidOpened = true;
      this.h.hideLid(s.x, s.z);
    }
    if (u >= 0.3 && !this.h.underground.isOpen(s)) {
      this.h.underground.openManhole(s);
      this.sound('metal_bend', 0.5, 1.5);
    }
    if (u >= 0.9 && lid.userData.down !== true) { lid.userData.down = true; this.sound('door_close', 0.7, 0.55); }
    // The lid: its near edge up (hinged on the far edge), then dragged aside and dropped.
    const tilt = kf(u, [[0.24, 0], [0.42, 0.42], [0.6, 0.3], [0.82, 0.12], [0.9, 0]]);
    const m = kf(u, [[0.42, 0], [0.86, 1]]);
    const lift = kf(u, [[0.42, 0], [0.5, 0.05], [0.84, 0.05], [0.9, 0]]);
    this.poseLid(lid, LID_LAT + (LID_DEST_LAT - LID_LAT) * m, s.side * LID_DEST_DS * m, G + lift, tilt);
    // The body: squatting, stepping along with the lid.
    const d = kf(u, [[0, 0], [0.2, 0.85], [0.86, 0.85], [1, 0]]);
    const bodyDs = s.side * 0.45 * m;
    const lat = STREET_LAT - 0.05 * d;
    this.place(lat, bodyDs, G);
    P.yaw = this.yawAcross(-1);
    P.puppet = 'idle';
    // Hands on the lid's near edge (lid frame: +x toward the hero; the hero's right is −z).
    const hw = smooth(0.1, 0.22, u) * (1 - smooth(0.88, 0.98, u));
    for (const [key, z] of [['L', 0.14], ['R', -0.14]] as const) {
      lid.updateMatrixWorld(true);
      g[key]!.p.set(LID_R * 0.92, LID_T * 0.5, z).applyMatrix4(lid.matrixWorld);
      g[key]!.w = hw;
      g.curl![key] = 1.3;
    }
    g.curlW = hw;
    const twist = kf(u, [[0.42, 0], [0.86, 0.45]]) * -1;
    const L = 0.85;
    this.poseFn = (p) => {
      const th = 1.1 * d, kn = 1.9 * d, sh = kn - th, tl = 0.3 * d;
      p.add('root', -tl);
      p.root.y -= (L / 2) * (2 - Math.cos(th) - Math.cos(sh));
      p.root.z += (L / 2) * (Math.sin(th) - Math.sin(sh)) * 0.6;
      for (const sd of ['L', 'R'] as const) p.leg(sd, th + tl, 0.15 * d, 0.05 * d, kn, -sh);
      p.spine(-0.45 * d, twist * 0.6);
      p.neck(0.2 * d);
      for (const sd of ['L', 'R'] as const) p.arm(sd, 0.9 * d, 0.2, 0, 0.3 * d);
    };
    this.overW = 1;
  }

  /** On the ladder under a closed lid: the right hand pushes it up and slides it off the hole. */
  private lidFromBelow(u: number, h: number): void {
    const s = this.spot!, G = this.G, g = this.goals;
    this.climbAt(h, true);
    const lid = this.ensureLid();
    if (!this.lidOpened) {
      this.lidOpened = true;
      this.h.hideLid(s.x, s.z);
      this.poseLid(lid, LID_LAT, 0, G, 0);
    }
    if (u >= 0.25 && !this.h.underground.isOpen(s)) {
      this.h.underground.openManhole(s);
      this.sound('metal_bend', 0.5, 1.4);
    }
    if (u >= 0.8 && lid.userData.down !== true) { lid.userData.down = true; this.sound('door_close', 0.7, 0.55); }
    const lift = kf(u, [[0.15, 0], [0.35, 0.16], [0.6, 0.12], [0.8, 0]]);
    const tilt = kf(u, [[0.15, 0], [0.35, -0.25], [0.6, -0.15], [0.8, 0]]);
    const m = kf(u, [[0.35, 0], [0.8, 1]]);
    this.poseLid(lid, LID_LAT + (LID_DEST_LAT - LID_LAT) * m, s.side * LID_DEST_DS * m, G + lift, tilt);
    // The right hand (lid frame: the hero faces +x, the right is +z) under the lid while it is in reach.
    const w = smooth(0, 0.15, u) * (1 - smooth(0.5, 0.68, u));
    lid.updateMatrixWorld(true);
    _v.set(-0.06, -LID_T * 0.5 - 0.02, 0.1).applyMatrix4(lid.matrixWorld);
    g.R!.p.lerp(_v, w);
    g.curl!.R = 1.25 + (0.1 - 1.25) * w;
    // The pushing arm straight up.
    const base = this.poseFn;
    this.poseFn = (p) => { base?.(p); p.arm('R', 0.7 * w, 0, 0, -0.9 * w); };
  }

  // ------------------------------------------------------------------ helpers

  /** Feet height on the ladder where the hero leaves it for the street (both feet on a rung). */
  private hTop(): number {
    return Math.max(STEP, Math.floor((this.G - 0.95 * this.k) / STEP) * STEP);
  }

  /** Feet height under a closed lid: the head just below it. */
  private hPush(): number {
    return Math.max(0, Math.min(this.hTop() - STEP, Math.floor((this.G - 1.95 * this.k) / STEP) * STEP));
  }

  /** The highest rung (below the street). */
  private topRung(): number {
    return Math.floor((this.G - 0.05 - 0.1) / RUNG) * RUNG;
  }

  /** Body centre on the ladder, across the trunk (an arm's length off the rungs, inside the shaft). */
  private ladderLat(): number {
    return Math.max(SHAFT_IN + 0.18, LADDER_LAT - 0.36 * this.k);
  }

  /** A hand's grip point for a hold at height y: on a rung, or flat on the street above the top. */
  private handPoint(y: number, sd: number, top: number, out: THREE.Vector3): THREE.Vector3 {
    if (y <= top + 0.01) return this.at(LADDER_LAT - 0.03, sd * (LADDER_HW - 0.06), y, out);
    return this.at(SEWER_HW + 0.1, sd * 0.2, this.G + 0.03, out);
  }

  private at(lat: number, ds: number, y: number, out: THREE.Vector3): THREE.Vector3 {
    const p = shaftPoint(this.spot!, lat, ds, y);
    return out.set(p[0], p[1], p[2]);
  }

  /** Move a point across the trunk (toward the wall: +) and up. */
  private toward(p: THREE.Vector3, d: number, up: number): void {
    const s = this.spot!;
    p.x += -s.dz * s.side * d;
    p.z += s.dx * s.side * d;
    p.y += up;
  }

  /** Feet on the ground at a point of the frame. */
  private place(lat: number, ds: number, y: number): void {
    this.at(lat, ds, y, this.h.player.pos);
  }

  /** The body placed by its hip height (over the walkway). */
  private placeHips(lat: number, ds: number, hipY: number): void {
    this.at(lat, ds, hipY - this.hipW, this.h.player.pos);
  }

  /** Facing across the trunk: +1 toward the shaft's wall, −1 back toward the trunk's middle. */
  private yawAcross(sgn: number): number {
    const s = this.spot!;
    const fx = -s.dz * s.side * sgn, fz = s.dx * s.side * sgn;
    return Math.atan2(-fx, -fz);
  }

  private fadeGoals(w: number): void {
    const g = this.goals;
    for (const key of ['L', 'R', 'footL', 'footR'] as const) g[key]!.w *= w;
    g.curlW = (g.curlW ?? 0) * w;
  }

  private click(p: THREE.Vector3, hand: boolean): void {
    if (!this.ik) return;
    this.h.sound('step_concrete', p.x, p.y, p.z, hand ? 0.12 : 0.22, hand ? 2.2 : 1.7);
  }

  private sound(id: string, gain: number, pitch: number): void {
    const s = this.spot!;
    this.h.sound(id, s.x, s.floor + this.G, s.z, gain, pitch);
  }

  // ------------------------------------------------------------------ the lid

  private ensureLid(): THREE.Mesh {
    if (this.lid) return this.lid;
    if (!this.lidGeo) {
      const g = new THREE.CylinderGeometry(LID_R, LID_R, LID_T, 28, 1);
      // The top cap shows the cover's picture (the furniture atlas cell).
      const { map, rect: [u0, v0, u1, v1] } = manholeCoverMap();
      const pos = g.getAttribute('position'), uv = g.getAttribute('uv');
      const top = g.groups[1];
      const idx = g.getIndex()!;
      const seen = new Set<number>();
      for (let i = top.start; i < top.start + top.count; i++) {
        const vi = idx.getX(i);
        if (seen.has(vi)) continue;
        seen.add(vi);
        const x = pos.getX(vi), z = pos.getZ(vi);
        uv.setXY(vi, u0 + (u1 - u0) * (0.5 + x / (2 * LID_R)), v0 + (v1 - v0) * (0.5 - z / (2 * LID_R)));
      }
      this.lidGeo = g;
      const iron = new THREE.MeshStandardMaterial({ color: 0x2c2c2d, roughness: 0.6, metalness: 0.55 });
      this.lidMats = [iron, new THREE.MeshStandardMaterial({ map, roughness: 0.55, metalness: 0.5 }), iron];
    }
    const m = new THREE.Mesh(this.lidGeo, this.lidMats!);
    m.castShadow = true;
    m.receiveShadow = true;
    this.h.scene.add(m);
    this.lid = m;
    return m;
  }

  /** Lid at (lat, ds) with its bottom at height y (over the walkway), tilted up on its +lat edge. */
  private poseLid(lid: THREE.Object3D, lat: number, ds: number, y: number, tilt: number): void {
    const s = this.spot!;
    _x.set(-s.dz * s.side, 0, s.dx * s.side);
    _z.crossVectors(_x, _y);
    _m.makeBasis(_x, _y, _z);
    lid.quaternion.setFromRotationMatrix(_m).multiply(_q.setFromAxisAngle(Z_AXIS, tilt));
    // Hinged on the edge that stays down: the centre swings in and up with the tilt.
    const d = LID_R * (1 - Math.cos(tilt)), up = LID_R * Math.abs(Math.sin(tilt));
    this.at(lat + (tilt >= 0 ? -d : d), ds, y + LID_T / 2 + 0.005 + up, lid.position);
  }

  /** Done: the body is the player's again, an opened lid stays where it was put. */
  private finish(): void {
    const P = this.h.player;
    P.puppet = null;
    P.puppetVel.set(0, 0, 0);
    P.vel.set(0, 0, 0);
    const an = P.rig.animator;
    if (an) { an.override = null; an.limbs = null; }
    if (this.lid) {
      this.loose.push(this.lid);
      // A city full of opened manholes keeps only the latest lids lying about.
      while (this.loose.length > 40) this.h.scene.remove(this.loose.shift()!);
      this.lid = null;
    }
    this.h.camRig.yaw = P.yaw;
    this.h.camRig.pitch = Math.min(this.h.camRig.pitch, -0.15);
    this.spot = null;
    this.segs = [];
  }

  // ------------------------------------------------------------------ camera

  /** Along the trunk, which side of the ladder the sewer camera stands (the free one). */
  private pickCamDs(): number {
    const s = this.spot!;
    for (const ds of [2.4, -2.4, 1.6, -1.6]) {
      const p = shaftPoint(s, -0.2, ds * s.side, 1.6);
      if (this.h.underground.cameraFree(p[0], p[1], p[2], 0.15)) return ds * s.side;
    }
    return 1.2;
  }

  private setCam(mode: CamMode, blend: number): void {
    if (mode === this.cam) return;
    const cam = this.h.camera;
    this.camFrom.pos.copy(cam.position);
    this.camFrom.quat.copy(cam.quaternion);
    this.camBlend = blend > 0 ? 0 : 1;
    this.camBlendDur = blend;
    if (this.cam === 'orbit' && mode !== 'orbit') {
      // (From the rig: the look target starts at the body.)
      this.h.player.pivot(this.camLook);
    }
    if (mode === 'orbit') { this.h.camRig.yaw = this.h.player.yaw; this.h.camRig.pitch = -0.25; this.h.camRig.snap(); }
    this.cam = mode;
  }

  private updateCamera(dt: number): void {
    const P = this.h.player, cam = this.h.camera, rig = this.h.camRig, s = this.spot!;
    if (this.cam === 'orbit') {
      rig.underground = this.h.underground.isUnder(P.pos.x, P.pos.y + 0.5, P.pos.z);
      rig.update(dt, P, this.h.input);
    } else {
      const head = _w.set(P.pos.x, P.pos.y + P.height * 0.85, P.pos.z);
      if (this.cam === 'shaft') {
        // Above the street on the trunk's side of the hole, looking down the shaft at the hero.
        this.at(SHAFT_IN - 1.1, 0.35 * s.side, this.G + 1.7 * Math.max(1, this.k), this.camPos);
        this.camLook.copy(head);
        rig.underground = false;
      } else {
        // In the sewer, along the trunk from the ladder, at head height.
        this.at(-0.2, this.camDs, 1.6, this.camPos);
        this.camLook.set(P.pos.x, Math.min(P.pos.y + P.height * 0.6, s.floor + 2.4), P.pos.z);
        rig.underground = true;
      }
      cam.position.copy(this.camPos);
      cam.lookAt(this.camLook);
    }
    if (this.camBlend < 1) {
      this.camBlend = Math.min(1, this.camBlend + dt / Math.max(0.01, this.camBlendDur));
      const a = smooth(0, 1, this.camBlend);
      cam.position.lerpVectors(this.camFrom.pos, cam.position, a);
      // Into a scripted view the hero stays in the middle of the picture all the way.
      if (this.cam !== 'orbit') cam.lookAt(this.camLook);
      else cam.quaternion.slerpQuaternions(this.camFrom.quat, cam.quaternion, a);
    }
  }
}

/** Angle from a toward b by f, the short way round. */
function turn(a: number, b: number, f: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}

