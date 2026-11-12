#!/usr/bin/env python3
"""Compare the ROI files of a draft run with human ROI files of the same sections, in original coordinates.

For every section: relative area error of Cb, ML_TOTAL, GL_TOTAL, WM and of Cb - GL - WM, relative PL length error where
the human PL_TOTAL is a line, boundary distances per region in micrometres, and Dice on the pixels the human file decides.
It measures the draft against one human reading; it approves nothing and changes no file it reads.
"""
import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nissl_lab import file_digest, read_roi_zip, require  # noqa: E402
import roi_draft as D  # noqa: E402
import roi_measure  # noqa: E402
import roi_revise as R  # noqa: E402
from evaluate_native_predictions import directed_distances, outline  # noqa: E402

SCHEMA = 'cerebellum-roi-validation/1'
REGIONS = ('Cb', 'ML', 'GL', 'WM')
TOTALS = {'Cb': 'Cb', 'ML': 'ML_TOTAL', 'GL': 'GL_TOTAL', 'WM': 'WM'}
STATEMENT = ('Draft ROI files compared with one human reading of the same sections. The numbers describe these sections only. '
             'Review time was not measured.')


def draft_map(rois, height, width):
    """Draft ROIs as one label map, read back from the ROI file, and the draft Cb mask."""
    named = {roi['name']: roi for roi in rois}
    require(all(TOTALS[name] in named for name in REGIONS), 'The draft ROI file lacks Cb, ML_TOTAL, GL_TOTAL or WM.')
    layers = {name: R.raster(named[TOTALS[name]], width, height) for name in ('ML', 'GL', 'WM')}
    count = sum(layer.astype(np.uint8) for layer in layers.values())
    label = sum(layers[name].astype(np.uint8) * D.CLASSES.index(name) for name in layers)
    return np.where(count == 1, label, 0).astype(np.uint8), R.raster(named['Cb'], width, height), int((count > 1).sum())


def relative(draft, human):
    return None if draft is None or human in (None, 0) else (draft - human) / human


def dice(a, b):
    total = int(a.sum()) + int(b.sum())
    return None if not total else 2 * int((a & b).sum()) / total


def distances(reference, drafted, keep, scale):
    """Both directed boundary distances in micrometres."""
    out = {}
    for key, source, target in (('human_to_draft', reference, drafted), ('draft_to_human', drafted, reference)):
        found = directed_distances(outline(source), outline(target), keep)
        out[key] = None if found is None else {'boundary_px': found['pixels'], 'mean_um': found['mean'] / scale,
                                               'median_um': found['median'] / scale, 'p95_um': found['p95'] / scale, 'max_um': found['maximum'] / scale}
    return out


def compare(sample, draft, draft_rois, human_rois, protocol):
    """All comparisons of one section. draft is the draft record; the ROI lists are as read from the two ZIP files."""
    from scipy.ndimage import binary_dilation
    height, width, scale = draft['source']['height'], draft['source']['width'], protocol['calibration']['pixels_per_micron']
    reference, counted = R.reference_map(human_rois, height, width)
    labels, draft_cb, overlap = draft_map(draft_rois, height, width)
    human_cb = reference > 0
    decided = reference <= R.WM
    keep = ~binary_dilation(~decided, iterations=1)
    human = roi_measure.section_qc(roi_measure.measure(human_rois, protocol), protocol)['values']
    mine = roi_measure.section_qc(roi_measure.measure(draft_rois, protocol), protocol)['values']
    row = {'sample': sample, 'human_reference_pixels': counted, 'draft_layers_overlapping_px': overlap,
           'human_pl_geometry': human['pl_total_geometry'], 'human_layer_outline': human.get('layer_outline'),
           'human_unassigned_per_pl_length_um': human.get('unassigned_per_pl_length_um'), 'area_um2': {}, 'relative_area_error': {},
           'boundary_um': {}, 'dice': {}}
    for name in REGIONS:
        total = TOTALS[name]
        row['area_um2'][total] = {'human': human['area_um2'].get(total), 'draft': mine['area_um2'].get(total)}
        row['relative_area_error'][total] = relative(mine['area_um2'].get(total), human['area_um2'].get(total))
        if name == 'Cb':
            row['dice'][name] = dice(human_cb, draft_cb)
            row['boundary_um'][name] = distances(human_cb, draft_cb, np.ones(reference.shape, bool), scale)
        else:
            value = D.CLASSES.index(name)
            row['dice'][name] = dice((reference == value), (labels == value) & decided)
            row['boundary_um'][name] = distances(reference == value, labels == value, keep, scale)
    rest = lambda v: None if any(v['area_um2'].get(k) is None for k in ('Cb', 'GL_TOTAL', 'WM')) else v['area_um2']['Cb'] - v['area_um2']['GL_TOTAL'] - v['area_um2']['WM']
    row['area_um2']['Cb-GL-WM'] = {'human': rest(human), 'draft': rest(mine)}
    row['relative_area_error']['Cb-GL-WM'] = relative(rest(mine), rest(human))
    line = human['pl_total_geometry'] == 'line' and mine['pl_total_geometry'] == 'line'
    row['pl_length_um'] = {'human': human['pl_total_length_um'], 'draft': mine['pl_total_length_um']}
    row['relative_pl_length_error'] = relative(mine['pl_total_length_um'], human['pl_total_length_um']) if line else None
    tiers = {}
    for item in draft['review_queue']:
        tiers[str(item['tier'])] = tiers.get(str(item['tier']), 0) + 1
    row['review_queue_by_tier'] = tiers
    return row


def flat(row):
    out = {'sample': row['sample'], 'human_pl_geometry': row['human_pl_geometry'], 'human_layer_outline': row['human_layer_outline']}
    for name, value in row['relative_area_error'].items():
        out['area_error_' + name] = value
    out['pl_length_error'] = row['relative_pl_length_error']
    for name in REGIONS:
        out['dice_' + name] = row['dice'][name]
        for way in ('human_to_draft', 'draft_to_human'):
            found = row['boundary_um'][name][way]
            out['%s_%s_mean_um' % (name, way)] = found and found['mean_um']
            out['%s_%s_p95_um' % (name, way)] = found and found['p95_um']
    for tier in ('1', '2', '3'):
        out['queue_tier_' + tier] = row['review_queue_by_tier'].get(tier, 0)
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description='Compare a draft run with human ROI files of the same sections.')
    parser.add_argument('--draft', required=True, type=Path, help='Folder written by roi_draft.')
    parser.add_argument('--reference', required=True, action='append', metavar='NAME=ROIS.zip')
    parser.add_argument('--output', required=True, type=Path, help='New folder; an existing one is never touched.')
    parser.add_argument('--protocol', type=Path, default=roi_measure.DEFAULT_PROTOCOL)
    args = parser.parse_args(argv)
    try:
        draft_folder, output = args.draft.resolve(), args.output.resolve()
        require(not output.exists(), 'The output folder already exists.')
        index_path = draft_folder / 'draft-index.json'
        index = json.loads(index_path.read_text())
        require(index.get('schema') == D.INDEX_SCHEMA, 'The draft folder has no draft index.')
        listed = {s['sample']: s for s in index['sections']}
        references = {}
        for item in args.reference:
            name, _, path = item.partition('=')
            require(name in listed and path and name not in references, 'Give each reference as NAME=ROIS.zip, once, for a section of the draft run.')
            path = Path(path).resolve()
            require(path.parent != output and path.parent not in output.parents, 'The output folder must not be inside a folder that holds a reference.')
            references[name] = path
        protocol = roi_measure.load_protocol(args.protocol)
        rows, skipped = [], []
        for name, path in references.items():
            entry = listed[name]
            record_path = draft_folder / entry['folder'] / entry['record']
            require(file_digest(record_path) == entry['record_sha256'], name + ': the draft record is not the one in the draft index.')
            draft = json.loads(record_path.read_text())
            draft_rois, roi_hash = read_roi_zip(draft_folder / entry['folder'] / draft['outputs']['roi']['file'])
            require(roi_hash == draft['outputs']['roi']['sha256'], name + ': the draft ROI file is not the recorded one.')
            human_rois, human_hash = read_roi_zip(path)
            try:
                row = compare(name, draft, draft_rois, human_rois, protocol)
            except ValueError as error:
                skipped.append({'sample': name, 'reason': str(error), 'reference_sha256': human_hash})
                continue
            row.update(draft_record_sha256=entry['record_sha256'], draft_roi_sha256=roi_hash, reference_file=path.name, reference_sha256=human_hash,
                       model=draft['model'], source_in_training_set=draft['model'].get('source_in_training_set'))
            rows.append(row)
            print(name + ' compared', file=sys.stderr)
        output.mkdir(parents=True)
        result = {'schema': SCHEMA, 'statement': STATEMENT, 'draft_index_sha256': file_digest(index_path), 'protocol': protocol['identity'],
                  'code_sha256': dict(D.code_identity(), **{'roi_validate.py': file_digest(Path(__file__).resolve())}),
                  'sections': rows, 'not_compared': skipped}
        D.write_new(output / 'validation.json', D.json_bytes(result))
        table = [flat(row) for row in rows]
        if table:
            with open(output / 'validation.csv', 'x', newline='', encoding='utf-8') as handle:
                writer = csv.DictWriter(handle, fieldnames=list(table[0]))
                writer.writeheader()
                writer.writerows(table)
    except (ValueError, OSError) as error:
        print('Not compared: ' + str(error), file=sys.stderr)
        return 2
    print(json.dumps({'schema': SCHEMA, 'sections': len(rows), 'not_compared': len(skipped)}, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
