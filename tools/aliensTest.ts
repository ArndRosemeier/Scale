/**
 * Self test of the Wardens (game/aliens, ALIENS_PLAN phase 1), run by tools/selftest.ts (or on its
 * own: `npx tsx tools/aliensTest.ts`): how many discs are over the city when (a handful, stretches
 * of none, rare swarms of a hundred or more, then nothing; the same for the same seed and time),
 * walker visits and long stares, what people say about them, and the news and talk lines; phase
 * 2, the runaway teens: hiding under the roofs, getting seen, rewards, regard, lines, news, the clock.
 */
import { WARDENS, discPlan, walkerVisit, stareVisit, nannyLine, allNannyLines, type NannyMoment } from '../src/game/aliens/wardenRules';
import { TEMPERAMENTS } from '../src/game/people/identity';
import { headline, gossip, storyKind } from '../src/game/news/headlines';
import { LINES } from '../src/game/people/lines';
import { matches } from '../src/game/people/talk';
import { TEENS, teenHeight, inOpen, seeStep, teenReward, freshRegard, handOver, readRegard, teenLine, allTeenLines, type TeenMoment } from '../src/game/aliens/teenRules';
import { ARCHETYPES, planEvent } from '../src/game/threats/ThreatClock';

type Check = (ok: boolean, msg: string) => void;

export function aliensChecks(check: Check): void {
  // The disc schedule over 60 game days for a few cities.
  for (const seed of [42, 7, 1234]) {
    const days = 60, slots = (days * 24) / WARDENS.slot;
    let empty = 0, swarmSlots = 0, swarms = 0, maxN = 0, bad = 0, afterOk = true;
    let prevSwarm = false, sinceSwarm = 99;
    for (let i = 0; i < slots; i++) {
      const h = (i + 0.5) * WARDENS.slot;
      const p = discPlan(seed, h);
      if (p.count < 0 || (!p.swarm && p.count > 7) || (p.swarm && (p.count < WARDENS.swarm[0] || p.count > WARDENS.swarm[1]))) bad++;
      if (p.count === 0) empty++;
      if (p.swarm) { swarmSlots++; if (!prevSwarm) swarms++; }
      if (prevSwarm && !p.swarm) sinceSwarm = 0; else sinceSwarm++;
      // Then nothing: right after a swarm the sky is empty for a while (unless another one starts).
      if (!p.swarm && sinceSwarm < WARDENS.afterSwarm && p.count !== 0) afterOk = false;
      prevSwarm = !!p.swarm;
      maxN = Math.max(maxN, p.count);
    }
    check(bad === 0, `wardens ${seed}: disc counts in range (a handful, or a swarm of ${WARDENS.swarm.join('–')})`);
    check(empty / slots > 0.08 && empty / slots < 0.35, `wardens ${seed}: some stretches with no disc at all (${((empty / slots) * 100).toFixed(0)} % of the time)`);
    check(swarms >= 3 && swarmSlots / slots < 0.14, `wardens ${seed}: swarms now and then (${swarms} in ${days} days, ${((swarmSlots / slots) * 100).toFixed(1)} % of the time)`);
    check(afterOk, `wardens ${seed}: after a swarm the sky is empty for a while`);
    const a = [0, 7.3, 55.1, 300.9].map((h) => JSON.stringify(discPlan(seed, h)));
    const b = [0, 7.3, 55.1, 300.9].map((h) => JSON.stringify(discPlan(seed, h)));
    check(a.join() === b.join(), `wardens ${seed}: the same sky for the same seed and time (saves need nothing)`);
  }
  // Walkers and stares.
  let walkers = 0, stayOk = true, stares = 0;
  for (let h = 0; h < 2000; h++) {
    const v = walkerVisit(42, h);
    if (v) { walkers++; if (v.start < h || v.start > h + 1 || v.end - v.start < WARDENS.walkerStay[0] || v.end - v.start > WARDENS.walkerStay[1]) stayOk = false; }
  }
  for (let d = 0; d < 300; d++) { const s = stareVisit(42, d); if (s) { stares++; if (s.end <= s.start || Math.floor(s.start / 24) !== d) stayOk = false; } }
  check(walkers > 300 && walkers < 600 && stares > 70 && stares < 140 && stayOk, `wardens: a walker in about one hour in five (${walkers}/2000), a long stare on about a third of the days (${stares}/300), visits within their hour / day`);
  // What people say.
  const moments: NannyMoment[] = ['swarm', 'walker', 'disc', 'sky'];
  let silent = 0, said = 0;
  for (const m of moments) for (const t of TEMPERAMENTS) for (const u of [0, 0.3, 0.64, 0.66, 0.99]) {
    const l = nannyLine(m, t, false, u);
    if (t === 'shy') { if (l) silent = -999; continue; }
    if (!l) silent++; else said++;
  }
  const kids = moments.every((m) => !!nannyLine(m, 'shy', true, 0.2));
  check(silent === 0 && said > 100 && kids, `wardens: everyone but the shy has a word about the Nannies (${said} lines picked), children too`);
  check(allNannyLines().every((l) => l.length > 3 && l.length < 110 && !/[{}]/.test(l)), 'wardens: lines are short, no tokens left over');
  // News.
  const now = 30;
  for (const what of ['swarm', 'walker', 'stare'] as const) {
    const it = { what, hood: 'Oldmarket', end: 'none' as const, t: 29 };
    const h = headline(it), g = gossip(it, now, 0.4);
    check(h.length > 10 && !/[{}]/.test(h) && !/[{}]/.test(g) && storyKind(it) === 'city', `wardens news: ${what} → "${h}" / "${g}"`);
  }
  // Talk: the Nanny lines only when they are about.
  const base = { temper: 'chatty', child: false, interest: 'chess' } as unknown as Parameters<typeof matches>[1];
  const nw = LINES.news.filter((e) => e.when.nannies);
  check(nw.length >= 5 && nw.every((e) => !matches(e.when, { ...base, nannies: null }) && !matches(e.when, { ...base, nannies: 'sky' })), 'wardens talk: the Nanny news lines need a swarm, a walker or a disc near (not just one in the sky)');
  check(nw.some((e) => matches(e.when, { ...base, nannies: 'swarm' })) && nw.some((e) => matches(e.when, { ...base, nannies: 'walker' })) && nw.some((e) => matches(e.when, { ...base, nannies: 'disc' })), 'wardens talk: a line for a swarm, a walker and a disc');

  // Phase 2: the runaway teens.
  // Under the roofs they stay hidden; pods out lift them; with none left they bob up into the open.
  let hidden = true;
  for (const cover of [8, 12, 20, 35, 60, 120]) if (inOpen(teenHeight(cover, 0), cover) || (cover >= 20 && inOpen(teenHeight(cover, 1), cover))) hidden = false;
  check(hidden && inOpen(teenHeight(8, 1), 8), 'teens: under roofs (8–120 m round them) they keep hidden; a pod out, low roofs no longer hide them, taller ones do');
  check([5, 12, 40, 100].every((c) => inOpen(teenHeight(c, 3), c)) && teenHeight(20, 2) > teenHeight(20, 1) && teenHeight(20, 1) > teenHeight(20, 0), 'teens: each pod out lifts the saucer; all three out, it bobs up into the open');
  check(inOpen(teenHeight(0, 0), 0) && inOpen(teenHeight(2, 0), 2), 'teens: over open ground (a park, a square) there is no cover: seen');
  // Being seen: in the open ~2.4 s, in a cone three times faster, a moment in the open forgiven.
  const until = (open: boolean, cone: boolean) => { let s = 0, t = 0; while (s < 1 && t < 60) { s = seeStep(s, 0.05, open, cone); t += 0.05; } return t; };
  let blip = 0;
  for (let k = 0; k < 20; k++) blip = seeStep(blip, 0.05, true, false);
  for (let k = 0; k < 40; k++) blip = seeStep(blip, 0.05, false, false);
  check(Math.abs(until(true, false) - TEENS.seeT) < 0.1 && until(false, true) < 1 && until(false, false) >= 60 && blip < 0.15, `teens: seen in the open after ${until(true, false).toFixed(2)} s, in a cone after ${until(false, true).toFixed(2)} s, never under cover; a 1 s blip fades (${blip.toFixed(2)})`);
  const r0 = teenReward(0, false), r1 = teenReward(0, true), r2 = teenReward(2, false);
  check(r0.credit === null && r0.karma === 0 && r1.credit === 'herded' && r1.karma > 0 && r2.credit === 'caught' && r2.karma > r1.karma, 'teens: no credit for the hero far away; chasing it into the open earns some, knocking its pods out more');
  let reg = freshRegard();
  for (let k = 0; k < 3; k++) reg = handOver(reg);
  const back = readRegard(JSON.parse(JSON.stringify(reg))), junk = readRegard({ handed: -4, regard: 'x' });
  check(reg.handed === 3 && reg.regard === 3 && back.handed === 3 && junk.handed === 0 && junk.regard === 0 && readRegard(null).handed === 0, 'teens: Warden regard counts each hand-over, saves and restores, junk sanitised');
  let tSaid = 0, tSilent = 0;
  for (const m of ['prank', 'caught'] as TeenMoment[]) for (const t of TEMPERAMENTS) for (const u of [0, 0.3, 0.59, 0.61, 0.99]) {
    const l = teenLine(m, t, false, u);
    if (t === 'shy') { if (l) tSilent = -999; continue; }
    if (l) tSaid++; else tSilent++;
  }
  check(tSilent === 0 && tSaid > 50 && !!teenLine('prank', 'shy', true, 0.3) && allTeenLines().every((l) => l.length > 3 && l.length < 110 && !/[{}]/.test(l)), `teens: everyone but the shy has a word (${tSaid} picked), children too, lines short`);
  for (const end of ['hero', 'stopped', 'none'] as const) {
    const it = { what: 'teens' as const, hood: 'Oldmarket', end, t: 29 };
    const h = headline(it), gs = gossip(it, 30, 0.4);
    check(h.length > 10 && !/[{}]/.test(h) && !/[{}]/.test(gs) && storyKind(it) === (end === 'hero' ? 'hero' : 'city'), `teens news (${end}): "${h}" / "${gs}"`);
  }
  // On the threat clock: a minor archetype with omens of its own, and it comes up.
  const arch = ARCHETYPES.find((a) => a.id === 'teens');
  let teensPlanned = 0;
  for (let n = 1; n < 60; n++) if (planEvent(42, n, 'normal', 0, 0, 'robots').archetype === 'teens') teensPlanned++;
  check(!!arch && arch.tier === 'minor' && arch.omens.includes('zip') && arch.omens.includes('glyph') && teensPlanned > 8, `teens: a minor event on the threat clock (${teensPlanned} of 59 planned events after a robot one)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let fails = 0;
  aliensChecks((ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; });
  process.exit(fails ? 1 : 0);
}
