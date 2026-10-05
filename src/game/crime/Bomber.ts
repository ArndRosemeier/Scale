/**
 * The mad bomber (tier 2): a lone madman walks into a busy street with a bag of round black bombs
 * and starts lobbing them about — into the crowd, under cars, at shop fronts, at the police when
 * they come and at the hero once they close in. Each bomb lies hissing on a lit fuse before it
 * goes off (crime/Bombs: the sparks are the tell, so a bomb can be outrun). He keeps his distance,
 * backing off and throwing; hurt, he weighs it up like any criminal (fight with his fists, run or
 * give up); out of bombs, he runs. Stop him before the street is in ruins.
 */
import { Crime, type CrimeWorld, play, setState, stand, lookAt, goTo, subdued } from './Crime';
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';

export const BOMBER = {
  ringMin: 110, ringMax: 300,
  /** A busy spot: walkers within this radius count as the crowd. */
  crowdR: 18,
  approachTimeout: 60,
  hp: 70, strength: 1.1,
  /** Bombs in the bag. */
  bombs: [12, 18] as const,
  /** Seconds between throws, and the wind-up before the bomb leaves the hand. */
  gap: [1.9, 3.2] as const,
  windup: 0.38,
  /** How far he throws (m), and from how far the hero becomes the target. */
  throwMin: 6, throwMax: 22, atPlayer: 26,
  fuse: [1.2, 1.7] as const,
  /** Backs off from a hero closer than this. */
  keepMin: 7,
  /** Wanders this far about his spot while throwing. */
  roam: 14,
  /** Below this share of his health he thinks about running or giving up. */
  hurt: 0.45,
};

export class Bomber extends Crime {
  readonly kind = 'bomber' as const;
  readonly tier = 2;
  bomber: PedAgent | null = null;
  bombsLeft = 0;
  /** Bombs he has thrown (tests, dev). */
  thrown = 0;

  constructor(w: CrimeWorld, seed: number, private near: { x: number; z: number } | null = null) {
    super(w, seed);
  }

  setup(): boolean {
    const p = this.w.player;
    const cx = this.near?.x ?? p.x, cz = this.near?.z ?? p.z;
    // The busiest stretch of pavement in the ring (or near the given point).
    const cands = this.walkers(cx, cz, this.near ? 60 : BOMBER.ringMax).filter((a) => {
      if (this.near) return true;
      const d = this.distToPlayer(a);
      return d >= BOMBER.ringMin && d <= BOMBER.ringMax;
    });
    if (!cands.length) return false;
    let site = cands[0], best = -1;
    for (let i = 0; i < Math.min(12, cands.length); i++) {
      const a = cands[this.rng.int(0, cands.length - 1)];
      const n = this.w.neighbours(a.x, a.z, BOMBER.crowdR).filter((o) => !o.inside).length;
      if (n > best) { best = n; site = a; }
    }
    this.x = site.x; this.z = site.z;
    this.hot.x = site.x; this.hot.z = site.z;
    // He walks in from out of view.
    let c: PedAgent | null = null;
    for (let k = 0; k < 8 && !c; k++) {
      const ang = this.rng.float() * Math.PI * 2, r = 24 + k * 3;
      const x = site.x + Math.sin(ang) * r, z = site.z + Math.cos(ang) * r;
      if (this.w.visible(x, 1, z) && this.distToPlayer({ x, z }) < 90) continue;
      c = this.spawnCriminal(x, z, Math.atan2(x - site.x, z - site.z), { hp: BOMBER.hp, maxHp: BOMBER.hp, strength: BOMBER.strength, armed: 'none' });
    }
    if (!c) return false;
    c.actor!.held = 'bomb';
    c.actor!.memo.brave = this.rng.chance(0.5) ? 1 : 0;
    this.bomber = c;
    this.bombsLeft = this.rng.int(BOMBER.bombs[0], BOMBER.bombs[1]);
    return true;
  }

  protected step(dt: number): void {
    const c = this.bomber;
    if (!c || !c.actor) { this.abort(); return; }
    const act = c.actor;
    switch (this.phase) {
      case 'approach': {
        if (!c.alive || this.phaseT > BOMBER.approachTimeout) { this.abort(); return; }
        goTo(act, this.x, this.z, 1.5);
        setState(act, 'walk');
        if (Math.hypot(c.x - this.x, c.z - this.z) < 4) this.commit();
        break;
      }
      case 'commit': this.rampage(c, dt); break;
      case 'escape':
      case 'subdued': {
        if (subdued(act) || act.state === 'down' || c.state === PState.Down) break;
        if (this.weighUp(c)) break;
        if (act.memo.choice === 1) { this.fight(c, dt); break; }
        this.flee(c, dt);
        // On the run with bombs left: one over the shoulder now and then at a hero on his heels.
        const d = this.distToPlayer(c);
        if (this.bombsLeft > 0 && d > 5 && d < 18) this.throwing(c, dt, 1.8);
        break;
      }
      default: break;
    }
  }

  private commit(): void {
    const c = this.bomber!, act = c.actor!;
    act.hostile = true;
    act.mood = 'angry';
    this.w.sound('shout_hey', c.x, c.y + 1.6, c.z, 0.9, 0.8);
    if (!this.policeCalled) { this.policeCalled = true; this.w.callPolice(this, 14); }
    this.go('commit');
    this.emit('commit');
  }

  /** The rampage: wander about the spot, lob a bomb every few seconds, back off from the hero. */
  private rampage(c: PedAgent, dt: number): void {
    const act = c.actor!;
    if (subdued(act) || act.state === 'down' || c.state === PState.Down) return;
    const d = this.distToPlayer(c);
    if (d < 30) this.playerInvolved = true;
    if (this.weighUp(c)) return;
    if (act.memo.choice === 1 && d < 12) { this.fight(c, dt); return; }
    if (this.bombsLeft <= 0 && !(act.memo.windup > 0)) { act.memo.panic = 3; this.go('escape'); return; }
    if (act.memo.windup > 0) stand(act);
    else if (d < BOMBER.keepMin) {
      // Too close: back off (and keep throwing from there).
      const p = this.w.player, ax = c.x - p.x, az = c.z - p.z, al = Math.hypot(ax, az) || 1;
      goTo(act, c.x + (ax / al) * 5, c.z + (az / al) * 5, 4.4);
      setState(act, 'run');
    } else {
      act.memo.roamT = (act.memo.roamT ?? 0) - dt;
      if (act.memo.roamT <= 0 || !act.goal) {
        act.memo.roamT = 3 + this.rng.float() * 3;
        const ang = this.rng.float() * Math.PI * 2, r = this.rng.float() * BOMBER.roam;
        goTo(act, this.x + Math.sin(ang) * r, this.z + Math.cos(ang) * r, 1.9);
      }
      setState(act, 'fight');
    }
    this.throwing(c, dt, 1);
  }

  /**
   * Hurt badly: decide once per blow taken (Crime.decide) — fight, flee or give up. True when he
   * gave up (nothing more to do this frame).
   */
  private weighUp(c: PedAgent): boolean {
    const act = c.actor!;
    if (act.hp >= act.maxHp * BOMBER.hurt && !(act.memo.choice >= 0)) return false;
    if (act.memo.decHp !== act.hp) {
      act.memo.decHp = act.hp;
      const d = this.decide(c);
      act.memo.choice = d === 'surrender' ? 2 : d === 'fight' && act.memo.brave ? 1 : 0;
      if (act.memo.choice === 1) this.emit('fight', c);
      if (act.memo.choice === 0 && this.phase === 'commit') { act.memo.panic = 4; this.go('escape'); }
    }
    if (act.memo.choice === 2) { if (act.state !== 'surrender') this.surrender(c); return true; }
    return false;
  }

  /** The throw: wind up, then the bomb leaves the hand towards the chosen spot (every `gap` s × slow). */
  private throwing(c: PedAgent, dt: number, slow: number): void {
    const act = c.actor!;
    if (act.memo.windup > 0) {
      act.memo.windup -= dt;
      lookAt(act, act.memo.tx, c.y + 1, act.memo.tz);
      if (act.memo.windup <= 0 && act.staggerT <= 0 && c.state !== PState.Down) {
        const fuse = BOMBER.fuse[0] + this.rng.float() * (BOMBER.fuse[1] - BOMBER.fuse[0]);
        if (!this.w.bomb || this.w.bomb(c, act.memo.tx, act.memo.tz, fuse)) { this.bombsLeft--; this.thrown++; }
      }
      return;
    }
    act.memo.throwT = (act.memo.throwT ?? 0.8) - dt;
    if (act.memo.throwT > 0 || act.staggerT > 0) return;
    act.memo.throwT = (BOMBER.gap[0] + this.rng.float() * (BOMBER.gap[1] - BOMBER.gap[0])) * slow;
    const t = this.pickTarget(c);
    if (!t) return;
    act.memo.tx = t.x; act.memo.tz = t.z;
    act.memo.windup = BOMBER.windup;
    stand(act);
    lookAt(act, t.x, c.y + 1, t.z);
    c.heading = Math.atan2(c.x - t.x, c.z - t.z);
    play(act, 'throw', 0.7);
  }

  /** Where the next bomb goes: the hero when they are close, else an officer, a car, the crowd, or anywhere. */
  private pickTarget(c: PedAgent): { x: number; z: number } | null {
    const p = this.w.player, B = BOMBER;
    const d = this.distToPlayer(c);
    const ok = (x: number, z: number) => { const e = Math.hypot(x - c.x, z - c.z); return e >= B.throwMin * 0.7 && e <= B.throwMax; };
    if (d >= 4 && d <= B.atPlayer && (!p.flying || p.y - c.y < 8) && !p.down) {
      // Where they will be in a moment (running straight on gets you caught; a turn dodges it).
      const x = p.x + p.vx * 0.6, z = p.z + p.vz * 0.6;
      return clampReach(c, x, z, B.throwMax);
    }
    const cops = this.w.officers?.(c.x, c.z, B.throwMax).filter((o) => ok(o.x, o.z));
    if (cops?.length) return cops[this.rng.int(0, cops.length - 1)];
    const r = this.rng.float();
    if (r < 0.35 && this.w.cars) {
      const cars = this.w.cars(c.x, c.z, B.throwMax).filter((v) => ok(v.x, v.z));
      if (cars.length) return cars[this.rng.int(0, cars.length - 1)];
    }
    if (r < 0.75) {
      const crowd = this.w.neighbours(c.x, c.z, B.throwMax).filter((o) => !o.actor && !o.inside && o.state !== PState.Down && ok(o.x, o.z));
      if (crowd.length) { const o = crowd[this.rng.int(0, crowd.length - 1)]; return { x: o.x, z: o.z }; }
    }
    const ang = this.rng.float() * Math.PI * 2, e = B.throwMin + this.rng.float() * (B.throwMax - B.throwMin) * 0.7;
    return { x: c.x + Math.sin(ang) * e, z: c.z + Math.cos(ang) * e };
  }
}

function clampReach(c: { x: number; z: number }, x: number, z: number, max: number): { x: number; z: number } {
  const dx = x - c.x, dz = z - c.z, d = Math.hypot(dx, dz);
  if (d <= max) return { x, z };
  return { x: c.x + (dx / d) * max, z: c.z + (dz / d) * max };
}
