/**
 * Self test of the villain groups' Phase 4 (VILLAINS_PLAN §3.5–3.9), run by tools/selftest.ts (or on
 * its own: `npx tsx tools/villainTest.ts`): boss operations as threat events — a boss's crew takes
 * a site and works while the guards hold it, the hero beats the boss and the crew breaks, the work
 * finishes when left alone, the threat event follows the crew; the schedule of boss operations.
 * The eco-radicals (sabotage, the Beast-master's dogs, the tree waking) and the necromancers (the
 * raising, the procession of thralls, the dead rising, skeletons that only fight).
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
import type { Faction, FactionMap } from '../src/game/factions/Factions';
import { Sabotage } from '../src/game/crime/Sabotage';
import { Raising, RAISING } from '../src/game/crime/Raising';
import { Procession } from '../src/game/crime/Procession';
import { DogPack, DOGS, type PackWorld } from '../src/game/crime/DogPack';
import { ARCHETYPES, CITY_GROUPS } from '../src/game/factions/archetypes';
import { factionOutfit, lieutenantOutfit, bossOutfit, skeletonOutfit } from '../src/game/factions/outfits';
import { KINDS } from '../src/game/crime/kinds';

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
    // A park: two trees (the far one taller), a parked car, nothing in the way.
    trees: () => [{ x: 700, z: 300, nx: 0, nz: 1, height: 9 }, { x: 720, z: 300, nx: 0, nz: 1, height: 14 }],
    parked: () => [{ x: 650, z: 40, nx: 0, nz: 1 }],
    blocked: () => false,
    sabotage: (c) => { state.done.push(`sabotage:${c.kind}`); },
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
  for (const kind of ['heist', 'takeover', 'uprising', 'awakening', 'treewake', 'deadrise'] as const) {
    const M = mockWorld();
    const op = new BossOperation(M.world, 4242 + kind.length, kind);
    check(op.setup(), `boss op ${kind}: a site and a crew`);
    const P = BOSS_OP_SPECS[kind];
    const work = op.criminals.filter((c) => c.actor!.memo.work).length, guards = op.criminals.filter((c) => c.actor!.memo.guard).length;
    check(work === P.workers && guards >= P.guards[0] && guards <= P.guards[1] && op.boss === op.criminals[0] && !op.boss!.actor!.memo.work, `boss op ${kind}: ${work} workers, ${guards} guards and the boss out front (${op.criminals.length} people)`);
    if (kind === 'heist') check(op.site!.x === 400 && op.criminals.some((c) => c.actor!.armed === 'gun'), `boss op heist: at the bank (the tallest shop front), gunmen among the guards (${op.site!.x})`);
    if (kind === 'awakening') check(op.landmark === 'cathedral' && op.criminals.filter((c) => c.actor!.memo.work).every((c) => Math.abs(Math.hypot(c.actor!.memo.postX - op.site!.x, c.actor!.memo.postZ - op.site!.z) - BOSS_OP.circle) < 0.01), `boss op awakening: a circle before the cathedral first (${op.landmark})`);
    if (kind === 'uprising') check(op.site!.x === 600, 'boss op uprising: at the robot');
    if (kind === 'treewake') check(op.site!.x === 720 && op.criminals.filter((c) => c.actor!.memo.work).every((c) => Math.hypot(c.actor!.memo.postX - 720, c.actor!.memo.postZ - 300) > 1), `boss op treewake: a circle round the taller tree (${op.site!.x})`);
    if (kind === 'deadrise') check(op.landmark === 'cathedral', `boss op deadrise: before the cathedral (${op.landmark})`);
    const ev: string[] = [];
    M.drive(op, () => op.phase !== 'approach', 4000, ev);
    check(op.phase === 'commit' && ev.includes('commit') && M.state.police === 1, `boss op ${kind}: the crew in place, the work begins, the police are called (${op.phase}, ${ev.join(',')})`);
    // Left alone: the work finishes once, the world's effect fires, they make off.
    M.drive(op, () => op.done, Math.ceil((P.workFor + 5) / 0.05), ev);
    check(op.done && M.state.done.join() === kind && ev.filter((e) => e === 'done').length === 1 && op.phase === 'escape' && M.state.looks.has(op.look), `boss op ${kind}: left alone it is done once (${M.state.done.join(',')}, ${op.phase}, looks ${[...M.state.looks].join(',')})`);
    if (kind === 'heist') check(op.loot?.kind === 'cash' && op.loot.carrier === op.boss && op.boss!.actor!.held === 'cash', 'boss op heist: the boss makes off with the cash');
    if (kind === 'deadrise') check(op.skeletons.length === (P.rise ?? 0) + 2 && ev.filter((e) => e === 'risen').length === op.skeletons.length && op.skeletons.every((c) => c.actor!.hostile && c.actor!.memo.guard), `boss op deadrise: ${op.skeletons.length} skeletons risen and guarding (${P.rise} during, 2 at the end)`);
    if (kind !== 'deadrise') check(op.skeletons.length === 0 && !ev.includes('risen'), `boss op ${kind}: nobody raised`);
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
  ecoNecroChecks(check);
  void Rng;
  console.log(`villains phase 4: boss operations, eco-radicals and necromancers checked in ${(performance.now() - t0).toFixed(0)} ms`);
}

/** The eco-radicals and the necromancers (VILLAINS_PLAN §3.6, §3.8, §3.9). */
function ecoNecroChecks(check: Check): void {
  // ---- the groups: kinds, rivals, a boss's set piece, everyone dressed
  {
    const E = ARCHETYPES.eco, N = ARCHETYPES.necro;
    check(CITY_GROUPS.length === 6 && CITY_GROUPS.includes('eco') && CITY_GROUPS.includes('necro'), `groups: six kinds in a city (${CITY_GROUPS.join(',')})`);
    check(E.kinds.sabotage > 0 && N.kinds.raising > 0 && N.kinds.procession > 0 && E.kinds.raising === 0 && N.kinds.sabotage === 0 && ARCHETYPES.gang.kinds.sabotage === 0, 'groups: sabotage is the eco-radicals\' own, raisings and processions the necromancers\'');
    check(E.rivals.includes('techno') && N.rivals.includes('cult') && ARCHETYPES.techno.rivals.includes('eco') && ARCHETYPES.cult.rivals.includes('necro'), 'groups: eco-radicals vs the techno-cult, necromancers vs the elemental cult');
    check(E.lieutenant.powers.includes('whistle') && N.lieutenant.powers.includes('drain') && BOSS_KINDS.eco.op === 'treewake' && BOSS_KINDS.necro.op === 'deadrise' && BOSS_KINDS.necro.power === 'curse', `groups: the Beast-master whistles, the Bone-caller drains; boss ops ${BOSS_KINDS.eco.op} and ${BOSS_KINDS.necro.op}`);
    for (const k of ['sabotage', 'raising', 'procession', 'treewake', 'deadrise'] as const) check(!!KINDS[k] && KINDS[k].resolved > 0, `kinds: ${k} has a row`);
    for (const a of ['eco', 'necro'] as const) {
      const f = { id: 0, archetype: a, name: a, palette: ARCHETYPES[a].palettes[0], emblem: '*', home: 0 } as unknown as Faction;
      const fo = factionOutfit(f, 7), lo = lieutenantOutfit(f, 7), bo = bossOutfit(f, 7);
      check(!!fo.chest && !!lo.chest && !!bo.chest && JSON.stringify(factionOutfit(f, 7)) === JSON.stringify(fo), `outfits: ${a} members, lieutenants and bosses dressed (seeded)`);
    }
    const sk = skeletonOutfit(null, 3) as unknown as Record<string, { defId: string; visual: { material: string } }>;
    check(sk.head.defId === 'skull' && sk.chest.visual.material === 'bones' && sk.legs.visual.material === 'bones', 'outfits: a skeleton is bones on black with a skull');
  }

  // ---- sabotage: the robot first, else a parked car; left alone the machines are wrecked
  {
    const M = mockWorld();
    const c = new Sabotage(M.world, 515);
    check(c.setup() && c.target === 'robot' && c.site!.x === 600, `sabotage: goes for the robot at the kerb (${c.target})`);
    const ev: string[] = [];
    M.drive(c, () => c.phase !== 'approach', 4000, ev);
    M.drive(c, () => M.state.done.length > 0, 2000, ev);
    check(M.state.done.join() === 'sabotage:sabotage' && ev.includes('done') && M.state.looks.has('wreck'), `sabotage: left alone the machines are wrecked (${M.state.done.join()})`);
    const M2 = mockWorld();
    M2.world.machines = () => [];
    const c2 = new Sabotage(M2.world, 516);
    check(c2.setup() && c2.target === 'car' && c2.site!.x === 650, `sabotage: no robot about, a parked car (${c2.target})`);
  }

  // ---- the raising: among the trees, the dead rise as the chant goes on; they only fight
  {
    const M = mockWorld();
    const c = new Raising(M.world, 616);
    check(c.setup() && Math.abs(c.site!.z - 305) < 1e-6 && c.criminals.length >= 2, `raising: a circle on open ground among the trees (${c.site!.x}, ${c.site!.z})`);
    const ev: string[] = [];
    M.drive(c, () => c.phase !== 'approach', 4000, ev);
    M.drive(c, () => c.skeletons.length >= 2, Math.ceil(RAISING.chantFor / 0.05), ev);
    const mid = c.skeletons.length;
    check(mid >= 2 && mid <= RAISING.rise && !ev.includes('done'), `raising: skeletons claw out while they chant (${mid})`);
    const sk = c.skeletons[0];
    check(sk.actor!.memo.skel === 1 && sk.actor!.hostile && sk.actor!.maxHp === 42, 'raising: a skeleton is a hostile member of the crime');
    // The hero walks up: a skeleton never runs or gives up, even badly hurt.
    M.player.x = sk.x + 1.2; M.player.z = sk.z;
    sk.actor!.hp = 5;
    M.drive(c, () => false, 30, ev);
    check(sk.actor!.state === 'fight' || sk.actor!.state === 'down' || sk.actor!.state === 'stagger', `raising: a hurt skeleton still fights (${sk.actor!.state})`);
    const M2 = mockWorld();
    const c2 = new Raising(M2.world, 617);
    c2.setup();
    const ev2: string[] = [];
    M2.drive(c2, () => c2.phase !== 'approach', 4000, ev2);
    M2.drive(c2, () => ev2.includes('done'), Math.ceil((RAISING.chantFor + 5) / 0.05), ev2);
    check(ev2.includes('done') && c2.risen === RAISING.rise + RAISING.riseAtEnd && ev2.filter((e) => e === 'risen').length === c2.risen, `raising: left alone, ${c2.risen} of the dead stand (${RAISING.rise} + ${RAISING.riseAtEnd} at the end)`);
  }

  // ---- the procession: walkers taken into a trance, led away; woken one by one or all at once
  const proc = (seed: number) => {
    const M = mockWorld();
    for (let i = 0; i < 6; i++) M.mk(100 + i, 120 + i * 2, 10 + (i % 2), 0, 0);
    const c = new Procession(M.world, seed);
    const ok = c.setup();
    const ev: string[] = [];
    M.drive(c, () => c.phase !== 'approach', 4000, ev);
    return { M, c, ok, ev };
  };
  {
    const { M, c, ok, ev } = proc(818);
    const n = c.entranced.length;
    check(ok && c.phase === 'commit' && n >= 3 && n <= 5 && c.entranced.every((a) => a.actor!.memo.thrall === 1 && a.actor!.role === 'victim'), `procession: the necromancer takes ${n} walkers into a trance`);
    // They follow the leader in a line.
    M.drive(c, () => false, 200, ev);
    const L = c.leader!, last = c.entranced[c.entranced.length - 1];
    check(Math.hypot(L.x - 120, L.z - 10) > 3 && Math.hypot(last.x - L.x, last.z - L.z) < 2.5 * (n + 3), `procession: the line walks after the leader (${Math.hypot(L.x - 120, L.z - 10).toFixed(1)} m on)`);
    // The hero wakes one (E).
    const a = c.entranced[0];
    M.player.x = a.x + 1; M.player.z = a.z;
    check(c.thrallNear(M.player.x, M.player.z) === a && c.wake(a) && !a.actor && c.woken === 1 && ev.concat(c.events.map((e) => e.type)).length >= 0, 'procession: the hero wakes one from the trance (released, unhurt)');
    c.events.length = 0;
    // The necromancer knocked out: everyone comes to at once.
    knockOut(M, L);
    M.drive(c, () => false, 4, ev);
    check(c.entranced.length === 0 && c.woken === n && c.taken === 0 && ev.filter((e) => e === 'woken').length >= n - 1, `procession: the necromancer down, all of them wake (${c.woken} of ${n})`);
  }
  {
    const { M, c, ev } = proc(819);
    const n = c.entranced.length;
    M.drive(c, () => !c.active || ev.includes('done'), 20000, ev);
    check(ev.includes('done') && c.taken === n && c.thralls.every((a) => !a.alive), `procession: left alone, all ${n} are led away into the dark`);
  }

  // ---- the Beast-master's dogs: at heel, then the hunt, bites, the whistle's lunge, beaten off
  {
    const player = { x: 30, y: 0, z: 0, height: 1.8, down: false };
    let hurt = 0, fighting = false, beaten = false;
    const W: PackWorld = { player, ground: () => 0, hurtPlayer: (d) => { hurt += d; }, sound: () => {}, random: Math.random };
    const H = { x: 0, z: 0, fighting: () => fighting, beaten: () => beaten };
    const P = new DogPack(W, H, 3, 4);
    const step = (sec: number) => { for (let t = 0; t < sec; t += 0.05) P.update(0.05); };
    step(3);
    check(P.dogs.length === 3 && P.dogs.every((d) => d.state === 'heel' && Math.hypot(d.x, d.z) < DOGS.heelR) && hurt === 0, 'dogs: at heel round a calm handler');
    fighting = true; player.x = 8;
    step(4);
    check(P.dogs.some((d) => d.state === 'bite') && P.stats.bites > 0 && hurt > 0, `dogs: the handler squares up, they run the hero down and bite (${P.stats.bites} bites, ${hurt.toFixed(0)} damage)`);
    player.x = 20;
    const n = P.sic(player.x, player.z);
    step(1.5);
    check(n === 3 && P.stats.lunges >= 1, `dogs: the whistle sends them lunging (${P.stats.lunges} landed)`);
    // A good punch floors one; it lies there, then slinks off.
    const d0 = P.dogs[0];
    const floored = P.hit(d0.x, d0.y + 0.4, d0.z, 0.05, 'blow', 6, 3).length;
    check(d0.state === 'down' && P.active.length === 3 - floored, `dogs: a punch floors a dog (${floored} in reach)`);
    step(DOGS.downT + 0.5);
    check(d0.state === 'flee' || d0.state === 'gone', `dogs: a floored dog runs off afterwards (${d0.state})`);
    // Fire sends them running; the handler beaten, the pack scatters and is gone.
    const d1 = P.dogs[1];
    P.hit(d1.x, d1.y + 0.4, d1.z, 0.8, 'fire', 1, 0);
    check(d1.state === 'flee', 'dogs: fire sends a dog running');
    beaten = true;
    step(DOGS.fleeFor + 1);
    check(P.done, `dogs: the handler beaten, the pack is gone (${P.dogs.map((d) => d.state).join(',')})`);
    // A giant hero: they never come at them.
    const Q = new DogPack({ ...W, player: { x: 4, y: 0, z: 0, height: 9, down: false } }, { x: 0, z: 0, fighting: () => true, beaten: () => false }, 3, 5);
    for (let t = 0; t < 2; t += 0.05) Q.update(0.05);
    check(Q.dogs.every((d) => d.state === 'flee'), 'dogs: a giant hero scares them off');
  }
}

// Run on its own: npx tsx tools/villainTest.ts
if (process.argv[1]?.endsWith('villainTest.ts')) {
  let failures = 0;
  await villainChecks((ok, msg) => { if (!ok) { failures++; console.error('  FAIL', msg); } });
  console.log(failures ? `${failures} failures` : 'all villain checks passed');
  process.exit(failures ? 1 : 0);
}
