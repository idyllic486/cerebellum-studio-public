#!/usr/bin/env python3
"""Checks of the ROI revision tool on synthetic labels: review answers on tissue parts, the proposed small-part
rule, cuts, a human ROI file as the reference, PL connectors along label borders, added borders and jumps, the
record, repeatability and refusals.
The command is checked end to end only where PyTorch is installed. No tissue accuracy claim."""
from pathlib import Path
import base64
import contextlib
import hashlib
import io
import json
import sys
import tempfile

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import roi_draft as D  # noqa: E402
import roi_measure as M  # noqa: E402
import roi_revise as R  # noqa: E402
from nissl_lab import read_roi_zip  # noqa: E402

PPM = 1.4
UM2 = 1 / (PPM * PPM)
SOURCE = {'file_name': 'Montage.tif', 'bytes': 1, 'sha256': '0' * 64, 'width': 900, 'height': 400, 'channels': 3}
MODEL = {'id': 'none', 'sha256': '1' * 64, 'source_in_training_set': False}
BASIS = [{'kind': 'synthetic check'}]


def reject(call):
    try:
        call()
    except (ValueError, OSError):
        return
    raise AssertionError('Expected explicit rejection.')


def close(a, b, tolerance=1e-9):
    return abs(a - b) <= tolerance * max(1, abs(b))


def section(height=240, width=640, columns=(24, 600)):
    labels = np.zeros((height, width), np.uint8)
    for value, (top, bottom) in ((1, (24, 90)), (2, (90, 150)), (3, (150, 200))):
        labels[top:bottom, columns[0]:columns[1]] = value
    return labels


def parameters():
    return dict(json.loads(json.dumps(D.PARAMETERS)), pl_band_width_um=0.0)  # these checks predate the Purkinje band


def policy(**changes):
    return dict(json.loads(json.dumps(R.POLICY)), **changes)


class Case:
    """A synthetic draft on disk and proposals made from it."""

    def __init__(self, folder, name, labels, protocol):
        self.folder, self.name, self.protocol, self.count = folder, name, protocol, 0
        self.draft, path = D.write_section(folder / 'draft', name, labels, protocol, parameters(), SOURCE, MODEL)
        self.sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
        self.labels = D.clean_labels(labels, D.PARAMETERS['min_part_area_px'])[0]

    def rank(self, code, bounds=None):
        found = [i['rank'] for i in self.draft['review_queue'] if i['code'] == code and (bounds is None or i['bounds'] == bounds)]
        assert len(found) == 1, (code, bounds, self.draft['review_queue'])
        return found[0]

    def propose(self, verdicts=None, cuts=None, rules=None, labels=None, reference=None, extend=None, follow=None):
        self.count += 1
        section_ = {'verdicts': {str(k): v for k, v in (verdicts or {}).items()}, 'cuts': cuts or [], 'note': None}
        if extend is not None:
            section_['extend_to_reference'] = extend
        if follow is not None:
            section_['follow_reference'] = follow
        return R.write_proposal(self.folder / ('proposal-%d' % self.count), self.name, self.draft, self.sha256,
                                self.labels if labels is None else labels, section_, rules or policy(), self.protocol, BASIS, reference)

    def region(self, bounds):
        """Add an undecided region to the draft's queue; synthetic labels carry no model confidence to make one."""
        rank = max([i['rank'] for i in self.draft['review_queue']] + [0]) + 1
        self.draft['review_queue'].append({'rank': rank, 'tier': 3, 'code': 'low-confidence-region', 'bounds': bounds, 'detail': 'synthetic'})
        return rank


def state(record, rank):
    return next(row['state'] for row in record['review']['items'] if row['draft_rank'] == rank)


def codes(record):
    return [(item['tier'], item['code']) for item in record['review_queue']]


def check_rule():
    settings, rules = parameters(), policy()
    whole = {'ML_px': 500, 'GL_px': 500, 'WM_px': 500, 'ml_gl_border_px': 40}
    assert R.small_part_rule(5000.0, whole, rules, settings) == (False, [], False)
    assert R.small_part_rule(5000.0, dict(whole, WM_px=0), rules, settings) == (True, ['WM'], False)
    assert R.small_part_rule(5000.0, dict(whole, ml_gl_border_px=settings['pl_min_chain_px'] - 1), rules, settings) == (True, [], True)
    assert R.small_part_rule(rules['small_part_max_area_um2'], dict(whole, GL_px=0, ml_gl_border_px=0), rules, settings)[0] is True
    assert R.small_part_rule(rules['small_part_max_area_um2'] + 1, dict(whole, GL_px=0, ml_gl_border_px=0), rules, settings)[0] is False
    assert R.POLICY['status'] == 'proposed'


def check_cut():
    labels = section()
    labels[150:170, 150:200] = 2          # the granular layer reaches lower here
    labels[90:150, 250:300] = 1           # columns without granular layer
    cut = {'kind': 'below-layer-edge', 'layer': 'GL', 'window': [100, 0, 300, 240], 'level_side': 'none'}
    mask, detail = R.cut_below_layer_edge(labels, cut)
    assert detail == {'lowest_point': [150, 169]} and int(mask.sum()) == 50 * 50 + 30 * 50 + 50 * 100
    assert not mask[:, :100].any() and not mask[:, 300:].any() and not (mask & (labels == 2)).any()
    assert mask[150:200, 250:300].all()   # a column without the layer takes the limit of its neighbour
    left, _ = R.cut_below_layer_edge(labels, dict(cut, level_side='left'))
    assert int(left.sum()) == 30 * 100 + 50 * 100 and not left[150:170, 100:150].any()
    right, _ = R.cut_below_layer_edge(labels, dict(cut, level_side='right'))
    assert int(right.sum()) == 50 * 50 + 30 * 150
    reject(lambda: R.cut_below_layer_edge(labels, dict(cut, kind='freehand')))
    reject(lambda: R.cut_below_layer_edge(labels, dict(cut, window=[100, 0, 700, 240])))
    reject(lambda: R.cut_below_layer_edge(labels, dict(cut, window=[100, 0, 300, 80])))
    reject(lambda: R.cut_below_layer_edge(labels, dict(cut, layer='background')))


def check_border_path():
    labels = np.zeros((20, 20), np.uint8)
    labels[5:10, 5:10] = 1

    def lattice(path):
        for (ax, ay), (bx, by) in zip(path, path[1:]):
            assert abs(ax - bx) + abs(ay - by) == 1
            if ax == bx:
                y = min(ay, by)
                assert labels[y, ax - 1] != labels[y, ax]
            else:
                x = min(ax, bx)
                assert labels[ay - 1, x] != labels[ay, x]

    path = R.border_path(labels, [5, 5], [10, 10], 4, set(), None)
    assert path[0] == [5, 5] and path[-1] == [10, 10] and len(path) == 11
    lattice(path)
    assert R.border_path(labels, [5, 5], [10, 10], 4, set(), [['ML', 'GL']]) is None
    assert R.border_path(labels, [5, 5], [10, 10], 4, set(), [['ML', 'background']]) == path
    stride = labels.shape[1] + 1
    first = tuple(sorted((path[0][1] * stride + path[0][0], path[1][1] * stride + path[1][0])))
    other = R.border_path(labels, [5, 5], [10, 10], 4, {first}, None)
    assert other is not None and other != path and len(other) == 11 and other[1] != path[1]
    lattice(other)
    edges = set()
    for (ax, ay), (bx, by) in ((path[0], path[1]), (other[0], other[1])):
        edges.add(tuple(sorted((ay * stride + ax, by * stride + bx))))
    assert R.border_path(labels, [5, 5], [10, 10], 4, edges, None) is None
    # A border of the image edge is a border with nothing: it is followed too.
    edge = np.zeros((6, 6), np.uint8)
    edge[:3] = 1
    assert R.border_path(edge, [0, 3], [6, 3], 2, set(), None) == [[x, 3] for x in range(7)]


def check_tissue(folder, protocol):
    labels = np.zeros((400, 900), np.uint8)
    labels[:240, :640] = section()
    mini = np.repeat(np.array([1, 2, 3], np.uint8), 20)[:, None]
    labels[20:60, 660:700] = 1            # A: molecular layer only, no answer
    labels[100:140, 660:700] = 1          # B: the same, accepted by the reviewer
    labels[20:80, 720:780] = mini         # C: small but with all layers and a border, no answer
    labels[120:180, 720:780] = mini       # D: the same, judged not cerebellum
    labels[230:380, 700:850] = 1          # E: one layer only, larger than the cap, no answer
    labels[300:340, 100:140] = 1          # F: molecular layer only, marked to be fixed
    case = Case(folder, 'T-1', labels, protocol)
    assert np.array_equal(case.labels, labels)
    a, b, c = (case.rank('detached-part', bounds) for bounds in ([660, 20, 700, 60], [660, 100, 700, 140], [720, 20, 780, 80]))
    d, e, f = (case.rank('detached-part', bounds) for bounds in ([720, 120, 780, 180], [700, 230, 850, 380], [100, 300, 140, 340]))
    record, path, revised = case.propose({b: 'ok', d: 'not-cb', f: 'fix'})
    expected = labels.copy()
    for y0, y1, x0, x1 in ((20, 60, 660, 700), (120, 180, 720, 780), (300, 340, 100, 140)):
        expected[y0:y1, x0:x1] = 0
    assert np.array_equal(revised, expected)
    parts = {entry['draft_rank']: entry for entry in record['changes']['parts']}
    assert [parts[r]['action'] for r in (a, b, c, d, e, f)] == ['removed', 'kept', 'kept', 'removed', 'kept', 'removed']
    assert parts[a]['reason'] == 'proposed rule: small separate part without GL, WM' and parts[d]['reason'] == 'reviewer: not cerebellum'
    assert parts[b]['proposed_rule_says_remove'] and not parts[c]['proposed_rule_says_remove'] and not parts[e]['proposed_rule_says_remove']
    assert close(parts[a]['area_um2'], 1600 * UM2) and parts[c]['layers_px'] == {'ML_px': 1200, 'GL_px': 1200, 'WM_px': 1200, 'ml_gl_border_px': 60}
    assert record['changes']['rule_against_answers'] == {'agree': 0, 'rule_would_keep': 1, 'rule_would_remove_accepted_part': 1}
    assert [state(record, r) for r in (a, b, c, d, e, f)] == ['proposed', 'applied', 'open', 'applied', 'open', 'proposed']
    queue = codes(record)
    assert queue.count((2, 'part-removed-by-proposed-rule')) == 2 and queue.count((2, 'detached-part-kept')) == 2
    # The draft had joined the borders of C and D to the line; those two crossings have no answer.
    assert record['review']['items_by_state'] == {'proposed': 2, 'applied': 2, 'open': 4}
    assert case.draft['structure']['purkinje_line']['chains_joined'] == 3 and record['structure']['purkinje_line']['chains_in_line'] == 2
    removed = (1600 + 3600 + 1600) * UM2
    cb = record['comparison']['Cb']
    assert close(cb['draft_um2'] - cb['proposal_um2'], removed) and close(cb['proposal_um2'], int((expected > 0).sum()) * UM2)
    assert record['comparison']['PL_TOTAL']['proposal_um'] < record['comparison']['PL_TOTAL']['draft_um']

    # Without the proposed rule nothing is removed that no answer names.
    record, _, revised = case.propose({d: 'not-cb'}, rules=policy(small_part_max_area_um2=0.0))
    expected = labels.copy()
    expected[120:180, 720:780] = 0
    assert np.array_equal(revised, expected) and (2, 'part-removed-by-proposed-rule') not in codes(record)
    # A cap above every part removes the one-layer parts and still keeps the accepted one and the complete one.
    record, _, revised = case.propose({b: 'ok'}, rules=policy(small_part_max_area_um2=1e9))
    parts = {entry['draft_rank']: entry['action'] for entry in record['changes']['parts']}
    assert [parts[r] for r in (a, b, c, d, e, f)] == ['removed', 'kept', 'kept', 'kept', 'removed', 'removed']

    reject(lambda: case.propose({b: 'maybe'}))
    reject(lambda: case.propose({99: 'ok'}))
    wrong = labels.copy()
    wrong[0, 0] = 1
    reject(lambda: case.propose(labels=wrong))
    reject(lambda: R.write_proposal(folder / 'other', 'T-2', case.draft, case.sha256, labels, {}, policy(), protocol, BASIS))
    assert not (folder / 'other').exists()
    return case, {b: 'ok', d: 'not-cb', f: 'fix'}


def check_record(case, answers, protocol):
    first, path, _ = case.propose(answers)
    second, again, _ = case.propose(answers)
    names = sorted(p.name for p in path.parent.iterdir())
    assert names == ['T-1.proposal-measurement.csv', 'T-1.proposal-roi.zip', 'T-1.proposal.json']
    for name in names:
        assert (path.parent / name).read_bytes() == (again.parent / name).read_bytes(), name
    raw = path.read_bytes()
    assert json.loads(raw) == first and str(case.folder).encode() not in raw
    assert first['schema'] == R.PROPOSAL_SCHEMA and first['status'] == 'proposal' and first['approval']['approved'] is False
    assert first['based_on']['draft_record_sha256'] == case.sha256 and first['based_on']['draft_roi_sha256'] == case.draft['outputs']['roi']['sha256']
    assert first['engine']['policy'] == policy() and first['engine']['parameters'] == case.draft['engine']['parameters']
    assert set(first['engine']['code_sha256']) == {'roi_draft.py', 'roi_measure.py', 'nissl_lab.py', 'native_tiff.py', 'roi_revise.py'}
    assert first['review']['basis'] == BASIS and first['review']['answers'] == {str(k): v for k, v in sorted(answers.items())}
    assert first['labels']['draft_sha256'] == case.draft['labels']['draft_sha256'] != first['labels']['proposal_sha256']
    assert len(first['review']['items']) == len(case.draft['review_queue'])
    assert [item['rank'] for item in first['review_queue']] == list(range(1, len(first['review_queue']) + 1))
    rois, digest = read_roi_zip(path.parent / first['outputs']['roi']['file'])
    assert digest == first['outputs']['roi']['sha256'] and [r['name'] for r in rois] == D.ROI_ORDER
    table = M.read_table(path.parent / first['outputs']['table']['file'])
    assert all(row['Sample'] == 'T-1' for row in table) and M.compare(M.measure(rois, protocol), table, protocol)['pass']
    reject(lambda: R.write_proposal(path.parent, 'T-1', case.draft, case.sha256, case.labels, {}, policy(), protocol, BASIS))


def check_line(folder, protocol):
    # A tear of 100 px (71 um): the draft crosses it in a straight line and asks.
    labels = section()
    labels[80:100, 300:400] = 0
    (folder / 'bridge').mkdir()
    case = Case(folder / 'bridge', 'L-1', labels, protocol)
    bridge = case.rank('pl-bridge')
    record, path, _ = case.propose({bridge: 'fix'})
    pl = record['structure']['purkinje_line']
    assert len(pl['joins']) == 1 and pl['joins'][0]['treatment'] == 'border' and pl['joins'][0]['borders'] == 'preferred'
    assert close(pl['joins'][0]['gap_um'], 100 / PPM) and close(pl['joins'][0]['path_um'], 120 / PPM)
    assert close(pl['length_um'], 596 / PPM) and close(pl['length_without_jumps_um'], 596 / PPM)
    assert pl['length_parts_um'] == {'ml_gl_border': 476 / PPM, 'border_connectors': 120 / PPM, 'straight_bridges': 0.0, 'jumps': 0.0}
    line = next(r for r in read_roi_zip(path.parent / record['outputs']['roi']['file'])[0] if r['name'] == 'PL_TOTAL')
    assert line['paths'] == [[[24, 90], [300, 90], [300, 100], [400, 100], [400, 90], [600, 90]]]
    assert close(record['comparison']['PL_TOTAL']['proposal_um'], 596 / PPM) and close(record['comparison']['PL_TOTAL']['draft_um'], 576 / PPM)
    assert state(record, bridge) == 'applied' and codes(record) == [(2, 'pl-connector-along-border')]
    assert record['comparison']['Cb']['draft_um2'] == record['comparison']['Cb']['proposal_um2']

    record, _, _ = case.propose({bridge: 'ok'})
    pl = record['structure']['purkinje_line']
    assert pl['joins'][0]['treatment'] == 'straight' and close(pl['length_um'], 576 / PPM) and codes(record) == []
    assert state(record, bridge) == 'applied' and close(pl['length_parts_um']['straight_bridges'], 100 / PPM)
    record, _, _ = case.propose()
    assert record['structure']['purkinje_line']['joins'][0]['treatment'] == 'straight' and state(record, bridge) == 'open'

    # With the ML to GL border as the only preferred border the hole's edge is used, and recorded as such.
    record, _, _ = case.propose({bridge: 'fix'}, rules=policy(connector_borders=[['ML', 'GL']]))
    join = record['structure']['purkinje_line']['joins'][0]
    assert join['treatment'] == 'border' and join['borders'] == 'any' and close(join['path_um'], 120 / PPM)
    record, _, _ = case.propose({bridge: 'fix'}, rules=policy(connector_borders=[['ML', 'GL']], connector_fallback='none'))
    join = record['structure']['purkinje_line']['joins'][0]
    assert join['treatment'] == 'straight-unresolved' and 'borders' not in join and state(record, bridge) == 'unresolved'
    assert (1, 'pl-connector-not-found') in codes(record) and (1, 'answer-not-applied') in codes(record)
    assert close(record['structure']['purkinje_line']['length_um'], 576 / PPM)

    # A tear of 300 px (214 um): the draft leaves the far border out and asks.
    labels = section()
    labels[80:100, 200:500] = 0
    (folder / 'far').mkdir()
    case = Case(folder / 'far', 'L-2', labels, protocol)
    chain, share = case.rank('pl-chain-left-out', [500, 90, 600, 90]), case.rank('pl-border-left-out')
    record, _, _ = case.propose({chain: 'fix', share: 'fix'})
    pl = record['structure']['purkinje_line']
    assert pl['chains_in_line'] == 2 and pl['chains_by_drafted_rule'] == 1 and pl['chains_left_out'] == []
    assert [c['draft_ranks'] for c in pl['chains_added_by_review']] == [[chain]] and close(pl['chains_added_by_review'][0]['edge_length_um'], 100 / PPM)
    assert pl['joins'][0]['treatment'] == 'jump' and close(pl['joins'][0]['gap_um'], 300 / PPM)
    assert close(pl['length_um'], 576 / PPM) and close(pl['length_without_jumps_um'], 276 / PPM)
    assert close(record['comparison']['PL_TOTAL']['draft_um'], 176 / PPM)
    assert close(record['comparison']['PL_TOTAL']['proposal_without_jumps_um'], 276 / PPM)
    assert state(record, chain) == 'applied' and codes(record) == [(2, 'pl-border-added'), (2, 'pl-jump')]
    record, _, _ = case.propose()
    pl = record['structure']['purkinje_line']
    assert pl['chains_in_line'] == 1 and close(pl['length_um'], 176 / PPM) and pl['chains_added_by_review'] == []
    assert codes(record) == [(2, 'pl-chain-left-out')] and state(record, chain) == 'open'

    # The border the reviewer asked for lies in tissue another answer takes out: the two answers disagree.
    labels = np.zeros((240, 1100), np.uint8)
    labels[:, :640] = section()
    labels[24:200, 900:1060] = section()[24:200, 24:184]
    (folder / 'conflict').mkdir()
    case = Case(folder / 'conflict', 'L-3', labels, protocol)
    part, chain = case.rank('detached-part', [900, 24, 1060, 200]), case.rank('pl-chain-left-out', [900, 90, 1060, 90])
    record, _, revised = case.propose({part: 'not-cb', chain: 'fix'})
    assert not revised[:, 640:].any() and state(record, part) == 'applied' and state(record, chain) == 'superseded'
    assert codes(record) == [(1, 'answers-disagree')] and close(record['structure']['purkinje_line']['length_um'], 576 / PPM)
    record, _, _ = case.propose({chain: 'fix'})
    pl = record['structure']['purkinje_line']
    assert state(record, chain) == 'applied' and pl['joins'][0]['treatment'] == 'jump' and close(pl['length_without_jumps_um'], 736 / PPM)


def check_cut_in_proposal(folder, protocol):
    labels = section(columns=(0, 600))
    case = Case(folder, 'C-1', labels, protocol)
    edge = case.rank('main-part-at-image-border')
    cut = {'kind': 'below-layer-edge', 'layer': 'GL', 'window': [100, 0, 300, 240], 'level_side': 'none', 'status': 'proposed'}
    record, _, revised = case.propose({edge: 'fix'}, cuts=[cut])
    assert not revised[150:, 100:300].any() and np.array_equal(revised[:150], labels[:150])
    assert record['changes']['cuts'][0]['removed_bounds'] == [100, 150, 300, 200] and close(record['changes']['cuts'][0]['removed_um2'], 10000 * UM2)
    assert close(record['comparison']['WM']['draft_um2'] - record['comparison']['WM']['proposal_um2'], 10000 * UM2)
    assert record['comparison']['GL_TOTAL']['draft_um2'] == record['comparison']['GL_TOTAL']['proposal_um2']
    assert state(record, edge) == 'proposed' and codes(record) == [(1, 'cut-to-confirm')] and record['review']['cuts'] == [cut]
    record, _, _ = case.propose({edge: 'fix'})
    assert state(record, edge) == 'unresolved' and (1, 'answer-not-applied') in codes(record) and (1, 'main-part-at-image-border') in codes(record)


def box(name, x0, y0, x1, y1):
    return {'name': name, 'kind': 'polygon', 'paths': [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]}


def reference_rois():
    """A human reading that differs from section(): tissue ends at column 560, WM starts at row 140 and ends at 220."""
    return [box('Cb', 24, 24, 560, 220), box('ML_TOTAL', 24, 24, 560, 90), box('GL_TOTAL', 24, 90, 560, 140), box('WM', 24, 140, 560, 220)]


def check_reference_map():
    rois = reference_rois()
    ref, counted = R.reference_map(rois, 240, 640)
    assert ref[24:90, 24:560].min() == ref[24:90, 24:560].max() == 1 and (ref[90:140, 24:560] == 2).all() and (ref[140:220, 24:560] == 3).all()
    assert not ref[:, 560:].any() and not ref[220:].any() and counted['outside_cb_px'] == 240 * 640 - 536 * 196
    assert counted['layer_px'] == {'ML': 536 * 66, 'GL': 536 * 50, 'WM': 536 * 80} and counted['layers_overlapping_px'] == 0
    rois[1], rois[2] = box('ML_TOTAL', 24, 24, 560, 85), box('GL_TOTAL', 24, 80, 600, 140)
    ref, counted = R.reference_map(rois, 240, 640)
    assert (ref[80:85, 24:560] == R.REF_CONFLICT).all() and counted['layers_overlapping_px'] == 536 * 5
    assert (ref[90:140, 560:600] == 2).all() and counted['layer_outside_cb_px'] == 40 * 60       # a layer outside Cb still counts as that layer
    rois[1] = box('ML_TOTAL', 24, 24, 560, 70)
    ref, counted = R.reference_map(rois, 240, 640)
    assert (ref[70:80, 24:560] == R.REF_INSIDE).all() and counted['inside_cb_without_layer_px'] == 536 * 10
    reject(lambda: R.reference_map(rois[:3], 240, 640))
    reject(lambda: R.reference_map(rois + [box('WM', 0, 0, 5, 5)], 240, 640))
    mask, _ = R.cut_outside_reference(section(), {'kind': 'outside-reference-cb', 'window': [500, 150, 640, 240]}, R.reference_map(reference_rois(), 240, 640)[0])
    assert int(mask.sum()) == 40 * 50 and mask[150:200, 560:600].all()
    reject(lambda: R.cut_outside_reference(section(), {'kind': 'outside-reference-cb', 'window': [500, 150, 640, 240]}, None))
    reject(lambda: R.cut_outside_reference(section(), {'kind': 'outside-reference-cb', 'window': [500, 150, 700, 240]}, mask))


def check_reference_in_proposal(folder, protocol):
    labels = section()
    case = Case(folder, 'F-1', labels, protocol)
    fix, outside, same, inside = (case.region(b) for b in ([100, 130, 200, 210], [540, 60, 600, 120], [100, 40, 150, 80], [300, 40, 340, 80]))
    answers = {fix: 'fix', outside: 'not-cb', same: 'fix', inside: 'not-cb'}
    reference = {'file': 'F-1_ROIs.zip', 'sha256': '2' * 64, 'rois': reference_rois()}
    # Without a reference the answers stay open questions, as before.
    record, _, revised = case.propose(answers)
    assert np.array_equal(revised, labels) and record['reference'] is None and all(state(record, r) == 'unresolved' for r in answers)
    assert record['changes']['reference'] == {'regions': [], 'extended': []}
    record, _, revised = case.propose(answers, reference=reference)
    expected = labels.copy()
    expected[140:150, 100:200], expected[200:210, 100:200] = 3, 3
    expected[60:120, 560:600] = 0
    assert np.array_equal(revised, expected)
    regions = {e['draft_rank']: e for e in record['changes']['reference']['regions']}
    assert regions[fix]['changed'] == {'GL>WM': 1000, 'background>WM': 1000} and close(regions[fix]['changed_um2'], 2000 * UM2)
    assert regions[outside]['changed'] == {'ML>background': 30 * 40, 'GL>background': 30 * 40} and regions[outside]['tissue_inside_reference_cb_px'] == 20 * 60
    assert regions[same]['changed_px'] == regions[inside]['changed_px'] == 0
    assert [state(record, r) for r in (fix, outside, same, inside)] == ['proposed', 'proposed', 'unresolved', 'unresolved']
    assert codes(record).count((2, 'label-from-reference')) == 2 and codes(record).count((1, 'answer-not-applied')) == 2
    assert record['reference']['sha256'] == '2' * 64 and record['reference']['file'] == 'F-1_ROIs.zip' and 'no measure of the model' in record['reference']['statement']
    assert record['approval']['approved'] is False and record['engine']['version'] == R.ENGINE['version']
    assert close(record['comparison']['WM']['proposal_um2'] - record['comparison']['WM']['draft_um2'], 2000 * UM2)
    # A cut along the human Cb outline and a layer widened to the human outline.
    cut = {'kind': 'outside-reference-cb', 'window': [500, 150, 640, 240], 'status': 'proposed'}
    record, _, revised = case.propose(answers, cuts=[cut], reference=reference, extend=['WM'])
    expected[140:150, 24:560], expected[200:220, 24:560] = 3, 3
    expected[150:200, 560:600] = 0
    assert np.array_equal(revised, expected)
    widened = record['changes']['reference']['extended']
    assert len(widened) == 1 and widened[0]['taken_from'] == {'GL>WM': 536 * 10 - 1000, 'background>WM': 536 * 20 - 1000}
    assert widened[0]['bounds'] == [24, 140, 560, 220] and record['review']['extend_to_reference'] == ['WM']
    assert record['changes']['cuts'][0]['removed_bounds'] == [560, 150, 600, 200] and close(record['changes']['cuts'][0]['removed_um2'], 2000 * UM2)
    assert (1, 'cut-to-confirm') in codes(record) and (1, 'layer-widened-to-reference') in codes(record)
    assert any('outside the human Cb outline' in i['detail'] for i in record['review_queue'] if i['code'] == 'cut-to-confirm')
    again, _, twice = case.propose(answers, cuts=[cut], reference=reference, extend=['WM'])
    assert np.array_equal(twice, revised) and again['outputs'] == record['outputs']
    # A region answered not-cb that lies wholly outside the human outline is applied in full.
    gone = case.region([570, 30, 600, 50])
    record, _, revised = case.propose({gone: 'not-cb'}, reference=reference)
    assert state(record, gone) == 'applied' and not revised[30:50, 570:600].any()
    reject(lambda: case.propose(answers, cuts=[cut]))
    reject(lambda: case.propose(answers, extend=['WM']))
    reject(lambda: case.propose(answers, reference=reference, extend=['PL']))
    reject(lambda: case.propose(answers, reference=reference, extend=['WM', 'WM']))
    reject(lambda: case.propose(answers, reference=dict(reference, rois=reference_rois()[1:])))


def check_follow_reference(folder, protocol):
    """A section that follows the human ROI file: its labels win over every answer, and its PL_TOTAL is used unchanged."""
    labels = section()
    labels[60:70, 300:320] = 2                      # a GL island inside ML that the human file does not have
    labels[100:112, 400:440] = 0                    # a hole the human file fills with GL
    case = Case(folder, 'G-1', labels, protocol)
    kept = case.region([100, 40, 150, 80])
    line = {'name': 'PL_TOTAL', 'kind': 'polyline', 'paths': [[[24, 90], [300, 92], [560, 90]]]}
    human = [box('Cb', 24, 24, 560, 220), box('ML_TOTAL', 24, 24, 560, 88), box('GL_TOTAL', 24, 92, 560, 140), box('WM', 24, 140, 560, 220)]
    for roi in human:
        roi['kind'] = 'area'
    reference = {'file': 'G-1_ROIs.zip', 'sha256': '3' * 64, 'rois': human + [line]}
    first_reference = reference
    record, _, revised = case.propose({kept: 'not-cb'}, reference=reference, follow=True)
    ref, _ = R.reference_map(human, 240, 640)
    decided = ref <= 3
    assert np.array_equal(revised[decided], ref[decided]), 'A pixel the human file decides does not have its label'
    assert not revised[:, 560:].any() and not revised[200:220, :24].any() and (revised[200:220, 24:560] == 3).all()
    assert (revised[60:70, 300:320] == 1).all() and (revised[100:112, 400:440] == 2).all()
    # The band between the human ML and GL is undecided: it keeps the draft's labels.
    assert np.array_equal(revised[88:92, 24:560], case.labels[88:92, 24:560]) and (ref[88:92, 24:560] == R.REF_INSIDE).all()
    log = record['changes']['reference']['section']
    assert log['changed_from_draft_px'] == int((decided & (case.labels != ref)).sum()) and log['reference_undecided_px'] == 4 * 536
    assert log['draft_label_kept_px'] == {'background': 0, 'ML': 2 * 536, 'GL': 2 * 536, 'WM': 0}
    assert log['regions_changed_from_draft'] >= 2 and len(log['largest_regions']) == min(log['regions_changed_from_draft'], R.FOLLOW_REGIONS_LISTED)
    assert all('label' not in e for e in log['largest_regions']) and log['largest_regions'][0]['area_um2'] >= log['largest_regions'][-1]['area_um2']
    listed = sum(e['area_um2'] for e in log['largest_regions']) + log['other_regions_um2']
    assert close(listed, log['changed_from_draft_um2'])
    written = {r['name']: r for r in read_roi_zip(folder / ('proposal-%d' % case.count) / 'G-1.proposal-roi.zip')[0]}
    assert written['PL_TOTAL']['kind'] == 'polyline' and written['PL_TOTAL']['paths'] == line['paths']
    assert record['structure']['purkinje_line']['source'] == 'reference' and record['comparison']['PL_TOTAL']['proposal_without_jumps_um'] is None
    assert close(record['comparison']['PL_TOTAL']['proposal_um'], (np.hypot(276, 2) + np.hypot(260, 2)) / PPM)
    assert record['reference']['followed_for_whole_section'] is True and 'says nothing about the model' in record['reference']['follow_statement']
    assert record['review']['follow_reference'] is True and record['approval']['approved'] is False and record['status'] == 'proposal'
    assert all(row['state'] == 'superseded' for row in record['review']['items'])
    found = codes(record)
    assert found[:3] == [(1, 'section-follows-reference'), (1, 'pl-from-reference'), (1, 'draft-label-kept-where-reference-undecided')]
    assert found.count((2, 'changed-to-reference')) == len(log['largest_regions']) and not any(c.startswith('pl-') and c != 'pl-from-reference' for _, c in found)
    assert [i['rank'] for i in record['review_queue']] == list(range(1, len(found) + 1))
    again, _, twice = case.propose({kept: 'not-cb'}, reference=reference, follow=True)
    assert np.array_equal(twice, revised) and again['outputs'] == record['outputs'] and again['review_queue'] == record['review_queue']
    # An area band as the human PL_TOTAL is passed on as an area, which has no length.
    band = {'name': 'PL_TOTAL', 'kind': 'area', 'paths': [[[24, 88], [560, 88], [560, 92], [24, 92]]]}
    record, _, _ = case.propose({}, reference=dict(reference, rois=human + [band]), follow=True)
    assert record['measurement']['values']['pl_total_geometry'] == 'area' and record['comparison']['PL_TOTAL']['proposal_um'] is None
    assert any(i['code'] == 'pl-from-reference' and 'no length' in i['detail'] for i in record['review_queue'])
    # More changed places than the queue lists one by one are summed in one item, never dropped silently.
    wide = D.PARAMETERS['min_part_area_px'] // 40 + 2
    many = section(width=80 + (wide + 8) * (R.FOLLOW_REGIONS_LISTED + 3), columns=(24, 60 + (wide + 8) * (R.FOLLOW_REGIONS_LISTED + 3)))
    for k in range(R.FOLLOW_REGIONS_LISTED + 3):
        many[36:76, 40 + (wide + 8) * k:40 + (wide + 8) * k + wide] = 3
    full = many.shape[1]
    reference = {'file': 'G-2_ROIs.zip', 'sha256': '4' * 64, 'rois': [dict(box(n, 24, a, full - 20, b), kind='area') for n, a, b in (
        ('Cb', 24, 200), ('ML_TOTAL', 24, 90), ('GL_TOTAL', 90, 150), ('WM', 150, 200))] + [{'name': 'PL_TOTAL', 'kind': 'polyline', 'paths': [[[24, 90], [full - 20, 90]]]}]}
    (folder / 'crowded').mkdir()
    crowded = Case(folder / 'crowded', 'G-2', many, protocol)
    record, _, _ = crowded.propose({}, reference=reference, follow=True)
    assert np.array_equal(crowded.labels, many), 'the synthetic blocks must survive the draft cleanup'
    log = record['changes']['reference']['section']
    assert log['regions_changed_from_draft'] > R.FOLLOW_REGIONS_LISTED and log['other_regions_um2'] > 0
    assert (2, 'changed-to-reference-not-listed') in codes(record)
    reference = first_reference
    # Without follow_reference nothing of this happens; without a file, or with no or two PL_TOTAL, it is refused.
    record, _, revised = case.propose({}, reference=reference)
    assert np.array_equal(revised, case.labels) and 'section' not in record['changes']['reference'] and record['review']['follow_reference'] is False
    reject(lambda: case.propose({}, follow=True))
    reject(lambda: case.propose({}, reference=dict(reference, rois=human), follow=True))
    reject(lambda: case.propose({}, reference=dict(reference, rois=human + [line, line]), follow=True))
    reject(lambda: case.propose({}, reference=reference, follow='yes'))


def run(arguments):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = R.main(arguments)
    return code, out.getvalue(), err.getvalue()


def check_command(folder):
    """End to end from a TIFF with the synthetic random-weight fixture; needs PyTorch."""
    try:
        import torch  # noqa: F401
    except ImportError:
        return False
    import tifffile
    fixture = json.loads((ROOT / 'qa' / 'fixtures' / 'unet-synthetic.json').read_text(encoding='utf-8'))
    native = fixture['native']
    pixels = np.frombuffer(base64.b64decode(native['image']), np.uint8).reshape(native['height'], native['width'], 3)
    bundle = folder / 'bundle.json'
    bundle.write_text(json.dumps(fixture['model']), encoding='utf-8')
    image = folder / 'synthetic' / 'Montage.tif'
    image.parent.mkdir()
    tifffile.imwrite(image, pixels, metadata=None)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        assert D.main(['--model', str(bundle), '--section', 'SYN-1=' + str(image), '--output', str(folder / 'draft')]) == 0
    index = folder / 'draft' / 'draft-index.json'
    draft = json.loads((folder / 'draft' / 'SYN-1' / 'SYN-1.draft.json').read_text())
    answers = {str(item['rank']): 'unsure' for item in draft['review_queue']}
    instructions = folder / 'instructions.json'
    document = {'schema': R.INSTRUCTION_SCHEMA, 'draft_index_sha256': hashlib.sha256(index.read_bytes()).hexdigest(), 'basis': BASIS,
                'policy': {'status': 'proposed'}, 'sections': {'SYN-1': {'verdicts': answers, 'note': None, 'cuts': []}}}
    instructions.write_text(json.dumps(document), encoding='utf-8')
    common = ['--draft', str(folder / 'draft'), '--model', str(bundle), '--section', 'SYN-1=' + str(image)]
    trees = []
    for name in ('run-1', 'run-2'):
        code, out, err = run(common + ['--instructions', str(instructions), '--output', str(folder / name)])
        assert code == 0, err
        trees.append({str(p.relative_to(folder / name)): p.read_bytes() for p in sorted((folder / name).rglob('*')) if p.is_file()})
    assert trees[0] == trees[1] and sorted(trees[0]) == ['SYN-1/SYN-1.proposal-measurement.csv', 'SYN-1/SYN-1.proposal-roi.zip',
                                                           'SYN-1/SYN-1.proposal.json', 'proposal-index.json', 'revision-instructions.json']
    result = json.loads(trees[0]['proposal-index.json'])
    assert result['status'] == 'proposal' and result['approval']['approved'] is False and result['policy'] == policy()
    assert result['sections'][0]['record_sha256'] == hashlib.sha256(trees[0]['SYN-1/SYN-1.proposal.json']).hexdigest()
    assert trees[0]['revision-instructions.json'] == instructions.read_bytes() and str(folder).encode() not in trees[0]['proposal-index.json']
    before = {str(p.relative_to(folder / 'draft')): p.read_bytes() for p in sorted((folder / 'draft').rglob('*')) if p.is_file()}
    # The draft's own ROI file as the reference: the command reads it, records its hash and leaves the layers as they are.
    human = folder / 'human' / 'SYN-1_ROIs.zip'
    human.parent.mkdir()
    wide, high = native['width'], native['height']
    human.write_bytes(D.roi_zip_bytes([dict(box(name, 1, top, wide - 1, bottom), kind='area') for name, top, bottom in (
        ('Cb', 1, high - 1), ('ML_TOTAL', 1, high // 3), ('GL_TOTAL', high // 3, 2 * high // 3), ('WM', 2 * high // 3, high - 1))]))
    widen = folder / 'widen.json'
    widen.write_text(json.dumps(dict(document, sections={'SYN-1': {'verdicts': answers, 'note': None, 'cuts': [], 'extend_to_reference': ['WM']}})), encoding='utf-8')
    code, out, err = run(common + ['--instructions', str(widen), '--reference', 'SYN-1=' + str(human), '--output', str(folder / 'run-3')])
    assert code == 0, err
    with_reference = json.loads((folder / 'run-3' / 'SYN-1' / 'SYN-1.proposal.json').read_text())
    assert with_reference['reference']['sha256'] == hashlib.sha256(human.read_bytes()).hexdigest() and with_reference['reference']['file'] == human.name
    assert json.loads((folder / 'run-3' / 'proposal-index.json').read_text())['sections'][0]['reference_sha256'] == with_reference['reference']['sha256']
    assert str(folder) not in json.dumps(with_reference) and with_reference['changes']['reference']['extended'][0]['layer'] == 'WM'
    assert with_reference['reference']['pixels']['layer_px']['WM'] == (wide - 2) * (high - 1 - 2 * high // 3)
    # A section that follows the human file: the command copies the stored bytes of the human PL_TOTAL into the proposal.
    import zipfile
    followed = folder / 'human-with-line' / 'SYN-1_ROIs.zip'
    followed.parent.mkdir()
    areas = [dict(box(name, 1, top, wide - 1, bottom), kind='area') for name, top, bottom in (
        ('Cb', 1, high - 1), ('ML_TOTAL', 1, high // 3), ('GL_TOTAL', high // 3, 2 * high // 3), ('WM', 2 * high // 3, high - 1))]
    followed.write_bytes(D.roi_zip_bytes(areas + [{'name': 'PL_TOTAL', 'kind': 'polyline', 'paths': [[[1, high // 3], [wide // 2, high // 3 + 1], [wide - 1, high // 3]]]}]))
    follow = folder / 'follow.json'
    follow.write_text(json.dumps(dict(document, sections={'SYN-1': {'verdicts': answers, 'note': None, 'cuts': [], 'follow_reference': True}})), encoding='utf-8')
    code, out, err = run(common + ['--instructions', str(follow), '--reference', 'SYN-1=' + str(followed), '--output', str(folder / 'run-4')])
    assert code == 0, err
    record = json.loads((folder / 'run-4' / 'SYN-1' / 'SYN-1.proposal.json').read_text())
    with zipfile.ZipFile(followed) as source, zipfile.ZipFile(folder / 'run-4' / 'SYN-1' / 'SYN-1.proposal-roi.zip') as written:
        copied = written.read('PL_TOTAL.roi')
        assert copied == source.read('PL_TOTAL.roi') and record['structure']['purkinje_line']['copied_bytes_sha256'] == hashlib.sha256(copied).hexdigest()
    assert record['review']['follow_reference'] is True and record['approval']['approved'] is False and str(folder) not in json.dumps(record)
    assert record['review_queue'][0]['code'] == 'section-follows-reference' and record['reference']['followed_for_whole_section'] is True

    def refused(arguments, output):
        code, out, err = run(arguments + ['--output', str(output)])
        assert code == 2 and err.startswith('Not revised: ') and out == '', (code, err)

    refused(common + ['--instructions', str(instructions)], folder / 'run-1')
    refused(common + ['--instructions', str(widen)], folder / 'no-4')
    refused(common + ['--instructions', str(follow)], folder / 'no-4')
    refused(common + ['--instructions', str(follow), '--reference', 'SYN-1=' + str(human)], folder / 'no-4')
    refused(common + ['--instructions', str(widen), '--reference', 'OTHER=' + str(human)], folder / 'no-4')
    refused(common + ['--instructions', str(widen), '--reference', 'SYN-1=' + str(human)], human.parent / 'proposal')
    assert not (folder / 'no-4').exists() and not (human.parent / 'proposal').exists()
    refused(common + ['--instructions', str(instructions)], folder / 'draft' / 'inside')
    refused(common + ['--instructions', str(instructions)], image.parent / 'proposal')
    refused(['--draft', str(folder / 'draft'), '--model', str(bundle), '--section', 'OTHER=' + str(image), '--instructions', str(instructions)], folder / 'no-1')
    for change in ({'draft_index_sha256': '0' * 64}, {'policy': {'status': 'approved'}}, {'policy': {'unknown': 1}},
                   {'sections': {'OTHER': {}}}, {'sections': {'SYN-1': {'verdicts': {'999': 'ok'}}}}, {'sections': {'SYN-1': {'answers': {}}}}):
        other = folder / 'other.json'
        other.write_text(json.dumps(dict(document, **change)), encoding='utf-8')
        refused(common + ['--instructions', str(other)], folder / 'no-2')
        assert not (folder / 'no-2').exists()
    changed = folder / 'changed' / 'Montage.tif'
    changed.parent.mkdir()
    other_pixels = pixels.copy()
    other_pixels[0, 0, 0] ^= 1
    tifffile.imwrite(changed, other_pixels, metadata=None)
    refused(['--draft', str(folder / 'draft'), '--model', str(bundle), '--section', 'SYN-1=' + str(changed), '--instructions', str(instructions)], folder / 'no-3')
    assert not (folder / 'no-3').exists() and not (folder / 'no-1').exists()
    after = {str(p.relative_to(folder / 'draft')): p.read_bytes() for p in sorted((folder / 'draft').rglob('*')) if p.is_file()}
    assert before == after
    return True


def main():
    protocol = M.load_protocol()
    assert protocol['calibration']['pixels_per_micron'] == PPM
    check_rule()
    check_cut()
    check_border_path()
    check_reference_map()
    with tempfile.TemporaryDirectory() as temporary:
        folder = Path(temporary).resolve()
        for name in ('tissue', 'line', 'cut', 'reference', 'follow', 'command'):
            (folder / name).mkdir()
        case, answers = check_tissue(folder / 'tissue', protocol)
        check_record(case, answers, protocol)
        check_line(folder / 'line', protocol)
        check_cut_in_proposal(folder / 'cut', protocol)
        check_reference_in_proposal(folder / 'reference', protocol)
        check_follow_reference(folder / 'follow', protocol)
        with_model = check_command(folder / 'command')
    print('ROI revision checks passed on synthetic labels' + (', including the command on the synthetic fixture.' if with_model
          else '. The command was not checked end to end: PyTorch is not installed here.'))


if __name__ == '__main__':
    main()
