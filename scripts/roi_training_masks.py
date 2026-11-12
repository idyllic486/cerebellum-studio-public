"""Native-coordinate training masks from declared area ROIs, using stdlib only.

Pixel centres use even-odd fill with half-open crossing intervals. Original
geometry is never rewritten. These masks represent supplied labels, not anatomy
or an independently verified ground truth.
"""
from collections import defaultdict
import math

MAX_PIXELS = 256_000_000
MAX_REQUIRED_VERTICES = 1_000_000
MAX_SCAN_INTERSECTIONS = 20_000_000
MAX_STORED_SPANS = 2_000_000
MAX_WINDOW_PIXELS = 4_194_304
REQUIRED = ('Cb', 'ML_TOTAL', 'GL_TOTAL', 'WM')


def require(value, message):
    if not value:
        raise ValueError(message)


def _integer(value):
    return type(value) is int


def _spans(roi, width, height, budget):
    """Index each integer row once, retaining runs rather than a full bitmap."""
    starts = defaultdict(list)
    for ring in roi['paths']:
        for a, b in zip(ring, ring[1:] + ring[:1]):
            if a[1] == b[1]:
                continue
            low, high = (a, b) if a[1] < b[1] else (b, a)
            first = max(0, math.ceil(low[1] - .5))
            end = min(height, math.ceil(high[1] - .5))
            if first >= end:
                continue
            slope = (high[0] - low[0]) / (high[1] - low[1])
            # Compute intersections from the original edge on every row; do not
            # accumulate slope and introduce tile/order-dependent drift.
            starts[first].append((end, low[0], low[1], slope))
    rows, active = [], []
    for y in range(height):
        active = [edge for edge in active if edge[0] > y]
        active.extend(starts.pop(y, ()))
        budget['intersections'] += len(active)
        require(budget['intersections'] <= MAX_SCAN_INTERSECTIONS,
                'ROI scanline work exceeds the bounded preparation budget; no geometry was simplified.')
        xs = sorted(edge[1] + (y + .5 - edge[2]) * edge[3] for edge in active)
        require(len(xs) % 2 == 0, 'Unmatched even-odd crossing; no label mask was substituted.')
        spans = []
        for left, right in zip(xs[::2], xs[1::2]):
            lo, hi = max(0, math.ceil(left - .5)), min(width, math.ceil(right - .5))
            if lo < hi:
                if spans and spans[-1][1] == lo:
                    spans[-1] = (spans[-1][0], hi)
                else:
                    spans.append((lo, hi))
        budget['spans'] += len(spans)
        require(budget['spans'] <= MAX_STORED_SPANS,
                'ROI scanline storage exceeds the bounded preparation budget; no geometry was simplified.')
        rows.append(tuple(spans))
    return rows


class TrainingMasks:
    """Reuse indexed area geometry for independently positioned native windows."""

    def __init__(self, rois, width, height):
        require(_integer(width) and _integer(height) and 0 < width <= 32767
                and 0 < height <= 32767 and width * height <= MAX_PIXELS,
                'Invalid or oversized native image grid for label preparation.')
        require(isinstance(rois, list) and 0 < len(rois) <= 2000, 'Expected decoded ImageJ ROI list.')
        by_name = defaultdict(list)
        for roi in rois:
            require(isinstance(roi, dict) and isinstance(roi.get('name'), str), 'Invalid decoded ROI.')
            by_name[roi['name']].append(roi)
        selected, vertices = [], 0
        for name in REQUIRED:
            require(len(by_name[name]) == 1, 'Exactly one declared area ROI is required: ' + name)
            roi = by_name[name][0]
            require(roi.get('kind') == 'area' and roi.get('closed') is True,
                    'Training area ROI has incompatible geometry: ' + name)
            paths = roi.get('paths')
            require(isinstance(paths, list) and 0 < len(paths) <= 2000, 'Invalid area paths: ' + name)
            for ring in paths:
                require(isinstance(ring, list) and len(ring) >= 3, 'Area path has too few vertices: ' + name)
                vertices += len(ring)
                require(vertices <= MAX_REQUIRED_VERTICES, 'Required ROI vertex budget exceeded; no points were removed.')
                for point in ring:
                    require(isinstance(point, (list, tuple)) and len(point) == 2
                            and all(type(v) in (int, float) and math.isfinite(v) for v in point),
                            'Invalid area coordinate: ' + name)
                    require(0 <= point[0] <= width and 0 <= point[1] <= height,
                            'Required area ROI lies outside the native image grid: ' + name)
            selected.append(roi)
        self.width, self.height = width, height
        budget = {'intersections': 0, 'spans': 0}
        self._rows = [_spans(roi, width, height, budget) for roi in selected]
        require(any(self._rows[0]), 'Declared CB area contains no sampled pixel centres; background-only training was not created.')
        totals = by_name.get('PL_TOTAL', [])
        require(len(totals) <= 1, 'Duplicate PL_TOTAL observations must be resolved before preparation.')
        self.metadata = {
            'schema': 'cerebellum-training-mask-policy/1',
            'required_area_rois': list(REQUIRED),
            'coordinate_system': 'unchanged original image pixels',
            'pixel_sampling': 'pixel centres (x+0.5,y+0.5); even-odd fill, half-open crossing intervals',
            'cb_classes': {'0': 'background', '1': 'CB', '255': 'unknown'},
            'layer_classes': {'0': 'background', '1': 'ML', '2': 'GL', '3': 'WM', '255': 'unknown'},
            'background_policy': 'Outside the declared even-odd CB area, including its holes, is background unless a declared tissue layer conflicts.',
            'conflict_policy': 'Layer overlap, layer outside CB and uncovered CB pixels are unknown for layer training. Tissue outside CB is also unknown for CB training.',
            'combined_region_policy': 'GL+WM is preserved in the original archive; it supplies no exclusive layer class.',
            'PL_TOTAL_kind': totals[0].get('kind') if totals else None,
            'PL_quantification_performed': False,
            'other_annotations_preserved_in_original': True,
            'geometry_modified': False,
            'anatomical_correspondence_verified': False,
            'scanline_intersections': budget['intersections'],
            'stored_spans': budget['spans'],
            'empty_required_area_masks': [name for name, rows in zip(REQUIRED, self._rows) if not any(rows)],
        }

    def render_window(self, x, y, width, height):
        require(all(_integer(v) for v in (x, y, width, height)) and x >= 0 and y >= 0
                and width > 0 and height > 0 and x + width <= self.width and y + height <= self.height
                and width * height <= MAX_WINDOW_PIXELS, 'Invalid or oversized native mask window.')
        cb, layers = bytearray(width * height), bytearray(width * height)
        qc = {'pixels': width * height, 'cb_pixels': 0, 'cb_unknown_pixels': 0,
              'layer_overlap_pixels': 0, 'layer_outside_cb_pixels': 0,
              'unassigned_inside_cb_pixels': 0, 'layer_unknown_pixels': 0,
              'ML_pixels': 0, 'GL_pixels': 0, 'WM_pixels': 0, 'background_pixels': 0}
        for row in range(y, y + height):
            events = defaultdict(int)
            events[x] = events[x + width] = 0
            for index, rows in enumerate(self._rows):
                bit = 1 << index
                for left, right in rows[row]:
                    lo, hi = max(left, x), min(right, x + width)
                    if lo < hi:
                        events[lo] ^= bit
                        events[hi] ^= bit
            positions = sorted(events)
            mask = 0
            base = (row - y) * width
            for start, end in zip(positions, positions[1:]):
                mask ^= events[start]
                length = end - start
                tissue = mask & 14
                count = tissue.bit_count()
                inside = bool(mask & 1)
                cb_value = 1 if inside else 255 if tissue else 0
                if tissue and not inside:
                    layer_value = 255
                    qc['layer_outside_cb_pixels'] += length
                elif inside and count != 1:
                    layer_value = 255
                    if not count:
                        qc['unassigned_inside_cb_pixels'] += length
                else:
                    layer_value = {0: 0, 2: 1, 4: 2, 8: 3}.get(tissue, 255)
                if count > 1:
                    qc['layer_overlap_pixels'] += length
                if cb_value == 1:
                    qc['cb_pixels'] += length
                elif cb_value == 255:
                    qc['cb_unknown_pixels'] += length
                if layer_value == 255:
                    qc['layer_unknown_pixels'] += length
                elif layer_value:
                    qc[{1: 'ML_pixels', 2: 'GL_pixels', 3: 'WM_pixels'}[layer_value]] += length
                else:
                    qc['background_pixels'] += length
                lo, hi = base + start - x, base + end - x
                if cb_value:
                    cb[lo:hi] = bytes([cb_value]) * length
                if layer_value:
                    layers[lo:hi] = bytes([layer_value]) * length
        return {'cb': bytes(cb), 'layers': bytes(layers), 'qc': qc}


class LobuleMasks:
    """Optional named cortical regions; no WM assignment or PL area conversion."""

    def __init__(self, rois, base, classes):
        import re
        self.base, self.classes = base, classes
        self.width, self.height = base.width, base.height
        self.entries = []
        vertices = 0
        budget = {'intersections': 0, 'spans': 0}
        for roi in rois:
            match = re.fullmatch(r'(ML|GL)_(.+)_part[1-9][0-9]*', roi['name'])
            if not match:
                continue
            require(roi.get('kind') == 'area' and roi.get('closed') is True,
                    'Named cortical training annotation must retain its area geometry: '+roi['name'])
            paths = roi.get('paths')
            require(isinstance(paths, list) and 0 < len(paths) <= 2000, 'Invalid cortical area paths.')
            for ring in paths:
                require(isinstance(ring, list) and len(ring) >= 3, 'Invalid cortical area ring.')
                vertices += len(ring)
                require(vertices <= MAX_REQUIRED_VERTICES, 'Cortical annotation vertex budget exceeded; no points removed.')
                for point in ring:
                    require(isinstance(point, (list, tuple)) and len(point) == 2
                            and all(type(v) in (int, float) and math.isfinite(v) for v in point)
                            and 0 <= point[0] <= self.width and 0 <= point[1] <= self.height,
                            'Named cortical annotation lies outside its original image grid.')
            self.entries.append((classes.index('LOBULE_'+match[2]) if 'LOBULE_'+match[2] in classes else 255, 1 if match[1] == 'ML' else 2,
                                 _spans(roi, self.width, self.height, budget)))
        self.metadata = {'schema': 'cerebellum-lobule-mask-policy/1', 'classes': classes,
            'scope': 'ML+GL annotated cortical subregions; not whole lobule',
            'unknown_policy': 'Unannotated CB, white matter, conflicting region identities, layer/region disagreement and out-of-CB annotation are unknown255.',
            'background_policy': 'Known CB background only; no anatomical class is inferred from missing annotations.',
            'naming_policy': 'Exact supplied region spelling; FI/Fl and PFI/PFl are not merged.',
            'PL_training_performed': False, 'whole_lobule_volume_supported': False,
            'geometry_modified': False, 'annotated_region_count': len(self.entries)}

    def render_window(self, x, y, width, height, raster=None):
        # A shared span sweep avoids a Python iteration for every native pixel.
        require(all(_integer(v) for v in (x,y,width,height)) and x >= 0 and y >= 0
                and width > 0 and height > 0 and x+width <= self.width and y+height <= self.height
                and width*height <= MAX_WINDOW_PIXELS, 'Invalid or oversized cortical mask window.')
        out = bytearray([255]) * (width * height)
        all_rows = self.base._rows + [entry[2] for entry in self.entries]
        for row in range(y, y+height):
            events = defaultdict(list)
            events[x]; events[x+width]
            for index, rows in enumerate(all_rows):
                for left, right in rows[row]:
                    lo, hi = max(left,x), min(right,x+width)
                    if lo < hi:
                        events[lo].append((index,True)); events[hi].append((index,False))
            active = set(); positions = sorted(events)
            for start,end in zip(positions,positions[1:]):
                for index, entering in events[start]:
                    if entering: active.add(index)
                    else: active.discard(index)
                annotations = [self.entries[i-4] for i in active if i >= 4]
                identities = {entry[0] for entry in annotations}
                tissues = {entry[1] for entry in annotations}
                inside = 0 in active
                known_layers = active.intersection((1,2,3))
                layer = next(iter(known_layers)) if len(known_layers)==1 else None
                if not inside and not known_layers and not annotations:
                    value = 0
                elif inside and layer in tissues and len(identities)==1:
                    value = next(iter(identities))
                else:
                    value = 255
                if value != 255:
                    lo=(row-y)*width+start-x
                    out[lo:lo+end-start] = bytes([value])*(end-start)
        return bytes(out)
