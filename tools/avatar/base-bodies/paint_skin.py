"""
Paint skin and eye textures onto a base body (woman.glb / man.glb) and embed them:
    python3 tools/avatar/base-bodies/paint_skin.py in.glb out.glb [--male] [--ref woman.glb]

Every texel of the body's UV layout is mapped back to its point on the body (3D position,
normal, skin weights), and the colour is computed there from body landmarks found on the
skeleton and mesh: skin tone with mottling and warmer cheeks / ears / knuckles, cavity
shading, lips, areolas, eyebrows, the lash line, painted cropped hair, and (male) stubble.
Since everything is placed on the body itself, the same code fits both bodies; --ref takes
the face landmarks (mouth, nose, chin) from the original body by vertex, where reshaping
could mislead the search. The eyes get
a sclera / iris / pupil texture in their own (radial) UV layout.
"""
import io
import sys

import numpy as np
from PIL import Image

from glb import Glb, world_matrices

SIZE = 2048
EYE_SIZE = 512


# ------------------------------------------------------------------ helpers

def lattice(seed, ijk):
    h = (ijk[..., 0] * 73856093) ^ (ijk[..., 1] * 19349663) ^ (ijk[..., 2] * 83492791) ^ (seed * 2654435761)
    h = (h ^ (h >> 13)) * 1274126177
    return ((h ^ (h >> 16)) & 0xFFFF) / 65535.0


def noise(P, freq, seed=0):
    """3D value noise in [0, 1] (smooth, trilinear with smoothstep)."""
    X = P * freq
    i = np.floor(X).astype(np.int64)
    f = X - i
    f = f * f * (3 - 2 * f)
    out = 0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
                out = out + w * lattice(seed, i + np.array([dx, dy, dz]))
    return out


def fbm(P, freq, octaves=4, seed=0):
    s, a, t = 0, 1.0, 0
    for o in range(octaves):
        s = s + a * noise(P, freq * 2 ** o, seed + o)
        t += a
        a *= 0.5
    return s / t


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def mix(a, b, t):
    return a + (b - a) * np.asarray(t)[..., None]


def srgb(c):
    return np.array(c, dtype=np.float64) / 255.0


def rasterize(uv, tris, size):
    """Per texel: triangle id (-1 = empty) and barycentrics."""
    tid = -np.ones((size, size), np.int32)
    bar = np.zeros((size, size, 3), np.float32)
    px = uv * size - 0.5
    for t, (a, b, c) in enumerate(tris):
        A, B, C = px[a], px[b], px[c]
        x0, y0 = np.floor(np.minimum(np.minimum(A, B), C)).astype(int)
        x1, y1 = np.ceil(np.maximum(np.maximum(A, B), C)).astype(int)
        x0, y0 = max(x0, 0), max(y0, 0)
        x1, y1 = min(x1, size - 1), min(y1, size - 1)
        if x1 < x0 or y1 < y0:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        det = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1])
        if abs(det) < 1e-12:
            continue
        l0 = ((B[1] - C[1]) * (gx - C[0]) + (C[0] - B[0]) * (gy - C[1])) / det
        l1 = ((C[1] - A[1]) * (gx - C[0]) + (A[0] - C[0]) * (gy - C[1])) / det
        l2 = 1 - l0 - l1
        inside = (l0 >= -0.02) & (l1 >= -0.02) & (l2 >= -0.02)
        ys, xs = gy[inside], gx[inside]
        tid[ys, xs] = t
        bar[ys, xs] = np.stack([l0[inside], l1[inside], l2[inside]], 1)
    return tid, bar


def dilate(img, filled, steps):
    """Grow painted texels into the empty ones around UV islands (no seams when mipmapped)."""
    img = img.copy()
    filled = filled.copy()
    for _ in range(steps):
        acc = np.zeros_like(img)
        cnt = np.zeros(filled.shape)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            f = np.roll(np.roll(filled, dy, 0), dx, 1)
            acc += np.roll(np.roll(img, dy, 0), dx, 1) * f[..., None]
            cnt += f
        grow = (~filled) & (cnt > 0)
        img[grow] = acc[grow] / cnt[grow][:, None]
        filled = filled | grow
    img[~filled] = img[filled].mean(0)
    return img


def encode(img, fmt):
    b = io.BytesIO()
    im = Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8))
    if fmt == 'JPEG':
        im.save(b, 'JPEG', quality=90, subsampling=0, optimize=True)
    else:
        im.save(b, 'PNG', optimize=True)
    return b.getvalue()


# ------------------------------------------------------------------ body

def paint_body(P, N, uv, tris, cav, landmarks, male):
    tid, bar = rasterize(uv, tris, SIZE)
    filled = tid >= 0
    t = tid[filled]
    b = bar[filled].astype(np.float64)
    tri = tris[t]
    X = (P[tri] * b[..., None]).sum(1)
    Nn = (N[tri] * b[..., None]).sum(1)
    Nn /= np.linalg.norm(Nn, axis=1, keepdims=True) + 1e-9
    C = (cav[tri] * b).sum(1)
    L = landmarks

    # Base tone, mottling and colour variation.
    base = srgb((222, 170, 138)) if not male else srgb((214, 160, 128))
    col = np.tile(base, (len(X), 1))
    m1 = fbm(X, 18, 4, 1) - 0.5
    m2 = fbm(X, 140, 2, 7) - 0.5
    col *= (1 + 0.10 * m1 + 0.05 * m2)[:, None]
    red = srgb((205, 120, 105))
    # Warm cheeks, nose, ears, lips' surroundings; knees, elbows, knuckles, palms, soles.
    e, hc = L['eyes'], L['headc']
    warm = 0
    for sx in (1, -1):
        warm = warm + 0.35 * np.exp(-((X[:, 0] - sx * 0.042) ** 2 + (X[:, 1] - e[1] + 0.035) ** 2 + ((X[:, 2] - L['facez'] + 0.02) ** 2)) / 0.022 ** 2)
    warm = warm + 0.35 * np.exp(-np.sum((X - L['nose']) ** 2, 1) / 0.014 ** 2)
    ear = (np.abs(X[:, 0]) > L['earx']) & (np.abs(X[:, 1] - e[1]) < 0.045) & (X[:, 1] > L['chin'][1])
    warm = warm + 0.4 * ear
    for k in ('kneeL', 'kneeR', 'elbowL', 'elbowR'):
        warm = warm + 0.2 * np.exp(-np.sum((X - L[k]) ** 2, 1) / 0.035 ** 2)
    warm = warm + 0.25 * L['fingers_w'][tri].__mul__(b).sum(1)
    warm = warm + 0.2 * smoothstep(0.05, 0.0, X[:, 1])  # feet / soles
    col = mix(col, col * red / base, np.clip(warm, 0, 0.6) * (0.9 + 0.4 * m1))
    # Cavities (armpits, navel, folds, between fingers) a little darker and warmer.
    col *= (1 - np.clip(C, 0, 1) * 0.35)[:, None] * np.array([1.0, 0.96, 0.95])
    # Areolas.
    for k in ('tipL', 'tipR'):
        r = 0.011 if male else 0.017
        d = np.hypot(X[:, 0] - L[k][0], X[:, 1] - L[k][1])  # seen from the front
        a = smoothstep(r, r * 0.7, d) * (Nn[:, 2] > 0.2) * (X[:, 2] > L[k][2] - 0.04)
        col = mix(col, col * srgb((170, 110, 100)) / base, a * 0.75)
    # Lips.
    m = L['mouth']
    hu = (L['lipU'][1] - m[1]) * (1.5 if not male else 1.25)
    hl = (m[1] - L['lipL'][1]) * (1.6 if not male else 1.35)
    lx = (X[:, 0] - m[0]) / (0.025 if not male else 0.024)
    up = X[:, 1] > m[1]
    bow = 0.0015 * np.exp(-(X[:, 0] / 0.006) ** 2) * up
    ly = (X[:, 1] - m[1] + bow) / np.where(up, hu, hl)
    lip = smoothstep(1.0, 0.75, np.sqrt(lx ** 2 + ly ** 2)) * (X[:, 2] > m[2] - 0.016)
    lipc = srgb((176, 92, 88)) if not male else srgb((170, 104, 94))
    col = mix(col, lipc * (1 + 0.06 * m2[:, None]), lip * (0.85 if not male else 0.55))
    # Eye surroundings: socket shading, lash line.
    for k in ('eyeL', 'eyeR'):
        c = L[k]
        ev = L['eyeS'][np.sign(L['eyeS'][:, 0]) == np.sign(c[0])]
        near = np.flatnonzero(np.linalg.norm(X - c, axis=1) < 0.035)
        d = np.full(len(X), 1.0)
        for i0 in range(0, len(near), 4096):
            ch = near[i0:i0 + 4096]
            d[ch] = np.sqrt(((X[ch, None, :] - ev[None]) ** 2).sum(2)).min(1)
        frontish = X[:, 2] > c[2]
        lash = smoothstep(0.0032, 0.0012, d) * frontish
        upper = X[:, 1] > c[1] - 0.001
        col = mix(col, srgb((40, 28, 24)), lash * np.where(upper, 0.9 if not male else 0.75, 0.2))
        sock = np.exp(-((X[:, 0] - c[0]) ** 2 / 0.02 ** 2 + (X[:, 1] - c[1] - 0.004) ** 2 / 0.014 ** 2)) * frontish
        col = mix(col, col * srgb((190, 140, 130)) / base, sock * (0.25 if male else 0.35))
        # Eyebrow: an arc above the eye, thicker in the middle, hairs as streaks.
        sx = np.sign(c[0])
        u = (X[:, 0] - c[0]) * sx  # >0 towards the temple
        yb = c[1] + 0.017 + 0.0045 * (1 - ((u - 0.004) / 0.024) ** 2)
        thick = (0.0042 if male else 0.0028) * np.clip(1 - ((u - (-0.004)) / 0.032) ** 2, 0, 1) ** 0.5
        span = smoothstep(-0.024, -0.016, u) * smoothstep(0.031, 0.022, u)
        db = np.abs(X[:, 1] - yb)
        streak = fbm(np.stack([X[:, 0] * 1.0, X[:, 1] * 0.25, X[:, 2]], 1), 900, 2, 11)
        brow = smoothstep(thick + 0.0012, thick * 0.6, db) * span * (X[:, 2] > c[2]) * (0.65 + 0.5 * streak)
        col = mix(col, srgb((58, 40, 30)), np.clip(brow, 0, 0.92))
    # Stubble (male): jaw, chin, upper lip.
    if male:
        yrel = X[:, 1] - e[1]
        az = np.arctan2(X[:, 0] - hc[0], X[:, 2] - hc[2])
        face = smoothstep(1.6, 1.35, np.abs(az))
        cheekline = -0.045 + 0.03 * smoothstep(0.8, 1.35, np.abs(az))
        stub = smoothstep(cheekline + 0.012, cheekline - 0.008, yrel) * face
        stub *= smoothstep(L['chin'][1] - 0.05, L['chin'][1] - 0.01, X[:, 1])
        stub *= 1 - lip
        speck = fbm(X, 2600, 1, 21)
        col = mix(col, srgb((96, 84, 82)), np.clip(stub * (0.32 + 0.3 * (speck - 0.5)), 0, 1))
    # Cropped hair painted on the scalp.
    az = np.arctan2(X[:, 0] - hc[0], X[:, 2] - hc[2])
    if male:
        hl = np.interp(np.abs(az), [0, 0.45, 0.9, 1.25, 1.45, 1.75, 2.4, np.pi], [0.068, 0.066, 0.052, 0.036, 0.03, 0.03, -0.035, -0.07])
    else:
        hl = np.interp(np.abs(az), [0, 0.45, 0.9, 1.25, 1.45, 1.75, 2.4, np.pi], [0.072, 0.07, 0.058, 0.04, 0.036, 0.036, -0.03, -0.075])
    ry = X[:, 1] - e[1] - hl
    hair = smoothstep(-0.002, 0.008, ry + 0.004 * (fbm(X, 300, 2, 31) - 0.5)) * (X[:, 1] > L['chin'][1])
    hair *= ~ear | (X[:, 1] > e[1] + 0.03)
    dirP = np.stack([X[:, 0] * 2.5, X[:, 1] * 0.6, X[:, 2] * 0.3], 1) if not male else X
    strands = fbm(dirP, 700 if not male else 2000, 2, 41)
    hairc = srgb((52, 36, 26)) * (0.75 + 0.5 * strands)[:, None]
    col = mix(col, hairc, hair * (0.97 if not male else 0.82))
    out = np.zeros((SIZE, SIZE, 3))
    out[filled] = np.clip(col, 0, 1)
    return dilate(out, filled, 12)


# ------------------------------------------------------------------ eyes

def paint_eyes(uv, P, tris, iris_rgb):
    """Each eye: iris and pupil centred on its front-most point, painted by distance from the
    eye's forward axis (the eye's own UV layout is radial, so this lands in the disc centre)."""
    tid, bar = rasterize(uv, tris, EYE_SIZE)
    filled = tid >= 0
    tri = tris[tid[filled]]
    b = bar[filled].astype(np.float64)
    X = (P[tri] * b[..., None]).sum(1)
    col = np.zeros((len(X), 3))
    for sx in (1, -1):
        sv = np.sign(P[:, 0]) == sx
        apex = P[sv][np.argmax(P[sv][:, 2])]
        sel = np.sign(X[:, 0]) == sx
        v = X[sel] - apex
        rho = np.hypot(v[:, 0], v[:, 1])
        front = v[:, 2] > -0.006
        rho = np.where(front, rho, 1.0)
        streak = fbm(np.stack([np.arctan2(v[:, 1], v[:, 0]) * 2.5, rho * 60, np.zeros(len(v))], 1), 4, 3, 51)
        iris = srgb(iris_rgb) * (0.65 + 0.7 * streak)[:, None]
        iris = mix(iris, iris * 0.45, smoothstep(0.0035, 0.0059, rho))
        sclera = srgb((236, 230, 224)) * (1 - 0.08 * smoothstep(0.008, 0.016, rho))[:, None]
        cc = mix(iris, sclera, smoothstep(0.0057, 0.0064, rho))
        cc = mix(cc, srgb((8, 6, 6)), smoothstep(0.0024, 0.0019, rho))
        col[sel] = cc
    out = np.zeros((EYE_SIZE, EYE_SIZE, 3))
    out[filled] = col
    return dilate(out, filled, 6)


# ------------------------------------------------------------------ landmarks

def body_landmarks(P, N, j, names, heads, eyeP):
    bi = {n: k for k, n in enumerate(names)}
    L = {}
    eyeL = eyeP[eyeP[:, 0] > 0]
    eyeR = eyeP[eyeP[:, 0] < 0]
    L['eyeL'], L['eyeR'] = eyeL.mean(0), eyeR.mean(0)
    L['eyer'] = np.median(np.linalg.norm(eyeL - eyeL.mean(0), axis=1))
    e = (L['eyeL'] + L['eyeR']) / 2
    L['eyes'] = e
    L['eyeP'] = eyeP
    head = P[P[:, 1] > e[1] - 0.12]
    L['headc'] = np.array([0, e[1], (head[:, 2].max() + head[:, 2].min()) / 2])
    mid = (np.abs(P[:, 0]) < 0.004) & (P[:, 2] > L['headc'][2])
    face = P[mid & (np.abs(P[:, 1] - e[1]) < 0.12)]
    L['facez'] = face[:, 2].max()
    nose = P[mid & (P[:, 1] < e[1]) & (P[:, 1] > e[1] - 0.06)]
    L['nose'] = nose[np.argmax(nose[:, 2])]
    L['mouth'], L['lipU'], L['lipL'] = mouth_landmarks(P, mid, L['nose'])
    chin = P[mid & (P[:, 1] < L['mouth'][1]) & (P[:, 1] > L['mouth'][1] - 0.07)]
    L['chin'] = chin[np.argmin(chin[:, 1])]
    L['neckc'] = heads[bi['Neck']]
    hw = head[np.abs(head[:, 1] - e[1]) < 0.01]
    L['earx'] = np.abs(hw[:, 0]).max() - 0.02
    for s, side in (('L', 'Left'), ('R', 'Right')):
        L['knee' + s] = heads[bi[side + 'LowerLeg']] + np.array([0, 0, 0.045])
        L['elbow' + s] = heads[bi[side + 'LowerArm']] + np.array([0, 0, -0.03])
    return L


def mouth_landmarks(P, mid, nose):
    """Mouth line between the most forward points of the upper and lower lip (midline)."""
    m = P[mid]
    up = m[(m[:, 1] < nose[1] - 0.012) & (m[:, 1] > nose[1] - 0.03)]
    up = up[np.argmax(up[:, 2])]
    lo = m[(m[:, 1] < up[1] - 0.008) & (m[:, 1] > nose[1] - 0.055)]
    lo = lo[np.argmax(lo[:, 2])]
    return (up + lo) / 2, up, lo


def main(src, dst, male, ref=None):
    g = Glb(src)
    j = g.json
    W, _ = world_matrices(j)
    joints = j['skins'][0]['joints']
    names = [j['nodes'][i]['name'] for i in joints]
    heads = np.array([W[i][:3, 3] for i in joints])
    prims = {}
    for m in j['meshes']:
        p = m['primitives'][0]
        prims['eyes' if 'Eye' in m['name'] else 'body'] = p
    pb, pe = prims['body'], prims['eyes']
    P = g.read(pb['attributes']['POSITION']).astype(np.float64)
    N = g.read(pb['attributes']['NORMAL']).astype(np.float64)
    uv = g.read(pb['attributes']['TEXCOORD_0']).astype(np.float64)
    tris = g.read(pb['indices']).reshape(-1, 3)
    Jt = g.read(pb['attributes']['JOINTS_0']).astype(int)
    Wt = g.read(pb['attributes']['WEIGHTS_0']).astype(np.float64)
    eP = g.read(pe['attributes']['POSITION']).astype(np.float64)
    L = body_landmarks(P, N, j, names, heads, eP)
    if ref:
        # Same mesh as the reference body: take the face landmarks found there, by vertex.
        r = Glb(ref)
        rb = [m['primitives'][0] for m in r.json['meshes'] if 'Eye' not in m['name']][0]
        rP = r.read(rb['attributes']['POSITION']).astype(np.float64)
        rW, _ = world_matrices(r.json)
        rh = np.array([rW[i][:3, 3] for i in r.json['skins'][0]['joints']])
        re = [m['primitives'][0] for m in r.json['meshes'] if 'Eye' in m['name']][0]
        RL = body_landmarks(rP, None, r.json, names, rh, r.read(re['attributes']['POSITION']).astype(np.float64))
        for k in ('nose', 'lipU', 'lipL', 'chin'):
            L[k] = P[np.argmin(np.linalg.norm(rP - RL[k], axis=1))]
        L['mouth'] = (L['lipU'] + L['lipL']) / 2
    # Dense points on the eye surface (distance to the eyes decides the lash line).
    et = eP[g.read(pe['indices']).reshape(-1, 3)]
    ws = np.array([[a, b_, 1 - a - b_] for a in np.linspace(0, 1, 5) for b_ in np.linspace(0, 1, 5) if a + b_ <= 1])
    L['eyeS'] = np.einsum('sk,tkd->tsd', ws, et).reshape(-1, 3)
    # Breast tips: the most forward vertex skinned to each breast bone.
    for s in ('L', 'R'):
        k = names.index(f'breast.{s}')
        w = (Wt * (Jt == k)).sum(1)
        cand = np.flatnonzero(w > 0.5)
        if not len(cand):
            cand = np.argsort(-w)[:20]
        L['tip' + s] = P[cand[np.argmax(P[cand, 2])]]
        if male:
            # The flattened chest drew the breast tip inwards: put the nipple where a man's
            # sits instead (about 20 cm apart, a little below the old tip's height).
            tx, ty = (0.098 if s == 'L' else -0.098), L['tip' + s][1] - 0.025
            near = np.flatnonzero(np.hypot(P[:, 0] - tx, P[:, 1] - ty) < 0.03)
            L['tip' + s] = np.array([tx, ty, P[near, 2].max()])
    tipw = np.array([('f_' in n and n.split('.')[1] == '03') or ('thumb.03' in n) for n in names])
    L['fingers_w'] = (Wt * tipw[Jt]).sum(1)
    # Cavity: how far each vertex sits below the mean of its neighbours (along its normal).
    key = np.round(P * 1e5).astype(np.int64)
    _, wid = np.unique(key, axis=0, return_inverse=True)
    wid = wid.ravel()
    n = wid.max() + 1
    Pw = np.zeros((n, 3)); Pw[wid] = P
    Nw = np.zeros((n, 3)); np.add.at(Nw, wid, N)
    Nw /= np.linalg.norm(Nw, axis=1, keepdims=True)
    e = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    e = wid[e]
    e = np.unique(np.concatenate([e, e[:, ::-1]]), axis=0)
    acc = np.zeros((n, 3)); np.add.at(acc, e[:, 0], Pw[e[:, 1]])
    cnt = np.bincount(e[:, 0], minlength=n)[:, None]
    lap = acc / np.maximum(cnt, 1) - Pw
    cv = (lap * Nw).sum(1)
    for _ in range(3):  # blur
        a2 = np.zeros(n); np.add.at(a2, e[:, 0], cv[e[:, 1]]); cv = 0.5 * cv + 0.5 * a2 / np.maximum(cnt[:, 0], 1)
    cav = np.clip(cv / 0.0012, 0, 1)[wid]

    skin = paint_body(P, N, uv, tris, cav, L, male)
    eyes = paint_eyes(g.read(pe['attributes']['TEXCOORD_0']).astype(np.float64), eP,
                      g.read(pe['indices']).reshape(-1, 3), (78, 112, 128) if male else (96, 62, 38))
    ts = g.add_image(encode(skin, 'JPEG'), 'skin', 'image/jpeg')
    te = g.add_image(encode(eyes, 'PNG'), 'eyes')
    for m in j['materials']:
        pbr = m.setdefault('pbrMetallicRoughness', {})
        pbr['baseColorFactor'] = [1, 1, 1, 1]
        pbr['metallicFactor'] = 0
        if 'Eye' in m['name']:
            pbr['baseColorTexture'] = {'index': te}
            pbr['roughnessFactor'] = 0.15
        else:
            pbr['baseColorTexture'] = {'index': ts}
            pbr['roughnessFactor'] = 0.62
        m['doubleSided'] = False
    g.save(dst)
    print(dst, {k: np.round(v, 3).tolist() for k, v in L.items() if k in ('mouth', 'lipU', 'lipL', 'chin', 'nose')})


if __name__ == '__main__':
    ref = sys.argv[sys.argv.index('--ref') + 1] if '--ref' in sys.argv else None
    main(sys.argv[1], sys.argv[2], '--male' in sys.argv, ref)
