/**
 * Which cities have which marvels (plan/marvelParts): `npx tsx tools/marvels.ts [size] [seeds] [first]`
 * lists, for each seed, its marvels (family, name, height, place) — a quick way to find a city with a
 * starship spire or a helix tower to look at. The family names follow MS in plan/marvelParts.
 */
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { landmarkParts } from '../src/plan/landmarkParts';
import { buildLandmarkMesh } from '../src/build/landmarks';

const FAMILY = ['starship', 'helix', 'porous', 'twist', 'skyship', 'halo', 'orbs', 'stack'];
const size = Number(process.argv[2] ?? 0.5);
const seeds = Number(process.argv[3] ?? 20);
const first = Number(process.argv[4] ?? 1);
for (let seed = first; seed < first + seeds; seed++) {
  const terrain = new Terrain(makeProfile({ seed, size }));
  const macro = buildMacroPlan(terrain);
  const ms = macro.landmarks.filter((l) => l.kind === 'marvel');
  const desc = ms.map((l) => {
    const parts = landmarkParts(l, terrain);
    const top = Math.max(...parts.map((p) => Math.max(p.y0, p.y1))) - l.base;
    const tris = buildLandmarkMesh(l, terrain, 0).build().index.length / 3;
    return `${FAMILY[l.style]} "${l.name}" ${top.toFixed(0)} m, ${parts.length} parts, ${(tris / 1000).toFixed(1)}k tris at (${l.x.toFixed(0)}, ${l.z.toFixed(0)})`;
  });
  console.log(`seed ${seed} (${terrain.profile.cls}, r ${terrain.profile.radius.toFixed(0)} m): ${desc.length ? desc.join('; ') : '—'}`);
}
