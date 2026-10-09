/**
 * What someone likes and what they think of things (typed NPC chat): a stable answer for every
 * person to "do you like jazz?", "what's your favourite food?" or "what do you think of the
 * police?", made from their seed and personality like everything else about them. Nothing is
 * stored. Anything one can name has a liking, even things nobody listed ("do you like
 * bananas?"): the name's hash and the person's seed decide.
 *
 * Pure.
 */
import { hashCombine, hashString, hashToFloat } from '../../../core/rng';
import type { Traits } from '../identity';

export type Category = 'food' | 'drink' | 'music' | 'sport' | 'film' | 'colour' | 'season' | 'animal' | 'weather' | 'pastime' | 'place';

/** Things by category (normalised names; the first word form is how they say it). */
export const THINGS: Record<Category, readonly string[]> = {
  food: ['pizza', 'pasta', 'sushi', 'curry', 'burgers', 'salad', 'soup', 'noodles', 'tacos', 'fish and chips', 'dumplings', 'steak', 'kebab', 'pancakes', 'chocolate', 'ice cream', 'cake', 'cheese', 'vegetables', 'spicy food', 'fruit', 'sandwiches', 'hot dogs', 'chips', 'bread', 'eggs'],
  drink: ['coffee', 'tea', 'beer', 'wine', 'juice', 'lemonade', 'hot chocolate', 'cocktails', 'milk', 'water', 'cola', 'whisky', 'smoothies'],
  music: ['jazz', 'rock', 'pop', 'classical music', 'hip hop', 'techno', 'folk', 'opera', 'punk', 'metal', 'country music', 'reggae', 'blues', 'soul', 'disco', 'rap', 'electronic music', 'musicals'],
  sport: ['football', 'basketball', 'tennis', 'swimming', 'cycling', 'running', 'boxing', 'chess', 'golf', 'skiing', 'rugby', 'cricket', 'volleyball', 'yoga', 'hockey', 'baseball', 'climbing', 'skateboarding'],
  film: ['comedies', 'horror films', 'action films', 'romance films', 'documentaries', 'cartoons', 'science fiction', 'westerns', 'old films', 'detective stories', 'superhero films', 'fantasy'],
  colour: ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'black', 'white', 'pink', 'grey', 'brown', 'gold', 'silver'],
  season: ['spring', 'summer', 'autumn', 'winter'],
  animal: ['dogs', 'cats', 'birds', 'pigeons', 'horses', 'rats', 'fish', 'snakes', 'spiders', 'rabbits', 'foxes', 'ducks', 'squirrels', 'hamsters', 'owls'],
  weather: ['rain', 'sunshine', 'snow', 'storms', 'fog', 'wind', 'heat', 'the cold'],
  pastime: ['reading', 'dancing', 'singing', 'cooking', 'gardening', 'video games', 'shopping', 'travelling', 'painting', 'television', 'board games', 'crosswords', 'knitting', 'fishing', 'photography', 'walking', 'parties', 'sleeping', 'puzzles', 'karaoke', 'flying', 'museums', 'art', 'poetry', 'maths', 'homework', 'school', 'work', 'politics', 'crowds', 'mondays', 'heights', 'the night', 'mornings', 'nature', 'the beach', 'the countryside', 'money', 'computers', 'robots', 'superheroes', 'conspiracy theories', 'astronomy', 'model trains', 'birdwatching', 'local history', 'the stock market'],
  place: ['the city', 'this city', 'it here', 'this street', 'this neighbourhood', 'the park', 'the river', 'the harbour', 'the sea', 'the mountains', 'the metro', 'the sewers'],
};

/** Words for a category in a question ("favourite food", "what music"). */
export const CATEGORY_WORDS: Record<Category, readonly string[]> = {
  food: ['food', 'dish', 'meal', 'eat', 'snack', 'dessert', 'cuisine'], drink: ['drink', 'beverage'],
  music: ['music', 'song', 'band', 'singer', 'kind of music', 'genre'], sport: ['sport', 'sports', 'game', 'team'],
  film: ['film', 'films', 'movie', 'movies', 'show', 'series', 'book', 'books'], colour: ['colour', 'colours'], season: ['season', 'time of year', 'month'],
  animal: ['animal', 'animals', 'pet', 'pets'], weather: ['weather'], pastime: ['hobby', 'pastime', 'thing to do', 'activity'], place: ['place', 'spot', 'part of town'],
};

/** Things that lean one way by who you are (age, traits): +1 likes, −1 dislikes. */
const LEAN: Record<string, (t: Traits, years: number) => number> = {
  'ice cream': (_, y) => (y < 14 ? 1 : 0.3), cartoons: (_, y) => (y < 13 ? 1 : y > 60 ? -0.4 : 0), 'video games': (_, y) => (y < 25 ? 0.8 : y > 60 ? -0.6 : 0),
  vegetables: (_, y) => (y < 13 ? -0.9 : 0.2), homework: (_, y) => (y < 19 ? -1 : -0.3), school: (_, y) => (y < 19 ? -0.5 : 0), tea: (_, y) => (y > 55 ? 0.7 : 0),
  'classical music': (t, y) => (y > 55 ? 0.6 : 0) + t.o * 0.4 - 0.2, techno: (_, y) => (y < 30 ? 0.4 : y > 55 ? -0.8 : -0.2), opera: (t) => t.o - 0.6, jazz: (t) => t.o * 0.6 - 0.2,
  'horror films': (t) => -t.n + 0.3, storms: (t) => -t.n + 0.2, heights: (t) => -t.n + 0.2, crowds: (t) => t.e - t.n, parties: (t) => t.e * 1.2 - 0.5,
  spiders: () => -0.6, rats: () => -0.6, snakes: () => -0.5, pigeons: () => -0.1, mondays: () => -0.8, money: () => 0.4, sleeping: () => 0.5, work: (t) => t.c - 0.6,
  coffee: (_, y) => (y < 14 ? -0.6 : 0.3), beer: (_, y) => (y < 18 ? -1 : 0), wine: (_, y) => (y < 18 ? -1 : 0), whisky: (_, y) => (y < 18 ? -1 : -0.2), cocktails: (_, y) => (y < 18 ? -1 : 0),
  sushi: (t) => t.o * 0.6 - 0.2, 'spicy food': (t) => t.o * 0.6 - 0.2, travelling: (t) => t.o * 0.8 - 0.2, art: (t) => t.o * 0.8 - 0.3, museums: (t) => t.o * 0.8 - 0.3, poetry: (t) => t.o - 0.7,
  'the night': (t) => t.e * 0.4 - t.n * 0.4, mornings: (t) => t.c * 0.8 - 0.4, politics: (t) => t.o * 0.4 - 0.5, maths: (t) => t.c * 0.8 - 0.5, chocolate: () => 0.6, cake: () => 0.5, pizza: () => 0.5,
  'this city': () => 0.2, 'it here': () => 0.2, 'the city': () => 0.2, sunshine: () => 0.5, 'the beach': () => 0.4, dogs: (t) => t.a * 0.4, cats: () => 0.1, robots: (t) => t.o * 0.5 - 0.2,
};

function u(seed: number, salt: string): number {
  return hashToFloat(hashCombine(seed, hashString(salt)));
}

/** −1 hates … 1 loves. Their interest is loved; the rest is the seed and who they are. */
export function liking(seed: number, t: Traits, years: number, interest: string, thing: string): number {
  const k = thing.toLowerCase().replace(/^(the|a|an) /, '');
  if (k === interest.replace(/^their /, '') || interest.endsWith(k)) return 1;
  const base = u(seed, `like:${k}`) * 2 - 1;
  const lean = LEAN[k]?.(t, years) ?? 0;
  // Agreeable, cheerful people like more things; grumpy ones fewer.
  const mood = (t.a - 0.5) * 0.3 + (t.e - 0.5) * 0.2;
  return Math.max(-1, Math.min(1, base * 0.75 + lean * 0.6 + mood));
}

/** Their favourite of a category (the thing they like most there). */
export function favourite(seed: number, t: Traits, years: number, interest: string, cat: Category): string {
  let best = THINGS[cat][0], bv = -Infinity;
  for (const th of THINGS[cat]) {
    if (cat === 'place' && (th === 'it here' || th === 'this city' || th === 'this street')) continue;
    const v = liking(seed, t, years, interest, th) + u(seed, `fav:${th}`) * 0.3;
    if (v > bv) { bv = v; best = th; }
  }
  return best;
}

/** The category of a known thing, or null. */
export function categoryOf(thing: string): Category | null {
  for (const c in THINGS) if ((THINGS[c as Category]).includes(thing)) return c as Category;
  return null;
}

/** Where they stand on a side of the city (−1 … 1), by personality and what the street is like. */
export interface StanceInput { traits: Traits; years: number; opinion: number; rough: boolean; groupHere: boolean; job: string; interest: string; seed: number }

export function stance(faction: string, s: StanceInput): number {
  const t = s.traits, r = u(s.seed, `stance:${faction}`) * 0.6 - 0.3;
  let v: number;
  switch (faction) {
    case 'police': v = 0.2 + (t.c - 0.5) * 0.8 + (s.years > 55 ? 0.2 : 0) - (s.rough ? 0.3 : 0) - (s.years < 25 ? 0.15 : 0); break;
    case 'army': v = (t.c - 0.5) * 0.6 - (t.o - 0.5) * 0.5 - 0.05; break;
    case 'wardens': v = (t.o - 0.5) * 1.0 - (t.n - 0.5) * 0.8 - 0.1; break;
    case 'heroes': v = s.opinion / 100 * 0.7 + (s.interest === 'superheroes' ? 0.6 : 0) + 0.1; break;
    case 'gangs': v = -0.7 - (s.groupHere ? 0.2 : 0) + (t.a < 0.25 ? 0.4 : 0); break;
    case 'mayor': v = -0.2 + (t.a - 0.5) * 0.5 - (s.rough ? 0.3 : 0); break;
    case 'monsters': v = -0.8 + (t.o > 0.8 ? 0.5 : 0); break;
    case 'robots': v = (s.job === 'tech' ? 0.4 : 0) + (t.o - 0.5) * 0.6 - (t.n - 0.5) * 0.4; break;
    case 'slimes': v = -0.4 + (t.o - 0.5) * 0.8; break;
    case 'paramedics': case 'firefighters': v = 0.7; break;
    default: v = 0;
  }
  return Math.max(-1, Math.min(1, v + r));
}
