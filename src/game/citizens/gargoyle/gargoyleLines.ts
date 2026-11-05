/**
 * What the retired cathedral gargoyle says (pure). Six hundred years a waterspout on the cathedral,
 * pensioned off when they put in a drainpipe; it still squats on its ledge by day like the statue
 * it is supposed to be, and comes down at night: gossips with the pigeons, chats with whoever stops
 * by, and gives night tours of the neighbourhood. Friendly, a little vain, a terrible gossip.
 *
 * `{name}`: its name, `{church}`: the cathedral's, `{place}`: a stop's, `{street}`: a street near.
 */

export type GargoyleTopic =
  | 'wake' | 'dawn' | 'whisper' | 'greet' | 'again' | 'gossip' | 'pigeons' | 'coo' | 'tourInfo' | 'announce'
  | 'tourStart' | 'walk' | 'tourEnd' | 'danger' | 'calm' | 'fly' | 'giant' | 'rain' | 'hero' | 'villain' | 'nobody'
  | 'busy' | 'church';

const LINES: Record<GargoyleTopic, string[]> = {
  wake: [
    'Ahh. Six hundred years and my back still cracks.',
    'Is it night? Finally. My face was going numb.',
    'Day shift over. Now for the fun one.',
    '*stretches* Ooh. Ooh, that\'s the stuff.',
  ],
  dawn: [
    'Sun\'s coming. Back to the office.',
    'Goodnight! Or good morning. Whichever.',
    'Time to be a statue again. Not a word, anyone.',
  ],
  whisper: [
    'Psst. Day shift. I\'m a statue.',
    'Don\'t look at me, people are watching!',
    'Come back after dark. I\'ll be down on the square.',
    'Lovely weather for standing perfectly still.',
    '*the stone eye winks*',
  ],
  greet: [
    'Good evening! {name}, retired gargoyle. Six hundred years on {church}. I was a waterspout, you know. A very good one.',
    'Oh, hello! {name}. I used to spit rainwater on tourists for a living. Then they put in a drainpipe. A DRAINPIPE.',
  ],
  again: [
    'Ah, you again! Good evening!',
    'There you are! The pigeons said you\'d be by.',
    'Evening! Pull up a step.',
  ],
  gossip: [
    'The pigeons say the hot dog man on {street} gives extra onions after midnight. If you ask nicely.',
    'Did you know the man on the third floor over there sings to his cactus? Every night. Badly. Lovely cactus, though.',
    'There\'s a very big friend of mine who sleeps at the stadium. Waves at me every morning. I can\'t wave back. Day shift.',
    'Somebody keeps feeding the pigeons croissants. They\'re getting ideas above their station.',
    'The bell ringer\'s been seeing the organist. Don\'t tell anyone. Tell everyone.',
    'A bloke on {street} parked on a pavement for three days. The pigeons have opinions.',
    'The crows are plotting something on the gasworks. They\'re always plotting something on the gasworks.',
    'Two of the tour guides from the day shift are not speaking. Over a hat. I know which hat.',
  ],
  pigeons: [
    'No! The baker? Again?',
    'And then what did the mayor say?',
    'Don\'t spread that around. ...Spread it around.',
    'On the roof? In THAT weather?',
    'You saw WHAT on the fourth floor?',
    'Coo yourself.',
    'I knew it. I KNEW it.',
    'Mm-hm. Mm-hm. Go on.',
  ],
  coo: ['Coo.', 'Coo coo!', 'Croo-oo.', '*ruffles feathers*', 'Coo?', 'Coo...'],
  tourInfo: [
    'Night tours at ten, midnight and two, from the steps of {church}. Free! Tips go to the pigeon fund.',
    'Come on the night tour! Ten, midnight and two. I know every gutter in this part of town.',
  ],
  announce: [
    'Night tour in a few minutes! Gather round!',
    'Tour! Night tour! Meet at the steps!',
  ],
  tourStart: [
    'Welcome, welcome! Stay close, mind the traffic, and no flash photography. I\'m shy.',
    'Right, everyone! Follow the wings. Keep up, the night is short.',
  ],
  church: [
    'This is {church}. I\'ve lived on it for six hundred years. Third buttress from the front, best view in town.',
    'The inside? Lovely, I hear. I\'ve only ever seen it from the outside.',
    'They pensioned me off when they put in a drainpipe. I\'m not bitter. I\'m limestone.',
  ],
  walk: [
    'This way! Keep up!',
    'Mind the puddle. Trust me, I know puddles.',
    'Left here. No, my left.',
    'Nearly there! Gargoyle\'s honour.',
  ],
  tourEnd: [
    'And that\'s the tour! Tips go to the pigeon fund.',
    'That\'s all, folks! Same time tomorrow. I\'ll be the grey one.',
  ],
  danger: ['Statue! I\'m a statue!', 'Nope. Back to work.', 'Not my business. Not my business!'],
  calm: ['Is it over? It\'s over. Phew.', 'Right. Where was I?'],
  fly: ['Show-off. I can glide, you know. Downhill.', 'Mind the spire up there!'],
  giant: ['My, you\'ve grown! Mind the roof, it\'s listed.', 'Oh, a big one! Don\'t sit on my cathedral.'],
  rain: ['Ah, rain. Takes me back. I used to BE in this business.', 'Listen to that drainpipe. Amateur.'],
  hero: ['The pigeons like you. Well, they like your crumbs.', 'Everyone\'s talking about you! Good things. Mostly.'],
  villain: ['The pigeons say you\'ve been naughty. I won\'t judge. I\'m made of judgement, but I won\'t.'],
  nobody: ['Nobody tonight? More gutters for me.', 'Just you? Lovely. A private tour!'],
  busy: ['Shh, I\'m giving a tour! Walk with us.', 'Tour in progress! Keep up!'],
};

/** Lines a stop on the tour gets, by landmark kind (`{place}`: its name). */
const STOPS: Record<string, string[]> = {
  townhall: ['{place}. Where they voted me "surplus to requirements". Nine to three. I counted.', 'The mayor works up there. Lovely man. Terrible at hats.'],
  museum: ['{place}. They wanted me in there once. Behind glass! The cheek.', 'Half the stone in that museum is younger than my left foot.'],
  monument: ['{place}. Very proud of itself. Never had a real job.', 'Pigeons love this one. Don\'t touch the base.'],
  tower: ['{place}. Tall, isn\'t it? Bit flashy for my taste.', 'From the top you can see my cathedral. And me. Waving.'],
  wheel: ['{place}. Goes round and round. Like gossip.', 'I rode it once. The man at the gate fainted.'],
  stadium: ['{place}. A very big friend of mine sleeps in there. Shh.', 'Concerts on Saturdays. I hum along from the roof.'],
  lighthouse: ['{place}. Another one with a day job. Well, a night job.', 'The keeper and I compare notes on seagulls.'],
  fortress: ['{place}. Older than me! Barely. It doesn\'t let you forget it.', 'Walls like that make a gargoyle feel at home.'],
  glasshouse: ['{place}. Full of plants that have never seen a winter. Soft.', 'Lovely and warm in there. Bad for my moss, though.'],
  cemetery: ['{place}. Very quiet neighbours. Mostly.', 'If anybody waves back in there, keep walking.'],
  station: ['{place}. Trains under our feet all night. Like an upset stomach.', 'The rats down there run a better timetable than the trains.'],
  street: ['{place}. Nice street. I spat on it for centuries.', 'Look up! Every cornice here has a story. Most of them are rude.'],
};

/** A line for a topic (null: none). */
export function gargoyleLine(topic: GargoyleTopic, u: number, f: { name: string; church: string; street?: string }): string | null {
  const pool = LINES[topic];
  if (!pool?.length) return null;
  return fill(pool[Math.floor(u * pool.length) % pool.length], f);
}

/** The lines told at a stop of the tour (all of them, in order). */
export function stopLines(kind: string, place: string, f: { name: string; church: string }): string[] {
  return (STOPS[kind] ?? STOPS.street).map((l) => fill(l, { ...f, place }));
}

/** The tour's lines at the cathedral (its first stop). */
export function churchLines(f: { name: string; church: string }): string[] {
  return LINES.church.map((l) => fill(l, f));
}

/** The pigeons' rumour, passed on (`heard`: what people say, as GameMaster.rumourText has it). */
export function rumourLine(heard: string): string {
  return `The pigeons heard something: ${heard}`;
}

function fill(s: string, f: { name: string; church: string; street?: string; place?: string }): string {
  return s.replace(/\{name\}/g, f.name).replace(/\{church\}/g, f.church).replace(/\{street\}/g, f.street ?? 'the corner').replace(/\{place\}/g, f.place ?? 'Here');
}

/** Its name (seeded per city). */
export const GARGOYLE_NAMES = ['Bartholomew', 'Old Grizzle', 'Mortimer', 'Gutterby', 'Basil', 'Ignatius', 'Sir Drippington', 'Agnes'];
