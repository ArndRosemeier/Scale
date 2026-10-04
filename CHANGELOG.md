# Changelog

Every push raises the version by 0.001. Newest first.

## 0.014 — 2026-10-04

- **Origin scene**: a new game in Normal mode opens with the night it all began — a falling star breaks apart over the city, a shard lands in front of you, you touch it … and the next morning you can feel when someone needs help. About 45 seconds; hold Space to skip (after the first time, one press skips). Not on Continue or Load, not in Sandbox.
- **Smoother start**: all shaders and textures are prepared behind the loading screen, so the first seconds of play (and turning round for the first time) no longer stutter. The very first launch on a computer loads a few seconds longer; later launches about the same as before.
- Sound starts right with the game (it used to wait for the first key press).

## 0.013 — 2026-10-04

- **Consequences of the giant creature's attacks**:
  - **Rescues**: people can be trapped under fresh rubble — hold **E** to dig them out. Injured people stay down; **E** carries one over your shoulders to the medics' triage tent (ambulances, medics, cots). Karma for both.
  - **Casualty count** under the compass during an incident: evacuated, injured, trapped, rescued. Nobody dies — people are injured or trapped.
  - **Fire engines** put out burning facades.
  - **Signs of it**: smoke columns you see from across the city, a live news-drone picture on billboards, people filming; afterwards cordons, a memorial with flowers and candles, news on the screens.
  - **The carcass** of a defeated creature stays as a landmark for a few hours, then a crane crew cuts it up and trucks carry it away.
- **The last resort**: if the army fails deep in the city, a countdown starts (sirens, the strike zone on the map, a timer on every screen). Drive the creature off in time — or the district is levelled for good. The city pays in karma and reputation.
- **Lead the army** (with enough reputation): **R** — nearby squads follow you; **T** — call in a jet strike on your target.
- Saves keep all of this (levelled districts, smoke, memorials, the carcass).

## 0.012 — 2026-10-04

- **Fix**: delivery drones could hang over a door for good — two drones delivering to the same door pushed each other off the drop point. Only one drone delivers to a door at a time now, and a drone nudged off its spot still finishes.
- **Fix**: getting up from a café chair or bench facing a wall could put you inside the building; you now step off to a free side.
- **Fix**: someone lying on the street briefly stood up and fell again when you came close.

## 0.011 — 2026-10-04

- **New start screen**: full screen over an evening view of the city — the title and Continue on the left, a new city on the right. Works on small windows too (the Enter button stays in reach).

## 0.010 — 2026-10-04

- **Fix**: sitting put the body too far back and too low, so the chair stuck through it (worse for tall characters). The hips now rest on the seat for every body size; tall sitters angle their shins forward, short ones let their feet dangle. For you and for city people.

## 0.009 — 2026-10-04

- **Fix**: rooftop equipment (air-conditioning units, elevator housings, water tanks) was walk-through; it is solid now — walk around it, or jump on top. (The equipment on each roof is laid out once more, slightly differently than before.)

## 0.008 — 2026-10-04

- **Fix**: train rides got shakier and shakier — the rattle piled up over the ride. It now stays at a steady, light level, with a jolt at rail joints and a lurch when pulling away or braking.

## 0.007 — 2026-10-04

- **Fix**: in fast flight the forward arm drifted across the body and the fists crossed in front of the head; the arms now reach ahead and slightly outward (one fist ahead, both in a V when boosting).

## 0.006 — 2026-10-04

- **The army fights the giant creature** (city response levels 3 and 4):
  - **National Guard**: convoys of trucks and armoured cars, squads behind sandbag walls firing at it (tracers, muzzle flashes), searchlights at night.
  - **Army and air power**: tanks on the avenues, attack helicopters with rockets — it swats them out of the air — jets on bombing runs, artillery flashes on the horizon.
  - **A battle without you**: it goes after whoever hurts it most, wrecks vehicles and breaks squads ("the line is breaking"). The army drives it off in a bit under half of the fights — help them, or face it yourself.
  - Squads on the map and compass; Army section in the admin console.

## 0.005 — 2026-10-04

- **People's faces**: city people now vary in cheek fullness (fuller with more weight), face width and resting expression — most look neutral to friendly, a few stern.

## 0.004 — 2026-10-04

- **Character builder, face**: new sliders *Cheeks (lean – full)*, *Face width* and *Expression (stern – smiling)*. A smiling character keeps a friendly face at rest (and still shows fear, pain and surprise); a stern one a slight frown.

## 0.003 — 2026-10-04

- **Weak spots**: with the giant creature targeted, Tab cycles its body parts (weak spots first: throat, belly, then head, legs, tail); the target frame shows what you aim at and whether a weak spot is open. Powers hit the part you picked — or an open weak spot, or what you look at.
- **Fix**: power hits on the creature counted on the body part nearest to you (mostly a leg), so aimed hits on the glowing throat never counted as weak-spot hits.

## 0.002 — 2026-10-04

- **Calmer standing**: the motion-captured idle now plays at half speed (also for distant crowds).

## 0.001 — 2026-10-04

The first versioned build.

New in this build:

- **Sound mix**: pause menu → Sound mix → Adjust… — a slider per sound category (alarms & sirens, voices, traffic, destruction, powers, monsters, animals, ambience & weather, footsteps, interface), 0–150 %, remembered.
- **Version and changelog**: the version shows in the main and pause menus; click it for this list.
- **Fix**: the camera no longer swings through walls into a building from outside (next to a door).
- **Fix**: the giant creature no longer gets stuck in town — busy swatting drones froze its clock; it now always heads back after a while, and if its way back is blocked it makes straight for the river.

What is in the game so far:

- **City**: seed-driven cities from small town to metropolis — streets, bridges, a river and coast, parks, countryside with fields and forests, enterable buildings with interiors, rooftops, a rideable metro and walkable sewers.
- **Living city**: people with their own daily routines, traffic with signals, delivery robots and drones, birds, cafés and restaurants with terraces, people who sit, chat, react and talk in short speech bubbles.
- **You**: start as an ordinary person; earn karma by helping people and stopping crimes, spend it on powers (P). Punch, super strength, super jump, super speed, flight, size shift and elemental powers (laser eyes, fire, frost, ice path, lightning, stomp, whirlwind, water, shrink ray). Sit on benches and café chairs (E).
- **Crime and police**: purse snatches, muggings and shop robberies; police respond, chase and arrest; your own misdeeds get you wanted. Small good deeds: cats in trees, runaway dogs, lost wallets.
- **Threats**: robot malfunctions with a city response (police, cordons, evacuation to the metro, SWAT) and the Strider — a 40 m creature rising from the river and rampaging into downtown.
- **Underground**: side rooms along sewers and metro tunnels — and something living down there, if you look carefully.
- **Weather**: mostly fair, with clouds, rain, storms and morning fog; the city reacts to it.
- **Interface**: compass with nearby points of interest, map with your own marker and descriptions on hover, minimap, departure boards in metro stations.
- **Saves**: autosave, Continue, named saves.
- **Hidden admin console**: Ctrl+Shift+F12.

## Before versioning

- **2026-10-04**:
  - **Interface**: compass and map marker; map travel is sandbox-only; map and minimap hover descriptions.
  - **Metro**: departure boards, see-through train windows, ride sounds.
  - **Fixes**: junction pile-ups and huge crowds; people walk on bridges, not under them.
  - **Powers and actions**: punch became a hotbar power; flight boost scales with rank; sitting.
  - **City and threats**: robot malfunctions and the city response; the Strider; cafés and terraces; underground side rooms and slimes; speech bubbles; weather.
  - **Game**: real-time clock by default; saves; motion-captured idle and flight poses; admin console.
- **2026-10-03**:
  - **City**: the city, map, metro, character creator, countryside and birds.
  - **Game**: game modes and karma powers, elemental powers and targeting, street crime and police, ragdolls.
