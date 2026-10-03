/**
 * Headless self test: determinism and invariants of world + plan generation,
 * population schedules and building layouts. `npm test`
 */
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { planCell } from '../src/plan/cell';
import { buildingLayout, gridCell, stoopTop, type BuildingLayout } from '../src/build/buildingLayout';
import { CURB_H } from '../src/build/ground';
import type { BuildingDesc } from '../src/plan/building';
import { pointInPoly } from '../src/core/geom2';
import { Population } from '../src/sim/Population';
import { metroInput } from './metroaudit';
import { auditLines, auditPassages } from './metroAuditCore';

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) { failures++; console.error('  FAIL', msg); }
};
const hashPlan = (o: unknown) => {
  const s = JSON.stringify(o, (_k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v));
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

/**
 * Ground floor of a building (on slopes too): the terrain stays below the floor everywhere
 * under the footprint, every point of the footprint has a slab tile (no hole to sink
 * through), and the door is reachable from the street in steps a walker can take
 * (no rise over 0.31 m from the ground in front, up the stoop, through the door).
 */
function groundFloorFaults(b: BuildingDesc, L: BuildingLayout, terrain: Terrain): number {
  let faults = 0;
  const fl = L.floors[0], grid = L.tiers[fl.tier].grid;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < b.poly.length; i += 2) { x0 = Math.min(x0, b.poly[i]); x1 = Math.max(x1, b.poly[i]); z0 = Math.min(z0, b.poly[i + 1]); z1 = Math.max(z1, b.poly[i + 1]); }
  for (let x = x0; x <= x1; x += 1.5) for (let z = z0; z <= z1; z += 1.5) {
    if (!pointInPoly(b.poly, x, z)) continue;
    if (terrain.height(x, z) > fl.y0 + 1e-3) faults++;
    const c = gridCell(grid, x, z);
    if (c < 0 || fl.tiles[c] < 0) faults++;
  }
  // Walk from the street to the door: past the lowest step, up the boxes, into the door.
  const n = b.poly.length >> 1, i = L.door.edge, j = (i + 1) % n;
  const ex = b.poly[j * 2] - b.poly[i * 2], ez = b.poly[j * 2 + 1] - b.poly[i * 2 + 1], el = Math.hypot(ex, ez);
  const nx = ez / el, nz = -ex / el;
  const S = L.stoop;
  const h = (x: number, z: number) => pointInPoly(b.poly, x, z) ? fl.y0 : Math.max(terrain.height(x, z) + CURB_H, S ? stoopTop(S, x, z) : -Infinity);
  const pts: [number, number][] = [];
  if (S) {
    const ord: number[] = [];
    for (let k = 0; k < S.boxes.length; k += 5) ord.push(k);
    ord.sort((p, q) => S.boxes[p + 4] - S.boxes[q + 4]);
    const lo = ord[0], nx2 = ord[1] ?? lo;
    let dx = S.boxes[lo] - S.boxes[nx2], dz = S.boxes[lo + 1] - S.boxes[nx2 + 1];
    if (Math.hypot(dx, dz) < 1e-6) { dx = nx; dz = nz; }
    const dl = Math.hypot(dx, dz);
    pts.push([S.boxes[lo] + (dx / dl) * 1.5, S.boxes[lo + 1] + (dz / dl) * 1.5]);
    for (const k of ord) pts.push([S.boxes[k], S.boxes[k + 1]]);
  } else pts.push([L.door.x + nx * 1.5, L.door.z + nz * 1.5]);
  pts.push([L.door.x + nx * 0.3, L.door.z + nz * 0.3], [L.door.x - nx * 0.8, L.door.z - nz * 0.8]);
  let prev = h(pts[0][0], pts[0][1]), rise = 0;
  for (let q = 0; q + 1 < pts.length; q++) {
    const [ax, az] = pts[q], [bx, bz] = pts[q + 1];
    const m = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.05);
    for (let t = 1; t <= m; t++) {
      const y = h(ax + ((bx - ax) * t) / m, az + ((bz - az) * t) / m);
      rise = Math.max(rise, y - prev);
      prev = y;
    }
  }
  if (rise > 0.31) faults++;
  return faults;
}

for (const [seed, size] of [[1, 0.1], [42, 0.4], [7, 0.7], [10, 0.2]] as const) {
  const t0 = performance.now();
  const profile = makeProfile({ seed, size });
  const terrain = new Terrain(profile);
  const macro = buildMacroPlan(terrain);
  const macro2 = buildMacroPlan(new Terrain(makeProfile({ seed, size })));
  check(hashPlan(macro.cells.map((c) => c.poly)) === hashPlan(macro2.cells.map((c) => c.poly)), `seed ${seed}: macro plan deterministic`);
  check(macro.cells.length > 5, `seed ${seed}: has cells (${macro.cells.length})`);
  check(macro.edges.length > 10, `seed ${seed}: has arterials`);
  // Cells near the centre.
  const c0 = macro.centres[0];
  const near = macro.cells.slice().sort((a, b) => Math.hypot(a.centroid[0] - c0.x, a.centroid[1] - c0.z) - Math.hypot(b.centroid[0] - c0.x, b.centroid[1] - c0.z)).slice(0, 6);
  let buildings = 0, overlapRoad = 0, outside = 0, floorFaults = 0;
  for (const c of near) {
    const p1 = planCell(macro, c, terrain), p2 = planCell(macro, c, terrain);
    check(hashPlan(p1.buildings) === hashPlan(p2.buildings), `seed ${seed} cell ${c.id}: cell plan deterministic`);
    for (const b of p1.buildings) {
      buildings++;
      let cx = 0, cz = 0;
      for (let i = 0; i < b.poly.length; i += 2) { cx += b.poly[i]; cz += b.poly[i + 1]; }
      cx /= b.poly.length / 2; cz /= b.poly.length / 2;
      if (!pointInPoly(c.poly, cx, cz)) outside++;
      for (const s of p1.carriageway) if (pointInPoly(s.outer, cx, cz) && !s.holes.some((h) => pointInPoly(h, cx, cz))) { overlapRoad++; break; }
      const L = buildingLayout(b, terrain, 0);
      check(L.panels.length > 0 && L.elemCount > L.panels.length, `building layout has panels and elements`);
      floorFaults += groundFloorFaults(b, L, terrain);
    }
  }
  check(buildings > 0, `seed ${seed}: buildings generated (${buildings})`);
  check(floorFaults === 0, `seed ${seed}: ground floors above the terrain, fully tiled and reachable from the street (${floorFaults} faults)`);
  check(outside === 0, `seed ${seed}: buildings inside their cells (${outside} outside)`);
  check(overlapRoad < buildings * 0.01 + 1, `seed ${seed}: buildings off the road (${overlapRoad})`);
  // Metro stations are on land.
  for (const st of macro.metroStations) check(!terrain.isWater(st.x, st.z), `seed ${seed}: station ${st.name} on land`);
  // Metro geometry (see tools/metroaudit.ts): tracks straight and level through their halls,
  // gentle gradients and curves, covered, clear of each other and of the sewers; trains stop
  // inside the halls on the track bed; every entrance walkable from the street to the platform.
  const { input: mi, inHole } = metroInput(macro, terrain);
  for (const r of auditLines(mi)) {
    const at = `seed ${seed} line ${r.name}`;
    check(r.hallLateral < 0.05 && r.hallDy < 0.05, `${at}: track on the hall axis at hall level (${r.hallLateral.toFixed(2)} m off, ${r.hallDy.toFixed(2)} m step)`);
    check(r.maxGrade <= 0.0401, `${at}: gradient ≤ 4% (${(r.maxGrade * 100).toFixed(1)}%)`);
    check(r.minRadius >= 60, `${at}: curve radius ≥ 60 m (${r.minRadius.toFixed(0)} m)`);
    check(r.minCover >= 5.5, `${at}: ≥ 5.5 m of cover over tunnels and halls (${r.minCover.toFixed(2)} m)`);
    check(r.lineConflicts === 0 && r.sewerConflicts === 0, `${at}: clear of other lines and sewers (${r.lineConflicts} / ${r.sewerConflicts} conflicts)`);
    check(r.carsOutside === 0 && r.carDy < 0.05 && r.carLateral < 0.3, `${at}: trains on the track, stopping inside the halls (${r.carsOutside} cars outside, ${r.carDy.toFixed(2)} m off the bed)`);
  }
  for (const p of auditPassages(mi, inHole)) {
    check(p.maxSlope <= 0.65 && p.floorErr <= 0.05 && p.ceilingOut <= 0 && p.hits === 0 && p.endsOnPlatform,
      `seed ${seed} entrance ${p.name}: walkable to the platform (slope ${p.maxSlope.toFixed(2)}, floor err ${p.floorErr.toFixed(2)}, ceiling ${p.ceilingOut.toFixed(2)}, cuts ${p.hits}, on platform ${p.endsOnPlatform})`);
  }
  // Population: plans are deterministic and every trip connects consecutive stays.
  const pop = new Population(macro, seed);
  const cp = planCell(macro, near[0], terrain);
  const b0 = cp.buildings.find((b) => b.units > 0) ?? cp.buildings[0];
  if (b0) {
    const res = pop.residentsOf(near[0].id, 0, b0);
    for (const cit of res.slice(0, 20)) {
      const a = pop.dayPlan(cit, 3), b = new Population(macro, seed).dayPlan(cit, 3);
      check(hashPlan(a) === hashPlan(b), 'day plan deterministic');
      for (let i = 0; i < a.trips.length; i++) check(a.trips[i].depart >= a.stays[i].from - 1e-6, 'trip departs after its stay starts');
    }
  }
  console.log(`seed ${seed} size ${size}: ${macro.cells.length} cells, ${macro.metroStations.length} stations, ${buildings} buildings checked in ${(performance.now() - t0).toFixed(0)} ms`);
}

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('all checks passed');
