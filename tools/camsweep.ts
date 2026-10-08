/**
 * Camera in narrow tunnels: walks a hero along every metro entrance stair, underpass and a stretch
 * of each sewer (both ways, along each wall), runs the real CameraRig behind them and reports
 * where the camera ends up outside the drawn tunnel: the line from the hero's head to the camera
 * (or to a corner of its near plane) passes through a drawn wall, floor or ceiling.
 *
 *   npx tsx tools/camsweep.ts <sizes> <seedA-seedB> [sewers]    e.g. npx tsx tools/camsweep.ts 0.5 1-2  (a few minutes per city)
 */
// The underground builds materials and canvases on construction: enough of a browser to get through.
const anyStub: any = new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : k === 'length' ? 0 : anyStub), apply: () => anyStub, construct: () => anyStub, set: () => true });
const g = globalThis as any;
g.window ??= g;
g.document ??= { createElement: () => ({ getContext: () => anyStub, style: {}, width: 0, height: 0 }), addEventListener() {} };
g.addEventListener ??= () => {};

const THREE = await import('three');
const { makeProfile } = await import('../src/world/settings');
const { Terrain } = await import('../src/world/terrain');
const { buildMacroPlan } = await import('../src/plan/macro');
const { Underground } = await import('../src/underground/Underground');
const { tubeAt } = await import('../src/underground/Volumes');
const { CameraRig } = await import('../src/player/CameraRig');

const ZERO = { mouseDX: 0, mouseDY: 0, wheel: 0 };
const H = 1.8;

export interface CamReport { poses: number; out: number; at: string[] }

export function camSweep(seed: number, size: number, sewers: boolean): CamReport {
  const terrain = new Terrain(makeProfile({ seed, size }));
  const macro = buildMacroPlan(terrain);
  const ground = (x: number, z: number) => terrain.height(x, z);
  const t0 = Date.now();
  const u: any = new Underground(macro, terrain, { facade: { tileMeters: [] } } as any, ground);
  console.log(`  underground built in ${Date.now() - t0} ms`);
  const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const tubes = (u.tubes as any[]).filter((t) => t.kind === 'passage' || (sewers && t.kind === 'sewer'));
  // Drawn geometry: every tube chunk and station hall (built once each).
  const chunks = new Map<string, any>();
  const meshesNear = (x: number, z: number): any[] => {
    const out: any[] = [];
    (u.tubes as any[]).forEach((t, ti) => {
      if (t.kind === 'crawl') return;
      if (t.bounds[0] > x + 40 || t.bounds[2] < x - 40 || t.bounds[1] > z + 40 || t.bounds[3] < z - 40) return;
      const P = t.pts, n = P.length / 3, chunk = t.kind === 'passage' ? n : 8;
      for (let i = 0; i < n - 1; i += chunk) {
        const j = Math.min(n - 1, i + chunk);
        let near = false;
        for (let k = i; k <= j && !near; k++) near = Math.hypot(P[k * 3] - x, P[k * 3 + 2] - z) < 40;
        if (!near) continue;
        const key = `t${ti}:${i}`;
        if (!chunks.has(key)) chunks.set(key, u.buildTubeChunk(t, i, j));
        out.push(chunks.get(key));
      }
    });
    (u.boxes as any[]).forEach((b, bi) => {
      if (b.kind !== 'station' || Math.hypot(b.cx - x, b.cz - z) > Math.max(b.hu, b.hv) + 40) return;
      const key = `b${bi}`;
      if (!chunks.has(key)) chunks.set(key, u.buildStation(b, bi));
      out.push(chunks.get(key));
    });
    const meshes: any[] = [];
    for (const o of out) o.traverse((c: any) => { if (c.isMesh && c.geometry?.attributes?.position) { c.material = mat; c.updateMatrixWorld(true); meshes.push(c); } });
    return meshes;
  };
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  const world: any = { terrain, raycast: () => ({ t: Infinity }) };
  const rig = new CameraRig(cam, world);
  const P: any = {
    height: H, flying: false, flightBlend: 0, speeding: false, k: 1, vel: new THREE.Vector3(), pos: new THREE.Vector3(),
    pivot(o: any) { return o.set(this.pos.x, this.pos.y + H * 0.82, this.pos.z); },
  };
  rig.solidAt = (x, y, z) => {
    if (rig.underground) return !u.cameraFree(x, y, z, 0.12);
    // (Up top only the ground matters here: no buildings over the stairs.)
    return y < terrain.height(x, z) + 0.05 && !u.cameraFree(x, y, z, 0.12);
  };
  const ray = new THREE.Raycaster();
  const head = new THREE.Vector3(), d = new THREE.Vector3(), corner = new THREE.Vector3();
  const rep: CamReport = { poses: 0, out: 0, at: [] };
  const blocked = (meshes: any[], from: any, to: any) => {
    d.subVectors(to, from);
    const L = d.length();
    if (L < 1e-4) return false;
    ray.set(from, d.multiplyScalar(1 / L));
    ray.near = 0; ray.far = L;
    return ray.intersectObjects(meshes, false).length > 0;
  };
  for (const t of tubes) {
    const Pt = t.pts, n = Pt.length / 3;
    const len = t.cum[n - 1];
    const span = t.kind === 'sewer' ? Math.min(len, 60) : len;
    const meshes = meshesNear(Pt[0], Pt[2]);
    const all = new Set(meshes);
    for (const m of meshesNear(Pt[(n - 1) * 3], Pt[(n - 1) * 3 + 2])) all.add(m);
    const M = [...all];
    for (const dir of [1, -1]) for (const lat of [-(t.halfWidth - 0.45), 0, t.halfWidth - 0.45]) for (const pitch of [-0.35, -0.1, 0.25]) {
      rig.pitch = pitch;
      rig.snap();
      let bad = 0, first = '';
      // Walk at a run (5 m/s) along the tube, the camera trailing behind.
      for (let s0 = 0.5; s0 < span - 0.5; s0 += 5 / 30) {
        const s = dir > 0 ? s0 : span - s0;
        // Point at arc length s, offset lat across.
        let i = 0;
        while (i < n - 2 && t.cum[i + 1] < s) i++;
        const f = (s - t.cum[i]) / Math.max(1e-6, t.cum[i + 1] - t.cum[i]);
        const ax = Pt[i * 3], az = Pt[i * 3 + 2], bx = Pt[i * 3 + 3], bz = Pt[i * 3 + 5];
        const L = Math.hypot(bx - ax, bz - az) || 1, ux = (bx - ax) / L * dir, uz = (bz - az) / L * dir;
        const x = ax + (bx - ax) * f - uz * lat, z = az + (bz - az) * f + ux * lat;
        const h = tubeAt(t, x, Pt[i * 3 + 1] + (Pt[i * 3 + 4] - Pt[i * 3 + 1]) * f + 0.5, z);
        const fl = u.floorAt(x, (h ? h.floor : Pt[i * 3 + 1]) + 0.5, z);
        if (fl === null) continue;
        P.pos.set(x, fl, z);
        // Look the way it walks (the camera behind), turning like a player would.
        const want = Math.atan2(ux, uz);
        rig.yaw += Math.atan2(Math.sin(want - rig.yaw), Math.cos(want - rig.yaw)) * 0.15;
        rig.underground = u.isUnder(x, fl + 0.5, z);
        rig.update(1 / 30, P, ZERO as any);
        rep.poses++;
        P.pivot(head);
        let out = blocked(M, head, cam.position);
        if (!out) {
          // The near plane's corners must be inside too.
          cam.updateMatrixWorld(true);
          for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            corner.set(cx, cy, -1).unproject(cam);
            if (blocked(M, cam.position, corner)) { out = true; break; }
          }
        }
        if (out) { bad++; if (!first) first = `${t.kind} at ${x.toFixed(1)},${fl.toFixed(1)},${z.toFixed(1)} (s ${s.toFixed(1)}, lat ${lat.toFixed(1)}, pitch ${pitch}, ${rig.underground ? 'under' : 'top'}) cam ${cam.position.x.toFixed(1)},${cam.position.y.toFixed(1)},${cam.position.z.toFixed(1)}`; }
      }
      rep.out += bad;
      if (process.env.CAMSWEEP_VERBOSE) console.log(`  ${t.kind} ${tubes.indexOf(t)}/${tubes.length} dir ${dir} lat ${lat.toFixed(1)} pitch ${pitch}: ${bad} out (${Date.now() - t0} ms)`);
      if (bad && rep.at.length < 12) rep.at.push(`${bad}x ${first}`);
    }
  }
  return rep;
}

const sizes = (process.argv[2] ?? '0.5').split(',').map(Number);
const [a, b] = (process.argv[3] ?? '1-2').split('-').map(Number);
const sewers = process.argv[4] === 'sewers';
let poses = 0, out = 0;
for (const size of sizes) for (let seed = a; seed <= (b ?? a); seed++) {
  const r = camSweep(seed, size, sewers);
  poses += r.poses; out += r.out;
  console.log(`seed ${seed} @${size}: ${r.poses} camera poses, ${r.out} outside the tunnel`);
  for (const s of r.at) console.log('   ' + s);
}
console.log(`${out} of ${poses} poses outside (${(100 * out / Math.max(1, poses)).toFixed(2)}%)`);
process.exit(out ? 1 : 0);
