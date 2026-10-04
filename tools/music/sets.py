"""
Stem sets for Scale's background music (adapted from Norgo's tools/music).

Every set is one musical mood of the city: a key, mode and tempo shared by all
of its layers, so the game can mix any variation of any layer with any other.
Layers:

  drone    sustained harmonic bed (always on while the set plays)
  texture  arpeggios / ostinato, movement without a lead line
  melody   a lead line (comes and goes)
  perc     unpitched rhythm only

A set may leave a layer out (pal entry None) and choose its own number of
variations per layer (`vars`), which keeps the download small.

Prompts are written for Stable Audio 3 Small-Music.
"""
from __future__ import annotations

NOTE_HZ = {
    'C': 130.81, 'C#': 138.59, 'D': 146.83, 'D#': 155.56, 'E': 164.81, 'F': 174.61,
    'F#': 185.00, 'G': 196.00, 'G#': 207.65, 'A': 220.00, 'A#': 233.08, 'B': 246.94,
}
NOTE_PC = {n: i for i, n in enumerate(NOTE_HZ)}
MODES = {
    'ionian': [0, 2, 4, 5, 7, 9, 11],
    'dorian': [0, 2, 3, 5, 7, 9, 10],
    'phrygian': [0, 1, 3, 5, 7, 8, 10],
    'lydian': [0, 2, 4, 6, 7, 9, 11],
    'mixolydian': [0, 2, 4, 5, 7, 9, 10],
    'aeolian': [0, 2, 3, 5, 7, 8, 10],
    'harmonic minor': [0, 2, 3, 5, 7, 8, 11],
    'phrygian dominant': [0, 1, 4, 5, 7, 8, 10],
}
PROMPT_NOTE = {'C#': 'C#', 'D#': 'Eb', 'F#': 'F#', 'G#': 'Ab', 'A#': 'Bb'}
PROMPT_KEY = {
    'ionian': 'major', 'lydian': 'major', 'mixolydian': 'major',
    'dorian': 'minor', 'phrygian': 'minor', 'aeolian': 'minor',
    'harmonic minor': 'minor', 'phrygian dominant': 'minor',
}

LAYERS = ('drone', 'texture', 'melody', 'perc')
LOCKED = ('texture', 'perc')
DEFAULT_VARS = {'drone': 1, 'texture': 2, 'melody': 2, 'perc': 1}

ROLE = {
    'drone': 'sustained ambient drone and slow evolving pad only, {pal}, free time, no rhythm, no drums, no percussion, no melody, harmonic bed',
    'texture': 'repeating arpeggio ostinato only, {pal}, strict tempo, no drums, no lead melody',
    'melody': 'solo lead melody only, {pal}, rubato, free time, expressive phrases with long rests, no drums, no pads, no accompaniment',
    'perc': 'percussion only, {pal}, steady groove, no melodic instruments, no pads, no bass',
}

SETS: dict[str, dict] = {
    # ---- the start screen
    'menu': dict(
        tonic='C', mode='aeolian', bpm=84, genre='Cinematic Synthwave Ambient',
        mood='evening skyline, city lights coming on, anticipation, wonder',
        vars={'drone': 1, 'texture': 1, 'melody': 1, 'perc': 1},
        pal=dict(drone='warm analog synth pad and soft strings', texture='gentle pulsing analog synth arpeggio',
                 melody='soft analog synth lead and felt piano', perc='soft electronic drums and gentle hi-hats'),
    ),
    # ---- calm city
    'day': dict(
        tonic='F', mode='ionian', bpm=80, genre='Lo-fi Chillhop Ambient',
        mood='relaxed, sunny, urban, easygoing, warm afternoon in the city',
        pal=dict(drone='warm Rhodes electric piano pad and soft tape-saturated synth', texture='mellow clean electric guitar and vibraphone arpeggio',
                 melody='mellow muted trumpet', perc='lo-fi hip hop drum kit with soft kick, brushed snare and vinyl crackle'),
    ),
    'night': dict(
        tonic='A', mode='dorian', bpm=72, genre='Nocturnal Neo-Noir Jazz Ambient',
        mood='late night, neon signs, wet streets, lonely, smoky, calm',
        pal=dict(drone='dark warm synth pad and soft low strings', texture='Rhodes electric piano arpeggio',
                 melody='smoky tenor saxophone', perc='brushed jazz drums and soft ride cymbal'),
    ),
    'under': dict(
        tonic='G', mode='phrygian', bpm=60, genre='Dark Industrial Ambient',
        mood='subterranean, damp tunnels, distant machinery, uneasy, echoing',
        vars={'drone': 1, 'texture': 1, 'melody': 1, 'perc': 1},
        pal=dict(drone='deep sub drone and bowed metal resonance', texture='slow pulsing dark synth arpeggio',
                 melody='distant reverberant prepared piano', perc='distant metallic clanks and low industrial pulse'),
    ),
    # ---- danger
    'tension': dict(
        tonic='E', mode='aeolian', bpm=104, genre='Cinematic Thriller Underscore',
        mood='suspenseful, urgent, danger nearby, chase',
        pal=dict(drone='low string tremolo and dark synth bass drone', texture='pulsing staccato synth bass ostinato',
                 melody='tense high violin motif', perc='tight electronic percussion and ticking hi-hats'),
    ),
    'battle': dict(
        tonic='D', mode='harmonic minor', bpm=138, genre='Epic Hybrid Orchestral Action',
        mood='massive, desperate, heroic, a giant monster attacks the city',
        pal=dict(drone='massive low brass and dark choir', texture='driving staccato strings and distorted synth ostinato',
                 melody='heroic brass lead', perc='huge cinematic drums, taiko and hybrid impacts'),
    ),
    # ---- after
    'elegy': dict(
        tonic='B', mode='aeolian', bpm=60, genre='Cinematic Elegy Ambient',
        mood='sorrowful, grieving, ruins, dust settling, quiet hope',
        vars={'drone': 1, 'texture': 2, 'melody': 2, 'perc': 0},
        pal=dict(drone='soft string ensemble and wordless choir pad', texture='slow solo piano arpeggio',
                 melody='solo cello', perc=None),
    ),
    'hero': dict(
        tonic='D', mode='ionian', bpm=120, genre='Uplifting Cinematic Superhero',
        mood='soaring, triumphant, flying over the skyline, freedom',
        vars={'drone': 1, 'texture': 1, 'melody': 2, 'perc': 1},
        pal=dict(drone='warm sustained string ensemble pad and soft horns', texture='soaring string ostinato and pulsing synth arpeggio',
                 melody='triumphant french horn lead', perc='driving cinematic drums and snare'),
    ),
}

# Per-set layer → variation count (0 when the set leaves the layer out).
VARIATIONS_OF = {
    sid: {l: (0 if s['pal'].get(l) is None else s.get('vars', DEFAULT_VARS).get(l, DEFAULT_VARS[l])) for l in LAYERS}
    for sid, s in SETS.items()
}

PLAIN = {'major': 'ionian', 'minor': 'aeolian'}


def plain_mode(mode: str) -> str:
    return PLAIN[PROMPT_KEY[mode]]


def safe_degrees(mode: str) -> list[int]:
    plain = set(MODES[plain_mode(mode)])
    return [d for d in MODES[mode] if d in plain]


def loop_bars(bpm: float, target_s: float = 32.0) -> int:
    """Whole 4-bar phrases giving a loop of roughly target_s seconds."""
    bar = 240.0 / bpm
    return max(8, int(round(target_s / bar / 4)) * 4)


def prompt_for(set_id: str, layer: str) -> str:
    s = SETS[set_id]
    key = f"{PROMPT_NOTE.get(s['tonic'], s['tonic'])} {PROMPT_KEY[s['mode']]}"
    role = ROLE[layer].format(pal=s['pal'][layer])
    head = 'TrackType: Music, VocalType: Instrumental'
    if layer == 'perc':
        return f"{head}, Genre: {s['genre']}, {s['bpm']} BPM, {role}, {s['mood']}, loopable, steady tempo, no intro, no ending"
    return f"{head}, Genre: {s['genre']}, Key: {key}, {s['bpm']} BPM, {role}, {s['mood']}, loopable, steady tempo, no intro, no ending"
