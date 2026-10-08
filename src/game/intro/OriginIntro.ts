/**
 * The origin scene: why this ordinary person can grow powers from good deeds.
 *
 * The night before, a falling star streaks over the city and breaks apart; one glowing shard comes
 * down in the street a few steps from the player. They walk up to it, reach for it — its light
 * pours into them, everything goes white. The next morning they wake on the pavement where it
 * lay, get up, and the captions say what changed: since that night they feel it when someone needs
 * help, and every good deed (karma) feeds the light in them — press P to awaken powers.
 *
 * Only for a new game in Normal mode (not a loaded save, not Sandbox, not `?auto` test starts);
 * `?intro` forces it, `?intro=0` turns it off. Skippable at any time: a key or click shows "hold to
 * skip" (once seen — remembered in localStorage — a single press skips). However it ends, the
 * game is left as a normal start: player standing at the start spot, the start time and weather,
 * karma untouched, the interface back.
 *
 * The places come from the start spot: the shard lands exactly where a normal game starts, the
 * player waits up to 9 m away on a clear straight walk to it, the star comes in through the
 * openest patch of sky seen from there (downtown is walled in by towers), and every camera is
 * checked against buildings and obstacles. The street's screens glitch as it breaks up (the signs'
 * own malfunction omen, src/future/Signs). Sounds are synthesized (IntroSound), the effects are
 * emissive only (StarFx), and the start-up warm-up renders the night city from the shots' cameras.
 *
 * Shots (scene seconds):
 *   0– 7    establishing: the night street from a few metres up, the star appears far off
 *   7–12.6  low behind the player, looking up: the star rushes in and breaks apart
 *  12.6–17.2 wide from the side: a fragment comes down in front of the player — flash, dust
 *  17.2–23.8 over the shoulder: the player walks up to the humming shard
 *  23.8–29.6 close and low: they reach down, touch it, light streams into them, white-out
 *  30.8–32.6 black: "The next morning"
 *  32.6–41   from above: lying on the pavement, waking, getting up (the ragdoll get-up); captions
 *  41–44.5   the camera glides into the gameplay view, the bars open, the interface comes back
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import type { Input } from '../Input';
import type { WarmView } from '../../render/WarmUp';
import { StarFx, type Streak } from './StarFx';
import { IntroUi } from './IntroUi';
import { IntroSound } from './IntroSound';
import { cityName } from '../../plan/names';
import { clamp, lerp, smoothstep } from '../../core/math';
import { hash32, hashToFloat } from '../../core/rng';
import { isTouch } from '../../ui/touch';

/** The skip prompt (a touch screen has no Space key). */
const skipText = (seen: boolean) => isTouch() ? (seen ? 'Tap to skip' : 'Hold to skip') : seen ? 'Skip — Space' : 'Hold Space to skip';

const SEEN_KEY = 'scale.originSeen';
/** The page's query as it was at load (the start menu rewrites the URL before the game starts). */
const BOOT_QUERY = new URLSearchParams(location.search);
const NIGHT_HOUR = 1.2;

/** Timeline (scene seconds). */
const T = {
  shotB: 7, starOn: 3.4, breakup: 10.6, shotC: 12.6, impact: 13.6, shotD: 17.2, walk: 17.4, shotE: 23.8,
  reach: 24.2, touch: 25.6, white: 28.4, collapse: 29.1, whiteFull: 29.6, toBlack: 30.0, title: 30.9, morning: 32.6,
  getUp: 33.8, handoff: 41, bars: 42.6, end: 44.5,
};

const CAPTIONS: [number, number, string][] = [
  [18.2, 23.2, 'It hummed softly in the dark — as if it had been waiting for you.'],
  [34.4, 37.8, 'Since that night, you can feel it when someone needs help.'],
  [37.8, 41.2, 'Every good deed earns <b>karma</b> — and karma feeds the light inside you.'],
  [41.2, 44.4, 'Help people with <kbd>E</kbd>. Awaken your powers with <kbd>P</kbd>.'],
];

/** Scripted keys for Player.update. */
class ScriptInput {
  readonly keys = new Set<string>();
  down(code: string): boolean { return this.keys.has(code); }
  hit(_code: string): boolean { return false; }
}

const ZERO_INPUT = { mouseDX: 0, mouseDY: 0, wheel: 0 } as unknown as Input;
const UP = new THREE.Vector3(0, 1, 0);

interface CamPose { pos: THREE.Vector3; look: THREE.Vector3; fov: number }

export class OriginIntro {
  /** Should a new game start with the origin scene? */
  static wanted(g: Game): boolean {
    if (g.pendingSave) return false;
    const q = BOOT_QUERY;
    if (q.has('intro')) return q.get('intro') !== '0';
    if (q.has('auto') || q.has('load')) return false;
    return g.mode === 'normal';
  }

  active = false;
  private t = 0;
  private ui: IntroUi | null = null;
  private fx = new StarFx();
  private snd: IntroSound;
  private input = new ScriptInput();
  private seen = false;
  // Places: the shard's spot S (= the normal start), the walk direction D, its right R, the night start P0.
  private S = new THREE.Vector3();
  /** The normal start spot: where the player wakes in the morning and the game begins. */
  private M = new THREE.Vector3();
  /** The morning shot's frame round the start spot (turned until its camera path is clear). */
  private gD = new THREE.Vector3(0, 0, -1);
  private gR = new THREE.Vector3(1, 0, 0);
  private gM = 0;
  private D = new THREE.Vector3(0, 0, -1);
  private R = new THREE.Vector3(1, 0, 0);
  private P0 = new THREE.Vector3();
  private W = new THREE.Vector3();
  private yawD = 0;
  /** The star's (horizontal) direction from the player, its right, the yaw facing it, its first elevation. */
  private H = new THREE.Vector3(0, 0, -1);
  private RH = new THREE.Vector3(1, 0, 0);
  private yawStar = 0;
  private elA = 0.6;
  private camA = new THREE.Vector3();
  private camB = new THREE.Vector3();
  private camC = new THREE.Vector3();
  private lookC = new THREE.Vector3();
  private camE = { p0: new THREE.Vector3(), p1: new THREE.Vector3() };
  private gS = 0;
  // Restored at the end.
  private startHour = 10.5;
  private startDay = 0;
  private weatherOverride: unknown = null;
  // The star.
  private A0 = new THREE.Vector3();
  private B0 = new THREE.Vector3();
  private vStar = new THREE.Vector3();
  private star!: Streak;
  private frags: { s: Streak; fade: number }[] = [];
  private lander!: Streak;
  private fired = new Set<string>();
  private shot = '';
  private lookCur = new THREE.Vector3();
  private posCur = new THREE.Vector3();
  private handoffFrom: { pos: THREE.Vector3; q: THREE.Quaternion; fov: number } | null = null;
  private hold = 0;
  private holding = false;
  private promptShown = false;
  private ended = false;
  private walked = false;
  private rng = 0;

  constructor(private g: Game) {
    this.snd = new IntroSound(g.audio);
    try { this.seen = localStorage.getItem(SEEN_KEY) === '1'; } catch { /* storage unavailable */ }
  }

  // ------------------------------------------------------------------ set-up (before the warm-up)

  /**
   * Choose the walk, set the night, build the effects. Called once the player stands at the
   * start spot, before the start-up warm-up (which then renders the night and the shots).
   */
  prepare(): void {
    const g = this.g, P = g.player;
    this.rng = hash32(g.settings.seed ^ 0x51a7);
    this.M.set(P.pos.x, P.pos.y, P.pos.z);
    this.gM = P.pos.y;
    // The night happens at the start spot, or (when that is walled in — an alley, a courtyard)
    // at the nearest open place; the morning is at the start spot again.
    this.S.copy(this.chooseSite());
    this.gS = this.S.y;
    // The walk: the clearest straight approach to the spot (up to 9 m).
    let best = { a: 0, len: -1 };
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2 + hashToFloat(this.rng) * 0.4;
      const len = this.clearRun(this.S, a, 9.5);
      if (len > best.len + 0.01) best = { a, len };
      if (len >= 9.5) { best = { a, len }; break; }
    }
    const a = best.a, len = Math.max(3, Math.min(9, best.len - 0.4));
    this.D.set(Math.sin(a), 0, Math.cos(a)); // walking direction: towards S
    this.R.set(-this.D.z, 0, this.D.x);
    this.P0.copy(this.S).addScaledVector(this.D, -len);
    this.P0.y = g.world.groundHeight(this.P0.x, this.P0.z, this.gS + 1);
    this.W.copy(this.S).addScaledVector(this.D, -0.62);
    this.yawD = Math.atan2(-this.D.x, -this.D.z);
    // The star: in through open sky as seen from where the player stands (towers all round
    // downtown), from far off and low to high above, where it breaks apart.
    const eye = this.P0.clone().addScaledVector(UP, 1.5);
    const sky = this.skySearch(eye);
    this.H.set(Math.sin(sky.az), 0, Math.cos(sky.az));
    this.RH.set(-this.H.z, 0, this.H.x);
    this.yawStar = Math.atan2(-this.H.x, -this.H.z);
    this.elA = sky.elA;
    // (Coming in at a slant across the sky, not straight at the camera, where the sky is open.)
    let slant = 0;
    for (const o of [-0.38, 0.38, -0.22, 0.22]) if (this.clearDir(eye, dirOf(sky.az + o, sky.elA), 700)) { slant = o; break; }
    this.A0.copy(eye).addScaledVector(dirOf(sky.az + slant, sky.elA), 900);
    this.B0.copy(eye).addScaledVector(dirOf(sky.az + 0.1, sky.elB), 170);
    this.vStar.subVectors(this.B0, this.A0).divideScalar(T.breakup - T.starOn);
    this.placeCameras(eye, sky.az);
    const main = (t: number) => _p.copy(this.A0).addScaledVector(this.vStar, Math.max(0, Math.min(t, T.breakup) - T.starOn)).clone();
    this.star = this.fx.addStreak(main, T.starOn, 0.9, 2.2, 3.2);
    const dir = this.vStar.clone().normalize();
    for (let i = 0; i < 5; i++) {
      const h = hash32(this.rng + i * 7919);
      const d = dir.clone().addScaledVector(this.RH, (i - 2) * 0.13 + (hashToFloat(h) - 0.5) * 0.05).addScaledVector(UP, (hashToFloat(h ^ 0x55) - 0.6) * 0.12).normalize();
      const sp = this.vStar.length() * (0.75 + 0.35 * hashToFloat(h ^ 0x99));
      const path = (t: number) => t <= T.breakup ? main(t) : this.B0.clone().addScaledVector(d, sp * (t - T.breakup)).addScaledVector(UP, -4.9 * (t - T.breakup) ** 2);
      this.frags.push({ s: this.fx.addStreak(path, T.starOn, 0.5, 0.9, 1.4), fade: 1.2 + 1.5 * hashToFloat(h ^ 0x1234) });
    }
    const C = this.B0.clone().addScaledVector(dir, 60).addScaledVector(UP, -10);
    const end = this.S.clone().addScaledVector(UP, 0.25);
    const land = (t: number) => {
      if (t <= T.breakup) return main(t);
      const u = Math.pow(clamp((t - T.breakup) / (T.impact - T.breakup), 0, 1), 1.25);
      return new THREE.Vector3()
        .addScaledVector(this.B0, (1 - u) * (1 - u))
        .addScaledVector(C, 2 * u * (1 - u))
        .addScaledVector(end, u * u);
    };
    this.lander = this.fx.addStreak(land, T.starOn, 0.45, 0.7, 1.2);
    this.fx.placeShard(this.S.x, this.gS, this.S.z, hashToFloat(this.rng ^ 0x77) * Math.PI * 2);
    g.renderer.scene.add(this.fx.group);
    // Night (for the warm-up too: it renders the night city), clear skies, no time running.
    this.startHour = g.sky.hour;
    this.startDay = g.sky.day;
    g.sky.hour = NIGHT_HOUR;
    this.weatherOverride = g.weather.override;
    g.weather.override = 'clear';
    // The player waits at the walk's start, facing the spot.
    P.pos.copy(this.P0);
    P.vel.set(0, 0, 0);
    P.yaw = this.yawD;
    g.camRig.yaw = this.yawD;
  }

  /** Open sky from `eye`: the azimuth with the lowest clear view (rather ahead of the walk). */
  private skySearch(eye: THREE.Vector3): { az: number; elA: number; elB: number } {
    const azD = Math.atan2(this.D.x, this.D.z);
    const deg = Math.PI / 180;
    let best: { az: number; el: number; score: number } | null = null;
    for (let k = 0; k < 48; k++) {
      const az = (k / 48) * Math.PI * 2;
      let elMin = -1;
      for (let el = 80; el >= 18; el -= 4) {
        if (!this.clearDir(eye, dirOf(az, el * deg), 700)) break;
        elMin = el;
      }
      if (elMin < 0 || !this.clearDir(eye, dirOf(az + 0.1, 70 * deg), 700)) continue;
      const score = elMin + 22 * (1 - Math.cos(az - azD)) / 2;
      if (!best || score < best.score) best = { az, el: elMin, score };
    }
    if (!best) return { az: azD, elA: 72 * deg, elB: 84 * deg };
    const elA = Math.max(best.el + 5, 24);
    return { az: best.az, elA: elA * deg, elB: Math.min(82, Math.max(elA + 22, 58)) * deg };
  }

  /** Nothing built in the way along a direction (m). */
  private clearDir(o: THREE.Vector3, d: THREE.Vector3, dist: number, step = 3): boolean {
    return this.g.world.raycast(o.x, o.y, o.z, d.x, d.y, d.z, dist, step).t >= dist;
  }

  /** A clear line between two points. */
  private los(a: THREE.Vector3, b: THREE.Vector3): boolean {
    _d.subVectors(b, a);
    const L = _d.length();
    if (L < 0.1) return true;
    _d.divideScalar(L);
    return this.g.world.raycast(a.x, a.y, a.z, _d.x, _d.y, _d.z, L, 0.5).t >= L - 0.3;
  }

  /** Inside a building (or an obstacle on the ground near it)? */
  private solid(p: THREE.Vector3, obstacles = false): boolean {
    const g = this.g;
    const b = g.world.buildingAt(p.x, p.z);
    if (b && p.y < b.top + 1 && p.y > b.low - 1) return true;
    if (obstacles) {
      const y = g.world.groundHeight(p.x, p.z, p.y);
      if (g.collision.collide(p.x, p.z, y, Math.max(0.5, p.y - y + 0.3), 0.4, p.x, p.z).hit) return true;
    }
    return false;
  }

  /** The shots' fixed cameras, placed clear of buildings (and of things in the street, close up). */
  private placeCameras(eye: THREE.Vector3, az: number): void {
    const S = this.S, D = this.D, R = this.R, H = this.H, RH = this.RH, gS = this.gS;
    const dA = dirOf(az, this.elA);
    // A: wide, a few metres up behind the player, looking where the star will come from.
    let a: THREE.Vector3 | null = null;
    for (const d of [12, 9, 6, 3.5]) {
      for (const h of [5.5, 3.5, 1.5]) {
        const p = eye.clone().addScaledVector(H, -d).addScaledVector(RH, d * 0.25).addScaledVector(UP, h);
        if (!this.solid(p) && this.los(p, eye) && this.clearDir(p, dA, 600)) { a = p; break; }
      }
      if (a) break;
    }
    this.camA = a ?? eye.clone().addScaledVector(H, -2).addScaledVector(UP, 0.5);
    // B: low behind the player, looking up along the star's way.
    let b = eye.clone().addScaledVector(H, -2.6).addScaledVector(RH, 0.7).addScaledVector(UP, -0.3);
    if (this.solid(b, true)) b = eye.clone().addScaledVector(H, -1.4).addScaledVector(RH, 0.5).addScaledVector(UP, -0.3);
    this.camB = b;
    // C: wide from the side of the walk: the spot and the player both in view.
    const mid = S.clone().lerp(this.P0, 0.4).addScaledVector(UP, 0.9);
    let c: THREE.Vector3 | null = null;
    for (const k of [1, 0.75, 0.55]) for (const sd of [1, -1]) {
      if (c) break;
      const p = S.clone().addScaledVector(R, sd * 9 * k).addScaledVector(D, -6 * k).setY(gS + 2);
      if (!this.solid(p, true) && this.los(p, S.clone().addScaledVector(UP, 0.4)) && this.los(p, this.P0.clone().addScaledVector(UP, 1.2))) c = p;
    }
    this.camC = c ?? S.clone().addScaledVector(R, 5).addScaledVector(D, -3).setY(gS + 2);
    this.lookC = mid;
    // E: close and low in front of the player, beside the shard.
    let e: { p0: THREE.Vector3; p1: THREE.Vector3 } | null = null;
    for (const sd of [1, -1]) {
      const p0 = S.clone().addScaledVector(D, 2.0).addScaledVector(R, sd * 2.3).setY(gS + 0.7);
      const p1 = S.clone().addScaledVector(D, 1.6).addScaledVector(R, sd * 1.8).setY(gS + 0.85);
      if (!this.solid(p0, true) && !this.solid(p1, true) && this.los(p0, S.clone().addScaledVector(UP, 0.5))) { e = { p0, p1 }; break; }
    }
    // G: the morning, from above the start spot: a direction round it whose whole camera path is
    // out of buildings and things and sees the player (a start beside a wall or under an arcade).
    const M = this.M, look = M.clone().addScaledVector(UP, 0.4);
    const gPath = (gd: THREE.Vector3, gr: THREE.Vector3) => {
      for (let i = 0; i <= 4; i++) {
        const u = i / 4;
        const p = M.clone().addScaledVector(gd, -0.4 - 1.8 * u).addScaledVector(gr, 0.9 + 1.7 * u).addScaledVector(UP, 3.6 - 1.7 * u);
        if (this.solid(p, true) || !this.los(p, look)) return false;
      }
      return true;
    };
    let found = false;
    for (let k = 0; k < 12 && !found; k++) for (const m of [1, -1]) {
      const a0 = Math.atan2(D.x, D.z) + (k * Math.PI) / 6;
      const gd = new THREE.Vector3(Math.sin(a0), 0, Math.cos(a0));
      const gr = new THREE.Vector3(gd.z, 0, -gd.x).multiplyScalar(m);
      if (gPath(gd, gr)) { this.gD.copy(gd); this.gR.copy(gr); found = true; break; }
    }
    if (!found) { this.gD.copy(D); this.gR.copy(R); }
    this.camE = e ?? { p0: S.clone().addScaledVector(D, 2.0).addScaledVector(R, 2.3).setY(gS + 0.7), p1: S.clone().addScaledVector(D, 1.6).addScaledVector(R, 1.8).setY(gS + 0.85) };
  }

  /** How far one can walk straight to spot `o` (y = its ground) from direction angle `a` (m, up to `max`). */
  private clearRun(o: THREE.Vector3, a: number, max: number): number {
    const g = this.g;
    const dx = Math.sin(a), dz = Math.cos(a);
    for (let d = 0.6; d <= max; d += 0.4) {
      const x = o.x - dx * d, z = o.z - dz * d;
      if (!g.world.standable(x, z)) return d - 0.4;
      const y = g.world.groundHeight(x, z, o.y + 1);
      if (Math.abs(y - o.y) > 0.45) return d - 0.4;
      const c = g.collision.collide(x, z, y, 1.7, 0.45, x, z);
      if (c.hit) return d - 0.4;
    }
    // The camera behind the start of the walk must be free too.
    const cx = o.x - dx * (max + 2.6), cz = o.z - dz * (max + 2.6);
    return g.world.buildingAt(cx, cz) ? max - 2 : max;
  }

  /**
   * Where the star comes down: the start spot when there is sky to see and room to walk there,
   * else the best open spot within ~65 m (a cheap openness test: clear views at 35° all round).
   */
  private chooseSite(): THREE.Vector3 {
    const g = this.g, M = this.M;
    const rate = (x: number, z: number) => {
      if (!g.world.standable(x, z)) return null;
      const y = g.world.groundHeight(x, z, this.gM + 4);
      if (!isFinite(y) || Math.abs(y - this.gM) > 4) return null;
      // Room for the shard: nothing standing within a metre (kiosks, benches, poles, parked cars).
      if (g.collision.collide(x, z, y, 1.7, 1.0, x, z).hit) return null;
      const p = new THREE.Vector3(x, y, z);
      const eye = new THREE.Vector3(x, y + 1.5, z);
      let open = 0;
      for (let k = 0; k < 16; k++) if (this.clearDir(eye, dirOf((k / 16) * Math.PI * 2, 0.61), 300, 4)) open++;
      let walk = 0;
      for (let k = 0; k < 8 && walk < 7; k++) walk = Math.max(walk, this.clearRun(p, (k / 8) * Math.PI * 2, 7));
      return { p, open, walk, score: open + (walk >= 6 ? 3 : walk >= 4 ? 0 : -20) - Math.hypot(x - M.x, z - M.z) / 25 };
    };
    // The start spot or a step or two from it, if good enough …
    let best: ReturnType<typeof rate> = null;
    for (const r of [0, 1.5, 3]) for (let k = 0; k < (r ? 8 : 1); k++) {
      const a = (k / 8) * Math.PI * 2;
      const c = rate(M.x + Math.sin(a) * r, M.z + Math.cos(a) * r);
      if (c && c.open >= 5 && c.walk >= 6) return c.p;
      if (c && (!best || c.score > best.score)) best = c;
    }
    // … else the best open place round about.
    for (const r of [14, 26, 38, 52, 66]) for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2 + r * 0.1;
      const c = rate(M.x + Math.sin(a) * r, M.z + Math.cos(a) * r);
      if (c && (!best || c.score > best.score)) best = c;
    }
    return best ? best.p : M.clone();
  }

  /** Small meshes of the scene's effects for the warm-up (programs and first draws). */
  stagingObjects(): THREE.Object3D[] { return [this.fx.warmObject()]; }

  /** The shots' cameras, so the warm-up draws what they will see. */
  warmViews(): WarmView[] {
    const out: WarmView[] = [];
    for (const t of [1, 6, 9, 11.5, 14, 20, 26]) {
      const c = this.camAt(t, true);
      out.push({ pos: c.pos.clone(), look: c.look.clone() });
    }
    return out;
  }

  // ------------------------------------------------------------------ playing

  /** Start (after the warm-up, as the loading screen goes). */
  async play(): Promise<void> {
    const g = this.g;
    this.ui = new IntroUi();
    this.ui.fade(1, 0);
    if (this.seen) this.showPrompt();
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    this.ui.root.addEventListener('pointerdown', this.onPointerDown);
    this.ui.root.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('pointerup', this.onPointerUp, true);
    window.addEventListener('blur', this.onPointerUp);
    g.audio.wake();
    this.snd.prepare();
    try { await Promise.race([g.player.rig.ready, new Promise((r) => setTimeout(r, 4000))]); } catch { /* default body */ }
    if (this.ended) return; // skipped meanwhile
    this.t = 0;
    this.active = true;
  }

  private showPrompt(): void {
    this.promptShown = true;
    this.ui?.skipPrompt(skipText(this.seen), 0);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.ui) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.g.audio.wake();
    if (e.repeat) return;
    const skipKey = e.code === 'Space' || e.code === 'Escape' || e.code === 'Enter' || e.code === 'NumpadEnter';
    if (this.seen && skipKey) { this.skip(); return; }
    if (!this.promptShown) this.showPrompt();
    if (skipKey) this.holding = true;
  };
  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space' || e.code === 'Escape' || e.code === 'Enter' || e.code === 'NumpadEnter') this.holding = false;
  };
  private onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    this.g.audio.wake();
    if (this.seen) { this.skip(); return; }
    if (!this.promptShown) this.showPrompt();
    this.holding = true;
  };
  private onPointerUp = () => { this.holding = false; };

  /** Skip to the end state now. */
  skip(): void {
    if (this.ended) return;
    this.finish(true);
  }

  /** Per frame, from the game's tick in place of the player's controls and the camera rig. */
  update(dt: number): void {
    if (!this.active || !this.ui) return;
    const g = this.g, P = g.player, ui = this.ui;
    // Hold to skip.
    if (this.holding) { this.hold += dt; if (this.hold >= 0.9) { this.skip(); return; } }
    else this.hold = Math.max(0, this.hold - dt * 2);
    if (this.promptShown) ui.skipPrompt(skipText(this.seen), this.hold / 0.9);
    this.t += dt;
    const t = this.t;
    const once = (k: string, at: number) => { if (t < at || this.fired.has(k)) return false; this.fired.add(k); return true; };
    // Time of day held (night, then the start time).
    g.sky.hour = t < T.whiteFull ? NIGHT_HOUR : this.startHour;
    g.sky.day = this.startDay;
    // ---- the player
    this.input.keys.clear();
    let camYaw = this.yawD;
    if (t >= T.walk && !this.walked) {
      const dx = this.W.x - P.pos.x, dz = this.W.z - P.pos.z, d = Math.hypot(dx, dz);
      if (d < 0.12 || (dx * this.D.x + dz * this.D.z) < 0) this.walked = true;
      else { this.input.keys.add('KeyW'); camYaw = Math.atan2(-dx, -dz); }
    }
    if (once('teleportW', T.shotE) && Math.hypot(this.W.x - P.pos.x, this.W.z - P.pos.z) > 0.35) {
      P.pos.set(this.W.x, g.world.groundHeight(this.W.x, this.W.z, this.gS + 1), this.W.z);
      P.vel.set(0, 0, 0);
      this.walked = true;
    }
    if ((this.walked || t < T.walk) && t < T.collapse) {
      // Face the star (looking up at it), after the impact the shard.
      let d = (t < T.impact + 0.6 ? this.yawStar : this.yawD) - P.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      P.yaw += d * Math.min(1, dt * 6);
    }
    if (once('cower', T.impact + 0.05)) P.action = { id: 'cower', t0: P.animClock, dur: 1.5 };
    if (once('reach', T.reach)) P.action = { id: 'pickup', t0: P.animClock, dur: 3.2 };
    if (once('collapse', T.collapse)) {
      P.action = undefined;
      P.vel.set(-this.D.x * 0.9, 0.3, -this.D.z * 0.9);
      P.downT = 1e4;
    }
    if (t >= T.collapse && t < T.getUp) P.downT = Math.max(P.downT, 1e3);
    if (once('getUp', T.getUp)) P.downT = 0;
    if (t >= T.getUp && P.ragdoll === 'limp') {
      // Up now (a body still settling gets up as soon as it lies still); one that will not
      // settle (wedged against something) is let go after a while rather than left lying.
      g.ragdolls.getUp(P);
      if (t > T.getUp + 2.5) { g.ragdolls.release(P); P.ragdoll = ''; }
    }
    // The morning has the start's own weather (the night was kept clear for the star).
    if (once('weather', T.whiteFull)) this.restoreWeather();
    // Night somewhere else nearby: they wake at the start spot (moved there under the black).
    if (once('relocate', T.toBlack) && this.S.distanceTo(this.M) > 0.5) {
      g.ragdolls.release(P);
      P.ragdoll = '';
      P.action = undefined;
      P.pos.copy(this.M);
      P.vel.set(0, 0, 0);
      P.yaw = this.yawD;
      this.moved = true;
    }
    // (A few frames later, once the rig stands there: the ragdoll is built from the rig's pose.)
    if (this.moved && once('relie', T.toBlack + 0.35)) g.ragdolls.knockout(P, { velocity: [0, 0, 0], stayDown: true });
    P.update(dt, this.input as unknown as Input, camYaw, 0);
    // ---- effects
    this.updateFx(dt, t);
    // ---- camera
    this.updateCamera(dt, t);
    // ---- sound
    if (once('sStreak', T.starOn + 0.2)) this.snd.play('streak', 0.85);
    if (once('sCrack', T.breakup)) this.snd.play('crack', 0.9);
    // The street's screens flicker and tear as it breaks up overhead and comes down (the signs'
    // own malfunction omen; they recover by themselves).
    if (once('glitch', T.breakup)) g.future.signs.glitch(this.S.x, this.S.z, 90, 3.5, 8);
    if (once('glitch2', T.impact)) g.future.signs.glitch(this.S.x, this.S.z, 45, 2.5, 6);
    if (once('sImpact', T.impact)) this.snd.play('impact', 1);
    if (once('sSurge', T.touch - 0.2)) this.snd.play('surge', 0.9);
    if (once('sDawn', T.whiteFull - 0.4)) this.snd.play('dawn', 0.7);
    if (t >= T.impact && t < T.whiteFull) {
      const cam = g.renderer.camera.position;
      const near = clamp(2.5 / Math.max(1, cam.distanceTo(this.S)), 0, 1);
      const k = smoothstep(T.impact, T.impact + 1.5, t) * (1 + 0.6 * smoothstep(T.touch, T.white, t));
      this.snd.humLevel(0.55 * near * k, 1 + 0.25 * smoothstep(T.touch, T.white, t));
    } else if (t >= T.whiteFull) this.snd.humLevel(0);
    // ---- screen
    const black = t < 2 ? 1 - smoothstep(0.4, 2, t) : 0;
    let a = black, white = 0;
    if (t >= T.white && t < T.morning + 1.6) {
      a = t < T.whiteFull ? smoothstep(T.white, T.whiteFull, t) : t < T.morning ? 1 : 1 - smoothstep(T.morning, T.morning + 1.6, t);
      white = t < T.toBlack ? 1 : 1 - smoothstep(T.toBlack, T.toBlack + 0.8, t);
    }
    ui.fade(a, white);
    const city = cityName(g.settings.seed);
    ui.titleCard(t > 0.9 && t < 5.2 ? `The night before<small>${city} · 1:12 a.m.</small>` : t > T.title && t < T.morning - 0.3 ? 'The next morning' : '');
    let cap = '';
    for (const [c0, c1, html] of CAPTIONS) if (t >= c0 && t < c1) cap = html;
    ui.caption(cap);
    if (once('bars', T.bars)) ui.root.classList.add('open-bars');
    if (t >= T.end) this.finish(false);
  }

  private updateFx(dt: number, t: number): void {
    const g = this.g, fx = this.fx, cam = g.renderer.camera;
    const night = t < T.whiteFull;
    fx.group.visible = night;
    if (!night) return;
    // Main star until the breakup (a flare), the fragments after it, the lander until impact.
    const cp = cam.position;
    if (t >= T.starOn && t < T.breakup + 0.25) {
      const k = smoothstep(T.starOn, T.starOn + 1.2, t) * (1 + 2.5 * smoothstep(T.breakup - 0.6, T.breakup, t)) * (t > T.breakup ? 1 - (t - T.breakup) / 0.25 : 1);
      const head = this.star.update(Math.min(t, T.breakup), cp, 3 * k);
      // Sparks shed along the way.
      for (let i = 0; i < 3; i++) fx.particles.spark(head, -this.vStar.x * 0.05 + rs() * 12, -this.vStar.y * 0.05 + rs() * 12, -this.vStar.z * 0.05 + rs() * 12, 0.5 + Math.random() * 0.9, 1.2 + Math.random() * 1.5, 2.2, 1.4 + Math.random() * 0.6, 0.9 + Math.random());
    } else this.star.hide();
    for (const f of this.frags) {
      const age = t - T.breakup;
      if (age > 0 && age < f.fade) {
        f.s.update(t, cp, 2.2 * (1 - age / f.fade) ** 1.5);
      } else f.s.hide();
    }
    if (t >= T.breakup && t < T.impact) {
      const head = this.lander.update(t, cp, 3.2 - 1.6 * smoothstep(T.impact - 1, T.impact, t));
      if (Math.random() < 0.8) fx.particles.spark(head, rs() * 3, rs() * 3, rs() * 3, 0.4 + Math.random() * 0.5, 0.4 + Math.random() * 0.4, 1.6, 1.5, 2.2);
    } else this.lander.hide();
    // Breakup flash.
    const bf = t >= T.breakup ? Math.exp(-(t - T.breakup) * 5) : 0;
    if (bf > 0.01) fx.flash.set(this.B0, 3 * bf, 6 + 10 * (1 - bf));
    // Impact: flash, sparks, dust, the shard and its glow.
    if (this.fired.has('impact') || t >= T.impact) {
      if (!this.fired.has('impact')) {
        this.fired.add('impact');
        const s = this.S;
        for (let i = 0; i < 140; i++) {
          const a = Math.random() * Math.PI * 2, up = 0.3 + Math.random() * 0.9, sp = 2 + Math.random() * 7;
          fx.particles.spark(_p.set(s.x, this.gS + 0.2, s.z), Math.cos(a) * sp * (1 - up * 0.5), up * sp * 1.2, Math.sin(a) * sp * (1 - up * 0.5), 0.7 + Math.random() * 1.6, 0.05 + Math.random() * 0.08, 1.4, 1.6, 2.4);
        }
        g.dust.burst(s.x, this.gS + 0.1, s.z, 8, 0.5, 1.8, 0.6, 1.6, new THREE.Color(0.24, 0.23, 0.25), 0.3, 0.3);
      }
      const ti = t - T.impact;
      const flash = Math.exp(-ti * 4.5);
      fx.flash.set(_p.set(this.S.x, this.gS + 0.5, this.S.z), 2.2 * flash, 0.8 + 3.2 * (1 - Math.exp(-ti * 8)));
      // The shard shrinks into the player while its light pours out.
      const drain = smoothstep(T.touch, T.collapse, t);
      const pulse = 1 + 0.25 * Math.sin(t * (3 + 6 * drain)) + 0.4 * smoothstep(0, 0.3, ti) * flash;
      fx.shard.visible = true;
      fx.shard.scale.setScalar(Math.min(1, ti * 6) * (1 - 0.8 * drain));
      fx.shardU.uI.value = (1.1 + 1.6 * drain) * pulse;
      fx.shardGlow.set(_p.set(this.S.x, this.gS + 0.35, this.S.z), (0.5 + 0.4 * drain) * pulse * Math.min(1, ti * 4), 0.45 + 0.2 * drain);
      fx.ground.visible = fx.scorch.visible = true;
      fx.groundU.uI.value = (0.55 + 0.6 * drain) * pulse * Math.min(1, ti * 3);
      fx.scorchU.uI.value = Math.min(1, ti * 4);
      if (Math.random() < dt * 14) fx.particles.mote(_p.set(this.S.x + rs() * 0.5, this.gS + 0.1, this.S.z + rs() * 0.5), 2 + Math.random() * 2, 0.02 + Math.random() * 0.025);
      // The streams into the player, and the light gathering in them.
      this.chestOf(fx.particles.target);
      if (t >= T.touch && t < T.collapse) {
        const n = Math.round(dt * (40 + 120 * drain));
        for (let i = 0; i < n; i++) fx.particles.stream(_p.set(this.S.x + rs() * 0.12, this.gS + 0.3 + Math.random() * 0.3, this.S.z + rs() * 0.12), 0.8 + Math.random() * 0.6, 0.025 + Math.random() * 0.03, Math.random() * 6.28);
      }
      fx.chestGlow.set(fx.particles.target, t >= T.touch ? 1.0 * smoothstep(T.touch, T.whiteFull, t) : 0, 0.2 + 0.3 * smoothstep(T.touch, T.whiteFull, t));
    }
    fx.update(dt, t, cam, g.renderer.gl);
  }

  private chestBone: THREE.Object3D | null | undefined;
  /** The player's chest (the spine bone of the rig when it has one: follows the bending). */
  private chestOf(out: THREE.Vector3): THREE.Vector3 {
    const P = this.g.player;
    if (this.chestBone === undefined || (this.chestBone && !this.chestBone.parent)) this.chestBone = P.rig.char?.bones.find((b) => b.name === 'spine04') ?? null;
    if (this.chestBone) return this.chestBone.getWorldPosition(out);
    P.pivot(out);
    out.y -= P.height * 0.12;
    return out;
  }

  // ------------------------------------------------------------------ camera

  private shotOf(t: number): string {
    return t < T.shotB ? 'A' : t < T.shotC ? 'B' : t < T.shotD ? 'C' : t < T.shotE ? 'D' : t < T.whiteFull ? 'E' : t < T.handoff ? 'G' : 'H';
  }

  /** The shot camera at time t (`nominal`: for the warm-up, without the live player / star). */
  private camAt(t: number, nominal = false): CamPose {
    const S = this.S, D = this.D, R = this.R, gS = this.gS;
    const P = this.g.player;
    const off = (o: THREE.Vector3, d: number, r: number, u: number) => o.clone().addScaledVector(D, d).addScaledVector(R, r).addScaledVector(UP, u);
    const shot = this.shotOf(t);
    if (shot === 'A') {
      // Wide; tilting up a little as the star comes.
      const u = t / T.shotB;
      const pos = this.camA.clone().addScaledVector(this.H, 0.8 * u).addScaledVector(UP, -0.3 * u);
      const el = Math.max(0.12, this.elA - 0.32 + 0.1 * smoothstep(T.starOn, T.shotB, t));
      const look = pos.clone().addScaledVector(dirOf(Math.atan2(this.H.x, this.H.z) + 0.04, el), 100);
      if (!nominal && t > T.starOn) look.lerp(this.star.path(t), 0.08 * smoothstep(T.starOn, T.starOn + 2, t));
      return { pos, look, fov: 56 };
    }
    if (shot === 'B') {
      const u = (t - T.shotB) / (T.shotC - T.shotB);
      const pos = this.camB.clone().addScaledVector(this.H, 0.35 * u);
      const base = pos.clone().addScaledVector(dirOf(Math.atan2(this.H.x, this.H.z), this.elA + 0.12), 60);
      const star = nominal ? this.B0.clone() : t < T.breakup ? this.star.path(t) : this.lander.path(t);
      return { pos, look: base.lerp(star.clone().sub(pos).setLength(60).add(pos), 0.55), fov: 64 };
    }
    if (shot === 'C') {
      const u = (t - T.shotC) / (T.shotD - T.shotC);
      const pos = this.camC.clone().lerp(this.lookC, 0.08 * u);
      // Following the fragment down to the ground, then holding on the spot and the player.
      const look = this.lookC.clone();
      if (!nominal && t < T.impact + 0.3) look.lerp(this.lander.path(Math.min(t, T.impact)).clone().sub(pos).setLength(pos.distanceTo(this.lookC)).add(pos), 1 - smoothstep(T.impact - 0.5, T.impact + 0.3, t));
      return { pos, look, fov: 52 };
    }
    if (shot === 'D') {
      const base = nominal ? this.P0 : P.pos;
      const pos = off(base, -2.3, 0.6, 1.7);
      return { pos, look: off(S, 0, 0, 0.25).lerp(off(base, 0, 0, 1.5), 0.25), fov: 55 };
    }
    if (shot === 'E') {
      const u = smoothstep(T.shotE, T.whiteFull, t);
      return { pos: this.camE.p0.clone().lerp(this.camE.p1, u), look: off(S, -0.45, 0, 0.8 + 0.15 * u), fov: 50 };
    }
    // G: from above the lying player, sinking and circling as they get up; H blends from its end.
    const u = smoothstep(T.morning, T.handoff, Math.min(t, T.handoff));
    const pos = this.M.clone().addScaledVector(this.gD, -0.4 - 1.8 * u).addScaledVector(this.gR, 0.9 + 1.7 * u).addScaledVector(UP, 3.6 - 1.7 * u);
    const look = nominal ? off(this.M, 0, 0, 0.3) : (() => { const v = new THREE.Vector3(); P.pivot(v); v.y = lerp(P.pos.y + 0.3, v.y, smoothstep(T.getUp, T.getUp + 3, t)); return v; })();
    return { pos, look, fov: 50 };
  }

  private updateCamera(dt: number, t: number): void {
    const g = this.g, cam = g.renderer.camera;
    const shot = this.shotOf(t);
    const c = this.camAt(t);
    const cut = shot !== this.shot;
    this.shot = shot;
    if (shot === 'H') {
      // Into the gameplay camera (the rig placed behind the player, as at a normal start).
      if (!this.handoffFrom) {
        const P = g.player;
        g.camRig.yaw = P.yaw;
        g.camRig.pitch = -0.2;
        this.handoffFrom = { pos: cam.position.clone(), q: cam.quaternion.clone(), fov: cam.fov };
      }
      g.camRig.update(dt, g.player, ZERO_INPUT);
      const e = smoothstep(T.handoff, T.end - 0.4, t);
      const f = this.handoffFrom;
      cam.position.lerpVectors(f.pos, cam.position, e);
      cam.quaternion.slerpQuaternions(f.q, cam.quaternion.clone(), e);
      const fov = lerp(f.fov, cam.fov, e);
      if (cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
      return;
    }
    // Smooth follow within a shot (the walk's bob, the star's jumps); a cut snaps.
    const k = cut ? 1 : Math.min(1, dt * (shot === 'D' || shot === 'G' ? 5 : 8));
    if (cut) { this.posCur.copy(c.pos); this.lookCur.copy(c.look); }
    this.posCur.lerp(c.pos, k);
    this.lookCur.lerp(c.look, k);
    cam.position.copy(this.posCur);
    // Impact shake.
    if (t > T.impact && t < T.impact + 1.5) {
      const s = 0.18 * Math.exp(-(t - T.impact) * 3.5);
      cam.position.x += Math.sin(t * 61) * s; cam.position.y += Math.sin(t * 47 + 1) * s; cam.position.z += Math.sin(t * 53 + 2) * s;
    }
    cam.lookAt(this.lookCur);
    if (cam.fov !== c.fov || cam.near !== 0.08) { cam.fov = c.fov; cam.near = 0.08; cam.far = 60000; cam.updateProjectionMatrix(); }
  }

  // ------------------------------------------------------------------ the end

  private finish(skipped: boolean): void {
    if (this.ended) return;
    this.ended = true;
    this.active = false;
    const g = this.g, P = g.player;
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('pointerup', this.onPointerUp, true);
    window.removeEventListener('blur', this.onPointerUp);
    this.snd.stop(skipped ? 0.3 : 1.2);
    this.fx.dispose();
    // The normal start: standing at the start spot (a skip puts them there; at the natural end
    // they got up there), the start time, the weather of the schedule, the camera behind them.
    P.action = undefined;
    P.seat = null;
    if (skipped || g.ragdolls.isActive(P) || P.downT > 0) {
      g.ragdolls.release(P);
      P.ragdoll = '';
      P.downT = 0;
      P.pos.copy(this.M);
      P.vel.set(0, 0, 0);
      P.yaw = 0; // as a normal start faces
    }
    g.sky.hour = this.startHour;
    g.sky.day = this.startDay;
    this.restoreWeather();
    g.camRig.yaw = P.yaw;
    g.camRig.pitch = -0.2;
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* storage unavailable */ }
    this.ui?.close();
    this.ui = null;
    window.setTimeout(() => g.powerHud.toast('Help people (<b>E</b>) to earn karma, then press <b>P</b> to awaken your powers.', 'info', 9000), 1600);
    this.onEnd?.();
  }

  private moved = false;
  private weatherBack = false;
  private restoreWeather(): void {
    if (this.weatherBack) return;
    this.weatherBack = true;
    const w = this.g.weather;
    w.override = this.weatherOverride as typeof w.override;
    (w as unknown as { first: boolean }).first = true; // snap to the scheduled weather (no blend)
  }

  /** Called once the scene is over (finished or skipped). */
  onEnd: (() => void) | null = null;
}

const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
/** Unit direction from azimuth (atan2(x, z)) and elevation. */
function dirOf(az: number, el: number): THREE.Vector3 {
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}
const rs = () => Math.random() * 2 - 1;
