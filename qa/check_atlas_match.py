#!/usr/bin/env python3
"""Checks of atlas matching and of the reconstruction integral on made-up shapes with known answers. No anatomical claim."""
from pathlib import Path
import json
import math
import sys
import tempfile

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import atlas_match as A  # noqa: E402
import atlas_reconstruct as C  # noqa: E402
import roi_draft as D  # noqa: E402

PPM = A.PARAMETERS['pixels_per_micron']


def blob(lobes, radius=1500.0, depth=0.35, count=240):
    """A closed outline with a number of lobes, in micrometres."""
    angle = np.linspace(0, 2 * math.pi, count, endpoint=False)
    r = radius * (1 + depth * np.cos(lobes * angle) + 0.1 * np.cos(angle))
    return np.stack([r * np.cos(angle) - 6000, r * np.sin(angle) - 2500], 1)


def plate(figure, lateral, lobes, labels):
    outer = blob(lobes)
    inner = (outer - outer.mean(0)) * 0.6 + outer.mean(0)
    return {'figure': figure, 'lateral_um': lateral, 'labels': [{'text': t} for t in labels + ['psf', 'Med']],
            'paths': [{'role': 'boundary_ink', 'closed': True, 'points': outer.tolist()},
                      {'role': 'published_compartment', 'closed': True, 'points': inner.tolist()},
                      {'role': 'inner_paint', 'closed': True, 'points': (inner * 0.5).tolist()}]}


def section_rois(lobes, names, rotation, scale, shift, mirror):
    """ROIs of a section that is the plate shape moved about, in image pixels with y down."""
    def move(points):
        p = points * [-1 if mirror else 1, 1]
        c, s = math.cos(rotation), math.sin(rotation)
        p = (p @ np.array([[c, s], [-s, c]])) * scale + shift
        return np.round(p * [PPM, -PPM]).astype(int).tolist()
    outer = blob(lobes)
    inner = (outer - outer.mean(0)) * 0.6 + outer.mean(0)
    rois = [{'name': 'Cb', 'kind': 'area', 'paths': [move(outer)]}, {'name': 'GL+WM', 'kind': 'area', 'paths': [move(inner)]},
            {'name': 'PL_TOTAL', 'kind': 'polyline', 'paths': [move(inner[:60])]}]
    return rois + [{'name': 'GL_%s_part1' % n, 'kind': 'area', 'paths': [move(inner[:20])]} for n in names]


def main():
    assert A.section_lobules([{'name': n} for n in ('GL_4-5Cb_part1', 'ML_4-5Cb_part1', 'PL_FI_part1', 'GL_TOTAL', 'FISSURE_icf', 'GL_Sim_part2')]) == ['4/5Cb', 'Fl', 'Sim']
    assert A.plate_lobules({'labels': [{'text': t} for t in ('4/5Cb', 'psf', 'Med', 'Sim', 'IntA')]}) == ['4/5Cb', 'Sim']
    assert A.jaccard(['a', 'b'], ['b', 'c']) == 1 / 3 and A.jaccard([], []) == 0
    line = A.resample([[0, 0], [100, 0]], 10, False)
    assert len(line) == 10 and np.allclose(line[3], [30, 0]) and len(A.resample([[0, 0], [10, 0], [10, 10], [0, 10]], 5, True)) == 8
    atlas = {'schema': 'cerebellum-atlas-drawing-series/1', 'unit': 'um', 'status': 'synthetic', 'series': {'coordinate_frame': {}},
             'plates': [plate(1, 0.0, 3, ['2Cb', '3Cb']), plate(2, 500.0, 5, ['Sim', 'Crus1']), plate(3, 1000.0, 7, ['Sim', 'Crus1']), plate(4, 1500.0, 4, ['PFl'])]}
    rois = section_rois(5, ['Sim', 'Crus1'], math.radians(140), 1.12, np.array([9000.0, -7000.0]), True)
    found, kept = A.match(rois, atlas, A.PARAMETERS)
    best = found['best']
    assert best['figure'] == 2 and best['lateral_um'] == 500.0 and best['name_score'] == 1.0, found['all']
    assert best['distance_um'] < 15 and found['runner_up']['figure'] == 3 and found['margin_um'] > 50, found['all']
    assert found['candidates_tried'] == 2 and close(best['scale'], 1 / 1.12, 0.03)  # the made-up shape is mirror symmetric, so the mirror flag is not checked
    back = A.transform(kept['Cb']['paths'][0], best)
    from scipy.spatial import cKDTree  # the shape nearly repeats every 72 degrees, so the test is distance to the plate outline, not point order
    assert cKDTree(A.resample(blob(5), 10, True)).query(back)[0].max() < 150, 'The placed outline is not back on the plate'
    # Names alone do not decide: with the same names as two plates the shape picks the right one.
    other, _ = A.match(section_rois(7, ['Sim', 'Crus1'], 0.3, 0.9, np.array([100.0, 50.0]), False), atlas, A.PARAMETERS)
    assert other['best']['figure'] == 3
    # Names can be ignored on request: every plate is tried and the shape alone must find the same plate.
    blind, _ = A.match(rois, atlas, A.PARAMETERS, use_names=False)
    assert blind['candidates_tried'] == 4 and blind['names_used'] is False and blind['best']['figure'] == 2 and found['names_used'] is True
    # Without lobule names every plate is tried.
    bare, _ = A.match(section_rois(4, [], 1.0, 1.0, np.array([0.0, 0.0]), False), atlas, A.PARAMETERS)
    assert bare['candidates_tried'] == 4 and bare['best']['figure'] == 4
    try:
        A.match([r for r in rois if r['name'] != 'Cb'], atlas, A.PARAMETERS)
    except ValueError:
        pass
    else:
        raise AssertionError('Expected explicit rejection.')
    # Reconstruction: areas averaged per position, trapezoid volume between positions.
    assert close(C.integral([(0, 2.0), (1000, 4.0)], 0, 1000), 3000) and C.integral([(0, 2.0), (1000, 4.0)], 0, 2000) is None
    match = {'schema': A.SCHEMA, 'sections': [
        {'sample': 'X-1', 'margin_um': 5.0, 'best': {'figure': 2, 'lateral_um': 500.0, 'distance_um': 10.0, 'name_score': 1.0, 'mirror': False, 'scale': 1.0}},
        {'sample': 'X-7', 'margin_um': None, 'best': {'figure': 2, 'lateral_um': 500.0, 'distance_um': 12.0, 'name_score': 1.0, 'mirror': False, 'scale': 1.0}},
        {'sample': 'X-13', 'margin_um': 2.0, 'best': {'figure': 4, 'lateral_um': 1500.0, 'distance_um': 9.0, 'name_score': 1.0, 'mirror': False, 'scale': 1.0}}]}
    values = {'X-1': {'Cb': 2.0, 'GL_TOTAL': 1.0, 'WM': 0.5, 'Cb-GL-WM': 0.5}, 'X-7': {'Cb': 4.0, 'GL_TOTAL': 1.0, 'WM': 0.5, 'Cb-GL-WM': 2.5},
              'X-13': {'Cb': 5.0, 'GL_TOTAL': 2.0, 'WM': None, 'Cb-GL-WM': None}}
    animals = C.arrange(match, values, (500.0, 1000.0))
    x = animals['X']
    assert x['positions_um'] == [500.0, 1500.0] and x['sections_sharing_a_position'] == 1 and x['range_um'] == [500.0, 1500.0]
    assert close(x['volume_mm3_own_range']['Cb'], (3.0 + 5.0) / 2 * 1000 / 1000) and x['volume_mm3_own_range']['WM'] is None
    assert close(x['volume_mm3_common_range']['Cb'], (3.0 + 4.0) / 2 * 500 / 1000) and x['order_by_number'] == [[1, 500.0], [7, 500.0], [13, 1500.0]]
    spread = C.sensitivity(x, [0.0, 500.0, 1000.0, 1500.0, 2000.0], None, 400, 1)
    assert spread['Cb']['p2_5'] <= spread['Cb']['median'] <= spread['Cb']['p97_5'] and spread['Cb']['p2_5'] < spread['Cb']['p97_5'] and spread['WM'] is None
    assert C.sensitivity(x, [0.0, 500.0, 1000.0, 1500.0, 2000.0], None, 400, 1) == spread, 'the same seed must give the same answer'
    # The command end to end on a synthetic ROI file.
    with tempfile.TemporaryDirectory() as temporary:
        folder = Path(temporary)
        (folder / 'atlas.json').write_text(json.dumps(atlas))
        on_image = section_rois(5, ['Sim', 'Crus1'], 0.0, 1.0, np.array([9000.0, -1000.0]), False)  # coordinates an ROI file can hold
        (folder / 'S-1.zip').write_bytes(D.roi_zip_bytes(on_image))
        assert A.main(['--atlas', str(folder / 'atlas.json'), '--section', 'S-1=' + str(folder / 'S-1.zip'), '--output', str(folder / 'match')]) == 0
        written = json.loads((folder / 'match' / 'atlas-match.json').read_text())
        assert written['sections'][0]['best']['figure'] == 2 and 'Not a measured position' in written['statement'] and str(folder) not in json.dumps(written)
        placed = json.loads((folder / 'match' / 'placed-outlines.json').read_text())['sections']['S-1']
        assert placed['lateral_um'] == 500.0 and set(placed['rois']) == {'Cb', 'GL+WM', 'PL_TOTAL'}
        manifest = {'sections': [{'section_id': 'S-1', 'animal_id': 'S', 'group': 'WT', 'values': {'area_um2': {'Cb': 4e6, 'GL_TOTAL': 1e6, 'WM': 1e6}, 'pl_total_geometry': 'line', 'pl_total_length_um': 1000}}]}
        (folder / 'm.json').write_text(json.dumps(manifest))
        assert C.main(['--match', str(folder / 'match'), '--manifest', str(folder / 'm.json'), '--output', str(folder / 'rec')]) == 0
        rec = json.loads((folder / 'rec' / 'reconstruction.json').read_text())
        assert rec['animals']['S']['volume_mm3_own_range']['Cb'] is None and 'not measured volumes' in rec['statement']
        viewer = (folder / 'rec' / 'viewer.html').read_text()
        assert '@DATA@' not in viewer and 'S-1' in viewer and str(folder) not in viewer
        assert A.main(['--atlas', str(folder / 'atlas.json'), '--section', 'S-1=' + str(folder / 'S-1.zip'), '--output', str(folder / 'match')]) == 2
        assert C.main(['--match', str(folder / 'match'), '--manifest', str(folder / 'm.json'), '--output', str(folder / 'rec')]) == 2
    print('Atlas matching and reconstruction checks passed on made-up shapes.')


def close(a, b, tolerance=1e-9):
    return abs(a - b) <= tolerance * max(1, abs(b))


main()
