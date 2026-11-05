/**
 * What the shrunk florist says (speech bubbles, ui/Barks), and what people say about her.
 * `{name}` and `{shop}` are filled in by the caller.
 */
export type FloristTopic =
  | 'own' | 'greet' | 'stepped' | 'stepped2' | 'giant' | 'tiny' | 'fly' | 'hero' | 'villain' | 'wanted'
  | 'mount' | 'garden' | 'back' | 'rain' | 'scared' | 'evening' | 'morning' | 'fan';

const LINES: Record<FloristTopic, readonly string[]> = {
  own: [
    'Fresh tulips! Well, fresh to me.', 'Watering this one takes me a whole morning.',
    'Mind the daisies, they\'re taller than I am.', 'A rose? Lovely. I\'ll need a ladder.',
    'Captain, no pecking the merchandise!', 'Bees are terrifying at this size, you know.',
    'I used to be five foot six. I miss top shelves.', 'Some days a single petal is my umbrella.',
    'The crystal was so pretty. Should have left it in the gutter.', 'Free advice: never pick up a glowing rock.',
    'Every customer is a giant. I\'ve made my peace with it.', 'Who needs a van when you have a pigeon?',
  ],
  greet: ['Hello down here!', 'Hi! Down here! By the tulips!', 'Oh, hello! Looking for flowers?', 'Welcome to {shop}!'],
  stepped: ['Eek! Watch your feet!', 'Careful! Florist underfoot!', 'Whoa! Small person here!', 'Mind your step, please!'],
  stepped2: ['That\'s the third time today!', 'Do you need glasses, dear?', 'I will set Captain on you!', 'Look DOWN, honestly!'],
  giant: ['Oh my. And I thought everyone was big.', 'Captain! Up, up, up!', 'Please, please look where you step!'],
  tiny: ['Oh! Someone my size! Hello!', 'Finally, eye to eye! Isn\'t it awful?', 'Did you touch a crystal too?', 'Welcome to the small world!'],
  fly: ['Show-off. Captain flies too, you know.', 'Ooh, can you carry deliveries?', 'Mind the pigeons up there!'],
  hero: ['You\'re that hero! A daisy for you?', 'Saving the city? Take a flower!', 'I\'d hug you, but, well. Knees.'],
  villain: ['Oh dear. Please don\'t trample the stand.', 'I\'m only a florist. Tiny one.', 'Captain, look busy.'],
  wanted: ['The police were asking about you. I\'m too small to notice things.', 'I didn\'t see you. I never see anyone above the knees.'],
  mount: ['Off to the gardens, Captain!', 'Deliveries! Hold still, Captain.', 'Up we go!', 'Hold the flowers, I\'ll hold on!'],
  garden: ['Ah, my roof garden.', 'These need water. Again.', 'Look at you, growing taller than me.', 'Hello, my lovelies.'],
  back: ['Home again!', 'Good boy, Captain.', 'And we\'re back. Who needs flowers?', 'Landing!'],
  rain: ['Rain! Good for the flowers, bad for me.', 'One raindrop is a bucket at my size.', 'No flying today, Captain. Too wet.'],
  scared: ['Captain, fly!', 'Not again!', 'Eek! Up, up!', 'Everybody mind the florist!'],
  evening: ['Long day. Lovely day.', 'Time to count my petals.', 'Last bunch of the day!'],
  morning: ['Good morning, city!', 'Open! Open! Flowers!', 'Morning, Captain. Breakfast later.'],
  fan: ['Smile for the paper? Again?', 'Yes, I\'m her. Yes, really.', 'Photos are free, flowers are not!', 'No flash, please, Captain hates it.'],
};

/** A line on a topic (null: none). */
export function floristLine(topic: FloristTopic, rand: () => number, name: string, shop: string): string | null {
  const L = LINES[topic];
  if (!L?.length) return null;
  return L[Math.floor(rand() * L.length) % L.length].replace('{name}', name).replace('{shop}', shop);
}

/** What passers-by say about her (watching her, filming her). */
export const ABOUT_HER: readonly string[] = [
  'Is that her? The tiny florist?', 'She\'s so small!', 'My mum buys all her roses from her.',
  'Careful, the florist!', 'She was in the paper again.', 'Look, the pigeon lady! The tiny one!',
  'Watch your step, the florist!', 'Get a picture, quick!',
];
