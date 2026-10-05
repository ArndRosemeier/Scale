/**
 * The look of a fiery explosion, shared by the player's fireball (Elements) and a villain's bomb
 * (crime/Bombs): a ball of flame, a column of smoke, chips and dust, a scorch on the ground. Only
 * pools that exist already (the powers' particles and decals, debris chips, dust) — no new
 * programs, no real lights. What the blast does to the world is the caller's.
 */
import * as THREE from 'three';
import { DecalKind, type ElementFx } from './ElementFx';
import type { Debris } from '../../destruction/Debris';
import type { Dust } from '../../destruction/Dust';

const FIRE_HOT = new THREE.Color(3.2, 1.6, 0.45), FIRE_END = new THREE.Color(0.6, 0.12, 0.02);
const CORE = new THREE.Color(4.5, 3.2, 1.6), CORE_END = new THREE.Color(1.6, 0.5, 0.06);
const SMOKE = new THREE.Color(0.16, 0.15, 0.14), SMOKE_L = new THREE.Color(0.42, 0.41, 0.4);
const DUST = new THREE.Color(0.55, 0.52, 0.47);

/**
 * A fiery burst at (x, y, z) of `size` (a hand grenade 0.8, a fireball 1–3, an army bomb 3) and
 * `ground` the height of the ground below for the scorch mark (NaN: none — it went off in the air).
 */
export function fireBurst(fx: ElementFx, debris: Debris, dust: Dust, x: number, y: number, z: number, size: number, ground: number, smoke = 1): void {
  // A white-hot core, then the rolling ball of flame.
  for (let i = 0; i < 3; i++) fx.glow(x, y, z, 0, 1.5, 0, 0.18 + i * 0.05, size * 1.4, size * 3.4, CORE, CORE_END, 1, 1, 0);
  const n = Math.round(8 + size * 6);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, u = Math.random() * 2 - 1, s = Math.sqrt(1 - u * u), v = (5 + Math.random() * 7) * size;
    fx.glow(x, y, z, Math.cos(a) * s * v, Math.abs(u) * v * 0.8 + 2, Math.sin(a) * s * v, 0.35 + Math.random() * 0.35, size * 1.0, size * 2.8, FIRE_HOT, FIRE_END, 0.9, 2.6, -3);
  }
  // Smoke rises from above the burst (not from the ground, where the sprites would cut into it); `smoke` scales the amount.
  for (let i = 0; i < Math.round((2 + size * 2) * smoke); i++) {
    fx.soft(x + (Math.random() - 0.5) * size * 1.6, y + size * (0.6 + Math.random() * 0.6), z + (Math.random() - 0.5) * size * 1.6, (Math.random() - 0.5) * 3, 2.5 + Math.random() * 2.5 * size, (Math.random() - 0.5) * 3, 2 + size, size * 1.1, size * 3.6, SMOKE, SMOKE_L, 0.45, 0.6, -0.8);
  }
  debris.chipBurst(x, y, z, Math.round(8 + size * 8), 6 + size * 5, 0, 1, 0, DUST, 0.05, 1.6);
  if (Number.isFinite(ground) && y - ground < size * 3) {
    dust.burst(x, ground + 0.2, z, Math.round(8 * size), size * 2.5, size * 3, size * 2.2, 4, DUST, 0.4, 0.5);
    fx.decal(DecalKind.Scorch, x, ground + 0.03, z, 0, 1, 0, size * 2.6, size * 2.6, Math.random() * 6, 60);
  }
}
