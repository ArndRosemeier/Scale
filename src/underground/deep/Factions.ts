/**
 * The slimes of the deep realm — two peoples in a war that never ends — and the few that come up
 * into the city (the Lumen answering the player's call, the Murk breaking out).
 *
 *  - Lumen (soft, glowing teal, green, blue, amber): dwellers wandering their Hall and slipping in
 *    and out of their domes, tenders in the Gardens, carriers bringing things to the Archive, the
 *    council sitting in its ring pulsing in turn, children round the nursery, sentries in the
 *    trench (in the Warrens' mouth) lobbing glowing bolts at the Murk coming over no-man's land (and fighting them
 *    hand to hand in the gaps), caravans on the roads, captives pulsing weakly in the Murk's pens.
 *    Shy of strangers (they hide in their domes), wary of acquaintances, greeting friends.
 *  - Murk (dark red, spiked, ember cores, glaring eyes): drones crawling the Warrens, jailers by the
 *    pens, brutes, raiders climbing the Throat to the Front (held up by the thorn wire), and the Maw
 *    by the Heart. They go for the player on sight, before any Lumen: lunges, and brutes and the Maw
 *    spit. Every Murk is a ThreatActor, so every power, Tab-targeting and the target frame work on them.
 *
 * Agents exist only in the areas near the player (spawned from the war's state, dropped when far);
 * they walk on the field's floors, turn aside at rock, follow the waypoint graph between places.
 * Two instanced batches each (shell, core): Lumen blobs and spiked Murk.
 */
import * as THREE from 'three';
import { blobGeometry } from '../Slimes';
import type { DeepField } from './field';
import type { DeepPlan, NavNode } from './plan';
import { LUMEN_COL, MURK_COL } from './mesher';
import type { DamageResult, DamageSource, ThreatActor, ThreatZone } from '../../game/threats/ThreatEvent';

export type Fac = 'lumen' | 'murk';
export type Role =
  | 'dweller' | 'tender' | 'carrier' | 'council' | 'child' | 'guard' | 'sentry' | 'caravan' | 'captive' | 'support'
  | 'drone' | 'raider' | 'brute' | 'jailer' | 'maw' | 'breacher';
type Mode = 'idle' | 'move' | 'hide' | 'hidden' | 'fight' | 'flee' | 'dead' | 'greet' | 'follow' | 'free' | 'go';

export interface Blob {
  id: number;
  fac: Fac;
  role: Role;
  x: number; y: number; z: number;
  yaw: number;
  r: number;
  hp: number; maxHp: number;
  mode: Mode;
  tx: number; tz: number;
  path: number[];
  wait: number;
  t: number;
  ph: number;
  col: [number, number, number];
  glow: number;
  area: string;
  foe: Blob | null;
  cd: number;
  stretch: number;
  /** Seconds of a lunge left (stretched forward). */
  lunge: number;
  actor: MurkActor | null;
  /** On the city's surface (support, breach): the ground, not the field. */
  surface: boolean;
  vy: number;
  /** Where it hides (a dwelling door). */
  den: { x: number; y: number; z: number } | null;
  /** Lifetime left (support, splats) or Infinity. */
  ttl: number;
  /** Seat in the council ring / place in a group. */
  seat: number;
  /** Hit flash 0..1. */
  flash: number;
  /** Something to do on the surface (support): a target id to hold, the spot to return to. */
  task: SupportTask | null;
  /** Velocity over the last frames (m/s; sentries lead their shots by it). */
  vx: number; vz: number;
  /** Following a path: nearest it has come to the waypoint, seconds since it got any nearer. */
  best: number; bestT: number;
}

/** A Lumen called to the surface: what it does (the game resolves the target by kind and object). */
export interface SupportTask { kind: 'hold' | 'douse' | 'fight' | 'return'; x: number; y: number; z: number; obj: object | null; home: { x: number; y: number; z: number } }

export interface Drop { x: number; y: number; z: number; vx: number; vy: number; vz: number; r: number; col: [number, number, number]; life: number; murk: boolean }
interface Spit { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; dmg: number; from: Blob }
/** A Lumen sentry's glowing bolt, lobbed at a Murk. */
interface Bolt { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; col: [number, number, number] }

/** What the factions need from the game. */
export interface FactionHost {
  field: DeepField;
  plan: DeepPlan;
  /** The player (feet), body height, horizontal speed (m/s), whether it can be seen (not hidden by size, flying fast …). */
  player(): { x: number; y: number; z: number; h: number; speed: number };
  hurtPlayer(dmg: number, fromX: number, fromZ: number): void;
  /** Knock the player back (impulse as a velocity change). */
  shovePlayer(vx: number, vy: number, vz: number): void;
  sound(id: string, x: number, y: number, z: number, gain: number, pitch?: number): void;
  /** Ground under (x, z) near height y (surface agents). */
  ground(x: number, z: number, y: number): number;
  /** The Lumen's trust in the player (−100 … 100). */
  trust(): number;
  /** Line of sight in the caves (or anywhere for surface agents). */
  clear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean;
  /** Something died / was hurt: credit, war, trust. */
  onKill(b: Blob, byPlayer: boolean): void;
  onLumenHurt(b: Blob, byPlayer: boolean): void;
  /** A blob splashed on the city's surface: a puddle of glow (support) or ooze (Murk). */
  onSplat?(x: number, y: number, z: number, murk: boolean): void;
}

/** Stats per role: radius, hit points, walk speed, damage of a lunge. */
const ROLE: Record<Role, { r: [number, number]; hp: number; speed: number; dmg: number }> = {
  dweller: { r: [0.2, 0.34], hp: 1.5, speed: 0.55, dmg: 0 },
  tender: { r: [0.18, 0.3], hp: 1.5, speed: 0.5, dmg: 0 },
  carrier: { r: [0.2, 0.3], hp: 1.5, speed: 0.75, dmg: 0 },
  council: { r: [0.36, 0.5], hp: 3, speed: 0.4, dmg: 0 },
  child: { r: [0.1, 0.16], hp: 0.8, speed: 0.9, dmg: 0 },
  guard: { r: [0.4, 0.62], hp: 9, speed: 1.6, dmg: 2.2 },
  sentry: { r: [0.36, 0.5], hp: 9, speed: 1.2, dmg: 3.6 },
  caravan: { r: [0.22, 0.34], hp: 2, speed: 0.9, dmg: 0 },
  captive: { r: [0.18, 0.28], hp: 1, speed: 1.4, dmg: 0 },
  support: { r: [0.28, 0.42], hp: 6, speed: 7, dmg: 0 },
  drone: { r: [0.3, 0.45], hp: 2.2, speed: 2.4, dmg: 5 },
  raider: { r: [0.35, 0.52], hp: 3.2, speed: 2.8, dmg: 6 },
  brute: { r: [0.8, 1.1], hp: 14, speed: 1.9, dmg: 13 },
  jailer: { r: [0.5, 0.65], hp: 5, speed: 2.0, dmg: 8 },
  maw: { r: [2.6, 2.6], hp: 420, speed: 1.6, dmg: 24 },
  breacher: { r: [0.32, 0.5], hp: 2.6, speed: 3.2, dmg: 4 },
};

const MAX = 420;
/** Murk notice the player within (m), give up beyond, drop a Lumen for the player within; Lumen strangers hide within. */
const AGGRO = 24, LEASH = 40, SWITCH = 10, SHY = 9;
/** Sentries: shoot at Murk within (m), every so many seconds, a bolt's damage (and splash); hand to hand within. */
export const SENTRY = { range: 22, cd: [2.4, 4.0] as [number, number], dmg: 0.5, splash: 0.3, melee: 2.4, scatter: 0.35, scatterK: 0.045 };
/** The thorn wire holds the Murk up: their speed in it. */
const WIRE_SLOW = 0.35;

export class Factions {
  readonly group = new THREE.Group();
  readonly blobs: Blob[] = [];
  readonly drops: Drop[] = [];
  private spits: Spit[] = [];
  private bolts: Bolt[] = [];
  private lShell: THREE.InstancedMesh;
  private lCore: THREE.InstancedMesh;
  private mShell: THREE.InstancedMesh;
  private mCore: THREE.InstancedMesh;
  private mEyes: THREE.InstancedMesh;
  private nextId = 1;
  private frame = 0;
  time = 0;
  /** Areas with agents now (key → spawned at). */
  readonly areas = new Map<string, number>();
  /** Nav graph adjacency. */
  private adj: number[][] = [];
  /** Statistics for tests. */
  stats = { lumen: 0, murk: 0, fights: 0, kills: 0, spits: 0, bolts: 0, boltHits: 0 };

  constructor(readonly host: FactionHost) {
    const g = blobGeometry();
    const mg = spikedGeometry();
    const shellMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.62, depthWrite: false });
    const coreMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending });
    const murkShell = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.92 });
    this.lCore = new THREE.InstancedMesh(g, coreMat, MAX);
    this.lShell = new THREE.InstancedMesh(g, shellMat, MAX);
    this.mShell = new THREE.InstancedMesh(mg, murkShell, MAX);
    this.mCore = new THREE.InstancedMesh(g, coreMat, MAX);
    this.mEyes = new THREE.InstancedMesh(eyesGeometry(), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX);
    for (const m of [this.lCore, this.lShell, this.mShell, this.mCore, this.mEyes]) {
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
      m.count = 0;
      m.frustumCulled = false;
      this.group.add(m);
    }
    this.lCore.renderOrder = 4; this.lShell.renderOrder = 5; this.mCore.renderOrder = 5;
    const P = host.plan;
    this.adj = P.nodes.map(() => []);
    for (const [a, b] of P.edges) { this.adj[a].push(b); this.adj[b].push(a); }
  }

  // ------------------------------------------------------------------ spawning

  spawn(fac: Fac, role: Role, x: number, y: number, z: number, area: string, surface = false): Blob {
    const S = ROLE[role];
    const r = S.r[0] + Math.random() * (S.r[1] - S.r[0]);
    const pal = fac === 'lumen' ? LUMEN_COL : MURK_COL;
    const b: Blob = {
      id: this.nextId++, fac, role, x, y, z, yaw: Math.random() * 6.28, r, hp: S.hp * (r / S.r[1]) * 1.2, maxHp: S.hp * (r / S.r[1]) * 1.2,
      mode: 'idle', tx: x, tz: z, path: [], wait: Math.random() * 3, t: 0, ph: Math.random() * 6, col: pal[Math.floor(Math.random() * pal.length)],
      glow: 0.8, area, foe: null, cd: Math.random(), stretch: 0, lunge: 0, actor: null, surface, vy: 0, den: null, ttl: Infinity, seat: 0, flash: 0, task: null,
      vx: 0, vz: 0, best: Infinity, bestT: 0,
    };
    if (role === 'maw') { b.hp = b.maxHp = S.hp; b.col = [1.0, 0.22, 0.18]; }
    if (fac === 'murk') b.actor = new MurkActor(b, this);
    this.blobs.push(b);
    return b;
  }

  /** Remove every agent of an area. */
  despawn(area: string): void {
    for (let i = this.blobs.length - 1; i >= 0; i--) if (this.blobs[i].area === area) this.blobs.splice(i, 1);
    this.areas.delete(area);
  }

  /** Nearest graph node to a point (optionally within a name prefix). */
  nodeNear(x: number, y: number, z: number, prefix?: string): number {
    let best = -1, bd = Infinity;
    for (const n of this.host.plan.nodes) {
      if (prefix && !n.name.startsWith(prefix)) continue;
      const d = Math.hypot(n.x - x, (n.y - y) * 2, n.z - z);
      if (d < bd) { bd = d; best = n.id; }
    }
    return best;
  }

  /** Shortest hop path between nodes (BFS). */
  route(a: number, b: number): number[] {
    if (a < 0 || b < 0) return [];
    const prev = new Int32Array(this.adj.length).fill(-1);
    prev[a] = a;
    const q = [a];
    while (q.length) {
      const n = q.shift()!;
      if (n === b) break;
      for (const m of this.adj[n]) if (prev[m] < 0) { prev[m] = n; q.push(m); }
    }
    if (prev[b] < 0) return [];
    const out: number[] = [];
    for (let n = b; n !== a; n = prev[n]) out.push(n);
    out.reverse();
    return out;
  }

  /** Send a blob along the graph to a node (then to its exact spot). */
  goTo(b: Blob, node: number): void {
    const from = this.nodeNear(b.x, b.y, b.z);
    b.path = this.route(from, node);
    b.mode = 'go';
    this.nextWaypoint(b);
  }

  private nextWaypoint(b: Blob): boolean {
    const n = b.path.shift();
    if (n === undefined) return false;
    const N = this.host.plan.nodes[n];
    b.best = Infinity; b.bestT = 0;
    b.tx = N.x + (Math.random() - 0.5) * Math.min(3, N.r);
    b.tz = N.z + (Math.random() - 0.5) * Math.min(3, N.r);
    return true;
  }

  // ------------------------------------------------------------------ update

  update(dt: number, cam: THREE.Vector3): void {
    this.time += dt;
    this.frame++;
    const P = this.host.player();
    const trust = this.host.trust();
    let nl = 0, nm = 0;
    for (const b of this.blobs) {
      if (b.mode === 'dead') continue;
      const far = Math.hypot(b.x - P.x, b.z - P.z) > 70;
      // Far ones think every fourth frame (with four frames' time).
      if (far && (b.id + this.frame) % 4 !== 0) continue;
      const h = far ? dt * 4 : dt;
      b.t += h;
      b.cd -= h;
      b.lunge = Math.max(0, b.lunge - h);
      b.flash = Math.max(0, b.flash - h * 3);
      if (b.ttl !== Infinity) { b.ttl -= h; if (b.ttl <= 0) { b.mode = 'dead'; continue; } }
      const ox = b.x, oz = b.z;
      if (b.fac === 'lumen') { this.lumen(b, h, P, trust); nl++; } else { this.murk(b, h, P); nm++; }
      const k = Math.min(1, h * 4);
      b.vx += ((b.x - ox) / h - b.vx) * k; b.vz += ((b.z - oz) / h - b.vz) * k;
    }
    this.stats.lumen = nl; this.stats.murk = nm;
    for (let i = this.blobs.length - 1; i >= 0; i--) if (this.blobs[i].mode === 'dead') this.blobs.splice(i, 1);
    this.updateDrops(dt);
    this.updateSpits(dt, P);
    this.updateBolts(dt);
    this.draw(cam);
  }

  private lumen(b: Blob, dt: number, P: { x: number; y: number; z: number; h: number; speed: number }, trust: number): void {
    const dp = Math.hypot(b.x - P.x, b.z - P.z), dy = Math.abs(b.y - P.y);
    const pal = 0.8;
    if (b.role === 'sentry') { this.sentry(b, dt); return; }
    // Danger: a Murk close by — guards go for it, the rest flee home.
    if (b.mode !== 'hidden' && b.mode !== 'fight' && (b.t * 3 + b.id) % 1 < dt * 3) {
      const m = this.nearest(b, 'murk', b.role === 'guard' || b.role === 'support' ? 14 : 6);
      if (m) {
        if (b.role === 'guard' || b.role === 'support') { b.foe = m; b.mode = 'fight'; }
        else if (b.role !== 'captive') this.flee(b, m.x, m.z);
      }
    }
    switch (b.mode) {
      case 'fight': {
        const f = b.foe;
        if (!f || f.mode === 'dead' || f.hp <= 0) { b.foe = null; b.mode = 'idle'; b.wait = 0.5; break; }
        b.tx = f.x; b.tz = f.z;
        const d = Math.hypot(f.x - b.x, f.z - b.z);
        if (d > b.r + f.r + 0.25) this.walk(b, dt, ROLE[b.role].speed * 1.4);
        else this.clash(b, f);
        b.glow += (1.2 - b.glow) * Math.min(1, dt * 3);
        if (b.role === 'guard' && b.den && Math.hypot(b.x - b.den.x, b.z - b.den.z) > 26) { b.foe = null; b.mode = 'go'; b.tx = b.den.x; b.tz = b.den.z; }
        return;
      }
      case 'flee': case 'hide': {
        b.glow += (0.25 - b.glow) * Math.min(1, dt * 4);
        if (this.walk(b, dt, ROLE[b.role].speed * 2.6)) { b.mode = b.den ? 'hidden' : 'idle'; b.wait = 20 + Math.random() * 30; }
        return;
      }
      case 'hidden': {
        b.wait -= dt;
        // Out again once the stranger has gone (or stood very still a long time) and no Murk is near.
        if (b.wait <= 0 && (dp > SHY + 6 || trust >= 10) && !this.nearest(b, 'murk', 12)) { b.mode = 'idle'; b.wait = 1 + Math.random() * 3; }
        return;
      }
      case 'free': {
        // Freed captives: off up the Throat to the Hall.
        b.glow += (1 - b.glow) * Math.min(1, dt);
        if (this.walk(b, dt, ROLE.captive.speed * 1.6) && !this.nextWaypoint(b)) { b.mode = 'dead'; }
        return;
      }
      default: break;
    }
    if (b.role === 'captive') {
      // Pulsing weakly in the pen, edging about.
      b.glow = 0.35 + 0.15 * Math.sin(b.t * 1.3 + b.ph);
      if (b.wait > 0) { b.wait -= dt; return; }
      if (this.walk(b, dt, 0.25)) { const c = b.den!; const a = Math.random() * 6.28; b.tx = c.x + Math.cos(a) * 1.3; b.tz = c.z + Math.sin(a) * 1.3; b.wait = 2 + Math.random() * 3; }
      return;
    }
    if (b.role === 'support') { this.support(b, dt, P); return; }
    // The player: strangers hide; acquaintances keep their distance; friends greet.
    if (!b.surface && dy < 4 && dp < SHY && b.role !== 'guard') {
      if (trust < 10) {
        if (b.den) { b.mode = 'hide'; b.tx = b.den.x; b.tz = b.den.z; }
        else this.flee(b, P.x, P.z);
        this.host.sound('slime_squish', b.x, b.y, b.z, 0.3, 1.3);
        return;
      }
      if (trust < 30 && dp < 3.5 && P.speed > 1.5) { this.flee(b, P.x, P.z); b.wait = 2; return; }
      if (trust >= 30 && b.mode !== 'greet' && b.cd <= 0 && dp < 5 && Math.random() < dt * 0.25) {
        b.mode = 'greet'; b.wait = 2.5; b.cd = 25;
        b.tx = P.x + (b.x - P.x) / dp * 1.2; b.tz = P.z + (b.z - P.z) / dp * 1.2;
        this.host.sound('lumen_chime', b.x, b.y, b.z, 0.35, 0.9 + Math.random() * 0.3);
      }
    }
    if (b.mode === 'greet') {
      b.glow += (1.25 - b.glow) * Math.min(1, dt * 2);
      if (this.walk(b, dt, 0.9)) { b.stretch = Math.min(1, b.stretch + dt * 1.2); b.wait -= dt; if (b.wait <= 0) { b.mode = 'idle'; b.stretch = 0; } }
      return;
    }
    // Children follow a friend for a while.
    if (b.role === 'child' && trust >= 30 && dp < 7 && dp > 1.6 && dy < 3) { b.tx = P.x; b.tz = P.z; this.walk(b, dt, 1.4); return; }
    b.glow += (pal - b.glow) * Math.min(1, dt * 1.5);
    if (b.wait > 0) { b.wait -= dt; return; }
    if (b.mode === 'go') {
      if (this.walk(b, dt, ROLE[b.role].speed)) { if (!this.nextWaypoint(b)) { b.mode = 'idle'; b.wait = 1 + Math.random() * 4; } }
      return;
    }
    if (b.mode === 'move') {
      if (this.walk(b, dt, ROLE[b.role].speed)) { b.mode = 'idle'; b.wait = this.pause(b); }
      return;
    }
    // Idle: pick the next errand.
    this.errand(b);
  }

  /**
   * A sentry in the trench: holds its spot; a Murk in reach is fought hand to hand, one coming over
   * no-man's land gets a glowing bolt lobbed at it (led by its pace, never quite sure).
   */
  private sentry(b: Blob, dt: number): void {
    const home = b.den ?? { x: b.x, y: b.y, z: b.z };
    const m = this.nearest(b, 'murk', SENTRY.range, 8);
    b.glow += ((m ? 1.15 : 0.85) - b.glow) * Math.min(1, dt * 2);
    // Hand to hand only on its own level (in the bay or the gap): over the parapet it shoots.
    if (m && Math.hypot(m.x - b.x, m.z - b.z) < SENTRY.melee + m.r && Math.abs(m.y - b.y) < 0.5 && Math.hypot(m.x - home.x, m.z - home.z) < 4) {
      b.tx = m.x; b.tz = m.z;
      if (Math.hypot(m.x - b.x, m.z - b.z) > b.r + m.r + 0.25) this.walk(b, dt, ROLE.sentry.speed * 1.5);
      else this.clash(b, m);
      return;
    }
    if (m && b.cd <= 0 && b.lunge <= 0) {
      b.cd = SENTRY.cd[0] + Math.random() * (SENTRY.cd[1] - SENTRY.cd[0]);
      this.shoot(b, m);
      return;
    }
    // Back to its spot; shuffling a little.
    if (b.wait > 0) { b.wait -= dt; return; }
    b.tx = home.x; b.tz = home.z;
    if (Math.hypot(home.x - b.x, home.z - b.z) > 0.6) { if (!this.walk(b, dt, ROLE.sentry.speed)) return; }
    b.wait = 1 + Math.random() * 3;
    const a = Math.random() * 6.28;
    b.tx = home.x + Math.cos(a) * 0.4; b.tz = home.z + Math.sin(a) * 0.4;
    b.yaw = Math.atan2((m?.z ?? b.z + Math.sin(b.yaw)) - b.z, (m?.x ?? b.x + Math.cos(b.yaw)) - b.x);
  }

  /** A sentry's bolt: up over the parapet and down on where the Murk will be. */
  private shoot(b: Blob, m: Blob): void {
    const sx = b.x, sy = b.y + b.r * 2 + 0.9, sz = b.z;
    const d0 = Math.hypot(m.x - sx, m.z - sz);
    const T = Math.max(0.6, Math.min(2.1, d0 / 13));
    const err = SENTRY.scatter + d0 * SENTRY.scatterK;
    const tx = m.x + m.vx * T + (Math.random() - 0.5) * 2 * err, tz = m.z + m.vz * T + (Math.random() - 0.5) * 2 * err;
    const ty = m.y + m.r * 0.5;
    this.bolts.push({ x: sx, y: sy, z: sz, vx: (tx - sx) / T, vy: (ty - sy) / T + 4.9 * T, vz: (tz - sz) / T, life: T + 1.5, col: b.col });
    b.lunge = 0.3;
    b.stretch = 0.6;
    b.yaw = Math.atan2(m.z - b.z, m.x - b.x);
    this.stats.bolts++;
    this.host.sound('murk_spit', sx, sy, sz, 0.35, 1.7 + Math.random() * 0.3);
  }

  private updateBolts(dt: number): void {
    const F = this.host.field;
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const o = this.bolts[i];
      o.vy -= 9.8 * dt;
      o.x += o.vx * dt; o.y += o.vy * dt; o.z += o.vz * dt;
      o.life -= dt;
      let hit: Blob | null = null;
      for (const m of this.blobs) {
        if (m.fac !== 'murk' || m.mode === 'dead' || m.surface) continue;
        if (Math.abs(m.x - o.x) < m.r + 0.5 && Math.abs(m.z - o.z) < m.r + 0.5 && Math.hypot(m.x - o.x, m.y + m.r * 0.6 - o.y, m.z - o.z) < m.r + 0.45) { hit = m; break; }
      }
      const rock = !hit && o.vy < 0 && F.near(o.x, o.y, o.z) && F.sdf(o.x, o.y, o.z) > 0;
      if (!hit && !rock && o.life > 0) continue;
      if (hit) { this.stats.boltHits++; this.hurt(hit, SENTRY.dmg, false, o.x - o.vx * 0.05, o.z - o.vz * 0.05); }
      // A splash of glow: the Murk close by are burnt a little too.
      for (const m of this.blobs) {
        if (m === hit || m.fac !== 'murk' || m.mode === 'dead' || m.surface) continue;
        if (Math.hypot(m.x - o.x, m.y - o.y, m.z - o.z) < m.r + 0.9) this.hurt(m, SENTRY.splash, false, o.x, o.z);
      }
      for (let k = 0; k < 6; k++) this.drops.push({ x: o.x, y: o.y, z: o.z, vx: (Math.random() - 0.5) * 3, vy: 0.5 + Math.random() * 2, vz: (Math.random() - 0.5) * 3, r: 0.05, col: o.col, life: 4, murk: false });
      this.host.sound('slime_squish', o.x, o.y, o.z, 0.4, 1.5);
      this.bolts.splice(i, 1);
    }
  }

  /** In the thorn wire at the Front? */
  private inWire(x: number, y: number, z: number): boolean {
    const T = this.host.plan.trench;
    if (!T || Math.abs(y - T.y) > 3) return false;
    const s = (x - T.x) * T.ax + (z - T.z) * T.az;
    return s > T.wire[0] && s < T.wire[1] && Math.abs((x - T.x) * T.cx + (z - T.z) * T.cz) < 9;
  }

  private pause(b: Blob): number {
    switch (b.role) {
      case 'council': return 6 + Math.random() * 10;
      case 'tender': return 3 + Math.random() * 5;
      case 'guard': return 2 + Math.random() * 4;
      default: return 1.5 + Math.random() * 5;
    }
  }

  private errand(b: Blob): void {
    const P = this.host.plan;
    const pick = (name: string, r = 3) => { const p = P.places[name]; if (!p) return false; const a = Math.random() * 6.28, d = Math.sqrt(Math.random()) * r; b.tx = p.x + Math.cos(a) * d; b.tz = p.z + Math.sin(a) * d; b.mode = 'move'; return true; };
    switch (b.role) {
      case 'dweller': {
        const r = Math.random();
        if (r < 0.35 && b.den) { b.tx = b.den.x; b.tz = b.den.z; b.mode = 'move'; return; }
        if (r < 0.55) { const d = P.dwellings[Math.floor(Math.random() * P.dwellings.length)]; if (d) { b.tx = d.x + Math.sin(d.yaw) * (d.r + 1); b.tz = d.z + Math.cos(d.yaw) * (d.r + 1); b.mode = 'move'; return; } }
        if (r < 0.7) { pick('pool', 9); return; }
        if (r < 0.8) { pick('spire', 7); return; }
        const t = this.nodeNear(b.x + (Math.random() - 0.5) * 50, b.y, b.z + (Math.random() - 0.5) * 50, 'terrace');
        if (t >= 0) this.goTo(b, t);
        return;
      }
      case 'tender': pick(b.area === 'lake' ? 'lake' : 'gardens', b.area === 'lake' ? 10 : 16); return;
      case 'carrier': {
        if (b.seat === 0) { b.seat = 1; this.goTo(b, this.nodeNear(P.places.archive?.x ?? b.x, P.places.archive?.y ?? b.y, P.places.archive?.z ?? b.z, 'archive')); }
        else { b.seat = 0; const d = P.dwellings[Math.floor(Math.random() * P.dwellings.length)]; if (d) { b.tx = d.x + Math.sin(d.yaw) * (d.r + 1); b.tz = d.z + Math.cos(d.yaw) * (d.r + 1); b.mode = 'move'; } }
        return;
      }
      case 'council': {
        const c = P.places.council;
        if (!c) return;
        const a = (b.seat / 9) * Math.PI * 2;
        b.tx = c.x + Math.cos(a) * 2.6; b.tz = c.z + Math.sin(a) * 2.6; b.mode = 'move';
        return;
      }
      case 'child': pick('nursery', 5); return;
      case 'guard': {
        if (b.den) { const a = Math.random() * 6.28; b.tx = b.den.x + Math.cos(a) * 2.5; b.tz = b.den.z + Math.sin(a) * 2.5; b.mode = 'move'; }
        return;
      }
      case 'caravan': {
        // Up and down their road.
        const gate = this.nodeNear(b.x, b.y, b.z, 'gate'), hall = this.nodeNear(P.places.hall.x, P.places.hall.y, P.places.hall.z, 'hall');
        this.goTo(b, b.seat++ % 2 === 0 ? hall : gate);
        b.wait = 4 + Math.random() * 8;
        return;
      }
      default: return;
    }
  }

  private flee(b: Blob, fx: number, fz: number): void {
    if (b.den) { b.mode = 'hide'; b.tx = b.den.x; b.tz = b.den.z; return; }
    const d = Math.hypot(b.x - fx, b.z - fz) || 1;
    b.mode = 'flee';
    b.tx = b.x + ((b.x - fx) / d) * 8; b.tz = b.z + ((b.z - fz) / d) * 8;
  }

  private murk(b: Blob, dt: number, P: { x: number; y: number; z: number; h: number; speed: number }): void {
    const dp = Math.hypot(b.x - P.x, b.z - P.z), dy = Math.abs(b.y + b.r - (P.y + P.h * 0.4));
    const S = ROLE[b.role];
    b.glow += ((b.mode === 'fight' ? 1.3 : 0.75) - b.glow) * Math.min(1, dt * 2);
    // Pick a fight: the player first, whenever in reach and in sight (dropping a Lumen for them when
    // they come close), else the nearest Lumen.
    if ((b.mode !== 'fight' || (b.foe && dp < SWITCH)) && (b.t * 4 + b.id * 0.37) % 1 < dt * 4) {
      const sees = dp < (b.mode === 'fight' ? SWITCH : AGGRO * (b.role === 'maw' ? 1.6 : 1)) && dy < 8 && this.host.clear(b.x, b.y + b.r, b.z, P.x, P.y + P.h * 0.6, P.z);
      if (sees) { b.foe = null; b.mode = 'fight'; if (b.cd < 0.3) this.host.sound(b.role === 'maw' ? 'maw_roar' : 'murk_growl', b.x, b.y, b.z, b.role === 'maw' ? 1 : 0.55, b.role === 'brute' ? 0.7 : 1 + Math.random() * 0.3); b.cd = 0.6; }
      else if (b.mode !== 'fight') {
        const l = this.nearest(b, 'lumen', b.role === 'raider' || b.role === 'breacher' ? 16 : 9);
        if (l && l.role !== 'captive' && l.mode !== 'hidden') { b.foe = l; b.mode = 'fight'; }
      }
    }
    if (b.mode === 'fight') {
      const f = b.foe;
      if (f) {
        // A Lumen.
        if (f.mode === 'dead' || f.hp <= 0 || f.mode === 'hidden') { b.foe = null; b.mode = 'idle'; return; }
        b.tx = f.x; b.tz = f.z;
        const d = Math.hypot(f.x - b.x, f.z - b.z);
        if (d > b.r + f.r + 0.2) this.walk(b, dt, S.speed);
        else this.clash(b, f);
        return;
      }
      // The player.
      if (dp > LEASH || dy > 10) { b.mode = 'idle'; b.wait = 1; return; }
      b.tx = P.x; b.tz = P.z;
      const reach = b.r + 0.6 + (b.role === 'maw' ? 2.5 : 0);
      if ((b.role === 'brute' || b.role === 'maw' || b.role === 'jailer') && dp > reach + 2 && dp < 22 && b.cd <= 0) {
        // Spit at range (in sight).
        if (this.host.clear(b.x, b.y + b.r * 1.2, b.z, P.x, P.y + P.h * 0.6, P.z)) {
          this.spit(b, P.x, P.y + P.h * 0.55, P.z);
          b.cd = b.role === 'maw' ? 1.4 : 2.6;
          return;
        }
      }
      if (dp > reach) { this.walk(b, dt, S.speed * (b.lunge > 0 ? 2.5 : 1)); if (dp < reach + 2.2 && b.cd <= 0 && b.lunge <= 0) { b.lunge = 0.35; } return; }
      if (b.cd <= 0) {
        b.cd = b.role === 'maw' ? 2.2 : 1.1 + Math.random() * 0.6;
        b.lunge = 0.3;
        this.host.hurtPlayer(S.dmg, b.x, b.z);
        const k = b.role === 'maw' ? 9 : b.role === 'brute' ? 5 : 1.5;
        this.host.shovePlayer(((P.x - b.x) / (dp || 1)) * k, k * 0.4, ((P.z - b.z) / (dp || 1)) * k);
        this.host.sound(b.role === 'maw' || b.role === 'brute' ? 'murk_slam' : 'slime_squish', b.x, b.y, b.z, 0.7, b.role === 'drone' ? 0.8 : 0.6);
      }
      return;
    }
    if (b.wait > 0) { b.wait -= dt; return; }
    if (b.mode === 'go') {
      // Going over the top at the Front: a charge.
      const charge = b.area === 'push' || b.area === 'raid' ? 1.25 : 0.8;
      if (this.walk(b, dt, S.speed * charge)) { if (!this.nextWaypoint(b)) { b.mode = 'idle'; b.wait = 1 + Math.random() * 2; } }
      return;
    }
    if (b.mode === 'move') { if (this.walk(b, dt, S.speed * 0.5)) { b.mode = 'idle'; b.wait = 1 + Math.random() * 4; } return; }
    // Idle: prowl round where it belongs.
    const home = b.den ?? { x: b.x, y: b.y, z: b.z };
    const r = b.role === 'jailer' ? 4 : b.role === 'maw' ? 7 : b.role === 'raider' ? 6 : 14;
    const a = Math.random() * 6.28, d = Math.sqrt(Math.random()) * r;
    b.tx = home.x + Math.cos(a) * d; b.tz = home.z + Math.sin(a) * d; b.mode = 'move';
  }

  /** Lumen at the surface helping the player (tasks set by the game: hold someone, douse, fight; then go home). */
  private support(b: Blob, dt: number, _P: { x: number; y: number; z: number }): void {
    const T = b.task;
    b.glow = 1.1 + 0.2 * Math.sin(b.t * 6 + b.ph);
    if (!T) { b.mode = 'dead'; return; }
    if (T.kind === 'fight' && b.foe && b.foe.mode !== 'dead') {
      b.tx = b.foe.x; b.tz = b.foe.z;
      if (Math.hypot(b.foe.x - b.x, b.foe.z - b.z) > b.r + b.foe.r + 0.2) this.walk(b, dt, ROLE.support.speed);
      else this.clash(b, b.foe);
      return;
    }
    const tx = T.kind === 'return' ? T.home.x : T.x, tz = T.kind === 'return' ? T.home.z : T.z;
    b.tx = tx; b.tz = tz;
    const arrived = this.walk(b, dt, ROLE.support.speed * (T.kind === 'return' ? 0.8 : 1));
    if (T.kind === 'return' && arrived) { b.mode = 'dead'; return; }
    if (arrived) { b.stretch = Math.min(1, b.stretch + dt * 2); b.wait += dt; }
  }

  /** One exchange of a fight between two blobs in contact. */
  private clash(a: Blob, f: Blob): void {
    if (a.cd > 0) return;
    a.cd = 0.7 + Math.random() * 0.5;
    a.lunge = 0.25;
    const dmg = Math.max(0.6, ROLE[a.role].dmg * 0.35) * (0.7 + Math.random() * 0.6);
    this.stats.fights++;
    this.hurt(f, dmg, false, a.x, a.z);
    if (Math.random() < 0.4) this.host.sound('slime_squish', f.x, f.y, f.z, 0.45, a.fac === 'murk' ? 0.7 : 1.2);
  }

  /** Damage a blob (by the player or another blob); splats at 0. */
  hurt(b: Blob, dmg: number, byPlayer: boolean, fx: number, fz: number): void {
    if (b.mode === 'dead' || dmg <= 0) return;
    b.hp -= dmg;
    b.flash = 1;
    if (b.fac === 'lumen') this.host.onLumenHurt(b, byPlayer);
    if (b.hp <= 0) { this.splat(b, fx, fz); this.stats.kills++; this.host.onKill(b, byPlayer); return; }
    // A Murk hit by the player turns on them.
    if (b.fac === 'murk' && byPlayer && b.mode !== 'fight') { b.mode = 'fight'; b.foe = null; }
  }

  private splat(b: Blob, fx: number, fz: number): void {
    b.mode = 'dead';
    const n = b.role === 'maw' ? 22 : 5 + Math.floor(b.r * 6);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, sp = 1.5 + Math.random() * 3 * Math.sqrt(b.r);
      const away = Math.atan2(b.z - fz, b.x - fx);
      const aa = Math.random() < 0.6 ? away + (Math.random() - 0.5) * 1.6 : a;
      this.drops.push({ x: b.x, y: b.y + b.r * 0.6, z: b.z, vx: Math.cos(aa) * sp, vy: 1.5 + Math.random() * 3, vz: Math.sin(aa) * sp, r: b.r * (0.18 + Math.random() * 0.22), col: b.col, life: 0, murk: b.fac === 'murk' });
    }
    this.host.sound('slime_squish', b.x, b.y, b.z, Math.min(1, 0.5 + b.r), b.fac === 'murk' ? 0.65 : 1.1);
    if (b.surface) this.host.onSplat?.(b.x, b.y, b.z, b.fac === 'murk');
  }

  private spit(b: Blob, x: number, y: number, z: number): void {
    const sx = b.x, sy = b.y + b.r * 1.3, sz = b.z;
    const d = Math.hypot(x - sx, z - sz);
    const t = Math.max(0.35, d / 16);
    this.spits.push({ x: sx, y: sy, z: sz, vx: (x - sx) / t, vy: (y - sy) / t + 4.9 * t, vz: (z - sz) / t, life: 3, dmg: b.role === 'maw' ? 14 : 7, from: b });
    b.lunge = 0.3;
    this.stats.spits++;
    this.host.sound('murk_spit', sx, sy, sz, 0.6, b.role === 'maw' ? 0.7 : 1);
  }

  private updateSpits(dt: number, P: { x: number; y: number; z: number; h: number }): void {
    const F = this.host.field;
    for (let i = this.spits.length - 1; i >= 0; i--) {
      const s = this.spits[i];
      s.vy -= 9.8 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      s.life -= dt;
      const hitP = Math.hypot(s.x - P.x, s.z - P.z) < 0.7 && s.y > P.y - 0.2 && s.y < P.y + P.h + 0.2;
      const rock = F.near(s.x, s.y, s.z) ? F.sdf(s.x, s.y, s.z) > 0 : s.y < this.host.ground(s.x, s.z, s.y);
      if (hitP || rock || s.life <= 0) {
        if (hitP) { this.host.hurtPlayer(s.dmg, s.from.x, s.from.z); this.host.shovePlayer(s.vx * 0.2, 1.5, s.vz * 0.2); }
        for (let k = 0; k < 5; k++) this.drops.push({ x: s.x, y: s.y, z: s.z, vx: (Math.random() - 0.5) * 3, vy: Math.random() * 2, vz: (Math.random() - 0.5) * 3, r: 0.06, col: MURK_COL[0], life: 0, murk: true });
        this.host.sound('slime_squish', s.x, s.y, s.z, 0.5, 0.8);
        this.spits.splice(i, 1);
      }
    }
  }

  private updateDrops(dt: number): void {
    const F = this.host.field;
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.life += dt;
      if (d.vy !== 0 || d.vx !== 0) {
        d.vy -= 9.8 * dt;
        d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
        const fl = F.near(d.x, d.y, d.z) ? (F.floorAt(d.x, d.y + 0.5, d.z, 3) ?? d.y - 1) : this.host.ground(d.x, d.z, d.y);
        if (d.y <= fl) { d.y = fl; d.vx = d.vz = d.vy = 0; }
      }
      if (d.life > (d.murk ? 6 : 10)) this.drops.splice(i, 1);
    }
  }

  /** Nearest living blob of a faction within r (same level). */
  nearest(b: { x: number; y: number; z: number }, fac: Fac, r: number, dy = 4): Blob | null {
    let best: Blob | null = null, bd = r;
    for (const o of this.blobs) {
      if (o.fac !== fac || o.mode === 'dead' || o === b) continue;
      if (Math.abs(o.y - b.y) > dy) continue;
      const d = Math.hypot(o.x - b.x, o.z - b.z);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  /**
   * Step towards (tx, tz) on the floor; turn aside at rock and drops too deep to take. True on arrival.
   */
  private walk(b: Blob, dt: number, speed: number): boolean {
    const dx = b.tx - b.x, dz = b.tz - b.z, d = Math.hypot(dx, dz);
    if (d < 0.25) return true;
    // On a path, a waypoint it cannot quite reach (an edge, a corner) counts as reached when it has
    // come no nearer for a while.
    if (b.mode === 'go') {
      if (d < b.best - 0.3) { b.best = d; b.bestT = 0; } else if ((b.bestT += dt) > 2.5 && d < 4) { b.best = Infinity; b.bestT = 0; return true; }
    }
    // Gliding in soft surges.
    const surge = 0.6 + 0.4 * Math.max(0, Math.sin(b.t * 7 + b.ph));
    const st = Math.min(d, speed * surge * dt);
    const a0 = Math.atan2(dz, dx);
    if (b.surface) {
      b.x += Math.cos(a0) * st; b.z += Math.sin(a0) * st;
      const g = this.host.ground(b.x, b.z, b.y + 1);
      if (b.y > g + 0.05) { b.vy -= 9.8 * dt; b.y = Math.max(g, b.y + b.vy * dt); } else { b.y = g; b.vy = 0; }
      b.yaw = a0;
      return d - st < 0.25;
    }
    const F = this.host.field;
    // Murk caught in the thorn wire: slow, wriggling.
    const stw = b.fac === 'murk' && this.inWire(b.x, b.y, b.z) ? st * WIRE_SLOW : st;
    for (const off of [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6]) {
      const a = a0 + off;
      const nx = b.x + Math.cos(a) * stw, nz = b.z + Math.sin(a) * stw;
      const f = F.floorAt(nx, b.y + 1.2, nz, 5);
      if (f === null || f - b.y > 0.7 || f - b.y < -3) continue;
      if (!F.air(nx, f + Math.max(0.15, b.r * 0.8), nz, Math.min(0.2, b.r * 0.3))) continue;
      b.x = nx; b.z = nz;
      // Fall smoothly, climb at once.
      b.y = f < b.y ? Math.max(f, b.y - 6 * dt) : f;
      b.yaw = a;
      return d - st < 0.25;
    }
    // Stuck: give up on this target.
    b.wait = 0.5 + Math.random();
    if (b.mode === 'move' || b.mode === 'flee' || b.mode === 'hide') { b.mode = b.mode === 'hide' ? 'hidden' : 'idle'; }
    if (b.mode === 'go' && !this.nextWaypoint(b)) b.mode = 'idle';
    return false;
  }

  // ------------------------------------------------------------------ drawing

  private draw(cam: THREE.Vector3): void {
    let kl = 0, km = 0;
    for (const b of this.blobs) {
      if (b.mode === 'dead' || b.mode === 'hidden') continue;
      if (Math.hypot(b.x - cam.x, b.z - cam.z) > 140) continue;
      const moving = b.mode !== 'idle' || b.lunge > 0;
      const w = moving ? Math.sin(b.t * (b.mode === 'flee' || b.mode === 'fight' ? 12 : 7) + b.ph) : Math.sin(b.t * 1.6 + b.ph) * 0.4;
      let sy = 1 + w * 0.12 + b.stretch * 0.6, sx = 1 - w * 0.06 - b.stretch * 0.2;
      // A lunge: long and low forward.
      let lx = 0;
      if (b.lunge > 0) { const q = Math.sin((b.lunge / 0.35) * Math.PI); sx *= 1 + q * 0.35; sy *= 1 - q * 0.25; lx = q * b.r * 0.6; }
      if (b.mode === 'hide') { const dd = b.den ? Math.hypot(b.den.x - b.x, b.den.z - b.z) : 9; if (dd < 1) { const q = 1 - dd; sx *= 1 - q * 0.7; sy *= 1 - q * 0.6; } }
      let glow = b.glow + b.flash * 0.8;
      // The council pulses in turn: the one "speaking" glows up.
      if (b.role === 'council' && b.mode === 'idle') { const sp = Math.floor(this.time / 1.8) % 9; glow *= 0.8 + 0.2 * Math.sin(this.time * 2.2) + (b.seat === sp ? 0.5 * Math.max(0, Math.sin(((this.time % 1.8) / 1.8) * Math.PI)) : 0); }
      const x = b.x + Math.cos(b.yaw) * lx, z = b.z + Math.sin(b.yaw) * lx;
      _m.compose(_p.set(x, b.y, z), _q.setFromAxisAngle(_up, -b.yaw), _s.set(b.r * sx, b.r * sy, b.r * sx));
      if (b.fac === 'lumen') { if (kl < MAX) kl = this.put(this.lShell, this.lCore, kl, b.col, glow, false); }
      else if (km < MAX) {
        // Glaring eyes: brighter in a fight, a slow blink.
        const blink = Math.sin(this.time * 0.7 + b.ph * 3) > 0.985 ? 0.15 : 1;
        const e = (b.mode === 'fight' ? 1.0 : 0.7) * blink;
        this.mEyes.setMatrixAt(km, _m);
        _c.setRGB(1.0 * e, 0.42 * e, 0.08 * e);
        this.mEyes.setColorAt(km, _c);
        km = this.put(this.mShell, this.mCore, km, b.col, glow, true);
      }
    }
    for (const o of this.bolts) {
      if (kl >= MAX) break;
      _m.compose(_p.set(o.x, o.y, o.z), _q.identity(), _s.set(0.11, 0.11, 0.11));
      kl = this.put(this.lShell, this.lCore, kl, o.col, 1.6, false);
    }
    for (const d of this.drops) {
      if (kl >= MAX - 1 || km >= MAX - 1) break;
      const fade = Math.max(0, 1 - d.life / (d.murk ? 6 : 10));
      const flat = d.vx === 0 && d.vz === 0;
      _m.compose(_p.set(d.x, d.y, d.z), _q.identity(), _s.set(d.r * (flat ? 1.4 : 1), d.r * (flat ? 0.35 : 1), d.r * (flat ? 1.4 : 1)));
      if (d.murk) { this.mEyes.setMatrixAt(km, _zero); km = this.put(this.mShell, this.mCore, km, d.col, 0.6 * fade, true); } else kl = this.put(this.lShell, this.lCore, kl, d.col, 0.7 * fade, false);
    }
    for (const s of this.spits) {
      if (km >= MAX) break;
      _m.compose(_p.set(s.x, s.y, s.z), _q.identity(), _s.set(0.12, 0.12, 0.12));
      this.mEyes.setMatrixAt(km, _zero);
      km = this.put(this.mShell, this.mCore, km, MURK_COL[2], 1.5, true);
    }
    this.lShell.count = this.lCore.count = kl;
    this.mShell.count = this.mCore.count = this.mEyes.count = km;
    for (const m of [this.lShell, this.lCore, this.mShell, this.mCore, this.mEyes]) { m.instanceMatrix.needsUpdate = true; m.instanceColor!.needsUpdate = true; }
  }

  private put(shell: THREE.InstancedMesh, core: THREE.InstancedMesh, k: number, col: [number, number, number], glow: number, murk: boolean): number {
    shell.setMatrixAt(k, _m);
    // Murk: dark blood red, the spines glowing hotter (vertex colours); nothing like the soft Lumen.
    if (murk) _c.setRGB(0.07 + col[0] * 0.06 * glow, 0.008 + col[2] * 0.01, 0.014);
    else _c.setRGB(col[0] * glow, col[1] * glow, col[2] * glow);
    shell.setColorAt(k, _c);
    _m2.makeScale(murk ? 0.42 : 0.6, murk ? 0.38 : 0.55, murk ? 0.42 : 0.6).setPosition(0, murk ? 0.25 : 0.12, 0);
    _m3.multiplyMatrices(_m, _m2);
    core.setMatrixAt(k, _m3);
    if (murk) {
      // An ember deep inside: dark red, brighter in a fight (bright colours wash out to peach).
      const g = 0.35 + glow * 0.4;
      _c.setRGB(Math.min(0.95, col[0] * g), col[1] * g * 0.5, col[2] * g * 0.5);
    } else {
      const g = glow * 1.1;
      _c.setRGB(Math.min(1.6, col[0] * g + 0.08), Math.min(1.6, col[1] * g + 0.06), Math.min(1.6, col[2] * g + 0.06));
    }
    core.setColorAt(k, _c);
    return k + 1;
  }

  /** The Murk as threat actors (targetable, damageable by every power), near a point. */
  actors(x: number, z: number, r: number): ThreatActor[] {
    const out: ThreatActor[] = [];
    for (const b of this.blobs) if (b.actor && b.mode !== 'dead' && Math.abs(b.x - x) < r && Math.abs(b.z - z) < r) out.push(b.actor);
    return out;
  }

  /** A physical blow (punch, blast) at a point: every blob in reach takes it (Lumen too). */
  blow(x: number, y: number, z: number, r: number, jx: number, jy: number, jz: number, byPlayer: boolean): number {
    const J = Math.hypot(jx, jy, jz);
    let n = 0;
    for (const b of this.blobs) {
      if (b.mode === 'dead' || b.mode === 'hidden') continue;
      // (A punch at chest height still reaches a slime at one's feet: the fist swings down at it.)
      const dy = Math.max(0, Math.abs(b.y + b.r - y) - b.r - 1.1);
      const d = Math.hypot(b.x - x, dy, b.z - z);
      if (d > r + b.r) continue;
      // Any punch takes a chunk out of a slime; harder blows splat it.
      this.hurt(b, 0.45 + J / 1500, byPlayer, x, z);
      n++;
    }
    return n;
  }

  dispose(): void {
    for (const m of [this.lShell, this.lCore, this.mShell, this.mCore, this.mEyes]) m.dispose();
  }
}

/** A Murk as the game's threat actor: one round body; brutes and the Maw have a weak core that shows when they strike. */
export class MurkActor implements ThreatActor {
  readonly zones: ThreatZone[];
  readonly aggro = new Map<string, number>();
  constructor(readonly b: Blob, private F: Factions) {
    const core = b.role === 'brute' || b.role === 'maw';
    this.zones = [{ id: 'body', name: b.role === 'maw' ? 'Hide' : 'Body', armour: b.role === 'maw' ? 0.55 : b.role === 'brute' ? 0.25 : 0, weak: false, exposed: false, x: b.x, y: b.y, z: b.z, r: b.r, recent: 0 }];
    if (core) this.zones.push({ id: 'core', name: 'Ember core', armour: 0, weak: true, exposed: false, x: b.x, y: b.y, z: b.z, r: b.r * 0.4, recent: 0 });
  }
  get name(): string { return this.b.role === 'maw' ? 'The Maw' : this.b.role === 'brute' ? 'Murk brute' : this.b.role === 'jailer' ? 'Murk jailer' : 'Murk'; }
  get hp(): number { return Math.max(0, this.b.hp); }
  get maxHp(): number { return this.b.maxHp; }
  get defeated(): boolean { return this.b.mode === 'dead' || this.b.hp <= 0; }
  get targetable(): boolean { return !this.defeated; }
  get x(): number { return this.b.x; }
  get y(): number { return this.b.y + this.b.r * 0.6; }
  get z(): number { return this.b.z; }
  get height(): number { return this.b.r * 1.3; }
  private sync(): void {
    const b = this.b;
    for (const z of this.zones) {
      z.x = b.x; z.z = b.z;
      z.y = b.y + b.r * (z.id === 'core' ? 0.5 : 0.6);
      z.r = z.id === 'core' ? b.r * 0.4 : b.r * 1.05;
      if (z.weak) z.exposed = b.lunge > 0 || b.cd > (b.role === 'maw' ? 1.6 : 2.0);
    }
  }
  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): { t: number; zone: ThreatZone } | null {
    this.sync();
    let best: { t: number; zone: ThreatZone } | null = null;
    for (const z of this.zones) {
      const px = ox - z.x, py = oy - z.y, pz = oz - z.z;
      const bq = px * dx + py * dy + pz * dz, c = px * px + py * py + pz * pz - z.r * z.r;
      const disc = bq * bq - c;
      if (disc < 0) continue;
      const t = -bq - Math.sqrt(disc);
      if (t < 0 || t > maxT) continue;
      if (!best || t < best.t - (z.weak && z.exposed ? 0.3 : 0)) best = { t, zone: z };
    }
    return best;
  }
  zoneAt(x: number, y: number, z: number): { zone: ThreatZone; d: number } | null {
    this.sync();
    let best: { zone: ThreatZone; d: number } | null = null;
    for (const zn of this.zones) {
      const d = Math.hypot(x - zn.x, y - zn.y, z - zn.z) - zn.r;
      if (!best || d < best.d) best = { zone: zn, d };
    }
    return best;
  }
  damage(zone: ThreatZone | string | null, amount: number, src: DamageSource): DamageResult {
    this.sync();
    const zn = typeof zone === 'string' ? this.zones.find((q) => q.id === zone) ?? this.zones[0] : zone ?? this.zones[0];
    const weak = zn.weak && zn.exposed;
    const dealt = amount * (1 - zn.armour) * (weak ? 2.5 : 1);
    zn.recent += dealt;
    this.aggro.set(src.key ?? src.cause, (this.aggro.get(src.key ?? src.cause) ?? 0) + dealt);
    this.F.hurt(this.b, dealt, src.cause === 'player', src.x ?? this.b.x, src.z ?? this.b.z);
    return { dealt, zone: zn, weak };
  }
  blow(x: number, y: number, z: number, r: number, jx: number, jy: number, jz: number, src: DamageSource): DamageResult | null {
    const hit = this.zoneAt(x, y, z);
    if (!hit || hit.d > r) return null;
    return this.damage(hit.zone, 0.45 + Math.hypot(jx, jy, jz) / 1500, src);
  }
  conStrength(): number { return this.b.role === 'maw' ? 40 : this.b.role === 'brute' ? 4 : this.b.role === 'jailer' ? 2 : 1; }
}

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);
const _c = new THREE.Color();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

/** The Murk's eyes: two slanted, glaring slits at the front (+x) of the shell. */
function eyesGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const e = new THREE.SphereGeometry(1, 10, 6);
    e.scale(0.07, 0.075, 0.17);
    // Slanted down towards the middle: an angry glare.
    e.rotateX(-side * 0.45);
    e.translate(0.9, 0.66, side * 0.27);
    parts.push(e);
  }
  const pos: number[] = [], idx: number[] = [];
  for (const p of parts) {
    const base = pos.length / 3, a = p.getAttribute('position');
    for (let i = 0; i < a.count; i++) pos.push(a.getX(i), a.getY(i), a.getZ(i));
    const ix = p.getIndex()!;
    for (let i = 0; i < ix.count; i++) idx.push(base + ix.getX(i));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

/** A blob with spines: the Murk's shell (dark, ridged, pointed). */
function spikedGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 3);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const l = Math.hypot(x, y, z);
    x /= l; y /= l; z /= l;
    // Spines where a lattice of directions peaks, ridges between.
    const s = Math.max(0, Math.sin(x * 9.1) * Math.sin(y * 8.3 + 1) * Math.sin(z * 9.7 + 2));
    const spike = y > -0.3 ? Math.pow(s, 3) * 0.9 : 0;
    const r = 1 + spike + 0.06 * Math.sin(x * 20 + z * 13);
    const yy = y < 0 ? y * 0.3 : y * 0.9;
    pos.setXYZ(i, x * r, yy * r + 0.28, z * r);
    // The body dark, the spines running hot towards their tips.
    const hot = Math.max(0, Math.min(1, (spike - 0.12) * 2.5));
    col[i * 3] = 0.45 + hot * 2.6; col[i * 3 + 1] = 0.45 + hot * 1.1; col[i * 3 + 2] = 0.45 + hot * 0.5;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
