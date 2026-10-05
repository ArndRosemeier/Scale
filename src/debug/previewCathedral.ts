/**
 * Standalone preview of the cathedral (preview-cathedral.html): the three styles in a row (gothic
 * twin towers, gothic single spire, domed), walkable inside. URL: ?seed=<n>&view=<style 0–2, or
 * -1 for the row>&inside=1 (from the west door down the nave)&at=<u,v,y,tu,tv,ty> (camera and target
 * in the framed one's local frame, y above its floor)&night=1&still=1 (one frame, for screenshots)
 * &shatter=1 (break every window's glass first). Keys: 1–3 frame a style, 0 the row, I inside,
 * Space next seed, N day / night, G shatter the glass.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { TextureLibrary } from '../render/TextureLibrary';
import { createFacadeMaterial, createElemDepthMaterial } from '../render/materials/facade';
import { LandmarkWrecks } from '../destruction/LandmarkWreck';
import type { Destruction } from '../destruction/Destruction';
import { PIECE_STRIDE } from '../build/landmarkDice';
import type { LandmarkWreckData } from '../stream/CityStreamer';
import { G } from '../render/materials/globals';
import { toGeometry } from '../stream/CityStreamer';
import { buildLandmarkMeshes } from '../build/landmarks';
import { landmarkInterior } from '../plan/landmarkParts';
import { pointInPoly } from '../core/geom2';
import { siteRect, siteToWorld, type Landmark } from '../plan/landmarks';
import { Rng } from '../core/rng';
import type { Terrain } from '../world/terrain';

const NAMES = ['gothic, twin towers', 'gothic, one spire', 'domed'];
const q = new URLSearchParams(location.search);
let seed = Number(q.get('seed') ?? 1);
let view = Number(q.get('view') ?? -1);
let inside = q.get('inside') === '1';
let night = q.get('night') === '1';

const hud = document.getElementById('hud')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.AgXToneMapping;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.2, 20000);
const controls = new OrbitControls(camera, renderer.domElement);
const sun = new THREE.DirectionalLight(0xfff1dd, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -250, right: 250, top: 250, bottom: -250, near: 10, far: 3000 });
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xbcd4ff, 0x4a4535, 0.7);
scene.add(hemi);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000), new THREE.MeshStandardMaterial({ color: 0x5b6050, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const lights = Array.from({ length: 4 }, () => new THREE.PointLight(0xffe4c0, 0, 11, 2));
for (const l of lights) scene.add(l);
let indoor = false;
const flat = { height: () => 0, isWater: () => false } as unknown as Terrain;
const tex = new TextureLibrary();
await tex.load();
const root = new THREE.Group();
scene.add(root);
const built: Landmark[] = [];
let wrecks: LandmarkWrecks | null = null;
const D = { onImpact: undefined, impact: () => 0, restoreMound: () => undefined } as unknown as Destruction;
const noop = new Proxy({}, { get: () => () => undefined }) as never;

function build(): void {
  root.clear();
  built.length = 0;
  const data: LandmarkWreckData[] = [];
  let x = 0;
  for (let s = 0; s < 3; s++) {
    const r = new Rng(seed * 101 + s);
    const L = Math.round(r.range(62, 96)), W = Math.round(r.range(20, 28));
    const p = { L, W, H: r.range(20, 30), towerH: r.range(60, 105), transept: r.range(1.6, 2.1), wall: r.int(0, 3), roof: r.int(0, 2) };
    const hu = W / 2 + 18, hv = L / 2 + 16;
    const lm: Landmark = { id: s, kind: 'cathedral', name: NAMES[s], cell: 0, x: x + hu, z: 0, angle: 0.4, hu, hv, site: [], base: 0.15, low: 0, seed: r.nextU32(), style: s, p };
    lm.site = siteRect(lm, -lm.hu, -lm.hv, lm.hu, lm.hv);
    const b = buildLandmarkMeshes(lm, flat);
    const near = b.near.build();
    const Wd = 1024, n = b.pieces!.length / PIECE_STRIDE, ed = new Uint8Array(Wd * Math.ceil((n + 1) / Wd) * 2).fill(255);
    const et = new THREE.DataTexture(ed, Wd, ed.length / 2 / Wd, THREE.RGFormat, THREE.UnsignedByteType);
    et.needsUpdate = true;
    const facade = createFacadeMaterial(tex.facade, et, Wd);
    const mesh = new THREE.Mesh(toGeometry(near), facade);
    mesh.position.set(...near.origin);
    mesh.customDepthMaterial = createElemDepthMaterial(et, Wd);
    mesh.castShadow = mesh.receiveShadow = true;
    root.add(mesh);
    data.push({ index: s, lm, grid: b.grid!, pieces: b.pieces!, elemData: ed, elemTex: et, elemW: Wd, near: mesh, nearGlass: null, facadeMat: facade, glassMat: null });
    built.push(lm);
    x += hu * 2 + 30;
    console.log(`cathedral ${s}: ${(near.index.length / 3 / 1000).toFixed(1)}k triangles, ${n} pieces`);
  }
  wrecks = new LandmarkWrecks(data, D, noop, noop, flat, null, tex.facade);
  root.add(wrecks.group);
  frame();
}

/** Break every window's glass. */
function shatter(): void {
  for (const w of wrecks?.wrecks ?? []) for (let p = 0; p < w.n; p++) {
    if (!w.pane[p]) continue;
    const o = p * PIECE_STRIDE;
    wrecks!.impact(w.T[o + 2], w.T[o + 3], w.T[o + 4], 0.01, 2000, 0, 0, 0);
  }
  for (let t = 0; t < 1; t += 1 / 30) wrecks!.update(1 / 30);
}

/** Local (u, v, y over the floor) to world. */
function W3(lm: Landmark, u: number, v: number, y: number): THREE.Vector3 {
  const [x, z] = siteToWorld(lm, u, v);
  return new THREE.Vector3(x, lm.base + y, z);
}

function frame(): void {
  const lm = view >= 0 ? built[view] : null;
  if (lm && (inside || q.get('at'))) {
    const at = (q.get('at') ?? '').split(',').map(Number);
    const L = lm.p.L, front = 6 - L / 2;
    const [u, v, y, tu, tv, ty] = at.length === 6 ? at : [0, front + 3, 1.7, 0, front + L, 6];
    camera.position.copy(W3(lm, u, v, y));
    controls.target.copy(W3(lm, tu, tv, ty));
  } else if (lm) {
    const c = W3(lm, 0, 0, 0), d = Math.max(lm.hu, lm.hv) * 2.4;
    controls.target.set(c.x, 25, c.z);
    camera.position.set(c.x + d * 0.7, 45, c.z - d * 0.75);
  } else {
    const cx = (built[0].x + built[2].x) / 2, d = built[2].x - built[0].x + 200;
    controls.target.set(cx, 20, 0);
    camera.position.set(cx + d * 0.25, d * 0.3, -d * 0.7);
  }
  controls.update();
  // Indoors the game dims the sky's light and lights the room lamps nearest the player.
  lights.forEach((l) => (l.intensity = 0));
  if (lm && (inside || q.get('at'))) {
    const ins = landmarkInterior(lm, flat), p = camera.position;
    if (ins) {
      const c: { x: number; y: number; z: number; d: number }[] = [];
      for (let i = 0; i < ins.lights.length; i += 3) c.push({ x: ins.lights[i], y: ins.lights[i + 1], z: ins.lights[i + 2], d: Math.hypot(ins.lights[i] - p.x, ins.lights[i + 2] - p.z) });
      c.sort((a, b) => a.d - b.d);
      c.slice(0, 4).forEach((q2, i) => { lights[i].position.set(q2.x, q2.y, q2.z); lights[i].intensity = q2.d < 14 ? 2.2 + 7 * G.uNight.value : 0; });
    }
  }
  indoor = !!(lm && (inside || q.get('at')) && landmarkInterior(lm, flat)?.rooms.some((r) => r.y0 < camera.position.y && r.y1 > camera.position.y && pointInPoly(r.poly, camera.position.x, camera.position.z)));
  light();
  const c = controls.target;
  sun.position.set(c.x + 300, 700, c.z - 400);
  sun.target.position.copy(c);
  hud.textContent = `seed ${seed} — ${lm ? NAMES[view] + (inside ? ', inside' : '') : 'all styles'}\n1–3 style, 0 row, I inside, Space next seed, N night, G shatter`;
}

function light(): void {
  G.uNight.value = night ? 1 : 0;
  G.uDayLight.value = night ? 0.05 : 1;
  G.uLitFrac.value = night ? 0.6 : 0.1;
  const sky = new THREE.Color(night ? 0x070b18 : 0x9fc4e8);
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 3000, 12000);
  sun.intensity = night ? 0.05 : 3;
  hemi.intensity = (night ? 0.08 : 0.7) * (indoor ? 0.3 : 1);
  scene.environmentIntensity = (night ? 0.08 : 1) * (indoor ? 0.12 : 1);
}

addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key >= '1' && e.key <= '3') { view = Number(e.key) - 1; frame(); }
  else if (e.key === '0') { view = -1; inside = false; frame(); }
  else if (e.key === 'i' || e.key === 'I') { inside = !inside; if (view < 0) view = 0; frame(); }
  else if (e.key === ' ') { seed++; build(); }
  else if (e.key === 'n' || e.key === 'N') { night = !night; light(); }
  else if (e.key === 'g' || e.key === 'G') shatter();
});
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
light();
build();
if (q.get('shatter') === '1') shatter();
if (q.get('still') === '1') renderer.render(scene, camera);
else {
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => { wrecks?.update(Math.min(0.05, clock.getDelta())); controls.update(); renderer.render(scene, camera); });
}
(window as unknown as { cathedralReady: boolean; dbg: unknown }).dbg = { root, built, wrecks };
(window as unknown as { cathedralReady: boolean }).cathedralReady = true;
