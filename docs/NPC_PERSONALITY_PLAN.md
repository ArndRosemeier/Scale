# People with personalities — plan

Status: **proposal** (Arnd, 2026-10-05: "give NPCs personalities with varied behaviour; every NPC has a name and a
conversation menu; optional LLM support via OpenRouter later, but the core works without it; NPCs remember the player;
people you have met get a faint dot on the map that persists, a small number of them").
Status (2026-10-05): Phase 1 is being built (names, personalities, the talk menu, memory, map dots, saves).
Status (2026-10-07): Phase 1 merged (v0.051, v0.056, v0.073). Phase 2 built (behaviour from personality). Phase 3
(OpenRouter) waits. Phase 4 built (social web, needs, favours: §3.6).

This amends PLAYGROUND_PLAN §0 decision 15 ("no chat, no quests"): talking to people is now allowed, **on the
player's initiative only** (nobody stops the hero to talk, there is still no quest log), and barks stay sparse.

## 1. What the player gets

- **Everybody has a name.** The target frame shows "Mara Okonkwo · shop assistant" instead of "Woman". Names fit the
  person's age and gender and are the same every time you meet them (they come from the person's seed).
- **People differ.** A cheerful pensioner greets you, a nervous office worker hurries off when something bangs, a
  grumpy cook complains about the giant who broke his street. Personality shows in pace, in what makes someone stop and
  look or run, in their small talk and in how they answer you.
- **E talks** to the person in front of you (on foot, normal size, nobody down to help up, no crime to deal with). A
  small panel opens with their name, what they do and their mood, and a few things to say:
  - *Hello* (they introduce themselves, or greet you again),
  - *How are you?* (mood: the day, the weather, what just happened on their street),
  - *What do you do?* (job, and the thing they care about: football, birds, their grandchildren, conspiracy theories),
  - *What's going on around here?* (local news from the real game state: the group that runs the street, its boss, a
    recent monster, the aftermath, the weather),
  - *Can you show me the way to …?* (the hospital, the metro, a landmark: puts your marker on the map),
  - *What do you think of me?* (their opinion: your reputation plus what you did to *them*),
  - *Goodbye*.
  Keys 1–7 or a click; Esc or E closes. The world keeps running; the person stops and faces you while you talk.
- **They remember you.** Talk to someone, help them up, save them from a mugger: they keep a little record of you
  (when you met, how often, what you did, what you talked about, how they feel about you). Meet them again days later
  and they greet you by what happened ("You're the one who helped me up on Linden Street!"). Knock someone down you know
  and they hold it against you.
- **Faint dots on the map** for the people you have met: where they are right now (home, at work, out for lunch: their
  real day plan, computed even when they are far away). Hover for the name and what you know. A small number only
  (24): when a new acquaintance would be one too many, the one you care least about is forgotten (least met, longest
  ago, no strong feelings).
- **Kept in saves** (and per city in the browser, like reputation).

## 2. Research: how games give NPCs personality

What other games and research do, and what we take from each:

| Source | Idea | What we take |
|---|---|---|
| **Big Five / OCEAN** (psychology; used by many sims) | Five independent traits: openness, conscientiousness, extraversion, agreeableness, neuroticism | The trait model. Five numbers per person are cheap, combine well and are easy to map to behaviour and lines. Our citizens already have `nerve` (≈ neuroticism) and `curiosity` (≈ openness), so existing behaviour stays as it is |
| **The Sims** (needs/motives, utility AI) | Needs decay, actions are scored by how much they satisfy needs × personality | Later (phase 4): small needs (hunger, social, rest) to pick between errands and street activities; not needed for talking |
| **Dwarf Fortress** (facets, values, memories) | ~50 facets, values, and memories with emotions that fade and can become long-term | Memories that fade unless strong, and opinions built from them. Our memory record is the small version of this |
| **RimWorld** (traits, opinion) | A few discrete traits on top of numbers; opinion = sum of remembered interactions | A short "temperament" label from the traits (cheerful, grumpy, shy, chatty, anxious, nosy, proud, kind) for writing, and opinion = reputation + personal history |
| **Shadow of Mordor — Nemesis** | Enemies remember encounters and call back to them | The callbacks: people greet you by what happened last time ("You again. Mind your feet this time.") |
| **Oblivion / Skyrim — Radiant AI** | Schedules, disposition toward the player | We already have deterministic day plans (`Population.dayPlan`); disposition = our opinion |
| **Valve — dynamic dialog by fuzzy rule matching** (Elan Ruskin, GDC 2012, Left 4 Dead 2) | Each line has criteria over facts (who, mood, map, what happened); the query picks the line whose criteria match best (most criteria wins), with memory of what was said | **The core of the non-LLM talk system.** Every topic is a small database of lines with criteria (traits, mood, opinion, met before, time of day, weather, district, recent events); the most specific match wins, ties picked by seed; lines remember they were used so the same person does not repeat themselves |
| **Versu / Prom Week (Comme il Faut)** | Social practices and social "physics" between characters | Later (phase 4): relationships between NPCs (friends greet each other, a neighbour mentions another person you know) |
| **Generative Agents** (Park et al., Stanford 2023) | Memory stream; retrieval by recency × importance × relevance; reflections summarise memories | The memory record is shaped so an LLM can use it: short dated entries with an importance, a running summary per person. Retrieval is trivial for us (one person, few entries) |
| **LLM NPCs in games** (Inworld, Convai, mods for Skyrim and Mount & Blade) | A character card + memory + world facts as the prompt; guard rails; latency | The OpenRouter hook (phase 3): the same facts the rules use become the prompt, the rules stay the fallback and the guard rail |

Takeaways for Scale:
1. **Personality is data, behaviour reads it.** Five traits plus a temperament label, all derived from the citizen's
   seed (no storage for the millions of people we never meet).
2. **Rules first, LLM optional.** The rule database gives instant, free, deterministic answers that already know the
   game world. An LLM can rephrase or answer free text, fed with the same facts, and falls back to the rules on any
   error or timeout.
3. **Memory is small and only for people you met.** Everybody else is a pure function of the seed. Only acquaintances
   cost storage (a few hundred bytes each, 24 of them).

## 3. Systems

### 3.1 Identity (`src/game/people/identity.ts`, pure)
- `nameOf(cit)`: first name by gender and birth cohort (age), last name; pools wide and international, as the city's
  street and boss names are. Same seed → same name.
- `traitsOf(cit)`: O, C, E, A, N in 0..1. N = `cit.nerve`, O = `cit.curiosity` (so existing reactions keep working),
  the other three from the seed.
- `temperamentOf(traits)`: one label from the strongest trait combination (cheerful, chatty, shy, grumpy, anxious,
  nosy, proud, kind, dreamy, steady).
- `occupationOf(cit, workUse)`: pupil, student, retired, at home, or a job by the workplace's use (office, shop,
  factory, civic, café/restaurant, …).
- `interestOf(cit)`: one thing they love to talk about.
- `moodOf(cit, day, ctx)`: the day's base mood (seed + day) moved by the weather, the hour and what happened nearby.

### 3.2 Talk (`src/game/people/talk.ts` + `lines.ts`, pure)
- `TalkFacts`: everything a line can depend on (traits, temperament, mood, occupation, interest, opinion, times met,
  last deed, hour, weather, district, local group and boss, last threat, hero's size and reputation).
- `LINES`: per topic, entries `{ when: Criteria, say: string[] }` with `{name}`, `{street}`, `{group}`, `{boss}`,
  `{interest}`, `{job}` … tokens. `pickLine(topic, facts, rng, used)` scores entries by matched criteria (each criterion
  must hold; more criteria = more specific = preferred), picks among the best with the person's seed, avoids lines
  this person already said.
- `TalkBackend` interface: `answer(topic, facts, person, freeText?) → Promise<string | null>`; `RuleBackend` is the
  default. Phase 3 adds `OpenRouterBackend`.

### 3.3 Memory (`src/game/people/People.ts`)
- `Known` per citizen id: name, seed, home and work place refs (to find them again), first and last met (game hours),
  times met, opinion (−100..100), deeds (`helped`, `saved`, `hurt`, `talked`), topics heard, a short log of dated notes
  (for the LLM), last seen spot.
- `note(agent, kind)`: talking, helping them up (`Deeds.help`), knocking them down (only remembered for people already
  known: a giant crushing a crowd does not make 40 acquaintances), saving them from a crime (phase 2).
- Opinion = what they did to you personally + your reputation weighted by agreeableness.
- Cap 24, evicting the lowest `keep score` (times met, |opinion|, recency).
- Saved per city in localStorage (like reputation) and in the save game (`SaveData.people`, optional field).

### 3.4 Map dots
- A `faint` marker kind: a small, half-transparent dot (not on the compass).
- Where each known person is now: the live agent if they are near, else `Population.stateAt` → the building door when
  the cell is loaded, else the cell's centre (walking between two places: in between). Updated every few seconds.

### 3.5 Behaviour from personality (phase 2)
- Pace (E, C), stopping to gawk or film (O), fleeing and how far (N), helping others up or pointing out a thief (A),
  greeting the hero (E × opinion), keeping distance from a hero who hurt them (opinion), small talk barks per
  temperament, known people greeting you when you pass.
- Built (`behaviour.ts` rules, `Manners.ts` glue, actors of `PEOPLE_OWNER`):
  - pace 0.8–1.22 × the usual by E and C (the crowd's average unchanged); a scare wears off 3× faster for the
    calmest than the most nervous, so the nervous run further; the curious stand and look 3–12 s;
  - opinion ≤ −30: they step aside as you come near, walk on instead of standing by you, now and then say so;
    opinion ≤ −65: they won't talk to you (E gets a refusal);
  - kind grown-ups (A ≥ 0.66, not frightened) walk over and help up someone lying within 22 m, once it is calm
    (9 s; an everyday fall, the hero's good deed, only after 40 s);
  - agreeable people point after a criminal running past;
  - people who know and like you stop and wave when they greet you; people you saved greet you as their hero;
  - victims of a crime you stop (and people whose stolen things you bring back) remember being saved;
  - what people shout when they run, gawk, film, get up or thank you is in their temperament.

### 3.6 The social web, needs and favours (phase 4, `social.ts`, pure)
- **Bonds** from the seeds, never stored: same home → family (30 %) or neighbours; same block → neighbours who
  know each other (12 %); same workplace → colleagues; any two of about the same age (≤ 18 years apart, both
  children or both grown-ups) → friends (0.6 %). Family words by age and gender (mother, son, sister, husband …).
- **Street chats** (Manners): two people with a bond who pass within 3.5 m near the hero stop and talk 5–16 s (by
  extraversion; family always stop, others now and then only nod), taking turns with the talking gesture, at most two
  pairs at once, the same pair once per 15 minutes.
- **Hearsay**: what you did to someone you know reaches the people bonded to them (family ½, friends 0.4, neighbours
  and colleagues ¼ of the deed's weight, at most ±35 opinion); hello and "what do you think of me" lines say who told them.
- **Needs**: hunger since the last meal (breakfast after waking, lunch 12–13:30, dinner 18:30–20), tiredness from
  waking to bed, loneliness after hours at home (extraverts sooner). Pressing needs lower the mood a little, show in
  "How are you?" and send a passer-by now and then to stop for a bite or a coffee.
- **Favours**: "Can I do anything for you?" Someone who has met you twice and likes you (opinion ≥ 15) asks, on some
  days: look in on a friend or relative (a citizen made from their seed; gold dot on the map; they come out of their
  door as you get near; talking to them does it) or clear the trouble on their street (stop a crime within 300 m).
  Two game days; done: +15 opinion and thanks, let down: −8 and a remark. Kept on the asker's record (saved).

## 4. LLM hook (phase 3, optional)
- Settings: an OpenRouter API key (stored only in this browser) and a model id; off by default. The game never sends
  anything without a key.
- `OpenRouterBackend` calls `POST https://openrouter.ai/api/v1/chat/completions` (OpenAI-compatible, streaming) with
  a system prompt built from `TalkFacts` (who they are, how they talk, what they know and remember, the world rules:
  near-future city, a super-hero in front of you, no quests, short answers), the person's memory notes, and the topic or
  the player's free text.
- A free-text box appears in the talk panel when the LLM is on. Answers stream into the bubble; on an error, a timeout
  (4 s to the first token) or an empty answer the rule line is shown instead.
- After a conversation the LLM writes a one-line summary into the person's memory notes (bounded), so the next
  conversation remembers what was said.
- Cost guard: one request per player message, max tokens small, a daily request counter shown in the settings.

## 5. Phases
1. **Identity, talk menu, memory, map dots, saves** (rule lines only). *Building now.*
2. **Behaviour from personality**: pace, gawk/flee thresholds, temperament barks, known people greeting you, saving a
   victim remembered, people who dislike you keeping away.
3. **OpenRouter**: settings, backend, free text, memory summaries.
4. **Social web and needs**: NPC relationships (friends, neighbours, colleagues met together), small needs driving
   errands, favours people ask of you (no quest log: a request is remembered by them, not by a journal). *Built.*

## 6. Open questions (defaults taken)
1. Names always visible on the target frame, or only once they told you? Default: **always** (Arnd: "all NPCs have a
   name").
2. Number of remembered people: **24**.
3. Talking pauses the game? Default: **no** (like the map), the person waits.
