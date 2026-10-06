/**
 * The city's response to a threat (THREATS_PLAN §2), levels 0–2 of the ladder, per incident:
 *
 *   0 Patrol      the nearest patrol cars come with sirens (Police, IncidentJob), a police drone
 *                 circles; officers get out, hold a line facing the trouble and wave people back.
 *   1 Perimeter   police cars park across the streets on the cordon as roadblocks (traffic stops
 *     & evacuation  at them: Traffic.blocks), a civil-defence siren wails over the district (a
 *                 `siren` stimulus with `evac`: people walk briskly to the nearest metro entrance
 *                 and go down — PedAgent.evac; cars inside the cordon turn round or are left
 *                 standing), the screens round about switch to a red alert pictogram.
 *   2 SWAT        an armoured van brings a tactical team, more patrol cars come, and the officers
 *                 go in on foot: they move to where they have a clear shot and wear the rogue
 *                 machines down with pistols and rifles (drones too), strike the ones that come
 *                 close (batons and stun batons), credited to the police.
 *
 * Officers carry guns (crime/Firearms) from level 0: whatever of the threat comes within range and
 * in sight of their post they shoot at — never through people (they hold fire), weaker than the
 * player's powers by design. A target they cannot get a shot at or cannot reach (a drone over the
 * roofs, the way blocked) they give up on for a while (`pursue` / `stuckT`, Actor) instead of
 * running in place under it.
 *
 * Escalation by elapsed time and how the level before fares (the share of the threat still in
 * action, people hurt); de-escalation once the incident is over: the siren stops, the roadblocks
 * open, the units pack up and drive off.
 *
 * A major threat (the Strider: `ThreatEvent.tier === 'major'`) escalates faster, with a wider
 * cordon, siren and alert area, and units keep their distance (scene points out beyond its
 * radius); officers never go in to strike something that big (`engageOnFoot === false`). From
 * level 2 (GIANT) patrol officers and SWAT on foot fire at it from a distance during its advance
 * and rampage: they close to about GIANT.standR m of its nearest part, kneel and shoot at the part
 * nearest them (its back over the roofs when that is hidden) with a clear line and nobody in it;
 * they run when it comes within GIANT.fleeR, or when it charges, breathes or sweeps its tail near
 * them. Damage is tiny against its 3000 hp — flavour and a distraction: it books to the aggro key
 * 'police', and enough of it makes the monster turn its breath on them (Strider.keyAt).
 *
 * Levels above 2 (National Guard, army and air, the last resort — THREATS_PLAN §2) plug in
 * through `registerLevel`.
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';
import { VState, type Vehicle } from '../../sim/Traffic';
import { DKind } from '../../future/Drones';
import { ENTRANCE_L } from '../../plan/metroDims';
import { play, goTo, stand, lookAt, setState, pursue, endPursuit, hold } from '../../sim/actors/Actor';
import { GUNS, MUZZLE_Y, type GunSpec } from '../crime/Firearms';
import { POLICE, equipSwat, type IncidentJob, type Unit } from '../crime/Police';
import type { ThreatEvent, ThreatTarget, ThreatZone } from '../threats/ThreatEvent';
import type { Stimulus } from '../Stimuli';

export const RESPONSE = {
  /** Patrol cars sent at once, after the first calls come in (s), one every callGap s. */
  patrol: 3, report: 1.5, callGap: 2.5,
  /** 0 → 1: after this long with more than this share of the threat still in action (or this many hurt). */
  up1: { after: 30, strength: 0.45, hurt: 8, hurtAfter: 15 },
  /** 1 → 2: this long at level 1 with more than this share still in action. */
  up2: { after: 40, strength: 0.25 },
  /** Cordon (roadblocks), evacuation and alert radii (m). */
  cordonR: 115, sirenR: 210, alertR: 330, roadblocks: 4,
  /** Level 2: SWAT vans and extra patrol cars. */
  swat: 1, extraPatrol: 2, swatOfficers: 4,
  /** Strike reach (m) and impulses (N·s) of batons; machines closer than `meleeR` get the baton. */
  reach: 1.45, baton: 430, stunBaton: 720, meleeR: 3.2,
  /** Advancing officers look this much farther than their gun reaches for something to go after (m). */
  seekR: 30,
  /** A target given up on (no shot to be had, the way blocked) is left alone this long (s). */
  ignoreT: 8,
  /** Units from out of view start this far out (m). */
  spawnR: 180,
  /** After the incident: stand down in steps (s). */
  calm: [8, 16, 30],
  /** Evacuation routing per frame (ms) and the farthest metro entrance worth walking to (m). */
  evacMs: 0.45, evacMaxWalk: 650,
  /** A major threat: sooner up the ladder, wider areas (m). */
  major: { up1: 10, up2: 25, cordonR: 260, sirenR: 520, alertR: 800 },
};

/** Police and SWAT on foot against a giant (the Strider): levels, distances, (tiny) damage. */
export const GIANT = {
  /** Response levels at which officers fire at it (2 SWAT … 4 army & air; at 5 everyone pulls out). */
  from: 2, until: 4,
  /** They close to about this far from its nearest body part (m), fire out to their gun's range + `extra`. */
  standR: 48, extra: 30,
  /** Run when its nearest part is this close (m), or while it charges / breathes / sweeps within `dangerR`; for `fleeFor` s. */
  fleeR: 28, dangerR: 75, fleeFor: 6,
  /** Damage per round before armour (most of its hide stops 60–85 %; it has 3000 hp). */
  pistol: 0.5, rifle: 0.25,
  /** Cadence: the gun's gap × this. Aggro each round books besides its damage (a nuisance: enough of it, ~25, and it turns on them). */
  gapK: 1.5, aggro: 0.15,
  /** It knows where the police are (its breath can go for them) this long after their last shot (s). */
  spotT: 10,
};

/**
 * A response level above the built-in ones (3 National Guard, 4 army & air, 5 the last resort):
 * when to go up to it from the level below, what to send, what to do every frame, how to stand down.
 */
export interface LevelHandler {
  /** Ready to go up to this level now (from the one below)? */
  when(inc: Incident): boolean;
  up(inc: Incident): void;
  step?(inc: Incident, dt: number): void;
  down(inc: Incident): void;
}

type Role = 'patrol' | 'block' | 'swat';

/** An officer's mind at an incident: the target, the line to it, where to shoot from. */
interface Mind {
  tgt: ThreatTarget | null;
  /** Seconds to the next look round (target and line of sight). */
  pickT: number;
  /** A clear line to `tgt` from where they stand (as of the last look). */
  los: boolean;
  /** Where they are going to shoot `spotFor` from; tries at it. */
  spot: { x: number; z: number } | null;
  spotFor: ThreatTarget | null;
  tries: number;
  /** Given up on (each left alone for ignoreT s; the oldest dropped when full). */
  ignore: ThreatTarget[];
  ignoreT: number[];
  fireT: number;
  /** Seconds holding fire (people in the line). */
  heldT: number;
  /** Seconds with nothing to shoot (the weapon goes back). */
  idleT: number;
  /** Fires kneeling. */
  kneel: boolean;
  /** Holding where they stand (the way to their post blocked) for this long. */
  stayT: number;
  /** A giant: running from it this long; the body part they shoot at (null: no clear line). */
  fleeT: number;
  gz: ThreatZone | null;
}
interface RJob extends IncidentJob { role: Role; inc: Incident; slot: number; turn?: { x0: number; z0: number; y0: number; x1: number; z1: number; y1: number; t: number } }

export interface Incident {
  ev: ThreatEvent;
  level: number;
  maxLevel: number;
  t: number;
  levelT: number;
  jobs: RJob[];
  /** Patrol cars still to send (retried until one is found). */
  pending: Role[];
  callT: number;
  siren: ReturnType<Game['audio']['loop']>;
  sirenT: number;
  sirenGain: number;
  alert: number;
  calmT: number;
  droneT: number;
  waveT: number;
  closed: boolean;
  stats: { tasked: number; taskedAt: number[]; levelAt: number[]; evacuated: number; fled: number; sirens: number; strikes: number; roadblocks: number };
  /** Level 5 (the last resort): another siren has taken over (the district's evacuation siren falls silent). */
  tone?: string;
  /** Level 5: the evacuation reaches this far (m) round the incident (the strike zone and beyond). */
  evacR?: number;
}

let INC = 1;

export class ResponseDirector {
  readonly incidents: Incident[] = [];
  private evacQ: PedAgent[] = [];
  private queued = new WeakSet<PedAgent>();
  private carT = 0;
  private devDone = false;
  /** Levels 3+ (stage 2: National Guard, army and air; the last resort). */
  private levels = new Map<number, LevelHandler>();
  private minds = new WeakMap<PedAgent, Mind>();
  stats = { incidents: 0, evacuated: 0, routed: 0, msAvg: 0, shots: 0, hits: 0, downed: 0, gaveUp: 0, spots: 0, heldFire: 0, giantShots: 0, giantDealt: 0, giantFled: 0 };
  /** Where the police last fired at a giant from (its breath may go for them: Strider.keyAt). */
  private giantSpot = { x: 0, y: 0, z: 0, t: -1e9 };
  private giantAggro = 0;
  private hookedGiants = new WeakSet<object>();

  constructor(private g: Game) {
    g.reactions.onEvacuate = (a, s) => this.evacuate(a, s);
    g.peds.shelter = (ax, az, bx, bz) => this.sheltered(ax, az, bx, bz);
  }

  /** Under an alert (level ≥ 1) people stay indoors: no trip starts or ends within the siren's reach. */
  private sheltered(ax: number, az: number, bx: number, bz: number): boolean {
    for (const inc of this.incidents) {
      if (inc.closed || inc.level < 1) continue;
      const ev = inc.ev, R = Math.max(this.radii(inc).sirenR, inc.evacR ?? 0);
      if (Math.hypot(ax - ev.x, az - ev.z) < R || Math.hypot(bx - ev.x, bz - ev.z) < R) return true;
    }
    return false;
  }

  /** A threat event began: the first calls come in. */
  open(ev: ThreatEvent): void {
    const inc: Incident = {
      ev, level: 0, maxLevel: 0, t: 0, levelT: 0, jobs: [], pending: [], callT: RESPONSE.report, siren: null, sirenT: 0, sirenGain: 0, alert: 0,
      calmT: 0, droneT: 0, waveT: 0, closed: false,
      stats: { tasked: 0, taskedAt: [], levelAt: [0], evacuated: 0, fled: 0, sirens: 0, strikes: 0, roadblocks: 0 },
    };
    for (let k = 0; k < RESPONSE.patrol; k++) inc.pending.push('patrol');
    this.incidents.push(inc);
    this.stats.incidents++;
    // Sounds load on first use.
    this.g.audio.loop('civil_siren')?.stop();
  }

  /** Plug in a level above 2 (THREATS_PLAN §2: 3 National Guard, 4 army & air, 5 the last resort: src/game/aftermath). */
  registerLevel(level: number, h: LevelHandler): void { this.levels.set(level, h); }

  /** The highest level there is (2 built in, more when registered in a row). */
  get top(): number { let n = 2; while (this.levels.has(n + 1)) n++; return n; }

  /** Radii for an incident (a major threat's are wider). */
  private radii(inc: Incident): { cordonR: number; sirenR: number; alertR: number } {
    return inc.ev.tier === 'major' ? RESPONSE.major : RESPONSE;
  }

  /** The highest level of any open incident (HUD, tests). */
  get level(): number { return this.incidents.reduce((m, i) => Math.max(m, i.closed ? 0 : i.level), 0); }

  /** Dev and saves: force the latest incident to a level (0 … top), going up one level at a time. */
  setLevel(n: number): number {
    const inc = this.incidents[this.incidents.length - 1];
    if (!inc) return -1;
    const to = Math.max(0, Math.min(this.top, n));
    if (to > inc.level) for (let l = inc.level + 1; l <= to; l++) this.goTo(inc, l);
    else this.goTo(inc, to);
    return inc.level;
  }

  update(dt: number): void {
    const t0 = performance.now();
    for (let i = this.incidents.length - 1; i >= 0; i--) {
      const inc = this.incidents[i];
      this.step(inc, dt);
      if (inc.closed && inc.calmT > RESPONSE.calm[2] + 5) { inc.siren?.stop(); this.incidents.splice(i, 1); }
    }
    this.roadblocks(dt);
    this.routeEvacuees();
    if (!this.devDone) this.installDev();
    this.stats.msAvg = this.stats.msAvg * 0.95 + (performance.now() - t0) * 0.05;
  }

  // ================================================================== one incident

  private step(inc: Incident, dt: number): void {
    const g = this.g, ev = inc.ev;
    inc.t += dt; inc.levelT += dt;
    // Calls: patrol cars (retried while none can be had).
    inc.callT -= dt;
    if (inc.pending.length && inc.callT <= 0 && ev.active) {
      inc.callT = RESPONSE.callGap;
      const role = inc.pending[0];
      if (this.send(inc, role)) inc.pending.shift(); else inc.callT = 1;
    }
    // A police drone circles over it.
    inc.droneT -= dt;
    if (inc.droneT <= 0 && ev.active) { inc.droneT = 45; g.future.drones.incident(DKind.Police, ev.x, ev.z, g.player.pos.x, g.player.pos.z); }
    // Patrol cars at the scene follow it as it moves.
    for (const j of inc.jobs) if (j.role !== 'block' && j.unit?.state === 'driving') { const p = this.scenePoint(inc, j.slot); j.x = p.x; j.z = p.z; }
    if (ev.active) {
      const s = ev.strength(), U = RESPONSE, major = ev.tier === 'major';
      if (inc.level === 0 && ((inc.t >= (major ? U.major.up1 : U.up1.after) && s > U.up1.strength) || (inc.t >= U.up1.hurtAfter && ev.hurt >= U.up1.hurt))) this.goTo(inc, 1);
      else if (inc.level === 1 && inc.levelT >= (major ? U.major.up2 : U.up2.after) && s > U.up2.strength) this.goTo(inc, 2);
      else if (inc.level >= 2 && inc.level < (ev.ceiling ?? Infinity) && this.levels.get(inc.level + 1)?.when(inc)) this.goTo(inc, inc.level + 1);
      // (Over its ceiling — a rampaging giant shrank back to human size: the heavy levels pull back.)
      else if (inc.level > 2 && inc.level > (ev.ceiling ?? Infinity)) this.goTo(inc, inc.level - 1);
    } else {
      // Over: stand down in steps.
      inc.calmT += dt;
      if (inc.level > 2 && inc.calmT > RESPONSE.calm[0] * 0.5) this.goTo(inc, inc.level - 1);
      if (inc.level === 2 && inc.calmT > RESPONSE.calm[0]) this.goTo(inc, 1);
      if (inc.level === 1 && inc.calmT > RESPONSE.calm[1]) this.goTo(inc, 0);
      if (!inc.closed && inc.calmT > RESPONSE.calm[2]) {
        inc.closed = true;
        for (const j of inc.jobs) j.done = true;
        inc.pending.length = 0;
      }
    }
    for (const [n, h] of this.levels) if (inc.level >= n) h.step?.(inc, dt);
    this.perimeter(inc, dt);
  }

  /** Move an incident to a level (up: send what it needs; down: release it). */
  private goTo(inc: Incident, level: number): void {
    if (level === inc.level) return;
    const up = level > inc.level;
    // Levels above 2 are the registered handlers' (up: the new one; down: every one left).
    if (up && level > 2) this.levels.get(level)?.up(inc);
    if (!up) for (let n = inc.level; n > level; n--) if (n > 2) this.levels.get(n)?.down(inc);
    inc.level = level;
    inc.levelT = 0;
    inc.maxLevel = Math.max(inc.maxLevel, level);
    inc.stats.levelAt[level] = inc.t;
    if (up) {
      if (level >= 1 && !inc.jobs.some((j) => j.role === 'block')) for (const p of this.cordon(inc)) this.send(inc, 'block', p);
      if (level >= 2) {
        for (let k = 0; k < RESPONSE.swat; k++) inc.pending.unshift('swat');
        for (let k = 0; k < RESPONSE.extraPatrol; k++) inc.pending.push('patrol');
        inc.callT = Math.min(inc.callT, 0.5);
      }
    } else {
      // Down: the cordon and the extra units go first.
      if (level < 2) for (const j of inc.jobs) if (j.role === 'swat' || (j.role === 'patrol' && j.slot >= RESPONSE.patrol)) j.done = true;
      if (level < 1) for (const j of inc.jobs) if (j.role === 'block') j.done = true;
      inc.pending = inc.pending.filter((r) => r === 'patrol' && level >= 0 && inc.ev.active);
    }
  }

  /** Send one unit (false: none to be had). */
  private send(inc: Incident, role: Role, at?: { x: number; z: number }): boolean {
    const slot = inc.jobs.filter((j) => j.role === role).length;
    const p = at ?? this.scenePoint(inc, slot);
    const self = this;
    const job: RJob = {
      role, inc, slot, x: p.x, z: p.z, done: false,
      vehicle: role === 'swat' ? 'swat' : 'police',
      officers: role === 'swat' ? RESPONSE.swatOfficers : role === 'block' ? 1 : 2,
      arrived(u) { self.arrived(this, u); },
      work(u, dt) { self.work(this, u, dt); },
      equip: role === 'swat' ? (o) => equipSwat(o) : undefined,
      spawnR: RESPONSE.spawnR,
    };
    if (!this.g.crime.police.respond(job)) return false;
    inc.jobs.push(job);
    inc.stats.tasked++;
    inc.stats.taskedAt.push(+inc.t.toFixed(1));
    if (role === 'block') inc.stats.roadblocks++;
    return true;
  }

  /** Where patrol car `slot` stops: round the incident, ~30 m out (a major threat: well beyond its reach). */
  scenePoint(inc: Incident, slot: number): { x: number; z: number } {
    const a = slot * 2.1 + inc.ev.id, r = inc.ev.tier === 'major' ? inc.ev.radius * 1.6 : 30;
    return { x: inc.ev.x + Math.cos(a) * r, z: inc.ev.z + Math.sin(a) * r };
  }

  // ================================================================== units on the scene

  private arrived(j: RJob, u: Unit): void {
    if (j.role !== 'block') return;
    // Roadblock: swing the car across the street on the spot (it stays where it stopped, turned
    // most of the way across, moved to the middle of the carriageway).
    const net = this.g.net, car = u.car;
    const ne = net.nearestEdge(car.x, car.z, 40);
    if (!ne) return;
    const e = net.edges[ne.e], o = { x: 0, z: 0, dx: 0, dz: 0 };
    net.pointAt(e, ne.s, 0, o);
    const across = Math.atan2(-o.dx, -o.dz) + Math.PI / 2 * (ne.side >= 0 ? 1 : -1) * 0.85;
    j.turn = { x0: car.x, z0: car.z, y0: car.yaw, x1: o.x, z1: o.z, y1: car.yaw + angle(across - car.yaw), t: 0 };
  }

  private work(j: RJob, u: Unit, dt: number): void {
    const g = this.g, inc = j.inc, ev = inc.ev, car = u.car;
    if (j.turn && j.turn.t < 1) {
      const T = j.turn;
      T.t = Math.min(1, T.t + dt / 1.6);
      const k = T.t * T.t * (3 - 2 * T.t);
      car.x = T.x0 + (T.x1 - T.x0) * k; car.z = T.z0 + (T.z1 - T.z0) * k; car.yaw = T.y0 + (T.y1 - T.y0) * k;
    }
    const fx = ev.x - car.x, fz = ev.z - car.z, fl = Math.hypot(fx, fz) || 1;
    // Every officer shoots at what comes within range and in sight; at level 2 (SWAT: always) they go after it.
    const armed = ev.active && ev.engageOnFoot !== false && !!ev.shoot;
    const advance = armed && (j.role === 'swat' || (j.role === 'patrol' && inc.level >= 2));
    // A giant: from level GIANT.from the officers on foot (not the roadblocks) fire at it from a distance.
    const mode = (ev as { mode?: string }).mode;
    const giant = ev.active && ev.engageOnFoot === false && !!ev.actors?.length && j.role !== 'block' && inc.level >= GIANT.from && inc.level <= GIANT.until && !inc.tone && (mode === 'advance' || mode === 'rampage');
    if (giant) this.hookGiant(ev);
    let i = 0;
    for (const o of u.officers) {
      const act = o.actor;
      if (!o.alive || !act || o.state === PState.Down) { i++; continue; }
      act.hostile = false;
      act.mood = 'focused';
      const M = this.mind(o, i);
      if (armed && this.engage(j, o, M, dt, advance)) { i++; continue; }
      if (giant && this.giant(j, o, M, dt)) { i++; continue; }
      if (M.fleeT > 0) M.fleeT = 0;
      this.lower(o, M, dt);
      // Hold: beside the car, facing the trouble (a roadblock faces out, towards the traffic).
      const side = i & 1 ? 1 : -1, row = i >> 1;
      const out = j.role === 'block' ? -1 : 1;
      const hx = car.x + (fx / fl) * (2.6 * out) + (-fz / fl) * side * (1.4 + row * 1.6);
      const hz = car.z + (fz / fl) * (2.6 * out) + (fx / fl) * side * (1.4 + row * 1.6);
      // (The way there blocked — the player, a crowd: hold where they are for a while.)
      if (act.stuckT > 0) M.stayT = 6;
      if (M.stayT > 0) M.stayT -= dt;
      if (Math.hypot(hx - o.x, hz - o.z) > 0.6 && M.stayT <= 0) { goTo(act, hx, hz, 2.2); setState(act, 'walk'); }
      else { stand(act); setState(act, 'idle'); }
      lookAt(act, car.x + (fx / fl) * 30 * out, o.y + 1.5, car.z + (fz / fl) * 30 * out);
      if (!act.action && Math.random() < dt * 0.25) play(act, 'gesture_wave', 1.6);
      i++;
    }
    // Officers wave people back: passers-by near them turn away from the trouble.
    inc.waveT -= dt;
    if (inc.waveT <= 0) {
      inc.waveT = 1;
      for (const jj of inc.jobs) {
        const uu = jj.unit;
        if (!uu || uu.state !== 'scene') continue;
        for (const a of g.peds.neighbours(uu.car.x, uu.car.z, 12, [])) {
          if (a.actor || a.evac || a.inside || a.state === PState.Down || a.state === PState.Flee) continue;
          a.fear = Math.max(a.fear, 0.7); a.fearX = ev.x; a.fearZ = ev.z; a.state = PState.Flee; a.stateT = 0;
          inc.stats.fled++;
        }
      }
    }
  }

  private mind(o: PedAgent, slot: number): Mind {
    let M = this.minds.get(o);
    if (!M) {
      M = { tgt: null, pickT: Math.random() * 0.3, los: false, spot: null, spotFor: null, tries: 0, ignore: [], ignoreT: [], fireT: 0.4 + Math.random() * 0.8, heldT: 0, idleT: 99, kneel: (slot & 1) === 1, stayT: 0, fleeT: 0, gz: null };
      this.minds.set(o, M);
    }
    return M;
  }

  /**
   * An officer and the threat: pick the nearest target in sight (the current one kept while it
   * is), strike it with the baton when it is right there, else shoot from where they stand; with no
   * shot to be had, move to a spot that gives one (advancing officers only) — or give up on it for
   * a while when there is none or the way there does not get them anywhere. True while engaged.
   */
  private engage(j: RJob, o: PedAgent, M: Mind, dt: number, advance: boolean): boolean {
    const ev = j.inc.ev, act = o.actor!, swat = j.role === 'swat';
    const spec = swat ? GUNS.rifle : GUNS.pistol;
    M.fireT -= dt;
    M.pickT -= dt;
    for (let k = M.ignoreT.length - 1; k >= 0; k--) if ((M.ignoreT[k] -= dt) <= 0) { M.ignore.splice(k, 1); M.ignoreT.splice(k, 1); }
    if (M.tgt && M.tgt.on === false) { M.tgt = null; M.spot = null; M.pickT = 0; }
    const eyeY = o.y + (M.kneel ? MUZZLE_Y.kneel : MUZZLE_Y.stand);
    if (M.pickT <= 0) { M.pickT = 0.45 + Math.random() * 0.2; this.pick(M, o, ev, spec, advance, eyeY); }
    const t = M.tgt;
    if (!t) return false;
    M.idleT = 0;
    const dh = Math.hypot(t.x - o.x, t.z - o.z);
    // Right here (a robot rolling up, a drone diving at head height): the baton.
    if ((t.grounded && dh < RESPONSE.meleeR && advance) || (!t.grounded && dh < RESPONSE.reach * 1.3 && t.y - o.y < 2.6)) return this.melee(j, o, M, t, dh, swat, dt);
    const ty = t.grounded ? t.y + 0.45 : t.y;
    const d3 = Math.hypot(dh, ty - eyeY);
    if (M.los && d3 <= spec.range) { M.spot = null; endPursuit(act); return this.shoot(j, o, M, t, spec, eyeY, ty, d3, advance); }
    if (!advance) return false;
    return this.reposition(o, M, t, spec, dt);
  }

  /** Look round: the current target while it stays in sight, else the nearest in range with a clear line (≤ 3 rays). */
  private pick(M: Mind, o: PedAgent, ev: ThreatEvent, spec: GunSpec, advance: boolean, eyeY: number): void {
    const guns = this.g.crime.guns;
    const list = ev.targetsNear(o.x, o.z, spec.range + (advance ? RESPONSE.seekR : 0));
    const dist = (t: ThreatTarget) => Math.hypot(t.x - o.x, (t.grounded ? t.y + 0.45 : t.y) - eyeY, t.z - o.z);
    const car = this.carOf(o);
    const sight = (t: ThreatTarget) => guns.los(o.x, eyeY, o.z, t.x, t.grounded ? t.y + 0.45 : t.y, t.z, 0.7, car);
    const cur = M.tgt;
    const ok = (t: ThreatTarget | null) => !!t && t.on !== false && !M.ignore.includes(t);
    if (ok(cur) && list.includes(cur!) && dist(cur!) <= spec.range && sight(cur!)) { M.los = true; return; }
    list.sort((a, b) => dist(a) - dist(b));
    let fallback: ThreatTarget | null = null, rays = 0;
    for (const t of list) {
      if (!ok(t)) continue;
      if (!fallback) fallback = t;
      if (dist(t) > spec.range || rays >= 3) continue;
      rays++;
      if (sight(t)) { this.setTarget(M, t, true); return; }
    }
    // Nothing in sight: the current one (still to get a shot at) or the nearest.
    this.setTarget(M, ok(cur) && list.includes(cur!) ? cur : fallback, false);
  }

  private setTarget(M: Mind, t: ThreatTarget | null, los: boolean): void {
    if (t !== M.tgt) { M.tries = 0; M.spot = null; M.spotFor = null; M.heldT = 0; }
    M.tgt = t;
    M.los = los;
  }

  /** The car an officer came in (their cover: it never blocks their own line). */
  private carOf(o: PedAgent): object | null {
    for (const inc of this.incidents) for (const j of inc.jobs) if (j.unit && j.unit.officers.includes(o)) return j.unit.car;
    return null;
  }

  /** Aim and fire (cadence, turned towards it, nobody in the line); every round fired hits (combat/shot.ts) and wears it down. */
  private shoot(j: RJob, o: PedAgent, M: Mind, t: ThreatTarget, spec: GunSpec, eyeY: number, ty: number, d3: number, advance: boolean): boolean {
    const g = this.g, act = o.actor!, ev = j.inc.ev;
    stand(act);
    setState(act, 'fight');
    lookAt(act, t.x, ty, t.z);
    act.held = spec.item;
    act.move = M.kneel ? 'crouch' : null;
    hold(act, spec.aim);
    // Turned towards it (standing actors turn to `face`)?
    let da = Math.atan2(-(t.x - o.x), -(t.z - o.z)) - o.heading;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    if (Math.abs(da) > 0.35 || M.fireT > 0) return true;
    M.fireT = spec.gap * (0.85 + Math.random() * 0.3);
    const fx = -Math.sin(o.heading), fz = -Math.cos(o.heading);
    const mx = o.x + fx * 0.55, mz = o.z + fz * 0.55;
    const guns = g.crime.guns;
    if (!guns.clear(o, mx, eyeY, mz, t.x, ty, t.z, null, t.grounded)) {
      // People in the line: hold fire; after a while look for another angle (advancing officers).
      M.heldT += M.fireT;
      this.stats.heldFire++;
      if (M.heldT > 3 && advance) { M.heldT = 0; M.los = false; M.tries++; }
      return true;
    }
    M.heldT = 0;
    void d3;
    const hits = spec.burst;
    guns.fire(o, spec, mx, eyeY, mz, t.x, ty, t.z, hits, true, t.grounded, 'police');
    this.stats.shots += spec.burst;
    this.stats.hits += hits;
    if (hits > 0 && ev.shoot) {
      j.inc.stats.strikes++;
      if (ev.shoot(t, hits * (t.grounded ? spec.machine : spec.drone), 'police', o.x, o.z)) { this.stats.downed++; M.tgt = null; M.pickT = 0.4; }
    }
    return true;
  }

  /** No shot from here: go to a spot that gives one (tried a few times, then given up on). */
  private reposition(o: PedAgent, M: Mind, t: ThreatTarget, spec: GunSpec, dt: number): boolean {
    const act = o.actor!;
    if (!M.spot || M.spotFor !== t) {
      M.spot = this.firingSpot(o, t, spec, M.tries);
      M.spotFor = t;
      endPursuit(act);
      if (!M.spot) return this.giveUp(M, t);
      this.stats.spots++;
    }
    const step = pursue(act, dt, 30);
    if (step === 'give_up') return this.giveUp(M, t);
    if (step === 'replan') { M.tries++; M.spot = this.firingSpot(o, t, spec, M.tries); if (!M.spot) return this.giveUp(M, t); this.stats.spots++; }
    const sd = Math.hypot(M.spot.x - o.x, M.spot.z - o.z);
    if (sd < 1) {
      // There: look again (a clear shot now, or another spot — twice — then leave it be).
      M.spot = null; M.spotFor = null; M.pickT = 0; M.tries++;
      endPursuit(act);
      if (M.tries > 2) return this.giveUp(M, t);
      stand(act);
      return true;
    }
    if (act.action?.id === 'aim_pistol' || act.action?.id === 'aim_rifle') act.action = null;
    act.move = null;
    this.g.crime.police.chase(o, M.spot, sd > 10 ? POLICE.run : 3.2);
    lookAt(act, t.x, t.y, t.z);
    return true;
  }

  private giveUp(M: Mind, t: ThreatTarget): false {
    if (M.ignore.length >= 6) { M.ignore.shift(); M.ignoreT.shift(); }
    M.ignore.push(t); M.ignoreT.push(RESPONSE.ignoreT);
    M.tgt = null; M.spot = null; M.spotFor = null; M.tries = 0; M.pickT = 0.2; M.los = false;
    this.stats.gaveUp++;
    return false;
  }

  /**
   * A spot about 9–16 m from the target (never right under a drone: a steep shot up is a poor
   * one), out of the buildings, with a clear line to it; tried round from the officer's side
   * (`tries` turns further).
   */
  private firingSpot(o: PedAgent, t: ThreatTarget, spec: GunSpec, tries: number): { x: number; z: number } | null {
    const g = this.g, guns = g.crime.guns;
    const bx = o.x - t.x, bz = o.z - t.z, bl = Math.hypot(bx, bz);
    const base = bl > 0.5 ? Math.atan2(bz, bx) : Math.random() * Math.PI * 2;
    const r = t.grounded ? Math.min(spec.range * 0.5, 12) : Math.max(9, Math.min(16, bl));
    const ty = t.grounded ? t.y + 0.45 : t.y;
    for (let k = 0; k < 4; k++) {
      const a = base + SPOT_TURN[(k + tries * 2) % SPOT_TURN.length];
      const x = t.x + Math.cos(a) * r, z = t.z + Math.sin(a) * r;
      if (g.world.buildingAt(x, z)) continue;
      if (!guns.los(x, g.terrain.height(x, z) + MUZZLE_Y.stand, z, t.x, ty, t.z)) continue;
      return { x, z };
    }
    return null;
  }

  /** A machine right there: close in and strike (batons; SWAT stun batons). */
  private melee(j: RJob, o: PedAgent, M: Mind, best: ThreatTarget, bd: number, swat: boolean, dt: number): boolean {
    const ev = j.inc.ev, act = o.actor!;
    lookAt(act, best.x, best.y + 0.4, best.z);
    act.move = null;
    if (act.action?.id === 'aim_pistol' || act.action?.id === 'aim_rifle') act.action = null;
    if (bd > RESPONSE.reach * 0.8) {
      this.g.crime.police.chase(o, best, POLICE.run);
      if (pursue(act, dt, 20) === 'give_up') return this.giveUp(M, best);
    } else { stand(act); setState(act, 'fight'); endPursuit(act); }
    if (bd < RESPONSE.reach && act.attackT <= 0) {
      act.attackT = swat ? 0.9 : 1.3;
      play(act, swat || Math.random() < 0.5 ? 'punch' : 'kick', 0.6);
      const dx = best.x - o.x, dz = best.z - o.z, l = Math.hypot(dx, dz) || 1, J = swat ? RESPONSE.stunBaton : RESPONSE.baton;
      ev.strike(best, (dx / l) * J, J * 0.25, (dz / l) * J, 'police');
      const g = this.g, cam = g.renderer.camera.position;
      g.audio.play('punch_impact', best.x, best.y + 0.5, best.z, 0.7, 0.75, 5, cam);
      if (swat) {
        // Stun baton: a crackle of blue sparks.
        g.debris.chipBurst(best.x, best.y + 0.5, best.z, 10, 3.5, 0, 0.8, 0, BLUE, 0.02, 0.5);
        g.synth.play('zap', best.x, best.y + 0.5, best.z, 0.5, 5);
      }
      j.inc.stats.strikes++;
    }
    return true;
  }

  // ================================================================== officers against a giant

  /** Tell the monster where the police are (its breath may go for whoever hurt it most: Strider.keyAt). */
  private hookGiant(ev: ThreatEvent): void {
    if (this.hookedGiants.has(ev)) return;
    this.hookedGiants.add(ev);
    const S = ev as { keyAt?: ((key: string) => { x: number; y: number; z: number } | null) | null };
    if (!('keyAt' in S)) return;
    const spot = this.giantSpot, out = { x: 0, y: 0, z: 0 };
    S.keyAt = (key) => {
      if (key !== 'police' || this.g.response !== this) return null;
      const t = this.incidents.reduce((m, i) => Math.max(m, i.t), 0);
      if (t - spot.t > GIANT.spotT) return null;
      out.x = spot.x; out.y = spot.y; out.z = spot.z;
      return out;
    };
  }

  /**
   * An officer and a giant (GIANT): run when it is close or lashing out near them; else close to
   * about GIANT.standR of its nearest part, kneel and fire at that part (its back when that is
   * hidden) — a clear line (the shared line of sight; their own car is cover) and nobody in it.
   * False: nothing to do about it from here (they hold their post as usual).
   */
  private giant(j: RJob, o: PedAgent, M: Mind, dt: number): boolean {
    const inc = j.inc, ev = inc.ev, A = ev.actors![0], act = o.actor!;
    if (!A.targetable) return false;
    const swat = j.role === 'swat';
    const spec = swat ? GUNS.rifle : GUNS.pistol;
    const eyeY = o.y + (M.kneel ? MUZZLE_Y.kneel : MUZZLE_Y.stand);
    // Its nearest body part.
    let nd = Infinity, nz: ThreatZone | null = null;
    for (const z of A.zones) {
      const d = Math.hypot(z.x - o.x, z.y - eyeY, z.z - o.z) - z.r;
      if (d < nd) { nd = d; nz = z; }
    }
    if (!nz) return false;
    // Run: it is right there, or it charges / breathes / sweeps its tail near them.
    const mon = ev as { act?: string | null; topAggro?: () => { key: string } | null };
    const lash = mon.act;
    const busy = lash === 'charge' || lash === 'breath' || lash === 'swipe';
    // (Its breath coming their way: the police are whom it is angriest with.)
    const atUs = (lash === 'charge' || lash === 'breath') && mon.topAggro?.()?.key === 'police';
    if (M.fleeT <= 0 && (nd < GIANT.fleeR || (busy && nd < GIANT.dangerR) || atUs)) { M.fleeT = GIANT.fleeFor; this.stats.giantFled++; }
    if (M.fleeT > 0) {
      M.fleeT -= dt;
      const dx = o.x - A.x, dz = o.z - A.z, l = Math.hypot(dx, dz) || 1;
      if (act.action?.id === 'aim_pistol' || act.action?.id === 'aim_rifle') act.action = null;
      act.move = null;
      act.mood = 'afraid';
      endPursuit(act);
      goTo(act, o.x + (dx / l) * 14, o.z + (dz / l) * 14, POLICE.run);
      setState(act, 'run');
      M.gz = null;
      return true;
    }
    act.mood = 'focused';
    const reach = spec.range + GIANT.extra;
    // Too far to matter: hold the post; within a run of it: close in (along the sidewalks, given up when stuck).
    if (nd > reach) {
      if (nd > reach + 70 || M.stayT > 0) { M.stayT = Math.max(0, M.stayT - dt); return false; }
      const dx = o.x - nz.x, dz = o.z - nz.z, l = Math.hypot(dx, dz) || 1;
      const sx = nz.x + (dx / l) * (GIANT.standR + nz.r), sz = nz.z + (dz / l) * (GIANT.standR + nz.r);
      if (act.action?.id === 'aim_pistol' || act.action?.id === 'aim_rifle') act.action = null;
      act.move = null;
      this.g.crime.police.chase(o, { x: sx, z: sz }, POLICE.run);
      if (pursue(act, dt, 30) === 'give_up') { endPursuit(act); M.stayT = 8; }
      lookAt(act, nz.x, nz.y, nz.z);
      return true;
    }
    endPursuit(act);
    // What to shoot at: the nearest part, else its back over the roofs (one or two rays, twice a second).
    M.pickT -= dt;
    if (M.pickT <= 0) {
      M.pickT = 0.5 + Math.random() * 0.25;
      const guns = this.g.crime.guns, car = this.carOf(o);
      M.gz = null;
      if (guns.los(o.x, eyeY, o.z, nz.x, nz.y, nz.z, nz.r * 0.8, car)) M.gz = nz;
      else {
        const back = A.zones.find((z) => z.id === 'back');
        if (back && back !== nz && guns.los(o.x, eyeY, o.z, back.x, back.y + back.r * 0.5, back.z, back.r * 0.8, car)) M.gz = back;
      }
    }
    const Z = M.gz;
    stand(act);
    lookAt(act, Z ? Z.x : nz.x, Z ? Z.y : nz.y, Z ? Z.z : nz.z);
    if (!Z) { this.lower(o, M, dt); return true; }
    M.idleT = 0;
    setState(act, 'fight');
    act.held = spec.item;
    act.move = M.kneel ? 'crouch' : null;
    hold(act, spec.aim);
    M.fireT -= dt;
    let da = Math.atan2(-(Z.x - o.x), -(Z.z - o.z)) - o.heading;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    if (Math.abs(da) > 0.35 || M.fireT > 0) return true;
    M.fireT = spec.gap * GIANT.gapK * (0.85 + Math.random() * 0.3);
    const fx = -Math.sin(o.heading), fz = -Math.cos(o.heading);
    const mx = o.x + fx * 0.55, mz = o.z + fz * 0.55;
    const guns = this.g.crime.guns;
    const ty = Z.id === 'back' ? Z.y + Z.r * 0.5 : Z.y;
    if (!guns.clear(o, mx, eyeY, mz, Z.x, ty, Z.z, null, false)) { this.stats.heldFire++; return true; }
    guns.fire(o, spec, mx, eyeY, mz, Z.x, ty, Z.z, spec.burst, true, false, 'police');
    guns.stats.atGiant += spec.burst;
    // (The nuisance is handed over in lumps: its aggro table forgets entries under 1.)
    this.giantAggro += GIANT.aggro * spec.burst;
    const lump = this.giantAggro >= 1.5 ? this.giantAggro : 0;
    if (lump) this.giantAggro = 0;
    const r = A.damage(Z, (swat ? GIANT.rifle : GIANT.pistol) * spec.burst, { cause: 'police', key: 'police', x: o.x, y: o.y + 1, z: o.z, aggro: lump });
    this.stats.giantShots += spec.burst;
    this.stats.giantDealt += r.dealt;
    const sp = this.giantSpot;
    sp.x = o.x; sp.y = o.y + 1; sp.z = o.z; sp.t = inc.t;
    return true;
  }

  /** Nothing to shoot: lower the weapon (holstered after a while). */
  private lower(o: PedAgent, M: Mind, dt: number): void {
    const act = o.actor!;
    M.idleT += dt;
    if (act.action?.id === 'aim_pistol' || act.action?.id === 'aim_rifle') act.action = null;
    if (act.move === 'crouch') act.move = null;
    if (M.idleT > 6 && (act.held === 'pistol' || act.held === 'rifle')) act.held = null;
  }

  // ================================================================== level 1: perimeter and evacuation

  private perimeter(inc: Incident, dt: number): void {
    const g = this.g, ev = inc.ev;
    const on = inc.level >= 1 && !inc.closed;
    // Civil-defence siren over the district (a slow rising and falling wail; silent while level 5's attack warning sounds).
    const voice = on && !inc.tone ? 1 : 0;
    inc.sirenGain += (voice - inc.sirenGain) * Math.min(1, dt * (voice ? 0.6 : 0.35));
    const R = this.radii(inc);
    if (on && !inc.siren) inc.siren = g.audio.loop('civil_siren', inc.ev.tier === 'major' ? 60 : 32);
    if (inc.siren) {
      inc.siren.set(ev.x, g.terrain.height(ev.x, ev.z) + 14, ev.z, inc.sirenGain);
      if (!on && inc.sirenGain < 0.01) { inc.siren.stop(); inc.siren = null; }
    }
    // Screens round about: the red alert.
    inc.alert += ((on ? 1 : 0) - inc.alert) * Math.min(1, dt * 1.5);
    if (inc === this.incidents[this.incidents.length - 1] || on) g.future.signs.alert(ev.x, ev.z, R.alertR, inc.alert > 0.02 ? inc.alert : 0);
    if (!on) return;
    inc.sirenT -= dt;
    if (inc.sirenT <= 0) {
      inc.sirenT = 2;
      g.stimuli.emit('siren', ev.x, g.terrain.height(ev.x, ev.z) + 10, ev.z, 4, Math.max(R.sirenR, inc.evacR ?? 0), { evac: true, cause: 'police' });
      inc.stats.sirens++;
    }
    // Traffic inside the cordon turns round or is left standing.
    this.carT -= dt;
    if (this.carT <= 0) {
      this.carT = 1;
      for (const v of g.traffic.vehicles) {
        if (v.state !== VState.Drive || v.task || v.siren || v.kind === 'police' || v.kind === 'swat' || v.kind === 'bus' || v.kind === 'ambulance' || v.kind === 'firetruck') continue;
        if (Math.hypot(v.x - ev.x, v.z - ev.z) < R.cordonR * 0.9) v.fear = Math.max(v.fear, 0.95);
      }
    }
  }

  /** Points where streets cross the cordon ring (arterials first), well spread round it. */
  private cordon(inc: Incident): { x: number; z: number }[] {
    const net = this.g.net, ev = inc.ev, R = this.radii(inc).cordonR;
    const cands: { x: number; z: number; a: number; cls: number }[] = [];
    for (const e of net.edges) {
      if (e.cls > 3) continue;
      const P = e.pts;
      for (let k = 0; k + 3 < P.length; k += 2) {
        const da = Math.hypot(P[k] - ev.x, P[k + 1] - ev.z), db = Math.hypot(P[k + 2] - ev.x, P[k + 3] - ev.z);
        if ((da < R) === (db < R)) continue;
        const t = (R - da) / (db - da || 1e-6);
        const x = P[k] + (P[k + 2] - P[k]) * t, z = P[k + 1] + (P[k + 3] - P[k + 1]) * t;
        cands.push({ x, z, a: Math.atan2(z - ev.z, x - ev.x), cls: e.cls });
      }
    }
    cands.sort((p, q) => p.cls - q.cls);
    const out: typeof cands = [];
    for (const c of cands) {
      if (out.length >= RESPONSE.roadblocks) break;
      if (out.some((o) => Math.abs(angle(o.a - c.a)) < 0.9)) continue;
      out.push(c);
    }
    return out;
  }

  /** Roadblock cars standing across their streets: obstacles for the traffic; lifted ones swing back into their lane. */
  private roadblocks(dt: number): void {
    const B = this.g.traffic.blocks;
    B.length = 0;
    for (const inc of this.incidents) for (const j of inc.jobs) {
      const u = j.unit;
      if (j.role !== 'block' || !u || !j.turn) continue;
      if (j.done) {
        // Back to where it stopped (the lane the traffic model has it on) before it drives off.
        const T = j.turn, car = u.car;
        if (T.t > 0 && car.task) {
          T.t = Math.max(0, T.t - dt / 1.6);
          const k = T.t * T.t * (3 - 2 * T.t);
          car.x = T.x0 + (T.x1 - T.x0) * k; car.z = T.z0 + (T.z1 - T.z0) * k; car.yaw = T.y0 + (T.y1 - T.y0) * k;
        }
        continue;
      }
      if (u.state !== 'scene') continue;
      const car: Vehicle = u.car, fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw);
      for (const s of [-0.28, 0.28]) B.push({ x: car.x + fx * car.length * s, z: car.z + fz * car.length * s, r: car.width * 0.75 });
    }
  }

  /** The siren reached someone: they will be routed to a metro entrance (budgeted per frame). */
  private evacuate(a: PedAgent, s: Stimulus): void {
    if (a.actor || a.inside || a.state === PState.Down || a.ragdoll || this.queued.has(a)) return;
    this.queued.add(a);
    this.evacQ.push(a);
    // Hurry off at once (away from the trouble) until the way to the metro is known.
    if (a.state !== PState.Flee) { a.state = PState.Flee; a.stateT = 0; a.fear = Math.max(a.fear, 1.1); a.fearX = s.x; a.fearZ = s.z; }
  }

  private routeEvacuees(): void {
    if (!this.evacQ.length) return;
    const g = this.g, t0 = performance.now();
    const inc = this.incidents.find((i) => !i.closed && i.level >= 1);
    const ents = this.entranceTops();
    while (this.evacQ.length && performance.now() - t0 < RESPONSE.evacMs) {
      const a = this.evacQ.shift()!;
      if (!a.alive || a.actor || a.inside || a.state === PState.Down || a.ragdoll || a.evac) continue;
      if (!inc) { continue; }
      const ev = inc.ev;
      // The nearest entrance that is not in the thick of it.
      let best: { x: number; z: number } | null = null, bs = RESPONSE.evacMaxWalk;
      for (const e of ents) {
        const d = Math.hypot(e.x - a.x, e.z - a.z);
        const s = d + (Math.hypot(e.x - ev.x, e.z - ev.z) < Math.max(45, ev.radius) ? 400 : 0);
        if (s < bs) { bs = s; best = e; }
      }
      const R = best ? g.peds.buildRoute(a.x, a.z, best.x, best.z) : null;
      this.stats.routed++;
      if (!R || !best) { a.state = PState.Flee; a.fear = Math.max(a.fear, 1.4); a.fearX = ev.x; a.fearZ = ev.z; continue; }
      a.route = R; a.wp = 1; a.dest = { x: best.x, z: best.z }; a.carDest = undefined;
      a.state = PState.Walk; a.stateT = 0; a.fear = 0.25; a.evac = 2.3; a.wpD = undefined; a.stall = 0; a.gawkT = 0; a.onRoad = false;
      inc.stats.evacuated++;
      this.stats.evacuated++;
    }
  }

  /** Street ends (tops of the stairs) of the loaded metro entrances. */
  private entranceTops(): { x: number; z: number }[] {
    const out: { x: number; z: number }[] = [];
    for (const e of this.g.underground.entrances.values()) out.push({ x: e.x - e.dx * (ENTRANCE_L / 2 + 0.8), z: e.z - e.dz * (ENTRANCE_L / 2 + 0.8) });
    return out;
  }

  // ================================================================== debug

  snapshot(): Record<string, unknown>[] {
    return this.incidents.map((i) => ({
      id: i.ev.id, level: i.level, maxLevel: i.maxLevel, t: +i.t.toFixed(1), closed: i.closed, calm: +i.calmT.toFixed(1),
      units: i.jobs.map((j) => `${j.role}${j.unit ? ':' + j.unit.state : ''}${j.done ? ' (done)' : ''}`).join(', '),
      pending: i.pending.join(','), ...i.stats, siren: +i.sirenGain.toFixed(2),
    }));
  }

  private installDev(): void {
    const dev = (window as unknown as { dev?: Record<string, unknown> }).dev;
    if (!dev) return;
    this.devDone = true;
    dev.response = {
      director: this,
      /** Force the latest incident to a response level (0 patrol, 1 perimeter & evacuation, 2 SWAT; 3+ when registered). */
      level: (n = 1) => this.setLevel(n),
      status: () => this.snapshot(),
    };
  }
}

const BLUE = new THREE.Color(0.6, 1.4, 4);
/** Angles (rad) round a target to try firing spots at, from the officer's side outwards. */
const SPOT_TURN = [0, 0.7, -0.7, 1.4, -1.4, 2.3, -2.3, Math.PI];

function angle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
