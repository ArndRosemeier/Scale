/**
 * Street props of the loaded cells (trees, lamps, benches, signals, …) drawn
 * as global instanced meshes refreshed by distance; nearest lamps get real
 * lights at night; props can be toppled / crushed and fall as rigid bodies.
 */
import * as THREE from 'three';
import { treeModel, shrubModel, createBarkMaterial, createLeafMaterial, createFarTreeMaterial, applyVegetationShadow, vegetationUniforms, TREE_SPECIES, type TreeSpecies } from './vegetation';
import { furnitureModel, createFurnitureMaterial, furnitureUniforms, type FurnitureKind } from './furniture';
import { PropType } from '../plan/cell';
import type { CellState } from '../stream/CityStreamer';
import type { Terrain } from '../world/terrain';
import type { RoadNet } from '../sim/RoadNet';
import type { Physics } from '../physics/Physics';
import type { District } from '../plan/types';
import type RAPIER from '@dimforge/rapier3d-compat';
import { CURB_H } from '../build/ground';
import { G } from '../render/materials/globals';
import { junctionBack } from '../sim/Traffic';
import type { Obstacle } from '../world/Collision';
import { hash32, hashToFloat } from '../core/rng';
import type { StreetSeg } from '../plan/cell';
import { TERRACE_PALETTE } from '../plan/terrace';

/** A street prop (tree, lamp, bench, sign …) as the powers and targeting see it. */
export type StreetProp = Prop;

interface Prop {
  kind: string;            // model key
  tree: boolean;
  x: number; y: number; z: number; yaw: number; scale: number;
  color: [number, number, number];
  broken: boolean;
  /** Signal: node + approach edge for the phase. */
  node?: number; edge?: number;
  breakable: 'bend' | 'topple' | 'shatter' | 'solid';
  radius: number;
  height: number;
  /** Collision shape (lazily derived; null = walk-through). */
  solid?: Obstacle | null;
  /** Lamp knocked out (lightning, a hit): no light. */
  dark?: boolean;
  /** Unscaled size while a power has resized it (shrink ray). */
  base?: { scale: number; radius: number; height: number };
  /** Light terrace furniture (chairs, tables, parasols, boards): knocked over easily, drawn nearer. */
  light?: boolean;
}

interface Batch { meshes: THREE.InstancedMesh[]; attrs: { color?: THREE.InstancedBufferAttribute; state?: THREE.InstancedBufferAttribute }; cap: number; n: number }

const SHADOW_TREE = 70;
const NEAR_TREE = 150;
const FAR_TREE = 1500;
const FURN_RANGE = 260;
const GRID = 64;

const STREET_SPECIES: TreeSpecies[] = ['plane', 'linden', 'maple', 'chestnut', 'ginkgo', 'oak'];
const PARK_SPECIES: TreeSpecies[] = ['oak', 'plane', 'birch', 'pine', 'maple', 'linden', 'chestnut', 'cypress'];
const WARM_SPECIES: TreeSpecies[] = ['palm', 'cypress', 'pine', 'plane'];

export class PropRenderer {
  readonly group = new THREE.Group();
  private byCell = new Map<number, Prop[]>();
  private all: Prop[] = [];
  private batches = new Map<string, Batch>();
  private bark = createBarkMaterial();
  private leafMats = new Map<string, THREE.Material>();
  private farMat = createFarTreeMaterial();
  private furnMat = createFurnitureMaterial();
  private lastPos = new THREE.Vector3(1e9, 0, 0);
  private lastFarPos = new THREE.Vector3(1e9, 0, 0);
  private grid = new Map<number, Prop[]>();
  private dirty = true;
  private lights: THREE.PointLight[] = [];
  private falling: { prop: Prop; obj: THREE.Object3D; body: RAPIER.RigidBody; t: number }[] = [];
  private t = 0;
  private signals: Prop[] = [];
  private netVersion = -1;
  stats = { props: 0, drawn: 0 };

  constructor(private terrain: Terrain, private warmth: number, private physics: Physics, private net: RoadNet, private signalGreen: (node: number, edge: number, offset: number) => boolean) {
    for (let i = 0; i < 6; i++) {
      const l = new THREE.PointLight(0xffd9a0, 0, 28, 1.6);
      l.castShadow = false;
      this.lights.push(l);
      this.group.add(l);
    }
  }

  addCell(cs: CellState, district: District): void {
    if (!cs.plan) return;
    const P = cs.plan.props;
    const list: Prop[] = [];
    const seed = cs.id * 7919;
    const streetSp = this.warmth > 0.75 ? WARM_SPECIES : STREET_SPECIES;
    const cellSpecies = streetSp[seed % streetSp.length];
    for (let i = 0; i < P.length; i += 6) {
      const t = P[i] as PropType, x = P[i + 1], z = P[i + 2], yaw = P[i + 3], sc = P[i + 4], v = P[i + 5];
      const y = this.terrain.height(x, z) + CURB_H;
      const base = { x, y, z, yaw, scale: sc, color: [0, 0, 0] as [number, number, number], broken: false };
      switch (t) {
        case PropType.Tree: {
          const park = district === 'park' || v >= 3;
          const parkSp = this.warmth > 0.75 ? WARM_SPECIES : PARK_SPECIES;
          // x can be negative: keep the index non-negative.
          const sp = park ? parkSp[(((seed + v * 31 + Math.round(x)) % parkSp.length) + parkSp.length) % parkSp.length] : cellSpecies;
          const variant = (Math.round(x * 7 + z * 3) & 1);
          const m = treeModel(sp, variant);
          list.push({ ...base, kind: `tree:${sp}:${variant}`, tree: true, breakable: 'topple', radius: m.trunkRadius * sc, height: m.height * sc });
          break;
        }
        case PropType.Bush:
        case PropType.Hedge:
          list.push({ ...base, kind: `shrub:${v % 4}`, tree: true, breakable: 'shatter', radius: 0.6 * sc, height: 1.5 * sc });
          break;
        case PropType.Lamp: {
          const kind: FurnitureKind = v === 1 ? 'lampDouble' : district === 'oldtown' || district === 'park' ? 'lampClassic' : 'lampModern';
          list.push(this.furn(kind, 0, base));
          break;
        }
        case PropType.Bench: list.push(this.furn('bench', v & 1, base)); break;
        case PropType.Bin: list.push(this.furn('bin', v & 1, base)); break;
        case PropType.Hydrant: list.push(this.furn('hydrant', v & 1, base)); break;
        case PropType.Mailbox: list.push(this.furn('mailbox', v & 1, base)); break;
        case PropType.Bollard: list.push(this.furn('bollard', v & 1, base)); break;
        case PropType.Planter: list.push(this.furn('planter', v & 1, base)); break;
        case PropType.Fountain: list.push(this.furn('fountain', v & 1, base)); break;
        case PropType.Statue: list.push(this.furn('statue', v & 1, base)); break;
        case PropType.Kiosk: list.push(this.furn('kiosk', v & 1, base)); break;
        case PropType.PlayGround: list.push(this.furn('playground', v & 1, base)); break;
        // Manhole lids come from the sewer layout (Underground), so every lid is a real entrance.
        case PropType.Manhole: break;
        case PropType.StopSign: list.push(this.furn('stopSign', 0, base)); break;
        // Café terraces (plan/terrace.ts): variant = colour scheme * 2 + model.
        case PropType.CafeTable: list.push(this.terrace('cafeTable', v, base, -1)); break;
        case PropType.CafeChair: list.push(this.terrace('cafeChair', v, base, 1)); break;
        case PropType.Parasol: list.push(this.terrace('parasol', v, base, 0)); break;
        case PropType.Awning: list.push(this.terrace('awning', v, base, 0)); break;
        case PropType.MenuBoard: list.push(this.terrace('menuBoard', v, base, -1)); break;
        case PropType.TerraceRail: list.push(this.terrace('terraceRail', v, base, 0)); break;
        case PropType.Parklet: list.push(this.terrace('parklet', v, base, -1)); break;
        case PropType.ParkedCar: {
          // Near-future kerbs: some parking bays have an EV charging post (more in dense districts).
          const share = EV_SHARE[district] ?? 0.03;
          if (hashToFloat(hash32(seed * 31 + i * 7 + 11)) >= share) break;
          const ev = evChargerSpot(cs.plan.streets, x, z, yaw);
          if (ev) list.push(this.furn('evCharger', v % 3 === 0 ? 1 : 0, { ...base, x: ev.x, y: this.terrain.height(ev.x, ev.z) + CURB_H, z: ev.z, yaw: ev.yaw, scale: 1 }));
          break;
        }
        default: break;
      }
    }
    this.byCell.set(cs.id, list);
    this.needRebuild = true; // coalesced in update()
  }

  /** Extra furniture tied to a cell (metro entrance railings). */
  addExtra(cellId: number, kind: FurnitureKind, x: number, z: number, yaw: number): void {
    const list = this.byCell.get(cellId);
    if (!list) return;
    // Railings stand on the sidewalk; manhole lids lie on the carriageway.
    const y = this.terrain.height(x, z) + (kind === 'manhole' ? 0.01 : CURB_H);
    list.push(this.furn(kind, 0, { x, y, z, yaw, scale: 1, color: [0, 0, 0], broken: false }));
    this.needRebuild = true; // coalesced in update()
  }

  removeCell(cs: CellState): void {
    this.byCell.delete(cs.id);
    this.needRebuild = true; // coalesced in update()
  }

  private furn(kind: FurnitureKind, variant: number, base: Omit<Prop, 'kind' | 'tree' | 'breakable' | 'radius' | 'height'>): Prop {
    const m = furnitureModel(kind, variant);
    return { ...base, kind: `furn:${kind}:${variant}`, tree: false, breakable: m.breakable, radius: m.radius, height: m.height };
  }

  /** Terrace furniture in the café's colours (`tint`: 0 fabric, 1 chair paint, -1 none). */
  private terrace(kind: FurnitureKind, v: number, base: Omit<Prop, 'kind' | 'tree' | 'breakable' | 'radius' | 'height'>, tint: number): Prop {
    const p = this.furn(kind, v & 1, base);
    const pal = TERRACE_PALETTE[(v >> 1) % TERRACE_PALETTE.length];
    if (tint >= 0 && !(kind === 'cafeChair' && (v & 1))) p.color = [...pal[tint]];
    p.light = kind !== 'awning' && kind !== 'parklet';
    return p;
  }

  private rebuildAll(): void {
    this.all = [...this.byCell.values()].flat().concat(this.signals);
    this.grid.clear();
    for (const p of this.all) {
      const k = (Math.floor(p.x / GRID) + 32768) * 65536 + (Math.floor(p.z / GRID) + 32768);
      let l = this.grid.get(k);
      if (!l) this.grid.set(k, (l = []));
      l.push(p);
    }
    this.dirty = true;
    this.farDirty = true;
    this.stats.props = this.all.length;
  }
  private farDirty = true;
  private needRebuild = false;
  private lastFar = -1;
  private lastRebuild = -1;

  /**
   * Solid props overlapping a box, for player collision: tree trunks, poles and lamps as
   * cylinders, benches / shelters / stands as oriented boxes. Flat or walk-in things
   * (manholes, playgrounds, metro entrances, bike racks, shrubs) and broken props are not
   * obstacles.
   */
  obstaclesIn(x0: number, z0: number, x1: number, z1: number, out: (o: Obstacle) => void): void {
    const i0 = Math.floor((x0 - 8) / GRID), i1 = Math.floor((x1 + 8) / GRID), j0 = Math.floor((z0 - 8) / GRID), j1 = Math.floor((z1 + 8) / GRID);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const l = this.grid.get((i + 32768) * 65536 + (j + 32768));
      if (!l) continue;
      for (const p of l) {
        if (p.broken) continue;
        if (p.solid === undefined) p.solid = propShape(p);
        const o = p.solid;
        if (!o) continue;
        const ext = o.cyl ? o.r : Math.max(o.hx, o.hz);
        if (o.x + ext < x0 || o.x - ext > x1 || o.z + ext < z0 || o.z - ext > z1) continue;
        out(o);
      }
    }
  }

  private near(x: number, z: number, r: number, fn: (p: Prop) => void): void {
    const i0 = Math.floor((x - r) / GRID), i1 = Math.floor((x + r) / GRID), j0 = Math.floor((z - r) / GRID), j1 = Math.floor((z + r) / GRID);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const l = this.grid.get((i + 32768) * 65536 + (j + 32768));
      if (l) for (const p of l) fn(p);
    }
  }

  /** Traffic signals at the corners of signalled junctions (rebuilt with the road net). */
  private rebuildSignals(): void {
    this.signals = [];
    const net = this.net;
    net.nodes.forEach((n, ni) => {
      if (!n.signal || n.edges.length < 3) return;
      for (const eid of n.edges) {
        const e = net.edges[eid];
        const incomingFwd = e.b === ni; // traffic on this edge travelling towards the node
        const back = junctionBack(e) + 1.5;
        const s = incomingFwd ? e.len - back : back;
        if (s < 2 || s > e.len - 2) continue;
        const o = { x: 0, z: 0, dx: 0, dz: 0 };
        // Right-hand kerb of the approaching traffic.
        net.pointAt(e, s, (incomingFwd ? 1 : -1) * (e.width / 2 + 0.7), o);
        const dirx = incomingFwd ? o.dx : -o.dx, dirz = incomingFwd ? o.dz : -o.dz;
        // The model's mast arm reaches over the road (-Z) and heads face +X: rotate so the arm points left of travel.
        const yaw = Math.atan2(-dirz, dirx) + Math.PI;
        const y = this.terrain.height(o.x, o.z) + CURB_H;
        const p = this.furn('trafficLight', ni & 1, { x: o.x, y, z: o.z, yaw, scale: 1, color: [0, 0, 0], broken: false });
        p.node = ni; p.edge = eid;
        this.signals.push(p);
      }
    });
  }

  /**
   * One tiny instanced mesh per prop material (leaves of every species, shrubs, bark, far
   * impostors, street furniture) for background shader precompilation. Not added to the scene.
   */
  warmupObject(): THREE.Object3D {
    const g = new THREE.Group();
    const geo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    const mats: THREE.Material[] = [this.bark, this.farMat, this.furnMat];
    for (const sp of TREE_SPECIES) {
      let lm = this.leafMats.get(sp);
      if (!lm) { lm = createLeafMaterial(sp); this.leafMats.set(sp, lm); }
      mats.push(lm);
    }
    for (let k = 0; k < 4; k++) {
      let lm = this.leafMats.get(String(k));
      if (!lm) { lm = createLeafMaterial(undefined); this.leafMats.set(String(k), lm); }
      mats.push(lm);
    }
    for (const m of mats) {
      const fg = m === this.furnMat ? geo.clone() : geo;
      if (m === this.furnMat) {
        fg.setAttribute('iColor', new THREE.InstancedBufferAttribute(new Float32Array(3), 3));
        fg.setAttribute('iState', new THREE.InstancedBufferAttribute(new Float32Array(4), 4));
      }
      const im = new THREE.InstancedMesh(fg, m, 1);
      // Shadow variants as the real batches use them (vegetation has custom depth shaders).
      im.castShadow = m !== this.farMat;
      if (m !== this.furnMat && m !== this.farMat) applyVegetationShadow(im);
      g.add(im);
    }
    return g;
  }

  private batch(key: string, cap: number): Batch {
    let b = this.batches.get(key);
    if (b && b.cap >= cap) return b;
    if (b) { for (const m of b.meshes) { this.group.remove(m); m.dispose(); } }
    const meshes: THREE.InstancedMesh[] = [];
    const attrs: Batch['attrs'] = {};
    const midTier = key.startsWith('mid:');
    const [type, a, v] = (midTier ? key.slice(4) : key).split(':');
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, shadow: boolean) => {
      const g = new THREE.BufferGeometry();
      for (const n of Object.keys(geo.attributes)) g.setAttribute(n, geo.attributes[n]);
      g.setIndex(geo.index);
      g.boundingSphere = geo.boundingSphere;
      const im = new THREE.InstancedMesh(g, mat, cap);
      im.count = 0;
      im.frustumCulled = false;
      im.castShadow = shadow;
      im.receiveShadow = true;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      meshes.push(im);
      this.group.add(im);
      return im;
    };
    if (type === 'tree' || type === 'shrub') {
      const m = type === 'tree' ? treeModel(a as TreeSpecies, Number(v)) : shrubModel(Number(a));
      let lm = this.leafMats.get(a);
      if (!lm) { lm = createLeafMaterial(type === 'tree' ? (a as TreeSpecies) : undefined); this.leafMats.set(a, lm); }
      const w = mk(m.wood, this.bark, !midTier);
      const l = mk(m.leaves, lm, !midTier);
      applyVegetationShadow(w);
      applyVegetationShadow(l);
    } else if (type === 'far') {
      const m = treeModel(a as TreeSpecies, Number(v));
      mk(m.far, this.farMat, false);
    } else {
      const m = furnitureModel(a as FurnitureKind, Number(v));
      const geo = m.geometry.clone();
      const color = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
      const state = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('iColor', color);
      geo.setAttribute('iState', state);
      attrs.color = color;
      attrs.state = state;
      mk(geo, this.furnMat, a !== 'manhole');
    }
    b = { meshes, attrs, cap, n: 0 };
    this.batches.set(key, b);
    return b;
  }

  update(dt: number, cam: THREE.Camera): void {
    this.t += dt;
    vegetationUniforms.uTime.value += dt;
    furnitureUniforms.uTime.value += dt;
    furnitureUniforms.uNight.value = G.uNight.value;
    furnitureUniforms.uLampOn.value = G.uLampOn.value;
    if (this.net.version !== this.netVersion) {
      this.netVersion = this.net.version;
      this.rebuildSignals();
      this.needRebuild = true;
    }
    // Cells stream in bursts: rebuild the index at most every 0.4 s.
    if (this.needRebuild && this.t - this.lastRebuild > 0.4) {
      this.needRebuild = false;
      this.lastRebuild = this.t;
      this.rebuildAll();
    }
    const cp = cam.position;
    // Signal phases change every frame (cheap: only signal batches).
    if ((this.farDirty && this.t - this.lastFar > 1) || cp.distanceTo(this.lastFarPos) > 60) {
      this.lastFar = this.t;
      this.farDirty = false;
      this.lastFarPos.copy(cp);
      this.refreshFar(cp);
    }
    if (this.dirty || cp.distanceTo(this.lastPos) > 6) {
      this.dirty = false;
      this.lastPos.copy(cp);
      this.refresh(cp);
    } else this.updateSignals();
    this.updateLights(cp);
    this.updateFalling(dt);
  }

  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();

  /** Near tiers: shadow-casting detailed trees, unshadowed detailed trees, shrubs, furniture. */
  private refresh(cp: THREE.Vector3): void {
    const groups = new Map<string, Prop[]>();
    const push = (k: string, p: Prop) => { let l = groups.get(k); if (!l) groups.set(k, (l = [])); l.push(p); };
    this.near(cp.x, cp.z, FURN_RANGE * 1.6, (p) => {
      if (p.broken) return;
      const d = Math.hypot(p.x - cp.x, p.z - cp.z);
      if (p.tree) {
        if (d < SHADOW_TREE) push(p.kind, p);
        else if (d < NEAR_TREE) push('mid:' + p.kind, p);
      } else if (d < FURN_RANGE * (p.kind.includes('lamp') || p.kind.includes('traffic') ? 1.6 : p.light ? 0.6 : 1)) push(p.kind, p);
    });
    this.fill(groups, (k) => !k.startsWith('far:'));
  }

  /** Far tier: impostor trees between the near range and the horizon. */
  private refreshFar(cp: THREE.Vector3): void {
    const groups = new Map<string, Prop[]>();
    for (const p of this.all) {
      if (p.broken || !p.kind.startsWith('tree:')) continue;
      const d = Math.hypot(p.x - cp.x, p.z - cp.z);
      if (d >= NEAR_TREE - 30 && d < FAR_TREE) { const k = 'far:' + p.kind.slice(5); let l = groups.get(k); if (!l) groups.set(k, (l = [])); l.push(p); }
    }
    this.fill(groups, (k) => k.startsWith('far:'));
  }

  private fill(groups: Map<string, Prop[]>, owns: (k: string) => boolean): void {
    for (const [k, b] of this.batches) if (owns(k)) { b.n = 0; for (const m of b.meshes) m.count = 0; }
    let drawn = 0;
    for (const [k, list] of groups) {
      const b = this.batch(k, Math.max(64, Math.ceil(list.length * 2)));
      list.forEach((p, i) => {
        this.q.setFromAxisAngle(_up, p.yaw);
        this.m4.compose(this.v.set(p.x, p.y, p.z), this.q, this.s.setScalar(p.scale));
        for (const m of b.meshes) m.setMatrixAt(i, this.m4);
        b.attrs.color?.setXYZ(i, p.color[0], p.color[1], p.color[2]);
        b.attrs.state?.setXYZW(i, p.dark ? 0 : 1, p.node !== undefined ? this.phase(p) : 0, 0, 0);
      });
      b.n = list.length;
      for (const m of b.meshes) { m.count = list.length; m.instanceMatrix.needsUpdate = true; }
      if (b.attrs.color) b.attrs.color.needsUpdate = true;
      if (b.attrs.state) b.attrs.state.needsUpdate = true;
      (b as Batch & { list?: Prop[] }).list = list;
      drawn += list.length;
    }
    this.stats.drawn = drawn;
  }

  private phase(p: Prop): number {
    if (this.signalGreen(p.node!, p.edge!, 0)) return 2;
    // amber: green a moment ago
    return this.signalGreen(p.node!, p.edge!, -2.5) ? 1 : 0;
  }

  private updateSignals(): void {
    for (const [k, b] of this.batches) {
      if (!k.startsWith('furn:trafficLight')) continue;
      const list = (b as Batch & { list?: Prop[] }).list;
      if (!list || !b.attrs.state) continue;
      list.forEach((p, i) => b.attrs.state!.setY(i, this.phase(p)));
      b.attrs.state.needsUpdate = true;
    }
  }

  /** Real point lights from the nearest street lamps at night. */
  private updateLights(cp: THREE.Vector3): void {
    const on = G.uLampOn.value;
    if (on < 0.05) { for (const l of this.lights) l.intensity = 0; return; }
    const lamps: { p: Prop; d: number }[] = [];
    this.near(cp.x, cp.z, 90, (p) => {
      if (p.broken || p.dark || !p.kind.includes('lamp')) return;
      const d = Math.hypot(p.x - cp.x, p.z - cp.z);
      if (d < 90) lamps.push({ p, d });
    });
    lamps.sort((a, b) => a.d - b.d);
    this.lights.forEach((l, i) => {
      const e = lamps[i];
      if (!e) { l.intensity = 0; return; }
      const m = furnitureModel(e.p.kind.split(':')[1] as FurnitureKind, Number(e.p.kind.split(':')[2]));
      const lp = m.lights[0]?.pos ?? [0, e.p.height * 0.95, 0];
      const c = Math.cos(e.p.yaw), s = Math.sin(e.p.yaw);
      l.position.set(e.p.x + lp[0] * c + lp[2] * s, e.p.y + lp[1] - 0.3, e.p.z - lp[0] * s + lp[2] * c);
      l.intensity = 60 * on;
    });
  }

  /** Strike props near a point; impulse J (N·s). Returns number affected. */
  hit(x: number, y: number, z: number, r: number, jx: number, jy: number, jz: number): number {
    const J = Math.hypot(jx, jy, jz);
    let n = 0;
    const cand: Prop[] = [];
    this.near(x, z, r + 6, (p) => cand.push(p));
    for (const p of cand) {
      if (p.broken) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d > r + p.radius || y > p.y + p.height + r || y < p.y - r - 1) continue;
      const need = p.breakable === 'solid' ? 1e9 : p.tree ? 2500 * p.scale ** 2 : p.light ? 150 : p.breakable === 'shatter' ? 300 : 1200;
      if (J < need) continue;
      this.topple(p, jx, jy, jz);
      n++;
    }
    return n;
  }

  /**
   * A big walker's body ploughs through: props it touches that are clearly shorter than it
   * (trees, lamps, signs, bushes) are pushed over in its walking direction - not only the ones
   * a footstep happens to land on. Returns the number pushed over.
   */
  shove(x: number, z: number, r: number, h: number, dirX: number, dirZ: number): number {
    if (h < 3) return 0;
    const cand: Prop[] = [];
    this.near(x, z, r + 6, (p) => cand.push(p));
    let n = 0;
    for (const p of cand) {
      if (p.broken || p.breakable === 'solid' || p.height > h * 0.75) continue;
      const dx = p.x - x, dz = p.z - z;
      const d = Math.hypot(dx, dz);
      if (d > r + p.radius + 0.1) continue;
      // Away from the body, leaning into the walking direction.
      let fx = dirX * 0.7 + (d > 1e-3 ? dx / d : 0) * 0.5, fz = dirZ * 0.7 + (d > 1e-3 ? dz / d : 0) * 0.5;
      const fl = Math.hypot(fx, fz) || 1;
      fx /= fl; fz /= fl;
      // Impulse sized to the prop's mass so it tips over at walking pace (topple() applies 5% at the top).
      const rad = p.tree ? p.radius * 1.2 : Math.min(0.3, p.radius);
      const mass = Math.PI * rad * rad * Math.max(0.3, p.height) * (p.tree ? 700 : 3000);
      const J = mass * 3 / 0.05;
      this.topple(p, fx * J, 0, fz * J);
      n++;
    }
    return n;
  }

  /** Props near (x, z) within about r (grid cells), standing or not. */
  query(x: number, z: number, r: number, fn: (p: Prop) => void): void {
    this.near(x, z, r, (p) => { if (Math.abs(p.x - x) <= r + p.radius && Math.abs(p.z - z) <= r + p.radius) fn(p); });
  }

  /** Knock a lamp's light out (it stays standing). */
  darken(p: Prop): void {
    if (p.dark) return;
    p.dark = true;
    this.patch(p);
  }

  /**
   * Resize a prop (shrink ray): f = factor of its own size (1 restores it). Collision follows;
   * only its instance is rewritten, not the whole batch.
   */
  setScale(p: Prop, f: number): void {
    if (!p.base) { if (f === 1) return; p.base = { scale: p.scale, radius: p.radius, height: p.height }; }
    p.scale = p.base.scale * f;
    p.radius = p.base.radius * f;
    p.height = p.base.height * f;
    p.solid = undefined;
    if (f === 1) p.base = undefined;
    this.patch(p);
  }

  /** Rewrite one prop's instance in place (matrix, light state). */
  private patch(p: Prop): void {
    for (const [k, b] of this.batches) {
      if (k !== p.kind && k !== 'mid:' + p.kind) continue;
      const list = (b as Batch & { list?: Prop[] }).list;
      const i = list ? list.indexOf(p) : -1;
      if (i < 0) continue;
      this.q.setFromAxisAngle(_up, p.yaw);
      this.m4.compose(this.v.set(p.x, p.y, p.z), this.q, this.s.setScalar(p.scale));
      for (const m of b.meshes) { m.setMatrixAt(i, this.m4); m.instanceMatrix.needsUpdate = true; }
      if (b.attrs.state) { b.attrs.state.setX(i, p.dark ? 0 : 1); b.attrs.state.needsUpdate = true; }
    }
  }

  /** Crush props under a giant foot / debris. */
  crush(x: number, z: number, r: number): void {
    const cand: Prop[] = [];
    this.near(x, z, r + 6, (p) => cand.push(p));
    for (const p of cand) {
      if (p.broken) continue;
      if (Math.hypot(p.x - x, p.z - z) < r + p.radius) this.topple(p, 0, -5000, 0);
    }
  }

  /**
   * Gone without a fall (a district levelled by the last resort, src/game/aftermath): everything
   * within r is broken at once — no falling bodies, no sounds. Returns how many.
   */
  flatten(x: number, z: number, r: number): number {
    let n = 0;
    this.near(x, z, r + 6, (p) => { if (!p.broken && Math.hypot(p.x - x, p.z - z) < r + p.radius) { p.broken = true; n++; } });
    if (n) { this.dirty = true; this.farDirty = true; }
    return n;
  }

  /** Gone from its spot without a fall (a tree sung awake walks off as a threat, src/game/threats/AwakenedTree). */
  uproot(p: Prop): void {
    if (p.broken) return;
    p.broken = true;
    this.dirty = true;
    this.farDirty = true;
  }

  onBreak?: (p: { x: number; y: number; z: number; tree: boolean }) => void;

  private topple(p: Prop, jx: number, jy: number, jz: number): void {
    p.broken = true;
    this.dirty = true;
    this.farDirty = true;
    this.onBreak?.({ x: p.x, y: p.y, z: p.z, tree: p.tree });
    if (p.kind.includes('manhole') || this.falling.length > 40) return;
    // A single-instance copy that falls as a rigid body (pivoting near its base).
    const b = this.batch(p.kind, 64);
    const obj = new THREE.Group();
    for (const m of b.meshes) {
      const one = new THREE.InstancedMesh(m.geometry, m.material, 1);
      one.setMatrixAt(0, new THREE.Matrix4().makeScale(p.scale, p.scale, p.scale));
      one.castShadow = true;
      one.frustumCulled = false;
      obj.add(one);
    }
    this.group.add(obj);
    const R = this.physics.R;
    const h = Math.max(0.3, p.height);
    const body = this.physics.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(p.x, p.y + h / 2, p.z).setRotation({ x: 0, y: Math.sin(p.yaw / 2), z: 0, w: Math.cos(p.yaw / 2) }).setAngularDamping(0.5));
    const rad = Math.max(0.08, p.tree ? p.radius * 1.2 : Math.min(0.3, p.radius));
    this.physics.world.createCollider(R.ColliderDesc.cylinder(h / 2, rad).setDensity(p.tree ? 700 : 3000).setFriction(0.8), body);
    // Push near the top so it tips over.
    body.applyImpulseAtPoint({ x: jx * 0.05, y: Math.max(0, jy * 0.01), z: jz * 0.05 }, { x: p.x, y: p.y + h * 0.8, z: p.z }, true);
    if (jx === 0 && jz === 0) body.applyImpulseAtPoint({ x: (Math.random() - 0.5) * 200, y: 0, z: (Math.random() - 0.5) * 200 }, { x: p.x, y: p.y + h, z: p.z }, true);
    this.physics.ensureGround(p.x, p.z, h + 5);
    this.falling.push({ prop: p, obj, body, t: 0 });
    void G;
  }

  private updateFalling(dt: number): void {
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i];
      f.t += dt;
      const t = f.body.translation(), r = f.body.rotation();
      const h = Math.max(0.3, f.prop.height);
      // Body origin is at the centre; the model origin is at its base.
      const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
      const off = new THREE.Vector3(0, -h / 2, 0).applyQuaternion(q);
      f.obj.position.set(t.x + off.x, t.y + off.y, t.z + off.z);
      f.obj.quaternion.copy(q);
      if (f.t > 6 && (f.body.isSleeping() || f.t > 30)) {
        this.physics.world.removeRigidBody(f.body);
        this.falling.splice(i, 1);
        // Leave it lying there (static).
      }
    }
  }
}

const _up = new THREE.Vector3(0, 1, 0);

/** Share of parking bays with an EV charging post, by district. */
const EV_SHARE: Partial<Record<District, number>> = { downtown: 0.14, commercial: 0.12, apartments: 0.1, rowhouses: 0.07, oldtown: 0.05, suburban: 0.04, industrial: 0.04, port: 0.03 };

/**
 * Kerb spot beside a parked car (x, z, yaw: forward = (−sin, −cos)) for a charging post: level
 * with the front wheels, on the side away from the carriageway (the farther point from every
 * street centreline), facing the car.
 */
function evChargerSpot(streets: StreetSeg[], x: number, z: number, yaw: number): { x: number; z: number; yaw: number } | null {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const lx = -fz, lz = fx;
  const dist = (px: number, pz: number) => {
    let best = Infinity;
    for (const s of streets) for (let k = 0; k + 3 < s.pts.length; k += 2) {
      const ax = s.pts[k], az = s.pts[k + 1], dx = s.pts[k + 2] - ax, dz = s.pts[k + 3] - az, l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
      best = Math.min(best, Math.hypot(ax + dx * t - px, az + dz * t - pz));
    }
    return best;
  };
  const cx = x + fx * 1.2, cz = z + fz * 1.2;
  const a = { x: cx + lx * 1.75, z: cz + lz * 1.75 }, b = { x: cx - lx * 1.75, z: cz - lz * 1.75 };
  const da = dist(a.x, a.z), db = dist(b.x, b.z);
  if (!isFinite(da) || Math.abs(da - db) < 0.5) return null;
  const p = da > db ? a : b;
  // Front (−Z) of the post towards the car.
  return { x: p.x, z: p.z, yaw: Math.atan2(-(cx - p.x), -(cz - p.z)) };
}

/** Collision shape of a prop (see obstaclesIn). Box axis = the model's local x. */
function propShape(p: Prop): Obstacle | null {
  const base = { x: p.x, z: p.z, y0: p.y, y1: p.y + p.height, ux: Math.cos(p.yaw), uz: -Math.sin(p.yaw) };
  const cyl = (r: number): Obstacle => ({ ...base, cyl: true, r, hx: 0, hz: 0 });
  const box = (hx: number, hz: number): Obstacle => ({ ...base, cyl: false, r: 0, hx, hz });
  if (p.kind.startsWith('tree:')) return cyl(Math.max(0.12, p.radius));
  if (!p.kind.startsWith('furn:')) return null; // shrubs, far impostors
  const k = p.kind.split(':')[1];
  const r = p.radius;
  switch (k) {
    case 'manhole': case 'playground': case 'metroEntrance': case 'bikeRack': case 'awning': case 'parklet': return null;
    case 'terraceRail': return box(1.0 * p.scale, 0.06 * p.scale);
    case 'bench': return box(0.95 * p.scale, 0.3 * p.scale);
    case 'busStop': return box(2.2 * p.scale, 0.75 * p.scale);
    case 'newsStand': return box(0.9 * p.scale, 0.4 * p.scale);
    case 'kiosk': return cyl(r * 0.8 * p.scale);
    case 'statue': return cyl(r * 0.55 * p.scale);
    case 'fountain': return cyl(r * 0.95 * p.scale);
    case 'phoneBooth': return cyl(0.55 * p.scale);
    default: return cyl(Math.max(0.08, r) * p.scale);
  }
}
