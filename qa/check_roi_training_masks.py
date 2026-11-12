#!/usr/bin/env python3
"""Analytic and independent point-in-polygon checks; no real tissue accuracy claim."""
from pathlib import Path
from copy import deepcopy
from collections import Counter
import hashlib
import math
import struct
import sys
import tempfile
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import roi_training_masks as M
from nissl_lab import read_roi_zip


def area(name, paths):
    return {'name': name, 'kind': 'area', 'closed': True, 'paths': paths}


def box(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def reject(call):
    try:
        call()
    except ValueError:
        return
    raise AssertionError('Expected explicit rejection.')


def contains(paths, x, y):
    # Independent per-point ray crossing oracle, not the scanline implementation.
    value = False
    for path in paths:
        for a, b in zip(path, path[1:] + path[:1]):
            if (a[1] > y) != (b[1] > y):
                if x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
                    value = not value
    return value


def oracle(rois, w, h):
    chosen = {r['name']: r for r in rois}
    cb, labels = bytearray(), bytearray()
    for y in range(h):
        for x in range(w):
            hit = [contains(chosen[n]['paths'], x + .5, y + .5) for n in M.REQUIRED]
            tissue = [i for i, flag in enumerate(hit[1:], 1) if flag]
            cb.append(1 if hit[0] else 255 if tissue else 0)
            labels.append(tissue[0] if hit[0] and len(tissue) == 1 else 255 if hit[0] or tissue else 0)
    return bytes(cb), bytes(labels)


def main():
    rois = [area('Cb', [box(1, 1, 11, 9), box(5, 3, 7, 5)]),
            area('ML_TOTAL', [box(.5, 2, 5.5, 7)]),
            area('GL_TOTAL', [box(4, 2, 9, 8)]),
            area('WM', [box(7, 6, 10, 9)]),
            area('GL+WM', [box(1, 1, 11, 9)]),
            {'name': 'PL_TOTAL', 'kind': 'polyline', 'closed': False,
             'paths': [[[2, 3], [4, 4], [6, 3]]]}]
    before = deepcopy(rois)
    renderer = M.TrainingMasks(rois, 12, 10)
    full = renderer.render_window(0, 0, 12, 10)
    expected = oracle(rois, 12, 10)
    assert (full['cb'], full['layers']) == expected
    assert full['qc']['layer_overlap_pixels'] > 0
    assert full['qc']['layer_outside_cb_pixels'] > 0
    assert full['qc']['unassigned_inside_cb_pixels'] > 0
    assert full['layers'][3 * 12 + 5] == 255  # layer conflicts with the CB hole
    assert full['cb'][3 * 12 + 5] == 255
    assert full['layers'][1 * 12 + 1] == 255  # GL+WM never supplies an exclusive class
    assert full['layers'][0] == full['cb'][0] == 0
    assert renderer.metadata['PL_TOTAL_kind'] == 'polyline'
    assert renderer.metadata['geometry_modified'] is False
    combined = {'cb': bytearray(120), 'layers': bytearray(120)}
    counts = Counter()
    windows = [(x, y, min(5, 12 - x), min(3, 10 - y))
               for y in range(0, 10, 3) for x in range(0, 12, 5)]
    for x, y, w, h in reversed(windows):
        tile = renderer.render_window(x, y, w, h)
        counts.update(tile['qc'])
        for name in combined:
            for row in range(h):
                combined[name][(y + row) * 12 + x:(y + row) * 12 + x + w] = tile[name][row * w:(row + 1) * w]
    assert all(bytes(combined[n]) == full[n] for n in combined)
    assert dict(counts) == full['qc']
    assert rois == before

    # Crossing and subpixel geometry, including even-odd hole with the same orientation.
    varied = deepcopy(rois)
    varied[1]['paths'] = [[[1.25, 1.25], [9.25, 8.25], [1.25, 8.25], [9.25, 1.25]]]
    varied[2]['paths'] = [box(1.5, 1.5, 10.5, 8.5), box(3.5, 3.5, 8.5, 6.5)]
    varied[-1] = area('PL_TOTAL', [box(2, 2, 4, 4)])
    changed = M.TrainingMasks(varied, 12, 10)
    got = changed.render_window(0, 0, 12, 10)
    assert (got['cb'], got['layers']) == oracle(varied, 12, 10)
    assert changed.metadata['PL_TOTAL_kind'] == 'area'
    assert changed.metadata['PL_quantification_performed'] is False
    assert all(len(got[k]) == 120 for k in ('cb', 'layers'))

    reject(lambda: M.TrainingMasks(rois[1:], 12, 10))
    reject(lambda: M.TrainingMasks(rois + [deepcopy(rois[0])], 12, 10))
    malformed = deepcopy(rois); malformed[0]['kind'] = 'polyline'
    reject(lambda: M.TrainingMasks(malformed, 12, 10))
    malformed = deepcopy(rois); malformed[0]['paths'] = [[[1, 1], [2, 2], [3, 3]]]
    reject(lambda: M.TrainingMasks(malformed, 12, 10))
    for bad in (-1, float('inf'), float('nan'), True):
        malformed = deepcopy(rois); malformed[0]['paths'][0][0][0] = bad
        reject(lambda: M.TrainingMasks(malformed, 12, 10))
    reject(lambda: renderer.render_window(-1, 0, 1, 1))
    reject(lambda: renderer.render_window(11, 0, 2, 1))
    reject(lambda: M.TrainingMasks(rois, 100000, 1))
    prior = M.MAX_SCAN_INTERSECTIONS
    try:
        M.MAX_SCAN_INTERSECTIONS = 2
        reject(lambda: M.TrainingMasks(rois, 12, 10))
    finally:
        M.MAX_SCAN_INTERSECTIONS = prior

    # Real ImageJ ZIP decoder integration preserves exact supplied archive bytes.
    with tempfile.TemporaryDirectory() as temp:
        source = Path(temp) / 'final.zip'
        with zipfile.ZipFile(source, 'w') as archive:
            for name in M.REQUIRED:
                data = bytearray(64)
                data[:4] = b'Iout'; struct.pack_into('>H', data, 4, 227); data[6] = 1
                struct.pack_into('>4h', data, 8, 1, 1, 9, 11)
                archive.writestr(name + '.roi', data)
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        decoded, actual = read_roi_zip(source)
        all_overlap = M.TrainingMasks(decoded, 12, 10).render_window(0, 0, 12, 10)
        assert all_overlap['qc']['layer_overlap_pixels'] == 80
        assert all_overlap['qc']['layer_unknown_pixels'] == 80
        assert actual == digest == hashlib.sha256(source.read_bytes()).hexdigest()

    # >40M native grid and 100k original vertices: no full-grid mask allocation.
    native = [area('Cb', [[[5000 + 4000 * math.cos(i * math.tau / 100000),
                           3500 + 3000 * math.sin(i * math.tau / 100000)] for i in range(100000)]]),
              area('ML_TOTAL', [box(2000, 2000, 4000, 5000)]),
              area('GL_TOTAL', [box(4000, 2000, 6000, 5000)]),
              area('WM', [box(6000, 2000, 8000, 5000)])]
    big = M.TrainingMasks(native, 10000, 7000)
    small = big.render_window(4990, 3490, 20, 20)
    assert len(small['cb']) == 400 and set(small['cb']) == {1}
    assert set(small['layers']) == {2}
    assert big.metadata['stored_spans'] < 40000
    print('PASS: independent pixel-centre oracle; holes, self-crossings, subpixels; window-order/tile equivalence; overlaps/outside/unassigned unknown; combined regions and PL geometry retained; ZIP bytes preserved; bounded >40M grid/100k vertices. Synthetic labels only.')


if __name__ == '__main__':
    main()
