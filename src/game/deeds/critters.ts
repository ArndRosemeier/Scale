/**
 * Small procedural models for the crime and deed layer: a cat, a dog (with a dangling leash),
 * a wallet, a handbag and a cash bag, plus a soft glint sprite for things lying on the ground.
 * A few primitives each, shared geometry and materials per colour; animated by moving parts.
 */
import * as THREE from 'three';

const geo = {
  sphere: new THREE.SphereGeometry(1, 12, 9),
  cone: new THREE.ConeGeometry(1, 1, 6),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 7),
  box: new THREE.BoxGeometry(1, 1, 1),
};
const mats = new Map<string, THREE.MeshStandardMaterial>();
function mat(color: number, rough = 0.85): THREE.MeshStandardMaterial {
  const k = `${color}:${rough}`;
  let m = mats.get(k);
  if (!m) mats.set(k, (m = new THREE.MeshStandardMaterial({ color, roughness: rough })));
  return m;
}
function part(g: THREE.BufferGeometry, m: THREE.Material, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0): THREE.Mesh {
  const o = new THREE.Mesh(g, m);
  o.scale.set(sx, sy, sz);
  o.position.set(x, y, z);
  o.castShadow = true;
  return o;
}

const CAT_COLORS = [0xd9822b, 0x222222, 0x8a8a8a, 0xf2efe6, 0x6b4a2f];
const DOG_COLORS = [0x8a5a2b, 0x2a2420, 0xd9c7a0, 0xa0703d, 0xeeeeee];

export interface Critter {
  object: THREE.Group;
  /** Animation: legs, tail, head (dog / cat). */
  legs: THREE.Object3D[];
  tail: THREE.Object3D | null;
  head: THREE.Object3D | null;
  update(dt: number, speed: number, t: number): void;
}

/** A cat, about 45 cm long, sitting (pose 0) or crouched on a branch. Forward is −z. */
export function makeCat(seed: number): Critter {
  const g = new THREE.Group();
  const fur = mat(CAT_COLORS[seed % CAT_COLORS.length], 0.95);
  const body = part(geo.sphere, fur, 0.1, 0.11, 0.19, 0, 0.13, 0.02);
  const head = new THREE.Group();
  head.position.set(0, 0.25, -0.13);
  head.add(part(geo.sphere, fur, 0.075, 0.07, 0.07));
  const earL = part(geo.cone, fur, 0.028, 0.055, 0.02, -0.045, 0.065, 0); earL.rotation.z = 0.25;
  const earR = part(geo.cone, fur, 0.028, 0.055, 0.02, 0.045, 0.065, 0); earR.rotation.z = -0.25;
  const eyeM = mat(0x9be06a, 0.3);
  head.add(earL, earR, part(geo.sphere, eyeM, 0.012, 0.014, 0.008, -0.025, 0.01, -0.065), part(geo.sphere, eyeM, 0.012, 0.014, 0.008, 0.025, 0.01, -0.065));
  const legs: THREE.Object3D[] = [];
  for (const [x, z] of [[-0.05, -0.09], [0.05, -0.09], [-0.05, 0.11], [0.05, 0.11]]) {
    const l = part(geo.cyl, fur, 0.022, 0.12, 0.022, x, 0.06, z);
    legs.push(l);
    g.add(l);
  }
  const tail = new THREE.Group();
  tail.position.set(0, 0.16, 0.2);
  const tl = part(geo.cyl, fur, 0.018, 0.24, 0.018, 0, 0.11, 0.02);
  tl.rotation.x = 0.5;
  tail.add(tl);
  g.add(body, head, tail);
  return {
    object: g, legs, tail, head,
    update(_dt, speed, t) {
      tail.rotation.z = Math.sin(t * 2.2 + seed) * 0.35;
      head.rotation.y = Math.sin(t * 0.7 + seed) * 0.4;
      for (let i = 0; i < legs.length; i++) legs[i].rotation.x = speed > 0.1 ? Math.sin(t * 12 + (i % 2) * Math.PI + (i > 1 ? Math.PI / 2 : 0)) * 0.6 : 0;
    },
  };
}

/** A medium dog (about 75 cm long) with collar and a leash trailing behind. Forward is −z. */
export function makeDog(seed: number): Critter {
  const g = new THREE.Group();
  const fur = mat(DOG_COLORS[seed % DOG_COLORS.length], 0.9);
  const dark = mat(0x1a1612, 0.6);
  const body = part(geo.sphere, fur, 0.14, 0.15, 0.32, 0, 0.42, 0);
  const head = new THREE.Group();
  head.position.set(0, 0.58, -0.32);
  head.add(part(geo.sphere, fur, 0.1, 0.1, 0.11), part(geo.box, fur, 0.09, 0.08, 0.13, 0, -0.03, -0.11), part(geo.sphere, dark, 0.025, 0.022, 0.02, 0, -0.01, -0.18));
  const earL = part(geo.box, mat(DOG_COLORS[(seed + 1) % DOG_COLORS.length], 0.9), 0.04, 0.1, 0.06, -0.08, 0.0, 0.0); earL.rotation.z = 0.35;
  const earR = part(geo.box, mat(DOG_COLORS[(seed + 1) % DOG_COLORS.length], 0.9), 0.04, 0.1, 0.06, 0.08, 0.0, 0.0); earR.rotation.z = -0.35;
  head.add(earL, earR);
  const collar = part(geo.cyl, mat(0xc0392b, 0.5), 0.09, 0.03, 0.09, 0, 0.5, -0.27);
  collar.rotation.x = 1.1;
  const legs: THREE.Object3D[] = [];
  for (const [x, z] of [[-0.08, -0.2], [0.08, -0.2], [-0.08, 0.2], [0.08, 0.2]]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.36, z);
    pivot.add(part(geo.cyl, fur, 0.035, 0.36, 0.035, 0, -0.18, 0));
    legs.push(pivot);
    g.add(pivot);
  }
  const tail = new THREE.Group();
  tail.position.set(0, 0.5, 0.3);
  const tl = part(geo.cyl, fur, 0.025, 0.24, 0.025, 0, 0.1, 0.05);
  tl.rotation.x = -0.6;
  tail.add(tl);
  // Leash: a thin strap from the collar down to the ground behind.
  const leash = part(geo.box, mat(0x2d3a8c, 0.6), 0.015, 0.012, 0.9, 0, 0.26, 0.15);
  leash.rotation.x = -0.5;
  g.add(body, head, collar, tail, leash);
  return {
    object: g, legs, tail, head,
    update(_dt, speed, t) {
      const f = Math.min(1, speed / 3);
      const w = t * (6 + speed * 2.2);
      legs[0].rotation.x = Math.sin(w) * 0.7 * f; legs[3].rotation.x = Math.sin(w) * 0.7 * f;
      legs[1].rotation.x = -Math.sin(w) * 0.7 * f; legs[2].rotation.x = -Math.sin(w) * 0.7 * f;
      tail.rotation.z = Math.sin(t * 9) * 0.5;
      head.position.y = 0.58 + Math.abs(Math.sin(w)) * 0.02 * f;
      leash.rotation.y = Math.sin(w * 0.5) * 0.3 * f;
    },
  };
}

/** Small things: a wallet, a handbag, a cash bag. */
export function makeItem(kind: 'wallet' | 'bag' | 'cash' | 'envelope'): THREE.Group {
  const g = new THREE.Group();
  if (kind === 'envelope') {
    // A fat manila envelope, a band of notes showing at the flap.
    g.add(part(geo.box, mat(0xc8a46a, 0.8), 0.23, 0.03, 0.12, 0, 0.015, 0), part(geo.box, mat(0x3b8f4a, 0.6), 0.05, 0.032, 0.1, 0.07, 0.016, 0));
  } else if (kind === 'wallet') g.add(part(geo.box, mat(0x4a2e1a, 0.55), 0.11, 0.025, 0.09, 0, 0.0125, 0));
  else if (kind === 'bag') {
    g.add(part(geo.box, mat(0x8c2f39, 0.55), 0.3, 0.22, 0.1, 0, 0.11, 0));
    const strap = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.01, 5, 12, Math.PI), mat(0x8c2f39, 0.6));
    strap.position.y = 0.22;
    g.add(strap);
  } else {
    const b = part(geo.cyl, mat(0x22262b, 0.7), 0.13, 0.42, 0.13, 0, 0.13, 0);
    b.rotation.z = Math.PI / 2;
    g.add(b, part(geo.box, mat(0x3b8f4a, 0.6), 0.05, 0.03, 0.08, 0.05, 0.27, 0));
  }
  return g;
}

/** A pulsing glint over something lying on the ground (additive sprite). */
export function makeGlint(): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,240,1)');
  grad.addColorStop(0.25, 'rgba(255,240,200,0.6)');
  grad.addColorStop(1, 'rgba(255,230,180,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.fillRect(30, 4, 4, 56); g.fillRect(4, 30, 56, 4);
  const tex = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  s.scale.setScalar(0.35);
  return s;
}
