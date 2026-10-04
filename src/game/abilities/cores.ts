/**
 * Power core placement: pure and deterministic from (seed, size) — no three.js, runs headless.
 *
 *  1. `planCoreSites(macro, terrain)`: the city-wide list from the macro plan. Metro platform
 *     and sewer walkway sites are exact already; roof / plaza / park sites name a cell.
 *  2. `resolveCoreSite(site, plan, terrain)`: the exact spot once that cell's plan exists
 *     (streamed in the game, `planCell` in tests) — a flat roof, a plaza or a park lawn.
 *
 * A mix of easy (plazas, parks) and hard spots (high roofs, deep platforms, sewers), so
 * some cores need powers (super jump, flight) to reach.
 */
import { Rng, deriveSeed } from '../../core/rng';
import { pointInPoly, polyCentroid, polyBounds } from '../../core/geom2';
import type { MacroPlan, District } from '../../plan/types';
import type { CellPlan } from '../../plan/cell';
import type { Shape } from '../../core/clip';
import type { Terrain } from '../../world/terrain';
import { buildingLayout } from '../../build/buildingLayout';
import { sewerInvert } from '../../plan/underground';
import { STATION_HW, PLATFORM_W, PLATFORM_H } from '../../underground/layout';
import { CORES, ENERGY, KARMA } from './tuning';

export type CoreKind = 'plaza' | 'park' | 'roof' | 'metro' | 'sewer';
export type CoreLoot = 'energy' | 'regen' | 'karma';

export interface CoreSite {
  id: number;
  kind: CoreKind;
  loot: CoreLoot;
  cell: number;
  /** Exact position for metro / sewer sites; for the others filled in by resolveCoreSite. */
  x: number; y: number; z: number;
  /** Per-site random seed (which roof, which spot). */
  seed: number;
  /** Roof sites: 0 low … 1 tall preference. */
  height: number;
}

export interface CoreSpot { x: number; y: number; z: number; surface: 'ground' | 'roof' | 'platform' | 'sewer' }

export const LOOT_INFO: Record<CoreLoot, { name: string; text: string; color: string }> = {
  energy: { name: 'Energy core', text: `+${ENERGY.coreMax} max energy`, color: '#58d6ff' },
  regen: { name: 'Vigor core', text: `+${ENERGY.coreRegen} energy/s regeneration`, color: '#7dffb0' },
  karma: { name: 'Karma core', text: `+${KARMA.coreKarma} karma`, color: '#ffd36b' },
};

const ROOF_DISTRICTS: District[] = ['downtown', 'commercial', 'oldtown', 'apartments', 'industrial', 'port', 'rowhouses'];

export function planCoreSites(macro: MacroPlan, terrain: Terrain): CoreSite[] {
  const rng = new Rng(deriveSeed(macro.seed, 'powercores', macro.cells.length));
  const land = macro.cells.filter((c) => c.district !== 'water');
  const n = Math.max(CORES.min, Math.min(CORES.max, Math.round(land.length / CORES.perCells)));
  const kinds: CoreKind[] = [];
  const nMetro = macro.metroStations.length ? Math.max(1, Math.round(n * 0.15)) : 0;
  const nSewer = macro.sewers.length ? Math.max(1, Math.round(n * 0.12)) : 0;
  for (let i = 0; i < nMetro; i++) kinds.push('metro');
  for (let i = 0; i < nSewer; i++) kinds.push('sewer');
  while (kinds.length < n) kinds.push(kinds.length % 5 < 2 ? 'roof' : kinds.length % 5 === 2 ? 'park' : kinds.length % 5 === 3 ? 'plaza' : 'roof');
  const used = new Set<number>();
  const usedStations = new Set<number>();
  const sites: CoreSite[] = [];
  const loots: CoreLoot[] = ['energy', 'regen', 'karma'];
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    const site: CoreSite = { id: i, kind, loot: loots[rng.int(0, 2)], cell: -1, x: 0, y: 0, z: 0, seed: rng.nextU32(), height: rng.float() };
    if (kind === 'metro') {
      const free = macro.metroStations.filter((s) => !usedStations.has(s.id));
      if (!free.length) continue;
      const st = rng.pick(free);
      usedStations.add(st.id);
      const h = st.halls[0];
      // On a side platform, a little off the hall centre (v axis across the hall).
      const ux = Math.cos(h.angle), uz = Math.sin(h.angle);
      const v = (STATION_HW - PLATFORM_W / 2) * rng.sign(), u = rng.range(-30, 30);
      site.x = h.x + ux * u - uz * v;
      site.z = h.z + uz * u + ux * v;
      site.y = h.y + PLATFORM_H;
    } else if (kind === 'sewer') {
      const tr = rng.pick(macro.sewers);
      const m = tr.pts.length >> 1;
      if (m < 3) continue;
      const k = rng.int(1, m - 2);
      const inv = sewerInvert(tr.pts, terrain, tr.culvert);
      const dx = tr.pts[k * 2 + 2] - tr.pts[k * 2 - 2], dz = tr.pts[k * 2 + 3] - tr.pts[k * 2 - 1];
      const l = Math.hypot(dx, dz) || 1;
      const side = rng.sign() * 1.15; // on the walkway beside the channel
      site.x = tr.pts[k * 2] - (dz / l) * side;
      site.z = tr.pts[k * 2 + 1] + (dx / l) * side;
      site.y = inv[k];
    } else {
      const pool = land.filter((c) => !used.has(c.id) && (kind !== 'roof' || ROOF_DISTRICTS.includes(c.district)) && (kind !== 'park' || c.district === 'park' || c.district === 'suburban' || c.district === 'apartments'));
      const from = pool.length ? pool : land.filter((c) => !used.has(c.id));
      if (!from.length) continue;
      const c = rng.pick(from);
      used.add(c.id);
      site.cell = c.id;
      site.x = c.centroid[0]; site.z = c.centroid[1];
      site.y = NaN;
    }
    if (site.cell < 0) site.cell = cellAt(macro, site.x, site.z);
    sites.push(site);
  }
  return sites;
}

function cellAt(macro: MacroPlan, x: number, z: number): number {
  for (const c of macro.cells) if (Math.hypot(c.centroid[0] - x, c.centroid[1] - z) < c.radius + 1 && pointInPoly(c.poly, x, z)) return c.id;
  return -1;
}

/** Whether a site needs its cell's plan to be placed. */
export function needsPlan(s: CoreSite): boolean { return s.kind === 'roof' || s.kind === 'plaza' || s.kind === 'park'; }

/** Exact spot of a site (plan: its cell's plan; null for metro / sewer sites). Null: no fitting spot. */
export function resolveCoreSite(s: CoreSite, plan: CellPlan | null, terrain: Terrain): CoreSpot | null {
  if (s.kind === 'metro') return { x: s.x, y: s.y, z: s.z, surface: 'platform' };
  if (s.kind === 'sewer') return { x: s.x, y: s.y, z: s.z, surface: 'sewer' };
  if (!plan) return null;
  const rng = new Rng(s.seed);
  if (s.kind === 'roof') {
    const flat = plan.buildings.filter((b) => b.roof === 'flat' && b.floors >= 1);
    if (flat.length) {
      // Height preference: sorted by height, pick around the site's preferred quantile.
      const L = flat.map((b) => ({ b, L: buildingLayout(b, terrain, 0) })).sort((p, q) => p.L.height - q.L.height || p.b.id - q.b.id);
      const i = Math.min(L.length - 1, Math.floor(s.height * L.length));
      const { L: lay } = L[i];
      const top = lay.tiers[lay.tiers.length - 1].poly;
      const pt = interiorPoint(top, [], rng);
      if (pt) return { x: pt[0], y: lay.base + lay.height, z: pt[1], surface: 'roof' };
    }
  }
  const order: Shape[][] = s.kind === 'park' ? [plan.parks, plan.plazas] : [plan.plazas, plan.parks];
  for (const shapes of order) {
    const list = shapes.filter((sh) => sh.outer.length >= 6);
    if (!list.length) continue;
    const sh = list[rng.int(0, list.length - 1)];
    const pt = interiorPoint(sh.outer, sh.holes, rng, plan);
    if (pt) return { x: pt[0], y: terrain.height(pt[0], pt[1]), z: pt[1], surface: 'ground' };
  }
  return null;
}

/** A point well inside a polygon (outside its holes and, with a plan, off buildings). */
function interiorPoint(poly: number[], holes: number[][], rng: Rng, plan?: CellPlan): [number, number] | null {
  const ok = (x: number, z: number) => pointInPoly(poly, x, z) && !holes.some((h) => pointInPoly(h, x, z)) && !(plan && plan.buildings.some((b) => pointInPoly(b.poly, x, z))) && edgeDist(poly, x, z) > 1.2;
  const [cx, cz] = polyCentroid(poly);
  if (ok(cx, cz)) return [cx, cz];
  const [x0, z0, x1, z1] = polyBounds(poly);
  for (let k = 0; k < 40; k++) {
    const x = x0 + (x1 - x0) * rng.float(), z = z0 + (z1 - z0) * rng.float();
    if (ok(x, z)) return [x, z];
  }
  return null;
}

function edgeDist(p: number[], x: number, z: number): number {
  let best = Infinity;
  const n = p.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = p[j * 2], az = p[j * 2 + 1], bx = p[i * 2], bz = p[i * 2 + 1];
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
  }
  return best;
}
