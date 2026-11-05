/** What Leo, his kids and the firefighters say (speech bubbles). */

export type FloaterTopic =
  | 'patter' | 'wave' | 'kid' | 'kidStop' | 'fly' | 'giant' | 'hero' | 'menace' | 'tiny'
  | 'gust' | 'kidGust' | 'stuck' | 'kidBelow' | 'ff' | 'ffTop' | 'ffHand' | 'heroTake' | 'heroHand' | 'kidThanks' | 'hit' | 'home';

const LINES: Record<FloaterTopic, string[]> = {
  patter: [
    'Lovely day for a float!',
    'I haven\'t touched the ground since March.',
    'Shoes are mostly decorative now.',
    'The pigeons think I\'m one of them.',
    'I sleep under a cargo net, if you must know.',
    'People ask if I\'m a balloon. I\'m an accountant.',
    'Stairs are wonderful. I just drift up them.',
    'The crystal? Nice and shiny. Would not recommend.',
    'Mia, not so fast, Daddy\'s not a kite.',
    'Hello! Yes, it\'s me. No, I can\'t come down.',
    'Someone\'s always filming. Hi, Mum!',
    'At least I never trip over anything.',
  ],
  wave: ['Hello there!', 'Afternoon!', 'Hi! Lovely to see you!', 'Morning! Mind the string.', 'Yes, it\'s really me!'],
  kid: [
    'Come on, Dad!',
    'Dad, stop waving at everyone.',
    'Ben, you hold him next. Both hands.',
    'Dad, people are filming again.',
    'Can we get ice cream? You can\'t hold a cone, Dad.',
    'Mum says double knot!',
  ],
  kidStop: ['Wait here, Dad. Ha ha.', 'Dad, you\'re drifting again.', 'Ben, stop pulling him!'],
  fly: ['You can fly properly! Any tips on landing?', 'Show-off! In the nicest way.', 'Careful up there, it\'s gusty!'],
  giant: ['Gently, big one! I blow away easily!', 'Ooh, now you know how it feels to stick out!'],
  hero: ['You\'re that hero! I\'d shake your hand, but I\'d drift off.', 'Big fan! Well. A floating fan.', 'If a gust gets me, you know where I\'ll be!'],
  menace: ['Kids, behind me. Well, below me.', 'Let\'s go the other way, kids.'],
  tiny: ['Oh, hello down there! Now I\'m the tall one.', 'You and me, we should start a club.'],
  gust: ['Whoa! Gust! Gust!', 'Mia, the string!', 'Not agaaain!', 'Here I go!'],
  kidGust: ['DAD!', 'Dad! Come back!', 'I\'m sorry! It just slipped!'],
  stuck: ['I\'m fine! Bit of a view up here.', 'Could someone call the fire brigade? They know me.', 'Hello, pigeons. Yes, me again.', 'Help! Not urgent! But help!'],
  kidBelow: ['Hold on, Dad!', 'The fire brigade\'s coming, Dad!', 'Dad\'s on the roof again.'],
  ff: ['Afternoon, Leo. Third time this month.', 'Hold still, we\'ve got you.', 'Ladder up!'],
  ffTop: ['Got the string. Down we go.', 'Mind your head on the gutter.'],
  ffHand: ['There you go, kids. Double knot this time.', 'All yours. Stay out of the wind, Leo.'],
  heroTake: ['Oh! Thank you! Mind the chimneys on the way down.', 'My hero! Literally!', 'Gently, please. I\'m a bit of a kite.'],
  heroHand: ['Thank you! Kids, say thank you to the hero.', 'Back on the string. Thank you!'],
  kidThanks: ['Thank you!!', 'You got him! Thanks!', 'Thanks for bringing Dad back!'],
  hit: ['Ow! What was that for?', 'Hey! I only float!'],
  home: ['Time to go home, kids.', 'Home time. Somebody tie me to the bed.'],
};

/** A line of a topic (random pick through `r`). */
export function floaterLine(topic: FloaterTopic, r: () => number): string {
  const L = LINES[topic];
  return L[Math.floor(r() * L.length) % L.length];
}

export const FLOATER_TOPICS = Object.keys(LINES) as FloaterTopic[];
