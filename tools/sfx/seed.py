#!/usr/bin/env python3
"""Sound effects from ByteDance Seed Audio (OpenRouter text-to-speech endpoint).

    python3 tools/sfx/seed.py RAW_DIR REF_DIR [id ...] [--n N]

Seed Audio is a speech model, but a prompt starting with "The sound of" makes it render the sound
instead of reading the words out (found by Arnd). Writes RAW_DIR/<id>/seedK.wav (48 kHz mono);
screen.py, build.py and compare.py take it from there. Needs OPEN_ROUTER_KEY.
"""
import json, os, subprocess, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate import load_prompts

args = sys.argv[1:]
n = 3
if '--n' in args:
    i = args.index('--n'); n = int(args[i + 1]); del args[i:i + 2]
raw, ref, ids = args[0], args[1], args[2:]
prompts = load_prompts(ref)


def one(job):
    sid, k = job
    spec = prompts[sid]
    d = os.path.join(raw, sid)
    os.makedirs(d, exist_ok=True)
    wav = os.path.join(d, f'seed{k}.wav')
    if os.path.exists(wav):
        return
    text = 'The sound of ' + spec.get('seed', spec['sound'])
    req = urllib.request.Request('https://openrouter.ai/api/v1/audio/speech', data=json.dumps(
        {'model': 'bytedance-seed/seed-audio-1-0', 'input': text, 'response_format': 'mp3'}).encode(),
        headers={'Authorization': 'Bearer ' + os.environ['OPEN_ROUTER_KEY'], 'Content-Type': 'application/json'})
    for _ in range(3):
        try:
            mp3 = urllib.request.urlopen(req, timeout=180).read()
            break
        except Exception as e:
            print(sid, k, 'error', e, flush=True)
    else:
        return
    open(wav[:-4] + '.mp3', 'wb').write(mp3)
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', wav[:-4] + '.mp3', '-ac', '1', '-ar', '48000', wav], check=True)
    os.remove(wav[:-4] + '.mp3')
    print(sid, k, 'ok', flush=True)


with ThreadPoolExecutor(6) as ex:
    list(ex.map(one, [(s, k) for s in (ids or list(prompts)) for k in range(1, n + 1)]))
