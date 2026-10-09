/**
 * Self test of the Burrower (game/threats/burrower, THREATS_PLAN §1 #3), run by tools/selftest.ts (or
 * on its own: `npx tsx tools/burrowerTest.ts`): the worm's skin (closed parts facing out, the bind
 * pose exact, sound volumes when it stands out of a hole and when it dives), its way under the city
 * for 20 cities (from the hero's side into downtown, breaches spaced out, the same for the same seed),
 * the sinkhole's crater (profile, mesh), and the clock (the Strider always first, then the worm among
 * the majors with its own omens).
 */
import * as THREE from 'three';
import { buildWormSkin } from '../src/game/threats/burrower/wormSkin';
import { WormRig, WORM_BONES, WORM_LENGTH } from '../src/game/threats/burrower/wormRig';
import { planBurrowerRoute, BURROW_ROUTE } from '../src/game/threats/burrower/burrowerRoute';
import { craterDepth, buildCrater, SINK } from '../src/game/threats/burrower/Sinkholes';
import { ThreatClock, CLOCK, FIRST_MAJOR, isMajor } from '../src/game/threats/ThreatClock';
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { boundaryAt } from '../src/world/boundary';

type Check = (ok: boolean, msg: string) => void;

export function burrowerChecks(check: Check): void {
  skinChecks(check);
  routeChecks(check);
  craterChecks(check);
  clockChecks(check);
}

function skinChecks(check: Check): void {
  const t0 = performance.now();
  const sk = buildWormSkin();
  const ms = performance.now() - t0;
  const nV = sk.position.length / 3;
  check(nV > 5000 && nV < 20000 && ms < 1500, `worm skin: ${nV} vertices, ${sk.index.length / 3} triangles, ${sk.parts.length} parts, built in ${ms.toFixed(0)} ms`);
  const vol = (P: Float32Array) => sk.parts.map((part) => {
    let V = 0;
    for (let t = part.i0; t < part.i1; t += 3) {
      const a = sk.index[t] * 3, b = sk.index[t + 1] * 3, c = sk.index[t + 2] * 3;
      V += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
    }
    return V;
  });
  // Closed: every edge of a part (welded) used once each way.
  let open = 0;
  for (const part of sk.parts) {
    const id = new Map<string, number>();
    const weld = (v: number) => { const k = `${Math.round(sk.position[v * 3] * 1e4)},${Math.round(sk.position[v * 3 + 1] * 1e4)},${Math.round(sk.position[v * 3 + 2] * 1e4)}`; let i = id.get(k); if (i === undefined) { i = id.size; id.set(k, i); } return i; };
    const edges = new Map<string, number>();
    for (let t = part.i0; t < part.i1; t += 3) {
      const a = weld(sk.index[t]), b = weld(sk.index[t + 1]), c = weld(sk.index[t + 2]);
      for (const [x, y] of [[a, b], [b, c], [c, a]]) if (x !== y) edges.set(`${x}>${y}`, (edges.get(`${x}>${y}`) ?? 0) + 1);
    }
    for (const [k, n] of edges) { const [x, y] = k.split('>'); if (n !== 1 || edges.get(`${y}>${x}`) !== 1) { open++; break; } }
  }
  const v0 = vol(sk.position);
  check(open === 0 && v0.every((v) => v > 0), `worm skin: every part closed with one winding, facing out (${open} open, ${v0.filter((v) => !(v > 0)).length} inside-out)`);
  // Skinning on the CPU (as the shader does).
  const bind = WormRig.bindFrames();
  const inv = Array.from({ length: WORM_BONES.count }, (_, b) => new THREE.Matrix4().fromArray(bind, b * 16).invert());
  const F = new Float32Array(WORM_BONES.count * 16), out = new Float32Array(sk.position.length);
  const M = new THREE.Matrix4(), p = new THREE.Vector3(), acc = new THREE.Vector3();
  const skinned = () => {
    const B = inv.map((iv, b) => (b === 0 ? new THREE.Matrix4() : new THREE.Matrix4().fromArray(F, b * 16).multiply(iv)));
    for (let v = 0; v < nV; v++) {
      acc.set(0, 0, 0);
      for (let k = 0; k < 4; k++) { const w = sk.skinWeight[v * 4 + k]; if (!w) continue; M.copy(B[sk.skinIndex[v * 4 + k]]); p.fromArray(sk.position, v * 3).applyMatrix4(M); acc.addScaledVector(p, w); }
      acc.toArray(out, v * 3);
    }
    return out;
  };
  const rig = new WormRig();
  rig.still = true;
  rig.reset(0, 0, 0, 0, 0, 1);
  rig.frames(F);
  let err = 0;
  const o = skinned();
  for (let i = 0; i < o.length; i++) err = Math.max(err, Math.abs(o[i] - sk.position[i]));
  check(err < 1e-3, `worm skin: a straight worm with the maw shut is the bind pose (max error ${err.toExponential(1)} m)`);
  // Standing out of a hole (anchored, maw open), then diving on: no part crushed or blown up.
  rig.reset(0, -20, -60, 0, 0, 1);
  for (let z = -60; z <= 0; z += 0.5) rig.moveHead(0, -20 + Math.max(0, z + 30) * 0.4, z);
  for (let y = -8; y <= 4; y += 0.5) rig.moveHead(0, y, 0);
  rig.anchorAt(0, 0, 0);
  rig.setDir(0.3, -0.2, 1); rig.moveHead(4, 26, 6); rig.petal = 1; rig.place(); rig.frames(F);
  const off = (vs: number[]) => vs.filter((v, i) => !(v > 0) || v < v0[i] * 0.4 || v > v0[i] * 2.5).length;
  const standing = off(vol(skinned())), exposed = rig.exposed();
  const headUp = rig.j[1];
  rig.release();
  for (let k = 0; k < 120; k++) { rig.moveHead(4 + 0.1 * k, 26 - k * 0.4, 6 + k * 0.3); rig.setDir(0.1, -0.8, 0.5); }
  rig.place(); rig.frames(F);
  const diving = off(vol(skinned()));
  check(standing === 0 && diving === 0 && exposed > 25 && exposed < WORM_LENGTH * 0.6 && headUp > 20, `worm rig: standing out of its hole (${exposed.toFixed(0)} m out, head ${headUp.toFixed(0)} m up) and diving on, every part keeps its volume (${standing} / ${diving} off)`);
}

function routeChecks(check: Check): void {
  let ok = 0;
  const lens: number[] = [];
  for (let seed = 1; seed <= 20; seed++) {
    const terrain = new Terrain(makeProfile({ seed, size: 0.6 }));
    const macro = buildMacroPlan(terrain);
    const c0 = macro.centres[0];
    // The hero out to the east of downtown.
    const hero = { x: c0.x + 600, z: c0.z + 100 };
    const R = planBurrowerRoute(macro, seed, hero);
    if (!R) { check(false, `burrower route: seed ${seed} has one`); continue; }
    const r0 = Math.hypot(R.start.x - c0.x, R.start.z - c0.z), r1 = Math.hypot(R.end.x - c0.x, R.end.z - c0.z);
    const inside = r0 <= boundaryAt(macro.boundary, R.start.x, R.start.z) * BURROW_ROUTE.edgeShare + 1;
    let side = Math.atan2(R.start.z - c0.z, R.start.x - c0.x) - Math.atan2(hero.z - c0.z, hero.x - c0.x);
    while (side > Math.PI) side -= Math.PI * 2;
    while (side < -Math.PI) side += Math.PI * 2;
    const B = R.breaches;
    let gaps = B.length >= 2 && B[0] >= BURROW_ROUTE.first[0] - 1 && B[B.length - 1] <= R.length - BURROW_ROUTE.endKeep;
    for (let i = 1; i < B.length; i++) if (B[i] - B[i - 1] < BURROW_ROUTE.gap[0] - 1) gaps = false;
    const good = inside && r0 > 300 && r1 < 250 && Math.abs(side) < 1.4 && R.length > 300 && R.length < 3000 && gaps;
    if (good) ok++;
    else check(false, `burrower route: seed ${seed}: starts ${Math.round(r0)} m out (inside ${inside}), ends ${Math.round(r1)} m from the centre, ${(side * 57.3).toFixed(0)}° off the hero's side, ${Math.round(R.length)} m, breaches ${B.map(Math.round).join(' ')}`);
    lens.push(Math.round(R.length));
  }
  check(ok === 20, `burrower route: from the hero's side into downtown with breaches every 130–210 m, 20 seeds (${ok}/20; ${lens.join(' ')} m)`);
  const tA = new Terrain(makeProfile({ seed: 5, size: 0.6 })), tB = new Terrain(makeProfile({ seed: 5, size: 0.6 }));
  const a = planBurrowerRoute(buildMacroPlan(tA), 9, { x: 300, z: 0 }), b = planBurrowerRoute(buildMacroPlan(tB), 9, { x: 300, z: 0 });
  check(!!a && !!b && JSON.stringify(a.pts) === JSON.stringify(b.pts) && JSON.stringify(a.breaches) === JSON.stringify(b.breaches), 'burrower route: deterministic per seed');
}

function craterChecks(check: Check): void {
  const D = 5.5;
  let mono = true;
  for (let u = 0; u < 1; u += 0.01) if (craterDepth(u + 0.01, D) > craterDepth(u, D) + 1e-9) mono = false;
  check(Math.abs(craterDepth(0, D) - D) < 1e-9 && craterDepth(1, D) === 0 && craterDepth(1.3, D) === 0 && mono && craterDepth(SINK.wallU, D) > D * 0.3,
    `sinkhole: the crater falls from the street (a sheer wall at the edge, ${craterDepth(SINK.wallU, D).toFixed(1)} m) to ${D} m in the middle, never rising`);
  const edge = new Float32Array(48).fill(7);
  const h = { x: 100, z: -50, r: 7, depth: D, seed: 3, edge, small: false };
  const street = (x: number, z: number) => 4 + x * 0.01 + z * 0.005;
  const c = buildCrater(h, street);
  const P = c.geometry.getAttribute('position').array as Float32Array;
  let finite = true, deepest = 0, rimTop = -Infinity;
  for (let i = 0; i < P.length; i++) if (!Number.isFinite(P[i])) finite = false;
  for (let i = 0; i < c.drop.length; i++) { deepest = Math.max(deepest, c.drop[i]); rimTop = Math.max(rimTop, -c.drop[i]); }
  const idx = c.geometry.getIndex()!;
  let badIdx = 0;
  for (let i = 0; i < idx.count; i++) if (idx.getX(i) >= c.base.length) badIdx++;
  check(finite && badIdx === 0 && Math.abs(deepest - D) < D * 0.25 && rimTop > 0 && rimTop < 0.2 && Math.abs(c.y0 - street(100, -50)) < 1e-6,
    `sinkhole: crater mesh (${c.base.length} vertices) is finite, goes ${deepest.toFixed(1)} m down, its broken rim ${(rimTop * 100).toFixed(0)} cm proud of the street`);
}

function clockChecks(check: Check): void {
  type Sig = { t: number; type: string; arch: string; kind?: string };
  let firstOk = 0, wormSeen = 0, omensOk = true;
  for (const seed of [42, 7, 1234, 5, 99]) {
    const c = new ThreatClock(seed);
    const out: Sig[] = [];
    for (let t = 0; t < 14 * 3600; t++) for (const s of c.tick(1, t % 15 === 0 ? 1 : 0, 0)) out.push({ t, type: s.type, arch: s.archetype, kind: s.type === 'omen' ? s.kind : undefined });
    const majors = out.filter((s) => s.type === 'event' && isMajor(s.arch));
    if (majors.length && majors[0].arch === FIRST_MAJOR) firstOk++;
    if (majors.some((m) => m.arch === 'burrower')) wormSeen++;
    for (const o of out) if (o.type === 'omen' && o.arch === 'burrower' && o.kind !== 'rumble' && o.kind !== 'pothole') omensOk = false;
  }
  check(firstOk === 5 && wormSeen >= 2 && omensOk, `threat clock: the first major event is always the Strider (${firstOk}/5), the worm comes among the later ones (${wormSeen}/5 cities in 14 h, gap ${CLOCK.majorGapMin / 3600}–${CLOCK.majorGapMax / 3600} h) with its own omens`);
}

// (Run on its own: npx tsx tools/burrowerTest.ts)
if (process.argv[1]?.endsWith('burrowerTest.ts')) {
  let fails = 0;
  burrowerChecks((ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; });
  process.exit(fails ? 1 : 0);
}
