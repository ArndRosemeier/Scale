/**
 * Standalone preview of the cathedral gargoyle (preview-gargoyle.html, game/citizens/gargoyle): a
 * row of its poses (perched stone, awake and talking, waving, walking, pointing, gliding), and a
 * cathedral with the gargoyle on its ledge. URL: ?view=row|perch &style=0–2 (the cathedral's)
 * &seed=<n> &pose=<i> (just that one, at the origin) &night=1 &at=x,y,z,tx,ty,tz (camera, target) &still=1 (one frame, for screenshots).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createCreatureMaterial } from '../game/threats/rig/CreatureMesh';
import { GargoyleMesh } from '../game/citizens/gargoyle/GargoyleMesh';
import { GargoyleRig } from '../game/citizens/gargoyle/gargoyleRig';
import { TextureLibrary } from '../render/TextureLibrary';
import { createFacadeMaterial } from '../render/materials/facade';
import { G } from '../render/materials/globals';
import { toGeometry } from '../stream/CityStreamer';
import { buildLandmarkMeshes } from '../build/landmarks';
import { landmarkInterior } from '../plan/landmarkParts';
import { siteRect, type Landmark } from '../plan/landmarks';
import { Rng } from '../core/rng';
import type { Terrain } from '../world/terrain';

const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'row';
const night = q.get('night') === '1';
const hud = document.getElementById('hud')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.AgXToneMapping;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = night ? 0.08 : 1;
scene.background = new THREE.Color(night ? 0x070b18 : 0x9fc4e8);
G.uNight.value = night ? 1 : 0;
G.uDayLight.value = night ? 0.05 : 1;
G.uLitFrac.value = night ? 0.6 : 0.1;
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.05, 5000);
const controls = new OrbitControls(camera, renderer.domElement);
const sun = new THREE.DirectionalLight(0xfff1dd, night ? 0.08 : 3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 600 });
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x4a4535, night ? 0.1 : 0.7));
const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshStandardMaterial({ color: 0x77736a, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const mat = createCreatureMaterial();
const rigs: GargoyleRig[] = [];
const meshes: GargoyleMesh[] = [];
const add = (set: (r: GargoyleRig) => void): GargoyleRig => {
  const r = new GargoyleRig();
  set(r);
  const m = new GargoyleMesh(mat);
  scene.add(m.mesh);
  rigs.push(r); meshes.push(m);
  return r;
};
const POSES: [string, (r: GargoyleRig) => void][] = [
  ['perched stone', (r) => { r.crouch = 1; r.fold = 1; r.still = true; r.eyes = 0; }],
  ['awake, talking', (r) => { r.crouch = 1; r.fold = 1; r.gape = 0.6; r.eyes = 0.6; }],
  ['standing, waving', (r) => { r.crouch = 0.25; r.rest = 0; r.fold = 0.9; r.wave = 1; r.eyes = 0.6; }],
  ['walking', (r) => { r.crouch = 0.3; r.rest = 0; r.walk = 1; r.phase = 1; r.fold = 0.95; r.curl = 0; }],
  ['pointing', (r) => { r.crouch = 0.2; r.rest = 0; r.aim = 1; r.fold = 0.85; r.curl = 0.3; }],
  ['stretching, wings out', (r) => { r.crouch = 0.1; r.rest = 0; r.stretch = 1; r.fold = 0; r.curl = 0; }],
  ['gliding', (r) => { r.feet = null; r.pitch = 1.2; r.crouch = 0; r.rest = 0; r.fold = 0; r.beat = 0.6; r.flap = 0.5; r.curl = 0; }],
];

let target = new THREE.Vector3();
if (view === 'perch') {
  const tex = new TextureLibrary();
  await tex.load();
  const flat = { height: () => 0, isWater: () => false } as unknown as Terrain;
  const st = Number(q.get('style') ?? 0), seed = Number(q.get('seed') ?? 1);
  const r = new Rng(seed * 101 + st);
  const L = Math.round(r.range(62, 96)), W = Math.round(r.range(20, 28));
  const p = { L, W, H: r.range(20, 30), towerH: r.range(60, 105), transept: r.range(1.6, 2.1), wall: r.int(0, 3), roof: r.int(0, 2) };
  const hu = W / 2 + 18, hv = L / 2 + 16;
  const lm: Landmark = { id: 0, kind: 'cathedral', name: 'c', cell: 0, x: 0, z: 0, angle: 0.4, hu, hv, site: [], base: 0.15, low: 0, seed: r.nextU32(), style: st, p };
  lm.site = siteRect(lm, -hu, -hv, hu, hv);
  const b = buildLandmarkMeshes(lm, flat);
  const near = b.near.build();
  const Wd = 1024, n = b.pieces!.length / 12, ed = new Uint8Array(Wd * Math.ceil((n + 1) / Wd) * 2).fill(255);
  const et = new THREE.DataTexture(ed, Wd, ed.length / 2 / Wd, THREE.RGFormat, THREE.UnsignedByteType);
  et.needsUpdate = true;
  const mesh = new THREE.Mesh(toGeometry(near), createFacadeMaterial(tex.facade, et, Wd));
  mesh.position.set(...near.origin);
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  const ins = landmarkInterior(lm, flat)!;
  for (const pc of ins.perches) {
    add((g) => { POSES[0][1](g); g.eyes = night ? 0.6 : 0; g.still = !night; g.x = pc.x; g.z = pc.z; g.feet = pc.y; g.yaw = pc.h + Math.PI; });
  }
  const pc = ins.perches[0];
  target.set(pc.x, pc.y + 0.6, pc.z);
  const f = { x: -Math.sin(pc.h), z: -Math.cos(pc.h) };
  camera.position.set(pc.x + f.x * 7 + f.z * 2, pc.y + 1.5, pc.z + f.z * 7 - f.x * 2);
  hud.textContent = `cathedral style ${st}: ${ins.perches.length} perches`;
} else {
  const one = q.get('pose');
  (one !== null ? [POSES[Number(one)]] : POSES).forEach(([, set], i) => add((r) => { set(r); r.x = one !== null ? 0 : (i - (POSES.length - 1) / 2) * 1.9; r.z = 0; r.yaw = 0; if (r.pitch > 1) { r.feet = null; r.y = 1.2; } else r.feet = 0; }));
  target.set(0, 0.7, 0);
  camera.position.set(1.5, 1.4, 9.5);
  hud.textContent = POSES.map((p) => p[0]).join(' · ');
}
const at = (q.get('at') ?? '').split(',').map(Number);
if (at.length === 6) { camera.position.set(at[0], at[1], at[2]); target = new THREE.Vector3(at[3], at[4], at[5]); }
controls.target.copy(target);
controls.update();
sun.position.set(target.x + 30, target.y + 60, target.z + 40);
sun.target.position.copy(target);

const draw = (t: number) => {
  rigs.forEach((r, i) => { r.t = t; r.place(); meshes[i].draw(r); });
};
draw(0);
if (q.get('still') === '1') renderer.render(scene, camera);
else {
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const t = clock.getElapsedTime();
    for (const r of rigs) { if (r.walk > 0) r.phase = t * 6; if (r.beat > 0) r.flap = t * 5; if (r.gape > 0) r.gape = 0.3 + 0.3 * Math.sin(t * 11); }
    draw(t); controls.update(); renderer.render(scene, camera);
  });
}
(window as unknown as { gargoyleReady: boolean }).gargoyleReady = true;
