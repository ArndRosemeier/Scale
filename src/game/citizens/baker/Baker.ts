/**
 * The weather-moody baker: a well-known citizen of the city (not a hero, not a villain). Earlier
 * in the year he bit into a crystal he found in a flour sack, and since then the weather over his
 * street follows his heart: a little rain cloud hangs over him when he is sad, his street gets
 * drizzle, rain or (when he is cross) a thunderstorm, and when he is happy the sun comes out over
 * his street whatever the rest of the city is doing.
 *
 * Where: in front of his bakery (the city's most central bakery for the seed, found once by
 * HomeShopSearch), from just before opening at 6:00 until he locks up at 19:00. At night he sleeps
 * and the sky over his street is the city's.
 *
 * Mood (mood.ts): every day has its own baseline (a bad day with a reason, an ordinary one, a good
 * one); talking to him and cheering him up (talk panel options, kind typed words, a crime stopped
 * near his street) lifts it, harm near his shop and a blow to him lower it (a blow makes him cross:
 * thunder). Cheering him up from a gloom into sunshine is a small good deed (karma, reputation),
 * once a day.
 *
 * He is an actor of BAKER_OWNER (role shopkeeper, so People lets the hero talk to him). Danger nearby
 * sends him into his shop for a while; knocked over, he is someone else's (a ragdoll) until he is
 * back on his feet, then he walks back to his door.
 */
import type { Game } from '../../Game';
import type { WeatherParams } from '../../../world/weather';
import { PState, isBystander, type PedAgent } from '../../../sim/Pedestrians';
import { Role, type Citizen } from '../../../sim/Population';
import { makeActor, attach, hold, goTo, stand, BAKER_OWNER, type Actor } from '../../../sim/actors/Actor';
import { Eatery, eateryName } from '../../../plan/eatery';
import { Rng, hash32, deriveSeed } from '../../../core/rng';
import { clamp, smoothstep } from '../../../core/math';
import type { Stimulus } from '../../Stimuli';
import type { HarmEntry } from '../../Consequences';
import type { EquipmentVisuals, ItemVisual } from '../../../items/types';
import { HomeShopSearch, type CityCitizen, type HomeShop } from '../Citizens';
import { MOOD, bakerDay, stepMood, nudge, moodWeight, moodWeather, moodWord, type MoodState, type BakerDay } from './mood';
import { TROUBLES, JOYS, BUBBLE, STREET, GOSSIP, HELLO, CRYSTAL, CHEER, JOKES, THANKS, fill } from './lines';
import { RainCloud } from './cloud';

/** He is out within these game hours. */
const OPEN = 6, CLOSE = 19;
/** He is spawned when the player comes within SPAWN_R m of his shop, and goes beyond DROP_R. */
const SPAWN_R = 160, DROP_R = 230;
/** Bubbles only when the player is this close (m). */
const HEAR_R = 32;
/** Karma and reputation for cheering him up from a gloom into sunshine (once a game day). */
const CHEER_KARMA = 6, CHEER_REP = 1;

type Ways = 'bread' | 'joke' | 'buy' | 'hug' | 'pep' | 'sky' | 'sorry' | 'ask' | 'crystal';

interface SavedBaker { mood: number; anger: number; cheeredDay: number; day: number }

export class Baker implements CityCitizen {
  readonly id = 'baker';
  readonly label = 'The weather-moody baker';
  readonly s: MoodState = { mood: 0, anger: 0 };
  /** His shop (null until found). */
  shop: HomeShop | null = null;
  bakery = 'the bakery';
  street = 'his street';
  readonly cit: Citizen;
  a: PedAgent | null = null;
  act: Actor | null = null;
  readonly cloud = new RainCloud();
  /** Off: he never comes out (dev, tests). */
  enabled = true;
  private search: HomeShopSearch;
  private fallback: HomeShop | null = null;
  private dayN = -1;
  private today: BakerDay = { base: 0, reason: -1, kind: 'fair' };
  private cheeredDay = -1;
  /** Game hours until which he stays inside (after a scare, a blow). */
  private awayUntil = -1;
  private rng: Rng;
  private bubbleT = 6;
  private streetT = 12;
  private fidgetT = 4;
  private greeted = false;
  /** Talk session this one is about (a new talk lifts his mood a little, once). */
  private talkedTo: PedAgent | null = null;
  /** Uses of each way to cheer him this game hour (diminishing returns). */
  private used = new Map<Ways, number>();
  private usedHour = -1;
  private harmT = 0;
  private time = 0;
  private wasGloom = false;
  /** Weight of his weather right now (status). */
  weight = 0;
  readonly stats = { spawned: 0, cheered: 0, scared: 0, hit: 0 };

  constructor(private g: Game) {
    this.rng = new Rng(deriveSeed(g.settings.seed, 'baker'));
    this.cit = this.pickCitizen();
    this.search = new HomeShopSearch(g, ['oldtown', 'rowhouses', 'apartments', 'commercial', 'downtown', 'suburban'], 0xba4e, (plan, cell) => {
      let best: HomeShop | null = null;
      for (const ep of plan.eateries) {
        const shop: HomeShop = { cell, b: ep.b, x: ep.door[0], z: ep.door[1], nx: ep.nx, nz: ep.nz, ux: ep.ux, uz: ep.uz };
        if (ep.kind === Eatery.Bakery) { best = shop; this.bakery = eateryName(g.settings.seed, cell, ep.b, ep.kind); break; }
        if (!this.fallback && ep.kind === Eatery.Cafe) this.fallback = shop;
      }
      return best;
    });
    g.renderer.scene.add(this.cloud.object);
    g.weather.locals.push((t) => this.weather(t));
    g.stimuli.on((st) => this.onStimulus(st));
    const prevRec = g.consequences.onRecord;
    g.consequences.onRecord = (e) => { prevRec?.(e); this.onHarm(e); };
    g.crime.onReward.push((d) => { if (d.stopped) this.onStopped(); });
    g.people.onWords.push((a, op) => { if (a === this.a && this.act && a.actor === this.act) this.words(op); });
    const prevOpt = g.people.extraOptions;
    g.people.extraOptions = (a) => [...(prevOpt?.(a) ?? []), ...this.options(a)];
  }

  /** A grown man of the city, the same one for the seed. */
  private pickCitizen(): Citizen {
    const pop = this.g.population;
    let fallback: Citizen | null = null;
    for (let k = 0; k < 60; k++) {
      const c = pop.synthetic(hash32(this.g.settings.seed ^ (0xba4e5 + k * 7919)) || 1);
      if (c.role === Role.Child || c.role === Role.Senior) continue;
      fallback ??= c;
      if (c.gender > 0.5) return c;
    }
    return fallback ?? pop.synthetic(0xba4e5);
  }

  get first(): string { return this.g.people.person(this.cit).first; }
  get full(): string { return this.g.people.person(this.cit).full; }
  private names() { return { first: this.first, bakery: this.bakery, street: this.street }; }

  /** Where he is (or his shop's door when he is inside): null until the shop is found. */
  where(): { x: number; z: number } | null {
    if (this.a?.alive) return { x: this.a.x, z: this.a.z };
    return this.shop ? { x: this.shop.x + this.shop.nx, z: this.shop.z + this.shop.nz } : null;
  }

  private get hours(): number { return this.g.sky.hoursAbs; }
  private get atWork(): boolean { const h = ((this.hours % 24) + 24) % 24; return h >= OPEN && h < CLOSE; }

  // ================================================================== per frame

  update(dt: number): void {
    const g = this.g;
    this.time += dt;
    if (!this.shop) {
      if (this.search.step()) {
        this.shop = this.search.found ?? this.fallback;
        if (this.shop) this.street = g.people.streetAt(this.shop.x, this.shop.z) ?? 'his street';
      }
      if (!this.shop) return;
    }
    // His day and his mood.
    const day = Math.floor(this.hours / 24);
    if (day !== this.dayN) {
      this.dayN = day;
      this.today = bakerDay(g.settings.seed, day, TROUBLES.length, JOYS.length);
      // (A new game: he starts the day in its mood.)
      if (!this.restored) { this.restored = true; this.s.mood = this.today.base; }
    }
    stepMood(this.s, this.today.base, (dt * g.sky.timeScale) / 3600);
    const hr = Math.floor(this.hours);
    if (hr !== this.usedHour) { this.usedHour = hr; this.used.clear(); }
    this.harmT = Math.max(0, this.harmT - dt);
    this.presence();
    this.cloudStep(dt);
    if (!this.a || !this.act) return;
    this.step(dt);
  }

  /** Out at his door in his hours when the player is near; gone otherwise. */
  private presence(): void {
    const g = this.g, sh = this.shop!, f = g.freeCam ? g.renderer.camera.position : g.player.pos;
    const d = Math.hypot(sh.x - f.x, sh.z - f.z);
    const a = this.a;
    // Lost him: dead, despawned, or taken over (a ragdoll, another owner) and not ours again.
    if (a && (!a.alive || (a.actor !== this.act && !a.ragdoll && a.state !== PState.Down && a.actor))) { this.lose(); return; }
    if (a && !a.actor && !a.ragdoll && a.state !== PState.Down && a.alive) {
      // Back on his feet after a fall (or calm after a fright): ours again, back to the door.
      if (a.fear < 0.3) { this.act = attach(a, this.makeAct()); }
    }
    const want = this.enabled && this.atWork && this.hours >= this.awayUntil && !g.camRig.underground;
    if (this.a) {
      const far = Math.hypot(this.a.x - f.x, this.a.z - f.z) > DROP_R && !g.crime.visible(this.a.x, this.a.y + 1, this.a.z);
      if (far || (!want && this.a.actor === this.act && this.act?.state !== 'run')) this.goInside(far);
      return;
    }
    if (!want || d > SPAWN_R) return;
    const x = sh.x + sh.nx * 1.0, z = sh.z + sh.nz * 1.0;
    const o = g.peds.spawnAt(this.cit, x, z, Math.atan2(-sh.nx, -sh.nz));
    if (!o) return;
    this.a = o;
    this.act = attach(o, this.makeAct());
    o.pref = 1.2;
    this.greeted = false;
    this.stats.spawned++;
  }

  private makeAct(): Actor {
    return makeActor('shopkeeper', BAKER_OWNER, { title: 'Baker', outfit: bakerOutfit(this.cit.seed), held: null, hp: 40, maxHp: 40 });
  }

  /** Into the shop (or simply gone, when nobody sees it). */
  private goInside(unseen: boolean): void {
    const a = this.a;
    if (!a) return;
    if (unseen || !this.act || a.actor !== this.act) { this.lose(); return; }
    const sh = this.shop!;
    const dd = Math.hypot(a.x - sh.x, a.z - sh.z);
    if (dd > 0.6 && this.act.stuckT < 3) { goTo(this.act, sh.x, sh.z, 1.3); return; }
    this.lose();
  }

  private lose(): void {
    const a = this.a;
    if (a && a.alive && (a.actor === this.act || !a.actor) && !a.ragdoll) a.alive = false;
    this.a = null;
    this.act = null;
    this.talkedTo = null;
  }

  private step(dt: number): void {
    const g = this.g, a = this.a!, act = this.act!, sh = this.shop!;
    if (a.actor !== act || a.ragdoll || a.state === PState.Down) return;
    // A blow from the hero: hurt, cross, thunder, and inside for a while.
    if (act.hitByPlayer) {
      act.hitByPlayer = false;
      this.stats.hit++;
      nudge(this.s, -0.5, 0.85);
      this.bubble(BUBBLE.furious, 6, 'angry');
      g.people.note(a, 'hurt');
      this.scare(0.6);
      return;
    }
    if (act.state === 'run') { // (scared off: into the shop)
      this.goInside(false);
      return;
    }
    act.mood = this.s.anger > 0.35 ? 'angry' : this.s.mood > 0.25 ? 'happy' : this.s.mood < -0.15 ? 'sad' : 'neutral';
    const P = g.player, dp = Math.hypot(P.pos.x - a.x, P.pos.z - a.z);
    const talking = g.people.partner === a;
    if (talking && this.talkedTo !== a) { this.talkedTo = a; nudge(this.s, 0.06); }
    if (!talking && dp > 12) this.talkedTo = null;
    // Home spot: just outside the door, facing the street.
    const hx = sh.x + sh.nx * 1.0, hz = sh.z + sh.nz * 1.0;
    if (talking) { stand(act); act.face = { x: P.pos.x, y: P.pos.y + P.height * 0.9, z: P.pos.z }; return; }
    this.fidgetT -= dt;
    const home = Math.hypot(a.x - hx, a.z - hz);
    if (act.goal && act.stuckT < 3 && Math.hypot(act.goal.x - a.x, act.goal.z - a.z) > 0.4) { /* walking */ }
    else if (home > 6 || act.stuckT >= 3) { act.stuckT = 0; goTo(act, hx, hz, 1.1); }
    else stand(act);
    // Something to do now and then: a few steps along the shop front, a wave, a sigh.
    if (this.fidgetT <= 0) {
      this.fidgetT = 7 + this.rng.float() * 12;
      const sad = this.s.mood < -0.2, happy = this.s.mood > 0.3;
      const u = this.rng.float();
      if (u < 0.35) {
        const off = (this.rng.float() * 2 - 1) * 3.5;
        goTo(act, hx + sh.ux * off, hz + sh.uz * off, sad ? 0.7 : 1.0);
      } else if (u < 0.6) {
        const by = g.peds.nearest(a.x, a.z, 9, (o) => o !== a && isBystander(o));
        if (by) { act.face = { x: by.x, y: by.y + 1.5, z: by.z }; hold(act, happy ? 'gesture_wave' : sad ? 'gesture_shrug' : 'gesture_wave', 1.6); }
      } else if (u < 0.8) {
        act.face = { x: hx + sh.nx * 5, y: a.y + 1.6, z: hz + sh.nz * 5 };
        hold(act, sad ? 'hands_on_head' : happy ? 'clap' : 'offer', sad ? 2.2 : 1.6);
      } else {
        act.face = { x: hx + sh.nx * 5, y: a.y + (sad ? 1.0 : 2.4), z: hz + sh.nz * 5 };
      }
    }
    // Greets the hero coming up to him, then talks to himself now and then.
    if (!this.greeted && dp < 7 && !P.flying) {
      this.greeted = true;
      act.face = { x: P.pos.x, y: P.pos.y + P.height * 0.9, z: P.pos.z };
      hold(act, 'gesture_wave', 1.5);
      this.bubble(this.s.anger > 0.35 ? BUBBLE.furious : this.s.mood < -0.15 ? BUBBLE.glum : BUBBLE.cheerful, 5);
    }
    if (dp > 25) this.greeted = false;
    this.bubbleT -= dt;
    if (this.bubbleT <= 0 && dp < HEAR_R) {
      this.bubbleT = 14 + this.rng.float() * 14;
      const w = moodWord(this.s);
      this.bubble(w === 'furious' ? BUBBLE.furious : w === 'heartbroken' ? BUBBLE.heartbroken : w === 'glum' ? BUBBLE.glum : w === 'all right' ? BUBBLE.fine : w === 'cheerful' ? BUBBLE.cheerful : BUBBLE.beaming, 5, w === 'furious' ? 'angry' : undefined);
    }
    this.streetTalk(dt, dp);
    this.cheerCheck();
  }

  private bubble(list: string[], pause: number, tone?: 'angry' | 'cheer'): void {
    if (!this.a) return;
    this.g.barks?.say(this.a, fill(this.rng.pick(list), this.names()), pause, tone);
  }

  /** His neighbours remark on the weather he makes. */
  private streetTalk(dt: number, dp: number): void {
    this.streetT -= dt;
    if (this.streetT > 0 || dp > 60) return;
    this.streetT = 18 + this.rng.float() * 20;
    if (this.weight < 0.4) return;
    const list = this.s.anger > 0.3 ? STREET.storm : this.s.mood < 0 ? STREET.gloom : STREET.sun;
    const P = this.g.player.pos, a = this.a!;
    const o = this.g.peds.nearest(P.x, P.z, 22, (x) => x !== a && isBystander(x) && Math.hypot(x.x - a.x, x.z - a.z) < 70);
    if (o) this.g.barks?.say(o, fill(this.rng.pick(list), this.names()), 5);
  }

  /** From a gloom to sunshine: a small good deed, once a day. */
  private cheerCheck(): void {
    const gloom = this.s.mood < MOOD.gloomAt;
    if (gloom) this.wasGloom = true;
    if (this.wasGloom && this.s.mood > MOOD.sunAt && this.s.anger < 0.2) {
      this.wasGloom = false;
      if (this.cheeredDay === this.dayN) return;
      this.cheeredDay = this.dayN;
      this.stats.cheered++;
      const g = this.g;
      if (g.people.partner === this.a) g.people.speak(THANKS);
      else this.bubble([THANKS], 7, 'cheer');
      g.crime.reward({ karma: CHEER_KARMA, rep: CHEER_REP, why: `cheered up ${this.first} the baker` });
      g.powerHud?.toast(`The sun comes out over <b>${this.street}</b>. ${this.first} is smiling again.`, 'info', 5200);
    }
  }

  // ================================================================== his weather

  /** Pull the city's weather towards his, near him (the camera's distance to him or his shop). */
  private weather(t: WeatherParams): void {
    this.weight = 0;
    if (!this.shop || !this.enabled) return;
    const h = ((this.hours % 24) + 24) % 24;
    // Out (or in the shop) in his hours; asleep at night, the sky is the city's. Fades in and out over half an hour.
    const awake = smoothstep(OPEN - 0.5, OPEN, h) * (1 - smoothstep(CLOSE, CLOSE + 0.5, h));
    if (awake <= 0) return;
    const c = this.g.renderer.camera.position, w = this.where()!;
    this.weight = moodWeight(this.s, Math.hypot(c.x - w.x, c.z - w.z)) * awake;
    moodWeather(this.s, this.weight, t);
  }

  private cloudStep(dt: number): void {
    const a = this.a, g = this.g;
    if (!a || !a.alive || a.inside) { this.cloud.update(dt, 0, 0, 0, 1.8, 0, 0, 0, 0); return; }
    const sad = smoothstep(MOOD.gloomAt, -0.6, this.s.mood);
    const want = Math.max(sad, smoothstep(0.05, 0.4, this.s.anger));
    const rain = clamp(sad * 0.8 + this.s.anger * 0.6, 0, 1);
    this.cloud.update(dt, a.x, a.y, a.z, 1.8, want, rain, this.s.anger, g.camRig?.yaw ?? 0);
  }

  // ================================================================== what happens around him

  /** Danger near him: into the shop for a while (game hours). */
  private scare(hours: number): void {
    const a = this.a, act = this.act;
    this.awayUntil = Math.max(this.awayUntil, this.hours + hours);
    this.stats.scared++;
    if (a && act && a.actor === act) { act.state = 'run'; act.stateT = 0; }
  }

  private onStimulus(st: Stimulus): void {
    const a = this.a;
    if (!a || !this.act || a.actor !== this.act) return;
    const d = Math.hypot(a.x - st.x, a.z - st.z);
    if (d > st.radius) return;
    if (st.kind === 'blast' || st.kind === 'collapse' || st.kind === 'gunfire' || st.kind === 'roar' || st.kind === 'threat' || (st.kind === 'power' && d < st.radius * 0.6)) {
      nudge(this.s, -0.12);
      this.bubble(['Oh no, no, no!', 'Not the windows!', 'Everybody inside!'], 3);
      this.scare(0.35);
    }
  }

  /** Harm done near his shop: it breaks his heart a little (and his shop front: he is cross). */
  private onHarm(e: HarmEntry): void {
    const sh = this.shop;
    if (!sh || e.cause !== 'player' || this.harmT > 0) return;
    const d = Math.hypot(e.x - sh.x, e.z - sh.z);
    if (d > 70) return;
    if (e.target !== 'building' && e.target !== 'car' && e.target !== 'prop' && e.target !== 'person') return;
    this.harmT = 6;
    nudge(this.s, d < 18 ? -0.25 : -0.1, d < 18 && e.target === 'building' ? 0.5 : 0.05);
  }

  /** A crime stopped near his street: a hero on his street! */
  private onStopped(): void {
    const sh = this.shop, P = this.g.player.pos;
    if (!sh || Math.hypot(P.x - sh.x, P.z - sh.z) > 130) return;
    nudge(this.s, 0.3);
    if (this.a && Math.hypot(P.x - this.a.x, P.z - this.a.z) < 60) this.bubble(['Bravo! Bravo!', 'My hero! Free rolls!', 'That\'s the way!'], 4, 'cheer');
  }

  /** Typed words in the talk panel (their opinion change: + kind, - rude). */
  private words(op: number): void {
    if (op > 0) nudge(this.s, Math.min(0.2, op * 0.03));
    else if (op < 0) nudge(this.s, Math.max(-0.3, op * 0.03), op <= -8 ? 0.3 : 0);
  }

  // ================================================================== talking

  private options(a: PedAgent): { label: string; run: () => void }[] {
    if (!this.a || a !== this.a) return [];
    const P = this.g.people, sad = this.s.mood < MOOD.gloomAt, cross = this.s.anger > 0.35;
    const say = (t: string) => P.speak(fill(t, this.names()));
    const list: { label: string; run: () => void }[] = [];
    if (cross) list.push({ label: 'I\'m sorry. I really am.', run: () => this.cheer('sorry', 0.12, 0.9, ['Hmph. Well. Apology… accepted. Mostly.', 'Sorry doesn\'t un-break things, you know.']) });
    if (sad && !cross) list.push({ label: 'You look a bit down. What\'s wrong?', run: () => { say(this.today.kind === 'bad' && this.today.reason >= 0 ? TROUBLES[this.today.reason] : 'Oh, nothing. Everything. You know how it is.'); this.mark('ask'); } });
    if (this.today.kind === 'good' && !sad) list.push({ label: 'You look happy today!', run: () => say(JOYS[Math.max(0, this.today.reason)]) });
    list.push({ label: 'About this weather of yours…', run: () => P.choices(this.cheerList()) });
    return list;
  }

  private cheerList(): { label: string; run: () => void }[] {
    const sad = this.s.mood < MOOD.gloomAt;
    const list: { label: string; run: () => void }[] = [
      { label: 'How did the weather thing start?', run: () => { this.g.people.speak(fill(CRYSTAL[this.used.get('crystal') ? 1 : 0], this.names())); this.mark('crystal'); } },
      { label: 'Your bread smells wonderful.', run: () => this.cheer('bread', 0.18, 0.95, CHEER.bread) },
      { label: 'Want to hear a joke?', run: () => this.joke() },
      { label: 'I\'ll take a loaf, please.', run: () => this.cheer('buy', 0.16, 1, CHEER.buy) },
    ];
    if (sad) {
      list.push({ label: 'Chin up! Tomorrow\'s a new batch.', run: () => this.cheer('pep', 0.15, 0.7, CHEER.pep) });
      list.push({ label: 'Come here. Hug?', run: () => this.cheer('hug', 0.4, 1, CHEER.hug, true) });
    } else list.push({ label: 'Lovely weather on your street!', run: () => this.cheer('sky', 0.12, 1, CHEER.sky) });
    return list;
  }

  private mark(w: Ways): number {
    const n = this.used.get(w) ?? 0;
    this.used.set(w, n + 1);
    return n;
  }

  /** A way to cheer him: works with chance `p` (less each time this hour); a hug once a day. */
  private cheer(w: Ways, d: number, p: number, lines: string[], oncePerDay = false): void {
    const n = this.mark(w);
    const dayKey = oncePerDay ? this.hugDay === this.dayN : false;
    if (oncePerDay) this.hugDay = this.dayN;
    const ok = !dayKey && this.rng.float() < p / (1 + n * 0.8);
    if (w === 'sorry') { this.s.anger = Math.max(0, this.s.anger - 0.5); nudge(this.s, ok ? d : d * 0.3); }
    else nudge(this.s, ok ? d / (1 + n) : 0.02);
    this.g.people.speak(fill(ok ? lines[0] : lines[1], this.names()));
    if (ok && this.act) hold(this.act, w === 'hug' ? 'cheer' : w === 'buy' ? 'offer' : 'clap', 1.6);
  }

  private hugDay = -1;
  /** His mood came from a save (or the first day has set it). */
  private restored = false;

  private joke(): void {
    const n = this.mark('joke');
    const j = JOKES[(this.dayN * 3 + n) % JOKES.length];
    const ok = this.rng.float() < 0.65 / (1 + n * 0.6);
    nudge(this.s, ok ? 0.22 / (1 + n) : 0.03);
    this.g.people.speak(`<i>“${j}”</i> ${ok ? CHEER.joke[0] : CHEER.joke[1]}`);
    if (ok && this.act) hold(this.act, 'clap', 1.5);
  }

  /** What his talk panel greeting would be (dev, tests). */
  hello(): string {
    const l = this.s.anger > 0.35 ? HELLO.angry : this.s.mood < MOOD.gloomAt ? HELLO.sad : this.s.mood > MOOD.sunAt ? HELLO.happy : HELLO.fine;
    return fill(this.rng.pick(l), this.names());
  }

  gossip(x: number, z: number): string | null {
    const sh = this.shop;
    if (!sh || Math.hypot(x - sh.x, z - sh.z) < 120 || Math.random() > 0.35) return null;
    return fill(GOSSIP[Math.floor(Math.random() * GOSSIP.length)], this.names());
  }

  // ================================================================== save, status, dev

  save(): SavedBaker {
    return { mood: Math.round(this.s.mood * 1000) / 1000, anger: Math.round(this.s.anger * 1000) / 1000, cheeredDay: this.cheeredDay, day: this.dayN };
  }

  restore(d: unknown): void {
    const o = d as Partial<SavedBaker> | null;
    if (!o || typeof o !== 'object') return;
    if (typeof o.mood === 'number' && Number.isFinite(o.mood)) this.s.mood = clamp(o.mood, -1, 1);
    if (typeof o.anger === 'number' && Number.isFinite(o.anger)) this.s.anger = clamp(o.anger, 0, 1);
    if (typeof o.cheeredDay === 'number') this.cheeredDay = o.cheeredDay;
    this.restored = true;
  }

  status(): Record<string, unknown> {
    const r2 = (v: number) => Math.round(v * 100) / 100;
    return {
      name: this.full, bakery: this.bakery, street: this.street, shop: this.shop ? { x: Math.round(this.shop.x), z: Math.round(this.shop.z), cell: this.shop.cell } : null,
      mood: r2(this.s.mood), anger: r2(this.s.anger), word: moodWord(this.s), day: this.today.kind, base: r2(this.today.base),
      out: !!this.a, weight: r2(this.weight), cloud: r2(this.cloud.amount), ...this.stats,
    };
  }

  /** Dev: set his mood (and anger). */
  devMood(m: number, anger = 0): Record<string, unknown> {
    this.s.mood = clamp(m, -1, 1);
    this.s.anger = clamp(anger, 0, 1);
    // (Hold it there a while: the day's baseline follows.)
    this.today = { ...this.today, base: this.s.mood };
    return this.status();
  }

  /** Dev: find his shop now (plans the remaining candidates at once). */
  devFind(): HomeShop | null {
    while (!this.shop && !this.search.step()) { /* plan on */ }
    this.shop ??= this.search.found ?? this.fallback;
    if (this.shop) this.street = this.g.people.streetAt(this.shop.x, this.shop.z) ?? 'his street';
    return this.shop;
  }
}

const cloth = (seed: number, primary: [number, number, number], secondary = primary, material = 'plain'): ItemVisual =>
  ({ shape: 'cloth', seed, primary, secondary, accent: secondary, material, glow: 0, glowColor: [0, 0, 0], wear: 0.05, style: '' });

/** Baker's whites: a white shirt, checked trousers, a tall white hat. */
export function bakerOutfit(seed: number): EquipmentVisuals {
  return {
    chest: { defId: 'shirt', visual: cloth(seed ^ 1, [0.94, 0.93, 0.9]) },
    legs: { defId: 'trousers', visual: cloth(seed ^ 2, [0.16, 0.16, 0.18], [0.85, 0.85, 0.83], 'checks') },
    feet: { defId: 'shoes', visual: cloth(seed ^ 3, [0.12, 0.1, 0.09]) },
    head: { defId: 'bakerhat', visual: cloth(seed ^ 4, [0.97, 0.96, 0.94]) },
  };
}
