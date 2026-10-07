/**
 * The trench war at the Front, run headlessly on a real city's realm: the Lumen's sentries against
 * the Murk's pushes (and optionally a raid), with the player standing in the trench or away.
 * Reports where the Murk fell (how far they got) and what the Lumen lost.
 *
 *   npx tsx tools/trenchsim.ts [seed] [size] [seconds] [player: away|trench|noMans]   (DICE=n: other dice)
 */
import { deepFor } from './deepsweep';
import { DeepField } from '../src/underground/deep/field';
import { Factions, type FactionHost } from '../src/underground/deep/Factions';
import { TrenchWar } from '../src/game/slimes/TrenchWar';
import type { DeepPlan } from '../src/underground/deep/plan';

export interface TrenchRun { spawned: number; killed: number; past: number; reachedLine: number; sentriesLost: number; playerHits: number; bolts: number; hits: number; sAtDeath: number[]; alive: string[] }

/**
 * Run the trench war for `secs` seconds; `player`: where the player stands. The game's dice
 * (`Math.random`) are seeded for the run (`rng`, default from the realm's seed), so a run repeats.
 */
export function runTrench(plan: DeepPlan, secs: number, player: 'away' | 'trench' | 'noMans' = 'away', rng = plan.seed): TrenchRun {
  const random = Math.random;
  let a = rng >>> 0;
  Math.random = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  try { return run(plan, secs, player); } finally { Math.random = random; }
}

function run(plan: DeepPlan, secs: number, player: 'away' | 'trench' | 'noMans'): TrenchRun {
  const field = new DeepField(plan.prims, plan.seed);
  const T = plan.trench;
  const at = (s: number, l: number) => { const x = T.x + T.ax * s + T.cx * l, z = T.z + T.az * s + T.cz * l; return { x, y: field.floorAt(x, T.y + 1.5, z, 5) ?? T.y, z }; };
  // No-man's land: its middle, a little off the Murk's lane (with a chasm, over the bridge on their side of it).
  const pp = player === 'trench' ? T.posts[0] : player === 'noMans' ? (T.chasm ? at((T.chasm.s + T.chasm.r + T.murkS) / 2, T.chasm.l - 2) : at((T.noMans[0] + T.noMans[1]) / 2, -4)) : { x: 1e6, y: 0, z: 1e6 };
  const out: TrenchRun = { spawned: 0, killed: 0, past: 0, reachedLine: 0, sentriesLost: 0, playerHits: 0, bolts: 0, hits: 0, sAtDeath: [], alive: [] };
  const sOf = (x: number, z: number) => (x - T.x) * T.ax + (z - T.z) * T.az;
  const host: FactionHost = {
    field, plan,
    player: () => ({ x: pp.x, y: pp.y, z: pp.z, h: 1.8, speed: 0 }),
    hurtPlayer: () => { out.playerHits++; },
    shovePlayer: () => {},
    sound: () => {},
    ground: () => 0,
    trust: () => 20,
    clear: (ax, ay, az, bx, by, bz) => field.lineClear(ax, ay, az, bx, by, bz, 0.3),
    onKill: (b) => {
      if (b.fac === 'murk') { out.killed++; out.sAtDeath.push(sOf(b.x, b.z)); } else if (b.role === 'sentry') out.sentriesLost++;
    },
    onLumenHurt: () => {},
  };
  const F = new Factions(host);
  const war = new TrenchWar(null, F, plan, field);
  for (const q of [...T.gapPosts, ...T.posts.slice(0, TrenchWar.sentries(plan, 0.7, 0.08))]) { const b = F.spawn('lumen', 'sentry', q.x, q.y, q.z, 'trench'); b.den = { ...q }; }
  F.areas.set('trench', 0);
  // A raid (RAID=n): n Murk out of the Warrens at once, a brute first from 9 on, as SlimeRealm sends them.
  const raid = Number(process.env.RAID ?? 0);
  if (raid) {
    const start = plan.nodes.find((q) => q.name === 'warrens')!, line = plan.nodes.find((q) => q.name === 'murkLine')!;
    const gaps = plan.nodes.filter((q) => q.name.startsWith('trench')), hall = plan.nodes.find((q) => q.name === 'hall')!;
    for (let i = 0; i < raid; i++) { const g = gaps[i % gaps.length]; const b = F.spawn('murk', i === 0 && raid >= 9 ? 'brute' : 'raider', start.x, start.y, start.z, 'raid'); b.wait = i * 0.6; F.goTo(b, line.id); b.path.push(...F.route(line.id, g.id), ...F.route(g.id, hall.id)); }
  }
  const dt = 1 / 30;
  const cam = { x: pp.x, y: pp.y, z: pp.z } as unknown as import('three').Vector3;
  const seen = new Set<number>();
  for (let t = 0; t < secs; t += dt) {
    war.update(dt, true, raid > 0, 0.45, 0.7, 0.08);
    F.update(dt, cam);
    if (process.env.TRACE && Math.round(t * 30) % 300 === 0) console.log(t.toFixed(0), 'murk', F.blobs.filter((b) => b.fac === 'murk' && b.mode !== 'dead').map((b) => `${b.mode[0]}${sOf(b.x, b.z).toFixed(0)}~${Math.hypot(b.x - pp.x, b.z - pp.z).toFixed(0)}`).join(' '), '| sentries', F.blobs.filter((b) => b.role === 'sentry' && b.mode !== 'dead').map((b) => `${b.mode[0]}${sOf(b.x, b.z).toFixed(0)}/${b.hp.toFixed(1)}`).join(' '));
    for (const b of F.blobs) {
      if (b.fac !== 'murk') continue;
      if (!seen.has(b.id)) { seen.add(b.id); out.spawned++; }
      const s = sOf(b.x, b.z);
      if (s < T.s + 2.5 && !(b as { line?: boolean }).line) { (b as { line?: boolean }).line = true; out.reachedLine++; }
      if (s < T.s - 2 && !(b as { past?: boolean }).past) { (b as { past?: boolean }).past = true; out.past++; }
    }
  }
  out.bolts = F.stats.bolts; out.hits = F.stats.boltHits;
  out.alive = F.blobs.filter((b) => b.fac === 'murk' && b.mode !== 'dead').map((b) => `${b.role} ${b.mode} s${sOf(b.x, b.z).toFixed(0)} l${((b.x - T.x) * T.cx + (b.z - T.z) * T.cz).toFixed(0)} y${(b.y - T.y).toFixed(1)} path${b.path.length}`);
  return out;
}

const isMain = process.argv[1]?.endsWith('trenchsim.ts');
if (isMain) {
  const seed = Number(process.argv[2] ?? 42), size = Number(process.argv[3] ?? 0.6), secs = Number(process.argv[4] ?? 300);
  const player = (process.argv[5] ?? 'away') as 'away' | 'trench' | 'noMans';
  // REALM=n: the realm below the n-th colony with one (default the first).
  const plan = deepFor(seed, size).plans[Number(process.env.REALM ?? 0)];
  if (!plan) { console.log('no realm'); process.exit(1); }
  console.log(`colony ${plan.hub}, ${plan.trench.style}`);
  const r = runTrench(plan, secs, player, process.env.DICE ? Number(process.env.DICE) : plan.seed);
  const T = plan.trench;
  const hist = new Map<string, number>();
  for (const s of r.sAtDeath) { const k = s > T.noMans[1] ? 'at their berm' : s > T.wire[1] ? "no-man's land" : s > T.wire[0] ? 'in the wire' : s > T.s - 2 ? 'at the line' : 'past the line'; hist.set(k, (hist.get(k) ?? 0) + 1); }
  console.log(`${secs} s, player ${player}: ${r.spawned} Murk came, ${r.killed} fell (${[...hist].map(([k, v]) => `${v} ${k}`).join(', ')}), ${r.reachedLine} reached the line, ${r.past} got past it; sentries lost ${r.sentriesLost}; bolts ${r.bolts}, hits ${r.hits}; player hit ${r.playerHits}x`);
}
