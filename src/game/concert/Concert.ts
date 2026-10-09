/**
 * The stadium concert: every evening the stadium puts on a show (plan.ts says when and where).
 *
 *  - The stage stands on the pitch from the doors opening until the crowd has gone (Stage.ts): the
 *    LED wall, the moving beams, searchlights over the city after dark, pyro on the big moments.
 *  - The band (VELA: a singer, guitar, bass, keys, drums) are actors on the deck (CONCERT_OWNER):
 *    the singer works the front of the stage, talks to the crowd between songs (speech bubbles),
 *    the band bows at the end.
 *  - The audience: the pit in front of the stage is people (actors, `crowd`: bouncing on the beat
 *    with the 'groove' action, cheering between songs) near the player; the stands are drawn-only
 *    figures (CrowdRenderer.figures) that groove on the beat too, out to 650 m.
 *  - The music: the night's set list (public/music/live.json: Arnd's Lyria songs; until they come,
 *    pieces of the score stand in) is streamed from the stage (Audio.stream) and heard across the
 *    district, duller and quieter with distance. The show keeps its own clock: it goes on unheard
 *    while the player is away, and one arriving late joins the song where it is. The score's music
 *    stays quiet near the show (Music: hush).
 *  - Danger at the stadium (a blast, a monster, gunfire, a giant hero, a punch in the pit) ends the
 *    show for the night: the music stops, the band runs off, the pit runs for the gate and the
 *    stands empty out.
 *
 * Dev (console): dev.concert.status(), dev.concert.start() (a show now, whatever the hour),
 * dev.concert.go('pit' | 'stand' | 'stage' | 'far'), dev.concert.next() (skip to the next song),
 * dev.concert.panic(), dev.concert.stop().
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import { PState, type PedAgent } from '../../sim/Pedestrians';
import { Role, type Citizen } from '../../sim/Population';
import { makeActor, attach, hold, play, goTo, stand, CONCERT_OWNER } from '../../sim/actors/Actor';
import type { CrowdFigure } from '../../sim/CrowdRenderer';
import type { LiveStream } from '../../audio/Audio';
import type { Stimulus } from '../Stimuli';
import type { Obstacle } from '../../world/Collision';
import { G } from '../../render/materials/globals';
import { hash32, deriveSeed, Rng } from '../../core/rng';
import { clamp, smoothstep } from '../../core/math';
import { cityName } from '../../plan/names';
import { musicianCostume, type MusicianPart } from '../street/costume';
import { SHOW, SHOW_END, concertAt, concertPlan, parseLive, setList, STAGE, PIT_CAP, type ConcertPlan, type ConcertPhase, type LiveSong, type BandRole } from './plan';
import { Stage } from './Stage';

const BASE = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';

/** The pit is filled while the player is within PIT_R of the stage (m); its people go beyond PIT_DROP. */
const PIT_R = 420, PIT_DROP = 520;
/** The band is on the deck within this (m). */
const BAND_R = 700;
/** The music is streamed within this (m); beyond, the show goes on unheard. */
const HEAR_R = 1600;
/** New people in the pit per frame (spawning costs). */
const PIT_PER_FRAME = 14;
/** Room left in the pedestrian budget (Pedestrians MAX_AGENTS 2600): far walkers make way above it. */
const PEDS_ROOM = 2560;
/** Seconds before the first song, and between songs. */
const INTRO_GAP = 9, GAP = 16;
/** Music level (the songs are mastered loud) and the distance it is heard at full level (m). */
const LEVEL = 0.9, REF = 38;
/** The wash on the band (candela; it hangs ~16 m from them). */
const WASH = 420;

type Item = { kind: 'gap'; dur: number } | { kind: 'song'; dur: number; song: LiveSong };

interface Fan { a: PedAgent; i: number; cheerT: number }

interface Player { a: PedAgent; role: BandRole; home: { x: number; z: number }; floor: (x: number, z: number) => number | null }

export class Concert {
  readonly plan: ConcertPlan | null;
  private stage: Stage | null = null;
  /**
   * The front-of-house wash on the band (the one real light of the show: the beams are only drawn).
   * Always in the scene, dark outside the show: a light coming and going would change every lit
   * material's shader (a recompile of the whole city).
   */
  private wash: THREE.SpotLight | null = null;
  private live: ReturnType<typeof parseLive> | null = null;
  private liveState: 'idle' | 'loading' | 'ready' = 'idle';
  /** The show tonight: its running order and clock (s), the day it is for. */
  private show: { day: number; items: Item[]; clock: number; ended: boolean; cancelled: boolean; lastStarted: number } | null = null;
  private stream: { s: LiveStream; song: LiveSong; item: number } | null = null;
  private fans: Fan[] = [];
  private band: Player[] = [];
  private figures: CrowdFigure[] = [];
  private crowdLoop: { set(x: number, y: number, z: number, gain: number, rate?: number): void; stop(): void } | null = null;
  private loopTry = 0;
  private time = 0;
  /** Dev: a show now (whatever the hour), until its set list is done. */
  private forced = false;
  private devDone = false;
  /** Seconds the singer waits before the next line, and has the next walk. */
  private talkT = 0;
  private walkT = 0;
  private lastItem = -1;
  private beat = NaN;
  private energy = 0;
  private city: string;
  stats = { fans: 0, figures: 0, songs: 0, panics: 0 };

  constructor(private g: Game) {
    const lm = g.macro.landmarks.find((l) => l.kind === 'stadium') ?? null;
    this.plan = lm ? concertPlan(lm, g.settings.seed) : null;
    this.city = cityName(g.settings.seed);
    if (!this.plan) return;
    g.stimuli.on((s) => this.onStimulus(s));
    g.collision.obstacleProviders.push(this.provider);
    g.crowd.figures = this.figures;
    const P = this.plan, [wx, wz] = P.onStage(STAGE.d + 9, 0), [tx, tz] = P.onStage(STAGE.d * 0.55, 0);
    this.wash = new THREE.SpotLight(0xfff0e2, 0, 45, 0.72, 0.55, 2);
    this.wash.position.set(wx, P.stage.deckY + 9, wz);
    this.wash.target.position.set(tx, P.stage.deckY + 1, tz);
    g.renderer.scene.add(this.wash, this.wash.target);
  }

  /** A street band's piece for a style (public/music/live.json `bands`), or null (none yet). */
  bandFile(style: string): string | null {
    this.loadLive();
    return this.live?.bands[style] ?? null;
  }

  /** The score's music keeps quiet here: the show's music is heard. */
  hushes(x: number, z: number): boolean {
    const P = this.plan;
    if (!P || !this.stream) return false;
    return Math.hypot(x - P.stage.x, z - P.stage.z) < 450;
  }

  /** Where in the evening it is (dev: a show now). */
  private phase(): { phase: ConcertPhase; day: number; t: number } {
    const at = concertAt(this.g.sky.hoursAbs);
    if (this.forced) return { phase: 'show', day: -1, t: 0.5 };
    return at;
  }

  private loadLive(): void {
    if (this.liveState !== 'idle') return;
    this.liveState = 'loading';
    fetch(`${BASE}music/live.json`).then((r) => r.json()).then((j) => { this.live = parseLive(j); this.liveState = 'ready'; }, () => { this.live = parseLive(null); this.liveState = 'ready'; });
  }

  update(dt: number): void {
    const P = this.plan;
    if (!P) return;
    if (!this.devDone) this.installDev();
    this.time += dt;
    this.loadLive();
    const g = this.g;
    const at = this.phase();
    const cam = g.renderer.camera.position;
    const focus = g.freeCam ? cam : g.player.pos;
    const d = Math.hypot(focus.x - P.stage.x, focus.z - P.stage.z);
    // Tonight's show: made when the doors open (or on arrival mid-evening).
    if (at.phase !== 'none' && (!this.show || this.show.day !== at.day) && this.live) this.newShow(at.day);
    if (at.phase === 'none' && this.show && !this.forced) this.endShow();
    const S = this.show;
    // The show's clock runs while it is on (heard or not); the last song finishes after the hour.
    let item = -1;
    if (S && !S.cancelled && !S.ended && (at.phase === 'show' || (at.phase === 'out' && this.inSong()))) {
      S.clock += dt;
      item = this.itemAt(S.clock);
      if (item < 0) { S.ended = true; this.finale(); }
    }
    if (S && at.phase === 'out' && !this.inSong() && !S.ended) { S.ended = true; this.finale(); }
    const song = item >= 0 && S!.items[item].kind === 'song' ? (S!.items[item] as Extract<Item, { kind: 'song' }>) : null;
    if (item !== this.lastItem) { this.onItem(item, song); this.lastItem = item; }
    // The stage and the stands: up from the doors until the crowd is gone.
    const up = !!S && at.phase !== 'none';
    if (up && !this.stage) this.buildStage();
    if (!up && this.stage) this.takeDown();
    this.music(song, item, d);
    this.crowdSound(up && !S!.cancelled, at.phase, d);
    if (this.stage) {
      const night = clamp(G.uNight.value, 0, 1);
      const live = !!S && !S.cancelled && (at.phase === 'show' || at.phase === 'doors' || !S.ended);
      const spec = (lo: number, hi: number) => (this.stream ? this.stream.s.level(lo, hi) : 0);
      this.stage.update(dt, this.time, this.energy, song ? this.beat : NaN, night, live, spec);
    }
    if (this.wash) this.wash.intensity = this.stage && S && !S.cancelled ? WASH * (0.25 + 0.75 * clamp(G.uNight.value, 0, 1)) * (song ? 1 : 0.6) : 0;
    // The beat for everyone grooving (CrowdRenderer): cycles of GROOVE_PERIOD (two beats each).
    g.crowd.groovePhase = song && Number.isFinite(this.beat) ? this.groove : null;
    // People.
    this.stepFigures(dt, at, !!S && !S.cancelled, !!song);
    this.stepFans(dt, at, d, !!song);
    this.stepBand(dt, at, d, song);
    this.stats.fans = this.fans.length;
  }

  /** One groove cycle (GROOVE_PERIOD of the baked clip) is two beats of the song. */
  private readonly groove = () => this.beat / 2;

  // ================================================================== the show

  private newShow(day: number): void {
    const songs = this.live?.songs ?? [];
    // The evening's show hours in real seconds (a dev show: the whole set).
    const budget = this.forced ? Infinity : ((SHOW_END - SHOW) * 3600) / Math.max(1, this.g.sky.timeScale) - INTRO_GAP;
    const list = setList(this.g.settings.seed, day, songs, budget, GAP);
    const items: Item[] = [{ kind: 'gap', dur: INTRO_GAP }];
    for (const s of list) { items.push({ kind: 'song', dur: s.seconds, song: s }); items.push({ kind: 'gap', dur: GAP }); }
    this.show = { day, items, clock: 0, ended: false, cancelled: false, lastStarted: -1 };
    this.lastItem = -1;
    if (this.stage) { this.stage.act = this.live?.act ?? 'VELA'; this.stage.title = `Live at ${this.plan!.lm.name}`; }
  }

  private endShow(): void {
    this.show = null;
    this.forced = false;
    this.stopStream(1);
  }

  private itemAt(clock: number): number {
    const S = this.show!;
    let t = 0;
    for (let i = 0; i < S.items.length; i++) { t += S.items[i].dur; if (clock < t) return i; }
    return -1;
  }

  private itemStart(i: number): number {
    let t = 0;
    for (let k = 0; k < i; k++) t += this.show!.items[k].dur;
    return t;
  }

  private inSong(): boolean {
    const S = this.show;
    if (!S || S.cancelled || S.ended) return false;
    const i = this.itemAt(S.clock);
    return i >= 0 && S.items[i].kind === 'song';
  }

  /** A new part of the show began: a song (lights, a line), a gap (cheers, a line), the end. */
  private onItem(item: number, song: Extract<Item, { kind: 'song' }> | null): void {
    const S = this.show, st = this.stage;
    if (!S || item < 0) return;
    if (song) {
      this.stats.songs++;
      st?.nextLook();
      if (st) st.title = song.song.title;
      const first = S.items.findIndex((x) => x.kind === 'song') === item;
      const last = S.items.map((x) => x.kind).lastIndexOf('song') === item;
      if (first || last) st?.boom();
      this.say(first ? `Good evening, ${this.city}!` : last ? 'This is the last one. Sing it with us!' : `This one's called "${song.song.title}"!`, 6);
    } else if (item > 0) {
      this.cheer(1);
      const next = S.items[item + 1];
      if (st) st.title = next?.kind === 'song' ? 'Next up…' : `Thank you, ${this.city}!`;
      this.talkT = 3;
    }
  }

  /** The set is over: the band bows, the crowd cheers, then goes home. */
  private finale(): void {
    this.cheer(1.2);
    if (this.stage) this.stage.title = `Goodnight, ${this.city}!`;
    for (const b of this.band) if (b.a.actor) { stand(b.a.actor); b.a.actor.move = null; play(b.a.actor, 'bow', 2.2); }
    this.say(`Goodnight, ${this.city}! We love you!`, 10);
  }

  // ================================================================== music

  private music(song: Extract<Item, { kind: 'song' }> | null, item: number, d: number): void {
    const P = this.plan!, S = this.show;
    const want = song && S && d < HEAR_R;
    if (this.stream && (!want || this.stream.item !== item)) this.stopStream(item === this.stream.item ? 1.5 : 0.6);
    if (want && !this.stream) {
      const offset = S!.clock - this.itemStart(item);
      if (offset < song!.dur - 1) {
        const s = this.g.audio.stream(song!.song.file, { refDist: REF, rolloff: 1, cat: 'music', offset: Math.max(0, offset) });
        if (s) this.stream = { s, song: song!.song, item };
      }
    }
    const st = this.stream;
    if (st) {
      // Over the stage, a little forward; duller from afar and from outside the bowl.
      const x = (P.stage.x * 0.4 + P.stage.fx * 0.6), z = (P.stage.z * 0.4 + P.stage.fz * 0.6);
      const outside = d > P.lm.p.ia + P.lm.p.tiers * P.lm.p.depth;
      const cutoff = d < 90 ? 18000 : 18000 * Math.pow(0.18, smoothstep(90, 1400, d)) * (outside ? 0.55 : 1);
      st.s.set(x, P.stage.deckY + 6, z, LEVEL, Math.max(700, cutoff));
      // The beat (the clock of the song as it plays, else the show's own) and the loudness.
      const t = st.s.time() > 0 ? st.s.time() : S!.clock - this.itemStart(item);
      this.beat = (t - st.song.beat0) * st.song.bpm / 60;
      this.energy += (st.s.level(0, 0.25) - this.energy) * 0.3;
    } else if (song) {
      // Unheard (far away): the lights still keep time.
      const t = S!.clock - this.itemStart(item);
      this.beat = (t - song.song.beat0) * song.song.bpm / 60;
      this.energy += (0.5 + 0.3 * Math.sin(t * 1.3) - this.energy) * 0.1;
    } else {
      this.beat = NaN;
      this.energy *= 0.9;
    }
  }

  private stopStream(fade: number): void {
    const st = this.stream;
    if (!st) return;
    this.stream = null;
    st.s.fade(fade);
    this.g.later.after(fade + 0.5, () => st.s.stop());
  }

  /** The crowd's murmur (doors, gaps) and cheers. */
  private crowdSound(on: boolean, phase: ConcertPhase, d: number): void {
    const P = this.plan!, g = this.g;
    const want = on && d < 900 && (phase === 'doors' || phase === 'show' || phase === 'out');
    this.loopTry -= 1 / 60;
    if (want && !this.crowdLoop && this.loopTry <= 0) { this.loopTry = 2; this.crowdLoop = g.audio.loop('amb_crowd', 45); }
    if (this.crowdLoop) {
      const [cx, cz] = this.centre();
      const level = want ? (this.stream ? 0.35 : 0.9) * (phase === 'out' ? 0.5 : 1) : 0;
      this.crowdLoop.set(cx, P.lm.base + 3, cz, level);
      if (!want && d > 1200) { this.crowdLoop.stop(); this.crowdLoop = null; }
    }
  }

  /** A roar from the bowl (several cheers, staggered). */
  private cheer(k: number): void {
    const g = this.g, [cx, cz] = this.centre(), y = this.plan!.lm.base + 4;
    for (let n = 0; n < 4; n++) g.later.after(n * 0.35, () => g.audio.play('crowd_cheer', cx + (n - 1.5) * 25, y, cz, clamp(k, 0, 1), 0.9 + n * 0.05, 60, g.renderer.camera.position));
    for (const f of this.fans) if (f.a.actor && f.a.actor.action?.id !== 'cheer') { f.cheerT = Math.random() * 1.5; }
  }

  private centre(): [number, number] {
    const P = this.plan!;
    return [P.lm.x, P.lm.z];
  }

  // ================================================================== the stage

  private buildStage(): void {
    const P = this.plan!;
    const st = new Stage();
    st.place(P.stage.x, P.lm.base + 0.02, P.stage.z, P.stage.heading);
    st.act = this.live?.act ?? 'VELA';
    st.title = `Live at ${P.lm.name}`;
    this.g.renderer.scene.add(st.group);
    this.stage = st;
    // The stands' figures (once: synthetic citizens of the city, no children on their own).
    if (!this.figures.length) {
      const pop = this.g.population;
      for (let i = 0; i < P.seats.length; i++) {
        const s = P.seats[i];
        const cit = this.citizen(deriveSeed(this.g.settings.seed, 'stands', i), pop.synthetic.bind(pop));
        if (!cit) continue;
        this.figures.push({ cit, x: s.x, y: s.y, z: s.z, heading: s.heading, clip: 'idle', phase: 0, on: false });
      }
      this.seatOf = P.seats.slice(0, this.figures.length);
    }
  }
  private seatOf: { x: number; y: number; z: number; heading: number }[] = [];

  private takeDown(): void {
    this.stage?.dispose();
    this.stage = null;
    for (const f of this.figures) f.on = false;
    for (const fan of [...this.fans]) this.dropFan(fan, true);
    for (const b of [...this.band]) { if (b.a.actor?.owner === CONCERT_OWNER) b.a.alive = false; }
    this.band = [];
    this.stopStream(1);
  }

  /** Collision: the stage deck (walkable on top) and its speaker stacks. */
  private readonly provider = (x0: number, z0: number, x1: number, z1: number, out: (o: Obstacle) => void): void => {
    const P = this.plan;
    if (!P || !this.stage) return;
    const cx = (P.stage.x + P.stage.fx) / 2, cz = (P.stage.z + P.stage.fz) / 2;
    const R = STAGE.w / 2 + 4;
    if (x1 < cx - R || x0 > cx + R || z1 < cz - R || z0 > cz + R) return;
    const ux = Math.cos(P.lm.angle), uz = Math.sin(P.lm.angle);
    out({ cyl: false, x: cx, z: cz, r: 0, hx: STAGE.d / 2, hz: STAGE.w / 2, ux, uz, y0: P.lm.base, y1: P.stage.deckY, deck: true });
  };

  // ================================================================== the stands

  private stepFigures(dt: number, at: { phase: ConcertPhase; t: number }, on: boolean, song: boolean): void {
    const F = this.figures;
    if (!F.length) return;
    const S = this.show;
    const panic = !!S?.cancelled;
    // How full the stands are now: filling while the doors are open, emptying after.
    const fill = !this.stage ? 0 : panic ? 0 : at.phase === 'doors' ? 0.25 + 0.75 * at.t : at.phase === 'show' ? 1 : at.phase === 'out' ? (S?.ended ? 1 - at.t * 1.4 : 1) : 0;
    let n = 0;
    for (let i = 0; i < F.length; i++) {
      const f = F[i], seat = this.seatOf[i];
      if (panic && f.on) {
        // Running up the stand, out over the top (and gone).
        f.clip = 'run';
        f.heading = seat.heading + Math.PI;
        const sp = 3.8 * dt;
        // (Away from the stage: against the way the seat faces.)
        f.x += Math.sin(seat.heading) * sp; f.z += Math.cos(seat.heading) * sp;
        f.phase += sp;
        f.y += 0.6 * sp;
        if (Math.hypot(f.x - seat.x, f.z - seat.z) > 4 + (hash32(i) % 9)) f.on = false;
        if (f.on) n++;
        continue;
      }
      const want = on && hash32(i * 7 + 3) % 1000 < fill * 1000;
      if (want && !f.on) { f.x = seat.x; f.y = seat.y; f.z = seat.z; f.heading = seat.heading; f.phase = 0; }
      f.on = want;
      if (!want) continue;
      n++;
      // Grooving to the songs (a few just watch), standing between them.
      f.clip = song && hash32(i * 13) % 10 < 8 ? 'groove' : 'idle';
    }
    this.stats.figures = n;
  }

  // ================================================================== the pit

  private stepFans(dt: number, at: { phase: ConcertPhase; t: number }, d: number, song: boolean): void {
    const P = this.plan!, g = this.g, S = this.show;
    // Those gone, hit, knocked down or taken over: not ours any more.
    for (const f of [...this.fans]) {
      const a = f.a, act = a.actor;
      if (!a.alive || !act || act.owner !== CONCERT_OWNER) { this.dropFan(f, false); continue; }
      if (act.hitByPlayer || a.state === PState.Down || act.state === 'ko') { this.panic(a.x, a.z); this.dropFan(f, false); continue; }
    }
    if (d > PIT_DROP || !this.stage) { for (const f of [...this.fans]) this.dropFan(f, true); return; }
    const leaving = !!S && (S.cancelled || (at.phase === 'out' && S.ended));
    // Fill up to tonight's crowd (while the player is near).
    if (!leaving && S && d < PIT_R && (at.phase === 'doors' || at.phase === 'show')) {
      const target = Math.round(PIT_CAP * (at.phase === 'doors' ? 0.3 + 0.7 * at.t : 1));
      if (this.fans.length < target) this.fill(Math.min(PIT_PER_FRAME, target - this.fans.length));
    }
    const fx = P.stage.fx, fz = P.stage.fz;
    for (const f of this.fans) {
      const a = f.a, act = a.actor!;
      if (leaving) {
        // Out through the far gate (running if it is a panic), then home.
        const run = S!.cancelled;
        const gi = P.gateIn, go = P.gateOut;
        act.action = null;
        act.face = null;
        const atGate = Math.hypot(a.x - gi[0], a.z - gi[1]) < 6 || act.memo.out === 1;
        if (atGate) { act.memo.out = 1; goTo(act, go[0], go[1], run ? 4.2 : 1.4); }
        else goTo(act, gi[0] + (hash32(f.i) % 7) - 3, gi[1] + (hash32(f.i + 9) % 7) - 3, run ? 4.2 : 1.4);
        if (act.memo.out === 1 && Math.hypot(a.x - go[0], a.z - go[1]) < 4) this.release(f, run);
        continue;
      }
      act.face = { x: fx, y: P.stage.deckY + 2, z: fz };
      f.cheerT -= dt;
      if (song) hold(act, 'groove', 1.4);
      else if (f.cheerT <= 0 && f.cheerT > -dt * 1.5) play(act, 'cheer', 1.6);
      else if (act.action?.id === 'groove') act.action = null;
    }
    this.fans = this.fans.filter((f) => f.a.alive && f.a.actor?.owner === CONCERT_OWNER);
  }

  /** n more people at the next free places in the pit (nearest the stage first). */
  private fill(n: number): void {
    const P = this.plan!, g = this.g;
    if (!this.makeRoom(n)) return;
    const taken = new Set(this.fans.map((f) => f.i));
    let k = 0;
    for (let i = 0; i < P.pit.length && k < n; i++) {
      if (taken.has(i)) continue;
      const s = P.pit[i];
      const cit = this.citizen(deriveSeed(g.settings.seed, 'pit', i, this.show?.day ?? 0), g.population.synthetic.bind(g.population));
      if (!cit) continue;
      const a = g.peds.spawnAt(cit, s.x, s.z, s.heading);
      if (!a) return;
      a.floorAt = P.floor;
      a.y = s.y;
      const act = attach(a, makeActor('bystander', CONCERT_OWNER, { title: 'Concert-goer', crowd: true, hp: 30, maxHp: 30, mood: 'happy', face: { x: P.stage.fx, y: P.stage.deckY + 2, z: P.stage.fz } }));
      act.memo.out = 0;
      this.fans.push({ a, i, cheerT: 1e9 });
      k++;
    }
  }

  /** Room in the pedestrian budget for n more: the farthest ordinary walkers make way (their schedules go on unseen). */
  private makeRoom(n: number): boolean {
    const A = this.g.peds.agents, over = A.length + n - PEDS_ROOM;
    if (over <= 0) return true;
    const p = this.g.player.pos;
    const far: { a: PedAgent; d: number }[] = [];
    for (const a of A) {
      if (!a.alive || a.actor || a.state !== PState.Walk || a.evac || a.inside) continue;
      const d = Math.hypot(a.x - p.x, a.z - p.z);
      if (d > 300) far.push({ a, d });
    }
    if (far.length < over) return false;
    far.sort((p1, q) => q.d - p1.d);
    for (let k = 0; k < over; k++) far[k].a.alive = false;
    return true;
  }

  /** Off the list; gone (unseen) or handed back to the street. */
  private dropFan(f: Fan, vanish: boolean): void {
    const i = this.fans.indexOf(f);
    if (i >= 0) this.fans.splice(i, 1);
    const a = f.a;
    if (a.actor?.owner !== CONCERT_OWNER) { if (a.floorAt) a.floorAt = undefined; return; }
    if (vanish) { a.alive = false; return; }
    this.release(f, true);
  }

  /** Back to the city's people: out of the stadium, on their way (running from a scare). */
  private release(f: Fan, scared: boolean): void {
    const a = f.a;
    const i = this.fans.indexOf(f);
    if (i >= 0) this.fans.splice(i, 1);
    a.actor = undefined;
    a.floorAt = undefined;
    if (a.state === PState.Down) return;
    const r = this.g.peds.buildRoute(a.x, a.z, a.x + (Math.random() - 0.5) * 300, a.z + (Math.random() - 0.5) * 300);
    if (r) { a.route = r; a.wp = 1; } else { a.alive = false; return; }
    if (scared) { a.state = PState.Flee; a.fear = 1.1; a.fearX = this.plan!.stage.x; a.fearZ = this.plan!.stage.z; a.stateT = 0; }
    else { a.state = PState.Walk; a.stateT = 0; a.fear = 0; }
  }

  private citizen(seed: number, synth: (s: number) => Citizen): Citizen | null {
    for (let k = 0; k < 6; k++) {
      const c = synth(hash32(seed + k * 7919) || 1);
      if (c.role === Role.Child || c.role === Role.Senior) continue;
      return c;
    }
    return null;
  }

  // ================================================================== the band

  private stepBand(dt: number, at: { phase: ConcertPhase; t: number }, d: number, song: Extract<Item, { kind: 'song' }> | null): void {
    const P = this.plan!, g = this.g, S = this.show;
    for (const b of [...this.band]) {
      if (!b.a.alive || b.a.actor?.owner !== CONCERT_OWNER || b.a.actor.hitByPlayer || b.a.state === PState.Down) {
        if (b.a.actor?.owner === CONCERT_OWNER) { b.a.actor = undefined; b.a.floorAt = undefined; }
        this.band.splice(this.band.indexOf(b), 1);
      }
    }
    const want = !!this.stage && !!S && !S.cancelled && !S.ended && d < BAND_R && (at.phase === 'show' || (at.phase === 'doors' && at.t > 0.85) || at.phase === 'out');
    if (!want) {
      // After the bow (or a scare): off the back of the stage, gone.
      for (const b of [...this.band]) {
        const act = b.a.actor!;
        if (S && !S.cancelled && S.ended && act.action?.id === 'bow') continue;
        act.move = null;
        act.held = act.held === 'stagemic' ? 'stagemic' : null;
        const [bx, bz] = P.onStage(0.6, b.home.x > 0 ? 6 : -6);
        goTo(act, bx, bz, S?.cancelled ? 4 : 1.4);
        if (Math.hypot(b.a.x - bx, b.a.z - bz) < 1.2 || d > BAND_R + 100) { b.a.alive = false; this.band.splice(this.band.indexOf(b), 1); }
      }
      return;
    }
    if (!this.band.length) this.bandUp();
    this.walkT -= dt;
    this.talkT -= dt;
    for (const b of this.band) {
      const a = b.a, act = a.actor!;
      act.face = { x: (P.stage.fx * 3 - P.stage.x * 2), y: P.stage.deckY + 1, z: (P.stage.fz * 3 - P.stage.z * 2) };
      act.mood = 'happy';
      if (act.action?.id === 'bow') continue;
      switch (b.role) {
        case 'singer':
          if (song) {
            hold(act, 'sing', 1.4);
            // Working the front of the stage: a few steps left or right now and then.
            if (this.walkT <= 0) {
              this.walkT = 6 + Math.random() * 8;
              const [x, z] = P.onStage(9 + Math.random() * 2, (Math.random() - 0.5) * 14);
              goTo(act, x, z, 1.1);
            }
          } else {
            if (Math.hypot(a.x - b.home.x, a.z - b.home.z) > 0.6) goTo(act, b.home.x, b.home.z, 1.1); else stand(act);
            if (act.action?.id === 'sing') act.action = null;
            if (this.talkT <= 0 && S && !S.ended) { this.talkT = 9; this.banter(); if (!act.action) play(act, 'gesture_wave', 2); }
          }
          break;
        case 'guitar': case 'bass':
          if (song) hold(act, 'play_guitar', 1.4); else if (act.action?.id === 'play_guitar') act.action = null;
          break;
        case 'keys':
          if (song) hold(act, 'play_keys', 1.4); else if (act.action?.id === 'play_keys') act.action = null;
          break;
        case 'drums':
          act.move = 'sit';
          if (song) hold(act, 'play_drums', 1.4); else if (act.action?.id === 'play_drums') act.action = null;
          break;
      }
    }
  }

  private bandUp(): void {
    const P = this.plan!, g = this.g;
    const parts: Record<BandRole, MusicianPart> = { singer: 'singer', guitar: 'guitar', bass: 'bass', keys: 'keys', drums: 'drums' };
    const deckY = P.stage.deckY;
    const [rx, rz] = P.onStage(3.2, 0);
    const ux = Math.cos(P.lm.angle), uz = Math.sin(P.lm.angle);
    for (const m of P.band) {
      const seed = deriveSeed(g.settings.seed, 'band', m.role);
      const female = m.role === 'singer';
      let cit: Citizen | null = null;
      for (let k = 0; k < 30 && !cit; k++) {
        const c = g.population.synthetic(hash32(seed + k * 131) || 1);
        if (c.role === Role.Child || c.role === Role.Senior) continue;
        if (female !== (c.gender < 0.5) && k < 25) continue;
        cit = c;
      }
      if (!cit) continue;
      const a = g.peds.spawnAt(cit, m.x, m.z, m.heading);
      if (!a) continue;
      // The drummer sits on the riser (0.5 m up), the others stand on the deck.
      const floor = m.role === 'drums'
        ? (x: number, z: number) => { const dx = x - rx, dz = z - rz; return Math.abs(dx * ux + dz * uz) < 1.7 && Math.abs(-dx * uz + dz * ux) < 2.5 ? deckY + 0.5 : P.floor(x, z); }
        : P.floor;
      a.floorAt = floor;
      a.y = floor(m.x, m.z) ?? deckY;
      const cos = musicianCostume(parts[m.role], cit.seed, cit.gender < 0.5, true);
      attach(a, makeActor('bystander', CONCERT_OWNER, { title: m.role === 'singer' ? (this.live?.act ?? 'VELA') : `${this.live?.act ?? 'VELA'}'s ${m.role === 'keys' ? 'keyboardist' : m.role === 'drums' ? 'drummer' : m.role === 'bass' ? 'bassist' : 'guitarist'}`, outfit: cos.eq, held: cos.held, hp: 60, maxHp: 60, mood: 'happy' }));
      this.band.push({ a, role: m.role, home: { x: m.x, z: m.z }, floor });
    }
  }

  private banter(): void {
    const hero = this.g.player.pos, P = this.plan!;
    const near = Math.hypot(hero.x - P.stage.fx, hero.z - P.stage.fz) < 60;
    const r = new Rng(hash32(Math.floor(this.time * 7)));
    const lines = [
      `How are you doing, ${this.city}?!`, 'Make some noise!', 'You are beautiful tonight!', 'Everybody, hands up!',
      'Thank you so much!', `${this.city}, you are amazing!`, 'Are you ready for more?!',
      ...(near ? ['Look who\'s here! A real superhero!', 'Give it up for our hero!'] : []),
    ];
    this.say(r.pick(lines), 7);
  }

  private say(text: string, pause: number): void {
    const s = this.band.find((b) => b.role === 'singer');
    if (s) this.g.barks.say(s.a, text, pause, 'cheer');
  }

  // ================================================================== danger

  private onStimulus(s: Stimulus): void {
    const S = this.show, P = this.plan;
    if (!S || S.cancelled || !P || !this.stage) return;
    const d = Math.hypot(s.x - P.lm.x, s.z - P.lm.z);
    const bowl = P.lm.p.ia + P.lm.p.tiers * P.lm.p.depth + 10;
    if (d > bowl + s.radius * 0.5) return;
    switch (s.kind) {
      case 'blast': case 'collapse': case 'sonic': case 'roar': case 'threat': case 'gunfire':
        this.panic(s.x, s.z);
        break;
      case 'power':
        if (d < bowl) this.panic(s.x, s.z);
        break;
      case 'stomp':
        if ((s.size ?? 0) > 4) this.panic(s.x, s.z);
        break;
      case 'siren':
        if (s.evac) this.panic(s.x, s.z);
        break;
      default: break;
    }
  }

  /** The show is over for tonight: the music stops, everyone gets out. */
  panic(x: number, z: number): void {
    const S = this.show;
    if (!S || S.cancelled) return;
    S.cancelled = true;
    this.stats.panics++;
    this.stopStream(0.4);
    this.g.audio.play('crowd_gasp', x, this.plan!.lm.base + 3, z, 1, 1, 40, this.g.renderer.camera.position);
    if (this.stage) this.stage.title = 'Please leave calmly';
  }

  // ================================================================== dev

  private installDev(): void {
    const dev = (window as unknown as { dev?: Record<string, unknown> }).dev;
    if (!dev) return;
    this.devDone = true;
    const P = this.plan!;
    dev.concert = {
      concert: this,
      status: () => ({
        phase: this.phase(), clock: this.show?.clock, items: this.show?.items.map((i) => (i.kind === 'song' ? i.song.title : `gap ${i.dur}`)), item: this.lastItem,
        cancelled: this.show?.cancelled, ended: this.show?.ended, song: this.stream?.song.title, beat: this.beat, energy: this.energy, ...this.stats, band: this.band.length,
        stadium: P.lm.name, at: [Math.round(P.lm.x), Math.round(P.lm.z)],
      }),
      start: () => { this.forced = true; this.loadLive(); if (this.show) this.show = null; return 'show now'; },
      stop: () => { this.forced = false; this.endShow(); this.takeDown(); return 'stopped'; },
      next: () => { const S = this.show; if (!S) return null; const i = this.itemAt(S.clock); if (i >= 0) S.clock = this.itemStart(i + 1) + 0.01; return this.itemAt(S.clock); },
      panic: () => { this.panic(P.lm.x, P.lm.z); return 'panic'; },
      go: (where: 'pit' | 'stand' | 'stage' | 'far' = 'pit') => {
        const g = this.g;
        let x: number, z: number, y: number, look: number;
        if (where === 'stage') { [x, z] = P.onStage(10.5, 3); y = P.stage.deckY; look = P.stage.heading; }
        else if (where === 'stand') { const s = P.seats[Math.floor(P.seats.length * 0.3)]; x = s.x; z = s.z; y = s.y; look = s.heading; }
        else if (where === 'far') { const dx = P.stage.fx - P.stage.x, dz = P.stage.fz - P.stage.z, L = Math.hypot(dx, dz); x = P.stage.x + (dx / L) * 700; z = P.stage.z + (dz / L) * 700; y = g.world.groundHeight(x, z); look = P.stage.heading + Math.PI; }
        else { const s = P.pit[Math.min(P.pit.length - 1, 60)]; x = s.x; z = s.z; y = s.y; look = s.heading; }
        g.freeCam = false;
        g.player.pos.set(x, y + 0.1, z);
        g.player.vel.set(0, 0, 0);
        g.camRig.yaw = look;
        return { x: Math.round(x), z: Math.round(z) };
      },
    };
  }
}
