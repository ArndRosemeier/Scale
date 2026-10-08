/**
 * A sewer den's crew (underground/rooms.ts hideouts): three to five crooks hanging about a hideout
 * off the sewers — sitting round the cable-drum table, warming their hands at the fire barrel, a
 * lookout by the door. They are there when the player comes down that way (CrimeSystem posts them);
 * come into the room (or hit one) and they get up and go for the hero; outmatched, they back into a
 * corner and give up. Nobody calls the police down here. With them down, the stash can be busted
 * (E, CrimeSystem). Its people walk the underground's floors (`PedAgent.under`), never the street.
 */
import { Crime, type CrimeWorld } from './Crime';
import { setState, stand, lookAt, play, goTo, subdued } from '../../sim/actors/Actor';
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';

export const DEN = { hp: 60, strength: 1.1, alertR: 8.5, leash: 22, knifeChance: 0.25, batChance: 0.3 };

/** Where the crew hang about (world points with the point each faces), the stash, the room's middle. */
export interface DenSite {
  room: number;
  spots: { x: number; y: number; z: number; fx: number; fz: number; sit: boolean }[];
  stash: { x: number; y: number; z: number };
  cx: number; cy: number; cz: number;
}

export class SewerDen extends Crime {
  readonly kind = 'den' as const;
  readonly tier = 1;
  private confronted = false;

  constructor(w: CrimeWorld, seed: number, readonly site: DenSite) {
    super(w, seed);
  }

  setup(): boolean {
    const S = this.site;
    if (!S.spots.length) return false;
    // The lookout (the last spot) always; two to four more.
    const n = Math.min(S.spots.length, 3 + this.rng.int(0, 2));
    const picks = [S.spots.length - 1, ...S.spots.slice(0, -1).map((_, i) => i)].slice(0, n);
    for (const i of picks) {
      const sp = S.spots[i];
      const u = this.rng.float();
      const c = this.spawnCriminal(sp.x, sp.z, Math.atan2(-(sp.fx - sp.x), -(sp.fz - sp.z)), {
        hp: DEN.hp, maxHp: DEN.hp, strength: DEN.strength, armed: u < DEN.knifeChance ? 'knife' : u < DEN.knifeChance + DEN.batChance ? 'bat' : 'none',
      });
      if (!c) break;
      c.under = true;
      c.y = sp.y;
      c.heading = Math.atan2(-(sp.fx - sp.x), -(sp.fz - sp.z));
      const act = c.actor!;
      act.held = act.armed === 'bat' ? 'club_bat' : null;
      act.memo.brave = 1;
      act.memo.postX = sp.x; act.memo.postZ = sp.z;
      act.memo.faceX = sp.fx; act.memo.faceZ = sp.fz;
      act.memo.sit = sp.sit ? 1 : 0;
    }
    if (!this.criminals.length) return false;
    this.x = S.cx; this.z = S.cz;
    this.hot.x = S.cx; this.hot.z = S.cz;
    return true;
  }

  /** The player went away without a fight: the crew stay where they are (the crime ends unseen). */
  standDown(): void {
    if (this.active) this.finish('aborted');
  }

  /** Crew still on their feet in the den. */
  get standing(): number {
    return this.criminals.filter((c) => c.alive && c.actor && !subdued(c.actor) && c.actor.state !== 'gone' && c.state !== PState.Down).length;
  }

  private playerClose(c: PedAgent, r: number): boolean {
    return this.distToPlayer(c) < r && Math.abs(this.w.player.y - c.y) < 3;
  }

  protected step(dt: number): void {
    const crooks = this.criminals.filter((c) => c.alive && c.actor && c.actor.state !== 'gone');
    switch (this.phase) {
      case 'approach': {
        // Hanging about: sitting at the table, now and then a drink, a word, a shrug.
        for (const c of crooks) {
          const act = c.actor!;
          if (act.state === 'down' || c.state === PState.Down) continue;
          const px = act.memo.postX, pz = act.memo.postZ;
          if (Math.hypot(px - c.x, pz - c.z) > 0.5) { setState(act, 'walk'); goTo(act, px, pz, 1.2); continue; }
          stand(act); setState(act, 'idle');
          act.face = { x: act.memo.faceX, y: c.y + 1.2, z: act.memo.faceZ };
          act.memo.idleT = (act.memo.idleT ?? this.rng.float() * 2) - dt;
          if (act.memo.idleT < 0) {
            act.memo.idleT = 3 + this.rng.float() * 5;
            const r = this.rng.float();
            if (act.memo.sit) play(act, r < 0.25 ? 'drink' : r < 0.45 ? 'talk' : 'sit', act.memo.sit && r >= 0.45 ? 9 : 2.4);
            else play(act, r < 0.3 ? 'talk' : r < 0.45 ? 'gesture_shrug' : r < 0.6 ? 'drink' : 'talk', 2.2);
          }
        }
        if (crooks.some((c) => this.playerClose(c, DEN.alertR)) || this.playerAttacked) this.commit();
        break;
      }
      case 'commit':
      case 'escape':
      case 'subdued':
        this.defend(crooks, dt);
        // No police down here: the downed lie until the hero has gone (CrimeSystem ends it then).
        if (this.phase === 'subdued' && Math.hypot(this.w.player.x - this.site.cx, this.w.player.z - this.site.cz) < 40) this.phaseT = Math.min(this.phaseT, 60);
        break;
      default:
        break;
    }
  }

  protected ambushed(): void { this.commit(); }

  private commit(): void {
    if (this.confronted) return;
    this.confronted = true;
    this.playerInvolved = true;
    const p = this.w.player;
    for (const c of this.criminals) if (c.actor) {
      c.actor.hostile = true; c.actor.face = null; c.actor.mood = 'angry'; c.actor.action = null;
      lookAt(c.actor, p.x, p.y + 1.5, p.z);
    }
    const first = this.criminals.find((c) => c.actor);
    if (first?.actor) play(first.actor, 'gesture_point', 0.9);
    this.go('commit');
    this.emit('commit');
  }

  /** Fight in the den; outmatched, back into the far corner and give up (there is nowhere to run). */
  private defend(crooks: PedAgent[], dt: number): void {
    if (!this.confronted) return;
    const p = this.w.player, S = this.site;
    const near = Math.hypot(p.x - S.cx, p.z - S.cz) < DEN.leash && Math.abs(p.y - S.cy) < 4;
    for (const c of crooks) {
      const act = c.actor!;
      if (subdued(act) || act.state === 'down') continue;
      if (this.rethink(c, (d) => (d === 'surrender' ? 2 : d === 'flee' && act.hp < act.maxHp * 0.5 ? 0 : 1)) && act.memo.choice === 0) {
        // The spot farthest from the hero.
        let best = S.spots[0], bd = -1;
        for (const sp of S.spots) { const dd = Math.hypot(sp.x - p.x, sp.z - p.z); if (dd > bd) { bd = dd; best = sp; } }
        act.memo.postX = best.x; act.memo.postZ = best.z; act.memo.cornerT = 0;
      }
      if (act.memo.choice === 2) { if (act.state !== 'surrender') this.surrender(c); continue; }
      if (act.memo.choice === 0) {
        setState(act, 'run');
        act.memo.cornerT = (act.memo.cornerT ?? 0) + dt;
        if (Math.hypot(act.memo.postX - c.x, act.memo.postZ - c.z) > 0.5 && act.memo.cornerT < 3.5) goTo(act, act.memo.postX, act.memo.postZ, 3.8);
        else { act.memo.choice = 2; this.surrender(c); }
        continue;
      }
      if (near) this.fight(c, dt);
      else {
        // The hero backed off up the tunnel: back to the den, eyes on the door.
        const px = act.memo.postX, pz = act.memo.postZ;
        if (Math.hypot(px - c.x, pz - c.z) > 0.6) { setState(act, 'walk'); goTo(act, px, pz, 2); } else stand(act);
        lookAt(act, p.x, p.y + 1.5, p.z);
      }
    }
  }

  /** Never handed back to the street: they live down here (gone with the crime). */
  dispose(keepVictims = false): void {
    for (const c of this.criminals) if (c.actor?.state !== 'arrested') c.alive = false;
    if (!keepVictims) this.releaseVictims();
  }
}
