/**
 * Modern city clothing for the Norgo garment-shell system, plus simple held
 * items (phone, coffee, bag, umbrella). Replaces Norgo's medieval item module.
 */
import * as THREE from 'three';
import type { EquipmentVisuals, ItemVisual } from '../../items/types';
import type { ShellLayer, ShellMaterial, WearableSpec, BodyFit, RigidPart } from '../../items/wearable';
import { Rng } from '../../core/rng';

type C3 = [number, number, number];

const mat = (color: C3, pattern: ShellMaterial['pattern'] = 'plain', o: Partial<ShellMaterial> = {}): ShellMaterial => ({
  color,
  color2: o.color2 ?? [color[0] * 0.75, color[1] * 0.75, color[2] * 0.75],
  pattern,
  patternScale: o.patternScale ?? 6,
  roughness: o.roughness ?? 0.85,
  metalness: 0,
  sheen: o.sheen ?? 0.3,
  glow: 0,
  glowColor: [0, 0, 0],
  wear: o.wear ?? 0.15,
});

const TORSO = [{ region: 'chest' as const }, { region: 'belly' as const }, { region: 'back' as const }];
const ARMS = (to: number) => [
  { region: 'upperarm.L' as const, to: Math.min(1, to * 2) }, { region: 'upperarm.R' as const, to: Math.min(1, to * 2) },
  ...(to > 0.5 ? [{ region: 'forearm.L' as const, to: (to - 0.5) * 2 }, { region: 'forearm.R' as const, to: (to - 0.5) * 2 }] : []),
];
const LEGS = (to: number) => [
  { region: 'pelvis' as const }, { region: 'buttocks' as const },
  { region: 'thigh.L' as const, to: Math.min(1, to * 2) }, { region: 'thigh.R' as const, to: Math.min(1, to * 2) },
  ...(to > 0.5 ? [{ region: 'shin.L' as const, to: (to - 0.5) * 2 }, { region: 'shin.R' as const, to: (to - 0.5) * 2 }] : []),
];

export function resolveWearable(defId: string, v: ItemVisual): WearableSpec | null {
  const c = v.primary, c2 = v.secondary;
  const pat = (v.material as ShellMaterial['pattern']) || 'plain';
  const L = (layer: ShellLayer): WearableSpec => ({ layers: [layer] });
  switch (defId) {
    case 'tshirt': return L({ kind: 'shell', regions: [...TORSO, ...ARMS(0.22)], offset: 0.004, layer: 1, material: mat(c, pat, { color2: c2, roughness: 0.9 }), trim: { width: 0.006, color: c2 } });
    case 'shirt': return L({ kind: 'shell', regions: [...TORSO, ...ARMS(0.97)], offset: 0.004, layer: 1, material: mat(c, pat, { color2: c2, roughness: 0.75, sheen: 0.2 }), trim: { width: 0.01, color: [c[0] * 0.9, c[1] * 0.9, c[2] * 0.9] } });
    case 'sweater': return L({ kind: 'shell', regions: [...TORSO, { region: 'neck', to: 0.3 }, ...ARMS(0.95)], offset: 0.008, layer: 2, material: mat(c, pat === 'plain' ? 'quilted' : pat, { color2: c2, roughness: 0.95, patternScale: 14, sheen: 0.5 }), trim: { width: 0.015, color: c2 } });
    case 'jacket': return L({ kind: 'shell', regions: [...TORSO, ...ARMS(0.95)], offset: 0.014, layer: 3, material: mat(c, pat, { color2: c2, roughness: pat === 'leather' ? 0.55 : 0.8 }), trim: { width: 0.02, color: c2 } });
    case 'suitjacket': return L({ kind: 'shell', regions: [...TORSO, ...ARMS(0.97)], offset: 0.012, layer: 3, material: mat(c, 'plain', { roughness: 0.7, sheen: 0.35 }), skirt: { length: 0.22, flare: 0.05, slits: 1 }, trim: { width: 0.02, color: [c[0] * 0.7, c[1] * 0.7, c[2] * 0.7] } });
    case 'coat': return L({ kind: 'shell', regions: [...TORSO, ...ARMS(0.97)], offset: 0.02, layer: 4, material: mat(c, pat, { color2: c2, roughness: 0.9, sheen: 0.4 }), skirt: { length: 0.72, flare: 0.25, slits: 1 }, trim: { width: 0.03, color: c2 } });
    case 'jeans': return L({ kind: 'shell', regions: LEGS(0.97), offset: 0.006, layer: 1, material: mat(c, 'plain', { roughness: 0.92, wear: 0.4 }) });
    case 'trousers': return L({ kind: 'shell', regions: LEGS(0.98), offset: 0.007, layer: 1, material: mat(c, pat, { color2: c2, roughness: 0.8 }) });
    case 'shorts': return L({ kind: 'shell', regions: LEGS(0.4), offset: 0.006, layer: 1, material: mat(c, pat, { color2: c2 }) });
    case 'skirt': return L({ kind: 'shell', regions: [{ region: 'pelvis', from: 0.5 }, { region: 'buttocks', from: 0.4 }], offset: 0.008, layer: 2, material: mat(c, pat, { color2: c2, roughness: 0.8 }), skirt: { length: 0.45 + (v.seed % 3) * 0.12, flare: 0.3 } });
    case 'dress': return L({ kind: 'shell', regions: [...TORSO, { region: 'pelvis' }, { region: 'buttocks' }, ...ARMS(v.seed % 2 ? 0.2 : 0)], offset: 0.006, layer: 2, material: mat(c, pat, { color2: c2, roughness: 0.75, sheen: 0.5 }), skirt: { length: 0.55 + (v.seed % 3) * 0.1, flare: 0.35 } });
    case 'sneakers': return L({ kind: 'shell', regions: [{ region: 'foot.L' }, { region: 'foot.R' }], offset: 0.012, layer: 1, material: mat(c, 'plain', { roughness: 0.7 }), trim: { width: 0.02, color: [0.95, 0.95, 0.95] } });
    case 'shoes': return L({ kind: 'shell', regions: [{ region: 'foot.L' }, { region: 'foot.R' }], offset: 0.01, layer: 1, material: mat(c, 'leather', { roughness: 0.4 }) });
    case 'boots': return L({ kind: 'shell', regions: [{ region: 'foot.L' }, { region: 'foot.R' }, { region: 'shin.L', from: 0.65 }, { region: 'shin.R', from: 0.65 }], offset: 0.012, layer: 2, material: mat(c, 'leather', { roughness: 0.5 }) });
    case 'cap': return { layers: [capPart(c)] };
    case 'helmet': return { layers: [helmetPart(c)] };
    case 'beanie': return { layers: [beaniePart(c)] };
    default: return null;
  }
}

function capPart(c: C3): RigidPart {
  return {
    kind: 'rigid',
    socket: 'head',
    build(fit: BodyFit) {
      const g = new THREE.Group();
      const m = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...c, THREE.SRGBColorSpace), roughness: 0.85 });
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
      const m = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...c, THREE.SRGBColorSpace), roughness: 0.9 });
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
      const m = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...c, THREE.SRGBColorSpace), roughness: 0.95 });
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
  return { visual: { shape: defId }, category: defId === 'umbrella' ? 'light' : 'trinket' };
}

export function buildItemObject(defId: string, v: ItemVisual): THREE.Object3D {
  const g = new THREE.Group();
  const col = new THREE.Color().setRGB(...v.primary, THREE.SRGBColorSpace);
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
    case 'wallet': {
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.02), new THREE.MeshStandardMaterial({ color: 0x4a2e1a, roughness: 0.55 })));
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
    default:
      break;
  }
  return g;
}

export function animateItem(_o: THREE.Object3D, _t: number): void {}
export function setItemSkyVis(_o: THREE.Object3D, _v: number): void {}
export function disposeItemObject(o: THREE.Object3D): void {
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
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
