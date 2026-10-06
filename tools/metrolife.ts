/**
 * Headless station life: commuters walking the real entrance stairs and underpasses (Pedestrians'
 * own stepping over the underground floors), waiting, boarding, riding, getting off and leaving.
 *   npx tsx tools/metrolife.ts [seed size seconds]
 */
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { Population } from '../src/sim/Population';
import { Pedestrians, PState, type PedAgent } from '../src/sim/Pedestrians';
import { tubeAt, boxAt, type Tube } from '../src/underground/Volumes';
import { trainsOn, carPose, CARS, CAR_L, CAR_W, CAR_FLOOR, DOOR_CLOSE, PLATFORM_H, PLATFORM_EDGE, metroTube } from '../src/underground/layout';
import { StationLife, type MetroCar, type MetroView } from '../src/game/metro/StationLife';
import { metroInput } from './metroaudit';
import { Rng } from '../src/core/rng';
import type { MacroPlan } from '../src/plan/types';

export interface LifeReport {
  spawned: number; boarded: number; alighted: number; left: number; crossed: number; stuck: number;
  /** Walkers that ended up below the platform edge on the tracks, or off any floor. */
  onTracks: number; offFloor: number;
  /** Worst gap between a walker's height and the floor under it (m). */
  floorGap: number;
  halls: number;
}

/** Run station life around the hall `hallIdx` for `secs` seconds. */
/**
 * `slow` (0 … 1) holds people back in the doors (a crowd, the player in the way): boarding and
 * alighting walk at that fraction of their pace, so the doors shut on some of them. `shove`: every few
 * seconds someone waiting is made to walk at the tracks for a while, and someone else is put down
 * on the track bed (as if knocked off the platform): neither may stay there.
 */
export function runLife(macro: MacroPlan, terrain: Terrain, seed: number, hallIdx: number, secs: number, slow = 1, shove = false): LifeReport {
  const { input } = metroInput(macro, terrain);
  const halls = input.halls;
  const tubes: Tube[] = [...macro.metroLines.map(metroTube), ...input.sewers, ...(input.passages ?? []).map((p) => p.tube)];
  const entrances = new Map<string, { passage: Tube | null; box: number }>();
  const underpasses = new Map<number, Tube>();
  (input.passages ?? []).forEach((p, i) => {
    const bi = halls.indexOf(p.hall);
    if (p.tube.underpass) underpasses.set(bi, p.tube); else entrances.set(`e${i}`, { passage: p.tube, box: bi });
  });
  const lineTubes = macro.metroLines.map(metroTube);
  const cars: MetroCar[] = [];
  const carLocal = (c: MetroCar, x: number, y: number, z: number) => {
    const ox = x - c.x, oz = z - c.z;
    return { u: ox * c.dx + oz * c.dz, v: -ox * c.dz + oz * c.dx, h: y - (c.y + CAR_FLOOR) };
  };
  const view: MetroView = {
    boxes: halls, cars, entrances, underpasses, carLocal,
    carWorld: (c, u, v) => [c.x + c.dx * u - c.dz * v, c.z + c.dz * u + c.dx * v],
  };
  const floorAt = (x: number, y: number, z: number): number | null => {
    let best: number | null = null;
    for (const t of tubes) { const h = tubeAt(t, x, y, z); if (h && h.floor <= y + 0.6 && (best === null || h.floor > best)) best = h.floor; }
    for (const b of halls) { const h = boxAt(b, x, y, z); if (h && h.floor <= y + 0.6 && (best === null || h.floor > best)) best = h.floor; }
    for (const c of cars) {
      if (Math.abs(c.x - x) > 10 || Math.abs(c.z - z) > 10) continue;
      const L = carLocal(c, x, y, z), f = c.y + CAR_FLOOR;
      if (Math.abs(L.u) < CAR_L / 2 && Math.abs(L.v) < CAR_W / 2 + 0.1 && f <= y + 0.6 && f > y - 1.5 && (best === null || f > best)) best = f;
    }
    return best;
  };
  const pop = new Population(macro, seed);
  const world = { bridgeDeck: () => -Infinity };
  const peds = new Pedestrians(pop, null as never, world as never, terrain, macro, null as never);
  peds.underFloor = floorAt;
  const life = new StationLife(view, { spawnAt: (c, x, z, h) => peds.spawnAt(c, x, z, h), citizen: (s) => pop.synthetic(s) }, macro.metroLines, ((r) => () => r.float())(new Rng(seed * 31 + hallIdx)));
  const hall = halls[hallIdx];
  const px = hall.cx, pz = hall.cz, py = hall.y0 + PLATFORM_H;
  const P = peds as unknown as { rebuildGrid(): void; step(a: PedAgent, dt: number, g: number): void; remove(i: number): void };
  const rep: LifeReport = { spawned: 0, boarded: 0, alighted: 0, left: 0, crossed: 0, stuck: 0, onTracks: 0, offFloor: 0, floorGap: 0, halls: 0 };
  const dt = 1 / 30;
  const bad = new Set<PedAgent>();
  const pushed = new Map<PedAgent, { left: number; b: (typeof halls)[number] }>(), dropped = new Set<PedAgent>();
  const knocked = new Map<PedAgent, { up: number; b: (typeof halls)[number] }>();
  for (let t = 0; t < secs; t += dt) {
    // Pedestrians first (as in the game), then the trains move, then station life places its riders.
    P.rebuildGrid();
    for (let i = peds.agents.length - 1; i >= 0; i--) {
      const a = peds.agents[i];
      P.step(a, dt, dt);
      if (!a.alive) P.remove(i);
    }
    cars.length = 0;
    macro.metroLines.forEach((line, li) => {
      trainsOn(line, 3600 + t).forEach((tr, k) => { for (let c = 0; c < CARS; c++) {
        const p = carPose(lineTubes[li], tr, c);
        if (p) cars.push({ line: li, k, slot: tr.dir * ((CARS - 1) / 2 - c), dir: tr.dir, x: p.x, y: p.y, z: p.z, dx: p.dx, dz: p.dz, dwell: tr.dwell, left: tr.left, next: tr.next, open: tr.dwell && tr.left > DOOR_CLOSE });
      } });
    });
    life.update(dt, px, py, pz);
    if (slow < 1) for (const q of life.list) if ((q.mode === 'board' || q.mode === 'alight') && q.a.actor) q.a.actor.speed *= slow;
    if (shove) {
      const waiting = life.list.filter((q) => q.mode === 'wait' && !q.seated && q.hall >= 0 && !bad.has(q.a));
      if (Math.floor(t / 4) !== Math.floor((t - dt) / 4) && waiting.length >= 3) {
        pushed.set(waiting[0].a, { left: 3, b: halls[waiting[0].hall] });
        const q = waiting[1], b = halls[q.hall];
        q.a.x = b.cx; q.a.z = b.cz; q.a.y = b.y0;
        dropped.add(q.a);
        // Knocked flying at the tracks (as by a blow); up again after a while (CrimeSystem's upkeep).
        const k = waiting[2].a, kb = halls[waiting[2].hall], d = Math.hypot(kb.cx - k.x, kb.cz - k.z) || 1;
        k.state = PState.Down; k.stateT = 0; k.vx = (kb.cx - k.x) / d * 4; k.vz = (kb.cz - k.z) / d * 4; k.vy = 2.5;
        knocked.set(k, { up: t + 2.5, b: kb });
      }
      // Knocked over inside a train standing at the platform, lying there as it pulls out.
      const rider = life.list.find((q) => q.mode === 'ride' && !knocked.has(q.a) && halls.some((b) => boxAt(b, q.a.x, q.a.y + 0.5, q.a.z)));
      if (rider && Math.floor(t / 4) !== Math.floor((t - dt) / 4)) {
        const kb = halls.find((b) => boxAt(b, rider.a.x, rider.a.y + 0.5, rider.a.z))!;
        rider.a.state = PState.Down; rider.a.stateT = 0; rider.a.vx = rider.a.vz = 0; rider.a.vy = 0.5;
        knocked.set(rider.a, { up: t + 30, b: kb });
      }
      for (const [k, w] of knocked) {
        if (k.state === PState.Down && t >= w.up) { k.state = PState.Idle; k.vx = k.vz = k.vy = 0; k.stateT = 0; }
        if (t < w.up + 0.2) continue;
        knocked.delete(k);
        // Up again: not on the track bed (if still one of the commuters or not).
        const h = boxAt(w.b, k.x, k.y + 0.5, k.z);
        if (k.alive && h && Math.abs(h.v) < PLATFORM_EDGE - 0.3 && k.y < w.b.y0 + 0.5) rep.onTracks++;
      }
      for (const [a, p] of pushed) {
        if (p.left <= 0 || !a.actor) { pushed.delete(a); continue; }
        p.left -= dt;
        a.actor.goal = { x: p.b.cx * 2 - a.x, z: p.b.cz * 2 - a.z };
        a.actor.speed = 1.4;
      }
    }
    // Walkers stay on floors: never down on the tracks, never off a floor.
    for (const q of life.list) {
      if (q.mode === 'ride' || bad.has(q.a)) continue;
      if (dropped.delete(q.a) || knocked.has(q.a)) continue;
      const a = q.a, f = floorAt(a.x, a.y + 0.5, a.z);
      if (f === null) { rep.offFloor++; bad.add(a); continue; }
      if (t > 1) rep.floorGap = Math.max(rep.floorGap, Math.abs(f - a.y));
      for (const b of halls) {
        const h = boxAt(b, a.x, a.y + 0.5, a.z);
        if (h && Math.abs(h.v) < PLATFORM_EDGE - 0.3 && a.y < b.y0 + 0.5 && !cars.some((c) => Math.abs(carLocal(c, a.x, a.y, a.z).u) < CAR_L / 2 && Math.abs(carLocal(c, a.x, a.y, a.z).v) < CAR_W / 2)) { rep.onTracks++; bad.add(a); }
      }
      if (a.state === PState.Down && !knocked.has(a)) bad.add(a);
    }
  }
  Object.assign(rep, life.stats);
  rep.halls = halls.length;
  return rep;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tools/metrolife.ts')) {
  const [seed = 1, size = 0.5, secs = 240] = process.argv.slice(2).map(Number);
  const terrain = new Terrain(makeProfile({ seed, size }));
  const macro = buildMacroPlan(terrain);
  for (const hi of [0, 3, 7]) {
    const t0 = performance.now();
    const r = runLife(macro, terrain, seed, hi, secs);
    console.log(`seed ${seed} hall ${hi}: ${JSON.stringify(r)} in ${(performance.now() - t0).toFixed(0)} ms`);
  }
}
