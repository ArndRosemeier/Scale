/**
 * Fame: the player's reputation felt in the street (rules and thresholds: fameRules.ts).
 *
 *  - The press (reputation ≥ FAME.pressAt): photographers walk up to the hero, ring them a few metres
 *    off, raise their cameras and flash away (a white flash at the camera, a faint flash on screen up
 *    close, the shutter), calling out ("Over here!"). Sooner after a crime stopped. From FAME.tvAt a TV
 *    crew comes along: a reporter holding out a microphone and a camera operator with the camera on
 *    the shoulder.
 *  - Fans (≥ FAME.fansAt): now and then someone runs up for a photo with their phone (a golden
 *    bubble), and passers-by call out to the hero ("It's the hero!").
 *  - Protesters (< 0): a group with placards gathers near the hero, chants in red bubbles to a drum,
 *    boos when the hero comes close and follows them about at a distance; the more hated, the bigger
 *    the crowd. Passers-by grumble at the hero.
 *  - The statue (HeroStatue): voted, built, unveiled in front of the town hall; pulled down when the
 *    city turns against the hero.
 *
 * They are actors (owner FAME_OWNER: their own budget, the crime layer leaves them be). Danger (a
 * blast, gunfire, a giant close by, a punch) ends it: they run like everyone else. Hitting them is
 * hurting bystanders (the justice layer). Nothing here is kept in saves except the statue.
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import { PState, type PedAgent } from '../../sim/Pedestrians';
import { Role, type Citizen } from '../../sim/Population';
import { makeActor, attach, hold, play, goTo, stand, followRoute, release, FAME_OWNER, type Actor } from '../../sim/actors/Actor';
import { hash32 } from '../../core/rng';
import type { Stimulus } from '../Stimuli';
import { FAME, FAME_LINES, pressCount, protestSize, remarkKind, tvCrew } from './fameRules';
import { PLACARDS, FAN_SIGNS, FAN_SIGNS_FROM } from '../../humanoid/client/placards';
import { HeroStatue } from './HeroStatue';
import { PressPhoto } from './PressPhoto';
import { onScreen, screenPoint, toScreen } from '../../render/screen';

type Kind = 'photo' | 'reporter' | 'camera' | 'fan' | 'protester' | 'admirer';
type Phase = 'come' | 'work' | 'leave';

interface Member {
  a: PedAgent;
  act: Actor;
  kind: Kind;
  /** Place round the hero (an angle offset) and how far off (m). */
  slot: number;
  dist: number;
  flashT: number;
  talkT: number;
  /** A fan's moment: seconds into the photo. */
  t: number;
  done: boolean;
  /** Getting no closer to the hero (s), and the closest yet: stuck somewhere, they give up. */
  stuckT: number;
  best: number;
}

interface Group {
  kind: 'press' | 'fan' | 'protest' | 'crowd';
  members: Member[];
  phase: Phase;
  t: number;
  stay: number;
  /** A protest's spot (it moves with the hero now and then). */
  x: number; z: number;
  saw: boolean;
  booT: number;
  /** The side of the hero they stand on (an angle), fixed until the hero has moved on from (ax, az). */
  base: number; ax: number; az: number;
  /** A photo of this visit went up on the billboards. */
  printed: boolean;
}

/** Groups farther than this from the hero (m) are dropped (unseen) or sent home. */
const DROP_R = 110;
/** Getting no closer for this long (s), farther than 18 m: stuck, they give up. */
const STUCK_T = 25;
const LINE_PAUSE = 7;

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];

export class Fame {
  readonly groups: Group[] = [];
  readonly statue: HeroStatue;
  /** Their photos on the billboards, with a headline. */
  readonly photo: PressPhoto;
  private pressT = 25;
  private fanT = 20;
  private protestT = 20;
  private remarkT = 2;
  private remarked = new WeakSet<PedAgent>();
  private flashes: { s: THREE.Sprite; t: number }[] = [];
  private readonly flashMat: THREE.SpriteMaterial;
  private readonly overlay: HTMLDivElement;
  private overlayT = 0;
  private chant: { set(x: number, y: number, z: number, gain: number, rate?: number): void; stop(): void } | null = null;
  private chantTry = 0;
  private band = 0;
  private nextSeed = 1;
  private devDone = false;
  /** Off: nobody new comes (dev, tests). */
  enabled = true;
  stats = { press: 0, tv: 0, fans: 0, protests: 0, flashes: 0, remarks: 0, panicked: 0 };

  constructor(private g: Game) {
    this.statue = new HeroStatue(g);
    this.photo = new PressPhoto(g);
    // The flash: a small white burst (one shared texture; the sprites are pooled).
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const x = cv.getContext('2d')!;
    const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.85)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(cv);
    this.flashMat = new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(6, 6, 6.4), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
    this.overlay = document.createElement('div');
    this.overlay.id = 'fameflash';
    document.body.appendChild(this.overlay);
    g.stimuli.on((s) => this.onStimulus(s));
    // A crime stopped: the press is on its way.
    g.crime.rep.on((d, v, reason) => {
      if (d > 0 && reason === 'crime stopped' && v >= FAME.pressAt) this.pressT = Math.min(this.pressT, FAME.press.afterDeed);
      this.milestone(v);
    });
    this.band = this.bandOf(g.crime.rep.value);
    // The unveiling: a cheering crowd in front of the statue (when the hero is near enough to see it).
    this.statue.onSignal = (sig) => { if (sig === 'unveiled') this.spawnCrowd(); };
  }

  update(dt: number): void {
    const g = this.g;
    if (!this.devDone) this.installDev();
    const rep = g.crime.rep.value;
    this.statue.update(dt, rep);
    this.photo.update(dt);
    const ok = this.enabled && this.available();
    // New visits.
    this.pressT -= dt; this.fanT -= dt; this.protestT -= dt;
    if (ok && this.pressT <= 0) {
      this.pressT = rand(...FAME.press.gap);
      if (pressCount(rep) > 0 && !this.groups.some((q) => q.kind === 'press')) this.spawnPress(rep);
    }
    if (ok && this.fanT <= 0) {
      this.fanT = rand(...FAME.fan.gap);
      if (rep >= FAME.fansAt && !this.groups.some((q) => q.kind === 'fan')) this.spawnFan();
    }
    if (ok && this.protestT <= 0) {
      this.protestT = rand(...FAME.protest.gap);
      if (protestSize(rep) > 0 && !this.groups.some((q) => q.kind === 'protest')) this.spawnProtest(rep);
    }
    for (let i = this.groups.length - 1; i >= 0; i--) this.step(this.groups[i], dt, rep, ok);
    this.remarkT -= dt;
    if (this.remarkT <= 0) { this.remarkT = 1.2; if (ok) this.remark(rep); }
    this.drawFlashes(dt);
    this.sound(dt);
  }

  // ================================================================== when

  /** The hero out in the street, human-sized, on foot (no press on a rooftop, in the sewer or mid-air). */
  private available(): boolean {
    const g = this.g, P = g.player;
    if (g.freeCam || g.defeat.active || g.intro?.active || P.flying || P.height > 3.5 || P.height < 0.8) return false;
    const p = P.pos;
    if (g.underground.isUnder(p.x, p.y + 0.5, p.z) || g.indoorsAt(p.x, p.y + 1, p.z)) return false;
    return p.y - g.world.groundHeight(p.x, p.z) < 2.5;
  }

  private bandOf(rep: number): number {
    return rep >= FAME.statueAt ? 3 : rep >= FAME.fansAt ? 2 : rep >= FAME.pressAt ? 1 : rep < FAME.protestAt ? -1 : 0;
  }

  /** A short word when the reputation crosses into a new band (once per crossing). */
  private milestone(rep: number): void {
    const b = this.bandOf(rep), was = this.band;
    if (b === was) return;
    this.band = b;
    const H = this.g.powerHud;
    if (b > was && b === 1) H.toast('<b>The press has noticed you</b> — expect photographers when you are out and about', 'info', 6000);
    else if (b > was && b === 2) H.toast('<b>You have fans now</b> — people call out to you and want photos', 'info', 6000);
    else if (b > was && b === 3 && this.statue.state !== 'standing') H.toast('<b>The city adores you</b> — the council is talking about a statue', 'info', 6000);
    else if (b === -1 && was >= 0) H.toast('<b>People are turning against you</b> — expect protests and a cold shoulder', 'warn', 6000);
  }

  // ================================================================== spawning

  /** A grown-up passer-by to play the part (deterministic per seed). */
  private citizen(seed: number): Citizen | null {
    const pop = this.g.population;
    for (let k = 0; k < 30; k++) {
      const c = pop.synthetic(hash32(seed * 7919 + k * 104729 + 17) || 1);
      if (c.role !== Role.Child && !this.g.peds.agentOf(c.id)) return c;
    }
    return null;
  }

  /**
   * Where a group comes from: a sidewalk point `r0`–`r1` m from the hero, out of view if possible,
   * with a route to them. Null: nowhere to come from.
   */
  private origin(r0: number, r1: number): { x: number; z: number; route: Float32Array | null } | null {
    const g = this.g, p = g.player.pos, cy = g.camRig.forwardYaw;
    let fallback: { x: number; z: number; route: Float32Array | null } | null = null;
    for (let k = 0; k < 10; k++) {
      // (Behind the camera first, then round about.)
      const a = cy + Math.PI + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.55;
      const d = rand(r0, r1);
      let x = p.x - Math.sin(a) * d, z = p.z - Math.cos(a) * d;
      if (!g.world.standable(x, z)) continue;
      const r = g.peds.buildRoute(x, z, p.x, p.z);
      if (!r || r.length < 6) continue;
      x = r[3]; z = r[4];
      const dd = Math.hypot(x - p.x, z - p.z);
      if (!g.world.standable(x, z) || dd < r0 * 0.6 || dd > r1 * 1.2) continue;
      const route = g.peds.buildRoute(x, z, p.x, p.z);
      const o = { x, z, route };
      if (!g.crime.visible(x, g.world.groundHeight(x, z) + 1.2, z)) return o;
      fallback ??= o;
    }
    return fallback;
  }

  private add(q: Group, kind: Kind, x: number, z: number, route: Float32Array | null, slot: number, dist: number, held: string | null, title: string): Member | null {
    const g = this.g;
    const c = this.citizen(this.nextSeed++ + g.settings.seed);
    if (!c) return null;
    // (A little apart from each other.)
    const jx = x + rand(-1.2, 1.2), jz = z + rand(-1.2, 1.2);
    const a = g.peds.spawnAt(c, g.world.standable(jx, jz) ? jx : x, g.world.standable(jx, jz) ? jz : z, Math.atan2(-(g.player.pos.x - x), -(g.player.pos.z - z)));
    if (!a) return null;
    const act = attach(a, makeActor('bystander', FAME_OWNER, { title, held, hp: 40, maxHp: 40 }));
    if (route) { act.route = Float32Array.from(route); act.wp = 1; }
    const m: Member = { a, act, kind, slot, dist, flashT: rand(0.5, 2), talkT: rand(1, 4), t: 0, done: false, stuckT: 0, best: 1e9 };
    q.members.push(m);
    return m;
  }

  private group(kind: Group['kind'], stay: number, x: number, z: number): Group {
    const q: Group = { kind, members: [], phase: 'come', t: 0, stay, x, z, saw: false, booT: 0, base: 0, ax: 1e9, az: 1e9, printed: false };
    this.groups.push(q);
    return q;
  }

  spawnPress(rep: number): boolean {
    const o = this.origin(28, 42);
    if (!o) return false;
    const q = this.group('press', FAME.press.stay, o.x, o.z);
    const n = pressCount(rep);
    for (let i = 0; i < n; i++) this.add(q, 'photo', o.x, o.z, o.route, (i - (n - 1) / 2) * 0.75, rand(...FAME.press.ring), 'presscam', 'Press photographer');
    if (tvCrew(rep)) {
      this.add(q, 'reporter', o.x, o.z, o.route, 1.25, 2.4, 'mic', 'TV reporter');
      this.add(q, 'camera', o.x, o.z, o.route, 0.95, 5.2, 'tvcam', 'Camera operator');
      this.stats.tv++;
    }
    if (!q.members.length) { this.groups.pop(); return false; }
    this.stats.press++;
    return true;
  }

  spawnFan(): boolean {
    const o = this.origin(18, 30);
    if (!o) return false;
    const q = this.group('fan', 40, o.x, o.z);
    if (!this.add(q, 'fan', o.x, o.z, o.route, rand(-0.6, 0.6), FAME.fan.near, 'phone', 'Fan')) { this.groups.pop(); return false; }
    this.stats.fans++;
    return true;
  }

  spawnProtest(rep: number): boolean {
    const o = this.origin(30, 45);
    if (!o) return false;
    const q = this.group('protest', FAME.protest.stay, o.x, o.z);
    const n = protestSize(rep);
    for (let i = 0; i < n; i++) {
      // Most carry a placard (the harsher ones when the city hates the hero).
      const sign = i % 4 === 3 ? null : `placard_${(i * 3 + this.nextSeed + (rep < -50 ? 6 : 0)) % PLACARDS.length}`;
      this.add(q, 'protester', o.x, o.z, o.route, i, 0, sign, 'Protester');
    }
    if (!q.members.length) { this.groups.pop(); return false; }
    this.stats.protests++;
    return true;
  }

  /** The unveiling's crowd: admirers with signs in an arc in front of the statue, cheering. */
  spawnCrowd(): boolean {
    const g = this.g, S = this.statue.site, p = g.player.pos;
    if (!S || Math.hypot(p.x - S.x, p.z - S.z) > 160) return false;
    const fx = -Math.sin(S.yaw), fz = -Math.cos(S.yaw);
    const q = this.group('crowd', 50, S.x + fx * 7.5, S.z + fz * 7.5);
    const n = 9;
    for (let i = 0; i < n; i++) {
      const a = (i - (n - 1) / 2) * 0.26;
      const d = 6.5 + (i % 2) * 1.6;
      // (Out of the statue's facing: an arc in front of it.)
      const dx = fx * Math.cos(a) - fz * Math.sin(a), dz = fz * Math.cos(a) + fx * Math.sin(a);
      const x = S.x + dx * (d + 14), z = S.z + dz * (d + 14);
      const m = this.add(q, 'admirer', x, z, null, a, d, i % 3 === 1 ? 'phone' : `placard_${FAN_SIGNS_FROM + (i % FAN_SIGNS.length)}`, 'Admirer');
      if (m) m.t = 0;
    }
    if (!q.members.length) { this.groups.pop(); return false; }
    return true;
  }

  // ================================================================== per frame

  private step(q: Group, dt: number, rep: number, ok: boolean): void {
    const g = this.g, p = g.player.pos;
    q.t += dt;
    q.booT -= dt;
    // Members taken over by something else (a ragdoll, a crime), hit, knocked down: theirs no longer.
    for (const m of q.members) {
      if (m.done) continue;
      const a = m.a, act = m.act;
      if (!a.alive || a.actor !== act) { m.done = true; continue; }
      if (act.hitByPlayer || a.state === PState.Down || act.state === 'down' || act.state === 'ko' || act.staggerT > 0) { this.panic(q, p.x, p.z); return; }
      // Stuck on the way (no way round a wall, a rotunda): they give up and go about their day.
      const dh = Math.hypot(a.x - p.x, a.z - p.z);
      if (dh < m.best - 0.5 || dh < 18) { m.best = dh; m.stuckT = 0; }
      else if (q.phase !== 'leave' && (m.stuckT += dt) > STUCK_T) { m.done = true; release(a); }
    }
    q.members = q.members.filter((m) => !m.done);
    if (!q.members.length) { this.drop(q); return; }
    const near = Math.min(...q.members.map((m) => Math.hypot(m.a.x - p.x, m.a.z - p.z)));
    // A giant, gone far, the visit over, the mood changed: leave.
    if (g.player.height > 6 && near < 14 * g.player.height) { this.panic(q, p.x, p.z); return; }
    if (q.phase !== 'leave') {
      const over = q.t > q.stay || near > DROP_R * (q.kind === 'crowd' ? 2 : 1) || (!ok && q.t > 12 && q.kind !== 'crowd')
        || (q.kind === 'protest' && rep >= FAME.protestAt) || (q.kind !== 'protest' && rep < FAME.pressAt - 10) || (q.kind === 'crowd' && this.statue.state !== 'standing');
      if (over) this.leave(q);
    }
    if (q.phase === 'leave') {
      // (Out of sight and far enough: gone.)
      for (const m of q.members) if (m.a.actor === m.act && near > 40 && !g.crime.visible(m.a.x, m.a.y + 1, m.a.z)) m.a.alive = false;
      if (q.t > 1.5) this.dismiss(q);
      return;
    }
    switch (q.kind) {
      case 'press': this.stepPress(q, dt); break;
      case 'fan': this.stepFan(q, dt); break;
      case 'protest': this.stepProtest(q, dt); break;
      case 'crowd': this.stepCrowd(q, dt); break;
    }
  }

  /** Walk up (the route, then straight in) to a spot round the hero: true when there. */
  private approach(m: Member, tx: number, tz: number, speed: number): boolean {
    const a = m.a, act = m.act, p = this.g.player.pos;
    const d = Math.hypot(tx - a.x, tz - a.z);
    if (d < 0.7) { stand(act); return true; }
    // Far off: the sidewalks (a new route now and then, the hero moves on); close: straight there.
    const far = Math.hypot(p.x - a.x, p.z - a.z) > 18;
    // The route leads no nearer (a detour round a square, a park): straight there instead.
    if (m.stuckT > 5 && act.route) { act.route = null; act.replanT = 10; }
    if (far && (!act.route || act.wp * 3 >= act.route.length) && act.replanT <= 0) {
      act.replanT = 3;
      const r = this.g.peds.buildRoute(a.x, a.z, tx, tz);
      // (A route that ends no nearer than here — the hero on a square, a plaza, off the sidewalks — is no use: straight across.)
      const n = r ? r.length : 0;
      act.route = r && n >= 3 && Math.hypot(r[n - 3] - tx, r[n - 2] - tz) < d - 6 ? r : null;
      act.wp = 1;
      if (!act.route) act.replanT = 10;
    }
    if (act.route && far && followRoute(a, act, speed)) return false;
    // At the route's end, still far: straight on for a while rather than round the block again.
    if (act.route) act.replanT = Math.max(act.replanT, 10);
    act.route = null;
    goTo(act, tx, tz, d > 4 ? speed : Math.min(speed, 1.3));
    return false;
  }

  /** The side the group stands on: the camera's side of the hero (where it is seen), kept while the hero stays put. */
  private anchor(q: Group): void {
    const g = this.g, p = g.player.pos, c = g.renderer.camera.position;
    if (Math.hypot(p.x - q.ax, p.z - q.az) < 6) return;
    q.ax = p.x; q.az = p.z;
    q.base = Math.atan2(c.x - p.x, c.z - p.z);
  }

  /** The spot `m` wants round the hero: its slot on the group's side. */
  private spot(q: Group, m: Member): { x: number; z: number } {
    const g = this.g, p = g.player.pos;
    const a = q.base + m.slot;
    let x = p.x + Math.sin(a) * m.dist, z = p.z + Math.cos(a) * m.dist;
    // (Not inside a wall or a landmark: closer in.)
    const inside = (x: number, z: number) => !!g.world.buildingAt(x, z) || !!g.world.landmarks?.hit(x, p.y + 1, z);
    for (let k = 0; k < 4 && inside(x, z); k++) { x = (x + p.x) / 2; z = (z + p.z) / 2; }
    return { x, z };
  }

  private faceHero(act: Actor): void {
    const P = this.g.player;
    act.face = { x: P.pos.x, y: P.pos.y + P.height * 0.85, z: P.pos.z };
  }

  private stepPress(q: Group, dt: number): void {
    const g = this.g, p = g.player.pos;
    this.anchor(q);
    for (const m of q.members) {
      const a = m.a, act = m.act;
      const s = this.spot(q, m);
      // (Keep the spot while the hero stands about; hurry after one walking off.)
      const there = this.approach(m, s.x, s.z, Math.hypot(p.x - a.x, p.z - a.z) > 14 ? 3.4 : 2.2);
      const dp = Math.hypot(p.x - a.x, p.z - a.z);
      if (dp < 14) this.faceHero(act); else act.face = null;
      if (!there && dp > m.dist + 2) { if (act.action && act.action.id !== 'pickup') act.action = null; continue; }
      if (!q.saw) { q.saw = true; this.say(m, pick(m.kind === 'reporter' ? FAME_LINES.tv : FAME_LINES.press)); }
      if (m.kind === 'photo') {
        if (!act.action || act.action.id === 'take_photo') hold(act, 'take_photo', 1.4);
        m.flashT -= dt;
        // (The camera is up most of the 3 s cycle.)
        if (m.flashT <= 0 && (act.action?.age ?? 0) % 3 > 0.45 && (act.action?.age ?? 0) % 3 < 2.5) {
          m.flashT = rand(...FAME.press.flashGap);
          this.flash(a, 1.62, 0.32);
          // The first good shot of a visit goes on the billboards (taken from their camera).
          if (!q.printed && this.photo.ready && dp < 12) {
            q.printed = true;
            const P = this.g.player;
            if (this.photo.snap(a.x - Math.sin(a.heading) * 0.45, a.y + 1.62, a.z - Math.cos(a.heading) * 0.45, this.g.crime.rep.value, this.g.people?.streetAt(P.pos.x, P.pos.z) ?? null))
              this.g.powerHud.toast(`Your photo is on the billboards: <b>${this.photo.headline}</b>`, 'info', 5000);
          }
        }
      } else if (m.kind === 'reporter') {
        if (!act.action || act.action.id === 'interview') hold(act, 'interview', 1.4);
      } else if (m.kind === 'camera') {
        if (!act.action || act.action.id === 'shoulder_cam') hold(act, 'shoulder_cam', 1.4);
      }
      m.talkT -= dt;
      if (m.talkT <= 0) {
        m.talkT = rand(6, 12);
        if (dp < 16) this.say(m, pick(m.kind === 'reporter' ? (Math.random() < 0.5 ? FAME_LINES.tv : FAME_LINES.pressQ) : m.kind === 'camera' ? FAME_LINES.press : Math.random() < 0.7 ? FAME_LINES.press : FAME_LINES.pressQ));
      }
    }
  }

  private stepFan(q: Group, dt: number): void {
    const p = this.g.player.pos;
    this.anchor(q);
    for (const m of q.members) {
      const a = m.a, act = m.act;
      if (m.t === 0) {
        const s = this.spot(q, m);
        const there = this.approach(m, s.x, s.z, 3.6);
        if (Math.hypot(p.x - a.x, p.z - a.z) < 12) this.faceHero(act);
        if (!there) continue;
        // There: a word, the phone up, a flash, a cheer — then off they go.
        m.t = dt;
        this.say(m, pick(FAME_LINES.fan), 'cheer');
        play(act, 'gesture_point', 2.2);
        continue;
      }
      m.t += dt;
      this.faceHero(act);
      if (m.t > 1.1 && m.flashT > 0) { m.flashT = 0; this.flash(a, 1.5, 0.45, 0.5); }
      if (m.t > 2.4 && m.t - dt <= 2.4) { play(act, 'cheer', 1.6); this.say(m, pick(FAME_LINES.fanThanks), 'cheer'); }
      if (m.t > 4.2) this.leave(q);
    }
  }

  private stepCrowd(q: Group, dt: number): void {
    const S = this.statue.site!, P = this.g.player, p = P.pos;
    const fx = -Math.sin(S.yaw), fz = -Math.cos(S.yaw);
    for (const m of q.members) {
      const a = m.a, act = m.act;
      const dx = fx * Math.cos(m.slot) - fz * Math.sin(m.slot), dz = fz * Math.cos(m.slot) + fx * Math.sin(m.slot);
      const there = this.approach(m, S.x + dx * m.dist, S.z + dz * m.dist, 2.6);
      // Looking at the statue, or at the hero when they are close.
      const dp = Math.hypot(p.x - a.x, p.z - a.z);
      act.face = dp < 8 ? { x: p.x, y: p.y + P.height * 0.85, z: p.z } : { x: S.x, y: S.y + 5, z: S.z };
      if (!there) continue;
      m.talkT -= dt;
      if (m.talkT <= 0) {
        m.talkT = rand(5, 11);
        play(act, Math.random() < 0.6 ? 'cheer' : 'gesture_wave', 1.6);
        if (Math.random() < 0.4) this.say(m, pick(dp < 10 ? FAME_LINES.hail : FAME_LINES.statue), 'cheer');
      }
      m.flashT -= dt;
      if (m.act.held === 'phone' && m.flashT <= 0) { m.flashT = rand(3, 7); this.flash(a, 1.5, 0.4, 0.5); }
    }
  }

  private stepProtest(q: Group, dt: number): void {
    const g = this.g, P = g.player, p = P.pos;
    // The protest's spot: `follow` m from the hero on the camera's side; it moves when the hero has
    // gone too far from it (or come too close).
    const dq = Math.hypot(q.x - p.x, q.z - p.z);
    const [f0, f1] = FAME.protest.follow;
    if (dq > f1 + 6 || dq < f0 - 3 || q.t < dt * 1.5) {
      const c = g.renderer.camera.position, base = Math.atan2(c.x - p.x, c.z - p.z) + rand(-0.5, 0.5), d = (f0 + f1) / 2;
      let x = p.x + Math.sin(base) * d, z = p.z + Math.cos(base) * d;
      for (let k = 0; k < 4 && !g.world.standable(x, z); k++) { x = (x + p.x) / 2; z = (z + p.z) / 2; }
      q.x = x; q.z = z;
    }
    const n = q.members.length;
    const fx = p.x - q.x, fz = p.z - q.z, fl = Math.hypot(fx, fz) || 1;
    let gathered = 0;
    q.members.forEach((m, i) => {
      const a = m.a, act = m.act;
      // A loose crowd: rows across the line to the hero.
      const row = Math.floor(i / 5), col = (i % 5) - Math.min(4, n - 1 - row * 5) / 2;
      const tx = q.x + (-fz / fl) * col * 1.15 - (fx / fl) * row * 1.3, tz = q.z + (fx / fl) * col * 1.15 - (fz / fl) * row * 1.3;
      const there = this.approach(m, tx, tz, 2.4);
      const dp = Math.hypot(p.x - a.x, p.z - a.z);
      if (dp < 30) this.faceHero(act); else act.face = null;
      if (!there && dp > f1 + 4) { if (act.action?.id === 'chant') act.action = null; return; }
      gathered++;
      if (!act.action || act.action.id === 'chant') hold(act, 'chant', 1.4);
    });
    if (!gathered) return;
    const near = Math.min(...q.members.map((m) => Math.hypot(m.a.x - p.x, m.a.z - p.z)));
    if (!q.saw && near < f1 + 4) {
      q.saw = true;
      const m = pick(q.members);
      this.say(m, pick(FAME_LINES.protestSee), 'angry');
      play(m.act, 'gesture_point', 1.6);
    }
    // The hero walks right up to them: they boo.
    if (near < 6 && q.booT <= 0) {
      q.booT = 14;
      g.audio.play('crowd_boo', q.x, p.y + 1.5, q.z, 0.9, 0.95 + Math.random() * 0.1, 8, g.renderer.camera.position);
      this.say(pick(q.members), pick(FAME_LINES.boo), 'angry');
    }
    // A chant now and then.
    for (const m of q.members) {
      m.talkT -= dt;
      if (m.talkT > 0) continue;
      m.talkT = rand(9, 16);
      if (Math.random() < 0.45) this.say(m, pick(FAME_LINES.chant), 'angry');
    }
  }

  // ================================================================== words and flashes

  private say(m: Member, line: string, tone?: 'angry' | 'cheer'): void {
    if (this.g.barks?.say(m.a, line, LINE_PAUSE, tone)) this.stats.remarks++;
  }

  /** Passers-by close to the hero call out to them (or grumble), once each. */
  private remark(rep: number): void {
    const g = this.g, p = g.player.pos;
    const kind = remarkKind(rep);
    if (!kind) return;
    for (const a of g.peds.neighbours(p.x, p.z, 7, [])) {
      if (a.actor || a.inside || this.remarked.has(a) || (a.state !== PState.Walk && a.state !== PState.Idle && a.state !== PState.Wait)) continue;
      this.remarked.add(a);
      // (Not everyone: about one in three.)
      if (Math.random() > 0.35) continue;
      if (g.barks.say(a, pick(kind === 'hail' ? FAME_LINES.hail : FAME_LINES.boo), 25, kind === 'hail' ? 'cheer' : 'angry')) {
        this.stats.remarks++;
        a.glance = 2;
        a.lookX = p.x; a.lookY = p.y + g.player.height * 0.85; a.lookZ = p.z;
      }
      return;
    }
  }

  /** A camera flash at the person's camera (`up` m high, `fwd` m in front of them). */
  private flash(a: PedAgent, up: number, fwd: number, size = 1): void {
    const g = this.g;
    const x = a.x - Math.sin(a.heading) * fwd, y = a.y + up, z = a.z - Math.cos(a.heading) * fwd;
    let f = this.flashes.find((q) => q.t <= 0);
    if (!f) {
      if (this.flashes.length >= 8) return;
      const s = new THREE.Sprite(this.flashMat);
      s.renderOrder = 10;
      g.renderer.scene.add(s);
      f = { s, t: 0 };
      this.flashes.push(f);
    }
    f.t = 0.12;
    f.s.position.set(x, y, z);
    f.s.scale.setScalar(0.9 * size);
    f.s.visible = true;
    this.stats.flashes++;
    const cam = g.renderer.camera.position, d = cam.distanceTo(f.s.position);
    g.audio.play('camera_shutter', x, y, z, 0.5, 0.95 + Math.random() * 0.1, 3, cam);
    // Up close and facing the camera: the screen flashes faintly.
    if (d < 14 && !g.map.open) {
      if (onScreen(toScreen(x, y, z, g.renderer.camera, screenPoint()), 0.999)) this.overlayT = Math.max(this.overlayT, 0.1 * (1 - d / 14) + 0.04);
    }
  }

  private drawFlashes(dt: number): void {
    for (const f of this.flashes) {
      if (f.t <= 0) { f.s.visible = false; continue; }
      f.t -= dt;
      f.s.scale.multiplyScalar(0.9);
      if (f.t <= 0) f.s.visible = false;
    }
    this.overlayT = Math.max(0, this.overlayT - dt * 0.9);
    this.overlay.style.opacity = this.overlayT > 0.002 ? (this.overlayT * 4).toFixed(3) : '0';
  }

  /** The protest's chant: one positional loop at the nearest gathered protest. */
  private sound(dt: number): void {
    const g = this.g, cam = g.renderer.camera.position;
    const q = this.groups.find((x) => x.kind === 'protest' && x.phase !== 'leave' && x.members.some((m) => m.act.action?.id === 'chant'));
    this.chantTry -= dt;
    if (q && !this.chant && this.chantTry <= 0) { this.chantTry = 2; this.chant = g.audio.loop('protest_chant', 9); }
    if (!this.chant) return;
    if (q && Math.hypot(q.x - cam.x, q.z - cam.z) < 90) this.chant.set(q.x, g.player.pos.y + 1.6, q.z, Math.min(1, 0.35 + q.members.length * 0.06));
    else this.chant.set(cam.x, -1000, cam.z, 0);
  }

  // ================================================================== endings

  /** Danger near them: the visit is over, they run. */
  private onStimulus(s: Stimulus): void {
    if (!this.groups.length) return;
    for (const q of [...this.groups]) {
      if (q.phase === 'leave' && !q.members.length) continue;
      const d = Math.min(...q.members.map((m) => Math.hypot(m.a.x - s.x, m.a.z - s.z)));
      if (d > s.radius) continue;
      const prox = 1 - d / s.radius;
      switch (s.kind) {
        case 'blast': case 'collapse': case 'sonic': case 'roar': case 'threat': case 'gunfire': this.panic(q, s.x, s.z); break;
        case 'power': if (prox > 0.25) this.panic(q, s.x, s.z); break;
        case 'crash': if (d < 20) this.panic(q, s.x, s.z); break;
        case 'stomp': if ((s.size ?? 0) > 4 && prox > 0.2) this.panic(q, s.x, s.z); break;
        case 'siren': if (s.evac) this.dismiss(q); break;
        default: break;
      }
    }
  }

  private panic(q: Group, fx: number, fz: number): void {
    this.stats.panicked++;
    for (const m of q.members) {
      const a = m.a;
      if (!a.alive || a.actor !== m.act) continue;
      a.actor = undefined;
      if (a.state === PState.Down) continue;
      a.state = PState.Flee; a.fear = Math.max(a.fear, 1.1); a.fearX = fx; a.fearZ = fz; a.stateT = 0;
    }
    this.drop(q);
  }

  /** The visit is over: a last line, then they walk off (handed back to the street a moment later). */
  private leave(q: Group): void {
    if (q.phase === 'leave') return;
    q.phase = 'leave';
    q.t = 0;
    for (const m of q.members) { stand(m.act); m.act.action = null; m.act.face = null; }
    const m = q.members[0];
    if (m && q.kind === 'protest') this.say(m, pick(['We\'ll be back!', 'This isn\'t over!', 'Shame!']), 'angry');
  }

  private dismiss(q: Group): void {
    for (const m of q.members) if (m.a.alive && m.a.actor === m.act) release(m.a);
    this.drop(q);
  }

  private drop(q: Group): void {
    const i = this.groups.indexOf(q);
    if (i >= 0) this.groups.splice(i, 1);
  }

  // ================================================================== saves, dev

  save(): { statue: ReturnType<HeroStatue['save']> } { return { statue: this.statue.save() }; }
  restore(o: unknown): void {
    const s = o && typeof o === 'object' ? (o as { statue?: unknown }).statue : null;
    this.statue.restore(s as Parameters<HeroStatue['restore']>[0]);
  }

  status(): Record<string, unknown> {
    const p = this.g.player.pos;
    return {
      rep: this.g.crime.rep.value, enabled: this.enabled, available: this.available(),
      next: { press: Math.round(this.pressT), fan: Math.round(this.fanT), protest: Math.round(this.protestT) },
      groups: this.groups.map((q) => ({ kind: q.kind, phase: q.phase, t: Math.round(q.t), n: q.members.length, d: Math.round(Math.min(...q.members.map((m) => Math.hypot(m.a.x - p.x, m.a.z - p.z)))) })),
      statue: this.statue.status(), photo: this.photo.status(), stats: { ...this.stats },
    };
  }

  private installDev(): void {
    const dev = (window as unknown as { dev?: Record<string, unknown> }).dev;
    if (!dev) return;
    this.devDone = true;
    const g = this.g;
    const setRep = (v: number) => { g.crime.rep.add(v - g.crime.rep.value, 'dev'); return g.crime.rep.value; };
    dev.fame = {
      fame: this,
      /** What is going on: groups, timers, the statue. */
      status: () => this.status(),
      /** Set the reputation (−100 and up, no upper limit). */
      rep: (v: number) => setRep(v),
      /** Bring them now: the press (with a TV crew at ≥ 65), a fan, a protest (sized by the reputation). */
      press: () => (this.spawnPress(Math.max(g.crime.rep.value, FAME.pressAt)) ? this.status() : 'nowhere to come from'),
      tv: () => (this.spawnPress(Math.max(g.crime.rep.value, FAME.tvAt)) ? this.status() : 'nowhere to come from'),
      fan: () => (this.spawnFan() ? this.status() : 'nowhere to come from'),
      protest: (rep?: number) => (this.spawnProtest(Math.min(rep ?? g.crime.rep.value, -1)) ? this.status() : 'nowhere to come from'),
      /** Put a press photo up now (from 6 m in front of the hero). */
      photo: () => { const P = g.player, y = g.camRig.forwardYaw; this.photo.snap(P.pos.x - Math.sin(y) * 6, P.pos.y + 1.6, P.pos.z - Math.cos(y) * 6, g.crime.rep.value, null); return this.photo.status(); },
      clear: () => { for (const q of [...this.groups]) this.dismiss(q); return 'cleared'; },
      /** The statue: 'build' (start building), 'unveil' (now), 'topple', 'remove'; 'go' walks the hero there. */
      statue: (what?: 'build' | 'unveil' | 'topple' | 'remove' | 'go') => this.statue.dev(what),
      on: (v = true) => (this.enabled = v),
      tuning: FAME,
    };
  }
}
