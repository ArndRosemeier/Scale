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
     the element; up to N rigid bodies in a Rapier ring pool
  3. the excess becomes GPU-only particles; dust uses sprites
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
  * NPCs: knock-back and ragdoll-lite

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
  cover, help, abandon the car, honk, swerve and reverse.
* Rendering tiers:
  * < 35 m: full Norgo skinned humans (LOD0/1)
  * < 300 m: GPU-instanced crowd with baked vertex-animation textures
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
  path, hydrokinesis, super speed) run as a `channel` while the key / right mouse is held.
* **Elements**: the elemental powers in the world. With a target they go for it, without one along the crosshair.
  They reuse destruction impacts (laser heat accumulates per 60 cm spot, ≤ 10 impacts/s), debris, dust, props.hit,
  traffic wrecks, reactions.knockDown and the near-future knock. Ice-path sheets are walkable through
  `Collision.extraGround`. Everything done to someone is recorded in `Consequences` (collateral ledger stub).
* **States** (`src/shared/status.ts`): frozen, shrunk, burning, stunned, wet — a WeakMap registry the sim and
  renderers read with one lookup (`statusOf`, free while nothing is affected): peds hold still / walk slower,
  cars stall, crowd instances ice-tint and stop animating, cars / robots / drones / props draw scaled.
* **ElementFx**: pooled beams (camera-facing ribbons), CPU particles (additive and alpha), procedural decals
  (scorch, ice, puddle, fissure), ice crystals and sheets; hidden when empty. `PowerSynth` makes the sounds.

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

### Interiors (`src/interior`)
* Generated on demand when the player approaches an entrance or a breach: floor plan by
  building use (apartments, offices, shops, restaurants, lobby, stair or elevator core),
  then rooms, doors and furniture by room type.
* Only the current floor ±1 is built.
* Uses the same element mechanism, so interiors are destructible too.

### Underground
* Metro: tunnels (extruded profiles), stations with platforms, stairs to street kiosks,
  and trains on analytic timetables that stop and open doors.
* Sewers: arched brick tunnels with channels and walkways under arterials, manholes with
  ladders, and outfalls.
* Terrain holes: shader discard plus a collision query.

### Audio (`src/audio`)
* Web Audio with spatial sources and an ambience mix by context: street, park, river,
  interior, sewer, metro, flight.
* Clips come from SoundStudio (`public/sounds`, see `docs/SOUNDS.md`), with procedural
  fallbacks.

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
src/world      terrain, water, settings, city outline, countryside land use
src/plan       macro, cell, building descriptors (pure data)
src/build      geometry builders (buildings, roads, terrain, props, interiors, underground)
src/render     renderer, sky, materials, textures, post
src/stream     cell streaming, worker pool
src/destruction elements, debris, structural collapse
src/player     controller, camera, scale, flight
src/sim        citizens, traffic, transit (worker) and the client-side crowd renderer
src/future     near-future layer: delivery robots, drones, animated signage, holo kiosks
src/fauna      birds: ground groups, flocks, gulls, crows (instanced, around the camera)
src/humanoid   Norgo human pipeline (bodies, animator) plus modern clothing
src/audio      audio engine
src/ui         HUD, menu, map
```
