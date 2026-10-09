/**
 * Typed NPC chat (src/game/people/chat): the self test's checks, and a demo.
 *
 *   npx tsx tools/chatTest.ts demo     a few conversations with different people, printed
 *   npx tsx tools/chatTest.ts misses   the held-out lines the chat gets wrong (corpus.ts)
 *
 * Checks: the word-piece tokenizer matches the model's reference ids; the held-out lines
 * (corpus.ts) are understood well enough with the sentence model and without it; every intent
 * gets an answer for all kinds of people in all kinds of situations, with every token filled in.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';
import { Terrain } from '../src/world/terrain';
import { makeProfile } from '../src/world/settings';
import { buildMacroPlan } from '../src/plan/macro';
import { Population, Role, type Citizen } from '../src/sim/Population';
import { Rng } from '../src/core/rng';
import { nameOf, traitsOf, temperamentOf, jobOf, interestOf, yearsOf, isFemale, moodOf, moodWord } from '../src/game/people/identity';
import type { TalkFacts } from '../src/game/people/talk';
import { ruleAnswer } from '../src/game/people/talk';
import { WordPiece } from '../src/game/people/chat/wordpiece';
import { SentenceModel } from '../src/game/people/chat/embedCore';
import { Understander, type Parse } from '../src/game/people/chat/understand';
import { normalise } from '../src/game/people/chat/normalise';
import { INTENTS, type Intent } from '../src/game/people/chat/intents';
import { CORPUS } from '../src/game/people/chat/corpus';
import { Conversation, type ChatWorld, type Kin, type Who } from '../src/game/people/chat/respond';
import { FACTIONS, THREATS, PLACE_KINDS, KIN_WORDS, findMentions, type Ent } from '../src/game/people/chat/lexicon';
import { THINGS, type Category } from '../src/game/people/chat/prefs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = join(ROOT, 'public/models/minilm');

type Check = (ok: boolean, msg: string) => void;

function who(c: Citizen, last?: string): Who {
  const t = traitsOf(c), n = nameOf(c), y = yearsOf(c);
  return {
    first: n.first, last: last ?? n.last, full: `${n.first} ${last ?? n.last}`, years: y, female: isFemale(c), child: c.role === Role.Child || y < 15, senior: y >= 66,
    traits: t, temper: temperamentOf(t), job: jobOf(c, 'downtown'), interest: interestOf(c), seed: c.seed, home: 'Ashgrove Lane', work: c.work ? 'Mill Street' : null,
  };
}

/** Fixed names for the tests (what Chat builds from the city). */
function lexicon(kin: readonly Kin[]): Ent[] {
  const out: Ent[] = [...FACTIONS, ...THREATS, ...PLACE_KINDS];
  for (const w in KIN_WORDS) out.push({ kind: 'kin', id: `kinword:${w}`, label: w, data: w, names: KIN_WORDS[w].flatMap((x) => [`your ${x}`, x]) });
  kin.forEach((k, i) => out.push({ kind: 'person', id: `kin:${i}`, label: k.who.first, names: [k.who.first, k.who.full] }));
  out.push({ kind: 'person', id: 'known:1', label: 'Tomas Novak', names: ['tomas novak', 'tomas'] }, { kind: 'person', id: 'known:2', label: 'Mara Okonkwo', names: ['mara okonkwo', 'mara'] });
  out.push({ kind: 'boss', id: 'boss:0', label: 'Viktor Hale', names: ['viktor hale', 'viktor', 'hale'] }, { kind: 'group', id: 'group:0', label: 'the Rust Saints', names: ['rust saints'] });
  for (const [i, n] of ['St. Aldric Cathedral', 'City Museum', 'Harbour Stadium', 'Town Hall'].entries()) out.push({ kind: 'place', id: `place:${i}`, label: n, names: [n, n.split(' ').pop()!.toLowerCase()], x: i * 300, z: 200 });
  out.push({ kind: 'street', id: 'street:Linden Street', label: 'Linden Street', names: ['Linden Street'], x: 50, z: 50 });
  const things = new Set<string>();
  for (const c in THINGS) for (const t of THINGS[c as Category]) things.add(t);
  for (const t of things) out.push({ kind: 'thing', id: `thing:${t}`, label: t, names: [t] });
  return out;
}

/** Someone's circle as Chat makes it (a smaller version: family by word, a friend). */
function circle(pop: Population, c: Citizen, r: Rng): Kin[] {
  const me = who(c);
  const out: Kin[] = [];
  const add = (word: string, bond: Kin['bond'], years: number, female: boolean, withMe: boolean) => {
    const b = pop.synthetic(r.nextU32() | 1);
    out.push({ word, bond, withMe, who: who({ ...b, age: years / 100, gender: female ? 0.25 : 0.75, role: years < 16 ? Role.Child : Role.Adult }, bond === 'family' ? me.last : undefined) });
  };
  if (r.chance(0.6)) add(me.female ? 'husband' : 'wife', 'family', me.years, !me.female, true);
  if (r.chance(0.5)) add('brother', 'family', me.years + 3, false, false);
  if (r.chance(0.4)) add('daughter', 'family', Math.max(2, me.years - 28), true, true);
  if (r.chance(0.7)) add('friend', 'friend', me.years, r.chance(0.5), false);
  return out;
}

interface Person { c: Citizen; facts: TalkFacts; world: ChatWorld; ents: Ent[] }

function people(n: number, seed: number): Person[] {
  const terrain = new Terrain(makeProfile({ seed: 7, size: 0.2 }));
  const macro = buildMacroPlan(terrain);
  const pop = new Population(macro, 7);
  const r = new Rng(seed);
  const out: Person[] = [];
  for (let i = 0; i < n; i++) {
    const c0 = pop.synthetic(5000 + i * 7919);
    const c = i % 2 && c0.role !== Role.Child ? { ...c0, role: Role.Worker, work: { ...c0.home, kind: 'work' as const } } : c0;
    const me = who(c), traits = me.traits;
    const trouble = r.chance(0.2) ? r.float() : 0, opinion = r.range(-100, 100), weather = r.pick(['clear', 'fair', 'rain', 'storm', 'fog', 'cloudy']);
    const hour = r.range(0, 24), mood = moodOf(c, traits, { day: 2, hour, weather, trouble, opinion }), met = r.chance(0.5) ? r.int(1, 4) : 0;
    const group = r.chance(0.4) ? 'the Rust Saints' : null;
    const facts: TalkFacts = {
      first: me.first, last: me.last, full: me.full, years: me.years, child: me.child, senior: me.senior, traits, temper: me.temper, job: me.job, interest: me.interest,
      mood, moodWord: moodWord(mood, trouble), met, deed: met ? r.pick([null, 'helped', 'saved', 'hurt'] as const) : null, days: met ? r.range(0, 6) : 0, opinion, hour, weather, trouble,
      threat: r.chance(0.2), street: r.chance(0.8) ? 'Linden Street' : null, metStreet: r.chance(0.5) ? 'Oak Avenue' : null, city: 'Port Ashford',
      group, boss: group && r.chance(0.7) ? 'Viktor Hale' : null, giant: false, heard: r.chance(0.4) ? 'there was a mugging in Ashville this morning.' : null,
      hood: r.chance(0.8) ? 'Ashville' : null, safety: r.pick(['safe', 'quiet', 'mixed', 'rough', 'dangerous'] as const), need: r.pick([null, null, 'hunger', 'tired', 'lonely'] as const),
      favour: 'none', nannies: null,
    };
    const kin = circle(pop, c, r);
    const world: ChatWorld = {
      facts, me, kin, known: [], next: r.pick([null, 'home', 'work', 'shop', 'food', 'park', 'leisure']),
      way: (e) => (e.x !== undefined ? { label: e.label, x: e.x, z: e.z ?? 0 } : e.data === 'station' ? { label: 'Linden Square station', x: 100, z: 100 } : null),
      threats: r.chance(0.5) ? [{ kind: 'burrower', label: 'the giant worm', ago: r.range(0, 60), street: r.chance(0.5) ? 'Mill Street' : null, active: r.chance(0.1), beaten: r.chance(0.5) }] : [],
      gangNear: r.chance(0.3) ? 'the Iron Wolves' : null, hideout: group && r.chance(0.6) ? { dir: 'north-east', dist: 640 } : null,
      heroName: r.chance(0.3) ? 'Nova' : null, heroLikes: [], favour: r.chance(0.5),
    };
    out.push({ c, facts, world, ents: lexicon(kin) });
  }
  return out;
}

async function model(): Promise<SentenceModel> {
  ort.env.wasm.numThreads = 1;
  return SentenceModel.create(ort, readFileSync(join(MODEL, 'model_q8.onnx')), readFileSync(join(MODEL, 'vocab.txt'), 'utf8'));
}

/** Words of every line (for the demo and the checks): a menu topic shows as the topic. */
function show(conv: Conversation, p: Parse, w: ChatWorld): string {
  const r = conv.reply(p, w);
  const menu = r.topic ? ruleAnswer({ topic: r.topic, facts: { ...w.facts, place: 'Linden Square station', dir: 'north', dist: 400, ...(r.extra ?? {}) }, seed: 7, used: new Set() }).text : '';
  return [menu, r.text, r.after].filter(Boolean).join(' ');
}

export async function chatChecks(check: Check): Promise<void> {
  // The tokenizer gives the reference tokenizer's ids (sentence-transformers/all-MiniLM-L6-v2).
  const wp = new WordPiece(readFileSync(join(MODEL, 'vocab.txt'), 'utf8'));
  const ref: [string, number[]][] = [
    ['Where do you live?', [101, 2073, 2079, 2017, 2444, 1029, 102]],
    ['where\'s ur place??', [101, 2073, 1005, 1055, 24471, 2173, 1029, 1029, 102]],
    ['I don\'t know, Mr. O\'Brien — café naïve résumé', [101, 1045, 2123, 1005, 1056, 2113, 1010, 2720, 1012, 1051, 1005, 9848, 1517, 7668, 15743, 13746, 102]],
  ];
  for (const [s, ids] of ref) check(JSON.stringify(wp.encode(s)) === JSON.stringify(ids), `chat: word pieces of "${s}" match the model's tokenizer`);

  // Held-out lines are understood (with the model, and without it while it loads).
  const ps = people(1, 3);
  const ents = ps[0].ents;
  const m = await model();
  const withModel = new Understander({ embed: (t) => m.embed(t) });
  check(await withModel.prepare(), 'chat: the sentence model loads and embeds the examples');
  const words = new Understander(null);
  // (Lines that normalise to an example, "whats ur name" = "what is your name", are counted apart: the
  // strictly new ones are the honest measure.)
  const isEx = (s: string) => INTENTS.some((d) => d.ex.some((e) => normalise(e).text === normalise(s).text));
  let okM = 0, okW = 0, newN = 0, newM = 0;
  for (const [s, want] of CORPUS) {
    const hit = (await withModel.parse(s, ents)).intent === want;
    if (hit) okM++;
    if (!isEx(s)) { newN++; if (hit) newM++; }
    if ((await words.parse(s, ents)).intent === want) okW++;
  }
  const n = CORPUS.length;
  check(okM / n >= 0.94, `chat: typed lines understood with the sentence model (${okM}/${n} = ${(okM / n * 100).toFixed(1)} %, want ≥ 94 %)`);
  check(newM / newN >= 0.9, `chat: lines unlike any example understood with the sentence model (${newM}/${newN} = ${(newM / newN * 100).toFixed(1)} %, want ≥ 90 %)`);
  check(okW / n >= 0.72, `chat: typed lines understood by patterns and words alone (${okW}/${n} = ${(okW / n * 100).toFixed(1)} %, want ≥ 72 %)`);

  // Names: typos forgiven in longer names, common words that are names only when capitalised.
  const nm = (s: string) => findMentions(normalise(s).words, s, ents).map((x) => x.ent.id);
  check(nm('where is the cathedrall').includes('place:0'), 'chat: a typo in a longer name is forgiven');
  check(nm('do you like jazz').includes('thing:jazz') && nm('tell me about your brother').includes('kinword:brother'), 'chat: things and relatives are found');

  // Every intent answers everybody, in every situation, with every token filled in.
  let raw = 0, empty = 0, total = 0;
  const bad: string[] = [];
  for (const p of people(160, 11)) {
    const conv = new Conversation(p.c.seed, p.world.me.traits, false);
    for (const d of INTENTS) {
      const line = d.ex[(p.c.seed >>> 3) % d.ex.length];
      const norm = normalise(line);
      const parse: Parse = { intent: d.id, score: 1, via: 'pattern', norm, mentions: findMentions(norm.words, line, p.ents), thing: undefined };
      parse.thing = (await words.parse(line, p.ents)).thing;
      const out = show(conv, parse, p.world);
      total++;
      if (!out.trim() || out.trim() === '…') { empty++; if (bad.length < 8) bad.push(`${d.id}: "${line}" → (nothing)`); }
      if (/[{}]|undefined|null|NaN/.test(out)) { raw++; if (bad.length < 8) bad.push(`${d.id}: "${line}" → ${out}`); }
      conv.patience = 9;
    }
  }
  check(empty === 0, `chat: every intent gets an answer (${empty} of ${total} empty) ${bad.join(' | ')}`);
  check(raw === 0, `chat: no answer shows a raw token (${raw} of ${total}) ${bad.join(' | ')}`);

  // Words have weight: an insult costs opinion, a threat ends the talk and costs reputation, a name is remembered.
  const p = people(1, 5)[0];
  const conv = new Conversation(p.c.seed, p.world.me.traits, false);
  const say = async (s: string) => conv.reply(await words.parse(s, p.ents), p.world);
  check(((await say('you are an idiot')).effects.opinion ?? 0) < 0, 'chat: an insult lowers their opinion');
  const named = await say('my name is Nova');
  check(named.effects.heroName === 'Nova', 'chat: "my name is Nova" is remembered');
  const thr = await say('I will crush you');
  check(!!thr.effects.end && (thr.effects.rep ?? 0) < 0, 'chat: a threat ends the talk and costs reputation');
}

// ------------------------------------------------------------------ run by hand
const mode = process.argv[2];
if (mode === 'demo' || mode === 'misses') {
  const ps = people(6, 21);
  const m = await model();
  const u = new Understander({ embed: (t) => m.embed(t) });
  await u.prepare();
  if (mode === 'misses') {
    for (const [s, want] of CORPUS) {
      const p = await u.parse(s, ps[0].ents);
      if (p.intent !== want) console.log(`${s.padEnd(44)} want ${want.padEnd(15)} got ${p.intent.padEnd(15)} ${p.via} ${p.score.toFixed(2)}`);
    }
  } else {
    const lines = ['hi!', 'whats ur name', 'how are you?', 'where do you live', 'tell me about your family', 'what does your wife do?', 'and your brother?', 'do you like jazz?', 'yes', 'what is your favourite food', 'what do you think about the police', 'why?', 'is it safe here', 'who runs this street', 'did you see the giant worm?', 'my name is Nova', 'I love chess', 'what do you think of me', 'I think the canal is haunted', 'you are cute', 'where is the cathedral', 'bye'];
    for (const p of ps.slice(0, 4)) {
      const me = p.world.me;
      console.log(`\n=== ${me.full}, ${me.years}, ${me.job.title}, ${me.temper}; loves ${me.interest}; circle: ${p.world.kin.map((k) => `${k.word} ${k.who.first}`).join(', ') || 'nobody'}`);
      const conv = new Conversation(p.c.seed, me.traits, false);
      for (const l of lines) {
        const parse = await u.parse(l, p.ents);
        console.log(`  You: ${l}\n    [${parse.intent} ${parse.via} ${parse.score.toFixed(2)}] ${show(conv, parse, p.world)}`);
        conv.patience = 9;
      }
    }
  }
}
