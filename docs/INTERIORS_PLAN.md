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

Checks: `tools/homeTest.ts` (selftest section "furnished homes"), `npx tsx tools/interiorPlans.ts
<seed> <size> <count> <outDir> <floor>` writes top-down SVG plans, `preview-interior.html` shows a
storey in 3D (`?n=<building>&floor=<f>&room=<k>&top=1&type=living&still=1`).

## Phases (one PR each)

1. Filler + home theme for flats (this PR, v0.167).
2. Room splitting for any shape with reserve-first programs; offices, shops and cafés themes.
3. The starship hall (design step 1) as one reserve strategy on the core.
4. Fill the museum and the other empty landmarks (impressive halls with side rooms).
5. Town hall, cathedral and sewer side rooms on the core.
6. Delete the old builders.
