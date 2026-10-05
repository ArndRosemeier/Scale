# Changelog

Every push raises the version by 0.001. Newest first.

## 0.045 — 2026-10-05

- **Being defeated is a real moment now.** When your health runs out you no longer just get up where you fell (where a swarm could knock you down again and again). You lie there untouchable, the edge of the screen red, and:
  - **with a reputation of 0 or better, the hospital sends its rescue drones**: three white drones with red crosses fly in, lock blue tractor beams onto you, lift you in a glowing stasis field and fly you over the city to the landing pad that lights up on the hospital's roof. Space skips ahead.
  - **in the hospital's revival ward** you lie in a high-tech revival machine under a glass canopy: scanning rings sweep along your body, the vitals hologram climbs, your heart starts again, a surge and a white flash, the canopy opens and you stand up beside it with full health. Walk out through the sliding doors at the end of the ward and you are on the street in front of the hospital.
  - **with a negative reputation nobody comes: game over.** Load the latest save, pick another save, or start a new game. Nothing is saved after a game over, so your saves stay as they were.
- Every city has its own hospital (Helix Medical Center, Vitalis Medical Center, …) in some of its flat-roofed office and civic blocks; the drones take you to the nearest one. A giant hero shrinks back to normal size while lying there.
- Knocked out again in the ward before leaving: straight back into the machine.
- Being arrested by the police is unchanged. A save made on the way to the hospital or in the ward puts you outside the hospital, healed.

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
