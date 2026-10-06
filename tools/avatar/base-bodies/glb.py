"""Minimal GLB reader / writer for the base-body tools (numpy only)."""
import json
import struct

import numpy as np

COMP = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


class Glb:
    def __init__(self, path):
        b = open(path, 'rb').read()
        jl = struct.unpack('<I', b[12:16])[0]
        self.json = json.loads(b[20:20 + jl])
        bl = struct.unpack('<I', b[20 + jl:24 + jl])[0]
        self.bin = bytearray(b[28 + jl:28 + jl + bl])

    def read(self, ai):
        a = self.json['accessors'][ai]
        bv = self.json['bufferViews'][a['bufferView']]
        n = NCOMP[a['type']]
        dt = np.dtype(COMP[a['componentType']])
        off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        stride = bv.get('byteStride', 0)
        if stride and stride != n * dt.itemsize:
            raise ValueError('interleaved buffers are not supported')
        arr = np.frombuffer(self.bin, dt, a['count'] * n, off).reshape(a['count'], n).copy()
        if a.get('normalized'):
            arr = arr.astype(np.float32) / np.iinfo(dt).max
        return arr

    def write(self, ai, arr):
        """Overwrite an accessor in place (same count, type and component type)."""
        a = self.json['accessors'][ai]
        bv = self.json['bufferViews'][a['bufferView']]
        arr = np.ascontiguousarray(arr, COMP[a['componentType']])
        off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        raw = arr.tobytes()
        self.bin[off:off + len(raw)] = raw
        if 'min' in a:
            a['min'] = arr.reshape(a['count'], -1).min(0).tolist()
            a['max'] = arr.reshape(a['count'], -1).max(0).tolist()

    def add_view(self, data, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        v = {'buffer': 0, 'byteOffset': len(self.bin), 'byteLength': len(data)}
        if target:
            v['target'] = target
        self.bin += data
        self.json['bufferViews'].append(v)
        self.json['buffers'][0]['byteLength'] = len(self.bin)
        return len(self.json['bufferViews']) - 1

    def add_image(self, data, name, mime='image/png'):
        bv = self.add_view(data)
        imgs = self.json.setdefault('images', [])
        imgs.append({'bufferView': bv, 'mimeType': mime, 'name': name})
        texs = self.json.setdefault('textures', [])
        if not self.json.get('samplers'):
            self.json['samplers'] = [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 33071, 'wrapT': 33071}]
        texs.append({'sampler': 0, 'source': len(imgs) - 1})
        return len(texs) - 1

    def save(self, path):
        js = json.dumps(self.json, separators=(',', ':')).encode()
        js += b' ' * ((4 - len(js) % 4) % 4)
        bn = bytes(self.bin) + b'\0' * ((4 - len(self.bin) % 4) % 4)
        total = 12 + 8 + len(js) + 8 + len(bn)
        with open(path, 'wb') as f:
            f.write(struct.pack('<III', 0x46546C67, 2, total))
            f.write(struct.pack('<II', len(js), 0x4E4F534A) + js)
            f.write(struct.pack('<II', len(bn), 0x004E4942) + bn)


def quat_mat(q):
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def node_local(n):
    m = np.eye(4)
    if 'matrix' in n:
        return np.array(n['matrix']).reshape(4, 4).T
    r = quat_mat(n.get('rotation', [0, 0, 0, 1]))
    s = np.array(n.get('scale', [1, 1, 1]))
    m[:3, :3] = r * s
    m[:3, 3] = n.get('translation', [0, 0, 0])
    return m


def world_matrices(j):
    nodes = j['nodes']
    parent = {c: i for i, n in enumerate(nodes) for c in n.get('children', [])}
    cache = {}

    def w(i):
        if i not in cache:
            loc = node_local(nodes[i])
            cache[i] = w(parent[i]) @ loc if i in parent else loc
        return cache[i]
    return [w(i) for i in range(len(nodes))], parent
