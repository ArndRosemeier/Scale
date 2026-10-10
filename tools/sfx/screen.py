#!/usr/bin/env python3
"""Screen generated candidates with a listening model (see generate.listen): every RAW_DIR/<id>/*.wav
without a verdict gets one (<name>.json). Needs OPEN_ROUTER_KEY in the environment.

    python3 tools/sfx/screen.py RAW_DIR REF_DIR [id ...] [--jobs N]
"""
import json, os, sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate import listen, load_prompts, best

args = sys.argv[1:]
jobs = 8
if '--jobs' in args:
    i = args.index('--jobs'); jobs = int(args[i + 1]); del args[i:i + 2]
raw, ref, ids = args[0], args[1], args[2:]
prompts = load_prompts(ref)
work = [(sid, os.path.join(raw, sid, f)) for sid in (ids or sorted(os.listdir(raw))) if sid in prompts
        for f in sorted(os.listdir(os.path.join(raw, sid))) if f.endswith('.wav')
        and not os.path.exists(os.path.join(raw, sid, f[:-4] + '.json'))]


def one(job):
    sid, wav = job
    for _ in range(3):
        try:
            v = listen(wav, prompts[sid])
            json.dump(v, open(wav[:-4] + '.json', 'w'), indent=1)
            print(f"{sid} {os.path.basename(wav)}: best {best(v)} | " + '; '.join(
                f"{t.get('score')} {t.get('what', '')[:50]}" for t in v.get('takes', [])[:3]), flush=True)
            return
        except Exception as e:
            print(sid, wav, 'error', e, flush=True)


with ThreadPoolExecutor(jobs) as ex:
    list(ex.map(one, work))
