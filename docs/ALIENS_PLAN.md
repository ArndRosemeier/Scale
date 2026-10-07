# Aliens — plan

Status: **plan, nothing built** (Arnd, 2026-10-07: "In this close future, aliens have actually landed and made
contact. They are not hostile and also not really friendly, more like upset parents watching over toddlers. They are
also mostly robotic. UFOs in the sky are not an uncommon thing. The normal kind of aliens is no problem. But then
there are other kinds who normally are not allowed to visit earth, but they occasionally find ways."). Decisions
below were settled with Arnd in the project thread the same day; lines marked *(default)* are Claude's picks that he
has not ruled on yet.

Replaces THREATS_PLAN Phase D (scouts → abduction → tripods → mothership invasion). Builds on: the threat clock and
director (game/threats), ThreatActor and the response ladder, the drone layer, the sky (SkySystem: sun, moon),
CityNews and the billboards, fame and reputation, people with personalities (NPC_PERSONALITY_PLAN), villains and
their power casting (VILLAINS_PLAN, powers/Caster), the underground (sewers, side rooms, the deep realm), defeat and
the revival ward.

## 1. Decisions

1. **The Wardens** *(working name; on the street: "the Nannies")* are the established aliens. Mostly robotic.
   Neither hostile nor friendly: upset parents watching toddlers.
2. **They never meddle in human affairs.** Not with the player, not with monsters, not with villains, not with the
   army's last resort: a district levelled by a nuke is beneath their notice. They watch and yawn. Only a threat to
   the whole Earth would move them (not part of any phase here).
3. **The one exception is other aliens.** Earth is closed to every other kind. A forbidden alien the Wardens notice
   is dealt with at once. So the player's lever on them is **exposing** forbidden aliens (§4).
4. **UFOs are a normal sight.** Discs cross the sky every day.
5. **The station is always in the sky** (§2). Entering it is a big later feature, not now.
6. **Runaway teens** are of the Wardens' own species: misbehaving youngsters on a joyride. A big embarrassment for
   the nannies (§5).
7. **Smugglers** bring alien tech in and sell it. Some other aliens have **lived underground for centuries** (§6).
8. **The player can fight a Warden**, and it is hard. Wardens underestimate humans; the others never help one (helping
   against ants is beneath them). A Warden beaten by a human is ridiculed by its own kind (§7).
9. **No shapeshifters** replacing people the player knows: it would read as a bug.

## 2. The Wardens in the city

- **The station:** a vast shape high over the city, always in the same part of the sky, like a second moon: pale by
  day, softly lit at night, a few slow lights crawling over it. Drawn in the sky pass (no geometry in the world),
  every seed *(default: the same station, at a seeded bearing)*.
- **Discs** (Arnd: random, unexplained): usually a handful, some days none at all, and now and then suddenly a
  hundred or more filling the sky for an hour or a day (a festival? nobody knows, the Wardens don't explain), then
  nothing again. People and the news speculate. Smooth, seamless, silent but for a low chord. They drift on
  slow routes between the station and the horizon, stop and hang over things, sweep a pale scan cone over a street,
  then move on. Seen from far; the drone layer's pattern (instanced, simulated coarsely beyond view).
- **Walkers** *(default: rare, 0–2 in the city)*: tall, thin robots that stand still on a plaza or a roof edge for an
  hour, head turning slowly, then walk off. People keep a ring of space around them. They never react to being
  bumped, shouted at or photographed.
- **Watching, never helping:** at an incident (a Strider battle, a heist, a nuke countdown) two or three discs
  gather high above and hang there for the whole thing, then drift away. The disinterest is the joke and the point.
  When the player does something spectacular a disc may turn its cone on them for a moment *(default)*, nothing
  more.
- **Sounds:** the low chord of a passing disc, a soft rising tone when a cone sweeps, nothing else.

## 3. The city lives with them

- **People have opinions,** from their traits: the trusting wave, the anxious hurry past, children point and follow a
  walker, some call them the Nannies with a grin. Talk lines about them in the talk menu *(default)*.
- **Protesters** ("Earth for humans") gather under a hanging disc now and then, a cheap crowd event.
- **The techno-cult reveres them** (machines that rule) and **the eco-radicals resent them** *(default)*: a line in
  each faction's barks, nothing systemic yet.
- **News:** short CityNews items ("Disc hovers over stadium for six hours, no comment", "Treaty anniversary") and
  pictograms on the billboards. The treaty is lore only: contact some twenty years ago *(default)*, Earth placed under
  their watch and closed to every other kind.

## 4. Exposing forbidden aliens

The Wardens see what their scan cones and the station see. Forbidden aliens hide from that: low between towers,
under bridges, in the underground, behind cloaks and jammers. Exposing one means **getting it seen**:

- **Bring it into a cone:** drive, carry, throw or lure the alien (or its craft) into a disc's scan cone, or into
  open sky where the station sees it. A disc reacts at once: a stasis field, a lift beam, and it is gone.
- **Break its cover:** hits knock cloaks and jammers out for a few seconds; exposed in open ground, the nearest
  disc turns and comes.
- **Evidence:** smuggled tech (a crate, a weapon taken from a villain) carried into a cone counts too and draws a
  disc to where it came from *(default)*.

Reward: karma and fame (people film it; the news runs it), and **Warden regard**, a quiet count of the times the
player handed them one of their problems. Regard does nothing visible at first; later it is how the door to the
station opens *(default)*. Wardens never thank anyone; at most a disc dips once.

## 5. Runaway teens

A minor event on the threat clock: a stolen saucer, smaller and scuffed, with youngsters aboard who are clearly the
Wardens' kind (smaller, glitchier, gaudy lights).

- **What they do:** joyride low through the streets, beam up a car and drop it on a roof, stack cars, beam a
  pedestrian up and leave them in a fountain, draw glowing glyphs on facades, abduct a cow in the countryside. Mostly
  harmless, often expensive. People film and laugh; some are hurt by falling cars.
- **Why the nannies miss them:** the teens keep low under the station's view and dodge the discs' routes.
- **The player's job:** chase the saucer, knock its hover pods out, or herd it up into open sky or a cone. Exposed,
  a parent disc drops on it in seconds, takes it in a lift beam, and a stern tone rolls over the block. Ripe for
  laughs in the news ("Nannies lose their kids again").
- **The police** chase it with cars and a helicopter and get nowhere; the response ladder stops at level 2.

## 6. Smugglers and the old ones

- **The old ones are the Lumen** (Arnd), the slime people of the deep realm: they came long before the treaty and
  live hidden underground. They now get **speech bubbles, cryptic ones** (short, strange, half-sense lines about
  light, waiting, the ones above, the sky-watchers), shown like other barks when the player is near. The Wardens either
  never found them or let them be; they keep to themselves.
- **Smugglers** use the old ones' hidden ways to bring in alien tech and sell it to gangs and villains: new gadgets
  for the villain power sets (a beam pistol, a cloak, a gravity grenade) with clear tells. Alien-tech crimes leave a
  glowing residue the player can follow down to a deal in a sewer side room.
- **The player's job:** break up the deal, take the crate, carry the evidence up into a cone. The Wardens sweep the
  smugglers' route; alien gadgets get rarer in the city for a while *(default)*.
- The Lumen themselves cannot be exposed: they are tolerated, or simply too old to matter *(default)*.

## 7. Fighting a Warden

The player may attack a disc or a walker. It is meant to be one of the hardest fights in the game.

- **Contempt first:** a Warden ignores the first hits, then swats the player away with a repulse, then switches to
  stasis fields and heavy beams. A regenerating shield over armour; weak spots open only while it fires.
- **Nobody helps it:** other discs watch from high up and do nothing.
- **Losing:** knocked out, the revival ward as usual. No grudge; the player was not worth one.
- **Winning:** the disc comes down in a smoking crash (or the walker topples), people flock to it, the news goes
  wild: a big fame moment. The other discs keep away from the hero for a while, and the station's lights flicker in
  what the news calls laughter *(default)*.
- **Regard after a win** (Arnd): the *first* beaten Warden makes the hero more interesting to them, because the
  loser is ridiculed by its own kind: regard **rises**. A few more wins leave it flat. After that it **falls, steeper
  with each further defeat**: a human who beats Wardens left and right stops being funny. Sketch *(default numbers)*:
  win 1 → +10, wins 2–3 → 0, win n ≥ 4 → −5·(n−3).
- **Reputation:** mixed *(default)*: people who dislike the Nannies cheer, the anxious are scared.
- No Warden wreck is ever carted off by the city: a disc lifts it away within minutes *(default)*.

## 8. Later

- **Entering the station** (Arnd: later, a big thing): regard opens it; the interior designer's sci-fi theme.
- **Trophy hunters** who come for the hero, or for a giant monster.
- **An escaped specimen:** a Strider-class alien beast from a Warden zoo ship; the Wardens want it back alive, so
  holding it down until a disc arrives beats killing it.
- **A mass break-in** as a late climax instead of the old mothership invasion.

## 9. Phases

1. **The Nannies in the sky:** the station in the sky pass, discs on routes with scan cones and random numbers with
   rare swarms, walkers, watching at
   incidents, sounds, people's reactions and talk lines, news items. Changes what you see: GPU check.
2. **Runaway teens and exposing:** the saucer event on the clock, its pranks, chasing and grounding it, cones and
   exposure, the parent disc, regard, karma and fame, news.
3. **Smugglers:** alien gadgets in the villain power sets, the residue trail, deals in side rooms, evidence, the
   cryptic Lumen bubbles.
4. **Fighting a Warden:** the Warden as a ThreatActor (repulse, stasis, beams, shield), crash and wreck, ridicule.
5. **Later:** §8.

Each phase is playable on its own.

## 10. Open questions

Settled 2026-10-07: the old ones are the Lumen, with cryptic bubbles; disc numbers are random with rare unexplained
swarms; regard after beating a Warden first rises, then stays, then falls ever steeper (§7). None open right now.
