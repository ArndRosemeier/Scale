/**
 * Entrance doors kept clear: rebuild the ground floor of every building in a few cities exactly as
 * Interiors does and probe the walkway just inside the street door (1.5 m deep, 0.9 m wide)
 * for walls, the stair core, the lift and solid furniture. Run by tools/selftest.ts, or on its own:
 *   npx tsx tools/doorsweep.ts [seedA-seedB] [size]     prints the blocked doors and what blocks them
 */
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { planCell } from '../src/plan/cell';
import { buildingLayout } from '../src/build/buildingLayout';
import { planFloor, planCores, coreFits, coreRect, liftRect, shopKindOf } from '../src/interior/InteriorGen';
import { wallCollisionSegments, furnitureCollision } from '../src/interior/InteriorBuilder';
import { pointInPoly, distSqPointSeg } from '../src/core/geom2';
import { offset } from '../src/core/clip';

type Check = (ok: boolean, msg: string) => void;

/** Depth of the walkway kept clear behind a street door (m), half its width, a walker's radius. */
const DEPTH = 1.5, HALF = 0.2, R = 0.25;

export interface DoorStats { doors: number; blocked: number; multi: number; noStairs: number; by: Record<string, number>; examples: string[] }

export function sweepDoors(seeds: number[], size: number): DoorStats {
  const s: DoorStats = { doors: 0, blocked: 0, multi: 0, noStairs: 0, by: {}, examples: [] };
  for (const seed of seeds) {
    const terrain = new Terrain(makeProfile({ seed, size }));
    const macro = buildMacroPlan(terrain);
    for (const c of macro.cells) {
      const p = planCell(macro, c, terrain);
      for (const b of p.buildings) {
        if (b.floors <= 0) continue;
        const L = buildingLayout(b, terrain, 0);
        const fl = L.floors.find((q) => q.f === 0);
        if (!fl || L.tiers[0].poly !== b.poly) continue; // no door leaf there in the game either
        const fpoly = (f: number) => {
          const x = L.floors.find((q) => q.f === f);
          const tp = L.tiers[x ? x.tier : 0].poly;
          const inner = offset([tp], -0.2, 'miter');
          return inner.length ? inner[0].outer : tp;
        };
        const poly = fpoly(0);
        const { lift, stair } = planCores(b, poly, Math.max(...L.floors.map((q) => q.y1 - q.y0)), L.door);
        if (b.floors >= 2 && b.style !== 'church') { s.multi++; if (!stair) s.noStairs++; }
        const stairsAt = (f: number) => !!stair && f >= 0 && f < b.floors && !!L.floors.find((x) => x.f === f) && coreFits(stair, fpoly(f));
        const up = stairsAt(0) && stairsAt(1);
        const plan = planFloor(b, poly, 0, fl.y0, fl.y1 - fl.y0, shopKindOf(b), lift, stair, up, false, L.door);
        plan.furniture = plan.furniture.filter((q) => q.kind === 'rug' || q.kind === 'painting' || q.use === 'dress' || Math.hypot(q.x - L.door.x, q.z - L.door.z) > 2.4 + Math.max(q.w, q.d) / 2);
        s.doors++;
        // Door frame: along the front edge, inward normal.
        const P = b.poly, n = P.length >> 1, i = L.door.edge, j = (i + 1) % n;
        const len = Math.hypot(P[j * 2] - P[i * 2], P[j * 2 + 1] - P[i * 2 + 1]);
        const ex = (P[j * 2] - P[i * 2]) / len, ez = (P[j * 2 + 1] - P[i * 2 + 1]) / len, ix = -ez, iz = ex;
        const walls = wallCollisionSegments(plan), furn = furnitureCollision(plan);
        const core = stair && stairsAt(0) ? coreRect(stair) : null;
        const shaft = plan.lift ? liftRect(plan.lift) : null;
        const hits = new Set<string>();
        for (let d = 0.45; d <= DEPTH + 1e-6; d += 0.15) for (const t of [-HALF, 0, HALF]) {
          const x = L.door.x + ix * d + ex * t, z = L.door.z + iz * d + ez * t;
          if (!pointInPoly(b.poly, x, z)) { hits.add('outline'); continue; }
          for (let k = 0; k < walls.length; k += 4) if (distSqPointSeg(x, z, walls[k], walls[k + 1], walls[k + 2], walls[k + 3]) < R * R) hits.add('wall');
          for (let k = 0; k < furn.length; k += 5) if (distSqPointSeg(x, z, furn[k], furn[k + 1], furn[k + 2], furn[k + 3]) < R * R) hits.add('furniture');
          if (core && pointInPoly(core, x, z)) hits.add('stairs');
          if (shaft && pointInPoly(shaft, x, z)) hits.add('lift');
        }
        if (hits.size) {
          s.blocked++;
          for (const h of hits) s.by[h] = (s.by[h] ?? 0) + 1;
          if (s.examples.length < 12) s.examples.push(`seed ${seed}@${size} ${b.use}/${b.style} floors ${b.floors} door ${L.door.x.toFixed(1)},${L.door.z.toFixed(1)}: ${[...hits].join('+')}`);
        }
      }
    }
  }
  return s;
}

export function doorChecks(check: Check): void {
  const t0 = performance.now();
  const s = sweepDoors([42], 0.35);
  // Odd little footprints (triangles, doors by an acute corner) may only leave a narrower way in.
  check(s.doors > 5000 && s.blocked <= s.doors * 0.005, `entrance doors: a clear walkway behind the street doors (${s.blocked} of ${s.doors} narrowed: ${JSON.stringify(s.by)})${s.examples.length ? ' e.g. ' + s.examples.slice(0, 3).join('; ') : ''}`);
  check(s.noStairs <= s.multi * 0.04, `entrance doors: multi-storey buildings keep their stairs (${s.noStairs} of ${s.multi} without)`);
  console.log(`doors: ${s.doors} in ${Math.round(performance.now() - t0)} ms`);
}

if (process.argv[1]?.endsWith('doorsweep.ts')) {
  const [a, bb] = (process.argv[2] ?? '1-5').split('-').map(Number);
  const size = Number(process.argv[3] ?? 0.5);
  const seeds: number[] = [];
  for (let k = a; k <= (bb ?? a); k++) seeds.push(k);
  const s = sweepDoors(seeds, size);
  console.log(`${s.blocked} of ${s.doors} doors blocked (${(100 * s.blocked / Math.max(1, s.doors)).toFixed(1)}%)`, s.by, `; ${s.noStairs} of ${s.multi} multi-storey buildings without stairs`);
  for (const e of s.examples) console.log('  ' + e);
}
