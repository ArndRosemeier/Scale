/**
 * Metro and sewers.
 *
 *  - Metro tunnels follow the planned lines at depth; stations are boxes with
 *    side platforms, tiled walls, columns, benches, lights and name signs.
 *    Street entrances (cut into the sidewalks by the cell planner) lead down
 *    inclined stair passages to the platform ends.
 *  - Trains run on analytic timetables (position = function of time), stop at
 *    stations and are drawn near the player.
 *  - Sewer trunks run under the arterials (arched brick, water channel with
 *    walkways), entered through manholes (E).
 *  - Geometry is built lazily near the player; volumes give collision.
 */
import * as THREE from 'three';
import type { MacroPlan, MetroLine } from '../plan/types';
import type { Terrain } from '../world/terrain';
import type { CellState } from '../stream/CityStreamer';
import { MeshBuilder } from '../build/meshBuilder';
import { facadeSpecs } from '../build/buildingShell';
import { createFacadeMaterial } from '../render/materials/facade';
import { createWaterMaterial } from '../render/materials/ground';
import type { TextureLibrary } from '../render/TextureLibrary';
import { toGeometry } from '../stream/CityStreamer';
import { makeTube, tubeAt, tubeInterior, boxAt, type Tube, type Box } from './Volumes';
import { ENTRANCE_L, ENTRANCE_W } from '../plan/metroDims';
import { pointInPoly } from '../core/geom2';
import { G } from '../render/materials/globals';
import { TUNNEL_HW, TUNNEL_H, PLATFORM_H, PLATFORM_EDGE, CAR_FLOOR, DOOR_U, DOOR_HW, DOOR_CLOSE, PASSAGE_HW, PASSAGE_H, CARS, CAR_L, CAR_W, CAR_H, metroTube, sewerTube, stationHalls, entranceRoute, routeEnv, trainsOn, nextTrainAt, carPose, DWELL, SEWER_HW, MANHOLE_EVERY, SHAFT_IN, SHAFT_HS, LID_LAT, LADDER_LAT, LADDER_HW, RUNG, SHAFT_VAULT, HOLE_R, COLLAR, shaftPoint, type ManholeSpot, type TrainState } from './layout';
import type { Obstacle } from '../world/Collision';
import { planRooms, type RoomPlan } from './rooms';
import { buildRoom, buildCrawl, buildChamber, colonyLayout, type BuiltRoom, type RoomMats, type EmitterId } from './RoomMeshes';
import { roomAtlas, decal, CELL } from './roomArt';
import { Slimes } from './Slimes';
import { SewerLife } from './SewerLife';
import type { Room } from './rooms';
import { planSewerHints } from './sewerHints';
import { planDeep, type DeepPlan } from './deep/plan';
import { DeepField } from './deep/field';
import { DeepMeshes } from './deep/DeepMeshes';

const BUILD_R = 380;
/** Side rooms and hidden chambers are built within these distances (m). */
const ROOM_R = 200, COLONY_R = 150;
/** Cell size (m) of the volume index. */
const GRID = 32;
const NONE: { tubes: Tube[]; boxes: Box[] } = { tubes: [], boxes: [] };

/** Sounds the underground plays (the game's audio engine). */
export interface UnderSound {
  play(id: string, x: number, y: number, z: number, gain?: number, pitch?: number, refDist?: number): void;
  loop(id: string, refDist?: number): { set(x: number, y: number, z: number, gain: number, rate?: number): void; stop(): void } | null;
}

export interface Entrance { x: number; z: number; ux: number; uz: number; station: number; /** hall * 2 + end */ end: number; passage: Tube | null; /** descent direction */ dx: number; dz: number; cell: number; /** index of the hall's box */ box: number }

export class Underground {
  readonly group = new THREE.Group();
  readonly tubes: Tube[] = [];
  readonly boxes: Box[] = [];
  readonly entrances = new Map<string, Entrance>();
  private built = new Map<string, THREE.Object3D>();
  /** Departure boards of the built station halls (one canvas per platform side, see updateBoards). */
  private boards: Board[] = [];
  private boardT = 0;
  private mat: THREE.MeshStandardMaterial;
  /** Murky sewer water: no sky reflection down here. */
  private waterMat = (() => { const m = createWaterMaterial(true); m.envMapIntensity = 0.04; m.roughness = 0.12; return m; })();
  private safetyMat = new THREE.MeshStandardMaterial({ color: 0xd9b21a, roughness: 0.6 });
  private lightMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff4e0, emissiveIntensity: 0.9 });
  private trainMesh: THREE.InstancedMesh;
  private glassMesh: THREE.InstancedMesh;
  /** While riding: the car's speed (m/s) and its change (m/s²), for the ride's camera and sound. */
  riding: { speed: number; accel: number; x: number; y: number; z: number } | null = null;
  private rideTime = 0;
  /** Train sounds near the listener (doors, arriving, departing, rushing past): set by the game. */
  onTrainSound: ((id: string, x: number, y: number, z: number, gain: number) => void) | null = null;
  private trainEv = new Map<string, { open: boolean; dwell: boolean; arriving: boolean; near: boolean }>();
  private flicker = 0;
  private trainColor: THREE.InstancedBufferAttribute;
  private headlamp = new THREE.SpotLight(0xfff2dd, 0, 30, 0.7, 0.8, 1.5);
  private stationLights: THREE.PointLight[] = [];
  private sewerTubes: Tube[] = [];
  private lastBuildPos = new THREE.Vector3(1e9, 0, 0);
  /** Hole rectangles (cx, cz, ux, uz, hw, hl) for the terrain shader / ground queries. */
  holes: number[] = [];
  openManholes: { x: number; z: number }[] = [];
  stationNames = new Map<number, string>();
  private time = 0;
  onEntrance?: (e: Entrance) => void;

  constructor(private macro: MacroPlan, private terrain: Terrain, tex: TextureLibrary, private ground: (x: number, z: number) => number) {
    this.mat = createFacadeMaterial(tex.facade, null, 1, false);
    this.group.add(this.headlamp, this.headlamp.target);
    for (let i = 0; i < 2; i++) {
      const l = new THREE.PointLight(0xfff4e8, 0, 45, 1.2);
      this.stationLights.push(l);
      this.group.add(l);
    }
    // Metro tunnels and stations.
    for (const line of macro.metroLines) this.tubes.push(metroTube(line));
    this.boxes.push(...stationHalls(macro));
    for (const st of macro.metroStations) this.stationNames.set(st.id, st.name);
    // Sewers under the arterials (not bridges).
    for (const sw of macro.sewers) {
      const t = sewerTube(sw.pts, terrain, sw.culvert);
      this.tubes.push(t);
      this.sewerTubes.push(t);
    }
    // Side rooms off the tunnels and the hidden chambers (volumes now, meshes when near).
    this.rooms = planRooms(macro, terrain, this.tubes, this.boxes);
    for (const r of this.rooms.rooms) {
      this.boxes.push(...r.boxes);
      const t = this.tubes[r.tube];
      let l = this.roomCuts.get(t);
      if (!l) this.roomCuts.set(t, (l = []));
      for (const c of r.cuts) l.push({ ...c, side: r.side });
    }
    for (const c of this.rooms.colonies) { this.boxes.push(c.chamber); this.tubes.push(c.crawl); }
    this.planManholes();
    for (const t of this.tubes) this.indexTube(t);
    for (const b of this.boxes) this.indexBox(b);
    // The deep realm below the colonies (its own field; meshes streamed by its worker).
    try {
      const halls = this.boxes.filter((b) => b.kind === 'station');
      const plan = planDeep({
        seed: macro.seed, colonies: this.rooms.colonies, ground: (x, z) => terrain.height(x, z),
        blocked: (x, y, z) => this.occupied(x, y, z, 1.0) || halls.some((h) => Math.hypot(h.cx - x, h.cz - z) < h.hu + 80 && y > h.y0 - 4),
      });
      if (plan) {
        const field = new DeepField(plan.prims, plan.seed);
        const skip = plan.roads.map((r) => this.rooms.colonies[r.colony].chamber).map((b) => ({ cx: b.cx, cz: b.cz, y0: b.y0, y1: b.y1, ux: b.ux, uz: b.uz, hu: b.hu, hv: b.hv }));
        this.deep = { plan, field, meshes: new DeepMeshes(plan, skip) };
        this.group.add(this.deep.meshes.group);
      }
    } catch (err) { console.warn('[deep]', err); }
    const atlas = roomAtlas();
    this.mats = {
      lit: this.mat,
      light: this.lightMat,
      glow: new THREE.MeshBasicMaterial({ map: atlas, vertexColors: true, alphaTest: 0.4, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      decal: new THREE.MeshStandardMaterial({ map: atlas, transparent: true, depthWrite: false, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      water: this.waterMat,
      veil: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
    };
    this.group.add(this.slimes.group);
    const snd = () => this.sound ? { play: (id: string, x: number, y: number, z: number, g: number) => this.sound!.play(id, x, y, z, g, 0.9 + Math.random() * 0.25, 3) } : null;
    this.life = new SewerLife({
      sewers: this.sewerTubes,
      roomsNear: (x, z, r) => {
        const out: Room[] = [];
        for (const k of this.builtRooms.keys()) {
          if (k[0] !== 'r') continue;
          const room = this.rooms.rooms[+k.slice(1)];
          if (room && Math.hypot(room.ox - x, room.oz - z) < r) out.push(room);
        }
        return out;
      },
      floorAt: (x, y, z) => this.floorAt(x, y, z),
      get sound() { return snd(); },
    }, this.slimes);
    this.group.add(this.life.group);
    // The Lumen's signs in the sewers: the way to the colonies (one mesh for the whole network).
    try {
      const hints = planSewerHints(macro, this.tubes, this.rooms);
      if (hints.length) {
        const mb = new MeshBuilder([{ name: 'uv', size: 2 }, { name: 'color', size: 3, type: 'u8n' }]);
        /** A glowing stroke on the floor: centre, direction (unit), half length, half width. */
        const stroke = (x: number, y: number, z: number, ax: number, az: number, hl: number, hwid: number) => decal(mb, x, y + 0.016, z, ax, 0, az, az, 0, -ax, hl, hwid, CELL.dot);
        /** A V pointing along (dx, dz) with its tip at (x, z). */
        const vee = (x: number, y: number, z: number, dx: number, dz: number, size: number) => {
          for (const a of [0.62, -0.62]) {
            const c = Math.cos(a), sn = Math.sin(a);
            // The arm runs back from the tip, turned by ±a.
            const bx = -(dx * c - dz * sn), bz = -(dx * sn + dz * c);
            stroke(x + bx * size * 0.5, y, z + bz * size * 0.5, bx, bz, size * 0.55, size * 0.11);
          }
        };
        let scouts = 0;
        for (const h of hints) {
          if (h.kind === 'mark') {
            mb.set('color', 0.2 * h.s, 0.85 * h.s, 0.7 * h.s);
            decal(mb, h.x + h.nx * 0.012, h.y, h.z + h.nz * 0.012, h.nz, 0, -h.nx, 0, 1, 0, 0.42, 0.42, CELL.mark + h.sign);
          } else if (h.kind === 'arrow') {
            // Three chevrons and a smear on the junction floor, into the branch.
            mb.set('color', 0.18 * h.s, 0.75 * h.s, 0.62 * h.s);
            for (let k = 0; k < 3; k++) vee(h.x + h.nx * (0.6 + k * 0.55), h.y, h.z + h.nz * (0.6 + k * 0.55), h.nx, h.nz, 0.55);
            stroke(h.x - h.nx * 0.4, h.y, h.z - h.nz * 0.4, h.nx, h.nz, 0.7, 0.16);
          } else if (h.kind === 'chevron') {
            mb.set('color', 0.15 * h.s, 0.62 * h.s, 0.52 * h.s);
            vee(h.x, h.y, h.z, h.nx, h.nz, 0.36);
          } else if (h.kind === 'scout') {
            // A lone Lumen waiting at the junction: it slips off down the right branch when someone comes.
            this.slimes.setScout(`sewer${scouts++}`, { x: h.x, y: h.y, z: h.z, hx: h.x + h.nx * 9, hz: h.z + h.nz * 9 }, (h.x * 13.7 + h.z * 7.1) | 0, true);
          }
        }
        const m = new THREE.Mesh(toGeometry(mb.build()), this.mats.glow);
        m.name = 'sewer-hints';
        this.group.add(m);
        this.hintCount = hints.length;
      }
    } catch (err) { console.warn('[sewer hints]', err); }
    // Stand-ins so the start-up warm-up compiles the room materials (a degenerate triangle each).
    for (const m of [this.mats.glow, this.mats.decal, this.mats.veil]) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1e4, 0, 0, -1e4, 0, 0, -1e4, 0], 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
      const w = new THREE.Mesh(g, m);
      w.frustumCulled = false;
      this.group.add(w);
    }
    // Trains: one instanced mesh of carriages.
    const carGeo = trainCarGeometry();
    this.trainColor = new THREE.InstancedBufferAttribute(new Float32Array(400 * 3), 3);
    carGeo.setAttribute('iLine', this.trainColor);
    // Double-sided: riders see the car's walls from inside.
    const trainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.5, side: THREE.DoubleSide });
    trainMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 iLine;\nattribute float aStripe;')
        .replace('#include <color_vertex>', '#include <color_vertex>\nvColor.rgb = mix(vColor.rgb, iLine, aStripe);');
    };
    this.trainMesh = new THREE.InstancedMesh(carGeo, trainMat, 400);
    // Window glass: tinted, see-through (the tunnel lights stream past; lit cars are seen from outside).
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x8aa2b0, roughness: 0.08, metalness: 0.3, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
    this.glassMesh = new THREE.InstancedMesh(trainGlassGeometry(), glassMat, 400);
    this.glassMesh.count = 0;
    this.glassMesh.frustumCulled = false;
    this.glassMesh.renderOrder = 2;
    this.group.add(this.glassMesh);
    this.trainMesh.count = 0;
    this.trainMesh.frustumCulled = false;
    this.trainMesh.castShadow = false;
    this.group.add(this.trainMesh);
    this.leafMesh = new THREE.InstancedMesh(doorLeafGeometry(), new THREE.MeshStandardMaterial({ color: 0x8d9094, roughness: 0.4, metalness: 0.5, side: THREE.DoubleSide }), 800);
    this.leafMesh.count = 0;
    this.leafMesh.frustumCulled = false;
    this.group.add(this.leafMesh);
  }
  private leafMesh: THREE.InstancedMesh;
  /** Side rooms and colonies (rooms.ts), the doorways they cut into their host tubes. */
  readonly rooms: RoomPlan;
  private roomCuts = new Map<Tube, { s0: number; s1: number; top: number; side: number }[]>();
  private mats: RoomMats;
  private builtRooms = new Map<string, BuiltRoom>();
  readonly slimes = new Slimes();
  /** Rats and the odd wandering slime around the player in the sewers. */
  readonly life: SewerLife;
  /**
   * The look of a hideout from the game: the group holding the street above (its accent colour and
   * a material for its tag), or null for nobody's.
   */
  hideoutLook: ((x: number, z: number, seed: number) => { accent: [number, number, number]; tag: THREE.Material } | null) | null = null;
  /** Lumen signs and trails laid in the sewers (sewerHints.ts). */
  hintCount = 0;
  /** The deep realm (deep/plan.ts): its plan, its rock as a field, its meshes; null when the city has none. */
  deep: { plan: DeepPlan; field: DeepField; meshes: DeepMeshes } | null = null;
  /** What the deep realm's look follows (set by the game's slime civilisation): the lift running, the kin mosaic. */
  readonly deepState = { murk: 0, lift: false, kin: false };
  /** The game's audio (set by the game): drips, hums, the slimes. */
  sound: UnderSound | null = null;
  private loops = new Map<EmitterId, ReturnType<UnderSound['loop']>>();
  private dripT = 0;

  /** Register metro entrances of a loaded cell (from its plan). */
  addCell(cs: CellState): void {
    this.placeManholes(cs.id);
    const E = cs.plan?.entrances;
    if (!E) return;
    for (let i = 0; i < E.length; i += 6) {
      const key = `${E[i + 4]}:${E[i + 5]}`;
      if (this.entrances.has(key)) continue;
      const sid = E[i + 4], bi = this.hallBox(sid, E[i + 5] >> 1);
      if (bi < 0) continue;
      const gx = E[i], gz = E[i + 1];
      const ux = E[i + 2], uz = E[i + 3];
      const route = entranceRoute(this.boxes[bi], gx, gz, ux, uz, this.ground, routeEnv(this.tubes, this.boxes, this.boxes[bi]));
      const passage = makeTube('passage', route.pts, PASSAGE_HW, PASSAGE_H);
      this.tubes.push(passage);
      this.indexTube(passage);
      this.entrances.set(key, { x: gx, z: gz, ux, uz, station: sid, end: E[i + 5], passage, dx: route.dx, dz: route.dz, cell: cs.id, box: bi });
      let D = this.doors.get(bi);
      if (!D) this.doors.set(bi, (D = []));
      D.push(route.door);
      // The station hall gets a doorway in its side wall: rebuild it if already built.
      const built = this.built.get(`b${bi}`);
      if (built) {
        this.group.remove(built);
        built.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
        this.built.delete(`b${bi}`);
      }
      this.lastBuildPos.set(1e9, 0, 0);
      this.onEntrance?.(this.entrances.get(key)!);
      this.holes.push(gx, gz, ux, uz, ENTRANCE_W / 2, ENTRANCE_L / 2);
    }
  }

  /** Box index of a station's hall (hall index within the station), or -1. */
  hallBox(station: number, hall: number): number {
    return this.boxes.findIndex((b) => b.station === station && b.hall === hall);
  }

  /** Doorways in the station halls' side walls (box index → box frame u, side ±1) where entrance passages arrive. */
  private doors = new Map<number, { u: number; sv: number }[]>();

  // ------------------------------------------------------------ queries

  /** Underground floor at a point if the point is inside an underground volume, else null. */
  floorAt(x: number, y: number, z: number): number | null {
    let best: number | null = null;
    const n = this.near(x, z);
    for (const t of n.tubes) {
      if (t.kind === 'sewer' && !this.sewerOpen(t, x, z, y)) continue;
      const h = tubeAt(t, x, y, z);
      if (h && h.floor <= y + 0.6 && (best === null || h.floor > best)) best = h.floor;
    }
    for (const b of n.boxes) {
      const h = boxAt(b, x, y, z);
      if (h && h.floor <= y + 0.6 && (best === null || h.floor > best)) best = h.floor;
    }
    // The deep realm's caves.
    const F = this.deep?.field;
    if (F && F.near(x, y, z)) {
      const f = F.floorAt(x, y + 0.6, z) ?? F.floorAt(x, y, z);
      if (f !== null && (best === null || f > best)) best = f;
    }
    // Car floors (level with the platforms).
    for (const c of this.cars) {
      if (Math.abs(c.x - x) > 10 || Math.abs(c.z - z) > 10) continue;
      const L = this.carLocal(c, x, y, z), f = c.y + CAR_FLOOR;
      if (Math.abs(L.u) < CAR_L / 2 && Math.abs(L.v) < CAR_W / 2 && f <= y + 0.6 && f > y - 1.5 && (best === null || f > best)) best = f;
    }
    return best;
  }

  /** Sewers are reachable only once someone is inside (they have no street openings except manholes). */
  private sewerOpen(_t: Tube, _x: number, _z: number, y: number): boolean {
    return y < this.ground(_x, _z) - 1.0;
  }

  /** Is (x,z) inside a hole in the street (metro entrance opening or open manhole)? */
  inHole(x: number, z: number): boolean {
    const H = this.holes;
    for (let i = 0; i < H.length; i += 6) {
      const dx = x - H[i], dz = z - H[i + 1];
      // (A negative half length: a round hole of radius H[i + 4].)
      if (H[i + 5] < 0) { if (dx * dx + dz * dz < H[i + 4] * H[i + 4]) return true; continue; }
      const u = dx * H[i + 2] + dz * H[i + 3], v = -dx * H[i + 3] + dz * H[i + 2];
      if (Math.abs(u) < H[i + 5] && Math.abs(v) < H[i + 4]) return true;
    }
    for (const m of this.openManholes) if (Math.hypot(x - m.x, z - m.z) < 0.4) return true;
    return false;
  }

  /** Lowest ceiling of the volumes containing (x, y, z) (Infinity: none) - jumps stop there. */
  ceilingAt(x: number, y: number, z: number): number {
    let c = Infinity;
    const n = this.near(x, z);
    for (const t of n.tubes) { const h = tubeAt(t, x, y, z); if (h) c = Math.min(c, h.floor + t.height); }
    for (const b of n.boxes) if (boxAt(b, x, y, z)) c = Math.min(c, b.y1);
    const F = this.deep?.field;
    if (F && F.near(x, y, z) && F.air(x, y, z)) c = Math.min(c, F.ceilingAt(x, y, z));
    return c;
  }

  /** Inside any volume (with margin)? Used to keep bodies inside tunnels. */
  contains(x: number, y: number, z: number, margin: number): boolean {
    const n = this.near(x, z);
    for (const t of n.tubes) if (tubeAt(t, x, y, z, -margin)) return true;
    for (const b of n.boxes) if (boxAt(b, x, y, z, -margin)) return true;
    const F = this.deep?.field;
    return !!F && F.near(x, y, z) && F.contains(x, y, z, margin);
  }

  /** Is a point inside a tunnel, room, chamber or cave (margin m inside its walls)? (Planning the deep realm.) */
  private occupied(x: number, y: number, z: number, margin: number): boolean {
    const n = this.near(x, z);
    for (const t of n.tubes) { const h = tubeAt(t, x, y, z, margin); if (h && y > h.floor - 1 - margin && y < h.floor + t.height + margin) return true; }
    for (const b of n.boxes) if (boxAt(b, x, y, z, margin) && y > b.y0 - 1 - margin && y < b.y1 + margin) return true;
    return false;
  }

  /** Line of sight underground: through the caves' air (null: not in the caves, ask someone else). */
  caveLine(ax: number, ay: number, az: number, bx: number, by: number, bz: number, pad = 0): boolean | null {
    const F = this.deep?.field;
    if (!F || !F.near(ax, ay, az) || !F.near(bx, by, bz)) return null;
    if (!F.air(ax, ay, az) && !F.air(bx, by, bz)) return null;
    return F.lineClear(ax, ay, az, bx, by, bz, pad);
  }

  /** First cave rock along a ray from a point in the caves (Infinity: none within maxT; null: not in the caves). */
  caveRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number | null {
    const F = this.deep?.field;
    if (!F || !F.near(ox, oy, oz) || !F.air(ox, oy, oz)) return null;
    return F.ray(ox, oy, oz, dx, dy, dz, maxT);
  }

  /** Strict interior test for the camera boom (vaults, vertical margins). */
  cameraFree(x: number, y: number, z: number, margin: number): boolean {
    // Riding: the camera stays inside the car.
    const inCar = this.inRiddenCar(x, y, z, margin);
    if (inCar !== null) return inCar;
    const n = this.near(x, z);
    for (const t of n.tubes) {
      if (!tubeInterior(t, x, y, z, margin)) continue;
      // Passage ceilings stay under the street (see buildTubeChunk), except in the opening.
      if (t.kind !== 'passage' || y < this.ground(x, z) - 0.15 - margin || this.inHole(x, z)) return true;
    }
    for (const b of n.boxes) if (boxAt(b, x, y, z, -margin) && y > b.y0 + margin && y < b.y1 - margin) return true;
    const F = this.deep?.field;
    return !!F && F.near(x, y, z) && F.sdf(x, y, z) < -margin;
  }

  /** Spatial index of the volumes (cells of GRID m): tubes by their segments, boxes by their bounds. */
  private grid = new Map<number, { tubes: Tube[]; boxes: Box[] }>();
  private cellOf(i: number, j: number): { tubes: Tube[]; boxes: Box[] } {
    const k = (i + 32768) * 65536 + (j + 32768);
    let c = this.grid.get(k);
    if (!c) this.grid.set(k, (c = { tubes: [], boxes: [] }));
    return c;
  }
  private indexTube(t: Tube): void {
    const P = t.pts, r = t.halfWidth + 2;
    for (let i = 0; i + 5 < P.length; i += 3) {
      for (let a = Math.floor((Math.min(P[i], P[i + 3]) - r) / GRID); a <= Math.floor((Math.max(P[i], P[i + 3]) + r) / GRID); a++)
        for (let b = Math.floor((Math.min(P[i + 2], P[i + 5]) - r) / GRID); b <= Math.floor((Math.max(P[i + 2], P[i + 5]) + r) / GRID); b++) {
          const c = this.cellOf(a, b);
          if (c.tubes[c.tubes.length - 1] !== t && !c.tubes.includes(t)) c.tubes.push(t);
        }
    }
  }
  private indexBox(b: Box): void {
    const [x0, z0, x1, z1] = b.bounds;
    for (let a = Math.floor(x0 / GRID); a <= Math.floor(x1 / GRID); a++) for (let c = Math.floor(z0 / GRID); c <= Math.floor(z1 / GRID); c++) this.cellOf(a, c).boxes.push(b);
  }
  /** Volumes that may contain a point at (x, z). */
  private near(x: number, z: number): { tubes: Tube[]; boxes: Box[] } {
    return this.grid.get((Math.floor(x / GRID) + 32768) * 65536 + (Math.floor(z / GRID) + 32768)) ?? NONE;
  }

  /** Inside a sewer tube (not the metro): where a manhole above can be climbed. */
  inSewer(x: number, y: number, z: number): boolean {
    return this.near(x, z).tubes.some((t) => t.kind === 'sewer' && !!tubeAt(t, x, y, z));
  }

  isUnder(x: number, y: number, z: number): boolean {
    return y < this.ground(x, z) - 1.2 && this.floorAt(x, y, z) !== null;
  }

  /** Manhole lids above the sewers (placed per loaded cell, every ~45 m along each trunk). */
  private manholes = new Map<number, ManholeSpot[]>();
  /** Lids per cell (generated once; re-announced whenever the cell's props are rebuilt). */
  private manholeCells = new Map<number, { x: number; z: number; yaw: number }[]>();
  /** Every manhole of the city, per trunk (planned once, see planManholes). */
  private shafts = new Map<Tube, ManholeSpot[]>();
  private allShafts: ManholeSpot[] = [];
  /** A manhole lid was placed (the game adds the visible lid prop). */
  onManhole?: (cell: number, x: number, z: number, yaw: number) => void;

  /**
   * Every MANHOLE_EVERY m along each trunk a shaft on one side (deterministic, the side flips
   * where a side room's doorway or a crossing trunk is in the way), not in the river over a
   * culvert, none within 10 m of another (crossing trunks).
   */
  private planManholes(): void {
    this.sewerTubes.forEach((t, ti) => {
      const total = t.cum[t.cum.length - 1];
      const cuts = this.roomCuts.get(t) ?? [];
      const list: ManholeSpot[] = [];
      for (let s = MANHOLE_EVERY * 0.5, k = 0; s < total; s += MANHOLE_EVERY, k++) {
        const q = pointOnTube(t, s);
        if (!q) continue;
        const first = hash01(ti * 977 + k * 31 + 7) < 0.5 ? 1 : -1;
        let spot: ManholeSpot | null = null;
        for (const side of [first, -first]) {
          if (cuts.some((c) => c.side === side && s > c.s0 - SHAFT_HS - 0.8 && s < c.s1 + SHAFT_HS + 0.8)) continue;
          const x = q.x - q.dz * LID_LAT * side, z = q.z + q.dx * LID_LAT * side;
          if (this.terrain.isWater(x, z, 3)) break;
          // A crossing trunk (a junction) under the shaft or the ladder.
          if (this.sewerTubes.some((o) => o !== t && !!tubeAt(o, x, q.y + 1, z, 1.2))) continue;
          if (this.allShafts.some((m) => Math.hypot(m.x - x, m.z - z) < 10)) break;
          spot = { tube: t, s, x, z, dx: q.dx, dz: q.dz, side, floor: q.y };
          break;
        }
        if (!spot) continue;
        list.push(spot);
        this.allShafts.push(spot);
      }
      this.shafts.set(t, list);
    });
  }

  private placeManholes(cellId: number): void {
    let lids = this.manholeCells.get(cellId);
    if (!lids) this.manholeCells.set(cellId, (lids = this.generateManholes(cellId)));
    for (const m of lids) {
      // An opened manhole keeps its hole and has no lid.
      if (this.openManholes.some((o) => Math.hypot(o.x - m.x, o.z - m.z) < 0.5)) continue;
      this.onManhole?.(cellId, m.x, m.z, m.yaw);
    }
  }

  private generateManholes(cellId: number): { x: number; z: number; yaw: number }[] {
    const out: { x: number; z: number; yaw: number }[] = [];
    const poly = this.macro.cells[cellId]?.poly;
    if (!poly) return out;
    for (const m of this.allShafts) {
      if (!pointInPoly(poly, m.x, m.z)) continue;
      const key = Math.floor(m.x / 32) * 65536 + Math.floor(m.z / 32);
      let l = this.manholes.get(key);
      if (!l) this.manholes.set(key, (l = []));
      if (!l.includes(m)) l.push(m);
      out.push({ x: m.x, z: m.z, yaw: Math.atan2(m.dx, m.dz) });
    }
    return out;
  }

  /** Street height (what the terrain holes and lids sit on). */
  groundAt(x: number, z: number): number { return this.ground(x, z); }

  /** Is this manhole open (lid off)? */
  isOpen(m: { x: number; z: number }): boolean {
    return this.openManholes.some((o) => Math.hypot(o.x - m.x, o.z - m.z) < 0.5);
  }

  /** Take the lid off for good: a round hole in the street, the shaft's cap gone. */
  openManhole(m: ManholeSpot): void {
    if (this.isOpen(m)) return;
    this.openManholes.push({ x: m.x, z: m.z });
    this.holes.push(m.x, m.z, 1, 0, HOLE_R, -1);
    // The chunk drawing the shaft is rebuilt without its cap.
    const ti = this.tubes.indexOf(m.tube);
    let seg = 0;
    while (seg < m.tube.cum.length - 2 && m.tube.cum[seg + 1] <= m.s) seg++;
    const key = `t${ti}:${Math.floor(seg / 8) * 8}`;
    const o = this.built.get(key);
    if (o) {
      this.group.remove(o);
      o.traverse((c) => { const mm = c as THREE.Mesh; if (mm.isMesh) mm.geometry.dispose(); });
      this.built.delete(key);
    }
    this.lastBuildPos.set(1e9, 0, 0);
  }

  /** Every placed manhole lid (cells loaded so far), e.g. for the map. */
  forEachManhole(fn: (x: number, z: number) => void): void {
    for (const l of this.manholes.values()) for (const m of l) fn(m.x, m.z);
  }

  /** Nearest manhole lid within r (for E and hints). */
  nearestManhole(x: number, z: number, r: number): ManholeSpot | null {
    let best: ManholeSpot | null = null, bd = r;
    const i0 = Math.floor((x - r) / 32), i1 = Math.floor((x + r) / 32), j0 = Math.floor((z - r) / 32), j1 = Math.floor((z + r) / 32);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      for (const m of this.manholes.get(i * 65536 + j) ?? []) {
        const d = Math.hypot(m.x - x, m.z - z);
        if (d < bd) { bd = d; best = m; }
      }
    }
    return best;
  }

  // ------------------------------------------------------------ update

  update(dt: number, time: number, cam: THREE.Camera, player: THREE.Vector3, playerH: number): void {
    // Build geometry near the player (and the camera).
    if (cam.position.distanceTo(this.lastBuildPos) > 40) {
      this.lastBuildPos.copy(cam.position);
      this.buildNear(cam.position.x, cam.position.z);
    }
    const under = this.isUnder(player.x, player.y + 0.5, player.z);
    // Headlamp underground (sewers are dark).
    const inStation = under && this.boxes.some((b) => b.kind === 'station' && boxAt(b, player.x, player.y + 0.5, player.z, 2));
    // Side rooms: animation, sounds; the slimes.
    const day = 1 - G.uNight.value;
    for (const br of this.builtRooms.values()) br.tick?.(time, day);
    this.roomSounds(dt, cam.position, under);
    const snd = this.sound;
    if (snd && !this.slimes.sound) this.slimes.sound = { play: (id, x, y, z, g) => snd.play(id, x, y, z, g, 1, 3), loop: (id) => snd.loop(id, 3) };
    this.life.update(dt, player, under && this.inSewerArea(player.x, player.y + 0.5, player.z));
    this.slimes.update(dt, player, under);
    this.shaftMat.color.setScalar(0.5 * G.uDayLight.value);
    this.lidGlowMat.color.copy(this.shaftMat.color);
    if (this.deep) {
      const c = cam.position, D = this.deep.plan;
      const camUnder = under || this.isUnder(c.x, c.y, c.z);
      this.deepState.murk = Math.max(0, Math.min(1, ((D.yGlow + D.yDeep) / 2 + 6 - c.y) / 12));
      this.deep.meshes.update(dt, c, camUnder, this.deepState);
    }
    if (under && !inStation) {
      this.headlamp.intensity = 3;
      this.headlamp.position.copy(cam.position);
      const d = new THREE.Vector3();
      cam.getWorldDirection(d);
      this.headlamp.target.position.copy(cam.position).addScaledVector(d, 10);
    } else this.headlamp.intensity = 0;
    // Station pool lights: the nearest station within reach gets both.
    let near: Box | null = null, nd = 160;
    for (const b of this.boxes) {
      if (b.kind !== 'station') continue;
      const d = Math.hypot(b.cx - cam.position.x, b.cz - cam.position.z);
      if (d < nd) { nd = d; near = b; }
    }
    this.stationLights.forEach((l, i) => {
      if (!near) { l.intensity = 0; return; }
      const u = (i === 0 ? -0.5 : 0.5) * near.hu;
      l.position.set(near.cx + near.ux * u, near.y1 - 1, near.cz + near.uz * u);
      l.intensity = 6;
    });
    this.time = time;
    this.updateTrains(time, cam.position);
    this.boardT -= dt;
    if (this.boardT <= 0) { this.boardT = 0.5; this.updateBoards(cam.position); }
    void playerH; void G;
  }

  private buildNear(x: number, z: number): void {
    const want = new Set<string>();
    // Tube segments (chunks of ~60 m).
    this.tubes.forEach((t, ti) => {
      if (t.kind === 'crawl') return;
      if (t.bounds[0] > x + BUILD_R || t.bounds[2] < x - BUILD_R || t.bounds[1] > z + BUILD_R || t.bounds[3] < z - BUILD_R) return;
      const P = t.pts;
      const n = P.length / 3;
      const chunk = t.kind === 'passage' ? n : 8;
      for (let i = 0; i < n - 1; i += chunk) {
        const j = Math.min(n - 1, i + chunk);
        const mx = (P[i * 3] + P[j * 3]) / 2, mz = (P[i * 3 + 2] + P[j * 3 + 2]) / 2;
        if (Math.hypot(mx - x, mz - z) > BUILD_R) continue;
        const key = `t${ti}:${i}`;
        want.add(key);
        if (!this.built.has(key)) this.built.set(key, this.buildTubeChunk(t, i, j));
      }
    });
    this.boxes.forEach((b, bi) => {
      if (b.kind !== 'station' || Math.hypot(b.cx - x, b.cz - z) > BUILD_R + 60) return;
      const key = `b${bi}`;
      want.add(key);
      if (!this.built.has(key)) this.built.set(key, this.buildStation(b, bi));
    });
    // Side rooms (a lone one may sit in a room with a trail), crawls and chambers.
    for (const r of this.rooms.rooms) {
      if (Math.abs(r.ox - x) > ROOM_R || Math.abs(r.oz - z) > ROOM_R || Math.hypot(r.ox - x, r.oz - z) > ROOM_R) continue;
      const key = `r${r.id}`;
      want.add(key);
      if (this.built.has(key)) continue;
      const [lx, lz] = [r.ox + r.nx * 3, r.oz + r.nz * 3];
      const look = r.kind === 'hideout' ? this.hideoutLook?.(lx, lz, r.seed) ?? null : null;
      const br = buildRoom(r, this.mats, look ? { accent: look.accent } : {});
      if (look) for (const t of br.tags) {
        const tag = new THREE.Mesh(new THREE.PlaneGeometry(1.45, 0.9), look.tag);
        tag.position.set(t.x + t.nx * 0.03, t.y, t.z + t.nz * 0.03);
        tag.rotation.y = Math.atan2(t.nx, t.nz);
        tag.renderOrder = 2;
        br.obj.add(tag);
      }
      this.builtRooms.set(key, br);
      this.built.set(key, br.obj);
      if (br.scout) this.slimes.setScout(key, br.scout, r.seed);
    }
    for (const c of this.rooms.colonies) {
      if (Math.hypot(c.chamber.cx - x, c.chamber.cz - z) > COLONY_R) continue;
      const key = `c${c.id}`;
      want.add(key);
      if (this.built.has(key)) continue;
      const L = colonyLayout(c);
      const road = this.deep?.plan.roads.find((r) => r.colony === c.id) ?? null;
      const br = buildChamber(c, L, this.mats, road?.hole ?? null);
      br.obj.add(buildCrawl(c, this.mats));
      this.builtRooms.set(key, br);
      this.built.set(key, br.obj);
      this.slimes.setColony(c, L);
    }
    for (const [k, o] of this.built) {
      if (want.has(k)) { if (!o.parent) this.group.add(o); continue; }
      this.group.remove(o);
      o.traverse((c) => {
        const m = c as THREE.Mesh;
        if (!m.isMesh || m === this.trainMesh) return;
        m.geometry.dispose();
        if ((m.material as THREE.Material).userData?.own) (m.material as THREE.Material).dispose();
      });
      this.built.delete(k);
      if (this.builtRooms.delete(k)) this.slimes.setScout(k, null, 0);
    }
  }

  /** Room sounds near the listener: drips now and then, the hum / fan / falling water as loops. */
  private roomSounds(dt: number, cam: THREE.Vector3, under: boolean): void {
    const snd = this.sound;
    if (!snd) return;
    const best = new Map<EmitterId, { d: number; x: number; y: number; z: number }>();
    const drips: { x: number; y: number; z: number }[] = [];
    if (under) for (const br of this.builtRooms.values()) for (const e of br.emitters) {
      const d = Math.hypot(e.x - cam.x, e.y - cam.y, e.z - cam.z);
      if (d > 35) continue;
      if (e.id === 'under_drip') { drips.push(e); continue; }
      const b = best.get(e.id);
      if (!b || d < b.d) best.set(e.id, { d, x: e.x, y: e.y, z: e.z });
    }
    for (const id of ['under_falls', 'under_hum', 'under_fan', 'under_engine', 'under_gears', 'under_fire'] as EmitterId[]) {
      const b = best.get(id);
      let l = this.loops.get(id);
      if (!l && b) { l = snd.loop(id, 3); if (l) this.loops.set(id, l); }
      if (l) { if (b) l.set(b.x, b.y, b.z, 1); else l.set(cam.x, cam.y, cam.z, 0); }
    }
    this.dripT -= dt;
    if (drips.length && this.dripT <= 0) {
      this.dripT = 0.6 + Math.random() * 2.2;
      const e = drips[(Math.random() * drips.length) | 0];
      snd.play('under_drip', e.x + (Math.random() - 0.5) * 2, e.y, e.z + (Math.random() - 0.5) * 2, 0.6 + Math.random() * 0.4, 0.85 + Math.random() * 0.3, 2);
    }
  }

  /** Something violent happened (a punch, a power, a blast): the slimes near it react. */
  onStimulus(kind: string, x: number, y: number, z: number, radius: number): void {
    this.slimes.stimulus(kind, x, y, z, radius);
    this.life.stimulus(kind, x, y, z, radius);
  }

  /** In a sewer trunk or a sewer side room? (Where the rats are.) */
  inSewerArea(x: number, y: number, z: number): boolean {
    if (this.inSewer(x, y, z)) return true;
    for (const b of this.near(x, z).boxes) if (b.room !== undefined && this.rooms.rooms[b.room]?.net === 'sewer' && boxAt(b, x, y, z)) return true;
    return false;
  }

  /** Extruded cross-section along a tube chunk; faces point inward. */
  private buildTubeChunk(t: Tube, i0: number, i1: number): THREE.Object3D {
    const g = new THREE.Group();
    const mb = new MeshBuilder(facadeSpecs());
    const P = t.pts;
    const sewer = t.kind === 'sewer';
    const passage = t.kind === 'passage';
    // Cross-section profile (lateral offset, height) — counter-clockwise when looking along the tube.
    const hw = t.halfWidth, h = t.height;
    const profile: [number, number][] = sewer
      ? [[-hw, 0.0], [-0.6, 0.0], [-0.6, -0.45], [0.6, -0.45], [0.6, 0], [hw, 0], [hw, GRIME], [hw, 1.6], ...arch(hw, 1.6, h, 8), [-hw, GRIME]]
      : [[-hw, 0], [hw, 0], [hw, h], [-hw, h]];
    const layer = sewer ? 1 : passage ? 15 : 8;
    // Crossing sewers near this chunk (junctions).
    let others: { o: Tube; idx: number }[] = [];
    const myIdx = this.sewerTubes.indexOf(t);
    const sty = sewer ? sewerStyle(myIdx, !!this.macro.sewers[myIdx]?.culvert) : null;
    if (sewer) {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let i = i0; i <= i1; i++) { x0 = Math.min(x0, P[i * 3]); x1 = Math.max(x1, P[i * 3]); z0 = Math.min(z0, P[i * 3 + 2]); z1 = Math.max(z1, P[i * 3 + 2]); }
      this.sewerTubes.forEach((o, idx) => {
        if (o !== t && o.bounds[0] < x1 + hw && o.bounds[2] > x0 - hw && o.bounds[1] < z1 + hw && o.bounds[3] > z0 - hw) others.push({ o, idx });
      });
    }
    mb.set('aLayer', sty ? sty.layer : layer).set('aTint', ...(sty ? sty.tint : passage ? [0.95, 0.95, 0.95] as const : [0.8, 0.8, 0.78] as const)).set('aFacade', 1, 1, 1, 0).set('aSeed', 0.3).set('aElem', 0);
    // Texture v runs along the perimeter of the section so the vault never smears.
    const perim = [0];
    for (let k = 0; k < profile.length; k++) {
      const [l0, h0] = profile[k], [l1, h1] = profile[(k + 1) % profile.length];
      perim.push(perim[k] + Math.hypot(l1 - l0, h1 - h0));
    }
    const cuts = this.roomCuts.get(t) ?? [];
    // Manhole shafts in this chunk's reach: the vault is open over them.
    const shafts = sewer ? (this.shafts.get(t) ?? []).filter((m) => m.s > t.cum[i0] - SHAFT_HS && m.s < t.cum[i1] + SHAFT_HS) : [];
    const halls = this.boxes.filter((bb) => bb.kind === 'station');
    /** Exit signs: x, y, z, facing (fx, fz) each. */
    const signs: number[] = [];
    for (let i = i0; i < i1; i++) {
      const ax = P[i * 3], ay = P[i * 3 + 1], az = P[i * 3 + 2], bx = P[i * 3 + 3], by = P[i * 3 + 4], bz = P[i * 3 + 5];
      const d0 = dirAt(P, i), d1 = dirAt(P, i + 1);
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      const segCuts = cuts.filter((c) => c.s1 > t.cum[i] && c.s0 < t.cum[i + 1]);
      const inStation = !sewer && halls.some((bb) => boxAt(bb, mx, (ay + by) / 2 + 0.5, mz, -0.05));
      // Through a hall the station draws walls, track bed and rails itself.
      if (inStation && !passage) continue;
      const open = passage && this.inHole(mx, mz);
      for (let k = 0; k < profile.length; k++) {
        const [l0, h0] = profile[k], [l1, h1] = profile[(k + 1) % profile.length];
        if (!sewer && k === 0 && !passage) continue; // tunnel floor is the track bed (drawn below)
        const A = [ax - d0[1] * l0, ay + h0, az + d0[0] * l0], B = [ax - d0[1] * l1, ay + h1, az + d0[0] * l1];
        const C = [bx - d1[1] * l1, by + h1, bz + d1[0] * l1], D = [bx - d1[1] * l0, by + h0, bz + d1[0] * l0];
        if (passage) {
          // In the street opening the passage is open to the sky; elsewhere walls and ceiling
          // stay just under the street surface. The stub inside the station hall draws nothing.
          if (inStation || (k === 2 && open)) continue;
          const lid = k === 2 ? 0.15 : 0.06;
          const ga = this.ground(ax, az) - lid, gb = this.ground(bx, bz) - lid;
          for (const V of [A, B]) V[1] = Math.min(V[1], ga);
          for (const V of [C, D]) V[1] = Math.min(V[1], gb);
        }
        if (sty) {
          // The channel dark and slimy, the walkways worn, a band of grime and moss at the foot of the walls.
          const tn = h0 < 0 || h1 < 0 ? sty.channel : h0 === 0 && h1 === 0 ? sty.walk : Math.max(h0, h1) <= GRIME + 1e-3 ? sty.grime : sty.tint;
          mb.set('aTint', tn[0], tn[1], tn[2]);
        }
        // inward normal ~ toward the centre of the section
        const ml = (l0 + l1) / 2, mh = (h0 + h1) / 2;
        let nl = -ml, nh = (h * 0.5 - mh);
        const nlen = Math.hypot(nl, nh) || 1;
        nl /= nlen; nh /= nlen;
        const nx = -d0[1] * nl, nz = d0[0] * nl;
        const s0 = t.cum[i], s1 = t.cum[i + 1];
        const v0 = perim[k], v1 = perim[k + 1];
        // At junctions, drop the parts of this section that lie inside a crossing sewer.
        const pieces = sewer && others.length ? keptPieces(others, myIdx, A, B, C, D, h0 <= 0 && h1 <= 0) : FULL;
        // Side room doorways: the wall on their side is cut out up to the door's top.
        const wallSide = l0 >= hw - 0.2 && l1 >= hw - 0.2 ? 1 : l0 <= -(hw - 0.2) && l1 <= -(hw - 0.2) ? -1 : 0;
        let doors = wallSide && segCuts.length ? segCuts.filter((c) => c.side === wallSide) : [];
        // The vault over a manhole shaft: cut out along the shaft (the shaft's walls close it, see shaftMesh).
        const archSide = sewer && Math.min(h0, h1) >= 1.6 - 1e-3 ? (Math.min(l0, l1) >= SHAFT_IN - 1e-3 ? 1 : Math.max(l0, l1) <= -SHAFT_IN + 1e-3 ? -1 : 0) : 0;
        if (archSide && shafts.length) doors = shafts.filter((m) => m.side === archSide).map((m) => ({ s0: m.s - SHAFT_HS, s1: m.s + SHAFT_HS, top: Infinity, side: m.side }));
        for (const [pa, pb] of pieces) for (const [ta, tb, clip] of doors.length ? splitDoors(pa, pb, doors, s0, s1) : [[pa, pb, -Infinity] as [number, number, number]]) {
          let PA = A, PB = B, PC = C, PD = D, V0 = v0, V1 = v1;
          if (clip > -Infinity) {
            // In a doorway only the part of the face above the door's top stays.
            if (Math.max(h0, h1) <= clip + 1e-3) continue;
            let L0 = l0, H0 = h0, L1 = l1, H1 = h1;
            if (h0 < clip) { const q = (clip - h0) / (h1 - h0); L0 = l0 + (l1 - l0) * q; H0 = clip; V0 = v0 + (v1 - v0) * q; }
            else if (h1 < clip) { const q = (clip - h1) / (h0 - h1); L1 = l1 + (l0 - l1) * q; H1 = clip; V1 = v1 + (v0 - v1) * q; }
            PA = [ax - d0[1] * L0, ay + H0, az + d0[0] * L0]; PB = [ax - d0[1] * L1, ay + H1, az + d0[0] * L1];
            PC = [bx - d1[1] * L1, by + H1, bz + d1[0] * L1]; PD = [bx - d1[1] * L0, by + H0, bz + d1[0] * L0];
          }
          const lerp3 = (X: number[], Y: number[], f: number) => [X[0] + (Y[0] - X[0]) * f, X[1] + (Y[1] - X[1]) * f, X[2] + (Y[2] - X[2]) * f];
          const A2 = lerp3(PA, PD, ta), B2 = lerp3(PB, PC, ta), C2 = lerp3(PB, PC, tb), D2 = lerp3(PA, PD, tb);
          const sa = s0 + (s1 - s0) * ta, sb = s0 + (s1 - s0) * tb;
          const i0v = mb.v(A2[0], A2[1], A2[2], nx, nh, nz, sa, V0);
          mb.v(B2[0], B2[1], B2[2], nx, nh, nz, sa, V1);
          mb.v(C2[0], C2[1], C2[2], nx, nh, nz, sb, V1);
          mb.v(D2[0], D2[1], D2[2], nx, nh, nz, sb, V0);
          // Wind so the face is visible from inside.
          mb.quad(i0v, i0v + 3, i0v + 2, i0v + 1);
          mb.quad(i0v, i0v + 1, i0v + 2, i0v + 3);
        }
      }
      if (!sewer && !passage) {
        // Track bed, two tracks of rails and sleepers.
        mb.set('aLayer', 22).set('aTint', 0.5, 0.48, 0.45);
        quadFlat(mb, ax, ay + 0.05, az, bx, by + 0.05, bz, d0, d1, -hw, hw);
        mb.set('aLayer', 11).set('aTint', 0.45, 0.4, 0.38);
        for (const tr of [-1.9, 1.9]) for (const rl of [-0.72, 0.72]) {
          const o = tr + rl;
          mb.beam(ax - d0[1] * o, ay + 0.28, az + d0[0] * o, bx - d1[1] * o, by + 0.28, bz + d1[0] * o, 0.04, 0.07);
        }
        mb.set('aLayer', 12).set('aTint', 0.35, 0.3, 0.26);
        const segL = t.cum[i + 1] - t.cum[i];
        for (let s = 0.3; s < segL; s += 0.75) {
          const f = s / segL;
          const cx = ax + (bx - ax) * f, cy = ay + (by - ay) * f + 0.15, cz = az + (bz - az) * f;
          for (const tr of [-1.9, 1.9]) mb.box(cx - d0[1] * tr, cy, cz + d0[0] * tr, 0.12, 0.07, 1.25, Math.atan2(d0[0], d0[1]) + Math.PI / 2);
        }
        // Cable trays along both walls and a pipe on one (not across the tall openings of side rooms).
        mb.set('aLayer', 11).set('aTint', 0.32, 0.32, 0.33);
        for (const sd of [-1, 1]) {
          if (segCuts.some((c) => c.side === sd && c.top > 2.55)) continue;
          for (const [hh, off] of [[2.75, 0.14], [3.05, 0.14]]) {
            const o = sd * (hw - off);
            mb.beam(ax - d0[1] * o, ay + hh, az + d0[0] * o, bx - d1[1] * o, by + hh, bz + d1[0] * o, 0.11, 0.02);
          }
          if (sd < 0) {
            const o = sd * (hw - 0.12);
            mb.set('aTint', 0.38, 0.3, 0.24);
            mb.beam(ax - d0[1] * o, ay + 3.6, az + d0[0] * o, bx - d1[1] * o, by + 3.6, bz + d1[0] * o, 0.08, 0.08);
            mb.set('aTint', 0.32, 0.32, 0.33);
          }
        }
        // Every 60 m an emergency exit sign (running figure) and, now and then, a maintenance ladder.
        const sA = t.cum[i], sB = t.cum[i + 1];
        for (let s = Math.ceil(sA / 60) * 60; s < sB; s += 60) {
          const f = (s - sA) / Math.max(1e-6, sB - sA), sd = (s / 60) % 2 ? 1 : -1;
          if (cuts.some((c) => c.side === sd && s > c.s0 - 1.5 && s < c.s1 + 1.5)) continue;
          const cx = ax + (bx - ax) * f, cy = ay + (by - ay) * f, cz = az + (bz - az) * f;
          if (halls.some((bb) => boxAt(bb, cx, cy + 0.5, cz, 2))) continue;
          const o = sd * (hw - 0.03);
          signs.push(cx - d0[1] * o, cy + 2.3, cz + d0[0] * o, -sd * -d0[1], -sd * d0[0]);
          if ((s / 60) % 3 === 0) {
            mb.set('aLayer', 11).set('aTint', 0.5, 0.42, 0.12);
            const o2 = sd * (hw - 0.18);
            for (const e of [-0.22, 0.22]) mb.beam(cx - d0[1] * o2 + d0[0] * e, cy, cz + d0[0] * o2 + d0[1] * e, cx - d0[1] * o2 + d0[0] * e, cy + 4.6, cz + d0[0] * o2 + d0[1] * e, 0.025, 0.025);
            for (let r = 0.3; r < 4.6; r += 0.3) mb.beam(cx - d0[1] * o2 - d0[0] * 0.22, cy + r, cz + d0[0] * o2 - d0[1] * 0.22, cx - d0[1] * o2 + d0[0] * 0.22, cy + r, cz + d0[0] * o2 + d0[1] * 0.22, 0.015, 0.015);
          }
        }
        mb.set('aLayer', 8).set('aTint', 0.8, 0.8, 0.78);
      }
      if (passage) {
        // Stairs on the slope (steps every ~0.3 m of rise).
        const rise = ay - by;
        if (rise > 0.2) {
          const n = Math.ceil(rise / 0.17);
          // Steps square to this leg (not to the averaged corner direction).
          const yaw = Math.atan2(bx - ax, bz - az);
          mb.set('aLayer', 13).set('aTint', 0.75, 0.75, 0.73);
          for (let k = 0; k < n; k++) {
            const f = (k + 0.5) / n;
            const cx = ax + (bx - ax) * f, cz = az + (bz - az) * f, cy = ay + (by - ay) * f;
            mb.box(cx, cy - 0.09, cz, hw * 0.98, 0.09, (t.cum[i + 1] - t.cum[i]) / n / 2 + 0.01, yaw);
          }
          mb.set('aLayer', 15).set('aTint', 0.95, 0.95, 0.95);
        }
      }
    }
    const wet = new MeshBuilder([{ name: 'uv', size: 2 }]);
    // (Pipes, outlets and ribs keep clear of the shafts and their ladders.)
    if (sty) this.sewerDressing(t, i0, i1, mb, wet, others.map((q) => q.o), [...cuts, ...shafts.map((m) => ({ s0: m.s - SHAFT_HS - 0.3, s1: m.s + SHAFT_HS + 0.3, top: 0, side: m.side }))], sty);
    for (const m of shafts) if (m.s >= t.cum[i0] && m.s < t.cum[i1]) this.shaftMesh(m, mb, sty);
    // Dead ends get a brick end wall (ends that open into another sewer stay open).
    if (sewer) {
      const n = P.length / 3;
      for (const [vi, sign] of [[0, -1], [n - 1, 1]] as const) {
        if (vi < i0 || vi > i1) continue;
        const d = dirAt(P, vi);
        const ex = P[vi * 3], ey = P[vi * 3 + 1], ez = P[vi * 3 + 2];
        const px = ex + d[0] * sign * 0.6, pz = ez + d[1] * sign * 0.6;
        if (others.some(({ o }) => tubeAt(o, px, ey + 1, pz, 0))) continue;
        const nx = -d[0] * sign, nz = -d[1] * sign;
        if (sty) mb.set('aTint', ...sty.tint);
        const c = mb.v(ex, ey + 1.2, ez, nx, 0, nz, 0, 1.2);
        for (const [l, hh] of profile) mb.v(ex - d[1] * l, ey + hh, ez + d[0] * l, nx, 0, nz, l, hh);
        for (let k = 0; k < profile.length; k++) {
          const a1 = c + 1 + k, a2 = c + 1 + ((k + 1) % profile.length);
          mb.tri(c, a1, a2); mb.tri(c, a2, a1);
        }
      }
    }
    const mesh = new THREE.Mesh(toGeometry(mb.build()), this.mat);
    mesh.receiveShadow = true;
    g.add(mesh);
    // Lights every 12 m along the ceiling / wall.
    const lg = new MeshBuilder([]);
    for (let i = i0; i < i1; i++) {
      const segL = t.cum[i + 1] - t.cum[i];
      const every = sty ? sty.lightEvery : 12;
      for (let s = (every - (t.cum[i] % every)) % every; s < segL; s += every) {
        if (sty && hash01(myIdx * 131 + Math.round((t.cum[i] + s) / every)) < sty.dead) continue;
        const f = s / segL;
        const d = dirAt(P, i);
        const cx = P[i * 3] + (P[i * 3 + 3] - P[i * 3]) * f, cy = P[i * 3 + 1] + (P[i * 3 + 4] - P[i * 3 + 1]) * f, cz = P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * f;
        const off = sewer ? hw - 0.1 : 0;
        if (!sewer && !passage && halls.some((bb) => boxAt(bb, cx, cy + 0.5, cz, -0.05))) continue;
        if (sewer && cuts.some((c) => c.side === 1 && t.cum[i] + s > c.s0 - 0.3 && t.cum[i] + s < c.s1 + 0.3)) continue;
        let top = cy + t.height;
        if (passage) {
          top = Math.min(top, this.ground(cx, cz) - 0.15);
          if (top - cy < 2.4 || this.inHole(cx, cz) || halls.some((bb) => boxAt(bb, cx, cy + 0.5, cz, -0.05))) continue;
        }
        if (sewer && others.some(({ o }) => tubeAt(o, cx - d[1] * off, cy + 1.9, cz + d[0] * off, 0.2))) continue;
        lg.box(cx - d[1] * off, sewer ? cy + 1.9 : top - 0.1, cz + d[0] * off, sewer ? 0.06 : 0.6, 0.05, sewer ? 0.3 : 0.15, Math.atan2(d[0], d[1]));
      }
    }
    if (!lg.empty) g.add(new THREE.Mesh(toGeometry(lg.build()), this.lightMat));
    if (signs.length) {
      const sg = new MeshBuilder([{ name: 'uv', size: 2 }, { name: 'color', size: 3, type: 'u8n' }]);
      sg.set('color', 0.85, 0.95, 0.85);
      for (let k = 0; k < signs.length; k += 5) {
        const [x, y, z, fx, fz] = signs.slice(k, k + 5), rx = fz, rz = -fx;
        decal(sg, x + fx * 0.02, y, z + fz * 0.02, rx, 0, rz, 0, 1, 0, 0.3, 0.15, CELL.exit);
      }
      g.add(new THREE.Mesh(toGeometry(sg.build()), this.mats.glow));
    }
    if (sewer) {
      // Flowing water in the channel.
      const wg = new MeshBuilder([{ name: 'uv', size: 2 }]);
      for (let i = i0; i < i1; i++) {
        const d0 = dirAt(P, i), d1 = dirAt(P, i + 1);
        quadFlat(wg, P[i * 3], P[i * 3 + 1] - 0.15, P[i * 3 + 2], P[i * 3 + 3], P[i * 3 + 4] - 0.15, P[i * 3 + 5], d0, d1, -0.6, 0.6);
      }
      g.add(new THREE.Mesh(toGeometry(wg.build()), this.waterMat));
      if (!wet.empty) g.add(new THREE.Mesh(toGeometry(wet.build()), this.waterMat));
      // Daylight through the manhole lids (fades with the day): the lid's pick holes glowing at the top
      // of the shaft (an open one lets the sky in) and a soft pool of light on the walkway and the water.
      const sh = new MeshBuilder([{ name: 'color', size: 3, type: 'u8n' }]);
      const glow = new MeshBuilder([{ name: 'color', size: 3, type: 'u8n' }]);
      for (const m of shafts) {
        if (m.s < t.cum[i0] || m.s >= t.cum[i1]) continue;
        const open = this.isOpen(m), SEG = 16, RINGS = 5, R = open ? 1.8 : 1.5;
        if (!open) {
          // (Its own mesh, facing down only: from the street it must not shine through the lid.)
          const c = shaftPoint(m, LID_LAT, 0, this.ground(m.x, m.z) - m.floor - 0.06);
          glow.set('color', 1, 0.96, 0.88);
          const c0 = glow.v(c[0], c[1], c[2], 0, -1, 0);
          for (let k = 0; k < SEG; k++) { const a = (k / SEG) * Math.PI * 2; glow.v(c[0] + Math.cos(a) * 0.3, c[1], c[2] + Math.sin(a) * 0.3, 0, -1, 0); }
          for (let k = 0; k < SEG; k++) glow.tri(c0, c0 + 1 + k, c0 + 1 + ((k + 1) % SEG));
        }
        // The pool: rings of vertices, on the walkway (and the water, where it reaches the channel).
        const q = shaftPoint(m, LID_LAT, 0, 0.015);
        const lit = open ? 0.6 : 0.35;
        sh.set('color', lit, lit * 0.96, lit * 0.88);
        const base = sh.v(q[0], q[1], q[2], 0, 1, 0);
        const ring0 = base + 1;
        for (let r = 1; r <= RINGS; r++) {
          const rr = (r / RINGS) * R, f = Math.pow(1 - r / RINGS, 2) * lit;
          sh.set('color', f, f * 0.96, f * 0.88);
          for (let k = 0; k < SEG; k++) {
            const a = (k / SEG) * Math.PI * 2;
            // Across the trunk (u, from the centreline on the shaft's side) the pool stops at the wall.
            const u = Math.min(SEWER_HW - 0.03, LID_LAT + Math.cos(a) * rr), v = Math.sin(a) * rr;
            const p = shaftPoint(m, u, v, Math.abs(u) < 0.6 ? -0.14 : 0.015);
            sh.v(p[0], p[1], p[2], 0, 1, 0);
          }
        }
        for (let k = 0; k < SEG; k++) sh.tri(base, ring0 + ((k + 1) % SEG), ring0 + k);
        for (let r = 0; r + 1 < RINGS; r++) for (let k = 0; k < SEG; k++) {
          const a0 = ring0 + r * SEG, a1 = a0 + SEG, k1 = (k + 1) % SEG;
          sh.quad(a0 + k, a0 + k1, a1 + k1, a1 + k);
        }
      }
      if (!sh.empty) { const m = new THREE.Mesh(toGeometry(sh.build()), this.shaftMat); m.renderOrder = 3; g.add(m); }
      if (!glow.empty) { const m = new THREE.Mesh(toGeometry(glow.build()), this.lidGlowMat); m.renderOrder = 3; g.add(m); }
    }
    return g;
  }

  /**
   * A manhole shaft (see MANHOLE_EVERY): its four walls from the vault's opening up to just under
   * the street, the lid's underside while it is closed, and the ladder on the outer wall from the
   * walkway to the top (rails, rungs every RUNG m, brackets into the wall).
   */
  private shaftMesh(m: ManholeSpot, mb: MeshBuilder, sty: SewerStyle | null): void {
    const top = this.ground(m.x, m.z) - m.floor - 0.03, hs = SHAFT_HS;
    const W = (lat: number, ds: number, y: number) => shaftPoint(m, lat, ds, y);
    // Inward normal of a wall across the trunk (at lat, facing −side) and along it (at ±hs).
    const nAcross = (sgn: number): [number, number, number] => [m.dz * m.side * sgn, 0, -m.dx * m.side * sgn];
    const nAlong = (sgn: number): [number, number, number] => [m.dx * sgn, 0, m.dz * sgn];
    const face = (A: number[], B: number[], C: number[], D: number[], n: [number, number, number], u0: number, u1: number, v0: number, v1: number, v2 = v1, v3 = v0) => {
      const i = mb.v(A[0], A[1], A[2], n[0], n[1], n[2], u0, v0);
      mb.v(B[0], B[1], B[2], n[0], n[1], n[2], u1, v3);
      mb.v(C[0], C[1], C[2], n[0], n[1], n[2], u1, v2);
      mb.v(D[0], D[1], D[2], n[0], n[1], n[2], u0, v1);
      mb.quad(i, i + 1, i + 2, i + 3); mb.quad(i, i + 3, i + 2, i + 1);
    };
    if (sty) mb.set('aLayer', sty.layer).set('aTint', ...sty.tint);
    // Outer wall (the trunk's wall going on up) and inner wall (from the vault).
    face(W(SEWER_HW, -hs, 1.6), W(SEWER_HW, hs, 1.6), W(SEWER_HW, hs, top), W(SEWER_HW, -hs, top), nAcross(1), 0, hs * 2, 1.6, top);
    const vin = SHAFT_VAULT[SHAFT_VAULT.length - 1][1];
    face(W(SHAFT_IN, -hs, vin), W(SHAFT_IN, hs, vin), W(SHAFT_IN, hs, top), W(SHAFT_IN, -hs, top), nAcross(-1), 0, hs * 2, vin, top);
    // End walls: down to the vault's curve.
    for (const e of [-1, 1]) for (let k = 0; k + 1 < SHAFT_VAULT.length; k++) {
      const [la, ya] = SHAFT_VAULT[k], [lb, yb] = SHAFT_VAULT[k + 1];
      face(W(la, e * hs, ya), W(lb, e * hs, yb), W(lb, e * hs, top), W(la, e * hs, top), nAlong(-e), la, lb, ya, top, top, yb);
    }
    // The round neck under the street: a brick cylinder down to a slab closing the square shaft round it.
    const y0 = top - COLLAR, N = 24, hu = (SEWER_HW - SHAFT_IN) / 2;
    const ang: number[] = [];
    for (let k = 0; k < N; k++) ang.push((k / N) * Math.PI * 2);
    const ca = Math.atan2(hs, hu);
    ang.push(ca, Math.PI - ca, Math.PI + ca, Math.PI * 2 - ca);
    ang.sort((a, b) => a - b);
    const C = (a: number, r: number, y: number) => W(LID_LAT + Math.cos(a) * r, Math.sin(a) * r, y);
    for (let k = 0; k < ang.length; k++) {
      const a0 = ang[k], a1 = k + 1 < ang.length ? ang[k + 1] : ang[0] + Math.PI * 2;
      // Cylinder (normal toward the centre).
      const am = (a0 + a1) / 2;
      const nc: [number, number, number] = [0, 0, 0];
      { const c = W(LID_LAT, 0, 0), q = C(am, 1, 0); nc[0] = c[0] - q[0]; nc[2] = c[2] - q[2]; }
      face(C(a0, HOLE_R, y0), C(a1, HOLE_R, y0), C(a1, HOLE_R, top + 0.03), C(a0, HOLE_R, top + 0.03), nc, a0 * HOLE_R, a1 * HOLE_R, y0, top + 0.03);
      // Slab: from the circle out to the square shaft's walls.
      const ro = (a: number) => Math.min(hu / Math.max(1e-6, Math.abs(Math.cos(a))), hs / Math.max(1e-6, Math.abs(Math.sin(a))));
      face(C(a0, HOLE_R, y0), C(a1, HOLE_R, y0), C(a1, ro(a1), y0), C(a0, ro(a0), y0), [0, -1, 0], 0, 1, 0, 1);
    }
    if (!this.isOpen(m)) {
      // The lid's underside (cast iron) while it is on.
      mb.set('aLayer', 11).set('aTint', 0.1, 0.1, 0.1);
      const c = W(LID_LAT, 0, top + 0.01), c0 = mb.v(c[0], c[1], c[2], 0, -1, 0, 0, 0);
      for (const a of ang) { const q = C(a, HOLE_R, top + 0.01); mb.v(q[0], q[1], q[2], 0, -1, 0, 0, 0); }
      for (let k = 0; k < ang.length; k++) { const k1 = (k + 1) % ang.length; mb.tri(c0, c0 + 1 + k, c0 + 1 + k1); mb.tri(c0, c0 + 1 + k1, c0 + 1 + k); }
    } else {
      // The lid's cast-iron frame round the open hole, flush with the street.
      mb.set('aLayer', 11).set('aTint', 0.12, 0.12, 0.12);
      for (let k = 0; k < ang.length; k++) {
        const a0 = ang[k], a1 = k + 1 < ang.length ? ang[k + 1] : ang[0] + Math.PI * 2;
        face(C(a0, HOLE_R, top + 0.04), C(a1, HOLE_R, top + 0.04), C(a1, HOLE_R + 0.07, top + 0.04), C(a0, HOLE_R + 0.07, top + 0.04), [0, 1, 0], 0, 1, 0, 1);
      }
    }
    // The ladder: galvanised rails and rungs, brackets into the wall.
    mb.set('aLayer', 11).set('aTint', 0.46, 0.45, 0.42);
    const L = LADDER_LAT, rt = top - 0.02;
    for (const e of [-LADDER_HW, LADDER_HW]) {
      const a = W(L, e, 0), b = W(L, e, rt);
      mb.beam(a[0], a[1], a[2], b[0], b[1], b[2], 0.02, 0.02);
      for (let y = 0.45; y < y0 - 0.1; y += 1.2) {
        const p = W(L, e, y), q = W(SEWER_HW + 0.02, e, y);
        mb.beam(p[0], p[1], p[2], q[0], q[1], q[2], 0.012, 0.02);
      }
    }
    for (let y = RUNG; y < rt - 0.1; y += RUNG) {
      const a = W(L, -LADDER_HW, y), b = W(L, LADDER_HW, y);
      mb.beam(a[0], a[1], a[2], b[0], b[1], b[2], 0.015, 0.015);
    }
  }

  /** Daylight under the manholes (lid glow, light pool): additive, scaled by the daylight each frame. */
  private shaftMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, color: 0x000000, fog: false });
  private lidGlowMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide, color: 0x000000, fog: false });

  /**
   * A sewer chunk's furnishings by its trunk's style: pipes on brackets along the walls (stopping
   * at junction openings and doorways, turning into the wall there), ribs across the vault at
   * intervals and a stone portal at every junction mouth, outlet pipes dribbling into the channel.
   */
  private sewerDressing(t: Tube, i0: number, i1: number, mb: MeshBuilder, wet: MeshBuilder, others: Tube[], cuts: { s0: number; s1: number; top: number; side: number }[], sty: SewerStyle): void {
    const hw = t.halfWidth, h = t.height, sA = t.cum[i0], sB = t.cum[i1];
    const total = t.cum[t.cum.length - 1];
    const inOther = (x: number, y: number, z: number, m = 0.25) => others.some((o) => !!tubeAt(o, x, y, z, m));
    const at = (s: number, lat: number, y: number) => {
      const q = pointOnTube(t, s);
      if (!q) return null;
      return { x: q.x - q.dz * lat, y: q.y + y, z: q.z + q.dx * lat, dx: q.dx, dz: q.dz, fy: q.y };
    };
    const door = (s: number, side: number, pad = 0.4) => cuts.some((c) => c.side === side && s > c.s0 - pad && s < c.s1 + pad);
    // Pipes: one straight run per tube segment and free stretch, turning into the wall where they stop.
    for (const pp of sty.pipes) {
      const lat = pp.side * (hw - 0.05 - pp.r);
      mb.set('aLayer', 8).set('aTint', ...pp.tint);
      const free = (s: number) => {
        const q = at(s, lat, pp.y);
        return !!q && !door(s, pp.side) && !inOther(q.x, q.y, q.z);
      };
      const elbow = (s: number) => {
        const q = at(s, lat, pp.y), w = at(s, pp.side * (hw + 0.05), pp.y);
        if (q && w) pipe(mb, w.x, q.y, w.z, q.x + (q.x - w.x) * 0.3, q.y, q.z + (q.z - w.z) * 0.3, pp.r);
      };
      for (let k = i0; k < i1; k++) {
        const k0 = Math.max(t.cum[k], 0.3), k1 = Math.min(t.cum[k + 1], total - 0.3);
        let r0 = -1;
        const n = Math.max(1, Math.ceil((k1 - k0) / 0.5));
        for (let j = 0; j <= n; j++) {
          const s = k0 + ((k1 - k0) * j) / n, ok = free(s);
          if (ok && r0 < 0) { r0 = s; if (!free(s - 0.5) && s > 0.4) elbow(s); }
          if (r0 >= 0 && (!ok || j === n)) {
            const e = ok ? s : s - (k1 - k0) / n;
            const A = at(r0, lat, pp.y), B = at(e, lat, pp.y);
            // A little past the joint so neighbouring segments meet without a gap.
            if (A && B && e > r0 + 0.05) pipe(mb, A.x - A.dx * 0.02, A.y, A.z - A.dz * 0.02, B.x + B.dx * 0.02, B.y, B.z + B.dz * 0.02, pp.r);
            if (!ok) elbow(e);
            r0 = -1;
          }
        }
      }
      // Brackets holding it to the wall.
      mb.set('aTint', 0.06, 0.055, 0.05);
      for (let s = Math.ceil(sA / 2.5) * 2.5; s < sB; s += 2.5) {
        if (!free(s)) continue;
        const q = at(s, lat, pp.y), w = at(s, pp.side * (hw + 0.02), pp.y);
        if (q && w) mb.beam(w.x, q.y, w.z, q.x, q.y, q.z, 0.03, pp.r + 0.015);
      }
    }
    // Ribs: rings across walls and vault (a slightly lighter, stone-dressed band).
    const ring = (s: number, inset: number, half: number, tint: readonly [number, number, number]) => {
      const c = at(s, 0, 0);
      if (!c || inOther(c.x, c.y + 1.2, c.z, 0.6)) return;
      if (cuts.some((q) => s > q.s0 - half - 0.3 && s < q.s1 + half + 0.3)) return;
      const pts: [number, number][] = [[hw, 0], [hw, 1.6], ...arch(hw, 1.6, h, 10).slice(0, -1), [-hw, 1.6], [-hw, 0]];
      const inner = pts.map(([l, y]): [number, number] => y <= 1.6 ? [l - Math.sign(l) * inset, y] : [l * (1 - inset / hw), 1.6 + (y - 1.6) * (1 - inset / (h - 1.6))]);
      mb.set('aLayer', sty.ribLayer).set('aTint', ...tint);
      const W = (lat: number, y: number, ds: number) => [c.x - c.dz * lat + c.dx * ds, c.fy + y, c.z + c.dx * lat + c.dz * ds];
      const quad = (A: number[], B: number[], C: number[], D: number[]) => {
        const i = mb.v(A[0], A[1], A[2], 0, 1, 0, 0, 0); mb.v(B[0], B[1], B[2], 0, 1, 0, 1, 0); mb.v(C[0], C[1], C[2], 0, 1, 0, 1, 1); mb.v(D[0], D[1], D[2], 0, 1, 0, 0, 1);
        mb.quad(i, i + 1, i + 2, i + 3); mb.quad(i, i + 3, i + 2, i + 1);
      };
      for (let k = 0; k + 1 < pts.length; k++) {
        const [la, ya] = pts[k], [lb, yb] = pts[k + 1], [ia, ja] = inner[k], [ib, jb] = inner[k + 1];
        quad(W(ia, ja, -half), W(ib, jb, -half), W(ib, jb, half), W(ia, ja, half));
        quad(W(la, ya, -half), W(lb, yb, -half), W(ib, jb, -half), W(ia, ja, -half));
        quad(W(la, ya, half), W(lb, yb, half), W(ib, jb, half), W(ia, ja, half));
      }
    };
    if (sty.ribEvery > 0) for (let s = Math.ceil(sA / sty.ribEvery) * sty.ribEvery; s < sB; s += sty.ribEvery) ring(s, 0.12, 0.18, sty.rib);
    // Portals at the junction mouths: a deeper stone arch where this trunk opens into another.
    for (const end of [0, 1]) {
      const s0 = end ? total : 0;
      if (s0 < sA - 0.01 || s0 > sB + 0.01) continue;
      const e = at(end ? total - 0.01 : 0.01, 0, 1);
      if (!e) continue;
      const o = others.find((q) => !!tubeAt(q, e.x, e.y, e.z, 0));
      if (!o) continue;
      const s = end ? total - o.halfWidth - 0.55 : o.halfWidth + 0.55;
      if (s > 0.5 && s < total - 0.5) ring(s, 0.22, 0.3, [0.62, 0.6, 0.55]);
    }
    // Outlets: a pipe mouth low in the wall, a thin stream across the walkway into the channel.
    for (let s = sty.outletFirst; s < total; s += sty.outletEvery) {
      if (s < sA || s >= sB) continue;
      const side = hash01(Math.round(s) + sty.seed) < 0.5 ? 1 : -1;
      if (door(s, side, 1)) continue;
      const m = at(s, side * (hw - 0.05), 0.55), o = at(s, side * (hw - 0.32), 0.55);
      if (!m || !o || inOther(m.x, m.y, m.z, 0.5)) continue;
      mb.set('aLayer', 8).set('aTint', 0.28, 0.24, 0.2);
      pipe(mb, m.x, m.y, m.z, o.x, o.y, o.z, 0.13);
      // The dark mouth.
      mb.set('aTint', 0.03, 0.03, 0.03);
      mb.box(o.x, o.y, o.z, 0.1, 0.1, 0.1, Math.atan2(o.dx, o.dz));
      // The stream: falling from the lip, then a wet streak to the channel.
      const lx = -o.dz * side, lz = o.dx * side;
      const ex = o.x - lx * 0.02, ez = o.z - lz * 0.02;
      const i = wet.v(ex - o.dx * 0.025, o.y - 0.08, ez - o.dz * 0.025, -lx, 0, -lz, 0, 0);
      wet.v(ex + o.dx * 0.025, o.y - 0.08, ez + o.dz * 0.025, -lx, 0, -lz, 1, 0);
      wet.v(ex + o.dx * 0.04, o.fy + 0.01, ez + o.dz * 0.04, -lx, 0, -lz, 1, 1);
      wet.v(ex - o.dx * 0.04, o.fy + 0.01, ez - o.dz * 0.04, -lx, 0, -lz, 0, 1);
      wet.quad(i, i + 1, i + 2, i + 3); wet.quad(i, i + 3, i + 2, i + 1);
      const c0 = at(s, side * 0.62, 0.012);
      if (c0) {
        const j = wet.v(ex - o.dx * 0.12, o.fy + 0.012, ez - o.dz * 0.12, 0, 1, 0, 0, 0);
        wet.v(ex + o.dx * 0.12, o.fy + 0.012, ez + o.dz * 0.12, 0, 1, 0, 1, 0);
        wet.v(c0.x + o.dx * 0.2, c0.y, c0.z + o.dz * 0.2, 0, 1, 0, 1, 1);
        wet.v(c0.x - o.dx * 0.2, c0.y, c0.z - o.dz * 0.2, 0, 1, 0, 0, 1);
        wet.quad(j, j + 1, j + 2, j + 3); wet.quad(j, j + 3, j + 2, j + 1);
      }
    }
    mb.set('aLayer', sty.layer).set('aTint', ...sty.tint);
  }

  private buildStation(b: Box, bi: number): THREE.Object3D {
    const g = new THREE.Group();
    const mb = new MeshBuilder(facadeSpecs());
    const st = this.macro.metroStations[b.station ?? 0];
    const P = (u: number, v: number, y: number): [number, number, number] => [b.cx + b.ux * u - b.uz * v, y, b.cz + b.uz * u + b.ux * v];
    const yaw = Math.atan2(b.ux, b.uz);
    const box = (u: number, v: number, y: number, hu: number, hy: number, hv: number) => {
      const p = P(u, v, y);
      mb.box(p[0], p[1], p[2], hv, hy, hu, yaw);
    };
    mb.set('aSeed', 0.6).set('aElem', 0).set('aFacade', 1, 1, 1, 0);
    // Shell: walls (tiled), ceiling, floor.
    mb.set('aLayer', 15).set('aTint', 0.94, 0.94, 0.92);
    for (const sv of [-1, 1]) {
      // Side walls, with doorways where entrance passages arrive on the platform.
      const doors = (this.doors.get(bi) ?? []).filter((d) => d.sv === sv).sort((p, q) => p.u - q.u);
      const yd = b.y0 + PLATFORM_H + PASSAGE_H, v = sv * b.hv;
      let u0 = -b.hu;
      for (const d of doors) {
        const d0 = d.u - PASSAGE_HW, d1 = d.u + PASSAGE_HW;
        if (d0 > u0) wallQuad(mb, P(u0, v, b.y0), P(d0, v, b.y0), b.y1 - b.y0, -sv, b);
        wallQuad(mb, P(d0, v, b.y0), P(d1, v, b.y0), PLATFORM_H, -sv, b);
        wallQuad(mb, P(d0, v, yd), P(d1, v, yd), b.y1 - yd, -sv, b);
        u0 = d1;
      }
      wallQuad(mb, P(u0, v, b.y0), P(b.hu, v, b.y0), b.y1 - b.y0, -sv, b);
    }
    for (const su of [-1, 1]) {
      // End walls with the tunnel portal openings (leave the track area open).
      for (const [v0, v1] of [[-b.hv, -TUNNEL_HW], [TUNNEL_HW, b.hv]]) {
        const a = P(su * b.hu, v0, b.y0), c = P(su * b.hu, v1, b.y0);
        wallQuad(mb, a, c, b.y1 - b.y0, 0, b, -su);
      }
      const a = P(su * b.hu, -TUNNEL_HW, b.y0 + TUNNEL_H), c = P(su * b.hu, TUNNEL_HW, b.y0 + TUNNEL_H);
      wallQuad(mb, a, c, b.y1 - b.y0 - TUNNEL_H, 0, b, -su);
    }
    mb.set('aLayer', 9).set('aTint', 0.85, 0.85, 0.83);
    box(0, 0, b.y1, b.hu, 0.1, b.hv);
    // Track bed and platforms.
    mb.set('aLayer', 22).set('aTint', 0.5, 0.48, 0.45);
    box(0, 0, b.y0 - 0.05, b.hu, 0.05, PLATFORM_EDGE + 0.01); // track bed reaches the platform walls
    mb.set('aLayer', 13).set('aTint', 0.8, 0.79, 0.76);
    const safety: number[] = [];
    for (const sv of [-1, 1]) {
      const vc = sv * (b.hv + PLATFORM_EDGE) / 2;
      box(0, vc, b.y0 + PLATFORM_H / 2, b.hu, PLATFORM_H / 2, (b.hv - PLATFORM_EDGE) / 2);
      // Yellow safety line at the platform edge (plain paint, see below).
      safety.push(sv * (PLATFORM_EDGE + 0.4));
    }
    // Rails through the station.
    mb.set('aLayer', 11).set('aTint', 0.45, 0.4, 0.38);
    for (const tr of [-1.9, 1.9]) for (const rl of [-0.72, 0.72]) box(0, tr + rl, b.y0 + 0.2, b.hu, 0.07, 0.04);
    // Columns along the platform edges, benches.
    mb.set('aLayer', 4).set('aTint', 0.9, 0.88, 0.84);
    for (let u = -b.hu + 8; u < b.hu - 6; u += 8) {
      for (const sv of [-1, 1]) {
        box(u, sv * (b.hv - 1.2), b.y0 + PLATFORM_H + (b.y1 - b.y0 - PLATFORM_H) / 2, 0.3, (b.y1 - b.y0 - PLATFORM_H) / 2, 0.3);
        mb.set('aLayer', 12).set('aTint', 0.45, 0.32, 0.2);
        box(u + 4, sv * (b.hv - 0.6), b.y0 + PLATFORM_H + 0.45, 1.0, 0.05, 0.22);
        mb.set('aLayer', 4).set('aTint', 0.9, 0.88, 0.84);
      }
    }
    // Departure boards hang over the middle of each platform at two points; rods to the ceiling.
    const boardY = b.y0 + PLATFORM_H + 3.1, boardU = [-b.hu * 0.35, b.hu * 0.35];
    const boardV = (sv: number) => sv * (b.hv + PLATFORM_EDGE) / 2;
    const metroLine = this.macro.metroLines[b.line ?? -1];
    if (metroLine) {
      mb.set('aLayer', 11).set('aTint', 0.3, 0.3, 0.32);
      for (const sv of [-1, 1]) for (const u of boardU) for (const dv of [-1, 1]) {
        box(u, boardV(sv) + dv * 1.0, (boardY + BOARD_H / 2 + b.y1) / 2, 0.025, (b.y1 - boardY - BOARD_H / 2) / 2, 0.025);
      }
    }
    const mesh = new THREE.Mesh(toGeometry(mb.build()), this.mat);
    mesh.receiveShadow = true;
    g.add(mesh);
    if (metroLine) {
      const stop = metroLine.stations.indexOf(b.station ?? -1);
      for (const sv of [-1, 1]) {
        const canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 128;
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        // Same material setup as the name signs (no new shader variant).
        const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.9 });
        for (const u of boardU) for (const face of [-1, 1]) {
          const m = new THREE.Mesh(new THREE.PlaneGeometry(BOARD_W, BOARD_H), mat);
          const p = P(u + face * 0.02, boardV(sv), boardY);
          m.position.set(p[0], p[1], p[2]);
          m.lookAt(p[0] + face * b.ux, p[1], p[2] + face * b.uz);
          g.add(m);
        }
        this.boards.push({ bi, owner: g, dir: sv, line: metroLine, stop, x: b.cx, z: b.cz, canvas, tex, mat, key: '' });
      }
    }
    const sm = new MeshBuilder([]);
    for (const v of safety) {
      const p = P(0, v, b.y0 + PLATFORM_H + 0.006);
      sm.box(p[0], p[1], p[2], 0.12, 0.006, b.hu, yaw);
    }
    const line = new THREE.Mesh(toGeometry(sm.build()), this.safetyMat);
    line.receiveShadow = true;
    g.add(line);
    // Ceiling light strips.
    const lg = new MeshBuilder([]);
    for (const sv of [-1, 1]) for (let u = -b.hu + 4; u < b.hu - 3; u += 6) {
      const p = P(u, sv * (b.hv - 2.2), b.y1 - 0.15);
      lg.box(p[0], p[1], p[2], 0.15, 0.04, 2.2, yaw);
    }
    g.add(new THREE.Mesh(toGeometry(lg.build()), this.lightMat));
    // Name signs on the walls.
    const tex = signTexture(st.name, st.lines.map((l) => this.macro.metroLines[l]?.color ?? 0x888888));
    const signMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.25 });
    for (const sv of [-1, 1]) for (const u of [-b.hu * 0.5, 0, b.hu * 0.5]) {
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 0.9), signMat);
      const p = P(u, sv * (b.hv - 0.03), b.y0 + PLATFORM_H + 2.4);
      sign.position.set(p[0], p[1], p[2]);
      sign.lookAt(p[0] + sv * b.uz, p[1], p[2] - sv * b.ux);
      g.add(sign);
    }
    // Real platform lights come from a fixed pool (see update): the number of lights in
    // the scene must never change, or every lit shader recompiles.
    return g;
  }

  /** Departure boards: the next two trains for the platform (redrawn only when the text changes). */
  private updateBoards(cam: THREE.Vector3): void {
    this.boards = this.boards.filter((bd) => {
      if (this.built.get(`b${bd.bi}`) === bd.owner) return true;
      bd.tex.dispose();
      bd.mat.dispose();
      return false;
    });
    for (const bd of this.boards) {
      if (Math.hypot(bd.x - cam.x, bd.z - cam.z) > 160) continue;
      const line = bd.line, t = this.time;
      const first = nextTrainAt(line, bd.stop, bd.dir, t);
      if (!first) continue;
      const t2 = t + (first.dwelling ? first.left : first.wait + DWELL) + 0.5;
      const second = nextTrainAt(line, bd.stop, bd.dir, t2);
      const dest = this.terminus(line, bd.dir);
      const ends = line.stations[bd.dir > 0 ? line.stations.length - 1 : 0] === line.stations[bd.stop];
      const when = first.dwelling ? (first.left < DOOR_CLOSE + 2 ? 'Departing' : 'Boarding') : first.wait < 25 ? 'Arriving' : `${Math.ceil(first.wait / 60)} min`;
      const then = second ? `then ${Math.max(1, Math.ceil((t2 - t + second.wait) / 60))} min` : '';
      const key = `${when}|${then}`;
      if (key === bd.key) continue;
      bd.key = key;
      drawBoard(bd.canvas, line.name, `#${line.color.toString(16).padStart(6, '0')}`, ends ? 'Terminates here' : dest, when, then);
      bd.tex.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------ trains

  /** Train state along a line (see layout.trainsOn). */
  trainsOn(line: MetroLine, t: number): TrainState[] {
    return trainsOn(line, t);
  }

  /** Every car of every train at the last update: pose (centre on the track bed, heading), velocity, schedule. */
  readonly cars: TrainCar[] = [];
  /** The player's ride: train k of a line, the car's physical slot along the train, offset in the car (along, across). */
  ride: { line: number; k: number; slot: number; u: number; v: number } | null = null;
  /** The ridden car's frame last update (to carry the player's own steps inside it along). */
  private rideFrame: { x: number; z: number; fx: number; fz: number } | null = null;
  /** The player's body (set by the game): carried by the train it rides, pushed aside by trains. */
  body: { pos: THREE.Vector3; vel: THREE.Vector3; grounded: boolean; height: number; radius: number; flying: boolean } | null = null;

  private computeCars(time: number): void {
    this.cars.length = 0;
    this.macro.metroLines.forEach((line, li) => {
      const tube = this.tubes[li];
      const now = trainsOn(line, time), soon = trainsOn(line, time + 0.1);
      now.forEach((tr, k) => {
        for (let c = 0; c < CARS; c++) {
          const p = carPose(tube, tr, c);
          if (!p) continue;
          const slot = tr.dir * ((CARS - 1) / 2 - c);
          const q = soon[k].dir === tr.dir ? carPose(tube, soon[k], c) : null;
          this.cars.push({ line: li, k, slot, dir: tr.dir, x: p.x, y: p.y, z: p.z, dx: p.dx, dz: p.dz, vx: q ? (q.x - p.x) * 10 : 0, vz: q ? (q.z - p.z) * 10 : 0, dwell: tr.dwell, left: tr.left, next: tr.next, s: tr.s, open: tr.dwell && tr.left > DOOR_CLOSE });
        }
      });
    });
  }

  private ridden(): TrainCar | null {
    const r = this.ride;
    if (!r) return null;
    return this.cars.find((c) => c.line === r.line && c.k === r.k && Math.abs(c.slot - r.slot) < 0.01) ?? null;
  }

  /**
   * Car-local coordinates of a point: along the car (u, in the direction of travel), across (v,
   * positive towards the platform side: trains run on the right-hand track, platforms are outside
   * the tracks), height over the car floor (h).
   */
  private carLocal(c: TrainCar, x: number, y: number, z: number): { u: number; v: number; h: number } {
    const ox = x - c.x, oz = z - c.z;
    return { u: ox * c.dx + oz * c.dz, v: -ox * c.dz + oz * c.dx, h: y - (c.y + CAR_FLOOR) };
  }

  /** World point of car-local (u, v). */
  private carWorld(c: TrainCar, u: number, v: number): [number, number] {
    return [c.x + c.dx * u - c.dz * v, c.z + c.dz * u + c.dx * v];
  }

  /** Is car-local u in a doorway (with a margin for the body)? */
  private atDoor(u: number, margin: number): boolean {
    return DOOR_U.some((d) => Math.abs(u - d) < DOOR_HW - margin);
  }

  /**
   * Sounds of the trains near the listener, from each train's middle car: doors (open / close),
   * the braking squeal pulling in, the departure, and a roaring rush past (in tunnels and through
   * stations, or past the ridden train).
   */
  private trainSounds(cam: THREE.Vector3): void {
    if (!this.onTrainSound) return;
    const mine = this.ridden();
    const seen = new Set<string>();
    for (const c of this.cars) {
      // One car per train: the one just ahead of the middle.
      if (Math.abs(c.slot - c.dir * ((CARS - 1) / 2 - Math.floor((CARS - 1) / 2))) > 0.01) continue;
      const key = `${c.line}:${c.k}`;
      seen.add(key);
      const d = Math.hypot(c.x - cam.x, c.y - cam.y, c.z - cam.z);
      const speed = Math.hypot(c.vx, c.vz);
      const line = this.macro.metroLines[c.line];
      const toStop = Math.abs(c.s - (line.stationS[c.next] ?? c.s));
      const own = !!mine && mine.line === c.line && mine.k === c.k;
      const ev = this.trainEv.get(key);
      if (!ev) { this.trainEv.set(key, { open: c.open, dwell: c.dwell, arriving: false, near: false }); continue; }
      const y = c.y + 1.5;
      if (d < 120) {
        if (c.open !== ev.open) this.onTrainSound('metro_doors', c.x, y, c.z, own ? 0.8 : 1);
        if (!c.dwell && ev.dwell) this.onTrainSound('metro_depart', c.x, y, c.z, own ? 0.7 : 1);
        if (!c.dwell && !ev.arriving && toStop < 140 && toStop > 20) { ev.arriving = true; this.onTrainSound('metro_arrive', c.x, y, c.z, own ? 0.7 : 1); }
      }
      if (c.dwell) ev.arriving = false;
      // Rushing past: a moving train comes within reach of the listener (not the one ridden).
      const near = !own && speed > 7 && d < (mine ? 14 : 22);
      if (near && !ev.near) this.onTrainSound('metro_pass', c.x, y, c.z, mine ? 1 : 0.8);
      ev.near = near;
      ev.open = c.open;
      ev.dwell = c.dwell;
    }
    for (const k of this.trainEv.keys()) if (!seen.has(k)) this.trainEv.delete(k);
  }

  private m4 = new THREE.Matrix4();
  private updateTrains(time: number, cam: THREE.Vector3): void {
    this.computeCars(time);
    let k = 0;
    for (const c of this.cars) {
      if (Math.hypot(c.x - cam.x, c.z - cam.z) > 500) continue;
      if (k >= 400) break;
      this.m4.makeRotationY(Math.atan2(c.dx, c.dz));
      this.m4.setPosition(c.x, c.y, c.z);
      this.trainMesh.setMatrixAt(k, this.m4);
      this.glassMesh.setMatrixAt(k, this.m4);
      const col = _col.setHex(this.macro.metroLines[c.line].color);
      this.trainColor.setXYZ(k, col.r, col.g, col.b);
      // Door leaves: the platform side (local −x) slides open during the dwell.
      for (const side of [-1, 1]) {
        _m4b.makeScale(side, 1, 1).setPosition(0, 0, side === -1 && c.open ? 1.25 : 0);
        this.leafMesh.setMatrixAt(k * 2 + (side + 1) / 2, _m4c.multiplyMatrices(this.m4, _m4b));
      }
      k++;
    }
    this.leafMesh.count = k * 2;
    this.leafMesh.instanceMatrix.needsUpdate = true;
    this.trainMesh.count = k;
    this.trainMesh.instanceMatrix.needsUpdate = true;
    this.glassMesh.count = k;
    this.glassMesh.instanceMatrix.needsUpdate = true;
    this.trainColor.needsUpdate = true;
    const was = this.riding;
    this.riding = null;
    this.carryBody();
    const now = this.riding as Underground['riding'];
    if (now && was) now.accel = (now.speed - was.speed) / Math.max(1e-3, time - this.rideTime);
    this.rideTime = time;
    this.trainSounds(cam);
  }

  /** Riding: the body moves with its car (its own steps inside the car are kept); trains shove bodies off the track. */
  private carryBody(): void {
    const b = this.body;
    if (!b) return;
    let car = this.ridden();
    if (this.ride && !car) { this.ride = null; this.rideFrame = null; }
    // Walking in through an open door (or standing inside a car): one rides it.
    if (!this.ride && !b.flying && b.height < 2.4) {
      for (const c of this.cars) {
        if (Math.abs(c.x - b.pos.x) > 12 || Math.abs(c.z - b.pos.z) > 12) continue;
        const L = this.carLocal(c, b.pos.x, b.pos.y, b.pos.z);
        if (Math.abs(L.u) < CAR_L / 2 - 0.4 && Math.abs(L.v) < CAR_W / 2 - 0.35 && L.h > -0.3 && L.h < 1) {
          this.ride = { line: c.line, k: c.k, slot: c.slot, u: L.u, v: L.v };
          this.rideFrame = null;
          car = c;
          break;
        }
      }
    }
    if (this.ride && car) {
      const r = this.ride;
      if (this.rideFrame) {
        // The body's own steps inside the car (since the last update), in the car's frame.
        const f = this.rideFrame, ox = b.pos.x - f.x, oz = b.pos.z - f.z;
        const u = ox * f.fx + oz * f.fz, v = -ox * f.fz + oz * f.fx;
        r.u = Math.max(-CAR_L / 2 + 0.5, Math.min(CAR_L / 2 - 0.5, u));
        const door = this.atDoor(r.u, 0.25);
        // Through an open door onto the platform: no longer riding.
        if (car.open && door && v > CAR_W / 2 - 0.1) { this.ride = null; this.rideFrame = null; return; }
        // Inside: the aisle between the benches, the vestibules at the doors.
        const vmax = door ? CAR_W / 2 - 0.3 : 0.6;
        r.v = Math.max(-vmax, Math.min(car.open && door ? CAR_W : vmax, v));
      }
      const [x, z] = this.carWorld(car, r.u, r.v);
      b.pos.set(x, car.y + CAR_FLOOR, z);
      b.vel.y = 0;
      b.grounded = true;
      this.rideFrame = { x: car.x, z: car.z, fx: car.dx, fz: car.dz };
      // The car's ceiling light (one of the pooled station lights: the light count never changes);
      // now and then it flickers at speed.
      const speed = Math.hypot(car.vx, car.vz);
      this.riding = { speed, accel: 0, x: car.x, y: car.y, z: car.z };
      if (this.flicker > 0) this.flicker--;
      else if (speed > 10 && Math.random() < 0.004) this.flicker = 3 + Math.floor(Math.random() * 6);
      const l = this.stationLights[1];
      l.position.set(car.x, car.y + CAR_H - 0.4, car.z);
      l.intensity = this.flicker > 0 && this.flicker % 2 === 0 ? 0.6 : 2.5;
      return;
    }
    // A train runs into anyone on its track (below its floor): shoved aside, thrown if it is moving.
    for (const c of this.cars) {
      if (Math.abs(c.x - b.pos.x) > 12 || Math.abs(c.z - b.pos.z) > 12) continue;
      const L = this.carLocal(c, b.pos.x, b.pos.y, b.pos.z);
      if (L.h > -0.3 || L.h + CAR_FLOOR + b.height < 0.1) continue;
      if (Math.abs(L.u) > CAR_L / 2 || Math.abs(L.v) > CAR_W / 2 + b.radius) continue;
      const side = Math.sign(L.v) || 1, push = CAR_W / 2 + b.radius + 0.05 - Math.abs(L.v);
      b.pos.x += -c.dz * side * push;
      b.pos.z += c.dx * side * push;
      const sp = Math.hypot(c.vx, c.vz);
      if (sp > 0.5) {
        b.vel.x = c.vx * 0.7 - c.dz * side * 3;
        b.vel.z = c.vz * 0.7 + c.dx * side * 3;
        b.vel.y = Math.max(b.vel.y, 2.5);
        b.grounded = false;
        this.onTrainHit?.(b.pos.x, b.pos.y, b.pos.z, sp);
      }
    }
  }
  /** A moving train hit the body (for sound / effects). */
  onTrainHit?: (x: number, y: number, z: number, speed: number) => void;

  /**
   * Train cars for the walker (not the car one rides in): solid boxes with the doors shut; with
   * the doors open, the walls (thin boxes) around the doorways on the platform side.
   */
  carObstacles(x0: number, z0: number, x1: number, z1: number, out: (o: Obstacle) => void): void {
    // (Also the solid things in the built side rooms: piers, machines, shelves, pillars.)
    for (const br of this.builtRooms.values()) for (const o of br.obstacles) {
      const r = o.cyl ? o.r : Math.hypot(o.hx, o.hz);
      if (o.x + r >= x0 && o.x - r <= x1 && o.z + r >= z0 && o.z - r <= z1) out(o);
    }
    const own = this.ridden();
    const wall = (c: TrainCar, u: number, v: number, hu: number, hv: number) => {
      const [x, z] = this.carWorld(c, u, v);
      out({ cyl: false, x, z, r: 0, hx: hu, hz: hv, ux: c.dx, uz: c.dz, y0: c.y + 0.1, y1: c.y + CAR_H });
    };
    for (const c of this.cars) {
      if (c === own || c.x < x0 - 10 || c.x > x1 + 10 || c.z < z0 - 10 || c.z > z1 + 10) continue;
      if (!c.open) { wall(c, 0, 0, CAR_L / 2 - 0.25, CAR_W / 2); continue; }
      const t = 0.06, hw = CAR_W / 2 - t;
      wall(c, 0, -hw, CAR_L / 2, t);
      wall(c, CAR_L / 2 - t, 0, t, CAR_W / 2);
      wall(c, -CAR_L / 2 + t, 0, t, CAR_W / 2);
      let u0 = -CAR_L / 2;
      for (const d of [...DOOR_U, CAR_L / 2 + DOOR_HW]) {
        const u1 = d - DOOR_HW;
        if (u1 > u0) wall(c, (u0 + u1) / 2, hw, (u1 - u0) / 2, t);
        u0 = d + DOOR_HW;
      }
    }
  }

  /** The hall (box index) whose platform the body stands on, or -1. */
  private platformAt(x: number, y: number, z: number): number {
    const n = this.near(x, z);
    if (!n.boxes.some((b) => b.kind === 'station')) return -1;
    return this.boxes.findIndex((b) => {
      if (b.kind !== 'station') return false;
      const h = boxAt(b, x, y + 0.3, z);
      return !!h && h.floor > b.y0 + 0.5 && Math.abs(y - h.floor) < 0.4;
    });
  }

  /** The dwelling car next to the body on its platform (to board), or null. */
  private boardable(): TrainCar | null {
    const b = this.body;
    if (!b || this.ride || b.flying || b.height > 2.4) return null;
    const bi = this.platformAt(b.pos.x, b.pos.y, b.pos.z);
    if (bi < 0) return null;
    const hall = this.boxes[bi];
    const line = this.macro.metroLines[hall.line ?? -1];
    if (!line) return null;
    const stop = line.stations.indexOf(hall.station ?? -1);
    // Anywhere on the platform beside the train (it reaches 7.7 m from the car side).
    let best: TrainCar | null = null, bd = 8;
    for (const c of this.cars) {
      if (c.line !== hall.line || !c.open || c.next !== stop) continue;
      const L = this.carLocal(c, b.pos.x, b.pos.y, b.pos.z);
      if (Math.abs(L.u) > CAR_L / 2 + 1) continue;
      const d = Math.abs(L.v) - CAR_W / 2;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  private terminus(line: MetroLine, dir: number): string {
    return this.stationNames.get(line.stations[dir > 0 ? line.stations.length - 1 : 0]) ?? '';
  }

  /** On-screen hint for the metro (boarding, riding, arriving trains), or null. */
  metroHint(): string | null {
    const b = this.body;
    if (!b) return null;
    const car = this.ridden();
    if (car) {
      const line = this.macro.metroLines[car.line];
      const name = this.stationNames.get(line.stations[car.next]) ?? '';
      if (car.open) return `<b>${name}</b> — walk out through the doors or press <b>E</b> to get off (departs in ${Math.ceil(car.left)} s)`;
      if (car.dwell) return `<b>${name}</b> — doors closing`;
      return `Line ${line.name} to ${this.terminus(line, car.dir)} — next stop <b>${name}</b>`;
    }
    const c = this.boardable();
    if (c) {
      const line = this.macro.metroLines[c.line];
      return `Line ${line.name} to ${this.terminus(line, c.dir)} — walk in or press <b>E</b> to board (departs in ${Math.ceil(c.left)} s)`;
    }
    const bi = this.platformAt(b.pos.x, b.pos.y, b.pos.z);
    if (bi < 0) return null;
    const hall = this.boxes[bi], line = this.macro.metroLines[hall.line ?? -1];
    if (!line) return null;
    const stop = line.stations.indexOf(hall.station ?? -1);
    // Trains for this platform side (they run on the right-hand track of their direction).
    const v = -(b.pos.x - hall.cx) * hall.uz + (b.pos.z - hall.cz) * hall.ux;
    for (const tr of trainsOn(line, this.time)) {
      if (Math.sign(v) !== tr.dir || tr.next !== stop) continue;
      if (tr.dwell) return `Line ${line.name} to ${this.terminus(line, tr.dir)} is at the platform`;
      if (Math.abs(tr.s - line.stationS[stop]) < 450) return `Line ${line.name} to ${this.terminus(line, tr.dir)} — train arriving`;
    }
    return `Platform — line ${line.name} to ${this.terminus(line, Math.sign(v) || 1)}`;
  }

  /** E on the metro: board the dwelling train next to the body, or get off at a station. Returns true if handled. */
  metroKey(): boolean {
    const b = this.body;
    if (!b) return false;
    const car = this.ridden();
    if (car) {
      if (!car.open) return true; // no getting off with the doors shut
      // Step out through the nearest door onto the platform.
      const r = this.ride!;
      const d = DOOR_U.reduce((p, q) => (Math.abs(q - r.u) < Math.abs(p - r.u) ? q : p));
      const [x, z] = this.carWorld(car, d, CAR_W / 2 + 0.6);
      b.pos.set(x, car.y + CAR_FLOOR, z);
      b.vel.set(0, 0, 0);
      this.ride = null;
      this.rideFrame = null;
      return true;
    }
    const c = this.boardable();
    if (!c) return false;
    const L = this.carLocal(c, b.pos.x, b.pos.y, b.pos.z);
    this.ride = { line: c.line, k: c.k, slot: c.slot, u: DOOR_U.reduce((p, q) => (Math.abs(q - L.u) < Math.abs(p - L.u) ? q : p)), v: 0 };
    this.rideFrame = null;
    b.vel.set(0, 0, 0);
    this.carryBody();
    return true;
  }

  /** Inside the ridden car (for the camera boom and the floor). */
  private inRiddenCar(x: number, y: number, z: number, margin: number): boolean | null {
    const c = this.ridden();
    if (!c) return null;
    const L = this.carLocal(c, x, y, z);
    return Math.abs(L.u) < CAR_L / 2 - 0.3 - margin && Math.abs(L.v) < CAR_W / 2 - 0.1 - margin && L.h > margin - 0.05 && L.h < CAR_H - CAR_FLOOR - 0.4 - margin;
  }

  /** Trains approaching a point (for sounds/collision): returns nearest car distance. */
  nearestTrain(x: number, y: number, z: number): number {
    let best = Infinity;
    for (const c of this.cars) best = Math.min(best, Math.hypot(c.x - x, c.y - y, c.z - z));
    return best;
  }
}

export interface TrainCar {
  line: number;
  /** Train index on its line. */
  k: number;
  /** Physical position in the train (−1.5 … 1.5 car lengths along the tube direction). */
  slot: number;
  dir: number;
  /** Centre on the track bed, heading (direction of travel). */
  x: number; y: number; z: number; dx: number; dz: number;
  vx: number; vz: number;
  dwell: boolean;
  /** Seconds left in the dwell. */
  left: number;
  /** Doors open (platform side). */
  open: boolean;
  /** Index (in line.stations) of the stop dwelt at or next. */
  next: number;
  s: number;
}

const FULL: [number, number][] = [[0, 1]];
const _col = new THREE.Color();
const _m4b = new THREE.Matrix4(), _m4c = new THREE.Matrix4();

/**
 * Parameter intervals [t0, t1] along a section quad (A,B at t=0; D,C at t=1)
 * that are NOT inside another sewer. Walls and vaults are removed wherever
 * they pass through a crossing tube; floors only by the lower-priority tube so
 * exactly one floor remains at a junction.
 */
function keptPieces(others: { o: Tube; idx: number }[], myIdx: number, A: number[], B: number[], C: number[], D: number[], floor: boolean): [number, number][] {
  // Conservative: a piece goes only where both long edges of the strip are inside,
  // so junction seams overlap (hidden above the other vault) instead of leaving gaps.
  const ea = insideIntervals(others, myIdx, A, D, floor);
  if (!ea.length) return FULL;
  const eb = insideIntervals(others, myIdx, B, C, floor);
  const cut: [number, number][] = [];
  for (const [a0, a1] of ea) for (const [b0, b1] of eb) {
    const lo = Math.max(a0, b0), hi = Math.min(a1, b1);
    if (hi - lo > 1e-4) cut.push([lo, hi]);
  }
  if (!cut.length) return FULL;
  cut.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let t = 0;
  for (const [a, b] of cut) {
    if (a > t + 1e-4) out.push([t, a]);
    t = Math.max(t, b);
  }
  if (t < 1 - 1e-4) out.push([t, 1]);
  return out;
}

/** Merged parameter intervals of the line P→Q that lie inside other sewers. */
function insideIntervals(others: { o: Tube; idx: number }[], myIdx: number, P0: number[], P1: number[], floor: boolean): [number, number][] {
  const m0x = P0[0], m0y = P0[1], m0z = P0[2];
  const m1x = P1[0], m1y = P1[1], m1z = P1[2];
  const cut: [number, number][] = [];
  for (const { o, idx } of others) {
    if (floor && idx > myIdx) continue; // the earlier tube keeps its floor
    const Q = o.pts;
    for (let j = 0; j + 5 < Q.length; j += 3) {
      const ax = Q[j], az = Q[j + 2], dx = Q[j + 3] - ax, dz = Q[j + 5] - az;
      const L = Math.hypot(dx, dz);
      if (L < 1e-6) continue;
      const ex = dx / L, ez = dz / L;
      // u(t) along the other segment, lat(t) across it: both linear in t.
      const u0 = (m0x - ax) * ex + (m0z - az) * ez, u1 = (m1x - ax) * ex + (m1z - az) * ez;
      const l0 = (m0z - az) * ex - (m0x - ax) * ez, l1 = (m1z - az) * ex - (m1x - ax) * ez;
      let lo = 0, hi = 1;
      const clampLin = (a: number, b: number, min: number, max: number) => {
        // keep t where min < a + (b - a) t < max
        const d = b - a;
        if (Math.abs(d) < 1e-9) { if (a <= min || a >= max) hi = -1; return; }
        let t0 = (min - a) / d, t1 = (max - a) / d;
        if (t0 > t1) [t0, t1] = [t1, t0];
        lo = Math.max(lo, t0); hi = Math.min(hi, t1);
      };
      clampLin(u0, u1, 0, L);
      const w = o.halfWidth - 0.02;
      clampLin(l0, l1, -w, w);
      if (hi - lo < 1e-4) continue;
      // How far below the other tube's vault the strip runs at t (concave in t).
      const f = (tt: number) => {
        const lat = l0 + (l1 - l0) * tt, uu = (u0 + (u1 - u0) * tt) / L;
        const fl = Q[j + 1] + (Q[j + 4] - Q[j + 1]) * uu;
        const r = Math.min(1, Math.abs(lat) / o.halfWidth);
        const top = fl + 1.6 + (o.height - 1.6) * Math.sqrt(1 - r * r);
        const y = m0y + (m1y - m0y) * tt;
        return floor ? 0.6 - Math.abs(y - fl) : Math.min(top - 0.02 - y, y - fl + 0.6);
      };
      // The inside part is a single interval: find the peak, then both edges.
      let a = lo, b = hi;
      for (let it = 0; it < 30; it++) { const m1 = a + (b - a) / 3, m2 = b - (b - a) / 3; if (f(m1) < f(m2)) a = m1; else b = m2; }
      const tp = (a + b) / 2;
      if (f(tp) <= 0) continue;
      let x0 = lo, x1 = tp;
      if (f(lo) <= 0) for (let it = 0; it < 30; it++) { const m = (x0 + x1) / 2; if (f(m) > 0) x1 = m; else x0 = m; } else x1 = lo;
      const left = x1;
      x0 = tp; x1 = hi;
      if (f(hi) <= 0) for (let it = 0; it < 30; it++) { const m = (x0 + x1) / 2; if (f(m) > 0) x0 = m; else x1 = m; } else x0 = hi;
      lo = left; hi = x0;
      cut.push([lo, hi]);
    }
  }
  cut.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const c of cut) {
    const last = out[out.length - 1];
    if (last && c[0] <= last[1]) last[1] = Math.max(last[1], c[1]); else out.push([c[0], c[1]]);
  }
  return out;
}

/**
 * A face's parameter range [ta, tb] along a tube segment (arc s0..s1) split at side-room
 * doorways: [t0, t1, top] pieces, top = -Infinity outside the doorways (the face stays whole).
 */
function splitDoors(ta: number, tb: number, doors: { s0: number; s1: number; top: number }[], s0: number, s1: number): [number, number, number][] {
  const L = Math.max(1e-6, s1 - s0);
  const cuts = [ta, tb];
  for (const d of doors) for (const s of [d.s0, d.s1]) { const t = (s - s0) / L; if (t > ta && t < tb) cuts.push(t); }
  cuts.sort((a, b) => a - b);
  const out: [number, number, number][] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const a = cuts[k], b = cuts[k + 1];
    if (b - a < 1e-5) continue;
    const sm = s0 + ((a + b) / 2) * L;
    let top = -Infinity;
    for (const d of doors) if (sm > d.s0 && sm < d.s1) top = Math.max(top, d.top);
    out.push([a, b, top]);
  }
  return out;
}

function dirAt(P: number[], i: number): [number, number] {
  const n = P.length / 3;
  const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
  const dx = P[b * 3] - P[a * 3], dz = P[b * 3 + 2] - P[a * 3 + 2];
  const l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
}

function arch(hw: number, y0: number, h: number, n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 1; k < n; k++) {
    const a = (k / n) * Math.PI;
    out.push([Math.cos(a) * hw, y0 + Math.sin(a) * (h - y0)]);
  }
  out.push([-hw, 1.6]);
  return out;
}

function quadFlat(mb: MeshBuilder, ax: number, ay: number, az: number, bx: number, by: number, bz: number, d0: [number, number], d1: [number, number], l0: number, l1: number): void {
  const i0 = mb.v(ax - d0[1] * l0, ay, az + d0[0] * l0, 0, 1, 0, ax, az);
  mb.v(ax - d0[1] * l1, ay, az + d0[0] * l1, 0, 1, 0, ax + 1, az);
  mb.v(bx - d1[1] * l1, by, bz + d1[0] * l1, 0, 1, 0, bx + 1, bz);
  mb.v(bx - d1[1] * l0, by, bz + d1[0] * l0, 0, 1, 0, bx, bz);
  mb.quad(i0, i0 + 1, i0 + 2, i0 + 3);
  mb.quad(i0, i0 + 3, i0 + 2, i0 + 1);
}

function wallQuad(mb: MeshBuilder, a: [number, number, number], c: [number, number, number], h: number, _sv: number, _b: Box, _su = 0): void {
  const L = Math.hypot(c[0] - a[0], c[2] - a[2]);
  const nx = -(c[2] - a[2]) / L, nz = (c[0] - a[0]) / L;
  const i0 = mb.v(a[0], a[1], a[2], nx, 0, nz, 0, 0);
  mb.v(c[0], c[1], c[2], nx, 0, nz, L, 0);
  mb.v(c[0], c[1] + h, c[2], nx, 0, nz, L, h);
  mb.v(a[0], a[1] + h, a[2], nx, 0, nz, 0, h);
  mb.quad(i0, i0 + 1, i0 + 2, i0 + 3);
  mb.quad(i0, i0 + 3, i0 + 2, i0 + 1);
}

/** Door leaves of one side of a car (local +x); they slide along the car to open. */
function doorLeafGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const d of DOOR_U) parts.push(new THREE.BoxGeometry(0.04, 1.9, DOOR_HW * 2).translate(1.475, CAR_FLOOR + 0.95, d));
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal']) {
    const arr: number[] = [];
    for (const p of parts) arr.push(...(p.toNonIndexed().getAttribute(name).array as Float32Array));
    g.setAttribute(name, new THREE.Float32BufferAttribute(arr, 3));
  }
  return g;
}

/** A metro carriage (18 m): walls with doorways, line-colour stripe, windows, benches and lights inside. */
function trainCarGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (w: number, h: number, d: number, x: number, y: number, z: number, col: [number, number, number], stripe = 0) => {
    const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
    g.translate(x, y, z);
    const n = g.getAttribute('position').count;
    const c = new Float32Array(n * 3), s = new Float32Array(n);
    for (let i = 0; i < n; i++) { c.set(col, i * 3); s[i] = stripe; }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.setAttribute('aStripe', new THREE.BufferAttribute(s, 1));
    parts.push(g);
  };
  // Pieces along the car with gaps at the doorways.
  const run = (w: number, h: number, x: number, y: number, z0: number, z1: number, col: [number, number, number], stripe = 0, gaps = true) => {
    let a = z0;
    for (const d of gaps ? [...DOOR_U, Infinity] : [Infinity]) {
      const b = Math.min(z1, d - DOOR_HW);
      if (b > a) add(w, h, b - a, x, y, (a + b) / 2, col, stripe);
      a = Math.max(a, d + DOOR_HW);
    }
  };
  const L2 = CAR_L / 2 - 0.25, body: [number, number, number] = [0.82, 0.83, 0.85], top = CAR_FLOOR + 1.9;
  for (const sx of [-1, 1]) {
    // Side walls: below and above the window band (WIN_Y0 … WIN_Y1), pillars between the panes.
    run(0.06, WIN_Y0 - 0.45, sx * 1.42, (0.45 + WIN_Y0) / 2, -L2, L2, body);
    run(0.06, 3.05 - WIN_Y1, sx * 1.42, (WIN_Y1 + 3.05) / 2, -L2, L2, body);
    for (const [a, b] of windowBays(L2)) {
      for (const u of [a, b]) add(0.06, WIN_Y1 - WIN_Y0, 0.2, sx * 1.42, (WIN_Y0 + WIN_Y1) / 2, u === a ? u + 0.1 : u - 0.1, body);
      const panes = Math.max(1, Math.round((b - a) / 2.3));
      for (let k = 1; k < panes; k++) add(0.06, WIN_Y1 - WIN_Y0, 0.12, sx * 1.42, (WIN_Y0 + WIN_Y1) / 2, a + ((b - a) * k) / panes, body);
    }
    run(0.02, 0.35, sx * 1.46, 1.15, -L2, L2, [1, 1, 1], 1);                       // line stripe
    for (const d of DOOR_U) {
      add(0.06, 3.05 - top, DOOR_HW * 2, sx * 1.42, (top + 3.05) / 2, d, body);   // over the door
      add(0.06, CAR_FLOOR - 0.45, DOOR_HW * 2, sx * 1.42, (CAR_FLOOR + 0.45) / 2, d, body); // under it
    }
  }
  // Ends, with a window (the view down the tunnel from the first and last car).
  for (const sz of [-1, 1]) {
    const z = sz * (L2 - 0.03);
    add(2.9, WIN_Y0 - 0.45, 0.06, 0, (0.45 + WIN_Y0) / 2, z, body);
    add(2.9, 3.05 - WIN_Y1, 0.06, 0, (WIN_Y1 + 3.05) / 2, z, body);
    for (const sx of [-1, 1]) add(1.45 - END_WIN, WIN_Y1 - WIN_Y0, 0.06, sx * (1.45 + END_WIN) / 2, (WIN_Y0 + WIN_Y1) / 2, z, body);
  }
  add(2.9, 0.1, CAR_L - 0.5, 0, 3.1, 0, [0.75, 0.75, 0.77]);                         // ceiling
  add(2.6, 0.5, 17.6, 0, 0.35, 0, [0.15, 0.15, 0.16]);                               // underframe
  add(2.5, 0.25, 17.6, 0, 3.2, 0, [0.7, 0.7, 0.72]);                                 // roof
  // Inside: floor level with the platform, bench rows along the walls (not across the doorways), light strip.
  add(2.84, 0.06, CAR_L - 0.5, 0, CAR_FLOOR - 0.03, 0, [0.18, 0.19, 0.2]);
  for (const x of [-1.12, 1.12]) {
    run(0.5, 0.42, x, CAR_FLOOR + 0.21, -8.1, 8.1, [0.25, 0.32, 0.5]);
    run(0.12, 0.5, x * 1.17, CAR_FLOOR + 0.65, -8.1, 8.1, [0.25, 0.32, 0.5]);
  }
  add(0.5, 0.04, 16, 0, 3.03, 0, [1, 0.98, 0.9]);
  const merged = mergeGeos(parts);
  merged.computeVertexNormals();
  return merged;
}

/** Window band of a carriage (height over the car's base) and the half width of the end windows. */
const WIN_Y0 = 1.7, WIN_Y1 = 2.6, END_WIN = 0.85;

/** Wall stretches between the doorways (car-local u), where the side windows go. */
function windowBays(L2: number): [number, number][] {
  const out: [number, number][] = [];
  let a = -L2;
  for (const d of [...DOOR_U, Infinity]) {
    const b = Math.min(L2, d - DOOR_HW);
    if (b - a > 0.8) out.push([a, b]);
    a = Math.max(a, d + DOOR_HW);
  }
  return out;
}

/** The glass of a carriage's windows (side panes and both ends), drawn with a see-through material. */
function trainGlassGeometry(): THREE.BufferGeometry {
  const gs: THREE.BufferGeometry[] = [];
  const L2 = CAR_L / 2 - 0.25, h = WIN_Y1 - WIN_Y0, y = (WIN_Y0 + WIN_Y1) / 2;
  for (const sx of [-1, 1]) for (const [a, b] of windowBays(L2)) {
    const g = new THREE.PlaneGeometry(b - a, h);
    g.rotateY(Math.PI / 2);
    g.translate(sx * 1.42, y, (a + b) / 2);
    gs.push(g.toNonIndexed());
  }
  for (const sz of [-1, 1]) {
    const g = new THREE.PlaneGeometry(END_WIN * 2, h);
    g.translate(0, y, sz * (L2 - 0.03));
    gs.push(g.toNonIndexed());
  }
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal']) {
    const parts = gs.map((g) => g.getAttribute(name).array as Float32Array);
    const arr = new Float32Array(parts.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of parts) { arr.set(a, o); o += a.length; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, 3));
  }
  return out;
}

function mergeGeos(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'color', 'aStripe']) {
    const size = gs[0].getAttribute(name).itemSize;
    const total = gs.reduce((a, g) => a + g.getAttribute(name).count, 0);
    const arr = new Float32Array(total * size);
    let o = 0;
    for (const g of gs) { const a = g.getAttribute(name).array as Float32Array; arr.set(a, o); o += a.length; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  return out;
}

const BOARD_W = 3.3, BOARD_H = 0.66;

interface Board {
  /** Hall box index and the built object it belongs to (gone or rebuilt: the board is dropped). */
  bi: number; owner: THREE.Object3D;
  /** Train direction served by this platform side. */
  dir: number; line: MetroLine; stop: number; x: number; z: number;
  canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; mat: THREE.MeshStandardMaterial; key: string;
}

/** A dot-matrix style departure board: line chip, destination and minutes; the train after below. */
function drawBoard(c: HTMLCanvasElement, line: string, color: string, dest: string, when: string, then: string): void {
  const g = c.getContext('2d')!;
  const W = c.width, H = c.height;
  g.fillStyle = '#0a0d11'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#2a3440'; g.lineWidth = 6; g.strokeRect(3, 3, W - 6, H - 6);
  g.fillStyle = color;
  g.beginPath(); g.arc(46, 48, 26, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffffff'; g.font = 'bold 30px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(line, 46, 50);
  g.fillStyle = '#ffb43a'; g.textAlign = 'left'; g.font = 'bold 34px ui-monospace, Consolas, monospace';
  const room = W - 86 - g.measureText(when).width - 44;
  let d = dest;
  while (g.measureText(d).width > room && d.length > 4) d = d.slice(0, -2) + '…';
  g.fillText(d, 86, 50);
  g.textAlign = 'right';
  g.fillText(when, W - 20, 50);
  g.fillStyle = '#b8862c'; g.font = 'bold 24px ui-monospace, Consolas, monospace';
  g.fillText(then, W - 20, 98);
}

function signTexture(name: string, colors: number[]): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 220;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1b2a4a'; g.fillRect(0, 0, 1024, 220);
  g.fillStyle = '#ffffff'; g.font = 'bold 110px sans-serif'; g.textBaseline = 'middle';
  g.fillText(name, 200, 115);
  colors.forEach((col, i) => {
    g.fillStyle = '#' + col.toString(16).padStart(6, '0');
    g.beginPath(); g.arc(90 + i * 0, 110, 70, 0, Math.PI * 2); g.fill();
  });
  g.fillStyle = '#ffffff'; g.font = 'bold 90px sans-serif'; g.fillText('M', 52, 116);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}



/** Height of the grime band at the foot of the sewer walls (m over the walkway). */
const GRIME = 0.45;

/** A sewer trunk's look: walls, pipes, ribs, lighting, outlets (deterministic per trunk). */
interface SewerStyle {
  seed: number;
  layer: number;
  ribLayer: number;
  tint: readonly [number, number, number];
  grime: readonly [number, number, number];
  walk: readonly [number, number, number];
  channel: readonly [number, number, number];
  rib: readonly [number, number, number];
  ribEvery: number;
  lightEvery: number;
  dead: number;
  outletFirst: number;
  outletEvery: number;
  pipes: { side: number; y: number; r: number; tint: readonly [number, number, number] }[];
}

function hash01(n: number): number {
  let h = Math.imul((n | 0) ^ 0x27d4eb2d, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca77);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

function sewerStyle(idx: number, culvert: boolean): SewerStyle {
  const r = (k: number) => hash01(idx * 97 + k);
  // Old red brick, yellow brick, dark engineering brick, or concrete (culverts, newer trunks).
  const kind = culvert ? 3 : Math.floor(r(1) * 10) < 4 ? 0 : Math.floor(r(1) * 10) < 6 ? 1 : Math.floor(r(1) * 10) < 8 ? 2 : 3;
  const base: [number, number, number] = kind === 0 ? [0.8, 0.74, 0.7] : kind === 1 ? [0.85, 0.82, 0.76] : kind === 2 ? [0.62, 0.58, 0.56] : [0.66, 0.66, 0.63];
  const v = 0.9 + r(2) * 0.2;
  const tint: [number, number, number] = [base[0] * v, base[1] * v, base[2] * v];
  const moss = r(3);
  const grime: [number, number, number] = [tint[0] * 0.42, tint[1] * (0.42 + moss * 0.08), tint[2] * 0.34];
  const pipeTints: [number, number, number][] = [[0.16, 0.12, 0.09], [0.1, 0.11, 0.12], [0.14, 0.17, 0.11], [0.24, 0.12, 0.07]];
  const pipes: SewerStyle['pipes'] = [];
  const np = r(4) < 0.2 ? 0 : r(4) < 0.65 ? 1 : 2;
  const side = r(5) < 0.5 ? -1 : 1;
  if (np >= 1) pipes.push({ side, y: 1.2 + r(6) * 0.15, r: 0.07 + r(7) * 0.04, tint: pipeTints[Math.floor(r(8) * 4)] });
  if (np >= 2) pipes.push(r(9) < 0.5 ? { side, y: 0.85, r: 0.06, tint: pipeTints[Math.floor(r(10) * 4)] } : { side: -side, y: 1.3, r: 0.09, tint: pipeTints[Math.floor(r(11) * 4)] });
  return {
    // Facade layers: 0 red brick, 2 yellow brick, 1 brown (Flemish) brick, 8 concrete.
    seed: idx * 7 + 3, layer: [0, 2, 1, 8][kind], ribLayer: kind === 3 ? 8 : 4, tint, grime,
    walk: [tint[0] * 0.8, tint[1] * 0.78, tint[2] * 0.75], channel: [tint[0] * 0.35, tint[1] * 0.38, tint[2] * 0.33],
    rib: kind === 3 ? [0.58, 0.58, 0.56] : [0.62, 0.6, 0.56],
    ribEvery: kind === 3 ? 6 : r(12) < 0.45 ? 0 : 7 + Math.floor(r(13) * 3) * 2,
    lightEvery: kind === 2 ? 16 : 10 + Math.floor(r(14) * 3) * 2, dead: 0.08 + r(15) * 0.2,
    outletFirst: 9 + r(16) * 15, outletEvery: 22 + r(17) * 18, pipes,
  };
}

/** The point at arc length s along a tube's centreline (floor level) and its unit direction. */
function pointOnTube(t: Tube, s: number): { x: number; y: number; z: number; dx: number; dz: number } | null {
  const n = t.cum.length;
  if (n < 2 || s < 0 || s > t.cum[n - 1]) return null;
  let i = 0;
  while (i < n - 2 && t.cum[i + 1] < s) i++;
  const L = t.cum[i + 1] - t.cum[i] || 1, u = (s - t.cum[i]) / L, P = t.pts;
  const dx = P[i * 3 + 3] - P[i * 3], dz = P[i * 3 + 5] - P[i * 3 + 2], dl = Math.hypot(dx, dz) || 1;
  return { x: P[i * 3] + dx * u, y: P[i * 3 + 1] + (P[i * 3 + 4] - P[i * 3 + 1]) * u, z: P[i * 3 + 2] + dz * u, dx: dx / dl, dz: dz / dl };
}

/** A round pipe (an n-sided prism with smooth normals) from A to B, without end caps. */
function pipe(mb: MeshBuilder, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, n = 8): void {
  let dx = bx - ax, dy = by - ay, dz = bz - az;
  const L = Math.hypot(dx, dy, dz);
  if (L < 1e-4) return;
  dx /= L; dy /= L; dz /= L;
  // u ⟂ axis (horizontal unless the pipe is vertical), w = axis × u.
  let ux = -dz, uy = 0, uz = dx;
  if (Math.hypot(ux, uz) < 1e-3) { ux = 1; uz = 0; }
  const ul = Math.hypot(ux, uy, uz); ux /= ul; uz /= ul;
  const wx = dy * uz - dz * uy, wy = dz * ux - dx * uz, wz = dx * uy - dy * ux;
  let base = -1;
  for (let k = 0; k <= n; k++) {
    const a = (k / n) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    const nx = ux * c + wx * s, ny = uy * c + wy * s, nz = uz * c + wz * s;
    const i = mb.v(ax + nx * r, ay + ny * r, az + nz * r, nx, ny, nz, (k / n) * r * 6.3, 0);
    if (base < 0) base = i;
    mb.v(bx + nx * r, by + ny * r, bz + nz * r, nx, ny, nz, (k / n) * r * 6.3, L);
  }
  for (let k = 0; k < n; k++) mb.quad(base + k * 2, base + k * 2 + 2, base + k * 2 + 3, base + k * 2 + 1);
}
