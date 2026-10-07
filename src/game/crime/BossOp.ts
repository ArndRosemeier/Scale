/**
 * A boss operation (VILLAINS_PLAN §3.5, Phase 4): the group's named boss comes out with a big crew
 * for one of its set pieces, and the city answers it as a threat event — perimeter, evacuation,
 * SWAT (threats/BossEvent hands it to the response). One per group archetype:
 *
 *   heist      the Syndicate takes a bank (the tallest shop front about): two safecrackers drill
 *              the vault door, gunmen hold the pavement, the Chairman directs; done, they make
 *              off with the cash (the boss carries it: catch them and it can go back)
 *   takeover   the gang storms a block: wreckers smash up the street round a burning barrel,
 *              the crew holds it; done, cars burn and the street is theirs
 *   uprising   the techno-cult's Architect jacks into the city's robots: hackers at the port,
 *              guards round them; done, a whole fleet of machines turns on the street
 *   awakening  the elemental cult chants in a great circle before a landmark (the cathedral
 *              first): done, its element bursts and something stirs (the threat clock moves)
 *   treewake   the eco-radicals' Elder sings a street or park tree awake, a circle round it, the
 *              Beast-master's dogs at the guard: done, the tree tears itself out of the ground and
 *              walks (threats/AwakenedTree, a major threat event of its own)
 *   deadrise   the necromancers' Grave Lord raises the old dead before the cathedral (or in a
 *              park): skeletons claw out of the ground while the circle chants and guard it;
 *              done, a last burst of bones and the risen band roams the street
 *
 * Unlike a small channelled operation, the work does not stop when the hero walks up: the crew
 * fights to hold the site while the workers carry on. To stop it, take the workers out (every
 * one of them down, or driven off) or beat the boss — with the boss down the rest lose heart and
 * run or give up. Left alone it finishes after `workFor` seconds.
 *
 * Every member is a real person (criminal actors, the group's colours and titles from
 * CrimeSystem.enlist, the boss promoted there); the world does the effects (`opFx`, `bossOpDone`).
 */
import { Crime, type CrimeWorld, type BossOpKind, type OpLook, setState, stand, lookAt, goTo, subdued } from './Crime';
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';
import { hold } from '../../sim/actors/Actor';

export interface BossOpSpec {
  /** Seconds of work to finish (the response escalates meanwhile). */
  workFor: number;
  /** Workers at the site and guards round it (the boss comes on top). */
  workers: number;
  guards: [number, number];
  /** Share of the guards with a gun (else a bat or bare hands). */
  guns: number;
  /** The look of the work (CrimeWorld.opFx). */
  look: OpLook;
  /** Hands raised to the sky (a chant) or at waist height (a drill, a hack, a hammer). */
  high: boolean;
  /** Where the workers stand: at the door / port (a line across it), spread along the street, in a circle. */
  layout: 'door' | 'street' | 'circle';
  /** Members' health and strength (before a lieutenant's or the boss's promotion). */
  hp: number;
  strength: number;
  /** Lieutenants among the guards (their group's powers). */
  lieutenants: number;
  /** A sound every few seconds of the work, its pitch. */
  sound: string;
  pitch: number;
  /** Skeletons that claw out of the ground during the work (the necromancers), on top of the guards. */
  rise?: number;
}

export const BOSS_OP_SPECS: Record<BossOpKind, BossOpSpec> = {
  heist: { workFor: 95, workers: 2, guards: [4, 5], guns: 0.6, look: 'drill', high: false, layout: 'door', hp: 60, strength: 1.05, lieutenants: 1, sound: 'metal_bend', pitch: 1.6 },
  takeover: { workFor: 80, workers: 3, guards: [4, 6], guns: 0.15, look: 'riot', high: false, layout: 'street', hp: 62, strength: 1.1, lieutenants: 1, sound: 'punch_impact', pitch: 0.7 },
  uprising: { workFor: 85, workers: 2, guards: [4, 5], guns: 0, look: 'hack', high: false, layout: 'door', hp: 58, strength: 1, lieutenants: 1, sound: 'robot_glitch', pitch: 1.2 },
  awakening: { workFor: 90, workers: 6, guards: [2, 3], guns: 0, look: 'fire', high: true, layout: 'circle', hp: 55, strength: 0.95, lieutenants: 1, sound: 'deep_glow', pitch: 0.6 },
  treewake: { workFor: 85, workers: 4, guards: [3, 4], guns: 0, look: 'grove', high: true, layout: 'circle', hp: 56, strength: 1, lieutenants: 1, sound: 'grow_rumble', pitch: 0.8 },
  deadrise: { workFor: 90, workers: 4, guards: [1, 2], guns: 0, look: 'grave', high: true, layout: 'circle', hp: 52, strength: 0.95, lieutenants: 1, sound: 'deep_murk', pitch: 0.7, rise: 6 },
};

export const BOSS_OP = {
  /** Sites in a ring around the player (m). */
  ringMin: 70, ringMax: 260,
  /** Seconds to get there (then it starts with whoever is at their post), and the wait for stragglers. */
  approachTimeout: 100, stragglers: 30,
  /** The crew fights the hero within this of the site (or once any of them is hit). */
  guardR: 32,
  /** A worker stops when the hero is this close to them (or hits them). */
  workerR: 2.4,
  /** A guard who chased the hero this far from the site goes back to their post. */
  leash: 45,
  /** The circle's radius (awakening) and the drill / hack line's half width (m). */
  circle: 3.4,
  /** Where the dead rise: a ring round the site (m). */
  riseR: [6, 11] as [number, number],
  /** Seconds between two sounds of the work. */
  soundEvery: 3.2,
};

/** What the operation is called on the map and compass, by kind. */
export const BOSS_OP_TITLE: Record<BossOpKind, string> = {
  heist: 'Heist — a crew is cracking a vault',
  takeover: 'Gang takeover — a crew is smashing up the street',
  uprising: 'Machine uprising — hackers are taking over the robots',
  awakening: 'Great ritual — a circle chanting before a landmark',
  treewake: 'Tree waking — a circle singing a tree awake',
  deadrise: 'The dead rise — skeletons clawing out of the ground',
};

export class BossOperation extends Crime {
  readonly tier = 3;
  /** Where the work happens (the vault door, the circle's centre, the robot's port) and the way out. */
  site: { x: number; z: number; nx: number; nz: number } | null = null;
  /** Which landmark the circle stands before (awakening), if any. */
  landmark: string | null = null;
  readonly spec: BossOpSpec;
  /** Seconds of work done. */
  progress = 0;
  /** Finished (the world's effect happened). */
  done = false;
  /** The boss went down (or was cuffed, or got away early): the crew broke. */
  broken = false;
  /** The hero took them on (the guards fight). */
  engaged = false;
  /** The cult's element (CrimeSystem sets it from the group's colours). */
  element: 'fire' | 'frost' | 'storm' = 'fire';
  private soundT = 0;
  /** Skeletons raised so far (deadrise). */
  risen = 0;

  constructor(w: CrimeWorld, seed: number, readonly kind: BossOpKind, private near: { x: number; z: number } | null = null) {
    super(w, seed);
    this.spec = BOSS_OP_SPECS[kind];
  }

  get share(): number { return Math.min(1, this.progress / this.spec.workFor); }

  /** The boss (always the first member: CrimeSystem promotes them). */
  get boss(): PedAgent | null { return this.criminals[0] ?? null; }

  /** The workers still at it (not down, not giving up, not driven off). */
  workers(): PedAgent[] {
    return this.criminals.filter((c) => c.alive && c.actor && c.actor.memo.work && !c.actor.memo.quit && !subdued(c.actor) && c.actor.state !== 'down' && c.actor.state !== 'gone' && c.state !== PState.Down);
  }

  /** People of the crew still standing (not down, not giving up, not gone). */
  standing(): PedAgent[] {
    return this.criminals.filter((c) => c.alive && c.actor && !subdued(c.actor) && c.actor.state !== 'gone' && c.state !== PState.Down);
  }

  get look(): OpLook { return this.kind === 'awakening' ? this.element : this.spec.look; }

  /** Members raised from the dead (deadrise). */
  get skeletons(): PedAgent[] { return this.criminals.filter((c) => c.actor?.memo.skel); }

  setup(): boolean {
    const s = this.pickSite();
    if (!s) return false;
    this.site = { x: s.x, z: s.z, nx: s.nx, nz: s.nz };
    this.landmark = s.kind ?? null;
    this.x = s.x; this.z = s.z;
    this.hot.x = s.x; this.hot.z = s.z;
    const S = this.site, ax = -S.nz, az = S.nx;
    const from = Math.atan2(S.nx, S.nz) + (this.rng.float() - 0.5) * 1.2;
    const P = this.spec;
    // The boss first (CrimeSystem promotes the first member): out front, overseeing the work.
    // (A circle's leader stands in its middle, in the column; before the trunk of a tree.)
    const bossAt = this.kind === 'treewake' ? { x: S.x + S.nx * 1.8, z: S.z + S.nz * 1.8 } : P.layout === 'circle' ? { x: S.x, z: S.z } : { x: S.x + S.nx * 3.2, z: S.z + S.nz * 3.2 };
    if (!this.member(bossAt.x, bossAt.z, from, 'boss', 0)) return false;
    // The workers.
    for (let i = 0; i < P.workers; i++) {
      let px: number, pz: number;
      if (P.layout === 'circle') {
        const a = (i / P.workers) * Math.PI * 2;
        px = S.x + Math.sin(a) * BOSS_OP.circle; pz = S.z + Math.cos(a) * BOSS_OP.circle;
      } else if (P.layout === 'street') {
        const u = (i - (P.workers - 1) / 2) * 5;
        px = S.x + S.nx * 3 + ax * u; pz = S.z + S.nz * 3 + az * u;
      } else {
        const side = i % 2 ? -1 : 1, row = Math.floor(i / 2);
        px = S.x + S.nx * (0.7 + row * 0.9) + ax * side * 0.8; pz = S.z + S.nz * (0.7 + row * 0.9) + az * side * 0.8;
      }
      this.member(px, pz, from, 'work', i + 1);
    }
    // The guards: an arc out in the street, facing it.
    const nG = this.rng.int(P.guards[0], P.guards[1]);
    for (let i = 0; i < nG; i++) {
      const a = ((i + 0.5) / nG - 0.5) * Math.PI * 0.95, r = 8 + this.rng.float() * 2.5;
      const dx = S.nx * Math.cos(a) + ax * Math.sin(a), dz = S.nz * Math.cos(a) + az * Math.sin(a);
      const g = this.member(S.x + dx * r, S.z + dz * r, from, 'guard', 1 + P.workers + i);
      if (g && i < P.lieutenants) g.actor!.memo.ltSlot = 1;
    }
    return this.criminals.length >= 3 && this.criminals.some((c) => c.actor?.memo.work);
  }

  private pickSite(): { x: number; z: number; nx: number; nz: number; kind?: string } | null {
    const w = this.w, rMin = this.near ? 0 : BOSS_OP.ringMin, rMax = this.near ? 120 : BOSS_OP.ringMax;
    const pick = <T>(l: T[]): T | null => (l.length ? l[this.rng.int(0, Math.min(l.length, 3) - 1)] : null);
    const shops = () => (w.shops?.(rMin, rMax) ?? []).map((s) => ({ x: s.x + s.nx * 0.8, z: s.z + s.nz * 0.8, nx: s.nx, nz: s.nz }));
    switch (this.kind) {
      case 'heist': return pick((w.banks?.(rMin, rMax) ?? []).map((s) => ({ x: s.x + s.nx * 0.8, z: s.z + s.nz * 0.8, nx: s.nx, nz: s.nz }))) ?? pick(shops());
      case 'uprising': return pick(w.machines?.(rMin, rMax) ?? []) ?? pick(shops());
      case 'awakening': {
        const lm = w.landmarks?.(rMin, rMax + 140) ?? [];
        // Before the cathedral if there is one about, else the grandest old place.
        const rank = (k?: string) => (k === 'cathedral' ? 0 : k === 'townhall' ? 1 : k === 'museum' || k === 'monument' || k === 'fortress' ? 2 : 3);
        lm.sort((a, b) => rank(a.kind) - rank(b.kind));
        if (lm.length) return lm[0];
        return pick((w.walls?.(rMin, rMax) ?? []).map((s) => ({ x: s.x + s.nx * 5, z: s.z + s.nz * 5, nx: s.nx, nz: s.nz })));
      }
      case 'takeover': return pick((w.walls?.(rMin, rMax) ?? []).map((s) => ({ x: s.x + s.nx * 0.8, z: s.z + s.nz * 0.8, nx: s.nx, nz: s.nz }))) ?? pick(shops());
      // A real tree of the street or the park (the bigger the better).
      case 'treewake': {
        const t = (w.trees?.(rMin, rMax) ?? []).slice(0, 8).sort((a, b) => b.height - a.height);
        return t.length ? { x: t[0].x, z: t[0].z, nx: t[0].nx, nz: t[0].nz, kind: 'tree' } : null;
      }
      // Before the cathedral (its crypts), else another old place, else the open ground among trees.
      case 'deadrise': {
        const lm = (w.landmarks?.(rMin, rMax + 140) ?? []).filter((l) => l.kind === 'cathedral' || l.kind === 'townhall' || l.kind === 'monument' || l.kind === 'fortress' || l.kind === 'museum');
        lm.sort((a, b) => (a.kind === 'cathedral' ? 0 : 1) - (b.kind === 'cathedral' ? 0 : 1));
        if (lm.length) return lm[0];
        return pick((w.trees?.(rMin, rMax) ?? []).map((t) => ({ x: t.x + t.nx * 7, z: t.z + t.nz * 7, nx: t.nx, nz: t.nz })));
      }
    }
  }

  /** A member walking in from out of view towards their post. */
  private member(px: number, pz: number, from: number, role: 'boss' | 'work' | 'guard', i: number): PedAgent | null {
    const S = this.site!, P = this.spec;
    let c: PedAgent | null = null;
    for (let k = 0; k < 10 && !c; k++) {
      const ang = from + (k - 4) * 0.33 + (i % 3) * 0.12, r = 30 + k * 4 + (i % 4) * 2;
      const x = S.x + Math.sin(ang) * r, z = S.z + Math.cos(ang) * r;
      if (this.w.visible(x, 1, z) && this.distToPlayer({ x, z }) < 90) continue;
      const u = this.rng.float();
      const armed = role !== 'guard' ? 'none' : u < P.guns ? 'gun' : u < P.guns + (1 - P.guns) * 0.5 ? 'bat' : 'none';
      c = this.spawnCriminal(x, z, Math.atan2(x - S.x, z - S.z), { hp: P.hp, maxHp: P.hp, strength: P.strength * (0.9 + this.rng.float() * 0.25), armed });
    }
    if (!c) return null;
    const act = c.actor!;
    act.held = act.armed === 'bat' ? 'club_bat' : null;
    act.memo.postX = px; act.memo.postZ = pz;
    act.memo.work = role === 'work' ? 1 : 0;
    act.memo.brave = role === 'work' ? 0 : 1;
    act.memo.role = i;
    if (role === 'guard') act.memo.guard = 1;
    return c;
  }

  protected step(dt: number): void {
    const S = this.site!;
    const crooks = this.criminals.filter((c) => c.alive && c.actor && c.actor.state !== 'gone');
    switch (this.phase) {
      case 'approach': {
        if (!crooks.length || this.phaseT > BOSS_OP.approachTimeout) { this.abort(); return; }
        let there = 0;
        for (const c of crooks) {
          const act = c.actor!;
          if (Math.hypot(act.memo.postX - c.x, act.memo.postZ - c.z) < 0.7) { there++; stand(act); continue; }
          setState(act, 'walk');
          goTo(act, act.memo.postX, act.memo.postZ, 1.6);
        }
        const atWork = crooks.filter((c) => c.actor!.memo.work && Math.hypot(c.actor!.memo.postX - c.x, c.actor!.memo.postZ - c.z) < 0.7).length;
        if (there === crooks.length || (this.phaseT > BOSS_OP.stragglers && atWork >= Math.min(2, this.spec.workers))) this.begin();
        break;
      }
      case 'commit': this.siege(crooks, dt); break;
      case 'escape':
      case 'subdued': {
        for (const c of crooks) {
          const act = c.actor!;
          if (subdued(act) || act.state === 'down') continue;
          // Done: they make off with it (they turn on a hero right on them).
          this.weighUp(c, dt, !this.done || this.distToPlayer(c) < 12);
        }
        break;
      }
      default: break;
    }
  }

  private begin(): void {
    for (const c of this.criminals) if (c.actor) c.actor.hostile = true;
    if (!this.policeCalled) { this.policeCalled = true; this.w.callPolice(this, 25); }
    this.go('commit');
    this.emit('commit');
  }

  /** The work goes on while the crew holds the site; the hero is fought off; the boss down breaks it. */
  private siege(crooks: PedAgent[], dt: number): void {
    const S = this.site!, p = this.w.player;
    const boss = this.boss;
    // The boss down, cuffed or gone: the crew breaks.
    if (!boss || !boss.alive || !boss.actor || subdued(boss.actor) || boss.actor.state === 'gone' || boss.actor.state === 'ko') { this.breakUp(); return; }
    if (!this.engaged && (this.distToPlayer(S) < BOSS_OP.guardR || this.playerAttacked)) { this.engaged = true; this.playerInvolved = true; this.emit('fight'); }
    for (const c of crooks) {
      const act = c.actor!;
      if (subdued(act) || act.state === 'down' || c.state === PState.Down) continue;
      if (act.memo.work && !act.memo.quit) {
        // A worker quits when the hero is on them (or has hit them): then they weigh it up.
        if (act.hitByPlayer || this.distToPlayer(c) < BOSS_OP.workerR) { act.memo.quit = 1; if (act.action?.id === 'channel') act.action = null; act.face = null; }
        else { this.work(c); continue; }
      }
      if (act.memo.quit) { this.weighUp(c, dt, true); continue; }
      // Guards and the boss: hold the post until the hero comes; then fight (back to the post when led too far off).
      const off = Math.hypot(c.x - S.x, c.z - S.z);
      if (this.engaged && !(off > BOSS_OP.leash && this.distToPlayer(S) > BOSS_OP.guardR + 10)) { this.weighUp(c, dt, true); continue; }
      if (act.action?.id === 'aim_pistol' && !this.engaged) act.action = null;
      if (Math.hypot(act.memo.postX - c.x, act.memo.postZ - c.z) > 0.8) { setState(act, 'walk'); goTo(act, act.memo.postX, act.memo.postZ, 2.4); continue; }
      stand(act);
      setState(act, 'idle');
      if (this.distToPlayer(c) < 70) lookAt(act, p.x, p.y + 1.5, p.z);
      else lookAt(act, S.x + S.nx * 30, c.y + 1.5, S.z + S.nz * 30);
    }
    const workers = this.workers();
    if (workers.length) {
      let working = 0;
      for (const c of workers) if (c.actor!.staggerT <= 0) working++;
      if (working) { this.progress += dt * Math.min(1, 0.4 + 0.6 * working / Math.max(1, this.spec.workers)); this.sound(dt); }
    }
    this.w.opFx?.(this.look, S.x, S.z, this.share, workers);
    // The dead rise as the work goes on (one by one, the last before it is done).
    const rise = this.spec.rise ?? 0;
    if (rise && workers.length && (this.risen < Math.min(rise, Math.floor(this.share * (rise + 1))) || (this.risen < rise && this.share > 0.92))) this.raiseOne();
    if (this.progress >= this.spec.workFor) { this.complete(); return; }
    // Every worker out of it: the work cannot be finished; the rest fight on or run.
    if (!workers.length) { this.go('escape'); }
  }

  /** A skeleton claws its way out of the ground somewhere round the site, and guards it. */
  private raiseOne(): void {
    const S = this.site!, k = this.risen++;
    for (let tries = 0; tries < 6; tries++) {
      const a = this.rng.float() * Math.PI * 2, r = BOSS_OP.riseR[0] + this.rng.float() * (BOSS_OP.riseR[1] - BOSS_OP.riseR[0]);
      const x = S.x + Math.sin(a) * r, z = S.z + Math.cos(a) * r;
      if (this.w.blocked?.(x, z)) continue;
      const c = this.raiseDead(x, z, Math.atan2(x - S.x, z - S.z));
      if (!c) return;
      const act = c.actor!;
      act.memo.postX = x; act.memo.postZ = z; act.memo.guard = 1; act.memo.role = 100 + k;
      // They come for the hero at once if they are about.
      act.hostile = true;
      return;
    }
  }

  /** A worker at it: at their post, facing the work, hands busy. */
  private work(c: PedAgent): void {
    const act = c.actor!, S = this.site!;
    if (Math.hypot(act.memo.postX - c.x, act.memo.postZ - c.z) > 0.7) { setState(act, 'walk'); goTo(act, act.memo.postX, act.memo.postZ, 2); return; }
    stand(act);
    setState(act, 'idle');
    lookAt(act, S.x, c.y + (this.spec.high ? 1.8 : 0.7), S.z);
    act.mood = 'focused';
    if (!act.action || act.action.id !== 'channel') hold(act, 'channel', 2);
  }

  private sound(dt: number): void {
    this.soundT -= dt;
    if (this.soundT > 0) return;
    this.soundT = BOSS_OP.soundEvery * (0.7 + this.rng.float() * 0.6);
    const S = this.site!;
    this.w.sound(this.spec.sound, S.x, this.spec.high ? 2 : 0.8, S.z, 0.45 + this.share * 0.4, this.spec.pitch + this.share * 0.3);
  }

  /** Fight or flight for one of them (re-weighed whenever their health changes). */
  private weighUp(c: PedAgent, dt: number, hot: boolean): void {
    const act = c.actor!;
    // A guard who backed off (the hero was down for a moment) looks again every couple of seconds.
    act.memo.reT = (act.memo.reT ?? 2) - dt;
    if (act.memo.reT <= 0) { act.memo.reT = 2; if (act.memo.choice === 0 && act.memo.brave && !this.broken && !this.w.player.down) act.memo.decided = 0; }
    if (act.memo.decHp !== act.hp || act.memo.decided !== 1) {
      act.memo.decHp = act.hp;
      act.memo.decided = 1;
      const d = this.decide(c);
      // Done and the hero not about: they all make off with it.
      act.memo.choice = d === 'surrender' ? 2 : (d === 'fight' || (act.memo.brave && act.hp > act.maxHp * 0.5 && !this.broken)) && hot ? 1 : 0;
      if (act.memo.choice === 1) this.emit('fight', c);
    }
    if (act.memo.choice === 2) { if (act.state !== 'surrender') this.surrender(c); return; }
    if (act.memo.choice === 1 && this.distToPlayer(c) < 30) this.fight(c, dt);
    else { act.memo.panic = Math.max(act.memo.panic ?? 0, 2); this.flee(c, dt); }
  }

  /** The work is done: the world's effect, then they make off. */
  private complete(): void {
    this.done = true;
    const S = this.site!;
    for (const c of this.criminals) { const act = c.actor; if (!act) continue; if (act.action?.id === 'channel') act.action = null; act.face = null; act.memo.calm = 1; act.memo.decided = 0; }
    // The Syndicate's take: the boss carries it (catch them and it goes back).
    const b = this.boss;
    if (this.kind === 'heist' && b?.alive && b.actor && !subdued(b.actor)) {
      this.loot = { kind: 'cash', x: b.x, y: b.y, z: b.z, owner: null, carrier: b, returned: false, crime: this.id };
      b.actor.held = 'cash';
    }
    // The last of the dead stand up with the final burst.
    if (this.kind === 'deadrise') for (let i = 0; i < 2; i++) this.raiseOne();
    this.w.bossOpDone?.(this, S.x, S.z);
    this.emit('done');
    this.go('escape');
  }

  /** The boss is down: the crew breaks — the work stops, they run or give up. */
  private breakUp(): void {
    if (this.broken) return;
    this.broken = true;
    for (const c of this.criminals) {
      const act = c.actor;
      if (!act) continue;
      if (act.action?.id === 'channel') act.action = null;
      act.memo.quit = 1; act.memo.decided = 0; act.memo.brave = 0; act.memo.grudge = 0; act.memo.panic = 3;
    }
    // Their master beaten, the raised dead fall apart and sink back into the ground.
    for (const c of this.skeletons) this.crumble(c);
    this.emit('broken');
    this.go('escape');
  }

  /** Map / debug. */
  snapshot(): ReturnType<Crime['snapshot']> & { op: { kind: BossOpKind; share: number; workers: number; standing: number; engaged: boolean; broken: boolean; done: boolean; landmark: string | null } } {
    return { ...super.snapshot(), op: { kind: this.kind, share: Math.round(this.share * 100) / 100, workers: this.workers().length, standing: this.standing().length, engaged: this.engaged, broken: this.broken, done: this.done, landmark: this.landmark } };
  }
}
