#!/usr/bin/env python3
"""Find, for each section, the most similar plate of the sagittal atlas drawing series, and place the section's ROI
outlines in the atlas frame at that plate's lateral position.

Two signals, both from the human-reviewed ROI file of the section:
  names : the lobule names of its ROIs against the lobule labels printed on each plate (Jaccard index)
  shape : the Cb and GL+WM outlines against the plate's ink and compartment outlines, after the best rotation, mirror,
          scale and shift found by a search (truncated mean distance in micrometres, both directions)
Plates whose name score is within NAME_MARGIN of the best are candidates; the candidate with the smallest shape distance
is the match. The runner-up is reported, so an uncertain match is visible.

The atlas is a published composite drawing of another brain. A match says which drawing a section resembles most; it
is not a measured position, it does not tell left from right, and nothing here is approved or validated anatomy.
"""
import argparse
import json
import math
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nissl_lab import file_digest, read_roi_zip, require  # noqa: E402

SCHEMA = 'cerebellum-atlas-match/1'
PARAMETERS = {'status': 'proposed', 'pixels_per_micron': 1.4, 'sample_step_um': 60.0, 'truncate_um': 400.0, 'name_margin': 0.15,
              'rotation_step_deg': 15, 'scale_range': [0.75, 1.3],
              'scale_factors': [0.88, 0.92, 0.96, 1.0, 1.04, 1.08, 1.12], 'refine_iterations': 12, 'max_candidates': 8}
ALIASES = {'4-5Cb': '4/5Cb', 'FI': 'Fl', 'Fl': 'Fl', 'PFI': 'PFl', 'PFl': 'PFl'}
NOT_LOBULES = {'Med', 'IntA', 'IntP', 'Lat', 'IntDL', 'IntPPC', 'MedDL', 'LatPC'}
LOBULE_ROI = re.compile(r'^(?:ML|GL|PL)_(.+?)_part\d+$')
STATEMENT = ('Most similar atlas drawing per section, from human-drawn ROI names and outlines. Not a measured position; the atlas is a '
             'composite drawing of another brain; left and right are not distinguished.')


def lobule(name):
    return ALIASES.get(name, name)


def section_lobules(rois):
    return sorted({lobule(m.group(1)) for m in (LOBULE_ROI.match(r['name']) for r in rois) if m})


def plate_lobules(plate):
    return sorted({lobule(l['text']) for l in plate['labels'] if l['text'][:1].isupper() or l['text'][:1].isdigit()} - NOT_LOBULES)


def jaccard(a, b):
    a, b = set(a), set(b)
    return len(a & b) / len(a | b) if a | b else 0.0


def resample(points, step, closed):
    """Points every `step` along a polyline."""
    pts = np.asarray(points, float)
    if closed:
        pts = np.vstack([pts, pts[:1]])
    seg = np.hypot(*np.diff(pts, axis=0).T)
    total = seg.sum()
    if total == 0:
        return pts[:1]
    at = np.arange(0, total, step)
    cum = np.concatenate([[0], np.cumsum(seg)])
    return np.stack([np.interp(at, cum, pts[:, 0]), np.interp(at, cum, pts[:, 1])], 1)


def section_points(rois, parameters):
    """Cb and GL+WM outlines in micrometres, y up, sampled evenly; and each named total ROI for the reconstruction."""
    scale, step = parameters['pixels_per_micron'], parameters['sample_step_um']
    named = {}
    for roi in rois:
        named.setdefault(roi['name'], []).append(roi)
    require('Cb' in named, 'The ROI file has no Cb.')
    out, kept = [], {}
    for name in ('Cb', 'GL+WM', 'GL_TOTAL', 'WM', 'ML_TOTAL', 'PL_TOTAL'):
        paths = [np.asarray(p, float) * [1 / scale, -1 / scale] for roi in named.get(name, []) for p in roi['paths']]
        closed = bool(named.get(name)) and named[name][0]['kind'] == 'area'
        if paths:
            kept[name] = {'closed': closed, 'paths': paths}
        if name in ('Cb', 'GL+WM') or (name in ('GL_TOTAL', 'WM') and 'GL+WM' not in named):
            out.extend(resample(p, step, closed) for p in paths)
    return np.vstack(out), kept


def plate_points(plate, parameters):
    use = [p for p in plate['paths'] if p['role'] in ('boundary_ink', 'published_compartment')]
    return np.vstack([resample(p['points'], parameters['sample_step_um'], p['closed']) for p in use])


def transform(points, t):
    """Mirror about the y axis, rotate, scale, then shift."""
    p = points * [-1 if t['mirror'] else 1, 1]
    c, s = math.cos(t['rotation']), math.sin(t['rotation'])
    return (p @ np.array([[c, s], [-s, c]])) * t['scale'] + t['shift']


def distance(moved, tree_fixed, fixed, truncate):
    from scipy.spatial import cKDTree
    forward = np.minimum(tree_fixed.query(moved)[0], truncate).mean()
    backward = np.minimum(cKDTree(moved).query(fixed)[0], truncate).mean()
    return float((forward + backward) / 2), float(forward), float(backward)


def fit(points, fixed, parameters):
    """Best similarity transform of the section points onto the plate points. Rotation and shift come from closest-point
    refinement at a fixed scale; the scale is chosen from a grid by the two-way distance, because letting closest points
    set the scale shrinks the section onto the plate."""
    from scipy.spatial import cKDTree
    tree, truncate, (lo, hi) = cKDTree(fixed), parameters['truncate_um'], parameters['scale_range']
    radius = lambda pts: float(np.sqrt(((pts - pts.mean(0)) ** 2).sum(1).mean()))  # spread about the centre, whatever the position
    centre_fixed, spread_fixed = fixed.mean(0), radius(fixed)
    best = None
    for mirror in (False, True):
        base = points * [-1 if mirror else 1, 1]
        centre, spread = base.mean(0), radius(base)
        scales = sorted({min(hi, max(lo, spread_fixed / spread * factor)) for factor in parameters['scale_factors']})
        for scale in scales:
            for degrees in range(0, 360, parameters['rotation_step_deg']):
                rotation = math.radians(degrees)
                c, s = math.cos(rotation), math.sin(rotation)
                matrix = np.array([[c, s], [-s, c]])
                shift = centre_fixed - (centre @ matrix) * scale
                for _ in range(parameters['refine_iterations']):
                    moved = (base @ matrix) * scale + shift
                    gap, index = tree.query(moved)
                    keep = gap < truncate
                    if keep.sum() < 10:
                        break
                    a, b = base[keep] * scale, fixed[index[keep]]
                    ma, mb = a.mean(0), b.mean(0)
                    u, _, vt = np.linalg.svd((a - ma).T @ (b - mb))
                    r = u @ vt
                    if np.linalg.det(r) < 0:
                        u[:, -1] *= -1
                        r = u @ vt
                    matrix, shift = r, mb - ma @ r
                moved = (base @ matrix) * scale + shift
                forward = float(np.minimum(tree.query(moved)[0], truncate).mean())
                if best is not None and forward > 2 * best['distance_um']:
                    continue  # the two-way distance cannot beat the best when one way alone is already twice as large
                score = distance(moved, tree, fixed, truncate)
                if best is None or score[0] < best['distance_um']:
                    best = {'distance_um': score[0], 'section_to_plate_um': score[1], 'plate_to_section_um': score[2], 'mirror': mirror,
                            'rotation': math.atan2(matrix[0, 1], matrix[0, 0]), 'scale': float(scale), 'shift': [float(shift[0]), float(shift[1])]}
    return best


def match(rois, atlas, parameters, use_names=True):
    """The match of one section: ranked candidates with both scores, and the kept ROI outlines. Without names every plate is a
    candidate and only the shape decides, as it must for ROI files that carry no lobule names."""
    points, kept = section_points(rois, parameters)
    names = section_lobules(rois) if use_names else []
    scored = sorted(((jaccard(names, plate_lobules(p)), i) for i, p in enumerate(atlas['plates'])), key=lambda t: (-t[0], t[1]))
    top = scored[0][0]
    cap = parameters['max_candidates'] or None       # 0: every plate within the name margin, as a finely spaced series needs
    candidates = [i for s, i in scored if s >= top - parameters['name_margin']][:cap] if names else list(range(len(atlas['plates'])))
    rows = []
    for i in candidates:
        plate = atlas['plates'][i]
        found = fit(points, plate_points(plate, parameters), parameters)
        rows.append(dict(found, figure=plate['figure'], lateral_um=plate['lateral_um'], name_score=jaccard(names, plate_lobules(plate)), plate_lobules=plate_lobules(plate)))
    rows.sort(key=lambda r: (r['distance_um'], r['figure']))
    return {'section_lobules': names, 'names_used': bool(names), 'candidates_tried': len(rows), 'best': rows[0], 'runner_up': rows[1] if len(rows) > 1 else None,
            'margin_um': (rows[1]['distance_um'] - rows[0]['distance_um']) if len(rows) > 1 else None,
            'all': [{k: r[k] for k in ('figure', 'lateral_um', 'name_score', 'distance_um')} for r in rows]}, kept


def placed(kept, t):
    return {name: {'closed': v['closed'], 'paths': [np.round(transform(p, t), 1).tolist() for p in v['paths']]} for name, v in kept.items()}


ATLAS_SCHEMAS = ('cerebellum-atlas-drawing-series/1', 'cerebellum-atlas-plane-series/1')


def match_file(job):
    """One section from its ROI file; a plain function so that sections can be matched side by side."""
    name, path, atlas, parameters, use_names = job
    rois, digest = read_roi_zip(path)
    found, kept = match(rois, atlas, parameters, use_names=use_names)
    return name, path.name, digest, found, placed(kept, found['best'])


def main(argv=None):
    parser = argparse.ArgumentParser(description='Most similar atlas plate per section, and ROI outlines placed in the atlas frame.')
    parser.add_argument('--atlas', required=True, type=Path, help='Sagittal atlas drawing series (JSON).')
    parser.add_argument('--section', required=True, action='append', metavar='NAME=ROIS.zip')
    parser.add_argument('--output', required=True, type=Path, help='New folder; an existing one is never touched.')
    parser.add_argument('--shape-only', action='store_true', help='Ignore lobule names in the ROI files; every plate is tried.')
    parser.add_argument('--max-candidates', type=int, default=PARAMETERS['max_candidates'],
                        help='Plates tried per section among those the names allow; 0 tries them all.')
    parser.add_argument('--scale-range', default='%g,%g' % tuple(PARAMETERS['scale_range']), metavar='LOW,HIGH',
                        help='How much a section may be shrunk or enlarged to fit a plate. An atlas of a larger brain needs a wider range.')
    parser.add_argument('--jobs', type=int, default=1, help='Sections matched side by side. The result does not depend on it.')
    args = parser.parse_args(argv)
    try:
        output = args.output.resolve()
        require(not output.exists(), 'The output folder already exists.')
        atlas = json.loads(args.atlas.read_text())
        require(atlas.get('schema') in ATLAS_SCHEMAS and atlas.get('unit') == 'um', 'Not a sagittal atlas series in micrometres.')
        require(args.max_candidates >= 0 and args.jobs >= 1, 'Give a candidate count of 0 or more and at least one job.')
        try:
            scale_range = [float(v) for v in args.scale_range.split(',')]
        except ValueError:
            scale_range = []
        require(len(scale_range) == 2 and 0 < scale_range[0] < scale_range[1], 'Give the scale range as LOW,HIGH.')
        parameters = dict(PARAMETERS, max_candidates=args.max_candidates, scale_range=scale_range)
        sections = []
        for item in args.section:
            name, _, path = item.partition('=')
            require(name and path and name not in [s[0] for s in sections], 'Give each section as NAME=ROIS.zip, once.')
            sections.append((name, Path(path).resolve()))
        rows, outlines = [], {}
        jobs = [(name, path, atlas, parameters, not args.shape_only) for name, path in sections]
        def collect(done):                       # each section is reported as soon as it is matched, in the order given
            for name, roi_file, digest, found, moved in done:
                rows.append(dict(found, sample=name, roi_file=roi_file, roi_sha256=digest))
                outlines[name] = {'figure': found['best']['figure'], 'lateral_um': found['best']['lateral_um'], 'rois': moved}
                print('%s: figure %d at %.0f um, distance %.0f um, names %.2f' % (name, found['best']['figure'], found['best']['lateral_um'],
                                                                                  found['best']['distance_um'], found['best']['name_score']), file=sys.stderr, flush=True)
        if args.jobs > 1:
            import multiprocessing
            with multiprocessing.get_context('spawn').Pool(args.jobs) as pool:
                collect(pool.imap(match_file, jobs, chunksize=1))
        else:
            collect(map(match_file, jobs))
        output.mkdir(parents=True)
        result = {'schema': SCHEMA, 'statement': STATEMENT, 'parameters': parameters, 'shape_only': args.shape_only, 'atlas_sha256': file_digest(args.atlas),
                  'atlas_status': atlas.get('status'), 'code_sha256': file_digest(Path(__file__).resolve()), 'sections': rows}
        (output / 'atlas-match.json').write_text(json.dumps(result, indent=1) + '\n', encoding='utf-8')
        (output / 'placed-outlines.json').write_text(json.dumps({'schema': 'cerebellum-atlas-placed-outlines/1', 'statement': STATEMENT, 'unit': 'um',
                                                                'frame': atlas.get('series', {}).get('coordinate_frame'), 'sections': outlines}) + '\n', encoding='utf-8')
    except (ValueError, OSError) as error:
        print('Not matched: ' + str(error), file=sys.stderr)
        return 2
    print(json.dumps({'schema': SCHEMA, 'sections': len(rows)}, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
