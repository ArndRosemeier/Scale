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
 * Remembered: everyone you talk to or help up; people you already know also remember being
 * knocked down by you. At most PEOPLE.cap of them (memory.ts decides who is forgotten).
 */
import type { Game } from '../Game';
import { PState, type PedAgent } from '../../sim/Pedestrians';
import { Role, type Citizen } from '../../sim/Population';
import { makeActor, release, type Actor, type Mood } from '../../sim/actors/Actor';
import { cityName, streetName } from '../../plan/names';
import { gameTimeLabel } from '../save/model';
import type { MapMarker } from '../../ui/map/GameMap';
import { nameOf, traitsOf, temperamentOf, jobOf, interestOf, moodOf, moodWord, yearsOf, MOOD_LABEL, type Traits, type Temperament, type Job } from './identity';
import { RuleBackend, ruleAnswer, dirWord, type TalkBackend, type TalkFacts, type Picked } from './talk';
import { CHAT, type Topic } from './lines';
import { PEOPLE, newKnown, opinionOf, applyDeed, addSaid, addNote, remember, savePeople, restorePeople, type Known, type Deed } from './memory';
import { TalkUi } from '../../ui/TalkUi';
import { hashCombine } from '../../core/rng';

/** Owner id of the people you are talking to (sim/actors/Actor owners). */
export const TALK_OWNER = -4;

export const TALK = {
  /** Talking range to the person in front of you, and to the targeted one (m, from the body's edge). */
  reach: 1.8, targetReach: 3.5,
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

interface Session {
  a: PedAgent;
  p: Person;
  k: Known;
  /** Our actor on them (null: indoors, where they are only turned to face you). */
  act: Actor | null;
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
  private markKey = '';
  private greeted = new Map<number, number>();
  private time = 0;
  /** Knock-downs already counted (per person, game seconds): a tumble is one deed, not every bounce. */
  private hurtAt = new Map<number, number>();
  readonly city: string;

  constructor(private g: Game) {
    this.city = cityName(g.settings.seed);
    this.ui = new TalkUi({
      choose: (topic) => this.ask(topic),
      way: (d) => this.showWay(d),
      close: () => this.end(),
      destinations: () => this.destinations(),
    });
    try { this.known.push(...restorePeople(JSON.parse(localStorage.getItem(STORE(g)) ?? 'null'))); } catch { /* storage unavailable */ }
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

  /** The target frame's name and sub line for a person ("Mara Okonkwo", "shop assistant · knows you"). */
  label(a: PedAgent): { name: string; kind: string; ours: boolean } {
    const p = this.person(a.cit), k = this.find(a.cit.id);
    const job = p.job.title.charAt(0).toUpperCase() + p.job.title.slice(1);
    return { name: p.full, kind: k ? `${job} · knows you` : job, ours: a.actor?.owner === TALK_OWNER };
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

  // ------------------------------------------------------------------ memory

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
    this.known.length = 0;
    this.known.push(...restorePeople(raw));
    this.markKey = '#stale';
    this.persist();
  }

  /** Forget everyone (dev). */
  forget(): void { this.known.length = 0; this.markKey = '#stale'; this.persist(); }

  // ------------------------------------------------------------------ talking

  get talking(): boolean { return !!this.session; }
  /** The talk panel has the keyboard (or just let go of it): Esc must not open the pause menu. */
  get holdsPointer(): boolean { return this.ui.holdsPointer; }

  private canTalk(): boolean {
    const P = this.g.player;
    return !this.g.freeCam && !P.flying && P.grounded && P.height >= 1.2 && P.height <= 2.4 && P.downT <= 0 && !P.ragdoll && !this.g.defeat?.active && !this.g.map.open;
  }

  private willTalk(a: PedAgent): boolean {
    if (!a.alive || a.actor || a.evac || a.ragdoll) return false;
    return a.state === PState.Walk || a.state === PState.Wait || a.state === PState.Idle || a.state === PState.Gawk || a.state === PState.Film;
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
    const before = this.find(a.cit.id);
    const metBefore = before ? before.met : 0, lastBefore = before ? before.last : this.g.sky.hoursAbs;
    const k = this.note(a, 'talked');
    let act: Actor | null = null;
    if (!a.inside) {
      act = makeActor('bystander', TALK_OWNER, { title: p.full, face: { x: P.pos.x, y: P.pos.y + P.height * 0.9, z: P.pos.z } });
      a.actor = act;
    }
    a.heading = Math.atan2(-(P.pos.x - a.x), -(P.pos.z - a.z));
    this.session = { a, p, k, act, idle: 0, closing: 0, metBefore, lastBefore, n: 0, since: this.g.consequences.time };
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
    const facts = { ...this.facts(s), ...extra };
    const seed = hashCombine(s.p.cit.seed, Math.floor(this.g.sky.hoursAbs * 4) * 131 + s.n);
    const req = { topic, facts, seed, used: new Set(s.k.said), memory: s.k.notes.map((n) => n.text) };
    const rule: Picked = ruleAnswer(req);
    addSaid(s.k, rule.id);
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
    const age = p.cit.role === Role.Child ? `${p.years}` : `about ${Math.round(p.years / 5) * 5}`;
    const sub = `${p.job.title.charAt(0).toUpperCase()}${p.job.title.slice(1)} · ${age} · ${p.temper} · ${MOOD_LABEL[f.moodWord]}`;
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
    const opinion = opinionOf(k, rep, p.traits.a);
    const trouble = this.troubleAt(a.x, a.z);
    const weather = g.weather?.kind ?? 'fair';
    const mood = moodOf(p.cit, p.traits, { day: Math.floor(now / 24), hour: g.sky.hour, weather, trouble, opinion });
    const f = g.crime?.factionAt(a.x, a.z) ?? null;
    const boss = f ? g.crime.bosses.find((b) => b.faction === f.id) ?? null : null;
    const C = g.consequences;
    return {
      first: p.first, last: p.last, full: p.full, years: p.years, child: p.cit.role === Role.Child, senior: p.years >= 66,
      traits: p.traits, temper: p.temper, job: p.job, interest: p.interest, mood, moodWord: moodWord(mood, trouble),
      met: s.metBefore, deed: k.deed, days: Math.max(0, (now - s.lastBefore) / 24),
      opinion, hour: g.sky.hour, weather, trouble,
      threat: C.log.some((e) => e.cause === 'threat' && C.time - e.t < 900),
      street: this.streetAt(a.x, a.z), metStreet: k.deedStreet, city: this.city,
      group: f?.name ?? null, boss: boss?.name ?? null, giant: g.player.height > 2.4,
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
      else a.heading = Math.atan2(-(P.pos.x - a.x), -(P.pos.z - a.z));
      const lost = !a.alive || (s.act && a.actor !== s.act) || a.state === PState.Down || a.ragdoll;
      if (s.closing > 0) { s.closing -= dt; if (s.closing <= 0) this.end(); }
      else if (lost || Math.hypot(a.x - P.pos.x, a.z - P.pos.z) > TALK.leave || s.idle > TALK.idle || !this.canTalk() || this.harmSince(a.x, a.z, s.since)) this.end();
    }
    this.greet();
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
      const op = opinionOf(k, this.g.crime?.rep.value ?? 0, p.traits.a);
      const line = op < -30 ? pick(['Hmph.', 'Oh. You.', 'Watch it, you.'])
        : k.deed === 'helped' ? pick(['Hey, my rescuer!', 'Hi again! Still in one piece, thanks to you.'])
          : p.traits.e > 0.55 || op > 40 ? pick(['Hey! Hello again!', 'Oh, hi! Good to see you!', `Hi! It's me, ${p.first}!`])
            : pick(['Oh, hello.', 'Hi again.']);
      if (this.g.barks.say(a, line, 30)) this.greeted.set(k.cit.id, this.time);
      return;
    }
  }

  /** Faint dots on the map where the people you met are now. */
  private markers(): void {
    const g = this.g, now = g.sky.hoursAbs, rep = g.crime?.rep.value ?? 0;
    const list: MapMarker[] = [];
    for (const k of this.known) {
      const spot = this.whereNow(k, now);
      if (!spot) continue;
      const p = this.person(k.cit);
      const op = opinionOf(k, rep, p.traits.a);
      const color = op >= 40 ? '#8ff0b4' : op <= -30 ? '#ffa894' : '#a9d6ff';
      const times = k.met === 1 ? 'met once' : `met ${k.met} times`;
      const at = spot.exact ? '' : ' · somewhere around here';
      list.push({ x: spot.x, z: spot.z, color, kind: 'faint', title: `${p.full}, ${p.job.title} — ${times}, last on ${gameTimeLabel(Math.floor(k.last / 24), k.last % 24)} · ${opinionWord(op)}${at}` });
    }
    const key = list.map((m) => `${m.x.toFixed(0)},${m.z.toFixed(0)},${m.color}`).join(';');
    if (key !== this.markKey) { this.markKey = key; g.map.setMarkers('people', list); }
  }

  /** Where a known person is now: their live body near the player, else their day plan's place. */
  whereNow(k: Known, now: number): { x: number; z: number; exact: boolean } | null {
    const peds = this.g.peds;
    const a = peds.agentOf(k.cit.id);
    if (a && a.alive) { k.x = a.x; k.z = a.z; return { x: a.x, z: a.z, exact: true }; }
    const st = peds.pop.stateAt(k.cit, now);
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
