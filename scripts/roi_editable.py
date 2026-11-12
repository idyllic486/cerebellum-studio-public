#!/usr/bin/env python3
"""ROI files that can be corrected by hand in ImageJ or Fiji, and the way back.

ImageJ lets a person drag the vertices of a polygon or a polyline, but not of a traced outline or of a composite
shape, and it treats a composite as one object. The draft, proposal and approved ROI files hold exactly those two
kinds. This tool writes the same section as plain polygons:

  export   Cb, GL+WM and WM are split into their separate parts; every part and every hole becomes one polygon with few
           enough vertices to drag (<name>_part01, <name>_part01_hole01, ...). PL_TOTAL is passed on. ML_TOTAL and
           GL_TOTAL are not written: they follow from the three outlines (ML = Cb outside GL+WM, GL = GL+WM outside WM).
  rebuild  reads the corrected polygons, puts the layers together again, takes the Purkinje band out of ML and writes
           the usual ROI ZIP and measurement table. The result is not approved; roi_approve records an approval.

Simplifying an outline moves it by at most the stated tolerance. The areas before and after are reported.
"""
import argparse
import json
import re
import struct
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nissl_lab import file_digest, read_roi_zip, require  # noqa: E402
import roi_draft as D  # noqa: E402
import roi_measure  # noqa: E402
from roi_approve import raster  # noqa: E402

SCHEMA = 'cerebellum-roi-editable/1'
OUTLINES = ('Cb', 'GL+WM', 'WM')
PARAMETERS = {'status': 'proposed', 'simplify_tolerance_px': 1.5, 'min_part_area_px': 16, 'min_hole_area_px': 16,
              # Proposed from the reviewer's remark of 2026-11-12 that every part after the first was a piece to delete, and from the
              # 66 human ROI files, where the separate parts of Cb and GL+WM are either under 1,000 um2 or over 50,000 um2.
              # The largest part of an outline is always written.
              'drop_secondary_parts_below_um2': 10000.0}
EDIT_NAME = re.compile(r'^(Cb|GL\+WM|WM)(?:_.*)?$')
STATEMENT = 'Polygons for correction by hand. Not a draft record, not a measurement and not an approval.'


def encode_polygon(name, path):
    """One ImageJ polygon ROI (type 0), the kind whose vertices can be dragged."""
    require(3 <= len(path) <= 65535 and all(type(v) is int for p in path for v in p), 'Polygon ' + name + ' cannot be written.')
    left, top = min(p[0] for p in path), min(p[1] for p in path)
    right, bottom = max(p[0] for p in path), max(p[1] for p in path)
    header = bytearray(64)
    header[0:4] = b'Iout'
    struct.pack_into('>H', header, 4, 228)
    for offset, value in ((8, top), (10, left), (12, bottom), (14, right)):
        header[offset:offset + 2] = D.pack_short(value)
    header[6] = 0
    struct.pack_into('>H', header, 16, len(path))
    body = b''.join(D.pack_short(p[0] - left) for p in path) + b''.join(D.pack_short(p[1] - top) for p in path)
    second = bytearray(64)
    struct.pack_into('>i', header, 60, 64 + len(body))
    struct.pack_into('>i', second, 16, 64 + len(body) + 64)
    struct.pack_into('>i', second, 20, len(name))
    return bytes(header) + body + bytes(second) + name.encode('utf-16-be')


def simplify_open(points, tolerance):
    """Douglas-Peucker with both ends fixed. Distances are rounded to a millionth of a pixel before they are compared, and
    the first of equal distances wins, so that the JavaScript port in the site picks the same vertices."""
    count = len(points)
    if count <= 2 or tolerance <= 0:
        return [list(p) for p in points]
    pts = np.asarray(points, np.float64)
    keep = np.zeros(count, bool)
    keep[0] = keep[-1] = True
    stack = [(0, count - 1)]
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        chord, rel = pts[j] - pts[i], pts[i + 1:j] - pts[i]
        square = float(chord[0] * chord[0] + chord[1] * chord[1])
        along = np.clip((rel[:, 0] * chord[0] + rel[:, 1] * chord[1]) / square, 0, 1) if square else np.zeros(len(rel))
        gx, gy = rel[:, 0] - along * chord[0], rel[:, 1] - along * chord[1]
        distance = np.floor(np.sqrt(gx * gx + gy * gy) * 1e6 + .5)
        k = int(distance.argmax())
        if distance[k] > tolerance * 1e6:
            keep[i + 1 + k] = True
            stack.append((i, i + 1 + k))
            stack.append((i + 1 + k, j))
    return [list(points[i]) for i in np.flatnonzero(keep).tolist()]


def simplify_closed(path, tolerance):
    """Douglas-Peucker on a closed outline: the first vertex and the vertex farthest from it stay."""
    if len(path) <= 4 or tolerance <= 0:
        return [list(p) for p in path]
    pts = np.asarray(path, np.int64)
    far = int(((pts - pts[0]) ** 2).sum(axis=1).argmax())      # whole-number distances: no rounding, the first of equals wins
    first, second = simplify_open(path[:far + 1], tolerance), simplify_open(path[far:] + [path[0]], tolerance)
    out = first[:-1] + second[:-1]
    return out if len(out) >= 3 else [list(p) for p in path]


def area_mask(rois, name, height, width):
    found = [r for r in rois if r['name'] == name]
    if name == 'WM' and not found:  # a section can be without white matter
        return np.zeros((height, width), bool)
    require(len(found) == 1 and found[0]['kind'] == 'area', 'The ROI file needs exactly one area named ' + name + '.')
    return raster(found[0], width, height)


def split(mask, parameters, um2=None):
    """Separate parts of a mask as (outer outline, hole outlines), largest first, each simplified. Parts after the
    largest that are smaller than the stated area are left out and counted."""
    found, parts = D.components(mask)
    out, dropped = [], {'parts': 0, 'part_px': 0, 'holes': 0, 'hole_px': 0, 'small_secondary_parts': 0, 'small_secondary_part_um2': 0.0,
                        'largest_left_out_um2': 0.0}
    limit = parameters.get('drop_secondary_parts_below_um2') or 0
    for index, part in enumerate(parts):
        x0, y0, x1, y1 = part['bounds']
        if part['area_px'] < parameters['min_part_area_px']:
            dropped['parts'] += 1
            dropped['part_px'] += part['area_px']
            continue
        if index and um2 and part['area_px'] * um2 < limit:
            dropped['small_secondary_parts'] += 1
            dropped['small_secondary_part_um2'] += part['area_px'] * um2
            dropped['largest_left_out_um2'] = max(dropped['largest_left_out_um2'], part['area_px'] * um2)
            continue
        paths = D.trace_mask(found[y0:y1, x0:x1] == part['label'])
        sized = sorted(((abs(roi_measure.signed_area(p)), p) for p in paths), key=lambda t: -t[0])
        outer, holes = sized[0][1], []
        for size, path in sized[1:]:
            if size < parameters['min_hole_area_px']:
                dropped['holes'] += 1
                dropped['hole_px'] += int(round(size))
                continue
            holes.append(path)
        move = lambda path: [[x + x0, y + y0] for x, y in simplify_closed(path, parameters['simplify_tolerance_px'])]
        out.append({'outer': move(outer), 'holes': [move(h) for h in holes], 'area_px': part['area_px'], 'vertices_before': len(outer)})
    return out, dropped


def editable(rois, height, width, parameters, um2=None):
    """The polygons to write, and what they are, from a draft, proposal or approved ROI list."""
    polygons, summary = [], {}
    for name in OUTLINES:
        mask = area_mask(rois, name, height, width)
        parts, dropped = split(mask, parameters, um2)
        back = np.zeros(mask.shape, bool)
        for index, part in enumerate(parts, 1):
            base = '%s_part%02d' % (name, index)
            polygons.append({'name': base, 'kind': 'polygon', 'paths': [part['outer']]})
            back ^= raster({'paths': [part['outer']]}, width, height)
            for h, hole in enumerate(part['holes'], 1):
                polygons.append({'name': '%s_hole%02d' % (base, h), 'kind': 'polygon', 'paths': [hole]})
                back &= ~raster({'paths': [hole]}, width, height)
        summary[name] = {'parts': len(parts), 'holes': sum(len(p['holes']) for p in parts), 'area_px': int(mask.sum()),
                         'area_px_as_polygons': int(back.sum()),
                         'pixels_changed_by_simplifying_and_left_out_parts': int((back != mask).sum()),
                         'separate_parts_before': sum(1 for q in D.components(mask)[1] if q['area_px'] >= parameters['min_part_area_px']),
                         'vertices_before': sum(p['vertices_before'] for p in parts),
                         'vertices_after': sum(len(p['outer']) for p in parts), 'left_out_as_too_small': dropped}
    line = [r for r in rois if r['name'] == 'PL_TOTAL']
    require(len(line) <= 1, 'The ROI file holds more than one PL_TOTAL.')
    if line and line[0]['kind'] == 'polyline':
        polygons.append({'name': 'PL_TOTAL', 'kind': 'polyline', 'paths': line[0]['paths']})
        summary['PL_TOTAL'] = {'kind': 'polyline', 'vertices': sum(len(p) for p in line[0]['paths'])}
    elif line:
        summary['PL_TOTAL'] = {'kind': 'area', 'note': 'An area band is not written; ImageJ keeps it as one composite. The band follows from the outlines.'}
    return polygons, summary


def editable_zip(polygons):
    import io
    import zipfile
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        for roi in polygons:
            entry = zipfile.ZipInfo(roi['name'] + '.roi', date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type, entry.create_system, entry.external_attr = zipfile.ZIP_DEFLATED, 3, 0o644 << 16
            data = D.encode_roi(roi['name'], 'polyline', roi['paths']) if roi['kind'] == 'polyline' else encode_polygon(roi['name'], roi['paths'][0])
            archive.writestr(entry, data, compresslevel=6)
    return buffer.getvalue()


def layers_from_edit(rois, height, width):
    """Labels from corrected polygons: every ROI named after an outline adds to it, unless its name says hole."""
    masks, used, ignored = {name: np.zeros((height, width), bool) for name in OUTLINES}, {name: {'added': [], 'holes': []} for name in OUTLINES}, []
    holes = {name: np.zeros((height, width), bool) for name in OUTLINES}
    for roi in rois:
        match = EDIT_NAME.match(roi['name'])
        if roi['name'] == 'PL_TOTAL':
            continue
        if not match or roi['kind'] != 'area':
            ignored.append(roi['name'])
            continue
        base, hole = match.group(1), 'hole' in roi['name'].lower()
        (holes if hole else masks)[base] |= raster(roi, width, height)
        used[base]['holes' if hole else 'added'].append(roi['name'])
    require(all(used[name]['added'] for name in ('Cb', 'GL+WM')), 'The corrected file needs at least one Cb and one GL+WM polygon.')
    cb = masks['Cb'] & ~holes['Cb']
    inner = masks['GL+WM'] & ~holes['GL+WM']
    white = masks['WM'] & ~holes['WM']
    clipped = {'gl_wm_outside_cb_px': int((inner & ~cb).sum()), 'wm_outside_gl_wm_px': int((white & ~(inner & cb)).sum())}
    inner &= cb
    white &= inner
    labels = np.zeros((height, width), np.uint8)
    labels[cb] = D.CLASSES.index('ML')
    labels[inner] = D.CLASSES.index('GL')
    labels[white] = D.CLASSES.index('WM')
    return labels, {'rois_used': used, 'rois_ignored': ignored, 'clipped_to_keep_layers_nested': clipped}


def rebuild(rois, height, width, protocol, parameters):
    labels, how = layers_from_edit(rois, height, width)
    out, structure = D.draft_rois(labels, protocol, parameters)
    line = [r for r in rois if r['name'] == 'PL_TOTAL']
    require(len(line) <= 1 and all(r['kind'] == 'polyline' for r in line), 'A corrected file may hold one PL_TOTAL line.')
    how['pl_total'] = 'the line of the corrected file' if line else 'made from the ML to GL border of the corrected outlines'
    if line:
        out = [r for r in out if r['name'] != 'PL_TOTAL'] + [{'name': 'PL_TOTAL', 'kind': 'polyline', 'paths': line[0]['paths']}]
        out.sort(key=lambda r: D.ROI_ORDER.index(r['name']))
    return out, labels, structure, how


def size_of(text):
    width, _, height = text.partition('x')
    require(width.isdigit() and height.isdigit() and int(width) > 0 and int(height) > 0, 'Give the image size as WIDTHxHEIGHT in pixels.')
    return int(width), int(height)


def main(argv=None):
    parser = argparse.ArgumentParser(description='ROI files a person can correct in ImageJ or Fiji, and back.')
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('export', 'rebuild'):
        p = sub.add_parser(name)
        p.add_argument('--roi', required=True, type=Path)
        p.add_argument('--size', required=True, metavar='WIDTHxHEIGHT', help='Size of the montage in pixels.')
        p.add_argument('--sample', required=True)
        p.add_argument('--output', required=True, type=Path, help='New folder; an existing one is never touched.')
        p.add_argument('--protocol', type=Path, default=roi_measure.DEFAULT_PROTOCOL)
    sub.choices['rebuild'].add_argument('--pl-band-um', type=float, default=D.PARAMETERS['pl_band_width_um'])
    sub.choices['export'].add_argument('--keep-small-parts', action='store_true', help='Write every separate part, however small.')
    args = parser.parse_args(argv)
    try:
        output = args.output.resolve()
        require(not output.exists(), 'The output folder already exists.')
        require(D.SAMPLE_NAME.fullmatch(args.sample) is not None, 'Section names may hold letters, digits, dot, dash and underscore only.')
        width, height = size_of(args.size)
        source = args.roi.resolve()
        require(source.parent != output and source.parent not in output.parents, 'The output folder must not be inside the folder of the ROI file.')
        rois, digest = read_roi_zip(source)
        protocol = roi_measure.load_protocol(args.protocol)
        if args.command == 'export':
            parameters = dict(PARAMETERS, drop_secondary_parts_below_um2=0.0) if args.keep_small_parts else dict(PARAMETERS)
            scale = protocol['calibration']['pixels_per_micron']
            polygons, summary = editable(rois, height, width, parameters, 1 / (scale * scale))
            output.mkdir(parents=True)
            target = output / (args.sample + '.editable-roi.zip')
            D.write_new(target, editable_zip(polygons))
            record = {'schema': SCHEMA, 'statement': STATEMENT, 'sample': args.sample, 'from': {'file': source.name, 'sha256': digest},
                      'image_size_px': [width, height], 'parameters': parameters, 'outlines': summary,
                      'file': {'name': target.name, 'sha256': file_digest(target), 'rois': len(polygons)},
                      'how_to_read': 'Every <outline>_partNN polygon adds tissue to the outline, every polygon with hole in its name takes tissue out. '
                                     'ML is Cb outside GL+WM; GL is GL+WM outside WM. Polygons may be dragged, deleted or added under the same naming.'}
            D.write_new(output / (args.sample + '.editable.json'), D.json_bytes(record))
            print(json.dumps({'sample': args.sample, 'rois': len(polygons), 'outlines': {k: {a: v[a] for a in ('parts', 'separate_parts_before', 'holes', 'vertices_before', 'vertices_after') if a in v} for k, v in summary.items()}}, indent=1))
        else:
            parameters = dict(D.PARAMETERS, pl_band_width_um=args.pl_band_um)
            built, labels, structure, how = rebuild(rois, height, width, protocol, parameters)
            output.mkdir(parents=True)
            target, table_path = output / (args.sample + '.rebuilt-roi.zip'), output / (args.sample + '.rebuilt-measurement.csv')
            D.write_new(target, D.roi_zip_bytes(built))
            decoded, roi_hash = read_roi_zip(target)
            records = roi_measure.measure(decoded, protocol)
            qc = roi_measure.section_qc(records, protocol)
            roi_measure.write_table(roi_measure.table_rows(records, args.sample), table_path)
            record = {'schema': SCHEMA, 'status': 'rebuilt from corrected polygons; not approved', 'approval': {'approved': False},
                      'sample': args.sample, 'from': {'file': source.name, 'sha256': digest}, 'image_size_px': [width, height],
                      'how': how, 'purkinje_band': structure['purkinje_band'], 'measurement': qc,
                      'outputs': {'roi': {'file': target.name, 'sha256': roi_hash}, 'table': {'file': table_path.name, 'sha256': file_digest(table_path)}},
                      'next': 'roi_approve.py record --roi <this ROI ZIP> writes the approval record.'}
            D.write_new(output / (args.sample + '.rebuilt.json'), D.json_bytes(record))
            print(json.dumps({'sample': args.sample, 'areas_um2': qc['values']['area_um2'], 'pl_total_length_um': qc['values']['pl_total_length_um'], 'how': how}, indent=1, ensure_ascii=False))
    except (ValueError, OSError) as error:
        print('Not written: ' + str(error), file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
