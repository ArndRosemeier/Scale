/**
 * Soccer in the stadium, the pure part (no three.js: runs in the self test). A match of two sides
 * of eleven on the stadium's pitch, in the pitch's own frame: x along its length (the stadium's
 * site u, goals at ±PITCH.L), y across (site v, touchlines at ±PITCH.W).
 *
 *  - Not the whole rule book, but what one sees from the stands: the walk out, kick-off, passing
 *    (along the ground, lofted when long), dribbling, tackles (now and then a foul and a free kick),
 *    shots, the keeper's saves (caught, parried, beaten), throw-ins, corners, goal kicks, goals with
 *    their celebration, half time with ends changed, the final whistle and the walk off.
 *  - Every player has skills (pace, control, passing, shooting, tackling, heading, stamina; the
 *    keeper's keeping): a team's level and one strength and one weakness each, which show: a quick
 *    winger outruns his marker, a wayward passer gives the ball away, a keeper with butterfingers
 *    spills shots. Tired legs slow everyone late in a half.
 *  - Deterministic: a fixed step (STEP) and its own random stream per match, so a match plays the
 *    same seen or unseen; `events` is what happened for the owner to show and play sounds for.
 */
import { Rng } from '../../core/rng';
import { clamp } from '../../core/math';

/** Pitch half length and half width, goal half width and height, the boxes (m). */
export const PITCH = { L: 52.5, W: 34, goalW: 3.66, goalH: 2.44, boxL: 16.5, boxW: 20.16, sixL: 5.5 };
/** Real seconds of a half (shown as 45 minutes), half time, and from the final whistle to the end. */
export const HALF = 150, HALF_TIME = 28, AFTER = 26;
/** Fixed simulation step (s). */
export const STEP = 0.05;

export type Pos = 'GK' | 'DF' | 'MF' | 'FW';
export type Skill = 'pace' | 'control' | 'passing' | 'shooting' | 'tackling' | 'heading' | 'stamina' | 'keeping';
export type Skills = Record<Skill, number>;

/** What a strength and a weakness are called (target frame, the info panel). */
export const SKILL_WORDS: Record<Skill, [string, string]> = {
  pace: ['lightning quick', 'slow'],
  control: ['silky touch', 'heavy first touch'],
  passing: ['sees every pass', 'wayward passer'],
  shooting: ['deadly finisher', 'shoots wide'],
  tackling: ['hard tackler', 'soft in the tackle'],
  heading: ['strong in the air', 'weak in the air'],
  stamina: ['tireless', 'tires late'],
  keeping: ['cat-like reflexes', 'butterfingers'],
};

export interface PlayerDef {
  num: number;
  name: string;
  pos: Pos;
  skills: Skills;
  strength: Skill;
  weakness: Skill;
  /** Formation spot (own goal at fx -1, the halfway line 0; fy across, -1…1). */
  fx: number; fy: number;
  /** Seed of the citizen who plays (looks, gender). */
  cit: number;
}

export interface Kit { shirt: [number, number, number]; trim: [number, number, number]; pattern: 'plain' | 'stripes' | 'checks'; shorts: [number, number, number]; keeper: [number, number, number] }

export interface TeamDef {
  name: string;
  short: string;
  kit: Kit;
  players: PlayerDef[];
  /** How high they press (0 sit back … 1 hunt the ball), how fast they move it on. */
  press: number;
  tempo: number;
}

export type ActId = 'kick' | 'pass' | 'shoot' | 'tackle' | 'slide' | 'header' | 'dive' | 'catch' | 'throw' | 'celebrate' | 'dejected' | 'fall' | 'clap';

export interface Man {
  team: 0 | 1;
  i: number;
  def: PlayerDef;
  x: number; y: number;
  vx: number; vy: number;
  /** Facing (radians, atan2(dy, dx) in the pitch frame). */
  face: number;
  tx: number; ty: number;
  /** Wanted speed now (m/s). */
  want: number;
  fatigue: number;
  act: { id: ActId; t: number; dur: number; side: number } | null;
  /** Seconds until the next decision (on the ball), until they can touch the ball again, beaten (slowed). */
  think: number;
  noTouch: number;
  beaten: number;
  /** Seconds the keeper has held the ball. */
  hold: number;
  /** On the pitch (false: off it, before the walk out and after the walk off). */
  on: boolean;
}

export interface Ball {
  x: number; y: number; h: number;
  vx: number; vy: number; vh: number;
  owner: Man | null;
  last: Man | null;
  /** A shot on its way (the keeper decides once), and by whom. */
  shot: Man | null;
  saveTried: boolean;
  /** Whom a pass is meant for (they go to meet it; the others only if clearly nearer). */
  target: Man | null;
}

export type Phase = 'pre' | 'walkout' | 'kickoff' | 'play' | 'restart' | 'goal' | 'half' | 'full' | 'done';
export type RestartKind = 'throw' | 'corner' | 'goalkick' | 'free' | 'kickoff';

export interface MatchEvent {
  kind: 'whistle' | 'kick' | 'goal' | 'save' | 'miss' | 'tackle' | 'foul' | 'out' | 'half' | 'full' | 'kickoff' | 'chance' | 'catch' | 'post';
  /** Match minute. */
  min: number;
  team?: 0 | 1;
  man?: Man;
  /** Kick strength 0…1 (sound), whistle length (1 short, 2 long, 3 the final three). */
  k?: number;
  text?: string;
}

const SK: Skill[] = ['pace', 'control', 'passing', 'shooting', 'tackling', 'heading', 'stamina'];

/** 4-4-2 and 4-3-3 (own goal at fx -1). */
const SHAPES: { pos: Pos; fx: number; fy: number }[][] = [
  [
    { pos: 'GK', fx: -0.96, fy: 0 },
    { pos: 'DF', fx: -0.68, fy: -0.62 }, { pos: 'DF', fx: -0.74, fy: -0.22 }, { pos: 'DF', fx: -0.74, fy: 0.22 }, { pos: 'DF', fx: -0.68, fy: 0.62 },
    { pos: 'MF', fx: -0.3, fy: -0.66 }, { pos: 'MF', fx: -0.36, fy: -0.2 }, { pos: 'MF', fx: -0.36, fy: 0.2 }, { pos: 'MF', fx: -0.3, fy: 0.66 },
    { pos: 'FW', fx: 0.02, fy: -0.22 }, { pos: 'FW', fx: 0.02, fy: 0.22 },
  ],
  [
    { pos: 'GK', fx: -0.96, fy: 0 },
    { pos: 'DF', fx: -0.68, fy: -0.62 }, { pos: 'DF', fx: -0.74, fy: -0.22 }, { pos: 'DF', fx: -0.74, fy: 0.22 }, { pos: 'DF', fx: -0.68, fy: 0.62 },
    { pos: 'MF', fx: -0.44, fy: 0 }, { pos: 'MF', fx: -0.3, fy: -0.42 }, { pos: 'MF', fx: -0.3, fy: 0.42 },
    { pos: 'FW', fx: -0.02, fy: -0.66 }, { pos: 'FW', fx: 0.04, fy: 0 }, { pos: 'FW', fx: -0.02, fy: 0.66 },
  ],
];
const NUMS: Record<Pos, number[]> = { GK: [1], DF: [2, 3, 4, 5, 6, 12, 15], MF: [7, 8, 10, 14, 16, 18, 20], FW: [9, 11, 17, 19, 21, 22] };

/**
 * A side for a match: names from `name(i)` (the citizens who play: seeds cit(i)), a level 0…1
 * (the teams of a city differ), the kit given.
 */
export function makeTeam(rng: Rng, name: string, short: string, kit: Kit, level: number, who: (i: number) => { name: string; cit: number }): TeamDef {
  const shape = rng.pick(SHAPES);
  const used = new Set<number>();
  const players = shape.map((s, i): PlayerDef => {
    const base = 0.35 + level * 0.35;
    const skills = {} as Skills;
    for (const k of SK) skills[k] = clamp(base + rng.gaussian(0, 0.08), 0.1, 0.95);
    skills.keeping = s.pos === 'GK' ? clamp(base + 0.1 + rng.gaussian(0, 0.08), 0.15, 0.95) : 0.1;
    // What the position asks for.
    if (s.pos === 'DF') { skills.tackling += 0.12; skills.heading += 0.1; skills.shooting -= 0.12; }
    if (s.pos === 'MF') { skills.passing += 0.1; skills.stamina += 0.08; }
    if (s.pos === 'FW') { skills.shooting += 0.14; skills.pace += 0.06; skills.tackling -= 0.15; }
    if (s.pos === 'GK') { skills.pace -= 0.1; skills.shooting -= 0.2; }
    // One thing they are known for, one they are not.
    const pool: Skill[] = s.pos === 'GK' ? ['keeping', 'passing', 'control'] : s.pos === 'DF' ? ['tackling', 'heading', 'pace', 'passing', 'control', 'stamina'] : s.pos === 'MF' ? ['passing', 'control', 'stamina', 'tackling', 'shooting', 'pace'] : ['shooting', 'pace', 'control', 'heading', 'passing'];
    const strength = rng.pick(pool);
    let weakness = rng.pick(s.pos === 'GK' ? ['keeping', 'passing', 'control', 'pace'] as Skill[] : SK);
    if (weakness === strength) weakness = SK[(SK.indexOf(strength) + 3) % SK.length];
    skills[strength] += 0.28;
    skills[weakness] -= 0.3;
    for (const k of [...SK, 'keeping'] as Skill[]) skills[k] = clamp(skills[k], 0.05, 1);
    const nums = NUMS[s.pos].filter((n) => !used.has(n));
    const num = nums.length ? nums[0] : 23 + i;
    used.add(num);
    const w = who(i);
    return { num, name: w.name, pos: s.pos, skills, strength, weakness, fx: s.fx, fy: s.fy, cit: w.cit };
  });
  return { name, short, kit, players, press: rng.range(0.25, 0.8), tempo: rng.range(0.3, 0.9) };
}

/** The title of a player on the target frame: "Rovers #9 Silva, striker: deadly finisher, slow". */
export function playerTitle(t: TeamDef, p: PlayerDef): string {
  const role = p.pos === 'GK' ? 'keeper' : p.pos === 'DF' ? 'defender' : p.pos === 'MF' ? 'midfielder' : 'striker';
  return `${t.short} #${p.num} ${p.name.split(' ').pop()}, ${role}: ${SKILL_WORDS[p.strength][0]}, ${SKILL_WORDS[p.weakness][1]}`;
}

const TAU = Math.PI * 2;

export class Match {
  readonly men: Man[] = [];
  readonly ball: Ball = { x: 0, y: 0, h: 0, vx: 0, vy: 0, vh: 0, owner: null, last: null, shot: null, saveTried: false, target: null };
  readonly score: [number, number] = [0, 0];
  readonly events: MatchEvent[] = [];
  /** Goals for the scoreboard: minute, team, scorer. */
  readonly goals: { min: number; team: 0 | 1; name: string }[] = [];
  phase: Phase = 'pre';
  /** Seconds in the phase; 1 or 2 (which half); real seconds played in this half. */
  phaseT = 0;
  half = 1;
  clock = 0;
  /** A restart about to be taken: who, where, what. */
  restart: { kind: RestartKind; team: 0 | 1; x: number; y: number; taker: Man | null } | null = null;
  /** Play stopped by something on the pitch (the hero walking on): everyone stands. */
  held = false;
  private rng: Rng;
  private acc = 0;
  /** Which team kicked off the first half. */
  private firstKick: 0 | 1;
  /** Where the players come out (and go off): the tunnel's mouth on the pitch (pitch frame). */
  readonly tunnel: [number, number];
  /** Off-pitch spot each side stands at during half time. */
  private bench: [number, number][];

  constructor(seed: number, readonly teams: [TeamDef, TeamDef], tunnelX = -PITCH.L - 4) {
    this.rng = new Rng(seed);
    this.tunnel = [tunnelX, 0];
    this.bench = [[-14, -PITCH.W - 3], [14, -PITCH.W - 3]];
    this.firstKick = this.rng.chance(0.5) ? 0 : 1;
    for (const team of [0, 1] as const) teams[team].players.forEach((def, i) => {
      this.men.push({ team, i, def, x: this.tunnel[0] - 3 - i * 0.8, y: (team ? 1.2 : -1.2), vx: 0, vy: 0, face: 0, tx: 0, ty: 0, want: 0, fatigue: 0, act: null, think: 0, noTouch: 0, beaten: 0, hold: 0, on: false });
    });
  }

  /** Match minute shown (1…45, 46…90, 90 after). */
  minute(): number {
    const m = Math.floor((this.clock / HALF) * 45) + 1;
    return this.half === 1 ? Math.min(45, m) : Math.min(90, 45 + m);
  }

  /** Which way a team attacks now (+1: towards +x). */
  dir(team: 0 | 1): number {
    return (team === 0 ? 1 : -1) * (this.half === 2 ? -1 : 1);
  }

  /** Is the match over (players gone)? */
  get over(): boolean { return this.phase === 'done'; }

  /** Advance by dt (real seconds): fixed steps. */
  update(dt: number): void {
    this.acc += Math.min(dt, 1);
    while (this.acc >= STEP) { this.acc -= STEP; this.step(STEP); }
  }

  private emit(e: Omit<MatchEvent, 'min'>): void {
    this.events.push({ ...e, min: this.minute() });
    if (this.events.length > 400) this.events.splice(0, 200);
  }

  private setPhase(p: Phase): void { this.phase = p; this.phaseT = 0; }

  // ================================================================== the step

  private step(dt: number): void {
    this.phaseT += dt;
    const b = this.ball;
    switch (this.phase) {
      case 'pre':
        this.setPhase('walkout');
        for (const m of this.men) m.on = true;
        break;
      case 'walkout': {
        // Out of the tunnel to the kick-off places.
        this.kickoffShape(this.firstKick);
        let ready = true;
        for (const m of this.men) if (Math.hypot(m.x - m.tx, m.y - m.ty) > 1.2) ready = false;
        if (ready || this.phaseT > 40) this.startKickoff(this.firstKick);
        break;
      }
      case 'kickoff': case 'restart': this.stepRestart(dt); break;
      case 'play': if (!this.held) this.stepPlay(dt); else this.standStill(); break;
      case 'goal': this.stepGoal(); break;
      case 'half':
        for (const m of this.men) { const [bx, by] = this.bench[m.team]; m.tx = bx + ((m.i % 6) - 2.5) * 1.6; m.ty = by - Math.floor(m.i / 6) * 1.5; m.want = 1.6; }
        if (this.phaseT > HALF_TIME) { this.half = 2; this.clock = 0; this.startKickoff(this.firstKick === 0 ? 1 : 0); }
        break;
      case 'full':
        // Off through the tunnel.
        for (const m of this.men) {
          m.tx = this.tunnel[0] - 6; m.ty = (m.team ? 1.5 : -1.5) + ((m.i % 3) - 1) * 0.8; m.want = 1.5 + (m.i % 3) * 0.1;
          if (m.on && Math.hypot(m.x - this.tunnel[0] + 6, m.y - m.ty) < 2.5) m.on = false;
        }
        if (this.phaseT > AFTER || this.men.every((m) => !m.on)) { for (const m of this.men) m.on = false; this.setPhase('done'); }
        break;
      case 'done': return;
    }
    if (this.phase === 'play' && !this.held) this.clock += dt;
    if (this.phase === 'play' && this.clock >= HALF && (b.owner || Math.abs(b.x) < PITCH.L * 0.6)) this.endHalf();
    this.moveMen(dt);
    this.moveBall(dt);
  }

  private standStill(): void {
    for (const m of this.men) { m.tx = m.x; m.ty = m.y; m.want = 0; }
  }

  private endHalf(): void {
    const b = this.ball;
    b.owner = null; b.vx = b.vy = b.vh = 0;
    if (this.half === 1) { this.emit({ kind: 'half', k: 2 }); this.setPhase('half'); }
    else { this.emit({ kind: 'full', k: 3 }); this.setPhase('full'); for (const m of this.men) m.act = { id: this.score[m.team] > this.score[1 - m.team] ? 'celebrate' : this.score[m.team] < this.score[1 - m.team] ? 'dejected' : 'clap', t: 0, dur: 3, side: 1 }; }
  }

  // ================================================================== restarts

  private startKickoff(team: 0 | 1): void {
    const b = this.ball;
    Object.assign(b, { x: 0, y: 0, h: 0, vx: 0, vy: 0, vh: 0, owner: null, shot: null, saveTried: false });
    this.restart = { kind: 'kickoff', team, x: 0, y: 0, taker: null };
    this.setPhase('kickoff');
  }

  /** Everyone in their own half, the kicking side's forwards at the centre spot. */
  private kickoffShape(team: 0 | 1): void {
    for (const m of this.men) {
      const d = this.dir(m.team);
      let fx = m.def.fx * 0.92 - 0.06, fy = m.def.fy;
      if (m.def.pos === 'FW' && m.team === team) { fx = -0.01; fy = Math.sign(m.def.fy || 1) * 0.05; }
      if (m.team !== team) fx = Math.min(fx, -0.2);
      m.tx = d * fx * PITCH.L; m.ty = fy * PITCH.W * 0.9;
      m.want = this.phase === 'walkout' ? 2.2 : 3.2;
    }
  }

  private stepRestart(dt: number): void {
    const R = this.restart!, b = this.ball;
    if (R.kind === 'kickoff') {
      this.kickoffShape(R.team);
      const taker = this.men.filter((m) => m.team === R.team && m.def.pos === 'FW').sort((p, q) => Math.hypot(p.x, p.y) - Math.hypot(q.x, q.y))[0] ?? this.men.find((m) => m.team === R.team)!;
      R.taker = taker;
      taker.tx = -this.dir(R.team) * 0.6; taker.ty = 0;
      const ready = this.men.every((m) => Math.hypot(m.x - m.tx, m.y - m.ty) < 2.5);
      if ((ready && this.phaseT > 2.5) || this.phaseT > 14) {
        this.emit({ kind: 'whistle', k: 1 });
        this.emit({ kind: 'kickoff', team: R.team });
        // Rolled to a teammate behind.
        const mate = this.men.filter((m) => m.team === R.team && m !== taker && m.def.pos === 'MF').sort((p, q) => Math.hypot(p.x, p.y) - Math.hypot(q.x, q.y))[0];
        this.setPhase('play');
        b.owner = taker; b.last = taker;
        if (mate) this.pass(taker, mate, false);
      }
      return;
    }
    // Others take up their places (attackers into the box for a corner).
    this.shape(R.team, R.x, R.y, false);
    if (R.kind === 'corner') this.boxRun(R.team);
    if (!R.taker || R.taker.def.pos === 'GK' && R.kind !== 'goalkick') {
      R.taker = R.kind === 'goalkick'
        ? this.men.find((m) => m.team === R.team && m.def.pos === 'GK')!
        : this.nearest(R.x, R.y, (m) => m.team === R.team && m.def.pos !== 'GK');
    }
    const t = R.taker!;
    // The taker to the ball (a step behind it, facing the play).
    const d = this.dir(R.team);
    const bx = R.kind === 'throw' ? R.x : R.x - d * 0.5, by = R.kind === 'throw' ? R.y + Math.sign(R.y) * 0.4 : R.y;
    t.tx = bx; t.ty = by; t.want = 5;
    Object.assign(b, { x: R.x, y: R.y, h: R.kind === 'throw' ? 0.1 : 0, vx: 0, vy: 0, vh: 0, owner: null, shot: null, saveTried: false });
    // Nobody else within 9 m of a free kick or corner.
    if (R.kind !== 'throw') for (const m of this.men) if (m.team !== R.team) {
      const dd = Math.hypot(m.tx - R.x, m.ty - R.y);
      if (dd < 9.2) { m.tx = R.x + ((m.tx - R.x) / (dd || 1)) * 9.2; m.ty = R.y + ((m.ty - R.y) / (dd || 1)) * 9.2; }
    }
    if (Math.hypot(t.x - t.tx, t.y - t.ty) < 0.8 && this.phaseT > 1.6 || this.phaseT > 12) {
      t.x = t.tx; t.y = t.ty;
      if (R.kind === 'free' || R.kind === 'corner') this.emit({ kind: 'whistle', k: 1 });
      this.setPhase('play');
      b.owner = t; b.last = t;
      t.think = 0;
      this.restart = null;
      this.restartKick(t, R.kind);
    }
  }

  private restartKick(t: Man, kind: RestartKind): void {
    const d = this.dir(t.team);
    if (kind === 'corner') {
      // A cross to whoever is best placed in the box.
      const tgt = this.men.filter((m) => m.team === t.team && m !== t && Math.abs(m.x - d * PITCH.L) < 16 && Math.abs(m.y) < 14)
        .sort((p, q) => q.def.skills.heading - p.def.skills.heading + this.rng.range(-0.3, 0.3))[0];
      if (tgt) { this.cross(t, tgt.x, tgt.y); return; }
    }
    if (kind === 'throw') {
      const mate = this.men.filter((m) => m.team === t.team && m !== t && m.def.pos !== 'GK').sort((p, q) => Math.hypot(p.x - t.x, p.y - t.y) - Math.hypot(q.x - t.x, q.y - t.y))[this.rng.int(0, 1)];
      if (mate) { this.throwTo(t, mate); return; }
    }
    if (kind === 'goalkick') {
      const mate = this.men.filter((m) => m.team === t.team && (m.def.pos === 'MF' || m.def.pos === 'FW')).sort(() => this.rng.float() - 0.5)[0];
      if (mate) { this.longBall(t, mate.x + d * 6, mate.y); return; }
    }
    if (kind === 'free' && Math.abs(d * PITCH.L - t.x) < 30 && Math.abs(t.y) < 20) { this.shoot(t); return; }
    this.decide(t, true);
  }

  // ================================================================== open play

  private stepPlay(dt: number): void {
    const b = this.ball;
    const owner = b.owner;
    const att: 0 | 1 = owner ? owner.team : (b.last?.team ?? 0);
    // Who goes for a loose ball (each side's quickest to it).
    const chase: Man[] = [];
    if (!owner) {
      const tgt = b.target && b.target.on ? b.target : null, tt = tgt ? this.reach(tgt) : Infinity;
      for (const team of [0, 1] as const) {
        let best: Man | null = null, bt = Infinity;
        for (const m of this.men) {
          if (m.team !== team || !m.on || m.def.pos === 'GK' && Math.abs(b.x - this.dir(team) * -PITCH.L) > PITCH.boxL + 4) continue;
          const t = this.reach(m);
          if (t < bt) { bt = t; best = m; }
        }
        if (tgt && tgt.team === team) best = tgt;
        // (A pass meant for the others: only if clearly first to it.)
        else if (tgt && best && bt > tt - 0.35) best = null;
        if (best) chase.push(best);
      }
    }
    // The shape of both sides around the ball.
    this.shape(0, b.x, b.y, att === 0 && !!owner);
    this.shape(1, b.x, b.y, att === 1 && !!owner);
    for (const m of chase) {
      const [ix, iy] = this.intercept(m);
      m.tx = ix; m.ty = iy; m.want = this.top(m);
    }
    if (owner) {
      // The defending side presses: the nearest goes for the ball, the next covers.
      const def = (1 - owner.team) as 0 | 1;
      const near = this.men.filter((m) => m.team === def && m.def.pos !== 'GK').sort((p, q) => Math.hypot(p.x - b.x, p.y - b.y) - Math.hypot(q.x - b.x, q.y - b.y));
      const press = this.teams[def].press;
      const myHalf = (b.x * this.dir(def)) < PITCH.L * (0.2 - press * 0.6);
      if (near[0] && (myHalf || Math.hypot(near[0].x - b.x, near[0].y - b.y) < 14 + press * 10)) {
        near[0].tx = b.x - this.dir(def) * 0.6; near[0].ty = b.y; near[0].want = this.top(near[0]) * 0.92;
      }
      if (near[1]) {
        const gx = -this.dir(def) * PITCH.L;
        near[1].tx = b.x + (gx - b.x) * 0.25; near[1].ty = b.y * 0.75; near[1].want = this.top(near[1]) * 0.75;
      }
      this.onBall(owner, dt);
      this.tackles(owner, near.slice(0, 2), dt);
    }
    this.keepers();
  }

  /** The side's places for the ball at (bx, by): the formation slid towards the ball, up the pitch when attacking. */
  private shape(team: 0 | 1, bx: number, by: number, attacking: boolean): void {
    const d = this.dir(team);
    const ball = (bx * d) / PITCH.L; // -1 own goal … 1 their goal
    // The deepest defender (the others' forwards stay level with it: a rough offside line).
    let lastDef = 0;
    for (const m of this.men) if (m.team !== team && m.def.pos !== 'GK' && m.on) lastDef = Math.max(lastDef, m.x * d);
    for (const m of this.men) {
      if (m.team !== team || m.def.pos === 'GK' || m === this.ball.owner) continue;
      const P = m.def;
      let fx = P.fx * 0.62 + ball * 0.5 + (attacking ? 0.2 : -0.06);
      if (P.pos === 'FW' && attacking) fx += 0.12;
      if (P.pos === 'DF') fx = Math.min(fx, attacking ? 0.15 : -0.25);
      fx = clamp(fx, -0.9, 0.9);
      let x = fx * PITCH.L;
      if (attacking) x = Math.min(x, Math.max(lastDef, ball * PITCH.L) - 0.5);
      const fy = P.fy * (attacking ? 0.95 : 0.78) + (by / PITCH.W) * 0.28;
      // A little life: drifting about their spot.
      const sway = Math.sin(this.clock * 0.37 + m.i * 1.7 + m.team) * 2.2;
      m.tx = x * d; m.ty = clamp(fy * PITCH.W + sway, -PITCH.W + 1.5, PITCH.W - 1.5);
      const far = Math.hypot(m.tx - m.x, m.ty - m.y);
      m.want = far > 12 ? this.top(m) * 0.85 : far > 4 ? 3.6 : 1.8;
    }
  }

  /** At a corner the attackers crowd the box, defenders mark them. */
  private boxRun(team: 0 | 1): void {
    const d = this.dir(team), gx = d * PITCH.L;
    let k = 0;
    for (const m of this.men) {
      if (m.def.pos === 'GK' || m === this.restart?.taker) continue;
      if (m.team === team && (m.def.pos !== 'DF' || k < 6) && k < 6) { m.tx = gx - d * (6 + (k % 3) * 3.5); m.ty = (k - 2.5) * 3.2; k++; }
      else if (m.team !== team && m.def.pos !== 'FW') { m.tx = gx - d * (4 + (m.i % 3) * 3); m.ty = ((m.i % 5) - 2) * 3.4; }
    }
  }

  /** The keepers: on the line between the ball and the goal's middle, off their line as the ball comes. */
  private keepers(): void {
    const b = this.ball;
    for (const m of this.men) {
      if (m.def.pos !== 'GK' || m === b.owner) continue;
      const d = this.dir(m.team), gx = -d * PITCH.L;
      const db = Math.hypot(b.x - gx, b.y);
      // A loose ball in the box near him: go for it (the chase above set that).
      if (!b.owner && Math.abs(b.x - gx) < PITCH.boxL && Math.abs(b.y) < PITCH.boxW && Math.hypot(b.x - m.x, b.y - m.y) < 12 && !b.shot) continue;
      const out = clamp(db * 0.12, 0.8, 6);
      m.tx = gx + ((b.x - gx) / (db || 1)) * out; m.ty = clamp((b.y / (db || 1)) * out, -PITCH.goalW, PITCH.goalW);
      m.want = b.shot ? this.top(m) : 3.5;
    }
  }

  /** The player with the ball: dribble on, pass, shoot (a decision every few tenths of a second). */
  private onBall(m: Man, dt: number): void {
    const b = this.ball;
    if (m.def.pos === 'GK' && b.h < 0.01 && m.hold >= 0) {
      // Holding it: a moment, then a throw to a defender or a long kick.
      m.hold += dt;
      m.tx = m.x; m.ty = m.y; m.want = 0;
      b.x = m.x + Math.cos(m.face) * 0.35; b.y = m.y + Math.sin(m.face) * 0.35; b.h = 1.0;
      if (m.hold > 2.4) {
        m.hold = -1;
        const d = this.dir(m.team);
        const short = this.men.filter((o) => o.team === m.team && o.def.pos === 'DF' && this.open(o) > 6);
        if (short.length && this.rng.chance(0.55)) this.throwTo(m, short[this.rng.int(0, short.length - 1)]);
        else { const mate = this.men.filter((o) => o.team === m.team && o.def.pos !== 'DF' && o.def.pos !== 'GK').sort(() => this.rng.float() - 0.5)[0]; this.longBall(m, (mate?.x ?? 0) + d * 4, mate?.y ?? 0); }
      }
      return;
    }
    m.think -= dt;
    if (m.think > 0) { this.dribble(m); return; }
    m.think = 0.25 + (1 - this.teams[m.team].tempo) * 0.35 + this.rng.float() * 0.2;
    this.decide(m, false);
  }

  private decide(m: Man, restart: boolean): void {
    const d = this.dir(m.team), gx = d * PITCH.L;
    const dist = Math.hypot(gx - m.x, m.y);
    const angle = Math.abs(Math.atan2(Math.abs(m.y), Math.abs(gx - m.x)));
    const pressure = this.pressure(m);
    // Shoot: in range and with a sight of goal (farther for good shooters).
    const range = 17 + m.def.skills.shooting * 15;
    const sight = this.laneOpen(m, gx, 0);
    if (!restart && dist < range && angle < 1.15 && (dist < 15 || this.rng.chance((dist < 22 ? 0.55 + m.def.skills.shooting * 0.4 : 0.15 + m.def.skills.shooting * 0.35) * (sight > 1.5 ? 1 : 0.5)))) { this.shoot(m); return; }
    // Pass: to the best of the open teammates (forward and open), more often under pressure.
    let best: Man | null = null, bs = -Infinity;
    for (const o of this.men) {
      if (o.team !== m.team || o === m || !o.on) continue;
      const dd = Math.hypot(o.x - m.x, o.y - m.y);
      if (dd < 5 || dd > 42) continue;
      const lane = this.laneOpen(m, o.x, o.y);
      if (lane < 1.6) continue;
      // Forward is worth more (more so in their half: balls into the box most).
      const fwd = (((o.x - m.x) * d) / 10) * (m.x * d > 0 ? 1.3 : 1) + (Math.abs(gx - o.x) < 20 && Math.abs(o.y) < 18 ? 0.7 : 0);
      const s = fwd * (0.7 + this.teams[m.team].tempo * 0.5) + Math.min(lane, 8) * 0.08 + Math.min(this.open(o), 10) * 0.08 - Math.abs(dd - 16) * 0.02 - (o.def.pos === 'GK' ? 1.5 : 0) + this.rng.range(-0.3, 0.3);
      if (s > bs) { bs = s; best = o; }
    }
    // A ball over the top / through the line, into the space behind it for a quick forward to run onto.
    let thru: { x: number; y: number; s: number; to: Man } | null = null;
    if (m.x * d > -PITCH.L * 0.3) {
      let line = -PITCH.L;
      for (const o of this.men) if (o.team !== m.team && o.def.pos !== 'GK' && o.on) line = Math.max(line, o.x * d);
      for (const o of this.men) {
        if (o.team !== m.team || o === m || o.def.pos === 'GK' || o.def.pos === 'DF' || !o.on || o.x * d < line - 6) continue;
        const sx = clamp(line + 9, line, PITCH.L - 6) * d, sy = clamp(o.y * 0.8, -PITCH.W + 4, PITCH.W - 4);
        const lane = this.laneOpen(m, sx, sy);
        if (lane < 2.2) continue;
        const sc = 1.1 + o.def.skills.pace * 0.9 + m.def.skills.passing * 0.4 + Math.min(lane, 6) * 0.05 + this.rng.range(-0.4, 0.3);
        if (!thru || sc > thru.s) thru = { x: sx, y: sy, s: sc, to: o };
      }
    }
    if (thru && thru.s > bs && this.rng.chance(0.35 + this.teams[m.team].tempo * 0.4)) {
      this.through(m, thru.x, thru.y, thru.to);
      return;
    }
    // Carrying it on: worth it with room ahead.
    const room = this.room(m);
    const carry = (Math.min(room, 14) / 14) * 1.3 + m.def.skills.control * 0.3 + m.def.skills.pace * 0.2 - (m.def.pos === 'DF' ? 0.3 : 0) - (restart ? 9 : 0);
    if (best && (pressure < 2.2 || bs > carry)) {
        const dd = Math.hypot(best.x - m.x, best.y - m.y);
      // From out wide near goal: a cross.
      if (Math.abs(gx - m.x) < 22 && Math.abs(m.y) > 16 && Math.abs(gx - best.x) < 16 && Math.abs(best.y) < 12) this.cross(m, best.x, best.y);
      else if (dd > 30 || this.laneOpen(m, best.x, best.y) < 3) this.longBall(m, best.x + d * 2, best.y);
      else this.pass(m, best, true);
      return;
    }
    // Nobody to give it to and under pressure: clear it upfield.
    if (pressure < 1.6 && (m.def.pos === 'DF' || m.def.pos === 'GK')) { this.longBall(m, m.x + d * 35, m.y * 0.6 + this.rng.range(-10, 10)); return; }
    this.dribble(m);
  }

  /** Run with the ball towards goal, round the nearest opponent; the ball a touch ahead. */
  private dribble(m: Man): void {
    const d = this.dir(m.team), gx = d * PITCH.L;
    let ax = gx - m.x, ay = -m.y * 0.5;
    const al = Math.hypot(ax, ay) || 1;
    ax /= al; ay /= al;
    const opp = this.nearest(m.x + ax * 4, m.y + ay * 4, (o) => o.team !== m.team && o.on);
    if (opp) {
      const ox = opp.x - m.x, oy = opp.y - m.y, od = Math.hypot(ox, oy);
      if (od < 6) {
        // Step away from them (to the side with more room).
        const side = Math.abs(m.y + 3) < Math.abs(m.y - 3) ? 1 : -1;
        const s = (ox * -ay + oy * ax) > 0 ? -1 : 1;
        ax += -ay * s * 0.8 * side * side; ay += ax * s * 0.8;
        const l = Math.hypot(ax, ay) || 1; ax /= l; ay /= l;
      }
    }
    m.tx = m.x + ax * 6; m.ty = clamp(m.y + ay * 6, -PITCH.W + 1, PITCH.W - 1);
    m.want = this.top(m) * (0.72 + m.def.skills.control * 0.12);
  }

  private tackles(owner: Man, near: Man[], dt: number): void {
    const b = this.ball;
    for (const m of near) {
      if (m.beaten > 0 || m.act) continue;
      const d = Math.hypot(m.x - b.x, m.y - b.y);
      if (d > 1.7 || !this.rng.chance(dt * 2.2)) continue;
      const slide = d > 1.1;
      m.act = { id: slide ? 'slide' : 'tackle', t: 0, dur: slide ? 1.1 : 0.6, side: 1 };
      const win = 0.32 + m.def.skills.tackling * 0.5 - owner.def.skills.control * 0.35 - (slide ? 0.08 : 0);
      if (this.rng.chance(win)) {
        this.emit({ kind: 'tackle', team: m.team, man: m });
        b.owner = null;
        b.last = m;
        // Won clean, or it runs loose.
        if (this.rng.chance(0.5) && !slide) { b.owner = m; m.think = 0.2; }
        else { const a = this.rng.range(0, TAU); this.kickBall(m, Math.cos(a) * 5, Math.sin(a) * 5, 0.5, 0.2); }
        owner.beaten = 0.5;
      } else if (this.rng.chance(0.18 * (1.1 - m.def.skills.tackling) + (slide ? 0.08 : 0))) {
        // A foul: the man goes down, a free kick.
        this.emit({ kind: 'foul', team: m.team, man: m });
        this.emit({ kind: 'whistle', k: 1 });
        owner.act = { id: 'fall', t: 0, dur: 1.6, side: 1 };
        b.owner = null;
        const inBox = Math.abs(b.x - this.dir(owner.team) * PITCH.L) < PITCH.boxL && Math.abs(b.y) < PITCH.boxW;
        const x = inBox ? this.dir(owner.team) * (PITCH.L - 11) : b.x, y = inBox ? 0 : b.y;
        this.setRestart('free', owner.team, x, y, inBox ? this.bestShooter(owner.team) : owner);
      } else {
        m.beaten = slide ? 1.4 : 0.7;
      }
      return;
    }
  }

  // ================================================================== kicks

  private kickBall(m: Man, vx: number, vy: number, vh: number, k: number): void {
    const b = this.ball;
    b.owner = null; b.last = m;
    b.vx = vx; b.vy = vy; b.vh = vh;
    b.h = Math.max(b.h, 0.11);
    b.shot = null; b.saveTried = false; b.target = null;
    m.noTouch = 0.35;
    m.face = Math.atan2(vy, vx);
    this.emit({ kind: 'kick', team: m.team, man: m, k });
  }

  /** Along the ground to a teammate (where they will be), weighted to arrive; worse passers miss. */
  private pass(m: Man, to: Man, lead: boolean): void {
    const tx = to.x + (lead ? to.vx * 0.9 : 0), ty = to.y + (lead ? to.vy * 0.9 : 0);
    const dx = tx - m.x, dy = ty - m.y, d = Math.hypot(dx, dy) || 1;
    const err = this.rng.gaussian(0, 0.03 + (1 - m.def.skills.passing) * 0.14);
    const a = Math.atan2(dy, dx) + err;
    // Speed so it is still rolling when it gets there (friction FRICTION m/s²).
    const v = clamp(Math.sqrt(2 * FRICTION * d) * 1.15 + 2, 7, 24) * (1 + this.rng.gaussian(0, (1 - m.def.skills.passing) * 0.12));
    m.act = { id: 'pass', t: 0, dur: 0.45, side: 1 };
    this.kickBall(m, Math.cos(a) * v, Math.sin(a) * v, 0, clamp(v / 26, 0.2, 0.8));
    this.ball.target = to;
  }

  /** Along the ground into space, to be there when the runner is. */
  private through(m: Man, tx: number, ty: number, to: Man): void {
    const dx = tx - m.x, dy = ty - m.y, d = Math.hypot(dx, dy) || 1;
    const a = Math.atan2(dy, dx) + this.rng.gaussian(0, 0.03 + (1 - m.def.skills.passing) * 0.1);
    const v = clamp(Math.sqrt(2 * FRICTION * d) * 0.95 + 1, 8, 22);
    m.act = { id: 'pass', t: 0, dur: 0.45, side: 1 };
    this.kickBall(m, Math.cos(a) * v, Math.sin(a) * v, d > 28 ? 3.5 : 0, clamp(v / 26, 0.2, 0.8));
    this.ball.target = to;
  }

  /** In the air to a point (long balls, clearances, goal kicks). */
  private longBall(m: Man, tx: number, ty: number): void {
    tx = clamp(tx, -PITCH.L + 2, PITCH.L - 2); ty = clamp(ty, -PITCH.W + 2, PITCH.W - 2);
    const err = (1 - m.def.skills.passing) * 7 + 1.5;
    tx += this.rng.gaussian(0, err); ty += this.rng.gaussian(0, err);
    const dx = tx - m.x, dy = ty - m.y, d = Math.hypot(dx, dy) || 1;
    // Flight time for the distance (a lob: up and down), rolling the last bit.
    const T = clamp(d / 22, 0.8, 2.6);
    const v = (d * 0.85) / T;
    m.act = { id: 'kick', t: 0, dur: 0.6, side: 1 };
    this.kickBall(m, (dx / d) * v, (dy / d) * v, (G * T) / 2, 1);
    this.ball.target = this.nearest(tx, ty, (o) => o.team === m.team && o !== m && o.on);
  }

  /** A cross into the box: lofted, dropping near a head. */
  private cross(m: Man, tx: number, ty: number): void {
    const err = (1 - m.def.skills.passing) * 4 + 1;
    tx += this.rng.gaussian(0, err); ty += this.rng.gaussian(0, err);
    const dx = tx - m.x, dy = ty - m.y, d = Math.hypot(dx, dy) || 1;
    const T = clamp(d / 20, 0.7, 1.8);
    m.act = { id: 'kick', t: 0, dur: 0.6, side: 1 };
    this.kickBall(m, dx / T, dy / T, (G * T) / 2 + 0.6, 0.9);
    this.ball.target = this.nearest(tx, ty, (o) => o.team === m.team && o !== m && o.on);
  }

  private throwTo(m: Man, to: Man): void {
    const dx = to.x - m.x, dy = to.y - m.y, d = Math.hypot(dx, dy) || 1;
    const T = clamp(d / 12, 0.5, 1.4);
    m.act = { id: 'throw', t: 0, dur: 0.7, side: 1 };
    this.ball.h = 2.1;
    this.kickBall(m, dx / T, dy / T, (G * T) / 2 - 2.1 / T, 0.15);
    this.ball.target = to;
    m.hold = 0;
  }

  private shoot(m: Man): void {
    const d = this.dir(m.team), gx = d * PITCH.L;
    // Aim at the side away from the keeper, a little inside the post.
    const gk = this.men.find((o) => o.team !== m.team && o.def.pos === 'GK');
    const side = gk ? (gk.y > 0 ? -1 : 1) : this.rng.sign();
    const dist = Math.hypot(gx - m.x, m.y);
    const err = 0.6 + (1 - m.def.skills.shooting) * 2.8 + dist * 0.05;
    const ty = side * (PITCH.goalW - 0.7) + this.rng.gaussian(0, err);
    const th = clamp(this.rng.range(0.2, 2.1) + this.rng.gaussian(0, err * 0.35), 0, 3.2);
    const v = 19 + m.def.skills.shooting * 9 + this.rng.range(-2, 2);
    const dx = gx - m.x, dy = ty - m.y, dl = Math.hypot(dx, dy) || 1;
    const T = dl / v;
    m.act = { id: 'shoot', t: 0, dur: 0.6, side: 1 };
    this.kickBall(m, (dx / dl) * v, (dy / dl) * v, th / T + (G * T) / 2, 1);
    this.ball.shot = m;
    this.emit({ kind: 'chance', team: m.team, man: m });
  }

  private bestShooter(team: 0 | 1): Man {
    return this.men.filter((m) => m.team === team && m.def.pos !== 'GK').sort((p, q) => q.def.skills.shooting - p.def.skills.shooting)[0];
  }

  // ================================================================== the ball

  private moveBall(dt: number): void {
    const b = this.ball;
    if (b.owner) {
      const m = b.owner;
      if (m.def.pos === 'GK' && m.hold >= 0 && b.h > 0.5) return;
      // At his feet, a touch ahead (it runs out and he catches up with it).
      const sp = Math.hypot(m.vx, m.vy);
      const touch = 0.45 + (sp > 1 ? 0.35 + 0.3 * Math.abs(Math.sin(this.clock * (4 + sp * 0.4) + m.i)) * (1.3 - m.def.skills.control) : 0);
      b.x = m.x + Math.cos(m.face) * touch; b.y = m.y + Math.sin(m.face) * touch; b.h = 0.11;
      b.vx = m.vx; b.vy = m.vy; b.vh = 0;
      return;
    }
    const prevX = b.x;
    b.x += b.vx * dt; b.y += b.vy * dt; b.h += b.vh * dt;
    if (b.h > 0.11 || b.vh !== 0) {
      b.vh -= G * dt;
      if (b.h <= 0.11) {
        b.h = 0.11;
        if (b.vh < -2.5) { b.vh = -b.vh * 0.5; b.vx *= 0.8; b.vy *= 0.8; } else b.vh = 0;
      }
      b.vx *= 1 - 0.05 * dt; b.vy *= 1 - 0.05 * dt;
    } else {
      const s = Math.hypot(b.vx, b.vy);
      if (s > 0) { const ns = Math.max(0, s - FRICTION * dt); b.vx *= ns / s; b.vy *= ns / s; }
    }
    if (this.phase !== 'play') return;
    // The keeper on a shot.
    this.saves();
    if (!b.owner) this.touches();
    if (b.owner) return;
    // Over a line.
    if (Math.abs(b.x) > PITCH.L + 0.11) {
      const end = Math.sign(b.x);
      const t = (end * (PITCH.L + 0.11) - prevX) / ((b.x - prevX) || 1e-6);
      const yAt = b.y - b.vy * dt * (1 - t);
      const scoring: 0 | 1 = this.dir(0) === end ? 0 : 1;
      if (Math.abs(yAt) < PITCH.goalW - 0.11 && b.h < PITCH.goalH) this.goal(scoring);
      else if (Math.abs(yAt) < PITCH.goalW + 0.12 && b.h < PITCH.goalH + 0.12) {
        // Off the post: back into play.
        b.vx = -b.vx * 0.5; b.x = end * (PITCH.L - 0.1); b.vy += this.rng.range(-3, 3);
        this.emit({ kind: 'post', team: scoring });
      } else {
        this.emit({ kind: b.shot ? 'miss' : 'out', team: scoring, man: b.shot ?? undefined });
        const lastDef = b.last && b.last.team !== scoring;
        if (lastDef) this.setRestart('corner', scoring, end * (PITCH.L - 0.4), Math.sign(yAt || 1) * (PITCH.W - 0.4), null);
        else this.setRestart('goalkick', (1 - scoring) as 0 | 1, end * (PITCH.L - PITCH.sixL), Math.sign(yAt || 1) * 5, null);
      }
      return;
    }
    if (Math.abs(b.y) > PITCH.W + 0.11) {
      const team: 0 | 1 = b.last ? ((1 - b.last.team) as 0 | 1) : 0;
      this.emit({ kind: 'out', team });
      this.setRestart('throw', team, clamp(b.x, -PITCH.L + 1, PITCH.L - 1), Math.sign(b.y) * PITCH.W, null);
    }
  }

  private setRestart(kind: RestartKind, team: 0 | 1, x: number, y: number, taker: Man | null): void {
    const b = this.ball;
    b.owner = null; b.shot = null; b.vx = b.vy = b.vh = 0;
    this.restart = { kind, team, x, y, taker };
    for (const m of this.men) m.hold = 0;
    this.setPhase('restart');
  }

  /** Someone near a loose ball takes it (or heads it, or it bounces off a heavy touch). */
  private touches(): void {
    const b = this.ball;
    const sp = Math.hypot(b.vx, b.vy);
    let best: Man | null = null, bd = Infinity;
    for (const m of this.men) {
      if (!m.on || m.noTouch > 0 || (m.act && (m.act.id === 'fall'))) continue;
      const d = Math.hypot(m.x - b.x, m.y - b.y);
      const reach = m.def.pos === 'GK' && this.inOwnBox(m) ? 1.3 : 0.95;
      if (d < reach && d < bd && b.h < (m.def.pos === 'GK' && this.inOwnBox(m) ? 2.6 : 2.3)) { bd = d; best = m; }
    }
    if (!best) return;
    const m = best;
    if (m.def.pos === 'GK' && this.inOwnBox(m)) {
      // Gathered: held, a moment, then thrown or kicked.
      b.owner = m; b.last = m; b.vx = b.vy = b.vh = 0; m.hold = 0;
      if (b.h > 0.8) m.act = { id: 'catch', t: 0, dur: 0.8, side: 1 };
      return;
    }
    if (b.h > 1.3) {
      // A header: at goal in the box, else away (a clearance), with the head's skill.
      const d = this.dir(m.team), gx = d * PITCH.L;
      m.act = { id: 'header', t: 0, dur: 0.6, side: 1 };
      const inBox = Math.abs(gx - m.x) < PITCH.boxL + 2 && Math.abs(m.y) < PITCH.boxW;
      const tx = inBox ? gx : m.x + d * 20, ty = inBox ? this.rng.gaussian(0, PITCH.goalW * (1.6 - m.def.skills.heading)) : m.y + this.rng.range(-12, 12);
      const dx = tx - m.x, dy = ty - m.y, dl = Math.hypot(dx, dy) || 1;
      const v = 9 + m.def.skills.heading * 8;
      this.kickBall(m, (dx / dl) * v, (dy / dl) * v, inBox ? -1 : 4, 0.4);
      if (inBox) { b.shot = m; this.emit({ kind: 'chance', team: m.team, man: m }); }
      return;
    }
    if (b.h > 0.6 && sp > 6 && !this.rng.chance(m.def.skills.control)) {
      // Off the chest / knee and away.
      b.vx *= -0.3; b.vy *= -0.3; b.vh = 2; b.last = m; m.noTouch = 0.4;
      return;
    }
    // Controlled, or a heavy touch it runs away from.
    const pControl = clamp(0.55 + m.def.skills.control * 0.45 - Math.max(0, sp - 10) * 0.035, 0.15, 0.98);
    if (this.rng.chance(pControl)) {
      b.owner = m; b.last = m; m.think = 0.15 + this.rng.float() * 0.2; b.shot = null; b.target = null;
      if (sp > 1) m.face = Math.atan2(-b.vy, -b.vx) + Math.PI;
    } else {
      const a = Math.atan2(b.vy, b.vx) + this.rng.range(-1, 1);
      b.vx = Math.cos(a) * sp * 0.35 + this.rng.range(-1, 1); b.vy = Math.sin(a) * sp * 0.35; b.last = m; m.noTouch = 0.5;
    }
  }

  /** A shot coming at goal: the keeper gets one go at it (catch, parry, or beaten). */
  private saves(): void {
    const b = this.ball;
    if (!b.shot || b.saveTried) return;
    const gk = this.men.find((m) => m.team !== b.shot!.team && m.def.pos === 'GK');
    if (!gk) return;
    // Ball near the keeper's line (within reach of a dive).
    const toward = b.vx * Math.sign(-gk.x) < 0;
    const dx = Math.abs(b.x - gk.x);
    if (!toward || dx > 1.2) return;
    b.saveTried = true;
    const lat = Math.abs(b.y - gk.y), hh = b.h;
    const sp = Math.hypot(b.vx, b.vy);
    const k = gk.def.skills.keeping;
    const reach = 1.0 + k * 2.2;
    if (lat > reach + 0.4 || hh > 2.6) return;
    const p = clamp(0.25 + k * 0.75 - (lat / reach) * 0.45 - Math.max(0, sp - 18) * 0.025, 0.05, 0.95);
    gk.act = lat > 1 ? { id: 'dive', t: 0, dur: 1.4, side: Math.sign(b.y - gk.y) || 1 } : { id: 'catch', t: 0, dur: 0.8, side: 1 };
    if (!this.rng.chance(p)) return;
    this.emit({ kind: 'save', team: gk.team, man: gk });
    if (sp < 21 && this.rng.chance(0.25 + k * 0.6) && lat < 1.4) {
      b.owner = gk; b.last = gk; b.shot = null; b.vx = b.vy = b.vh = 0; gk.hold = 0;
      this.emit({ kind: 'catch', team: gk.team, man: gk });
    } else {
      // Parried away: wide (a corner, maybe) or back into play.
      const dir = Math.sign(-gk.x);
      b.vx = dir * sp * this.rng.range(0.15, 0.4); b.vy = (Math.sign(b.y - gk.y) || 1) * sp * this.rng.range(0.2, 0.55); b.vh = this.rng.range(1, 5);
      b.last = gk; b.shot = null; gk.noTouch = 0.8;
    }
  }

  private goal(team: 0 | 1): void {
    const b = this.ball;
    const scorer = b.last && b.last.team === team ? b.last : null;
    this.score[team]++;
    const name = scorer ? scorer.def.name.split(' ').pop()! : 'own goal';
    this.goals.push({ min: this.minute(), team, name });
    this.emit({ kind: 'goal', team, man: scorer ?? undefined, text: name });
    this.emit({ kind: 'whistle', k: 1 });
    b.owner = null; b.shot = null;
    b.vx *= 0.15; b.vy *= 0.15; b.vh = 0;
    this.setPhase('goal');
    this.goalBy = scorer;
    this.goalTeam = team;
    if (scorer) scorer.act = { id: 'celebrate', t: 0, dur: 4.5, side: 1 };
    for (const m of this.men) if (m.team !== team) m.act = { id: 'dejected', t: 0, dur: 2.5, side: 1 };
  }
  private goalBy: Man | null = null;
  private goalTeam: 0 | 1 = 0;

  private stepGoal(): void {
    // The scorer runs to the corner, the others after him; the others walk back.
    const s = this.goalBy, team = this.goalTeam;
    const cx = this.dir(team) * PITCH.L * 0.85, cy = Math.sign(s?.y || 1) * PITCH.W * 0.85;
    for (const m of this.men) {
      if (m === s) { m.tx = cx; m.ty = cy; m.want = 6; }
      else if (m.team === team && m.def.pos !== 'GK') { m.tx = cx - this.dir(team) * (2 + (m.i % 4)); m.ty = cy - Math.sign(cy) * (1 + (m.i % 3) * 1.2); m.want = 4.5; }
      else { m.tx = m.x; m.ty = m.y; m.want = 0; }
    }
    if (this.phaseT > 4 && s && !s.act) s.act = { id: 'celebrate', t: 0, dur: 3, side: 1 };
    if (this.phaseT > 8.5) this.startKickoff((1 - team) as 0 | 1);
  }

  // ================================================================== moving

  private moveMen(dt: number): void {
    for (const m of this.men) {
      if (m.act) { m.act.t += dt; if (m.act.t > m.act.dur) m.act = null; }
      if (m.noTouch > 0) m.noTouch -= dt;
      if (m.beaten > 0) m.beaten -= dt;
      if (!m.on) { m.vx = m.vy = 0; continue; }
      let want = m.want;
      // Down, sliding, diving: no running (the slide carries on a little).
      if (m.act && (m.act.id === 'fall' || m.act.id === 'dive' || m.act.id === 'dejected' && this.phase === 'goal')) want = 0;
      if (m.beaten > 0) want *= 0.45;
      // In play nobody runs far off the pitch (a ball gone out is fetched by the one taking the throw).
      if (this.phase === 'play' || this.phase === 'restart' || this.phase === 'kickoff') {
        m.tx = clamp(m.tx, -PITCH.L - 2.5, PITCH.L + 2.5);
        m.ty = clamp(m.ty, -PITCH.W - 2.5, PITCH.W + 2.5);
      }
      const dx = m.tx - m.x, dy = m.ty - m.y, d = Math.hypot(dx, dy);
      if (d < 0.25) want = 0;
      else want = Math.min(want, d * 2.2);
      const wx = d > 1e-6 ? (dx / d) * want : 0, wy = d > 1e-6 ? (dy / d) * want : 0;
      // Accelerate (quicker for quick players), turn with the run.
      const acc = (5 + m.def.skills.pace * 4) * dt;
      const ex = wx - m.vx, ey = wy - m.vy, el = Math.hypot(ex, ey);
      if (el > acc) { m.vx += (ex / el) * acc; m.vy += (ey / el) * acc; } else { m.vx = wx; m.vy = wy; }
      // Keep a little apart (not through each other).
      for (const o of this.men) {
        if (o === m || !o.on) continue;
        const ox = m.x - o.x, oy = m.y - o.y, od = Math.hypot(ox, oy);
        if (od < 0.75 && od > 1e-4) { m.x += (ox / od) * (0.75 - od) * 0.5; m.y += (oy / od) * (0.75 - od) * 0.5; }
      }
      m.x += m.vx * dt; m.y += m.vy * dt;
      const sp = Math.hypot(m.vx, m.vy);
      if (sp > 0.3) m.face = turn(m.face, Math.atan2(m.vy, m.vx), dt * 9);
      else if (this.phase === 'play' || this.phase === 'restart' || this.phase === 'kickoff') m.face = turn(m.face, Math.atan2(this.ball.y - m.y, this.ball.x - m.x), dt * 4);
      // Tired legs (the less stamina, the sooner), rested at the breaks.
      if (sp > 5) m.fatigue = Math.min(1, m.fatigue + dt * (1.2 - m.def.skills.stamina) * 0.006);
      if (this.phase === 'half') m.fatigue = Math.max(0, m.fatigue - dt * 0.01);
    }
  }

  /** Top speed now (m/s): pace, fatigue. */
  top(m: Man): number {
    return (6.2 + m.def.skills.pace * 2.6) * (1 - m.fatigue * 0.22);
  }

  /** Seconds for m to reach the loose ball (roughly: where it will be). */
  private reach(m: Man): number {
    const [ix, iy] = this.intercept(m);
    return Math.hypot(ix - m.x, iy - m.y) / this.top(m) + (m.noTouch > 0 ? 1 : 0);
  }

  /** Where m can meet the ball (its path sampled ahead, stopping where it stops). */
  private intercept(m: Man): [number, number] {
    const b = this.ball;
    let x = b.x, y = b.y, vx = b.vx, vy = b.vy;
    const top = this.top(m);
    for (let t = 0; t < 4; t += 0.2) {
      if (Math.hypot(x - m.x, y - m.y) <= top * t + 0.6) return [x, y];
      const s = Math.hypot(vx, vy);
      if (s < 0.05) return [x, y];
      const ns = Math.max(0, s - FRICTION * 0.2);
      x += vx * 0.2; y += vy * 0.2; vx *= ns / s; vy *= ns / s;
    }
    return [clamp(x, -PITCH.L, PITCH.L), clamp(y, -PITCH.W, PITCH.W)];
  }

  private nearest(x: number, y: number, ok: (m: Man) => boolean): Man | null {
    let best: Man | null = null, bd = Infinity;
    for (const m of this.men) { if (!ok(m)) continue; const d = Math.hypot(m.x - x, m.y - y); if (d < bd) { bd = d; best = m; } }
    return best;
  }

  /** Distance to the nearest opponent. */
  private pressure(m: Man): number {
    const o = this.nearest(m.x, m.y, (q) => q.team !== m.team && q.on);
    return o ? Math.hypot(o.x - m.x, o.y - m.y) : 99;
  }

  /** Room ahead of m towards their goal: the nearest opponent in front (within ±50°). */
  private room(m: Man): number {
    const d = this.dir(m.team);
    let r = 30;
    for (const o of this.men) {
      if (o.team === m.team || !o.on) continue;
      const ox = (o.x - m.x) * d, oy = o.y - m.y;
      if (ox <= 0 || Math.abs(oy) > ox * 1.2) continue;
      r = Math.min(r, Math.hypot(ox, oy));
    }
    return r;
  }

  /** How open a player is (nearest opponent). */
  private open(m: Man): number { return this.pressure(m); }

  /** Clearance of the lane from m to a point: the nearest opponent to the segment. */
  private laneOpen(m: Man, x: number, y: number): number {
    const dx = x - m.x, dy = y - m.y, L2 = dx * dx + dy * dy || 1;
    let c = 99;
    for (const o of this.men) {
      if (o.team === m.team || !o.on) continue;
      const t = clamp(((o.x - m.x) * dx + (o.y - m.y) * dy) / L2, 0, 1);
      // (One right at the passer's feet is played round: the first 2 m don't count.)
      if (t * Math.sqrt(L2) < 2) continue;
      c = Math.min(c, Math.hypot(m.x + dx * t - o.x, m.y + dy * t - o.y));
    }
    return c;
  }

  private inOwnBox(m: Man): boolean {
    const gx = -this.dir(m.team) * PITCH.L;
    return Math.abs(m.x - gx) < PITCH.boxL && Math.abs(m.y) < PITCH.boxW;
  }

  /** Stop and resume (something on the pitch). */
  hold(on: boolean): void { this.held = on; }
}

/** Rolling friction (m/s²) and gravity. */
const FRICTION = 2.6, G = 9.81;

function turn(a: number, b: number, k: number): number {
  let d = b - a;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return a + d * Math.min(1, k);
}
