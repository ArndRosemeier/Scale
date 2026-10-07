/**
 * Self test of the second shard (game/sidekick, SIDEKICK_PLAN phase 1), run by tools/selftest.ts
 * (or on its own: `npx tsx tools/sidekickTest.ts`): where it turns up (a park or a square, clear of
 * buildings, inside the map's circle, the same every time), who says yes to it and who says no,
 * what people say, and that the news has words for it.
 */
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { planCell } from '../src/plan/cell';
import { pointInPoly } from '../src/core/geom2';
import { Population } from '../src/sim/Population';
import { traitsOf, TEMPERAMENTS } from '../src/game/people/identity';
import { SHARD, shardCells, resolveShard, sceptic, hasMatter, offerAnswer, accepts, answerLine, awakeningLines, type OfferFacts, type OfferAnswer } from '../src/game/sidekick/shardRules';
import { headline, gossip, storyKind } from '../src/game/news/headlines';

type Check = (ok: boolean, msg: string) => void;

export function sidekickChecks(check: Check): void {
  const t0 = performance.now();
  // Where it turns up: two cities (a big one takes minutes to plan), the hero at the city's middle.
  for (const [seed, size] of [[42, 0.35], [7, 0.6]] as const) {
    const terrain = new Terrain(makeProfile({ seed, size }));
    const macro = buildMacroPlan(terrain);
    const px = 0, pz = 0;
    const cells = shardCells(macro, seed, 0, px, pz);
    check(cells.length > 0 && cells.join() === shardCells(macro, seed, 0, px, pz).join(), `shard ${seed}/${size}: candidate cells, the same every time (${cells.length})`);
    check(cells.every((c) => macro.cells[c].district !== 'water'), `shard ${seed}/${size}: never on water`);
    check(shardCells(macro, seed, 1, px, pz).join() !== cells.join() || cells.length < 3, `shard ${seed}/${size}: the next shard (after a death) has its own order`);
    let site = null, tried = 0;
    for (const c of cells.slice(0, 24)) {
      tried++;
      site = resolveShard(macro, c, planCell(macro, macro.cells[c], terrain), terrain, seed, 0);
      if (site) break;
    }
    check(!!site, `shard ${seed}/${size}: a spot found within ${tried} cells`);
    if (!site) continue;
    const plan = planCell(macro, macro.cells[site.cell], terrain);
    const again = resolveShard(macro, site.cell, plan, terrain, seed, 0);
    check(!!again && again.x === site.x && again.z === site.z && again.zx === site.zx, `shard ${seed}/${size}: the same spot every time`);
    check(pointInPoly(macro.cells[site.cell].poly, site.x, site.z) && !plan.buildings.some((b) => pointInPoly(b.poly, site!.x, site!.z)), `shard ${seed}/${size}: in its cell, not inside a building`);
    const inShape = (site.kind === 'park' ? plan.parks : plan.plazas).some((p) => pointInPoly(p.outer, site!.x, site!.z));
    check(inShape, `shard ${seed}/${size}: on the ${site.kind} it says`);
    const dz = Math.hypot(site.x - site.zx, site.z - site.zz);
    check(dz < site.zr - 20 && dz > 5, `shard ${seed}/${size}: inside the map's circle, not at its middle (${dz.toFixed(0)} of ${site.zr} m)`);
    check(Math.abs(site.y - terrain.height(site.x, site.z)) < 0.01, `shard ${seed}/${size}: on the ground`);
    const d = Math.hypot(site.x - px, site.z - pz);
    console.log(`shard ${seed}/${size}: ${site.kind} in cell ${site.cell} (${macro.cells[site.cell].district}), ${d.toFixed(0)} m from the middle`);
  }

  // Who says yes: most people; children, people on duty, people who dislike the hero, people
  // against heroes on principle say no; a matter of their own comes first.
  const base: OfferFacts = { child: false, duty: false, rep: 35, opinion: 20, sceptic: false, matter: false, matterState: 'none' };
  const ans = (o: Partial<OfferFacts>): OfferAnswer => offerAnswer({ ...base, ...o });
  check(ans({}) === 'yes' && accepts(ans({})), 'shard offer: an ordinary person says yes');
  check(ans({ opinion: -5 }) === 'yes', 'shard offer: a stranger who does not mind the hero says yes');
  check(ans({ child: true }) === 'child' && ans({ duty: true }) === 'duty' && ans({ rep: -1 }) === 'rep' && ans({ opinion: -20 }) === 'dislike' && ans({ sceptic: true }) === 'principle', 'shard offer: children, people on duty, a hated hero, a disliked hero, sceptics say no');
  check(ans({ child: true, opinion: 80 }) === 'child', 'shard offer: a child says no however much they like the hero');
  check(ans({ matter: true }) === 'matter' && ans({ matter: true, matterState: 'open' }) === 'waiting' && ans({ matter: true, matterState: 'lost' }) === 'letdown' && ans({ matter: true, matterState: 'done' }) === 'grateful', 'shard offer: a matter of their own first, yes once the favour is done');
  check(!accepts('matter') && !accepts('waiting') && !accepts('letdown') && accepts('grateful'), 'shard offer: only yes and grateful hand it over');
  // How many: a few sceptics (more of the disagreeable), about a fifth with a matter.
  const pop = new Population(buildMacroPlan(new Terrain(makeProfile({ seed: 7, size: 0.4 }))), 7);
  const cits = Array.from({ length: 2000 }, (_, i) => pop.synthetic(9100 + i * 17));
  const sc = cits.filter((c) => sceptic(c, traitsOf(c))).length / cits.length;
  const mt = cits.filter((c) => hasMatter(c)).length / cits.length;
  check(sc > 0.04 && sc < 0.2, `shard offer: a few people against heroes on principle (${(sc * 100).toFixed(1)} %)`);
  check(Math.abs(mt - SHARD.matterShare) < 0.04, `shard offer: about a fifth with a matter of their own (${(mt * 100).toFixed(1)} %)`);
  const grumpy = cits.filter((c) => traitsOf(c).a < 0.35), nice = cits.filter((c) => traitsOf(c).a > 0.65);
  const share = (l: typeof cits) => l.filter((c) => sceptic(c, traitsOf(c))).length / Math.max(1, l.length);
  check(share(grumpy) > share(nice), `shard offer: the disagreeable are sceptics more often (${(share(grumpy) * 100).toFixed(0)} % vs ${(share(nice) * 100).toFixed(0)} %)`);
  check(sceptic(cits[3], traitsOf(cits[3])) === sceptic(cits[3], traitsOf(cits[3])) && hasMatter(cits[5]) === hasMatter(cits[5]), 'shard offer: the same answer every time');

  // Words: every answer, the one to look in on named; three lines for every temperament.
  const all: OfferAnswer[] = ['yes', 'grateful', 'child', 'duty', 'rep', 'dislike', 'principle', 'matter', 'waiting', 'letdown'];
  check(all.every((a) => [0, 0.5, 0.99].every((u) => { const l = answerLine(a, u, 'Hana', 'sister'); return l.length > 5 && !/[{}]/.test(l); })), 'shard offer: a line for every answer, tokens filled');
  check(answerLine('matter', 0, 'Hana', 'sister').includes('Hana') && answerLine('matter', 0.9, 'Hana', 'sister').includes('Hana'), 'shard offer: the matter names who to look in on');
  check(TEMPERAMENTS.every((t) => [0, 0.3, 0.7, 0.99].every((u) => { const l = awakeningLines(t, u); return l.length === 3 && l.every((x) => x.length > 3) && new Set(l).size === 3; })), 'shard: three different awakening lines for every temperament');

  // The news.
  const it = { what: 'shard' as const, hood: 'Mill Quarter', end: 'none' as const, t: 10 };
  check(headline(it).includes('glowing stone') && headline(it).includes('Mill Quarter') && storyKind(it) === 'city', `shard news: a headline (${headline(it)})`);
  check([0, 0.4, 0.8].every((u) => { const l = gossip(it, 12, u); return l.includes('Mill Quarter') && !/[{}]/.test(l); }), 'shard news: people talk about it');
  console.log(`sidekick shard: ${(performance.now() - t0).toFixed(0)} ms`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let failures = 0;
  sidekickChecks((ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); });
  if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
}
