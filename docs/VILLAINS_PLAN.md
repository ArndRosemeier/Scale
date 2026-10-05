# Villain groups — plan (for approval)

Status: **proposal**, accepted with the defaults of §6 questions 1 and 2.
Status (2026-10-05): Phase 1 part 1 is built — seeded street gang and Syndicate with turf, the turf map layer, today's
crimes as their operations (uniforms, names on the target frame and map); see ARCHITECTURE.md, "Street crime". Part 2
(racket, tagging, saves, turf shrinking when you stop them) is open. Builds on the street-crime layer (`src/game/crime`),
the threat/response layer (`src/game/threats`, `src/game/response`) and the powers
(`src/game/powers`). Design rules from PLAYGROUND_PLAN §0 still hold: show, don't tell (no quests,
no dialogue trees, sparse barks); nobody dies (KO / injured); progression is karma.

## 1. What changes for the player

Today crime is three anonymous kinds (snatch, mugging, robbery) rolled near the player. With
villain groups:

- Every city has **3–4 groups** with a face: a name, colours, an emblem, a uniform look, a turf
  on the map and an agenda. You learn to recognise the Syndicate's suits or the cult's robes
  before they act.
- What happens in a district **depends on who holds it**: a gang's turf has rackets and tags on
  the walls, the Syndicate's downtown has heists and slow police, the techno-cult's industrial
  zone has hijacked robots.
- **Your actions move the map.** Stopping a group's operations, busting its hideouts and taking
  down its lieutenants shrinks its turf. Rivals move into the gap and fight over it.
- **Some members have powers** (bolts, fire, frost, a ground-pound, a dash). They are telegraphed
  and use the same visual language as yours. Bosses are named, escape, come back and remember you.
- Big moments go through the existing city response: a boss operation becomes a threat event
  with perimeter, SWAT and news.

## 2. The groups (archetypes)

The archetypes are fixed. **Names, colours, emblem and turf are seeded per city**, so seed 1234
might have "the Harbour Kings", "the Ashen Order" and "Gilt & Co."

| Archetype | Agenda | Turf (districts) | Look | Operations | Powers / gear |
|---|---|---|---|---|---|
| **Street gang** | Own the streets, collect protection money | apartments, rowhouses, port | gang colours, caps and hoods, one colour accent | muggings, protection racket (shops), tagging, turf brawls | bats and knives; lieutenant **Brute** (heavy hitter, shoulder charge) |
| **Syndicate** | Money and control, bribing the city | downtown, commercial | dark suits, sunglasses, gold accent | heists (bank, jeweller, armoured car), getaway convoys, bribery (police respond slower in their turf) | guns; **Enforcer** with stun and frost gadgets |
| **Techno-cult** | Free the machines, steal tech | industrial, metro | grey overalls, glowing visors (garment glow) | hijack service robots and drones (reuses RogueMachines), sabotage power and lights, steal from labs | **lightning** and EMP (stalls cars and robots), drone swarm |
| **Elemental cult** | Rituals that "wake" something | old town, near the cathedral and landmarks, sewers | robes with runes pattern, ember or frost glow | rituals at landmarks (omens, which feed the threat clock), kidnap a citizen for a ritual (rescue), cleansing fires | **fire** and **frost** casters, a summoner (a Murk-like creature in a minor event) |
| **Wreckers** | Chaos, tear the city down | industrial edges, construction sites | hi-vis vests, helmets, masks | demolitions (Destruction system), sabotaged bridges and cranes, smash-and-grab | **quake** stomp, thrown debris; boss can grow (GiantBody) |
| **Eco-radicals** (back to nature) | Drive the machines out, take the city back for nature | parks, the river banks, suburbs, the countryside edge | green and brown, bark and leaf patterns, face paint, moss-glow accents | sabotage (slash tyres, wreck charging posts, smash service robots and drones), occupy streets and parks, free zoo animals, "rewild" a street | **trained animals**: dog packs, a crow swarm, rats from the sewers; a beast-master lieutenant; top tier: the **awakened tree** (§3.8) |
| **Necromancers** | Power from the city's dead; their master wants to cheat death | old town, cemeteries, the cathedral, crypts and catacombs under the old town; mostly at night | black robes, bone-white masks, a pale green glow | grave robbing, relic theft (museum, cathedral), raising skeletons in a cemetery, entrancing citizens (a sleepwalking procession of thralls) | **life drain** beam, raise skeletons, wail (fear), curse (slows, weakens), bone shield; top tier: the **bone colossus** (§3.9) |

Default: a city gets the street gang plus 2–3 others weighted by its districts (port → gang,
downtown → Syndicate, industrial → techno-cult or wreckers, old town and cemeteries → elemental cult or necromancers, lots of
park and river → eco-radicals). The **techno-cult and the eco-radicals are natural enemies**:
where their turfs meet, their clashes are the most dramatic (hijacked robots against animals
and trees).

No group exists only to hunt the player. Groups defend themselves and their operations, and
strike back locally (see §3.5), but they have their own agendas.

## 3. Systems

### 3.1 Faction model (`src/game/factions/`, pure, saved)
- `Faction`: id, archetype, seeded name / colours / emblem, relations to the other groups
  (hostile / wary / allied), strength, notoriety toward the player, lieutenants and boss.
- **Influence per macro cell** (0..1 per faction). Macro cells already carry district, density and
  the crime index, and `playerCell()` exists. Seeded at city start from archetype × district ×
  crime index. A hideout per faction (a warehouse, a back room, or an underground side room from
  `underground/rooms.ts`).
- **Off-screen drift on game hours**, the same pattern as the slimes' `War.ts`: borders creep,
  rivals clash and a faction weakened by the player loses ground. Deterministic per seed and
  hour (`deriveSeed`). Cheap: one update per game hour.

### 3.2 FactionDirector (extends CrimeDirector)
- Today `kindWeights` picks among three hard-coded kinds. Instead the director asks **which
  faction holds the cell**, and that faction's archetype picks the operation, weighted by hour and
  agenda. Cells nobody holds keep today's anonymous crime.
- **Operations** subclass the existing `Crime` FSM, which already has approach → commit → escape,
  flee, fight, gunfight, surrender, loot, witnesses and the police call. New operations:
  - protection racket
  - tagging
  - turf brawl (two factions)
  - heist (multi-stage, with a getaway)
  - robot hijack
  - ritual
  - kidnapping (rescue)
  - demolition
  - sabotage and street occupation (eco-radicals)
- The tables that are closed today (`CrimeKind`, `CRIME_KARMA`, `CRIMINAL_NAME`, `make()`) become
  a registry, so an operation is one file.
- Caps stay: concurrent crimes and operations ≤ 3, the actor budget of 40, a start needs 6 free slots.

### 3.3 Group combat and aggro (new)
- Today criminals only fight the player, officers and their victim. New: `Actor.faction` plus a
  small target picker among nearby actors, using the relations (rival members, police, the player)
  and threat.
- Squad behaviour stays light:
  - members keep near their leader;
  - at most 2–3 members on the player at once (as today);
  - they retreat when the leader goes down;
  - lieutenants rally them.
- **Turf brawl**: two groups fight. You can stop it, or wait and clean up the winner.
  Influence shifts either way.
- `Justice.isHostile` knows faction members, so hitting them books no collateral.

### 3.4 NPC powers: actor-agnostic caster (the biggest refactor)
- `Elements` is hard-wired to the player: origin at the player's hands, aim from Targeting,
  cause 'player'. Split out a **`Caster` core** that takes an origin, a target, a cause and a
  rank, and reuse:
  - `ElementFx` (beams, particles, decals);
  - `status` (frozen, burning, stunned, wet);
  - `Reactions.knockDown`, `Combat.hitActor`, `PlayerHealth`;
  - Destruction with a new cause `villain`.
- The player's powers run on the same core afterwards, so there's no duplication.
- **Villain power set (v1):**
  - bolt (lightning), fireball, frost ray, gust shove, quake stomp, dash, shield;
  - gadgets: stun grenade, EMP, smoke.
- **Readability:** every power has a **wind-up tell** (glow on the hands, a cast animation,
  `cast_forward` / `cast_ground` already exist, a sound). There are cooldowns, and damage that is
  fair against your health.
- Budgets: ≤ 3 active casters, effects capped per second like the laser (≤ 10 impacts/s).
- Ranks with con colours: minion, lieutenant (one power), boss (two or three powers, a weak spot
  or an armour phase).

### 3.5 Bosses, nemesis, escalation
- **Named bosses and lieutenants persist per city.** Arrested means jailed for N game days, then
  maybe a breakout. Escaped means they come back with a grudge. Each one's record (escapes, times
  you beat them) is saved.
- **Notoriety per faction toward you** rises when you hurt it. It never turns into a manhunt:
  high notoriety means more guards on its operations, members in its turf attack you on sight
  instead of fleeing, and its lieutenants turn up to defend an operation you interfere with.
  Busting the hideout and beating the boss collapses the faction for some days; a rival or a
  splinter takes over.
- **Boss operations become threat events** through `ThreatDirector.ARCHETYPE_IMPL`, started
  from outside like the slimes' `murk`, and go into `ResponseDirector.open`: perimeter, evacuation,
  SWAT. Examples:
  - the Syndicate takes the bank;
  - the cult performs a ritual at the cathedral;
  - the Wreckers' boss grows and walks on the town hall;
  - the eco-radicals awaken a tree (§3.8).
  - Optional: the army levels for a grown boss or an awakened tree.

### 3.6 Trained animals (eco-radicals)
- **Dogs:** a pack of 3–5 that runs down a target, holds a person down or bites and tugs (stagger,
  small damage). Starts from the procedural dog in `game/deeds/critters.ts`, moved by actor-style
  steering; it needs a run and leap cycle. Animals are knocked out like people (they flee when
  hurt; no deaths) and calm down when their handler is beaten.
- **Crow swarm:** the bird system (`fauna/Birds.ts`) already flies flocks with steering. A trained
  swarm is a flock that dives at a target: it blinds you (a short screen effect), pecks, and makes
  drivers swerve. Wind and fire scatter it.
- **Rats:** a carpet of rats spilling out of a manhole (instanced, like the birds) that stalls
  cars and makes crowds flee. It ties in with the sewers.
- **Beast-master lieutenant:** commands the animals (whistle tells). Beat them and the animals
  scatter.
- Budget: animals count against the actor budget in groups (one pack = one "actor"), drawn instanced.

### 3.7 Showing it (no text walls)
- **Map:** a "turf" tile layer (a faction tint per cell, toggleable like the crime heat), hideout
  markers once discovered, operation alerts in the faction colour.
- **In the world:**
  - graffiti and emblem decals on walls in gang turf;
  - closed shutters and broken windows where rackets run;
  - hijacked robots with the cult's colour on their visors;
  - eco-radical slogans and seedlings on billboards and walls (pictograms through `future/Signs.ts`); rewilded streets with vines and moss decals.
- **On the target frame:** "Harbour Kings · Lieutenant" through `Actor.title`, plus the emblem.
- **Barks:** one voice per faction (taunts, surrender lines, rally calls) in the existing `Barks` tables.
- **News feed:** "Syndicate heist foiled", "Ashen Order spotted at cathedral".

### 3.8 The awakened tree (eco-radicals' top tier)
- A ritual by the eco-radicals' leader turns a real street or park tree (a prop of the loaded cell)
  into a creature. Its prop disappears, roots tear up the pavement (decals and rubble), and the
  creature stands up in its place. The ritual is an omen first: leaves swirl and the ground
  trembles, which you can try to stop.
- **Body:** a `CreatureRig` (the Strider's procedural rig): the trunk is the spine, two or three
  root legs, branch arms (tails or tentacles in rig terms) with a sweep and a grab, the crown as
  its "head". The skin is built from the same procedural tree model (bark and leaf materials),
  so it looks like the tree it was. Size follows the tree's species and scale, 8–15 m.
- **Behaviour:** it goes for **anything technical**:
  - cars (throws or crushes them);
  - service robots and drones;
  - traffic lights, street lamps, charging posts, the techno-cult's machines.
  It ignores people unless they attack it. It **defends itself**: whoever hurts it (you, the
  police, the army) becomes its target until they back off.
- **Fighting it:** it's weak to **fire** (burning status, it panics and flails); frost slows it;
  lightning does little. Weak spot: a glowing heart in the trunk, exposed when it rears up for a
  slam. When it's beaten it roots and turns back into an (old, gnarled) tree that stays as a
  landmark of the fight.
- **Escalation:** it's a major threat event (`ThreatEvent` + `ThreatActor` with zones and weak
  spots, like the Strider), started by the faction (like the slimes' `murk`), with the full city
  response. A lesser version (a bush or hedge creature, human-sized) works as a lieutenant power.

### 3.9 Necromancers
- **The no-death rule holds:** nobody who goes down in the game is ever raised. Necromancers use
  the city's *old* dead (cemeteries, catacombs, crypts) and the living only in a trance.
- **New places** (the world has none yet):
  - cemeteries, a park variant in the cell planner (graves, a chapel, walls and gates, yews),
    placed in the old town and at the city's edge;
  - crypts under the cathedral and the cemeteries, reached through the underground side rooms
    (the bricked-up and collapsed sewer rooms become crypt entrances).
- **Skeletons:** minions built on the humanoid body with a bone suit and skull mask (garment
  patterns and glow), so they need no new rig. Hit hard enough, they **fall apart into a heap of
  bones** and pull themselves together again unless their necromancer is beaten. Spooky, not gory.
- **Thralls:** entranced citizens walk in a slow procession behind a necromancer, eyes glowing.
  Beat the necromancer, or wake them one by one with E, and they come to, confused and unhurt.
  A rescue operation without punching civilians.
- **Powers:**
  - life drain (a green beam that heals the caster);
  - raise skeletons from the ground;
  - wail (crowds flee, a short stun);
  - curse (slow, weak);
  - bone shield.
  At night street lamps flicker and fog gathers where they operate (weather and lights hooks).
- **Top tier, the bone colossus:** a ritual in the catacombs pulls thousands of bones into a giant
  (a `CreatureRig` biped or quadruped, 12–20 m) that rises from the cathedral square or a cemetery
  as a major threat event. Weak spot: the necromancer master riding in its ribcage, exposed when
  it roars. Beaten, it collapses into a hill of bones that sinks back into the ground.
- **Rivals:** the elemental cult (both occult, competing for the same sites); the eco-radicals
  hate them too. The street gang stays clear of their turf at night.

### 3.10 Saves
- A `factions` block (migration 3 → 4, next to `slimes`):
  - per faction: seed-derived id, influence grid (quantised), strength, notoriety;
  - boss and lieutenant states, hideout busted-until.
- Running operations aren't saved (same rule as crimes).

## 4. Delivery in phases

| Phase | Contents | Playable result |
|---|---|---|
| **P1 Faces & turf** | Faction model and seeding (names, colours, emblems, uniforms through `Actor.outfit`). Influence per cell and the map layer. FactionDirector runs today's three crimes as faction operations, plus racket and tagging. Target frame, barks, saves. | You see who runs a district and who's robbing whom; stopping them shrinks their turf. |
| **P2 Turf wars** | Relations and group aggro. Turf brawl. Hideouts (find them, bust the stash with E). Off-screen drift. Influence from results. | Groups fight each other; the map shifts with your actions and over time. |
| **P3 Powers** | `Caster` core (the player's Elements moved onto it). Villain power set and gadgets with tells. Lieutenants with powers. Techno-cult robot hijack, cult ritual. | Powered fights that read clearly and feel like your own powers. |
| **P4 Bosses** | Named bosses, jail and breakout, notoriety. Boss operations as threat events with the city response. Eco-radicals' trained animals (dogs, crows, rats). The awakened tree. Necromancers: cemeteries and crypts, skeletons, thralls, the bone colossus. | Recurring nemeses and big set pieces: a tree monster tearing up traffic, a bone giant rising from the cathedral square. |
| **P5 Polish** | Sounds (synth tools: taunts, gadget sounds, faction stingers), news, graffiti decals, balancing, self-tests. | — |

Each phase ships on its own and keeps the old behaviour where a cell has no faction.

## 5. Budgets
- Actors: shared reserve of 48 and the crime budget of 40, unchanged. ≤ 12 actors per operation,
  ≤ 8 full rigs (shared with crime and threats).
- ≤ 3 casters, effect caps as for the player's powers.
- Directors ≤ 0.3 ms per frame; off-screen drift once per game hour; boss events within the
  threat budget (≤ 2.5 ms extra).

## 6. Questions to decide
1. **Cast:** fixed archetypes with names and looks seeded per city (proposed), or hand-made named
   groups that are the same in every city?
2. **First two groups for P1:** proposed are the street gang and the Syndicate (no powers needed yet).
3. **Power level:** may villains knock you out? Ground-only casters first (proposed), with flying
   or growing bosses later?
4. **Off-screen drift** (the map changes while you're elsewhere): yes (proposed), or only change
   through your actions?
5. **Eco-radicals in which phase?** They need the animals and the creature rig (P4 as proposed).
   Could the animals come earlier (P2) and the awakened tree later?
6. **Awakened tree and people:** ignores people unless attacked (proposed), or does it also chase
   away anyone near its tree?
7. **Necromancers' tone and timing:** night-only (proposed: mostly night, the colossus any time),
   and how spooky (proposed: cartoonish bones, glowing eyes, no gore)?
8. **Town hall:** use it as a stage (a Syndicate bribe scene, a boss attack on the council)?
