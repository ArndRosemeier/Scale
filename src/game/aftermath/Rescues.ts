/**
 * Rescues and triage (THREATS_PLAN §2 "Casualties without gore", "How the player helps"):
 *
 *  - trapped: collapses in an incident (the monster's, the army's, the last resort's) leave people
 *    under the rubble — dust-covered, half buried at the edge of a rubble mound, waving, calling out
 *    (a muffled cry, a short "Help!"). The player digs them out: hold E beside them for a few seconds
 *    (dust, stones, the digging sound) — karma. Crews reach the rest some time after it is over.
 *  - injured: people the monster or a blast knocked down stay down (no gore: they lie there hurt).
 *    The player can pick one up (E) and carry them over the shoulders to the triage tent and put them
 *    on a cot there (E, or just arriving) — karma. Paramedics also fetch them, slowly: one kneels by
 *    someone for a while, then helps them walk to the tent.
 *  - the triage tent: EMS sets it up in a park / open spot outside the cordon — a white tent with the
 *    first-aid sign, cots, ambulances with their lights going, medics in high-vis kneeling by the
 *    cots; the treated get a coloured triage tag (their jacket's trim) and walk off after a while.
 *
 * Everything counts in the casualty ledger (evacuated / injured / trapped / rescued — never dead).
 * Map markers (layer 'rescue') with tooltips: the trapped, the injured, the tent (on the compass at
 * any distance while carrying someone). Budgets: ≤ 10 trapped and ≤ 14 injured drawn (materialised
 * near the player; the rest stay counted), ≤ 3 medics, 2 ambulances.
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import type { Aftermath } from './Aftermath';
import { Rng, deriveSeed, hash32 } from '../../core/rng';
import { PState, type PedAgent, isBystander } from '../../sim/Pedestrians';
import { Role } from '../../sim/Population';
import { VState, type Vehicle } from '../../sim/Traffic';
import { attach, makeActor, play, goTo, stand, lookAt, setState, release, AFTERMATH_OWNER } from '../../sim/actors/Actor';
import type { EquipmentVisuals } from '../../items/types';
import type { MapMarker } from '../../ui/map/GameMap';
import { AFTERMATH } from './rules';
import { parked } from './park';
import { pointInPoly, distPointPolyEdge } from '../../core/geom2';
import { voice } from '../../ui/voices';

export const RESCUE = {
  /** Trapped / injured people drawn at once (near the player), entries kept, medics, ambulances. */
  maxTrapped: 10, keepTrapped: 30, maxInjured: 14, medics: 3, ambulances: 2,
  /** Materialise within / go abstract again beyond (m). */
  near: 220, far: 300,
  /** Hold E this long (s, faster with super strength) within this reach (m) to dig someone out. */
  digT: 3.5, reach: 2.4, carryReach: 2.2, cotReach: 7,
  karma: { dig: 12, triage: 10 }, rep: { dig: 1.5, triage: 1 },
  /** People trapped per new rubble mound in a rescue area: the chance, at most this many. */
  perMound: 0.65, perMoundMax: 2,
  /** A medic kneels this long beside someone (s); the treated stay on a cot this long (s). */
  kneelT: 7, cotT: [40, 90] as [number, number],
  /** Call for help when the player is within (m), every (s). */
  callR: 70, callGap: [5, 9] as [number, number],
};

interface Trapped {
  x: number; y: number; z: number; yaw: number;
  seed: number;
  a: PedAgent | null;
  /** Digging progress 0..1, the next call, when crews reach them (abs game hours; −1 not yet planned). */
  dig: number;
  callT: number;
  crewAt: number;
  freed: boolean;
  /** The rubble over their legs was placed (static debris; it stays). */
  slabs?: boolean;
}

type InjState = 'down' | 'carried' | 'medic' | 'walking' | 'cot' | 'gone';
interface Injured { a: PedAgent; state: InjState; medic: Medic | null; t: number; cot: number; tag: number }
interface Medic { a: PedAgent; job: Injured | null; mode: 'idle' | 'go' | 'kneel' | 'escort'; t: number }
interface Cot { x: number; y: number; z: number; yaw: number; who: Injured | null }

interface Triage {
  x: number; y: number; z: number; yaw: number;
  cots: Cot[];
  cars: Vehicle[];
  medics: Medic[];
  /** Absolute game hours it packs up (−1: while it is needed). */
  until: number;
  spawnT: number;
  /** Ambulances still to come. */
  pending: number;
}

const DUST = new THREE.Color(0.58, 0.55, 0.5);
const STONE = new THREE.Color(0.5, 0.48, 0.45);
const SLAB = new THREE.Color(0.8, 0.78, 0.74);
const TAGS: [number, number, number][] = [[0.75, 0.05, 0.04], [0.9, 0.75, 0.05], [0.1, 0.6, 0.15]];
const CANVAS: [number, number, number] = [0.92, 0.92, 0.88];
const SIGN_GREEN: [number, number, number] = [0.02, 0.45, 0.18];
const COT: [number, number, number] = [0.28, 0.36, 0.26];

export class Rescues {
  readonly trapped: Trapped[] = [];
  readonly injured: Injured[] = [];
  private pending: { a: PedAgent; t: number }[] = [];
  triage: Triage | null = null;
  /** Destruction.mounds already looked at (new ones in a rescue area may hold someone). */
  moundsSeen = -1;
  /** Mounds made by the last resort's strike are not looked at (its casualties are planned by the strike). */
  quiet = false;
  carrying: Injured | null = null;
  private digging: Trapped | null = null;
  private digFx = 0;
  private markT = 0;
  private markKey = '';
  private triageDirty = true;
  private siren: ReturnType<Game['audio']['loop']> = null;
  private rng: Rng;
  stats = { trapped: 0, dug: 0, crewDug: 0, injured: 0, carried: 0, medicTreated: 0, materialised: 0 };

  constructor(private g: Game, private A: Aftermath) {
    this.rng = new Rng(deriveSeed(g.settings.seed, 'rescues'));
    // Knocked down by a monster, a collapse in an incident, a blast (the army's shells, rockets, bombs): injured (counted; looked after).
    const prev = g.reactions.onKnockDown;
    g.reactions.onKnockDown = (a, fx, fz, power, cause) => {
      prev?.(a, fx, fz, power, cause);
      if ((cause === 'threat' || cause === 'collapse' || cause === 'military') && !a.actor && A.rescueArea(a.x, a.z)) this.knocked(a);
    };
  }

  private knocked(a: PedAgent): void {
    if (this.pending.some((p) => p.a === a) || this.injured.some((i) => i.a === a)) return;
    this.A.ledger.injure(1);
    this.stats.injured++;
    this.pending.push({ a, t: 0 });
  }

  // ================================================================== frame

  update(dt: number): void {
    this.newMounds();
    this.trappedStep(dt);
    this.claim(dt);
    this.injuredStep(dt);
    this.triageStep(dt);
    this.carry();
    this.markers(dt);
  }

  /** New rubble in a rescue area: someone may be under it. */
  private newMounds(): void {
    const M = this.g.destruction.mounds;
    if (this.moundsSeen < 0 || this.moundsSeen > M.length) this.moundsSeen = M.length;
    for (; this.moundsSeen < M.length; this.moundsSeen++) {
      const m = M[this.moundsSeen];
      if (this.quiet || m.r < 3 || !this.A.rescueArea(m.x, m.z) || this.A.inZone(m.x, m.z)) continue;
      const rng = new Rng(deriveSeed(this.g.settings.seed, 'trapped', Math.round(m.x), Math.round(m.z)));
      if (!rng.chance(RESCUE.perMound)) continue;
      const n = rng.int(1, RESCUE.perMoundMax);
      for (let k = 0; k < n; k++) this.addTrapped(m.x, m.z, m.r, m.h, rng.nextU32());
    }
  }

  /** Someone under the rubble of a mound (counted now unless `count` is false; drawn when the player comes near). */
  addTrapped(mx: number, mz: number, r: number, h: number, seed: number, count = true): boolean {
    if (count) this.A.ledger.trap(1);
    this.stats.trapped++;
    if (this.trapped.filter((t) => !t.freed).length >= RESCUE.keepTrapped) return false;
    const rng = new Rng(seed), W = this.g.world;
    // At the foot of the mound (its lumpy edge reaches out to ~1.2 r), pinned under slabs that fell
    // off it; not inside a standing building, not in the water.
    void h;
    const d = r * 1.18;
    for (let k = 0; k < 8; k++) {
      const ang = rng.range(0, Math.PI * 2), x = mx + Math.cos(ang) * d, z = mz + Math.sin(ang) * d;
      if (!W.standable(x, z, 0)) continue;
      // Facing away from the mound (towards the street).
      this.trapped.push({ x, z, y: W.groundHeight(x, z), yaw: Math.atan2(-(x - mx), -(z - mz)), seed, a: null, dig: 0, callT: rng.range(0, 3), crewAt: -1, freed: false });
      return true;
    }
    return false;
  }

  private trappedStep(dt: number): void {
    const g = this.g, P = g.player, p = P.pos, now = this.A.hours, calm = this.A.calm;
    let drawn = 0;
    for (const t of this.trapped) if (t.a) drawn++;
    for (let i = this.trapped.length - 1; i >= 0; i--) {
      const t = this.trapped[i];
      if (t.freed) { if (!t.a) this.trapped.splice(i, 1); else if (!t.a.alive || !t.a.actor) { t.a = null; this.trapped.splice(i, 1); } continue; }
      // Crews reach them some time after it is over.
      if (calm && t.crewAt < 0) t.crewAt = now + this.rng.range(AFTERMATH.crewDigH[0], AFTERMATH.crewDigH[1]);
      if (t.crewAt >= 0 && now >= t.crewAt) { this.free(t, false); continue; }
      const d = Math.hypot(t.x - p.x, t.z - p.z);
      // Drawn near the player (a dust-covered person half in the rubble), abstract farther off.
      if (!t.a && d < RESCUE.near && drawn < RESCUE.maxTrapped) { if (this.materialise(t)) drawn++; }
      else if (t.a && (d > RESCUE.far || !t.a.alive)) { if (t.a.alive) t.a.alive = false; t.a = null; drawn--; }
      const a = t.a;
      if (!a?.actor) continue;
      const act = a.actor;
      a.x = t.x; a.z = t.z;
      stand(act);
      act.mood = 'pain';
      // Waving, calling out; looking at the player once they are close.
      if (d < 40) lookAt(act, p.x, p.y + 1.5, p.z);
      if (!act.action && Math.random() < dt * 0.5) play(act, 'gesture_wave', 2.2);
      t.callT -= dt;
      if (t.callT <= 0 && d < RESCUE.callR) {
        t.callT = this.rng.range(RESCUE.callGap[0], RESCUE.callGap[1]);
        // Over them, or (out of sight) low on the screen with where it came from.
        voice(a, 'trapped');
      }
    }
    // Digging: E held beside them.
    const D = this.digging;
    if (D) {
      const ok = !D.freed && g.input.down('KeyE') && Math.hypot(D.x - p.x, D.z - p.z) < RESCUE.reach + P.radius && !P.flying && P.height < 4;
      if (!ok) { this.digging = null; return; }
      const rate = 1 + 0.25 * g.abilities.rank('strength');
      D.dig = Math.min(1, D.dig + (dt * rate) / RESCUE.digT);
      P.vel.x *= 0.5; P.vel.z *= 0.5;
      this.digFx -= dt;
      if (this.digFx <= 0) {
        this.digFx = 0.55;
        P.action = { id: 'dig', t0: P.animClock, dur: 0.6 };
        g.dust.burst(D.x, D.y + 0.6, D.z, 6, 0.8, 1.6, 0.8, 1.2, DUST, 0.1, 0.4);
        g.debris.chipBurst(D.x, D.y + 0.8, D.z, 4, 2.5, 0, 0.6, 0, STONE, 0.06, 0.8);
        g.audio.play('dig_rubble', D.x, D.y + 0.6, D.z, 0.8, 0.9 + Math.random() * 0.2, 5, g.renderer.camera.position);
      }
      if (D.dig >= 1) { this.free(D, true); this.digging = null; }
    }
  }

  /** A person in the rubble: a citizen, dust-covered, as an actor of the aftermath. */
  private materialise(t: Trapped): boolean {
    const g = this.g, pop = g.population;
    let c = null;
    for (let k = 0; k < 10 && !c; k++) { const cc = pop.synthetic(hash32(t.seed + k * 7919) || 1); if (cc.role !== Role.Child) c = cc; }
    if (!c) return false;
    const a = g.peds.spawnAt(c, t.x, t.z, t.yaw, false);
    if (!a) return false;
    attach(a, makeActor('victim', AFTERMATH_OWNER, { outfit: dustyOutfit(c.seed), mood: 'pain', held: null, hp: 40, maxHp: 40, move: 'crouch' }));
    a.heading = t.yaw;
    t.a = a;
    this.stats.materialised++;
    // Slabs and stones over their legs (static rubble; once per person).
    if (!t.slabs) {
      t.slabs = true;
      const rng = new Rng(t.seed ^ 0x51ab), fx = -Math.sin(t.yaw), fz = -Math.cos(t.yaw);
      for (let k = 0; k < 5; k++) {
        const side = (k - 2) * 0.3, fwd = rng.float() * 0.55 - 0.1;
        const x = t.x + fx * fwd + fz * side, z = t.z + fz * fwd - fx * side;
        g.debris.spawn(x, t.y + 0.15 + rng.float() * 0.25, z, 0.5 + rng.float() * 0.7, 0.18 + rng.float() * 0.25, 0.4 + rng.float() * 0.6, 0, 0, 0, rng.int(0, 15), SLAB, 0, false);
      }
    }
    return true;
  }

  /** Dug out (by the player, or by the crews): out of the rubble, a word of thanks, off they go. */
  private free(t: Trapped, byPlayer: boolean): void {
    if (t.freed) return;
    t.freed = true;
    this.A.ledger.dig(byPlayer);
    const g = this.g, a = t.a;
    if (byPlayer) {
      this.stats.dug++;
      g.crime.reward({ karma: RESCUE.karma.dig, why: 'dug someone out of the rubble', rep: RESCUE.rep.dig, news: 'rescue', count: 'deeds' });
      g.audio.play('crowd_cheer', t.x, t.y + 2, t.z, 0.3, 1.05, 8, g.renderer.camera.position);
    } else this.stats.crewDug++;
    if (a?.actor) {
      // Climbs out towards the player (or away from the rubble) and walks off.
      const p = g.player.pos;
      a.x = t.x + Math.sin(t.yaw) * -1.2; a.z = t.z + Math.cos(t.yaw) * -1.2;
      a.helped = true;
      if (byPlayer) { a.heading = Math.atan2(-(p.x - a.x), -(p.z - a.z)); g.barks.say(a, pick(this.rng, THANKS)); }
      a.actor.outfit = dustyOutfit(a.cit.seed);
      a.actor.move = null;
      release(a);
      a.state = PState.Idle; a.stateT = 0; a.fear = 0.2;
    }
  }

  // ---------------------------------------------------------------- the injured

  /** Knocked-down people, once they lie still: claimed as injured (they stay down until cared for). */
  private claim(dt: number): void {
    const g = this.g, p = g.player.pos;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const q = this.pending[i];
      q.t += dt;
      const a = q.a;
      // Gone (despawned, looked after out of sight) or up again by itself: cared for.
      if (!a.alive || (a.state !== PState.Down && q.t > 1)) { this.A.ledger.treat(false); this.pending.splice(i, 1); continue; }
      if (q.t < 1.5 || g.ragdolls.isTumbling(a) || a.actor) continue;
      if (this.injured.length >= RESCUE.maxInjured || Math.hypot(a.x - p.x, a.z - p.z) > 260) { if (q.t > 20) { this.pending.splice(i, 1); this.A.ledger.treat(false); } continue; }
      this.pending.splice(i, 1);
      g.ragdolls.keepDown(a);
      attach(a, makeActor('victim', AFTERMATH_OWNER, { state: 'down', mood: 'pain', upT: 1e9, held: null }));
      this.injured.push({ a, state: 'down', medic: null, t: 0, cot: -1, tag: this.rng.int(0, 2) });
    }
  }

  private injuredStep(dt: number): void {
    const g = this.g, p = g.player.pos;
    for (let i = this.injured.length - 1; i >= 0; i--) {
      const I = this.injured[i];
      I.t += dt;
      const a = I.a, act = a.actor;
      if (!a.alive || !act) {
        if (I.state !== 'cot' && I.state !== 'gone') this.A.ledger.treat(false);
        if (this.carrying === I) this.carrying = null;
        this.unCot(I);
        this.injured.splice(i, 1);
        continue;
      }
      act.upT = 1e9;
      if (I.state === 'down') {
        act.mood = 'pain';
        a.state = PState.Down;
        // Far behind the player and out of sight: looked after by others.
        if (Math.hypot(a.x - p.x, a.z - p.z) > 320 && !I.medic) { a.alive = false; continue; }
      } else if (I.state === 'walking') {
        // With a medic (escort) or on their own to the tent; limping.
        const T = this.triage;
        if (!T) { this.letGo(I); continue; }
        const c = this.freeCot();
        const to = c >= 0 ? T.cots[c] : T;
        if (Math.hypot(to.x - a.x, to.z - a.z) > 1.6) { goTo(act, to.x, to.z, 0.9); setState(act, 'walk'); }
        else if (c >= 0) this.toCot(I, c, false);
        else this.letGo(I);
      } else if (I.state === 'cot') {
        if (I.cot >= 0 && this.triage) { const c = this.triage.cots[I.cot]; a.x = c.x; a.y = c.y + 0.52; a.z = c.z; a.heading = c.yaw; }
        if (I.t > 0 || !this.triage) this.letGo(I);
      }
    }
  }

  /** On a cot at the tent (lying; the medic beside them). */
  private toCot(I: Injured, c: number, byPlayer: boolean): void {
    const T = this.triage!, cot = T.cots[c], a = I.a, act = a.actor!;
    cot.who = I;
    I.cot = c;
    I.state = 'cot';
    // (Counts up to 0: the time on the cot.)
    I.t = -this.rng.range(RESCUE.cotT[0], RESCUE.cotT[1]);
    a.ragdoll = true;
    a.state = PState.Down;
    a.x = cot.x; a.y = cot.y + 0.52; a.z = cot.z; a.heading = cot.yaw;
    a.vx = a.vy = a.vz = 0;
    act.move = 'sleep';
    act.state = 'down';
    act.goal = null;
    // Triage tag: the trim of their clothes in the tag colour.
    act.outfit = taggedOutfit(a.cit.seed, TAGS[I.tag]);
    this.triageDirty = true;
    this.A.ledger.treat(byPlayer);
    if (byPlayer) {
      const g = this.g;
      this.stats.carried++;
      g.crime.reward({ karma: RESCUE.karma.triage, why: 'brought someone injured to the triage tent', rep: RESCUE.rep.triage, news: 'rescue', count: 'deeds' });
    } else this.stats.medicTreated++;
  }

  private unCot(I: Injured): void {
    if (I.cot >= 0 && this.triage?.cots[I.cot]?.who === I) this.triage.cots[I.cot].who = null;
    I.cot = -1;
  }

  /** Treated: up and off they walk (tagged), back to ordinary life. */
  private letGo(I: Injured): void {
    const a = I.a;
    this.unCot(I);
    if (I.state !== 'cot' && I.state !== 'gone') this.A.ledger.treat(false);
    I.state = 'gone';
    a.ragdoll = false;
    a.y = this.g.world.groundHeight(a.x, a.z);
    if (a.actor) { a.actor.move = null; a.actor.upT = 0; }
    release(a);
    a.state = PState.Idle; a.stateT = 0; a.fear = 0; a.helped = true;
    const i = this.injured.indexOf(I);
    if (i >= 0) this.injured.splice(i, 1);
  }

  private freeCot(): number {
    const T = this.triage;
    if (!T) return -1;
    return T.cots.findIndex((c) => !c.who);
  }

  // ---------------------------------------------------------------- carrying (the player)

  /** The carried person over the player's shoulders. */
  private carry(): void {
    const I = this.carrying;
    if (!I) return;
    const P = this.g.player, p = P.pos, a = I.a;
    if (!a.alive || !a.actor) { this.carrying = null; return; }
    const h = P.height / 1.8;
    // Across the shoulders: lying, the hips on one shoulder, the body sideways to the player.
    const rx = Math.cos(P.yaw), rz = -Math.sin(P.yaw);
    a.x = p.x + rx * 0.05 * h; a.z = p.z + rz * 0.05 * h; a.y = p.y + 1.25 * h;
    a.heading = P.yaw + Math.PI / 2;
    a.vx = a.vy = a.vz = 0;
    // Arriving at the tent: onto a free cot.
    const T = this.triage;
    if (T && Math.hypot(T.x - p.x, T.z - p.z) < RESCUE.cotReach * 0.6) {
      const c = this.freeCot();
      if (c >= 0) { this.carrying = null; this.toCot(I, c, true); }
    }
  }

  /** E: start digging, pick someone up, put them down at the tent or here. True when used. */
  use(): boolean {
    const g = this.g, P = g.player, p = P.pos;
    if (P.flying || P.height > 4 || P.height < 1.2) return false;
    if (this.carrying) {
      const I = this.carrying, T = this.triage;
      this.carrying = null;
      P.action = { id: 'pickup', t0: P.animClock, dur: 0.8 };
      if (T && Math.hypot(T.x - p.x, T.z - p.z) < RESCUE.cotReach) {
        const c = this.freeCot();
        if (c >= 0) { this.toCot(I, c, true); return true; }
      }
      // Put down here.
      const a = I.a, fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw);
      a.ragdoll = false;
      a.x = p.x + fx * 0.9; a.z = p.z + fz * 0.9; a.y = g.world.groundHeight(a.x, a.z);
      a.state = PState.Down; a.stateT = 0;
      if (a.actor) { a.actor.move = null; a.actor.state = 'down'; }
      I.state = 'down';
      return true;
    }
    if (g.crime.deeds.current?.phase === 'carried') return false;
    // Someone trapped in reach: start digging (hold E).
    let bt: Trapped | null = null, bd = RESCUE.reach + P.radius;
    for (const t of this.trapped) { if (t.freed || !t.a) continue; const d = Math.hypot(t.x - p.x, t.z - p.z); if (d < bd) { bd = d; bt = t; } }
    if (bt) { this.digging = bt; this.digFx = 0; return true; }
    // Someone injured in reach: up onto the shoulders.
    let bi: Injured | null = null; bd = RESCUE.carryReach + P.radius;
    for (const I of this.injured) { if (I.state !== 'down') continue; const d = Math.hypot(I.a.x - p.x, I.a.z - p.z); if (d < bd && Math.abs(I.a.y - p.y) < 1.5) { bd = d; bi = I; } }
    if (bi) {
      if (bi.medic) { bi.medic.job = null; bi.medic.mode = 'idle'; bi.medic = null; }
      g.ragdolls.release(bi.a);
      bi.state = 'carried';
      bi.a.ragdoll = true;
      bi.a.state = PState.Down;
      bi.a.actor!.move = 'sleep';
      this.carrying = bi;
      P.action = { id: 'pickup', t0: P.animClock, dur: 0.9 };
      return true;
    }
    return false;
  }

  hint(): string | null {
    const g = this.g, P = g.player, p = P.pos;
    if (this.carrying) {
      const T = this.triage;
      if (T && Math.hypot(T.x - p.x, T.z - p.z) < RESCUE.cotReach) return this.freeCot() >= 0 ? 'Press <b>E</b> to lay them on a cot' : 'The cots are full — press <b>E</b> to put them down here';
      return T ? 'Carry them to the triage tent — the green mark on your map and compass (<b>E</b> puts them down)' : 'Press <b>E</b> to put them down';
    }
    if (this.digging) return `Digging… <b>${'▮'.repeat(Math.round(this.digging.dig * 8))}${'▯'.repeat(8 - Math.round(this.digging.dig * 8))}</b>`;
    if (P.flying) return null;
    for (const t of this.trapped) if (!t.freed && t.a && Math.hypot(t.x - p.x, t.z - p.z) < RESCUE.reach + P.radius) return P.height > 4 ? 'Someone is trapped — you are too big to dig them out' : 'Someone is trapped — hold <b>E</b> to dig them out';
    for (const I of this.injured) if (I.state === 'down' && Math.hypot(I.a.x - p.x, I.a.z - p.z) < RESCUE.carryReach + P.radius) return P.height > 4 ? null : 'Someone is injured — press <b>E</b> to carry them';
    return null;
  }

  // ---------------------------------------------------------------- the triage tent and EMS

  /** Set up the tent in an open spot near (cx, cz), outside `avoid` m of it (the cordon). */
  setUp(cx: number, cz: number, avoid: number): boolean {
    if (this.triage) { this.triage.until = -1; return true; }
    const spot = this.findSpot(cx, cz, avoid);
    if (!spot) return false;
    const g = this.g, y = g.world.groundHeight(spot.x, spot.z);
    const cots: Cot[] = [];
    const fx = Math.sin(spot.yaw), fz = Math.cos(spot.yaw), rx = Math.cos(spot.yaw), rz = -Math.sin(spot.yaw);
    // Four cots inside the tent, four outside in front of it.
    for (let k = 0; k < 8; k++) {
      const inside = k < 4, col = (k % 4) - 1.5;
      const ox = rx * col * 1.35, oz = rz * col * 1.35;
      const f = inside ? -0.4 : 3.6;
      const x = spot.x + ox + fx * f, z = spot.z + oz + fz * f;
      cots.push({ x, z, y: g.world.groundHeight(x, z), yaw: spot.yaw, who: null });
    }
    this.triage = { x: spot.x, y, z: spot.z, yaw: spot.yaw, cots, cars: [], medics: [], until: -1, spawnT: 0, pending: RESCUE.ambulances };
    this.triageDirty = true;
    return true;
  }

  /** A parking spot on the street near (x, z), `along` m further along it, at the kerb side of the lane. */
  private kerbSlot(x: number, z: number, along: number): { x: number; z: number } {
    const net = this.g.net, ne = net.nearestEdge(x, z, 60), o = { x: 0, z: 0, dx: 0, dz: 0 };
    if (!ne) return { x, z };
    const e = net.edges[ne.e];
    net.pointAt(e, Math.max(0, Math.min(e.len, ne.s + along)), (e.width / 2 - 1.6) * (ne.side >= 0 ? 1 : -1), o);
    return { x: o.x, z: o.z };
  }

  /** Pack up (when it is no longer needed): at `hours` (absolute game time). */
  packUpAt(hours: number): void { if (this.triage && this.triage.until < 0) this.triage.until = hours; }

  /** An open spot for the tent: no building within 7 m, dry, near a street (ambulances), parks preferred. */
  private findSpot(cx: number, cz: number, avoid: number): { x: number; z: number; yaw: number } | null {
    const g = this.g, W = g.world, net = g.net, p = g.player.pos, o = { x: 0, z: 0, dx: 0, dz: 0 };
    let best: { x: number; z: number; yaw: number } | null = null, bs = -Infinity;
    const rng = new Rng(deriveSeed(g.settings.seed, 'triage', Math.round(cx), Math.round(cz)));
    for (let k = 0; k < 90; k++) {
      const ang = rng.range(0, Math.PI * 2), r = avoid + 40 + rng.range(0, 220);
      const x = cx + Math.cos(ang) * r, z = cz + Math.sin(ang) * r;
      if (W.wet(x, z, 2) || W.buildingsIn(x - 8, z - 8, x + 8, z + 8).some((b) => b.alive && (pointInPoly(b.poly, x, z) || distPointPolyEdge(b.poly, x, z) < 7))) continue;
      const ne = net.nearestEdge(x, z, 40);
      if (!ne) continue;
      const e = net.edges[ne.e];
      net.pointAt(e, ne.s, 0, o);
      const ds = Math.hypot(o.x - x, o.z - z);
      if (ds < e.width / 2 + 3) continue;
      const cell = g.macro.cells.find((c) => Math.abs(c.centroid[0] - x) < c.radius && Math.abs(c.centroid[1] - z) < c.radius && pointInPoly(c.poly, x, z));
      const park = cell?.district === 'park' ? 60 : 0;
      const slope = Math.abs(g.terrain.height(x + 4, z) - g.terrain.height(x - 4, z)) + Math.abs(g.terrain.height(x, z + 4) - g.terrain.height(x, z - 4));
      if (slope > 1.6) continue;
      const s = park - Math.hypot(x - p.x, z - p.z) * 0.15 - ds * 0.8 - slope * 10;
      // The opening faces the street.
      if (s > bs) { bs = s; best = { x, z, yaw: Math.atan2(o.x - x, o.z - z) }; }
    }
    return best;
  }

  private triageStep(dt: number): void {
    const T = this.triage, g = this.g;
    if (!T) { this.siren?.set(0, 0, 0, 0); return; }
    const p = g.player.pos, near = Math.hypot(T.x - p.x, T.z - p.z) < 700;
    // Packing up: the medics get in, the ambulances drive off, the tent goes (when nobody sees it).
    const packing = T.until >= 0 && this.A.hours >= T.until;
    if (packing && !this.injured.some((i) => i.state === 'cot' || i.state === 'walking') && !(this.carrying)) {
      if (!g.crime.visible(T.x, T.y + 1.5, T.z) || Math.hypot(T.x - p.x, T.z - p.z) > 250) { this.takeDown(); return; }
    }
    // Ambulances come (sirens) and park beside the tent; two medics each.
    T.spawnT -= dt;
    if (near && !packing && T.pending > 0 && T.spawnT <= 0) {
      T.spawnT = 6;
      const k = RESCUE.ambulances - T.pending;
      const fx = Math.sin(T.yaw), fz = Math.cos(T.yaw);
      // In the street in front of the tent, one behind the other along the kerb.
      const slot = this.kerbSlot(T.x + fx * 9, T.z + fz * 9, k * 8);
      const ang = this.rng.range(0, Math.PI * 2);
      const car = g.traffic.spawnVehicle('ambulance', T.x + Math.cos(ang) * 260, T.z + Math.sin(ang) * 260, 120, slot);
      if (car) {
        car.task = { x: slot.x, z: slot.z, arrived: false };
        car.siren = true; car.fear = 0; car.state = VState.Drive; car.vmax = 18;
        g.traffic.sendTo(car, slot.x, slot.z);
        T.cars.push(car);
        T.pending--;
      }
    }
    let driving = false;
    for (const car of T.cars) {
      if (!car.alive) continue;
      // Close to its spot but held up (a parked car, the end of its route): it parks where it is.
      parked(car, dt);
      if (car.task?.arrived || car.task?.hold) {
        if (car.siren) {
          car.siren = false;
          car.fear = 0.5; // lights keep flashing on the scene
          this.deployMedics(car);
        }
      } else driving = true;
      if (packing && car.task && !car.task.hold && car.task.arrived) {
        // (Packing up: off they go once the tent is taken down.)
      }
    }
    // The siren of the ones on their way.
    const lead = T.cars.find((c) => c.alive && c.siren);
    if (lead && driving) { this.siren ??= g.audio.loop('ambulance_siren', 30); this.siren?.set(lead.x, lead.y + 1.6, lead.z, 0.9); }
    else this.siren?.set(T.x, T.y, T.z, 0);
    this.medicStep(dt);
    if (this.triageDirty) this.drawTriage();
  }

  private deployMedics(car: Vehicle): void {
    const T = this.triage!, g = this.g;
    for (let i = 0; i < 2 && T.medics.length < RESCUE.medics; i++) {
      const c = g.population.synthetic(hash32(car.id * 131 + i * 7) || 1);
      const bx = car.x + Math.sin(car.yaw) * 3.2 + (i - 0.5) * 1.2, bz = car.z + Math.cos(car.yaw) * 3.2;
      const a = g.peds.spawnAt(c, bx, bz, car.yaw, false);
      if (!a) break;
      attach(a, makeActor('medic', AFTERMATH_OWNER, { outfit: medicOutfit(c.seed), mood: 'focused', held: null, hp: 90, maxHp: 90 }));
      T.medics.push({ a, job: null, mode: 'idle', t: 0 });
      g.audio.play('door_open', bx, 1, bz, 0.5, 0.9, 6, g.renderer.camera.position);
    }
  }

  /** Medics: kneel by the cots; one at a time fetch someone lying out there (not where it is dangerous). */
  private medicStep(dt: number): void {
    const T = this.triage!, g = this.g;
    for (let i = T.medics.length - 1; i >= 0; i--) {
      const M = T.medics[i], a = M.a, act = a.actor;
      if (!a.alive || !act) { if (M.job) M.job.medic = null; T.medics.splice(i, 1); continue; }
      M.t += dt;
      act.hostile = false;
      const J = M.job;
      if (M.mode === 'idle') {
        // A job: the nearest injured lying out there, not near the monster, the closest first.
        if (M.t > 3) {
          M.t = 0;
          let best: Injured | null = null, bd = 320;
          for (const I of this.injured) {
            if (I.state !== 'down' || I.medic || this.A.danger(I.a.x, I.a.z)) continue;
            const d = Math.hypot(I.a.x - T.x, I.a.z - T.z);
            if (d < bd) { bd = d; best = I; }
          }
          if (best && this.freeCot() >= 0) { M.job = best; best.medic = M; M.mode = 'go'; continue; }
        }
        // By a cot, kneeling beside someone (or standing by the tent).
        const busy = T.cots.find((c) => c.who && !T.medics.some((m) => m !== M && m.mode === 'idle' && Math.hypot(m.a.x - c.x, m.a.z - c.z) < 1.5));
        const to = busy ? { x: busy.x + Math.cos(T.yaw) * 0.9, z: busy.z - Math.sin(T.yaw) * 0.9 } : { x: T.x + Math.sin(T.yaw) * 2.5, z: T.z + Math.cos(T.yaw) * 2.5 };
        if (Math.hypot(to.x - a.x, to.z - a.z) > 0.8) { goTo(act, to.x, to.z, 1.6); setState(act, 'walk'); act.move = null; }
        else { stand(act); act.move = busy ? 'crouch' : null; setState(act, 'idle'); if (busy) lookAt(act, busy.x, busy.y + 0.5, busy.z); if (busy && !act.action && Math.random() < dt * 0.3) play(act, 'pickup', 1.6); }
        continue;
      }
      if (!J || J.state === 'gone' || J.state === 'carried' || J.state === 'cot' || !J.a.alive) { M.job = null; M.mode = 'idle'; if (J) J.medic = null; continue; }
      if (M.mode === 'go') {
        act.move = null;
        if (this.A.danger(J.a.x, J.a.z)) { J.medic = null; M.job = null; M.mode = 'idle'; continue; }
        if (Math.hypot(J.a.x - a.x, J.a.z - a.z) > 1.3) g.crime.police.chase(a, J.a, 3.2);
        else { stand(act); M.mode = 'kneel'; M.t = 0; }
      } else if (M.mode === 'kneel') {
        stand(act);
        act.move = 'crouch';
        lookAt(act, J.a.x, J.a.y + 0.3, J.a.z);
        if (!act.action && Math.random() < dt * 0.5) play(act, 'pickup', 1.4);
        if (M.t > RESCUE.kneelT) {
          // Up together: the injured limps to the tent beside the medic.
          M.mode = 'escort';
          act.move = null;
          g.ragdolls.release(J.a);
          J.a.ragdoll = false;
          J.a.state = PState.Idle; J.a.stateT = 0;
          J.a.y = g.world.groundHeight(J.a.x, J.a.z);
          J.state = 'walking';
          if (J.a.actor) { J.a.actor.state = 'walk'; J.a.actor.move = null; }
        }
      } else if (M.mode === 'escort') {
        // Beside them, at their pace.
        const side = { x: J.a.x + Math.cos(J.a.heading) * 0.8, z: J.a.z - Math.sin(J.a.heading) * 0.8 };
        if (Math.hypot(side.x - a.x, side.z - a.z) > 0.6) { goTo(act, side.x, side.z, 1.2); setState(act, 'walk'); } else stand(act);
        if (J.state !== 'walking') { M.mode = 'idle'; M.job = null; J.medic = null; }
      }
    }
  }

  /** Tent, sign and cots into the aftermath's props. */
  private drawTriage(): void {
    this.triageDirty = false;
    const T = this.triage;
    if (!T) { this.A.setStatic('triage', []); return; }
    const fx = Math.sin(T.yaw), fz = Math.cos(T.yaw);
    this.A.setStatic('triage', [
      { kind: 'tent', x: T.x, y: T.y, z: T.z, yaw: T.yaw, paint: CANVAS },
      { kind: 'sign', x: T.x + fx * 2.12, y: T.y + 1.45, z: T.z + fz * 2.12, yaw: T.yaw, paint: SIGN_GREEN },
      ...T.cots.map((c) => ({ kind: 'cot' as const, x: c.x, y: c.y, z: c.z, yaw: c.yaw, paint: COT })),
    ]);
  }

  /** The tent comes down: medics and the treated go, the ambulances drive off. */
  private takeDown(): void {
    const T = this.triage, g = this.g;
    if (!T) return;
    for (const I of [...this.injured]) if (I.state === 'cot' || I.state === 'walking') this.letGo(I);
    for (const M of T.medics) M.a.alive = false;
    for (const car of T.cars) {
      if (!car.alive) continue;
      car.fear = 0;
      const a = this.rng.range(0, Math.PI * 2);
      car.task = undefined;
      car.state = VState.Drive;
      if (!g.crime.visible(car.x, car.y + 1, car.z)) car.alive = false;
      else g.traffic.sendTo(car, car.x + Math.cos(a) * 600, car.z + Math.sin(a) * 600);
    }
    this.triage = null;
    this.triageDirty = true;
    this.drawTriage();
  }

  // ---------------------------------------------------------------- map

  private markers(dt: number): void {
    this.markT -= dt;
    if (this.markT > 0) return;
    this.markT = 0.5;
    const list: MapMarker[] = [];
    const p = this.g.player.pos;
    // (The nearest few: a struck district would fill the compass.)
    const near = this.trapped.filter((t) => !t.freed && Math.hypot(t.x - p.x, t.z - p.z) < 400).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z)).slice(0, 6);
    for (const t of near) list.push({ x: t.x, z: t.z, color: '#ffb340', kind: 'alert', title: 'Someone trapped under the rubble — hold E beside them to dig them out' });
    for (const I of this.injured) if (I.state === 'down') list.push({ x: I.a.x, z: I.a.z, color: '#ff7a59', kind: 'dot', title: 'Injured — carry them to the triage tent (E)' });
    const T = this.triage;
    if (T) list.push({ x: T.x, z: T.z, color: '#30d158', kind: 'core', title: 'Triage tent — bring the injured here', always: !!this.carrying });
    const key = list.map((m) => `${Math.round(m.x / 3)},${Math.round(m.z / 3)},${m.always ? 1 : 0}`).join(';');
    if (key !== this.markKey) { this.markKey = key; this.g.map.setMarkers('rescue', list); }
  }

  // ---------------------------------------------------------------- saves, dev

  /** Everyone still waiting is looked after (a load, a long while after): the ledger settles. */
  settle(): void {
    for (const t of this.trapped) { t.freed = true; if (t.a) t.a.alive = false; t.a = null; }
    this.trapped.length = 0;
    for (const I of [...this.injured]) { I.a.alive = false; }
    this.injured.length = 0;
    this.pending.length = 0;
    this.carrying = null;
    this.digging = null;
    this.A.ledger.settle();
  }

  /** Dev: someone trapped at the nearest rubble mound to the player (or a fresh mound ahead). */
  devTrap(): string {
    const g = this.g, p = g.player.pos, M = g.destruction.mounds;
    let m = M.slice().sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
    if (!m || Math.hypot(m.x - p.x, m.z - p.z) > 150) {
      const fy = g.camRig.forwardYaw, x = p.x - Math.sin(fy) * 14, z = p.z - Math.cos(fy) * 14;
      g.destruction.restoreMound(x, z, 6, 2.5);
      this.moundsSeen = M.length;
      m = M[M.length - 1];
    }
    return this.addTrapped(m.x, m.z, Math.max(3, m.r), Math.max(1.5, m.h), (Math.random() * 2 ** 32) >>> 0) ? `trapped at ${Math.round(m.x)},${Math.round(m.z)}` : 'no spot';
  }

  /** Dev: knock someone down near the player as injured (by the monster); nobody about: passers-by are made. */
  devInjure(n = 1): number {
    const g = this.g, p = g.player.pos;
    let k = 0;
    const people = g.peds.neighbours(p.x, p.z, 40, []).filter(isBystander);
    for (let i = people.length; i < n; i++) {
      const ang = Math.random() * Math.PI * 2, x = p.x + Math.cos(ang) * 6, z = p.z + Math.sin(ang) * 6;
      if (g.world.buildingAt(x, z)) continue;
      const a = g.peds.spawnAt(g.population.synthetic((Math.random() * 2 ** 31) | 1), x, z, 0, false);
      if (a) people.push(a);
    }
    for (const a of people) {
      if (k >= n) break;
      g.reactions.knockDown(a, a.x + 1, a.z, 2, 'threat');
      if (!this.pending.some((q) => q.a === a)) this.knocked(a);
      k++;
    }
    return k;
  }

  status(): Record<string, unknown> {
    return {
      trappedNow: this.trapped.filter((t) => !t.freed).map((t) => `${Math.round(t.x)},${Math.round(t.z)}${t.a ? '*' : ''} dig ${t.dig.toFixed(2)}${t.crewAt >= 0 ? ' crew@' + t.crewAt.toFixed(2) : ''}`),
      injuredNow: this.injured.map((i) => `${i.state}${i.medic ? ' +medic' : ''}`),
      pending: this.pending.length,
      triage: this.triage ? { x: Math.round(this.triage.x), z: Math.round(this.triage.z), cars: this.triage.cars.filter((c) => c.alive).length, medics: this.triage.medics.map((m) => m.mode), cots: this.triage.cots.filter((c) => c.who).length, until: this.triage.until } : null,
      carrying: !!this.carrying, ...this.stats,
    };
  }
}

const THANKS = ['Thank you!', 'Oh, thank you…', 'I thought nobody would come.'];

function pick<T>(rng: Rng, l: readonly T[]): T { return l[rng.int(0, l.length - 1)]; }

type RGB = [number, number, number];
function vis(seed: number, primary: RGB, secondary: RGB, accent: RGB, k: number, material = 'plain') {
  return { shape: 'cloth', seed: seed + k, primary, secondary, accent, material, glow: 0 };
}

/** Dust-covered clothes (someone dug out of the rubble): everything in greys and dun. */
function dustyOutfit(seed: number): EquipmentVisuals {
  const r = new Rng(seed);
  const tint = (l: number): RGB => [l + r.range(-0.03, 0.03), l * 0.96, l * 0.9];
  return {
    chest: { defId: 'shirt', visual: vis(seed, tint(0.46), tint(0.38), tint(0.3), 1) },
    back: { defId: 'jacket', visual: vis(seed, tint(0.4), tint(0.34), tint(0.28), 2, 'checks') },
    legs: { defId: 'trousers', visual: vis(seed, tint(0.36), tint(0.3), tint(0.25), 3) },
  } as unknown as EquipmentVisuals;
}

/** A paramedic: green shirt and trousers, a high-visibility jacket. */
function medicOutfit(seed: number): EquipmentVisuals {
  const green: RGB = [0.08, 0.32, 0.18], dark: RGB = [0.05, 0.16, 0.1], hivis: RGB = [0.82, 0.9, 0.15], white: RGB = [0.9, 0.9, 0.9];
  return {
    chest: { defId: 'shirt', visual: vis(seed, green, dark, white, 1) },
    back: { defId: 'jacket', visual: vis(seed, hivis, green, white, 2) },
    legs: { defId: 'trousers', visual: vis(seed, green, dark, white, 3) },
    feet: { defId: 'boots', visual: vis(seed, [0.05, 0.05, 0.05], [0, 0, 0], [0.1, 0.1, 0.1], 4) },
  } as unknown as EquipmentVisuals;
}

/** Someone treated: their own colours, the trim in the triage tag's colour. */
function taggedOutfit(seed: number, tag: RGB): EquipmentVisuals {
  const r = new Rng(seed);
  const c = (): RGB => [r.range(0.15, 0.6), r.range(0.15, 0.6), r.range(0.15, 0.6)];
  return {
    chest: { defId: 'shirt', visual: vis(seed, c(), c(), tag, 1) },
    back: { defId: 'jacket', visual: vis(seed, c(), tag, tag, 2) },
    legs: { defId: 'trousers', visual: vis(seed, c(), c(), tag, 3) },
  } as unknown as EquipmentVisuals;
}

export { dustyOutfit, medicOutfit };

