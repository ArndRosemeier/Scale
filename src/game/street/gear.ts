/**
 * Things the street characters put down (game/street): an open guitar case and an upturned hat
 * collecting coins, a boombox, juggling balls. A few primitives each with shared geometry and
 * materials (never disposed: the same handful serve every character); no lights.
 */
import * as THREE from 'three';

const geo = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 16),
  coin: new THREE.CylinderGeometry(0.012, 0.012, 0.003, 10),
  ball: new THREE.SphereGeometry(0.045, 12, 9),
};
const mats = new Map<string, THREE.MeshStandardMaterial>();
function mat(color: number, rough = 0.8, metal = 0): THREE.MeshStandardMaterial {
  const k = `${color}:${rough}:${metal}`;
  let m = mats.get(k);
  if (!m) mats.set(k, (m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal })));
  return m;
}
function part(g: THREE.BufferGeometry, m: THREE.Material, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0): THREE.Mesh {
  const o = new THREE.Mesh(g, m);
  o.scale.set(sx, sy, sz);
  o.position.set(x, y, z);
  o.castShadow = true;
  o.receiveShadow = true;
  return o;
}

export interface Gear {
  object: THREE.Group;
  /** Coins shown (hat / case). */
  setCoins(n: number): void;
}

/** Up to this many coins show in a hat or case. */
const COINS = 14;

function coins(g: THREE.Group, w: number, d: number, y: number): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  const gold = mat(0xc9a43a, 0.35, 0.8), silver = mat(0xb9bcc2, 0.35, 0.8);
  for (let k = 0; k < COINS; k++) {
    const c = new THREE.Mesh(geo.coin, k % 3 ? silver : gold);
    const a = k * 2.399, r = Math.sqrt((k + 0.5) / COINS);
    c.position.set(Math.cos(a) * r * w * 0.45, y + (k % 4) * 0.002, Math.sin(a) * r * d * 0.45);
    c.rotation.set((k % 5) * 0.1, k, 0);
    c.visible = false;
    g.add(c);
    out.push(c);
  }
  return out;
}

const show = (cs: THREE.Mesh[]) => (n: number) => { for (let k = 0; k < cs.length; k++) cs[k].visible = k < n; };

/** An open guitar case on the ground (lid up behind), red plush inside. Forward is −z (towards the street). */
export function guitarCase(): Gear {
  const g = new THREE.Group();
  const shell = mat(0x1b1b1d, 0.55), plush = mat(0x7a1520, 0.95);
  g.add(part(geo.box, shell, 1.0, 0.09, 0.38, 0, 0.045, 0));
  g.add(part(geo.box, plush, 0.94, 0.02, 0.32, 0, 0.085, 0));
  const lid = part(geo.box, shell, 1.0, 0.03, 0.38, 0, 0.2, 0.2);
  lid.rotation.x = -1.35;
  g.add(lid);
  const cs = coins(g, 0.9, 0.3, 0.1);
  return { object: g, setCoins: show(cs) };
}

/** An upturned hat with a few coins in it. */
export function hat(color = 0x222226): Gear {
  const g = new THREE.Group();
  const felt = mat(color, 0.95);
  g.add(part(geo.cyl, felt, 0.16, 0.012, 0.16, 0, 0.006, 0));
  g.add(part(geo.cyl, felt, 0.1, 0.1, 0.1, 0, 0.06, 0));
  g.add(part(geo.cyl, mat(0x0d0d0f, 1), 0.092, 0.002, 0.092, 0, 0.111, 0));
  const cs = coins(g, 0.16, 0.16, 0.114);
  return { object: g, setCoins: show(cs) };
}

/** A boombox with two speakers and a handle. */
export function boombox(): Gear {
  const g = new THREE.Group();
  const body = mat(0x2a2b2f, 0.5, 0.2), grille = mat(0x0b0b0c, 0.9), chrome = mat(0xc8ccd2, 0.25, 0.9);
  g.add(part(geo.box, body, 0.56, 0.28, 0.16, 0, 0.14, 0));
  for (const x of [-0.17, 0.17]) {
    const s = part(geo.cyl, grille, 0.085, 0.01, 0.085, x, 0.14, -0.081);
    s.rotation.x = Math.PI / 2;
    g.add(s);
  }
  g.add(part(geo.box, chrome, 0.12, 0.05, 0.005, 0, 0.2, -0.081));
  g.add(part(geo.box, chrome, 0.4, 0.02, 0.02, 0, 0.34, 0));
  return { object: g, setCoins: () => {} };
}

/** A cajón: a wooden box drum to sit on, its sound hole at the back. Origin on the ground. */
export function cajon(): THREE.Group {
  const g = new THREE.Group();
  const wood = mat(0xb07a45, 0.6), face = mat(0x3a2414, 0.5), dark = mat(0x0b0b0c, 0.95);
  g.add(part(geo.box, wood, 0.3, 0.47, 0.3, 0, 0.235, 0));
  g.add(part(geo.box, face, 0.29, 0.45, 0.01, 0, 0.235, -0.151));
  const hole = part(geo.cyl, dark, 0.055, 0.01, 0.055, 0, 0.26, 0.151);
  hole.rotation.x = Math.PI / 2;
  g.add(hole);
  return g;
}

/** A street band's things: the open guitar case in front of the leader, the cajón behind to the left (local: forward −z). */
export function bandGear(): Gear {
  const g = new THREE.Group();
  const gc = guitarCase();
  gc.object.position.set(0, 0, -1.3);
  const box = cajon();
  box.position.set(-1.45, 0, 0.65);
  g.add(gc.object, box);
  return { object: g, setCoins: gc.setCoins };
}

const BALL_COLORS = [0xd8342c, 0xf2c230, 0x2f7fd6, 0x3fb04a, 0xee7a1f];

/** n juggling balls (separate meshes, placed by the juggler every frame). */
export function balls(n: number, seed: number): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  for (let k = 0; k < n; k++) {
    const b = new THREE.Mesh(geo.ball, mat(BALL_COLORS[(seed + k) % BALL_COLORS.length], 0.6));
    b.castShadow = true;
    out.push(b);
  }
  return out;
}
