/**
 * Protection racket (tier 1, a street gang's operation — VILLAINS_PLAN §3.2). One or two gang
 * members stroll up to a shop; the owner steps out of the door, they loom over them, an envelope of
 * cash changes hands and they saunter off. It plays out like a mugging with the shopkeeper as the
 * victim (Mugging's staging, confrontation and escape), so the same tactics work: scare them off,
 * knock them out, bring the envelope back.
 */
import { Mugging } from './Mugging';
import type { PedAgent } from '../../sim/Pedestrians';

export const RACKET = { ringMin: 110, ringMax: 380, hp: 60, strength: 1.1, batChance: 0.45 };

export class Racket extends Mugging {
  readonly kind = 'racket' as const;
  door: { x: number; z: number; nx: number; nz: number } | null = null;

  setup(): boolean {
    const shops = this.w.shops?.(this.near ? 0 : RACKET.ringMin, this.near ? 90 : RACKET.ringMax) ?? [];
    if (!shops.length) return false;
    const door = shops[this.rng.int(0, Math.min(shops.length, 6) - 1)];
    // The owner, standing in the doorway (they come out when they see who it is).
    const heading = Math.atan2(-door.nx, -door.nz) + Math.PI;
    const owner = this.spawnOwned(this.rng.nextU32(), door.x + door.nx * 0.7, door.z + door.nz * 0.7, heading, 'shopkeeper');
    if (!owner?.actor) return false;
    Object.assign(owner.actor, { hp: 40, maxHp: 40, strength: 0.6, held: null });
    // The collectors, coming along the pavement from out of view.
    const ax = -door.nz, az = door.nx, side = this.rng.chance(0.5) ? 1 : -1;
    const n = this.rng.chance(0.55) ? 2 : 1;
    for (let i = 0; i < n; i++) {
      let c: PedAgent | null = null;
      for (let k = 0; k < 6 && !c; k++) {
        const along = side * (24 + k * 5 + i * 1.6), out = 2.6 + i * 0.9;
        const x = door.x + ax * along + door.nx * out, z = door.z + az * along + door.nz * out;
        if (this.w.visible(x, 1, z) && this.distToPlayer({ x, z }) < 90) continue;
        c = this.spawnCriminal(x, z, Math.atan2(ax * side, az * side), {
          hp: RACKET.hp, maxHp: RACKET.hp, strength: RACKET.strength, armed: i === 0 && this.rng.chance(RACKET.batChance) ? 'bat' : 'none',
        });
      }
      if (!c) break;
      c.actor!.held = c.actor!.armed === 'bat' ? 'club_bat' : null;
      c.actor!.memo.brave = this.rng.chance(0.5) ? 1 : 0;
    }
    if (!this.criminals.length) { owner.alive = false; return false; }
    this.door = door;
    this.victim = owner;
    this.x = door.x; this.z = door.z;
    this.hot.x = door.x; this.hot.z = door.z;
    this.loot = { kind: 'cash', x: owner.x, y: owner.y, z: owner.z, owner, carrier: null, returned: false, crime: this.id };
    return true;
  }
}

