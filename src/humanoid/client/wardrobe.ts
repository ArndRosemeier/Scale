/**
 * The city wardrobe: deterministic city outfits (garment ids and colours per slot, worn as
 * Actors garments), rigid pieces Scale builds itself, and simple held items (phone, coffee, bag,
 * umbrella).
 */
import * as THREE from 'three';
import type { EquipmentVisuals, ItemVisual } from '../../items/types';
import type { WearableSpec, BodyFit, RigidPart } from '../../items/wearable';
import { Rng } from '../../core/rng';
import { streetWearable, streetHeld } from './streetwear';
import { srgbColor } from '../../render/color';

type C3 = [number, number, number];

/**
 * Scale's own pieces of an outfit: rigid parts on the body's sockets (a beanie; the street
 * characters' and villains' costume pieces). Soft clothes (shirts, trousers, shoes, caps, helmets,
 * gloves…) are Actors garments (humanoid/actors/outfit.ts) and never come here.
 */
export function resolveWearable(defId: string, v: ItemVisual): WearableSpec | null {
  const c = v.primary;
  switch (defId) {
    case 'cap': return { layers: [capPart(c)] };
    case 'helmet': return { layers: [helmetPart(c)] };
    case 'beanie': return { layers: [beaniePart(c)] };
    // Costumes of the street characters (game/street) and the villain groups.
    default: return streetWearable(defId, v);
  }
}

function capPart(c: C3): RigidPart {
  return {
    kind: 'rigid',
    socket: 'head',
    build(fit: BodyFit) {
      const g = new THREE.Group();
      const m = new THREE.MeshStandardMaterial({ color: srgbColor(c), roughness: 0.85 });
      const r = fit.headRadius * 1.08;
      const dome = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.45), m);
      dome.position.set(0, fit.headRadius * 0.35, -0.005);
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.75, r * 0.8, 0.008, 16, 1, false, -Math.PI / 2, Math.PI), m);
      brim.position.set(0, fit.headRadius * 0.45, r * 0.55);
      brim.scale.set(1, 1, 1.3);
      g.add(dome, brim);
      return g;
    },
  };
}

/** A combat helmet: a deep dome with a rim, matte. */
function helmetPart(c: C3): RigidPart {
  return {
    kind: 'rigid',
    socket: 'head',
    build(fit: BodyFit) {
      const m = new THREE.MeshStandardMaterial({ color: srgbColor(c), roughness: 0.9 });
      const r = fit.headRadius * 1.2;
      const dome = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), m);
      dome.position.set(0, fit.headRadius * 0.22, -0.01);
      dome.scale.set(1, 0.92, 1.06);
      return dome;
    },
  };
}

function beaniePart(c: C3): RigidPart {
  return {
    kind: 'rigid',
    socket: 'head',
    build(fit: BodyFit) {
      const m = new THREE.MeshStandardMaterial({ color: srgbColor(c), roughness: 0.95 });
      const r = fit.headRadius * 1.1;
      const dome = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.52), m);
      dome.position.set(0, fit.headRadius * 0.25, -0.01);
      return dome;
    },
  };
}

// ---------------------------------------------------------------- held items

export function itemDef(defId: string): { visual: { shape: string }; category?: string; twoHanded?: boolean; tool?: boolean } | undefined {
  // An umbrella is held up like a torch (the raised-arm grip, shaft upright).
  // So is a protest placard.
  return { visual: { shape: defId }, category: defId === 'umbrella' || defId.startsWith('placard_') ? 'light' : 'trinket' };
}

export function buildItemObject(defId: string, v: ItemVisual): THREE.Object3D {
  const g = new THREE.Group();
  const col = srgbColor(v.primary);
  switch (defId) {
    case 'phone': {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.15, 0.008), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.2, metalness: 0.5 }));
      m.position.set(0, 0.04, 0.01);
      g.add(m);
      break;
    }
    case 'coffee': {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.033, 0.13, 14), new THREE.MeshStandardMaterial({ color: 0xf0ebe0, roughness: 0.6 }));
      const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.044, 0.012, 14), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5 }));
      lid.position.y = 0.07;
      m.add(lid);
      m.position.set(0, 0.02, 0.03);
      g.add(m);
      break;
    }
    case 'bag': {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.24, 0.1), new THREE.MeshStandardMaterial({ color: col, roughness: 0.55 }));
      m.position.set(0, -0.2, 0);
      const strap = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.008, 6, 16, Math.PI), new THREE.MeshStandardMaterial({ color: col, roughness: 0.6 }));
      strap.position.set(0, -0.08, 0);
      g.add(m, strap);
      break;
    }
    case 'knife': {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.13, 0.004), new THREE.MeshStandardMaterial({ color: 0xc8ccd0, roughness: 0.25, metalness: 0.8 }));
      blade.position.set(0, 0.1, 0);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.08, 0.018), new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 }));
      g.add(blade, grip);
      break;
    }
    case 'club_bat': {
      const bat = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.016, 0.8, 8), new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.6 }));
      bat.position.y = 0.32;
      g.add(bat);
      break;
    }
    case 'rifle': {
      // Held at the grip: the barrel forward along +Y, the stock back.
      const dark = new THREE.MeshStandardMaterial({ color: 0x1b1d1a, roughness: 0.6, metalness: 0.3 });
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.42, 0.09), dark);
      body.position.set(0, 0.08, 0.03);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.38, 6), dark);
      barrel.position.set(0, 0.47, 0.05);
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.24, 0.11), dark);
      stock.position.set(0, -0.24, 0.0);
      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.05, 0.14), dark);
      mag.position.set(0, 0.12, -0.06);
      g.add(body, barrel, stock, mag);
      break;
    }
    case 'pistol': {
      // Held at the grip (along the hand), the slide and barrel forward along +Y like the rifle's.
      const dark = new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.45, metalness: 0.55 });
      const slide = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.034, 0.19), dark);
      slide.position.set(0, 0.045, 0.06);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.1, 0.034), dark);
      grip.position.set(0, -0.0, -0.005);
      grip.rotation.x = 0.25;
      g.add(slide, grip);
      break;
    }
    case 'wallet': {
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.02), new THREE.MeshStandardMaterial({ color: 0x4a2e1a, roughness: 0.55 })));
      break;
    }
    case 'envelope': {
      // Protection money: a fat manila envelope held up in the hand.
      const env = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.22, 0.12), new THREE.MeshStandardMaterial({ color: 0xc8a46a, roughness: 0.8 }));
      env.position.y = 0.06;
      g.add(env);
      break;
    }
    case 'cash': {
      // A heist's take: a dark duffel bag with a band of notes showing, hanging from the hand.
      const bag = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.4, 8), new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.7 }));
      bag.rotation.x = Math.PI / 2;
      bag.position.y = -0.12;
      const notes = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.08), new THREE.MeshStandardMaterial({ color: 0x3b8f4a, roughness: 0.6 }));
      notes.position.set(0, -0.01, 0);
      g.add(bag, notes);
      break;
    }
    case 'bomb': {
      // A round black bomb with a short fuse (the mad bomber's): held in the palm.
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 9), new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.45, metalness: 0.35 }));
      m.position.set(0, 0.06, 0.03);
      const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.06, 5), new THREE.MeshStandardMaterial({ color: 0xc8a060, emissive: 0xff7a20, emissiveIntensity: 0.6 }));
      fuse.position.set(0, 0.155, 0.03);
      g.add(m, fuse);
      break;
    }
    case 'lantern': {
      // A procession's lantern (the necromancers'): a bail in the fist, the lit glass hanging below.
      const iron = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.5, metalness: 0.6 });
      const glow = srgbColor(v.glowColor ?? v.accent ?? v.primary);
      const glass = new THREE.MeshStandardMaterial({ color: glow, emissive: glow, emissiveIntensity: 2.4, roughness: 0.3 });
      const bail = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.005, 5, 12, Math.PI), iron);
      bail.rotation.z = Math.PI;
      bail.position.y = 0.0;
      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.065, 0.05, 6), iron);
      cap.position.y = -0.065;
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.045, 0.13, 6), glass);
      body.position.y = -0.155;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.056, 0.056, 0.02, 6), iron);
      base.position.y = -0.23;
      g.add(bail, cap, body, base);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.14, 0.006), iron);
        bar.position.set(Math.cos(a) * 0.05, -0.155, Math.sin(a) * 0.05);
        g.add(bar);
      }
      break;
    }
    case 'umbrella': {
      // Held up beside the head (raised grip): a short shaft to the canopy just above it.
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.75, 6), new THREE.MeshStandardMaterial({ color: 0x222222 }));
      shaft.position.y = 0.3;
      const canopy = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.22, 8, 1, true), new THREE.MeshStandardMaterial({ color: col, roughness: 0.8, side: THREE.DoubleSide }));
      canopy.position.y = 0.66;
      g.add(shaft, canopy);
      break;
    }
    default: {
      const s = streetHeld(defId);
      if (s) g.add(s);
      break;
    }
  }
  return g;
}

export function animateItem(_o: THREE.Object3D, _t: number): void {}
export function setItemSkyVis(_o: THREE.Object3D, _v: number): void {}
export function disposeItemObject(o: THREE.Object3D): void {
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    // (Some items carry a material array: one per part.)
    if (m.isMesh) { m.geometry.dispose(); for (const mt of Array.isArray(m.material) ? m.material : [m.material]) mt.dispose(); }
  });
}

// ------------------------------------------------------------------- outfits

const FABRIC: C3[] = [
  [0.12, 0.13, 0.16], [0.2, 0.22, 0.3], [0.85, 0.85, 0.82], [0.55, 0.12, 0.12], [0.2, 0.35, 0.55], [0.35, 0.3, 0.25],
  [0.55, 0.5, 0.42], [0.15, 0.3, 0.2], [0.7, 0.6, 0.2], [0.45, 0.45, 0.48], [0.9, 0.55, 0.6], [0.3, 0.2, 0.35], [0.95, 0.92, 0.85],
];
const DENIM: C3[] = [[0.18, 0.25, 0.42], [0.12, 0.16, 0.28], [0.3, 0.38, 0.55], [0.08, 0.08, 0.1]];
const SHOE: C3[] = [[0.08, 0.08, 0.08], [0.25, 0.15, 0.08], [0.9, 0.9, 0.9], [0.4, 0.3, 0.2], [0.15, 0.18, 0.3]];

function vis(seed: number, primary: C3, secondary: C3, pattern = 'plain'): ItemVisual {
  return { shape: 'cloth', seed, primary, secondary, accent: secondary, material: pattern, glow: 0 } as ItemVisual;
}

/**
 * Deterministic city outfit. `formal` (0..1) biases suits/coats, `cold` (0..1) adds outerwear.
 */
export function cityOutfit(seed: number, gender: number, age: number, formal: number, cold: number): EquipmentVisuals {
  const r = new Rng(seed ^ 0x51ab);
  const eq: EquipmentVisuals = {};
  const female = gender < 0.5;
  const pick = (a: C3[]) => r.pick(a);
  const pattern = () => r.weighted(['plain', 'stripes', 'checks'], (p) => (p === 'plain' ? 6 : 1));
  const suit = r.chance(formal * 0.7);
  if (suit) {
    const sc = r.pick([[0.12, 0.12, 0.14], [0.2, 0.22, 0.28], [0.3, 0.3, 0.32], [0.25, 0.2, 0.15]] as C3[]);
    eq.chest = { defId: 'shirt', visual: vis(r.nextU32(), r.pick([[0.95, 0.95, 0.95], [0.75, 0.85, 0.95], [0.95, 0.9, 0.9]] as C3[]), [0.9, 0.9, 0.9]) };
    eq.back = { defId: 'suitjacket', visual: vis(r.nextU32(), sc, sc) };
    if (female && r.chance(0.5)) eq.legs = { defId: 'skirt', visual: vis(r.nextU32(), sc, sc) };
    else eq.legs = { defId: 'trousers', visual: vis(r.nextU32(), sc, sc) };
    eq.feet = { defId: 'shoes', visual: vis(r.nextU32(), pick(SHOE.slice(0, 2)), [0, 0, 0]) };
  } else {
    const top = r.weighted(['tshirt', 'shirt', 'sweater'], (t) => (t === 'tshirt' ? 3 * (1 - cold) + 0.3 : t === 'sweater' ? 1 + cold * 2 : 2));
    const c1 = pick(FABRIC), c2 = pick(FABRIC);
    if (female && r.chance(0.25)) {
      eq.chest = { defId: 'dress', visual: vis(r.nextU32(), c1, c2, pattern()) };
    } else {
      eq.chest = { defId: top, visual: vis(r.nextU32(), c1, c2, pattern()) };
      const legs = female ? r.weighted(['jeans', 'trousers', 'skirt', 'shorts'], (l) => (l === 'shorts' ? 1 - cold : l === 'skirt' ? 1.2 : 2)) : r.weighted(['jeans', 'trousers', 'shorts'], (l) => (l === 'shorts' ? (1 - cold) * 1.2 : 2.5));
      eq.legs = { defId: legs, visual: vis(r.nextU32(), legs === 'jeans' ? pick(DENIM) : pick(FABRIC), pick(FABRIC), legs === 'trousers' ? 'plain' : pattern()) };
    }
    if (r.chance(0.15 + cold * 0.6)) eq.back = { defId: r.chance(0.5) ? 'jacket' : 'coat', visual: vis(r.nextU32(), pick(FABRIC), pick(FABRIC), r.chance(0.2) ? 'leather' : 'plain') };
    eq.feet = { defId: r.weighted(['sneakers', 'shoes', 'boots'], (s) => (s === 'sneakers' ? 3 : s === 'boots' ? cold * 2 + 0.3 : 1.5)), visual: vis(r.nextU32(), pick(SHOE), [1, 1, 1]) };
  }
  if (r.chance(0.12 + cold * 0.2)) eq.head = { defId: cold > 0.5 ? 'beanie' : 'cap', visual: vis(r.nextU32(), pick(FABRIC), pick(FABRIC)) };
  void age;
  return eq;
}

/** Optional held item. */
export function heldItem(seed: number): EquipmentVisuals['mainhand'] | undefined {
  const r = new Rng(seed ^ 0x77);
  const k = r.weighted(['none', 'phone', 'coffee', 'bag'], (x) => (x === 'none' ? 6 : 1));
  if (k === 'none') return undefined;
  return { defId: k, visual: vis(r.nextU32(), r.pick(FABRIC), [0, 0, 0]) };
}
