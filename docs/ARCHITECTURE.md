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

### Humanoid animation (`src/humanoid/client/anim`)
* `Animator`: locomotion families (ground, swim, climb, air, glide/fly, sit, sleep, dead, stunned) cross-faded by
  weight, carry poses, actions, the superpower layer, additive breathing / look-at / hit springs, foot IK, face and
  fingers. Poses are Euler angles over a neutral (arms hanging, palms to the thighs; `pose.ts`).
* Clips (`clips.ts`, `public/assets/anim/clips.{json,bin}`): model-space rotations of a 22-bone Rigify body,
  retargeted per character at runtime. Quaternius clips (CC0, `tools/build-anim-clips.ts`) for walk / jog / sprint,
  crouch, swim, sit, jump, actions; motion capture for standing (`CMU_*`, below). `LICENSE.txt` holds the credits.
* **Standing idle = CMU motion capture** (`tools/cmu-bvh.ts` + `tools/cmuBvh.ts`): BVH takes of the CMU Graphics
  Lab database are retargeted onto the library skeleton (torso and collarbones by rotation from rest, long limb
  bones by matching the rest segments — the CMU rest stands with spread legs —, feet and toes against their
  parent, hands rigid with the forearm, which takes the wrist's pronation), smoothed, resampled to 30 fps, turned
  to face −Z, the head's motion centred and damped, the upper body set to a relaxed upright, hips sway kept
  (weight shifts) around the mean, and looped by cross-fading the end into the frames before the cut.
  Clips: `CMU_Idle_1` (113_21 "Standing Still", 1–10.8 s), `CMU_Idle_2` (the same, mirrored), `CMU_Idle_3`
  (77_02 "standing", 1–7.5 s). Each character picks one by seed (`MOCAP_IDLES`) and starts at a seeded point in
  it. Over a mocap idle the clip drives arms and torso fully (no collarbone protraction or procedural calm arms,
  which the Quaternius `Idle_Loop` still gets as a fallback); the arms get a little room by body weight so hands
  clear hips and skirts. Talking blends to `Idle_Talking_Loop`; walking, carry poses, look-at, moods and sitting
  work as before. Relaxed hands curl more toward the little finger, fingers drawn together; fists wrap the thumb.
  `CrowdBaker` bakes one whole idle cycle (`Animator.idleCycle`, sub-stepped, eyes fixed ahead) so baked crowds
  loop without a seam. `npm test` checks the parser and retarget math (`tools/cmuBvhTest.ts`).
* **Flight** (`Animator.flight`, move `fly`): the player pitches and banks the body (`Player.updateRig`) and passes
  `PowerAnim.fly` (tilt 0–1, bank, boost); the animator poses the limbs for it — hover (upright, arms a little out,
  legs together with one knee bent, toes pointed, slow drift), slow flight (arms along the body, head up), cruise
  (right fist ahead, left arm along the body), boost (both fists ahead), banking (head and torso into the turn),
  blended by tilt; fists close on stretched arms.

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
* Flight (F): hover, slow, cruise and boost poses (see Humanoid animation), banking, speed FOV,
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

### Landmarks (`src/plan/landmarks`, `src/plan/landmarkParts`, `src/build/landmarks`, `src/world/airfield`)
Special buildings, planned with the macro plan (`MacroPlan.landmarks`, ~10 ms) and different in every city.
* **Which**: a town hall (at the old core: classical with portico and dome, gothic with belfry and spire,
  baroque with clock tower and cupola, or modern slab with campanile and council drum; wings, a square
  with a fountain in front), a stadium (around the edge of the centre: oval or rectangular bowl, 1–3 tiers by
  city size, open / canopied sides / ring canopy / closed roof, running track, floodlights, car parks), 1–4
  attractions by size from a weighted pool that depends on the place (TV / lattice / glass observation tower,
  gothic or domed cathedral, big wheel, obelisk / column / triumphal arch / statue, classical or modern museum,
  lighthouse only on a coast, castle or castle ruin only where there is a hill, botanical glasshouse), and for
  cities from 3.5 km radius an airport.
* **Sites**: every in-city landmark reserves an oriented rectangle inside one cell (`SiteFitter`: inside the cell
  inset by its arterials' half width and sidewalk, so off the sewer manholes too; dry, flat enough, apart from the
  other sites; near its target — the core, a hilltop, the shore, a park; the front (-v) towards the cell edge for
  squares). `planCell` keeps it free: local street cuts that would cross it move along its edge (or the piece
  stays whole), blocks lose the site (holes are split away so lots never land in it, thin leftovers are paved),
  the site gets its ground (`siteZones`: square, lawn or car park, with holes under the structure) and its own
  props (lamps, benches, trees, a fountain, parked cars) — after the cafés, so no terrace spills onto it.
* **Structure** (`landmarkParts`): a list of primitive parts — boxes, cylinders / cones, (elliptic) domes, gable
  and pyramid roofs, stands (quad prisms with stepped seat rows), beams, tubes, barrel vaults, flats, quads —
  each with a facade-atlas material (layer, tint, window grammar). One description serves the mesh, collision
  (`partObstacles`: the solid parts; open structures like the wheel use hidden collision volumes), the map
  (`partFootprints`) and the planner (`solidFootprints`). Walls that follow the terrain (fortress) sample it.
* **Mesh** (`build/landmarks`, worker job `landmarks`): one `THREE.LOD` per landmark in the facade material
  (shared, not destructible), near mesh with all details, far mesh without `detail` parts and with fewer
  segments; 0.1–11 k triangles each.
* **Collision** (`world/LandmarkSolids`): a 32 m grid of the solid parts; an obstacle provider for the walker
  (walls stop, tops can be stood on), `WorldIndex.groundHeight` (physics ground) and `WorldIndex.raycast`
  (camera, aiming, sight).
* **Airport**: `world/airfield` picks a flat, dry rectangle just beyond the protected zone around the city (the
  city's terrain stays unchanged), the terrain levels it (`Terrain.height`, a 90 m embankment band) and the land
  use keeps forest, fields and hedges off it. Runway(s) with markings, taxiway, apron, a terminal (flat, waved or
  saw-tooth roof) with jet bridges, a control tower, hangars, parked airliners and a road to the nearest arterial
  node.
* **Map**: footprints on the map tiles (buildings, paving, pitch, track), a star badge per landmark (named on the
  full map, tooltip, compass within ~1.3 km); the map square reaches out to the airport.
* Debug: `npx tsx tools/celldump.ts <seed> <size> out.png 600 landmark:<kind>`.

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
  hit and die when their wall breaks), plus holographic kiosks. One instanced quad mesh, own shader; in an incident it
  draws the red alert, the last resort's countdown, the live news feed (a sampler bound to a 1×1 texture until the feed
  renders) and the news pictograms (src/game/aftermath) — no text, one program.
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
  Buildings: `Destruction` remembers who broke each building last (`as(cause, fn)` around the monster's, the army's
  and fires' impacts; the player otherwise) and reports `onDamage` / `onCollapse` (blamed within 120 s); Game books the
  player's into the ledger (`building:facade`, `building:collapse` with the storeys as `size`). Facade damage before
  witnesses costs a little (`JUSTICE.facade`, every 2 s at most); a collapse the player caused is always known and
  costs heat, karma and reputation by storeys (`JUSTICE.collapse`), once per building.
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
THREATS_PLAN Phase A ("Robot malfunction"), Phase B stage 1 (the Strider), stage 2 (the army) and stage 3 (consequences and the
last resort), PLAYGROUND_PLAN §0 decisions 2, 15 and 19.
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
  come down), **swat** (drones near its head; the army's helicopters through `airTargets`). Its feet come down through
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
  machines within 250 m as red dots, a fallen creature as a grey dot; police units as blue dots (crime layer); the
  army's squads as green-grey dots (layer `army`, the tooltip says what it is and whether it holds, moves up or is
  breaking).
* **Targeting**: big threats are a target kind `threat` (Tab first, three times the range); the frame shows the con
  ('deadly' unless the hero is a giant too), its health and its weak spots (rings on the body, pulsing while exposed;
  the soft lock aims at an exposed weak spot). Every power lands on it as damage in the zone it hits (`Elements.hurtThreat`:
  laser dose, fire heat, bolts, shoves; frost bites a leg), never as collateral.
* **Response to a major threat**: up the ladder sooner (level 1 after 10 s, 2 after 25 s more), wider (cordon 260 m,
  evacuation siren 520 m, alert screens 800 m), units stop well beyond its reach and never go in on foot
  (`engageOnFoot: false`). Under an alert people shelter in place (`Pedestrians.shelter`: no trip starts or ends
  within the siren's reach). Levels above 2 plug in with `registerLevel(n, { when, up, step, down })` (3 and 4: the
  army, below; 5, the last resort, is stage 3). `setLevel` (dev, saves) climbs one level at a time.
* **The army** (`response/forces`, `game.forces`, prof `army`; Phase B stage 2) — levels 3 and 4 for a major threat
  with a body (the Strider). **3 National Guard** (`ARMY.up3`: 30 s at level 2 with it above half strength, or 25 people
  hurt): four infantry squads riding in army trucks and two APCs, from ~720 m beyond the monster (ahead of it, towards
  downtown) along the streets. **4 Army & air** (`ARMY.up4`: 55 s at level 3, or the guard's lines breaking with it above
  40 %): three tank platoons (2 each), three attack helicopters, two strike jets, an artillery battery 3.2 km beyond the
  route's end (beyond the city edge). Stand down with the incident (level 4 then 3 go 4 s after it is over: units drive /
  walk / fly off, then go).
  * **Battle model** (`BattleModel.ts`, pure, shared with the headless battle): `ForceUnit {kind, squad, pos, hp, morale
    (per squad), ammo, task}`, squads as the monster's aggro keys. `stepForces`: units hold **slots** ahead of the
    monster's projected position along its route (`slotFor`: tanks ~360 m on the avenue itself, APCs ~280, rifle squads
    ~230 on its flanks, as far as the route runs straight — a line of sight down the avenue; a ring round the route's end
    in downtown), a rifle squad rides in its truck, gets out at its slot and digs in, falls back on foot away from the
    monster when it comes within `danger`, and once it has gone by its truck takes it to the next line; vehicles fall back
    to the next slot. **Fire**: a volley = rounds × hit chance (falling off with range, lower when shaken) × damage before
    armour on a body zone picked by exposed surface; an exposed weak spot (the throat while charging / breathing, the
    belly while rearing) only when the volley is aimed at it **and** has line of sight — army fire mostly chips armour
    and staggers; `ARMY.firepower` (0.16) is the balance knob. **Morale**: −0.17 per soldier / vehicle lost, breath close
    by, roars within 300 m; recovers after 20 s quiet; below 0.38 the squad falls back ("the line is breaking"), below
    0.1 it routs. Helicopters circle at 230 m and make rocket runs that pass 40–115 m from its head (inside 54 m it can swat
    them); jets and the artillery strike on timers (50 s, 30 s).
  * **The monster answers** through the Strider's hooks: `unitAt(key)` (its breath goes for the squad that hurt it most
    within reach — `angriestInReach`, the player included), `onBlow(kind, x, y, z, r)` (breath ticks, tail sweeps,
    footfalls, slams, its fall hurt the units there: `hurtUnit`; vehicles are wrecked / crushed, soldiers knocked flat;
    a roar shakes morale), `airTargets` (helicopters near its head, reach × 1.7). Its own swipes, breath and feet wreck
    and crush materialised vehicles in traffic too.
  * **Tiered simulation**: units within 600 m of the player (`ARMY.matR`, out at 700) are **materialised** — vehicles
    as traffic vehicles (kinds `army_truck`, `apc`, `tank` with a turret: `Vehicle.gun` yaw / pitch / recoil, drawn by
    VehicleRenderer as two more instanced meshes; tasks, `sendTo`, stuck → hold), soldiers as crowd actors (role
    `soldier`: olive uniform, helmet, rifle, `aim_rifle` pose, crouched behind sandbag walls between bursts; their own
    budget, not the crime layer's; knocked down = out of the fight, they get up and walk off — stage 3: medics) — and
    fire with rays: one world probe per volley (≤ 2 Hz a squad; blocked → the high back over the roofs; three blocked
    volleys → a new spot), tracers, flashes, the tank turning its turret and recoiling, shells / rockets / bombs
    resolved where they land (a hit on the body, else a facade or the street: explosion, scorch, a destruction impact).
    Farther units are **abstract** (straight-line moves, chance-based volleys on the real Strider) and only map pings;
    helicopters and jets are always drawn (instanced flyers). Helicopters fly after their unit drone-style (arrival
    steering, tilt into the acceleration, yaw into the flight / at the monster); swatted they become a Rapier body that
    spins down, crashes (explosion, a destruction impact, a 'collapse' stimulus) and burns. Jets fly straight dive-and-climb
    runs, bombs released ahead of the target, a flyby roar with a crack. The artillery: a flash on the horizon (drawn
    1.3 km out in its direction), the boom later (343 m/s, ≤ 12 s), a whistle, three shells.
  * **Look and sound, cheaply** (`ArmyFx`): tracers are the powers' beam ribbons (≤ 256), flashes / smoke / fire their
    particles, debris chips and dust the existing pools; destruction impacts from army fire draw on a token bucket
    (≤ 6 / s); searchlights at night are emissive beam ribbons from trucks / APCs sweeping over the monster (≤ 4, faded
    near the camera; no real lights); sandbag walls are one instanced mesh. Every new model (`props/military.ts`: truck,
    APC, tank + turret + gun, helicopter body / rotor / tail rotor, jet, sandbags) uses the shared vehicle material (new
    parts `VPart.Matte` / `Canvas`), so nothing compiles a new program; the models are built at start. `gunfire`
    stimulus (people near it run, farther ones start and look), barks ("Open fire!", "Fall back!"). Stray splash can hurt
    the player a little (`HurtKind` 'military', no karma cost when it knocks them out); soldiers never aim at people.
    Collateral is booked with cause `military` (never the player's karma).
  * **Budgets** (THREATS_PLAN §4): ≤ 24 materialised military vehicles, ≤ 48 soldiers (24 sent), ≤ 4 helicopters (3
    sent), ≤ 2 jets, ≤ 256 tracers, ≤ 6 impacts / s; checked by the headless battle (peaks per run) and `levelSquads`.
    Measured (seed 42, size 0.6, Strider at level 4 vs. the same with the army off, fixed camera, fair weather, 120 s):
    the `army` section ~0.09 ms; whole-frame CPU about +1.2 ms (sum of `window.prof`, noisy ±0.8 ms).
  * **Headless "no player" battle** (`simulateBattle`, `SimMonster`: the Strider's rules along its route — emerge, pace,
    slower when hurt, roar / rear, breath at the angriest in reach, swipes, steps, swats, stagger, back to the river at
    30 %, a 260 s rampage downtown): deterministic per seed; `selftest.ts` runs this city's route for 50 seeds — the army
    drives it off / brings it down in 25–55 % (now ~46 %), units within the budgets.
  * **Saves**: the army is not kept; a resumed Strider brings the response back to its saved level (`SaveStrider.level`)
    and the units come in anew.
  * Hooks: `Forces.onOutcome` (the battle's end: outcome, whether the army did it, losses), `withdraw()` (level 5: every unit
    pulls out — convoys leaving, no more fire), `rally(x, z, r)` and `airstrike(x, z)` (wired to the player: the aftermath's
    `Command`, below; a player's airstrike is its own squad `air-strike`, one run per call, attached to a monster the army
    has not engaged yet), `struck` (a punch of the player's knocks a helicopter in reach out of the sky while the army is
    after them). The army fights an `ArmyFoe`: the Strider, or a rampaging giant player (below).
* **The army against the player** (`threats/PlayerRampage.ts`, `game.hostile`, rules in `threats/rampageRules.ts`, pure,
  tested; PLAYGROUND_PLAN §0 decision 19: no cap, after a clear warning sequence). `HostilePlayer` reads the player's own
  entries in the collateral ledger as a decaying **fury** (a building brought down 3 + 0.35 per storey, a facade 0.25 at
  most every 1.5 s, a bystander 0.6, an officer or soldier 1.2, a car wrecked 0.4; criminals nothing; halves every 75 s).
  The **watch** (`RampageWatch`): a giant (≥ 6 m) with a feared reputation (≤ −40) whose fury reaches 6 is warned (a toast,
  a siren whoop, the nearest officer shouts, a police drone comes over, the screens round about show the red alert);
  20 s later, still at it, the final warning; 20 s after that, fury ≥ 9: **hostile** — a `PlayerRampage` event (archetype
  `rampage`, major, never on foot) that the response escalates against like a monster's: patrol cars and a cordon,
  evacuation sirens, SWAT and patrol officers firing from a distance (GIANT), the National Guard and the army and air
  (levels 3 and 4), and, rarely, level 5. Below fury 3 while warned (or no longer a giant), the warnings lapse. Standing down — no destruction
  for 45 s, or human-sized for 20 s, but never within 180 s of the army being called (once mobilised the Guard and
  the tanks get there) — ends it (`abandoned`; the fury is spent); a relapse within 5 min brings the army
  back without new warnings. Brought down (knocked out by the response): `stopped`, taken into custody (Justice.arrested).
  * **The player's body** (`PlayerBody`, a ThreatActor with `self`: the police's and the army's target, never in
    `ThreatDirector.actors()`, so never the player's own Tab target or blow): zones head / torso / legs round the player
    (armour 0.2–0.35, no weak spots); army damage points after armour become health — 500 points a full bar (small hits
    add up), past the health's size scaling; `HurtKind` 'military' (no karma for the knock-out itself).
  * **As the army's foe**: its route runs from the city centre's side (≥ 1 km) to where the player stands, rewritten as
    they move, mode `rampage` — the battle model rings them (rifles ~230 m, APCs ~270, tanks ~330); units come in 420 m
    from the player on the city's side (`spawnPoint`), the artillery beyond them (`batteryAt`); units holding beyond
    their weapon's range of a player who has moved on go again after 5 s (`regroup`: a rifle squad waits for its truck).
    The player's blows on the units are their own: vehicles crushed or wrecked, soldiers knocked down (the usual losses
    and morale), helicopters punched out of the sky (`Forces.struck`). Headless check (`simulatePlayerBattle`,
    selftest): a 20 m giant standing still goes down ~40 s after level 4 arrives, the ground forces doing about half (level 3 alone takes far longer); one walking
    off is followed.
  * **The last resort against the player**: the same rule (level 4 a while, the army failing, the seeded roll), the player
    counting as "deep in the city"; the strike zone follows the player through the countdown; standing down or being
    brought down calls it off; at zero the blast knocks the player out (not underground) and ends the rampage
    (`destroyed`). The news feed films the rampaging giant; medics keep clear of them. Not kept in saves.
* **Consequences and the last resort** (`src/game/aftermath`, `game.aftermath`, prof `aftermath`; Phase B stage 3, THREATS_PLAN
  §2 "Casualties without gore", "Show, don't tell", "How the player helps", level 5; §3 aftermath). Built after the army.
  * **Casualty ledger** (`Casualties.ts`, pure, tested): evacuated (the response's count) / injured / trapped / rescued (and
    how many by the player) — never dead: `injure`, `trap`, `dig`, `treat`, `settle` (the crews look after everyone still
    waiting); counts never go negative, the waiting only fall by a rescue. A small chip under the compass shows the four as
    pictograms with numbers (hover: what they are) while a major incident and its aftermath last.
  * **Rules** (`rules.ts`, pure, tested): `lastResortDue` (below), `ShockWave` (the strike's buildings by distance, ≤ 6 a
    frame, never before the front), the carcass schedule (`carcassStage`, `removalOrder`, `boneScales`), how long smoke,
    cordons, the memorial, the news and the EMS stay (`AFTERMATH`, in game hours).
  * **Level 5 — the last resort** (`LastResort.ts`, `registerLevel(5)`): only for a major threat with the army failing deep
    in the city — level 4 for ≥ 45 s, the monster at ≥ 45 % in downtown (its rampage) or ≥ 85 % along its route, the army's
    lines broken (≥ 2 squads) or ≥ 6 units lost or level 4 for 150 s without a result — and a seeded roll per incident
    (`lastResortRoll`: 45 % × the City events setting; off: never); `LAST_RESORT` holds every number. Countdown (180 s):
    the district's evacuation siren falls silent and the attack warning (`nuke_siren`) wails over ground zero, the
    evacuation widens to 1.6 × the strike radius (`Incident.tone`, `evacR`), cars in the zone are sent out of it (a few a
    second), the army pulls out (`Forces.withdraw`), the monster stays in downtown (`Strider.stay`), every screen in the
    city shows a hazard symbol and MM:SS (`Signs.countdown`), the map and minimap draw the strike zone's ring and the
    compass points at its nearest edge with the distance (marker kind `zone`). Driven off or brought down in time: called
    off — the attack siren winds down, an all-clear pictogram on the billboards, 150 karma and 15 reputation when the
    player did most of it. At zero: a white flash (an overlay; `Weather.glare` on the sky and the light), the boom after
    distance / 343 m/s (`blast_rumble`), a fireball (glow particles), a mushroom cloud (the smoke columns' mushroom mode,
    growing over ~25 s), the monster gone (`Strider.obliterate`, outcome `destroyed`; a carcass in the zone goes too), the
    shock wave levelling every building within 380 m by its distance (`Aftermath.level`: all its elements dead, the
    building gone, a rubble mound for the bigger ones, street furniture flattened without falling bodies — ≤ 0.9 ms in any
    frame), cars crushed as it passes, dust rolling out, a `tremor` stimulus far off. People still in the district are
    counted trapped (40 %) or injured — never dead (`strikeCasualties`, plus a few per hectare who sheltered indoors); the
    player inside 1.1 × the radius (not underground) is thrown down (a ragdoll), the view fades and they come round at the
    ring's edge with a third of their health, at no karma cost. The city lost: −40 karma, −20 reputation, the news
    pictogram for hours. The district stays levelled: `Aftermath.zones` (in saves), levelled again without effects as its
    cells stream in (`streamer.onCellReady`), hidden in the far skyline (`Skyline.ruins`, a uniform), and the city damage
    keeps its buildings and mounds. A running countdown is not kept in saves (the resumed monster brings the response back
    to level 4 at most; level 5 comes again if due).
  * **Rescues and triage** (`Rescues.ts`): new rubble mounds in a rescue area (a major incident's 650 m, a recent scene, a
    struck district — whose trapped are planned by the strike instead) may hold one or two people (65 %): drawn within
    220 m of the player (≤ 10; dust-covered, crouched at the foot of the mound with slabs over their legs, waving, a
    muffled call `trapped_call` every few seconds, a "Help!" bark up close), abstract farther off. Hold E beside them
    (3.5 s, faster with super strength): the dig action, dust, stones, `dig_rubble` — out they climb, thank the player and
    walk off (12 karma, 1.5 reputation). Crews reach the rest 0.3–1.5 game hours after it is over. People the monster or a
    collapse knocks down in a rescue area are injured: once they lie still they stay down (`RagdollSystem.keepDown`, an
    actor that does not get up); E carries one across the shoulders (as the cat in SmallDeeds), E (or just arriving) at
    the triage tent lays them on a cot (10 karma, 1 reputation), E elsewhere puts them down. The **triage tent** goes up at
    level 2 of a major incident (and after a strike) in an open spot outside the cordon (no building within 7 m, dry,
    flat, near a street, parks preferred): a white tent with the first-aid sign (a white cross on green), eight cots, two
    ambulances with sirens (`ambulance_siren`) that park at the kerb with their light bars going, three paramedics in
    high-vis who kneel by the cots and, one at a time, fetch someone lying out there (never near the monster or in a strike
    zone counting down): they kneel beside them for 7 s, then walk them to a cot. The treated get a triage tag (their
    clothes' trim red / yellow / green) and walk off after 40–90 s; the tent packs up 1.2 game hours after it is over.
    Markers (layer `rescue`): the nearest six trapped (amber "!"), the injured (orange dots), the tent (a green diamond, on
    the compass at any distance while carrying someone), tooltips saying what to do. ≤ 14 injured looked after near the
    player (the rest are counted and cared for out of sight). Actors of the aftermath (owner `AFTERMATH_OWNER`, roles
    `medic`, `worker`) have their own budget (not the crime layer's).
  * **Fire engines** (`FireCrew.ts`): a facade burning within 420 m of the player and not by the monster: an engine comes
    with its siren, parks in the street, two firefighters get out and hose it down (a water jet, `FacadeFires.douse`); with
    nothing left burning they stand by 90 s and leave. ≤ 2.
  * **Show, don't tell**: long-range **smoke columns** (`SmokeColumns.ts`): every collapse smokes for 3–8 game hours
    (merged within 35 m), every burning facade sends up a dark column lit from below, a struck district smokes for a day;
    ONE instanced billboard mesh (≤ 24 columns × 14 puffs + a 72-puff mushroom cloud), its own small shader (rise, drift
    with the wind, growth and fade in the vertex shader; fog; puffs at the camera fade out), compiled in the warm-up — the
    CPU only rewrites instances when a column changes. The **live news feed** (`NewsFeed.ts`, the Cloverfield trick): one
    256 × 144 render target in the scene pass's HDR format (no new programs), ≤ 5 Hz, only while there is something to
    film and a billboard within 420 m of the player: a news drone circling the monster above the roofs (after the strike
    the cloud from 2.6 km; a carcass for its first hour); the picture leaves out people, cars, street furniture, signs,
    birds, interiors, the underground and cells far from its subject, draws facades at the simple LOD, brings new cells
    and terrain tiles in a few a picture, reuses the frame's shadow map and does not recompute matrices (~1.2 ms a
    render). The billboards (slide-show screens) show it with scan lines, a blinking red dot and viewfinder corners;
    afterwards most of them show the **news** as a pictogram — a mushroom cloud over a broken skyline (the city lost), a
    check over the skyline (all clear), the monster lying before the skyline (brought down). During an incident people
    near the player stop to point and film it (a few a second); at night their phones glow (a tiny glow at the hand).
  * **The aftermath** (`Aftermath.ts`): per major incident a scene (where it raged, its worst damage = clusters of
    collapses). When it is over: cordon tape on posts round the two worst clusters (barriers with blinking lamps where
    streets cross the ring; a struck district: barriers on its streets only) for 10 game hours, a memorial on the
    pavement nearby (at a struck district's edge) — flowers, candles lit at night, a few mourners now and then who pray or
    bow — for two game days; the EMS packs up after 1.2 game hours, smoke lingers, the news shows for 8 game hours, people
    come back (the alert lifts). `onReconstruct` (the damage clusters) is the hook for scaffolding and slow repair — not
    built.
  * **The carcass** (`Cleanup.ts`; THREATS_PLAN §5.4): a monster brought down lies where it fell (`ThreatDirector.remains`,
    `Strider.downAt`) — a landmark for 5 game hours: barriers round it (42 m), people at the tape staring and filming, on
    the news feed for its first hour. Then the city removes it over 6 game hours: a mobile crane (vehicle kind `crane`: its
    cab and boom turn and lift as the model's turret and gun) parks in a street beside it clear of the body, a crew of
    three in orange high-vis and white helmets cuts it up (saw / hammer actions) tail tip first, then the head and jaw, the
    neck, the legs foot first, the trunk last (`removalOrder`); the piece being worked on shrinks out of the skin round its
    joint (`CreatureRig.cut`, a per-bone scale applied in `CreatureMesh`), the crane lifts a chunk on its hook and swings it
    over a flatbed (kind `flatbed`), which drives off with it while the next one arrives; parts cut away are no longer
    obstacles. Gone: `ThreatDirector.removeRemains`. Far from the player only the schedule runs; the share carted away is
    saved (`SaveBody.cleared`).
  * **The player leading the army** (`Command.ts`): **R** with reputation ≥ 40 — the squads within 350 m gather on the
    player and follow for 60 s (`Forces.rally` every 4 s; a soldier calls "On you!"); **T** with reputation ≥ 70 and a
    giant creature as the Tab target — two jets roar in and bomb it (`Forces.airstrike`; held up to 20 s while the army's
    jets are on a run), 150 s between calls. A refusal says why in one short line; the P screen and the help list the keys.
  * Service vehicles: kinds `ambulance` (the delivery van with light bars and a livery band), `firetruck` (the truck's cab
    with an equipment body, lockers, a roof ladder and light bars), `crane`, `flatbed` (props/vehicles.ts; light bars flash
    on the scene); the aftermath's props (`props/aftermath.ts`: tent, sign, cot, barrier, tape and posts, bouquet, candle,
    carcass chunk, hook and cable) are instanced in the shared vehicle material (`Props.ts`): no new programs, warmed at
    start. Service vehicles park close to their spot when the street network does not run right past it (`park.ts`).
  * Costs (desktop, seed 42, size 0.6; sum of `window.prof`, noisy ±1 ms): the aftermath section ~0.04 ms idle, ~0.15 ms
    with the triage scene and the feed running (a feed render ~1.2 ms at 5 Hz), ~0.07 ms with a carcass being cut up
    (crane, flatbeds, crew, 9 smoke columns, cordon, memorial); the triage scene ran at ~15.5 ms CPU / 59.5 fps, the
    cleanup scene at ~15 ms / 59 fps; the 10 s after a strike averaged 16.8 ms a frame (p95 21 ms) against 60 fps before,
    levelling ≤ 0.9 ms in any frame. Known: the feed's first picture of a place the main camera has not drawn yet costs one
    frame of 50–90 ms (its meshes are uploaded in one go), once per incident.
* Dev console: `dev.threat.spawn('robots', { dist, at, robots, bots, drones, duration })`, `dev.threat.spawn('strider',
  { from: 'river' })`, `dev.threat.strider.status() | roar(rear) | breathe() | swipe(side) | damage(zone, amount) |
  expose(zone) | die() | retreat() | skip(m) | route() | player(dist)`, `dev.threat.clock(seconds | { setting, played,
  pressure })`, `dev.threat.omen(kind)`, `dev.threat.events()`, `dev.threat.stop()`, `dev.response.level(n)`,
  `dev.response.status()`, `dev.army.status() | spawn('tank' | 'heli' | 'rifles' | 'apc' | 'truck', dist) | airstrike(x, z) |
  sim(seed) | enabled(on) | level(n) | log()` (admin console: "Army" — battle status, spawn tank / helicopter / squad /
  APC, airstrike, the no-player battle). Sounds: `tools/synthThreats.mjs` (civil siren, glitch, hostile),
  `tools/synthStrider.mjs` (footsteps, two-tone roar, breath charge, breath, tremor rumble, car alarm),
  `tools/synthArmy.mjs` (rifle bursts, autocannon, tank gun, rotor loop, jet flyby, rockets, explosions, bomb, a hit on
  the hide, distant artillery, incoming whistle), `tools/synthAftermath.mjs` (the attack warning siren, a distant blast,
  a trapped person's muffled call, digging, the ambulance's two-tone, a crane at work). The aftermath:
  `dev.aftermath.status() | rescues() | fire() | trap() | injure(n) | triage() | smoke(strength, hours) | zone(r, x, z) |
  carcass(hours) | cleanup() | news(kind) | settle() | log()`, `dev.lastResort.status() | force() | left(s) | enabled(on)`
  (`dev.response.level(5)` climbs to the countdown too).

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

### Street characters (`src/game/street`)
Eccentric people who make the streets feel lived in, near the player only. Twelve kinds: a doomsayer in a
sandwich board ("THE END IS NIGH", finger to the sky, hints at the falling star, giants from the river and
things glowing under the drains), a busker (guitar slung across the chest, open guitar case collecting
coins, a positional guitar loop), a living statue (silver or gold: body paint on skin, hair and clothes; frozen
in a pose until someone comes close — BOO!), a mime in an invisible box (white face, stripes), a juggler
(three balls in a cascade over the rig's hands, now and then one gets away and is fetched), street dancers
(headphones; on plazas and in parks sometimes a crew of three round a boombox with a beat loop), a chicken
mascot handing out flyers for a real café nearby, a conspiracy theorist (tinfoil hat, "BIRDS AREN'T REAL"
board, pacing), the pigeon lady (feeds pigeons that fly in: `Birds.feed`), a sleepwalker in pyjamas at
night, a lost tourist with a huge map asking the way to a real station or café, a neon jogger doing laps.
* **Cast** (`cast.ts`, pure, checked in `selftest.ts`): `streetSites(plan)` finds spots per cell — on plazas,
  on small park lawns / beside park paths, next to metro entrances, on wide sidewalks between the walking
  corridor and the facades — clear of the walking lines, carriageways, doors, footprints and furniture (the
  rules of `plan/terrace.ts`). `streetCast(seed, site, district, hoursAbs)` rolls per site and 1.5 h slot
  whether someone is there and who (by site kind, district liveliness, the kind's hours: busker 10–23,
  sleepwalker 0:30–4:30, jogger morning and evening …). Same seed + site + slot → same character.
* **Life** (`StreetLife.ts`, `game.street`): within 120 m the nearest cast site comes alive (one a second,
  at most 8 characters, no two of a kind within 100 m, none underground): a synthetic citizen fitting the
  part (`costume.ts`: wardrobe garments plus `humanoid/client/streetwear.ts` pieces — tinfoil hat, chicken
  head, headphones, nightcap, sweatband, sandwich board with a canvas text, guitar, city map, flyer) walks in
  from a door down the street when the spot is in view, else is simply there; sets up (`gear.ts`: guitar
  case, hat with coins, boombox, balls), performs with looping actions (`anim/actions.ts`: play_guitar,
  preach, mime_box, juggle, statue_salute / statue_thinker, feed_birds, sleepwalk, read_map, offer; dance),
  and packs up and walks off at the end of the slot (after at least 75 s) or in the rain (not the rainproof).
  Body paint goes through `CrowdRenderer.appearance`; the target frame shows their title (`Actor.title`).
* **Crowd and talk**: performers draw a few curious passers-by (they stop and watch: `PState.Gawk`) who drop a
  coin as they leave now and then (`street_coin`); the juggler bows to applause. Lines (`lines.ts`) go through
  `Barks.say` with a per-character pause: their own patter, and for the player — flying past, a giant, tiny,
  wanted, a hero or a menace by reputation, a first hello up close; `{place}` is a real name nearby.
* **Danger**: performers are actors (`STREET_OWNER`, own budget; the crime layer and Reactions leave them be).
  A blast, collapse, roar, threat, gunfire, a close power or crash, a giant's stomp, a giant player, or any
  hit ends the act at once: they say a line and become ordinary pedestrians fleeing (Reactions takes over,
  knock-downs included); their things stay on the pavement for 45 s; nobody new sets up for 60 s. A
  civil-defence siren sends them off with everyone else.
* Cost: sites planned once per loaded cell (one cell a second), a few characters stepped per frame, no lights.
  Sounds: `tools/synthStreet.mjs` (guitar loop, boombox beat, coin). Dev: `dev.street.spawn(kind, dist)`,
  `.list()`, `.sites()`, `.clear()`, `.stats()`; admin console section "Street life".

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
* Stairs (`InteriorGen.planStair`, once per building like the lift): a switchback core at the end of the long axis
  away from the lift, along a side wall — two half flights per storey (lane A up to a landing at the far end, lane B
  back to the next floor's near landing), a wall between the lanes and along the stair hall; a compact core
  (narrower, steeper) for narrow houses. Every storey the core fits gets a stair hall across that end (rooms are laid
  out short of it); flights and landings are collision ramps (`Interiors.ground`), their well is cut out of the slab
  above (`FloorPlan.stairHole`, `ActiveFloor.stairPoly`) and the ceiling below. Self test: flights inside the outline
  and reaching the next floor.
* Office ground floors: a lobby at the front (reception, waiting area), offices behind a wall; residential towers
  have flats on the ground floor too.
* Looks (`InteriorBuilder`): walls painted per room on each side (plaster texture), baseboards along every wall and
  the outline, frames round doorways, tiles to 1.35 m in baths; switchback steps with nosings and handrails;
  detailed furniture (cushioned sofas, made beds with pillows, kitchens with hob, sink, tap, wall cabinets and hood,
  bookshelves with books, plants with leaves, tables with vases and bowls, glowing lamp shades, screens), patterned
  rugs; ceiling fixtures per room (pendants in homes and cafés, round lamps in halls and baths, panels in offices).
  All deterministic per plan (seeded by position).
* Function: solid furniture blocks walking (`furnitureCollision`: footprint edges up to the piece's height;
  rugs, pictures, chairs, lamps excepted); the entrance is kept clear; **E** sits down on chairs, sofas and
  armchairs (`Interiors.seatNear`, one place per sofa cushion).

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
  ladders, and outfalls. One trunk per arterial edge (`SewerTrunk.a / b`: its junction nodes, where trunks meet
  level); under a bridge the trunk is a culvert (`culvert`, `sewerInvert(…, culvert)`: ≥ 4.6 m under the bed, a
  lower envelope with grade ≤ 0.3), so the whole city's sewers are one network (self test). No manhole lids over
  water; the player does not float in a tunnel under the river (`Collision.underground`).
* The Lumen's signs (`underground/sewerHints.ts`, pure): Dijkstra over the sewer junctions from every colony room
  off a sewer; at each junction the colony's sign (`CELL.mark + id % 4`) on both walls of the branch towards it
  (fading over `MARK_FADE` = 1600 m) and a large glowing arrow 3.2 m in; chevrons every 2.6 m along the walkway
  within `TRAIL_REACH` (900 m); within `SCOUT_REACH` (650 m) a Lumen scout may wait at a junction and flee down
  the right branch (`Slimes.setScout(…, always)`). One glow mesh for the city (`sewer-hints`).
* Sewer looks (`sewerStyle`, per trunk, deterministic): red, yellow or brown brick or concrete (culverts always
  concrete), a dark grime band at the foot of the walls (`GRIME`), worn walkways, a dark channel; 0–2 round pipes
  (`pipe()`) on brackets, one straight run per tube segment, stopping at junction openings and doorways with an
  elbow into the wall; stone ribs across the vault at 7–11 m (or none), a deeper stone portal at every junction
  mouth; outlet pipes dribbling into the channel; lamp spacing 10–16 m with some dead lamps; additive daylight
  through the manhole lids (`shaftMat`, scaled by `G.uDayLight`): the lid glowing and a pool of light on walkways
  and water — no beam geometry standing in the tunnel.
* Tunnel dressing (in the tube chunks): cable trays and a pipe along metro walls, a green
  running-figure exit sign every 60 m with a maintenance ladder at every third.
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
* The deep realm (`underground/deep`): the slime civilisation below the colonies.
  * Plan (`plan.ts`, pure, deterministic per seed, ~0.1 s): a hub colony (nearest the centre) hosts the Glow
    `GLOW_DEPTH` (64 m) under the lowest ground over the realm, the Deep `DEEP_DROP` (52 m) lower. Shapes in a frame
    (origin at the Great Hall, u along the realm's axis): the Hall (ellipsoid, flat-cut, terraced `bowl` floor, pool,
    the Spire rock column, hanging masses), Gardens, Lake (falls), Archive (mosaics), the Front gallery with the
    barricade, the Throat (shaft cylinder + dome, a `helix` rock ramp, a rock bridge to a lookout niche), the Warrens
    (pillars), the Heart chamber (mound, the shard). Roads: from a chamber wall (u+ / v± — `Road.hole`, cut by
    `buildChamber`) a narrow neck with the gate, descending steeply until the wide gallery fits under the ground, then
    a gallery (r 5.2 m, grade ≤ 0.16) to the Hall's rim, a spiral first where the way is too short for the drop.
    Colonies within 950 m get roads. Tried over hub colonies / axes / distances until clear of every tube, box and
    the station surroundings and ≥ 14 m under the ground. Decor (dwellings, mushrooms, fungus, crystals, shelves,
    strands, stones, stalactites, hives, pens, salvaged things), ~500 baked light sources, water, falls, veins, the
    lift column, and a waypoint graph whose edges are walked on the field (detour nodes round obstacles).
  * Rock (`field.ts`): one signed distance field — smooth union of air shapes, smooth subtraction of rock shapes,
    two octaves of 3D noise by the nearest shape's roughness (gentle on floors). Grid of 16 m cells listing shapes.
    Queries: `floorAt` / `ceilingAt` (sphere traced), `contains` (air with margin, closed membranes solid, no
    climbing faces steeper than 60°), `lineClear`, `ray`. Underground merges it into `floorAt`, `ceilingAt`,
    `contains`, `cameraFree` and `isUnder`; `caveLine` / `caveRay` serve `Sight.clear` and `Targeting` (probe, LOS
    in `inView`) so shots and powers work in the caves.
  * Meshes (`mesher.ts` in `deep.worker.ts`, `DeepMeshes.ts`): naive surface nets over 24 m chunks at 1 m (a chunk
    owns the edges at its base points: seamless), normals from the field, rock colour by region (moss in the Glow,
    red seams in the Deep), occlusion from the field and the light of every source in reach baked per vertex
    (`aGlow`, added as emission × albedo by the cave material); decor in the same chunk (lit parts and an unlit glow
    mesh). Built nearest first within 230 m of the camera, dropped beyond 300 m (~5 ms a chunk in the worker, ~500
    chunks for the whole realm). Faces inside the chambers the roads open into are skipped. Membranes (gates, the
    barricade), water, falls, the Heart (the origin scene's shard shader), spores round the camera, the lift column,
    the mosaics (canvas). No lights: `SkySystem.deep` (camera in the caves' air) drops the fill light to almost
    nothing and tints the haze (teal in the Glow, red in the Deep).
  * Slimes (`Factions.ts`): Lumen (dwellers with a dome to hide in, tenders, carriers, the council, children,
    guards, caravans, captives, support) and Murk (drones, raiders, brutes, jailers, the Maw, breachers) as agents
    of the areas near the player, walking on the field (turning aside at rock, steps ≤ 0.7 m) along the waypoint
    graph; fights between them, lunges and spit at the player; every Murk a `MurkActor` (ThreatActor: body, an
    exposed ember core on brutes and the Maw). Four instanced batches (Lumen blob shell / core, spiked Murk shell /
    ember core).
  * The war (`War.ts`, pure, saved): Murk strength (grows from the Heart, not while the Maw is down), Lumen strength,
    the front line; raids every 2.5–5.5 game hours — fought out live by agents when the player is near the Front,
    else decided by strength; breakouts at night when the Murk hold the Hall (`MurkBreach`, threat archetype
    `murk`: police, compass, music).
  * Trust (`Trust.ts`, per city, saved): tiers Shunned / Stranger / Noticed (gates) / Welcome (greetings, lift,
    pebbles) / Ally / Kin; grants the Slime call (`Progress.granted`, `AbilitySystem.special`).
  * The game side (`game/slimes/SlimeRealm.ts`): areas, raids, gates, pens (E), the lift, the Heart's resonance,
    pebbles, ambience, the Slime call, breakouts, toasts, saves (`SaveData.slimes`, version 3), a safety net for
    bodies below the realm. Sounds: `tools/synthDeep.mjs`. Admin console section "Slimes"; `dev.deep.go(place)`,
    `dev.deep.status()`, `dev.slimes.status() | trust(v) | raid() | breach() | war(patch)`.
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
* Marker kind `zone` (a radius `r`): a dashed ring of that size on the map and minimap (the last resort's strike zone, a
  levelled district); on the compass its nearest edge — from inside, the way out — with the distance.

### Saves (`src/game/save`, `src/ui/SaveUi.ts`)
A session can be saved and continued: `game.saves` (`SaveSystem`), stored by `SaveStore`.
* **Model** (`model.ts`, pure, tested in `selftest.ts`): one versioned JSON object (`SAVE_VERSION`; `MIGRATIONS[v]`
  upgrades v → v + 1, `parseSave` sanitises every field so a partial save loads with defaults, a newer version is
  refused): city (seed, size), mode, the character (AvatarStore id, plus a created look as a fallback), the player
  (position, yaw, size incl. the admin size override, flying, health, energy, hotbar slot; whether the spot was
  underground / indoors), camera (yaw, pitch, zoom), sky (day, hour, time speed), weather (setting, wet streets, the
  schedule skip; read from `render/Weather` — a `serialize` / `restore` pair there would take over), Progress (karma,
  ranks, hotbar, cores, bonuses), reputation, justice (heat, wanted), the threat clock and its setting, the bodies of
  defeated monsters (`ThreatDirector.remains`, laid back down settled, with when they came down and the share carted
  away) and a Strider on the move (resumed at its route position and hit points; the response at most at level 4), the map
  marker, the crime / city-event settings, the city damage, and the aftermath (`SaveAftermath`, version 2: the casualty
  ledger, levelled districts, smoke still rising, cordons, memorials, the news on the screens; migrated from version 1
  with none).
* **City damage** (`CityDamage.ts`, `codec.ts`): per damaged cell the dead elements (walls, roofs, slabs — not slabs
  only hidden by an open interior), shattered windows (not windows an interior opened) and broken slab tiles as
  index runs (gap + length varints, base64); collapsed buildings (gone, or the lower top of a partial collapse) and the
  rubble mounds. Restored into loaded cells at once and into the others as they stream in (`CityStreamer.restoreElements`,
  `Destruction.restoreBuilding` shows the storey slabs through the holes). The same bookkeeping keeps collapsed
  buildings collapsed across cell eviction. A heavily damaged district (34 collapsed buildings, 27 k dead elements) is
  ~6 KB of JSON; a save is ~1.4 KB without damage, gzip-compressed in IndexedDB, plus a ~6 KB JPEG thumbnail.
  Not kept: loose / settled debris, broken props and trees, wrecked cars, road craters.
* **Not restored on purpose**: people, traffic, robots and drones (seed + clock), running crimes, small deeds, robot
  malfunctions, omens and facade fires (they end with the session); a last-resort countdown; the trapped and injured
  still waiting (the ledger settles them: looked after meanwhile), the triage tent and the cleanup crews (they come back
  as needed). Indoors the player is put on the street outside
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
src/plan       macro, cell, building descriptors, landmarks and their parts (pure data)
src/build      geometry builders (buildings, roads, terrain, props, interiors, underground)
src/render     renderer, sky, weather (rain, wet streets, lightning), materials, textures, post
src/stream     cell streaming, worker pool
src/destruction elements, debris, structural collapse
src/player     controller, camera, scale, flight
src/sim        citizens, traffic, transit (worker) and the client-side crowd renderer
src/future     near-future layer: delivery robots, drones, animated signage, holo kiosks
src/fauna      birds: ground groups, flocks, gulls, crows (instanced, around the camera)
src/underground metro, sewers, trains, side rooms, hidden colonies, their slimes and the deep realm (deep/)
src/humanoid   Norgo human pipeline (bodies, animator) plus modern clothing
src/audio      audio engine
src/ui         HUD, menu, map
src/game/street street characters: sites and cast (pure), performers, costumes, their lines
```
