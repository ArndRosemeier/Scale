/**
 * The conversation (typed NPC chat): what someone answers to what you typed, given what they
 * know (ChatWorld, built by People from the game) and the state of this conversation (who you
 * are talking about, what they asked you, how much patience they have left). It never touches
 * the game itself: it returns the words and the effects (opinion, your name remembered, they
 * leave or run, a waypoint), and People applies them.
 *
 * Answers that the talk menu already gives (hello, how are you, what do you do, news, the way,
 * a favour, what do you think of me, goodbye) come back as a menu topic, so typed and clicked
 * questions sound the same and keep everything the menu knows (hearsay, needs, favours).
 *
 * Pure.
 */
import { hashCombine, hashString, hashToFloat } from '../../../core/rng';
import type { Topic } from '../lines';
import { pickLine, withArticle, distLabel, type TalkFacts } from '../talk';
import type { Job, Temperament, Traits } from '../identity';
import type { Bond } from '../social';
import type { Intent } from './intents';
import type { Parse } from './understand';
import { CHAT, type ChatTopic } from './answers';
import { KIN_WORDS, type Ent } from './lexicon';
import { THINGS, CATEGORY_WORDS, liking, favourite, stance, type Category } from './prefs';
import { fallback } from './eliza';
import { voiced } from './voice';

/** Someone (the one you talk to, or someone close to them). */
export interface Who {
  first: string;
  last: string;
  full: string;
  years: number;
  female: boolean;
  child: boolean;
  senior: boolean;
  traits: Traits;
  temper: Temperament;
  job: Job;
  interest: string;
  seed: number;
  /** Streets they live and work on (null: not known, or out of town). */
  home: string | null;
  work: string | null;
}

/** Someone close to them, and what they are to them ("brother", "friend", "neighbour"). */
export interface Kin { word: string; bond: Bond; who: Who; withMe: boolean }

/** Someone the hero knows, and what they are to this person (null: nothing). */
export interface HeroKnown { id: number; who: Who; word: string | null }

export interface ThreatSeen {
  /** ThreatDirector archetype ("burrower", "strider" …). */
  kind: string;
  label: string;
  /** Hours since it began. */
  ago: number;
  street: string | null;
  active: boolean;
  beaten: boolean;
}

/** A place to show the way to. */
export interface Way { label: string; x: number; z: number }

/** What the one you talk to knows (built by People for this moment). */
export interface ChatWorld {
  facts: TalkFacts;
  me: Who;
  kin: readonly Kin[];
  known: readonly HeroKnown[];
  /** Where they are going next: home, work, shop, food, park, school, leisure; null: nowhere special. */
  next: string | null;
  /** The place an entity names, or the nearest of a kind of place; null: none that they know. */
  way(e: Ent): Way | null;
  /** Big threats lately (newest first). */
  threats: readonly ThreatSeen[];
  /** Another villain group holding streets close by (not this one). */
  gangNear: string | null;
  /** The gang's hideout from here, if there is a gang here and one is known. */
  hideout: { dir: string; dist: number } | null;
  /** What the hero told them before (remembered). */
  heroName: string | null;
  heroLikes: readonly string[];
  /** Asking for a favour now is possible (the favour topic will offer one). */
  favour: boolean;
}

export interface Effects {
  /** Opinion of the hero (added to what they remember of this conversation). */
  opinion?: number;
  rep?: number;
  heroName?: string;
  heroLike?: string;
  /** The talk ends after this line (they walk on), or they run away. */
  end?: boolean;
  flee?: boolean;
  /** They calm down (less shaken). */
  calm?: boolean;
  waypoint?: Way;
}

export interface Reply {
  /** What they say (empty when `topic` answers alone). */
  text: string;
  /** Answer with the menu's lines for this topic first (People asks its backend). */
  topic?: Topic;
  extra?: Partial<TalkFacts>;
  /** Said after the topic's answer (a question back). */
  after?: string;
  effects: Effects;
  /** What answered, for the log and tests ("chat:like", "menu:mood", "fallback"). */
  via: string;
}

type Expect = { kind: 'yesno'; thing: string } | { kind: 'name' } | { kind: 'fav'; cat: Category };

/** One conversation's memory (People keeps one per talk). */
export class Conversation {
  turns = 0;
  patience: number;
  misses = 0;
  private used = new Set<string>();
  private expect: Expect | null = null;
  private focus: Kin | null = null;
  private lastHero: Intent | null = null;
  private lastThing: string | null = null;
  private why: string | null = null;
  private lastLine = '';
  private counts = new Map<string, number>();
  private asked = new Set<string>();

  constructor(private seed: number, traits: Traits, troubled: boolean) {
    this.patience = 4 + traits.a * 5 + traits.e * 2 - (troubled ? 2 : 0);
  }

  private count(k: string): number {
    const n = (this.counts.get(k) ?? 0) + 1;
    this.counts.set(k, n);
    return n;
  }

  private u(salt: string): number {
    return hashToFloat(hashCombine(hashCombine(this.seed, this.turns * 7919), hashString(salt)));
  }

  /** A line of a chat topic, filled. */
  private say(topic: ChatTopic, w: ChatWorld, flags: readonly string[] = [], tok: Record<string, string> = {}): string {
    const f: TalkFacts = { ...w.facts, flags: new Set(flags) };
    const p = pickLine(topic as Topic, f, hashCombine(this.seed, this.turns * 131 + this.used.size), this.used, CHAT[topic]);
    this.used.add(p.id);
    const base: Record<string, string> = {
      age: String(w.me.years), home: w.me.home ?? 'the other side of town', work: w.me.work ?? 'across town', heroname: w.heroName ?? 'friend',
      fav: favourite(w.me.seed, w.me.traits, w.me.years, w.me.interest, 'colour'), clock: clockWords(w.facts.hour),
    };
    return fillTokens(p.text, { ...base, ...tok });
  }

  /** The answer to a typed line. */
  reply(p: Parse, w: ChatWorld): Reply {
    this.turns++;
    const r = this.answer(p, w);
    if (r.text) r.text = voiced(r.text, w.me.temper, w.me.child, this.u('voice'));
    if (r.after) r.after = voiced(r.after, w.me.temper, w.me.child, this.u('voice2'));
    if (r.text) this.lastLine = r.after ? `${r.text} ${r.after}` : r.text;
    if (p.intent !== 'unclear' && p.intent !== 'repeat') this.misses = 0;
    // Out of patience: the last word, and off they go.
    if (!r.effects.end && this.patience <= 0) {
      const t = this.say('patience', w, r.effects.opinion !== undefined && r.effects.opinion < 0 ? ['hurt'] : []);
      return { text: r.text ? `${r.text} ${t}` : t, effects: { ...r.effects, end: true }, via: `${r.via}+patience` };
    }
    return r;
  }

  /** The last thing they said (People tells the conversation when a menu topic answered). */
  heard(text: string): void { this.lastLine = text; }

  private answer(p: Parse, w: ChatWorld): Reply {
    const f = w.facts, me = w.me;
    const E: Effects = {};
    const done = (text: string, via: string, extra: Partial<Reply> = {}): Reply => ({ text, effects: E, via: `chat:${via}`, ...extra });
    const menu = (topic: Topic, via: string, extra: Partial<Reply> = {}): Reply => ({ text: '', topic, effects: E, via: `menu:${via}`, ...extra });
    const kinOf = this.subject(p, w);
    const thing = this.thingIn(p);
    const intent = this.reread(p, w);
    const exp = this.expect;
    this.expect = null;
    this.why = intent === 'why' || intent === 'more' ? this.why : null;
    const ask = (q: Expect, flags: string[], tok: Record<string, string> = {}): string => {
      this.expect = q;
      return this.say('ask_back', w, flags, tok);
    };

    // ---------------------------------------------------------------- answers to their question
    if (exp?.kind === 'yesno' && (intent === 'yes' || intent === 'no')) {
      const theirs = liking(me.seed, me.traits, me.years, me.interest, exp.thing);
      const yes = intent === 'yes';
      if (yes) E.heroLike = exp.thing;
      if (yes && theirs > 0.2 && this.count(`agree:${exp.thing}`) === 1) E.opinion = 3;
      return done(this.say(yes ? 'answer_yes' : 'answer_no', w, ['thing'], { thing: exp.thing }), yes ? 'answer_yes' : 'answer_no');
    }
    if (exp?.kind === 'name' && intent !== 'tell_name' && p.norm.words.length <= 3 && /^\p{L}/u.test(p.norm.raw) && (intent === 'unclear' || intent === 'greet' || intent === 'okay')) {
      return this.tellName(titleCase(p.norm.raw.replace(/[^\p{L}\s'-]/gu, '').trim()), w, E, done);
    }
    if (exp?.kind === 'fav' && (thing || intent === 'unclear' || intent === 'okay') && p.norm.words.length <= 5) {
      const t = thing ?? p.norm.text.replace(/^(my favourite is|mine is|i like|i love|probably|definitely|i guess|i would say)\s+/, '').trim();
      return this.tellLike(t, true, w, E, done);
    }

    const prevHero = this.lastHero;
    this.lastHero = intent;
    // "What does your wife do?" with no wife: say so (whatever was asked about her).
    if (!kinOf && ABOUT_SOMEONE.has(intent) && intent !== 'ask_opinion' && intent !== 'ask_know' && this.kinWord(p) && !GROUP_WORDS.has(this.kinWord(p)!)) return this.noKin(p, w, done);
    switch (intent) {
      // -------------------------------------------------------------- social
      case 'greet': return this.turns <= 1 ? done(this.say('greet_again', w, ['first']), 'greet') : done(this.say('greet_again', w), 'greet');
      case 'bye': return menu('bye', 'bye', { effects: { ...E, end: true } });
      case 'how_are_you': return menu('mood', 'mood');
      case 'thanks': if (this.count('thanks') === 1) E.opinion = 1; return done(this.say('thanks', w), 'thanks');
      case 'sorry': {
        const insulted = (this.counts.get('insult') ?? 0) > 0;
        if (f.deed === 'hurt' && this.count('sorry_hurt') === 1) E.opinion = 6;
        else if (insulted && this.count('sorry_insult') === 1) { E.opinion = 4; this.patience += 2; }
        return done(this.say('sorry', w, insulted ? ['insulted'] : []), 'sorry');
      }
      case 'compliment': {
        const n = this.count('compliment');
        E.opinion = n === 1 ? (me.temper === 'grumpy' ? 1 : 3) : n === 2 ? 1 : 0;
        return done(this.say('compliment', w, n > 1 ? ['again'] : []), 'compliment');
      }
      case 'insult': {
        const n = this.count('insult');
        E.opinion = n === 1 ? -8 : -12;
        this.patience -= me.temper === 'kind' ? 2 : 3;
        return done(this.say('insult', w, n > 1 ? ['again'] : []), 'insult');
      }
      case 'threat': {
        const brave = me.traits.n < 0.3 && (me.temper === 'grumpy' || me.temper === 'proud') && !me.child;
        E.opinion = -25;
        E.rep = -2;
        E.end = true;
        E.flee = !brave;
        return done(this.say('threatened', w, brave ? ['brave'] : []), 'threat');
      }
      case 'joke': if (this.count('joke') === 1) E.opinion = 1; return done(this.say('joke', w), 'joke');
      case 'laugh': return done(this.say('laugh', w), 'laugh');
      case 'flirt': {
        const partner = w.kin.find((k) => k.word === 'wife' || k.word === 'husband');
        const warm = f.opinion >= 40 && (me.temper === 'cheerful' || me.temper === 'chatty' || me.temper === 'nosy');
        E.opinion = me.child ? -3 : warm ? 1 : me.temper === 'grumpy' || partner ? -3 : -1;
        return done(this.say('flirt', w, partner && !me.child ? ['taken'] : [], partner ? { kword: partner.word } : {}), 'flirt');
      }
      case 'yes': case 'no':
        // "Do you like jazz?" "Not really." "Yes." : the hero says whether they like it.
        if (prevHero === 'ask_like' && this.lastThing) { this.lastHero = intent === 'yes' ? 'tell_like' : 'tell_dislike'; return this.tellLike(this.lastThing, intent === 'yes', w, E, done); }
        return done(this.say(intent, w), intent);
      case 'dunno': return done(this.say('dunno', w), 'dunno');
      case 'okay': return this.initiative(w, E, done) ?? done(this.say('okay', w), 'okay');
      case 'reassure': {
        if (f.trouble > 0.3 || f.threat) { E.calm = true; if (this.count('reassure') === 1) E.opinion = 3; }
        return done(this.say('reassure', w), 'reassure');
      }
      case 'req_calm': if (f.trouble > 0.3) E.calm = true; return done(this.say('calm', w), 'calm');
      case 'req_leave': {
        const goes = f.trouble > 0.3 || f.threat || f.opinion > 25 || me.traits.n > 0.65;
        if (goes) { E.end = true; E.flee = f.trouble > 0.3 || f.threat; }
        return done(this.say('leave', w, goes && f.trouble <= 0.3 ? ['goes'] : []), 'leave');
      }

      // -------------------------------------------------------------- about them
      case 'ask_name':
        if (kinOf) return this.aboutKin('name_kin', kinOf, w, done);
        if (this.kinWord(p)) return this.noKin(p, w, done);
        return done(this.say('name', w), 'name');
      case 'ask_age':
        if (kinOf) return this.aboutKin('age_kin', kinOf, w, done);
        return done(this.say('age', w), 'age');
      case 'ask_job':
        if (kinOf) return this.aboutKin('job_kin', kinOf, w, done);
        return menu('job', 'job');
      case 'ask_work_where':
        if (kinOf) return this.aboutKin('work_kin', kinOf, w, done, kinOf.who.work ? ['kwork'] : []);
        return done(this.say('work', w, me.work ? (me.work === f.street ? ['work', 'workhere'] : ['work']) : ['nowork']), 'work');
      case 'ask_home':
        if (kinOf) return this.aboutKin('home_kin', kinOf, w, done, kinOf.withMe ? ['kwithme'] : kinOf.who.home ? ['khome'] : []);
        return done(this.say('home', w, me.home ? (me.home === f.street ? ['home', 'homehere'] : ['home']) : ['nohome']), 'home');
      case 'ask_family': {
        const fam = w.kin.filter((k) => k.bond === 'family');
        if (!fam.length) return done(this.say('family', w, ['none']), 'family');
        this.focus = fam[0];
        return done(this.say('family', w, ['many'], { list: listOf(fam) }), 'family');
      }
      case 'ask_partner': {
        const k = w.kin.find((x) => x.word === 'wife' || x.word === 'husband');
        if (!k) return done(this.say('no_kin', w, ['partner'], { kword: 'partner' }), 'partner');
        this.focus = k;
        return done(this.say('partner', w, ['kin'], kinTokens(k)), 'partner');
      }
      case 'ask_children': {
        const ks = w.kin.filter((x) => x.word === 'son' || x.word === 'daughter');
        if (!ks.length) return done(this.say('no_kin', w, ['children'], { kword: 'children' }), 'children');
        this.focus = ks[0];
        return done(this.say('children', w, ['kin'], { ...kinTokens(ks[0]), list: listOf(ks) }), 'children');
      }
      case 'ask_friends': {
        const ks = w.kin.filter((x) => x.bond === 'friend');
        if (!ks.length) return done(this.say('friends', w, ['none']), 'friends');
        this.focus = ks[0];
        return done(this.say('friends', w, ['kin'], { ...kinTokens(ks[0]), list: listOf(ks) }), 'friends');
      }
      case 'ask_hobby':
        if (kinOf) return this.aboutKin('hobby_kin', kinOf, w, done);
        return menu('hobby', 'hobby', { after: this.maybeAskInterest(w, 0.35) });
      case 'ask_like': return this.askLike(thing, kinOf, p, w, done);
      case 'ask_favourite': {
        const cat = categoryIn(p.norm.text);
        if (!cat) return done(this.say('fav', w, ['nocat']), 'fav');
        const fav = favourite(me.seed, me.traits, me.years, me.interest, cat);
        const mine = me.interest.endsWith(fav);
        this.lastThing = fav;
        this.why = mine ? 'It\'s my thing. Always has been.' : null;
        const back = this.u('askfav') < 0.25 + me.traits.e * 0.4 ? ask({ kind: 'fav', cat }, ['q_fav']) : undefined;
        return done(this.say('fav', w, mine ? ['mine'] : [], { fav, cat }), 'fav', { after: back });
      }
      case 'ask_feel': return menu('mood', 'feel');
      case 'ask_scared': {
        const scared = me.traits.n > 0.55 || f.trouble > 0.4 || (f.threat && me.traits.n > 0.35);
        this.why = scared ? (f.threat ? 'Monsters. In the city. Every few days.' : 'Have you seen what happens here?') : 'Fear doesn\'t pay the rent.';
        return done(this.say('scared', w, [scared ? 'scared' : 'calm']), 'scared');
      }
      case 'ask_need': return done(this.say('need', w, f.need ? [] : ['fine']), 'need');
      case 'ask_plans': return done(this.say('plans', w, [`to_${w.next ?? 'none'}`]), 'plans');
      case 'ask_about':
        if (kinOf) return this.aboutKin('about_kin', kinOf, w, done);
        return done(this.say('about', w), 'about');
      case 'ask_opinion': return this.opinionOn(p, kinOf, thing, w, done, menu);
      case 'ask_know': return this.knowWho(p, kinOf, w, done);

      // -------------------------------------------------------------- the world
      case 'ask_news': return menu('news', 'news');
      case 'ask_where': return this.showWay(p, thing, w, E, done, menu);
      case 'ask_safe': return done(this.say('safe', w, f.hood && f.safety ? ['safety'] : []), 'safe');
      case 'ask_gang': {
        if (!f.group) return done(this.say('gang', w, w.gangNear ? ['gangnear'] : [], { other: w.gangNear ?? '' }), 'gang');
        const afraid = f.opinion < 15 || (me.traits.n > 0.6 && f.opinion < 50);
        const tells = !afraid && f.opinion >= 30 && !!w.hideout && !!f.boss;
        return done(this.say('gang', w, afraid ? ['afraid'] : tells ? ['tells'] : [], tells ? { dir: w.hideout!.dir, dist: distLabel(w.hideout!.dist) } : {}), 'gang');
      }
      case 'ask_weather': return done(this.say('weather', w, [weatherFlag(f.weather)]), 'weather');
      case 'ask_time': return done(this.say('time', w), 'time');
      case 'ask_threat': return this.threatTalk(p, w, done);
      case 'ask_place': return done(this.say('here', w), 'here');
      case 'ask_city': {
        const v = liking(me.seed, me.traits, me.years, me.interest, 'this city');
        return done(this.say('city', w, [v > 0.25 ? 'pos' : v < -0.25 ? 'neg' : 'mixed']), 'city');
      }
      case 'ask_trouble':
        if (w.favour && f.opinion >= 15) return menu('favour', 'trouble');
        return done(this.say('trouble', w, f.hood && f.safety ? ['safety'] : []), 'trouble');

      // -------------------------------------------------------------- the hero
      case 'ask_me': return menu('me', 'me');
      case 'ask_know_me': return done(this.say('know_me', w, w.heroName && f.met ? ['named'] : []), 'know_me');
      case 'ask_my_name': {
        if (w.heroName) return done(this.say('my_name', w, ['named']), 'my_name');
        this.expect = { kind: 'name' };
        return done(this.say('my_name', w, ['unnamed']), 'my_name');
      }
      case 'tell_name': return p.name ? this.tellName(p.name, w, E, done) : done(this.say('unclear', w), 'unclear');
      case 'tell_like': case 'tell_dislike': {
        if (!thing) return done(this.say('okay', w), 'okay');
        return this.tellLike(thing, intent === 'tell_like', w, E, done);
      }
      case 'tell_feel': {
        const m = /\b(tired|exhausted|sleepy|sad|down|depressed|awful|terrible|happy|great|good|fine|well|excited|bored|lost|confused|hungry|hurt|sick|ill|lonely|angry|scared)\b/.exec(p.norm.text);
        const k = m?.[1] ?? '';
        const flag = /tired|exhausted|sleepy/.test(k) ? 'f_tired' : /sad|down|depressed|awful|terrible/.test(k) ? 'f_sad' : /happy|great|good|fine|well|excited/.test(k) ? 'f_happy'
          : /bored/.test(k) ? 'f_bored' : /lost|confused/.test(k) ? 'f_lost' : /hungry/.test(k) ? 'f_hungry' : /hurt|sick|ill/.test(k) ? 'f_hurt' : /lonely/.test(k) ? 'f_lonely'
            : /angry/.test(k) ? 'f_angry' : /scared/.test(k) ? 'f_scared' : 'f_other';
        return done(this.say('tell_feel', w, [flag]), 'tell_feel');
      }
      case 'tell_hero': return done(this.say('tell_hero', w, /\bnew\b|arrived|first day/.test(p.norm.text) ? ['new'] : []), 'tell_hero');

      // -------------------------------------------------------------- asking of them
      case 'offer_help': return menu('favour', 'favour');
      case 'ask_help': return done(this.say('ask_help', w), 'ask_help');

      // -------------------------------------------------------------- the conversation
      case 'why': return done(this.why ? this.say('why', w, ['reason'], { why: this.why }) : this.say('why', w), 'why');
      case 'more':
        if (this.focus) return this.aboutKin('about_kin', this.focus, w, done);
        return menu('hobby', 'more');
      case 'really': return done(this.say('really', w), 'really');
      case 'you_too': return this.youToo(w, E, done, menu);
      case 'what_can_i_say': return done(this.say('what_can', w), 'what_can');
      case 'repeat': return done(this.lastLine || this.say('unclear', w), 'repeat');
      case 'unclear': default: {
        this.misses++;
        this.patience -= this.misses > 1 ? 1.5 : 1;
        const fb = fallback(p, w, (t, fl, tok) => this.say(t, w, fl, tok), this.u('fallback'), this.misses);
        return done(fb, 'fallback');
      }
    }
  }

  /** A line read differently in context: "and your brother?" after a question repeats it about him. */
  private reread(p: Parse, w: ChatWorld): Intent {
    const kin = p.mentions.find((m) => m.ent.kind === 'kin' || m.ent.kind === 'person');
    const follow = p.intent === 'unclear' || p.intent === 'more' || p.intent === 'you_too' || /^(and|what about|how about|and what about)\b/.test(p.norm.text);
    if (follow && kin && p.norm.words.length <= 5 && this.lastHero && ABOUT_SOMEONE.has(this.lastHero)) return this.lastHero;
    // A lone name or thing: talk about it.
    if (p.intent === 'unclear' && p.mentions.length && p.norm.words.length <= 8) {
      const k = p.mentions[0].ent.kind;
      if (k === 'thing') return this.lastHero === 'tell_like' ? 'tell_like' : 'ask_like';
      if (k === 'kin') return 'ask_about';
      if (k === 'person' || k === 'boss') return 'ask_know';
      if (k === 'place' || k === 'placeKind' || k === 'street') return 'ask_where';
      if (k === 'threat') return 'ask_threat';
      if (k === 'faction' || k === 'group') return 'ask_opinion';
      if (k === 'hood') return 'ask_place';
    }
    void w;
    return p.intent;
  }

  /** Who the line is about when it is someone close to them (by word, by name, or "he/she" for the one just talked about). */
  private subject(p: Parse, w: ChatWorld): Kin | null {
    for (const m of p.mentions) {
      if (m.ent.kind === 'kin') {
        const words = KIN_GROUPS[m.ent.data ?? ''] ?? [m.ent.data ?? ''];
        const k = w.kin.find((x) => words.includes(x.word) || (words.includes('friend') && x.bond === 'friend') || (words.includes('neighbour') && x.bond === 'neighbour') || (words.includes('colleague') && x.bond === 'colleague'));
        if (k) { this.focus = k; return k; }
        return null;
      }
      if (m.ent.kind === 'person' && m.ent.id.startsWith('kin:')) {
        const k = w.kin[Number(m.ent.id.slice(4))];
        if (k) { this.focus = k; return k; }
      }
    }
    if (this.focus && /\b(he|she|him|her|his|hers|they|them)\b/.test(p.norm.text) && !/\b(you|your)\b/.test(p.norm.text)) return this.focus;
    return null;
  }

  /** The kin word typed, when they have nobody of that kind ("your brother" with no brother). */
  private kinWord(p: Parse): string | null {
    return p.mentions.find((m) => m.ent.kind === 'kin')?.ent.data ?? null;
  }

  private noKin(p: Parse, w: ChatWorld, done: (t: string, v: string) => Reply): Reply {
    const word = this.kinWord(p) ?? 'family';
    const fl = word === 'partner' || word === 'husband' || word === 'wife' ? ['partner'] : word === 'children' || word === 'son' || word === 'daughter' ? ['children'] : [];
    this.focus = null;
    return done(this.say('no_kin', w, fl, { kword: word }), 'no_kin');
  }

  private aboutKin(topic: ChatTopic, k: Kin, w: ChatWorld, done: (t: string, v: string) => Reply, flags: string[] = []): Reply {
    const fl = ['kin', ...flags];
    if (k.who.job.kind === 'pupil') fl.push('kpupil');
    if (k.who.job.kind === 'retired') fl.push('kretired');
    return done(this.say(topic, w, fl, kinTokens(k)), topic);
  }

  /** What a "like" line is about: a found thing, else the words after the verb. */
  private thingIn(p: Parse): string | null {
    const t = p.mentions.find((m) => m.ent.kind === 'thing');
    if (t) return t.ent.label;
    return p.thing ?? null;
  }

  private askLike(thing: string | null, kin: Kin | null, p: Parse, w: ChatWorld, done: (t: string, v: string, x?: Partial<Reply>) => Reply): Reply {
    const me = w.me;
    if (!thing) {
      if (this.lastThing) thing = this.lastThing;
      else return done(this.say('like', w, ['what']), 'like');
    }
    // "Do you like it here?" "Do you like your job?"
    if (/^(it here|here|living here|this place|this street|the city|this city|the town|this town)$/.test(thing)) thing = 'this city';
    if (/^(job|work|your job|your work)$/.test(thing)) thing = 'work';
    const who = kin?.who ?? me;
    const v = liking(who.seed, who.traits, who.years, who.interest, thing);
    const band = v > 0.6 ? 'love' : v > 0.2 ? 'like' : v > -0.2 ? 'meh' : v > -0.6 ? 'dislike' : 'hate';
    const mine = who.interest.endsWith(thing);
    const fl = [band];
    if (mine) fl.push('mine');
    if (kin) fl.push('kinsubj');
    this.lastThing = thing;
    this.why = mine ? 'It\'s my passion. I could talk about it all day.' : band === 'hate' ? 'Bad memories. Don\'t ask.' : band === 'love' ? 'It just makes me happy.' : null;
    const tok = { thing, ...(kin ? kinTokens(kin) : {}) };
    // Interested people ask back.
    const back = !kin && !this.asked.has(`like:${thing}`) && this.u('askback') < 0.2 + me.traits.e * 0.35 + (me.temper === 'nosy' || me.temper === 'chatty' ? 0.2 : 0)
      ? (this.asked.add(`like:${thing}`), this.ask2({ kind: 'yesno', thing }, ['q_like'], w, { thing })) : undefined;
    void p;
    return done(this.say('like', w, fl, tok), 'like', { after: back });
  }

  private ask2(q: Expect, flags: string[], w: ChatWorld, tok: Record<string, string>): string {
    this.expect = q;
    return this.say('ask_back', w, flags, tok);
  }

  private tellLike(thing: string, likes: boolean, w: ChatWorld, E: Effects, done: (t: string, v: string) => Reply): Reply {
    const me = w.me;
    if (/^(it here|here|this city|the city|your city|this place|this town|the town)$/.test(thing)) {
      if (likes && this.count('likecity') === 1) E.opinion = 1;
      return done(this.say('tell_like', w, ['place']), 'tell_like');
    }
    const v = liking(me.seed, me.traits, me.years, me.interest, thing);
    const mine = me.interest.endsWith(thing);
    if (likes) E.heroLike = thing;
    let flag: string;
    if (likes) flag = v > 0.2 ? 'agree' : v < -0.2 ? 'differ' : 'neutral';
    else flag = v < -0.2 ? 'agree_no' : v > 0.2 ? 'differ_no' : 'neutral';
    if ((flag === 'agree' || flag === 'agree_no') && this.count(`agree:${thing}`) === 1) E.opinion = mine ? 5 : 3;
    this.lastThing = thing;
    return done(this.say('tell_like', w, mine && flag === 'agree' ? ['agree', 'mine'] : [flag], { thing }), 'tell_like');
  }

  private tellName(name: string, w: ChatWorld, E: Effects, done: (t: string, v: string) => Reply): Reply {
    const old = w.heroName;
    E.heroName = name;
    const same = !!old && old.toLowerCase() === name.toLowerCase();
    if (!old && this.count('named') === 1) E.opinion = 1;
    const w2 = { ...w, heroName: name };
    return done(this.say('tell_name', w2, same ? ['same'] : old ? ['changed'] : [], { old: old ?? '' }), 'tell_name');
  }

  private opinionOn(p: Parse, kin: Kin | null, thing: string | null, w: ChatWorld, done: (t: string, v: string) => Reply, menu: (t: Topic, v: string) => Reply): Reply {
    const f = w.facts, me = w.me;
    if (kin) return done(this.say('opinion', w, ['person', 'kin'], kinTokens(kin)), 'opinion_kin');
    const m = p.mentions[0]?.ent;
    if (m?.kind === 'faction') {
      const fac = m.id.slice('faction:'.length);
      if (fac === 'heroes' && /\b(me|you)\b/.test(p.norm.text)) return menu('me', 'me');
      const v = stance(fac, { traits: me.traits, years: me.years, opinion: f.opinion, rough: f.safety === 'rough' || f.safety === 'dangerous', groupHere: !!f.group, job: me.job.kind, interest: me.interest, seed: me.seed });
      const band = v > 0.25 ? 'pos' : v < -0.25 ? 'neg' : 'mixed';
      this.why = band === 'neg' ? (fac === 'police' ? 'They never come when you call. Then twenty come at once.' : 'I\'ve seen what they do.') : band === 'pos' ? 'Someone has to keep this city in one piece.' : null;
      return done(this.say('opinion', w, [`f_${fac}`, band], { fac: m.label }), `opinion_${fac}`);
    }
    if (m?.kind === 'group') return done(this.say('opinion', w, ['f_gangs']), 'opinion_group');
    if (m?.kind === 'boss') return done(this.say('opinion', w, ['boss'], { other: m.label }), 'opinion_boss');
    if (m?.kind === 'threat') return done(this.say('opinion', w, ['threatop'], { threat: m.label }), 'opinion_threat');
    if (m?.kind === 'person') return this.knowWho(p, null, w, done);
    if (m?.kind === 'place' || m?.kind === 'street' || m?.kind === 'hood') {
      const v = liking(me.seed, me.traits, me.years, me.interest, m.label);
      return done(this.say('opinion', w, ['placeop', v > 0.2 ? 'pos' : v < -0.2 ? 'neg' : 'mixed'], { thing: m.label }), 'opinion_place');
    }
    if (m?.kind === 'city') return this.answer({ ...p, intent: 'ask_city', mentions: [] }, w);
    if (thing) return this.askLike(thing, null, p, w, done);
    return done(this.say('unclear', w), 'unclear');
  }

  private knowWho(p: Parse, kin: Kin | null, w: ChatWorld, done: (t: string, v: string) => Reply): Reply {
    if (kin) return done(this.say('know', w, ['kin'], kinTokens(kin)), 'know_kin');
    const m = p.mentions.find((x) => x.ent.kind === 'person' || x.ent.kind === 'boss');
    if (m?.ent.kind === 'boss') return done(this.say('know', w, ['boss'], { other: m.ent.label }), 'know_boss');
    if (m?.ent.kind === 'person' && m.ent.id.startsWith('known:')) {
      const k = w.known.find((x) => `known:${x.id}` === m.ent.id);
      if (k?.word) return done(this.say('know', w, ['kin'], { kname: k.who.first, kfull: k.who.full, kword: k.word, kpro: k.who.female ? 'she' : 'he' }), 'know_known');
      return done(this.say('know', w, [this.u('famous') < 0.12 ? 'famous' : 'stranger'], { other: m.ent.label }), 'know_stranger');
    }
    const name = /\b(?:know|met|heard of|heard about|who is)\s+([a-z]+(?:\s[a-z]+)?)$/.exec(p.norm.text)?.[1];
    return done(this.say('know', w, ['stranger'], { other: name ? titleCase(name) : 'them' }), 'know_stranger');
  }

  private showWay(p: Parse, thing: string | null, w: ChatWorld, E: Effects, done: (t: string, v: string) => Reply, menu: (t: Topic, v: string, x?: Partial<Reply>) => Reply): Reply {
    const m = p.mentions.find((x) => x.ent.kind === 'place' || x.ent.kind === 'placeKind' || x.ent.kind === 'street' || x.ent.kind === 'hood');
    const to = m ? w.way(m.ent) : null;
    if (!to) {
      const kind = m?.ent.kind === 'placeKind' ? m.ent.data ?? '' : '';
      const label = m?.ent.label ?? thing ?? p.norm.text.replace(/^(where is|where are|where can i find|how do i get to|how can i get to|which way is|which way to|show me the way to|take me to|directions to|the way to|way to|i am looking for)\s+/, '');
      return done(this.say('where_none', w, kind ? [kind] : [], { thing: label }), 'where_none');
    }
    E.waypoint = to;
    return menu('way', 'way', { extra: { place: to.label } });
  }

  private threatTalk(p: Parse, w: ChatWorld, done: (t: string, v: string) => Reply): Reply {
    const m = p.mentions.find((x) => x.ent.kind === 'threat');
    const kind = m?.ent.data ?? null;
    const t = kind ? w.threats.find((x) => x.kind === kind) : w.threats[0];
    if (!t) return done(this.say('threat', w, [kind ? 'never' : 'none'], { threat: m?.ent.label ?? 'that' }), 'threat');
    const tok = { threat: t.label, ago: agoWords(t.ago), where: t.street ?? '' };
    if (t.active) return done(this.say('threat', w, ['now'], tok), 'threat');
    this.why = 'Because it was the size of a building!';
    return done(this.say('threat', w, ['seen', ...(t.street ? ['where'] : []), ...(t.beaten ? ['beaten'] : [])], tok), 'threat');
  }

  /** "And you?": the last thing the hero told or asked, asked back of them. */
  private youToo(w: ChatWorld, E: Effects, done: (t: string, v: string, x?: Partial<Reply>) => Reply, menu: (t: Topic, v: string) => Reply): Reply {
    const last = this.lastHero;
    const thing = this.lastThing;
    if ((last === 'tell_like' || last === 'tell_dislike' || last === 'ask_like') && thing) return this.askLike(thing, null, { intent: 'ask_like', score: 1, via: 'pattern', norm: { raw: '', text: '', words: [], question: true, exclaim: false }, mentions: [] }, w, done);
    if (last === 'tell_name') return done(this.say('name', w), 'name');
    if (last === 'tell_feel' || last === 'how_are_you' || last === 'greet') return menu('mood', 'mood');
    if (last === 'tell_hero') return menu('job', 'job');
    void E;
    return menu('mood', 'mood');
  }

  /** After a plain "okay": someone talkative fills the silence (a question, or their hobby). */
  private initiative(w: ChatWorld, E: Effects, done: (t: string, v: string, x?: Partial<Reply>) => Reply): Reply | null {
    const me = w.me;
    if (this.u('init') > 0.25 + me.traits.e * 0.5) return null;
    if (!w.heroName && !this.asked.has('name') && w.facts.met === 0) { this.asked.add('name'); return done(this.ask2({ kind: 'name' }, ['q_name'], w, {}), 'ask_name_back'); }
    const it = me.interest.replace(/^their /, '');
    if (!this.asked.has('interest')) { this.asked.add('interest'); return done(this.ask2({ kind: 'yesno', thing: it }, ['q_interest'], w, { thing: it }), 'ask_interest'); }
    void E;
    return null;
  }

  /** Now and then, a question back about their hobby after talking about it. */
  private maybeAskInterest(w: ChatWorld, chance: number): string | undefined {
    if (this.asked.has('interest') || this.u('askint') > chance * (0.5 + w.me.traits.e)) return undefined;
    this.asked.add('interest');
    const it = w.me.interest.replace(/^their /, '');
    return this.ask2({ kind: 'yesno', thing: it }, ['q_interest'], w, { thing: it });
  }

  /** The menu answered (People asks the menu backend); remember the topic for "and you?" and "why?". */
  menuAnswered(topic: Topic): void {
    if (topic === 'hobby') this.lastThing = null;
  }
}

/** Kin words that name a group ("your family", "your friends"): no one missing to say so about. */
const GROUP_WORDS = new Set(['family', 'friend', 'neighbour', 'colleague', 'parents', 'siblings', 'children', 'grandchildren']);

const ABOUT_SOMEONE = new Set<Intent>(['ask_name', 'ask_age', 'ask_job', 'ask_work_where', 'ask_home', 'ask_hobby', 'ask_like', 'ask_about', 'ask_opinion', 'ask_know']);

/** Kin words a typed word covers ("parents": mother and father). */
const KIN_GROUPS: Record<string, readonly string[]> = {
  parents: ['mother', 'father'], siblings: ['brother', 'sister'], children: ['son', 'daughter'], grandchildren: ['grandson', 'granddaughter'],
  partner: ['wife', 'husband'], family: ['mother', 'father', 'brother', 'sister', 'son', 'daughter', 'wife', 'husband', 'grandmother', 'grandfather', 'grandson', 'granddaughter'],
  friend: ['friend'], neighbour: ['neighbour'], colleague: ['colleague'],
};

export function kinTokens(k: Kin): Record<string, string> {
  const w = k.who;
  return {
    kname: w.first, kfull: w.full, kword: k.word, kjob: w.job.title, kajob: w.job.kind === 'retired' ? 'retired' : withArticle(w.job.title), kint: w.interest.replace(/^their /, w.female ? 'her ' : 'his '),
    kage: String(w.years), kage1: String(w.years + 1), khome: w.home ?? 'the other side of town', kwork: w.work ?? 'across town',
    kpro: w.female ? 'she' : 'he', kpos: w.female ? 'her' : 'his',
  };
}

/** "my brother Tomas, my mother Vera and my friend Ali" */
export function listOf(ks: readonly Kin[]): string {
  const parts = ks.slice(0, 4).map((k) => `my ${k.word} ${k.who.first}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? '';
}

function categoryIn(text: string): Category | null {
  for (const c in CATEGORY_WORDS) for (const w of CATEGORY_WORDS[c as Category]) if (new RegExp(`\\b${w}\\b`).test(text)) return c as Category;
  for (const c in THINGS) for (const t of THINGS[c as Category]) if (new RegExp(`\\b${t}\\b`).test(text)) return c as Category;
  return null;
}

function weatherFlag(kind: string): string {
  return kind === 'clear' || kind === 'fair' ? 'w_clear' : kind === 'fog' ? 'w_fog' : kind === 'cloudy' || kind === 'overcast' ? 'w_cloudy' : 'w_wet';
}

const HOUR_WORDS = ['twelve', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven'];

/** "half past three", "quarter to five", "ten past eight in the evening". */
export function clockWords(hour: number): string {
  const h0 = ((hour % 24) + 24) % 24;
  let h = Math.floor(h0), m = Math.round((h0 - h) * 12) * 5;
  if (m === 60) { m = 0; h = (h + 1) % 24; }
  const name = (x: number) => HOUR_WORDS[x % 12];
  const part = h < 5 ? ' at night' : h < 12 ? ' in the morning' : h < 18 ? ' in the afternoon' : h < 22 ? ' in the evening' : ' at night';
  if (m === 0) return h === 12 ? 'noon' : h === 0 ? 'midnight' : `${name(h)} o'clock${part}`;
  if (m === 30) return `half past ${name(h)}`;
  if (m === 15) return `quarter past ${name(h)}`;
  if (m === 45) return `quarter to ${name(h + 1)}`;
  if (m < 30) return `${m} past ${name(h)}`;
  return `${60 - m} to ${name(h + 1)}`;
}

/** "just now", "earlier today", "yesterday", "3 days ago". */
export function agoWords(hours: number): string {
  if (hours < 0.5) return 'just now';
  if (hours < 3) return 'a couple of hours ago';
  if (hours < 20) return 'earlier today';
  if (hours < 44) return 'yesterday';
  return `${Math.round(hours / 24)} days ago`;
}

function titleCase(s: string): string {
  return s.split(/\s+/).filter(Boolean).slice(0, 3).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

/** Chat tokens after the menu's own (a capital first letter capitalises the value). */
export function fillTokens(s: string, v: Record<string, string>): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => {
    const val = v[k.toLowerCase()];
    if (val === undefined) return m;
    return k[0] === k[0].toUpperCase() ? val.charAt(0).toUpperCase() + val.slice(1) : val;
  });
}
