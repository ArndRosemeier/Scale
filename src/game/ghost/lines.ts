/**
 * What the ghost tour guide says (speech bubbles, src/ui/voices.ts rule: no synthesized voices).
 * Ambrose Penhallow, the city's crier until 1887, has been giving night tours ever since. Friendly,
 * a little vain about his stories, forever forgetting that the living need doors.
 * `{place}` is filled with "on Elm Street" style places (game/story where()), `{name}` with his.
 */

export const GHOST_NAME = 'Ambrose Penhallow';
export const GHOST_TITLE = 'Ghost tour guide';

export type GhostTopic =
  | 'welcome' | 'start' | 'graveStory' | 'houseStory' | 'oldStory' | 'punch' | 'follow' | 'phaseStart' | 'phaseEnd'
  | 'farewell' | 'invite' | 'fly' | 'giant' | 'tiny' | 'hero' | 'villain' | 'wanted' | 'through' | 'hitThrough'
  | 'scared' | 'lost' | 'thanks' | 'dawn';

/** Each stop's story comes as three bubbles (a set): the start, the middle, the punchline. */
export const STORIES: Record<'graveStory' | 'houseStory' | 'oldStory', readonly (readonly [string, string, string])[]> = {
  graveStory: [
    ['Here lies Old Tobias, the lamplighter.', 'Every night he still tries to light the lamps along the wall.', 'He has not managed one in ninety years. We cheer him on.'],
    ['This is the grave of the Widow Marsh.', 'She buried three husbands, all in this very row.', 'She says it was the cooking. I believe her.'],
    ['Captain Elias Crane, lost at sea.', 'His body was never found, so this grave is empty.', 'He haunts the harbour instead. Lovely chap. Smells of seaweed.'],
    ['The twins, Agatha and Agnes.', 'They argued for seventy years about who was born first.', 'They are still arguing. On quiet nights you can hear it.'],
    ['Professor Hargreave, inventor.', 'He built a machine to talk to the dead.', 'It worked. He is on the other end of it now. Rather pleased.'],
    ['A poet lies here. Nobody remembers his name.', 'Not even him, which upsets him terribly.', 'If you hear a sad sonnet tonight, that is Gerald. Or Gordon.'],
    ['This stone is the oldest in the city.', 'The name has worn away completely.', 'I asked its owner once. He said it was none of my business.'],
  ],
  houseStory: [
    ['This house was once an apothecary.', 'The owner sold a potion for eternal life in 1852.', 'He took it himself. Didn\'t work. We play cards on Tuesdays.'],
    ['Behind these walls, a famous séance went wrong.', 'Twelve people tried to call a spirit.', 'They called me. I was in the bath. Very awkward for everyone.'],
    ['A baker lived here who never slept.', 'He baked through the night for forty years.', 'You can still smell fresh bread at three in the morning. Or that\'s the shop next door.'],
    ['In this building the great fire of 1871 began.', 'A cat knocked over a candle.', 'The cat is still around. It looks very guilty.'],
    ['A jeweller hid his gold somewhere in this house.', 'People have searched for it for a century.', 'I know where it is. I\'m not telling. A ghost needs a hobby.'],
    ['This is where I proposed to my dear Eliza.', 'She said she would think about it.', 'She is still thinking. She lives across town. It\'s been 140 years.'],
  ],
  oldStory: [
    ['This spot was the old town square.', 'Public hangings, every Sunday after church.', 'Terrible business. The food stalls were excellent, though.'],
    ['A highwayman was caught right here.', 'He swore he would come back for revenge.', 'He did come back. He sells postcards now. Very reasonable prices.'],
    ['Under these stones runs a secret tunnel.', 'Smugglers used it to bring in brandy.', 'Some of the brandy is still down there. Some of the smugglers too.'],
    ['Here stood the city gallows tree.', 'Legend says its leaves whisper names at night.', 'Mostly they whisper "mind the step". It\'s a considerate tree.'],
    ['The city crier stood here every morning. That was me.', 'Hear ye, hear ye! I shouted the news for thirty years.', 'Old habits. I still do it at dawn. The neighbours love it.'],
  ],
};

const LINES: Record<Exclude<GhostTopic, 'graveStory' | 'houseStory' | 'oldStory'>, readonly string[]> = {
  welcome: [
    'Gather round, gather round! Welcome to the Twilight Tour.',
    'Good evening, good evening! Ambrose Penhallow, your guide. Deceased.',
    'Welcome, living friends! Stay close. And stay alive, it\'s easier.',
  ],
  start: ['Right then, follow me. Watch the gravestones, they bite. No they don\'t.', 'This way, everyone. Mind the puddles, I can\'t.', 'Off we go! Lanterns up. Well, mine is.'],
  punch: ['Woooo! Ha ha, just my little joke.', 'And THEN… the lights went out! Ha!', 'Boo! Sorry, sorry. Can\'t help myself.'],
  follow: ['Keep up, please, the night won\'t last forever.', 'This way! Don\'t dawdle, I haven\'t got all eternity. Well, I have.', 'Over here, everyone!'],
  phaseStart: [
    'And the strangest thing about this street is that—',
    'Now, if you look to your left, you will see—',
    'Let me tell you about the man who lived on the other side of—',
    'Ahh, this reminds me of a story about a door that—',
  ],
  phaseEnd: [
    'Oh! Sorry. I keep forgetting you need doors.',
    '…where was I? Oh dear, they\'re walking round. Of course.',
    'Ah. The living. Always going the long way.',
    'Sorry about that. Walls are more of a suggestion for me.',
  ],
  farewell: [
    'And that concludes the Twilight Tour! Tips are welcome, but I can\'t hold them.',
    'Thank you, thank you! Sleep well. I won\'t be watching. Probably.',
    'That\'s the tour! Mind how you go, and do come back. Not like me, though.',
  ],
  invite: [
    'You there! Join the tour, it\'s free. The dead don\'t need money.',
    'A latecomer! Come along, we\'ve only just begun.',
    'Care to join us? Ghost stories, every night, no refunds.',
  ],
  fly: ['Ooh, another one who floats! Welcome, colleague.', 'Flying? Show-off. I\'ve been doing that since 1887.'],
  giant: ['Goodness, a big one! Mind the graves, dear, they\'re listed.', 'Ladies and gentlemen, don\'t look up. Very large guest.'],
  tiny: ['Is that a person or a very brave mouse? Welcome either way.'],
  hero: ['Ladies and gentlemen, our city\'s hero is on the tour tonight! A round of applause.', 'The hero! I\'ll put you in my stories one day. After you\'re dead, ideally.'],
  villain: ['Ah. A rather notorious guest. Hold on to your purses, everyone.', 'I know your face from the papers. Behave, and nobody gets haunted.'],
  wanted: ['The police are looking for you, you know. They never look for me.'],
  through: ['Ooh! That tickles.', 'Do you mind? You\'re standing in my liver.', 'Excuse me, you\'re in me.', 'Brrr. You\'re very warm. Please step out.'],
  hitThrough: ['Went straight through me. Rude, but harmless.', 'Ha! Missed. Well, not missed. Through.', 'Violence! On a ghost tour! In my day we just glowered.'],
  scared: ['Oh dear, not again. They always run.', 'Come back! It\'s only a little danger!', 'Well. That\'s the tour over, then.'],
  lost: ['Everyone? Hello? I seem to have lost my tour.', 'Oh. Nobody left. That happens.'],
  thanks: ['And a special thank-you to our hero for sticking with us!', 'You stayed for the whole tour! I like you. I may haunt you, a little, fondly.'],
  dawn: ['Oh, is it dawn already? Must dash. Or fade, rather.', 'The sun! Excuse me, I\'m not a morning ghost.'],
};

/** A line on a topic; `r` gives 0..1. */
export function ghostLine(topic: Exclude<GhostTopic, 'graveStory' | 'houseStory' | 'oldStory'>, r: () => number, place = ''): string {
  const L = LINES[topic];
  return L[Math.floor(r() * L.length) % L.length].replace('{place}', place);
}

/** What the tourists say now and then. */
export const TOURIST_LINES = {
  gasp: ['Ooh!', 'No way!', 'Creepy…', 'Did you hear that?', 'Brr.'],
  laugh: ['Ha ha!', 'He\'s funny!', 'Ha!'],
  awe: ['He\'s actually see-through!', 'Is this real?', 'Best tour ever.', 'Get a picture of him!', 'How does he do that?'],
  wall: ['He went through the wall!', 'Wait, where did he go?', 'Is he coming back?', 'We have to go round!'],
  clap: ['Bravo!', 'Thank you!', 'Wonderful!'],
} as const;
