/**
 * The carcass (PLAYGROUND_PLAN §0 decision 19; THREATS_PLAN §3 "aftermath"): a monster brought down
 * lies where it fell — a landmark for a few game hours, cordoned off (barriers round it), crowds
 * standing at the tape staring and filming, the news feed showing it. Then the city has it removed:
 * a mobile crane parks beside it, a cleanup crew in orange high-vis cuts it up (tail tip first, the
 * trunk last), the crane lifts piece after piece onto a flatbed, which drives off as the next one
 * arrives — until it is gone (ThreatDirector.removeRemains).
 *
 * The schedule is pure (rules.ts: carcassStage, removalOrder, boneScales — tested); the cut-off
 * pieces shrink out of the skin (CreatureRig.cut). Far from the player only the schedule runs (the
 * share carted away is kept in saves); near it the crane, the trucks and the crew are there.
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import type { Aftermath, StaticProp } from './Aftermath';
import { Rng, deriveSeed, hash32 } from '../../core/rng';
import { PState, type PedAgent } from '../../sim/Pedestrians';
import { VState, type Vehicle } from '../../sim/Traffic';
import { attach, makeActor, play, stand, lookAt, setState, AFTERMATH_OWNER } from '../../sim/actors/Actor';
import type { EquipmentVisuals } from '../../items/types';
import { Strider, STRIDER_RIG, CUT_LAYOUT } from '../threats/Strider';
import { CARCASS, carcassStage, removalOrder, boneScales } from './rules';
import { CRANE_BOOM_LEN, CRANE_BOOM_PIVOT, vehicleModel } from '../../props/vehicles';
import { parked } from './park';

const ORDER = removalOrder(CUT_LAYOUT, { tail: STRIDER_RIG.tail.length, neck: STRIDER_RIG.neck.length, spine: STRIDER_RIG.spine.length, legs: STRIDER_RIG.legs.length });
const HIDE: [number, number, number] = [0.13, 0.12, 0.11];
const BARRIER: [number, number, number] = [0.75, 0.08, 0.06];
const CABLE: [number, number, number] = [0.1, 0.1, 0.1];

interface Site {
  body: Strider;
  /** The crane, the flatbed being loaded, the ones driving off, the crew. */
  crane: Vehicle | null;
  bed: Vehicle | null;
  leaving: { car: Vehicle; t: number }[];
  crew: PedAgent[];
  /** The piece being worked on (index into ORDER) and where the crane stands. */
  piece: number;
  at: { x: number; z: number; yaw: number } | null;
  spawnT: number;
  gawkT: number;
  loop: ReturnType<Game['audio']['loop']>;
}

const _f = new Float32Array(CUT_LAYOUT.count * 16);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0);
const _X = new THREE.Vector3(1, 0, 0);

export class Cleanup {
  private sites = new Map<Strider, Site>();
  private rng: Rng;
  private drawKey = '';
  stats = { pieces: 0, cranes: 0, flatbeds: 0, removed: 0 };

  constructor(private g: Game, private A: Aftermath) {
    this.rng = new Rng(deriveSeed(g.settings.seed, 'cleanup'));
    // The crane model, built now (not on the first cleanup).
    vehicleModel('crane'); vehicleModel('flatbed');
  }

  update(dt: number): void {
    const g = this.g, now = this.A.hours;
    const bodies = g.threats.remains;
    for (const b of bodies) if (!this.sites.has(b)) this.sites.set(b, { body: b, crane: null, bed: null, leaving: [], crew: [], piece: -1, at: null, spawnT: 0, gawkT: 0, loop: null });
    let barriers = '';
    for (const [b, S] of this.sites) {
      if (!bodies.includes(b)) { this.dismiss(S); this.sites.delete(b); continue; }
      if (b.downAt < 0) b.downAt = now;
      const st = carcassStage(now - b.downAt);
      // (Monotone: a load or the clock never puts a piece back.)
      b.cleared = Math.max(b.cleared, st.removed);
      if (b.cleared > 0) {
        b.rig.cut ??= new Float32Array(CUT_LAYOUT.count).fill(1);
        boneScales(b.cleared, ORDER, b.rig.cut);
      }
      if (b.cleared >= 1) {
        // Gone: the last truck drives off, the crane packs up, the cordon comes down.
        this.dismiss(S);
        this.sites.delete(b);
        g.threats.removeRemains(b);
        b.rig.cut = null;
        this.stats.removed++;
        this.A.note('the carcass is gone');
        continue;
      }
      const p = g.player.pos, near = Math.hypot(b.x - p.x, b.z - p.z) < 600;
      barriers += near ? `${Math.round(b.x)},${Math.round(b.z)};` : '';
      if (st.stage === 'landmark' || b.cleared === 0) { this.gawkers(S, dt); if (S.crane) this.dismiss(S); continue; }
      if (near) this.operation(S, dt);
      else this.dismiss(S);
    }
    if (barriers !== this.drawKey) { this.drawKey = barriers; this.cordons(); }
  }

  /** The cordon round each carcass near the player: barriers on a ring (not inside buildings or in the water). */
  private cordons(): void {
    const g = this.g, p = g.player.pos;
    const list: StaticProp[] = [];
    for (const b of g.threats.remains) {
      if (Math.hypot(b.x - p.x, b.z - p.z) > 600) continue;
      const R = CARCASS.cordonR, n = Math.round((Math.PI * 2 * R) / 7);
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2, x = b.x + Math.cos(a) * R, z = b.z + Math.sin(a) * R;
        if (!g.world.standable(x, z, 0)) continue;
        list.push({ kind: 'barrier', x, y: g.world.groundHeight(x, z), z, yaw: -a, paint: BARRIER, o: { blink: k % 3 === 0 ? 2 : 0 } });
      }
    }
    this.A.setStatic('carcass', list);
  }

  /** People at the tape: stop, stare and film it (a few at a time). */
  private gawkers(S: Site, dt: number): void {
    S.gawkT -= dt;
    if (S.gawkT > 0) return;
    S.gawkT = 1.2;
    const g = this.g, b = S.body;
    let n = 0;
    for (const a of g.peds.neighbours(b.x, b.z, CARCASS.gawkR + 60, [])) {
      if (n >= 3 || a.actor || a.inside || a.state !== PState.Walk || a.evac) continue;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < CARCASS.cordonR + 2 || this.rng.float() > 0.5) continue;
      a.state = a.cit.curiosity > 0.6 ? PState.Film : PState.Gawk;
      a.stateT = 0;
      a.lookX = b.x; a.lookY = b.y + 4; a.lookZ = b.z;
      n++;
    }
  }

  /** The cleanup at work (near the player): the crane, a flatbed, the crew, the piece on the hook. */
  private operation(S: Site, dt: number): void {
    const g = this.g, b = S.body, n = ORDER.length;
    const x = b.cleared * n, k = Math.min(n - 1, Math.floor(x)), phase = x - k;
    // The crane: in a street beside the body (not under it), within the boom's reach of it.
    if (!S.at) { S.at = this.craneSpot(b); if (!S.at) return; }
    S.spawnT -= dt;
    if (!S.crane && S.spawnT <= 0) {
      S.spawnT = 4;
      const car = g.traffic.spawnVehicle('crane', S.at.x, S.at.z, 60, S.at);
      if (car) { car.task = { x: car.x, z: car.z, arrived: true, hold: true }; car.speed = 0; car.gun = { yaw: 0, pitch: 0.5, recoil: 0 }; S.crane = car; this.stats.cranes++; }
    }
    const crane = S.crane;
    if (!crane || !crane.alive) { S.crane = null; return; }
    // The crew (3, orange high-vis, helmets) at the piece, cutting.
    const bone = ORDER[k];
    const pc = this.bonePos(b, bone);
    while (S.crew.length < 3) {
      const c = g.population.synthetic(hash32(b.id * 977 + S.crew.length * 131 + 5) || 1);
      const a = g.peds.spawnAt(c, crane.x + (S.crew.length - 1) * 1.5, crane.z + 2, 0, false);
      if (!a) break;
      attach(a, makeActor('worker', AFTERMATH_OWNER, { outfit: workerOutfit(c.seed), mood: 'focused', held: null }));
      S.crew.push(a);
    }
    S.crew.forEach((a, i) => {
      const act = a.actor;
      if (!a.alive || !act) return;
      const ang = i * 2.1 + 0.5, tx = pc.x + Math.cos(ang) * 3.2, tz = pc.z + Math.sin(ang) * 3.2;
      if (Math.hypot(tx - a.x, tz - a.z) > 1.2) { g.crime.police.chase(a, { x: tx, z: tz }, 1.8); }
      else { stand(act); setState(act, 'idle'); lookAt(act, pc.x, pc.y, pc.z); if (!act.action) play(act, i === 1 ? 'work_hammer' : 'work_saw', 2); }
    });
    // A flatbed parks beside the crane for each load; a loaded one drives off.
    if (S.piece !== k) {
      if (S.piece >= 0 && S.bed) {
        const a = this.rng.range(0, Math.PI * 2);
        S.bed.task = { x: S.bed.x + Math.cos(a) * 700, z: S.bed.z + Math.sin(a) * 700, arrived: false };
        S.bed.state = VState.Drive;
        g.traffic.sendTo(S.bed, S.bed.task.x, S.bed.task.z);
        S.leaving.push({ car: S.bed, t: 0 });
        S.bed = null;
        this.stats.pieces++;
      }
      S.piece = k;
    }
    if (!S.bed && S.spawnT <= 0) {
      S.spawnT = 3;
      const fx = -Math.sin(S.at.yaw), fz = -Math.cos(S.at.yaw);
      const slot = { x: S.at.x - fx * 12, z: S.at.z - fz * 12 };
      const a = this.rng.range(0, Math.PI * 2);
      const car = g.traffic.spawnVehicle('flatbed', slot.x + Math.cos(a) * 220, slot.z + Math.sin(a) * 220, 100, slot);
      if (car) { car.task = { x: slot.x, z: slot.z, arrived: false }; car.state = VState.Drive; car.fear = 0; g.traffic.sendTo(car, slot.x, slot.z); S.bed = car; this.stats.flatbeds++; }
    }
    // The boom swings to the piece, lifts it, swings over the flatbed and sets it down.
    const bed = S.bed && parked(S.bed, dt) ? S.bed : null;
    const from = { x: pc.x, y: pc.y, z: pc.z };
    const to = bed ? { x: bed.x, y: bed.y + 1.6, z: bed.z } : { x: crane.x + 8, y: crane.y + 2, z: crane.z };
    const lift = phase < 0.3 ? 0 : phase < 0.45 ? (phase - 0.3) / 0.15 : 1;
    const swing = phase < 0.45 ? 0 : phase < 0.75 ? (phase - 0.45) / 0.3 : 1;
    const lower = phase < 0.8 ? 0 : (phase - 0.8) / 0.2;
    const hx = from.x + (to.x - from.x) * smooth(swing), hz = from.z + (to.z - from.z) * smooth(swing);
    const hy = Math.max(from.y, to.y) + 9 * lift * (1 - lower) + (to.y - Math.max(from.y, to.y)) * lower * (swing >= 1 ? 1 : 0);
    this.aimBoom(crane, hx, hz, dt);
    const tip = this.boomTip(crane);
    const P = this.A.props;
    const hookY = phase < 0.3 ? Math.max(pc.y + 2.5, tip.y - 14) : hy + 1.4;
    const cableLen = Math.max(0.5, tip.y - hookY);
    P.put('cable', tip.x, tip.y, tip.z, 0, CABLE, { sy: cableLen });
    P.put('hook', tip.x, tip.y - cableLen, tip.z, 0, [0.85, 0.65, 0.05]);
    const size = 2.2 + (bone >= CUT_LAYOUT.spine && bone < CUT_LAYOUT.spine + 3 ? 1.2 : 0);
    if (phase >= 0.3) P.put('chunk', tip.x, tip.y - cableLen - 0.9 - size * 0.9, tip.z, phase * 3, HIDE, { sx: size, sy: size * 0.8, sz: size });
    // The loads driving off with their piece on the deck (gone when out of sight).
    for (let i = S.leaving.length - 1; i >= 0; i--) {
      const L = S.leaving[i];
      L.t += dt;
      const c = L.car;
      if (!c.alive || L.t > 90) { if (c.alive && !g.crime.visible(c.x, c.y + 1, c.z)) c.alive = false; S.leaving.splice(i, 1); continue; }
      P.put('chunk', c.x + Math.sin(c.yaw) * 1.5, c.y + 1.35, c.z + Math.cos(c.yaw) * 1.5, c.yaw, HIDE, { sx: 2.4, sy: 1.8, sz: 2.4 });
      if (Math.hypot(c.x - b.x, c.z - b.z) > 260 && !g.crime.visible(c.x, c.y + 1, c.z)) { c.alive = false; S.leaving.splice(i, 1); }
    }
    if (bed) P.put('chunk', bed.x + Math.sin(bed.yaw) * 1.5, bed.y + 1.35, bed.z + Math.cos(bed.yaw) * 1.5, bed.yaw, HIDE, { sx: 1.6, sy: 1.2, sz: 1.6 });
    // The diesel and the hydraulics.
    S.loop ??= g.audio.loop('crane_machinery', 25);
    S.loop?.set(crane.x, crane.y + 2, crane.z, 0.8);
    void dt;
  }

  /** A street spot beside the body, clear of it, as close as the boom allows. */
  private craneSpot(b: Strider): { x: number; z: number; yaw: number } | null {
    const g = this.g, net = g.net, o = { x: 0, z: 0, dx: 0, dz: 0 };
    let best: { x: number; z: number; yaw: number } | null = null, bs = Infinity;
    for (const e of net.edges) {
      const P = e.pts;
      let near = false;
      for (let k = 0; k < P.length && !near; k += 2) if (Math.abs(P[k] - b.x) < 110 && Math.abs(P[k + 1] - b.z) < 110) near = true;
      if (!near || e.cls > 4) continue;
      for (let sAt = 4; sAt < e.len - 4; sAt += 6) {
        net.pointAt(e, sAt, 0, o);
        const dc = Math.hypot(o.x - b.x, o.z - b.z);
        if (dc > 95) continue;
        const gy = g.world.groundHeight(o.x, o.z);
        const n = b.rig.nearest(o.x, gy + 2, o.z);
        const clear = n ? n.d : 99;
        if (clear < 7) continue;
        const s = Math.abs(clear - 10) + dc * 0.15;
        if (s < bs) { bs = s; best = { x: o.x, z: o.z, yaw: Math.atan2(-o.dx, -o.dz) }; }
      }
    }
    return best;
  }

  /** Where a bone's joint is now (the start of its piece). */
  private bonePos(b: Strider, bone: number): { x: number; y: number; z: number } {
    b.rig.boneFrames(_f, CUT_LAYOUT);
    const o = bone * 16;
    return { x: _f[o + 12], y: Math.max(this.g.world.groundHeight(_f[o + 12], _f[o + 14]) + 0.5, _f[o + 13]), z: _f[o + 14] };
  }

  /** Turn the crane's cab towards (x, z) and raise or lower the boom for the reach. */
  private aimBoom(crane: Vehicle, x: number, z: number, dt: number): void {
    const G2 = crane.gun!;
    const dx = x - crane.x, dz = z - crane.z;
    const yaw = angle(Math.atan2(-dx, -dz) - crane.yaw);
    const reach = Math.min(CRANE_BOOM_LEN, Math.max(4, Math.hypot(dx, dz)));
    // (Raised at least a little — a crane's boom is never laid flat at work — and never past upright.)
    const pitch = Math.max(0.45, Math.min(1.2, Math.acos(Math.min(1, reach / CRANE_BOOM_LEN))));
    G2.yaw += Math.max(-0.25 * dt, Math.min(0.25 * dt, angle(yaw - G2.yaw)));
    G2.pitch += Math.max(-0.2 * dt, Math.min(0.2 * dt, pitch - G2.pitch));
  }

  /** The boom tip in the world (as VehicleRenderer poses the turret and gun). */
  private boomTip(crane: Vehicle): THREE.Vector3 {
    const T = vehicleModel('crane').turret!, G2 = crane.gun!;
    _m.compose(_v.set(crane.x, crane.y, crane.z), _q.setFromAxisAngle(_Y, crane.yaw), _w.set(1, 1, 1));
    _v.set(0, 0, -CRANE_BOOM_LEN).applyAxisAngle(_X, G2.pitch).add(_w.set(CRANE_BOOM_PIVOT[0], CRANE_BOOM_PIVOT[1], CRANE_BOOM_PIVOT[2]));
    _v.applyAxisAngle(_Y, G2.yaw).add(_w.set(T.pivot[0], T.pivot[1], T.pivot[2]));
    return _v.applyMatrix4(_m).clone();
  }

  /** The crane drives off, the crew goes, the flatbeds leave. */
  private dismiss(S: Site): void {
    const g = this.g;
    if (S.crane?.alive) { const c = S.crane; c.task = undefined; c.state = VState.Drive; c.gun = undefined; if (!g.crime.visible(c.x, c.y + 1, c.z)) c.alive = false; }
    S.crane = null;
    if (S.bed?.alive && !g.crime.visible(S.bed.x, S.bed.y + 1, S.bed.z)) S.bed.alive = false;
    else if (S.bed) S.bed.task = undefined;
    S.bed = null;
    for (const a of S.crew) a.alive = false;
    S.crew.length = 0;
    S.loop?.stop(); S.loop = null;
    S.at = null;
  }

  status(): Record<string, unknown> {
    const now = this.A.hours;
    return {
      bodies: this.g.threats.remains.map((b) => ({ x: Math.round(b.x), z: Math.round(b.z), downAt: +b.downAt.toFixed(2), hours: +(now - b.downAt).toFixed(2), stage: carcassStage(now - b.downAt).stage, cleared: +b.cleared.toFixed(3) })),
      sites: [...this.sites.values()].map((s) => ({ crane: !!s.crane, bed: !!s.bed, leaving: s.leaving.length, crew: s.crew.length, piece: s.piece })),
      ...this.stats,
    };
  }
}

function smooth(t: number): number { return t * t * (3 - 2 * t); }

function angle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** The city's cleanup crew: orange high-visibility jackets and trousers, white helmets. */
function workerOutfit(seed: number): EquipmentVisuals {
  const orange: [number, number, number] = [0.95, 0.4, 0.05], grey: [number, number, number] = [0.3, 0.3, 0.32], white: [number, number, number] = [0.92, 0.92, 0.9];
  const v = (p: [number, number, number], s: [number, number, number], k: number) => ({ shape: 'cloth', seed: seed + k, primary: p, secondary: s, accent: [0.9, 0.9, 0.3], material: 'plain', glow: 0 });
  return {
    chest: { defId: 'shirt', visual: v(grey, grey, 1) },
    back: { defId: 'jacket', visual: v(orange, white, 2) },
    legs: { defId: 'trousers', visual: v(orange, grey, 3) },
    feet: { defId: 'boots', visual: v([0.08, 0.07, 0.06], [0, 0, 0], 4) },
    head: { defId: 'helmet', visual: v(white, white, 5) },
  } as unknown as EquipmentVisuals;
}
