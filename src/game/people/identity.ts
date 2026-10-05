/**
 * Who a citizen is (NPC_PERSONALITY_PLAN §3.1): name, personality, temperament, job, the thing
 * they love to talk about and today's mood. All of it comes from the citizen's seed (and the
 * district of their workplace), so a person is the same every time you meet them and nothing is
 * stored for the people you never talk to.
 *
 * Personality is the Big Five (OCEAN, 0..1). Neuroticism is the citizen's `nerve` and openness
 * their `curiosity`, which reactions already use (fleeing, gawking, filming), so behaviour that
 * exists keeps reading the same people the same way.
 *
 * Pure: no DOM, no three.js.
 */
import { Rng, deriveSeed } from '../../core/rng';
import { Role, type Citizen } from '../../sim/Population';
import type { District } from '../../plan/types';

// ------------------------------------------------------------------ names

/** First names by birth cohort (old: 66+, mid: 36–65, young: 19–35, kid) and gender (f, m). */
const FIRST = {
  old: {
    f: ['Margaret', 'Edith', 'Ingrid', 'Rosa', 'Dorothy', 'Gloria', 'Helga', 'Maria', 'Agnes', 'Ruth', 'Yoko', 'Fatima', 'Irene', 'Beatrice', 'Hannelore', 'Carmen', 'Mildred', 'Olga', 'Lucia', 'Vera'],
    m: ['Walter', 'Harold', 'Klaus', 'Giuseppe', 'Arthur', 'Bernard', 'Hiroshi', 'Stanley', 'Frank', 'Albert', 'Ernesto', 'Dieter', 'Leonard', 'Mehmet', 'Raymond', 'Vincent', 'Eugene', 'Kazimierz', 'Otis', 'Henry'],
  },
  mid: {
    f: ['Sandra', 'Monika', 'Lisa', 'Priya', 'Karen', 'Nadia', 'Claudia', 'Mei', 'Sabine', 'Angela', 'Leticia', 'Julia', 'Amara', 'Heike', 'Natasha', 'Ines', 'Rachel', 'Ayumi', 'Bettina', 'Samira'],
    m: ['Michael', 'Thomas', 'Ahmed', 'Stefan', 'David', 'Marco', 'Kenji', 'Andreas', 'Rafael', 'Paul', 'Tobias', 'Darnell', 'Jan', 'Sergei', 'Ravi', 'Chris', 'Oliver', 'Emeka', 'Lars', 'Pedro'],
  },
  young: {
    f: ['Mia', 'Zoe', 'Lena', 'Aisha', 'Chloe', 'Yuki', 'Emma', 'Sofia', 'Nia', 'Hannah', 'Leonie', 'Maya', 'Imani', 'Freya', 'Lucía', 'Selin', 'Ava', 'Jade', 'Mara', 'Amélie'],
    m: ['Noah', 'Luca', 'Jonas', 'Omar', 'Finn', 'Kai', 'Elias', 'Mateo', 'Jayden', 'Leon', 'Arjun', 'Ben', 'Malik', 'Theo', 'Ruben', 'Hugo', 'Ezra', 'Kofi', 'Milan', 'Felix'],
  },
  kid: {
    f: ['Lily', 'Ella', 'Nora', 'Amira', 'Ivy', 'Luna', 'Rosie', 'Hana', 'Mila', 'Tilly', 'Zara', 'Pia', 'Esme', 'Aya', 'Juna'],
    m: ['Max', 'Leo', 'Sami', 'Ollie', 'Milo', 'Tom', 'Kian', 'Nico', 'Jasper', 'Ali', 'Ben', 'Rio', 'Paul', 'Aiden', 'Juri'],
  },
} as const;

const LAST = [
  'Smith', 'Müller', 'Okonkwo', 'Rossi', 'Nguyen', 'García', 'Kowalski', 'Tanaka', 'Schneider', 'Haddad', 'O\'Brien', 'Petrov',
  'Fischer', 'Silva', 'Andersson', 'Kim', 'Dubois', 'Weber', 'Mensah', 'Novak', 'Brennan', 'Yilmaz', 'Hoffmann', 'Moreau',
  'Patel', 'Lindqvist', 'Costa', 'Wagner', 'Sato', 'Rahman', 'Becker', 'Lopez', 'Jensen', 'Kaur', 'Fontaine', 'Okafor',
  'Bianchi', 'Schulz', 'Ivanova', 'Walsh', 'Chen', 'Kruger', 'Romero', 'Lehmann', 'Adeyemi', 'Varga', 'Hughes', 'Takahashi',
  'Meyer', 'Duarte', 'Nowak', 'Bauer', 'Mbeki', 'Sorensen', 'Fernández', 'Keller', 'Ali', 'Morales', 'Richter', 'Doyle',
];

/** Age in years (Citizen.age is 0..1 of a hundred years). */
export function yearsOf(c: Citizen): number {
  return Math.round(c.age * 100);
}

export function isFemale(c: Citizen): boolean {
  return c.gender < 0.5;
}

/** "Mara Okonkwo": the same for the same person, fitting their age and gender. */
export function nameOf(c: Citizen): { first: string; last: string; full: string } {
  const r = new Rng(deriveSeed(c.seed, 'name'));
  const y = yearsOf(c);
  const cohort = c.role === Role.Child || y < 19 ? FIRST.kid : y >= 66 ? FIRST.old : y >= 36 ? FIRST.mid : FIRST.young;
  const first = r.pick(isFemale(c) ? cohort.f : cohort.m);
  const last = r.pick(LAST);
  return { first, last, full: `${first} ${last}` };
}

// ------------------------------------------------------------------ personality

/** Big Five, each 0..1. */
export interface Traits {
  /** Openness: curious, imaginative (= Citizen.curiosity). */
  o: number;
  /** Conscientiousness: orderly, punctual, dutiful. */
  c: number;
  /** Extraversion: talkative, outgoing. */
  e: number;
  /** Agreeableness: friendly, trusting, forgiving. */
  a: number;
  /** Neuroticism: nervous, easily upset (= Citizen.nerve). */
  n: number;
}

export function traitsOf(c: Citizen): Traits {
  const r = new Rng(deriveSeed(c.seed, 'traits'));
  // Sums of two uniforms: most people are middling, few are extreme.
  const t = () => (r.float() + r.float()) / 2;
  return { o: c.curiosity, c: t(), e: t(), a: t(), n: c.nerve };
}

export const TEMPERAMENTS = ['cheerful', 'chatty', 'shy', 'grumpy', 'anxious', 'nosy', 'proud', 'kind', 'dreamy', 'steady'] as const;
export type Temperament = (typeof TEMPERAMENTS)[number];

/** One word for how they come across: the strongest combination of their traits. */
export function temperamentOf(t: Traits): Temperament {
  const score: Record<Temperament, number> = {
    cheerful: t.e + (1 - t.n) + t.a * 0.5 - 1.25,
    chatty: t.e * 1.4 + t.o * 0.6 - 0.92,
    shy: (1 - t.e) * 1.3 + t.n * 0.7 - 0.98,
    grumpy: (1 - t.a) * 1.4 + t.n * 0.5 - 0.92,
    anxious: t.n * 1.6 + (1 - t.e) * 0.2 - 1.02,
    nosy: t.o + t.e * 0.6 + (1 - t.c) * 0.4 - 0.9,
    proud: t.c + (1 - t.a) * 0.8 + t.e * 0.2 - 0.92,
    kind: t.a * 1.6 + (1 - t.n) * 0.3 - 0.95,
    dreamy: t.o * 1.2 + (1 - t.c) * 0.8 - 1.0,
    steady: t.c * 1.1 + (1 - t.n) * 0.9 - 1.01,
  };
  let best: Temperament = 'steady', bs = -Infinity;
  for (const k of TEMPERAMENTS) if (score[k] > bs) { bs = score[k]; best = k; }
  return best;
}

// ------------------------------------------------------------------ job and interest

export type JobKind = 'pupil' | 'student' | 'retired' | 'home' | 'office' | 'shop' | 'factory' | 'dock' | 'civic' | 'food' | 'craft' | 'tech';

const JOB_TITLES: Record<JobKind, readonly string[]> = {
  pupil: ['pupil'],
  student: ['student'],
  retired: ['retired'],
  home: ['stays at home', 'between jobs', 'works from home', 'freelancer'],
  office: ['office worker', 'accountant', 'insurance clerk', 'project manager', 'lawyer', 'architect', 'marketing assistant', 'analyst'],
  shop: ['shop assistant', 'cashier', 'florist', 'bookseller', 'pharmacist', 'baker', 'tailor', 'barber'],
  factory: ['factory worker', 'machinist', 'welder', 'forklift driver', 'warehouse worker', 'robot technician'],
  dock: ['dock worker', 'crane operator', 'harbour pilot', 'fishmonger'],
  civic: ['nurse', 'teacher', 'city clerk', 'librarian', 'paramedic', 'social worker'],
  food: ['cook', 'waiter', 'barista', 'café owner', 'dishwasher'],
  craft: ['plumber', 'electrician', 'carpenter', 'painter', 'bike courier', 'taxi driver'],
  tech: ['drone pilot', 'software developer', 'service-robot mechanic', 'data scientist', 'game designer'],
};

/** What kind of work the jobs of a district are (a workplace's use is not known while its cell is unloaded). */
const DISTRICT_JOBS: Partial<Record<District, readonly JobKind[]>> = {
  downtown: ['office', 'office', 'office', 'tech', 'food', 'civic', 'shop'],
  commercial: ['shop', 'shop', 'food', 'office', 'craft'],
  oldtown: ['shop', 'food', 'food', 'civic', 'craft', 'office'],
  industrial: ['factory', 'factory', 'factory', 'craft', 'tech'],
  port: ['dock', 'dock', 'factory', 'craft'],
  apartments: ['shop', 'civic', 'craft', 'food'],
  rowhouses: ['shop', 'craft', 'civic'],
  suburban: ['civic', 'shop', 'craft'],
  park: ['civic', 'craft'],
};

export interface Job { kind: JobKind; title: string }

/** Their job: by age and role, and for workers by the district they work in. */
export function jobOf(c: Citizen, workDistrict: District | null): Job {
  const r = new Rng(deriveSeed(c.seed, 'job'));
  const y = yearsOf(c);
  let kind: JobKind;
  if (c.role === Role.Child) kind = 'pupil';
  else if (c.role === Role.Senior || y >= 67) kind = 'retired';
  else if (c.role === Role.Worker) kind = r.pick(DISTRICT_JOBS[workDistrict ?? 'commercial'] ?? DISTRICT_JOBS.commercial!);
  else kind = y < 27 && r.chance(0.6) ? 'student' : 'home';
  return { kind, title: r.pick(JOB_TITLES[kind]) };
}

/** Things people love to talk about. */
export const INTERESTS = [
  'football', 'birdwatching', 'cooking', 'old films', 'gardening', 'chess', 'the stock market', 'conspiracy theories',
  'their grandchildren', 'jazz', 'cycling', 'astronomy', 'knitting', 'video games', 'local history', 'fishing',
  'running', 'their dog', 'their cat', 'photography', 'the opera', 'model trains', 'robots', 'superheroes',
] as const;

export function interestOf(c: Citizen): string {
  const r = new Rng(deriveSeed(c.seed, 'interest'));
  const y = yearsOf(c);
  for (let k = 0; k < 8; k++) {
    const it = r.pick(INTERESTS);
    // Children don't talk about grandchildren or stocks; the young rarely about the opera.
    if (it === 'their grandchildren' && y < 55) continue;
    if ((it === 'the stock market' || it === 'the opera' || it === 'knitting') && y < 16) continue;
    return it;
  }
  return 'football';
}

// ------------------------------------------------------------------ mood

export interface MoodInput {
  /** Absolute game day. */
  day: number;
  hour: number;
  /** clear, fair, cloudy, overcast, drizzle, rain, storm, fog. */
  weather: string;
  /** 0..1: how much destruction / danger was near them lately. */
  trouble: number;
  /** −100..100: how they feel about the hero (lifts the mood a little while you talk). */
  opinion: number;
}

/** Today's mood, −1 (miserable) … 1 (great). */
export function moodOf(c: Citizen, t: Traits, m: MoodInput): number {
  const r = new Rng(deriveSeed(c.seed, 'mood', m.day));
  let v = (t.e - t.n) * 0.5 + (t.a - 0.5) * 0.3 + (r.float() - 0.5) * 0.9;
  const bad = m.weather === 'storm' ? 0.35 : m.weather === 'rain' ? 0.2 : m.weather === 'drizzle' || m.weather === 'overcast' ? 0.08 : m.weather === 'clear' ? -0.1 : 0;
  // Dreamers like the rain more than the rest.
  v -= bad * (1 - t.o * 0.6);
  // Late at night the introverts are tired; early mornings are hard on everybody a bit.
  if (m.hour >= 22 || m.hour < 5) v -= 0.15 * (1 - t.e);
  else if (m.hour < 8) v -= 0.08;
  v -= m.trouble * (0.3 + t.n * 0.6);
  v += m.opinion / 400;
  return Math.max(-1, Math.min(1, v));
}

export type MoodWord = 'great' | 'good' | 'fine' | 'meh' | 'bad' | 'shaken';

export function moodWord(v: number, trouble: number): MoodWord {
  if (trouble > 0.5 && v < 0) return 'shaken';
  return v > 0.55 ? 'great' : v > 0.2 ? 'good' : v > -0.15 ? 'fine' : v > -0.5 ? 'meh' : 'bad';
}

/** For the talk panel: "in a good mood". */
export const MOOD_LABEL: Record<MoodWord, string> = {
  great: 'in a great mood', good: 'in a good mood', fine: 'calm', meh: 'a bit down', bad: 'in a bad mood', shaken: 'shaken',
};
