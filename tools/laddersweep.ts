/**
 * Check that every sewer ladder leads out: for each manhole shaft, a hero at the ladder's foot
 * must be in the sewer and get the shaft as the nearest manhole (the E prompt), and some cell
 * must place its lid on the street.
 *
 *   npx tsx tools/laddersweep.ts <sizes> <seedA-seedB>      e.g. npx tsx tools/laddersweep.ts 0.5,1 1-5
 */
// The underground builds materials and canvases on construction: enough of a browser to get through.
const anyStub: any = new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : k === 'length' ? 0 : anyStub), apply: () => anyStub, construct: () => anyStub, set: () => true });
const g = globalThis as any;
g.window ??= g;
g.document ??= { createElement: () => ({ getContext: () => anyStub, style: {}, width: 0, height: 0 }), addEventListener() {} };
g.addEventListener ??= () => {};

const { makeProfile } = await import('../src/world/settings');
const { Terrain } = await import('../src/world/terrain');
const { buildMacroPlan } = await import('../src/plan/macro');
const { Underground } = await import('../src/underground/Underground');
const { shaftPoint, LADDER_LAT } = await import('../src/underground/layout');

export function deadLadders(seed: number, size: number): { shafts: number; noPrompt: number; noLid: number; at: string[] } {
  const terrain = new Terrain(makeProfile({ seed, size }));
  const macro = buildMacroPlan(terrain);
  const u: any = new Underground(macro, terrain, { facade: { tileMeters: [] } } as any, (x, z) => terrain.height(x, z));
  const all = u.allShafts as any[];
  const lids = new Set<any>();
  for (const c of macro.cells) for (const m of u.cellShafts.get(c.id) ?? []) lids.add(m);
  let noPrompt = 0, noLid = 0;
  const at: string[] = [];
  for (const m of all) {
    // Where the hero stands at the ladder's foot (an arm's length off the rungs).
    const [x, y, z] = shaftPoint(m, LADDER_LAT - 0.5, 0, 0.5);
    const ok = u.inSewer(x, y, z) && u.nearestManhole(x, z, 3) === m;
    if (!ok) { noPrompt++; if (at.length < 5) at.push(`no E at ${x.toFixed(0)},${z.toFixed(0)}`); }
    if (!lids.has(m)) { noLid++; if (at.length < 5) at.push(`no lid at ${m.x.toFixed(0)},${m.z.toFixed(0)}`); }
  }
  return { shafts: all.length, noPrompt, noLid, at };
}

const sizes = (process.argv[2] ?? '0.5').split(',').map(Number);
const [a, b] = (process.argv[3] ?? '1-3').split('-').map(Number);
let bad = 0;
for (const size of sizes) for (let seed = a; seed <= (b ?? a); seed++) {
  const r = deadLadders(seed, size);
  bad += r.noPrompt + r.noLid;
  console.log(`seed ${seed} @${size}: ${r.shafts} ladders, ${r.noPrompt} without E, ${r.noLid} without a lid` + (r.at.length ? '; ' + r.at.join('; ') : ''));
}
console.log(bad ? `${bad} dead ladders` : 'every ladder leads out');
process.exit(bad ? 1 : 0);
