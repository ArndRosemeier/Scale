/**
 * Purse snatch / pickpocket (tier 1). A real passer-by on a busy sidewalk; the thief walks up
 * from behind (spawned out of view on the victim's way, or a converted walker), bumps into them
 * and grabs the bag. The victim staggers (an elderly victim may fall), screams and points after
 * the thief, who sprints off down the sidewalk, looks back, and slows to a walk to blend in once
 * nobody follows. Witnesses turn and film. An ordinary person can catch and floor him (about
 * three punches, or a tackle at a run); cornered and hurt he gives up. The bag drops where he
 * goes down — bring it back to the victim (E) for a cheer. The police come for him.
 */
import { Crime, type CrimeWorld, play, setState, stand, lookAt } from './Crime';
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';

export const SNATCH = { ringMin: 120, ringMax: 280, approachTimeout: 45, thiefHp: 30, thiefStrength: 0.7 };

export class Snatch extends Crime {
  readonly kind = 'snatch' as const;
  readonly tier = 1;
  victim: PedAgent | null = null;
  thief: PedAgent | null = null;
  private shoutT = 0;

  constructor(w: CrimeWorld, seed: number, private near: { x: number; z: number } | null = null) {
    super(w, seed);
  }

  setup(): boolean {
    const p = this.w.player;
    const cx = this.near?.x ?? p.x, cz = this.near?.z ?? p.z;
    // A victim: an adult or senior on a sidewalk, best where there are people around.
    const cands = this.walkers(cx, cz, this.near ? 60 : SNATCH.ringMax, true).filter((a) => {
      if (this.near) return true;
      const d = this.distToPlayer(a);
      return d >= SNATCH.ringMin && d <= SNATCH.ringMax;
    });
    if (!cands.length) return false;
    const scored = cands.map((a) => ({ a, s: Math.min(8, this.w.neighbours(a.x, a.z, 30).length) + this.rng.float() * 4 - (this.near ? Math.hypot(a.x - cx, a.z - cz) * 0.05 : 0) }));
    scored.sort((u, v) => v.s - u.s);
    const victim = scored[0].a;
    // The thief: a walker close behind (converted) or a newcomer out of view behind the victim.
    const bx = -Math.sin(victim.heading), bz = -Math.cos(victim.heading); // victim's forward
    let thief: PedAgent | null = null;
    const conv = this.walkers(victim.x, victim.z, 35, true).filter((a) => a !== victim && a.cit.role === 1 && ((a.x - victim.x) * bx + (a.z - victim.z) * bz) < -4);
    if (conv.length && this.rng.chance(0.5)) {
      thief = conv[this.rng.int(0, conv.length - 1)];
      this.adopt(thief, 'criminal', { hp: SNATCH.thiefHp, maxHp: SNATCH.thiefHp, strength: SNATCH.thiefStrength, held: null });
      this.criminals.push(thief);
    } else {
      for (let k = 0; k < 6 && !thief; k++) {
        const back = 22 + k * 5, side = (this.rng.float() - 0.5) * 4;
        const x = victim.x - bx * back - bz * side, z = victim.z - bz * back + bx * side;
        if (this.w.visible(x, victim.y + 1, z) && this.distToPlayer({ x, z }) < 90) continue;
        thief = this.spawnCriminal(x, z, victim.heading, { hp: SNATCH.thiefHp, maxHp: SNATCH.thiefHp, strength: SNATCH.thiefStrength });
      }
    }
    if (!thief) return false;
    this.victim = victim;
    this.thief = thief;
    this.x = victim.x; this.z = victim.z;
    this.hot.x = victim.x; this.hot.z = victim.z;
    this.loot = { kind: 'bag', x: victim.x, y: victim.y, z: victim.z, owner: victim, carrier: null, returned: false, crime: this.id };
    this.go('approach');
    return true;
  }

  protected step(dt: number): void {
    const v = this.victim, th = this.thief;
    if (!v || !th || !th.actor) { this.abort(); return; }
    const act = th.actor;
    switch (this.phase) {
      case 'approach': {
        // Catch up with the victim (who keeps walking their route).
        if (!v.alive || v.inside || v.state === PState.Down || v.actor || this.phaseT > SNATCH.approachTimeout) {
          // Lost them: the would-be thief just walks on.
          this.abort();
          return;
        }
        const ahead = 0.9;
        const tx = v.x - Math.sin(v.heading) * ahead * 0.3, tz = v.z - Math.cos(v.heading) * ahead * 0.3;
        act.goal = { x: tx, z: tz };
        act.speed = Math.hypot(tx - th.x, tz - th.z) > 6 ? 2.2 : 1.9;
        setState(act, 'walk');
        if (Math.hypot(v.x - th.x, v.z - th.z) < 1.05) this.commit();
        break;
      }
      case 'escape':
      case 'subdued': {
        this.victimStaging(dt);
        if (act.state === 'run' || act.state === 'walk' || act.state === 'idle' || act.state === 'fight') {
          // Confronted: fight, flee or give up.
          if (this.distToPlayer(th) < 3.2 && act.hitByPlayer) {
            // Decide again after every blow taken.
            if (act.memo.decHp !== act.hp) { act.memo.decHp = act.hp; const d = this.decide(th); act.memo.choice = d === 'surrender' ? 2 : d === 'fight' ? 1 : 0; }
            if (act.memo.choice === 2) { this.surrender(th); break; }
            if (act.memo.choice === 1) { this.fight(th, dt); break; }
          }
          if (act.state === 'fight' && this.distToPlayer(th) > 6) setState(act, 'run');
          if (act.state !== 'fight') this.flee(th, dt);
          else this.fight(th, dt);
        }
        break;
      }
      default:
        this.victimStaging(dt);
        break;
    }
  }

  private commit(): void {
    const v = this.victim!, th = this.thief!, act = th.actor!;
    // The victim becomes part of the scene: staggers (an older victim falls), screams, points.
    const va = this.adopt(v, 'victim', { hp: 30, maxHp: 30, strength: 0.4, held: null, mood: 'afraid' });
    const old = v.cit.role === 2;
    if (old && this.rng.chance(0.55)) this.w.combat.hitActor(v, Math.sin(v.heading) * -300, 60, Math.cos(v.heading) * -300, 'shove', 'npc', th.x, th.z);
    else { play(va, 'stagger', 0.8); va.staggerT = 0.8; }
    act.held = 'bag';
    act.hostile = true;
    this.loot!.carrier = th;
    this.w.sound('scream_single', v.x, v.y + 1.6, v.z, 0.9, 1.05);
    this.shoutT = 0.9;
    this.w.emit('cry', v.x, v.y + 1.6, v.z, 2, 45);
    setState(act, 'run');
    act.memo.panic = 5;
    this.callOnce(22);
    this.go('escape');
    this.emit('commit');
  }

  private callOnce(delay: number): void {
    if (this.policeCalled) return;
    this.policeCalled = true;
    this.w.callPolice(this, delay);
  }

  /** The victim stands, points after the thief and shouts for help; cheers when the bag comes back. */
  private victimStaging(dt: number): void {
    const v = this.victim;
    if (!v || !v.actor || !v.alive) return;
    const va = v.actor;
    const th = this.thief!;
    if (v.state === PState.Down) {
      // Down after the shove: gets up after a few seconds.
      if (va.state !== 'down') { setState(va, 'down'); va.upT = 3; }
      return;
    }
    stand(va);
    if (this.loot?.returned) {
      va.mood = 'happy';
      lookAt(va, this.w.player.x, this.w.player.y + 1.5, this.w.player.z);
      if (va.state !== 'cheer') { setState(va, 'cheer'); play(va, 'cheer', 2.6); va.held = 'bag'; }
      return;
    }
    const thiefAround = th.alive && th.actor && th.actor.state !== 'gone' && Math.hypot(th.x - v.x, th.z - v.z) < 90;
    if (thiefAround) {
      lookAt(va, th.x, th.y + 1.2, th.z);
      setState(va, 'point');
      if (!va.action || va.action.id !== 'gesture_point') play(va, 'gesture_point', 2.4);
    } else {
      // Thief gone: upset, looks at whoever comes close.
      va.mood = 'sad';
      if (this.distToPlayer(v) < 10) lookAt(va, this.w.player.x, this.w.player.y + 1.5, this.w.player.z);
    }
    this.shoutT -= dt;
    const playerClose = this.distToPlayer(v) < 45;
    if (this.shoutT <= 0 && (thiefAround || playerClose) && this.phaseT < 50) {
      this.shoutT = 3.2 + this.rng.float() * 2;
      this.w.sound(v.cit.gender < 0.5 ? 'cry_help' : 'shout_hey', v.x, v.y + 1.6, v.z, 0.8, 0.95 + this.rng.float() * 0.15);
      this.w.emit('cry', v.x, v.y + 1.6, v.z, 1, 30);
    }
  }

  /** The dev / test hook: the victim's actor (null before the snatch). */
  get victimActor() { return this.victim?.actor ?? null; }
}
