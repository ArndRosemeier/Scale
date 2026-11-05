/**
 * What the weather-moody baker says (speech bubbles and the talk panel), and what the street says
 * about him. `{first}` is his first name, `{bakery}` the shop, `{street}` his street.
 */

/** Why a bad day is a bad day (he tells you when you ask what is wrong). */
export const TROUBLES: string[] = [
  'The oven went out at four this morning. Forty loaves. All flat. Like little sad pancakes.',
  'My sourdough starter died. Gerald. He was eleven years old.',
  'Nobody came for the cinnamon buns yesterday. Not one person. I ate them all. Alone.',
  'It\'s my mother\'s birthday and I burned her cake. The one thing. The one thing!',
  'The critic from the paper called my rye bread "adequate". Adequate!',
  'A pigeon got into the shop and judged me. I could feel it judging me.',
  'I asked the woman from the flower shop to the cinema. She laughed. Nicely. But she laughed.',
  'My big croissant tower fell over in the window. Everybody saw. A child cried.',
  'The flour delivery is late again, and the rain… well. You can see the rain.',
  'I dreamed I was a baguette and nobody wanted me. I can\'t shake it.',
];

/** Why a good day is a good day. */
export const JOYS: string[] = [
  'The first batch came out perfect. Perfect! Listen to that crust.',
  'A little girl told me my pretzels are better than her grandma\'s. Don\'t tell her grandma.',
  'I got a letter from my sister. She\'s coming to visit next week!',
  'The new oven is in. She hums when she\'s hot. I named her Brunhilde.',
  'Somebody left a thank-you note under the door. Just "thank you for the bread". I nearly cried.',
  'I sold out of rolls before eight. Before eight!',
];

/** His own bubbles, by mood. */
export const BUBBLE = {
  heartbroken: ['*sniff*', 'Why does it always rain on me…', 'Fresh bread… if anybody wants it…', 'Oh, it\'s raining again. Of course it is.', 'Don\'t mind the cloud. It follows me.'],
  glum: ['Rolls, warm rolls…', 'Hmm. Grey again.', 'Bit of a drizzly day, isn\'t it. Sorry about that.', 'At least the bread is warm.'],
  fine: ['Good morning! Fresh bread!', 'Rolls, pretzels, a nice rye!', 'Not bad, not bad.', 'Mind the step!'],
  cheerful: ['What a day! Fresh bread for everyone!', 'Lovely weather, isn\'t it? You\'re welcome!', 'Try the poppy-seed roll!', 'Hello, hello!'],
  beaming: ['Sunshine! Sunshine for everybody!', 'Look at that sky! I did that!', 'Free crumbs for the pigeons today!', 'I could hug the whole street!'],
  furious: ['Look what you did to my sky!', 'Out! Out of my street!', 'Now look. Now it\'s thundering.', 'I am VERY upset!'],
  closed: ['Closed! Back at half past six!', 'Early start tomorrow. Good night!'],
};

/** Ordinary people on his street when the cloud is out or the sun breaks through. */
export const STREET = {
  gloom: ['Oh no, {first}\'s sad again.', 'Somebody cheer up {first}, I left my umbrella at home.', 'Rain on {street} again. Poor {first}.', 'It\'s only raining on this street. It\'s {first}.'],
  sun: ['The sun\'s out on {street}! {first} must be happy.', 'Look at that, {first}\'s in a good mood.', 'Lovely. {first} must have sold out early.'],
  storm: ['Thunder?! Who upset {first}?', 'Whoever made {first} cross, say sorry!'],
};

/** Gossip elsewhere in town, so the hero hears of him. */
export const GOSSIP = [
  'Have you met {first} from {bakery} on {street}? When he\'s sad it rains on his street. Only his street.',
  'There\'s a baker on {street} who found one of those crystals. Now his mood is the weather. Bring an umbrella.',
  'If it\'s raining on {street}, somebody should go and cheer up {first}. Works every time.',
  '{bakery} on {street}. Best rolls in the city, if you catch {first} on a sunny day.',
];

/** The talk panel: what he says when you come to him, by mood. */
export const HELLO = {
  sad: ['Oh. Hello. Sorry about the cloud. It\'s… it\'s been a day.', 'Hello… mind the drips. It\'s my own little cloud. Don\'t ask.'],
  fine: ['Hello! Welcome to {bakery}! Something warm?', 'Morning! Or afternoon. It\'s always morning in a bakery.'],
  happy: ['Hello, hello! Isn\'t it a glorious day? I made it myself!', 'Welcome to {bakery}! The sun\'s out, the bread\'s out, life is good!'],
  angry: ['You! You have a nerve, coming back here.', 'Oh, it\'s you. The thunder is about you, you know.'],
};

/** The crystal story (asked how it started). */
export const CRYSTAL = [
  'I found a glowing stone in the flour sack in March. Thought it was a sugar crystal. Bit into it. Next morning I was sad about the burnt rolls, and it rained. Indoors. Over the counter.',
  'Since then the sky over {street} does what my heart does. The neighbours are very understanding. Mostly. They bought umbrellas.',
];

/** Answers to the hero's ways of cheering him up: [worked, didn't]. */
export const CHEER = {
  bread: ['You think so? It\'s the butter. Real butter. Oh, that\'s kind of you.', 'Everybody says that.'],
  joke: [
    'Ha! Haha! Oh, that\'s terrible. That\'s wonderful. Ha!',
    'Why did the… no, I don\'t get it. But thank you for trying.',
  ],
  buy: ['A loaf for the hero! Still warm. No, no, put your money away. Oh, all right. Thank you!', 'Here you are. Thank you.'],
  hug: ['Oh! Oh. A superhero hug. Oh, that\'s… *sniff* …that\'s really nice.', 'Mind the flour… oh, too late.'],
  pep: ['You\'re right. You\'re right! One bad batch doesn\'t make a bad baker!', 'I suppose. Maybe. We\'ll see.'],
  sky: ['Ha! Yes! Look at it! Isn\'t it beautiful?', 'Sunny days are the best days.'],
};

/** Hero jokes (the hero tells one; he laughs, or does not). */
export const JOKES = [
  'Why did the baker go to therapy? He kneaded it.',
  'What do you call a sad loaf? Pumpernickel… blue?',
  'I used to be a baker, but I couldn\'t make enough dough.',
  'Why do croissants never win arguments? They always fold.',
];

/** After the hero cheered him up for the first time today. */
export const THANKS = 'You did it, you know. Look up. That\'s your sun. Thank you.';

/** Fill in the names. */
export function fill(s: string, v: { first: string; bakery: string; street: string }): string {
  return s.replace(/\{first\}/g, v.first).replace(/\{bakery\}/g, v.bakery).replace(/\{street\}/g, v.street);
}
