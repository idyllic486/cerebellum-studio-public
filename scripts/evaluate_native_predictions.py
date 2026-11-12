#!/usr/bin/env python3
"""Apply a saved auto-ROI bundle to every native pixel of held-out sections.

Sampled training metrics weight classes equally and omit spatial structure. This
tool measures the exported model files against final reviewed ROI masks across
whole images: confusion, boundary distance, fragmentation and the distance from
the derived ML-GL interface to observed PL lines. Originals are only read, and
reports contain no image pixels. Results are exploratory, not independent
biological validation: prior animal/batch exposure remains unknown.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ProcessPoolExecutor, as_completed
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from native_tiff import NativeTiff
from nissl_lab import features, read_roi_zip, validate_forest
from prepare_training_sources import REFS, file_hash, now, read_plan, require, verify_source, windows, write_json
from roi_training_masks import LobuleMasks, TrainingMasks

SCHEMA = 'cerebellum-whole-image-evaluation/1'
SCOPE = ('Exploratory whole-image comparison with final reviewed ROI masks on animals excluded from fitting. '
         'Unknown or conflicting reference pixels are excluded. Prior animal/batch exposure is unknown; this is not '
         'independent biological validation, atlas validation, measured review time or a population estimate. '
         'Distances are native image pixels because physical scale is not established here.')
SMALL_COMPONENT_PIXELS = 100
BOUNDARY_TASKS = ('cb', 'layers')


def compile_forest(model):
    import numpy as np
    validate_forest(model)
    return [tuple(np.asarray(tree[key], dtype=kind) for key, kind in
                  (('left', np.int32), ('right', np.int32), ('feature', np.int32),
                   ('threshold', np.float64), ('probabilities', np.float64))) for tree in model['trees']]


def predict_flat(forest, flat, classes):
    """Vectorized traversal, matching forest_predict: summed leaf probabilities, first maximum."""
    import numpy as np
    rows = np.arange(len(flat))
    votes = np.zeros((len(flat), classes), dtype=np.float64)
    for left, right, feature, threshold, probabilities in forest:
        nodes = np.zeros(len(flat), dtype=np.int32)
        active = rows
        while len(active):
            current = nodes[active]
            go_left = flat[active, feature[current]] <= threshold[current]
            nodes[active] = np.where(go_left, left[current], right[current])
            active = active[left[nodes[active]] != -1]
        votes += probabilities[nodes]
    return votes.argmax(axis=1).astype(np.uint8)


def ratio(top, bottom):
    return float(top/bottom) if bottom else None


def confusion_metrics(confusion, classes):
    import numpy as np
    confusion = np.asarray(confusion, dtype=np.int64)
    per_class = {}
    for index, name in enumerate(classes):
        tp = int(confusion[index, index]); actual = int(confusion[index, :].sum()); called = int(confusion[:, index].sum())
        per_class[name] = {'reference_pixels': actual, 'predicted_pixels': called, 'true_positive_pixels': tp,
                           'precision': ratio(tp, called), 'recall': ratio(tp, actual), 'dice': ratio(2*tp, actual+called),
                           'iou': ratio(tp, actual+called-tp),
                           'area_ratio_predicted_to_reference': ratio(called, actual)}
    foreground = [per_class[name]['dice'] for name in classes[1:] if per_class[name]['dice'] is not None]
    return {'known_reference_pixels': int(confusion.sum()),
            'confusion_rows_reference_columns_prediction': confusion.tolist(),
            'accuracy': ratio(int(np.trace(confusion)), int(confusion.sum())),
            'macro_foreground_dice': float(sum(foreground)/len(foreground)) if foreground else None,
            'per_class': per_class}


def outline(mask):
    """Foreground pixels with a 4-neighbour outside the mask; the image edge is not a boundary."""
    import numpy as np
    edge = np.zeros(mask.shape, dtype=bool)
    edge[1:, :] |= mask[1:, :] & ~mask[:-1, :]
    edge[:-1, :] |= mask[:-1, :] & ~mask[1:, :]
    edge[:, 1:] |= mask[:, 1:] & ~mask[:, :-1]
    edge[:, :-1] |= mask[:, :-1] & ~mask[:, 1:]
    return edge


def distance_summary(values):
    import numpy as np
    if not len(values):
        return None
    return {'pixels': int(len(values)), 'mean': float(values.mean()), 'median': float(np.median(values)),
            'p95': float(np.percentile(values, 95)), 'maximum': float(values.max())}


def directed_distances(source, target, keep):
    """Distances from source pixels to the nearest target pixel, reporting only kept positions."""
    from scipy.ndimage import distance_transform_edt
    if not source.any() or not target.any():
        return None
    field = distance_transform_edt(~target).astype('float32')
    return distance_summary(field[source & keep])


def boundary_metrics(reference, predicted, classes):
    """Symmetric boundary distance; reference pixels of unknown class constrain neither direction."""
    import numpy as np
    from scipy.ndimage import binary_dilation
    unknown = reference == 255
    keep = ~binary_dilation(unknown, iterations=1) if unknown.any() else np.ones(reference.shape, dtype=bool)
    result = {}
    for index, name in enumerate(classes):
        if index == 0:
            continue
        ref, pred = outline(reference == index), outline(predicted == index)
        result[name] = {'reference_to_prediction': directed_distances(ref, pred, keep),
                        'prediction_to_reference': directed_distances(pred, ref, keep)}
    return result


def fragmentation(reference, predicted, classes):
    import numpy as np
    from scipy.ndimage import label
    result = {}
    for index, name in enumerate(classes):
        if index == 0:
            continue
        row = {}
        for key, values in (('reference', reference), ('prediction', predicted)):
            labelled, count = label(values == index)
            sizes = np.bincount(labelled.ravel())[1:] if count else np.array([], dtype=np.int64)
            row[key] = {'components': int(count),
                        'components_below_100_pixels': int((sizes < SMALL_COMPONENT_PIXELS).sum()),
                        'largest_component_pixels': int(sizes.max()) if count else 0}
        result[name] = row
    return result


def polyline_pixels(paths, width, height):
    """Rasterize an open line densely enough that no segment skips a native pixel."""
    import numpy as np
    mask = np.zeros((height, width), dtype=bool)
    length = 0.0
    for path in paths:
        for (x0, y0), (x1, y1) in zip(path, path[1:]):
            span = max(abs(x1-x0), abs(y1-y0))
            length += float(np.hypot(x1-x0, y1-y0))
            steps = int(np.ceil(span))+1
            xs = np.clip(np.floor(np.linspace(x0, x1, steps)).astype(int), 0, width-1)
            ys = np.clip(np.floor(np.linspace(y0, y1, steps)).astype(int), 0, height-1)
            mask[ys, xs] = True
    return mask, length


def interface(labels, first, second):
    """Pixels of the first class that touch the second class by a shared edge."""
    import numpy as np
    a, b = labels == first, labels == second
    edge = np.zeros(labels.shape, dtype=bool)
    edge[1:, :] |= a[1:, :] & b[:-1, :]
    edge[:-1, :] |= a[:-1, :] & b[1:, :]
    edge[:, 1:] |= a[:, 1:] & b[:, :-1]
    edge[:, :-1] |= a[:, :-1] & b[:, 1:]
    return edge


def pl_metrics(rois, reference, predicted, classes):
    """Compare the derived ML-GL candidate with an observed PL_TOTAL line; areas are never converted."""
    import numpy as np
    totals = [roi for roi in rois if roi['name'] == 'PL_TOTAL']
    if len(totals) != 1 or totals[0].get('kind') != 'polyline':
        return {'status': 'not_compared', 'reason': 'PL_TOTAL is absent or not a line; an area is not converted to a length.',
                'PL_TOTAL_kind': totals[0].get('kind') if len(totals) == 1 else None}
    height, width = reference.shape
    ml, gl = classes.index('ML'), classes.index('GL')
    line, length = polyline_pixels(totals[0]['paths'], width, height)
    candidate = interface(predicted, ml, gl)
    reference_interface = interface(reference, ml, gl)
    everywhere = np.ones(line.shape, dtype=bool)
    return {'status': 'compared', 'scope': 'Derived ML-GL interface against an observed line; not Purkinje-cell detection.',
            'reference_line_length_pixels': length,
            'candidate_interface_pixels': int(candidate.sum()),
            'candidate_interface_pixels_note': 'Counts touching pixels on a jagged boundary; it is not a measured line length.',
            'reference_to_candidate': directed_distances(line, candidate, everywhere),
            'candidate_to_reference': directed_distances(candidate, line, everywhere),
            'reference_mask_interface_to_reference_line': directed_distances(reference_interface, line, everywhere)}


def evaluate_section(section, root, bundle_path, tile_size):
    import numpy as np
    bundle = json.loads(Path(bundle_path).read_text(encoding='utf-8'))
    models = bundle['models']
    forests = {task: compile_forest(model) for task, model in models.items()}
    paths = {key: verify_source(root, section[key]) for key in REFS}
    rois, roi_hash = read_roi_zip(paths['primary_roi'])
    require(roi_hash == section['primary_roi']['sha256'], 'ROI archive changed during decoding.')
    with NativeTiff(paths['source_image']) as image:
        width, height = image.width, image.height
        require((width, height) == (section['width'], section['height']), 'TIFF dimensions differ from the confirmed plan.')
        masks = TrainingMasks(rois, width, height)
        lobules = LobuleMasks(rois, masks, models['lobules']['classes']) if 'lobules' in models else None
        reference = {task: np.empty((height, width), dtype=np.uint8) for task in models}
        predicted = {task: np.empty((height, width), dtype=np.uint8) for task in models}
        for x, y, w, h, left, top, tw, th in windows(width, height, tile_size):
            raster = masks.render_window(x, y, w, h)
            if lobules is not None:
                raster['lobules'] = lobules.render_window(x, y, w, h, raster)
            patch = np.frombuffer(image.read_window(left, top, tw, th), dtype=np.uint8).reshape(th, tw, image.channels)
            block = features(patch, [255]*image.channels)[y-top:y-top+h, x-left:x-left+w]
            flat = block.reshape(-1, block.shape[2])
            for task, forest in forests.items():
                reference[task][y:y+h, x:x+w] = np.frombuffer(raster[task], dtype=np.uint8).reshape(h, w)
                predicted[task][y:y+h, x:x+w] = predict_flat(forest, flat, len(models[task]['classes'])).reshape(h, w)
    tasks = {}
    for task, model in models.items():
        classes = model['classes']
        ref, pred = reference[task], predicted[task]
        known = ref != 255
        size = len(classes)
        confusion = np.bincount(ref[known].astype(np.int64)*size+pred[known], minlength=size*size).reshape(size, size)
        row = {'classes': classes, 'unknown_reference_pixels': int((~known).sum()), **confusion_metrics(confusion, classes)}
        if task in BOUNDARY_TASKS:
            row['boundary_distance_pixels'] = boundary_metrics(ref, pred, classes)
            row['fragmentation'] = fragmentation(ref, pred, classes)
        tasks[task] = row
    pl = pl_metrics(rois, reference['layers'], predicted['layers'], models['layers']['classes']) if 'layers' in models else None
    for key in REFS:
        verify_source(root, section[key])
    return {'animal_id': section['animal_id'], 'section_id': section['section_id'], 'width': width, 'height': height,
            'source_sha256': section['source_image']['sha256'], 'roi_sha256': roi_hash,
            'source_hashes_verified': True, 'tasks': tasks, 'pl_candidate': pl}


def spread(values):
    import numpy as np
    values = [v for v in values if v is not None]
    if not values:
        return None
    return {'count': len(values), 'mean': float(np.mean(values)), 'minimum': float(min(values)),
            'median': float(np.median(values)), 'maximum': float(max(values))}


def summarize(rows, models):
    """Pool pixels per animal, and keep section spread beside it; sections are not independent animals."""
    import numpy as np
    def group(items):
        result = {}
        for task, model in models.items():
            classes = model['classes']
            present = [row for row in items if task in row['tasks']]
            pooled = sum(np.asarray(row['tasks'][task]['confusion_rows_reference_columns_prediction'], dtype=np.int64) for row in present)
            entry = confusion_metrics(pooled, classes)
            entry['section_dice'] = {name: spread([row['tasks'][task]['per_class'][name]['dice'] for row in present]) for name in classes}
            if task in BOUNDARY_TASKS:
                entry['section_boundary_mean_pixels'] = {name: {direction: spread([(row['tasks'][task]['boundary_distance_pixels'][name][direction] or {}).get('mean') for row in present])
                    for direction in ('reference_to_prediction', 'prediction_to_reference')} for name in classes[1:]}
                entry['section_boundary_p95_pixels'] = {name: {direction: spread([(row['tasks'][task]['boundary_distance_pixels'][name][direction] or {}).get('p95') for row in present])
                    for direction in ('reference_to_prediction', 'prediction_to_reference')} for name in classes[1:]}
                entry['section_prediction_components'] = {name: spread([row['tasks'][task]['fragmentation'][name]['prediction']['components'] for row in present]) for name in classes[1:]}
                entry['section_reference_components'] = {name: spread([row['tasks'][task]['fragmentation'][name]['reference']['components'] for row in present]) for name in classes[1:]}
            result[task] = entry
        compared = [row['pl_candidate'] for row in items if (row.get('pl_candidate') or {}).get('status') == 'compared']
        result['pl_candidate'] = {'compared_sections': len(compared), 'sections': len(items),
            'reference_to_candidate_mean_pixels': spread([(row['reference_to_candidate'] or {}).get('mean') for row in compared]),
            'reference_to_candidate_p95_pixels': spread([(row['reference_to_candidate'] or {}).get('p95') for row in compared]),
            'candidate_to_reference_mean_pixels': spread([(row['candidate_to_reference'] or {}).get('mean') for row in compared]),
            'candidate_to_reference_p95_pixels': spread([(row['candidate_to_reference'] or {}).get('p95') for row in compared]),
            'reference_mask_interface_to_reference_line_mean_pixels': spread([(row['reference_mask_interface_to_reference_line'] or {}).get('mean') for row in compared])}
        return result
    animals = sorted({row['animal_id'] for row in rows})
    return {'by_animal': {animal: group([row for row in rows if row['animal_id'] == animal]) for animal in animals},
            'pooled_pixels_all_sections': group(rows),
            'independent_animals': len(animals)}


def evaluate(plan_path, root, models_path, output, animals=None, workers=1, tile_size=512, progress=print):
    plan, plan_hash = read_plan(plan_path)
    root = Path(root).expanduser().absolute()
    require(root.is_dir() and not root.is_symlink(), 'Use an original source directory, not a symbolic link.')
    root = root.resolve()
    output = Path(output).expanduser().absolute()
    require(not output.exists() and not output.is_symlink() and output.parent.is_dir(), 'Choose a new output directory with an existing parent.')
    output = output.parent.resolve()/output.name
    require(not output.is_relative_to(root), 'Evaluation output must be outside the original source tree.')
    require(type(workers) is int and 1 <= workers <= 32, 'Use 1-32 workers.')
    require(type(tile_size) is int and 64 <= tile_size <= 512, 'Use 64-512 pixel native windows.')
    models_path = Path(models_path).expanduser().absolute()
    bundle_hash = file_hash(models_path)
    bundle = json.loads(models_path.read_text(encoding='utf-8'))
    require(bundle.get('schema') == 'cerebellum-auto-roi-models/1' and isinstance(bundle.get('models'), dict) and 'layers' in bundle['models'], 'Choose an auto-roi-models.json bundle.')
    for model in bundle['models'].values():
        validate_forest(model)
    trained = {animal for model in bundle['models'].values() for animal in model['training_animals']}
    trained_sources = {source['source_sha256'] for model in bundle['models'].values() for source in model['training_sources']}
    declared = sorted({section['animal_id'] for section in plan['sections']})
    chosen = sorted(set(declared)-trained) if animals is None else sorted(set(animals))
    require(chosen, 'No animal outside the fitted training animals is available.')
    require(set(chosen) <= set(declared), 'Requested animal is absent from the pairing plan.')
    require(not set(chosen) & trained, 'Training animals are refused: whole-image scores on them would not be held-out.')
    sections = sorted((s for s in plan['sections'] if s['animal_id'] in chosen), key=lambda s: s['section_id'])
    require(sections, 'No section matches the requested animals.')
    require(not {s['source_image']['sha256'] for s in sections} & trained_sources, 'A fitted source image is present in the evaluation set.')
    report = {'schema': SCHEMA, 'status': 'running', 'created_at': now(), 'scope': SCOPE,
        'plan_sha256': plan_hash, 'model_bundle_sha256': bundle_hash, 'model_created_at': bundle.get('created_at'),
        'training_animals': sorted(trained), 'evaluation_animals': chosen,
        'tasks': {task: model['classes'] for task, model in bundle['models'].items()},
        'settings': {'native_window_size': tile_size, 'workers': workers, 'small_component_pixels': SMALL_COMPONENT_PIXELS},
        'independent_validation_established': False, 'anatomical_accuracy_established': False,
        'prior_exposure_unknown': True, 'physical_scale_applied': False, 'review_time_measured': False,
        'originals_modified': False, 'image_pixels_in_report': False, 'uploaded': False,
        'sections_requested': len(sections), 'sections': [], 'failed_sections': []}
    staging = Path(tempfile.mkdtemp(prefix=output.name+'.incomplete-', dir=output.parent))
    def save():
        report['updated_at'] = now(); write_json(staging/'whole-image-evaluation.json', report)
    save()
    try:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            jobs = {pool.submit(evaluate_section, section, root, models_path, tile_size): section for section in sections}
            for job in as_completed(jobs):
                section = jobs[job]
                try:
                    report['sections'].append(job.result())
                    progress(f'[{len(report["sections"])+len(report["failed_sections"])}/{len(sections)}] {section["section_id"]} done')
                except (ValueError, OSError, KeyError) as error:
                    report['failed_sections'].append({'section_id': section['section_id'], 'animal_id': section['animal_id'], 'error': str(error)})
                    progress(f'[{len(report["sections"])+len(report["failed_sections"])}/{len(sections)}] {section["section_id"]} FAILED: {error}')
                save()
        report['sections'].sort(key=lambda row: row['section_id'])
        require(file_hash(models_path) == bundle_hash, 'Model bundle changed during evaluation.')
        require(report['sections'], 'Every section failed; no metric was computed.')
        report['summary'] = summarize(report['sections'], bundle['models'])
        report.update(status='complete' if not report['failed_sections'] else 'partial_failure', finished_at=now())
        save()
        staging.rename(output)
        return report
    except BaseException as error:
        report.update(status='interrupted' if isinstance(error, KeyboardInterrupt) else 'failed',
                      error=str(error) or type(error).__name__, finished_at=now())
        save()
        if not output.exists():
            staging.rename(output)
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--models', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--animals', nargs='*', help='Default: every planned animal outside the model training animals.')
    parser.add_argument('--workers', type=int, default=max(1, min(6, (os.cpu_count() or 2)//2)))
    parser.add_argument('--tile-size', type=int, default=512)
    args = parser.parse_args(argv)
    report = evaluate(args.plan, args.root, args.models, args.output, args.animals, args.workers, args.tile_size)
    print('Status:', report['status'], '| sections:', len(report['sections']), '| failed:', len(report['failed_sections']))
    print('Report:', args.output/'whole-image-evaluation.json')
    return 0 if report['status'] == 'complete' else 1


if __name__ == '__main__':
    raise SystemExit(main())
