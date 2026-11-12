#!/usr/bin/env python3
"""Run an explicitly configured, externally trained Nissl ONNX model locally.

Output is an unapproved draft. No anatomical validity is asserted by this adapter.
The supplied model must expose one float32 NCHW input and same-resolution logits.
"""
from __future__ import annotations
import argparse
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile

VERSION = '1.0.0'
MAX_PIXELS = 40_000_000
MAX_FILE_BYTES = 128 * 1024 * 1024
MAX_ROIS = 64
MAX_VERTICES = 30_000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate_manifest(manifest):
    require(isinstance(manifest, dict), 'The model manifest must be a JSON object.')
    require(manifest.get('schema') == 'cerebellum-onnx-model/1', 'Unsupported model manifest schema.')
    model = manifest.get('model', {})
    require(isinstance(model, dict), 'Invalid model identity.')
    for key in ('id', 'version'):
        require(isinstance(model.get(key), str) and 0 < len(model[key]) <= 120, f'Model {key} is required.')
    sha = model.get('weights_sha256')
    require(isinstance(sha, str) and len(sha) == 64 and all(c in '0123456789abcdef' for c in sha),
            'Set weights_sha256 to the SHA-256 of the trained ONNX file.')
    require(manifest.get('single_section') is True,
            'Set single_section=true only after confirming this montage contains one anatomical section.')
    require(manifest.get('input_layout') == 'NCHW' and manifest.get('output_layout') == 'NCHW',
            'Only explicit NCHW input and output layouts are supported.')
    require(manifest.get('input_channels') in ('gray', 'RGB'), 'input_channels must be gray or RGB; no conversion is inferred.')
    require(manifest.get('input_dtype') in ('uint8', 'uint16'), 'Declare original TIFF input_dtype as uint8 or uint16.')
    channels = 1 if manifest['input_channels'] == 'gray' else 3
    for name in ('offset', 'scale'):
        values = manifest.get('normalization', {}).get(name)
        require(isinstance(values, list) and len(values) == channels, f'normalization.{name} needs one number per channel.')
        import math
        require(all(type(n) in (int, float) and math.isfinite(n) for n in values), 'Normalization numbers must be finite.')
        if name == 'scale':
            require(all(n > 0 for n in values), 'Normalization scales must be positive.')
    tile = manifest.get('tile_size')
    overlap = manifest.get('tile_overlap')
    require(isinstance(tile, list) and len(tile) == 2 and all(type(v) is int and 8 <= v <= 2048 for v in tile),
            'tile_size must be [height,width], each between 8 and 2048 pixels.')
    require(isinstance(overlap, list) and len(overlap) == 2 and all(type(v) is int and 0 <= v < t for v, t in zip(overlap, tile)),
            'tile_overlap must be [height,width], each nonnegative and smaller than its tile dimension.')
    classes = manifest.get('classes')
    require(classes in [['background', 'CB'], ['background', 'ML', 'GL', 'WM']],
            'Classes must be background,CB or exclusive background,ML,GL,WM, in output channel order.')
    require(manifest.get('output_kind') == 'logits', 'Declare output_kind=logits; probabilities and labels are not inferred.')
    require(manifest.get('padding') == 'edge', 'Declare padding=edge. Other padding is not supported.')
    return manifest


def read_image(path, manifest):
    import numpy as np
    import tifffile
    require(path.suffix.lower() in ('.tif', '.tiff'), 'Use an original single-page TIFF.')
    require(path.stat().st_size <= MAX_FILE_BYTES, 'TIFF exceeds the 128 MiB source limit.')
    raw = path.read_bytes()
    with tifffile.TiffFile(io.BytesIO(raw)) as tif:
        require(not tif.is_bigtiff and len(tif.pages) == 1, 'Use Classic TIFF with one page per anatomical section.')
        page = tif.pages[0]
        require(not page.subifds, 'Sub-IFD TIFF is not supported; provide a single image plane.')
        require(int(page.tags.get('Orientation').value) == 1 if page.tags.get('Orientation') else True,
                'TIFF orientation must be the original top-left orientation (1); no transform is inferred.')
        require(int(page.planarconfig or 1) == 1, 'Planar-separated TIFF is not supported.')
        require(int(page.compression) in (1, 8), 'Use uncompressed or Deflate TIFF for the local runner. Keep the original and any conversion provenance.')
        require(page.imagewidth <= 32767 and page.imagelength <= 32767 and
                0 < page.imagewidth * page.imagelength <= MAX_PIXELS,
                'TIFF exceeds 40 million pixels or the ImageJ 32767-pixel dimension limit.')
        require(page.dtype.name == manifest['input_dtype'], 'TIFF dtype differs from the explicitly configured model input.')
        channels = 1 if manifest['input_channels'] == 'gray' else 3
        require(page.samplesperpixel == channels, 'TIFF channels differ from model input; no channel conversion is inferred.')
        require(page.imagewidth * page.imagelength * channels * page.dtype.itemsize <= 128 * 1024 * 1024,
                'Decoded TIFF exceeds the 128 MiB review limit.')
        require(int(page.photometric) == (1 if channels == 1 else 2),
                'Use unsigned BlackIsZero gray or RGB TIFF; no inversion or color conversion is inferred.')
        require(page.axes in ('YX', 'YXS'), 'TIFF axes are not a single interleaved image plane.')
        image = page.asarray()
    require(image.dtype in (np.dtype('uint8'), np.dtype('uint16')), 'Only unsigned 8/16-bit source pixels are supported.')
    if channels == 1:
        image = image[:, :, None]
    require(image.ndim == 3 and image.shape[2] == channels, 'Decoded TIFF shape does not match its configured channels.')
    return image, {'name': path.name, 'sha256': digest(raw), 'width': image.shape[1], 'height': image.shape[0]}


def tile_starts(size, tile, overlap):
    if size <= tile:
        return [0]
    result = list(range(0, size - tile + 1, tile - overlap))
    if result[-1] != size - tile:
        result.append(size - tile)
    return result


def validate_tensor(tensor, channels, tile, label):
    require(tensor.type == 'tensor(float)' and len(tensor.shape) == 4, f'{label} must be float32 NCHW.')
    wanted = [1, channels, *tile]
    for actual, expected in zip(tensor.shape, wanted):
        require(not isinstance(actual, int) or actual == expected,
                f'{label} fixed tensor shape {tensor.shape} conflicts with [1,{channels},{tile[0]},{tile[1]}].')


def infer(image, model_path, manifest):
    import numpy as np
    import onnxruntime as ort
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(model_path if isinstance(model_path, bytes) else str(model_path), sess_options=options, providers=['CPUExecutionProvider'])
    inputs, outputs = session.get_inputs(), session.get_outputs()
    require(len(inputs) == len(outputs) == 1, 'The model must expose exactly one input and one output.')
    tile = manifest['tile_size']
    overlap = manifest['tile_overlap']
    classes = manifest['classes']
    validate_tensor(inputs[0], image.shape[2], tile, 'Input')
    validate_tensor(outputs[0], len(classes), tile, 'Output')
    height, width = image.shape[:2]
    offsets = np.array(manifest['normalization']['offset'], dtype=np.float32)[None, None, :]
    scales = np.array(manifest['normalization']['scale'], dtype=np.float32)[None, None, :]
    y_starts = tile_starts(height, tile[0], overlap[0])
    x_starts = tile_starts(width, tile[1], overlap[1])
    require(len(y_starts) * len(x_starts) <= 10000, 'Inference would exceed 10000 tiles. Review the model tile/overlap configuration; no tiles were skipped.')
    count = 0
    # Disk-backed sums keep a 40Mpx image from requiring all class logits in RAM.
    with tempfile.TemporaryDirectory(prefix='cerebellum-logits-') as directory:
        sums = np.memmap(Path(directory) / 'sum.f32', dtype=np.float32, mode='w+', shape=(len(classes), height, width))
        weights = np.memmap(Path(directory) / 'weights.f32', dtype=np.float32, mode='w+', shape=(height, width))
        sums[:] = 0
        weights[:] = 0
        for y in y_starts:
            for x in x_starts:
                patch = image[y:y + tile[0], x:x + tile[1]]
                h, w = patch.shape[:2]
                patch = np.pad(patch, ((0, tile[0] - h), (0, tile[1] - w), (0, 0)), mode='edge')
                normalized = (patch.astype(np.float32) - offsets) / scales
                require(np.isfinite(normalized).all(), 'Normalization produced non-finite values.')
                tensor = np.ascontiguousarray(normalized.transpose(2, 0, 1)[None])
                logits = session.run([outputs[0].name], {inputs[0].name: tensor})[0]
                require(logits.shape == (1, len(classes), *tile) and logits.dtype == np.float32,
                        'Output must be float32 same-resolution logits; no resizing is performed.')
                require(np.isfinite(logits).all(), 'Model returned non-finite logits.')
                sums[:, y:y+h, x:x+w] += logits[0, :, :h, :w]
                weights[y:y+h, x:x+w] += 1
                count += 1
        labels = np.empty((height, width), dtype=np.uint8)
        for y in range(0, height, 256):
            section = slice(y, min(y + 256, height))
            require((weights[section] > 0).all(), 'Internal tiling error: an image pixel was not inferred.')
            mean = sums[:, section] / weights[section][None]
            require(np.isfinite(mean).all(), 'Blended logits overflowed; model output magnitude is unsupported.')
            labels[section] = mean.argmax(axis=0)
        del sums, weights
    return labels, count


def cell_paths(mask, x_offset=0, y_offset=0):
    """Trace exact pixel-cell boundaries, preserving all holes and components.

    A topological pinch is rejected instead of silently changing an observed mask.
    Integer pixel edges also give an exact, explicit geometric area definition.
    """
    import numpy as np
    padded = np.pad(mask, 1, constant_values=False)
    edge_sets = [
        (mask & ~padded[:-2, 1:-1], lambda x, y: ((x, y), (x+1, y))),
        (mask & ~padded[1:-1, 2:], lambda x, y: ((x+1, y), (x+1, y+1))),
        (mask & ~padded[2:, 1:-1], lambda x, y: ((x+1, y+1), (x, y+1))),
        (mask & ~padded[1:-1, :-2], lambda x, y: ((x, y+1), (x, y))),
    ]
    edge_count = sum(int(edges.sum()) for edges, _ in edge_sets)
    require(edge_count <= 2_000_000, 'Mask boundary exceeds 2 million pixel edges; no components were discarded. Review the model/noise.')
    outgoing = {}
    for edges, endpoints in edge_sets:
        ys, xs = np.nonzero(edges)
        for x, y in zip(xs.tolist(), ys.tolist()):
            start, end = endpoints(x, y)
            require(start not in outgoing, 'A mask component has a diagonal pinch/touching boundary. Repair it before polygon export; no topology was altered.')
            outgoing[start] = end
    paths = []
    while outgoing:
        start = next(iter(outgoing))
        points = [start]
        current = outgoing.pop(start)
        while current != start:
            points.append(current)
            require(current in outgoing, 'Mask boundary is not a simple closed contour.')
            current = outgoing.pop(current)
        reduced = []
        for index, point in enumerate(points):
            before, after = points[index - 1], points[(index + 1) % len(points)]
            if (point[0]-before[0]) * (after[1]-point[1]) != (point[1]-before[1]) * (after[0]-point[0]):
                reduced.append([point[0] + x_offset, point[1] + y_offset])
        require(len(reduced) >= 4, 'Empty or degenerate pixel-cell contour.')
        paths.append(reduced)
    return paths


def polygon_area(paths):
    return sum(sum(a[0]*b[1]-b[0]*a[1] for a, b in zip(path, path[1:] + path[:1])) / 2 for path in paths)


def vectorize(labels, classes):
    import numpy as np
    from scipy import ndimage
    rois = []
    counts = {}
    total_vertices = 0
    connectivity = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=np.uint8)
    for class_index, name in enumerate(classes[1:], 1):
        mask = labels == class_index
        counts[name] = int(mask.sum())
        components, count = ndimage.label(mask, structure=connectivity)
        require(len(rois) + count <= MAX_ROIS, 'More than 64 connected ROIs. No islands were discarded; review the model/noise or analyze a smaller original image.')
        for component, bounds in enumerate(ndimage.find_objects(components), 1):
            if bounds is None:
                continue
            local = components[bounds] == component
            paths = cell_paths(local, bounds[1].start, bounds[0].start)
            vertices = sum(len(path) for path in paths)
            total_vertices += vertices
            require(len(paths) <= 128 and vertices <= 5000 and total_vertices <= MAX_VERTICES,
                    'Polygon complexity exceeds review limits (128 rings/5000 vertices per ROI, 30000 total). No rings or islands were discarded.')
            require(polygon_area(paths) == int(local.sum()), 'Polygon area differs from the original predicted pixel-cell mask.')
            rois.append({'id': f'{name}-{component:03d}', 'label': name, 'paths': paths})
    require(rois, 'Model predicted background only. No fabricated ROI or empty approved measurement was produced.')
    return rois, counts


def predict(image_path, model_path, manifest_path):
    require(model_path.is_file(), 'Trained ONNX weights were not found. Supply your validated external model; no trained model is bundled.')
    require(manifest_path.is_file(), 'Model manifest not found.')
    require(manifest_path.stat().st_size <= 1024*1024, 'Manifest exceeds 1 MiB.')
    manifest_bytes = manifest_path.read_bytes()
    manifest = validate_manifest(json.loads(manifest_bytes))
    require(model_path.stat().st_size <= 512*1024*1024, 'Model exceeds the 512 MiB local adapter limit.')
    model_bytes = model_path.read_bytes()
    model_digest = digest(model_bytes)
    require(model_digest == manifest['model']['weights_sha256'], 'Model SHA-256 does not match manifest; inference was not run.')
    import onnx
    graph = onnx.load_model_from_string(model_bytes)
    def check_embedded(message):
        if isinstance(message, onnx.TensorProto):
            require(message.data_location != onnx.TensorProto.EXTERNAL and not message.external_data,
                    'External ONNX tensor files are not supported: embed all weights so the recorded SHA-256 covers the complete model.')
        for field, value in message.ListFields():
            if field.message_type is not None:
                for child in (value if field.is_repeated else [value]):
                    check_embedded(child)
    check_embedded(graph)
    image, source = read_image(image_path, manifest)
    labels, tiles = infer(image, model_bytes, manifest)
    rois, counts = vectorize(labels, manifest['classes'])
    import numpy, scipy, tifffile, onnxruntime
    return {
        'schema': 'cerebellum-prediction/1', 'source': source, 'model': manifest['model'], 'rois': rois,
        'processing': {
            'adapter': 'cerebellum-nissl-onnx', 'adapter_version': VERSION,
            'manifest_sha256': digest(manifest_bytes), 'manifest': manifest,
            'runtime': {'numpy': numpy.__version__, 'scipy': scipy.__version__, 'tifffile': tifffile.__version__, 'onnxruntime': onnxruntime.__version__, 'provider': 'CPUExecutionProvider'},
            'tile_count': tiles, 'blending': 'Arithmetic mean of overlapping logits; argmax; ties use first class index.',
            'padding': 'Edge repetition on bottom/right of incomplete tiles; no resampling.',
            'contours': 'Exact pixel-cell edges; four-connected foreground; holes retained; only collinear points removed.',
            'pixel_counts': counts, 'coordinate_system': 'Original image pixels, top-left origin, x right, y down; pixel edges at integers.',
            'status': 'Unreviewed model draft; anatomical accuracy and uncertainty are not validated by this runner.',
            'derived_CB': False,
        },
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True, type=Path)
    parser.add_argument('--model', required=True, type=Path)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        require(not args.output.exists(), 'Output already exists; choose a new path to preserve the earlier prediction.')
        result = predict(args.image, args.model, args.manifest)
        with args.output.open('x', encoding='utf-8') as output:
            json.dump(result, output, ensure_ascii=False, indent=2, allow_nan=False)
            output.write('\n')
        print(f'Unreviewed prediction saved: {args.output} ({len(result["rois"])} ROIs). Open it with the same original TIFF in Cerebellum Studio.')
        return 0
    except Exception as error:
        # Library-specific ONNX/TIFF exceptions also fail closed at the CLI boundary.
        # No partial prediction file is created when inference/validation fails.
        if isinstance(error, ImportError):
            print('Install optional CPU runner dependencies: python -m pip install -r scripts/requirements-nissl.txt', file=sys.stderr)
        print(f'Prediction stopped: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
