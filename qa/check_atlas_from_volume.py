#!/usr/bin/env python3
"""Checks of the atlas plane converter on a made-up labelled volume with known answers. No anatomical claim."""
from pathlib import Path
import gzip
import json
import sys
import tempfile

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import atlas_from_volume as V  # noqa: E402
import atlas_match as A  # noqa: E402
import roi_draft as D  # noqa: E402

GR, MO, ARB, FN, CB, OTHER = 10672, 10674, 728, 989, 512, 7
TREE = {'msg': [{'id': 997, 'acronym': 'root', 'name': 'root', 'children': [
    {'id': 512, 'acronym': 'CB', 'name': 'Cerebellum', 'children': [
        {'id': 528, 'acronym': 'CBX', 'name': 'Cerebellar cortex', 'children': [
            {'id': 1007, 'acronym': 'SIM', 'name': 'Simple lobule', 'children': [
                {'id': GR, 'acronym': 'SIMgr', 'name': 'Simple lobule, granular layer', 'children': []},
                {'id': MO, 'acronym': 'SIMmo', 'name': 'Simple lobule, molecular layer', 'children': []}]}]},
        {'id': 519, 'acronym': 'CBN', 'name': 'Cerebellar nuclei', 'children': [
            {'id': FN, 'acronym': 'FN', 'name': 'Fastigial nucleus', 'children': []}]}]},
    {'id': 1009, 'acronym': 'fiber tracts', 'name': 'fiber tracts', 'children': [
        {'id': ARB, 'acronym': 'arb', 'name': 'arbor vitae', 'children': []}]},
    {'id': OTHER, 'acronym': 'PSV', 'name': 'Somewhere else', 'children': []}]}]}
SPACING, ORIGIN = 25.0, (-350.0, 0.0, 0.0)
SOURCE = {'name': 'Made-up volume', 'citation': 'None', 'license': 'Test fixture', 'obtained_from': 'This check'}


def volume():
    """Axes: anterior to posterior (60), dorsal to ventral (30), left to right (20). The shape narrows away from the middle."""
    v = np.zeros((60, 30, 20), np.uint32)
    for k in range(20):
        shrink = int(abs(k - 9.5))                     # 0 at the two middle planes, 9 at the edges
        if shrink > 7:
            continue
        a0, a1, d0, d1 = 6 + 2 * shrink, 54 - 2 * shrink, 4, 26
        v[a0:a1, d0:d1, k] = MO
        v[a0 + 2:a1 - 2, d0 + 2:d1 - 2, k] = GR
        v[a0 + 5:a1 - 5, d0 + 5:d1 - 5, k] = ARB
        v[a0 + 6:a0 + 8, d0 + 6:d0 + 8, k] = FN         # a nucleus inside the white matter
        v[a0:a0 + 2, d0:d0 + 2, k] = 0                  # a notch in the molecular layer at the anterior dorsal corner
        v[a1:a1 + 2, d1 - 1, k] = CB                    # an unlabelled tail at the posterior ventral corner
        v[0:3, 0:3, k] = OTHER
    return v


def write_nrrd(path, v):
    header = ('NRRD0005\ntype: uint32\ndimension: 3\nspace: left-posterior-superior\nsizes: %d %d %d\n'
              'space directions: (25,0,0) (0,25,0) (0,0,25)\nkinds: domain domain domain\nendian: little\nencoding: gzip\n'
              'space origin: (%g,%g,%g)\n\n' % (v.shape + ORIGIN))
    path.write_bytes(header.encode('ascii') + gzip.compress(v.astype('<u4').tobytes(order='F')))


def area(points):
    p = np.asarray(points, float)
    return abs(float(np.dot(p[:, 0], np.roll(p[:, 1], -1)) - np.dot(p[:, 1], np.roll(p[:, 0], -1)))) / 2


def main():
    checks = []
    v = volume()
    with tempfile.TemporaryDirectory(prefix='atlas-volume-check-') as temp:
        temp = Path(temp)
        write_nrrd(temp / 'v.nrrd', v)
        (temp / 'tree.json').write_text(json.dumps(TREE))
        (temp / 'source.json').write_text(json.dumps(SOURCE))
        args = ['--volume', str(temp / 'v.nrrd'), '--hierarchy', str(temp / 'tree.json'), '--source', str(temp / 'source.json')]
        assert V.main(args + ['--output', str(temp / 'atlas.json'), '--plane-step-um', '50']) == 0
        atlas = json.loads((temp / 'atlas.json').read_text())

        # Planes: one hemisphere, every second voxel from the first plane right of the middle, until the shape ends.
        assert atlas['schema'] == V.SCHEMA and atlas['unit'] == 'um' and atlas['source']['license'] == 'Test fixture'
        assert [p['figure'] for p in atlas['plates']] == [10, 12, 14, 16]
        assert [p['lateral_um'] for p in atlas['plates']] == [12.5, 62.5, 112.5, 162.5]
        checks.append('planes of one hemisphere at the asked spacing, with their distance from the middle')

        # Areas are voxel counts; nuclei count as white matter; unlabelled cerebellum and other structures are left out.
        for plate in atlas['plates']:
            plane = v[:, :, plate['figure']]
            count = {'ML': (plane == MO).sum(), 'GL': (plane == GR).sum(), 'WM': ((plane == ARB) | (plane == FN)).sum()}
            for name in count:
                assert plate['area_um2'][name] == count[name] * 625.0
            assert plate['area_um2']['Cb'] == sum(count.values()) * 625.0
            rings = {name: [q for q in plate['paths'] if q['compartment'] == name] for name in ('Cb', 'GL+WM', 'ML', 'GL', 'WM')}
            assert len(rings['Cb']) == 1 and len(rings['GL+WM']) == 1 and len(rings['WM']) == 1
            assert abs(area(rings['Cb'][0]['points']) - plate['area_um2']['Cb']) < 1e-6      # straight edges: nothing lost to simplifying
            assert abs(area(rings['GL+WM'][0]['points']) - plate['area_um2']['GL'] - plate['area_um2']['WM']) < 1e-6
            assert [q['role'] for q in rings['Cb'] + rings['GL+WM']] == ['published_compartment'] * 2
            assert all(q['role'] == 'layer_compartment' for name in ('ML', 'GL', 'WM') for q in rings[name])
            assert [label['text'] for label in plate['labels']] == ['Sim'] and plate['labels'][0]['atlas_acronym'] == 'SIM'
        checks.append('areas equal voxel counts; nuclei with white matter; unlabelled cerebellum and other structures left out')

        # Frame: anterior is positive x and dorsal is positive y, in the coordinates of the volume.
        first = atlas['plates'][0]
        outline = np.asarray([q for q in first['paths'] if q['compartment'] == 'Cb'][0]['points'])
        a0, a1, d0, d1 = 6, 54, 4, 26
        x_of, y_of = (lambda c: -(c * SPACING + ORIGIN[0] - SPACING / 2)), (lambda r: -(r * SPACING + ORIGIN[1] - SPACING / 2))
        assert outline[:, 0].max() == x_of(a0) and outline[:, 0].min() == x_of(a1)
        assert outline[:, 1].max() == y_of(d0) and outline[:, 1].min() == y_of(d1)
        corner = [x_of(a0), y_of(d0)]                   # the notch removes the anterior dorsal corner, and only that one
        assert not any((outline == corner).all(axis=1)) and any((outline == [x_of(a1), y_of(d1)]).all(axis=1))
        assert any((outline == [x_of(a0 + 2), y_of(d0 + 2)]).all(axis=1))
        checks.append('anterior is positive x, dorsal is positive y, positions follow the volume origin')

        # A section cut from one plane is matched to that plane.
        ppm = A.PARAMETERS['pixels_per_micron']
        chosen = atlas['plates'][2]
        rois = []
        outer = np.asarray([q for q in chosen['paths'] if q['compartment'] == 'Cb'][0]['points'])
        corner = [outer[:, 0].min(), outer[:, 1].max()]          # one shift for both outlines keeps them in register
        for name in ('Cb', 'GL+WM'):
            path = np.asarray([q for q in chosen['paths'] if q['compartment'] == name][0]['points'])
            rois.append({'name': name, 'kind': 'area', 'paths': [((path - corner) * [ppm, -ppm] + 40).tolist()]})
        found, _ = A.match(rois, atlas, dict(A.PARAMETERS, sample_step_um=10.0, max_candidates=0), use_names=False)
        assert found['best']['figure'] == chosen['figure'] and found['best']['distance_um'] < 1.0 and found['margin_um'] > 15, found['all']
        assert abs(found['best']['scale'] - 1) < 0.01 and not found['best']['mirror'], found['best']
        assert found['candidates_tried'] == len(atlas['plates'])
        checks.append('a section cut from one plane is matched to that plane')

        # Refusals: an existing output, a source without its licence, a volume that is not NRRD, a hierarchy without cerebellum.
        assert V.main(args + ['--output', str(temp / 'atlas.json')]) == 2
        (temp / 'bad-source.json').write_text(json.dumps({k: SOURCE[k] for k in SOURCE if k != 'license'}))
        assert V.main(args[:4] + ['--source', str(temp / 'bad-source.json'), '--output', str(temp / 'b.json')]) == 2
        (temp / 'not.nrrd').write_bytes(b'something else')
        assert V.main(['--volume', str(temp / 'not.nrrd')] + args[2:] + ['--output', str(temp / 'c.json')]) == 2
        (temp / 'empty-tree.json').write_text(json.dumps({'msg': [{'id': 1, 'acronym': 'root', 'name': 'root', 'children': []}]}))
        assert V.main(args[:2] + ['--hierarchy', str(temp / 'empty-tree.json')] + args[4:] + ['--output', str(temp / 'd.json')]) == 2
        no_nuclei = json.loads(json.dumps(TREE))
        no_nuclei['msg'][0]['children'][0]['children'] = [c for c in no_nuclei['msg'][0]['children'][0]['children'] if c['acronym'] != 'CBN']
        (temp / 'no-nuclei.json').write_text(json.dumps(no_nuclei))
        assert V.main(args[:2] + ['--hierarchy', str(temp / 'no-nuclei.json')] + args[4:] + ['--output', str(temp / 'e.json')]) == 2
        whole = (temp / 'v.nrrd').read_bytes()
        (temp / 'cut.nrrd').write_bytes(whole[:-40])
        assert V.main(['--volume', str(temp / 'cut.nrrd')] + args[2:] + ['--output', str(temp / 'f.json')]) == 2
        for step in ('0', '-100', 'inf', 'nan'):
            assert V.main(args + ['--output', str(temp / 'g.json'), '--plane-step-um', step]) == 2, step
        assert not any((temp / n).exists() for n in ('b.json', 'c.json', 'd.json', 'e.json', 'f.json', 'g.json'))
        assert atlas['parameters']['plane_step_um'] == 50.0 and atlas['parameters']['plane_step_applied_um'] == 50.0
        assert V.main(args + ['--output', str(temp / 'h.json'), '--plane-step-um', '60']) == 0
        assert json.loads((temp / 'h.json').read_text())['parameters']['plane_step_applied_um'] == 50.0   # 60 um falls on 2 voxels
        checks.append('refuses an existing output, a source without a licence, a damaged or foreign volume, a hierarchy without cerebellum or nuclei, and a spacing that is not a positive number; records the spacing actually used')

        # Same input, same output.
        assert V.main(args + ['--output', str(temp / 'again.json'), '--plane-step-um', '50']) == 0
        assert (temp / 'again.json').read_bytes() == (temp / 'atlas.json').read_bytes()
        checks.append('the same input gives the same file')
    for line in checks:
        print('ok: ' + line)
    print('Atlas plane converter checks passed on a made-up volume.')


if __name__ == '__main__':
    main()
