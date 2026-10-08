/**
 * Travel speed per rank: flight (boost held) against super jump (W held, Space held for each
 * leap, pressed again on landing), on an open flat plain with the real Player and AbilitySystem
 * and the energy pool of a Normal game. `npx tsx tools/travelsim.ts`
 */
import * as THREE from 'three';
import { Player } from '../src/player/Player';
import { AbilitySystem } from '../src/game/abilities/AbilitySystem';
import { MAX_RANK } from '../src/game/abilities/tuning';


export interface TravelRun { avg: number; jumps: number; energyLeft: number; peak: number }

function makeInput() {
  const held = new Set<string>(), hits = new Set<string>();
  return {
    held, hits, touchRun: false, touchSlow: false, touchLook: false,
    down: (c: string) => held.has(c), hit: (c: string) => hits.has(c),
  };
}

function makePlayer(): Player {
  const world = { terrain: { waterLevel: () => -Infinity }, groundHeight: () => 0 } as any;
  // (The rig's asset load is held back: there is nothing to fetch headless.)
  const g = globalThis as any, fetch0 = g.fetch;
  g.fetch = () => new Promise(() => {});
  let p: Player;
  try { p = new Player(1, world); } finally { g.fetch = fetch0; }
  (p as any).updateRig = () => {};
  p.collision = {
    collide: (x: number, z: number) => ({ x, z, hit: false }),
    groundAt: () => 0, ceilingAt: () => Infinity, underground: () => false, under: null, skimHoles: false,
  } as any;
  p.pos.set(0, 0, 0); p.vel.set(0, 0, 0); p.grounded = true; p.height = 1.8;
  return p;
}

export function simTravel(mode: 'flight' | 'jump', rank: number, seconds = 60, react = 0.12, forward = true): TravelRun {
  const p = makePlayer();
  const ranks: Record<string, number> = { flight: mode === 'flight' ? rank : 0, superJump: mode === 'jump' ? rank : 0 };
  const prog = { sandbox: false, bonusMax: 0, bonusRegen: 0, rank: (id: string) => ranks[id] ?? 0, unlocked: () => true, slots: [] } as any;
  const ab = new AbilitySystem(prog, p, {} as any, new THREE.PerspectiveCamera());
  const inp = makeInput();
  const dt = 1 / 60;
  if (forward) inp.held.add('KeyW');
  let jumps = 0, landT = 0, wasGround = true, peak = 0;
  for (let t = 0; t < seconds; t += dt) {
    inp.hits.clear();
    if (mode === 'flight') {
      if (t < dt) inp.hits.add('KeyF');
      inp.held.add('ShiftLeft');
    } else {
      if (p.grounded && !wasGround) landT = t;
      if (p.grounded && t - landT >= react && (ab as any).charge < 0) { inp.hits.add('Space'); inp.held.add('Space'); jumps++; }
      wasGround = p.grounded;
    }
    ab.preUpdate(dt, inp as any);
    p.update(dt, inp as any, 0, 0);
    peak = Math.max(peak, p.pos.y);
  }
  return { avg: Math.hypot(p.pos.x, p.pos.z) / seconds, jumps, energyLeft: ab.energy, peak };
}

if (process.argv[1]?.endsWith('travelsim.ts')) {
  for (let r = 1; r <= MAX_RANK; r++) {
    const f = simTravel('flight', r), j = simTravel('jump', r);
    console.log(`rank ${r}: flight ${f.avg.toFixed(1)} m/s | jump ${j.avg.toFixed(1)} m/s (${j.jumps} leaps, peak ${j.peak.toFixed(0)} m, energy left ${j.energyLeft.toFixed(0)})`);
  }
}
