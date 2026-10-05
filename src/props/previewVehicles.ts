/**
 * Standalone vehicle preview (preview-vehicles.html). Renders every kind × variant through the
 * instanced path (one InstancedMesh per body model, one per wheel geometry) on a ground plane
 * with a RoomEnvironment env map, day/night, light-state toggles and triangle counts.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import {
  VEHICLE_KINDS, vehicleModel, createVehicleMaterial, vehicleUniforms, paintColor, createInstancedVehicleGeometry,
  type VehicleKind, type VehicleModel,
} from './vehicles';
import { Rng } from '../core/rng';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = envTex;

const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 800);
camera.position.set(-6, 5, 14);
const controls = new OrbitControls(camera, canvas);
controls.target.set(6, 0.8, 4);
controls.enableDamping = true;
controls.update();

// ---- lights
const sun = new THREE.DirectionalLight(0xfff3e0, 3.2);
sun.position.set(-30, 45, 25);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera as THREE.OrthographicCamera;
sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 150;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
sun.target.position.set(15, 0, 10);
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xbfd6ff, 0x3a3530, 0.6);
scene.add(hemi);
const lamps: THREE.PointLight[] = [];
for (let i = 0; i < 6; i++) {
  const l = new THREE.PointLight(0xffc68a, 0, 22, 1.6);
  l.position.set(-2 + i * 8, 6, 22);
  scene.add(l);
  lamps.push(l);
}

// ---- ground (procedural asphalt with parking lines)
function groundTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const x = c.getContext('2d')!;
  x.fillStyle = '#3b3b3d';
  x.fillRect(0, 0, 1024, 1024);
  const r = new Rng(7);
  for (let i = 0; i < 40000; i++) {
    const v = 45 + r.int(0, 30);
    x.fillStyle = `rgb(${v},${v},${v + 2})`;
    x.fillRect(r.int(0, 1023), r.int(0, 1023), 2, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(30, 30);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const ground = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.92 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ---- vehicles
const matInst = createVehicleMaterial(true);

interface Placed { model: VehicleModel; pos: THREE.Vector3; rotY: number; paint: [number, number, number]; kind: VehicleKind; police: boolean }

const showroom: Placed[] = [];
const rowZ: number[] = [];
{
  let z = 0;
  VEHICLE_KINDS.forEach((kind, ki) => {
    const models = [0, 1, 2, 3].map((v) => vehicleModel(kind, v));
    const maxW = Math.max(...models.map((m) => m.width));
    if (ki > 0) z += maxW / 2 + 3.2;
    rowZ.push(z);
    let x = 0;
    models.forEach((m, v) => {
      x += m.length / 2;
      showroom.push({ model: m, pos: new THREE.Vector3(x, 0, z), rotY: Math.PI / 2, paint: paintColor(kind, ki * 10 + v + 3), kind, police: kind === 'police' });
      x += m.length / 2 + 2.2;
    });
    z += maxW / 2 + 3.2;
  });
}

const crowd: Placed[] = [];
{
  const r = new Rng(1234);
  const carKinds: VehicleKind[] = ['sedan', 'sedan', 'sedan', 'hatch', 'hatch', 'wagon', 'suv', 'suv', 'van', 'pickup', 'taxi', 'sports', 'delivery', 'police'];
  for (let i = 0; i < 200; i++) {
    const kind = r.pick(carKinds);
    const m = vehicleModel(kind, r.int(0, 3));
    const col = i % 20, row = (i / 20) | 0;
    crowd.push({ model: m, pos: new THREE.Vector3(col * 2.8, 0, -12 - row * 6.5), rotY: row % 2 ? 0 : Math.PI, paint: paintColor(kind, i * 7 + 1), kind, police: kind === 'police' });
  }
}

interface Batch { mesh: THREE.InstancedMesh; geo: THREE.BufferGeometry; items: { p: Placed; wheel?: number }[]; isWheel: boolean }
const batches: Batch[] = [];
function buildBatches(list: Placed[], group: THREE.Group) {
  const byModel = new Map<THREE.BufferGeometry, Placed[]>();
  const byWheel = new Map<THREE.BufferGeometry, { p: Placed; wheel: number }[]>();
  for (const p of list) {
    if (!byModel.has(p.model.body)) byModel.set(p.model.body, []);
    byModel.get(p.model.body)!.push(p);
    if (!byWheel.has(p.model.wheel)) byWheel.set(p.model.wheel, []);
    p.model.wheels.forEach((_, i) => byWheel.get(p.model.wheel)!.push({ p, wheel: i }));
  }
  for (const [geoBase, items] of byModel) {
    const geo = createInstancedVehicleGeometry(geoBase, items.length);
    const mesh = new THREE.InstancedMesh(geo, matInst, items.length);
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
    batches.push({ mesh, geo, items: items.map((p) => ({ p })), isWheel: false });
  }
  for (const [geoBase, items] of byWheel) {
    const geo = createInstancedVehicleGeometry(geoBase, items.length);
    const mesh = new THREE.InstancedMesh(geo, matInst, items.length);
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
    batches.push({ mesh, geo, items, isWheel: true });
  }
}
const showGroup = new THREE.Group();
const crowdGroup = new THREE.Group();
crowdGroup.visible = false;
scene.add(showGroup, crowdGroup);
buildBatches(showroom, showGroup);
buildBatches(crowd, crowdGroup);

// ---- state
const state = { night: false, head: 0, brake: 0, ind: 0, dmg: 0, spin: false, spinAngle: 0, paintSeed: 0 };
const m4 = new THREE.Matrix4(), mBody = new THREE.Matrix4(), mW = new THREE.Matrix4(), mMirror = new THREE.Matrix4().makeScale(-1, 1, 1), mRot = new THREE.Matrix4();
const q = new THREE.Quaternion();
const one = new THREE.Vector3(1, 1, 1);

function updateInstances() {
  for (const b of batches) {
    const paint = b.geo.getAttribute('iPaint') as THREE.InstancedBufferAttribute;
    const st = b.geo.getAttribute('iState') as THREE.InstancedBufferAttribute;
    b.items.forEach((it, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.p.rotY);
      mBody.compose(it.p.pos, q, one);
      if (b.isWheel) {
        const w = it.p.model.wheels[it.wheel!];
        mW.makeTranslation(w[0], w[1], w[2]);
        mRot.makeRotationX(-state.spinAngle);
        m4.multiplyMatrices(mBody, mW).multiply(mRot);
        if (w[0] < 0) m4.multiply(mMirror);
      } else m4.copy(mBody);
      b.mesh.setMatrixAt(i, m4);
      const pc = state.paintSeed ? paintColor(it.p.kind, (it.p.pos.x * 13 + it.p.pos.z * 7 + state.paintSeed) | 0) : it.p.paint;
      paint.setXYZ(i, pc[0], pc[1], pc[2]);
      const ind = it.p.police && state.ind === 3 ? 3 : state.ind === 3 ? 0 : state.ind;
      st.setXYZW(i, state.head, state.brake, ind, state.dmg);
    });
    b.mesh.instanceMatrix.needsUpdate = true;
    paint.needsUpdate = true;
    st.needsUpdate = true;
    b.mesh.computeBoundingSphere();
  }
}

function applyNight() {
  vehicleUniforms.uNight.value = state.night ? 1 : 0;
  sun.intensity = state.night ? 0.08 : 3.2;
  sun.color.set(state.night ? 0x8899cc : 0xfff3e0);
  hemi.intensity = state.night ? 0.04 : 0.6;
  scene.environmentIntensity = state.night ? 0.06 : 1.0;
  scene.background = new THREE.Color(state.night ? 0x05070d : 0x9fb8d6);
  scene.fog = new THREE.Fog(state.night ? 0x05070d : 0x9fb8d6, 60, 260);
  for (const l of lamps) l.intensity = state.night ? 120 : 0;
  bloom.enabled = state.night;
  bloom.strength = 0.6;
}

// ---- post
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.6, 0.35, 2.5);
composer.addPass(bloom);
composer.addPass(new OutputPass());

applyNight();
updateInstances();

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'n') { state.night = !state.night; if (state.night) state.head = 1; applyNight(); }
  if (k === 'h') state.head = state.head ? 0 : 1;
  if (k === 'b') state.brake = state.brake ? 0 : 1;
  if (k === 'l') state.ind = state.ind === -1 ? 0 : -1;
  if (k === 'r') state.ind = state.ind === 1 ? 0 : 1;
  if (k === 'z') state.ind = state.ind === 2 ? 0 : 2;
  if (k === 'p') state.ind = state.ind === 3 ? 0 : 3;
  if (k === 'd') state.dmg = state.dmg >= 1 ? 0 : Math.round((state.dmg + 0.34) * 100) / 100;
  if (k === 'w') state.spin = !state.spin;
  if (k === 'c') state.paintSeed++;
  if (k === 't') crowdGroup.visible = !crowdGroup.visible;
  updateInstances();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// ---- HUD
const triCount = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
let tableHtml = '<table><tr><td><b>kind</b></td><td>v0</td><td>v1</td><td>v2</td><td>v3</td><td>wheel</td><td>L×W×H</td></tr>';
for (const kind of VEHICLE_KINDS) {
  const ms = [0, 1, 2, 3].map((v) => vehicleModel(kind, v));
  tableHtml += `<tr><td>${kind}</td>${ms.map((m) => `<td>${triCount(m.body)}</td>`).join('')}<td>${triCount(ms[0].wheel)}</td><td>${ms[0].length.toFixed(2)}×${ms[0].width.toFixed(2)}×${ms[0].height.toFixed(2)}</td></tr>`;
}
tableHtml += '</table>';
let fps = 0, frames = 0, lastT = performance.now();
let lastInfo = { t: 0, c: 0 };

const clock = new THREE.Timer();
function frame() {
  const dt = clock.update().getDelta();
  vehicleUniforms.uTime.value += dt;
  if (state.spin) { state.spinAngle += dt * 6; updateInstances(); }
  controls.update();
  renderer.info.reset();
  composer.render();
  lastInfo = { t: renderer.info.render.triangles, c: renderer.info.render.calls };
  frames++;
  const now = performance.now();
  if (now - lastT > 500) {
    fps = (frames * 1000) / (now - lastT); frames = 0; lastT = now;
        hud.innerHTML = `<b>Vehicle triangles (body)</b>${tableHtml}<br/>frame: ${lastInfo.t.toLocaleString()} tris · ${lastInfo.c} calls · ${fps.toFixed(0)} fps<br/>` +
      `night ${state.night ? 'on' : 'off'} · head ${state.head} · brake ${state.brake} · ind ${state.ind} · dmg ${state.dmg}`;
  }
  requestAnimationFrame(frame);
}
renderer.info.autoReset = false;
frame();

// handle for automation / debugging
(window as unknown as { __vp: unknown }).__vp = {
  THREE, camera, controls, renderer, scene, state, composer, bloom, sun, hemi, updateInstances, applyNight,
  look(px: number, py: number, pz: number, tx: number, ty: number, tz: number) { camera.position.set(px, py, pz); controls.target.set(tx, ty, tz); controls.update(); },
  /** camera around showroom car (row i, variant j): ang = yaw from the -z side, d = distance, h = eye height */
  car(i: number, j: number, ang = 1.15, d = 5.2, h = 1.3, ty = 0.75) {
    const c = showroom[i * 4 + j];
    camera.position.set(c.pos.x - Math.sin(ang) * d, h, c.pos.z - Math.cos(ang) * d);
    controls.target.set(c.pos.x, ty, c.pos.z); controls.update();
  },
  rowZ, showroom: showroom.map((s) => ({ kind: s.kind, x: s.pos.x, z: s.pos.z, L: s.model.length })),
};
