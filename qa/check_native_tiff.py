#!/usr/bin/env python3
"""Independent pixel comparisons for the stdlib native TIFF window adapter."""
from pathlib import Path
import hashlib
import importlib.util
import os
import struct
import tempfile
import tracemalloc

import numpy as np
import tifffile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('native_tiff', ROOT / 'scripts/native_tiff.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def reject(call):
    try:
        call()
    except (ValueError, FileExistsError):
        return
    raise AssertionError('Expected safe rejection.')


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def patch_tag(source, target, tag, value):
    data = bytearray(source.read_bytes())
    endian = '<' if data[:2] == b'II' else '>'
    ifd = struct.unpack_from(endian + 'I', data, 4)[0]
    count = struct.unpack_from(endian + 'H', data, ifd)[0]
    for i in range(count):
        offset = ifd + 2 + i * 12
        current, kind, number = struct.unpack_from(endian + 'HHI', data, offset)
        if current == tag:
            assert number == 1
            struct.pack_into(endian + ('H' if kind == 3 else 'I'), data, offset + 8, value)
            target.write_bytes(data)
            return
    raise AssertionError('Missing fixture tag.')


def main():
    with tempfile.TemporaryDirectory() as folder:
        folder = Path(folder)
        rgb = np.arange(37 * 43 * 3, dtype=np.uint8).reshape(37, 43, 3)
        gray = np.arange(37 * 43, dtype=np.uint8).reshape(37, 43)
        for endian in ('<', '>'):
            for channels, pixels in ((1, gray), (3, rgb)):
                for rows in (1, 7, 37):
                    path = folder / f'strips-{endian == ">"}-{channels}-{rows}.tif'
                    tifffile.imwrite(path, pixels, byteorder=endian, rowsperstrip=rows,
                                     photometric='minisblack' if channels == 1 else 'rgb', metadata=None)
                    before = digest(path)
                    with native.NativeTiff(path) as image:
                        assert (image.width, image.height, image.channels) == (43, 37, channels)
                        for x, y, width, height in ((0, 0, 43, 37), (4, 5, 23, 17), (42, 36, 1, 1), (0, 6, 1, 8)):
                            assert image.read_window(x, y, width, height) == pixels[y:y + height, x:x + width].tobytes()
                        assert image.metadata['whole_image_allocated'] is False
                        for bounds in ((-1, 0, 1, 1), (0, 0, 0, 1), (42, 36, 2, 1), (True, 0, 1, 1)):
                            reject(lambda b=bounds: image.read_window(*b))
                    reject(lambda: image.read_window(0, 0, 1, 1))
                    assert digest(path) == before

        for channels, pixels in ((1, gray), (3, rgb)):
            target = folder / f'written-{channels}.tif'
            native.write_tiff(target, 43, 37, pixels.tobytes(), channels=channels)
            assert np.array_equal(tifffile.imread(target), pixels)
            with tifffile.TiffFile(target) as tif:
                assert 'XResolution' not in tif.pages[0].tags and 'YResolution' not in tif.pages[0].tags
            with native.NativeTiff(target) as image:
                assert image.read_window(0, 0, 43, 37) == pixels.tobytes()
            before = digest(target)
            reject(lambda: native.write_tiff(target, 43, 37, pixels.tobytes(), channels=channels))
            assert digest(target) == before
        reject(lambda: native.write_tiff(folder / 'bad-output.tif', 2, 2, b'123'))
        assert not (folder / 'bad-output.tif').exists()

        # A real sparse, native TIFF exceeding both old 40M-pixel/128MiB limits.
        # Only small source windows are allocated by the adapter.
        large_path = folder / 'large-native.tif'
        large = tifffile.memmap(large_path, shape=(7000, 7000, 3), dtype='uint8',
                               photometric='rgb', metadata=None)
        large[6998:7000, 6997:7000] = np.arange(18, dtype=np.uint8).reshape(2, 3, 3)
        large[511:514, 511:514] = 211
        large.flush()
        expected = large[6998:7000, 6997:7000].tobytes()
        del large
        before = digest(large_path)
        tracemalloc.start()
        with native.NativeTiff(large_path) as image:
            assert image.width * image.height > 40_000_000
            assert image.read_window(6997, 6998, 3, 2) == expected
            block = image.read_window(500, 500, 512, 512)
            assert block[((511 - 500) * 512 + 511 - 500) * 3] == 211
            reject(lambda: image.read_window(0, 0, 7000, 7000))
        peak = tracemalloc.get_traced_memory()[1]
        tracemalloc.stop()
        assert peak < 4 * 1024 ** 2, peak
        assert digest(large_path) == before

        base = folder / 'written-3.tif'
        for tag, value in ((259, 8), (274, 2), (284, 2), (339, 2),
                           (273, 8), (273, 2 ** 30), (279, 1), (278, 1)):
            target = folder / f'bad-{tag}-{value}.tif'
            patch_tag(base, target, tag, value)
            reject(lambda p=target: native.NativeTiff(p))
        for name, options, array in (
                ('bigtiff', {'bigtiff': True}, rgb),
                ('uint16', {}, rgb.astype(np.uint16)),
                ('tiled', {'tile': (16, 16)}, rgb),
                ('inverted', {'photometric': 'miniswhite'}, gray),
                ('rgba', {'photometric': 'rgb'}, np.zeros((5, 5, 4), dtype=np.uint8))):
            path = folder / (name + '.tif')
            tifffile.imwrite(path, array, metadata=None, **options)
            reject(lambda p=path: native.NativeTiff(p))
        multi = folder / 'multiple.tif'
        with tifffile.TiffWriter(multi) as writer:
            writer.write(rgb, metadata=None)
            writer.write(rgb, metadata=None)
        reject(lambda: native.NativeTiff(multi))
        pyramid = folder / 'pyramid.tif'
        with tifffile.TiffWriter(pyramid) as writer:
            writer.write(rgb, metadata=None, subifds=1)
            writer.write(rgb[::2, ::2], metadata=None, subfiletype=1)
        reject(lambda: native.NativeTiff(pyramid))
        overlap = folder / 'overlap.tif'
        strip_source = folder / 'strips-False-3-7.tif'
        raw = bytearray(strip_source.read_bytes())
        ifd = struct.unpack_from('<I', raw, 4)[0]
        count = struct.unpack_from('<H', raw, ifd)[0]
        for i in range(count):
            entry = ifd + 2 + i * 12
            tag, kind, number, pointer = struct.unpack_from('<HHII', raw, entry)
            if tag == 273:
                assert kind == 4 and number > 1
                first = struct.unpack_from('<I', raw, pointer)[0]
                struct.pack_into('<I', raw, pointer + 4, first)
                break
        overlap.write_bytes(raw)
        reject(lambda: native.NativeTiff(overlap))
        truncated = folder / 'truncated.tif'
        truncated.write_bytes(base.read_bytes()[:-1])
        reject(lambda: native.NativeTiff(truncated))
        changed = folder / 'changed.tif'
        changed.write_bytes(base.read_bytes())
        with native.NativeTiff(changed) as image:
            info = changed.stat()
            os.utime(changed, ns=(info.st_atime_ns, info.st_mtime_ns + 1_000_000_000))
            reject(lambda: image.read_window(0, 0, 1, 1))
    print('PASS: exact grayscale/RGB uint8 native windows across little/big-endian strip boundaries; independent tifffile writer round-trip; 49M-pixel/147MB source with <4MiB traced Python allocations; preserved source bytes; malformed/unsupported layouts, out-of-bounds windows, source changes and overwrites rejected. Synthetic pixels only.')


if __name__ == '__main__':
    main()
