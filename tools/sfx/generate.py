#!/usr/bin/env python3
"""Generate sound-effect candidates with Lyria (OpenRouter) and screen them with a listening model.

    OPEN_ROUTER_KEY=... python3 tools/sfx/generate.py RAW_DIR REF_DIR [id ...] [--tries N] [--jobs N]

For every id in tools/sfx/prompts.json (or the ids given) this asks a video model with native audio
(Grok Imagine Video 1.5 Lite at 480p, about $0.02 per second) for a clip of the sound: three takes for
shots, a steady stretch for loops, and keeps only the soundtrack. A Gemini model then listens blind
and lists the sound events; a text-only call scores each event against the wanted sound (blind first,
because naming the target makes the listener hear it). A clip whose best event scores below ACCEPT is
retried, up to --tries clips per id. Everything lands in RAW_DIR/<id>/: clipN.wav, the verdicts
(clipN.json) and the prompt; build.py cuts the final sounds from there.
Lyria (OpenRouter's only audio model) was tried first: it is a music model and slides into a beat
within seconds whatever the prompt says. The key is read from the environment only.
"""
import base64, json, os, subprocess, sys, threading, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
GEN_MODEL = os.environ.get('SFX_MODEL', 'x-ai/grok-imagine-video-1.5-lite')
LISTENER = os.environ.get('SFX_LISTENER', 'google/gemini-3.8-flash')
ACCEPT = 6
API = 'https://openrouter.ai/api/v1'


def gen_prompt(spec):
    if spec['kind'] == 'loop':
        audio = f"only {spec['sound']}, steady and continuous for the whole clip"
    elif spec['single']:
        audio = f"only {spec['sound']}, once, then its natural fade to silence"
    else:
        audio = f"only {spec['sound']}, three separate times with a short silence after each"
    scene = spec.get('scene', f"Realistic cinematic shot of {spec['sound']}")
    return f"{scene}. Audio: {audio}. No music, no speech, no voices."


def call(path, data=None, timeout=120):
    req = urllib.request.Request(API + path, data=json.dumps(data).encode() if data is not None else None,
                                 headers={'Authorization': 'Bearer ' + os.environ['OPEN_ROUTER_KEY'],
                                          'Content-Type': 'application/json'})
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'{e.code} {e.read().decode()[:300]}')


def video_audio(prompt, dur, seed, out_wav):
    """Video model with native audio; only the soundtrack is kept (48 kHz wav). Returns the cost."""
    job = json.load(call('/videos', {'model': GEN_MODEL, 'prompt': prompt, 'duration': dur,
                                     'resolution': '480p', 'seed': seed}))
    while True:
        time.sleep(6)
        st = json.load(call('/videos/' + job['id']))
        if st['status'] not in ('pending', 'in_progress'):
            break
    if st['status'] != 'completed':
        raise RuntimeError(f"video {st['status']}: {st.get('error')}")
    mp4 = out_wav[:-4] + '.mp4'
    open(mp4, 'wb').write(call(f"/videos/{job['id']}/content", timeout=300).read())
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', mp4, '-vn', '-ac', '2', '-ar', '48000',
                    '-c:a', 'pcm_s16le', out_wav], check=True)
    os.remove(mp4)
    return (st.get('usage') or {}).get('cost', 0)


def chat(content, timeout=300):
    body = {'model': LISTENER, 'temperature': 0, 'response_format': {'type': 'json_object'},
            'messages': [{'role': 'user', 'content': content}]}
    txt = json.load(call('/chat/completions', body, timeout))['choices'][0]['message']['content'].strip()
    if txt.startswith('```'):
        txt = txt.strip('`').split('\n', 1)[1]
    return json.loads(txt)


def listen(wav, spec):
    """Blind listening first (the target would bias it), then a text-only match against the target."""
    mp3 = wav.rsplit('.', 1)[0] + '.listen.mp3'
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', wav, '-b:a', '160k', mp3], check=True)
    b = base64.b64encode(open(mp3, 'rb').read()).decode()
    os.remove(mp3)
    heard = chat([{'type': 'text', 'text':
                   'Listen to this audio and identify, blind, every separate sound event with exact times. Answer ONLY with JSON '
                   '{"music": true/false, "speech": true/false, "events": [{"start": seconds, "end": seconds, "what": "what makes the sound, how it sounds"}]}. '
                   '"music" = any melody, chords, beat or instruments; "speech" = any words or voices talking.'},
                  {'type': 'input_audio', 'input_audio': {'data': b, 'format': 'mp3'}}])
    judged = chat([{'type': 'text', 'text':
                    f"A game needs this sound effect: {spec['sound']}. A listener heard these events in a generated clip: "
                    f"{json.dumps(heard.get('events', []))}. For each event give score 0-10: how well it serves as that sound effect "
                    '(10 = clearly that sound, 5 = plausible stand-in, 0 = something else). Answer ONLY with JSON {"scores": [numbers in the same order]}.'}])
    sc = judged.get('scores', [])
    for i, e in enumerate(heard.get('events', [])):
        e['score'] = sc[i] if i < len(sc) else 0
    if heard.get('music') or heard.get('speech'):
        for e in heard.get('events', []):
            e['score'] = min(e['score'], 4)
    heard['takes'] = heard.pop('events', [])
    return heard


def best(verdict):
    return max([t.get('score', 0) for t in verdict.get('takes', [])] or [0])


lock = threading.Lock()


def log(*a):
    with lock:
        print(*a, flush=True)


def load_prompts(ref):
    """prompts.json plus file count, old length (from REF_DIR, the sounds being replaced) and whether a
    shot is one long take per clip (old sounds over 2.2 s: thunder, roars) or three short ones."""
    import soundfile as sf
    sounds = os.path.join(os.path.dirname(os.path.dirname(HERE)), 'public', 'sounds')
    man = json.load(open(os.path.join(sounds, 'manifest.json')))
    out = {}
    for k, v in json.load(open(os.path.join(HERE, 'prompts.json'))).items():
        if k.startswith('_'):
            continue
        files = man[k]['files']
        v['files'] = len(files)
        v['old_s'] = sum(sf.info(os.path.join(ref, f)).duration for f in files) / len(files)
        v['single'] = v['kind'] == 'shot' and v.get('single', v['old_s'] > 2.2)
        out[k] = v
    return out


def run(sid, spec, raw, tries):
    d = os.path.join(raw, sid)
    os.makedirs(d, exist_ok=True)
    prompt = gen_prompt(spec)
    open(os.path.join(d, 'prompt.txt'), 'w').write(prompt + '\n')
    have = sorted(f for f in os.listdir(d) if f.startswith('clip') and f.endswith('.wav'))
    good = sum(1 for f in have if os.path.exists(os.path.join(d, f[:-4] + '.json'))
               and best(json.load(open(os.path.join(d, f[:-4] + '.json')))) >= ACCEPT)
    n, cost = len(have), 0.0
    dur = spec.get('gen_s', 10 if spec['kind'] == 'loop' else min(15, int(spec['old_s'] + 2.5)) if spec['single'] else 6)
    want = spec['files'] if spec['single'] else 1
    tries = max(tries, want + 1)
    while good < want and n < tries:
        n += 1
        wav = os.path.join(d, f'clip{n}.wav')
        for attempt in range(3):
            try:
                if not os.path.exists(wav):
                    cost += video_audio(prompt, dur, 1000 + n, wav)
                v = listen(wav, spec)
                json.dump(v, open(wav[:-4] + '.json', 'w'), indent=1)
                break
            except Exception as e:  # network hiccups, malformed JSON: try again
                log(sid, 'clip', n, 'error', e)
                time.sleep(5 * (attempt + 1))
        else:
            continue
        b = best(v)
        log(f"{sid} clip{n}: music={v.get('music')} speech={v.get('speech')} best={b} | " + '; '.join(
            f"{t.get('start')}-{t.get('end')} {t.get('score')} {t.get('what', '')[:50]}" for t in v.get('takes', [])[:5]))
        if b >= ACCEPT:
            good += 1
    return sid, good, cost


def main():
    args = [a for a in sys.argv[1:]]
    tries, jobs = 3, 6
    if '--tries' in args:
        i = args.index('--tries'); tries = int(args[i + 1]); del args[i:i + 2]
    if '--jobs' in args:
        i = args.index('--jobs'); jobs = int(args[i + 1]); del args[i:i + 2]
    raw, ref, ids = args[0], args[1], args[2:]
    prompts = load_prompts(ref)
    ids = ids or list(prompts)
    with ThreadPoolExecutor(jobs) as ex:
        res = list(ex.map(lambda s: run(s, prompts[s], raw, tries), ids))
    miss = [s for s, g, _ in res if g == 0]
    print(f"done; {len(ids) - len(miss)} of {len(ids)} have a usable take; spent ${sum(c for *_, c in res):.2f}",
          ('; missing: ' + ' '.join(miss)) if miss else '')


if __name__ == '__main__':
    main()
