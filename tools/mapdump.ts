/**
 * Headless debug map: `npx tsx tools/mapdump.ts <seed> <size> [out.png] [zoomWidthMeters] [cx] [cz]`
 */
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { Raster } from './raster';

const DISTRICT_COLOR: Record<string, number> = {
  downtown: 0x6b5b95, commercial: 0x8a7cb0, oldtown: 0xb5835a, apartments: 0x9a8f7d, rowhouses: 0xa8746a,
  suburban: 0x8faa7a, industrial: 0x707a80, port: 0x5d7f99, park: 0x3f7f3f, water: 0x2a5d8a,
};

const seed = Number(process.argv[2] ?? 1);
const size = Number(process.argv[3] ?? 0.35);
const out = process.argv[4] ?? `map_${seed}_${size}.png`;
const t0 = performance.now();
const profile = makeProfile({ seed, size });
const terrain = new Terrain(profile);
const t1 = performance.now();
const plan = buildMacroPlan(terrain);
const t2 = performance.now();
console.log(`profile`, JSON.stringify({ ...profile, arch: undefined }));
console.log(`terrain ${(t1 - t0).toFixed(0)} ms, macro ${(t2 - t1).toFixed(0)} ms: ${plan.nodes.length} nodes, ${plan.edges.length} edges, ${plan.cells.length} cells, ${plan.bridges.length} bridges, ${plan.metroLines.length} metro lines, ${plan.metroStations.length} stations`);
const counts: Record<string, number> = {};
for (const c of plan.cells) counts[c.district] = (counts[c.district] ?? 0) + 1;
console.log(counts);

const W = 1400;
const ras = new Raster(W, W);
const span = Number(process.argv[5] ?? profile.radius * 2.6);
ras.view(Number(process.argv[6] ?? 0), Number(process.argv[7] ?? 0), span);
// Terrain hillshade + water
ras.shade((x, z) => {
  const wl = terrain.waterLevel(x, z);
  const h = terrain.height(x, z);
  if (wl > -Infinity && wl > h) return 0x1d4f7a;
  const e = span / W;
  const dx = terrain.height(x + e, z) - h, dz = terrain.height(x, z + e) - h;
  const shade = Math.max(0, Math.min(1, 0.6 + (dx - dz) * 0.6 / e * 0.5));
  const t = Math.max(0, Math.min(1, h / 120));
  const r = (60 + 90 * t) * shade, g = (80 + 60 * t) * shade, b = (55 + 50 * t) * shade;
  return ((r | 0) << 16) | ((g | 0) << 8) | (b | 0);
});
for (const c of plan.cells) ras.fill([c.poly], DISTRICT_COLOR[c.district] ?? 0xff00ff, 0.55);
for (const e of plan.edges) ras.polyline(e.pts, e.bridge ? 0xffcc33 : e.cls === 0 ? 0xffffff : 0xd0d0d0, e.cls === 0 ? 3 : 1.5);
for (const l of plan.metroLines) ras.polyline(l.pts, l.color, 2);
for (const s of plan.metroStations) ras.dot(s.x, s.z, 4, 0xffffff);
for (const n of plan.nodes) if (n.kind) ras.dot(n.x, n.z, 2, n.kind === 1 ? 0x00ffff : 0xff00ff);
for (const c of plan.centres) ras.dot(c.x, c.z, 6, 0xff3060);
ras.dot(plan.core[0], plan.core[1], 5, 0xffaa00);
ras.save(out);
console.log('wrote', out);
