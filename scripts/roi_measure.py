#!/usr/bin/env python3
"""Recompute ROI measurements from original-coordinate ImageJ ROI sets.

Geometry only. Area, length and perimeter come from the stored vertices and the
protocol calibration, so the same ROI file always gives the same table. Intensity
columns need image pixels and are left empty. Nothing here approves an ROI.
"""
import argparse
import csv
import hashlib
import json
import math
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nissl_lab import read_roi_zip, require  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PROTOCOL = ROOT / 'config/nissl-roi-protocol-v1.json'
PROTOCOL_SCHEMA = 'cerebellum-roi-protocol/1'
COLUMNS = ['Sample', 'ROI_Name', 'Tissue_Type', 'ROI_Level', 'Region', 'Part', 'Review',
           'Length', 'Area', 'Mean', 'Integrated_Density', 'Perimeter', 'Feret']
LINE_TYPES = {'line', 'polyline', 'freeline'}
LOCAL_NAME = re.compile(r'([A-Za-z]+)_(.+)_part([1-9][0-9]*)')


def load_protocol(path=DEFAULT_PROTOCOL):
    """Read and validate a protocol file. The identity records which criteria produced a table."""
    path = Path(path)
    require(path.is_file() and path.stat().st_size <= 1024 * 1024, 'Protocol file missing or too large.')
    raw = path.read_bytes()
    protocol = json.loads(raw.decode('utf-8'))
    require(isinstance(protocol, dict) and protocol.get('schema') == PROTOCOL_SCHEMA, 'Unknown protocol schema.')
    for key in ('protocol_id', 'version', 'status', 'approval', 'calibration', 'roi_names', 'measurement', 'qc'):
        require(key in protocol, 'Protocol is missing ' + key + '.')
    for key in ('closure_ratio', 'gl_wm_consistency', 'local_to_total', 'layer_outline', 'unassigned_per_pl_length_um'):
        require(key in protocol['qc'], 'Protocol review rules are missing ' + key + '.')
    scale = protocol['calibration'].get('pixels_per_micron')
    require(isinstance(scale, (int, float)) and not isinstance(scale, bool) and math.isfinite(scale) and scale > 0,
            'Protocol calibration must be a positive number of pixels per micron.')
    names = protocol['roi_names']
    for key in ('totals', 'local', 'lobules', 'lobule_aliases', 'fissure_prefix', 'fissures', 'fissures_seen_once'):
        require(key in names, 'Protocol ROI names are missing ' + key + '.')
    require(all(target in names['lobules'] for target in names['lobule_aliases'].values()),
            'A lobule alias points to a label outside the lobule list.')
    tolerance = protocol['measurement'].get('comparison_tolerance_relative')
    require(isinstance(tolerance, (int, float)) and 0 < tolerance < 1, 'Protocol comparison tolerance is invalid.')
    approved = protocol['approval'].get('approved') is True
    require(approved == (protocol['status'] == 'approved'), 'Protocol status and approval disagree.')
    protocol['identity'] = {'protocol_id': protocol['protocol_id'], 'version': protocol['version'],
                            'status': protocol['status'], 'approved': approved,
                            'sha256': hashlib.sha256(raw).hexdigest()}
    return protocol


def parse_name(name, protocol):
    """Classify an ROI name. Unknown names are reported, never guessed."""
    names = protocol['roi_names']
    blank = {'role': 'unknown', 'tissue': None, 'level': None, 'region': None, 'label': None,
             'part': None, 'alias': None, 'known': False, 'allowed_geometry': []}
    if name in names['totals']:
        entry = names['totals'][name]
        return dict(blank, role='total', tissue=entry['tissue'], level='Total', region='TOTAL', label='TOTAL',
                    part=0, known=True, allowed_geometry=list(entry['geometry']))
    prefix = names['fissure_prefix']
    if name.startswith(prefix) and len(name) > len(prefix):
        label = name[len(prefix):]
        return dict(blank, role='fissure', label=label, region=label, allowed_geometry=['line'],
                    known=label in names['fissures'] or label in names['fissures_seen_once'])
    match = LOCAL_NAME.fullmatch(name)
    if match and match.group(1) in names['local']['tissues']:
        label = match.group(2)
        region = names['lobule_aliases'].get(label, label)
        return dict(blank, role='local', tissue=match.group(1), level='Local', region=region, label=label,
                    part=int(match.group(3)), alias=label if label != region else None,
                    known=region in names['lobules'], allowed_geometry=list(names['local']['tissues'][match.group(1)]))
    return blank


def signed_area(path):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(path, path[1:] + path[:1])) / 2


def area_px2(roi):
    """Signed parts are summed first, so a hole wound against its outline is subtracted."""
    return abs(sum(signed_area(path) for path in roi['paths']))


def path_length(path, closed):
    pairs = zip(path, path[1:] + path[:1]) if closed else zip(path, path[1:])
    return sum(math.dist(a, b) for a, b in pairs)


def axis_aligned(path):
    """True for pixel-edge outlines, as written by the ImageJ wand and by mask conversion."""
    if len(path) < 4 or any(float(v) != int(v) for point in path for v in point):
        return False
    return all(a[0] == b[0] or a[1] == b[1] for a, b in zip(path, path[1:] + path[:1]))


def traced_perimeter(path):
    """ImageJ's perimeter for traced outlines: each corner is shortened to a diagonal."""
    dx_sum = dy_sum = corners = 0
    dx1, dy1 = path[0][0] - path[-1][0], path[0][1] - path[-1][1]
    side1, corner = abs(dx1) + abs(dy1), False
    for a, b in zip(path, path[1:] + path[:1]):
        dx2, dy2 = b[0] - a[0], b[1] - a[1]
        dx_sum += abs(dx1)
        dy_sum += abs(dy1)
        if side1 > 1 or not corner:
            corner = True
            corners += 1
        else:
            corner = False
        dx1, dy1, side1 = dx2, dy2, abs(dx2) + abs(dy2)
    return dx_sum + dy_sum - corners * (2 - math.sqrt(2))


def perimeter_px(roi):
    """Return (value, method). The value is None where ImageJ's own rule is not reproduced."""
    kind = roi.get('type')
    if roi['kind'] != 'area':
        return length_px(roi), 'path-length'
    if kind in ('polygon', 'rectangle'):
        return sum(path_length(path, True) for path in roi['paths']), 'polygon'
    if kind == 'traced':
        if all(axis_aligned(path) for path in roi['paths']):
            return sum(traced_perimeter(path) for path in roi['paths']), 'traced'
        return None, 'not-reproduced'
    if kind == 'composite':
        return sum(traced_perimeter(path) if axis_aligned(path) else path_length(path, True)
                   for path in roi['paths']), 'composite'
    return None, 'not-reproduced'


def length_px(roi):
    return sum(path_length(path, False) for path in roi['paths'])


def outline_construction(roi):
    """How the main outline of an area ROI is built: (construction, vertex count of that outline).

    The main outline is the path enclosing the largest area. 'pixel-edge' means integer vertices joined
    by axis-parallel steps, as written by mask conversion and the ImageJ wand. 'free-polygon' is anything
    else, which is what a polygon placed by hand looks like. It describes the coordinates only: a rectangle
    drawn by hand on whole pixels also reads as pixel-edge.
    """
    if roi['kind'] != 'area':
        return None, None
    main = max(roi['paths'], key=lambda path: abs(signed_area(path)))
    return ('pixel-edge' if axis_aligned(main) else 'free-polygon'), len(main)


def measure(rois, protocol):
    """One record per ROI, in file order, with geometry in micrometres."""
    scale = 1 / protocol['calibration']['pixels_per_micron']
    records = []
    for roi in rois:
        require(roi['kind'] in ('area', 'polyline') and roi['paths'] and all(len(p) >= 2 for p in roi['paths']),
                'ROI ' + str(roi.get('name')) + ' has no measurable geometry.')
        record = parse_name(roi['name'], protocol)
        points = [point for path in roi['paths'] for point in path]
        geometry = 'area' if roi['kind'] == 'area' else 'line'
        perimeter, method = perimeter_px(roi)
        construction, outline_vertices = outline_construction(roi)
        record.update({
            'name': roi['name'], 'geometry': geometry, 'type': roi.get('type'),
            'path_count': len(roi['paths']), 'vertex_count': len(points),
            'bounds': [min(p[0] for p in points), min(p[1] for p in points),
                       max(p[0] for p in points), max(p[1] for p in points)],
            'area_um2': area_px2(roi) * scale * scale if geometry == 'area' else None,
            'length_um': length_px(roi) * scale if geometry == 'line' else None,
            'perimeter_um': None if perimeter is None else perimeter * scale,
            'perimeter_method': method,
            'outline_construction': construction, 'outline_vertices': outline_vertices,
            'geometry_allowed': geometry in record['allowed_geometry'],
        })
        records.append(record)
    return records


def number(value):
    return 'NaN' if value is None else '%.3f' % value


def table_rows(records, sample):
    """Measurement table rows for total and local ROIs. Landmarks and unknown names are not rows."""
    return [{'Sample': sample, 'ROI_Name': r['name'], 'Tissue_Type': r['tissue'], 'ROI_Level': r['level'],
             'Region': r['region'], 'Part': str(r['part']), 'Review': '',
             'Length': number(r['length_um']), 'Area': number(r['area_um2']), 'Mean': 'NaN',
             'Integrated_Density': 'NaN', 'Perimeter': number(r['perimeter_um']), 'Feret': 'NaN'}
            for r in records if r['role'] in ('total', 'local')]


def write_table(rows, path):
    path = Path(path)
    require(not path.exists(), 'Refusing to overwrite an existing file: ' + path.name)
    with path.open('x', newline='', encoding='utf-8') as stream:
        writer = csv.DictWriter(stream, fieldnames=COLUMNS, lineterminator='\n')
        writer.writeheader()
        writer.writerows(rows)


def read_table(path):
    path = Path(path)
    require(path.is_file() and path.stat().st_size <= 8 * 1024 * 1024, 'Measurement table missing or too large.')
    with path.open(newline='', encoding='utf-8-sig') as stream:
        reader = csv.DictReader(stream)
        require(reader.fieldnames is not None and all(c in reader.fieldnames for c in COLUMNS),
                'Measurement table does not have the expected columns.')
        rows = list(reader)
    require(len({row['ROI_Name'] for row in rows}) == len(rows), 'Measurement table repeats an ROI name.')
    return rows


def recorded_number(text):
    text = (text or '').strip()
    if text == '' or text.lower() == 'nan':
        return None
    value = float(text)
    return value if math.isfinite(value) else None


def relative_deviation(value, reference):
    if reference == 0:
        return 0.0 if value == 0 else math.inf
    return abs(value - reference) / abs(reference)


def compare(records, recorded, protocol):
    """Check recomputed geometry against a recorded table, row by row."""
    tolerance = protocol['measurement']['comparison_tolerance_relative']
    aliases = protocol['roi_names']['lobule_aliases']
    measured = {r['name']: r for r in records if r['role'] in ('total', 'local')}
    by_name = {row['ROI_Name']: row for row in recorded}
    fields = {key: {'compared': 0, 'max_relative_deviation': 0.0, 'outside_tolerance': []}
              for key in ('Area', 'Length', 'Perimeter')}
    labels, not_reproduced = [], []
    for name in [n for n in measured if n in by_name]:
        mine, theirs = measured[name], by_name[name]
        region = aliases.get(theirs['Region'], theirs['Region'])
        if (theirs['Tissue_Type'], theirs['ROI_Level'], region, theirs['Part'].strip()) != (
                mine['tissue'], mine['level'], mine['region'], str(mine['part'])):
            labels.append(name)
        pairs = [('Area', mine['area_um2']), ('Perimeter', mine['perimeter_um'])] if mine['geometry'] == 'area' \
            else [('Length', mine['length_um']), ('Perimeter', mine['perimeter_um'])]
        for key, value in pairs:
            reference = recorded_number(theirs[key])
            if reference is None:
                continue
            if value is None:
                not_reproduced.append(name + ':' + key)
                continue
            deviation = relative_deviation(value, reference)
            fields[key]['compared'] += 1
            fields[key]['max_relative_deviation'] = max(fields[key]['max_relative_deviation'], deviation)
            if deviation > tolerance:
                fields[key]['outside_tolerance'].append(name)
    for entry in fields.values():
        entry['max_relative_deviation'] = None if not math.isfinite(entry['max_relative_deviation']) \
            else round(entry['max_relative_deviation'], 9)
    report = {
        'tolerance_relative': tolerance, 'rows_recorded': len(recorded), 'rows_measured': len(measured),
        'rows_compared': len([n for n in measured if n in by_name]),
        'missing_in_roi_file': sorted(n for n in by_name if n not in measured),
        'missing_in_table': sorted(n for n in measured if n not in by_name),
        'label_mismatches': labels, 'fields': fields, 'not_reproduced': not_reproduced,
    }
    report['pass'] = bool(report['rows_compared']) and not (
        report['missing_in_roi_file'] or report['missing_in_table'] or labels
        or any(entry['outside_tolerance'] for entry in fields.values()))
    return report


def section_qc(records, protocol, expected_lobules=None):
    """Consistency values and review signals for one section. Signals order review; they do not approve."""
    names, limits = protocol['roi_names'], protocol['qc']
    flags = []

    def flag(priority, code, detail):
        flags.append({'priority': priority, 'code': code, 'detail': detail})

    totals = {r['name']: r for r in records if r['role'] == 'total'}
    local = [r for r in records if r['role'] == 'local']
    for name in names['totals']:
        if name not in totals:
            flag(1, 'total-missing', name)
    for r in records:
        if r['role'] == 'unknown':
            flag(1, 'name-not-in-protocol', r['name'])
        elif not r['geometry_allowed']:
            flag(1, 'geometry-not-allowed', r['name'] + ' drawn as ' + r['geometry'])
        elif r['role'] == 'fissure' and r['label'] in names['fissures_seen_once']:
            flag(3, 'fissure-label-single-use', r['name'])
        elif r['role'] == 'fissure' and not r['known']:
            flag(3, 'fissure-label-unknown', r['name'])
        elif r['role'] == 'local' and not r['known']:
            flag(2, 'lobule-unknown', r['name'])
    aliases = sorted({r['label'] for r in local if r['alias']})
    if aliases:
        flag(3, 'alias-label', ', '.join(aliases))

    def area(name):
        r = totals.get(name)
        return r['area_um2'] if r and r['geometry'] == 'area' else None

    values = {'area_um2': {name: area(name) for name in names['totals'] if name != 'PL_TOTAL'},
              'pl_total_geometry': totals['PL_TOTAL']['geometry'] if 'PL_TOTAL' in totals else None,
              'pl_total_length_um': totals['PL_TOTAL']['length_um'] if 'PL_TOTAL' in totals else None,
              'closure_ratio': None, 'gl_wm_consistency': None, 'local_to_total': {},
              'outline': {}, 'layer_outline': None, 'unassigned_um2': None, 'unassigned_per_pl_length_um': None}
    cb, ml, gl, wm, glwm = (area(n) for n in ('Cb', 'ML_TOTAL', 'GL_TOTAL', 'WM', 'GL+WM'))
    if None not in (cb, ml, gl, wm) and cb > 0:
        values['closure_ratio'] = (ml + gl + wm) / cb
        rule = limits['closure_ratio']
        # Areas are sums of floating-point terms, so a set that closes exactly can land a rounding step above 1.
        if not rule['review_below'] <= values['closure_ratio'] <= rule['review_above'] + 1e-9:
            flag(1, 'closure-outside-range', '%.3f' % values['closure_ratio'])
        # Width of the band left between the layers, as area per length of the Purkinje line. It is taken
        # from areas alone, so overlapping outlines lower it; it needs PL_TOTAL drawn as a line.
        values['unassigned_um2'] = cb - ml - gl - wm
        if values['pl_total_length_um']:
            values['unassigned_per_pl_length_um'] = values['unassigned_um2'] / values['pl_total_length_um']
            if values['unassigned_per_pl_length_um'] > limits['unassigned_per_pl_length_um']['review_above']:
                flag(2, 'unassigned-band-wide', '%.1f um per PL length' % values['unassigned_per_pl_length_um'])
    # Layer outlines built in different ways leave a different band unassigned, so the build is recorded.
    rule = limits['layer_outline']
    for name in rule['layers']:
        r = totals.get(name)
        if r and r['geometry'] == 'area':
            values['outline'][name] = {'construction': r['outline_construction'], 'vertices': r['outline_vertices']}
    builds = {entry['construction'] for entry in values['outline'].values()}
    if len(values['outline']) == len(rule['layers']) and builds:
        values['layer_outline'] = builds.pop() if len(builds) == 1 else 'mixed'
        if values['layer_outline'] in rule['review_if']:
            flag(2, 'layer-outline-not-pixel-edge', ', '.join(
                '%s %s %d vertices' % (name, entry['construction'], entry['vertices'])
                for name, entry in values['outline'].items()))
    if None not in (gl, wm, glwm) and glwm > 0:
        values['gl_wm_consistency'] = (gl + wm) / glwm
        if abs(values['gl_wm_consistency'] - 1) > limits['gl_wm_consistency']['review_if_deviation_above']:
            flag(1, 'gl-wm-inconsistent', '%.4f' % values['gl_wm_consistency'])
    if values['pl_total_geometry'] == 'area':
        flag(2, 'pl-total-area-band', 'PL_TOTAL has no length')
    rule = limits['local_to_total']
    for tissue, total_name in (('ML', 'ML_TOTAL'), ('GL', 'GL_TOTAL'), ('PL', 'PL_TOTAL')):
        parts, total = [r for r in local if r['tissue'] == tissue], totals.get(total_name)
        key = 'length_um' if tissue == 'PL' else 'area_um2'
        if tissue == 'PL' and any(r['geometry'] == 'area' for r in parts):
            flag(2, 'pl-local-area-band', ', '.join(r['name'] for r in parts if r['geometry'] == 'area'))
        usable = [r[key] for r in parts if r[key] is not None]
        if not parts or total is None or total[key] is None or total[key] <= 0 or len(usable) != len(parts):
            values['local_to_total'][tissue] = None
            continue
        ratio = sum(usable) / total[key]
        values['local_to_total'][tissue] = ratio
        if ratio > rule['review_above']:
            flag(1, 'local-exceeds-total', '%s %.4f' % (tissue, ratio))
        elif ratio < rule[tissue]['review_below']:
            flag(2, 'local-below-total', '%s %.4f' % (tissue, ratio))
    groups = {}
    for r in local:
        groups.setdefault((r['tissue'], r['region']), []).append(r['part'])
    for (tissue, region), parts in sorted(groups.items()):
        if sorted(parts) != list(range(names['local']['first_part'], names['local']['first_part'] + len(parts))):
            flag(2, 'part-number-gap', '%s_%s parts %s' % (tissue, region, sorted(parts)))
    regions = sorted({r['region'] for r in local})
    for region in regions:
        present = {tissue for tissue, name in groups if name == region}
        missing = [tissue for tissue in names['local']['tissues'] if tissue not in present]
        if missing:
            flag(2, 'lobule-layer-missing', region + ' has no ' + ', '.join(missing))
    if expected_lobules is not None:
        expected = {names['lobule_aliases'].get(label, label) for label in expected_lobules}
        for region in sorted(expected - set(regions)):
            flag(2, 'expected-lobule-missing', region)
        for region in sorted(set(regions) - expected):
            flag(2, 'lobule-not-expected', region)
    values['lobules'] = regions
    return {'values': values, 'flags': sorted(flags, key=lambda f: (f['priority'], f['code'], f['detail']))}


def main(argv=None):
    parser = argparse.ArgumentParser(description='Recompute a measurement table from an ImageJ ROI ZIP.')
    parser.add_argument('--roi', required=True, type=Path)
    parser.add_argument('--sample', required=True)
    parser.add_argument('--output', required=True, type=Path, help='New CSV file; an existing file is never overwritten.')
    parser.add_argument('--compare', type=Path, help='Recorded measurement table to check against.')
    parser.add_argument('--protocol', type=Path, default=DEFAULT_PROTOCOL)
    args = parser.parse_args(argv)
    try:
        protocol = load_protocol(args.protocol)
        rois, roi_hash = read_roi_zip(args.roi)
        records = measure(rois, protocol)
        report = {'schema': 'cerebellum-roi-measurement/1', 'protocol': protocol['identity'], 'roi_sha256': roi_hash,
                  'rows': len(table_rows(records, args.sample)), 'qc': section_qc(records, protocol)}
        if args.compare:
            report['comparison'] = compare(records, read_table(args.compare), protocol)
        write_table(table_rows(records, args.sample), args.output)
    except (ValueError, OSError) as error:
        print('Not measured: ' + str(error), file=sys.stderr)
        return 2
    print(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False))
    return 0 if not args.compare or report['comparison']['pass'] else 1


if __name__ == '__main__':
    sys.exit(main())
