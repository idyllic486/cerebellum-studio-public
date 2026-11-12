#!/usr/bin/env python3
"""Checks of the hand-editable ROI export and of the way back, on synthetic labels. No tissue accuracy claim."""
from pathlib import Path
import io
import json
import sys
import tempfile
import zipfile

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import roi_draft as D  # noqa: E402
import roi_editable as E  # noqa: E402
import roi_measure as M  # noqa: E402
from nissl_lab import read_roi_zip  # noqa: E402

H, W = 300, 500


def reject(call):
    try:
        call()
    except (ValueError, OSError):
        return
    raise AssertionError('Expected explicit rejection.')


def labels():
    out = np.zeros((H, W), np.uint8)
    out[20:220, 20:400] = 1                 # ML
    out[80:200, 60:360] = 2                 # GL
    out[120:170, 100:320] = 3               # WM
    out[40:60, 200:230] = 0                 # a hole in the tissue
    out[240:270, 420:470] = 1               # a separate tissue part
    out[250:260, 430:450] = 2               # with its own bit of GL
    return out


def decode(data, folder, name='x.zip'):
    path = folder / name
    path.write_bytes(data)
    return read_roi_zip(path)[0]


def main():
    protocol = M.load_protocol()
    plain = dict(D.PARAMETERS, pl_band_width_um=0.0)
    with tempfile.TemporaryDirectory() as temporary:
        folder = Path(temporary)
        truth = labels()
        rois, _ = D.draft_rois(truth, protocol, plain)
        usual = decode(D.roi_zip_bytes(rois), folder, 'usual.zip')
        polygons, summary = E.editable(usual, H, W, E.PARAMETERS)
        names = [p['name'] for p in polygons]
        assert names == ['Cb_part01', 'Cb_part01_hole01', 'Cb_part02', 'GL+WM_part01', 'GL+WM_part02', 'WM_part01', 'PL_TOTAL'], names
        assert summary['Cb'] == dict(summary['Cb'], parts=2, holes=1, pixels_changed_by_simplifying_and_left_out_parts=0) and summary['GL+WM']['parts'] == 2
        assert all(s['area_px'] == s['area_px_as_polygons'] for k, s in summary.items() if k in E.OUTLINES)
        data = E.editable_zip(polygons)
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            kinds = {n: archive.read(n)[6] for n in archive.namelist()}
        assert all(kind == (5 if name == 'PL_TOTAL.roi' else 0) for name, kind in kinds.items()), 'Areas must be ImageJ polygons (type 0), the line a polyline (type 5)'
        assert E.editable_zip(polygons) == data, 'equal polygons must give equal bytes'
        # Nothing corrected: the way back gives the same layers and the same measurements.
        edited = decode(data, folder, 'editable.zip')
        assert all(r['kind'] == ('polyline' if r['name'] == 'PL_TOTAL' else 'area') and len(r['paths']) == 1 for r in edited)
        built, back, structure, how = E.rebuild(edited, H, W, protocol, plain)
        assert np.array_equal(back, truth) and how['clipped_to_keep_layers_nested'] == {'gl_wm_outside_cb_px': 0, 'wm_outside_gl_wm_px': 0}
        assert how['rois_ignored'] == [] and how['pl_total'] == 'the line of the corrected file'
        values = lambda found: M.section_qc(M.measure(decode(D.roi_zip_bytes(found), folder, 'v.zip'), protocol), protocol)['values']
        assert values(built) == values(rois)
        # A person deletes the separate part, fills the hole, and adds a piece of white matter and a new hole by drawing.
        box = lambda name, x0, y0, x1, y1: {'name': name, 'kind': 'area', 'paths': [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]}
        changed = [r for r in edited if r['name'] not in ('Cb_part02', 'GL+WM_part02', 'Cb_part01_hole01', 'PL_TOTAL')]
        changed += [box('WM_extra', 320, 130, 340, 160), box('Cb_hole_new', 20, 20, 40, 40), box('scale bar', 0, 0, 5, 5)]
        built, back, structure, how = E.rebuild(changed, H, W, protocol, plain)
        expected = truth.copy()
        expected[240:270, 420:470] = 0
        expected[40:60, 200:230] = 1
        expected[130:160, 320:340] = 3
        expected[20:40, 20:40] = 0
        assert np.array_equal(back, expected) and how['rois_ignored'] == ['scale bar'] and how['pl_total'].startswith('made from')
        assert how['rois_used']['WM']['added'] == ['WM_part01', 'WM_extra'] and how['rois_used']['Cb']['holes'] == ['Cb_hole_new']
        assert {r['name'] for r in built} >= {'Cb', 'ML_TOTAL', 'GL_TOTAL', 'WM', 'GL+WM'}
        # Layers stay nested: white matter drawn outside GL+WM, or GL+WM outside Cb, is cut back and counted.
        _, back, _, how = E.rebuild(edited + [box('WM_far', 380, 30, 395, 50), box('GL+WM_out', 405, 100, 415, 110)], H, W, protocol, plain)
        assert how['clipped_to_keep_layers_nested'] == {'gl_wm_outside_cb_px': 100, 'wm_outside_gl_wm_px': 300} and np.array_equal(back, truth)
        # The Purkinje band is taken out of ML on the way back, as in a draft.
        banded, _, structure, _ = E.rebuild(edited, H, W, protocol, dict(D.PARAMETERS))
        assert structure['purkinje_band']['pixels'] > 0 and M.area_px2({r['name']: r for r in banded}['ML_TOTAL']) == int((truth == 1).sum()) - structure['purkinje_band']['pixels']
        # Simplifying moves an outline by no more than the tolerance and says how many pixels changed.
        wavy = np.zeros((H, W), np.uint8)
        yy, xx = np.mgrid[:H, :W]
        wavy[(xx - 250) ** 2 / 200 ** 2 + (yy - 150) ** 2 / 120 ** 2 <= 1] = 1
        wavy[(xx - 250) ** 2 / 120 ** 2 + (yy - 150) ** 2 / 60 ** 2 <= 1] = 2
        smooth, summary = E.editable(decode(D.roi_zip_bytes(D.draft_rois(wavy, protocol, plain)[0]), folder, 'w.zip'), H, W, E.PARAMETERS)
        cb = summary['Cb']
        assert cb['vertices_after'] < cb['vertices_before'] / 4 and 0 < cb['pixels_changed_by_simplifying_and_left_out_parts'] < 0.02 * cb['area_px']
        assert all(len(p['paths'][0]) >= 3 for p in smooth if p['kind'] == 'polygon')
        # Small specks are left out by a stated limit and counted, not dropped silently.
        specks = truth.copy()
        specks[280:283, 10:13] = 1
        _, summary = E.editable(decode(D.roi_zip_bytes(D.draft_rois(specks, protocol, plain)[0]), folder, 's.zip'), H, W, E.PARAMETERS)
        assert summary['Cb']['left_out_as_too_small']['parts'] == 1 and summary['Cb']['left_out_as_too_small']['part_px'] == 9
        # Parts after the largest that are smaller than the stated area are left out, counted, and can be kept on request.
        um2 = 1 / (1.4 * 1.4)
        few, summary = E.editable(usual, H, W, E.PARAMETERS, um2)        # the separate part is 1500 px, its GL 200 px: both far below 10,000 um2
        assert [p['name'] for p in few] == ['Cb_part01', 'Cb_part01_hole01', 'GL+WM_part01', 'WM_part01', 'PL_TOTAL']
        left = summary['Cb']['left_out_as_too_small']
        assert left['small_secondary_parts'] == 1 and abs(left['small_secondary_part_um2'] - 1500 * um2) < 1e-6 and summary['Cb']['separate_parts_before'] == 2
        assert summary['Cb']['area_px'] - summary['Cb']['area_px_as_polygons'] == 1500
        roomy = dict(E.PARAMETERS, drop_secondary_parts_below_um2=500.0)  # 1500 px is 765 um2: kept; 200 px is 102 um2: left out
        assert [p['name'] for p in E.editable(usual, H, W, roomy, um2)[0]] == ['Cb_part01', 'Cb_part01_hole01', 'Cb_part02', 'GL+WM_part01', 'WM_part01', 'PL_TOTAL']
        assert len(E.editable(usual, H, W, dict(E.PARAMETERS, drop_secondary_parts_below_um2=0.0), um2)[0]) == 7
        lone = np.zeros((H, W), np.uint8)
        lone[100:130, 100:130], lone[105:115, 105:115] = 1, 2            # a section whose only tissue is tiny: the largest part always stays
        assert [p['name'] for p in E.editable(decode(D.roi_zip_bytes(D.draft_rois(lone, protocol, plain)[0]), folder, 'l.zip'), H, W, E.PARAMETERS, um2)[0]][:2] == ['Cb_part01', 'GL+WM_part01']
        reject(lambda: E.rebuild([r for r in edited if not r['name'].startswith('GL+WM')], H, W, protocol, plain))
        reject(lambda: E.rebuild(edited + [{'name': 'PL_TOTAL', 'kind': 'polyline', 'paths': [[[0, 0], [5, 5]]]}], H, W, protocol, plain))
        reject(lambda: E.editable([r for r in usual if r['name'] != 'Cb'], H, W, E.PARAMETERS))
        assert E.editable([r for r in usual if r['name'] != 'WM'], H, W, E.PARAMETERS)[1]['WM']['parts'] == 0, 'a section without WM is written without WM polygons'
        # The command, both ways.
        (folder / 'in').mkdir()
        (folder / 'in' / 'S-1.roi.zip').write_bytes(D.roi_zip_bytes(rois))
        common = ['--size', '%dx%d' % (W, H), '--sample', 'S-1']
        assert E.main(['export', '--roi', str(folder / 'in' / 'S-1.roi.zip'), '--output', str(folder / 'out')] + common) == 0
        record = json.loads((folder / 'out' / 'S-1.editable.json').read_text())
        assert record['file']['rois'] == 5 and 'not an approval' in record['statement'] and str(folder) not in json.dumps(record)
        assert record['parameters']['drop_secondary_parts_below_um2'] == 10000.0 and record['outlines']['Cb']['left_out_as_too_small']['small_secondary_parts'] == 1
        assert E.main(['export', '--roi', str(folder / 'in' / 'S-1.roi.zip'), '--keep-small-parts', '--output', str(folder / 'all')] + common) == 0
        assert json.loads((folder / 'all' / 'S-1.editable.json').read_text())['file']['rois'] == 7
        assert E.main(['rebuild', '--roi', str(folder / 'all' / 'S-1.editable-roi.zip'), '--pl-band-um', '0', '--output', str(folder / 'back')] + common) == 0
        rebuilt = json.loads((folder / 'back' / 'S-1.rebuilt.json').read_text())
        assert rebuilt['approval'] == {'approved': False} and rebuilt['measurement']['values'] == values(rois)
        assert E.main(['export', '--roi', str(folder / 'in' / 'S-1.roi.zip'), '--output', str(folder / 'out')] + common) == 2
        assert E.main(['export', '--roi', str(folder / 'in' / 'S-1.roi.zip'), '--output', str(folder / 'in' / 'inside')] + common) == 2
        assert E.main(['export', '--roi', str(folder / 'in' / 'S-1.roi.zip'), '--size', '500', '--sample', 'S-1', '--output', str(folder / 'no')]) == 2
    print('Editable ROI checks passed on synthetic labels.')


main()
