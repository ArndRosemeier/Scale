/**
 * Life in the sewers around the player: rats, and now and then a lone slime.
 *
 *  - Rats exist only near the player while they are in the sewers (trunks and sewer side rooms;
 *    nothing is simulated city-wide and placement is not deterministic). On the walkways they sit
 *    and sniff (now and then rearing up), scurry a few metres, sit again; in the rooms they nose
 *    about the floor (more of them in hideouts and machine halls). Someone coming close, fast, or
 *    anything violent nearby: they squeak and bolt along the wall, away, and are gone (into a pipe,
 *    a crack).
 *  - A slime: every few minutes in the sewers, one may be oozing along a walkway ahead, carrying
 *    something small and glowing. It stops when it notices the player, then slides off and squeezes
 *    into the wall; a blow splatters it. Drawn with the colonies' blobs (Slimes.blob).
 *
 * One instanced mesh for the rats (plus one for their eyes), no per-frame allocations.
 */
import * as THREE from 'three';
import type { Tube } from './Volumes';
import { tubeAt } from './Volumes';
import { pointOnTube } from './layout';
import { roomW, type Room } from './rooms';
import type { Slimes } from './Slimes';

export const SEWER_LIFE = {
  /** Rats kept around the player; spawn ring (m); gone beyond. */
  rats: 12, spawnMin: 7, spawnMax: 30, dropR: 45,
  /** They bolt when someone comes this close (m), more at a run (+ speed × k). */
  scare: 3.5, scareK: 0.7,
  /** Seconds between slimes (first one, then after each), its notice distance (m). */
  slimeFirst: [70, 200] as [number, number], slimeGap: [160, 420] as [number, number], slimeNotice: 6.5,
};

const MAX_RATS = 24;
const WALK_LAT: [number, number] = [1.2, 1.55];

type RatMode = 'sit' | 'walk' | 'run';

interface Rat {
  mode: RatMode;
  /** On a sewer walkway (tube, arc s, lateral offset, heading along s ±1) or in a room (room-local u, v). */
  tube: Tube | null; s: number; lat: number; dir: number; total: number;
  room: Room | null; u: number; v: number; tu: number; tv: number;
  x: number; y: number; z: number; yaw: number;
  speed: number; wait: number; run: number; ph: number; size: number; rear: number;
}

interface Slime {
  tube: Tube; s: number; lat: number; dir: number; total: number;
  mode: 'ooze' | 'freeze' | 'flee' | 'squeeze' | 'splat';
  t: number; wait: number; r: number; x: number; y: number; z: number; yaw: number; left: number;
  drops: { x: number; z: number; vx: number; vz: number; r: number }[];
}

export interface SewerLifeHost {
  /** Sewer trunks. */
  sewers: readonly Tube[];
  /** Built side rooms near the player (sewer ones are used). */
  roomsNear(x: number, z: number, r: number): Room[];
  floorAt(x: number, y: number, z: number): number | null;
  sound: { play(id: string, x: number, y: number, z: number, gain: number): void } | null;
}

export class SewerLife {
  readonly group = new THREE.Group();
  private rats: Rat[] = [];
  private body: THREE.InstancedMesh;
  private eyes: THREE.InstancedMesh;
  private slime: Slime | null = null;
  private slimeT = rnd(SEWER_LIFE.slimeFirst);
  private spawnT = 0;
  private squeakT = 0;
  private lastP = new THREE.Vector3(1e9, 0, 0);
  private pSpeed = 0;
  /** Debug: rats and slimes stay put (screenshots). */
  calm = false;

  constructor(private host: SewerLifeHost, private slimes: Slimes) {
    const g = ratGeometry();
    this.body = new THREE.InstancedMesh(g.body, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), MAX_RATS);
    this.eyes = new THREE.InstancedMesh(g.eyes, new THREE.MeshBasicMaterial({ color: 0x8a2a1c }), MAX_RATS);
    for (const m of [this.body, this.eyes]) { m.count = 0; m.frustumCulled = false; this.group.add(m); }
    this.group.name = 'sewer-life';
  }

  /** How many rats and slimes are about (debug, tests). */
  get stats(): { rats: number; running: number; slime: string | null } {
    return { rats: this.rats.length, running: this.rats.filter((r) => r.mode === 'run').length, slime: this.slime?.mode ?? null };
  }

  /** Something violent at (x, y, z): rats bolt, a slime hit splatters. */
  stimulus(kind: string, x: number, y: number, z: number, radius: number): void {
    const reach = kind === 'impact' ? 6 : Math.max(8, radius);
    for (const r of this.rats) if (Math.hypot(r.x - x, r.z - z) < reach && Math.abs(r.y - y) < 4) this.bolt(r, x, z);
    const S = this.slime;
    if (!S || S.mode === 'splat' || S.mode === 'squeeze') return;
    const d = Math.hypot(S.x - x, S.z - z);
    const hit = kind === 'impact' ? d < S.r + 0.8 : (kind === 'power' || kind === 'blast' || kind === 'stomp') && d < Math.min(6, radius * 0.25 + 1);
    if (hit && Math.abs(S.y - y) < 2.5) {
      S.mode = 'splat'; S.t = 0;
      for (let i = 0; i < 5; i++) { const a = Math.random() * Math.PI * 2, sp = 1 + Math.random() * 1.6; S.drops.push({ x: S.x, z: S.z, vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, r: S.r * (0.28 + Math.random() * 0.15) }); }
      this.host.sound?.play('slime_squish', S.x, S.y + 0.2, S.z, 1);
    } else if (d < 10 && S.mode === 'ooze') { S.mode = 'flee'; S.t = 0; S.dir = Math.sign(this.along(S, x, z)) || S.dir; }
  }

  /** `active`: the player is in the sewers (trunk or sewer room). */
  update(dt: number, p: THREE.Vector3, active: boolean): void {
    const moved = this.lastP.x > 1e8 ? 0 : Math.hypot(p.x - this.lastP.x, p.z - this.lastP.z) / Math.max(1e-3, dt);
    this.lastP.copy(p);
    this.pSpeed += (Math.min(moved, 20) - this.pSpeed) * Math.min(1, dt * 4);
    this.squeakT -= dt;
    // Rats: drop the far ones, keep the number up while the player is down here.
    this.rats = this.rats.filter((r) => Math.hypot(r.x - p.x, r.z - p.z) < SEWER_LIFE.dropR && r.run > -1);
    this.spawnT -= dt;
    if (active && this.spawnT <= 0) {
      this.spawnT = 0.4;
      if (this.rats.length < SEWER_LIFE.rats) this.spawnRat(p);
    }
    if (!active && this.rats.length && Math.random() < dt * 0.5) this.rats.shift();
    for (const r of this.rats) this.stepRat(r, dt, p);
    this.rats = this.rats.filter((r) => r.run > -1);
    // The slime.
    if (this.slime) this.stepSlime(this.slime, dt, p);
    else if (active) {
      this.slimeT -= dt;
      if (this.slimeT <= 0) { this.slimeT = 8; this.spawnSlime(p); }
    }
    this.draw();
  }

  // ------------------------------------------------------------ rats

  private spawnRat(p: THREE.Vector3): void {
    // Now and then in a sewer room nearby (more in hideouts and machine halls), mostly on a walkway.
    const rooms = this.host.roomsNear(p.x, p.z, 28).filter((r) => r.net === 'sewer');
    if (rooms.length && Math.random() < 0.35) {
      const r = rooms[(Math.random() * rooms.length) | 0];
      const crowd = this.rats.filter((q) => q.room === r).length;
      const want = r.kind === 'hideout' ? 4 : r.kind === 'hall' ? 3 : 1;
      if (crowd < want) {
        const m = r.main;
        for (let k = 0; k < 6; k++) {
          const u = m.u0 + 0.4 + Math.random() * (m.u1 - m.u0 - 0.8), v = m.v0 + 0.4 + Math.random() * (m.v1 - m.v0 - 0.8);
          const [x, z] = roomW(r, u, v);
          if (Math.hypot(x - p.x, z - p.z) < 4) continue;
          const y = this.host.floorAt(x, m.y0 + m.h - 0.5, z);
          if (y === null) continue;
          this.rats.push(this.newRat(null, 0, 0, r, u, v, x, y, z));
          return;
        }
      }
    }
    const near = this.host.sewers.filter((t) => p.x > t.bounds[0] - 30 && p.x < t.bounds[2] + 30 && p.z > t.bounds[1] - 30 && p.z < t.bounds[3] + 30);
    if (!near.length) return;
    const t = near[(Math.random() * near.length) | 0];
    const h = tubeAt(t, p.x, p.y, p.z, 30, true);
    if (!h) return;
    const total = t.cum[t.cum.length - 1];
    const s = h.s + (Math.random() < 0.5 ? -1 : 1) * (SEWER_LIFE.spawnMin + Math.random() * (SEWER_LIFE.spawnMax - SEWER_LIFE.spawnMin));
    if (s < 1 || s > total - 1) return;
    const lat = (Math.random() < 0.5 ? -1 : 1) * (WALK_LAT[0] + Math.random() * (WALK_LAT[1] - WALK_LAT[0]));
    const q = pointOnTube(t, s);
    if (!q) return;
    const x = q.x - q.dz * lat, z = q.z + q.dx * lat;
    if (Math.hypot(x - p.x, z - p.z) < SEWER_LIFE.spawnMin || Math.abs(q.y - p.y) > 6) return;
    const r = this.newRat(t, s, lat, null, 0, 0, x, q.y, z);
    r.total = total;
    this.rats.push(r);
  }

  private newRat(tube: Tube | null, s: number, lat: number, room: Room | null, u: number, v: number, x: number, y: number, z: number): Rat {
    return {
      mode: 'sit', tube, s, lat, dir: Math.random() < 0.5 ? -1 : 1, total: tube ? tube.cum[tube.cum.length - 1] : 0,
      room, u, v, tu: u, tv: v, x, y, z, yaw: Math.random() * Math.PI * 2,
      speed: 0, wait: 0.5 + Math.random() * 3, run: 0, ph: Math.random() * 6, size: 0.85 + Math.random() * 0.4, rear: 0,
    };
  }

  /** Squeak and run, away from (x, z). */
  private bolt(r: Rat, x: number, z: number): void {
    if (r.mode === 'run') return;
    r.mode = 'run';
    r.run = 6 + Math.random() * 8;
    r.rear = 0;
    if (r.tube) {
      const q = pointOnTube(r.tube, r.s);
      if (q) r.dir = (r.x - x) * q.dx + (r.z - z) * q.dz >= 0 ? 1 : -1;
    } else if (r.room) {
      // To the corner farthest from the threat (and through the crack there).
      const m = r.room.main;
      let best = -1;
      for (const [cu, cv] of [[m.u0, m.v0], [m.u0, m.v1], [m.u1, m.v0], [m.u1, m.v1]]) {
        const uu = cu + (cu === m.u0 ? 0.25 : -0.25), vv = cv + (cv === m.v0 ? 0.25 : -0.25);
        const [cx, cz] = roomW(r.room, uu, vv);
        const d = Math.hypot(cx - x, cz - z);
        if (d > best) { best = d; r.tu = uu; r.tv = vv; }
      }
    }
    if (this.squeakT <= 0) {
      this.squeakT = 0.35;
      this.host.sound?.play('rat_squeak', r.x, r.y + 0.1, r.z, 0.7 + Math.random() * 0.3);
    }
  }

  private stepRat(r: Rat, dt: number, p: THREE.Vector3): void {
    const d = Math.hypot(r.x - p.x, r.z - p.z);
    if (!this.calm && r.mode !== 'run' && d < SEWER_LIFE.scare + this.pSpeed * SEWER_LIFE.scareK && Math.abs(p.y - r.y) < 3) this.bolt(r, p.x, p.z);
    r.ph += dt * (r.mode === 'run' ? 22 : r.mode === 'walk' ? 12 : 1.5);
    if (r.mode === 'sit') {
      r.speed = 0;
      r.wait -= dt;
      // Rearing up to sniff now and then.
      r.rear += ((Math.sin(r.ph * 0.7) > 0.75 ? 1 : 0) - r.rear) * Math.min(1, dt * 5);
      if (r.wait <= 0 && !this.calm) {
        r.mode = 'walk'; r.rear = 0;
        r.wait = 0.4 + Math.random() * 1.8;
        if (r.tube) { if (Math.random() < 0.4) r.dir = -r.dir; }
        else if (r.room) { const m = r.room.main; r.tu = m.u0 + 0.35 + Math.random() * (m.u1 - m.u0 - 0.7); r.tv = m.v0 + 0.35 + Math.random() * (m.v1 - m.v0 - 0.7); }
      }
    } else if (r.mode === 'walk') {
      // Scurrying in bursts.
      r.speed = 0.5 + 0.9 * Math.max(0, Math.sin(r.ph * 0.35));
      r.wait -= dt;
      if (r.wait <= 0) { r.mode = 'sit'; r.wait = 1 + Math.random() * 4; }
    } else {
      r.speed = 3.6;
      r.run -= r.speed * dt;
      if (r.run <= 0) { r.run = -2; return; }
    }
    if (r.tube) {
      r.s += r.dir * r.speed * dt;
      if (r.s < 0.5 || r.s > r.total - 0.5) { if (r.mode === 'run') { r.run = -2; return; } r.dir = -r.dir; r.s = Math.max(0.5, Math.min(r.total - 0.5, r.s)); }
      // Hugging the wall when running.
      const want = Math.sign(r.lat) * (r.mode === 'run' ? WALK_LAT[1] : Math.abs(r.lat));
      r.lat += (want - r.lat) * Math.min(1, dt * 3);
      const q = pointOnTube(r.tube, r.s);
      if (!q) { r.run = -2; return; }
      const x = q.x - q.dz * r.lat, z = q.z + q.dx * r.lat;
      if (r.speed > 0.05) r.yaw = Math.atan2(x - r.x, z - r.z);
      r.x = x; r.z = z; r.y = q.y;
    } else if (r.room) {
      const du = r.tu - r.u, dv = r.tv - r.v, dd = Math.hypot(du, dv);
      if (dd < 0.05) { if (r.mode === 'run') { r.run = -2; return; } if (r.mode === 'walk') { r.mode = 'sit'; r.wait = 1 + Math.random() * 3; } return; }
      const st = Math.min(dd, r.speed * dt);
      const nu = r.u + (du / dd) * st, nv = r.v + (dv / dd) * st;
      const [x, z] = roomW(r.room, nu, nv);
      const f = this.host.floorAt(x, r.y + 0.3, z);
      if (f === null || Math.abs(f - r.y) > 0.3) { if (r.mode === 'run') { r.run = -2; return; } r.mode = 'sit'; r.wait = 0.5; return; }
      if (st > 1e-4) r.yaw = Math.atan2(x - r.x, z - r.z);
      r.u = nu; r.v = nv; r.x = x; r.z = z; r.y = f;
    }
  }

  // ------------------------------------------------------------ the slime

  private spawnSlime(p: THREE.Vector3): void {
    const near = this.host.sewers.filter((t) => p.x > t.bounds[0] - 30 && p.x < t.bounds[2] + 30 && p.z > t.bounds[1] - 30 && p.z < t.bounds[3] + 30);
    if (!near.length) return;
    const t = near[(Math.random() * near.length) | 0];
    const h = tubeAt(t, p.x, p.y, p.z, 30, true);
    if (!h) return;
    const total = t.cum[t.cum.length - 1];
    const s = h.s + (Math.random() < 0.5 ? -1 : 1) * (18 + Math.random() * 12);
    if (s < 3 || s > total - 3) return;
    const q = pointOnTube(t, s);
    if (!q || Math.abs(q.y - p.y) > 4) return;
    const lat = (Math.random() < 0.5 ? -1 : 1) * 1.15;
    this.slime = {
      tube: t, s, lat, dir: Math.random() < 0.5 ? -1 : 1, total, mode: 'ooze', t: 0, wait: 0, r: 0.3 + Math.random() * 0.14,
      x: q.x - q.dz * lat, y: q.y, z: q.z + q.dx * lat, yaw: 0, left: 50 + Math.random() * 60, drops: [],
    };
    this.slimeT = rnd(SEWER_LIFE.slimeGap);
  }

  /** Signed distance of (x, z) along the slime's tube from it (+: ahead in +s). */
  private along(S: Slime, x: number, z: number): number {
    const q = pointOnTube(S.tube, S.s);
    return q ? (S.x - x) * q.dx + (S.z - z) * q.dz : 0;
  }

  private stepSlime(S: Slime, dt: number, p: THREE.Vector3): void {
    S.t += dt;
    const d = Math.hypot(S.x - p.x, S.z - p.z);
    if (d > 70 && S.mode !== 'splat') { this.slime = null; return; }
    let speed = 0;
    switch (S.mode) {
      case 'ooze':
        speed = 0.32 * (0.5 + 0.5 * Math.max(0, Math.sin(S.t * 3)));
        S.left -= speed * dt;
        if (S.left <= 0) { S.mode = 'squeeze'; S.t = 0; }
        if (!this.calm && d < SEWER_LIFE.slimeNotice && Math.abs(p.y - S.y) < 3) { S.mode = 'freeze'; S.t = 0; S.wait = 0.8 + Math.random() * 0.8; this.host.sound?.play('slime_squish', S.x, S.y + 0.2, S.z, 0.3); }
        break;
      case 'freeze':
        if (S.t > S.wait || d < 2.5) { S.mode = 'flee'; S.t = 0; S.dir = Math.sign(this.along(S, p.x, p.z)) || S.dir; }
        break;
      case 'flee':
        speed = 1.9 * (0.6 + 0.4 * Math.max(0, Math.sin(S.t * 9)));
        S.lat += (Math.sign(S.lat) * 1.55 - S.lat) * Math.min(1, dt * 2);
        if (S.t > 4.5) { S.mode = 'squeeze'; S.t = 0; }
        break;
      case 'squeeze':
        if (S.t > 0.8) { this.slime = null; return; }
        break;
      case 'splat':
        for (const q of S.drops) { const k = Math.max(0, 1 - S.t * 1.5); q.x += q.vx * dt * k; q.z += q.vz * dt * k; }
        if (S.t > 3) { this.slime = null; return; }
        return;
    }
    S.s += S.dir * speed * dt;
    if (S.s < 1 || S.s > S.total - 1) { S.mode = 'squeeze'; S.t = Math.max(S.t, 0); S.s = Math.max(1, Math.min(S.total - 1, S.s)); }
    const q = pointOnTube(S.tube, S.s);
    if (!q) { this.slime = null; return; }
    S.x = q.x - q.dz * S.lat; S.z = q.z + q.dx * S.lat; S.y = q.y;
    S.yaw = Math.atan2(q.dx * S.dir, q.dz * S.dir);
  }

  // ------------------------------------------------------------ drawing

  private draw(): void {
    let k = 0;
    for (const r of this.rats) {
      if (k >= MAX_RATS) break;
      const run = r.mode !== 'sit';
      const bob = run ? Math.abs(Math.sin(r.ph)) * 0.012 * r.size : 0;
      const pitch = -r.rear * 0.55 + (run ? Math.sin(r.ph * 2) * 0.05 : Math.sin(r.ph * 3) * 0.02);
      const yaw = r.yaw + (run ? Math.sin(r.ph * 0.5) * 0.12 : 0);
      _e.set(pitch, yaw, 0, 'YXZ');
      _m.compose(_p.set(r.x, r.y + bob + 0.005, r.z), _q.setFromEuler(_e), _s.setScalar(r.size));
      this.body.setMatrixAt(k, _m);
      this.eyes.setMatrixAt(k, _m);
      k++;
    }
    this.body.count = this.eyes.count = k;
    if (k) this.body.instanceMatrix.needsUpdate = this.eyes.instanceMatrix.needsUpdate = true;
    const S = this.slime;
    if (!S) return;
    const col: [number, number, number] = [0.5, 0.85, 0.32];
    if (S.mode === 'splat') {
      const fade = Math.max(0, 1 - S.t / 3);
      for (const q of S.drops) this.slimes.blob(q.x, S.y, q.z, q.r, 1.2, 0.5, 0, col, 0.45 * fade);
      return;
    }
    const w = S.mode === 'flee' ? Math.sin(S.t * 13) : S.mode === 'ooze' ? Math.sin(S.t * 3) : Math.sin(S.t * 1.5) * 0.3;
    let sx = 1 - w * 0.08, sy = 1 + w * 0.14;
    let x = S.x, z = S.z;
    if (S.mode === 'squeeze') {
      const q = Math.min(1, S.t / 0.8);
      sx *= 1 - q * 0.75; sy *= 1 - q * 0.6;
      const p = pointOnTube(S.tube, S.s);
      if (p) { const out = Math.sign(S.lat) * q * 0.35; x -= p.dz * out; z += p.dx * out; }
    }
    const glow = S.mode === 'freeze' || S.mode === 'flee' ? 0.32 : 0.55;
    this.slimes.blob(x, S.y, z, S.r, sx, sy, S.yaw, col, glow);
    // What it carries: a small glowing thing on top (not while it squeezes away).
    if (S.mode === 'ooze' || S.mode === 'freeze') this.slimes.blob(x, S.y + S.r * 1.2 * sy, z, 0.04, 1, 1, 0, [1, 0.85, 0.5], 1.2);
  }
}

function rnd([a, b]: [number, number]): number { return a + Math.random() * (b - a); }

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();

/** A rat (nose at +z, ~0.24 m long and a 0.2 m tail at size 1): body, head, ears, legs, tail; eyes apart. */
export function ratGeometry(): { body: THREE.BufferGeometry; eyes: THREE.BufferGeometry } {
  const parts: THREE.BufferGeometry[] = [];
  const fur = new THREE.Color(0.27, 0.23, 0.19), belly = new THREE.Color(0.36, 0.32, 0.27), pink = new THREE.Color(0.55, 0.38, 0.36);
  const add = (g: THREE.BufferGeometry, c: THREE.Color, m: THREE.Matrix4) => {
    g.applyMatrix4(m);
    const n = g.getAttribute('position').count, col = new Float32Array(n * 3);
    const pos = g.getAttribute('position');
    for (let i = 0; i < n; i++) {
      // Lighter underneath.
      const t = pos.getY(i) < 0.035 ? belly : c;
      col[i * 3] = t.r; col[i * 3 + 1] = t.g; col[i * 3 + 2] = t.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g.index ? g.toNonIndexed() : g);
  };
  const M = (x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, 0)), new THREE.Vector3(sx, sy, sz));
  add(new THREE.SphereGeometry(1, 9, 6), fur, M(0, 0.055, -0.01, 0.055, 0.05, 0.11));
  add(new THREE.SphereGeometry(1, 8, 5), fur, M(0, 0.06, 0.09, 0.042, 0.04, 0.05));
  add(new THREE.ConeGeometry(0.032, 0.07, 7), fur, M(0, 0.055, 0.155, 1, 1, 1, Math.PI / 2));
  add(new THREE.SphereGeometry(0.008, 4, 3), pink, M(0, 0.054, 0.19));
  for (const s of [-1, 1]) {
    add(new THREE.SphereGeometry(0.016, 5, 4), pink, M(s * 0.026, 0.1, 0.085, 1, 1, 0.4));
    for (const z of [0.05, -0.07]) add(new THREE.BoxGeometry(0.014, 0.03, 0.022), pink, M(s * 0.035, 0.015, z));
  }
  // The tail: a thin tapering curve, drooping to the floor.
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push(new THREE.Vector3(Math.sin(t * 2.2) * 0.03, 0.04 - t * 0.035, -0.11 - t * 0.2)); }
  const tail = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 8, 0.006, 4, false);
  add(tail, pink, new THREE.Matrix4());
  const merge = (gs: THREE.BufferGeometry[]) => {
    let n = 0;
    for (const g of gs) n += g.getAttribute('position').count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
    let o = 0;
    for (const g of gs) {
      const P = g.getAttribute('position'), N = g.getAttribute('normal'), C = g.getAttribute('color');
      for (let i = 0; i < P.count; i++, o++) {
        pos.set([P.getX(i), P.getY(i), P.getZ(i)], o * 3);
        nor.set([N.getX(i), N.getY(i), N.getZ(i)], o * 3);
        if (C) col.set([C.getX(i), C.getY(i), C.getZ(i)], o * 3);
      }
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return out;
  };
  const body = merge(parts);
  const eyes: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    const g = new THREE.SphereGeometry(0.008, 5, 4).toNonIndexed();
    g.translate(s * 0.024, 0.072, 0.12);
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 3), 3));
    eyes.push(g);
  }
  return { body, eyes: merge(eyes) };
}
