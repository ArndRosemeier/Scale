# Sidekick — plan

Status: **plan, nothing built** (Arnd, 2026-10-07: "an optional sidekick once reputation is high enough; the player
finds a second crystal and gives it to someone; the sidekick was a normal person and keeps their traits; really
autonomous, not taking orders, but naturally inclined to help; the player can give karma, the sidekick decides what
to spend it on and earns karma himself"). Decisions below were settled with Arnd in the project thread the same day;
lines marked *(default)* are Claude's picks that he has not ruled on yet.

Builds on: people with personalities (NPC_PERSONALITY_PLAN: traits, memory, social web, needs, favours), villain
power casting (powers/Caster, crime/VillainCasts), karma and ranks (abilities/Progress), reputation (Reputation.ts),
defeat and the revival ward (game/defeat), CityNews, the origin intro (game/intro).

## 1. Decisions

1. **Optional.** The player never has to take a sidekick.
2. **Unlocked by reputation.** The first time reputation reaches **+30** *(default: where crowds start cheering)*,
   the second shard turns up.
3. **The player picks the person** by offering them the crystal. They keep who they were: name, body, face, traits,
   temperament, job, friends, needs and their memory of the hero.
4. **Autonomous, not a pet, not a second hero.** The sidekick is *around*: they live and do their own small deeds
   near the hero, join fights by their own judgement, and come when called. The player **asks, never orders**; the
   sidekick accepts or refuses in character and says why.
5. **Intent is visible.** Short bubbles say what they are doing and why ("I'll get the kids out", "That one's mine!",
   "Not the police. I'm out."), so autonomy reads as personality, not as bugs.
6. **No size powers** (no giant, no shrink): no unwanted damage. **A travel power comes first** so they can keep up.
7. **Outside the reputation system.** Nothing the sidekick does changes the hero's reputation or their own; the
   sidekick never attacks the police on purpose, so there is nothing to mitigate.
8. **Reputation below 0 breaks the bond** at once.
9. **Death is possible.** A defeated sidekick goes to the revival ward like the hero, but the revival fails 20 % of
   the time (the hero always beats those odds). After a death a new shard turns up the same way as the first, so the
   sidekick is replaceable in principle.
10. **Turning villain** is a good idea for later, not now (§7).

## 2. Finding the shard

Hiding it somewhere in a city of this size would be unfair. Two parts instead:

- **The city finds it first.** A CityNews item: "Strange glowing stone found at …", with a photo and a place: a
  building site, the museum, a pawn shop, a park pond *(default list)*. The map gets a circle (~200 m) around where
  it was reported.
- **The pull.** Within ~300 m the hero feels it the way they feel people in need: a low hum, a soft pulse at the screen
  edge in its direction, growing stronger closer. At a few metres the shard glows through whatever covers it.
- **Sometimes someone else wants it** *(default 30 %)*: a gang snatches it before the hero arrives (a short
  Snatch/Robbery-style crime with the shard as the loot); the pull then follows the thief.
- Picking it up: the hero carries it (a held item, like returned property). It stays until given away; it is saved.
- **Repeatable:** after a sidekick's death the next shard is reported the same way, a few in-game days later
  *(default)*.

## 3. Choosing and offering

- With the shard in hand, the talk menu (E) gains **"Offer the crystal"**.
- They **agree** unless something personal stands against it *(default rules)*:
  - they dislike the hero (memory: hurt by them, or a low opinion),
  - they are against heroes on principle (hero protesters, members of a villain faction or gang),
  - a need of theirs comes first ("Not now, my mother is in hospital"): turns into a favour; once it is done they
    accept,
  - always refused: children; police and soldiers on duty.
- A refusal keeps the shard with the hero; they can offer it to someone else.
- **Awakening:** a short scene in the spirit of the origin intro: the shard's light pours into them, they stagger,
  look at their hands, a first line in their own voice. Their map dot becomes a gold sidekick marker.

## 4. Being around

- **Their day goes on**, compressed: they still go home and to work sometimes, but mostly they stay within about
  150 m of the hero *(default)*, doing small deeds (helping people up, returning things, stopping a mugger).
- **Joining a fight:** when a crime or threat flares within ~80 m of the hero, they decide by character: brave and
  agreeable ones jump in, nervous ones get bystanders clear first, proud ones go for the boss. They say so.
- **Keeping up:** when the hero travels away, the sidekick follows with their travel power, never by teleporting into
  view. Far behind and out of sight, they may cover distance faster (as off-screen walkers already do) and arrive
  flying or running in from the edge of view.
- **Calling for help** *(default key K; H is the controls help)*: a shout and a flare; they come at full speed unless they refuse (§6).
- **No police fights:** if the hero is wanted and the police close in, the sidekick steps back and says so.
- **Talking:** E opens their menu with extra entries: how they are getting on with the powers, what they bought, give
  karma, the asks. The later OpenRouter talk backend fits the sidekick best of all.

## 5. Karma and powers

- **Own earning:** the sidekick's deeds give *them* karma at the hero's rates. Nothing goes to the hero.
- **Gifts:** "Give karma" in the talk menu moves an amount from the hero's balance. The gift may carry a wish
  ("I'd like you to learn healing"); they honour it or not, by character and trust.
- **Their roster:** the hero's powers minus size and shrink *(default: also minus slime call)*.
- **Spending follows their traits** *(default weights)*: first a travel power: flight if the hero flies a lot, super
  speed otherwise. Then curious → elemental, dutiful → shield and support, outgoing → flashy and loud, disagreeable →
  hard hitters, nervous → movement and escape. They tell the hero what they bought and why.
- Their elemental powers go through the existing caster core, so they look like the hero's.

## 6. Asks and trust

- Asks: **help me**, **stay back**, **go home for now**, **come with me** *(default set)*.
- Trust grows with time together, karma gifts, fights won side by side, and the hero helping their friends. It drops
  when the hero hurts bystanders, leaves them in a losing fight, or asks for things against their character.
- They accept or refuse by trust and traits, always with a reason in a bubble.
- **Bond break:** the moment reputation drops below 0 they leave ("I can't stand next to you any more."). They keep
  their powers but go back to their old life and stop helping *(default)*. If reputation climbs back to +30, talking
  to them can win them back *(default)*.

## 7. Defeat and death

- A defeated sidekick is carried off by the med drones and goes into the revival ward.
- **80 %:** they walk out of the hospital, a bit shaken, and come back to the hero.
- **20 %:** the machine flatlines. They are dead. A grave with their name appears in a cemetery; their friends in
  the social web grieve (mood, lines about them). Karma they held is lost. The next shard is reported later (§2).
- **Later idea (not now):** a sidekick who left after the bond broke, or was neglected, could turn villain.

## 8. Saves and sandbox

- Sidekick state is part of the per-city save like Progress and Reputation: who, karma, ranks, trust, bond, shard
  state, the dead.
- Sandbox: the shard is available at once, all powers maxed. `dev.sidekick.*` for shard, offer, call, defeat, die.

## 9. Phases

1. **The shard:** unlock at +30, the news item, the pull, picking it up, the gang variant, offering in the talk menu,
   refusal rules, the awakening scene, saves.
2. **A sidekick around:** a full body actor for the chosen person, ground and flight movement, the "around"
   behaviour, joining fights with punch plus one power, intent bubbles, call for help, keeping up, defeat with the
   80/20 revival, the grave and the next shard.
3. **Karma:** own earning, gifts and wishes, trait-driven spending, the roster.
4. **Asks and trust:** the asks, trust, refusals, the bond break and winning them back.
5. **Later:** turning villain; OpenRouter talk for the sidekick.

Each phase is playable on its own. Phase 2 is the largest (the sidekick is closer to a second player than to a
pedestrian) and changes what you see, so it needs a GPU check; phase 1's awakening scene does too.
