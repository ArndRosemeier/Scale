/**
 * Procedural street furniture. Every kind is a single merged BufferGeometry (origin at the ground
 * contact point, front facing -Z = street side) drawn with ONE shared material (createFurnitureMaterial)
 * that resolves the per-vertex material id (aMat, see FMat) in the shader — instancing-ready.
 *
 * Geometry attributes:
 *  - position, normal, uv
 *  - aMat   float FMat id
 *  - aEmit  float 0..1 emissive mask (lamp lenses, signal lenses, back-lit signs)
 *  - aSub   float sub-material code (internal): 0 plain, 1 red / 2 amber / 3 green signal lens,
 *           4 pedestrian "don't walk" / 5 "walk" lens, 7 back-lit sign, 8 foliage, 9 fixed paint
 *           (ignores iColor), 10 status LED / 11 strobe / 12 navigation light (near-future robots
 *           and drones: always powered, iState.z = blink phase, iState.w = 0 ok / 1 alert / 2 off /
 *           3 hostile (red) / 4 glitching (flicker))
 *  - aColor vec3 default paint / plastic colour (linear). Per-instance iColor (sRGB) replaces it for
 *           PaintedMetal / Plastic vertices when non-zero.
 *
 * Instance attributes (optional, InstancedBufferAttribute on the geometry): iColor (vec3 sRGB),
 * iState (vec4: x light on, y traffic phase 0 red / 1 amber / 2 green). When iState is absent the
 * shader treats lights as on and cycles traffic signals by uTime.
 *
 * Conventions: lampModern / lampDouble arms reach over the street (-Z). trafficLight: mast arm over
 * the street (-Z); vehicle heads face +X (traffic approaching from +X); pedestrian head faces -Z.
 * Pedestrian "walk" is shown while the vehicle phase is red. metroEntrance: origin = centre of the
 * 2.5 (X) x 6 (Z) opening, stairs descend towards +Z, the open end is at -Z.
 */
import * as THREE from 'three';
import { Rng } from '../core/rng';
import { Noise } from '../core/noise';

export type FurnitureKind = 'lampModern' | 'lampClassic' | 'lampDouble' | 'trafficLight' | 'bench' | 'bin' | 'hydrant' | 'mailbox' | 'bollard' | 'planter' | 'busStop' | 'fountain' | 'statue' | 'kiosk' | 'stopSign' | 'playground' | 'manhole' | 'metroEntrance' | 'newsStand' | 'bikeRack' | 'phoneBooth' | 'evCharger'
  | 'cafeTable' | 'cafeChair' | 'parasol' | 'awning' | 'menuBoard' | 'terraceRail' | 'parklet';

export const FURNITURE_KINDS: FurnitureKind[] = ['lampModern', 'lampClassic', 'lampDouble', 'trafficLight', 'bench', 'bin', 'hydrant', 'mailbox', 'bollard', 'planter', 'busStop', 'fountain', 'statue', 'kiosk', 'stopSign', 'playground', 'manhole', 'metroEntrance', 'newsStand', 'bikeRack', 'phoneBooth', 'evCharger', 'cafeTable', 'cafeChair', 'parasol', 'awning', 'menuBoard', 'terraceRail', 'parklet'];

export interface FurnitureModel {
  kind: FurnitureKind;
  geometry: THREE.BufferGeometry;
  height: number;
  radius: number;
  lights: { pos: [number, number, number]; color: [number, number, number]; intensity: number }[];
  breakable: 'bend' | 'topple' | 'shatter' | 'solid';
}

export const enum FMat { Metal = 0, PaintedMetal = 1, Wood = 2, Concrete = 3, Stone = 4, Glass = 5, Plastic = 6, Light = 7, Water = 8, Bronze = 9, Rubber = 10, Signage = 11 }

export const furnitureUniforms = {
  uTime: { value: 0 },
  uNight: { value: 0 },
  uLampOn: { value: 0 },
};

// ---------------------------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------------------------

export type V = [number, number, number];
export interface PO { m: FMat; c?: V; e?: number; s?: number }

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _n3 = new THREE.Matrix3();

export function M(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q, new THREE.Vector3(sx, sy, sz));
}

/** uv rect of a signage atlas cell (4x4 grid, cell 0 = top-left). */
function cellRect(cell: number): [number, number, number, number] {
  const cx = cell % 4, cy = Math.floor(cell / 4);
  const m = 0.004;
  return [cx / 4 + m, 1 - (cy + 1) / 4 + m, (cx + 1) / 4 - m, 1 - cy / 4 - m];
}

export class FB {
  pos: number[] = []; nrm: number[] = []; uv: number[] = []; mat: number[] = []; emit: number[] = []; sub: number[] = []; col: number[] = [];
  idx: number[] = [];
  get count() { return this.pos.length / 3; }

  add(geo: THREE.BufferGeometry, mtx: THREE.Matrix4, po: PO, uvMap?: (u: number, v: number) => [number, number], doubleSided = false) {
    if (doubleSided) {
      const back = geo.clone();
      const bn = back.getAttribute('normal');
      for (let i = 0; i < bn.count; i++) bn.setXYZ(i, -bn.getX(i), -bn.getY(i), -bn.getZ(i));
      if (!back.index) back.setIndex([...Array(back.getAttribute('position').count).keys()]);
      const ia = back.index!;
      const arr = Array.from(ia.array as ArrayLike<number>);
      for (let i = 0; i < arr.length; i += 3) { const t = arr[i + 1]; arr[i + 1] = arr[i + 2]; arr[i + 2] = t; }
      back.setIndex(arr);
      this.add(back, mtx, po, uvMap);
    }
    const p = geo.getAttribute('position');
    const n = geo.getAttribute('normal');
    const t = geo.getAttribute('uv');
    _n3.getNormalMatrix(mtx);
    const base = this.count;
    const v = new THREE.Vector3(), nn = new THREE.Vector3();
    const c = po.c ?? [0.5, 0.5, 0.5];
    const cl = [lin(c[0]), lin(c[1]), lin(c[2])];
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(mtx);
      nn.fromBufferAttribute(n, i).applyMatrix3(_n3).normalize();
      this.pos.push(v.x, v.y, v.z);
      this.nrm.push(nn.x, nn.y, nn.z);
      let uu = t ? t.getX(i) : 0, vv = t ? t.getY(i) : 0;
      if (uvMap) [uu, vv] = uvMap(uu, vv);
      this.uv.push(uu, vv);
      this.mat.push(po.m);
      this.emit.push(po.e ?? 0);
      this.sub.push(po.s ?? 0);
      this.col.push(cl[0], cl[1], cl[2]);
    }
    if (geo.index) for (let i = 0; i < geo.index.count; i++) this.idx.push(base + geo.index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    geo.dispose();
  }

  box(po: PO, sx: number, sy: number, sz: number, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0) {
    this.add(new THREE.BoxGeometry(sx, sy, sz), M(x, y, z, rx, ry, rz), po);
  }
  /** Cylinder with its base at (x,y,z) (before rotation about that base). */
  cyl(po: PO, rTop: number, rBot: number, h: number, x: number, y: number, z: number, seg = 12, open = false, rx = 0, ry = 0, rz = 0) {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open);
    g.translate(0, h / 2, 0);
    this.add(g, M(x, y, z, rx, ry, rz), po);
  }
  rod(po: PO, a: V, b: V, r: number, seg = 8, rb = r) {
    const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
    const d = vb.clone().sub(va);
    const len = d.length();
    const g = new THREE.CylinderGeometry(r, rb, len, seg, 1, true);
    g.translate(0, len / 2, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    this.add(g, new THREE.Matrix4().compose(va, q, new THREE.Vector3(1, 1, 1)), po);
  }
  lathe(po: PO, prof: [number, number][], seg: number, x = 0, y = 0, z = 0, ry = 0, sx = 1, sz = 1, phiLen = Math.PI * 2) {
    const g = new THREE.LatheGeometry(prof.map(([r, yy]) => new THREE.Vector2(Math.max(0, r), yy)), seg, 0, phiLen);
    this.add(g, M(x, y, z, 0, ry, 0, sx, 1, sz), po);
  }
  tube(po: PO, pts: V[], r: number, radial = 8, segs = 16, rEnd = r) {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)), false, 'centripetal');
    const g = new THREE.TubeGeometry(curve, segs, r, radial, false);
    if (rEnd !== r) {
      // taper along the tube
      const pa = g.getAttribute('position');
      const per = radial + 1;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const c = curve.getPointAt(t);
        const k = (r + (rEnd - r) * t) / r;
        for (let j = 0; j < per; j++) {
          const vi = i * per + j;
          pa.setXYZ(vi, c.x + (pa.getX(vi) - c.x) * k, c.y + (pa.getY(vi) - c.y) * k, c.z + (pa.getZ(vi) - c.z) * k);
        }
      }
    }
    this.add(g, new THREE.Matrix4(), po);
  }
  sphere(po: PO, r: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, ws = 12, hs = 8, thetaLen = Math.PI) {
    this.add(new THREE.SphereGeometry(r, ws, hs, 0, Math.PI * 2, 0, thetaLen), M(x, y, z, 0, 0, 0, sx, sy, sz), po);
  }
  capsule(po: PO, a: V, b: V, r: number, rb = r, radial = 10) {
    const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
    const d = vb.clone().sub(va);
    const len = d.length();
    const g = new THREE.CylinderGeometry(rb, r, len, radial, 1, true);
    g.translate(0, len / 2, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
    this.add(g, new THREE.Matrix4().compose(va, q, new THREE.Vector3(1, 1, 1)), po);
    this.sphere(po, r, ...a, 1, 1, 1, radial, 6);
    this.sphere(po, rb, ...b, 1, 1, 1, radial, 6);
  }
  /** Flat sign panel (front faces -Z after rotation ry) with uv into a signage cell. */
  panel(po: PO, w: number, h: number, x: number, y: number, z: number, ry: number, cell: number, rx = 0) {
    const g = new THREE.PlaneGeometry(w, h);
    g.rotateY(Math.PI);
    const [u0, v0, u1, v1] = cellRect(cell);
    this.add(g, M(x, y, z, rx, ry, 0), po, (u, v) => [u0 + (u1 - u0) * u, v0 + (v1 - v0) * v]);
  }
  /** Regular polygon plate in the XY plane facing -Z (front signage, back metal). */
  polyPlate(front: PO, back: PO, n: number, r: number, thick: number, x: number, y: number, z: number, ry: number, cell: number, rot = Math.PI / n) {
    const [u0, v0, u1, v1] = cellRect(cell);
    const shapePts: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * Math.PI * 2;
      shapePts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    const mk = (zz: number, facing: number) => {
      const pos: number[] = [0, 0, zz], nrm: number[] = [0, 0, facing], uv: number[] = [(u0 + u1) / 2, (v0 + v1) / 2];
      const idx: number[] = [];
      shapePts.forEach(([px, py], i) => {
        pos.push(px, py, zz); nrm.push(0, 0, facing);
        // front (facing -Z) is viewed from -Z: mirror u so text reads correctly from either side
        uv.push(u0 + (u1 - u0) * (0.5 + facing * (px / r) * 0.5), v0 + (v1 - v0) * (0.5 + (py / r) * 0.5));
        const a = i + 1, b = ((i + 1) % n) + 1;
        if (facing < 0) idx.push(0, a, b); else idx.push(0, b, a);
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      return g;
    };
    const fixWinding = (g: THREE.BufferGeometry, facing: number) => {
      // ensure CCW when seen from the facing side
      const idx = g.index!;
      const p = g.getAttribute('position');
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      a.fromBufferAttribute(p, idx.getX(0)); b.fromBufferAttribute(p, idx.getX(1)); c.fromBufferAttribute(p, idx.getX(2));
      const nz = b.sub(a).cross(c.sub(a)).z;
      if (Math.sign(nz) !== Math.sign(facing)) {
        const arr = idx.array as Uint16Array | Uint32Array;
        for (let i = 0; i < arr.length; i += 3) { const t = arr[i + 1]; arr[i + 1] = arr[i + 2]; arr[i + 2] = t; }
      }
      return g;
    };
    const m = M(x, y, z, 0, ry, 0);
    this.add(fixWinding(mk(-thick / 2, -1), -1), m, front);
    this.add(fixWinding(mk(thick / 2, 1), 1), m, back);
    // rim
    const rim = new THREE.CylinderGeometry(r, r, thick, n, 1, true, 0, Math.PI * 2);
    rim.rotateX(Math.PI / 2);
    rim.rotateZ(rot + Math.PI / 2);
    this.add(rim, m, back);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.mat, 1));
    g.setAttribute('aEmit', new THREE.Float32BufferAttribute(this.emit, 1));
    g.setAttribute('aSub', new THREE.Float32BufferAttribute(this.sub, 1));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------------------------
// Common parts / palette
// ---------------------------------------------------------------------------------------------

export const METAL: PO = { m: FMat.Metal };
export const RUBBER: PO = { m: FMat.Rubber, c: [0.05, 0.05, 0.05] };
const CONCRETE: PO = { m: FMat.Concrete, c: [0.6, 0.59, 0.56] };
const STONE: PO = { m: FMat.Stone };
export const GLASS: PO = { m: FMat.Glass };
const WOOD: PO = { m: FMat.Wood, c: [0.55, 0.36, 0.2] };
const BRONZE: PO = { m: FMat.Bronze };
const WATER: PO = { m: FMat.Water };
export const paint = (c: V, fixed = false): PO => ({ m: FMat.PaintedMetal, c, s: fixed ? 9 : 0 });
export const plastic = (c: V, fixed = false): PO => ({ m: FMat.Plastic, c, s: fixed ? 9 : 0 });
const sign = (emit = 0): PO => ({ m: FMat.Signage, e: emit, s: emit > 0 ? 7 : 0, c: [1, 1, 1] });
const LAMP = (e = 1): PO => ({ m: FMat.Light, e, s: 0, c: [1, 0.97, 0.9] });

const WARM: [number, number, number] = [1.0, 0.8, 0.55];
const LED: [number, number, number] = [0.95, 0.93, 1.0];

const fNoise = new Noise(0xf00d);

/** Fluted (grooved) column: cylinder with radial modulation. */
function fluted(fb: FB, po: PO, rBot: number, rTop: number, h: number, flutes: number, x: number, y: number, z: number) {
  const seg = flutes * 4;
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, true);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const px = p.getX(i), pz = p.getZ(i);
    const a = Math.atan2(pz, px);
    const k = 1 - 0.09 * Math.pow(Math.abs(Math.sin((a * flutes) / 2)), 3);
    p.setX(i, px * k);
    p.setZ(i, pz * k);
  }
  g.computeVertexNormals();
  g.translate(0, h / 2, 0);
  fb.add(g, M(x, y, z), po);
}

// ---------------------------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------------------------

type Lights = FurnitureModel['lights'];

function lampModern(fb: FB, v: number, lights: Lights): number {
  const H = 8.8;
  fb.cyl(CONCRETE, 0.32, 0.36, 0.12, 0, -0.02, 0, 16);
  fb.cyl(METAL, 0.22, 0.22, 0.03, 0, 0.1, 0, 16);
  fb.cyl(METAL, 0.15, 0.17, 0.55, 0, 0.12, 0, 8);
  fb.cyl(METAL, 0.065, 0.12, H - 0.6, 0, 0.6, 0, 14);
  fb.cyl(METAL, 0.072, 0.072, 0.05, 0, H - 0.35, 0, 14);
  if (v % 2 === 0) {
    // classic cobra head on a curved davit arm
    fb.tube(METAL, [[0, H - 0.6, 0], [0, H - 0.05, -0.15], [0, H + 0.25, -0.8], [0, H + 0.35, -1.7], [0, H + 0.38, -2.0]], 0.055, 8, 18, 0.042);
    const hz = -2.45, hy = H + 0.36;
    fb.sphere(METAL, 1, 0, hy, hz, 0.3, 0.14, 0.62, 16, 8, Math.PI / 2);
    fb.sphere(paint([0.42, 0.44, 0.45], true), 1, 0, hy, hz, 0.3, 0.05, 0.62, 16, 4);
    fb.sphere(LAMP(1), 1, 0, hy - 0.04, hz - 0.06, 0.22, 0.06, 0.45, 14, 6);
    lights.push({ pos: [0, hy - 0.12, hz], color: WARM, intensity: 1 });
  } else {
    // slim LED luminaire on a straight, slightly raised arm
    fb.rod(METAL, [0, H - 0.4, 0], [0, H + 0.1, -1.9], 0.045, 8, 0.035);
    fb.rod(METAL, [0, H - 1.0, 0], [0, H - 0.25, -1.0], 0.02, 6);
    const hz = -2.35, hy = H + 0.14;
    fb.box(paint([0.25, 0.27, 0.28], true), 0.34, 0.07, 0.9, 0, hy, hz, 0, -0.06);
    fb.box(LAMP(1), 0.26, 0.012, 0.72, 0, hy - 0.04, hz - 0.02, 0, -0.06);
    lights.push({ pos: [0, hy - 0.1, hz], color: LED, intensity: 1 });
  }
  return H + 0.5;
}

function lantern(fb: FB, x: number, y: number, z: number, body: PO, s = 1, lights: Lights) {
  // classic hexagonal lantern; y = bottom of lantern
  fb.lathe(body, [[0, 0], [0.05 * s, 0], [0.07 * s, 0.04 * s], [0.12 * s, 0.08 * s], [0.17 * s, 0.1 * s], [0.17 * s, 0.13 * s], [0, 0.13 * s]], 6, x, y, z, Math.PI / 6);
  fb.lathe(LAMP(1), [[0, 0.12 * s], [0.155 * s, 0.12 * s], [0.225 * s, 0.62 * s], [0, 0.62 * s]], 6, x, y, z, Math.PI / 6);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6 + Math.PI / 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    fb.rod(body, [x + ca * 0.165 * s, y + 0.12 * s, z + sa * 0.165 * s], [x + ca * 0.238 * s, y + 0.63 * s, z + sa * 0.238 * s], 0.012 * s, 4);
  }
  fb.lathe(body, [[0, 0.6 * s], [0.25 * s, 0.6 * s], [0.31 * s, 0.66 * s], [0.29 * s, 0.7 * s], [0.12 * s, 0.86 * s], [0.06 * s, 0.9 * s], [0.04 * s, 0.98 * s], [0, 0.98 * s]], 6, x, y, z, Math.PI / 6);
  fb.sphere(body, 0.045 * s, x, y + 1.0 * s, z, 1, 1, 1, 8, 6);
  lights.push({ pos: [x, y + 0.4 * s, z], color: WARM, intensity: 0.6 });
}

function lampClassic(fb: FB, v: number, lights: Lights): number {
  const body = paint([0.07, 0.11, 0.09]);
  // moulded base
  fb.lathe(body, [[0, 0], [0.26, 0], [0.26, 0.08], [0.22, 0.12], [0.2, 0.35], [0.24, 0.4], [0.24, 0.45], [0.16, 0.52], [0.13, 0.8], [0.15, 0.85], [0.15, 0.9], [0.11, 0.95], [0, 0.95]], 16);
  fluted(fb, body, 0.1, 0.075, 2.5, 12, 0, 0.95, 0);
  fb.lathe(body, [[0, 0], [0.11, 0], [0.12, 0.04], [0.09, 0.08], [0.09, 0.14], [0.11, 0.18], [0.07, 0.24], [0.06, 0.6], [0, 0.6]], 12, 0, 3.45, 0);
  if (v % 2 === 0) {
    // capital + single lantern
    fb.lathe(body, [[0, 0], [0.07, 0], [0.16, 0.08], [0.17, 0.12], [0, 0.12]], 12, 0, 4.05, 0);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      fb.tube(body, [[0, 3.85, 0], [Math.cos(a) * 0.12, 3.95, Math.sin(a) * 0.12], [Math.cos(a) * 0.16, 4.1, Math.sin(a) * 0.16]], 0.012, 4, 6);
    }
    lantern(fb, 0, 4.17, 0, body, 1, lights);
    return 5.15;
  }
  // two-arm candelabra with lanterns
  fb.lathe(body, [[0, 0], [0.07, 0], [0.09, 0.08], [0, 0.1]], 10, 0, 4.05, 0);
  for (const sd of [-1, 1]) {
    fb.tube(body, [[0, 4.0, 0], [sd * 0.25, 4.12, 0], [sd * 0.5, 4.08, 0], [sd * 0.62, 3.95, 0], [sd * 0.62, 3.88, 0]], 0.03, 6, 14);
    fb.tube(body, [[0, 3.8, 0], [sd * 0.2, 3.85, 0], [sd * 0.38, 3.97, 0], [sd * 0.4, 4.08, 0]], 0.012, 4, 8);
    lantern(fb, sd * 0.62, 3.88, 0, body, 0.85, lights);
  }
  fb.sphere(body, 0.06, 0, 4.2, 0, 1, 1.4, 1, 8, 6);
  return 4.8;
}

function lampDouble(fb: FB, v: number, lights: Lights): number {
  if (v % 2 === 1) {
    // classic double lantern for boulevards
    const body = paint([0.07, 0.11, 0.09]);
    fb.lathe(body, [[0, 0], [0.3, 0], [0.3, 0.1], [0.24, 0.16], [0.22, 0.45], [0.27, 0.5], [0.27, 0.56], [0.17, 0.62], [0.14, 1.0], [0, 1.0]], 16);
    fluted(fb, body, 0.11, 0.08, 3.0, 12, 0, 1.0, 0);
    fb.lathe(body, [[0, 0], [0.1, 0], [0.12, 0.06], [0.08, 0.14], [0.08, 0.3], [0, 0.3]], 12, 0, 4.0, 0);
    for (const sd of [-1, 1]) {
      fb.tube(body, [[0, 4.2, 0], [0, 4.35, sd * 0.3], [0, 4.4, sd * 0.65], [0, 4.3, sd * 0.85], [0, 4.2, sd * 0.86]], 0.035, 6, 14);
      fb.tube(body, [[0, 3.95, 0], [0, 4.05, sd * 0.3], [0, 4.25, sd * 0.5]], 0.014, 4, 8);
      lantern(fb, 0, 4.2, sd * 0.86, body, 0.95, lights);
    }
    fb.sphere(body, 0.07, 0, 4.42, 0, 1, 1.5, 1, 8, 6);
    return 5.2;
  }
  const H = 10;
  fb.cyl(CONCRETE, 0.34, 0.38, 0.12, 0, -0.02, 0, 16);
  fb.cyl(METAL, 0.17, 0.19, 0.6, 0, 0.1, 0, 8);
  fb.cyl(METAL, 0.07, 0.13, H - 0.6, 0, 0.6, 0, 14);
  fb.sphere(METAL, 0.075, 0, H, 0, 1, 0.6, 1, 10, 4, Math.PI / 2);
  for (const sd of [-1, 1]) {
    fb.tube(METAL, [[0, H - 0.5, 0], [0, H - 0.1, sd * 0.4], [0, H + 0.15, sd * 1.4], [0, H + 0.2, sd * 2.0]], 0.05, 8, 14, 0.038);
    const hz = sd * 2.4, hy = H + 0.2;
    fb.box(paint([0.25, 0.27, 0.28], true), 0.34, 0.08, 0.9, 0, hy, hz, 0, sd * 0.05);
    fb.box(LAMP(1), 0.26, 0.012, 0.72, 0, hy - 0.045, hz, 0, sd * 0.05);
    lights.push({ pos: [0, hy - 0.12, hz], color: LED, intensity: 1 });
  }
  return H + 0.3;
}

function signalHead(fb: FB, x: number, y: number, z: number, housing: PO, backplate: boolean) {
  // head faces +X; y = centre of the middle lens
  const w = 0.32, h = 1.0, d = 0.26;
  fb.box(housing, d, h, w, x, y, z);
  if (backplate) {
    fb.box(paint([0.05, 0.05, 0.05], true), 0.025, h + 0.28, w + 0.28, x - d / 2 - 0.01, y, z);
    // retro-reflective border
    fb.box(paint([0.95, 0.85, 0.1], true), 0.026, h + 0.28, 0.035, x - d / 2 - 0.01, y, z - (w + 0.28) / 2 + 0.02);
    fb.box(paint([0.95, 0.85, 0.1], true), 0.026, h + 0.28, 0.035, x - d / 2 - 0.01, y, z + (w + 0.28) / 2 - 0.02);
    fb.box(paint([0.95, 0.85, 0.1], true), 0.026, 0.035, w + 0.28, x - d / 2 - 0.01, y + (h + 0.28) / 2 - 0.02, z);
    fb.box(paint([0.95, 0.85, 0.1], true), 0.026, 0.035, w + 0.28, x - d / 2 - 0.01, y - (h + 0.28) / 2 + 0.02, z);
  }
  const codes: [number, V][] = [[1, [1.0, 0.1, 0.05]], [2, [1.0, 0.55, 0.0]], [3, [0.0, 0.95, 0.6]]];
  codes.forEach(([code, col], i) => {
    const ly = y + 0.32 - i * 0.32;
    fb.cyl({ m: FMat.Light, e: 1, s: code, c: col }, 0.105, 0.105, 0.02, x + d / 2, ly, z, 16, false, 0, 0, -Math.PI / 2);
    // visor: open half cylinder over the lens
    const g = new THREE.CylinderGeometry(0.125, 0.135, 0.24, 12, 1, true, -Math.PI * 1.1, Math.PI * 1.2);
    g.rotateZ(-Math.PI / 2);
    g.translate(x + d / 2 + 0.12, ly, z);
    fb.add(g, new THREE.Matrix4(), housing, undefined, true);
  });
}

function trafficLight(fb: FB, v: number): number {
  const housing = v % 2 === 0 ? paint([0.06, 0.06, 0.06], true) : paint([0.92, 0.72, 0.08], true);
  const H = 6.6, reach = 5.6;
  fb.cyl(CONCRETE, 0.4, 0.45, 0.1, 0, -0.02, 0, 12);
  fb.cyl(METAL, 0.28, 0.28, 0.04, 0, 0.08, 0, 12);
  fb.cyl(METAL, 0.17, 0.2, 0.5, 0, 0.1, 0, 8);
  fb.cyl(METAL, 0.11, 0.15, H, 0, 0.1, 0, 14);
  fb.sphere(METAL, 0.112, 0, H + 0.1, 0, 1, 0.7, 1, 10, 4, Math.PI / 2);
  // mast arm with flange and tie rod
  fb.box(METAL, 0.3, 0.45, 0.06, 0, 5.6, -0.13);
  fb.tube(METAL, [[0, 5.6, -0.1], [0, 5.68, -2], [0, 5.82, -4], [0, 5.92, -reach]], 0.1, 10, 16, 0.055);
  fb.rod(METAL, [0, 6.4, -0.12], [0, 5.78, -3.2], 0.02, 5);
  fb.sphere(METAL, 0.06, 0, 5.92, -reach, 1, 1, 1, 8, 6);
  // heads on the arm
  for (const z of [-2.9, -5.0]) {
    fb.rod(METAL, [0, 5.78, z], [0, 5.35, z], 0.025, 6);
    signalHead(fb, 0.0, 4.8, z, housing, true);
  }
  // street name blade on the arm
  fb.panel(sign(), 1.5, 0.3, 0, 6.15, -1.6, -Math.PI / 2, 15);
  fb.panel(sign(), 1.5, 0.3, 0, 6.15, -1.6, Math.PI / 2, 15);
  fb.rod(METAL, [0, 5.75, -1.6], [0, 6.0, -1.6], 0.015, 4);
  // near-side head on the pole
  fb.box(METAL, 0.18, 0.08, 0.08, 0.2, 3.25, 0);
  signalHead(fb, 0.38, 3.0, 0, housing, false);
  // pedestrian head (faces -Z): upper "don't walk" hand, lower "walk" figure
  const ph = paint([0.06, 0.06, 0.06], true);
  fb.box(METAL, 0.06, 0.1, 0.2, 0, 2.55, -0.18);
  fb.box(ph, 0.36, 0.64, 0.22, 0, 2.55, -0.36);
  fb.panel({ m: FMat.Light, e: 1, s: 4, c: [1, 0.45, 0.1] }, 0.28, 0.26, 0, 2.7, -0.475, 0, 7);
  fb.panel({ m: FMat.Light, e: 1, s: 5, c: [0.95, 0.95, 1] }, 0.28, 0.26, 0, 2.4, -0.475, 0, 8);
  for (const yy of [2.7, 2.4]) fb.box(ph, 0.34, 0.025, 0.12, 0, yy + 0.14, -0.52);
  // push button
  fb.box(paint([0.9, 0.75, 0.1], true), 0.12, 0.2, 0.08, 0, 1.15, -0.15);
  fb.cyl(METAL, 0.03, 0.03, 0.02, 0, 1.12, -0.19, 10, false, Math.PI / 2);
  return H + 0.2;
}

function bench(fb: FB, v: number): number {
  const iron = paint([0.08, 0.1, 0.09]);
  const L = 1.9;
  if (v % 2 === 1) {
    // backless modern bench: concrete blocks + timber top
    for (const x of [-0.7, 0.7]) fb.box(CONCRETE, 0.25, 0.4, 0.55, x, 0.2, 0);
    for (let i = 0; i < 6; i++) fb.box(WOOD, L + 0.1, 0.05, 0.075, 0, 0.425, -0.22 + i * 0.088);
    return 0.45;
  }
  for (const sx of [-1, 1]) {
    const x = sx * (L / 2 - 0.12);
    // cast iron end frame: front leg, rear leg, seat bearer, back post, armrest with scroll
    fb.box(iron, 0.05, 0.45, 0.06, x, 0.225, -0.24, 0, 0.12);
    fb.box(iron, 0.05, 0.47, 0.06, x, 0.23, 0.24, 0, -0.18);
    fb.box(iron, 0.05, 0.06, 0.58, x, 0.42, 0.0);
    fb.box(iron, 0.05, 0.55, 0.06, x, 0.7, 0.29, 0, -0.26);
    fb.tube(iron, [[x, 0.42, -0.24], [x, 0.58, -0.28], [x, 0.66, -0.2], [x, 0.66, 0.1], [x, 0.62, 0.25]], 0.022, 6, 12);
    fb.add(new THREE.TorusGeometry(0.04, 0.012, 5, 12), M(x, 0.62, -0.28, 0, Math.PI / 2), iron);
    fb.box(RUBBER, 0.07, 0.02, 0.08, x, 0.01, -0.27);
    fb.box(RUBBER, 0.07, 0.02, 0.08, x, 0.01, 0.29);
  }
  for (let i = 0; i < 5; i++) fb.box(WOOD, L, 0.035, 0.085, 0, 0.465, -0.22 + i * 0.1);
  for (let i = 0; i < 3; i++) {
    const t = i / 2;
    fb.box(WOOD, L, 0.09, 0.03, 0, 0.6 + t * 0.26, 0.26 + t * 0.075, 0, -0.27);
  }
  return 0.9;
}

function bin(fb: FB, v: number): number {
  const green = paint([0.1, 0.24, 0.17]);
  if (v % 2 === 1) {
    // post-mounted hoop with a bag
    fb.cyl(green, 0.04, 0.04, 1.05, 0, 0, 0.3, 10);
    fb.add(new THREE.TorusGeometry(0.22, 0.015, 6, 20), M(0, 0.95, 0.06, Math.PI / 2), green);
    fb.add(new THREE.TorusGeometry(0.22, 0.012, 6, 20), M(0, 0.55, 0.06, Math.PI / 2), green);
    fb.rod(green, [0, 0.95, 0.28], [0, 0.95, 0.27], 0.03);
    fb.box(green, 0.05, 0.45, 0.04, 0, 0.75, 0.27);
    fb.lathe(plastic([0.3, 0.55, 0.3], true), [[0.0, 0.3], [0.12, 0.31], [0.19, 0.45], [0.21, 0.75], [0.215, 0.96], [0.2, 0.97], [0.0, 0.97]], 14, 0, 0, 0.06);
    return 1.05;
  }
  const r = 0.27, H = 0.92;
  fb.cyl(paint([0.06, 0.06, 0.06], true), r - 0.03, r - 0.03, 0.05, 0, 0, 0, 16);
  fb.cyl({ m: FMat.Metal }, r - 0.04, r - 0.05, H - 0.1, 0, 0.04, 0, 16, true);
  const n = 18;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    fb.box(green, 0.06, H - 0.12, 0.018, Math.cos(a) * r, 0.06 + (H - 0.12) / 2, Math.sin(a) * r, -a + Math.PI / 2);
  }
  for (const y of [0.08, H - 0.07]) fb.add(new THREE.TorusGeometry(r + 0.005, 0.018, 6, 24), M(0, y, 0, Math.PI / 2), green);
  // domed lid with front opening
  fb.lathe(green, [[0, 0.16], [0.1, 0.15], [0.22, 0.09], [r + 0.02, 0.02], [r + 0.02, 0], [0, 0]].reverse() as [number, number][], 18, 0, H - 0.04, 0);
  fb.box(paint([0.03, 0.03, 0.03], true), 0.22, 0.09, 0.02, 0, H + 0.02, -r + 0.02, 0, 0.5);
  fb.panel(sign(), 0.12, 0.12, 0, 0.6, -r - 0.012, 0, 13);
  return H + 0.16;
}

function hydrant(fb: FB, v: number): number {
  const body = paint(v % 2 === 0 ? [0.72, 0.08, 0.06] : [0.92, 0.7, 0.08]);
  const caps = paint(v % 2 === 0 ? [0.72, 0.08, 0.06] : [0.15, 0.3, 0.6], true);
  fb.lathe(body, [[0, 0], [0.17, 0], [0.17, 0.04], [0.13, 0.07], [0.12, 0.09], [0.12, 0.5], [0.135, 0.52], [0.135, 0.56], [0.12, 0.58], [0.115, 0.62], [0.1, 0.7], [0.05, 0.74], [0, 0.745]], 16);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    fb.cyl(METAL, 0.012, 0.012, 0.02, Math.cos(a) * 0.15, 0.04, Math.sin(a) * 0.15, 6);
  }
  fb.cyl(caps, 0.03, 0.035, 0.05, 0, 0.73, 0, 5);
  // side hose nozzles (±X) and pumper nozzle (-Z)
  for (const sx of [-1, 1]) {
    fb.cyl(body, 0.045, 0.05, 0.08, sx * 0.1, 0.42, 0, 12, false, 0, 0, -sx * Math.PI / 2);
    fb.cyl(caps, 0.05, 0.05, 0.04, sx * 0.18, 0.42, 0, 12, false, 0, 0, -sx * Math.PI / 2);
    fb.cyl(caps, 0.018, 0.018, 0.03, sx * 0.22, 0.42, 0, 5, false, 0, 0, -sx * Math.PI / 2);
  }
  fb.cyl(body, 0.07, 0.075, 0.09, 0, 0.36, -0.09, 14, false, -Math.PI / 2);
  fb.cyl(caps, 0.075, 0.075, 0.05, 0, 0.36, -0.18, 14, false, -Math.PI / 2);
  fb.cyl(caps, 0.025, 0.025, 0.03, 0, 0.36, -0.23, 5, false, -Math.PI / 2);
  return 0.76;
}

function mailbox(fb: FB, v: number): number {
  if (v % 2 === 1) {
    // pillar box
    const red = paint([0.72, 0.05, 0.04], true);
    fb.lathe(paint([0.05, 0.05, 0.05], true), [[0, 0], [0.3, 0], [0.3, 0.12], [0, 0.12]], 20);
    fb.lathe(red, [[0, 0.12], [0.27, 0.12], [0.27, 0.18], [0.25, 0.2], [0.25, 1.1], [0.29, 1.14], [0.29, 1.2], [0.26, 1.23], [0.2, 1.36], [0.1, 1.42], [0, 1.44]], 20);
    fb.box(paint([0.03, 0.03, 0.03], true), 0.26, 0.035, 0.04, 0, 1.0, -0.245);
    fb.box(red, 0.3, 0.03, 0.06, 0, 1.03, -0.25);
    fb.panel(sign(), 0.2, 0.26, 0, 0.75, -0.252, 0, 12);
    fb.panel(sign(), 0.24, 0.07, 0, 1.17, -0.292, 0, 11);
    return 1.44;
  }
  const blue = paint([0.1, 0.2, 0.48]);
  const W = 0.46, D = 0.52, bodyH = 0.75, y0 = 0.32;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) fb.box(blue, 0.05, y0 + 0.02, 0.05, sx * (W / 2 - 0.04), (y0 + 0.02) / 2, sz * (D / 2 - 0.04));
  fb.box(blue, W, bodyH, D, 0, y0 + bodyH / 2, 0);
  // rounded top (half cylinder along Z)
  const g = new THREE.CylinderGeometry(W / 2, W / 2, D, 18, 1, false, Math.PI / 2, Math.PI);
  g.rotateX(Math.PI / 2);
  fb.add(g, M(0, y0 + bodyH, 0), blue);
  // pull-down chute handle
  fb.box(blue, 0.32, 0.14, 0.04, 0, y0 + bodyH + 0.06, -D / 2 - 0.02, 0, 0.35);
  fb.box(METAL, 0.16, 0.025, 0.03, 0, y0 + bodyH + 0.14, -D / 2 - 0.05);
  fb.panel(sign(), 0.34, 0.3, 0, y0 + bodyH * 0.5, -D / 2 - 0.002, 0, 11);
  fb.panel(sign(), 0.36, 0.3, -W / 2 - 0.002, y0 + bodyH * 0.55, 0, -Math.PI / 2, 11);
  fb.panel(sign(), 0.36, 0.3, W / 2 + 0.002, y0 + bodyH * 0.55, 0, Math.PI / 2, 11);
  return y0 + bodyH + W / 2;
}

function bollard(fb: FB, v: number): number {
  if (v % 2 === 1) {
    fb.cyl(METAL, 0.065, 0.065, 0.9, 0, 0, 0, 14);
    fb.sphere(METAL, 0.065, 0, 0.9, 0, 1, 0.5, 1, 14, 4, Math.PI / 2);
    fb.cyl({ m: FMat.Light, e: 0.15, s: 9, c: [0.95, 0.95, 0.95] }, 0.067, 0.067, 0.05, 0, 0.72, 0, 14, true);
    fb.cyl({ m: FMat.Light, e: 0.15, s: 9, c: [0.95, 0.95, 0.95] }, 0.067, 0.067, 0.05, 0, 0.62, 0, 14, true);
    return 0.93;
  }
  const iron = paint([0.06, 0.07, 0.07]);
  fb.lathe(iron, [[0, 0], [0.12, 0], [0.12, 0.05], [0.1, 0.08], [0.095, 0.62], [0.11, 0.65], [0.11, 0.69], [0.09, 0.71], [0.085, 0.8], [0.1, 0.82], [0.1, 0.86], [0.07, 0.92], [0.03, 0.96], [0, 0.97]], 14);
  return 0.97;
}

function foliageBall(fb: FB, r: number, x: number, y: number, z: number, col: V, seed: number) {
  const g = new THREE.IcosahedronGeometry(r, 2);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
    const k = 1 + 0.18 * fNoise.n3(vx * 4 + seed, vy * 4, vz * 4) + 0.08 * fNoise.n3(vx * 11, vy * 11 + seed, vz * 11);
    p.setXYZ(i, vx * k, vy * k * 0.85, vz * k);
  }
  g.deleteAttribute('normal');
  const mg = mergeVertsNormals(g);
  fb.add(mg, M(x, y, z), { m: FMat.Plastic, c: col, s: 8 });
}

/** Normals for the non-indexed polyhedron: average by position. */
function mergeVertsNormals(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  const map = new Map<string, number>();
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
    let k = map.get(key);
    if (k === undefined) { k = pos.length / 3; map.set(key, k); pos.push(p.getX(i), p.getY(i), p.getZ(i)); }
    idx.push(k);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((pos.length / 3) * 2).fill(0), 2));
  out.setIndex(idx);
  out.computeVertexNormals();
  g.dispose();
  return out;
}

function planter(fb: FB, v: number): number {
  const leaf: V = [0.22, 0.38, 0.14];
  if (v % 2 === 1) {
    // round timber planter
    const n = 20, r = 0.45;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      fb.box(WOOD, 0.14, 0.55, 0.04, Math.cos(a) * r, 0.275, Math.sin(a) * r, -a + Math.PI / 2);
    }
    for (const y of [0.1, 0.45]) fb.add(new THREE.TorusGeometry(r + 0.025, 0.012, 5, 24), M(0, y, 0, Math.PI / 2), METAL);
    fb.cyl({ m: FMat.Concrete, c: [0.2, 0.15, 0.1] }, r - 0.02, r - 0.02, 0.5, 0, 0.02, 0, 16);
    foliageBall(fb, 0.45, 0, 0.85, 0, leaf, 3);
    foliageBall(fb, 0.3, 0.2, 0.7, -0.15, [0.25, 0.42, 0.16], 7);
    return 1.25;
  }
  const W = 1.3, H = 0.55;
  fb.box(CONCRETE, W, 0.08, W, 0, 0.04, 0);
  for (const [x, z, w, d] of [[0, -W / 2 + 0.06, W, 0.12], [0, W / 2 - 0.06, W, 0.12], [-W / 2 + 0.06, 0, 0.12, W - 0.24], [W / 2 - 0.06, 0, 0.12, W - 0.24]] as [number, number, number, number][]) {
    fb.box(CONCRETE, w, H, d, x, H / 2, z);
  }
  fb.box({ m: FMat.Concrete, c: [0.2, 0.15, 0.1], s: 9 }, W - 0.24, 0.02, W - 0.24, 0, H - 0.06, 0);
  foliageBall(fb, 0.42, -0.15, H + 0.25, 0.1, leaf, 1);
  foliageBall(fb, 0.36, 0.22, H + 0.2, -0.15, [0.2, 0.34, 0.12], 2);
  foliageBall(fb, 0.3, 0.1, H + 0.45, 0.2, [0.26, 0.42, 0.15], 5);
  return H + 0.85;
}

function busStop(fb: FB, v: number, lights: Lights): number {
  const frame = v % 2 === 0 ? { m: FMat.Metal } as PO : paint([0.12, 0.13, 0.14], true);
  const L = 4.2, D = 1.5, H = 2.5;
  const zb = D / 2 - 0.05;
  // posts
  for (const x of [-L / 2, -L / 6, L / 6, L / 2]) {
    fb.box(frame, 0.08, H, 0.08, x, H / 2, zb);
    if (Math.abs(x) > L / 3) fb.box(frame, 0.08, H, 0.08, x, H / 2, -D / 2 + 0.25);
  }
  // roof: sloped canopy with fascia
  fb.box(frame, L + 0.4, 0.12, D + 0.3, 0, H + 0.08, 0.0, 0, 0.04);
  fb.box(GLASS, L + 0.2, 0.02, D + 0.1, 0, H + 0.15, 0.0, 0, 0.04);
  fb.box(frame, L + 0.42, 0.22, 0.05, 0, H + 0.03, -D / 2 - 0.15);
  fb.box(LAMP(1), L - 0.4, 0.02, 0.08, 0, H + 0.01, 0.1);
  // back glass wall (3 panes) and side glass
  for (let i = 0; i < 3; i++) {
    const x = -L / 3 + i * (L / 3);
    fb.box(GLASS, L / 3 - 0.1, H - 0.4, 0.015, x, (H - 0.4) / 2 + 0.2, zb);
    fb.box(frame, L / 3 - 0.08, 0.05, 0.05, x, 0.18, zb);
    fb.box(frame, L / 3 - 0.08, 0.05, 0.05, x, H - 0.2, zb);
  }
  fb.box(GLASS, 0.015, H - 0.4, D - 0.35, -L / 2, (H - 0.4) / 2 + 0.2, 0.08);
  // ad panel at +X end (back-lit)
  const ax = L / 2;
  fb.box(frame, 0.16, 1.95, 1.32, ax, 0.2 + 1.95 / 2, 0.08);
  fb.panel(sign(1), 1.18, 1.75, ax - 0.082, 0.2 + 1.95 / 2, 0.08, Math.PI / 2, v % 2 === 0 ? 3 : 4);
  fb.panel(sign(1), 1.18, 1.75, ax + 0.082, 0.2 + 1.95 / 2, 0.08, -Math.PI / 2, v % 2 === 0 ? 4 : 3);
  // bench
  for (const x of [-1.2, 0, 1.2]) fb.box(frame, 0.05, 0.45, 0.05, x, 0.225, zb - 0.25);
  fb.box(WOOD, 2.8, 0.04, 0.38, 0, 0.47, zb - 0.25);
  // timetable inside
  fb.panel(sign(1), 0.6, 0.8, -1.2, 1.5, zb - 0.012, 0, 13);
  // bus stop sign pole at -X front
  fb.cyl(METAL, 0.035, 0.035, 2.9, -L / 2 - 0.5, 0, -D / 2 - 0.1, 10);
  fb.polyPlate(sign(), sign(), 24, 0.34, 0.03, -L / 2 - 0.5, 2.55, -D / 2 - 0.1, 0, 2);
  fb.box(METAL, 0.32, 0.45, 0.05, -L / 2 - 0.5, 1.6, -D / 2 - 0.1);
  fb.panel(sign(), 0.28, 0.4, -L / 2 - 0.5, 1.6, -D / 2 - 0.1 - 0.027, 0, 13);
  lights.push({ pos: [0, H - 0.05, 0.1], color: LED, intensity: 0.35 });
  return H + 0.25;
}

function fountain(fb: FB, v: number): number {
  const R = v % 2 === 0 ? 3.0 : 2.4;
  const st = STONE;
  fb.lathe(st, [[R - 0.35, 0.12], [R - 0.35, 0.5], [R - 0.3, 0.55], [R + 0.12, 0.55], [R + 0.16, 0.5], [R + 0.12, 0.45], [R + 0.08, 0.1], [R + 0.18, 0.04], [R + 0.18, -0.05]].reverse() as [number, number][], 48);
  fb.lathe(st, [[0, 0.05], [R - 0.3, 0.05], [R - 0.3, 0.12]].reverse() as [number, number][], 48);
  fb.lathe(WATER, [[0, 0.4], [R - 0.34, 0.4]].reverse() as [number, number][], 48);
  // central column + tiers
  fb.lathe(st, [[0, 0.05], [0.55, 0.05], [0.55, 0.25], [0.45, 0.3], [0.32, 0.4], [0.25, 0.7], [0.22, 1.1], [0.3, 1.18], [0, 1.18]], 20);
  fb.lathe(st, [[0, 1.12], [0.3, 1.12], [0.7, 1.22], [1.1, 1.35], [1.18, 1.45], [1.12, 1.47], [1.05, 1.42], [0.3, 1.36], [0, 1.36]], 32);
  fb.lathe(WATER, [[0, 1.41], [1.06, 1.41]].reverse() as [number, number][], 32);
  fb.lathe(st, [[0, 1.36], [0.17, 1.36], [0.14, 1.7], [0.12, 2.0], [0.18, 2.06], [0, 2.06]], 16);
  fb.lathe(st, [[0, 2.02], [0.15, 2.02], [0.4, 2.1], [0.6, 2.2], [0.64, 2.27], [0.58, 2.28], [0.15, 2.2], [0, 2.2]], 24);
  fb.lathe(WATER, [[0, 2.25], [0.58, 2.25]].reverse() as [number, number][], 24);
  fb.lathe(st, [[0, 2.2], [0.08, 2.2], [0.1, 2.35], [0.05, 2.45], [0.06, 2.5], [0, 2.52]], 12);
  // falling water sheets from bowl rims and the jet
  fb.lathe({ m: FMat.Water, e: 0, s: 1 }, [[1.17, 1.44], [1.22, 1.3], [1.28, 0.9], [1.32, 0.42]].reverse() as [number, number][], 32);
  fb.lathe({ m: FMat.Water, e: 0, s: 1 }, [[0.63, 2.26], [0.68, 2.1], [0.72, 1.7], [0.74, 1.42]].reverse() as [number, number][], 24);
  fb.lathe({ m: FMat.Water, e: 0, s: 1 }, [[0.0, 3.25], [0.05, 3.2], [0.04, 2.9], [0.03, 2.5]].reverse() as [number, number][], 10);
  fb.lathe({ m: FMat.Water, e: 0, s: 1 }, [[0.03, 3.22], [0.18, 3.15], [0.35, 2.85], [0.45, 2.4], [0.5, 2.26]].reverse() as [number, number][], 16);
  return 3.3;
}

function human(fb: FB, x: number, y: number, z: number, s: number, pose: number, po: PO) {
  // a stylised standing figure facing -Z; y = feet
  const P = (px: number, py: number, pz: number): V => [x + px * s, y + py * s, z + pz * s];
  // legs and shoes
  for (const sx of [-1, 1]) {
    fb.capsule(po, P(sx * 0.11, 0.08, -0.02), P(sx * 0.1, 0.5, 0), 0.06 * s, 0.07 * s, 8);
    fb.capsule(po, P(sx * 0.1, 0.5, 0), P(sx * 0.1, 0.92, 0.01), 0.07 * s, 0.085 * s, 8);
    fb.sphere(po, 0.07 * s, ...P(sx * 0.11, 0.05, -0.07), 1, 0.6, 1.7, 8, 5);
  }
  // long coat
  fb.lathe(po, [[0.0, 0.62], [0.27, 0.62], [0.24, 0.9], [0.2, 1.1], [0.0, 1.1]].map(([r, yy]) => [r * s, yy * s]) as [number, number][], 14, x, y, z, 0, 1.1, 0.85);
  // torso
  fb.lathe(po, [[0, 1.05], [0.19, 1.08], [0.21, 1.3], [0.23, 1.45], [0.2, 1.52], [0.08, 1.56], [0, 1.56]].map(([r, yy]) => [r * s, yy * s]) as [number, number][], 14, x, y, z, 0, 1.15, 0.75);
  // neck + head
  fb.capsule(po, P(0, 1.52, 0), P(0, 1.6, 0), 0.055 * s, 0.05 * s, 8);
  fb.sphere(po, 0.11 * s, ...P(0, 1.71, -0.01), 0.9, 1.1, 1.0, 12, 9);
  fb.sphere(po, 0.03 * s, ...P(0, 1.69, -0.11), 1, 1.3, 1, 6, 4);
  // arms
  fb.capsule(po, P(-0.25, 1.46, 0), P(-0.3, 1.15, 0.02), 0.055 * s, 0.05 * s, 8);
  fb.capsule(po, P(-0.3, 1.15, 0.02), P(-0.3, 0.9, -0.04), 0.05 * s, 0.04 * s, 8);
  if (pose === 0) {
    fb.capsule(po, P(0.25, 1.46, 0), P(0.4, 1.62, -0.25), 0.055 * s, 0.05 * s, 8);
    fb.capsule(po, P(0.4, 1.62, -0.25), P(0.5, 1.82, -0.5), 0.05 * s, 0.04 * s, 8);
  } else {
    fb.capsule(po, P(0.25, 1.46, 0), P(0.3, 1.2, -0.12), 0.055 * s, 0.05 * s, 8);
    fb.capsule(po, P(0.3, 1.2, -0.12), P(0.12, 1.25, -0.22), 0.05 * s, 0.04 * s, 8);
  }
}

function statue(fb: FB, v: number): number {
  const equestrian = v % 2 === 1;
  const pw = equestrian ? 1.8 : 1.5, pd = equestrian ? 3.2 : 1.5, ph = equestrian ? 2.2 : 2.0;
  // pedestal: steps, base moulding, die, cornice
  fb.box(STONE, pw + 0.8, 0.2, pd + 0.8, 0, 0.1, 0);
  fb.box(STONE, pw + 0.45, 0.2, pd + 0.45, 0, 0.3, 0);
  fb.box(STONE, pw + 0.2, 0.15, pd + 0.2, 0, 0.475, 0);
  fb.box(STONE, pw, ph - 0.85, pd, 0, 0.55 + (ph - 0.85) / 2, 0);
  fb.box(STONE, pw + 0.22, 0.12, pd + 0.22, 0, ph - 0.24, 0);
  fb.box(STONE, pw + 0.1, 0.1, pd + 0.1, 0, ph - 0.13, 0);
  fb.box(STONE, pw - 0.1, 0.08, pd - 0.1, 0, ph - 0.04, 0);
  fb.box(BRONZE, pw * 0.55, 0.35, 0.03, 0, 1.15, -pd / 2 - 0.01);
  const top = ph;
  if (!equestrian) {
    fb.box(BRONZE, 0.9, 0.06, 0.9, 0, top + 0.03, 0);
    human(fb, 0, top + 0.06, 0, 1.45, 0, BRONZE);
    return top + 2.9;
  }
  // horse (facing -Z), rider on top
  const y0 = top + 0.06;
  fb.box(BRONZE, 1.0, 0.06, 2.6, 0, top + 0.03, 0);
  const H = (px: number, py: number, pz: number): V => [px, y0 + py, pz];
  fb.capsule(BRONZE, H(0, 1.45, 0.55), H(0, 1.5, -0.6), 0.36, 0.38, 14);
  fb.sphere(BRONZE, 0.42, ...H(0, 1.45, 0.62), 1, 0.95, 1.05, 12, 8);
  fb.capsule(BRONZE, H(0, 1.6, -0.75), H(0, 2.2, -1.05), 0.26, 0.17, 12);
  fb.capsule(BRONZE, H(0, 2.25, -1.05), H(0, 2.0, -1.45), 0.14, 0.08, 10);
  fb.sphere(BRONZE, 0.06, ...H(-0.08, 2.38, -1.0), 1, 2, 1, 6, 4);
  fb.sphere(BRONZE, 0.06, ...H(0.08, 2.38, -1.0), 1, 2, 1, 6, 4);
  fb.box(BRONZE, 0.08, 0.5, 0.25, 0, 2.05, -0.95);
  // legs: hind legs planted, one front leg raised
  for (const sx of [-1, 1]) {
    fb.capsule(BRONZE, H(sx * 0.2, 1.3, 0.7), H(sx * 0.2, 0.75, 0.82), 0.14, 0.08, 8);
    fb.capsule(BRONZE, H(sx * 0.2, 0.75, 0.82), H(sx * 0.2, 0.06, 0.72), 0.07, 0.065, 8);
  }
  fb.capsule(BRONZE, H(-0.2, 1.25, -0.65), H(-0.2, 0.7, -0.7), 0.11, 0.07, 8);
  fb.capsule(BRONZE, H(-0.2, 0.7, -0.7), H(-0.2, 0.06, -0.72), 0.065, 0.065, 8);
  fb.capsule(BRONZE, H(0.2, 1.25, -0.65), H(0.2, 1.0, -1.1), 0.11, 0.07, 8);
  fb.capsule(BRONZE, H(0.2, 1.0, -1.1), H(0.2, 0.62, -1.0), 0.065, 0.06, 8);
  fb.tube(BRONZE, [H(0, 1.6, 1.0), H(0, 1.4, 1.2), H(0, 0.9, 1.25), H(0, 0.55, 1.18)], 0.09, 8, 10, 0.04);
  // rider
  const R = (px: number, py: number, pz: number): V => [px, y0 + py, pz];
  for (const sx of [-1, 1]) {
    fb.capsule(BRONZE, R(sx * 0.2, 1.95, -0.05), R(sx * 0.42, 1.55, -0.25), 0.09, 0.075, 8);
    fb.capsule(BRONZE, R(sx * 0.42, 1.55, -0.25), R(sx * 0.42, 1.1, -0.1), 0.07, 0.06, 8);
  }
  fb.lathe(BRONZE, [[0, 1.85], [0.22, 1.9], [0.24, 2.2], [0.25, 2.45], [0.2, 2.52], [0.07, 2.56], [0, 2.56]], 12, 0, y0, 0, 0, 1.15, 0.75);
  fb.capsule(BRONZE, R(0, 2.52, 0), R(0, 2.6, 0), 0.055, 0.05, 8);
  fb.sphere(BRONZE, 0.12, ...R(0, 2.72, -0.01), 0.9, 1.1, 1, 12, 8);
  fb.lathe(BRONZE, [[0, 0], [0.2, 0], [0.2, 0.02], [0.1, 0.05], [0.09, 0.15], [0, 0.16]], 12, 0, y0 + 2.8, 0);
  fb.capsule(BRONZE, R(-0.27, 2.45, 0), R(-0.25, 2.1, -0.3), 0.055, 0.05, 8);
  fb.capsule(BRONZE, R(-0.25, 2.1, -0.3), R(-0.1, 2.05, -0.55), 0.05, 0.04, 8);
  fb.capsule(BRONZE, R(0.27, 2.45, 0), R(0.45, 2.7, -0.3), 0.055, 0.05, 8);
  fb.capsule(BRONZE, R(0.45, 2.7, -0.3), R(0.55, 3.05, -0.55), 0.05, 0.04, 8);
  fb.rod(BRONZE, R(0.55, 2.9, -0.4), R(0.62, 3.6, -0.75), 0.02, 6);
  return y0 + 3.6;
}

function kiosk(fb: FB, v: number): number {
  const green = paint([0.08, 0.22, 0.16]);
  if (v % 2 === 0) {
    // Parisian-style octagonal kiosk
    const R = 1.25;
    fb.lathe(green, [[0, 0], [R + 0.05, 0], [R + 0.05, 0.12], [R, 0.15], [R, 1.0], [R + 0.04, 1.05], [R + 0.04, 1.1], [0, 1.1]], 8, 0, 0, 0, Math.PI / 8);
    fb.lathe(GLASS, [[R - 0.05, 1.1], [R - 0.05, 2.1], [0, 2.1]], 8, 0, 0, 0, Math.PI / 8);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      fb.box(green, 0.07, 1.0, 0.07, Math.cos(a) * (R - 0.02), 1.6, Math.sin(a) * (R - 0.02));
    }
    // sign band (8 panels)
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const rr = R * Math.cos(Math.PI / 8) + 0.06;
      const w = 2 * R * Math.sin(Math.PI / 8) + 0.06;
      fb.box(green, w, 0.4, 0.04, Math.cos(a) * (rr - 0.03), 2.3, Math.sin(a) * (rr - 0.03), -a + Math.PI / 2);
      fb.panel(sign(1), w * 0.9, 0.32, Math.cos(a) * (rr - 0.005), 2.3, Math.sin(a) * (rr - 0.005), -a - Math.PI / 2, 10);
    }
    // flared roof / onion dome and finial
    fb.lathe(green, [[0, 2.5], [R + 0.35, 2.5], [R + 0.38, 2.56], [R + 0.1, 2.75], [0.8, 2.95], [0.5, 3.25], [0.35, 3.5], [0.25, 3.6], [0, 3.62]], 8, 0, 0, 0, Math.PI / 8);
    fb.lathe(green, [[0, 3.6], [0.08, 3.6], [0.12, 3.75], [0.04, 3.95], [0, 4.1]], 8);
    // counter + magazines on the front
    fb.box(green, 1.0, 0.06, 0.3, 0, 1.12, -R - 0.12);
    fb.panel(sign(), 0.95, 0.75, 0, 1.55, -R + 0.01, 0, 5, -0.12);
    return 4.1;
  }
  // modern box kiosk with awning
  const W = 3.0, D = 2.0, H = 2.6;
  fb.box(green, W, 1.0, D, 0, 0.5, 0);
  fb.box(GLASS, W - 0.1, H - 1.0, D - 0.1, 0, 1.0 + (H - 1.0) / 2, 0);
  for (const x of [-W / 2, W / 2]) for (const z of [-D / 2, D / 2]) fb.box(green, 0.08, H, 0.08, x, H / 2, z);
  fb.box(green, W + 0.2, 0.18, D + 0.2, 0, H + 0.09, 0);
  fb.panel(sign(1), W - 0.3, 0.32, 0, H + 0.4, -D / 2 - 0.06, 0, 10);
  fb.box(green, W, 0.4, 0.1, 0, H + 0.4, -D / 2);
  // striped awning
  for (let i = 0; i < 8; i++) {
    const x = -W / 2 + (i + 0.5) * (W / 8);
    fb.box(paint(i % 2 === 0 ? [0.85, 0.82, 0.75] : [0.1, 0.3, 0.2], true), W / 8, 0.02, 0.9, x, H - 0.1, -D / 2 - 0.4, 0, -0.35);
  }
  fb.box(green, W + 0.04, 0.06, 0.12, 0, 1.05, -D / 2 - 0.15);
  fb.panel(sign(), W - 0.4, 0.7, 0, 1.5, -D / 2 - 0.06, 0, 5);
  return H + 0.6;
}

function stopSign(fb: FB, v: number): number {
  const post = v % 2 === 0;
  if (post) fb.box(METAL, 0.05, 2.6, 0.05, 0, 1.3, 0.03);
  else fb.cyl(METAL, 0.03, 0.03, 2.6, 0, 0, 0.03, 10);
  fb.polyPlate(sign(), METAL, 8, 0.4, 0.012, 0, 2.2, -0.0, 0, 0, Math.PI / 8);
  fb.box(METAL, 0.06, 0.08, 0.04, 0, 2.38, 0.02);
  fb.box(METAL, 0.06, 0.08, 0.04, 0, 2.02, 0.02);
  return 2.65;
}

function playground(fb: FB, v: number): number {
  const c1: V = v % 2 === 0 ? [0.85, 0.15, 0.1] : [0.1, 0.45, 0.8];
  const c2: V = v % 2 === 0 ? [0.95, 0.75, 0.1] : [0.2, 0.7, 0.3];
  const post = paint([0.15, 0.4, 0.2], true);
  const ox = -2.2;
  // tower: 4 posts, platform, roof
  for (const x of [-0.6, 0.6]) for (const z of [-0.6, 0.6]) fb.box(WOOD, 0.1, 3.0, 0.1, ox + x, 1.5, z);
  fb.box(WOOD, 1.3, 0.06, 1.3, ox, 1.5, 0);
  fb.lathe(plastic(c1, true), [[0, 3.6], [0.95, 2.95], [0.95, 2.9], [0, 2.9]].reverse() as [number, number][], 4, ox, 0, 0, Math.PI / 4);
  // railings / panels
  fb.box(plastic(c2, true), 1.2, 0.6, 0.03, ox, 1.85, 0.62);
  fb.box(plastic(c2, true), 0.03, 0.6, 1.2, ox - 0.62, 1.85, 0);
  for (let i = 0; i < 5; i++) fb.rod(post, [ox + 0.62, 1.53, -0.5 + i * 0.25], [ox + 0.62, 2.15, -0.5 + i * 0.25], 0.02, 6);
  fb.rod(post, [ox + 0.62, 2.15, -0.6], [ox + 0.62, 2.15, 0.6], 0.025, 6);
  // ladder on -Z side
  for (const x of [-0.25, 0.25]) fb.rod(post, [ox + x, 0, -1.5], [ox + x, 1.55, -0.62], 0.03, 6);
  for (let i = 1; i <= 5; i++) {
    const t = i / 6;
    fb.rod(METAL, [ox - 0.25, t * 1.55, -1.5 + t * 0.88], [ox + 0.25, t * 1.55, -1.5 + t * 0.88], 0.018, 6);
  }
  // slide chute on +Z side: U profile swept along a curve
  {
    const path = new THREE.CatmullRomCurve3([
      new THREE.Vector3(ox, 1.52, 0.62), new THREE.Vector3(ox, 1.3, 1.1), new THREE.Vector3(ox, 0.7, 2.2),
      new THREE.Vector3(ox, 0.35, 3.0), new THREE.Vector3(ox, 0.3, 3.5),
    ]);
    const prof: [number, number][] = [[-0.3, 0.25], [-0.3, 0.02], [-0.22, 0], [0.22, 0], [0.3, 0.02], [0.3, 0.25]];
    const segs = 16;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const p = path.getPointAt(t);
      for (const [px, py] of prof) {
        pos.push(p.x + px, p.y + py, p.z);
        uv.push(px, t);
      }
    }
    const n = prof.length;
    for (let i = 0; i < segs; i++) for (let j = 0; j < n - 1; j++) {
      const a = i * n + j, b = a + n;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    fb.add(g, new THREE.Matrix4(), plastic(c2, true), undefined, true);
    fb.rod(post, [ox - 0.2, 0, 3.3], [ox - 0.2, 0.3, 3.3], 0.03, 6);
    fb.rod(post, [ox + 0.2, 0, 3.3], [ox + 0.2, 0.3, 3.3], 0.03, 6);
  }
  // swing frame (A-frames) on +X
  const sx0 = 1.8, beamY = 2.35, half = 1.4;
  for (const z of [-half, half]) {
    fb.rod(post, [sx0 - 0.8, 0, z], [sx0, beamY, z], 0.05, 8);
    fb.rod(post, [sx0 + 0.8, 0, z], [sx0, beamY, z], 0.05, 8);
  }
  fb.rod(post, [sx0, beamY, -half - 0.1], [sx0, beamY, half + 0.1], 0.055, 10);
  for (const z of [-0.6, 0.6]) {
    for (const dz of [-0.2, 0.2]) fb.rod(METAL, [sx0 - 0.05, beamY, z + dz], [sx0, 0.48, z + dz], 0.008, 4);
    fb.box(RUBBER, 0.2, 0.03, 0.46, sx0, 0.46, z);
  }
  // rubber safety surface tiles
  fb.box({ m: FMat.Rubber, c: [0.25, 0.1, 0.08] }, 2.4, 0.03, 3.4, sx0, 0.015, 0);
  return 3.6;
}

function manhole(fb: FB, v: number): number {
  const r = 0.33;
  // cover: textured disc
  const seg = 24;
  const [u0, v0, u1, v1] = cellRect(9);
  const pos: number[] = [0, 0.02, 0], nrm: number[] = [0, 1, 0], uv: number[] = [(u0 + u1) / 2, (v0 + v1) / 2], idx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pos.push(Math.cos(a) * r, 0.02, Math.sin(a) * r);
    nrm.push(0, 1, 0);
    uv.push(u0 + (u1 - u0) * (0.5 + Math.cos(a) * 0.5), v0 + (v1 - v0) * (0.5 - Math.sin(a) * 0.5));
    if (i < seg) idx.push(0, i + 2, i + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  fb.add(g, new THREE.Matrix4(), { m: FMat.Signage, c: [1, 1, 1] });
  // frame ring
  fb.lathe(METAL, [[r, 0.02], [r + 0.01, 0.025], [r + 0.07, 0.022], [r + 0.09, 0.0]].reverse() as [number, number][], seg);
  if (v % 2 === 1) fb.lathe(CONCRETE, [[r + 0.09, 0.0], [r + 0.1, 0.012], [r + 0.3, 0.008], [r + 0.32, -0.01]].reverse() as [number, number][], seg);
  return 0.03;
}

function metroEntrance(fb: FB, v: number, lights: Lights): number {
  const rail = v % 2 === 0 ? paint([0.12, 0.28, 0.2]) : { m: FMat.Metal } as PO;
  const hw = 1.25, hl = 3.0;
  // granite curb around the opening (3 sides)
  fb.box(STONE, 0.3, 0.18, hl * 2 + 0.6, -hw - 0.15, 0.09, 0.3);
  fb.box(STONE, 0.3, 0.18, hl * 2 + 0.6, hw + 0.15, 0.09, 0.3);
  fb.box(STONE, hw * 2 + 0.6, 0.18, 0.3, 0, 0.09, hl + 0.15);
  fb.box(STONE, hw * 2 + 0.6, 0.04, 0.2, 0, 0.0, -hl - 0.1);
  // railings
  const railAlong = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / 1.0));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
      fb.box(rail, 0.06, 1.1, 0.06, x, 0.18 + 0.55, z);
      fb.sphere(rail, 0.045, x, 1.32, z, 1, 1, 1, 8, 5);
    }
    fb.rod(rail, [x0, 1.25, z0], [x1, 1.25, z1], 0.03, 8);
    fb.rod(rail, [x0, 0.35, z0], [x1, 0.35, z1], 0.02, 6);
    // balusters
    const nb = Math.round(len / 0.14);
    for (let i = 1; i < nb; i++) {
      const t = i / nb;
      const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
      fb.rod(rail, [x, 0.35, z], [x, 1.25, z], 0.009, 4);
    }
  };
  railAlong(-hw - 0.15, -hl + 0.1, -hw - 0.15, hl + 0.15);
  railAlong(hw + 0.15, -hl + 0.1, hw + 0.15, hl + 0.15);
  railAlong(-hw - 0.15, hl + 0.15, hw + 0.15, hl + 0.15);
  // sign mast at the open end: pole + illuminated disc with "M"
  const sx = hw + 0.55, sz = -hl - 0.1;
  fb.cyl(rail, 0.055, 0.07, 3.0, sx, 0, sz, 12);
  fb.cyl(rail, 0.48, 0.48, 0.12, sx, 3.05, sz - 0.06, 32, false, Math.PI / 2);
  fb.panel(sign(1), 0.86, 0.86, sx, 3.05, sz - 0.062, 0, 1);
  fb.panel(sign(1), 0.86, 0.86, sx, 3.05, sz + 0.062, Math.PI, 1);
  // info / station-name plate
  fb.box(rail, 0.9, 0.3, 0.06, sx - 0.0, 2.35, sz);
  fb.panel(sign(1), 0.84, 0.24, sx, 2.35, sz - 0.032, 0, 14);
  fb.panel(sign(1), 0.84, 0.24, sx, 2.35, sz + 0.032, Math.PI, 14);
  lights.push({ pos: [sx, 3.05, sz], color: [1, 0.95, 0.85], intensity: 0.4 });
  return 3.6;
}

function newsStand(fb: FB, v: number): number {
  const cols: V[] = v % 2 === 0 ? [[0.1, 0.25, 0.6], [0.75, 0.1, 0.08], [0.95, 0.75, 0.1]] : [[0.1, 0.4, 0.2], [0.9, 0.9, 0.88], [0.2, 0.2, 0.22]];
  cols.forEach((c, i) => {
    const x = (i - 1) * 0.56;
    const po = plastic(c, true);
    fb.box(METAL, 0.05, 0.4, 0.05, x - 0.18, 0.2, 0);
    fb.box(METAL, 0.05, 0.4, 0.05, x + 0.18, 0.2, 0);
    fb.box(METAL, 0.45, 0.04, 0.4, x, 0.02, 0);
    fb.box(po, 0.5, 0.65, 0.44, x, 0.4 + 0.325, 0);
    fb.box(po, 0.5, 0.06, 0.48, x, 1.08, 0.0, 0, -0.1);
    // window with newspaper
    fb.box(paint([0.05, 0.05, 0.05], true), 0.42, 0.38, 0.02, x, 0.86, -0.225);
    fb.panel(sign(), 0.36, 0.32, x, 0.86, -0.237, 0, 5);
    fb.box(METAL, 0.12, 0.1, 0.04, x + 0.13, 0.55, -0.235);
  });
  return 1.12;
}

function bikeRack(fb: FB, v: number): number {
  const n = v % 2 === 0 ? 5 : 3;
  const po = { m: FMat.Metal } as PO;
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * 0.8;
    const pts: V[] = [[x, 0, -0.3], [x, 0.6, -0.3]];
    for (let k = 1; k < 8; k++) {
      const a = (k / 8) * Math.PI;
      pts.push([x, 0.6 + Math.sin(a) * 0.25, -Math.cos(a) * 0.3]);
    }
    pts.push([x, 0.6, 0.3], [x, 0, 0.3]);
    fb.tube(po, pts, 0.026, 8, 28);
  }
  return 0.85;
}

function phoneBooth(fb: FB, v: number): number {
  if (v % 2 === 0) {
    // classic red kiosk
    const red = paint([0.72, 0.05, 0.04]);
    const W = 0.95, H = 2.45;
    fb.box(CONCRETE, W + 0.15, 0.12, W + 0.15, 0, 0.06, 0);
    fb.box(red, W, 0.18, W, 0, 0.21, 0);
    for (const x of [-1, 1]) for (const z of [-1, 1]) fb.box(red, 0.1, H - 0.3, 0.1, x * (W / 2 - 0.05), 0.3 + (H - 0.3) / 2, z * (W / 2 - 0.05));
    // glazed sides with glazing bars (3 x 8 panes)
    for (let s = 0; s < 4; s++) {
      const ry = (s * Math.PI) / 2;
      const nx = Math.sin(ry), nz = -Math.cos(ry);
      const cx = nx * (W / 2 - 0.04), cz = nz * (W / 2 - 0.04);
      fb.box(GLASS, W - 0.2, 1.65, 0.01, cx, 1.18, cz, ry);
      for (let i = 0; i <= 3; i++) {
        const o = -0.375 + i * 0.25;
        fb.box(red, 0.03, 1.65, 0.035, cx + Math.cos(ry) * o, 1.18, cz + Math.sin(ry) * o, ry);
      }
      for (let j = 0; j <= 8; j++) fb.box(red, W - 0.2, 0.03, 0.035, cx, 0.36 + j * (1.65 / 8), cz, ry);
      // header sign
      fb.box(red, W - 0.1, 0.22, 0.04, nx * (W / 2 - 0.02), 2.15, nz * (W / 2 - 0.02), ry);
      fb.panel(sign(1), W - 0.25, 0.14, nx * (W / 2 + 0.002), 2.15, nz * (W / 2 + 0.002), ry, 6);
    }
    // stepped domed roof
    fb.box(red, W + 0.06, 0.08, W + 0.06, 0, 2.3, 0);
    const g = new THREE.CylinderGeometry(W / 2 + 0.02, W / 2 + 0.02, W + 0.04, 12, 1, false, 0, Math.PI);
    g.rotateZ(Math.PI / 2);
    fb.add(g, M(0, 2.34, 0, 0, 0, 0, 1, 0.4, 1), red);
    const g2 = new THREE.CylinderGeometry(W / 2 + 0.02, W / 2 + 0.02, W + 0.04, 12, 1, false, 0, Math.PI);
    g2.rotateZ(Math.PI / 2);
    fb.add(g2, M(0, 2.34, 0, 0, Math.PI / 2, 0, 1, 0.4, 1), red);
    fb.box(red, 0.18, 0.08, 0.18, 0, 2.55, 0);
    fb.box({ m: FMat.Light, e: 0.6, c: [1, 0.95, 0.85] }, 0.25, 0.04, 0.25, 0, 2.27, 0);
    // phone inside
    fb.box(METAL, 0.3, 0.4, 0.15, 0, 1.4, W / 2 - 0.15);
    return 2.6;
  }
  // modern open phone stand
  fb.box(METAL, 0.12, 2.2, 0.12, 0, 1.1, 0.25);
  fb.box(paint([0.15, 0.17, 0.2], true), 0.9, 0.08, 0.7, 0, 2.2, 0.0);
  fb.box(GLASS, 0.02, 1.4, 0.6, -0.44, 1.45, 0.0);
  fb.box(GLASS, 0.02, 1.4, 0.6, 0.44, 1.45, 0.0);
  fb.box(paint([0.15, 0.17, 0.2], true), 0.5, 0.6, 0.18, 0, 1.35, 0.15);
  fb.box(METAL, 0.3, 0.35, 0.02, 0, 1.4, 0.055);
  fb.panel(sign(1), 0.8, 0.12, 0, 2.2, -0.352, 0, 6);
  fb.box({ m: FMat.Light, e: 0.6, c: [0.95, 0.95, 1] }, 0.6, 0.02, 0.4, 0, 2.155, 0.0);
  return 2.25;
}

/**
 * Kerbside EV charging post (front -Z faces the parking bay): a slim rounded column with a
 * screen, a status light ring and the charging cable coiled on its holster. v1: a lower
 * twin-socket bollard type.
 */
function evCharger(fb: FB, v: number): number {
  const body = paint([0.9, 0.91, 0.9], true);
  const dark = plastic([0.12, 0.13, 0.14], true);
  const led: PO = { m: FMat.Light, e: 1, s: 10, c: [0.2, 0.9, 1] };
  fb.box(CONCRETE, 0.5, 0.06, 0.4, 0, 0.03, 0);
  if (v % 2 === 0) {
    const H = 1.55;
    fb.lathe(body, [[0, 0.06], [0.16, 0.06], [0.17, 0.1], [0.17, H - 0.12], [0.15, H - 0.03], [0.1, H], [0, H]], 20, 0, 0, 0, 0, 1, 0.72);
    // Dark face with the screen and the status light band.
    fb.box(dark, 0.22, 0.62, 0.03, 0, 1.08, -0.115);
    fb.box(plastic([0.04, 0.1, 0.18], true), 0.16, 0.12, 0.01, 0, 1.25, -0.132);
    fb.box(led, 0.1, 0.012, 0.012, 0, 1.22, -0.136);
    fb.box(led, 0.17, 0.025, 0.012, 0, 1.43, -0.122);
    fb.box(led, 0.022, 0.4, 0.012, -0.135, 0.75, -0.06, 0.55);
    // Socket, holster and the cable hanging in a loop.
    fb.box(dark, 0.09, 0.12, 0.06, 0, 0.88, -0.14);
    fb.box(dark, 0.07, 0.16, 0.07, 0.15, 0.95, -0.02);
    fb.tube(RUBBER, [[0.17, 0.9, -0.03], [0.24, 0.6, -0.08], [0.2, 0.32, -0.12], [0.06, 0.38, -0.16], [0.0, 0.82, -0.15]], 0.016, 6, 24);
    return H;
  }
  const H = 1.05;
  fb.box(body, 0.3, H - 0.06, 0.26, 0, 0.06 + (H - 0.06) / 2, 0);
  fb.box(dark, 0.31, 0.06, 0.27, 0, H - 0.03, 0);
  for (const z of [-1, 1]) {
    fb.box(dark, 0.18, 0.2, 0.02, 0, 0.72, z * 0.135);
    fb.box(led, 0.16, 0.02, 0.012, 0, 0.9, z * 0.14);
  }
  fb.box(led, 0.31, 0.015, 0.27, 0, H - 0.07, 0);
  return H;
}

// ---------------------------------------------------------------------------------------------
// Café and restaurant terraces (plan/terrace.ts). Kept low-poly: there are many of them.
// Fabric and chair paint take the café's colours through iColor.
// ---------------------------------------------------------------------------------------------

/** Low-detail foliage clump (planters on parklets). */
function smallFoliage(fb: FB, r: number, x: number, y: number, z: number, col: V, seed: number) {
  const g = new THREE.IcosahedronGeometry(r, 1);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
    const k = 1 + 0.16 * fNoise.n3(vx * 4 + seed, vy * 4, vz * 4);
    p.setXYZ(i, vx * k, vy * k * 0.85, vz * k);
  }
  g.deleteAttribute('normal');
  fb.add(mergeVertsNormals(g), M(x, y, z), { m: FMat.Plastic, c: col, s: 8 });
}

/** Round bistro table (cast-iron foot, marble top) or square timber table. Top at 0.74 m. */
function cafeTable(fb: FB, v: number): number {
  const iron = paint([0.07, 0.07, 0.07], true);
  if (v % 2 === 0) {
    fb.cyl(iron, 0.2, 0.24, 0.04, 0, 0, 0, 10);
    fb.cyl(iron, 0.028, 0.034, 0.68, 0, 0.04, 0, 6);
    fb.cyl({ m: FMat.Concrete, c: [0.9, 0.89, 0.86] }, 0.33, 0.33, 0.03, 0, 0.71, 0, 14);
    fb.cyl(METAL, 0.335, 0.335, 0.012, 0, 0.705, 0, 14, true);
    return 0.74;
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) fb.box(WOOD, 0.045, 0.7, 0.045, sx * 0.31, 0.35, sz * 0.31);
  fb.box(WOOD, 0.72, 0.04, 0.72, 0, 0.72, 0);
  fb.box(WOOD, 0.6, 0.06, 0.03, 0, 0.67, 0.31);
  fb.box(WOOD, 0.6, 0.06, 0.03, 0, 0.67, -0.31);
  return 0.74;
}

/** Bistro chair (painted frame, woven seat) or timber chair. The sitter faces -Z. */
function cafeChair(fb: FB, v: number): number {
  if (v % 2 === 0) {
    const frame = paint([0.1, 0.1, 0.1]);
    const weave: PO = { m: FMat.Wood, c: [0.62, 0.48, 0.3] };
    for (const sx of [-1, 1]) {
      fb.rod(frame, [sx * 0.18, 0, -0.19], [sx * 0.16, 0.45, -0.16], 0.012, 5);
      fb.rod(frame, [sx * 0.18, 0, 0.21], [sx * 0.16, 0.45, 0.17], 0.012, 5);
      fb.rod(frame, [sx * 0.16, 0.45, 0.17], [sx * 0.15, 0.86, 0.22], 0.012, 5);
    }
    fb.cyl(weave, 0.2, 0.2, 0.035, 0, 0.44, 0, 10);
    fb.box(weave, 0.32, 0.12, 0.02, 0, 0.76, 0.21, 0, -0.12);
    fb.box(weave, 0.32, 0.07, 0.02, 0, 0.6, 0.195, 0, -0.12);
    return 0.86;
  }
  const wood: PO = { m: FMat.Wood, c: [0.42, 0.27, 0.15] };
  for (const sx of [-1, 1]) {
    fb.box(wood, 0.035, 0.45, 0.035, sx * 0.18, 0.225, -0.18);
    fb.box(wood, 0.035, 0.9, 0.035, sx * 0.18, 0.45, 0.19);
  }
  fb.box(wood, 0.42, 0.035, 0.42, 0, 0.46, 0);
  for (const y of [0.6, 0.72, 0.84]) fb.box(wood, 0.36, 0.06, 0.02, 0, y, 0.19);
  return 0.9;
}

/** Market parasol: square (v0, 2.6 m) or round (v1, 2.3 m); LED strip under the canopy at night. */
function parasol(fb: FB, v: number): number {
  const fabric = plastic([0.92, 0.9, 0.84]);
  const pole: PO = { m: FMat.Wood, c: [0.5, 0.36, 0.22] };
  const led: PO = { m: FMat.Light, e: 0.4, c: [1, 0.8, 0.55] };
  const H = 2.45, sq = v % 2 === 0;
  fb.cyl(paint([0.08, 0.08, 0.08], true), 0.2, 0.22, 0.05, 0, 0, 0, 8);
  fb.cyl(pole, 0.026, 0.026, H - 0.02, 0, 0.05, 0, 6);
  const R = sq ? 1.84 : 1.15, segs = sq ? 4 : 8, h = sq ? 0.5 : 0.42;
  const cone = new THREE.CylinderGeometry(0.04, R, h, segs, 1, true);
  cone.translate(0, h / 2, 0);
  fb.add(cone, M(0, H - h - 0.03, 0, 0, sq ? Math.PI / 4 : Math.PI / 8), fabric, undefined, true);
  if (sq) {
    for (const [x, z, w, d] of [[0, -1.3, 2.6, 0.01], [0, 1.3, 2.6, 0.01], [-1.3, 0, 0.01, 2.6], [1.3, 0, 0.01, 2.6]] as [number, number, number, number][]) fb.box(fabric, w, 0.16, d, x, H - h - 0.1, z);
  } else {
    const val = new THREE.CylinderGeometry(R * 0.995, R * 0.995, 0.13, 8, 1, true);
    val.translate(0, -0.065, 0);
    fb.add(val, M(0, H - h - 0.03, 0, 0, Math.PI / 8), fabric, undefined, true);
  }
  fb.cyl(pole, 0.04, 0.03, 0.12, 0, H - 0.06, 0, 6);
  fb.add(new THREE.TorusGeometry(R * 0.42, 0.022, 3, sq ? 4 : 8), M(0, H - h + 0.04, 0, Math.PI / 2, 0, sq ? Math.PI / 4 : 0), led);
  return H + 0.06;
}

/** Striped folding-arm awning over a shop window, 2.4 m (v0) or 3.2 m (v1) wide; top at 3 m, on the wall (z = 0). */
function awning(fb: FB, v: number): number {
  const W = v % 2 === 0 ? 2.4 : 3.2, top = 3.0, drop = 0.45, proj = 1.3;
  const colour = plastic([0.9, 0.88, 0.82]);
  const white = plastic([0.93, 0.92, 0.88], true);
  const slope = Math.hypot(proj, drop), pitch = Math.atan2(drop, proj);
  const n = Math.round(W / 0.3);
  const sw = W / n;
  for (let k = 0; k < n; k++) {
    const x = -W / 2 + sw * (k + 0.5);
    const po = k % 2 === 0 ? colour : white;
    fb.box(po, sw, 0.012, slope, x, top - drop / 2, -proj / 2, 0, -pitch);
    fb.box(po, sw, 0.24, 0.01, x, top - drop - 0.13, -proj - 0.005);
  }
  fb.box(METAL, W + 0.06, 0.06, 0.06, 0, top - drop - 0.01, -proj);
  fb.box(paint([0.18, 0.18, 0.18], true), W + 0.1, 0.1, 0.08, 0, top + 0.03, -0.04);
  for (const sx of [-1, 1]) {
    fb.rod(METAL, [sx * (W / 2 - 0.25), top - 0.55, 0], [sx * (W / 2 - 0.45), top - 0.25, -proj * 0.55], 0.014, 5);
    fb.rod(METAL, [sx * (W / 2 - 0.45), top - 0.25, -proj * 0.55], [sx * (W / 2 - 0.25), top - drop, -proj], 0.014, 5);
  }
  return top + 0.08;
}

/** A-board with a chalk menu (v0) or a lit menu lectern (v1). Faces ±Z. */
function menuBoard(fb: FB, v: number): number {
  if (v % 2 === 0) {
    const frame: PO = { m: FMat.Wood, c: [0.45, 0.3, 0.17] };
    const slate = paint([0.06, 0.08, 0.07], true);
    const chalk = plastic([0.86, 0.86, 0.82], true);
    for (const s of [-1, 1]) {
      const a = s * 0.2, z = s * 0.11;
      fb.box(frame, 0.62, 0.95, 0.025, 0, 0.47, z, 0, a);
      fb.box(slate, 0.52, 0.72, 0.01, 0, 0.5, z + s * 0.016, 0, a);
      for (let k = 0; k < 6; k++) {
        const y = 0.76 - k * 0.1, w = k === 0 ? 0.34 : 0.22 + ((k * 37) % 13) / 60;
        fb.box(chalk, w, 0.018, 0.004, (k === 0 ? 0 : -0.05), y, z + s * 0.024 - Math.sin(a) * (y - 0.5) * s * 0, 0, a);
      }
    }
    return 0.97;
  }
  const dark = paint([0.1, 0.09, 0.08], true);
  fb.cyl(dark, 0.18, 0.2, 0.03, 0, 0, 0, 8);
  fb.box(dark, 0.05, 1.05, 0.05, 0, 0.53, 0);
  fb.box(dark, 0.42, 0.56, 0.08, 0, 1.18, 0, 0, -0.25);
  fb.box({ m: FMat.Light, e: 0.3, c: [1, 0.95, 0.85] }, 0.36, 0.48, 0.01, 0, 1.18, -0.045, 0, -0.25);
  return 1.45;
}

/** Low glass windscreen with a fabric band in the café's colour, 2 m long (along X). */
function terraceRail(fb: FB, _v: number): number {
  const post = paint([0.12, 0.12, 0.12], true);
  for (const x of [-0.97, 0.97]) fb.box(post, 0.05, 0.95, 0.05, x, 0.475, 0);
  fb.box({ m: FMat.Wood, c: [0.5, 0.35, 0.2] }, 2.0, 0.04, 0.07, 0, 0.95, 0);
  fb.box(plastic([0.85, 0.85, 0.8]), 1.9, 0.28, 0.02, 0, 0.26, 0);
  fb.box(GLASS, 1.9, 0.52, 0.012, 0, 0.66, 0);
  return 0.97;
}

/** Timber parklet deck module in a parking bay: 2.0 × 1.8 m (v0), or a 1.0 m end with a planter (v1). Top at 0 (sidewalk level). */
function parklet(fb: FB, v: number): number {
  const L = v % 2 === 0 ? 2.0 : 1.0, D = 1.8;
  const deck: PO = { m: FMat.Wood, c: [0.58, 0.42, 0.27] };
  fb.box(paint([0.16, 0.15, 0.14], true), L, 0.13, D - 0.04, 0, -0.085, 0);
  const n = 9;
  for (let k = 0; k < n; k++) fb.box(deck, L - 0.01, 0.035, D / n - 0.012, 0, -0.018, -D / 2 + (k + 0.5) * (D / n));
  if (v % 2 === 1) {
    fb.box({ m: FMat.Wood, c: [0.4, 0.28, 0.17] }, 0.8, 0.55, D - 0.1, 0, 0.275, 0);
    fb.box({ m: FMat.Concrete, c: [0.2, 0.15, 0.1], s: 9 }, 0.72, 0.02, D - 0.2, 0, 0.53, 0);
    smallFoliage(fb, 0.38, 0, 0.75, -0.42, [0.22, 0.38, 0.14], 4);
    smallFoliage(fb, 0.33, 0.05, 0.72, 0.4, [0.26, 0.42, 0.15], 9);
    smallFoliage(fb, 0.28, -0.1, 0.9, 0.02, [0.2, 0.34, 0.12], 2);
    return 1.1;
  }
  return 0.02;
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

const furnCache = new Map<string, FurnitureModel>();

export function furnitureModel(kind: FurnitureKind, variant = 0): FurnitureModel {
  const v = Math.abs(variant | 0) % 2;
  const key = kind + ':' + v;
  const cached = furnCache.get(key);
  if (cached) return cached;
  const fb = new FB();
  const lights: Lights = [];
  let height = 1;
  let radius = 0.3;
  let breakable: FurnitureModel['breakable'] = 'topple';
  switch (kind) {
    case 'lampModern': height = lampModern(fb, v, lights); radius = 0.15; breakable = 'bend'; break;
    case 'lampClassic': height = lampClassic(fb, v, lights); radius = 0.2; breakable = 'bend'; break;
    case 'lampDouble': height = lampDouble(fb, v, lights); radius = 0.2; breakable = 'bend'; break;
    case 'trafficLight': height = trafficLight(fb, v); radius = 0.2; breakable = 'bend'; break;
    case 'bench': height = bench(fb, v); radius = 0.95; breakable = 'topple'; break;
    case 'bin': height = bin(fb, v); radius = 0.3; breakable = 'topple'; break;
    case 'hydrant': height = hydrant(fb, v); radius = 0.2; breakable = 'solid'; break;
    case 'mailbox': height = mailbox(fb, v); radius = 0.32; breakable = v === 1 ? 'solid' : 'topple'; break;
    case 'bollard': height = bollard(fb, v); radius = 0.12; breakable = 'solid'; break;
    case 'planter': height = planter(fb, v); radius = 0.7; breakable = 'shatter'; break;
    case 'busStop': height = busStop(fb, v, lights); radius = 2.3; breakable = 'shatter'; break;
    case 'fountain': height = fountain(fb, v); radius = v === 0 ? 3.2 : 2.6; breakable = 'solid'; break;
    case 'statue': height = statue(fb, v); radius = v === 0 ? 1.2 : 2.0; breakable = 'solid'; break;
    case 'kiosk': height = kiosk(fb, v); radius = v === 0 ? 1.6 : 1.8; breakable = 'shatter'; break;
    case 'stopSign': height = stopSign(fb, v); radius = 0.06; breakable = 'bend'; break;
    case 'playground': height = playground(fb, v); radius = 4.0; breakable = 'solid'; break;
    case 'manhole': height = manhole(fb, v); radius = 0.4; breakable = 'solid'; break;
    case 'metroEntrance': height = metroEntrance(fb, v, lights); radius = 3.5; breakable = 'solid'; break;
    case 'newsStand': height = newsStand(fb, v); radius = 0.9; breakable = 'topple'; break;
    case 'bikeRack': height = bikeRack(fb, v); radius = v === 0 ? 1.9 : 1.1; breakable = 'bend'; break;
    case 'phoneBooth': height = phoneBooth(fb, v); radius = 0.6; breakable = 'shatter'; break;
    case 'evCharger': height = evCharger(fb, v); radius = 0.22; breakable = 'topple'; break;
    case 'cafeTable': height = cafeTable(fb, v); radius = 0.36; breakable = 'topple'; break;
    case 'cafeChair': height = cafeChair(fb, v); radius = 0.22; breakable = 'topple'; break;
    case 'parasol': height = parasol(fb, v); radius = 0.06; breakable = 'topple'; break;
    case 'awning': height = awning(fb, v); radius = 0.1; breakable = 'shatter'; break;
    case 'menuBoard': height = menuBoard(fb, v); radius = 0.25; breakable = 'topple'; break;
    case 'terraceRail': height = terraceRail(fb, v); radius = 0.1; breakable = 'topple'; break;
    case 'parklet': height = parklet(fb, v); radius = v === 0 ? 1.0 : 0.5; breakable = 'solid'; break;
  }
  const model: FurnitureModel = { kind, geometry: fb.build(), height, radius, lights, breakable };
  furnCache.set(key, model);
  return model;
}

// ---------------------------------------------------------------------------------------------
// Signage atlas
// ---------------------------------------------------------------------------------------------

let signTex: THREE.CanvasTexture | null = null;

function getSignAtlas(): THREE.CanvasTexture {
  if (signTex) return signTex;
  const S = 1024, C = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#808080';
  g.fillRect(0, 0, S, S);
  const rng = Rng.from('signage');
  const cell = (i: number, draw: (g: CanvasRenderingContext2D) => void) => {
    g.save();
    g.translate((i % 4) * C, Math.floor(i / 4) * C);
    g.beginPath(); g.rect(0, 0, C, C); g.clip();
    draw(g);
    g.restore();
  };
  const text = (gg: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, col: string, font = 'Arial, Helvetica, sans-serif', weight = 'bold', sx = 1) => {
    gg.save();
    gg.translate(x, y);
    gg.scale(sx, 1);
    gg.fillStyle = col;
    gg.font = `${weight} ${size}px ${font}`;
    gg.textAlign = 'center';
    gg.textBaseline = 'middle';
    gg.fillText(s, 0, 0);
    gg.restore();
  };
  const octagon = (gg: CanvasRenderingContext2D, r: number) => {
    gg.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = Math.PI / 8 + (i / 8) * Math.PI * 2;
      const x = 128 + Math.cos(a) * r, y = 128 + Math.sin(a) * r;
      if (i === 0) gg.moveTo(x, y); else gg.lineTo(x, y);
    }
    gg.closePath();
  };
  // 0 STOP
  cell(0, (gg) => {
    gg.fillStyle = '#ffffff'; gg.fillRect(0, 0, C, C);
    octagon(gg, 128); gg.fillStyle = '#f2f2f2'; gg.fill();
    octagon(gg, 118); gg.fillStyle = '#b5121b'; gg.fill();
    text(gg, 'STOP', 128, 132, 78, '#ffffff', 'Arial, Helvetica, sans-serif', 'bold', 0.92);
  });
  // 1 metro "M" disc
  cell(1, (gg) => {
    gg.fillStyle = '#f4f4f0'; gg.fillRect(0, 0, C, C);
    gg.beginPath(); gg.arc(128, 128, 122, 0, Math.PI * 2); gg.fillStyle = '#f2c200'; gg.fill();
    gg.lineWidth = 6; gg.strokeStyle = '#222'; gg.stroke();
    text(gg, 'M', 128, 136, 190, '#111');
  });
  // 2 bus stop
  cell(2, (gg) => {
    gg.fillStyle = '#f2c94c'; gg.fillRect(0, 0, C, C);
    gg.beginPath(); gg.arc(128, 128, 112, 0, Math.PI * 2); gg.fillStyle = '#1f7a3a'; gg.fill();
    gg.fillStyle = '#ffffff';
    gg.fillRect(68, 64, 120, 84);
    gg.fillStyle = '#1f7a3a';
    gg.fillRect(78, 74, 46, 34); gg.fillRect(132, 74, 46, 34);
    gg.beginPath(); gg.arc(90, 152, 12, 0, Math.PI * 2); gg.arc(166, 152, 12, 0, Math.PI * 2); gg.fillStyle = '#ffffff'; gg.fill();
    text(gg, 'BUS', 128, 196, 48, '#ffffff');
  });
  // 3 & 4 posters
  const poster = (gg: CanvasRenderingContext2D, hue: number, title: string, r: Rng) => {
    const gr = gg.createLinearGradient(0, 0, 0, C);
    gr.addColorStop(0, `hsl(${hue},70%,55%)`);
    gr.addColorStop(1, `hsl(${hue + 40},65%,25%)`);
    gg.fillStyle = gr; gg.fillRect(0, 0, C, C);
    for (let i = 0; i < 6; i++) {
      gg.beginPath();
      gg.arc(r.range(30, 226), r.range(60, 180), r.range(15, 60), 0, Math.PI * 2);
      gg.fillStyle = `hsla(${hue + r.range(-60, 60)},80%,${r.range(50, 80)}%,0.55)`;
      gg.fill();
    }
    text(gg, title, 128, 40, 40, '#ffffff');
    gg.fillStyle = 'rgba(255,255,255,0.85)';
    gg.fillRect(40, 205, 176, 8); gg.fillRect(60, 222, 136, 6);
  };
  cell(3, (gg) => poster(gg, 200, 'SCALE', rng.fork('p1')));
  cell(4, (gg) => poster(gg, 330, 'SUMMER', rng.fork('p2')));
  // 5 newspaper fronts / magazines
  cell(5, (gg) => {
    gg.fillStyle = '#ddd'; gg.fillRect(0, 0, C, C);
    const r = rng.fork('news');
    for (let i = 0; i < 6; i++) {
      const x = (i % 3) * 85 + 3, y = Math.floor(i / 3) * 128 + 3;
      gg.fillStyle = i % 2 ? '#f4f1e8' : `hsl(${r.range(0, 360)},50%,55%)`;
      gg.fillRect(x, y, 80, 122);
      gg.fillStyle = '#111';
      gg.fillRect(x + 6, y + 8, 68, 14);
      for (let k = 0; k < 7; k++) { gg.fillStyle = 'rgba(0,0,0,0.45)'; gg.fillRect(x + 6, y + 34 + k * 11, r.range(40, 68), 4); }
      gg.fillStyle = `hsl(${r.range(0, 360)},40%,45%)`;
      gg.fillRect(x + 40, y + 60, 34, 40);
    }
  });
  // 6 TELEPHONE header
  cell(6, (gg) => {
    gg.fillStyle = '#111'; gg.fillRect(0, 0, C, C);
    text(gg, 'TELEPHONE', 128, 128, 40, '#f5f2e6', 'Georgia, serif', 'bold', 0.95);
  });
  // 7 pedestrian hand (mask, white on black) / 8 walking figure
  cell(7, (gg) => {
    gg.fillStyle = '#000'; gg.fillRect(0, 0, C, C);
    gg.fillStyle = '#fff';
    gg.beginPath(); gg.roundRect(88, 120, 84, 90, 24); gg.fill();
    for (let i = 0; i < 4; i++) { gg.beginPath(); gg.roundRect(90 + i * 21, 52 + Math.abs(i - 1.5) * 10, 16, 90, 8); gg.fill(); }
    gg.beginPath(); gg.roundRect(56, 120, 50, 18, 9); gg.save(); gg.translate(70, 130); gg.rotate(-0.6); gg.translate(-70, -130); gg.fill(); gg.restore();
  });
  cell(8, (gg) => {
    gg.fillStyle = '#000'; gg.fillRect(0, 0, C, C);
    gg.fillStyle = '#fff'; gg.strokeStyle = '#fff'; gg.lineCap = 'round';
    gg.beginPath(); gg.arc(128, 48, 20, 0, Math.PI * 2); gg.fill();
    gg.lineWidth = 26;
    gg.beginPath(); gg.moveTo(124, 82); gg.lineTo(118, 150); gg.stroke();
    gg.lineWidth = 18;
    gg.beginPath(); gg.moveTo(118, 150); gg.lineTo(90, 196); gg.lineTo(78, 228); gg.stroke();
    gg.beginPath(); gg.moveTo(118, 150); gg.lineTo(146, 190); gg.lineTo(170, 222); gg.stroke();
    gg.lineWidth = 14;
    gg.beginPath(); gg.moveTo(124, 90); gg.lineTo(94, 128); gg.stroke();
    gg.beginPath(); gg.moveTo(124, 90); gg.lineTo(152, 120); gg.lineTo(168, 138); gg.stroke();
  });
  // 9 manhole cover: cast iron
  cell(9, (gg) => {
    gg.fillStyle = '#2f2f30'; gg.fillRect(0, 0, C, C);
    gg.beginPath(); gg.arc(128, 128, 126, 0, Math.PI * 2); gg.fillStyle = '#3a3a3b'; gg.fill();
    gg.save(); gg.beginPath(); gg.arc(128, 128, 104, 0, Math.PI * 2); gg.clip();
    gg.fillStyle = '#2a2a2b';
    for (let y = 0; y < C; y += 16) for (let x = 0; x < C; x += 16) {
      if (((x + y) / 16) % 2 === 0) gg.fillRect(x + 2, y + 2, 12, 12);
    }
    gg.restore();
    gg.lineWidth = 10; gg.strokeStyle = '#4a4a4b';
    for (const r of [104, 60]) { gg.beginPath(); gg.arc(128, 128, r, 0, Math.PI * 2); gg.stroke(); }
    gg.beginPath(); gg.arc(128, 128, 54, 0, Math.PI * 2); gg.fillStyle = '#3a3a3b'; gg.fill();
    text(gg, 'SEWER', 128, 130, 30, '#555556');
    for (const a of [0.4, 3.5]) { gg.beginPath(); gg.arc(128 + Math.cos(a) * 82, 128 + Math.sin(a) * 82, 6, 0, Math.PI * 2); gg.fillStyle = '#151515'; gg.fill(); }
  });
  // 10 kiosk sign band
  cell(10, (gg) => {
    gg.fillStyle = '#0f2f22'; gg.fillRect(0, 0, C, C);
    text(gg, 'PRESSE', 128, 120, 60, '#f0e6c8', 'Georgia, serif', 'bold', 1.25);
    gg.fillStyle = '#c9a54a'; gg.fillRect(10, 30, 236, 6); gg.fillRect(10, 214, 236, 6);
  });
  // 11 mailbox label / 12 post plate
  cell(11, (gg) => {
    gg.fillStyle = '#1b3a78'; gg.fillRect(0, 0, C, C);
    gg.strokeStyle = '#ffffff'; gg.lineWidth = 6; gg.strokeRect(24, 40, 208, 176);
    text(gg, 'MAIL', 128, 108, 70, '#ffffff');
    gg.fillStyle = '#ffffff'; gg.fillRect(60, 160, 136, 10); gg.fillRect(80, 182, 96, 8);
  });
  cell(12, (gg) => {
    gg.fillStyle = '#c8c4b8'; gg.fillRect(0, 0, C, C);
    gg.fillStyle = '#181818';
    text(gg, 'POST', 128, 60, 52, '#181818', 'Georgia, serif');
    for (let k = 0; k < 5; k++) gg.fillRect(40, 110 + k * 24, 176, 6);
  });
  // 13 timetable
  cell(13, (gg) => {
    gg.fillStyle = '#f7f7f2'; gg.fillRect(0, 0, C, C);
    gg.fillStyle = '#1f7a3a'; gg.fillRect(0, 0, C, 40);
    text(gg, '24  31  M8', 128, 21, 26, '#ffffff');
    gg.fillStyle = '#333';
    for (let k = 0; k < 14; k++) for (let c = 0; c < 4; c++) gg.fillRect(14 + c * 60, 56 + k * 14, 40, 5);
  });
  // 14 station name plate
  cell(14, (gg) => {
    gg.fillStyle = '#1b2b5a'; gg.fillRect(0, 0, C, C);
    text(gg, 'CENTRAL', 128, 128, 62, '#ffffff', 'Arial, Helvetica, sans-serif', 'bold', 0.9);
  });
  // 15 street name blade
  cell(15, (gg) => {
    gg.fillStyle = '#1a6b3c'; gg.fillRect(0, 0, C, C);
    gg.strokeStyle = '#ffffff'; gg.lineWidth = 6; gg.strokeRect(6, 90, 244, 76);
    text(gg, 'MAIN ST', 128, 128, 54, '#ffffff', 'Arial, Helvetica, sans-serif', 'bold', 0.85);
  });
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  signTex = t;
  return t;
}

// ---------------------------------------------------------------------------------------------
// Material
// ---------------------------------------------------------------------------------------------

export function createFurnitureMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  const sign = getSignAtlas();
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = furnitureUniforms.uTime;
    shader.uniforms.uNight = furnitureUniforms.uNight;
    shader.uniforms.uLampOn = furnitureUniforms.uLampOn;
    shader.uniforms.uSignTex = { value: sign };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        attribute float aMat;
        attribute float aEmit;
        attribute float aSub;
        attribute vec3 aColor;
        attribute vec3 iColor;
        attribute vec4 iState;
        varying float vMat;
        varying float vEmit;
        varying float vSub;
        varying vec3 vPaint;
        varying vec4 vState;
        varying vec2 vUvF;
        varying vec3 vOPos;
        varying vec3 vONrm;
        `,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        vMat = aMat; vEmit = aEmit; vSub = aSub; vUvF = uv; vOPos = position; vONrm = normal;
        bool hasInst = !(iState.x == 0.0 && iState.y == 0.0 && iState.z == 0.0 && iState.w == 1.0);
        vState = hasInst ? iState : vec4(1.0, -1.0, 0.0, 0.0);
        bool tint = dot(iColor, iColor) > 0.0 && aSub < 8.5 && (aMat > 0.5 && aMat < 1.5 || aMat > 5.5 && aMat < 6.5);
        vPaint = tint ? pow(iColor, vec3(2.2)) : aColor;
        #ifdef USE_INSTANCING
          vOPos += instanceMatrix[3].xyz * 0.73;
        #endif
        `,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform float uTime;
        uniform float uNight;
        uniform float uLampOn;
        uniform sampler2D uSignTex;
        varying float vMat;
        varying float vEmit;
        varying float vSub;
        varying vec3 vPaint;
        varying vec4 vState;
        varying vec2 vUvF;
        varying vec3 vOPos;
        varying vec3 vONrm;
        float fh(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float fn(vec3 x) {
          vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(fh(i), fh(i + vec3(1,0,0)), f.x), mix(fh(i + vec3(0,1,0)), fh(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(fh(i + vec3(0,0,1)), fh(i + vec3(1,0,1)), f.x), mix(fh(i + vec3(0,1,1)), fh(i + vec3(1,1,1)), f.x), f.y), f.z);
        }
        vec3 fRough; // x roughness, y metalness
        vec3 fEmis;
        `,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        {
          int mid = int(vMat + 0.5);
          int sub = int(vSub + 0.5);
          vec3 base = vec3(0.5);
          float rough = 0.6, metal = 0.0;
          fEmis = vec3(0.0);
          float n1 = fn(vOPos * 7.0), n2 = fn(vOPos * 23.0), n0 = fn(vOPos * 1.7);
          float lightOn = vState.x * uLampOn;
          if (mid == 0) { // galvanised / stainless steel
            base = vec3(0.56, 0.57, 0.58) * (0.9 + 0.15 * n1 + 0.06 * n2);
            rough = 0.32 + 0.18 * n1; metal = 0.85;
          } else if (mid == 1) { // painted metal
            base = vPaint * (0.94 + 0.08 * n2);
            rough = 0.38 + 0.15 * n1 + 0.12 * n0 * n2; metal = 0.25;
            float scuff = smoothstep(0.78, 0.92, n1 * 0.6 + n2 * 0.4) * 0.35;
            base = mix(base, vec3(0.32, 0.31, 0.3), scuff); rough += scuff * 0.3;
          } else if (mid == 2) { // timber
            float along = abs(vONrm.x) < 0.7 ? vOPos.x : vOPos.z;
            float grain = fn(vec3(along * 2.0, vOPos.y * 40.0, vOPos.z * 40.0 + vOPos.x * 3.0));
            float rings = 0.5 + 0.5 * sin((vOPos.y + vOPos.z) * 140.0 + grain * 6.0);
            base = vPaint * (0.68 + 0.28 * grain + 0.12 * rings) * (0.85 + 0.2 * n0);
            rough = 0.62 + 0.15 * grain;
          } else if (mid == 3) { // concrete
            base = vPaint * (0.82 + 0.22 * n1 + 0.1 * n2) * (1.0 - 0.25 * step(0.86, fn(vOPos * 60.0)));
            rough = 0.9;
          } else if (mid == 4) { // stone (granite / limestone)
            float speck = step(0.82, fn(vOPos * 90.0));
            base = vec3(0.25, 0.235, 0.215) * (0.82 + 0.25 * n0 + 0.12 * n1 + 0.06 * n2) * (1.0 - speck * 0.3);
            rough = 0.72 + 0.1 * n2;
          } else if (mid == 5) { // glass (screen-door transparency)
            ivec2 fc = ivec2(gl_FragCoord.xy) % 2;
            if (fc.x == fc.y) discard;
            base = vec3(0.04, 0.05, 0.055);
            rough = 0.04; metal = 0.6;
          } else if (mid == 6) { // plastic / foliage
            base = vPaint;
            rough = 0.45 + 0.1 * n1;
            if (sub == 8) {
              float leaf = fn(vOPos * 38.0) * 0.6 + fn(vOPos * 90.0) * 0.4;
              base = vPaint * (0.55 + 0.75 * leaf) * (0.8 + 0.3 * n1);
              rough = 0.85;
            }
          } else if (mid == 7) { // light lens
            if (sub >= 1 && sub <= 3) {
              float phase = vState.y < -0.5 ? mod(floor(uTime / 4.0), 3.0) : vState.y;
              float want = float(sub == 1 ? 0 : sub == 2 ? 1 : 2);
              float lit = abs(phase - want) < 0.5 ? 1.0 : 0.0;
              base = vPaint * 0.12;
              rough = 0.15;
              fEmis = vPaint * vPaint * lit * (2.2 + 3.0 * uNight);
            } else if (sub == 4 || sub == 5) {
              float phase = vState.y < -0.5 ? mod(floor(uTime / 4.0), 3.0) : vState.y;
              float walk = phase < 0.5 ? 1.0 : 0.0;
              float lit = sub == 5 ? walk : 1.0 - walk;
              float mask = texture2D(uSignTex, vUvF).r;
              base = vec3(0.02) + vPaint * mask * 0.05;
              rough = 0.2;
              fEmis = vPaint * mask * lit * (3.0 + 4.0 * uNight);
            } else if (sub >= 10 && sub <= 12) { // near-future LEDs (always powered; iState.z phase, .w mode: 0 ok, 1 alert, 2 off, 3 hostile, 4 glitching)
              base = vPaint * 0.25;
              rough = 0.2;
              float off = abs(vState.w - 2.0) < 0.5 ? 0.0 : 1.0;
              bool hostile = vState.w > 2.5 && vState.w < 3.5;
              // Glitching: irregular drop-outs, flicking between its colour and red.
              float gl = vState.w > 3.5 ? fract(sin(floor(uTime * 11.0) * 91.7 + vState.z * 311.0) * 43758.5) : 0.0;
              if (sub == 10) { // status light: steady teal pulse, amber blink when waiting, angry red when hostile
                bool alert = vState.w > 0.5 && vState.w < 1.5;
                vec3 c = alert ? vec3(1.0, 0.5, 0.06) : vec3(0.12, 0.8, 1.0);
                float k = alert ? step(0.45, fract(uTime * 1.6 + vState.z)) : 0.75 + 0.25 * sin(uTime * 2.5 + vState.z * 6.283);
                if (hostile) { c = vec3(1.0, 0.03, 0.02); k = 0.8 + 0.4 * step(0.5, fract(uTime * 3.0 + vState.z)); }
                if (vState.w > 3.5) { c = gl > 0.55 ? vec3(1.0, 0.04, 0.02) : c; k *= step(0.25, gl); }
                base = c * 0.3;
                fEmis = c * k * off * (1.4 + 2.6 * uNight);
              } else if (sub == 11) { // anti-collision strobe (double flash); police: red / blue; hostile: fast red
                float ph = fract(uTime * 0.9 + vState.z);
                float k = step(ph, 0.04) + step(abs(ph - 0.13), 0.02);
                vec3 c = vState.y > 2.5 ? (fract(uTime * 2.0 + vState.z) < 0.5 ? vec3(1.0, 0.05, 0.03) : vec3(0.05, 0.2, 1.0)) : vec3(1.0);
                if (vState.y > 2.5) k = step(0.5, fract(uTime * 8.0)) * 0.8;
                if (hostile) { c = vec3(1.0, 0.03, 0.02); k = step(0.5, fract(uTime * 5.0 + vState.z)); }
                fEmis = c * k * off * (5.0 + 9.0 * uNight);
              } else { // steady navigation light (colour from the model); hostile: red
                fEmis = (hostile ? vec3(1.0, 0.03, 0.02) : vPaint) * off * (0.6 + 3.4 * uNight) * (vState.w > 3.5 ? step(0.3, gl) : 1.0);
              }
            } else if (sub == 9) { // retro-reflective band
              base = vPaint; rough = 0.25; metal = 0.0;
            } else { // lamp: frosted diffuser
              base = vec3(0.82, 0.82, 0.8);
              rough = 0.25;
              fEmis = vPaint * vec3(1.0, 0.86, 0.66) * vEmit * lightOn * 9.0;
            }
          } else if (mid == 8) { // water
            float t = uTime;
            if (sub == 1) {
              float streak = fn(vec3(atan(vOPos.z, vOPos.x) * 12.0, vOPos.y * 6.0 + t * 5.0, 0.0));
              ivec2 fc = ivec2(gl_FragCoord.xy) % 2;
              float streak2 = fn(vec3(atan(vOPos.z, vOPos.x) * 31.0, vOPos.y * 9.0 + t * 7.0, 3.0));
              streak = streak * 0.6 + streak2 * 0.4;
              if (streak < 0.42) discard;
              if (streak < 0.6 && fc.x == fc.y) discard;
              base = mix(vec3(0.05, 0.09, 0.1), vec3(0.55, 0.62, 0.64), smoothstep(0.5, 0.85, streak));
              rough = 0.08; metal = 0.1;
            } else {
              base = vec3(0.025, 0.07, 0.075);
              rough = 0.03; metal = 0.15;
            }
          } else if (mid == 9) { // bronze with verdigris
            float pat = smoothstep(0.35, 0.8, n0 * 0.5 + fn(vOPos * 4.0) * 0.3 + n2 * 0.1 + max(0.0, vONrm.y) * 0.3);
            base = mix(vec3(0.16, 0.09, 0.045), vec3(0.13, 0.24, 0.19), pat);
            metal = mix(0.85, 0.15, pat); rough = mix(0.38, 0.75, pat);
          } else if (mid == 10) { // rubber
            base = vPaint * (0.85 + 0.2 * n2);
            rough = 0.95;
          } else if (mid == 11) { // signage
            base = texture2D(uSignTex, vUvF).rgb;
            rough = 0.45; metal = 0.0;
            if (sub == 7) fEmis = base * vEmit * uNight * 1.6 * max(lightOn, uNight * vState.x);
          }
          diffuseColor.rgb = base;
          fRough = vec3(clamp(rough, 0.02, 1.0), metal, 0.0);
        }
        `,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = fRough.x;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = fRough.y;')
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
        if (int(vMat + 0.5) == 8 && vSub < 0.5) {
          float t = uTime;
          vec2 p = vOPos.xz * 3.0;
          vec2 g = vec2(sin(p.x * 2.1 + t * 1.7) + sin(p.y * 1.3 - t * 1.3 + p.x), cos(p.y * 2.4 + t * 1.9) + sin(p.x * 1.7 + p.y * 0.8 - t));
          normal = normalize(normal + (viewMatrix * vec4(g.x * 0.06, 0.0, g.y * 0.06, 0.0)).xyz);
        }
        `,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = fEmis;');
  };
  m.customProgramCacheKey = () => 'furniture-v1';
  return m;
}
