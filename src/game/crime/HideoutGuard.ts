/**
 * Hideout guards (VILLAINS_PLAN §3.1, Phase 2): two or three members of a group loiter at the door of
 * its hideout — hands in pockets, eyes on the street. They are there when the player comes by
 * (factions/Hideouts places the hideout, CrimeSystem puts the guards there); come close and they
 * square up, weigh the hero up (fight, run, give up) and defend the door. With them out of the way
 * the stash inside can be busted (E at the door, CrimeSystem).
 */
import { Crime, type CrimeWorld, setState, stand, lookAt, play, goTo, subdued } from './Crime';
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';

export const HIDEOUT = { hp: 65, strength: 1.15, alertR: 16, leash: 40, gunChance: 0.2 };

export interface Door { x: number; z: number; nx: number; nz: number }

export class HideoutGuard extends Crime {
  readonly kind = 'hideout' as const;
  readonly tier = 1;
  private confronted = false;

  constructor(w: CrimeWorld, seed: number, readonly door: Door) {
    super(w, seed);
  }

  setup(): boolean {
    const D = this.door, ax = -D.nz, az = D.nx;
    const n = this.rng.chance(0.5) ? 3 : 2;
    for (let i = 0; i < n; i++) {
      // Either side of the door, a step out on the pavement.
      const along = (i % 2 ? 1 : -1) * (1.6 + Math.floor(i / 2) * 1.4 + this.rng.float() * 0.6), out = 1.4 + this.rng.float() * 1.2;
      const x = D.x + ax * along + D.nx * out, z = D.z + az * along + D.nz * out;
      const u = this.rng.float();
      const c = this.spawnCriminal(x, z, Math.atan2(-D.nx, -D.nz) + Math.PI + (this.rng.float() - 0.5) * 1.2, {
        hp: HIDEOUT.hp, maxHp: HIDEOUT.hp, strength: HIDEOUT.strength, armed: u < HIDEOUT.gunChance ? 'gun' : u < 0.5 ? 'bat' : 'none',
      });
      if (!c) break;
      const act = c.actor!;
      act.held = act.armed === 'bat' ? 'club_bat' : null;
      act.memo.brave = 1;
      act.memo.postX = x; act.memo.postZ = z;
    }
    if (!this.criminals.length) return false;
    this.x = D.x; this.z = D.z;
    this.hot.x = D.x; this.hot.z = D.z;
    return true;
  }

  /** The player has gone: the guards go back inside (the crime ends without a result). */
  standDown(): void {
    if (this.active) this.finish('aborted');
  }

  /** Guards still standing at (or defending) the door. */
  get guarding(): number {
    return this.criminals.filter((c) => c.alive && c.actor && !subdued(c.actor) && c.actor.state !== 'gone' && Math.hypot(c.x - this.door.x, c.z - this.door.z) < 15).length;
  }

  protected step(dt: number): void {
    const crooks = this.criminals.filter((c) => c.alive && c.actor && c.actor.state !== 'gone');
    switch (this.phase) {
      case 'approach': {
        // On watch: at their posts, glancing up and down the street.
        for (const c of crooks) {
          const act = c.actor!;
          if (act.state === 'down' || c.state === PState.Down) continue;
          const px = act.memo.postX, pz = act.memo.postZ;
          if (Math.hypot(px - c.x, pz - c.z) > 0.6) { setState(act, 'walk'); goTo(act, px, pz, 1.3); } else { stand(act); setState(act, 'idle'); }
          act.memo.glanceT = (act.memo.glanceT ?? this.rng.float() * 3) - dt;
          if (act.memo.glanceT < 0) {
            act.memo.glanceT = 2.5 + this.rng.float() * 4;
            const a = this.rng.float() * Math.PI * 2;
            act.face = { x: c.x + Math.sin(a) * 10 + this.door.nx * 8, y: c.y + 1.5, z: c.z + Math.cos(a) * 10 + this.door.nz * 8 };
          }
        }
        if (crooks.some((c) => this.distToPlayer(c) < HIDEOUT.alertR && this.w.player.y - c.y < 12) || this.playerAttacked) this.commit();
        break;
      }
      case 'commit':
      case 'escape':
      case 'subdued': {
        this.defend(crooks, dt);
        break;
      }
      default:
        break;
    }
  }

  private commit(): void {
    this.confronted = true;
    this.playerInvolved = true;
    for (const c of this.criminals) if (c.actor) { c.actor.hostile = true; c.actor.face = null; c.actor.mood = 'angry'; }
    const p = this.w.player;
    for (const c of this.criminals) if (c.actor) { lookAt(c.actor, p.x, p.y + 1.5, p.z); play(c.actor, 'gesture_point', 0.9); }
    this.go('commit');
    this.emit('commit');
  }

  /** Each guard decides once per blow taken: fight (near the door), run, or give up. */
  private defend(crooks: PedAgent[], dt: number): void {
    if (!this.confronted) return;
    for (const c of crooks) {
      const act = c.actor!;
      if (subdued(act) || act.state === 'down') continue;
      if (act.memo.decHp !== act.hp) {
        act.memo.decHp = act.hp;
        const d = this.decide(c);
        // They defend their own door: they fight unless clearly outmatched.
        act.memo.choice = d === 'surrender' ? 2 : d === 'flee' && act.hp < act.maxHp * 0.5 ? 0 : 1;
        if (act.memo.choice === 1) this.emit('fight', c);
      }
      if (act.memo.choice === 2) { if (act.state !== 'surrender') this.surrender(c); continue; }
      const nearDoor = Math.hypot(this.w.player.x - this.door.x, this.w.player.z - this.door.z) < HIDEOUT.leash;
      if (act.memo.choice === 1 && nearDoor) this.fight(c, dt);
      else if (act.memo.choice === 1) {
        // The player backed off: back to the door, eyes on them.
        const px = act.memo.postX, pz = act.memo.postZ;
        if (Math.hypot(px - c.x, pz - c.z) > 0.6) { setState(act, 'walk'); goTo(act, px, pz, 2); } else stand(act);
        lookAt(act, this.w.player.x, this.w.player.y + 1.5, this.w.player.z);
      } else { act.memo.panic = 4; this.flee(c, dt); }
    }
  }
}
