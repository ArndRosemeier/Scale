/**
 * What people say (NPC_PERSONALITY_PLAN §3.2), as rules in the style of Valve's dynamic dialog
 * (Ruskin, GDC 2012): every entry has criteria over the talk facts and a few ways to say it. The
 * most specific entry that matches wins (talk.ts `pickLine`), so a grumpy dock worker who was
 * knocked down by the hero last week says something only he would say, and everybody else still
 * has a line.
 *
 * Tokens: {first} {last} {full} {title} {aTitle} {interest} {street} {metStreet} {group} {boss}
 * {city} {place} {dir} {dist} {days} {heard} {hood}, and the social web's {teller} {bond} {who} {word} {asker};
 * a capital first letter ({ATitle}, {Group}, {Dir}) capitalises
 * the value. An entry that uses {street}, {metStreet}, {group}, {boss} or {heard} must require it in `when`
 * ({hood}: require a `safety`).
 *
 * Pure data.
 */
import type { JobKind, Temperament } from './identity';
import type { Safety } from '../news/pulse';

export type Topic = 'hello' | 'mood' | 'job' | 'hobby' | 'news' | 'way' | 'favour' | 'me' | 'bye';

/** Where a favour stands (phase 4): asking now (visit / streets), open, done, let down, nothing. */
export type FavourState = 'visit' | 'streets' | 'open' | 'done' | 'lost' | 'none';

export interface When {
  temper?: readonly Temperament[];
  /** Mood range (−1..1), inclusive. */
  mood?: readonly [number, number];
  /** Opinion of the hero range (−100..100), inclusive. */
  op?: readonly [number, number];
  /** Met before (true) or a stranger (false). */
  met?: boolean;
  /** What happened between them last time it mattered. */
  deed?: 'helped' | 'saved' | 'hurt';
  /** Days since you last met at least this many. */
  away?: number;
  night?: boolean;
  morning?: boolean;
  wet?: boolean;
  storm?: boolean;
  /** Destruction or danger nearby lately. */
  trouble?: boolean;
  /** A monster or another big threat in the city lately. */
  threat?: boolean;
  child?: boolean;
  senior?: boolean;
  job?: readonly JobKind[];
  /** Exact job titles (identity JOB_TITLES). */
  title?: readonly string[];
  interest?: readonly string[];
  /** A villain group holds this street. */
  group?: boolean;
  boss?: boolean;
  street?: boolean;
  metStreet?: boolean;
  /** The hero is giant-sized. */
  giant?: boolean;
  /** The place asked for is far (way topic). */
  far?: boolean;
  /** Something they heard lately (game/news: city news as a sentence). */
  heard?: boolean;
  /** How safe these streets are (game/news: the neighbourhood's live crime index). */
  safety?: readonly Safety[];
  /** What someone close to them ({teller}, their {bond}) told them the hero did to them (social.ts hearsay). */
  told?: 'helped' | 'saved' | 'hurt';
  /** The need that presses now (social.ts needs). */
  need?: 'hunger' | 'tired' | 'lonely';
  /** Where the favour they asked stands ({who}, their {word}; streets: {group} or the street). */
  favour?: readonly FavourState[];
  /** They are the one somebody ({asker}) asked you to look in on. */
  sent?: boolean;
  /** The Wardens about now (game/aliens): a swarm overhead, a walker close by, a disc hanging or scanning near. */
  nannies?: readonly ('swarm' | 'walker' | 'disc')[];
}

export interface LineEntry { id: string; when: When; say: readonly string[] }

const S = (...say: string[]) => say;

export const LINES: Record<Topic, readonly LineEntry[]> = {
  hello: [
    { id: 'hs0', when: { title: ['busker'] }, say: S('Hey! Got a request? I know three songs. Well, two and a half.', 'Hi, I\'m {first}. Mind the hat, that\'s my rent in there.') },
    { id: 'hs1', when: { title: ['living statue'] }, say: S('(The statue doesn\'t move. Then, barely moving its lips:) Not while I\'m working.') },
    { id: 'hs2', when: { title: ['mime'] }, say: S('(The mime waves, then mimes a very large wall between you.)', '(The mime bows deeply and pretends to tip a hat that isn\'t there.)') },
    { id: 'hs3', when: { title: ['juggler'] }, say: S('Hi! Don\'t make me laugh, I\'ll drop everything.') },
    { id: 'hs4', when: { title: ['street dancer'] }, say: S('Yo! Want to join in? We need someone who can fly.') },
    { id: 'hs5', when: { title: ['chicken mascot'] }, say: S('(Muffled from inside the chicken:) Hi! I\'m {first}. It\'s very hot in here.') },
    { id: 'hs6', when: { title: ['conspiracy theorist'] }, say: S('Finally, someone they can\'t control. I\'m {first}. Listen carefully.') },
    { id: 'hs7', when: { title: ['pigeon lady'] }, say: S('Hello, dear. Careful, you\'ll scare my little ones. I\'m {first}.') },
    { id: 'hs8', when: { title: ['sleepwalker'] }, say: S('Mmh… five more minutes, Mum…', '(Still asleep:) The ducks… the ducks know…') },
    { id: 'hs9', when: { title: ['lost tourist'] }, say: S('Oh thank goodness! Excuse me, do you speak — oh, you\'re the hero! I\'m {first}, I\'m a bit lost.') },
    { id: 'hs10', when: { title: ['jogger'] }, say: S('Hi! (pant) Can\'t stop (pant) long. {first}.') },
    { id: 'hs11', when: { title: ['doomsayer'] }, say: S('The end is near! Oh — hello. {first}. The end is still near, though.') },
    { id: 'hs12', when: { title: ['police officer'] }, say: S('Officer {last}. Everything alright here?', 'Afternoon. {last}, city police. Need anything?') },
    { id: 'hs13', when: { title: ['paramedic'] }, say: S('{first}, paramedic. Are you hurt? No? Good, I\'m busy enough.') },
    { id: 'hs14', when: { title: ['soldier'] }, say: S('Private {last}. Please keep back from the line, sir or madam.') },
    { id: 'hs15', when: { title: ['shopkeeper'] }, say: S('Welcome, welcome! {first}. Looking for anything?') },
    { id: 'hs16', when: { title: ['cleanup worker'] }, say: S('{first}, cleanup crew. Mind the rubble.') },
    { id: 'hs17', when: { title: ['firefighter'] }, say: S('{first}, fire brigade. Keep back from the smoke.', 'Stay clear of the hose, please.') },
    { id: 'h0', when: { met: false }, say: S('Hi. I\'m {first}.', 'Hello! {full}. Nice to meet you.', 'Hey. {first}, {first} {last}.') },
    { id: 'h1', when: { met: false, temper: ['shy'] }, say: S('Oh! Um, hi. I\'m {first}.', 'H-hello. {first}. Sorry, I don\'t usually talk to… you know. Heroes.') },
    { id: 'h2', when: { met: false, temper: ['grumpy'] }, say: S('What? …Fine. {first}. What do you want?', '{last}. And no, I don\'t want an autograph.') },
    { id: 'h3', when: { met: false, temper: ['chatty'] }, say: S('Hello hello! I\'m {first}, {first} {last}, but everybody just says {first}. And you\'re — wait, you\'re the hero, aren\'t you?') },
    { id: 'h4', when: { met: false, temper: ['cheerful'] }, say: S('Hi there! I\'m {first}. Lovely day to meet a hero!', 'Oh, hello! {first}. What a nice surprise.') },
    { id: 'h5', when: { met: false, temper: ['anxious'] }, say: S('Oh — hello. Sorry. I\'m {first}. Is something going to happen?', '{first}. Hi. Is everything alright? You\'re not here because of a… a situation?') },
    { id: 'h6', when: { met: false, temper: ['proud'] }, say: S('{full}. Pleased to meet you, I suppose.', '{full}. You may have heard of me. No? Well.') },
    { id: 'h7', when: { met: false, temper: ['kind'] }, say: S('Hello, dear. I\'m {first}. Are you alright? You look like you\'ve had a long day.', 'Hi, I\'m {first}. Can I help you with something?') },
    { id: 'h8', when: { met: false, temper: ['nosy'], street: true }, say: S('Hello! {first}. So what brings a hero to {street}? Something going on?') },
    { id: 'h9', when: { met: false, temper: ['dreamy'] }, say: S('Oh, hi. {first}. Sorry, I was miles away.') },
    { id: 'h10', when: { met: false, child: true }, say: S('Hi! I\'m {first}! Are you a real superhero? Can you fly?', 'I\'m {first} and I\'m nearly {years}! Are you strong? Show me!') },
    { id: 'h11', when: { met: false, senior: true, temper: ['kind', 'cheerful', 'chatty'] }, say: S('Well, hello there, young one. {full}. In my day heroes wore capes, you know.') },
    { id: 'h12', when: { met: false, giant: true }, say: S('Whoa. Hello up there! I\'m {first}! Please don\'t step on me.') },
    { id: 'h13', when: { met: false, op: [-100, -40] }, say: S('You\'re the one from the news. {first}. Keep your distance, alright?') },
    { id: 'h14', when: { met: false, op: [40, 100] }, say: S('Oh wow, it\'s you! I\'m {first}! My friends won\'t believe this.') },
    { id: 'h20', when: { met: true }, say: S('Oh, hello again!', '{first}, remember? Good to see you again.', 'Hey, it\'s you again.') },
    { id: 'h21', when: { met: true, deed: 'helped', metStreet: true }, say: S('It\'s you! You helped me up on {metStreet}. I never thanked you properly.', 'You\'re the one who picked me up off the pavement on {metStreet}! Thank you, really.') },
    { id: 'h22', when: { met: true, deed: 'helped' }, say: S('It\'s you! You helped me up when I fell. I never thanked you properly.') },
    { id: 'h23', when: { met: true, deed: 'saved' }, say: S('My hero! I tell everybody about the day you came to help me.') },
    { id: 'h24', when: { met: true, deed: 'hurt' }, say: S('You again. Last time you knocked me flat. Mind your step.', 'Oh. You. My hip still hurts, thanks for asking.') },
    { id: 'h25', when: { met: true, temper: ['grumpy'] }, say: S('Hm. You again.', 'What now?') },
    { id: 'h26', when: { met: true, temper: ['chatty'] }, say: S('Hey! Back again! I was just telling my neighbour about you.') },
    { id: 'h27', when: { met: true, away: 2 }, say: S('Long time no see! It\'s been {days} days.', 'Well, look who it is! Where have you been?') },
    { id: 'h28', when: { met: true, child: true }, say: S('Hi again! Did you fight any monsters today?', 'It\'s you! I told my whole class about you!') },
    { id: 'h29', when: { met: true, op: [-100, -30] }, say: S('You. What do you want this time?') },
    { id: 'h30', when: { met: true, temper: ['shy'] }, say: S('Oh — hi again. You remembered me?') },
    // The social web (phase 4): word gets round; favours.
    { id: 'h40', when: { met: false, told: 'helped' }, say: S('Wait, you\'re the one who helped my {bond} {teller} up! {Teller} told me all about it. I\'m {first}.') },
    { id: 'h41', when: { met: false, told: 'saved' }, say: S('You saved my {bond} {teller}! I\'m {first}. Thank you, from all of us.', 'Oh! {Teller} is my {bond}. You saved them! I\'m {first}.') },
    { id: 'h42', when: { met: false, told: 'hurt' }, say: S('I know who you are. You knocked my {bond} {teller} down. {first}. Keep your distance.') },
    { id: 'h43', when: { met: false, told: 'hurt', temper: ['kind', 'cheerful'] }, say: S('{first}. My {bond} {teller} says you knocked them over. I\'m sure it was an accident… was it?') },
    { id: 'h44', when: { sent: true }, say: S('{Asker} sent you? Oh, that\'s sweet. Tell them I\'m fine. I\'m {first}, by the way.', 'You\'re checking on me for {asker}? Ha! I\'m alright, really. Thank you. I\'m {first}.') },
    { id: 'h45', when: { met: true, favour: ['done'] }, say: S('There you are! {Who} called me. Thank you for looking in on them, really.', 'Thank you! It meant the world to me.') },
    { id: 'h46', when: { met: true, favour: ['done'], temper: ['grumpy'] }, say: S('Hm. You did it. Thanks. Didn\'t think you would.') },
    { id: 'h47', when: { met: true, favour: ['lost'] }, say: S('Oh. It\'s you. I asked you for one thing…', 'I waited, you know. Never mind.') },
    { id: 'h48', when: { met: true, favour: ['open'] }, say: S('Hello again! Did you manage to do what I asked?', 'Oh, hi! Any news?') },
  ],
  mood: [
    { id: 'ms0', when: { title: ['mime'] }, say: S('(The mime draws a big smile on its face with one finger.)') },
    { id: 'ms1', when: { title: ['living statue'] }, say: S('(Not a twitch.) …Stiff.') },
    { id: 'ms2', when: { title: ['sleepwalker'] }, say: S('Zzz.') },
    { id: 'ms3', when: { title: ['chicken mascot'] }, say: S('Hot. So hot. Why did I take this job.') },
    { id: 'm0', when: { mood: [0.55, 1] }, say: S('Couldn\'t be better, honestly!', 'Wonderful, thanks for asking!') },
    { id: 'm1', when: { mood: [0.2, 0.55] }, say: S('Good, good. Can\'t complain.', 'Pretty good, actually.') },
    { id: 'm2', when: { mood: [-0.15, 0.2] }, say: S('Oh, you know. Fine.', 'Same as always.', 'Alright. Busy.') },
    { id: 'm3', when: { mood: [-0.5, -0.15] }, say: S('Bit of a slow day.', 'Could be better.', 'Meh. One of those days.') },
    { id: 'm4', when: { mood: [-1, -0.5] }, say: S('Honestly? Rotten.', 'Don\'t ask.') },
    { id: 'm5', when: { trouble: true, mood: [-1, 0] }, say: S('Shaken. Did you see what happened over there? I\'m still shaking.', 'Not good. All that noise, the dust… I thought the building was coming down.') },
    { id: 'm6', when: { wet: true, mood: [-1, 0.2] }, say: S('Wet. This rain gets into my bones.', 'Soaked through. Again.') },
    { id: 'm7', when: { wet: true, mood: [0, 1], temper: ['dreamy', 'cheerful'] }, say: S('I like the rain, actually. The city smells different.') },
    { id: 'm8', when: { storm: true }, say: S('With this storm? I just want to get home.', 'Did you hear that thunder? I nearly dropped my shopping.') },
    { id: 'm9', when: { night: true, mood: [-1, 0.3] }, say: S('Tired. It\'s late, I should be in bed.') },
    { id: 'm10', when: { morning: true, mood: [-1, 0.3] }, say: S('Not awake yet. Ask me after my coffee.') },
    { id: 'm11', when: { trouble: true, temper: ['anxious'] }, say: S('I heard the crashes. Is it over? Is it safe now?') },
    { id: 'm12', when: { trouble: true, temper: ['grumpy'] }, say: S('How do you think? Half the street is rubble. Was that you?') },
    { id: 'm13', when: { child: true, mood: [0.2, 1] }, say: S('Good! We had pancakes!', 'Super good! No homework today!') },
    { id: 'm14', when: { senior: true, mood: [-0.5, 0.2] }, say: S('My knees hurt, but that\'s old news.') },
    { id: 'm15', when: { temper: ['chatty'], mood: [0.2, 1] }, say: S('Great! I\'ve been thinking about {interest} all day.') },
    { id: 'm16', when: { met: true, deed: 'helped', mood: [0, 1] }, say: S('Better than the last time we met, thanks to you!') },
    { id: 'm17', when: { op: [50, 100], mood: [0, 1] }, say: S('Better now that you\'re here!') },
    { id: 'm18', when: { threat: true, temper: ['anxious', 'shy'] }, say: S('I can\'t sleep since that… thing was in the city.') },
    { id: 'm20', when: { need: 'hunger' }, say: S('Starving, to be honest. I haven\'t eaten since this morning.', 'Hungry! I\'m on my way to get something to eat.') },
    { id: 'm21', when: { need: 'tired' }, say: S('Tired. So tired. It\'s been a long day.', 'I could sleep standing up.') },
    { id: 'm22', when: { need: 'lonely' }, say: S('Better now. I\'ve been on my own all day, it\'s nice to talk to someone.', 'Honestly? A bit lonely. Thanks for stopping.') },
    { id: 'm23', when: { need: 'hunger', temper: ['grumpy'] }, say: S('Hungry. And when I\'m hungry I\'m grumpy. Well, grumpier.') },
    { id: 'm24', when: { need: 'lonely', temper: ['chatty'] }, say: S('Oh, so much better now that someone\'s listening! Where do I start…') },
  ],
  job: [
    { id: 'js0', when: { title: ['busker'] }, say: S('I play for whoever stops. Some days that\'s nobody, some days it\'s a crowd.') },
    { id: 'js1', when: { title: ['living statue'] }, say: S('(Without moving:) I stand still. Six hours a day. You try it.') },
    { id: 'js2', when: { title: ['mime'] }, say: S('(The mime pulls an invisible rope, climbs an invisible ladder, and shrugs.)') },
    { id: 'js3', when: { title: ['juggler'] }, say: S('I juggle. Clubs, balls, once a chainsaw. Never again.') },
    { id: 'js4', when: { title: ['street dancer'] }, say: S('We dance. Here, the metro, wherever there\'s room and a beat.') },
    { id: 'js5', when: { title: ['chicken mascot'] }, say: S('I hand out flyers for the chicken place. In a chicken suit. Don\'t ask.') },
    { id: 'js6', when: { title: ['conspiracy theorist'] }, say: S('I tell people the truth. Somebody has to.') },
    { id: 'js7', when: { title: ['pigeon lady'] }, say: S('I feed the pigeons. Somebody has to. They have names, you know.') },
    { id: 'js8', when: { title: ['sleepwalker'] }, say: S('Zzz… accounts… the accounts are due…') },
    { id: 'js9', when: { title: ['lost tourist'] }, say: S('I\'m on holiday! Well, I was. Now I\'m mostly lost.') },
    { id: 'js10', when: { title: ['jogger'] }, say: S('Running. Ten kilometres. Every day. (pant)') },
    { id: 'js11', when: { title: ['doomsayer'] }, say: S('I warn the city. Nobody listens. That\'s how I know I\'m right.') },
    { id: 'js12', when: { title: ['police officer'] }, say: S('Patrol. Keeping the streets safe. You make that easier. Or harder, depending on the day.') },
    { id: 'js13', when: { title: ['paramedic'] }, say: S('Paramedic. I patch people up after… well, after days like this.') },
    { id: 'js14', when: { title: ['soldier'] }, say: S('Army. We\'re here because of the threat. Hopefully not for long.') },
    { id: 'js15', when: { title: ['shopkeeper'] }, say: S('This is my shop. Twenty years now. Through everything.') },
    { id: 'js16', when: { title: ['cleanup worker'] }, say: S('Cleanup crew. Every time something gets smashed, we sweep it up. You keep us busy.') },
    { id: 'js17', when: { title: ['firefighter'] }, say: S('Firefighter. When things burn, we put them out. Lately that\'s a lot of things.') },
    { id: 'j0', when: {}, say: S('I\'m {aTitle}. It pays the bills.', '{ATitle}. Have been for years.') },
    { id: 'j1', when: { job: ['pupil'] }, say: S('I go to school. Maths is boring, but break is good.', 'School. We\'re doing volcanoes!') },
    { id: 'j2', when: { job: ['student'] }, say: S('I study. Mostly I study how to pay the rent.', 'Student. Exams next week, so… panicking, mostly.') },
    { id: 'j3', when: { job: ['retired'] }, say: S('Retired! Forty years of work, and now I finally have time for {interest}.', 'Retired. I keep busier than when I worked, though.') },
    { id: 'j4', when: { job: ['home'], title: ['job seeker'] }, say: S('I\'m between jobs right now. Something will come up.') },
    { id: 'j4b', when: { job: ['home'], title: ['remote worker'] }, say: S('I work from home. Which means I mostly talk to the cat.') },
    { id: 'j4c', when: { job: ['home'], title: ['homemaker'] }, say: S('I keep the house running. Harder than any office job, believe me.') },
    { id: 'j4d', when: { job: ['home'], title: ['freelancer'] }, say: S('Freelancer. Feast or famine, every single month.') },
    { id: 'j5', when: { temper: ['proud'] }, say: S('I\'m {aTitle}, and a good one, if I may say so.') },
    { id: 'j6', when: { temper: ['grumpy'] }, say: S('{ATitle}. Don\'t get me started.') },
    { id: 'j7', when: { temper: ['cheerful'] }, say: S('I\'m {aTitle}! Love it, most days.') },
    { id: 'j8', when: { temper: ['dreamy'] }, say: S('I\'m {aTitle}, but really I\'d like to do something with {interest}.') },
    { id: 'j9', when: { job: ['office'] }, say: S('{ATitle}. Spreadsheets. Meetings about spreadsheets.') },
    { id: 'j10', when: { job: ['factory'] }, say: S('{ATitle} out in the industrial area. The robots do half the work now.') },
    { id: 'j11', when: { job: ['dock'] }, say: S('{ATitle} down at the port. Early starts, good people.') },
    { id: 'j12', when: { job: ['food'] }, say: S('{ATitle}. If you\'re ever hungry, you know where to find me.') },
    { id: 'j13', when: { job: ['civic'] }, say: S('{ATitle}. Busy days, with everything that goes on in {city}.') },
    { id: 'j14', when: { job: ['tech'] }, say: S('{ATitle}. Somebody has to keep the machines happy.') },
    { id: 'j15', when: { job: ['craft'] }, say: S('{ATitle}. If it\'s broken, I fix it. Which keeps me busy around you, ha.') },
    { id: 'j16', when: { job: ['craft'], giant: true }, say: S('{ATitle}. And people like you keep me in work, ha!') },
    { id: 'j17', when: { job: ['factory', 'office'], temper: ['grumpy', 'anxious'] }, say: S('{ATitle}. For now. They keep talking about robots taking over.') },
  ],
  hobby: [
    { id: 'i0', when: {}, say: S('In my free time? {Interest}, mostly.', 'And I\'m mad about {interest}.') },
    { id: 'i1', when: { temper: ['chatty', 'nosy'] }, say: S('But {interest} — that\'s my real passion. Don\'t get me started, I could talk for hours.') },
    { id: 'i2', when: { temper: ['shy'] }, say: S('I like {interest}. Quietly.') },
    { id: 'i3', when: { interest: ['conspiracy theories'] }, say: S('Have you noticed the drones fly in patterns? Think about it.', 'Ask yourself who really runs the robots. Go on. Ask.') },
    { id: 'i4', when: { interest: ['superheroes'] }, say: S('Superheroes, obviously. I collect the cards. Would you sign one?') },
    { id: 'i5', when: { interest: ['their dog'] }, say: S('Mostly I walk my dog. Best friend I have.') },
    { id: 'i6', when: { interest: ['their cat'] }, say: S('My cat runs my life, honestly. I just live there.') },
    { id: 'i7', when: { interest: ['their grandchildren'] }, say: S('My grandchildren! Do you want to see pictures? I have a few hundred.') },
    { id: 'i8', when: { interest: ['robots'] }, say: S('I build little robots at home. Nothing that could take over a street, promise.') },
    { id: 'i9', when: { interest: ['birdwatching'] }, say: S('Birds. You\'d be amazed what nests on the rooftops here. Mind them when you fly.') },
    { id: 'i10', when: { interest: ['astronomy'] }, say: S('Stargazing, when the city lights let me. Have you ever been up high enough to see properly?') },
    { id: 'i11', when: { interest: ['local history'] }, say: S('Local history. Every street in {city} has a story, you know.') },
    { id: 'i12', when: { child: true }, say: S('I like {interest}! And ice cream!') },
  ],
  news: [
    { id: 'ns0', when: { title: ['conspiracy theorist'] }, say: S('The drones aren\'t delivering parcels. They\'re delivering data. Wake up!') },
    { id: 'ns1', when: { title: ['lost tourist'] }, say: S('I was hoping you could tell me! Is this still the city centre?') },
    { id: 'ns2', when: { title: ['doomsayer'] }, say: S('Monsters! Fires! Slime in the sewers! It is all written. Well, I wrote it.') },
    { id: 'ns3', when: { title: ['police officer'] }, say: S('Between us? Keep an eye out around here. It\'s been a busy week.') },
    { id: 'ns4', when: { title: ['mime'] }, say: S('(The mime points left, then right, then mimes a monster stomping, and runs on the spot.)') },
    { id: 'ns5', when: { title: ['living statue'] }, say: S('(Still not moving:) A pigeon has been sitting on my head for an hour. That\'s the news.') },
    { id: 'ns6', when: { title: ['sleepwalker'] }, say: S('(Asleep:) …they\'re in the walls…') },
    { id: 'n0', when: {}, say: S('Quiet around here, mostly. That\'s how I like it.', 'Nothing much. The usual.', 'The {city} news says it\'ll be a quiet week. They always say that.') },
    { id: 'n1', when: { group: true }, say: S('{Group} run these streets. Keep your head down around their people.', 'You see the tags on the walls? {Group}. They think they own the place.') },
    { id: 'n2', when: { group: true, temper: ['grumpy'] }, say: S('{Group}, that\'s what. And the police do nothing.') },
    { id: 'n3', when: { group: true, temper: ['anxious', 'shy'] }, say: S('Don\'t say it too loud, but {group} are everywhere around here.') },
    { id: 'n4', when: { group: true, boss: true, temper: ['nosy', 'chatty'] }, say: S('They say {boss} calls the shots for {group}. Nobody\'s ever seen them twice in the same place.') },
    { id: 'n5', when: { group: true, boss: true, op: [30, 100] }, say: S('If you want to do something about {group}, it\'s {boss} you need. Everyone knows that name.') },
    { id: 'n6', when: { trouble: true }, say: S('Did you see the damage? Something tore up the street a while ago.', 'The noise earlier! I thought it was an earthquake.') },
    { id: 'n7', when: { threat: true }, say: S('There was something huge in the city. A monster! The sirens went on for ages.') },
    { id: 'n8', when: { storm: true }, say: S('They say the storm will go on all night.') },
    { id: 'n9', when: { temper: ['nosy'] }, say: S('Well, since you ask… the couple upstairs have been arguing again. Oh, you meant crime? Ha.') },
    { id: 'n10', when: { temper: ['chatty'] }, say: S('You know the café round the corner? They put in a robot barista. The coffee\'s terrible now.') },
    { id: 'n11', when: { temper: ['dreamy'] }, say: S('Have you ever looked at the city from the top of a tower? I\'d love to, just once.') },
    { id: 'n12', when: { interest: ['conspiracy theories'] }, say: S('The drones. Watch them. They\'re counting us.') },
    { id: 'n13', when: { senior: true }, say: S('In my day this was all little shops. Now it\'s robots carrying parcels.') },
    { id: 'n14', when: { child: true }, say: S('There\'s a cat that lives in the park! I named it Captain.', 'My friend says there are slime monsters in the sewers. That\'s not true, right?') },
    { id: 'n15', when: { group: true, child: true }, say: S('Mum says I\'m not allowed near the ones with the tags. {Group}.') },
    // The Wardens (game/aliens): what is in the sky or on the square right now.
    { id: 'nw0', when: { nannies: ['swarm'] }, say: S('Have you seen the sky? Hundreds of them. Nobody knows why, and they\'re not saying.', 'A festival, the news says. Or a meeting. Or a migration. They never explain anything.') },
    { id: 'nw1', when: { nannies: ['swarm'], temper: ['anxious', 'shy'] }, say: S('So many discs… Do you think something\'s coming? They only come in numbers like this when… well, I don\'t know when.') },
    { id: 'nw2', when: { nannies: ['walker'] }, say: S('There\'s one of their walkers on the square. Just standing. It\'s been looking at the bakery for twenty minutes.', 'See the tall one? Don\'t go near it. Not that it does anything. It just… looks.') },
    { id: 'nw3', when: { nannies: ['walker'], child: true }, say: S('There\'s a giant robot over there! Mum says it\'s a Warden and I mustn\'t poke it.') },
    { id: 'nw4', when: { nannies: ['disc'] }, say: S('One of the Nanny discs is hanging over us again. Scanning. For what, I\'d love to know.', 'Twenty years they\'ve watched us. Never lift a finger, never say a word. Just watch.') },
    { id: 'nw5', when: { nannies: ['disc'], temper: ['grumpy'] }, say: S('A city could burn down and they\'d just hover there. I\'ve seen it. Nannies, my foot.') },
    { id: 'nw6', when: { nannies: ['disc', 'walker'], interest: ['conspiracy theories'] }, say: S('They\'re not watching us. They\'re watching for something else. Mark my words.') },
    // City news (game/news): what people heard about, and how safe their neighbourhood is.
    { id: 'n20', when: { heard: true }, say: S('{Heard}', '{Heard} That\'s what people are saying, anyway.') },
    { id: 'n21', when: { heard: true, temper: ['nosy', 'chatty'] }, say: S('Oh, have I got news. {Heard} And that\'s not even the half of it!') },
    { id: 'n22', when: { heard: true, temper: ['anxious'] }, say: S('{Heard} It\'s getting worse out there, isn\'t it?') },
    { id: 'n23', when: { safety: ['safe', 'quiet'] }, say: S('{Hood} is a good place to live. There are police on every corner.', 'Here in {hood}? Nothing ever happens. The patrols see to that.') },
    { id: 'n24', when: { safety: ['mixed'] }, say: S('{Hood}? Not the worst, not the best. Watch your pockets after dark.') },
    { id: 'n25', when: { safety: ['rough', 'dangerous'] }, say: S('Here in {hood}, somebody gets robbed every other day, and the police hardly ever come.', 'You want news? {Hood} is going to the dogs. Nobody does anything.') },
    { id: 'n26', when: { safety: ['rough', 'dangerous'], op: [30, 100] }, say: S('{Hood} needs someone like you. The police have given up on us.') },
  ],
  way: [
    { id: 'w0', when: {}, say: S('{Place}? That\'s {dir} of here, about {dist}. There, I\'ve put it on your map.', '{Place}… go {dir}, it\'s about {dist}. I\'ll mark it for you.') },
    { id: 'w1', when: { temper: ['grumpy'] }, say: S('{Place}? {Dir}. About {dist}. Can\'t miss it.') },
    { id: 'w2', when: { temper: ['chatty', 'cheerful'] }, say: S('Oh, {place}! Go {dir}, about {dist} — lovely spot. There, it\'s on your map now.') },
    { id: 'w3', when: { far: true }, say: S('{Place}? That\'s a long way, {dist} {dir}. I\'ve marked it, but take the metro!') },
    { id: 'w4', when: { child: true }, say: S('That way! {Dir}! I\'ll show you on your map!') },
    { id: 'w5', when: { temper: ['shy', 'anxious'] }, say: S('I think… {dir}? About {dist}. I put it on your map, I hope that\'s right.') },
  ],
  favour: [
    { id: 'f0', when: { favour: ['none'] }, say: S('That\'s kind of you, but no, I\'m fine. Thanks for asking!', 'No, nothing. But thank you.') },
    { id: 'f1', when: { favour: ['none'], temper: ['grumpy'] }, say: S('You could stop wrecking the street. Otherwise, no.') },
    { id: 'f2', when: { favour: ['none'], temper: ['cheerful', 'kind'] }, say: S('Oh, you sweetheart! No, I\'m fine. Just keep doing what you do.') },
    { id: 'f3', when: { favour: ['none'], child: true }, say: S('Can you fly me to school? …No? Okay.') },
    { id: 'f4', when: { favour: ['none'], op: [-100, 0] }, say: S('From you? No thanks.') },
    { id: 'f10', when: { favour: ['visit'] }, say: S('Actually… could you look in on my {word} {who}? I haven\'t heard from them in days. I\'ve put them on your map.', 'Would you check on my {word}, {who}? They don\'t answer the phone. I\'ll mark where they usually are.') },
    { id: 'f11', when: { favour: ['visit'], temper: ['anxious'] }, say: S('Yes! Please — my {word} {who}. Nobody\'s heard from them since yesterday, I\'m worried sick. Could you find them? I\'ve marked them on your map.') },
    { id: 'f12', when: { favour: ['streets'], group: true }, say: S('There is something. {Group} have been leaning on everyone on {street}. If you could teach them a lesson around here…', 'Clear {group} off our street. Stop one of their jobs around here and they\'ll think twice.') },
    { id: 'f13', when: { favour: ['streets'] }, say: S('There\'s trouble on {street} lately. Robberies, muggings. If you could catch one of them around here…') },
    { id: 'f20', when: { favour: ['open'] }, say: S('You already said you\'d help, remember? I\'m still waiting.', 'Just what I asked before. No rush. Well, a bit of a rush.') },
    { id: 'f21', when: { favour: ['done'] }, say: S('You\'ve done more than enough already. Thank you!') },
    { id: 'f22', when: { favour: ['lost'] }, say: S('I asked you once. Forget it.') },
  ],
  me: [
    { id: 'o20', when: { told: 'helped', met: false }, say: S('My {bond} {teller} says you\'re one of the good ones. I believe them.') },
    { id: 'o21', when: { told: 'saved' }, say: S('You saved my {bond} {teller}. That\'s all I need to know.') },
    { id: 'o22', when: { told: 'hurt' }, say: S('My {bond} {teller} told me what you did to them. So, not much.') },
    { id: 'o23', when: { favour: ['done'], op: [0, 100] }, say: S('You kept your word. Not many people do.') },
    { id: 'os0', when: { title: ['mime'] }, say: S('(The mime points at you, puts a hand on its heart, and flexes.)') },
    { id: 'os1', when: { title: ['police officer'] }, say: S('You help, mostly. Just let us do the paperwork, alright?') },
    { id: 'os2', when: { title: ['sleepwalker'] }, say: S('(Mumbling:) …nice cape…') },
    { id: 'o0', when: { op: [-10, 25] }, say: S('Don\'t know you well enough yet. Ask me again in a while.', 'You seem alright. Time will tell.') },
    { id: 'o1', when: { op: [25, 60] }, say: S('I think you\'re alright. You help people. That counts.') },
    { id: 'o2', when: { op: [60, 100] }, say: S('Honestly? You\'re the best thing that\'s happened to this city.', 'People like you give me hope.') },
    { id: 'o3', when: { op: [-40, -10] }, say: S('You break a lot of things. Somebody has to pay for all that, you know.') },
    { id: 'o4', when: { op: [-100, -40] }, say: S('I think you\'re dangerous. People get hurt around you.', 'Honestly? I wish you\'d go and be a hero somewhere else.') },
    { id: 'o5', when: { deed: 'helped', op: [0, 100] }, say: S('You helped me when I was on the ground. I won\'t forget that.') },
    { id: 'o6', when: { deed: 'saved', op: [0, 100] }, say: S('You came for me when nobody else did. That\'s what I think of you.') },
    { id: 'o7', when: { deed: 'hurt' }, say: S('You knocked me over and didn\'t even look back.', 'Ask my bruises.') },
    { id: 'o8', when: { giant: true }, say: S('Hard to have an opinion of someone whose ankle I\'m talking to.') },
    { id: 'o9', when: { child: true, op: [0, 100] }, say: S('You\'re so cool! When I grow up I want to fly too!') },
    { id: 'o10', when: { temper: ['grumpy'], op: [25, 100] }, say: S('You\'re alright. Don\'t let it go to your head.') },
    { id: 'o11', when: { temper: ['shy'], op: [-10, 60] }, say: S('Oh! Um. You seem… nice?') },
    { id: 'o12', when: { trouble: true, op: [-100, 10] }, say: S('Look around you. That\'s what I think.') },
  ],
  bye: [
    { id: 'bs0', when: { title: ['mime'] }, say: S('(The mime waves goodbye with an invisible handkerchief.)') },
    { id: 'bs1', when: { title: ['living statue'] }, say: S('(The statue winks.)') },
    { id: 'bs2', when: { title: ['police officer'] }, say: S('Stay out of trouble.') },
    { id: 'bs3', when: { title: ['sleepwalker'] }, say: S('Zzz…') },
    { id: 'b0', when: {}, say: S('See you around.', 'Take care!', 'Bye!') },
    { id: 'b1', when: { temper: ['grumpy'] }, say: S('Finally.', 'Yeah, yeah.') },
    { id: 'b2', when: { temper: ['cheerful'] }, say: S('Bye! Go save the world!') },
    { id: 'b3', when: { temper: ['kind'] }, say: S('Look after yourself, dear.') },
    { id: 'b4', when: { op: [-100, -30] }, say: S('Good. Off you go.') },
    { id: 'b5', when: { child: true }, say: S('Bye! Fly safe!') },
    { id: 'b6', when: { temper: ['anxious'] }, say: S('Be careful out there.') },
    { id: 'b7', when: { night: true }, say: S('Good night!') },
    { id: 'b8', when: { temper: ['chatty'] }, say: S('Oh, already? Well — come by again, I\'m usually around here!') },
  ],
};

/** Small talk of passers-by (ui/Barks), by temperament; shy people say nothing. */
export const CHAT: Record<Temperament, readonly string[]> = {
  cheerful: ['Lovely day!', 'Morning!', 'Ha, look at that!', 'What a day.'],
  chatty: ['…and then I said to her…', 'Yeah, I\'ll call you back!', 'You won\'t believe what happened.', 'Did you see the news?'],
  shy: [],
  grumpy: ['Tsk.', 'Watch where you\'re going.', 'Typical.', 'Unbelievable.'],
  anxious: ['Did you hear that?', 'I should get home.', 'Is it going to rain?', 'Running late, running late…'],
  nosy: ['What\'s going on over there?', 'Who\'s that?', 'Ooh, look.'],
  proud: ['Excuse me.', 'Pardon.', 'If you don\'t mind.'],
  kind: ['After you!', 'Have a nice day!', 'Sorry, go ahead.'],
  dreamy: ['Hmm…', 'Look at those clouds.', 'Where was I going again?'],
  steady: ['Running late again…', 'Morning.', 'Right on time.', 'Excuse me.'],
};
