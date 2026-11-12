#!/usr/bin/env python3
"""Make the synthetic example section: a drawn image, its ROI file and a short description.

The picture is not tissue. It is one plane of the open atlas outlines painted in flat, Nissl-like colours with a coarse
texture, so that a newcomer can try the image, ROI and review steps without any research data. The ROI file holds the
same outlines the picture was painted from, so the two agree exactly. Nothing measured on it means anything.
"""
import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import roi_draft as D  # noqa: E402
from nissl_lab import require  # noqa: E402
from roi_approve import raster  # noqa: E402

PARAMETERS = {'plane_index': 10, 'um_per_pixel': 5.0, 'margin_px': 60, 'texture_block_px': 6, 'texture_seed': 20261112,
              'colours': {'background': [245, 243, 246], 'ML': [214, 196, 222], 'GL': [122, 86, 160], 'WM': [232, 222, 236]}}
README = """Synthetic example section for Cerebellum Studio

synthetic-section.tif        a drawn picture, 8-bit RGB. It is NOT tissue and NOT a microscope image.
synthetic-section_ROIs.zip   ImageJ ROI file with Cb, ML_TOTAL, GL_TOTAL, GL+WM and WM for that picture.

Pixel size: {um} micrometres per pixel (the picture is far coarser than a real montage).

How it was made: one sagittal plane ({lateral} micrometres from the midplane) of atlas outlines was painted in flat
colours with a coarse texture. The ROI file holds the outlines the picture was painted from.

Use it to try opening an image, importing ROIs, reviewing and exporting. Do not use it to judge a model or to
measure anything: a model trained on real stained tissue is not expected to draw sensible layers on a flat drawing.

Outlines: {citation}
Licence of the outlines: {license}
"""


def tiff_bytes(image):
    """An uncompressed 8-bit RGB baseline TIFF, one strip."""
    height, width, _ = image.shape
    data = image.astype(np.uint8).tobytes()
    entries = [(256, 4, 1, width), (257, 4, 1, height), (258, 3, 3, None), (259, 3, 1, 1), (262, 3, 1, 2), (273, 4, 1, None),
               (277, 3, 1, 3), (278, 4, 1, height), (279, 4, 1, len(data)), (284, 3, 1, 1)]
    ifd_at = 8
    after = ifd_at + 2 + 12 * len(entries) + 4
    bits_at, data_at = after, after + 6
    out = bytearray(b'II' + struct.pack('<HI', 42, ifd_at) + struct.pack('<H', len(entries)))
    for tag, kind, count, value in entries:
        value = bits_at if tag == 258 else data_at if tag == 273 else value
        out += struct.pack('<HHI', tag, kind, count) + (struct.pack('<I', value) if kind == 4 or count > 1 else struct.pack('<HH', value, 0))
    out += struct.pack('<I', 0) + struct.pack('<HHH', 8, 8, 8) + data
    return bytes(out)


def make(atlas, parameters):
    plate = atlas['plates'][parameters['plane_index']]
    scale, margin = 1 / parameters['um_per_pixel'], parameters['margin_px']
    rings = {name: [p['points'] for p in plate['paths'] if p['compartment'] == name] for name in ('Cb', 'GL+WM', 'WM')}
    points = np.asarray([pt for group in rings.values() for ring in group for pt in ring], float)
    left, top = points[:, 0].min(), points[:, 1].max()
    to_px = lambda ring: [[int(round((x - left) * scale)) + margin, int(round((top - y) * scale)) + margin] for x, y in ring]
    width = int(round((points[:, 0].max() - left) * scale)) + 2 * margin
    height = int(round((top - points[:, 1].min()) * scale)) + 2 * margin
    drawn = {name: raster({'paths': [to_px(ring) for ring in group]}, width, height) for name, group in rings.items()}
    # Layers come from nested outlines, so they tile the cerebellum without gaps or overlap.
    inner = drawn['GL+WM'] & drawn['Cb']
    white = drawn['WM'] & inner
    masks = {'ML': drawn['Cb'] & ~inner, 'GL': inner & ~white, 'WM': white}
    labels = {'Cb': masks['ML'] | masks['GL'] | masks['WM'], 'ML_TOTAL': masks['ML'], 'GL_TOTAL': masks['GL'],
              'GL+WM': masks['GL'] | masks['WM'], 'WM': masks['WM']}
    rois = [{'name': name, 'kind': 'area', 'paths': [[list(map(int, p)) for p in path] for path in D.trace_mask(mask)]}
            for name, mask in labels.items()]
    colours = parameters['colours']
    image = np.empty((height, width, 3), np.int16)
    image[:] = colours['background']
    for name in ('ML', 'GL', 'WM'):
        image[masks[name]] = colours[name]
    block = parameters['texture_block_px']
    coarse = np.random.RandomState(parameters['texture_seed']).randint(-7, 8, (height // block + 1, width // block + 1))
    image += np.kron(coarse, np.ones((block, block), np.int16))[:height, :width, None]
    areas = {name: int(mask.sum()) for name, mask in labels.items()}
    return np.clip(image, 0, 255).astype(np.uint8), rois, areas, plate


def main(argv=None):
    parser = argparse.ArgumentParser(description='Make the synthetic example section from one plane of the open atlas outlines.')
    parser.add_argument('--atlas', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path, help='New folder; an existing one is never touched.')
    args = parser.parse_args(argv)
    try:
        require(not args.output.exists(), 'The output folder already exists.')
        atlas = json.loads(args.atlas.read_text(encoding='utf-8'))
        require(atlas.get('schema') == 'cerebellum-atlas-plane-series/1', 'Not an atlas plane series.')
        image, rois, areas, plate = make(atlas, PARAMETERS)
        args.output.mkdir(parents=True)
        (args.output / 'synthetic-section.tif').write_bytes(tiff_bytes(image))
        (args.output / 'synthetic-section_ROIs.zip').write_bytes(D.roi_zip_bytes(rois))
        (args.output / 'README.txt').write_text(README.format(um='%g' % PARAMETERS['um_per_pixel'], lateral='%g' % plate['lateral_um'],
                                                             citation=atlas['source']['citation'], license=atlas['source']['license']), encoding='utf-8')
        (args.output / 'synthetic-section.json').write_text(json.dumps(
            {'schema': 'cerebellum-synthetic-example/1', 'statement': 'A drawing, not tissue. Nothing measured on it means anything.',
             'parameters': PARAMETERS, 'atlas_plate': plate['id'], 'atlas_source_sha256': atlas['source']['sha256'],
             'width': int(image.shape[1]), 'height': int(image.shape[0]), 'area_px': areas}, indent=1) + '\n', encoding='utf-8')
    except (ValueError, OSError, KeyError) as error:
        print('Not made: ' + str(error), file=sys.stderr)
        return 2
    print(json.dumps({'width': int(image.shape[1]), 'height': int(image.shape[0]), 'area_px': areas}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
