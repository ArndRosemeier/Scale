# Scale — Conventions: use the shared helper

Many systems need the same answer: "is this underground?", "can a person stand here?", "is that
on screen?" When each system writes its own version, a fix in one place misses the others. The
Tab-targeting-in-the-sewers bug is the example: about eight systems each did their own distance
and line-of-sight checks.

**Read this before writing gameplay code.** If your code needs one of the answers below, call
the helper and don't re-derive it. If the helper doesn't fit, extend the helper. Where a
selftest guard exists (`npm test`), it fails on a stray copy. Which test command to run when: see
[Tests](#tests-which-command-when) below.

To look for new copies, use the two finders from Arnd's Toolbox. Both write reading lists, not verdicts.
`npm run dup` lists functions that share a name (`reports/duplicate-candidates.md`). `npm run repeated` lists
the same body under different names and inline snippets pasted into several files (`reports/repeated-code.md`).

The audit that started this list (v0.130) is in the project files, `code-audit/findings.md`.
Its open items are consolidated here one PR at a time.

## Space

| Question | Use | Not |
|---|---|---|
| Is someone (feet at y) underground? | `Underground.feetUnder(x, feetY, z)`. `isUnder(x, y, z)` is for a point (an eye, an orb, the camera). `Collision.underground` is the movement test (player, ragdolls, hops) and is stricter near stairs. | `isUnder(x, y + 0.5, z)` written out (**guarded**) |
| Where does something land at a target (a decal, an orb, a bomb, a stray bullet's chip)? Can someone lying there be reached? | `game.floorAt(x, feetY, z)`: the sewer, metro or cave floor when underground, else street, deck or roof | `world.groundHeight(x, z)` or `terrain.height` at a target that may be underground (it lands on the street above a sewer fight) |
| Are two bodies on the same side of the street (both underground or both up top)? | `Underground.sameSide(ax, ay, az, bx, by, bz)` with **feet** heights. A blow, blast or footfall point counts as feet. | `Math.abs(dy) < r`, `s.y > a.y - 2`, or a 2D `hypot` alone |
| Does a blow, blast, stomp or shove reach a person? | 2D/3D range **and** `sameSide`. `Reactions.sameSide` is wired to it. | Range alone. A street stomp must not floor the sewer crew below. |
| Does a blow reach the player? | `PlayerHealth.damage(…, x, z, y)` with the source's real height (the type requires it). It refuses blows from the other side. | Writing `hp`. Passing the player's own `y` as the source height. |
| Where may the third-person camera go (tunnels, stairwells, rooms, streets)? | `CameraRig.solidAt` (wired in `Game`); in the tunnels it asks `Underground.cameraFree`. Tunnel meshes are mitered at turns (`sideAt` in `Underground.ts`) so the drawn walls never sit inside that volume; `npx tsx tools/camsweep.ts` checks it. | A camera clamp or boom test of your own |
| How high is the ground someone stands on? | `world.groundHeight` (roofs, decks, landmarks too) or the player's `collision.groundAt`; street level alone: `terrain.height + world.surfaceOffset`. It follows what is drawn: road 0, kerb `CURB_H`, open countryside `-TERRAIN_DROP` (the terrain mesh sits lower), country roads and yards 0. | Bare `terrain.height` for feet: out of town that floats 0.35 m above the grass |
| Can the camera see a person (markers, tags)? | `makeSight` (`game/sightline.ts`) via `render/screen.ts` `setSight` | A raycast of your own |
| Where on screen is a world point? | `render/screen.ts` `toScreen` / `screenPoint` | `.project(cam…)` (**guarded**: the selftest fails on it anywhere else) |
| Can someone shoot or see from A to B? | `game.sight.clear` (`game/combat/sight.ts`: caves, tunnels, buildings, landmarks, cars, facade holes). For a `Target`: `targeting.sees(from, t, centre)` (pads by `targeting.padOf(t)`, the target car never blocks). | `world.raycast` with your own tolerances (**guarded**) |

## Interiors

| Need | Use | Not |
|---|---|---|
| Put furniture into a room (any outline) | a theme's `Item` list given to `new Filler(roomArea(…), rng).fill(items)` (`interior/fill/`, see `docs/INTERIORS_PLAN.md`): it keeps doorways, stairs and walkways free and checks the outline | Fixed offsets in the room's box (`add('sofa', um, ext + …)`): pieces end up in doorways, facing walls, in front of windows |

## The ledger and blame

| Question | Use | Not |
|---|---|---|
| The player knocked someone down | `reactions.knockDown(a, …, 'player')`. It books the `body` entry **with the victim** through `CrimeSystem`. | An extra `consequences.record(…, 'person', 'knockdown', x, z)` without a ref. Justice can't tell a mugger from a bystander, and the threat clock counts it twice. |
| The player's blow hits a car (punch, shockwave, dash) | `Game.hitCar`: a wreck or a dent, booked on the ledger with the car | `wreckIt` + `makeWreck` or a dent with no ledger entry (wrecking a police car with a punch used to cost nothing) |
| Add damage to a car | `dentCar(v, amount, cap?)` (`sim/Traffic.ts`; never lowers it) | `v.damage = Math.min(…)` by hand (**guarded**) |
| Reward a good deed (karma, reputation, a stat, cheers) | `g.crime.reward({ karma, why, rep, news, stopped?, count?, atone? })`. `stopped: true` for anything that ends a crime, den, monster or event: counted as stopped, police cool off, people cheer. | `rep.add` + `rep.count` + `cheer()` by hand (**guarded**; the old copies each forgot a different part) |
| Karma only (a weak-spot hit, a power core) | `Progress.addKarma` (it already ignores the sandbox) | Your own `sandbox` check in front of it |
| Who did it (cause) | One vocabulary, `Cause` in `game/Stimuli.ts` (`HarmCause` is the same type; `DamageCause` adds `'fire'`). Cross into a knock-down's `DownCause` with `downCauseOf(cause)` and from a broken building to the ledger with `harmCauseOf(cause)` (`shared/cause.ts`). | An inline `cause === 'threat' ? 'threat' : … 'player'` (**guarded**: police and army stomps used to land on the hero) |

## People

| Need | Use | Not |
|---|---|---|
| The nearest person who … | `peds.nearest(x, z, r, (a, d) => …)` (`sim/Pedestrians.ts`) | A `let best = null, bd = r; for (… neighbours …)` loop (**guarded**) |
| Is this person up and about / an ordinary passer-by / an officer still standing? | `isUp(a)`, `isBystander(a)`, `hasRole(a, 'police', …)` | `a.alive && !a.inside && a.state !== PState.Down …` written out (the copies each forgot a different part), or `a.state === 5` |

## Time

| Need | Use | Not |
|---|---|---|
| Do something in a few seconds (a delayed boom, a second burst, a bark) | `g.later.after(seconds, fn)` (`core/later.ts`, ticked with simulation time) | `setTimeout` in `src/game` (**guarded**; UI, loading, intro and autosave may) |

## Crimes

| Need | Use | Not |
|---|---|---|
| A crook decides again after a blow: fight, flee or surrender | `this.rethink(c, pick?)` in `game/crime/Crime.ts` (sets `memo.choice` 0/1/2, announces a fight; `pick` holds the crime's own rule) | A local `if (act.memo.decHp !== act.hp) { … }` block (**guarded**) |
| Then the usual follow-through | `this.actOnChoice(c, dt, reach?)`: give up, fight within `reach`, or run | Copying the three lines |

## Factions

| Need | Use | Not |
|---|---|---|
| Is one side hostile to another (the hero, a villain group, police, Murk, monsters …)? | `game/factions/relations.ts`: `g.relations.get(a, b)` (a number, −100 … 100) / `.hostile(a, b)`; `factionOf(target, world)` / `actorFaction(actor)` in `game/friendFoe.ts` say which faction something belongs to | A new `role === …` / `rivals.includes(…)` rule of your own |
| A faction's feeling about the hero | `g.relations.get(f, 'hero')`: bound live (`bindHero`) to the system that keeps it (civilians: reputation; police: wanted/suspect; army: a rampage; villain groups: notoriety; Lumen: trust; Wardens: regard). `dev.factions()` shows them | A second standing number |
| Two villain groups at war | `hostileGroups(F, a, b)` in `game/factions/Factions.ts` | Comparing archetype `rivals` lists |
| Change how two villain groups feel about each other | `feud(R, a, b, d)` (both ways); the hourly drift is `driftGroups` (CrimeSystem.groupHours); saved by `saveGroupRelations` | `R.set` on one direction only, or a flag of your own |
| Should someone run from a threat? | `menaceNear(R, from, x, y, z, threats, sameSide?)` + `scatterReach(height)` in `game/factions/relations.ts` (crimes: `CrimeWorld.menace`, the crew scatters in `Crime.lookRound`) | A distance check of your own against `threats.actors()` |

## Threats

| Need | Use | Not |
|---|---|---|
| A monster's anger (who hurt it most) | `game/threats/aggro.ts`: `bookAggro`, `decayAggro(m, dt, tau)`, `topAggro(m, min?)` | `aggro.set(…)` and a decay loop by hand (**guarded**) |
| Did the hero earn the win against a big monster? | `heroEarned(aggro, share = 0.25)`: angriest with the hero, or a quarter of all its anger | Your own share or HP threshold (Strider and the last-resort strike used to disagree) |
| Who brought a machine down? | `lastHitBy(lastBy, lastT, now, window = 6)` | `now - lastT < 6` written out |
| Damage through a zone's armour and weak spot | `zoneDealt(amount, armour, weak, weakMul, weakArmour?)` | `amount * (1 - armour) * (weak ? …)` by hand (**guarded**) |

## Small helpers

| Need | Use | Not |
|---|---|---|
| clamp, 0..1 clamp, lerp, smoothstep | `core/math.ts`: `clamp`, `saturate`, `lerp`, `smoothstep` (import with an alias such as `saturate as clamp01` or `smoothstep as smooth` if the short name reads better) | A local `const clamp = …` (**guarded**) |
| An sRGB colour as linear | `srgbColor([r, g, b])` from `render/color.ts` (a `THREE.Color`), or `srgbToLinear(c)` from `core/math.ts` for one channel | A local `lin` / `srgbToLin`, or the 0.04045 curve typed out (**guarded**; GLSL/TSL shaders keep their own) |
| Random numbers in game code | `Rng` from `core/rng.ts` (`new Rng(seed)`, `Rng.from(...)`, `deriveSeed`); saved state rolls from a seed, never `Math.random` | A hand-rolled `seed * 1103515245` LCG (the float product loses bits and the sequence decays; **guarded**) |
| Text into HTML | `esc` from `ui/esc.ts` (escapes `& < > " '`) | A local `esc` (the six old copies escaped different sets; **guarded**) |
| Polygon or polyline maths (area, bounds, point in polygon, distance to the outline, length, reverse, rectangularity) | `core/geom2.ts`: `polyArea`, `polyBounds`, `pointInPoly`, `distPointPolyEdge`, `polylineLength` (`stride` 3 for x,z,extra routes), `reversePoly`, `rectangularity` | A local `polyBox`, `routeLength`, `reversed`, … (**guarded by body, not name**) |
| Angle difference, turning toward an angle, 3D vector basics | `core/math.ts`: `angleDiff(from, to)` (= to − from, wrapped to ±π), `lerpAngle`, `v3add`, `v3sub`, `v3scale`, `v3madd`, `v3dot`, `v3cross`, `v3len`, `v3norm`, `v3lerp` (alias them to short names if you like) | A local `angDiff` / `turn` / `norm` / `cross` (**guarded by body**; a typed-out cross product is **guarded** too) |
| Find more copies | `npm run dup`, `npm run repeated` | |

## Tests: which command when

The self test (`tools/selftest.ts`) is a list of independent sections; `tools/testHarness.ts` runs them.

| When | Run | Takes (4 cores) |
|---|---|---|
| While working on a change, after each edit | `npm run test:quick`: only the sections that import (through any chain) a file changed against `origin/main`, committed or not, plus the source-tree guards and any section whose own lines changed. A change to the harness, the selftest's shared helpers or `package.json` runs everything. | seconds to ~2 min |
| A few named sections | `npm test -- --only sewer,deep` (name contains a word; `npm test -- --list` shows the names) | |
| **Before merging any PR** (after merging `main` into it) | the full `npm test`: every section, spread over one worker per core | ~3 min (was ~17 min) |
| A section seems to depend on another one | `npm test -- --serial` (one process, file order, as before v0.153) | ~10 min |

Rules for tests:

- **Never skip, disable or shorten a check to save time.** Make the code under test faster instead, or split a slow section.
- Each top-level block is `section('short name', async () => { … })` (a `check()` outside a section fails the run) and stands alone: it builds its own cities and state and never reads another section's variables. Sections run in any order and in any process.
- Put shared helpers (pure functions) above the first section; a change there makes `test:quick` run everything.
- A section that reads files itself (`readFileSync`, `readdirSync`, …) always runs in `test:quick`, so keep these guards cheap.
- The slowest sections start first, by the times of the last full run (`.cache/selftest-times.json`; the baseline is `tools/selftest-times.json`, rewritten with `npm test -- --save-times`).

## Shaders

Every GLSL shader has a TSL twin in `src/render/webgpu/` (see `docs/WEBGPU_PORTING.md`). If you
change one, change the other. The twin's header comment names the GLSL file it mirrors.

Bone indices (`skinIndex`) are made with `skinIndexAttribute` (`src/render/skinIndex.ts`): floats on
WebGL. Any vertex input the shader declares as float but that is fed integers makes ANGLE on Windows
compile a second shader variant at the first draw (seconds, no three.js program shows it).
