/**
 * Typed lines the way players type them, with what they mean: the self test's measure of how
 * well the chat understands (tools/chatTest.ts). None of these are examples in intents.ts, so the
 * score is honest; when a line from the misunderstanding log gets fixed, it goes here.
 *
 * Pure data.
 */
import type { Intent } from './intents';

export const CORPUS: readonly [string, Intent][] = [
  // social
  ['Hello there!', 'greet'], ['heyyy', 'greet'], ['hiya mate', 'greet'], ['good afternoon', 'greet'], ['yo whats up', 'greet'], ['hey, nice to see you', 'greet'],
  ['Hi! How are you?', 'how_are_you'], ['how r u', 'how_are_you'], ['how are you feeling', 'how_are_you'], ['hows it going', 'how_are_you'], ['you doing ok?', 'how_are_you'], ['How\'s your day been?', 'how_are_you'],
  ['bye!', 'bye'], ['see ya later', 'bye'], ['ok gotta go', 'bye'], ['I must be going now', 'bye'], ['laters', 'bye'], ['have a good one', 'bye'],
  ['thanks!', 'thanks'], ['thx', 'thanks'], ['thank you so much for your help', 'thanks'], ['that was helpful, thanks', 'thanks'],
  ['sorry about that', 'sorry'], ['I\'m really sorry I knocked you down', 'sorry'], ['oops, my bad', 'sorry'], ['I didn\'t mean it', 'sorry'],
  ['you\'re really nice', 'compliment'], ['love your jacket', 'compliment'], ['you seem cool', 'compliment'], ['you\'re a good person', 'compliment'],
  ['you are so stupid', 'insult'], ['shut up already', 'insult'], ['ur boring', 'insult'], ['nobody likes you', 'insult'], ['you\'re a waste of space', 'insult'],
  ['I\'m going to crush you', 'threat'], ['give me all your money', 'threat'], ['I could squash you right now', 'threat'], ['do as I say or you\'ll regret it', 'threat'],
  ['know any good jokes?', 'joke'], ['tell me something funny', 'joke'], ['make me laugh please', 'joke'],
  ['ur cute', 'flirt'], ['wanna grab a coffee with me sometime?', 'flirt'], ['are you seeing anyone?', 'flirt'],
  ['lol', 'laugh'], ['hahaha good one', 'laugh'],
  ['yeah', 'yes'], ['yes I do', 'yes'], ['sure thing', 'yes'], ['of course!', 'yes'],
  ['nah', 'no'], ['no not really', 'no'], ['nope', 'no'],
  ['idk', 'dunno'], ['no clue', 'dunno'],
  ['ok', 'okay'], ['i see', 'okay'], ['cool cool', 'okay'],
  ['don\'t be afraid, you\'re safe', 'reassure'], ['it\'s over now, relax', 'reassure'], ['I\'ll keep you safe', 'reassure'],
  // about them
  ['whats ur name', 'ask_name'], ['who are u', 'ask_name'], ['what\'s your name again?', 'ask_name'], ['may I know your name?', 'ask_name'], ['what\'s your brother\'s name?', 'ask_name'],
  ['how old r u', 'ask_age'], ['what age are you', 'ask_age'], ['how old is your dad?', 'ask_age'],
  ['what do u do for work', 'ask_job'], ['what\'s your job?', 'ask_job'], ['what does your wife do?', 'ask_job'], ['do you have a job', 'ask_job'], ['are you a student?', 'ask_job'],
  ['where do you work?', 'ask_work_where'], ['where\'s your workplace', 'ask_work_where'],
  ['where do u live', 'ask_home'], ['do you live nearby?', 'ask_home'], ['where\'s your home', 'ask_home'], ['are you from around here?', 'ask_home'], ['where does your sister live?', 'ask_home'],
  ['tell me about ur family', 'ask_family'], ['do you have any brothers or sisters?', 'ask_family'], ['how\'s the family?', 'ask_family'], ['who lives with you?', 'ask_family'],
  ['are u married', 'ask_partner'], ['got a girlfriend?', 'ask_partner'], ['do you have a husband?', 'ask_partner'],
  ['do you have kids?', 'ask_children'], ['any children?', 'ask_children'],
  ['who\'s your best friend?', 'ask_friends'], ['do you have many friends?', 'ask_friends'],
  ['what are your hobbies?', 'ask_hobby'], ['what do you do for fun?', 'ask_hobby'], ['what are you into?', 'ask_hobby'], ['any hobbies?', 'ask_hobby'], ['what does your son like doing?', 'ask_hobby'],
  ['do you like jazz?', 'ask_like'], ['do u like pizza', 'ask_like'], ['are you a football fan?', 'ask_like'], ['do you like cats or dogs?', 'ask_like'], ['you like opera?', 'ask_like'], ['do you enjoy living here?', 'ask_like'],
  ['what\'s your favorite food', 'ask_favourite'], ['favourite colour?', 'ask_favourite'], ['what music do you listen to?', 'ask_favourite'], ['which season do you like best?', 'ask_favourite'], ['what\'s your fav movie', 'ask_favourite'],
  ['are you happy?', 'ask_feel'], ['you look sad', 'ask_feel'], ['is everything ok with you?', 'ask_feel'], ['what\'s wrong?', 'ask_feel'],
  ['are you scared of the monsters?', 'ask_scared'], ['aren\'t you afraid?', 'ask_scared'], ['do you feel safe here?', 'ask_scared'],
  ['are you hungry?', 'ask_need'], ['you look exhausted', 'ask_need'], ['have you had lunch?', 'ask_need'],
  ['where are you going?', 'ask_plans'], ['what are you up to today?', 'ask_plans'], ['where you headed?', 'ask_plans'], ['what brings you here?', 'ask_plans'],
  ['tell me about you', 'ask_about'], ['so what\'s your story?', 'ask_about'], ['tell me more about yourself', 'ask_about'], ['what\'s your mum like?', 'ask_about'],
  ['what do you think about the cops?', 'ask_opinion'], ['what\'s your opinion on the army?', 'ask_opinion'], ['how do you feel about the aliens?', 'ask_opinion'], ['are the police doing a good job?', 'ask_opinion'], ['what do you think of the mayor', 'ask_opinion'],
  ['do you know Tomas?', 'ask_know'], ['have you heard of Viktor Hale?', 'ask_know'], ['who is Mara?', 'ask_know'],
  // the world
  ['what\'s going on?', 'ask_news'], ['anything happening around here?', 'ask_news'], ['any gossip?', 'ask_news'], ['what\'s new in town', 'ask_news'], ['heard anything interesting?', 'ask_news'],
  ['where is the cathedral?', 'ask_where'], ['how do i get to the museum', 'ask_where'], ['where\'s the nearest metro?', 'ask_where'], ['which way is the stadium', 'ask_where'], ['can you point me to the town hall', 'ask_where'], ['where can I eat around here?', 'ask_where'], ['is there a station near here?', 'ask_where'],
  ['is it dangerous here?', 'ask_safe'], ['is this neighborhood safe', 'ask_safe'], ['lots of crime around here?', 'ask_safe'], ['should i be careful around here', 'ask_safe'],
  ['who runs this place?', 'ask_gang'], ['are there gangs around here?', 'ask_gang'], ['who\'s in charge of this street?', 'ask_gang'], ['where do the gang hang out?', 'ask_gang'], ['who is the local boss', 'ask_gang'],
  ['nice day isn\'t it', 'ask_weather'], ['looks like rain', 'ask_weather'], ['what a horrible weather', 'ask_weather'], ['it\'s so hot today', 'ask_weather'],
  ['what time is it?', 'ask_time'], ['do you know what time it is?', 'ask_time'],
  ['did you see the giant worm?', 'ask_threat'], ['what happened with the monster?', 'ask_threat'], ['were you here during the attack?', 'ask_threat'], ['have you seen the robot thing?', 'ask_threat'],
  ['where are we?', 'ask_place'], ['what\'s this street called?', 'ask_place'], ['what area is this?', 'ask_place'],
  ['what\'s the name of this city?', 'ask_city'], ['what do you think of this town', 'ask_city'], ['is it nice living in this city?', 'ask_city'],
  ['is anybody in trouble around here?', 'ask_trouble'], ['seen any crime lately?', 'ask_trouble'], ['anyone need my help?', 'ask_trouble'],
  // the hero
  ['what do u think of me', 'ask_me'], ['do you like me?', 'ask_me'], ['am i a good hero?', 'ask_me'], ['what do people think of me?', 'ask_me'], ['are you scared of me?', 'ask_me'],
  ['do you remember me?', 'ask_know_me'], ['have we met?', 'ask_know_me'], ['you know who I am?', 'ask_know_me'], ['do you recognize me', 'ask_know_me'],
  ['what\'s my name?', 'ask_my_name'], ['do you remember what my name is?', 'ask_my_name'],
  // telling them
  ['my name is Nova', 'tell_name'], ['I\'m Nova', 'tell_name'], ['call me Captain Spark', 'tell_name'], ['they call me Zephyr', 'tell_name'],
  ['I love jazz', 'tell_like'], ['i like football', 'tell_like'], ['I\'m really into chess', 'tell_like'], ['I like your city', 'tell_like'],
  ['i hate rain', 'tell_dislike'], ['I don\'t like opera', 'tell_dislike'], ['I can\'t stand spiders', 'tell_dislike'],
  ['i\'m tired', 'tell_feel'], ['I\'m sad today', 'tell_feel'], ['I feel great', 'tell_feel'], ['i\'m bored', 'tell_feel'], ['I\'m a bit lost', 'tell_feel'],
  ['I\'m a superhero', 'tell_hero'], ['I can fly, you know', 'tell_hero'], ['I protect this city', 'tell_hero'], ['I\'m new around here', 'tell_hero'],
  // asking of them
  ['can i help you with anything?', 'offer_help'], ['need any help?', 'offer_help'], ['is there anything I can do for you?', 'offer_help'],
  ['can you help me?', 'ask_help'], ['I need a favour', 'ask_help'],
  ['get out of here!', 'req_leave'], ['go home, it\'s dangerous', 'req_leave'], ['run!', 'req_leave'], ['you should get inside', 'req_leave'],
  ['calm down', 'req_calm'], ['just breathe', 'req_calm'],
  // the conversation
  ['why?', 'why'], ['why is that?', 'why'], ['how come?', 'why'],
  ['tell me more', 'more'], ['go on', 'more'], ['and?', 'more'], ['what else?', 'more'],
  ['really?', 'really'], ['seriously?', 'really'], ['no way!', 'really'],
  ['and you?', 'you_too'], ['what about you?', 'you_too'], ['you?', 'you_too'],
  ['what can I ask you?', 'what_can_i_say'], ['what do you know?', 'what_can_i_say'],
  ['what?', 'repeat'], ['huh?', 'repeat'], ['come again?', 'repeat'],
];
