/**
 * Characters for the start-up warm-up: two dressed rigs that between them wear every kind of
 * garment shader the city's people and the hero use (one-sided shells, double-sided skirts and
 * coats, cowl and full masks), hair and hats, all casting shadows. Added to the scene unseen
 * while loading, so the shader gate compiles these programs behind the loading screen.
 *
 * Without them the first coat, dress or masked hero met in play compiled its skinned
 * MeshPhysical garment shader (and the hair's shadow variant) while drawing: up to 10 s on a
 * Windows PC with a cold shader cache.
 */
import * as THREE from 'three';
import { HumanoidRig } from './HumanoidRig';
import { randomAppearance } from '../appearance';
import type { EquipmentVisuals, ItemVisual } from '../../items/types';

type C3 = [number, number, number];

function cloth(seed: number, primary: C3, secondary: C3 = primary, material = 'plain'): ItemVisual {
  return { shape: 'cloth', seed, primary, secondary, accent: secondary, material, glow: 0 } as ItemVisual;
}

const OUTFITS: { gender: number; eq: EquipmentVisuals }[] = [
  {
    gender: 0.1,
    eq: {
      chest: { defId: 'dress', visual: cloth(11, [0.55, 0.12, 0.12], [0.2, 0.22, 0.3], 'stripes') },
      back: { defId: 'coat', visual: cloth(12, [0.35, 0.3, 0.25]) },
      feet: { defId: 'boots', visual: cloth(13, [0.25, 0.15, 0.08], [1, 1, 1]) },
      head: { defId: 'cap', visual: cloth(14, [0.2, 0.35, 0.55]) },
      face: { defId: 'mask_cowl', visual: cloth(15, [0.05, 0.05, 0.06]) },
    },
  },
  {
    gender: 0.9,
    eq: {
      shoulders: { defId: 'tights', visual: cloth(21, [0.2, 0.3, 0.7], [0.8, 0.1, 0.1]) },
      chest: { defId: 'sweater', visual: cloth(22, [0.15, 0.3, 0.2], [0.7, 0.6, 0.2], 'checks') },
      legs: { defId: 'jeans', visual: cloth(23, [0.18, 0.25, 0.42]) },
      back: { defId: 'jacket', visual: cloth(24, [0.12, 0.13, 0.16], [0.12, 0.13, 0.16], 'leather') },
      feet: { defId: 'sneakers', visual: cloth(25, [0.9, 0.9, 0.9], [1, 1, 1]) },
      head: { defId: 'beanie', visual: cloth(26, [0.3, 0.2, 0.35]) },
      face: { defId: 'mask_full', visual: cloth(27, [0.05, 0.05, 0.06]) },
    },
  },
];

/**
 * Builds the warm-up rigs into `parent` at `at`, never drawn; resolves when all are dressed (their
 * garments added, so the gate has seen them). They stay for the whole game: disposing them would
 * release their programs (three deletes a program nobody uses) and the next coat would compile
 * again.
 */
export function warmRigs(parent: THREE.Object3D, at: THREE.Vector3): Promise<unknown> {
  const rigs = OUTFITS.map((o, i) => {
    const rig = new HumanoidRig(randomAppearance('human', 9100 + i, { gender: o.gender, age: 0.4 }), { castShadow: true, priority: -5 });
    rig.setEquipment(o.eq);
    rig.object.name = 'warm-rig';
    rig.object.position.copy(at);
    // (Hidden: the gate compiles hidden meshes too, and nobody sees a stranger at the start.)
    rig.object.visible = false;
    parent.add(rig.object);
    return rig;
  });
  return Promise.all(rigs.map((r) => r.whenDressed));
}
