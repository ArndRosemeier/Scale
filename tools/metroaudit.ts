/**
 * Headless metro audit: builds the world plans for a few seeds and measures the metro
 * geometry (see metroAuditCore.ts). `npx tsx tools/metroaudit.ts [seed size ...]`
 */
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { planCell, ENTRANCE_L, ENTRANCE_W } from '../src/plan/cell';
import { CURB_H } from '../src/build/ground';
import { makeTube } from '../src/underground/Volumes';
import { metroTube, sewerTube, stationHalls, entranceRoute, routeEnv, PASSAGE_HW, PASSAGE_H } from '../src/underground/layout';
import { auditLines, auditPassages, type AuditInput } from './metroAuditCore';
import type { MacroPlan } from '../src/plan/types';

/** Geometry of a city's metro as the game builds it, with every entrance passage. */
export function metroInput(macro: MacroPlan, terrain: Terrain): { input: AuditInput; inHole: (x: number, z: number) => boolean } {
  const halls = stationHalls(macro);
  const lines = macro.metroLines.map((line) => ({
    line,
    tube: metroTube(line),
    stops: line.stations.map((sid, k) => ({ s: line.stationS[k], hall: halls.find((b) => b.station === sid && b.line === line.id) ?? null })),
  }));
  const sewers = macro.sewers.map((sw) => sewerTube(sw.pts, terrain, sw.culvert));
  // Entrances from the cell plans around the halls.
  const ground = (x: number, z: number) => terrain.height(x, z) + CURB_H;
  const holes: number[] = [];
  const passages: NonNullable<AuditInput['passages']> = [];
  for (const cell of macro.cells) {
    const [x0, z0, x1, z1] = cellBounds(cell.poly);
    if (!halls.some((b) => b.cx > x0 - 150 && b.cx < x1 + 150 && b.cz > z0 - 150 && b.cz < z1 + 150)) continue;
    const E = planCell(macro, cell, terrain).entrances;
    for (let i = 0; i < E.length; i += 6) {
      const hall = halls.find((b) => b.station === E[i + 4] && b.hall === E[i + 5] >> 1);
      if (!hall) continue;
      const r = entranceRoute(hall, E[i], E[i + 1], E[i + 2], E[i + 3], ground, routeEnv([...lines.map((l) => l.tube), ...sewers], halls, hall));
      passages.push({ name: `${macro.metroStations[E[i + 4]].name} hall ${E[i + 5] >> 1} end ${E[i + 5] & 1}`, tube: makeTube('passage', r.pts, PASSAGE_HW, PASSAGE_H), hall, ground });
      holes.push(E[i], E[i + 1], E[i + 2], E[i + 3]);
    }
  }
  const inHole = (x: number, z: number) => {
    for (let i = 0; i < holes.length; i += 4) {
      const dx = x - holes[i], dz = z - holes[i + 1];
      const u = dx * holes[i + 2] + dz * holes[i + 3], v = -dx * holes[i + 3] + dz * holes[i + 2];
      if (Math.abs(u) < ENTRANCE_L / 2 + 0.3 && Math.abs(v) < ENTRANCE_W / 2 + 0.3) return true;
    }
    return false;
  };
  return { input: { terrain, lines, sewers, halls, passages }, inHole };
}

function cellBounds(p: number[]): [number, number, number, number] {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]); }
  return [x0, z0, x1, z1];
}

const fmt = (o: object) => JSON.stringify(o, (_k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v));

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tools/metroaudit.ts')) {
  const args = process.argv.slice(2).map(Number);
  const runs: [number, number][] = [];
  for (let i = 0; i + 1 < args.length; i += 2) runs.push([args[i], args[i + 1]]);
  if (!runs.length) runs.push([1, 0.26], [5, 0.35], [3, 0.6]);
  for (const [seed, size] of runs) {
    const t0 = performance.now();
    const terrain = new Terrain(makeProfile({ seed, size }));
    const macro = buildMacroPlan(terrain);
    const { input, inHole } = metroInput(macro, terrain);
    console.log(`seed ${seed} size ${size}: ${macro.metroLines.length} lines, ${macro.metroStations.length} stations, ${input.halls.length} halls, ${input.passages?.length} entrances (${(performance.now() - t0).toFixed(0)} ms)`);
    for (const r of auditLines(input)) console.log('  line', fmt(r));
    const P = auditPassages(input, inHole);
    const bad = P.filter((p) => p.maxSlope > 0.65 || p.floorErr > 0.05 || p.ceilingOut > 0 || p.hits > 0 || !p.endsOnPlatform);
    const worst = (k: keyof (typeof P)[0]) => Math.max(...P.map((p) => Number(p[k])));
    console.log(`  entrances: ${P.length}, worst slope ${worst('maxSlope').toFixed(2)}, floor err ${worst('floorErr').toFixed(2)}, ceiling over street ${worst('ceilingOut').toFixed(2)}, cutting other volumes ${P.filter((p) => p.hits).length}, not ending on the platform ${P.filter((p) => !p.endsOnPlatform).length}`);
    for (const p of bad.slice(0, 8)) console.log('   ', fmt(p));
  }
}
