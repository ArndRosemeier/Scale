# Scale — Architecture

Browser city: TypeScript, three.js (WebGL2), Rapier (debris physics), Vite. Units are
meters, Y is up, and the city is centred on the world origin.

## Guiding principles

1. **Everything derives from `(seed, settings)`** via path-keyed hashing (`core/rng.ts`
   `deriveSeed(seed, 'cell', id, 'lot', k)`). Any part can be regenerated in isolation, in
   any worker, and comes out identical.
2. **Plan → mesh → simulate** are separate layers with compact typed-array data between them.
   The plan is pure data (no three.js) and runs in workers and in headless tests.
3. **Hierarchy everywhere:** macro plan (whole city, fast) → cells (streaming units) →
   buildings → elements (destruction units).
4. **Cost scales with what you look at**, not with city size: LOD for geometry, agents,
   physics and audio.
5. **World-ready:** terrain and water are global functions of world coordinates. A city is
   a `Settlement` placed into a `World`, so more cities and countryside can be added later
   without rewriting the city code.

## Layers

```
World (seed)                     src/world/      terrain height, water (river, sea), biome
 └─ CityPlan (macro)             src/plan/macro  centres, districts, arterial graph, river crossings,
 │                                               metro lines, sewer trunks
 └─ Cell (face of arterial graph)src/plan/cell   local streets (recursive block subdivision by
     │                                           district pattern), blocks, lots, buildings,
     │                                           props, parks
     └─ Building descriptor      src/plan/building  footprint polygon, style, floors, facade grammar
         └─ Elements             src/build/      wall bays, slabs, columns, glass, roof pieces
```

### World & terrain (`src/world`)
* `height(x,z)`: regional slope plus hills (seed decides flat vs hilly), river valley carving,
  coastline falloff to the sea floor, and road and lot grading applied by the plan.
* River: a meandering polyline crossing the map, with width growing downstream. Banks are
  quays in the core and natural elsewhere.
* Sea: optional (≈45% of seeds), as one side of the map.

### Macro plan (`src/plan/macro.ts`)
* Centres: the main centre plus sub-centres (boroughs) for larger cities.
* District field: downtown, commercial, old town, residential (dense/row/suburban),
  industrial, port, parks. Sampled from centre distance, noise and water.
* Arterial graph: Poisson nodes (denser near centres) → Delaunay → Gabriel/RNG filter →
  terrain-aware curved edges. River crossings are limited to bridge sites; ring and radial
  bias around centres.
* Cells: the faces of the arterial graph. Each one is the streaming and generation unit.
* Metro (larger cities): lines through centres, with stations every 0.8–1.2 km.
* Sewers: trunks under the arterials, with outfalls into the river or sea.

### Cell plan (`src/plan/cell.ts`)
* The district pattern picks the subdivision grammar:
  * grid: aligned or rotated parallel cuts in both directions
  * organic old town: jittered recursive splits with varying angles
  * suburban: curved cuts and loops
  * industrial: large blocks
  * park: paths only
* Cuts become streets. The final polygons, inset by street half-width plus sidewalk, become blocks.
* Lots: recursive OBB splits, keeping only lots with street frontage.
* Buildings: footprint is the lot inset by a district setback. The style is chosen per
  district and era.
* Output is a compact `CellData` (typed arrays plus small JSON), transferable.

### Building generation (`src/build`)
Buildings are made of **elements**:
* per floor × facade bay: a wall panel (with window or door opening), glass, frame/sill/ornament
* per floor: slab pieces and corner columns
* roof pieces

Every vertex carries `aElem` (the element index within its cell mesh). A per-cell
`DataTexture` holds element state (alive or broken). The shader collapses dead elements in
the vertex stage, so destroying something never re-uploads geometry.

Styles (facade grammar plus roof plus massing):
* rowhouse/brownstone
* tenement brick with fire escapes
* Haussmann stone with mansard
* old-town timber-frame
* art deco tower
* glass curtain-wall office
* brutalist concrete
* modern residential with balconies
* suburban detached house (gable or hip)
* warehouse/factory (saw-tooth roof)
* church
* small shop/pavilion
* parking garage
* gas station

### Rendering
* `CellMesh` LOD0 (full elements), LOD1 (extruded shells with the facade texture, no
  ornament) and LOD2 (merged massing with a procedural window shader) for the far skyline.
* Materials use `DataArrayTexture` atlases of procedural PBR textures (brick types, stone,
  stucco, concrete, glass, asphalt, paving, roof tiles, metal, wood). One shader per surface
  family, layer per vertex.
* Interior mapping on windows of non-entered buildings; lit windows at night.
* Lighting:
  * sun and sky (physical sky), cascaded shadows near the player
  * hemisphere, environment probe
  * fog and aerial perspective, day/night cycle
  * street lamps as emissive plus a few real lights near the player
* Post-processing: AgX tone mapping, bloom, SSAO (GTAO), SMAA.
* Depth: reversed-Z (fallback: logarithmic depth), so a 10 cm player and a 30 km horizon coexist.

### Streaming (`src/stream`)
* Worker pool: plan jobs for every cell run in the background (nearest first). Mesh jobs
  run per cell and LOD by priority, which is distance and frustum.
* Damage state per cell (element bitset, rubble list) survives eviction.

### Destruction (`src/destruction`)
* Hit query: spatial hash of elements per cell, with no linear scans.
* Element break:
  1. mark the element dead
  2. spawn debris from pre-fractured convex templates (Voronoi cells of a unit box) scaled to
     the element; up to N rigid bodies in a Rapier ring pool (≤ 350 at once, ≤ 24 new a frame and
     on average ≤ 40 a second — a token bucket of 60 — so a monster breaking panel after panel
     does not keep the pool full of tumbling hulls)
  3. the excess becomes GPU-only particles; dust uses sprites
  * instanced fragments and chips upload only the instance range that changed this frame
* Physics ground: heightfield patches (96 m, 49² samples of terrain, kerbs, bridges and roofs;
  20–50 ms each near the river) are made on demand; `Physics.prefetchGround` (a monster
  walking: 40 m ahead, 90 m round) samples them in the background, a column at a time within
  0.6 ms a frame, so debris and wrecks find their ground ready (one needed early is finished on
  the spot). `WorldIndex.surfaceOffset` (kerbs) rejects carriageway shapes and holes by bounds
  before point-in-polygon.
* Structure: element grid with support rules.
  * Floor *f* fails if its supporting elements below drop under a threshold or one side is
    gone.
  * The part above becomes a rigid **chunk**: geometry sliced from the cell mesh plus a box
    collider. It topples or pancakes depending on asymmetry, shatters on impact into debris,
    and leaves rubble.
* Settled debris freezes into static instanced rubble, so the physics cost stays bounded.
* Other destructibles:
  * cars: vertex dents, crush, wheels off
  * trees: break and fall
  * lamps and signs: bend or topple
  * roads: crack decals and craters
  * people and the player: physical ragdolls (see Ragdolls)

### Ragdolls (`src/physics/ragdoll`)
People and the player knocked flying, tumbling, lying, getting up — or staying down.
* `skeleton.ts`: 14 parts (pelvis, abdomen, chest, head, upper/fore arms, thighs, shins,
  feet) mapped onto the MakeHuman bones, shapes sized from the rig's rest bone heads (or a
  default 1.76 m plan for crowd people without a rig), mass shares, joint limits (ball joints
  with per-axis limits for spine, neck, shoulders, hips, ankles; limited hinges for elbows and
  knees) and a relaxed pose. Body frames are the rig's model axes at rest (rest bones carry no
  rotation), so a body's rotation is its driver bone's world rotation.
* `Ragdoll.ts`: the Rapier bodies and joints (`GROUPS.ragdoll` / `ragdollArm`: exact local
  ground and building prisms from `future/ground.ts`, debris, robots, each other; arms skip
  other ragdoll parts); joint motors give friction and a faint muscle tone; sizes 0.1–100 m
  (mass ∝ k³, damping rates ∝ 1/√k).
* `drive.ts`: seeds bodies from the animated pose; writes bodies back as bone rotations and
  the root position, blended over the animation (no pops; copes with throttled animators).
* `getup.ts`: procedural get-up key poses (from the back: elbows → sit → squat → stand; face
  down: push-up → all fours → kneel → stand) through `Animator.override`.
* `RagdollSystem.ts` (`game.ragdolls`): `knockout(target, { impulse, point, velocity,
  stayDown, lie, source })`, `isActive`, `getUp`, `release`, `onSettled`, `onGotUp`. Every
  knock-down of a person within 45 m of the camera (Down with a fresh fling velocity, i.e.
  `Reactions.knockDown` and all powers, strikes, cars built on it) becomes a ragdoll; crowd
  instances are promoted to rigs (`CrowdRenderer.forceRig`). The player: `Player.downT`
  (combat), hard landings, or the API; `Player.ragdoll` blocks control. ≤ 8 simulated at
  once (the oldest tumbling person falls back to the simple knock-down); settled bodies drop
  their physics and keep the pose (accident/collapse victims, crime actors and hard KOs stay
  down until helped or stood up by their owner). `PedAgent.ragdoll` tells Pedestrians to
  leave the body alone. Bodies land on entrance steps (`LocalGround` adds each building's stoop
  boxes next to its prism) and hit cars: up to 10 cars near tumbling bodies get kinematic boxes
  (`RagdollDeps.cars`; wrecks are physical already).

### Player & scale (`src/player`)
* Height *H* ∈ [0.1, 100] m and *k* = *H*/1.8.
* Mass ∝ *k*³; strength ∝ *k*²; walking speed ∝ √*k* (Froude similarity); cadence ∝ 1/√*k*;
  jump take-off speed ∝ *k*^0.25.
* Drag gives a terminal velocity ∝ √*k*, so tiny players float down.
* Footstep energy ∝ mass × speed², which drives:
  * camera shake
  * crushing cars
  * cracking paving
  * breaking walls when the momentum exceeds element strength
* **GiantBody** (`src/game/GiantBody.ts`, THREATS_PLAN §4.1): the scaling laws (`bodyMass`, `stepEnergy`, `walkSpeed`,
  `gaitRate`) and `GiantSteps` (`interactions.steps`), the footfall and landing effects every body shares — the
  player's own (a short thud on the camera) and a monster's (shake by distance from the camera): dust, a `stomp`
  stimulus with the body's `size` and `cause` (Game, Reactions and the near-future layer crush people, cars, props and
  robots by *its* size and book it to whoever stepped), the sound and a destruction impact under a heavy foot.
* Perception radius (for NPCs) grows with *H*. Tiny players go unnoticed and can be bumped.
* Camera: orbit distance in body heights (mouse wheel), collision-aware, and near/far scale with *H*.
* Flight (F): a hover pose when slow, a prone superhero glide when fast, banking, speed FOV,
  wind streaks, a sonic boom over Mach 1, and the downwash kicks up dust near the ground.

### Life simulation (`src/sim`, in a worker)
Citizens are deterministic: `(home building, slot)` gives age, job, workplace, schedule
and car ownership.
* **Abstract tier** (everyone): the schedule is a pure function of the clock, so it costs
  nothing per tick (Vuntra-style: "where is X at time t" is computed, not simulated).
* **Regional tier** (≈2 km around the player): trips are materialised on the street graph,
  as walking, car or metro legs, and positions are updated at low frequency.
* **Local tier** (≈250 m): steering, collision avoidance, traffic rules (IDM car following,
  signals), and perception and reactions to stimuli. Stimuli are explosions, collapses,
  giants, flight, crashes and gunfire-like bangs. Reactions are flee, gawk/film, take
  cover, help, abandon the car, honk, swerve and reverse. People walk on bridge decks when
  walking along a bridge (or already on it), like cars; paths passing under a bridge stay below.
* Rendering tiers:
  * < 35 m: full Norgo skinned humans (LOD0/1); at most 2 new rigs a frame (a ragdoll is never
    held back; the rest stay crowd instances a few frames longer), rig shadows only within
    24 m, foot-IK ground queries cached for 0.25 s on a 0.2 m grid, no per-frame garbage;
    instanced crowd and vehicle attributes upload only the instances in use
  * walking people cache the terrain height under them while they stay within 0.4 m (it was
    the largest cost of stepping 2600 people and most of their garbage); people fleeing more
    than 160 m from the focus step at half rate (the rest of the far ones at a quarter)
  * < 300 m: GPU-instanced crowd with baked vertex-animation textures (`CrowdBaker`: body
    vertices under a garment take its colour slot, so gaps in the decimated far-LOD garment
    shells never show skin)
  * farther: none
  * cars: instanced procedural models with wheel animation and lights

### Countryside (`src/world/landuse`, `src/build/forest`, `src/stream/Countryside`)
The land beyond the city is a global, seed-driven layer, built to sit between several cities later.
* **Rivers** (`Terrain.extendRivers`): the city's rivers continue as meandering countryside rivers to
  the edge of the streamed world (same gradient and width at the junction), plus a few streams joining
  them out in the country. They never come near the city: inside the protected zone (city outline +
  500 m) the terrain is computed from the city rivers alone, bit for bit as without them; beyond it a
  coarse whole-world valley raster (jump flooding) takes over through a 900 m blend band.
* **Land use** (`LandUse.sample`): from the city outline (`world/boundary`), the terrain slope, rivers and
  coast: forest (large warped patches, on slopes, fewer near the city), farmland (flat, dry, away from the
  edge, in farming regions) and meadow, plus a green bank strip; a soft ring of meadow and scattered trees
  around the city. Fields are a patchwork of parcels (`parcelAt`, a warped, rotated, brick-offset grid
  split into strips) with crops (wheat, barley, green cereal, maize, ploughed, pasture, rapeseed, stubble).
  The parcel layout exists in TS and GLSL with the same integer hash.
* **Ground**: terrain tiles carry `aLand` (forest, field, meadow, bank; zero in the city); the terrain shader
  draws forest floor (canopy colour from afar), parcels with crop rows, tramlines and grass margins (each
  fading out before it aliases), meadows and banks.
* **Trees** (`ForestGen.tile` in the city workers, `Countryside` on the main thread): tiles follow the
  terrain quadtree rule. 256 m tiles hold the real trees (forest, bank rows, solitary meadow trees,
  hedgerows along some parcel borders, undergrowth shrubs); near the camera they are drawn with the street
  tree models (full ≤ 75 m, shadows ≤ 45 m, far hulls ≤ ~330 m), every other tile is one or two instanced
  meshes of low-poly canopy clumps (a constant count per tile; in big tiles each clump is a patch of forest)
  out to 11 km. Trunks near the player are obstacles. Budget: ~10–25 MB, ≤ 0.1 ms/frame on average.

### Near future (`src/future`)
The city is a believable near future (PLAYGROUND_PLAN §0, decision 16). `NearFuture` owns it; the game
constructs it, updates it, forwards strikes, and it listens to stimuli (stomp, collapse, crash, blast).
* **Delivery robots** (`Robots`): six-wheeled sidewalk robots that leave shops in loaded cells (density
  follows shop density), drive `Pedestrians.buildRoute` sidewalk routes to a door and back, slow down
  and swerve for people (who step aside: the robot sets `PedAgent.sideX/Z/T`), notice a player of any
  size, wait at the kerb until `Traffic.safeToCross` and stop short of a moving car's path. Robots on
  the carriageway (crossing or lying there) go into `Traffic.obstacles` every frame; cars brake for
  them (IDM gap, junction connectors too) and a car waiting at a fallen one has it dragged to the kerb.
  A shove or punch makes them Rapier boxes; a hard hit or a giant's foot breaks them; a fallen robot
  draws a few gawkers / filmers (`attention`).
* **Street-cleaning robots** (`Robots`, kind Cleaner): slow sweepers with spinning side brushes and an
  amber beacon, at night and early in the morning, sweeping block to block (own rng stream).
* **Humanoid service robots** (`ServiceBots`): articulated (body, head, arms as instanced parts) slim
  humanoids at posts that are a pure function of (seed, junction / building): traffic directors on the
  corner of busy signalled junctions (arm gestures follow the signal phase) and greeters at big shop /
  office entrances (head follows passers-by, waves). Knockable / breakable, player obstacles.
* **Exact local ground** (`ground.ts`, `LocalGround`): knocked robots and falling drones are in
  `GROUPS.smallBody` and skip the coarse city heightfield (which ramps up to roofs at building edges);
  they collide with 1 m street-level patches and building prisms (trimesh walls + roof caps) built
  around them on demand; debris (`GROUPS.debris`) ignores those. `resolve` pushes anything still
  inside a footprint out through the nearest wall.
* **Drones** (`Drones`): parcel quadcopters cruising in 25–55 m lanes by heading, routed round towers
  by A* on a coarse grid (`skyPath`: clearance round footprints that reach into the lane, extra cost
  over buildings just below it, string-pulled), the next lane up (+12/+24 m) when there is no way round,
  over the top only as a last resort; climb / sink rates capped. They winch parcels to doors or flat
  roofs (people below glance up); news drones gather over collapses, police drones circle crashes. Attitude follows acceleration; nav lights and strobes as glow dots (`NavGlows`); a swat or
  a giant's body knocks them down (Rapier, break on impact). One positional rotor-buzz loop.
* **Signage** (`Signs`, art in `signArt`): LED fascias, blade signs and billboard screens placed per
  building from (seed, cell, building), attached to the wall elements behind them (they flicker when
  hit and die when their wall breaks), plus holographic kiosks. One instanced quad mesh, own shader.
* Robots and drones exist only near the player (≤ 150 delivery + 24 cleaning robots, ≤ 16 service
  robots, ≤ 60 drones), in the furniture material (instanced).
* **Malfunctions** (`malfunction.ts`): a machine with `mal` set (glitching, hostile, shut down) is stepped by the
  threat layer's controller (see "Threats and city response"); `spawnAt` places a robot / drone / service robot for it.
  EV charging posts are street furniture (`evCharger`, beside some parking bays); driverless
  `shuttle`s are a vehicle kind in traffic with turquoise automated-driving marker lamps.
* Vehicles sit on the road surface: `Traffic.settle` samples the surface (terrain, or a bridge deck the
  car drives along, `WorldIndex.bridgeDeck` with a heading) under the axles and wheel tracks for
  height, pitch and roll (smoothed); parked cars are settled once, wrecks keep their resting attitude.

### Powers (`src/game/abilities`, `src/game/powers`, `src/game/Targeting.ts`)
Roster and rules: PLAYGROUND_PLAN §0 decisions 17 and 18. Every power is a ranked ability (`defs.ts`: icon,
text from the real numbers; `tuning.ts`: every number; `Progress`: karma, ranks, hotbar of 10 slots, old saves
migrated — dash was folded into super speed: tap = dash, hold = run).
* **Targeting**: Tab / Shift+Tab cycle people, cars, robots, drones and props in view, nearest the crosshair first;
  Esc clears. `probe()` is the "first thing ahead" ray (targets, standing facade panels — holes let it through —,
  roofs, ground); `inSphere()` lists everything an area effect hits. `TargetHud` draws the corner brackets and the
  target frame (slots for the later con colour and health).
* **AbilitySystem**: energy, cooldowns, input; tap powers fire through `Elements.fire`, held powers (laser, ice
  path, hydrokinesis, super speed) run as a `channel` while the key / right mouse is held. **Punch** is a hotbar power
  like the others (always rank 1 and free, slot 1 by default; super strength sets its force): left click only targets.
  Flight boost multiplies the cruise speed by a factor that grows with the rank (`FLIGHT_BOOST_MUL`).
* **Elements**: the elemental powers in the world. With a target they go for it, without one along the crosshair.
  They reuse destruction impacts (laser heat accumulates per 60 cm spot, ≤ 10 impacts/s), debris, dust, props.hit,
  traffic wrecks, reactions.knockDown and the near-future knock. Ice-path sheets are walkable through
  `Collision.extraGround`. Everything done to someone is recorded in `Consequences` (collateral ledger stub).
* **States** (`src/shared/status.ts`): frozen, shrunk, burning, stunned, wet — a WeakMap registry the sim and
  renderers read with one lookup (`statusOf`, free while nothing is affected): peds hold still / walk slower,
  cars stall, crowd instances ice-tint and stop animating, cars / robots / drones / props draw scaled.
* **ElementFx**: pooled beams (camera-facing ribbons), CPU particles (additive and alpha), procedural decals
  (scorch, ice, puddle, fissure), ice crystals and sheets; hidden when empty. `PowerSynth` makes the sounds.

### Street crime (`src/game/crime`, `src/game/deeds`, `src/sim/actors`, `src/game/Combat.ts`)
Phase 1 of PLAYGROUND_PLAN §5 ("Street Hero"), decisions 3–6 and 11–15. `CrimeSystem` (built by the game, updated
every frame) owns the parts and draws what belongs to them.
* **Crime index** (`CrimeIndex`): a deterministic 0..1 per macro cell from (seed, plan): district base (port .70,
  industrial .64, apartments .58 … downtown .30, suburbs .14), density, the poorer inner ring, a seeded smooth noise.
  `hourFactor` shifts it (nightlife and docks worse after dark, business districts calmer). Shown as a heat tint layer
  ("Crime") on the full map.
* **Director** (`CrimeDirector`): every 4 s a slot roll `deriveSeed(seed, 'crime', day, hour, slot, cell)` against
  `crimesPerMinute` (index × hour × setting: average district ≈ one street crime per 2 min, bad ≈ 1/min, safe ≈ 1/10 min;
  off / calm ×0.4 / normal / chaos ×3.5) picks whether and which crime starts (same seed + day + hour + district →
  same rolls); site and outcome are live. At most 1 / 2 / 3 crimes at once (calm / normal / chaos), cooldowns between.
* **Crimes** (`Crime` base, `Snatch`, `Mugging`, `Robbery`): small FSMs (approach → commit → escape / fight /
  surrender → subdued → resolved, or failed / aborted) over real people: victims are passers-by, criminals spawn out of
  view or are converted walkers. Staging only (decision 15): screams and "help!", pointing, cowering with hands up, a
  thief who sprints, looks back and slows to blend in, witnesses who turn and film, a shopkeeper shouting from the door,
  an alarm bell, a getaway car with hazards on. Criminals weigh up the player (con): fight, flee, surrender. Loot drops
  where they go down; E picks it up and gives it back (the victim waits for it). All world access goes through
  `CrimeWorld`, so a crime runs headless in `selftest.ts`.
* **Actors** (`sim/actors/Actor.ts`): `PedAgent.actor` (role, state, health, goal/speed, facing, held item, outfit,
  one-shot animation). `Pedestrians.step` steers actors to their goal and keeps the physics; they are not despawned
  while pinned, Reactions leaves them alone, `CrowdRenderer` gives up to 8 of them full rigs out to 60 m and plays
  their actions (hands_up / cower poses), moods, look-at and held items (knife, bat, bag). Budget 40 actors.
* **Combat** (`Combat.hitActor`): impulse → damage → stagger / knock-down / KO by health (an ordinary punch: 12 of a
  thief's 30). Punches (`Game.strike`, one body per punch, soft-locked target first), tackles at a run and police
  take-downs go through it; knock-downs from powers arrive via `Reactions.onKnockDown`. `onKnockdown` listeners get the
  impulse (ragdolls detect fresh knock-downs themselves).
* **Player health** (`PlayerHealth`): criminals' punches / knives / bats, cars, falls, collapses; regeneration out of
  combat; a heavy hit knocks the player down (`Player.downT`), zero health knocks them out (fade, wake where they
  fell, small karma / reputation cost). Sandbox: invulnerable by default (pause menu toggle).
* **Police** (`Police`): a call sends the nearest patrol car (or one from out of view) with siren (`Vehicle.task`,
  `.siren`: runs red lights, cars ahead pull over), two uniformed officers get out, cuff the knocked-out and the
  surrendered, run down and tackle the rest, walk the arrested to the car.
* **Justice** (`Justice`): reads the collateral ledger (`Consequences`, now with the hit object): hurting bystanders,
  police or property in front of witnesses costs karma and reputation and builds heat → wanted 1–3 (officers chase and
  arrest: a fine in karma); out of reach long enough drops a level; E next to an officer or police car turns the player
  in (smaller fine); good deeds cool the heat.
* **Reputation** (`Reputation`, −100…+100 per city and mode): crowds cheer / wave or step away, police suspicion; HUD
  chip and P screen. **Con** (`Consider.ts`): target vs player strength → grey … purple on the target frame and brackets.
* **Small deeds** (`deeds/SmallDeeds`): seeded every few minutes — a cat up a tree (owner pointing up, meowing; climb with
  E, jump or fly), a runaway dog trailing its leash (catch it, it follows you back), a dropped wallet (the owner pats
  their pockets later). E while carrying puts the cat / wallet down (next to its owner it counts as returned; when E
  has nothing else to do). Sounds: `tools/synthCrime.mjs` (siren, alarm bell, cuffs, meow, bark, cheer, shouts).
* **HUD** (`ui/CrimeHud`): over every active criminal within 80 m a pulsing red chevron with a health bar (from the
  moment the crime is committed until surrender / KO / arrest), health bar, reputation chip, wanted stars.
* **Helping people up** (`game/Deeds`): fallen people within 160 m are marked; ones nobody can get to (indoors, in the
  water, at a height that does not match the ground) get no marker and leave after a few seconds.

### Threats and city response (`src/game/threats`, `src/game/response`)
THREATS_PLAN Phase A ("Robot malfunction") and Phase B stage 1 (the Strider), PLAYGROUND_PLAN §0 decisions 15 and 19.
`ThreatDirector` (`game.threats`) and `ResponseDirector` (`game.response`) are built after the crime layer and updated
every frame (`prof.threats`).
* **Threat clock** (`ThreatClock`, pure, tested in `selftest.ts`): pressure = played time + karma earned × 6 s + the
  player's own ledger entries (chaos) × 1.5 s. Event n has a seeded gap (`deriveSeed(seed, 'threat', n)`: the first minor
  event no earlier than 45 min of play, then 20–30 min apart, × the "City events" setting: off / rare ×2 / normal /
  frequent ×½) and fires when played ≥ last + gap and pressure ≥ last + 1.4 × gap. A seeded 4–8 min before, the clock
  arms and schedules 2–3 omens of the coming archetype over that lead; the event never comes before them, and waits
  while the player is underground, indoors or a giant. Saved per city and mode (`scale.threat.v1.…`); the setting is a
  pause-menu preference. Archetypes plug into the clock's table and the director's `ARCHETYPE_IMPL` (omens, start,
  fallback omen kinds); every event implements `ThreatEvent` (centre, strength, people hurt, targets for the police,
  shutdown; `tier`, `engageOnFoot`, `actors`). **Major events** (the Strider): none before 3 h of play (× the setting's
  scale) and only once the karma earned in the city reaches a milestone (150, +250 per major; `ClockState.karma`,
  `majors`, `lastMajorAt`), then 1.5–3 h apart; when one is due the next planned event is major, with a 10–16 min lead
  and 3–4 omens of its own.
* **Rogue machines** (`RogueMachines`, the near-future layer's `MalfunctionCtl`, `src/future/malfunction.ts`): a robot,
  service robot or drone with `mal` set is stepped by the controller (one early return in each class's step; knocks are
  reported to it; status LEDs in shader modes 3 hostile red / 4 glitch flicker / 2 dark, the livery parts red; kept
  loaded to 720 m). Glitch (omen): stops dead and spins, a drone sags out of its lane and lurches, a service robot
  twitches, then they carry on. Hostile: delivery and cleaning robots hunt people and the player (knock-downs with
  cause `threat`, at most 3 machines on the player, one blow per 1.2 s), rammers dent and stall cars, blockers line
  up across the street (Traffic.obstacles); knocked over they right themselves after 2.6 s until they have taken
  their impulse hit points (delivery 600 N·s: three ordinary punches; service robot 950), then break. Service robots
  leave their posts and swing at people; drones hover over a target, dive to head height, hit and climb. They keep to
  their district (85 m leash round the event's centre). The last knock's cause (player / police / threat) is kept.
* **Robot malfunction** (`RobotMalfunction`): near the site 9–12 delivery robots (those about, the rest rolling out
  of shop doors), 2–3 service robots and 4–6 drones (overhead ones drop their parcels, more fly in) glitch for a
  moment and turn. A `threat` stimulus at the swarm's centre keeps people away; it ends when every machine is out of
  action (stopped) or after 5 min (the fleet is shut down remotely: what is left powers off; drones fly home).
  Omens (`robotOmen`): glitching robots, a drone dropping out of its lane, screens tearing (`Signs.glitch`).
  Rewards: a machine the player disabled 5 karma (service robot 8) +0.5 rep, +3 when it was going for someone,
  20 karma +4 rep and cheers when it is stopped with the player's help (≥ 2 machines).
* **City response** (`ResponseDirector`, levels 0–2 of the ladder, per incident): 0 — three patrol cars with sirens
  (`Police.respond(IncidentJob)`: the job says where, how many get out, what they do there, when to go), a police
  drone; officers hold a line facing it and wave people back. 1 (after 30 s with > 45 % of it still in action, or 8
  people hurt) — police cars swing across the streets where they cross a 115 m cordon (`Traffic.blocks`), a civil-defence
  siren loops over the district and every 2 s a `siren` stimulus with `evac` (210 m) sends people to the nearest metro
  entrance not in the thick of it (`Reactions.onEvacuate` → a sidewalk route, `PedAgent.evac` = 2.3 × pace, vanishing
  down the stairs; budget 0.45 ms/frame of routing), cars inside the cordon turn round or are left, screens within
  330 m show a flashing red warning pictogram (`Signs.alert`). 2 (40 s later with > 25 % still in action) — a SWAT van
  (vehicle kind `swat`: the delivery van with a light bar, push bumper, running boards) with four officers and two more
  patrol cars; officers go in on foot and strike the machines (baton 430 / stun baton 720 N·s, credited to the police;
  never guns, never at people), SWAT bring drones down with a hand-held jammer. Units stuck in a jam within 90 m get
  out and walk. When it is over: down a level after 8 s and 16 s, everyone packs up at 30 s.
* **Cause-aware ledger**: `Consequences.record(…, cause)` (player / threat / police / military) with totals per cause; Justice only
  books the player's own entries and never a rogue machine (fair game); `Reactions.knockDown` causes `threat` and
  `police`; people knocked down by a threat are helped up for karma like accident victims; a robot knocking the player
  out costs nothing. `Stimuli` carry `seq` (Reactions takes everything emitted since it last ran, also what was
  emitted later in the frame), `cause` and `evac`.
* **Threat actors** (`ThreatActor` in `ThreatEvent.ts`): a big threat's body — hit points, zones (`ThreatZone`: armour,
  weak spot, exposed, where it is now), `ray` / `zoneAt` against its body capsules, `damage(zone, amount, source)` (points
  before armour: × (1 − armour), × 4 on an exposed weak spot; booked to the aggro table by `source.key`), `blow(point, r,
  impulse)` (impulse × `DAMAGE_PER_IMPULSE`), `conStrength()`. The director lists the targetable ones (`actors()`), routes
  blows (`blow`: Game.strike — punches —, a giant player's own stomps), lets their bodies be obstacles for the player
  (Collision provider: leg and torso cylinders) and draws every creature in one batch.
* **Creature rig** (`rig/chain.ts` pure math, tested in `selftest.ts`; `rig/CreatureRig.ts`; `rig/skin.ts`; `rig/CreatureMesh.ts`): a
  `RigDef` in metres (spine from neck base to pelvis with joint heights, neck, head, jaw, tail, legs with hip offsets,
  bone lengths, gait phase, knee / elbow direction and sprawl, dorsal plates), scalable. The spine follows its leader
  along the path walked (follow-the-leader), feet stay planted on the terrain / street (`ground`) and are stepped by a
  gait phase driven by the distance walked (a lateral-sequence walk, a settle step when standing; `onStep` at every
  touch-down), two-bone IK with a pole for the knees, FABRIK aims the neck at `look`, the tail is drawn towards a bent
  curve (sweep angle, idle sway, droop) and kept above the ground. Pose controls: lift (sunk / risen), rear, slump
  (dying), jaw, sweep, glows (ridge with a wave from the tail to the head, throat, eyes), pinned feet (a forefoot on a
  facade), wet (glossy after wading). **Skin** (`skin.ts`, pure, tested in `selftest.ts`): one continuous body per
  creature kind, built once around the rig's bind pose (the rig standing `still` on flat ground) and skinned to its bones
  (bone layout: 0 = per-creature parameters, spine, neck and tail segments, head, jaw, upper / lower leg and foot per
  leg; linear blend, ≤ 4 influences): the body is ONE tube lofted (Catmull-Rom through the joints) from the snout over
  the skull, neck and trunk to the tail tip — cross-sections change along it (skull with brow ridges, cheeks and a flat
  palate, neck, deep belly, shoulder and hip bulges, a crest), weights blended half-and-half across every joint; the
  lower jaw hinges under the skull (its back tucked into the throat), teeth on both; legs are lofted from inside the
  trunk through knee to ankle onto columnar feet with four toes and curved claws; eyes under the brow, swept horns;
  jagged dorsal plates (thick in the middle, thin at the edge) in a staggered double row on trunk and tail. Every part
  is a closed, consistently wound, outward-facing surface and parts overlap where they meet, so no pose opens a gap
  or a see-through spot (selftest: watertight per part, positive volume, the bind pose reproduces the mesh, poses
  walking / rearing with the jaw open / tail swept both ways looking up / collapsed keep every part closed, out-facing
  and its volume; weights sum to 1). Vertex attributes: colour (dark hide, paler banded belly, dark red mouth, teeth,
  claws, bone-coloured plates), `glow` (plate mask, plate order tail → head, throat / mouth mask, eye mask), uv (square
  scales: a fixed number of tiles round a tube, along it by girth). The Strider: ~14 k vertices, ~26 k triangles, 105
  closed parts, 30 bones, built in ~40 ms at start. `CreatureRig.boneFrames` writes every bone's frame each frame
  (segments: Y along, Z up the back — necks up-and-back so a raised neck keeps its twist; head; the jaw opened about
  its hinge, `JAW_OPEN` 0.62 rad, a breath of movement at rest; legs; feet flat on the ground, rolling heel-up / toes-
  down while they swing; the chest swells with the breath). `CreatureMesh` (the director's `mesh`): per kind a pool
  of `THREE.SkinnedMesh`es sharing the geometry and ONE material (`creature-skin-v1`: MeshStandardMaterial, vertex
  colours, a generated 256² tileable scale texture as normal map and as roughness / crevice-occlusion map; emissive
  only from the glow mask: plates blue-white in a wave from the tail before the breath, throat and mouth blue-white
  while charging, eyes amber); bone matrices are written straight into the skeleton's bone texture (cur × bind⁻¹),
  the glow levels and wetness ride in bone 0, so creatures share the material and program; culled against a sphere
  round the rig's capsules, never ray-cast. One draw call (+ its shadow) per creature; the pool holds two Striders
  (a live one and a body in the city). A speck of a body is drawn during the start-up warm-up, so the skinned
  program and its skinned shadow-depth variant compile behind the loading screen.
* **The Strider** (`Strider.ts`, archetype `strider`, major, T3 40 m): rises from the river where `StriderRoute` says
  (pure, tested for 20 seeds: the city river about 750 m from the main centre, near a bridge or quay, off the bridge
  towards downtown; a landing up the bank that leaves the water once, then the cheapest way over the arterial graph —
  boulevards preferred, bridges never — to the node nearest the main centre). Emerging (10 s): sunk under the bed it
  comes up with water cascading off its back and plates and foam boiling round it, then roars. It walks its route at
  a 40 m body's Froude pace (≈ 5 m/s, slower when hurt), turning towards the route ahead; in downtown it goes for
  towers one by one (rampage, ~4 min) and then back to the river. Behaviours (cooldowns, one at a time): **roar**
  (two-tone, a `roar` stimulus 700 m: people run, drivers abandon their cars, birds lift; half the time it rears up,
  the belly exposed, and its forefeet slam down as a landing), **breath** (the ridge lights up plate by plate and the
  throat glows for 2 s — the throat is an exposed weak spot — then a blue-white beam sweeps a facade for 3.4 s: heat
  impacts, windows burst, `FacadeFires`, people and cars there burn and are thrown; at whoever hurt it most when in
  reach, else at the tallest building ahead), **tail swipe** (the tail's capsules sweep a side: facades, cars flung as
  wrecks, people knocked flying, props, the player), **lean** (a forefoot pinned on a facade, pushes; low buildings
  come down), **swat** (drones near its head; helicopters later through `airTargets`). Its feet come down through
  `GiantSteps` (cause `threat`, size 40, stomp stimulus capped at 420 m, a `tremor` every second step to 1.1 km); its
  torso and knees shoulder into facades. All its destruction impacts draw on a budget (3 tokens/s, a burst of 6;
  softened after many panels broke lately). Hurt: a hard hit staggers it, a heavy hit on the glowing throat chokes the
  breath off, a battered leg (frost) buckles; at 30 % it turns back and sinks into the river (`retreated`); at 0 it
  collapses — legs fold and splay, the body comes down and rolls, crushing what is under it — no gore; the event ends
  `defeated`, `onDefeated` fires, and after the incident winds down the body moves to `ThreatDirector.remains` (drawn,
  an obstacle, a grey map dot) until stage 3's aftermath removes it (`removeRemains`). Rewards: hits on an exposed
  weak spot 2 karma, driving it off 60 karma +6 rep, bringing it down 120 karma +12 rep and cheers. Omens: `tremor`
  (a shudder and rumble where the player is, birds lift, people look round, car alarms) and `wake` (foam drifting on
  the river where it will rise). It pins news drones, a `threat` stimulus (160 m) and drivers' fear round it.
* **Facade fires** (`FacadeFires`, `threats.fires`): ≤ 32 fires on walls (flames and smoke in the powers' particle pool,
  no lights; now and then the heat bursts a window), 90–150 s; `douse` (hydrokinesis now, fire trucks later).
* **Map / compass**: layer `threat` — the incident as a red alert marker with `always` (compass at any distance), its
  machines within 250 m as red dots, a fallen creature as a grey dot; police units as blue dots (crime layer).
* **Targeting**: big threats are a target kind `threat` (Tab first, three times the range); the frame shows the con
  ('deadly' unless the hero is a giant too), its health and its weak spots (rings on the body, pulsing while exposed;
  the soft lock aims at an exposed weak spot). Every power lands on it as damage in the zone it hits (`Elements.hurtThreat`:
  laser dose, fire heat, bolts, shoves; frost bites a leg), never as collateral.
* **Response to a major threat**: up the ladder sooner (level 1 after 10 s, 2 after 25 s more), wider (cordon 260 m,
  evacuation siren 520 m, alert screens 800 m), units stop well beyond its reach and never go in on foot
  (`engageOnFoot: false`). Under an alert people shelter in place (`Pedestrians.shelter`: no trip starts or ends
  within the siren's reach). Levels above 2 plug in with `registerLevel(n, { when, up, step, down })` (stage 2:
  National Guard, army and air; the last resort).
* Dev console: `dev.threat.spawn('robots', { dist, at, robots, bots, drones, duration })`, `dev.threat.spawn('strider',
  { from: 'river' })`, `dev.threat.strider.status() | roar(rear) | breathe() | swipe(side) | damage(zone, amount) |
  expose(zone) | die() | retreat() | skip(m) | route() | player(dist)`, `dev.threat.clock(seconds | { setting, played,
  pressure })`, `dev.threat.omen(kind)`, `dev.threat.events()`, `dev.threat.stop()`, `dev.response.level(n)`,
  `dev.response.status()`. Sounds: `tools/synthThreats.mjs` (civil siren, glitch, hostile), `tools/synthStrider.mjs`
  (footsteps, two-tone roar, breath charge, breath, tremor rumble, car alarm).

### Cafés, restaurants and terraces (`src/plan/eatery.ts`, `src/plan/terrace.ts`, `src/sim/Terraces.ts`)
Part of the cell plan (pure, in the workers, checked in `selftest.ts`), lived in near the player.
* **Eateries** (`eatery.ts`): a share of the shop fronts (old town 36 %, commercial 30 %, residential 24 %,
  downtown 22 %; +32 % where the shop faces a plaza or park) are cafés, restaurants, bistros, bakery-cafés,
  pizzerias, gelaterias or wine bars (`BuildingDesc.eatery`, kind weights per district), named in the city's
  style ("Café Linden", "Trattoria Mercer", "Gelato Bramble"). Opening hours (later in nightlife districts)
  and busy hours per kind (`eateryDemand`: coffee in the morning, lunch and dinner peaks, bars at night) drive
  `tableVisit(seed, table, kind, district, hours)`: a deterministic timeline of visits per table (who sits
  there when, group size 1–4).
* **Terraces** (`terrace.ts`, `placeEateries` after the street furniture): a sidewalk row of small tables
  against the facade where the sidewalk is wide; a parklet (timber deck modules, planter ends, a rail on
  the traffic side) in the parking strip of local streets where it is narrow (the parked cars there go);
  tables with parasols out on a plaza or park any facade of the building faces (old-town squares, the
  plaza round a downtown tower). Hard rules, shared with the self test (`clearOfWalk`, `frontDoor`,
  `junctionPoints`): nothing in the ±`WALK_CLEAR` (1 m) corridor round the sidewalk's walking line, on a
  carriageway (except the parklet strip) or a park path, within 1.2 m of any door, 12 m of a junction
  (crossings) or near a metro entrance or other furniture. Plus striped awnings over the windows (when no
  lamp, tree or signal is in the way) and an A-board / lit menu lectern by the door. Everything is a street
  prop (`PropType.CafeTable … Parklet`, variant = colour scheme × 2 + model; models in `props/furniture.ts`,
  instanced in the furniture material with the café's colours as `iColor`): light pieces topple at 150 N·s
  and are drawn within 156 m, the rail is a box obstacle, awnings and decks are walk-through. Cost: ≈ 2 ms
  per cell of planning; ~550 instances / 120k triangles in view on a busy old-town square.
* **Fronts** (`future/Signs.ts`, `future/eateryArt.ts`): the name board over the door (above the awnings)
  in the sign shader on a separate 1024² name atlas (same program): the 24 nearest eateries get their own
  names, the rest a generic board per kind; attached to the wall elements like every sign. The facade
  shader lights café shop windows warm while open (`FF.Eatery`, `G.uEatLit`) with a homely room behind the
  glass and no generic sign band. Interiors of eateries always get the café layout (tables, chairs, bar).
* **People** (`sim/Terraces.ts`, `game.terraces`): within 150 m the visits become people (synthetic
  citizens): a group walks in from a door 15–50 m away and sits down (`PState.Sit` on the street:
  `Pedestrians` leaves them be; `onArrive` hands over the end of the route), chats (`Sitting_Talking_Loop`
  via `CrowdRenderer.talking`), holds a cup at cafés (`CrowdRenderer.heldFor`), stays at least 25 s, then
  walks off to another door. A table that comes into range mid-visit is filled at once; after dark most
  sit inside (not at bars and restaurants). A waiter now and then walks between the door and the busy
  tables. Seated crowd instances use a baked sitting pose (`CrowdBaker` clip `sit`). Guests are ordinary
  pedestrians for `Reactions`: they run (knocking a chair over now and then), stand up to stare and sit
  down again, get knocked down; a scared table is taken by new guests once it is calm (20 s). Budget:
  ≤ 170 people, within the street population (`PEDS_ROOM`: a full street gives up its farthest walkers).
  Awnings fall when the wall behind them breaks. Ambience: one positional loop `terrace_murmur` at the
  nearest busy terrace (`tools/synthTerrace.mjs`). ≈ 0.02 ms/frame.

### Birds (`src/fauna`)
`Birds` (constructed, updated and sent strikes by the game; it listens to stimuli itself) keeps at most 300 birds,
only around the camera, in one instanced mesh (`birdMesh.ts`: 26 triangles, wing flap and fold in the vertex
shader from a per-instance phase / amplitude / fold / dihedral, colours per species, a minimum on-screen size
as distance LOD).
* Ground groups: pigeons and sparrows on sidewalks, plazas and lawns, pigeons (gulls near water) on flat roof
  edges. They peck, walk or hop; the player (by size, speed, flight), running people, cars, drones and loud
  stimuli flush them (flutter sound), they circle and land again nearby once it is calm. Walkers passing
  through make the nearest birds hop-flutter aside.
* Sky: a circling pigeon flock by day, starling murmurations in the last daylight hour (offsets in a
  deforming, rippling ellipsoid round a wandering centre that clears the roofs), gulls soaring over the
  river or sea, crows crossing. Birds bank with their lateral acceleration, climb over buildings and
  scatter around giants and flying players.
* Night: no flocks, gulls or crows; birds on the ground roost; street groups thin out unseen.
* Strikes, blasts and a giant's body knock birds out of their flight with a feather puff (dust + chips); they
  tumble, then flee.

### Weather (`src/world/weather.ts`, `src/render/Weather.ts`, `game.weather`)
* **Schedule** (`world/weather.ts`, pure, in `selftest.ts`): a Markov chain of states — clear, fair (sunny with
  clouds), cloudy, overcast, drizzle, rain, storm, fog — seeded per city (`deriveSeed(seed, 'weather', i)`), each
  lasting ~20 min to 8 h of game time. Transition weights depend on the hour (fog only starts 2:30–8:30 and burns
  off by ~11, thunderstorms mostly 12–19:30) and the climate (`climateOf(profile)`: coastal → more fog, drizzle and
  rain; warm → sunnier, more afternoon storms). Long run: clear + fair 52–60 %, rain of any kind 7–10 %, storms
  0.5–1 %, fog 1.5–2.5 %. `at(h)` gives continuous parameters (cover, density, dark, rain, fog, wind, sun,
  lightning): a state blends into the next over 9–27 game minutes (clouds first, the rain late; stopping, the
  rain first), plus showers / drifting cover / gusts from smooth noise over game time. The past never depends on
  how far ahead was queried.
* **Runtime** (`render/Weather.ts`): follows the schedule (or the state picked in the pause menu / admin console,
  remembered in `scale.weather`; blended over ~20 s, rain only once the sky has covered), smooths clock jumps,
  and integrates wet ground (`stepWet`: soaked within ~10 min of rain, dry an hour or so after). Applies:
  * sky / light / fog via `SkySystem.wx` (uniforms on the existing sky shader and the environment sky: cloud
    cover, opacity, darkness, an overcast grey without blue or sun disc, fog towards the horizon; less sun, a
    greyer sky light, adapted exposure; `FogExp2` density from 0.00012 to ~0.006 in thick fog; stars behind
    clouds; the environment map refreshed when the weather changed noticeably) — no extra lights, no new shader
    variants;
  * wet streets: `G.uWet` in the ground (darker, glossier hard surfaces; puddles in the paving hollows with a
    fog-coloured grazing sheen), terrain and facade materials (rain-darkened walls);
  * wind: `vegetationUniforms.uWind` (trees);
  * rain: one `LineSegments` of up to 12 000 streaks in a box round the camera, moved and wrapped in the vertex
    shader (no CPU work per drop; drawn count by intensity); box, streak length and fall speed scale with the
    player's size; hidden indoors and underground (`sky.indoor`, `camRig.underground`). Cost in heavy rain:
    ≈ 0.02 ms CPU, no measurable GPU change (p50 frame time 22.23 vs 22.27 ms);
  * lightning in storms: flash pulses on the clouds (towards the strike) and the hemisphere / environment light,
    thunder (`thunder_near` / `thunder_far`) after distance / 343 m/s, muffled indoors and underground; a close one
    emits the `thunder` stimulus (people glance up, a little startled; birds lift);
  * ambience layers `amb_rain_light`, `amb_rain_heavy`, `amb_wind_gust` (`Game.updateAudio`, muffled indoors and
    underground, the city layer quieter in rain); sounds from `tools/synthWeather.mjs`.
* **The city reacts**: `peds.outdoorShare` (fewer walks are made; walkers who would not be out go in where nobody
  sees it) and `peds.paceK` (the rest hurry); umbrellas for many walkers (`Weather.heldFor` after the terraces'
  cups: the `umbrella` item, held up with the raised torch grip); when it starts some walkers without one detour
  under the nearest awning or bus stop (≤ 3 each) for 15–60 s; terraces empty (`terraces.rain`: guests hurry in
  at the café's door; under a square's parasols some sit out a drizzle) and fill again when it is dry; cars drive
  slower (`traffic.weatherK`) with their lights on (`vehicles.weatherLights`); no flocks, gulls or crows aloft in
  rain and fewer street birds (`birds.rain`).
* **Controls**: pause menu "Weather" (auto / clear / fair / cloudy / rain / storm / fog), a glyph after the time in
  the HUD, the admin console's Weather section, `dev.weather.set(kind) / next() / auto() / status() / forecast(n) /
  strike(m)`.

### Interiors (`src/interior`)
* Generated on demand when the player approaches an entrance or a breach: floor plan by
  building use (apartments, offices, shops, restaurants, lobby, stair or elevator core),
  then rooms, doors and furniture by room type.
* Only the current floor ±1 is built.
* Uses the same element mechanism, so interiors are destructible too.

### Underground
* Metro: tunnels (extruded profiles), stations with platforms, stairs to street kiosks,
  and trains on analytic timetables that stop and open doors.
  * Departure boards over every platform (two, double-sided): line, destination, the next train
    and the one after, from `layout.nextTrainAt` (the same timetable as `trainsOn`; checked in
    `selftest.ts`). Redrawn on a canvas only when the text changes.
  * Cars have window openings with tinted see-through glass (sides and both ends, a second
    instanced mesh). Riding: a running sound that follows the speed, a knock at every rail joint,
    rattle, a lurch pulling away / braking, the light flickering now and then (`Game.rideFx`,
    `Underground.riding`); doors, arrival, departure and oncoming trains rushing past are heard
    near the listener (`Underground.onTrainSound`). Sounds: `tools/synthMetro.mjs`.
* Sewers: arched brick tunnels with channels and walkways under arterials, manholes with
  ladders, and outfalls.
* Tunnel dressing (in the tube chunks): cable trays and a pipe along metro walls, a green
  running-figure exit sign every 60 m with a maintenance ladder at every third, an old pipe along
  one sewer wall.
* Side rooms (`underground/rooms.ts`, pure data, deterministic per seed): every ~240–520 m of sewer
  and ~160–320 m of metro tunnel a room opens off the tube through a doorway cut into its wall —
  sewers: alcove, overflow chamber (street grate, falling water, basin), cistern (lowered floor with
  steps, piers, standing water), pump room, collapsed passage, bricked-up arch with a gap; metro:
  refuge niche, cross-passage (shut steel door), staff room, ghost platform (old platform behind
  arches, steps up from the track bed), ventilation room (turning fan, shaft with daylight),
  electrical room, storage. Each room is a door box (reaching 0.75 m into its host so the walker
  passes) plus a main box (`Box` kind `room`; steps are `Platform`s limited along u); clear of every
  tube, hall, room and (via the hall distance) the entrance passages, ≥ 0.9 m under the ground,
  sewer rooms under their street. Planned with a spatial grid in ~60 ms (seed 42, size 0.6).
  Meshes (`RoomMeshes.ts`) are built within 200 m like the tube chunks, lit by emissive fixtures
  only, with the facade atlas (`aLayer`/`aTint`), one unlit glow and one decal material on a canvas
  atlas (`roomArt.ts`: signs, graffiti, markings, cracks, puddles) and an additive veil. Solid
  props are obstacles (`carObstacles`). Drips, hum, fan and falling water: `tools/synthUnder.mjs`.
* Hidden colonies (2–5 per city, far out): a gap in the back wall of a quiet side room opens into a
  rough crawl passage (`Tube` kind `crawl`) sinking to a chamber at depth (under the lowest ground
  within 32 m, so hillside foundations never reach it). Slimes live there (`Slimes.ts`, one
  colony active at a time, two instanced meshes, one unlit material): moss gardens, domes and
  stacks of salvaged things, fungus lamps, a spiral and a row of collected things, wall markings.
  Calm they tend, carry, gather and sit pulsing in turn; they notice the player, freeze, dim and
  squeeze into cracks; someone standing still is approached by a brave one that stretches up to
  look and, once, leaves a glowing pebble. Hits (stimuli `impact`/`power`/`blast`/`stomp`) splatter
  them into drops that flow away; the colony then hides for ten minutes. A few rooms near colonies
  have a faint glowing trail, sometimes with a lone one that slips into a crack. No markers, no
  text. `dev.colony(i)` puts a tester in the room with the gap.
* Volume queries (`floorAt`, `contains`, `cameraFree`, …) go through a 32 m grid of tubes and boxes.
* Terrain holes: shader discard plus a collision query.

### Audio (`src/audio`)
* Web Audio with spatial sources and an ambience mix by context: street, park, river,
  interior, sewer, metro, flight.
* Clips come from SoundStudio (`public/sounds`, see `docs/SOUNDS.md`), with procedural
  fallbacks.
* Weather layers (rain light / heavy, gusts) and thunder: see "Weather".

### Map, minimap and compass (`src/ui/map`, `src/ui/Compass.ts`)
* Full map (M) and minimap (N). Clicking the map sets the player's marker (a red pin, also on the
  minimap's edge when out of view; cleared on arrival); travel by clicking is a sandbox feature.
* Compass strip at the top: heading ticks, nearby points of interest within ~320 m (metro
  entrances, people needing help, crimes, small deeds, power cores — the map's marker layers)
  and the player's marker with its distance, pinned to the edge when behind.
* A threat incident is a red alert marker shown on the compass at any distance (`always`).

### Saves (`src/game/save`, `src/ui/SaveUi.ts`)
A session can be saved and continued: `game.saves` (`SaveSystem`), stored by `SaveStore`.
* **Model** (`model.ts`, pure, tested in `selftest.ts`): one versioned JSON object (`SAVE_VERSION`; `MIGRATIONS[v]`
  upgrades v → v + 1, `parseSave` sanitises every field so a partial save loads with defaults, a newer version is
  refused): city (seed, size), mode, the character (AvatarStore id, plus a created look as a fallback), the player
  (position, yaw, size incl. the admin size override, flying, health, energy, hotbar slot; whether the spot was
  underground / indoors), camera (yaw, pitch, zoom), sky (day, hour, time speed), weather (setting, wet streets, the
  schedule skip; read from `render/Weather` — a `serialize` / `restore` pair there would take over), Progress (karma,
  ranks, hotbar, cores, bonuses), reputation, justice (heat, wanted), the threat clock and its setting, the bodies of
  defeated monsters (`ThreatDirector.remains`, laid back down settled) and a Strider on the move (resumed at its route
  position and hit points), the map marker, the crime / city-event settings, and the city damage.
* **City damage** (`CityDamage.ts`, `codec.ts`): per damaged cell the dead elements (walls, roofs, slabs — not slabs
  only hidden by an open interior), shattered windows (not windows an interior opened) and broken slab tiles as
  index runs (gap + length varints, base64); collapsed buildings (gone, or the lower top of a partial collapse) and the
  rubble mounds. Restored into loaded cells at once and into the others as they stream in (`CityStreamer.restoreElements`,
  `Destruction.restoreBuilding` shows the storey slabs through the holes). The same bookkeeping keeps collapsed
  buildings collapsed across cell eviction. A heavily damaged district (34 collapsed buildings, 27 k dead elements) is
  ~6 KB of JSON; a save is ~1.4 KB without damage, gzip-compressed in IndexedDB, plus a ~6 KB JPEG thumbnail.
  Not kept: loose / settled debris, broken props and trees, wrecked cars, road craters.
* **Not restored on purpose**: people, traffic, robots and drones (seed + clock), running crimes, small deeds, robot
  malfunctions, omens and facade fires (they end with the session). Indoors the player is put on the street outside
  (interiors open on approach); an underground spot is restored exactly when the tunnel / room is there; a street or
  roof spot when the ground under it matches, else `GameMap.placeSafely` (the map's safe-spot logic).
* **Storage** (`SaveStore.ts`): IndexedDB `scale-saves` (`meta`: the list entries with name, city, mode, game day /
  time, real date, play time, karma, thumbnail; `data`: the save), one transaction per save; localStorage as the
  fallback. Every call is wrapped — a failed save never breaks the game.
* **Autosave**: every 2 min of play, on `visibilitychange` → hidden, after notable moments (a city event or a crime
  ends, karma spent; at most every 25 s), rotating over three slots (`auto-0..2`: the oldest is overwritten, so the
  previous autosave always survives). On `pagehide` / `beforeunload` a synchronous copy goes to localStorage
  (`scale.save.emergency`, ~7 ms) and is folded into IndexedDB on the next start (`recover`).
* **Loading** always starts the city fresh: Continue / Load on the start screen start it in place; loading from the
  pause menu (same or another city) reloads with `?seed&size&mode&load=<id>`. `Game.startAt` streams the city in
  around the saved spot, `Game.pendingSave` is applied before the warm-up. Loading a save writes its progress /
  reputation back to the per-city stores (`scale.progress.v1.…`, `scale.rep.v1.…`, `scale.threat.v1.…`), which still
  carry a city's progress into a new game there.
* **UI**: start screen — Continue (newest save: thumbnail, city, mode, day / time, play time) and Load game (the list:
  thumbnail, name, city, mode, day / time, real date, play time, karma; load, delete with an inline confirm). Pause
  menu — Save game (a name; the same name asks to overwrite inline), Load game, "Autosaved 12 s ago". A small
  "Saving… / Saved" chip bottom left. Admin console section "Saves"; `dev.save.now(name) | auto() | list() |
  load(id | 'latest') | get(id) | remove(id) | capture() | sizes() | status()`.

## Threads

| Thread | Work |
|---|---|
| main | render, input, player, Rapier, mesh assembly, audio |
| plan workers (pool) | macro plan, cell plans |
| mesh workers (pool) | cell geometry (LOD0/1/2), interiors, human bodies (Norgo `body.worker`) |
| sim worker | citizens, traffic, transit |

## Directory map

```
src/core       rng, noise, math, geometry (polygons, splitting, offsetting), spatial hash
src/world      terrain, water, settings, city outline, countryside land use, weather schedule
src/plan       macro, cell, building descriptors (pure data)
src/build      geometry builders (buildings, roads, terrain, props, interiors, underground)
src/render     renderer, sky, weather (rain, wet streets, lightning), materials, textures, post
src/stream     cell streaming, worker pool
src/destruction elements, debris, structural collapse
src/player     controller, camera, scale, flight
src/sim        citizens, traffic, transit (worker) and the client-side crowd renderer
src/future     near-future layer: delivery robots, drones, animated signage, holo kiosks
src/fauna      birds: ground groups, flocks, gulls, crows (instanced, around the camera)
src/underground metro, sewers, trains, side rooms, hidden colonies and their slimes
src/humanoid   Norgo human pipeline (bodies, animator) plus modern clothing
src/audio      audio engine
src/ui         HUD, menu, map
```
