#!/usr/bin/env python3
"""Inspect a TIFF, then copy an explicitly selected page to a NEW Classic TIFF.

No resampling, cropping, orientation transform, color conversion, inversion,
channel dropping or intensity normalization is performed. The input is read-only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

VERSION = '1.0.0'
MAX_PIXELS = 40_000_000
MAX_DECODED = 128 * 1024 * 1024
MAX_PAGES = 1000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def file_hash(path):
    result = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def tag_value(page, name, default=None):
    tag = page.tags.get(name)
    return tag.value if tag else default


def page_metadata(page, index):
    return {
        'page_1_based': index + 1, 'width': int(page.imagewidth),
        'height': int(page.imagelength), 'dtype': str(page.dtype),
        'axes': page.axes, 'samples_per_pixel': int(page.samplesperpixel),
        'photometric': int(page.photometric), 'compression': int(page.compression),
        'orientation': int(tag_value(page, 'Orientation', 1)),
        'planar_configuration': int(page.planarconfig or 1),
        'sub_ifds_present': bool(page.subifds),
        'resolution': {name: tag_value(page, name) for name in ('XResolution', 'YResolution', 'ResolutionUnit')},
        'decoded_bytes': int(page.imagewidth * page.imagelength * page.samplesperpixel * page.dtype.itemsize),
    }


def supported(page, display_only=False):
    import numpy as np
    width, height, channels = int(page.imagewidth), int(page.imagelength), int(page.samplesperpixel)
    require(0 < width * height <= MAX_PIXELS and width <= 32767 and height <= 32767,
            'Page exceeds 40 million pixels or the ImageJ 32767-pixel dimension limit. No crop or resampling is allowed.')
    require(page.dtype.kind == 'u' and page.dtype.itemsize in (1, 2),
            'Signed and floating-point data are unsupported. No intensity conversion is performed.')
    require(width * height * channels * page.dtype.itemsize <= MAX_DECODED,
            'Page exceeds the 128 MiB decoded-pixel limit.')
    require(int(tag_value(page, 'Orientation', 1)) == 1,
            'Orientation must be 1. No rotation or mirror transform is inferred; source ROI coordinates must remain unchanged.')
    require(not page.subifds, 'Sub-IFD/pyramid page is ambiguous. Select an explicitly exported original-resolution image plane first.')
    require(int(page.planarconfig or 1) == 1 and page.axes in ('YX', 'YXS'),
            'Use an interleaved single image plane. Planar channels and ambiguous axes are unsupported.')
    photo = int(page.photometric)
    gray = channels == 1 and photo in (0, 1)
    rgb = channels in (3, 4) and photo == 2
    require(gray or rgb, 'Only unsigned 8/16-bit grayscale or RGB(A) pixels are supported; no color interpretation is inferred.')
    require(not (photo == 0 and page.dtype.itemsize == 2),
            '16-bit WhiteIsZero is unsupported by the browser. No inversion is performed.')
    if channels == 4:
        require(tuple(int(value) for value in page.extrasamples) == (2,),
                'RGBA requires exactly one unassociated alpha channel; no channel is dropped or reinterpreted.')
    if channels == 4 or photo == 0:
        require(display_only,
                'RGBA or WhiteIsZero is not supported by the Nissl model runner. Use --display-only only for observation/review; pixels will not be altered.')
    require(np.dtype(page.dtype).kind == 'u', 'Unsupported pixel type.')
    return {'width': width, 'height': height, 'channels': channels, 'photometric': photo,
            'display_only': channels == 4 or photo == 0}


def pixel_hash(array):
    """Canonical logical pixel hash: shape + unsigned dtype + C-order little-endian samples."""
    import numpy as np
    dtype = np.dtype('u1' if array.dtype.itemsize == 1 else '<u2')
    canonical = np.ascontiguousarray(array, dtype=dtype)
    header = json.dumps({'shape': list(array.shape), 'dtype': 'uint8' if dtype.itemsize == 1 else 'uint16'},
                        sort_keys=True, separators=(',', ':')).encode('utf-8')
    result = hashlib.sha256(header + b'\0')
    result.update(memoryview(canonical).cast('B'))
    return result.hexdigest()


def inspect(path):
    import tifffile
    path = Path(path).expanduser().resolve(strict=True)
    require(path.is_file(), 'Input must be a regular TIFF file.')
    pages = []
    with tifffile.TiffFile(path) as image:
        for index, page in enumerate(image.pages):
            require(index < MAX_PAGES, 'More than 1000 pages; split/index the source explicitly before using this bounded tool.')
            metadata = page_metadata(page, index)
            try:
                supported(page)
                metadata['conversion_eligible'] = True
            except ValueError as error:
                metadata['conversion_eligible'] = False
                metadata['reason'] = str(error)
            pages.append(metadata)
        require(pages, 'No TIFF image pages found.')
        return {'schema': 'cerebellum-tiff-inspection/1', 'source_name': path.name,
                'source_bytes': path.stat().st_size, 'big_tiff': bool(image.is_bigtiff),
                'page_count': len(pages), 'pages': pages,
                'note': 'Metadata inspection only; conversion eligibility is not an anatomical or model validation.'}


def prepare(input_path, output_directory, page_number=None, display_only=False):
    import numpy as np
    import tifffile
    source = Path(input_path).expanduser().resolve(strict=True)
    require(source.is_file(), 'Input must be a regular TIFF file.')
    destination = Path(output_directory).expanduser().absolute()
    require(not destination.exists(), 'Output directory already exists. Choose a new directory; no existing file will be overwritten.')
    require(destination.parent.is_dir(), 'The parent of the new output directory must already exist.')
    inspection = inspect(source)
    if page_number is None:
        require(inspection['page_count'] == 1,
                'This TIFF contains multiple pages. Inspect it, then explicitly choose --page N (1-based). No page is selected automatically.')
        page_number = 1
    require(type(page_number) is int and 1 <= page_number <= inspection['page_count'], 'Selected page is outside the TIFF page range.')
    before_hash = file_hash(source)
    with tifffile.TiffFile(source) as image:
        page = image.pages[page_number - 1]
        info = supported(page, display_only=display_only)
        metadata = page_metadata(page, page_number - 1)
        try:
            pixels = page.asarray(maxworkers=1)
        except Exception as error:
            raise ValueError('The selected compression could not be decoded with the pinned tools. No conversion was made. '
                             'Keep the original and use an explicitly documented unsigned, uncompressed export. Details: ' + str(error)) from error
        expected = (info['height'], info['width']) if info['channels'] == 1 else (info['height'], info['width'], info['channels'])
        require(pixels.shape == expected and pixels.nbytes <= MAX_DECODED,
                'Decoded shape or allocation differs from the inspected single plane.')
        source_pixel_hash = pixel_hash(pixels)
        resolution = metadata['resolution']
    destination.mkdir(exist_ok=False)
    target = destination / f'{source.stem}-page-{page_number:04d}-classic.tif'
    report_path = destination / 'tiff-compatibility-report.json'
    created = []
    try:
        options = {'bigtiff': False, 'byteorder': '<', 'photometric': info['photometric'],
                   'planarconfig': 'contig', 'compression': None, 'metadata': None,
                   'rowsperstrip': min(info['height'], 256), 'extratags': [(274, 'H', 1, 1, False)]}
        if info['channels'] == 4:
            options['extrasamples'] = ('unassalpha',)
        if resolution['XResolution'] is not None and resolution['YResolution'] is not None:
            options['resolution'] = (resolution['XResolution'], resolution['YResolution'])
            if resolution['ResolutionUnit'] is not None:
                options['resolutionunit'] = int(resolution['ResolutionUnit'])
        with target.open('xb') as handle:
            created.append(target)
            tifffile.imwrite(handle, pixels, **options)
            handle.flush()
            os.fsync(handle.fileno())
        require(target.stat().st_size <= MAX_DECODED,
                'The Classic TIFF including its header exceeds the 128 MiB browser file limit. No resizing was performed.')
        with tifffile.TiffFile(target) as derived:
            require(not derived.is_bigtiff and len(derived.pages) == 1, 'Derived container validation failed.')
            supported(derived.pages[0], display_only=display_only)
            check = derived.pages[0].asarray(maxworkers=1)
            require(check.dtype.kind == pixels.dtype.kind and check.dtype.itemsize == pixels.dtype.itemsize
                    and np.array_equal(check, pixels) and pixel_hash(check) == source_pixel_hash,
                    'Derived pixel equality check failed; no compatible image is released.')
        require(file_hash(source) == before_hash, 'The original changed during conversion. The derived result has been discarded.')
        report = {'schema': 'cerebellum-tiff-compatibility/1', 'tool_version': VERSION,
                  'dependencies': {'numpy': np.__version__, 'tifffile': tifffile.__version__},
                  'source': {'name': source.name, 'bytes': source.stat().st_size, 'sha256': before_hash,
                             'big_tiff': inspection['big_tiff'], 'page_count': inspection['page_count']},
                  'selected_page_1_based': page_number, 'source_page_metadata': metadata,
                  'derived': {'name': target.name, 'bytes': target.stat().st_size, 'sha256': file_hash(target),
                              'container': 'Classic TIFF', 'compression': 'none', 'page_count': 1},
                  'pixels': {'source_sha256': source_pixel_hash, 'derived_sha256': pixel_hash(check),
                             'equality_verified': True, 'shape': list(pixels.shape), 'dtype': str(pixels.dtype),
                             'hash_definition': 'SHA-256 of sorted compact JSON {dtype:uint8|uint16,shape:[...]} + NUL + C-order little-endian samples'},
                  'coordinate_transform': 'identity; no crop, resampling, rotation or mirroring',
                  'intensity_transform': 'none; no scaling, inversion, channel removal or color conversion',
                  'calibration': 'TIFF X/Y resolution and resolution unit copied when present; verify physical calibration in the study.',
                  'metadata_policy': 'Only pixel interpretation, orientation=1 and TIFF resolution are copied. Vendor/OME/ImageJ descriptions remain in the unchanged original.',
                  'display_only': info['display_only'], 'model_compatibility': 'Not established; model input and validation requirements still apply.',
                  'original_unchanged': True,
                  'instructions': 'Keep the original and this report. Select the NEW Classic TIFF in the website. Original ROI coordinates remain applicable only if they refer to this exact selected page.'}
        with report_path.open('x', encoding='utf-8') as handle:
            created.append(report_path)
            json.dump(report, handle, indent=2, ensure_ascii=False)
            handle.write('\n')
        return report
    except Exception:
        for path in created:
            path.unlink(missing_ok=True)
        try:
            destination.rmdir()
        except OSError:
            pass
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--inspect', action='store_true', help='Print metadata only; do not decode or write an image.')
    parser.add_argument('--page', type=int, help='Explicit 1-based page number; required for multi-page TIFF.')
    parser.add_argument('--output-directory', type=Path, help='A NEW directory; existing paths are never overwritten.')
    parser.add_argument('--display-only', action='store_true', help='Allow 8-bit WhiteIsZero or unassociated RGBA for observation/review, not the Nissl model runner.')
    args = parser.parse_args(argv)
    try:
        require(args.inspect or args.output_directory is not None, 'Choose --inspect or provide --output-directory.')
        report = inspect(args.input) if args.inspect else prepare(args.input, args.output_directory, args.page, args.display_only)
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0
    except (OSError, ValueError, ImportError) as error:
        print('Could not prepare TIFF: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
