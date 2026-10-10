# Interiors: one core that fills any space

Arnd, 2026-10-08: every interior (flats, offices, shops, landmarks, sewer rooms) should go through
one core that does the hard part of filling a 3D space sensibly, for spaces of any shape. The
caller keeps the logic of *what* goes *where*; theme helpers (living space, offices, impressive
halls with side rooms, …) say what belongs together. When everything is on the core, the old
builders are deleted.

## The seven builders before this plan (v0.166)

| Builder | Used for |
|---|---|
| `interior/design/` (`designHall`, `emitDesign`, `scifiTheme`) | the starship lobby and great hall only |
| `InteriorGen.planFloor` + `InteriorBuilder` + `Interiors` | ordinary buildings, built when you walk in: flats, offices, shops, cafés, arcades, small churches, warehouses, car parks |
| `townhallInterior` / `grandHall` / `compactHall` (`plan/landmarkParts.ts`) | the town hall |
| `plan/cathedralParts.ts` (`furnish`, `walkways`) | the cathedral |
| `underground/rooms.ts` + `RoomMeshes.buildRoom` | sewer and metro side rooms (hideouts, machine halls, …) |
| `RoomMeshes.buildChamber` / `buildCrawl`, `underground/deep/` | slime colonies and the deep realm |
| `Underground.buildStation` | metro stations |

The museum and most landmarks have no inside at all. Metro tubes and the slime realm are not
"filling a room" and stay outside the core.

## Order of decisions (themes speak first)

1. **Reserve.** The theme claims its big spaces before anything is divided: halls, voids through
   several storeys, galleries, stair and lift cores. (Rooms first would make big halls impossible.)
2. **Split.** Only the space left over is cut into rooms, by a layout strategy chosen for its shape.
3. **Furnish.** Each room is filled by its theme's rules through the filler.

## The filler (phase 1, `src/interior/fill/`)

- `area.ts`: an `Area` is a room's outline (any polygon) and what each edge is: facade with
  windows, blind party wall, inner wall (with its doors) or open; plus floor that must stay free
  (stairs, the way in from the street). `roomArea()` builds one from a storey's walls.
- `place.ts`: the `Filler`. A theme lists `Item`s in order of importance: against a wall or free,
  clear floor needed in front, tall (kept from windows), hung on a wall, flat (a rug), standing on
  another piece, companions placed with it (`kids`), and a score saying where it would rather be.
  The filler tries spots best first and keeps the first where the group fits the outline, keeps
  doorways, stairs and every piece's clear floor free, and leaves every door and every piece that
  must be reached connected by a walkway (flood fill on a 20 cm grid).
- `home.ts`: the home theme (living room, bedroom, kitchen, bathroom, hall).
- `palette.ts`: shared colours.

## The splitter (phase 2, `fill/split.ts`)

`splitStorey(storey, program, rng)` divides a storey of any outline. The storey brings its fixed
spaces (stair hall, lift lobby, kept as they are), the street front and the walls already
standing. The program brings, in this order:

1. `reserve`: bands claimed before anything is divided, measured inward from the street front
   (or the back): a depth in metres or a share of the floor's depth, `leave` (on deep floors keep
   only this much behind the band, one row of rooms) and `minLeft` (less than this left over and the
   band takes everything). A shop's sales floor, an office's open plan, a café's guest room, an
   office lobby on the ground floor.
2. `rooms`: what the rest is cut into. Leftover pieces are cut into near-rectangles at their inner
   corners, get a corridor down the middle when deep enough (`corridor`, `corridorType`), and are
   sliced into rooms from the cycle (each with a length range and an optional `max`).
3. Tidying: no room reaches into a fixed space, walls run straight, rooms too small or oddly cut
   join the neighbour they share most wall with (or become a closet).
4. Walls where spaces meet (not where a wall already stands) and doors as a spanning tree from the
   stair hall: through halls and corridors first, through `leaf` rooms (bathrooms, bedrooms,
   meeting rooms) only when nothing else reaches, never through a closet. A door goes only where a
   step through it leads from the one space into the other; a room no door reaches joins a neighbour.

Themes: `homeProgram` (home.ts: no reservation, corridor or hall with rooms on both sides) and
`workProgram` / `workItems` (work.ts): offices (lobby, open plan with desk pairs, meeting rooms,
single offices, tea kitchen, WC, store), shops (grocery: checkout, aisles, wall shelves, fridge;
clothes: fitting mirror, display tables, shelves) and cafés (counter, table sets, kitchen). The
old wing and split layouts in `InteriorGen.planFloor` are gone; churches, industry, car parks and
arcades still use their own builders until the later phases.

## Great halls (phase 3, `design/hall.ts` + `fill/starship.ts`)

`designHall` plans the section of a hall through several storeys: the void up the middle, the
gallery ring on every level, two stair columns, bridges. That is its reservation. Each level is
then handed to the core: the gallery pieces and stair wells are fixed `open` spaces (no walls
between them), the void is a `hole`, and the ring behind is cut along rays from the axis
(`Program.sectors`: neighbouring wedges join until a room is as wide as its type wants), with
doors in the middle of the gallery wall (`doorsMid`). The theme (`starshipProgram` /
`starshipItems`: quarters, labs, messes, lounges, control rooms, stores) furnishes each room
through the filler, and `design/emit` builds the pieces as landmark parts (`design/props`).
The old per-room prop recipes in `design/theme` are gone; a theme there is only materials.

## The museum (phase 4, `plan/museumParts.ts` + `fill/museum.ts`)

`design/storey.ts` (`fillStorey`) is the one way a landmark hands a storey to the core: outline,
fixed spaces, holes, program and theme items in; walls, furnished rooms (with their door and the
way out) and lights into the design out. The starship's decks and the museum both use it.

The museum's program reserves the great hall first as a `centre` band (`Reserve.at: 'centre'`: a
share of the width through the middle, front to back, the entrance in its front wall). The wings
either side get a gallery corridor with exhibition rooms, one shop, one café and a store
(`museumProgram` / `museumItems`), with wide doors (`Program.doorW`) in the middle of each wall.
Above the wings a solid block reaches the roof, so the classical hall alone rises the full height.
Exhibition pieces (display case, statue, big statue, painting, bench, reception desk) are built in
`design/props`; colours come from `museumTheme`.

## Glasshouse and airport terminal (phase 4b)

Every designed landmark registers its design in `plan/designs.ts` (`landmarkDesign`,
`landmarkRooms`). `fillStorey` also takes `entrances` (shell walls the caller builds itself, with
their openings, so the filler keeps the floor in front of them clear), `keepOut` floor and
`furnishFixed` (furnish halls the caller laid out itself). The filler takes `Item.spots`: a
free-standing piece tries only those points (a fountain in the middle of a ring path, plants
lining the paths, seat rows at a gate) instead of its coarse grid.

- Glasshouse (`plan/glasshouseParts.ts`, `fill/garden.ts`): the shell is glass panels on a brick
  plinth (polygons round the domes, the door a gap in the front panel, entrance steps), domes and
  vaults stay as roofs with a clear inner copy. Each hall is its own storey: the dome a ring path
  round a fountain with spokes to the door and the wings (a second ring in big domes), the wings
  and parallel halls a path along their axis with cross paths to the arches. Plantings: palms
  (palms, broadleaf trees, ferns, beds along the glass), desert (cacti, rocks, low palms), flowers
  (beds, small trees); plants only as tall as the hall allows. Paths are gravel over green beds.
- Airport terminal (`plan/terminalParts.ts`, `fill/terminal.ts`): the glazed hall is a shell with
  three doors under the kerb canopy. Fixed open spaces: the check-in hall along the front, the
  gate lounges along the apron, two security lanes through the band between; the core cuts the
  rest of the band into shops, cafés, a back office and stores (under its own ceiling) and
  furnishes everything: a row of check-in desks facing the doors, departures boards, scanner
  arches with bag belts, seat rows facing the glass at each gate with its desk.

Selftest section "walk-in landmarks": museums (both styles), glasshouses (all three styles) and
terminals, walked in from the ground through every door, every room passable through its door
(a security lane through each scanner), key pieces present. `preview-landmark.html?kind=<museum|
glasshouse|airport|tower|lighthouse|fortress>&seed=&size=&at=u,v,y,tu,tv,ty&still=1` renders one from a real city plan on
flat ground, outside or from a point inside.

## Tower deck, lighthouse and fortress keep (phase 4c)

`plan/lookoutParts.ts` builds the three with a walled room shell each (walls round an outline,
the door in the middle of its front edge, `wallAB` for walls between any two points) and
`fill/lookout.ts` furnishes them; every room is one `fillStorey` reserved whole.

- Observation tower: the TV tower's glass drum and the glass tower's shaft foot are a lobby round
  the core (ticket desk, lift doors on the core, souvenir racks, benches); the deck sits in the
  pod (behind the glass ring of the sphere, or in the lowest disc), in the lattice tower's octagon
  on the third-level platform (corners cut clear of the legs, the bracing no longer solid) or in
  the lower part of the glass tower's box. Decks have coin telescopes at the glass, benches
  looking out, a snack counter and tables, and a gallery with a railing round them.
- Lighthouse: the stair room at the foot (a spiral stair up through the ceiling) and the lantern
  room with the lens, its door out onto the gallery. The keeper's house moved beside the tower.
- Fortress keep: a great hall in the foot of the keep behind 1.6 m walls, up steps from the
  courtyard (throne on its dais facing the door, a long table with benches, fireplace, banners,
  armour; a ruin's has fallen stones too). Its way out leads across the courtyard and out
  through the gate.

The rooms up top (decks, the lantern room) have no way up but flying; their doors open onto
the gallery. The walk-in test follows every exit's whole way (a fortress's through the gate)
and walks each room's door from inside out, at the room's own floor.

## The twisted tower (phase 4d, `plan/twistParts.ts`)

The Twist (marvel style 3) gets its lowest blocks walkable: four storeys, or two when the
storeys are 7.8 m tall. Each storey is its block's rectangle turned by that block's twist, with
glass walls round its own floor plate and a ceiling slab under the next plate (the slab's
corners outside the next block are the ledges seen from outside). Scissor stairs go up the
middle. A flight climbs one storey along the long axis through a well in the plate above, and
the next flight starts beside where it arrives and runs back. The flights sit apart by how far
a flight's far corner swings over one storey's turn. The well is cut in the turned plate as the
flight's bounding box in that plate's frame, with glass rails round it, open at the arrival
end. The storeys get as few as fit: a narrower tower gets steeper flights, and no stairs (lobby
only) when nothing fits.

- Lobby: one open room (the tower foyer's desk and benches, the lounge's holo table and seats,
  a café's counter and tables when it is over 300 m²); the stair core is a keep-out.
- Storeys above: the stair core (flights, wells, landings, an aisle of 1.7 m beside them) is a
  fixed hub that runs out to the back facade, so the splitter never has to wrap rooms round it.
  Rooms are cut in sectors round the middle (`Program.sectors`, 16 rays turned with the
  storey). The café storey, the capsule hotel and the studios are furnished with
  `fill/starship` items and the sci-fi theme in the tower's accent colour.

The walk-in test also climbs every flight of each Twist it finds (seeds 1, 5, 9) to the top
storey with an inside.

## The helix tower (phase 4e, `plan/helixParts.ts`)

The helix tower (marvel style 1) is a round core with a glazed walkway winding up round it. The
walkway is the way up; the core has no stairs. Its storeys are discs inside a ring of walls
with as many sides as the solid core above (36, or 24 when the core is too small for a door in
each side).

- Lobby: one open foyer at the square's level, the way in from the square across from where
  the walkway starts (a quarter round with two walkways), and a door onto each walkway where
  it passes the lobby floor. The walkway starts on the ground at its own start, not at the
  landmark's floor level, which is the square's highest point.
- Up to five storeys above it, and a sky lounge under the roof. Each storey's floor is moved a
  little up or down from an even 4.5 m so that the first walkway passes it in the middle of a
  side; that is where the door is. Between the lowest storeys and the sky lounge the core is
  solid.
- Inside a storey above the lobby: a fixed hall from the walkway door to a small octagon in the
  middle, rooms in sectors round it (`storeyProgram` from the Twist: café, lounge and capsule
  hotel, studios), sci-fi theme in the tower's accent colour.
- Walking up the walkway is smooth: world/Collision stands a walker on the floor at the point
  (`Obstacle.floorAt`), not on the collision piece's top, which is the floor at the piece's
  upper end and made a 0.3 m staircase.

The walk-in test walks each walkway from the ground up past every door (no step over 0.12 m per
10 cm, as Collision stands a walker) and in through the highest door of the first walkway.

Checks: `tools/homeTest.ts` (selftest section "furnished homes"), `tools/splitTest.ts` (section
"room splitting": odd outlines and real storeys, coverage, overlap, room size, reachability,
reservation first, desks, tables, checkouts, mirrors, counters, timing), `npx tsx tools/interiorPlans.ts
<seed> <size> <count> <outDir> <floor> [home|office|shop|all]` writes top-down SVG plans, `preview-interior.html` shows a
storey in 3D (`?n=<building>&floor=<f>&room=<k>&top=1&type=living&still=1`).

## Phases (one PR each)

1. Filler + home theme for flats (v0.169, PR #139).
2. Room splitting for any shape with reserve-first programs; offices, shops and cafés themes (v0.172).
3. The starship hall (design step 1) as one reserve strategy on the core (v0.173).
4. The museum (great hall + galleries) on the core (v0.176); glasshouse and airport terminal (v0.181); tower deck, lighthouse and fortress keep (v0.183); the twisted tower (v0.230).
5. Town hall, cathedral and sewer side rooms on the core.
6. Delete the old builders.
