/**
 * The people of the city as individuals (NPC_PERSONALITY_PLAN, phase 1): everyone's name and
 * personality (identity.ts), talking to someone with E (talk.ts, lines.ts, ui/TalkUi.ts), what
 * the people you met remember of you (memory.ts), their faint dots on the map, and saving it.
 *
 * Talking: on foot and of ordinary size, E talks to the person you have targeted (within
 * TALK.targetReach) or the one right in front of you. They stop, turn to you and wait while the
 * panel is open (an actor of TALK_OWNER: Pedestrians keeps the physics, perception leaves them
 * be); walking away, a scare or their being knocked down ends it. The world keeps running.
 *
 * Remembered: everyone you talk to, help up or save from a crime (or give their stolen things
 * back to); people you already know also remember being knocked down by you. At most PEOPLE.cap of
 * them (memory.ts decides who is forgotten).
 *
 * The social web (phase 4, social.ts): word of what you did gets round to the people close to
 * someone (their opinion moves and they say so), pressing needs colour mood and small talk, and
 * people who like you may ask a favour: look in on a friend or relative (their dot goes on the
 * map) or clear the gang off their street. The one who asked remembers it; nothing else does.
 *
 * Behaviour from personality (phase 2, behaviour.ts and Manners.ts): pace, how long a scare or a
 * spectacle holds someone, people who dislike you keeping away and refusing to talk, kind people
 * helping others up and pointing after thieves, people who like you waving, and what everyone
 * shouts in the moment in their own temperament (ui/Barks asks reactLine).
 */
import type { Game } from '../Game';
import { PState, type PedAgent } from '../../sim/Pedestrians';
import { Role, type Citizen } from '../../sim/Population';
import { makeActor, release, STREET_OWNER, PEOPLE_OWNER, type Actor, type Mood } from '../../sim/actors/Actor';
import { cityName, streetName } from '../../plan/names';
import { gameTimeLabel } from '../save/model';
import type { MapMarker } from '../../ui/map/GameMap';
import { nameOf, traitsOf, temperamentOf, jobOf, interestOf, moodOf, moodWord, yearsOf, MOOD_LABEL, type Traits, type Temperament, type Job } from './identity';
import { RuleBackend, ruleAnswer, dirWord, type TalkBackend, type TalkFacts, type Picked } from './talk';
import { CHAT, type Topic } from './lines';
import { PEOPLE, onTheirWay, newKnown, opinionOf, applyDeed, addSaid, addNote, remember, savePeople, restorePeople, type Known, type Deed } from './memory';
import { TalkUi } from '../../ui/TalkUi';
import { Manners } from './Manners';
import { paceOf, refuses, waves, type Moment } from './behaviour';
import { hashCombine, hashToFloat, deriveSeed } from '../../core/rng';
import { SOCIAL, hearsay, needsOf, needsMood, pressing, visitTarget, asksFavour, type Told, type Favour } from './social';

/** Roles and actor states of people other systems drive who will still talk to you. */
const TALK_ROLES = new Set<string>(['bystander', 'shopkeeper', 'owner', 'police', 'medic', 'worker', 'soldier', 'victim']);
const TALK_STATES = new Set<string>(['idle', 'walk', 'point', 'cheer']);
/** Titles for roles without one of their own. */
export const ROLE_JOB: Record<string, string> = { police: 'police officer', medic: 'paramedic', soldier: 'soldier', shopkeeper: 'shopkeeper', worker: 'cleanup worker' };

/** Owner id of the people you are talking to (sim/actors/Actor owners: game/people's own). */
export const TALK_OWNER = PEOPLE_OWNER;

export const TALK = {
  /** Talking range to the person in front of you, and to the targeted one (m, from the body's edge). */
  reach: 1.8, targetReach: 3.5,
  /** Someone another system drives may be busy this long (s) before the talk ends (a worker stepping back to their spot). */
  busy: 3,
  /** The talk ends when you are this far apart (m). */
  leave: 5,
  /** Seconds of nothing said before they walk on. */
  idle: 75,
  /** Map dots: seconds between position updates. */
  markEvery: 2,
  /** A known person greets you (a bark) within this range, at most once per this many seconds. */
  greetR: 9, greetEvery: 240,
} as const;

/** Who someone is (derived from the seed; cached per citizen id). */
export interface Person {
  cit: Citizen;
  first: string;
  last: string;
  full: string;
  years: number;
  traits: Traits;
  temper: Temperament;
  job: Job;
  interest: string;
}

export interface Destination { label: string; x: number; z: number }

/** Someone whose whereabouts People keeps up with (a known person, or one you were asked to look in on). */
interface Spot { cit: Citizen; x: number; z: number }

interface Session {
  a: PedAgent;
  p: Person;
  k: Known;
  /** Our actor on them (null: indoors, where they are only turned to face you). */
  act: Actor | null;
  /** Driven by another system (a street performer, an officer): left to it; the talk ends when it turns away. */
  foreign: Actor | null;
  /** What they are to you right now (their job, or the busker, the officer …). */
  job: Job;
  /** Their age as that (an officer or a paramedic is a grown-up, whoever the citizen behind is). */
  years: number;
  /** Seconds the foreign actor has been busy (a worker running back to their spot): a moment is fine. */
  busy: number;
  /** Seconds since the last thing said. */
  idle: number;
  /** Closing after a goodbye: seconds left. */
  closing: number;
  /** Met before this conversation (0: a stranger), and when they last met (game hours). */
  metBefore: number;
  lastBefore: number;
  /** Times asked this conversation (the seed of the next pick). */
  n: number;
  /** Consequences.time when the talk began (new harm close by ends it). */
  since: number;
  /** They are the one somebody asked you to look in on: the asker's first name. */
  asker: string | null;
  /** Asked the favour topic this conversation (the answer stays the same). */
  askedFavour: boolean;
}

const STORE = (g: Game) => `scale.people.v1.${g.mode}.${g.settings.seed}.${g.settings.size.toFixed(2)}`;

export class People {
  readonly known: Known[] = [];
  /** Where answers come from (phase 3: a language model, falling back to the rules). */
  backend: TalkBackend = new RuleBackend();
  private ui: TalkUi;
  private session: Session | null = null;
  private cache = new Map<number, Person>();
  private markT = 0;
  private driftT = 0;
  /** Next time (this.time) to try bringing a known person back into the street, per citizen id. */
  private backT = new Map<number, number>();
  private markKey = '';
  private greeted = new Map<number, number>();
  private time = 0;
  /** Knock-downs already counted (per person, game seconds): a tumble is one deed, not every bounce. */
  private hurtAt = new Map<number, number>();
  readonly city: string;
  /** Behaviour from personality around the hero (phase 2). */
  readonly manners: Manners;
  /** Saves already counted (per person, game seconds): stopping the crime and handing the bag back are one rescue. */
  private savedAt = new Map<number, number>();
  /** Someone you were asked to look in on, waiting at their door (People keeps them there till you come or go). */
  private waiting: { a: PedAgent; act: Actor } | null = null;
  /** More things to say to the person you talk to (the sidekick's shard offer), after the usual topics. */
  extraOptions: ((a: PedAgent) => { label: string; run: () => void }[]) | null = null;

  constructor(private g: Game) {
    this.city = cityName(g.settings.seed);
    this.manners = new Manners(g, this);
    this.ui = new TalkUi({
      choose: (topic) => this.ask(topic),
      way: (d) => this.showWay(d),
      close: () => this.end(),
      destinations: () => this.destinations(),
      extras: () => (this.session && this.extraOptions ? this.extraOptions(this.session.a) : []),
    });
    try { this.known.push(...restorePeople(JSON.parse(localStorage.getItem(STORE(g)) ?? 'null'))); } catch { /* storage unavailable */ }
    // People you know appear where they plausibly are, not where their schedule ran ahead to.
    g.peds.placeFor = (c) => { const k = this.find(c.id); return k ? { x: k.x, z: k.z } : null; };
    // Brisk or dawdling, by who they are.
    g.peds.paceOf = (c) => paceOf(traitsOf(c));
    // Saved from a crime (or their stolen things brought back): remembered, once per rescue.
    if (g.crime) {
      g.crime.onStopped = (c) => {
        for (const v of [...c.victims, ...c.extras]) if (v.alive && (v.actor?.role === 'victim' || v.actor?.role === 'shopkeeper' || v.actor?.role === 'owner')) this.saved(v);
        // A street you were asked to clear: any crime stopped near where they asked.
        for (const k of this.known) {
          const f = k.favour;
          if (f?.kind === 'streets' && !f.done && !f.lost && Math.hypot(c.x - (f.x ?? 0), c.z - (f.z ?? 0)) < SOCIAL.streetsR) this.favourDone(k);
        }
      };
      g.crime.onReturned = (who) => { if (who.alive && !who.actor?.hostile) this.saved(who); };
    }
    // Helping someone up: they remember it (and you, if they did not know you yet).
    const prevHelp = g.deeds.onHelped;
    g.deeds.onHelped = (a) => { prevHelp?.(a); this.note(a, 'helped'); };
    // Knocked down by the hero: remembered by people who already know you.
    const prevKnock = g.reactions.onKnockDown;
    g.reactions.onKnockDown = (a, fx, fz, power, cause) => {
      prevKnock?.(a, fx, fz, power, cause);
      if (cause === 'player' && this.find(a.cit.id)) this.note(a, 'hurt');
    };
  }

  // ------------------------------------------------------------------ identity

  /** Who a citizen is (name, personality, job …): the same every time. */
  person(cit: Citizen): Person {
    let p = this.cache.get(cit.id);
    if (p) return p;
    if (this.cache.size > 800) this.cache.clear();
    const traits = traitsOf(cit);
    const wd = cit.work ? this.g.macro.cells[cit.work.cell]?.district ?? null : null;
    const n = nameOf(cit);
    p = { cit, first: n.first, last: n.last, full: n.full, years: yearsOf(cit), traits, temper: temperamentOf(traits), job: jobOf(cit, wd), interest: interestOf(cit) };
    this.cache.set(cit.id, p);
    return p;
  }

  find(citId: number): Known | null {
    return this.known.find((k) => k.cit.id === citId) ?? null;
  }

  /**
   * How someone feels about the hero now: what you did to them, what they heard from the people
   * close to them, your reputation.
   */
  opinion(cit: Citizen): number {
    const p = this.person(cit), k = this.find(cit.id);
    return opinionOf(k, this.g.crime?.rep.value ?? 0, p.traits.a, this.heard(cit).op);
  }

  /** What they heard about the hero from people close to them (social.ts hearsay). */
  heard(cit: Citizen): { told: Told | null; op: number } {
    return hearsay(cit, this.known, { helped: PEOPLE.helped, saved: PEOPLE.saved, hurt: PEOPLE.hurt });
  }

  /** The target frame's name and sub line for a person ("Mara Okonkwo", "shop assistant · knows you"). */
  label(a: PedAgent): { name: string; kind: string; ours: boolean } {
    const p = this.person(a.cit), k = this.find(a.cit.id);
    const t = this.jobFor(a).title;
    const job = t.charAt(0).toUpperCase() + t.slice(1);
    // (A criminal keeps the crime layer's name: "Harbour Kings thug (knife)".)
    const ours = !a.actor || a.actor.owner === TALK_OWNER || this.friendlyActor(a.actor);
    return { name: p.full, kind: k ? `${job} · knows you` : job, ours };
  }

  /** What they are doing now when it is not their everyday job: a busker, an officer, a medic … */
  jobFor(a: PedAgent): Job {
    const act = a.actor, base = this.person(a.cit).job;
    if (!act || act.owner === TALK_OWNER) return base;
    const t = act.title ?? ROLE_JOB[act.role];
    if (!t) return base;
    const kind: Job['kind'] = act.role === 'police' || act.role === 'medic' || act.role === 'soldier' ? 'civic' : act.role === 'shopkeeper' ? 'shop' : act.owner === STREET_OWNER ? 'street' : base.kind;
    return { kind, title: t.toLowerCase() };
  }

  /** Someone another system drives (a street performer, an officer on patrol) who can still be talked to. */
  private friendlyActor(act: Actor): boolean {
    return !act.hostile && TALK_ROLES.has(act.role) && TALK_STATES.has(act.state);
  }

  /** A passer-by's bit of small talk in their temperament (null: they keep quiet). */
  chatLine(a: PedAgent): string | null {
    const t = this.person(a.cit).temper, l = CHAT[t];
    if (!l.length) return null;
    // City news and a word about these streets (game/news); the talkative ones more often.
    const city = this.g.city?.chatLine(a.x, a.z) ?? null;
    if (city && Math.random() < (t === 'chatty' || t === 'nosy' ? 0.8 : t === 'grumpy' || t === 'dreamy' ? 0.35 : 0.6)) return city;
    return pick(l);
  }

  /** What someone shouts in a moment, in their temperament (null: the common line). */
  reactLine(a: PedAgent, m: Moment): string | null {
    return this.manners.line(a, m);
  }

  // ------------------------------------------------------------------ memory

  /** Saved by the hero (a crime stopped, their things returned): one deed per rescue. */
  private saved(a: PedAgent): void {
    const last = this.savedAt.get(a.cit.id) ?? -1e9;
    this.savedAt.set(a.cit.id, this.time);
    if (this.time - last < 180) return;
    this.note(a, 'saved');
  }

  /** Record something between the hero and this person (meeting them if they are new). */
  note(a: PedAgent, d: Deed): Known {
    const now = this.g.sky.hoursAbs;
    const street = this.streetAt(a.x, a.z);
    let k = this.find(a.cit.id);
    if (d === 'hurt') {
      const last = this.hurtAt.get(a.cit.id) ?? -1e9;
      this.hurtAt.set(a.cit.id, this.time);
      if (k && this.time - last < 20) return k;
    }
    const where = street ? ` on ${street}` : '';
    const day = gameTimeLabel(Math.floor(now / 24), now % 24);
    if (!k) {
      k = newKnown(a.cit, this.person(a.cit).full, now, a.x, a.z, street);
      remember(this.known, k, now);
      addNote(k, now, `${day}: met the hero${where}`);
    }
    applyDeed(k, d, now, street);
    k.x = a.x; k.z = a.z; k.street = street;
    if (d === 'helped') addNote(k, now, `${day}: the hero helped them up${where}`);
    else if (d === 'hurt') addNote(k, now, `${day}: the hero knocked them down${where}`);
    else if (d === 'saved') addNote(k, now, `${day}: the hero saved them${where}`);
    this.markKey = '#stale';
    this.persist();
    return k;
  }

  private persist(): void {
    try { localStorage.setItem(STORE(this.g), JSON.stringify(savePeople(this.known))); } catch { /* storage unavailable or full */ }
  }

  save(): unknown { return savePeople(this.known); }

  /** A save's people (null: an older save, keep what the browser remembers). */
  restore(raw: unknown): void {
    if (raw === null || raw === undefined) return;
    this.end();
    this.manners.clear();
    if (this.waiting) { if (this.waiting.a.actor === this.waiting.act) this.waiting.a.alive = false; this.waiting = null; }
    this.known.length = 0;
    this.known.push(...restorePeople(raw));
    this.markKey = '#stale';
    this.persist();
  }

  /** Forget everyone (dev). */
  forget(): void { this.known.length = 0; this.markKey = '#stale'; this.persist(); }

  // ------------------------------------------------------------------ talking

  get talking(): boolean { return !!this.session; }
  /** Who you are talking to (null: nobody). */
  get partner(): PedAgent | null { return this.session?.a ?? null; }
  /** The talk panel has the keyboard (or just let go of it): Esc must not open the pause menu. */
  get holdsPointer(): boolean { return this.ui.holdsPointer; }

  /** The conversation now, for other systems (the shard offer): who, their record, how they feel; null: none. */
  talkInfo(): { a: PedAgent; person: Person; known: Known; foreign: Actor | null; actor: Actor | null; opinion: number; child: boolean } | null {
    const s = this.session;
    if (!s) return null;
    const f = this.facts(s);
    return { a: s.a, person: s.p, known: s.k, foreign: s.foreign, actor: s.act, opinion: f.opinion, child: f.child };
  }

  /** Put a line in the open talk panel (another system's: the shard offer); the topics come back unless `hush`. */
  speak(text: string, hush = false): void {
    const s = this.session;
    if (!s) return;
    s.idle = 0;
    this.ui.line(text);
    if (hush) this.ui.clearOptions();
    else this.ui.showTopics();
  }

  /** The person you talk to asks you to look in on someone close to them now (null: no talk, or a favour already open). */
  askVisit(): Favour | null {
    const s = this.session;
    if (!s || s.foreign || (s.k.favour && s.k.favour.done === undefined && !s.k.favour.lost)) return null;
    delete s.k.favour;
    this.makeFavour(s, 'visit');
    return s.k.favour ?? null;
  }

  /** Mark someone you know as your sidekick (or no longer): kept for good, a gold dot on the map. */
  /** Someone gone for good (a sidekick who died): out of memory and off the map. */
  remove(citId: number): void {
    const i = this.known.findIndex((k) => k.cit.id === citId);
    if (i < 0) return;
    this.known.splice(i, 1);
    this.markKey = '#stale';
    this.persist();
  }

  setSidekick(citId: number, on: boolean): void {
    const k = this.find(citId);
    if (!k) return;
    if (on) k.sidekick = true;
    else delete k.sidekick;
    this.markKey = '#stale';
    this.persist();
  }

  private canTalk(): boolean {
    const P = this.g.player;
    return !this.g.freeCam && !P.flying && P.grounded && P.height >= 1.2 && P.height <= 2.4 && P.downT <= 0 && !P.ragdoll && !this.g.defeat?.active && !this.g.map.open;
  }

  private willTalk(a: PedAgent): boolean {
    if (!a.alive || a.evac || a.ragdoll) return false;
    if (this.waiting?.a === a) return true;
    if (a.actor) return a.actor.owner !== TALK_OWNER && this.friendlyActor(a.actor) && a.state !== PState.Down;
    return a.state === PState.Walk || a.state === PState.Wait || a.state === PState.Idle || a.state === PState.Gawk || a.state === PState.Film || a.state === PState.Sit;
  }

  /** The person E would talk to now, or null. */
  talkable(): PedAgent | null {
    if (this.session || !this.canTalk()) return null;
    const P = this.g.player, p = P.pos;
    const t = this.g.targeting.current;
    if (t?.kind === 'person') {
      const a = t.obj;
      if (this.willTalk(a) && Math.hypot(a.x - p.x, a.z - p.z) < P.radius + TALK.targetReach && Math.abs(a.y - p.y) < 1.5) return a;
    }
    // Else whoever is right in front, when you stop by them (walking through a crowd offers nobody).
    if (Math.hypot(P.vel.x, P.vel.z) > 1.6) return null;
    const fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw);
    let best: PedAgent | null = null, bs = Infinity;
    for (const a of this.g.peds.neighbours(p.x, p.z, P.radius + TALK.reach, [])) {
      if (!this.willTalk(a) || Math.abs(a.y - p.y) > 1.5) continue;
      const dx = a.x - p.x, dz = a.z - p.z, d = Math.hypot(dx, dz);
      if (d > P.radius + TALK.reach || d < 0.05) continue;
      const front = (dx * fx + dz * fz) / d;
      if (front < 0.35) continue;
      const s = d * (1.6 - front);
      if (s < bs) { bs = s; best = a; }
    }
    return best;
  }

  hint(): string | null {
    const a = this.talkable();
    if (!a) return null;
    const p = this.person(a.cit);
    // (Someone who won't talk to you gets no prompt; E still gets you their refusal.)
    if (!a.actor && refuses(opinionOf(this.find(a.cit.id), this.g.crime?.rep.value ?? 0, p.traits.a))) return null;
    return `Press <b>E</b> to talk to ${this.find(a.cit.id) ? p.full : p.first}`;
  }

  /** E: talk to the person in front (or close the talk). True when E was used. */
  use(): boolean {
    if (this.session) { this.end(); return true; }
    const a = this.talkable();
    if (!a) return false;
    this.start(a);
    return true;
  }

  private start(a: PedAgent): void {
    const p = this.person(a.cit), P = this.g.player;
    // Right after a crash or a fight nearby nobody stops for a chat.
    if (this.troubleAt(a.x, a.z) > 0.6) {
      this.g.barks?.say(a, pick(p.temper === 'grumpy' ? ['Not now!', 'Are you serious? Now?'] : ['Not now!', 'Sorry, I have to go!', 'Not now, it\'s not safe here!']), 8);
      return;
    }
    // The one you were asked to look in on, waiting at their door: no longer held there.
    if (this.waiting?.a === a) { if (a.actor === this.waiting.act) release(a); this.waiting = null; }
    const before = this.find(a.cit.id);
    // Someone who can't stand you won't talk to you (only someone another system drives has to).
    if (!a.actor && refuses(this.opinion(a.cit))) {
      this.g.barks?.say(a, this.manners.line(a, 'refuse') ?? 'No.', 8, 'angry');
      if (a.state !== PState.Sit) { a.state = PState.Walk; a.stateT = 0; a.heading = Math.atan2(P.pos.x - a.x, P.pos.z - a.z); }
      return;
    }
    const metBefore = before ? before.met : 0, lastBefore = before ? before.last : this.g.sky.hoursAbs;
    const k = this.note(a, 'talked');
    // Their own owner keeps someone it drives (a busker plays on); seated people stay in their seat,
    // indoor ones where they stand; everyone else stops and turns to you.
    const foreign = a.actor ?? null;
    const job = this.jobFor(a);
    if (foreign && job.title !== p.job.title) k.title = job.title;
    else delete k.title;
    const years = foreign && foreign.owner !== STREET_OWNER && job.title !== p.job.title ? Math.min(60, Math.max(22, p.years)) : p.years;
    let act: Actor | null = null;
    if (!foreign && !a.inside && a.state !== PState.Sit) {
      act = makeActor('bystander', TALK_OWNER, { title: p.full, face: { x: P.pos.x, y: P.pos.y + P.height * 0.9, z: P.pos.z } });
      a.actor = act;
    }
    if (!foreign && a.state !== PState.Sit) a.heading = Math.atan2(-(P.pos.x - a.x), -(P.pos.z - a.z));
    // Someone you were asked to look in on: the favour is done (and they know who sent you).
    let asker: string | null = null;
    for (const o of this.known) {
      const fv = o.favour;
      if (o !== k && fv?.kind === 'visit' && !fv.done && !fv.lost && fv.who?.id === a.cit.id) { asker = o.name.split(' ')[0]; this.favourDone(o); }
    }
    this.session = { a, p, k, act, foreign, job, years, busy: 0, idle: 0, closing: 0, metBefore, lastBefore, n: 0, since: this.g.consequences.time, asker, askedFavour: false };
    // Opinion and mood before the menu: the header shows them.
    const f = this.facts(this.session);
    if (act) act.mood = actorMood(f);
    this.ui.showOpen(this.header(f), this.say('hello'));
    this.g.input.keys.clear();
  }

  /** End the talk now (they walk on). */
  end(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    if (s.act && s.a.actor === s.act) release(s.a);
    this.ui.close();
    this.persist();
  }

  private ask(topic: Topic): void {
    const s = this.session;
    if (!s || s.closing > 0) return;
    if (topic === 'way') { this.ui.showDestinations(); return; }
    const text = this.say(topic);
    this.ui.line(text);
    if (topic === 'bye') { s.closing = 1.8; this.ui.closing(); }
  }

  private showWay(d: Destination): void {
    const s = this.session;
    if (!s) return;
    const dx = d.x - s.a.x, dz = d.z - s.a.z;
    const text = this.say('way', { place: d.label, dir: dirWord(dx, dz), dist: Math.hypot(dx, dz) });
    this.g.map.setWaypoint({ x: d.x, z: d.z });
    this.ui.line(text);
    this.ui.showTopics();
  }

  /** A line on a topic from the backend (rule answer at once; a slower backend replaces it when it comes). */
  private say(topic: Topic, extra: Partial<TalkFacts> = {}): string {
    const s = this.session!;
    s.idle = 0;
    s.n++;
    // (Asked what they need: someone who likes you may ask a favour now, once per conversation.)
    const asks = topic === 'favour' && !s.askedFavour && (s.askedFavour = true) && this.maybeAsk(s);
    const facts = { ...this.facts(s), ...extra, ...(asks && s.k.favour ? { favour: s.k.favour.kind } : {}) };
    const seed = hashCombine(s.p.cit.seed, Math.floor(this.g.sky.hoursAbs * 4) * 131 + s.n);
    const req = { topic, facts, seed, used: new Set(s.k.said), memory: s.k.notes.map((n) => n.text) };
    const rule: Picked = ruleAnswer(req);
    addSaid(s.k, rule.id);
    // A favour done (or forgotten) is talked about once, then it is over.
    const fv = s.k.favour;
    if (fv && (fv.done !== undefined || fv.lost) && (facts.favour === 'done' || facts.favour === 'lost') && /^(h4[5-7]|f2[12])#/.test(rule.id)) delete s.k.favour;
    if (topic !== 'hello' && topic !== 'bye' && topic !== 'way' && !s.k.notes.some((n) => n.text.endsWith(`asked about ${topic}`))) {
      addNote(s.k, this.g.sky.hoursAbs, `${gameTimeLabel(Math.floor(this.g.sky.hoursAbs / 24), this.g.sky.hoursAbs % 24)}: the hero asked about ${topic}`);
    }
    if (this.backend.id !== 'rules') {
      const mine = s;
      void this.backend.answer(req).then((r) => { if (r && this.session === mine) this.ui.line(r.text); }).catch(() => { /* the rule line stays */ });
    }
    return rule.text;
  }

  private header(f: TalkFacts): { name: string; sub: string; known: string } {
    const s = this.session!, p = s.p;
    const age = p.cit.role === Role.Child && s.years === p.years ? `${p.years}` : `about ${Math.round(s.years / 5) * 5}`;
    const sub = `${s.job.title.charAt(0).toUpperCase()}${s.job.title.slice(1)} · ${age} · ${p.temper} · ${MOOD_LABEL[f.moodWord]}`;
    const k = s.k;
    const known = s.metBefore > 0
      ? `Met ${s.metBefore === 1 ? 'once' : `${s.metBefore} times`} · first on ${gameTimeLabel(Math.floor(k.first / 24), k.first % 24)} · ${opinionWord(f.opinion)}`
      : `A stranger · ${opinionWord(f.opinion)}`;
    return { name: p.full, sub, known };
  }

  /** Everything a line can depend on, for this person now. */
  private facts(s: Session): TalkFacts {
    const g = this.g, a = s.a, p = s.p, k = s.k;
    const now = g.sky.hoursAbs;
    const rep = g.crime?.rep.value ?? 0;
    const heard = this.heard(p.cit);
    const opinion = opinionOf(k, rep, p.traits.a, heard.op);
    const trouble = this.troubleAt(a.x, a.z);
    const weather = g.weather?.kind ?? 'fair';
    const needs = needsOf(p.cit, p.traits, g.sky.hour, this.homeHours(p.cit, now));
    const mood = Math.max(-1, Math.min(1, moodOf(p.cit, p.traits, { day: Math.floor(now / 24), hour: g.sky.hour, weather, trouble, opinion }) + needsMood(needs)));
    const fv = k.favour;
    const favour = !fv ? 'none' as const : fv.done !== undefined ? 'done' as const : fv.lost ? 'lost' as const : 'open' as const;
    const f = g.crime?.factionAt(a.x, a.z) ?? null;
    const boss = f ? g.crime.bosses.find((b) => b.faction === f.id) ?? null : null;
    const C = g.consequences;
    return {
      first: p.first, last: p.last, full: p.full, years: s.years, child: p.cit.role === Role.Child && s.years === p.years, senior: s.years >= 66,
      traits: p.traits, temper: p.temper, job: s.job, interest: p.interest, mood, moodWord: moodWord(mood, trouble),
      met: s.metBefore, deed: k.deed, days: Math.max(0, (now - s.lastBefore) / 24),
      opinion, hour: g.sky.hour, weather, trouble,
      threat: C.log.some((e) => e.cause === 'threat' && C.time - e.t < 900),
      street: this.streetAt(a.x, a.z), metStreet: k.deedStreet, city: this.city,
      group: f?.name ?? null, boss: boss?.name ?? null, giant: g.player.height > 2.4,
      teller: heard.told?.name ?? null, bond: heard.told?.word, told: heard.told?.deed ?? null, need: s.foreign ? null : pressing(needs),
      favour, who: fv?.whoName?.split(' ')[0], word: fv?.word, asker: s.asker,
      nannies: g.wardens?.momentAt(a.x, a.z) ?? null,
      ...(g.city ? g.city.talkFacts(a.x, a.z, hashCombine(p.cit.seed, Math.floor(now))) : {}),
    };
  }

  /** 0..1: harm done near a point lately (the hero's powers, a threat, the army). */
  private troubleAt(x: number, z: number): number {
    const C = this.g.consequences;
    let n = 0;
    for (let i = C.log.length - 1; i >= 0; i--) {
      const e = C.log[i];
      if (C.time - e.t > 300) break;
      if (e.cause !== 'police' && Math.abs(e.x - x) < 150 && Math.abs(e.z - z) < 150) n += e.effect === 'collapse' ? 4 : 1;
    }
    return Math.min(1, n / 8);
  }

  /** Harm done within 40 m of a point since a time (a crash during the talk ends it). */
  private harmSince(x: number, z: number, t: number): boolean {
    const C = this.g.consequences;
    for (let i = C.log.length - 1; i >= 0 && C.log[i].t >= t; i--) {
      const e = C.log[i];
      if (e.cause !== 'police' && Math.hypot(e.x - x, e.z - z) < 40) return true;
    }
    return false;
  }

  /** Hours they spent at home before going out (lonely if long; 0 while at home or out a while). */
  private homeHours(c: Citizen, now: number): number {
    const day = Math.floor(now / 24), plan = this.g.peds.pop.dayPlan(c, day);
    let best = 0;
    for (const st of plan.stays) {
      if (st.place.kind !== 'home' || st.to > now || st.from < day * 24 + c.wake) continue;
      best = Math.max(0, (st.to - st.from) - (now - st.to) * 2);
    }
    return Math.min(12, best);
  }

  // ------------------------------------------------------------------ favours

  /** Asked "Can I do anything for you?": someone who likes you may ask a favour now. */
  private maybeAsk(s: Session): boolean {
    const k = s.k, g = this.g, now = g.sky.hoursAbs, day = Math.floor(now / 24);
    if (s.foreign || k.favour) return false;
    const u = hashToFloat(deriveSeed(k.cit.seed, 'favour', day));
    if (!asksFavour(this.opinion(k.cit), Math.max(k.met, s.metBefore), false, u)) return false;
    const group = g.crime?.factionAt(s.a.x, s.a.z) ?? null;
    this.makeFavour(s, group && u < SOCIAL.favourChance * 0.45 ? 'streets' : 'visit');
    return true;
  }

  /** The person you talk to asks a favour of this kind (look in on someone close, clear the gang off their street). */
  private makeFavour(s: Session, kind: Favour['kind']): void {
    const k = s.k, g = this.g, now = g.sky.hoursAbs, day = Math.floor(now / 24);
    const group = g.crime?.factionAt(s.a.x, s.a.z) ?? null;
    const f: Favour = { kind, asked: now, until: now + SOCIAL.favourHours };
    if (f.kind === 'streets') { f.x = s.a.x; f.z = s.a.z; f.group = group?.name ?? null; }
    else {
      const t = visitTarget(k.cit, (seed) => g.peds.pop.synthetic(seed), day);
      f.who = t.cit; f.word = t.word; f.whoName = nameOf(t.cit).full;
      const at = this.planSpotOf(t.cit, now);
      if (at) { f.wx = at.x; f.wz = at.z; g.map.setWaypoint({ x: at.x, z: at.z }); }
    }
    k.favour = f;
    const d = gameTimeLabel(day, now % 24);
    addNote(k, now, f.kind === 'visit' ? `${d}: asked the hero to look in on their ${f.word} ${f.whoName}` : `${d}: asked the hero to deal with the trouble on their street`);
    this.markKey = '#stale';
    this.persist();
  }

  private favourDone(k: Known): void {
    const f = k.favour;
    if (!f || f.done !== undefined || f.lost) return;
    const now = this.g.sky.hoursAbs;
    f.done = now;
    k.favours++;
    addNote(k, now, `${gameTimeLabel(Math.floor(now / 24), now % 24)}: the hero ${f.kind === 'visit' ? `looked in on their ${f.word} ${f.whoName}` : 'cleared the trouble on their street'}`);
    this.g.powerHud?.toast(f.kind === 'visit' ? `You looked in on <b>${f.whoName}</b> for ${k.name}` : `You dealt with the trouble on <b>${k.name}</b>'s street`, 'info');
    this.markKey = '#stale';
    this.persist();
  }

  /** Open favours past their time are lost (they remember being let down). */
  private favoursDue(now: number): void {
    for (const k of this.known) {
      const f = k.favour;
      if (!f || f.done !== undefined || f.lost || now < f.until) continue;
      f.lost = true;
      k.letDown++;
      addNote(k, now, `${gameTimeLabel(Math.floor(now / 24), now % 24)}: the hero never did what they asked`);
      this.markKey = '#stale';
    }
  }

  /** Where the one you were asked to look in on is now; near their door at home they wait outside for you. */
  private visitSpot(k: Known, f: Favour, now: number, dt: number): { x: number; z: number; exact: boolean } | null {
    if (!f.who) return null;
    const rec = { cit: f.who, x: f.wx ?? k.x, z: f.wz ?? k.z };
    const w = this.whereNow(rec, now, dt);
    f.wx = rec.x; f.wz = rec.z;
    this.bringBack(rec, now);
    const P = this.g.player.pos, peds = this.g.peds;
    // At home (or wherever they stay), indoors: they come out to the door as you get near.
    if (!peds.agentOf(f.who.id) && !this.waiting && Math.hypot(rec.x - P.x, rec.z - P.z) < 45) {
      const st = peds.pop.stateAt(f.who, now);
      const door = st.stay ? peds.placeSpot(st.stay.place) : null;
      if (door?.exact) {
        const a = peds.spawnAt(f.who, door.x, door.z, Math.atan2(-(P.x - door.x), -(P.z - door.z)));
        if (a) {
          const act = makeActor('bystander', PEOPLE_OWNER, { title: this.person(f.who).full, face: { x: P.x, y: P.y + 1.6, z: P.z } });
          a.actor = act;
          this.waiting = { a, act };
        }
      }
    }
    return w;
  }

  /** The waiting one goes back in when you leave (or someone else takes them). */
  private keepWaiting(): void {
    const w = this.waiting;
    if (!w) return;
    const a = w.a, P = this.g.player.pos;
    if (!a.alive || a.actor !== w.act || a.state === PState.Down) { if (a.actor === w.act) release(a); this.waiting = null; return; }
    w.act.face = { x: P.x, y: P.y + this.g.player.height * 0.9, z: P.z };
    if (Math.hypot(a.x - P.x, a.z - P.z) > 70) { a.alive = false; this.waiting = null; }
  }

  /** The named street nearest a point (arterials, as the map names them), within 120 m. */
  streetAt(x: number, z: number): string | null {
    const E = this.g.macro.edges;
    let best = -1, bd = 120;
    for (let i = 0; i < E.length; i++) {
      const pts = E[i].pts;
      for (let j = 0; j + 3 < pts.length; j += 2) {
        const ax = pts[j], az = pts[j + 1], bx = pts[j + 2], bz = pts[j + 3];
        if (Math.min(ax, bx) - bd > x || Math.max(ax, bx) + bd < x || Math.min(az, bz) - bd > z || Math.max(az, bz) + bd < z) continue;
        const d = segDist(ax, az, bx, bz, x, z);
        if (d < bd) { bd = d; best = i; }
      }
    }
    return best < 0 ? null : streetName(this.g.settings.seed, best, E[best].cls);
  }

  /** Places they can show you the way to: the nearest metro station and the nearest landmarks. */
  destinations(): Destination[] {
    const s = this.session;
    if (!s) return [];
    const m = this.g.macro, x = s.a.x, z = s.a.z;
    const out: Destination[] = [];
    const st = m.metroStations.slice().sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
    if (st) out.push({ label: `${st.name} station`, x: st.x, z: st.z });
    const lms = m.landmarks.filter((l) => l.cell >= 0).sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
    for (const l of lms.slice(0, 4)) out.push({ label: l.name, x: l.x, z: l.z });
    return out;
  }

  // ------------------------------------------------------------------ per frame

  update(dt: number): void {
    this.time += dt;
    const s = this.session;
    if (s) {
      const P = this.g.player, a = s.a;
      s.idle += dt;
      if (s.act) s.act.face = { x: P.pos.x, y: P.pos.y + P.height * 0.9, z: P.pos.z };
      else if (!s.foreign && a.state !== PState.Sit) a.heading = Math.atan2(-(P.pos.x - a.x), -(P.pos.z - a.z));
      if (s.foreign) s.busy = this.friendlyActor(s.foreign) ? 0 : s.busy + dt;
      const lost = !a.alive || (s.act && a.actor !== s.act) || (s.foreign && (a.actor !== s.foreign || s.foreign.hostile || s.busy > TALK.busy)) || a.state === PState.Down || a.ragdoll;
      if (s.closing > 0) { s.closing -= dt; if (s.closing <= 0) this.end(); }
      else if (lost || Math.hypot(a.x - P.pos.x, a.z - P.pos.z) > TALK.leave || s.idle > TALK.idle || !this.canTalk() || this.harmSince(a.x, a.z, s.since)) this.end();
    }
    this.greet();
    this.keepWaiting();
    this.manners.update(dt);
    this.markT -= dt;
    if (this.markT <= 0) { this.markT = TALK.markEvery; this.markers(); }
  }

  /** People who know you say hello as you pass (a bark, now and then). */
  private greet(): void {
    if (this.session || !this.known.length || !this.g.barks) return;
    const P = this.g.player.pos;
    for (const k of this.known) {
      const a = this.g.peds.agentOf(k.cit.id);
      if (!a || !a.alive || a.actor || a.inside || a.state === PState.Down || a.state === PState.Flee) continue;
      if (Math.hypot(a.x - P.x, a.z - P.z) > TALK.greetR) continue;
      if (this.time - (this.greeted.get(k.cit.id) ?? -1e9) < TALK.greetEvery) continue;
      const p = this.person(a.cit);
      const op = this.opinion(k.cit);
      // (People who dislike you say nothing: they keep away, Manners.)
      if (op <= -30) continue;
      const line = k.deed === 'saved' ? pick(['It\'s you! My hero!', 'Hey! I still tell everyone how you saved me!'])
        : k.deed === 'helped' ? pick(['Hey, my rescuer!', 'Hi again! Still in one piece, thanks to you.'])
          : p.temper === 'shy' ? pick(['…hi.', 'Oh. H-hello.'])
            : p.temper === 'grumpy' && op < 25 ? pick(['Oh. You again.', 'Hm. Hello.'])
              : p.traits.e > 0.55 || op > 40 ? pick(['Hey! Hello again!', 'Oh, hi! Good to see you!', `Hi! It's me, ${p.first}!`])
                : pick(['Oh, hello.', 'Hi again.']);
      if (this.g.barks.say(a, line, 30)) {
        this.greeted.set(k.cit.id, this.time);
        // Those who like you stop for a moment and wave.
        if (waves(op, p.traits)) this.manners.wave(a);
      }
      return;
    }
  }

  /** Faint dots on the map where the people you met are now. */
  private markers(): void {
    const g = this.g, now = g.sky.hoursAbs, rep = g.crime?.rep.value ?? 0;
    const dt = Math.min(10, this.time - this.driftT);
    this.driftT = this.time;
    const list: MapMarker[] = [];
    this.favoursDue(now);
    for (const k of this.known) {
      const f = k.favour;
      if (f && f.done === undefined && !f.lost) {
        if (f.kind === 'visit') {
          const w = this.visitSpot(k, f, now, dt);
          if (w) list.push({ x: w.x, z: w.z, color: '#ffd166', kind: 'faint', title: `${f.whoName}, ${k.name.split(' ')[0]}'s ${f.word} — ${k.name.split(' ')[0]} asked you to look in on them${w.exact ? '' : ' · somewhere around here'}` });
        } else list.push({ x: f.x ?? k.x, z: f.z ?? k.z, color: '#ffd166', kind: 'faint', title: `${k.name} asked you to deal with ${f.group ?? 'the trouble'} around here (stop a crime nearby)` });
      }
      const spot = this.whereNow(k, now, dt);
      if (!spot) continue;
      this.bringBack(k, now);
      const p = this.person(k.cit);
      const op = opinionOf(k, rep, p.traits.a, this.heard(k.cit).op);
      const color = k.sidekick ? '#ffc94d' : op >= 40 ? '#8ff0b4' : op <= -30 ? '#ffa894' : '#a9d6ff';
      const times = k.met === 1 ? 'met once' : `met ${k.met} times`;
      const at = spot.exact ? '' : ' · somewhere around here';
      const asked = f && f.done === undefined && !f.lost ? ` · asked you a favour` : '';
      if (k.sidekick) { list.push({ x: spot.x, z: spot.z, color, kind: 'dot', title: `${p.full} — your sidekick${at}` }); continue; }
      list.push({ x: spot.x, z: spot.z, color, kind: 'faint', title: `${p.full}, ${k.title ?? p.job.title} — ${times}, last on ${gameTimeLabel(Math.floor(k.last / 24), k.last % 24)} · ${opinionWord(op)}${asked}${at}` });
    }
    const key = list.map((m) => `${m.x.toFixed(0)},${m.z.toFixed(0)},${m.color}`).join(';');
    if (key !== this.markKey) { this.markKey = key; g.map.setMarkers('people', list); }
  }

  /**
   * Where a known person is now: their live body near the player; else on their way (dt seconds of
   * it, at a plausible pace) from where they were last towards where their day plan has them.
   */
  whereNow(k: Spot, now: number, dt = 0): { x: number; z: number; exact: boolean } | null {
    const a = this.g.peds.agentOf(k.cit.id);
    if (a && a.alive) { k.x = a.x; k.z = a.z; return { x: a.x, z: a.z, exact: true }; }
    const T = this.planSpot(k, now);
    if (!T) return { x: k.x, z: k.z, exact: false };
    const P = this.g.player.pos;
    const n = onTheirWay(k.x, k.z, T.x, T.z, P.x, P.z, dt);
    k.x = n.x; k.z = n.z;
    return { x: k.x, z: k.z, exact: T.exact };
  }

  /**
   * Near you but out of range of their body (it went too far, or the schedule offered their walk
   * only once): put them back in the street at their dot, walking on to where their day is taking them.
   */
  private bringBack(k: Spot, now: number): void {
    const peds = this.g.peds, P = this.g.player.pos;
    if (peds.agentOf(k.cit.id) || Math.hypot(k.x - P.x, k.z - P.z) > PEOPLE.backR) return;
    if ((this.backT.get(k.cit.id) ?? 0) > this.time) return;
    this.backT.set(k.cit.id, this.time + PEOPLE.backEvery);
    const st = peds.pop.stateAt(k.cit, now);
    const to = st.trip?.to ?? st.stay?.place;
    if (!to) return;
    // (Already at the place they are staying at: indoors, where the interiors put them.)
    const at = peds.placeSpot(to);
    if (!st.trip && at && Math.hypot(at.x - k.x, at.z - k.z) < 30) return;
    peds.bringBack(k.cit, k.x, k.z, to);
  }

  /** Where their day plan has them now (a place, or a point on the way between two). */
  private planSpot(k: Spot, now: number): { x: number; z: number; exact: boolean } | null {
    return this.planSpotOf(k.cit, now);
  }

  private planSpotOf(c: Citizen, now: number): { x: number; z: number; exact: boolean } | null {
    const peds = this.g.peds;
    const st = peds.pop.stateAt(c, now);
    if (st.stay) return peds.placeSpot(st.stay.place);
    if (st.trip) {
      const A = peds.placeSpot(st.trip.from), B = peds.placeSpot(st.trip.to);
      if (!A || !B) return A ?? B;
      const t = Math.max(0, Math.min(1, (now - st.trip.depart) / Math.max(1e-3, st.tripEnd - st.trip.depart)));
      return { x: A.x + (B.x - A.x) * t, z: A.z + (B.z - A.z) * t, exact: A.exact && B.exact };
    }
    return null;
  }

  /** dev: who you know, where they are. */
  report(): string[] {
    const now = this.g.sky.hoursAbs;
    return this.known.map((k) => {
      const w = this.whereNow(k, now);
      return `${k.name} (${this.person(k.cit).temper}, ${this.person(k.cit).job.title}): met ${k.met}, talks ${k.talks}, helped ${k.helped}, hurt ${k.hurt}, at ${w ? `${w.x.toFixed(0)},${w.z.toFixed(0)}${w.exact ? '' : '~'}` : '?'}`;
    });
  }
}

function opinionWord(op: number): string {
  return op >= 60 ? 'adores you' : op >= 25 ? 'likes you' : op > -10 ? 'neutral' : op > -40 ? 'wary of you' : 'dislikes you';
}

function actorMood(f: TalkFacts): Mood {
  if (f.opinion < -40) return 'angry';
  if (f.moodWord === 'shaken') return 'afraid';
  return f.mood > 0.2 ? 'happy' : f.mood < -0.45 ? 'sad' : 'neutral';
}

function pick<T>(l: readonly T[]): T {
  return l[Math.floor(Math.random() * l.length)];
}

function segDist(ax: number, az: number, bx: number, bz: number, px: number, pz: number): number {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(ax + dx * t - px, az + dz * t - pz);
}
