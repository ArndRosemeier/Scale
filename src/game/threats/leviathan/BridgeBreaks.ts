/**
 * Fallen bridge spans (the Leviathan smashes decks): a gap opens in a deck between two piers
 * (or a 16–24 m piece where there are none), cars, people and the deck itself drop into the
 * river, traffic stops short of the broken ends. The gaps live on the bridge profiles (so
 * `world.bridgeDeck` and `wet()` see open water there) and in the bridge mesh (rebuilt by the
 * worker, same material). A gap is mended a game day later, once nobody is near to watch.
 */
import * as THREE from 'three';
import type { Game } from '../../Game';
import { Rng } from '../../../core/rng';
import { bridgePiers, inGap, type BridgeGapSpec, type BridgeProfile } from '../../../build/bridges';
import { VState } from '../../../sim/Traffic';
import { isUp } from '../../../sim/Pedestrians';
import { downCauseOf } from '../../../shared/cause';
import type { Cause } from '../../Stimuli';

/** A fallen span: deck arc-length range on an edge's bridge, mended after `until` (game hours). */
export interface BridgeGap { edge: number; s0: number; s1: number; until: number; seed: number }

export const BRIDGE_BREAK = {
  /** Game hours a gap stays open. */
  keepH: 24,
  /** Mended only with the camera at least this far (m). */
  mendDist: 300,
  /** A gap stays this far inside the deck ends (m). */
  endKeep: 4,
  /** Span length where there are no piers (m). */
  piece: [16, 24] as [number, number],
  /** Shortest gap worth opening (m). */
  minLen: 6,
  /** The deck ends this far past a pier's centre (it rests on it). */
  pierInset: 1,
};

const DECK = new THREE.Color(0.8, 0.79, 0.76), TAR = new THREE.Color(0.3, 0.3, 0.31);
const DUST = new THREE.Color(0.62, 0.6, 0.56), FOAM = new THREE.Color(0.9, 0.93, 0.95);
const WATER_A = new THREE.Color(0.75, 0.82, 0.86), WATER_B = new THREE.Color(0.5, 0.6, 0.66);

export class BridgeBreaks {
  readonly gaps: BridgeGap[] = [];
  private checkT = 0;

  constructor(private readonly g: Game) {}

  private prof(edge: number): BridgeProfile | undefined {
    return this.g.world.bridges.find((b) => b.edge === edge);
  }

  /** A point on an intact deck: its bridge, arc length and deck height; null off decks and in gaps. */
  deckAt(x: number, z: number): { edge: number; s: number; y: number; prof: BridgeProfile } | null {
    for (const b of this.g.world.bridges) {
      const dx = x - b.ax, dz = z - b.az, s = dx * b.dx + dz * b.dz;
      if (s < b.s0 || s > b.s1 || Math.abs(-dx * b.dz + dz * b.dx) > b.width / 2 || inGap(b.gaps, s)) continue;
      return { edge: b.edge, s, y: b.y(s), prof: b };
    }
    return null;
  }

  /** The deck range that would fall around s: between piers, else a 16–24 m piece; inside the ends, clear of gaps. */
  spanAt(edge: number, s: number): [number, number] | null {
    const p = this.prof(edge);
    return p ? breakSpan(p, s, this.gaps.filter((q) => q.edge === edge)) : null;
  }

  /** Brings the span around s down: gap, mesh, ground, traffic, the cars and people on it, and the show. */
  collapse(edge: number, s: number, cause: Cause = 'threat'): BridgeGap | null {
    const g = this.g, p = this.prof(edge), span = this.spanAt(edge, s);
    if (!p || !span) return null;
    const [s0, s1] = span;
    const gap: BridgeGap = { edge, s0, s1, until: g.sky.hoursAbs + BRIDGE_BREAK.keepH, seed: Rng.from('bridgeGap', edge, Math.round(s0 * 10), Math.floor(g.sky.hoursAbs * 60)).nextU32() };
    this.gaps.push(gap);
    this.sync();
    this.mendGround(gap);
    const half = p.width / 2, G = s1 - s0, sm = (s0 + s1) / 2, ym = p.y(sm), wl = p.waterLevel;
    const cx = p.ax + p.dx * sm, cz = p.az + p.dz * sm;
    const onGap = (x: number, y: number, z: number, pad: number) => {
      const dx = x - p.ax, dz = z - p.az, t = dx * p.dx + dz * p.dz;
      return t > s0 - pad && t < s1 + pad && Math.abs(-dx * p.dz + dz * p.dx) < half + pad && Math.abs(y - p.y(t)) < 4;
    };
    // Cars on it go into the river with a small push; people on it fall.
    for (const v of [...g.traffic.vehicles, ...g.parkedCars]) {
      if (v.state === VState.Crushed || v.state === VState.Wreck || !onGap(v.x, v.y, v.z, 1)) continue;
      g.traffic.wreckIt(v);
      g.vehicles.makeWreck(v, v.x, v.y + 1, v.z, (Math.random() - 0.5) * 3000, -1500, (Math.random() - 0.5) * 3000);
      g.consequences.record('leviathan', 'car', 'wreck', v.x, v.z, v, cause);
    }
    for (const a of g.peds.neighbours(cx, cz, G / 2 + half + 2, [])) {
      if (!isUp(a) || !onGap(a.x, a.y, a.z, 0.5)) continue;
      g.reactions.knockDown(a, cx, cz, 4, downCauseOf(cause));
      g.consequences.record('leviathan', 'person', 'knockdown', a.x, a.z, a, cause);
    }
    // The deck breaking up as it drops.
    const rng = Rng.from('bridgeFall', gap.seed);
    const n = rng.int(6, 10);
    for (let i = 0; i < n; i++) {
      const t = rng.range(s0 + 1, s1 - 1), o = rng.range(-half + 1, half - 1), y = p.y(t) - 0.6;
      const tar = rng.chance(0.4);
      g.debris.spawn(p.ax + p.dx * t - p.dz * o, y, p.az + p.dz * t + p.dx * o, rng.range(1.5, 3.2), rng.range(0.4, 0.9), rng.range(1.5, 3.2),
        rng.range(-1.5, 1.5), rng.range(-3, 0), rng.range(-1.5, 1.5), tar ? 16 : 8, tar ? TAR : DECK, rng.range(1, 3));
    }
    const cam = g.renderer.camera.position;
    g.dust.burst(cx, ym, cz, 30, half + G * 0.4, 5, 5, 6, DUST, 0.3, 0.55);
    g.audio.play('collapse_big', cx, ym, cz, 1, 0.8, 80, cam);
    g.stimuli.emit('collapse', cx, ym, cz, 8, 700, { cause, size: G });
    g.camRig.addShake(Math.min(0.6, 80 / Math.max(40, Math.hypot(cam.x - cx, cam.z - cz))));
    g.consequences.record('leviathan', 'bridge', 'collapse', cx, cz, undefined, cause);
    // The splash when it hits the water.
    g.later.after(Math.sqrt((2 * Math.max(1, ym - wl)) / 9.8), () => {
      g.dust.burst(cx, wl + 0.5, cz, 30, half + G * 0.4, 7, 4, 3, FOAM, -0.2, 0.7);
      for (let i = 0; i < 24; i++) {
        const t = s0 + Math.random() * G, o = (Math.random() - 0.5) * p.width;
        g.elements.fx.soft(p.ax + p.dx * t - p.dz * o, wl + 0.5, p.az + p.dz * t + p.dx * o, (Math.random() - 0.5) * 10, 8 + Math.random() * 12, (Math.random() - 0.5) * 10, 2, 1.5, 4, WATER_A, WATER_B, 0.6, 0.3, 9.8);
      }
      g.audio.play('splash_big', cx, wl, cz, 1, 0.6, 60, g.renderer.camera.position);
    });
    return gap;
  }

  /** Mends gaps whose time is up, when the camera is far enough not to see it happen. */
  update(dt: number): void {
    if ((this.checkT -= dt) > 0 || !this.gaps.length) return;
    this.checkT = 1;
    this.turnCars();
    const now = this.g.sky.hoursAbs, cam = this.g.renderer.camera.position;
    let changed = false;
    for (let i = this.gaps.length - 1; i >= 0; i--) {
      const q = this.gaps[i], p = this.prof(q.edge);
      if (q.until > now) continue;
      const sm = (q.s0 + q.s1) / 2;
      if (p && Math.hypot(cam.x - (p.ax + p.dx * sm), cam.z - (p.az + p.dz * sm)) < BRIDGE_BREAK.mendDist) continue;
      this.gaps.splice(i, 1);
      this.mendGround(q);
      changed = true;
    }
    if (changed) this.sync();
  }

  /** Cars stopped at a broken end on the cut street itself turn round (they would wait there for a day). */
  private turnCars(): void {
    const T = this.g.traffic, holds = T.holds.filter((h) => (h as { bridge?: boolean }).bridge);
    if (!holds.length) return;
    for (const v of T.vehicles) {
      if (v.state !== VState.Drive || v.task || v.speed > 0.5 || !this.g.net.closed(v.edge)) continue;
      const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
      // (Facing the broken end, close to it.)
      if (holds.some((h) => { const dx = h.x - v.x, dz = h.z - v.z; return Math.hypot(dx, dz) < 30 && dx * fx + dz * fz > 0; })) T.turnBack(v);
    }
  }

  /** Saves: [edge, s0, s1, until, seed] per gap. */
  saveState(): number[][] {
    return this.gaps.map((q) => [q.edge, Math.round(q.s0 * 100) / 100, Math.round(q.s1 * 100) / 100, Math.round(q.until * 1000) / 1000, q.seed]);
  }

  restoreState(rows: number[][]): void {
    const old = this.gaps.splice(0);
    for (const r of rows) {
      if (r.length < 5 || !r.every(Number.isFinite) || !this.prof(r[0]) || !(r[2] > r[1])) continue;
      this.gaps.push({ edge: r[0], s0: r[1], s1: r[2], until: r[3], seed: r[4] >>> 0 });
    }
    if (!old.length && !this.gaps.length) return;
    for (const q of [...old, ...this.gaps]) this.mendGround(q);
    this.sync();
  }

  /** Dev: the open gaps. */
  status(): string {
    const now = this.g.sky.hoursAbs;
    return this.gaps.map((q) => `edge ${q.edge} ${q.s0.toFixed(0)}–${q.s1.toFixed(0)} m, ${(q.until - now).toFixed(1)} h left`).join(' · ') || 'no gaps';
  }

  /** Gaps onto the profiles, the traffic holds, the road network's cuts and the mesh. */
  private sync(): void {
    const g = this.g;
    for (const b of g.world.bridges) {
      const mine = this.gaps.filter((q) => q.edge === b.edge);
      b.gaps = mine.length ? mine.map((q) => [q.s0, q.s1]) : undefined;
    }
    this.syncHolds();
    // Nobody routes over a gap any more; people walking up to one turn back (Pedestrians.cuts).
    const cuts = this.gaps.flatMap((q) => {
      const p = this.prof(q.edge);
      if (!p) return [];
      const sm = (q.s0 + q.s1) / 2;
      return [{ x: p.ax + p.dx * sm, z: p.az + p.dz * sm, r: Math.max((q.s1 - q.s0) / 2, 3) + 0.5 }];
    });
    g.net.setCuts(cuts);
    g.peds.cuts = cuts;
    g.traffic.rerouteCuts();
    const specs: BridgeGapSpec[] = this.gaps.map((q) => ({ edge: q.edge, s0: q.s0, s1: q.s1, seed: q.seed }));
    g.streamer.rebuildBridges(specs).catch((e) => console.warn('bridge rebuild failed', e));
  }

  /** A stop sign just short of each broken end, on the deck that is left. */
  private syncHolds(): void {
    const T = this.g.traffic.holds;
    for (let i = T.length - 1; i >= 0; i--) if ((T[i] as { bridge?: boolean }).bridge) T.splice(i, 1);
    for (const q of this.gaps) {
      const p = this.prof(q.edge);
      if (!p) continue;
      const r = p.width / 2;
      for (const [e, d] of [[q.s0, -1], [q.s1, 1]]) {
        const s = e + d * 1.5;
        if (s < p.s0 || s > p.s1 || inGap(p.gaps, s)) continue;
        T.push({ x: p.ax + p.dx * s, z: p.az + p.dz * s, r, bridge: true } as { x: number; z: number; r: number });
      }
    }
  }

  /** The physics ground over a gap samples the decks again. */
  private mendGround(q: BridgeGap): void {
    const p = this.prof(q.edge);
    if (!p) return;
    const h = p.width / 2 + 2;
    const xs = [q.s0, q.s1].flatMap((s) => [p.ax + p.dx * s - p.dz * h, p.ax + p.dx * s + p.dz * h]);
    const zs = [q.s0, q.s1].flatMap((s) => [p.az + p.dz * s + p.dx * h, p.az + p.dz * s - p.dx * h]);
    this.g.physics.invalidateGround(Math.min(...xs) - 2, Math.min(...zs) - 2, Math.max(...xs) + 2, Math.max(...zs) + 2);
  }
}

/**
 * The deck range of bridge `p` that falls around s: between neighbouring piers (stone, girder),
 * else a 16–24 m piece (its length from the spot); kept `endKeep` inside the deck ends and clear
 * of the existing `gaps`. Null when too little room is left.
 */
export function breakSpan(p: BridgeProfile, s: number, gaps: readonly { s0: number; s1: number }[]): [number, number] | null {
  const B = BRIDGE_BREAK;
  if (gaps.some((q) => s >= q.s0 && s <= q.s1)) return null;
  const piers = bridgePiers(p.style, p.s0, p.s1);
  let a: number, b: number;
  if (piers.length) {
    const st = [p.s0, ...piers, p.s1];
    let k = 0;
    while (k < st.length - 2 && s >= st[k + 1]) k++;
    a = st[k] + (k > 0 ? B.pierInset : 0);
    b = st[k + 1] - (k + 1 < st.length - 1 ? B.pierInset : 0);
  } else {
    const len = B.piece[0] + (B.piece[1] - B.piece[0]) * Rng.from('bridgeSpan', Math.round(s)).float();
    a = s - len / 2; b = s + len / 2;
  }
  a = Math.max(a, p.s0 + B.endKeep);
  b = Math.min(b, p.s1 - B.endKeep);
  for (const q of gaps) {
    if (q.s1 <= s) a = Math.max(a, q.s1);
    if (q.s0 >= s) b = Math.min(b, q.s0);
  }
  return b - a >= B.minLen ? [a, b] : null;
}
