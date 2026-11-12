#!/usr/bin/env python3
"""Corrected ROI proposal from a draft and a person's review of it.

A reviewer answers the draft's review queue item by item. This tool applies those answers to the
labels behind the draft: tissue the reviewer judged not to be cerebellum is taken out, borders they
asked for are added to PL_TOTAL, straight crossings they rejected are replaced by a path along the
label borders, and explicit cuts are made. Every answer is accounted for in the record, including
the ones that could not be applied. Where the reviewer points to a human ROI file of the same section, that
file can serve as the reference for labels to fix, for a cut along the human Cb outline and for widening a
layer; such a proposal repeats the human ROI there and says nothing about the model. The result is a proposal for the reviewer to look at again. It
is never an approval, and every rule and threshold here is a proposal recorded in the output.
"""
import argparse
import hashlib
import io
import json
import math
import sys
import zipfile
from collections import deque
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from native_tiff import NativeTiff  # noqa: E402
from nissl_lab import decode_roi, file_digest, read_roi_zip, require  # noqa: E402
import roi_draft as D  # noqa: E402
import roi_measure  # noqa: E402
from roi_approve import raster  # noqa: E402

ENGINE = {'name': 'roi_revise', 'version': '0.3.0'}
PROPOSAL_SCHEMA = 'cerebellum-roi-revision/1'
INDEX_SCHEMA = 'cerebellum-roi-revision-index/1'
INSTRUCTION_SCHEMA = 'cerebellum-roi-revision-instructions/1'
VERDICTS = ('ok', 'fix', 'not-cb', 'unsure')
ML, GL, WM = (D.CLASSES.index(name) for name in ('ML', 'GL', 'WM'))
# Proposals of this tool, written into every record. None is a criterion the researcher has approved.
POLICY = {
    'status': 'proposed',
    # A separate tissue part without a reviewer's answer is taken out when it is at most this large and lacks a
    # layer or a usable ML to GL border.
    'small_part_max_area_um2': 10000.0,
    # A rejected straight crossing is replaced by the shortest path along these label borders.
    'connector_borders': [['ML', 'GL'], ['GL', 'background'], ['ML', 'WM']],
    # When those borders do not connect the two ends (a hole in the tissue, for one), any border between two labels.
    'connector_fallback': 'any-label-border',
    'connector_search_margin_um': 200.0,
}
STATEMENT = ('Corrected proposal made by a tool from a reviewer\'s answers to the draft. No person has reviewed or '
             'approved this proposal.')
LIMITS = ['The reviewer answered the draft, not this proposal. A changed ROI here is the tool\'s reading of an answer.',
          'PL_TOTAL is one line. Where the border lies in pieces that are far apart, the pieces are joined by straight '
          'jumps that are not Purkinje layer; their length is reported apart and is part of the length in the table.',
          'A path along label borders is as good as the labels. It is not a traced Purkinje layer.']


# Names in a human ROI file that serve as the reference, and the two values of the reference map that are not labels.
REFERENCE_ROIS = {'Cb': 'Cb', 'ML': 'ML_TOTAL', 'GL': 'GL_TOTAL', 'WM': 'WM'}
REF_INSIDE, REF_CONFLICT = 254, 255
REFERENCE_STATEMENT = ('A human ROI file of the same section was the reference for the labels the reviewer asked to fix, '
                       'for cuts along the human Cb outline and for widened layers. Where it was used the proposal repeats '
                       'the human ROI. That is possible only for a section that already has such a file, and it is no '
                       'measure of the model.')
FOLLOW_STATEMENT = ('This section follows the human ROI file: every pixel that file decides (one of ML_TOTAL, GL_TOTAL, WM, or '
                    'outside Cb) has its label, applied after every other change, and PL_TOTAL is the PL_TOTAL of that file '
                    'unchanged. Only pixels inside the human Cb that no layer or more than one layer covers keep the label of '
                    'the draft. The result says nothing about the model.')
FOLLOW_REGIONS_LISTED = 10  # proposed: how many changed regions the queue lists one by one; the rest is summed in one item
EXTENDABLE = ('ML', 'GL', 'WM')


def reference_map(rois, height, width):
    """Human ROIs as one map: 0 outside Cb, a label where exactly one layer ROI covers the pixel, REF_INSIDE inside
    Cb without a layer (the Purkinje band, gaps), REF_CONFLICT where layer ROIs overlap."""
    named = {}
    for roi in rois:
        named.setdefault(roi['name'], []).append(roi)
    for name in REFERENCE_ROIS.values():
        require(len(named.get(name, [])) == 1 and named[name][0]['paths'] and all(len(path) >= 3 for path in named[name][0]['paths']),
                'The reference ROI file needs exactly one area named ' + name + '.')
    cb = raster(named['Cb'][0], width, height)
    layers = {name: raster(named[REFERENCE_ROIS[name]][0], width, height) for name in ('ML', 'GL', 'WM')}
    count = sum(layer.astype(np.uint8) for layer in layers.values())
    label = sum(layers[name].astype(np.uint8) * D.CLASSES.index(name) for name in layers)
    out = np.where(count == 1, label, np.where(count > 1, REF_CONFLICT, np.where(cb, REF_INSIDE, 0))).astype(np.uint8)
    return out, {'outside_cb_px': int((out == 0).sum()), 'layer_px': {name: int((out == D.CLASSES.index(name)).sum()) for name in layers},
                 'inside_cb_without_layer_px': int((out == REF_INSIDE).sum()), 'layers_overlapping_px': int((out == REF_CONFLICT).sum()),
                 'layer_outside_cb_px': int(((count > 0) & ~cb).sum())}


def cut_outside_reference(labels, cut, reference):
    """Tissue inside a window that lies outside the human Cb outline."""
    require(reference is not None, 'A cut along the human Cb outline needs a reference ROI file.')
    height, width = labels.shape
    window = cut.get('window')
    require(isinstance(window, list) and len(window) == 4 and all(type(v) is int for v in window)
            and 0 <= window[0] < window[2] <= width and 0 <= window[1] < window[3] <= height, 'Cut window is not inside the image.')
    x0, y0, x1, y1 = window
    mask = np.zeros(labels.shape, bool)
    mask[y0:y1, x0:x1] = (labels[y0:y1, x0:x1] > 0) & (reference[y0:y1, x0:x1] == 0)
    return mask, {}


def changed_classes(before, after):
    """Pixels by 'label before>label after'."""
    pairs = np.bincount(before.astype(np.int64) * len(D.CLASSES) + after, minlength=len(D.CLASSES) ** 2)
    return {D.CLASSES[i // len(D.CLASSES)] + '>' + D.CLASSES[i % len(D.CLASSES)]: int(n) for i, n in enumerate(pairs) if n}


def apply_reference(revised, reference, queue, verdicts, extend, um2):
    """Reference labels in the regions answered 'fix', tissue outside the human Cb taken out of the regions answered
    'not-cb', and layers widened to the human outline. Pixels the reference does not decide keep their label."""
    log = {'regions': [], 'extended': []}
    if reference is None:
        return log
    for item in queue:
        verdict = verdicts.get(item['rank'])
        if item['code'] != 'low-confidence-region' or verdict not in ('fix', 'not-cb'):
            continue
        x0, y0, x1, y1 = item['bounds']
        ref, now = reference[y0:y1, x0:x1], revised[y0:y1, x0:x1]
        change = ((ref <= WM) if verdict == 'fix' else (ref == 0)) & (now != ref)
        entry = {'draft_rank': item['rank'], 'verdict': verdict, 'bounds': item['bounds'], 'pixels': int(ref.size),
                 'changed_px': int(change.sum()), 'changed_um2': int(change.sum()) * um2,
                 'changed': changed_classes(now[change], ref[change]),
                 'reference_undecided_px': int((ref > WM).sum())}
        now[change] = ref[change]
        entry['tissue_inside_reference_cb_px'] = int(((now > 0) & (ref > 0)).sum())
        log['regions'].append(entry)
    for name in extend:
        value = D.CLASSES.index(name)
        mask = (reference == value) & (revised != value)
        entry = {'layer': name, 'added_px': int(mask.sum()), 'added_um2': int(mask.sum()) * um2,
                 'taken_from': changed_classes(revised[mask], reference[mask]), 'bounds': mask_bounds(mask) if mask.any() else None}
        revised[mask] = value
        log['extended'].append(entry)
    return log


def part_mask(found, part):
    x0, y0, x1, y1 = part['bounds']
    mask = np.zeros(found.shape, bool)
    mask[y0:y1, x0:x1] = found[y0:y1, x0:x1] == part['label']
    return mask


def part_layers(labels, found, part):
    x0, y0, x1, y1 = part['bounds']
    local = np.where(found[y0:y1, x0:x1] == part['label'], labels[y0:y1, x0:x1], 0)
    ml, gl = local == ML, local == GL
    border = int((ml[:, :-1] & gl[:, 1:]).sum() + (gl[:, :-1] & ml[:, 1:]).sum()
                 + (ml[:-1] & gl[1:]).sum() + (gl[:-1] & ml[1:]).sum())
    return {'ML_px': int(ml.sum()), 'GL_px': int(gl.sum()), 'WM_px': int((local == WM).sum()), 'ml_gl_border_px': border}


def small_part_rule(area_um2, layers, policy, parameters):
    """The proposed reading of 'a very small separate piece without normal layers'."""
    lacking = [name for name in ('ML', 'GL', 'WM') if not layers[name + '_px']]
    no_border = layers['ml_gl_border_px'] < parameters['pl_min_chain_px']
    return bool(area_um2 <= policy['small_part_max_area_um2'] and (lacking or no_border)), lacking, no_border


def cut_below_layer_edge(labels, cut):
    """Tissue below the lower edge of one layer inside a window, column by column.

    On the level side of the layer's lowest point the cut is level with that point; on the other side it follows
    the lowest pixel of the layer in each column, and a column without the layer takes the limit of the column
    next to it on the side of the lowest point.
    """
    require(cut.get('kind') == 'below-layer-edge' and cut.get('layer') in D.CLASSES[1:]
            and cut.get('level_side') in ('left', 'right', 'none'), 'Unknown cut.')
    height, width = labels.shape
    window = cut.get('window')
    require(isinstance(window, list) and len(window) == 4 and all(type(v) is int for v in window)
            and 0 <= window[0] < window[2] <= width and 0 <= window[1] < window[3] <= height, 'Cut window is not inside the image.')
    x0, y0, x1, y1 = window
    view = labels[y0:y1, x0:x1]
    layer = view == D.CLASSES.index(cut['layer'])
    require(layer.any(), 'The cut window holds no ' + cut['layer'] + '.')
    rows = np.arange(y1 - y0)[:, None]
    low = np.where(layer.any(0), (layer * (rows + 1)).max(0) - 1, -1)
    tip = int(low.argmax())
    limit = low.copy()
    if cut['level_side'] == 'left':
        limit[:tip] = low[tip]
    elif cut['level_side'] == 'right':
        limit[tip + 1:] = low[tip]
    for column in range(tip + 1, len(limit)):
        if limit[column] < 0:
            limit[column] = limit[column - 1]
    for column in range(tip - 1, -1, -1):
        if limit[column] < 0:
            limit[column] = limit[column + 1]
    mask = np.zeros(labels.shape, bool)
    mask[y0:y1, x0:x1] = (rows > limit[None, :]) & (view > 0)
    return mask, {'lowest_point': [x0 + tip, y0 + int(low[tip])]}


def mask_bounds(mask):
    ys, xs = np.flatnonzero(mask.any(1)), np.flatnonzero(mask.any(0))
    return [int(xs[0]), int(ys[0]), int(xs[-1]) + 1, int(ys[-1]) + 1]


def chain_bounds(chain):
    return [min(p[0] for p in chain), min(p[1] for p in chain), max(p[0] for p in chain), max(p[1] for p in chain)]


def surviving_share(chain, labels):
    """Share of a border chain's edges that still separate ML from GL in labels."""
    kept = 0
    for (ax, ay), (bx, by) in zip(chain, chain[1:]):
        if ax == bx:
            y = min(ay, by)
            pair = {int(labels[y, ax - 1]), int(labels[y, ax])}
        else:
            x = min(ax, bx)
            pair = {int(labels[ay - 1, x]), int(labels[ay, x])}
        kept += pair == {ML, GL}
    return kept / (len(chain) - 1)


def follow_reference(labels, revised, reference, um2):
    """The human ROI has the last word: every pixel it decides takes its label. Returns the log of what changed."""
    change = (reference <= WM) & (revised != reference)
    against_draft = (reference <= WM) & (labels != reference)
    log = {'changed_after_other_steps_px': int(change.sum()), 'changed_after_other_steps': changed_classes(revised[change], reference[change]),
           'changed_from_draft_px': int(against_draft.sum()), 'changed_from_draft_um2': int(against_draft.sum()) * um2,
           'changed_from_draft': changed_classes(labels[against_draft], reference[against_draft]),
           'reference_undecided_px': int((reference > WM).sum()),
           'draft_label_kept_px': {D.CLASSES[v]: int(((reference > WM) & (labels == v)).sum()) for v in range(len(D.CLASSES))}}
    revised[change] = reference[change]
    found, parts = D.components(against_draft)
    regions = sorted(({'bounds': part['bounds'], 'area_um2': part['area_px'] * um2, 'label': part['label']} for part in parts),
                     key=lambda e: (-e['area_um2'], e['bounds']))
    for entry in regions[:FOLLOW_REGIONS_LISTED]:
        x0, y0, x1, y1 = entry['bounds']
        mask = found[y0:y1, x0:x1] == entry.pop('label')
        entry['changed'] = changed_classes(labels[y0:y1, x0:x1][mask], reference[y0:y1, x0:x1][mask])
    for entry in regions[FOLLOW_REGIONS_LISTED:]:
        del entry['label']
    log['regions_changed_from_draft'] = len(regions)
    log['largest_regions'] = regions[:FOLLOW_REGIONS_LISTED]
    log['other_regions_um2'] = sum(e['area_um2'] for e in regions[FOLLOW_REGIONS_LISTED:])
    return log


def revise_tissue(labels, queue, verdicts, cuts, policy, parameters, scale, reference=None, extend=(), follow=False):
    """Labels with the reviewer's tissue answers, the reference, the cuts and the proposed small-part rule applied."""
    um2 = 1 / (scale * scale)
    found, parts = D.components(labels > 0)
    by_bounds = {}
    for part in parts[1:]:
        by_bounds.setdefault(tuple(part['bounds']), []).append(part)
    revised = labels.copy()
    reference_log = apply_reference(revised, reference, queue, verdicts, extend, um2)
    keep = np.zeros(labels.shape, bool)
    rank_of, log, evidence = {}, [], {'agree': 0, 'rule_would_keep': 0, 'rule_would_remove_accepted_part': 0}
    for item in queue:
        if not item['code'].startswith('detached-part'):
            continue
        match = by_bounds.get(tuple(item['bounds']), [])
        require(len(match) == 1, 'Review item %d does not name one tissue part of the draft.' % item['rank'])
        part, verdict = match[0], verdicts.get(item['rank'])
        layers = part_layers(labels, found, part)
        area = part['area_px'] * um2
        rule, lacking, no_border = small_part_rule(area, layers, policy, parameters)
        entry = {'draft_rank': item['rank'], 'verdict': verdict, 'bounds': part['bounds'], 'area_um2': area,
                 'layers_px': layers, 'layers_lacking': lacking, 'proposed_rule_says_remove': rule}
        rank_of[part['label']] = entry
        if verdict == 'not-cb':
            revised[part_mask(found, part)] = 0
            entry['action'], entry['reason'] = 'removed', 'reviewer: not cerebellum'
            evidence['agree' if rule else 'rule_would_keep'] += 1
        elif verdict == 'ok':
            keep |= part_mask(found, part)
            entry['action'], entry['reason'] = 'kept', 'reviewer: accepted as drafted'
            evidence['rule_would_remove_accepted_part'] += rule
        log.append(entry)
    cut_log, cut_mask = [], np.zeros(labels.shape, bool)
    for cut in cuts:
        mask, detail = cut_outside_reference(revised, cut, reference) if cut.get('kind') == 'outside-reference-cb' \
            else cut_below_layer_edge(revised, cut)
        if mask.any():
            cut_mask |= mask
            revised[mask] = 0
        cut_log.append(dict(cut, **detail, removed_um2=int(mask.sum()) * um2, removed_bounds=mask_bounds(mask) if mask.any() else None))
    found2, parts2 = D.components(revised > 0)
    require(parts2, 'No tissue is left after the review answers were applied.')
    for part in parts2[1:]:
        x0, y0, x1, y1 = part['bounds']
        inside = found2[y0:y1, x0:x1] == part['label']
        if keep[y0:y1, x0:x1][inside].any():
            continue
        origins = found[y0:y1, x0:x1][inside]
        origins = origins[origins > 0]
        entry = rank_of.get(int(origins[0])) if origins.size else None
        layers = part_layers(revised, found2, part)
        area = part['area_px'] * um2
        rule, lacking, no_border = small_part_rule(area, layers, policy, parameters)
        if entry is not None and 'action' not in entry and entry['area_um2'] != area:
            entry.update(area_after_changes_um2=area, layers_after_changes_px=layers, proposed_rule_says_remove=rule)
        elif entry is None or entry['area_um2'] != area:
            entry = {'draft_rank': entry['draft_rank'] if entry else None, 'verdict': entry['verdict'] if entry else None,
                     'bounds': part['bounds'], 'area_um2': area, 'layers_px': layers, 'layers_lacking': lacking,
                     'proposed_rule_says_remove': rule, 'separated_by_cut': True}
            log.append(entry)
        if rule:
            revised[part_mask(found2, part)] = 0
            entry['action'] = 'removed'
            entry['reason'] = 'proposed rule: small separate part without ' + (', '.join(lacking) if lacking else 'a usable ML to GL border')
        else:
            entry['action'], entry['reason'] = 'kept', 'no answer removes it and the proposed rule does not apply'
    for entry in log:
        if 'action' not in entry:
            entry['action'], entry['reason'] = 'gone', 'nothing of this part is left after the other changes'
    log.sort(key=lambda e: (e['draft_rank'] is None, e['draft_rank'] or 0, e['bounds']))
    if follow:
        reference_log['section'] = follow_reference(labels, revised, reference, um2)
    return revised, {'parts': log, 'cuts': cut_log, 'rule_against_answers': evidence, 'reference': reference_log}, cut_mask


def border_path(labels, start, goal, margin, blocked, pairs):
    """Shortest path along allowed label borders between two lattice vertices, inside a window around them."""
    height, width = labels.shape
    x0, x1 = max(0, min(start[0], goal[0]) - margin), min(width, max(start[0], goal[0]) + margin)
    y0, y1 = max(0, min(start[1], goal[1]) - margin), min(height, max(start[1], goal[1]) + margin)
    wide, high = x1 - x0, y1 - y0
    pad = np.zeros((high + 2, wide + 2), np.uint8)
    ya, yb, xa, xb = max(0, y0 - 1), min(height, y1 + 1), max(0, x0 - 1), min(width, x1 + 1)
    pad[ya - y0 + 1:yb - y0 + 1, xa - x0 + 1:xb - x0 + 1] = labels[ya:yb, xa:xb]
    allowed = np.zeros((len(D.CLASSES), len(D.CLASSES)), bool)
    if pairs is None:
        allowed = ~np.eye(len(D.CLASSES), dtype=bool)
    for a, b in pairs or []:
        allowed[D.CLASSES.index(a), D.CLASSES.index(b)] = allowed[D.CLASSES.index(b), D.CLASSES.index(a)] = True
    vertical = allowed[pad[1:high + 1, 0:wide + 1], pad[1:high + 1, 1:wide + 2]]      # vertex (i, j) to (i, j + 1)
    level = allowed[pad[0:high + 1, 1:wide + 1], pad[1:high + 2, 1:wide + 1]]         # vertex (i, j) to (i + 1, j)
    stride, global_stride = wide + 1, width + 1

    def key(i, j, k, l):
        a, b = (y0 + j) * global_stride + x0 + i, (y0 + l) * global_stride + x0 + k
        return (a, b) if a < b else (b, a)

    first, last = (start[0] - x0) + (start[1] - y0) * stride, (goal[0] - x0) + (goal[1] - y0) * stride
    before = {first: -1}
    waiting = deque([first])
    while waiting and last not in before:
        node = waiting.popleft()
        i, j = node % stride, node // stride
        for k, l, open_ in ((i, j - 1, j > 0 and vertical[j - 1, i]), (i - 1, j, i > 0 and level[j, i - 1]),
                            (i + 1, j, i < wide and level[j, i]), (i, j + 1, j < high and vertical[j, i])):
            if open_ and (l * stride + k) not in before and key(i, j, k, l) not in blocked:
                before[l * stride + k] = node
                waiting.append(l * stride + k)
    if last not in before:
        return None
    path, node = [], last
    while node >= 0:
        path.append([x0 + node % stride, y0 + node // stride])
        node = before[node]
    return path[::-1]


def revised_line(labels, draft_line, queue, verdicts, parameters, policy, scale):
    """PL_TOTAL as one line: the drafted joining rule, plus the borders and connectors the reviewer asked for."""
    um = 1 / scale
    limit = parameters['pl_max_bridge_um'] * scale
    tolerance = parameters['pl_simplify_tolerance_px']
    chains = D.interface_chains(labels, ML, GL)
    ordered, _, omitted = D.join_chains(chains, parameters['pl_min_chain_px'], limit)
    asked = [item for item in queue if item['code'] == 'pl-chain-left-out']
    left_out, added, excluded = [], [], set()
    for entry in omitted:
        bounds = chain_bounds(entry['chain'])
        about = [i for i in asked if i['bounds'][0] <= bounds[0] and i['bounds'][1] <= bounds[1]
                 and bounds[2] <= i['bounds'][2] and bounds[3] <= i['bounds'][3]]
        wanted = [i['rank'] for i in about if verdicts.get(i['rank']) == 'fix']
        note = {'edge_length_um': (len(entry['chain']) - 1) * um, 'bounds': bounds, 'draft_ranks': [i['rank'] for i in about]}
        if entry['reason'] == 'beyond-bridge-limit' and wanted:
            added.append(dict(note, draft_ranks=wanted))
        else:
            excluded.add(id(entry['chain']))
            left_out.append(dict(note, reason=entry['reason'] if entry['reason'] != 'beyond-bridge-limit' else
                                 'far from the line and no review answer asks for it'))
    included = [c for c in chains if id(c) not in excluded]
    line, _, rest = D.join_chains(included, parameters['pl_min_chain_px'], math.inf)
    require(not rest, 'A border chain could not be placed in the line.')
    if not line:
        return None, {'status': 'proposed', 'border_chains': len(chains), 'chains_in_line': 0, 'chains_added_by_review': added,
                      'chains_left_out': left_out, 'joins': [], 'length_um': None}
    reviewed = {}
    for bridge in draft_line['bridges']:
        xs, ys = sorted((bridge['from'][0], bridge['to'][0])), sorted((bridge['from'][1], bridge['to'][1]))
        rank = next((i['rank'] for i in queue if i['code'] == 'pl-bridge' and i['bounds'] == [xs[0], ys[0], xs[1], ys[1]]), None)
        reviewed[frozenset((tuple(bridge['from']), tuple(bridge['to'])))] = rank
    blocked = set()
    stride = labels.shape[1] + 1
    for chain in line:
        for (ax, ay), (bx, by) in zip(chain, chain[1:]):
            a, b = ay * stride + ax, by * stride + bx
            blocked.add((a, b) if a < b else (b, a))
    margin = int(round(policy['connector_search_margin_um'] * scale))
    points, joins = [], []
    lengths = {'ml_gl_border': 0.0, 'border_connectors': 0.0, 'straight_bridges': 0.0, 'jumps': 0.0}
    for index, chain in enumerate(line):
        piece = D.simplify(chain, tolerance)
        if index:
            start, goal = line[index - 1][-1], chain[0]
            gap = math.dist(start, goal)
            if gap > 0:
                pair = frozenset((tuple(start), tuple(goal)))
                rank = reviewed.get(pair)
                verdict = verdicts.get(rank) if rank is not None else None
                join = {'from': list(start), 'to': list(goal), 'gap_um': gap * um, 'in_draft': pair in reviewed,
                        'draft_rank': rank, 'verdict': verdict}
                follow = False
                if verdict == 'ok':
                    join['treatment'], join['why'] = 'straight', 'reviewer accepted the straight crossing'
                elif gap > limit:
                    join['treatment'], join['why'] = 'jump', 'the pieces lie farther apart than the drafted bridge limit'
                elif verdict == 'fix':
                    follow, join['why'] = True, 'reviewer: follow the border instead of a straight line'
                elif gap * um <= parameters['pl_bridge_review_above_um'] or pair in reviewed:
                    join['treatment'] = 'straight'
                    join['why'] = 'as drafted; ' + ('below the length shown for review' if rank is None else 'no answer changes it')
                else:
                    follow, join['why'] = True, 'new crossing after the changes; not reviewed'
                if follow:
                    path = border_path(labels, start, goal, margin, blocked, policy['connector_borders'])
                    join['borders'] = 'preferred'
                    if path is None and policy['connector_fallback'] == 'any-label-border':
                        path = border_path(labels, start, goal, margin, blocked, None)
                        join['borders'] = 'any'
                    if path is None:
                        del join['borders']
                        join['treatment'], join['why'] = 'straight-unresolved', join['why'] + '; no path along the allowed borders was found'
                    else:
                        path = D.simplify(path, tolerance)
                        join['treatment'], join['path_um'] = 'border', D.polyline_length(path) * um
                        points.extend(p for p in path[1:-1])
                        lengths['border_connectors'] += D.polyline_length(path)
                if join['treatment'] != 'border':
                    lengths['jumps' if join['treatment'] == 'jump' else 'straight_bridges'] += gap
                joins.append(join)
        for point in piece:
            if not points or points[-1] != point:
                points.append(point)
        lengths['ml_gl_border'] += D.polyline_length(piece)
    total = D.polyline_length(points)
    require(abs(total - sum(lengths.values())) <= 1e-6 * max(1.0, total), 'The parts of the line do not add up to its length.')
    report = {'status': 'proposed', 'border_chains': len(chains), 'chains_in_line': len(line),
              'chains_by_drafted_rule': len(ordered), 'chains_added_by_review': added, 'chains_left_out': left_out,
              'joins': joins, 'vertices': len(points), 'length_um': total * um,
              'length_parts_um': {name: value * um for name, value in lengths.items()},
              'length_without_jumps_um': (total - lengths['jumps']) * um,
              'border_edge_length_um': sum(len(c) - 1 for c in chains) * um}
    return (points if len(points) > 1 else None), report


def dispositions(queue, verdicts, labels, revised, tissue, line, draft_chains, cuts):
    """One line per draft review item: what the answer was and what became of it."""
    parts = {e['draft_rank']: e for e in tissue['parts'] if e['draft_rank'] is not None and not e.get('separated_by_cut')}
    joins = {j['draft_rank']: j for j in (line['joins'] if line else []) if j['draft_rank'] is not None}
    added = {rank for chain in (line['chains_added_by_review'] if line else []) for rank in chain['draft_ranks']}
    regions = {e['draft_rank']: e for e in tissue['reference']['regions']}
    out = []
    for item in queue:
        verdict = verdicts.get(item['rank'])
        row = {'draft_rank': item['rank'], 'tier': item['tier'], 'code': item['code'], 'verdict': verdict, 'bounds': item['bounds']}
        code = item['code']
        if verdict in (None, 'unsure'):
            state, detail = 'open', 'no answer yet' if verdict is None else 'reviewer was unsure'
            if code.startswith('detached-part') and parts[item['rank']]['action'] in ('removed', 'gone'):
                state, detail = 'proposed', parts[item['rank']]['reason']
        elif code.startswith('detached-part'):
            entry = parts[item['rank']]
            if verdict == 'fix':
                state = 'proposed' if entry['action'] in ('removed', 'gone') else 'unresolved'
                detail = entry['reason'] if entry['action'] in ('removed', 'gone') else 'the answer does not say what to change, and the proposed rule does not apply'
            else:
                state, detail = 'applied', entry['action'] + ' (' + entry['reason'] + ')'
        elif code == 'pl-chain-left-out':
            chain = draft_chains.get(tuple(item['bounds']))
            share = surviving_share(chain, revised) if chain else None
            row['border_still_present_share'] = share
            if verdict == 'fix':
                if share == 0:
                    state, detail = 'superseded', 'the tissue under this border was taken out by another answer, so there is no border to add'
                elif item['rank'] in added:
                    state, detail = 'applied', 'added to PL_TOTAL' + ('' if share == 1 else '; part of it lies in tissue that was taken out')
                else:
                    state, detail = 'unresolved', 'the border could not be matched after the other changes'
            elif verdict == 'not-cb':
                state, detail = ('applied', 'gone with the tissue that was taken out') if share == 0 else \
                    ('unresolved', 'the border lies in tissue that stays; it is left out of PL_TOTAL and nothing was removed')
            else:
                state, detail = 'applied', 'left out of PL_TOTAL as drafted'
        elif code == 'pl-bridge':
            join = joins.get(item['rank'])
            if join is None:
                state, detail = 'superseded', 'this crossing is no longer part of the line'
            elif verdict == 'fix' and join['treatment'] == 'border':
                state, detail = 'applied', 'replaced by a path of %.0f um along the label borders' % join['path_um']
            elif verdict == 'ok' and join['treatment'] == 'straight':
                state, detail = 'applied', 'straight crossing kept'
            else:
                state, detail = 'unresolved', join['why']
        elif code == 'low-confidence-region':
            x0, y0, x1, y1 = item['bounds']
            before, after = int((labels[y0:y1, x0:x1] > 0).sum()), int((revised[y0:y1, x0:x1] > 0).sum())
            row['tissue_left_share'] = after / before if before else None
            region = regions.get(item['rank'])
            if region is not None and verdict == 'fix':
                state, detail = ('proposed', '%.0f um2 here took the label of the human ROI (%s)' % (
                    region['changed_um2'], ', '.join('%s %d px' % pair for pair in sorted(region['changed'].items())))) \
                    if region['changed_px'] else ('unresolved', 'the human ROI gives the same labels as the draft here; nothing was changed')
            elif region is not None and verdict == 'not-cb' and after:
                state, detail = ('proposed', 'tissue outside the human Cb outline was taken out; %.0f%% of the drafted tissue here lies '
                                 'inside that outline and stays' % (100 * after / before)) if region['changed_px'] else \
                    ('unresolved', 'the tissue here lies inside the human Cb outline; nothing was removed')
            elif before and not after:
                state, detail = ('applied' if verdict == 'not-cb' else 'superseded'), 'all tissue here was taken out by another answer or a cut'
            elif verdict == 'ok':
                state, detail = 'applied', 'kept as drafted'
            else:
                state = 'unresolved'
                detail = 'the answer does not say which layer this should be' if verdict == 'fix' else \
                    'this is not a separate tissue part; nothing was removed'
        elif code == 'main-part-at-image-border':
            state, detail = ('proposed', 'a cut was made; it is the tool\'s reading of the reviewer\'s instruction') if cuts and verdict == 'fix' \
                else (('applied', 'kept as drafted') if verdict == 'ok' else ('unresolved', 'no cut was given'))
        elif code == 'pl-border-left-out':
            state, detail = ('applied', 'see the left-out border items') if verdict in ('fix', 'ok') else ('unresolved', 'not a tissue part')
        else:
            state, detail = ('applied', 'kept as drafted') if verdict == 'ok' else ('unresolved', 'this tool has no change for this kind of item')
        out.append(dict(row, state=state, detail=detail))
    return out


def proposal_queue(rows, tissue, line, structure):
    """What a person should look at in the proposal, most consequential first."""
    items = []

    def add(tier, code, detail, bounds=None, draft_rank=None, weight=0.0):
        items.append({'tier': tier, 'code': code, 'detail': detail, 'bounds': bounds, 'draft_rank': draft_rank, 'weight': weight})

    for cut in tissue['cuts']:
        where = 'outside the human Cb outline' if cut['kind'] == 'outside-reference-cb' else 'below the lower edge of ' + cut['layer']
        add(1, 'cut-to-confirm', 'Tissue of %.0f um2 %s was taken out. This is the tool\'s reading of the reviewer\'s instruction.'
            % (cut['removed_um2'], where), cut['removed_bounds'], weight=cut['removed_um2'])
    for entry in tissue['reference']['extended']:
        add(1, 'layer-widened-to-reference', '%s was widened by %.0f um2 to the human %s outline.'
            % (entry['layer'], entry['added_um2'], REFERENCE_ROIS[entry['layer']]), entry['bounds'], weight=entry['added_um2'])
    for row in rows:
        if row['state'] == 'superseded' and row['verdict'] == 'fix':
            add(1, 'answers-disagree', 'Draft item %d was marked to be fixed, but: %s.' % (row['draft_rank'], row['detail']),
                row['bounds'], row['draft_rank'])
        elif row['state'] == 'proposed' and row['code'] == 'low-confidence-region':
            add(2, 'label-from-reference', 'Draft item %d: %s.' % (row['draft_rank'], row['detail']), row['bounds'], row['draft_rank'],
                row['tissue_left_share'] or 0.0)
        elif row['state'] == 'unresolved':
            add(1, 'answer-not-applied', 'Draft item %d (%s): %s.' % (row['draft_rank'], row['code'], row['detail']),
                row['bounds'], row['draft_rank'])
    if structure['main_part_touches_image_border'] and not tissue['cuts']:
        add(1, 'main-part-at-image-border', 'The main tissue part still reaches the image border.')
    for entry in tissue['parts']:
        if entry['action'] == 'removed' and entry['reason'].startswith('proposed rule'):
            add(2, 'part-removed-by-proposed-rule', 'Tissue of %.0f um2 taken out (%s).' % (entry['area_um2'], entry['reason']),
                entry['bounds'], entry['draft_rank'], entry['area_um2'])
        elif entry['action'] == 'kept' and entry['verdict'] != 'ok':
            add(2, 'detached-part-kept', 'Tissue of %.0f um2 separate from the main part stays inside Cb.' % entry['area_um2'],
                entry['bounds'], entry['draft_rank'], entry['area_um2'])
    for join in (line['joins'] if line else []):
        xs, ys = sorted((join['from'][0], join['to'][0])), sorted((join['from'][1], join['to'][1]))
        bounds = [xs[0], ys[0], xs[1], ys[1]]
        if join['treatment'] == 'jump':
            add(2, 'pl-jump', 'PL_TOTAL jumps %.0f um in a straight line between separate pieces of border. The jump is not '
                'Purkinje layer.' % join['gap_um'], bounds, join['draft_rank'], join['gap_um'])
        elif join['treatment'] == 'border':
            add(2, 'pl-connector-along-border', 'A straight crossing of %.0f um was replaced by %.0f um along %s.'
                % (join['gap_um'], join['path_um'], 'the ML, GL and tissue borders' if join['borders'] == 'preferred' else
                   'label borders that include the edge of a hole or of another layer'), bounds, join['draft_rank'], join['path_um'])
        elif join['treatment'] == 'straight-unresolved':
            add(1, 'pl-connector-not-found', 'PL_TOTAL still crosses %.0f um in a straight line: %s.' % (join['gap_um'], join['why']),
                bounds, join['draft_rank'], join['gap_um'])
    for chain in (line['chains_added_by_review'] if line else []):
        add(2, 'pl-border-added', '%.0f um of ML to GL border was added to PL_TOTAL.' % chain['edge_length_um'], chain['bounds'],
            chain['draft_ranks'][0], chain['edge_length_um'])
    for chain in (line['chains_left_out'] if line else []):
        if chain['reason'] != 'shorter-than-minimum':
            add(2, 'pl-chain-left-out', '%.0f um of ML to GL border is not in PL_TOTAL.' % chain['edge_length_um'], chain['bounds'],
                weight=chain['edge_length_um'])
    items.sort(key=lambda item: (item['tier'], item['code'], -item['weight'], item['bounds'] or [], item['detail']))
    for rank, item in enumerate(items, 1):
        item['rank'] = rank
        del item['weight']
    return items


def reference_line(rois):
    """PL_TOTAL of the human ROI file, as drawn: one ROI, a line or an area band."""
    found = [roi for roi in rois if roi['name'] == 'PL_TOTAL']
    require(len(found) == 1 and found[0]['kind'] in ('polyline', 'area') and found[0]['paths']
            and all(len(path) >= (3 if found[0]['kind'] == 'area' else 2) for path in found[0]['paths']),
            'The reference ROI file needs exactly one PL_TOTAL, a line or an area.')
    return found[0]


def roi_zip_with_copies(rois, copies):
    """The ROI ZIP of roi_draft, except that the named entries are the bytes of the human file, copied unchanged.
    A human outline can have sub-pixel vertices, which this tool's own encoder does not write."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        for roi in rois:
            entry = zipfile.ZipInfo(roi['name'] + '.roi', date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type, entry.create_system, entry.external_attr = zipfile.ZIP_DEFLATED, 3, 0o644 << 16
            payload = copies[roi['name']] if roi['name'] in copies else D.encode_roi(roi['name'], roi['kind'], roi['paths'])
            archive.writestr(entry, payload, compresslevel=6)
    return buffer.getvalue()


def reference_entry_bytes(path, roi):
    """The stored bytes of one ROI of a ROI ZIP."""
    with zipfile.ZipFile(path) as archive:
        found = [data for data, name in ((archive.read(member), member.filename) for member in archive.infolist() if not member.is_dir())
                 if decode_roi(data, name)['name'] == roi['name']]
        require(len(found) == 1 and decode_roi(found[0], roi['name'] + '.roi')['paths'] == roi['paths'],
                'The reference ROI file does not hold exactly one entry for ' + roi['name'] + '.')
        return found[0]


def follow_queue(tissue, pl, reference, scale):
    """What a person should look at in a section that follows the human ROI file."""
    um2 = 1 / (scale * scale)
    log, items = tissue['reference']['section'], []
    items.append({'tier': 1, 'code': 'section-follows-reference', 'bounds': None, 'draft_rank': None,
                  'detail': 'Labels follow the human ROI file in the whole section: %.0f um2 in %d places differ from the draft (%s).' % (
                      log['changed_from_draft_um2'], log['regions_changed_from_draft'],
                      ', '.join('%s %d px' % pair for pair in sorted(log['changed_from_draft'].items())) or 'nothing')})
    items.append({'tier': 1, 'code': 'pl-from-reference', 'bounds': None, 'draft_rank': None,
                  'detail': 'PL_TOTAL is the PL_TOTAL of the human ROI file, unchanged: ' + (
                      'one line.' if pl['geometry'] == 'polyline' else 'an area band of %d outlines, which has no length.' % pl['paths'])})
    kept = {name: n for name, n in log['draft_label_kept_px'].items() if n and name != 'background'}
    if kept or reference['pixels']['layers_overlapping_px']:
        items.append({'tier': 1, 'code': 'draft-label-kept-where-reference-undecided', 'bounds': None, 'draft_rank': None,
                      'detail': 'Inside the human Cb, %.0f um2 that no human layer covers and %.0f um2 that more than one covers keep the '
                                'label of the draft (%s).' % (reference['pixels']['inside_cb_without_layer_px'] * um2,
                                                              reference['pixels']['layers_overlapping_px'] * um2,
                                                              ', '.join('%s %d px' % pair for pair in sorted(kept.items())) or 'no tissue label')})
    for entry in log['largest_regions']:
        items.append({'tier': 2, 'code': 'changed-to-reference', 'bounds': entry['bounds'], 'draft_rank': None,
                      'detail': '%.0f um2 here differ from the draft and now have the label of the human ROI file (%s).' % (
                          entry['area_um2'], ', '.join('%s %d px' % pair for pair in sorted(entry['changed'].items())))})
    if log['regions_changed_from_draft'] > len(log['largest_regions']):
        items.append({'tier': 2, 'code': 'changed-to-reference-not-listed', 'bounds': None, 'draft_rank': None,
                      'detail': '%d smaller places, %.0f um2 together, also changed to the label of the human ROI file and are not listed '
                                'one by one.' % (log['regions_changed_from_draft'] - len(log['largest_regions']), log['other_regions_um2'])})
    for rank, item in enumerate(items, 1):
        item['rank'] = rank
    return items


def code_identity():
    return dict(D.code_identity(), **{'roi_revise.py': file_digest(Path(__file__).resolve())})


def answers(sample, queue, section):
    """The reviewer's answers of one section by queue rank; every answer must name an item of the draft's queue."""
    require(isinstance(section, dict) and set(section) <= {'verdicts', 'note', 'cuts', 'extend_to_reference', 'follow_reference'}, 'The instructions for %s hold an unknown entry.' % sample)
    verdicts = {}
    for rank, verdict in (section.get('verdicts') or {}).items():
        require(str(rank).isdigit() and verdict in VERDICTS and any(i['rank'] == int(rank) for i in queue),
                'Answer %s=%s does not match the review queue of %s.' % (rank, verdict, sample))
        verdicts[int(rank)] = verdict
    extend = section.get('extend_to_reference') or []
    require(isinstance(extend, list) and len(set(extend)) == len(extend) and set(extend) <= set(EXTENDABLE),
            'The layers to widen for %s are not known.' % sample)
    require(section.get('follow_reference') in (None, False, True), 'follow_reference for %s must be true or false.' % sample)
    return verdicts


def write_proposal(folder, sample, draft, draft_sha256, labels, section, policy, protocol, basis, reference=None):
    """Write the proposed ROI ZIP, its measurement table and the proposal record for one section into a new folder.

    labels are the cleaned labels the draft was made from; their hash must be the one in the draft record.
    reference, when given, is {'file', 'sha256', 'rois'} of a human ROI file of the same section.
    """
    require(D.SAMPLE_NAME.fullmatch(sample) is not None and draft.get('schema') == D.DRAFT_SCHEMA and draft.get('sample') == sample,
            'The draft record is not the draft of ' + sample + '.')
    require(hashlib.sha256(labels.tobytes()).hexdigest() == draft['labels']['draft_sha256'], 'The labels are not the ones the draft was made from.')
    require(draft['protocol'] == protocol['identity'], 'The protocol is not the one the draft was made with.')
    parameters, queue, scale = draft['engine']['parameters'], draft['review_queue'], protocol['calibration']['pixels_per_micron']
    verdicts = answers(sample, queue, section)
    cuts = section.get('cuts') or []
    extent = (draft['labels']['labelled_extent']['height'], draft['labels']['labelled_extent']['width'])
    extend = section.get('extend_to_reference') or []
    follow = section.get('follow_reference') is True
    require(reference is not None or not (follow or extend or any(c.get('kind') == 'outside-reference-cb' for c in cuts)),
            sample + ': the instructions need a reference ROI file.')
    reference_labels = reference_record = None
    if reference is not None:
        reference_labels, counted = reference_map(reference['rois'], *labels.shape)
        reference_record = {'file': reference['file'], 'sha256': reference['sha256'], 'rois_used': REFERENCE_ROIS,
                            'pixels': counted, 'statement': REFERENCE_STATEMENT, 'followed_for_whole_section': follow}
        if follow:
            reference_record['follow_statement'] = FOLLOW_STATEMENT
    changed, tissue, _ = revise_tissue(labels, queue, verdicts, cuts, policy, parameters, scale, reference_labels, extend, follow)
    revised, cleanup = D.clean_labels(changed, parameters['min_part_area_px'])
    rois, structure = D.draft_rois(revised, protocol, parameters, extent)
    if follow:
        human = reference_line(reference['rois'])
        line, pl = None, {'source': 'reference', 'geometry': human['kind'], 'paths': len(human['paths']),
                          'vertices': sum(len(path) for path in human['paths']), 'joins': [], 'chains_added_by_review': [],
                          'chains_left_out': [], 'length_without_jumps_um': None,
                          'copied_bytes_sha256': hashlib.sha256(reference['entries']['PL_TOTAL']).hexdigest() if reference.get('entries') else None,
                          'note': 'PL_TOTAL is the PL_TOTAL of the human ROI file, unchanged. No line was made from the labels.'}
    else:
        line, pl = revised_line(revised, draft['structure']['purkinje_line'], queue, verdicts, parameters, policy, scale)
    rois = [r for r in rois if r['name'] != 'PL_TOTAL']
    if follow:
        rois.append({'name': 'PL_TOTAL', 'kind': human['kind'], 'paths': human['paths']})
    elif line:
        rois.append({'name': 'PL_TOTAL', 'kind': 'polyline', 'paths': [line]})
    rois.sort(key=lambda r: D.ROI_ORDER.index(r['name']))
    structure['purkinje_line_by_drafted_rule'] = {k: v for k, v in structure.pop('purkinje_line').items() if k not in ('bridges', 'omitted')}
    structure['purkinje_line'] = pl
    draft_chains = {}
    if not follow and any(i['code'] == 'pl-chain-left-out' and i['rank'] in verdicts for i in queue):
        _, _, omitted = D.join_chains(D.interface_chains(labels, ML, GL), parameters['pl_min_chain_px'], parameters['pl_max_bridge_um'] * scale)
        draft_chains = {tuple(chain_bounds(e['chain'])): e['chain'] for e in omitted}
    rows = dispositions(queue, verdicts, labels, revised, tissue, pl, draft_chains, cuts)
    if follow:
        rows = [dict(row, state='superseded', detail='the section follows the human ROI file; what the tool did for this answer '
                     'before that was: ' + row['state'] + ', ' + row['detail']) for row in rows]
    folder = Path(folder)
    folder.mkdir()
    roi_path, table_path = folder / (sample + '.proposal-roi.zip'), folder / (sample + '.proposal-measurement.csv')
    copies = {'PL_TOTAL': reference['entries']['PL_TOTAL']} if follow and reference.get('entries') else {}
    D.write_new(roi_path, roi_zip_with_copies(rois, copies) if copies else D.roi_zip_bytes(rois))
    decoded, roi_hash = read_roi_zip(roi_path)
    require([(r['name'], r['paths']) for r in decoded] == [(r['name'], r['paths']) for r in rois],
            'The written ROI file does not read back as the proposal.')
    records = roi_measure.measure(decoded, protocol)
    qc = roi_measure.section_qc(records, protocol)
    table = roi_measure.table_rows(records, sample)
    roi_measure.write_table(table, table_path)
    before, after = draft['measurement']['values'], qc['values']
    names = list(D.AREA_CLASSES)
    comparison = {name: {'draft_um2': before['area_um2'].get(name), 'proposal_um2': after['area_um2'].get(name)} for name in names}
    comparison['PL_TOTAL'] = {'draft_um': before['pl_total_length_um'], 'proposal_um': after['pl_total_length_um'],
                              'proposal_without_jumps_um': pl.get('length_without_jumps_um')}
    states = {}
    for row in rows:
        states[row['state']] = states.get(row['state'], 0) + 1
    record = {
        'schema': PROPOSAL_SCHEMA, 'status': 'proposal',
        'approval': {'approved': False, 'statement': STATEMENT},
        'sample': sample, 'source': draft['source'], 'model': draft['model'], 'protocol': protocol['identity'],
        'based_on': {'draft_record_sha256': draft_sha256, 'draft_roi_sha256': draft['outputs']['roi']['sha256'],
                     'draft_engine': {k: draft['engine'][k] for k in ('name', 'version', 'code_sha256')}},
        'engine': dict(ENGINE, code_sha256=code_identity(), parameters=parameters, policy=policy, environment=D.environment()),
        'review': {'basis': basis, 'answers': {str(k): v for k, v in sorted(verdicts.items())}, 'note': section.get('note'),
                   'cuts': cuts, 'extend_to_reference': extend, 'follow_reference': follow, 'items_by_state': states, 'items': rows},
        'reference': reference_record,
        'labels': {'draft_sha256': draft['labels']['draft_sha256'], 'proposal_sha256': hashlib.sha256(revised.tobytes()).hexdigest(),
                   'labelled_extent': draft['labels']['labelled_extent'], 'cleanup_after_changes': cleanup},
        'changes': tissue,
        'outputs': {'roi': {'file': roi_path.name, 'sha256': roi_hash, 'bytes': roi_path.stat().st_size,
                            'rois': [{'name': r['name'], 'type': r['type'], 'geometry': r['geometry'],
                                      'paths': r['path_count'], 'vertices': r['vertex_count']} for r in records]},
                    'table': {'file': table_path.name, 'sha256': file_digest(table_path), 'rows': len(table)}},
        'measurement': qc, 'comparison': comparison, 'structure': structure,
        'review_queue': follow_queue(tissue, pl, reference_record, scale) if follow else proposal_queue(rows, tissue, pl, structure),
        'not_drafted': D.NOT_DRAFTED, 'limits': LIMITS + D.LIMITS,
    }
    record_path = folder / (sample + '.proposal.json')
    D.write_new(record_path, D.json_bytes(record))
    return record, record_path, revised


def load_instructions(path, index_sha256):
    data = json.loads(Path(path).read_text())
    require(data.get('schema') == INSTRUCTION_SCHEMA and isinstance(data.get('sections'), dict) and isinstance(data.get('basis'), list),
            'Not a revision instruction file.')
    require(data.get('draft_index_sha256') == index_sha256, 'The instructions were written for another draft run.')
    policy = dict(POLICY, **(data.get('policy') or {}))
    require(set(policy) == set(POLICY) and policy['status'] == 'proposed' and policy['connector_fallback'] in ('any-label-border', 'none'),
            'The policy holds a setting this tool does not know.')
    return data, policy


def main(argv=None):
    parser = argparse.ArgumentParser(description='Corrected ROI proposal from a draft run and the review answers to it.')
    parser.add_argument('--draft', required=True, type=Path, help='Folder written by roi_draft.')
    parser.add_argument('--instructions', required=True, type=Path, help='Review answers, cuts and policy (JSON).')
    parser.add_argument('--model', required=True, type=Path, help='The layer U-Net bundle the draft was made with.')
    parser.add_argument('--section', required=True, action='append', metavar='NAME=MONTAGE.tif')
    parser.add_argument('--reference', action='append', default=[], metavar='NAME=ROIS.zip',
                        help='Human ROI file of a section, used only where the instructions ask for it.')
    parser.add_argument('--output', required=True, type=Path, help='New folder; an existing one is never touched.')
    parser.add_argument('--protocol', type=Path, default=roi_measure.DEFAULT_PROTOCOL)
    args = parser.parse_args(argv)
    try:
        draft_folder, output = args.draft.resolve(), args.output.resolve()
        require(not output.exists(), 'The output folder already exists; proposals are never written over.')
        require(output != draft_folder and draft_folder not in output.parents, 'The output folder must not be inside the draft folder.')
        index_path = draft_folder / 'draft-index.json'
        index = json.loads(index_path.read_text())
        require(index.get('schema') == D.INDEX_SCHEMA, 'The draft folder has no draft index.')
        listed = {s['sample']: s for s in index['sections']}
        instructions, policy = load_instructions(args.instructions, file_digest(index_path))
        sections = []
        for item in args.section:
            name, _, image = item.partition('=')
            require(name in listed and image, 'Give each section as NAME=MONTAGE.tif, with a name from the draft run.')
            image = Path(image).resolve()
            require(image.parent != output and image.parent not in output.parents, 'The output folder must not be inside a folder that holds an original image.')
            sections.append((name, image))
        require(len({name for name, _ in sections}) == len(sections), 'Section names must differ.')
        references = {}
        for item in args.reference:
            name, _, path = item.partition('=')
            require(name in dict(sections) and path and name not in references, 'Give each reference as NAME=ROIS.zip, once, for a section of this run.')
            path = Path(path).resolve()
            require(path.parent != output and path.parent not in output.parents, 'The output folder must not be inside a folder that holds a reference.')
            rois, digest = read_roi_zip(path)
            references[name] = {'file': path.name, 'sha256': digest, 'rois': rois}
            args.reference_paths = dict(getattr(args, 'reference_paths', {}), **{name: path})
        require(set(instructions['sections']) <= set(listed), 'The instructions name a section the draft run does not have.')
        protocol = roi_measure.load_protocol(args.protocol)
        bundle, model, _ = D.load_bundle(args.model)
        network = D.load_network(bundle)
        drafts = {}
        for name, image in sections:
            entry = listed[name]
            record_path = draft_folder / entry['folder'] / entry['record']
            require(file_digest(record_path) == entry['record_sha256'], name + ': the draft record is not the one in the draft index.')
            draft = json.loads(record_path.read_text())
            require(file_digest(image) == draft['source']['sha256'], name + ': the montage is not the one the draft was made from.')
            require(all(draft['model'][k] == model[k] for k in ('id', 'sha256')), name + ': the model is not the one the draft was made with.')
            wanted = instructions['sections'].get(name, {})
            answers(name, draft['review_queue'], wanted)
            require(name in references or not (wanted.get('follow_reference') or wanted.get('extend_to_reference') or any(
                isinstance(c, dict) and c.get('kind') == 'outside-reference-cb' for c in wanted.get('cuts') or [])),
                name + ': the instructions need a reference ROI file.')
            if name in references:
                reference_map(references[name]['rois'], draft['source']['height'], draft['source']['width'])
                if wanted.get('follow_reference'):
                    references[name]['entries'] = {'PL_TOTAL': reference_entry_bytes(args.reference_paths[name], reference_line(references[name]['rois']))}
            drafts[name] = draft
        output.mkdir(parents=True)
        entries = []
        for name, image in sections:
            entry, draft = listed[name], drafts[name]
            with NativeTiff(image) as tiff:
                reduced = D.reduced_image(tiff, bundle['input']['block_mean_factor'])
                _, labels = D.predict(network, bundle, reduced, tiff.height, tiff.width)
            require(hashlib.sha256(labels.tobytes()).hexdigest() == draft['labels']['model_sha256'], name + ': the model labels did not reproduce.')
            cleaned, _ = D.clean_labels(labels, draft['engine']['parameters']['min_part_area_px'])
            record, path, _ = write_proposal(output / name, name, draft, entry['record_sha256'], cleaned,
                                             instructions['sections'].get(name, {}), policy, protocol, instructions['basis'],
                                             references.get(name))
            entries.append({'sample': name, 'folder': name, 'record': path.name, 'record_sha256': file_digest(path),
                            'draft_record_sha256': entry['record_sha256'], 'roi_sha256': record['outputs']['roi']['sha256'],
                            'table_sha256': record['outputs']['table']['sha256'],
                            'reference_sha256': record['reference']['sha256'] if record['reference'] else None,
                            'source_in_training_set': record['model']['source_in_training_set'],
                            'items_by_state': record['review']['items_by_state'], 'queue_items': len(record['review_queue']),
                            'comparison': record['comparison']})
            print('%s: %s; %d items to look at' % (name, ', '.join('%d %s' % (v, k) for k, v in sorted(record['review']['items_by_state'].items())),
                                                   len(record['review_queue'])), file=sys.stderr)
        result = {'schema': INDEX_SCHEMA, 'status': 'proposal', 'approval': {'approved': False, 'statement': STATEMENT},
                  'draft_index_sha256': file_digest(index_path), 'instructions_sha256': file_digest(args.instructions),
                  'basis': instructions['basis'], 'policy': policy, 'sections': entries}
        D.write_new(output / 'proposal-index.json', D.json_bytes(result))
        D.write_new(output / 'revision-instructions.json', Path(args.instructions).read_bytes())
    except (ValueError, OSError) as error:
        print('Not revised: ' + str(error), file=sys.stderr)
        return 2
    print(json.dumps({'schema': INDEX_SCHEMA, 'sections': len(entries)}, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
