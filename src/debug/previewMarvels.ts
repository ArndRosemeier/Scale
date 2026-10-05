/**
 * Standalone preview of the marvels (preview-marvels.html): one of each family in a row, made
 * for a seed. URL: ?seed=<n>&radius=<city radius m>&view=<family 0–7, or -1 for the row>&night=1.
 * &still=1 draws one frame (screenshots). Keys: 1–8 frame a family, 0 the row, Space the next seed, N day / night.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { TextureLibrary } from '../render/TextureLibrary';
import { createFacadeMaterial } from '../render/materials/facade';
import { clearGlassMaterial } from '../render/materials/clearGlass';
import { G } from '../render/materials/globals';
import { toGeometry } from '../stream/CityStreamer';
import { buildLandmarkMesh } from '../build/landmarks';
import { marvelDesign, siteRect, type Landmark } from '../plan/landmarks';
import { MARVEL_STYLES, type MS } from '../plan/marvelParts';
import { Rng } from '../core/rng';
import type { Terrain } from '../world/terrain';

const FAMILY = ['starship spire', 'helix tower', 'porous slab', 'twisted tower', 'skyship', 'halo tower', 'orbs', 'stack'];
const q = new URLSearchParams(location.search);
let seed = Number(q.get('seed') ?? 1);
const radius = Number(q.get('radius') ?? 7000);
let view = Number(q.get('view') ?? -1);
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
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 20000);
const controls = new OrbitControls(camera, renderer.domElement);
const sun = new THREE.DirectionalLight(0xfff1dd, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -1500, right: 1500, top: 1500, bottom: -1500, near: 10, far: 5000 });
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xbcd4ff, 0x4a4535, 0.7);
scene.add(hemi);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000), new THREE.MeshStandardMaterial({ color: 0x5b6050, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const flat = { height: () => 0, isWater: () => false } as unknown as Terrain;
const tex = new TextureLibrary();
await tex.load();
const facade = createFacadeMaterial(tex.facade, null);
const glass = clearGlassMaterial();
const root = new THREE.Group();
scene.add(root);
const frames: { x: number; h: number; r: number }[] = [];

function build(): void {
  root.clear();
  frames.length = 0;
  let x = 0;
  for (let s = 0; s < MARVEL_STYLES; s++) {
    const r = new Rng(seed * 101 + s);
    const d = marvelDesign(s as MS, radius)(r.fork('design'), 1)!;
    const lm: Landmark = { id: s, kind: 'marvel', name: FAMILY[s], cell: 0, x: x + d.hu, z: 0, angle: 0.4, hu: d.hu, hv: d.hv, site: [], base: 0.15, low: 0, seed: r.nextU32(), style: s, p: d.p };
    lm.site = siteRect(lm, -lm.hu, -lm.hv, lm.hu, lm.hv);
    const near = buildLandmarkMesh(lm, flat, 0).build(), clear = buildLandmarkMesh(lm, flat, 0, true).build();
    const mesh = new THREE.Mesh(toGeometry(near), facade);
    mesh.position.set(...near.origin);
    mesh.castShadow = mesh.receiveShadow = true;
    root.add(mesh);
    if (clear.index.length) {
      const g = new THREE.Mesh(toGeometry(clear), glass);
      g.position.set(...clear.origin);
      g.renderOrder = 1;
      root.add(g);
    }
    const h = near.bounds[4];
    frames.push({ x: lm.x, h, r: Math.max(d.hu, d.hv) });
    x += d.hu * 2 + 40;
  }
  frame();
}

function frame(): void {
  const f = view >= 0 ? frames[view] : null;
  const cx = f ? f.x : frames[frames.length - 1].x / 2, h = f ? f.h : Math.max(...frames.map((q) => q.h));
  const dist = f ? Math.max(f.h * 1.15, f.r * 3) : frames[frames.length - 1].x * 0.75;
  controls.target.set(cx, h * 0.42, 0);
  camera.position.set(cx + dist * 0.55, h * 0.35 + 20, dist);
  controls.update();
  sun.position.set(cx + 800, 1400, 900);
  sun.target.position.set(cx, 0, 0);
  hud.textContent = `seed ${seed}, radius ${radius} m — ${f ? FAMILY[view] + `, ${f.h.toFixed(0)} m` : 'all families'}\n1–8 family, 0 row, Space next seed, N night`;
}

function light(): void {
  G.uNight.value = night ? 1 : 0;
  G.uDayLight.value = night ? 0.05 : 1;
  G.uLitFrac.value = night ? 0.6 : 0.1;
  const sky = new THREE.Color(night ? 0x070b18 : 0x9fc4e8);
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 3000, 12000);
  sun.intensity = night ? 0.05 : 3;
  hemi.intensity = night ? 0.08 : 0.7;
  scene.environmentIntensity = night ? 0.08 : 1;
}

addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key >= '1' && e.key <= '8') { view = Number(e.key) - 1; frame(); }
  else if (e.key === '0') { view = -1; frame(); }
  else if (e.key === ' ') { seed++; build(); }
  else if (e.key === 'n' || e.key === 'N') { night = !night; light(); }
});
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
light();
build();
// still=1: one frame only (screenshots in a software renderer).
if (q.get('still') === '1') renderer.render(scene, camera);
else renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
(window as unknown as { marvelsReady: boolean }).marvelsReady = true;
