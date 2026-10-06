import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { marvelHall } from '../src/plan/marvelParts';
import { landmarkParts } from '../src/plan/landmarkParts';
import { LandmarkSolids } from '../src/world/LandmarkSolids';
const terrain = new Terrain(makeProfile({ seed: 873738, size: 1 }));
const macro = buildMacroPlan(terrain);
const lm = macro.landmarks.find((l) => /Starship/.test(l.name))!;
const S = new LandmarkSolids(macro, terrain);
const h = marvelHall(lm);
console.log('hall', !!h, h?.levels.slice(0, 4), 'parts', landmarkParts(lm, terrain).length);
if (h) {
  const f = h.design.floors.find((f) => f.fn === 'gallery')!;
  const u = (f.q[0][0] + f.q[2][0]) / 2, v = (f.q[0][1] + f.q[2][1]) / 2;
  const c = Math.cos(lm.angle), s = Math.sin(lm.angle);
  for (const [x, z] of [[lm.x + u * c - v * s, lm.z + u * s + v * c], [lm.x + u * c + v * s, lm.z - u * s + v * c]]) console.log('gallery y', f.y, 'top', S.topAt(x, z, f.y + 0.2, 0.5));
}
