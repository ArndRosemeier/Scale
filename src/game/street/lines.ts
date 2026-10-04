/**
 * What the street characters say (speech bubbles, ui/Barks): their own patter, and lines for the
 * player — close by, flying past, a giant, tiny, famous, infamous, wanted — plus a few moments
 * (a coin in the hat, a dropped ball, running for it). `{place}` is filled in by the caller.
 */
import type { StreetKind } from './cast';

export type LineTopic = 'own' | 'greet' | 'fly' | 'giant' | 'tiny' | 'hero' | 'villain' | 'wanted' | 'panic' | 'hit' | 'leave' | 'special';

type Pool = Partial<Record<LineTopic, readonly string[]>>;

/** Fallbacks for anyone without their own line on a topic. */
const ANYONE: Pool = {
  greet: ['Hey there.', 'Nice day for it.', 'You again?'],
  fly: ['Did that person just fly?', 'Show-off!', 'Hey! No flying over the act!'],
  giant: ['Whoa. Big fella.', 'Mind your feet up there!', 'Please don\'t step on me.'],
  tiny: ['Aww, look at the little one!', 'Did somebody shrink?', 'Careful, tiny, people walk here.'],
  hero: ['Hey, you\'re that hero!', 'Big fan! Big fan!', 'Can I get a selfie later?'],
  villain: ['Oh no. It\'s you.', 'Keep walking, pal.', 'I don\'t want any trouble.'],
  wanted: ['Cops are looking for you, you know.', 'I didn\'t see anything. Nothing!'],
  panic: ['Not again!', 'Show\'s over, folks!', 'Run!'],
  hit: ['Ow! What was that for?', 'Hey! I\'m working here!'],
  leave: ['That\'s it for today, folks.', 'Same time tomorrow!'],
};

const LINES: Record<StreetKind, Pool> = {
  preacher: {
    own: [
      'The end is nigh!', 'Repent! The star that fell was no star!', 'Something walks in the river at night!',
      'They glow down there. Under the drains. Watching!', 'The ground hums at night. Can\'t you hear it?',
      'Giants! Giants shall rise from the water!', 'The machines will turn on us — mark my words!',
      'Your phones won\'t save you!', 'Look up! LOOK UP!', 'The sewers go deeper than the maps say!',
      'Woe to the city of glass and towers!', 'Turn back! Turn back while there is time!',
      'I have seen the light beneath the streets!', 'It\'s coming! It is ALWAYS coming!',
    ],
    greet: ['You! Yes, YOU! Repent!', 'You have the look of the chosen.', 'Brother! Sister! The hour is late!'],
    fly: ['A sign! A SIGN IN THE SKY!', 'The heavens are open!', 'Come down from there, angel or devil!'],
    giant: ['THE GIANTS ARE HERE! I SAID IT! I SAID IT!', 'Behold! The prophecy walks!'],
    tiny: ['Even the smallest shall be judged!', 'The meek shall inherit… oh. Very meek.'],
    hero: ['Even heroes must repent!', 'Can you stop what is coming, hero? CAN you?'],
    villain: ['The wicked walk among us! THERE!', 'Your sins are many, stranger!'],
    wanted: ['The law seeks you, sinner!', 'Flee! As the wicked always flee!'],
    panic: ['I TOLD YOU! I TOLD ALL OF YOU!', 'IT HAS BEGUN!', 'Nobody ever listens!'],
    hit: ['Strike me down! I shall only grow louder!', 'Persecution!'],
    leave: ['The end will have to wait till tomorrow.', 'I\'ll be back. So will IT.'],
  },
  busker: {
    own: ['♪ La la laaa… ♪', 'Requests? Anyone?', 'This one\'s an original.', '♪ Ooh, the city at night… ♪', 'Tips appreciated, folks!', 'Thank you, thank you!', 'Bit of a crowd today.', 'Last one before my break.'],
    greet: ['Got a favourite song?', 'Hey, stay for one more?', 'Thanks for stopping!'],
    fly: ['Now THAT\'s a stage entrance.', 'Flying audience, that\'s new.'],
    giant: ['Biggest fan I ever had.', 'Uh… song for the tall person!'],
    hero: ['I\'m writing a song about you, you know.', 'Hero of the city! This one\'s for you.'],
    villain: ['Please don\'t smash the guitar.', 'Just… listening, right?'],
    panic: ['Not the guitar! NOT THE GUITAR!', 'Gig\'s over!'],
    hit: ['Hey! Watch the guitar!'],
    leave: ['Thanks folks, you\'ve been great!', 'That\'s my set. Goodnight!'],
    special: ['Thank you kindly!', 'Cheers, mate!', 'Bless you!', 'That\'s a sandwich tonight!'],
  },
  statue: {
    own: ['…', '……', '(perfectly still)'],
    greet: ['…', '(the statue winks)'],
    fly: ['(the statue\'s eyes follow you)'],
    giant: ['(the statue sweats silver)'],
    hero: ['(the statue salutes)'],
    panic: ['Okay, statue\'s off duty!', 'NOPE.'],
    hit: ['OW! I\'m a professional!', 'Hands off the art!'],
    leave: ['(the statue walks away. Unsettling.)'],
    special: ['BOO!', 'Gotcha!', 'Ha! Every time.', 'Tips welcome, by the way.', 'Made you jump!'],
  },
  mime: {
    own: ['…', '(taps on invisible glass)', '(pulls an invisible rope)', '(silently screams)', '(is trapped. Again.)'],
    greet: ['(waves frantically from inside the box)', '(mouths: "help")'],
    fly: ['(points up, astonished)'],
    giant: ['(mimes being very, very small)'],
    hero: ['(mimes a cape blowing in the wind)'],
    villain: ['(mimes a tiny violin)'],
    panic: ['AAAAAH! — oh. Sorry.', '…!!!'],
    hit: ['(mimes great pain)', 'Ow! — I mean… (silence)'],
    leave: ['(climbs out of the box)'],
  },
  juggler: {
    own: ['Three balls! Nothing up my sleeves!', 'Watch this, watch this!', 'And now — blindfolded! …Just kidding.', 'Hup! Hup!', 'Who wants to see five?'],
    greet: ['You want to try? No? Smart.', 'Stand back, professional at work!'],
    fly: ['Show-off. I can only do balls.'],
    giant: ['Can you juggle cars? I bet you can juggle cars.'],
    hero: ['Juggled for the hero! Put that on my poster!'],
    panic: ['Balls everywhere!', 'Not my day!'],
    hit: ['Hey! I nearly dropped one!'],
    leave: ['That\'s the show! Coins in the hat!'],
    special: ['Oops!', 'That was on purpose.', 'Gravity, man.', 'Part of the act!'],
  },
  dancer: {
    own: ['Can\'t hear you!', 'This beat though!', 'Woo!', 'Feel it!', 'Keep up, keep up!', 'Yeah! Yeah!'],
    greet: ['Come on, dance with me!', 'You got moves? Show me!'],
    fly: ['Okay, that\'s a sick move.', 'Teach me THAT!'],
    giant: ['Big moves! Big moves!', 'Watch your step, big dancer!'],
    tiny: ['Tiny dance battle! Let\'s go!'],
    hero: ['Yo, the hero! Dance-off, you and me!'],
    panic: ['Battle\'s cancelled!', 'Run, crew, run!'],
    hit: ['Hey! Personal space!'],
    leave: ['Crew, we\'re out!', 'Peace!'],
  },
  mascot: {
    own: ['Bawk! Two for one at {place}!', 'Cluck cluck! Get your flyer!', 'Free sample, anyone? Bawk!', 'It\'s so hot in here.', 'Chicken Tuesday at {place}!', 'Bawk bawk! Half-price wings!', 'Please take one. Please.'],
    greet: ['Flyer? Bawk!', 'You look hungry! Bawk!'],
    fly: ['Chickens can\'t do that. Trust me, I tried.', 'Bawk?!'],
    giant: ['Family bucket for the big one!'],
    hero: ['Free nuggets for heroes! …Maybe.'],
    villain: ['Bawk… bawk… backing away…'],
    panic: ['THE CHICKEN IS LEAVING!', 'Bawk! BAWK!'],
    hit: ['You hit a chicken! Who hits a chicken?!'],
    leave: ['Shift\'s over. Getting this head off.'],
    special: ['Here you go! Bawk!', 'Enjoy! Bawk!', 'Tell your friends!'],
  },
  conspiracy: {
    own: [
      'Birds aren\'t real. Think about it.', 'The metro goes deeper than they tell you.', 'Why do the robots all face the same way at night?',
      'The falling star? Satellite. Government satellite.', 'Ever wonder why the drains glow green?', 'They put something in the river.',
      'The pigeons report to someone.', 'Wake up, people!', 'The foil keeps them out of my head.', 'Who built the city? WHO?',
      'There are things living down there. Big, slimy things.', 'Count the drones. Go on, count them.',
    ],
    greet: ['You\'re awake, aren\'t you? I can tell.', 'Psst. Want to know the truth?'],
    fly: ['FLYING PEOPLE! The cover-up is over!', 'Anti-gravity! I KNEW it!'],
    giant: ['Growth hormones in the water. Told you!', 'Experiments! EXPERIMENTS!'],
    tiny: ['Shrink ray. They have a shrink ray!'],
    hero: ['Who pays the hero? Ask yourselves that.', 'Hero, huh? Convenient.'],
    villain: ['A plant! You\'re a government plant!'],
    wanted: ['The cops are after you? Welcome to the club.'],
    panic: ['THIS IS WHAT THEY WANT!', 'I WAS RIGHT! I WAS RIGHT!'],
    hit: ['Assault! They sent an agent!'],
    leave: ['They\'re onto me. Moving on.'],
  },
  pigeons: {
    own: ['There you go, my darlings.', 'Don\'t be greedy, Gerald.', 'Come on, little ones.', 'Mind the crumbs, dear.', 'They\'re better company than people.', 'One for you, and one for you…'],
    greet: ['They don\'t bite, dear.', 'Want to feed them too?'],
    fly: ['You scared my babies!', 'Shoo! Not you, the flying one!'],
    giant: ['Watch where you step, you great lump!'],
    hero: ['Oh, you\'re that nice young hero!'],
    villain: ['Hooligan.'],
    panic: ['Oh my! Oh my!', 'My birds!'],
    hit: ['Well, I never!', 'How DARE you!'],
    leave: ['Same time tomorrow, my darlings.'],
  },
  sleepwalker: {
    own: ['Zzz…', '…five more minutes…', '…not the cheese again…', '…mum, I\'m up, I\'m up…', 'Zzz… mmh… pancakes…', '…I can fly… zzz…'],
    greet: ['…mum? Is that you?', '…the bus… don\'t let it leave…'],
    fly: ['…I\'m flying too… zzz…'],
    giant: ['…big… so big… zzz…'],
    panic: ['WHAT? Where am I?!', 'Huh? HUH?!'],
    hit: ['Ow — wh— where am I?'],
    leave: ['…home… bed…'],
  },
  tourist: {
    own: ['Where is {place}? It\'s on the map…', 'This map is upside down. Or I am.', 'Excuse me! Excuse me?', 'Everything looks the same here.', 'Is this north? This feels like north.'],
    greet: ['Excuse me! Which way to {place}?', 'Sorry — is this the way to {place}?', 'Hi! Could you take a photo of me? No? Okay.'],
    fly: ['Is that… a local thing?', 'Nobody told me about flying people!'],
    giant: ['That\'s not in the guidebook!'],
    hero: ['Are you famous? You look famous!'],
    panic: ['Is this normal here?!', 'I want to go home!'],
    hit: ['Ow! The guidebook said this was a friendly city!'],
    leave: ['Found it! I think.'],
    special: ['Thanks anyway!', 'Oh! Thank you!', 'I\'ll just ask someone else.'],
  },
  jogger: {
    own: ['On your left!', 'Morning!', 'Can\'t stop! PB pace!', 'Huff… huff…', 'Coming through!', 'Lovely day for it!'],
    greet: ['On your left!', 'Join me! No? Fine!'],
    fly: ['Cheater!', 'That\'s not fair!'],
    giant: ['Your stride must be amazing!'],
    hero: ['Morning, hero! Race you!'],
    panic: ['Interval training! INTERVAL TRAINING!', 'Run!'],
    hit: ['Ow! My split time!'],
    leave: ['Cool-down time!'],
  },
};

/** A line on a topic for a kind (its own, else anyone's; null when nobody has one). */
export function lineFor(kind: StreetKind, topic: LineTopic, rnd: () => number, place = 'the old town'): string | null {
  const l = LINES[kind][topic] ?? ANYONE[topic];
  if (!l || !l.length) return null;
  return l[Math.floor(rnd() * l.length)].replace('{place}', place);
}

/** Every line (self test: no empty or broken ones). */
export function allLines(): string[] {
  const out: string[] = [];
  for (const p of [ANYONE, ...Object.values(LINES)]) for (const l of Object.values(p)) out.push(...(l ?? []));
  return out;
}

/** Sandwich board texts ('|' breaks the line). */
export const BOARDS = {
  preacher: ['THE END|IS NIGH', 'REPENT!', 'THE STAR|WAS A|WARNING', 'THEY|RISE FROM|THE RIVER', 'LOOK|DOWN'],
  conspiracy: ['WAKE UP!', 'BIRDS|AREN\'T|REAL', 'ASK ABOUT|THE METRO', 'THEY ARE|LISTENING', 'THE DRAINS|GLOW'],
};
