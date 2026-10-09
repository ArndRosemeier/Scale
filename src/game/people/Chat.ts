/**
 * Typed chat with the people of the city (the chat/ modules): what People needs to answer a
 * typed line. It builds what the one you talk to knows (ChatWorld: who they are, the people close
 * to them, where they live and work and where they are going, the street, its gang, the threats
 * lately, what the hero told them) and the names a line may use (the lexicon), runs the
 * understanding (patterns, the sentence model, word overlap) and keeps the conversation's state.
 *
 * The people close to someone (their circle) are made from their seed like everything else: a
 * partner, children, parents, brothers and sisters, a friend or two, a neighbour, a colleague,
 * each a citizen of their own (synthetic, so a name, a job, an age and an interest), family with
 * the family name. Nothing is stored for them.
 *
 * The sentence model loads in a worker the first time someone is talked to (Embedder.ts); until
 * then, and if it can't, lines are understood by patterns and word overlap.
 */
import type { Game } from '../Game';
import { Role, type Citizen } from '../../sim/Population';
import { Rng, deriveSeed, hashCombine } from '../../core/rng';
import { streetName } from '../../plan/names';
import { nameOf, traitsOf, temperamentOf, jobOf, interestOf, yearsOf, isFemale, INTERESTS } from './identity';
import type { TalkFacts } from './talk';
import type { Known } from './memory';
import type { Bond } from './social';
import { Understander, type Parse } from './chat/understand';
import { WorkerEmbedder } from './chat/Embedder';
import { Conversation, type ChatWorld, type Kin, type Who, type ThreatSeen, type Way, type HeroKnown } from './chat/respond';
import { FACTIONS, THREATS, PLACE_KINDS, KIN_WORDS, type Ent } from './chat/lexicon';
import { THINGS, type Category } from './chat/prefs';
import { dirWord } from './talk';
import { logMissed } from './chat/log';

/** Threat archetypes as people call them. */
const THREAT_LABEL: Record<string, string> = {
  robots: 'the robot malfunction', brood: 'the swarm', strider: 'the Strider', tree: 'the walking tree', burrower: 'the giant worm',
  leviathan: 'the leviathan', roc: 'the roc', mech: 'the mech', teens: 'the flying saucer',
};

export interface ChatSession {
  conv: Conversation;
  cit: Citizen;
  kin: Kin[];
  ents: Ent[];
}

export class Chat {
  readonly understand: Understander;
  private embedder: WorkerEmbedder | null;
  private streets: Map<string, { x: number; z: number }[]> | null = null;
  private fixed: Ent[] | null = null;
  /** Big threats seen this session, by event id (ThreatDirector drops ended events after a while). */
  private seen = new Map<number, ThreatSeen & { t0: number; id: number }>();
  private seenT = 0;

  constructor(private g: Game) {
    this.embedder = typeof Worker !== 'undefined' ? new WorkerEmbedder() : null;
    this.understand = new Understander(this.embedder);
  }

  /** Start loading the sentence model (the first talk). */
  warm(): void {
    if (!this.embedder || this.embedder.failed) return;
    void this.embedder.start().then((ok) => (ok ? this.understand.prepare() : false));
  }

  /** Keep up with the big threats (a few times a minute). */
  update(dt: number): void {
    this.seenT -= dt;
    if (this.seenT > 0) return;
    this.seenT = 3;
    const T = this.g.threats;
    if (!T) return;
    const now = this.g.sky.hoursAbs;
    for (const ev of T.events) {
      const label = THREAT_LABEL[ev.archetype];
      if (!label) continue;
      const s = this.seen.get(ev.id);
      const street = this.g.people.streetAt(ev.x, ev.z);
      if (!s) this.seen.set(ev.id, { id: ev.id, kind: ev.archetype, label, t0: now, ago: 0, street, active: ev.active, beaten: false });
      else { s.active = ev.active; if (!s.street) s.street = street; s.beaten = ev.outcome === 'defeated' || ev.outcome === 'destroyed' || ev.outcome === 'stopped'; }
    }
    if (this.seen.size > 20) this.seen.delete(this.seen.keys().next().value!);
  }

  /** A conversation begins. */
  begin(cit: Citizen, troubled: boolean): ChatSession {
    const kin = this.circleOf(cit);
    const ents = [...this.fixedEnts(), ...kin.map((k, i): Ent => ({ kind: 'person', id: `kin:${i}`, label: k.who.first, names: [k.who.first, k.who.full] }))];
    for (const k of this.g.people.known) if (k.cit.id !== cit.id) ents.push({ kind: 'person', id: `known:${k.cit.id}`, label: k.name, names: [k.name, k.name.split(' ')[0]] });
    const g = this.g;
    if (g.crime) {
      for (const b of g.crime.bosses) ents.push({ kind: 'boss', id: `boss:${b.faction}`, label: b.name, names: [b.name, ...b.name.split(' ').filter((w) => w.length > 3)] });
      for (const f of g.crime.factions.factions) ents.push({ kind: 'group', id: `group:${f.id}`, label: f.name, names: [f.name] });
    }
    return { conv: new Conversation(hashCombine(cit.seed, Math.floor(g.sky.hoursAbs)), traitsOf(cit), troubled), cit, kin, ents };
  }

  /** Understand a typed line and answer it (the model may take a moment). */
  async reply(s: ChatSession, text: string, facts: TalkFacts, k: Known, x: number, z: number) {
    if (this.embedder && !this.understand.modelReady) this.warm();
    const p: Parse = await this.understand.parse(text, s.ents);
    const w = this.world(s, facts, k, x, z);
    const r = s.conv.reply(p, w);
    if (r.via.startsWith('chat:fallback')) logMissed(p, w.me.temper, r.text || r.topic || '');
    return { p, r };
  }

  /** Who someone is, for the chat. */
  who(c: Citizen, last?: string): Who {
    const g = this.g;
    const t = traitsOf(c), n = nameOf(c), y = yearsOf(c);
    const wd = c.work ? g.macro.cells[c.work.cell]?.district ?? null : null;
    const lastName = last ?? n.last;
    return {
      first: n.first, last: lastName, full: `${n.first} ${lastName}`, years: y, female: isFemale(c), child: c.role === Role.Child || y < 15, senior: y >= 66,
      traits: t, temper: temperamentOf(t), job: jobOf(c, wd), interest: interestOf(c), seed: c.seed,
      home: this.streetOfCell(c.home.cell, c.home.pick + c.home.b), work: c.work ? this.streetOfCell(c.work.cell, c.work.pick + c.work.b) : null,
    };
  }

  /** A street on the edge of a macro cell (the same one for the same pick). */
  private streetOfCell(cell: number, pick: number): string | null {
    const c = this.g.macro.cells[cell];
    if (!c || !c.edges.length) return null;
    const e = c.edges[((pick % c.edges.length) + c.edges.length) % c.edges.length];
    const E = this.g.macro.edges[e];
    return E ? streetName(this.g.settings.seed, e, E.cls) : null;
  }

  /**
   * The people close to someone, from their seed: family (sharing the family name; partner,
   * children at home and, for a child, the parents live with them), friends, a neighbour, a colleague.
   */
  circleOf(c: Citizen): Kin[] {
    const r = new Rng(deriveSeed(c.seed, 'circle'));
    const pop = this.g.peds.pop;
    const me = this.who(c);
    const y = me.years;
    const out: Kin[] = [];
    const make = (word: string, bond: Bond, years: number, female: boolean | null, withMe: boolean, family: boolean): void => {
      const base = pop.synthetic(r.nextU32() | 1);
      female = FEMALE_WORD[word] ?? female;
      const age = Math.max(0.03, Math.min(0.97, years / 100));
      const cit: Citizen = {
        ...base, age, gender: female === null ? base.gender : female ? 0.25 : 0.75,
        role: years < 16 ? Role.Child : years >= 66 ? Role.Senior : base.work ? Role.Worker : Role.Adult,
        home: withMe ? c.home : base.home, work: years < 19 || years >= 66 ? null : base.work,
      };
      out.push({ word, bond, who: this.who(cit, family ? me.last : undefined), withMe });
    };
    if (me.child) {
      const parentAge = y + 24 + r.int(0, 14);
      make('mother', 'family', parentAge, true, true, true);
      if (r.chance(0.8)) make('father', 'family', parentAge + r.int(-3, 6), false, true, true);
      for (let i = r.int(0, 2); i > 0; i--) { const f = r.chance(0.5); make(f ? 'sister' : 'brother', 'family', Math.max(1, y + r.int(-6, 6)), f, true, true); }
      for (let i = r.int(1, 2); i > 0; i--) make('friend', 'friend', Math.max(5, y + r.int(-1, 1)), null, false, false);
    } else {
      const partner = y >= 24 && y <= 85 && r.chance(y < 30 ? 0.35 : 0.6);
      if (partner) make(me.female ? (r.chance(0.9) ? 'husband' : 'wife') : (r.chance(0.9) ? 'wife' : 'husband'), 'family', y + r.int(-4, 4), null, true, true);
      if (y >= 28 && r.chance(partner ? 0.65 : 0.25)) {
        for (let i = r.int(1, 3); i > 0; i--) {
          const ky = Math.max(1, y - r.int(22, 38)), f = r.chance(0.5);
          make(f ? 'daughter' : 'son', 'family', ky, f, ky < 20, true);
        }
      }
      if (y < 62 && r.chance(0.8 - y / 120)) make('mother', 'family', y + r.int(22, 34), true, y < 22, true);
      if (y < 55 && r.chance(0.65 - y / 120)) make('father', 'family', y + r.int(24, 36), false, y < 22, true);
      for (let i = r.int(0, 2); i > 0; i--) { const f = r.chance(0.5); make(f ? 'sister' : 'brother', 'family', Math.max(5, y + r.int(-9, 9)), f, false, true); }
      for (let i = r.int(0, 2) + (me.traits.e > 0.6 ? 1 : 0); i > 0; i--) make('friend', 'friend', Math.max(16, y + r.int(-8, 8)), null, false, false);
      if (r.chance(0.6)) make('neighbour', 'neighbour', Math.max(18, r.int(20, 85)), null, false, false);
      if (c.work && r.chance(0.7)) make('colleague', 'colleague', Math.max(19, y + r.int(-15, 15)), null, false, false);
    }
    return out;
  }

  /** Names that don't depend on who you talk to: factions, threats, places, streets, things. */
  private fixedEnts(): Ent[] {
    if (this.fixed) return this.fixed;
    const g = this.g, m = g.macro;
    const out: Ent[] = [...FACTIONS, ...THREATS, ...PLACE_KINDS];
    for (const word in KIN_WORDS) out.push({ kind: 'kin', id: `kinword:${word}`, label: word, data: word, names: KIN_WORDS[word].flatMap((w) => [`your ${w}`, `ur ${w}`, w]) });
    for (const l of m.landmarks) out.push({ kind: 'place', id: `place:${l.id}`, label: l.name, names: [l.name, ...landmarkWords(l.kind)], x: l.x, z: l.z });
    for (const st of m.metroStations) out.push({ kind: 'place', id: `station:${st.id}`, label: `${st.name} station`, names: [`${st.name} station`, st.name], x: st.x, z: st.z });
    for (const [name, pts] of this.streetIndex()) out.push({ kind: 'street', id: `street:${name}`, label: name, names: [name], x: pts[0].x, z: pts[0].z });
    for (const h of g.city?.hoods.list ?? []) out.push({ kind: 'hood', id: `hood:${h.id}`, label: h.name, names: [h.name], x: h.x, z: h.z });
    out.push({ kind: 'city', id: 'city', label: g.people.city, names: [g.people.city, 'the city', 'this city', 'this town'] });
    const things = new Set<string>();
    for (const c in THINGS) for (const t of THINGS[c as Category]) things.add(t);
    for (const it of INTERESTS) things.add(it.replace(/^their /, ''));
    for (const t of things) out.push({ kind: 'thing', id: `thing:${t}`, label: t, names: [t] });
    this.fixed = out;
    return out;
  }

  /** Every street name and where its pieces are (centres). */
  private streetIndex(): Map<string, { x: number; z: number }[]> {
    if (this.streets) return this.streets;
    const m = new Map<string, { x: number; z: number }[]>();
    const E = this.g.macro.edges;
    for (let i = 0; i < E.length; i++) {
      const pts = E[i].pts;
      if (pts.length < 4) continue;
      const j = Math.floor(pts.length / 4) * 2;
      const name = streetName(this.g.settings.seed, i, E[i].cls);
      const arr = m.get(name) ?? [];
      arr.push({ x: pts[j], z: pts[j + 1] });
      m.set(name, arr);
    }
    this.streets = m;
    return m;
  }

  /** What they know now. */
  private world(s: ChatSession, facts: TalkFacts, k: Known, x: number, z: number): ChatWorld {
    const g = this.g, now = g.sky.hoursAbs;
    const me = this.who(s.cit);
    const known: HeroKnown[] = [];
    for (const o of g.people.known) {
      if (o.cit.id === s.cit.id) continue;
      known.push({ id: o.cit.id, who: this.who(o.cit), word: null });
    }
    const threats = [...this.seen.values()].map((t) => ({ ...t, ago: Math.max(0, now - t.t0) })).sort((a, b) => a.ago - b.ago);
    const here = g.crime?.factionAt(x, z) ?? null;
    let gangNear: string | null = null;
    if (g.crime && !here) {
      for (const [dx, dz] of [[300, 0], [-300, 0], [0, 300], [0, -300]]) { const f = g.crime.factionAt(x + dx, z + dz); if (f) { gangNear = f.name; break; } }
    }
    let hideout: ChatWorld['hideout'] = null;
    if (here && g.crime) {
      const h = g.crime.hideouts.find((o) => o.faction === here.id);
      const at = h?.door ?? (h ? { x: g.macro.cells[h.cell]?.centroid[0] ?? x, z: g.macro.cells[h.cell]?.centroid[1] ?? z } : null);
      if (at) hideout = { dir: dirWord(at.x - x, at.z - z), dist: Math.hypot(at.x - x, at.z - z) };
    }
    const plan = g.peds.pop.dayPlan(s.cit, Math.floor(now / 24));
    const nextStay = plan.stays.find((st) => st.from > now - 0.25 && st.to > now);
    return {
      facts, me, kin: s.kin, known, threats, gangNear, hideout,
      next: nextStay ? nextStay.place.kind : null,
      way: (e) => this.way(e, x, z),
      heroName: k.heroName ?? null, heroLikes: k.heroLikes ?? [],
      favour: !k.favour,
    };
  }

  /** Where an entity is (a landmark, a station, a street, a neighbourhood, the nearest of a kind of place). */
  private way(e: Ent, x: number, z: number): Way | null {
    const m = this.g.macro;
    if (e.kind === 'street') {
      const pts = this.streetIndex().get(e.label) ?? [];
      let best: Way | null = null, bd = Infinity;
      for (const p of pts) { const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; best = { label: e.label, x: p.x, z: p.z }; } }
      return best;
    }
    if ((e.kind === 'place' || e.kind === 'hood') && e.x !== undefined && e.z !== undefined) {
      // A landmark kind word ("the museum") names the nearest of that kind.
      if (e.id.startsWith('place:')) {
        const l = m.landmarks.find((o) => `place:${o.id}` === e.id);
        if (l) {
          const same = m.landmarks.filter((o) => o.kind === l.kind).sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
          const near = same[0] ?? l;
          return { label: near.name, x: near.x, z: near.z };
        }
      }
      return { label: e.label, x: e.x, z: e.z };
    }
    if (e.kind === 'placeKind') {
      if (e.data === 'station') {
        const st = m.metroStations.slice().sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
        return st ? { label: `${st.name} station`, x: st.x, z: st.z } : null;
      }
      if (e.data === 'park') {
        let best: Way | null = null, bd = Infinity;
        for (const c of m.cells) if (c.district === 'park') { const d = Math.hypot(c.centroid[0] - x, c.centroid[1] - z); if (d < bd) { bd = d; best = { label: 'the park', x: c.centroid[0], z: c.centroid[1] }; } }
        return best;
      }
    }
    return null;
  }
}

/** Words people use for a landmark of a kind. */
function landmarkWords(kind: string): string[] {
  const W: Record<string, string[]> = {
    townhall: ['town hall', 'city hall', 'townhall'], stadium: ['stadium', 'football ground', 'arena'], airport: ['airport', 'airfield', 'terminal'],
    tower: ['tower', 'observation tower', 'tv tower'], cathedral: ['cathedral', 'church'], wheel: ['big wheel', 'ferris wheel', 'wheel'],
    monument: ['monument', 'statue', 'memorial'], museum: ['museum', 'gallery'], lighthouse: ['lighthouse'], fortress: ['castle', 'fortress', 'keep'],
    glasshouse: ['glasshouse', 'greenhouse', 'palm house', 'botanical garden'], marvel: [],
  };
  return W[kind] ?? [];
}

/** The gender a kin word says (the circle's citizens are made to match, so their names do). */
const FEMALE_WORD: Record<string, boolean> = {
  mother: true, sister: true, daughter: true, wife: true, grandmother: true, granddaughter: true,
  father: false, brother: false, son: false, husband: false, grandfather: false, grandson: false,
};
