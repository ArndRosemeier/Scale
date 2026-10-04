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
 *                 go in on foot: they run the rogue machines down and strike them (batons and stun
 *                 batons, never guns at people), credited to the police.
 *
 * Escalation by elapsed time and how the level before fares (the share of the threat still in
 * action, people hurt); de-escalation once the incident is over: the siren stops, the roadblocks
 * open, the units pack up and drive off.
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';
import { VState, type Vehicle } from '../../sim/Traffic';
import { DKind } from '../../future/Drones';
import { ENTRANCE_L } from '../../plan/metroDims';
import { play, goTo, stand, lookAt, setState } from '../../sim/actors/Actor';
import { POLICE, policeOutfit, type IncidentJob, type Unit } from '../crime/Police';
import type { ThreatEvent, ThreatTarget } from '../threats/ThreatEvent';
import type { EquipmentVisuals } from '../../items/types';
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
  /** Officers engage within this range of themselves (m); strike reach and impulses (N·s). */
  engageR: 38, reach: 1.45, baton: 430, stunBaton: 720,
  /** SWAT anti-drone jammer: range (m), seconds between shots. */
  jamR: 32, jamGap: 2.4,
  /** Units from out of view start this far out (m). */
  spawnR: 180,
  /** After the incident: stand down in steps (s). */
  calm: [8, 16, 30],
  /** Evacuation routing per frame (ms) and the farthest metro entrance worth walking to (m). */
  evacMs: 0.45, evacMaxWalk: 650,
};

type Role = 'patrol' | 'block' | 'swat';
interface RJob extends IncidentJob { role: Role; inc: Incident; slot: number; turn?: { x0: number; z0: number; y0: number; x1: number; z1: number; y1: number; t: number } }

interface Incident {
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
}

let INC = 1;

export class ResponseDirector {
  readonly incidents: Incident[] = [];
  private evacQ: PedAgent[] = [];
  private queued = new WeakSet<PedAgent>();
  private carT = 0;
  private devDone = false;
  stats = { incidents: 0, evacuated: 0, routed: 0, msAvg: 0 };

  constructor(private g: Game) {
    g.reactions.onEvacuate = (a, s) => this.evacuate(a, s);
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

  /** The highest level of any open incident (HUD, tests). */
  get level(): number { return this.incidents.reduce((m, i) => Math.max(m, i.closed ? 0 : i.level), 0); }

  /** Dev: force the latest incident to a level (0–2). */
  setLevel(n: number): number {
    const inc = this.incidents[this.incidents.length - 1];
    if (!inc) return -1;
    this.goTo(inc, Math.max(0, Math.min(2, n)));
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
      const s = ev.strength(), U = RESPONSE;
      if (inc.level === 0 && ((inc.t >= U.up1.after && s > U.up1.strength) || (inc.t >= U.up1.hurtAfter && ev.hurt >= U.up1.hurt))) this.goTo(inc, 1);
      else if (inc.level === 1 && inc.levelT >= U.up2.after && s > U.up2.strength) this.goTo(inc, 2);
    } else {
      // Over: stand down in steps.
      inc.calmT += dt;
      if (inc.level === 2 && inc.calmT > RESPONSE.calm[0]) this.goTo(inc, 1);
      if (inc.level === 1 && inc.calmT > RESPONSE.calm[1]) this.goTo(inc, 0);
      if (!inc.closed && inc.calmT > RESPONSE.calm[2]) {
        inc.closed = true;
        for (const j of inc.jobs) j.done = true;
        inc.pending.length = 0;
      }
    }
    this.perimeter(inc, dt);
  }

  /** Move an incident to a level (up: send what it needs; down: release it). */
  private goTo(inc: Incident, level: number): void {
    if (level === inc.level) return;
    const up = level > inc.level;
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

  /** Where patrol car `slot` stops: round the incident, ~30 m out. */
  private scenePoint(inc: Incident, slot: number): { x: number; z: number } {
    const a = slot * 2.1 + inc.ev.id;
    return { x: inc.ev.x + Math.cos(a) * 30, z: inc.ev.z + Math.sin(a) * 30 };
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
    const engage = ev.active && (j.role === 'swat' || (j.role === 'patrol' && inc.level >= 2));
    let i = 0;
    for (const o of u.officers) {
      const act = o.actor;
      if (!o.alive || !act || o.state === PState.Down) { i++; continue; }
      act.hostile = false;
      act.mood = 'focused';
      if (engage && this.engage(j, o, dt)) { i++; continue; }
      if (engage) {
        // Nothing in reach: move in on the nearest of it (SWAT after drones too), else the centre.
        let to: { x: number; z: number } = ev, bd = Infinity;
        for (const t of ev.targetsNear(ev.x, ev.z, 140)) {
          if (!t.grounded && j.role !== 'swat') continue;
          const d = Math.hypot(t.x - o.x, t.z - o.z);
          if (d < bd) { bd = d; to = t; }
        }
        if (Math.hypot(to.x - o.x, to.z - o.z) > (to === ev ? 14 : RESPONSE.jamR * 0.6)) {
          this.g.crime.police.chase(o, to, 3.8);
          lookAt(act, to.x, o.y + 1.5, to.z);
          i++;
          continue;
        }
      }
      // Hold: beside the car, facing the trouble (a roadblock faces out, towards the traffic).
      const side = i & 1 ? 1 : -1, row = i >> 1;
      const out = j.role === 'block' ? -1 : 1;
      const hx = car.x + (fx / fl) * (2.6 * out) + (-fz / fl) * side * (1.4 + row * 1.6);
      const hz = car.z + (fz / fl) * (2.6 * out) + (fx / fl) * side * (1.4 + row * 1.6);
      if (Math.hypot(hx - o.x, hz - o.z) > 0.6) { goTo(act, hx, hz, 2.2); setState(act, 'walk'); }
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

  /**
   * An officer goes for the nearest rogue machine on the ground (a drone diving low within reach
   * gets the baton too); SWAT bring down drones with a hand-held jammer. True while engaged.
   */
  private engage(j: RJob, o: PedAgent, _dt: number): boolean {
    const ev = j.inc.ev, act = o.actor!, swat = j.role === 'swat';
    let best: ThreatTarget | null = null, bd = RESPONSE.engageR, air: ThreatTarget | null = null, ad = RESPONSE.jamR;
    for (const t of ev.targetsNear(o.x, o.z, Math.max(RESPONSE.engageR, RESPONSE.jamR))) {
      const d = Math.hypot(t.x - o.x, t.z - o.z);
      const low = !t.grounded && t.y - o.y < 2.6 && d < RESPONSE.reach;
      if ((t.grounded || low) && d < bd) { bd = d; best = t; }
      if (!t.grounded && d < ad) { ad = d; air = t; }
    }
    if (swat && air && act.attackT <= 0 && (!best || bd > 6)) {
      // Jammer: aim, a crackle, and the drone tumbles out of the sky.
      act.attackT = RESPONSE.jamGap;
      stand(act);
      lookAt(act, air.x, air.y, air.z);
      play(act, 'cast_forward', 0.8);
      ev.strike(air, 0, -60, 0, 'police');
      const g = this.g;
      g.debris.chipBurst(air.x, air.y, air.z, 8, 2.5, 0, 0.5, 0, BLUE, 0.02, 0.4);
      g.synth.play('zap', air.x, air.y, air.z, 0.45, 8);
      j.inc.stats.strikes++;
      return true;
    }
    if (!best) return false;
    lookAt(act, best.x, best.y + 0.4, best.z);
    if (bd > RESPONSE.reach * 0.8) this.g.crime.police.chase(o, best, POLICE.run);
    else { stand(act); setState(act, 'fight'); }
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

  // ================================================================== level 1: perimeter and evacuation

  private perimeter(inc: Incident, dt: number): void {
    const g = this.g, ev = inc.ev;
    const on = inc.level >= 1 && !inc.closed;
    // Civil-defence siren over the district (a slow rising and falling wail).
    inc.sirenGain += ((on ? 1 : 0) - inc.sirenGain) * Math.min(1, dt * (on ? 0.6 : 0.35));
    if (on && !inc.siren) inc.siren = g.audio.loop('civil_siren', 32);
    if (inc.siren) {
      inc.siren.set(ev.x, g.terrain.height(ev.x, ev.z) + 14, ev.z, inc.sirenGain);
      if (!on && inc.sirenGain < 0.01) { inc.siren.stop(); inc.siren = null; }
    }
    // Screens round about: the red alert.
    inc.alert += ((on ? 1 : 0) - inc.alert) * Math.min(1, dt * 1.5);
    if (inc === this.incidents[this.incidents.length - 1] || on) g.future.signs.alert(ev.x, ev.z, RESPONSE.alertR, inc.alert > 0.02 ? inc.alert : 0);
    if (!on) return;
    inc.sirenT -= dt;
    if (inc.sirenT <= 0) {
      inc.sirenT = 2;
      g.stimuli.emit('siren', ev.x, g.terrain.height(ev.x, ev.z) + 10, ev.z, 4, RESPONSE.sirenR, { evac: true, cause: 'police' });
      inc.stats.sirens++;
    }
    // Traffic inside the cordon turns round or is left standing.
    this.carT -= dt;
    if (this.carT <= 0) {
      this.carT = 1;
      for (const v of g.traffic.vehicles) {
        if (v.state !== VState.Drive || v.task || v.siren || v.kind === 'police' || v.kind === 'swat' || v.kind === 'bus') continue;
        if (Math.hypot(v.x - ev.x, v.z - ev.z) < RESPONSE.cordonR * 0.9) v.fear = Math.max(v.fear, 0.95);
      }
    }
  }

  /** Points where streets cross the cordon ring (arterials first), well spread round it. */
  private cordon(inc: Incident): { x: number; z: number }[] {
    const net = this.g.net, ev = inc.ev, R = RESPONSE.cordonR;
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
        const s = d + (Math.hypot(e.x - ev.x, e.z - ev.z) < 45 ? 400 : 0);
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
      /** Force the latest incident to a response level (0 patrol, 1 perimeter & evacuation, 2 SWAT). */
      level: (n = 1) => this.setLevel(n),
      status: () => this.snapshot(),
    };
  }
}

const BLUE = new THREE.Color(0.6, 1.4, 4);

/** The tactical team: dark overalls, helmet-like cap, tougher and stronger. */
function equipSwat(o: PedAgent): void {
  const act = o.actor;
  if (!act) return;
  const seed = o.cit.seed;
  const dark: [number, number, number] = [0.03, 0.035, 0.045], grey: [number, number, number] = [0.12, 0.13, 0.15];
  const v = (primary: [number, number, number], secondary: [number, number, number], k: number) => ({ shape: 'cloth', seed: seed + k, primary, secondary, accent: [0.2, 0.22, 0.25], material: 'plain', glow: 0 });
  act.outfit = {
    ...policeOutfit(seed),
    chest: { defId: 'shirt', visual: v(grey, dark, 1) },
    back: { defId: 'jacket', visual: v(dark, grey, 2) },
    legs: { defId: 'trousers', visual: v(dark, dark, 3) },
    head: { defId: 'cap', visual: v(dark, dark, 5) },
  } as unknown as EquipmentVisuals;
  act.hp = act.maxHp = 160;
  act.strength = 2.2;
}

function angle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
