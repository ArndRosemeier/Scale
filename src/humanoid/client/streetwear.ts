/**
 * Costume pieces of the street characters (game/street): a tinfoil hat, a chicken mascot's head,
 * headphones, a nightcap, a sweatband, a sandwich board (its text in `visual.style`), a guitar
 * slung across the chest, a big folded city map held in front, and a flyer in the hand.
 *
 * Rigid parts in socket space (+Y up, +Z forward; see bodyBuild sockets), a few primitives each.
 * Every build makes its own geometry and materials (the rig disposes them with the part); the
 * board texts are canvas textures shared per text.
 */
import * as THREE from 'three';
import type { ItemVisual } from '../../items/types';
import type { RigidPart, WearableSpec, BodyFit, BodyRegion, Socket } from '../../items/wearable';
import { PLACARDS, FAN_SIGNS, FAN_SIGNS_FROM } from './placards';
import { srgbColor } from '../../render/color';

type C3 = [number, number, number];

const std = (c: C3, rough = 0.8, metal = 0): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color: srgbColor(c), roughness: rough, metalness: metal });

const rigid = (socket: RigidPart['socket'], build: (fit: BodyFit) => THREE.Object3D): RigidPart => ({ kind: 'rigid', socket, build });

/** Costume wearables by id (null: not one of these). */
export function streetWearable(defId: string, v: ItemVisual): WearableSpec | null {
  const c = v.primary, c2 = v.secondary;
  switch (defId) {
    case 'tinfoil': return { layers: [rigid('head', tinfoil)] };
    case 'chickenhead': return { layers: [rigid('head', (f) => chickenHead(f, c))], hideHair: true, hideBeard: true };
    case 'headphones': return { layers: [rigid('head', (f) => headphones(f, c))] };
    case 'nightcap': return { layers: [rigid('head', (f) => nightcap(f, c, c2))] };
    case 'sweatband': return { layers: [rigid('head', (f) => sweatband(f, c))] };
    case 'sandwichboard': return { layers: [rigid('chest', (f) => sandwichBoard(f, v.style || 'THE END IS NIGH', c))] };
    case 'guitar': return { layers: [rigid('chest', (f) => guitar(f, c))] };
    case 'citymap': return { layers: [rigid('chest', cityMap)] };
    // Villain groups' heads (game/factions/outfits): the raised dead, the necromancers, the eco-radicals.
    case 'skull': return { layers: [rigid('head', (f) => skull(f, c, v.glowColor ?? v.accent))], hideHair: true, hideBeard: true, hideRegions: ['scalp', 'face'] };
    // The raised dead's bones in place of the body (with 'skull' on the head).
    case 'skeleton': return skeleton(c);
    case 'bonemask': return { layers: [rigid('head', (f) => boneMask(f, c, c2, v.glowColor ?? v.accent))], hideHair: true };
    case 'leafwreath': return { layers: [rigid('head', (f) => leafWreath(f, c, c2))] };
    default: return null;
  }
}

/** Held costume items (null: not one of these). */
export function streetHeld(defId: string): THREE.Object3D | null {
  if (defId.startsWith('placard_')) return placard(Number(defId.slice(8)) || 0);
  // (The cameras turned in the grip: lens forward when the hands are up at the eye: take_photo, shoulder_cam.)
  const turned = (o: THREE.Object3D, dx = 0, dz = 0) => { o.rotation.set(Math.PI / 2, 0, Math.PI); o.position.set(dx, 0, dz); return new THREE.Group().add(o); };
  if (defId === 'presscam') return turned(pressCamera(), 0.17, -0.02);
  if (defId === 'mic') return microphone();
  if (defId === 'tvcam') return turned(tvCamera());
  if (defId !== 'flyer') return null;
  // A flyer pinched in the fist, standing up out of the thumb side.
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.21), new THREE.MeshStandardMaterial({ map: textTexture('2 FOR 1|TODAY ONLY', '#f6d64a', '#b3261e', 256, 352), roughness: 0.8, side: THREE.DoubleSide }));
  m.position.set(0, 0.1, 0.02);
  m.rotation.y = Math.PI / 2;
  g.add(m);
  return g;
}

/**
 * A protest placard (fame: protesters, fans): a painted board on a stick, held up high (the raised
 * torch grip: the stick upright, +Y), the text on both faces.
 */
function placard(i: number): THREE.Object3D {
  const g = new THREE.Group();
  const text = i < FAN_SIGNS_FROM ? PLACARDS[i % PLACARDS.length] : FAN_SIGNS[(i - FAN_SIGNS_FROM) % FAN_SIGNS.length];
  const fan = i >= FAN_SIGNS_FROM;
  const bg = fan ? '#fff4c2' : ['#f4f1e8', '#f6e27a', '#ffffff', '#f2c9a0'][i % 4];
  const fg = fan ? '#c0182a' : ['#141414', '#b3261e', '#1b2a8a', '#141414'][i % 4];
  const stick = new THREE.Mesh(new THREE.BoxGeometry(0.025, 1.05, 0.025), std([0.55, 0.4, 0.25], 0.9));
  stick.position.y = 0.2;
  const face = new THREE.MeshStandardMaterial({ map: textTexture(text, bg, fg, 384, 256), roughness: 0.9 });
  const edge = std([0.75, 0.7, 0.6], 0.9);
  // (Board faces ±X: the hand's palm side and back — turned to face forward by the grip.)
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.42, 0.62), [face, face, edge, edge, edge, edge]);
  board.position.set(0, 0.72, 0);
  g.add(stick, board);
  return g;
}

/** A press photographer's camera: body, a big lens and a flash head on top (its lamp: `flash`). */
function pressCamera(): THREE.Object3D {
  const g = new THREE.Group();
  const black = std([0.04, 0.04, 0.045], 0.45, 0.3);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 0.075), black);
  body.position.set(0, 0.06, 0.04);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.04, 0.12, 14), black);
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0, 0.055, 0.13);
  const glass = new THREE.Mesh(new THREE.CircleGeometry(0.03, 14), new THREE.MeshStandardMaterial({ color: 0x223344, roughness: 0.05, metalness: 0.8 }));
  glass.position.set(0, 0.055, 0.191);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.05, 0.06), black);
  head.position.set(0, 0.14, 0.05);
  const lamp = new THREE.Mesh(new THREE.PlaneGeometry(0.058, 0.035), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
  lamp.position.set(0, 0.14, 0.081);
  lamp.name = 'flash';
  g.add(body, lens, glass, head, lamp);
  return g;
}

/** A TV reporter's microphone with the channel's cube on it. */
function microphone(): THREE.Object3D {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.011, 0.2, 10), std([0.08, 0.08, 0.09], 0.4, 0.4));
  shaft.position.y = 0.06;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 10), std([0.15, 0.15, 0.16], 0.9));
  ball.position.y = 0.18;
  const cube = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.045, 0.055), new THREE.MeshStandardMaterial({ map: textTexture('6', '#c61f2b', '#ffffff', 64, 64), roughness: 0.5 }));
  cube.position.y = 0.12;
  g.add(shaft, ball, cube);
  return g;
}

/** A TV camera carried by its handle (put on the shoulder while filming: the action's pose). */
function tvCamera(): THREE.Object3D {
  const g = new THREE.Group();
  const grey = std([0.18, 0.18, 0.2], 0.5, 0.3), black = std([0.04, 0.04, 0.045], 0.45, 0.3);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.17, 0.38), grey);
  body.position.set(0, -0.02, 0.06);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.16, 14), black);
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0, 0, 0.32);
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.035, 0.03), new THREE.MeshBasicMaterial({ color: 0xfff2d0, toneMapped: false }));
  lamp.position.set(0, 0.09, 0.2);
  const red = new THREE.Mesh(new THREE.SphereGeometry(0.008, 6, 6), new THREE.MeshBasicMaterial({ color: 0xff2020, toneMapped: false }));
  red.position.set(0.04, 0.07, 0.24);
  g.add(body, lens, lamp, red);
  return g;
}

/** A crumpled foil cone (a little crooked), the brim folded out. */
function tinfoil(fit: BodyFit): THREE.Object3D {
  const r = fit.headRadius * 1.12;
  const foil = std([0.8, 0.81, 0.84], 0.32, 0.9);
  const g = new THREE.Group();
  const cone = new THREE.Mesh(new THREE.ConeGeometry(r, r * 2.3, 9, 3), foil);
  // Crumple: jitter the vertices (deterministic).
  const p = cone.geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const h = Math.sin(i * 12.9898) * 43758.5453;
    const k = (h - Math.floor(h) - 0.5) * 0.18 * r;
    if (p.getY(i) < r * 1.1) { p.setX(i, p.getX(i) + k); p.setZ(i, p.getZ(i) - k * 0.7); }
  }
  cone.geometry.computeVertexNormals();
  cone.position.set(0, fit.headRadius * 0.55 + r * 1.15, -0.01);
  cone.rotation.z = 0.12;
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.18, r * 1.25, 0.012, 11), foil);
  brim.position.set(0, fit.headRadius * 0.55, -0.01);
  g.add(cone, brim);
  return g;
}

/** A big round foam chicken head over the whole head: beak, comb, wattle, googly eyes. */
function chickenHead(fit: BodyFit, c: C3): THREE.Object3D {
  const R = fit.headRadius * 1.75;
  const g = new THREE.Group();
  const foam = std(c, 0.95);
  const head = new THREE.Mesh(new THREE.SphereGeometry(R, 18, 14), foam);
  head.scale.set(1, 1.12, 1);
  head.position.set(0, R * 0.35, 0);
  const beakM = std([0.98, 0.62, 0.12], 0.7);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(R * 0.3, R * 0.62, 10), beakM);
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, R * 0.25, R * 1.12);
  const red = std([0.86, 0.1, 0.1], 0.8);
  const comb = new THREE.Group();
  for (let k = 0; k < 3; k++) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(R * 0.2, 10, 8), red);
    s.position.set(0, R * 1.42 - Math.abs(k - 1) * R * 0.08, (k - 1) * R * 0.3);
    comb.add(s);
  }
  const wattle = new THREE.Mesh(new THREE.SphereGeometry(R * 0.15, 10, 8), red);
  wattle.scale.set(0.8, 1.4, 0.8);
  wattle.position.set(0, -R * 0.12, R * 0.98);
  const white = std([0.97, 0.97, 0.97], 0.5), black = std([0.03, 0.03, 0.03], 0.3);
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(R * 0.2, 12, 10), white);
    eye.position.set(s * R * 0.42, R * 0.62, R * 0.86);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(R * 0.09, 10, 8), black);
    pupil.position.set(s * R * 0.4 + 0.01, R * 0.6, R * 1.04);
    g.add(eye, pupil);
  }
  g.add(head, beak, comb, wattle);
  return g;
}

const lit = (c: C3, k: number): THREE.MeshStandardMaterial => {
  const m = std([c[0] * 0.3, c[1] * 0.3, c[2] * 0.3], 0.4);
  m.emissive = srgbColor(c);
  m.emissiveIntensity = k;
  return m;
};

/** A skull in place of the head: a domed cranium, deep dark sockets with a glow in them, a jaw. */
function skull(fit: BodyFit, bone: C3, eyes: C3): THREE.Object3D {
  // (The head is hidden under it: a skull a little smaller than the head, not a big round one.)
  const r = fit.headRadius * 0.9;
  const g = new THREE.Group();
  const m = std(bone, 0.75), dark = std([0.02, 0.02, 0.02], 0.9), glow = lit(eyes, 2.2);
  const cran = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 14), m);
  cran.scale.set(0.92, 1.02, 1.08);
  cran.position.set(0, r * 0.18, -r * 0.05);
  // The face narrows to the cheekbones and the upper jaw.
  const face = new THREE.Mesh(new THREE.SphereGeometry(r * 0.7, 14, 10), m);
  face.scale.set(1, 0.9, 0.9);
  face.position.set(0, -r * 0.3, r * 0.3);
  const jaw = new THREE.Mesh(new THREE.BoxGeometry(r * 1.0, r * 0.32, r * 0.75), m);
  jaw.position.set(0, -r * 0.82, r * 0.38);
  g.add(cran, face, jaw);
  for (const sx of [-1, 1]) {
    const sock = new THREE.Mesh(new THREE.SphereGeometry(r * 0.24, 12, 10), dark);
    sock.scale.set(1, 0.9, 0.45);
    sock.position.set(sx * r * 0.34, r * 0.0, r * 0.82);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(r * 0.1, 8, 6), glow);
    eye.position.set(sx * r * 0.34, r * 0.0, r * 0.88);
    g.add(sock, eye);
  }
  const nose = new THREE.Mesh(new THREE.ConeGeometry(r * 0.1, r * 0.2, 3), dark);
  nose.rotation.x = Math.PI;
  nose.position.set(0, -r * 0.3, r * 0.93);
  // A row of teeth.
  for (let k = -3; k <= 3; k++) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(r * 0.1, r * 0.16, r * 0.06), m);
    t.position.set(k * r * 0.12, -r * 0.62, r * 0.74 - Math.abs(k) * r * 0.035);
    g.add(t);
  }
  g.add(nose);
  return g;
}

// ---------------------------------------------------------------------------------------------
// The raised dead: the whole body hidden, bones on every socket (they follow the animation).
// Limb sockets: origin at the joint, +Y along the limb to the next joint, +Z forward. Trunk
// sockets: +Y up, +Z forward. Foot: +Y towards the toes, +Z up. Hand: +Y to the fingers, +X thumb.
// ---------------------------------------------------------------------------------------------

const ALL_REGIONS: BodyRegion[] = ['scalp', 'face', 'neck', 'chest', 'belly', 'back', 'pelvis', 'buttocks', 'upperarm.L', 'upperarm.R', 'forearm.L', 'forearm.R', 'hand.L', 'hand.R', 'thigh.L', 'thigh.R', 'shin.L', 'shin.R', 'foot.L', 'foot.R'];

function skeleton(bone: C3): WearableSpec {
  const mat = () => std(bone, 0.7);
  const B = (f: BodyFit) => f.bones ?? { upperArm: f.height * 0.17, forearm: f.height * 0.15, thigh: f.height * 0.245, shin: f.height * 0.25, neck: f.height * 0.07, chest: f.height * 0.12, spine: f.height * 0.1 };
  /** A long bone from the origin up +Y: shaft with knobbly ends. */
  const longBone = (g: THREE.Object3D, m: THREE.Material, len: number, r: number, x = 0, z = 0) => {
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r * 0.7, len * 0.86, 8), m);
    shaft.position.set(x, len / 2, z);
    const a = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), m);
    a.scale.set(1.25, 0.8, 1); a.position.set(x, len * 0.05, z);
    const b = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), m);
    b.scale.set(1.25, 0.8, 1); b.position.set(x, len * 0.95, z);
    g.add(shaft, a, b);
  };
  /** Vertebrae stacked up +Y from y0 to y1, set back by z. */
  const column = (g: THREE.Object3D, m: THREE.Material, y0: number, y1: number, r: number, z: number) => {
    const n = Math.max(2, Math.round((y1 - y0) / 0.032));
    for (let k = 0; k < n; k++) {
      const d = new THREE.Mesh(new THREE.CylinderGeometry(r, r, ((y1 - y0) / n) * 0.62, 8), m);
      d.position.set(0, y0 + ((k + 0.5) / n) * (y1 - y0), z);
      const spur = new THREE.Mesh(new THREE.BoxGeometry(r * 0.45, r * 0.6, r * 1.3), m);
      spur.position.set(0, d.position.y, z - r * 1.2);
      g.add(d, spur);
    }
  };
  const part = (socket: Socket, build: (f: BodyFit, g: THREE.Group, m: THREE.Material) => void): RigidPart => rigid(socket, (f) => { const g = new THREE.Group(); build(f, g, mat()); return g; });
  const layers: RigidPart[] = [
    part('neck', (f, g, m) => column(g, m, 0, B(f).neck * 0.95, f.neckRadius * 0.4, -f.neckRadius * 0.2)),
    // Ribcage round the chest socket, the clavicles across the top, a sternum in front.
    part('chest', (f, g, m) => {
      const w = f.shoulderWidth * 0.29, d = f.chestDepth * 0.4, top = 0.04, bottom = top - f.height * 0.15, n = 6, gap = 0.55;
      // (The socket sits on the spine at the back: the ribs curve round forward of it.)
      column(g, m, bottom - 0.1, top + 0.03, 0.02, 0);
      for (let k = 0; k < n; k++) {
        const t = k / (n - 1), y = top - t * (top - bottom);
        const sc = 0.7 + 0.32 * Math.sin(Math.PI * (0.3 + t * 0.6));
        const ring = new THREE.Group();
        const rib = new THREE.Mesh(new THREE.TorusGeometry(1, 0.0085 / (w * sc), 5, 24, Math.PI * 2 - gap * 2), m);
        rib.rotation.z = Math.PI / 2 + gap;
        ring.add(rib);
        ring.rotation.x = Math.PI / 2 - 0.3;
        ring.scale.set(w * sc, d * (0.8 + 0.2 * sc), w * sc);
        ring.position.set(0, y, d * 0.82);
        g.add(ring);
      }
      const sternum = new THREE.Mesh(new THREE.BoxGeometry(0.03, (top - bottom) * 0.6, 0.014), m);
      sternum.position.set(0, top - (top - bottom) * 0.35, d * 1.62);
      sternum.rotation.x = 0.15;
      g.add(sternum);
      for (const sx of [-1, 1]) {
        const cl = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, f.shoulderWidth * 0.4, 6), m);
        cl.rotation.z = Math.PI / 2 + sx * 0.12;
        cl.position.set(sx * f.shoulderWidth * 0.22, top + 0.03, d * 1.3);
        g.add(cl);
      }
    }),
    // The lumbar column from the hips up to the ribs; the pelvis round the hip joints.
    part('pelvis', (f, g, m) => {
      column(g, m, 0.04, B(f).spine + 0.02, 0.026, -f.waistRadius * 0.45);
      const hw = f.waistRadius * 0.95;
      for (const sx of [-1, 1]) {
        const wing = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8, 0, Math.PI), m);
        wing.scale.set(hw * 0.5, hw * 0.55, 0.02);
        wing.rotation.y = sx * 0.9;
        wing.position.set(sx * hw * 0.55, hw * 0.25, -hw * 0.15);
        g.add(wing);
      }
      const sacrum = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 6), m);
      sacrum.rotation.x = Math.PI;
      sacrum.position.set(0, -0.02, -hw * 0.45);
      const pubis = new THREE.Mesh(new THREE.TorusGeometry(hw * 0.4, 0.013, 5, 14, Math.PI), m);
      pubis.rotation.set(Math.PI / 2 + 0.3, 0, 0);
      pubis.position.set(0, -0.06, 0.02);
      g.add(sacrum, pubis);
    }),
  ];
  for (const s of ['L', 'R'] as const) {
    layers.push(
      part(`upperarm.${s}`, (f, g, m) => longBone(g, m, B(f).upperArm, f.upperArmRadius * 0.38)),
      part(`forearm.${s}`, (f, g, m) => { const r = f.forearmRadius * 0.24; longBone(g, m, B(f).forearm, r, r * 1.2); longBone(g, m, B(f).forearm, r * 0.8, -r * 1.2); }),
      part(`hand.${s}`, (f, g, m) => {
        const L = f.handLength, r = 0.007;
        for (let k = 0; k < 4; k++) {
          const x = (k - 1.5) * 0.017;
          const finger = new THREE.Group();
          longBone(finger, m, L * (k === 1 ? 0.95 : k === 3 ? 0.78 : 0.9), r);
          finger.position.x = x;
          finger.rotation.z = -x * 2.2;
          g.add(finger);
        }
        const thumb = new THREE.Group();
        longBone(thumb, m, L * 0.55, r * 1.1);
        thumb.position.set(0.02, 0.0, 0.0);
        thumb.rotation.z = -0.7;
        g.add(thumb);
      }),
      part(`thigh.${s}`, (f, g, m) => longBone(g, m, B(f).thigh, f.thighRadius * 0.3)),
      part(`shin.${s}`, (f, g, m) => { const r = f.shinRadius * 0.32; longBone(g, m, B(f).shin, r, 0, r * 0.4); longBone(g, m, B(f).shin, r * 0.5, r * 1.6, -r * 0.6); }),
      part(`foot.${s}`, (f, g, m) => {
        const L = f.footLength, r = 0.008;
        const heel = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), m);
        heel.scale.set(0.9, 1.4, 1);
        heel.position.set(0, -0.02, -0.04);
        g.add(heel);
        for (let k = 0; k < 5; k++) {
          const toe = new THREE.Group();
          longBone(toe, m, L * (0.78 - Math.abs(k - 1) * 0.06), r * (k === 0 ? 1.5 : 1));
          toe.position.set((k - 2) * 0.016, 0, -0.035);
          toe.rotation.z = -(k - 2) * 0.06;
          g.add(toe);
        }
      }),
    );
  }
  return { layers, hideHair: true, hideBeard: true, hideRegions: ALL_REGIONS };
}

/** A necromancer's bone-white mask under a deep hood; the eyes lit behind it. */
function boneMask(fit: BodyFit, hood: C3, bone: C3, eyes: C3): THREE.Object3D {
  const r = fit.headRadius;
  const g = new THREE.Group();
  const hm = std(hood, 0.95);
  hm.side = THREE.DoubleSide;
  const cowl = new THREE.Mesh(new THREE.SphereGeometry(r * 1.32, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), hm);
  cowl.scale.set(1, 1.15, 1.1);
  cowl.position.set(0, r * 0.15, -r * 0.12);
  // The point of the hood falling down the back.
  const tip = new THREE.Mesh(new THREE.ConeGeometry(r * 0.75, r * 1.5, 10), hm);
  tip.rotation.x = -2.3;
  tip.position.set(0, r * 0.35, -r * 1.05);
  const mm = std(bone, 0.6);
  const mask = new THREE.Mesh(new THREE.SphereGeometry(r * 0.95, 16, 12, -Math.PI * 0.42, Math.PI * 0.84, Math.PI * 0.2, Math.PI * 0.62), mm);
  mask.scale.set(1, 1.08, 1.06);
  mask.position.set(0, -r * 0.05, r * 0.1);
  const glow = lit(eyes, 1.8), dark = std([0.02, 0.02, 0.02], 0.9);
  g.add(cowl, tip, mask);
  for (const sx of [-1, 1]) {
    const sock = new THREE.Mesh(new THREE.SphereGeometry(r * 0.17, 10, 8), dark);
    sock.scale.set(1.2, 0.7, 0.4);
    sock.position.set(sx * r * 0.33, r * 0.12, r * 0.98);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(r * 0.06, 8, 6), glow);
    eye.position.set(sx * r * 0.33, r * 0.12, r * 1.02);
    g.add(sock, eye);
  }
  return g;
}

/** A wreath of leaves and twigs round the head (the eco-radicals). */
function leafWreath(fit: BodyFit, leaf: C3, twig: C3): THREE.Object3D {
  const r = fit.headRadius * 1.08;
  const g = new THREE.Group();
  const tm = std(twig, 0.9), lm = std(leaf, 0.8);
  lm.side = THREE.DoubleSide;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r, r * 0.07, 6, 24), tm);
  ring.rotation.x = Math.PI / 2;
  ring.position.set(0, r * 0.3, -r * 0.05);
  g.add(ring);
  const leafG = new THREE.CircleGeometry(r * 0.24, 6);
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2;
    const l = new THREE.Mesh(leafG, lm);
    l.scale.set(0.55, 1, 1);
    l.position.set(Math.sin(a) * r * 1.02, r * 0.38 + (k % 2) * r * 0.08, Math.cos(a) * r * 1.02 - r * 0.05);
    l.rotation.set(-0.5 + (k % 3) * 0.3, a, (k % 2 ? 0.6 : -0.6));
    g.add(l);
  }
  return g;
}

/** Big over-ear headphones: a band over the top, two cups. */
function headphones(fit: BodyFit, c: C3): THREE.Object3D {
  const r = fit.headRadius;
  const g = new THREE.Group();
  const m = std(c, 0.4, 0.2), dark = std([0.06, 0.06, 0.07], 0.5);
  const band = new THREE.Mesh(new THREE.TorusGeometry(r * 1.12, 0.012, 6, 20, Math.PI), m);
  // (The arc runs from ear to ear over the crown: the torus's XY plane.)
  band.position.set(0, r * 0.15, -0.005);
  g.add(band);
  for (const s of [-1, 1]) {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.42, r * 0.42, 0.05, 14), m);
    cup.rotation.z = Math.PI / 2;
    cup.position.set(s * r * 1.08, r * 0.08, 0);
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.36, r * 0.36, 0.02, 14), dark);
    pad.rotation.z = Math.PI / 2;
    pad.position.set(s * r * 1.03 - s * 0.02, r * 0.08, 0);
    g.add(cup, pad);
  }
  return g;
}

/** A floppy nightcap with a pompom. */
function nightcap(fit: BodyFit, c: C3, c2: C3): THREE.Object3D {
  const r = fit.headRadius * 1.08;
  const g = new THREE.Group();
  const m = std(c, 0.95);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(r, r * 2.6, 12, 4, true), m);
  cap.material.side = THREE.DoubleSide;
  cap.position.set(0, fit.headRadius * 0.4 + r * 1.0, -r * 0.35);
  cap.rotation.x = -0.75;
  const pom = new THREE.Mesh(new THREE.SphereGeometry(r * 0.22, 10, 8), std(c2, 1));
  pom.position.set(0, fit.headRadius * 0.4 + r * 1.85, -r * 1.5);
  g.add(cap, pom);
  return g;
}

/** A terry sweatband round the forehead. */
function sweatband(fit: BodyFit, c: C3): THREE.Object3D {
  const r = fit.headRadius * 1.02;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.045, 18, 1, true), std(c, 1));
  band.material.side = THREE.DoubleSide;
  band.position.set(0, fit.headRadius * 0.38, 0.005);
  band.rotation.x = -0.18;
  return band;
}

/** Two painted boards on shoulder straps, front and back, hanging to the knees. */
function sandwichBoard(fit: BodyFit, text: string, c: C3): THREE.Object3D {
  const g = new THREE.Group();
  const w = Math.max(0.46, fit.shoulderWidth * 1.15), h = 0.82;
  const front = new THREE.MeshStandardMaterial({ map: textTexture(text, '#f2ecd9', '#141414', 384, 640), roughness: 0.85 });
  const edge = std(c, 0.85);
  const d = fit.chestDepth;
  for (const s of [1, -1]) {
    const board = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.018), [edge, edge, edge, edge, s > 0 ? front : edge, s > 0 ? edge : front]);
    board.position.set(0, -h * 0.5 + 0.06, s > 0 ? d * 0.78 + 0.05 : -d * 0.55 - 0.06);
    board.rotation.x = s > 0 ? -0.06 : 0.06;
    g.add(board);
  }
  const strap = std([0.22, 0.16, 0.1], 0.7);
  for (const x of [-1, 1]) {
    const st = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.006, d * 1.45 + 0.12), strap);
    st.position.set(x * fit.shoulderWidth * 0.28, 0.13, d * 0.12);
    g.add(st);
  }
  return g;
}

/** An acoustic guitar slung across the chest: body at the right hip, neck up to the left. */
function guitar(fit: BodyFit, c: C3): THREE.Object3D {
  const g = new THREE.Group();
  const wood = std(c, 0.45), dark = std([0.08, 0.06, 0.05], 0.6), neckM = std([0.3, 0.2, 0.12], 0.6);
  const body = new THREE.Group();
  const lower = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.09, 20), wood);
  const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.145, 0.09, 20), wood);
  lower.rotation.x = upper.rotation.x = Math.PI / 2;
  upper.position.set(0, 0.22, 0);
  const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.092, 14), dark);
  hole.rotation.x = Math.PI / 2;
  hole.position.set(0, 0.12, 0);
  body.add(lower, upper, hole);
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 0.025), neckM);
  neck.position.set(0, 0.6, 0.02);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.16, 0.022), neckM);
  head.position.set(0, 0.92, 0.015);
  body.add(neck, head);
  // Hand anchors for the play_guitar action (anim/actions.ts): the left hand's place on the neck
  // and the strings over the sound hole (+Y up the neck, +Z out of the top).
  const fret = new THREE.Object3D(), strum = new THREE.Object3D();
  fret.name = 'reach:fret';
  fret.position.set(0, 0.6, 0.02);
  strum.name = 'reach:strum';
  strum.position.set(0, 0.12, 0.045);
  body.add(fret, strum);
  // Across the body: tilted ~60° (neck up to the player's left, +X), in front of the belly.
  body.rotation.z = -1.05;
  body.position.set(-0.1, -0.24, fit.chestDepth * 0.75 + 0.08);
  const strap = new THREE.Mesh(new THREE.TorusGeometry(fit.shoulderWidth * 0.42, 0.012, 5, 18), dark);
  strap.rotation.set(0.15, 0, -0.75);
  strap.position.set(0, -0.02, fit.chestDepth * 0.1);
  g.add(body, strap);
  return g;
}

/** A big unfolded city map held up in front of the chest (the read_map pose holds its edges). */
function cityMap(fit: BodyFit): THREE.Object3D {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.44, 4, 1), new THREE.MeshStandardMaterial({ map: mapTexture(), roughness: 0.9, side: THREE.DoubleSide }));
  // Folds: a zig-zag across the sheet.
  const p = m.geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setZ(i, (Math.round((p.getX(i) + 0.31) / 0.155) % 2) * 0.025);
  m.geometry.computeVertexNormals();
  m.position.set(0, -0.1, fit.chestDepth * 0.8 + 0.2);
  m.rotation.x = -0.85;
  return m;
}

// ------------------------------------------------------------------ textures

const textures = new Map<string, THREE.CanvasTexture>();

/** Hand-painted block letters on a board (lines split at '|'), cached per text. */
function textTexture(text: string, bg: string, fg: string, w: number, h: number): THREE.Texture {
  const key = `${text}|${bg}|${fg}|${w}x${h}`;
  let t = textures.get(key);
  if (t) return t;
  const cv = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (!cv) return new THREE.Texture();
  cv.width = w; cv.height = h;
  const x = cv.getContext('2d')!;
  x.fillStyle = bg;
  x.fillRect(0, 0, w, h);
  x.strokeStyle = fg;
  x.lineWidth = w * 0.02;
  x.strokeRect(w * 0.04, h * 0.03, w * 0.92, h * 0.94);
  const lines = text.split('|');
  x.fillStyle = fg;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  const longest = Math.max(...lines.map((l) => l.length));
  const size = Math.min(h / (lines.length + 1.2), (w * 1.55) / Math.max(4, longest));
  x.font = `bold ${size.toFixed(0)}px Impact, "Arial Black", sans-serif`;
  lines.forEach((l, i) => {
    const y = h / 2 + (i - (lines.length - 1) / 2) * size * 1.12;
    // A little wobble: painted by hand.
    x.save();
    x.translate(w / 2, y);
    x.rotate(((i * 7919) % 5 - 2) * 0.012);
    x.fillText(l, 0, 0, w * 0.86);
    x.restore();
  });
  t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  textures.set(key, t);
  return t;
}

/** A tourist map: pale paper, blocks, a river, a red route. */
function mapTexture(): THREE.Texture {
  const key = 'citymap';
  let t = textures.get(key);
  if (t) return t;
  const cv = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (!cv) return new THREE.Texture();
  cv.width = 256; cv.height = 192;
  const x = cv.getContext('2d')!;
  x.fillStyle = '#f3efe2';
  x.fillRect(0, 0, 256, 192);
  x.fillStyle = '#d9d3bf';
  for (let i = 0; i < 9; i++) for (let j = 0; j < 7; j++) if ((i * 31 + j * 17) % 7 > 1) x.fillRect(6 + i * 28, 6 + j * 26, 22, 20);
  x.fillStyle = '#a9d18e';
  x.fillRect(118, 60, 50, 46);
  x.strokeStyle = '#7fb2de';
  x.lineWidth = 9;
  x.beginPath(); x.moveTo(0, 150); x.bezierCurveTo(80, 120, 150, 190, 256, 130); x.stroke();
  x.strokeStyle = '#d23a2a';
  x.lineWidth = 3;
  x.setLineDash([6, 4]);
  x.beginPath(); x.moveTo(30, 20); x.lineTo(90, 70); x.lineTo(140, 80); x.lineTo(200, 40); x.stroke();
  t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  textures.set(key, t);
  return t;
}
