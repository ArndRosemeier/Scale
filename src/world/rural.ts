/**
 * Countryside settlements and roads: hamlets, villages and small towns, farmsteads with their
 * yards (and some with an orchard), and the country roads, village lanes and farm tracks that
 * join them to each other and to the city's outer arterial ring.
 *
 * A pure function of the terrain, the land use and the macro plan (every worker builds the same
 * plan at init, ~tens of ms). The buildings of a settlement are laid out lazily (`layout`) as
 * ordinary `BuildingDesc`s, so the city's building shells, facades and roofs draw them.
 *
 * The land use reads the plan back (`clearing`, `roadEdge`): fields and forest keep off the
 * villages, yards and roads, so it must be built from the land use before it is attached to it.
 */
import { Rng, deriveSeed } from '../core/rng';
import { chaikin, ensureCCW, resample, closestOnPolyline, pointInPoly, type Poly } from '../core/geom2';
import { clamp, smoothstep } from '../core/math';
import { STYLES, WallMat, RoofMat, type BuildingDesc, type StyleId, type RoofKind } from '../plan/building';
import { cityName } from '../plan/names';
import type { MacroPlan } from '../plan/types';
import type { Terrain } from './terrain';
import { newLandSample, type LandUse } from './landuse';
import { airfieldEdge } from './airfield';

export const enum RoadKind { Main = 0, Lane = 1, Track = 2 }
/** Half widths of the road kinds (m). */
export const ROAD_HW = [3.3, 2.5, 1.6];

export interface RuralRoad {
  id: number;
  kind: RoadKind;
  /** Centreline (x, z, …), ~8 m spacing. */
  pts: number[];
  hw: number;
  /** Metres at the start drawn by the city's ground (a road leaving from an arterial gate). */
  trim: number;
  /** Settlements at its ends (-1: the city / none). */
  a: number;
  b: number;
}

export const enum SettleKind { Hamlet = 0, Village = 1, Town = 2, Farm = 3 }

export interface Settlement {
  id: number;
  kind: SettleKind;
  name: string;
  x: number;
  z: number;
  /** Radius of the built-up area (farms: of the yard). */
  r: number;
  seed: number;
  /** Radius of the square (or the paved junction) at the centre; 0 for farms. */
  square: number;
  /** Farms: frame angle (u axis) and yard half extents; the gate is on the -u side. */
  angle: number;
  hu: number;
  hv: number;
  /** Farms: orchard rectangle in the frame (u0, v0, u1, v1), or null. */
  orchard: [number, number, number, number] | null;
  /** Roads ending here. */
  roads: number[];
}

export interface PavedArea {
  poly: Poly;
  /** GroundLayer (build/ground). */
  layer: number;
}

export interface SettlementLayout {
  buildings: BuildingDesc[];
  /** Per building: oriented box cx, cz, hu, hv, ux, uz (BOX_STRIDE). */
  boxes: number[];
  paved: PavedArea[];
}
export const BOX_STRIDE = 6;

const RB = 64;
/** Road segments are indexed this far beyond their edge (the widest query margin). */
const ROAD_PAD = 16;
const SB = 512;
const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);

/** Ground layers used here (kept in sync with build/ground GroundLayer). */
const L_ASPHALT = 0, L_PLAZA = 4, L_COBBLE = 5, L_GRAVEL = 6, L_DIRT = 11;

interface Node { x: number; z: number; settle: number; junction: number; dirs: number[]; gate: boolean; trim: number }

export class RuralPlan {
  readonly settlements: Settlement[] = [];
  readonly roads: RuralRoad[] = [];
  private roadHash = new Map<number, number[]>();
  private setHash = new Map<number, number[]>();
  private layouts = new Map<number, SettlementLayout>();
  private seed: number;
  private ls = newLandSample();

  constructor(readonly terrain: Terrain, readonly land: LandUse, macro: MacroPlan) {
    this.seed = deriveSeed(terrain.profile.seed, 'rural');
    const nodes = this.gates(macro);
    const villages = this.villages();
    for (const v of villages) nodes.push({ x: v.x, z: v.z, settle: v.id, junction: Math.max(18, v.square + 8), dirs: [], gate: false, trim: 0 });
    this.pending = villages;
    this.mainRoads(nodes);
    this.pending = null;
    // Villages no road reached are dropped (a village in the middle of nowhere looks wrong).
    const keep = villages.filter((v) => v.roads.length > 0);
    const remap = new Map<number, number>();
    for (const v of keep) { remap.set(v.id, this.settlements.length); v.id = this.settlements.length; this.settlements.push(v); }
    for (const r of this.roads) { r.a = r.a >= 0 ? remap.get(r.a) ?? -1 : -1; r.b = r.b >= 0 ? remap.get(r.b) ?? -1 : -1; }
    for (const v of keep) this.lanes(v);
    this.farms();
    for (const s of this.settlements) {
      const R = s.kind === SettleKind.Farm ? Math.hypot(s.hu, s.hv) + 80 : s.r * 1.2 + 20;
      for (let i = Math.floor((s.x - R) / SB); i <= Math.floor((s.x + R) / SB); i++) {
        for (let j = Math.floor((s.z - R) / SB); j <= Math.floor((s.z + R) / SB); j++) {
          const k = key(i, j);
          let l = this.setHash.get(k);
          if (!l) this.setHash.set(k, (l = []));
          l.push(s.id);
        }
      }
    }
  }

  // ------------------------------------------------------------------ queries

  /**
   * Distance from (x, z) to the edge of the nearest road (negative on it); Infinity farther than
   * ROAD_PAD beyond every edge. `kind` (when given) receives the road's kind.
   */
  roadEdge(x: number, z: number, kind?: { k: RoadKind; road: number }): number {
    const l = this.roadHash.get(key(Math.floor(x / RB), Math.floor(z / RB)));
    if (!l) return Infinity;
    let best = Infinity;
    for (let q = 0; q < l.length; q += 2) {
      const R = this.roads[l[q]], i = l[q + 1] * 2, P = R.pts;
      const ax = P[i], az = P[i + 1], dx = P[i + 2] - ax, dz = P[i + 3] - az, l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1) : 0;
      const d = Math.hypot(ax + dx * t - x, az + dz * t - z) - R.hw;
      if (d < best) { best = d; if (kind) { kind.k = R.kind; kind.road = R.id; } }
    }
    return best;
  }

  /** Settlements whose area may reach (x, z). */
  near(x: number, z: number): readonly number[] {
    return this.setHash.get(key(Math.floor(x / SB), Math.floor(z / SB))) ?? EMPTY;
  }

  /** How much (x, z) belongs to a settlement, yard or orchard (0..1): fields and forest give way. */
  clearing(x: number, z: number): number {
    let c = 0;
    for (const id of this.near(x, z)) {
      const s = this.settlements[id];
      if (s.kind === SettleKind.Farm) {
        const [u, v] = this.toFrame(s, x, z);
        c = Math.max(c, 1 - smoothstep(1, 6, Math.max(Math.abs(u) - s.hu, Math.abs(v) - s.hv)));
        const o = s.orchard;
        if (o) c = Math.max(c, 1 - smoothstep(1, 6, Math.max(o[0] - u, u - o[2], o[1] - v, v - o[3])));
      } else {
        // Houses and gardens along the streets (fields reach up to the back gardens).
        const d = Math.hypot(x - s.x, z - s.z);
        if (d > s.r * 1.25) continue;
        const S = this.streetSegs(s);
        let ds = d - s.square;
        for (let o = 0; o < S.length; o += 4) {
          const ax = S[o], az = S[o + 1], dx = S[o + 2] - ax, dz = S[o + 3] - az, l2 = dx * dx + dz * dz;
          const t = l2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1) : 0;
          ds = Math.min(ds, Math.hypot(ax + dx * t - x, az + dz * t - z));
        }
        // (Narrow edges: the grass of a wide fade reads as a dark smudge on the fields from afar.)
        const depth = s.kind === SettleKind.Town ? 34 : 30;
        c = Math.max(c, (1 - smoothstep(depth, depth + 8, ds)) * (1 - smoothstep(s.r, s.r * 1.1, d)));
      }
      if (c >= 1) break;
    }
    return c;
  }

  private segs = new Map<number, number[]>();
  /** Street segments of a village within its built-up radius (ax, az, bx, bz, …). */
  private streetSegs(s: Settlement): number[] {
    let S = this.segs.get(s.id);
    if (S) return S;
    S = [];
    for (const id of s.roads) {
      const P = this.roads[id].pts;
      for (let i = 0; i + 3 < P.length; i += 2) {
        if (Math.hypot(P[i] - s.x, P[i + 1] - s.z) > s.r * 1.05 && Math.hypot(P[i + 2] - s.x, P[i + 3] - s.z) > s.r * 1.05) continue;
        S.push(P[i], P[i + 1], P[i + 2], P[i + 3]);
      }
    }
    this.segs.set(s.id, S);
    return S;
  }

  /** Is (x, z) within `margin` of a building of a settlement? */
  onBuilding(x: number, z: number, margin: number): boolean {
    for (const id of this.near(x, z)) {
      const s = this.settlements[id];
      const R = s.kind === SettleKind.Farm ? Math.hypot(s.hu, s.hv) + 10 : s.r * 1.1 + 20;
      if (Math.abs(x - s.x) > R + margin || Math.abs(z - s.z) > R + margin) continue;
      const B = this.layout(id).boxes;
      for (let o = 0; o < B.length; o += BOX_STRIDE) {
        const dx = x - B[o], dz = z - B[o + 1];
        if (Math.abs(dx * B[o + 4] + dz * B[o + 5]) < B[o + 2] + margin && Math.abs(-dx * B[o + 5] + dz * B[o + 4]) < B[o + 3] + margin) return true;
      }
    }
    return false;
  }

  /** On a village square or a farmyard? */
  onPaved(x: number, z: number, margin: number): boolean {
    for (const id of this.near(x, z)) {
      const s = this.settlements[id];
      if (s.kind === SettleKind.Farm) {
        const [u, v] = this.toFrame(s, x, z);
        if (Math.abs(u) < s.hu + margin && Math.abs(v) < s.hv + margin) return true;
      } else if (Math.hypot(x - s.x, z - s.z) < s.square + margin) return true;
    }
    return false;
  }

  /** Farm frame coordinates of a world point. */
  toFrame(s: Settlement, x: number, z: number): [number, number] {
    const c = Math.cos(s.angle), n = Math.sin(s.angle), dx = x - s.x, dz = z - s.z;
    return [dx * c + dz * n, -dx * n + dz * c];
  }
  fromFrame(s: Settlement, u: number, v: number): [number, number] {
    const c = Math.cos(s.angle), n = Math.sin(s.angle);
    return [s.x + u * c - v * n, s.z + u * n + v * c];
  }

  // ------------------------------------------------------------------ villages

  /** Outermost arterial nodes, spread round the ring: where country roads leave the city. */
  private gates(macro: MacroPlan): Node[] {
    for (const c of macro.cells) this.cells.push({ poly: c.poly, box: polyBox(c.poly) });
    // On the outer ring: nothing of the city lies just beyond the node, radially outward.
    const cands = macro.nodes.map((n, i) => ({ n, i, e: this.land.edge(n.x, n.z) })).filter((c) => {
      if (c.n.edges.length < 2 || this.terrain.isWater(c.n.x, c.n.z, 25) || this.terrain.coastDistance(c.n.x, c.n.z) < 400) return false;
      const l = Math.hypot(c.n.x, c.n.z) || 1;
      for (const d of [25, 60, 150]) if (this.inCity(c.n.x + (c.n.x / l) * d, c.n.z + (c.n.z / l) * d)) return false;
      return true;
    });
    cands.sort((a, b) => b.e - a.e || a.i - b.i);
    const want = clamp(Math.round(this.terrain.profile.radius / 450), 5, 14);
    const out: Node[] = [];
    for (const c of cands) {
      if (out.length >= want) break;
      const a = Math.atan2(c.n.z, c.n.x);
      if (out.some((g) => Math.abs(angDiff(Math.atan2(g.z, g.x), a)) < (Math.PI * 2) / want * 0.6)) continue;
      let trim = 0;
      for (const e of c.n.edges) trim = Math.max(trim, macro.edges[e].width / 2 + macro.edges[e].sidewalk + 2);
      out.push({ x: c.n.x, z: c.n.z, settle: -1, junction: trim + 25, dirs: [], gate: true, trim });
    }
    return out;
  }

  private cells: { poly: Poly; box: [number, number, number, number] }[] = [];
  /** Inside one of the city's cells? */
  private inCity(x: number, z: number): boolean {
    for (const c of this.cells) if (x >= c.box[0] && x <= c.box[2] && z >= c.box[1] && z <= c.box[3] && pointInPoly(c.poly, x, z)) return true;
    return false;
  }

  private villages(): Settlement[] {
    const T = this.terrain, p = T.profile, ls = this.ls;
    const rng = new Rng(deriveSeed(this.seed, 'villages'));
    const G = 2300, W = T.worldExtent - 900;
    const n = Math.floor(W / G);
    const out: Settlement[] = [];
    for (let j = -n; j < n; j++) for (let i = -n; i < n; i++) {
      const r = rng.fork(i, j);
      if (!r.chance(0.72)) continue;
      const x = (i + r.range(0.15, 0.85)) * G, z = (j + r.range(0.15, 0.85)) * G;
      const roll = r.float();
      const kind = roll < 0.16 ? SettleKind.Town : roll < 0.62 ? SettleKind.Village : SettleKind.Hamlet;
      const rad = kind === SettleKind.Town ? r.range(230, 300) : kind === SettleKind.Village ? r.range(140, 190) : r.range(75, 100);
      if (this.land.edge(x, z) < 900 + rad) continue;
      if (T.isWater(x, z, 50 + rad * 0.35)) continue;
      if (p.coastal && T.coastDistance(x, z) < 120 + rad * 0.5) continue;
      if (T.airfield && airfieldEdge(T.airfield, x, z) < rad + 250) continue;
      const lq = T.lakeAt(x, z);
      if (lq.lake >= 0 && lq.e < rad * 0.4 + 30) continue;
      // Not on a steep slope; deep forest only now and then.
      let slope = 0;
      for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; slope += T.slope(x + Math.cos(a) * rad * 0.5, z + Math.sin(a) * rad * 0.5, 8); }
      if (slope / 6 > 0.13) continue;
      this.land.sample(x, z, ls);
      if (ls.forest > 0.6 && !r.chance(0.3)) continue;
      if (out.some((v) => Math.hypot(v.x - x, v.z - z) < v.r + rad + 700)) continue;
      const square = kind === SettleKind.Town ? r.range(24, 32) : kind === SettleKind.Village ? r.range(13, 19) : ROAD_HW[RoadKind.Main] + 3;
      const seed = r.nextU32();
      out.push({ id: out.length, kind, name: cityName(seed), x, z, r: rad, seed, square, angle: 0, hu: 0, hv: 0, orchard: null, roads: [] });
    }
    return out;
  }

  // ------------------------------------------------------------------ roads

  /** Index a road's segments (padded by its half width plus ROAD_PAD). */
  private indexRoad(R: RuralRoad): void {
    const P = R.pts, m = R.hw + ROAD_PAD;
    for (let i = 0; i + 3 < P.length; i += 2) {
      const x0 = Math.min(P[i], P[i + 2]) - m, x1 = Math.max(P[i], P[i + 2]) + m, z0 = Math.min(P[i + 1], P[i + 3]) - m, z1 = Math.max(P[i + 1], P[i + 3]) + m;
      for (let a = Math.floor(x0 / RB); a <= Math.floor(x1 / RB); a++) for (let b = Math.floor(z0 / RB); b <= Math.floor(z1 / RB); b++) {
        const k = key(a, b);
        let l = this.roadHash.get(k);
        if (!l) this.roadHash.set(k, (l = []));
        l.push(R.id, i >> 1);
      }
    }
  }

  private addRoad(kind: RoadKind, pts: number[], a: number, b: number, trim = 0): RuralRoad {
    const R: RuralRoad = { id: this.roads.length, kind, pts, hw: ROAD_HW[kind], trim, a, b };
    this.roads.push(R);
    this.indexRoad(R);
    return R;
  }

  /**
   * Does the polyline cross (or run within `gap` of) an existing road, other than within
   * `skipA` / `skipB` metres of its two ends?
   */
  private crosses(pts: number[], hw: number, gap: number, skipA: number, skipB: number): boolean {
    const n = pts.length >> 1;
    const ex = pts[pts.length - 2], ez = pts[pts.length - 1];
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2], z = pts[i * 2 + 1];
      if (Math.hypot(x - pts[0], z - pts[1]) < skipA || Math.hypot(x - ex, z - ez) < skipB) continue;
      if (this.roadEdge(x, z) < hw + gap) return true;
    }
    return false;
  }

  /** Can a road run along this polyline (dry, out of the city and the airfield)? */
  private passable(pts: number[], hw: number, cityOkA: number, cityOkB: number): boolean {
    const T = this.terrain, n = pts.length >> 1;
    const ex = pts[pts.length - 2], ez = pts[pts.length - 1];
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2], z = pts[i * 2 + 1];
      if (T.isWater(x, z, hw + 5)) return false;
      if (T.airfield && airfieldEdge(T.airfield, x, z) < hw + 25) return false;
      const d0 = Math.hypot(x - pts[0], z - pts[1]);
      const nearEnd = d0 < cityOkA || Math.hypot(x - ex, z - ez) < cityOkB;
      if (this.land.edge(x, z) < 40 && (!nearEnd || (d0 > 30 && this.inCity(x, z)))) return false;
    }
    return true;
  }

  /** A gently wandering polyline from a to b (ends fixed, straight for `lead` metres at each end). */
  private wander(r: Rng, ax: number, az: number, bx: number, bz: number, amp: number, lead: number): number[] {
    const L = Math.hypot(bx - ax, bz - az);
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    const n = Math.max(2, Math.round(L / 240));
    const ctrl: number[] = [ax, az];
    const ph = r.range(0, 100), f = r.range(0.6, 1.4);
    if (L > lead * 3) ctrl.push(ax + ux * lead, az + uz * lead);
    for (let i = 1; i < n; i++) {
      const s = (i / n) * L;
      if (s < lead * 1.5 || s > L - lead * 1.5) continue;
      const off = Math.sin(i * f + ph) * amp * 0.6 + Math.sin(i * f * 2.3 + ph * 1.7) * amp * 0.4;
      ctrl.push(ax + ux * s - uz * off, az + uz * s + ux * off);
    }
    if (L > lead * 3) ctrl.push(bx - ux * lead, bz - uz * lead);
    ctrl.push(bx, bz);
    const pts = resample(chaikin(ctrl, 3), 8);
    pts[0] = ax; pts[1] = az; pts[pts.length - 2] = bx; pts[pts.length - 1] = bz;
    return pts;
  }

  /**
   * Country roads: each village to its nearest neighbours (villages or city gates), shortest
   * first, keeping the network planar (no crossings without a junction), leaving each node at
   * distinct angles and keeping off the water, the city and the airfield.
   */
  private mainRoads(nodes: Node[]): void {
    const rng = new Rng(deriveSeed(this.seed, 'roads'));
    const cand: { a: number; b: number; d: number }[] = [];
    const seen = new Set<number>();
    nodes.forEach((A, ia) => {
      if (A.gate) return;
      const near = nodes.map((B, ib) => ({ ib, d: Math.hypot(B.x - A.x, B.z - A.z) })).filter((q) => q.ib !== ia && q.d < 7000).sort((p, q) => p.d - q.d);
      const k = this.settleKindOf(A) === SettleKind.Town ? 4 : 3;
      for (const q of near.slice(0, k)) {
        const lo = Math.min(ia, q.ib), hi = Math.max(ia, q.ib);
        if (seen.has(lo * 65536 + hi)) continue;
        seen.add(lo * 65536 + hi);
        cand.push({ a: lo, b: hi, d: q.d });
      }
    });
    // Gates reach out to the nearest villages too.
    nodes.forEach((G, ig) => {
      if (!G.gate) return;
      const near = nodes.map((B, ib) => ({ ib, d: Math.hypot(B.x - G.x, B.z - G.z) })).filter((q) => !nodes[q.ib].gate && q.d < 8000).sort((p, q) => p.d - q.d);
      for (const q of near.slice(0, 5)) {
        const lo = Math.min(ig, q.ib), hi = Math.max(ig, q.ib);
        if (seen.has(lo * 65536 + hi)) continue;
        seen.add(lo * 65536 + hi);
        cand.push({ a: lo, b: hi, d: q.d - 1e6 });
      }
    });
    // Out of the city first (one road per gate), then between the villages, shortest first.
    cand.sort((p, q) => p.d - q.d || p.a - q.a || p.b - q.b);
    const hw = ROAD_HW[RoadKind.Main];
    for (const c of cand) {
      // A gate end first (roads leave the city outward).
      let A = nodes[c.a], B = nodes[c.b];
      if (B.gate) [A, B] = [B, A];
      if (A.gate && B.gate) continue;
      if (A.gate && A.dirs.length) continue;
      // A road out of a gate leaves radially for a stretch, then turns for its village.
      const gl = Math.hypot(A.x, A.z) || 1, gx = A.x / gl, gz = A.z / gl, stub = 380;
      const sx = A.gate ? A.x + gx * stub : A.x, sz = A.gate ? A.z + gz * stub : A.z;
      const da = A.gate ? Math.atan2(gz, gx) : Math.atan2(B.z - A.z, B.x - A.x);
      const db = Math.atan2(sz - B.z, sx - B.x);
      if (A.gate && (B.x - sx) * gx + (B.z - sz) * gz < -0.35 * Math.hypot(B.x - sx, B.z - sz)) continue;
      const minSep = 0.62;
      if (A.dirs.some((d) => Math.abs(angDiff(d, da)) < minSep) || B.dirs.some((d) => Math.abs(angDiff(d, db)) < minSep)) continue;
      if (A.dirs.length >= 5 || B.dirs.length >= 5) continue;
      // Not straight through another village: the network goes via it instead.
      let through = false;
      for (const N of nodes) {
        if (N === A || N === B || N.gate) continue;
        const t = clamp(((N.x - sx) * (B.x - sx) + (N.z - sz) * (B.z - sz)) / Math.max(1, (B.x - sx) ** 2 + (B.z - sz) ** 2), 0, 1);
        if (Math.hypot(sx + (B.x - sx) * t - N.x, sz + (B.z - sz) * t - N.z) < this.radiusOf(N) + 60) { through = true; break; }
      }
      if (through) continue;
      const r = rng.fork(c.a, c.b);
      const D = Math.hypot(B.x - sx, B.z - sz);
      const withStub = (P: number[]) => (A.gate ? [...resample([A.x, A.z, sx, sz], 8).slice(0, -2), ...P] : P);
      let pts = withStub(this.wander(r, sx, sz, B.x, B.z, Math.min(120, D * 0.07), A.gate ? B.junction + 40 : Math.max(A.junction, B.junction) + 40));
      const cityA = A.gate ? stub + 40 : 0;
      const ok = (P: number[]) => this.passable(P, hw, cityA, 0) && !this.crosses(P, hw, 4, A.junction, B.junction);
      if (!ok(pts)) {
        pts = withStub(resample([sx, sz, B.x, B.z], 8));
        if (!ok(pts)) continue;
      }
      const R = this.addRoad(RoadKind.Main, pts, A.settle, B.settle, A.trim);
      A.dirs.push(da); B.dirs.push(db);
      if (A.settle >= 0) this.pending![A.settle].roads.push(R.id);
      if (B.settle >= 0) this.pending![B.settle].roads.push(R.id);
    }
  }

  /** The village candidates while the roads are planned (ids = indices). */
  private pending: Settlement[] | null = null;
  private settleKindOf(N: Node): SettleKind { return N.settle >= 0 && this.pending ? this.pending[N.settle].kind : SettleKind.Hamlet; }
  private radiusOf(N: Node): number { return N.settle >= 0 && this.pending ? this.pending[N.settle].r : 0; }

  /** Village lanes: spokes from the square into the directions the country roads leave free. */
  private lanes(v: Settlement): void {
    const r = new Rng(deriveSeed(v.seed, 'lanes'));
    const want = v.kind === SettleKind.Town ? r.int(3, 5) : v.kind === SettleKind.Village ? r.int(1, 3) : r.int(0, 1);
    const dirs = v.roads.map((id) => {
      const R = this.roads[id], P = R.pts;
      const i = R.b === v.id ? P.length - 4 : 2;
      return Math.atan2(P[i + 1] - v.z, P[i] - v.x);
    });
    const hw = ROAD_HW[RoadKind.Lane];
    for (let k = 0, tries = 0; k < want && tries < 14; tries++) {
      const a = r.range(-Math.PI, Math.PI);
      if (dirs.some((d) => Math.abs(angDiff(d, a)) < 0.75)) continue;
      const L = v.r * r.range(0.65, 1.0);
      const sx = v.x + Math.cos(a) * (v.square * 0.5), sz = v.z + Math.sin(a) * (v.square * 0.5);
      const bend = r.range(-0.18, 0.18) * L;
      const mx = v.x + Math.cos(a) * L * 0.55 - Math.sin(a) * bend, mz = v.z + Math.sin(a) * L * 0.55 + Math.cos(a) * bend;
      const ex = v.x + Math.cos(a) * L - Math.sin(a) * bend * 0.6, ez = v.z + Math.sin(a) * L + Math.cos(a) * bend * 0.6;
      let pts = resample(chaikin([sx, sz, mx, mz, ex, ez], 3), 8);
      pts[0] = sx; pts[1] = sz;
      // Cut where it would get wet or run onto another road.
      let cut = pts.length;
      for (let i = 0; i < pts.length; i += 2) {
        const x = pts[i], z = pts[i + 1];
        if (this.terrain.isWater(x, z, hw + 6) || (Math.hypot(x - v.x, z - v.z) > v.square + 12 && this.roadEdge(x, z) < hw + 6)) { cut = i; break; }
      }
      pts = pts.slice(0, cut);
      if (pts.length < 10) continue;
      dirs.push(a);
      const R = this.addRoad(RoadKind.Lane, pts, v.id, -1);
      v.roads.push(R.id);
      k++;
    }
    // Side lanes branching off the streets (a fishbone of back lanes in the bigger places).
    const branches = v.kind === SettleKind.Town ? r.int(4, 7) : v.kind === SettleKind.Village ? r.int(1, 3) : 0;
    const parents = v.roads.slice();
    for (let k = 0, tries = 0; k < branches && tries < 20 && parents.length; tries++) {
      const P0 = this.roads[r.pick(parents)];
      const P = P0.b === v.id ? reversedPts(P0.pts) : P0.pts;
      const n = P.length >> 1;
      let i = 0, sAcc = 0;
      const want = v.r * r.range(0.3, 0.75);
      while (i < n - 2 && sAcc < want) { sAcc += Math.hypot(P[i * 2 + 2] - P[i * 2], P[i * 2 + 3] - P[i * 2 + 1]); i++; }
      if (sAcc < want || i < 1) continue;
      const tx = P[i * 2 + 2] - P[i * 2 - 2], tz = P[i * 2 + 3] - P[i * 2 - 1], tl = Math.hypot(tx, tz) || 1;
      const side = r.sign(), a = Math.atan2(tz, tx) + side * (Math.PI / 2 + r.range(-0.3, 0.3));
      const L = r.range(50, 110);
      const sx = P[i * 2] + (-tz / tl) * side * (P0.hw - 0.5), sz = P[i * 2 + 1] + (tx / tl) * side * (P0.hw - 0.5);
      let pts = resample([sx, sz, sx + Math.cos(a) * L, sz + Math.sin(a) * L], 8);
      let cut = pts.length;
      for (let q = 0; q < pts.length; q += 2) {
        const x = pts[q], z = pts[q + 1];
        if (this.terrain.isWater(x, z, hw + 6) || Math.hypot(x - v.x, z - v.z) > v.r * 1.05 || (q >= 4 && this.roadEdge(x, z) < hw + 8)) { cut = q; break; }
      }
      pts = pts.slice(0, cut);
      if (pts.length < 8) continue;
      const R = this.addRoad(RoadKind.Lane, pts, v.id, -1);
      v.roads.push(R.id);
      k++;
    }
  }

  // ------------------------------------------------------------------ farms

  /** Farmsteads out in the fields, each with a track to the nearest road. */
  private farms(): void {
    const T = this.terrain, ls = this.ls, P = this.land.parcels;
    const rng = new Rng(deriveSeed(this.seed, 'farms'));
    const G = 820, W = T.worldExtent - 900;
    const n = Math.floor(W / G);
    const base = Math.atan2(P.sin, P.cos);
    const villages = this.settlements.slice();
    const bounds: [number, number, number, number][] = [];
    for (let j = -n; j < n; j++) for (let i = -n; i < n; i++) {
      const r = rng.fork(i, j);
      if (!r.chance(0.6)) continue;
      const x = (i + r.range(0.2, 0.8)) * G, z = (j + r.range(0.2, 0.8)) * G;
      if (this.land.edge(x, z) < 700) continue;
      this.land.sample(x, z, ls);
      if (ls.rural < 0.99 || ls.forest > 0.25) continue;
      if (ls.field < 0.45 && !(ls.meadow > 0.6 && r.chance(0.35))) continue;
      if (villages.some((v) => Math.hypot(v.x - x, v.z - z) < v.r + 260)) continue;
      const hu = r.range(21, 25), hv = r.range(16, 19);
      // Nearest road (main roads and lanes), at most 1.3 km away.
      let best: { d: number; px: number; pz: number } | null = null;
      for (const R of this.roads) {
        if (R.kind === RoadKind.Track) continue;
        const b = bounds[R.id] ??= polyBox(R.pts);
        if (x < b[0] - 1300 || x > b[2] + 1300 || z < b[1] - 1300 || z > b[3] + 1300) continue;
        const c = closestOnPolyline(R.pts, x, z);
        if (c.s < R.trim + 30) continue;
        if (!best || c.d < best.d) best = { d: c.d, px: c.px, pz: c.pz };
      }
      if (!best || best.d > 1300 || best.d < hu + 40) continue;
      // Frame: along the parcel grid, the gate (-u side) facing the road.
      const ta = Math.atan2(best.pz - z, best.px - x);
      let angle = base;
      for (let q = 0; q < 4; q++) { const a = base + (q * Math.PI) / 2; if (Math.cos(angDiff(a + Math.PI, ta)) > Math.cos(angDiff(angle + Math.PI, ta))) angle = a; }
      const s: Settlement = { id: this.settlements.length, kind: SettleKind.Farm, name: '', x, z, r: Math.hypot(hu, hv), seed: r.nextU32(), square: 0, angle, hu, hv, orchard: null, roads: [] };
      // The yard and its surroundings: dry, level enough, off the roads, the lakes and other farms.
      let ok = true;
      const hs: number[] = [];
      for (let a = -1; a <= 1 && ok; a++) for (let b = -1; b <= 1; b++) {
        const [px, pz] = this.fromFrame(s, a * (hu + 8), b * (hv + 8));
        if (T.isWater(px, pz, 12) || this.roadEdge(px, pz) < 6 || this.land.edge(px, pz) < 600) { ok = false; break; }
        hs.push(T.height(px, pz));
      }
      if (!ok || Math.max(...hs) - Math.min(...hs) > 7) continue;
      if (this.settlements.some((o) => o.kind === SettleKind.Farm && Math.hypot(o.x - x, o.z - z) < 300)) continue;
      // Track: from the gate straight to the road.
      const [gx, gz] = this.fromFrame(s, -hu, 0);
      const [ox, oz] = this.fromFrame(s, -hu - 10, 0);
      const L = Math.hypot(best.px - ox, best.pz - oz);
      const track = resample([gx, gz, ox, oz, best.px, best.pz], 8);
      const thw = ROAD_HW[RoadKind.Track];
      if (L < 12 || !this.passable(track, thw, 0, 0) || this.crosses(track, thw, 3, 0, ROAD_HW[RoadKind.Main] + 6)) continue;
      // Not through a village.
      if (villages.some((v) => { for (let q = 0; q < track.length; q += 8) if (Math.hypot(track[q] - v.x, track[q + 1] - v.z) < v.r * 0.9) return true; return false; })) continue;
      // An orchard beside the yard now and then.
      if (r.chance(0.4)) {
        const side = r.sign(), depth = r.range(30, 55);
        const o: [number, number, number, number] = side > 0 ? [-hu + 6, hv + 6, hu, hv + 6 + depth] : [-hu + 6, -hv - 6 - depth, hu, -hv - 6];
        let dry = true;
        for (const [u, v] of [[o[0], o[1]], [o[2], o[1]], [o[2], o[3]], [o[0], o[3]], [(o[0] + o[2]) / 2, (o[1] + o[3]) / 2]]) {
          const [px, pz] = this.fromFrame(s, u, v);
          if (T.isWater(px, pz, 5) || this.roadEdge(px, pz) < 4) dry = false;
        }
        if (dry) s.orchard = o;
      }
      this.settlements.push(s);
      const R = this.addRoad(RoadKind.Track, track, s.id, -1);
      s.roads.push(R.id);
    }
  }

  // ------------------------------------------------------------------ layouts

  /** Buildings and paved ground of a settlement (laid out on first use, then cached). */
  layout(id: number): SettlementLayout {
    let L = this.layouts.get(id);
    if (!L) {
      const s = this.settlements[id];
      L = s.kind === SettleKind.Farm ? this.farmLayout(s) : this.villageLayout(s);
      this.layouts.set(id, L);
    }
    return L;
  }

  /** Building styles of the place, from the city's architectural flavour. */
  private styleOf(r: Rng, core: boolean, town: boolean): StyleId {
    const a = this.terrain.profile.arch, warm = this.terrain.profile.warmth;
    const w: [StyleId, number][] = core
      ? [['timber', a.oldWorld * (1 - a.warm) * (1.2 - warm)], ['oldstone', 0.5 + a.oldWorld], ['mediterranean', a.warm * 2.5 + Math.max(0, warm - 0.6)], ['house', a.american * (town ? 0.5 : 1.2)]]
      : [['house', 3], ['timber', 0.4 * a.oldWorld * (1 - a.warm)], ['oldstone', 0.4 * a.oldWorld], ['mediterranean', a.warm * 1.2]];
    return r.weighted(w, (q) => q[1])[0];
  }

  private desc(r: Rng, id: number, poly: Poly, front: number, style: StyleId, opt: { floors?: number; roof?: RoofKind; pitch?: number; floorH?: number; walls?: WallMat[]; roofMats?: RoofMat[]; shop?: boolean; landmark?: boolean; use?: BuildingDesc['use'] }): BuildingDesc {
    const rule = STYLES[style];
    const floorH = opt.floorH ?? r.range(rule.floorH[0], rule.floorH[1]);
    let roof = opt.roof ?? r.pick(rule.roofs);
    if (roof === 'flat' && style !== 'warehouse' && r.chance(0.8)) roof = r.chance(0.6) ? 'gable' : 'hip';
    if (roof === 'mansard' || roof === 'sawtooth') roof = 'gable';
    return {
      id, poly, front, style,
      use: opt.use ?? (opt.shop ? 'mixed' : rule.use === 'mixed' ? 'residential' : rule.use),
      floors: opt.floors ?? 1, floorH, groundH: opt.floorH ?? r.range(rule.groundH[0], rule.groundH[1]),
      roof, pitch: opt.pitch ?? (roof === 'gable' || roof === 'hip' ? r.range(0.5, 0.95) : 0.2),
      setbacks: [], wall: r.pick(opt.walls ?? rule.walls), trim: r.int(0, 7), roofMat: r.pick(opt.roofMats ?? rule.roofMats), accent: r.int(0, 7),
      bay: r.range(rule.bay[0], rule.bay[1]), shopfront: !!opt.shop, seed: r.nextU32(), attached: false,
      units: rule.use === 'residential' || rule.use === 'mixed' ? 1 : 0, landmark: !!opt.landmark,
    };
  }

  /**
   * A rectangle (centre, axis u, half extents) as a CCW footprint; `front` = the edge whose
   * outward normal points along `fdir` (x, z).
   */
  private rect(cx: number, cz: number, ux: number, uz: number, hu: number, hv: number, fx: number, fz: number): { poly: Poly; front: number } {
    const vx = -uz, vz = ux;
    const poly = ensureCCW([
      cx - ux * hu - vx * hv, cz - uz * hu - vz * hv,
      cx + ux * hu - vx * hv, cz + uz * hu - vz * hv,
      cx + ux * hu + vx * hv, cz + uz * hu + vz * hv,
      cx - ux * hu + vx * hv, cz - uz * hu + vz * hv,
    ]);
    let front = 0, best = -Infinity;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const mx = (poly[i * 2] + poly[j * 2]) / 2 - cx, mz = (poly[i * 2 + 1] + poly[j * 2 + 1]) / 2 - cz;
      const d = (mx * fx + mz * fz) / (Math.hypot(mx, mz) || 1);
      if (d > best) { best = d; front = i; }
    }
    return { poly, front };
  }

  /** Can a box stand here: dry, fairly level, off the roads, the squares and the other boxes? */
  private fits(boxes: number[], cx: number, cz: number, ux: number, uz: number, hu: number, hv: number, own: Settlement): boolean {
    const T = this.terrain, vx = -uz, vz = ux;
    let lo = Infinity, hi = -Infinity;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const x = cx + ux * hu * a + vx * hv * b, z = cz + uz * hu * a + vz * hv * b;
      if (T.isWater(x, z, 3) || this.roadEdge(x, z) < 1.2) return false;
      if (own.kind !== SettleKind.Farm && Math.hypot(x - own.x, z - own.z) < own.square + 2) return false;
      const h = T.height(x, z);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    if (hi - lo > 3.5) return false;
    // Oriented boxes apart (separating axes, with a gap).
    const gap = 1.2;
    for (let o = 0; o < boxes.length; o += BOX_STRIDE) {
      if (Math.hypot(boxes[o] - cx, boxes[o + 1] - cz) > Math.hypot(hu, hv) + Math.hypot(boxes[o + 2], boxes[o + 3]) + gap) continue;
      if (obbOverlap(cx, cz, ux, uz, hu + gap / 2, hv + gap / 2, boxes[o], boxes[o + 1], boxes[o + 4], boxes[o + 5], boxes[o + 2] + gap / 2, boxes[o + 3] + gap / 2)) return false;
    }
    return true;
  }

  private villageLayout(v: Settlement): SettlementLayout {
    const r = new Rng(deriveSeed(v.seed, 'layout'));
    const out: SettlementLayout = { buildings: [], boxes: [], paved: [] };
    const town = v.kind === SettleKind.Town, a = this.terrain.profile.arch;
    const add = (d: BuildingDesc, cx: number, cz: number, ux: number, uz: number, hu: number, hv: number) => {
      out.buildings.push(d);
      out.boxes.push(cx, cz, hu, hv, ux, uz);
    };
    // The square (or a paved junction where the roads meet).
    const sq: number[] = [];
    for (let i = 0; i < 28; i++) {
      const t = (i / 28) * Math.PI * 2;
      const rr = v.square * (v.kind === SettleKind.Hamlet ? 1 : 1 + 0.08 * Math.sin(t * 3 + v.seed % 7));
      sq.push(v.x + Math.cos(t) * rr, v.z + Math.sin(t) * rr);
    }
    out.paved.push({ poly: sq, layer: v.kind === SettleKind.Hamlet ? L_ASPHALT : a.oldWorld > a.american ? L_COBBLE : L_PLAZA });
    // Directions of the streets leaving the square.
    const dirs = v.roads.map((id) => {
      const R = this.roads[id], P = R.pts;
      const i = R.b === v.id ? P.length - 4 : 2;
      return Math.atan2(P[i + 1] - v.z, P[i] - v.x);
    });
    // Church (villages and towns) in the widest gap between the streets, its tower towards the square.
    if (v.kind !== SettleKind.Hamlet && (town || r.chance(0.75)) && dirs.length) {
      const sorted = dirs.slice().sort((p, q) => p - q);
      let ga = sorted[0] + Math.PI, gw = 0;
      for (let i = 0; i < sorted.length; i++) {
        const p = sorted[i], q = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + Math.PI * 2;
        if (q - p > gw) { gw = q - p; ga = (p + q) / 2; }
      }
      const ux = Math.cos(ga), uz = Math.sin(ga);
      const len = town ? r.range(26, 34) : r.range(20, 26), wid = town ? r.range(12, 15) : r.range(10, 12), tw = town ? r.range(7, 8.5) : r.range(5.5, 7);
      const d0 = v.square + 5;
      const tcx = v.x + ux * (d0 + tw / 2), tcz = v.z + uz * (d0 + tw / 2);
      const ncx = v.x + ux * (d0 + tw - 1 + len / 2), ncz = v.z + uz * (d0 + tw - 1 + len / 2);
      if (this.fits(out.boxes, ncx, ncz, ux, uz, len / 2, wid / 2, v) && this.fits(out.boxes, tcx, tcz, ux, uz, tw / 2, tw / 2, v)) {
        const walls = [WallMat.Sandstone, WallMat.Limestone, WallMat.Granite, WallMat.BrickRed, WallMat.Plaster];
        const nave = this.rect(ncx, ncz, ux, uz, len / 2, wid / 2, -ux, -uz);
        const nd = this.desc(r, out.buildings.length, nave.poly, nave.front, 'church', { floors: 1, roof: 'gable', pitch: r.range(0.9, 1.2), floorH: town ? r.range(11, 14) : r.range(8, 10), walls, landmark: true, use: 'civic' });
        add(nd, ncx, ncz, ux, uz, len / 2, wid / 2);
        const tower = this.rect(tcx, tcz, ux, uz, tw / 2, tw / 2, -ux, -uz);
        const td = this.desc(r, out.buildings.length, tower.poly, tower.front, 'church', { floors: town ? 6 : 5, roof: 'hip', pitch: r.range(2.4, 3.4), floorH: r.range(4.6, 5.2), walls: [WALL(nd.wall)], roofMats: [RoofMat.Slate, RoofMat.Zinc, RoofMat.Green], landmark: true, use: 'civic' });
        add(td, tcx, tcz, ux, uz, tw / 2, tw / 2);
      }
    }
    // Houses along every street, denser and taller near the square.
    const streets: { pts: number[]; hw: number; len: number; s0: number }[] = [];
    for (const id of v.roads) {
      const R = this.roads[id];
      let P = R.pts;
      if (R.b === v.id) P = reversedPts(P);
      const fromSquare = Math.hypot(P[0] - v.x, P[1] - v.z) < v.square + 2;
      streets.push({ pts: P, hw: R.hw, len: R.kind === RoadKind.Lane ? polyLen(P) : v.r * 1.05, s0: fromSquare ? v.square + 4 : 9 });
    }
    const coreR = v.r * (town ? 0.55 : 0.32);
    for (const st of streets) {
      const P = st.pts, n = P.length >> 1;
      const S = new Float64Array(n);
      for (let i = 1; i < n; i++) S[i] = S[i - 1] + Math.hypot(P[i * 2] - P[i * 2 - 2], P[i * 2 + 1] - P[i * 2 - 1]);
      const sMax = Math.min(st.len, S[n - 1] - 4);
      const at = (s: number): [number, number, number, number] => {
        let i = 0;
        while (i < n - 2 && S[i + 1] < s) i++;
        const t = clamp((s - S[i]) / Math.max(1e-6, S[i + 1] - S[i]), 0, 1);
        const dx = P[i * 2 + 2] - P[i * 2], dz = P[i * 2 + 3] - P[i * 2 + 1], l = Math.hypot(dx, dz) || 1;
        return [P[i * 2] + dx * t, P[i * 2 + 1] + dz * t, dx / l, dz / l];
      };
      for (const side of [-1, 1]) {
        let s = st.s0 + r.range(0, 6);
        while (s < sMax) {
          const [px0, pz0] = at(s);
          const dc = Math.hypot(px0 - v.x, pz0 - v.z);
          const core = dc < coreR;
          const w = core ? r.range(8, 11.5) : r.range(9.5, 14);
          const gap = core ? r.range(0.8, 3) : town ? r.range(3, 9) : r.range(5, 13);
          const sm = s + w / 2;
          if (sm > sMax) break;
          const pIn = core ? 0.95 : 0.85 - 0.45 * smoothstep(coreR, v.r, dc);
          if (r.chance(pIn)) {
            const [px, pz, tx, tz] = at(sm);
            const nx = -tz * side, nz = tx * side;
            const d = core ? r.range(9, 13) : r.range(8, 11.5);
            const sb = core ? r.range(1.2, 3) : r.range(4, 9);
            const off = st.hw + 1.4 + sb + d / 2;
            const cx = px + nx * off, cz = pz + nz * off;
            if (Math.hypot(cx - v.x, cz - v.z) < v.r * 1.05 && this.fits(out.boxes, cx, cz, tx, tz, w / 2, d / 2, v)) {
              const barn = !core && v.kind !== SettleKind.Town && r.chance(0.12);
              const R = this.rect(cx, cz, tx, tz, w / 2, d / 2, -nx, -nz);
              let bd: BuildingDesc;
              if (barn) bd = this.barnDesc(r, out.buildings.length, R.poly, R.front);
              else {
                const style = this.styleOf(r, core, town);
                const rule = STYLES[style];
                const floors = clamp(rule.floors(r, 0.3, this.terrain.profile), 1, core ? (town ? 3 : 2) : 2);
                const shop = core && style !== 'house' && r.chance(town ? 0.45 : 0.15);
                bd = this.desc(r, out.buildings.length, R.poly, R.front, style, { floors, shop });
              }
              add(bd, cx, cz, tx, tz, w / 2, d / 2);
            }
          }
          s += w + gap;
        }
      }
    }
    return out;
  }

  private barnDesc(r: Rng, id: number, poly: Poly, front: number): BuildingDesc {
    const a = this.terrain.profile.arch;
    const walls = a.american > a.oldWorld ? [WallMat.WoodSiding, WallMat.WoodSiding, WallMat.BrickRed, WallMat.MetalPanel] : [WallMat.BrickRed, WallMat.Plaster, WallMat.Timber, WallMat.WoodSiding, WallMat.BrickBrown];
    const d = this.desc(r, id, poly, front, 'warehouse', { floors: 1, roof: 'gable', pitch: r.range(0.45, 0.8), floorH: r.range(5.5, 7.5), walls, roofMats: [RoofMat.Metal, RoofMat.ClayTile, RoofMat.Slate, RoofMat.Asphalt], use: 'industrial' });
    // Few, widely spaced openings: a barn, not a hall full of windows.
    d.bay = r.range(8, 11);
    return d;
  }

  private farmLayout(s: Settlement): SettlementLayout {
    const r = new Rng(deriveSeed(s.seed, 'layout'));
    const out: SettlementLayout = { buildings: [], boxes: [], paved: [] };
    const c = Math.cos(s.angle), n = Math.sin(s.angle);
    // The yard: trodden earth or gravel between the buildings, rounded and a little uneven at the edge.
    const yard: number[] = [];
    const yu = s.hu - 2.5, yv = s.hv - 2.5, rc = 7;
    for (let q = 0; q < 4; q++) {
      const su = q === 0 || q === 3 ? 1 : -1, sv = q < 2 ? 1 : -1;
      for (let k = 0; k <= 4; k++) {
        const a = ((q + k / 4) * Math.PI) / 2;
        const j = r.range(-1, 1);
        yard.push(...this.fromFrame(s, su * (yu - rc) + Math.cos(a) * (rc + j), sv * (yv - rc) + Math.sin(a) * (rc + j)));
      }
    }
    out.paved.push({ poly: ensureCCW(yard), layer: r.chance(0.6) ? L_DIRT : L_GRAVEL });
    // Frame-aligned boxes: (u, v) centre, half extents along u and v, front direction in the frame.
    const put = (u: number, v: number, hu: number, hv: number, fu: number, fv: number, mk: (poly: Poly, front: number) => BuildingDesc) => {
      const [cx, cz] = this.fromFrame(s, u, v);
      if (!this.fits(out.boxes, cx, cz, c, n, hu, hv, s)) return;
      const R = this.rect(cx, cz, c, n, hu, hv, fu * c - fv * n, fu * n + fv * c);
      out.buildings.push(mk(R.poly, R.front));
      out.boxes.push(cx, cz, hu, hv, c, n);
    };
    const a = this.terrain.profile.arch;
    // Farmhouse on the +v side near the gate, facing the yard.
    const hw = r.range(6, 7.5), hd = r.range(4.5, 5.5);
    put(-s.hu + 4 + hw, s.hv - hd - 1, hw, hd, 0, -1, (p, f) => this.desc(r, out.buildings.length, p, f, a.warm > 0.5 ? 'mediterranean' : r.chance(a.oldWorld) ? 'oldstone' : 'house', { floors: 2, roof: r.chance(0.7) ? 'gable' : 'hip' }));
    // The barn along the -v side.
    const bl = r.range(11, 15), bw = r.range(6.5, 8);
    put(Math.min(s.hu - 1 - bl, -s.hu + 10 + bl), -s.hv + bw + 1, bl, bw, 0, 1, (p, f) => this.barnDesc(r, out.buildings.length, p, f));
    // A shed or stable at the far end.
    const sl = r.range(4, 5.5), sw = r.range(7, 9);
    put(s.hu - sl - 1, s.hv - sw - 1, sl, sw, -1, 0, (p, f) => this.barnDesc(r, out.buildings.length, p, f));
    // Sometimes a second, smaller barn behind the house.
    if (r.chance(0.35)) {
      const ql = r.range(6, 8), qw = r.range(4.5, 5.5);
      put(-s.hu + 6 + hw * 2 + ql, s.hv - qw - 1, ql, qw, 0, -1, (p, f) => this.barnDesc(r, out.buildings.length, p, f));
    }
    return out;
  }
}

const EMPTY: readonly number[] = [];

/** Wall material id as a WallMat (identity; keeps the church tower in the nave's stone). */
function WALL(w: number): WallMat { return w as WallMat; }

function angDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function reversedPts(P: number[]): number[] {
  const out: number[] = [];
  for (let i = P.length - 2; i >= 0; i -= 2) out.push(P[i], P[i + 1]);
  return out;
}

function polyBox(P: number[]): [number, number, number, number] {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 2) { b[0] = Math.min(b[0], P[i]); b[1] = Math.min(b[1], P[i + 1]); b[2] = Math.max(b[2], P[i]); b[3] = Math.max(b[3], P[i + 1]); }
  return b;
}

function polyLen(P: number[]): number {
  let s = 0;
  for (let i = 2; i < P.length; i += 2) s += Math.hypot(P[i] - P[i - 2], P[i + 1] - P[i - 1]);
  return s;
}

/** Do two oriented boxes overlap (separating axis test)? */
function obbOverlap(ax: number, az: number, aux: number, auz: number, ahu: number, ahv: number, bx: number, bz: number, bux: number, buz: number, bhu: number, bhv: number): boolean {
  const dx = bx - ax, dz = bz - az;
  const axes = [[aux, auz], [-auz, aux], [bux, buz], [-buz, bux]];
  for (const [x, z] of axes) {
    const ra = ahu * Math.abs(aux * x + auz * z) + ahv * Math.abs(-auz * x + aux * z);
    const rb = bhu * Math.abs(bux * x + buz * z) + bhv * Math.abs(-buz * x + bux * z);
    if (Math.abs(dx * x + dz * z) > ra + rb) return false;
  }
  return true;
}
