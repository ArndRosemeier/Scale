/**
 * Being defeated (health at zero, not arrested): no more waking up where one fell.
 *
 *  - Reputation 0 or better: the city's hospital sends its rescue drones. The hero lies there
 *    (untouchable: the knockout holds), three white drones with red crosses come in from the
 *    hospital, lock tractor beams onto the body, lift it in a glowing stasis field and fly it over
 *    the city to the landing pad lit up on the hospital's roof. Fade to black.
 *  - The revival ward: deep under the hospital (HospitalWard), the hero lies in the revival machine
 *    under its glass canopy; rings sweep along the body, the vitals climb on the hologram, the heart
 *    starts, a surge and a white flash, the canopy opens and the hero stands up beside it. Full
 *    health. The way out is through the doors at the end of the ward, onto the street in front of
 *    the hospital.
 *  - Reputation below 0: nobody comes. Game over: load a save (the latest first) or a new game.
 *  - Arrested as a public menace (crime/Justice lockedAway): taken away for good, game over too.
 *
 * The hospital: one of the city's flat-roofed office or civic blocks, the nearest of those the
 * seed made hospitals (rules.pickHospital). Space skips ahead (the flight, the scan).
 * Dev: dev.defeat.down(), dev.defeat.status().
 */
import * as THREE from 'three';
import { lightPool } from '../../render/lightPool';
import type { Game } from '../Game';
import type { HurtKind } from '../PlayerHealth';
import type { BuildingRef } from '../../world/WorldIndex';
import { MedFleet } from './MedDrones';
import { HospitalWard } from './HospitalWard';
import { DefeatUi } from '../../ui/DefeatUi';
import { DEFEAT, WARD, flightAt, hospitalName, padSpot, pickHospital, planFlight, rescueAllowed, wardExit, type FlightPlan, type HospitalCandidate, type RoofBlock } from './rules';
import { buildingEntrance } from '../../build/buildingLayout';
import { polyArea } from '../../core/geom2';
import { clamp, lerp, smoothstep } from '../../core/math';
import { BASE_HEIGHT } from '../../player/Player';
import { cityName } from '../../plan/names';

export type DefeatPhase = 'idle' | 'down' | 'inbound' | 'lift' | 'flight' | 'arrive' | 'revive' | 'ward' | 'leaving' | 'over';

/** Drone slots round the body (x across, z along the heading, y over the body). */
const SLOTS: [number, number][] = [[0, -1.25], [-1.15, 0.85], [1.15, 0.85]];
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _b = new THREE.Vector3(), _q = new THREE.Quaternion();
const _f: [number, number, number] = [0, 0, 0];

interface Hospital {
  ref: BuildingRef | null;
  /** The landing pad (roof centre). */
  pad: THREE.Vector3;
  /** Where one comes out (street in front of the entrance) and the way one faces. */
  exit: { x: number; z: number; yaw: number };
}

export class Defeat {
  phase: DefeatPhase = 'idle';
  readonly fleet = new MedFleet(3);
  readonly ward: HospitalWard;
  readonly ui: DefeatUi;
  readonly name: string;
  private t = 0;
  private hosp: Hospital | null = null;
  private plan: FlightPlan | null = null;
  /** The body's spot (feet) while carried. */
  private body = new THREE.Vector3();
  private heading = 0;
  private from: THREE.Vector3[] = [];
  private skipping = 0;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private chase = new THREE.Vector3();
  private camInit = false;
  private handoff: { pos: THREE.Vector3; q: THREE.Quaternion } | null = null;
  private loop: ReturnType<Game['audio']['loop']> = null;
  private beat = 0;
  private fired = new Set<string>();
  private rep = 0;
  /** The game over is an arrest (the police took the hero down for good), not a defeat. */
  private cuffed = false;
  /** The roof pad's size (smaller on a cramped roof). */
  private padScale = 1;
  stats = { defeats: 0, rescues: 0, gameOvers: 0, arrests: 0, skips: 0, last: '' };

  constructor(private g: Game) {
    this.name = hospitalName(g.settings.seed);
    this.ward = new HospitalWard(this.name);
    this.ui = new DefeatUi(g);
    g.renderer.scene.add(this.fleet.group, this.ward.group);
    g.collision.room = this.ward.room;
    g.collision.obstacleProviders.push(this.ward.provider);
  }

  get active(): boolean { return this.phase !== 'idle'; }
  /** The scene drives the player and the camera itself (the game skips the controls and the rig). */
  get drives(): boolean { return this.phase === 'lift' || this.phase === 'flight' || this.phase === 'arrive' || this.phase === 'revive'; }
  /** The hero is in the ward (sealed room: no city sounds, no weather, its own camera space). */
  get inWard(): boolean { return this.ward.open && this.phase !== 'idle'; }
  /** No saving (game over: the older saves are what one goes back to). */
  get holdSaves(): boolean { return this.phase === 'over'; }

  /** Where a save made now puts the hero (on the way to or in the hospital: outside it, healed); null: as they are. */
  saveSpot(): { x: number; y: number; z: number } | null {
    if (this.phase === 'idle' || this.phase === 'over' || !this.hosp) return null;
    const e = this.hosp.exit;
    return { x: e.x, y: this.g.world.groundHeight(e.x, e.z), z: e.z };
  }

  /** Health reached zero (not an arrest). Returns true: the defeat takes it from here. */
  begin(kind: HurtKind): boolean {
    const g = this.g, P = g.player, H = g.crime.health;
    if (this.phase === 'ward' || this.phase === 'leaving') { this.again(kind); return true; }
    if (this.phase !== 'idle') { H.koT = 1e9; return true; }
    this.cuffed = false;
    H.koT = 1e9; // held down (untouchable) until the revival
    P.downT = Math.max(P.downT, 1e3);
    this.rep = g.crime.rep.value;
    this.stats.defeats++;
    this.stats.last = kind;
    this.fired.clear();
    this.skipping = 0;
    this.camInit = false;
    this.handoff = null;
    this.ui.hurt(true);
    g.audio.play2d('heart_pulse', 0.7, 0.75);
    if (!rescueAllowed(this.rep)) {
      this.set('over');
      this.stats.gameOvers++;
      return true;
    }
    this.stats.rescues++;
    this.hosp = this.findHospital(P.pos.x, P.pos.z);
    this.set('down');
    return true;
  }

  /**
   * Cuffed as a public menace (crime/Justice lockedAway): no fine, no night in a cell, no rescue —
   * the hero is held where they lie and it is game over. False: a defeat is already under way.
   */
  arrested(): boolean {
    const g = this.g, P = g.player, H = g.crime.health;
    if (this.phase !== 'idle') return false;
    H.koT = 1e9;
    P.downT = Math.max(P.downT, 1e3);
    this.rep = g.crime.rep.value;
    this.cuffed = true;
    this.fired.clear();
    this.skipping = 0;
    this.stats.defeats++;
    this.stats.arrests++;
    this.stats.gameOvers++;
    this.stats.last = 'arrest';
    this.ui.hurt(true);
    g.audio.play2d('heart_pulse', 0.7, 0.75);
    this.set('over');
    return true;
  }

  private set(p: DefeatPhase): void {
    this.phase = p;
    this.t = 0;
  }

  /** Defeated again before leaving the ward: straight back into the machine. */
  private again(kind: HurtKind): void {
    const g = this.g, P = g.player, H = g.crime.health;
    H.koT = 1e9;
    P.downT = Math.max(P.downT, 1e3);
    this.stats.defeats++;
    this.stats.last = kind;
    this.fired.clear();
    this.camInit = false;
    this.handoff = null;
    this.ui.hurt(true);
    g.audio.play2d('heart_pulse', 0.7, 0.75);
    this.body.copy(P.pos);
    this.takeBody();
    this.fleet.field.visible = false;
    this.set('down');
    this.skipping = 0;
    this.startSkip();
  }

  // ------------------------------------------------------------------ the hospital

  private findHospital(x: number, z: number): Hospital {
    const g = this.g, R = 900;
    const refs = g.world.buildingsIn(x - R, z - R, x + R, z + R);
    const seen = new Set<BuildingRef>();
    const list: BuildingRef[] = [], cand: HospitalCandidate[] = [];
    for (const b of refs) {
      if (seen.has(b)) continue;
      seen.add(b);
      const bb = b.bounds;
      list.push(b);
      cand.push({ id: b.cell.id * 4096 + b.index, x: (bb[0] + bb[2]) / 2, z: (bb[1] + bb[3]) / 2, base: b.base, top: b.top, area: Math.abs(polyArea(b.poly)), use: b.desc.use, roof: b.desc.roof, alive: b.alive });
    }
    const i = pickHospital(cand, x, z, g.settings.seed);
    if (i < 0) {
      // Nothing standing near (out in the country): the drones fly off over the horizon.
      const a = Math.random() * Math.PI * 2;
      const pad = new THREE.Vector3(x + Math.cos(a) * 320, g.terrain.height(x, z) + 90, z + Math.sin(a) * 320);
      return { ref: null, pad, exit: { x, z, yaw: g.player.yaw } };
    }
    const b = list[i], c = cand[i];
    // The pad: where the roof has the most room (clear of water tanks, HVAC units, the edges).
    const L = g.destruction.layoutOf(b);
    const top = L.tiers[L.tiers.length - 1].poly;
    const items: RoofBlock[] = [];
    g.collision.roofEquipmentIn(b.bounds[0], b.bounds[1], b.bounds[2], b.bounds[3], (o) => {
      if (o.y1 > b.top - 0.5) items.push({ x: o.x, z: o.z, r: o.cyl ? o.r + 0.4 : Math.hypot(o.hx, o.hz) + 0.3 });
    });
    const ps = padSpot(top, items, c.x, c.z);
    const pad = new THREE.Vector3(ps.x, b.top + 0.08, ps.z);
    this.padScale = clamp((ps.clear - 0.5) / 4.9, 0.5, 1);
    let ex = c.x, ez = c.z, yaw = 0;
    const st = buildingEntrance(b.desc, g.terrain);
    if (st && st.boxes.length >= 5) {
      const sx = st.boxes[0], sz = st.boxes[1];
      let ox = sx - c.x, oz = sz - c.z;
      const l = Math.hypot(ox, oz) || 1;
      ox /= l; oz /= l;
      // Out of the doors onto the pavement (not the road), walking away from them.
      ex = sx + ox * 1.4; ez = sz + oz * 1.4;
      yaw = Math.atan2(-ox, -oz);
    } else {
      let ox = x - c.x, oz = z - c.z;
      const l = Math.hypot(ox, oz) || 1;
      ox /= l; oz /= l;
      const r = Math.max(b.bounds[2] - b.bounds[0], b.bounds[3] - b.bounds[1]) * 0.6 + 4;
      ex = c.x + ox * r; ez = c.z + oz * r;
      yaw = Math.atan2(-ox, -oz);
    }
    return { ref: b, pad, exit: { x: ex, z: ez, yaw } };
  }

  // ------------------------------------------------------------------ per frame

  /** Every frame (from the game's tick after the player and camera, or instead of them while `drives`). */
  update(dt: number): void {
    const g = this.g;
    this.fleet.update(dt);
    this.ward.update(dt, this.inWard ? g.player.pos : null);
    const o = this.ward.origin, lit = this.ward.open;
    // The ward's three ceiling lights (from the shared pool: render/lightPool).
    if (lit) for (let i = 0; i < 3; i++) lightPool.want(o.x, o.y + (i === 2 ? 2.6 : 3.9), o.z + [WARD.pod.z + 1, 4, WARD.hz + 1.6][i], 0xeef6ff, 4, 18, 1.2, -30);
    if (this.ward.doorsMoved) g.audio.play('door_open', this.ward.origin.x, this.ward.origin.y + 1.5, this.ward.origin.z + WARD.hz, 0.6, 1.3, 5, g.renderer.camera.position);
    if (this.phase === 'idle') return;
    this.t += dt;
    const P = g.player, H = g.crime.health;
    const once = (k: string, at: number) => { if (this.t < at || this.fired.has(k)) return false; this.fired.add(k); return true; };
    // Space skips ahead (to the hospital; through the scan).
    const skip = g.input.hit('Space');
    switch (this.phase) {
      case 'down': case 'inbound': {
        P.downT = Math.max(P.downT, 1e3);
        H.koT = 1e9;
        // A giant (or a tiny) hero's power fades with consciousness: back towards normal size.
        if (!g.ragdolls.isActive(P) && P.height > BASE_HEIGHT * 1.3) { P.height = Math.max(BASE_HEIGHT, P.height * Math.exp(-dt * 1.4)); P.targetHeight = P.height; }
        if (once('cap', 0.6)) this.ui.titleCard('DEFEATED<small>Rescue drones on the way</small>', true);
        if (once('capOff', 3.4)) this.ui.titleCard('');
        // Down again in the ward: no ragdoll there (its physics has no floor down here).
        if (this.phase === 'down' && this.ward.open) { this.takeBody(); P.pos.copy(this.body); }
        if (this.phase === 'down' && this.t >= DEFEAT.downTime && this.skipping === 0) this.startInbound();
        if (this.phase === 'inbound' && this.skipping === 0) { this.inbound(dt); this.inboundCam(dt); }
        // (Not in the first moment: a jump pressed as the blow landed should not skip it all.)
        if (skip && (this.phase === 'inbound' || this.t > 0.6)) this.startSkip();
        break;
      }
      case 'lift': this.lift(dt); if (skip) this.startSkip(); break;
      case 'flight': this.flight(dt); if (skip) this.startSkip(); break;
      case 'arrive': this.arrive(dt); if (skip) this.startSkip(); break;
      case 'revive': this.revive(dt, skip); break;
      case 'ward': this.inWardStep(); break;
      case 'leaving': this.leaving(); break;
      case 'over': {
        P.downT = Math.max(P.downT, 1e3);
        H.koT = 1e9;
        if (once('cap', 0.6)) this.ui.titleCard(this.cuffed ? 'ARRESTED<small>Taken into custody</small>' : 'DEFEATED<small>No one is coming</small>', true);
        if (once('screen', DEFEAT.overDelay)) {
          this.ui.titleCard('');
          const r = Math.round(this.rep);
          this.ui.gameOver(this.cuffed
            ? `Your reputation is <b>${r}</b>. The city had seen enough: the police took you down and locked you away for good.`
            : `Your reputation is <b>${r}</b>. With the city against you, the hospital sent no drones to bring you in.`);
        }
        break;
      }
    }
    if (this.skipping > 0) this.skipStep(dt);
    this.sound();
    this.faceCamera();
  }

  /** A short fade to black, then straight into the ward. */
  private startSkip(): void {
    if (this.skipping > 0) return;
    this.skipping = 0.001;
    this.stats.skips++;
  }

  private skipStep(dt: number): void {
    this.skipping = Math.min(1, this.skipping + dt * 2.5);
    this.ui.fade(this.skipping);
    if (this.skipping >= 1) { this.skipping = 0; this.transfer(); }
  }

  // ------------------------------------------------------------------ inbound and lift

  private startInbound(): void {
    const g = this.g, P = g.player, h = this.hosp!;
    this.set('inbound');
    // Down in the metro or the sewers, or inside a building: carried out under the black.
    if (g.underground.feetUnder(P.pos.x, P.pos.y, P.pos.z) || g.indoorsAt(P.pos.x, P.pos.y + 0.5, P.pos.z)) { this.startSkip(); return; }
    this.fleet.group.visible = true;
    this.fleet.pad.visible = !!h.ref;
    this.fleet.pad.position.copy(h.pad);
    this.fleet.pad.scale.setScalar(this.padScale);
    let dx = h.pad.x - P.pos.x, dz = h.pad.z - P.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    this.heading = Math.atan2(-dx, -dz) + Math.PI;
    this.from = this.fleet.drones.map((_, i) => new THREE.Vector3(P.pos.x + dx * DEFEAT.inboundDist + (i - 1) * 4, P.pos.y + DEFEAT.inboundUp + i * 2, P.pos.z + dz * DEFEAT.inboundDist));
    this.fleet.drones.forEach((d, i) => d.object.position.copy(this.from[i]));
    this.ui.skippable(true);
    this.ui.cinema(true);
    // The camera from where the rig left it (inboundCam takes it from there).
    const cam = g.renderer.camera;
    this.camPos.copy(cam.position);
    _v.set(0, 0, -1).applyQuaternion(cam.quaternion);
    this.camLook.copy(cam.position).addScaledVector(_v, 6);
    this.camInit = true;
  }

  /** The drones coming in: low beside the body, looking up past it at them (both in the frame). */
  private inboundCam(dt: number): void {
    const g = this.g, P = g.player;
    _w.set(0, 0, 0);
    for (const d of this.fleet.drones) _w.add(d.object.position);
    _w.multiplyScalar(1 / this.fleet.drones.length);
    let dx = _w.x - P.pos.x, dz = _w.z - P.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    // Behind the body (seen from the drones) and to the side.
    let ox = -dx * 6.5 - dz * 2.8, oz = -dz * 6.5 + dx * 2.8;
    const oy = 1.5;
    const ol = Math.hypot(ox, oy, oz);
    const hit = g.world.raycast(P.pos.x, P.pos.y + 0.8, P.pos.z, ox / ol, oy / ol, oz / ol, ol, 0.5);
    const k = hit.t < ol ? Math.max(0.3, (hit.t - 0.6) / ol) : 1;
    ox *= k; oz *= k;
    _v.set(P.pos.x + ox, P.pos.y + 0.8 + oy * k, P.pos.z + oz);
    _v.y = Math.max(_v.y, g.terrain.height(_v.x, _v.z) + 0.5);
    // Look halfway (in angle) between the body and the drones.
    _b.set(P.pos.x, P.pos.y + 0.3, P.pos.z).sub(_v).normalize();
    _w.sub(_v).normalize().add(_b).normalize();
    _w.multiplyScalar(10).add(_v);
    this.camTo(_v, _w, dt, 1.4);
  }

  /** The slot of drone i over a body at (b) with the given heading. */
  private slot(i: number, b: THREE.Vector3, heading: number, up: number, out: THREE.Vector3): THREE.Vector3 {
    const [sx, sz] = SLOTS[i % SLOTS.length];
    const c = Math.cos(heading), s = Math.sin(heading);
    // Local x across, z along the body (towards the head: heading's backward).
    return out.set(b.x + sx * c + sz * s, b.y + up + Math.sin(this.t * 2.1 + i * 2) * 0.12, b.z - sx * s + sz * c);
  }

  private inbound(_dt: number): void {
    const P = this.g.player;
    const u = smoothstep(0, DEFEAT.inboundTime, this.t);
    this.fleet.drones.forEach((d, i) => {
      this.slot(i, P.pos, this.heading, DEFEAT.hang + 0.6, _v);
      d.object.position.lerpVectors(this.from[i], _v, u);
      this.face(d.object, _v.x - this.from[i].x, _v.z - this.from[i].z, (1 - u) * 0.3);
    });
    if (this.t >= DEFEAT.inboundTime) this.startLift();
  }

  /** Face a drone along (dx, dz), pitched forward by `tilt`. */
  private face(o: THREE.Object3D, dx: number, dz: number, tilt: number): void {
    if (Math.hypot(dx, dz) > 1e-3) o.rotation.set(-tilt, Math.atan2(-dx, -dz), 0, 'YXZ');
  }

  private startLift(): void {
    const g = this.g, P = g.player;
    this.set('lift');
    this.body.copy(P.pos);
    this.ui.cinema(true);
    this.ui.hurt(false);
    g.audio.play('whoosh_takeoff', P.pos.x, P.pos.y + 2, P.pos.z, 0.5, 0.7, 6, g.renderer.camera.position);
    // The camera from where the rig left it.
    const cam = g.renderer.camera;
    this.camPos.copy(cam.position);
    _v.set(0, 0, -1).applyQuaternion(cam.quaternion);
    this.camLook.copy(cam.position).addScaledVector(_v, 6);
    this.camInit = true;
  }

  private takeBody(): void {
    const g = this.g, P = g.player;
    if (g.ragdolls.isActive(P)) g.ragdolls.release(P);
    if (P.puppet) return;
    P.ragdoll = '';
    P.downT = 0;
    P.action = undefined;
    if (P.height < BASE_HEIGHT * 0.65 || P.height > BASE_HEIGHT * 1.3) P.height = P.targetHeight = BASE_HEIGHT;
    P.puppet = 'sleep';
    this.body.y = Math.max(this.body.y, g.collision.groundAt(this.body.x, this.body.z, this.body.y + 0.5, 0.5));
    this.fleet.field.visible = true;
  }

  private lift(dt: number): void {
    const k = smoothstep(0, 0.5, this.t);
    if (this.t > 0.45) this.takeBody();
    const rise = smoothstep(0.6, DEFEAT.liftTime, this.t) * 3.2;
    _w.copy(this.body);
    _w.y += rise;
    this.carry(_w, this.heading, k, dt);
    // The camera swings round to the side, looking at the rising body.
    const side = this.heading + Math.PI / 2;
    _v.set(_w.x + Math.sin(side) * 8, _w.y + 1.2, _w.z + Math.cos(side) * 8);
    _w.y += 1.6; // between the body and the drones
    this.camTo(_v, _w, dt, 1.6);
    _w.y -= 1.6;
    if (this.t >= DEFEAT.liftTime) {
      this.body.copy(_w);
      const h = this.hosp!;
      const clear = this.clearance(this.body, h.pad);
      this.plan = planFlight([this.body.x, this.body.y, this.body.z], [h.pad.x, h.pad.y + 1.6, h.pad.z], clear);
      this.set('flight');
    }
  }

  /** The highest roof between two points (the flight stays above it). */
  private clearance(a: THREE.Vector3, b: THREE.Vector3): number {
    let top = -Infinity;
    const n = Math.max(2, Math.ceil(a.distanceTo(b) / 40));
    for (let i = 0; i <= n; i++) {
      const x = lerp(a.x, b.x, i / n), z = lerp(a.z, b.z, i / n);
      for (const r of this.g.world.buildingsIn(x - 60, z - 60, x + 60, z + 60)) if (r !== this.hosp?.ref) top = Math.max(top, r.top);
      top = Math.max(top, this.g.terrain.height(x, z));
    }
    return top;
  }

  /** Body at (b), facing so the head leads; the drones over it with their beams; the field round it. */
  private carry(b: THREE.Vector3, heading: number, beam: number, dt: number): void {
    const P = this.g.player;
    if (P.puppet) {
      P.pos.copy(b);
      P.yaw = heading;
      P.vel.set(0, 0, 0);
      const f = this.fleet.field;
      f.position.set(b.x, b.y + 0.28, b.z);
      f.rotation.set(Math.PI / 2, heading, 0, 'YXZ');
    }
    _b.set(b.x, b.y + 0.3, b.z);
    this.fleet.drones.forEach((d, i) => {
      const prev = _q.copy(d.object.quaternion);
      this.slot(i, b, heading, DEFEAT.hang, _v);
      const vx = (_v.x - d.object.position.x) / Math.max(1e-3, dt), vz = (_v.z - d.object.position.z) / Math.max(1e-3, dt);
      d.object.position.copy(_v);
      const sp = Math.hypot(vx, vz);
      if (sp > 2) this.face(d.object, vx, vz, clamp(sp / 140, 0, 0.35));
      else d.object.quaternion.copy(prev);
      d.aim(P.puppet || beam > 0 ? _b : null, beam);
    });
    P.update(dt, this.g.input, 0, 0);
  }

  // ------------------------------------------------------------------ the flight

  private flight(dt: number): void {
    const f = this.plan!;
    const p = flightAt(f, this.t, _f);
    const nx = p[0], ny = p[1], nz = p[2];
    const dx = nx - this.body.x, dz = nz - this.body.z;
    if (Math.hypot(dx, dz) > 0.02) {
      const want = Math.atan2(-dx, -dz) + Math.PI;
      let d = want - this.heading;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.heading += d * Math.min(1, dt * 2.5);
    }
    this.body.set(nx, ny, nz);
    this.carry(this.body, this.heading, 1, dt);
    // Chase camera: behind (the feet trail) and above, a little to the side, swinging slowly.
    // ((sin, cos) of the heading is the way the body travels: the camera trails it.)
    // (The offset is smoothed, not the camera: at 50 m/s a lagging camera loses the body.)
    const back = this.heading, sw = Math.sin(this.t * 0.35) * 0.6;
    _v.set(-Math.sin(back + sw) * 8.5, 3.6, -Math.cos(back + sw) * 8.5);
    if (this.t <= dt) this.chase.copy(this.camPos).sub(this.body);
    this.chase.lerp(_v, Math.min(1, dt * 1.5));
    const cam = this.g.renderer.camera;
    this.camPos.copy(this.body).add(this.chase);
    this.camLook.set(nx, ny + 0.5, nz);
    cam.position.copy(this.camPos);
    cam.lookAt(this.camLook);
    this.fov(62);
    if (this.t >= f.dur) {
      this.set('arrive');
      this.g.audio.play('drone_buzz', nx, ny + 2, nz, 0.4, 0.9, 10, this.g.renderer.camera.position);
    }
  }

  private arrive(dt: number): void {
    const h = this.hosp!;
    const k = smoothstep(0, DEFEAT.arriveTime, this.t);
    _w.set(h.pad.x, lerp(h.pad.y + 1.6, h.pad.y + 0.7, k), h.pad.z);
    this.body.copy(_w);
    this.carry(this.body, this.heading, 1, dt);
    _v.set(_w.x - Math.sin(this.heading + 0.9) * 9, _w.y + 5, _w.z - Math.cos(this.heading + 0.9) * 9);
    this.camTo(_v, _w, dt, 1.5);
    this.ui.fade(smoothstep(DEFEAT.arriveTime * 0.4, DEFEAT.arriveTime, this.t));
    if (this.t >= DEFEAT.arriveTime) this.transfer();
  }

  // ------------------------------------------------------------------ the ward

  /** Under the black: into the revival machine. */
  private transfer(): void {
    const g = this.g, P = g.player, h = this.hosp!;
    this.skipping = 0;
    this.ui.fade(1);
    this.ui.cinema(true);
    this.ui.hurt(false);
    this.ui.titleCard('');
    this.takeBody();
    this.fleet.group.visible = false;
    this.fleet.field.visible = false;
    this.fleet.pad.visible = false;
    for (const d of this.fleet.drones) d.aim(null);
    const x = h.pad.x, z = h.pad.z;
    this.ward.place(x, g.terrain.height(x, z) - DEFEAT.wardDepth, z);
    const o = this.ward.origin;
    P.puppet = 'sleep';
    P.pos.set(o.x + WARD.pod.x, o.y + WARD.pod.top - 0.08, o.z + WARD.pod.z);
    P.yaw = Math.PI; // head towards the machine's tower (-z)
    P.vel.set(0, 0, 0);
    this.ward.setVitals(0.02, 0, 'STASIS');
    this.ward.setCanopy(0);
    this.ward.surge(1);
    this.camInit = false;
    this.beat = 0;
    this.fired.clear();
    this.set('revive');
  }

  private revive(dt: number, skip: boolean): void {
    const g = this.g, P = g.player, H = g.crime.health, W = this.ward, o = W.origin;
    const once = (k: string, at: number) => { if (this.t < at || this.fired.has(k)) return false; this.fired.add(k); return true; };
    const T = { fadeIn: 1.0, scan: 1.4, beat: 3.2, surge: 7.4, flash: 7.8, stand: 7.85, hand: 8.4, end: 10.2 };
    if (skip && this.t < T.surge - 0.3) { this.t = T.surge - 0.3; this.stats.skips++; }
    if (this.t < T.stand) {
      P.puppet = 'sleep';
      P.pos.set(o.x + WARD.pod.x, o.y + WARD.pod.top - 0.08, o.z + WARD.pod.z);
      P.yaw = Math.PI;
      P.update(dt, g.input, 0, 0);
    }
    this.ui.titleCard(this.t > 0.2 && this.t < 3.6 ? `${this.name}<small>Regeneration ward · ${cityName(g.settings.seed)}</small>` : '');
    // Screen: black, fade in; the white flash of the revival.
    let a = 1 - smoothstep(T.fadeIn, T.fadeIn + 1.6, this.t), white = 0;
    if (this.t > T.surge) {
      const f = this.t < T.flash ? smoothstep(T.surge, T.flash, this.t) : 1 - smoothstep(T.flash, T.flash + 1.1, this.t);
      a = Math.max(a, f * 0.7); white = 1;
    }
    this.ui.fade(a, white);
    // The scan and the vitals.
    const sk = clamp((this.t - T.scan) / (T.surge - T.scan), 0, 1);
    W.scan(sk, this.t > T.scan && this.t < T.flash);
    const hp = lerp(0.02, 1, smoothstep(T.scan + 0.8, T.surge, this.t));
    const bpm = this.t < T.beat ? 0 : lerp(34, 68, smoothstep(T.beat, T.surge, this.t));
    W.setVitals(hp, bpm, this.t < T.scan + 1 ? 'STASIS' : this.t < T.beat ? 'CELLULAR REGENERATION' : this.t < T.surge ? 'NEURAL RESTART' : 'REVIVED');
    H.hp = Math.max(1, H.max * hp);
    W.surge(this.t > T.surge ? 1 + 1.4 * (1 - smoothstep(T.surge, T.surge + 1.6, this.t)) : 1);
    if (bpm > 0) {
      this.beat -= dt;
      if (this.beat <= 0) { this.beat = 60 / bpm; g.audio.play2d('heart_pulse', 0.35 + 0.25 * sk, 1); }
    }
    if (once('surge', T.surge)) { g.audio.chime('core', 0.8); g.audio.play2d('dash_whoosh', 0.5, 0.6); }
    W.setCanopy(smoothstep(T.surge + 0.2, T.surge + 1.4, this.t));
    if (once('stand', T.stand)) {
      // Under the flash: up, standing beside the machine, facing the doors.
      P.puppet = null;
      P.downT = 0;
      P.action = undefined;
      P.pos.set(o.x + WARD.stand.x, o.y, o.z + WARD.stand.z);
      P.yaw = Math.PI; // facing the doors (+z)
      P.vel.set(0, 0, 0);
      P.height = P.targetHeight = BASE_HEIGHT;
      P.rig.animator?.snapPose(); // standing at once (no slanted blend out of lying in the bed)
      H.reset();
      H.koT = 1e9;
      this.ui.caption('');
    }
    if (this.t >= T.stand && this.t < T.hand) P.update(dt, ZERO_INPUT as unknown as Game['input'], P.yaw, 0);
    // Camera: high over the machine, circling; close at the head as the scan ends; then the rig.
    const cam = g.renderer.camera;
    if (this.t >= T.stand && this.t < T.hand) {
      // Cut under the flash: from in front, the hero up beside the machine.
      _v.set(o.x + WARD.stand.x + 2.6, o.y + 2.1, o.z + WARD.stand.z + 4.6);
      _w.set(o.x + WARD.stand.x - 0.4, o.y + 1.1, o.z + WARD.stand.z - 0.6);
      this.camTo(_v, _w, dt, this.fired.has('wide') ? 3 : 100, 55);
      this.fired.add('wide');
    } else if (this.t < T.hand) {
      const a0 = 0.6 + this.t * 0.07;
      const pz = o.z + WARD.pod.z;
      if (this.t < 5.2) {
        _v.set(o.x + Math.sin(a0) * 4.6, o.y + 3.3, pz + Math.cos(a0) * 4.6);
        _w.set(o.x, o.y + 1.0, pz);
      } else {
        _v.set(o.x + 1.6, o.y + 1.85, pz - 0.2 + (this.t - 5.2) * 0.12);
        _w.set(o.x, o.y + 1.05, pz - 0.6);
      }
      this.camTo(_v, _w, dt, this.t > 5.15 && this.t < 5.3 ? 100 : 3, 55);
    } else {
      // Into the gameplay camera, behind the hero facing the doors.
      if (!this.handoff) {
        g.camRig.yaw = P.yaw - 0.35; // behind, a little to the open side
        g.camRig.pitch = -0.2;
        g.camRig.snap();
        this.handoff = { pos: cam.position.clone(), q: cam.quaternion.clone() };
      }
      g.camRig.update(dt, P, ZERO_INPUT as unknown as Game['input'], false);
      const e = smoothstep(T.hand, T.end - 0.3, this.t);
      cam.position.lerpVectors(this.handoff.pos, cam.position, e);
      cam.quaternion.slerpQuaternions(this.handoff.q, cam.quaternion.clone(), e);
      P.update(dt, ZERO_INPUT as unknown as Game['input'], g.camRig.yaw, g.camRig.pitch);
    }
    if (this.t >= T.end) {
      this.ui.clear();
      H.koT = 0;
      this.handoff = null;
      this.set('ward');
      g.powerHud.toast(`Revived at <b>${this.name}</b>. Leave through the doors at the end of the ward.`, 'info', 7000);
    }
  }

  /** Free in the ward until the doors. */
  private inWardStep(): void {
    const P = this.g.player, W = this.ward;
    const l = W.local(P.pos.x, P.pos.z);
    if (wardExit(l.x, l.z)) this.set('leaving');
  }

  private leaving(): void {
    const g = this.g, P = g.player;
    this.ui.fade(smoothstep(0, 0.6, this.t));
    if (this.t >= 0.6 && !this.fired.has('out')) {
      this.fired.add('out');
      const e = this.hosp!.exit;
      this.ward.close();
      g.map.placeSafely(e.x, e.z);
      P.yaw = e.yaw;
      P.vel.set(0, 0, 0);
      // The camera in front, looking back at the hero walking out with the hospital behind them.
      g.camRig.yaw = e.yaw + Math.PI - 0.55;
      g.camRig.pitch = -0.12;
      g.camRig.snap();
      g.audio.play2d('door_close', 0.5, 1);
    }
    if (this.t >= 0.6) this.ui.fade(1 - smoothstep(0.7, 1.6, this.t));
    if (this.t >= 1.6) {
      this.ui.clear();
      this.hosp = null;
      this.set('idle');
    }
  }

  /** In the ward: no flying, no growing past the ceiling, and never out through a wall. */
  gate(): void {
    if (!this.inWard || this.drives) return;
    const P = this.g.player;
    P.flightAllowed = false;
    P.maxHeight = Math.min(P.maxHeight, 2.6);
  }

  /** After the player moved (the game's tick): keep the body in the ward. */
  afterPlayer(dt: number): void {
    if (!this.inWard || this.drives) return;
    const P = this.g.player, o = this.ward.origin;
    // Near the front wall, heading out: eased into the doorway (off to one side one would only
    // walk into the wall beside it).
    const lx = P.pos.x - o.x, lz = P.pos.z - o.z, D = WARD.door.half - P.radius - 0.15;
    if (this.phase === 'ward' && lz > WARD.hz - 2.4 && lz < WARD.hz + 0.3 && Math.abs(lx) > D && Math.abs(lx) < WARD.door.half + 1.6 && P.vel.z > 0.3) {
      P.pos.x -= (lx - Math.sign(lx) * D) * Math.min(1, dt * 5);
    }
    this.ward.clampBody(P.pos, P.radius, P.height);
  }

  /** Where the camera is (the vitals hologram turns to it). */
  faceCamera(): void {
    if (this.ward.open) this.ward.faceVitals(this.g.renderer.camera.position);
  }

  // ------------------------------------------------------------------ camera, sound

  private camTo(pos: THREE.Vector3, look: THREE.Vector3, dt: number, rate: number, fov = 58): void {
    const cam = this.g.renderer.camera;
    if (!this.camInit) { this.camPos.copy(pos); this.camLook.copy(look); this.camInit = true; }
    const k = Math.min(1, dt * rate);
    this.camPos.lerp(pos, k);
    this.camLook.lerp(look, k);
    cam.position.copy(this.camPos);
    cam.lookAt(this.camLook);
    this.fov(fov);
  }

  private fov(f: number): void {
    const cam = this.g.renderer.camera;
    if (Math.abs(cam.fov - f) > 0.01 || cam.near !== 0.06) { cam.fov = f; cam.near = 0.06; cam.far = 60000; cam.updateProjectionMatrix(); }
  }

  private sound(): void {
    const g = this.g;
    const flying = this.fleet.group.visible && (this.phase === 'inbound' || this.phase === 'lift' || this.phase === 'flight' || this.phase === 'arrive');
    if (flying && !this.loop) this.loop = g.audio.loop('drone_buzz', 9);
    if (this.loop) {
      if (!flying) { this.loop.stop(); this.loop = null; return; }
      const p = this.fleet.drones[0].object.position;
      this.loop.set(p.x, p.y, p.z, 0.8, 1.05);
    }
  }

  // ------------------------------------------------------------------ dev

  /** Dev: knock the hero out now (as if their health ran out). */
  down(kind: HurtKind = 'monster'): string {
    const H = this.g.crime.health;
    const was = H.invulnerable;
    H.invulnerable = false;
    H.damage(H.hp + 1000, kind, this.g.player.pos.x, this.g.player.pos.z, this.g.player.pos.y);
    H.invulnerable = was;
    return this.phase;
  }

  status(): Record<string, unknown> {
    const h = this.hosp;
    return {
      phase: this.phase, t: +this.t.toFixed(2), hospital: this.name,
      pad: h ? { x: Math.round(h.pad.x), y: Math.round(h.pad.y), z: Math.round(h.pad.z), building: !!h.ref } : null,
      exit: h ? { x: Math.round(h.exit.x), z: Math.round(h.exit.z) } : null,
      flight: this.plan ? +this.plan.dur.toFixed(1) : null, ward: this.ward.open, ...this.stats,
      local: this.ward.open ? (() => { const P = this.g.player.pos, l = this.ward.local(P.x, P.z); return { x: +l.x.toFixed(2), y: +(P.y - this.ward.origin.y).toFixed(2), z: +l.z.toFixed(2) }; })() : null,
    };
  }
}

/** No keys, no mouse (the scripted camera and body). */
const ZERO_INPUT = { down: () => false, hit: () => false, mouseDX: 0, mouseDY: 0, wheel: 0, keys: new Set<string>() };
