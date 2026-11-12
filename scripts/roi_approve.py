#!/usr/bin/env python3
"""Record a person's review of a draft ROI set, and check later that the record still holds.

`record` takes the draft, the montage it was drafted from and the ROI ZIP the reviewer edited. It
writes one record that ties together the image, the model and protocol behind the draft, the ROIs
before and after, what changed and the measurements on both sides. Only a person's explicit
decision approves anything; this tool never approves by itself. `verify` recomputes the hashes and
the table, so an image, ROI file or protocol that changed after approval is found.
"""
import argparse
import datetime
import json
import re
import sys
import zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nissl_lab import digest, file_digest, read_roi_zip, require  # noqa: E402
import roi_measure  # noqa: E402

ENGINE = {'name': 'roi_approve', 'version': '0.1.0'}
RECORD_SCHEMA = 'cerebellum-roi-approval/1'
DRAFT_SCHEMA = 'cerebellum-roi-draft/1'
DECISIONS = ('approved', 'returned')
TIMESTAMP = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z')
MAX_RECORD_BYTES = 8 * 1024 ** 2


def read_json(path, schema, what):
    path = Path(path)
    require(path.is_file() and path.stat().st_size <= MAX_RECORD_BYTES, what + ' is missing or too large.')
    raw = path.read_bytes()
    value = json.loads(raw.decode('utf-8'))
    require(isinstance(value, dict) and value.get('schema') == schema, what + ' has an unknown schema.')
    return value, digest(raw)


def raster(roi, width, height):
    """Pixels whose centre lies inside an area ROI, by the even-odd rule. Exact for whole-pixel outlines."""
    toggles = np.zeros((height, width + 1), np.uint8)
    for path in roi['paths']:
        points = np.asarray(path + [path[0]], np.float64)
        x0, y0, x1, y1 = points[:-1, 0], points[:-1, 1], points[1:, 0], points[1:, 1]
        first = np.clip(np.ceil(np.minimum(y0, y1) - .5), 0, height).astype(np.int64)
        last = np.clip(np.ceil(np.maximum(y0, y1) - .5), 0, height).astype(np.int64)
        count = last - first
        edge = np.repeat(np.flatnonzero(count > 0), count[count > 0])
        if not edge.size:
            continue
        starts = np.cumsum(count[count > 0]) - count[count > 0]
        rows = first[edge] + np.arange(edge.size) - np.repeat(starts, count[count > 0])
        cross = x0[edge] + (rows + .5 - y0[edge]) * (x1[edge] - x0[edge]) / (y1[edge] - y0[edge])
        columns = np.clip(np.ceil(cross - .5), 0, width).astype(np.int64)
        np.bitwise_xor.at(toggles, (rows, columns), 1)
    return np.bitwise_xor.accumulate(toggles, axis=1)[:, :width].astype(bool)


def changes(before, after, records_before, records_after, width, height, pixels_per_micron):
    """What the reviewer changed, ROI by ROI: geometry, measurements on both sides and, for areas, overlap."""
    old, new = {r['name']: r for r in before}, {r['name']: r for r in after}
    measured_old, measured_new = {r['name']: r for r in records_before}, {r['name']: r for r in records_after}
    um2 = 1 / (pixels_per_micron * pixels_per_micron)
    out = []
    for name in list(old) + [n for n in new if n not in old]:
        a, b = old.get(name), new.get(name)
        status = 'added' if a is None else 'removed' if b is None else \
            'unchanged' if (a['kind'], a['paths']) == (b['kind'], b['paths']) else 'changed'
        entry = {'name': name, 'status': status}
        for side, roi, measured in (('before', a, measured_old.get(name)), ('after', b, measured_new.get(name))):
            entry[side] = None if roi is None else {
                'type': roi['type'], 'geometry': measured['geometry'], 'paths': measured['path_count'],
                'vertices': measured['vertex_count'], 'area_um2': measured['area_um2'], 'length_um': measured['length_um']}
        if a is not None and b is not None:
            for key in ('area_um2', 'length_um'):
                x, y = entry['before'][key], entry['after'][key]
                if x is not None and y is not None:
                    entry[key + '_difference'] = y - x
                    entry[key + '_relative_difference'] = (y - x) / x if x else None
            if status == 'changed' and a['kind'] == b['kind'] == 'area':
                ra, rb = raster(a, width, height), raster(b, width, height)
                both, either = int((ra & rb).sum()), int(ra.sum()) + int(rb.sum())
                entry['overlap'] = {'shared_um2': both * um2, 'removed_um2': (int(ra.sum()) - both) * um2,
                                    'added_um2': (int(rb.sum()) - both) * um2,
                                    'dice': 2 * both / either if either else None}
        out.append(entry)
    return out


def flag_keys(flags):
    return sorted({(f['priority'], f['code'], f['detail']) for f in flags})


def build_record(args, now):
    """Read and check everything, and return (record, reviewed ROI bytes, table rows)."""
    require(args.decision in DECISIONS, 'The decision must be one of: ' + ', '.join(DECISIONS) + '.')
    reviewer = ' '.join(args.reviewer.split())
    require(1 <= len(reviewer) <= 80, 'Give the reviewer as a name of at most 80 characters.')
    reviewed_at = args.reviewed_at or now
    require(TIMESTAMP.fullmatch(reviewed_at) is not None, 'Give the review time as UTC, like 2026-11-10T09:30:00Z.')
    datetime.datetime.strptime(reviewed_at, '%Y-%m-%dT%H:%M:%SZ')
    require(args.review_minutes is None or 0 < args.review_minutes <= 6000, 'Review minutes must be a positive number.')
    note = ' '.join((args.note or '').split())
    require(len(note) <= 2000, 'The note is too long.')

    draft, draft_hash = read_json(args.draft, DRAFT_SCHEMA, 'The draft record')
    require(draft.get('status') == 'draft' and draft.get('approval', {}).get('approved') is False,
            'The draft record does not describe an unapproved draft.')
    sample = draft['sample']
    protocol = roi_measure.load_protocol(args.protocol)
    require(protocol['identity']['sha256'] == draft['protocol']['sha256'],
            'The protocol has changed since this draft was made. Draft the section again under the current protocol.')
    require(file_digest(args.image) == draft['source']['sha256'],
            'This is not the image the draft was made from.')
    draft_roi_path = Path(args.draft).parent / draft['outputs']['roi']['file']
    require(draft_roi_path.name == draft['outputs']['roi']['file'] and draft_roi_path.is_file(),
            'The draft ROI file is not next to the draft record.')
    before, before_hash = read_roi_zip(draft_roi_path)
    require(before_hash == draft['outputs']['roi']['sha256'], 'The draft ROI file is not the one the draft record describes.')
    reviewed_bytes = Path(args.roi).read_bytes()
    after, after_hash = read_roi_zip(Path(args.roi))
    require(after_hash == digest(reviewed_bytes), 'The reviewed ROI file changed while it was being read.')
    width, height = draft['source']['width'], draft['source']['height']
    for roi in after:
        require(all(0 <= x <= width and 0 <= y <= height for path in roi['paths'] for x, y in path),
                'ROI ' + roi['name'] + ' lies outside the image.')

    expected = None
    if args.expected_lobules:
        expected = [line.strip() for line in Path(args.expected_lobules).read_text(encoding='utf-8').splitlines() if line.strip()]
    records_before = roi_measure.measure(before, protocol)
    records_after = roi_measure.measure(after, protocol)
    qc_before = roi_measure.section_qc(records_before, protocol)
    qc_after = roi_measure.section_qc(records_after, protocol, expected)
    open_flags = qc_after['flags']
    approved = args.decision == 'approved'
    if approved:
        require(not any(f['priority'] == 1 for f in open_flags) or note,
                'Priority 1 checks are still open. Approving them needs a note that says why: '
                + ', '.join(sorted({f['code'] for f in open_flags if f['priority'] == 1})))

    supersedes = None
    if args.previous:
        previous, previous_hash = read_json(args.previous, RECORD_SCHEMA, 'The earlier review record')
        require(previous['sample'] == sample and previous['source']['sha256'] == draft['source']['sha256'],
                'The earlier review record is for another section or image.')
        supersedes = {'record_sha256': previous_hash, 'decision': previous['decision'],
                      'reviewed_at': previous['review']['reviewed_at'], 'roi_sha256': previous['reviewed_roi']['sha256']}

    change_list = changes(before, after, records_before, records_after, width, height,
                          protocol['calibration']['pixels_per_micron'])
    counts = {status: sum(1 for c in change_list if c['status'] == status) for status in ('added', 'removed', 'changed', 'unchanged')}
    queue = draft.get('review_queue', [])
    first_tier = sorted({item['code'] for item in queue if item['tier'] == 1})
    if approved and first_tier and counts['unchanged'] == len(change_list):
        require(note, 'The draft listed priority 1 review items and no ROI was changed. Approving it as it is needs a '
                      'note that says why: ' + ', '.join(first_tier))
    rows = roi_measure.table_rows(records_after, sample)
    folder = Path(__file__).resolve().parent
    record = {
        'schema': RECORD_SCHEMA, 'sample': sample, 'decision': args.decision,
        'approval': {'approved': approved,
                     'statement': ('Approved by the reviewer named here under a protocol that is itself still a draft.'
                                   if approved and not protocol['identity']['approved'] else
                                   'Approved by the reviewer named here.' if approved else
                                   'Returned for more editing. Nothing here is approved.')},
        'review': {'reviewer': reviewer, 'reviewer_identity': 'as typed; this tool does not check who is at the keyboard',
                   'reviewed_at': reviewed_at, 'review_minutes': args.review_minutes, 'note': note or None,
                   'edited': counts['unchanged'] != len(change_list)},
        'source': draft['source'], 'model': draft['model'], 'protocol': protocol['identity'],
        'draft': {'record_sha256': draft_hash, 'roi_sha256': before_hash, 'engine': draft['engine'],
                  'labels': {key: draft['labels'][key] for key in ('model_sha256', 'draft_sha256')},
                  'review_queue': {'items': len(queue),
                                   'by_tier': {str(tier): sum(1 for item in queue if item['tier'] == tier) for tier in (1, 2, 3)},
                                   'priority_1_codes': first_tier},
                  'not_drafted': draft.get('not_drafted', [])},
        'engine': dict(ENGINE, code_sha256={name: file_digest(folder / name)
                                            for name in ('roi_approve.py', 'roi_measure.py', 'nissl_lab.py')}),
        'reviewed_roi': {'sha256': after_hash, 'bytes': len(reviewed_bytes), 'rois': len(after), 'file': None},
        'table': None,
        'changes': {'counts': counts, 'rois': change_list},
        'measurement': {'before': qc_before['values'], 'after': qc_after['values']},
        'checks': {'open_flags': open_flags,
                   'cleared_by_review': [list(k) for k in flag_keys(qc_before['flags']) if k not in flag_keys(open_flags)],
                   'expected_lobules_given': expected is not None},
        'supersedes': supersedes,
        'limits': ['This record is not signed. Keep it with the ROI file and table it names; `verify` detects a changed '
                   'image, ROI file, table or protocol, not a rewritten record.',
                   'Overlap compares areas only. A moved line shows as a change in length, not in position.'],
    }
    return record, reviewed_bytes, rows


def write_review(args, now):
    record, reviewed_bytes, rows = build_record(args, now)
    output = Path(args.output).resolve()
    require(not output.exists(), 'The output folder already exists; review records are never written over.')
    sample = record['sample']
    output.mkdir(parents=True)
    if record['approval']['approved']:
        # Only an approved set gets an ROI file and a table under final-looking names.
        roi_path, table_path = output / (sample + '.approved-roi.zip'), output / (sample + '.measurement.csv')
        with roi_path.open('xb') as stream:
            stream.write(reviewed_bytes)
        roi_measure.write_table(rows, table_path)
        record['reviewed_roi']['file'] = roi_path.name
        record['table'] = {'file': table_path.name, 'sha256': file_digest(table_path), 'rows': len(rows)}
    path = output / (sample + '.approval.json')
    with path.open('x', encoding='utf-8') as stream:
        stream.write(json.dumps(record, indent=2, ensure_ascii=False, allow_nan=False) + '\n')
    return record, path


def verify(record_path, image, protocol_path):
    """Check an approval against the files as they are now. Returns the report; 'valid' is the verdict."""
    record, record_hash = read_json(record_path, RECORD_SCHEMA, 'The review record')
    checks = {'decision_is_approved': record.get('decision') == 'approved' and record['approval'].get('approved') is True}
    folder = Path(record_path).parent
    protocol = roi_measure.load_protocol(protocol_path)
    checks['protocol_unchanged'] = protocol['identity']['sha256'] == record['protocol']['sha256']
    checks['image_unchanged'] = file_digest(image) == record['source']['sha256']
    checks['roi_file_unchanged'] = checks['table_unchanged'] = checks['table_reproduced'] = False
    name = record['reviewed_roi'].get('file')
    table = record.get('table')
    if name and table and Path(name).name == name and Path(table['file']).name == table['file'] \
            and (folder / name).is_file() and (folder / table['file']).is_file():
        checks['roi_file_unchanged'] = file_digest(folder / name) == record['reviewed_roi']['sha256']
        checks['table_unchanged'] = file_digest(folder / table['file']) == table['sha256']
        try:
            rois = read_roi_zip(folder / name)[0]
        except (ValueError, zipfile.BadZipFile):
            rois = None    # a file that no longer reads as an ROI ZIP cannot reproduce the table
        if rois is not None and checks['protocol_unchanged']:
            rows = roi_measure.table_rows(roi_measure.measure(rois, protocol), record['sample'])
            checks['table_reproduced'] = rows == roi_measure.read_table(folder / table['file'])
    return {'schema': 'cerebellum-roi-approval-check/1', 'sample': record['sample'], 'record_sha256': record_hash,
            'valid': all(checks.values()), 'checks': checks,
            'meaning': 'valid means the approved files and the protocol are the ones the reviewer approved; '
                       'it says nothing about anatomical accuracy'}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Record a person's review of a draft ROI set, or verify a record.")
    commands = parser.add_subparsers(dest='command', required=True)
    record = commands.add_parser('record', help='Write a review record for one section.')
    record.add_argument('--draft', required=True, type=Path, help='The <sample>.draft.json written by roi_draft.')
    record.add_argument('--image', required=True, type=Path, help='The montage the draft was made from.')
    record.add_argument('--roi', required=True, type=Path, help='The ROI ZIP after the reviewer edited it.')
    record.add_argument('--reviewer', required=True)
    record.add_argument('--decision', required=True, choices=DECISIONS)
    record.add_argument('--output', required=True, type=Path, help='New folder; an existing one is never touched.')
    record.add_argument('--note')
    record.add_argument('--review-minutes', type=float, help='Time the reviewer spent, as they state it.')
    record.add_argument('--reviewed-at', help='UTC time of the review; the current time when omitted.')
    record.add_argument('--previous', type=Path, help='An earlier review record of this section that this one replaces.')
    record.add_argument('--expected-lobules', type=Path)
    record.add_argument('--protocol', type=Path, default=roi_measure.DEFAULT_PROTOCOL)
    check = commands.add_parser('verify', help='Check that an approval still matches its files.')
    check.add_argument('--record', required=True, type=Path)
    check.add_argument('--image', required=True, type=Path)
    check.add_argument('--protocol', type=Path, default=roi_measure.DEFAULT_PROTOCOL)
    args = parser.parse_args(argv)
    try:
        if args.command == 'verify':
            report = verify(args.record, args.image, args.protocol)
            print(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False))
            return 0 if report['valid'] else 1
        now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        written, path = write_review(args, now)
    except (ValueError, OSError, KeyError, zipfile.BadZipFile) as error:
        print(('Not checked: ' if args.command == 'verify' else 'Not recorded: ') + str(error), file=sys.stderr)
        return 2
    print(json.dumps({'schema': written['schema'], 'sample': written['sample'], 'decision': written['decision'],
                      'approved': written['approval']['approved'], 'record': path.name,
                      'changes': written['changes']['counts'], 'open_flags': len(written['checks']['open_flags'])},
                     indent=2, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
