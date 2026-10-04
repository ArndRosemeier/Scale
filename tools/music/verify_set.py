"""
Check a built set: file sizes, loop lengths, beat alignment of the locked layers,
and render a demo mix (all layers, variation 0, played twice to hear the loop seam).

  cd tools/music && uv run python verify_set.py <set>
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).parent))
from sets import LOCKED  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
MUSIC = ROOT / 'public' / 'music'

set_id = sys.argv[1]
info = json.loads((MUSIC / 'manifest.json').read_text())['sets'][set_id]
beat = 60 / info['bpm']
L = info['loopSeconds']
mix = None
for layer, files in info['layers'].items():
    for f in files:
        p = MUSIC / f
        x, sr = sf.read(str(p), always_2d=True)
        line = f'{f:24s} {p.stat().st_size / 1024:6.0f} KB  {len(x) / sr:7.3f}s (loop {L:.3f}s)'
        if layer in LOCKED:
            y = librosa.resample(x.mean(axis=1), orig_sr=sr, target_sr=22050)
            oenv = librosa.onset.onset_strength(y=y, sr=22050)
            _, bt = librosa.beat.beat_track(onset_envelope=oenv, sr=22050, start_bpm=info['bpm'], tightness=400, units='time')
            # Offset of each detected beat from the ideal grid starting at 0.
            off = ((bt + beat / 2) % beat) - beat / 2
            line += f'  beat offset median {np.median(off) * 1000:+5.0f} ms, spread {off.std() * 1000:4.0f} ms'
        print(line)
        if f.endswith('_0.ogg'):
            seg = np.concatenate([x, x])  # twice: hear the seam
            mix = seg.copy() if mix is None else mix[:len(seg)] + seg[:len(mix)]
mix /= max(1.0, np.abs(mix).max() / 0.95)
out = ROOT / '.cache' / f'demo-{set_id}.wav'
sf.write(str(out), mix, sr)
print('demo mix:', out)
