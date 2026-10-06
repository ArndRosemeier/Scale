/**
 * Self test of the villain groups' Phase 4 (VILLAINS_PLAN §3.5–3.9), run by tools/selftest.ts (or on
 * its own: `npx tsx tools/villainTest.ts`): boss operations as threat events — a boss's crew takes
 * a site and works while the guards hold it, the hero beats the boss and the crew breaks, the work
 * finishes when left alone, the threat event follows the crew; the schedule of boss operations.
 * Mocked world (no three.js scene): people move straight to their goals.
 */
import { Rng } from '../src/core/rng';
import { makeActor, attach } from '../src/sim/actors/Actor';
import type { PedAgent } from '../src/sim/Pedestrians';
import type { Crime, CrimeWorld } from '../src/game/crime/Crime';
import { Combat } from '../src/game/Combat';
import { BossOperation, BOSS_OP_SPECS, BOSS_OP } from '../src/game/crime/BossOp';
import { BossEvent } from '../src/game/threats/BossEvent';
import { planBosses, bossOpChance, saveBosses, restoreBosses, BOSS_OP as BOSS_SCHED, BOSS_KINDS, NOTORIETY } from '../src/game/factions/Bosses';
import type { FactionMap } from '../src/game/factions/Factions';

type Check = (ok: boolean, msg: string) => void;

/** A small mocked city for crimes: agents, a player, shop doors, walls, a landmark and a robot. */
export function mockWorld() {
  const agents: PedAgent[] = [];
  let id = 1;
  const mk = (seed: number, x: number, z: number, heading: number, state = 2): PedAgent => {
    const a = { id: id++, cit: { seed, role: 1, gender: seed & 1, age: 0.3, nerve: 0.5, curiosity: 0.3 }, x, z, y: 0, heading, speed: 1.3, pref: 1.3, state, route: Float32Array.from([x, z, 0]), wp: 1, dest: null, fear: 0, fearX: 0, fearZ: 0, lookX: 0, lookZ: 0, lookY: 0, stateT: 0, onRoad: false, phase: 0, look: seed, vy: 0, vx: 0, vz: 0, alive: true, slot: -1 } as unknown as PedAgent;
    agents.push(a);
    return a;
  };
  const combat = new Combat({ knockDown: (a, fx, fz, power) => { a.state = 5; a.stateT = 0; const d = Math.hypot(a.x - fx, a.z - fz) || 1; a.vx = ((a.x - fx) / d) * power; a.vz = ((a.z - fz) / d) * power; if (a.actor && a.actor.state !== 'ko') { a.actor.state = 'down'; a.actor.upT = 2; } } });
  const player = { x: 0, y: 0, z: 0, vx: 0, vz: 0, height: 1.8, flying: false, strength: 1, down: false };
  const state = { time: 0, police: 0, hurt: 0, done: [] as string[], looks: new Set<string>() };
  const doors = [{ x: 180, z: 40, nx: 0, nz: 1 }, { x: 200, z: 40, nx: 0, nz: 1 }];
  const world: CrimeWorld = {
    get time() { return state.time; }, hour: 14, player,
    agents: () => agents,
    neighbours: (x, z, r) => agents.filter((a) => a.alive && Math.hypot(a.x - x, a.z - z) < r),
    spawn: (seed, x, z, h, role) => { const a = mk(seed, x, z, h, 2); attach(a, makeActor(role, -1)); return a; },
    route: (ax, az, bx, bz) => Float32Array.from([ax, az, 0, bx, bz, 0]),
    visible: () => false, emit: () => {}, sound: () => {}, combat,
    hurtPlayer: (d) => { state.hurt += d; }, callPolice: () => { state.police++; }, random: Math.random,
    shops: () => doors,
    walls: () => doors.map((d) => ({ ...d, bay: 2.2 })),
    banks: () => [{ x: 400, z: 40, nx: 0, nz: 1 }],
    machines: () => [{ x: 600, z: 40, nx: 0, nz: 1 }],
    landmarks: () => [{ x: 900, z: 90, nx: 0, nz: -1, kind: 'museum' }, { x: 1000, z: 90, nx: 0, nz: -1, kind: 'cathedral' }],
    opFx: (look) => { state.looks.add(look); },
    bossOpDone: (c) => { state.done.push(c.kind); },
  };
  /** Step a crime: actors walk to their goals, the knocked-down get up. */
  const drive = (c: Crime, until: () => boolean, max: number, ev: string[]) => {
    for (let i = 0; i < max && !until(); i++) {
      state.time += 0.05;
      for (const a of agents) {
        const act = a.actor;
        if (!a.alive || !act) continue;
        act.stateT += 0.05; act.attackT -= 0.05; act.replanT -= 0.05; act.staggerT = Math.max(0, act.staggerT - 0.05);
        if (act.state === 'down') { act.upT -= 0.05; if (act.upT <= 0) { a.state = 2; act.state = 'run'; act.stateT = 0; } continue; }
        if (act.state === 'ko' || act.state === 'surrender' || act.state === 'arrested') continue;
        const g = act.goal;
        if (g) { const dx = g.x - a.x, dz = g.z - a.z, d = Math.hypot(dx, dz); const s = Math.min(d, act.speed * 0.05); if (d > 1e-6) { a.x += (dx / d) * s; a.z += (dz / d) * s; a.heading = Math.atan2(-dx, -dz); } }
      }
      c.update(0.05);
      for (const e of c.events) ev.push(e.type);
      c.events.length = 0;
    }
  };
  return { agents, mk, combat, player, state, world, drive };
}

/** Knock someone out (a few heavy punches from the hero standing next to them). */
function knockOut(M: ReturnType<typeof mockWorld>, a: PedAgent): number {
  let n = 0;
  for (let i = 0; i < 30 && a.actor && a.actor.state !== 'ko' && a.actor.state !== 'surrender'; i++) {
    M.player.x = a.x + 0.9; M.player.z = a.z;
    M.combat.hitActor(a, -900, 120, 0, 'punch', 'player', M.player.x, M.player.z);
    if (a.actor.memo) a.actor.memo.shieldT = 0;
    n++;
  }
  return n;
}

export async function villainChecks(check: Check): Promise<void> {
  const t0 = performance.now();

  // ---- boss operations: one per archetype, the crew takes its site
  for (const kind of ['heist', 'takeover', 'uprising', 'awakening'] as const) {
    const M = mockWorld();
    const op = new BossOperation(M.world, 4242 + kind.length, kind);
    check(op.setup(), `boss op ${kind}: a site and a crew`);
    const P = BOSS_OP_SPECS[kind];
    const work = op.criminals.filter((c) => c.actor!.memo.work).length, guards = op.criminals.filter((c) => c.actor!.memo.guard).length;
    check(work === P.workers && guards >= P.guards[0] && guards <= P.guards[1] && op.boss === op.criminals[0] && !op.boss!.actor!.memo.work, `boss op ${kind}: ${work} workers, ${guards} guards and the boss out front (${op.criminals.length} people)`);
    if (kind === 'heist') check(op.site!.x === 400 && op.criminals.some((c) => c.actor!.armed === 'gun'), `boss op heist: at the bank (the tallest shop front), gunmen among the guards (${op.site!.x})`);
    if (kind === 'awakening') check(op.landmark === 'cathedral' && op.criminals.filter((c) => c.actor!.memo.work).every((c) => Math.abs(Math.hypot(c.actor!.memo.postX - op.site!.x, c.actor!.memo.postZ - op.site!.z) - BOSS_OP.circle) < 0.01), `boss op awakening: a circle before the cathedral first (${op.landmark})`);
    if (kind === 'uprising') check(op.site!.x === 600, 'boss op uprising: at the robot');
    const ev: string[] = [];
    M.drive(op, () => op.phase !== 'approach', 4000, ev);
    check(op.phase === 'commit' && ev.includes('commit') && M.state.police === 1, `boss op ${kind}: the crew in place, the work begins, the police are called (${op.phase}, ${ev.join(',')})`);
    // Left alone: the work finishes once, the world's effect fires, they make off.
    M.drive(op, () => op.done, Math.ceil((P.workFor + 5) / 0.05), ev);
    check(op.done && M.state.done.join() === kind && ev.filter((e) => e === 'done').length === 1 && op.phase === 'escape' && M.state.looks.has(op.look), `boss op ${kind}: left alone it is done once (${M.state.done.join(',')}, ${op.phase}, looks ${[...M.state.looks].join(',')})`);
    if (kind === 'heist') check(op.loot?.kind === 'cash' && op.loot.carrier === op.boss && op.boss!.actor!.held === 'cash', 'boss op heist: the boss makes off with the cash');
  }

  // ---- the hero walks in: the guards fight, the workers carry on; the boss beaten, the crew breaks
  {
    const M = mockWorld();
    const op = new BossOperation(M.world, 777, 'heist');
    check(op.setup(), 'boss op (fight): setup');
    const ev: string[] = [];
    M.drive(op, () => op.phase !== 'approach', 4000, ev);
    M.drive(op, () => op.progress > 10, 400, ev);
    // The hero at the edge of the site: the crew engages, but the workers do not stop.
    const S = op.site!;
    M.player.x = S.x + S.nx * 14; M.player.z = S.z + S.nz * 14;
    const p0 = op.progress;
    M.drive(op, () => false, 60, ev);
    check(op.engaged && op.progress > p0 + 1.5 && op.phase === 'commit', `boss op: the hero comes, the crew fights, the vault is still being drilled (${op.progress.toFixed(1)} from ${p0.toFixed(1)}, ${op.phase})`);
    const fighting = op.criminals.filter((c) => c.actor!.memo.guard && c.actor!.state === 'fight').length;
    check(fighting >= 2, `boss op: the guards turn on the hero (${fighting} fighting)`);
    // The hero knocked down for a moment: plain guards back off — and come back once they are up.
    M.player.down = true;
    M.drive(op, () => false, 10, ev);
    const backed = op.criminals.filter((c) => c.actor!.memo.guard && !c.actor!.memo.lt && c.actor!.state === 'run').length;
    M.player.down = false;
    M.drive(op, () => false, 60, ev);
    const again = op.criminals.filter((c) => c.actor!.memo.guard && c.actor!.state === 'fight').length;
    check(backed >= 1 && again >= 2, `boss op: guards back off a floored hero and come back (${backed} backed off, ${again} fighting again)`);
    // The boss knocked out: the crew breaks, the work is never done.
    const boss = op.boss!;
    boss.actor!.maxHp = boss.actor!.hp = 60;
    const n = knockOut(M, boss);
    M.drive(op, () => op.broken, 20, ev);
    check(boss.actor!.state === 'ko' && op.broken && ev.includes('broken') && op.phase === 'escape', `boss op: the boss is knocked out (${n} blows) and the crew breaks (${op.phase}, ${ev.join(',')})`);
    M.player.x = 0; M.player.z = 0;
    M.drive(op, () => false, Math.ceil(op.spec.workFor / 0.05), ev);
    check(!op.done && !ev.includes('done'), 'boss op: broken, the vault is never cracked');
    const fled = op.criminals.filter((c) => c !== boss && (c.actor!.state === 'run' || c.actor!.state === 'gone' || c.actor!.state === 'surrender' || !c.alive)).length;
    check(fled >= op.criminals.length - 2, `boss op: with the boss down they run or give up (${fled} of ${op.criminals.length - 1})`);
  }

  // ---- all workers taken out: the work stops even with the boss standing
  {
    const M = mockWorld();
    const op = new BossOperation(M.world, 991, 'uprising');
    op.setup();
    const ev: string[] = [];
    M.drive(op, () => op.phase !== 'approach', 4000, ev);
    M.drive(op, () => op.progress > 5, 400, ev);
    for (const w of op.criminals.filter((c) => c.actor!.memo.work)) { knockOut(M, w); M.drive(op, () => false, 2, ev); }
    M.player.x = 0; M.player.z = 0;
    const p0 = op.progress;
    M.drive(op, () => false, 200, ev);
    check(op.workers().length === 0 && op.progress === p0 && !op.done && op.phase !== 'commit', `boss op: every worker down, the hack stops (${op.progress.toFixed(1)}, ${op.phase})`);
  }

  // ---- the threat event follows the crew: targets for the response, strength, the end
  {
    const M = mockWorld();
    const op = new BossOperation(M.world, 3131, 'takeover');
    op.setup();
    const ev: string[] = [];
    M.drive(op, () => op.phase !== 'approach', 4000, ev);
    const E = new BossEvent(op, M.combat, 'test');
    const S = op.site!;
    const T = E.targetsNear(S.x, S.z, 40);
    check(E.active && E.strength() === 1 && T.length === op.criminals.length && Math.hypot(E.x - S.x, E.z - S.z) < 1e-6, `boss event: the whole crew are targets (${T.length}), strength 1`);
    // An officer's baton: credited to the police, never to the player.
    const t = T[1], a = (t as unknown as { a: PedAgent }).a;
    for (let i = 0; i < 12 && t.on !== false; i++) E.strike(t, 700, 150, 0, 'police');
    check(t.on === false && !a.actor!.hitByPlayer, `boss event: SWAT batons bring one down, not booked to the hero (${a.actor!.state})`);
    E.update(0.1);
    check(E.active && E.strength() < 1, `boss event: still on, strength ${E.strength().toFixed(2)}`);
    for (const c of op.criminals) knockOut(M, c);
    M.drive(op, () => false, 4, ev);
    E.update(0.1);
    check(!E.active && E.outcome === 'stopped' && op.wasSubdued, `boss event: the crew beaten, it is over (${E.outcome})`);
  }

  // ---- the schedule: calm groups rarely, hunted ones often; never while jailed or collapsed; saved
  {
    const F = { factions: (['gang', 'syndicate', 'techno', 'cult'] as const).map((a, i) => ({ id: i, archetype: a, name: a, palette: { name: 'x', map: '#fff', primary: [0, 0, 0], accent: [1, 1, 1] }, emblem: '*', home: 0 })) } as unknown as FactionMap;
    const B = planBosses(F, 42);
    check(B.every((b) => b.opAt === -1) && BOSS_KINDS.gang.op === 'takeover' && BOSS_KINDS.syndicate.op === 'heist' && BOSS_KINDS.techno.op === 'uprising' && BOSS_KINDS.cult.op === 'awakening', 'boss ops: one set piece per group kind, none yet');
    const b = B[1];
    check(bossOpChance(b, 0, 5, false) === 0 && bossOpChance(b, 0, 20, false) === BOSS_SCHED.chance.calm, `boss ops: a calm group's first one after ${BOSS_SCHED.gap.calm / 2} game hours`);
    b.opAt = 100;
    check(bossOpChance(b, 0, 120, false) === 0 && bossOpChance(b, NOTORIETY.hunted, 110, false) === BOSS_SCHED.chance.hunted && bossOpChance(b, NOTORIETY.wary, 110, false) === 0 && bossOpChance(b, NOTORIETY.wary, 119, false) === BOSS_SCHED.chance.wary, 'boss ops: the gap shrinks and the chance grows with notoriety');
    check(bossOpChance(b, NOTORIETY.hunted, 200, true) === 0 && bossOpChance({ ...b, jailedUntil: 300 }, NOTORIETY.hunted, 200, false) === 0, 'boss ops: none while collapsed or behind bars');
    const N = [0, 0, 0, 0];
    const R = planBosses(F, 42);
    restoreBosses(F, R, N, JSON.parse(JSON.stringify(saveBosses(F, B, N))));
    check(R[1].opAt === 100 && R[0].opAt === -1, 'boss ops: the last one is saved');
    const O = planBosses(F, 42);
    restoreBosses(F, O, N, [{ archetype: 'syndicate', name: 'x', jailedUntil: -1, beaten: 0, escapes: 0, jailed: 0, notoriety: 3 }]);
    check(O[1].opAt === -1, 'boss ops: an older save without it reads as none yet');
  }
  void Rng;
  console.log(`villains phase 4: boss operations checked in ${(performance.now() - t0).toFixed(0)} ms`);
}

// Run on its own: npx tsx tools/villainTest.ts
if (process.argv[1]?.endsWith('villainTest.ts')) {
  let failures = 0;
  await villainChecks((ok, msg) => { if (!ok) { failures++; console.error('  FAIL', msg); } });
  console.log(failures ? `${failures} failures` : 'all villain checks passed');
  process.exit(failures ? 1 : 0);
}
