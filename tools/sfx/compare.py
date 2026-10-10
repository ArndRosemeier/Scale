#!/usr/bin/env python3
"""Old against new: does the generated sound beat the one it replaced?

    python3 tools/sfx/compare.py REF_DIR [id ...] [--jobs N] > verdicts.json

For every id, each file in public/sounds is played to two listening models next to its old version
from REF_DIR, in both orders (A/B then B/A, so neither model's habit of preferring the first or
the second clip decides), and they say which clip is the better game sound for the wanted sound
(prompts.json). That's four votes. The new sound counts as better only with at least 3 of them;
a "same" vote counts for the old one. Needs OPEN_ROUTER_KEY.
"""
import base64, json, os, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from generate import call, load_prompts

SOUNDS = os.path.join(os.path.dirname(os.path.dirname(HERE)), 'public', 'sounds')
MODELS = [os.environ.get('SFX_LISTENER', 'google/gemini-3.8-flash'), os.environ.get('SFX_LISTENER2', 'google/gemini-3.5-flash')]


def mp3b64(wav):
    with tempfile.TemporaryDirectory() as t:
        out = os.path.join(t, 'a.mp3')
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', wav, '-b:a', '160k', out], check=True)
        return base64.b64encode(open(out, 'rb').read()).decode()


def ask(model, spec, a, b):
    text = (f"Two candidate sound effects for a video game. The game needs: {spec['sound']}. "
            f"{'It loops, so it should be steady. ' if spec['kind'] == 'loop' else ''}"
            'Clip A is the first audio, clip B the second. Which one is the better game sound for that purpose: '
            'more convincing, clearer, more fitting? Answer ONLY with JSON {"better": "A" or "B" or "same", "why": "a few words"}.')
    body = {'model': model, 'temperature': 0, 'response_format': {'type': 'json_object'},
            'messages': [{'role': 'user', 'content': [
                {'type': 'text', 'text': text},
                {'type': 'input_audio', 'input_audio': {'data': a, 'format': 'mp3'}},
                {'type': 'input_audio', 'input_audio': {'data': b, 'format': 'mp3'}}]}]}
    txt = json.load(call('/chat/completions', body, 300))['choices'][0]['message']['content'].strip()
    if txt.startswith('```'):
        txt = txt.strip('`').split('\n', 1)[1]
    return json.loads(txt)


def judge(job):
    sid, f, spec, ref = job
    old, new = mp3b64(os.path.join(ref, f)), mp3b64(os.path.join(SOUNDS, f))
    votes = []
    for m in MODELS:
        for order in ('old-new', 'new-old'):
            a, b = (old, new) if order == 'old-new' else (new, old)
            for _ in range(3):
                try:
                    r = ask(m, spec, a, b)
                    break
                except Exception as e:  # network or JSON hiccup
                    r = {'better': 'same', 'why': f'error {e}'[:80]}
            pick = r.get('better', 'same')
            who = 'same' if pick not in ('A', 'B') else ('old' if (pick == 'A') == (order == 'old-new') else 'new')
            votes.append({'model': m, 'order': order, 'vote': who, 'why': r.get('why', '')})
    n = sum(v['vote'] == 'new' for v in votes)
    print(f"{f}: new {n}/4 " + ' | '.join(f"{v['vote']}: {v['why'][:40]}" for v in votes), file=sys.stderr, flush=True)
    return {'id': sid, 'file': f, 'new_votes': n, 'keep_new': n >= 3, 'votes': votes}


def main():
    args = sys.argv[1:]
    jobs = 8
    if '--jobs' in args:
        i = args.index('--jobs'); jobs = int(args[i + 1]); del args[i:i + 2]
    ref, ids = args[0], args[1:]
    prompts = load_prompts(ref)
    man = json.load(open(os.path.join(SOUNDS, 'manifest.json')))
    work = [(sid, f, prompts[sid], ref) for sid in (ids or list(prompts)) for f in man[sid]['files']]
    with ThreadPoolExecutor(jobs) as ex:
        res = list(ex.map(judge, work))
    print(json.dumps(res, indent=1))


if __name__ == '__main__':
    main()
