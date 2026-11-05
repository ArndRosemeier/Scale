/**
 * Self test of the retired cathedral gargoyle (game/citizens/gargoyle), run by tools/selftest.ts (or
 * on its own: `npx tsx tools/gargoyleTest.ts`): its skin (closed parts facing out), its poses (the
 * soles on what it stands on, crouched and walking, every bone finite), its home (a ledge on a
 * cathedral, the town hall's roof edge in a city without one, a spot on the square below), its hours
 * (stone by day, tours at 22, 0 and 2) and its lines (every placeholder filled).
 */
import * as THREE from 'three';
import { buildGargoyleSkin } from '../src/game/citizens/gargoyle/gargoyleSkin';
import { GargoyleRig, GARGOYLE_BONES, GARGOYLE_BIND } from '../src/game/citizens/gargoyle/gargoyleRig';
import { gargoyleHome, awakeAt, tourStarting, tourAnnounce, tourStops, GARGOYLE_PLAN } from '../src/game/citizens/gargoyle/gargoylePlan';
import { gargoyleLine, stopLines, churchLines, rumourLine, type GargoyleTopic } from '../src/game/citizens/gargoyle/gargoyleLines';
import { landmarkInterior } from '../src/plan/landmarkParts';
import { buildMacroPlan } from '../src/plan/macro';
import { Terrain } from '../src/world/terrain';
import { makeProfile } from '../src/world/settings';

type Check = (ok: boolean, msg: string) => void;

export function gargoyleChecks(check: Check): void {
  skinChecks(check);
  homeChecks(check);
  clockChecks(check);
  lineChecks(check);
}

function skinChecks(check: Check): void {
  const t0 = performance.now();
  const sk = buildGargoyleSkin();
  const ms = performance.now() - t0;
  const nV = sk.position.length / 3, P = sk.position;
  check(nV > 2000 && nV < 20000 && ms < 1000, `gargoyle skin: ${nV} vertices, ${sk.index.length / 3} triangles, ${sk.parts.length} parts, built in ${ms.toFixed(0)} ms`);
  let open = 0, inside = 0;
  for (const part of sk.parts) {
    const id = new Map<string, number>();
    const weld = (v: number) => { const k = `${Math.round(P[v * 3] * 1e5)},${Math.round(P[v * 3 + 1] * 1e5)},${Math.round(P[v * 3 + 2] * 1e5)}`; let i = id.get(k); if (i === undefined) { i = id.size; id.set(k, i); } return i; };
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
  check(open === 0 && inside === 0, `gargoyle skin: every part closed with one winding, facing out (${open} open, ${inside} inside-out)`);

  // Skinned on the CPU as the shader does: the soles on the ground crouched (on its ledge) and walking.
  const inv = GARGOYLE_BIND.map((B) => new THREE.Matrix4().makeTranslation(-B[0], -B[1], -B[2]));
  const M = new THREE.Matrix4(), p = new THREE.Vector3(), acc = new THREE.Vector3();
  const lowest = (rig: GargoyleRig, names: string[]) => {
    const Bm = inv.map((iv, b) => (b === 0 ? new THREE.Matrix4() : new THREE.Matrix4().fromArray(rig.world, b * 16).multiply(iv)));
    let low = Infinity, all = Infinity, finite = true;
    for (const part of sk.parts) for (let v = part.v0; v < part.v1; v++) {
      acc.set(0, 0, 0);
      for (let k = 0; k < 4; k++) { const w = sk.skinWeight[v * 4 + k]; if (!w) continue; M.copy(Bm[sk.skinIndex[v * 4 + k]]); p.fromArray(P, v * 3).applyMatrix4(M); acc.addScaledVector(p, w); }
      if (!Number.isFinite(acc.y)) finite = false;
      all = Math.min(all, acc.y);
      if (names.includes(part.name)) low = Math.min(low, acc.y);
    }
    return { low, all, finite };
  };
  const crouch = new GargoyleRig();
  crouch.x = 12; crouch.z = -4; crouch.yaw = 1.1; crouch.feet = 20; crouch.still = true;
  crouch.place();
  const c = lowest(crouch, ['foot', 'toe']);
  const walk = new GargoyleRig();
  walk.feet = 3; walk.crouch = 0.3; walk.rest = 0; walk.walk = 1; walk.curl = 0;
  let wLow = Infinity, wAll = Infinity, wFin = true;
  for (let ph = 0; ph < Math.PI * 2; ph += 0.7) { walk.phase = ph; walk.place(); const w = lowest(walk, ['foot', 'toe']); wLow = Math.min(wLow, w.low); wAll = Math.min(wAll, w.all); wFin &&= w.finite; }
  check(c.finite && wFin && Math.abs(c.low - 20) < 0.08 && c.all > 20 - 0.12 && Math.abs(wLow - 3) < 0.1 && wAll > 3 - 0.15,
    `gargoyle: crouched on its ledge its feet stand on it (${(c.low - 20).toFixed(3)} m, nothing deeper than ${(c.all - 20).toFixed(2)} m), walking too (${(wLow - 3).toFixed(3)} m, ${(wAll - 3).toFixed(2)} m), ${GARGOYLE_BONES.count} bones`);
  // Gliding: the pelvis where it is put, wings spread wider than folded.
  const fly = new GargoyleRig();
  fly.feet = null; fly.y = 30; fly.pitch = 1.1; fly.fold = 0; fly.crouch = 0; fly.beat = 0.6;
  fly.place();
  const tipFly = fly.joint(GARGOYLE_BONES.wing(1) + 1), tipRest = crouch.joint(GARGOYLE_BONES.wing(1) + 1);
  const spanFly = Math.hypot(tipFly.x - fly.x, tipFly.z - fly.z), spanRest = Math.hypot(tipRest.x - crouch.x, tipRest.z - crouch.z);
  check(Math.abs(fly.joint(GARGOYLE_BONES.pelvis).y - 30) < 1e-6 && spanFly > spanRest + 0.1, `gargoyle: gliding, its wings spread out (elbow ${spanFly.toFixed(2)} m from the body, folded ${spanRest.toFixed(2)} m)`);
}

function homeChecks(check: Check): void {
  // Seed 2: a cathedral; seed 1: none (the town hall's roof edge).
  const out: string[] = [];
  let ok = true;
  for (const seed of [2, 1]) {
    const terrain = new Terrain(makeProfile({ seed, size: 0.35 }));
    const macro = buildMacroPlan(terrain);
    const H = gargoyleHome(seed, macro.landmarks, (lm) => landmarkInterior(lm, terrain));
    const cath = macro.landmarks.some((l) => l.kind === 'cathedral');
    if (!H) { ok = false; out.push(`seed ${seed}: none`); continue; }
    const want = cath ? 'cathedral' : 'townhall';
    // The ledge up on the building, the spot on the square in front within reach of it, near the ground.
    const lm = H.lm, up = H.perch.y - lm.base;
    const toSpot = Math.hypot(H.spot.x - H.perch.x, H.spot.z - H.perch.z);
    const ground = terrain.height(H.spot.x, H.spot.z);
    const stops = tourStops(H, macro.landmarks);
    const stopsOk = stops[0].kind === 'church' && stops.length >= 1 && stops.length <= GARGOYLE_PLAN.maxStops + 1 && stops.every((s) => Math.hypot(s.x - H.spot.x, s.z - H.spot.z) < GARGOYLE_PLAN.stopR + 1);
    const same = gargoyleHome(seed, macro.landmarks, (l) => landmarkInterior(l, terrain));
    if (lm.kind !== want || up < 6 || toSpot > 60 || Math.abs(lm.base - ground) > 6 || !stopsOk || same?.perch !== H.perch) ok = false;
    out.push(`seed ${seed}: ${lm.kind} ledge ${up.toFixed(1)} m up, spot ${toSpot.toFixed(0)} m away, ${stops.length - 1} sights`);
  }
  check(ok, `gargoyle home: a ledge on the cathedral (else the town hall), its spot on the square below, the same each time, sights near (${out.join('; ')})`);
}

function clockChecks(check: Check): void {
  const day = [8, 12, 16, 19.9].every((h) => !awakeAt(h)), night = [20.6, 23, 0.5, 3, 4.9].every((h) => awakeAt(h));
  // Stepping the clock by small steps through two days: each tour starts once a night, announced before.
  const starts: number[] = [], ann: number[] = [];
  let h = 12;
  for (let i = 0; i < 2 * 24 * 60; i++) {
    const n = (h + 1 / 60) % 24;
    const s = tourStarting(h, n), a = tourAnnounce(h, n);
    if (s !== null) starts.push(s);
    if (a !== null) ann.push(a);
    h = n;
  }
  check(day && night && starts.join() === '22,0,2,22,0,2' && ann.join() === '22,0,2,22,0,2' && tourStarting(23, 23) === null,
    `gargoyle hours: stone by day, awake at night, tours start once each (${starts.join(', ')}) and are announced first`);
}

function lineChecks(check: Check): void {
  const f = { name: 'Basil', church: "St Ann's Cathedral", street: 'Elm Street' };
  const topics: GargoyleTopic[] = ['wake', 'dawn', 'whisper', 'greet', 'again', 'gossip', 'pigeons', 'coo', 'tourInfo', 'announce', 'tourStart', 'walk', 'tourEnd', 'danger', 'calm', 'fly', 'giant', 'rain', 'hero', 'villain', 'nobody', 'busy', 'church'];
  const all: string[] = [];
  for (const t of topics) for (let u = 0; u < 1; u += 0.05) { const l = gargoyleLine(t, u, f); if (l) all.push(l); else all.push(`<none ${t}>`); }
  for (const k of ['townhall', 'museum', 'stadium', 'tower', 'nothing-known']) all.push(...stopLines(k, 'Old Museum', f));
  all.push(...churchLines(f), rumourLine('they hide out on Elm Street'));
  const bad = all.filter((l) => /[{}]|<none|undefined/.test(l));
  check(bad.length === 0, `gargoyle lines: every topic has lines, every placeholder filled (${all.length} lines${bad.length ? `, e.g. "${bad[0]}"` : ''})`);
}

// (Run on its own: npx tsx tools/gargoyleTest.ts)
if (process.argv[1]?.endsWith('gargoyleTest.ts')) {
  let fails = 0;
  gargoyleChecks((ok, msg) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); });
  process.exit(fails ? 1 : 0);
}
