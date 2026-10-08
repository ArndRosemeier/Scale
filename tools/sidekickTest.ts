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
import { MATE, MATE_POWERS, matePower, type MatePower, fightStyle, pickFoe, revives, mateLine, graveSpot, type MateSay } from '../src/game/sidekick/companionRules';
import { PropType } from '../src/plan/cell';
import { ROSTER, GIFTS, nextCost, nextWant, honoursWish, leaning, buyLine, giftLine, wishLine, askAnswer, answersCall, trustWord, type Gift, type Ranks, type Ask } from '../src/game/sidekick/growthRules';

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
  companionChecks(check);
}

/** Phase 2: the sidekick around (how they fight, what they say, the revival, the grave). */
function companionChecks(check: Check): void {
  const t0 = performance.now();
  const mid = { o: 0.5, c: 0.5, e: 0.5, a: 0.5, n: 0.5 };
  check(fightStyle('proud', mid) === 'boss' && fightStyle('steady', { ...mid, c: 0.7, a: 0.3 }) === 'boss', 'sidekick fight: the proud and the hard go for the boss');
  check(fightStyle('anxious', mid) === 'careful' && fightStyle('shy', mid) === 'careful' && fightStyle('cheerful', { ...mid, n: 0.8 }) === 'careful', 'sidekick fight: the nervous get people clear first');
  check(fightStyle('cheerful', mid) === 'brave' && fightStyle('kind', mid) === 'brave', 'sidekick fight: everyone else jumps in');
  const foes = [{ d: 5, maxHp: 40, lead: false, onHero: false }, { d: 14, maxHp: 220, lead: true, onHero: false }, { d: 8, maxHp: 40, lead: false, onHero: true }];
  check(pickFoe('boss', foes) === 1, 'sidekick fight: the boss-minded go for the leader');
  check(pickFoe('brave', foes) === 2, 'sidekick fight: the brave help with the one on the hero');
  check(pickFoe('brave', []) === -1, 'sidekick fight: nobody to fight');
  // Their power: by who they are, with luck in it; every power turns up; the same person, the same power.
  const pop = new Population(buildMacroPlan(new Terrain(makeProfile({ seed: 7, size: 0.4 }))), 7);
  const count: Record<string, number> = {};
  const byTrait = (k: 'o' | 'c' | 'e' | 'a' | 'n', hi: boolean, p: MatePower) => { let n = 0, m = 0; for (let i = 0; i < 3000; i++) { const c = pop.synthetic(5000 + i * 13), t = traitsOf(c); if ((t[k] > 0.62) !== hi) continue; n++; if (matePower(7, c.id, t) === p) m++; } return m / Math.max(1, n); };
  for (let i = 0; i < 3000; i++) { const c = pop.synthetic(5000 + i * 13); const p = matePower(7, c.id, traitsOf(c)); count[p] = (count[p] ?? 0) + 1; }
  check((Object.keys(MATE_POWERS) as MatePower[]).filter((p) => p !== 'dash').every((p) => (count[p] ?? 0) > 3000 * 0.06), `sidekick power: every power turns up (${Object.entries(count).map(([k, v]) => `${k} ${(v / 30).toFixed(0)} %`).join(', ')})`);
  check(byTrait('a', false, 'quake') > byTrait('a', true, 'quake') * 1.5 && byTrait('n', true, 'gust') > byTrait('n', false, 'gust') * 1.5 && byTrait('c', true, 'stun') > byTrait('c', false, 'stun') * 1.3, 'sidekick power: the disagreeable quake, the nervous gust, the dutiful stun more often');
  const c0 = pop.synthetic(5013);
  check(matePower(7, c0.id, traitsOf(c0)) === matePower(7, c0.id, traitsOf(c0)), 'sidekick power: the same person gets the same power');
  check(new Set([1, 2, 3, 4, 5, 6, 7, 8].map((sd) => matePower(sd, c0.id, traitsOf(c0)))).size > 1, 'sidekick power: another city, maybe another power');
  // The revival: about four in five, the same answer for the same count.
  let ok = 0;
  for (let k = 0; k < 4000; k++) if (revives(42, 1000 + (k >> 2), k & 3)) ok++;
  check(Math.abs(ok / 4000 - MATE.survive) < 0.03, `sidekick revival: about four in five come back (${(ok / 40).toFixed(1)} %)`);
  check(revives(42, 77, 1) === revives(42, 77, 1), 'sidekick revival: the same answer every time');
  // Words: every kind, every temperament.
  const kinds: MateSay[] = ['join', 'careful', 'boss', 'won', 'police', 'called', 'coming', 'back', 'idle', 'hurt'];
  check(kinds.every((w) => TEMPERAMENTS.every((t) => [0, 0.21, 0.5, 0.77, 0.999].every((u) => { const l = mateLine(w, t, u); return typeof l === 'string' && l.length > 2; }))), 'sidekick words: a line for every kind and temperament');
  check(new Set([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((u) => mateLine('idle', 'dreamy', u))).size > 2, 'sidekick words: more than one idle line');
  // The grave: in a cemetery, off its paths, clear of the stones, the same every time.
  const terrain = new Terrain(makeProfile({ seed: 42, size: 0.35 }));
  const macro = buildMacroPlan(terrain);
  let found = false;
  for (const cell of macro.cells) {
    if (cell.district === 'water') continue;
    const plan = planCell(macro, cell, terrain);
    if (!plan.cemeteries.length) continue;
    const g = graveSpot(plan, 42);
    check(!!g, `sidekick grave: a spot in the cemetery of cell ${cell.id}`);
    if (!g) break;
    found = true;
    const again = graveSpot(plan, 42);
    check(!!again && again.x === g.x && again.z === g.z && again.yaw === g.yaw, 'sidekick grave: the same spot every time');
    check(plan.cemeteries.some((c) => pointInPoly(c.outer, g.x, g.z)), 'sidekick grave: inside the cemetery');
    check(!plan.cemPaths.some((s) => pointInPoly(s.outer, g.x, g.z)), 'sidekick grave: not on a path');
    let clear = true;
    for (let i = 0; i < plan.props.length; i += 6) if (Math.hypot(plan.props[i + 1] - g.x, plan.props[i + 2] - g.z) < 1.6) clear = false;
    check(clear, 'sidekick grave: clear of the other graves');
    let tomb = false;
    for (let i = 0; i < plan.props.length; i += 6) if (plan.props[i] === PropType.Tomb && Math.hypot(plan.props[i + 1] - g.x, plan.props[i + 2] - g.z) < 23) tomb = true;
    check(tomb, 'sidekick grave: near the cemetery\'s tomb');
    break;
  }
  check(found, 'sidekick grave: the test city has a cemetery');
  console.log(`sidekick around: ${(performance.now() - t0).toFixed(0)} ms`);
  growthChecks(check);
}

/** Phases 3 and 4: what they buy, wishes, asks, trust. */
function growthChecks(check: Check): void {
  const mid = { o: 0.5, c: 0.5, e: 0.5, a: 0.5, n: 0.5 };
  check(nextCost('strength', {}) === ROSTER.strength.cost[0] && nextCost('strength', { strength: 3 }) === null && nextCost('fireball', { fireball: 1 }) === null, 'sidekick karma: prices by rank, nothing past the top');
  // What they save for follows who they are.
  const tally = (t: typeof mid) => { const c: Record<string, number> = {}; for (let w = 0; w < 400; w++) { const g = nextWant(t, {}, 9, 1000 + w, 0)!; c[g] = (c[g] ?? 0) + 1; } return c; };
  const hard = tally({ ...mid, a: 0.1 }), duty = tally({ ...mid, c: 0.92, a: 0.7 }), nerv = tally({ ...mid, n: 0.92, a: 0.7 }), flash = tally({ ...mid, o: 0.9, e: 0.9, a: 0.7 });
  const top = (c: Record<string, number>, ...gs: Gift[]) => gs.reduce((s, g) => s + (c[g] ?? 0), 0) / 400;
  check(top(hard, 'quake', 'strength', 'dash') > 0.6, `sidekick karma: the disagreeable go for hard hitters (${(top(hard, 'quake', 'strength', 'dash') * 100).toFixed(0)} %)`);
  check(top(duty, 'stun', 'shield', 'toughness') > 0.6, `sidekick karma: the dutiful go for stun, shield, toughness (${(top(duty, 'stun', 'shield', 'toughness') * 100).toFixed(0)} %)`);
  check(top(nerv, 'gust', 'shield', 'toughness', 'dash') > 0.6, `sidekick karma: the nervous go for wind, shield, escape (${(top(nerv, 'gust', 'shield', 'toughness', 'dash') * 100).toFixed(0)} %)`);
  check(top(flash, 'fireball', 'bolt') > 0.5, `sidekick karma: the curious and outgoing go for the flashy elements (${(top(flash, 'fireball', 'bolt') * 100).toFixed(0)} %)`);
  check(nextWant(mid, {}, 9, 5, 2) === nextWant(mid, {}, 9, 5, 2), 'sidekick karma: the same choice every time');
  const all: Ranks = {}; for (const g of GIFTS) all[g] = ROSTER[g].cost.length;
  check(nextWant(mid, all, 9, 5, 0) === null, 'sidekick karma: nothing left to want once they have it all');
  // Spending a whole career: every purchase is new, and passives come in ranks.
  { const r: Ranks = {}; const seen: string[] = []; for (let i = 0; i < 40; i++) { const w = nextWant(mid, r, 3, 77, i); if (!w) break; seen.push(w); r[w] = (r[w] ?? 0) + 1; }
    check(seen.length === GIFTS.reduce((s, g) => s + ROSTER[g].cost.length, 0), `sidekick karma: they end up with the whole roster (${seen.length} purchases)`); }
  // Wishes: trust and fit.
  const rate = (g: Gift, trust: number, t: typeof mid) => { let y = 0; for (let i = 0; i < 1000; i++) if (honoursWish(g, trust, t, (i + 0.5) / 1000)) y++; return y / 1000; };
  check(rate('shield', 90, mid) > rate('shield', 10, mid) + 0.3, `sidekick wish: trust makes them listen (${rate('shield', 90, mid)} vs ${rate('shield', 10, mid)})`);
  check(rate('quake', 50, { ...mid, a: 0.1 }) > rate('stun', 50, { ...mid, a: 0.1, c: 0.1 }), 'sidekick wish: a wish that suits them is taken more often');
  // Asks.
  const A = (k: Ask, trust: number, t = mid, temper: Parameters<typeof askAnswer>[3] = 'steady', fight = false) => askAnswer(k, trust, t, temper, { fight }, 0.4);
  check(A('help', 60).ok && A('come', 60).ok && A('back', 60).ok && A('home', 60).ok, 'sidekick asks: a trusting sidekick does what is asked, out of a fight');
  check(!A('back', 40, { ...mid, a: 0.2 }, 'proud', true).ok && A('back', 85, { ...mid, a: 0.2 }, 'proud', true).ok, 'sidekick asks: the proud will not hang back from a fight unless they trust you a lot');
  check(!A('home', 50, mid, 'steady', true).ok && A('home', 50, mid, 'anxious', true).ok, 'sidekick asks: nobody goes home mid-fight, but the anxious gladly do');
  check(!A('help', 2).ok, 'sidekick asks: the wary may not help');
  check((['help', 'back', 'home', 'come'] as Ask[]).every((k) => [0, 30, 90].every((tr) => [true, false].every((f) => A(k, tr, mid, 'grumpy', f).line.length > 3))), 'sidekick asks: always a reason');
  let calls = 0; for (let i = 0; i < 1000; i++) if (answersCall(10, (i + 0.5) / 1000)) calls++;
  check(answersCall(30, 0.99) && calls > 300 && calls < 900, `sidekick asks: a call is nearly always answered, the wary sometimes not (${calls / 10} % at trust 10)`);
  // Words.
  check(GIFTS.every((g) => TEMPERAMENTS.every((t) => [0, 0.5, 0.99].every((u) => buyLine(g, t, u).length > 5 && wishLine(true, g, t, u).length > 5 && wishLine(false, g, t, u).length > 5))), 'sidekick words: a line for every purchase and wish');
  check(TEMPERAMENTS.every((t) => giftLine(t, 0.2, 0.3).length > 3 && giftLine(t, 0.9, 0.7).length > 3) && [0, 25, 50, 70, 95].every((x) => trustWord(x).length > 3), 'sidekick words: thanks for gifts, trust in words');
  check(GIFTS.every((g) => leaning(g, mid) >= 0 && leaning(g, mid) <= 1), 'sidekick karma: leanings in range');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let failures = 0;
  sidekickChecks((ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); });
  if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
}
