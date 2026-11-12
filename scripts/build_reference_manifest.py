#!/usr/bin/env python3
"""List the reference ROI sets of a research folder and check them against the ROI protocol.

Read-only on the source folder. For every final measurement table it finds the ROI set and image
beside it, records their hashes, recomputes the table from the ROI coordinates, compares it with the
recorded table and lists review signals. Results go to a new folder outside the source and outside
this repository. Nothing here approves a section, an ROI or the protocol.
"""
import argparse
import csv
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nissl_lab import file_digest, read_roi_zip, require  # noqa: E402
from research_intake_checks import tiff_metadata  # noqa: E402
import roi_measure  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_COHORT = ROOT / 'config/research-cohort-declaration.json'
SCHEMA = 'cerebellum-reference-manifest/1'
COHORT_SCHEMA = 'cerebellum-cohort-declaration/1'
TABLE_SUFFIX = '_CRA_Structured_Measurements.csv'
ROI_SUFFIX = '_CRA_ROIs.zip'
LOBULES_SUFFIX = '_CRA_Expected_Lobules.txt'
SECTION_ID = re.compile(r'([A-Za-z0-9]+)-([0-9]+)')
MM2, MM = 1e-6, 1e-3


def inside(path, folder):
    return path == folder or folder in path.parents


def load_cohort(path):
    path = Path(path)
    require(path.is_file() and path.stat().st_size <= 1024 * 1024, 'Cohort declaration missing or too large.')
    cohort = json.loads(path.read_text(encoding='utf-8'))
    require(isinstance(cohort, dict) and cohort.get('schema') == COHORT_SCHEMA, 'Unknown cohort declaration schema.')
    animals = cohort.get('animals')
    require(isinstance(animals, list) and animals and all(
        isinstance(a, dict) and isinstance(a.get('id'), str) and isinstance(a.get('group'), str) for a in animals),
        'Cohort declaration lists no animals.')
    require(len({a['id'] for a in animals}) == len(animals), 'Cohort declaration repeats an animal.')
    return {'id': cohort.get('id'), 'sha256': file_digest(path), 'roi_review': cohort.get('roi_review'),
            'statement': cohort.get('statement'), 'groups': {a['id']: a['group'] for a in animals}}


def section_key(section_id):
    animal, number = section_id.rsplit('-', 1)
    digits = re.match(r'[0-9]*', animal).group()
    return (int(digits) if digits else 0, animal, int(number))


def find_image(table, source, tables):
    """The only TIFF beside the final table, else the only TIFF one folder above when that folder
    holds no other section. A name match is not proof of correspondence; the coordinate check adds evidence."""
    def tiffs(folder):
        return sorted(p for p in folder.iterdir() if p.is_file() and not p.name.startswith('.')
                      and p.suffix.lower() in ('.tif', '.tiff'))
    here = tiffs(table.parent)
    if len(here) == 1:
        return here[0], 'only TIFF beside the final table', None
    if len(here) > 1:
        return None, None, 'image-ambiguous'
    parent = table.parent.parent
    if parent != source and inside(parent, source) and all(t == table or not inside(t, parent) for t in tables):
        above = tiffs(parent)
        if len(above) == 1:
            return above[0], 'only TIFF one folder above the final table', None
        if len(above) > 1:
            return None, None, 'image-ambiguous'
    return None, None, 'image-missing'


def build(source, output, protocol_path=roi_measure.DEFAULT_PROTOCOL, cohort_path=DEFAULT_COHORT):
    source, output = Path(source).resolve(), Path(output).resolve()
    require(source.is_dir(), 'Source folder not found.')
    require(not output.exists(), 'Output folder already exists; choose a new folder.')
    require(output.parent.is_dir(), 'The folder that should hold the output does not exist.')
    require(not inside(output, source) and not inside(source, output), 'Output must be outside the source folder.')
    require(not inside(output, ROOT), 'Output must be outside the repository.')
    protocol = roi_measure.load_protocol(protocol_path)
    cohort = load_cohort(cohort_path)
    read = {}

    def track(path):
        stat = path.stat()
        read.setdefault(path, (stat.st_size, stat.st_mtime_ns))
        return path

    def relative(path):
        return path.relative_to(source).as_posix()

    def record(path):
        track(path)
        return {'path': relative(path), 'bytes': path.stat().st_size, 'sha256': file_digest(path)}

    tables = sorted(p for p in source.rglob('*' + TABLE_SUFFIX) if p.is_file() and not p.name.startswith('.'))
    candidates, not_included, issues = {}, [], []
    for table in tables:
        stem = table.name[:-len(TABLE_SUFFIX)]
        section_id = stem[:-4] if stem.endswith('.img') else stem
        match = SECTION_ID.fullmatch(section_id)
        if not match:
            not_included.append({'path': relative(table), 'reason': 'section-id-not-recognised'})
        elif match.group(1) not in cohort['groups']:
            not_included.append({'path': relative(table), 'reason': 'animal-not-in-cohort-declaration'})
        elif not (table.parent / (stem + ROI_SUFFIX)).is_file():
            not_included.append({'path': relative(table), 'reason': 'final-roi-set-missing'})
        else:
            candidates.setdefault(section_id, []).append((table, stem, match.group(1)))
    for section_id, found in sorted(candidates.items()):
        if len(found) > 1:
            issues.append({'code': 'duplicate-section-id', 'section_id': section_id,
                           'paths': [relative(t) for t, _, _ in found]})
            not_included += [{'path': relative(t), 'reason': 'duplicate-section-id'} for t, _, _ in found]
    # Section folders of declared animals that hold no final table are listed, not silently skipped.
    covered = {t.parent for t in tables} | {p for t in tables for p in t.parents}
    for folder in sorted(p for p in source.rglob('*') if p.is_dir() and not p.name.startswith('.')):
        name = folder.name[:-4] if folder.name.endswith('.img') else folder.name
        match = SECTION_ID.fullmatch(name)
        if match and match.group(1) in cohort['groups'] and folder not in covered:
            not_included.append({'path': relative(folder), 'reason': 'no-final-measurement-table'})

    output.mkdir()
    try:
        return _build(source, output, protocol, cohort, tables, candidates, not_included, issues, read, track, relative, record)
    except BaseException:
        shutil.rmtree(output, ignore_errors=True)  # only the folder this run created
        raise


def _build(source, output, protocol, cohort, tables, candidates, not_included, issues, read, track, relative, record):
    (output / 'measurements').mkdir()
    sections = []
    for section_id in sorted((s for s, found in candidates.items() if len(found) == 1), key=section_key):
        table, stem, animal = candidates[section_id][0]
        roi_path = table.parent / (stem + ROI_SUFFIX)
        flags = []
        try:
            rois, roi_hash = read_roi_zip(track(roi_path))
            records = roi_measure.measure(rois, protocol)
            recorded = roi_measure.read_table(track(table))
        except (ValueError, OSError, KeyError) as error:
            not_included.append({'path': relative(table), 'reason': 'not-readable: ' + str(error)})
            continue
        entry = {'section_id': section_id, 'animal_id': animal, 'group': cohort['groups'][animal],
                 'roi_review_statement': cohort['roi_review'], 'approval': None, 'files': {}}
        entry['files']['roi'] = dict(record(roi_path), roi_count=len(records), roles={
            role: sum(r['role'] == role for r in records) for role in ('total', 'local', 'fissure', 'unknown')})
        require(entry['files']['roi']['sha256'] == roi_hash, 'ROI file changed while it was being read.')
        samples = sorted({row['Sample'] for row in recorded})
        entry['files']['table'] = dict(record(table), rows=len(recorded), sample_labels=samples)

        image, basis, problem = find_image(table, source, tables)
        entry['files']['image'] = None
        entry['coordinate_check'] = None
        if problem:
            flags.append({'priority': 1, 'code': problem, 'detail': 'no single TIFF found for this section'})
        else:
            try:
                meta = tiff_metadata(track(image))
                entry['files']['image'] = dict(record(image), width=meta['width'], height=meta['height'], match_basis=basis)
                bounds = [min(r['bounds'][0] for r in records), min(r['bounds'][1] for r in records),
                          max(r['bounds'][2] for r in records), max(r['bounds'][3] for r in records)]
                fits = bounds[0] >= 0 and bounds[1] >= 0 and bounds[2] <= meta['width'] and bounds[3] <= meta['height']
                entry['coordinate_check'] = {'roi_bounds': bounds, 'image_size': [meta['width'], meta['height']],
                                             'inside_image': fits}
                if not fits:
                    flags.append({'priority': 1, 'code': 'roi-outside-image', 'detail': str(bounds)})
            except (ValueError, OSError) as error:
                flags.append({'priority': 1, 'code': 'image-not-readable', 'detail': str(error)})

        expected = None
        lobules = table.parent / (stem + LOBULES_SUFFIX)
        entry['files']['expected_lobules'] = None
        if lobules.is_file() and lobules.stat().st_size <= 65536:
            expected = [label.strip() for label in lobules.read_text(encoding='utf-8-sig').replace('\n', ',').split(',') if label.strip()]
            entry['files']['expected_lobules'] = dict(record(lobules), labels=expected)
        else:
            flags.append({'priority': 3, 'code': 'expected-lobules-file-missing', 'detail': stem + LOBULES_SUFFIX})

        others = []
        for other in sorted(table.parent.glob('*_CRA_ROIs*.zip')):
            if other != roi_path and other.is_file() and not other.name.startswith('.'):
                item = record(other)
                item['same_content_as_final'] = item['sha256'] == roi_hash
                others.append(item)
                if not item['same_content_as_final']:
                    flags.append({'priority': 2, 'code': 'other-final-like-roi-file', 'detail': other.name})
        entry['other_roi_files'] = others

        comparison = roi_measure.compare(records, recorded, protocol)
        entry['measurement_check'] = comparison
        if not comparison['pass']:
            flags.append({'priority': 1, 'code': 'measurement-mismatch', 'detail': 'recomputed table differs from the recorded table'})
        qc = roi_measure.section_qc(records, protocol, expected)
        entry['values'] = qc['values']
        entry['flags'] = sorted(flags + qc['flags'], key=lambda f: (f['priority'], f['code'], f['detail']))
        entry['review_priority'] = min((f['priority'] for f in entry['flags']), default=None)
        target = output / 'measurements' / (section_id + '.measurement.csv')
        roi_measure.write_table(roi_measure.table_rows(records, section_id), target)
        entry['recomputed_table'] = {'path': target.relative_to(output).as_posix(), 'sha256': file_digest(target),
                                     'rows': len(roi_measure.table_rows(records, section_id))}
        sections.append(entry)

    changed = [relative(p) for p, (size, mtime) in read.items()
               if not p.is_file() or (p.stat().st_size, p.stat().st_mtime_ns) != (size, mtime)]
    require(not changed, 'Source files changed during the run: ' + ', '.join(changed[:5]))

    animals = []
    for animal in sorted(cohort['groups'], key=lambda a: section_key(a + '-0')):
        own = [s for s in sections if s['animal_id'] == animal]
        lengths = [s['values']['pl_total_length_um'] for s in own if s['values']['pl_total_length_um'] is not None]
        def total(name):
            values = [s['values']['area_um2'][name] for s in own]
            return None if not own or None in values else sum(values) * MM2
        animals.append({'animal_id': animal, 'group': cohort['groups'][animal], 'sections': len(own),
                        'sum_area_mm2': {name: total(name) for name in ('Cb', 'ML_TOTAL', 'GL_TOTAL', 'WM', 'GL+WM')},
                        'pl_length_sections': len(lengths), 'sum_pl_length_mm': sum(lengths) * MM if lengths else None,
                        'sections_with_priority_1': sum(s['review_priority'] == 1 for s in own),
                        'sections_with_any_flag': sum(bool(s['flags']) for s in own)})
    fields = {}
    for name in ('Area', 'Length', 'Perimeter'):
        parts = [s['measurement_check']['fields'][name] for s in sections]
        fields[name] = {'compared': sum(p['compared'] for p in parts),
                        'max_relative_deviation': max((p['max_relative_deviation'] for p in parts if p['compared'] and p['max_relative_deviation'] is not None), default=None),
                        'outside_tolerance': sum(len(p['outside_tolerance']) for p in parts)}
    codes = {}
    for s in sections:
        for f in s['flags']:
            codes[f['code']] = codes.get(f['code'], 0) + 1
    manifest = {
        'schema': SCHEMA,
        'created_utc': datetime.now(timezone.utc).isoformat(),
        'statement': 'Inventory and automatic checks only. This file approves no section, no ROI and no protocol. '
                     'Review status and groups are the researcher statements in the cohort declaration.',
        'source_folder_name': source.name,
        'originals_modified': False,
        'uploaded': False,
        'paths': 'relative to the source folder, or to this folder for recomputed tables',
        'protocol': protocol['identity'],
        'cohort_declaration': {k: cohort[k] for k in ('id', 'sha256', 'roi_review', 'statement')},
        'summary': {
            'sections': len(sections), 'not_included': len(not_included), 'issues': len(issues),
            'source_files_read': len(read),
            'measurement_check': {'tolerance_relative': protocol['measurement']['comparison_tolerance_relative'],
                                  'sections_passing': sum(s['measurement_check']['pass'] for s in sections),
                                  'rows_compared': sum(s['measurement_check']['rows_compared'] for s in sections),
                                  'fields': fields,
                                  'perimeters_not_reproduced': sum(len(s['measurement_check']['not_reproduced']) for s in sections)},
            'sections_by_review_priority': {str(p): sum(s['review_priority'] == p for s in sections) for p in (1, 2, 3)},
            'sections_without_flags': sum(not s['flags'] for s in sections),
            'flag_counts': dict(sorted(codes.items())),
        },
        'animals': animals,
        'sections': sections,
        'not_included': sorted(not_included, key=lambda item: item['path']),
        'issues': issues,
    }

    def write_csv(name, header, rows):
        with (output / name).open('x', newline='', encoding='utf-8') as stream:
            writer = csv.writer(stream, lineterminator='\n')
            writer.writerow(header)
            writer.writerows(rows)

    def shown(value, digits=4):
        return '' if value is None else ('%.' + str(digits) + 'f') % value

    queue = sorted(((f['priority'], section_key(s['section_id']), s, f) for s in sections for f in s['flags']),
                   key=lambda item: item[:2] + (item[3]['code'], item[3]['detail']))
    write_csv('review-queue.csv', ['Priority', 'Animal', 'Group', 'Section', 'Signal', 'Detail'],
              [[p, s['animal_id'], s['group'], s['section_id'], f['code'], f['detail']] for p, _, s, f in queue])
    write_csv('measurement-check.csv',
              ['Section', 'Rows_Recorded', 'Rows_Compared', 'Area_Rows', 'Area_Max_Relative_Deviation', 'Length_Rows',
               'Length_Max_Relative_Deviation', 'Perimeter_Rows', 'Perimeter_Max_Relative_Deviation',
               'Perimeter_Not_Reproduced', 'Pass'],
              [[s['section_id'], c['rows_recorded'], c['rows_compared'],
                c['fields']['Area']['compared'], shown(c['fields']['Area']['max_relative_deviation'], 6),
                c['fields']['Length']['compared'], shown(c['fields']['Length']['max_relative_deviation'], 6),
                c['fields']['Perimeter']['compared'], shown(c['fields']['Perimeter']['max_relative_deviation'], 6),
                len(c['not_reproduced']), 'yes' if c['pass'] else 'no']
               for s in sections for c in [s['measurement_check']]])
    write_csv('section-values.csv',
              ['Section', 'Animal', 'Group', 'Cb_mm2', 'ML_mm2', 'GL_mm2', 'WM_mm2', 'GL+WM_mm2', 'PL_Geometry', 'PL_Length_mm',
               'Closure_Ratio', 'GL_WM_Consistency', 'Layer_Outline', 'ML_Outline_Vertices', 'GL_Outline_Vertices',
               'Unassigned_mm2', 'Unassigned_per_PL_um', 'Local_ML_Ratio', 'Local_GL_Ratio', 'Local_PL_Ratio', 'Lobules',
               'Image_Width', 'Image_Height', 'ROI_Inside_Image', 'Review_Priority'],
              [[s['section_id'], s['animal_id'], s['group']]
               + [shown(None if v['area_um2'][n] is None else v['area_um2'][n] * MM2) for n in ('Cb', 'ML_TOTAL', 'GL_TOTAL', 'WM', 'GL+WM')]
               + [v['pl_total_geometry'] or '', shown(None if v['pl_total_length_um'] is None else v['pl_total_length_um'] * MM),
                  shown(v['closure_ratio']), shown(v['gl_wm_consistency']), v['layer_outline'] or '']
               + [v['outline'][n]['vertices'] if n in v['outline'] else '' for n in ('ML_TOTAL', 'GL_TOTAL')]
               + [shown(None if v['unassigned_um2'] is None else v['unassigned_um2'] * MM2),
                  shown(v['unassigned_per_pl_length_um'], 2)]
               + [shown(v['local_to_total'].get(t)) for t in ('ML', 'GL', 'PL')]
               + [' '.join(v['lobules'])]
               + ([s['files']['image']['width'], s['files']['image']['height']] if s['files']['image'] else ['', ''])
               + ['' if s['coordinate_check'] is None else 'yes' if s['coordinate_check']['inside_image'] else 'no',
                  s['review_priority'] or '']
               for s in sections for v in [s['values']]])
    write_csv('animal-summary.csv',
              ['Animal', 'Group', 'Sections', 'Sum_Cb_mm2', 'Sum_ML_mm2', 'Sum_GL_mm2', 'Sum_WM_mm2', 'Sum_GL+WM_mm2',
               'PL_Length_Sections', 'Sum_PL_Length_mm', 'Sections_With_Priority_1', 'Sections_With_Any_Signal'],
              [[a['animal_id'], a['group'], a['sections']]
               + [shown(a['sum_area_mm2'][n]) for n in ('Cb', 'ML_TOTAL', 'GL_TOTAL', 'WM', 'GL+WM')]
               + [a['pl_length_sections'], shown(a['sum_pl_length_mm']), a['sections_with_priority_1'], a['sections_with_any_flag']]
               for a in animals])
    with (output / 'reference-manifest.json').open('x', encoding='utf-8') as stream:
        json.dump(manifest, stream, indent=2, ensure_ascii=False, allow_nan=False)
        stream.write('\n')
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description='List reference ROI sets and check them against the ROI protocol (read-only).')
    parser.add_argument('--source', required=True, type=Path, help='Research folder. It is only read.')
    parser.add_argument('--output', required=True, type=Path, help='New folder outside the source and the repository.')
    parser.add_argument('--protocol', type=Path, default=roi_measure.DEFAULT_PROTOCOL)
    parser.add_argument('--cohort', type=Path, default=DEFAULT_COHORT)
    args = parser.parse_args(argv)
    try:
        manifest = build(args.source, args.output, args.protocol, args.cohort)
    except (ValueError, OSError) as error:
        print('Not built: ' + str(error), file=sys.stderr)
        return 2
    print(json.dumps({'protocol': manifest['protocol'], 'summary': manifest['summary'], 'animals': manifest['animals'],
                      'not_included': manifest['not_included'], 'issues': manifest['issues']},
                     indent=2, ensure_ascii=False, allow_nan=False))
    check = manifest['summary']['measurement_check']
    return 0 if check['sections_passing'] == manifest['summary']['sections'] and not manifest['issues'] else 1


if __name__ == '__main__':
    sys.exit(main())
