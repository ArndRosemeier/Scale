/**
 * Bridges over rivers: deck with carriageway, sidewalks and parapets, plus a
 * structure chosen by style (stone multi-arch, steel arch, girder, truss,
 * suspension). Built in the facade material family (same shader).
 */
import type { Terrain } from '../world/terrain';
import type { Bridge, MacroPlan } from '../plan/types';
import { MeshBuilder } from './meshBuilder';
import { facadeSpecs, FF } from './buildingShell';
import { Rng } from '../core/rng';
import { v3cross, v3madd, v3norm, v3scale, type Vec3 } from '../core/math';

export interface BridgeProfile {
  /** start/end of the deck along the edge (arc-length), deck height function. */
  edge: number;
  ax: number; az: number; dx: number; dz: number;
  s0: number; s1: number;
  y: (s: number) => number;
  width: number;
  style: Bridge['style'];
  waterLevel: number;
  /** Deck arc-length ranges that have fallen into the river (BridgeBreaks): no deck there. */
  gaps?: [number, number][];
}

/** A fallen span for the mesh: deck arc-length range on an edge's bridge, seed of its wreckage. */
export interface BridgeGapSpec { edge: number; s0: number; s1: number; seed: number }

/**
 * Pier stations (arc length) of a stone or girder bridge between its deck ends; none for the
 * other styles. The one home for the mesh and the span breaks (a span falls between piers).
 */
export function bridgePiers(style: Bridge['style'], s0: number, s1: number): number[] {
  if (style !== 'stone' && style !== 'girder') return [];
  const span = s1 - s0, n = Math.max(1, Math.round(span / (style === 'stone' ? 28 : 45))), sl = span / n;
  const out: number[] = [];
  for (let k = 1; k < n; k++) out.push(s0 + k * sl);
  return out;
}

/** Does [a, b] (a point when b is left out) reach into one of the gaps? */
export function inGap(gaps: readonly (readonly [number, number])[] | undefined, a: number, b = a): boolean {
  if (gaps) for (const g of gaps) if (a < g[1] && b > g[0]) return true;
  return false;
}

/** The deck runs left of s0..s1 once the gaps are cut out. */
function deckRuns(s0: number, s1: number, gaps: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let a = s0;
  for (const g of [...gaps].sort((p, q) => p[0] - q[0])) {
    if (g[0] > a) out.push([a, Math.min(g[0], s1)]);
    a = Math.max(a, g[1]);
  }
  if (a < s1) out.push([a, s1]);
  return out.filter((r) => r[1] - r[0] > 0.05);
}

/** Deck geometry parameters shared with ground queries. */
export function bridgeProfiles(macro: MacroPlan, terrain: Terrain): BridgeProfile[] {
  const out: BridgeProfile[] = [];
  for (const br of macro.bridges) {
    const e = macro.edges[br.edge];
    const ax = e.pts[0], az = e.pts[1], bx = e.pts[e.pts.length - 2], bz = e.pts[e.pts.length - 1];
    const L = Math.hypot(bx - ax, bz - az);
    const dx = (bx - ax) / L, dz = (bz - az) / L;
    // Water extent along the edge.
    let w0 = L, w1 = 0;
    for (let s = 0; s <= L; s += 2) {
      if (terrain.isWater(ax + dx * s, az + dz * s, 1)) { w0 = Math.min(w0, s); w1 = Math.max(w1, s); }
    }
    if (w1 <= w0) continue;
    const s0 = Math.max(0, w0 - 6), s1 = Math.min(L, w1 + 6);
    const h0 = terrain.height(ax + dx * s0, az + dz * s0), h1 = terrain.height(ax + dx * s1, az + dz * s1);
    const span = s1 - s0;
    const arch = Math.min(br.clearance - 2.5, span * 0.04);
    const y = (s: number) => {
      const t = Math.max(0, Math.min(1, (s - s0) / span));
      return h0 + (h1 - h0) * t + Math.max(0, arch) * Math.sin(Math.PI * t);
    };
    out.push({ edge: br.edge, ax, az, dx, dz, s0, s1, y, width: br.width, style: br.style, waterLevel: br.waterLevel });
  }
  return out;
}

/** All bridges in one mesh; `gaps` leaves fallen spans out (broken ends and wreckage in the river instead). */
export function buildBridges(macro: MacroPlan, terrain: Terrain, gaps: readonly BridgeGapSpec[] = []): MeshBuilder {
  const mb = new MeshBuilder(facadeSpecs());
  const profiles = bridgeProfiles(macro, terrain);
  let elem = 0;
  for (const pr of profiles) {
    const br = macro.bridges.find((b) => b.edge === pr.edge)!;
    const e = macro.edges[pr.edge];
    const wl = br.waterLevel;
    const half = pr.width / 2;
    const carr = e.width / 2;
    const nx = -pr.dz, nz = pr.dx;
    const P = (s: number, o: number, y: number): [number, number, number] => [pr.ax + pr.dx * s + nx * o, y, pr.az + pr.dz * s + nz * o];
    const mine = gaps.filter((g) => g.edge === pr.edge && g.s1 > pr.s0 && g.s0 < pr.s1);
    const cut: [number, number][] = mine.map((g) => [g.s0, g.s1]);
    // Deck pieces of ~4 m per run between gaps (the whole deck: at least 8, as before).
    const pieces: [number, number][] = [];
    for (const [ra, rb] of deckRuns(pr.s0, pr.s1, cut)) {
      const n = Math.max(cut.length ? 1 : 8, Math.ceil((rb - ra) / 4)), d = (rb - ra) / n;
      for (let k = 0; k < n; k++) pieces.push([ra + k * d, ra + (k + 1) * d]);
    }
    const stone = br.style === 'stone';
    const structLayer = stone ? 4 : br.style === 'girder' ? 8 : 11;
    const structTint: [number, number, number] = stone ? [0.85, 0.8, 0.72] : br.style === 'girder' ? [0.75, 0.75, 0.74] : br.style === 'truss' ? [0.32, 0.42, 0.38] : [0.45, 0.48, 0.5];
    const thick = br.style === 'girder' ? 2.4 : stone ? 1.6 : 1.3;
    mb.set('aSeed', 0.5).set('aElem', elem++);
    // --- Deck surfaces: carriageway (tar), sidewalks (raised), deck underside and sides.
    for (const [sa, sb] of pieces) {
      const ya = pr.y(sa), yb = pr.y(sb);
      mb.set('aLayer', 16).set('aTint', 0.75, 0.75, 0.75).set('aFacade', 1, 1, 1, FF.Roof);
      quadUp(mb, P(sa, -carr, ya), P(sb, -carr, yb), P(sb, carr, yb), P(sa, carr, ya));
      mb.set('aLayer', 8).set('aTint', 0.9, 0.9, 0.88);
      quadUp(mb, P(sa, carr, ya + 0.15), P(sb, carr, yb + 0.15), P(sb, half, yb + 0.15), P(sa, half, ya + 0.15));
      quadUp(mb, P(sa, -half, ya + 0.15), P(sb, -half, yb + 0.15), P(sb, -carr, yb + 0.15), P(sa, -carr, ya + 0.15));
      // curbs
      side(mb, P(sa, carr, ya), P(sb, carr, yb), 0.15, -1, nx, nz);
      side(mb, P(sb, -carr, yb), P(sa, -carr, ya), 0.15, 1, nx, nz);
      // underside
      mb.set('aLayer', structLayer).set('aTint', ...structTint).set('aFacade', 1, 1, 1, 0);
      quadDown(mb, P(sa, -half, ya - thick), P(sb, -half, yb - thick), P(sb, half, yb - thick), P(sa, half, ya - thick));
      // fascia (outer deck edges)
      side(mb, P(sb, half, yb - thick), P(sa, half, ya - thick), thick + 0.15, 0, nx, nz, true);
      side(mb, P(sa, -half, ya - thick), P(sb, -half, yb - thick), thick + 0.15, 0, -nx, -nz, true);
    }
    // --- Parapets / railings.
    for (const sgn of [-1, 1]) {
      for (const [sa, sb] of pieces) {
        const ds = sb - sa;
        const ya = pr.y(sa) + 0.15, yb = pr.y(sb) + 0.15;
        const o = sgn * (half - 0.15);
        if (stone) {
          mb.set('aLayer', 4).set('aTint', 0.88, 0.84, 0.76);
          const mid = P((sa + sb) / 2, o, (ya + yb) / 2 + 0.5);
          mb.box(mid[0], mid[1], mid[2], ds / 2, 0.5, 0.18, -Math.atan2(pr.dz, pr.dx));
          // coping
          const top = P((sa + sb) / 2, o, (ya + yb) / 2 + 1.06);
          mb.box(top[0], top[1], top[2], ds / 2 + 0.02, 0.06, 0.25, -Math.atan2(pr.dz, pr.dx));
        } else {
          mb.set('aLayer', 11).set('aTint', 0.25, 0.27, 0.28);
          const rail = P((sa + sb) / 2, o, (ya + yb) / 2 + 1.05);
          mb.box(rail[0], rail[1], rail[2], ds / 2, 0.04, 0.05, -Math.atan2(pr.dz, pr.dx));
          const rail2 = P((sa + sb) / 2, o, (ya + yb) / 2 + 0.5);
          mb.box(rail2[0], rail2[1], rail2[2], ds / 2, 0.03, 0.03, -Math.atan2(pr.dz, pr.dx));
          const post = P(sa, o, ya + 0.55);
          mb.box(post[0], post[1], post[2], 0.04, 0.55, 0.04);
        }
      }
    }
    // --- Lamp posts every ~25 m.
    for (let s = pr.s0 + 8; s < pr.s1 - 4; s += 25) {
      if (inGap(cut, s - 0.5, s + 0.5)) continue;
      for (const sgn of [-1, 1]) {
        const y = pr.y(s) + 0.15;
        const p = P(s, sgn * (half - 0.4), y);
        mb.set('aLayer', 11).set('aTint', 0.18, 0.2, 0.2).set('aFacade', 1, 1, 1, 0);
        mb.box(p[0], y + 2.5, p[2], 0.07, 2.5, 0.07);
        mb.box(p[0], y + 5.05, p[2], 0.2, 0.12, 0.2);
      }
    }
    // --- Structure.
    const span = pr.s1 - pr.s0;
    mb.set('aLayer', structLayer).set('aTint', ...structTint).set('aFacade', 1, 1, 1, 0);
    const yaw = -Math.atan2(pr.dz, pr.dx);
    if (stone || br.style === 'girder') {
      // Piers in the water + arches (stone) or straight girders on piers.
      const piers = bridgePiers(br.style, pr.s0, pr.s1);
      const nSpan = piers.length + 1;
      const sl = span / nSpan;
      for (const s of piers) {
        if (inGap(cut, s)) continue;
        const y = pr.y(s) - thick;
        const bottom = wl - 4;
        const p = P(s, 0, (y + bottom) / 2);
        const pw = stone ? 2.2 : 1.6;
        mb.box(p[0], p[1], p[2], pw, (y - bottom) / 2, half - (stone ? 0 : 1.5), yaw);
        if (stone) {
          // Cutwaters (pointed ends) up to just above the water.
          for (const sgn of [-1, 1]) {
            const c = P(s, sgn * (half + 1.2), (wl + 1.2 + bottom) / 2);
            mb.box(c[0], c[1], c[2], pw * 0.72, (wl + 1.2 - bottom) / 2, 1.3, yaw + Math.PI / 4);
          }
        }
      }
      if (stone) {
        // Arch vaults: spandrel side walls with a semicircular (segmental) opening.
        for (let k = 0; k < nSpan; k++) {
          const sa = pr.s0 + k * sl, sb = sa + sl;
          const rise = Math.min(sl * 0.45, Math.max(2, pr.y((sa + sb) / 2) - thick - wl - 0.8));
          const springY = pr.y((sa + sb) / 2) - thick - rise;
          const archSeg = 14;
          for (const sgn of [-1, 1]) {
            const o = sgn * half;
            for (let i = 0; i < archSeg; i++) {
              const t0 = i / archSeg, t1 = (i + 1) / archSeg;
              const s0 = sa + 1.1 + (sl - 2.2) * t0, s1 = sa + 1.1 + (sl - 2.2) * t1;
              if (inGap(cut, s0, s1)) continue;
              const a0 = springY + rise * Math.sin(Math.PI * t0), a1 = springY + rise * Math.sin(Math.PI * t1);
              const d0 = pr.y(s0) - thick, d1 = pr.y(s1) - thick;
              // spandrel face from arch curve up to the deck underside
              const A = P(s0, o, a0), B = P(s1, o, a1), C = P(s1, o, d1), D = P(s0, o, d0);
              if (sgn > 0) quadSide(mb, A, B, C, D, nx, nz);
              else quadSide(mb, B, A, D, C, -nx, -nz);
              // intrados (vault underside)
              const E = P(s0, -half, a0), F = P(s1, -half, a1), G = P(s1, half, a1), Hh = P(s0, half, a0);
              if (sgn > 0) quadDown(mb, E, F, G, Hh);
            }
          }
        }
      }
    } else if (br.style === 'arch') {
      // Two steel arch ribs under the deck springing from the banks, with vertical struts.
      const rise = Math.min(span * 0.18, Math.max(4, pr.y((pr.s0 + pr.s1) / 2) - wl - 1.5));
      const yMid = pr.y((pr.s0 + pr.s1) / 2) - thick;
      const springY = yMid - rise;
      const n = 24;
      for (const sgn of [-1, 1]) {
        const o = sgn * (half - 1.5);
        for (let i = 0; i < n; i++) {
          const t0 = i / n, t1 = (i + 1) / n;
          const s0 = pr.s0 + span * t0, s1 = pr.s0 + span * t1;
          if (inGap(cut, s0, s1)) continue;
          const y0 = springY + rise * Math.sin(Math.PI * t0), y1 = springY + rise * Math.sin(Math.PI * t1);
          const a = P(s0, o, y0), b = P(s1, o, y1);
          mb.beam(a[0], a[1], a[2], b[0], b[1], b[2], 0.45, 0.6);
          if (i % 2 === 0 && i > 0) {
            const d = pr.y(s0) - thick;
            const c = P(s0, o, (y0 + d) / 2);
            if (d - y0 > 0.3) mb.box(c[0], c[1], c[2], 0.2, (d - y0) / 2, 0.2, yaw);
          }
        }
      }
    } else if (br.style === 'truss') {
      // Through truss: top chords, verticals and diagonals on both sides of the deck.
      const panels = Math.max(4, Math.round(span / 9));
      const pl = span / panels;
      const th = 7;
      for (const sgn of [-1, 1]) {
        const o = sgn * (half + 0.2);
        for (let k = 0; k <= panels; k++) {
          const s = pr.s0 + k * pl;
          const y = pr.y(s);
          const a = P(s, o, y), b = P(s, o, y + th);
          if (!inGap(cut, s)) mb.beam(a[0], a[1], a[2], b[0], b[1], b[2], 0.18, 0.18);
          if (k < panels && !inGap(cut, s, s + pl)) {
            const s2 = s + pl, y2 = pr.y(s2);
            const c = P(s2, o, y2 + th);
            mb.beam(b[0], b[1], b[2], c[0], c[1], c[2], 0.25, 0.25);
            const d = k < panels / 2 ? P(s2, o, y2) : a;
            const e2 = k < panels / 2 ? b : P(s2, o, y2 + th);
            void d; void e2;
            const da = k < panels / 2 ? P(s, o, y + th) : P(s, o, y);
            const db = k < panels / 2 ? P(s2, o, y2) : P(s2, o, y2 + th);
            mb.beam(da[0], da[1], da[2], db[0], db[1], db[2], 0.14, 0.14);
          }
        }
      }
      // Portal bracing across the top.
      for (let k = 0; k <= panels; k += 2) {
        const s = pr.s0 + k * pl, y = pr.y(s) + th;
        if (inGap(cut, s)) continue;
        const a = P(s, -half - 0.2, y), b = P(s, half + 0.2, y);
        mb.beam(a[0], a[1], a[2], b[0], b[1], b[2], 0.15, 0.15);
      }
    } else {
      // Suspension: two towers, main cables, hangers.
      const tH = Math.min(80, 25 + span * 0.12);
      const sT0 = pr.s0 + span * 0.18, sT1 = pr.s1 - span * 0.18;
      mb.set('aLayer', 8).set('aTint', 0.8, 0.8, 0.78);
      for (const sT of [sT0, sT1]) {
        if (inGap(cut, sT - 1.4, sT + 1.4)) continue;
        for (const sgn of [-1, 1]) {
          const y0 = wl - 4, y1 = pr.y(sT) + tH;
          const p = P(sT, sgn * (half + 0.6), (y0 + y1) / 2);
          mb.box(p[0], p[1], p[2], 1.4, (y1 - y0) / 2, 1.4, yaw);
        }
        for (const hy of [0.45, 0.95]) {
          const y = pr.y(sT) + tH * hy;
          const a = P(sT, -half - 0.6, y), b = P(sT, half + 0.6, y);
          mb.beam(a[0], a[1], a[2], b[0], b[1], b[2], 1.0, 1.2);
        }
      }
      mb.set('aLayer', 11).set('aTint', 0.55, 0.3, 0.25);
      const cableY = (s: number) => {
        const mid = (sT0 + sT1) / 2, halfL = (sT1 - sT0) / 2;
        const top = pr.y(sT0) + tH, low = pr.y(mid) + 3;
        const t = (s - mid) / halfL;
        if (Math.abs(t) <= 1) return low + (top - low) * t * t;
        // side spans down to the anchorages
        const tt = s < sT0 ? (sT0 - s) / (sT0 - pr.s0) : (s - sT1) / (pr.s1 - sT1);
        return top - (top - pr.y(s) - 1) * Math.min(1, tt);
      };
      const n = 40;
      for (const sgn of [-1, 1]) {
        const o = sgn * (half + 0.6);
        for (let i = 0; i < n; i++) {
          const s0 = pr.s0 + (span * i) / n, s1 = pr.s0 + (span * (i + 1)) / n;
          const a = P(s0, o, cableY(s0)), b = P(s1, o, cableY(s1));
          mb.beam(a[0], a[1], a[2], b[0], b[1], b[2], 0.35, 0.35);
          const d = pr.y(s0);
          if (cableY(s0) - d > 1.5 && !inGap(cut, s0)) {
            const c = P(s0, o, (cableY(s0) + d) / 2);
            mb.box(c[0], c[1], c[2], 0.04, (cableY(s0) - d) / 2, 0.04);
          }
        }
      }
    }
    // Abutments at both ends (stone/concrete blocks into the bank).
    mb.set('aLayer', stone ? 4 : 8).set('aTint', ...(stone ? [0.82, 0.78, 0.7] as [number, number, number] : [0.75, 0.75, 0.74] as [number, number, number]));
    for (const s of [pr.s0 + 2, pr.s1 - 2]) {
      const y = pr.y(s) - thick, bottom = wl - 3;
      const p = P(s, 0, (y + bottom) / 2);
      mb.box(p[0], p[1], p[2], 3, (y - bottom) / 2, half + 0.5, yaw);
    }
    for (const g of mine) gapWreckage(mb, pr, g, thick, P);
  }
  return mb;
}

/**
 * A fallen span's leftovers, all from the gap's seed: at each broken end deck slabs hanging down
 * from the edge and bent rebar, and 2–3 big deck slabs lying tilted in the river, half under.
 */
function gapWreckage(mb: MeshBuilder, pr: BridgeProfile, g: BridgeGapSpec, thick: number, P: (s: number, o: number, y: number) => Vec3): void {
  const half = pr.width / 2;
  const ends: [number, number][] = [];
  if (g.s0 > pr.s0 + 0.5) ends.push([g.s0, 1]);
  if (g.s1 < pr.s1 - 0.5) ends.push([g.s1, -1]);
  for (const [e, dir] of ends) {
    const rng = Rng.from('bridgeGap', g.seed, dir);
    const y = pr.y(e);
    // Slabs hinged at the edge, hanging into the gap: three across the deck, each its own droop.
    for (let k = 0; k < 3; k++) {
      if (rng.chance(0.2)) continue;
      const oc = -half + (k + 0.5) * (pr.width / 3) + rng.range(-0.4, 0.4);
      const a = rng.range(0.45, 1.25), L = rng.range(2.5, 6);
      const u: Vec3 = [pr.dx * dir * Math.cos(a), -Math.sin(a), pr.dz * dir * Math.cos(a)];
      const v: Vec3 = [pr.dx * dir * Math.sin(a), Math.cos(a), pr.dz * dir * Math.sin(a)];
      mb.set('aLayer', 8).set('aTint', 0.82, 0.81, 0.78).set('aFacade', 1, 1, 1, 0);
      slab(mb, v3madd(P(e, oc, y - thick * 0.45), u, L / 2), u, v, L / 2, thick * 0.4, (pr.width / 6) * rng.range(0.7, 0.95));
    }
    // Rebar sticking out of the torn edge, bent down.
    mb.set('aLayer', 11).set('aTint', 0.36, 0.22, 0.15);
    const nBar = rng.int(6, 10);
    for (let i = 0; i < nBar; i++) {
      const o = rng.range(-half + 0.3, half - 0.3), L = rng.range(0.8, 2.4), a = rng.range(0.1, 1.1);
      const u: Vec3 = [pr.dx * dir * Math.cos(a), -Math.sin(a), pr.dz * dir * Math.cos(a)];
      slab(mb, v3madd(P(e, o, y - rng.range(0.15, thick * 0.8)), u, L / 2), u, v3norm([-u[0] * u[1], 1 - u[1] * u[1], -u[2] * u[1]]), L / 2, 0.035, 0.035);
    }
  }
  // Big pieces of the deck in the river, tilted and partly under water.
  const rng = Rng.from('bridgeGap', g.seed, 0);
  const G = g.s1 - g.s0, n = G > 14 ? rng.int(2, 3) : 2;
  for (let k = 0; k < n; k++) {
    const s = g.s0 + (G * (k + 0.5)) / n + rng.range(-1, 1);
    const yaw = rng.range(-0.35, 0.35), a = rng.range(0.2, 0.65) * rng.sign(), roll = rng.range(-0.25, 0.25);
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    const h: Vec3 = [pr.dx * c - pr.dz * sn, 0, pr.dz * c + pr.dx * sn];
    const w0: Vec3 = [-h[2], 0, h[0]];
    const u: Vec3 = [h[0] * Math.cos(a), Math.sin(a), h[2] * Math.cos(a)];
    const v0 = v3cross(w0, u);
    const v = v3norm(v3madd(v3scale(v0, Math.cos(roll)), w0, Math.sin(roll)));
    const L = Math.min((G / n) * 1.15, rng.range(6, 10));
    const ctr = P(s, rng.range(-half * 0.4, half * 0.4), pr.waterLevel + rng.range(-0.4, 0.5));
    mb.set('aLayer', 8).set('aTint', 0.8, 0.79, 0.76).set('aFacade', 1, 1, 1, 0);
    slab(mb, ctr, u, v, L / 2, thick * 0.45, half * rng.range(0.55, 0.9));
  }
}

/** A box of half extents (hu, hv, hw) on the unit axes u, v (at right angles) and u×v round c: a tilted slab or a bent bar. */
function slab(mb: MeshBuilder, c: Vec3, u: Vec3, v: Vec3, hu: number, hv: number, hw: number): void {
  const A = [u, v, v3cross(u, v)], H = [hu, hv, hw];
  for (let i = 0; i < 3; i++) {
    const n = A[i], a = A[(i + 1) % 3], b = A[(i + 2) % 3], ha = H[(i + 1) % 3], hb = H[(i + 2) % 3];
    for (const sg of [1, -1]) {
      const f = v3madd(c, n, sg * H[i]);
      const q = (x: number, y: number) => v3madd(v3madd(f, a, x * ha), b, y * hb);
      const cs = sg > 0 ? [q(-1, -1), q(1, -1), q(1, 1), q(-1, 1)] : [q(-1, -1), q(-1, 1), q(1, 1), q(1, -1)];
      mb.quadP(cs.flat(), [0, 0, ha * 2, 0, ha * 2, hb * 2, 0, hb * 2]);
    }
  }
}

function quadUp(mb: MeshBuilder, a: number[], b: number[], c: number[], d: number[]): void {
  emitQuad(mb, a, b, c, d, true);
}
function quadDown(mb: MeshBuilder, a: number[], b: number[], c: number[], d: number[]): void {
  emitQuad(mb, a, b, c, d, false);
}
function emitQuad(mb: MeshBuilder, a: number[], b: number[], c: number[], d: number[], up: boolean): void {
  const ny = up ? 1 : -1;
  const i0 = mb.v(a[0], a[1], a[2], 0, ny, 0, a[0], a[2]);
  mb.v(b[0], b[1], b[2], 0, ny, 0, b[0], b[2]);
  mb.v(c[0], c[1], c[2], 0, ny, 0, c[0], c[2]);
  mb.v(d[0], d[1], d[2], 0, ny, 0, d[0], d[2]);
  // Pick winding from the actual geometric normal.
  const ex = b[0] - a[0], ez = b[2] - a[2], fx = d[0] - a[0], fz = d[2] - a[2];
  const gy = ez * fx - ex * fz;
  if ((gy > 0) === up) mb.quad(i0, i0 + 1, i0 + 2, i0 + 3);
  else mb.quad(i0, i0 + 3, i0 + 2, i0 + 1);
}

/** Vertical strip from segment a→b (bottom) up by h, facing (fx,fz) or the side sign. */
function side(mb: MeshBuilder, a: number[], b: number[], h: number, _sgn: number, fx: number, fz: number, explicit = false): void {
  const i0 = mb.v(a[0], a[1], a[2], fx, 0, fz, 0, 0);
  const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
  mb.v(b[0], b[1], b[2], fx, 0, fz, L, 0);
  mb.v(b[0], b[1] + h, b[2], fx, 0, fz, L, h);
  mb.v(a[0], a[1] + h, a[2], fx, 0, fz, 0, h);
  // geometric normal of (a,b,b+h): (b-a) x (up) = (ez*... ) → right of a→b
  const ex = b[0] - a[0], ez = b[2] - a[2];
  const rx = ez, rz = -ex; // right normal
  const facesRight = rx * fx + rz * fz > 0;
  void explicit;
  if (facesRight) mb.quad(i0, i0 + 3, i0 + 2, i0 + 1);
  else mb.quad(i0, i0 + 1, i0 + 2, i0 + 3);
}

function quadSide(mb: MeshBuilder, a: number[], b: number[], c: number[], d: number[], fx: number, fz: number): void {
  const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const i0 = mb.v(a[0], a[1], a[2], fx, 0, fz, 0, a[1]);
  mb.v(b[0], b[1], b[2], fx, 0, fz, L, b[1]);
  mb.v(c[0], c[1], c[2], fx, 0, fz, L, c[1]);
  mb.v(d[0], d[1], d[2], fx, 0, fz, 0, d[1]);
  const ex = b[0] - a[0], ez = b[2] - a[2];
  const facesRight = ez * fx - ex * fz > 0;
  if (facesRight) mb.quad(i0, i0 + 3, i0 + 2, i0 + 1);
  else mb.quad(i0, i0 + 1, i0 + 2, i0 + 3);
}
