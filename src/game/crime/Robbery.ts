/**
 * Shop robbery, street side (tier 2). The alarm bell goes off at a shop door; two or three robbers
 * burst out (one with a bat or a knife, one with the cash bag) while the shopkeeper shouts and
 * points after them from the doorway. Sometimes a car waits at the kerb with its hazards on: they
 * pile in and it tears off. Stop the car (wreck it, freeze it, stand in its way) and they bail out
 * on foot. The leader is sometimes armed with a gun (GUNMAN): mostly a threat, aimed at whoever
 * comes close; they shoot at a player who hurts one of them and now and then at officers on their
 * heels (the police shoot back). Armed robbers in a group are dangerous for an ordinary person (the con colour shows
 * it): tactics or powers. The police come with sirens.
 */
import { Crime, CRIME_DEV, type CrimeWorld, type GetawayCar, play, setState, stand, lookAt, goTo, subdued } from './Crime';
import type { Armed } from '../../sim/actors/Actor';
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';
import { voice } from '../../ui/voices';

export const ROBBERY = { ringMin: 120, ringMax: 450, hp: 80, strength: 1.25, carChance: 0.55, alarmFor: 45, insideFor: 2.2, gunChance: 0.35 };

export class Robbery extends Crime {
  readonly kind = 'robbery' as const;
  readonly tier = 2;
  door: { x: number; z: number; nx: number; nz: number } | null = null;
  car: GetawayCar | null = null;
  shopkeeper: PedAgent | null = null;
  private alarm: { stop(): void } | null = null;
  private shoutT = 0;
  private blockedT = 0;
  private seeds: number[] = [];
  private confronted = false;
  private aboard = 0;

  constructor(w: CrimeWorld, seed: number, private near: { x: number; z: number } | null = null) {
    super(w, seed);
  }

  setup(): boolean {
    const shops = this.w.shops?.(this.near ? 0 : ROBBERY.ringMin, this.near ? 90 : ROBBERY.ringMax) ?? [];
    if (!shops.length) return false;
    const door = shops[this.rng.int(0, Math.min(shops.length, 6) - 1)];
    const n = 2 + (this.rng.chance(0.4) ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const s = this.rng.nextU32();
      this.seeds.push(s);
      // Just inside the door, side by side.
      const side = (i - (n - 1) / 2) * 0.7;
      const x = door.x - door.nx * 1.3 - door.nz * side, z = door.z - door.nz * 1.3 + door.nx * side;
      const lead: Armed = CRIME_DEV.guns || this.rng.chance(ROBBERY.gunChance) ? 'gun' : this.rng.chance(0.5) ? 'bat' : 'knife';
      const armed: Armed = i === 0 ? lead : i === 1 && this.rng.chance(0.4) ? 'knife' : 'none';
      const a = this.spawnOwned(s, x, z, Math.atan2(-door.nx, -door.nz), 'criminal');
      if (!a) break;
      Object.assign(a.actor!, { hp: ROBBERY.hp, maxHp: ROBBERY.hp, strength: ROBBERY.strength, armed, hostile: true, held: armed === 'none' ? (i === n - 1 ? 'bag' : null) : armed === 'bat' ? 'club_bat' : armed === 'gun' ? 'pistol' : 'knife' });
      a.actor!.memo.seed = s;
      a.actor!.memo.brave = armed !== 'none' ? 1 : 0;
      this.criminals.push(a);
    }
    if (this.criminals.length < 2) return false;
    this.door = door;
    this.x = door.x; this.z = door.z;
    this.hot.x = door.x; this.hot.z = door.z;
    const bagger = this.criminals[this.criminals.length - 1];
    this.loot = { kind: 'cash', x: door.x, y: bagger.y, z: door.z, owner: null, carrier: bagger, returned: false, crime: this.id };
    if (this.rng.chance(ROBBERY.carChance)) this.car = this.w.getaway?.(door.x + door.nx * 5, door.z + door.nz * 5) ?? null;
    this.commit();
    return true;
  }

  private commit(): void {
    const d = this.door!;
    this.alarm = this.w.loop?.('alarm_bell', d.x, 3, d.z, 0.9) ?? null;
    this.w.emit('alarm', d.x, 2.5, d.z, 3, 70);
    this.w.sound('glass_shatter', d.x, 1.5, d.z, 0.6);
    if (!this.policeCalled) { this.policeCalled = true; this.w.callPolice(this, 8); }
    this.go('commit');
    this.emit('commit');
  }

  protected step(dt: number): void {
    const d = this.door!;
    const crooks = this.criminals.filter((c) => c.alive && c.actor && c.actor.state !== 'gone');
    if (this.alarm && (this.t > ROBBERY.alarmFor || !this.active)) { this.alarm.stop(); this.alarm = null; }
    this.shopkeeperStaging(dt);
    switch (this.phase) {
      case 'commit': {
        // Inside a moment (the alarm rings), then out of the door.
        for (const c of crooks) { stand(c.actor!); setState(c.actor!, 'idle'); }
        if (this.phaseT > ROBBERY.insideFor) {
          crooks.forEach((c, i) => {
            const act = c.actor!;
            setState(act, 'run');
            act.memo.panic = 6;
            // First out of the door, then (with a car) to the car, else split up.
            goTo(act, d.x + d.nx * 3 + d.nz * (i - 1) * 1.5, d.z + d.nz * 3 - d.nx * (i - 1) * 1.5, 4.8);
            act.memo.out = 0;
          });
          this.go('escape');
        }
        break;
      }
      case 'escape':
      case 'subdued': {
        if (this.reactToPlayer(crooks, dt)) break;
        for (const c of crooks) {
          const act = c.actor!;
          if (subdued(act) || act.state === 'down') continue;
          if (!act.memo.out) {
            // Through the door first.
            if (Math.hypot(c.x - d.x, c.z - d.z) > 2.6 || this.phaseT > 2) act.memo.out = 1;
            else continue;
          }
          if (this.car && this.car.alive && !this.car.disabled && !act.memo.bailed) {
            const dc = Math.hypot(this.car.x - c.x, this.car.z - c.z);
            if (dc < 2.4) { this.board(c); continue; }
            goTo(act, this.car.x, this.car.z, 5);
            setState(act, 'run');
            act.face = null;
          } else if (act.state === 'fight') this.fight(c, dt);
          else this.flee(c, dt);
        }
        // Everyone still free is in the car: off it goes.
        if (this.car && this.aboard > 0 && crooks.every((c) => c.actor!.memo.inCar || subdued(c.actor!))) {
          this.car.drive(this.w.player.x, this.w.player.z);
          this.go('getaway');
        }
        break;
      }
      case 'getaway': {
        const car = this.car!;
        const pd = Math.hypot(car.x - this.w.player.x, car.z - this.w.player.z);
        this.hot.x = car.x; this.hot.z = car.z;
        // Blocked by the player standing in the way, or disabled: they bail out.
        this.blockedT = car.speed < 0.6 && pd < 12 ? this.blockedT + dt : 0;
        if (!car.alive || car.disabled || this.blockedT > 3.5) { this.bail(); break; }
        if (pd > 340 || (this.phaseT > 70 && pd > 120 && !this.w.visible(car.x, 1, car.z))) {
          for (const c of this.criminals) if (c.actor?.memo.inCar) { c.actor.memo.escaped = 1; setState(c.actor, 'gone'); }
          car.release();
          this.finish('escaped');
        }
        break;
      }
      default:
        break;
    }
  }

  /** A robber gets in (the body leaves the street; the car carries them). */
  private board(c: PedAgent): void {
    const act = c.actor!;
    act.memo.inCar = 1;
    setState(act, 'gone');
    c.alive = false;
    this.aboard++;
    this.car?.hold();
    this.w.sound('door_close', c.x, 1, c.z, 0.7);
    if (this.loot?.carrier === c) this.loot.carrier = null, this.loot.x = NaN;
  }

  /** Out of the stopped car, on foot (the armed ones turn to fight). */
  private bail(): void {
    const car = this.car!;
    const list = this.criminals.slice();
    let k = 0;
    for (const c of list) {
      const act = c.actor;
      if (!act?.memo.inCar) continue;
      const s = act.memo.seed;
      const ang = k * 2.1 + 0.6;
      const a = this.spawnOwned(s, car.x + Math.cos(ang) * 1.9, car.z + Math.sin(ang) * 1.9, ang, 'criminal');
      if (!a) continue;
      Object.assign(a.actor!, { hp: act.hp, maxHp: act.maxHp, strength: act.strength, armed: act.armed, hostile: true, held: act.held, memo: { seed: s, bailed: 1, out: 1, panic: 5, brave: act.memo.brave ?? 0 } });
      setState(a.actor!, 'run');
      // The cash comes out with the one who had it.
      if (this.loot && Number.isNaN(this.loot.x) && k === 0) { this.loot.carrier = a; this.loot.x = a.x; }
      this.criminals[this.criminals.indexOf(c)] = a;
      this.w.sound('door_open', a.x, 1, a.z, 0.7);
      k++;
    }
    car.release();
    this.car = null;
    this.aboard = 0;
    this.go('escape');
  }

  private reactToPlayer(crooks: PedAgent[], dt: number): boolean {
    const close = crooks.some((c) => !c.actor!.memo.inCar && this.distToPlayer(c) < 16);
    if (!close && !this.confronted) return false;
    if (close && !this.confronted) { this.confronted = true; this.playerInvolved = true; }
    for (const c of crooks) {
      const act = c.actor!;
      if (subdued(act) || act.state === 'down' || act.memo.inCar) continue;
      this.rethink(c);
      if (act.memo.choice === 2) { if (act.state !== 'surrender') this.surrender(c); continue; }
      if (act.memo.choice === 1 && this.distToPlayer(c) < 25) this.fight(c, dt);
      else if (this.car && this.car.alive && !this.car.disabled && !act.memo.bailed && Math.hypot(this.car.x - c.x, this.car.z - c.z) < 40) {
        if (Math.hypot(this.car.x - c.x, this.car.z - c.z) < 2.4) this.board(c);
        else { goTo(act, this.car.x, this.car.z, 5); setState(act, 'run'); }
      } else { act.memo.panic = 4; this.flee(c, dt); }
    }
    if (this.car && this.aboard > 0 && crooks.every((c) => c.actor!.memo.inCar || subdued(c.actor!))) { this.car.drive(this.w.player.x, this.w.player.z); this.go('getaway'); }
    return true;
  }

  /** The shopkeeper in the doorway: shouts and points after the robbers (or the car). */
  private shopkeeperStaging(dt: number): void {
    const d = this.door!;
    if (!this.shopkeeper && this.t > ROBBERY.insideFor + 1.2 && this.t < 50 && this.active) {
      const a = this.spawnOwned(this.rng.nextU32(), d.x + d.nx * 0.6, d.z + d.nz * 0.6, Math.atan2(-d.nx, -d.nz) + Math.PI, 'shopkeeper');
      if (a) { this.shopkeeper = a; Object.assign(a.actor!, { role: 'shopkeeper', hp: 40, maxHp: 40, strength: 0.6, mood: 'angry', held: null }); this.extras.push(a); }
    }
    const s = this.shopkeeper;
    if (!s || !s.alive || !s.actor) return;
    const act = s.actor;
    if (s.state === PState.Down) return;
    stand(act);
    const target = this.phase === 'getaway' && this.car ? { x: this.car.x, y: 1, z: this.car.z } : this.criminals.find((c) => c.alive && c.actor && c.actor.state !== 'gone');
    if (target && this.active) {
      lookAt(act, target.x, (target.y ?? 0) + 1.2, target.z);
      setState(act, 'point');
      if (!act.action || act.action.id !== 'gesture_point') play(act, 'gesture_point', 2.2);
      this.shoutT -= dt;
      if (this.shoutT <= 0 && this.t < 40) {
        this.shoutT = 2.6 + this.rng.float() * 1.8;
        voice(s, 'stop');
        this.w.emit('cry', s.x, s.y + 1.6, s.z, 1.2, 35);
      }
    } else {
      act.mood = this.loot?.returned ? 'happy' : 'sad';
      if (this.distToPlayer(s) < 12) lookAt(act, this.w.player.x, this.w.player.y + 1.5, this.w.player.z);
      if (this.loot?.returned && act.state !== 'cheer') { setState(act, 'cheer'); play(act, 'cheer', 2.6); }
    }
  }

  dispose(keepVictims = false): void {
    this.alarm?.stop();
    this.alarm = null;
    this.car?.release();
    super.dispose(keepVictims);
  }
}
