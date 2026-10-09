/**
 * What people answer in typed chat, as rules like the menu's lines (lines.ts): every entry has
 * criteria over the talk facts and a few ways to say it, the most specific match wins (talk.ts
 * `pickLine`). The chat sets `flags` for what the answer is about ("kin", "love", "f_police",
 * "seen" …) and fills its own tokens after the menu's:
 *
 *  {age} their age · {home} {work} the streets they live and work on · {kname} {kfull} {kword}
 *  {kjob} {kajob} {kint} {kage} {khome} someone close to them · {kpro} {kpos} he/she, his/her ·
 *  {thing} what you asked about · {fav} their favourite · {cat} its category · {list} several
 *  people · {other} a name you said · {fac} a side of the city · {threat} {ago} {where} a big
 *  threat · {next} where they are going · {clock} the time · {heroname} your name ·
 *  {old} the name they knew · {why} a reason
 *
 * A capital first letter in a token ({Kname}, {Thing}) capitalises the value.
 *
 * Pure data.
 */
import type { LineEntry } from '../lines';

const S = (...say: string[]) => say;

export type ChatTopic =
  | 'name' | 'name_kin' | 'no_kin' | 'age' | 'age_kin' | 'job_kin' | 'work' | 'work_kin' | 'home' | 'home_kin' | 'family' | 'partner' | 'children' | 'friends'
  | 'hobby_kin' | 'like' | 'fav' | 'scared' | 'need' | 'plans' | 'about' | 'about_kin' | 'opinion' | 'know' | 'safe' | 'gang' | 'weather' | 'time' | 'threat'
  | 'here' | 'city' | 'trouble' | 'where_none' | 'know_me' | 'my_name' | 'tell_name' | 'tell_like' | 'tell_feel' | 'tell_hero' | 'ask_help' | 'leave' | 'calm'
  | 'reassure' | 'compliment' | 'insult' | 'threatened' | 'joke' | 'flirt' | 'laugh' | 'thanks' | 'sorry' | 'greet_again' | 'yes' | 'no' | 'dunno' | 'okay'
  | 'answer_yes' | 'answer_no' | 'answer_name' | 'why' | 'really' | 'what_can' | 'unclear' | 'patience' | 'ask_back';

export const CHAT: Record<ChatTopic, readonly LineEntry[]> = {
  // ------------------------------------------------------------------ who they are
  name: [
    { id: 'cn0', when: {}, say: S('{first}. {full}.', 'I\'m {first}.', 'The name\'s {first} {last}.') },
    { id: 'cn1', when: { met: true }, say: S('{first}! We\'ve met, remember?', 'Still {first}. Same as last time.') },
    { id: 'cn2', when: { temper: ['grumpy'] }, say: S('{last}. Why?', '{first}. Happy now?') },
    { id: 'cn3', when: { temper: ['shy'] }, say: S('Oh, um… {first}.', 'I\'m {first}. Sorry, I should have said.') },
    { id: 'cn4', when: { temper: ['proud'] }, say: S('{full}. Remember it.', '{full}, at your service. More or less.') },
    { id: 'cn5', when: { child: true }, say: S('{first}! What\'s yours?', 'I\'m {first} and my best colour is {fav}.') },
    { id: 'cn6', when: { temper: ['chatty'] }, say: S('{first}! Well, {first} {last}, but only my mother says the whole thing.') },
    { id: 'cn7', when: { op: [-100, -30] }, say: S('Why do you want to know?', 'I\'d rather not say. No offence.') },
  ],
  name_kin: [
    { id: 'cnk0', when: { flag: ['kin'] }, say: S('My {kword}? {Kname}.', '{Kfull}. That\'s my {kword}.', '{Kname}. Why do you ask?') },
    { id: 'cnk1', when: { flag: ['kin', 'many'] }, say: S('{List}.', 'That would be {list}.') },
  ],
  no_kin: [
    { id: 'cnn0', when: {}, say: S('I don\'t have a {kword}.', 'No {kword}, I\'m afraid.', 'There\'s no {kword} in my life.') },
    { id: 'cnn1', when: { flag: ['partner'] }, say: S('No {kword}. Not at the moment, anyway.', 'Single. Thanks for reminding me.') },
    { id: 'cnn2', when: { flag: ['partner'], child: true }, say: S('Ew! I\'m only {age}!', 'I\'m a kid! Gross.') },
    { id: 'cnn3', when: { flag: ['children'], child: true }, say: S('I AM a kid!', 'Kids? I\'m {age}!') },
    { id: 'cnn4', when: { flag: ['children'] }, say: S('No children.', 'No kids. Not yet, maybe never.', 'No little ones, no.') },
    { id: 'cnn5', when: { flag: ['children'], senior: true }, say: S('We never had children. It just never happened.') },
  ],
  age: [
    { id: 'ca0', when: {}, say: S('I\'m {age}.', '{age}.', '{age}, since you ask.') },
    { id: 'ca1', when: { temper: ['grumpy', 'proud'] }, say: S('Old enough.', 'That\'s a rude question.', 'Old enough to know better than to answer.') },
    { id: 'ca2', when: { senior: true }, say: S('{age}, and every year of it in my knees.', '{age}. I remember when this was all fields. Well, car parks.') },
    { id: 'ca3', when: { child: true }, say: S('{age}! Well, {age} and a half.', 'I\'m {age}. How old are YOU?') },
    { id: 'ca4', when: { temper: ['cheerful', 'chatty'] }, say: S('{age} and feeling twenty!', '{age}. Don\'t tell anyone.') },
  ],
  age_kin: [
    { id: 'cak0', when: {}, say: S('{Kname}? {Kpro}\'s {kage}.', '{Kname} is {kage}.', '{kage}, I think. Or is it {kage1}? {kage}.') },
  ],
  job_kin: [
    { id: 'cj0', when: {}, say: S('{Kname} is {kajob}.', '{Kname}? {Kajob}. {Kpro} loves {kint}, though.', '{Kpro}\'s {kajob}.') },
    { id: 'cj1', when: { flag: ['kpupil'] }, say: S('{Kname} is still at school.', '{Kname} goes to school. Mostly.') },
    { id: 'cj2', when: { flag: ['kretired'] }, say: S('{Kname} is retired. Busier than ever, apparently.', '{Kname} retired years ago.') },
  ],
  work: [
    { id: 'cw0', when: { flag: ['work'] }, say: S('On {work}.', 'Over on {work}. Not far.', 'I work on {work}.') },
    { id: 'cw1', when: { flag: ['work', 'workhere'] }, say: S('Right here on {work}!', 'Just round the corner, here on {work}.') },
    { id: 'cw2', when: { job: ['pupil'] }, say: S('I go to school! It\'s boring.', 'At school. Where else?') },
    { id: 'cw3', when: { job: ['retired'] }, say: S('Work? I\'m retired, dear. I did my forty years.', 'Nowhere, thank goodness. I\'m retired.') },
    { id: 'cw4', when: { job: ['home'] }, say: S('From home, mostly.', 'At home. The commute is great.') },
    { id: 'cw5', when: { job: ['student'] }, say: S('At the university, in theory.', 'I study. Well, I go to lectures. Sometimes.') },
    { id: 'cw6', when: { job: ['street'] }, say: S('Right here. The street is my stage!', 'Wherever the crowd is.') },
    { id: 'cw7', when: { flag: ['nowork'] }, say: S('Here and there.', 'Oh, all over the city.') },
  ],
  work_kin: [
    { id: 'cwk0', when: { flag: ['kwork'] }, say: S('{Kname} works on {kwork}.', 'On {kwork}, I think.') },
    { id: 'cwk1', when: {}, say: S('I\'m not sure where {Kname} works these days.', 'Somewhere across town.') },
  ],
  home: [
    { id: 'ch0', when: { flag: ['home'] }, say: S('On {home}.', 'Over on {home}.', 'I live on {home}.') },
    { id: 'ch1', when: { flag: ['home', 'homehere'] }, say: S('Right here on {home}!', 'Just there. I can see my window from here.') },
    { id: 'ch2', when: { flag: ['home'], temper: ['shy', 'anxious'] }, say: S('Not far. I\'d rather not say exactly.', 'Around here. Sorry, I don\'t give out my address.') },
    { id: 'ch3', when: { flag: ['home'], op: [-100, -20] }, say: S('Why would I tell you that?', 'Nice try.') },
    { id: 'ch4', when: { flag: ['home'], temper: ['chatty', 'cheerful'] }, say: S('On {home}! Second floor, the window with all the plants.', '{Home}. Lovely street, terrible parking.') },
    { id: 'ch5', when: { flag: ['nohome'] }, say: S('Out of town. It\'s a long ride in.', 'Far from here. I come in for work.') },
  ],
  home_kin: [
    { id: 'chk0', when: { flag: ['kwithme'] }, say: S('{Kname} lives with me.', 'Same place as me. Under one roof, for better or worse.') },
    { id: 'chk1', when: { flag: ['khome'] }, say: S('{Kname} lives on {khome}.', 'Over on {khome}.') },
    { id: 'chk2', when: {}, say: S('Across town. We don\'t see each other as often as we should.') },
  ],
  family: [
    { id: 'cf0', when: { flag: ['many'] }, say: S('There\'s {list}.', 'Well, {list}.', 'Let\'s see: {list}.') },
    { id: 'cf1', when: { flag: ['many'], temper: ['chatty', 'cheerful', 'kind'] }, say: S('Oh, there\'s {list}. We\'re a noisy bunch!', 'There\'s {list}. I could show you photos!') },
    { id: 'cf2', when: { flag: ['many'], temper: ['grumpy'] }, say: S('{List}. They\'re fine.', 'Family. {List}. Next question.') },
    { id: 'cf3', when: { flag: ['none'] }, say: S('It\'s just me.', 'No family here. It\'s me and my plants.', 'Just me. I like it quiet.') },
    { id: 'cf4', when: { flag: ['none'], temper: ['anxious', 'shy'] }, say: S('It\'s… just me, really.') },
  ],
  partner: [
    { id: 'cp0', when: { flag: ['kin'] }, say: S('Yes, {kname}. My {kword}.', 'Married to {kname}. Happily, mostly.', '{Kname}. Best thing that ever happened to me.') },
    { id: 'cp1', when: { flag: ['kin'], temper: ['grumpy'] }, say: S('{Kname}. Don\'t get me started.', 'Yes. {Kname}. Why?') },
  ],
  children: [
    { id: 'cc0', when: { flag: ['kin'] }, say: S('Yes, {list}.', '{List}. They keep me busy!', 'I do: {list}.') },
    { id: 'cc1', when: { flag: ['kin'], senior: true }, say: S('{List}. All grown up now.', 'Oh yes, {list}. And grandchildren on the way, I hope.') },
  ],
  friends: [
    { id: 'cfr0', when: { flag: ['kin'] }, say: S('{List}, mostly.', 'My best friend is {kname}.', 'There\'s {list}. Good people.') },
    { id: 'cfr1', when: { flag: ['none'] }, say: S('Not many, to be honest.', 'A few. Fewer since I moved.', 'Friends are hard to make in a city this big.') },
    { id: 'cfr2', when: { flag: ['none'], temper: ['chatty', 'cheerful'] }, say: S('Everybody is my friend! Well, nobody special.') },
    { id: 'cfr3', when: { flag: ['none'], need: 'lonely' }, say: S('Not really. That\'s why I\'m out here, I suppose.') },
  ],
  hobby_kin: [
    { id: 'chb0', when: {}, say: S('{Kname}? {Kint}. Never shuts up about it.', '{Kname} loves {kint}.', '{Kint}, mostly.') },
  ],

  // ------------------------------------------------------------------ likes
  like: [
    { id: 'cl0', when: { flag: ['love'] }, say: S('{Thing}? I love {thing}!', 'Oh, I adore {thing}.', '{Thing}! Yes! Very much.') },
    { id: 'cl1', when: { flag: ['like'] }, say: S('{Thing}? Yes, I like {thing}.', 'Sure, {thing} is nice.', 'I do, actually.') },
    { id: 'cl2', when: { flag: ['meh'] }, say: S('{Thing}? It\'s all right.', 'Not really my thing, but I don\'t mind {thing}.', 'Meh. Sometimes.') },
    { id: 'cl3', when: { flag: ['dislike'] }, say: S('Not really.', '{Thing}? Not my cup of tea.', 'I can take it or leave it. Mostly leave it.') },
    { id: 'cl4', when: { flag: ['hate'] }, say: S('{Thing}? Can\'t stand it.', 'Ugh, no. I hate {thing}.', 'Don\'t get me started on {thing}.') },
    { id: 'cl5', when: { flag: ['love', 'mine'] }, say: S('Do I like {thing}? It\'s my life!', '{Thing} is my absolute favourite thing in the world.', 'Ha! You\'ve found my weak spot. {Thing}!') },
    { id: 'cl6', when: { flag: ['love'], temper: ['grumpy'] }, say: S('{Thing}. Yes. Fine. I like {thing}. Don\'t tell anyone.') },
    { id: 'cl7', when: { flag: ['hate'], temper: ['kind'] }, say: S('I\'m afraid {thing} isn\'t for me.') },
    { id: 'cl8', when: { flag: ['love'], child: true }, say: S('YES! {Thing} is the best!', 'I love {thing} so much!') },
    { id: 'cl9', when: { flag: ['hate'], child: true }, say: S('Yuck! {Thing} is the worst!', 'Eww, no!') },
    { id: 'cl10', when: { flag: ['kinsubj', 'love'] }, say: S('{Kname}? Loves {thing}.', 'Oh, {kname} adores {thing}.') },
    { id: 'cl11', when: { flag: ['kinsubj', 'like'] }, say: S('I think {kname} likes {thing}, yes.') },
    { id: 'cl12', when: { flag: ['kinsubj', 'meh'] }, say: S('{Kname}? Not bothered either way, I think.') },
    { id: 'cl13', when: { flag: ['kinsubj', 'dislike'] }, say: S('Not really, no.') },
    { id: 'cl14', when: { flag: ['kinsubj', 'hate'] }, say: S('{Kname} hates {thing}. Don\'t mention it at dinner.') },
    { id: 'cl15', when: { flag: ['what'] }, say: S('Do I like what?', 'Like what, sorry?') },
  ],
  fav: [
    { id: 'cv0', when: {}, say: S('{Fav}.', '{Fav}, definitely.', 'Hmm. {Fav}, I\'d say.', 'Easy. {Fav}.') },
    { id: 'cv1', when: { temper: ['dreamy'] }, say: S('Oh, {fav}. There\'s something about {fav}.') },
    { id: 'cv2', when: { temper: ['grumpy'] }, say: S('{Fav}. If I have to pick.') },
    { id: 'cv3', when: { child: true }, say: S('{Fav}!!', '{Fav}! Obviously!') },
    { id: 'cv4', when: { flag: ['mine'] }, say: S('{Fav}, of course! Ask anyone.', '{Fav}. It\'s my whole thing.') },
    { id: 'cv5', when: { flag: ['nocat'] }, say: S('My favourite? Hard to pick.', 'I don\'t really have a favourite.', 'Oh, I couldn\'t choose.') },
  ],

  // ------------------------------------------------------------------ feelings, needs, plans
  scared: [
    { id: 'cs0', when: { flag: ['scared'] }, say: S('Terrified, if I\'m honest.', 'Yes. Every time something big comes, I think: this is it.', 'Of course I am. Aren\'t you?') },
    { id: 'cs1', when: { flag: ['calm'] }, say: S('Scared? No. You get used to it here.', 'Not really. Worrying doesn\'t help.', 'Nah. I\'ve seen worse.') },
    { id: 'cs2', when: { flag: ['scared'], trouble: true }, say: S('After what just happened? I\'m shaking.', 'My hands are still shaking.') },
    { id: 'cs3', when: { flag: ['calm'], op: [30, 100] }, say: S('Not with you around.', 'Not while you\'re in town.') },
    { id: 'cs4', when: { flag: ['scared'], child: true }, say: S('A bit. But I\'m brave! Mostly.') },
    { id: 'cs5', when: { flag: ['scared'], temper: ['anxious'] }, say: S('Scared of everything. Monsters, gangs, my landlord…') },
  ],
  need: [
    { id: 'cne0', when: { need: 'hunger' }, say: S('Starving, actually.', 'I could eat a horse.', 'Now that you mention it… yes. Very hungry.') },
    { id: 'cne1', when: { need: 'tired' }, say: S('Exhausted. I need my bed.', 'Tired. So tired.', 'I could sleep standing up.') },
    { id: 'cne2', when: { need: 'lonely' }, say: S('Just a bit of company, maybe.', 'Someone to talk to. This is nice, actually.') },
    { id: 'cne3', when: { flag: ['fine'] }, say: S('No, I\'m fine, thanks.', 'Nothing, thank you. Kind of you to ask.', 'I\'ve got everything I need.') },
    { id: 'cne4', when: { flag: ['fine'], temper: ['grumpy'] }, say: S('A bit of peace and quiet.', 'Less chatting, more walking.') },
  ],
  plans: [
    { id: 'cpl0', when: { flag: ['to_home'] }, say: S('Home. Finally.', 'On my way home.', 'Home, to put my feet up.') },
    { id: 'cpl1', when: { flag: ['to_work'] }, say: S('To work. Don\'t remind me.', 'Work. Off to earn my keep.') },
    { id: 'cpl2', when: { flag: ['to_shop'] }, say: S('Just some shopping.', 'Off to the shops. We\'re out of everything.') },
    { id: 'cpl3', when: { flag: ['to_food'] }, say: S('To get something to eat.', 'Lunch! Or a snack. Something with food in it.') },
    { id: 'cpl4', when: { flag: ['to_park'] }, say: S('To the park, for some air.', 'Just a walk in the park.') },
    { id: 'cpl5', when: { flag: ['to_school'] }, say: S('School. Ugh.', 'To school. I\'m late!') },
    { id: 'cpl6', when: { flag: ['to_leisure'] }, say: S('Meeting some friends.', 'Out. Just out. It\'s my free time!') },
    { id: 'cpl7', when: { flag: ['to_none'] }, say: S('Nowhere special.', 'Just wandering.', 'Nowhere in particular. Just walking.') },
    { id: 'cpl8', when: { flag: ['to_home'], night: true }, say: S('Home. It\'s late.', 'Bed. It\'s way past my bedtime.') },
    { id: 'cpl9', when: { temper: ['grumpy'], flag: ['to_none'] }, say: S('Why do you care?', 'Away from here, ideally.') },
  ],
  about: [
    { id: 'cab0', when: {}, say: S('Not much to tell. I\'m {first}, {atitle}. I live on {home} and I love {interest}.', 'I\'m {atitle}, I live on {home}, and in my free time it\'s {interest}, {interest}, {interest}.') },
    { id: 'cab1', when: { temper: ['shy'] }, say: S('Oh, there\'s not much to say. I\'m {atitle}. I like {interest}. That\'s… that\'s about it.') },
    { id: 'cab2', when: { temper: ['chatty'] }, say: S('Where do I start? I\'m {first}, {atitle}, I live on {home}, I\'m mad about {interest}, and I talk too much. As you may have noticed.') },
    { id: 'cab3', when: { temper: ['proud'] }, say: S('I\'m {full}. {ATitle}, and a good one. I don\'t like to brag. But I am.') },
    { id: 'cab4', when: { temper: ['grumpy'] }, say: S('I\'m {atitle}. I like {interest} and I don\'t like questions.') },
    { id: 'cab5', when: { child: true }, say: S('I\'m {first} and I\'m {age} and I like {interest} and {fav}!') },
    { id: 'cab6', when: { temper: ['dreamy'] }, say: S('Me? I\'m {atitle} by day. But really I think about {interest}. All the time.') },
    { id: 'cab7', when: { senior: true }, say: S('Me? I was {atitle} for years. Now I\'ve got time for {interest} at last.') },
  ],
  about_kin: [
    { id: 'cak2', when: {}, say: S('{Kname}? {Kajob}, {kage}, crazy about {kint}. A good soul.', 'My {kword}? {Kpro}\'s {kajob}. Loves {kint}. We get on, mostly.') },
    { id: 'cak3', when: { temper: ['grumpy'] }, say: S('{Kname}. {Kajob}. Talks about {kint} too much.') },
  ],

  // ------------------------------------------------------------------ opinions
  opinion: [
    { id: 'co0', when: { flag: ['pos'] }, say: S('{Fac}? They do a good job, mostly.', 'I\'m glad we have {fac}.', 'Good people, {fac}. Most of them.') },
    { id: 'co1', when: { flag: ['mixed'] }, say: S('{Fac}? Mixed feelings.', 'Some days I like {fac}, some days I don\'t.', 'Hard to say. They\'re… there.') },
    { id: 'co2', when: { flag: ['neg'] }, say: S('{Fac}? Don\'t get me started.', 'I don\'t trust {fac}.', 'Useless, if you ask me.') },
    { id: 'co3', when: { flag: ['f_police', 'pos'] }, say: S('The police? They keep us safe. When they turn up.', 'I\'d be lost without the police.') },
    { id: 'co4', when: { flag: ['f_police', 'neg'] }, say: S('The police? Never there when you need them.', 'Always too late and always too many.') },
    { id: 'co5', when: { flag: ['f_army', 'neg'] }, say: S('Tanks in the street. Is that really the answer?', 'The army breaks more than the monsters.') },
    { id: 'co6', when: { flag: ['f_army', 'pos'] }, say: S('When the big ones come, I\'m glad the army does.', 'Brave lads and lasses, the soldiers.') },
    { id: 'co7', when: { flag: ['f_wardens', 'pos'] }, say: S('The Wardens? Fascinating! I\'d love to see one up close.', 'I think they\'re looking after us. In their way.') },
    { id: 'co8', when: { flag: ['f_wardens', 'neg'] }, say: S('Those discs in the sky? They give me the creeps.', 'Aliens watching us all day. I don\'t like it.') },
    { id: 'co9', when: { flag: ['f_gangs'] }, say: S('Criminals. They make this city worse.', 'I keep my head down and my bag closed.') },
    { id: 'co10', when: { flag: ['f_gangs'], group: true }, say: S('Shh! {Group} have ears everywhere.', 'Not here. Not about them.') },
    { id: 'co11', when: { flag: ['f_monsters'] }, say: S('Monsters! Who ordered those?', 'Every week something new wants to eat the city.') },
    { id: 'co12', when: { flag: ['f_mayor'] }, say: S('The mayor? Nice speeches. That\'s about it.', 'The council? They should come and live here for a week.') },
    { id: 'co13', when: { flag: ['f_heroes', 'pos'] }, say: S('Superheroes? Best thing that happened to this city.', 'I love superheroes. Present company included.') },
    { id: 'co14', when: { flag: ['f_heroes', 'neg'] }, say: S('Superheroes? More damage than help.', 'Capes. Who needs them.') },
    { id: 'co15', when: { flag: ['f_robots', 'pos'] }, say: S('The robots? Handy little things.', 'I like the delivery bots. They say please.') },
    { id: 'co16', when: { flag: ['f_robots', 'neg'] }, say: S('Robots everywhere. One day they\'ll all go wrong at once.', 'I don\'t trust anything without a face.') },
    { id: 'co17', when: { flag: ['f_slimes'] }, say: S('Slimes? In the sewers? Please tell me you\'re joking.', 'I don\'t want to know what lives down there.') },
    { id: 'co18', when: { flag: ['person', 'kin'] }, say: S('{Kname}? I love {kname} to bits.', 'My {kword}? Wonderful. Infuriating, but wonderful.', '{Kname}\'s the best.') },
    { id: 'co19', when: { flag: ['person', 'kin'], temper: ['grumpy'] }, say: S('{Kname}? Fine. Annoying. Fine.') },
    { id: 'co20', when: { flag: ['person', 'stranger'] }, say: S('{Other}? I don\'t know them.', 'Never met {other}.') },
    { id: 'co21', when: { flag: ['boss'] }, say: S('{Other}? Dangerous. Stay away from that one.', 'I don\'t say that name out loud.', 'A crook with nice shoes.') },
    { id: 'co22', when: { flag: ['threatop'] }, say: S('{Threat}? Horrible thing.', 'I hope we never see {threat} again.', '{Threat} nearly gave me a heart attack.') },
    { id: 'co23', when: { flag: ['placeop', 'pos'] }, say: S('{Thing}? Lovely.', 'I like it there.', 'One of my favourite places.') },
    { id: 'co24', when: { flag: ['placeop', 'neg'] }, say: S('{Thing}? Not my favourite.', 'Never liked it much.') },
    { id: 'co25', when: { flag: ['placeop', 'mixed'] }, say: S('{Thing}? It\'s all right.', 'Haven\'t been there in ages.') },
  ],
  know: [
    { id: 'ck0', when: { flag: ['kin'] }, say: S('{Kname}? Of course! My {kword}.', 'Know {kname}? {Kpro}\'s my {kword}!') },
    { id: 'ck1', when: { flag: ['stranger'] }, say: S('{Other}? Never heard of them.', 'No, I don\'t think so.', '{Other}… no. Should I?') },
    { id: 'ck2', when: { flag: ['boss'] }, say: S('Everybody knows {other}. Nobody talks about {other}.', '{Other}? Keep your voice down.') },
    { id: 'ck3', when: { flag: ['boss'], op: [40, 100] }, say: S('{Other}? Runs things for {group}. If you\'re going after them… be careful.') },
    { id: 'ck4', when: { flag: ['famous'] }, say: S('{Other}? I\'ve heard the name.', 'Sounds familiar. From the news, maybe?') },
  ],

  // ------------------------------------------------------------------ the world
  safe: [
    { id: 'csa0', when: { safety: ['safe', 'quiet'], flag: ['safety'] }, say: S('Safe as houses. Nothing ever happens in {hood}.', 'Very safe. Boring, even.', 'It\'s quiet here. I like it that way.') },
    { id: 'csa1', when: { safety: ['mixed'], flag: ['safety'] }, say: S('Mostly. Keep an eye on your wallet.', 'It\'s all right in the day. At night, I\'m not so sure.') },
    { id: 'csa2', when: { safety: ['rough', 'dangerous'], flag: ['safety'] }, say: S('Safe? In {hood}? No.', 'Not really. I don\'t go out after dark.', 'Rough area. Don\'t flash anything shiny.') },
    { id: 'csa3', when: { safety: ['rough', 'dangerous'], group: true, flag: ['safety'] }, say: S('Not with {group} running things.', 'Ask {group}. They decide what\'s safe around here.') },
    { id: 'csa4', when: { trouble: true }, say: S('Does it LOOK safe?', 'After all that? No!') },
    { id: 'csa5', when: {}, say: S('Safe enough, I suppose.', 'Depends who you ask.', 'As safe as anywhere in this city.') },
  ],
  gang: [
    { id: 'cg0', when: { group: true }, say: S('{Group}. Everybody knows it.', 'This is {group} turf.', '{Group} run this street. Their boss is {boss}.') },
    { id: 'cg1', when: { group: true, flag: ['afraid'] }, say: S('I… I don\'t know anything about that.', 'Gangs? No idea. I mind my own business.', 'Not here. Please.') },
    { id: 'cg2', when: { group: true, boss: true, flag: ['tells'] }, say: S('{Group}. {Boss} runs them. I heard their place is {dir} of here. You didn\'t hear it from me.', '{Boss}\'s lot. {Group}. Try {dir}, about {dist} from here.') },
    { id: 'cg3', when: { group: false }, say: S('No gang here, thank goodness.', 'Nobody runs this street. Well, the pigeons.', 'Not round here. Try the rougher parts of town.') },
    { id: 'cg4', when: { group: false, flag: ['gangnear'] }, say: S('Not here. But {other} hold the streets nearby.', 'Not this street. {Other} are close, though.') },
  ],
  weather: [
    { id: 'cwe0', when: { flag: ['w_clear'] }, say: S('Gorgeous, isn\'t it?', 'Lovely day. Makes everything better.', 'Not a cloud. I could get used to this.') },
    { id: 'cwe1', when: { flag: ['w_cloudy'] }, say: S('A bit grey, but dry.', 'Could be worse. Could be raining.') },
    { id: 'cwe2', when: { wet: true }, say: S('Wet, wet, wet.', 'I forgot my umbrella. Of course.', 'Typical. It always rains when I go out.') },
    { id: 'cwe3', when: { storm: true }, say: S('What a storm! I should be inside.', 'Did you hear that thunder? I nearly jumped out of my skin.') },
    { id: 'cwe4', when: { flag: ['w_fog'] }, say: S('Can\'t see a thing in this fog.', 'Spooky, this fog.') },
    { id: 'cwe5', when: { wet: true, temper: ['dreamy'] }, say: S('I love the rain. Everything smells new.') },
    { id: 'cwe6', when: { night: true }, say: S('It\'s night. The weather is: dark.', 'Bit chilly now the sun is gone.') },
  ],
  time: [
    { id: 'cti0', when: {}, say: S('It\'s {clock}.', 'About {clock}.', '{Clock}, I think.') },
    { id: 'cti1', when: { night: true }, say: S('{Clock}. Way too late.', '{Clock}. I should be in bed.') },
    { id: 'cti2', when: { child: true }, say: S('{Clock}! I think. I can\'t really read clocks.') },
  ],
  threat: [
    { id: 'cth0', when: { flag: ['seen'] }, say: S('{Threat}? {Ago}. I\'ll never forget it.', '{Threat}, {ago}. I watched from my window.', 'Oh, I saw it. {Ago}. Horrible.') },
    { id: 'cth1', when: { flag: ['seen', 'where'] }, say: S('{Threat}! {Ago}, over by {where}. The noise!', '{Ago}, near {where}. I\'ve never run so fast.') },
    { id: 'cth2', when: { flag: ['now'] }, say: S('{Threat}! It\'s here NOW! Why are you talking to me?!', 'It\'s happening right now! Go!') },
    { id: 'cth3', when: { flag: ['never'] }, say: S('{Threat}? I\'ve only heard stories.', 'Not with my own eyes, thank goodness.', 'No, and I hope I never do.') },
    { id: 'cth4', when: { flag: ['none'] }, say: S('Monsters? Not lately, touch wood.', 'It\'s been quiet. Too quiet, my nan would say.') },
    { id: 'cth5', when: { flag: ['seen', 'beaten'] }, say: S('{Threat}? {Ago}. And then it went down! Someone finally stopped it.', '{Ago}. I saw it fall. Best day of the year.') },
  ],
  here: [
    { id: 'chr0', when: { street: true }, say: S('This is {street}.', '{Street}. Lost?', 'You\'re on {street}.') },
    { id: 'chr1', when: { street: true, safety: ['safe', 'quiet', 'mixed', 'rough', 'dangerous'] }, say: S('{Street}, in {hood}.', 'This is {street}. {Hood}.') },
    { id: 'chr2', when: { street: false }, say: S('Somewhere in {city}. I\'m not sure of the name.', 'Honestly? No idea what this bit is called.') },
  ],
  city: [
    { id: 'cci0', when: { flag: ['pos'] }, say: S('{City}! Best city in the world. Mostly.', '{City}. I wouldn\'t live anywhere else.', 'I love {city}. Monsters and all.') },
    { id: 'cci1', when: { flag: ['mixed'] }, say: S('{City}. It has its moments.', '{City}. You get used to it.') },
    { id: 'cci2', when: { flag: ['neg'] }, say: S('{City}. If I had the money I\'d leave.', '{City}. Noisy, dirty, dangerous. Home.') },
  ],
  trouble: [
    { id: 'ctr0', when: { safety: ['rough', 'dangerous'], flag: ['safety'] }, say: S('Around here? Something\'s always going on. Keep your eyes open.', 'Try the next street. There\'s always someone getting mugged.') },
    { id: 'ctr1', when: { heard: true }, say: S('I heard {heard}', 'Well, {heard}') },
    { id: 'ctr2', when: { safety: ['safe', 'quiet'], flag: ['safety'] }, say: S('Not here. It\'s a quiet street.', 'Nothing I\'ve seen. Lucky us.') },
    { id: 'ctr3', when: {}, say: S('Not that I\'ve seen.', 'All quiet, as far as I know.') },
    { id: 'ctr4', when: { flag: ['favour'] }, say: S('Actually, yes. Me. Could you do something for me?') },
  ],
  where_none: [
    { id: 'cwn0', when: {}, say: S('{Thing}? Sorry, I don\'t know where that is.', 'No idea, sorry.', 'Never heard of it. Try the map?') },
    { id: 'cwn1', when: { flag: ['hospital'] }, say: S('The hospital? The drones know the way. If you\'re hurt, they find you.', 'Somewhere across town. The paramedics would know.') },
    { id: 'cwn2', when: { flag: ['toilet'] }, say: S('Ha! Try a café. Buy a coffee first.', 'Not out here, I\'m afraid. Can\'t you just… fly home?') },
    { id: 'cwn3', when: { flag: ['sewers'] }, say: S('The sewers? Any manhole. Why would you want to go there?', 'Lift a manhole cover. And hold your nose.') },
    { id: 'cwn4', when: { flag: ['food'] }, say: S('There are cafés all along the main streets. Follow your nose!', 'Any of the shops with tables outside.') },
    { id: 'cwn5', when: { flag: ['police'] }, say: S('There\'s always a patrol around. Just shout.', 'Don\'t know the station. But a police car passes every few minutes.') },
  ],

  // ------------------------------------------------------------------ the hero
  know_me: [
    { id: 'ckm0', when: { met: false, op: [30, 100] }, say: S('Who doesn\'t? You\'re the hero!', 'Everybody knows you! You\'re in the news every day.') },
    { id: 'ckm1', when: { met: false, op: [-100, -30] }, say: S('I know who you are. Everybody does.', 'You\'re the one from the news. The bad news.') },
    { id: 'ckm2', when: { met: false }, say: S('Should I? You do look familiar.', 'You\'re the one who flies about, aren\'t you?', 'I don\'t think we\'ve met.') },
    { id: 'ckm3', when: { met: true }, say: S('Of course! We met {days} days ago.', 'Sure, we\'ve met before.', 'I remember you. You don\'t forget a face like that.') },
    { id: 'ckm4', when: { met: true, deed: 'helped' }, say: S('How could I forget? You helped me up on {metstreet}.') },
    { id: 'ckm5', when: { met: true, deed: 'saved' }, say: S('You saved me! I\'ll remember that till the day I die.') },
    { id: 'ckm6', when: { met: true, deed: 'hurt' }, say: S('Oh, I remember. My back remembers too.') },
    { id: 'ckm7', when: { flag: ['named'] }, say: S('{Heroname}! Of course I remember.', 'You\'re {heroname}. See? I remember.') },
  ],
  my_name: [
    { id: 'cmn0', when: { flag: ['named'] }, say: S('{Heroname}.', 'It\'s {heroname}, isn\'t it?', '{Heroname}! I\'m good with names.') },
    { id: 'cmn1', when: { flag: ['unnamed'] }, say: S('You never told me.', 'No idea. What is it?', 'I don\'t think you said.') },
  ],
  tell_name: [
    { id: 'ctn0', when: {}, say: S('{Heroname}! Nice to meet you.', '{Heroname}. I\'ll remember that.', 'Hello, {heroname}.') },
    { id: 'ctn1', when: { temper: ['chatty', 'cheerful'] }, say: S('{Heroname}! What a great name! I\'m {first}.', '{Heroname}! Love it. Very heroic.') },
    { id: 'ctn2', when: { temper: ['grumpy'] }, say: S('{Heroname}. Right.', 'Fine. {Heroname}.') },
    { id: 'ctn3', when: { temper: ['shy'] }, say: S('Oh… {heroname}. That\'s nice. I\'m {first}.') },
    { id: 'ctn4', when: { flag: ['same'] }, say: S('I know, {heroname}. You told me.', 'Yes, {heroname}. I haven\'t forgotten.') },
    { id: 'ctn5', when: { flag: ['changed'] }, say: S('{Heroname}? I thought it was {old}.', 'Last time you said {old}. Now it\'s {heroname}?') },
    { id: 'ctn6', when: { child: true }, say: S('{Heroname}! That\'s a superhero name!', 'Cool! When I grow up I want a name like {heroname}.') },
  ],
  tell_like: [
    { id: 'ctl0', when: { flag: ['agree'] }, say: S('Me too! I love {thing}.', 'Really? So do I!', 'Finally, someone with taste!') },
    { id: 'ctl1', when: { flag: ['agree', 'mine'] }, say: S('No way! {Thing} is my favourite thing in the world!', 'You like {thing}? We have to talk! I\'m mad about it.') },
    { id: 'ctl2', when: { flag: ['differ'] }, say: S('Really? Not my thing.', '{Thing}? Each to their own.', 'Hmm. I don\'t get the appeal.') },
    { id: 'ctl3', when: { flag: ['neutral'] }, say: S('{Thing}? It\'s all right.', 'Oh yes? Good for you.') },
    { id: 'ctl4', when: { flag: ['agree_no'] }, say: S('Me neither! Awful.', 'Ha, same. Can\'t stand {thing}.', 'Finally someone who gets it.') },
    { id: 'ctl5', when: { flag: ['differ_no'] }, say: S('What? I love {thing}!', 'Oh, don\'t say that. {Thing} is great.') },
    { id: 'ctl6', when: { flag: ['place'] }, say: S('Glad you like it here.', 'Me too, most days.') },
  ],
  tell_feel: [
    { id: 'ctf0', when: { flag: ['f_tired'] }, say: S('Saving the city must be exhausting.', 'You should get some rest. Even heroes sleep.') },
    { id: 'ctf1', when: { flag: ['f_sad'] }, say: S('Oh no. Do you want to talk about it?', 'I\'m sorry. It\'ll get better.', 'Chin up. The city needs you.') },
    { id: 'ctf2', when: { flag: ['f_happy'] }, say: S('Good! That makes two of us.', 'Glad to hear it!', 'Lovely. Happy heroes are the best kind.') },
    { id: 'ctf3', when: { flag: ['f_bored'] }, say: S('Bored? In this city? Just wait an hour.', 'Something will blow up soon, don\'t worry.') },
    { id: 'ctf4', when: { flag: ['f_lost'] }, say: S('Lost? Where do you want to go?', 'Ask me the way somewhere. I know these streets.') },
    { id: 'ctf5', when: { flag: ['f_hungry'] }, say: S('There are cafés all over. I\'d get a bun.', 'Me too! Let\'s not talk about food.') },
    { id: 'ctf6', when: { flag: ['f_hurt'] }, say: S('Are you all right? Should I call someone?', 'You heal fast, don\'t you? Please say yes.') },
    { id: 'ctf7', when: { flag: ['f_lonely'] }, say: S('Well, you\'ve got me to talk to.', 'It must be lonely, being the only one who can fly.') },
    { id: 'ctf8', when: { flag: ['f_sad'], temper: ['grumpy'] }, say: S('Join the club.', 'Aren\'t we all.') },
    { id: 'ctf9', when: { flag: ['f_angry'] }, say: S('Not at me, I hope.', 'Count to ten. Please.') },
    { id: 'ctf10', when: { flag: ['f_scared'] }, say: S('YOU are scared? Then what about me?!', 'If you\'re scared, I\'m leaving.') },
    { id: 'ctf11', when: { flag: ['f_other'] }, say: S('I see.', 'Oh? I know the feeling.') },
  ],
  tell_hero: [
    { id: 'cte0', when: {}, say: S('I know. I can see the… everything.', 'Yes, I\'d noticed.', 'So I hear.') },
    { id: 'cte1', when: { op: [30, 100] }, say: S('And we\'re lucky to have you!', 'The best one we\'ve got!') },
    { id: 'cte2', when: { op: [-100, -30] }, say: S('Hero. Right.', 'Some hero.') },
    { id: 'cte3', when: { child: true }, say: S('I KNOW! Can you show me a power? Please?', 'That\'s SO cool! Can I be your sidekick?') },
    { id: 'cte4', when: { flag: ['new'] }, say: S('Welcome to {city}! Mind the monsters.', 'New in town? You picked an interesting city.') },
  ],
  ask_help: [
    { id: 'cah0', when: {}, say: S('Me? What could I do for a hero?', 'I can tell you the way, or what\'s going on. That\'s about it.', 'Sure, if I can. Ask away.') },
    { id: 'cah1', when: { op: [-100, -20] }, say: S('Help you? After everything?', 'I don\'t think so.') },
  ],
  leave: [
    { id: 'clv0', when: { trouble: true }, say: S('You don\'t have to tell me twice!', 'Going! Going!', 'Thank you! I\'m off!') },
    { id: 'clv1', when: { trouble: false }, say: S('Why? What\'s happening?', 'Is something coming? Should I be worried?') },
    { id: 'clv2', when: { trouble: false, temper: ['grumpy', 'proud'] }, say: S('It\'s a free country. I\'ll stand where I like.', 'Don\'t tell me what to do.') },
    { id: 'clv3', when: { flag: ['goes'] }, say: S('If you say so. I trust you.', 'All right, all right. I\'m going.', 'You know something I don\'t. Bye!') },
  ],
  calm: [
    { id: 'cca0', when: { trouble: true }, say: S('You\'re right. Breathe. Okay.', 'Okay. Okay. I\'m calm. I\'m calm!') },
    { id: 'cca1', when: { trouble: false }, say: S('I AM calm.', 'I\'m perfectly calm, thank you.') },
  ],
  reassure: [
    { id: 'crs0', when: { trouble: true }, say: S('Thank you. I feel better with you here.', 'Really? Thank goodness.', 'You promise?') },
    { id: 'crs1', when: { trouble: false }, say: S('I wasn\'t worried. Should I be?', 'Okay…? Thanks, I suppose.') },
    { id: 'crs2', when: { threat: true }, say: S('Even with the monsters about? Thank you.', 'I\'ll hold you to that.') },
  ],

  // ------------------------------------------------------------------ social
  compliment: [
    { id: 'ccp0', when: {}, say: S('Oh! Thank you.', 'That\'s nice of you to say.', 'Well, thank you!') },
    { id: 'ccp1', when: { temper: ['shy'] }, say: S('Oh… thank you. I don\'t know what to say.', '(They go a bit red.) Thanks.') },
    { id: 'ccp2', when: { temper: ['grumpy'] }, say: S('What do you want?', 'Flattery won\'t get you anywhere.') },
    { id: 'ccp3', when: { temper: ['proud'] }, say: S('I know. But thank you.', 'Finally, someone notices.') },
    { id: 'ccp4', when: { temper: ['cheerful', 'chatty'] }, say: S('Aww, you\'re sweet! You made my day.', 'Stop it! Well, don\'t stop.') },
    { id: 'ccp5', when: { child: true }, say: S('Thanks! You\'re cool too!', 'I know! My mum says so too.') },
    { id: 'ccp6', when: { flag: ['again'] }, say: S('You said that already. But thanks.', 'Careful, I\'ll get a big head.') },
  ],
  insult: [
    { id: 'cin0', when: {}, say: S('Excuse me?', 'Well, that\'s rude.', 'Charming.') },
    { id: 'cin1', when: { temper: ['kind'] }, say: S('That\'s not very nice. Bad day?', 'I\'m sorry you feel that way.') },
    { id: 'cin2', when: { temper: ['grumpy'] }, say: S('Same to you!', 'And you\'re a walking disaster with a cape.', 'Get lost.') },
    { id: 'cin3', when: { temper: ['proud'] }, say: S('How dare you.', 'I don\'t have to listen to this.') },
    { id: 'cin4', when: { temper: ['shy', 'anxious'] }, say: S('Oh. I… sorry.', '(They look at their shoes.)') },
    { id: 'cin5', when: { child: true }, say: S('I\'m telling my mum!', 'YOU are! Hmph.') },
    { id: 'cin6', when: { flag: ['again'] }, say: S('Right. That\'s enough.', 'Some hero you are.') },
  ],
  threatened: [
    { id: 'cte5', when: {}, say: S('Help! Somebody help!', 'Please! I\'ll go, I\'ll go!', 'Don\'t hurt me!') },
    { id: 'cte6', when: { flag: ['brave'] }, say: S('You wouldn\'t dare. People are watching.', 'Go on then. See what happens to your reputation.') },
    { id: 'cte7', when: { child: true }, say: S('MUUUM!', 'I\'m telling! I\'m telling everyone!') },
  ],
  joke: [
    { id: 'cjo0', when: {}, say: S('Why did the superhero flush the toilet? It was his duty.', 'What do you call a monster with no neck? The Lost Neck Monster.', 'I told my landlord the giant broke my window. He said: prove it. So I pointed at the giant.', 'Why don\'t skeletons fight crime? They don\'t have the guts.', 'What\'s a hero\'s favourite drink? Fruit punch.') },
    { id: 'cjo1', when: { temper: ['grumpy'] }, say: S('I don\'t do jokes.', 'Here\'s a joke: this city\'s rent.') },
    { id: 'cjo2', when: { child: true }, say: S('Knock knock! …You have to say who\'s there! …Banana! Hahaha!', 'Why did the cookie go to the doctor? It felt crummy! Hahaha!') },
    { id: 'cjo3', when: { temper: ['shy'] }, say: S('Oh, I\'m terrible at jokes. Um. Why did the pigeon cross the road? …I forget.') },
    { id: 'cjo4', when: { temper: ['dreamy'] }, say: S('A neutron walks into a bar and asks how much for a drink. The barman says: for you, no charge.') },
    { id: 'cjo5', when: { senior: true }, say: S('In my day we didn\'t need jokes. We had the weather.', 'Why do old people never get lost? They know all the shortcuts. Because they walked them before there were roads.') },
  ],
  flirt: [
    { id: 'cfl0', when: {}, say: S('Ha! Smooth.', 'You say that to everyone you rescue, don\'t you?', 'Careful, hero.') },
    { id: 'cfl1', when: { flag: ['taken'] }, say: S('I\'m married, you know.', 'My {kword} wouldn\'t like that.', 'Flattered. And taken.') },
    { id: 'cfl2', when: { child: true }, say: S('Ew! Gross!', 'Grown-ups are so weird.') },
    { id: 'cfl3', when: { temper: ['shy'] }, say: S('Oh! I… um… (They\'ve gone very red.)', 'I don\'t… what do I say to that?') },
    { id: 'cfl4', when: { temper: ['grumpy'] }, say: S('No.', 'Not a chance.') },
    { id: 'cfl5', when: { op: [40, 100], temper: ['cheerful', 'chatty', 'nosy'] }, say: S('Maybe. If you save the city first.', 'Ha! Ask me again after the next monster.') },
    { id: 'cfl6', when: { senior: true }, say: S('Oh, you charmer. Forty years ago, maybe!', 'If I were fifty years younger!') },
  ],
  laugh: [
    { id: 'cla0', when: {}, say: S('Ha!', 'Glad you think so.', 'I have my moments.') },
    { id: 'cla1', when: { temper: ['grumpy'] }, say: S('It wasn\'t that funny.', 'Hm.') },
  ],
  thanks: [
    { id: 'cty0', when: {}, say: S('You\'re welcome.', 'Any time.', 'No problem.') },
    { id: 'cty1', when: { op: [30, 100] }, say: S('Anything for you!', 'After all you do for us? Don\'t mention it.') },
    { id: 'cty2', when: { temper: ['grumpy'] }, say: S('Yeah, yeah.', 'Mm-hm.') },
  ],
  sorry: [
    { id: 'cso0', when: { deed: 'hurt' }, say: S('Well… thank you for saying it.', 'Apology accepted. Just watch where you land next time.', 'It still hurts. But thank you.') },
    { id: 'cso1', when: { deed: 'hurt', temper: ['grumpy', 'proud'] }, say: S('Sorry doesn\'t fix my back.', 'Hmph. We\'ll see.') },
    { id: 'cso2', when: { flag: ['insulted'] }, say: S('Fine. Let\'s forget it.', 'All right. Apology accepted.') },
    { id: 'cso3', when: {}, say: S('What for?', 'It\'s fine, really.', 'No harm done.') },
  ],
  greet_again: [
    { id: 'cga0', when: {}, say: S('Hello again. We\'re already talking!', 'Hi. Still here.', 'Yes, hello!') },
    { id: 'cga1', when: { flag: ['first'] }, say: S('Hi! What can I do for you?', 'Hello! What is it?', 'Hi there. Need something?') },
    { id: 'cga2', when: { flag: ['first'], temper: ['grumpy'] }, say: S('Yes?', 'What?') },
    { id: 'cga3', when: { flag: ['first'], temper: ['shy'] }, say: S('Oh… hi.', 'H-hello again.') },
    { id: 'cga4', when: { flag: ['first'], temper: ['chatty', 'cheerful'] }, say: S('Hi hi! What\'s up?', 'Hello! Go on, ask me anything.') },
  ],
  yes: [{ id: 'cy0', when: {}, say: S('Yes what?', 'Good. I think?', 'Okay!') }],
  no: [{ id: 'cno0', when: {}, say: S('No? No what?', 'Oh. All right then.', 'Fair enough.') }],
  dunno: [{ id: 'cdk0', when: {}, say: S('Nobody knows anything these days.', 'Me neither.', 'Fair enough.') }],
  okay: [{ id: 'cok0', when: {}, say: S('Mm.', 'Yes.', 'So…', 'Anything else?') }, { id: 'cok1', when: { temper: ['chatty'] }, say: S('So! Where was I?') }],
  answer_yes: [
    { id: 'cay0', when: {}, say: S('Great!', 'I knew it!', 'Good answer.') },
    { id: 'cay1', when: { flag: ['thing'] }, say: S('You too? Brilliant!', 'Ha! I knew I liked you.', 'Finally someone who understands.') },
  ],
  answer_no: [
    { id: 'can0', when: {}, say: S('Oh. Pity.', 'Fair enough.', 'Your loss!') },
    { id: 'can1', when: { flag: ['thing'] }, say: S('No? You don\'t know what you\'re missing.', 'Oh well. Nobody\'s perfect.') },
  ],
  answer_name: [
    { id: 'cam0', when: {}, say: S('{Heroname}. Nice to meet you, {heroname}.', '{Heroname}! I\'ll remember.') },
  ],
  why: [
    { id: 'cwy0', when: { flag: ['reason'] }, say: S('{Why}', 'Well… {why}') },
    { id: 'cwy1', when: {}, say: S('Why not?', 'Just because.', 'I don\'t know. That\'s how it is.', 'Does there have to be a reason?') },
  ],
  really: [
    { id: 'crl0', when: {}, say: S('Really.', 'Would I lie to you?', 'Cross my heart.') },
    { id: 'crl1', when: { temper: ['grumpy'] }, say: S('Yes, really.', 'Why would I make that up?') },
  ],
  what_can: [
    { id: 'cwc0', when: {}, say: S('Ask me anything. About me, my family, this street, the news, the way somewhere. Or just chat.', 'Whatever you like. I know this neighbourhood, and I know myself. Mostly.') },
    { id: 'cwc1', when: { temper: ['grumpy'] }, say: S('Ask what you want. Quickly.') },
  ],
  unclear: [
    { id: 'cu0', when: {}, say: S('Sorry, I don\'t follow.', 'Come again?', 'I\'m not sure what you mean.', 'Hm?') },
    { id: 'cu1', when: { temper: ['grumpy'] }, say: S('What are you on about?', 'Talk sense.') },
    { id: 'cu2', when: { temper: ['shy'] }, say: S('Sorry… I didn\'t understand.', 'Um… what?') },
    { id: 'cu3', when: { child: true }, say: S('Huh? Say it simpler!', 'That doesn\'t make sense!') },
    { id: 'cu4', when: { temper: ['chatty', 'nosy'] }, say: S('Ooh, I didn\'t catch that. Ask me about the street! I know everyone here.', 'Sorry, what? Ask me about my family, or the news, I love a gossip.') },
    { id: 'cu5', when: { temper: ['dreamy'] }, say: S('Sorry, I drifted off. What were you saying?') },
  ],
  patience: [
    { id: 'cpa0', when: {}, say: S('I\'ve really got to go. Bye.', 'Look, I have things to do. Goodbye.', 'Right. I\'m off.') },
    { id: 'cpa1', when: { temper: ['grumpy'] }, say: S('That\'s enough. Bye.', 'I\'m done here.') },
    { id: 'cpa2', when: { temper: ['kind'] }, say: S('I\'m sorry, I must be going. Take care of yourself.') },
    { id: 'cpa3', when: { flag: ['hurt'] }, say: S('I don\'t have to listen to this. Goodbye.', 'I\'m leaving.') },
  ],
  ask_back: [
    { id: 'cbk0', when: { flag: ['q_like'] }, say: S('Do you like {thing}?', 'And you? Are you into {thing}?', 'What about you?') },
    { id: 'cbk1', when: { flag: ['q_name'] }, say: S('What\'s your name, by the way?', 'And you are…? Besides the obvious.', 'I didn\'t catch your name.') },
    { id: 'cbk2', when: { flag: ['q_interest'] }, say: S('Do you follow {thing}?', 'Are you into {thing}, by any chance?') },
    { id: 'cbk3', when: { flag: ['q_fav'] }, say: S('What\'s yours?', 'And yours?') },
  ],
};
