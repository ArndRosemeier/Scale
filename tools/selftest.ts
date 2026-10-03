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
import { pointInPoly, distPointPolyEdge } from '../src/core/geom2';
import { buildBuildingShell, facadeSpecs } from '../src/build/buildingShell';
import { MeshBuilder } from '../src/build/meshBuilder';
import { Population } from '../src/sim/Population';
import { planFloor, planLift } from '../src/interior/InteriorGen';
import { metroInput } from './metroaudit';
import { auditLines, auditPassages } from './metroAuditCore';
import { LandUse, newLandSample, parcelAt, type Parcel } from '../src/world/landuse';
import { ForestGen, FOREST_KINDS, FOREST_STRIDE } from '../src/build/forest';
import { terrainExtent } from '../src/world/boundary';

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

/**
 * Roof over the top tier's outline: every up-facing roof triangle lies over the outline (plus
 * the eaves), faces up by its winding, and every point of the outline is under the roof.
 */
/** Interior walls and furniture of the first storeys standing outside the storey outline (> 10 cm). */
function interiorFaults(b: BuildingDesc, L: BuildingLayout): number {
  let n = 0;
  for (const fl of L.floors.slice(0, 2)) {
    const poly = L.tiers[fl.tier].poly;
    const fp = planFloor(b, poly, fl.f, fl.y0, fl.y1 - fl.y0, 0, planLift(b, poly));
    for (const w of fp.walls) {
      for (let t = 0; t <= 1.0001; t += 0.25) {
        const x = w.ax + (w.bx - w.ax) * t, z = w.az + (w.bz - w.az) * t;
        if (!pointInPoly(poly, x, z) && distPointPolyEdge(poly, x, z) > 0.1) { n++; break; }
      }
    }
    for (const f of fp.furniture) if (!pointInPoly(poly, f.x, f.z)) n++;
  }
  return n;
}

function roofFaults(b: BuildingDesc, terrain: Terrain): number {
  const mb = new MeshBuilder(facadeSpecs());
  const info = buildBuildingShell(mb, b, 0, terrain, 0, 'shell');
  const top = info.layout.tiers[info.layout.tiers.length - 1].poly;
  const md = mb.build();
  const P = md.attrs.position.array as Float32Array, N = md.attrs.normal.array as Float32Array, Ly = md.attrs.aLayer.array as Float32Array;
  const [ox, oy, oz] = md.origin, I = md.index;
  const tris: number[][] = [];
  let faults = 0;
  for (let t = 0; t < I.length; t += 3) {
    const v = [I[t], I[t + 1], I[t + 2]];
    if (Ly[v[0]] !== 16 + b.roofMat || N[v[0] * 3 + 1] < 0.05) continue;
    const cy = (P[v[0] * 3 + 1] + P[v[1] * 3 + 1] + P[v[2] * 3 + 1]) / 3 + oy;
    if (cy < info.topY - 1 || cy > info.topY + 25) continue;
    const q = v.flatMap((k) => [P[k * 3] + ox, P[k * 3 + 2] + oz]);
    tris.push(q);
    const mx = (q[0] + q[2] + q[4]) / 3, mz = (q[1] + q[3] + q[5]) / 3;
    if (!pointInPoly(top, mx, mz) && distPointPolyEdge(top, mx, mz) > 0.5) faults++;
    if ((q[3] - q[1]) * (q[4] - q[0]) - (q[2] - q[0]) * (q[5] - q[1]) < 0) faults++;
  }
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < top.length; i += 2) { x0 = Math.min(x0, top[i]); x1 = Math.max(x1, top[i]); z0 = Math.min(z0, top[i + 1]); z1 = Math.max(z1, top[i + 1]); }
  for (let x = x0 + 0.5; x < x1; x += 2) for (let z = z0 + 0.5; z < z1; z += 2) {
    if (!pointInPoly(top, x, z) || distPointPolyEdge(top, x, z) < 0.45) continue;
    const s = (q: number[], a: number, c: number) => (x - q[c]) * (q[a + 1] - q[c + 1]) - (q[a] - q[c]) * (z - q[c + 1]);
    if (!tris.some((q) => { const d = [s(q, 0, 2), s(q, 2, 4), s(q, 4, 0)]; return !(d.some((e) => e < -1e-9) && d.some((e) => e > 1e-9)); })) faults++;
  }
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
  let buildings = 0, overlapRoad = 0, outside = 0, floorFaults = 0, roofs = 0, interiors = 0;
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
      roofs += roofFaults(b, terrain);
      interiors += interiorFaults(b, L);
    }
  }
  check(buildings > 0, `seed ${seed}: buildings generated (${buildings})`);
  check(floorFaults === 0, `seed ${seed}: ground floors above the terrain, fully tiled and reachable from the street (${floorFaults} faults)`);
  check(roofs === 0, `seed ${seed}: roofs cover their footprints exactly, facing up (${roofs} faults)`);
  check(interiors === 0, `seed ${seed}: interior walls and furniture inside the storey outline (${interiors} outside)`);
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
    check(r.platformGapMin >= 0.02 && r.platformGapMax <= 0.1 && r.floorStep < 0.01, `${at}: platform edge 2–10 cm from the car side, level with the car floor (gap ${r.platformGapMin.toFixed(3)}…${r.platformGapMax.toFixed(3)} m, step ${r.floorStep.toFixed(3)} m)`);
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

// Countryside: the land-use field and forest tiles are deterministic, the countryside rivers
// leave the city's terrain untouched and run on to the edge of the world.
for (const [seed, size] of [[3, 0.2], [42, 0.4]] as const) {
  const t0 = performance.now();
  const p = makeProfile({ seed, size });
  const tA = new Terrain(p), tB = new Terrain(makeProfile({ seed, size })), tCity = new Terrain(p, false);
  const macro = buildMacroPlan(tA);
  const lA = new LandUse(tA), lB = new LandUse(tB);
  const sA = newLandSample(), sB = newLandSample();
  const par: Parcel = { i: 0, j: 0, strip: 0, id: 0, crop: 0, border: 0, fu: 0, fv: 0 };
  let same = true, forest = 0, field = 0, n = 0, badParcel = 0;
  for (let k = 0; k < 400; k++) {
    const x = Math.sin(k * 12.9898) * 9000, z = Math.cos(k * 78.233) * 9000;
    lA.sample(x, z, sA); lB.sample(x, z, sB);
    if (JSON.stringify(sA) !== JSON.stringify(sB)) same = false;
    if (sA.rural > 0.99) { n++; forest += sA.forest; field += sA.field; }
    parcelAt(lA.parcels, x, z, par);
    if (!(par.border >= 0) || par.crop < 0 || par.crop > 7) badParcel++;
  }
  check(same, `seed ${seed}: land use deterministic`);
  check(n > 100 && forest / n > 0.08 && field / n > 0.08, `seed ${seed}: countryside has forests and fields (${(forest / n * 100).toFixed(0)}% / ${(field / n * 100).toFixed(0)}%)`);
  check(badParcel === 0, `seed ${seed}: parcels valid`);
  const gA = new ForestGen(lA, macro), gB = new ForestGen(lB, buildMacroPlan(tB));
  let trees = 0;
  for (const [x0, z0, sz] of [[4096, 4096, 256], [-5120, 2048, 256], [8192, -8192, 2048]]) {
    const a = gA.tile(x0, z0, sz), b = gB.tile(x0, z0, sz);
    check(a.length === b.length && a.every((v, i) => v === b[i]), `seed ${seed}: forest tile ${x0},${z0} deterministic`);
    for (let o = 0; o < a.length; o += FOREST_STRIDE) if (!FOREST_KINDS[a[o + 5]] || a[o] < x0 || a[o] >= x0 + sz) trees = -1e9; else trees++;
  }
  check(trees > 0, `seed ${seed}: forest tiles hold valid trees (${trees})`);
  let diff = 0;
  for (let k = 0; k < 3000; k++) {
    const r = tA.protectR * Math.sqrt((k % 997) / 997), a = k * 2.399963;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (tA.height(x, z) !== tCity.height(x, z) || tA.waterLevel(x, z) !== tCity.waterLevel(x, z)) diff++;
  }
  check(diff === 0, `seed ${seed}: countryside rivers leave the city terrain unchanged (${diff} differences)`);
  const edge = terrainExtent(macro.boundary) * 0.95;
  check(tA.rivers.slice(tA.baseRivers).some((R) => { for (let i = 0; i < R.pts.length; i += 2) if (Math.max(Math.abs(R.pts[i]), Math.abs(R.pts[i + 1])) > edge) return true; return false; }), `seed ${seed}: rivers reach the edge of the world`);
  console.log(`seed ${seed} countryside: ${tA.rivers.length - tA.baseRivers} countryside rivers, ${trees} trees checked in ${(performance.now() - t0).toFixed(0)} ms`);
}

// ---- powers: every rank has truthful text, super speed outruns flight, old saves migrate
{
  const { ABILITIES, LEGACY_IDS } = await import('../src/game/abilities/defs');
  const T = await import('../src/game/abilities/tuning');
  for (const d of ABILITIES) for (let r = 1; r <= d.maxRank; r++) {
    const txt = d.rankText(r) + (d.costText ? d.costText(r) : '');
    check(!/NaN|undefined|Infinity/.test(txt), `${d.id} rank ${r} text: ${txt}`);
    check((T.KARMA_COST as Record<string, readonly number[]>)[d.id]?.length === d.maxRank, `${d.id}: karma cost for every rank`);
  }
  for (let r = 1; r <= T.MAX_RANK; r++) check(T.SPEED_TOP[r] > T.FLIGHT_BOOST * T.FLIGHT_SPEED[r] * 1.1, `super speed rank ${r} clearly faster than flight boost`);
  check(LEGACY_IDS.dash === 'speed', 'dash folds into super speed');
  // A Normal save from before the fold: dash rank 3 on slot 2 becomes super speed rank 3 there.
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
  store.set('scale.progress.v1.5.0.30', JSON.stringify({ v: 1, karma: 40, earned: 100, deeds: 3, ranks: { dash: 3, flight: 1 }, slots: ['flight', 'dash', null, null, null, null, null, null], cores: [], seen: [], bonusMax: 0, bonusRegen: 0 }));
  const { Progress } = await import('../src/game/abilities/Progress');
  const pg = new Progress(5, 0.3, 'normal');
  check(pg.rank('speed') === 3 && pg.slots[1] === 'speed' && pg.slots.length === 10 && pg.karma === 40, `old save migrates (speed ${pg.rank('speed')}, slot ${pg.slots[1]})`);
  check(pg.rank('dash' as never) === 3 && pg.rank('nonsense' as never) === 0, 'rank lookups are robust for unknown / legacy ids');
  console.log(`powers: ${ABILITIES.length} abilities checked`);
}

// ---- street crime: district index and director are deterministic; a purse snatch runs
// approach → escape → KO → arrested with scripted time (headless, mocked world).
{
  const { crimeIndex, crimesPerMinute } = await import('../src/game/crime/CrimeIndex');
  const { planHour, rollSlot } = await import('../src/game/crime/CrimeDirector');
  const t0 = performance.now();
  const macro = buildMacroPlan(new Terrain(makeProfile({ seed: 42, size: 0.3 })));
  const iA = crimeIndex(macro, 42), iB = crimeIndex(buildMacroPlan(new Terrain(makeProfile({ seed: 42, size: 0.3 }))), 42), iC = crimeIndex(macro, 43);
  check(iA.length === macro.cells.length && iA.every((v, i) => v === iB[i]), 'crime index deterministic for (seed, plan)');
  check(iA.every((v) => v >= 0 && v <= 1), 'crime index in 0..1');
  check(iA.some((v, i) => v !== iC[i]), 'crime index varies with the seed (poverty noise)');
  const mean = (d: string) => { const v = macro.cells.map((c, i) => (c.district === d ? iA[i] : NaN)).filter((x) => !Number.isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
  const rough = [mean('industrial'), mean('port'), mean('apartments')].filter((x) => !Number.isNaN(x));
  const safe = [mean('suburban'), mean('downtown')].filter((x) => !Number.isNaN(x));
  check(!rough.length || !safe.length || Math.max(...rough) > Math.min(...safe), `rough districts score higher than safe ones (${rough.map((x) => x.toFixed(2))} vs ${safe.map((x) => x.toFixed(2))})`);
  const perMin = crimesPerMinute(0.5, 'apartments', 13, 'normal');
  check(perMin > 0.33 && perMin < 1, `average district by day: one crime every 1–3 min (${(1 / perMin).toFixed(1)} min)`);
  check(crimesPerMinute(0.5, 'apartments', 13, 'off') === 0 && crimesPerMinute(0.9, 'port', 1, 'normal') > crimesPerMinute(0.15, 'suburban', 13, 'normal') * 4, 'rate: off is off, bad district at night far above a safe suburb by day');
  const cell = macro.cells.findIndex((c) => c.district !== 'water');
  for (const [day, hour] of [[0, 14], [3, 22], [9, 2]]) {
    const a = planHour(42, day, hour, cell, iA[cell], macro.cells[cell].district, 'chaos');
    const b = planHour(42, day, hour, cell, iA[cell], macro.cells[cell].district, 'chaos');
    check(JSON.stringify(a) === JSON.stringify(b), `director: same crime weather for seed / day ${day} / hour ${hour}`);
  }
  const all = Array.from({ length: 24 }, (_, h) => planHour(42, 1, h, cell, 0.6, 'apartments', 'chaos')).flat();
  const other = Array.from({ length: 24 }, (_, h) => planHour(43, 1, h, cell, 0.6, 'apartments', 'chaos')).flat();
  check(all.length > 10 && JSON.stringify(all) !== JSON.stringify(other), `director rolls crimes and the seed changes them (${all.length} in a day)`);
  check(rollSlot(42, 1, 12, 5, cell, 0.6, 'apartments', 'off') === null, 'director: off rolls nothing');

  // Snatch FSM with a mocked world.
  const { Snatch } = await import('../src/game/crime/Snatch');
  const { Combat } = await import('../src/game/Combat');
  const pop = new Population(macro, 42);
  type A = import('../src/sim/Pedestrians').PedAgent;
  const agents: A[] = [];
  const mk = (seed: number, x: number, z: number, heading: number, state = 0): A => {
    const a = { id: agents.length + 1, cit: { ...pop.synthetic(seed), role: 1 }, x, z, y: 0, heading, speed: 1.3, pref: 1.3, state, route: Float32Array.from([x, z, 0]), wp: 1, dest: null, fear: 0, fearX: 0, fearZ: 0, lookX: 0, lookZ: 0, lookY: 0, stateT: 0, onRoad: false, phase: 0, look: seed, vy: 0, vx: 0, vz: 0, alive: true, slot: -1 } as unknown as A;
    agents.push(a);
    return a;
  };
  const victim = mk(7, 150, 0, -Math.PI / 2); // walking along +x
  for (let k = 0; k < 4; k++) mk(100 + k, 150 + k * 3, 6, 0, 2); // bystanders standing
  const combat = new Combat({ knockDown: (a, fx, fz, power) => { a.state = 5; a.stateT = 0; const d = Math.hypot(a.x - fx, a.z - fz) || 1; a.vx = ((a.x - fx) / d) * power; a.vz = ((a.z - fz) / d) * power; } });
  const player = { x: 0, y: 0, z: 0, vx: 0, vz: 0, height: 1.8, flying: false, strength: 1 };
  let time = 0, policeCalls = 0;
  const world = {
    get time() { return time; }, hour: 14, player,
    agents: () => agents,
    neighbours: (x: number, z: number, r: number) => agents.filter((a) => a.alive && Math.hypot(a.x - x, a.z - z) < r),
    spawn: (seed: number, x: number, z: number, h: number) => mk(seed, x, z, h, 2),
    route: (ax: number, az: number, bx: number, bz: number) => Float32Array.from([ax, az, 0, bx, bz, 0]),
    visible: () => false, emit: () => {}, sound: () => {}, combat,
    hurtPlayer: () => {}, callPolice: () => { policeCalls++; }, random: () => 0.5,
  };
  const crime = new Snatch(world, 12345);
  check(crime.setup(), 'snatch: setup finds a victim and a thief');
  const thief = crime.thief!;
  const phases: string[] = [];
  const events: string[] = [];
  const step = (dt: number) => {
    time += dt;
    // Minimal movement: walkers walk on, actors go to their goal.
    for (const a of agents) {
      if (!a.alive || a.state === 5) continue;
      const act = a.actor;
      if (act) {
        act.stateT += dt; act.attackT -= dt; act.replanT -= dt;
        const g = act.goal;
        if (g) { const dx = g.x - a.x, dz = g.z - a.z, d = Math.hypot(dx, dz); const s = Math.min(d, act.speed * dt); if (d > 1e-6) { a.x += (dx / d) * s; a.z += (dz / d) * s; a.heading = Math.atan2(-dx, -dz); } }
      } else if (a.state === 0) { a.x += -Math.sin(a.heading) * a.speed * dt; a.z += -Math.cos(a.heading) * a.speed * dt; }
    }
    crime.update(dt);
    for (const e of crime.events) events.push(e.type);
    crime.events.length = 0;
    if (phases[phases.length - 1] !== crime.phase) phases.push(crime.phase);
  };
  for (let i = 0; i < 600 && crime.phase === 'approach'; i++) step(0.05);
  check(crime.phase === 'escape' && thief.actor?.held === 'bag' && crime.loot?.carrier === thief, `snatch: the thief grabs the bag and runs (${crime.phase})`);
  for (let i = 0; i < 40; i++) step(0.05);
  check(Math.hypot(thief.x - victim.x, thief.z - victim.z) > 5, 'snatch: the thief gets away from the victim');
  // The hero catches up and punches until he is out.
  let hits = 0;
  for (let i = 0; i < 200 && thief.actor!.state !== 'ko'; i++) {
    player.x = thief.x + 0.9; player.z = thief.z;
    if (i % 12 === 0) { combat.hitActor(thief, -400, 80, 0, 'punch', 'player'); hits++; }
    step(0.05);
  }
  check(thief.actor!.state === 'ko' && hits <= 4, `snatch: a few punches knock the thief out (${hits} hits, ${thief.actor!.state})`);
  step(0.05);
  check(crime.phase === 'subdued' && crime.loot?.carrier === null, `snatch: subdued, the bag drops (${crime.phase})`);
  crime.arrest(thief);
  step(0.05);
  check(crime.phase === 'resolved' && crime.outcome === 'arrested' && thief.actor!.state === 'arrested', `snatch: arrested, resolved (${crime.phase}, ${crime.outcome})`);
  check(events.join(',') === 'commit,ko,arrest,resolved' && policeCalls === 1, `snatch events ${events.join(',')}, police called ${policeCalls} times`);
  check(phases.join('>') === 'approach>escape>subdued>resolved', `snatch phases ${phases.join(' > ')}`);
  console.log(`crime: index ${macro.cells.length} cells, ${all.length} rolls/day (chaos), snatch FSM ${phases.join(' > ')} in ${(performance.now() - t0).toFixed(0)} ms`);
}

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('all checks passed');
