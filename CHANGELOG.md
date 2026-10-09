# Changelog

Every push raises the version by 0.001. Newest first.

## 0.234 — 2026-10-09

- **Less flickering inside the museum** (and the other walk-in landmarks). Four causes: the paintings in the museum (and anything hung in the airport terminal) were sunk into the thick inner walls with the canvas exactly level with the wall's face, so they were cut up by sawtooth stripes or hidden; every doorway's light frame stood exactly level with the wall's own edge, so the two surfaces fought over the jamb and it shimmered as you moved; the glass of display cases (and sleeping pods, holo tables and the great lens) sat exactly on its plinth, so the plinth's top flickered through the glass; and only the four nearest room lights are lit, which switched on and off hard as you walked past the museum's many lamps, so walls and floors blinked. Pieces along those thicker walls now stand off their face as on any other wall, frames now reach a centimetre into the doorway, glass stands half a centimetre above its plinth, and a light now fades out before another one takes its place. The great hall's lamps of the classical museum hang low enough to reach the floor.
- `tools/zfight.ts <kind>` lists where a landmark's surfaces lie in the same plane and overlap.

## 0.233 — 2026-10-09

- **You no longer fall through the Twist's upper floors.** Their floor slabs were too thin for the hero's footing, so only the stairs held you. Now every floor you can walk on up there holds. The same goes for the observation decks of the TV tower and the glass tower and the lighthouse gallery. The walk-in test now measures floors the way the hero's footing does.

## 0.232 — 2026-10-09

- **Super speed is smooth now.** Most of what was left of the stutter came from the glowing afterimages the runner leaves behind: a new copy of the whole hero every 70 ms, each with its own materials, skinned meshes and about twenty bone textures for the graphics card. On a PC that draws the same street at a steady 60 fps without them, racing ran at 20 to 30 fps with stops of up to 300 ms. Now a few copies are made once and reused, so racing costs hardly more to draw than standing. They look the same.

## 0.231 — 2026-10-09

- **Clothes shops' wall shelves hold folded clothes**, not books. The shelves along the walls of a clothes shop now carry stacks of folded clothes in many colours instead of the general store's goods, which looked like rows of books.

## 0.230 — 2026-10-09

- **The Twist has an inside.** Walk in through the door at the foot of the twisted tower into a lobby with a reception desk, a lounge corner and, in a big one, a café. Stairs in the middle climb from storey to storey. Each storey is turned a little further than the one below, like the tower, and the stairs are laid out so they still meet. Up there are about three more storeys (two in towers with very tall storeys), each with rooms round a stair hall that runs out to the glass at the back: a café storey, a capsule hotel with sleeping pods and lounges, and a storey of studios and a control room. Glass rails run round each stairwell. The blocks above stay solid.
- `preview-landmark.html` takes `&style=<n>` to pick a landmark of one style (the Twist: `kind=marvel&style=3`).

## 0.229 — 2026-10-09

- **No more looking through the world at the slime tunnels' entrances.** Where a slime colony's road leaves its hidden chamber, the wall had a square hole cut into it, but the rock tunnel behind is round and starts a little way past the wall, so its corners and edges showed the city and the sky. The opening is now a round arch that sits inside the tunnel, with a short stone lining reaching out into the rock, for every entrance. The glowing wall markings and cracks no longer hang in the opening either.

## 0.228 — 2026-10-09

- **No bare skin between top and trousers.** Since the smooth hems (0.170), every garment's edge is cut a few centimetres inside the body's ragged triangle edge, so a T-shirt and jeans that used to meet exactly at the waist left a band of skin between them (front, sides and back, down to the top of the seat). Now the inner of the two reaches well under the outer one: a shirt or T-shirt tucked into trousers, shorts or a skirt continues down inside them, and trousers under a sweater, jacket or coat reach up under it. The extra part is hidden, so nothing else changes in the look.

## 0.227 — 2026-10-09

- **The city rebuilds.** Buildings damaged by monsters, villains or you no longer stay broken forever. A couple of game hours after the damage round them stops (and with no big monster nearby), building crews move in: scaffolding with safety netting goes up round each damaged building, collapsed plots get a site fence, there is a site board, and a tower crane stands over the worst-hit building, its jib slowly turning. Round a collapsed building the scaffolding climbs as the work goes on. After 10 to 60 game hours (longer for more and worse damage) each building is whole again: walls, windows, floors, upper storeys, and its rubble cleared. That only happens while you are not looking: off screen or far away. A few broken windows are just mended quietly. A district levelled by the last resort becomes one big fenced site with cranes once its cordon is lifted, and stands again after three game days. Saves keep it all. The scaffolding leaves room for lamp posts, traffic lights and trees on the pavement.

## 0.226 — 2026-10-09

- **Super speed runs more smoothly.** Racing through the city at super speed looked like a string of small jumps with brief stops in between, even at a good frame rate. The running itself was even; the hitches came from work the game did for the places raced past: every building door passed opened its interior (a storey or two furnished each time, for a fraction of a second nobody saw), and every 40 m the sewer tunnels ahead were built in one go. Now, while you race, interiors only open for a building you are inside (doors open up again as soon as you slow down), and the sewers are built after you slow down, one piece per frame, nearest first (still at once when you are down there). The same goes for a fast low flight. Frame times also follow the screen's own clock instead of the moment the code happened to run, which removes a small jitter that was most visible at high speed. Afterimages share one material per copy instead of one per body part.

## 0.225 — 2026-10-09

- **Helping the Lumen gets you somewhere again.** Each colony's war goes on while you are away, and left alone the Murk win it within a day or two of game time: they take the Lumen's trench and then their Hall. From then on nothing you did there counted. Murk killed with no Lumen within sight gave no trust, there were no sentries left in the trench to see them, and the line only moved back after a won raid. Raids come hours apart on the game clock, which runs at real speed by default, so in practice they never came. Now every Murk you kill below ground earns trust. Clearing the Murk out of the Hall wins it back (+10 trust), and clearing them out of the trench, or off the gallery's lip, gives the trench back to the Lumen (+8): their sentries return and the trench war starts again. If you stay at the Front, the Murk storm it within a few minutes, so you can help hold the line (+8). Small gains no longer pass silently: they are added up and shown with your trust and the next step, for example "The Lumen trust you more (+2.4) — you fought the Murk · trust 14, welcome at 30".

## 0.224 — 2026-10-09

- **The player's manual is up to date again (0.224).** New in it: the animated title and title music, first person view, autorun pace, clicking minimap and compass markers to target, speech bubbles, the freeze log (Shift+F9), how ranks change the powers (area damage, shockwave reach, held-back punches), the new focus beam and seeker orb looks, the VELA concert at the stadium every evening, street bands, the landmarks you can now walk into (museum, glasshouse, airport terminal, observation decks, lighthouse, castle keep), furnished homes, offices, shops and cafés, crooks running from monsters, truces between rival organisations, the new big threats (giant worm, Leviathan, Roc, giant mech), and the new music. New pictures of the concert, the glasshouse, the airport terminal and the Roc. Help > Manual, the start screen's Manual button and the PDF all show the new version.

## 0.223 — 2026-10-09

- **Swarm creatures can be targeted.** The brood's creatures (the swarm that pours out of the manholes) were never offered as targets, so Tab, clicking on one, clicking the swarm's marker on the minimap or compass, and the phase pulse, focus beam and seeker orb all passed them by. Each creature is now a target like a monster: Tab steps through the ones nearest your crosshair (a big threat still comes first, then the creatures, then hostile people), a click picks the one under the cursor, the swarm's map marker picks a creature near it, and the single-target powers hit the one you picked (a small one dies to any of them; frost freezes it so the next hit shatters it). The friend/foe sense counts them as foes. When the creature you target dies, the target moves on to the nearest one still close by, so you can keep firing. They are not big threats: no body parts to pick with Tab, the normal targeting range, and no airstrike on them.

## 0.222 — 2026-10-09

- **No long freeze right after loading.** Your hero is dressed piece by piece over the first frames, and on a fresh browser the shaders for their clothes were still compiling when play began, so the first frame stalled until they were done (9 seconds in one freeze log). The loading screen now waits until the hero is dressed and every shader still compiling is ready, up to 20 seconds. The freeze log also missed that freeze, because it skipped the very first frame of play; it no longer does, and a long frame right after switching back to the game's tab now counts too.

## 0.221 — 2026-10-09

- **No freeze when a giant first shows up on the news screens.** The news drone's picture for the billboards left out the sewers, and with them the sewer lights, so the game had to prepare every shader in the picture a second time, all at once: about a second and a half the first time the mech fired its missiles. The lights now stay in the picture (only what the drone can't see is left out), so it reuses the shaders already prepared.

## 0.220 — 2026-10-09

- **No more long freezes when missiles hit buildings.** The giant mech's missile blasts gave the wreckage a direction that was really a distance, so pieces flew off at hundreds of metres per second, and each one made the game prepare the physics ground for kilometres around in one go: the game froze for seconds, sometimes minutes. Blasts now always throw debris at sensible speeds, debris only asks for the ground close to it, and looking up the countryside roads under the ground is much faster.

## 0.219 — 2026-10-09

- **Nobody walks or drives over a fallen bridge span any more.** When the Leviathan brought a span down, people and cars carried on along the bridge as if it were still there, through the water. Now the street over the gap counts as cut: cars and walkers plan their way round it by another bridge, a car that reaches the broken end stops and turns round, and someone walking up to the gap stops, stares at it for a moment and walks back the way they came. Once the span is mended, the way is open again.

## 0.218 — 2026-10-09

- **A new big threat: the giant mech.** After the first Strider, a 30 m war machine can stride into town, heralded by an emergency bulletin or by heavy footfalls from far off that shake the ground. It walks the streets towards the centre on two legs, each step crushing cars and knocking people over. Its shoulder pods fire salvos of twelve missiles that blast whatever they hit, its right arm is a three-barrel cannon that sweeps bursts of tracers, and its left arm is a hammer fist it smashes down on anyone close. Salvos heat it up: when it's hot it stops and opens the vents on its back, which glow and are then a weak spot (3.5 times the damage); frost while it vents shuts it down for a few seconds. The cockpit is always a weak spot (twice the damage), and enough damage to the legs brings it down on one knee for a while. Badly hurt it walks off; destroyed it sparks, topples forward and lies smouldering where it fell for a few game hours. The army fights it wherever it goes. The admin console has a "Giant mech" section, and `dev.threat.mech` has tools for testing.

## 0.217 — 2026-10-09

- **Clothes shops look like clothes shops again.** Since the interior work they had only a few display tables, a rug and pictures, so they looked like a flat. Now they have rails of hanging clothes down the floor and along the walls, a couple of dressed shop dummies by the window, a few tables of folded clothes and wall shelves, plus the counter and the fitting mirror (E there changes your look).
- **Fewer clothes shops.** Only one in three of the shops that used to be clothes shops still are; the rest are general stores. Arcades stay where they were.
- `preview-interior.html` takes `&clothes=1` to step through clothes shops only.

## 0.216 — 2026-10-09

- **First person view.** Zoom the camera all the way in with the mouse wheel (or pinch) and one more notch takes you through the hero's eyes: the head, hair and hat fold away (in fast flight the forearms too, so the outstretched fist doesn't cover the view), you see your arms and body when you look down, and the body turns with the view, so A and D strafe and S backs up. It works on foot, in flight and at giant size. While first person is on, the hero casts no shadow (a headless shadow looked wrong). Knockdowns, the manhole climb and other scenes still show the hero from outside. One notch out returns to the closest third person view.

## 0.215 — 2026-10-09

- **A freeze log.** Once the game is running, any moment it stops for more than half a second is recorded with what was going on: which parts of the game ran and for how long, work done between frames (city cells arriving, crowd bodies, autosaves), what the browser itself reports about the slow frame and which scripts it blames, whether memory dropped sharply (garbage collection), and where you were and what was happening. The first freeze of a session over a second shows a short note. **Shift+F9** saves the log as a file (this session plus the last few freezes from earlier ones, which survive a reload) to send with a bug report. The Shift+F11 box now also shows how many freezes there were and when the last one was.

## 0.214 — 2026-10-09

- **"Spawn at the nearest bridge" now really comes to your bridge.** The Leviathan only ever planned its way along one river (the one with the most bridges) and to at most three of its bridges, so standing on any other bridge it went to the nearest of those, often a kilometre or more away, and seemed to do nothing. With the admin button (or `dev.threat.spawn('leviathan', { near: true })`) it now picks the river of the bridge nearest you and comes up it to that bridge, surfacing right away. Only bridges at the very edge of the city, outside its reach, still fall back to the usual way.

## 0.213 — 2026-10-09

- **A new big threat: the Roc.** After the first Strider, a giant bird of prey, 40 m from wingtip to wingtip, can come to town. It is heralded by a far-off screech from high up, or by the bird itself crossing the sky far above with its shadow sweeping over the streets. It comes in from beyond you, circles overhead screeching, then picks what to do. It may perch on the roof edge of one of the tallest buildings nearby (landing on a lower one breaks its top floor), spread its wings over the street and beat them: the gusts knock people down and throw benches, bins and debris about, and it pecks at whoever comes close. It may stoop on a car, a bus by preference, carry it up high and drop it. It dives on helicopters and drones, and rakes whoever hurt it most with its talons in a low pass. A whirlwind, or enough damage to its wings, tumbles it out of the sky onto the street for a few seconds with its head low; its head is the weak spot (three times the damage) while it screeches or is grounded. Hurt badly it flies off; brought down it falls and lies where it fell for a few game hours. The army fights it wherever it goes. The admin console has a "Roc" section, and `dev.threat.roc` has tools for testing.

## 0.212 — 2026-10-09

- **Street accidents back to one every 3 to 6 minutes.** The doubled rate from 0.210 turned out to be too much in play; the earlier drought was a run of bad luck.

## 0.211 — 2026-10-09

- **The focus beam hits like a blow, and the seeker orb got a glow-up.** Looks only: damage and energy costs are unchanged. The focus beam now has a wide golden haze round its white-hot core. Rings of air ripple away along its path, and a flash and a ring leave your eyes when it fires. Where it lands you get a white flash, a shock ring across the surface, sparks thrown back, chips and dust kicked up, and a heavier camera shake. A ring rolls out across the ground, and a well-charged shot lands with a thud. The seeker orb is now a white-hot heart in a violet glow with a soft halo, three sparks circling it, little arcs crackling off it and a smooth comet tail behind it. It leaves your hands with a flash and bursts on its target with a violet flash, shock rings and a spray of sparks.
## 0.210 — 2026-10-09

## 0.210 — 2026-10-09

- **Street accidents twice as often.** Someone near you trips and falls every 1.5 to 3 minutes instead of every 3 to 6, so a young hero who cannot fight yet has a steady source of karma from helping people up. They still only happen where you can see them.

## 0.209 — 2026-10-09

- **A new big threat: the Leviathan.** After the first Strider, a river monster can come up the river with the most bridges. It is heralded by a long V of foam moving up the river, or the water heaving and boiling beside a bridge with a deep surge. Under the surface it shows as a long V of foam with a low surge you hear from the banks, and drivers on the bridges ahead stop. At up to three bridges, and the quays between them, the water heaves and it rears its head 12 m out of the river with six tentacles round it. The tentacles pull cars off the deck and fling them into the river, hammer the deck until a span falls in (two per visit at most), sweep people off the promenade and swat helicopters and drones. The head roars and snaps at whoever fights it; its open maw is the weak spot (four times the damage). Frost freezes it fast for a few seconds, icy mist smoking off it. Hurt badly it goes back down the river; beaten, it slumps and sinks. You can only hurt it while it is up, and the army fights it from the banks. Fallen spans stay open for a game day and are rebuilt once you are far away; they are saved with the game. The admin console has a "Leviathan" section, and `dev.threat.leviathan` has tools for testing.

## 0.208 — 2026-10-09

- **Super jump landings leave cars whole.** Coming down from a high super jump on or right next to a driving car used to flatten it. At about human size a landing now leaves cars intact. Only a giant's foot (a body over 6 m) still crushes them, as before.

## 0.207 — 2026-10-09

- The concert's sky searchlights are wider and fainter, shafts of light in the haze instead of hard white sticks.

## 0.206 — 2026-10-09

- **The background music makes way for street musicians.** Within about 30 m of a busker, a street band or a dance crew's boombox, the score fades out, so the two pieces no longer play on top of each other. It comes back once you are about 40 m away, or when they pack up.

## 0.205 — 2026-10-09

- **Concert lights, after the check on Arnd's PC.** The colour beams now reach just to the ground and fade out there, so there are no more bright round caps where they land. They stay over the field instead of sweeping out across the stands. Every beam and searchlight has a soft glow cone round it in place of a hard edge.
- **The stands read at night:** the seated crowd is brighter after dark, and during the songs phones are held up and swaying in the stands. A slow song gets more of them.
- dev.concert.stop() during the evening now means no show tonight (it used to start a new one straight away).

## 0.204 — 2026-10-09

- **The concert now plays Arnd's own VELA songs** (Lyria 3 Pro, with vocals): City of Lights, Neon Heartbeat, Paper Wings, Hold On to the Night, Gravity and Rise. **The street bands play his folk, bossa and swing pieces**, each turned into a seamless loop. The lights and the crowd follow each song's measured beat. The ballad is read at its real slow tempo, not double time.
- **The show is longer, and each night's set fits the evening.** Doors now open at 18:00 and the band plays from 19:00 to 23:00. The songs run at their real length, which is longer than those four game hours allow at the usual time scale, so each night plays the opener, the closer, and as many of the other songs as fit, in a different order every night.

## 0.203 — 2026-10-09

- **A concert at the stadium every evening.** The act is VELA. Doors open at 19:00, the band plays from 20:00 to 23:00, and the crowd has gone home by about 23:45.
  - **The stage:** a deck at one end of the pitch with a roof, speaker stacks and a crush barrier. Behind the band is an LED wall that shows the act, the song title and a spectrum that moves with the music.
  - **The lights:** colour beams sweep the crowd on the beat, searchlights sweep the night sky, blinders flash on the big beats, pyro fires at the opener and the finale, and a front light shines on the band.
  - **The band:** a singer, guitar, bass, keys and drums. The singer walks the stage and talks to the crowd between songs ("How are you doing, …?!"), and the band bows at the end.
  - **The crowd:** the pit in front of the stage fills with real people who dance on the beat, cheer between songs and leave through the far gate afterwards. The stands fill with a seated crowd.
  - **The music:** you hear it from far across the city, softer and more muffled the further away you are, and the score goes quiet near the show. The songs and their running order come from public/music/live.json. Until Arnd's Lyria songs are built with tools/music/build_live.py, pieces of the score stand in for them.
  - **Trouble ends the show:** an explosion, a monster, gunfire, an evacuation or a hit fan stops the music, and everyone runs for the exits.
  - Console commands: dev.concert.start(), go('pit' | 'stand' | 'stage' | 'far'), next(), panic(), stop().
- **Street bands:** a trio (guitar, bass and a cajón player sitting on the box) plays on plazas, in parks and at metro stations from late morning until late evening. A few people stop to listen, and you can talk to them. They play folk, bossa or swing loops once those are built, and the street guitar until then.

## 0.202 — 2026-10-09

- **A new big threat: the giant worm.** After the first Strider, a 95 m worm can come instead of a strider or a swarm. It is heralded by a rumble underfoot with cracks running along the street, or a pothole that suddenly caves in. It tunnels under the main roads from your side of town towards downtown: cracks, dust and a rumble run along the street above it, drivers stop and the metro waits. Now and then the street bulges and caves in, and the worm rears 30 m out of the sinkhole. It roars, slams down on whatever is near, snatches cars and people, bites and swats, then dives back in an arc and opens a new hole further on. It comes up beside you when you are close, and a heavy super-jump landing above its head brings it up stunned. Its maw is the weak spot (four times the damage). The army fights it only while it is up. Hurt badly it flees underground; beaten, it topples across the street and lies there for a few hours. The sinkholes stay a while and are filled once you are far away. Cars drive around them and people walk around them. They are saved with the game. The admin console has a "Giant worm" section, and `dev.threat.burrower` has tools for testing.

## 0.201 — 2026-10-09

- **Fixed a memory leak that let long sessions run out of memory.** The body of every person who walked past stayed in memory for good, about 3.5 MB each. On a PC, ten minutes of fast travel added over 1.5 GB. Bodies nobody has used for 30 seconds are now freed; the 24 most recent ones stay for quick reuse.

## 0.200 — 2026-10-09

- **Factions, step 4: the villain groups' feelings for each other change by themselves.** Each street fight between two groups deepens their feud. When two rival groups are both hunting you, they draw closer every game hour, and after about six hours they call a truce. A toast tells you: "… have called a truce — against you". During a truce they stop brawling and stop pushing into each other's turf. Once one of them stops hunting you, old habits come back within a few hours ("The truce is over"). Every pair also drifts slowly back towards its usual feelings. Truces and feuds are kept in save files.

## 0.199 — 2026-10-09

- **Factions, step 3d: rogue machines ask the table.** Robots, service bots and drones gone rogue go for you and for people only if they are hostile to that faction. The seeded table makes that everyone, as before, so nothing plays differently. This finishes phase 3: crews, the army, the Murk and rogue machines all decide who to fight or run from through the one table.

## 0.198 — 2026-10-09

- **Factions, step 3c: the Murk ask the table.** Murk breaking out into the street go only for people whose faction they are hostile to. Below ground they go for you and for the Lumen the same way. In the seeded table that is still everyone, so nothing plays differently yet. Changing one number would make them leave a whole faction alone (police, for example).

## 0.197 — 2026-10-09

- **Fix: crooks really run from monsters now.** In 0.195 the faction table had no entry between crews and the monsters or the Murk, so crews never actually scattered. Now monsters, the Murk and rogue machines are enemies of every crew, and a new test checks the real table.
- **Factions, step 3b: the army asks the table too.** The army now goes after a big threat only if it is hostile to that threat's faction. Today that means the same two foes as before: the Strider, and you while you rampage as a giant. Changing one number would now be enough to keep the army out of a fight.

## 0.196 — 2026-10-09

- **Click a marker to target it.** Clicking a dot or "!" on the minimap or the compass now makes what it stands for your target, the same as Tab or clicking it in the world: a criminal, a getaway car, a rogue machine, a monster, a police car, someone you met. It works for anything within targeting range, even if it is out of sight or behind you; as with Tab, a target that stays out of view is let go after 5 seconds. Markers for places (a grave, a memorial, the spot the loot goes back to, someone trapped under rubble, someone only known to be "somewhere around here") never target whoever happens to stand there. Clicking anywhere else on the minimap still opens the full map.
## 0.195 — 2026-10-09

- **Factions, step 3: crooks run from monsters.** Until now a mugger kept mugging and a gang kept brawling with a Strider right next to them. Now every crew at work, from a street thief to a boss operation, looks round twice a second. When a threat their faction is hostile to comes near (a monster, a swarm, the Murk), they drop what they stole and scatter away from it. The bigger it is, the farther off they run: about 20 m for the Murk, 110 m for a Strider. A crime that had not started yet is called off. One that had started ends without the group gaining turf. If you had already knocked someone down, it still counts as stopped. Runaway saucers don't scare them. The friend/foe table decides who runs from whom, so a group could later be made fearless or loyal to a monster by changing one number.

## 0.194 — 2026-10-09

- **The aliens have their own music.** When a Warden's disc hovers, watches or stares over you, or a walker comes down close by, "Visitors Overhead" plays: shimmering glass, a soft choir and a quiet hint of the hero's horn. It's wondering rather than threatening, and it plays once like the other calm pieces. It starts a few seconds after a disc settles over you and stays a little while after it leaves. The runaway teens' saucer is still a chase, with the tension music.

## 0.193 — 2026-10-09

- **Memory no longer creeps up over long trips through the city.** Trips the city's people had planned near a place you left were dropped, but their empty places in the queue stayed until the trip's time came, game hours later. When you travel fast, these piled up. The queue now packs itself once more than half of it is empty, and trips far away are dropped every second, even while game time stands still.

## 0.192 — 2026-10-09

- **Area powers hit people harder as they rank up, not only wider.** Before, a fireball, fire wave, laser, chain lightning or water jet did the same to a person at every rank. Now the damage grows with the rank, from rank 1 to rank 5:
  - Fireball: 28 to 58 at the centre, half that at the rim. It used to be 53 at the centre at every rank, so rank 1 is weaker now and rank 5 a bit stronger.
  - Fire wave: 20 to 38, up close.
  - Laser eyes: 18 to 35 each time someone falls.
  - Chain lightning: 14 to 25 for each person it strikes.
  - Hydrokinesis: 21 to 41 when the jet knocks someone down.
  - The shockwave (27 to 60), seismic stomp (26 to 53), whirlwind (22 to 50), super speed and punches already grew with rank.
- Higher ranks also throw people a little farther. Slipping on an ice path still hurts the same at every rank, as it depends on how fast the person was walking.
- The Powers table in the help shows the new numbers.

## 0.191 — 2026-10-09

- **Factions, step 2: every faction's feeling about the hero is in the table.** Each value is read live from the system that already keeps it, so nothing is stored twice and nothing plays differently: civilians = reputation; police = friendly, wary of a suspect, hostile while you are wanted (more at higher levels) or rampaging; army = hostile only against a rampaging giant; each villain group = its notoriety (hunting you is the hostile line); Lumen = their trust; Wardens = their regard (10 per problem handed over). Your own feelings, which the friend/foe sense uses, stay as they were. In the dev console, `dev.factions()` lists every faction's feeling about the hero and `dev.factions(true)` the whole table.

## 0.190 — 2026-10-09

- **Autorun keeps your pace.** Press R while holding Shift and the hero keeps sprinting (in flight: keeps boosting) after you let go of Shift. Started with Alt held, autorun stays at a slow walk; started plain, it runs at the normal pace. Holding Shift or Alt during autorun still changes the pace while held.

## 0.189 — 2026-10-09

- **Factions, step 1: one table of who is hostile to whom.** Every side in the game (civilians, police, army, the hero, the sidekick, street crooks, each villain group, Lumen, Murk, Wardens, runaway teens, monsters, rogue machines) now has a relation to every other one, as a number from −100 to +100; −50 or lower is hostile. The civilians' feeling about the hero is the reputation itself. For now the numbers repeat today's rules, so nothing plays differently: the friend/foe sense and the villain groups' turf wars ask the table instead of their own lists. Later steps will move the hero's other standings into it and let the numbers change.

## 0.188 — 2026-10-09

- **Less memory used by the people of the city.** Until now, every building you passed queued its residents' trips for the next six game hours (about 18 real minutes) and kept them after you left. Driving or flying around the city piled them up and pushed the browser toward its memory limit. Now trips are queued two game hours ahead and are dropped when you move away from a building or its block unloads. The same number of people walk the streets.
- Shop signs no longer keep a copy of each building's floor layout after they are placed, and the cache of residents' day plans is smaller.

## 0.187 — 2026-10-09

- **Super strength punches no longer knock out anyone in one blow.** From rank 2 on, a punch hit a person with the full force that smashes walls, which did thousands of damage: one punch took out anyone, bosses included. A punch now takes at most 22, 30, 40, 52 or 65 health off a person by rank (an ordinary punch still does 12). It is still the hardest single hit in the game, since you have to get close for it: at rank 5 a thug goes down in one punch, a lieutenant in two and a boss in three. A giant's punch hits harder in proportion to its size. Walls, cars and monsters still take the full force.
- The Powers table in the help shows the new punch damage.

## 0.186 — 2026-10-09

- Tests only: the "room splitting" speed check allows 60 ms per office, shop or café storey (about 21 ms alone), and the brood's speed check takes the fastest of three runs against 1.5 ms. Under a full parallel test run, other workers sharing the CPU no longer make them fail.

## 0.185 — 2026-10-09

- **The shockwave no longer flattens everyone in it.** Until now, every person in the blast took the full force that breaks walls: 900 to 15 000 damage, a sure knockout for anyone, bosses included. Now a person takes 27 to 60 at the centre, depending on rank, and half that at the rim. That still knocks people down, about as hard as a fireball does. Walls, cars and monsters still take the full blast.
- **The shockwave's reach is shorter**: 45, 60, 80, 100 and 130 m by rank, down from 80 m up to 800 m, so you can no longer blow up a building from across the city.
- **Chain lightning does less to monsters**: 22 points per second of stun instead of 40. At low ranks it used to do several times more damage per energy against monsters than any other power.
- The Powers table in the help shows the shockwave's new damage.

## 0.184 — 2026-10-09

- **The title music starts as soon as the start screen shows.** It no longer waits for a click wherever the browser lets a page play sound by itself. Chrome and Edge allow that on sites you have played on before, so it will usually start right away on apps.futuremagic.de. On a first visit, and always in Safari and Firefox by default, browsers block sound until the first click, tap or key press (moving the mouse doesn't count), and the music then starts with that first input.

## 0.183 — 2026-10-09

- **Observation towers have a lobby and an observation deck.** Walk into the glass drum at the foot of the TV tower, or the foot of the glass tower, and you're in a lobby round the core with a ticket desk, lift doors, souvenir racks and benches. Up top, the deck sits behind the glass ring of the pod, in the lowest disc of a stacked tower, in an octagon on the lattice tower's platform, or in the lower part of the glass tower's box. Each deck has coin telescopes at the glass, benches looking out, a snack counter and tables, and an outdoor gallery with a railing round it. You get up there by flying and walk in from the gallery.
- **The lighthouse can be walked into.** The door at its foot opens into a round room with a spiral stair going up. At the top, the lantern room holds the great lens, and its door opens onto the gallery. The keeper's house now stands beside the tower, so the door is clear.
- **The fortress keep has a great hall.** Climb the steps from the courtyard into a stone hall with the throne on its dais facing the door, a long table with benches, a fireplace, banners and suits of armour. A ruined castle's hall also has fallen stones in it.
- Interior core, step 4 of 6 completed (`docs/INTERIORS_PLAN.md`). The walk-in self-test now covers these three landmarks too: it follows a fortress's way out through its gate, and walks each room's door at that room's own floor height.

## 0.182 — 2026-10-09

- **New music throughout the game: Arnd's Lyria pieces, in the style of the title theme.** The old background music, built from short AI layers, is gone. Every mood now plays a real piece:
  - Calm: a light orchestral day theme and a nocturnal night theme, with two of each taking turns. There is a dark piece under the city (sewers, metro) and a soaring one for fast flight. Calm music still comes in episodes: one whole piece, then silence until the next.
  - Danger: a chase loop for tension, which switches to a harder version when the danger is very close. There is a huge battle loop for giant monsters and full fights. These loop without a seam for as long as the fight lasts.
  - After a fight with casualties, a cello elegy plays.
- **New moods.**
  - A villain theme plays when a named boss's operation or a cult's rite is close by, instead of the chase music.
  - The war under the city gets its own slimy battle music.
  - Out past the city's edge by day, a pastoral piece plays.
  - Inside a landmark (cathedral, museum, town hall, starship …), a quiet piece for the grand halls plays.
- **Cues.**
  - A short victory fanfare plays when a threat you were fighting is beaten near you. The fight music stops at once instead of holding on.
  - A tender piece plays while the drones carry you to the hospital.
  - A somber one plays under the game over screen.
  - The origin scene has its own score now, lined up so its impact lands with the star's. It plays out into the first seconds of the game, and is cut short if you skip the scene.
- **The busker's guitar, the boombox and the statue's fanfare** are real recordings now (Lyria) instead of synthesized sounds.
- Long pieces stream as they play, so they cost no memory. Only the danger loops are decoded, and only when they are needed. `tools/music/build_tracks.py` builds everything from the source tracks: it trims them, evens out their loudness, finds a loop point that falls on a bar, and cuts the stings. Dev: `dev.music.cue('victory')`.

## 0.181 — 2026-10-09

- **The botanical glasshouse can be walked into.** Go up the steps and through the door in the front: inside are gravel paths between green beds, a fountain in the middle of the dome with a ring path round it, and palms, broadleaf trees and ferns lining the paths, with flower beds along the glass and benches to sit on. The wings or side halls each get a planting of their own: a desert hall with cacti and rocks, or a flower hall with beds and small trees. The palm house's dome opens into its wings, and the three parallel halls are joined by arches. Plants are only as tall as each hall allows.
- **The airport terminal can be walked into.** Three doors under the kerbside canopy lead into the check-in hall, with a row of check-in desks and bag belts, departures boards and seats. Two security lanes with scanner arches and bag belts lead through a low band of shops, cafés and back rooms to the gate lounges along the glass, where rows of seats face the apron and each gate has its desk and sign.
- Interior core, step 4 of 6 continued (`docs/INTERIORS_PLAN.md`). New `preview-landmark.html` shows a walkable landmark from a real city, inside or out.

## 0.180 — 2026-10-09

- **Less memory: the game's tab holds about 1 GB less after a while of travelling.** Building meshes, the crowd's baked animation and the facade and street texture sets used to stay in the tab's memory a second time after they had been handed to the graphics card. Now each is kept once, on the graphics card. Buildings that start hidden (the detailed version of far blocks, the simple version of near ones) are handed over within a few frames of arriving, one per frame. Measured on a real PC (size 1, four minutes of travel): the tab's JavaScript heap fell from 3.7 GB to 2.8 GB (Chrome's limit is 4.2 GB) and the tab's process from 6.0 to 5.0 GB; the graphics process grew by 0.3 GB. Frame rate unchanged, fewer long frames. Nothing looks different.
- **Sounds are decoded when first heard.** All thirteen ambience beds (sea, sewer, metro, rain, …) used to be decoded at start and kept, about 85 MB, even where you never hear them. Now each is loaded when it first becomes audible (it fades in as before), and any sound or bed not wanted for 90 seconds is dropped and loaded again when next needed. Headless after four minutes of travel: 11 MB of decoded sound instead of 85 MB.
- A building that comes down now rebuilds just its own outer walls to cut the falling part from (a self-test checks that this gives exactly the same pieces as the block's mesh).

## 0.179 — 2026-10-09

- **New title music: "Dusk Awakening", Arnd's heroic main theme.** It starts with a soft fade-in after your first click or key on the start screen and loops while you choose a city. It plays on through the loading screen and fades out as the game begins. It streams in only when it starts, so the page doesn't load any slower. It follows the volume, mute, music switch and music level from the settings (and `?mute`).

## 0.178 — 2026-10-09

- Tests only: the "room splitting" speed check times each office, shop or café storey three times and counts the fastest, so other test workers sharing the CPU no longer make it fail.

## 0.177 — 2026-10-09

- **UFOs over the start screen.** Three flying saucers circle high over the city with running lights round their rims and a glowing dome. Every half minute or so one sinks a little and sweeps a green scanning beam over the roofs.
- **Watch out.** Every 40 to 75 seconds (the first time about 12 seconds in) a saucer comes in from far over the skyline, picks up speed and dives straight at you, its glowing belly filling the screen. Then there is a green flash and the camera jolts. Once you have clicked or pressed a key on the page, you also hear it: a wobbling hum rising to a shriek, then a whoosh as it passes. There is no sound with `?mute`, and no dive with reduced motion switched on.

## 0.176 — 2026-10-09

- **The museum can be walked into.** Climb the steps, go through the big door in the middle of the front and you're in a great hall that runs to the back, the full height of the building in the classical museum. A big statue stands in the middle with benches round it, and there are display cases, plants, large paintings and a reception desk just inside the door. Either side, a gallery corridor leads to exhibition rooms with paintings round the walls, display cases, statues and a bench, plus a museum shop, a café and a store room. The modern glass museum gets the same inside under its glazed walls.
- Interior core, step 4 of 6 (`docs/INTERIORS_PLAN.md`). The room splitter can now keep a hall down the middle of a building, and one shared storey helper fills the starship's decks and the museum alike.

## 0.175 — 2026-10-09

- **Voices are speech bubbles now, not synthesized sounds.** A mugging or bag-snatch victim shows "Help!" in a bubble over their head instead of the robotic cry. If they are out of sight, the cry appears low on the screen with the direction it came from ("Help me!" (from behind you)). The same goes for people trapped under rubble, a shopkeeper shouting after a robber, officers warning a gunman or you, the mad bomber, a lost dog's owner calling, people stumbling ("Oof!", "Whoops!"), a villain's charge yell and the beast master's whistle, and the call to your sidekick.
- **Animals speak in small italic bubbles.** Cats ("Meow!"), dogs and attack dogs ("Woof!", "Grrr!", "Yip!"), pigeons, gulls, crows and sewer rats show their call as a bubble instead of a sound. Bird calls come less often so the sky doesn't fill with bubbles.
- Protesters keep their drum, but the chanting is only in their red bubbles. Booing is in their bubbles too. The café terrace loop keeps its cups and cutlery, without the babble.
- Kept as sounds: screams, crowd cheers, crowd murmur ambience, monsters, slimes and the alien teens' robot giggle, since none of these try to be words.
## 0.174 — 2026-10-09

- **An animated title.** On the start screen the letters of SCALE rise from the street like towers going up. Their faces are lit facades glowing warm towards the bottom, like the sunset city behind them, and a red beacon blinks on the L. Every 16 seconds a golden glint runs across the word and it swells for a moment, like the size power, with a flash of light along its base. Plain CSS, no shaders. With reduced motion switched on, the title stands still.

## 0.173 — 2026-10-09

- **The starship's rooms are planned and furnished like every other interior.** Round the great hall the rooms are no longer one wedge each with props at fixed spots. The ring behind each gallery is divided by the shared room splitter: quarters and labs one wedge wide, messes and lounges two, one control room per deck. Each room is furnished by the shared filler: sleep pods head to a wall, lockers and racks along the walls, consoles with their stools, holo tables and mess tables with stools in the free floor. Doorways and the way in from the gallery stay clear.
- Interior core, step 3 of 6 (`docs/INTERIORS_PLAN.md`). The starship's old room recipes are gone.

## 0.172 — 2026-10-09

- **Offices, shops and cafés are laid out and furnished for real.** Every floor of a flat, office or shop is now divided by one shared room splitter that works for any outline (an L, a triangle, a round end, a skewed block). The theme claims its big space first: a shop's sales floor along the street front, an office's open plan, a café's guest room, a lobby on an office's ground floor. Only the rest becomes rooms. Open-plan offices get rows of paired desks with monitors and chairs, plus meeting rooms with their table, single offices, a tea kitchen, a WC and a store. Grocery shops get a checkout by the door, aisles and wall shelves; clothes shops their fitting mirror (E still changes your look there), display tables and shelves; cafés a counter and table sets by the windows, with a kitchen behind.
- **Every room can be reached.** Doors are placed so every room opens onto the stairs, a hall or a corridor; you only walk through a bedroom, bathroom or meeting room when nothing else reaches it, never through a closet. Rooms too small to use join the room next to them.
- Interior core, step 2 of 6 (`docs/INTERIORS_PLAN.md`). The old wing and split floor layouts are gone.

## 0.171 — 2026-10-09

- **Super jump and super speed swap karma prices.** Since super jump became a travel power it is worth more than super speed, so it now costs what super speed cost (40 / 50 / 75 / 105 / 150 karma per rank) and super speed costs what super jump cost (20 / 30 / 45 / 70 / 100). The help's Powers tab shows the new prices.

## 0.170 — 2026-10-08

- **Clean shirt necklines and sleeve edges.** Garments ended exactly on the body's triangles, so necklines, sleeves and hems ran out in jagged teeth (in close-up, light shirts and contrast trims showed a white sawtooth fringe), in WebGL and WebGPU alike. Each hem is now cut along a smooth line just inside those teeth, at an even depth, and the skin under the hem stays drawn so the cut never opens a gap. Trims follow the same smooth line. Cloth smoothing now only lifts the fabric off the body and no longer slides it sideways, which had bent the cut line.

## 0.169 — 2026-10-08

- **Flats are furnished so they make sense.** Furniture no longer sits at fixed spots in each room's box. The sofa stands against a wall with room in front of it, away from the door, with the coffee table, rug, a lamp and an armchair round it, and the TV goes on the wall across from it, facing it. The bed's head is against a plain wall with a nightstand on each side and a picture above it, the wardrobe has room to open, and the desk stands under the window. The kitchen counter runs along a wall without windows with the fridge at one end, and the table with its chairs stands in the free floor. Nothing stands in a doorway any more, tall pieces keep clear of windows, and every door and every piece you need to reach can still be walked to.
- **Every room opens onto the corridor.** In flats with a corridor each room now has its own door onto it (doors used to be spaced evenly, so some rooms had two and others none), and a sliver left at the end of a row joins the room next to it instead of becoming a tiny room of its own.
- **Interior core, step 1.** The furnishing goes through a new shared filler (`src/interior/fill/`) that every interior will use in the end: it works in rooms of any shape, and themes say what belongs together. Plan: `docs/INTERIORS_PLAN.md`. A storey is now built one per frame as you walk in, so entering a building doesn't stall.

## 0.168 — 2026-10-08

- **The player's manual is up to date (0.167).** It now covers everything since 0.098: the Hero tab (tights and masks) and the three costumes on F1–F3, the new help (H) with changeable keys and the Powers tab, energy costs instead of cooldowns, the three Energy powers and the friend/foe sense, super jump as a travel power, the reworked shrink ray, open-ended reputation and the Living legend, arrest as a public menace, the street and the tunnels as separate worlds, and two new chapters: *Lights in the sky* (the Nannies, their walkers and the joyriders) and *Your sidekick* (the second shard, trust, talking, the info panel). Ten new screenshots, including the living start screen. 32 pages as PDF (Help › Manual, or Manual on the start screen).

## 0.167 — 2026-10-08

- **A living start screen.** The old still picture behind the menu is gone: you now look over a city at dusk, gliding slowly round its downtown. Windows light up and go dark, cars stream through the streets, red beacons pulse on the tallest roofs, aircraft circle high up, and now and then a hero streaks past the skyline. The camera leans a little with the mouse. Every seed has its own skyline: type a new seed and the city fades over to it.
- It is up within a moment of opening the page, before the game itself has finished loading: a small separate scene with four little shaders, made in a few milliseconds. It stops and frees the graphics card as soon as you enter the city, and pauses while the character creator is open. Without WebGL 2 the old picture is shown instead; with reduced motion switched on in the system the city stands still.

## 0.166 — 2026-10-08

- **No more screams at every landing.** Travelling by super jump, each touchdown made the people round about take fright and scream (the long scream, several times a minute), with nobody hurt and nothing on the map. Now someone of human size landing hard only startles people: they flinch and turn to look. A giant or a monster coming down still makes them scream and run.
- **Being knocked over is not a scream.** Someone knocked down just now no longer counts as a screamer (a fall is a fall).

## 0.165 — 2026-10-08

- **Super jump builds up speed in the air.** A forward leap no longer shoots off at full speed. It starts as a jump and picks up speed as it flies, reaching its top speed (18 / 40 / 80 / 120 / 200 m/s at ranks 1 to 5) about three seconds in, near the top of a high leap. As a travel power it is now a little slower than a boosted flight: bounding on from landing to landing averages 14 / 25 / 46 / 77 / 138 m/s, against flight's 14 / 28 / 54 / 90 / 159 m/s.

## 0.164 — 2026-10-08

- **Three new single-target powers (new "Energy" group).** They hit only the one they are aimed at: no fire, no bystanders, nothing broken on the way.
  - **Phase pulse** (tap, 20 energy): passes through walls, cars and people to your target, even one that ducked out of sight a moment ago. Weaker than the laser and short-ranged (25–60 m). Never between the street and the sewers.
  - **Focus beam** (hold, then let go): gathers a beam behind your eyes for up to 1.5 s (the charge bar fills), then one heavy shot. 15 energy on the press, up to 45 at a full charge; a shot that cannot go off gives the energy back. Best against monsters' weak spots.
  - **Seeker orb** (tap, 30 energy): a ball of energy that flies round corners and over buildings to its target and bursts only on it. Needs a target. When it can't see its target, it climbs over the roofs, flies across and drops onto it. It grows a little with distance so you can follow it.
- **Friend/foe sense, bought per power.** Laser eyes, shockwave, fire wave, fireball, frost nova, chain lightning, seismic stomp, whirlwind and hydrokinesis each offer it on the powers screen, for the price of that power's first rank. With it, the power harms nothing that would cost you reputation: only criminals still in the fight, monsters and rogue machines are hit; bystanders, police, cars, props and buildings are left alone (the laser beam passes through people in the way, chain lightning only jumps to foes). A giant loses the sense: above normal size every power hits everything again. In the sandbox it is a free switch.

## 0.163 — 2026-10-08

- **One way to find the nearest person.** About a dozen places searched for the nearest passer-by, officer or soldier with their own loop and their own idea of who counts, and some forgot something. Small fixes come with it: the sidekick no longer keeps away from an officer who is lying knocked out, and a mad bomber and the rescue scenes no longer pick someone who is no longer there. A self-test keeps new copies out.

## 0.162 — 2026-10-08

- **Super jump is a real travel power.** Hold W while you leap and the jump now carries you forward: the higher you climb, the faster it goes, up to 18, 39, 72, 120 and 200 m/s at ranks 1 to 5 (it was 12 m/s at every rank). Bounding on from landing to landing now covers ground at least as fast as a boosted flight at the same rank (flight 14 / 28 / 54 / 91 / 159 m/s, super jump 14 / 29 / 55 / 94 / 161 m/s even pressing Space a little late on each landing). A top-rank leap clears about a kilometre. A long leap stops on landing instead of skidding down the street, a quick hop still only moves you a little, and without W the jump is the same straight climb as before. The energy cost is unchanged, and landing beside someone at human size still costs no reputation. The Powers table shows the leap speed per rank (`npx tsx tools/travelsim.ts` measures it).

## 0.161 — 2026-10-08

- **Fix: the hero no longer gets stuck at turns in tunnels.** Walking from a platform into the underpass, the hero could stand stuck at the right-angle turn just inside its mouth until facing exactly down the next stretch. Underground, a body pressed against a wall only slid along the map's north-south or east-west axis; against a wall at an angle to them (most tunnels) both ways led into the wall and the hero stopped dead. Bodies now slide along walls at any angle, in the metro, its stairs and underpasses, the sewers and the caves. The metro audit and the self-test now walk every stair and underpass both ways like a player who cuts the corners: before the fix 38 of 50 passages in one city stopped such a walker, now none.

## 0.160 — 2026-10-08

- **Far fewer fall cries.** Someone tripping in the street now happens every three to six minutes instead of every one to two, the first one not before a minute and a half, and only within about 35 m of you (it was up to 60 m), so you can see who fell.
- **Screams come from whoever got frightened.** When people take fright, the scream used to be played at the first frightened person in the whole city, often someone already lying knocked down somewhere else. That made screams seem to come from people on the ground with nothing happening. Now it comes from one of the people who just got scared.

## 0.159 — 2026-10-08

- **Behind the scenes: the self test runs in under 3 minutes instead of about 17.** It is now split into 69 independent sections that run side by side, one worker per processor core, the slowest first. `npm run test:quick` runs only the sections that touch what you changed, for quick checks while working; the full `npm test` is still required before every merge (docs/CONVENTIONS.md, "Tests: which command when"). No check was dropped or shortened.
- **Cities are planned about twice as fast.** Laying out the metro sampled the ground along every sewer again for each metro line; it now does that once. The cities come out exactly the same, so loading a new city is a bit quicker too.

## 0.158 — 2026-10-08

- **Fights in the sewers stay in the sewers.** When a villain cast frost, an orb, an EMP or a fireball, when a mad bomber threw a bomb, or when a gunman missed someone underground, the scorch marks, frost, chips and the bomb itself landed on the street above. They now land on the sewer, metro or cave floor where the fight is. People knocked down underground also no longer quietly vanish: you can find them and help them up like anyone on the street.
## 0.157 — 2026-10-08

- **Shrink ray reworked.** It now works on everything, monsters included, and the same way for all of them. Small things still shrink by the rank's factor (rank 1 halves a person), but the ray never takes more than 1 m off something's biggest dimension at rank 1, up to 5 m at rank 5: a car loses a metre, the 99 m long Strider loses 5 m of length (about 5 %). Monsters (Strider, awakened tree, runaway saucer, Murk) visibly shrink, and their reach and hit zones shrink with them, instead of just taking some damage. Anything shrunk deals 10 % less damage per rank (50 % at rank 5): punches, guns, spells, robots, monster stomps and swipes. Shrunk targets no longer take extra damage.

## 0.156 — 2026-10-08

- **Thinner lips, and a lip thickness slider.** Everyone's lips were too thick: the average mouth is now noticeably thinner, for city people and new heroes alike, and the coloured lip area is tighter. The creator's Lips slider (Face tab) is now "Lip thickness (thin – full)" and goes from thin lips to full ones, on women and men alike. Saved with the character like every face slider.

## 0.155 — 2026-10-08

- **Three costumes, on F1, F2 and F3.** At the start all three are your hero's look. The fitting mirror in a clothes shop now changes only the costume you are wearing, so you can keep, say, street clothes on F1 and your hero suit on F2 and switch anywhere in the city. The three costumes are kept in your saves. The keys can be moved in the help (H, Keys). The detailed info line (frame rate, position) moved from F3 to F4.

## 0.154 — 2026-10-08

- **Tab only offers what your powers can actually reach.** The Tab list, the click pick and the fire wave each checked line of sight their own way: they ignored cars and holes blasted in walls, so Tab could lock onto someone behind a bus that the power then refused to hit. Now they all use the same line of sight as the powers and every shooter. People behind cars are no longer offered, targets behind a blasted-open wall are, and the fire wave no longer burns through parked cars. Also fixed: shooters and powers could fire through the solid parts of landmarks (town hall, stadium, attractions); those now block the line.

## 0.153 — 2026-10-08

- **Character creator works in WebGPU mode.** With `?gpu=webgpu` the creator showed only a grey capsule, because its preview still drew with the old WebGL renderer, which cannot show the WebGPU materials. In WebGPU mode the preview now uses a WebGPU renderer too. WebGL mode is unchanged.

## 0.152 — 2026-10-08

- **Fair credit against monsters.** The Strider and the last-resort strike judged differently whether the hero had earned the win. Now both use one rule: the monster was angriest with the hero, or the hero did at least a quarter of the fighting it remembers. Rogue and hijacked machines also count the hero's last blow the same way, with the same 6-second window. The Maw only rewards the hero (and raises the Lumen's trust) when the hero brought it down. Behind the scenes, every monster books its anger and armour through one place, and a self-test keeps it that way.

## 0.151 — 2026-10-08

- **The camera stays inside narrow tunnels.** On metro stairs, in the underpasses and at every turn of a tunnel the camera could slip through the wall and show the empty void outside. The drawn walls pinched in at each turn (a right-angle landing was about 30 % narrower than the space the camera and the hero were allowed in); they now keep their full width round the corner. Going down from the street, the camera is no longer lifted above the pavement before you count as underground, the camera's anchor never sits inside a low ceiling, a screen shake never pushes it through a wall, it no longer sinks into a raised platform or slips behind the walls at the underpass mouth, and near the top of a stair it keeps clear of the street overhead. In a headless walk down every stair and underpass of two cities, the camera left the tunnel in 11 % of frames before and 0.04 % now (`npx tsx tools/camsweep.ts`).

## 0.150 — 2026-10-08

- **Fix: landing a super jump next to someone no longer costs reputation.** At about human size, coming down beside a pedestrian now only makes them stumble and call a stern word after you, just like brushing past them at super speed: no harm, no reputation, no wanted level. A giant hero's landing still counts as before.

## 0.149 — 2026-10-08

- **Every good deed is rewarded the same way.** Each kind of rescue and win used to hand out its own mix of karma, reputation, cheers and stats, and each one forgot something different. Now they all go through one reward step. Anything that ends a crime, a den, a monster or a whole event counts as "stopped" in your stats, makes people nearby cheer, and calms the police a little. This now also applies to bringing down the Strider, stopping the awakened tree, beating back the brood or the rogue robots, catching the runaway saucer, calling off the last-resort strike and bringing down the Maw. Rescues count as good deeds, and surface slime brutes earn a little reputation like brood beasts. A self-test keeps rewards in one place.

## 0.148 — 2026-10-08

- **No more floating outside the city.** Out in the countryside the hero (and everyone else standing on the ground) stood 35 cm above the grass: the terrain is drawn a little lower than its height so it never shows through the city's streets, but walking used the undropped height. The ground height now follows what is drawn: open land at the drawn terrain, country roads, village squares and farmyards at their surface. Inside the city nothing changes.

## 0.147 — 2026-10-08

- **Fix: police and army stomps no longer count against the hero.** When a soldier's or officer's footstep knocked someone down, the game booked it as the hero's doing, which could cost reputation and raise the wanted level while the hero only stood by. A giant police or army step also no longer hurts the slime brood or a monster as if the hero had stamped. When the police shoot a rampaging giant hero, the hit now counts as theirs instead of the army's. Behind the scenes, "who did it" now uses one vocabulary everywhere, and a self-test keeps it that way.

## 0.146 — 2026-10-08

- **Behind the scenes: one "is this person underground?" question.** Two dozen places asked it by hand (crimes, threats, wardens, saves, markers, the manhole prompt); they now ask the underground system the same way. Nothing changes in play; a self-test keeps it that way.

## 0.145 — 2026-10-08

- **Fix: Seismic stomp now hurts giant creatures.** Its crack pushed them with a capped shove, so at every rank it did only about 3 points to the Strider or the awakened tree. Now they take the quake's full force at the legs: 10 points at rank 1, 27 at rank 2, 60 at rank 3, 120 at rank 4 and 213 at rank 5 (before armour). The power table in the help shows the new values.

## 0.144 — 2026-10-08

- **Fairer dice for the police and the slime war.** Patrol officers and the officers stepping out of a car used a home-made random generator whose numbers slowly got worse; they now use the game's own. The deep slime war rolled with the browser's dice, so a loaded game could go differently each time; it now rolls from the city's seed. A self-test catches the broken generator if it comes back.

## 0.143 — 2026-10-08

- **The power table in the help (H, Powers) now shows damage.** Every rank has a Damage column: the health a person loses (and how: per punch, per fall, everyone in the blast, at the rim or the centre …) and the points a giant creature takes before its armour. A new line on top gives what that means: a passer-by has 36 health, a mugger 55, a robber 80, lieutenants ×1.8 and bosses ×3.1; the Strider has 3000 points, the awakened tree 1000, with their weak spots and the tree's weakness to fire. The numbers are the ones the game itself uses, so they stay right when powers are rebalanced.

## 0.142 — 2026-10-08

- **Delayed effects keep game time.** The distant boom after a last-resort blast, the army's artillery and whistles, the ritual's second burst, the car alarms after a tremor, the hospital fade and a startled passer-by's cry were timed by the browser's clock; on slow frames they ran ahead of the game. They now wait in game time, and a self-test keeps wall-clock timers out of gameplay.

## 0.141 — 2026-10-08

- **Behind the scenes: crooks make up their minds in one place.** Every crime (muggers, taggers, robbers, gangs, cults, the den, the bomber, the procession, the snatcher) had its own copy of "after each blow: fight, run or give up"; they now share one, each keeping its own rule (the tagger runs first, a guard defends the door, …). Nothing changes in play; a self-test fails if a crime grows its own copy again.

## 0.140 — 2026-10-08

- **Shift+F11: shader counter.** A small box at the top (off by default) shows how many shaders were compiled in the last 10 seconds, the shader cap, and the longest frame, in WebGL and WebGPU.
- **Hard cap on new shaders.** Once loading is done, at most 5 new shaders start per second, and at most one mesh's worth per frame. Anything new that would need more stays hidden until there is room, so things can pop in a little later instead of the game freezing. URL `&shadercap=N` changes the limit (0 turns it off); in the console `shaderCap.maxPerSecond = N`.

## 0.139 — 2026-10-08

- **No more fall cries out of nowhere.** The everyday accidents (someone trips and needs a hand up) now only happen to people you can actually see: on screen, not behind a building, and never while you are indoors or underground. So when you hear an "oof", you see who fell. Before, they picked anyone 15 to 60 m away, often behind you or round a corner.

## 0.138 — 2026-10-08

- **Behind the scenes: one sRGB conversion.** Skin, eyes, garments, street props, the wardrobe, furniture and trees each converted their authored colours to linear light with their own copy; they now share one. Colours look exactly as before; a self-test fails if a new copy appears.

## 0.137 — 2026-10-08

- **Behind the scenes: 3D vector maths has one home.** Eight files had their own add, subtract, dot, cross, length, normalise and blend helpers for 3D points, and four more typed out cross products by hand; they all use the shared versions now. Nothing changes in play; a self-test fails if a typed-out cross product or a copied helper comes back.

## 0.136 — 2026-10-08

- **Behind the scenes: geometry has one home.** Polygon area, bounds, point-in-polygon, edge distance, polyline length and reversal, the angle difference and two vector helpers had been written again in 22 files under other names; they now all use the shared versions. Nothing changes in play. A self-test now compares function bodies, not names, and fails if a new copy of a shared geometry helper appears.

## 0.135 — 2026-10-08

- **WebGPU (`?gpu=webgpu`) no longer stutters after loading.** The distant forest no longer prepares a shader for every patch of trees as you move, and every car model is prepared behind the loading screen instead of the first time it drives by. In the first minute of play, hitches over 50 ms dropped from 36 to 7, the worst from 217 ms to about 150 ms. Loading takes about 7 s longer for it. Auto quality stepping up no longer freezes the game for several seconds (on WebGPU the shadow map keeps the size it started with). WebGL is unchanged.

## 0.134 — 2026-10-08

- **Behind the scenes: small helpers have one home.** Text shown in menus and panels is escaped by one shared function, and the small maths helpers (clamp, lerp, smoothstep) come from one module instead of a dozen local copies. Nothing changes in play; a self-test now fails if a new copy appears.
- **A second copy finder for developers.** `npm run repeated` lists functions copied under a different name and code pasted into several files.

## 0.133 — 2026-10-08

- **Hitting a car is on the record now.** Wrecking a car with a punch, a shockwave or a dash used to cost nothing, unlike the same wreck by a power; now it is booked like any other harm (a dent costs only on a police car, a wreck in front of witnesses as before). Cars flattened under a giant hero's feet are booked too, and those under a monster's or the army's feet go to them.
- **Car damage has one helper.** Eight places added damage to cars by hand; one of them could even repair a car that was already wrecked. They now share one helper, and the selftest fails if a new copy appears.
- **`npm run dup`** runs the duplicate finder from Arnd's Toolbox over the code and writes `reports/duplicate-candidates.md`.
## 0.132 — 2026-10-08

- **Nobody gets placed in the river any more.** Police firing spots, monster and robot spawns, crooks, protesters and the press, street performers, the Wardens and the runaway teens' stand-off spots, mourners, cordon barriers and rescue spots now all use one shared test for "can someone stand here": no building, no landmark, no open water. Bridges count as dry land everywhere now; some systems used to treat them as water.
- **One water test for everything.** The map, the army, pedestrians, small deeds and saves used four slightly different shore margins; they now share one helper, and the selftest fails if a new private copy appears.
- **Shader twins are guarded:** the selftest fails if a GLSL shader file has no WebGPU twin naming it.
## 0.131 — 2026-10-08

- **Your blows no longer reach through the pavement.** A stomp, blast, punch, dash or shove on the street used to knock down people in the sewer or the metro station right below you; now only those on your side of the street go down (and the other way round from below).
- **Dashing into someone is booked once, with who it was.** A speed dash used to add a second, nameless entry to the record of what you broke, so knocking over a mugger could still count as hurting a bystander.
- **New docs/CONVENTIONS.md:** the one helper to use for each common question (same side of the street, sight, screen position, the harm ledger), the start of the code-duplication clean-up.
## 0.130 — 2026-10-08

- **WebGPU renderer (try it with `?gpu=webgpu`).** The game can now draw with WebGPU instead of WebGL. WebGL stays the default and is unchanged. On WebGPU the city, people, cars, trees, street furniture, sky, weather and effects look the same as on WebGL, and shaders are compiled in the background, so loading is close to WebGL (about 23 s vs 17 s on the test PC). It still stutters for a few seconds after loading and when new kinds of pedestrians appear, runs at about 42 fps where WebGL holds 60, and hero tights patterns and mask cut-outs still show as plain cloth there; those are next.
- **Auto quality also measures the GPU on WebGPU**, so it picks the right quality level there too.

## 0.129 — 2026-10-08

- **The runaway saucer is fairer.** It now always comes down over a street lined with houses instead of over a park, where the Nannies used to spot it before its first prank. Joyriding on its own it slips across open stretches and through the discs' scan cones unnoticed, and it only bolts when you actually come at it, not when you just stand there. Once it is hurt or on the run, open sky or a cone gives it away, so chasing it into a cone works. Knock out a pod and it bolts for the tallest streets nearby: roofs tall enough still hide it, low ones give it away, and with every pod lost fewer streets are tall enough. The third pod pops it up over any roof.
- **Brighter and clearer up close.** The rim lights now glow in strong magenta, green, yellow and blue with a soft halo, by day and at night, and the pods no longer turn white after dark. The hull is visibly battered, with dents, scorch streaks and riveted patch plates. The two kids in the dome have bigger heads with glowing eyes. Glyphs go only on walls without a street tree in front and never on top of one another, the kids don't play the same trick twice in a row, glyphs are easier to see by day and take a little longer to draw, and a column of light now joins the parent disc to the bubble it lifts the saucer in.

## 0.128 — 2026-10-08

- **Reputation has no upper limit any more.** It used to stop at +100; now every good deed keeps counting, however famous you already are. Past +150 the city calls you a *Living legend*. Everything that reacts to your reputation (cheering crowds, the press, fans, the statue, what strangers think of you) works as before and is at full strength from +100 on. The bottom stays at −100. Saves keep reputation above 100.

## 0.127 — 2026-10-08

- **Click your sidekick to see how they are doing.** Clicking (or tapping) your sidekick opens a small see-through panel above the target frame. It shows their name, their mood, what they are doing right now (around you, fighting, keeping back, flying, in hospital…), their health and trust, the karma they have put by and what they are saving for, and every power they have learned with its level. The power the shard gave them is marked. The panel closes with the target (Esc or another click).

## 0.126 — 2026-10-08

- **The Strider no longer stands frozen in town for minutes.** When it got held up on the way in (the army fighting it hard), it started its rampage wherever it was, and with no high-rise near enough it simply stood still for over four minutes. If it got stuck again on the way home it finally sank into the ground on the spot, which looked like it vanished. Now it always finds something to do: it looks further for a tower, takes lower blocks when there are no high-rises around, goes after the army or you when there are no buildings to attack, and otherwise walks on into downtown and roams there. A tower it has already leaned on, or can't bring down after a while, no longer keeps it waiting either: it moves on to the next one.
- **Long console output is copied to the clipboard.** When the admin console cuts a result off (like the Strider's status), the full text is now on your clipboard, ready to paste into a bug report. The Strider's status also shows its rampage state near the start.

## 0.125 — 2026-10-08

- **The help dialog (H) is new, with three tabs.** **Keys** shows the controls in tidy groups (moving, powers, doing things, screens) instead of one long list, and every key can be changed: click a key, press the new one. Each action can have two keys; a key you take from another action is freed there and the dialog tells you. Your keys are kept in this browser, and **Reset to defaults** brings the old ones back. The hotbar, the powers screen and the hints show your keys. The iPad's on-screen controls are not affected. **Powers** lists every power with its exact numbers for each rank (effect, energy, karma price), taken straight from the game's own values, plus the energy, flight, giant-body and karma rules; your current rank is highlighted. **Manual** is the player's manual, readable right in the game (with a link to the PDF).

## 0.124 — 2026-10-08

- **Nothing hurts through the pavement any more, by one rule.** Every blow in the game now says where it came from, and your health ignores any that come from the other side of the street. That covers fists, knives, bats, guns, bombs, villain powers, dogs, robots, monsters, the army, cars and collapses, including any added later. Fighting in the sewers, the metro or the caves works as before; nothing up on the street can hurt you down there, and nothing down there can hurt you up top.

## 0.123 — 2026-10-08

- **Fix: Tab targeting works underground.** In the sewers, the hideouts and the metro stations, Tab found nobody, because the street overhead counted as a wall between you and everyone down there. Now the tunnel and room walls are what block the view, so Tab and clicking pick out people and crews down there, and your aimed powers can hit them. The street above still can't be targeted from below, and nobody below from the street.
- **Fix: the street and the tunnels no longer reach through each other.** Down in the sewers and the metro, fire, frost, fireballs, lightning and quakes no longer hit people and cars on the street above (or the other way round), and your shockwave and flames work against the tunnel walls instead of the street overhead. Police on the pavement can no longer club or cuff you through the ground, and the officers and witnesses up there no longer see what you do below, so hiding underground can lose your wanted level. Monster footfalls, army shells, dog bites and collapsing buildings above no longer hurt you in a tunnel, a blast in a sewer no longer knocks people over on the street, a whirlwind spins up on the tunnel floor, and flying chips no longer jump up to the street.

## 0.122 — 2026-10-08

- **No more cooldowns on powers: they cost more energy instead.** You can use any power again as soon as you have the energy for it. To keep things fair the powers cost more: Fire wave 30 → 40, Fireball 32 → 40, Frost nova 35 → 55, Chain lightning 30 → 38, Seismic stomp 40 → 55, Whirlwind 35 → 50, Shrink ray 25 → 30, Shockwave 55–70 by rank (was 40–55), dash in flight 18 → 22, and the Slime call 70 / 60 / 50 by rank (was 25, with a wait of up to 75 seconds). A hotbar slot now darkens while you are short of the energy for that power, so you can see when it is ready.

## 0.121 — 2026-10-08

- **No more shaking arms when you stop running late in a session.** The breathing motion of the chest sped up and slowed down with your speed, and after a few minutes of play every stop made the chest, and with it the arms, shake for a second or two. Breathing now changes pace smoothly, however long you have been playing. Tails swaying on other creatures had the same problem and are fixed too.

## 0.120 — 2026-10-07

- **Runaway saucer.** Now and then two Warden kids steal a small, battered saucer and go joyriding low between the houses, where the roofs hide them from their parents' station. Before it happens you may see one zip down a street or find a glowing glyph on a wall. While they are out they play pranks: they beam up a parked car and drop it on a low roof, lift someone off the pavement and set them down in a fountain, or draw big glowing glyphs on a facade that stay lit for a long time. The saucer whines as it flies, giggles after a prank, and people point, laugh or grumble about it.
- **Get them caught.** The Nannies never chase their kids under the roofs, but if the saucer is out in the open sky for a couple of seconds, or crosses a disc's scan cone, they have it. Chase it and punch out its three glowing hover pods: each one lost makes it fly higher, and with all three out it bobs up over the roofs like a cork. Getting close also makes them flee, sometimes into the open. Then a big parent disc comes down, holds the saucer in a bubble with a stern tone and lifts it away.
- **Handing them over pays.** If you knocked out a pod or were close when they were seen, you get karma, a little reputation and cheers, and the news reports that you handed the saucer back. The Wardens quietly remember every problem you hand them. If nobody catches the kids, they fly home on their own after a while and the news writes about cars on roofs instead.

## 0.119 — 2026-10-07

- **Your sidekick earns karma and learns new powers.** They earn karma of their own by knocking out bad guys, winning fights at your side and helping people up who were left lying. They spend it themselves on powers that suit who they are: fireballs and lightning for the curious and outgoing, a ground quake, a shoulder charge and more strength for the hard-headed, a stunning flash and a shield for the dutiful, a blast of wind and toughness for the nervous. A message tells you what they learned. In a fight they mix their powers, using whichever fits and switching between them rather than repeating one, and raise a shield when they get hurt.
- **Talk to your sidekick about the two of you.** Press E next to them and pick "About the two of us…": ask how they are getting on (their powers, their savings, how much they trust you), give them some of your karma, perhaps with a wish for a power they might learn (whether they listen depends on their trust and their character), or ask them to help you, stay back, go home for now or come with you. They say yes or no in their own way.
- **Trust.** Your sidekick's trust in you grows with time together, gifts, fights won side by side and when you help someone close to them. It drops when you knock down people near them, when you leave them alone in a losing fight, or when you push them into something that is not them. A wary sidekick may not come when you call (K). If they leave you because the city turned against you, they keep their powers and karma for when you win them back.
- **Fix:** a sidekick no longer takes off and lands again and again when you stand in water; they hover nearby instead.

## 0.118 — 2026-10-07

- **The Nannies are here.** The Wardens' station hangs high over the city like a second moon: a pale ghost against the blue by day, a dark shape with slow lights crawling round its rim at night, hidden by thick cloud and fog. Their silver discs cross the sky: usually a handful, some hours none at all, and now and then, for no reason anyone knows, a swarm of a hundred or more with festive lights, then an empty sky. Discs come down to hang over a street and sweep it with a pale scan cone, gather high over a crime or a fight and watch it to the end without ever helping, hang over a landmark for hours, and turn a cone on you when you fly high or grow giant. Now and then a disc sets a tall robot walker down on a square with its beam; it stands there for a while, looks around (at you, if you come close), takes a few slow steps and is lifted away again. People look up at the cones, crowd round the walkers and film them, grumble or joke about the Nannies, talk about them when you chat, and the news reports swarms, walkers and long stares. The discs hum as they pass and chime when a cone comes on.

## 0.117 — 2026-10-07

- **Your sidekick is around.** Once you have given someone the second shard, they become a full companion: they hang about nearby (not glued to your heels), fly to keep up when you go far, land close to you, and if you leave them far behind they catch up out of sight and fly in rather than popping up.
- **They fight in their own way.** When a fight breaks out near you they join in with punches and now and then their own power, which the shard picks by who they are: fireballs or lightning for the curious and outgoing, a ground quake for the hard-headed, a stunning flash for the dutiful, a blast of wind for the nervous. The awakening tells you which one they got. The proud and hard go for the leader, the nervous first shout people clear, everyone else jumps straight in, and they say so in short bubbles.
- **Press K to call them** (touch: "Call sidekick" under More). They come at full speed and stay close for a while.
- **They stay out of trouble with the police.** If the police are after you, your sidekick keeps their distance and tells you so; they never fight officers and their actions never cost you reputation.
- **When they go down,** the hospital's med drones lift them away to be revived. Most come back after a while, but one time in five the revival fails. Then the city mourns them, they get a grave with their name in a cemetery (shown on the map), and about a day and a half later news of another glowing stone comes in.
- **The second shard is easier to find and take.** On the map it now has its own glowing crystal mark (also in the legend) instead of looking like a power core, walking into it takes it just like a core, a clear "You carry the second shard" label shows while you have it, and offering it is the first choice when you talk to someone.
- **Your sidekick no longer gets stuck on parked cars.** In a fight they could land on a car roof and freeze there; they now always come down on the street.

## 0.116 — 2026-10-07

- **Every slime colony leads down into its own realm.** A city now has 2–3 hidden colonies, all near the centre, and none is a dead end any more: each opens into a deep realm of its own with its own Lumen home, its own Murk lair and its own war. Each realm's battleground is different, chosen per city: a single trench line, a double line, a chasm with one rock bridge across no-man's land, flooded craters, or a Murk siege wall with a crystal forest and hive towers. Width, depth and the Murk's lane vary too. Wars in the other realms go on while you are away. Murk that cannot walk straight at you (over their berm, across the chasm) now go round to reach you.
- **The Lumen's sewer signs are much easier to see.** Big glowing arrows on both walkways at each junction, wider chevrons along the way that never fade below 60%, and bigger, brighter colony signs on the walls at eye height.

## 0.115 — 2026-10-07

- **Every sewer ladder leads out.** About one manhole shaft in twelve lay outside every city block, so standing at its ladder never showed the E prompt. Every shaft now has its E prompt from the start, and its lid lies on the street of the nearest block. The decorative maintenance ladders on the metro tunnel walls, which led nowhere, are gone.

## 0.114 — 2026-10-07

- **Traffic lights no longer throw an error after the road network rebuilds.** When the city streamed new streets in or dropped far ones, the traffic lights still on screen kept the old network's junction numbers for a moment (or for good, if no light of that kind was near you any more), and reading their colour hit a junction that no longer existed. The console showed "[props] TypeError … reading 'signal'". The lights now switch to the new network in the same frame, and lights that are no longer drawn are forgotten.

## 0.113 — 2026-10-07

- **Aliens plan, decided points.** The Lumen slimes are the old ones who came long before the Wardens and get cryptic speech bubbles; the number of discs in the sky is random, now and then a sudden unexplained swarm of a hundred; beating a Warden first raises their interest in you, then no longer, then lowers it more with each further win. Nothing in the game changes yet.

## 0.112 — 2026-10-07

- **Plan: aliens.** A design plan for the aliens who already live alongside us (docs/ALIENS_PLAN.md): the Wardens, mostly robotic nannies who watch from discs and a station in the sky and never meddle, and the forbidden kinds who sneak in anyway (runaway teens of their own species, smugglers selling alien tech, old ones living underground). Nothing in the game changes yet.

## 0.111 — 2026-10-07

- **No more shimmering arms far out in the city.** The further you went from the centre of the map (super speed takes you far), the more arms, hands and clothes could shimmer, because the skin was computed in world coordinates with too little precision. It is now computed relative to the character, so it looks the same everywhere.
- **Smoother stop from a run.** The arms no longer straighten and bend again while you come to a halt.

## 0.110 — 2026-10-07

- **A second shard.** Once your reputation reaches +30 (or after a short while in the sandbox), the news reports a strange glowing stone in one of the city's parks or squares. The area shows up as a circle on the map; nearer in, a soft glow at the edge of the screen and a hum lead you to it, and a pale column of light rises from the stone. Sometimes a gang has got there first and guards it: deal with them before you can pick it up.
- **Give it to someone.** Carry the shard and talk to anyone: a new option offers it to them. Most people say yes. Children, people at work, people who dislike you or are against heroes on principle say no, and some have something they need help with first (do that favour and they will take it).
- **Your sidekick awakens.** The shard floats into them, light floods out, and they say a few words in their own manner. They are then marked gold on the map as your sidekick. For now they carry on with their own life; their powers and helping you come in the next steps. If your reputation drops below zero, they break with you, and you can ask again later. Saved with the game.

## 0.109 — 2026-10-07

- **Nothing blocks the front door any more.** House interiors were laid out without looking at where the street door is, so about one door in three opened onto a wall, the lift shaft or the staircase. Now the stairs and the lift are placed clear of the way in, room walls across it get an opening, and nothing solid stands right behind the door. A sweep over 16,679 buildings found 0.2% with a narrower way in (odd little triangular houses), down from 33%. A few such tiny houses now go without inner stairs rather than have them right behind the door.

## 0.108 — 2026-10-07

- **Shoulders no longer sit back.** In every animation the shoulders were pulled behind the chest, so the arms hung from the back of the body. The collarbones now come forward and the arms hang along the side of the body, as in the procedural pose.

## 0.107 — 2026-10-07

- **Super speed no longer drops you into the sewers.** Running across a river at super speed and onto a steep quay used to carry the hero through the bank into the sewer or culvert beneath the street (or into the earth), without any manhole. Now the runner goes up onto the street; the only ways down stay the manholes and the metro stairs.

## 0.106 — 2026-10-07

- **Smoother hero masks.** The cowl and full mask are smooth stretch fabric like the tights (no more grainy speckle), and they hug the face round the eye holes and the cowl's jaw opening, so there is no dark rim or see-through sliver at the edges. The lightning bolt design is a proper zigzag.

## 0.105 — 2026-10-07

- **Superhero tights and masks.** The character creator (and the fitting mirror in clothes shops) has a new **Hero** tab. **Tights**: a skin-tight, slightly shiny bodysuit in any colour with an accent colour and a design: plain, star emblem, lightning bolt, chevron, side stripes, or trunks with a golden belt; gloves in the suit or accent colour if wanted. Putting the tights on takes off the everyday clothes and pulls on boots in the accent colour; anything added back in Outfit is worn over them. **Masks**: a domino mask round the eyes, a cowl (head, nose and neck covered, mouth and chin free), or a full mask with only the eyes open. Hair and beard hide under a cowl or full mask; the eyes still blink and look around.
- Collars no longer let you see through the neck when looking down past them (the neck stays under every garment).

## 0.104 — 2026-10-07

- **Player's manual.** A "Manual" link next to Feedback on the start screen (and in the pause menu) opens a 25-page illustrated PDF manual: getting started, controls, powers, landmarks, places to explore, people and favours, crime and the six organisations, big threats and the army, reputation, and what happens when you go down. Spoiler-light by design.

## 0.103 — 2026-10-07

- **No game changes.** The plan for an optional sidekick is written down (docs/SIDEKICK_PLAN.md).

## 0.102 — 2026-10-07

- **The police really stop a public menace.** With a reputation of −70 or worse, being taken down by the police is the end: the hero stays down, the officers come and cuff them, and it is game over ("Arrested — taken into custody"). No more waking up and walking off. If no officer can get to the body, backup takes the hero in after 20 seconds anyway.
- **Officers no longer walk away from a fight.** Officers heading back to their car after an arrest turn round and come after the hero again when attacked (or when the hero is wanted again), instead of ignoring it; the ones already in the car get back out.
- **Beaten is beaten.** An officer (or a soldier) knocked out cold stays down for good instead of standing up again after a while; the others leave them lying when they drive off. Being knocked down without losing all health still means getting back up.

## 0.101 — 2026-10-07

- **Shoulders stay down while people move.** The standing, walking and running animations still pulled the collarbones up into a shrug a moment after any change (0.099 only fixed the pose without animation). Every animation now keeps the shoulders sloping down from the neck.

## 0.100 — 2026-10-07

- **"Awakened tree" works next to any tree.** The debug entry only looked for street, park and cemetery trees and reported a misleading "unknown archetype" when none was found. It now also wakes forest and countryside trees (the woken tree leaves its spot for good), and it says "no tree standing nearby" when there really is none.
- **Beating an awakened tree pays properly.** It now gives 120 karma (was 60) and a big reputation boost, the same as defeating the strider, and it has a third less health, so the fight is shorter.
- **Other villain debug entries try harder.** Crimes and boss operations that cannot start straight ahead now also try nearer, farther and to the sides before giving up, and the procession explains that it needs people walking about.

## 0.099 — 2026-10-07

- **Shoulders sit lower.** People no longer hold their collarbones up as in a shrug: the shoulder line now slopes down from the neck, the neck shows its full length, and the arms hang from lower, closer shoulders.

## 0.098 — 2026-10-07

- **Arcades only where there is room for one.** They are now only in big, plainly rectangular buildings, never in small or oddly shaped corner houses, so every arcade is a real hall with at least seven cabinets.
- **Nothing walls an arcade off any more.** Cabinets used to stand in front of the doorway from the stairs or the lift lobby, and where the street door led in that way, the hall was shut off. They now keep doorways clear, and a self test walks from the street door to every cabinet.
- **Arcades are easier to find on the map:** a round cyan "A" badge, with its own line in the map's legend.
- **The ARCADE sign no longer sits on a painted shop sign** — arcade fronts have no generic sign band now, and their windows glow in the evening.
- **People keep out of your view while you play:** passers-by in the hall no longer step between you and the screen.

## 0.097 — 2026-10-07

- **Metro entrance stairs no longer run into the station's underpass.** At every station one entrance's stairs used to end right where the passage under the tracks starts down, so its side wall stood across the stairs (a wall you could walk through) and the steps dipped below the hall and climbed back up. Seen at Spring Market and Highland Park. Those stairs now take a different way down and end level with the hall.

## 0.096 — 2026-10-07

- **People who trip no longer scream as if dying.** When someone falls in the street they now let out a short, mild cry instead: an "oof", "ow", "whoa", "ugh", "ah" or "whoops", picked at random each time. Men and women have their own voices, every person keeps a slightly different pitch, children sound higher and older people a little lower. It is also a touch quieter than before.

## 0.095 — 2026-10-07

- **Flying no longer recharges your energy.** Flight itself is still free, but energy only comes back on the ground (or on a roof), so a hero who flies and fights has to land now and then to catch their breath. The energy bar turns grey while it is not recovering.
- **Being a giant costs energy.** The bigger you are, the more it takes: a few metres tall costs little, at 10 m it eats all of your regeneration, and at 100 m a full pool lasts about 20 seconds. When you run dry you shrink back to 10 m on your own and catch your breath there for a few seconds; once a quarter of your energy is back you can grow again (and 10 m holds that energy steady). The energy bar turns orange while your size is draining it. Super speed and super jump are unchanged.

## 0.094 — 2026-10-07

- **Arcades.** Some general stores on the shopping streets are now arcades, with a neon ARCADE sign over the door (the map shows the nearest few). Inside is one dim hall full of tall video game cabinets along the walls and in back-to-back rows, their screens running a demo and their titles lit on top.
- **The games really play.** Walk up to a cabinet and press **E**: the arrows or WASD and Space now drive the game instead of your hero, right there on the big screen in the hall, and **E** steps back. Six classics: Rock Storm (shoot the asteroids), Block Drop (falling blocks), Space Raiders (invaders), Snake, Brick Breaker and Paddle Ball (against the machine). Each keeps a high score.

## 0.093 — 2026-10-07

- **New characters start from the plain face and body:** every shape slider in the middle, age 25, evenly mixed ancestry and no random tweaks. Only hair, colours and outfit are picked at random. A new **Plain** button next to Randomize brings any character back to that base (it keeps the sex, hair, skin and outfit). Playing without a created character also gives you the plain body.

## 0.092 — 2026-10-07

- **Cemeteries.** Every city now has a few walled cemeteries, mostly in the old town and the quiet residential streets (on the map they show green, like parks). A stone wall with corner pillars runs round each one, with a gate in the middle of its longest side. A gravel path leads from the gate past tall dark yews to a mausoleum at the far end, and a cross path meets it at a mourning figure on a pedestal. Rows of headstones, stone crosses, ledger graves and obelisks face the gate, in pale limestone, dark granite and sandstone. Headstones can be knocked over; the wall breaks.
- **The necromancers go to the cemetery.** If there is one nearby, their raisings happen there, and the Grave Lord's great circle gathers there rather than before the cathedral.

## 0.091 — 2026-10-07

- **Your hero starts from the plain face.** City people still get small random differences in nose, lips, eyes and ears, but your own character no longer does, so the face sliders work from the clean base face. A new "Random tweaks" slider on the Face page adds them back if you want them.
- **Faces look closer to the original model:** eyebrows sit lower, nearer the eyes, and are a bit fuller and darker; a dark lash line runs along the upper lids; lips are rosier.

## 0.090 — 2026-10-07

- **The procession's lantern really shows now,** a green-lit lantern held up in the necromancer's hand.
- **The skeletons' eyes burn green** instead of a pale white, and their skulls are a little smaller.

## 0.089 — 2026-10-07

- **The raised dead are real skeletons now.** Instead of a person in a striped bodysuit, they are bare bones: a skull with glowing eyes, ribs round a spine, a pelvis, and arm, leg, hand and foot bones that move with them.
- **The procession's necromancer carries a lantern,** lit in the group's colour and held up high as they lead the entranced along.

## 0.088 — 2026-10-07

- **The awakened tree is drawn properly.** Its crown and trunk now show on top of its root legs, and the legs and branch arms stay with its body.
- **The Beast-master's dogs bite a little less hard,** so a pack is a nuisance to deal with rather than a quick knockout.

## 0.087 — 2026-10-07

- **Bosses come out for their big set piece.** Now and then a group's boss leads a whole crew to one big job near its turf, marked on your map. The city answers it like a monster attack (police lines, SWAT, people cleared away). Leave it alone and it succeeds; knock the boss out and the crew breaks and runs. The more you anger a group, the sooner it comes.
  - The Syndicate cracks a bank vault and the boss runs off with the money.
  - The street gang takes over a street and sets the cars on fire.
  - The techno-cult turns the city's robots on the people.
  - The elemental cult holds a great ritual before a landmark.
- **The eco-radicals are here.** They live in parks and the leafy suburbs and dress in patchwork greens and browns with leaf wreaths. They sabotage delivery robots and parked cars and leave the pavement grown over with moss. Their Beast-master brings three or four trained dogs that run you down and bite, and a whistle sends them lunging at you. Punch a dog and it goes down and slinks off; fire scares them away. Their boss, the Elder, gathers a circle round a big tree and sings it awake.
- **The awakened tree.** The tree tears itself out of the ground and walks on its roots. It goes for anything with a motor or a plug: cars, robots, street lamps, traffic lights. Hurt it and it comes for you instead. It is weak to fire and slowed by frost, and lightning barely bothers it. When it rears up for a slam, its glowing heart shows; hits there count triple. Beaten, it takes root where it stands and stays there as a gnarled old tree.
- **The necromancers are here.** They haunt the old town and the parks, mostly at night, in black robes and bone-white masks. In a park they kneel in a ring and chant, and skeletons claw their way out of the ground. Knocked apart, a skeleton pulls itself back together while a necromancer still stands; beat the necromancers and the bones sink back into the earth. They also lead processions: a few people in a trance shuffling after a necromancer with a lantern. Walk up and press E to wake them one by one, or beat the necromancer to wake them all at once. Their Bone-caller drains your strength with a beam and wails you back. Their boss, the Grave Lord, curses you and raises the dead before the cathedral.
## 0.086 — 2026-10-07

- **Men are back to the earlier body** with the fixed upper legs: the broader, higher shoulders from 0.081 are undone (they gave men a hunched look). Walkers still carry their arms a little away from the body.

## 0.085 — 2026-10-07

- **People know each other.** Friends, family, neighbours and colleagues who pass each other in the street stop for a chat: a wave, a greeting by name, a few words with their hands going, a goodbye, then they walk on.
- **Word gets round.** What you did to someone reaches the people close to them. Help a woman up and her neighbour likes you a little more, and tells you so when you meet ("You're the one who helped my neighbour Mara up!"). Knock someone down and their family will remember that too.
- **People have needs.** Hunger between meals, tiredness late in the day, and loneliness after a long day at home (outgoing people feel it sooner) make them feel worse, and they tell you about it when you ask how they are. A hungry or tired passer-by sometimes stops for a bite or a coffee on the way.
- **Favours.** A new option in the talk menu: "Can I do anything for you?" Someone who knows and likes you may ask you to look in on a friend or relative. That person then shows as a golden dot on the map, and they come out to their door when you get near. Or they may ask you to deal with the gang on their street, which counts once you stop a crime nearby. You have two game days. They remember whether you did it: they thank you and like you more, or they tell you they were let down. There is no quest log; the person who asked remembers it, and their dot on the map says so.

## 0.084 — 2026-10-07

- **Reputation is only lost for what you hit yourself.** Rubble flying out of a collapsing building used to count as your doing, so standing by while a monster brought a block down could wreck your reputation as the neighbours fell. Now only what your own punches, steps and powers hit counts. What collapse rubble breaks, and what your body breaks while a monster has knocked you flying, is nobody's fault.
- **No reputation lost while fighting a big monster.** Near a monster like the Strider (and for a short while after it leaves or falls), damage you cause costs no reputation or karma and draws no police. A short note on screen says so. Away from monsters, collateral counts as before.
- **The city no longer blames you when the last resort strikes.** The strike still costs karma, but no reputation any more, and being knocked out by criminals no longer costs reputation either.

## 0.083 — 2026-10-07

- **Soldiers stay out of the water.** Every spot the army picks (where a unit digs in, where it gathers when you rally it with G, where it drives or walks off to when the battle is over, where a squad on foot gets out) is now on dry ground. A spot over a river, lake or the sea moves to the nearest dry street. As a backstop, soldiers, police and anyone else heading straight for a point, and people running off in a panic, now stop at the bank or walk along it instead of stepping into the water.
- **After the battle the army leaves sensibly.** Units used to head off eastwards once the monster was gone, whatever lay there, and their target moved with them. Each one now gets one fixed street point away from where the fight was.
- **Rally (G) is calmer.** Each unit has its own spot around you and only moves when you do. Before, all of them got a new random spot every four seconds and kept milling about.
- **The army fights instead of standing around.**
  - Units no longer drive or walk on into the monster's feet on the way to their position. They fall back as soon as it is on top of them. Tanks and trucks used to keep going and were stepped on.
  - A squad digs in once most of its soldiers are there. One soldier held up behind a car kept the whole squad running about without firing for minutes.
  - Guns look for any part of the Strider that shows over the roofs or past a corner, not only the middle of each body part. Rifles and APCs without a clear line fire over the roofs at its back. A unit that keeps having no line moves to a spot that has one. A tank with a building in the way shoots through it.
  - Helicopters keep closing in until they have a clear line before firing, instead of giving up the run at 300 m. One that has used up its rockets comes back rearmed after a while instead of leaving for good.

## 0.082 — 2026-10-07

- **People behave like who they are.** Everyone already had a personality; now it shows in the street:
  - Outgoing, orderly people walk briskly, dreamers dawdle. The calm get over a scare quickly; the nervous keep running longer. The curious stand and stare longer at a spectacle.
  - People who dislike you (because you hurt them, or because of your reputation) step out of your way when you come near, don't hang about next to you, and sometimes tell you to keep away. Someone who really can't stand you won't talk to you at all.
  - Kind passers-by walk over and help up someone lying in the street once it is calm again. An everyday fall is still yours to help with first; after a while a stranger does it.
  - When a thief runs past, an agreeable passer-by points after them and shouts which way they went.
  - People who know and like you stop and wave when they say hello. People you saved greet you as their hero.
  - Victims of a crime you stop, and people whose stolen things you bring back, now remember being saved by you.
  - What people shout when they run, gawk, film, fall or thank you is in their own temperament (grumpy, anxious, chatty and so on).

## 0.081 — 2026-10-07

- **Change your look at the tailor's.** Clothes shops now have a full-length fitting mirror on a side wall. Step up to it and press E: the character creator opens on your hero's current look, and saving changes the hero on the spot (and keeps the look as your selected character for the next game). The game is paused for input while the creator is open, and Esc closes it without opening the pause menu. The four nearest clothes shops show on the map in lilac.
- **Underwear can be switched off in the character creator** (Outfit tab, "Underwear: shown / removed"). With top, trousers and shoes on "none" and underwear removed, the character is fully nude, in the creator and in the city. It stays on by default.
- **The separate Woman and Man characters are gone from the start screen's character picker.** Every human is built on those bodies now, and the creator does everything they did. A save or a selection that still points to one of them starts with the default human. The body credit (Bananaboy, CC BY 3.0) is shown at the bottom of the creator, and the clothes shops are in the map legend.
- **Men have broader shoulders.** The male base body was too narrow at the shoulders, so walking men swung their hands in front of the crotch. Walkers also carry their arms a little away from the body now, so the forward hand no longer swings in front of the hips.

## 0.080 — 2026-10-06

- **The starship has an inside.** Doors between its fins open into a lobby at its foot. Beyond it a great hall rises dozens of metres through the middle of the ship around a glowing core. Every storey has a gallery with glass rails running around the hall, with cabins, labs, mess rooms, lounges, control rooms and stores behind it. Stairs climb from level to level, and bridges cross the hall every few storeys. The rooms are furnished from a sci-fi prop set (bunks, lockers, consoles, holo tables, screens, crates and more).
- This is the first job of a new interior designer that works on any shape (round, oval, tapering), not only boxes. Its look comes from a swappable prop set, so other buildings and themes can follow.

## 0.079 — 2026-10-06

- **Super speed hops over people.** Running at super speed, the hero now hops over someone a little ahead, and over cars, vans and benches too, in a short, snappy hurdle that keeps the speed. It only hops when the arc is clear (no wall, bus, tree or overhang in the way) and the landing spot is free and on about the same level; several people in a row are cleared in one hop.
- **Brushing past someone is no misdeed any more.** When a hop is not possible, the person still stumbles out of the way, but it costs no reputation or karma, draws no police, does them no harm and they get up on their own. Instead they call after you in a red bubble low on the screen ("Mara, behind you: “Slow down, hero!”"). Helping such a person up earns nothing, like anyone you knocked down yourself. Dashes and giants running through crowds count as before. A hop that grazes a façade in the air no longer turns into a wall run up onto the roof.

## 0.078 — 2026-10-06

- **You can walk to the starship (and every other landmark) again.** In big cities the houses around a landmark's square could close into an unbroken ring, so the only way in was to fly (seed 873738 at full size had its starship, town hall, cathedral and stadium walled in). Now a paved way leads from the middle of each side of a landmark's square straight out to the street. No house, café terrace, fountain, statue or bench is put on it.

## 0.077 — 2026-10-06

- **No more walls to walk through in the metro entrances.** Two things from above could stand across an entrance passage as a wall without substance:
  - The ground is drawn in square tiles, and along every tile edge a curtain hangs a few metres into the earth to hide the seams. It was hidden only once the camera itself was underground, so in a corridor right under the street the camera, still at street level, showed it across the way. It now stays hidden whenever you are in a stairwell or passage.
  - The shafts of the sewer manholes run from the sewer straight up to the street, through anything in between. They now keep clear of metro tunnels, halls and side rooms, and of the ground around every station where its stairs run.
- **Nobody walks on the tracks any more.** Commuters can no longer step off the edge of a platform. People halfway through a door when it shuts stay on the train. Someone knocked over in a train standing at a platform, or knocked off the platform, no longer gets up on the track bed and wanders there: they are lifted back onto the platform and go back to waiting.

## 0.076 — 2026-10-06

- **Every human is now built on the new Woman and Man bodies.** NPCs and the character you create get their proportions, body shape and face, while height, weight, age, muscle, the face sliders, the other races, clothes and facial expressions all keep working as before. Crowds perform the same (same mesh size and detail levels).
- **Better bending.** Humans now use the Woman's skin weights, so shoulders, elbows, hips and knees deform more smoothly. Jumps, flight and other procedural poses bend the legs at the real hip and knee instead of kinking the thigh and shin.
- **Superman flight.** At speed the hero flies with the right fist stretched out ahead, the left arm straight back along the body with the hand flat against the thigh, legs together and toes pointed; the fist points straight ahead past the head. Boosting still puts both fists forward.
- The character creator can leave top, trousers or shoes off ("none"). Nude is an option only; new characters still start dressed.
- The creator's Face view centres on the head, so a character standing with a hip-shot pose no longer has their face cut off at the side.

## 0.075 — 2026-10-06

- **"Preparing shaders" is much shorter.** The shaders were already meant to compile in parallel on the graphics driver's own threads, but that compile ran before the sky had made its environment light. The first frame then added it, and that changed every lit material, so about 40 shaders were compiled a second time, one after the other, while the loading screen waited (and the parallel work had been thrown away). The environment light now exists from the start, so the parallel compile is the only one. The first frame's new content (cars, effects, the first crowd) now also compiles in parallel instead of one by one. About a quarter fewer shaders are built at the start (154 to 106).
- Objects that appear while you play no longer risk staying invisible when their shader got swapped for another variant before it was ready: the shader is requested again, and nothing waits longer than 8 seconds.
- The browser console now shows how long loading took in all and how much of it was preparing shaders.

## 0.074 — 2026-10-06

- **Manholes are climbed now, not teleported through.** Press E by a lid and the hero squats, lifts its edge and drags the heavy cover aside, turns round, lowers themselves over the edge and climbs down a ladder to the sewer's walkway, hands and feet on the rungs. From below, the hero walks to the ladder, climbs up, pushes the lid up and off if it is still on, and climbs out over the edge onto the street. Every manhole has a real brick shaft now, on one side of the sewer over the walkway, with the ladder on its wall and daylight falling in through the pick holes (more when the lid is off). The camera looks down the shaft from the street while the hero is in it and watches from inside the sewer below. An opened manhole stays open with its lid lying beside it, and the hole now cuts through the road surface too (before, an open manhole on the road was hidden under the asphalt).
- The hole in the street is round like its lid, with a cast-iron frame and a round brick neck under it before the square shaft opens out; the ladder stands inside the neck. Over the edge, the hands lie flat on the street, palms down, until the hero is up on one knee, then they stand. Cars wait while the hero is busy at the hole instead of driving over them, the camera no longer squeezes into the hero's face in the sewer, the lid lifting off is watched from the street, and the "press E" prompt is hidden during the climb.

## 0.073 — 2026-10-06

- **People you know no longer outrun you.** After you leave someone you talked to, they carry on at a walking pace (or ride, when they and where they are going are both far from you) instead of jumping along their day plan, which runs many times faster than real time. Their map dot moves the same way, and their body only shows up again near where they plausibly are, so you can't run away and find them waiting ahead of you. When you come back near them, they are back in the street around their dot, walking on to where their day takes them, so you can talk to them again.

## 0.072 — 2026-10-06

- **Dresses and skirts no longer let skin poke through.** The skirt part is now shaped to each body: it starts close at the waist (no strip of skin between bodice and skirt, and no stiff shelf), clears the widest hips, bottom and thighs, and leaves room for the legs to move, so it is a bit wider, most of all lower down. It follows the legs better when walking, running and sitting, and the upper thighs inside a long skirt are hidden so they can't push through when someone sits down.
- Fixed tears in every skirt and dress: the front split open from the knees down while walking, and the back hem opened into a V between the legs. Sitting in a skirt no longer shows skin on the lap.

## 0.071 — 2026-10-06

- **Super speed is a toggle now, and it steers itself.** Press its hotbar key (or tap its button) once to switch it on and again to switch it off; no more holding. It is slower than before (40 m/s at the first rank up to 100 m/s at the top, was 75 to 240), so the city keeps up with you. While it is on, you steer roughly and the runner does the rest: it swerves around cars, poles and trees, follows the street around walls, and brakes when the way straight ahead is blocked instead of slamming into it (keep pushing into a wall and it still runs up it, slowly). It no longer drops into manholes or metro stairwells: it runs around them, and at speed skims straight over them. In flight, pressing it still gives the dash burst.
- **Super jump climbs while you hold Space.** You take off the moment you press it and keep rising for as long as you hold it, up to the jump's maximum height (about a second and a half to the top); let go and the climb stops, so you choose your height. You can steer the whole time you are in the air, at a good pace, so landing on a particular roof is easy. A quick tap is a small hop. Energy is paid for the height you actually gain. On the touch screen, the Jump button works the same way.

## 0.070 — 2026-10-06

- **Credit for the built-in characters.** The Woman and Man are based on "Woman_model" by Bananaboy from Blend Swap (Creative Commons Attribution 3.0). The credit is in `public/assets/bodies/LICENSE.txt` and shows when you point at either card in the character picker.

## 0.069 — 2026-10-06

- **Two new built-in characters: a woman and a man.** The start screen's character picker now offers **Woman** and **Man** next to the default human. Both are fully animated, with painted skin, short hair, eyebrows, lips and real irises. The woman is the new base model from Blend Swap; the man is made from the very same mesh and skeleton, reshaped (broader shoulders and chest, narrower hips, fuller thighs, thicker neck and arms, stronger jaw, 1.80 m tall), so the two move and fit exactly alike.

## 0.068 — 2026-10-06

- Fix: **sewer pipes no longer stick out of the streets.** Where a street ran through a dip, the sewer under it stayed too high and its brick vault broke through the road (seed 1234 at size 0.5, for example). Every sewer now stays at least a metre under the street along its whole length and width (also where streets meet on a steep river bank); under dips it simply runs a little deeper. `npx tsx tools/sewersweep.ts <sizes> <seedA-seedB>` checks any city for this.

## 0.067 — 2026-10-06

- **Power cores no longer hide inside things.** A core on a square or in a park used to sit exactly in the middle, which is where the fountain or statue stands, so it ended up inside the fountain where nobody could reach it (about a third of all cores in a sweep of 16 cities were buried like that). Cores now keep clear of fountains, statues, kiosks, trees, playgrounds, benches, café terraces, metro stairwells and water, and a core on a roof keeps clear of the air-conditioning units, water tanks and lift housings up there. `npx tsx tools/coresweep.ts <sizes> <seedA-seedB>` checks every core of many cities headlessly.

## 0.066 — 2026-10-06

- **The Lumen's trench holds steadier**: when two or more of their spots are empty, fresh sentries now come every 2.5 s (was 7 s) from right behind the line instead of the floor of the Throat, so a lucky Murk push no longer snowballs into the whole line falling. The headless trench test is now repeatable (its dice are seeded per city).

## 0.065 — 2026-10-06

- **Health tags no longer show up for people behind you.** On graphics cards that use the game's sharper depth mode, everything behind the camera was also projected onto the screen, mirrored: villains you ran away from got a second health bar in front of you, speech bubbles hung in empty air, and Tab or a click near a target could pick someone behind you. Every marker that follows something in the world (criminal health tags, target brackets and weak-spot rings, speech bubbles, target picking, the photo-flash glare) now goes through one shared piece of code that knows which side of the camera a point is on, and the self-test fails if any new marker tries to do it on its own.
- **No more tags through walls and floors.** Health tags and speech bubbles only show for people you could actually see: not for a sewer crew under your feet while you walk the street (or the street above while you are in the sewers), and not for someone behind a building or a hill.
- **Sewer hideouts stay off the map.** A crew holed up in the sewers no longer shows on the map or the compass; you have to find them down there.


## 0.064 — 2026-10-06

- **Metro stations are full of people now.**
  - **Commuters** come down the entrance stairs from the street, some crossing to the far platform, and wait on the platforms: standing and looking down the tracks, or sitting on the benches.
  - **Trains**: when a train pulls in and opens its doors, some riders get off and walk out and up the stairs to the street, and most of the people waiting step in, take a seat or stand by a door, and ride away. Trains near you carry passengers who sit along the benches, also in the car you ride in.
- **Sit in the train**: the benches in the cars and on the platforms are seats now. Press **E** next to one to sit down (in a moving train too); the train carries you along on your seat, and on a platform bench you stay down in the station. Move or press **E** to get up again.
- **Every platform can be reached on foot**: in more than half of the stations one platform (one direction of travel) had no way to it except by train. Every station now has an underpass under the tracks between its two platforms, with stairs down and up again on both sides.
- **No more invisible ledges on the stairs**: where an entrance passage turned a corner right at the top or bottom of a flight, walking along one side of it ran into a step half a metre high. Every turn now has a level landing. Corridors that turned back and ran underneath their own stairs, and corridors running back alongside the first flight, now swing out to the side first.
- Entrance routes are worked out about twice as fast as before (they only look at the tunnels and sewers near their station).

## 0.063 — 2026-10-06

- **The town hall and the cathedral are full of people now**, by the time of day.
  - **Cathedral**: the priest is there from morning to evening. At the services at 9:00 and 18:00 the pews fill, the priest stands behind the altar and two altar servers sit in the choir stalls. Through the day visitors come and go. They stand at the aisle windows and the rose windows looking up at the glass, look up into the crossing or the dome, stop at the font and the pulpit, and rest in the pews. In the evening a few people sit and pray. At night it is empty.
  - **Town hall** (open 8:00–18:00): clerks standing behind the information desk and the service counter, people asking at the counter and waiting on the benches, visitors in the hall, on the benches under the galleries and up on the galleries looking down. Upstairs, the mayor sits at the desk with an aide in the office (9:00–17:00). Council sessions fill the chamber from 10:00 to 12:00 and 14:00 to 16:00. Weddings are at 11:00, 13:00 and 15:00 in the wedding room, with the couple at the table (the bride in white), the registrar and rows of guests. At night a porter keeps the desk.
  - People walk in from down the street, up the steps and through the door to where they are going, and leave the same way. Staff come and go with their hours. The priest wears black and the clerks, mayor and council wear suits.
  - They react like people outside: a blast or a monster sends them running out of the door, a commotion makes them stop and look, and you bump into them and can knock them down (they get up after a few seconds and run). If the cathedral is badly damaged, everyone leaves.
  - In a queue at the door they keep a little room to the one in front, and they wait for you to step aside rather than shoving you down the steps. Nobody holds a coffee cup or an umbrella inside.
- The choir stalls in the cathedral now face each other across the chancel. They used to face the walls.

## 0.061 — 2026-10-06

- **The way to the slime civilisation is open.** The living membrane that closed the tunnel out of a colony's chamber is gone: anyone can walk down to the Lumen now. The tunnel itself is much wider (and a little less steep), so the camera no longer gets squeezed against the rock behind you.
- **Where the Lumen and the Murk meet is a WW1-style battlefield now.** The see-through barricade in the Front gallery is gone (the gallery is open, a few Lumen guards stand there). The war is fought where the two realms actually touch: at the foot of the Throat, where the Lumen hold the floor of the shaft and the Warrens open beyond. Fallen rock narrows the Warrens' mouth to a passage, and across it:
  - **The Lumen's trench**: three bays dug a metre deep across the passage, with duckboards on the floor and sandbags on the parapet, lit low from inside, and two gaps between the bays marked with glowing stakes. Lumen sentries stand in the bays and lob glowing bolts over the parapet; at the gaps they fight hand to hand.
  - **Thorn wire** in front of the trench (knife rests wound with thorny strands). Murk caught in it slow to a crawl.
  - **No-man's land**: craters, dark ooze where Murk burst, the husks of dead Murk, broken stakes, the faded glow of fallen Lumen.
  - **The Murk's berm** where the passage opens into the Warrens, studded with their red crystals, where they gather to go over.
  - **The war never stops**: every few seconds a handful of Murk come out of the Warrens and charge across no-man's land at the gaps. Most are shot down before they get far; a few reach the line and die there. Fallen sentries are replaced from behind, and the Lumen send glowing flares up over no-man's land that hang and slowly sink. These endless pushes don't change how the war stands (only the raids do, as before, and big raids can still break through); Murk you kill there still count.
  - The floor of the Throat glows the Lumen's pale teal now, the Deep's red glow starts beyond the berm. Two Murk hives moved out of the passage.
- **You can tell the slimes apart.** The Murk are blood red now, their spines glowing hotter towards the tips, and they have two slanted, glaring orange eyes (brighter when they fight). The Lumen stay soft, round and glowing.
- **The Murk go for you on sight**: from 24 m away (was 17), and a Murk fighting a Lumen drops it for you once you come within 10 m. They also follow you further before giving up.
- Fix: slimes following a route through the caves could get stuck forever trying to reach a waypoint at an edge (the Murk at the lip of the Throat, for example). Now they move on.

## 0.060 — 2026-10-06

- **Save to file and Load from file use your computer's own file dialogs** where the browser has them (Chrome, Edge and Opera on a desktop): you choose the folder and name of a saved game, and pick the file to open from a normal Open window that shows Scale saves first. The dialogs remember the folder you used last. In other browsers (Firefox, Safari, iPad) saving still downloads the file, and loading uses the browser's file chooser.

## 0.059 — 2026-10-06

- **Save a game to a file, and load it back from one.** The pause menu has two new buttons under Save game: **Save to file** downloads the game as it is right now as a small `.scale` file (named after the city, your save's name and the game time), and **Load from file…** opens a file and plays it. Every save in the Load game list also has a ⇩ button that downloads it. The start screen has **Load from file…** next to Load game (it is there even when the browser has no saves at all), and so does the game over screen. Use it to keep a game safe, carry it to another computer or browser, or send it to a friend. A game loaded from a file also lands in Your saves, so it can be continued later; loading the same file twice replaces the earlier copy rather than adding a second one. Files from older versions of the game still load, and a file that is not a save, is damaged or comes from a newer version gets a clear message instead.

## 0.058 — 2026-10-06

- **Long speech bubbles wrap now.** A longer line over someone's head used to run out of its bubble; now it breaks onto several lines and the bubble grows taller, for every kind of bubble (passers-by, street characters, officers, protesters and fans). Longer lines also stay up a little longer so you can read them.

## 0.057 — 2026-10-06

- **Metro entrance stairs no longer go down and back up.** Where the street dipped or a sewer crossed the way, the passage from a station entrance sank, climbed again on a bare ramp and only then took the stairs down to the platform. The corridor under the street now only ever goes down (about 1 in 40 entrances was affected), and it no longer dips into its own station hall on the way (where it did, it cut through the hall's roof and lost its walls).
## 0.056 — 2026-10-06

- **You can talk to more people now**: people sitting on benches and café terraces (they stay seated), street performers and characters (the busker, the mime, the living statue, the chicken mascot, the doomsayer, the lost tourist, even the sleepwalker), police officers, paramedics, soldiers, shopkeepers and cleanup crews, as long as they are not busy fighting or fleeing. Each of them answers as what they are: the mime only mimes, the statue barely moves its lips, the officer introduces themselves by rank. Performers carry on with their act while you talk, and the map remembers them as what you met them as. Firefighters can be talked to as well. Cleanup workers no longer end the talk when they step back to their spot, the map remembers officers, paramedics and shopkeepers by their role too, and people met in a role are always grown-ups.

## 0.055 — 2026-10-06

- **Feedback**: a new "Feedback" link next to the version label, in the main menu and the pause menu, opens a small form. Pick Bug, Idea, Praise or Other, write your message, and Send opens your mail program with it ready to go (with the game version, city seed and browser added, if you like). The address it goes to is never written anywhere on the site or in its code; the game only puts it together at the moment you press Send, so spam bots scanning the page find nothing.

## 0.054 — 2026-10-06

- **Your reputation is felt in the street now.**
  - **The press**: once you are well known (reputation 35 and up), photographers turn up when you are out on foot, gather round you, raise their cameras and flash away ("Over here!", "Front page!"), more of them the more famous you are, and right after you stop a crime. **Their photo of you goes up on the big billboard screens** with a headline in a news bar ("CITY HERO DOES IT AGAIN", "WHO IS THE MYSTERY HERO?", and "MENACE ON THE LOOSE" when the city has turned on you). From 65 a TV crew comes along: a reporter holding out a microphone and a camera operator.
  - **Fans** (50 and up): now and then someone runs up to take a photo of you with their phone, and passers-by call out to you ("It's the hero!") in golden speech bubbles.
  - **A statue**: keep your reputation at 80 or above for a while and the city council votes for a statue of you on the town hall square. It is built behind a fence and under a tarp, then unveiled with a fanfare, confetti and a cheering crowd with signs: a bronze statue of your hero, fist raised, on a stone plinth with a plaque. It stays in your saves.
  - **Protesters**: below 0, people gather with placards ("GO HOME HERO", "WHO PAYS FOR THIS?"), chant against you in red speech bubbles to a drum, boo when you walk up and follow you about. The lower your reputation, the bigger the crowd. Passers-by grumble at you. If your reputation stays below 0, protesters pull your statue down; it lies on the paving with its plaque sprayed over (raise your reputation to 80 again and it is rebuilt).
- **The police and the army escalate against you at any size now**, not only as a giant. With a reputation of −40 or lower, wrecking things gets you warned, warned again, and then hunted: the police, SWAT and the National Guard for a human-sized hero, the full army and air support for a giant. The lower your reputation, the less destruction it takes. At −70 and below the police hunt you on sight: the first officer who sees you goes after you.
- **Helping someone up raises your reputation a little** (+1; not for people you knocked down yourself).

## 0.053 — 2026-10-06

- **The city lives its own life now, and you hear about it.** Crime happens all over the city, not just near you. The police stop some of it, and the neighbourhoods get safer or rougher over time.
  - **Neighbourhoods with a crime index**: the city is split into named neighbourhoods ("Ashford Heights", "Mill Quarter" …). Every block has a live crime index. Crimes that get away push it up, crimes stopped by you or the police bring it down, a gang holding the street keeps it high, and it slowly drifts back to the area's usual level. Jailing a gang boss calms their streets. The index is kept in your saves.
  - **Low crime, lots of police; high crime, the opposite**: safe areas have many patrol cars in traffic and pairs of officers walking the beat, who step in when a crime breaks out near them and cuff the criminals. Rough areas have more crime, hardly any patrols and slow police response.
  - **A new game starts in a very safe neighbourhood** near the centre.
  - **On the map**: the crime layer now shades every block from green (safe, many police) through yellow to red (rough). Neighbourhood names show with a coloured dot, and hovering a spot tells you its crime level and police presence.
  - **Walking into another neighbourhood** shows its name, crime level and police presence.
  - **News from passers-by**: people chat about what happened around the city ("Did you hear? There was a robbery in Mill Quarter last night.") and about how safe their streets feel. Asking "what's going on around here" in a conversation gets the same news.
  - **News on the billboards**: the big screens put city news cards between their ads (crime alerts, police news, the hero's deeds, neighbourhoods getting safer or rougher) plus a report on the crime level where you are. Other systems can post a photo with a caption to them (for the press shots of the hero to come).

## 0.052 — 2026-10-05

- **Playable on an iPad (and other touch screens)**: touch the screen and on-screen controls appear; a mouse moving switches back.
  - Left thumb: a stick appears where you put it down. Push it to the rim to run (in flight: boost), barely push it to walk slowly.
  - Right side: drag to look around, pinch to move the camera closer or further, tap someone to target them.
  - Buttons for Jump (hold for a super jump; in flight Up), Fly / Land, Down, Use (lights up when there is something to do; hold to dig), Target and clear target, Autorun, and grow / shrink. Top right: Powers, Map, a ⋯ menu (rally the army, airstrike, minimap, time of day, controls) and ☰ for pause and settings.
  - Hotbar slots work with a finger, held powers run while you hold the slot. The map pans with a finger and zooms with a pinch. The controls screen lists the touch controls.
  - Sound and music now start on an iPad (Safari only lets a touch's end start audio). The page no longer zooms or scrolls under your fingers.

## 0.051 — 2026-10-05

- **Everybody has a name and a personality now.** Click someone and the target frame shows who they are ("Mara Okonkwo", "Shop assistant"). Every person has a temperament (cheerful, chatty, shy, grumpy, anxious, nosy, proud, kind, dreamy or steady), a job, a hobby and a mood that changes with the day, the weather and what just happened on their street. Passers-by make small talk in their own manner; shy people keep quiet.
- **Talk to people with E**: stand by someone (or target them) and press E. They stop, turn to you and you can say hello, ask how they are, what they do, what's going on around here (the gang that runs the street, its boss, a recent monster), ask the way (they put the nearest metro station or a landmark on your map) or what they think of you. Keys 1–7 or click; Esc or E ends it. Their answers depend on who they are and on what you did.
- **People remember you.** Everyone you talk to or help up remembers it, and people who know you also remember being knocked down by you. Meet them again and they greet you for it ("You're the one who helped me up on Linden Street!"), or grumble at you. Their opinion of you mixes your reputation with what you did to them.
- **Faint dots on the map** show where the people you have met are right now (at home, at work, out for lunch), even far away. Hover one for their name and how they feel about you. Up to 24 people; after that the one you care least about is forgotten. They are kept in your saves.
- The plan for all of this, and for optional language-model conversations via OpenRouter later, is in docs/NPC_PERSONALITY_PLAN.md.
- Fixes from the first look in the real game: right after a crash or a fight nearby people say "Not now!" instead of the talk panel flashing open and shut; people at home have job titles that fit a sentence (homemaker, job seeker, remote worker, freelancer) and always tell the same story about them; the target frame keeps the person's name and job while you talk to them; the map legend explains the faint dots.

## 0.050 — 2026-10-05

- **Livelier sewers.**
  - **Rats** scurry along the walkways and nose about the side rooms. They sit and sniff, rear up now and then, and squeak and bolt along the wall when you come close, run, or something violent happens nearby.
  - **Now and then a slime**: every few minutes in the sewers one may be oozing along a walkway ahead of you, carrying something small and glowing. It freezes when it notices you, then slides off and squeezes into the wall. A blow splatters it.
  - **Machine halls**: big rooms off the trunks with a gallery inside the door over a floor 2 m lower, stairs down, a row of pump sets with turning flywheels, risers through the ceiling, valves, a travelling crane with its hook and a control desk with blinking lamps. They thump and hiss.
  - **Winding rooms** over a sluice: the gate in the back wall with water seeping under it, a big gear and its pinion turning slowly over it, chain drums, a gear train on the wall and a spinning governor. They clank.
  - **Hideouts**: dens with mattresses, a sofa in front of an old TV, a cable-drum table with cards and bottles, a fire barrel, string lights and a stash in the corner. Where a villain group holds the street above, the den is in its colours with its tags on the walls.
  - **The hideouts are manned**: three to five crooks hang about there (sitting at the table, by the fire, a lookout at the door). Come in or hit one and they go for you; outmatched, they back into a corner and give up. Nobody calls the police down here. With them down, **press E at the stash** to bust it: karma, and the group above loses some ground. A cleared den stays empty for a day.
  - The new rooms come on top of the old ones: every existing side room, slime colony and the deep realm stay where they were.

## 0.049 — 2026-10-05

- **Being defeated is a real moment now.** When your health runs out you no longer just get up where you fell (where a swarm could knock you down again and again). You lie there untouchable, the edge of the screen red, and:
  - **with a reputation of 0 or better, the hospital sends its rescue drones**: three white drones with red crosses fly in, lock blue tractor beams onto you, lift you in a glowing stasis field and fly you over the city to the landing pad that lights up on the hospital's roof. Space skips ahead.
  - **in the hospital's revival ward** you lie in a high-tech revival machine under a glass canopy: scanning rings sweep along your body, the vitals hologram climbs, your heart starts again, a surge and a white flash, the canopy opens and you stand up beside it with full health. Walk out through the sliding doors at the end of the ward and you are on the street in front of the hospital.
  - **with a negative reputation nobody comes: game over.** Load the latest save, pick another save, or start a new game. Nothing is saved after a game over, so your saves stay as they were.
- Every city has its own hospital (Helix Medical Center, Vitalis Medical Center, …) in some of its flat-roofed office and civic blocks; the drones take you to the nearest one. A giant hero shrinks back to normal size while lying there.
- Knocked out again in the ward before leaving: straight back into the machine.
- Being arrested by the police is unchanged. A save made on the way to the hospital or in the ward puts you outside the hospital, healed.

## 0.048 — 2026-10-05

- **No more ghost walls in the sewers**: the walls you could walk through down there were not houses but the edges of the ground itself. The landscape is drawn in square tiles, and each tile hangs a curtain a few metres deep along its edges to hide seams between near and far detail; wherever a tile edge crossed a tunnel, that curtain stood across it (smeared ground texture, which looked like wood). From underground these curtains are no longer drawn, in the sewers and the metro alike.

## 0.047 — 2026-10-05

- **No more falling out of the caves**: a hard fall or a knock-down underground (slime colonies, the deep caves, sewers, metro) used to throw your body onto the street above, often into a house, before you were snapped back. Underground you now just go down on the spot and get up again where you fell.

## 0.046 — 2026-10-05

- **Avatar converter rebuilt**: the converter (download on the start screen) now handles far more Blender characters.
  - It measures what the character's rig actually does to the mesh and builds a clean game skeleton from that, so muscle and helper bones, breast and jiggle bones, cage-deformed clothes, BlenRig and Rigify rigs and non-English bone names all come out right.
  - Arms, legs and spine are found by shape when the bone names don't help.
  - Before writing the file it bends the result into test poses. If the mesh would tear, or no humanoid body is found and there is no animation of its own, it writes no .glb and says why, instead of producing a broken model.
  - The character's own animations are baked onto the new skeleton. Very dense models get their subdivision lowered to stay playable.

## 0.045 — 2026-10-05

- **Walk into the cathedral**: the west doors stand open and lead into a full interior.
  - Inside: a nave with pillars and arcades, side aisles, a transept and an apse, under stone vaults. The domed cathedral's crossing rises on four arches and pendentives to a gilded ring, a drum and a dome.
  - Furnishings: rows of pews, a red runner up the middle, a raised chancel with choir stalls and an altar, a pulpit, a font, and crown lamps hanging on chains.
  - It is dim inside like other interiors, lit by the lamps and the stained glass.
- **Stained glass**: the cathedral's lancet and rose windows are coloured glass that glows in daylight.
  - The glass shatters into coloured shards from a light hit while the stone around it holds, and a broken window lets you through.
  - The cathedral can now be wrecked piece by piece like the marvels. Broken windows and walls are kept in saves.
- **Fix**: the town hall's front door was blocked for walking (the stone above it reached down to the ground). It is open now, and so are other landmark doors and windows built the same way. The doorway has a threshold, so you don't drop into a pit under it.
- **Fix**: entrance steps (cathedral and town hall) now reach the square even when it lies far below the floor. They get steeper (up to 30 cm) and more numerous instead of stopping short with a high first step.

## 0.044 — 2026-10-05

- **Real shoes**: sneakers, shoes and boots no longer show the toes through them. The front of the foot is now a closed, rounded toe box with a flat sole, so footwear reads as shoes instead of paint on bare feet.

## 0.043 — 2026-10-05

- **A real sun and moon in the sky**: the sun is now a clear disc, yellow-white by day and orange-red as it rises and sets, with a soft glow around it instead of one white blot of glare. Clouds pass in front of it and it vanishes under an overcast sky.
- **The moon** crosses the sky like the sun, about 50 minutes later each day, and goes through its phases over a month (crescent, half, gibbous, full), with darker seas and faint craters. By night it shines over the city and hides the stars behind it; by day you can sometimes see it as a pale disc. Moonlight now comes from the moon: brighter at full moon, darkest on moonless nights.

## 0.042 — 2026-10-05

- **The busker really plays the guitar**: the strumming hand now strums across the strings in front of the sound hole (the forearm lies over the guitar instead of reaching through it, no more waving), and the other hand holds the neck, moving between chord positions. Works for every body shape: the hands are placed on the guitar itself.

## 0.041 — 2026-10-05

- **Named bosses**: every villain group now has a boss with a name and a title: the gang's **Kingpin**, the Syndicate's **Chairman**, the techno-cult's **Architect** and the elemental cult's **High Invoker**. A boss is far tougher than a lieutenant, glows brightly in the group's colour, has the lieutenants' powers plus one of its own, and fights to the end.
- **Groups remember you**: stopping a group's operations, knocking out its members and busting its stash makes it notice you.
  - Once it has **noticed you**, more of its operations come with a lieutenant, an extra guard stands at its hideout, and now and then the boss leads an operation in person.
  - Once it is **out for you**, its members stand and fight instead of running, and the boss guards the hideout.
  - It calms down again over a few game days. A message tells you when a group starts paying attention.
- **Jail and breakout**: a boss the police cuff goes to jail for three game days (longer each time) and then breaks out. A boss who gets away after you went for them comes back with a grudge.
- **Breaking a group**: with its boss behind bars and its stash busted, a group collapses. It runs no operations until one of the two is over.
- Bosses, their records and every group's notoriety are kept in saves.
- Admin console, Crime & deeds: a gang, Syndicate and cult boss, a button that makes the gang hunt you, and a list of bosses and notoriety.

## 0.040 — 2026-10-05

- **Autorun and autoflight on R**: press R and you keep going forward on your own, walking or running on foot and flying when in the air (Shift still runs or boosts, the mouse still steers). Press R again, W or S to stop; it also stops when you sit down or are knocked down.
- **Rallying the army moved to G** (it was R): with reputation 40+, G makes the soldiers near you follow you. T still calls the airstrike.

## 0.038 — 2026-10-05

- **Two new villain groups**: every city now also has a **techno-cult** (grey work clothes with glowing seams, in industrial districts and the port) and an **elemental cult** (long dark robes with glowing trim, in the old town and the parks). They hold turf, fight the other groups and show on the map like the street gang and the Syndicate.
- **Robot hijacks**: techno-cultists walk up to a delivery robot and hack into it, with sparks and a blue glow, while a guard watches the street. Leave them be and the hack goes through: the robots, a service robot and drones nearby turn on people for a while, and the hackers slip away. Stop the hackers and the hijacked robots go dark. Get close in time and the hack is broken off.
- **Rituals**: three or four cultists stand in a circle before a landmark and chant, arms raised. A ring of runes lights up and a column of fire, frost or lightning rises, stronger the longer it runs. Left alone for half a minute it ends in a burst that knocks back everyone near; break the circle and it never happens.
- **New lieutenants**: the techno-cult's **Technomancer** fires lightning, raises a shield and sets off an **EMP** that stalls cars, drops drones and jolts and slows you; the cult's **Invoker** throws fireballs, frost rays and gusts of wind.
- Admin console, Crime & deeds: a robot hijack, a ritual, each with its lieutenant, and a button that brings hacks and rituals under way to their end.

## 0.037 — 2026-10-05

- **Fixed a crash while generating some cities** (for example seed 17 at size 0.75 and seed 1234 at the largest size): planning the bridges over the river read a water lookup after another lookup had already overwritten it. These cities now generate normally.

## 0.036 — 2026-10-05

- **Marvels**: some cities now have breathtaking near-future landmark buildings, different in every city. Towns get one now and then, big cities often, megacities up to three. There are eight kinds, each shaped differently every time:
  - a **starship spire**, 340 m to a kilometre tall (big cities only): a rocket hull standing on swept fins, with engine pods, sometimes strap-on boosters, and observation rings
  - a **helix tower** wound by one or two glass walkways that you can walk up from the street to the roof
  - a **slab pierced by giant round holes** that you can fly through
  - a **twisted tower**, a **skyship** (towers carrying a long sky park), a **halo tower** with rings on spokes, **orbs** (spheres on a stalk, or a giant molecule standing on one corner) and a **stack** of cantilevered blocks
- They are on the map, the compass and the minimap like the other landmarks, with a plaza around them. Their windows light up at night, and the glass of walkways, domes and orbs is see-through.
- **They can be smashed**, piece by piece, like the city's buildings: punches, blasts, fireballs, monsters and the army all break off what they hit. Cut through a level and everything above it loses its hold: a tall top topples toward the damaged side (from high up it tumbles as it falls) and crashes down across the streets, flattening what it lands on and leaving a line of rubble; a wide, low part comes straight down and crushes what is under it. Collision follows the damage (you can walk through the holes, and broken walkway is gone), and saves keep it.

## 0.035 — 2026-10-05

- **Villains with powers**: the street gang and the Syndicate now send lieutenants now and then. They are tougher, dressed in their group's colours with glowing trim, and stand and fight with powers instead of running.
  - The gang's **Brute** braces and charges you shoulder first, or stamps a crack along the pavement that knocks down whoever stands on it.
  - The Syndicate's **Enforcer** lobs stun grenades, fires a frost gun that slows you down, raises a shimmering shield that soaks up your punches, and drops a smoke bomb to slip away when it goes badly.
- Every power has a clear wind-up: light gathering in the hands, a cast pose and a sound. The aim is fixed when the wind-up starts, so a step to the side gets you out of the way. No single power can knock you out, and at most three villains cast at once.
- Knocking out a lieutenant earns double karma.
- Clothing can glow now: a lieutenant's jacket or suit has lit seams in the group's colour.
- Admin console, Crime & deeds: a gang Brute, a Syndicate Enforcer, a brawl with lieutenants on both sides, and a test villain with bolt, fireball and gust.

## 0.034 — 2026-10-05

- **No more orange blobs in your face**: embers, flames and smoke puffs right in front of the camera now fade out instead of filling the view as big flat discs.
- **Sandbox shows no karma**: the police and witness messages ("people saw it", turning yourself in, being arrested) no longer mention karma or fines in sandbox, where there is no karma.

## 0.033 — 2026-10-05

- **The army comes for you**: a giant on a rampage with a bad reputation is now treated like a monster. First a warning (a siren, the screens around you turn to the red alert, a police drone overhead, an officer shouting up at you), then a final warning, then the whole response: police and SWAT firing from a distance, cordons and evacuation sirens, the National Guard, tanks, attack helicopters, jets and artillery — and, rarely, the tactical nuke countdown, aimed at you.
- **Ending it**: stop wrecking things for a while, or shrink back to human size, and the army stands down — but once it has been called it keeps after you for four minutes at least, so the Guard and the tanks get there and fight. Get knocked out and you are taken into custody. After that the slate is clean: rampage again and you get warned first. Start again soon after and the army comes back without new warnings.
- **Tanks, APCs and infantry fight too**: ground units close in on you (tanks to about 480 m, APCs to 350 m, infantry to 250 m) and follow you when you walk off, pick spots with a clear view of you, don't park behind each other, aim at whatever part of you they can see (a shoulder past a corner, the top of your head over the roofs) and move to a better spot when they lose sight of you. A tank with a building in the way shoots its way through the facade. Infantry and APCs without a clear view fire over the roofs at your head (they hit less often). A rifle squad whose truck doesn't come goes on foot. While the army is after you, your health comes back much more slowly. Soldiers no longer get knocked over by their own side's shells.
- **Fix**: a giant knocked down or knocked out no longer turns into a giant ragdoll, which could fall through the ground or break the physics for the rest of the game.
- **Fighting back** works: stomp tanks and trucks, knock soldiers down, punch helicopters out of the sky. The news drone films you on the city's screens.

## 0.032 — 2026-10-05

- **Turf wars**: where the gang's streets meet the Syndicate's, the two groups now fight it out — two or three of each, fists, bats and the odd knife, each in their own colours. Left alone, one side is beaten and the winners take the street (a message says who won). Step in and the fight breaks up: both groups lose ground, and the karma for stopping it comes right then.
- **Hideouts**: every group keeps a stash behind an ordinary door in its turf, with two or three guards loitering outside. Walk past it (or have a cuffed member give it away) and it is marked on the map. Deal with the guards and press **E** at the door to bust the stash — the group loses the block its stash was in, and ground around it, and lies low for a day and a half before it sets up somewhere else.
- **The map moves by itself**: every game hour the borders creep a little — groups push into the streets next to theirs, rivals press on each other, and a group you have beaten back holds less for a long while (it always comes back to its home ground eventually). You hear about it when it is the block you are standing in.
- **Stopping a crime pays at once**: karma, reputation, the cheer and the group losing ground now come the moment the last of them is down or gives up, not when the police finally cuff them.
- Rackets look like extortion, not a fight: the collector stands over the shopkeeper with a pointed word, the shopkeeper hands over a fat envelope (no screaming, no shove), and the envelope is what drops when you knock the collector down.
- Tags go on the wall between the windows of ordinary houses, a little smaller and just above the ground floor's base — no more tags on shop windows.
- Saves keep the turf exactly as it was, including blocks a group just about holds on to.
- Admin console, Crime & deeds: racket, tagging, turf brawl, groups and hideouts, go to the gang's hideout, 24 h of turf drift.

## 0.031 — 2026-10-05

- **Fireball**: a new elemental power. Hurl a ball of fire that flies to your target (or where you aim) and bursts: people are thrown and set alight, cars burn (from rank 3 they are blown up), props topple, windows and, at high rank, walls are blown in. Buy it on the powers screen (P). The old blast power is still there as **Shockwave**.
- **The mad bomber**: a rare new crime. A madman walks into a busy street with a bag of round black bombs and lobs them about: into the crowd, under cars, at the police and at you once you come close. Each bomb lies hissing and sparking on its fuse before it goes off, so you can get out of the way (his throws at you go a little wide, and a dash sideways on the fuse gets you clear). Fires his bombs start are never booked to you. Knock him out or wait for the police; out of bombs, he runs. The street gang sends one now and then in its turf.
- Admin console, Crime & deeds: start a mad bomber.

## 0.030 — 2026-10-05

- **Laser eyes look stronger**: thicker beams with a white-hot core inside a pulsing red halo, a flare at each eye, a bigger glow where they hit, twice the sparks, molten drips and more smoke. Damage, reach and energy cost are unchanged.

## 0.029 — 2026-10-05

- **Villain groups, second step**: the street gang now runs its own rackets. Its collectors lean on shopkeepers in their doorways for protection money, and **taggers** spray the gang's emblem and name on walls (with a hiss of the can and a lookout now and then). Both happen only in the gang's turf.
- **Tags stay on the walls** when nobody stops them; caught in the act, the tagger runs and the half-done tag is never finished.
- **Your work changes the map**: stopping a group's crimes loosens its grip on that block and the ones next to it, until it loses them ("… lost their grip on a block"). Crimes that come off and fresh tags let it grow back and take over new streets.
- Turf, the tags on the walls and the groups' tallies are kept in **saves**. Older saves load with the city's starting turf.

## 0.028 — 2026-10-05

- **The countryside is lived in**: hamlets, villages and small towns now dot the land around the city — houses along their streets in the local building style, a church with a spire on the village square, shops round the square in the towns, gardens with trees.
- **Farmsteads** out in the fields: farmhouse, barns and sheds round an earth or gravel yard, a dirt track to the road, some with an orchard.
- **Country roads** lead out of the city and link the villages, with a dashed centre line; village lanes and side streets; roads cut through the forests.
- **Lakes** in the open country, with shores and groups of trees round them — you can swim in them.

## 0.027 — 2026-10-05

- **The swarm**: a new city event. Manhole lids rattle and chitter, a few creatures dart from one manhole to another — then the brood pours out of the sewers: up to 150 chittering creatures spreading through the street like a dark carpet. They knock people down, gnaw cars to a standstill (the big ones roll them over), chew robots apart, go for you, and run up facades and over low roofs.
- A good first monster for a weak hero: a punch kills a small one. Fire wave and chain lightning clear whole clumps (the lightning jumps from creature to creature), frost nova freezes them so the next blow shatters them, and the stomp, whirlwind and water jet scatter them. The police come and shoot and baton them.
- Killing them earns karma (more for the big ones and for saving someone); beating the swarm back earns a bonus and cheers. Once most are dead, the rest flee back underground.
- Admin console, City events: spawn a scout pack or a full swarm, show its omens.

## 0.026 — 2026-10-05

- **Villain groups, first step**: every city now has a street gang and a Syndicate with their own names, colours and emblem — different in every city (for example "the Harbour Saints" and "Marlow Holdings").
- Each group holds **turf**: the gang in the rough housing estates, docks and industrial streets, the Syndicate in the centre. A new **Turf** layer on the map shows who runs which streets, with the groups listed in the legend.
- Crime in a group's turf is its work: the gang mugs, the Syndicate robs shops. Its members wear its colours (gang caps and jackets, dark Syndicate suits), the target frame names the group, and the map marks their crimes in its colour.

## 0.025 — 2026-10-04

- **Landmarks**: every city now has a town hall with a square in front (classical with columns and dome, gothic with bell tower, baroque with clock tower, or modern with a campanile), a stadium (oval or rectangular, open, partly or fully roofed, floodlights, scoreboard, car parks) and 1–4 tourist attractions picked and shaped differently in every city: TV or lattice or glass observation towers, cathedrals, a Ferris wheel, monuments (obelisk, column, triumphal arch, statue), museums (colonnade or glass pyramid), a lighthouse on the coast, a castle or ruin on the highest hill, botanical glasshouses.
- **Airports** for bigger cities: runways, terminal with jet bridges, control tower, hangars, parked airliners in different liveries, and a road out to it.
- All of them have names, are shown on the map, minimap and compass, and are solid — you can stand on roofs and stands.

## 0.024 — 2026-10-04

- Sewers: the grey see-through slabs standing in the tunnels are gone — they were meant as daylight falling through the manhole lids. Now the lid glows overhead and a soft pool of daylight lies on the walkways and water below it.
- Outlet pipes dribble a thinner stream.

## 0.023 — 2026-10-04

- **Wrecking buildings has consequences**: smashing facades in front of people costs reputation and karma and draws the police; bringing a building down is seen by everyone — a big hit to reputation and karma (the taller, the worse) and the police come for you.
- Applies however it happens — punches, slamming through walls, a giant's footsteps, landing on a roof, any power. What the monster, the army or a fire wrecks is never blamed on you; a building you damaged that falls within two minutes is.

## 0.022 — 2026-10-04

- **Sewers pass**: every trunk now has its own character — red, yellow or brown brick or concrete, stone ribs across the vault in some, a deep stone portal where one tunnel opens into another, a dark grime band along the foot of the walls and a darker channel.
- Round pipes on brackets along the walls that stop properly at openings and turn into the wall — no more grey "railings" running straight across the junctions.
- Outlet pipes dribble water into the channel; lamps are spaced differently per tunnel and some are dead; daylight falls through the manhole lids.
- **Finding the slimes**: the Lumen's signs are now much easier to spot — their sign on both walls of the right branch at every junction, a big glowing arrow pointing the way, and glowing chevrons along the walkway on the last stretch. Close to a colony, a Lumen scout sometimes waits at a junction and flees down the right tunnel.

## 0.021 — 2026-10-04

- **Characters in the streets**: a doomsayer with a sandwich board warning that the end is nigh, buskers, living statues (silver or gold) that come alive when you get too close, a mime trapped in an invisible box, jugglers, street dancers (sometimes a crew round a boombox), a chicken mascot handing out flyers for a café round the corner, a tinfoil-hat conspiracy theorist, the pigeon lady, a lost tourist asking the way, neon joggers — and at night a sleepwalker in pyjamas.
- Passers-by stop to watch the performers and drop coins; you hear the busker's guitar and the dance crew's beat.
- They talk to you: about you flying past, being a giant or tiny, your reputation, being wanted.
- When danger comes they drop everything and run — and the doomsayer finally gets to say "I told you so".
- Fix: a flock of pigeons scared up once never settled back to normal.

## 0.020 — 2026-10-04

- **Stairs everywhere**: almost every building with more than one storey now has a real stairwell — a stair hall at one end of each floor with a switchback staircase (two flights and a landing per storey, handrails). Walk up as far as the building goes; no more being stuck on the ground floor without a lift.
- **Furniture is solid**: you no longer walk through beds, sofas, tables, shelves and counters. The way in through the front door is always kept clear.
- **Sit down indoors**: **E** next to a chair, sofa or armchair.
- **Prettier rooms**: walls painted per room on each side, with plaster texture, baseboards and door frames; tiled bathrooms; pendant lamps with glowing shades over tables, ceiling lamps in halls; patterned rugs; much more detailed furniture — cushioned sofas, made beds with pillows, kitchens with hob, sink, tap, wall cabinets and hood, bookshelves full of books, plants with leaves, vases and bowls, bedside lamps, TVs and monitors that glow.
- **Better layouts**: office lobbies take the front of the ground floor with offices behind; residential towers have flats on the ground floor instead of a vast empty hall; offices get filing cabinets, a water cooler, plants and a meeting room with chairs and a screen; bedrooms get a second bedside table and a desk chair; baths a mirror.

## 0.019 — 2026-10-04

- **Saves: your own saves first.** The load list now shows the games you saved by name on top, and the autosaves in a section of their own below (folded away unless they are all there is).
- **One sewer network**: under every bridge a culvert now dips beneath the river, so the sewers of the whole city connect — you can walk from any manhole to any other. (Side rooms and the hidden colonies are laid out anew in every city because of it.)
- **The Lumen's signs**: at every junction in the sewers, a faint glowing sign is painted on the wall of the branch that leads towards the nearest slime colony — each colony has its own sign — brighter the nearer you get, and close by a trail of glowing drops on the walkway. Nothing says what they mean.
- Fix: the deep caves could grow phantom bumps of rock where two cave shapes met (most noticeable on the lower part of the Throat's ramp).

## 0.018 — 2026-10-04

- **The slime civilisation**: behind the hidden slime colonies there is now a whole world, deep under the city — two peoples of slimes in a war that never ends.
  - **The Lumen** (soft, glowing) live in the Glow, about 60 m down: a vast domed Hall with terraces full of their little domed homes round a pool and the Spire (a rock column ringed with glowing fungus shelves), a council sitting in a ring of standing stones, a nursery, the Gardens (a forest of giant glowing mushrooms), the Lake with a waterfall, and the Archive, where they keep the things they find in the city — and their mosaics.
  - **The Murk** (dark, spiked, ember-cored) live in the Deep, 50 m further down: the Warrens with crystal spikes, hives and pens of captured Lumen, and the Heart chamber, where a shard of the falling star sits on a mound with glowing veins running to it. The Maw guards it.
  - **The Front**: the Lumen hold a living barricade at the lip of the Throat, a 50 m shaft with a ramp spiralling down its wall and a natural bridge across it. The Murk raid it again and again — be there and fight with the Lumen, or the line falls back; if the Murk take the Hall and grow strong, at night some of them break out of the sewers into the city (the police come).
  - **Getting there**: from a colony's chamber a gate (a living membrane) opens onto a broad road that winds down to the Hall. The gate only opens for someone the Lumen know.
- **Lumen trust**: patience earns it (take the brave one's gift in a colony), and so does fighting the Murk, holding the Front, tearing open the Murk's pens (**E**) and bringing down the Maw. Hurting a Lumen costs a lot. Friends are greeted, followed by the little ones, given glow pebbles (full energy) and carried up the Throat by the Lumen lift (Ctrl / C to sink).
- **New power: Slime call** — not bought with karma but given by the Lumen's trust (Ally: rank 1, Kin: rank 2, and rank 3 at full trust once the Maw has fallen). Near a manhole (or underground), the Lumen pour out to your target: they hold a criminal down, stall a car or a machine, gnaw at a monster, fight the Murk or smother a fire.
- **Fighting slimes**: every Murk can be targeted (Tab) and hit by punches and every power; brutes and the Maw show a weak ember core when they strike, and they spit. Area powers and blasts hurt Lumen too — careful.
- Powers and line of sight work in the caves (and the sewers): rock is what stops a shot down there.
- New sounds for the caves, the Heart, the Murk and the Lumen; the music turns to tension and battle when the Murk fight you or a raid is on.
- Saves keep the Lumen's trust and the state of the war.

## 0.017 — 2026-10-04

- **Line of sight for everybody**: buildings, terrain and cars block shots — yours, the police's, criminals' and the army's (a hole blasted in a wall lets them through).
- **Targeted powers never miss**: with a target picked (Tab or click), a power hits it — or, without a clear line or out of reach, does not go off at all (no energy spent; the target frame says why). Without a target, a power flies where you aim and hits whatever is there: a bystander, a car, a window.
- **Explosions hurt bystanders**: army shells, rockets and bombs now knock down and injure people nearby (they count as injured, as with the creature).
- **Police vs you**: at wanted level 3 officers shoot at you, and a SWAT van joins the pursuit; below that they still chase and arrest.
- **Police vs the creature**: officers on foot fire at the Strider from a distance and run when it comes close — little damage, but it may turn on them.
- Police shout what they are doing ("Take cover!", "Fall back!").

## 0.016 — 2026-10-04

- **Background music**: eight new pieces for the city — a calm lo-fi day, noir jazz at night, a dark drone underground, tension when trouble is near (a robbery, robots, the creature on its way), battle when it fights, a quiet elegy afterwards, a heroic theme when you fly fast, and a menu theme. Calm music comes and goes (quiet stretches between pieces); the mood follows what happens. Darker in the rain, ducked in the pause menu.
- **Music volume**: a *Music* slider in Sound mix (65 % by default) and a *Music* on/off switch in the pause menu.

## 0.015 — 2026-10-04

- **Police carry guns**: officers have pistols, SWAT rifles. At a robot event they shoot down rogue drones and wear down machines from a firing spot (kneeling, aiming), and hold fire when people are in the line. Useful, but much weaker than your powers.
- **Armed criminals**: some robbers and muggers carry a gun. They mostly threaten — they shoot at you only once you have hurt one of them, or at police who chase them. Police shoot back; a wounded gunman may surrender. Bystanders run from gunfire.
- **Fix**: police at a robot event could run in place for good (two orders contradicted each other when only drones were left). People who get nowhere for a few seconds now take another way or give up the chase.

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
