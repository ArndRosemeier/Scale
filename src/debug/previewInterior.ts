/**
 * Standalone preview of a real storey's interior (preview-interior.html), the way the game builds
 * it when you walk in (InteriorGen.planFloor + InteriorBuilder.buildFloorMeshes), lit by its
 * ceiling lights. URL: ?seed=<n>&size=<s>&n=<k-th home building from the centre>&floor=<f>
 * &room=<room index: stand in its corner and look across; -1: the whole storey from above>&top=1 (the room
 * from above, ceiling cut away)&type=<room type: count only those rooms>
 * &still=1 (one frame, for screenshots). Keys: Space next building, R next room, F next floor.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { makeProfile } from '../world/settings';
import { Terrain } from '../world/terrain';
import { buildMacroPlan } from '../plan/macro';
import { planCell } from '../plan/cell';
import { buildingLayout } from '../build/buildingLayout';
import { planFloor, planCores, coreFits, shopKindOf } from '../interior/InteriorGen';
import { buildFloorMeshes } from '../interior/InteriorBuilder';
import { minAreaRect, polyCentroid } from '../core/geom2';
import type { BuildingDesc } from '../plan/building';

const q = new URLSearchParams(location.search);
const seed = Number(q.get('seed') ?? 42), size = Number(q.get('size') ?? 0.4);
const top = q.get('top') === '1', kind = q.get('type');
let n = Number(q.get('n') ?? 0), floor = Number(q.get('floor') ?? 1), room = Number(q.get('room') ?? -1);

const hud = document.getElementById('hud')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.AgXToneMapping;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202326);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 500);
const controls = new OrbitControls(camera, renderer.domElement);
scene.add(new THREE.HemisphereLight(0xfff4e6, 0x403a33, 1.2));
const root = new THREE.Group();
scene.add(root);

const terrain = new Terrain(makeProfile({ seed, size }));
const macro = buildMacroPlan(terrain);
const c0 = macro.centres[0];
const cells = macro.cells.slice().sort((a, b) => Math.hypot(a.centroid[0] - c0.x, a.centroid[1] - c0.z) - Math.hypot(b.centroid[0] - c0.x, b.centroid[1] - c0.z));
const homes: BuildingDesc[] = [];
for (const c of cells.slice(0, 12)) for (const b of planCell(macro, c, terrain).buildings) {
  if (b.use !== 'office' && b.use !== 'industrial' && b.use !== 'parking' && b.style !== 'church' && b.floors >= 2) homes.push(b);
}

function show(): void {
  root.clear();
  const b = homes[n % homes.length];
  const L = buildingLayout(b, terrain, 0);
  const fl = L.floors.find((x) => x.f === Math.min(floor, b.floors - 1))!;
  const poly = L.tiers[fl.tier].poly;
  const { lift, stair } = planCores(b, L.tiers[0].poly, Math.max(...L.floors.map((x) => x.y1 - x.y0)), L.door);
  const next = L.floors.find((x) => x.f === fl.f + 1);
  const up = !!stair && !!next && coreFits(stair, poly) && coreFits(stair, L.tiers[next.tier].poly);
  const plan = planFloor(b, poly, fl.f, fl.y0, fl.y1 - fl.y0, shopKindOf(b), lift, stair, up, fl.f > 0 && !!stair && coreFits(stair, poly), fl.f === 0 ? L.door : null);
  root.add(buildFloorMeshes(plan, poly, [], [], poly));
  for (let i = 0; i < plan.lights.length; i += 2) {
    const l = new THREE.PointLight(0xffe2bc, 6, 9, 1.6);
    l.position.set(plan.lights[i], plan.y + plan.height - 0.5, plan.lights[i + 1]);
    root.add(l);
  }
  const rooms = plan.rooms.filter((r) => (kind ? r.type === kind : r.type !== 'corridor' && r.type !== 'stairs' && r.type !== 'hall'));
  if (room >= 0 && rooms.length) {
    const r = rooms[room % rooms.length];
    const o = minAreaRect(r.poly), cx = o.cx, cz = o.cz;
    if (top) {
      // From above (the ceiling is one-sided and drops out), tilted a little.
      camera.position.set(cx + o.uz * 0.8, plan.y + Math.max(o.hu, o.hv) * 1.5 + 2.5, cz - o.ux * 0.8);
      controls.target.set(cx, plan.y, cz);
    } else {
      // A corner of the room, a little in from the walls, looking across to the far corner.
      const ex = cx - o.ux * (o.hu - 0.45) + o.uz * (o.hv - 0.45), ez = cz - o.uz * (o.hu - 0.45) - o.ux * (o.hv - 0.45);
      camera.position.set(ex, plan.y + 1.75, ez);
      controls.target.set(2 * cx - ex, plan.y + 0.6, 2 * cz - ez);
    }
    hud.textContent = `building ${n} (${b.use}) floor ${fl.f} room ${room % rooms.length}: ${r.type}`;
  } else {
    const [cx, cz] = polyCentroid(poly), o = minAreaRect(poly);
    camera.position.set(cx + 1, plan.y + Math.max(o.hu, o.hv) * 2.2, cz + Math.max(o.hu, o.hv) * 0.8);
    controls.target.set(cx, plan.y, cz);
    hud.textContent = `building ${n} (${b.use}) floor ${fl.f}: ${plan.rooms.length} rooms, ${plan.furniture.length} pieces`;
  }
  controls.update();
}
show();
addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.code === 'Space') { n++; show(); }
  if (e.code === 'KeyR') { room++; show(); }
  if (e.code === 'KeyF') { floor++; show(); }
});
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });
if (q.get('still') === '1') { renderer.render(scene, camera); (window as unknown as { ready: boolean }).ready = true; }
else renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
