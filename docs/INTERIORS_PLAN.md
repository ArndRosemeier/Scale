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

Checks: `tools/homeTest.ts` (selftest section "furnished homes"), `tools/splitTest.ts` (section
"room splitting": odd outlines and real storeys, coverage, overlap, room size, reachability,
reservation first, desks, tables, checkouts, mirrors, counters, timing), `npx tsx tools/interiorPlans.ts
<seed> <size> <count> <outDir> <floor> [home|office|shop|all]` writes top-down SVG plans, `preview-interior.html` shows a
storey in 3D (`?n=<building>&floor=<f>&room=<k>&top=1&type=living&still=1`).

## Phases (one PR each)

1. Filler + home theme for flats (v0.169, PR #139).
2. Room splitting for any shape with reserve-first programs; offices, shops and cafés themes (v0.172).
3. The starship hall (design step 1) as one reserve strategy on the core (v0.173).
4. Fill the museum and the other empty landmarks (impressive halls with side rooms).
5. Town hall, cathedral and sewer side rooms on the core.
6. Delete the old builders.
