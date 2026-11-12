#!/usr/bin/env python3
"""Checks of the ROI draft engine on synthetic labels: outlines, ROI files, the PL line, clean-up, the review
queue and repeatability. Layer-model inference is checked only where PyTorch is installed. No tissue accuracy claim."""
from pathlib import Path
import base64
import contextlib
import hashlib
import io
import json
import math
import sys
import tempfile
import zipfile

import numpy as np
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import roi_draft as D  # noqa: E402
import roi_measure as M  # noqa: E402
from nissl_lab import read_roi_zip  # noqa: E402

PPM = 1.4


def reject(call):
    try:
        call()
    except (ValueError, OSError):
        return
    raise AssertionError('Expected explicit rejection.')


def close(a, b, tolerance=1e-9):
    return abs(a - b) <= tolerance * max(1, abs(b))


def fill(paths, height, width):
    # Independent oracle: even-odd fill from the vertical edges of whole-pixel outlines.
    toggles = np.zeros((height, width + 1), np.int64)
    for path in paths:
        for (x0, y0), (x1, y1) in zip(path, path[1:] + path[:1]):
            assert (x0 == x1) != (y0 == y1), 'Outline step is not along one axis.'
            if x0 == x1:
                toggles[min(y0, y1):max(y0, y1), x0] ^= 1
    return (np.cumsum(toggles, axis=1)[:, :width] % 2).astype(bool)


def section(height=240, width=640, ml=(24, 90), gl=(90, 150), wm=(150, 200), columns=(24, 600)):
    labels = np.zeros((height, width), np.uint8)
    for value, (top, bottom) in ((1, ml), (2, gl), (3, wm)):
        labels[top:bottom, columns[0]:columns[1]] = value
    return labels


def parameters(**changes):
    return dict(json.loads(json.dumps(D.PARAMETERS)), **dict({'pl_band_width_um': 0.0}, **changes))  # the band has its own check


def codes(queue):
    return [(item['tier'], item['code']) for item in queue]


def check_outlines():
    rng = np.random.default_rng(20261110)
    cross = np.ones((3, 3), bool)
    for index in range(80):
        height, width = int(rng.integers(1, 26)), int(rng.integers(1, 26))
        mask = rng.random((height, width)) < (.15, .5, .85)[index % 3]
        paths = D.trace_mask(mask)
        assert np.array_equal(fill(paths, height, width), mask)
        if not mask.any():
            assert paths == []
            continue
        assert M.area_px2({'name': 'Cb', 'kind': 'area', 'paths': paths}) == int(mask.sum())
        parts = ndimage.label(mask)[1]
        holes = ndimage.label(~np.pad(mask, 1), structure=cross)[1] - 1
        assert len(paths) == parts + holes
        for path in paths:
            assert len(path) >= 4 and len({tuple(p) for p in path}) >= 4
            # No vertex lies on a straight run.
            for a, b, c in zip(path, path[1:] + path[:1], path[2:] + path[:2]):
                assert (a[0] == b[0]) != (b[0] == c[0])
    pinch = np.array([[1, 0], [0, 1]], bool)
    assert len(D.trace_mask(pinch)) == 2
    ring = np.ones((5, 5), bool)
    ring[1:4, 1:4] = False
    ring[2, 2] = True
    assert sorted(len(p) for p in D.trace_mask(ring)) == [4, 4, 4]


def check_roi_files(folder):
    square = [[10, 10], [30, 10], [30, 25], [10, 25]]
    hole = [[14, 14], [14, 20], [20, 20], [20, 14]]
    rois = [{'name': 'Cb', 'kind': 'area', 'paths': [square]},
            {'name': 'PL_TOTAL', 'kind': 'polyline', 'paths': [[[0, 0], [40000, 3], [59999, 59999]]]},
            {'name': 'GL+WM', 'kind': 'area', 'paths': [square, hole, [[100, 100], [101, 100], [101, 101], [100, 101]]]}]
    data = D.roi_zip_bytes(rois)
    assert data == D.roi_zip_bytes(json.loads(json.dumps(rois)))
    path = folder / 'written.zip'
    path.write_bytes(data)
    decoded, digest = read_roi_zip(path)
    assert digest == hashlib.sha256(data).hexdigest()
    assert [(r['name'], r['kind'], r['paths']) for r in decoded] == [(r['name'], r['kind'], r['paths']) for r in rois]
    assert [r['type'] for r in decoded] == ['traced', 'polyline', 'composite'], [r['type'] for r in decoded]
    assert M.area_px2(decoded[2]) == 20 * 15 - 6 * 6 + 1
    with zipfile.ZipFile(path) as archive:
        assert archive.namelist() == ['Cb.roi', 'PL_TOTAL.roi', 'GL+WM.roi']
        assert all(info.date_time == (1980, 1, 1, 0, 0, 0) for info in archive.infolist())
    reject(lambda: D.encode_roi('Cb', 'area', [[[0.5, 0], [4, 0], [4, 4]]]))
    reject(lambda: D.encode_roi('Cb', 'area', [[[-1, 0], [4, 0], [4, 4]]]))
    reject(lambda: D.encode_roi('Cb', 'area', []))


def check_cleanup():
    labels = np.zeros((40, 60), np.uint8)
    labels[2:20, 2:58] = 1
    labels[20:38, 2:58] = 2
    assert D.clean_labels(labels, 16)[0] is labels
    speck = labels.copy()
    speck[6:9, 6:9] = 2            # GL speck inside ML
    speck[26:28, 10:12] = 0        # hole inside GL
    speck[19:21, 30:32] = 3        # WM speck with equal ML and GL border: goes to the lower class
    speck[8:10, 40:42] = 3         # two small parts side by side inside ML
    speck[8:10, 42:44] = 2
    cleaned, report = D.clean_labels(speck, 16)
    expected = labels.copy()
    expected[19:21, 30:32] = 1
    assert np.array_equal(cleaned, expected)
    assert report['small_parts'] == 5 and report['parts_reassigned'] == 5 and report['parts_left'] == 0
    assert report['reassigned_px'][2][1] == 13 and report['reassigned_px'][0][2] == 4 and report['reassigned_px'][3][1] == 8
    island = np.zeros((20, 20), np.uint8)
    island[5:8, 5:8] = 1
    cleaned, report = D.clean_labels(island, 16)
    assert not cleaned.any() and report['reassigned_px'][1][0] == 9
    alone = np.ones((3, 3), np.uint8)
    cleaned, report = D.clean_labels(alone, 16)
    assert np.array_equal(cleaned, alone) and report['parts_left'] == 1 and report['parts_reassigned'] == 0


def distance_to_line(point, line):
    best = math.inf
    for a, b in zip(line, line[1:]):
        chord = (b[0] - a[0], b[1] - a[1])
        square = chord[0] ** 2 + chord[1] ** 2
        t = 0 if not square else max(0, min(1, ((point[0] - a[0]) * chord[0] + (point[1] - a[1]) * chord[1]) / square))
        best = min(best, math.dist(point, (a[0] + t * chord[0], a[1] + t * chord[1])))
    return best


def check_purkinje_line(protocol):
    settings = parameters()
    line, report = D.purkinje_line(section(), settings, PPM)
    assert line == [[24, 90], [600, 90]] and close(report['length_um'], 576 / PPM)
    assert report['border_chains'] == report['chains_joined'] == 1 and report['bridge_count'] == report['omitted_chains'] == 0

    def torn(first, last, extra=None):
        labels = section()
        labels[80:100, first:last] = 0
        if extra:
            extra(labels)
        rois, structure = D.draft_rois(labels, protocol, settings)
        records = M.measure(rois, protocol)
        return structure['purkinje_line'], codes(D.review_queue(M.section_qc(records, protocol), structure, [], settings)), records

    pl, queue, records = torn(300, 330)
    assert pl['border_chains'] == pl['chains_joined'] == 2 and pl['bridge_count'] == 1 and pl['omitted_chains'] == 0
    assert close(pl['bridged_length_um'], 30 / PPM) and close(pl['length_um'], 576 / PPM)
    assert close(next(r for r in records if r['name'] == 'PL_TOTAL')['length_um'], 576 / PPM)
    assert (2, 'pl-bridge') not in queue
    pl, queue, _ = torn(300, 400)
    assert pl['bridge_count'] == 1 and close(pl['bridged_length_um'], 100 / PPM) and (2, 'pl-bridge') in queue
    pl, queue, _ = torn(200, 500)
    assert pl['chains_joined'] == 1 and pl['bridge_count'] == 0 and pl['omitted_chains'] == 1
    assert pl['omitted'][0]['reason'] == 'beyond-bridge-limit' and pl['omitted'][0]['bounds'] == [500, 90, 600, 90]
    assert close(pl['omitted_share_of_border'], 100 / 276) and close(pl['length_um'], 176 / PPM)
    assert (1, 'pl-border-left-out') in queue and (2, 'pl-chain-left-out') in queue

    def dot(labels):
        labels[50:53, 100:103] = 2
    pl, queue, _ = torn(300, 330, dot)
    assert pl['omitted_chains'] == 1 and pl['omitted'][0]['reason'] == 'shorter-than-minimum'
    assert close(pl['omitted_edge_length_um'], 12 / PPM) and (2, 'pl-chain-left-out') not in queue
    assert pl['chains_joined'] == 2 and pl['bridge_count'] == 1 and close(pl['length_um'], 576 / PPM)

    none = section()
    none[none == 2] = 3
    rois, structure = D.draft_rois(none, protocol, settings)
    assert 'PL_TOTAL' not in [r['name'] for r in rois] and set(structure['absent']) == {'PL_TOTAL', 'GL_TOTAL'}
    queue = D.review_queue(M.section_qc(M.measure(rois, protocol), protocol), structure, [], settings)
    assert codes(queue).count((1, 'not-drafted-here')) == 2

    rng = np.random.default_rng(7)
    for _ in range(20):
        steps = rng.integers(0, 2, 400)
        chain = [[0, 0]]
        for step in steps:
            chain.append([chain[-1][0] + int(step), chain[-1][1] + 1 - int(step)])
        assert D.simplify(chain, 0) == chain
        previous = None
        for tolerance in (1.0, 2.0, 4.0, 8.0):
            simple = D.simplify(chain, tolerance)
            assert simple[0] == chain[0] and simple[-1] == chain[-1] and all(p in chain for p in simple)
            assert max(distance_to_line(p, simple) for p in chain) <= tolerance + 1e-9
            length = D.polyline_length(simple)
            assert previous is None or length <= previous + 1e-9
            previous = length


def check_structure(protocol):
    settings = parameters()
    labels = section()
    rois, structure = D.draft_rois(labels, protocol, settings)
    assert [r['name'] for r in rois] == D.ROI_ORDER
    records = {r['name']: r for r in M.measure(rois, protocol)}
    um2 = 1 / (PPM * PPM)
    for name, classes in D.AREA_CLASSES.items():
        assert close(records[name]['area_um2'], int(np.isin(labels, classes).sum()) * um2)
    qc = M.section_qc(list(records.values()), protocol)
    assert close(qc['values']['closure_ratio'], 1) and qc['flags'] == []
    assert structure['tissue_parts'] == 1 and structure['detached_parts'] == [] and not structure['main_part_touches_image_border']
    assert D.review_queue(qc, structure, [], settings) == []

    extra = np.zeros((248, 644), np.uint8)
    extra[:240, :640] = section()
    extra[100:140, 606:636] = 1      # separate tissue inside the image
    extra[204:240, 100:160] = 3      # separate tissue that reaches the last labelled row, not the last image row
    inside = D.draft_rois(extra, protocol, settings)[1]
    assert [p['touches_image_border'] for p in inside['detached_parts']] == [False, False]
    rois, edge = D.draft_rois(extra, protocol, settings, (240, 640))
    assert [p['touches_image_border'] for p in edge['detached_parts']] == [True, False]
    assert close(edge['detached_area_share'], (36 * 60 + 40 * 30) / int((extra > 0).sum()))
    queue = D.review_queue(M.section_qc(M.measure(rois, protocol), protocol), edge, [{'cells': 40, 'bounds': [0, 0, 8, 8]}], settings)
    assert codes(queue) == [(1, 'detached-part-at-image-border'), (2, 'detached-part'), (3, 'low-confidence-region')]
    assert [item['rank'] for item in queue] == [1, 2, 3] and queue[0]['bounds'] == [100, 204, 160, 240]
    reject(lambda: D.draft_rois(extra, protocol, settings, (200, 640)))
    touching = section(columns=(0, 600))
    queue = D.review_queue(qc, D.draft_rois(touching, protocol, settings)[1], [], settings)
    assert (1, 'main-part-at-image-border') in codes(queue)
    gap = section()
    gap[110:130, 200:260] = 0
    assert D.draft_rois(gap, protocol, settings)[1]['enclosed_gaps'] == 1
    reject(lambda: D.draft_rois(np.zeros((40, 40), np.uint8), protocol, settings))
    reject(lambda: D.draft_rois(np.full((40, 40), 4, np.uint8), protocol, settings))

    probabilities = np.zeros((4, 30, 40), np.float32)
    probabilities[0] = 1
    probabilities[:, 5:25, 5:35] = np.array([0, 1, 0, 0], np.float32)[:, None, None]
    probabilities[:, 10:15, 10:20] = np.array([0, .55, .45, 0], np.float32)[:, None, None]
    values, regions = D.confidence_signals(probabilities, 8, settings)
    assert values['tissue_cells'] == 600 and close(values['low_margin_share'], 50 / 600) and values['low_margin_regions'] == 1
    # The region is counted after one erosion (5 x 10 cells leave 3 x 8); its bounds are grown back by one cell.
    assert regions == [{'cells': 24, 'bounds': [80, 80, 160, 120]}], regions


def check_writing(folder, protocol):
    settings = parameters()
    labels = section()
    labels[40:44, 300:304] = 2       # a speck the clean-up removes
    source = {'file_name': 'Montage.tif', 'bytes': 1, 'sha256': '0' * 64, 'width': 640, 'height': 240, 'channels': 3}
    model = {'id': 'none', 'sha256': '1' * 64, 'source_in_training_set': False}
    written = []
    for name in ('first', 'second'):
        record, path = D.write_section(folder / name / 'S-1', 'S-1', labels, protocol, settings, source, model) \
            if (folder / name).mkdir() is None else None
        written.append((record, path))
    files = sorted(p.name for p in (folder / 'first' / 'S-1').iterdir())
    assert files == ['S-1.draft-measurement.csv', 'S-1.draft-roi.zip', 'S-1.draft.json']
    for name in files:
        assert (folder / 'first' / 'S-1' / name).read_bytes() == (folder / 'second' / 'S-1' / name).read_bytes(), name
    record, path = written[0]
    raw = path.read_bytes()
    assert json.loads(raw) == record and str(folder).encode() not in raw
    assert record['schema'] == D.DRAFT_SCHEMA and record['status'] == 'draft' and record['approval']['approved'] is False
    assert record['protocol'] == protocol['identity'] and record['engine']['parameters']['status'] == 'proposed'
    assert record['labels']['model_sha256'] != record['labels']['draft_sha256']
    assert record['labels']['cleanup']['reassigned_px'][2][1] == 16
    rois, digest = read_roi_zip(path.parent / record['outputs']['roi']['file'])
    assert digest == record['outputs']['roi']['sha256']
    table = M.read_table(path.parent / record['outputs']['table']['file'])
    assert [row['ROI_Name'] for row in table] == D.ROI_ORDER and all(row['Sample'] == 'S-1' for row in table)
    assert M.compare(M.measure(rois, protocol), table, protocol)['pass']
    assert record['review_queue'] == [] and record['measurement']['flags'] == []
    assert set(record['engine']['code_sha256']) == {'roi_draft.py', 'roi_measure.py', 'nissl_lab.py', 'native_tiff.py'}
    reject(lambda: D.write_section(folder / 'first' / 'S-1', 'S-1', labels, protocol, settings, source, model))
    reject(lambda: D.write_section(folder / 'first' / 'bad name', 'bad name', labels, protocol, settings, source, model))

    entries = []
    for index, bottom in enumerate((90, 120, 90)):
        other = section(ml=(24, bottom), gl=(bottom, 150)) if index != 2 else section(columns=(0, 600))
        record, path = D.write_section(folder / ('S-%d' % (index + 2)), 'S-%d' % (index + 2), other, protocol, settings, source, model)
        entries.append({'record': record, 'folder': path.parent.name, 'file': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    index = D.section_index(entries)
    assert [s['sample'] for s in index['sections']] == ['S-2', 'S-3', 'S-4'] and index['review_order'][0] == 'S-4'
    middle = index['sections'][1]
    ml = [s['values']['ML_TOTAL'] for s in index['sections']]
    assert close(middle['neighbour_deviation']['ML_TOTAL'], abs(ml[1] - (ml[0] + ml[2]) / 2) / ((ml[0] + ml[2]) / 2))
    assert index['sections'][0]['neighbour_deviation'] == {} and index['sections'][0]['largest_neighbour_deviation'] is None
    assert D.neighbour_deviation([1, 4, 3]) == [None, 1.0, None] and D.neighbour_deviation([1, None, 3, 3]) == [None, None, None, None]


def run(arguments):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = D.main(arguments)
    return code, out.getvalue(), err.getvalue()


def check_command(folder):
    image = folder / 'images' / 'Montage.tif'
    image.parent.mkdir()
    image.write_bytes(b'not read')
    model = folder / 'missing-model.json'
    assert run(['--model', str(model), '--section', 'no-equals-sign', '--output', str(folder / 'out-a')])[0] == 2
    assert run(['--model', str(model), '--section', 'A=' + str(image), '--section', 'A=' + str(image), '--output', str(folder / 'out-a')])[0] == 2
    assert run(['--model', str(model), '--section', 'A=' + str(image), '--output', str(folder)])[0] == 2
    assert run(['--model', str(model), '--section', 'A=' + str(image), '--output', str(image.parent / 'drafts')])[0] == 2
    code, out, err = run(['--model', str(model), '--section', 'A=' + str(image), '--output', str(folder / 'out-a')])
    assert code == 2 and err.startswith('Not drafted: ') and out == '' and not (folder / 'out-a').exists()


def check_model(folder):
    """End to end from a TIFF with the synthetic random-weight fixture; needs PyTorch."""
    try:
        import torch  # noqa: F401
    except ImportError:
        return False
    import tifffile
    fixture = json.loads((ROOT / 'qa' / 'fixtures' / 'unet-synthetic.json').read_text(encoding='utf-8'))
    native = fixture['native']
    height, width = native['height'], native['width']
    pixels = np.frombuffer(base64.b64decode(native['image']), np.uint8).reshape(height, width, 3)
    expected = np.frombuffer(base64.b64decode(native['labels']), np.uint8).reshape(height, width)
    bundle_path = folder / 'bundle.json'
    bundle_path.write_text(json.dumps(fixture['model']), encoding='utf-8')
    image = folder / 'synthetic' / 'Montage.tif'
    image.parent.mkdir()
    tifffile.imwrite(image, np.pad(pixels, ((0, 3), (0, 2), (0, 0))), metadata=None)
    bundle, identity, hashes = D.load_bundle(bundle_path)
    network = D.load_network(bundle)
    with D.NativeTiff(image) as tiff:
        reduced = D.reduced_image(tiff, 4)
        probabilities, labels = D.predict(network, bundle, reduced, tiff.height, tiff.width)
    blocks = pixels.reshape(height // 4, 4, width // 4, 4, 3).astype(np.float64).mean(axis=(1, 3))
    assert np.array_equal(reduced, np.floor(blocks + .5).astype(np.uint8))
    assert labels.shape == (height + 3, width + 2) and not labels[height:].any() and not labels[:, width:].any()
    # The fixture was made by another PyTorch build; near-ties of its random weights may fall the other way,
    # so this uses the tolerance the site model check uses.
    different = int((labels[:height, :width] != expected).sum())
    assert different / expected.size < 1e-3, 'Labels differ from the fixture at %d pixels.' % different
    assert close(float(probabilities.sum(0).min()), 1, 1e-5) and close(float(probabilities.sum(0).max()), 1, 1e-5)
    trees = []
    for name in ('run-1', 'run-2'):
        code, out, err = run(['--model', str(bundle_path), '--section', 'SYN-1=' + str(image), '--output', str(folder / name)])
        assert code == 0, err
        trees.append({str(p.relative_to(folder / name)): p.read_bytes() for p in sorted((folder / name).rglob('*')) if p.is_file()})
    assert trees[0] == trees[1] and sorted(trees[0]) == ['SYN-1/SYN-1.draft-measurement.csv', 'SYN-1/SYN-1.draft-roi.zip',
                                                           'SYN-1/SYN-1.draft.json', 'draft-index.json']
    record = json.loads(trees[0]['SYN-1/SYN-1.draft.json'])
    assert record['labels']['labelled_extent'] == {'width': width, 'height': height}
    assert record['model']['sha256'] == hashlib.sha256(bundle_path.read_bytes()).hexdigest()
    assert record['model']['source_in_training_set'] is False and record['source']['sha256'] == hashlib.sha256(image.read_bytes()).hexdigest()
    assert run(['--model', str(bundle_path), '--section', 'SYN-1=' + str(image), '--output', str(folder / 'run-1')])[0] == 2
    return True


def check_purkinje_band(protocol):
    """The Purkinje layer band: model ML within 20 um of GL, measured through ML, leaves ML_TOTAL and gets no ROI."""
    assert D.PARAMETERS['pl_band_width_um'] == 20.0 and D.PARAMETERS['pl_band_side'] == 'ML'
    width = int(round(20.0 * PPM))                                  # 28 px
    labels = np.zeros((260, 400), np.uint8)
    labels[20:100, 20:300], labels[100:160, 20:300], labels[160:200, 20:300] = 1, 2, 3   # ML over GL over WM
    labels[20:100, 320:380] = 1                                     # ML across a gap from everything else
    labels[210:240, 20:300] = 1                                     # ML touching WM only, never GL
    labels[200:210, 20:300] = 3
    band = D.purkinje_band(labels, width)
    assert band[100 - width:100, 30:290].all() and not band[:100 - width - 1, :].any(), 'The band is the strip of ML next to GL'
    assert not band[:, 320:380].any() and not band[210:240].any() and not (band & (labels != 1)).any()
    assert not D.purkinje_band(labels, 0).any() and not D.purkinje_band(np.where(labels == 2, 3, labels), width).any()
    # Through ML only: ML that is near GL in a straight line but separated by background is not reached.
    folded = labels.copy()
    folded[90:100, 20:300] = 0
    assert not D.purkinje_band(folded, width).any()
    rois, structure = D.draft_rois(labels, protocol, parameters(pl_band_width_um=20.0))
    named = {r['name']: r for r in rois}
    ml_px = int((labels == 1).sum())
    assert M.area_px2(named['ML_TOTAL']) == ml_px - int(band.sum()) and M.area_px2(named['Cb']) == int((labels > 0).sum())
    assert M.area_px2(named['GL_TOTAL']) == int((labels == 2).sum()) and M.area_px2(named['WM']) == int((labels == 3).sum())
    assert structure['purkinje_band']['pixels'] == int(band.sum()) and structure['purkinje_band']['width_um'] == 20.0
    assert close(structure['purkinje_band']['area_um2'], band.sum() / PPM / PPM) and structure['purkinje_band']['side'] == 'ML'
    assert named['PL_TOTAL']['kind'] == 'polyline', 'PL_TOTAL stays the line along the GL edge of the band'
    values = M.section_qc(M.measure(rois, protocol), protocol)['values']
    assert close(values['unassigned_um2'], band.sum() / PPM / PPM), 'What no layer ROI covers inside Cb is the band'
    # Without a width, as in drafts made before the band existed, ML_TOTAL is all of the model's ML.
    plain, before = D.draft_rois(labels, protocol, parameters())
    assert M.area_px2({r['name']: r for r in plain}['ML_TOTAL']) == ml_px and before['purkinje_band']['pixels'] == 0
    legacy = {k: v for k, v in parameters().items() if not k.startswith('pl_band')}
    assert D.draft_rois(labels, protocol, legacy)[0] == plain
    reject(lambda: D.draft_rois(labels, protocol, parameters(pl_band_width_um=20.0, pl_band_side='GL')))


def main():
    protocol = M.load_protocol()
    assert protocol['calibration']['pixels_per_micron'] == PPM
    check_outlines()
    with tempfile.TemporaryDirectory() as temporary:
        folder = Path(temporary).resolve()
        check_roi_files(folder)
        check_cleanup()
        check_purkinje_line(protocol)
        check_purkinje_band(protocol)
        check_structure(protocol)
        (folder / 'writing').mkdir()
        check_writing(folder / 'writing', protocol)
        (folder / 'command').mkdir()
        check_command(folder / 'command')
        (folder / 'model').mkdir()
        with_model = check_model(folder / 'model')
    print('ROI draft checks passed on synthetic labels' + (', including model inference on the synthetic fixture.' if with_model
          else '. Model inference was not checked: PyTorch is not installed here.'))


if __name__ == '__main__':
    main()
