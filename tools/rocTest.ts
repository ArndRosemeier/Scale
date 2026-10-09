/**
 * Self test of the Roc (game/threats/roc, THREATS_PLAN §1 #5), run by tools/selftest.ts (or on its
 * own: `npx tsx tools/rocTest.ts`): the bird's skin (closed parts facing out; posed in flight and
 * perched, the body inside its hit capsules and its feet on the roof), where it goes (a perch on a
 * tall roof edge facing the looker, the way in from far out, the car it snatches) and the clock (the
 * Strider still first, the Roc among the later majors with its own omens).
 */
import * as THREE from 'three';
import { buildRocSkin } from '../src/game/threats/roc/rocSkin';
import { RocRig, ROC_BONES, ROC_BIND, PERCH_HEIGHT } from '../src/game/threats/roc/rocRig';
import { pickPerch, entryPoint, pickPrey, ROC_PLAN, type PerchBuilding } from '../src/game/threats/roc/rocPlan';
import { ThreatClock, FIRST_MAJOR, isMajor } from '../src/game/threats/ThreatClock';
import { pointInPoly } from '../src/core/geom2';
import { Rng } from '../src/core/rng';

type Check = (ok: boolean, msg: string) => void;

export function rocChecks(check: Check): void {
  skinChecks(check);
  planChecks(check);
  clockChecks(check);
}

function skinChecks(check: Check): void {
  const t0 = performance.now();
  const sk = buildRocSkin();
  const ms = performance.now() - t0;
  const nV = sk.position.length / 3;
  check(nV > 3000 && nV < 20000 && ms < 1500, `roc skin: ${nV} vertices, ${sk.index.length / 3} triangles, ${sk.parts.length} parts, built in ${ms.toFixed(0)} ms`);
  let open = 0, inside = 0;
  const P = sk.position;
  for (const part of sk.parts) {
    const id = new Map<string, number>();
    const weld = (v: number) => { const k = `${Math.round(P[v * 3] * 1e4)},${Math.round(P[v * 3 + 1] * 1e4)},${Math.round(P[v * 3 + 2] * 1e4)}`; let i = id.get(k); if (i === undefined) { i = id.size; id.set(k, i); } return i; };
    const edges = new Map<string, number>();
    let V = 0;
    for (let t = part.i0; t < part.i1; t += 3) {
      const a = sk.index[t] * 3, b = sk.index[t + 1] * 3, c = sk.index[t + 2] * 3;
      V += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
      const A = weld(a / 3), B = weld(b / 3), C = weld(c / 3);
      for (const [x, y] of [[A, B], [B, C], [C, A]]) if (x !== y) edges.set(`${x}>${y}`, (edges.get(`${x}>${y}`) ?? 0) + 1);
    }
    for (const [k, n] of edges) { const [x, y] = k.split('>'); if (n !== 1 || edges.get(`${y}>${x}`) !== 1) { open++; break; } }
    if (!(V > 0)) inside++;
  }
  check(open === 0 && inside === 0, `roc skin: every part closed with one winding, facing out (${open} open, ${inside} inside-out)`);

  // Skinning on the CPU (as the shader does): bone frames × inverse bind translations.
  const inv = ROC_BIND.map((B) => new THREE.Matrix4().makeTranslation(-B[0], -B[1], -B[2]));
  const M = new THREE.Matrix4(), p = new THREE.Vector3(), acc = new THREE.Vector3();
  const skinned = (rig: RocRig) => {
    const out = new Float32Array(P.length);
    const B = inv.map((iv, b) => (b === 0 ? new THREE.Matrix4() : new THREE.Matrix4().fromArray(rig.world, b * 16).multiply(iv)));
    for (let v = 0; v < nV; v++) {
      acc.set(0, 0, 0);
      for (let k = 0; k < 4; k++) { const w = sk.skinWeight[v * 4 + k]; if (!w) continue; M.copy(B[sk.skinIndex[v * 4 + k]]); p.fromArray(P, v * 3).applyMatrix4(M); acc.addScaledVector(p, w); }
      acc.toArray(out, v * 3);
    }
    return out;
  };
  const covered = (rig: RocRig, S: Float32Array, margin: number) => {
    let n = 0;
    for (let v = 0; v < nV; v++) if ((rig.nearest(S[v * 3], S[v * 3 + 1], S[v * 3 + 2])?.d ?? Infinity) < margin) n++;
    return n / nV;
  };
  // In flight, wings spread mid-beat.
  const fly = new RocRig();
  fly.still = true;
  fly.x = 40; fly.y = 80; fly.z = -30; fly.yaw = 0.7; fly.beat = 1; fly.flap = 0.3;
  fly.place();
  const F = skinned(fly);
  const finite = F.every((v) => Number.isFinite(v));
  const cf = covered(fly, F, 1.2);
  // Perched on a roof at y = 30, wings folded.
  const st = new RocRig();
  st.still = true;
  st.x = -10; st.y = 30 + PERCH_HEIGHT; st.z = 5; st.yaw = -2; st.perch = true; st.legs = 1; st.fold = 1;
  st.place();
  const S = skinned(st);
  // Lowest point of the toes (pads) and of everything (the hooked talons may bite into the roof a little).
  let toeY = Infinity, minY = Infinity;
  for (const part of sk.parts) for (let v = part.v0; v < part.v1; v++) {
    const y = S[v * 3 + 1];
    minY = Math.min(minY, y);
    if (part.name === 'toe') toeY = Math.min(toeY, y);
  }
  const cs = covered(st, S, 1.2);
  check(finite && cf > 0.9 && cs > 0.9, `roc: its body inside the hit capsules (${(cf * 100).toFixed(0)}% in flight, ${(cs * 100).toFixed(0)}% perched, within 1.2 m), ${ROC_BONES.count} bones`);
  check(Math.abs(toeY - 30) < 0.2 && minY - 30 > -0.6, `roc: perched, its toes stand on the roof (${(toeY - 30).toFixed(2)} m), the talons hooking in no deeper than 0.6 m (${(minY - 30).toFixed(2)} m)`);
}

function planChecks(check: Check): void {
  const sq = (x: number, z: number, h: number, alive = true, w = 20): PerchBuilding => ({ poly: [x - w, z - w, x + w, z - w, x + w, z + w, x - w, z + w], top: 10 + h, base: 10, alive });
  // Tall ones at 0..2, a taller dead one, short ones, one too far.
  const list = [sq(100, 0, 60), sq(0, 120, 55), sq(-100, 0, 50), sq(0, -100, 80, false), sq(60, 60, 12), sq(-60, 60, 15), sq(0, 600, 120), sq(-60, -60, 30)];
  const picked = new Set<number>();
  let good = true;
  for (let s = 1; s <= 40; s++) {
    const P = pickPerch(list, 0, 0, 0, 0, new Rng(s));
    if (!P) { good = false; continue; }
    picked.add(P.i);
    const b = list[P.i];
    // Feet on the roof, inside the footprint, near the edge facing the looker, facing out at it.
    const fx = Math.sin(P.yaw), fz = Math.cos(P.yaw), tx = -P.x, tz = -P.z, tl = Math.hypot(tx, tz);
    if (P.y !== b.top || !pointInPoly(b.poly, P.x, P.z) || (fx * tx + fz * tz) / tl < 0.9) good = false;
  }
  check(good && [...picked].every((i) => i <= 2) && picked.size >= 2, `roc perch: one of the tallest standing roofs in range, feet on its edge facing the looker (picked ${[...picked].sort().join(', ')} of 40 tries)`);
  const used = new Set([0, 1, 2]);
  const P2 = pickPerch(list, 0, 0, 0, 0, new Rng(3), used);
  const none = pickPerch(list.map((b) => ({ ...b, alive: false })), 0, 0, 0, 0, new Rng(3));
  const tooNear = pickPerch([sq(0, 0, 60, true, 8)], 0, 0, 0, 0, new Rng(3));
  check(P2?.i === 7 && none === null && tooNear === null, `roc perch: used edges skipped (next ${P2?.i}), none when nothing stands (${none}), never right on the looker (${tooNear})`);
  let entryOk = true;
  for (let s = 1; s <= 20; s++) {
    const E = entryPoint(0, 0, 200, 50, new Rng(s));
    const d = Math.hypot(E.x - 200, E.z - 50), out = Math.hypot(E.x, E.z) > Math.hypot(200, 50);
    if (Math.abs(d - ROC_PLAN.entry) > 1 || !out || E.y !== ROC_PLAN.entryAlt) entryOk = false;
  }
  check(entryOk, `roc entry: from ${ROC_PLAN.entry} m out beyond the hero, away from the centre, ${ROC_PLAN.entryAlt} m up`);
  const cars = [{ x: 30, z: 0, bus: false, ok: true }, { x: 80, z: 0, bus: true, ok: true }, { x: 5, z: 0, bus: false, ok: false }, { x: 400, z: 0, bus: true, ok: true }];
  const prey = pickPrey(cars, 0, 0, 300), far = pickPrey(cars.slice(3), 0, 0, 300), wrecked = pickPrey(cars.slice(2, 3), 0, 0, 300);
  check(prey === 1 && far === -1 && wrecked === -1, `roc prey: a bus before a nearer car (${prey}), nothing out of reach (${far}) or wrecked (${wrecked})`);
}

function clockChecks(check: Check): void {
  let firstOk = 0, seen = 0, omensOk = true, omens = 0;
  for (const seed of [42, 7, 1234, 5, 99, 11, 2024, 3]) {
    const c = new ThreatClock(seed);
    const out: { type: string; arch: string; kind?: string }[] = [];
    for (let t = 0; t < 14 * 3600; t++) for (const s of c.tick(1, t % 15 === 0 ? 1 : 0, 0)) out.push({ type: s.type, arch: s.archetype, kind: s.type === 'omen' ? s.kind : undefined });
    const majors = out.filter((s) => s.type === 'event' && isMajor(s.arch));
    if (majors.length && majors[0].arch === FIRST_MAJOR) firstOk++;
    if (majors.some((m) => m.arch === 'roc')) seen++;
    for (const o of out) if (o.type === 'omen' && o.arch === 'roc') { omens++; if (o.kind !== 'cry' && o.kind !== 'flyover') omensOk = false; }
  }
  check(firstOk === 8 && seen >= 2 && omensOk && omens > 0, `threat clock: the Strider still comes first (${firstOk}/8), the Roc among the later majors (${seen}/8 cities in 14 h) with its own omens (${omens} cries and fly-overs)`);
}

// (Run on its own: npx tsx tools/rocTest.ts)
if (process.argv[1]?.endsWith('rocTest.ts')) {
  let fails = 0;
  rocChecks((ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; });
  process.exit(fails ? 1 : 0);
}
