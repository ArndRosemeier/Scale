/**
 * The sidekick around the hero (docs/SIDEKICK_PLAN.md phase 2). Sidekick.ts hands it the person
 * once they are bonded; from then on they have a body near the hero for good:
 *
 *  - Around: they hang about a few metres off (a spot they pick and change now and then), walking,
 *    running to keep up, flying when the hero is farther than a walk or in the air (the hero's
 *    flight pose), landing next to them again. Lost far behind and out of sight, they make up the
 *    distance off-screen and fly in from the edge of view: never popping up in plain sight.
 *  - A fight near the hero (hostile gang members, villains): they go in by character (shardRules'
 *    temperament; companionRules.fightStyle): most jump in, the nervous get people clear first, the
 *    proud go for the boss. Punches, and their own power (picked by who they are) when nobody but the bad guys is near where it
 *    lands. None of it touches the hero's reputation, and they never fight the police: wanted, with
 *    officers about, they keep out of it.
 *  - K calls them: they come at full speed and stay close for a while.
 *  - Phase 3 (growthRules): they earn their own karma (knock-outs, fights won, helping people up), take
 *    the hero's gifts (with a wish, honoured or not) and buy powers by their traits; in a fight they
 *    use whichever of their powers fits where the foe stands, a shield when hurt, a charge.
 *  - Phase 4: trust (time together, gifts, fights won, the hero helping people close to them; the
 *    hero hurting bystanders near them, leaving them alone in a losing fight). The asks from the
 *    talk menu: help me, stay back (they hang 20–40 m off and only step in when the hero is hurt),
 *    go home for now (back to their own day until called), come with me.
 *  - Knocked out: the hospital's med drones come, lift them in a stasis field and fly off; after a
 *    while in the revival ward they come back, or (1 in 5) they do not (Sidekick: the grave, the next
 *    shard).
 *
 * Short bubbles say what they are doing (companionRules.mateLine). They are a pinned actor of
 * SIDEKICK_OWNER on their own citizen's body (Pedestrians: `airborne` while flying).
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import { PState, type PedAgent } from '../../sim/Pedestrians';
import { makeActor, play, goTo, stand, lookAt, SIDEKICK_OWNER, PEOPLE_OWNER, type Actor } from '../../sim/actors/Actor';
import { traitsOf, temperamentOf, type Temperament, type Traits } from '../people/identity';
import { VILLAIN_POWERS, CASTERS } from '../powers/Caster';
import { bondOf, bondWord } from '../people/social';
import type { Deed } from '../people/memory';
import type { DownCause } from '../../sim/Pedestrians';
import { ROSTER, GIFTS, MATE_KARMA, TRUST, nextCost, nextWant, honoursWish, buyLine, giftLine, wishLine, trustWord, askAnswer, answersCall, leaning, type Gift, type Ranks, type Ask } from './growthRules';
import { MedFleet } from '../defeat/MedDrones';
import { MATE, MATE_POWERS, fightStyle, matePower, pickFoe, revives, mateLine, type FightStyle, type MateSay, type FoeInfo, type MatePower } from './companionRules';
import { smoothstep as smooth } from '../../core/math';
import { fightingCrook } from '../friendFoe';
import { dealtBy } from '../../shared/status';

/** Companion.panel: what the info panel shows. */
export interface MatePanel {
  name: string; temper: Temperament; mode: MateMode; away: Away; flying: boolean;
  hp: number; maxHp: number;
  karma: number; want: string | null; wantCost: number | null; wished: boolean;
  trust: number; trustWord: string;
  /** What they have learned (`first`: the shard's own gift); rank of max. */
  powers: { name: string; rank: number; max: number; first: boolean }[];
}

export type MateMode = 'around' | 'fight' | 'back' | 'down' | 'ward' | 'home' | 'gone';

/** What a save keeps of them (Sidekick.save); the growth fields are absent in older saves. */
export interface MateSave {
  hp: number; k: number; ward: number;
  karma?: number; earned?: number; ranks?: Ranks; trust?: number; bought?: number; wish?: Gift | null; away?: Away;
}

/** Where an ask left them: nowhere special, hanging back, or at home (until called). */
export type Away = 'none' | 'hold' | 'home';

interface Carry {
  /** 'wait': lying; 'in': drones coming; 'lift': raised into the field; 'away': off to the hospital. */
  stage: 'wait' | 'in' | 'lift' | 'away';
  t: number;
  from: THREE.Vector3[];
  body: THREE.Vector3;
  heading: number;
  dir: THREE.Vector3;
}

const SLOTS: [number, number][] = [[0, 0.95], [-0.8, -0.55], [0.8, -0.55]];

export class Companion {
  mode: MateMode = 'gone';
  a: PedAgent | null = null;
  private act: Actor | null = null;
  private who = -1;
  name = '';
  temper: Temperament = 'steady';
  /** Their one power (companionRules.matePower). */
  power: MatePower = 'fireball';
  private traits: Traits = { o: 0.5, c: 0.5, e: 0.5, a: 0.5, n: 0.5 };
  style: FightStyle = 'brave';
  hp: number = MATE.hp;
  /** Times taken to the ward (the revival roll's count). */
  k = 0;
  private wardT = 0;
  private flying = false;
  private spot: { x: number; z: number } | null = null;
  private spotT = 0;
  /** Where the hero last stood under the open sky (indoors or underground the sidekick waits there). */
  private anchor = new THREE.Vector3();
  private foes: PedAgent[] = [];
  private foe: PedAgent | null = null;
  private scanT = 0;
  private policeNear = false;
  private saidPolice = false;
  private clearT = 0;
  private fought = false;
  private calledT = 0;
  private barkT = 4;
  private idleT = 30;
  private powerCd = 3;
  /** Seconds spent stepping back out of a brawl to use their power. */
  private backT = 0;
  private cast: { t: number; tx: number; ty: number; tz: number; w: MatePower | 'shield' } | null = null;
  private swing = -1;
  private counter: { a: PedAgent; t: number } | null = null;
  private carry: Carry | null = null;
  private fleet: MedFleet | null = null;
  private sayBack = false;
  private tmp: PedAgent[] = [];
  private v = new THREE.Vector3();
  /** Phase 3: their karma, ranks bought, what they save for (a wish they took to heart). */
  karma = 0;
  earned = 0;
  ranks: Ranks = {};
  bought = 0;
  wish: Gift | null = null;
  /** Phase 4: trust in the hero (0…100), and where an ask left them. */
  trust: number = TRUST.start;
  away: Away = 'none';
  /** The power in hand (chosen per cast from the ones they have). */
  private cur: MatePower = 'fireball';
  /** How much each power was used lately (fades with every cast). */
  private used = new Map<MatePower, number>();
  private shieldCd = 0;
  private rush: { x: number; z: number; t: number; hit: boolean } | null = null;
  /** Someone they are helping up, and how long they have been at it. */
  private helping: { a: PedAgent; t: number; lift: number } | null = null;
  private helpScanT = 2;
  private hurtSeen = new Map<number, number>();
  private time = 0;
  stats = { flights: 0, catchUps: 0, punches: 0, powers: 0, unsafe: 0, kos: 0, called: 0, taken: 0, returned: 0, bought: 0, helped: 0, refused: 0 };

  constructor(private g: Game, private hooks: { died(): void; persist(): void }) {}

  /** The bonded person (Sidekick.bond / restore); `save` brings back health and a stay in the ward. */
  start(who: number, name: string, save?: MateSave | null): void {
    if (this.who !== who) this.dismiss();
    this.who = who;
    this.name = name;
    const k = this.g.people.find(who);
    if (k) { this.traits = traitsOf(k.cit); this.temper = temperamentOf(this.traits); }
    this.style = fightStyle(this.temper, this.traits);
    this.power = matePower(this.g.settings.seed, who, this.traits);
    if (save && save.ranks) {
      this.ranks = {};
      for (const g of GIFTS) { const r = Math.floor(Number(save.ranks[g]) || 0); if (r > 0) this.ranks[g] = Math.min(r, ROSTER[g].cost.length); }
      this.karma = Math.max(0, Math.floor(save.karma ?? 0));
      this.earned = Math.max(0, Math.floor(save.earned ?? 0));
      this.trust = Math.max(0, Math.min(TRUST.max, save.trust ?? TRUST.start));
      this.bought = Math.max(0, Math.floor(save.bought ?? 0));
      this.wish = save.wish && GIFTS.includes(save.wish) ? save.wish : null;
      this.away = save.away === 'hold' || save.away === 'home' ? save.away : 'none';
    } else {
      // The shard's first gift: flight and the power that suits them.
      this.ranks = { [this.power]: 1 };
      this.karma = 0; this.earned = 0; this.bought = 0; this.wish = null;
      this.trust = TRUST.start; this.away = 'none';
    }
    this.hp = save ? Math.max(1, Math.min(this.maxHp(), save.hp)) : this.maxHp();
    this.k = save ? save.k : 0;
    this.wardT = save && save.ward > 0 ? save.ward : 0;
    this.mode = this.wardT > 0 ? 'ward' : this.away === 'home' ? 'home' : 'around';
    // (In the ward nobody sees them in the streets.)
    if (this.mode === 'ward') this.g.peds.absent.add(who);
    this.anchor.copy(this.g.player.pos);
  }

  /** No longer the sidekick (the bond broke, or they died): back to their own life, or gone. */
  dismiss(): void {
    const a = this.a;
    if (a && a.alive && a.actor === this.act) {
      if (a.airborne) { a.airborne = false; a.fly = undefined; a.y = this.g.collision.groundAt(a.x, a.z, a.y, 400); a.vx = a.vy = a.vz = 0; }
      a.actor = undefined;
      if (a.state !== PState.Down) { a.state = PState.Flee; a.fear = 0; a.fearX = a.x; a.fearZ = a.z; a.stateT = 0; }
    }
    this.a = null; this.act = null; this.carry = null; this.flying = false;
    if (this.fleet) this.fleet.group.visible = false;
    if (this.mode === 'ward' && this.who >= 0) this.g.peds.absent.delete(this.who);
    this.mode = 'gone';
    this.who = -1;
  }

  save(): MateSave {
    const away = this.mode === 'ward' ? this.wardT : this.mode === 'down' ? MATE.wardTime : 0;
    return {
      hp: Math.round(this.hp), k: this.k, ward: Math.round(away),
      karma: this.karma, earned: this.earned, ranks: { ...this.ranks }, trust: Math.round(this.trust * 10) / 10, bought: this.bought, wish: this.wish, away: this.away,
    };
  }

  /** K: the hero calls for help. */
  call(): void {
    const g = this.g;
    if (this.mode === 'gone') return;
    this.stats.called++;
    const p = g.player.pos;
    g.crime?.sound('shout_hey', p.x, p.y + 1.6, p.z, 0.8, 1.1);
    g.dust.burst(p.x, p.y + g.player.height + 1.2, p.z, 14, 0.4, 3.5, 0.5, 1.2, new THREE.Color(1.6, 1.25, 0.4), 1.2, 0.5);
    if (this.mode === 'ward') { g.powerHud.toast(`<b>${this.name}</b> is in the hospital's revival ward and cannot come`, 'warn', 4000); return; }
    if (this.mode === 'down') { g.powerHud.toast(`<b>${this.name}</b> is down and cannot come`, 'warn', 3500); return; }
    if (!answersCall(this.trust, Math.random())) {
      this.stats.refused++;
      g.powerHud.toast(`<b>${this.name}</b> does not come. They are ${trustWord(this.trust)}`, 'warn', 4000);
      return;
    }
    if (this.mode === 'home') { this.mode = 'around'; this.sayBack = false; }
    this.away = 'none';
    this.calledT = MATE.calledFor;
    g.powerHud.toast(`You call for <b>${this.name}</b>`, 'info', 2500);
    if (this.a) this.say('called', true);
  }

  // ------------------------------------------------------------------ per frame

  update(dt: number): void {
    if (this.mode === 'gone' || this.mode === 'home') return;
    const g = this.g, P = g.player;
    this.time += dt;
    this.shieldCd -= dt;
    this.barkT -= dt; this.idleT -= dt; this.powerCd -= dt; this.calledT -= dt; this.spotT -= dt; this.scanT -= dt;
    if (this.mode === 'ward') {
      this.wardT -= dt;
      if (this.wardT <= 0) this.outOfWard();
      return;
    }
    if (this.mode === 'down') { this.stepDown(dt); return; }
    // Where the hero is under the open sky (they wait there while the hero is indoors or underground).
    if (this.open(P.pos.x, P.pos.y, P.pos.z)) this.anchor.copy(P.pos);
    const a = this.body();
    if (!a) return;
    const act = this.act!;
    // Talking to the hero: stand and face them (down to the ground first).
    if (g.people.partner === a) {
      if (this.flying) this.land(a, dt, a.x, a.z);
      else { stand(act); lookAt(act, P.pos.x, P.pos.y + P.height * 0.9, P.pos.z); }
      return;
    }
    if (act.state === 'ko') { this.knockedOut(a); return; }
    if (a.state === PState.Down || a.ragdoll) { this.flying = false; a.airborne = false; a.fly = undefined; this.cast = null; return; }
    this.hp = act.hp;
    // Lost far behind and out of sight: make up the distance off-screen.
    const d = Math.hypot(a.x - P.pos.x, a.z - P.pos.z);
    if (d < 60) this.trustBy(TRUST.together * dt);
    if (act.memo.shieldT > 0) { act.memo.shieldT -= dt; g.crime?.casts.cast(a, 'shield', 'hold', a.x, a.y, a.z); }
    if (d > MATE.lostR && !this.seen(a.x, a.y + 1, a.z)) this.catchUp(a);
    if (this.sayBack && d < 30) { this.sayBack = false; this.say('back', true); }
    if (this.scanT <= 0) { this.scanT = 0.4; this.scan(a); }
    const before = this.mode;
    // Asked to stay back: into a fight only when called or when the hero is hurt.
    const H = g.crime?.health, joins = this.away !== 'hold' || this.calledT > 0 || (!!H && H.hp < H.max * 0.4);
    this.mode = this.policeNear ? 'back' : this.foes.length && joins ? 'fight' : 'around';
    if (this.mode !== 'around') this.helping = null;
    if (this.mode !== before) this.changed(before);
    if (this.mode !== 'fight') { this.cast = null; this.swing = -1; }
    if (this.mode === 'around') {
      if (this.hp < this.maxHp()) { this.hp = Math.min(this.maxHp(), this.hp + MATE.heal * dt); act.hp = this.hp; }
      this.around(a, dt);
    } else if (this.mode === 'fight') this.fight(a, dt);
    else this.keepOff(a, dt);
    this.counterStep(dt);
  }

  // ------------------------------------------------------------------ the body

  /** Their body near the hero (taken over, or brought in flying from off-screen); null: not now. */
  private body(): PedAgent | null {
    const g = this.g;
    let a = this.a;
    if (a && (!a.alive || a.cit.id !== this.who || g.peds.agentOf(this.who) !== a)) { a = this.a = null; this.act = null; this.flying = false; }
    if (a) {
      // Something else took them over (a robbery's victim, a talk): ours again when it lets go.
      if (a.actor !== this.act) {
        if (a.actor && a.actor.owner === PEOPLE_OWNER) return null;
        a.actor = this.act!;
      }
      return a;
    }
    const k = g.people.find(this.who);
    if (!k) return null;
    a = g.peds.agentOf(this.who);
    if (!a) {
      const s = this.offscreen(MATE.catchUp, null);
      a = g.peds.spawnAt(k.cit, s.x, s.z, 0);
      if (!a) return null;
      this.airborneAt(a, s.x, s.y, s.z);
    } else if (a.actor && a.actor.owner === PEOPLE_OWNER) return null;
    this.a = a;
    this.act = makeActor('bystander', SIDEKICK_OWNER, { title: this.name, hp: this.hp, maxHp: this.maxHp(), strength: this.strength() });
    a.actor = this.act;
    if (a.inside) { a.inside = false; a.hall = false; }
    if (!a.airborne) this.flying = false;
    return a;
  }

  /** Is there open sky over this spot (not inside a building, not underground)? */
  private open(x: number, y: number, z: number): boolean {
    const g = this.g;
    if (g.collision.underground(x, y, z)) return false;
    return this.roof(x, z) < y + 1.2;
  }

  /** The highest surface at (x, z): roofs, or the ground. */
  private roof(x: number, z: number): number {
    return this.g.collision.groundAt(x, z, 3000, 0);
  }

  private seen(x: number, y: number, z: number): boolean {
    return this.g.crime ? this.g.crime.visible(x, y, z) : true;
  }

  /** A point r m from the hero off-screen (behind the camera if their own side is in view), high over the roofs. */
  private offscreen(r: number, from: PedAgent | null): { x: number; y: number; z: number } {
    const g = this.g, p = g.player.pos;
    const cam = g.renderer.camera;
    cam.getWorldDirection(this.v);
    let dx = from ? from.x - p.x : -this.v.x, dz = from ? from.z - p.z : -this.v.z;
    let l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    let x = p.x + dx * r, z = p.z + dz * r;
    if (this.seen(x, p.y + 10, z)) {
      l = Math.hypot(this.v.x, this.v.z) || 1;
      x = p.x - (this.v.x / l) * r; z = p.z - (this.v.z / l) * r;
    }
    const y = Math.max(p.y + 8, this.roof(x, z) + MATE.clear + 6);
    return { x, y, z };
  }

  private catchUp(a: PedAgent): void {
    const s = this.offscreen(MATE.catchUp, a);
    if (this.seen(s.x, s.y, s.z)) return;
    this.stats.catchUps++;
    if (a.ragdoll) this.g.ragdolls.release(a);
    a.ragdoll = false;
    this.airborneAt(a, s.x, s.y, s.z);
  }

  private airborneAt(a: PedAgent, x: number, y: number, z: number): void {
    a.x = x; a.y = y; a.z = z;
    a.vx = a.vz = 0; a.vy = 0;
    a.airborne = true;
    a.fly = { tilt: 0, bank: 0, boost: 0 };
    a.state = PState.Idle;
    a.gx = 1e9;
    this.flying = true;
    if (this.act) { this.act.goal = null; this.act.speed = 0; }
  }

  // ------------------------------------------------------------------ moving

  /** Go to (x, z): walking or running when close and the way is clear, else flying (landing there if `land`). */
  private moveTo(a: PedAgent, dt: number, x: number, z: number, land: boolean, hurry = false, flyY?: number): void {
    const act = this.act!, dh = Math.hypot(x - a.x, z - a.z), wet = this.g.peds.wet(x, z);
    if (!this.flying) {
      const blocked = act.stuckT > 1.4 || wet;
      if (dh > (hurry ? 12 : MATE.flyFrom) || blocked || !land) { this.takeOff(a); }
      else {
        if (dh < 0.6) { stand(act); return; }
        goTo(act, x, z, dh > 7 || hurry ? MATE.run : MATE.walk);
        return;
      }
    }
    // (Over water they hover: nowhere to stand.)
    if (land && !wet && dh < MATE.landR) this.land(a, dt, x, z);
    else this.fly(a, dt, x, flyY ?? Math.max(this.g.player.pos.y + 3, a.y - 2), z, hurry);
  }

  private takeOff(a: PedAgent): void {
    const g = this.g, act = this.act!;
    this.stats.flights++;
    this.flying = true;
    a.airborne = true;
    a.fly = { tilt: 0, bank: 0, boost: 0 };
    a.vy = 6; a.vx = -Math.sin(a.heading) * a.speed; a.vz = -Math.cos(a.heading) * a.speed;
    a.state = PState.Idle;
    act.goal = null; act.speed = 0; act.route = null; act.stuckT = 0;
    const c = g.renderer.camera.position;
    if (Math.hypot(c.x - a.x, c.z - a.z) < 90) g.audio.play('whoosh_takeoff', a.x, a.y + 1, a.z, 0.45, 1.15, 6, c);
  }

  /** Fly towards (tx, ty, tz), over the roofs on the way. */
  private fly(a: PedAgent, dt: number, tx: number, ty: number, tz: number, hurry: boolean): void {
    const P = this.g.player;
    const dx = tx - a.x, dz = tz - a.z, dh = Math.hypot(dx, dz) || 1e-6;
    const ux = dx / dh, uz = dz / dh;
    // The roofs on the way (just ahead): over them first.
    let clear = this.roof(a.x, a.z);
    for (const s of [5, 12, 22, 36]) if (s < dh + 6) clear = Math.max(clear, this.roof(a.x + ux * s, a.z + uz * s));
    const want = Math.max(ty, clear + MATE.clear);
    const heroV = Math.hypot(P.vel.x, P.vel.z);
    const cap = Math.min(MATE.top, Math.max(hurry ? MATE.cruise * 2 : MATE.cruise, heroV * 1.15 + (dh > 40 ? 10 : 0), dh > 120 ? 45 : 0));
    let hs = Math.min(cap, dh * 1.1 + 0.5);
    if (a.y < clear + 1.2) hs *= 0.2;
    const vyT = Math.max(-MATE.climb * 1.3, Math.min(MATE.climb + cap * 0.25, (want - a.y) * 1.6));
    const k = 1 - Math.exp(-dt * 2.6);
    a.vx += (ux * hs - a.vx) * k; a.vz += (uz * hs - a.vz) * k; a.vy += (vyT - a.vy) * k;
    this.integrate(a, dt);
  }

  /** Coming down at (x, z): over it, then down onto the ground. */
  private land(a: PedAgent, dt: number, x0: number, z0: number): void {
    const [x, z] = this.groundSpot(x0, z0, Math.max(a.y, this.g.player.pos.y + 1.5));
    const gy = this.g.collision.groundAt(x, z, Math.max(a.y, this.g.player.pos.y + 1.5), 400);
    const dx = x - a.x, dz = z - a.z, dh = Math.hypot(dx, dz);
    const hs = Math.min(MATE.cruise, dh * 1.4);
    const vyT = dh > 3 ? Math.max(-6, Math.min(6, (gy + 2 - a.y) * 1.4)) : Math.max(-7, (gy - a.y) * 2.2 - 0.6);
    const k = 1 - Math.exp(-dt * 3);
    const l = dh || 1;
    a.vx += ((dx / l) * hs - a.vx) * k; a.vz += ((dz / l) * hs - a.vz) * k; a.vy += (vyT - a.vy) * k;
    this.integrate(a, dt);
    if (a.y - gy < 0.25 && dh < 1.5) {
      a.y = gy;
      a.airborne = false; a.fly = undefined;
      a.vx = a.vy = a.vz = 0; a.speed = 0;
      a.gx = 1e9;
      this.flying = false;
      stand(this.act!);
    }
  }

  /**
   * Somewhere to stand near (x, z) on the street itself, not on a parked car or a crate (from up
   * there they cannot walk on, and would take off and land on it again and again).
   */
  private groundSpot(x: number, z: number, from: number): [number, number] {
    const g = this.g, ok = (px: number, pz: number) => {
      const gy = g.collision.groundAt(px, pz, from, 400);
      return gy - g.world.groundHeight(px, pz, from) < 0.4 && !g.peds.wet(px, pz);
    };
    if (ok(x, z)) return [x, z];
    for (const r of [1.5, 2.5, 3.5, 5]) for (let k = 0; k < 8; k++) {
      const an = (k / 8) * Math.PI * 2, px = x + Math.cos(an) * r, pz = z + Math.sin(an) * r;
      if (ok(px, pz)) return [px, pz];
    }
    return [x, z];
  }

  private integrate(a: PedAgent, dt: number): void {
    a.x += a.vx * dt; a.y += a.vy * dt; a.z += a.vz * dt;
    // Never into a roof or the ground under them.
    const floor = this.g.collision.groundAt(a.x, a.z, a.y + 0.6, 0.6);
    if (a.y < floor) { a.y = floor; if (a.vy < 0) a.vy = 0; }
    const hs = Math.hypot(a.vx, a.vz);
    a.speed = hs;
    const P = this.g.player;
    const h = hs > 0.6 ? Math.atan2(-a.vx, -a.vz) : Math.atan2(-(P.pos.x - a.x), -(P.pos.z - a.z));
    let dh = h - a.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    const turn = dh * Math.min(1, dt * 4);
    a.heading += turn;
    const F = a.fly ?? (a.fly = { tilt: 0, bank: 0, boost: 0 });
    F.tilt += (Math.max(0, Math.min(1, (hs - 3) / 9)) - F.tilt) * Math.min(1, dt * 3);
    F.bank += (Math.max(-0.6, Math.min(0.6, -(turn / Math.max(dt, 1e-3)) * 0.18)) - F.bank) * Math.min(1, dt * 4);
    F.boost = hs > 24 ? 1 : 0;
  }

  // ------------------------------------------------------------------ around

  private around(a: PedAgent, dt: number): void {
    const g = this.g, P = g.player, p = P.pos;
    const called = this.calledT > 0;
    if (P.flying) {
      // Alongside the flying hero: off to one side and a little behind.
      const fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw), side = (this.who & 1) ? 1 : -1;
      const x = p.x - fz * MATE.wing * side - fx * 3, z = p.z + fx * MATE.wing * side - fz * 3;
      if (!this.flying) this.takeOff(a);
      this.fly(a, dt, x, p.y + 0.5, z, called);
      return;
    }
    const base = this.anchor;
    // A small deed of their own: someone fell near them and nobody came.
    if (!called && this.helpUp(a, dt)) return;
    const hold = this.away === 'hold' && !called;
    const r0 = called ? 2 : hold ? 22 : MATE.ringMin, r1 = called ? 5 : hold ? 40 : MATE.ringMax;
    if (!this.spot || this.spotT <= 0 || Math.hypot(this.spot.x - base.x, this.spot.z - base.z) > r1 + 5) this.pickSpot(base, r0, r1);
    const s = this.spot!;
    this.moveTo(a, dt, s.x, s.z, true, called);
    if (!this.flying && Math.hypot(s.x - a.x, s.z - a.z) < 0.8) {
      // Standing about: looking at the hero, or round the street.
      const act = this.act!;
      if (Math.sin(this.spotT * 0.7 + this.who) > -0.2) lookAt(act, p.x, p.y + P.height * 0.85, p.z);
      else lookAt(act, s.x + Math.sin(this.spotT) * 10, a.y + 1.6, s.z + Math.cos(this.spotT) * 10);
      if (this.idleT <= 0 && Math.hypot(p.x - a.x, p.z - a.z) < 14) { this.idleT = MATE.idleGap * (0.7 + Math.random() * 0.6); this.say('idle'); }
    }
    if (!this.flying && Math.hypot(s.x - a.x, s.z - a.z) > 40 && this.barkT <= 0 && Math.random() < dt * 0.2) this.say('coming');
  }

  /** Someone down near them for a while (nobody helped): over to them and up they get. True while at it. */
  private helpUp(a: PedAgent, dt: number): boolean {
    const g = this.g, p = g.player.pos;
    this.helpScanT -= dt;
    if (!this.helping && this.helpScanT <= 0 && !this.flying) {
      this.helpScanT = 1.5;
      for (const o of g.peds.neighbours(a.x, a.z, 25, this.tmp)) {
        if (o === a || !o.alive || o.inside || o.actor || o.state !== PState.Down || o.ragdoll || o.stateT < 8) continue;
        if (Math.hypot(o.x - p.x, o.z - p.z) < 5 || Math.abs(o.y - a.y) > 1.5 || g.peds.wet(o.x, o.z)) continue;
        this.helping = { a: o, t: 0, lift: -1 };
        break;
      }
    }
    const H = this.helping;
    if (!H) return false;
    const o = H.a;
    if (!o.alive || o.state !== PState.Down || o.actor || o.ragdoll || H.t > 20) { this.helping = null; return false; }
    H.t += dt;
    const d = Math.hypot(o.x - a.x, o.z - a.z);
    if (d > 1.9) { this.moveTo(a, dt, o.x + (a.x - o.x) / (d || 1) * 1.0, o.z + (a.z - o.z) / (d || 1) * 1.0, true); return true; }
    const act = this.act!;
    stand(act);
    lookAt(act, o.x, o.y + 0.3, o.z);
    if (H.lift < 0) { H.lift = 0; play(act, 'pickup', 0.9); }
    H.lift += dt;
    if (H.lift < 0.85) return true;
    // Up (as the hero helps people up: Deeds.help).
    o.state = PState.Idle; o.stateT = 0; o.fear = 0; o.vx = o.vy = o.vz = 0; o.speed = 0; o.helped = true; o.downBy = undefined;
    o.heading = Math.atan2(-(a.x - o.x), -(a.z - o.z));
    this.helping = null;
    this.stats.helped++;
    this.say('helpUp', true);
    this.earn(MATE_KARMA.helpUp);
    return false;
  }

  /** A new spot to stand: round the hero, on open ground at their level, not in water. */
  private pickSpot(base: THREE.Vector3, r0: number, r1: number): void {
    const g = this.g;
    this.spotT = MATE.spotEvery[0] + Math.random() * (MATE.spotEvery[1] - MATE.spotEvery[0]);
    for (let i = 0; i < 10; i++) {
      const ang = Math.random() * Math.PI * 2, r = r0 + Math.random() * (r1 - r0);
      const x = base.x + Math.cos(ang) * r, z = base.z + Math.sin(ang) * r;
      const gy = g.collision.groundAt(x, z, base.y + 1.5, 2);
      if (Math.abs(gy - base.y) > 1.2 || this.roof(x, z) > gy + 0.6 || g.peds.wet(x, z)) continue;
      this.spot = { x, z };
      return;
    }
    this.spot = { x: base.x + 1.5, z: base.z + 1.5 };
  }

  // ------------------------------------------------------------------ fights

  /** Who is fighting near the hero (hostile, still up), and whether the police are about while the hero is wanted. */
  private scan(a: PedAgent): void {
    const g = this.g, p = g.player.pos, list = this.foes;
    list.length = 0;
    this.policeNear = false;
    const wanted = (g.crime?.justice.wanted ?? 0) > 0;
    for (const o of g.peds.neighbours(p.x, p.z, MATE.joinR, this.tmp)) {
      if (o === a || !o.alive || o.inside) continue;
      const act = o.actor;
      if (!act) continue;
      if (wanted && act.role === 'police' && o.state !== PState.Down && Math.hypot(o.x - p.x, o.z - p.z) < MATE.policeR) this.policeNear = true;
      if (isFoe(o)) list.push(o);
    }
    if (!wanted) this.saidPolice = false;
    if (this.foe && !list.includes(this.foe)) this.foe = null;
    if (list.length) {
      const info: FoeInfo[] = list.map((o) => ({ d: Math.hypot(o.x - a.x, o.z - a.z), maxHp: o.actor!.maxHp, lead: !!(o.actor!.memo.boss || o.actor!.memo.lt), onHero: Math.hypot(o.x - p.x, o.z - p.z) < 3 }));
      // Keep the one in hand while it is close.
      if (!this.foe || Math.hypot(this.foe.x - a.x, this.foe.z - a.z) > 4) this.foe = list[pickFoe(this.style, info)] ?? null;
    }
  }

  /** Into a fight, out of one, keeping off: what they say. */
  private changed(before: MateMode): void {
    if (this.mode === 'fight') {
      this.fought = true;
      if (this.style === 'careful') { this.clearT = MATE.clearFor; this.say('careful', true); }
      else this.say(this.style === 'boss' ? 'boss' : 'join', true);
    } else if (this.mode === 'back') {
      if (!this.saidPolice) { this.saidPolice = true; this.say('police', true); }
    } else if (before === 'fight' && this.fought) {
      this.fought = false;
      if (Math.random() < 0.6) this.say('won');
      // Won side by side (the hero there for it).
      const p = this.g.player.pos, a = this.a;
      if (a && Math.hypot(a.x - p.x, a.z - p.z) < 60) { this.earn(MATE_KARMA.won); this.trustBy(TRUST.won); }
    }
  }

  private fight(a: PedAgent, dt: number): void {
    const g = this.g, act = this.act!, p = g.player.pos;
    // The careful ones first get people clear: arms out, between the fight and the street.
    if (this.clearT > 0) {
      this.clearT -= dt;
      const f = this.foes[0];
      const x = p.x + (a.x - (f?.x ?? p.x)) * 0.3, z = p.z + (a.z - (f?.z ?? p.z)) * 0.3;
      this.moveTo(a, dt, x, z, true, true);
      if (!this.flying && (!act.action || act.action.id !== 'gesture_point')) play(act, 'gesture_point', 1.2);
      return;
    }
    const t = this.foe;
    if (!t) { this.around(a, dt); return; }
    const dx = t.x - a.x, dz = t.z - a.z, d = Math.hypot(dx, dz) || 1e-6;
    if (this.cast) { this.casting(a, dt); return; }
    if (this.swing >= 0) {
      this.swing -= dt;
      stand(act);
      if (this.swing < 0) this.strike(a, t);
      return;
    }
    if (this.rush) { this.rushing(a, dt); return; }
    // Hurt: their shield, if they have one.
    if (this.has('shield') && !this.flying && this.shieldCd <= 0 && act.hp < act.maxHp * 0.6 && !(act.memo.shieldT > 0)) { this.beginCast(a, a, 'shield'); return; }
    // A power when one is ready: whichever of theirs fits where the foe stands and is safe there
    // (their favourite first); too close for the favourite, they step back out of the brawl for it.
    const own = this.attacks();
    const fav = own[0] ?? null;
    const M = MATE_POWERS[fav ?? 'fireball'], ready = this.powerCd <= 0 && !!fav;
    const castD = Math.min(M.max - 2, Math.max(M.min + 2.5, 8));
    if (ready && !this.flying) {
      for (const w of own) {
        const W = MATE_POWERS[w];
        if (d > W.min && d < W.max && this.safe(a, t, w)) { this.backT = 0; this.beginCast(a, t, w); return; }
      }
    }
    if (ready && !this.flying && d > M.min) {
      this.stats.unsafe++;
      this.powerCd = 1.5;
    } else if (ready && !this.flying && d <= M.min) {
      this.backT += dt;
      if (this.backT > 2.5) { this.backT = 0; this.powerCd = 2; } else {
        this.moveTo(a, dt, t.x - (dx / d) * castD, t.z - (dz / d) * castD, true, true);
        return;
      }
    }
    const stop = ready && M.min > 2 ? castD : 1.4;
    if (this.flying && d > Math.max(MATE.landR, stop + 2)) {
      this.fly(a, dt, t.x - (dx / d) * stop, Math.max(t.y + 3, p.y + 2), t.z - (dz / d) * stop, true);
      return;
    }
    if (this.flying) { this.land(a, dt, t.x - (dx / d) * stop, t.z - (dz / d) * stop); return; }
    lookAt(act, t.x, t.y + 1.3, t.z);
    if (d > MATE.punchR) { this.moveTo(a, dt, t.x - (dx / d) * 1.1, t.z - (dz / d) * 1.1, true, true); return; }
    stand(act);
    act.attackT -= dt;
    if (act.attackT <= 0) {
      act.attackT = MATE.attackCd[0] + Math.random() * (MATE.attackCd[1] - MATE.attackCd[0]);
      this.swing = MATE.windup;
      play(act, Math.random() < 0.3 ? 'kick' : 'punch', 0.7);
    }
  }

  /** The blow lands if they are still in reach. */
  private strike(a: PedAgent, t: PedAgent): void {
    const g = this.g, act = this.act!;
    const dx = t.x - a.x, dz = t.z - a.z, d = Math.hypot(dx, dz) || 1;
    if (d > MATE.hitR || act.staggerT > 0 || !g.crime) return;
    const J = 360 * Math.sqrt(act.strength) * (0.8 + 0.4 * Math.random()) * dealtBy(a);
    const res = g.crime.combat.hitActor(t, (dx / d) * J, 60, (dz / d) * J, 'punch', 'npc', a.x, a.z);
    g.crime.sound('punch_impact', t.x, t.y + 1.2, t.z, 0.55, 1);
    this.stats.punches++;
    if (res.effect === 'ko') { this.stats.kos++; this.earn(t.actor?.memo.boss || t.actor?.memo.lt ? MATE_KARMA.lead : MATE_KARMA.ko); }
    if ((res.effect === 'stagger' || res.effect === 'none') && Math.random() < MATE.counterChance) this.counter = { a: t, t: 0.55 };
  }

  /** Whoever they hit may hit back. */
  private counterStep(dt: number): void {
    const C = this.counter, a = this.a, g = this.g;
    if (!C || !a || !g.crime) return;
    C.t -= dt;
    if (C.t > 0) return;
    this.counter = null;
    const o = C.a, oa = o.actor;
    if (!oa || !isFoe(o) || oa.staggerT > 0 || this.flying) return;
    const dx = a.x - o.x, dz = a.z - o.z, d = Math.hypot(dx, dz) || 1;
    if (d > 1.9) return;
    play(oa, 'punch', 0.6);
    lookAt(oa, a.x, a.y + 1.3, a.z);
    const J = MATE.counterJ * Math.sqrt(oa.strength) * (0.8 + 0.4 * Math.random()) * dealtBy(o);
    const res = g.crime.combat.hitActor(a, (dx / d) * J, 50, (dz / d) * J, 'punch', 'npc', o.x, o.z);
    g.crime.sound('punch_impact', a.x, a.y + 1.2, a.z, 0.5, 0.9);
    if (res.effect !== 'none' && res.effect !== 'ko' && this.barkT <= 0 && Math.random() < 0.35) this.say('hurt');
  }

  /** Nobody but the bad guys where their power would land (or along its line, or in its cone), the hero well clear of it. */
  private safe(a: PedAgent, t: PedAgent, w: MatePower): boolean {
    const g = this.g, p = g.player.pos, M = MATE_POWERS[w];
    const dx = t.x - a.x, dz = t.z - a.z, d = Math.hypot(dx, dz) || 1e-6, ux = dx / d, uz = dz / d;
    // In the way: inside the area round the target, near the line, in the cone.
    let cx: number, cz: number, reach: number;
    let inIt: (x: number, z: number, slack: number) => boolean;
    if (M.shape === 'area') {
      cx = t.x; cz = t.z; reach = M.R;
      inIt = (x, z, s) => {
        if (Math.hypot(x - t.x, z - t.z) < M.R + s) return true;
        // Thrown: nobody close to its path either.
        const u = Math.max(0, Math.min(1, ((x - a.x) * ux + (z - a.z) * uz) / d));
        return s > 0 && Math.hypot(a.x + dx * u - x, a.z + dz * u - z) < 2.5;
      };
    } else if (M.shape === 'line') {
      const L = Math.min(d + 4, M.max + 6);
      cx = a.x + ux * L / 2; cz = a.z + uz * L / 2; reach = L / 2 + M.R;
      inIt = (x, z, s) => {
        const u = Math.max(0, Math.min(L, (x - a.x) * ux + (z - a.z) * uz));
        return Math.hypot(a.x + ux * u - x, a.z + uz * u - z) < M.R + s;
      };
    } else {
      cx = a.x; cz = a.z; reach = M.R;
      inIt = (x, z, s) => {
        const vx = x - a.x, vz = z - a.z, l = Math.hypot(vx, vz);
        return l < M.R + s && l > 0.2 && (vx * ux + vz * uz) / l > 0.7;
      };
    }
    if (inIt(p.x, p.z, 2)) return false;
    for (const o of g.peds.neighbours(cx, cz, reach, this.tmp)) {
      if (o === t || o === a || !o.alive || o.inside || o.state === PState.Down) continue;
      if (inIt(o.x, o.z, 0) && !isFoe(o)) return false;
    }
    return true;
  }

  private beginCast(a: PedAgent, t: PedAgent, w: MatePower | 'shield'): void {
    if (w !== 'shield') {
      for (const [k, n] of this.used) this.used.set(k, n * 0.5);
      this.used.set(w, (this.used.get(w) ?? 0) + 1);
    }
    const g = this.g, act = this.act!, P = VILLAIN_POWERS[w];
    const tx = t.x, ty = t.y + 1.0, tz = t.z;
    if (!g.crime || !g.crime.casts.cast(a, w, 'begin', tx, ty, tz)) { if (w === 'shield') this.shieldCd = 2; else this.powerCd = 2; return; }
    this.cast = { t: 0, tx, ty, tz, w };
    stand(act);
    lookAt(act, tx, ty, tz);
    play(act, P.pose, P.windup + 0.25);
    g.crime.sound(P.tellSound, a.x, a.y + 1.4, a.z, 0.75, 1.1);
  }

  private casting(a: PedAgent, dt: number): void {
    const g = this.g, C = this.cast!, w = C.w, P = VILLAIN_POWERS[w], act = this.act!;
    C.t += dt;
    stand(act);
    if (w !== 'shield') a.heading = Math.atan2(a.x - C.tx, a.z - C.tz);
    if (act.staggerT > 0) { g.crime.casts.cast(a, w, 'end', C.tx, C.ty, C.tz); this.cast = null; if (w === 'shield') this.shieldCd = 3; else this.powerCd = 3; return; }
    if (C.t < P.windup) { g.crime.casts.cast(a, w, 'tell', C.tx, C.ty, C.tz); return; }
    g.crime.casts.cast(a, w, 'release', C.tx, C.ty, C.tz);
    const atSelf = w === 'shield' || w === 'dash';
    g.crime.sound(P.sound, atSelf ? a.x : C.tx, a.y + 1.2, atSelf ? a.z : C.tz, 0.8, P.pitch ?? 1);
    this.cast = null;
    if (w === 'shield') {
      g.crime.casts.cast(a, w, 'end', C.tx, C.ty, C.tz);
      act.memo.shieldT = P.hold;
      this.shieldCd = 14;
      return;
    }
    if (w === 'dash') {
      // On past where the foe stood (a charge does not stop at the spot).
      const dx = C.tx - a.x, dz = C.tz - a.z, l = Math.hypot(dx, dz) || 1, L = Math.min(P.max, l + 2.5);
      this.rush = { x: a.x + (dx / l) * L, z: a.z + (dz / l) * L, t: 0, hit: false };
      play(act, 'block', P.hold);
    } else g.crime.casts.cast(a, w, 'end', C.tx, C.ty, C.tz);
    this.stats.powers++;
    this.powerCd = MATE.powerCd * (0.85 + 0.3 * Math.random());
  }

  /** The charge: a rush to the end point; the first foe in the way goes flying. */
  private rushing(a: PedAgent, dt: number): void {
    const g = this.g, R = this.rush!, act = this.act!, P = VILLAIN_POWERS.dash;
    R.t += dt;
    goTo(act, R.x, R.z, CASTERS.dashSpeed);
    g.crime?.casts.cast(a, 'dash', 'hold', R.x, a.y, R.z);
    if (!R.hit && g.crime) for (const o of g.peds.neighbours(a.x, a.z, P.radius + 0.4, this.tmp)) {
      if (!isFoe(o) || Math.hypot(o.x - a.x, o.z - a.z) > P.radius + 0.3) continue;
      R.hit = true;
      const dx = R.x - a.x, dz = R.z - a.z, l = Math.hypot(dx, dz) || 1, J = 700 * Math.sqrt(act.strength) * dealtBy(a);
      const res = g.crime.combat.hitActor(o, (dx / l) * J, 150, (dz / l) * J, 'punch', 'npc', a.x, a.z);
      g.crime.sound('punch_impact', o.x, o.y + 1.2, o.z, 0.8, 0.75);
      if (res.effect === 'ko') { this.stats.kos++; this.earn(o.actor?.memo.boss || o.actor?.memo.lt ? MATE_KARMA.lead : MATE_KARMA.ko); }
      break;
    }
    if (Math.hypot(R.x - a.x, R.z - a.z) < 0.7 || R.t > 1.4 || act.stuckT > 0.5) {
      g.crime?.casts.cast(a, 'dash', 'end', R.x, a.y, R.z);
      this.rush = null;
      stand(act);
    }
  }

  /** Wanted with the police about: out of it, on the hero's far side from the nearest officer. */
  private keepOff(a: PedAgent, dt: number): void {
    const g = this.g, p = g.player.pos;
    let ox = p.x + 1, oz = p.z, best = Infinity;
    for (const o of g.peds.neighbours(p.x, p.z, MATE.policeR, this.tmp)) {
      if (o.actor?.role !== 'police') continue;
      const d = Math.hypot(o.x - p.x, o.z - p.z);
      if (d < best) { best = d; ox = o.x; oz = o.z; }
    }
    const dx = p.x - ox, dz = p.z - oz, l = Math.hypot(dx, dz) || 1;
    const x = p.x + (dx / l) * MATE.keepOff, z = p.z + (dz / l) * MATE.keepOff;
    if (!this.spot || Math.hypot(this.spot.x - x, this.spot.z - z) > 12) this.spot = { x, z };
    this.moveTo(a, dt, this.spot.x, this.spot.z, true);
    if (!this.flying) lookAt(this.act!, p.x, p.y + 1.6, p.z);
  }

  // ------------------------------------------------------------------ down, the drones, the ward

  private knockedOut(a: PedAgent): void {
    const g = this.g;
    this.mode = 'down';
    this.cast = null; this.swing = -1; this.counter = null; this.foe = null;
    this.flying = false;
    if (a.airborne) { a.airborne = false; a.fly = undefined; a.state = PState.Down; a.stateT = 0; a.vy = Math.min(a.vy, 0); }
    this.hp = 0;
    g.barks?.hush(a);
    const dh = Math.hypot(a.x - g.player.pos.x, a.z - g.player.pos.z), far = dh > 260;
    // Left alone in a losing fight: the hero was nowhere near.
    if (dh > 60) this.trustBy(TRUST.left);
    this.rush = null; this.helping = null;
    this.carry = { stage: 'wait', t: 0, from: [], body: new THREE.Vector3(a.x, a.y, a.z), heading: a.heading, dir: new THREE.Vector3() };
    if (far) { this.toWard(); return; }
    g.powerHud.toast(`<b>${this.name}</b> is down! The hospital's med drones are on their way`, 'warn', 6000);
    g.audio.chime('deny', 0.45);
  }

  private stepDown(dt: number): void {
    const g = this.g, C = this.carry, a = this.a;
    if (!C || !a || !a.alive) { this.toWard(); return; }
    C.t += dt;
    const F = this.fleet ?? this.makeFleet();
    F.update(dt);
    if (C.stage === 'wait') {
      if (!a.ragdoll) C.body.set(a.x, a.y, a.z);
      if (C.t < MATE.dronesAfter) return;
      C.stage = 'in'; C.t = 0;
      C.heading = a.heading;
      C.from = F.drones.map((_d, i) => new THREE.Vector3(C.body.x + Math.cos(i * 2.1 + 0.4) * 35, C.body.y + 45, C.body.z + Math.sin(i * 2.1 + 0.4) * 35));
      F.group.visible = true;
      F.drones.forEach((d, i) => d.object.position.copy(C.from[i]));
      return;
    }
    if (!a.ragdoll && C.stage === 'in') C.body.set(a.x, a.y, a.z);
    const u = C.stage === 'in' ? smooth(0, 4.2, C.t) : 1;
    const rise = C.stage === 'lift' ? smooth(0.6, 2.6, C.t) * 3.2 : C.stage === 'away' ? 3.2 : 0;
    const body = this.v.copy(C.body);
    body.y += rise;
    if (C.stage === 'away') body.addScaledVector(C.dir, 1);
    F.drones.forEach((d, i) => {
      const [sx, sz] = SLOTS[i];
      const c = Math.cos(C.heading), s = Math.sin(C.heading);
      const slot = new THREE.Vector3(body.x + sx * c + sz * s, body.y + 3.1 + Math.sin(C.t * 2.1 + i * 2) * 0.12, body.z - sx * s + sz * c);
      if (C.stage === 'in') d.object.position.lerpVectors(C.from[i], slot, u);
      else d.object.position.copy(slot);
      d.aim(C.stage === 'in' && u < 0.9 ? null : body, C.stage === 'in' ? (u - 0.9) * 10 : 1);
    });
    if (C.stage === 'in' && C.t >= 4.2) {
      C.stage = 'lift'; C.t = 0;
      g.audio.play('whoosh_takeoff', C.body.x, C.body.y + 2, C.body.z, 0.5, 0.7, 6, g.renderer.camera.position);
    }
    if (C.stage === 'lift' || C.stage === 'away') {
      // The body in the field, held by the beams.
      if (C.stage === 'lift' && C.t > 0.45 && !a.airborne) {
        if (a.ragdoll || g.ragdolls.isActive(a)) g.ragdolls.release(a);
        a.ragdoll = false;
        a.airborne = true;
        a.state = PState.Down;
        a.fly = undefined;
      }
      if (a.airborne) { a.x = body.x; a.y = body.y; a.z = body.z; a.heading = C.heading; a.vx = a.vy = a.vz = 0; }
      F.field.visible = !!a.airborne;
      F.field.position.set(body.x, body.y + 0.35, body.z);
      F.field.rotation.set(Math.PI / 2, C.heading, 0);
    }
    if (C.stage === 'lift' && C.t >= 2.6) {
      C.stage = 'away'; C.t = 0;
      const p = g.player.pos, dx = C.body.x - p.x, dz = C.body.z - p.z, l = Math.hypot(dx, dz) || 1;
      C.dir.set(dx / l, 0, dz / l);
    }
    if (C.stage === 'away') {
      // Up and off towards the hospital (away from the hero), faster and faster.
      const s = 3 * C.t * C.t + 4 * C.t;
      C.dir.y = 0;
      const l = Math.hypot(C.dir.x, C.dir.z) || 1;
      C.dir.set((C.dir.x / l) * s, s * 0.45, (C.dir.z / l) * s);
      if (C.t > 12 || (C.t > 4 && !this.seen(body.x, body.y, body.z))) this.toWard();
    }
  }

  private makeFleet(): MedFleet {
    const F = new MedFleet(3);
    F.group.name = 'sidekick-drones';
    this.g.renderer.scene.add(F.group);
    this.fleet = F;
    return F;
  }

  /** Off to the revival ward: the body goes (they come back, or not, later). */
  private toWard(): void {
    const g = this.g, a = this.a;
    if (this.fleet) { this.fleet.group.visible = false; this.fleet.field.visible = false; }
    if (a && a.alive) {
      if (g.ragdolls.isActive(a)) g.ragdolls.release(a);
      a.ragdoll = false; a.airborne = false; a.fly = undefined;
      a.actor = undefined;
      a.alive = false;
    }
    this.a = null; this.act = null; this.carry = null; this.flying = false;
    this.mode = 'ward';
    this.wardT = MATE.wardTime;
    g.peds.absent.add(this.who);
    this.k++;
    this.stats.taken++;
    g.powerHud.toast(`The drones took <b>${this.name}</b> to the hospital's revival ward`, 'warn', 6000);
    this.hooks.persist();
  }

  /** Out of the ward: back (most of the time), or not. */
  private outOfWard(): void {
    const g = this.g;
    g.peds.absent.delete(this.who);
    if (revives(g.settings.seed, this.who, this.k)) {
      this.stats.returned++;
      this.mode = this.away === 'home' ? 'home' : 'around';
      this.hp = this.maxHp();
      this.sayBack = true;
      g.powerHud.toast(`<b>${this.name}</b> pulled through and is on the way back to you`, 'core', 6000);
      g.audio.chime('core', 0.4);
      this.hooks.persist();
      return;
    }
    this.mode = 'gone';
    this.hooks.died();
  }

  // ------------------------------------------------------------------ words

  private say(what: MateSay, force = false, word = 'friend'): void {
    const a = this.a;
    if (!a || !this.g.barks || (!force && this.barkT > 0)) return;
    this.barkT = MATE.barkGap;
    this.g.barks.line(a, mateLine(what, this.temper, Math.random()).replace(/\{word\}/g, word));
  }

  // ------------------------------------------------------------------ growth (phase 3)

  /** Health and punch strength with what they bought. */
  maxHp(): number { return Math.round(MATE.hp * (1 + 0.3 * (this.ranks.toughness ?? 0))); }
  private strength(): number { return MATE.strength * (1 + 0.25 * (this.ranks.strength ?? 0)); }

  /** Do they have this (the sandbox gives them everything)? */
  has(g: Gift): boolean { return this.g.progress.sandbox || (this.ranks[g] ?? 0) > 0; }

  /** Their attack powers, favourite first (with a little luck each time); what they just used
   *  falls back a little, so someone with many powers mixes them rather than repeating one. */
  private attacks(): MatePower[] {
    const list = (Object.keys(MATE_POWERS) as MatePower[]).filter((w) => this.has(w));
    const sc = new Map(list.map((w) => [w, (leaning(w, this.traits) * (0.75 + 0.5 * Math.random()) + (w === this.power ? 0.15 : 0)) * Math.pow(0.45, this.used.get(w) ?? 0)]));
    return list.sort((x, y) => sc.get(y)! - sc.get(x)!);
  }

  /** What they save for now: a wish they took to heart, else what suits them. */
  want(): Gift | null {
    if (this.wish && nextCost(this.wish, this.ranks) !== null) return this.wish;
    return nextWant(this.traits, this.ranks, this.g.settings.seed, this.who, this.bought);
  }

  /** Karma of their own, for a deed; they buy what they save for once they can. */
  earn(n: number): void {
    if (this.g.progress.sandbox || n <= 0) return;
    this.karma += n;
    this.earned += n;
    this.tryBuy();
    this.hooks.persist();
  }

  private tryBuy(): void {
    for (let i = 0; i < 12; i++) {
      const w = this.want();
      const c = w ? nextCost(w, this.ranks) : null;
      if (!w || c === null || this.karma < c) return;
      this.karma -= c;
      this.ranks[w] = (this.ranks[w] ?? 0) + 1;
      this.bought++;
      this.stats.bought++;
      if (this.wish === w) this.wish = null;
      const act = this.act;
      if (act) { act.strength = this.strength(); act.maxHp = this.maxHp(); }
      const r = this.ranks[w]!, many = ROSTER[w].cost.length > 1;
      this.g.powerHud.toast(`<b>${this.name}</b> spent ${c} karma on <b>${ROSTER[w].name}</b>${many ? ` (rank ${r})` : ''}: ${ROSTER[w].what}`, 'karma', 6000);
      if (this.a) { this.barkT = MATE.barkGap; this.g.barks?.line(this.a, buyLine(w, this.temper, Math.random())); }
    }
  }

  /** The hero gives them karma (taken from the hero's balance by the caller), maybe with a wish. What they say. */
  give(n: number, wish: Gift | null): string {
    const share = n / Math.max(10, this.karma + n);
    this.karma += n;
    this.trustBy(Math.min(TRUST.giftMax, n * TRUST.giftPer));
    let line = giftLine(this.temper, share, Math.random());
    if (wish && nextCost(wish, this.ranks) !== null) {
      const yes = honoursWish(wish, this.trust, this.traits, Math.random());
      if (yes) this.wish = wish;
      line += ' ' + wishLine(yes, wish, this.temper, Math.random());
    }
    this.tryBuy();
    this.hooks.persist();
    return line;
  }

  /** How they are getting on (their talk line). */
  describe(): string {
    const have = (Object.keys(this.ranks) as Gift[]).filter((g) => (this.ranks[g] ?? 0) > 0).map((g) => ROSTER[g].name.toLowerCase());
    const w = this.want(), c = w ? nextCost(w, this.ranks) : null;
    const list = have.length > 1 ? `${have.slice(0, -1).join(', ')} and ${have[have.length - 1]}` : have[0] ?? 'nothing yet';
    const save = w && c !== null ? ` I'm saving for ${ROSTER[w].name.toLowerCase()}: ${this.karma} of ${c} karma.` : this.karma ? ` I've got ${this.karma} karma put by.` : '';
    const feel = this.trust < 20 ? 'I\'m not sure about you, to be honest.' : this.trust < 40 ? 'Still getting to know you.' : this.trust < 60 ? 'I think we make a decent team.' : this.trust < 80 ? 'I trust you.' : 'I\'d follow you anywhere.';
    return `Flying, ${list}.${save} ${feel}`;
  }

  // ------------------------------------------------------------------ trust and asks (phase 4)

  trustBy(n: number): void {
    this.trust = Math.max(0, Math.min(TRUST.max, this.trust + n));
  }

  /** The hero asks something in the talk menu. What they say. */
  ask(k: Ask): string {
    const fight = this.foes.length > 0;
    if (k === 'help') {
      const r = askAnswer('help', this.trust, this.traits, this.temper, { fight }, Math.random());
      if (r.ok) { this.away = 'none'; this.calledT = MATE.calledFor; if (this.mode === 'home') this.mode = 'around'; }
      else this.stats.refused++;
      return r.line;
    }
    const r = askAnswer(k, this.trust, this.traits, this.temper, { fight }, Math.random());
    if (!r.ok) { this.stats.refused++; return r.line; }
    if (r.against) this.trustBy(TRUST.against);
    if (k === 'back') { this.away = 'hold'; this.calledT = 0; this.spot = null; }
    else if (k === 'come') { this.away = 'none'; if (this.mode === 'home') this.mode = 'around'; }
    else if (k === 'home') this.goHome();
    this.hooks.persist();
    return r.line;
  }

  /** Back to their own day: the body goes back to the city's people until called. */
  private goHome(): void {
    const a = this.a;
    this.away = 'home';
    this.calledT = 0;
    if (a && a.alive && a.actor === this.act) {
      if (a.airborne) { a.airborne = false; a.fly = undefined; a.y = this.g.collision.groundAt(a.x, a.z, a.y, 400); a.vx = a.vy = a.vz = 0; }
      a.actor = undefined;
      // (Moving again: their own day picks up from here.)
      if (a.state !== PState.Down) { a.state = PState.Flee; a.fear = 0; a.fearX = a.x; a.fearZ = a.z; a.stateT = 0; }
    }
    this.a = null; this.act = null; this.flying = false; this.cast = null; this.rush = null; this.helping = null;
    if (this.mode !== 'ward' && this.mode !== 'down') this.mode = 'home';
  }

  /** Someone knocked down: by the hero, near them, they mind (more so someone close to them). */
  onKnock(o: PedAgent, cause: DownCause): void {
    const a = this.a;
    if (cause !== 'player' || !a || this.mode === 'gone' || this.mode === 'home' || o === a || o.actor?.hostile) return;
    if (Math.hypot(o.x - a.x, o.z - a.z) > 50) return;
    const last = this.hurtSeen.get(o.cit.id) ?? -1e9;
    if (this.time - last < 30) return;
    this.hurtSeen.set(o.cit.id, this.time);
    const close = this.cit() ? bondOf(this.cit()!, o.cit) : null;
    this.trustBy(close ? TRUST.hurtFriend : TRUST.hurt);
    if (this.barkT <= 0 || close) this.say('wary', true);
  }

  /** The hero helped or saved someone: someone close to them earns the hero trust. */
  onDeed(o: PedAgent, d: Deed): void {
    if ((d !== 'helped' && d !== 'saved') || this.mode === 'gone') return;
    const me = this.cit();
    const b = me ? bondOf(me, o.cit) : null;
    if (!b || !me) return;
    this.trustBy(TRUST.friend);
    if (this.a && Math.hypot(this.a.x - o.x, this.a.z - o.z) < 80) this.say('friend', true, bondWord(b, o.cit, me));
  }

  private cit() { return this.g.people.find(this.who)?.cit ?? null; }

  // ------------------------------------------------------------------ dev

  status(): Record<string, unknown> {
    const a = this.a, p = this.g.player.pos;
    return {
      mode: this.mode, name: this.name, temper: this.temper, style: this.style, power: this.power, hp: Math.round(this.hp), maxHp: this.maxHp(), k: this.k, ward: Math.round(this.wardT),
      karma: this.karma, earned: this.earned, ranks: { ...this.ranks }, want: this.want(), wish: this.wish, trust: Math.round(this.trust), away: this.away,
      flying: this.flying, called: this.calledT > 0, foes: this.foes.length, police: this.policeNear,
      body: a ? { x: +a.x.toFixed(1), y: +a.y.toFixed(1), z: +a.z.toFixed(1), d: Math.round(Math.hypot(a.x - p.x, a.z - p.z)), state: a.state, act: a.actor?.state ?? null } : null,
      stats: { ...this.stats },
    };
  }

  /** For the info panel (clicking them): who they are, how they are, what they can do. */
  panel(): MatePanel {
    const powers: MatePanel['powers'] = [];
    for (const g of GIFTS) {
      const max = ROSTER[g].cost.length;
      const rank = this.g.progress.sandbox ? max : this.ranks[g] ?? 0;
      if (rank > 0) powers.push({ name: ROSTER[g].name, rank, max, first: g === this.power });
    }
    const want = this.g.progress.sandbox ? null : this.want();
    return {
      name: this.name, temper: this.temper, mode: this.mode, away: this.away, flying: this.flying,
      hp: Math.round(this.hp), maxHp: Math.round(this.maxHp()),
      karma: Math.round(this.karma), want: want ? ROSTER[want].name : null, wantCost: want ? nextCost(want, this.ranks) : null, wished: !!want && want === this.wish,
      trust: Math.round(this.trust), trustWord: trustWord(this.trust), powers,
    };
  }

  /** dev: knock them out now. */
  devKo(): void {
    const a = this.a;
    if (!a || !this.act || !this.g.crime) return;
    this.act.hp = 1;
    this.g.crime.combat.hitActor(a, 600, 200, 0, 'punch', 'npc');
  }

  /** dev: out of the ward now (true: they make it, false: they do not, undefined: the roll). */
  devWard(make?: boolean): void {
    if (this.mode !== 'ward') return;
    if (make === undefined) { this.wardT = 0; return; }
    this.g.peds.absent.delete(this.who);
    if (make) { this.mode = 'around'; this.hp = this.maxHp(); this.sayBack = true; this.hooks.persist(); }
    else { this.mode = 'gone'; this.hooks.died(); }
  }
}

/** Fighting the hero's side right now: a hostile criminal still on their feet. */
function isFoe(o: PedAgent): boolean {
  const act = o.actor;
  return !!o.alive && fightingCrook(act) && act!.state !== 'down' && o.state !== PState.Down;
}
