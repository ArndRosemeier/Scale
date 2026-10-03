/**
 * Near-future models built with the street-furniture builder (one merged geometry each, drawn
 * with the shared furniture material, so they instance and light like the rest of the street):
 * a six-wheeled sidewalk delivery robot, a delivery quadcopter (body, rotor, parcel) and the
 * pedestal of a holographic info kiosk.
 *
 * Conventions as in furniture.ts: origin at the ground contact (drones: body centre), front -Z.
 * LED parts use the Light material with sub codes 10 (status), 11 (strobe), 12 (nav light).
 */
import * as THREE from 'three';
import { FB, FMat, METAL, RUBBER, GLASS, paint, plastic, type PO, type V } from '../props/furniture';

const led = (sub: 10 | 11 | 12, c: V = [1, 1, 1]): PO => ({ m: FMat.Light, e: 1, s: sub, c });

/** Robot body proportions (m). */
export const ROBOT = { length: 0.72, width: 0.56, height: 0.62, flag: 1.45, mass: 45 };

/** Rounded box: a box with bevelled vertical edges, from a lathe-free extrusion. */
function roundedBox(fb: FB, po: PO, w: number, h: number, l: number, r: number, x: number, y: number, z: number, seg = 3) {
  const s = new THREE.Shape();
  const hw = w / 2 - r, hl = l / 2 - r;
  s.moveTo(-hw, -l / 2);
  s.lineTo(hw, -l / 2);
  s.absarc(hw, -hl, r, -Math.PI / 2, 0, false);
  s.lineTo(w / 2, hl);
  s.absarc(hw, hl, r, 0, Math.PI / 2, false);
  s.lineTo(-hw, l / 2);
  s.absarc(-hw, hl, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-w / 2, -hl);
  s.absarc(-hw, -hl, r, Math.PI, Math.PI * 1.5, false);
  const g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: true, bevelSize: Math.min(r, 0.03), bevelThickness: Math.min(r, 0.03), bevelSegments: 2, curveSegments: seg });
  // Shape lies in XY extruded along +Z: stand it up (extrusion → +Y).
  g.rotateX(-Math.PI / 2);
  g.translate(x, y, z);
  g.computeVertexNormals();
  fb.add(g, new THREE.Matrix4(), po);
}

/**
 * Sidewalk delivery robot: a white cooler box on six small wheels, a dark sensor band at the
 * front with a status light strip, a hinged lid, and the orange safety flag on a whip antenna.
 * Painted parts (lid stripe) take the fleet colour from iColor.
 */
export function robotGeometry(): THREE.BufferGeometry {
  const fb = new FB();
  const shell = plastic([0.9, 0.9, 0.88], true);
  const dark = plastic([0.08, 0.085, 0.09], true);
  const L = ROBOT.length, W = ROBOT.width;
  // Six wheels (three per side) with hub caps.
  for (const sx of [-1, 1]) for (const zz of [-0.24, 0, 0.24]) {
    const wg = new THREE.CylinderGeometry(0.095, 0.095, 0.075, 16);
    wg.rotateZ(Math.PI / 2);
    fb.add(wg, new THREE.Matrix4().makeTranslation(sx * (W / 2 - 0.02), 0.095, zz), RUBBER);
    const hg = new THREE.CylinderGeometry(0.045, 0.045, 0.08, 10);
    hg.rotateZ(Math.PI / 2);
    fb.add(hg, new THREE.Matrix4().makeTranslation(sx * (W / 2 - 0.015), 0.095, zz), METAL);
  }
  // Chassis tub (dark) and the cooler body.
  roundedBox(fb, dark, W - 0.1, 0.1, L - 0.04, 0.06, 0, 0.1, 0);
  roundedBox(fb, shell, W - 0.04, 0.3, L, 0.08, 0, 0.19, 0);
  // Lid: slightly domed, with a fleet-coloured stripe.
  roundedBox(fb, shell, W - 0.06, 0.06, L - 0.03, 0.08, 0, 0.5, 0.005);
  fb.box(paint([0.1, 0.55, 0.5]), 0.12, 0.012, L - 0.12, 0, 0.592, 0.01);
  // Lid seam.
  fb.box(dark, W - 0.02, 0.012, L + 0.012, 0, 0.495, 0);
  // Front sensor band (dark glass) with a status light strip and two camera eyes.
  fb.box(dark, W - 0.12, 0.11, 0.03, 0, 0.36, -L / 2 - 0.02);
  fb.box(led(10), W - 0.2, 0.022, 0.012, 0, 0.395, -L / 2 - 0.038);
  for (const sx of [-0.13, 0.13]) fb.cyl(GLASS, 0.022, 0.022, 0.02, sx, 0.335, -L / 2 - 0.035, 10, false, Math.PI / 2);
  // Rear light and side reflectors.
  fb.box(led(12, [0.9, 0.05, 0.03]), W - 0.26, 0.025, 0.01, 0, 0.42, L / 2 + 0.035);
  for (const sx of [-1, 1]) fb.box(led(12, [1, 0.45, 0.05]), 0.01, 0.025, 0.08, sx * (W / 2 + 0.002), 0.3, -L / 2 + 0.12);
  // Whip antenna with the orange pennant (rear left).
  const ax = -W / 2 + 0.08, az = L / 2 - 0.08;
  fb.rod(METAL, [ax, 0.5, az], [ax, ROBOT.flag, az], 0.006, 6, 0.004);
  const flag = new THREE.BufferGeometry();
  flag.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, -0.24, 0, 0, -0.11, 0.3], 3));
  flag.setAttribute('normal', new THREE.Float32BufferAttribute([1, 0, 0, 1, 0, 0, 1, 0, 0], 3));
  flag.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 0.5], 2));
  fb.add(flag, new THREE.Matrix4().makeTranslation(ax, ROBOT.flag - 0.01, az), plastic([1, 0.38, 0.05], true), undefined, true);
  fb.sphere(led(10), 0.014, ax, ROBOT.flag + 0.01, az, 1, 1, 1, 8, 6);
  return fb.build();
}

/** Drone proportions (m): arm reach from the centre to a motor. */
export const DRONE = { arm: 0.52, rotorR: 0.3, mass: 7 };

/** Motor positions (body frame) of the four rotors. */
export const DRONE_MOTORS: [number, number, number][] = [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]].map(([x, , z]) => [x * DRONE.arm * 0.7071, 0.09, z * DRONE.arm * 0.7071]);

/**
 * Quadcopter body (origin at the body centre, front -Z): a streamlined shell in the fleet
 * colour, four arms with motor pods, landing skids, a camera ball and navigation lights
 * (red port / green starboard, white strobe on top). Variant 1 (news) carries a bigger gimbal.
 */
export function droneGeometry(variant: number): THREE.BufferGeometry {
  const fb = new FB();
  const shell = paint([0.92, 0.92, 0.9]);
  const dark = plastic([0.1, 0.1, 0.11], true);
  fb.sphere(shell, 0.2, 0, 0, 0, 1.0, 0.42, 1.35, 16, 10);
  fb.sphere(dark, 0.17, 0, -0.04, 0, 1.0, 0.35, 1.25, 14, 8);
  for (const [mx, my, mz] of DRONE_MOTORS) {
    fb.rod(dark, [mx * 0.25, 0, mz * 0.25], [mx, my - 0.03, mz], 0.022, 8);
    fb.cyl(dark, 0.042, 0.048, 0.07, mx, my - 0.06, mz, 12);
    fb.cyl(METAL, 0.012, 0.012, 0.03, mx, my + 0.01, mz, 8);
    // Small down-facing leg under each motor.
    fb.rod(dark, [mx, my - 0.06, mz], [mx * 1.05, -0.2, mz * 1.05], 0.01, 6);
  }
  // Navigation lights on the front arms' motor pods, strobe on top, status underneath.
  const [lf, , rf] = [DRONE_MOTORS[0], 0, DRONE_MOTORS[1]];
  fb.sphere(led(12, [1, 0.04, 0.02]), 0.022, lf[0], lf[1] - 0.04, lf[2] - 0.045, 1, 1, 1, 8, 6);
  fb.sphere(led(12, [0.05, 1, 0.2]), 0.022, rf[0], rf[1] - 0.04, rf[2] - 0.045, 1, 1, 1, 8, 6);
  fb.cyl(led(11), 0.025, 0.03, 0.025, 0, 0.075, 0.05, 10);
  fb.box(led(10), 0.18, 0.012, 0.02, 0, -0.06, -0.24);
  // Camera.
  const camR = variant === 1 ? 0.07 : 0.045;
  fb.sphere(dark, camR, 0, -0.1 - camR * 0.5, -0.16, 1, 1, 1, 12, 8);
  fb.cyl(GLASS, camR * 0.5, camR * 0.5, 0.02, 0, -0.1 - camR * 0.5, -0.16 - camR, 10, false, Math.PI / 2);
  return fb.build();
}

/** One rotor (two blades and a hub), centred on its axis; spun per instance. */
export function rotorGeometry(): THREE.BufferGeometry {
  const fb = new FB();
  const blade = plastic([0.12, 0.12, 0.13], true);
  for (const a of [0, Math.PI]) {
    const g = new THREE.BoxGeometry(DRONE.rotorR, 0.006, 0.045);
    g.translate(DRONE.rotorR / 2, 0, 0);
    g.rotateX(0.12);
    g.rotateY(a);
    fb.add(g, new THREE.Matrix4(), blade);
  }
  fb.cyl(METAL, 0.02, 0.02, 0.018, 0, -0.009, 0, 8);
  return fb.build();
}

/** Parcel hanging under a delivery drone (cardboard box with tape). */
export function parcelGeometry(): THREE.BufferGeometry {
  const fb = new FB();
  fb.box(plastic([0.62, 0.46, 0.3], true), 0.3, 0.22, 0.36, 0, -0.32, 0);
  fb.box(plastic([0.85, 0.8, 0.7], true), 0.305, 0.03, 0.365, 0, -0.22, 0);
  fb.rod(METAL, [0, -0.2, 0], [0, -0.14, 0], 0.006, 4);
  return fb.build();
}

/** Holographic kiosk pedestal: a slim plinth with a glowing emitter ring (the hologram is separate). */
export function kioskPedestalGeometry(): THREE.BufferGeometry {
  const fb = new FB();
  const body = paint([0.16, 0.17, 0.19], true);
  fb.lathe(body, [[0, 0], [0.34, 0], [0.36, 0.05], [0.3, 0.12], [0.22, 0.85], [0.26, 0.92], [0.28, 0.96], [0, 0.96]], 28);
  fb.lathe(led(10), [[0.282, 0.955], [0.27, 0.975], [0.0, 0.975]], 28);
  fb.box(GLASS, 0.24, 0.32, 0.01, 0, 0.55, -0.2, 0, -0.12);
  return fb.build();
}

/** Street-cleaning robot proportions (m). */
export const CLEANER = { length: 0.92, width: 0.62, height: 0.56, mass: 70 };
/** Side brush hubs (body frame, front -Z) and bristle reach. */
export const CLEANER_BRUSHES: [number, number, number][] = [[-0.25, 0.05, -0.42], [0.25, 0.05, -0.42]];

/**
 * Street-cleaning robot: a low rounded sweeper body in the municipal colour (iColor) with a
 * dark skirt, two driven rear wheels, a front sensor band, a dirt hopper lid and an amber
 * beacon on a short mast (status LED, blinking amber = mode 1). The side brushes are separate
 * (spun per instance).
 */
export function cleanerGeometry(): THREE.BufferGeometry {
  const fb = new FB();
  const body = paint([0.95, 0.55, 0.1]);
  const dark = plastic([0.07, 0.075, 0.08], true);
  const L = CLEANER.length, W = CLEANER.width;
  roundedBox(fb, dark, W - 0.02, 0.12, L - 0.02, 0.14, 0, 0.04, 0);
  roundedBox(fb, body, W, 0.28, L, 0.16, 0, 0.14, 0.02);
  // Hopper lid (light grey) and a dark seam.
  roundedBox(fb, plastic([0.82, 0.83, 0.82], true), W - 0.14, 0.07, L * 0.55, 0.1, 0, 0.44, 0.1);
  fb.box(dark, W + 0.01, 0.014, L + 0.01, 0, 0.425, 0.02);
  // Rear wheels and a front caster.
  for (const sx of [-1, 1]) {
    const wg = new THREE.CylinderGeometry(0.11, 0.11, 0.07, 16);
    wg.rotateZ(Math.PI / 2);
    fb.add(wg, new THREE.Matrix4().makeTranslation(sx * (W / 2 - 0.01), 0.11, L / 2 - 0.2), RUBBER);
  }
  fb.sphere(dark, 0.05, 0, 0.05, -L / 2 + 0.2, 1, 1, 1, 10, 6);
  // Brush arms (the brushes hang under their ends).
  for (const [bx, , bz] of CLEANER_BRUSHES) fb.rod(dark, [bx * 0.5, 0.12, bz + 0.08], [bx, 0.1, bz], 0.018, 6);
  // Front sensor band with status strip and camera eyes.
  fb.box(dark, W - 0.16, 0.09, 0.03, 0, 0.3, -L / 2 - 0.0);
  fb.box(led(10), W - 0.26, 0.018, 0.012, 0, 0.325, -L / 2 - 0.018);
  for (const sx of [-0.12, 0.12]) fb.cyl(GLASS, 0.02, 0.02, 0.02, sx, 0.285, -L / 2 - 0.012, 10, false, Math.PI / 2);
  // Reflective stripes on the flanks, rear light.
  for (const sx of [-1, 1]) fb.box({ m: FMat.PaintedMetal, s: 9, c: [0.9, 0.9, 0.9] }, 0.01, 0.04, L * 0.6, sx * (W / 2 + 0.003), 0.3, 0.02);
  fb.box(led(12, [0.9, 0.05, 0.03]), W - 0.3, 0.025, 0.01, 0, 0.36, L / 2 + 0.03);
  // Beacon mast (rear).
  fb.cyl(METAL, 0.012, 0.012, 0.16, 0, 0.47, L / 2 - 0.16, 8);
  fb.cyl(led(10, [1, 0.6, 0.1]), 0.035, 0.035, 0.05, 0, 0.62, L / 2 - 0.16, 12);
  fb.sphere(led(10, [1, 0.6, 0.1]), 0.035, 0, 0.67, L / 2 - 0.16, 1, 0.6, 1, 12, 6, Math.PI / 2);
  return fb.build();
}

/** A side brush: hub and eight bristle tufts fanning out and down, origin at the hub. */
export function brushGeometry(): THREE.BufferGeometry {
  const fb = new FB();
  fb.cyl(plastic([0.1, 0.1, 0.11], true), 0.05, 0.05, 0.03, 0, 0, 0, 12);
  const bristle = plastic([0.2, 0.18, 0.12], true);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    fb.rod(bristle, [Math.cos(a) * 0.04, 0.01, Math.sin(a) * 0.04], [Math.cos(a) * 0.19, -0.045, Math.sin(a) * 0.19], 0.012, 4, 0.02);
  }
  return fb.build();
}

/**
 * Humanoid service robot (≈1.72 m, slim), as articulated parts drawn per instance:
 * body (legs, pelvis, torso, neck), head, upper arm and forearm (+hand). Each part's origin is
 * its pivot; HUMANOID gives the pivots in the parent frame. White shell, graphite joints, the
 * accent (chest stripe, shoulder caps) in iColor, a visor with LED eyes and a chest status bar.
 */
export const HUMANOID = {
  height: 1.72, mass: 65,
  shoulder: [0.215, 1.39, 0] as V,
  neck: [0, 1.49, 0] as V,
  elbow: [0, -0.28, 0] as V,
};

export function humanoidBodyGeometry(): THREE.BufferGeometry {
  const fb = new FB();
  const shell = plastic([0.93, 0.93, 0.91], true);
  const joint = plastic([0.12, 0.125, 0.13], true);
  const accent = paint([0.95, 0.75, 0.1]);
  for (const sx of [-1, 1]) {
    const x = sx * 0.1;
    // Foot, shin, knee, thigh.
    roundedBox(fb, joint, 0.1, 0.06, 0.24, 0.04, x, 0.0, -0.04);
    fb.capsule(shell, [x, 0.1, 0], [x, 0.47, 0], 0.052, 0.06);
    fb.sphere(joint, 0.06, x, 0.5, 0, 1, 1, 1, 10, 8);
    fb.capsule(shell, [x, 0.53, 0], [x * 0.95, 0.88, 0], 0.065, 0.078);
  }
  // Pelvis and waist joint.
  fb.sphere(joint, 0.15, 0, 0.93, 0, 1, 0.55, 0.75, 14, 8);
  fb.cyl(joint, 0.1, 0.12, 0.12, 0, 0.95, 0, 14);
  // Torso: a tapered shell, chest plate and accent stripe.
  fb.lathe(shell, [[0, 1.04], [0.12, 1.05], [0.15, 1.15], [0.18, 1.3], [0.19, 1.4], [0.15, 1.46], [0.06, 1.48], [0, 1.48]], 18, 0, 0, 0, 1, 0.7);
  fb.box(accent, 0.05, 0.3, 0.02, 0, 1.25, -0.128, 0, 0.12);
  fb.box(led(10), 0.11, 0.016, 0.01, 0, 1.36, -0.13);
  // Shoulder caps (accent) and neck.
  for (const sx of [-1, 1]) fb.sphere(accent, 0.062, sx * HUMANOID.shoulder[0], HUMANOID.shoulder[1], 0, 1, 1, 1, 12, 8);
  fb.cyl(joint, 0.04, 0.045, 0.07, 0, 1.46, 0, 10);
  return fb.build();
}

export function humanoidHeadGeometry(): THREE.BufferGeometry {
  const fb = new FB();
  const shell = plastic([0.93, 0.93, 0.91], true);
  fb.sphere(shell, 0.105, 0, 0.13, 0.005, 0.9, 1.12, 1.0, 16, 12);
  // Visor (dark glass) wrapping the front, LED eyes behind it.
  fb.sphere(plastic([0.03, 0.035, 0.04], true), 0.1, 0, 0.14, -0.012, 0.92, 0.42, 0.96, 16, 8);
  for (const sx of [-0.035, 0.035]) fb.sphere(led(10), 0.012, sx, 0.145, -0.104, 1.4, 0.7, 0.5, 8, 6);
  // Ear discs.
  for (const sx of [-1, 1]) fb.cyl(plastic([0.12, 0.125, 0.13], true), 0.03, 0.03, 0.02, sx * 0.095, 0.13, 0.005, 10, false, 0, 0, Math.PI / 2);
  return fb.build();
}

export function humanoidUpperArmGeometry(): THREE.BufferGeometry {
  const fb = new FB();
  fb.capsule(plastic([0.93, 0.93, 0.91], true), [0, -0.03, 0], [0, -0.25, 0], 0.048, 0.042);
  fb.sphere(plastic([0.12, 0.125, 0.13], true), 0.042, 0, -0.28, 0, 1, 1, 1, 10, 8);
  return fb.build();
}

export function humanoidForearmGeometry(): THREE.BufferGeometry {
  const fb = new FB();
  const joint = plastic([0.12, 0.125, 0.13], true);
  fb.capsule(plastic([0.93, 0.93, 0.91], true), [0, -0.02, 0], [0, -0.22, 0], 0.04, 0.034);
  // Hand: palm block and a thumb.
  roundedBox(fb, joint, 0.05, 0.1, 0.085, 0.02, 0, -0.34, 0);
  fb.capsule(joint, [0, -0.27, -0.035], [0, -0.31, -0.06], 0.012);
  return fb.build();
}
