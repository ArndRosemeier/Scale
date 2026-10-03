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
import { makeTube, makeBox, tubeAt, tubeInterior, boxAt, type Tube, type Box } from './Volumes';
import { STATION_HALF, ENTRANCE_L, ENTRANCE_W } from '../plan/cell';
import { pointInPoly } from '../core/geom2';
import { G } from '../render/materials/globals';

const TUNNEL_HW = 4.3;
const TUNNEL_H = 6.0;
const STATION_HW = 11;
const STATION_H = 7.5;
const PLATFORM_H = 1.05;
const SEWER_HW = 1.7;
const SEWER_H = 2.8;
const BUILD_R = 380;

export interface Entrance { x: number; z: number; ux: number; uz: number; station: number; end: number; passage: Tube | null; /** descent direction */ dx: number; dz: number; cell: number }

export class Underground {
  readonly group = new THREE.Group();
  readonly tubes: Tube[] = [];
  readonly boxes: Box[] = [];
  readonly entrances = new Map<string, Entrance>();
  private stationY = new Map<number, number>();
  private built = new Map<string, THREE.Object3D>();
  private mat: THREE.MeshStandardMaterial;
  /** Murky sewer water: no sky reflection down here. */
  private waterMat = (() => { const m = createWaterMaterial(true); m.envMapIntensity = 0.04; m.roughness = 0.12; return m; })();
  private safetyMat = new THREE.MeshStandardMaterial({ color: 0xd9b21a, roughness: 0.6 });
  private lightMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff4e0, emissiveIntensity: 0.9 });
  private trainMesh: THREE.InstancedMesh;
  private trainColor: THREE.InstancedBufferAttribute;
  private headlamp = new THREE.SpotLight(0xfff2dd, 0, 30, 0.7, 0.8, 1.5);
  private stationLights: THREE.PointLight[] = [];
  private sewerTubes: Tube[] = [];
  private lastBuildPos = new THREE.Vector3(1e9, 0, 0);
  /** Hole rectangles (cx, cz, ux, uz, hw, hl) for the terrain shader / ground queries. */
  holes: number[] = [];
  openManholes: { x: number; z: number }[] = [];
  stationNames = new Map<number, string>();
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
    for (const line of macro.metroLines) this.tubes.push(this.lineTube(line));
    for (const st of macro.metroStations) {
      const y = terrain.height(st.x, st.z) - st.depth;
      this.stationY.set(st.id, y);
      this.boxes.push(makeBox('station', st.x, st.z, y, y + STATION_H, st.angle, STATION_HALF, STATION_HW, [[-STATION_HW, -STATION_HW + 4.2, PLATFORM_H], [STATION_HW - 4.2, STATION_HW, PLATFORM_H]]));
      this.stationNames.set(st.id, st.name);
    }
    // Sewers under the arterials (not bridges).
    for (const sw of macro.sewers) {
      const pts: number[] = [];
      for (let i = 0; i < sw.pts.length; i += 2) {
        const x = sw.pts[i], z = sw.pts[i + 1];
        pts.push(x, terrain.height(x, z) - 4.6, z);
      }
      // Smooth the invert so it never climbs steeply.
      for (let it = 0; it < 4; it++) for (let i = 3; i + 3 < pts.length; i += 3) pts[i + 1] = (pts[i - 2] + pts[i + 1] * 2 + pts[i + 4]) / 4;
      const t = makeTube('sewer', pts, SEWER_HW, SEWER_H, 0.6, 0.45);
      this.tubes.push(t);
      this.sewerTubes.push(t);
    }
    // Trains: one instanced mesh of carriages.
    const carGeo = trainCarGeometry();
    this.trainColor = new THREE.InstancedBufferAttribute(new Float32Array(400 * 3), 3);
    carGeo.setAttribute('iLine', this.trainColor);
    const trainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.5 });
    trainMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 iLine;\nattribute float aStripe;')
        .replace('#include <color_vertex>', '#include <color_vertex>\nvColor.rgb = mix(vColor.rgb, iLine, aStripe);');
    };
    this.trainMesh = new THREE.InstancedMesh(carGeo, trainMat, 400);
    this.trainMesh.count = 0;
    this.trainMesh.frustumCulled = false;
    this.trainMesh.castShadow = false;
    this.group.add(this.trainMesh);
  }

  private lineTube(line: MetroLine): Tube {
    const pts: number[] = [];
    for (let i = 0, k = 0; i < line.pts.length; i += 2, k++) {
      const x = line.pts[i], z = line.pts[i + 1];
      pts.push(x, this.terrain.height(x, z) - line.depth[Math.min(k, line.depth.length - 1)], z);
    }
    // Stations are flat: pin the track level to the station floor near stations, then smooth.
    for (let i = 0; i < pts.length; i += 3) {
      for (const sid of line.stations) {
        const st = this.macro.metroStations[sid];
        const d = Math.hypot(pts[i] - st.x, pts[i + 2] - st.z);
        if (d < STATION_HALF + 20) {
          const sy = this.terrain.height(st.x, st.z) - st.depth;
          const w = Math.min(1, Math.max(0, (STATION_HALF + 20 - d) / 20));
          pts[i + 1] = pts[i + 1] * (1 - w) + sy * w;
        }
      }
    }
    for (let it = 0; it < 6; it++) for (let i = 3; i + 3 < pts.length; i += 3) pts[i + 1] = (pts[i - 2] + pts[i + 1] * 2 + pts[i + 4]) / 4;
    return makeTube('metro', pts, TUNNEL_HW, TUNNEL_H);
  }

  /** Register metro entrances of a loaded cell (from its plan). */
  addCell(cs: CellState): void {
    this.placeManholes(cs.id);
    const E = cs.plan?.entrances;
    if (!E) return;
    for (let i = 0; i < E.length; i += 6) {
      const key = `${E[i + 4]}:${E[i + 5]}`;
      if (this.entrances.has(key)) continue;
      const st = this.macro.metroStations[E[i + 4]];
      const sy = this.stationY.get(st.id)! + PLATFORM_H;
      const end = E[i + 5] ? 1 : -1;
      const ax = Math.cos(st.angle), az = Math.sin(st.angle);
      // Passage: from the street opening down to the platform end (side platform nearest).
      const gx = E[i], gz = E[i + 1];
      const gy = this.ground(gx, gz);
      const px = st.x + ax * end * (STATION_HALF - 3), pz = st.z + az * end * (STATION_HALF - 3);
      // Lateral platform side closest to the entrance.
      const lat = (-(gx - st.x) * az + (gz - st.z) * ax) >= 0 ? 1 : -1;
      const tx = px + -az * lat * (STATION_HW - 2), tz = pz + ax * lat * (STATION_HW - 2);
      // Start the slope at the far end of the opening so the stair is inside the hole.
      const ux = E[i + 2], uz = E[i + 3];
      const sgnU = (tx - gx) * ux + (tz - gz) * uz >= 0 ? 1 : -1;
      const sx = gx - ux * sgnU * ENTRANCE_L / 2, sz = gz - uz * sgnU * ENTRANCE_L / 2;
      const ox = gx + ux * sgnU * ENTRANCE_L / 2, oz = gz + uz * sgnU * ENTRANCE_L / 2;
      const pts = [sx, gy, sz, ox, gy - ENTRANCE_L * 0.55, oz, tx, sy, tz];
      const passage = makeTube('passage', pts, ENTRANCE_W / 2 + 0.2, 3.2);
      this.tubes.push(passage);
      this.entrances.set(key, { x: gx, z: gz, ux, uz, station: st.id, end: E[i + 5], passage, dx: ux * sgnU, dz: uz * sgnU, cell: cs.id });
      this.onEntrance?.(this.entrances.get(key)!);
      this.holes.push(gx, gz, ux, uz, ENTRANCE_W / 2, ENTRANCE_L / 2);
    }
  }

  // ------------------------------------------------------------ queries

  /** Underground floor at a point if the point is inside an underground volume, else null. */
  floorAt(x: number, y: number, z: number): number | null {
    let best: number | null = null;
    for (const t of this.tubes) {
      if (t.kind === 'sewer' && !this.sewerOpen(t, x, z, y)) continue;
      const h = tubeAt(t, x, y, z);
      if (h && h.floor <= y + 0.6 && (best === null || h.floor > best)) best = h.floor;
    }
    for (const b of this.boxes) {
      const h = boxAt(b, x, y, z);
      if (h && h.floor <= y + 0.6 && (best === null || h.floor > best)) best = h.floor;
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
      const u = dx * H[i + 2] + dz * H[i + 3], v = -dx * H[i + 3] + dz * H[i + 2];
      if (Math.abs(u) < H[i + 5] && Math.abs(v) < H[i + 4]) return true;
    }
    for (const m of this.openManholes) if (Math.hypot(x - m.x, z - m.z) < 0.4) return true;
    return false;
  }

  /** Inside any volume (with margin)? Used to keep bodies inside tunnels. */
  contains(x: number, y: number, z: number, margin: number): boolean {
    for (const t of this.tubes) if (tubeAt(t, x, y, z, -margin)) return true;
    for (const b of this.boxes) if (boxAt(b, x, y, z, -margin)) return true;
    return false;
  }

  /** Strict interior test for the camera boom (vaults, vertical margins). */
  cameraFree(x: number, y: number, z: number, margin: number): boolean {
    for (const t of this.tubes) if (tubeInterior(t, x, y, z, margin)) return true;
    for (const b of this.boxes) if (boxAt(b, x, y, z, -margin) && y > b.y0 + margin && y < b.y1 - margin) return true;
    return false;
  }

  isUnder(x: number, y: number, z: number): boolean {
    return y < this.ground(x, z) - 1.2 && this.floorAt(x, y, z) !== null;
  }

  /** Manhole lids above the sewers (placed per loaded cell, every ~45 m along each trunk). */
  private manholes = new Map<number, { x: number; z: number; tube: Tube }[]>();
  /** Lids per cell (generated once; re-announced whenever the cell's props are rebuilt). */
  private manholeCells = new Map<number, { x: number; z: number; yaw: number }[]>();
  /** A manhole lid was placed (the game adds the visible lid prop). */
  onManhole?: (cell: number, x: number, z: number, yaw: number) => void;

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
    const SPACING = 45;
    for (const t of this.sewerTubes) {
      const P = t.pts, C = t.cum;
      const n = P.length / 3;
      const total = C[n - 1];
      for (let s = SPACING * 0.5; s < total; s += SPACING) {
        let i = 0;
        while (i < n - 2 && C[i + 1] < s) i++;
        const f = (s - C[i]) / Math.max(1e-6, C[i + 1] - C[i]);
        const x = P[i * 3] + (P[i * 3 + 3] - P[i * 3]) * f, z = P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * f;
        if (!pointInPoly(poly, x, z)) continue;
        const key = Math.floor(x / 32) * 65536 + Math.floor(z / 32);
        let l = this.manholes.get(key);
        if (!l) this.manholes.set(key, (l = []));
        if (l.some((m) => Math.hypot(m.x - x, m.z - z) < 10)) continue;
        l.push({ x, z, tube: t });
        out.push({ x, z, yaw: Math.atan2(P[i * 3 + 3] - P[i * 3], P[i * 3 + 5] - P[i * 3 + 2]) });
      }
    }
    return out;
  }

  /** Every placed manhole lid (cells loaded so far), e.g. for the map. */
  forEachManhole(fn: (x: number, z: number) => void): void {
    for (const l of this.manholes.values()) for (const m of l) fn(m.x, m.z);
  }

  /** Nearest manhole lid within r (for E and hints). */
  nearestManhole(x: number, z: number, r: number): { x: number; z: number; tube: Tube } | null {
    let best: { x: number; z: number; tube: Tube } | null = null, bd = r;
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
    const inStation = under && this.boxes.some((b) => boxAt(b, player.x, player.y + 0.5, player.z, 2));
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
    this.updateTrains(time, cam.position);
    void dt; void playerH; void G;
  }

  private buildNear(x: number, z: number): void {
    const want = new Set<string>();
    // Tube segments (chunks of ~60 m).
    this.tubes.forEach((t, ti) => {
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
      if (Math.hypot(b.cx - x, b.cz - z) > BUILD_R + 60) return;
      const key = `b${bi}`;
      want.add(key);
      if (!this.built.has(key)) this.built.set(key, this.buildStation(b, bi));
    });
    for (const [k, o] of this.built) {
      if (want.has(k)) { if (!o.parent) this.group.add(o); continue; }
      this.group.remove(o);
      o.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh && m !== this.trainMesh) m.geometry.dispose(); });
      this.built.delete(k);
    }
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
      ? [[-hw, 0.0], [-0.6, 0.0], [-0.6, -0.45], [0.6, -0.45], [0.6, 0], [hw, 0], [hw, 1.6], ...arch(hw, 1.6, h, 8)]
      : [[-hw, 0], [hw, 0], [hw, h], [-hw, h]];
    const layer = sewer ? 1 : passage ? 15 : 8;
    // Crossing sewers near this chunk (junctions).
    let others: { o: Tube; idx: number }[] = [];
    const myIdx = this.sewerTubes.indexOf(t);
    if (sewer) {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let i = i0; i <= i1; i++) { x0 = Math.min(x0, P[i * 3]); x1 = Math.max(x1, P[i * 3]); z0 = Math.min(z0, P[i * 3 + 2]); z1 = Math.max(z1, P[i * 3 + 2]); }
      this.sewerTubes.forEach((o, idx) => {
        if (o !== t && o.bounds[0] < x1 + hw && o.bounds[2] > x0 - hw && o.bounds[1] < z1 + hw && o.bounds[3] > z0 - hw) others.push({ o, idx });
      });
    }
    mb.set('aLayer', layer).set('aTint', ...(sewer ? [0.75, 0.68, 0.6] as const : passage ? [0.95, 0.95, 0.95] as const : [0.8, 0.8, 0.78] as const)).set('aFacade', 1, 1, 1, 0).set('aSeed', 0.3).set('aElem', 0);
    // Texture v runs along the perimeter of the section so the vault never smears.
    const perim = [0];
    for (let k = 0; k < profile.length; k++) {
      const [l0, h0] = profile[k], [l1, h1] = profile[(k + 1) % profile.length];
      perim.push(perim[k] + Math.hypot(l1 - l0, h1 - h0));
    }
    for (let i = i0; i < i1; i++) {
      const ax = P[i * 3], ay = P[i * 3 + 1], az = P[i * 3 + 2], bx = P[i * 3 + 3], by = P[i * 3 + 4], bz = P[i * 3 + 5];
      const d0 = dirAt(P, i), d1 = dirAt(P, i + 1);
      for (let k = 0; k < profile.length; k++) {
        const [l0, h0] = profile[k], [l1, h1] = profile[(k + 1) % profile.length];
        if (!sewer && k === 0 && !passage) continue; // tunnel floor is the track bed (drawn below)
        const A = [ax - d0[1] * l0, ay + h0, az + d0[0] * l0], B = [ax - d0[1] * l1, ay + h1, az + d0[0] * l1];
        const C = [bx - d1[1] * l1, by + h1, bz + d1[0] * l1], D = [bx - d1[1] * l0, by + h0, bz + d1[0] * l0];
        if (passage) {
          // Near the street the passage is open to the sky: no ceiling, walls clipped at street level.
          const ga = this.ground(ax, az) - 0.06, gb = this.ground(bx, bz) - 0.06;
          if (k === 2 && (ay + h > ga - 0.3 || by + h > gb - 0.3)) continue;
          for (const V of [A, B]) V[1] = Math.min(V[1], ga);
          for (const V of [C, D]) V[1] = Math.min(V[1], gb);
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
        for (const [ta, tb] of pieces) {
          const lerp3 = (X: number[], Y: number[], f: number) => [X[0] + (Y[0] - X[0]) * f, X[1] + (Y[1] - X[1]) * f, X[2] + (Y[2] - X[2]) * f];
          const A2 = lerp3(A, D, ta), B2 = lerp3(B, C, ta), C2 = lerp3(B, C, tb), D2 = lerp3(A, D, tb);
          const sa = s0 + (s1 - s0) * ta, sb = s0 + (s1 - s0) * tb;
          const i0v = mb.v(A2[0], A2[1], A2[2], nx, nh, nz, sa, v0);
          mb.v(B2[0], B2[1], B2[2], nx, nh, nz, sa, v1);
          mb.v(C2[0], C2[1], C2[2], nx, nh, nz, sb, v1);
          mb.v(D2[0], D2[1], D2[2], nx, nh, nz, sb, v0);
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
        mb.set('aLayer', 8).set('aTint', 0.8, 0.8, 0.78);
      }
      if (passage) {
        // Stairs on the slope (steps every ~0.3 m of rise).
        const rise = ay - by;
        if (rise > 0.2) {
          const n = Math.ceil(rise / 0.17);
          mb.set('aLayer', 13).set('aTint', 0.75, 0.75, 0.73);
          for (let k = 0; k < n; k++) {
            const f = (k + 0.5) / n;
            const cx = ax + (bx - ax) * f, cz = az + (bz - az) * f, cy = ay + (by - ay) * f;
            mb.box(cx, cy - 0.09, cz, hw * 0.98, 0.09, (t.cum[i + 1] - t.cum[i]) / n / 2 + 0.01, Math.atan2(d0[0], d0[1]));
          }
          mb.set('aLayer', 15).set('aTint', 0.95, 0.95, 0.95);
        }
      }
    }
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
      for (let s = (12 - (t.cum[i] % 12)) % 12; s < segL; s += 12) {
        const f = s / segL;
        const d = dirAt(P, i);
        const cx = P[i * 3] + (P[i * 3 + 3] - P[i * 3]) * f, cy = P[i * 3 + 1] + (P[i * 3 + 4] - P[i * 3 + 1]) * f, cz = P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * f;
        const off = sewer ? hw - 0.1 : 0;
        if (passage && cy + t.height > this.ground(cx, cz) - 0.4) continue;
        if (sewer && others.some(({ o }) => tubeAt(o, cx - d[1] * off, cy + 1.9, cz + d[0] * off, 0.2))) continue;
        lg.box(cx - d[1] * off, cy + (sewer ? 1.9 : t.height - 0.1), cz + d[0] * off, sewer ? 0.06 : 0.6, 0.05, sewer ? 0.3 : 0.15, Math.atan2(d[0], d[1]));
      }
    }
    if (!lg.empty) g.add(new THREE.Mesh(toGeometry(lg.build()), this.lightMat));
    if (sewer) {
      // Flowing water in the channel.
      const wg = new MeshBuilder([{ name: 'uv', size: 2 }]);
      for (let i = i0; i < i1; i++) {
        const d0 = dirAt(P, i), d1 = dirAt(P, i + 1);
        quadFlat(wg, P[i * 3], P[i * 3 + 1] - 0.15, P[i * 3 + 2], P[i * 3 + 3], P[i * 3 + 4] - 0.15, P[i * 3 + 5], d0, d1, -0.6, 0.6);
      }
      g.add(new THREE.Mesh(toGeometry(wg.build()), this.waterMat));
    }
    return g;
  }

  private buildStation(b: Box, bi: number): THREE.Object3D {
    const g = new THREE.Group();
    const mb = new MeshBuilder(facadeSpecs());
    const st = this.macro.metroStations[bi];
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
      const a = P(-b.hu, sv * b.hv, b.y0), c = P(b.hu, sv * b.hv, b.y0);
      wallQuad(mb, a, c, b.y1 - b.y0, -sv, b);
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
    box(0, 0, b.y0 - 0.05, b.hu, 0.05, b.hv - 4.2 + 0.01); // track bed reaches the platform walls
    mb.set('aLayer', 13).set('aTint', 0.8, 0.79, 0.76);
    const safety: number[] = [];
    for (const sv of [-1, 1]) {
      const vc = sv * (b.hv - 2.1);
      box(0, vc, b.y0 + PLATFORM_H / 2, b.hu, PLATFORM_H / 2, 2.1);
      // Yellow safety line at the platform edge (plain paint, see below).
      safety.push(sv * (b.hv - 4.2 + 0.3));
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
    const mesh = new THREE.Mesh(toGeometry(mb.build()), this.mat);
    mesh.receiveShadow = true;
    g.add(mesh);
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

  // ------------------------------------------------------------ trains

  /** Train state along a line: list of [s, direction] per train at time t. */
  trainsOn(line: MetroLine, t: number): { s: number; dir: number; dwell: boolean }[] {
    const v = 16, dwell = 22;
    const S = line.stationS;
    if (S.length < 2) return [];
    // One-way schedule from first to last station and back.
    const legs: { a: number; b: number; dur: number }[] = [];
    for (let i = 0; i + 1 < S.length; i++) legs.push({ a: S[i], b: S[i + 1], dur: Math.abs(S[i + 1] - S[i]) / v });
    const oneWay = legs.reduce((a, l) => a + l.dur + dwell, 0);
    const cycle = oneWay * 2;
    const n = Math.max(2, Math.round(Math.abs(S[S.length - 1] - S[0]) / 1400));
    const out: { s: number; dir: number; dwell: boolean }[] = [];
    for (let k = 0; k < n; k++) {
      let tt = ((t + (cycle * k) / n) % cycle + cycle) % cycle;
      let dir = 1;
      if (tt > oneWay) { tt -= oneWay; dir = -1; }
      const L = dir > 0 ? legs : legs.slice().reverse().map((l) => ({ a: l.b, b: l.a, dur: l.dur }));
      let s = L[0].a, dw = false;
      for (const leg of L) {
        if (tt < dwell) { s = leg.a; dw = true; break; }
        tt -= dwell;
        if (tt < leg.dur) {
          // ease in/out
          const f = tt / leg.dur;
          const e = f * f * (3 - 2 * f);
          s = leg.a + (leg.b - leg.a) * e;
          break;
        }
        tt -= leg.dur;
        s = leg.b;
      }
      out.push({ s, dir, dwell: dw });
    }
    return out;
  }

  private m4 = new THREE.Matrix4();
  private updateTrains(time: number, cam: THREE.Vector3): void {
    let k = 0;
    this.macro.metroLines.forEach((line, li) => {
      const tube = this.tubes[li];
      const col = new THREE.Color(line.color);
      for (const tr of this.trainsOn(line, time)) {
        for (let c = 0; c < 4; c++) {
          const s = tr.s - tr.dir * c * 18.5;
          const p = pointOnTube(tube, s);
          if (!p) continue;
          if (Math.hypot(p.x - cam.x, p.z - cam.z) > 500) continue;
          if (k >= 400) return;
          const off = 1.9 * tr.dir;
          const yaw = Math.atan2(p.dx * tr.dir, p.dz * tr.dir);
          this.m4.makeRotationY(yaw);
          this.m4.setPosition(p.x - p.dz * off, p.y, p.z + p.dx * off);
          this.trainMesh.setMatrixAt(k, this.m4);
          this.trainColor.setXYZ(k, col.r, col.g, col.b);
          k++;
        }
      }
    });
    this.trainMesh.count = k;
    this.trainMesh.instanceMatrix.needsUpdate = true;
    this.trainColor.needsUpdate = true;
  }

  /** Trains approaching a point (for sounds/collision): returns nearest car distance. */
  nearestTrain(x: number, y: number, z: number, time: number): number {
    let best = Infinity;
    this.macro.metroLines.forEach((line, li) => {
      const tube = this.tubes[li];
      for (const tr of this.trainsOn(line, time)) {
        const p = pointOnTube(tube, tr.s);
        if (p) best = Math.min(best, Math.hypot(p.x - x, p.y - y, p.z - z));
      }
    });
    return best;
  }
}

const FULL: [number, number][] = [[0, 1]];

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

function pointOnTube(t: Tube, s: number): { x: number; y: number; z: number; dx: number; dz: number } | null {
  const C = t.cum, P = t.pts;
  if (s < 0 || s > C[C.length - 1]) return null;
  let lo = 0, hi = C.length - 1;
  while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (C[m] <= s) lo = m; else hi = m; }
  const f = (s - C[lo]) / Math.max(1e-6, C[hi] - C[lo]);
  const ax = P[lo * 3], ay = P[lo * 3 + 1], az = P[lo * 3 + 2], bx = P[hi * 3], by = P[hi * 3 + 1], bz = P[hi * 3 + 2];
  const L = Math.hypot(bx - ax, bz - az) || 1;
  return { x: ax + (bx - ax) * f, y: ay + (by - ay) * f, z: az + (bz - az) * f, dx: (bx - ax) / L, dz: (bz - az) / L };
}

/** A metro carriage (18 m) with line-colour stripe, windows, doors and lights. */
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
  add(2.9, 2.6, 18, 0, 1.75, 0, [0.82, 0.83, 0.85]);
  add(2.92, 0.35, 18.02, 0, 1.15, 0, [1, 1, 1], 1);                 // line stripe
  add(2.94, 0.9, 16.5, 0, 2.15, 0, [0.06, 0.07, 0.09]);             // windows band
  for (const z of [-5.5, 0, 5.5]) add(2.96, 2.0, 1.3, 0, 1.45, z, [0.55, 0.56, 0.58]); // doors
  add(2.6, 0.5, 17.6, 0, 0.35, 0, [0.15, 0.15, 0.16]);              // underframe
  add(2.5, 0.25, 17.6, 0, 3.15, 0, [0.7, 0.7, 0.72]);               // roof
  const merged = mergeGeos(parts);
  merged.computeVertexNormals();
  return merged;
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


