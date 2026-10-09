/**
 * Self test of furnished homes (fill/place + fill/home), run by tools/selftest.ts: on real storeys of
 * home buildings every solid piece stands inside its room, apart from the others and out of the
 * doorways; living rooms have a sofa with the TV across from it, facing it; bedrooms a bed with its
 * head against a wall; kitchens their counter row; and a storey is furnished fast enough to build
 * while the player walks in.
 */
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { planCell } from '../src/plan/cell';
import { buildingLayout } from '../src/build/buildingLayout';
import { planFloor, planCores, coreFits, shopKindOf, type Furn, type FloorPlan } from '../src/interior/InteriorGen';
import { quad, overlap } from '../src/interior/fill/place';
import { pointInPoly, distSqPointSeg, minAreaRect, type Poly } from '../src/core/geom2';

type Check = (ok: boolean, msg: string) => void;

/** Pieces with a floor of their own that people cannot walk through. */
const NOT_SOLID = new Set(['rug', 'painting', 'mirror', 'tv', 'monitor']);
const foot = (f: Furn, m = 0): Poly => quad(f.x, f.z, f.yaw, f.w + 2 * m, -f.d / 2 - m, f.d / 2 + m);

/** Distance from a piece's back (middle of its -z face) to the nearest wall or outline edge. */
function backToWall(f: Furn, plan: FloorPlan, outline: Poly): number {
  const bx = f.x - Math.sin(f.yaw) * f.d / 2, bz = f.z - Math.cos(f.yaw) * f.d / 2;
  let d = Infinity;
  for (const w of plan.walls) d = Math.min(d, distSqPointSeg(bx, bz, w.ax, w.az, w.bx, w.bz));
  const n = outline.length >> 1;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; d = Math.min(d, distSqPointSeg(bx, bz, outline[i * 2], outline[i * 2 + 1], outline[j * 2], outline[j * 2 + 1])); }
  return Math.sqrt(d);
}

export function homeChecks(check: Check): void {
  const stats = { storeys: 0, ms: 0, solids: 0, outside: 0, overlaps: 0, doorways: 0, livings: 0, sofas: 0, tvs: 0, tvAway: 0, bedrooms: 0, beds: 0, bedOff: 0, kitchens: 0, rows: 0 };
  for (const [seed, size] of [[42, 0.4], [7, 0.7], [3, 0.5]] as const) {
    const terrain = new Terrain(makeProfile({ seed, size }));
    const macro = buildMacroPlan(terrain);
    const c0 = macro.centres[0];
    const cells = macro.cells.slice().sort((a, b) => Math.hypot(a.centroid[0] - c0.x, a.centroid[1] - c0.z) - Math.hypot(b.centroid[0] - c0.x, b.centroid[1] - c0.z));
    let done = 0;
    for (const c of cells.slice(0, 10)) for (const b of planCell(macro, c, terrain).buildings) {
      if (done >= 25 || b.use === 'office' || b.use === 'industrial' || b.use === 'parking' || b.style === 'church' || b.floors < 2) continue;
      done++;
      const L = buildingLayout(b, terrain, 0);
      const { lift, stair } = planCores(b, L.tiers[0].poly, Math.max(...L.floors.map((q) => q.y1 - q.y0)), L.door);
      for (const fl of L.floors.slice(1, 3)) {
        const poly = L.tiers[fl.tier].poly;
        const next = L.floors.find((q) => q.f === fl.f + 1);
        const up = !!stair && !!next && coreFits(stair, poly) && coreFits(stair, L.tiers[next.tier].poly);
        const t0 = performance.now();
        const plan = planFloor(b, poly, fl.f, fl.y0, fl.y1 - fl.y0, shopKindOf(b), lift, stair, up, !!stair && coreFits(stair, poly), null);
        stats.ms += performance.now() - t0;
        stats.storeys++;
        const solids = plan.furniture.filter((f) => !NOT_SOLID.has(f.kind));
        stats.solids += solids.length;
        for (const f of solids) {
          const room = plan.rooms.find((r) => pointInPoly(r.poly, f.x, f.z));
          const q = foot(f, -0.02);
          for (let k = 0; k < 8; k += 2) if (!room || !pointInPoly(room.poly, q[k], q[k + 1])) { stats.outside++; break; }
        }
        for (let i = 0; i < solids.length; i++) for (let j = i + 1; j < solids.length; j++) if (overlap(foot(solids[i]), foot(solids[j]))) stats.overlaps++;
        // Doorways: 60 cm either side of every door opening kept free (by pieces in the two rooms it
        // joins: near a slanted corner the box reaches past a wall into a third room).
        const roomOf = (x: number, z: number) => plan.rooms.findIndex((r) => pointInPoly(r.poly, x, z));
        for (const w of plan.walls) {
          const L2 = Math.hypot(w.bx - w.ax, w.bz - w.az), ux = (w.bx - w.ax) / L2, uz = (w.bz - w.az) / L2;
          for (const [t0d, t1d] of w.doors) {
            const p = (t: number, s: number): [number, number] => [w.ax + (w.bx - w.ax) * t - uz * s, w.az + (w.bz - w.az) * t + ux * s];
            const zone = [...p(t0d, -0.6), ...p(t1d, -0.6), ...p(t1d, 0.6), ...p(t0d, 0.6)];
            const sides = [roomOf(...p((t0d + t1d) / 2, -0.3)), roomOf(...p((t0d + t1d) / 2, 0.3))];
            for (const f of solids) if (overlap(foot(f), zone) && sides.includes(roomOf(f.x, f.z))) stats.doorways++;
          }
        }
        for (const r of plan.rooms) {
          const inRoom = plan.furniture.filter((f) => pointInPoly(r.poly, f.x, f.z));
          const o = minAreaRect(r.poly), short = 2 * Math.min(o.hu, o.hv);
          if (r.type === 'living' && short >= 3.2) {
            stats.livings++;
            const sofa = inRoom.find((f) => f.kind === 'sofa');
            if (sofa) stats.sofas++;
            const tv = inRoom.find((f) => f.kind === 'tvStand');
            if (tv && sofa) {
              stats.tvs++;
              const fx = Math.sin(sofa.yaw), fz = Math.cos(sofa.yaw);
              const along = (tv.x - sofa.x) * fx + (tv.z - sofa.z) * fz, facing = -(Math.sin(tv.yaw) * fx + Math.cos(tv.yaw) * fz);
              if (along < 1.8 || facing < 0.7) stats.tvAway++;
            }
          }
          if (r.type === 'bedroom' && short >= 2.4) {
            stats.bedrooms++;
            const bed = inRoom.find((f) => f.use === 'sleep');
            if (bed) { stats.beds++; if (backToWall(bed, plan, poly) > 0.25) stats.bedOff++; }
          }
          if (r.type === 'kitchen' && short >= 2.2) { stats.kitchens++; if (inRoom.some((f) => f.kind === 'kitchenRow')) stats.rows++; }
        }
      }
    }
  }
  const S = stats;
  check(S.storeys > 50, `home storeys checked (${S.storeys})`);
  check(S.outside === 0, `furniture stands inside its room (${S.outside} of ${S.solids} pieces reach out)`);
  check(S.overlaps === 0, `furniture pieces stand apart (${S.overlaps} overlapping pairs)`);
  check(S.doorways === 0, `doorways kept free of furniture (${S.doorways} pieces in a doorway)`);
  check(S.sofas >= S.livings * 0.95, `living rooms have a sofa (${S.sofas} of ${S.livings})`);
  check(S.tvs >= S.sofas * 0.6 && S.tvAway === 0, `the TV stands across from the sofa, facing it (${S.tvs} TVs for ${S.sofas} sofas, ${S.tvAway} elsewhere)`);
  check(S.beds >= S.bedrooms * 0.95 && S.bedOff === 0, `bedrooms have a bed with its head against a wall (${S.beds} of ${S.bedrooms}, ${S.bedOff} standing free)`);
  check(S.rows >= S.kitchens * 0.9, `kitchens have their counter row (${S.rows} of ${S.kitchens})`);
  check(S.ms / S.storeys < 20, `a home storey is planned and furnished in ${(S.ms / S.storeys).toFixed(1)} ms (< 20)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let fails = 0;
  homeChecks((ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; });
  process.exit(fails ? 1 : 0);
}
