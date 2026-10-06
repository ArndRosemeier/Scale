/**
 * Headless self test: determinism and invariants of world + plan generation,
 * population schedules and building layouts. `npm test`
 */
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { planCell, PropType } from '../src/plan/cell';
import { RoadClass } from '../src/plan/types';
import { Eatery, eateryDemand, tableVisit } from '../src/plan/eatery';
import { TerraceKind, frontDoor, junctionPoints, clearOfWalk, WALK_CLEAR, DOOR_CLEAR, CROSSING_CLEAR, PT } from '../src/plan/terrace';
import { closestOnPolyline } from '../src/core/geom2';
import { buildingLayout, gridCell, stoopTop, type BuildingLayout } from '../src/build/buildingLayout';
import { CURB_H } from '../src/build/ground';
import type { BuildingDesc } from '../src/plan/building';
import { pointInPoly, distPointPolyEdge } from '../src/core/geom2';
import { buildBuildingShell, facadeSpecs } from '../src/build/buildingShell';
import { MeshBuilder } from '../src/build/meshBuilder';
import { Population } from '../src/sim/Population';
import { routeNearest } from '../src/sim/Pedestrians';
import { planFloor, planLift, planStair, coreFits } from '../src/interior/InteriorGen';
import { metroInput } from './metroaudit';
import { auditLines, auditPassages } from './metroAuditCore';
import { LandUse, newLandSample, parcelAt, type Parcel } from '../src/world/landuse';
import { ForestGen, FOREST_KINDS, FOREST_STRIDE } from '../src/build/forest';
import { RuralPlan, SettleKind, BOX_STRIDE } from '../src/world/rural';
import { buildRuralTile } from '../src/build/rural';
import { terrainExtent } from '../src/world/boundary';
import { cmuBvhChecks } from './cmuBvhTest';
import { parseSave, serializeSave, migrate, SAVE_VERSION, type SaveData } from '../src/game/save/model';
import { encodeIndexSet, decodeIndexSet, lowIndices } from '../src/game/save/codec';
import { makeActor, watchProgress, pursue, STUCK } from '../src/sim/actors/Actor';
import { GUNS, DRONE_PLATING, hitRate } from '../src/game/crime/Firearms';
import { LineOfSight, LOS, type LosCar, type LosWorld } from '../src/game/combat/los';
import { resolveShot, newShot, type ShotTrace } from '../src/game/combat/shot';
import { MoodDirector, MOODS, CALM_SIGNALS, MOOD_TUNING, type MusicSignals } from '../src/audio/music/mood';
import { parseStemManifest } from '../src/audio/music/StemPlayer';
import { streetSites, streetCast, kindAt, STREET_KINDS, STREET_KIND_LIST, SLOT_H, SiteKind, type StreetKind } from '../src/game/street/cast';
import { lineFor, allLines } from '../src/game/street/lines';
import { Justice, JUSTICE } from '../src/game/crime/Justice';
import type { HarmEntry } from '../src/game/Consequences';
import { ATTRACTION_KINDS, inSite, siteToWorld, siteRect, marvelDesign, marvelCount, type Landmark } from '../src/plan/landmarks';
import { landmarkParts, partOutline, solidFootprints, partObstacles, helixFloorAt, PK } from '../src/plan/landmarkParts';
import { MARVEL_STYLES, MS } from '../src/plan/marvelParts';
import { PIECE_STRIDE } from '../src/build/landmarkDice';
import { LID_LAT } from '../src/underground/layout';
import { LandmarkWrecks } from '../src/destruction/LandmarkWreck';
import { GLASS_IMPULSE } from '../src/destruction/wallStrength';
import type { LandmarkWreckData } from '../src/stream/CityStreamer';
import type { Destruction } from '../src/destruction/Destruction';
import type { MeshData } from '../src/build/meshBuilder';
import type { MaterialArrays } from '../src/render/TextureLibrary';
import { LandmarkSolids } from '../src/world/LandmarkSolids';
import { insideObstacle } from '../src/world/Collision';
import { marvelHall, marvelDoors } from '../src/plan/marvelParts';
import { auditWays } from './landmarkWays';
import { landmarkInterior } from '../src/plan/landmarkParts';
import { Rng as MRng } from '../src/core/rng';
import type { MacroPlan } from '../src/plan/types';
import { buildLandmarkMesh, buildLandmarkMeshes } from '../src/build/landmarks';
import * as THREE from 'three';
import { onScreen, screenPoint, toScreen } from '../src/render/screen';
import { makeSight } from '../src/game/sightline';
import type { WorldIndex as SightWorld } from '../src/world/WorldIndex';
import { AIRPORT_MIN_RADIUS } from '../src/world/airfield';
import { intersection } from '../src/core/clip';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { nameOf, traitsOf, temperamentOf, jobOf, interestOf, moodOf, moodWord, TEMPERAMENTS, type Temperament } from '../src/game/people/identity';
import { pickLine, ruleAnswer, fill, dirWord, type TalkFacts } from '../src/game/people/talk';
import { LINES, CHAT, type Topic } from '../src/game/people/lines';
import { planHoods, LiveIndex, LIVE, policePresence, policeCarWeight, beatPairs, responseFactor, safeStart, rollOffScreen, safetyOf, type Safety } from '../src/game/news/pulse';
import { headline, gossip, whenWord, localRemark } from '../src/game/news/headlines';
import { PEOPLE, onTheirWay, newKnown, applyDeed, remember, opinionOf, savePeople, restorePeople, addSaid } from '../src/game/people/memory';
import { rescueAllowed, pickHospital, hospitalFit, planFlight, flightAt, wardInside, wardExit, hospitalName, padSpot, WARD, type HospitalCandidate } from '../src/game/defeat/rules';

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
/** Multi-storey buildings / with stairs; stair flights that do not reach the next floor or leave the outline. */
const stairStats = { multi: 0, stairs: 0, faults: 0 };
/** Interior walls and furniture of the first storeys standing outside the storey outline (> 10 cm). */
function interiorFaults(b: BuildingDesc, L: BuildingLayout): number {
  let n = 0;
  const lift0 = planLift(b, L.tiers[0].poly);
  const stair = planStair(b, L.tiers[0].poly, lift0, Math.max(...L.floors.map((q) => q.y1 - q.y0)));
  if (b.floors >= 2 && b.style !== 'church') { stairStats.multi++; if (stair) stairStats.stairs++; }
  for (const fl of L.floors.slice(0, 2)) {
    const poly = L.tiers[fl.tier].poly;
    const next = L.floors.find((q) => q.f === fl.f + 1);
    const up = !!stair && !!next && coreFits(stair, poly) && coreFits(stair, L.tiers[next.tier].poly);
    const fp = planFloor(b, poly, fl.f, fl.y0, fl.y1 - fl.y0, 0, planLift(b, poly), stair, up, fl.f > 0 && !!stair && coreFits(stair, poly));
    if (up) {
      const top = fp.flights[fp.flights.length - 1];
      if (fp.flights.length !== 2 || Math.abs(top.y1 - next!.y0) > 0.05) stairStats.faults++;
      for (const f of fp.flights) for (const t of [0, 1]) if (!pointInPoly(poly, f.x + f.dx * f.run * t, f.z + f.dz * f.run * t)) stairStats.faults++;
    }
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

// Regression: these cities crashed in the bridge picking (the shared terrain.water() result was
// overwritten by a later water query before its river was read). Seed 1234 at size 1 had the same cause.
for (const [seed, size] of [[17, 0.75]] as const) {
  let ok = true;
  try { buildMacroPlan(new Terrain(makeProfile({ seed, size }))); } catch (e) { ok = false; console.error(e); }
  check(ok, `seed ${seed} size ${size}: macro plan builds without crashing`);
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
  console.log(`seed ${seed}: stairs in ${stairStats.stairs} of ${stairStats.multi} multi-storey buildings`);
  check(stairStats.faults === 0 && stairStats.stairs >= stairStats.multi * 0.75, `seed ${seed}: stairs in ${stairStats.stairs} of ${stairStats.multi} multi-storey buildings, every flight inside and reaching the next floor (${stairStats.faults} faults)`);
  stairStats.multi = stairStats.stairs = stairStats.faults = 0;
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
    check(p.maxSlope <= 0.65 && p.floorErr <= 0.05 && p.ceilingOut <= 0 && p.hits === 0 && p.endsOnPlatform && p.ledge <= 0.45,
      `seed ${seed} entrance ${p.name}: walkable to the platform (slope ${p.maxSlope.toFixed(2)}, floor err ${p.floorErr.toFixed(2)}, ceiling ${p.ceilingOut.toFixed(2)}, cuts ${p.hits}, on platform ${p.endsOnPlatform}, ledge ${p.ledge.toFixed(2)})`);
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

// Landmark sites are never walled in by buildings: from the middle of each side, walking straight
// out reaches a sidewalk or street before any building (seed 873738 at full size had its starship,
// town hall, cathedral and stadium ringed by houses).
{
  const terrain = new Terrain(makeProfile({ seed: 873738, size: 1 }));
  const macro = buildMacroPlan(terrain);
  for (const lm of macro.landmarks.filter((l) => l.cell >= 0)) {
    const plan = planCell(macro, macro.cells.find((c) => c.id === lm.cell)!, terrain);
    const walk = [...plan.sidewalks, ...plan.carriageway];
    const onWalk = (x: number, z: number) => walk.some((s) => pointInPoly(s.outer, x, z) && !s.holes.some((h) => pointInPoly(h, x, z)));
    let open = 0;
    for (const [du, dv] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      for (let d = 0; d < 300; d++) {
        const pts = [-2.5, 0, 2.5].map((s) => siteToWorld(lm, du * (lm.hu + d) + (du ? 0 : s), dv * (lm.hv + d) + (dv ? 0 : s)));
        if (pts.some(([x, z]) => plan.buildings.some((b) => pointInPoly(b.poly, x, z)))) break;
        if (pts.every(([x, z]) => onWalk(x, z))) { open++; break; }
      }
    }
    check(open === 4, `seed 873738 ${lm.name}: a way in from the street on every side (${open} of 4)`);
    let cluttered = 0;
    // (Awnings hang overhead on the fronts beside the way, so they don't count.)
    for (let i = 0; i < plan.props.length; i += 6) if (plan.props[i] !== PropType.Awning && plan.approaches.some((w) => pointInPoly(w, plan.props[i + 1], plan.props[i + 2]))) cluttered++;
    const onWay = (x: number, z: number) => plan.approaches.some((w) => pointInPoly(w, x, z));
    for (const e of plan.eateries) {
      for (let i = 0; i < e.tables.length; i += 3) if (onWay(e.tables[i], e.tables[i + 1])) cluttered++;
      for (let i = 0; i < e.seats.length; i += 4) if (onWay(e.seats[i], e.seats[i + 1])) cluttered++;
    }
    check(cluttered === 0, `seed 873738 ${lm.name}: its approaches kept clear of furniture and terraces (${cluttered} in the way)`);
  }
}

// Cafés, restaurants and their terraces (plan/eatery.ts, plan/terrace.ts): deterministic; outdoor
// seating never on a footprint, in a doorway, at a crossing or in the walking corridor of a
// sidewalk; parklets only in the parking strip of local streets; plausible counts per district;
// busy hours that make sense.
for (const [seed, size] of [[3, 0.5], [42, 0.4]] as const) {
  const t0 = performance.now();
  const terrain = new Terrain(makeProfile({ seed, size }));
  const macro = buildMacroPlan(terrain);
  const c0 = macro.centres[0];
  const cells = macro.cells.slice().sort((a, b) => Math.hypot(a.centroid[0] - c0.x, a.centroid[1] - c0.z) - Math.hypot(b.centroid[0] - c0.x, b.centroid[1] - c0.z)).slice(0, 70);
  const TERRACE = new Set<number>([PropType.CafeTable, PropType.CafeChair, PropType.Parasol, PropType.MenuBoard, PropType.TerraceRail, PropType.Parklet]);
  const R: Record<number, number> = { [PropType.CafeTable]: 0.38, [PropType.CafeChair]: 0.24, [PropType.Parasol]: 0.05, [PropType.MenuBoard]: 0.25, [PropType.TerraceRail]: 0.1, [PropType.Parklet]: 0 };
  const by: Record<string, { shops: number; eat: number; terr: number; seats: number; square: number; parklet: number }> = {};
  let items = 0, onFootprint = 0, inCorridor = 0, inDoor = 0, atCrossing = 0, badParklet = 0, badSeats = 0;
  for (const c of cells) {
    const p = planCell(macro, c, terrain);
    if (c === cells[0] || c === cells[5]) {
      const q = planCell(macro, c, terrain);
      check(hashPlan(p.eateries) === hashPlan(q.eateries) && hashPlan(p.props) === hashPlan(q.props), `seed ${seed} cell ${c.id}: eateries and terraces deterministic`);
    }
    const d = (by[c.district] ??= { shops: 0, eat: 0, terr: 0, seats: 0, square: 0, parklet: 0 });
    d.shops += p.buildings.filter((b) => b.shopfront).length;
    for (const e of p.eateries) {
      d.eat++;
      if (e.terrace !== TerraceKind.None) d.terr++;
      if (e.terrace === TerraceKind.Square) d.square++;
      if (e.terrace === TerraceKind.Parklet) d.parklet++;
      d.seats += e.seats.length / 4;
      check(p.buildings[e.b]?.eatery === e.kind, `seed ${seed} cell ${c.id}: eatery ${e.b} marked on its building`);
      for (let k = 0; k < e.seats.length; k += 4) {
        const t = e.seats[k + 3] * 3;
        if (Math.hypot(e.seats[k] - e.tables[t], e.seats[k + 1] - e.tables[t + 1]) > 0.95) badSeats++;
      }
    }
    const doors = p.buildings.map((b) => frontDoor(b));
    const junc = junctionPoints(p, c, macro);
    const open = [...p.plazas, ...p.parks];
    for (let i = 0; i < p.props.length; i += 6) {
      const t = p.props[i];
      if (!TERRACE.has(t)) continue;
      items++;
      const x = p.props[i + 1], z = p.props[i + 2], r = R[t];
      // On the road: a parklet (the parking strip of a local street) and what stands on it.
      let road: (typeof p.streets)[number] | null = null;
      for (const s of p.streets) if (closestOnPolyline(s.pts, x, z).d < s.width / 2) road = s;
      if (road) {
        const dd = closestOnPolyline(road.pts, x, z).d;
        if (road.cls !== RoadClass.Street || road.arterial >= 0 || dd < road.width / 2 - 1.95) badParklet++;
      } else if (t === PropType.Parklet) badParklet++;
      if (t !== PropType.Parklet && p.buildings.some((b) => pointInPoly(b.poly, x, z) || distPointPolyEdge(b.poly, x, z) < r)) onFootprint++;
      if (t !== PropType.Parklet && !clearOfWalk(p.streets, x, z, r, !!road)) inCorridor++;
      if (t !== PropType.Parklet && doors.some((o) => Math.hypot(o.x - x, o.z - z) < (t === PropType.MenuBoard ? 0.75 : DOOR_CLEAR) + r - 1e-6)) inDoor++;
      const onSquare = open.some((sh) => pointInPoly(sh.outer, x, z));
      if (!onSquare && !road && junc.some((_, k) => k % 2 === 0 && Math.hypot(junc[k] - x, junc[k + 1] - z) < CROSSING_CLEAR - 1e-6)) atCrossing++;
      if (road && junc.some((_, k) => k % 2 === 0 && Math.hypot(junc[k] - x, junc[k + 1] - z) < CROSSING_CLEAR)) atCrossing++;
    }
  }
  check(items > 200, `seed ${seed}: terrace furniture planned (${items} items)`);
  check(onFootprint === 0, `seed ${seed}: terrace furniture off building footprints (${onFootprint} on one)`);
  check(inCorridor === 0, `seed ${seed}: terrace furniture clear of the ${(WALK_CLEAR * 2).toFixed(1)} m walking corridor and carriageways (${inCorridor} in the way)`);
  check(inDoor === 0, `seed ${seed}: doorways kept clear (${inDoor} items in front of a door)`);
  check(atCrossing === 0, `seed ${seed}: crossings kept clear (${atCrossing} items within ${CROSSING_CLEAR} m of a junction)`);
  check(badParklet === 0, `seed ${seed}: parklets only in the parking strip of local streets (${badParklet} bad)`);
  check(badSeats === 0, `seed ${seed}: every seat at its table (${badSeats} off)`);
  let eat = 0, terr = 0;
  const rows: string[] = [];
  for (const [k, d] of Object.entries(by)) {
    eat += d.eat; terr += d.terr;
    if (d.shops >= 60) check(d.eat / d.shops > 0.08 && d.eat / d.shops < 0.6, `seed ${seed} ${k}: eateries a plausible share of the shop fronts (${d.eat} of ${d.shops})`);
    if (d.terr) check(d.seats / d.terr >= 4 && d.seats / d.terr <= 60, `seed ${seed} ${k}: plausible seats per terrace (${(d.seats / d.terr).toFixed(1)})`);
    rows.push(`${k} ${d.eat}/${d.shops} eat, ${d.terr} terraces (${d.square} square, ${d.parklet} parklet), ${d.seats} seats`);
  }
  check(eat > 30 && terr / eat > 0.25 && terr / eat < 0.85, `seed ${seed}: a good share of the eateries with outside seating (${terr} of ${eat})`);
  console.log(`eateries seed ${seed} (${cells.length} central cells, ${(performance.now() - t0).toFixed(0)} ms): ${rows.join('; ')}`);
}
check(PT.Tree === PropType.Tree && PT.Mailbox === PropType.Mailbox && PT.ParkedCar === PropType.ParkedCar && PT.CafeTable === PropType.CafeTable && PT.Parklet === PropType.Parklet && PT.Awning === PropType.Awning, 'terrace planner prop numbers match PropType');
{
  // Busy hours: coffee in the morning, lunch and dinner peaks, bars at night, closed at 4 am.
  const D = (k: Eatery, h: number, d: 'commercial' | 'suburban' = 'commercial') => eateryDemand(k, h, d);
  check(D(Eatery.Cafe, 8.6) > D(Eatery.Cafe, 10.8) && D(Eatery.Cafe, 13) > 0.5 && D(Eatery.Cafe, 4) === 0, 'demand: cafés busy at breakfast and lunch, closed at night');
  check(D(Eatery.Restaurant, 20) > D(Eatery.Restaurant, 16.5) && D(Eatery.Restaurant, 9) === 0, 'demand: restaurants busiest at dinner');
  check(D(Eatery.Bar, 22.5) > 0.6 && D(Eatery.Bar, 0.5) > 0 && D(Eatery.Bar, 11) === 0 && D(Eatery.Bar, 0.5, 'suburban') === 0, 'demand: bars at night, later in nightlife districts');
  let a = 0, b = 0;
  for (let t = 0; t < 24 * 7; t += 0.25) { if (tableVisit(5, 1234, Eatery.Cafe, 'oldtown', t)) a++; if (tableVisit(5, 1234, Eatery.Cafe, 'oldtown', t) && tableVisit(5, 1234, Eatery.Cafe, 'oldtown', t)!.n === tableVisit(5, 1234, Eatery.Cafe, 'oldtown', t)!.n) b++; }
  check(a > 40 && a === b && !tableVisit(5, 1234, Eatery.Cafe, 'oldtown', 24 * 3 + 3.5), `demand: tables come and go deterministically (${a} of ${24 * 7 * 4} quarter hours taken)`);
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

// Countryside settlements (world/rural): deterministic; villages joined to the city's arterial ring by
// country roads that keep off the water and the city; houses, barns and churches dry, apart, off the
// roads; garden and forest trees never on a road or a building; lakes carved below their level.
for (const [seed, size] of [[1, 0.35], [42, 0.4]] as const) {
  const t0 = performance.now();
  const p = makeProfile({ seed, size });
  const T = new Terrain(p), macro = buildMacroPlan(T);
  const land = new LandUse(T), plan = new RuralPlan(T, land, macro);
  land.settle = plan;
  const T2 = new Terrain(makeProfile({ seed, size }));
  const plan2 = new RuralPlan(T2, new LandUse(T2), buildMacroPlan(T2));
  check(hashPlan(plan.settlements) === hashPlan(plan2.settlements) && hashPlan(plan.roads) === hashPlan(plan2.roads), `rural seed ${seed}: plan deterministic`);
  const villages = plan.settlements.filter((s) => s.kind !== SettleKind.Farm);
  check(villages.length >= 10 && plan.settlements.length - villages.length >= 20, `rural seed ${seed}: villages (${villages.length}) and farms (${plan.settlements.length - villages.length})`);
  check(villages.every((v) => v.roads.length > 0), `rural seed ${seed}: every village has a road`);
  check(plan.roads.some((R) => R.trim > 0), `rural seed ${seed}: country roads leave the city`);
  let wet = 0, inCity = 0;
  for (const R of plan.roads) for (let i = 0; i < R.pts.length; i += 2) {
    if (T.isWater(R.pts[i], R.pts[i + 1], R.hw)) wet++;
    if (Math.hypot(R.pts[i] - R.pts[0], R.pts[i + 1] - R.pts[1]) > 450 && land.edge(R.pts[i], R.pts[i + 1]) < 30) inCity++;
  }
  check(wet === 0 && inCity === 0, `rural seed ${seed}: roads dry (${wet}) and out of the city (${inCity})`);
  let nb = 0, bad = 0, overlap = 0;
  for (const s of plan.settlements) {
    const L = plan.layout(s.id);
    check(hashPlan(L) === hashPlan(plan2.layout(s.id)), `rural seed ${seed} settlement ${s.id}: layout deterministic`);
    const B = L.boxes;
    for (let o = 0; o < B.length; o += BOX_STRIDE) {
      nb++;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const x = B[o] + B[o + 4] * B[o + 2] * a - B[o + 5] * B[o + 3] * b, z = B[o + 1] + B[o + 5] * B[o + 2] * a + B[o + 4] * B[o + 3] * b;
        if (T.isWater(x, z, 0) || plan.roadEdge(x, z) < 0.5) bad++;
      }
      for (let q = o + BOX_STRIDE; q < B.length; q += BOX_STRIDE) if (Math.hypot(B[q] - B[o], B[q + 1] - B[o + 1]) < Math.min(B[o + 2], B[o + 3], B[q + 2], B[q + 3])) overlap++;
    }
    check(L.buildings.length === B.length / BOX_STRIDE && L.buildings.every((b) => b.poly.length === 8 && b.floors >= 1), `rural seed ${seed} settlement ${s.id}: buildings valid`);
  }
  check(nb > 300 && bad === 0 && overlap === 0, `rural seed ${seed}: ${nb} buildings dry and off the roads (${bad}), apart (${overlap})`);
  // Trees around a town: never on its roads or buildings.
  const town = villages.find((v) => v.kind === SettleKind.Town) ?? villages[0];
  const fg = new ForestGen(land, macro);
  let onRoad = 0, trees = 0;
  for (const [dx, dz] of [[-256, -256], [0, -256], [-256, 0], [0, 0]]) {
    const R = fg.tile(Math.floor((town.x + dx) / 256) * 256, Math.floor((town.z + dz) / 256) * 256, 256);
    for (let o = 0; o < R.length; o += FOREST_STRIDE) { trees++; if (plan.roadEdge(R[o], R[o + 2]) < 1 || plan.onBuilding(R[o], R[o + 2], 1)) onRoad++; }
  }
  check(trees > 20 && onRoad === 0, `rural seed ${seed}: ${trees} trees round ${town.name}, none on a road or building (${onRoad})`);
  // Lakes: water below the level in the middle, dry land at the shore band's edge.
  for (const [k, L] of T.lakes.entries()) {
    const ok = T.waterLevel(L.x, L.z) === L.level && T.height(L.x, L.z) < L.level - 1 && T.lakeAt(L.x, L.z).lake === k;
    check(ok, `rural seed ${seed}: lake ${k} holds water`);
  }
  const tile = buildRuralTile(plan, T, Math.floor(town.x / 1024) * 1024, Math.floor(town.z / 1024) * 1024, 1024);
  check(!!tile.ground && !!tile.facade && tile.obstacles.length > 0, `rural seed ${seed}: the town's tile has roads, buildings and collision boxes`);
  console.log(`seed ${seed} rural: ${villages.length} villages, ${plan.settlements.length - villages.length} farms, ${plan.roads.length} roads, ${nb} buildings, ${T.lakes.length} lakes in ${(performance.now() - t0).toFixed(0)} ms`);
}

// ---- powers: every rank has truthful text, super speed outruns flight, old saves migrate
{
  const { ABILITIES, LEGACY_IDS } = await import('../src/game/abilities/defs');
  const T = await import('../src/game/abilities/tuning');
  for (const d of ABILITIES) for (let r = 1; r <= d.maxRank; r++) {
    const txt = d.rankText(r) + (d.costText ? d.costText(r) : '');
    check(!/NaN|undefined|Infinity/.test(txt), `${d.id} rank ${r} text: ${txt}`);
    if (!d.granted) check((T.KARMA_COST as Record<string, readonly number[]>)[d.id]?.length === d.maxRank, `${d.id}: karma cost for every rank`);
  }
  for (let r = 1; r <= T.MAX_RANK; r++) check(T.SPEED_TOP[r] > T.SPEED_TOP[r - 1] && T.SPEED_TOP[r] <= 100, `super speed rank ${r}: faster than the rank below, at most 100 m/s`);
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

// ---- departure boards: the next train they announce really pulls in then (same timetable as the trains).
{
  const { nextTrainAt, trainsOn } = await import('../src/underground/layout');
  const macro = buildMacroPlan(new Terrain(makeProfile({ seed: 42, size: 0.6 })));
  let n = 0;
  for (const line of macro.metroLines) for (let stop = 0; stop < line.stations.length; stop++) for (const dir of [1, -1]) {
    for (const t of [0, 137.5, 1234, 5000.25]) {
      const r = nextTrainAt(line, stop, dir, t);
      const at = t + (r ? r.wait : 0) + 0.05;
      const ok = !!r && trainsOn(line, at).some((tr) => tr.dwell && tr.dir === dir && tr.next === stop);
      check(ok, `board: line ${line.name} stop ${stop} dir ${dir} t ${t}: a train dwells when announced (${JSON.stringify(r)})`);
      n++;
    }
  }
  console.log(`departure boards: ${n} announcements checked`);
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
  const { Combat, COMBAT } = await import('../src/game/Combat');
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
  check(events.join(',') === 'commit,ko,subdued,arrest,resolved' && policeCalls === 1, `snatch events ${events.join(',')}, police called ${policeCalls} times`);
  check(phases.join('>') === 'approach>escape>subdued>resolved', `snatch phases ${phases.join(' > ')}`);
  // Group operations (VILLAINS_PLAN P1 part 2) with the same mocked world plus shop doors: a racket
  // leans on the shopkeeper and walks off with the cash; a tagger paints the tag and it stays, or
  // runs when the hero comes close and the tag is never finished.
  {
    const { Racket } = await import('../src/game/crime/Racket');
    const { Tagging, TAGGING } = await import('../src/game/crime/Tagging');
    const { attach } = await import('../src/sim/actors/Actor');
    const doors = [{ x: 180, z: 40, nx: 0, nz: 1 }, { x: 200, z: 40, nx: 0, nz: 1 }];
    const w2 = Object.assign(Object.create(world) as typeof world, {
      spawn: (seed: number, x: number, z: number, h: number, role: Parameters<typeof makeActor>[0]) => { const a = mk(seed, x, z, h, 2); attach(a, makeActor(role, -1)); return a; },
      shops: () => doors,
    });
    const drive = (c: import('../src/game/crime/Crime').Crime, until: () => boolean, max: number, ev: string[]) => {
      for (let i = 0; i < max && !until(); i++) {
        time += 0.05;
        for (const a of agents) {
          const act = a.actor;
          if (!a.alive || !act) continue;
          act.stateT += 0.05; act.attackT -= 0.05; act.replanT -= 0.05; act.staggerT = Math.max(0, act.staggerT - 0.05);
          if (act.memo.stagCd > 0) act.memo.stagCd -= 0.05;
          // Knocked down (not out): up again after a while (CrimeSystem.upkeep).
          if (act.state === 'down') { act.upT -= 0.05; if (act.upT <= 0) { a.state = 2; act.state = 'run'; act.stateT = 0; } continue; }
          if (act.state === 'ko' || act.state === 'surrender' || act.state === 'arrested') continue;
          const g = act.goal;
          if (g) { const dx = g.x - a.x, dz = g.z - a.z, d = Math.hypot(dx, dz); const s = Math.min(d, act.speed * 0.05); if (d > 1e-6) { a.x += (dx / d) * s; a.z += (dz / d) * s; } }
        }
        c.update(0.05);
        for (const e of c.events) ev.push(e.type);
        c.events.length = 0;
      }
    };
    player.x = 0; player.z = 0;
    const racket = new Racket(w2, 777);
    check(racket.setup() && racket.kind === 'racket' && racket.victim?.actor?.role === 'shopkeeper' && racket.loot?.kind === 'envelope', `racket: a shopkeeper at the door is the victim, the loot an envelope of cash (${racket.victim?.actor?.role}, ${racket.loot?.kind})`);
    check(racket.criminals.length >= 1 && racket.criminals.length <= 2, `racket: one or two collectors (${racket.criminals.length})`);
    const rEv: string[] = [];
    drive(racket, () => racket.phase === 'escape' || racket.phase === 'aborted', 2400, rEv);
    check(racket.phase === 'escape' && racket.loot?.carrier === racket.criminals[0] && racket.criminals[0].actor?.held === 'envelope', `racket: they take the envelope and walk off (${racket.phase}, events ${rEv.join(',')})`);
    check(racket.victim!.actor?.state !== 'cower' && racket.victim!.state !== 5, `racket: the shopkeeper pays up, not cowering or shoved down (${racket.victim!.actor?.state})`);

    const tag = new Tagging(w2, 4242);
    check(tag.setup() && !!tag.spot && tag.kind === 'tagging', 'tagging: setup finds a wall beside a door and a tagger');
    const tEv: string[] = [];
    drive(tag, () => tag.phase !== 'approach', 2400, tEv);
    check(tag.phase === 'commit', `tagging: the tagger reaches the wall and starts painting (${tag.phase})`);
    drive(tag, () => tag.done, Math.ceil((TAGGING.paintFor + 1) / 0.05), tEv);
    check(tag.done && tag.phase === 'escape' && tEv.includes('tagged') && tag.progress >= TAGGING.paintFor, `tagging: left alone the tag is finished (${tEv.join(',')})`);

    const tag2 = new Tagging(w2, 99);
    check(tag2.setup(), 'tagging: a second tagger');
    const t2Ev: string[] = [];
    drive(tag2, () => tag2.phase !== 'approach', 2400, t2Ev);
    drive(tag2, () => tag2.progress > 3, 200, t2Ev);
    player.x = tag2.tagger!.x + 3; player.z = tag2.tagger!.z + 3;
    drive(tag2, () => false, Math.ceil(TAGGING.paintFor / 0.05), t2Ev);
    check(!tag2.done && !t2Ev.includes('tagged') && tag2.playerInvolved && tag2.phase !== 'commit', `tagging: the hero comes close, the tag is abandoned (${tag2.phase}, ${t2Ev.join(',')})`);
    player.x = 0; player.z = 0;

    // Phase 2: a turf brawl between two groups fights itself out (one side beaten, a winner) with
    // nobody about; with the hero close it is broken up (no winner). Hideout guards square up.
    const { TurfBrawl } = await import('../src/game/crime/TurfBrawl');
    const { HideoutGuard } = await import('../src/game/crime/HideoutGuard');
    const w3 = Object.assign(Object.create(w2) as typeof w2, { walls: () => doors.map((d) => ({ ...d, bay: 2.2 })) });
    const brawl = new TurfBrawl(w3, 31337);
    brawl.faction = 0; brawl.rival = 1;
    check(brawl.setup() && brawl.standing(0).length >= 2 && brawl.standing(1).length >= 2, `brawl: two sides of 2–3 (${brawl.standing(0).length} vs ${brawl.standing(1).length})`);
    const bEv: string[] = [];
    drive(brawl, () => brawl.phase !== 'approach', 2400, bEv);
    check(brawl.phase === 'commit', `brawl: the two sides meet and fight (${brawl.phase})`);
    drive(brawl, () => brawl.winner >= 0 || !brawl.active, 4000, bEv);
    const beaten = brawl.standing(0).length === 0 ? 0 : 1;
    check(brawl.winner === (beaten === 0 ? 1 : 0) && bEv.includes('won') && !brawl.playerInvolved, `brawl: left alone, one side is beaten and the other wins (winner ${brawl.winner}, standing ${brawl.standing(0).length}/${brawl.standing(1).length}, ${bEv.join(',')})`);
    check(brawl.criminals.some((c) => c.actor?.state === 'ko' && !c.actor.koByPlayer), 'brawl: they knock each other out');
    const brawl2 = new TurfBrawl(w3, 4711);
    brawl2.faction = 0; brawl2.rival = 1;
    check(brawl2.setup(), 'brawl: a second one');
    const b2Ev: string[] = [];
    drive(brawl2, () => brawl2.phase !== 'approach', 2400, b2Ev);
    const m = brawl2.meet!;
    player.x = m.x + 4; player.z = m.z + 4;
    drive(brawl2, () => false, 60, b2Ev);
    check(brawl2.playerInvolved && brawl2.winner < 0 && brawl2.phase !== 'commit' && b2Ev.includes('subdued'), `brawl: the hero comes close and breaks it up, stopped at once (${brawl2.phase}, ${b2Ev.join(',')})`);
    player.x = 0; player.z = 0;

    const guards = new HideoutGuard(w3, 2024, { x: 300, z: 60, nx: 0, nz: 1 });
    check(guards.setup() && guards.criminals.length >= 2 && guards.guarding === guards.criminals.length, `hideout: ${guards.criminals.length} guards at the door`);
    const gEv: string[] = [];
    drive(guards, () => false, 100, gEv);
    check(guards.phase === 'approach' && !gEv.includes('commit'), 'hideout: the guards keep watch while nobody comes');
    player.x = 300; player.z = 72;
    drive(guards, () => guards.phase !== 'approach', 40, gEv);
    check(guards.phase === 'commit' && guards.criminals.every((c) => c.actor!.hostile), `hideout: the hero walks up and they square up (${guards.phase})`);
    for (let k = 0; k < 40 && guards.phase !== 'subdued' && guards.active; k++) {
      for (const c of guards.criminals) if (c.actor && c.actor.state !== 'ko' && c.actor.state !== 'surrender') combat.hitActor(c, 0, 60, -500, 'punch', 'player', player.x, player.z);
      drive(guards, () => false, 10, gEv);
    }
    check(guards.phase === 'subdued' && gEv.filter((e) => e === 'subdued').length === 1 && guards.guarding === 0, `hideout: guards beaten, 'subdued' once (${guards.phase}, ${gEv.join(',')})`);
    player.x = 0; player.z = 0;

    // Phase 3: the caster core (powers/Caster) on its own, then a lieutenant among hideout guards:
    // it picks a power that fits, winds up (the tell) with the aim fixed, then releases it; a
    // shoulder charge lands on a hero who stands still; a step aside in the tell leaves the aim behind.
    const { Caster, VILLAIN_POWERS, CASTERS, segDist } = await import('../src/game/powers/Caster');
    const { Rng } = await import('../src/core/rng');
    {
      const K = new Caster(['bolt', 'shield', 'smoke'], new Rng(5));
      const ctx = { dist: 10, hp: 1, fleeing: false, targetDown: false, clear: true };
      check(K.choose(ctx) === null, 'caster: nothing before its first delay (they square up first)');
      K.tick(5);
      check(K.choose(ctx) === 'bolt', 'caster: a bolt in range with a clear line');
      check(K.choose({ ...ctx, clear: false }) === null && K.choose({ ...ctx, dist: 40 }) === null && K.choose({ ...ctx, targetDown: true }) === null, 'caster: no bolt without a clear line, out of range or at a hero who is down');
      check(K.choose({ ...ctx, hp: 0.5, clear: false }) === 'shield', 'caster: hurt, it shields');
      check(K.choose({ ...ctx, fleeing: true }) === 'smoke', 'caster: on the run only smoke');
      K.begin('bolt', 1, 1, 1);
      let t = 0, ev: string | null = null;
      while (!(ev = K.step(0.05)) && t < 5) t += 0.05;
      check(ev === 'release' && Math.abs(t + 0.05 - VILLAIN_POWERS.bolt.windup) < 0.06 && !K.busy && K.choose(ctx) !== 'bolt', `caster: the bolt goes off after its wind-up (${(t + 0.05).toFixed(2)} s), then cools down`);
      K.begin('shield', 0, 0, 0);
      const evs: string[] = [];
      for (let i = 0; i < 200 && K.busy; i++) { const e = K.step(0.05); if (e) evs.push(e); }
      check(evs.join(',') === 'release,end', `caster: a shield holds after its release, then ends (${evs.join(',')})`);
      check(Math.abs(segDist(5, 1, 0, 0, 10, 0) - 1) < 1e-9 && Math.abs(segDist(-3, 4, 0, 0, 10, 0) - 5) < 1e-9, 'caster: distance to a beam');
      check(Object.values(VILLAIN_POWERS).every((P) => P.windup >= 0.3 && P.cooldown >= 5 && P.dmg < 22), 'caster: every power has a tell, a cooldown and no one-hit knock-down');
    }
    {
      const stages: string[] = [], hurt: { kind: string; dmg: number }[] = [], aims: { stage: string; x: number; z: number }[] = [];
      const w5 = Object.assign(Object.create(w3) as typeof w3, {
        cast: (_c: unknown, p: string, st: string, x: number, _y: number, z: number) => {
          const key = `${p}:${st}`;
          if (stages[stages.length - 1] !== key) stages.push(key);
          if (st === 'begin' || st === 'release') aims.push({ stage: st, x, z });
          return true;
        },
        hurtPlayer: (dmg: number, kind: string) => { hurt.push({ kind, dmg }); },
      });
      const lg = new HideoutGuard(w5, 777, { x: 400, z: 60, nx: 0, nz: 1 });
      check(lg.setup(), 'lieutenant: guards at a door');
      const brute = lg.criminals[0];
      const hp0 = brute.actor!.maxHp;
      lg.promote(brute, ['dash']);
      check(brute.actor!.maxHp > hp0 && brute.actor!.memo.lt === 1 && lg.casters.has(brute), 'lieutenant: promoted (tougher, with powers)');
      player.x = 400; player.z = 71;
      const lEv: string[] = [];
      drive(lg, () => stages.includes('dash:end'), 400, lEv);
      const iB = stages.indexOf('dash:begin'), iT = stages.indexOf('dash:tell'), iR = stages.indexOf('dash:release');
      check(lEv.includes('cast') && iB >= 0 && iT > iB && iR > iT, `lieutenant: begin, the tell, then the release (${stages.slice(0, 6).join(' ')})`);
      check(hurt.some((h) => h.kind === 'punch' && h.dmg >= 15), `lieutenant: the shoulder charge lands on a hero who stands still (${hurt.map((h) => Math.round(h.dmg)).join(',')})`);
      // A frost caster: the hero steps aside during the tell; the ray goes where they stood.
      const fg = new HideoutGuard(w5, 991, { x: 600, z: 60, nx: 0, nz: 1 });
      check(fg.setup(), 'lieutenant: a second door');
      fg.promote(fg.criminals[0], ['frost']);
      for (const c of fg.criminals.slice(1)) c.alive = false;
      player.x = 600; player.z = 72;
      aims.length = 0; stages.length = 0;
      drive(fg, () => aims.some((a) => a.stage === 'begin'), 400, []);
      const b = aims.find((a) => a.stage === 'begin');
      player.x += 3;
      drive(fg, () => aims.some((a) => a.stage === 'release'), 60, []);
      const r = aims.find((a) => a.stage === 'release');
      check(!!b && !!r && b.x === r.x && b.z === r.z && Math.abs(r.x - player.x) > 2.5, `lieutenant: the aim is fixed in the wind-up, a step aside dodges (${b ? b.x.toFixed(1) : '-'} → ${r ? r.x.toFixed(1) : '-'}, hero at ${player.x.toFixed(1)})`);
      // A shield: blows barely get through and do not floor them.
      const sa = fg.criminals[0];
      sa.actor!.memo.shieldT = 2;
      const hpS = sa.actor!.hp;
      const res = combat.hitActor(sa, 0, 60, -900, 'punch', 'player', sa.x, sa.z + 1);
      check(res.effect !== 'knockdown' && res.effect !== 'ko' && hpS - sa.actor!.hp < 900 * COMBAT.dmgPerNs * CASTERS.shieldTakes * 1.2, `lieutenant: a shield takes most of a blow (${(hpS - sa.actor!.hp).toFixed(1)} hp, ${res.effect})`);
      player.x = 0; player.z = 0;
      // City-wide: at most CASTERS.maxCasting casts at once.
      const { VillainCasts } = await import('../src/game/crime/VillainCasts');
      const vc = new VillainCasts({} as never);
      const cs = [0, 1, 2, 3, 4].map((k) => mk(900 + k, 5000 + k * 3, 5000, 0, 2));
      const ok = cs.slice(0, CASTERS.maxCasting).every((a) => vc.cast(a, 'bolt', 'begin', 0, 0, 0));
      check(ok && !vc.cast(cs[CASTERS.maxCasting], 'bolt', 'begin', 0, 0, 0), `caster budget: ${CASTERS.maxCasting} at once`);
      vc.cast(cs[0], 'bolt', 'end', 0, 0, 0);
      check(vc.cast(cs[CASTERS.maxCasting], 'bolt', 'begin', 0, 0, 0), 'caster budget: a slot frees when a cast ends');
      // A boss: tougher than a lieutenant, fights on longer; a hunting group's members stand and fight.
      const bg = new HideoutGuard(w5, 4040, { x: 800, z: 60, nx: 0, nz: 1 });
      check(bg.setup() && bg.criminals.length >= 2, 'boss: guards at a door');
      const [bossA, other] = bg.criminals;
      const hp1 = bossA.actor!.maxHp;
      bg.promote(bossA, ['dash', 'quake', 'gust'], { hp: 1.7, strength: 1.2 });
      check(bossA.actor!.memo.boss === 1 && bossA.actor!.maxHp >= Math.round(hp1 * 1.8 * 1.7) - 1, `boss: promoted, tougher than a lieutenant (${hp1} → ${bossA.actor!.maxHp})`);
      bossA.actor!.hp = bossA.actor!.maxHp * 0.25;
      check((bg as unknown as { decide(c: unknown): string }).decide(bossA) === 'fight', 'boss: still fights at a quarter of its health');
      other.actor!.memo.grudge = 1; other.actor!.memo.lt = 0; other.actor!.armed = 'none';
      check((bg as unknown as { decide(c: unknown): string }).decide(other) === 'fight', 'notoriety: a member of a hunting group stands and fights');
      // The hero floored: a boss stands over them (no running off at full health); a plain member runs.
      const pd = player as typeof player & { down?: boolean };
      pd.down = true;
      const bgF = bg as unknown as { fight(c: unknown, dt: number): void };
      bgF.fight(bossA, 0.05);
      const plain = bg.criminals[2] ?? other;
      if (plain !== other) { plain.actor!.memo.lt = 0; plain.actor!.memo.grudge = 0; bgF.fight(plain, 0.05); }
      check(bossA.actor!.state === 'fight' && (plain === other || plain.actor!.state === 'run'), `boss: stands over a floored hero instead of running (${bossA.actor!.state}${plain !== other ? `, a member: ${plain.actor!.state}` : ''})`);
      pd.down = false;
      for (const a of bg.criminals) a.alive = false;
      for (const a of cs) a.alive = false;
    }

    // Phase 3 part 2: channelled operations. A techno-cult hack at a robot and an elemental cult's
    // ritual before a landmark: left alone the work finishes and the world's effect fires once; with
    // the hero close it is broken off and never finished.
    {
      const { Hijack, HIJACK } = await import('../src/game/crime/Hijack');
      const { Ritual, RITUAL } = await import('../src/game/crime/Ritual');
      const fired: string[] = [], looks = new Set<string>();
      const w6 = Object.assign(Object.create(w3) as typeof w3, {
        machines: () => [{ x: 700, z: 40, nx: 0, nz: 1 }],
        landmarks: () => [{ x: 760, z: 90, nx: 0, nz: -1 }],
        opFx: (look: string) => { looks.add(look); },
        hijack: (_c: unknown, _x: number, _z: number, n: number) => { fired.push(`hijack:${n}`); },
        ritual: (_c: unknown, _x: number, _z: number, el: string) => { fired.push(`ritual:${el}`); },
      });
      const hk = new Hijack(w6, 5150);
      check(hk.setup() && hk.kind === 'hijack' && hk.criminals.some((c) => c.actor!.memo.work) && hk.criminals.some((c) => !c.actor!.memo.work), `hijack: hackers at the robot and a guard (${hk.criminals.length})`);
      const hEv: string[] = [];
      drive(hk, () => hk.phase !== 'approach', 2400, hEv);
      check(hk.phase === 'commit', `hijack: they reach the robot and start the hack (${hk.phase})`);
      drive(hk, () => hk.done, Math.ceil((HIJACK.hackFor + 2) / 0.05), hEv);
      const nM = Number(fired.find((f) => f.startsWith('hijack'))?.split(':')[1] ?? 0);
      check(hk.done && hEv.filter((e) => e === 'done').length === 1 && nM >= HIJACK.machines[0] && looks.has('hack') && hk.phase === 'escape', `hijack: left alone the hack goes through, the machines turn once (${fired.join(',')}, ${hEv.join(',')})`);
      const hk2 = new Hijack(w6, 6160);
      check(hk2.setup(), 'hijack: a second one');
      drive(hk2, () => hk2.phase !== 'approach', 2400, []);
      drive(hk2, () => hk2.progress > 3, 200, []);
      const h2Ev: string[] = [];
      player.x = hk2.site!.x + 4; player.z = hk2.site!.z + 4;
      drive(hk2, () => false, Math.ceil(HIJACK.hackFor / 0.05), h2Ev);
      check(!hk2.done && !h2Ev.includes('done') && hk2.playerInvolved && hk2.phase !== 'commit', `hijack: the hero comes close, the hack is broken off (${hk2.phase}, ${h2Ev.join(',')})`);
      player.x = 0; player.z = 0;
      for (const c of [...hk.criminals, ...hk2.criminals]) c.alive = false;

      fired.length = 0;
      const rt = new Ritual(w6, 7170);
      rt.element = 'frost';
      check(rt.setup() && rt.kind === 'ritual' && rt.criminals.filter((c) => c.actor!.memo.work).length >= 3, `ritual: a circle of ${rt.criminals.filter((c) => c.actor!.memo.work).length} before the landmark`);
      const rc = rt.criminals.filter((c) => c.actor!.memo.work).map((c) => Math.hypot(c.actor!.memo.postX - rt.site!.x, c.actor!.memo.postZ - rt.site!.z));
      check(rc.every((d) => Math.abs(d - RITUAL.radius) < 0.01), 'ritual: they stand on the circle');
      const rEv2: string[] = [];
      drive(rt, () => rt.phase !== 'approach', 2400, rEv2);
      check(rt.phase === 'commit', `ritual: the circle forms and the chant begins (${rt.phase})`);
      drive(rt, () => rt.progress > RITUAL.chantFor * 0.5, Math.ceil(RITUAL.chantFor / 0.05), rEv2);
      check(!rt.done && fired.length === 0 && rt.share > 0.45, `ritual: half way, nothing yet (${rt.share.toFixed(2)})`);
      drive(rt, () => rt.done, Math.ceil(RITUAL.chantFor / 0.05), rEv2);
      check(rt.done && fired.join() === 'ritual:frost' && looks.has('frost') && rEv2.filter((e) => e === 'done').length === 1, `ritual: left alone it is completed, its element bursts once (${fired.join(',')}, ${rEv2.join(',')})`);
      const rt2 = new Ritual(w6, 8180);
      check(rt2.setup(), 'ritual: a second one');
      drive(rt2, () => rt2.phase !== 'approach', 2400, []);
      drive(rt2, () => rt2.progress > 5, 400, []);
      const r2Ev: string[] = [];
      player.x = rt2.site!.x + 5; player.z = rt2.site!.z + 5;
      drive(rt2, () => false, Math.ceil(RITUAL.chantFor / 0.05), r2Ev);
      check(!rt2.done && fired.length === 1 && rt2.playerInvolved && rt2.phase !== 'commit', `ritual: the hero breaks the circle, it is never completed (${rt2.phase}, ${r2Ev.join(',')})`);
      player.x = 0; player.z = 0;
      for (const c of [...rt.criminals, ...rt2.criminals]) c.alive = false;
      // Struck on the way there: it is off, the blow counts (a knockout is a knockout).
      const rt3 = new Ritual(w6, 9190);
      check(rt3.setup(), 'ritual: a third one');
      drive(rt3, () => false, 3, []);
      const amb = rt3.criminals[0];
      amb.actor!.hp = 1;
      combat.hitActor(amb, 0, 60, -900, 'punch', 'player', amb.x, amb.z + 1);
      const r3Ev: string[] = [];
      drive(rt3, () => false, 40, r3Ev);
      check(rt3.phase !== 'approach' && rt3.playerInvolved && amb.actor!.state === 'ko' && r3Ev.includes('ko'), `crime: a criminal knocked out on the way to the site counts, the crime is off (${rt3.phase}, ${amb.actor!.state}, ${r3Ev.join(',')})`);
      for (const c of rt3.criminals) c.alive = false;
      const nohk = new Hijack(Object.assign(Object.create(w6) as typeof w6, { machines: () => [], shops: () => [] }), 1);
      check(!nohk.setup(), 'hijack: no robot and no shop near, no hack');
      // The EMP: a Technomancer's pulse at a hero in range.
      const KE = new Caster(['emp'], new Rng(9));
      KE.tick(5);
      check(KE.choose({ dist: 10, hp: 1, fleeing: false, targetDown: false, clear: false }) === 'emp' && KE.choose({ dist: 2, hp: 1, fleeing: false, targetDown: false, clear: true }) === null, 'caster: an EMP in range (no clear line needed), not point-blank');
    }

    // The mad bomber: walks to the busy spot and starts lobbing bombs; once the hero is close the
    // bombs go at them; a few punches knock him out and the police take him.
    const { Bomber, BOMBER } = await import('../src/game/crime/Bomber');
    for (let k = 0; k < 6; k++) mk(500 + k, 300 + k * 2.5, 60 + (k % 2) * 3, Math.PI / 2, 0);
    const thrownAt: { x: number; z: number }[] = [];
    const w4 = Object.assign(Object.create(w2) as typeof w2, { bomb: (_c: unknown, x: number, z: number) => { thrownAt.push({ x, z }); return true; } });
    const bomber = new Bomber(w4, 31337, { x: 305, z: 62 });
    check(bomber.setup() && bomber.bomber?.actor?.held === 'bomb' && bomber.bombsLeft >= BOMBER.bombs[0] && bomber.kind === 'bomber', `bomber: setup finds a busy spot and a bomber with a bag of bombs (${bomber.bombsLeft})`);
    const bombEv: string[] = [];
    drive(bomber, () => bomber.phase !== 'approach', 2400, bombEv);
    check(bomber.phase === 'commit' && bombEv.includes('commit'), `bomber: he reaches the spot and starts (${bomber.phase}, ${bombEv.join(',')})`);
    drive(bomber, () => thrownAt.length >= 3, 800, bombEv);
    const bb = bomber.bomber!;
    check(thrownAt.length >= 3 && bomber.thrown === thrownAt.length, `bomber: bombs fly (${thrownAt.length} thrown)`);
    player.x = bb.x + 15; player.z = bb.z;
    const n0 = thrownAt.length;
    drive(bomber, () => thrownAt.length > n0, 800, bombEv);
    const last = thrownAt[thrownAt.length - 1];
    check(thrownAt.length > n0 && Math.hypot(last.x - player.x, last.z - player.z) <= BOMBER.scatter[1] + 0.1, `bomber: once the hero is close the next bomb goes at them (${last ? Math.hypot(last.x - player.x, last.z - player.z).toFixed(1) : '-'} m off)`);
    let punches = 0;
    for (let i = 0; i < 400 && bb.actor!.state !== 'ko' && bb.actor!.state !== 'surrender'; i++) {
      player.x = bb.x + 0.9; player.z = bb.z;
      if (i % 12 === 0) { combat.hitActor(bb, -420, 80, 0, 'punch', 'player'); punches++; }
      drive(bomber, () => false, 1, bombEv);
    }
    check(bb.actor!.state === 'ko' || bb.actor!.state === 'surrender', `bomber: a few punches stop him (${punches} punches, ${bb.actor!.state})`);
    drive(bomber, () => false, 2, bombEv);
    bomber.arrest(bb);
    drive(bomber, () => false, 2, bombEv);
    check(bomber.phase === 'resolved' && bomber.outcome === 'arrested', `bomber: arrested, resolved (${bomber.phase}, ${bombEv.join(',')})`);
    player.x = 0; player.z = 0;
  }
  console.log(`crime: index ${macro.cells.length} cells, ${all.length} rolls/day (chaos), snatch FSM ${phases.join(' > ')} in ${(performance.now() - t0).toFixed(0)} ms`);
}

// ---- villain groups (VILLAINS_PLAN Phase 1): every city gets its street gang and Syndicate with a
// seeded name and turf in their districts; the same seed gives the same groups; in a group's turf
// the director rolls its operations (the Syndicate robs, the gang mugs); members wear its colours.
{
  const { crimeIndex } = await import('../src/game/crime/CrimeIndex');
  const { planHour } = await import('../src/game/crime/CrimeDirector');
  const { planFactions, HOLD, shift, SHIFT, saveFactions, restoreFactions, drift, relation, rivalsAt, strength, DRIFT } = await import('../src/game/factions/Factions');
  const { planHideouts, hideoutCell, pickDoor, saveHideouts, restoreHideouts } = await import('../src/game/factions/Hideouts');
  const { planBosses, bossLabel, raise, heatOf, fade, ltChance, bossChance, jail, saveBosses, restoreBosses, NOTORIETY, BOSS } = await import('../src/game/factions/Bosses');
  const { ARCHETYPES, CITY_GROUPS } = await import('../src/game/factions/archetypes');
  const { factionOutfit } = await import('../src/game/factions/outfits');
  const t0 = performance.now();
  const names = new Set<string>();
  for (const [seed, size] of [[42, 0.3], [7, 0.3], [3, 0.6]] as const) {
    const macro = buildMacroPlan(new Terrain(makeProfile({ seed, size })));
    const idx = crimeIndex(macro, seed);
    const F = planFactions(macro, seed, idx), G = planFactions(macro, seed, idx);
    check(JSON.stringify(F.factions) === JSON.stringify(G.factions) && F.holder.every((h, i) => h === G.holder[i]), `factions deterministic (seed ${seed})`);
    check(F.factions.map((f) => f.archetype).join() === 'gang,syndicate', `seed ${seed}: a street gang and a Syndicate (${F.factions.map((f) => f.name).join(', ')})`);
    const all4 = planFactions(macro, seed, idx, CITY_GROUPS);
    check(all4.factions.length >= 3 && all4.factions.slice(0, 2).map((f) => f.archetype).join() === 'gang,syndicate' && all4.factions.some((f) => f.archetype === 'techno' || f.archetype === 'cult'), `seed ${seed}: the city's groups include the cults (${all4.factions.map((f) => `${f.archetype}:${all4.holder.filter((h) => h === f.id).length}`).join(', ')})`);
    for (const f of all4.factions.filter((x) => x.archetype === 'techno' || x.archetype === 'cult')) {
      const o = factionOutfit(f, 5);
      check(f.archetype === 'techno' ? o.feet?.defId === 'boots' : o.back?.defId === 'coat', `${f.name}: dressed as ${f.archetype === 'techno' ? 'techno-cultists (work clothes, boots)' : 'cultists (long coats)'}`);
      check(all4.holder.every((h, i) => h !== f.id || ARCHETYPES[f.archetype].affinity[macro.cells[i].district] > 0), `${f.name}: turf only in its kind of district`);
    }
    const land = macro.cells.filter((c) => c.district !== 'water').length;
    for (const f of F.factions) {
      names.add(f.name);
      const held = macro.cells.filter((_, i) => F.holder[i] === f.id);
      check(F.holder[f.home] === f.id, `${f.name} holds its home cell`);
      check(held.every((c) => ARCHETYPES[f.archetype].affinity[c.district] > 0), `${f.name}: turf only in its kind of district`);
      check(held.length >= 2 && held.length <= land * 0.4, `${f.name}: turf ${held.length} of ${land} cells`);
      check(F.influence[f.id].every((v) => v >= 0 && v <= 1), `${f.name}: influence in 0..1`);
    }
    check(F.holder.every((h, i) => h < 0 || F.influence[h][i] >= HOLD), `seed ${seed}: every holder reaches the hold threshold`);
    const syn = F.factions.find((f) => f.archetype === 'syndicate')!, gang = F.factions.find((f) => f.archetype === 'gang')!;
    check(['downtown', 'commercial', 'oldtown'].includes(macro.cells[syn.home].district), `the Syndicate sits in the centre (${macro.cells[syn.home].district})`);
    const robs = (ops: Record<import('../src/game/crime/Crime').CrimeKind, number> | null) => Array.from({ length: 24 }, (_, h) => planHour(seed, 2, h, syn.home, 0.6, 'commercial', 'chaos', 45, ops)).flat().filter((r) => r.kind === 'robbery').length;
    check(robs(ARCHETYPES.syndicate.kinds) > robs(null) && robs(null) >= robs(ARCHETYPES.gang.kinds), `operations: the Syndicate robs more (${robs(ARCHETYPES.syndicate.kinds)} vs ${robs(null)} vs gang ${robs(ARCHETYPES.gang.kinds)} a day)`);
    const suit = factionOutfit(syn, 99), hood = factionOutfit(gang, 99);
    check(suit.back?.defId === 'suitjacket' && JSON.stringify(suit) === JSON.stringify(factionOutfit(syn, 99)), 'Syndicate members wear suits (deterministic)');
    check(!!hood.head && JSON.stringify(hood.head.visual.primary) === JSON.stringify(gang.palette.accent), 'gang members wear a cap in their colour');
    // Part 2: group operations only in a group's turf; the gang rackets and tags, the Syndicate doesn't.
    const day = (ops: Record<import('../src/game/crime/Crime').CrimeKind, number> | null, cell: number) => Array.from({ length: 24 }, (_, h) => planHour(seed, 3, h, cell, 0.7, 'apartments', 'chaos', 45, ops)).flat();
    const anon = day(null, 1).concat(day(null, 2));
    check(!anon.some((r) => r.kind === 'racket' || r.kind === 'tagging'), `nobody's turf: no rackets or tags (${anon.length} rolls)`);
    const gangDay = day(ARCHETYPES.gang.kinds, gang.home), synDay = day(ARCHETYPES.syndicate.kinds, syn.home);
    check(gangDay.some((r) => r.kind === 'racket') && gangDay.some((r) => r.kind === 'tagging'), `gang turf: rackets and tags (${gangDay.map((r) => r.kind).join(',')})`);
    check(!synDay.some((r) => r.kind === 'racket' || r.kind === 'tagging'), 'Syndicate turf: no rackets or tags');
    // Turf shifts: stopping the gang at home again and again loosens its grip (the cell and next door), then a save brings it back.
    const before = saveFactions(F);
    check(before.groups.every((g) => g.cells.length === 0), 'untouched turf saves nothing');
    const flips: { cell: number; from: number; to: number }[] = [];
    for (let k = 0; k < 12 && F.holder[gang.home] === gang.id; k++) flips.push(...shift(F, gang.home, gang.id, SHIFT.stopped));
    check(F.holder[gang.home] !== gang.id && flips.some((x) => x.cell === gang.home && x.from === gang.id), `stopping the gang loses it its home block (${flips.length} flips)`);
    check(F.near[gang.home].some((n) => F.influence[gang.id][n] < F.base[gang.id][n]), 'and loosens its grip next door');
    const saved = JSON.parse(JSON.stringify(saveFactions(F, { stopped: 12 })));
    const H = planFactions(macro, seed, idx);
    const st = restoreFactions(H, saved);
    check(st.stopped === 12 && H.holder.every((h, i) => h === F.holder[i]) && H.influence.every((I, f) => I.every((v, i) => Math.abs(v - F.influence[f][i]) < 0.006)), 'turf and stats survive a save');
    restoreFactions(H, null);
    check(H.holder.every((h, i) => h === G.holder[i]), 'no saved turf: the seeded one');
    // Drift's hysteresis lets a holder keep a cell a little below HOLD: a save keeps it held.
    const K = planFactions(macro, seed, idx);
    K.influence[gang.id][gang.home] = HOLD - DRIFT.hysteresis * 0.6;
    const kept = planFactions(macro, seed, idx);
    restoreFactions(kept, JSON.parse(JSON.stringify(saveFactions(K))));
    check(K.holder[gang.home] === gang.id && kept.holder[gang.home] === gang.id, `a block held just below HOLD stays held through a save (${kept.holder[gang.home]})`);

    const grow = shift(G, gang.home, gang.id, SHIFT.tag);
    check(grow.length === 0 && G.influence[gang.id][gang.home] <= SHIFT.max, 'a tag at home strengthens the hold without flipping it');
    // Phase 2: the gang and the Syndicate are at war; turf brawls only where they meet.
    check(relation(F, gang.id, syn.id) === 'hostile' && relation(F, syn.id, gang.id) === 'hostile' && relation(F, gang.id, gang.id) === 'self', 'the gang and the Syndicate are rivals');
    const border = F.holder.findIndex((h, i) => h === gang.id && F.near[i].some((j) => F.holder[j] === syn.id));
    const deep = F.holder.findIndex((h, i) => h === gang.id && [i, ...F.near[i]].every((j) => F.holder[j] !== syn.id && F.influence[syn.id][j] < 0.12));
    if (border >= 0) check(rivalsAt(F, border, gang.id)[0] === syn.id, `a border cell: the Syndicate presses there (cell ${border})`);
    if (deep >= 0) check(rivalsAt(F, deep, gang.id).length === 0, `deep in gang turf: no rivals about (cell ${deep})`);
    // Off-screen drift: deterministic, borders don't flicker, the map stays near its seeded shape.
    const D1 = planFactions(macro, seed, idx), D2 = planFactions(macro, seed, idx);
    let drifts = 0;
    for (let h = 0; h < 240; h++) { drifts += drift(D1, seed, 5000 + h).length; drift(D2, seed, 5000 + h); }
    check(D1.holder.every((h, i) => h === D2.holder[i]) && D1.influence.every((I, f) => I.every((v, i) => v === D2.influence[f][i])), `drift deterministic for seed and hour (seed ${seed})`);
    check(D1.influence.every((I) => I.every((v) => v >= 0 && v <= SHIFT.max)), 'drift keeps influence in range');
    check(drifts <= macro.cells.length * 0.5, `drift: no flickering borders (${drifts} changes of hand in 240 h over ${macro.cells.length} cells)`);
    for (const f of D1.factions) {
      const n0 = F.baseHeld[f.id], n1 = D1.holder.filter((h) => h === f.id).length;
      check(n1 >= n0 * 0.6 && n1 <= Math.max(n0 + 3, n0 * 1.6), `drift: ${f.name} keeps about its turf over 10 days (${n0} → ${n1} cells)`);
    }
    // A group the player has driven out of its streets: holds less for a while, then comes back home.
    const W = planFactions(macro, seed, idx);
    for (let k = 0; k < 600 && W.holder.some((h) => h === gang.id); k++) shift(W, W.holder.indexOf(gang.id), gang.id, SHIFT.stopped);
    check(strength(W, gang.id) === 0, 'the gang driven out of every block');
    for (let h = 0; h < 12; h++) drift(W, seed, 6000 + h);
    const after12 = W.holder.filter((h) => h === gang.id).length;
    for (let h = 12; h < 120; h++) drift(W, seed, 6000 + h);
    check(after12 < F.baseHeld[gang.id] && W.holder[gang.home] === gang.id, `a beaten gang lies low (${after12} blocks after 12 h), then is back home (${W.holder.filter((h) => h === gang.id).length} after 5 days)`);
    check(DRIFT.maxCatchUp >= 1, 'drift catches up a bounded number of hours');
    // Hideouts: in the home cell while it holds it; the door is picked by seed and move count; saved.
    const HO = planHideouts(F);
    check(HO.length === 2 && HO.every((h, i) => h.cell === F.factions[i].home && !h.found && !h.door), 'hideouts: one per group, in its home, not found yet');
    check(hideoutCell(G, gang.id) === gang.home && hideoutCell(F, gang.id) !== gang.home, 'hideout cell: home while held, else its strongest block');
    const doorsAt = Array.from({ length: 12 }, (_, k) => ({ x: 100 + k * 9.5, z: -40 + (k % 3) * 7, nx: 0, nz: 1 }));
    const d0 = pickDoor(doorsAt, seed, gang.id, 0, 150, -30, 300), d0b = pickDoor(doorsAt, seed, gang.id, 0, 150, -30, 300);
    const moved = [1, 2, 3, 4].map((m) => pickDoor(doorsAt, seed, gang.id, m, 150, -30, 300));
    check(d0 === d0b && moved.some((d) => d !== d0), 'hideout door: the same for seed and move count, another after a move');
    HO[gang.id].door = d0; HO[gang.id].found = true; HO[gang.id].bustedUntil = 77.5; HO[gang.id].moves = 1;
    const back = restoreHideouts(F, JSON.parse(JSON.stringify(saveHideouts(F, HO))));
    check(JSON.stringify(back) === JSON.stringify(HO), 'hideouts survive a save');
    check(JSON.stringify(restoreHideouts(F, [{ archetype: 'nobody' }, null, 5])) === JSON.stringify(planHideouts(F)), 'hideouts: junk in a save is ignored');
    // Phase 4: a named boss per group (the same city, the same bosses), notoriety that turns a group
    // wary then hunting and fades, jail time that grows, records in saves.
    const BS = planBosses(F, seed), BS2 = planBosses(F, seed);
    check(BS.length === F.factions.length && JSON.stringify(BS) === JSON.stringify(BS2) && BS.every((b) => /^\S+ \S+$/.test(b.name) && b.jailedUntil < 0), `bosses: one per group, seeded (${BS.map((b) => bossLabel(F, b)).join('; ')})`);
    const NT = F.factions.map(() => 0);
    const steps: (string | null)[] = [];
    for (let k = 0; k < 6; k++) steps.push(raise(NT, gang.id, NOTORIETY.stopped));
    check(steps.filter(Boolean).join() === 'wary' && heatOf(NT[gang.id]) === 'wary', `notoriety: stopping the gang makes it wary (${NT[gang.id]}, ${steps.join(',')})`);
    check(raise(NT, gang.id, NOTORIETY.bust + NOTORIETY.boss) === 'hunted' && NT[syn.id] === 0, 'notoriety: a bust and its boss beaten: hunted (the others do not care)');
    check(ltChance(0.4, NT[gang.id]) > ltChance(0.4, 0) && bossChance(BS[gang.id], NT[gang.id], 0) > bossChance(BS[gang.id], 30, 0) && bossChance(BS[gang.id], 0, 0) === 0, 'notoriety: more lieutenants, and the boss comes out, the hotter it gets');
    fade(NT, 48);
    check(heatOf(NT[gang.id]) !== 'hunted' && NT[gang.id] >= 0, `notoriety fades over two days (${NT[gang.id].toFixed(0)})`);
    const t1 = jail(BS[gang.id], 100), t2 = jail(BS[gang.id], 500);
    check(t1 === 100 + BOSS.jail && t2 - 500 > t1 - 100 && bossChance(BS[gang.id], 90, 200) === 0, 'jail: a boss behind bars leads nothing; longer the second time');
    BS[gang.id].beaten = 3; BS[gang.id].escapes = 1; NT[gang.id] = 42;
    const BR = planBosses(F, seed), NR = F.factions.map(() => 0);
    restoreBosses(F, BR, NR, JSON.parse(JSON.stringify(saveBosses(F, BS, NT))));
    check(JSON.stringify(BR) === JSON.stringify(BS) && NR[gang.id] === 42, 'bosses and notoriety survive a save');
    const BJ = planBosses(F, seed), NJ = F.factions.map(() => 0);
    restoreBosses(F, BJ, NJ, [{ archetype: 'nobody' }, null, { archetype: 'gang', notoriety: 'x', beaten: -4 }]);
    check(JSON.stringify(BJ) === JSON.stringify(planBosses(F, seed)) && NJ.every((n) => n === 0), 'bosses: junk in a save is ignored');
  }
  check(names.size >= 5, `group names vary with the seed (${[...names].join(', ')})`);
  console.log(`factions: ${[...names].join(' · ')} in ${(performance.now() - t0).toFixed(0)} ms`);
}

// ---- traffic at a six-way junction with one exit blocked (its queue backs up into the box):
// cars never stay inside each other and the junction does not lock up; gawking crowds are capped.
{
  const t0 = performance.now();
  const { Traffic, pathGap } = await import('../src/sim/Traffic');
  const { RoadNet } = await import('../src/sim/RoadNet');
  const { Stimuli } = await import('../src/game/Stimuli');
  const net = new RoadNet(buildMacroPlan(new Terrain(makeProfile({ seed: 42, size: 0.2 }))));
  net.nodes = [{ x: 0, z: 0, edges: [], signal: true, macro: -1 }];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.2, x = Math.cos(a) * 160, z = Math.sin(a) * 160;
    net.nodes.push({ x, z, edges: [k], signal: false, macro: -1 });
    net.nodes[0].edges.push(k);
    net.edges.push({ a: 0, b: k + 1, pts: [0, 0, x / 2, z / 2, x, z], len: 160, width: 16, sidewalk: 3, lanes: 2, cls: 1, cum: [0, 80, 160] });
  }
  net.version = 1;
  const stimuli = new Stimuli();
  const peds = { neighbours: (_x: number, _z: number, _r: number, out: unknown[]) => { out.length = 0; return out; }, crossCheck: null };
  const tr = new Traffic(net, peds as never, stimuli, { height: () => 0 } as never, true, 42);
  // Something lying across the outbound lanes of arm 0, 70 m out: its exit queue fills up.
  const blk = { x: 0, z: 0, dx: 0, dz: 0 };
  net.pointAt(net.edges[0], 70, 0, blk);
  const overlap = (p: { x: number; z: number; yaw: number; length: number; width: number }, q: typeof p) => {
    const ax = [[-Math.sin(p.yaw), -Math.cos(p.yaw)], [Math.cos(p.yaw), -Math.sin(p.yaw)], [-Math.sin(q.yaw), -Math.cos(q.yaw)], [Math.cos(q.yaw), -Math.sin(q.yaw)]];
    const ext = (v: typeof p, ux: number, uz: number) => (v.length / 2) * 0.92 * Math.abs(-Math.sin(v.yaw) * ux - Math.cos(v.yaw) * uz) + (v.width / 2) * 0.92 * Math.abs(Math.cos(v.yaw) * ux - Math.sin(v.yaw) * uz);
    return ax.every(([ux, uz]) => Math.abs((q.x - p.x) * ux + (q.z - p.z) * uz) <= ext(p, ux, uz) + ext(q, ux, uz));
  };
  const lasting = new Map<string, number>();
  let worst = 0, maxBox = 0, maxStill = 0, n = 0;
  for (let i = 0; i < 30 * 400; i++) {
    tr.obstacles.length = 0;
    // The blockage is cleared after 200 s.
    if (i < 30 * 200) tr.obstacles.push({ x: blk.x - blk.dz * 4, z: blk.z + blk.dx * 4, r: 4.5 }, { x: blk.x + blk.dz * 4, z: blk.z - blk.dx * 4, r: 4.5 });
    stimuli.update(1 / 30);
    tr.update(1 / 30, 8.3, 0, 0);
    if (i % 15) continue;
    const V = tr.vehicles;
    n = Math.max(n, V.length);
    const now = new Set<string>();
    for (let a = 0; a < V.length; a++) for (let b = a + 1; b < V.length; b++) {
      if (Math.abs(V[a].x - V[b].x) > 14 || Math.abs(V[a].z - V[b].z) > 14 || !overlap(V[a], V[b])) continue;
      const k = `${V[a].id}:${V[b].id}`;
      now.add(k);
      lasting.set(k, (lasting.get(k) ?? 0) + 0.5);
      worst = Math.max(worst, lasting.get(k)!);
    }
    for (const k of lasting.keys()) if (!now.has(k)) lasting.delete(k);
    const box = V.filter((v) => v.turn);
    maxBox = Math.max(maxBox, box.length);
    if (i >= 30 * 400 - 15) maxStill = Math.max(maxStill, ...box.map((v) => v.jam ?? 0), 0);
  }
  check(n > 40, `traffic: the junction gets busy (${n} cars)`);
  // (Two cars crossing in the box can touch for a few seconds; before, piles at the box exit stayed for good.)
  check(worst <= 20, `traffic: no two cars stay inside each other (longest overlap ${worst} s)`);
  check(maxStill < 30, `traffic: the box is moving again after the blockage is gone (a car standing in it ${maxStill.toFixed(0)} s)`);
  // pathGap: a car straight ahead in the corridor, one in the next lane, one behind.
  const car = { x: 0, z: 0, yaw: 0, length: 4.7, width: 1.85, speed: 5 };
  check(Math.abs(pathGap(car, { x: 0, z: -10, yaw: 0, length: 4.7, width: 1.85 }) - 5.3) < 1e-6 && pathGap(car, { x: 3, z: -10, yaw: 0, length: 4.7, width: 1.85 }) === Infinity && pathGap(car, { x: 0, z: 10, yaw: 0, length: 4.7, width: 1.85 }) === Infinity, 'traffic: pathGap sees only what is in the way');

  // Gawkers: a cry repeated every 3 s for 2 minutes among 200 idle walkers.
  const { Reactions } = await import('../src/sim/Reactions');
  const P = await import('../src/sim/Pedestrians');
  const pop = new Population(buildMacroPlan(new Terrain(makeProfile({ seed: 42, size: 0.2 }))), 42);
  const agents = Array.from({ length: 200 }, (_, k) => ({ id: k + 1, cit: { ...pop.synthetic(500 + k), curiosity: 0.9, nerve: 0.3 }, x: (k % 20) * 1.5 - 15, z: Math.floor(k / 20) * 1.5 - 7, y: 0, heading: 0, speed: 1.3, pref: 1.3, state: P.PState.Walk, route: Float32Array.from([0, 0, 0]), wp: 1, dest: null, fear: 0, fearX: 0, fearZ: 0, lookX: 0, lookZ: 0, lookY: 0, stateT: 0, onRoad: false, phase: 0, look: k, vy: 0, vx: 0, vz: 0, alive: true, slot: -1 } as unknown as import('../src/sim/Pedestrians').PedAgent));
  const gp = { agents, neighbours: (x: number, z: number, r: number, out: typeof agents) => { out.length = 0; for (const a of agents) if (Math.abs(a.x - x) <= r && Math.abs(a.z - z) <= r) out.push(a); return out; } };
  const st2 = new Stimuli();
  const re = new Reactions(gp as never, st2);
  const player = { height: 1.8, pos: { x: 500, y: 0, z: 500 }, flying: false, vel: { length: () => 0 }, k: 1 };
  let maxG = 0, gawkingAtEnd = 0;
  for (let i = 0; i < 30 * 150; i++) {
    const dt = 1 / 30;
    st2.update(dt);
    if (i % 90 === 0 && i < 30 * 120) st2.emit('cry', 0, 1.6, 0, 1, 30);
    re.update(dt, player as never);
    // The pedestrians' own gawk bookkeeping (Pedestrians.step).
    for (const a of agents) { a.stateT += dt; if ((a.state === P.PState.Gawk || a.state === P.PState.Film) && P.gawkOver(a, dt)) a.state = P.PState.Walk; }
    const g = agents.filter((a) => a.state === P.PState.Gawk || a.state === P.PState.Film).length;
    maxG = Math.max(maxG, g);
    if (i === 30 * 119) gawkingAtEnd = g;
  }
  check(maxG > 5 && maxG <= P.GAWK_CROWD, `gawkers: a crowd forms but stays at most ${P.GAWK_CROWD} (${maxG})`);
  check(agents.every((a) => (a.state !== P.PState.Gawk && a.state !== P.PState.Film) || a.stateT < P.GAWK_MAX + 1), 'gawkers: nobody stands longer than GAWK_MAX');
  console.log(`traffic: six-way junction ${n} cars, longest overlap ${worst} s, ${maxBox} in the box at most; gawkers ≤ ${maxG} (${gawkingAtEnd} after 2 min of cries) in ${(performance.now() - t0).toFixed(0)} ms`);
}

// ---- side rooms and hidden colonies: deterministic per seed; rooms clear of every tube, station
// hall, entrance passage and each other, under the ground; 2–5 colonies, each reachable on foot
// from its side room (and every room from its tunnel) in steps a walker can take.
{
  const { planRooms, roomConflicts, roomW } = await import('../src/underground/rooms');
  const { metroTube, sewerTube, stationHalls } = await import('../src/underground/layout');
  const { tubeAt, boxAt } = await import('../src/underground/Volumes');
  for (const [seed, size] of [[42, 0.6], [7, 0.4]] as const) {
    const terrain = new Terrain(makeProfile({ seed, size }));
    const macro = buildMacroPlan(terrain);
    const tubes = [...macro.metroLines.map(metroTube), ...macro.sewers.map((s) => sewerTube(s.pts, terrain, s.culvert))];
    const halls = stationHalls(macro);
    const t0 = performance.now();
    const plan = planRooms(macro, terrain, tubes, halls);
    const ms = performance.now() - t0;
    check(hashPlan(plan) === hashPlan(planRooms(macro, terrain, tubes, halls)), `rooms seed ${seed}: plan deterministic`);
    const passages = metroInput(macro, terrain).input.passages ?? [];
    const conf = roomConflicts(plan, terrain, tubes, halls, passages.map((p) => p.tube));
    check(conf.cuts === 0 && conf.uncovered === 0, `rooms seed ${seed}: clear of tubes, halls, ${passages.length} entrance passages and each other, under the ground (${conf.cuts} cuts, ${conf.uncovered} uncovered)`);
    check(plan.colonies.length >= 2 && plan.colonies.length <= 5, `rooms seed ${seed}: 2–5 colonies (${plan.colonies.length})`);
    // Walking: floors as the game finds them (highest floor in reach of the feet), always inside a volume.
    const allT = [...tubes, ...plan.colonies.map((c) => c.crawl)];
    const allB = [...halls, ...plan.rooms.flatMap((r) => r.boxes), ...plan.colonies.map((c) => c.chamber)];
    const floorAt = (x: number, y: number, z: number) => {
      let best: number | null = null;
      for (const t of allT) { const h = tubeAt(t, x, y, z); if (h && h.floor <= y + 0.6 && (best === null || h.floor > best)) best = h.floor; }
      for (const b of allB) { const h = boxAt(b, x, y, z); if (h && h.floor <= y + 0.6 && (best === null || h.floor > best)) best = h.floor; }
      return best;
    };
    const inside = (x: number, y: number, z: number) => allT.some((t) => tubeAt(t, x, y, z, -0.15)) || allB.some((b) => boxAt(b, x, y, z, -0.15));
    /** Walk a polyline (x, z pairs) from floor y: the largest step up, or Infinity if the walker leaves the volumes. */
    const walk = (pts: number[], y: number): number => {
      let worst = 0;
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const L = Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]), n = Math.max(1, Math.ceil(L / 0.2));
        for (let k = 1; k <= n; k++) {
          const x = pts[i] + ((pts[i + 2] - pts[i]) * k) / n, z = pts[i + 1] + ((pts[i + 3] - pts[i + 1]) * k) / n;
          const f = floorAt(x, y + 0.3, z);
          if (f === null || !inside(x, f + 0.3, z)) return Infinity;
          worst = Math.max(worst, f - y);
          y = f;
        }
      }
      return worst;
    };
    let unreachable = 0;
    for (const r of plan.rooms) {
      const v0 = r.kind === 'ghost' ? r.doors[0].v0 + 1.1 : 0, m = r.main;
      const pts = [...roomW(r, -0.5, v0), ...roomW(r, r.kind === 'ghost' ? 2 : m.u0 + 0.4, v0), ...roomW(r, (m.u0 + m.u1) / 2, (m.v0 + m.v1) / 2)];
      if (walk(pts, r.y) > 0.36) unreachable++;
    }
    check(unreachable === 0, `rooms seed ${seed}: every room reachable from its tunnel (${unreachable} not)`);
    for (const c of plan.colonies) {
      const r = plan.rooms[c.room], m = r.main, P = c.crawl.pts;
      const pts = [...roomW(r, -0.5, 0), ...roomW(r, m.u0 + 0.4, 0), P[0], P[2]];
      for (let i = 3; i < P.length; i += 3) pts.push(P[i], P[i + 2]);
      pts.push(c.chamber.cx, c.chamber.cz);
      const step = walk(pts, r.y);
      check(!!r.gap && step <= 0.36, `rooms seed ${seed}: colony ${c.id} reachable from room ${r.id} (${r.kind}) through its gap (largest step ${step.toFixed(2)} m)`);
    }
    // The bigger rooms: machine halls (stairs back up to the gallery in steps a walker can take),
    // winding rooms and hideouts (the crew's spots on its floor, clear of each other).
    const { HALL_GALLERY, HALL_STAIR_W, HALL_STEPS, HALL_RUN, denLayout } = await import('../src/underground/rooms');
    const big = { hall: 0, gears: 0, hideout: 0 };
    let hallSteep = 0, denBad = 0;
    for (const r of plan.rooms) {
      if (r.kind === 'hall' || r.kind === 'gears' || r.kind === 'hideout') big[r.kind]++;
      const m = r.main;
      if (r.kind === 'hall') {
        const g1 = m.u0 + HALL_GALLERY, sv = m.v1 - HALL_STAIR_W / 2, end = g1 + HALL_STEPS * HALL_RUN + 0.6;
        const pts = [...roomW(r, end + 0.5, (m.v0 + m.v1) / 2), ...roomW(r, end, sv), ...roomW(r, g1 - 0.3, sv), ...roomW(r, m.u0 + 0.4, 0), ...roomW(r, -0.5, 0)];
        if (walk(pts, m.y0) > 0.36) hallSteep++;
      }
      if (r.kind === 'hideout') {
        const L = denLayout(r);
        for (const c of L.crew) {
          const [x, z] = roomW(r, c.u, c.v);
          const f = floorAt(x, r.y + 0.5, z);
          if (f === null || Math.abs(f - r.y) > 0.05 || c.u < m.u0 + 0.3 || c.u > m.u1 - 0.3 || c.v < m.v0 + 0.3 || c.v > m.v1 - 0.3) denBad++;
        }
        for (let i = 0; i < L.crew.length; i++) for (let j = i + 1; j < L.crew.length; j++) if (Math.hypot(L.crew[i].u - L.crew[j].u, L.crew[i].v - L.crew[j].v) < 0.7) denBad++;
      }
    }
    check(big.hall > 0 && big.gears > 0 && big.hideout > 0, `rooms seed ${seed}: machine halls, winding rooms and hideouts off the sewers (${big.hall} / ${big.gears} / ${big.hideout})`);
    check(hallSteep === 0, `rooms seed ${seed}: every machine hall's stairs lead back up to its gallery (${hallSteep} not)`);
    check(denBad === 0, `rooms seed ${seed}: every hideout's crew spots on its floor, apart (${denBad} bad)`);
    const kinds = new Set(plan.rooms.map((r) => r.kind));
    check(kinds.size >= 12, `rooms seed ${seed}: most kinds of rooms present (${[...kinds].join(' ')})`);
    console.log(`rooms seed ${seed}: ${plan.rooms.length} side rooms (${plan.rooms.filter((r) => r.trace).length} with traces), ${plan.colonies.length} colonies in ${ms.toFixed(0)} ms`);
  }
}

// ---- the sewers: one network (culverts under the rivers join the banks), junctions level, culverts
// walkable and under the river bed; the Lumen's signs on every junction lead to a colony.
{
  const { metroTube, sewerTube, stationHalls } = await import('../src/underground/layout');
  const { planRooms } = await import('../src/underground/rooms');
  const { planSewerHints } = await import('../src/underground/sewerHints');
  for (const [seed, size] of [[42, 0.6], [7, 0.4]] as const) {
    const terrain = new Terrain(makeProfile({ seed, size }));
    const macro = buildMacroPlan(terrain);
    const S = macro.sewers, sew = S.map((s) => sewerTube(s.pts, terrain, s.culvert));
    const parent = macro.nodes.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const ends = new Map<number, number[]>();
    S.forEach((s, i) => {
      parent[find(s.a)] = find(s.b);
      const P = sew[i].pts;
      ends.set(s.a, [...(ends.get(s.a) ?? []), P[1]]);
      ends.set(s.b, [...(ends.get(s.b) ?? []), P[P.length - 2]]);
    });
    const comps = new Set(S.map((s) => find(s.a))).size;
    let step = 0;
    for (const ys of ends.values()) step = Math.max(step, Math.max(...ys) - Math.min(...ys));
    let grade = 0, cover = Infinity;
    S.forEach((s, i) => {
      if (!s.culvert) return;
      const P = sew[i].pts;
      for (let k = 3; k < P.length; k += 3) { const L = Math.hypot(P[k] - P[k - 3], P[k + 2] - P[k - 1]); if (L > 0.5) grade = Math.max(grade, Math.abs(P[k + 1] - P[k - 2]) / L); }
      for (let k = 0; k < P.length; k += 3) cover = Math.min(cover, terrain.height(P[k], P[k + 2]) - (P[k + 1] + sew[i].height));
    });
    const culverts = S.filter((s) => s.culvert).length;
    check(comps === 1, `sewers seed ${seed}: one network (${comps} parts, ${culverts} culverts under the rivers)`);
    check(step < 0.01, `sewers seed ${seed}: trunks meet level at the junctions (largest step ${step.toFixed(3)} m)`);
    check(!culverts || (grade <= 0.31 && cover >= 1.5), `sewers seed ${seed}: culverts walkable and covered (grade ${grade.toFixed(2)}, cover ${cover.toFixed(1)} m)`);
    let steep = 0;
    S.forEach((s, i) => {
      if (s.culvert) return;
      const P = sew[i].pts;
      for (let k = 3; k < P.length; k += 3) { const L = Math.hypot(P[k] - P[k - 3], P[k + 2] - P[k - 1]); if (L > 0.5) steep = Math.max(steep, Math.abs(P[k + 1] - P[k - 2]) / L); }
    });
    check(steep <= 0.31, `sewers seed ${seed}: trunks walkable (steepest ${steep.toFixed(2)})`);
    const tubes = [...macro.metroLines.map(metroTube), ...sew];
    const rooms = planRooms(macro, terrain, tubes, stationHalls(macro));
    const hints = planSewerHints(macro, tubes, rooms);
    const junctions = [...new Set(S.flatMap((s) => [s.a, s.b]))].filter((n) => S.filter((s) => s.a === n || s.b === n).length >= 2).length;
    const n = (k: string) => hints.filter((h) => h.kind === k).length;
    const arrows = n('arrow'), marks = n('mark'), chev = n('chevron'), scouts = n('scout');
    const sewerColonies = rooms.colonies.filter((c) => rooms.rooms[c.room].net === 'sewer').length;
    check(!sewerColonies || (arrows >= junctions * 0.9 && marks >= junctions * 1.8 && chev > 100 && scouts >= 1), `sewers seed ${seed}: the Lumen's signs show the way at the junctions (${arrows} arrows and ${marks} signs at ${junctions} junctions, ${chev} chevrons, ${scouts} scouts, ${sewerColonies} colonies off the sewers)`);
  }
}

// ---- no sewer breaks through the street: soil over every trunk's vault along its whole length
// (seed 1234 @0.5 once had a brick trunk standing out of a street in a dip).
{
  const { sewerBreaches, MIN_COVER } = await import('./sewersweep');
  for (const [seed, size] of [[1234, 0.5], [42, 0.6], [7, 0.4], [17, 0.75]] as const) {
    const { breaches, trunks } = sewerBreaches(seed, size);
    const w = breaches.reduce((m, q) => Math.min(m, q.ground - q.crown), Infinity);
    check(!breaches.length, `sewers seed ${seed} @${size}: every trunk under the ground (${breaches.length} of ${trunks} with less than ${MIN_COVER} m over the vault${breaches.length ? `, worst ${w.toFixed(2)} m` : ''})`);
  }
}

// ---- the deep realm (src/underground/deep): deterministic per seed; its caves clear of every tunnel,
// station, room, crawl and entrance passage, deep under the ground; every waypoint edge walkable on
// the field's floors (steps a walker can take, headroom); the war and the trust behave.
{
  const { planRooms } = await import('../src/underground/rooms');
  const { metroTube, sewerTube, stationHalls } = await import('../src/underground/layout');
  const { tubeAt, boxAt } = await import('../src/underground/Volumes');
  const { planDeep } = await import('../src/underground/deep/plan');
  const { DeepField, primBounds } = await import('../src/underground/deep/field');
  const { runTrench } = await import('./trenchsim');
  for (const [seed, size] of [[42, 0.6], [7, 0.4]] as const) {
    const terrain = new Terrain(makeProfile({ seed, size }));
    const macro = buildMacroPlan(terrain);
    const tubes = [...macro.metroLines.map(metroTube), ...macro.sewers.map((s) => sewerTube(s.pts, terrain, s.culvert))];
    const halls = stationHalls(macro);
    const rooms = planRooms(macro, terrain, tubes, halls);
    const passages = (metroInput(macro, terrain).input.passages ?? []).map((p) => p.tube);
    const allT = [...tubes, ...passages, ...rooms.colonies.map((c) => c.crawl)];
    const allB = [...halls, ...rooms.rooms.flatMap((r) => r.boxes), ...rooms.colonies.map((c) => c.chamber)];
    const occupied = (x: number, y: number, z: number) => allT.some((t) => { const h = tubeAt(t, x, y, z, 1.0); return !!h && y > h.floor - 2 && y < h.floor + t.height + 1; }) || allB.some((b) => !!boxAt(b, x, y, z, 1.0) && y > b.y0 - 2 && y < b.y1 + 1);
    const blocked = (x: number, y: number, z: number) => occupied(x, y, z) || halls.some((h) => Math.hypot(h.cx - x, h.cz - z) < h.hu + 80 && y > h.y0 - 4);
    const t0 = performance.now();
    const inp = { seed: macro.seed, colonies: rooms.colonies, ground: (x: number, z: number) => terrain.height(x, z), blocked };
    const plan = planDeep(inp);
    const ms = performance.now() - t0;
    check(!!plan, `deep seed ${seed}: a realm is planned (${rooms.colonies.length} colonies)`);
    if (!plan) continue;
    check(hashPlan(plan) === hashPlan(planDeep(inp)), `deep seed ${seed}: plan deterministic`);
    const F = new DeepField(plan.prims, plan.seed);
    const own = new Set(plan.roads.map((r) => rooms.colonies[r.colony].chamber));
    // Air of the realm vs everything else (the roads' own chambers excepted), and its cover.
    let cuts = 0, shallow = 0, samples = 0;
    for (const p of plan.prims) {
      if (p.rock) continue;
      const b = primBounds(p);
      for (let x = b[0]; x <= b[3]; x += 3) for (let z = b[2]; z <= b[5]; z += 3) for (let y = b[1]; y <= b[4]; y += 2) {
        if (F.sdf(x, y, z) > -0.3) continue;
        samples++;
        if (allT.some((t) => { const h = tubeAt(t, x, y, z, 0); return !!h && y > h.floor - 0.3 && y < h.floor + t.height; }) || allB.some((bx) => !own.has(bx) && !!boxAt(bx, x, y, z, 0) && y > bx.y0 - 0.3 && y < bx.y1)) cuts++;
        if (y > terrain.height(x, z) - 1.5) shallow++;
      }
    }
    check(cuts === 0 && shallow === 0, `deep seed ${seed}: caves clear of the tunnels, stations, rooms and passages, under the ground (${cuts} cuts, ${shallow} shallow of ${samples} samples)`);
    // Walking the waypoint graph on the field: half-metre steps, rises a walker takes, room for the body.
    let bad = 0;
    const why: string[] = [];
    for (const [a, b] of plan.edges) {
      const A = plan.nodes[a], B = plan.nodes[b];
      const L = Math.hypot(B.x - A.x, B.z - A.z), n = Math.max(1, Math.ceil(L / 0.5));
      let y = A.y, fail = '';
      for (let i = 1; i <= n && !fail; i++) {
        const x = A.x + ((B.x - A.x) * i) / n, z = A.z + ((B.z - A.z) * i) / n;
        const f = F.floorAt(x, y + 0.85, z, 6);
        if (f === null) fail = 'no floor';
        else if (f - y > 0.55) fail = `step ${(f - y).toFixed(2)}`;
        else if (!F.air(x, f + 1.7, z)) fail = 'low';
        else y = f;
      }
      if (fail) { bad++; if (why.length < 6) why.push(`${A.name}→${B.name}: ${fail}`); }
    }
    check(bad === 0, `deep seed ${seed}: every waypoint edge walkable (${bad} of ${plan.edges.length} not${why.length ? ': ' + why.join('; ') : ''})`);
    // Every road's gate connects to the Heart through the graph.
    const adj: number[][] = plan.nodes.map(() => []);
    for (const [a, b] of plan.edges) { adj[a].push(b); adj[b].push(a); }
    const seen = new Set<number>([plan.nodes.find((q) => q.name === 'heart')!.id]);
    const q = [...seen];
    while (q.length) for (const m of adj[q.shift()!]) if (!seen.has(m)) { seen.add(m); q.push(m); }
    const gates = plan.nodes.filter((q2) => q2.name.startsWith('gate'));
    check(gates.length === plan.roads.length && gates.every((g2) => seen.has(g2.id)), `deep seed ${seed}: every gate (${gates.length}) leads down to the Heart`);
    // The trench war in the Warrens' mouth: the line laid out, the Lumen's sentries hold it against the endless pushes
    // (most Murk fall in no-man's land, hardly any get past, the fallen are replaced; dice seeded per realm),
    // and the Murk go for a player in their way.
    const T = plan.trench;
    check(T.segs.length === 3 && T.posts.length >= 5 && T.gapPosts.length === 2 && T.craters.length >= 3 && ['trench', 'noMans', 'murkLine'].every((k) => !!plan.places[k]) && ['trench0', 'trench1', 'noMans', 'murkLine'].every((k) => plan.nodes.some((q2) => q2.name === k)),
      `deep seed ${seed}: the Warrens' mouth is a trench line (${T.segs.length} bays, ${T.posts.length} spots, ${T.gapPosts.length} gaps, ${T.craters.length} craters)`);
    const tw = runTrench(plan, 150, 'away');
    check(tw.spawned >= 20 && tw.killed >= tw.spawned * 0.6 && tw.past <= 2 && tw.sentriesLost <= 12, `deep seed ${seed}: the Lumen hold the trench (${tw.spawned} Murk came, ${tw.killed} fell, ${tw.reachedLine} reached the line, ${tw.past} got past; ${tw.sentriesLost} sentries lost; ${tw.hits}/${tw.bolts} bolts hit)`);
    const tp = runTrench(plan, 60, 'noMans');
    check(tp.playerHits >= 3, `deep seed ${seed}: the Murk go for a player in no-man's land (${tp.playerHits} hits in 60 s)`);
    console.log(`deep seed ${seed}: ${plan.roads.length} roads, ${plan.prims.length} shapes, ${plan.decor.length} decor, ${plan.glows.length / 7} lights, ${plan.nodes.length} waypoints, Glow at ${plan.yGlow.toFixed(0)} m, Deep at ${plan.yDeep.toFixed(0)} m, in ${ms.toFixed(0)} ms`);
  }
  // The war: deterministic; left alone with strong Murk the line falls back; the Maw brought down stops them growing.
  const { freshWar, stepWar, mawDown, parseWar, WAR } = await import('../src/underground/deep/War');
  const seeded = (n: number) => () => { n = (n * 1664525 + 1013904223) >>> 0; return n / 4294967296; };
  const wa = freshWar(0, 3, seeded(1)), wb = freshWar(0, 3, seeded(1));
  stepWar(wa, 200, false, false, {}, seeded(2)); stepWar(wb, 200, false, false, {}, seeded(2));
  check(JSON.stringify(wa) === JSON.stringify(wb), 'war: deterministic for a seed');
  const strong = freshWar(0, 3, seeded(3)); strong.murk = 1; strong.lumen = 0.1;
  stepWar(strong, 48, false, false, {}, seeded(4));
  check(strong.front > 0.5 && strong.stats.lost > strong.stats.won, `war: strong Murk push the line back when nobody helps (front ${strong.front.toFixed(2)}, ${strong.stats.lost} lost / ${strong.stats.won} won)`);
  const down = freshWar(0, 3, seeded(5)); down.murk = 0.8; mawDown(down); const m0 = down.murk;
  stepWar(down, 24, false, false, {}, seeded(6));
  check(down.murk <= m0 && down.mawBack === WAR.mawDown, `war: with the Maw down the Murk do not grow (${m0.toFixed(2)} → ${down.murk.toFixed(2)})`);
  let breaches = 0;
  const lost = freshWar(0, 3, seeded(7)); lost.front = 1; lost.murk = 1; lost.lumen = 0;
  for (let h = 1; h <= 72; h++) stepWar(lost, h, false, true, { breach: () => { breaches++; } }, seeded(8 + h));
  check(breaches >= 2, `war: the Murk holding the Hall break out at night (${breaches} in three nights)`);
  const pw = parseWar({ ...JSON.parse(JSON.stringify(wa)), murk: 7, captives: [9, 'x'] }, 3, 0);
  check(!!pw && pw.murk === 1 && pw.captives.length === 3 && pw.captives[0] === WAR.penMax && pw.captives[1] === 0, 'war: a saved state is sanitised');
  const { tierOf, callRank, parseTrust, TRUST } = await import('../src/underground/deep/Trust');
  check(tierOf(-50) === 'Shunned' && tierOf(0) === 'Stranger' && tierOf(10) === 'Noticed' && tierOf(30) === 'Welcome' && tierOf(55) === 'Ally' && tierOf(80) === 'Kin', 'trust: tiers');
  check(callRank(54, true) === 0 && callRank(TRUST.ally, false) === 1 && callRank(TRUST.kin, false) === 2 && callRank(100, false) === 2 && callRank(100, true) === 3, 'trust: the Slime call rank follows trust (rank 3 after the Maw)');
  check(parseTrust({ v: 500, gifts: [1, 'x'], marks: ['a', 3] })?.v === 100 && parseTrust('x') === null, 'trust: a saved value is sanitised');
}

// ---- city threats: the threat clock's schedule is deterministic per seed, the first minor event
// comes no earlier than its minimum, omens always come first, "off" schedules nothing.
{
  const { ThreatClock, CLOCK, EVENT_SCALE } = await import('../src/game/threats/ThreatClock');
  type Sig = { t: number; type: string; kind?: string };
  const run = (seed: number, setting: 'off' | 'rare' | 'normal' | 'frequent', hours: number, karmaEvery = 0, from?: InstanceType<typeof ThreatClock>) => {
    const c = from ?? new ThreatClock(seed);
    c.setting = setting;
    const out: Sig[] = [];
    for (let t = 0; t < hours * 3600; t++) {
      for (const s of c.tick(1, karmaEvery && t % karmaEvery === 0 ? 1 : 0, 0)) out.push({ t: Math.round(c.state.played), type: s.type, kind: s.type === 'omen' ? s.kind : undefined });
    }
    return { out, c };
  };
  const a = run(42, 'normal', 5).out, b = run(42, 'normal', 5).out, c2 = run(43, 'normal', 5).out;
  const evA = a.filter((s) => s.type === 'event');
  check(JSON.stringify(a) === JSON.stringify(b), 'threat clock: schedule deterministic for a seed');
  check(JSON.stringify(a) !== JSON.stringify(c2), 'threat clock: schedule varies with the seed');
  check(evA.length >= 3, `threat clock: minor events come over 5 h of play (${evA.length})`);
  check(evA.length > 0 && evA[0].t >= CLOCK.firstMinor, `threat clock: first event not before ${CLOCK.firstMinor / 60} min (${(evA[0]?.t / 60).toFixed(1)} min)`);
  let gapsOk = true, omensOk = true, prev = 0;
  for (const e of evA) {
    if (prev && e.t - prev < CLOCK.gapMin) gapsOk = false;
    const om = a.filter((s) => s.type === 'omen' && s.t > prev && s.t < e.t);
    if (om.length < CLOCK.omensMin) omensOk = false;
    prev = e.t;
  }
  check(gapsOk, 'threat clock: at most one minor event per 20 min of play');
  check(omensOk, `threat clock: every event preceded by ≥ ${CLOCK.omensMin} omens since the last one`);
  check(run(42, 'off', 6).out.length === 0, 'threat clock: "off" schedules nothing');
  // A busy hero (karma) brings events sooner — never before the minimum.
  const busy = run(42, 'normal', 5, 20).out.filter((s) => s.type === 'event');
  check(busy.length > evA.length && busy[0].t >= CLOCK.firstMinor && busy[0].t <= evA[0].t, `threat clock: karma brings events sooner, not before the minimum (first ${(busy[0]?.t / 60).toFixed(1)} vs ${(evA[0]?.t / 60).toFixed(1)} min, ${busy.length} vs ${evA.length} events)`);
  const freq = run(42, 'frequent', 5).out.filter((s) => s.type === 'event'), rare = run(42, 'rare', 5).out.filter((s) => s.type === 'event');
  check(freq.length > evA.length && freq[0].t >= CLOCK.firstMinor * EVENT_SCALE.frequent && rare.length < evA.length, `threat clock: frequent / rare scale it (${freq.length} / ${evA.length} / ${rare.length} events in 5 h)`);
  // Saved and restored half way: the same continuation.
  const half = run(42, 'normal', 2.5).c;
  const restored = new ThreatClock(42, JSON.parse(JSON.stringify(half.state)));
  const rest = run(42, 'normal', 2.5, 0, restored).out.filter((s) => s.type === 'event').map((s) => s.t);
  check(JSON.stringify(rest) === JSON.stringify(evA.filter((s) => s.t > 2.5 * 3600).map((s) => s.t)), 'threat clock: a saved clock continues the same schedule');
  // Never armed while not ready (underground): the due event waits, then comes.
  const w = new ThreatClock(42);
  let fired = -1;
  for (let t = 0; t < 4 * 3600 && fired < 0; t++) if (w.tick(1, 0, 0, t > 2 * 3600).some((s) => s.type === 'event')) fired = t;
  check(fired > 2 * 3600, `threat clock: a due event waits until it can be seen (fired at ${(fired / 60).toFixed(0)} min)`);
  console.log(`threat clock: seed 42 normal → events at ${evA.map((e) => (e.t / 60).toFixed(0)).join(', ')} min; omens ${a.filter((s) => s.type === 'omen').map((s) => `${(s.t / 60).toFixed(0)}:${s.kind}`).join(' ')}`);
}

// ---- the brood (THREATS_PLAN Phase C): the swarm's simulation is deterministic, stays within its cap,
// comes out of its holes, spreads into a carpet (not a heap), goes for people a few at a time, climbs
// walls without ending up inside buildings, dies to blows (a frozen brute shatters), withdraws into
// its holes, steps 150 creatures cheaply; the clock schedules it among the minor events.
{
  const { BroodSim, BROOD, CMode } = await import('../src/game/threats/brood/BroodSim');
  const { ThreatClock } = await import('../src/game/threats/ThreatClock');
  type P = { kind: 'person'; x: number; y: number; z: number; r: number; ref: unknown; n: number; down: boolean };
  // Flat ground, one building (x 20…30, z −10…10, 8 m tall), people in a row north of the holes.
  const inB = (x: number, z: number) => x > 20 && x < 30 && z > -10 && z < 10;
  const mk = (seed: number, n: number, brutes: number, people = 20) => {
    const prey: P[] = [];
    for (let i = 0; i < people; i++) prey.push({ kind: 'person', x: -10 + i, y: 0, z: 30, r: 0.3, ref: i, n: 0, down: false });
    const sim = new BroodSim({
      surface: (x, z, yRef) => (inB(x, z) && yRef >= 7.5 ? 8 : 0),
      wall: (x, z, y) => (inB(x, z) && y < 7.4 ? 8 : NaN),
      prey: (out) => { for (const p of prey) if (!p.down) out.push(p); },
    }, seed, [{ x: 0, z: 0 }, { x: 6, z: 2 }]);
    sim.onBite = (_c, p) => { (p as P).down = true; };
    sim.spawn(n, brutes, 0.5);
    return { sim, prey };
  };
  const runFor = (sim: InstanceType<typeof BroodSim>, s: number, each?: () => void) => { for (let t = 0; t < s * BROOD.hz; t++) { sim.step(1 / BROOD.hz); each?.(); } };
  const a = mk(42, 60, 2), b = mk(42, 60, 2), c = mk(43, 60, 2);
  runFor(a.sim, 20); runFor(b.sim, 20); runFor(c.sim, 20);
  check(a.sim.hash() === b.sim.hash(), 'brood: the swarm is deterministic for a seed');
  check(a.sim.hash() !== c.sim.hash(), 'brood: the swarm varies with the seed');
  check(mk(1, 400, 4).sim.list.length === BROOD.cap, `brood: at most ${BROOD.cap} creatures`);
  check(a.sim.stats.out === 60, `brood: all came out of the holes within 20 s (${a.sim.stats.out})`);
  const bitten = a.prey.filter((p) => p.down).length;
  check(bitten >= 10, `brood: it goes for people (${bitten} of 20 knocked down in 20 s)`);
  // Never more than the cap on one person; a carpet (nearest neighbour apart), and no one inside the building.
  const d = mk(7, 120, 3, 0);
  d.sim.goal = { x: 40, z: 0 };
  let crowd = 0, inside = 0, nnSum = 0, nnN = 0;
  const e = mk(8, 80, 0, 4);
  runFor(e.sim, 12, () => { for (const p of e.prey) if (p.n > BROOD.maxOn.person) crowd++; });
  runFor(d.sim, 30, () => {
    for (const k of d.sim.list) if ((k.mode === CMode.Run || k.mode === CMode.Leave) && !k.air && inB(k.x, k.z) && k.y < 7.5) inside++;
  });
  for (const k of d.sim.list) {
    if (k.mode !== CMode.Run || k.kind !== 0 || k.air) continue;
    let nn = Infinity;
    for (const o of d.sim.list) if (o !== k && o.mode === CMode.Run && !o.air && Math.abs(o.y - k.y) < 1) nn = Math.min(nn, Math.hypot(o.x - k.x, o.z - k.z));
    if (isFinite(nn)) { nnSum += nn; nnN++; }
  }
  check(crowd === 0, `brood: at most ${BROOD.maxOn.person} on one person (${crowd} steps over)`);
  check(nnN > 50 && nnSum / nnN > 0.7, `brood: a carpet, not a heap (mean nearest neighbour ${(nnSum / Math.max(1, nnN)).toFixed(2)} m over ${nnN})`);
  check(d.sim.stats.climbs > 0, `brood: creatures climb walls (${d.sim.stats.climbs} climbs)`);
  check(inside === 0, `brood: none runs inside a building (${inside} creature-steps)`);
  check(d.sim.list.some((k) => k.y > 7.9 && inB(k.x, k.z)), 'brood: some get over the edge onto the roof');
  // Hits: a blow kills the small ones round it, a brute takes more; frozen, it shatters at the next blow.
  const h = mk(9, 40, 1, 0);
  runFor(h.sim, 10);
  const live = () => h.sim.list.filter((k) => k.mode === CMode.Run || k.mode === CMode.Frozen);
  const k0 = live().filter((k) => k.kind === 0)[0];
  const r1 = h.sim.hit(k0.x, k0.y + 0.3, k0.z, 4, 'blow', 1, k0.x + 1, k0.z, 5, 'player');
  check(r1.killed >= 1 && r1.killed === r1.hit.filter((k) => k.kind === 0).length, `brood: a blow kills the small ones it reaches (${r1.killed} of ${r1.hit.length})`);
  const br = h.sim.list.find((k) => k.kind === 1)!;
  h.sim.damage(br, 'blow', 1, br.x + 1, br.z, 2, 'player');
  check(br.mode !== CMode.Dead && br.hp > 0, 'brood: a brute survives one blow');
  h.sim.damage(br, 'frost', 4, br.x, br.z, 0, 'player');
  const froze = br.mode === CMode.Frozen;
  h.sim.damage(br, 'blow', 0.5, br.x + 1, br.z, 2, 'player');
  check(froze && br.mode === CMode.Dead, 'brood: frozen, a brute shatters at the next blow');
  check((h.sim.stats.killedBy.player ?? 0) === h.sim.stats.killed, 'brood: kills are credited to who did it');
  h.sim.leave();
  runFor(h.sim, 60);
  check(h.sim.alive === 0 && h.sim.list.every((k) => k.mode === CMode.Gone), `brood: leaving, they all drop back into the holes (${h.sim.alive} left)`);
  // Cost: 150 creatures at 15 Hz.
  const f = mk(11, 150, 6, 60);
  runFor(f.sim, 5);
  const t0 = performance.now();
  runFor(f.sim, 20);
  const ms = (performance.now() - t0) / (20 * BROOD.hz);
  check(ms < 1.0, `brood: a step of 150 creatures is cheap (${ms.toFixed(3)} ms)`);
  // The clock: the brood among the minor events.
  const clk = new ThreatClock(42);
  const arch: string[] = [];
  for (let t = 0; t < 8 * 3600; t++) for (const sg of clk.tick(1, 0, 0)) if (sg.type === 'event') arch.push(sg.archetype);
  check(arch.includes('brood') && arch.includes('robots'), `brood: the clock schedules it among the minor events (${arch.join(', ')})`);
  console.log(`brood: ${a.sim.stats.bites} bites, ${d.sim.stats.climbs} climbs, step ${ms.toFixed(3)} ms for 150`);
}

// ---- the Strider (THREATS_PLAN Phase B): major events come no earlier than their floor and only after a
// karma milestone, with their own omens; its route from the river to downtown exists for 20 seeds; the
// rig's pure math (two-bone IK reach, follow-the-leader spacing, FABRIK, ray vs capsule) behaves.
{
  const { ThreatClock, CLOCK } = await import('../src/game/threats/ThreatClock');
  type Sig = { t: number; type: string; arch: string; kind?: string; karma: number };
  const run = (seed: number, hours: number, karmaFrom: number, karmaEvery: number) => {
    const c = new ThreatClock(seed);
    const out: Sig[] = [];
    for (let t = 0; t < hours * 3600; t++) {
      const k = karmaEvery && t >= karmaFrom && t % karmaEvery === 0 ? 1 : 0;
      for (const s of c.tick(1, k, 0)) out.push({ t: Math.round(c.state.played), type: s.type, arch: s.archetype, kind: s.type === 'omen' ? s.kind : undefined, karma: c.state.karma });
    }
    return out;
  };
  const none = run(42, 6, 0, 0);
  check(!none.some((s) => s.type === 'event' && s.arch === 'strider'), 'major events: none without the karma milestone (6 h, no karma)');
  for (const seed of [42, 7, 1234]) {
    const busy = run(seed, 7, 0, 20);
    const majors = busy.filter((s) => s.type === 'event' && s.arch === 'strider');
    check(majors.length >= 1 && majors[0].t >= CLOCK.firstMajor, `major events: seed ${seed}: the first Strider no earlier than ${CLOCK.firstMajor / 3600} h (${majors.map((m) => (m.t / 3600).toFixed(2) + ' h').join(', ') || 'none'})`);
    check(majors.every((m) => m.karma >= CLOCK.majorKarma), `major events: seed ${seed}: only after the karma milestone (${majors.map((m) => m.karma).join(', ')})`);
    const i0 = busy.indexOf(majors[0]);
    const prevEv = busy.slice(0, i0).filter((s) => s.type === 'event').pop();
    const om = busy.filter((s) => s.type === 'omen' && s.arch === 'strider' && s.t < (majors[0]?.t ?? 0) && s.t > (prevEv?.t ?? 0));
    check(om.length >= CLOCK.majorOmensMin && om.every((o) => o.kind === 'tremor' || o.kind === 'wake'), `major events: seed ${seed}: ≥ ${CLOCK.majorOmensMin} Strider omens before it (${om.map((o) => o.kind).join(', ')})`);
    // Minor events still come around it.
    const evs = busy.filter((s) => s.type === 'event');
    check(evs.filter((e) => e.arch === 'robots' || e.arch === 'brood').length >= 4, `major events: seed ${seed}: minor events go on around them (${evs.map((e) => e.arch[0]).join('')})`);
    if (seed === 42) console.log(`threat clock (busy hero, seed 42): ${evs.map((e) => `${(e.t / 60).toFixed(0)}:${e.arch}`).join(' ')}`);
  }
  // The milestone reached late (karma only from 4 h on): the Strider waits for it.
  const late = run(42, 9, 4 * 3600, 20);
  const reached = late.find((s) => s.karma >= CLOCK.majorKarma);
  const firstLate = late.find((s) => s.type === 'event' && s.arch === 'strider');
  check(!!firstLate && firstLate.t >= 4 * 3600 + CLOCK.majorKarma * 20 - 20, `major events: a late karma milestone delays the Strider (${firstLate ? (firstLate.t / 3600).toFixed(2) + ' h' : 'none'}, milestone at ${reached ? (reached.t / 3600).toFixed(2) : '?'} h)`);

  // Route: start in the river, end in downtown, along the arterials, a reasonable length.
  const { planStriderRoute } = await import('../src/game/threats/StriderRoute');
  let routesOk = 0;
  const lens: number[] = [];
  for (let seed = 1; seed <= 20; seed++) {
    const terrain = new Terrain(makeProfile({ seed, size: 0.6 }));
    const macro = buildMacroPlan(terrain);
    const R = planStriderRoute(macro, terrain);
    if (!R) { check(false, `strider route: seed ${seed} has one`); continue; }
    const c0 = macro.centres[0];
    const straight = Math.hypot(R.end.x - R.start.x, R.end.z - R.start.z);
    const inDowntown = Math.hypot(R.end.x - c0.x, R.end.z - c0.z) < 250 || macro.cells.some((c) => c.district === 'downtown' && pointInPoly(c.poly, R.end.x, R.end.z));
    const ok = terrain.isWater(R.start.x, R.start.z, 2) && inDowntown && R.onArterials >= R.length * 0.75 && R.length >= 300 && R.length <= Math.max(2500, straight * 2.6) && R.landS < 200;
    if (ok) routesOk++;
    else check(false, `strider route: seed ${seed}: start in water ${terrain.isWater(R.start.x, R.start.z, 2)}, ends downtown ${inDowntown}, ${Math.round(R.onArterials)} of ${Math.round(R.length)} m on arterials (straight ${Math.round(straight)} m), lands at ${Math.round(R.landS)} m`);
    lens.push(Math.round(R.length));
  }
  check(routesOk === 20, `strider route: river to downtown along the arterials for 20 seeds (${routesOk}/20)`);
  const tA = new Terrain(makeProfile({ seed: 5, size: 0.6 })), tB = new Terrain(makeProfile({ seed: 5, size: 0.6 }));
  const rA = planStriderRoute(buildMacroPlan(tA), tA), rB = planStriderRoute(buildMacroPlan(tB), tB);
  check(!!rA && !!rB && hashPlan(rA.pts) === hashPlan(rB.pts), 'strider route: deterministic per seed');
  console.log(`strider routes (20 seeds, size 0.6): ${lens.join(' ')} m`);

  // The army (Phase B stage 2): the headless "no player" battle — the Strider along this city's route
  // against the response's levels 3 and 4 — deterministic per seed, the army wins in 25–55 % of runs.
  {
    const { simulateBattle, levelSquads, hitChance, pickZone, hurtUnit, makeUnit, makeSquad, moraleStep, ARMY, FORCE } = await import('../src/game/response/forces/BattleModel');
    const { STRIDER, STRIDER_ZONES } = await import('../src/game/threats/Strider');
    const { Rng } = await import('../src/core/rng');
    const spec = { ...STRIDER, zones: STRIDER_ZONES } as unknown as Parameters<typeof simulateBattle>[0];
    const t0 = performance.now();
    let wins = 0, runs = 0, nondet = 0, overBudget = 0, defeated = 0;
    const lost: Record<string, number> = {};
    for (let seed = 1; seed <= 50; seed++) {
      const terrain = new Terrain(makeProfile({ seed, size: 0.6 }));
      const R = planStriderRoute(buildMacroPlan(terrain), terrain);
      if (!R) continue;
      const a = simulateBattle(spec, R, seed * 7919 + 13);
      runs++;
      if (a.winner === 'army') wins++;
      if (a.outcome === 'defeated') defeated++;
      for (const [k, v] of Object.entries(a.lost)) lost[k] = (lost[k] ?? 0) + v;
      const P = a.peak;
      if ((P.truck ?? 0) + (P.apc ?? 0) + (P.tank ?? 0) > ARMY.maxVehicles || (P.rifles ?? 0) > ARMY.maxSoldiers || (P.heli ?? 0) > ARMY.maxHelis || (P.jet ?? 0) > ARMY.maxJets) overBudget++;
      if (seed <= 8) { const b = simulateBattle(spec, R, seed * 7919 + 13); if (b.hash !== a.hash || b.winner !== a.winner || b.t !== a.t) nondet++; }
    }
    check(nondet === 0, `army battle: deterministic per seed (8 seeds run twice, ${nondet} differ)`);
    check(runs === 50 && wins >= 0.25 * runs && wins <= 0.55 * runs, `army battle: the army drives the Strider off / brings it down in 25–55 % of 50 runs without the player (${wins}/${runs})`);
    check(overBudget === 0, `army battle: units on the field within the budgets (vehicles ≤ ${ARMY.maxVehicles}, soldiers ≤ ${ARMY.maxSoldiers}, helicopters ≤ ${ARMY.maxHelis}, jets ≤ ${ARMY.maxJets}; ${overBudget} runs over)`);
    console.log(`army battle (50 seeds, no player): army wins ${wins}/${runs} (${defeated} brought down), losses ${JSON.stringify(lost)}, ${Math.round(performance.now() - t0)} ms`);
    // What a level sends fits the budgets on its own, too.
    const l3 = levelSquads(3, () => ({ x: 0, z: 0 })), l4 = levelSquads(4, () => ({ x: 0, z: 0 }));
    const all = [...l3, ...l4].flatMap((q) => q.units);
    const veh = all.filter((u) => u.kind === 'truck' || u.kind === 'apc' || u.kind === 'tank').length;
    const sol = all.filter((u) => u.kind === 'rifles').reduce((n, u) => n + u.crew, 0);
    check(veh <= ARMY.maxVehicles && sol <= ARMY.maxSoldiers && all.filter((u) => u.kind === 'heli').length <= ARMY.maxHelis && all.filter((u) => u.kind === 'jet').length <= ARMY.maxJets,
      `army: levels 3 + 4 send ${veh} vehicles, ${sol} soldiers, ${all.filter((u) => u.kind === 'heli').length} helicopters, ${all.filter((u) => u.kind === 'jet').length} jets (within the budgets)`);
    // Fire and morale rules.
    const W = FORCE.tank.weapon!;
    check(hitChance(W, 100, 1) > hitChance(W, 800, 1) && hitChance(W, 300, 1) > hitChance(W, 300, 0.2), 'army: hit chance falls off with range and when shaken');
    const zr = new Rng(5);
    const zsT = STRIDER_ZONES.map((z) => ({ ...z, exposed: z.id === 'throat' }));
    let throat = 0, throatNoLos = 0;
    for (let i = 0; i < 2000; i++) { if (pickZone(zr, zsT, true, 0.5)?.id === 'throat') throat++; if (pickZone(zr, zsT, false, 0.5)?.id === 'throat') throatNoLos++; }
    check(throat > 900 && throatNoLos < 300, `army: an exposed weak spot is hit when aimed at with line of sight (${throat}/2000), rarely without (${throatNoLos}/2000)`);
    const u = makeUnit('rifles', 'q', 0, 0, 1, 0), q = makeSquad('q', 'rifles', 3, [u]);
    const hr = new Rng(9);
    for (let i = 0; i < 12 && q.morale >= ARMY.breakAt; i++) hurtUnit(u, q, 260, hr);
    check(u.crew < 6 && u.crew > 0 && q.morale < ARMY.breakAt && moraleStep(q, 0.5) !== 'ok', `army: losses drop a squad's morale until the line breaks (${u.crew} left, morale ${q.morale.toFixed(2)})`);
  }

  // Fame (game/fame): the press, fans and protesters by the reputation; the statue voted, built,
  // unveiled and pulled down; the justice layer's manhunt at the bottom.
  {
    const { FAME, StatueClock, pressCount, protestSize, remarkKind, tvCrew } = await import('../src/game/fame/fameRules');
    check(pressCount(FAME.pressAt - 1) === 0 && pressCount(FAME.pressAt) === 1 && pressCount(100) === 3 && !tvCrew(FAME.tvAt - 1) && tvCrew(FAME.tvAt),
      'fame: no press below the threshold, one photographer at it, three for a city hero; a TV crew from its own threshold');
    check(protestSize(0) === 0 && protestSize(-1) === 3 && protestSize(-50) > protestSize(-10) && protestSize(-100) === 12 && remarkKind(50) === 'hail' && remarkKind(-5) === 'boo' && remarkKind(10) === null,
      `fame: protests only below 0, bigger the more hated (${protestSize(-1)}, ${protestSize(-50)}, ${protestSize(-100)}); passers-by hail a hero, boo a hated one`);
    const run = (C: InstanceType<typeof StatueClock>, secs: number, rep: number) => { const out: string[] = []; for (let t = 0; t < secs; t += 0.5) { const x = C.step(0.5, rep); if (x) out.push(x); } return out; };
    const C = new StatueClock();
    const a = [...run(C, FAME.statueHold - 5, 90), ...run(C, 10, 70), ...run(C, FAME.statueHold + 1, 90)];
    const b = run(C, FAME.buildT + 1, 60);
    const c = [...run(C, FAME.toppleHold - 5, -10), ...run(C, 10, 5), ...run(C, FAME.toppleHold + 1, -10)];
    check(a.join() === 'voted' && b.join() === 'unveiled' && C.stats.unveiled === 1 && c.join() === 'toppled' && C.state === 'toppled',
      `fame: the statue is voted only after the reputation held high, built, unveiled, and pulled down only after it held below 0 (${[...a, ...b, ...c].join(' → ')})`);
    const D = new StatueClock();
    run(D, FAME.statueHold + 1, 90);
    const d = run(D, FAME.toppleHold + 1, -20);
    const E = new StatueClock();
    E.restore(JSON.parse(JSON.stringify(C.serialize())));
    E.restore({ state: 'bogus', t: 'x' });
    check(d.join() === 'cancelled' && D.state === 'none' && E.state === 'none' && run(C, FAME.statueHold + 1, 95).join() === 'voted',
      'fame: a statue being built for a hero who falls from grace is called off; a pulled-down one is rebuilt when the city loves them again; bad saves are ignored');
  }

  // The army against a rampaging giant player (PLAYGROUND_PLAN decision 19): the warning sequence,
  // standing down, a relapse; the army ringing a giant, following one who walks off, wearing a
  // passive one down in a bounded time.
  {
    const { RAMPAGE, RampageWatch, furyOf, furyScale, ladderTop, simulatePlayerBattle, playerPath, playerSpawn } = await import('../src/game/threats/rampageRules');
    const { ARMY } = await import('../src/game/response/forces/BattleModel');
    const run = (W: InstanceType<typeof RampageWatch>, secs: number, perS: number, height = 20, rep = -60) => {
      const out: string[] = [];
      for (let t = 0; t < secs; t += 0.5) { const s = W.step(0.5, perS * 0.5, height, rep); if (s) out.push(s); }
      return out;
    };
    const collapse = furyOf({ target: 'building', effect: 'collapse', size: 6 });
    check(collapse > furyOf({ target: 'building', effect: 'facade' }) && furyOf({ target: 'person', effect: 'knockdown', role: 'criminal' }) === 0 && furyOf({ target: 'person', effect: 'knockdown', role: 'soldier' }) > furyOf({ target: 'person', effect: 'knockdown' }),
      'rampage: fury counts buildings brought down most, officers and soldiers more than bystanders, criminals not at all');
    // A feared giant levelling a block a few seconds: warned, warned again, then the army.
    const W1 = new RampageWatch();
    const seq = run(W1, 120, 0.5);
    check(seq[0] === 'warn' && seq[1] === 'final' && seq[2] === 'hostile' && W1.state === 'hostile', `rampage: warning, final warning, then the army (${seq.join(' → ')})`);
    const tHostile = (() => { const W = new RampageWatch(); for (let t = 0; t < 200; t += 0.5) if (W.step(0.5, 0.25, 20, -60) === 'hostile') return t; return -1; })();
    check(tHostile >= RAMPAGE.gap * 2, `rampage: never hostile before both warnings had their time (${tHostile} s ≥ ${RAMPAGE.gap * 2} s)`);
    // Not for a player the city does not fear, of any size; a feared human-sized one is warned too
    // (and gets the police, SWAT and the Guard at most); the lower the reputation, the sooner.
    const small = run(new RampageWatch(), 120, 0.5, 1.8);
    check(run(new RampageWatch(), 120, 0.5, 20, 10).length === 0 && run(new RampageWatch(), 120, 0.5, 1.8, -10).length === 0, 'rampage: no warnings for a player with a decent reputation, giant or not');
    check(small[0] === 'warn' && small.includes('hostile') && ladderTop(1.8) === 3 && ladderTop(20) === 5, `rampage: a feared human-sized player is warned and then hunted, up to the National Guard (${small.join(' → ')})`);
    const firstWarn = (rep: number) => { const W = new RampageWatch(); for (let t = 0; t < 200; t += 0.5) if (W.step(0.5, 0.1, 1.8, rep) === 'warn') return t; return -1; };
    check(furyScale(RAMPAGE.rep) === 1 && Math.abs(furyScale(-100) - RAMPAGE.lowScale) < 1e-9 && firstWarn(-95) > 0 && firstWarn(-95) < firstWarn(-45), `rampage: the lower the reputation, the less destruction brings the warnings (${firstWarn(-95)} s at −95, ${firstWarn(-45)} s at −45)`);
    // Stopping after the first warning: the warnings lapse, no army.
    const W2 = new RampageWatch();
    const s2 = [...run(W2, 6, 2, 20, RAMPAGE.rep), ...run(W2, 200, 0, 20, RAMPAGE.rep)];
    check(s2[0] === 'warn' && s2.includes('lapse') && !s2.includes('hostile') && W2.state === 'calm', `rampage: stopping after a warning lets it lapse (${s2.join(' → ')})`);
    // Hostile, then standing down: quiet for a while, or human-sized again.
    const W3 = new RampageWatch();
    run(W3, 120, 0.5);
    const s3 = run(W3, 200, 0);
    const W4 = new RampageWatch();
    run(W4, 120, 0.5);
    const early = run(W4, RAMPAGE.minHostile - 90, 0, 1.8);
    const s4 = run(W4, 160, 0.5, 1.8);
    // (Shrinking stands down a giant's rampage only: a human-sized one has to stop.)
    const W4b = new RampageWatch();
    run(W4b, 120, 0.5, 1.8);
    run(W4b, RAMPAGE.minHostile - 90, 0.2, 1.8);
    const s4b = run(W4b, 160, 0.2, 1.8);
    check(s3.includes('standDown') && W3.state === 'calm' && s4.includes('standDown') && !s4b.includes('standDown'), 'rampage: standing down ends it (no destruction for a while, or a giant human-sized again)');
    check(early.length === 0, `rampage: once mobilised the army keeps at it for ${RAMPAGE.minHostile} s at least (the Guard and the tanks get there)`);
    // A relapse soon after: the army comes back without new warnings; much later, warnings again.
    const r1 = run(W3, 30, 0.6);
    check(r1[0] === 'hostile' && !r1.includes('warn'), `rampage: a relapse soon after brings the army back at once (${r1.join(' → ')})`);
    const W5 = new RampageWatch();
    run(W5, 120, 0.5); run(W5, 200, 0); run(W5, RAMPAGE.memory + 10, 0);
    check(run(W5, 30, 0.6)[0] === 'warn', 'rampage: long after, the warnings come again first');
    // Taken into custody: a clean slate — rampaging again straight away is warned first.
    const W6 = new RampageWatch();
    run(W6, 120, 0.5); W6.served();
    check(run(W6, 30, 0.6)[0] === 'warn', 'rampage: after custody, the warnings come again first');
    // The army's route for the player ends where they stand; units come from the city's side.
    const path = { pts: [] as number[], s: [] as number[], length: 0, start: { x: 0, z: 0 }, end: { x: 0, z: 0 } };
    playerPath(path, 0, 0, 300, 400);
    playerPath(path, 0, 0, 0.2, 0);
    const sp = playerSpawn(-1000, 0, 0, 0, 3);
    check(path.pts.length === 4 && path.end.x === 0.2 && path.length >= 1000 && Math.abs(Math.hypot(sp.x, sp.z) - RAMPAGE.spawnR) < 1e-6 && sp.x < 0, 'rampage: the army plans to the player (route ends at them, ≥ 1 km) and comes in from the city side');
    // The battle model against a giant standing still: ringed, worn down in a bounded time (level 3 alone: much longer).
    const t0 = performance.now();
    const ko: number[] = [];
    let nondet = 0, ringed = 0, over = 0, ground = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const a = simulatePlayerBattle(seed);
      ko.push(a.koT);
      if (a.nearest >= 150 && a.farthest <= 450) ringed++;
      const tot = Object.values(a.dealtBy).reduce((x, y) => x + y, 0);
      if (((a.dealtBy.rifles ?? 0) + (a.dealtBy.apc ?? 0) + (a.dealtBy.tank ?? 0)) >= 0.35 * tot) ground++;
      const P = a.peak;
      if ((P.truck ?? 0) + (P.apc ?? 0) + (P.tank ?? 0) > ARMY.maxVehicles || (P.rifles ?? 0) > ARMY.maxSoldiers || (P.heli ?? 0) > ARMY.maxHelis) over++;
      if (seed <= 3 && simulatePlayerBattle(seed).hash !== a.hash) nondet++;
    }
    const l3 = simulatePlayerBattle(7, { l4At: 1e9, maxT: 900 });
    check(nondet === 0 && over === 0, `rampage battle: deterministic per seed, within the budgets (${nondet} differ, ${over} over)`);
    check(ko.every((t) => t >= 60 && t <= 240) && (l3.koT < 0 || l3.koT > 2 * Math.max(...ko)), `rampage battle: a giant standing still goes down at level 4 in 60–240 s (${ko.join(', ')} s), at level 3 alone far later (${l3.koT} s)`);
    check(ringed >= 8, `rampage battle: units hold a ring round the giant out of its reach (${ringed}/10)`);
    check(ground >= 8, `rampage battle: the Guard and the tanks get there and do a good share of the fighting, not just the air (${ground}/10)`);
    const w = simulatePlayerBattle(9, { walk: 5, maxT: 500, hp: 1e9 });
    const still = simulatePlayerBattle(9, { maxT: 500, hp: 1e9 });
    check(w.late >= 0.25 * still.late, `rampage battle: the army follows a giant walking off at 5 m/s — its ground forces keep firing, if less (${w.late} vs ${still.late} on one standing still)`);
    console.log(`rampage battle (10 seeds): KO at ${ko.join(' ')} s, level 3 alone ${l3.koT} s, ${Math.round(performance.now() - t0)} ms`);
  }

  // Rig math.
  const { twoBone, follow, reach, lengths, layStraight } = await import('../src/game/threats/rig/chain');
  const { rayCapsule, capsuleDist } = await import('../src/game/threats/rig/CreatureRig');
  let seedR = 99;
  const rr = () => { seedR = (seedR * 1103515245 + 12345) & 0x7fffffff; return seedR / 0x7fffffff; };
  let ikBad = 0, ikFar = 0;
  for (let k = 0; k < 500; k++) {
    const a = 3 + rr() * 8, b = 3 + rr() * 8;
    const h = { x: rr() * 20 - 10, y: 10 + rr() * 10, z: rr() * 20 - 10 };
    const dir = { x: rr() - 0.5, y: -rr() - 0.05, z: rr() - 0.5 }, dl = Math.hypot(dir.x, dir.y, dir.z);
    const d = (Math.abs(a - b) + 0.05) + rr() * (a + b - Math.abs(a - b) - 0.1);
    const f = { x: h.x + dir.x / dl * d, y: h.y + dir.y / dl * d, z: h.z + dir.z / dl * d };
    const knee = { x: 0, y: 0, z: 0 }, foot = { x: 0, y: 0, z: 0 };
    const ok = twoBone(h, f, a, b, { x: 1, y: 0.2, z: 0 }, knee, foot);
    const e1 = Math.abs(Math.hypot(knee.x - h.x, knee.y - h.y, knee.z - h.z) - a), e2 = Math.abs(Math.hypot(foot.x - knee.x, foot.y - knee.y, foot.z - knee.z) - b);
    if (!ok || e1 > 1e-6 || e2 > 1e-6 || Math.hypot(foot.x - f.x, foot.y - f.y, foot.z - f.z) > 1e-6) ikBad++;
    // Out of reach: straight towards the target, as far as the bones go.
    const far = { x: h.x + dir.x / dl * (a + b + 5), y: h.y + dir.y / dl * (a + b + 5), z: h.z + dir.z / dl * (a + b + 5) };
    const ok2 = twoBone(h, far, a, b, { x: 1, y: 0.2, z: 0 }, knee, foot);
    if (ok2 || Math.abs(Math.hypot(foot.x - h.x, foot.y - h.y, foot.z - h.z) - (a + b)) > 1e-4) ikFar++;
  }
  check(ikBad === 0, `rig: two-bone IK reaches reachable targets with exact bone lengths (${ikBad}/500 off)`);
  check(ikFar === 0, `rig: two-bone IK stretches straight towards targets out of reach (${ikFar}/500 off)`);
  const lens0 = [7, 7, 6.5, 6, 5.5, 5, 4.5, 4, 3.5];
  const chain = new Float64Array((lens0.length + 1) * 3);
  layStraight(chain, lens0, 0, 15, 0, 0, 0, 1);
  let spacing = 0;
  for (let k = 0; k < 400; k++) {
    chain[0] += Math.sin(k * 0.05) * 1.5; chain[2] -= 1.2; chain[1] = 15 + Math.sin(k * 0.1) * 3;
    follow(chain, lens0, 0.3, () => 1);
    const L = lengths(chain);
    for (let i = 0; i < L.length; i++) spacing = Math.max(spacing, Math.abs(L[i] - lens0[i]));
  }
  check(spacing < 1e-9, `rig: follow-the-leader keeps every segment's length (worst ${spacing.toExponential(1)} m)`);
  const nl = [5, 5, 4.5];
  const neck = new Float64Array(4 * 3);
  layStraight(neck, nl, 0, 20, 0, 0, 0, -1);
  let fabrikBad = 0;
  for (let k = 0; k < 200; k++) {
    const tx = rr() * 16 - 8, ty = 20 + rr() * 8, tz = -rr() * 10;
    const miss = reach(neck, nl, tx, ty, tz, 8);
    const dT = Math.hypot(tx, ty - 20, tz);
    const L = lengths(neck);
    if ((dT > 8 && dT < 13.5 && miss > 0.05) || neck[0] !== 0 || neck[1] !== 20 || neck[2] !== 0 || L.some((l, i) => Math.abs(l - nl[i]) > 1e-6)) fabrikBad++;
  }
  check(fabrikBad === 0, `rig: FABRIK reaches targets at a neck's working reach, root fixed, lengths kept (${fabrikBad}/200 off)`);
  const cap = { ax: 0, ay: 0, az: 0, bx: 0, by: 10, bz: 0, r: 2, zone: 'x' };
  const tHit = rayCapsule(-20, 5, 0, 1, 0, 0, cap, 100), tEnd = rayCapsule(0, 30, 0, 0, -1, 0, cap, 100), tMiss = rayCapsule(-20, 5, 3, 1, 0, 0, cap, 100);
  check(Math.abs(tHit - 18) < 1e-6 && Math.abs(tEnd - 18) < 1e-6 && tMiss === Infinity && Math.abs(capsuleDist(5, 5, 0, cap) - 3) < 1e-9, `rig: ray vs capsule (${tHit}, ${tEnd}, ${tMiss})`);

  // The creature's skinned body (rig/skin.ts): closed surfaces, sane weights, poses that stay closed.
  {
    const THREE = await import('three');
    const { STRIDER_RIG } = await import('../src/game/threats/Strider');
    const { CreatureRig } = await import('../src/game/threats/rig/CreatureRig');
    const { boneLayout, buildCreatureSkin } = await import('../src/game/threats/rig/skin');
    const L = boneLayout(STRIDER_RIG);
    const rig = new CreatureRig(STRIDER_RIG);
    rig.still = true; rig.place();
    for (let i = 0; i < 90; i++) rig.update(0.05, 0);
    const bind = new Float32Array(L.count * 16);
    rig.boneFrames(bind, L);
    const sk = buildCreatureSkin(STRIDER_RIG, L, { frames: bind, spine: rig.spine, neck: rig.neck, tail: rig.tail, legs: rig.legs });
    const nV = sk.position.length / 3, nT = sk.index.length / 3;
    check(nV > 5000 && nV < 40000 && nT < 60000 && sk.parts.length >= 50, `skin: ${nV} vertices, ${nT} triangles, ${sk.parts.length} closed parts`);
    console.log(`creature skin (Strider): ${nV} vertices, ${nT} triangles, ${sk.parts.length} closed parts`);
    let nan = 0;
    for (const a of [sk.position, sk.normal, sk.uv, sk.color, sk.glow, sk.skinWeight]) for (const v of a) if (!Number.isFinite(v)) nan++;
    check(nan === 0, `skin: no NaN in any attribute (${nan})`);
    let wBad = 0, iBad = 0;
    for (let v = 0; v < nV; v++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const w = sk.skinWeight[v * 4 + k], b = sk.skinIndex[v * 4 + k];
        sum += w;
        if (b >= L.count || (w > 0 && b === 0)) iBad++;
      }
      if (Math.abs(sum - 1) > 1e-4) wBad++;
    }
    check(wBad === 0 && iBad === 0, `skin: weights sum to 1 (${wBad} off), bones in range and never the parameter bone (${iBad} off)`);
    // Watertight, consistently wound, outward (positive volume): every part, so no pose shows a hole.
    const volumes = (P: Float32Array) => sk.parts.map((part) => {
      let V = 0;
      for (let t = part.i0; t < part.i1; t += 3) {
        const a = sk.index[t] * 3, b = sk.index[t + 1] * 3, c = sk.index[t + 2] * 3;
        V += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
      }
      return V;
    });
    let open = 0;
    for (const part of sk.parts) {
      const id = new Map<string, number>();
      const weld = (v: number) => { const k = `${Math.round(sk.position[v * 3] * 1e4)},${Math.round(sk.position[v * 3 + 1] * 1e4)},${Math.round(sk.position[v * 3 + 2] * 1e4)}`; let i = id.get(k); if (i === undefined) { i = id.size; id.set(k, i); } return i; };
      const edges = new Map<string, number>();
      for (let t = part.i0; t < part.i1; t += 3) {
        const a = weld(sk.index[t]), b = weld(sk.index[t + 1]), c = weld(sk.index[t + 2]);
        for (const [x, y] of [[a, b], [b, c], [c, a]]) if (x !== y) edges.set(`${x}>${y}`, (edges.get(`${x}>${y}`) ?? 0) + 1);
      }
      for (const [k, n] of edges) { const [x, y] = k.split('>'); if (n !== 1 || edges.get(`${y}>${x}`) !== 1) { open++; break; } }
    }
    const v0 = volumes(sk.position);
    check(open === 0 && v0.every((v) => v > 0), `skin: every part is closed with one winding and faces out (${open} open, ${v0.filter((v) => !(v > 0)).length} inside-out)`);
    // Linear blend skinning on the CPU (as the GPU does): the bind pose gives the mesh back; poses keep every part closed and the right way out.
    const inv = Array.from({ length: L.count }, (_, b) => new THREE.Matrix4().fromArray(bind, b * 16).invert());
    const F = new Float32Array(L.count * 16), out = new Float32Array(sk.position.length), M = new THREE.Matrix4(), p = new THREE.Vector3(), acc = new THREE.Vector3();
    const skinned = () => {
      const B = inv.map((iv, b) => b === 0 ? new THREE.Matrix4() : new THREE.Matrix4().fromArray(F, b * 16).multiply(iv));
      for (let v = 0; v < nV; v++) {
        acc.set(0, 0, 0);
        for (let k = 0; k < 4; k++) {
          const w = sk.skinWeight[v * 4 + k];
          if (!w) continue;
          M.copy(B[sk.skinIndex[v * 4 + k]]);
          p.fromArray(sk.position, v * 3).applyMatrix4(M);
          acc.addScaledVector(p, w);
        }
        acc.toArray(out, v * 3);
      }
      return out;
    };
    rig.boneFrames(F, L);
    let err = 0;
    const o0 = skinned();
    for (let i = 0; i < o0.length; i++) err = Math.max(err, Math.abs(o0[i] - sk.position[i]));
    check(err < 1e-3, `skin: the bind pose reproduces the mesh (worst ${err.toExponential(1)} m)`);
    const poses: [string, () => void][] = [
      ['walking', () => { rig.still = false; for (let i = 0; i < 120; i++) { rig.z -= 0.25; rig.update(1 / 30, 0.25); } }],
      ['rearing, jaw open', () => { rig.rear = 1; rig.jaw = 1; for (let i = 0; i < 60; i++) rig.update(1 / 30, 0); }],
      ['tail swept, looking up', () => { rig.rear = 0; rig.sweep = 1; rig.lookW = 1; rig.look.x = rig.x + 30; rig.look.y = 90; rig.look.z = rig.z - 20; for (let i = 0; i < 60; i++) rig.update(1 / 30, 0); }],
      ['swept the other way, turning', () => { rig.sweep = -1; for (let i = 0; i < 60; i++) { rig.yaw += 0.02; rig.z -= 0.2; rig.update(1 / 30, 0.2); } }],
      ['collapsed', () => { rig.sweep = 0; rig.lookW = 0; rig.slump = 1; for (let i = 0; i < 90; i++) rig.update(1 / 30, 0); }],
    ];
    for (const [name, pose] of poses) {
      pose();
      rig.boneFrames(F, L);
      const P = skinned();
      let bad = 0;
      for (const v of P) if (!Number.isFinite(v)) bad++;
      const vs = volumes(P);
      const flipped = vs.filter((v, i) => !(v > 0) || v < v0[i] * 0.4 || v > v0[i] * 2.5).length;
      check(bad === 0 && flipped === 0, `skin: ${name}: finite, every part still out-facing with its volume (${bad} NaN, ${flipped} parts off)`);
    }
  }
}

{
  // Weather (src/world/weather.ts): deterministic per seed, mostly fair, storms rare, fog in the
  // mornings, and continuous (no jumps in clouds, rain, fog or light).
  const { WeatherSchedule, WEATHER_KINDS, stepWet } = await import('../src/world/weather');
  const coast = { coastal: true, warmth: 0.3 }, inland = { coastal: false, warmth: 0.7 };
  {
    const a = new WeatherSchedule(42, coast), b = new WeatherSchedule(42, coast), far = new WeatherSchedule(42, coast), other = new WeatherSchedule(43, coast);
    far.at(24 * 90); // queried far ahead first: the past must not change
    let same = true, diff = 0;
    for (let h = 0; h < 24 * 30; h += 0.37) {
      const pa = a.at(h), pb = b.at(h), pf = far.at(h);
      if (a.kindAt(h) !== b.kindAt(h) || a.kindAt(h) !== far.kindAt(h) || pa.rain !== pb.rain || pa.cover !== pf.cover) same = false;
      if (a.kindAt(h) !== other.kindAt(h)) diff++;
    }
    check(same, 'weather: the schedule is deterministic per seed (and independent of the query order)');
    check(diff > 300, `weather: another seed gives other weather (${diff} of ${Math.ceil(24 * 30 / 0.37)} samples differ)`);
  }
  for (const [name, cl] of [['coastal', coast], ['inland', inland]] as const) {
    const n: Record<string, number> = {};
    let total = 0, fogMorning = 0, stormAfternoon = 0;
    for (const seed of [1, 7, 42, 99]) {
      const s = new WeatherSchedule(seed, cl);
      for (let h = 0; h < 24 * 200; h += 0.1) {
        const k = s.kindAt(h), hr = h % 24;
        n[k] = (n[k] ?? 0) + 1; total++;
        if (k === 'fog' && hr >= 3 && hr < 11.5) fogMorning++;
        if (k === 'storm' && hr >= 11.5 && hr < 21) stormAfternoon++;
      }
    }
    const f = (k: string) => (n[k] ?? 0) / total;
    const shares = WEATHER_KINDS.map((k) => `${k} ${(f(k) * 100).toFixed(1)}%`).join(', ');
    check(f('clear') + f('fair') > 0.5 && f('fair') > f('cloudy') && f('fair') > f('clear'), `weather ${name}: sunny with clouds most of the time (${shares})`);
    check(f('storm') > 0.001 && f('storm') < 0.025, `weather ${name}: thunderstorms rare (${(f('storm') * 100).toFixed(2)}%), mostly in the afternoon (${((stormAfternoon / Math.max(1, n.storm ?? 0)) * 100).toFixed(0)}%)`);
    check(stormAfternoon / Math.max(1, n.storm ?? 0) > 0.75, `weather ${name}: storms mostly between 11:30 and 21:00`);
    const wet = f('drizzle') + f('rain') + f('storm');
    check(wet > 0.03 && wet < 0.2, `weather ${name}: some rain, not too much (${(wet * 100).toFixed(1)}%)`);
    check(f('fog') > 0.002 && fogMorning / Math.max(1, n.fog ?? 0) > 0.95, `weather ${name}: fog now and then (${(f('fog') * 100).toFixed(1)}%), in the mornings (${((fogMorning / Math.max(1, n.fog ?? 0)) * 100).toFixed(0)}% between 3 and 11:30)`);
  }
  {
    // Continuity: the largest change per game second over 20 days, every parameter.
    const s = new WeatherSchedule(7, coast);
    const keys = ['cover', 'density', 'dark', 'rain', 'fog', 'wind', 'sun', 'lightning'] as const;
    const worst: Record<string, number> = {};
    let prev = { ...s.at(0) };
    for (let h = 1 / 3600; h < 24 * 20; h += 1 / 3600) {
      const p = s.at(h);
      for (const k of keys) worst[k] = Math.max(worst[k] ?? 0, Math.abs(p[k] - prev[k]));
      prev = { ...p };
    }
    const max = Math.max(...keys.map((k) => worst[k]));
    check(max < 0.01, `weather: continuous — largest change per game second ${max.toFixed(4)} (${keys.map((k) => `${k} ${worst[k].toFixed(4)}`).join(', ')})`);
    // Rain only from a covered sky; transitions take game minutes.
    let rainClear = 0;
    for (let h = 0; h < 24 * 20; h += 0.05) { const p = s.at(h); if (p.rain > 0.05 && p.cover < 0.6) rainClear++; }
    check(rainClear === 0, `weather: no rain from a clear sky (${rainClear} samples)`);
    // Wet streets: soaked within ~15 minutes of rain, dry again within ~3 hours of sun.
    let w = 0, t = 0;
    while (w < 0.9 && t < 2) { w = stepWet(w, 0.62, 0.1, 1 / 60); t += 1 / 60; }
    let t2 = 0;
    while (w > 0.02 && t2 < 10) { w = stepWet(w, 0, 1, 1 / 60); t2 += 1 / 60; }
    check(t < 0.25 && t2 > 0.5 && t2 < 3, `weather: streets wet after ${(t * 60).toFixed(0)} min of rain, dry ${(t2 * 60).toFixed(0)} min after it stops`);
  }
}

// ------------------------------------------------------------------ the aftermath (src/game/aftermath): casualty ledger, the last
// resort's trigger and shock wave, the carcass cleanup schedule — pure rules
{
  console.log('aftermath: casualty ledger, last resort, shock wave, carcass removal');
  const { CasualtyLedger, strikeCasualties } = await import('../src/game/aftermath/Casualties');
  const { LAST_RESORT, lastResortDue, lastResortRoll, ShockWave, CARCASS, carcassStage, removalOrder, boneScales } = await import('../src/game/aftermath/rules');
  const { STRIDER_RIG, CUT_LAYOUT } = await import('../src/game/threats/Strider');
  // Ledger: a random run of events keeps the rules (never negative, the waiting only fall by a rescue, nobody counted dead).
  const L = new CasualtyLedger();
  let lr = 4242, bad = 0, digs = 0, treats = 0, mine = 0;
  const lrnd = () => { lr = (lr * 1103515245 + 12345) & 0x7fffffff; return lr / 0x7fffffff; };
  for (let i = 0; i < 4000; i++) {
    const r = lrnd(), before = { ...L.c };
    if (r < 0.2) L.injure(1 + Math.floor(lrnd() * 3));
    else if (r < 0.35) L.trap(1);
    else if (r < 0.4) L.evacuate(Math.floor(lrnd() * 40));
    else if (r < 0.7) { const p = lrnd() < 0.5; if (L.dig(p)) { digs++; if (p) mine++; } }
    else { const p = lrnd() < 0.3; if (L.treat(p)) { treats++; if (p) mine++; } }
    const c = L.c;
    if (c.injured < 0 || c.trapped < 0 || c.rescued < 0 || c.evacuated < before.evacuated || c.rescued < before.rescued) bad++;
    if (c.trapped < before.trapped && c.rescued !== before.rescued + 1) bad++;
    if (c.injured < before.injured && c.rescued !== before.rescued + 1) bad++;
  }
  check(bad === 0 && L.c.rescued === digs + treats && L.c.byPlayer === mine && !('dead' in L.c) && !('killed' in L.c), `casualty ledger: the rules hold over 4000 events (${JSON.stringify(L.c)}, ${bad} broken)`);
  const waiting = L.c.injured + L.c.trapped, rescued0 = L.c.rescued;
  check(L.settle() === waiting && L.c.injured === 0 && L.c.trapped === 0 && L.c.rescued === rescued0 + waiting && !L.dig(true) && !L.treat(true), 'casualty ledger: the crews settle everyone still waiting; nothing to dig or treat after');
  const L2 = new CasualtyLedger();
  L2.restore(JSON.parse(JSON.stringify(L.serialize())));
  const L3 = new CasualtyLedger();
  L3.restore({ evacuated: -3, injured: 2.9, trapped: 'x', rescued: Infinity, byPlayer: 4 });
  check(JSON.stringify(L2.c) === JSON.stringify(L.c) && L3.c.evacuated === 0 && L3.c.injured === 2 && L3.c.trapped === 0 && L3.c.rescued === 0 && L3.c.byPlayer === 4, `casualty ledger: saved and restored (sanitised: ${JSON.stringify(L3.c)})`);
  const sc = strikeCasualties(37);
  check(sc.trapped + sc.injured === 37 && sc.trapped > 0 && sc.injured > 0 && Object.keys(sc).length === 2, `casualty ledger: people left in a struck district are trapped or injured, never dead (${JSON.stringify(sc)})`);
  // The last resort: deterministic, only deep in the city with the army failing, rare and tunable.
  const base = { major: true, level: 4, levelT: 90, strength: 0.7, downtown: true, progress: 1, broken: 2, lost: 3, roll: 0.1, setting: 'normal' as 'off' | 'rare' | 'normal' | 'frequent' };
  const due = (o: Partial<typeof base> & { forced?: boolean }) => lastResortDue({ ...base, ...o });
  check(due({}) && due({}) === due({}), 'last resort: due deep in the city with the army failing (deterministic)');
  check(!due({ level: 3 }) && !due({ major: false }) && !due({ roll: 0.9 }) && !due({ strength: 0.3 }) && !due({ downtown: false, progress: 0.5 }) && !due({ broken: 0, lost: 0 }) && !due({ levelT: 20 }) && !due({ setting: 'off' }),
    'last resort: not below level 4, not for a minor threat, not past the roll, not with the monster nearly beaten, not before it is deep in the city, not while the army holds, not before level 4 has fought a while, never with city events off');
  check(due({ broken: 0, lost: 0, levelT: LAST_RESORT.timeout }) && due({ downtown: false, progress: LAST_RESORT.deep }) && due({ broken: 0, lost: LAST_RESORT.lost }), 'last resort: the army failing — lines broken, units lost or no result for too long');
  check(due({ forced: true, roll: 0.99, strength: 0.1, downtown: false, progress: 0, broken: 0, lost: 0, levelT: 0 }) && !due({ forced: true, level: 3 }), 'last resort: dev can force it at level 4 (not below)');
  let under = 0, same = 0;
  for (let id = 1; id <= 2000; id++) { const r = lastResortRoll(42, id); if (r < LAST_RESORT.chance) under++; if (r === lastResortRoll(42, id)) same++; }
  check(same === 2000 && Math.abs(under / 2000 - LAST_RESORT.chance) < 0.04 && !due({ roll: LAST_RESORT.chance * 0.6, setting: 'rare' }) && due({ roll: LAST_RESORT.chance * 1.2, setting: 'frequent' }),
    `last resort: the roll is seeded per incident and comes up ~${Math.round(LAST_RESORT.chance * 100)} % (× the setting) (${(under / 20).toFixed(1)} %)`);
  // The shock wave levels everything in range, nearest first, never more than its budget a frame, never before the front.
  const dists: number[] = [];
  for (let i = 0; i < 260; i++) dists.push(lrnd() * LAST_RESORT.radius);
  const W = new ShockWave(dists);
  let early = 0, over = 0, out = 0, last = -1, order = 0, t = 0;
  while (!W.done && t < 60) { const got = W.step(1 / 60); t += 1 / 60; if (got.length > LAST_RESORT.perFrame) over++; for (const k of got) { out++; if (dists[k] > W.front + 1e-9) early++; if (dists[k] < last) order++; last = dists[k]; } }
  const tMax = LAST_RESORT.radius / LAST_RESORT.shockSpeed + dists.length / LAST_RESORT.perFrame / 60 + 0.1;
  check(out === dists.length && early === 0 && over === 0 && order === 0 && t <= tMax, `last resort: the shock wave levels all ${dists.length} buildings nearest first within the budget (${t.toFixed(2)} s ≤ ${tMax.toFixed(2)} s)`);
  // The carcass: a landmark first, then carted away piece by piece, tail tip first, trunk last.
  check(carcassStage(0).stage === 'landmark' && carcassStage(CARCASS.landmarkH - 0.01).removed === 0 && carcassStage(CARCASS.landmarkH + CARCASS.cleanupH / 2).stage === 'cleanup'
    && Math.abs(carcassStage(CARCASS.landmarkH + CARCASS.cleanupH / 2).removed - 0.5) < 1e-9 && carcassStage(CARCASS.landmarkH + CARCASS.cleanupH).stage === 'gone', 'carcass: landmark, cleanup, gone on schedule');
  let mono = true, prev = 0;
  for (let h = 0; h < 20; h += 0.05) { const r = carcassStage(h).removed; if (r < prev) mono = false; prev = r; }
  const ord = removalOrder(CUT_LAYOUT, { tail: STRIDER_RIG.tail.length, neck: STRIDER_RIG.neck.length, spine: STRIDER_RIG.spine.length, legs: STRIDER_RIG.legs.length });
  const want = STRIDER_RIG.tail.length + 2 + STRIDER_RIG.neck.length + STRIDER_RIG.legs.length * 3 + STRIDER_RIG.spine.length;
  check(mono && ord.length === want && new Set(ord).size === want && ord[0] === CUT_LAYOUT.tail + STRIDER_RIG.tail.length - 1 && ord[want - 1] === CUT_LAYOUT.spine && ord.every((b) => b > 0 && b < CUT_LAYOUT.count),
    `carcass: ${want} pieces, every bone once, the tail tip first and the trunk last`);
  const sA = new Float32Array(CUT_LAYOUT.count), sB = new Float32Array(CUT_LAYOUT.count);
  let scaleBad = 0;
  boneScales(0, ord, sA);
  if (sA.some((v) => v !== 1)) scaleBad++;
  for (let r = 0.01; r <= 1.0001; r += 0.01) {
    boneScales(r, ord, sB);
    let partial = 0;
    for (let b = 0; b < sB.length; b++) { if (sB[b] > sA[b] + 1e-6) scaleBad++; if (sB[b] > 0 && sB[b] < 1) partial++; }
    if (partial > 1) scaleBad++;
    sA.set(sB);
  }
  boneScales(1, ord, sB);
  check(scaleBad === 0 && ord.every((b) => sB[b] === 0) && sB[0] === 1, `carcass: pieces only ever shrink, one at a time, all gone at the end (${scaleBad} faults)`);
}

// ------------------------------------------------------------------ saves (src/game/save)
{
  console.log('saves: model round trip, migrations, damage codec');
  const full: SaveData = {
    v: SAVE_VERSION, id: 'save-abc', name: 'Before the bridge', kind: 'manual', created: 1759580000000, playTime: 3725,
    city: { seed: 42, size: 0.6 }, mode: 'normal',
    character: { id: 'gen-123', look: { appearance: { gender: 0.3 }, outfit: { top: 'jacket' } } },
    player: { x: 123.456, y: 7.25, z: -98.5, yaw: 1.25, height: 12.5, sizeOverride: true, flying: true, under: false, indoors: false, hp: 63.5, invulnerable: true, energy: 42.5, slot: 3 },
    camera: { yaw: -2.5, pitch: -0.35, zoom: 4.2 },
    sky: { day: 3, hour: 18.75, timeScale: 60 },
    weather: { setting: 'rain', wet: 0.62, skipH: 1.5 },
    progress: { v: 1, karma: 140, earned: 320, deeds: 17, ranks: { laser: 2, flight: 1 }, slots: ['punch', 'laser', null, null, null, null, null, null, null, null], cores: [3, 9], seen: [3, 9, 11], bonusMax: 20, bonusRegen: 1.5 },
    reputation: { v: 37.5, stats: { stopped: 4, kos: 2, arrests: 1, returned: 3, deeds: 9, hurt: 1, busted: 0 } },
    justice: { heat: 3.2, wanted: 1, stats: { offences: 3, arrests: 0, turnIns: 1, escapes: 2 } },
    threats: {
      clock: { v: 1, played: 5400, pressure: 7300, n: 2, lastAt: 4100, lastP: 5000, last: 'robots', armedAt: null, omensDone: 0, karma: 320, majors: 0, lastMajorAt: 0, armedMajor: false },
      setting: 'frequent', remains: [{ kind: 'strider', x: 410.5, z: -220.25, yaw: 0.75, side: -1, s: 812, downAt: 98.25, cleared: 0.375 }], strider: { s: 455.5, hp: 3800, mode: 'advance', level: 4 },
    },
    waypoint: { x: -500, z: 260.5 },
    settings: { crime: 'chaos', events: 'frequent' },
    damage: { cells: [{ id: 17, n: 50000, dead: encodeIndexSet([5, 6, 7, 900]), glass: encodeIndexSet([12, 13]), slabs: encodeIndexSet([7]) }], buildings: [[17, 4, -1], [17, 9, 31.5]], mounds: [[401.25, -230.5, 14.5, 6.25]] },
    aftermath: {
      ledger: { evacuated: 1240, injured: 3, trapped: 2, rescued: 17, byPlayer: 6 },
      zones: [[120.5, -64.25, 380, 96.5]], smoke: [[118, -60, 2.5, 120.25], [410, -221, 1, 104]], cordons: [[405.5, -218, 42, 106.5]],
      memorials: [[398.25, -190.5, 1.5, 99]], news: { kind: 'lost', until: 104.5 },
    },
    slimes: { trust: { v: 42.5, gifts: [0, 2], marks: ['heart'] }, war: { v: 1, murk: 0.5, lumen: 0.625, front: 0.25, at: 130.5, nextRaid: 133, mawBack: 0, raid: null, captives: [2, 4, 0], nextBreach: 150, stats: { won: 3, lost: 1, kills: 12, freed: 4, maw: 0, breaches: 0 } } },
    factions: { turf: { v: 1, groups: [{ archetype: 'gang', cells: [[4, -14], [5, -7]] }], stats: { stopped: 1, tags: 2 } }, tags: [{ x: 10.5, y: 1.45, z: -3.25, nx: 0, nz: 1, archetype: 'gang', seed: 77 }], hideouts: [{ archetype: 'gang', door: [12.5, -4, 0, 1], cell: 4, found: true, bustedUntil: 80.5, moves: 1 }], bosses: [{ archetype: 'gang', name: 'Rook Malone', jailedUntil: 90, beaten: 2, escapes: 1, jailed: 1, notoriety: 40 }] },
  };
  const back = parseSave(serializeSave(full));
  check(JSON.stringify(back) === JSON.stringify(full), `saves: serialize → parse round trip keeps every field${JSON.stringify(back) === JSON.stringify(full) ? '' : `\n${serializeSave(back)}\n${serializeSave(full)}`}`);
  // Every top-level and player field present after parsing (nothing silently dropped).
  const keys = (o: object) => Object.keys(o).sort().join(',');
  check(keys(back) === keys(full) && keys(back.player) === keys(full.player) && keys(back.threats) === keys(full.threats) && keys(back.aftermath!) === keys(full.aftermath!) && keys(back.threats.remains[0]) === keys(full.threats.remains[0]), 'saves: all fields survive parsing');
  // A version-1 save (before the aftermath): migrates with no aftermath; its bodies count from the load, nothing cleared.
  const v1 = JSON.parse(serializeSave(full)) as Record<string, unknown>;
  v1.v = 1; delete v1.aftermath;
  for (const b of (v1.threats as { remains: Record<string, unknown>[] }).remains) { delete b.downAt; delete b.cleared; }
  const up1 = parseSave(v1);
  check(up1.v === SAVE_VERSION && up1.aftermath === null && up1.threats.remains[0].downAt === -1 && up1.threats.remains[0].cleared === 0,
    `saves: a version-1 save migrates (aftermath ${JSON.stringify(up1.aftermath)}, body ${JSON.stringify(up1.threats.remains[0])})`);
  // A version-2 save (before the slimes): migrates with none (the city's stored trust and war stay).
  const v2 = JSON.parse(serializeSave(full)) as Record<string, unknown>;
  v2.v = 2; delete v2.slimes;
  const up2 = parseSave(v2);
  check(up2.v === SAVE_VERSION && up2.slimes === null && up2.aftermath !== null, `saves: a version-2 save migrates (slimes ${JSON.stringify(up2.slimes)})`);
  // A version-3 save (before the villain groups): migrates with the seeded turf and no tags.
  const v3 = JSON.parse(serializeSave(full)) as Record<string, unknown>;
  v3.v = 3; delete v3.factions;
  const up3 = parseSave(v3);
  check(up3.v === SAVE_VERSION && up3.factions === null && up3.slimes !== null, `saves: a version-3 save migrates (factions ${JSON.stringify(up3.factions)})`);
  // The aftermath is sanitised: garbage rows dropped, counts whole and ≥ 0, the level-5 countdown never comes back (level ≤ 4).
  const junk = parseSave({ ...JSON.parse(serializeSave(full)), aftermath: { ledger: { evacuated: -5, injured: 'x', trapped: 2.7 }, zones: [[1, 2, 3], 'z', [1, 2, 3, NaN], [5, 6, 7, 8]], news: { kind: 7 } }, threats: { ...full.threats, strider: { s: 10, hp: 50, mode: 'rampage', level: 5 } } });
  check(junk.aftermath!.ledger.evacuated === 0 && junk.aftermath!.ledger.injured === 0 && junk.aftermath!.ledger.trapped === 2 && junk.aftermath!.zones.length === 1 && junk.aftermath!.news === null && junk.aftermath!.smoke.length === 0 && junk.threats.strider!.level === 4,
    `saves: the aftermath is sanitised (${JSON.stringify(junk.aftermath)}, level ${junk.threats.strider?.level})`);
  // Garbage and partial saves load with defaults (no throw), a city is required, newer versions are refused.
  const partial = parseSave({ v: 1, city: { seed: 7, size: 0.4 }, player: { x: 'nope', hp: 1e9 }, sky: { hour: 99 }, damage: { cells: [{ id: 'x' }, { id: 3, dead: 5 }], buildings: [[1, 2], [1, 2, 3]] } });
  check(partial.player.x === 0 && partial.sky.hour < 24 && partial.player.height === 1.8 && partial.mode === 'normal' && partial.damage!.cells.length === 1 && partial.damage!.cells[0].dead === '' && partial.damage!.buildings.length === 1,
    `saves: a partial / damaged save is sanitised to defaults (${JSON.stringify({ x: partial.player.x, hour: partial.sky.hour, cells: partial.damage?.cells.length })})`);
  let threw = 0;
  try { parseSave({ v: 1, player: {} }); } catch { threw++; }
  try { parseSave({ v: SAVE_VERSION + 1, city: { seed: 1, size: 0.5 } }); } catch { threw++; }
  check(threw === 2, 'saves: no city / a newer version is refused');
  // Migration stub: a version-0 save (flat fields) upgrades to the current version.
  const v0 = { v: 0, id: 'old', name: 'Old', seed: 99, size: 0.3, mode: 'sandbox', pos: [10, 2, -4], yaw: 0.5, height: 3, hp: 80, day: 2, hour: 7.5, timeScale: 20 };
  const m = migrate(v0), up = parseSave(v0);
  check(m.v === SAVE_VERSION && up.city.seed === 99 && up.city.size === 0.3 && up.mode === 'sandbox' && up.player.x === 10 && up.player.z === -4 && up.player.height === 3 && up.sky.day === 2 && up.sky.hour === 7.5,
    `saves: version 0 migrates to ${SAVE_VERSION} (${JSON.stringify({ seed: up.city.seed, x: up.player.x, day: up.sky.day })})`);
  // Save files: a save written to a file reads back unchanged (gzip and plain), the same file always gets
  // the same id of its own, an old save in a file migrates, and junk / foreign JSON / newer saves are refused.
  {
    const { encodeSaveFile, decodeSaveFile, importedId, saveFileName } = await import('../src/game/save/files');
    const meta = { id: full.id, name: full.name, kind: full.kind, seed: full.city.seed, size: full.city.size, mode: full.mode, city: 'Lindenford', day: 2, hour: 18.75, created: full.created, playTime: full.playTime, karma: 12, thumb: 'data:image/jpeg;base64,AAAA' };
    const blob = await encodeSaveFile(full, meta);
    const bytes = await blob.arrayBuffer(), u = new Uint8Array(bytes);
    const back2 = await decodeSaveFile(bytes);
    const plain = await decodeSaveFile(new TextEncoder().encode(serializeSave(full)).buffer as ArrayBuffer);
    check(u[0] === 0x1f && u[1] === 0x8b && JSON.stringify(back2.data) === JSON.stringify(full) && back2.meta?.thumb === meta.thumb && back2.meta?.karma === 12 && JSON.stringify(plain.data) === JSON.stringify(full) && plain.meta === null,
      `save files: round trip (gzip ${u[0] === 0x1f}, ${bytes.byteLength} B of ${serializeSave(full).length})`);
    check(importedId(back2.data) === importedId(full) && importedId(full).startsWith('file-') && importedId({ ...full, created: full.created + 1 }) !== importedId(full), `save files: own stable id (${importedId(full)})`);
    const oldFile = await decodeSaveFile(new TextEncoder().encode(JSON.stringify({ scale: 'save', meta: null, data: { v: 0, id: 'old', name: 'Old', seed: 99, size: 0.3, mode: 'sandbox', pos: [10, 2, -4] } })).buffer as ArrayBuffer);
    check(oldFile.data.v === SAVE_VERSION && oldFile.data.city.seed === 99 && oldFile.data.player.x === 10, 'save files: an old save in a file migrates');
    const refused: string[] = [];
    const junks = ['hello', '{"a":1}', '[1,2]', JSON.stringify({ scale: 'save', data: { v: SAVE_VERSION + 1, city: { seed: 1, size: 0.5 } } })].map((t) => new TextEncoder().encode(t));
    junks.push(new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 4]));
    for (const junk of junks) {
      try { await decodeSaveFile(junk.buffer as ArrayBuffer); } catch (e) { refused.push((e as Error).message); }
    }
    check(refused.length === 5 && refused[3].includes('newer'), `save files: junk is refused with a message (${refused.join(' | ')})`);
    const fn1 = saveFileName('Port Haven', 'My: save/1', 2, 18.75), fn2 = saveFileName('Port Haven', 'Day 3 18:45', 2, 18.75);
    check(fn1 === 'Scale - Port Haven - My save1 - Day 3 18-45.scale' && fn2 === 'Scale - Port Haven - Day 3 18-45.scale', `save files: file names (${fn1} / ${fn2})`);
  }
  // Damage codec: index sets round trip (empty, single, runs, gaps, big indices, unsorted with duplicates).
  const sets: number[][] = [[], [0], [5], [0, 1, 2, 3], [1, 3, 5, 7], [100000, 100001, 4_000_000], [9, 3, 3, 4, 8, 2, 2]];
  let rng = 12345;
  const rnd = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  // A realistic damaged cell: 120 k elements, a few buildings with walls blown out (clustered) plus scattered panels.
  const cell = new Uint8Array(120000 * 2).fill(255);
  for (let b = 0; b < 6; b++) { const at = Math.floor(rnd() * 110000), n = 50 + Math.floor(rnd() * 600); for (let k = 0; k < n; k++) if (rnd() < 0.8) cell[(at + k) * 2] = 0; }
  for (let k = 0; k < 300; k++) cell[Math.floor(rnd() * 120000) * 2] = 0;
  for (let k = 0; k < 200; k++) cell[Math.floor(rnd() * 120000) * 2 + 1] = 0;
  const dead = lowIndices(cell, 120000, 2, 0), glass = lowIndices(cell, 120000, 2, 1);
  sets.push(dead, glass);
  let bad = 0;
  for (const set of sets) {
    const want = [...new Set(set)].sort((a, b) => a - b);
    const got = decodeIndexSet(encodeIndexSet(set));
    if (got.length !== want.length || got.some((v, i) => v !== want[i])) bad++;
  }
  const enc = encodeIndexSet(dead);
  check(bad === 0, `saves: damage index sets round trip (${sets.length} sets, ${bad} wrong)`);
  check(enc.length < dead.length * 1.5, `saves: a damaged cell compacts (${dead.length} dead of 120 k elements → ${enc.length} chars, ${glass.length} windows → ${encodeIndexSet(glass).length})`);
  check(decodeIndexSet('%%%').length === 0 && decodeIndexSet('').length === 0, 'saves: bad damage strings decode to nothing');
  // A restored cell equals the saved one (both channels).
  const restored = new Uint8Array(120000 * 2).fill(255);
  for (const e of decodeIndexSet(encodeIndexSet(dead))) restored[e * 2] = 0;
  for (const e of decodeIndexSet(encodeIndexSet(glass))) restored[e * 2 + 1] = 0;
  let diff = 0;
  for (let i = 0; i < cell.length; i++) if ((cell[i] < 128) !== (restored[i] < 128)) diff++;
  check(diff === 0, `saves: cell element state restored exactly (${diff} differences)`);
}

// ------------------------------------------------------------------ actors that cannot get anywhere; small arms
// (sim/actors/Actor watchProgress / pursue, crime/Firearms): running in place under an unreachable
// target counts as stuck, a pursuit re-plans once and then gives up; a goal flipping back and forth
// every frame (the old "move in / hold" flip at an incident) is caught too; guns stay weaker than powers.
{
  const act = makeActor('police', 0);
  const a = { x: 0, z: 0 };
  // Running hard at a point 10 m off without getting anywhere (blocked): stuck after the window.
  act.goal = { x: 10, z: 0 }; act.speed = 5.45;
  let t = 0;
  for (; t < 6 && act.stuckT <= 0; t += 1 / 60) watchProgress(a, act, 1 / 60);
  check(act.stuckT > 0 && Math.abs(t - STUCK.window) < 0.1, `actors: running in place is noticed after ${t.toFixed(2)} s (window ${STUCK.window} s)`);
  // A goal that flips between two points every frame (jitter on the spot): stuck as well.
  const b = makeActor('police', 0), pb = { x: 0, z: 0 };
  let flips = 0;
  for (t = 0; t < 6 && b.stuckT <= 0; t += 1 / 60) {
    b.goal = flips++ & 1 ? { x: 14, z: 0 } : { x: -30, z: 0 }; b.speed = 3.8;
    pb.x += (flips & 1 ? 0.05 : -0.05);
    watchProgress(pb, b, 1 / 60);
  }
  check(b.stuckT > 0, `actors: a goal flipping every frame (running in place) is caught (${t.toFixed(2)} s)`);
  // Real progress keeps it at zero; standing still (no goal) is never stuck.
  const c = makeActor('police', 0), pc = { x: 0, z: 0 };
  c.goal = { x: 100, z: 0 }; c.speed = 4;
  let worst = 0;
  for (t = 0; t < 10; t += 1 / 60) { pc.x += 4 / 60; worst = Math.max(worst, watchProgress(pc, c, 1 / 60)); }
  const d = makeActor('police', 0);
  for (t = 0; t < 10; t += 1 / 60) worst = Math.max(worst, watchProgress({ x: 0, z: 0 }, d, 1 / 60));
  check(worst === 0, 'actors: moving on, or standing still, is never stuck');
  // Pursuit: stuck → re-plan once → stuck again → give up (unreachable); a time cap gives up too.
  const e = makeActor('police', 0), pe = { x: 0, z: 0 };
  e.goal = { x: 20, z: 0 }; e.speed = 5;
  const steps: string[] = [];
  for (t = 0; t < 20; t += 1 / 60) {
    watchProgress(pe, e, 1 / 60);
    const r = pursue(e, 1 / 60);
    if (r !== 'go') steps.push(`${r}@${t.toFixed(1)}`);
    if (r === 'give_up') break;
  }
  check(steps.length === 2 && steps[0].startsWith('replan') && steps[1].startsWith('give_up'), `actors: an unreachable target is re-planned once, then given up (${steps.join(', ')})`);
  const f = makeActor('police', 0);
  let capped = '';
  for (t = 0; t < 40 && !capped; t += 0.1) if (pursue(f, 0.1, 30) === 'give_up') capped = t.toFixed(1);
  check(capped !== '' && Math.abs(+capped - 30) < 0.3, `actors: a pursuit gives up at its time cap (${capped} s)`);
  // Guns: a pair of officers brings a drone down in a few seconds; a robot takes them longer; a
  // robber's gun stings the player only a little; all well short of a power (one blow). Every
  // round fired hits (a clear line or no shot), so these are the plain rates.
  const droneS = Math.ceil(DRONE_PLATING / GUNS.pistol.drone) / hitRate(GUNS.pistol, 2);
  const robotS = 600 / (hitRate(GUNS.pistol, 2) * GUNS.pistol.machine);
  // (A robber fires every 2.6–4.4 s: GUNMAN.gap; officers at the player: their gap × POLICE.playerGapK 2.5.)
  const playerHp = GUNS.crook.player / 3.5;
  const copHp = hitRate(GUNS.pistol, 1) / 2.5 * GUNS.pistol.player, swatHp = hitRate(GUNS.rifle, 1) / 2.5 * GUNS.rifle.player;
  check(droneS > 2.5 && droneS < 6, `guns: two officers' pistols bring a hovering drone down in ${droneS.toFixed(1)} s (≈ 4)`);
  check(robotS > 8 && robotS < 14, `guns: two officers wear a rogue robot down in ${robotS.toFixed(1)} s (≈ 11)`);
  check(playerHp > 0.6 && playerHp < 1.5, `guns: an armed robber costs the player ${playerHp.toFixed(2)} hp/s (≈ 1; regen 7 hp/s out of a fight)`);
  check(copHp < 2.5 && swatHp < 2.5, `guns: an officer at wanted 3 costs the player ${copHp.toFixed(2)} hp/s, SWAT ${swatHp.toFixed(2)} hp/s`);
  check(GUNS.crook.player < 22 && GUNS.rifle.player * GUNS.rifle.burst < 22 && GUNS.pistol.player < 22, 'guns: no single trigger pull knocks the player down (HEALTH.knockAt 22)');
  console.log(`actors & guns: stuck after ${STUCK.window} s, drone ${droneS.toFixed(1)} s, robot ${robotS.toFixed(1)} s, robber ${playerHp.toFixed(2)} hp/s`);
}

// Background music: mood selection (src/audio/music/mood.ts) and the stem manifest (public/music).
{
  let seed = 12345;
  const rng = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const run = (d: MoodDirector, secs: number, s: Partial<MusicSignals> | ((t: number) => Partial<MusicSignals>)) => {
    const moods: (string | null)[] = [];
    for (let t = 0; t < secs; t += 0.1) moods.push(d.update(0.1, { ...CALM_SIGNALS, ...(typeof s === 'function' ? s(t) : s) }).mood);
    return moods;
  };
  const d = new MoodDirector(rng);
  const first = run(d, 60, {});
  check(first[0] === null && first.includes('day'), `music: silence at first, then a calm day episode (${first.indexOf('day') / 10} s)`);
  // Danger flapping in and out of range every 3 s: tension comes once and stays.
  const flap = run(d, 40, (t) => ({ danger: Math.floor(t / 3) % 2 === 0 ? 1 : 0 }));
  const firstT = flap.indexOf('tension');
  const changes = flap.slice(firstT).filter((m, i, a) => i > 0 && m !== a[i - 1]).length;
  check(firstT > 10 && firstT < 25 && changes === 0, `music: tension after ${firstT / 10} s and no flapping (${changes} changes)`);
  const calmAgain = run(d, 30, {});
  const off = calmAgain.findIndex((m) => m !== 'tension') / 10;
  check(off > MOOD_TUNING.tensionHold - 3 && off < MOOD_TUNING.tensionHold + 1, `music: tension holds ${off} s after the danger ends`);
  // The Strider: battle at once, an elegy after it when people wait for help.
  const war = run(d, 5, { battle: 1 });
  check(war.indexOf('battle') >= 0 && war.indexOf('battle') < 8, 'music: battle within a second');
  const after = run(d, 60, { grief: true });
  check(after.slice(0, 150).every((m) => m === 'battle') && after.includes('elegy'), `music: battle holds, then an elegy (${after.indexOf('elegy') / 10} s)`);
  // Night with hysteresis; underground after a short delay.
  const n = new MoodDirector(rng);
  n.play();
  check(run(n, 2, { night: 0.5 }).at(-1) === 'day' && run(n, 2, { night: 0.7 }).at(-1) === 'night' && run(n, 2, { night: 0.5 }).at(-1) === 'night' && run(n, 2, { night: 0.3 }).at(-1) === 'day', 'music: night comes and goes with hysteresis');
  check(run(n, 1, { under: true }).at(-1) === 'day' && run(n, 3, { under: true }).at(-1) === 'under', 'music: underground after a moment');
  check(run(n, 6, { flySpeed: 80 }).at(-1) === 'hero', 'music: flying fast');
  // Sparse: over an hour of calm, music plays only part of the time.
  const h = new MoodDirector(rng);
  const hour = run(h, 3600, (t) => ({ night: t > 1800 ? 1 : 0 }));
  const share = hour.filter((m) => m !== null).length / hour.length;
  check(share > 0.3 && share < 0.75, `music: calm music plays ${Math.round(share * 100)} % of the time`);
  // Manifest: every mood has a set, every file exists.
  const man = parseStemManifest(JSON.parse(readFileSync('public/music/manifest.json', 'utf8')));
  check(!!man && man.lead > 0, 'music: manifest parses');
  let files = 0;
  for (const m of MOODS) {
    const set = man?.sets[m];
    check(!!set, `music: a set for ${m}`);
    for (const list of Object.values(set?.layers ?? {})) for (const f of list ?? []) { files++; check(existsSync(`public/music/${f}`), `music: ${f} exists`); }
  }
  console.log(`music: ${MOODS.length} moods, ${files} stems, calm share ${Math.round(share * 100)} %`);
}

// ------------------------------------------------------------------ line of sight and shots (combat/los, combat/shot)
// One rule for everybody: buildings, terrain and cars block a line (people never do); a holed
// facade lets it through; a targeted shot without a clear line does not fire, with one it always
// hits; an untargeted one hits whatever is on its ray — the bystander behind a miss.
{
  const cacheT = LOS.cacheT;
  LOS.cacheT = 0;
  const box = { low: 0, top: 20 };
  const cars: LosCar[] = [];
  let hill = 0, holes = false;
  const world: LosWorld = {
    building: (x, z) => (x > 10 && x < 20 && z > -5 && z < 5 ? box : null),
    ground: (_x, z) => (z > 30 && z < 34 ? hill : 0),
    cars: (x0, z0, x1, z1, out) => { let n = 0; for (const c of cars) if (c.x > x0 - 3 && c.x < x1 + 3 && c.z > z0 - 3 && c.z < z1 + 3) out[n++] = c; return n; },
  };
  const holed: LosWorld = { ...world, panel: () => (holes ? Infinity : 0) };
  const los = new LineOfSight(world, () => 0), losH = new LineOfSight(holed, () => 0);
  const car = (kind: string, x: number, z: number): LosCar => ({ x, y: 0, z, yaw: 0, length: 4.5, width: 1.8, kind, state: 0, alive: true });
  // Open street.
  check(los.clear(0, 1.42, 0, 0, 1.25, 25), 'los: an open street is a clear line');
  // Buildings block; a line up over the roof to a drone does not touch it.
  check(!los.clear(0, 1.42, 0, 30, 1.25, 0) && los.last === 'building', `los: a building blocks the line (${los.last})`);
  check(los.clear(0, 1.42, 0, 30, 60, 0), 'los: a line over the roof (to a drone) is clear');
  // A hole blasted in the wall lets it through (no facade panel standing there); intact: blocked.
  holes = true;
  check(losH.clear(0, 5, 0, 30, 5, 0), 'los: a line through a holed facade is clear');
  holes = false;
  check(!losH.clear(0, 5, 0, 30, 5, 0), 'los: an intact facade blocks it');
  // Cars block at chest height (parked or moving: the same boxes); a line up to a drone passes over.
  cars.push(car('sedan', 0, 10));
  check(!los.clear(0, 1.42, 0, 0, 1.25, 20) && los.last === 'car', `los: a car in between blocks the line (${los.last})`);
  check(los.clear(0, 1.42, 0, 0, 12, 20), 'los: a line up over the car (to a drone) is clear');
  check(los.clear(0, 1.42, 0, 0, 1.25, 20, LOS.pad, cars[0]), "los: the shooter's own car (cover) does not block their line");
  check(los.clear(0, 1.42, 0, 0, 0.75, 10, 0.5), 'los: a car does not hide itself (it is the target)');
  check(los.clear(0, 1.42, -2, 3, 1.25, 20), 'los: a line past the car is clear');
  cars[0] = car('bus', 0, 10);
  check(!los.clear(0, 2.4, 0, 0, 2.4, 20), 'los: a bus stands taller than a car (blocks at 2.4 m)');
  cars[0] = car('sedan', 0, 10);
  check(los.clear(0, 2.4, 0, 0, 2.4, 20), 'los: …a sedan does not (1.5 m)');
  cars.length = 0;
  // Terrain: a bank of earth between.
  hill = 4;
  check(!los.clear(0, 1.42, 25, 0, 1.25, 40) && los.last === 'terrain', `los: a bank of earth blocks it (${los.last})`);
  hill = 0;
  // Shots. A target behind the building: no shot at all ('sight'); beyond reach: 'range'.
  type Body = { name: string; x: number; z: number };
  const target: Body = { name: 'target', x: 30, z: 0 }, bystander: Body = { name: 'bystander', x: 3, z: 25 }, inLine: Body = { name: 'in line', x: 0, z: 12 };
  const bodies: Body[] = [target, bystander, inLine];
  const trace: ShotTrace<Body> = {
    trace(ox, oy, oz, dx, dy, dz, maxT) {
      const wall = los.block(ox, oy, oz, ox + dx * maxT, oy + dy * maxT, oz + dz * maxT, 0);
      let best = Math.min(wall, maxT), hit: Body | null = null;
      for (const b of bodies) {
        const t = (b.x - ox) * dx + (b.z - oz) * dz;
        if (t <= 0 || t >= best) continue;
        const px = ox + dx * t - b.x, pz = oz + dz * t - b.z, y = oy + dy * t;
        if (Math.hypot(px, pz) < 0.4 && y > 0 && y < 1.8) { best = t; hit = b; }
      }
      return { t: hit || wall < maxT ? best : Infinity, body: hit };
    },
  };
  const out = newShot<Body>();
  resolveShot(los, trace, 0, 1.42, 0, { body: target, x: 30, y: 1.2, z: 0, pad: 0.45 }, 0, 0, 1, 60, out);
  check(!out.fired && out.why === 'sight', `shot: targeted without a line of sight does not fire (${out.fired} ${out.why})`);
  resolveShot(los, trace, 0, 1.42, 0, { body: target, x: 30, y: 1.2, z: 0, pad: 0.45 }, 0, 0, 1, 20, out);
  check(!out.fired && out.why === 'range', `shot: targeted beyond reach does not fire (${out.why})`);
  // A target out in the open with someone standing in the line: it fires and hits the target.
  target.x = 0; target.z = 25;
  resolveShot(los, trace, 0, 1.42, 0, { body: target, x: 0, y: 1.2, z: 25, pad: 0.45 }, 0, 0, 1, 60, out);
  check(out.fired && out.body === target, `shot: targeted with a clear line always hits the target (${out.body?.name})`);
  // Untargeted, aimed a little off the target: on along the ray into the bystander behind it.
  inLine.x = -5;
  const ax = 3, az = 25, al = Math.hypot(ax, az);
  resolveShot(los, trace, 0, 1.42, 0, null, ax / al, -0.17 / al, az / al, 60, out);
  check(out.fired && out.body === bystander, `shot: an untargeted miss hits the bystander behind (${out.body?.name ?? 'nothing'})`);
  // …and with nobody there it ends on the wall (a surface, no body).
  resolveShot(los, trace, 0, 1.42, 0, null, 1, 0, 0, 60, out);
  check(out.fired && out.body === null && Math.abs(out.t - 10) < 1.3, `shot: an untargeted shot into a wall stops there (${out.t.toFixed(1)} m)`);
  // Cost (no cache), and the cache.
  const t0 = performance.now();
  let n = 0;
  for (let k = 0; k < 2000; k++) { los.clear(Math.sin(k) * 30, 1.4, Math.cos(k) * 30, Math.cos(k) * 25, 1.2, Math.sin(k * 1.3) * 25); n++; }
  const per = (performance.now() - t0) / n;
  LOS.cacheT = cacheT;
  const lc = new LineOfSight(world, () => 1);
  for (let k = 0; k < 10; k++) lc.clear(0, 1.42, 0, 30, 1.25, 0);
  check(lc.stats.rays === 1 && lc.stats.cached === 9, `los: the same line is cached (${lc.stats.rays} traced, ${lc.stats.cached} cached)`);
  console.log(`line of sight: ${(per * 1000).toFixed(1)} µs a line (headless boxes)`);
}

// Street characters (game/street/cast.ts): sites clear of the walking corridors, footprints, doors and
// furniture; the cast deterministic, only in its hours, everyone turning up somewhere.
{
  const t0 = performance.now();
  const terrain = new Terrain(makeProfile({ seed: 42, size: 0.4 }));
  const macro = buildMacroPlan(terrain);
  const c0 = macro.centres[0];
  const cells = macro.cells.slice().sort((a, b) => Math.hypot(a.centroid[0] - c0.x, a.centroid[1] - c0.z) - Math.hypot(b.centroid[0] - c0.x, b.centroid[1] - c0.z)).slice(0, 40);
  const byKind = [0, 0, 0, 0];
  let n = 0, onFoot = 0, inWalk = 0, atDoor = 0, sameA = true, badHour = 0;
  const seen = new Set<StreetKind>();
  for (const c of cells) {
    const p = planCell(macro, c, terrain);
    const A = streetSites(p), B = streetSites(p);
    if (hashPlan(A) !== hashPlan(B)) sameA = false;
    for (const s of A) {
      n++; byKind[s.kind]++;
      if (p.buildings.some((b) => pointInPoly(b.poly, s.x, s.z))) onFoot++;
      if (!clearOfWalk(p.streets, s.x, s.z, 0.75)) inWalk++;
      if (p.buildings.some((b) => { const d = frontDoor(b); return Math.hypot(d.x - s.x, d.z - s.z) < 2.9; })) atDoor++;
      for (let h = 0; h < 48; h += SLOT_H) {
        const k = streetCast(42, s, c.district, h);
        const k2 = streetCast(42, s, c.district, h);
        if (JSON.stringify(k) !== JSON.stringify(k2)) sameA = false;
        if (!k) continue;
        seen.add(k.kind);
        if (!kindAt(k.kind, (k.slot + 0.5) * SLOT_H) || !STREET_KINDS[k.kind].sites.includes(s.kind) || h < k.from || h >= k.to) badHour++;
      }
    }
  }
  check(sameA, 'street: sites and cast deterministic');
  check(n > 40 && byKind[SiteKind.Plaza] + byKind[SiteKind.Park] > 3 && byKind[SiteKind.Sidewalk] > 10, `street: sites found (${n}: ${byKind.join(' plaza / park / metro / sidewalk ')})`);
  check(onFoot === 0 && inWalk === 0 && atDoor === 0, `street: sites off footprints (${onFoot}), clear of the walking corridor (${inWalk}) and doors (${atDoor})`);
  check(badHour === 0, `street: everyone cast within their hours and at their kind of site (${badHour} not)`);
  const missing = STREET_KIND_LIST.filter((k) => !seen.has(k));
  check(missing.length === 0, `street: every character turns up somewhere in two days (missing: ${missing.join(', ') || 'none'})`);
  check(kindAt('sleepwalker', 2) && !kindAt('sleepwalker', 14) && kindAt('busker', 21) && !kindAt('busker', 4) && kindAt('jogger', 7) && !kindAt('jogger', 12), 'street: day people by day, night people at night');
  const lines = allLines();
  check(lines.length > 150 && lines.every((l) => l.trim().length > 0 && !/undefined|NaN/.test(l)), `street: lines all there (${lines.length})`);
  check(STREET_KIND_LIST.every((k) => (['own', 'greet', 'panic', 'hit', 'leave', 'fly', 'giant'] as const).every((t) => !!lineFor(k, t, () => 0.5, 'X'))), 'street: every character has a line for every common moment');
  check(lineFor('tourist', 'greet', () => 0, 'Linden station')!.includes('Linden station'), 'street: places filled into the lines');
  console.log(`street: ${n} sites in ${cells.length} cells (${(performance.now() - t0).toFixed(0)} ms), ${seen.size} kinds cast`);
}

// Justice: wrecking buildings is not free (facade damage before witnesses; a collapse always known).
{
  let rep = 0, karma = 0, called = 0, witnesses = 0;
  const host = { time: 0, player: { x: 0, z: 0 }, witnesses: () => witnesses, officersNear: () => 0, karma: (n: number) => { karma += n; }, rep: (d: number) => { rep += d; }, repValue: () => rep, pursue: () => { called++; }, toast: () => {}, sound: () => {} };
  const J = new Justice(host);
  const e = (effect: HarmEntry['effect'], ref: object, size?: number, t = 0): HarmEntry => ({ cause: 'player', power: 'impact', target: 'building', effect, x: 0, z: 0, t, ref, size });
  const house = {}, tower = {};
  J.record(e('facade', house));
  const unseen = rep;
  witnesses = 3; host.time = 5;
  J.record(e('facade', house, undefined, 5));
  const seen = rep;
  J.record(e('collapse', house, 4, 5.5));
  const afterOne = rep;
  J.record(e('collapse', house, 4, 6));
  witnesses = 0; host.time = 20;
  J.record(e('collapse', tower, 12, 20));
  check(unseen === 0 && seen < 0 && afterOne < seen - 5 && rep < afterOne - 10 && karma < -30 && J.wanted >= 2 && called > 0 && J.stats.collapses === 2,
    `justice: unseen facade damage free, seen costs (${seen}), a collapse costs a lot and always counts (${afterOne.toFixed(1)}, then ${rep.toFixed(1)}, karma ${karma}, wanted ${J.wanted}), once per building`);
  const m = new Justice({ ...host, witnesses: () => 5 });
  m.record({ ...e('collapse', {}, 6), cause: 'threat' });
  check(m.stats.collapses === 0 && m.heat === 0, "justice: a monster's collapse is not booked to the player");
  // A manhunt for a public menace: an officer close by is enough (no offence), not for a merely disliked hero.
  let hunted = 0;
  const hunt = (repV: number) => { const H = new Justice({ ...host, time: 100, officersNear: () => 1, repValue: () => repV, pursue: () => { hunted++; } }); H.update(0.5); return H.wanted; };
  check(hunt(JUSTICE.manhunt - 5) === 1 && hunt(JUSTICE.manhunt + 15) === 0 && hunted > 0, 'justice: a public menace is hunted by the first officer who sees them; a disliked hero is not');
}

// Landmarks (plan/landmarks.ts, plan/landmarkParts.ts): deterministic; a town hall and a stadium in
// every city, 1–4 attractions by size, an airport only for big ones; sites clear of each other, of
// water, roads, buildings and sewer manholes, the structures inside their sites, no furniture on them;
// the airfield levelled, outside the city and free of forest; different from city to city.
{
  const t0 = performance.now();
  const sigs: string[] = [];
  const kinds = new Set<string>();
  const thLooks = new Set<string>();
  for (const [seed, size] of [[1, 0.1], [42, 0.4], [7, 0.7], [10, 0.2], [42, 0.6], [3, 0.5], [5, 0.3]] as const) {
    const at = `landmarks seed ${seed} size ${size}`;
    const terrain = new Terrain(makeProfile({ seed, size }));
    const macro = buildMacroPlan(terrain);
    const again = buildMacroPlan(new Terrain(makeProfile({ seed, size })));
    const L = macro.landmarks;
    check(hashPlan(L) === hashPlan(again.landmarks), `${at}: deterministic`);
    const R = terrain.profile.radius;
    const count = (k: string) => L.filter((l) => l.kind === k).length;
    check(count('townhall') === 1 && count('stadium') === 1, `${at}: a town hall and a stadium (${L.map((l) => l.kind).join(', ')})`);
    const nAttr = L.filter((l) => (ATTRACTION_KINDS as string[]).includes(l.kind)).length;
    check(nAttr >= 1 && nAttr <= 4 && nAttr >= (R >= 3200 ? 2 : 1), `${at}: ${nAttr} attractions for a ${terrain.profile.cls}`);
    check(count('airport') === (R >= AIRPORT_MIN_RADIUS ? 1 : 0), `${at}: airport only for big cities (${count('airport')}, radius ${R.toFixed(0)} m)`);
    for (const l of L) kinds.add(l.kind);
    sigs.push(L.map((l) => `${l.kind}${l.style}:${Object.values(l.p).map((v) => v.toFixed(1)).join('/')}`).join(' '));
    const th = L.find((l) => l.kind === 'townhall');
    if (th) thLooks.add(`${th.style}/${th.p.w}/${th.p.tower}/${th.p.wings}`);
    // Sites: apart, dry, inside their cells.
    let overlaps = 0, wet = 0, outside = 0;
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) if (intersection([L[i].site], [L[j].site]).length) overlaps++;
    for (const l of L) {
      if (l.cell < 0) continue;
      for (let i = 0; i < l.site.length; i += 2) if (!pointInPoly(macro.cells[l.cell].poly, l.site[i], l.site[i + 1])) outside++;
      for (let u = -1; u <= 1; u += 0.25) for (let v = -1; v <= 1; v += 0.25) {
        const [x, z] = siteToWorld(l, u * l.hu, v * l.hv);
        if (terrain.isWater(x, z)) wet++;
      }
    }
    check(overlaps === 0 && wet === 0 && outside === 0, `${at}: sites apart (${overlaps} overlaps), dry (${wet}) and inside their cells (${outside} corners out)`);
    // Sewer manholes (every 45 m along the trunks, as Underground lays them, on either side of the
    // trunk over its shaft) stay off the sites.
    let lids = 0;
    for (const sw of macro.sewers) {
      let acc = 0;
      for (let i = 0; i + 3 < sw.pts.length; i += 2) {
        const ax = sw.pts[i], az = sw.pts[i + 1], bx = sw.pts[i + 2], bz = sw.pts[i + 3], d = Math.hypot(bx - ax, bz - az);
        for (let s = Math.ceil((acc - 22.5) / 45) * 45 + 22.5; s < acc + d; s += 45) {
          const f = (s - acc) / d, x = ax + (bx - ax) * f, z = az + (bz - az) * f;
          const nx = -(bz - az) / d * LID_LAT, nz = (bx - ax) / d * LID_LAT;
          if (L.some((l) => inSite(l, x + nx, z + nz, 1) || inSite(l, x - nx, z - nz, 1))) lids++;
        }
        acc += d;
      }
    }
    check(lids === 0, `${at}: no sewer manhole on a landmark site (${lids})`);
    // The host cells: no street, sidewalk or building on the site, no furniture on the structure;
    // the structure inside its site, meshes for both LODs.
    let onRoad = 0, onBld = 0, onSolid = 0, partsOut = 0, meshes = 0;
    for (const l of L) {
      const parts = landmarkParts(l, terrain);
      for (const p of parts) {
        if (p.map === 5) continue; // the airport's access road
        const o = partOutline(p);
        if (o) for (let i = 0; i < o.length; i += 2) if (!inSite(l, o[i], o[i + 1], 1)) partsOut++;
      }
      const m0 = buildLandmarkMesh(l, terrain, 0).build(), m1 = buildLandmarkMesh(l, terrain, 1).build();
      if (m0.index.length > 0 && m1.index.length > 0 && m1.index.length <= m0.index.length) meshes++;
      if (l.cell < 0) continue;
      const cp = planCell(macro, macro.cells[l.cell], terrain);
      check(cp.landmarks.includes(l.id), `${at}: ${l.kind} known to its cell`);
      const solids = solidFootprints(l, parts, 0);
      for (let u = -1; u <= 1; u += 0.1) for (let v = -1; v <= 1; v += 0.1) {
        const [x, z] = siteToWorld(l, u * l.hu, v * l.hv);
        if ([...cp.carriageway, ...cp.sidewalks].some((s) => pointInPoly(s.outer, x, z) && !s.holes.some((h) => pointInPoly(h, x, z)))) onRoad++;
      }
      for (const b of cp.buildings) {
        let hit = false;
        for (let i = 0; i < b.poly.length && !hit; i += 2) hit = inSite(l, b.poly[i], b.poly[i + 1], -0.3);
        for (let i = 0; i < l.site.length && !hit; i += 2) hit = pointInPoly(b.poly, l.site[i], l.site[i + 1]);
        if (hit) onBld++;
      }
      for (let i = 0; i < cp.props.length; i += 6) {
        if (cp.props[i] === PropType.Manhole) continue;
        if (solids.some((q) => pointInPoly(q, cp.props[i + 1], cp.props[i + 2]))) onSolid++;
      }
    }
    check(onRoad === 0 && onBld === 0, `${at}: sites clear of streets and sidewalks (${onRoad} samples) and of buildings (${onBld})`);
    check(onSolid === 0, `${at}: no street furniture on a landmark (${onSolid})`);
    check(partsOut === 0, `${at}: every structure inside its site (${partsOut} points out)`);
    check(meshes === L.length, `${at}: near and far meshes for every landmark (${meshes} of ${L.length})`);
    // The airport: outside the city (and its protected terrain), level, without forest, a road into town.
    const ap = L.find((l) => l.kind === 'airport');
    if (ap) {
      const land = new LandUse(terrain), ls = newLandSample();
      let inCity = 0, lo = Infinity, hi = -Infinity, rural = 0;
      for (let u = -1; u <= 1; u += 0.1) for (let v = -1; v <= 1; v += 0.2) {
        const [x, z] = siteToWorld(ap, u * ap.hu, v * ap.hv);
        if (Math.hypot(x, z) < terrain.protectR) inCity++;
        const h = terrain.height(x, z);
        lo = Math.min(lo, h); hi = Math.max(hi, h);
        rural = Math.max(rural, land.sample(x, z, ls).rural);
      }
      check(inCity === 0, `${at}: airport outside the city's protected zone (${inCity} samples in)`);
      check(hi - lo < 0.01 && rural === 0, `${at}: airfield level (${(hi - lo).toFixed(3)} m) and free of forest and fields (rural ${rural.toFixed(2)})`);
      check(!!ap.road && ap.road.length >= 4, `${at}: a road from the airport into town`);
    }
  }
  check(new Set(sigs).size === sigs.length, `landmarks: every city's set is its own (${new Set(sigs).size} of ${sigs.length})`);
  check(thLooks.size >= 5, `landmarks: town halls differ (${thLooks.size} looks in ${sigs.length} cities)`);
  check([...ATTRACTION_KINDS].filter((k) => kinds.has(k)).length >= 5, `landmarks: varied attractions (${[...kinds].join(', ')})`);
  console.log(`landmarks: ${sigs.length} cities, kinds ${[...kinds].join(', ')} in ${(performance.now() - t0).toFixed(0)} ms`);
}

// Marvels (plan/marvelParts): every family builds for many seeds and city sizes (finite parts inside
// the site, near and far meshes within budget); the helix walkway can be walked from the street to
// the roof between its walls; a pierced slab's holes are open; more of them the bigger the city.
{
  const t0 = performance.now();
  const flat = { height: () => 0, isWater: () => false } as unknown as Terrain;
  const make = (style: MS, seed: number, R: number): Landmark | null => {
    const r = new MRng(seed * 977 + style);
    const d = marvelDesign(style, R)(r.fork('design'), 1);
    if (!d) return null;
    const lm: Landmark = { id: 0, kind: 'marvel', name: 'test', cell: 0, x: 100, z: -50, angle: 0.3 + seed, hu: d.hu, hv: d.hv, site: [], base: 0.15, low: 0, seed: r.nextU32(), style, p: d.p };
    lm.site = siteRect(lm, -lm.hu, -lm.hv, lm.hu, lm.hv);
    return lm;
  };
  let missing = 0, nan = 0, out = 0, empty = 0, maxTris = 0, farBig = 0, maxInner = 0;
  const looks = new Map<number, Set<string>>();
  for (let style = 0; style < MARVEL_STYLES; style++) for (let seed = 1; seed <= 6; seed++) for (const R of [1300, 3500, 9000]) {
    const lm = make(style as MS, seed, R);
    if (!lm) { missing++; continue; }
    const parts = landmarkParts(lm, flat);
    for (const p of parts) {
      const nums = [p.x, p.z, p.a, p.y0, p.y1, p.hx, p.hz, ...(p.pts ?? [])];
      if (nums.some((v) => !Number.isFinite(v))) nan++;
      const o = partOutline(p);
      if (o) for (let i = 0; i < o.length; i += 2) if (!inSite(lm, o[i], o[i + 1], 1)) out++;
    }
    const m0 = buildLandmarkMesh(lm, flat, 0).build(), m1 = buildLandmarkMesh(lm, flat, 1).build();
    if (!m0.index.length || !m1.index.length) empty++;
    if (m1.index.length > m0.index.length) farBig++;
    maxTris = Math.max(maxTris, m0.index.length / 3);
    if (parts.some((p) => p.inner)) maxInner = Math.max(maxInner, buildLandmarkMesh(lm, flat, 0, false, undefined, true).build().index.length / 3);
    if (!looks.has(style)) looks.set(style, new Set());
    looks.get(style)!.add(Object.values(lm.p).map((v) => v.toFixed(1)).join('/'));
  }
  check(missing === 0 && nan === 0, `marvels: every family designs and builds (${missing} missing, ${nan} non-finite parts)`);
  check(out === 0, `marvels: structures inside their sites (${out} points out)`);
  check(empty === 0 && farBig === 0 && maxTris < 60000, `marvels: near and far meshes (${empty} empty, ${farBig} far bigger), at most ${(maxTris / 1000).toFixed(1)}k triangles`);
  check(maxInner < 150000, `marvels: insides (drawn close by only) at most ${(maxInner / 1000).toFixed(1)}k triangles`);
  check([...looks.values()].every((v) => v.size >= 6), `marvels: each family differs from seed to seed (${[...looks.values()].map((v) => v.size).join(', ')} looks from 6 seeds × 3 sizes)`);
  // The helix: up the walkway from its foot to the roof, on its floor all the way, never inside a wall.
  {
    const lm = make(MS.Helix, 3, 5000)!;
    const solids = new LandmarkSolids({ landmarks: [lm] } as unknown as MacroPlan, flat);
    const hp = landmarkParts(lm, flat).find((p) => p.k === PK.Helix && !p.clear)!;
    const full = Math.abs(hp.turns!) * Math.PI * 2, sg = hp.turns! < 0 ? -1 : 1, rm = (hp.r! + hp.r2!) / 2;
    let y = hp.y0, off = 0, blocked = 0, steps = 0;
    for (let phi = 0; phi <= full; phi += 0.4 / rm) {
      const th = hp.a + sg * phi, x = hp.x + Math.cos(th) * rm, z = hp.z + Math.sin(th) * rm;
      const g = solids.topAt(x, z, y, 0.5);
      if (Math.abs(g - helixFloorAt(hp, phi)) > 0.35) off++;
      if (g > -Infinity) y = g;
      solids.provider(x - 0.3, z - 0.3, x + 0.3, z + 0.3, (o) => {
        if (o.y1 - o.y0 < 0.72 || y >= o.y1 - 0.5 || y + 1.8 <= o.y0) return;
        const dx = x - o.x, dz = z - o.z;
        if (o.cyl ? Math.hypot(dx, dz) < o.r + 0.3 : Math.abs(dx * o.ux + dz * o.uz) < o.hx + 0.3 && Math.abs(-dx * o.uz + dz * o.ux) < o.hz + 0.3) blocked++;
      });
      steps++;
    }
    const roof = solids.topAt(hp.x, hp.z, y, 0.5);
    check(off === 0 && blocked === 0 && Math.abs(y - hp.y1) < 0.4 && Math.abs(roof - hp.y1) < 0.1,
      `marvels: the helix walks from ${hp.y0.toFixed(1)} up to the roof at ${hp.y1.toFixed(1)} m (ended at ${y.toFixed(1)}, ${off} of ${steps} steps off the floor, ${blocked} blocked, roof ${roof.toFixed(1)})`);
    // Its glass wall: one cannot step off the walkway.
    const th = hp.a + sg * full * 0.5, fy = helixFloorAt(hp, full * 0.5), ex = hp.x + Math.cos(th) * (hp.r2! + 0.2), ez = hp.z + Math.sin(th) * (hp.r2! + 0.2);
    check(solids.hit(hp.x + Math.cos(th) * (hp.r2! - 0.05), fy + 1, hp.z + Math.sin(th) * (hp.r2! - 0.05)) && !solids.hit(ex, fy + 1, ez), 'marvels: the helix walkway has a wall outside');
  }
  // A pierced slab: the holes are open, the slab around them solid.
  {
    const lm = make(MS.Porous, 2, 5000)!;
    const solids = new LandmarkSolids({ landmarks: [lm] } as unknown as MacroPlan, flat);
    const slab = landmarkParts(lm, flat).find((p) => p.k === PK.Perf)!;
    const H = slab.pts!, c = Math.cos(slab.a), s2 = Math.sin(slab.a);
    let open = 0, solid = 0;
    for (let i = 0; i < H.length; i += 3) {
      const x = slab.x + H[i] * c, z = slab.z + H[i] * s2;
      if (!solids.hit(x, H[i + 1], z)) open++;
      if (solids.hit(x, H[i + 1] + H[i + 2] + 1, z) || H[i + 1] + H[i + 2] + 1 > slab.y1) solid++;
    }
    check(H.length >= 9 && open === H.length / 3 && solid === H.length / 3, `marvels: a slab's ${H.length / 3} holes open (${open}) in solid walls (${solid})`);
    check(partObstacles([slab]).length > H.length / 3, 'marvels: the pierced slab collides as pieces round its holes');
  }
  // How many: often none in a town, more the bigger the city.
  const mean = (R: number) => { let n = 0, mx = 0; for (let i = 0; i < 400; i++) { const c = marvelCount(R, new MRng(i * 31 + 7)); n += c; mx = Math.max(mx, c); } return [n / 400, mx]; };
  const [town, townMax] = mean(1200), [city] = mean(3000), [metro] = mean(6000), [mega, megaMax] = mean(12000);
  check(town < city && city < metro && metro < mega && townMax <= 1 && megaMax <= 3 && town > 0.15 && town < 0.45,
    `marvels: more in bigger cities (town ${town.toFixed(2)}, city ${city.toFixed(2)}, metropolis ${metro.toFixed(2)}, megacity ${mega.toFixed(2)})`);
  console.log(`marvels: ${MARVEL_STYLES} families checked in ${(performance.now() - t0).toFixed(0)} ms`);
}

// Breakable marvels (build/landmarkDice, destruction/LandmarkWreck): meshes diced into pieces that
// all three meshes agree on; a hit breaks what it reaches, a few broken pieces don't bring it down,
// a cut-through level drops everything above (it falls, lands and leaves rubble), collision follows
// and a save brings the same state back.
{
  const t0 = performance.now();
  const flat = { height: () => 0, isWater: () => false } as unknown as Terrain;
  const noop = new Proxy({}, { get: () => () => undefined }) as never;
  const facade = { albedo: null, normal: null, tileMeters: [] } as unknown as MaterialArrays;
  const geo = (m: MeshData) => {
    const g = new THREE.BufferGeometry();
    for (const k in m.attrs) g.setAttribute(k, new THREE.BufferAttribute(m.attrs[k].array, m.attrs[k].size, m.attrs[k].normalized));
    g.setIndex(new THREE.BufferAttribute(m.index, 1));
    return g;
  };
  let badElem = 0, unnamed = 0;
  const results: string[] = [];
  for (const [style, name] of [[MS.Starship, 'starship'], [MS.Helix, 'helix'], [MS.Orbs, 'orbs']] as const) {
    const r = new MRng(3 * 977 + style);
    const d = marvelDesign(style, 6000)(r.fork('design'), 1)!;
    const lm: Landmark = { id: 0, kind: 'marvel', name: 'test', cell: 0, x: 100, z: -50, angle: 0.3, hu: d.hu, hv: d.hv, site: [], base: 0.15, low: 0, seed: r.nextU32(), style, p: d.p };
    lm.site = siteRect(lm, -lm.hu, -lm.hv, lm.hu, lm.hv);
    const data = (): LandmarkWreckData => {
      const b = buildLandmarkMeshes(lm, flat);
      const n = b.pieces!.length / PIECE_STRIDE;
      const meshes = [b.near.build(), b.far.build(), ...(b.glass ? [b.glass[0].build(), b.glass[1].build()] : [])];
      meshes.forEach((m, i) => {
        const e = m.attrs.aElem.array;
        for (let v = 0; v < e.length; v++) { if (e[v] > n || e[v] < 0) badElem++; if (i !== 1 && i !== 3 && e[v] === 0) unnamed++; }
      });
      const W = 1024, H = Math.ceil((n + 1) / W), ed = new Uint8Array(W * H * 2).fill(255);
      const near = new THREE.Mesh(geo(meshes[0])), glass = b.glass ? new THREE.Mesh(geo(meshes[2])) : null;
      near.position.set(...meshes[0].origin);
      if (glass) glass.position.set(...meshes[2].origin);
      return { index: 0, lm, grid: b.grid!, pieces: b.pieces!, elemData: ed, elemTex: new THREE.DataTexture(ed, W, H), elemW: W, near, nearGlass: glass, facadeMat: null as never, glassMat: null };
    };
    const mounds: number[][] = [];
    const D = {
      onImpact: undefined, impact: (...a: number[]) => wr.impact(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]),
      restoreMound: (x: number, z: number, rr: number, h: number) => { mounds.push([x, z, rr, h]); },
    } as unknown as Destruction;
    const solids = new LandmarkSolids({ landmarks: [lm] } as unknown as MacroPlan, flat);
    const wr = new LandmarkWrecks([data()], D, noop, noop, flat, solids, facade);
    const w = wr.wrecks[0], T = w.T, top = w.box[4];
    const run = (s: number) => { for (let t = 0; t < s; t += 1 / 30) wr.update(1 / 30); };
    // A punch-sized hit on one piece of the lower part: that piece (and little else) breaks.
    const k = Math.floor(((top - w.g.y0) * 0.25) / w.g.ch);
    const lvl: number[] = [];
    for (let p = 0; p < w.n; p++) if (w.ijk[p * 3 + 2] === k) lvl.push(p);
    const p0 = lvl[0];
    const one = wr.impact(T[p0 * PIECE_STRIDE + 2], T[p0 * PIECE_STRIDE + 3], T[p0 * PIECE_STRIDE + 4], 0.5, 1e6, 1, 0, 0);
    const weak = wr.impact(T[p0 * PIECE_STRIDE + 2], T[p0 * PIECE_STRIDE + 3], T[p0 * PIECE_STRIDE + 4], 0.5, 100, 1, 0, 0);
    run(2);
    const afterOne = wr.standing(0);
    // A quarter of that level more: it still stands.
    for (let i = 1; i < lvl.length; i += 4) wr.impact(T[lvl[i] * PIECE_STRIDE + 2], T[lvl[i] * PIECE_STRIDE + 3], T[lvl[i] * PIECE_STRIDE + 4], 0.01, 1e7, 0, 0, 0);
    run(3);
    const afterQuarter = wr.standing(0), topBefore = solids.topAt(lm.x, lm.z, 1e9);
    // The whole level: everything above comes down.
    for (const p of lvl) wr.impact(T[p * PIECE_STRIDE + 2], T[p * PIECE_STRIDE + 3], T[p * PIECE_STRIDE + 4], 0.01, 1e7, 0, 0, 0);
    let fell = 0;
    for (let t = 0; t < 40; t += 1 / 30) { wr.update(1 / 30); fell = Math.max(fell, wr.group.children.length); }
    const left = wr.standing(0), yCut = w.g.y0 + (k + 1) * w.g.ch;
    let above = 0;
    for (let p = 0; p < w.n; p++) if (w.alive[p] && w.ijk[p * 3 + 2] > k) above++;
    const topAfter = solids.topAt(lm.x, lm.z, 1e9), hitHigh = solids.hit(lm.x, (yCut + top) / 2, lm.z);
    const save = wr.capture();
    const wr2 = new LandmarkWrecks([data()], D, noop, noop, flat, new LandmarkSolids({ landmarks: [lm] } as unknown as MacroPlan, flat), facade);
    const restored = save.length === 1 && wr2.restore(save[0][0], save[0][1], save[0][2]) && wr2.standing(0) === left;
    check(one === 1 && weak === 0 && afterOne === w.n - 1, `wrecks ${name}: a hit breaks the piece it reaches (${one}), a weak one nothing (${weak})`);
    check(afterQuarter > w.n * 0.9, `wrecks ${name}: a quarter of a level broken, it stands (${afterQuarter} of ${w.n} pieces)`);
    check(above === 0 && fell >= 1 && mounds.length > 0 && !wr.busy, `wrecks ${name}: a level cut through, the ${w.n - left} pieces above fall (${fell} falling, ${mounds.length} mounds, ${above} left above)`);
    check(topAfter < yCut + 0.5 && topBefore > yCut && !hitHigh, `wrecks ${name}: collision follows (top ${topBefore.toFixed(0)} → ${topAfter.toFixed(0)} m, cut at ${yCut.toFixed(0)})`);
    check(restored, `wrecks ${name}: a save restores the same ${left} standing pieces`);
    results.push(`${name} ${w.n}`);
  }
  check(badElem === 0 && unnamed === 0, `wrecks: every triangle of the near meshes is a piece, the far ones agree (${badElem} out of range, ${unnamed} unnamed)`);
  console.log(`wrecks: ${results.join(', ')} pieces in ${(performance.now() - t0).toFixed(0)} ms`);
}

// Defeat: the rescue needs reputation 0+, the hospital is a fitting block (the same ones every
// time, never the one beside the hero when another is near), the flight climbs over the roofs.
{
  check(rescueAllowed(0) && rescueAllowed(35) && !rescueAllowed(-0.1) && !rescueAllowed(-60), 'defeat: drones come at reputation 0 or better, not below');
  const blocks: HospitalCandidate[] = [];
  for (let i = 0; i < 400; i++) {
    const a = i * 2.4, r = 30 + i * 3;
    blocks.push({ id: i, x: Math.cos(a) * r, z: Math.sin(a) * r, base: 2, top: 2 + 10 + (i % 9) * 8, area: 300 + (i % 7) * 150, use: ['office', 'residential', 'civic', 'mixed', 'retail'][i % 5], roof: i % 4 === 3 ? 'gable' : 'flat', alive: i % 13 !== 0 });
  }
  const h1 = pickHospital(blocks, 0, 0, 77), h2 = pickHospital(blocks, 0, 0, 77), h3 = pickHospital(blocks, 0, 0, 78);
  const fit = h1 >= 0 && hospitalFit(blocks[h1]);
  const d1 = h1 >= 0 ? Math.hypot(blocks[h1].x, blocks[h1].z) : -1;
  check(fit && h1 === h2 && d1 >= 50, `defeat: the hospital is a fitting block, the same every time, not next door (block ${h1} at ${d1.toFixed(0)} m; another seed: ${h3})`);
  const lonely = pickHospital([{ id: 1, x: 10, z: 0, base: 0, top: 8, area: 90, use: 'residential', roof: 'gable', alive: true }], 0, 0, 1);
  check(lonely === 0 && pickHospital([], 0, 0, 1) === -1, 'defeat: without a fitting block any standing building will do; none: no hospital');
  const f = planFlight([0, 5, 0], [600, 42, 300], 120);
  let maxY = -Infinity, okEnds = true;
  const p: [number, number, number] = [0, 0, 0];
  for (let t = 0; t <= f.dur; t += 0.05) { flightAt(f, t, p); maxY = Math.max(maxY, p[1]); }
  flightAt(f, 0, p); okEnds &&= Math.hypot(p[0], p[1] - 5, p[2]) < 1e-6;
  flightAt(f, f.dur, p); okEnds &&= Math.hypot(p[0] - 600, p[1] - 42, p[2] - 300) < 1e-6;
  check(okEnds && maxY > 120 && f.dur >= 6 && f.dur <= 14, `defeat: the flight starts at the body, ends over the pad, clears the roofs (top ${maxY.toFixed(0)} m over 120, ${f.dur.toFixed(1)} s)`);
  check(wardInside(0, 0) && !wardInside(WARD.hx + 0.5, 0) && wardExit(0, WARD.hz) && !wardExit(WARD.hx - 1, WARD.hz) && !wardExit(0, WARD.pod.z), 'defeat: the ward has an inside and a way out through the doors only');
  {
    // A 30 × 20 roof with a water tank in its middle: the pad goes beside it, clear of the tank and the edges.
    const roof = [0, 0, 30, 0, 30, 20, 0, 20];
    const p = padSpot(roof, [{ x: 15, z: 10, r: 3 }], 15, 10);
    const tank = Math.hypot(p.x - 15, p.z - 10) - 3;
    const empty = padSpot(roof, [], 15, 10);
    check(tank >= 4 && p.clear >= 4 && p.x > 1 && p.x < 29 && Math.hypot(empty.x - 15, empty.z - 10) < 1.5, `defeat: the roof pad keeps clear of the water tank and the edges (${tank.toFixed(1)} m from the tank, ${p.clear.toFixed(1)} m clear; empty roof: the middle)`);
  }
  check(hospitalName(5) === hospitalName(5) && hospitalName(5).length > 4, `defeat: the city's hospital has a name (${hospitalName(5)})`);
}

// Cathedrals (plan/cathedralParts): walk in through the west door, under the vaults to the nave; the
// stained glass shatters on a light hit while the walls hold (and lets you through), the meshes
// agree on the pieces and a save brings the broken windows back.
{
  const t0 = performance.now();
  const flat = { height: () => 0, isWater: () => false } as unknown as Terrain;
  const noop = new Proxy({}, { get: () => () => undefined }) as never;
  const facade = { albedo: null, normal: null, tileMeters: [] } as unknown as MaterialArrays;
  const results: string[] = [];
  for (const style of [0, 1, 2]) {
    const r = new MRng(7 * 101 + style);
    const L = Math.round(r.range(62, 96)), W = Math.round(r.range(20, 28));
    const p = { L, W, H: r.range(20, 30), towerH: r.range(60, 105), transept: r.range(1.6, 2.1), wall: r.int(0, 3), roof: r.int(0, 2) };
    const lm: Landmark = { id: 0, kind: 'cathedral', name: 'test', cell: 0, x: 100, z: -50, angle: 0.4, hu: W / 2 + 18, hv: L / 2 + 16, site: [], base: 0.15, low: 0, seed: r.nextU32(), style, p } as Landmark;
    lm.site = siteRect(lm, -lm.hu, -lm.hv, lm.hu, lm.hv);
    const solids = new LandmarkSolids({ landmarks: [lm] } as unknown as MacroPlan, flat);
    // Walk up the centre line from the square: up the steps, through the door, into the nave.
    let y = 0, blocked = 0, maxStep = 0, inside = false;
    for (let v = -lm.hv; v <= 0; v += 0.2) {
      const [x, z] = siteToWorld(lm, 0, v);
      const ny = Math.max(0, solids.topAt(x, z, y + 0.45, 0));
      maxStep = Math.max(maxStep, ny - y);
      y = ny;
      for (const h of [0.3, 1.0, 1.7]) if (solids.hit(x, y + h, z)) { blocked++; break; }
      inside = !!solids.insideAt(x, y + 1, z);
    }
    const floor = y;
    check(blocked === 0 && maxStep < 0.45 && inside && floor >= lm.base - 0.01, `cathedral ${style}: walk in from the square to the nave (${blocked} blocked, steps up to ${maxStep.toFixed(2)} m, floor ${floor.toFixed(2)} m, inside ${inside})`);
    // Its people's ways (sim/LandmarkCrowds): clear of the stone, on the floor, all reachable.
    const ways = auditWays(lm, landmarkInterior(lm, flat)!, solids, flat);
    const who = new Set(landmarkInterior(lm, flat)!.spots.map((sp) => sp.who));
    check(!ways.bad.length && ['priest', 'server', 'faithful', 'visitor'].every((w) => who.has(w as never)), `cathedral ${style}: ${ways.legs} walkway legs and ${ways.spots} spots clear, on the floor and reachable (${ways.bad.slice(0, 3).join('; ') || 'ok'})`);
    // Destruction: glass, walls, meshes, save.
    let badElem = 0;
    const data = (): LandmarkWreckData => {
      const b = buildLandmarkMeshes(lm, flat);
      const n = b.pieces!.length / PIECE_STRIDE;
      const meshes = [b.near.build(), b.far.build()];
      for (const m of meshes) { const e = m.attrs.aElem.array; for (let i = 0; i < e.length; i++) if (e[i] > n || e[i] < 0) badElem++; }
      const Wd = 1024, Hd = Math.ceil((n + 1) / Wd), ed = new Uint8Array(Wd * Hd * 2).fill(255);
      const g = new THREE.BufferGeometry();
      for (const k in meshes[0].attrs) g.setAttribute(k, new THREE.BufferAttribute(meshes[0].attrs[k].array, meshes[0].attrs[k].size, meshes[0].attrs[k].normalized));
      g.setIndex(new THREE.BufferAttribute(meshes[0].index, 1));
      const near = new THREE.Mesh(g);
      near.position.set(...meshes[0].origin);
      return { index: 0, lm, grid: b.grid!, pieces: b.pieces!, elemData: ed, elemTex: new THREE.DataTexture(ed, Wd, Hd), elemW: Wd, near, nearGlass: null, facadeMat: null as never, glassMat: null };
    };
    const D = { onImpact: undefined, impact: () => 0, restoreMound: () => undefined } as unknown as Destruction;
    const wr = new LandmarkWrecks([data()], D, noop, noop, flat, solids, facade);
    const w = wr.wrecks[0], T = w.T;
    let panes = 0;
    for (let q = 0; q < w.n; q++) panes += w.pane[q];
    // The lowest pane on the nave's side: a light hit breaks it (and only glass), its wall stands.
    let p0 = -1;
    for (let q = 0; q < w.n; q++) if (w.pane[q] && (p0 < 0 || T[q * PIECE_STRIDE + 3] < T[p0 * PIECE_STRIDE + 3])) p0 = q;
    const at = (q: number) => [T[q * PIECE_STRIDE + 2], T[q * PIECE_STRIDE + 3], T[q * PIECE_STRIDE + 4]] as const;
    const [px, py, pz] = at(p0);
    const before = solids.hit(px, py, pz);
    // (Glass gives at GLASS_IMPULSE·0.3 per m², walls at thousands.)
    const light = GLASS_IMPULSE * Math.max(1, T[p0 * PIECE_STRIDE + 1]) * 0.6;
    const broken = wr.impact(px, py, pz, 0.01, light, 1, 0, 0), glass = wr.lastPanes;
    for (let t = 0; t < 2; t += 1 / 30) wr.update(1 / 30);
    let wallBroken = 0;
    for (let q = 0; q < w.n; q++) if (!w.pane[q] && !w.alive[q]) wallBroken++;
    check(panes > 20 && broken >= 1 && glass === broken && wallBroken === 0 && !w.alive[p0], `cathedral ${style}: a light hit shatters the stained glass (${broken} pieces, ${glass} glass) of ${panes} panes, no wall (${wallBroken})`);
    check(before && !solids.hit(px, py, pz), `cathedral ${style}: a shattered window lets you through (solid before ${before})`);
    const save = wr.capture();
    const wr2 = new LandmarkWrecks([data()], D, noop, noop, flat, new LandmarkSolids({ landmarks: [lm] } as unknown as MacroPlan, flat), facade);
    const restored = save.length === 1 && wr2.restore(save[0][0], save[0][1], save[0][2]) && wr2.standing(0) === wr.standing(0) && !wr2.wrecks[0].alive[p0];
    check(badElem === 0 && restored, `cathedral ${style}: meshes agree on the ${w.n} pieces (${badElem} out of range), a save restores the broken glass`);
    results.push(`${style}: ${w.n} pieces, ${panes} panes`);
  }
  console.log(`cathedrals: ${results.join('; ')} in ${(performance.now() - t0).toFixed(0)} ms`);
}

// The starship's great hall (interior/design, plan/marvelParts): in from the square through a lobby
// door and the hull to the hall floor; up every flight to its level; from every gallery through a
// room's door; all without a wall in the way or a step a walker can't take.
{
  const t0 = performance.now();
  const flat = { height: () => 0, isWater: () => false } as unknown as Terrain;
  const results: string[] = [];
  for (const seed of [1, 3, 4]) {
    const r = new MRng(seed * 101);
    const d = marvelDesign(0, 7000)(r.fork('design'), 1)!;
    // (Its site on a slope: foundations reach 1.5 m down, as on real ground.)
    const lm: Landmark = { id: 0, kind: 'marvel', name: 'test', cell: 0, x: 40, z: -20, angle: 0.4, hu: d.hu, hv: d.hv, site: [], base: 0.15, low: -1.5, seed: r.nextU32(), style: 0, p: d.p };
    lm.site = siteRect(lm, -lm.hu, -lm.hv, lm.hu, lm.hv);
    landmarkParts(lm, flat);
    const hall = marvelHall(lm);
    check(!!hall && hall.levels.length >= 6, `starship ${seed}: a great hall with galleries (${hall?.levels.length ?? 0} levels)`);
    if (!hall) continue;
    const solids = new LandmarkSolids({ landmarks: [lm] } as unknown as MacroPlan, flat);
    // The player's rules (world/Collision, player/Player): a 1.8 m walker of radius 0.3 stands on tops at
    // least 0.7 m deep (or decks) up to 0.5 m above its feet; taller tops within its radius stop it.
    const STEP = 0.5, MINH = 0.7, R = 0.3, HGT = 1.8;
    const groundAt = (x: number, z: number, y: number) => {
      let g = 0;
      solids.provider(x - 0.01, z - 0.01, x + 0.01, z + 0.01, (o) => {
        if ((o.y1 - o.y0 < MINH && !o.deck) || o.y1 > y + STEP || o.y1 <= g) return;
        if (insideObstacle(o, x, z, 0)) g = o.y1;
      });
      return g;
    };
    const stopped = (x: number, z: number, y: number) => {
      let hit = false;
      solids.provider(x - R - 6, z - R - 6, x + R + 6, z + R + 6, (o) => {
        if (hit || o.y1 - o.y0 < HGT * 0.4 || y >= o.y1 - STEP || y + HGT <= o.y0) return;
        if (insideObstacle(o, x, z, R)) hit = true;
      });
      return hit;
    };
    // Walk a polyline of local points from height y: blocked samples and the biggest step up.
    const walk = (pts: [number, number][], y: number) => {
      let blocked = 0, maxStep = 0;
      for (let i = 0; i + 1 < pts.length; i++) {
        const L = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        for (let s = 0; s <= L; s += 0.2) {
          const [x, z] = siteToWorld(lm, pts[i][0] + ((pts[i + 1][0] - pts[i][0]) * s) / L, pts[i][1] + ((pts[i + 1][1] - pts[i][1]) * s) / L);
          const ny = groundAt(x, z, y);
          maxStep = Math.max(maxStep, ny - y);
          y = ny;
          if (stopped(x, z, y)) blocked++;
        }
      }
      return { blocked, maxStep, y };
    };
    const doors = marvelDoors(lm);
    let inBlocked = 0, inStep = 0, inFloor = 0, inside = true;
    for (const a of doors) {
      const e = Math.min(lm.hu / Math.max(1e-6, Math.abs(Math.cos(a))), lm.hv / Math.max(1e-6, Math.abs(Math.sin(a)))) - 0.5, i = hall.voidR * 0.6;
      const inn = walk([[Math.cos(a) * e, Math.sin(a) * e], [Math.cos(a) * i, Math.sin(a) * i]], 0);
      const [ix, iz] = siteToWorld(lm, Math.cos(a) * i, Math.sin(a) * i);
      inBlocked += inn.blocked; inStep = Math.max(inStep, inn.maxStep); inFloor = Math.max(inFloor, Math.abs(inn.y - lm.base));
      inside &&= !!solids.insideAt(ix, inn.y + 1, iz);
    }
    check(doors.length >= 3 && inBlocked === 0 && inStep < 0.45 && inFloor < 0.05 && inside, `starship ${seed}: walk in from the square through each of the ${doors.length} doors to the hall floor (${inBlocked} blocked, steps up to ${inStep.toFixed(2)} m, inside ${inside})`);
    let badFlights = 0, badRooms = 0;
    for (const st of hall.design.stairs) {
      const run = st.n * st.tread;
      const w = walk([[st.from[0] - st.dir[0] * 0.6, st.from[1] - st.dir[1] * 0.6], [st.from[0] + st.dir[0] * (run + 0.8), st.from[1] + st.dir[1] * (run + 0.8)]], st.y0);
      if (w.blocked || w.maxStep > 0.45 || Math.abs(w.y - st.y1) > 0.05) { badFlights++; if (badFlights < 3) results.push(`flight ${st.y0.toFixed(0)}→${st.y1.toFixed(0)}: ${w.blocked} blocked, step ${w.maxStep.toFixed(2)}, ends ${w.y.toFixed(2)}`); }
    }
    for (const room of hall.design.rooms) {
      const out: [number, number] = [room.door[0] - room.facing[0] * -1.6, room.door[1] - room.facing[1] * -1.6];
      const inDoor: [number, number] = [room.door[0] - room.facing[0] * 1.2, room.door[1] - room.facing[1] * 1.2];
      const w = walk([out, room.door, inDoor], room.y);
      if (w.blocked || Math.abs(w.y - room.y) > 0.05) { badRooms++; if (badRooms < 3) results.push(`room at ${room.y.toFixed(0)}: ${w.blocked} blocked, floor ${w.y.toFixed(2)}`); }
    }
    // Round each gallery: no wall or rail across the walkway.
    let badRing = 0;
    for (const y of hall.levels) {
      const pts: [number, number][] = [];
      const rm = hall.voidR + 1.8, sz = lm.p.ell;
      for (let i = 0; i <= 96; i++) { const t = (i / 96) * Math.PI * 2; pts.push([Math.cos(t) * rm, Math.sin(t) * rm * sz]); }
      const w = walk(pts, y);
      if (w.blocked || Math.abs(w.y - y) > 0.05) badRing++;
    }
    check(badRing === 0, `starship ${seed}: round every gallery unhindered (${badRing} of ${hall.levels.length} blocked)`);
    check(badFlights === 0, `starship ${seed}: every one of the ${hall.design.stairs.length} flights climbs clear to its level (${badFlights} bad)`);
    check(badRooms === 0, `starship ${seed}: every one of the ${hall.design.rooms.length} rooms is walkable in through its door (${badRooms} bad)`);
  }
  console.log(`starship halls in ${(performance.now() - t0).toFixed(0)} ms ${results.join('; ')}`);
}

// Front doors in real cities: from the square up the steps (however far below the floor it lies)
// and through the door of the town hall and the cathedral, with no pit or wall on the way.
for (const [seed, size] of [[9, 0.6], [12, 0.8]] as const) {
  const terrain = new Terrain(makeProfile({ seed, size }));
  const macro = buildMacroPlan(terrain);
  const S = new LandmarkSolids(macro, terrain);
  for (const lm of macro.landmarks.filter((l) => l.kind === 'cathedral' || l.kind === 'townhall')) {
    const end = lm.kind === 'cathedral' ? 0 : lm.hv - 4 - lm.p.d + 2;
    let [x, z] = siteToWorld(lm, 0, -lm.hv - 2);
    let y = terrain.height(x, z), up = 0, down = 0, blocked = 0;
    for (let v = -lm.hv - 2; v <= end; v += 0.1) {
      [x, z] = siteToWorld(lm, 0, v);
      const ny = Math.max(terrain.height(x, z), S.topAt(x, z, y, 0.5));
      up = Math.max(up, ny - y);
      down = Math.max(down, y - ny);
      y = ny;
      if (S.hit(x, y + 0.3, z) || S.hit(x, y + 1.5, z)) blocked++;
    }
    check(up <= 0.31 && down < 0.31 && blocked === 0 && Math.abs(y - lm.base) < 0.05 && !!S.insideAt(x, y + 1, z),
      `seed ${seed} size ${size}: walk in to the ${lm.kind} (steps up to ${up.toFixed(2)} m, drops ${down.toFixed(2)} m, ${blocked} blocked, floor ${(y - lm.base).toFixed(2)} m)`);
    const ways = auditWays(lm, landmarkInterior(lm, terrain)!, S, terrain);
    check(!ways.bad.length, `seed ${seed} size ${size}: the ${lm.kind}'s ${ways.legs} walkway legs and ${ways.spots} spots clear, on the floor and reachable (${ways.bad.slice(0, 3).join('; ') || 'ok'})`);
  }
}


// People in the landmarks (sim/LandmarkCrowds): who is there by the hour, nobody inside a wall or
// floating, they walk their ways, a scare empties the building, at night the town hall's porter.
{
  const t0 = performance.now();
  const { RoadNet } = await import('../src/sim/RoadNet');
  const { Pedestrians, PState } = await import('../src/sim/Pedestrians');
  const { LandmarkCrowds, roomFor } = await import('../src/sim/LandmarkCrowds');
  const terrain = new Terrain(makeProfile({ seed: 9, size: 0.6 }));
  const macro = buildMacroPlan(terrain);
  const S = new LandmarkSolids(macro, terrain);
  const world = { buildingsIn: () => [], bridgeDeck: () => -Infinity, landmarks: S } as never;
  const pop = new Population(macro, 9);
  const peds = new Pedestrians(pop, new RoadNet(macro), world, terrain, macro, {} as never);
  const halls = new LandmarkCrowds({ macro, terrain, world, peds, pop, floor: (x, y, z) => S.topAt(x, z, y, 0), clear: (x, y, z) => roomFor(S, x, y, z) });
  const run = (lm: Landmark, hours: number, secs: number, onStep?: () => void, far = false) => {
    const px = lm.x + (far ? 5000 : 0), pz = lm.z;
    for (let t = 0; t < secs; t += 1 / 30) {
      peds.update(1 / 30, hours + t / 3600, px, pz, 1 / 30);
      halls.update(1 / 30, hours + t / 3600, px, pz);
      onStep?.();
    }
  };
  const ours = () => peds.agents.filter((a) => a.alive && a.hall);
  const roles = (lm: Landmark) => halls.report().find((h) => h.name === lm.name)?.people ?? {};
  for (const lm of macro.landmarks.filter((l) => l.kind === 'cathedral' || l.kind === 'townhall')) {
    const day = 3 * 24, hour = lm.kind === 'cathedral' ? 9.5 : 10.5;
    let wall = 0, lost = 0, n = 0;
    run(lm, day + hour, 90, () => {
      for (const a of ours()) {
        n++;
        if (!Number.isFinite(a.x + a.y + a.z)) { lost++; continue; }
        if (S.hit(a.x, a.y + 1.0, a.z)) wall++;
        const f = Math.max(terrain.height(a.x, a.z), S.topAt(a.x, a.z, a.y + 0.35, 0));
        if (Math.abs(f - a.y) > 0.35) lost++;
      }
    });
    const r = roles(lm), count = ours().length;
    const staff = lm.kind === 'cathedral' ? (r.priest ?? 0) === 1 && (r.faithful ?? 0) >= 10 && (r.server ?? 0) >= 1 : (r.clerk ?? 0) >= 2 && (r.councillor ?? 0) >= 3 && (r.mayor ?? 0) === 1;
    const walking = ours().filter((a) => a.state === PState.Walk).length, seated = ours().filter((a) => a.state === PState.Sit).length;
    check(count >= 15 && staff && wall === 0 && lost === 0 && seated > 3, `landmark people: the ${lm.kind} at ${Math.floor(hour)}:30 (${count} people: ${Object.entries(r).map(([k, v]) => `${v} ${k}`).join(', ')}; ${seated} seated, ${walking} walking; ${wall} of ${n} samples in a wall, ${lost} off the floor)`);
    // A blast nearby: everyone runs out (and away down the street: here they just vanish at the steps).
    for (const a of ours()) a.fear = 1.2;
    run(lm, day + hour + 0.03, 40);
    check(ours().filter((a) => a.inside).length === 0, `landmark people: a scare empties the ${lm.kind} (${ours().length} still inside after 40 s)`);
    // Night (come back to it): the cathedral closed and empty, the town hall's porter at the desk.
    run(lm, day + 26.5, 1, undefined, true);
    run(lm, day + 26.5, 30);
    const nr = roles(lm);
    check(lm.kind === 'cathedral' ? ours().length === 0 : (nr.porter ?? 0) === 1 && ours().length === 1, `landmark people: the ${lm.kind} at 2:30 at night (${Object.entries(nr).map(([k, v]) => `${v} ${k}`).join(', ') || 'nobody'})`);
    if (lm.kind === 'cathedral') {
      // The end of the service: out in a queue, a little room to the one in front, nobody inside anybody
      // (a few brushing past where the ways meet).
      let pairs = 0, close = 0;
      run(lm, day + 33.9, 1, undefined, true);
      run(lm, day + 33.9, 5);
      run(lm, day + 34.01, 60, () => {
        const w = ours().filter((a) => a.inside && a.state !== PState.Sit);
        for (let i = 0; i < w.length; i++) for (let j = i + 1; j < w.length; j++) {
          if (Math.abs(w[i].y - w[j].y) > 1 || Math.abs(w[i].x - w[j].x) > 1 || Math.abs(w[i].z - w[j].z) > 1) continue;
          pairs++;
          if (Math.hypot(w[i].x - w[j].x, w[i].z - w[j].z) < 0.15) close++;
        }
      });
      check(close <= pairs * 0.02, `landmark people: leaving the cathedral after the service, ${close} of ${pairs} near pairs inside each other (closer than 0.15 m)`);
    }
  }
  console.log(`landmark people: ${(performance.now() - t0).toFixed(0)} ms`);
}

// People (NPC_PERSONALITY_PLAN phase 1): names, personalities, talk lines, memory.
{
  const t0 = performance.now();
  const terrain = new Terrain(makeProfile({ seed: 7, size: 0.4 }));
  const macro = buildMacroPlan(terrain);
  const pop = new Population(macro, 7);
  // (Synthetic citizens are never workers: every other one gets a workplace, as workersOf would.)
  const cits = Array.from({ length: 3000 }, (_, i) => { const c = pop.synthetic(1000 + i * 7919); return i % 2 && c.role !== 0 ? { ...c, role: 3, work: { ...c.home, kind: 'work' as const } } : c; });
  const same = cits.slice(0, 50).every((c) => nameOf(c).full === nameOf({ ...c }).full && nameOf(c).full === nameOf(pop.synthetic(1000 + cits.indexOf(c) * 7919)).full && temperamentOf(traitsOf(c)) === temperamentOf(traitsOf(pop.synthetic(c.seed))));
  check(same, 'people: the same person has the same name and temperament every time');
  const names = new Set(cits.map((c) => nameOf(c).full));
  check(names.size > cits.length * 0.7, `people: names vary (${names.size} different of ${cits.length})`);
  const tally: Record<string, number> = {};
  for (const c of cits) { const t = temperamentOf(traitsOf(c)); tally[t] = (tally[t] ?? 0) + 1; }
  const rare = TEMPERAMENTS.filter((t) => (tally[t] ?? 0) < cits.length * 0.02);
  check(rare.length === 0, `people: every temperament is common enough (${TEMPERAMENTS.map((t) => `${t} ${tally[t] ?? 0}`).join(', ')})`);
  check(TEMPERAMENTS.every((t) => Array.isArray(CHAT[t])), 'people: small talk for every temperament');
  // Every topic answers for everybody in every situation, with every token filled in.
  const topics: Topic[] = ['hello', 'mood', 'job', 'news', 'way', 'me', 'bye'];
  let none = 0, raw = 0, n = 0;
  const seen: Record<string, Set<string>> = {};
  const rng = new MRng(99);
  for (const c of cits.slice(0, 400)) {
    const traits = traitsOf(c);
    const temper = temperamentOf(traits) as Temperament;
    const job = jobOf(c, rng.pick(['downtown', 'industrial', 'port', 'oldtown', 'commercial'] as const));
    const trouble = rng.chance(0.2) ? rng.float() : 0;
    const opinion = rng.range(-100, 100);
    const weather = rng.pick(['clear', 'fair', 'rain', 'storm', 'fog']);
    const hour = rng.range(0, 24);
    const mood = moodOf(c, traits, { day: rng.int(0, 9), hour, weather, trouble, opinion });
    const nm = nameOf(c);
    const met = rng.chance(0.5) ? rng.int(1, 5) : 0;
    const f: TalkFacts = {
      first: nm.first, last: nm.last, full: nm.full, years: Math.round(c.age * 100), child: c.role === 0, senior: c.age >= 0.66,
      traits, temper, job, interest: interestOf(c), mood, moodWord: moodWord(mood, trouble), met,
      deed: met ? rng.pick([null, 'helped', 'saved', 'hurt'] as const) : null, days: met ? rng.range(0, 6) : 0, opinion, hour, weather, trouble,
      threat: rng.chance(0.2), street: rng.chance(0.8) ? 'Linden Street' : null, metStreet: rng.chance(0.5) ? 'Oak Avenue' : null, city: 'Port Ashford',
      group: rng.chance(0.4) ? 'The Harbour Kings' : null, boss: rng.chance(0.5) ? 'Rook Malone' : null, giant: rng.chance(0.1),
      place: 'Linden Square station', dir: dirWord(rng.range(-1, 1), rng.range(-1, 1)), dist: rng.range(100, 4000),
      heard: rng.chance(0.4) ? 'Did you hear? There was a mugging in Ashville this morning.' : null, hood: rng.chance(0.8) ? 'Ashville' : null,
      safety: rng.pick(['safe', 'quiet', 'mixed', 'rough', 'dangerous'] as const),
    };
    if (!f.group) f.boss = null;
    for (const tp of topics) {
      const p = ruleAnswer({ topic: tp, facts: f, seed: c.seed + n, used: new Set() });
      n++;
      if (p.text === '…') none++;
      if (/[{}]/.test(p.text)) raw++;
      (seen[tp] ??= new Set()).add(p.id);
    }
  }
  check(none === 0 && raw === 0, `people: every topic has a line for everybody (${none} without, ${raw} with unfilled tokens, of ${n})`);
  const unused = topics.flatMap((tp) => LINES[tp].filter((e) => !e.when.title && ![...seen[tp]].some((id) => id.split(' ').some((x) => x.startsWith(`${e.id}#`)))).map((e) => e.id));
  check(unused.length <= 6, `people: almost every line gets said by someone (${unused.length} never: ${unused.join(' ')})`);
  // The most specific line wins; a person does not repeat themselves.
  const base = { first: 'Ann', last: 'Lee', full: 'Ann Lee', years: 40, child: false, senior: false, traits: { o: 0.5, c: 0.5, e: 0.5, a: 0.5, n: 0.5 }, job: { kind: 'office' as const, title: 'office worker' }, interest: 'chess', mood: 0, moodWord: 'fine' as const, days: 0, opinion: 0, hour: 12, weather: 'fair', trouble: 0, threat: false, street: 'Elm Street', metStreet: 'Elm Street', city: 'X', group: null, boss: null, giant: false };
  const helped = pickLine('hello', { ...base, temper: 'grumpy', met: 2, deed: 'helped' }, 1);
  check(helped.id.startsWith('h21#'), `people: someone you helped up greets you for it (${helped.id}: ${helped.text})`);
  const used = new Set<string>();
  const said: string[] = [];
  for (let i = 0; i < 3; i++) { const p = pickLine('news', { ...base, temper: 'steady', met: 0, deed: null }, 5 + i, used); said.push(p.text); used.add(p.id); }
  check(new Set(said).size === said.length, `people: no repeats while there is something new to say (${said.join(' | ')})`);
  {
    // Out of sight, a known person moves at a walk near you (the plan runs many times faster), rides only far away.
    let w = { x: 0, z: 0 };
    for (let i = 0; i < 30; i++) w = onTheirWay(w.x, w.z, 2000, 0, 50, 0, 1);
    check(Math.abs(w.x - 30 * PEOPLE.walk) < 1e-6, `people: walk near the hero (${w.x.toFixed(1)} m in 30 s)`);
    const far = onTheirWay(1000, 0, 3000, 0, 0, 0, 10);
    check(Math.abs(far.x - 1000 - 10 * PEOPLE.ride) < 1e-6, 'people: ride when far from the hero');
    const there = onTheirWay(0, 0, 3, 4, 0, 0, 100);
    check(there.x === 3 && there.z === 4, 'people: stop at the place');
    const R = Float32Array.from([0, 0, 0, 100, 0, 0, 100, 100, 0]);
    const at = routeNearest(R, 100, 50 + 0.5);
    check(Math.abs(at.along - 150.5) < 1e-3 && at.d < 1e-3, 'people: nearest route point');
    check(routeNearest(R, 50, 30).d === 30, 'people: route distance');
  }
  check(fill('{ATitle}, {aTitle}, {Group}.', { ...base, temper: 'kind', met: 0, deed: null, job: { kind: 'office', title: 'office worker' }, group: 'the Kings' }) === 'An office worker, an office worker, The Kings.', 'people: tokens with articles and capitals');
  check(dirWord(0, -1) === 'north' && dirWord(1, 0) === 'east' && dirWord(-1, 1) === 'south-west', 'people: compass words (north is −z, as on the map)');
  // Memory: a small cap; the one you care least about is forgotten; saves round-trip.
  const list = cits.slice(0, PEOPLE.cap).map((c, i) => { const k = newKnown(c, nameOf(c).full, i, 0, 0, null); applyDeed(k, 'talked', i, null); return k; });
  applyDeed(list[0], 'helped', 30, 'Elm Street');
  const all: typeof list = [];
  for (const k of list) remember(all, k, 30);
  const extra = newKnown(cits[PEOPLE.cap], 'New One', 40, 0, 0, null);
  const gone = remember(all, extra, 40);
  check(all.length === PEOPLE.cap && !!gone && gone !== list[0] && gone !== extra && all.includes(list[0]), `people: at most ${PEOPLE.cap} remembered, the least important forgotten (${gone?.name})`);
  check(opinionOf(list[0], 0, 0.5) > 20 && opinionOf({ talks: 0, helped: 0, saved: 0, hurt: 2 }, 0, 0.5) < -40 && opinionOf(null, 80, 1) > opinionOf(null, 80, 0), 'people: opinion from deeds and reputation (agreeable people go by reputation more)');
  addSaid(list[0], 'h1#0 i0#1');
  const back = restorePeople(JSON.parse(JSON.stringify(savePeople(all))));
  check(back.length === all.length && back[0].name === all[0].name && back[0].cit.seed === all[0].cit.seed && back[0].deed === 'helped' && back[0].said.join() === 'h1#0,i0#1' && back[0].cit.home.cell === all[0].cit.home.cell,
    'people: the people you met survive a save');
  check(restorePeople({ people: [{ cit: { id: 1 } }, 'junk', null] }).length === 0 && restorePeople(null).length === 0, 'people: a damaged list loads empty, not broken');
  const st = pop.stateAt(list[0].cit, 30);
  check(!!(st.stay || st.trip), 'people: a remembered person is somewhere on their day plan');
  // Special characters (street performers, officers, medics …) answer as what they are.
  const specials = [...Object.values(STREET_KINDS).map((k) => k.title.toLowerCase()), 'police officer', 'paramedic', 'soldier', 'shopkeeper', 'cleanup worker', 'firefighter'];
  const own = (tp: Topic, t: string) => {
    const id = pickLine(tp, { ...base, temper: 'grumpy', met: 3, deed: 'helped', job: { kind: 'street', title: t } }, 3).id.split('#')[0];
    return !!LINES[tp].find((e) => e.id === id)?.when.title?.includes(t);
  };
  const miss = specials.filter((t) => !own('hello', t) || !own('job', t));
  check(miss.length === 0, `people: every special character greets you and tells you what they do in their own words (missing: ${miss.join(', ')})`);
  const mime = ruleAnswer({ topic: 'job', facts: { ...base, temper: 'chatty', met: 0, deed: null, job: { kind: 'street', title: 'mime' } }, seed: 4, used: new Set() });
  check(mime.id.startsWith('js2#') && !mime.id.includes(' '), `people: the mime only mimes (${mime.text})`);
  console.log(`people: ${TEMPERAMENTS.length} temperaments, ${topics.reduce((s, t) => s + LINES[t].length, 0)} line rules, ${n} answers in ${(performance.now() - t0).toFixed(0)} ms`);
}

// ------------------------------------------------------------------ the city's pulse (game/news): neighbourhoods, live
// crime index, police presence, the fresh start, off-screen crime and the news in words
{
  const t0 = performance.now();
  const { crimeIndex } = await import('../src/game/crime/CrimeIndex');
  const { planFactions } = await import('../src/game/factions/Factions');
  const { CITY_GROUPS } = await import('../src/game/factions/archetypes');
  const seed = 42;
  const macro = buildMacroPlan(new Terrain(makeProfile({ seed, size: 0.4 })));
  const base = crimeIndex(macro, seed);
  const H1 = planHoods(macro, seed), H2 = planHoods(buildMacroPlan(new Terrain(makeProfile({ seed, size: 0.4 }))), seed);
  check(H1.list.length >= 3 && H1.list.map((h) => h.name).join() === H2.list.map((h) => h.name).join() && H1.of.join() === H2.of.join(), `news: neighbourhoods deterministic (${H1.list.length}: ${H1.list.slice(0, 4).map((h) => h.name).join(', ')} …)`);
  check(new Set(H1.list.map((h) => h.name)).size === H1.list.length, 'news: every neighbourhood has its own name');
  check(macro.cells.every((c, i) => (c.district === 'water') === (H1.of[i] < 0)), 'news: every land block is in a neighbourhood');
  check(policePresence(0.05) > 0.85 && policePresence(0.3) > policePresence(0.5) && policePresence(0.7) < 0.1 && beatPairs(policePresence(0.05)) === 3 && beatPairs(policePresence(0.6)) === 0
    && policeCarWeight(policePresence(0.05)) > 10 * policeCarWeight(policePresence(0.7)) && responseFactor(policePresence(0.05)) < 0.7 && responseFactor(policePresence(0.7)) > 1.6,
    'news: low crime index, many police (cars, the beat, quick response); high index, hardly any');
  const F = planFactions(macro, seed, base, CITY_GROUPS);
  const start = safeStart(macro, base, (i) => F.holder[i] >= 0);
  const land = base.filter((v) => v > 0).slice().sort();
  check(start >= 0 && F.holder[start] < 0 && base[start] <= land[Math.floor(land.length * 0.25)], `news: a fresh game starts in a calm block nobody's gang holds (index ${base[start]?.toFixed(2)})`);
  const L = new LiveIndex(base, H1.near);
  const c0 = H1.list[0].cells[0];
  const before = L.live[c0];
  for (let k = 0; k < 5; k++) L.bump(c0, LIVE.escaped);
  check(L.live[c0] > before + 0.1 && H1.near[c0].every((n) => base[n] <= 0 || L.live[n] >= base[n]), 'news: crimes that come off raise the index (and a little next door)');
  const saved = JSON.parse(JSON.stringify(L.save()));
  const L2 = new LiveIndex(base, H1.near);
  L2.restore(saved);
  check(Math.abs(L2.live[c0] - L.live[c0]) < 0.002 && L2.live.every((v, i) => Math.abs(v - L.live[i]) < 0.002), 'news: the live index survives a save');
  L2.restore([[c0, 'x'], 'junk', [-4, 3], null]);
  check(L2.live.every((v, i) => v === base[i]), 'news: a damaged index loads as the seeded one');
  for (let k = 0; k < 40; k++) L.relax(300, () => false);
  check(Math.abs(L.live[c0] - base[c0]) < 0.01, 'news: the index relaxes back over time');
  const holder = () => null;
  const r1 = rollOffScreen(seed, 7, H1, L, macro, 22, 'normal', 0, 0, holder), r2 = rollOffScreen(seed, 7, H1, L, macro, 22, 'normal', 0, 0, holder);
  check(JSON.stringify(r1) === JSON.stringify(r2), 'news: off-screen crime is seeded');
  let off = 0, stopped = 0, nearP = 0, safeN = 0, roughN = 0;
  const rough = (i: number) => base[i] > 0.5, safe = (i: number) => base[i] > 0 && base[i] < 0.2;
  for (let k = 0; k < 600; k++) for (const c of rollOffScreen(seed, k, H1, L, macro, 21, 'normal', 0, 0, holder)) {
    off++; if (c.stopped) stopped++;
    if (Math.hypot(macro.cells[c.cell].centroid[0], macro.cells[c.cell].centroid[1]) < 450 - macro.cells[c.cell].radius) nearP++;
    if (rough(c.cell)) roughN++; else if (safe(c.cell)) safeN++;
  }
  const nRough = base.filter((v, i) => rough(i)).length, nSafe = base.filter((v, i) => safe(i)).length;
  check(off > 100 && stopped > 0 && stopped < off && nearP === 0, `news: crime happens all over the city, away from the player, some stopped (${off} in 600 ticks, ${stopped} stopped)`);
  check(nSafe === 0 || nRough === 0 || roughN / nRough > 2 * (safeN / nSafe), `news: rough blocks see far more crime than safe ones (${(roughN / Math.max(1, nRough)).toFixed(1)} vs ${(safeN / Math.max(1, nSafe)).toFixed(1)} per block)`);
  check(rollOffScreen(seed, 3, H1, L, macro, 12, 'off', 0, 0, holder).length === 0, 'news: crime setting off: nothing off-screen either');
  const kinds = ['snatch', 'mugging', 'robbery', 'racket', 'tagging', 'brawl', 'hijack', 'ritual', 'bomber', 'rising', 'falling', 'turf'] as const;
  let bad = 0;
  for (const w of kinds) for (const end of ['stopped', 'escaped', 'hero', 'none'] as const) {
    const it = { what: w, hood: 'Ashville', end, t: 30, group: 'The Harbour Kings' };
    for (const txt of [headline(it), gossip(it, 33, 0.3), gossip(it, 60, 0.9)]) if (/[{}]|undefined/.test(txt) || !txt.includes('Ashville')) bad++;
  }
  check(bad === 0, `news: every story reads right on a billboard and in a passer-by's mouth (${bad} bad)`);
  check(whenWord(30, 30.2) === 'just now' && whenWord(2, 30) === 'last night' && whenWord(10, 40) === 'yesterday', 'news: when words');
  check(['safe', 'quiet', 'mixed', 'rough', 'dangerous'].every((s) => localRemark(s as Safety, 0.5).length > 5) && safetyOf(0.05) === 'safe' && safetyOf(0.8) === 'dangerous', 'news: a word about the streets for every level');
  console.log(`news: ${H1.list.length} neighbourhoods, ${off} off-screen crimes in 600 ticks (${stopped} stopped), start block index ${base[start].toFixed(2)}, in ${(performance.now() - t0).toFixed(0)} ms`);
}

// Screen overlays (health tags, target brackets, speech bubbles): one projection for all of them,
// right in front of and behind the camera with either depth convention (src/render/screen.ts).
{
  const s = screenPoint();
  let bad = 0;
  for (const rev of [false, true]) {
    const cam = new THREE.PerspectiveCamera(60, 1.6, 0.05, 60000);
    (cam as unknown as { _reversedDepth: boolean })._reversedDepth = rev;
    cam.position.set(10, 2, 5); cam.lookAt(10, 2, -5); cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    for (const d of [0.5, 3, 40, 900]) {
      if (!onScreen(toScreen(10.2, 2.1, 5 - d, cam, s)) || s.depth < d * 0.99) bad++; // ahead
      if (toScreen(10.2, 2.1, 5 + d, cam, s).front || onScreen(s)) bad++; // behind
    }
    if (onScreen(toScreen(10, 2, 5.03, cam, s))) bad++; // just behind the lens
  }
  check(bad === 0, `screen: overlays only for what is in front of the camera, with or without reversed depth (${bad} wrong)`);
  // Nothing else may project world points to the screen on its own: `.project(` with a `z > 1`
  // test lets things behind the camera through (mirrored) under the reversed depth buffer.
  const strays: string[] = [];
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir)) {
      const full = `${dir}/${f}`;
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.ts$/.test(f) || full.endsWith('render/screen.ts')) continue;
      const txt = readFileSync(full, 'utf8');
      if (/\.project\(\s*[\w.]*cam/i.test(txt)) strays.push(full);
    }
  };
  walk('src');
  check(strays.length === 0, `screen: every world-to-screen overlay goes through src/render/screen.ts (${strays.join(', ') || 'none elsewhere'})`);
  // Markers over people need them in sight: same side of the ground, no wall in between.
  let wall = Infinity;
  const fake = { terrain: { height: () => 0 }, buildingAt: () => null, raycast: () => ({ t: wall, building: null }) } as unknown as SightWorld;
  // The camera's side is the game's own flag, not its depth: in a shallow sewer it is barely under the street.
  let camUnder = false;
  const see = makeSight(fake, () => camUnder, (_x, y) => y < -1.5), cam = new THREE.PerspectiveCamera();
  const look = (under: boolean, cy: number, feet: number): boolean => { camUnder = under; cam.position.set(0, cy, 0); return see(20, feet, 0, cam); };
  const street = look(false, 2, 0), sewer = look(true, -0.8, -2.4), fromStreet = look(false, 2, -2.4), fromSewer = look(true, -0.8, 0);
  wall = 5;
  const walled = look(false, 2, 0);
  check(street && sewer && !fromStreet && !fromSewer && !walled, `screen: no tags through the ground or walls (street ${street}, sewer ${sewer}, sewer from street ${fromStreet}, street from sewer ${fromSewer}, through a wall ${walled})`);
}

// Station life: commuters come down the real entrance stairs (Pedestrians' own steps over the
// underground floors), cross by the underpass, wait, board, ride, get off and walk up and out;
// nobody stalls on a step, leaves the floor or ends up on the tracks.
{
  const { runLife } = await import('./metrolife');
  const t0 = performance.now();
  const terrain = new Terrain(makeProfile({ seed: 1, size: 0.5 }));
  const macro = buildMacroPlan(terrain);
  const r = runLife(macro, terrain, 1, 9, 150);
  check(r.stuck === 0 && r.offFloor === 0 && r.onTracks === 0 && r.floorGap < 0.3, `metro life: every commuter keeps to the floors (${r.stuck} stalled, ${r.offFloor} off the floor, ${r.onTracks} on the tracks, worst gap ${r.floorGap.toFixed(2)} m)`);
  check(r.boarded > 0 && r.alighted > 0 && r.left > 0 && r.crossed > 0, `metro life: people board, get off, cross and leave (${r.boarded} / ${r.alighted} / ${r.crossed} / ${r.left})`);
  // Pushed at the tracks, or knocked down onto them: nobody stays down there.
  const s = runLife(macro, terrain, 1, 9, 60, 1, true);
  check(s.onTracks === 0 && s.offFloor === 0, `metro life: shoved commuters stop at the platform edge, knocked-off ones climb back (${s.onTracks} on the tracks)`);
  console.log(`metro life: ${r.spawned} commuters, ${r.boarded} boarded, ${r.alighted} got off, ${r.left} walked out, in ${(performance.now() - t0).toFixed(0)} ms`);
}

// Motion capture: CMU BVH parsing and retargeting onto the clip library (tools/cmuBvh.ts).
cmuBvhChecks(check);

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('all checks passed');
