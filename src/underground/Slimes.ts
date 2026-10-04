/**
 * The slimes: soft, glowing blobs living in the hidden chambers (rooms.ts colonies), with the
 * odd one glimpsed near ordinary side rooms. Show, don't tell: nothing is explained.
 *
 *  - Calm, they go about their work: tending the moss gardens, carrying little glowing things
 *    from the pile to the spiral and the row, gathering along the walls, and a few sitting in a
 *    circle pulsing in turn, as if talking.
 *  - Shy: they notice the player some way off, freeze, dim, then flow to the cracks at the foot
 *    of the walls and squeeze in. Someone who stays still long enough is looked at: a few peek
 *    out, a brave one comes close, stretches up to look, and (once per colony) leaves a glowing
 *    pebble.
 *  - Hurt (a punch, a power, a blast near them) they splatter into smaller blobs that flow away;
 *    the colony then stays hidden for a long time.
 *
 * One colony is active at a time (the nearest within reach); all blobs share two instanced
 * meshes (a translucent shell and a brighter core) with one unlit material, warmed at start.
 */
import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { Colony } from './rooms';
import { fw, type Frame } from './roomArt';
import type { ColonyLayout } from './RoomMeshes';

const MAX = 96;
/** Notice distances (m): in the chamber, from the crawl. */
const NOTICE = 8.5, NOTICE_CRAWL = 5;
/** Seconds of standing still before they peek out; the brave one's approach distance. */
const STILL = 7, CLOSE = 1.3;
/** Hidden after being hurt (s). */
const HURT_HIDE = 600;

type Role = 'tend' | 'carry' | 'gather' | 'sit';
type Mode = 'calm' | 'freeze' | 'flee' | 'squeeze' | 'hidden' | 'peek' | 'brave' | 'back';

interface Slime {
  u: number; v: number; r: number; col: number; role: Role; mode: Mode;
  tu: number; tv: number; wait: number; ph: number; t: number;
  glow: number; carry: boolean; crev: number; stretch: number; seat: number; dead: boolean; hop: number;
}

interface Drop { u: number; v: number; vu: number; vv: number; r: number; col: number; life: number; crev: number }

interface ColonyState {
  c: Colony; L: ColonyLayout; slimes: Slime[]; drops: Drop[];
  alarm: boolean; awayT: number; stillT: number; hurtUntil: number; brave: Slime | null; braveT: number;
  gift: { u: number; v: number; taken: boolean } | null; gifted: boolean;
}

interface Scout { x: number; y: number; z: number; hx: number; hz: number; mode: 'sit' | 'flee' | 'gone'; t: number; col: [number, number, number]; r: number; show: boolean; ph: number }

export interface SlimeSound {
  play(id: string, x: number, y: number, z: number, gain: number): void;
  loop(id: string): { set(x: number, y: number, z: number, gain: number, rate?: number): void; stop(): void } | null;
}

export class Slimes {
  readonly group = new THREE.Group();
  private shell: THREE.InstancedMesh;
  private core: THREE.InstancedMesh;
  private states = new Map<number, ColonyState>();
  private scouts = new Map<string, Scout>();
  private time = 0;
  private lastP = new THREE.Vector3(1e9, 0, 0);
  private speed = 0;
  private burble: ReturnType<SlimeSound['loop']> = null;
  sound: SlimeSound | null = null;
  /** Debug (headless screenshots): they do not notice the player. */
  oblivious = false;

  constructor() {
    const g = blobGeometry();
    // One unlit material for shells and cores (two instances of it, one program).
    const shellMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.62, depthWrite: false });
    const coreMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending });
    this.core = new THREE.InstancedMesh(g, coreMat, MAX);
    this.shell = new THREE.InstancedMesh(g, shellMat, MAX);
    for (const m of [this.core, this.shell]) {
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
      m.count = 0;
      m.frustumCulled = false;
      this.group.add(m);
    }
    this.core.renderOrder = 4;
    this.shell.renderOrder = 5;
  }

  /** A colony's chamber was built (or dropped): its slimes exist while it is near. */
  setColony(c: Colony, L: ColonyLayout | null): void {
    if (!L) return;
    if (!this.states.has(c.id)) this.states.set(c.id, this.spawn(c, L));
  }

  /** A trace room's lone one (key: room id); null removes it. */
  setScout(key: string, s: { x: number; y: number; z: number; hx: number; hz: number } | null, seed: number): void {
    if (!s) { this.scouts.delete(key); return; }
    if (this.scouts.has(key)) return;
    const rng = new Rng(seed);
    // Only now and then is one there at all.
    const show = rng.chance(0.55);
    const pal: [number, number, number][] = [[0.3, 0.95, 0.8], [0.75, 0.55, 1.0], [1.0, 0.75, 0.35]];
    this.scouts.set(key, { ...s, mode: 'sit', t: 0, col: rng.pick(pal), r: rng.range(0.15, 0.2), show, ph: rng.range(0, 6) });
  }

  private spawn(c: Colony, L: ColonyLayout): ColonyState {
    const rng = new Rng(c.seed ^ 0x51e);
    const n = 12 + rng.int(0, 6);
    const slimes: Slime[] = [];
    const roles: Role[] = ['sit', 'sit', 'sit', 'sit', 'tend', 'tend', 'tend', 'carry', 'carry', 'carry', 'gather', 'gather'];
    for (let i = 0; i < n; i++) {
      const role = roles[i] ?? rng.pick(['tend', 'carry', 'gather'] as Role[]);
      const big = rng.chance(0.25);
      const s: Slime = { u: 0, v: 0, r: big ? rng.range(0.3, 0.42) : rng.range(0.16, 0.28), col: rng.int(0, 2), role, mode: 'calm', tu: 0, tv: 0, wait: rng.range(0, 3), ph: rng.range(0, 6), t: 0, glow: 0.8, carry: false, crev: rng.int(0, L.crevices.length - 1), stretch: 0, seat: i, dead: false, hop: 0 };
      if (role === 'sit') { const a = (i / 4) * Math.PI * 2; s.u = L.circle.u + Math.cos(a) * 0.65; s.v = L.circle.v + Math.sin(a) * 0.65; }
      else { const g = L.gardens[i % L.gardens.length]; s.u = g.u + rng.range(-0.8, 0.8); s.v = g.v + rng.range(-0.8, 0.8); }
      s.tu = s.u; s.tv = s.v;
      slimes.push(s);
    }
    return { c, L, slimes, drops: [], alarm: false, awayT: 0, stillT: 0, hurtUntil: -1, brave: null, braveT: 0, gift: null, gifted: false };
  }

  /** Something violent happened at (x, y, z): blobs near it splatter, the colony hides. */
  stimulus(kind: string, x: number, y: number, z: number, radius: number): void {
    const reach = kind === 'impact' ? 0.85 : kind === 'power' || kind === 'blast' || kind === 'stomp' ? Math.min(6, radius * 0.25 + 1) : 0;
    if (reach <= 0) return;
    for (const st of this.states.values()) {
      const L = st.L, [cx, cz] = fw(L.frame, 0, 0);
      if (Math.abs(y - L.y) > 6 || Math.hypot(x - cx, z - cz) > 20) continue;
      // A punch splatters the one it lands on; a power or a blast every one within its reach.
      let hit = false, nearest: Slime | null = null, nd = Infinity;
      for (const s of st.slimes) {
        if (s.dead || s.mode === 'hidden' || s.mode === 'squeeze') continue;
        const [sx, sz] = fw(L.frame, s.u, s.v), d = Math.hypot(sx - x, sz - z);
        if (d > reach + s.r || y > L.y + 2.5) continue;
        if (kind === 'impact') { if (d < nd) { nd = d; nearest = s; } continue; }
        this.splat(st, s);
        hit = true;
      }
      if (nearest) { this.splat(st, nearest); hit = true; }
      // Anything violent nearby: they all hide, for a long while if one was hurt.
      st.alarm = true;
      st.awayT = 0;
      if (hit) st.hurtUntil = this.time + HURT_HIDE;
      for (const s of st.slimes) if (!s.dead && s.mode !== 'hidden' && s.mode !== 'squeeze') { s.mode = 'flee'; this.toCrevice(st, s, x, z); }
    }
    for (const sc of this.scouts.values()) if (sc.show && sc.mode === 'sit' && Math.hypot(sc.x - x, sc.z - z) < 12) { sc.mode = 'flee'; sc.t = 0; }
  }

  private splat(st: ColonyState, s: Slime): void {
    s.dead = true;
    const rng = new Rng((this.time * 1000) | 0);
    const n = 4 + rng.int(0, 2);
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2), sp = rng.range(1.2, 2.6);
      st.drops.push({ u: s.u, v: s.v, vu: Math.cos(a) * sp, vv: Math.sin(a) * sp, r: s.r * rng.range(0.3, 0.45), col: s.col, life: 0, crev: rng.int(0, st.L.crevices.length - 1) });
    }
    const [x, z] = fw(st.L.frame, s.u, s.v);
    this.sound?.play('slime_squish', x, st.L.y + 0.2, z, 1);
  }

  /** Pick the crack to flee to: near, away from the threat. */
  private toCrevice(st: ColonyState, s: Slime, px: number, pz: number): void {
    let best = 0, bs = -Infinity;
    st.L.crevices.forEach((q, i) => {
      const [qx, qz] = fw(st.L.frame, q.u + q.fu * 0.3, q.v + q.fv * 0.3);
      const [sx, sz] = fw(st.L.frame, s.u, s.v);
      const sc = Math.hypot(qx - px, qz - pz) * 0.7 - Math.hypot(qx - sx, qz - sz);
      if (sc > bs) { bs = sc; best = i; }
    });
    s.crev = best;
    const q = st.L.crevices[best];
    s.tu = q.u + q.fu * 0.25; s.tv = q.v + q.fv * 0.25;
    s.wait = 0.25 + Math.random() * 0.6;
  }

  update(dt: number, player: THREE.Vector3, under: boolean): void {
    this.time += dt;
    const p = player;
    const moved = this.lastP.x > 1e8 ? 0 : Math.hypot(p.x - this.lastP.x, p.z - this.lastP.z) / Math.max(1e-3, dt);
    this.lastP.copy(p);
    this.speed += (Math.min(moved, 20) - this.speed) * Math.min(1, dt * 4);
    let k = 0;
    // The colony in reach (others keep their state, frozen).
    let active: ColonyState | null = null, ad = 70;
    for (const st of this.states.values()) {
      const [cx, cz] = fw(st.L.frame, 0, 0), d = Math.hypot(cx - p.x, cz - p.z);
      if (d < ad && Math.abs(p.y - st.L.y) < 25) { ad = d; active = st; }
    }
    if (active) k = this.updateColony(active, dt, p, under, k);
    k = this.updateScouts(dt, p, k);
    this.core.count = this.shell.count = k;
    if (k) {
      this.core.instanceMatrix.needsUpdate = this.shell.instanceMatrix.needsUpdate = true;
      this.core.instanceColor!.needsUpdate = this.shell.instanceColor!.needsUpdate = true;
    }
    // Their murmur while they sit and talk (only near, only calm).
    if (this.sound && active && !active.alarm && ad < 30) {
      if (!this.burble) this.burble = this.sound.loop('slime_burble');
      const [x, z] = fw(active.L.frame, active.L.circle.u, active.L.circle.v);
      this.burble?.set(x, active.L.y + 0.3, z, 0.5);
    } else this.burble?.set(p.x, p.y, p.z, 0);
  }

  private updateColony(st: ColonyState, dt: number, p: THREE.Vector3, under: boolean, k: number): number {
    const L = st.L, f = L.frame;
    // Player in the chamber frame.
    const dx = p.x - f.ox, dz = p.z - f.oz;
    const pu = dx * f.nx + dz * f.nz, pv = -dx * f.nz + dz * f.nx;
    const inside = under && Math.abs(pu) < L.hu + 0.3 && Math.abs(pv) < L.hv + 0.3 && Math.abs(p.y - L.y) < 3;
    const nearMouth = under && !inside && Math.hypot(pu + L.hu, pv) < NOTICE_CRAWL && Math.abs(p.y - L.y) < 3;
    const hurt = this.time < st.hurtUntil;
    // Noticing: the nearest blob within reach of the player.
    if (!this.oblivious && !st.alarm && (inside || nearMouth)) {
      const lim = inside ? NOTICE : NOTICE_CRAWL + 2;
      if (st.slimes.some((s) => !s.dead && s.mode === 'calm' && Math.hypot(s.u - pu, s.v - pv) < lim)) {
        st.alarm = true;
        st.stillT = 0;
        for (const s of st.slimes) {
          if (s.dead) continue;
          s.mode = 'freeze';
          s.wait = 0.35 + Math.hypot(s.u - pu, s.v - pv) * 0.07 + Math.random() * 0.4;
          s.carry = false;
        }
        const [x, z] = fw(f, L.circle.u, L.circle.v);
        this.sound?.play('slime_squish', x, L.y + 0.2, z, 0.35);
      }
    }
    // Leaving them alone a while: they come out again (not while hurt).
    if (st.alarm) {
      st.awayT = inside || nearMouth ? 0 : st.awayT + dt;
      if (st.awayT > 20 && !hurt) {
        st.alarm = false;
        st.brave = null;
        for (const s of st.slimes) {
          s.dead = false;
          if (s.mode !== 'calm') { s.mode = 'calm'; const q = L.crevices[s.crev]; s.u = q.u + q.fu * 0.3; s.v = q.v + q.fv * 0.3; s.tu = s.u; s.tv = s.v; s.wait = Math.random() * 2; }
        }
      }
      // Standing still in the chamber: they get curious.
      if (inside && !hurt && this.speed < 0.25) st.stillT += dt; else if (this.speed > 0.6) st.stillT = 0;
    }
    const still = st.stillT > STILL;
    for (const s of st.slimes) {
      if (s.dead) continue;
      s.t += dt;
      switch (s.mode) {
        case 'calm': this.calm(st, s, dt); break;
        case 'freeze':
          s.glow += (0.22 - s.glow) * Math.min(1, dt * 5);
          s.wait -= dt;
          if (s.wait <= 0) { s.mode = 'flee'; this.toCrevice(st, s, p.x, p.z); s.wait = 0; }
          break;
        case 'flee':
          if (this.move(s, dt, 2.6)) { s.mode = 'squeeze'; s.wait = 0.6; }
          s.glow += (0.2 - s.glow) * Math.min(1, dt * 4);
          break;
        case 'squeeze':
          s.wait -= dt;
          if (s.wait <= 0) { s.mode = 'hidden'; s.wait = 0; }
          break;
        case 'hidden':
          // A still visitor: a few peek out of their cracks, one of them is brave.
          if (still && !hurt && !st.brave && s.r > 0.2 && Math.random() < dt * 0.4) {
            s.mode = 'peek';
            s.wait = 2 + Math.random() * 2;
            const q = L.crevices[s.crev];
            s.u = q.u + q.fu * 0.3; s.v = q.v + q.fv * 0.3;
            s.tu = s.u; s.tv = s.v;
          }
          break;
        case 'peek':
          s.glow += (0.35 - s.glow) * Math.min(1, dt * 2);
          if (this.speed > 0.6 || hurt) { s.mode = 'flee'; this.toCrevice(st, s, p.x, p.z); break; }
          s.wait -= dt;
          if (s.wait <= 0 && !st.brave && inside) {
            st.brave = s;
            st.braveT = 0;
            s.mode = 'brave';
            const d = Math.hypot(pu - s.u, pv - s.v) || 1;
            s.tu = pu - ((pu - s.u) / d) * CLOSE; s.tv = pv - ((pv - s.v) / d) * CLOSE;
          }
          break;
        case 'brave': {
          if (this.speed > 0.6 || hurt) { s.mode = 'flee'; s.stretch = 0; st.brave = null; this.toCrevice(st, s, p.x, p.z); break; }
          s.glow += (0.75 - s.glow) * Math.min(1, dt * 1.5);
          if (this.move(s, dt, 0.8)) {
            // Close: stretch up and look, a while; then, once, leave a pebble.
            st.braveT += dt;
            s.stretch = Math.min(1, s.stretch + dt * 0.8);
            if (st.braveT > 3.5 && !st.gifted) {
              st.gifted = true;
              const d = Math.hypot(pu - s.u, pv - s.v) || 1;
              st.gift = { u: s.u + ((pu - s.u) / d) * 0.45, v: s.v + ((pv - s.v) / d) * 0.45, taken: false };
              const [x, z] = fw(f, st.gift.u, st.gift.v);
              this.sound?.play('slime_gift', x, L.y + 0.2, z, 0.8);
            }
            if (st.braveT > 6.5) { s.mode = 'back'; s.stretch = 0; const q = L.crevices[s.crev]; s.tu = q.u + q.fu * 0.25; s.tv = q.v + q.fv * 0.25; }
          }
          break;
        }
        case 'back':
          s.stretch = Math.max(0, s.stretch - dt * 2);
          if (this.move(s, dt, 0.6)) { s.mode = 'squeeze'; s.wait = 0.6; st.brave = null; st.stillT = STILL - 3; }
          break;
      }
    }
    // The pebble: taken when walked over (a soft chime).
    if (st.gift && !st.gift.taken && inside && Math.hypot(pu - st.gift.u, pv - st.gift.v) < 0.45) {
      st.gift.taken = true;
      const [x, z] = fw(f, st.gift.u, st.gift.v);
      this.sound?.play('slime_gift', x, L.y + 0.2, z, 0.45);
    }
    // Splatter drops: fly out, then flow to a crack and vanish.
    for (const d of st.drops) {
      d.life += dt;
      if (d.life < 0.35) { d.u += d.vu * dt; d.v += d.vv * dt; }
      else {
        const q = L.crevices[d.crev], tu = q.u + q.fu * 0.2, tv = q.v + q.fv * 0.2, dd = Math.hypot(tu - d.u, tv - d.v);
        const sp = Math.min(dd, 1.4 * dt);
        if (dd > 1e-3) { d.u += ((tu - d.u) / dd) * sp; d.v += ((tv - d.v) / dd) * sp; }
        if (dd < 0.05) d.life = 99;
      }
      d.u = Math.max(-L.hu + 0.1, Math.min(L.hu - 0.1, d.u)); d.v = Math.max(-L.hv + 0.1, Math.min(L.hv - 0.1, d.v));
    }
    st.drops = st.drops.filter((d) => d.life < 30);
    // Draw.
    const pal = L.palette;
    for (const s of st.slimes) {
      if (s.dead || s.mode === 'hidden' || k >= MAX - 4) continue;
      const moving = s.mode === 'flee' || s.mode === 'back' || s.mode === 'brave' || (s.mode === 'calm' && s.wait <= 0);
      const w = moving ? Math.sin(s.t * (s.mode === 'flee' ? 13 : 7) + s.ph) : Math.sin(s.t * 1.6 + s.ph) * 0.4;
      let sy = 1 + w * 0.13 + s.stretch * 0.7, sx = 1 - w * 0.07 - s.stretch * 0.22;
      let off = 0;
      if (s.mode === 'squeeze') { const q = 1 - s.wait / 0.6; sx *= 1 - q * 0.7; sy *= 1 - q * 0.6; off = q * 0.35; }
      const q = L.crevices[s.crev];
      const yaw = Math.atan2(s.tv - s.v, s.tu - s.u);
      let pulse = 1;
      if (s.role === 'sit' && s.mode === 'calm' && s.wait <= 0) {
        // Sitting together, pulsing in turn: the one "speaking" glows up.
        const speaker = Math.floor(this.time / 1.7) % 4;
        pulse = 0.75 + 0.25 * Math.sin(this.time * 2.4) + (s.seat % 4 === speaker ? 0.35 * Math.max(0, Math.sin(((this.time % 1.7) / 1.7) * Math.PI)) : 0);
        sy *= 1 + (pulse - 1) * 0.15;
      }
      k = this.put(k, f, s.u - q.fu * off, s.v - q.fv * off, L.y, s.r, sx, sy, yaw, pal[s.col], s.glow * pulse);
      if (s.carry) k = this.put(k, f, s.u, s.v, L.y + s.r * 1.25 * sy, 0.035, 1, 1, 0, pal[(s.col + 1) % 3], 1.2);
    }
    for (const d of st.drops) if (d.life < 30 && k < MAX - 2) {
      const w = Math.sin(d.life * 15) * 0.2;
      k = this.put(k, f, d.u, d.v, L.y, d.r, 1 + w * 0.5, 0.6 - w * 0.3, Math.atan2(d.vv, d.vu), pal[d.col], 0.5);
    }
    if (st.gift && !st.gift.taken && k < MAX - 1) k = this.put(k, f, st.gift.u, st.gift.v, L.y, 0.045, 1, 0.8, 0, [1, 0.95, 0.75], 1.3 + 0.2 * Math.sin(this.time * 3));
    return k;
  }

  /** Calm work: tend a garden, carry from the pile to the spiral or the row, gather, or sit. */
  private calm(st: ColonyState, s: Slime, dt: number): void {
    const L = st.L;
    s.glow += (0.8 - s.glow) * Math.min(1, dt * 1.5);
    if (s.wait > 0) { s.wait -= dt; return; }
    if (!this.move(s, dt, s.role === 'carry' ? 0.45 : 0.32)) return;
    const rnd = Math.random;
    switch (s.role) {
      case 'sit': {
        const a = ((s.seat % 4) / 4) * Math.PI * 2;
        s.tu = L.circle.u + Math.cos(a) * 0.65; s.tv = L.circle.v + Math.sin(a) * 0.65;
        s.wait = 4 + rnd() * 6;
        break;
      }
      case 'tend': {
        const g = L.gardens[Math.floor(rnd() * L.gardens.length)];
        const a = rnd() * Math.PI * 2, d = rnd() * g.r * 0.7;
        s.tu = g.u + Math.cos(a) * d; s.tv = g.v + Math.sin(a) * d;
        s.wait = 2.5 + rnd() * 4;
        break;
      }
      case 'carry': {
        if (s.carry) {
          // Delivered: the spiral or the row.
          s.carry = false;
          s.tu = L.pile.u + (rnd() - 0.5) * 0.5; s.tv = L.pile.v + (rnd() - 0.5) * 0.5;
          s.wait = 0.8;
        } else {
          s.carry = true;
          const toRow = rnd() < 0.4;
          s.tu = toRow ? L.row.u - 0.25 : L.spiral.u + (rnd() - 0.5) * 0.4;
          s.tv = toRow ? L.row.v0 + rnd() * (L.row.v1 - L.row.v0) : L.spiral.v + (rnd() - 0.5) * 0.4;
          s.wait = 1.0;
        }
        break;
      }
      case 'gather': {
        if (Math.hypot(s.u - L.pile.u, s.v - L.pile.v) < 0.5) {
          const q = L.crevices[Math.floor(rnd() * L.crevices.length)];
          s.tu = q.u + q.fu * 0.6 + (rnd() - 0.5); s.tv = q.v + q.fv * 0.6 + (rnd() - 0.5);
          s.tu = Math.max(-L.hu + 0.4, Math.min(L.hu - 0.4, s.tu)); s.tv = Math.max(-L.hv + 0.4, Math.min(L.hv - 0.4, s.tv));
          s.wait = 2 + rnd() * 2;
        } else { s.tu = L.pile.u; s.tv = L.pile.v; s.wait = 1; s.carry = false; }
        break;
      }
    }
  }

  /** Step towards the target; true on arrival. */
  private move(s: Slime, dt: number, speed: number): boolean {
    const du = s.tu - s.u, dv = s.tv - s.v, d = Math.hypot(du, dv);
    if (d < 0.04) return true;
    // Gliding in soft surges (fast in the stretch of each squash).
    const surge = 0.55 + 0.45 * Math.max(0, Math.sin(s.t * 7 + s.ph));
    const st = Math.min(d, speed * surge * dt);
    s.u += (du / d) * st; s.v += (dv / d) * st;
    return d - st < 0.04;
  }

  private updateScouts(dt: number, p: THREE.Vector3, k: number): number {
    for (const sc of this.scouts.values()) {
      if (!sc.show) continue;
      const d = Math.hypot(sc.x - p.x, sc.z - p.z), dy = Math.abs(sc.y - p.y);
      sc.t += dt;
      if (sc.mode === 'sit' && !this.oblivious && d < 6.5 && dy < 3) { sc.mode = 'flee'; sc.t = 0; }
      if (sc.mode === 'gone') {
        // Back after a long while, when nobody is near.
        if (d > 80 && sc.t > 240) { sc.mode = 'sit'; sc.t = 0; }
        continue;
      }
      if (k >= MAX - 1) continue;
      let x = sc.x, z = sc.z, sx = 1, sy = 1, glow = 0.6;
      if (sc.mode === 'flee') {
        // Away into the crack in a second, squeezing through.
        const q = Math.min(1, sc.t / 0.9), e = q * q * (3 - 2 * q);
        x = sc.x + (sc.hx - sc.x) * e; z = sc.z + (sc.hz - sc.z) * e;
        const w = Math.sin(sc.t * 14);
        sx = (1 - w * 0.1) * (1 - Math.max(0, q - 0.6) * 2); sy = (1 + w * 0.15) * (1 - Math.max(0, q - 0.6) * 1.5);
        glow = 0.3;
        if (q >= 1) { sc.mode = 'gone'; sc.t = 0; continue; }
      } else { const w = Math.sin(sc.t * 1.5 + sc.ph) * 0.4; sy = 1 + w * 0.1; sx = 1 - w * 0.05; }
      _m.compose(_p.set(x, sc.y, z), _q.setFromAxisAngle(_up, Math.atan2(sc.hx - sc.x, sc.hz - sc.z)), _s.set(sc.r * sx, sc.r * sy, sc.r * sx));
      k = this.putM(k, sc.col, glow);
    }
    return k;
  }

  private put(k: number, f: Frame, u: number, v: number, y: number, r: number, sx: number, sy: number, yaw: number, col: [number, number, number], glow: number): number {
    const [x, z] = fw(f, u, v);
    const a = Math.atan2(f.nz, f.nx) + yaw;
    _m.compose(_p.set(x, y, z), _q.setFromAxisAngle(_up, -a), _s.set(r * sx, r * sy, r * sx));
    return this.putM(k, col, glow);
  }

  private putM(k: number, col: [number, number, number], glow: number): number {
    this.shell.setMatrixAt(k, _m);
    _c.setRGB(col[0] * glow, col[1] * glow, col[2] * glow);
    this.shell.setColorAt(k, _c);
    // The core: smaller and brighter, low in the blob.
    _m2.makeScale(0.6, 0.55, 0.6).setPosition(0, 0.12, 0);
    _m3.multiplyMatrices(_m, _m2);
    this.core.setMatrixAt(k, _m3);
    _c.setRGB(Math.min(1, col[0] * glow * 1.1 + 0.08), Math.min(1, col[1] * glow * 1.1 + 0.08), Math.min(1, col[2] * glow * 1.1 + 0.08));
    this.core.setColorAt(k, _c);
    return k + 1;
  }

  /** For tests/inspection: what the active colonies are doing. */
  debugState(): { colony: number; alarm: boolean; visible: number; hidden: number; dead: number; gift: boolean }[] {
    return [...this.states.values()].map((st) => ({
      colony: st.c.id, alarm: st.alarm,
      visible: st.slimes.filter((s) => !s.dead && s.mode !== 'hidden').length,
      hidden: st.slimes.filter((s) => s.mode === 'hidden').length,
      dead: st.slimes.filter((s) => s.dead).length,
      gift: !!st.gift && !st.gift.taken,
    }));
  }
}

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);
const _c = new THREE.Color();

/** A soft blob sitting on the ground (radius 1, height ~1.3): brighter on top, darker at the rim. */
function blobGeometry(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 16, 10);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // Flattened underneath, a slightly drooping belly.
    const yy = y < 0 ? y * 0.25 : y * 0.95;
    const bulge = 1 + (y < 0.2 ? 0.08 * (1 - Math.abs(y)) : 0);
    pos.setXYZ(i, x * bulge, yy + 0.25, z * bulge);
    const c = 0.45 + 0.55 * Math.max(0, y * 0.6 + 0.5 - Math.hypot(x, z) * 0.15);
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = c;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
