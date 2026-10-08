/**
 * Procession of thralls (tier 2, the necromancers' rescue operation — VILLAINS_PLAN §3.9). A
 * necromancer walks slowly down the street with a lantern, and behind them, in a line, citizens
 * in a trance: arms out, shuffling, eyes on nothing. They are being led to a crypt (a manhole, a
 * park's far end) — reach it and they are gone into the dark for the night.
 *
 * A rescue without punching civilians: beat the necromancer (or make them give up) and every
 * thrall comes to at once, confused and unhurt; or walk up to them and wake them one by one (E).
 * The necromancer fights back with their powers when a Bone-caller leads it; a lone one runs.
 */
import { Crime, type CrimeWorld, setState, stand, lookAt, goTo, subdued, play } from './Crime';
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';
import { hold, release } from '../../sim/actors/Actor';

export const PROCESSION = { ringMin: 60, ringMax: 260, hp: 52, strength: 0.95, thralls: [3, 5] as [number, number], gather: 26, approachTimeout: 60, walk: 0.95, gap: 1.6, lead: 85, leadMax: 160, noticeR: 16, wakeR: 1.9, moanEvery: 5 };

export class Procession extends Crime {
  readonly kind = 'procession' as const;
  readonly tier = 2;
  /** The entranced, in the order they walk. */
  readonly thralls: PedAgent[] = [];
  /** Thralls woken (by the hero or the necromancer's fall) and taken (led all the way). */
  woken = 0;
  taken = 0;
  /** Where they are led. */
  dest = { x: 0, z: 0 };
  private route: { x: number; z: number }[] = [];
  private ri = 0;
  private confronted = false;
  private moanT = 0;

  constructor(w: CrimeWorld, seed: number, private near: { x: number; z: number } | null = null) {
    super(w, seed);
  }

  /** The necromancer leading it. */
  get leader(): PedAgent | null { return this.criminals[0] ?? null; }

  setup(): boolean {
    const p = this.w.player;
    const cx = this.near?.x ?? p.x, cz = this.near?.z ?? p.z;
    // Walkers to take: in a ring round the player (or near the point), a few together.
    const cands = this.walkers(cx, cz, this.near ? 80 : PROCESSION.ringMax, true).filter((a) => this.near || (this.distToPlayer(a) > PROCESSION.ringMin && this.distToPlayer(a) < PROCESSION.ringMax));
    if (cands.length < PROCESSION.thralls[0]) return false;
    const first = cands[this.rng.int(0, cands.length - 1)];
    const group = cands.filter((a) => Math.hypot(a.x - first.x, a.z - first.z) < PROCESSION.gather).sort((a, b) => Math.hypot(a.x - first.x, a.z - first.z) - Math.hypot(b.x - first.x, b.z - first.z));
    const n = Math.min(group.length, this.rng.int(PROCESSION.thralls[0], PROCESSION.thralls[1]));
    if (n < PROCESSION.thralls[0]) return false;
    // The necromancer comes up the street towards them, out of sight.
    let c: PedAgent | null = null;
    for (let k = 0; k < 8 && !c; k++) {
      const a = this.rng.float() * Math.PI * 2, r = 22 + k * 4;
      const x = first.x + Math.sin(a) * r, z = first.z + Math.cos(a) * r;
      if (this.w.blocked?.(x, z) || (this.w.visible(x, 1, z) && this.distToPlayer({ x, z }) < 90)) continue;
      c = this.spawnCriminal(x, z, Math.atan2(x - first.x, z - first.z), { hp: PROCESSION.hp, maxHp: PROCESSION.hp, strength: PROCESSION.strength, armed: 'none' });
    }
    if (!c) return false;
    c.actor!.memo.brave = 0;
    for (const a of group.slice(0, n)) this.thralls.push(a);
    this.x = first.x; this.z = first.z;
    this.hot.x = first.x; this.hot.z = first.z;
    return true;
  }

  /** Thralls still in the trance and in the line. */
  get entranced(): PedAgent[] { return this.thralls.filter((a) => a.alive && a.actor?.owner === this.id && a.actor.memo.thrall === 1); }

  protected step(dt: number): void {
    const L = this.leader;
    if (!L) { this.abort(); return; }
    const la = L.actor;
    switch (this.phase) {
      case 'approach': {
        if (!L.alive || !la || this.phaseT > PROCESSION.approachTimeout) { this.abort(); return; }
        const first = this.thralls[0];
        if (!first?.alive || first.inside || first.actor) { this.abort(); return; }
        goTo(la, first.x, first.z, 1.5);
        setState(la, 'walk');
        if (Math.hypot(first.x - L.x, first.z - L.z) < 3) this.entrance();
        break;
      }
      case 'commit': {
        if (this.leaderBeaten()) { this.wakeAll(); this.go('subdued'); break; }
        if (this.reactToPlayer(dt)) break;
        this.lead(dt);
        this.follow(dt);
        break;
      }
      case 'escape':
      case 'subdued': {
        if (this.leaderBeaten()) this.wakeAll();
        if (la && !subdued(la) && la.state !== 'down') {
          if (this.reactToPlayer(dt)) { /* fighting or fleeing */ }
          else this.flee(L, dt);
        }
        this.follow(dt);
        break;
      }
      default: break;
    }
    // A thrall woken by the hero (E) or hurt comes to.
    for (const a of this.thralls) {
      const act = a.actor;
      if (!act || act.owner !== this.id || act.memo.thrall !== 1) continue;
      if (a.state === PState.Down || act.hp < act.maxHp) this.wake(a);
    }
  }

  /** The trance takes them: they turn, arms out, and fall in behind. */
  private entrance(): void {
    for (const a of this.thralls) {
      if (!a.alive || a.inside) continue;
      const act = this.adopt(a, 'victim', { hp: 32, maxHp: 32, strength: 0.4, mood: 'sad', held: null });
      act.memo.thrall = 1;
    }
    const L = this.leader!;
    for (const c of this.criminals) if (c.actor) c.actor.hostile = true;
    // Where to: a long walk away from the player, down the streets.
    const p = this.w.player, ax = L.x - p.x, az = L.z - p.z, al = Math.hypot(ax, az) || 1;
    const d = PROCESSION.lead + this.rng.float() * (PROCESSION.leadMax - PROCESSION.lead);
    this.dest = { x: L.x + (ax / al) * d, z: L.z + (az / al) * d };
    const R = this.w.route(L.x, L.z, this.dest.x, this.dest.z);
    this.route = [];
    // (A route: x, z, crossing flag per point.)
    if (R) for (let i = 0; i + 2 < R.length; i += 3) this.route.push({ x: R[i], z: R[i + 1] });
    if (!this.route.length) this.route.push(this.dest);
    this.ri = 0;
    if (!this.policeCalled) { this.policeCalled = true; this.w.callPolice(this, 60); }
    this.w.sound('deep_murk', L.x, 1.2, L.z, 0.6, 0.6);
    this.go('commit');
    this.emit('commit');
  }

  /** The necromancer walks the route slowly with a raised hand; reaching the end, the thralls are gone. */
  private lead(dt: number): void {
    const L = this.leader!, la = L.actor!;
    const wp = this.route[this.ri];
    if (!wp) {
      // At the crypt: the line walks into the dark, out of the city's sight.
      for (const a of this.entranced) { this.taken++; a.alive = false; }
      la.memo.escaped = 1;
      setState(la, 'gone');
      L.alive = false;
      this.emit('done');
      return;
    }
    if (Math.hypot(wp.x - L.x, wp.z - L.z) < 1.4) { this.ri++; return; }
    // Wait for the line to keep up.
    const last = this.entranced[this.entranced.length - 1];
    const slow = last && Math.hypot(last.x - L.x, last.z - L.z) > PROCESSION.gap * (this.entranced.length + 2);
    if (slow) stand(la); else goTo(la, wp.x, wp.z, PROCESSION.walk);
    setState(la, 'walk');
    la.mood = 'focused';
    hold(la, 'cast_self', 1.2);
    this.hot.x = L.x; this.hot.z = L.z;
    this.moanT -= dt;
    if (this.moanT <= 0) { this.moanT = PROCESSION.moanEvery * (0.7 + this.rng.float() * 0.6); this.w.sound('deep_glow', L.x, 1.2, L.z, 0.35, 0.5); }
  }

  /** Each thrall shuffles after the one ahead, arms out. */
  private follow(_dt: number): void {
    let ahead: { x: number; z: number } | null = this.leader;
    for (const a of this.entranced) {
      const act = a.actor!;
      const tx = ahead?.x ?? a.x, tz = ahead?.z ?? a.z, d = Math.hypot(tx - a.x, tz - a.z);
      if (this.phase === 'commit' && d > PROCESSION.gap) { goTo(act, tx, tz, PROCESSION.walk * (d > 4 ? 1.3 : 1)); setState(act, 'walk'); }
      else { stand(act); setState(act, 'idle'); }
      act.mood = 'sad';
      lookAt(act, tx, a.y + 1.5, tz);
      hold(act, 'sleepwalk', 1.5);
      ahead = a;
    }
  }

  private leaderBeaten(): boolean {
    const L = this.leader, la = L?.actor;
    return !L || !L.alive || !la || subdued(la) || la.state === 'gone' || L.state === PState.Down;
  }

  /** The hero comes close (or hits the necromancer): they fight with powers, or run. True when it took the frame. */
  private reactToPlayer(dt: number): boolean {
    const L = this.leader!, la = L.actor!;
    const close = this.distToPlayer(L) < PROCESSION.noticeR || this.playerAttacked;
    if (!close && !this.confronted) return false;
    if (!this.confronted) {
      this.confronted = true;
      this.playerInvolved = true;
      if (this.phase === 'commit') this.go('escape');
      la.action = null;
    }
    if (subdued(la) || la.state === 'down') return true;
    this.rethink(L);
    this.actOnChoice(L, dt);
    return true;
  }

  /** A thrall comes to: confused, unhurt, back to their day. */
  wake(a: PedAgent): boolean {
    const act = a.actor;
    if (!act || act.owner !== this.id || act.memo.thrall !== 1) return false;
    act.memo.thrall = 0;
    act.action = null;
    this.woken++;
    this.emit('woken', a);
    // A moment of confusion (a shrug, looking round), then back to their day.
    play(act, 'gesture_shrug', 1.6);
    const self = this;
    act.memo.wokeAt = this.t;
    void self;
    release(a);
    return true;
  }

  /** The necromancer is beaten: the trance breaks for every one of them at once. */
  private wakeAll(): void {
    for (const a of this.entranced) this.wake(a);
  }

  /** The nearest entranced thrall within reach of a point (the hero's E). */
  thrallNear(x: number, z: number, r = PROCESSION.wakeR): PedAgent | null {
    let best: PedAgent | null = null, bd = r;
    for (const a of this.entranced) { const d = Math.hypot(a.x - x, a.z - z); if (d < bd) { bd = d; best = a; } }
    return best;
  }

  /** Released at the end: nobody stays entranced. */
  dispose(keepVictims = false): void {
    this.wakeAll();
    super.dispose(keepVictims);
  }

  snapshot(): ReturnType<Crime['snapshot']> & { thralls: number; woken: number; taken: number } {
    return { ...super.snapshot(), thralls: this.entranced.length, woken: this.woken, taken: this.taken };
  }
}
