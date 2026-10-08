# Changelog

Every push raises the version by 0.001. Newest first.

## 0.147 — 2026-10-08

- **Three costumes, on F1, F2 and F3.** At the start all three are your hero's look. The fitting mirror in a clothes shop now changes only the costume you are wearing, so you can keep, say, street clothes on F1 and your hero suit on F2 and switch anywhere in the city. The three costumes are kept in your saves. The keys can be moved in the help (H, Keys). The detailed info line (frame rate, position) moved from F3 to F4.

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
