/**
 * Shared art for the side rooms and hidden chambers: one canvas atlas (signs, graffiti, wall
 * markings, cracks, puddles, soft blobs) and small shape helpers on MeshBuilder (cylinders,
 * domes, decal quads, walls with openings) in a room frame.
 */
import * as THREE from 'three';
import type { MeshBuilder } from '../build/meshBuilder';
import { Rng } from '../core/rng';

/** Atlas cells (8 × 4 of 128 px). */
export const CELL = {
  white: 0, exit: 1, graffiti: 2 /* 2..5 */, roundel: 6, arrow: 7, chips: 8, frieze: 9,
  mark: 10 /* 10..13 */, crack: 14, puddle: 15, blob: 16, hazard: 17, grate: 18, volt: 19, poster: 20, stain: 21, streak: 22, dot: 23,
} as const;

const COLS = 8, ROWS = 4, PX = 128;

/** UV rectangle of an atlas cell (u0, v0, u1, v1), inset half a texel. */
export function cellUV(i: number): [number, number, number, number] {
  const c = i % COLS, r = Math.floor(i / COLS), e = 0.5 / (COLS * PX);
  // Canvas row 0 is the top; textures are flipped (v = 1 at the top).
  return [c / COLS + e, 1 - (r + 1) / ROWS + e, (c + 1) / COLS - e, 1 - r / ROWS - e];
}

export function roomAtlas(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = COLS * PX; cv.height = ROWS * PX;
  const g = cv.getContext('2d')!;
  const rng = new Rng(0x51a3e);
  const at = (i: number, fn: () => void) => {
    g.save();
    g.translate((i % COLS) * PX, Math.floor(i / COLS) * PX);
    g.beginPath(); g.rect(0, 0, PX, PX); g.clip();
    fn();
    g.restore();
  };
  at(CELL.white, () => { g.fillStyle = '#fff'; g.fillRect(0, 0, PX, PX); });
  // Emergency exit: green panel, running figure towards a doorway, arrow.
  at(CELL.exit, () => {
    g.fillStyle = '#0f9d58'; g.fillRect(0, 24, PX, 80);
    g.fillStyle = '#fff'; g.fillRect(86, 34, 30, 60);
    g.fillStyle = '#0f9d58'; g.fillRect(92, 40, 18, 54);
    g.strokeStyle = '#fff'; g.lineWidth = 7; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.arc(56, 38, 7, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
    g.beginPath(); g.moveTo(52, 50); g.lineTo(46, 70); g.lineTo(58, 80); g.lineTo(54, 96); g.stroke();
    g.beginPath(); g.moveTo(46, 70); g.lineTo(34, 92); g.stroke();
    g.beginPath(); g.moveTo(36, 56); g.lineTo(52, 50); g.lineTo(66, 62); g.stroke();
    g.beginPath(); g.moveTo(12, 64); g.lineTo(28, 64); g.moveTo(20, 56); g.lineTo(28, 64); g.lineTo(20, 72); g.stroke();
  });
  // Graffiti: loose scribbles, blobs and drips in two or three colours (no letters).
  const paints = ['#e8483b', '#f2c12e', '#3bb3e8', '#9b5de5', '#2ec27e', '#f15bb5', '#ffffff', '#ff8c42'];
  for (let k = 0; k < 4; k++) at(CELL.graffiti + k, () => {
    const cols = [rng.pick(paints), rng.pick(paints), '#1b1b1b'];
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (let pass = 0; pass < 3; pass++) {
      g.strokeStyle = cols[pass]; g.lineWidth = pass === 2 ? 3 : 9 - pass * 3;
      g.beginPath();
      let x = 18 + rng.range(0, 10), y = 64 + rng.range(-20, 20);
      g.moveTo(x, y);
      for (let s = 0; s < 7; s++) {
        const nx = Math.min(112, x + rng.range(8, 20)), ny = 64 + rng.range(-36, 36);
        g.bezierCurveTo(x + rng.range(-10, 20), y + rng.range(-40, 40), nx - rng.range(-10, 20), ny + rng.range(-40, 40), nx, ny);
        x = nx; y = ny;
      }
      g.stroke();
    }
    g.fillStyle = cols[0];
    for (let d = 0; d < 4; d++) { const x = rng.range(20, 108); g.fillRect(x, rng.range(70, 90), 2.5, rng.range(10, 30)); }
  });
  // Old signs: the city's old line emblem, an arrow, line chips, a tile frieze.
  at(CELL.roundel, () => {
    // (An old line emblem of this city: a green disc with a cream chevron band.)
    g.fillStyle = '#e9e2cf'; g.fillRect(0, 0, PX, PX);
    g.fillStyle = '#2f6b5a'; g.beginPath(); g.arc(64, 64, 46, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#e9e2cf'; g.beginPath(); g.moveTo(22, 52); g.lineTo(64, 76); g.lineTo(106, 52); g.lineTo(106, 66); g.lineTo(64, 90); g.lineTo(22, 66); g.fill();
    g.fillStyle = '#b5452f'; g.fillRect(0, 0, PX, 10); g.fillRect(0, PX - 10, PX, 10);
  });
  at(CELL.arrow, () => {
    g.fillStyle = '#244a7a'; g.fillRect(0, 30, PX, 68);
    g.fillStyle = '#e9e2cf'; g.beginPath(); g.moveTo(20, 56); g.lineTo(76, 56); g.lineTo(76, 42); g.lineTo(108, 64); g.lineTo(76, 86); g.lineTo(76, 72); g.lineTo(20, 72); g.fill();
  });
  at(CELL.chips, () => {
    g.fillStyle = '#20252b'; g.fillRect(0, 34, PX, 60);
    ['#e23b2e', '#1f6fd1', '#1d9a4a', '#f2b705'].forEach((c, i) => { g.fillStyle = c; g.beginPath(); g.arc(22 + i * 28, 64, 11, 0, Math.PI * 2); g.fill(); });
  });
  at(CELL.frieze, () => {
    g.fillStyle = '#d8cfb4'; g.fillRect(0, 0, PX, PX);
    for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? '#2f6b5a' : '#a0442e'; g.fillRect(i * 16, 52, 16, 24); }
  });
  // Wall markings of the hidden ones: spirals, rings of dots, waves, branching lines (white, tinted).
  g.strokeStyle = '#fff'; g.fillStyle = '#fff';
  at(CELL.mark, () => {
    g.strokeStyle = '#fff'; g.lineWidth = 5; g.lineCap = 'round'; g.beginPath();
    for (let a = 0; a < Math.PI * 7; a += 0.1) { const r = 4 + a * 2.6; g.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r); }
    g.stroke();
  });
  at(CELL.mark + 1, () => {
    g.fillStyle = '#fff';
    for (let ring = 0; ring < 4; ring++) for (let k = 0; k < 6 + ring * 6; k++) {
      const a = (k / (6 + ring * 6)) * Math.PI * 2, r = 12 + ring * 15;
      g.beginPath(); g.arc(64 + Math.cos(a) * r, 64 + Math.sin(a) * r, 4 - ring * 0.5, 0, Math.PI * 2); g.fill();
    }
    g.beginPath(); g.arc(64, 64, 6, 0, Math.PI * 2); g.fill();
  });
  at(CELL.mark + 2, () => {
    g.strokeStyle = '#fff'; g.lineWidth = 4; g.lineCap = 'round';
    for (let row = 0; row < 4; row++) {
      g.beginPath();
      for (let x = 8; x <= 120; x += 2) g.lineTo(x, 26 + row * 25 + Math.sin(x * 0.12 + row) * 8);
      g.stroke();
    }
  });
  at(CELL.mark + 3, () => {
    g.strokeStyle = '#fff'; g.lineCap = 'round';
    const branch = (x: number, y: number, a: number, len: number, w: number, d: number) => {
      const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
      g.lineWidth = w; g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
      g.beginPath(); g.arc(x2, y2, w * 0.8, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
      if (d > 0) { branch(x2, y2, a - 0.5, len * 0.7, w * 0.7, d - 1); branch(x2, y2, a + 0.45, len * 0.7, w * 0.7, d - 1); }
    };
    branch(64, 120, -Math.PI / 2, 34, 6, 3);
  });
  // A dark fissure (crevice), a puddle, a soft irregular blob, a small round dot.
  at(CELL.crack, () => {
    g.fillStyle = 'rgba(8,6,5,0.95)'; g.beginPath(); g.moveTo(64, 128);
    for (let y = 128; y > 10; y -= 8) g.lineTo(64 - 6 - (y / 128) * 14 + rng.range(-5, 5), y);
    for (let y = 10; y <= 128; y += 8) g.lineTo(64 + 6 + (y / 128) * 14 + rng.range(-5, 5), y);
    g.fill();
  });
  at(CELL.puddle, () => {
    const gr = g.createRadialGradient(64, 64, 10, 64, 64, 62);
    gr.addColorStop(0, 'rgba(20,24,26,0.85)'); gr.addColorStop(0.7, 'rgba(25,28,30,0.6)'); gr.addColorStop(1, 'rgba(25,28,30,0)');
    g.fillStyle = gr; g.beginPath(); g.ellipse(64, 64, 62, 46, 0, 0, Math.PI * 2); g.fill();
  });
  at(CELL.blob, () => {
    g.fillStyle = '#fff'; g.beginPath();
    for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.2) { const r = 44 + Math.sin(a * 3) * 8 + Math.sin(a * 7 + 1) * 6; g.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r); }
    g.fill();
  });
  at(CELL.dot, () => { g.fillStyle = '#fff'; g.beginPath(); g.arc(64, 64, 40, 0, Math.PI * 2); g.fill(); });
  at(CELL.hazard, () => {
    g.fillStyle = '#f2c12e'; g.fillRect(0, 0, PX, PX);
    g.fillStyle = '#151515';
    for (let k = -4; k < 8; k++) { g.beginPath(); g.moveTo(k * 32, 0); g.lineTo(k * 32 + 16, 0); g.lineTo(k * 32 + 16 + PX, PX); g.lineTo(k * 32 + PX, PX); g.fill(); }
  });
  at(CELL.grate, () => {
    g.fillStyle = '#2a2a2a';
    for (let k = 0; k < 8; k++) g.fillRect(4 + k * 16, 0, 7, PX);
    g.fillRect(0, 0, PX, 8); g.fillRect(0, PX - 8, PX, 8); g.fillRect(0, 60, PX, 8);
  });
  at(CELL.volt, () => {
    g.fillStyle = '#f2c12e'; g.strokeStyle = '#151515'; g.lineWidth = 8; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(64, 14); g.lineTo(118, 110); g.lineTo(10, 110); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#151515'; g.beginPath(); g.moveTo(70, 40); g.lineTo(50, 76); g.lineTo(64, 76); g.lineTo(56, 100); g.lineTo(80, 64); g.lineTo(66, 64); g.lineTo(74, 40); g.fill();
  });
  at(CELL.poster, () => {
    g.fillStyle = '#efe8d6'; g.fillRect(16, 6, 96, 116);
    g.fillStyle = '#b03a2e'; g.fillRect(24, 14, 80, 18);
    g.strokeStyle = '#8a8070'; g.lineWidth = 2;
    for (let r = 0; r < 5; r++) for (let c = 0; c < 7; c++) g.strokeRect(24 + c * 11.4, 40 + r * 15, 11.4, 15);
  });
  at(CELL.stain, () => {
    for (let k = 0; k < 40; k++) {
      g.fillStyle = `rgba(30,24,18,${rng.range(0.05, 0.2)})`;
      g.beginPath(); g.arc(rng.range(16, 112), rng.range(16, 112), rng.range(6, 24), 0, Math.PI * 2); g.fill();
    }
  });
  at(CELL.streak, () => {
    for (let k = 0; k < 14; k++) {
      const x = rng.range(8, 120), w = rng.range(2, 8), len = rng.range(40, 128);
      const gr = g.createLinearGradient(0, 0, 0, len);
      gr.addColorStop(0, 'rgba(40,32,22,0.55)'); gr.addColorStop(1, 'rgba(40,32,22,0)');
      g.fillStyle = gr; g.fillRect(x, 0, w, len);
    }
  });
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ------------------------------------------------------------ frames and shapes

/** A room frame: origin, u axis (nx, nz), v axis (-nz, nx). */
export interface Frame { ox: number; oz: number; nx: number; nz: number }

export function fw(f: Frame, u: number, v: number): [number, number] {
  return [f.ox + f.nx * u - f.nz * v, f.oz + f.nz * u + f.nx * v];
}

/** Box in a frame: centre (u, v, y), half extents along u, up, v; extra yaw (radians) in the frame. */
export function fbox(mb: MeshBuilder, f: Frame, u: number, v: number, y: number, hu: number, hy: number, hv: number, yaw = 0): void {
  const [x, z] = fw(f, u, v);
  mb.box(x, y, z, hv, hy, hu, Math.atan2(f.nx, f.nz) + yaw);
}

/** Cylinder between two points (radius r, n sides, capped). uv: u around (m), v along (m). */
export function cyl(mb: MeshBuilder, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, n = 8, caps = true): void {
  const dx = bx - ax, dy = by - ay, dz = bz - az, L = Math.hypot(dx, dy, dz);
  if (L < 1e-5) return;
  const ex = dx / L, ey = dy / L, ez = dz / L;
  // A basis around the axis.
  let px = -ez, py = 0, pz = ex;
  if (Math.abs(ey) > 0.9) { px = 1; py = 0; pz = 0; }
  const pl = Math.hypot(px, py, pz); px /= pl; py /= pl; pz /= pl;
  const qx = ey * pz - ez * py, qy = ez * px - ex * pz, qz = ex * py - ey * px;
  const base = mb.vcount;
  for (let k = 0; k <= n; k++) {
    const a = (k / n) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    const nx = px * c + qx * s, ny = py * c + qy * s, nz = pz * c + qz * s;
    mb.v(ax + nx * r, ay + ny * r, az + nz * r, nx, ny, nz, (a * r), 0);
    mb.v(bx + nx * r, by + ny * r, bz + nz * r, nx, ny, nz, (a * r), L);
  }
  for (let k = 0; k < n; k++) mb.quad(base + k * 2, base + k * 2 + 2, base + k * 2 + 3, base + k * 2 + 1);
  if (!caps) return;
  for (const [cx, cy, cz, sg] of [[ax, ay, az, -1], [bx, by, bz, 1]] as const) {
    const c0 = mb.v(cx, cy, cz, ex * sg, ey * sg, ez * sg, 0.5, 0.5);
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      mb.v(cx + (px * c + qx * s) * r, cy + (py * c + qy * s) * r, cz + (pz * c + qz * s) * r, ex * sg, ey * sg, ez * sg, 0.5 + c * 0.5, 0.5 + s * 0.5);
    }
    for (let k = 0; k < n; k++) { if (sg > 0) mb.tri(c0, c0 + 1 + k, c0 + 2 + k); else mb.tri(c0, c0 + 2 + k, c0 + 1 + k); }
  }
}

/** Half-ellipsoid dome on the ground (radius r, height h). */
export function dome(mb: MeshBuilder, x: number, y: number, z: number, r: number, h: number, n = 10, rings = 4): void {
  const base = mb.vcount;
  for (let j = 0; j <= rings; j++) {
    const t = (j / rings) * Math.PI / 2, cr = Math.cos(t) * r, yy = Math.sin(t) * h;
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      const nx = c * Math.cos(t) / r, ny = Math.sin(t) / h, nz = s * Math.cos(t) / r, nl = Math.hypot(nx, ny, nz) || 1;
      mb.v(x + c * cr, y + yy, z + s * cr, nx / nl, ny / nl, nz / nl, a * r, t * h);
    }
  }
  for (let j = 0; j < rings; j++) for (let k = 0; k < n; k++) {
    const a = base + j * (n + 1) + k, b = a + n + 1;
    mb.quad(a, b, b + 1, a + 1);
  }
}

/** Decal quad: centre, right (rx, ry, rz) and up (ux, uy, uz) unit vectors, half sizes, atlas cell. */
export function decal(mb: MeshBuilder, x: number, y: number, z: number, rx: number, ry: number, rz: number, ux: number, uy: number, uz: number, hw: number, hh: number, cell: number, flip = false): void {
  const [u0, v0, u1, v1] = cellUV(cell);
  const nx = ry * uz - rz * uy, ny = rz * ux - rx * uz, nz = rx * uy - ry * ux;
  const a = flip ? u1 : u0, b = flip ? u0 : u1;
  const i = mb.v(x - rx * hw - ux * hh, y - ry * hw - uy * hh, z - rz * hw - uz * hh, nx, ny, nz, a, v0);
  mb.v(x + rx * hw - ux * hh, y + ry * hw - uy * hh, z + rz * hw - uz * hh, nx, ny, nz, b, v0);
  mb.v(x + rx * hw + ux * hh, y + ry * hw + uy * hh, z + rz * hw + uz * hh, nx, ny, nz, b, v1);
  mb.v(x - rx * hw + ux * hh, y - ry * hw + uy * hh, z - rz * hw + uz * hh, nx, ny, nz, a, v1);
  mb.quad(i, i + 1, i + 2, i + 3);
}

/** Wall decal in a frame: on the wall plane at (u, v) facing (fu, fv) (unit, in the frame), centre height y. */
export function wallDecal(mb: MeshBuilder, f: Frame, u: number, v: number, fu: number, fv: number, y: number, hw: number, hh: number, cell: number): void {
  const [x, z] = fw(f, u + fu * 0.012, v + fv * 0.012);
  // Facing direction in world; right = up × facing.
  const fx = f.nx * fu - f.nz * fv, fz = f.nz * fu + f.nx * fv;
  decal(mb, x, y, z, fz, 0, -fx, 0, 1, 0, hw, hh, cell);
}

/** Floor decal in a frame (rotation a). */
export function floorDecal(mb: MeshBuilder, f: Frame, u: number, v: number, y: number, hw: number, hh: number, a: number, cell: number): void {
  const [x, z] = fw(f, u, v);
  const c = Math.cos(a), s = Math.sin(a);
  const rx = f.nx * c - f.nz * s, rz = f.nz * c + f.nx * s;
  decal(mb, x, y + 0.012, z, rx, 0, rz, rz, 0, -rx, hw, hh, cell);
}

/** Quad with a uv-cell from the atlas filling it (glow builders): corners A..D counter-clockwise. */
export function cellQuad(mb: MeshBuilder, A: number[], B: number[], C: number[], D: number[], cell: number): void {
  const [u0, v0, u1, v1] = cellUV(cell);
  const ax = B[0] - A[0], ay = B[1] - A[1], az = B[2] - A[2], bx = D[0] - A[0], by = D[1] - A[1], bz = D[2] - A[2];
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
  const i = mb.v(A[0], A[1], A[2], nx, ny, nz, u0, v0);
  mb.v(B[0], B[1], B[2], nx, ny, nz, u1, v0);
  mb.v(C[0], C[1], C[2], nx, ny, nz, u1, v1);
  mb.v(D[0], D[1], D[2], nx, ny, nz, u0, v1);
  mb.quad(i, i + 1, i + 2, i + 3);
  mb.quad(i, i + 3, i + 2, i + 1);
}

/**
 * Vertical wall in a frame from (u0, v0) to (u1, v1), floor y0 to y1, double-sided, with
 * rectangular openings [a0, a1, h0, h1] (a: distance along the wall from its start, h: absolute y).
 * uv in metres (along, up).
 */
export function wall(mb: MeshBuilder, f: Frame, u0: number, v0: number, u1: number, v1: number, y0: number, y1: number, holes: [number, number, number, number][] = []): void {
  const L = Math.hypot(u1 - u0, v1 - v0);
  if (L < 1e-4 || y1 <= y0) return;
  const at = (a: number) => fw(f, u0 + ((u1 - u0) * a) / L, v0 + ((v1 - v0) * a) / L);
  const du = (u1 - u0) / L, dv = (v1 - v0) / L;
  // Normal: left of the direction (either side is drawn).
  const nu = -dv, nvv = du;
  const nx = f.nx * nu - f.nz * nvv, nz = f.nz * nu + f.nx * nvv;
  const cuts = [0, L];
  for (const h of holes) cuts.push(Math.max(0, Math.min(L, h[0])), Math.max(0, Math.min(L, h[1])));
  cuts.sort((a, b) => a - b);
  for (let k = 0; k + 1 < cuts.length; k++) {
    const a0 = cuts[k], a1 = cuts[k + 1];
    if (a1 - a0 < 1e-4) continue;
    const mid = (a0 + a1) / 2;
    // Vertical spans of this column not covered by an opening.
    let spans: [number, number][] = [[y0, y1]];
    for (const h of holes) {
      if (mid < h[0] || mid > h[1]) continue;
      const out: [number, number][] = [];
      for (const [s0, s1] of spans) {
        if (h[3] <= s0 || h[2] >= s1) { out.push([s0, s1]); continue; }
        if (h[2] > s0) out.push([s0, h[2]]);
        if (h[3] < s1) out.push([h[3], s1]);
      }
      spans = out;
    }
    const [xa, za] = at(a0), [xb, zb] = at(a1);
    for (const [s0, s1] of spans) {
      if (s1 - s0 < 1e-4) continue;
      const i = mb.v(xa, s0, za, nx, 0, nz, a0, s0 - y0);
      mb.v(xb, s0, zb, nx, 0, nz, a1, s0 - y0);
      mb.v(xb, s1, zb, nx, 0, nz, a1, s1 - y0);
      mb.v(xa, s1, za, nx, 0, nz, a0, s1 - y0);
      mb.quad(i, i + 1, i + 2, i + 3);
      mb.quad(i, i + 3, i + 2, i + 1);
    }
  }
}

/** Horizontal rectangle in a frame at height y (floor: normal up, ceiling: down), double-sided. */
export function flat(mb: MeshBuilder, f: Frame, u0: number, u1: number, v0: number, v1: number, y: number, up = true): void {
  if (u1 - u0 < 1e-4 || v1 - v0 < 1e-4) return;
  const ny = up ? 1 : -1;
  const p = [fw(f, u0, v0), fw(f, u1, v0), fw(f, u1, v1), fw(f, u0, v1)];
  const i = mb.v(p[0][0], y, p[0][1], 0, ny, 0, u0, v0);
  mb.v(p[1][0], y, p[1][1], 0, ny, 0, u1, v0);
  mb.v(p[2][0], y, p[2][1], 0, ny, 0, u1, v1);
  mb.v(p[3][0], y, p[3][1], 0, ny, 0, u0, v1);
  mb.quad(i, i + 1, i + 2, i + 3);
  mb.quad(i, i + 3, i + 2, i + 1);
}
