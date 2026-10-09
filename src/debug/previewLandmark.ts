/**
 * Standalone preview of a walkable landmark from a real city plan (preview-landmark.html): the
 * museum, the glasshouse or the airport terminal of ?seed=<n>&size=<s>&kind=<kind>, rebuilt on
 * flat ground, outside or inside. URL: &at=<u,v,y,tu,tv,ty> (camera and target in its local
 * frame, y above its floor; default: outside, three-quarter view)&night=1&still=1 (one frame, for
 * screenshots). Inside, the room lights nearest the camera are lit as the game does.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { TextureLibrary } from '../render/TextureLibrary';
import { createFacadeMaterial } from '../render/materials/facade';
import { clearGlassMaterial } from '../render/materials/clearGlass';
import { G } from '../render/materials/globals';
import { toGeometry } from '../stream/CityStreamer';
import { buildLandmarkMeshes } from '../build/landmarks';
import { landmarkInterior } from '../plan/landmarkParts';
import { buildMacroPlan } from '../plan/macro';
import { siteRect, siteToWorld, type Landmark } from '../plan/landmarks';
import { Terrain } from '../world/terrain';
import { makeProfile } from '../world/settings';
import type { MeshBuilder } from '../build/meshBuilder';

const q = new URLSearchParams(location.search);
const seed = Number(q.get('seed') ?? 7), size = Number(q.get('size') ?? 0.8), kind = q.get('kind') ?? 'glasshouse';
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
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.2, 20000);
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
const lights = Array.from({ length: 6 }, () => new THREE.PointLight(0xffe4c0, 0, 16, 2));
for (const l of lights) scene.add(l);

const tex = new TextureLibrary();
await tex.load();
// The landmark as planned in that city, moved to the origin on flat ground.
const real = buildMacroPlan(new Terrain(makeProfile({ seed, size }))).landmarks.find((l) => l.kind === kind);
if (!real) throw new Error(`no ${kind} in seed ${seed} size ${size}`);
const flat = { height: () => 0, isWater: () => false } as unknown as Terrain;
const lm: Landmark = { ...real, x: 0, z: 0, angle: 0, base: 0.15, low: 0, site: [] };
lm.site = siteRect(lm, -lm.hu, -lm.hv, lm.hu, lm.hv);
const b = buildLandmarkMeshes(lm, flat);
const facade = createFacadeMaterial(tex.facade, null), glassM = clearGlassMaterial();
const add = (mb: MeshBuilder, glass: boolean) => {
  if (mb.empty) return;
  const md = mb.build(), mesh = new THREE.Mesh(toGeometry(md), glass ? glassM : facade);
  mesh.position.set(...md.origin);
  mesh.castShadow = !glass;
  mesh.receiveShadow = true;
  if (glass) mesh.renderOrder = 2;
  scene.add(mesh);
};
add(b.near, false);
if (b.glass) add(b.glass[0], true);
if (b.inner) { add(b.inner[0], false); add(b.inner[1], true); }

const W3 = (u: number, v: number, y: number) => { const [x, z] = siteToWorld(lm, u, v); return new THREE.Vector3(x, lm.base + y, z); };
const at = (q.get('at') ?? '').split(',').map(Number);
const inside = at.length === 6;
if (inside) {
  camera.position.copy(W3(at[0], at[1], at[2]));
  controls.target.copy(W3(at[3], at[4], at[5]));
  const ins = landmarkInterior(lm, flat)!, p = camera.position, c: { x: number; y: number; z: number; d: number }[] = [];
  for (let i = 0; i < ins.lights.length; i += 3) c.push({ x: ins.lights[i], y: ins.lights[i + 1], z: ins.lights[i + 2], d: Math.hypot(ins.lights[i] - p.x, ins.lights[i + 2] - p.z) });
  c.sort((a1, a2) => a1.d - a2.d);
  c.slice(0, lights.length).forEach((l, i) => { lights[i].position.set(l.x, l.y, l.z); lights[i].intensity = 3 + 8 * (night ? 1 : 0); });
} else {
  const d = Math.max(lm.hu, lm.hv) * 1.5;
  controls.target.set(0, 8, 0);
  camera.position.copy(W3(d * 0.6, -d, d * 0.45));
}
controls.update();
G.uNight.value = night ? 1 : 0;
G.uDayLight.value = night ? 0.05 : 1;
G.uLitFrac.value = night ? 0.6 : 0.1;
const sky = new THREE.Color(night ? 0x070b18 : 0x9fc4e8);
scene.background = sky;
sun.position.set(300, 700, -400);
sun.intensity = night ? 0.05 : 3;
hemi.intensity = night ? 0.08 : 0.7;
hud.textContent = `${lm.name} (${kind} style ${lm.style}), seed ${seed}${inside ? ', inside' : ''}`;
if (q.get('still') === '1') renderer.render(scene, camera);
else renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
(window as unknown as { ready: boolean }).ready = true;
