#!/usr/bin/env python3
"""Analytic checks of ROI geometry, naming and review signals on synthetic shapes; no tissue accuracy claim."""
from pathlib import Path
import copy
import csv
import json
import math
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import roi_measure as M

UM = 1 / 1.4


def roi(name, paths, kind='area', shape='polygon'):
    return {'name': name, 'kind': kind, 'type': shape, 'paths': paths}


def box(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def close(a, b, tolerance=1e-9):
    return abs(a - b) <= tolerance * max(1, abs(b))


def reject(call):
    try:
        call()
    except ValueError:
        return
    raise AssertionError('Expected explicit rejection.')


def pixel_count(paths, width, height):
    # Independent oracle: even-odd pixel-centre counting, not the shoelace formula.
    total = 0
    for y in range(height):
        for x in range(width):
            inside = False
            for path in paths:
                for a, b in zip(path, path[1:] + path[:1]):
                    if (a[1] > y + .5) != (b[1] > y + .5) and x + .5 < (b[0] - a[0]) * (y + .5 - a[1]) / (b[1] - a[1]) + a[0]:
                        inside = not inside
            total += inside
    return total


def section():
    """A consistent synthetic section: Cb 100 x 60, ML 100 x 30, GL 100 x 20, WM 100 x 8."""
    return [
        roi('Cb', [box(0, 0, 100, 60)], shape='traced'),
        roi('PL_TOTAL', [[[0, 30], [100, 30]]], 'polyline', 'polyline'),
        roi('ML_TOTAL', [box(0, 0, 100, 30)]),
        roi('GL_TOTAL', [box(0, 30, 100, 50)]),
        roi('WM', [box(0, 50, 100, 58)]),
        roi('GL+WM', [box(0, 30, 100, 58)]),
        roi('PL_3Cb_part1', [[[0, 30], [60, 30]]], 'polyline', 'polyline'),
        roi('ML_3Cb_part1', [box(0, 0, 60, 30)]),
        roi('GL_3Cb_part1', [box(0, 30, 60, 50)]),
        roi('PL_FI_part1', [[[60, 30], [100, 30]]], 'polyline', 'polyline'),
        roi('ML_FI_part1', [box(60, 0, 100, 30)]),
        roi('GL_FI_part1', [box(60, 30, 100, 50)]),
        roi('FISSURE_prf', [[[60, 0], [60, 50]]], 'polyline', 'polyline'),
    ]


def codes(qc):
    return [flag['code'] for flag in qc['flags']]


def main():
    protocol = M.load_protocol()
    assert protocol['identity']['status'] == 'draft' and protocol['identity']['approved'] is False
    assert len(protocol['identity']['sha256']) == 64

    # Names: totals, local parts, aliases, fissures and anything else.
    assert M.parse_name('GL+WM', protocol)['tissue'] == 'GL+WM'
    local = M.parse_name('ML_4/5Cb_part2', protocol)
    assert (local['role'], local['tissue'], local['region'], local['label'], local['part'], local['alias']) == (
        'local', 'ML', '4-5Cb', '4/5Cb', 2, '4/5Cb')
    assert M.parse_name('PL_PFI_part1', protocol)['region'] == 'PFl'
    assert M.parse_name('GL_Crus1_part1', protocol)['alias'] is None
    assert M.parse_name('ML_Xyz_part1', protocol)['known'] is False
    assert M.parse_name('FISSURE_Cop', protocol)['known'] and not M.parse_name('FISSURE_zzz', protocol)['known']
    for name in ('ML_3Cb_part0', 'ML_3Cb', 'XX_3Cb_part1', 'FISSURE_', 'cb', 'ML_TOTAL_copy'):
        assert M.parse_name(name, protocol)['role'] == 'unknown', name

    # Area: analytic values, a hole, and an independent pixel count of an irregular integer polygon.
    assert M.area_px2(roi('a', [box(2, 3, 12, 23)])) == 200
    assert M.area_px2(roi('a', [box(0, 0, 10, 10), box(2, 2, 6, 6)[::-1]], shape='composite')) == 84
    assert M.area_px2(roi('a', [box(0, 0, 4, 4), box(10, 0, 14, 4)], shape='composite')) == 32
    stair = [[1, 1], [9, 1], [9, 4], [6, 4], [6, 8], [3, 8], [3, 5], [1, 5]]
    assert M.area_px2(roi('a', [stair])) == pixel_count([stair], 12, 12) == 38
    assert M.area_px2(roi("a", [stair[::-1]])) == 38
    assert close(M.area_px2(roi('a', [[[0, 0], [4.5, 0], [0, 3]]])), 6.75)

    # Length and perimeter rules.
    assert M.length_px(roi('l', [[[0, 0], [3, 4], [3, 10]]], 'polyline', 'polyline')) == 11
    assert M.perimeter_px(roi('p', [box(0, 0, 10, 20)])) == (60, 'polygon')
    value, method = M.perimeter_px(roi('t', [box(0, 0, 10, 10)], shape='traced'))
    assert method == 'traced' and close(value, 40 - 4 * (2 - math.sqrt(2)))
    value, method = M.perimeter_px(roi('t', [stair], shape='traced'))
    assert close(value, 30 - 8 * (2 - math.sqrt(2)))
    triangle = [[0, 0], [3, 0], [0, 4]]
    value, method = M.perimeter_px(roi('c', [box(0, 0, 10, 10), triangle], shape='composite'))
    assert method == 'composite' and close(value, 40 - 4 * (2 - math.sqrt(2)) + 12)
    assert M.perimeter_px(roi('f', [stair], shape='freehand')) == (None, 'not-reproduced')
    assert M.perimeter_px(roi('t', [[[0, 0], [2.5, 0], [0, 2]]], shape='traced')) == (None, 'not-reproduced')
    assert M.perimeter_px(roi('l', [[[0, 0], [3, 4]]], 'polyline', 'polyline')) == (5, 'path-length')

    # Outline construction: the path enclosing the largest area decides, whatever the ROI type says.
    free = [[0, 0], [100, 0], [100, 30], [50, 31], [0, 30]]
    assert M.outline_construction(roi('a', [box(0, 0, 10, 10)])) == ('pixel-edge', 4)
    assert M.outline_construction(roi('a', [stair], shape='traced')) == ('pixel-edge', 8)
    assert M.outline_construction(roi('a', [triangle], shape='traced')) == ('free-polygon', 3)
    assert M.outline_construction(roi('a', [[[0, 0], [10.5, 0], [10.5, 10], [0, 10]]])) == ('free-polygon', 4)
    assert M.outline_construction(roi('a', [box(0, 0, 2, 2), free], shape='composite')) == ('free-polygon', 5)
    assert M.outline_construction(roi('a', [triangle, box(0, 0, 20, 20), stair], shape='composite')) == ('pixel-edge', 4)
    assert M.outline_construction(roi('l', [[[0, 0], [3, 0]]], 'polyline', 'polyline')) == (None, None)

    # Records and table rows.
    records = M.measure(section(), protocol)
    by = {r['name']: r for r in records}
    assert close(by['Cb']['area_um2'], 6000 * UM * UM) and by['Cb']['length_um'] is None
    assert close(by['PL_TOTAL']['length_um'], 100 * UM) and by['PL_TOTAL']['area_um2'] is None
    assert by['ML_3Cb_part1']['bounds'] == [0, 0, 60, 30] and by['FISSURE_prf']['role'] == 'fissure'
    assert (by['Cb']['outline_construction'], by['Cb']['outline_vertices']) == ('pixel-edge', 4)
    assert (by['PL_TOTAL']['outline_construction'], by['PL_TOTAL']['outline_vertices']) == (None, None)
    rows = M.table_rows(records, 'S-1')
    assert [r['ROI_Name'] for r in rows] == [r['name'] for r in section()[:-1]]
    assert list(rows[0]) == M.COLUMNS
    assert rows[0]['Area'] == '%.3f' % (6000 / 1.96) and rows[0]['Length'] == 'NaN' and rows[0]['Mean'] == 'NaN'
    assert rows[1]['Length'] == '%.3f' % (100 / 1.4) and rows[1]['Area'] == 'NaN'
    assert (rows[9]['Tissue_Type'], rows[9]['ROI_Level'], rows[9]['Region'], rows[9]['Part']) == ('PL', 'Local', 'Fl', '1')
    reject(lambda: M.measure([roi('Cb', [])], protocol))
    reject(lambda: M.measure([{'name': 'x', 'kind': 'point', 'type': 'point', 'paths': [[[1, 1]]]}], protocol))

    # Comparison with a recorded table, including an old alias label and the recorded line-area artefact.
    recorded = copy.deepcopy(rows)
    for row in recorded:
        if row['Region'] == 'Fl':
            row['Region'] = 'FI'
        if row['Length'] != 'NaN':
            row['Area'] = '123.456'
        else:
            row['Length'] = '0.000'
    report = M.compare(records, recorded, protocol)
    assert report['pass'] and report['rows_compared'] == 12
    assert report['fields']['Area']['compared'] == 9 and report['fields']['Length']['compared'] == 3
    within, outside = copy.deepcopy(recorded), copy.deepcopy(recorded)
    within[2]['Area'] = '%.3f' % (float(recorded[2]['Area']) * 1.0009)
    outside[2]['Area'] = '%.3f' % (float(recorded[2]['Area']) * 1.002)
    assert M.compare(records, within, protocol)['pass']
    bad = M.compare(records, outside, protocol)
    assert not bad['pass'] and bad['fields']['Area']['outside_tolerance'] == ['ML_TOTAL']
    short = M.compare(records, recorded[:-1], protocol)
    assert not short['pass'] and short['missing_in_table'] == ['GL_FI_part1']
    extra = M.compare(records[:-2] + records[-1:], recorded, protocol)
    assert not extra['pass'] and extra['missing_in_roi_file'] == ['GL_FI_part1']
    wrong = copy.deepcopy(recorded)
    wrong[7]['Region'] = '6Cb'
    assert M.compare(records, wrong, protocol)['label_mismatches'] == ['ML_3Cb_part1']
    assert not M.compare(records, [], protocol)['pass']
    blank = copy.deepcopy(recorded)
    blank[0]['Perimeter'] = 'NaN'
    assert M.compare(records, blank, protocol)['pass']

    # Review signals.
    qc = M.section_qc(records, protocol, ['3Cb', 'Fl'])
    assert close(qc['values']['closure_ratio'], 5800 / 6000) and close(qc['values']['gl_wm_consistency'], 1)
    assert all(close(v, 1) for v in qc['values']['local_to_total'].values())
    assert codes(qc) == ['alias-label'] and qc['values']['lobules'] == ['3Cb', 'Fl']
    assert qc['values']['layer_outline'] == 'pixel-edge' and qc['values']['outline'] == {
        'ML_TOTAL': {'construction': 'pixel-edge', 'vertices': 4}, 'GL_TOTAL': {'construction': 'pixel-edge', 'vertices': 4}}
    assert close(qc['values']['unassigned_um2'], 200 * UM * UM)
    assert close(qc['values']['unassigned_per_pl_length_um'], 2 * UM)

    def changed(edit, expected=None):
        rois = section()
        edit(rois)
        return codes(M.section_qc(M.measure(rois, protocol), protocol, expected))

    def replace(rois, name, new):
        rois[[r['name'] for r in rois].index(name)] = new

    assert 'total-missing' in changed(lambda r: r.pop(4))

    # Outline construction and the unassigned band between the layers.
    def judged(edit):
        rois = section()
        edit(rois)
        return M.section_qc(M.measure(rois, protocol), protocol)

    def flags_of(qc, code):
        return [f for f in qc['flags'] if f['code'] == code]

    free_gl = [[0, 30], [100, 30], [100, 50], [50, 51], [0, 50]]
    mixed = judged(lambda r: replace(r, 'ML_TOTAL', roi('ML_TOTAL', [free])))
    assert mixed['values']['layer_outline'] == 'mixed'
    assert flags_of(mixed, 'layer-outline-not-pixel-edge') == [{
        'priority': 2, 'code': 'layer-outline-not-pixel-edge',
        'detail': 'ML_TOTAL free-polygon 5 vertices, GL_TOTAL pixel-edge 4 vertices'}]
    both = judged(lambda r: (replace(r, 'ML_TOTAL', roi('ML_TOTAL', [free])), replace(r, 'GL_TOTAL', roi('GL_TOTAL', [free_gl]))))
    assert both['values']['layer_outline'] == 'free-polygon' and len(flags_of(both, 'layer-outline-not-pixel-edge')) == 1
    traced = judged(lambda r: replace(r, 'ML_TOTAL', roi('ML_TOTAL', [box(0, 0, 100, 30), box(40, 10, 44, 14)[::-1]], shape='composite')))
    assert traced['values']['layer_outline'] == 'pixel-edge' and not flags_of(traced, 'layer-outline-not-pixel-edge')
    other = judged(lambda r: replace(r, 'WM', roi('WM', [[[0, 50], [100, 50], [100, 58], [50, 58.5], [0, 58]]])))
    assert other['values']['layer_outline'] == 'pixel-edge' and not flags_of(other, 'layer-outline-not-pixel-edge')
    absent = judged(lambda r: r.pop(2))
    assert absent['values']['layer_outline'] is None and absent['values']['outline'] == {
        'GL_TOTAL': {'construction': 'pixel-edge', 'vertices': 4}}
    assert not flags_of(absent, 'layer-outline-not-pixel-edge') and absent['values']['unassigned_um2'] is None

    # With ML h px deep the band is 32 - h px of area per px of Purkinje line; test both sides of the limit.
    limit_px = protocol['qc']['unassigned_per_pl_length_um']['review_above'] / UM
    assert 2 < 32 - limit_px < 30
    at_limit = math.ceil(32 - limit_px)
    narrow = judged(lambda r: replace(r, 'ML_TOTAL', roi('ML_TOTAL', [box(0, 0, 100, at_limit)])))
    wide = judged(lambda r: replace(r, 'ML_TOTAL', roi('ML_TOTAL', [box(0, 0, 100, at_limit - 1)])))
    assert close(narrow['values']['unassigned_per_pl_length_um'], (32 - at_limit) * UM) and not flags_of(narrow, 'unassigned-band-wide')
    assert close(wide['values']['unassigned_per_pl_length_um'], (33 - at_limit) * UM)
    assert flags_of(wide, 'unassigned-band-wide') == [{
        'priority': 2, 'code': 'unassigned-band-wide', 'detail': '%.1f um per PL length' % ((33 - at_limit) * UM)}]
    area_pl = judged(lambda r: (replace(r, 'ML_TOTAL', roi('ML_TOTAL', [box(0, 0, 100, 2)])),
                                replace(r, 'PL_TOTAL', roi('PL_TOTAL', [box(0, 29, 100, 31)]))))
    assert area_pl['values']['unassigned_per_pl_length_um'] is None and not flags_of(area_pl, 'unassigned-band-wide')
    assert close(area_pl['values']['unassigned_um2'], 3000 * UM * UM)
    overlap = judged(lambda r: replace(r, 'ML_TOTAL', roi('ML_TOTAL', [box(0, 0, 100, 40)])))
    assert close(overlap['values']['unassigned_per_pl_length_um'], -8 * UM) and not flags_of(overlap, 'unassigned-band-wide')
    assert 'closure-outside-range' in changed(lambda r: replace(r, 'ML_TOTAL', roi('ML_TOTAL', [box(0, 0, 100, 20)])))
    assert 'closure-outside-range' in changed(lambda r: replace(r, 'ML_TOTAL', roi('ML_TOTAL', [box(0, 0, 100, 40)])))
    assert 'gl-wm-inconsistent' in changed(lambda r: replace(r, 'GL+WM', roi('GL+WM', [box(0, 30, 100, 59)])))
    assert 'local-exceeds-total' in changed(lambda r: replace(r, 'ML_FI_part1', roi('ML_FI_part1', [box(50, 0, 100, 30)])))
    assert 'local-below-total' in changed(lambda r: replace(r, 'GL_FI_part1', roi('GL_FI_part1', [box(70, 30, 100, 50)])))
    assert 'local-below-total' in changed(lambda r: replace(r, 'PL_FI_part1', roi('PL_FI_part1', [[[70, 30], [100, 30]]], 'polyline', 'polyline')))
    band = changed(lambda r: replace(r, 'PL_TOTAL', roi('PL_TOTAL', [box(0, 29, 100, 31)])))
    assert 'pl-total-area-band' in band and 'geometry-not-allowed' not in band
    assert 'pl-local-area-band' in changed(lambda r: replace(r, 'PL_FI_part1', roi('PL_FI_part1', [box(60, 29, 100, 31)])))
    assert 'geometry-not-allowed' in changed(lambda r: replace(r, 'WM', roi('WM', [[[0, 50], [100, 50]]], 'polyline', 'polyline')))
    assert 'part-number-gap' in changed(lambda r: replace(r, 'GL_FI_part1', roi('GL_FI_part2', [box(60, 30, 100, 50)])))
    assert 'lobule-layer-missing' in changed(lambda r: r.pop(11))
    assert 'name-not-in-protocol' in changed(lambda r: r.append(roi('Scratch', [box(0, 0, 2, 2)])))
    assert 'lobule-unknown' in changed(lambda r: r.append(roi('ML_Xyz_part1', [box(0, 0, 2, 2)])))
    assert 'fissure-label-unknown' in changed(lambda r: r.append(roi('FISSURE_zzz', [[[0, 0], [2, 2]]], 'polyline', 'polyline')))
    assert 'fissure-label-single-use' in changed(lambda r: r.append(roi('FISSURE_sec', [[[0, 0], [2, 2]]], 'polyline', 'polyline')))
    assert 'expected-lobule-missing' in changed(lambda r: None, ['3Cb', 'FI', '6Cb'])
    assert 'lobule-not-expected' in changed(lambda r: None, ['3Cb'])

    # Protocol validation and file handling.
    with tempfile.TemporaryDirectory() as folder:
        folder = Path(folder)
        source = json.loads(M.DEFAULT_PROTOCOL.read_text(encoding='utf-8'))

        def variant(edit):
            value = copy.deepcopy(source)
            edit(value)
            path = folder / 'protocol.json'
            path.write_text(json.dumps(value), encoding='utf-8')
            return path

        reject(lambda: M.load_protocol(variant(lambda p: p.update(schema='other/1'))))
        reject(lambda: M.load_protocol(variant(lambda p: p['calibration'].update(pixels_per_micron=0))))
        reject(lambda: M.load_protocol(variant(lambda p: p['roi_names']['lobule_aliases'].update(FI='Flx'))))
        reject(lambda: M.load_protocol(variant(lambda p: p.update(status='approved'))))
        reject(lambda: M.load_protocol(variant(lambda p: p['qc'].pop('layer_outline'))))
        reject(lambda: M.load_protocol(variant(lambda p: p['qc'].pop('unassigned_per_pl_length_um'))))
        strict = M.load_protocol(variant(lambda p: p['qc']['layer_outline'].update(review_if=[])))
        assert 'layer-outline-not-pixel-edge' not in codes(M.section_qc(M.measure(
            [roi('ML_TOTAL', [free]) if r['name'] == 'ML_TOTAL' else r for r in section()], strict), strict))
        reject(lambda: M.load_protocol(folder / 'missing.json'))
        scaled = M.load_protocol(variant(lambda p: p['calibration'].update(pixels_per_micron=2)))
        assert close(M.measure(section(), scaled)[0]['area_um2'], 1500)
        assert scaled['identity']['sha256'] != protocol['identity']['sha256']
        target = folder / 'table.csv'
        M.write_table(rows, target)
        with target.open(newline='', encoding='utf-8') as stream:
            assert list(csv.DictReader(stream)) == rows
        assert M.compare(records, M.read_table(target), protocol)['pass']
        reject(lambda: M.write_table(rows, target))
        doubled = folder / 'doubled.csv'
        M.write_table(rows + rows[:1], doubled)
        reject(lambda: M.read_table(doubled))
    print('ROI measurement checks passed.')


if __name__ == '__main__':
    main()
