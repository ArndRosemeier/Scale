# Scale — Playground plan: crimes, superpowers, villains, monsters

Brainstorm and phased roadmap (2026-10-03). Status: decisions taken (§0); details below are the original brainstorm, superseded where §0 differs.

## 0. Decisions (user, 2026-10-03)

1. **Tone** — playful-heroic, grounded stakes (as proposed).
2. **Violence** — more realistic than proposed, think *City of Heroes*: real fights and injuries, a good **ragdoll** system (people and the player get knocked flying, tumble, get up — or stay down), no blood/gore.
3. **Player harm** — yes. The character **starts weak and gets stronger** over time (progression system TBD; powers are all available for now but their strength scales with progression later).
4. **Reputation** — yes, it is a real system.
5. **Police** — real consequences for crimes the player commits (pursuit, arrest), and a way to **atone** (e.g. turn yourself in / community service / heroic acts that clear heat — to be designed).
6. **Crime frequency** — like real life and **district-based**: some districts are poorer and more crime-ridden (a deterministic crime/poverty index per district/cell), shown on a **crime map layer** in the map view.
7. **Persistence** — per seed, reputation and stats (as proposed).
8. **Offscreen crime** — not simulated; later supervillains may cause city-wide effects, not from the start.
9. **Game modes** — *Normal*: start as an ordinary person (no flight, no size change, weak punch). *Sandbox*: all powers unlocked at full rank and freely assignable.
10. **Progression = karma** — good deeds earn karma, spent freely on unlocking and ranking any power. Special loot (power cores etc.) gives other, optional effects. "Get better by playing the game as it's meant to be played."
11. **Cheeky small deeds** alongside crime — e.g. get a cat down from a tree, catch a runaway dog, return a dropped wallet, help someone up, push a stalled car, rescue a balloon/kite, carry shopping. Light, funny, seeded in the city and noticed in the world (meowing, a worried owner pointing), each worth a little karma.
12. **Crime fighting is viable without powers** — an ordinary person can tackle/punch a lone criminal (pickpocket, purse snatcher); groups, armed robbers and villains need powers or tactics.
13. **Consideration ("con") system** — the player can assess a target's threat relative to themselves (EverQuest/City-of-Heroes style): colour-coded threat (trivial … deadly) from the target's level/strength/powers/group size vs. the player's current strength and size, shown on the target frame and as a subtle marker tint.
14. **Tab targeting** — Tab cycles through nearby targets in view (hostiles first, then people of interest), with a target frame (name/role, con colour, health); soft-lock for punches/abilities.
15. **No chat, no quests (for now)** — the world tells its stories: show, don't tell. Situations are readable from behaviour, sound and staging (a crowd backing off, someone pointing, a siren, a cat meowing in a tree), not from dialogue or quest logs. Only minimal hints for controls.
    - Amended (2026-10-04): **barks** are allowed — sparse speech bubbles with short situational outbursts ("Help! Thief!", "Stop! Police!", "Thanks!", a bit of small talk), never dialogue, instructions or quest text (`src/ui/Barks.ts`).
16. **Near-future setting** — the city is a believable near future, not cyberpunk kitsch: sidewalk delivery robots, quadcopter drones (deliveries, news, police), autonomous shuttles/taxis among the cars, holographic/animated billboards and shop signs, EV chargers, maintenance and cleaning robots, a few humanoid service robots. Robots are part of the living world (they react, get knocked over, can be helped or broken — destructible like everything else) and later part of the threat ladder (malfunctioning/hacked robots → robot gangs → a villain's robot army → giant mechs as kaiju alternatives).
17. **Power roster (2026-10-03)** — elemental: laser eyes, frost nova, ice path, fire wave, chain lightning, seismic stomp, whirlwind/gust, hydrokinesis (conjured water — never tied to hydrants or other map features: nobody levels a power that only works in special places); movement: flight and one super-speed power (faster than flight) — no overlapping movement powers (no glide, no rocket boots, no separate dash/teleport variants beyond what exists); support: shrink ray. Not now: EMP, mind powers (too easy), other support powers.
18. **Targeting rule for all powers** — every power works on every kind of target (people, criminals, cars, robots, drones, props, buildings); with a target selected it goes for the target, with none it goes out in front (aim direction). Area effects hit everything in the area, bystanders and cars included — careless use near crowds has consequences (collateral ledger, reputation, karma).
19. **Threats & city response** follow docs/THREATS_PLAN.md (monsters, aliens, rogue tech; police → SWAT/EMS → National Guard → army & air). Its §5 defaults are accepted, with these changes:
    - **No player levels** — progression is karma only (decision 10). Strength thresholds may exist internally for con/pacing but are never shown as "levels".
    - **Army vs the player: yes, without a cap** — a rampaging, low-reputation player gets the full response ladder (after a clear warning sequence).
    - **The city can lose — realistic.** Districts get levelled. If conventional forces can't stop a monster, the army gets desperate and prepares a **small tactical nuke**: a visible, diegetic countdown (evacuation sirens, convoys leaving, the strike announced on billboards) that the player can beat by defeating or driving off the threat in time. Replaces the "bomb a block" last resort as the top of the ladder.
    - **Defeated monsters** collapse without gore and the carcass stays in the city for quite a while (a landmark, cordoned, crowds gawking); then city officials have it removed (cleanup crews, cranes, trucks carting pieces away) until it's gone.

Status (2026-10-03): decisions 17 and 18 are implemented — see ARCHITECTURE.md, "Powers".
Status (2026-10-03): Phase 1 "Street Hero" crime layer (crime index and map layer, director, snatch / mugging / street-side robbery, actors, combat, player health, police, wanted and atonement, reputation, con, three small deeds) is implemented — see ARCHITECTURE.md, "Street crime".

## 1. Vision

**The city is a stage and the player decides whether they are its hero or its disaster.** Crimes and threats are generated from the living simulation (real citizens on real routes, real shops at real hours) and play out with the systems we already have: screams propagate as stimuli, crowds flee/film, cars swerve, buildings crumble.

Core loop: **Notice** (screams, alarms, sirens, map pings, super hearing) → **Respond** (run, fly, swing, blink, or grow huge and stride over blocks) → **Resolve** (catch, knock out, disable car, rescue, defeat) → **Consequence** (crowd cheers or flees, news ticker, collateral counted, police treat you as ally or threat).

Scale is the twist: a giant arrives in seconds but crushes cars and people on the way; a 0.3 m hero can sneak into a hostage scene unseen. Every ability is tuned against size; the hero-vs-menace question falls out naturally.

## 2. Crime system

### 2.1 Generation (deterministic sites, dynamic outcomes)

`CrimeDirector` (`src/game/crime/CrimeDirector.ts`) ticks every ~4 s game time over a ring 120–450 m around the player (never on top of the player). Candidates: shopfronts (robberies), parked cars (car theft), busy sidewalks (snatches), "banks" (civic/office in downtown/commercial cells, deterministic tag from `hash(seed, cell, b)`). Crime seeds: `deriveSeed(seed, 'crime', day, slot, cell)` — same seed + day + hour reproduce the same "crime weather"; outcomes are live.

| Factor | Effect |
|---|---|
| District | downtown/commercial: robbery, snatch; port/industrial: gangs, car theft; residential: burglary, vandalism |
| Hour | night ×2.5 muggings, gangs, arson; day: snatches, bank heists |
| Density | snatch needs ≥ 6 peds within 30 m; mugging prefers ≤ 2 (quiet street) |
| Heat / chaos | raises tier and concurrency (1 → 3 crimes → city-wide event) |
| Pacing | cooldown after resolution; escalate at most one tier above recent successes |

Actors from the population: the victim and witnesses are real nearby `PedAgent`s; the criminal is a synthetic citizen spawned out of view or a converted walker.

### 2.2 Crime tiers

| Tier | Crime | Plays out | Getaway | Resolve | Failure |
|---|---|---|---|---|---|
| 1 | Purse snatch / pickpocket | thief bumps victim, victim staggers + "cry" stimulus | sprints a sidewalk route away, cuts through alleys | tackle/punch → KO; return the bag → cheer | thief gone after 60 s or 250 m |
| 1 | Mugging | 1–2 criminals corner a victim (cower, hands up) | flee on foot when the hero is near | KO both | victim injured (ambulance) |
| 1 | Vandalism / arson | smash/spray a shop window (glass panel impact), molotov later | walks away | catch before fire spreads | fire spreads (Phase 2) |
| 2 | Car theft | criminal takes a parked car → live getaway vehicle | ignores signals, faster, weaves | disable (strike below wreck threshold stalls it), lift/block; criminal bails → foot chase | map edge or 600 m lead |
| 2 | Shop robbery | 1–3 robbers inside, alarm, hostages kneel | exit to a waiting car | KO inside (x-ray helps) or catch the car | shop looted (news) |
| 2 | Gang fight | 2 groups of 4–8 brawl, bystanders flee | scatter when police arrive | KO all or scare off (giant presence) | spills into traffic |
| 3 | Bank heist | entry → vault (they blow a wall) → 2 getaway cars + decoy | cars split; one dives into the metro and boards a train | stop both, chase into the metro | money gone, heat up |
| 3 | Hostage situation | criminal holds a hostage, police cordon, timer | — | stealth: shrink, sneak, KO without panic; brute force risks the hostage | hostage hurt |
| 4 | Supervillain | boss actor with 2–3 powers (same ability framework) | flies/jumps over roofs | boss phases, weak-spot windows | damage, villain escapes and recurs |
| 5 | Kaiju | scaled giant creature on player giant physics, walks a route through districts | — | defeat or lure to sea/river | district levelled; evacuation success/failure |

### 2.3 Actor layer

Optional fields on `PedAgent`: `role`, `ctl` (controller), `hp`, `koT`, `action`. With `ctl` set, `Pedestrians.step()` delegates to `ctl.step(a, dt)` but keeps physics, ground and avoidance. New states: Fight, Cower, Run (chase/escape with replanning), Grab (hostage), Surrender, Arrested, KO (20–60 s, groggy get-up), EnterCar. Criminal FSM: Approach → Commit → Escape → (Fight if cornered / Surrender if outmatched) → KO / Arrested.

### 2.4 Police and services

- Patrol cars already exist (`VKind 'police'`, flasher when afraid): add `Vehicle.task {respond, x, z}`, siren loop + `siren` stimulus so traffic yields.
- Foot cops spawn from the car, chase, cuff KO'd criminals (an arrest finishes the crime).
- Roadblocks (Phase 2), helicopter with searchlight (Phase 3).
- Ambulance and fire truck: paramedics kneel by downed peds and revive them — "injured, not dead" stays readable.

### 2.5 Perception

New stimuli: `cry`, `alarm`, `siren`, `fire` (`gunshot` only if violence allows). Witnesses gawk/film/flee and point at the criminal. Markers on map + minimap, a world chevron over the criminal within 80 m, edge-of-screen arrow. Radio line in the hint system ("Purse snatching, Rue X, suspect on foot heading north"), news ticker. New sounds via the local Stable Audio tool: siren, alarm bell, "help!" voices, cuffs, whoosh/charge/beam loops, freeze crackle, kaiju roar.

### 2.6 Consequences

- Collateral ledger (`src/game/Consequences.ts`) attributes every player-caused strike, stomp, wall smash, blast, crush and wreck.
- No gore, no deaths by default: peds downed by the player are injured (paramedics revive), giant crushes become "trapped" (rescuable).
- Reputation (−100 and up; open-ended since v0.123): + resolved crimes, rescues, villains; − hurt bystanders, wrecked civilian cars, collapsed occupied buildings. High rep: crowds cheer and film closer; low rep: they flee even from a normal-size player.
- Police stance: allies by default; "wanted" mode (comedic, low stakes) after attacking cops or at very low reputation.
- City chaos meter (destroyed elements, wrecks, collapses; slow decay) drives the director (looters during collapses) and the ticker.

## 3. Superpowers

Input: digits 1–8 select the active power (hotbar), right mouse uses it (tap/hold/aim), hold R opens a radial wheel in slow-mo, G grab/throw, V/X vision modes; LMB punch, F flight and size keys unchanged. Effort: S ≤ 2 days, M ≈ 1 week, L ≥ 2 weeks.

**Movement**

| Power | Mechanic | Reuses | Effort | Risks |
|---|---|---|---|---|
| Super speed | ×6 run, slow-mo feel; shove peds aside | speed scaling, flight streaks, `props.shove` | M | tunnelling (substep collision) |
| Super jump | hold Space to charge, arc to rooftops; landing crater | `land` → stomp impact | S | roof overload (intended) |
| Dash / blink | burst or raycast teleport | collision push-out | S | ending inside geometry |
| Wall run / climb | sprinting into a facade sticks and climbs | `blocked` normal | M | needs a climb animation |
| Grapple / web swing | raycast to facade, analytic pendulum, line breaks with the element | raycast, element state | M–L | camera feel |
| Glide | slow fall with forward speed | flight code | S | — |

**Combat**

| Power | Mechanic | Reuses | Effort | Risks |
|---|---|---|---|---|
| Grab / throw | pick up cars, props, KO'd criminals; throw with velocity → impact | `makeWreck`, `props.hit`, pickup/throw actions | M | throwing civilians (allowed, counts as collateral) |
| Ground pound | airborne dive → radial shockwave, knockdowns, dust | `land`, `strike` | S | crowd griefing (rep cost) |
| Sonic clap | cone impulse: people/cars over, only glass breaks | sonic stimulus | S | — |
| Heat vision | held beam, cumulative small impacts, fire stimulus, scorch | raycast, `destruction.impact` | M | impact spam (10 Hz cap) |
| Freeze breath | cone: peds frozen 8 s, cars stop, fires out | crowd tint | M | shader variants |
| Energy blast | projectile → scaled blast | blast | S | — |
| Telekinesis | lift props/wrecks/debris into orbit, fling | debris pool, props as bodies | L | physics budget (cap 40) |

**Defense and utility**: invulnerability toggle (S), shield bubble protecting victims (S), time slow — sim/physics/audio slowed, player not (M), super hearing — ×5 range for crime stimuli, directional rings and pings (S), x-ray/detective vision — ghosted buildings, criminals red, hostages blue (M), size powers (exist; add a grow-stomp-shrink combo).

Cross-cutting: charge/release VFX, energy pool with cooldowns, per-power sounds. Misuse goes through the collateral ledger — a game consequence, not a hard block.

## 4. Foundation (build first)

1. **Director + mission framework** (`src/game/crime/`): `CrimeDirector`, `Crime` base FSM (`phase`, `actors`, `markers`, `onResolve/onFail`, `update`), one file per crime, serializable state for tests.
2. **Actor layer** extending `Pedestrians` (controllers in `src/sim/actors/`); `CrowdRenderer` gives actors priority rigs within 60 m (own budget of 8) and passes their actions to the animator; actors don't despawn while their crime runs.
3. **Combat model** (`src/game/Combat.ts`): `hitActor(a, impulse, kind)` → stagger / KO / injured, scaled by size (a giant's flick KOs anyone, a tiny hero needs many hits); `Game.strike()` routes through it; optional player HP.
4. **Targeting**: soft lock on the nearest hostile in the view cone, punch auto-steers, Tab cycles.
5. **Ability framework** (`src/game/abilities/`): `Ability {id, slot, energyCost, cooldown, mode, start/update/end}`, `AbilitySystem` for energy, input, animation hook. Actor-agnostic so villains can use the same powers.
6. **HUD**: energy, (HP), hotbar, objective line, reputation and chaos chips, ticker; `GameMap.addMarker()`; world chevrons.
7. **Persistence** (later): per-seed reputation/stats in localStorage behind one `Progress` object.
8. **Budgets**: ≤ 3 active crimes, ≤ 40 actors, ≤ 8 actor rigs, ≤ 40 thrown bodies, heat vision ≤ 10 impacts/s, director ≤ 0.3 ms.
9. **Determinism**: generation seeded and testable in `selftest.ts`; crime FSMs use crime-local RNG.

## 5. Roadmap

**Phase 1 — "Street Hero" (first playable, ~3–4 weeks)**: foundation 1–6 (minimal); purse snatch, mugging, street-side shop robbery; police response (flasher, siren, foot cops arresting); powers: super jump, dash, ground pound, grab/throw (props, KO'd peds), super hearing, sonic clap; HUD with energy, hotbar, objective, map pings, radio line; simple reputation with cheering crowds.
Tests: headless — director reproduces the crime list for seed/day; snatch FSM runs Escape → KO → Arrested with scripted dt. Headless browser — spawn a snatch: marker, scream within 2 s, nearest police car tasked; resolve it: state resolved, rep up; ground pound in a crowd: ≥ 1 ped down and counted. Perf: 3 active crimes add < 1 ms per frame.

**Phase 2 — Vehicles and heists (~4 weeks)**: car theft and getaway chases, roadblocks, ambulance and fire truck, gang fights, robberies inside interiors, arson with element-by-element fire spread, bank heist with vault blast and metro escape; powers: super speed, wall run, grapple swing, heat vision, freeze breath, shield, x-ray, car throwing; news ticker and chaos meter.

**Phase 3 — Supervillains (~4–5 weeks)**: villain actors using the shared ability framework, full rig, size, HP bar; archetypes Brute (grows to 8 m, throws cars, ground pounds), Speedster (dash/blink, robs shops in sequence), Elementalist (heat beam, freeze, flight); boss phases, recurring named villains, helicopter, city alert, hostage situations with the shrink-stealth solution; telekinesis and time slow for the player.

**Phase 4 — Kaiju and city-wide events (~5+ weeks)**: a kaiju on player giant physics (stomps, wall smashing, tail swipe, roar) walking arterials from the water toward downtown; city-wide alert, evacuation (peds flee to metro stations/shelters, traffic abandons the corridor); scoring (lives saved, buildings lost); player grows to 100 m to wrestle it or lures it into the water; rubble persists.

## 6. Open questions (recommended defaults)

1. **Tone** — playful-heroic (Spider-Man / Incredibles), comedic touches, grounded stakes.
2. **Violence** — no guns, no blood, no deaths; knives/bats at most; KO/injured, paramedics revive; giant crushes = trapped/injured.
3. **Player harm** — HP exists, invulnerable by default in Phases 1–2; villains can knock you down from Phase 3 (respawn in place).
4. **Reputation affects the world** — yes (crowd cheer vs. flee, police attitude); never blocks powers.
5. **Police vs. player** — allies by default; light "wanted" mode only after attacking cops / very low rep, decays fast.
6. **Crime frequency** — about one street crime every 60–120 s near the player; setting off / calm / normal / chaos.
7. **Persistence** — per seed, reputation and stats only, from Phase 2; city damage stays per session.
8. **Offscreen crime** — not simulated; the ticker invents distant headlines from the seeded crime weather.
