#!/usr/bin/env python3
"""Cut generated sound candidates into the game's sound files.

    python3 tools/sfx/build.py RAW_DIR REF_DIR [id ...] [--samples DIR]

RAW_DIR is generate.py's output (RAW_DIR/<id>/clipN.wav + clipN.json). REF_DIR holds the sounds they
replace (the old procedural wavs, same file names): each new sound is levelled to the active RMS of
the one it replaces and kept near its length, so the mix and the code stay as they were. Files keep
their names in public/sounds/, mono 16-bit 32 kHz.

Shots: the clip is split at silences into takes; the listener's scores (generate.py) rank them and
the best distinct takes fill the id's files. Loops: the steadiest stretch of the best event, the tail
crossfaded (equal power) into the head so it loops seamlessly.
--samples DIR also writes <id>_before.mp3 / <id>_after.mp3 and one all.mp3 (before, after, before,
after …) with an index, for listening.
"""
import json, os, re, subprocess, sys
import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SOUNDS = os.path.join(ROOT, 'public', 'sounds')
SR = 32000
HOP = 0.01  # envelope hop (s)


def load(path, sr=SR):
    y, s = sf.read(path, always_2d=True)
    y = y.mean(axis=1)
    if s != sr:
        import librosa
        y = librosa.resample(y, orig_sr=s, target_sr=sr)
    return y.astype(np.float64)


def env_db(y, sr=SR):
    h = int(HOP * sr)
    n = max(1, len(y) // h)
    e = np.sqrt(np.mean(y[:n * h].reshape(n, h) ** 2, axis=1) + 1e-12)
    return 20 * np.log10(e)


def active_rms(y, sr=SR):
    e = env_db(y, sr)
    act = e > e.max() - 30
    return float(np.sqrt(np.mean((10 ** (e[act] / 20)) ** 2)))


def highpass(y, sr=SR, f=30.0):
    """One-pole DC/rumble blocker."""
    from scipy.signal import lfilter
    a = np.exp(-2 * np.pi * f / sr)
    return lfilter([1, -1], [1, -a], y) * (1 + a) / 2


def soft_limit(y, knee=0.8, ceil=0.98):
    a = np.abs(y)
    over = a > knee
    r = ceil - knee
    a[over] = knee + r * np.tanh((a[over] - knee) / r)
    return np.sign(y) * a


def segments(y, sr=SR):
    """Takes split at silences: (start s, end s) of stretches above peak-35 dB, gaps >= 0.12 s."""
    e = env_db(y, sr)
    on = e > e.max() - 35
    segs, i, n = [], 0, len(on)
    while i < n:
        if not on[i]:
            i += 1
            continue
        j = i
        quiet = 0
        while j < n and quiet < int(0.12 / HOP):
            quiet = quiet + 1 if not on[j] else 0
            j += 1
        segs.append((i * HOP, (j - quiet) * HOP))
        i = j
    return [s for s in segs if s[1] - s[0] >= 0.08]


def score_of(seg, takes):
    best = 0.0
    for t in takes:
        ov = min(seg[1], float(t.get('end', 0))) - max(seg[0], float(t.get('start', 0)))
        if ov > 0.25 * (seg[1] - seg[0]) or ov > 0.3:
            best = max(best, float(t.get('score', 0)))
    return best


def cut_shot(y, seg, length, sr=SR):
    a = max(0, int((seg[0] - 0.005) * sr))
    # find the real onset: first sample within the take above peak-30 dB
    e = env_db(y[a:int(seg[1] * sr)], sr)
    on = int(np.argmax(e > e.max() - 30) * HOP * sr)
    a = max(0, a + on - int(0.005 * sr))
    natural = seg[1] - a / sr + 0.25
    L = int(min(natural, length) * sr)
    out = y[a:a + L].copy()
    fade = int(min(0.25 * len(out), 0.4 * sr))
    out[-fade:] *= 0.5 * (1 + np.cos(np.linspace(0, np.pi, fade)))
    out[:int(0.003 * sr)] *= np.linspace(0, 1, int(0.003 * sr))
    return out


def cut_loop(y, span, length, sr=SR):
    X = min(1.0, 0.2 * length)
    L, Xn = int(length * sr), int(X * sr)
    a0, a1 = int(span[0] * sr), int(span[1] * sr) - L - Xn
    if a1 <= a0:  # the stretch is too short: take the whole clip's steadiest window
        a0, a1 = 0, len(y) - L - Xn
    if a1 <= a0:
        L = len(y) - Xn - 1
        a0 = a1 = 0
    best, bv = a0, 1e9
    for a in range(a0, a1 + 1, int(0.1 * sr)):
        v = np.std(env_db(y[a:a + L + Xn], sr))
        if v < bv:
            best, bv = a, v
    seg = y[best:best + L + Xn]
    out = seg[:L].copy()
    t = np.linspace(0, np.pi / 2, Xn)
    out[:Xn] = out[:Xn] * np.sin(t) + seg[L:L + Xn] * np.cos(t)
    return out


def mp3(wav_y, path, sr=SR):
    tmp = path + '.tmp.wav'
    sf.write(tmp, wav_y, sr, subtype='PCM_16')
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', tmp, '-b:a', '160k', path], check=True)
    os.remove(tmp)


def verdict(d, c):
    """The listener's verdict; with a second opinion (.b.json) every score is capped at its best."""
    v = json.load(open(os.path.join(d, c)))
    b = os.path.join(d, c[:-5] + '.b.json')
    if os.path.exists(b):
        cap = max([float(t.get('score', 0)) for t in json.load(open(b)).get('takes', [])] or [0])
        for t in v.get('takes', []):
            t['score'] = min(float(t.get('score', 0)), cap)
    return v


def audio_of(d, name):
    base = name[:-5]
    return next(os.path.join(d, base + e) for e in ('.wav', '.flac') if os.path.exists(os.path.join(d, base + e)))


def build(sid, spec, files, raw, ref):
    d = os.path.join(raw, sid)
    clips = sorted(f for f in os.listdir(d) if f.endswith('.json') and not f.endswith('.b.json'))
    # Sound Studio candidates (candN) are one take each; video clips (clipN) hold three
    single = spec['single'] or any(c.startswith('cand') for c in clips)
    if not clips:
        return None
    olds = [load(os.path.join(ref, f)) for f in files]
    old_len = np.mean([len(o) for o in olds]) / SR
    target = np.mean([active_rms(o) for o in olds])
    outs = []
    if spec['kind'] == 'loop':
        cands = []
        for c in clips:
            v = verdict(d, c)
            for t in v.get('takes', []):
                cands.append((float(t.get('score', 0)), float(t.get('end', 0)) - float(t.get('start', 0)), c, t))
        cands.sort(key=lambda k: (-k[0], -k[1]))
        for k in range(len(files)):
            sc, _, c, t = cands[min(k, len(cands) - 1)]
            y = highpass(load(audio_of(d, c)))
            outs.append((cut_loop(y, (float(t['start']), float(t['end'])), max(old_len, spec.get('loop_s', 6))), sc, c))
    else:
        cands = []
        for c in clips:
            v = verdict(d, c)
            y = highpass(load(audio_of(d, c)))
            segs = segments(y)
            if single and segs:  # one long take per clip: from its onset to the clip's end
                segs = [(segs[0][0], len(y) / SR)]
                cands.append((max([float(t.get('score', 0)) for t in v.get('takes', [])] or [0]), segs[0], c, y))
                continue
            for seg in segs:
                cands.append((score_of(seg, v.get('takes', [])), seg, c, y))
        cands.sort(key=lambda k: -k[0])
        for k in range(len(files)):
            sc, seg, c, y = cands[min(k, len(cands) - 1)]
            outs.append((cut_shot(y, seg, max(old_len * 1.25, old_len + 0.3)), sc, c))
    res, short = [], []
    for (y, sc, c), f in zip(outs, files):
        g = target / max(active_rms(y), 1e-9)
        # match the old level, but never push more than 1% of the samples into the limiter
        # (the old synth sirens were near-square waves at full scale; a recording can't be that dense)
        g = min(g, 0.8 / max(np.percentile(np.abs(y), 99), 1e-9))
        y = soft_limit(y * g)
        short.append(target / max(active_rms(y), 1e-9))
        sf.write(os.path.join(SOUNDS, f), y, SR, subtype='PCM_16')
        res.append((f, sc, c, len(y) / SR))
    return res, olds, float(np.mean(short))


def main():
    args = sys.argv[1:]
    samples = None
    if '--samples' in args:
        i = args.index('--samples'); samples = args[i + 1]; del args[i:i + 2]
    raw, ref, ids = args[0], args[1], args[2:]
    sys.path.insert(0, HERE)
    from generate import load_prompts
    prompts = load_prompts(ref)
    manifest = json.load(open(os.path.join(SOUNDS, 'manifest.json')))
    ids = ids or list(prompts)
    main_manifest = json.loads(subprocess.run(['git', 'show', 'origin/main:public/sounds/manifest.json'], cwd=ROOT,
                                              capture_output=True, text=True, check=True).stdout)
    reel, index, t = [], [], 0.0
    gap = np.zeros(int(0.6 * SR))
    for sid in ids:
        files = manifest[sid]['files']
        r = build(sid, prompts[sid], files, raw, ref)
        if not r:
            print(sid, 'no candidates')
            continue
        res, olds, short = r
        # what the limiter cost comes back through the manifest gain (from main's value: reruns stay put)
        base = main_manifest.get(sid, manifest[sid])
        manifest[sid]['gain'] = round(base.get('gain', 1) * min(2.0, short), 3) if short > 1.06 else base.get('gain', 1)
        manifest[sid]['description'] = re.sub(r'\((procedural[^)]*, )?tools/synth\w+\.mjs\)', '(Stable Audio SFX via tools/sfx)',
                                              base['description'])
        for f, sc, c, dur in res:
            print(f'{sid}: {f} <- {c} score {sc:g}, {dur:.2f} s')
        if samples:
            os.makedirs(samples, exist_ok=True)
            news = [load(os.path.join(SOUNDS, f)) for f in files]
            mp3(np.concatenate([np.concatenate([o, gap]) for o in olds]), os.path.join(samples, f'{sid}_before.mp3'))
            mp3(np.concatenate([np.concatenate([n, gap]) for n in news]), os.path.join(samples, f'{sid}_after.mp3'))
            loop = manifest[sid].get('loop')
            for o, n in zip(olds, news):
                o2 = np.tile(o, 2) if loop else o
                n2 = np.tile(n, max(1, int(np.ceil(len(o2) / len(n))))) if loop else n
                index.append(f'{int(t // 60)}:{t % 60:04.1f}  {sid} before')
                reel += [o2, gap]; t += (len(o2) + len(gap)) / SR
                index.append(f'{int(t // 60)}:{t % 60:04.1f}  {sid} after')
                reel += [n2, gap, gap]; t += (len(n2) + 2 * len(gap)) / SR
    with open(os.path.join(SOUNDS, 'manifest.json'), 'w') as fh:
        fh.write(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
    if samples and reel:
        mp3(np.concatenate(reel), os.path.join(samples, 'all.mp3'))
        open(os.path.join(samples, 'all-index.txt'), 'w').write('\n'.join(index) + '\n')


if __name__ == '__main__':
    main()
