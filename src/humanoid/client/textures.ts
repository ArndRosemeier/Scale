/**
 * Shared procedural textures for humanoids, generated once on the main
 * thread: skin pore/micro-wrinkle height, hair strand cards, eyelashes and
 * sylvan leaf cards. Deterministic (fixed seeds) so every client looks the
 * same.
 */
import * as THREE from 'three';
import { Rng } from '../../core/rng';

let pores: THREE.DataTexture | null = null;

/** Tiling skin micro-height (R) + fine cross-hatch wrinkles (G), 512². */
export function poreTexture(): THREE.DataTexture {
  if (pores) return pores;
  const S = 512;
  const h = new Float32Array(S * S);
  const rng = new Rng(0x5ca1ab1e);
  // Pores: small Gaussian dimples on a jittered grid (tiling).
  const cell = 9;
  for (let gy = 0; gy < S / cell * 1.0; gy++) for (let gx = 0; gx < S / cell; gx++) {
    const cx = (gx + rng.float()) * cell, cy = (gy + rng.float()) * cell;
    const r = rng.range(0.9, 2.1), depth = rng.range(0.4, 1);
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = (Math.floor(cx) + dx + S) % S, y = (Math.floor(cy) + dy + S) % S;
      const d2 = ((Math.floor(cx) + dx - cx) ** 2 + (Math.floor(cy) + dy - cy) ** 2) / (r * r);
      h[y * S + x] -= depth * Math.exp(-d2 * 1.6);
    }
  }
  // Micro wrinkles: two families of long thin grooves crossing at ~60°.
  const w = new Float32Array(S * S);
  for (let k = 0; k < 900; k++) {
    const ang = (rng.chance(0.5) ? 0.5 : -0.55) + rng.gaussian(0, 0.25);
    const len = rng.range(10, 40);
    let x = rng.range(0, S), y = rng.range(0, S);
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const d = rng.range(0.3, 0.8);
    for (let t = 0; t < len; t++) {
      const ix = ((Math.round(x) % S) + S) % S, iy = ((Math.round(y) % S) + S) % S;
      w[iy * S + ix] -= d;
      w[iy * S + ((ix + 1) % S)] -= d * 0.4;
      x += dx; y += dy;
    }
  }
  const data = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    data[i * 4] = Math.max(0, Math.min(255, 200 + h[i] * 120));
    data[i * 4 + 1] = Math.max(0, Math.min(255, 220 + w[i] * 90));
    data[i * 4 + 2] = Math.floor(rng.float() * 255); // white noise (flake/variation)
    data[i * 4 + 3] = 255;
  }
  // Light blur on wrinkles so derivatives are smooth.
  pores = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  pores.wrapS = pores.wrapT = THREE.RepeatWrapping;
  pores.magFilter = THREE.LinearFilter;
  pores.minFilter = THREE.LinearMipmapLinearFilter;
  pores.generateMipmaps = true;
  pores.anisotropy = 4;
  pores.needsUpdate = true;
  return pores;
}

let strands: THREE.DataTexture | null = null;

/**
 * Hair card texture: many thin strands with tapered tips. G = alpha
 * coverage (three.js alphaMap reads green, which also makes shadows
 * alpha-tested), R = per-strand brightness, B = per-strand highlight shift.
 * Cards map u across, v root (0) → tip (1).
 */
export function strandTexture(): THREE.DataTexture {
  if (strands) return strands;
  const W = 256, H = 512;
  const a = new Float32Array(W * H), g = new Float32Array(W * H).fill(0.5), b = new Float32Array(W * H);
  const rng = new Rng(0x4a1e);
  for (let s = 0; s < 260; s++) {
    const x0 = rng.range(0, W);
    const len = rng.range(0.6, 1.0) * H;
    const width = rng.range(0.6, 1.5);
    const bright = rng.range(0.25, 1);
    const wav = rng.range(0, 2.5), ph = rng.range(0, 6.28);
    const shift = rng.float();
    for (let y = 0; y < len; y++) {
      const t = y / len;
      const x = x0 + Math.sin(ph + t * 6) * wav;
      const wd = width * (1 - Math.pow(t, 3) * 0.8);
      for (let dx = -2; dx <= 2; dx++) {
        const xi = Math.floor(x) + dx;
        const xx = ((xi % W) + W) % W;
        const d = Math.abs(xi + 0.5 - x) / wd;
        const cov = Math.max(0, 1 - d) * (1 - Math.pow(t, 6));
        const i = y * W + xx;
        if (cov > a[i]) { g[i] = bright; b[i] = shift; }
        a[i] = Math.min(1, a[i] + cov * 0.9);
      }
    }
  }
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = Math.round(g[i] * 255);
    data[i * 4 + 1] = Math.round(a[i] * 255);
    data[i * 4 + 2] = Math.round(b[i] * 255);
    data[i * 4 + 3] = 255;
  }
  strands = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  strands.wrapS = THREE.RepeatWrapping;
  strands.wrapT = THREE.ClampToEdgeWrapping;
  strands.magFilter = THREE.LinearFilter;
  strands.minFilter = THREE.LinearMipmapLinearFilter;
  strands.generateMipmaps = true;
  strands.anisotropy = 8;
  strands.needsUpdate = true;
  return strands;
}

let leaves: THREE.DataTexture | null = null;

/** Leaf cluster card for sylvan hair: G = alpha, R = vein shading, B = per-leaf hue jitter. */
export function leafTexture(): THREE.DataTexture {
  if (leaves) return leaves;
  const W = 256, H = 512;
  const data = new Uint8Array(W * H * 4);
  const rng = new Rng(0x1eaf);
  for (let k = 0; k < 34; k++) {
    const cx = rng.range(0.2, 0.8) * W, cy = rng.range(0.08, 0.95) * H;
    const len = rng.range(40, 80), wid = rng.range(14, 26);
    const ang = rng.range(-0.9, 0.9) + Math.PI / 2;
    const hue = rng.float();
    const ca = Math.cos(ang), sa = Math.sin(ang);
    for (let y = Math.max(0, Math.floor(cy - len)); y < Math.min(H, cy + len); y++) for (let x = Math.max(0, Math.floor(cx - len)); x < Math.min(W, cx + len); x++) {
      const dx = x - cx, dy = y - cy;
      const u = (dx * ca + dy * sa) / len; // along leaf -1..1
      const v = (-dx * sa + dy * ca) / wid;
      const shape = Math.sqrt(Math.max(0, 1 - u * u)) * (1 - 0.25 * u);
      if (Math.abs(v) > shape || Math.abs(u) > 1) continue;
      const i = (y * W + x) * 4;
      const vein = Math.min(1, Math.abs(v) * 8) * (0.85 + 0.15 * Math.cos(u * 18 + Math.abs(v) * 10));
      data[i + 1] = 255;
      data[i] = Math.round(120 + 135 * vein * (0.6 + 0.4 * Math.abs(v) / Math.max(0.05, shape)));
      data[i + 2] = Math.round(hue * 255);
      data[i + 3] = 255;
    }
  }
  leaves = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  leaves.wrapS = THREE.RepeatWrapping;
  leaves.magFilter = THREE.LinearFilter;
  leaves.minFilter = THREE.LinearMipmapLinearFilter;
  leaves.generateMipmaps = true;
  leaves.needsUpdate = true;
  return leaves;
}
