/**
 * What the player can mean (typed NPC chat): every intent with example sentences and, for the
 * clear-cut cases, patterns. Patterns run first on the normalised text (normalise.ts) and win
 * when they match; the sentence model compares everything else with the examples (understand.ts),
 * so an intent needs examples in many shapes, not many patterns. Words in the examples stand for
 * any of their kind ("your brother" for any relative, "jazz" for anything you can like): who or
 * what is meant comes from the names found in the sentence (lexicon.ts), not from the intent.
 *
 * The self test keeps a separate set of typed lines (corpus.ts) that are NOT examples here and
 * checks how many of them are understood.
 *
 * Pure data.
 */

export type Intent =
  // social
  | 'greet' | 'bye' | 'thanks' | 'sorry' | 'how_are_you' | 'compliment' | 'insult' | 'threat' | 'joke' | 'flirt' | 'laugh'
  | 'yes' | 'no' | 'dunno' | 'okay' | 'reassure'
  // about them (or someone they know)
  | 'ask_name' | 'ask_age' | 'ask_job' | 'ask_work_where' | 'ask_home' | 'ask_family' | 'ask_partner' | 'ask_children' | 'ask_friends'
  | 'ask_hobby' | 'ask_like' | 'ask_favourite' | 'ask_feel' | 'ask_scared' | 'ask_need' | 'ask_plans' | 'ask_about' | 'ask_opinion' | 'ask_know'
  // about the world
  | 'ask_news' | 'ask_where' | 'ask_safe' | 'ask_gang' | 'ask_weather' | 'ask_time' | 'ask_threat' | 'ask_place' | 'ask_city' | 'ask_trouble'
  // about the hero
  | 'ask_me' | 'ask_know_me' | 'ask_my_name'
  // telling them
  | 'tell_name' | 'tell_like' | 'tell_dislike' | 'tell_feel' | 'tell_hero'
  // asking of them
  | 'offer_help' | 'ask_help' | 'req_leave' | 'req_calm'
  // the conversation itself
  | 'why' | 'more' | 'really' | 'you_too' | 'what_can_i_say' | 'repeat' | 'unclear';

export interface IntentDef {
  id: Intent;
  /** Example sentences (the sentence model's reference; also its word-overlap fallback). */
  ex: readonly string[];
  /** Patterns over the normalised text that settle it outright. */
  re?: readonly RegExp[];
}

const R = (...re: RegExp[]) => re;

export const INTENTS: readonly IntentDef[] = [
  // ------------------------------------------------------------------ social
  { id: 'greet', re: R(/^(hi|hello|hey|hey there|hi there|hello there|greetings|good (morning|afternoon|evening|day)|morning|evening|yo|sup|whats up|what is up|hiya|(yo |hey )?what is up)( (there|friend|mate|buddy|you|sir|madam|lady|man|dude|everyone))?$/),
    ex: ['hello', 'hi there', 'hey', 'good morning', 'good evening to you', 'greetings, citizen', 'hey, how is it going', 'nice to meet you', 'howdy', 'hello friend', 'well hello', 'hey you', 'sup'] },
  { id: 'bye', re: R(/^(bye|goodbye|good bye|see you|see you later|see ya|farewell|later|gotta go|got to go|i have to go|i must go|take care|good night|cheerio|so long|bye bye)( (then|now|friend|mate))?$/),
    ex: ['goodbye', 'see you around', 'I have to go now', 'bye then', 'I will be off', 'catch you later', 'take care of yourself', 'I need to leave', 'have a nice day', 'until next time', 'good night', 'I am off, bye', 'later then', 'have a good day', 'I gotta run', 'off I go'] },
  { id: 'thanks', re: R(/^(thanks|thank you|thank you very much|thanks a lot|many thanks|cheers|much appreciated|thank you so much)( (so much|a lot|for that|friend|mate))?$/),
    ex: ['thank you', 'thanks a lot', 'cheers for that', 'I appreciate it', 'that is very kind, thanks', 'thanks for the help', 'thank you for telling me', 'much obliged'] },
  { id: 'sorry', re: R(/^(sorry|i am sorry|i am so sorry|my bad|my apologies|apologies|forgive me|excuse me)\b.{0,30}$/),
    ex: ['sorry', 'I apologise', 'I am sorry about that', 'forgive me', 'sorry for knocking you over', 'I did not mean to hurt you', 'my mistake', 'sorry about earlier', 'I feel bad about what happened'] },
  { id: 'how_are_you', re: R(/^(how are you|how are you doing|how is it going|how do you do|how have you been|how is life|how is your day|how are things|you okay|are you okay|are you all right|you all right)( today| doing| now)?$/),
    ex: ['how are you', 'how are you doing today', 'how is your day going', 'are you doing well', 'how have you been', 'what is up with you', 'how is life treating you', 'you okay?', 'are you feeling all right', 'how do you feel today'] },
  { id: 'compliment',
    ex: ['you look nice', 'I like your style', 'you are very kind', 'nice outfit', 'you seem like a good person', 'you are funny', 'you are smart', 'I like you', 'you have a lovely smile', 'you are great', 'what a nice person you are', 'nice hat', 'you are cool', 'you are awesome', 'love your shoes', 'cool jacket', 'great dress'] },
  { id: 'insult', re: R(/\b(idiot|stupid|moron|dumb|loser|ugly|shut up|fuck|fucking|bitch|bastard|asshole|dickhead|piss off|screw you|jerk|fool|pathetic|useless|worthless|creep|freak|scum)\b/),
    ex: ['you are an idiot', 'shut up', 'you are boring', 'nobody cares', 'you are ugly', 'what a loser', 'you smell', 'you are useless', 'go away, you bore me', 'you are pathetic', 'I hate you', 'you are annoying', 'you are so dumb', 'everyone hates you', 'no one likes you'] },
  { id: 'threat', re: R(/\b(i will|i am going to|i could|gonna|going to|want to) (kill|hurt|smash|crush|beat|punch|destroy|squash|step on|throw|eat|burn|fry|break) you\b/, /\b(or else|you are dead|you will die|watch your back|i will end you|or you will (regret|be sorry)|you will regret)\b/),
    ex: ['I will kill you', 'I am going to hurt you', 'give me your money', 'I could crush you like a bug', 'do what I say or else', 'I will destroy this whole street', 'you are dead', 'I will throw you into the river', 'hand over your wallet', 'run before I smash you', 'I will burn your house down'] },
  { id: 'joke', re: R(/\b(tell|know) (me )?(a |any )?(joke|jokes|something funny)\b/, /^make me laugh$/),
    ex: ['tell me a joke', 'do you know any jokes', 'say something funny', 'make me laugh', 'got a joke for me', 'cheer me up with a joke'] },
  { id: 'flirt', re: R(/\b(date|go out with me|marry me|kiss me|you are (hot|sexy|cute|beautiful|handsome|gorgeous)|are you single)\b/),
    ex: ['you are cute', 'want to go out with me', 'are you single', 'can I have your number', 'will you marry me', 'you are beautiful', 'let us get a drink sometime', 'you are very handsome', 'can I take you to dinner', 'want to have a coffee with me', 'do you have someone', 'are you taken'] },
  { id: 'laugh', re: R(/^(haha|hahaha|hehe|hihi|lol|ha|ha ha|funny|that is funny|good one|nice one|very funny|hilarious)( haha)?$/),
    ex: ['haha', 'that is funny', 'good one', 'very funny', 'you made me laugh', 'hilarious'] },
  { id: 'yes', re: R(/^(yes|yes please|sure|of course|definitely|absolutely|certainly|indeed|i do|i am|i did|right|correct|exactly|totally|why not|ok sure|okay sure|yes i do|yes i am|i guess so|i think so|true|that is right)( (yes|i do|of course))?$/),
    ex: ['yes', 'sure', 'of course I do', 'absolutely', 'yes, I am', 'I think so', 'that is right', 'indeed'] },
  { id: 'no', re: R(/^(no|no thanks|no thank you|not really|nope|never|i do not|i am not|i did not|not at all|nah|negative|of course not|certainly not|i do not think so|not me|no no)( (thanks|really))?$/),
    ex: ['no', 'not really', 'no thanks', 'I do not', 'not at all', 'no way', 'I do not think so', 'never', 'nope, sorry'] },
  { id: 'dunno', re: R(/^(i do not know|do not know|no idea|i have no idea|not sure|i am not sure|who knows|maybe|perhaps|hard to say|i can not say|beats me|no clue)$/),
    ex: ['I do not know', 'no idea', 'not sure', 'maybe', 'who knows', 'beats me'] },
  { id: 'okay', re: R(/^(okay|ok|all right|fine|cool|nice|great|good|i see|ah|oh|hmm|hm|mhm|uh huh|got it|understood|interesting|really nice|wow|oh well|fair enough|right then|whatever|good to know|ah okay|oh okay|okay then|sounds good)$/),
    ex: ['okay', 'I see', 'cool', 'got it', 'interesting', 'fair enough', 'oh well', 'good to know'] },
  { id: 'reassure',
    ex: ['do not worry', 'everything will be fine', 'you are safe now', 'I will protect you', 'calm down, it is over', 'I am here to help', 'nothing will happen to you', 'it is all right now', 'you can relax', 'I will keep you safe', 'the danger is gone', 'do not be scared', 'no need to be afraid'] },

  // ------------------------------------------------------------------ the hero
  { id: 'ask_me', re: R(/^what do you think (of|about) me$/, /^do you (like|hate|trust|fear|love) me$/, /^how do you feel about me$/, /^are you (scared|afraid|frightened) of me$/),
    ex: ['what do you think of me', 'do you like me', 'do you trust me', 'am I a good hero', 'what do people say about me', 'am I popular', 'are you afraid of me', 'do people hate me', 'what is my reputation'] },
  { id: 'ask_know_me', re: R(/^(do you know (me|who i am)|have we met( before)?|do you remember me|remember me)$/),
    ex: ['do you know who I am', 'have we met before', 'do you remember me', 'do you recognise me', 'what did I do for you', 'when did we meet', 'what do you remember about me', 'have you heard of me'] },
  { id: 'ask_my_name', re: R(/^(what is my name|do you know my name|who am i|do you remember my name)$/),
    ex: ['what is my name', 'do you remember my name', 'do you know my name', 'what did I say my name was'] },

  // ------------------------------------------------------------------ about them
  { id: 'ask_name', re: R(/^(what is|whats) (your|ur) name$/, /^(who are you|and you are|your name|name)$/, /^what (do|should) (people|i) call you$/),
    ex: ['what is your name', 'who are you', 'tell me your name', 'what should I call you', 'may I ask your name', 'and you are?', 'what is your brother called', 'what is the name of your sister', 'what was your name again'] },
  { id: 'ask_age', re: R(/\bhow old (are|is)\b/, /\bwhat is (your|his|her) age\b/),
    ex: ['how old are you', 'what is your age', 'when were you born', 'are you old', 'how old is your mother', 'what age is your son'] },
  { id: 'ask_job', re: R(/^what (do|does) (you|he|she|your \w+) do( for (a )?living| for work| all day)?$/),
    ex: ['what do you do', 'what is your job', 'what do you do for a living', 'do you work', 'what kind of work do you do', 'are you a student', 'what does your brother do', 'what is your profession', 'where do you go to school', 'are you retired', 'what is your sister job'] },
  { id: 'ask_work_where',
    ex: ['where do you work', 'which company do you work for', 'where is your office', 'where does your wife work', 'is your work far from here', 'where do you go every morning'] },
  { id: 'ask_home', re: R(/\bwhere (do|does) (you|he|she|your \w+) live\b/),
    ex: ['where do you live', 'where is your home', 'do you live around here', 'is your flat nearby', 'which street do you live on', 'where does your mother live', 'are you from here', 'where are you from', 'have you always lived here', 'do you live alone'] },
  { id: 'ask_family',
    ex: ['tell me about your family', 'do you have a family', 'do you have brothers or sisters', 'do you have any siblings', 'who do you live with', 'how is your family', 'are your parents alive', 'do you have relatives here', 'what about your parents'] },
  { id: 'ask_partner', re: R(/\bare you married\b/, /\bdo you have a (husband|wife|boyfriend|girlfriend|partner)\b/),
    ex: ['are you married', 'do you have a boyfriend', 'do you have a girlfriend', 'is there someone special in your life', 'do you have a partner', 'who is your wife'] },
  { id: 'ask_children', re: R(/\bdo you have (any )?(children|kids|a son|a daughter)\b/),
    ex: ['do you have children', 'do you have kids', 'how many children do you have', 'are you a mother', 'are you a father', 'tell me about your kids'] },
  { id: 'ask_friends',
    ex: ['do you have friends', 'who are your friends', 'who is your best friend', 'do you know many people here', 'are you lonely', 'who do you hang out with'] },
  { id: 'ask_hobby', re: R(/\bwhat (are|is) your (hobby|hobbies|passion|passions|interests)\b/, /\bwhat (do|does) (you|he|she|your \w+) (like|love|enjoy) (to do|doing)\b/),
    ex: ['what are your hobbies', 'what do you like to do', 'what do you do for fun', 'do you have any hobbies', 'what are you interested in', 'what do you do in your free time', 'what are you passionate about', 'what does your brother like to do'] },
  { id: 'ask_like', re: R(/^do you (like|love|enjoy|hate|play|watch|follow|listen to|eat|drink) (?!me$)\w/),
    ex: ['do you like jazz', 'do you enjoy football', 'are you into cooking', 'how do you feel about cats', 'do you play chess', 'do you like pizza', 'do you follow football', 'are you a fan of opera', 'is jazz your thing', 'do you hate dogs', 'do you like it here', 'do you like the rain'] },
  { id: 'ask_favourite', re: R(/\b(what|which) is your favourite\b/, /\byour favourite \w+\b/),
    ex: ['what is your favourite food', 'which is your favourite colour', 'what music do you like best', 'what is your favourite season', 'who is your favourite team', 'what kind of films do you like', 'what do you like to eat', 'what do you like to drink', 'what animal do you like most', 'favourite place in the city'] },
  { id: 'ask_feel', re: R(/^are you (happy|sad|angry|upset|mad|bored|lonely|worried|nervous|cheerful|unhappy|depressed|in a good mood|in a bad mood)$/, /^you (look|seem) (sad|down|upset|unhappy|angry|worried|happy|cheerful|nervous|miserable|glum|grumpy|cross|annoyed|stressed|blue)( today)?$/),
    ex: ['are you happy', 'are you sad', 'why are you upset', 'are you angry with me', 'you seem down', 'is something wrong', 'you look worried', 'what is bothering you', 'are you in a good mood', 'you look happy today'] },
  { id: 'ask_scared', re: R(/^(are|are not) you (scared|afraid|frightened|terrified)( of (the|those|these|that) \w+.*)?$/),
    ex: ['are you scared', 'are you afraid of the monsters', 'what are you afraid of', 'does this place scare you', 'are you frightened', 'do you feel safe', 'what scares you'] },
  { id: 'ask_need', re: R(/^are you (hungry|tired|thirsty|sleepy|exhausted|starving)$/, /^you (look|seem) (tired|hungry|exhausted|sleepy|worn out)$/),
    ex: ['are you hungry', 'are you tired', 'do you need anything', 'have you eaten', 'do you need a rest', 'what do you need', 'is there anything you need', 'you look tired'] },
  { id: 'ask_plans', re: R(/^where (are|r) you (going|headed|heading|off to|walking)( now| today| to)?$/),
    ex: ['where are you going', 'what are you doing here', 'what are you up to', 'what are your plans today', 'where are you headed', 'are you on your way home', 'what will you do tonight', 'why are you here', 'what are you doing today', 'what brings you to this street', 'what are you doing out here'] },
  { id: 'ask_about',
    ex: ['tell me about yourself', 'who are you really', 'what is your story', 'tell me something about you', 'what kind of person are you', 'describe yourself', 'I want to know more about you', 'tell me about your brother', 'what is your mother like'] },
  { id: 'ask_opinion', re: R(/^(what do you think|how do you feel|what is your opinion) (of|about|on) (?!(me|myself|this (city|town)|the (city|town))$)\w/),
    ex: ['what do you think of the police', 'what do you think about the army', 'how do you feel about the gangs', 'what is your opinion of the mayor', 'what do you make of the giant worm', 'are the police any good', 'what do you think of this city', 'what do you think of your neighbours', 'is the army helping', 'what do you think about superheroes'] },
  { id: 'ask_know', re: R(/^do you know (a |an )?[a-z]+( [a-z]+)?$/, /^have you (met|heard of|heard about) \w/),
    ex: ['do you know Mara', 'have you met Tomas', 'do you know anyone called Vera', 'do you know the boss of the gang', 'have you heard of Viktor', 'is Mara a friend of yours', 'who is Tomas'] },

  // ------------------------------------------------------------------ the world
  { id: 'ask_news', re: R(/\b(any|what is the|whats the|heard any) (news|gossip)\b/, /^what is (new|going on|happening)( around here| here| today| lately| in town| in the city)?$/),
    ex: ['what is going on around here', 'any news', 'what is new', 'heard any gossip', 'what happened today', 'anything interesting happening', 'what is the latest', 'tell me the news', 'what is happening in the city', 'did anything happen lately'] },
  { id: 'ask_where', re: R(/^(where is|where are|where can i find|how do i get to|how can i get to|which way (is|to)|show me the way to|take me to|directions to|the way to|way to) (?!(you|your|we|i|my|they|he|she)\b)\w/),
    ex: ['where is the museum', 'how do I get to the station', 'which way to the cathedral', 'can you show me the way to the town hall', 'is the stadium far', 'where can I find a metro station', 'where is Linden Street', 'how far is the airport', 'I am looking for the big wheel', 'where can I find the hospital', 'is there a station nearby', 'where can I get something to eat'] },
  { id: 'ask_safe', re: R(/\bis (it|this|this area|this street|this place|the neighbourhood|here) (safe|dangerous)\b/),
    ex: ['is it safe here', 'is this a dangerous area', 'is there much crime around here', 'should I be careful here', 'is this neighbourhood safe at night', 'is it a good area', 'are the streets safe'] },
  { id: 'ask_gang', re: R(/\bwho (runs|controls|owns|rules) (this|the) (street|area|place|neighbourhood|district|block)\b/),
    ex: ['who runs this street', 'is there a gang here', 'who controls this area', 'are there criminals around', 'who is the boss around here', 'tell me about the gang', 'where is their hideout', 'where can I find the boss', 'who are the bad guys here', 'is there organised crime here'] },
  { id: 'ask_weather', re: R(/\b(how is|what is|nice|lovely|bad|terrible|awful|horrible|crazy) (the )?weather\b/, /\bis it (going to )?(rain|raining|snow|snowing|storm)\b/),
    ex: ['nice weather today', 'what is the weather like', 'is it going to rain', 'lovely day, is it not', 'terrible weather', 'it is cold today', 'what a storm', 'do you like the rain', 'hot today, is it not'] },
  { id: 'ask_time', re: R(/^(what time is it|what is the time|do you have the time|what day is it|what is the date)$/),
    ex: ['what time is it', 'do you know the time', 'what day is it today', 'is it late', 'is it morning yet'] },
  { id: 'ask_threat',
    ex: ['did you see the monster', 'what happened with the giant worm', 'were you here when the robot attacked', 'have you seen any monsters', 'are the aliens dangerous', 'what was that thing in the river', 'did you see the giant bird', 'what about the creature', 'tell me about the attack'] },
  { id: 'ask_place', re: R(/^(where am i|where are we|what street is this|what is this (street|place|area|neighbourhood|district)|what is this place called)$/),
    ex: ['where am I', 'what street is this', 'what is this neighbourhood called', 'what part of town is this', 'what is this place', 'where are we right now'] },
  { id: 'ask_city', re: R(/^(what is (this|the) (city|town)|what (city|town) is this|what is the name of (this|the) (city|town))( called)?$/, /^(what do you think|how do you feel|what is your opinion) (of|about|on) (this|the) (city|town)$/),
    ex: ['what is this city called', 'tell me about the city', 'do you like living in this city', 'what is special about this town', 'is this a good city', 'how is life in the city'] },
  { id: 'ask_trouble',
    ex: ['is anyone in trouble', 'does anyone need help around here', 'have you seen any crimes', 'is there anything I can do around here', 'where can I help', 'any trouble nearby', 'where is the crime happening', 'anything going wrong around here'] },

  // ------------------------------------------------------------------ telling them
  { id: 'tell_name', re: R(/^(my name is|i am called|call me|people call me|they call me|the name is|my names) [a-z]+( [a-z]+)?$/),
    ex: ['my name is Nova', 'I am called Max', 'call me Blaze', 'people call me the Comet', 'you can call me Sam', 'the name is Bond'] },
  { id: 'tell_like', re: R(/^i (really |really do |do |totally )?(like|love|enjoy|adore|dig) (?!you\b)\w/, /^i am (really |totally |very much |a big |a huge |such a )?(into|a fan of|fan of) \w/),
    ex: ['I like jazz', 'I love football', 'I am into cooking', 'I enjoy chess', 'I am a big fan of opera', 'my favourite food is pizza', 'I play video games', 'I collect stamps', 'I like it here'] },
  { id: 'tell_dislike', re: R(/^i (really )?(hate|dislike|can not stand|do not like|detest) \w/),
    ex: ['I hate football', 'I do not like jazz', 'I can not stand the rain', 'opera is boring', 'I dislike crowds', 'I hate this city'] },
  { id: 'tell_feel', re: R(/^i (am|feel|am feeling) (so |really |very |a bit |quite |kind of )?(tired|sad|happy|bored|lonely|hungry|angry|scared|exhausted|fine|good|great|okay|well|depressed|excited|lost|confused|hurt|awful|terrible|down|sick|ill)( today| now)?$/),
    ex: ['I am tired', 'I feel sad today', 'I am happy', 'I am bored', 'I feel lonely', 'I had a bad day', 'I am lost', 'I am hungry', 'I am doing great', 'I feel awful'] },
  { id: 'tell_hero',
    ex: ['I am a superhero', 'I can fly', 'I am the hero of this city', 'I protect this city', 'I fight crime', 'I have super powers', 'I am stronger than anyone', 'I saved a lot of people', 'I am new in town', 'I just arrived here', 'this is my first day in the city'] },

  // ------------------------------------------------------------------ asking of them
  { id: 'offer_help', re: R(/^(can|may|could) i help( you)?$/, /^(do you )?need (any |some )?help$/, /^can i do anything for you$/),
    ex: ['can I help you', 'do you need help', 'can I do anything for you', 'is there something I can do for you', 'do you need a favour', 'let me help you', 'how can I help'] },
  { id: 'ask_help',
    ex: ['can you help me', 'I need your help', 'will you help me', 'could you do me a favour', 'help me please', 'I need something from you', 'would you do something for me', 'I could use a hand'] },
  { id: 'req_leave', re: R(/^(go home|run|get out of here|leave|go away|get lost|clear off|move along|run away|get to safety|get inside|take cover|hide)( now| quickly| please)?$/),
    ex: ['go home', 'get out of here, it is not safe', 'you should leave', 'run, quickly', 'go away', 'get to safety', 'take cover', 'go inside', 'you need to get away from here'] },
  { id: 'req_calm',
    ex: ['calm down', 'take a deep breath', 'relax', 'do not panic', 'stay calm', 'chill out'] },

  // ------------------------------------------------------------------ the conversation
  { id: 'why', re: R(/^(why|why not|how come|why is that|why so|what for|why would you say that|why do you say that)$/),
    ex: ['why', 'why is that', 'how come', 'what makes you say that', 'why not'] },
  { id: 'more', re: R(/^(tell me more|go on|and|and then|more|what else|anything else|continue|keep going|go ahead|and so|so)$/),
    ex: ['tell me more', 'go on', 'what else', 'and then?', 'anything else', 'please continue', 'I want to hear more'] },
  { id: 'really', re: R(/^(really|seriously|are you sure|is that so|is that true|no way|you are kidding|you are joking|for real|honestly)$/),
    ex: ['really?', 'are you serious', 'is that true', 'you are kidding me', 'for real?', 'I do not believe you'] },
  { id: 'you_too', re: R(/^(and you|what about you|how about you|you|yourself|and yourself|same to you|you too)$/),
    ex: ['and you?', 'what about you', 'how about yourself', 'you too', 'same question to you'] },
  { id: 'what_can_i_say', re: R(/^(help|what can i (ask|say)|what can we talk about|what should i ask|what do you know|what can you tell me)$/),
    ex: ['what can I ask you', 'what can we talk about', 'what do you know about', 'what should I say', 'help', 'what topics do you know'] },
  { id: 'repeat', re: R(/^(what|pardon|come again|say again|sorry what|huh|eh|excuse me what|what did you say|say that again|repeat that)$/),
    ex: ['what did you say', 'pardon?', 'come again?', 'can you repeat that', 'huh?', 'say that again'] },
];

/** Intents by id. */
export const INTENT: ReadonlyMap<Intent, IntentDef> = new Map(INTENTS.map((d) => [d.id, d]));
