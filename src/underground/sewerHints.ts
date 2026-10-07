/**
 * The way to the hidden colonies, written into the sewers (pure, deterministic per seed).
 *
 * The sewers form one network (culverts under the rivers join the banks). From every colony
 * whose gap opens off a sewer room the network is searched outwards (shortest way along the
 * trunks), and the Lumen have left their sign on it:
 *
 *  - Marks: at every junction, at eye height, on the wall of the branch that leads towards the nearest colony
 *    (a few metres in), that colony's own glowing sign — the same ones that cover its chamber's
 *    walls. Faint far away, brighter the nearer one gets. Following the marks leads to the room
 *    with the gap.
 *  - Trails: within a few hundred metres, a faint dotted glow on the walkway along that way,
 *    stronger towards the room.
 *
 * Nothing says what they mean; whoever notices that the same sign is always on one branch can
 * follow it.
 */
import { pointOnTube } from './layout';
import { tubeAt, type Tube } from './Volumes';
import type { MacroPlan } from '../plan/types';
import type { RoomPlan } from './rooms';
import { MinHeap } from '../core/heap';

export interface SewerHint {
  /** mark: the colony's sign on a wall; arrow: a big arrow on the junction's walkways into the right branch;
   *  chevron: a glowing V on the walkway pointing the way; scout: a lone Lumen who flees down the branch. */
  kind: 'mark' | 'arrow' | 'chevron' | 'scout';
  x: number; y: number; z: number;
  /** Facing (marks: into the tunnel) or the way to the colony (arrows, chevrons, scouts: unit). */
  nx: number; nz: number;
  /** 0..1: how strong the glow is. */
  s: number;
  /** Which colony's sign (0..3). */
  sign: number;
}

/** Chevron trails within this distance (m along the sewers) of a colony's room; marks fade out over
 *  MARK_FADE; scouts wait at junctions within SCOUT_REACH. */
export const TRAIL_REACH = 900, MARK_FADE = 1600, SCOUT_REACH = 650;

/**
 * `tubes`: the Underground's tube list (metro lines first, then one per macro.sewers entry).
 */
export function planSewerHints(macro: MacroPlan, tubes: Tube[], rooms: RoomPlan): SewerHint[] {
  const nMetro = macro.metroLines.length;
  const S = macro.sewers;
  const T = (k: number) => tubes[nMetro + k];
  const len = S.map((_, k) => { const t = T(k); return t.cum[t.cum.length - 1]; });
  // Trunks per node.
  const at = new Map<number, number[]>();
  S.forEach((s, k) => { for (const n of [s.a, s.b]) { let l = at.get(n); if (!l) at.set(n, (l = [])); l.push(k); } });
  // Shortest way from every node to the nearest colony room (Dijkstra over the junctions).
  const dist = new Map<number, number>(), via = new Map<number, number>(), sign = new Map<number, number>();
  const src: { k: number; s: number; sign: number }[] = [];
  for (const c of rooms.colonies) {
    const r = rooms.rooms[c.room];
    if (r.net !== 'sewer') continue;
    src.push({ k: r.tube - nMetro, s: r.s, sign: c.id % 4 });
  }
  if (!src.length) return [];
  const heap = new MinHeap();
  const push = (n: number, d: number, k: number, sg: number) => {
    if (d >= (dist.get(n) ?? Infinity)) return;
    dist.set(n, d); via.set(n, k); sign.set(n, sg);
    heap.push(d, n);
  };
  for (const q of src) { const s = S[q.k]; push(s.a, q.s, q.k, q.sign); push(s.b, len[q.k] - q.s, q.k, q.sign); }
  while (heap.size) {
    const n = heap.pop(), d = heap.lastPriority;
    if (d > (dist.get(n) ?? Infinity)) continue;
    for (const k of at.get(n) ?? []) {
      const o = S[k].a === n ? S[k].b : S[k].a;
      push(o, d + len[k], k, sign.get(n)!);
    }
  }
  const out: SewerHint[] = [];
  const sewers = S.map((_, k) => T(k));
  /** A spot in trunk k at arc s, on the side `side` at lateral offset `lat` (inside another trunk: null). */
  const spot = (k: number, s: number, lat: number) => {
    const t = T(k), p = pointOnTube(t, s);
    if (!p) return null;
    const lx = -p.dz, lz = p.dx;
    const x = p.x + lx * lat, z = p.z + lz * lat;
    for (let j = 0; j < sewers.length; j++) if (j !== k && sewers[j].bounds[0] < x && sewers[j].bounds[2] > x && sewers[j].bounds[1] < z && sewers[j].bounds[3] > z && tubeAt(sewers[j], x, p.y + 1, z, 0.3)) return null;
    return { x, y: p.y, z, lx, lz };
  };
  // Side rooms' doorways cut the walls: keep the marks clear of them.
  const doorNear = (k: number, s: number, side: number) => rooms.rooms.some((r) => r.tube === nMetro + k && r.side === side && Math.abs(r.s - s) < 5);
  // At every junction: the colony's sign on both walls of the branch that leads to it, a smear on
  // the floor pointing into it; near the colonies a scout waiting there now and then.
  for (const [n, d] of dist) {
    const k = via.get(n)!, L = len[k], hw = T(k).halfWidth;
    const arms = at.get(n)?.length ?? 0;
    if (arms < 2 && d > 30) continue;
    const fromA = S[k].a === n;
    const strength = Math.max(0.45, Math.min(1, 1.15 - d / MARK_FADE));
    const sg = sign.get(n)!;
    const s0 = Math.min(L / 2, 5.5);
    const s = fromA ? s0 : L - s0;
    for (const side of [1, -1]) {
      if (doorNear(k, s, side)) continue;
      const q = spot(k, s, side * (hw - 0.03));
      if (!q) continue;
      out.push({ kind: 'mark', x: q.x, y: q.y + 1.45, z: q.z, nx: -side * q.lx, nz: -side * q.lz, s: strength, sign: sg });
    }
    // The way into the branch (unit, along the trunk from the node).
    const p0 = pointOnTube(T(k), fromA ? Math.min(L, 2) : Math.max(0, L - 2));
    if (!p0) continue;
    const dx = fromA ? p0.dx : -p0.dx, dz = fromA ? p0.dz : -p0.dz;
    // On both walkways (the middle is the channel).
    for (const side of [1, -1]) {
      const qa = spot(k, fromA ? Math.min(L / 2, 1.6) : Math.max(L / 2, L - 1.6), side * (hw - 0.55));
      if (qa) out.push({ kind: 'arrow', x: qa.x, y: qa.y, z: qa.z, nx: dx, nz: dz, s: strength, sign: sg });
    }
    if (d < SCOUT_REACH && arms >= 3 && hashf(n * 7919 + k) < 0.55) {
      const sd = (n + k) % 2 ? 1 : -1;
      const qs = spot(k, fromA ? Math.min(L / 2, 2.2) : Math.max(L / 2, L - 2.2), sd * (hw - 0.45));
      if (qs) out.push({ kind: 'scout', x: qs.x, y: qs.y, z: qs.z, nx: dx, nz: dz, s: 1, sign: sg });
    }
  }
  // Chevrons: along the way within reach, on one walkway, pointing towards the colony.
  for (const [n, d] of dist) {
    if (d > TRAIL_REACH) continue;
    const k = via.get(n)!, L = len[k], hw = T(k).halfWidth;
    const fromA = S[k].a === n;
    // How far along this trunk the way goes: to its other end, or (the colony's own trunk) to the room.
    const own = src.find((q) => q.k === k);
    const span = own ? (fromA ? own.s : L - own.s) : L;
    const side = (n + k) % 2 ? 1 : -1;
    for (let u = 4; u < span - 1; u += 2.6) {
      const left = d - u;
      if (left > TRAIL_REACH) continue;
      const s = fromA ? u : L - u;
      const q = spot(k, s, side * (hw - 0.55));
      if (!q) continue;
      const p = pointOnTube(T(k), s);
      if (!p) continue;
      out.push({ kind: 'chevron', x: q.x, y: q.y, z: q.z, nx: fromA ? p.dx : -p.dx, nz: fromA ? p.dz : -p.dz, s: Math.max(0.2, 1 - Math.max(0, left) / TRAIL_REACH), sign: sign.get(n)! });
    }
  }
  return out;
}

function hashf(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
