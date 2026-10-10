#!/usr/bin/env python3
"""Write the job list for Sound Studio (Stable Audio 3 Small-SFX on Arnd's PC, see docs/SOUNDS.md).

    python3 tools/sfx/studio_jobs.py REF_DIR > tools/sfx/studio_jobs.json

One entry per sound id: the prompt in the library's style ("TrackType: SFX, …, no music, no voice"),
the length to generate (at least 3 s: the model turns to noise below ~2 s; loops get room for the
crossfade) and how many candidates (seeds) to make. build.py cuts and levels the results.
"""
import json, math, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate import load_prompts

jobs = []
for sid, p in load_prompts(sys.argv[1]).items():
    if p['kind'] == 'loop':
        secs, n = min(22, math.ceil(max(p['old_s'], 6) + 2)), 2
    else:
        secs, n = min(10, max(3, math.ceil(p['old_s'] + 0.5))), 2 + p['files']
    tail = ', steady and continuous, no fade' if p['kind'] == 'loop' else ''
    jobs.append({'id': sid, 'prompt': f"TrackType: SFX, {p['sound']}{tail}, no music, no voice",
                 'seconds': secs, 'candidates': n})
print(json.dumps(jobs, indent=1, ensure_ascii=False))
