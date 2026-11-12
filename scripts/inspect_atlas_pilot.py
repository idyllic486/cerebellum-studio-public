#!/usr/bin/env python3
"""Extract native PDF ink geometry; no pixel segmentation or biological approval."""
import argparse
import hashlib
import json
import math
import re
from pathlib import Path

import fitz

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--input-dir', required=True, type=Path, help='Verified pilot extraction folder containing pages/ and preparation-report.json')
parser.add_argument('--output', required=True, type=Path, help='New output directory; existing directories are refused')
args = parser.parse_args()
PILOT = args.input_dir.expanduser().resolve()
ROOT = args.output.expanduser().resolve()
SOURCE_SHA = 'c4f3a08f4130dac67c543c7d30aecc68cc11bd6f13c487c53637d2788a427afa'
PAGE_SHA = {
    108: '2149ff0a83d2ececb7eef04dc41173a1fb37a923ac58a838b427b75e6c3f598f',
    129: '4297cf04ddbdbe99bd76352eba7f7cf429fc3c3f7f4d098fea0997d98c3ebf50',
    149: '095e0f534b65591c8054e0548902cbc6f88cc1487079df5d5103e1d3844d04f0',
    180: 'e688513d4d0b98136486f28a5a1331a365756c05a51bc751033c0119f0c5cd89',
}
report = json.loads((PILOT / 'preparation-report.json').read_text())
if report['source']['sha256'] != SOURCE_SHA:
    raise ValueError('This reviewed candidate selection applies only to the exact documented atlas source.')
if fitz.VersionBind != '1.26.6':
    raise ValueError('Use pinned PyMuPDF 1.26.6 to preserve path indexing.')
for number, expected_hash in PAGE_SHA.items():
    pdf_path = PILOT / 'pages' / f'page-{number:06d}.pdf'
    if hashlib.sha256(pdf_path.read_bytes()).hexdigest() != expected_hash:
        raise ValueError(f'Page {number} differs from the visually reviewed pilot; candidate path IDs cannot be applied.')
ROOT.mkdir(parents=True, exist_ok=False)
SELECTION = {
    129: {'figure': 102, 'lateral_mm': 0.12, 'filled_compartment': [355], 'pale_inner_fill': [356],
          'outer_and_fissure_ink': [201, 202, 203, 204, 210, 211, 212, 213, 214], 'nucleus_cutout': []},
    149: {'figure': 122, 'lateral_mm': 2.52, 'filled_compartment': [252], 'pale_inner_fill': [253],
          'outer_and_fissure_ink': [200, 201, 202, 203, 204, 205], 'nucleus_cutout': [254]},
}


def jsonable(value):
    if isinstance(value, (fitz.Point, fitz.Rect, fitz.Quad)):
        return [jsonable(x) for x in value]
    if isinstance(value, (list, tuple)):
        return [jsonable(x) for x in value]
    if isinstance(value, dict):
        return {k: jsonable(v) for k, v in value.items()}
    return value


def linear_fit(observations):
    xs = [r['page_position_points'] for r in observations]
    ys = [r['printed_value_mm'] for r in observations]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    slope = sum((x-mx)*(y-my) for x, y in zip(xs, ys)) / sum((x-mx)**2 for x in xs)
    intercept = my - slope * mx
    residuals = [(slope*x+intercept-y)*1000 for x, y in zip(xs, ys)]
    return {'slope_mm_per_pdf_point': slope, 'intercept_mm': intercept,
            'rms_grid_residual_um': math.sqrt(sum(r*r for r in residuals)/len(residuals)),
            'max_absolute_grid_residual_um': max(abs(r) for r in residuals),
            'observations': observations, 'residuals_um': residuals}


def calibration(page, drawings):
    words = page.get_text('words')
    x_labels = [w for w in words if w[1] < 58 and re.fullmatch('-?\\d+', w[4])]
    y_labels = [w for w in words if 951 < w[0] < 980 and 60 < w[1] < 490 and re.fullmatch('\\d+', w[4])]
    xgrid, ygrid = [], []
    for i, drawing in enumerate(drawings):
        if len(drawing['items']) != 1 or drawing['items'][0][0] != 'l':
            continue
        p, q = drawing['items'][0][1:]
        if abs(p.x-q.x) < 0.001 and abs(p.y-q.y) > 400 and p.y < 60:
            xgrid.append((i, p.x))
        if abs(p.y-q.y) < 0.001 and abs(p.x-q.x) > 880 and 100 < p.y < 470:
            ygrid.append((i, p.y))
    observations = []
    for labels, grid, axis in [(x_labels, xgrid, 0), (y_labels, ygrid, 1)]:
        pairs = []
        for label in labels:
            centre = (label[axis] + label[axis+2]) / 2
            index, position = min(grid, key=lambda item: abs(item[1] - centre))
            assert abs(position-centre) < 1
            pairs.append({'page_position_points': position, 'printed_value_mm': float(label[4]),
                          'grid_path_index': index, 'label_bbox_points': list(label[:4]),
                          'label_to_grid_offset_points': centre-position})
        assert len({p['grid_path_index'] for p in pairs}) == len(pairs)
        observations.append(sorted(pairs, key=lambda p: p['page_position_points']))
    assert len(observations[0]) == 14 and len(observations[1]) == 7
    return {'schema': 'cerebellum-diagram-grid-fit/1',
            'AP_Bregma_mm_from_x': linear_fit(observations[0]),
            'depth_below_Bregma_mm_from_y': linear_fit(observations[1]),
            'source_convention_evidence_pdf_page': 10,
            'anatomical_DV_positive_dorsal': 'Negate depth_below_Bregma_mm.',
            'status': 'source-grid affine fit; not expert-approved calibration',
            'meaning_of_residuals': 'Fit to the published drawing grid only; these are not specimen-registration or biological-accuracy errors.',
            'native_geometry_authority': 'Unmodified page-coordinate paths. Fit is stored separately and has not resampled or moved any path.',
            'histology_pixel_calibration': None}


def path_svg(drawing):
    commands, current = [], None
    for item in drawing['items']:
        tag = item[0]
        if tag in ('l', 'c'):
            start = item[1]
            if current is None or abs(start-current) > 0.0001:
                commands.append(f'M{start.x:.9f},{start.y:.9f}')
            if tag == 'l':
                end = item[2]
                commands.append(f'L{end.x:.9f},{end.y:.9f}')
            else:
                a, b, end = item[2:]
                commands.append(f'C{a.x:.9f},{a.y:.9f} {b.x:.9f},{b.y:.9f} {end.x:.9f},{end.y:.9f}')
            current = end
        else:
            raise ValueError(f'Pilot selection has an unsupported command: {tag}')
    if drawing['closePath']:
        commands.append('Z')
    return ' '.join(commands)


def color(value):
    return 'none' if value is None else 'rgb(' + ','.join(f'{100*x:.6f}%' for x in value) + ')'


summaries = []
for number in [108, 129, 149, 180]:
    pdf = PILOT / 'pages' / f'page-{number:06d}.pdf'
    doc = fitz.open(pdf)
    page = doc[0]
    drawings = page.get_drawings()
    native = {'schema': 'cerebellum-pdf-native-ink/1', 'original_pdf_sha256': SOURCE_SHA,
              'original_pdf_page_number': number, 'extracted_page_sha256': hashlib.sha256(pdf.read_bytes()).hexdigest(),
              'coordinate_system': 'PyMuPDF unrotated PDF page points; y increases down',
              'interpretation': 'Ink paths, fills and paint order. A source path is not automatically a tissue ROI or lobule boundary.',
              'path_index_convention': 'zero-based index in PyMuPDF get_drawings output; seqno retained',
              'pymupdf_version': fitz.VersionBind, 'page_rect_points': list(page.rect),
              'path_groups': [dict(path_index=i, **jsonable(d)) for i, d in enumerate(drawings)],
              'image_count': len(page.get_images()), 'text_words': jsonable(page.get_text('words'))}
    (ROOT / f'page-{number:06d}-native-ink.json').write_text(json.dumps(native, separators=(',', ':'), ensure_ascii=False))
    summary = {'pdf_page_number': number, 'path_groups': len(drawings), 'embedded_images': len(page.get_images()),
               'extracted_pdf_bytes': pdf.stat().st_size}
    if number in SELECTION:
        spec = SELECTION[number]
        calibration_record = calibration(page, drawings)
        groups = {name: ids for name, ids in spec.items() if isinstance(ids, list)}
        svg = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="690 125 260 255" width="780" height="765">',
               '<title>Native cerebellar diagram ink candidates; not approved tissue segmentation</title>',
               '<rect x="690" y="125" width="260" height="255" fill="white"/>']
        selected = []
        for index in sorted({i for ids in groups.values() for i in ids}):
            drawing = drawings[index]
            categories = [name for name, ids in groups.items() if index in ids]
            attrs = f'fill="{color(drawing["fill"])}" stroke="{color(drawing["color"])}" stroke-width="{drawing["width"] or 0}" fill-rule="{"evenodd" if drawing["even_odd"] else "nonzero"}"'
            if drawing.get('dashes') and drawing['dashes'] != '[] 0':
                dash_values = re.match(r'\[([^]]*)\]\s*([-.\d]+)', drawing['dashes'])
                assert dash_values
                attrs += f' stroke-dasharray="{dash_values[1]}" stroke-dashoffset="{dash_values[2]}"'
            svg.append(f'<path id="source-path-{index}" {attrs} d="{path_svg(drawing)}"/>')
            selected.append({'path_index': index, 'categories': categories,
                             'source_path': jsonable(drawing),
                             'anatomical_label': None, 'review_status': 'unreviewed_source_ink_candidate'})
        svg.append('</svg>')
        svg_path = ROOT / f'page-{number:06d}-cerebellar-ink.svg'
        svg_path.write_text('\n'.join(svg))
        with fitz.open(svg_path) as svg_doc:
            svg_doc[0].get_pixmap().save(ROOT / f'page-{number:06d}-cerebellar-ink.png')
        candidate = {'schema': 'cerebellum-pdf-ink-candidates/1', 'source': native['original_pdf_sha256'],
                     'extracted_page_sha256': native['extracted_page_sha256'],
                     'pdf_page_number': number, 'figure': spec['figure'], 'plane': 'sagittal',
                     'printed_lateral_mm': spec['lateral_mm'], 'selection': groups,
                     'selection_basis': 'Manual visual inspection of the supplied source diagram and native paint properties; stable path indices bound to the exact page hash.',
                     'native_paths': selected, 'diagram_grid_fit': calibration_record,
                     'limitations': [
                         'Blue fill plus pale overpaint are preserved as separate source paint operations. They are not blindly mapped to GL and WM.',
                         'Outer/fissure cyan curves include open parts. No automatic gap bridging, closing, union or tissue filling has been performed.',
                         'A valid total cerebellar ROI is not yet present; junction to brainstem/peduncles needs a documented boundary decision.',
                         'White fill for labelled lateral cerebellar nucleus on page149 is preserved; it is not dropped as a hole or white matter.',
                         'Lobule labels and annotation strokes have zero anatomical volume. Stroke width is a drawing style, not tissue thickness.',
                         'Two sagittal planes are 2.40 mm apart; they cannot establish the complete cerebellum or a validated interpolation.',
                     ]}
        (ROOT / f'page-{number:06d}-candidates.json').write_text(json.dumps(candidate, indent=2, ensure_ascii=False))
        summary.update({'selected_source_paths': len(selected), 'grid_fit': calibration_record})
    summaries.append(summary)
(ROOT / 'vector-review-summary.json').write_text(json.dumps({'source_sha256': SOURCE_SHA, 'pages': summaries,
    'tissue_segmentation_approved': False, 'source_paths_modified': False, 'raw_measurements_changed': False,
    'full_3d_reconstruction': None}, indent=2))
print(json.dumps([{k:v for k,v in s.items() if k!='grid_fit'} for s in summaries], indent=2))
