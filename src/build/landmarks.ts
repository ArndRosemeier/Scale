/**
 * Landmark meshes from their parts (plan/landmarkParts): one mesh per landmark and LOD in the
 * facade material family (same shader and texture atlas as buildings and bridges: walls with
 * procedural windows, roofs, glass curtain walls). LOD0 has everything (seat rows, markings,
 * bracing, clock faces…), LOD1 leaves the `detail` parts out, halves the segments and draws
 * stands as plain slopes. Landmarks are not destructible: every vertex is element 0 of an
 * always-alive element texture. Parts of clear glass (`clear`: the glazed walkway of a helix
 * tower, glass orbs and crowns) go into a separate mesh drawn with a transparent glass material.
 */
import type { Terrain } from '../world/terrain';
import type { Landmark } from '../plan/landmarks';
import { landmarkParts, latheClosed, helixFloorAt, HELIX_SLAB, PK, type LmPart, type PartMat } from '../plan/landmarkParts';
import { MeshBuilder } from './meshBuilder';
import earcut from 'earcut';
import { Dicer, isWreckable, wreckGrid, type WreckGrid } from './landmarkDice';
import { facadeSpecs } from './buildingShell';

type V3 = [number, number, number];

/** Roof flag (no openings): build/buildingShell FF.Roof. */
const ROOF_FLAG = 128;

/** The landmark's mesh for a LOD: its facade parts, or (clear) only its clear glass; diced into pieces with a dicer. */
export function buildLandmarkMesh(lm: Landmark, terrain: Terrain, lod: number, clear = false, dicer?: Dicer): MeshBuilder {
  const mb = new MeshBuilder(facadeSpecs());
  mb.setOrigin(Math.round(lm.x), Math.round(lm.base), Math.round(lm.z));
  mb.set('aSeed', (lm.seed % 10007) / 10007).set('aElem', 0);
  const E = new Emitter(mb, lod, dicer);
  for (const p of landmarkParts(lm, terrain)) {
    if (p.hidden || (lod > 0 && p.detail) || !!p.clear !== clear) continue;
    E.part(p);
  }
  return mb;
}

/** A landmark's meshes: near and far facade, clear glass (near, far) if any, and for a breakable one its pieces. */
export interface LandmarkMeshes {
  near: MeshBuilder;
  far: MeshBuilder;
  glass: [MeshBuilder, MeshBuilder] | null;
  /** Breakable (isWreckable): the piece table (landmarkDice PIECE_STRIDE) and its grid. */
  pieces: Float32Array | null;
  grid: WreckGrid | null;
}

export function buildLandmarkMeshes(lm: Landmark, terrain: Terrain): LandmarkMeshes {
  if (!isWreckable(lm)) {
    const gn = buildLandmarkMesh(lm, terrain, 0, true);
    return { near: buildLandmarkMesh(lm, terrain, 0), far: buildLandmarkMesh(lm, terrain, 1), glass: gn.empty ? null : [gn, buildLandmarkMesh(lm, terrain, 1, true)], pieces: null, grid: null };
  }
  const grid = wreckGrid(lm, landmarkParts(lm, terrain));
  const d0 = new Dicer(grid);
  const near = buildLandmarkMesh(lm, terrain, 0, false, d0);
  // (The near glass names pieces too: a glass dome or orb breaks like the rest.)
  const gn = buildLandmarkMesh(lm, terrain, 0, true, d0);
  const pieces = d0.table();
  const D = () => new Dicer(grid, pieces);
  return { near, far: buildLandmarkMesh(lm, terrain, 1, false, D()), glass: gn.empty ? null : [gn, buildLandmarkMesh(lm, terrain, 1, true, D())], pieces, grid };
}

class Emitter {
  /** The part being emitted is window glass (its bits go to glass pieces). */
  private pane = false;

  constructor(readonly mb: MeshBuilder, readonly lod: number, readonly dicer?: Dicer) {}

  private use(m: PartMat): void {
    this.mb.set('aLayer', m.layer).set('aTint', ...m.tint).set('aFacade', m.bay, m.fh, m.gh, m.flags);
  }

  /** Top surfaces: the part's top material, else its own without openings. */
  private useTop(p: LmPart): void {
    if (p.top) this.use(p.top);
    else this.use({ ...p.m, flags: p.m.flags & ROOF_FLAG });
  }

  /** Plain foundation material (no windows), a little darker. */
  private usePlinth(p: LmPart): void {
    const t = p.m.tint;
    this.use({ layer: p.m.layer === 10 ? 13 : p.m.layer, tint: [t[0] * 0.8, t[1] * 0.8, t[2] * 0.8], flags: 0, bay: 3, fh: 4, gh: 4 });
  }

  /**
   * Convex polygon with per-vertex uv and normals (one normal for all, or one each). The winding
   * is made counter-clockwise around the normal, so the front face is the outside.
   */
  poly(P: V3[], uv: [number, number][], n: V3 | V3[]): void {
    if (this.dicer) {
      const one = typeof n[0] === 'number';
      const verts = P.map((p, i) => ({ p, uv: uv[i], n: one ? (n as V3) : (n as V3[])[i] }));
      // (The polygon's own facing, for the bits: one normal for the whole polygon keeps the winding.)
      let ax = 0, ay = 0, az = 0;
      for (const v of verts) { ax += v.n[0]; ay += v.n[1]; az += v.n[2]; }
      const face: V3 = [ax, ay, az];
      this.dicer.split(verts, this.mb.cur.aLayer[0], this.pane, (bit, elem) => {
        this.mb.set('aElem', elem);
        this.rawPoly(bit.map((v) => v.p), bit.map((v) => v.uv), bit.map((v) => v.n), face);
      });
      this.mb.set('aElem', 0);
      return;
    }
    this.rawPoly(P, uv, n);
  }

  private rawPoly(P: V3[], uv: [number, number][], n: V3 | V3[], face?: V3): void {
    const mb = this.mb, k = P.length;
    let gx = 0, gy = 0, gz = 0;
    for (let i = 0; i < k; i++) {
      const a = P[i], b = P[(i + 1) % k];
      gx += (a[1] - b[1]) * (a[2] + b[2]);
      gy += (a[2] - b[2]) * (a[0] + b[0]);
      gz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const one = typeof n[0] === 'number';
    let ax = 0, ay = 0, az = 0;
    if (face) { ax = face[0]; ay = face[1]; az = face[2]; }
    else if (one) { const q = n as V3; ax = q[0]; ay = q[1]; az = q[2]; }
    else for (const q of n as V3[]) { ax += q[0]; ay += q[1]; az += q[2]; }
    if (gx * gx + gy * gy + gz * gz < 1e-10) return;
    const flip = gx * ax + gy * ay + gz * az < 0;
    const i0 = mb.vcount;
    for (let i = 0; i < k; i++) {
      const q = one ? (n as V3) : (n as V3[])[i];
      mb.v(P[i][0], P[i][1], P[i][2], q[0], q[1], q[2], uv[i][0], uv[i][1]);
    }
    for (let i = 1; i + 1 < k; i++) {
      if (flip) mb.tri(i0, i0 + i + 1, i0 + i);
      else mb.tri(i0, i0 + i, i0 + i + 1);
    }
  }

  /** Vertical wall quad from (ax, az) to (bx, bz) between y0 and y1; u from u0 along it. */
  wall(ax: number, az: number, bx: number, bz: number, y0: number, y1: number, nx: number, nz: number, u0 = 0, vBase = y0): void {
    if (y1 - y0 < 1e-3) return;
    const L = Math.hypot(bx - ax, bz - az);
    this.poly([[ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az]], [[u0, y0 - vBase], [u0 + L, y0 - vBase], [u0 + L, y1 - vBase], [u0, y1 - vBase]], [nx, 0, nz]);
  }

  /** Horizontal polygon (world xz as uv). */
  cap(pts: [number, number][], y: number, up: boolean): void {
    this.poly(pts.map(([x, z]) => [x, y, z] as V3), pts.map(([x, z]) => [x, z]), [0, up ? 1 : -1, 0]);
  }

  part(p: LmPart): void {
    this.pane = !!p.pane;
    switch (p.k) {
      case PK.Box: return this.box(p);
      case PK.Cyl: return this.cyl(p);
      case PK.Dome: return this.dome(p);
      case PK.Gable: return this.gable(p);
      case PK.Pyramid: return this.pyramid(p);
      case PK.Ramp: return this.ramp(p);
      case PK.Beam: return this.beam(p);
      case PK.Tube: return this.tube(p);
      case PK.Vault: return this.vault(p);
      case PK.Flat: return this.flat(p);
      case PK.Quad: return this.quad(p);
      case PK.Lathe: return this.lathe(p);
      case PK.Prism: return this.prism(p);
      case PK.Perf: return this.perf(p);
      case PK.Helix: return this.helix(p);
      case PK.Strut: return this.strut(p);
    }
  }

  /** A cylinder between two points (any direction). */
  strut(p: LmPart): void {
    const n = this.segs(p, 10), rad = p.w ?? 0.3;
    const a: V3 = [p.x, p.y0, p.z], b: V3 = [p.bx!, p.by!, p.bz!];
    const d = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]), L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    // Two axes across the strut.
    const h: V3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const e1 = norm([d[1] * h[2] - d[2] * h[1], d[2] * h[0] - d[0] * h[2], d[0] * h[1] - d[1] * h[0]]);
    const e2: V3 = [d[1] * e1[2] - d[2] * e1[1], d[2] * e1[0] - d[0] * e1[2], d[0] * e1[1] - d[1] * e1[0]];
    const dir = (t: number): V3 => [e1[0] * Math.cos(t) + e2[0] * Math.sin(t), e1[1] * Math.cos(t) + e2[1] * Math.sin(t), e1[2] * Math.cos(t) + e2[2] * Math.sin(t)];
    this.use(p.m);
    for (let i = 0; i < n; i++) {
      const t0 = (i / n) * Math.PI * 2, t1 = ((i + 1) / n) * Math.PI * 2, q0 = dir(t0), q1 = dir(t1);
      const P = (q: V3, e: V3): V3 => [e[0] + q[0] * rad, e[1] + q[1] * rad, e[2] + q[2] * rad];
      this.poly([P(q0, a), P(q1, a), P(q1, b), P(q0, b)], [[t0 * rad, 0], [t1 * rad, 0], [t1 * rad, L], [t0 * rad, L]], [q0, q1, q1, q0]);
    }
  }

  /** Triangles (index triples into P) with their winding turned to face the normal(s). */
  tris(P: V3[], uv: [number, number][], n: V3 | V3[], idx: ArrayLike<number>): void {
    const mb = this.mb, one = typeof n[0] === 'number';
    if (this.dicer) {
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const I = [idx[t], idx[t + 1], idx[t + 2]];
        this.poly(I.map((i) => P[i]), I.map((i) => uv[i]), one ? (n as V3) : I.map((i) => (n as V3[])[i]));
      }
      return;
    }
    const i0 = mb.vcount;
    for (let i = 0; i < P.length; i++) {
      const q = one ? (n as V3) : (n as V3[])[i];
      mb.v(P[i][0], P[i][1], P[i][2], q[0], q[1], q[2], uv[i][0], uv[i][1]);
    }
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const A = P[a], B = P[b], C = P[c];
      const ex = B[0] - A[0], ey = B[1] - A[1], ez = B[2] - A[2], fx = C[0] - A[0], fy = C[1] - A[1], fz = C[2] - A[2];
      const gx = ey * fz - ez * fy, gy = ez * fx - ex * fz, gz = ex * fy - ey * fx;
      const q = one ? (n as V3) : (n as V3[])[a];
      if (gx * q[0] + gy * q[1] + gz * q[2] < 0) mb.tri(i0 + a, i0 + c, i0 + b);
      else mb.tri(i0 + a, i0 + b, i0 + c);
    }
  }

  /** Surface of revolution (elliptical by hx, hz): bands between the profile's rings, caps at open ends. */
  lathe(p: LmPart): void {
    const P = p.pts!, n = this.segs(p, 32), K = P.length >> 1;
    const c = Math.cos(p.a), s = Math.sin(p.a), sx = p.hx, sz = p.hz;
    const closed = latheClosed(P);
    const at = (t: number, r: number, y: number): V3 => {
      const u = Math.cos(t) * r * sx, v = Math.sin(t) * r * sz;
      return [p.x + u * c - v * s, y, p.z + u * s + v * c];
    };
    // Profile step normals (radial, y) and per-ring normals: smooth across gentle bends, sharp at corners.
    const segN: [number, number][] = [];
    for (let i = 0; i + 1 < K; i++) {
      const dr = P[i * 2 + 2] - P[i * 2], dy = P[i * 2 + 3] - P[i * 2 + 1], l = Math.hypot(dr, dy) || 1;
      segN.push([dy / l, -dr / l]);
    }
    const nAt = (i: number, side: 0 | 1): [number, number] => {
      // Normal at ring i for the step i (side 0: its start) or i-1 (side 1: its end).
      const own = segN[side ? i - 1 : i];
      const otherIdx = side ? i : i - 1;
      const other = otherIdx >= 0 && otherIdx < segN.length ? segN[otherIdx] : closed ? segN[(otherIdx + segN.length) % segN.length] : null;
      if (!other || own[0] * other[0] + own[1] * other[1] < 0.7) return own;
      const l = Math.hypot(own[0] + other[0], own[1] + other[1]) || 1;
      return [(own[0] + other[0]) / l, (own[1] + other[1]) / l];
    };
    const nrm = (t: number, q: [number, number]): V3 => {
      const u = (Math.cos(t) / sx) * q[0], v = (Math.sin(t) / sz) * q[0];
      return norm([u * c - v * s, q[1], u * s + v * c]);
    };
    this.use(p.m);
    let len = 0;
    const rs = (sx + sz) / 2;
    for (let i = 0; i + 1 < K; i++) {
      const r0 = P[i * 2], y0 = P[i * 2 + 1], r1 = P[i * 2 + 2], y1 = P[i * 2 + 3];
      const L = Math.hypot(r1 - r0, y1 - y0);
      if (L < 1e-4) continue;
      const q0 = nAt(i, 0), q1 = nAt(i + 1, 1);
      for (let j = 0; j < n; j++) {
        const t0 = (j / n) * Math.PI * 2, t1 = ((j + 1) / n) * Math.PI * 2;
        const pts: V3[] = [at(t0, r0, y0), at(t1, r0, y0), at(t1, r1, y1), at(t0, r1, y1)];
        const uv: [number, number][] = [[t0 * r0 * rs, len], [t1 * r0 * rs, len], [t1 * r1 * rs, len + L], [t0 * r1 * rs, len + L]];
        const nn: V3[] = [nrm(t0, q0), nrm(t1, q0), nrm(t1, q1), nrm(t0, q1)];
        if (r0 < 1e-3) this.poly([pts[0], pts[2], pts[3]], [uv[0], uv[2], uv[3]], [nn[0], nn[2], nn[3]]);
        else if (r1 < 1e-3) this.poly([pts[0], pts[1], pts[2]], [uv[0], uv[1], uv[2]], [nn[0], nn[1], nn[2]]);
        else this.poly(pts, uv, nn);
      }
      len += L;
    }
    if (closed || p.noSides) return;
    const cap = (r: number, y: number, up: boolean) => {
      if (r < 1e-3) return;
      const ring: [number, number][] = [];
      for (let j = 0; j < n; j++) { const q = at((j / n) * Math.PI * 2, r, y); ring.push([q[0], q[2]]); }
      this.cap(ring, y, up);
    };
    this.useTop(p);
    cap(P[K * 2 - 2], P[K * 2 - 1], true);
    if (p.foot === undefined) { this.use(p.m); cap(P[0], P[1], false); }
  }

  /** A slab in a vertical plane: the outline on both faces, its edges between them. */
  prism(p: LmPart): void {
    const P = p.pts!, k = P.length >> 1, c = Math.cos(p.a), s = Math.sin(p.a);
    const W = (u: number, v: number, y: number): V3 => [p.x + u * c - v * s, y, p.z + u * s + v * c];
    const flat: number[] = [];
    for (let i = 0; i < k; i++) flat.push(P[i * 2], P[i * 2 + 1]);
    const idx = earcut(flat);
    this.use(p.m);
    for (const sv of [-1, 1]) {
      const pts: V3[] = [], uv: [number, number][] = [];
      for (let i = 0; i < k; i++) { pts.push(W(P[i * 2], sv * p.hz, P[i * 2 + 1])); uv.push([sv * P[i * 2], P[i * 2 + 1] - p.y0]); }
      this.tris(pts, uv, [-s * sv, 0, c * sv], idx);
    }
    // Edges: outward in the plane is (dy, -du) for a CCW outline (u right, y up).
    let area = 0;
    for (let i = 0; i < k; i++) { const j = (i + 1) % k; area += P[i * 2] * P[j * 2 + 1] - P[j * 2] * P[i * 2 + 1]; }
    const sg = area >= 0 ? 1 : -1;
    let run = 0;
    for (let i = 0; i < k; i++) {
      const j = (i + 1) % k, du = P[j * 2] - P[i * 2], dy = P[j * 2 + 1] - P[i * 2 + 1], L = Math.hypot(du, dy);
      if (L < 1e-4) continue;
      const nu = (sg * dy) / L, ny = (-sg * du) / L;
      if (ny > 0.5) this.useTop(p); else this.use(p.m);
      const nw: V3 = [nu * c, ny, nu * s];
      this.poly([W(P[i * 2], -p.hz, P[i * 2 + 1]), W(P[j * 2], -p.hz, P[j * 2 + 1]), W(P[j * 2], p.hz, P[j * 2 + 1]), W(P[i * 2], p.hz, P[i * 2 + 1])],
        [[run, 0], [run + L, 0], [run + L, 2 * p.hz], [run, 2 * p.hz]], nw);
      run += L;
    }
  }

  /** A slab pierced by round holes along v: both faces with the holes cut out, the holes lined. */
  perf(p: LmPart): void {
    const H = p.pts!, n = this.segs(p, 24), c = Math.cos(p.a), s = Math.sin(p.a);
    const W = (u: number, v: number, y: number): V3 => [p.x + u * c - v * s, y, p.z + u * s + v * c];
    const R = this.rect(p, p.hx, p.hz);
    this.foot(p, R);
    // Face outline (u, y) with the holes (clockwise rings for earcut's holes: any winding works).
    const flat = [-p.hx, p.y0, p.hx, p.y0, p.hx, p.y1, -p.hx, p.y1];
    const holes: number[] = [];
    for (let i = 0; i < H.length; i += 3) {
      holes.push(flat.length >> 1);
      for (let j = 0; j < n; j++) { const t = (-j / n) * Math.PI * 2; flat.push(H[i] + Math.cos(t) * H[i + 2], H[i + 1] + Math.sin(t) * H[i + 2]); }
    }
    const idx = earcut(flat, holes);
    this.use(p.m);
    for (const sv of [-1, 1]) {
      const pts: V3[] = [], uv: [number, number][] = [];
      for (let i = 0; i < flat.length; i += 2) { pts.push(W(flat[i], sv * p.hz, flat[i + 1])); uv.push([sv * flat[i] + p.hx, flat[i + 1] - p.y0]); }
      this.tris(pts, uv, [-s * sv, 0, c * sv], idx);
    }
    // Ends (u = ±hx), roof, underside.
    for (const su of [-1, 1]) this.poly([W(su * p.hx, -p.hz, p.y0), W(su * p.hx, p.hz, p.y0), W(su * p.hx, p.hz, p.y1), W(su * p.hx, -p.hz, p.y1)],
      [[0, 0], [2 * p.hz, 0], [2 * p.hz, p.y1 - p.y0], [0, p.y1 - p.y0]], [su * c, 0, su * s]);
    this.useTop(p);
    this.cap(R, p.y1, true);
    if (p.foot === undefined) { this.use(p.m); this.cap(R, p.y0, false); }
    // Hole linings (facing the hole's axis), in the lining material.
    this.use(p.back ?? { ...p.m, flags: 0 });
    for (let i = 0; i < H.length; i += 3) {
      const hu = H[i], hy = H[i + 1], hr = H[i + 2];
      for (let j = 0; j < n; j++) {
        const t0 = (j / n) * Math.PI * 2, t1 = ((j + 1) / n) * Math.PI * 2;
        const a = (t: number, v: number) => W(hu + Math.cos(t) * hr, v, hy + Math.sin(t) * hr);
        const nn = (t: number): V3 => norm([-Math.cos(t) * c, -Math.sin(t), -Math.cos(t) * s]);
        this.poly([a(t0, -p.hz), a(t1, -p.hz), a(t1, p.hz), a(t0, p.hz)], [[t0 * hr, 0], [t1 * hr, 0], [t1 * hr, 2 * p.hz], [t0 * hr, 2 * p.hz]], [nn(t0), nn(t1), nn(t1), nn(t0)]);
      }
    }
  }

  /**
   * Helix walkway: the opaque part draws the floor slab (top, underside, outer edge) and a roof
   * edge; the clear part the glass wall outside and the glass roof.
   */
  helix(p: LmPart): void {
    const turns = Math.abs(p.turns!), sg = p.turns! < 0 ? -1 : 1, r0 = p.r!, r1 = p.r2!, hh = p.hh!;
    const per = this.lod > 0 ? Math.max(12, Math.round((p.seg ?? 48) / 2)) : p.seg ?? 48;
    const N = Math.max(4, Math.ceil(turns * per)), full = turns * Math.PI * 2;
    const at = (phi: number, r: number, y: number): V3 => { const t = p.a + sg * phi; return [p.x + Math.cos(t) * r, y, p.z + Math.sin(t) * r]; };
    const out = (phi: number): V3 => { const t = p.a + sg * phi; return [Math.cos(t), 0, Math.sin(t)]; };
    const w = r1 - r0, arc = (phi: number, r: number) => phi * r;
    this.use(p.m);
    for (let i = 0; i < N; i++) {
      const fa = (i / N) * full, fb = ((i + 1) / N) * full;
      const ya = helixFloorAt(p, fa), yb = helixFloorAt(p, fb);
      const na = out(fa), nb = out(fb);
      if (!p.clear) {
        // Floor (walking surface), underside, outer and inner edges.
        this.useTop(p);
        this.poly([at(fa, r0, ya), at(fa, r1, ya), at(fb, r1, yb), at(fb, r0, yb)], [[0, arc(fa, r0)], [w, arc(fa, r0)], [w, arc(fb, r0)], [0, arc(fb, r0)]], [0, 1, 0]);
        this.use(p.m);
        this.poly([at(fa, r0, ya - HELIX_SLAB), at(fa, r1, ya - HELIX_SLAB), at(fb, r1, yb - HELIX_SLAB), at(fb, r0, yb - HELIX_SLAB)], [[0, arc(fa, r0)], [w, arc(fa, r0)], [w, arc(fb, r0)], [0, arc(fb, r0)]], [0, -1, 0]);
        this.poly([at(fa, r1, ya - HELIX_SLAB), at(fb, r1, yb - HELIX_SLAB), at(fb, r1, yb), at(fa, r1, ya)], [[arc(fa, r1), 0], [arc(fb, r1), 0], [arc(fb, r1), HELIX_SLAB], [arc(fa, r1), HELIX_SLAB]], [na, nb, nb, na]);
        // Roof rim (a band of the frame along the top of the glass).
        this.poly([at(fa, r1 + 0.05, ya + hh - 0.35), at(fb, r1 + 0.05, yb + hh - 0.35), at(fb, r1 + 0.05, yb + hh), at(fa, r1 + 0.05, ya + hh)], [[arc(fa, r1), 0], [arc(fb, r1), 0], [arc(fb, r1), 0.35], [arc(fa, r1), 0.35]], [na, nb, nb, na]);
      } else {
        // Glass wall outside and the glass roof.
        this.poly([at(fa, r1, ya), at(fb, r1, yb), at(fb, r1, yb + hh), at(fa, r1, ya + hh)], [[arc(fa, r1), 0], [arc(fb, r1), 0], [arc(fb, r1), hh], [arc(fa, r1), hh]], [na, nb, nb, na]);
        this.poly([at(fa, r0, ya + hh), at(fa, r1, ya + hh), at(fb, r1, yb + hh), at(fb, r0, yb + hh)], [[0, arc(fa, r0)], [w, arc(fa, r0)], [w, arc(fb, r0)], [0, arc(fb, r0)]], [0, 1, 0]);
      }
    }
    // Mullions every few metres along the outside (near only).
    if (!p.clear && this.lod === 0) {
      const step = Math.max(1, Math.round(N / Math.max(1, (full * r1) / 3.2)));
      for (let i = 0; i <= N; i += step) {
        const f = (i / N) * full, y = helixFloorAt(p, f), q = at(f, r1 + 0.05, y);
        if (this.dicer) this.mb.set('aElem', this.dicer.idAt(q[0], y + hh / 2, q[2]));
        this.mb.beam(q[0], y, q[2], q[0], y + hh, q[2], 0.06, 0.06);
      }
      this.mb.set('aElem', 0);
    }
  }

  /** Corners of the part's rectangle (half sizes a along u, b along v), CCW from above. */
  private rect(p: LmPart, a: number, b: number): [number, number][] {
    const c = Math.cos(p.a), s = Math.sin(p.a);
    const P = (u: number, v: number): [number, number] => [p.x + u * c - v * s, p.z + u * s + v * c];
    return [P(-a, -b), P(a, -b), P(a, b), P(-a, b)];
  }

  /** Walls around a CCW ring of points between y0 and y1 (u running on around the ring). */
  private ringWalls(R: [number, number][], y0: number, y1: number, vBase = y0): void {
    let u = 0;
    for (let i = 0; i < R.length; i++) {
      const [ax, az] = R[i], [bx, bz] = R[(i + 1) % R.length];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-4) continue;
      this.wall(ax, az, bx, bz, y0, y1, (bz - az) / L, -(bx - ax) / L, 0, vBase);
      u += L;
    }
  }

  private foot(p: LmPart, R: [number, number][]): void {
    if (p.foot === undefined || p.foot > p.y0 - 0.05) return;
    this.usePlinth(p);
    this.ringWalls(R, p.foot, p.y0);
  }

  box(p: LmPart): void {
    const R = this.rect(p, p.hx, p.hz);
    this.foot(p, R);
    this.use(p.m);
    this.ringWalls(R, p.y0, p.y1);
    this.useTop(p);
    this.cap(R, p.y1, true);
    // Underside of parts that do not stand on a foundation (attics, platforms, pods).
    if (p.foot === undefined) { this.use(p.m); this.cap(R, p.y0, false); }
  }

  private segs(p: LmPart, def: number): number {
    const n = p.seg ?? def;
    return this.lod > 0 ? Math.max(6, Math.round(n / 2)) : n;
  }

  cyl(p: LmPart): void {
    const n = this.segs(p, 20), r0 = p.r ?? p.hx, r1 = p.r2 ?? r0, h = p.y1 - p.y0;
    // (A half one sweeps the part's +v side only, like a half dome.)
    const half = !!p.half, m = half ? Math.max(3, n >> 1) : n, a0f = half ? p.a : 0, step = (half ? Math.PI : Math.PI * 2) / m;
    const ring = (r: number): [number, number][] => Array.from({ length: half ? m + 1 : m }, (_, i) => [p.x + Math.cos(a0f + i * step) * r, p.z + Math.sin(a0f + i * step) * r]);
    const R0 = ring(r0), R1 = ring(r1);
    if (p.foot !== undefined && p.foot < p.y0 - 0.05) { this.usePlinth(p); this.ringWalls(R0, p.foot, p.y0); }
    this.use(p.m);
    const ny = r0 - r1;
    for (let i = 0; i < m; i++) {
      const j = half ? i + 1 : (i + 1) % m;
      const a0 = a0f + i * step, a1 = a0f + (i + 1) * step;
      const n0: V3 = norm([Math.cos(a0) * h, ny, Math.sin(a0) * h]), n1: V3 = norm([Math.cos(a1) * h, ny, Math.sin(a1) * h]);
      const u0 = a0 * r0, u1 = a1 * r0;
      if (r1 > 1e-3) this.poly([[R0[i][0], p.y0, R0[i][1]], [R0[j][0], p.y0, R0[j][1]], [R1[j][0], p.y1, R1[j][1]], [R1[i][0], p.y1, R1[i][1]]], [[u0, 0], [u1, 0], [u1, h], [u0, h]], [n0, n1, n1, n0]);
      else this.poly([[R0[i][0], p.y0, R0[i][1]], [R0[j][0], p.y0, R0[j][1]], [p.x, p.y1, p.z]], [[u0, 0], [u1, 0], [(u0 + u1) / 2, h]], [n0, n1, norm([n0[0] + n1[0], n0[1] + n1[1], n0[2] + n1[2]])]);
    }
    if (half) return;
    if (r1 > 1e-3) { this.useTop(p); this.cap(R1, p.y1, true); }
    if (p.foot === undefined && p.y0 > 0) { this.use(p.m); this.cap(R0, p.y0, false); }
  }

  dome(p: LmPart): void {
    const n = this.segs(p, 20), K = this.lod > 0 ? 4 : 7;
    const h = p.y1 - p.y0, c = Math.cos(p.a), s = Math.sin(p.a);
    const pt = (t: number, f: number): V3 => {
      const u = Math.cos(t) * p.hx * Math.cos(f), v = Math.sin(t) * p.hz * Math.cos(f);
      return [p.x + u * c - v * s, p.y0 + h * Math.sin(f), p.z + u * s + v * c];
    };
    const sg = p.inward ? -1 : 1, sweep = p.half ? Math.PI : Math.PI * 2, m = p.half ? Math.max(3, n >> 1) : n;
    const nr = (t: number, f: number): V3 => {
      const u = Math.cos(t) * Math.cos(f) / p.hx, v = Math.sin(t) * Math.cos(f) / p.hz;
      return norm([(u * c - v * s) * sg, (Math.sin(f) / h) * sg, (u * s + v * c) * sg]);
    };
    this.use(p.m);
    for (let k = 0; k < K; k++) {
      const f0 = (k / K) * Math.PI / 2, f1 = ((k + 1) / K) * Math.PI / 2;
      for (let i = 0; i < m; i++) {
        const t0 = (i / m) * sweep, t1 = ((i + 1) / m) * sweep;
        const uv = (t: number, f: number): [number, number] => [t * p.hx, f * Math.abs(h)];
        if (k === K - 1) this.poly([pt(t0, f0), pt(t1, f0), pt(t0, f1)], [uv(t0, f0), uv(t1, f0), uv(t0, f1)], [nr(t0, f0), nr(t1, f0), nr(t0, f1)]);
        else this.poly([pt(t0, f0), pt(t1, f0), pt(t1, f1), pt(t0, f1)], [uv(t0, f0), uv(t1, f0), uv(t1, f1), uv(t0, f1)], [nr(t0, f0), nr(t1, f0), nr(t1, f1), nr(t0, f1)]);
      }
    }
  }

  gable(p: LmPart): void {
    const o = 0.35, rise = p.y1 - p.y0, slope = rise / p.hz;
    const c = Math.cos(p.a), s = Math.sin(p.a);
    const P = (u: number, v: number, y: number): V3 => [p.x + u * c - v * s, y, p.z + u * s + v * c];
    const ye = p.y0 - o * slope, hu = p.hx + o;
    this.useTop(p);
    for (const sv of [-1, 1]) {
      // Slope y = y1 - sv·slope·v: normal (0, sv·slope, 1) in (u, v, y), v = (-sin, cos) in world.
      const wn = norm([-s * sv * slope, 1, c * sv * slope]);
      const L = Math.hypot(p.hz + o, rise + o * slope);
      this.poly([P(-hu, sv * (p.hz + o), ye), P(hu, sv * (p.hz + o), ye), P(hu, 0, p.y1), P(-hu, 0, p.y1)], [[0, 0], [hu * 2, 0], [hu * 2, L], [0, L]], wn);
    }
    this.use({ ...p.m, flags: 0 });
    for (const su of [-1, 1]) this.poly([P(su * p.hx, -p.hz, p.y0), P(su * p.hx, p.hz, p.y0), P(su * p.hx, 0, p.y1)], [[0, 0], [p.hz * 2, 0], [p.hz, rise]], [su * c, 0, su * s]);
  }

  pyramid(p: LmPart): void {
    const t = p.r2 ?? 0, B = this.rect(p, p.hx, p.hz), T = this.rect(p, p.hx * t, p.hz * t);
    if (p.foot !== undefined && p.foot < p.y0 - 0.05) { this.usePlinth(p); this.ringWalls(B, p.foot, p.y0); }
    this.use(p.m);
    const h = p.y1 - p.y0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const ex = B[j][0] - B[i][0], ez = B[j][1] - B[i][1], L = Math.hypot(ex, ez);
      const inset = (i % 2 === 0 ? p.hz : p.hx) * (1 - t);
      const n = norm([(ez / L) * h, inset, -(ex / L) * h]);
      const sl = Math.hypot(h, inset);
      if (t > 1e-3) this.poly([[B[i][0], p.y0, B[i][1]], [B[j][0], p.y0, B[j][1]], [T[j][0], p.y1, T[j][1]], [T[i][0], p.y1, T[i][1]]], [[0, 0], [L, 0], [L * (0.5 + t / 2), sl], [L * (0.5 - t / 2), sl]], n);
      else this.poly([[B[i][0], p.y0, B[i][1]], [B[j][0], p.y0, B[j][1]], [p.x, p.y1, p.z]], [[0, 0], [L, 0], [L / 2, sl]], n);
    }
    if (t > 1e-3) { this.useTop(p); this.cap(T, p.y1, true); }
  }

  /** Corners of a stand on the ground: front left, front right, back right, back left (x, z). */
  private rampCorners(p: LmPart): [number, number][] {
    if (p.q && p.q.length === 8) return [[p.q[0], p.q[1]], [p.q[2], p.q[3]], [p.q[4], p.q[5]], [p.q[6], p.q[7]]];
    const c = Math.cos(p.a), s = Math.sin(p.a), a = p.hx, b = p.hx2 ?? p.hx, hz = p.hz;
    const P = (u: number, v: number): [number, number] => [p.x + u * c - v * s, p.z + u * s + v * c];
    return [P(-a, -hz), P(a, -hz), P(b, hz), P(-b, hz)];
  }

  /** Sloped stand (a quadrilateral prism): stepped seat rows near, a plain slope far. */
  ramp(p: LmPart): void {
    const [F0, F1, K1, K0] = this.rampCorners(p), yLo = p.yLo ?? p.y1;
    const at = (s: number, t: number, y: number): V3 => {
      const fx = F0[0] + (F1[0] - F0[0]) * s, fz = F0[1] + (F1[1] - F0[1]) * s;
      const kx = K0[0] + (K1[0] - K0[0]) * s, kz = K0[1] + (K1[1] - K0[1]) * s;
      return [fx + (kx - fx) * t, y, fz + (kz - fz) * t];
    };
    // Outward hints: front (towards the field) and back.
    const fm = [(F0[0] + F1[0]) / 2, (F0[1] + F1[1]) / 2], km = [(K0[0] + K1[0]) / 2, (K0[1] + K1[1]) / 2];
    const dl = Math.hypot(km[0] - fm[0], km[1] - fm[1]) || 1;
    const nf: V3 = [(fm[0] - km[0]) / dl, 0, (fm[1] - km[1]) / dl], nb: V3 = [-nf[0], 0, -nf[2]];
    const wF = Math.hypot(F1[0] - F0[0], F1[1] - F0[1]), wK = Math.hypot(K1[0] - K0[0], K1[1] - K0[1]);
    if (p.foot !== undefined && p.foot < p.y0 - 0.05) {
      this.usePlinth(p);
      this.poly([at(0, 0, p.foot), at(1, 0, p.foot), at(1, 0, p.y0), at(0, 0, p.y0)], [[0, 0], [wF, 0], [wF, p.y0 - p.foot], [0, p.y0 - p.foot]], nf);
      this.poly([at(0, 1, p.foot), at(1, 1, p.foot), at(1, 1, p.y0), at(0, 1, p.y0)], [[0, 0], [wK, 0], [wK, p.y0 - p.foot], [0, p.y0 - p.foot]], nb);
    }
    this.use(p.m);
    if (yLo > p.y0 + 0.01) this.poly([at(0, 0, p.y0), at(1, 0, p.y0), at(1, 0, yLo), at(0, 0, yLo)], [[0, 0], [wF, 0], [wF, yLo - p.y0], [0, yLo - p.y0]], nf);
    this.use(p.back ?? p.m);
    this.poly([at(0, 1, p.y0), at(1, 1, p.y0), at(1, 1, p.y1), at(0, 1, p.y1)], [[0, 0], [wK, 0], [wK, p.y1 - p.y0], [0, p.y1 - p.y0]], nb);
    if (!p.noSides) {
      this.use(p.m);
      for (const s of [0, 1]) {
        const ex = (s ? F1[0] - F0[0] : F0[0] - F1[0]) / (wF || 1), ez = (s ? F1[1] - F0[1] : F0[1] - F1[1]) / (wF || 1);
        this.poly([at(s, 0, p.y0), at(s, 1, p.y0), at(s, 1, p.y1), at(s, 0, yLo)], [[0, 0], [dl, 0], [dl, p.y1 - p.y0], [0, yLo - p.y0]], [ex, 0, ez]);
      }
    }
    if (p.foot === undefined) { this.use(p.m); this.poly([at(0, 0, p.y0), at(1, 0, p.y0), at(1, 1, p.y0), at(0, 1, p.y0)], [[0, 0], [1, 0], [1, 1], [0, 1]], [0, -1, 0]); }
    this.useTop(p);
    const rows = this.lod > 0 ? 0 : p.rows ?? 0;
    if (rows < 2) {
      const L = Math.hypot(dl, p.y1 - yLo);
      const n = norm([nf[0] * (p.y1 - yLo), dl, nf[2] * (p.y1 - yLo)]);
      this.poly([at(0, 0, yLo), at(1, 0, yLo), at(1, 1, p.y1), at(0, 1, p.y1)], [[0, 0], [wF, 0], [wK, L], [0, L]], n);
      return;
    }
    // Seat rows: a riser and a tread per row.
    const dy = (p.y1 - yLo) / rows;
    for (let i = 0; i < rows; i++) {
      const t0 = i / rows, t1 = (i + 1) / rows, y = yLo + i * dy, y2 = y + dy;
      const w0 = wF + (wK - wF) * t0, w1 = wF + (wK - wF) * t1;
      this.poly([at(0, t0, y), at(1, t0, y), at(1, t0, y2), at(0, t0, y2)], [[0, 0], [w0, 0], [w0, dy], [0, dy]], nf);
      this.poly([at(0, t0, y2), at(1, t0, y2), at(1, t1, y2), at(0, t1, y2)], [[0, 0], [w0, 0], [w1, dl / rows], [0, dl / rows]], [0, 1, 0]);
    }
  }

  beam(p: LmPart): void {
    this.use(p.m);
    const w = p.w ?? 0.2;
    this.mb.beam(p.x, p.y0, p.z, p.bx!, p.by!, p.bz!, w, w);
  }

  tube(p: LmPart): void {
    const n = this.segs(p, 14), r0 = p.r ?? p.hz, r1 = p.r2 ?? r0, yc = (p.y0 + p.y1) / 2;
    const c = Math.cos(p.a), s = Math.sin(p.a);
    // Frame: u along the axis, w across horizontally, y up.
    const P = (u: number, t: number, r: number): V3 => {
      const w = Math.cos(t) * r, y = Math.sin(t) * r;
      return [p.x + u * c - w * s, yc + y, p.z + u * s + w * c];
    };
    const N = (t: number): V3 => norm([-Math.cos(t) * s, Math.sin(t), Math.cos(t) * c]);
    this.use(p.m);
    const L = 2 * p.hx;
    for (let i = 0; i < n; i++) {
      const t0 = (i / n) * Math.PI * 2, t1 = ((i + 1) / n) * Math.PI * 2;
      this.poly([P(-p.hx, t0, r0), P(-p.hx, t1, r0), P(p.hx, t1, r1), P(p.hx, t0, r1)], [[t0 * r0, 0], [t1 * r0, 0], [t1 * r0, L], [t0 * r0, L]], [N(t0), N(t1), N(t1), N(t0)]);
    }
    for (const [u, r, sg] of [[-p.hx, r0, -1], [p.hx, r1, 1]] as const) {
      if (r < 1e-3) continue;
      const pts: V3[] = [], uv: [number, number][] = [];
      for (let i = 0; i < n; i++) { const t = (i / n) * Math.PI * 2; pts.push(P(u, t, r)); uv.push([Math.cos(t) * r, Math.sin(t) * r]); }
      this.poly(pts, uv, [sg * c, 0, sg * s]);
    }
  }

  vault(p: LmPart): void {
    const n = this.segs(p, 14), h = p.y1 - p.y0;
    const c = Math.cos(p.a), s = Math.sin(p.a);
    const P = (u: number, f: number): V3 => {
      const v = -Math.cos(f) * p.hz;
      return [p.x + u * c - v * s, p.y0 + Math.sin(f) * h, p.z + u * s + v * c];
    };
    const sg = p.inward ? -1 : 1;
    const N = (f: number): V3 => { const v = -Math.cos(f) / p.hz; return norm([-v * s * sg, (Math.sin(f) / h) * sg, v * c * sg]); };
    this.use(p.m);
    for (let i = 0; i < n; i++) {
      const f0 = (i / n) * Math.PI, f1 = ((i + 1) / n) * Math.PI;
      const arc = (f: number) => f * (p.hz + h) / 2;
      this.poly([P(-p.hx, f0), P(p.hx, f0), P(p.hx, f1), P(-p.hx, f1)], [[0, arc(f0)], [2 * p.hx, arc(f0)], [2 * p.hx, arc(f1)], [0, arc(f1)]], [N(f0), N(f0), N(f1), N(f1)]);
    }
    if (p.inward) return;
    for (const su of [-1, 1]) {
      const pts: V3[] = [], uv: [number, number][] = [];
      for (let i = 0; i <= n; i++) { const f = (i / n) * Math.PI; pts.push(P(su * p.hx, f)); uv.push([-Math.cos(f) * p.hz + p.hz, Math.sin(f) * h]); }
      this.poly(pts, uv, [su * c, 0, su * s]);
    }
  }

  flat(p: LmPart): void {
    const R = this.rect(p, p.hx, p.hz);
    if (p.foot !== undefined && p.foot < p.y1 - 0.05) { this.usePlinth(p); this.ringWalls(R, p.foot, p.y1); }
    this.use(p.m);
    this.cap(R, p.y1, true);
  }

  quad(p: LmPart): void {
    const q = p.q!;
    this.use(p.m);
    const pts: V3[] = [[q[0], q[1], q[2]], [q[3], q[4], q[5]], [q[6], q[7], q[8]], [q[9], q[10], q[11]]];
    this.poly(pts, pts.map((v) => [v[0], v[2]]), [0, 1, 0]);
  }
}

function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
