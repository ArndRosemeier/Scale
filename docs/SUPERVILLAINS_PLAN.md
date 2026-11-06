# Supervillains — plan

Status: accepted direction (2026-11-05, Arnd, thread "Build game master, tracker and supervillains"). Builds on the game
master and the tracker (GAME_MASTER_PLAN, phases 1–4 built in v0.283–v0.288).

Arnd's rules:

- **Not a fixed thing. Every seed is different.** Who rises, why, with which powers, where and when comes from the city's
  seed and from what happens in that city.
- **One or more, developing over time.** A city starts with none. Villains rise as the city goes on; there can be
  several at once.
- **They can be beaten for good, and new ones can arise.**
- **Turf wars between villains** are possible.
- **Not too on the nose** (as for the game master): a villain is found out from signs, rumours and their deeds, never
  announced by the game. The player never sees the words "game master".

## 1. A villain

A villain is a record, made from the seed and the city at the moment they rise (pure, saved, `src/game/villains`):

| Part | Made from |
|---|---|
| **Alias and real name** | seeded word lists per theme ("the Gilded Fang", "Magnetar", "Mother Ash"); the real name like the bosses' names |
| **Origin** | what the city offers when they rise (§2): a gang boss who got powers, someone the hero failed, an accident at a landmark, an outsider |
| **Motive** | money, revenge (on the hero, the city, a group), a creed (cult, eco, machines), rule (order by force), fame |
| **Style** | showy or cold, cruel or with a code; shapes their lines, how they treat bystanders and hostages, whether they keep a truce |
| **Theme and element** | one of a few themes (storm, frost, fire, metal, bone, beast, mind, shadow) that picks the powers, the colours, the words |
| **Powers** | 3–4 from the villain power pool the lieutenants and bosses use (`VillainPower`), weighted by theme, plus one **signature** (§4) |
| **Power level** | grows with time and with their wins, drops when the hero beats their plans; never tuned to the hero (fair, not rubber-banded) |
| **Base** | their lair: a landmark, a block in their gang's turf, the sewers, a tower; found like a hideout |
| **Crew** | the gang they took over or brought; their lieutenants are powered |
| **Record** | schemes done and stopped, fights with the hero, escapes, jail, grudges (whom they hate: the hero, a group, another villain) |

## 2. How villains rise

A **villain pressure** per city grows with game days and with what happens: a high crime index, a collapsed gang (a gap
to fill), the hero's fame (someone wants to beat them), threats and their remains (a source of power), a lot of damage
done by the hero (someone they hurt). When it passes a mark and there is room (one villain early, up to three later),
one rises. Which origin depends on the city then, seeded:

- **The boss who rose**: a gang boss with a long record (escapes, beaten, jailed) comes back with powers and makes
  the gang theirs.
- **Someone the hero failed**: a person hurt in the hero's fights, a favour let down, a citizen whose street was
  wrecked; they come back with a grudge against the hero.
- **The accident**: at a landmark (the museum, the port, a tower) or at a threat's remains, someone is changed.
- **The outsider**: comes to town with a crew and takes turf from a weak group.

Each rise starts quietly (rumours, a symbol, a sign); the game master paces the reveal.

## 3. How a villain shows (the arc)

1. **Rumours**: people asked for the news whisper a name; the tracker opens a story with only that ("Someone calling
   themselves the Gilded Fang").
2. **Signs**: their symbol on walls in their turf, a calling card at a crime scene, members of their crew in new colours.
3. **Lieutenants**: powered members on the crew's operations; a cuffed one gives up something about the villain.
4. **The face**: a sighting (a rooftop, a speech in a square, on the billboards' news), then a first fight that they
   leave on their own terms.
5. **Schemes**: a plan in steps (cased with the game master's signs), a set piece by motive: a vault of the city, a
   hostage at a landmark, a machine uprising, a storm over a district, a duel with another villain.
6. **Showdown**: at their base or the scheme's site. Beaten and cuffed: jail (they may break out); beaten at the end of
   their arc (after a final showdown, or beaten often enough): **beaten for good** (locked away for good, or gone),
   and their story in the tracker ends.

A beaten villain's lieutenant, rival or victim can be a later villain's origin.

## 4. Signature powers

Built from what exists (Caster, Elements, blastFx), one per villain, themed: a chain of bolts, a quake ring, a
blink-dash (short teleport), a storm cloud over the street, a frost wall, a swarm (the Beast-masters' whistle), a
drain aura, a mind-turn (a bystander or a cop fights for them a moment), a shadow cloak. Each has a clear tell, a
counter and energy-like limits, like the hero's powers (no cooldown tricks the player can't see).

## 5. Villains and each other

Villains have feelings for each other in the faction relations table (numbers, FACTION plan): rivals fight over turf
(their crews brawl, a duel of villains as a set piece), allies share a truce against the hero, a strong villain can
absorb a weak gang. Turf wars between villains use the existing turf drift and brawls; a duel is a threat event the
city answers.

## 6. Phases

Each phase one PR (or a few), headless tests in the cloud; a GPU check on Arnd's PC only for looks, powers and fights.

1. **The villain table and the rise** (no body yet): the record, the generator (seeded, pure), pressure and rising over
   time from the city's state, rumours and news, the tracker story, symbols on walls in their turf (the graffiti
   system), the developer view. Saved.
   *Built in v0.300*: `src/game/villains` (villain.ts pure: record, generator, pressure, room, saves; villainText.ts;
   Villains.ts: hourly pressure from crime, collapsed groups, fame, ended threats and the hero's harm; rise from the city's
   state; whispers through the people's news talk; marks on walls in the crew's turf, seen from 12 m; thread
   `villain:<id>`; `dev.villains.*`, admin console "Supervillains"; selftest "supervillains").
2. **In person**: their body and costume (Actors generator, theme colours, a cape or mask where Actors has one), the
   boss fight with powers and the signature, escapes, jail, beaten for good. GPU check.
3. **Schemes**: plans in steps through the game master (casing, lieutenants, calling cards), a set piece per motive.
4. **Villains and each other**: turf wars, duels, alliances, absorbing gangs.
5. **Endings and successors**: final showdowns at the base, beaten for good, new villains from what is left.

## 7. Budgets

Generation and rising are pure and cheap (one look per game hour). In person a villain is one actor with powers, like
a boss; at most one villain fight at a time; their symbols are graffiti tags (the existing cap).
