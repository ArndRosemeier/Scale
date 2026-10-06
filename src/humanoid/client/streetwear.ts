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
import type { RigidPart, WearableSpec, BodyFit } from '../../items/wearable';
import { PLACARDS, FAN_SIGNS, FAN_SIGNS_FROM } from './placards';

type C3 = [number, number, number];

const std = (c: C3, rough = 0.8, metal = 0): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...c, THREE.SRGBColorSpace), roughness: rough, metalness: metal });

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
