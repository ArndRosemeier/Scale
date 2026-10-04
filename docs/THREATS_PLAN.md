# Scale — Threats (monsters, aliens, tech) and the city's response

Research and design brief (2026-10-03). Status: accepted with changes — see PLAYGROUND_PLAN.md §0 decision 19 (no player levels; army vs player uncapped; small-nuke countdown as last resort; carcasses removed by city crews after a while). Builds on docs/PLAYGROUND_PLAN.md §0 (binding decisions).

Status (2026-10-04): Phase A "Robot malfunction" is implemented — ThreatClock with omens, rogue robots / service robots / drones, response levels 0–2 (patrol, perimeter & evacuation with civil-defence siren and roadblocks, SWAT), cause-aware consequences, incident marker; see ARCHITECTURE.md, "Threats and city response".
Status (2026-10-04): Phase B stage 1 of 3 "the Strider" is implemented — GiantBody (shared footfalls with `size` / `cause`, `roar` / `tremor` stimuli), the segmented creature rig, ThreatActor (zones, weak spots, aggro, damage API), the Strider from the river along the arterials (walk, lean, tail swipe, roar and rear, swat, breath with burning facades; stagger, retreat, collapse — the body stays), major events on the clock (≥ 3 h and a karma milestone, tremor / wake omens), Tab target kind `threat`, faster and wider response for majors with `registerLevel` for levels 3+. Stage 3 (aftermath, rescues, nuke countdown) is open.
Status (2026-10-04): Phase B stage 2 of 3 "the army" is implemented — levels 3 (National Guard: trucks with infantry squads, APCs, sandbags, searchlights) and 4 (tanks with turrets, attack helicopters with rocket runs that the Strider swats into burning wrecks, jet bombing runs, artillery beyond the city edge), `ForceUnit`s and squads with tiered simulation (materialised within 600 m, abstract beyond), hit chance × damage vs zone armour with line-of-sight weak spots, morale and falling back, the Strider retaliating by aggro, `gunfire` stimulus, sounds; the headless no-player battle (deterministic, army wins ~46 % of 50 seeds). The army against a rampaging player is a documented hook only; see ARCHITECTURE.md, "The army".
Status (2026-10-04): Phase B stage 3 of 3 "consequences and the last resort" is implemented — level 5 (a small tactical nuke: a seeded, rare countdown when the army fails deep in the city — the attack siren, traffic and the army leaving, the countdown on every screen, the strike zone on the map and compass; beaten in time it is called off, at zero a flash, a shock wave levelling the district (it stays levelled, also in saves), a mushroom cloud, the player knocked out at its edge, the city lost), the casualty ledger (never dead), people trapped under rubble to dig out (hold E), the injured to carry to an EMS triage tent with ambulances and paramedics, fire engines hosing burning facades, long-range smoke columns, the live news feed and news pictograms on the billboards, people pointing and filming (phones glowing at night), cordons and a memorial afterwards, the carcass a landmark and then carted away by a crane and flatbeds, the player's rally (R) and airstrike (T) at good reputation; see ARCHITECTURE.md, "Consequences and the last resort". Not built: reconstruction (a hook), the army against a rampaging player.

## 0. Research takeaways

- **Cloverfield / Godzilla (2014) / Minus One** — the monster is seen in fragments (a tail between towers, a silhouette in smoke, a news-drone feed on a billboard) long before it is seen whole; restraint sells the scale. Fits "show, don't tell".
- **Shin Godzilla / War of the Worlds** — the city's response failing in a believable order (tank column on a bridge → helicopters → bombing run → evacuation). The army losing communicates stakes; the player's later win is earned.
- **Pacific Rim** — size categories and glowing weak spots. **Rampage** — climbing/toppling towers, helicopters pecking at the monster. **Earth Defense Force** — swarms in a destructible city, NPC squads fighting alongside. **City of Heroes** — giant monsters as zone events (Lusca), Rikti invasion waves with pylons and a mothership; low-level heroes contribute (rescues, adds) — the key to motivation. **XCOM** — a rising threat clock with sightings first. **Prototype** — military zones, checkpoints, escalating army stance (also against the player).
- **Real-world response (ICS/NIMS)** — patrol first responders set inner/outer cordons → incident command + staging → SWAT/tactical → mutual aid → state/National Guard → army under unified command; zoned evacuation or shelter-in-place; civil-defence sirens and phone alerts; shelters at pre-designated sites; colour-tag triage. A natural, *visible* five-step ladder.

## 1. Threat catalogue

Size tiers by player scale: **T1** 2–6 m (human/SWAT), **T2** 6–20 m (police/army), **T3** 20–60 m (army/air power), **T4** 60–120 m (full-power giant player or combined-arms climax).

Common foundation: a `ThreatActor` (HP, armour, weak spots as local hitspheres, aggro table, FSM) on a `GiantBody` extracted from Player.ts (stride, footstep energy ∝ k³, landing) and Interactions footstep/land. Key refactor: footstep/land and the stomp/collapse crush handler in Game.ts use `player.height` — stimuli must carry `size` and `cause`, so a kaiju crushes cars by *its* size and isn't booked to the player.

### Monsters
1. **Strider — reptilian walker** (T3 40 m, later T4 80 m). Emerges from the river (every seed has one; sea only in ~45%), walks the arterial graph toward downtown, attracted by tall buildings, loud stimuli and whoever hurt it most; roars at and swats helicopters. Footsteps via destruction impacts, tail swipes as capsule sweeps, leans on/climbs and topples towers. Low spine, tall dorsal ridge that glows 2 s before its breath weapon; two-tone roar. Weak spots: glowing throat while charging, soft belly when rearing. Weak player: evacuate, dig out the trapped, carry the injured to triage. Medium: distract (aggro), freeze a leg (stagger), shield helicopters. Strong: wrestle at 60–100 m, seismic stomp to unbalance, lure it back into the river.
2. **Leviathan — amphibious river/sea creature** (T3). Stays in the water channel, attacks bridges and quays, tentacles pull cars off decks. Bridge spans collapse. Shadow → wake → tentacles. Weak spots: eyes at the surface; frost nova freezes the water around it (rooted). Weak player: rescue people from cars on the bridge; strong: drag it ashore where it's weak.
3. **Burrower — giant worm** (T3). Travels under arterials along sewer trunks and metro tunnels, surfaces in sinkholes, rears, dives. Street collapses, undermined buildings (ground-floor slabs break), metro halts. Tremors first (camera shake, birds flush, pipes rattle) → street bulges → tooth-ring maw. Weak spot: the maw while surfaced. Weak player: go into the sewers (small) to find the nest/egg sacs; medium: seismic stomp forces it up. Constraint: only 16 terrain-hole slots today — sinkholes need more or a crater mesh + collision.
4. **Brood — swarm** (T1–T2, 40–150 units). Boids over streets and walls; chase people, flip cars, gnaw robots; small but everywhere-destruction. Chittering wave, dark carpet. The entry-level threat: a weak hero can fight single creatures; fire wave/chain lightning clear clumps. Pairs with a "Mother" Strider later. Instanced + vertex animation like the birds.
5. **Roc — flying beast** (T2–T3). Perches on towers/roof edges, dives on helicopters/drones, carries off a bus; perch weight crushes top floors, wing gusts throw debris. Weak player: catch falling people; medium: whirlwind grounds it; strong: aerial fight.

### Aliens (escalation: scouts → abduction → landing → invasion)
6. **Scout drones** (T1) — silent lights at night (omen), scanning people with light cones; reuse the drone layer; downed scouts drop loot/power cores.
7. **Abduction craft** (T2) — hovers and beams up cars and people; the player pulls people out (rescue) or shrinks the craft.
8. **Landing craft & tripods** (T3) — three IK legs and a dome, heat ray reusing the laser-eyes beam/heat accumulation; shields fall after pylon generators are destroyed (CoH); weak spots at leg joints; toppling a tripod onto a building is spectacular.
9. **Infiltrators** (T1) — humanoids in the crowd who glitch, behave wrongly, run when Tab-targeted (con shows "?"); a slow-burn reveal built on crowd + actor controller.
10. **Mothership** (T4 climax) — sky-filling disc dropping waves; the ground game is the rooftop pylons; the player goes up with flight.

### Near-future tech
11. **Robot uprising** (T1 wave) — delivery robots, service robots and drones turn hostile (red eyes, clustering). Almost free; ideal early threat with police + SWAT.
12. **Giant mech** (T3) — rogue prototype or villain mech; piston legs, missile pods (blast), weak spots: cockpit, heat vents (frost), joints; cheap to render, readable mechanical sounds.

## 2. City response

### Ladder (`ResponseDirector`, src/game/response/), per incident, unlocked by threat tier, elapsed time and how the previous level fares

| Lvl | Who | What the player sees |
|---|---|---|
| 0 | Patrol | nearest police cars respond with lights/siren; police drones orbit; officers wave people back |
| 1 | Perimeter & evacuation | cars as roadblocks across arterials (+ barriers), inner/outer cordon, civil-defence siren loops, billboards switch to red alert pictograms with arrows to the nearest metro (no text), people flee to metro entrances, traffic flees or is abandoned |
| 2 | SWAT & emergency | armoured SWAT vans, fire trucks hosing burning facades, ambulances and a triage tent in a park/plaza outside the cordon, news drones and helicopter |
| 3 | National Guard | trucks and APCs on boulevards, sandbag positions at junctions, infantry squads, searchlights at night |
| 4 | Army & air | tanks firing from bridges/avenues, 2–4 attack helicopters with rocket runs, jets strafing/bombing with sonic booms, artillery flashes from beyond the city edge (sound delayed) |
| 5 | Last resort | conventional forces failed: the army prepares a small tactical nuke — evacuation sirens, convoys leaving, the strike countdown on billboards; the player can beat the clock by defeating or driving off the threat |

### Forces without the player
`ForceUnit {kind, squad, pos, hp, morale, ammo, task}`; fire resolved as hit chance × damage vs the threat's armour per body zone (army fire mostly chips armour and staggers; weak-spot hits need line of sight, rays at 2 Hz per squad). The threat retaliates by aggro (helicopters swatted → physics wrecks; tanks stomped → crushed wrecks). Morale drops after losses; units fall back to the next roadblock line ("the line is breaking"). Seeded but live outcomes: the army drives it off/kills it after heavy losses (~40% without the player, tunable); or it reaches downtown and topples towers until level 5 or retreat; or the player turns the battle. Balance via a headless "no player" simulation. Soldiers fire only at threats, never at people; police use non-lethal tools on criminals; tracers as beam ribbons, muzzle flash/sparks via debris bursts; new `gunfire` stimulus.

### Casualties without gore
People are counted as evacuated / injured / trapped / missing — never dead on screen. Collapses turn nearby people into trapped markers on rubble mounds (dust-covered people waving); crushed soldiers go down and medics drag them away; paramedics kneel and load ambulances; triage tags as coloured armbands. Consequences gets `cause: player | threat | military | police`; army collateral feeds news and city damage, never the player's karma — and makes rescues more valuable.

### Show, don't tell
Long-range smoke columns per burning/collapsed building; jets overhead; distant artillery flash then boom; civil-defence sirens wailing far off; phones glowing in crowds; convoys rolling past toward something; people pointing; billboards showing a live news-drone feed (one low-res render target at 5 Hz — the Cloverfield trick and the best device for "the weak player sees it from the start").

### How the player helps
Low power (karma, extends Deeds): guide stragglers to a metro entrance, dig trapped people out (hold E), carry the injured to triage, pull drivers from crushed cars, return a lost child to its parent at the shelter, put out fires (hydro, frost), protect the field hospital from swarm stragglers, shield soldiers. Medium: take aggro, mark weak spots (units focus them for 10 s), clear swarms, rescue downed helicopter crews. High: lead the battle — at high reputation squads rally behind the player; call airstrikes on a Tab target (reputation unlock). A giant player levelling blocks *becomes* a threat to the same ResponseDirector (Rampage/Prototype), unifying it with the police-consequences decision.

## 3. Pacing — the City Threat Clock
`ThreatClock` (pure, headless-testable, saved per seed): pressure += played time × base + karma earned × a + chaos × b.
- Normal mode: first **major** event no earlier than ~3 h of play and a karma milestone, always after omens. **Minor** events (robot malfunction cluster, a swarm scout pack, a scout-drone sighting) from ~45 min, at most one per 20–30 min. Then majors every 1.5–3 h, tier rising with player power but always about **one tier above** what the player can handle — watching the army fight something you can't is the motivation.
- **Omens** (seeded schedules): micro-tremors (birds flush, car-alarm chorus, ripples in puddles), strange lights over the river at night, blackout blocks with flickering signs, a sealed-off area with fences/military truck/hazmat suits, news headlines on billboards, a convoy leaving town, an infiltrator glitching when targeted. Each omen points to the coming archetype.
- **Lifecycle**: omen → alert (sirens) → contact → escalation (levels 0–4) → climax → resolution → **aftermath** (rubble stays — damage already survives cell eviction; smoke for hours; ambulances, fire trucks, cordon tape; people return, flowers and candles; then scaffolding and cranes; reconstruction later). Recovery window: no major for X hours; looters raise minor crime.
- **Variety**: never the same archetype twice in a row, rotating entry points, variant mods (colour, size, extra weak spot, night/day), different response doctrine per event (bridge defence, downtown last stand, failed stadium evacuation).
- **Sandbox**: "City events" panel (off / rare / normal / frequent, manual spawn by archetype/entry/tier, "no player" spectate); devtools `dev.threat.spawn('strider', {from: 'river'})`, `dev.threat.phase(...)`, `dev.response.level(3)`, `dev.threat.clock(...)`.

## 4. Foundation, budgets, roadmap

Foundation modules:
1. `GiantBody` — shared gait/footstep/landing for player and threats; footstep/land/stomp handlers take size and cause from the stimulus.
2. Stimuli: `size`/`cause` fields; kinds `roar`, `siren`, `gunfire`, `tremor`, `alarm`; Reactions fear profiles (siren = evacuate, not panic), birds, traffic yielding to sirens.
3. `src/game/threats/` — ThreatDirector, ThreatClock, ThreatActor, and a procedural **segmented creature rig** (spine chain follow-the-leader, IK legs, instanced parts like the service robots) driving Strider, Burrower, Leviathan tentacles and tripods.
4. `src/game/response/` — ResponseDirector, ForceUnit/squads with tiered simulation (abstract far away, materialized within ~600 m), road closures (blocked edges + traffic rerouting), roadblocks, staging/triage sites (parks, plazas), evacuation planner (people to metro entrances/shelters, metro lines suspended).
5. New vehicles: ambulance, fire truck, SWAT van, army truck, APC, tank (turret yaw); helicopters and jets as instanced flyers reusing drone flight/orbit code (jets on splines, no physics).
6. Soldiers, police, medics as crowd actors (outfit variants, controllers) — shared with the crime actor layer.
7. Targeting: a `threat` target kind with zone-aware frame (weak spots), "deadly" con.
8. Consequences: cause field and casualty ledger.
9. Visuals: long-range smoke columns, billboard news feed, red-alert sign art, searchlights (≤ 4 real lights).
10. Sounds: siren wail, civil-defence siren, roars, helicopter rotor, jet flyby, tank tracks, cannon, gunfire bursts, tripod horn.

Budgets (desktop): 1 large threat (2 at a climax), ≤ 64 instanced rig parts each; swarm ≤ 150 (boids at 15 Hz); ≤ 48 materialized soldiers/police on foot, ≤ 8 full rigs within 35 m (shared with crime actors); ≤ 24 military + ≤ 16 police/EMS vehicles; ≤ 4 helicopters, ≤ 2 jets; 256 tracer ribbons; ≤ 6 destruction impacts/s from response fire; debris shares the physics pool; directors ≤ 0.4 ms; whole event ≤ 2.5 ms/frame extra at the climax. Far units are abstract (map pings and horizon effects only). Detailed destruction exists only in loaded cells — threats act within loaded range or apply abstract damage when far; far ruins need a per-building "ruined" flag in the skyline later.

Roadmap:
- **Phase A — Robot malfunction** (minor, ~2 weeks): hostile controller for robots/drones/service robots, police levels 0–2, first evacuation to metro entrances, siren stimulus, cause-aware consequences, ThreatClock with omens. Tests: deterministic clock schedule, first event ≥ T; spawning → ≥ 3 police cars tasked within 20 s, siren stimulus, fleeing people.
- **Phase B — Strider from the river** (flagship, ~5–6 weeks): GiantBody refactor, segmented rig, arterial route to downtown, full ladder 0–4 with tanks, helicopters, jets, triage tent, rescues, smoke columns, billboard alerts, aftermath. Tests: route reaches downtown for 20 seeds; abstract army-vs-Strider battle deterministic, army win rate 25–55% over 50 seeds; ≥ 60% of people within 300 m flee within 15 s; level ≥ 3 within 3 min; footsteps break buildings; downed helicopter becomes a wreck; rescues give karma; climax frame time within budget.
- **Phase C — Swarm + Burrower** (~4 weeks): swarm instancing, sewer/metro use, sinkholes (lift the 16-hole limit), metro suspension.
- **Phase D — Aliens** (~6 weeks): scouts and infiltrators as omens, abduction craft, tripods with pylons, mothership climax.
- **Phase E**: Leviathan and bridges, Roc, giant mech, the player leading the army (rally, airstrikes), reconstruction.

## 5. Open questions (recommended defaults)
1. Firearms: soldiers/police use visible guns (tracers, cannon, missiles) against threats? — yes, only at threats, never at people; police non-lethal against criminals.
2. Army vs the player: a rampaging / very-low-reputation giant player triggers the same military ladder? — yes, levels 0–3 only, after a clear warning sequence.
3. Can the city "lose"? — yes, districts get levelled; damage persists per session, ruins per seed; reconstruction over game days later.
4. Monster defeat look — kaiju collapse and stay down, carted off or decaying in the aftermath; no gore (aliens/robots break apart, creatures don't bleed).
5. First major event — ~3 h of play + a karma milestone; minor events from ~45 min; omens from the first session.
6. Threats can knock the player out? — yes; wake at the field hospital, no karma penalty.
7. Alien tone — slow burn (lights, infiltrators) → overt invasion with a mothership as a late-game climax, rarer than monsters.
8. Diegetic news — pictograms and a live news-drone feed on billboards; headlines only as a short, sparse HUD ticker.

## Sources
- City of Heroes Issue 10: Invasion — https://cityofheroesrebirth.com/public/issue_10.phtml
- Paragon Wiki: Giant Monster Guide — https://archive.paragonwiki.com/wiki/Giant_Monster_Guide
- Engadget: Fried calamari (Lusca) — https://www.engadget.com/2014-05-04-one-shots-fried-calamari.html
- EDF: Insect Armageddon — https://store.steampowered.com/app/23530/Earth_Defense_Force_Insect_Armageddon/
- Cambridge PD emergency mobilization policy — https://cambridgema.gov/Departments/cambridgepolice/Publications/2020/06/711emergencymobilization
- Texarkana: Incident and Unified Command Systems — https://tx-texarkana.civicplus.com/DocumentCenter/View/2668/8112-Incident-and-Unified-Command-Systems
- Films and games (Cloverfield, Godzilla 2014/Minus One, Shin Godzilla, Pacific Rim, War of the Worlds, Rampage, Prototype, XCOM): general knowledge.
