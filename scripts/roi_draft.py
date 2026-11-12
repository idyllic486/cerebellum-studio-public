#!/usr/bin/env python3
"""Draft ROI set, measurement table and review queue from a montage.

The layer model labels the original image. The labels are written as original-coordinate ImageJ
ROIs under the protocol's total names, measured by roi_measure, and the places a person should
look at first are listed. Every numeric rule here is an engine proposal recorded in the draft,
not an approved criterion, and a draft is never an approved ROI. The same image, model, protocol,
code and software give the same files byte for byte.
"""
import argparse
import base64
import hashlib
import io
import json
import math
import platform
import re
import struct
import sys
import zipfile
import zlib
from pathlib import Path

import numpy as np
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from native_tiff import NativeTiff  # noqa: E402
from nissl_lab import file_digest, read_roi_zip, require  # noqa: E402
import roi_measure  # noqa: E402

ENGINE = {'name': 'roi_draft', 'version': '0.2.0'}
DRAFT_SCHEMA = 'cerebellum-roi-draft/1'
INDEX_SCHEMA = 'cerebellum-roi-draft-index/1'
BUNDLE_SCHEMA = 'cerebellum-auto-roi-unet/1'
CLASSES = ['background', 'ML', 'GL', 'WM']
TENSOR_NAME = re.compile(r'(?:[du]\.[0-4]\.[0134]\.(?:weight|bias)|o\.(?:weight|bias))')
SAMPLE_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}')
MAX_BUNDLE_BYTES = 64 * 1024 ** 2
MAX_PROBABILITY_BYTES = 4 * 1024 ** 3
MAX_IMAGE_SIDE = 60000
ROI_ORDER = ['Cb', 'PL_TOTAL', 'ML_TOTAL', 'GL_TOTAL', 'WM', 'GL+WM']
AREA_CLASSES = {'Cb': (1, 2, 3), 'ML_TOTAL': (1,), 'GL_TOTAL': (2,), 'WM': (3,), 'GL+WM': (2, 3)}
# Engine proposals. They shape the draft and are written into every draft record; none is a criterion
# the researcher has approved, and changing one changes the engine identity of the result.
PARAMETERS = {
    'status': 'proposed',
    'min_part_area_px': 1024,
    'pl_simplify_tolerance_px': 4.0,
    'pl_min_chain_px': 16,
    'pl_max_bridge_um': 200.0,
    'pl_sensitivity_tolerances_px': [2.0, 4.0, 8.0],
    'pl_bridge_review_above_um': 50.0,
    'pl_omitted_share_review_above': 0.05,
    'confidence_margin_below': 0.5,
    'confidence_region_min_cells': 16,
    'queue_region_limit': 20,
    # Researcher decision of 2026-11-11, not a proposal: the band between ML and GL is the Purkinje layer, it is 20 um wide
    # and it opens from the model's ML to GL border toward ML, where the Purkinje cell bodies lie.
    'pl_band_width_um': 20.0,
    'pl_band_side': 'ML',
}
NOT_DRAFTED = ['Lobule ROIs (<tissue>_<lobule>_part<N>): the model has no lobule or fissure classes.',
               'Fissure landmarks (FISSURE_<label>).']
LIMITS = ['The model assigns every tissue pixel to ML, GL or WM. The Purkinje layer band is not seen by the model: it is the strip of '
          'model ML within a fixed width of GL, taken out of ML_TOTAL and left without a layer ROI, as in the human ROI files. '
          'Its width is a fixed rule, not a measurement of the cells in this image.',
          'Cb is the union of the three layer drafts. Tissue the model labels outside the cerebellum is inside it '
          'until a person removes it; detached parts are listed in the review queue.',
          'PL_TOTAL is a line along the ML to GL border of the draft. In lateral sections the reference used an '
          'area band in places, and which is right there is an open protocol decision.',
          'Model probabilities are not calibrated. Confidence values order the review; they are not error rates.',
          'The model reads the image in cells of several pixels. A strip narrower than one cell at the right and '
          'bottom image edge is not labelled and is outside every draft ROI.']


# ---------------------------------------------------------------- model

def load_bundle(path):
    """Read the model bundle. Its hash identifies the weights that produced a draft."""
    path = Path(path)
    require(path.is_file() and path.stat().st_size <= MAX_BUNDLE_BYTES, 'Model bundle missing or too large.')
    raw = path.read_bytes()
    bundle = json.loads(raw.decode('utf-8'))
    require(isinstance(bundle, dict) and bundle.get('schema') == BUNDLE_SCHEMA, 'Unknown model bundle schema.')
    arch, inference = bundle.get('architecture', {}), bundle.get('inference', {})
    require(arch.get('name') == 'unet-groupnorm/1' and arch.get('depth') == 5 and arch.get('classes') == CLASSES,
            'Model architecture or class list is not the layer U-Net this engine reads.')
    base, groups = arch.get('base_channels'), arch.get('group_norm_groups')
    factor = bundle.get('input', {}).get('block_mean_factor')
    tile, keep = inference.get('tile'), inference.get('keep')
    require(all(type(v) is int for v in (base, groups, factor, tile, keep)) and 1 <= base <= 64 and groups >= 1
            and base % groups == 0 and 1 <= factor <= 64 and 16 <= keep <= tile <= 4096 and (tile - keep) % 2 == 0,
            'Model bundle settings are out of range.')
    require(inference.get('upsample') == 'bilinear-probabilities', 'Unknown upsampling rule in the model bundle.')
    tensors = bundle.get('tensors')
    require(isinstance(tensors, dict) and tensors and all(TENSOR_NAME.fullmatch(name) for name in tensors),
            'Model bundle tensors are missing or misnamed.')
    sources = bundle.get('training_sources') or []
    identity = {'id': bundle.get('id'), 'version': bundle.get('version'), 'schema': bundle['schema'],
                'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw),
                'training_animals': list(bundle.get('training_animals') or []),
                'independent_validation_established': bundle.get('independent_validation_established') is True,
                'anatomical_accuracy_established': bundle.get('anatomical_accuracy_established') is True,
                'scope': bundle.get('scope')}
    training_hashes = {entry.get('source_sha256') for entry in sources if isinstance(entry, dict)}
    return bundle, identity, training_hashes


def load_network(bundle):
    """Build the network from the bundle. PyTorch is needed only here and in predict()."""
    try:
        import torch
        from torch import nn
        import torch.nn.functional as F
    except ImportError:
        raise ValueError('PyTorch is needed to run the layer model; it is not installed here.')
    torch.set_num_threads(1)
    base, groups = bundle['architecture']['base_channels'], bundle['architecture']['group_norm_groups']

    def block(a, b):
        return nn.Sequential(nn.Conv2d(a, b, 3, padding=1), nn.GroupNorm(groups, b), nn.ReLU(True),
                             nn.Conv2d(b, b, 3, padding=1), nn.GroupNorm(groups, b), nn.ReLU(True))

    class UNet(nn.Module):
        def __init__(self):
            super().__init__()
            c = [base, base * 2, base * 4, base * 8, base * 16]
            self.d = nn.ModuleList([block(3, c[0])] + [block(c[i], c[i + 1]) for i in range(4)])
            self.u = nn.ModuleList([block(c[i + 1] + c[i], c[i]) for i in range(4)])
            self.o = nn.Conv2d(base, len(CLASSES), 1)

        def forward(self, x):
            skips = []
            for i, down in enumerate(self.d):
                x = down(x if i == 0 else F.max_pool2d(x, 2))
                skips.append(x)
            for i in range(3, -1, -1):
                x = self.u[i](torch.cat([F.interpolate(x, size=skips[i].shape[2:], mode='bilinear',
                                                       align_corners=False), skips[i]], 1))
            return self.o(x)

    state = {}
    for name, entry in bundle['tensors'].items():
        values = np.frombuffer(base64.b64decode(entry['base64']), '<f4')
        require(values.size == int(np.prod(entry['shape'])), 'Model tensor ' + name + ' has the wrong size.')
        state[name] = torch.from_numpy(values.reshape(entry['shape']).astype(np.float32))
    network = UNet()
    network.load_state_dict(state, strict=True)
    return network.eval()


def reduced_image(tiff, factor):
    """Block mean of the original pixels, rounded half up, as RGB uint8. Integer arithmetic throughout."""
    require(tiff.channels in (1, 3), 'The montage must be 8-bit grey or RGB.')
    require(max(tiff.width, tiff.height) <= MAX_IMAGE_SIDE, 'The montage is wider or taller than ROI files can address.')
    rows, cols = tiff.height // factor, tiff.width // factor
    require(rows >= 1 and cols >= 1, 'The montage is smaller than one model cell.')
    reduced = np.zeros((rows, cols, 3), np.uint8)
    band = max(factor, min(512, (16 * 1024 ** 2 // (tiff.width * tiff.channels)) // factor * factor))
    for y in range(0, rows * factor, band):
        height = min(band, rows * factor - y)
        pixels = np.frombuffer(tiff.read_window(0, y, cols * factor, height), np.uint8)
        pixels = pixels.reshape(height // factor, factor, cols, factor, tiff.channels)
        total = pixels.sum(axis=(1, 3), dtype=np.uint32)
        mean = ((2 * total + factor * factor) // (2 * factor * factor)).astype(np.uint8)
        reduced[y // factor:(y + height) // factor] = mean if tiff.channels == 3 else np.repeat(mean, 3, axis=2)
    return reduced


def predict(network, bundle, reduced, height, width):
    """Model probabilities at the reduced scale and the label of every original pixel."""
    import torch
    import torch.nn.functional as F
    factor = bundle['input']['block_mean_factor']
    tile, keep = bundle['inference']['tile'], bundle['inference']['keep']
    rows, cols = reduced.shape[:2]
    require(len(CLASSES) * rows * cols * factor * factor * 4 <= MAX_PROBABILITY_BYTES,
            'The montage is too large to label in one pass on this engine version.')
    scaled = reduced.astype(np.float32) / 255
    probabilities = np.zeros((len(CLASSES), rows, cols), np.float32)
    margin = (tile - keep) // 2
    with torch.no_grad():
        for y in range(0, rows, keep):
            for x in range(0, cols, keep):
                y0, x0, y1, x1 = max(0, y - margin), max(0, x - margin), min(rows, y + keep + margin), min(cols, x + keep + margin)
                patch = torch.from_numpy(np.ascontiguousarray(scaled[y0:y1, x0:x1].transpose(2, 0, 1))[None])
                out = network(patch).softmax(1)[0].numpy()
                h, w = min(keep, rows - y), min(keep, cols - x)
                probabilities[:, y:y + h, x:x + w] = out[:, y - y0:y - y0 + h, x - x0:x - x0 + w]
        native = F.interpolate(torch.from_numpy(probabilities[None]), size=(rows * factor, cols * factor),
                               mode='bilinear', align_corners=False)[0].argmax(0).numpy().astype(np.uint8)
    labels = np.zeros((height, width), np.uint8)
    labels[:rows * factor, :cols * factor] = native
    return probabilities, labels


# ---------------------------------------------------------------- labels

def clean_labels(labels, min_area):
    """Give each 4-connected part smaller than min_area to the class it shares the longest border with.

    Only borders with parts that stay are counted, ties go to the lower class index, and a small part
    with no such neighbour is left as it is. Returns the new labels and what was moved.
    """
    part = np.zeros(labels.shape, np.int32)
    origin = [0]
    for cls in range(len(CLASSES)):
        found, count = ndimage.label(labels == cls)
        if not count:
            continue
        sizes = np.bincount(found.ravel(), minlength=count + 1)
        small = np.flatnonzero(sizes[1:] < min_area) + 1
        if small.size:
            ids = np.zeros(count + 1, np.int32)
            ids[small] = len(origin) + np.arange(small.size, dtype=np.int32)
            chosen = ids[found]
            part[chosen > 0] = chosen[chosen > 0]
            origin.extend([cls] * small.size)
        del found
    moved = [[0] * len(CLASSES) for _ in CLASSES]
    report = {'min_part_area_px': int(min_area), 'small_parts': len(origin) - 1, 'parts_reassigned': 0,
              'parts_left': 0, 'reassigned_px': moved}
    if len(origin) == 1:
        return labels, report
    border = np.zeros(len(origin) * len(CLASSES), np.int64)
    for a, b, la, lb in ((part[:, :-1], part[:, 1:], labels[:, :-1], labels[:, 1:]),
                         (part[:-1], part[1:], labels[:-1], labels[1:])):
        for inner, outer, outer_label in ((a, b, lb), (b, a, la)):
            at = np.flatnonzero((inner > 0) & (outer == 0))
            if at.size:
                keys = inner.ravel()[at].astype(np.int64) * len(CLASSES) + outer_label.ravel()[at]
                border += np.bincount(keys, minlength=border.size)
    border = border.reshape(len(origin), len(CLASSES))
    target = border.argmax(1).astype(np.int16)
    target[border.sum(1) == 0] = -1
    target[0] = -1
    inside = np.flatnonzero(part.ravel() > 0)
    chosen = target[part.ravel()[inside]]
    cleaned = labels.copy()
    cleaned.ravel()[inside[chosen >= 0]] = chosen[chosen >= 0].astype(np.uint8)
    sizes = np.bincount(part.ravel()[inside], minlength=len(origin))
    for index in range(1, len(origin)):
        if target[index] >= 0:
            moved[origin[index]][int(target[index])] += int(sizes[index])
            report['parts_reassigned'] += 1
        else:
            report['parts_left'] += 1
    return cleaned, report


def trace_mask(mask):
    """Pixel-edge outlines of a mask as closed integer paths.

    Each boundary edge is walked with the mask on its right, so outlines and the holes inside them wind in
    opposite directions and signed areas add up to the pixel count. Where two mask pixels meet only at a
    corner the walk turns right, which keeps 4-connected parts as separate paths. Vertices between
    collinear edges are dropped. Paths start at their top-left vertex and are ordered by it.
    """
    rows = np.flatnonzero(mask.any(axis=1))
    if not rows.size:
        return []
    cols = np.flatnonzero(mask.any(axis=0))
    y0, y1, x0, x1 = int(rows[0]), int(rows[-1]) + 1, int(cols[0]), int(cols[-1]) + 1
    m = np.zeros((y1 - y0 + 2, x1 - x0 + 2), bool)
    m[1:-1, 1:-1] = mask[y0:y1, x0:x1]
    stride = m.shape[1] + 1
    ys, xs = np.nonzero(m & ~np.roll(m, 1, axis=0))
    keys = [(ys * stride + xs) * 4]                                # top edge, heading +x
    ys, xs = np.nonzero(m & ~np.roll(m, -1, axis=1))
    keys.append((ys * stride + xs + 1) * 4 + 1)                    # right edge, heading +y
    ys, xs = np.nonzero(m & ~np.roll(m, -1, axis=0))
    keys.append(((ys + 1) * stride + xs + 1) * 4 + 2)              # bottom edge, heading -x
    ys, xs = np.nonzero(m & ~np.roll(m, 1, axis=1))
    keys.append(((ys + 1) * stride + xs) * 4 + 3)                  # left edge, heading -y
    starts = np.sort(np.concatenate(keys)).tolist()
    unused = set(starts)
    step = (1, stride, -1, -stride)
    paths = []
    for first in starts:
        if first not in unused:
            continue
        path, key = [], first
        heading = -1
        while True:
            unused.discard(key)
            vertex, direction = divmod(key, 4)
            if direction != heading:
                path.append([vertex % stride + x0 - 1, vertex // stride + y0 - 1])
                heading = direction
            vertex += step[direction]
            for turn in (1, 0, 3):
                key = vertex * 4 + (direction + turn) % 4
                if key in unused or key == first:
                    break
            else:
                raise ValueError('Mask outline is not closed.')
            if key == first:
                break
        # The start vertex is a corner by construction: the top-left edge of a path is entered from below.
        paths.append(path)
    return paths


def components(mask, structure=None):
    found, count = ndimage.label(mask, structure=structure)
    if not count:
        return found, []
    sizes = np.bincount(found.ravel(), minlength=count + 1)[1:]
    boxes = ndimage.find_objects(found)
    height, width = mask.shape
    parts = [{'label': i + 1, 'area_px': int(sizes[i]),
              'bounds': [box[1].start, box[0].start, box[1].stop, box[0].stop],
              'touches_image_border': bool(box[0].start == 0 or box[1].start == 0 or box[0].stop == height or box[1].stop == width)}
             for i, box in enumerate(boxes)]
    parts.sort(key=lambda p: (-p['area_px'], p['bounds']))
    return found, parts


# ---------------------------------------------------------------- Purkinje line

def interface_chains(labels, first, second):
    """Border between two classes as chains of lattice vertices, split wherever the border branches or ends."""
    height, width = labels.shape
    stride = width + 1
    a, b = labels[:, :-1], labels[:, 1:]
    ys, xs = np.nonzero(((a == first) & (b == second)) | ((a == second) & (b == first)))
    start = [ys * stride + xs + 1]
    end = [(ys + 1) * stride + xs + 1]
    a, b = labels[:-1], labels[1:]
    ys, xs = np.nonzero(((a == first) & (b == second)) | ((a == second) & (b == first)))
    start.append((ys + 1) * stride + xs)
    end.append((ys + 1) * stride + xs + 1)
    near = {}
    for s, t in zip(np.concatenate(start).tolist(), np.concatenate(end).tolist()):
        near.setdefault(s, []).append(t)
        near.setdefault(t, []).append(s)
    for neighbours in near.values():
        neighbours.sort()
    used = set()

    def walk(origin, following):
        path, previous, current = [origin, following], origin, following
        used.add((min(origin, following), max(origin, following)))
        while len(near[current]) == 2 and current != origin:
            one, two = near[current]
            onward = two if one == previous else one
            used.add((min(current, onward), max(current, onward)))
            path.append(onward)
            previous, current = current, onward
        return path

    chains = []
    ordered = sorted(near)
    for branching in (True, False):
        for vertex in ordered:
            if (len(near[vertex]) != 2) == branching:
                for neighbour in near[vertex]:
                    if (min(vertex, neighbour), max(vertex, neighbour)) not in used:
                        chains.append([[v % stride, v // stride] for v in walk(vertex, neighbour)])
    return chains


def simplify(points, tolerance):
    """Douglas-Peucker with both ends fixed; distance is measured to the chord segment."""
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
        square = float(chord @ chord)
        along = np.clip(rel @ chord / square, 0, 1) if square else np.zeros(len(rel))
        gap = rel - along[:, None] * chord
        distance = np.hypot(gap[:, 0], gap[:, 1])
        k = int(distance.argmax())
        if distance[k] > tolerance:
            keep[i + 1 + k] = True
            stack.append((i, i + 1 + k))
            stack.append((i + 1 + k, j))
    return [list(points[i]) for i in np.flatnonzero(keep).tolist()]


def polyline_length(points):
    return sum(math.dist(a, b) for a, b in zip(points, points[1:]))


def join_chains(chains, min_chain_px, max_bridge_px):
    """Order chains into one line. Starting from the longest, the nearest free chain end is attached by a
    straight bridge while it lies within max_bridge_px. Returns (ordered chains, bridges, omitted chains)."""
    usable = [c for c in chains if len(c) - 1 >= min_chain_px]
    short = [c for c in chains if len(c) - 1 < min_chain_px]
    if not usable:
        return [], [], [{'reason': 'shorter-than-minimum', 'chain': c} for c in short]
    order = sorted(range(len(usable)), key=lambda i: (-(len(usable[i]) - 1), usable[i][0], usable[i][-1]))
    line = [usable[order[0]]]
    free = order[1:]
    bridges = []
    while free:
        best = None
        for index in free:
            chain = usable[index]
            for at_tail, anchor in ((True, line[-1][-1]), (False, line[0][0])):
                for reverse, point in ((False, chain[0]), (True, chain[-1])):
                    gap = math.dist(anchor, point)
                    candidate = (gap, free.index(index), not at_tail, reverse)
                    if best is None or candidate < best[0]:
                        best = (candidate, index, at_tail, reverse, anchor, point)
        (gap, _, _, _), index, at_tail, reverse, anchor, point = best
        if gap > max_bridge_px:
            break
        chain = usable[index]
        # A chain joins the tail by its nearest end first, and the head by its nearest end last.
        oriented = chain[::-1] if reverse == at_tail else chain
        if at_tail:
            line.append(oriented)
        else:
            line.insert(0, oriented)
        if gap > 0:
            bridges.append({'from': list(anchor), 'to': list(point), 'length_px': gap})
        free.remove(index)
    omitted = [{'reason': 'beyond-bridge-limit', 'chain': usable[i]} for i in free]
    omitted += [{'reason': 'shorter-than-minimum', 'chain': c} for c in short]
    return line, bridges, omitted


def assemble_line(ordered, tolerance):
    points = []
    for chain in ordered:
        for point in simplify(chain, tolerance):
            if not points or points[-1] != point:
                points.append(point)
    return points


def purkinje_line(labels, parameters, pixels_per_micron):
    """PL_TOTAL draft: one line along the ML to GL border, with what was bridged and what was left out."""
    chains = interface_chains(labels, CLASSES.index('ML'), CLASSES.index('GL'))
    ordered, bridges, omitted = join_chains(chains, parameters['pl_min_chain_px'],
                                            parameters['pl_max_bridge_um'] * pixels_per_micron)
    um = 1 / pixels_per_micron
    border_px = sum(len(c) - 1 for c in chains)
    omitted_px = sum(len(entry['chain']) - 1 for entry in omitted)
    line = assemble_line(ordered, parameters['pl_simplify_tolerance_px'])
    report = {'border_chains': len(chains), 'border_edge_length_um': border_px * um,
              'chains_joined': len(ordered), 'bridge_count': len(bridges),
              'bridged_length_um': sum(b['length_px'] for b in bridges) * um,
              'bridges': [{'from': b['from'], 'to': b['to'], 'length_um': b['length_px'] * um} for b in bridges],
              'omitted_chains': len(omitted), 'omitted_edge_length_um': omitted_px * um,
              'omitted_share_of_border': omitted_px / border_px if border_px else 0.0,
              'omitted': [{'reason': entry['reason'], 'edge_length_um': (len(entry['chain']) - 1) * um,
                           'bounds': [min(p[0] for p in entry['chain']), min(p[1] for p in entry['chain']),
                                      max(p[0] for p in entry['chain']), max(p[1] for p in entry['chain'])]}
                          for entry in omitted],
              'vertices': len(line), 'length_um': polyline_length(line) * um if len(line) > 1 else None,
              'length_um_by_tolerance_px': {('%g' % t): polyline_length(assemble_line(ordered, t)) * um
                                            for t in parameters['pl_sensitivity_tolerances_px']} if ordered else {}}
    return (line if len(line) > 1 else None), report


# ---------------------------------------------------------------- ROI files

def pack_short(value):
    require(0 <= value <= MAX_IMAGE_SIDE, 'ROI coordinate is outside the range an ROI file can hold.')
    return struct.pack('>H', value)


def encode_roi(name, kind, paths):
    """One ImageJ .roi file. Areas are a traced outline or, with several paths, a composite shape;
    lines are a polyline. Coordinates are whole original-image pixels."""
    points = [p for path in paths for p in path]
    require(points and all(type(v) is int for p in points for v in p), 'ROI coordinates must be whole pixels.')
    left, top = min(p[0] for p in points), min(p[1] for p in points)
    right, bottom = max(p[0] for p in points), max(p[1] for p in points)
    header = bytearray(64)
    header[0:4] = b'Iout'
    struct.pack_into('>H', header, 4, 228)
    for offset, value in ((8, top), (10, left), (12, bottom), (14, right)):
        header[offset:offset + 2] = pack_short(value)
    if kind == 'polyline' or (len(paths) == 1 and len(points) <= 65535):
        require(len(paths) == 1 and len(points) >= (2 if kind == 'polyline' else 3) and len(points) <= 65535,
                'ROI ' + name + ' cannot be written as one path.')
        header[6] = 5 if kind == 'polyline' else 8
        struct.pack_into('>H', header, 16, len(points))
        body = b''.join(pack_short(p[0] - left) for p in points) + b''.join(pack_short(p[1] - top) for p in points)
    else:
        values = []
        for path in paths:
            require(len(path) >= 3, 'ROI ' + name + ' has a path with fewer than three vertices.')
            for index, point in enumerate(path):
                values.extend((1.0 if index else 0.0, float(point[0]), float(point[1])))
            values.append(4.0)
        require(len(values) <= 6000000, 'ROI ' + name + ' has more vertices than an ROI file can hold.')
        header[6] = 1
        struct.pack_into('>i', header, 36, len(values))
        body = struct.pack('>%df' % len(values), *values)
    second = bytearray(64)
    struct.pack_into('>i', header, 60, 64 + len(body))
    struct.pack_into('>i', second, 16, 64 + len(body) + 64)
    struct.pack_into('>i', second, 20, len(name))
    return bytes(header) + body + bytes(second) + name.encode('utf-16-be')


def roi_zip_bytes(rois):
    """ZIP with fixed entry order, timestamps and attributes, so equal ROIs give equal bytes."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        for roi in rois:
            entry = zipfile.ZipInfo(roi['name'] + '.roi', date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type, entry.create_system, entry.external_attr = zipfile.ZIP_DEFLATED, 3, 0o644 << 16
            archive.writestr(entry, encode_roi(roi['name'], roi['kind'], roi['paths']), compresslevel=6)
    return buffer.getvalue()


# ---------------------------------------------------------------- draft

def confidence_signals(probabilities, factor, parameters):
    """Where the model's two best classes are close. Uncalibrated: it orders review and nothing more."""
    ranked = np.sort(probabilities, axis=0)
    margin = ranked[-1] - ranked[-2]
    tissue = probabilities.argmax(0) > 0
    cells = int(tissue.sum())
    if not cells:
        return {'tissue_cells': 0}, []
    low = (margin < parameters['confidence_margin_below']) & tissue
    # Every class border is a thin low-margin ribbon; one erosion keeps only areas wider than that.
    core = ndimage.binary_erosion(low, structure=np.ones((3, 3), bool))
    found, parts = components(core, np.ones((3, 3), bool))
    regions = [{'cells': p['area_px'],
                'bounds': [max(0, p['bounds'][0] - 1) * factor, max(0, p['bounds'][1] - 1) * factor,
                           (p['bounds'][2] + 1) * factor, (p['bounds'][3] + 1) * factor]}
               for p in parts if p['area_px'] >= parameters['confidence_region_min_cells']]
    values = {'tissue_cells': cells, 'mean_margin': float(margin[tissue].mean()),
              'low_margin_share': float(low.sum() / cells), 'low_margin_regions': len(regions)}
    return values, regions


def purkinje_band(labels, width_px):
    """Model ML within width_px of GL, measured through ML only, so the band does not jump across a fissure or a gap.
    Growth alternates 4- and 8-neighbour steps, which keeps the reach close to a Euclidean distance."""
    ml, reach = labels == CLASSES.index('ML'), labels == CLASSES.index('GL')
    if width_px <= 0 or not ml.any() or not reach.any():
        return np.zeros(labels.shape, bool)
    cross, square = ndimage.generate_binary_structure(2, 1), ndimage.generate_binary_structure(2, 2)
    allowed = ml | reach
    for step in range(width_px):
        reach = ndimage.binary_dilation(reach, structure=cross if step % 2 == 0 else square, mask=allowed)
    return reach & ml


def draft_rois(labels, protocol, parameters, extent=None):
    """ROIs and structure signals from native labels. Uses no model and no image.

    extent is the (height, width) the model labelled; tissue reaching its edge counts as reaching the image border.
    """
    totals = protocol['roi_names']['totals']
    require(all(name in totals for name in ROI_ORDER), 'The protocol does not define the total ROI names this engine drafts.')
    require(all('area' in totals[name]['geometry'] for name in AREA_CLASSES) and 'line' in totals['PL_TOTAL']['geometry'],
            'The protocol does not allow the geometry this engine drafts.')
    scale = protocol['calibration']['pixels_per_micron']
    counts = np.bincount(labels.ravel(), minlength=len(CLASSES))
    require(len(counts) == len(CLASSES), 'Labels hold a class the engine does not know.')
    require(int(counts[1:].sum()) > 0, 'The model found no tissue in this image.')
    rois, absent = {}, []
    band_um = float(parameters.get('pl_band_width_um', 0) or 0)  # drafts made before the band existed carry no width
    require(band_um == 0 or parameters.get('pl_band_side') == 'ML', 'The Purkinje band is only drafted on the ML side.')
    band = purkinje_band(labels, int(round(band_um * scale)))
    for name, classes in AREA_CLASSES.items():
        mask = np.isin(labels, classes)
        if name == 'ML_TOTAL':
            mask &= ~band
        paths = trace_mask(mask)
        if not paths:
            absent.append(name)
            continue
        rois[name] = {'name': name, 'kind': 'area', 'paths': paths}
        require(roi_measure.area_px2(rois[name]) == int(mask.sum()), 'Outline of ' + name + ' does not enclose its pixels.')
    line, pl = purkinje_line(labels, parameters, scale)
    if line:
        rois['PL_TOTAL'] = {'name': 'PL_TOTAL', 'kind': 'polyline', 'paths': [line]}
    else:
        absent.append('PL_TOTAL')
    height, width = extent or labels.shape
    require(not labels[height:].any() and not labels[:, width:].any(), 'Labels lie outside the labelled extent.')
    tissue = labels[:height, :width] > 0
    _, parts = components(tissue)
    _, gaps = components(~tissue, np.ones((3, 3), bool))
    enclosed = [g for g in gaps if not g['touches_image_border']]
    um2 = 1 / (scale * scale)
    structure = {
        'pixels': {name: int(counts[i]) for i, name in enumerate(CLASSES)},
        'absent': absent,
        'tissue_parts': len(parts),
        'main_part_area_um2': parts[0]['area_px'] * um2,
        'detached_parts': [{'area_um2': p['area_px'] * um2, 'bounds': p['bounds'],
                            'touches_image_border': p['touches_image_border']} for p in parts[1:]],
        'detached_area_share': sum(p['area_px'] for p in parts[1:]) / int(tissue.sum()),
        'main_part_touches_image_border': parts[0]['touches_image_border'],
        'enclosed_gaps': len(enclosed), 'enclosed_gap_area_um2': sum(g['area_px'] for g in enclosed) * um2,
        'layer_parts': {name: len(components(labels == i)[1]) for i, name in enumerate(CLASSES) if i},
        'purkinje_line': pl,
        'purkinje_band': {'width_um': band_um, 'side': parameters.get('pl_band_side') if band_um else None, 'pixels': int(band.sum()),
                          'area_um2': int(band.sum()) * um2, 'rule': 'model ML within the width of GL, measured through ML; not in ML_TOTAL, no ROI of its own',
                          'basis': 'researcher decision 2026-11-11' if band_um else None},
    }
    return [rois[name] for name in ROI_ORDER if name in rois], structure


def review_queue(qc, structure, regions, parameters):
    """What a person should look at first, most consequential first. An empty queue approves nothing."""
    items = []

    def add(tier, code, detail, bounds=None, weight=0.0):
        items.append({'tier': tier, 'code': code, 'detail': detail, 'bounds': bounds, 'weight': weight})

    for flag in qc['flags']:
        add(flag['priority'], flag['code'], flag['detail'])
    for name in structure['absent']:
        add(1, 'not-drafted-here', name + ' could not be drafted from the model labels.')
    if structure['main_part_touches_image_border']:
        add(1, 'main-part-at-image-border', 'The main tissue part reaches the image border: the cerebellum may be cut off '
            'there, or other tissue may be joined to it.')
    for part in structure['detached_parts']:
        at_border = part['touches_image_border']
        add(1 if at_border else 2, 'detached-part-at-image-border' if at_border else 'detached-part',
            'Tissue of %.0f um2 separate from the main part; it is inside Cb and the layer ROIs.' % part['area_um2'],
            part['bounds'], part['area_um2'])
    pl = structure['purkinje_line']
    if pl['omitted_share_of_border'] > parameters['pl_omitted_share_review_above']:
        add(1, 'pl-border-left-out', '%.1f%% of the ML to GL border is not in PL_TOTAL.' % (100 * pl['omitted_share_of_border']))
    for bridge in pl['bridges']:
        if bridge['length_um'] > parameters['pl_bridge_review_above_um']:
            xs, ys = sorted((bridge['from'][0], bridge['to'][0])), sorted((bridge['from'][1], bridge['to'][1]))
            add(2, 'pl-bridge', 'PL_TOTAL crosses %.0f um in a straight line here.' % bridge['length_um'],
                [xs[0], ys[0], xs[1], ys[1]], bridge['length_um'])
    for entry in pl['omitted']:
        if entry['reason'] == 'beyond-bridge-limit':
            add(2, 'pl-chain-left-out', '%.0f um of ML to GL border is not in PL_TOTAL.' % entry['edge_length_um'],
                entry['bounds'], entry['edge_length_um'])
    for region in regions[:parameters['queue_region_limit']]:
        add(3, 'low-confidence-region', 'The model is undecided over %d cells here.' % region['cells'],
            region['bounds'], float(region['cells']))
    items.sort(key=lambda item: (item['tier'], item['code'], -item['weight'], item['bounds'] or [], item['detail']))
    for rank, item in enumerate(items, 1):
        item['rank'] = rank
        del item['weight']
    return items


def environment():
    info = {'python': platform.python_version(), 'implementation': platform.python_implementation(),
            'machine': platform.machine(), 'system': platform.system(), 'numpy': np.__version__,
            'scipy': __import__('scipy').__version__, 'zlib': zlib.ZLIB_RUNTIME_VERSION, 'torch': None, 'torch_threads': None}
    try:
        import torch
        info['torch'], info['torch_threads'] = torch.__version__, torch.get_num_threads()
    except ImportError:
        pass
    return info


def code_identity():
    folder = Path(__file__).resolve().parent
    return {name: file_digest(folder / name) for name in ('roi_draft.py', 'roi_measure.py', 'nissl_lab.py', 'native_tiff.py')}


def write_new(path, data):
    require(not path.exists(), 'Refusing to overwrite an existing file: ' + path.name)
    with path.open('xb') as stream:
        stream.write(data)


def json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + '\n').encode('utf-8')


def write_section(folder, sample, labels, protocol, parameters, source, model, probabilities=None, factor=None,
                  extent=None):
    """Write the draft ROI ZIP, its measurement table and the draft record for one section into a new folder."""
    require(SAMPLE_NAME.fullmatch(sample) is not None, 'Section names may hold letters, digits, dot, dash and underscore only.')
    folder = Path(folder)
    folder.mkdir()
    cleaned, cleanup = clean_labels(labels, parameters['min_part_area_px'])
    rois, structure = draft_rois(cleaned, protocol, parameters, extent)
    roi_path, table_path = folder / (sample + '.draft-roi.zip'), folder / (sample + '.draft-measurement.csv')
    write_new(roi_path, roi_zip_bytes(rois))
    decoded, roi_hash = read_roi_zip(roi_path)
    require([(r['name'], r['paths']) for r in decoded] == [(r['name'], r['paths']) for r in rois],
            'The written ROI file does not read back as the draft.')
    records = roi_measure.measure(decoded, protocol)
    qc = roi_measure.section_qc(records, protocol)
    rows = roi_measure.table_rows(records, sample)
    roi_measure.write_table(rows, table_path)
    confidence, regions = ({'tissue_cells': None}, []) if probabilities is None else confidence_signals(probabilities, factor, parameters)
    record = {
        'schema': DRAFT_SCHEMA, 'status': 'draft',
        'approval': {'approved': False, 'statement': 'Machine draft. No person has reviewed or approved it.'},
        'sample': sample, 'source': source, 'model': model, 'protocol': protocol['identity'],
        'engine': dict(ENGINE, code_sha256=code_identity(), parameters=parameters, environment=environment()),
        'labels': {'model_sha256': hashlib.sha256(labels.tobytes()).hexdigest(),
                   'draft_sha256': hashlib.sha256(cleaned.tobytes()).hexdigest(),
                   'labelled_extent': {'width': (extent or labels.shape)[1], 'height': (extent or labels.shape)[0]},
                   'cleanup': cleanup},
        'outputs': {'roi': {'file': roi_path.name, 'sha256': roi_hash, 'bytes': roi_path.stat().st_size,
                            'rois': [{'name': r['name'], 'type': r['type'], 'geometry': r['geometry'],
                                      'paths': r['path_count'], 'vertices': r['vertex_count']} for r in records]},
                    'table': {'file': table_path.name, 'sha256': file_digest(table_path), 'rows': len(rows)}},
        'measurement': qc, 'structure': structure, 'confidence': confidence,
        'review_queue': review_queue(qc, structure, regions, parameters),
        'not_drafted': NOT_DRAFTED, 'limits': LIMITS,
    }
    record_path = folder / (sample + '.draft.json')
    write_new(record_path, json_bytes(record))
    return record, record_path


def neighbour_deviation(values):
    """Distance of each value from the mean of its two neighbours, relative to that mean. Ends have none."""
    out = [None] * len(values)
    for i in range(1, len(values) - 1):
        trio = values[i - 1:i + 2]
        if None not in trio and trio[0] + trio[2] > 0:
            out[i] = abs(trio[1] - (trio[0] + trio[2]) / 2) / ((trio[0] + trio[2]) / 2)
    return out


def section_index(entries):
    """Sections in the order supplied, with how far each measurement departs from its neighbours."""
    series = {name: [e['record']['measurement']['values']['area_um2'].get(name) for e in entries]
              for name in AREA_CLASSES}
    series['PL_TOTAL'] = [e['record']['measurement']['values']['pl_total_length_um'] for e in entries]
    deviation = {name: neighbour_deviation(values) for name, values in series.items()}
    sections = []
    for i, entry in enumerate(entries):
        record = entry['record']
        queue = record['review_queue']
        jumps = {name: deviation[name][i] for name in series if deviation[name][i] is not None}
        sections.append({
            'sample': record['sample'], 'folder': entry['folder'], 'record': entry['file'], 'record_sha256': entry['sha256'],
            'source_sha256': record['source']['sha256'], 'roi_sha256': record['outputs']['roi']['sha256'],
            'table_sha256': record['outputs']['table']['sha256'],
            'source_in_training_set': record['model']['source_in_training_set'],
            'queue': {'items': len(queue), 'by_tier': {str(t): sum(1 for q in queue if q['tier'] == t) for t in (1, 2, 3)}},
            'values': {name: series[name][i] for name in series},
            'neighbour_deviation': jumps, 'largest_neighbour_deviation': max(jumps.values()) if jumps else None})
    order = sorted(range(len(sections)), key=lambda i: (-sections[i]['queue']['by_tier']['1'],
                                                        -(sections[i]['largest_neighbour_deviation'] or 0),
                                                        -sections[i]['queue']['items'], i))
    return {'schema': INDEX_SCHEMA, 'status': 'draft', 'approval': {'approved': False},
            'section_order': 'as supplied on the command line; neighbour deviation assumes anatomical order',
            'sections': sections, 'review_order': [sections[i]['sample'] for i in order]}


def draft_section(folder, sample, image, network, bundle, model, training_hashes, protocol, parameters):
    image = Path(image)
    source_hash = file_digest(image)
    with NativeTiff(image) as tiff:
        factor = bundle['input']['block_mean_factor']
        reduced = reduced_image(tiff, factor)
        source = {'file_name': image.name, 'bytes': image.stat().st_size, 'sha256': source_hash,
                  'width': tiff.width, 'height': tiff.height, 'channels': tiff.channels}
        probabilities, labels = predict(network, bundle, reduced, tiff.height, tiff.width)
    require(file_digest(image) == source_hash, 'The montage changed while it was being read.')
    model = dict(model, source_in_training_set=source_hash in training_hashes)
    extent = (source['height'] // factor * factor, source['width'] // factor * factor)
    return write_section(folder, sample, labels, protocol, parameters, source, model, probabilities, factor, extent)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Draft ROI ZIP, measurement table and review queue from montages.')
    parser.add_argument('--model', required=True, type=Path, help='Layer U-Net bundle (JSON). It stays outside the repository.')
    parser.add_argument('--section', required=True, action='append', metavar='NAME=MONTAGE.tif',
                        help='One section; repeat in anatomical order for a whole animal.')
    parser.add_argument('--output', required=True, type=Path, help='New folder for the drafts; an existing one is never touched.')
    parser.add_argument('--protocol', type=Path, default=roi_measure.DEFAULT_PROTOCOL)
    args = parser.parse_args(argv)
    try:
        sections = []
        for item in args.section:
            name, _, image = item.partition('=')
            require(SAMPLE_NAME.fullmatch(name) is not None and image, 'Give each section as NAME=MONTAGE.tif.')
            sections.append((name, Path(image).resolve()))
        require(len({name for name, _ in sections}) == len(sections), 'Section names must differ.')
        output = args.output.resolve()
        require(not output.exists(), 'The output folder already exists; drafts are never written over.')
        require(all(image.parent != output and image.parent not in output.parents for _, image in sections),
                'The output folder must not be inside a folder that holds an original image.')
        protocol = roi_measure.load_protocol(args.protocol)
        bundle, model, training_hashes = load_bundle(args.model)
        network = load_network(bundle)
        parameters = json.loads(json.dumps(PARAMETERS))
        output.mkdir(parents=True)
        entries = []
        for name, image in sections:
            record, path = draft_section(output / name, name, image, network, bundle, model, training_hashes, protocol, parameters)
            entries.append({'record': record, 'folder': name, 'file': path.name, 'sha256': file_digest(path)})
            print('%s: %d ROIs, %d review items' % (name, len(record['outputs']['roi']['rois']), len(record['review_queue'])),
                  file=sys.stderr)
        index = section_index(entries)
        write_new(output / 'draft-index.json', json_bytes(index))
    except (ValueError, OSError) as error:
        print('Not drafted: ' + str(error), file=sys.stderr)
        return 2
    print(json.dumps({'schema': index['schema'], 'sections': len(index['sections']), 'review_order': index['review_order']},
                     indent=2, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
