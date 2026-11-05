/**
 * What the magnetic grandma says (speech bubbles, ui/Barks), and what people say about her.
 * `{thing}` is the piece that just flew to her ("a teaspoon"), `{name}` her own name.
 */
export type GrandmaTopic = 'own' | 'stick' | 'bike' | 'full' | 'shake' | 'giveBack' | 'greet' | 'fly' | 'giant' | 'tiny' | 'hero' | 'villain' | 'wanted' | 'panic' | 'hit' | 'home' | 'shop';

const LINES: Record<GrandmaTopic, readonly string[]> = {
  own: [
    'Lovely day for the shops.', 'Now, was it eggs or flour? Both, I think.', 'I only came out for milk, you know.',
    'My knees aren\'t what they were, but my pull is.', 'Morning, Mrs. Kowalski! Mind your earrings!',
    'Don\'t stand too close, dear, you\'ll lose your zip.', 'They wrote about me in the paper again. Page six!',
    'Fifty years in this street and now everything follows me home.', 'I used to collect stamps. Now things collect me.',
    'The doctor says it\'s harmless. He keeps his distance, mind.', 'Off to the baker, then the chemist.',
    'I can\'t go near the fridge magnets aisle any more.', 'Hello, pigeons. No, you\'re not metal. Lucky you.',
  ],
  stick: [
    'Ooh! {thing}! Thank you, dear.', 'Oh, not again. {thing}.', 'Well, hello, {thing}.', 'Look at that: {thing}. I\'ll need a bigger handbag.',
    'There goes {thing}. Sorry! Sorry!', '{thing}! I\'ll have a whole kitchen by lunchtime.', 'Oh! That tickles. {thing}, is it?',
    'Is this {thing}? Somebody will miss that.', 'Clink! Ha, I felt that one.', 'Every time I pass this café…',
  ],
  bike: [
    'Oh dear. A whole bicycle this time.', 'Whose bicycle is this? Hello? Anyone?', 'I haven\'t ridden one since 1974, and I\'m not starting now.',
    'That\'s Mr. Peters\' bike again. He\'ll be ever so cross.', 'Well, it\'s good exercise, carrying a bicycle.',
  ],
  full: ['I think that\'s quite enough for one morning.', 'Right. Time for a little shake.', 'I\'m starting to clank when I walk.', 'Heavy today. Let\'s lighten the load.'],
  shake: ['Off you go, then!', 'Shoo! Shoo, the lot of you!', 'There we are. Light as a feather.', 'Sorry about the noise, everyone!', 'Mind your feet!'],
  giveBack: ['These yours, love? Here you are.', 'I think you dropped these. Well, I took them. Sorry!', 'Here, dear, before you miss them.', 'Your keys, young man. Don\'t mention it.'],
  greet: ['Hello, dear! Don\'t mind the cutlery.', 'Well, aren\'t you a nice young person.', 'Hello! Careful, I\'m a bit clingy today.', 'Oh, hello! Have you got a belt buckle? Hold on to it.'],
  fly: ['Goodness! Do they let you do that?', 'Flying! In my day we took the bus.', 'Come down before you catch a cold up there!'],
  giant: ['My, you\'re a big one. Do you need a spoon?', 'Mind where you step, dear, I\'m only small.', 'Oh my. And I thought I was a sight.'],
  tiny: ['Oh, look at you! Like my little brooch.', 'Careful, dear, you\'re the size of a thimble. Are you metal?'],
  hero: ['You\'re the one from the news! I\'m in the news too, you know.', 'Oh, our hero! Would you like a fork? I have plenty.', 'Thank you for keeping us safe, dear.'],
  villain: ['I know who you are. Shame on you.', 'You keep away, or I\'ll fling a frying pan at you.', 'I don\'t want your sort near my shopping.'],
  wanted: ['The police are looking for you, dear. Do the right thing.', 'You\'re in trouble, aren\'t you? Hand yourself in.'],
  panic: ['Oh my word!', 'Not at my age!', 'Help! Somebody help!', 'My shopping!'],
  hit: ['Ow! I\'m eighty-one!', 'Well! I never!', 'Is that how they raise them now?'],
  home: ['Time for a cup of tea and a sit down.', 'Home now. My feet are killing me.', 'That\'s me done for today.'],
  shop: ['Ooh, they\'ve got the good biscuits in.', 'Just having a look, thank you!', 'Do you have it in a non-magnetic tin?', 'Morning! Same as always, please.'],
};

/** A line on a topic, with its gaps filled in; null if there is none. */
export function grandmaLine(topic: GrandmaTopic, rnd: () => number, thing = 'something', name = 'Grandma'): string | null {
  const pool = LINES[topic];
  if (!pool?.length) return null;
  const line = pool[Math.floor(rnd() * pool.length)];
  const t = line.startsWith('{thing}') ? thing.charAt(0).toUpperCase() + thing.slice(1) : thing;
  return line.replace('{thing}', t).replace('{name}', name);
}

/** What passers-by say when something flies to her. */
export const WATCHER_LINES: readonly string[] = [
  'Did you see that?', 'There she goes again!', 'That\'s the magnetic grandma!', 'Quick, get a photo!',
  'Hey! That was my spoon!', 'She\'s in the paper every week.', 'My nan\'s the same with gossip.', 'Mind your keys!',
];
