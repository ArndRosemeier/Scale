/**
 * Standalone preview for procedural trees and street furniture (preview-props.html).
 * Keys: N = day/night, W = wind strength cycle, S = season cycle, F = toggle far-LOD row, T = text HUD.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  TREE_SPECIES, treeModel, shrubModel, createBarkMaterial, createLeafMaterial, createFarTreeMaterial,
  vegetationUniforms, applyVegetationShadow, type TreeModel,
} from './vegetation';
import { furnitureModel, createFurnitureMaterial, furnitureUniforms, FURNITURE_KINDS, type FurnitureKind } from './furniture';

const hud = document.getElementById('hud')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = envTex;
const daySky = new THREE.Color(0x9fc4e8), nightSky = new THREE.Color(0x070b18);
scene.background = daySky.clone();
scene.fog = new THREE.Fog(daySky.clone(), 120, 420);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1500);
camera.position.set(40, 22, 70);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(40, 5, 10);
controls.update();

const sun = new THREE.DirectionalLight(0xfff1dd, 3.2);
sun.position.set(60, 80, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
const sc = sun.shadow.camera;
sc.left = -110; sc.right = 110; sc.top = 110; sc.bottom = -110; sc.near = 1; sc.far = 300;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
sun.target.position.set(40, 0, 0);
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xbcd4ff, 0x4a4535, 0.6);
scene.add(hemi);

// ground
const groundMat = new THREE.MeshStandardMaterial({ color: 0x4f5446, roughness: 0.95 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
// a strip of "street" asphalt + curb to judge furniture scale
const road = new THREE.Mesh(new THREE.PlaneGeometry(260, 10), new THREE.MeshStandardMaterial({ color: 0x2c2d2f, roughness: 0.9 }));
road.rotation.x = -Math.PI / 2;
road.position.set(70, 0.005, 74);
road.receiveShadow = true;
scene.add(road);

const bark = createBarkMaterial();
const leaf = createLeafMaterial();
const far = createFarTreeMaterial();
(far as THREE.MeshStandardMaterial).side = THREE.DoubleSide;

const lines: string[] = [];
const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

function addInstanced(geo: THREE.BufferGeometry, mat: THREE.Material, mats: THREE.Matrix4[], shadow = true) {
  const m = new THREE.InstancedMesh(geo, mat, mats.length);
  mats.forEach((mm, i) => m.setMatrixAt(i, mm));
  m.instanceMatrix.needsUpdate = true;
  m.computeBoundingSphere();
  if (shadow) applyVegetationShadow(m);
  scene.add(m);
  return m;
}

const tmp = new THREE.Matrix4();
const q = new THREE.Quaternion();
function trs(x: number, z: number, yaw: number, s = 1) {
  q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  return tmp.clone().compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s, s));
}

// ---- trees: row per variant, one column per species ----------------------------------------
const farGroup: THREE.Object3D[] = [];
const t0 = performance.now();
lines.push('TREES (tris: wood / leaves / far)');
TREE_SPECIES.forEach((sp, i) => {
  for (let v = 0; v < 2; v++) {
    const tm: TreeModel = treeModel(sp, v);
    const x = i * 17;
    const z = v * 22;
    addInstanced(tm.wood, bark, [trs(x, z, v * 1.3)]);
    addInstanced(tm.leaves, leaf, [trs(x, z, v * 1.3)]);
    const f = addInstanced(tm.far, far, [trs(x, -30, v * 1.3), trs(x + 8, -30, 2)]);
    farGroup.push(f);
    lines.push(`${sp.padEnd(9)} v${v}  h ${tm.height.toFixed(1)}m  ${tris(tm.wood)} / ${tris(tm.leaves)} / ${tris(tm.far)}`);
  }
});
// shrubs
for (let v = 0; v < 4; v++) {
  const sm = shrubModel(v);
  const mats = [trs(-12, v * 4, v), trs(-15, v * 4 + 2, v + 2)];
  addInstanced(sm.wood, bark, mats);
  addInstanced(sm.leaves, leaf, mats);
  lines.push(`shrub v${v}  h ${sm.height.toFixed(1)}m  ${tris(sm.wood)} / ${tris(sm.leaves)} / ${tris(sm.far)}`);
}
// an instanced avenue (wind phase per instance)
{
  const tm = treeModel('plane', 2);
  const mats: THREE.Matrix4[] = [];
  for (let k = 0; k < 10; k++) mats.push(trs(k * 14, 56, k * 2.1, 0.85 + (k % 3) * 0.08));
  addInstanced(tm.wood, bark, mats);
  addInstanced(tm.leaves, leaf, mats);
}
lines.push(`tree gen: ${(performance.now() - t0).toFixed(0)} ms`);

// ---- furniture -----------------------------------------------------------------------------
const fmat = createFurnitureMaterial();
const lampLights: THREE.PointLight[] = [];
const signalMeshes: THREE.InstancedMesh[] = [];
lines.push('', 'FURNITURE (tris)');
const t1 = performance.now();
FURNITURE_KINDS.forEach((kind: FurnitureKind, i: number) => {
  for (let v = 0; v < 2; v++) {
    const fm = furnitureModel(kind, v);
    const x = (i % 11) * 12 + v * 5;
    const z = 82 + Math.floor(i / 11) * 18;
    const n = 1;
    const m = new THREE.InstancedMesh(fm.geometry, fmat, n);
    m.setMatrixAt(0, trs(x, z, 0));
    const col = new Float32Array(n * 3);
    const st = new Float32Array(n * 4);
    for (let k = 0; k < n; k++) { st[k * 4] = 1; st[k * 4 + 1] = (i + v) % 3; }
    // demonstrate per-instance paint: the second bin / classic lamp get a custom colour
    if (v === 1 && (kind === 'bin' || kind === 'lampClassic')) { col[0] = 0.1; col[1] = 0.2; col[2] = 0.45; }
    m.geometry = fm.geometry;
    m.geometry.setAttribute('iColor', new THREE.InstancedBufferAttribute(col, 3));
    m.geometry.setAttribute('iState', new THREE.InstancedBufferAttribute(st, 4));
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
    if (kind === 'trafficLight') signalMeshes.push(m);
    const pos = new THREE.Vector3();
    m.getMatrixAt(0, tmp);
    pos.setFromMatrixPosition(tmp);
    for (const l of fm.lights) {
      if (lampLights.length < 12) {
        const pl = new THREE.PointLight(new THREE.Color(...l.color), 0, 30, 2);
        pl.position.set(pos.x + l.pos[0], l.pos[1], pos.z + l.pos[2]);
        pl.userData.intensity = l.intensity * 80;
        scene.add(pl);
        lampLights.push(pl);
      }
    }
    lines.push(`${kind.padEnd(14)} v${v} ${String(tris(fm.geometry)).padStart(5)}  h ${fm.height.toFixed(2)} r ${fm.radius.toFixed(2)} ${fm.breakable}`);
  }
});
lines.push(`furniture gen: ${(performance.now() - t1).toFixed(0)} ms`);

// ---- controls ------------------------------------------------------------------------------
let night = false, windIdx = 1, seasonIdx = 0, showHud = true;
const winds = [0, 0.5, 1, 1.8];
const seasons = [0, 0.5, 1];
function applyDayNight() {
  const k = night ? 1 : 0;
  sun.intensity = night ? 0.05 : 3.2;
  hemi.intensity = night ? 0.06 : 0.6;
  scene.environmentIntensity = night ? 0.05 : 1;
  (scene.background as THREE.Color).copy(night ? nightSky : daySky);
  (scene.fog as THREE.Fog).color.copy(night ? nightSky : daySky);
  furnitureUniforms.uNight.value = k;
  furnitureUniforms.uLampOn.value = k;
  for (const l of lampLights) l.intensity = night ? l.userData.intensity : 0;
}
window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (key === 'n') { night = !night; applyDayNight(); }
  if (key === 'w') windIdx = (windIdx + 1) % winds.length;
  if (key === 's') seasonIdx = (seasonIdx + 1) % seasons.length;
  if (key === 'f') farGroup.forEach((f) => (f.visible = !f.visible));
  if (key === 't') { showHud = !showHud; hud.style.display = showHud ? 'block' : 'none'; }
});
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

Object.assign(window as unknown as Record<string, unknown>, {
  camera, controls, scene, renderer, vegetationUniforms, furnitureUniforms,
  setNight: (b: boolean) => { night = b; applyDayNight(); },
  setSeason: (i: number) => { seasonIdx = i % seasons.length; },
  setWind: (i: number) => { windIdx = i % winds.length; },
  hideHud: () => { showHud = false; hud.style.display = 'none'; },
  look: (px: number, py: number, pz: number, tx: number, ty: number, tz: number) => {
    camera.position.set(px, py, pz); controls.target.set(tx, ty, tz); controls.update();
  },
});

const clock = new THREE.Timer();
let frames = 0, fpsT = 0, fps = 0;
function step() {
  const dt = clock.update().getDelta();
  const t = clock.getElapsed();
  vegetationUniforms.uTime.value = t;
  vegetationUniforms.uWind.value = winds[windIdx];
  vegetationUniforms.uSeason.value = seasons[seasonIdx];
  furnitureUniforms.uTime.value = t;
  // traffic signal cycle: green 6s, amber 2s, red 6s (offset per instance)
  for (const m of signalMeshes) {
    const a = m.geometry.getAttribute('iState') as THREE.InstancedBufferAttribute;
    for (let k = 0; k < m.count; k++) {
      const c = (t + k * 3) % 14;
      a.setY(k, c < 6 ? 2 : c < 8 ? 1 : 0);
    }
    a.needsUpdate = true;
  }
  controls.update();
  renderer.render(scene, camera);
  frames++; fpsT += dt;
  if (fpsT > 0.5) { fps = frames / fpsT; frames = 0; fpsT = 0; }
  if (showHud) {
    hud.textContent = `fps ${fps.toFixed(0)}  draw tris ${renderer.info.render.triangles}  calls ${renderer.info.render.calls}\n` +
      `[N] night: ${night}  [W] wind: ${winds[windIdx]}  [S] season: ${seasons[seasonIdx]}  [F] far LOD  [T] HUD\n\n` + lines.join('\n');
  }
}
function frame() {
  step();
  requestAnimationFrame(frame);
}
(window as unknown as Record<string, unknown>).renderNow = () => { step(); return renderer.info.render.triangles; };
applyDayNight();
frame();
