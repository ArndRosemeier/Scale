/**
 * Self test of the giant mech (game/threats/mech, THREATS_PLAN §1 #12), run by tools/selftest.ts (or
 * on its own: `npx tsx tools/mechTest.ts`): the skin (closed parts facing out, every vertex on one
 * bone), the frame posed standing, striding, firing, kneeling (the body inside its hit capsules, the
 * soles where the feet are told to stand, the knees behind), and the clock (the Strider still first,
 * the mech among the later majors with its own omens).
 */
import * as THREE from 'three';
import { buildMechSkin } from '../src/game/threats/mech/mechSkin';
import { MechRig, MECH, MECH_BONES, MECH_BIND } from '../src/game/threats/mech/mechRig';
import { ThreatClock, FIRST_MAJOR, isMajor } from '../src/game/threats/ThreatClock';

type Check = (ok: boolean, msg: string) => void;

export function mechChecks(check: Check): void {
  skinChecks(check);
  clockChecks(check);
}

function skinChecks(check: Check): void {
  const t0 = performance.now();
  const sk = buildMechSkin();
  const ms = performance.now() - t0;
  const nV = sk.position.length / 3;
  check(nV > 1500 && nV < 20000 && ms < 1500, `mech skin: ${nV} vertices, ${sk.index.length / 3} triangles, ${sk.parts.length} parts, built in ${ms.toFixed(0)} ms`);
  let open = 0, inside = 0, multi = 0;
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
    for (let v = part.v0; v < part.v1; v++) if (sk.skinWeight[v * 4] < 0.999 || sk.skinIndex[v * 4] !== sk.skinIndex[part.v0 * 4]) { multi++; break; }
  }
  check(open === 0 && inside === 0 && multi === 0, `mech skin: every part closed with one winding, facing out, rigid on one bone (${open} open, ${inside} inside-out, ${multi} blended)`);

  // Skinning on the CPU (as the shader does): bone frames × inverse bind translations.
  const inv = MECH_BIND.map((B) => new THREE.Matrix4().makeTranslation(-B[0], -B[1], -B[2]));
  const M = new THREE.Matrix4(), p = new THREE.Vector3();
  const skinned = (rig: MechRig) => {
    const out = new Float32Array(P.length);
    const B = inv.map((iv, b) => (b === 0 ? new THREE.Matrix4() : new THREE.Matrix4().fromArray(rig.world, b * 16).multiply(iv)));
    for (let v = 0; v < nV; v++) { M.copy(B[sk.skinIndex[v * 4]]); p.fromArray(P, v * 3).applyMatrix4(M).toArray(out, v * 3); }
    return out;
  };
  const covered = (rig: MechRig, S: Float32Array, margin: number) => {
    let n = 0;
    for (let v = 0; v < nV; v++) if ((rig.nearest(S[v * 3], S[v * 3 + 1], S[v * 3 + 2])?.d ?? Infinity) < margin) n++;
    return n / nV;
  };
  const sc = 1.35;
  const pose = (f: (q: MechRig) => void) => {
    const q = new MechRig(sc);
    q.still = true;
    q.x = 30; q.z = -20; q.yaw = 0.6; q.y = 5 + MECH.stand * sc;
    const rx = Math.cos(q.yaw), rz = -Math.sin(q.yaw);
    q.feet.forEach((F, i) => { const s = i ? -1 : 1; F.x = q.x + rx * s * MECH.hip[0] * sc; F.z = q.z + rz * s * MECH.hip[0] * sc; F.y = 5; F.yaw = q.yaw; });
    f(q);
    q.place();
    return q;
  };
  const fwd = { x: Math.sin(0.6), z: Math.cos(0.6) };
  const poses: [string, MechRig][] = [
    ['standing', pose(() => {})],
    ['striding', pose((q) => { q.feet[0].x += fwd.x * 4; q.feet[0].z += fwd.z * 4; q.feet[1].x -= fwd.x * 4; q.feet[1].z -= fwd.z * 4; q.feet[1].lift = 2.5; })],
    ['firing', pose((q) => { q.aim = { x: q.x + 80, y: 40, z: q.z + 120 }; q.pods = 1; q.vent = 1; })],
    ['kneeling', pose((q) => { q.y -= 4.2 * sc; q.pitch = 0.18; q.smash = 1; })],
  ];
  let worst = 1, soleErr = 0, kneesBehind = true, finite = true;
  for (const [, q] of poses) {
    const S = skinned(q);
    if (!S.every((v) => Number.isFinite(v))) finite = false;
    worst = Math.min(worst, covered(q, S, 1.5));
    q.feet.forEach((F, i) => {
      const side = i ? -1 : 1, so = q.sole(side);
      soleErr = Math.max(soleErr, Math.hypot(so.x - F.x, so.y - (F.y + F.lift * sc), so.z - F.z) > 2.5 ? 99 : Math.abs(so.y - (F.y + F.lift * sc)));
      // The knee behind the line from hip to ankle (reverse-jointed).
      const l = MECH_BONES.leg(side), h = q.joint(l), k = q.joint(l + 1), a = q.joint(l + 2);
      const mx = (h.x + a.x) / 2, mz = (h.z + a.z) / 2;
      if ((k.x - mx) * fwd.x + (k.z - mz) * fwd.z > -0.3) kneesBehind = false;
    });
  }
  check(finite && worst > 0.88, `mech: its body inside the hit capsules in every pose (worst ${(worst * 100).toFixed(0)}% within 1.5 m; standing, striding, firing, kneeling), ${MECH_BONES.count} bones`);
  check(soleErr < 0.35 && kneesBehind, `mech: the legs reach the feet (soles within ${soleErr.toFixed(2)} m of where they are told to stand), knees behind (reverse-jointed: ${kneesBehind})`);
}

function clockChecks(check: Check): void {
  let firstOk = 0, seen = 0, omensOk = true, omens = 0;
  for (const seed of [42, 7, 1234, 5, 99, 11, 2024, 3]) {
    const c = new ThreatClock(seed);
    const out: { type: string; arch: string; kind?: string }[] = [];
    for (let t = 0; t < 14 * 3600; t++) for (const s of c.tick(1, t % 15 === 0 ? 1 : 0, 0)) out.push({ type: s.type, arch: s.archetype, kind: s.type === 'omen' ? s.kind : undefined });
    const majors = out.filter((s) => s.type === 'event' && isMajor(s.arch));
    if (majors.length && majors[0].arch === FIRST_MAJOR) firstOk++;
    if (majors.some((m) => m.arch === 'mech')) seen++;
    for (const o of out) if (o.type === 'omen' && o.arch === 'mech') { omens++; if (o.kind !== 'stomps' && o.kind !== 'bulletin') omensOk = false; }
  }
  check(firstOk === 8 && seen >= 2 && omensOk && omens > 0, `threat clock: the Strider still comes first (${firstOk}/8), the mech among the later majors (${seen}/8 cities in 14 h) with its own omens (${omens} footfalls and bulletins)`);
}

// (Run on its own: npx tsx tools/mechTest.ts)
if (process.argv[1]?.endsWith('mechTest.ts')) {
  let fails = 0;
  mechChecks((ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; });
  process.exit(fails ? 1 : 0);
}
