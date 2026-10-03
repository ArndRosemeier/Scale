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
src/world      terrain, water, settings
src/plan       macro, cell, building descriptors (pure data)
src/build      geometry builders (buildings, roads, terrain, props, interiors, underground)
src/render     renderer, sky, materials, textures, post
src/stream     cell streaming, worker pool
src/destruction elements, debris, structural collapse
src/player     controller, camera, scale, flight
src/sim        citizens, traffic, transit (worker) and the client-side crowd renderer
src/humanoid   Norgo human pipeline (bodies, animator) plus modern clothing
src/audio      audio engine
src/ui         HUD, menu, map
```
