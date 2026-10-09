/**
 * Self test of the Leviathan (game/threats/leviathan, THREATS_PLAN §1 #2), run by tools/selftest.ts (or
 * on its own: `npx tsx tools/leviathanTest.ts`): its way up the river for 20 cities (a river with
 * bridges, entering in the city, stops in the water just off each deck, in order, the way along the
 * channel), the same way for the same seed, and the clock (the Strider still first, the Leviathan
 * among the later majors with its own omens).
 */
import { planLeviathanRoute, LEVI_ROUTE } from '../src/game/threats/leviathan/leviRoute';
import { ThreatClock, FIRST_MAJOR, isMajor } from '../src/game/threats/ThreatClock';
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { boundaryAt } from '../src/world/boundary';
import { bridgeProfiles } from '../src/build/bridges';

type Check = (ok: boolean, msg: string) => void;

export function leviathanChecks(check: Check): void {
  routeChecks(check);
  clockChecks(check);
}

function routeChecks(check: Check): void {
  let found = 0, ok = 0;
  const lens: number[] = [];
  for (let seed = 1; seed <= 20; seed++) {
    const terrain = new Terrain(makeProfile({ seed, size: 0.6 }));
    const macro = buildMacroPlan(terrain);
    const R = planLeviathanRoute(macro, terrain, seed);
    if (!R) continue;
    found++;
    const inside = Math.hypot(R.start.x, R.start.z) <= boundaryAt(macro.boundary, R.start.x, R.start.z) * LEVI_ROUTE.edgeShare + 15;
    let wet = 0;
    for (let i = 0; i < R.pts.length; i += 2) if (terrain.water(R.pts[i], R.pts[i + 1]).d < terrain.water(R.pts[i], R.pts[i + 1]).halfWidth) wet++;
    const wetShare = wet / (R.pts.length / 2);
    let ordered = R.stops.length > 0 && R.stops.some((st) => st.kind === 'bridge');
    for (let i = 0; i < R.stops.length; i++) {
      const st = R.stops[i];
      if (st.s < 0 || st.s > R.length + 1 || (i && st.s <= R.stops[i - 1].s)) ordered = false;
      if (st.kind === 'bridge' && Math.hypot(st.x - st.tx, st.z - st.tz) > LEVI_ROUTE.offDeck + 25) ordered = false;
    }
    const good = inside && wetShare > 0.9 && ordered && R.length > 30 && R.length < LEVI_ROUTE.lead + LEVI_ROUTE.span + 50;
    if (good) ok++;
    else check(false, `leviathan route: seed ${seed}: starts inside ${inside}, ${(wetShare * 100).toFixed(0)}% in the channel, stops ${R.stops.map((s) => `${s.kind}@${Math.round(s.s)}`).join(' ')}, ${Math.round(R.length)} m`);
    lens.push(Math.round(R.length));
  }
  check(found >= 10 && ok === found, `leviathan route: up a river in the city to its bridges, stops in order off each deck (${ok}/${found} cities with a bridged river of 20; ${lens.join(' ')} m)`);
  const tA = new Terrain(makeProfile({ seed: 42, size: 0.6 })), tB = new Terrain(makeProfile({ seed: 42, size: 0.6 }));
  const a = planLeviathanRoute(buildMacroPlan(tA), tA, 9), b = planLeviathanRoute(buildMacroPlan(tB), tB, 9);
  check(JSON.stringify(a) === JSON.stringify(b), 'leviathan route: deterministic per seed');
  nearChecks(check);
}

/** Dev spawn at the nearest bridge: from the middle of any river bridge's deck, the way goes to that bridge. */
function nearChecks(check: Check): void {
  let decks = 0, hit = 0;
  const miss: string[] = [];
  for (let seed = 1; seed <= 12; seed++) {
    const terrain = new Terrain(makeProfile({ seed, size: 0.6 }));
    const macro = buildMacroPlan(terrain);
    for (const p of bridgeProfiles(macro, terrain)) {
      const sm = (p.s0 + p.s1) / 2, x = p.ax + p.dx * sm, z = p.az + p.dz * sm;
      const w = terrain.water(x, z);
      if (w.river < 0 || w.d > w.halfWidth + 4) continue;
      decks++;
      const R = planLeviathanRoute(macro, terrain, seed, { x, z });
      const last = R?.stops[R.stops.length - 1];
      if (R && last?.kind === 'bridge' && last.edge === p.edge && R.length < LEVI_ROUTE.lead + 60) hit++;
      else miss.push(`seed ${seed} edge ${p.edge}: ${R ? R.stops.map((s) => `${s.kind}${s.edge}@${Math.round(s.s)}`).join(' ') : 'none'}`);
    }
  }
  check(decks >= 10 && hit >= decks * 0.9, `leviathan route: spawn at the nearest bridge goes straight to the hero's bridge (${hit}/${decks} river decks${miss.length ? '; missed ' + miss.slice(0, 4).join(', ') : ''})`);
}

function clockChecks(check: Check): void {
  let firstOk = 0, seen = 0, omensOk = true;
  for (const seed of [42, 7, 1234, 5, 99, 11, 2024, 3]) {
    const c = new ThreatClock(seed);
    const out: { type: string; arch: string; kind?: string }[] = [];
    for (let t = 0; t < 14 * 3600; t++) for (const s of c.tick(1, t % 15 === 0 ? 1 : 0, 0)) out.push({ type: s.type, arch: s.archetype, kind: s.type === 'omen' ? s.kind : undefined });
    const majors = out.filter((s) => s.type === 'event' && isMajor(s.arch));
    if (majors.length && majors[0].arch === FIRST_MAJOR) firstOk++;
    if (majors.some((m) => m.arch === 'leviathan')) seen++;
    for (const o of out) if (o.type === 'omen' && o.arch === 'leviathan' && o.kind !== 'wake' && o.kind !== 'surge') omensOk = false;
  }
  check(firstOk === 8 && seen >= 2 && omensOk, `threat clock: the Strider still comes first (${firstOk}/8), the Leviathan among the later majors (${seen}/8 cities in 14 h) with its own omens`);
}

// (Run on its own: npx tsx tools/leviathanTest.ts)
if (process.argv[1]?.endsWith('leviathanTest.ts')) {
  let fails = 0;
  leviathanChecks((ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; });
  process.exit(fails ? 1 : 0);
}
