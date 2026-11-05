# Game master and the hero's tracker — plan (for approval)

Status: **proposal** (2026-11-05, Arnd, thread "Explore supervillain ideas"). Nothing built yet.

Scale already simulates a lot that the player hardly sees: six kinds of villain groups with turf, hideouts,
lieutenants, named bosses with a record, notoriety, turf wars, truces and boss operations (VILLAINS_PLAN), the threat
clock with its omens and the big threats (THREATS_PLAN), the city pulse (crime index, off-screen crime, news), NPC
needs and favours (NPC_PERSONALITY_PLAN §3.6) and the sidekick. Most of it happens out of sight or looks like
random noise: the player sees a mugging, not the Syndicate behind it.

Two parts make it visible, **without being too on the nose** (Arnd):

1. **The game master (GM)**, after MasterWorld's virtual game master (MasterWorld `docs/design/vgm.md`). It decides
   *what of the city's life reaches the player, when and how*: it stages, hints, paces and calls back.
2. **The tracker**: an always-visible, clickable HUD element. It keeps track of what the hero knows, with details
   and map markers.

Powered supervillains (a rival with a face) come after this (Arnd: "discuss this first before we escalate").

**Amends PLAYGROUND_PLAN decision 15** ("no quests, no quest logs") and NPC_PERSONALITY_PLAN §3.6 ("no quest log"):
there is still no quest giver and no objective text, but the hero now keeps a record of what they have seen and
heard (Arnd, 2026-11-05).

## 1. Principles

- **The GM is invisible in play.** It never says "the game master". What it does looks like the city's own life.
  A developer panel shows it (§5).
- **The GM decides what is seen, not what is true.** CrimeDirector, ThreatClock, Bosses, Factions and BossOp keep
  deciding what *happens*. The GM chooses which of it plays out near the hero, and adds the small signs that tie
  it together. It may start an event itself only through the existing directors (the same rules, budgets and seeds
  apply), never by moving people or things directly.
- **Show first, then remember.** The player comes upon something (a situation, not a quest). The tracker writes
  it down afterwards.
- **The tracker knows only what the hero knows.** An entry exists because the hero saw it, heard it (an NPC, the
  news, a billboard, police chatter) or got it out of someone (a cuffed member). It never shows the GM's plans, so
  finding out stays the player's job.
- **Warn before danger** (as the threat clock's omens do already). A boss operation gets signs before it starts.
- **Ignored threads run their course.** The world goes on without the hero, and the tracker says how a thread
  ended: stopped, done, the boss jailed, it faded.
- **Fair, not rubber-banded.** The GM never makes the world stronger because the hero is.
- **Deterministic and pure.** The GM's choices are seeded (`deriveSeed`), its logic lives in pure modules that
  run in selftest, like `pulse.ts` and `ThreatClock.ts`.

## 2. The game master

### 2.1 Director: what the player needs now

Like MasterWorld's Director, it keeps a few **needs** that grow while unmet and are met by what the hero does:

| Need | Met by | Answered with (cheapest first) |
|---|---|---|
| **Story** (a thread moves on) | a clue, a sign, a thread step seen | a sign of a group active in the hero's area (§2.2) |
| **Challenge** | a fight won | a crime of the area's group near the hero |
| **People** | a talk, a deed for someone | a person in need, a favour, a witness |
| **Spectacle** | an event, a threat seen | a boss operation or an omen within sight |
| **Calm** | a stretch with nothing urgent | nothing (the GM holds back) |

A **tension curve** keeps a rhythm: quiet, then build-up (signs), then a payoff (an operation, a fight), then
calm. While the hero is busy (fighting, talking, carrying someone) the GM sends nothing new.

A **player model** from decayed evidence (fights, rescues, deeds, talks, flights, destruction) leans the needs.
A fighter gets clashes sooner, a rescuer more people in need. It reads stats Scale already keeps (Deeds, Justice,
CrimeSystem rewards).

### 2.2 Tools

Each tool is a pure function: it gets a context (the hero's place, the hour, the factions, the clock, the log) and
returns a decision or nothing. They are registered in one toolbox (`src/game/gm/toolbox.ts`) with the need they
meet. The game applies a decision in one place. First tools:

1. **Group thread**: in a district the hero keeps coming back to, the holding group's crimes come up more often
   than random ones (a weight on CrimeDirector's roll, not a new spawner), so one group's story keeps coming back.
2. **Casing** (warns before a boss operation): a game day or two before a heist, takeover, ritual and so on,
   members are seen at the site (suits watching the bank, robes chalking circles, hackers at the port). The boss
   operation's time and site are planned ahead for this (today it is rolled when it starts).
3. **Calling card**: after a stopped operation or a busted stash, the group answers in the hero's area: a fresh tag
   with the hero crossed out, a dropped emblem, a member who sneers and runs (notoriety ≥ wary).
4. **Witness**: someone who saw what a group did, waiting near the scene, who speaks to the hero (an important
   bubble, §3.3), e.g. "They went into the back of the laundry on Pike St" (a hideout hint).
5. **Talk that knows**: NPC chat and barks get lines about the thread the hero is following (the news topic, "anything
   happening around here?"), from the same facts as the tracker.
6. **Callback**: a jailed boss breaks out → a news line plus a sign in their old turf; an old rival group
   comes back into a gap.
7. **Aftermath**: what an ignored operation leaves (burned cars after a takeover, a robbed bank's tape) stays for a
   while, and its tracker entry closes with how it ended.

Later tools: threats (omens shown nearer the hero), personal threads (favours), and the supervillain.

### 2.3 Log

Every GM move is a line in the log: the tool, the need, why, where, when (`game.gm.log`, the newest 200, saved with
their reasons like MasterWorld's `SaveData.vgm`).

## 3. The tracker

### 3.1 Always on screen

A small strip by the minimap: one icon per open thread (the group's emblem in its map colour, a monster glyph, a
person). A new or changed thread pulses for a moment. With nothing open, the strip is empty and takes no space.
On touch layouts it sits with the map button.

### 3.2 Details on click (with tabs)

A click opens a panel with tabs (Arnd: "riders for categories"):

- **Villains**: one thread per group: its name, emblem, boss (once known), notoriety, hideout (once found), turf on
  the map, then what the hero knows in short lines, newest first.
- **Threats**: omens seen, the threat now in the city, how past ones ended.
- **People**: favours asked of you, the sidekick, people you rescued who remember you.
- **City** (maybe): the neighbourhood you are in, its safety, recent news.

Each line says when and where. A line with a place has a map pin: a click shows it on the full map, and **Show on
map** sets a marker on the compass (`MapMarker` with `place: true`). Closed threads move down, greyed, with how
they ended. The panel does not pause the game, like the target frame.

Entries are facts with sources, so the tracker, NPC talk and the GM read the same data:

```ts
interface Clue { id: string; thread: string; at: number; where?: { x: number; z: number }; text: string;
  source: 'seen' | 'heard' | 'news' | 'told' | 'cuffed'; place?: boolean }
```

`Knowledge` (pure, saved) holds the threads and clues. CrimeSystem, BossOp, Hideouts, Bosses, ThreatClock, CityNews
and the people system add clues where the hero saw or heard something. No system writes HUD text itself.

### 3.3 How a new entry is told

- **A short toast** (Arnd: "short toast is good") with the thread's emblem and one line, e.g. "Gilt & Co. — suits
  watching the bank on Elm St". It uses the PowerHud toast, at most one per 20 s; more fold into the strip's pulse.
- **Or a speech bubble where it fits**: when a person says it (a witness, a cuffed crook, someone in need). An
  important bubble must stand out from the background chatter (Arnd), so several things happen at once:
  - a coloured edge with the group's emblem (barks stay plain white);
  - a short, soft chime only these bubbles use;
  - the speaker stops, turns to the hero and gestures, instead of talking while walking past;
  - the tracker icon pulses at the same moment and the line goes into the thread, so a missed bubble loses
    nothing;
  - it stays longer than a bark and is said again when the hero walks up to that person.
  It goes through `voice()` in `src/ui/voices.ts` (all voices are bubbles), with a new "important" style.

## 4. Phases

Each phase is one PR. Headless tests in the cloud; a GPU check on Arnd's PC only for the HUD layout and the
bubble look.

1. **Knowledge + tracker** (no GM yet): `Knowledge`, clues from what exists today (a group's crime stopped, a
   hideout found or given up by a cuffed member, a boss met, beaten, jailed or broken out, a boss operation, omens,
   threats, favours), the strip, the panel with tabs, map pins, toasts, the important bubble. Saved. This alone
   makes most of today's simulation visible.
2. **GM core**: needs, tension, the log, the developer panel (§5), the group-thread tool, talk that knows.
3. **Signs**: casing before boss operations, calling cards, witnesses.
4. **Callbacks and aftermath**: breakouts, returning groups, what ignored operations leave behind; player model.
5. **Then the supervillain**: a powered rival with a face, built on the GM, the tracker and the boss record.

## 5. Developer view

A GM panel (dev only, off in releases, a toggle in the admin console): the GM's moves, newest first, each with
tool, need, why and a "Go to" (the admin console's Go to sections), plus the needs and buttons that make the GM act
now. Selftest: the GM's choices are deterministic per seed, every tool is in the toolbox, every clue kind has a
source, the tracker never shows a clue the hero has no source for.

## 6. Budgets

GM tick every 4 s like CrimeDirector, ≤ 0.2 ms; Knowledge ≤ 200 clues (old closed threads fold to one line); the
strip and panel are plain DOM, updated only when something changes.

## 7. Questions

1. Is the City tab wanted, or is the map enough for that?
2. Should the tracker be on in Sandbox mode too?
3. Toasts: on by default with a setting to turn them off?
