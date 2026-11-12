#!/usr/bin/env python3
"""Checks of the review recorder on a synthetic draft: what an approval writes and ties together, what it
refuses, the change list against an independent raster, and that later changes to any file are found."""
from pathlib import Path
import contextlib
import hashlib
import io
import json
import shutil
import sys
import tempfile

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import roi_approve as A  # noqa: E402
import roi_draft as D  # noqa: E402
import roi_measure as M  # noqa: E402
from nissl_lab import read_roi_zip  # noqa: E402

PPM = 1.4
WIDTH, HEIGHT = 640, 240
WHEN = '2026-11-10T09:30:00Z'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def close(a, b, tolerance=1e-9):
    return abs(a - b) <= tolerance * max(1, abs(b))


def section(ml=(24, 90), gl=(90, 150), wm=(150, 200), columns=(24, 600)):
    labels = np.zeros((HEIGHT, WIDTH), np.uint8)
    for value, (top, bottom) in ((1, ml), (2, gl), (3, wm)):
        labels[top:bottom, columns[0]:columns[1]] = value
    return labels


def inside(paths):
    # Independent oracle: crossing number of a ray to the right of every pixel centre.
    cy, cx = np.mgrid[0:HEIGHT, 0:WIDTH] + .5
    odd = np.zeros((HEIGHT, WIDTH), bool)
    for path in paths:
        for (x0, y0), (x1, y1) in zip(path, path[1:] + path[:1]):
            if y0 != y1:
                odd ^= ((y0 > cy) != (y1 > cy)) & (cx < x0 + (cy - y0) * (x1 - x0) / (y1 - y0))
    return odd


def run(*arguments):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = A.main([str(a) for a in arguments])
    return code, out.getvalue(), err.getvalue()


def whole(rois):
    return [{'name': r['name'], 'kind': r['kind'], 'paths': [[[int(x), int(y)] for x, y in path] for path in r['paths']]}
            for r in rois]


def main():
    protocol = M.load_protocol()
    assert protocol['calibration']['pixels_per_micron'] == PPM
    with tempfile.TemporaryDirectory() as temporary:
        folder = Path(temporary).resolve()
        image = folder / 'images' / 'Montage.tif'
        image.parent.mkdir()
        image.write_bytes(b'stand-in for the montage: the recorder reads its bytes only')
        source = {'file_name': image.name, 'bytes': image.stat().st_size, 'sha256': sha(image),
                  'width': WIDTH, 'height': HEIGHT, 'channels': 3}
        model = {'id': 'none', 'sha256': '1' * 64, 'source_in_training_set': False}

        def draft(name, labels):
            record, path = D.write_section(folder / 'drafts' / name, name, labels, protocol, dict(D.PARAMETERS, pl_band_width_um=0.0), source, model)
            return record, path, path.parent / record['outputs']['roi']['file']

        def record(output, draft_path, roi, decision='approved', reviewer='Reviewer A', extra=(), picture=image, when=WHEN):
            return run('record', '--draft', draft_path, '--image', picture, '--roi', roi, '--reviewer', reviewer,
                       '--decision', decision, '--output', folder / output, '--reviewed-at', when, *extra)

        def refused(output, *arguments, **options):
            code, out, err = record(output, *arguments, **options)
            assert code == 2 and err.startswith('Not recorded: ') and out == '' and not (folder / output).exists(), (code, err)
            return err

        def checked(record_path, picture=image, extra=()):
            code, out, err = run('verify', '--record', record_path, '--image', picture, *extra)
            return code, json.loads(out)

        (folder / 'drafts').mkdir()
        clean, clean_path, clean_zip = draft('S-1', section())
        assert clean['review_queue'] == []

        # An unchanged clean draft, approved: byte copy of the ROI file, a table, and a record that ties them.
        for name in ('a1', 'a2'):
            code, out, err = record(name, clean_path, clean_zip, extra=('--review-minutes', '12.5'))
            assert code == 0 and err == '', err
        assert sorted(p.name for p in (folder / 'a1').iterdir()) == ['S-1.approval.json', 'S-1.approved-roi.zip', 'S-1.measurement.csv']
        for name in ('S-1.approval.json', 'S-1.approved-roi.zip', 'S-1.measurement.csv'):
            assert (folder / 'a1' / name).read_bytes() == (folder / 'a2' / name).read_bytes(), name
        raw = (folder / 'a1' / 'S-1.approval.json').read_bytes()
        assert str(folder).encode() not in raw
        approval = json.loads(raw)
        assert json.loads(out)['approved'] is True and approval['schema'] == A.RECORD_SCHEMA
        assert approval['decision'] == 'approved' and approval['approval']['approved'] is True
        assert ('still a draft' in approval['approval']['statement']) == (not protocol['identity']['approved'])
        assert approval['review'] == {'reviewer': 'Reviewer A', 'reviewer_identity': approval['review']['reviewer_identity'],
                                      'reviewed_at': WHEN, 'review_minutes': 12.5, 'note': None, 'edited': False}
        assert approval['source'] == source and approval['model'] == model and approval['protocol'] == protocol['identity']
        assert approval['draft']['record_sha256'] == sha(clean_path) and approval['draft']['roi_sha256'] == sha(clean_zip)
        assert approval['draft']['labels']['draft_sha256'] == clean['labels']['draft_sha256']
        assert approval['draft']['engine'] == clean['engine'] and approval['draft']['not_drafted'] == clean['not_drafted']
        assert approval['reviewed_roi'] == {'sha256': sha(clean_zip), 'bytes': clean_zip.stat().st_size, 'rois': 6, 'file': 'S-1.approved-roi.zip'}
        assert (folder / 'a1' / 'S-1.approved-roi.zip').read_bytes() == clean_zip.read_bytes()
        assert approval['table'] == {'file': 'S-1.measurement.csv', 'sha256': sha(folder / 'a1' / 'S-1.measurement.csv'), 'rows': 6}
        assert M.read_table(folder / 'a1' / 'S-1.measurement.csv') == M.read_table(clean_path.parent / clean['outputs']['table']['file'])
        assert approval['changes']['counts'] == {'added': 0, 'removed': 0, 'changed': 0, 'unchanged': 6}
        assert all('overlap' not in c and c['before'] == c['after'] for c in approval['changes']['rois'])
        assert approval['measurement']['before'] == approval['measurement']['after'] and approval['checks']['open_flags'] == []
        assert set(approval['engine']['code_sha256']) == {'roi_approve.py', 'roi_measure.py', 'nissl_lab.py'}
        assert approval['engine']['code_sha256']['roi_approve.py'] == sha(ROOT / 'scripts' / 'roi_approve.py')
        code, report = checked(folder / 'a1' / 'S-1.approval.json')
        assert code == 0 and report['valid'] is True and all(report['checks'].values()) and len(report['checks']) == 6
        assert report['record_sha256'] == hashlib.sha256(raw).hexdigest()

        # Anything that changes after approval is found, each by its own check.
        variant = folder / 'protocol-variant.json'
        variant.write_bytes(Path(M.DEFAULT_PROTOCOL).read_bytes() + b'\n')
        other_image = folder / 'other.tif'
        other_image.write_bytes(image.read_bytes() + b'.')
        rois = whole(read_roi_zip(clean_zip)[0])
        by_name = {r['name']: r for r in rois}
        slanted = [dict(r) for r in rois]
        slanted[[r['name'] for r in rois].index('ML_TOTAL')] = {'name': 'ML_TOTAL', 'kind': 'area',
                                                               'paths': [[[24, 90], [24, 30], [600, 24], [600, 90]]]}
        slanted_zip = folder / 'slanted.zip'
        slanted_zip.write_bytes(D.roi_zip_bytes(slanted))

        def failing(change, picture=image, extra=()):
            copy = folder / ('tamper-%d' % len(list(folder.glob('tamper-*'))))
            shutil.copytree(folder / 'a1', copy)
            change(copy)
            code, report = checked(copy / 'S-1.approval.json', picture, extra)
            assert code == 1 and report['valid'] is False
            return {name for name, passed in report['checks'].items() if not passed}

        assert failing(lambda copy: None, picture=other_image) == {'image_unchanged'}
        assert failing(lambda copy: None, extra=('--protocol', variant)) == {'protocol_unchanged', 'table_reproduced'}
        assert failing(lambda copy: shutil.copyfile(slanted_zip, copy / 'S-1.approved-roi.zip')) == {'roi_file_unchanged', 'table_reproduced'}
        assert failing(lambda copy: (copy / 'S-1.approved-roi.zip').write_bytes(b'not a zip')) == {'roi_file_unchanged', 'table_reproduced'}
        assert failing(lambda copy: (copy / 'S-1.approved-roi.zip').unlink()) == {'roi_file_unchanged', 'table_unchanged', 'table_reproduced'}

        def digit(copy):
            table = copy / 'S-1.measurement.csv'
            text = table.read_text(encoding='utf-8')
            position = max(i for i, c in enumerate(text) if c.isdigit())
            table.write_text(text[:position] + str((int(text[position]) + 1) % 10) + text[position + 1:], encoding='utf-8')
        assert failing(digit) == {'table_unchanged', 'table_reproduced'}
        code, out, err = run('verify', '--record', clean_path, '--image', image)
        assert code == 2 and err.startswith('Not checked: ')

        # An edited set: the change list, measured on both sides, with overlap against the independent raster.
        code, out, err = record('edited', clean_path, slanted_zip, extra=('--note', '  ML outer border   redrawn  '))
        assert code == 0, err
        edited = json.loads((folder / 'edited' / 'S-1.approval.json').read_text(encoding='utf-8'))
        assert edited['review']['edited'] is True and edited['review']['note'] == 'ML outer border redrawn'
        assert edited['changes']['counts'] == {'added': 0, 'removed': 0, 'changed': 1, 'unchanged': 5}
        change = next(c for c in edited['changes']['rois'] if c['name'] == 'ML_TOTAL')
        before, after = inside(by_name['ML_TOTAL']['paths']), inside(slanted[2]['paths'])
        assert slanted[2]['name'] == 'ML_TOTAL' and int(before.sum()) == 576 * 66
        um2 = 1 / (PPM * PPM)
        assert close(change['overlap']['shared_um2'], int((before & after).sum()) * um2)
        assert close(change['overlap']['removed_um2'], int((before & ~after).sum()) * um2)
        assert close(change['overlap']['added_um2'], int((after & ~before).sum()) * um2) and change['overlap']['added_um2'] == 0
        assert close(change['overlap']['dice'], 2 * int((before & after).sum()) / (int(before.sum()) + int(after.sum())))
        assert close(change['before']['area_um2'], 576 * 66 * um2) and close(change['after']['area_um2'], 576 * 63 * um2)
        assert close(change['area_um2_difference'], -576 * 3 * um2) and close(change['area_um2_relative_difference'], -3 / 66)
        # The shoelace area of the redrawn outline and its pixel-centre raster agree to within the slanted edge.
        assert abs(change['after']['area_um2'] - int(after.sum()) * um2) <= 576 * um2
        assert [f['code'] for f in edited['checks']['open_flags']] == ['layer-outline-not-pixel-edge']
        assert edited['measurement']['after']['closure_ratio'] < 1 and close(edited['measurement']['before']['closure_ratio'], 1)
        assert checked(folder / 'edited' / 'S-1.approval.json')[0] == 0
        mask = np.zeros((HEIGHT, WIDTH), bool)
        mask[40:90, 30:70] = mask[60:70, 70:200] = True
        mask[50:60, 40:50] = False
        traced = {'paths': D.trace_mask(mask)}
        assert np.array_equal(A.raster(traced, WIDTH, HEIGHT), mask) and np.array_equal(inside(traced['paths']), mask)
        triangle = {'paths': [[[10, 10], [300, 37], [120, 201]]]}
        assert np.array_equal(A.raster(triangle, WIDTH, HEIGHT), inside(triangle['paths']))

        # A returned set writes the record only, and never passes as an approval.
        without_gl = [r for r in rois if r['name'] != 'GL_TOTAL']
        without_gl[[r['name'] for r in without_gl].index('PL_TOTAL')] = {'name': 'PL_TOTAL', 'kind': 'polyline',
                                                                        'paths': [[[24, 90], [300, 96], [600, 90]]]}
        without_gl.append({'name': 'ML_II_part1', 'kind': 'area', 'paths': [[[30, 30], [90, 30], [90, 80], [30, 80]]]})
        partial_zip = folder / 'partial.zip'
        partial_zip.write_bytes(D.roi_zip_bytes(without_gl))
        code, out, err = record('returned', clean_path, partial_zip, decision='returned')
        assert code == 0 and json.loads(out)['approved'] is False
        assert [p.name for p in (folder / 'returned').iterdir()] == ['S-1.approval.json']
        returned = json.loads((folder / 'returned' / 'S-1.approval.json').read_text(encoding='utf-8'))
        assert returned['decision'] == 'returned' and returned['approval']['approved'] is False
        assert returned['table'] is None and returned['reviewed_roi']['file'] is None
        assert returned['changes']['counts'] == {'added': 1, 'removed': 1, 'changed': 1, 'unchanged': 4}
        statuses = {c['name']: c for c in returned['changes']['rois']}
        assert statuses['GL_TOTAL']['status'] == 'removed' and statuses['GL_TOTAL']['after'] is None
        assert statuses['ML_II_part1']['status'] == 'added' and statuses['ML_II_part1']['before'] is None
        line = statuses['PL_TOTAL']
        assert line['status'] == 'changed' and 'overlap' not in line and line['before']['area_um2'] is None
        assert close(line['length_um_difference'], (np.hypot(276, 6) + np.hypot(300, 6) - 576) / PPM)
        assert (1, 'total-missing') in {(f['priority'], f['code']) for f in returned['checks']['open_flags']}
        code, report = checked(folder / 'returned' / 'S-1.approval.json')
        assert code == 1 and report['checks']['decision_is_approved'] is False

        # Open priority 1 checks can be approved only with a note; the later record names the one it replaces.
        assert 'total-missing' in refused('no-note', clean_path, partial_zip)
        code, out, err = record('with-note', clean_path, partial_zip,
                                extra=('--note', 'GL not visible in this section', '--previous', folder / 'returned' / 'S-1.approval.json'))
        assert code == 0, err
        later = json.loads((folder / 'with-note' / 'S-1.approval.json').read_text(encoding='utf-8'))
        assert later['supersedes'] == {'record_sha256': sha(folder / 'returned' / 'S-1.approval.json'), 'decision': 'returned',
                                       'reviewed_at': WHEN, 'roi_sha256': sha(partial_zip)}
        assert later['checks']['open_flags'] == returned['checks']['open_flags'] and approval['supersedes'] is None
        assert checked(folder / 'with-note' / 'S-1.approval.json')[0] == 0

        # A draft with priority 1 review items cannot be approved untouched without a note.
        flagged, flagged_path, flagged_zip = draft('S-2', section(columns=(0, 600)))
        assert [(i['tier'], i['code']) for i in flagged['review_queue']] == [(1, 'main-part-at-image-border')]
        assert 'main-part-at-image-border' in refused('untouched', flagged_path, flagged_zip)
        code, out, err = record('untouched-returned', flagged_path, flagged_zip, decision='returned')
        assert code == 0, err
        code, out, err = record('untouched-note', flagged_path, flagged_zip, extra=('--note', 'The section is cut at the slide edge.'))
        assert code == 0, err
        kept = json.loads((folder / 'untouched-note' / 'S-2.approval.json').read_text(encoding='utf-8'))
        assert kept['draft']['review_queue'] == {'items': 1, 'by_tier': {'1': 1, '2': 0, '3': 0},
                                                 'priority_1_codes': ['main-part-at-image-border']}

        # A review that completes what the draft could not make clears the draft's flags.
        short, short_path, short_zip = draft('S-3', section(ml=(24, 150), gl=(150, 150)))
        assert {(f['priority'], f['code'], f['detail']) for f in short['measurement']['flags']} == \
            {(1, 'total-missing', 'GL_TOTAL'), (1, 'total-missing', 'PL_TOTAL')}
        completed = [dict(r) for r in rois]
        assert {r['name'] for r in whole(read_roi_zip(short_zip)[0])} == {'Cb', 'ML_TOTAL', 'WM', 'GL+WM'}
        completed_zip = folder / 'completed.zip'
        completed_zip.write_bytes(D.roi_zip_bytes(completed))
        code, out, err = record('completed', short_path, completed_zip)
        assert code == 0, err
        done = json.loads((folder / 'completed' / 'S-3.approval.json').read_text(encoding='utf-8'))
        assert done['changes']['counts'] == {'added': 2, 'removed': 0, 'changed': 2, 'unchanged': 2}
        assert done['checks']['open_flags'] == [] and sorted(c[2] for c in done['checks']['cleared_by_review']) == ['GL_TOTAL', 'PL_TOTAL']
        moved = next(c for c in done['changes']['rois'] if c['name'] == 'ML_TOTAL')['overlap']
        assert close(moved['removed_um2'], 576 * 60 * um2) and moved['added_um2'] == 0 and close(moved['dice'], 2 * 66 / (126 + 66))

        # Refusals. None of them leaves an output folder behind.
        assert 'not the image' in refused('r', clean_path, clean_zip, picture=other_image)
        assert 'protocol has changed' in refused('r', clean_path, clean_zip, extra=('--protocol', variant))
        refused('r', clean_path, clean_zip, reviewer='   ')
        refused('r', clean_path, clean_zip, reviewer='x' * 81)
        refused('r', clean_path, clean_zip, when='2026-11-10 09:30')
        refused('r', clean_path, clean_zip, when='2026-13-40T00:00:00Z')
        refused('r', clean_path, clean_zip, extra=('--review-minutes', '0'))
        refused('r', clean_path, clean_zip, extra=('--note', 'x' * 2001))
        refused('r', clean_path, folder / 'missing.zip')
        refused('r', folder / 'a1' / 'S-1.approval.json', clean_zip)
        refused('r', clean_path, clean_zip, extra=('--previous', folder / 'untouched-note' / 'S-2.approval.json'))
        refused('r', clean_path, clean_zip, extra=('--previous', clean_path))
        broken = folder / 'broken.zip'
        broken.write_bytes(b'not a zip')
        refused('r', clean_path, broken)
        outside = [dict(r) for r in rois]
        outside[0] = {'name': 'Cb', 'kind': 'area', 'paths': [[[24, 24], [WIDTH + 1, 24], [600, 200], [24, 200]]]}
        outside_zip = folder / 'outside.zip'
        outside_zip.write_bytes(D.roi_zip_bytes(outside))
        assert 'outside the image' in refused('r', clean_path, outside_zip)
        code, out, err = record('a1', clean_path, clean_zip)
        assert code == 2 and 'already exists' in err and (folder / 'a1' / 'S-1.approval.json').read_bytes() == raw

        def altered(name, change):
            copy = folder / 'drafts' / name
            shutil.copytree(clean_path.parent, copy)
            change(copy)
            return copy / clean_path.name
        assert 'not the one the draft record describes' in refused(
            'r', altered('swapped', lambda copy: shutil.copyfile(slanted_zip, copy / clean_zip.name)), clean_zip)
        assert 'not next to the draft record' in refused('r', altered('lost', lambda copy: (copy / clean_zip.name).unlink()), clean_zip)

        def claim(copy):
            value = json.loads((copy / clean_path.name).read_text(encoding='utf-8'))
            value['approval']['approved'] = True
            (copy / clean_path.name).write_text(json.dumps(value), encoding='utf-8')
        assert 'unapproved draft' in refused('r', altered('claimed', claim), clean_zip)
    print('ROI approval record checks passed.')


if __name__ == '__main__':
    main()
