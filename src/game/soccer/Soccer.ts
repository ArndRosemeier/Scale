/**
 * Soccer in the stadium: by day the city's clubs play matches on the stadium's pitch, one after
 * another (plan.ts says when and who, match.ts plays them).
 *
 *  - The match runs whether the player is near or not (it is cheap: 22 dots and a ball), so one
 *    arriving mid-match finds the score as it stands and the clock running.
 *  - Near the stadium the players are people (actors, SOCCER_OWNER, moved by the match every frame:
 *    PedAgent.puppet) in their club's kit, the keepers in theirs, with a referee in black following
 *    play; the ball is a mesh rolling, bouncing and flying as the match moves it. Kicks, headers,
 *    tackles, keepers' saves and dives, throw-ins and celebrations play their animations.
 *  - The scoreboard over the west stand shows the clubs, the score and the minute; the stands fill
 *    with drawn figures (CrowdRenderer.figureLists) who get up and cheer a goal. Kicks thud, the
 *    referee whistles, the crowd murmurs, cheers goals and groans at a near miss.
 *  - The hero walking onto the pitch stops play (the referee tells them to get off); a hit on a
 *    player or danger at the stadium (a blast, a monster, gunfire) abandons the match: everyone runs.
 *
 * Dev (console): dev.soccer.status(), dev.soccer.start() (a match now, whatever the hour),
 * dev.soccer.go('pitch' | 'stand' | 'far'), dev.soccer.skip(s) (play s seconds at once), dev.soccer.stop().
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import { PState, type PedAgent } from '../../sim/Pedestrians';
import { Role, type Citizen } from '../../sim/Population';
import { makeActor, attach, SOCCER_OWNER } from '../../sim/actors/Actor';
import type { CrowdFigure } from '../../sim/CrowdRenderer';
import type { Stimulus } from '../Stimuli';
import type { EquipmentVisuals, ItemVisual } from '../../items/types';
import { hash32, deriveSeed, Rng } from '../../core/rng';
import { clamp } from '../../core/math';
import { nameOf } from '../people/identity';
import { Match, makeTeam, playerTitle, PITCH, type Man, type Kit, type TeamDef, type ActId } from './match';
import { soccerAt, soccerPlan, clubs, fixture, BREAK_S, type SoccerPlan, type Club } from './plan';

/** Players are people within this of the stadium's centre (m); gone again beyond DROP_R. */
const NEAR_R = 420, DROP_R = 520;
/** The crowd is heard within this (m). */
const HEAR_R = 900;
/** Match actions → animations (actions.ts). */
const ANIM: Partial<Record<ActId, string>> = {
  kick: 'soccer_kick', pass: 'soccer_kick', shoot: 'soccer_kick', tackle: 'soccer_kick', slide: 'slide_tackle', header: 'soccer_header',
  catch: 'keeper_catch', throw: 'throw_in', celebrate: 'cheer', dejected: 'hands_on_head', clap: 'clap',
};

/** Animations whose strike is a third of the way in. */
const KICKS = new Set(['soccer_kick', 'soccer_header']);

interface Body { a: PedAgent; man: Man | null }

export class Soccer {
  readonly plan: SoccerPlan | null;
  private clubs: Club[] = [];
  match: Match | null = null;
  /** Which match of the day this is, the day, real seconds until the next may start. */
  private k = 0;
  private day = -1;
  private wait = 0;
  private fix: ReturnType<typeof fixture> | null = null;
  /** Dev: a match now, whatever the hour. */
  private forced = false;
  private bodies = new Map<Man, Body>();
  private ref: PedAgent | null = null;
  private refPos = { x: 0, y: -20, vx: 0, vy: 0 };
  private ball: THREE.Mesh | null = null;
  private board: { mesh: THREE.Mesh; tex: THREE.CanvasTexture; ctx: CanvasRenderingContext2D; key: string } | null = null;
  private figures: CrowdFigure[] = [];
  private seatOf: { x: number; y: number; z: number; heading: number }[] = [];
  private cheerT = 0;
  private crowdLoop: { set(x: number, y: number, z: number, gain: number, rate?: number): void; stop(): void } | null = null;
  private loopTry = 0;
  /** Events of the match already shown. */
  private seen = 0;
  private abandoned = false;
  private invaderT = 0;
  private devDone = false;
  stats = { matches: 0, goals: 0, players: 0, figures: 0, abandoned: 0 };

  constructor(private g: Game) {
    const lm = g.macro.landmarks.find((l) => l.kind === 'stadium') ?? null;
    this.plan = lm ? soccerPlan(lm, g.settings.seed) : null;
    if (!this.plan) return;
    this.clubs = clubs(g.settings.seed);
    g.stimuli.on((s) => this.onStimulus(s));
    g.crowd.figureLists.push(this.figures);
  }

  update(dt: number): void {
    const P = this.plan;
    if (!P) return;
    if (!this.devDone) this.installDev();
    const g = this.g;
    const at = soccerAt(g.sky.hoursAbs, g.sky.timeScale);
    if (at.day !== this.day) { this.day = at.day; this.k = 0; }
    this.wait -= dt;
    // A new match when the day allows (and the concert's stage is not up).
    if (!this.match && (at.open || this.forced) && this.wait <= 0 && !g.concert?.busy) this.newMatch();
    const M = this.match;
    const focus = g.freeCam ? g.renderer.camera.position : g.player.pos;
    const d = Math.hypot(focus.x - P.lm.x, focus.z - P.lm.z);
    if (M) {
      this.invader(dt);
      M.update(dt);
      this.onEvents(d);
      if (M.over) this.endMatch();
    }
    this.people(dt, d);
    this.stepBall(dt, d);
    this.stepBoard();
    this.stepFigures(dt);
    this.crowdSound(dt, d);
    this.stats.players = this.bodies.size;
  }

  /** The stadium's pitch is in use (the concert waits). */
  get busy(): boolean { return !!this.match; }

  // ================================================================== matches

  private newMatch(): void {
    const g = this.g, P = this.plan!;
    const f = fixture(g.settings.seed, this.day, this.k++, this.clubs);
    this.fix = f;
    const team = (ci: number, change: boolean): TeamDef => {
      const c = this.clubs[ci];
      const kit = change ? c.away : c.kit;
      // The squad: the same citizens for the club every time.
      return makeTeam(new Rng(c.seed), c.name, c.short, kit, c.level, (i) => {
        const cit = this.citizen(deriveSeed(c.seed, 'player', i), c.women);
        // (cit: the seed the player's citizen is found from again when they are spawned.)
        return { name: cit ? nameOf(cit).full : `Player ${i + 1}`, cit: deriveSeed(c.seed, 'player', i) };
      });
    };
    this.match = new Match(f.seed, [team(f.home, false), team(f.away, f.change)], P.tunnelX);
    this.seen = 0;
    this.abandoned = false;
    this.stats.matches++;
  }

  private endMatch(): void {
    for (const b of [...this.bodies.values()]) this.dropBody(b, true);
    this.bodies.clear();
    if (this.ref) { this.ref.alive = false; this.ref = null; }
    this.match = null;
    this.forced = false;
    this.wait = BREAK_S;
  }

  /** The hero on the pitch: play stops until they are off it. */
  private invader(dt: number): void {
    const M = this.match!, P = this.plan!, p = this.g.player;
    const on = !this.g.freeCam && P.onPitch(p.pos.x, p.pos.z) && Math.abs(p.pos.y - P.field) < 2.5 && (M.phase === 'play' || M.phase === 'restart' || M.phase === 'kickoff');
    M.hold(on);
    this.invaderT -= dt;
    if (on && this.invaderT <= 0 && this.ref) {
      this.invaderT = 9;
      this.g.barks.say(this.ref, Math.random() < 0.5 ? 'Off the pitch, please! There\'s a match on!' : 'Hey! Get off the field!', 6);
      this.whistle(1);
    }
  }

  /** What happened in the match since the last frame: sounds, the crowd, bubbles. */
  private onEvents(d: number): void {
    const M = this.match!, g = this.g, P = this.plan!;
    const cam = g.renderer.camera.position;
    for (; this.seen < M.events.length; this.seen++) {
      const e = M.events[this.seen];
      if (d > HEAR_R && e.kind !== 'goal') continue;
      const [bx, bz] = P.toWorld(M.ball.x, M.ball.y);
      switch (e.kind) {
        case 'kick': g.audio.play('ball_kick', bx, P.field + 0.3, bz, 0.25 + (e.k ?? 0.5) * 0.65, 0.9 + Math.random() * 0.2, 9, cam); break;
        case 'whistle': this.whistle(e.k ?? 1); break;
        case 'half': case 'full': this.whistle(e.kind === 'full' ? 3 : 2); break;
        case 'goal': {
          this.stats.goals++;
          this.cheer(1);
          this.cheerT = 6;
          const b = e.man ? this.bodies.get(e.man) : null;
          if (b) g.barks.say(b.a, Math.random() < 0.5 ? 'GOAL!' : 'Yesss!', 5, 'cheer');
          break;
        }
        case 'save': case 'post': case 'miss':
          if (d < HEAR_R) g.audio.play('crowd_gasp', P.lm.x, P.field + 6, P.lm.z, e.kind === 'miss' ? 0.5 : 0.8, 1, 60, cam);
          break;
        case 'foul': {
          const b = e.man ? this.bodies.get(e.man) : null;
          if (this.ref && Math.random() < 0.5) g.barks.say(this.ref, 'Foul! Free kick.', 5);
          else if (b && Math.random() < 0.4) g.barks.say(b.a, 'I got the ball!', 4);
          break;
        }
        case 'chance': if (Math.random() < 0.25 && e.man) { const b = this.bodies.get(e.man); if (b) g.barks.say(b.a, 'Shoot!', 3); } break;
        default: break;
      }
    }
  }

  private whistle(n: number): void {
    const g = this.g, P = this.plan!, cam = g.renderer.camera.position;
    const [x, z] = this.ref ? [this.ref.x, this.ref.z] : [P.lm.x, P.lm.z];
    const one = (dl: number, long: boolean) => g.later.after(dl, () => g.audio.play(long ? 'ref_whistle_long' : 'ref_whistle', x, P.field + 1.6, z, 0.9, 1, 30, cam));
    if (n === 1) one(0, false);
    else if (n === 2) { one(0, false); one(0.5, true); }
    else { one(0, false); one(0.45, false); one(0.9, true); }
  }

  // ================================================================== people

  private people(dt: number, d: number): void {
    const M = this.match, g = this.g, P = this.plan!;
    // Hit, knocked down or taken over: the match is off.
    for (const b of [...this.bodies.values()]) {
      const a = b.a, act = a.actor;
      if (!a.alive || !act || act.owner !== SOCCER_OWNER) { this.bodies.delete(b.man!); continue; }
      if (act.hitByPlayer || a.state === PState.Down || act.state === 'ko') { this.abandon(a.x, a.z); break; }
    }
    if (!M || d > DROP_R) { for (const b of [...this.bodies.values()]) this.dropBody(b, true); this.bodies.clear(); if (this.ref) { this.ref.alive = false; this.ref = null; } return; }
    if (d > NEAR_R && !this.bodies.size) return;
    const c = Math.cos(P.angle), s = Math.sin(P.angle);
    for (const m of M.men) {
      let b = this.bodies.get(m);
      if (!m.on) { if (b) { this.dropBody(b, true); this.bodies.delete(m); } continue; }
      if (!b) { const nb = this.spawn(m); if (!nb) continue; b = nb; this.bodies.set(m, b); }
      this.place(b.a, m.x, m.y, m.face, Math.hypot(m.vx, m.vy), c, s);
      const act = b.a.actor!;
      // The match's action as an animation (diving to the keeper's own left or right).
      const want = m.act ? (m.act.id === 'dive' ? (this.diveRight(m) ? 'dive_r' : 'dive_l') : ANIM[m.act.id] ?? null) : null;
      if (want && m.act) {
        // (The match sends the ball off as the action starts: kicks start at the end of the back-swing.)
        const age = m.act.t + (KICKS.has(want) ? m.act.dur * 0.35 : 0);
        if (act.action?.id !== want) act.action = { id: want, age, dur: m.act.dur };
        else act.action.age = age;
      } else act.action = null;
      act.move = m.act?.id === 'fall' ? 'knockdown' : null;
      const [bx, bz] = P.toWorld(M.ball.x, M.ball.y);
      act.face = { x: bx, y: P.field + M.ball.h, z: bz };
      act.mood = m.act?.id === 'celebrate' ? 'happy' : m.act?.id === 'dejected' ? 'sad' : 'focused';
    }
    this.stepRef(dt, c, s);
  }

  /**
   * Does the keeper dive to his own right? (The pitch frame's +y is the right of +x seen from
   * above, as the site's +v is of +u: the right of a facing f is (-sin f, cos f).)
   */
  private diveRight(m: Man): boolean {
    return (m.act?.side ?? 1) * Math.cos(m.face) > 0;
  }

  /** Put a body at a pitch point, facing and moving as the match has it. */
  private place(a: PedAgent, x: number, y: number, face: number, speed: number, c: number, s: number): void {
    const P = this.plan!;
    const [wx, wz] = P.toWorld(x, y);
    a.x = wx; a.z = wz; a.y = P.field;
    const dx = Math.cos(face) * c - Math.sin(face) * s, dz = Math.cos(face) * s + Math.sin(face) * c;
    a.heading = Math.atan2(-dx, -dz);
    a.speed = speed;
  }

  /** Does this side of the match field women? */
  private women(team: number): boolean {
    const f = this.fix;
    return !!f && !!this.clubs[team === 0 ? f.home : f.away]?.women;
  }

  private spawn(m: Man): Body | null {
    const g = this.g, P = this.plan!, M = this.match!;
    const team = M.teams[m.team];
    const cit = this.citizen(m.def.cit, this.women(m.team));
    if (!cit) return null;
    const [x, z] = P.toWorld(m.x, m.y);
    const a = g.peds.spawnAt(cit, x, z, 0);
    if (!a) return null;
    a.puppet = true;
    a.y = P.field;
    attach(a, makeActor('bystander', SOCCER_OWNER, { title: playerTitle(team, m.def), outfit: kitOutfit(team.kit, m.def.pos === 'GK', cit.seed), held: null, hp: 50, maxHp: 50, mood: 'focused' }));
    return { a, man: m };
  }

  private dropBody(b: Body, vanish: boolean): void {
    const a = b.a;
    if (a.actor?.owner !== SOCCER_OWNER) { a.puppet = false; return; }
    if (vanish) { a.alive = false; return; }
    this.release(a);
  }

  /** Back to the city's people, running from a scare. */
  private release(a: PedAgent): void {
    const P = this.plan!;
    a.actor = undefined;
    a.puppet = false;
    if (a.state === PState.Down) return;
    const r = this.g.peds.buildRoute(a.x, a.z, a.x + (Math.random() - 0.5) * 300, a.z + (Math.random() - 0.5) * 300);
    if (r) { a.route = r; a.wp = 1; } else { a.alive = false; return; }
    a.floorAt = (x, z) => (P.onPitch(x, z, 12) ? P.field : null);
    a.state = PState.Flee; a.fear = 1.1; a.fearX = P.lm.x; a.fearZ = P.lm.z; a.stateT = 0;
  }

  /** The referee: in black, a little off the ball on the diagonal, whistling. */
  private stepRef(dt: number, c: number, s: number): void {
    const M = this.match!, g = this.g, P = this.plan!;
    const on = M.phase !== 'pre' && M.phase !== 'done' && M.phase !== 'full';
    if (!on) { if (this.ref) { this.ref.alive = false; this.ref = null; } return; }
    const R = this.refPos;
    if (!this.ref) {
      const cit = this.citizen(deriveSeed(this.fix?.seed ?? 1, 'referee'), false);
      if (!cit) return;
      const [x, z] = P.toWorld(0, -6);
      const a = g.peds.spawnAt(cit, x, z, 0);
      if (!a) return;
      a.puppet = true;
      attach(a, makeActor('bystander', SOCCER_OWNER, { title: 'Referee', outfit: refOutfit(cit.seed), held: null, hp: 50, maxHp: 50, mood: 'focused' }));
      this.ref = a;
      R.x = 0; R.y = -6; R.vx = R.vy = 0;
    }
    const b = M.ball;
    const tx = M.phase === 'half' ? 0 : clamp(b.x * 0.85 - Math.sign(b.x || 1) * 6, -PITCH.L + 8, PITCH.L - 8);
    const ty = M.phase === 'half' ? -PITCH.W - 2 : clamp(b.y * 0.6 - 9, -PITCH.W + 3, PITCH.W - 6);
    const dx = tx - R.x, dy = ty - R.y, dl = Math.hypot(dx, dy);
    const want = dl < 0.5 ? 0 : Math.min(dl * 1.2, 6.5);
    R.vx += ((dl > 1e-6 ? (dx / dl) * want : 0) - R.vx) * Math.min(1, dt * 3);
    R.vy += ((dl > 1e-6 ? (dy / dl) * want : 0) - R.vy) * Math.min(1, dt * 3);
    R.x += R.vx * dt; R.y += R.vy * dt;
    const sp = Math.hypot(R.vx, R.vy);
    const face = sp > 0.6 ? Math.atan2(R.vy, R.vx) : Math.atan2(b.y - R.y, b.x - R.x);
    this.place(this.ref, R.x, R.y, face, sp, c, s);
    const act = this.ref.actor!;
    const [bx, bz] = P.toWorld(b.x, b.y);
    act.face = { x: bx, y: P.field + 0.5, z: bz };
  }

  /** Danger or a hit: the match is off, everyone runs. */
  abandon(x: number, z: number): void {
    const M = this.match;
    if (!M || this.abandoned) return;
    this.abandoned = true;
    this.stats.abandoned++;
    this.g.audio.play('crowd_gasp', x, this.plan!.field + 3, z, 1, 1, 40, this.g.renderer.camera.position);
    for (const b of [...this.bodies.values()]) this.dropBody(b, false);
    this.bodies.clear();
    if (this.ref) { this.release(this.ref); this.ref = null; }
    for (const f of this.figures) f.on = false;
    this.match = null;
    this.wait = BREAK_S * 3;
  }

  private onStimulus(s: Stimulus): void {
    const P = this.plan;
    if (!P || !this.match) return;
    const d = Math.hypot(s.x - P.lm.x, s.z - P.lm.z);
    const bowl = P.lm.p.ia + P.lm.p.tiers * P.lm.p.depth + 10;
    if (d > bowl + s.radius * 0.5) return;
    switch (s.kind) {
      case 'blast': case 'collapse': case 'sonic': case 'roar': case 'threat': case 'gunfire': this.abandon(s.x, s.z); break;
      case 'power': if (d < bowl) this.abandon(s.x, s.z); break;
      case 'stomp': if ((s.size ?? 0) > 4) this.abandon(s.x, s.z); break;
      case 'siren': if (s.evac) this.abandon(s.x, s.z); break;
      default: break;
    }
  }

  private citizen(seed: number, women: boolean | null): Citizen | null {
    const pop = this.g.population;
    for (let k = 0; k < 40; k++) {
      const c = pop.synthetic(hash32(seed + k * 7919) || 1);
      if (c.role === Role.Child || c.role === Role.Senior) continue;
      if (women !== null && (c.gender < 0.5) !== women && k < 36) continue;
      return c;
    }
    return null;
  }

  // ================================================================== the ball

  private stepBall(dt: number, d: number): void {
    const M = this.match, P = this.plan!;
    const show = !!M && d < DROP_R && M.phase !== 'pre' && M.phase !== 'done' && M.phase !== 'half' && !(M.phase === 'full' && M.phaseT > 3);
    if (!show) { if (this.ball) this.ball.visible = false; return; }
    if (!this.ball) this.ball = this.makeBall();
    const m = this.ball, b = M!.ball;
    const [x, z] = P.toWorld(b.x, b.y);
    const ox = m.position.x, oz = m.position.z;
    m.visible = true;
    m.position.set(x, P.field + Math.max(0.11, b.h), z);
    // Rolling: about the axis across its way, by the distance over the radius.
    const dx = x - ox, dz = z - oz, dl = Math.hypot(dx, dz);
    if (dl > 1e-4 && dl < 5) { _ax.set(dz / dl, 0, -dx / dl); _q.setFromAxisAngle(_ax, dl / 0.11); m.quaternion.premultiply(_q); }
  }

  private makeBall(): THREE.Mesh {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 64;
    const x = c.getContext('2d')!;
    x.fillStyle = '#f4f4f0'; x.fillRect(0, 0, 128, 64);
    x.fillStyle = '#16161a';
    // Patches over the sphere (equirectangular: a pentagon look from afar).
    for (const [u, v, r] of [[16, 32, 8], [48, 14, 7], [48, 50, 7], [80, 32, 8], [112, 14, 7], [112, 50, 7], [0, 4, 6], [64, 4, 6], [0, 60, 6], [64, 60, 6]]) {
      x.beginPath();
      for (let k = 0; k < 5; k++) { const a = (k / 5) * Math.PI * 2 - Math.PI / 2; x.lineTo(u + Math.cos(a) * r, v + Math.sin(a) * r * 0.9); }
      x.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 }));
    m.castShadow = true;
    this.g.renderer.scene.add(m);
    return m;
  }

  // ================================================================== the scoreboard

  private stepBoard(): void {
    const M = this.match, P = this.plan!;
    if (!this.board) {
      const c = document.createElement('canvas');
      c.width = 512; c.height = 196;
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(P.board.w, P.board.h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
      mesh.position.set(P.board.x, P.board.y, P.board.z);
      // (The plane faces +z: turned to face along the board's normal.)
      mesh.rotation.y = Math.atan2(P.board.nx, P.board.nz);
      this.g.renderer.scene.add(mesh);
      this.board = { mesh, tex, ctx: c.getContext('2d')!, key: '' };
    }
    const B = this.board;
    const T = M?.teams;
    const key = M && T ? `${T[0].short}${M.score[0]}${T[1].short}${M.score[1]}${M.minute()}${M.phase === 'half' ? 'H' : M.phase === 'full' ? 'F' : ''}${M.goals.length}` : `idle${this.wait > 0 ? 1 : 0}`;
    if (key === B.key) return;
    B.key = key;
    const x = B.ctx, W = 512, H = 196;
    x.fillStyle = '#05070a'; x.fillRect(0, 0, W, H);
    x.textAlign = 'center'; x.textBaseline = 'middle';
    if (!M || !T) {
      x.fillStyle = '#ffcf40'; x.font = 'bold 44px sans-serif';
      x.fillText(this.plan!.lm.name.toUpperCase(), W / 2, H / 2);
    } else {
      const col = (k: Kit) => `rgb(${k.shirt.map((v) => Math.round(Math.pow(v, 1 / 2.2) * 255)).join(',')})`;
      x.fillStyle = col(T[0].kit); x.fillRect(18, 22, 18, 74);
      x.fillStyle = col(T[1].kit); x.fillRect(W - 36, 22, 18, 74);
      x.fillStyle = '#f2f2f2'; x.font = 'bold 54px sans-serif';
      x.fillText(T[0].short, 110, 60); x.fillText(T[1].short, W - 110, 60);
      x.fillStyle = '#ffcf40'; x.font = 'bold 70px sans-serif';
      x.fillText(`${M.score[0]} - ${M.score[1]}`, W / 2, 62);
      x.font = 'bold 44px sans-serif'; x.fillStyle = '#7fe08a';
      x.fillText(M.phase === 'half' ? 'HALF TIME' : M.phase === 'full' || M.phase === 'done' ? 'FULL TIME' : M.phase === 'walkout' || M.phase === 'pre' ? 'KICK-OFF SOON' : `${M.minute()}'`, W / 2, 128);
      // The last goal.
      const lg = M.goals[M.goals.length - 1];
      if (lg) { x.font = '26px sans-serif'; x.fillStyle = '#c8d0d8'; x.fillText(`⚽ ${lg.name} ${lg.min}'  (${T[lg.team].short})`, W / 2, 170); }
    }
    B.tex.needsUpdate = true;
  }

  // ================================================================== the stands

  private stepFigures(dt: number): void {
    const M = this.match, P = this.plan!;
    this.cheerT -= dt;
    if (!M) { if (this.figures.length) for (const f of this.figures) f.on = false; this.stats.figures = 0; return; }
    if (!this.figures.length) {
      for (let i = 0; i < P.seats.length; i++) {
        const s = P.seats[i];
        const cit = this.citizen(deriveSeed(this.g.settings.seed, 'soccer', 'fan', i), null);
        if (!cit) continue;
        this.figures.push({ cit, x: s.x, y: s.y, z: s.z, heading: s.heading, clip: 'sit', phase: 0, on: false });
        this.seatOf.push(s);
      }
    }
    // How full: the clubs' pull, filling up during the walk out, emptying at the end.
    const pull = 0.35 + 0.25 * ((this.clubs[this.fix?.home ?? 0]?.level ?? 0.5) + (this.clubs[this.fix?.away ?? 0]?.level ?? 0.5));
    const fill = M.phase === 'walkout' || M.phase === 'pre' ? pull * clamp(0.5 + M.phaseT / 40, 0, 1) : M.phase === 'full' ? pull * (1 - M.phaseT / 26) : pull;
    let n = 0;
    for (let i = 0; i < this.figures.length; i++) {
      const f = this.figures[i];
      f.on = hash32(i * 7 + 11) % 1000 < fill * 1000;
      if (!f.on) continue;
      n++;
      // Up on their feet for a goal (most), the rest seated.
      f.clip = this.cheerT > 0 && hash32(i * 13 + 5) % 10 < 7 ? 'groove' : 'sit';
      const s = this.seatOf[i];
      f.x = s.x; f.y = s.y; f.z = s.z;
    }
    this.stats.figures = n;
  }

  private cheer(k: number): void {
    const g = this.g, P = this.plan!, y = P.field + 4;
    for (let n = 0; n < 4; n++) g.later.after(n * 0.35, () => g.audio.play('crowd_cheer', P.lm.x + (n - 1.5) * 25, y, P.lm.z, clamp(k, 0, 1), 0.9 + n * 0.05, 60, g.renderer.camera.position));
  }

  private crowdSound(dt: number, d: number): void {
    const P = this.plan!, g = this.g;
    const want = !!this.match && d < HEAR_R;
    this.loopTry -= dt;
    if (want && !this.crowdLoop && this.loopTry <= 0) { this.loopTry = 2; this.crowdLoop = g.audio.loop('amb_crowd', 45); }
    if (this.crowdLoop) {
      this.crowdLoop.set(P.lm.x, P.field + 3, P.lm.z, want ? 0.75 : 0);
      if (!want && d > 1200) { this.crowdLoop.stop(); this.crowdLoop = null; }
    }
  }

  // ================================================================== dev

  private installDev(): void {
    const dev = (window as unknown as { dev?: Record<string, unknown> }).dev;
    if (!dev) return;
    this.devDone = true;
    const P = this.plan!;
    dev.soccer = {
      soccer: this,
      status: () => {
        const M = this.match;
        return M ? { phase: M.phase, minute: M.minute(), half: M.half, score: M.score.join('-'), teams: M.teams.map((t) => t.name), scorers: M.goals, held: M.held, ...this.stats } : { match: null, wait: this.wait, ...this.stats };
      },
      start: () => { this.forced = true; this.wait = 0; if (this.match) this.endMatch(); this.wait = 0; return 'match now'; },
      stop: () => { this.endMatch(); this.wait = 1e9; return 'stopped (start() for one now)'; },
      skip: (s: number) => { const M = this.match; if (!M) return null; for (let t = 0; t < s; t += 0.05) M.update(0.05); this.seen = M.events.length; return M.phase; },
      go: (where: 'pitch' | 'stand' | 'far' = 'stand') => {
        const g = this.g;
        let x: number, z: number, y: number, look: number;
        if (where === 'pitch') { [x, z] = P.toWorld(0, -PITCH.W - 4); y = P.field; look = P.angle + Math.PI / 2; }
        else if (where === 'far') { [x, z] = P.toWorld(0, -400); y = g.world.groundHeight(x, z); look = P.angle + Math.PI / 2; }
        else { const s = P.seats.reduce((b, q) => (Math.abs(P.toPitch(q.x, q.z)[0]) < Math.abs(P.toPitch(b.x, b.z)[0]) && P.toPitch(q.x, q.z)[1] < 0 ? q : b), P.seats[0]); x = s.x; z = s.z; y = s.y; look = s.heading; }
        g.freeCam = false;
        g.player.pos.set(x, y + 0.1, z);
        g.player.vel.set(0, 0, 0);
        g.camRig.yaw = look;
        return { x: Math.round(x), z: Math.round(z) };
      },
    };
  }
}

const _ax = new THREE.Vector3(), _q = new THREE.Quaternion();

const cloth = (seed: number, primary: [number, number, number], secondary: [number, number, number] = primary, pattern = 'plain'): ItemVisual =>
  ({ shape: 'cloth', seed, primary, secondary, accent: secondary, material: pattern, glow: 0, glowColor: [0, 0, 0], wear: 0.05, style: '' });

/** A club's kit (the keeper's in his own colour, long sleeves and gloves). */
export function kitOutfit(k: Kit, keeper: boolean, seed: number): EquipmentVisuals {
  const boots: [number, number, number] = [0.08, 0.08, 0.09];
  if (keeper) return {
    chest: { defId: 'sweater', visual: cloth(seed, k.keeper, [k.keeper[0] * 0.6, k.keeper[1] * 0.6, k.keeper[2] * 0.6]) },
    legs: { defId: 'shorts', visual: cloth(seed + 1, [0.1, 0.1, 0.12]) },
    feet: { defId: 'sneakers', visual: cloth(seed + 2, boots) },
    hands: { defId: 'gloves', visual: cloth(seed + 3, [0.92, 0.92, 0.88]) },
  } as EquipmentVisuals;
  return {
    chest: { defId: 'tshirt', visual: cloth(seed, k.shirt, k.trim, k.pattern) },
    legs: { defId: 'shorts', visual: cloth(seed + 1, k.shorts) },
    feet: { defId: 'sneakers', visual: cloth(seed + 2, boots) },
  };
}

function refOutfit(seed: number): EquipmentVisuals {
  return {
    chest: { defId: 'tshirt', visual: cloth(seed, [0.06, 0.06, 0.07], [0.9, 0.9, 0.9]) },
    legs: { defId: 'shorts', visual: cloth(seed + 1, [0.06, 0.06, 0.07]) },
    feet: { defId: 'sneakers', visual: cloth(seed + 2, [0.08, 0.08, 0.09]) },
  };
}
