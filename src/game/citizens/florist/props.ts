/**
 * The florist's things (game/citizens/florist): her flower stand on the pavement (zinc buckets of
 * flowers, a terracotta pot she sits on, a sandwich board asking people to mind their step), her
 * own little door in the shop wall with its sign, and the planter boxes of her roof gardens.
 * Shared primitives and plain standard materials (as game/street/gear.ts): no new shaders, no lights.
 *
 * Local frame of every piece: +x along the facade, +z out of it (towards the street), y up.
 */
import * as THREE from 'three';
import { textTexture } from '../../../humanoid/client/streetwear';

const geo = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 14),
  pot: new THREE.CylinderGeometry(1, 0.75, 1, 14),
  bloom: new THREE.IcosahedronGeometry(1, 0),
  plane: new THREE.PlaneGeometry(1, 1),
};
const mats = new Map<string, THREE.MeshStandardMaterial>();
function mat(color: number, rough = 0.8, metal = 0): THREE.MeshStandardMaterial {
  const k = `${color}:${rough}:${metal}`;
  let m = mats.get(k);
  if (!m) mats.set(k, (m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal })));
  return m;
}
function part(g: THREE.BufferGeometry, m: THREE.Material, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0, shadow = true): THREE.Mesh {
  const o = new THREE.Mesh(g, m);
  o.scale.set(sx, sy, sz);
  o.position.set(x, y, z);
  o.castShadow = shadow;
  o.receiveShadow = true;
  return o;
}

const BLOOMS = [0xd8283c, 0xf3c22f, 0xf08cb4, 0x9a49c2, 0xfaf6ee, 0xf2742a, 0x4a6fd8];
const LEAF = 0x3f7a2e, STEM = 0x2e5e22;

/** A cluster of n flowers on stems, their heads around height h within radius r. */
function flowers(g: THREE.Group, n: number, r: number, h: number, seed: number, x = 0, z = 0): void {
  const leaf = mat(LEAF, 0.85), stem = mat(STEM, 0.9);
  for (let k = 0; k < n; k++) {
    const a = k * 2.399 + seed, rr = r * Math.sqrt((k + 0.5) / n);
    const fx = x + Math.cos(a) * rr, fz = z + Math.sin(a) * rr, fh = h * (0.8 + ((k * 37 + seed * 11) % 10) * 0.04);
    g.add(part(geo.cyl, stem, 0.006, fh, 0.006, fx, fh / 2, fz, false));
    const s = 0.03 + ((k + seed) % 3) * 0.008;
    const b = part(geo.bloom, mat(BLOOMS[(k + seed * 3) % BLOOMS.length], 0.8), s, s * 0.8, s, fx, fh, fz, false);
    b.rotation.set(k, k * 0.7, 0);
    g.add(b);
    if (k % 2 === 0) { const l = part(geo.box, leaf, 0.012, 0.09, 0.04, fx, fh * 0.55, fz, false); l.rotation.set(0.5, a, 0.4); g.add(l); }
  }
}

/** A sign board with painted letters (both faces). */
function board(text: string, w: number, h: number, bg = '#f3ead2', fg = '#2f5d2a'): THREE.Mesh {
  const face = new THREE.MeshStandardMaterial({ map: textTexture(text, bg, fg, 384, Math.round((384 * h) / w)), roughness: 0.85, side: THREE.DoubleSide });
  const m = new THREE.Mesh(geo.plane, face);
  m.scale.set(w, h, 1);
  return m;
}

export interface Stand {
  object: THREE.Group;
  /** Her seat: the rim of the terracotta pot (local position, height). */
  seat: { x: number; z: number; y: number };
  /** Where her pigeon waits (local). */
  perch: { x: number; z: number };
  /** Spots she tends (local, in front of each bucket). */
  tend: { x: number; z: number }[];
  /** Footprints for collision (local centre, radius). */
  solid: { x: number; z: number; r: number; h: number }[];
}

/**
 * The flower stand (origin on the pavement at the stand point). `flip` −1: laid out towards −x
 * (the shop door is on the other side; the group's rotation keeps +z out of the wall).
 */
export function flowerStand(shop: string, seed: number, flip = 1): Stand {
  const g = new THREE.Group();
  const zinc = mat(0x9aa0a6, 0.45, 0.6), clay = mat(0xb5603a, 0.9), wood = mat(0x7a5232, 0.8);
  const tend: Stand['tend'] = [], solid: Stand['solid'] = [];
  // Four buckets along the wall, the tall ones at the back.
  const at = [-0.3, 0.05, 0.4, 0.75];
  at.forEach((x, k) => {
    const h = k % 2 ? 0.22 : 0.28, r = 0.12;
    g.add(part(geo.pot, zinc, r, h, r, x, h / 2, 0));
    flowers(g, 9, r * 0.9, h + 0.18 + (k % 2) * 0.05, seed + k * 5, x, 0);
    tend.push({ x, z: 0.2 });
    solid.push({ x, z: 0, r: r + 0.02, h: h + 0.25 });
  });
  // A crate of bunches for sale beside them.
  g.add(part(geo.box, wood, 0.42, 0.14, 0.26, 1.55, 0.07, 0.2));
  flowers(g, 6, 0.12, 0.2, seed + 40, 1.45, 0.2);
  flowers(g, 5, 0.1, 0.18, seed + 47, 1.68, 0.2);
  solid.push({ x: 1.55, z: 0.2, r: 0.2, h: 0.3 });
  // Her terracotta pot to sit on (rim at 0.13 m), a few seedlings in it.
  const seat = { x: 1.1, z: 0.12, y: 0.13 };
  g.add(part(geo.pot, clay, 0.09, 0.13, 0.09, seat.x, 0.065, seat.z));
  g.add(part(geo.cyl, mat(0x3b2a1c, 1), 0.082, 0.005, 0.082, seat.x, 0.126, seat.z, false));
  flowers(g, 3, 0.04, 0.06, seed + 60, seat.x + 0.03, seat.z - 0.03);
  solid.push({ x: seat.x, z: seat.z, r: 0.1, h: 0.14 });
  // The sandwich board.
  const sb = new THREE.Group();
  const text = board('MIND YOUR STEP!|TINY FLORIST|AT WORK', 0.42, 0.5);
  text.position.set(0, 0.36, 0.06);
  text.rotation.x = -0.22;
  const back = board(`${shop.toUpperCase()}|FLOWERS FOR|EVERY SIZE`, 0.42, 0.5);
  back.position.set(0, 0.36, -0.06);
  back.rotation.set(0.22, Math.PI, 0);
  sb.add(text, back);
  for (const s of [-1, 1]) { const leg = part(geo.box, wood, 0.03, 0.66, 0.02, s * 0.2, 0.32, 0.065); leg.rotation.x = -0.22; sb.add(leg); const l2 = part(geo.box, wood, 0.03, 0.66, 0.02, s * 0.2, 0.32, -0.065); l2.rotation.x = 0.22; sb.add(l2); }
  sb.position.set(2.05, 0, 0.45);
  sb.rotation.y = 0.35;
  g.add(sb);
  solid.push({ x: 2.05, z: 0.45, r: 0.25, h: 0.7 });
  const perch = { x: 0.75, z: 0.62 };
  if (flip < 0) {
    for (const c of g.children) { c.position.x = -c.position.x; c.rotation.y = -c.rotation.y; }
    for (const p of [seat, perch, ...tend, ...solid]) p.x = -p.x;
  }
  return { object: g, seat, perch, tend, solid };
}

/** Her own little door in the shop wall (origin at the foot of the wall, the door's face at z 0). */
export function littleDoor(shop: string): THREE.Group {
  const g = new THREE.Group();
  const frame = mat(0x2f5d2a, 0.6), door = mat(0xb8322a, 0.55), brass = mat(0xd8b048, 0.3, 0.9), step = mat(0x8c8c88, 0.9);
  g.add(part(geo.box, frame, 0.15, 0.24, 0.03, 0, 0.12, 0.012));
  g.add(part(geo.box, door, 0.11, 0.2, 0.03, 0, 0.105, 0.02));
  g.add(part(geo.box, brass, 0.012, 0.012, 0.01, 0.035, 0.1, 0.04, false));
  g.add(part(geo.box, step, 0.2, 0.02, 0.07, 0, 0.01, 0.04));
  const sign = board(shop.toUpperCase(), 0.34, 0.08, '#2f5d2a', '#f3ead2');
  sign.position.set(0, 0.31, 0.03);
  g.add(sign);
  // A window box under the sign.
  g.add(part(geo.box, mat(0x7a5232, 0.8), 0.24, 0.035, 0.05, 0, 0.255, 0.04));
  flowers(g, 6, 0.04, 0.035, 3, -0.06, 0.04);
  flowers(g, 6, 0.04, 0.035, 9, 0.06, 0.04);
  return g;
}

/** A roof garden: three planter boxes in a row along local x, a watering can, a bench of a brick. */
export function roofGarden(seed: number): { object: THREE.Group; tend: { x: number; z: number }[]; solid: { x: number; z: number; hx: number; hz: number; h: number }[] } {
  const g = new THREE.Group();
  const wood = mat(0x8a5e38, 0.85), soil = mat(0x3b2a1c, 1), leaf = mat(LEAF, 0.85);
  const tend: { x: number; z: number }[] = [], solid: { x: number; z: number; hx: number; hz: number; h: number }[] = [];
  for (let k = 0; k < 3; k++) {
    const x = (k - 1) * 1.5;
    g.add(part(geo.box, wood, 1.2, 0.35, 0.45, x, 0.175, 0));
    g.add(part(geo.box, soil, 1.12, 0.02, 0.38, x, 0.345, 0, false));
    if ((seed + k) % 3 === 0) {
      // Greens: low bushes.
      for (let j = 0; j < 4; j++) { const b = part(geo.bloom, leaf, 0.13, 0.1, 0.13, x - 0.42 + j * 0.28, 0.42, 0, false); b.rotation.y = j; g.add(b); }
    } else {
      const fl = new THREE.Group();
      flowers(fl, 8, 0.16, 0.22, seed + k * 13, -0.3, 0);
      flowers(fl, 8, 0.16, 0.22, seed + k * 17, 0.3, 0);
      fl.position.set(x, 0.35, 0);
      g.add(fl);
    }
    tend.push({ x, z: 0.42 });
    solid.push({ x, z: 0, hx: 0.6, hz: 0.23, h: 0.36 });
  }
  return { object: g, tend, solid };
}
