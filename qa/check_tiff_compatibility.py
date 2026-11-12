#!/usr/bin/env python3
"""Synthetic format-conversion checks; never reads or alters research sources."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

import numpy as np
import tifffile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('compat', ROOT / 'scripts/prepare_tiff_compatibility.py')
compat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compat)


class CompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def verify(self, name, pixels, **kwargs):
        source = self.directory / name
        tifffile.imwrite(source, pixels, metadata=None, **kwargs)
        before = source.read_bytes()
        report = compat.prepare(source, self.directory / (name + '-out'))
        target = self.directory / (name + '-out') / report['derived']['name']
        with tifffile.TiffFile(target) as result:
            self.assertFalse(result.is_bigtiff)
            self.assertEqual(len(result.pages), 1)
            self.assertTrue(np.array_equal(result.asarray(), pixels))
        self.assertEqual(source.read_bytes(), before)
        self.assertTrue(report['original_unchanged'])
        self.assertEqual(report['pixels']['source_sha256'], report['pixels']['derived_sha256'])
        self.assertEqual(report['source']['sha256'], compat.file_hash(source))
        self.assertEqual(report['derived']['sha256'], compat.file_hash(target))
        # Verify the browser's unchanged strict reader accepts the new container.
        result = subprocess.run(['node', '-e', "const fs=require('fs'),vm=require('vm');const c={console,TextDecoder,Uint8Array,ArrayBuffer,DataView,URL,Blob,pako:require('./vendor/pako.min.js')};c.globalThis=c;c.self=c;vm.runInNewContext(fs.readFileSync('vendor/UTIF.js','utf8'),c);vm.runInNewContext(fs.readFileSync('src/research_image.js','utf8'),c);c.ResearchImage.validateTIFF(new Uint8Array(fs.readFileSync(process.argv[1])));", str(target)], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return report

    def test_bigtiff_unsigned_gray_rgb_exact(self):
        self.verify('big-gray.tif', np.arange(128 * 64, dtype=np.uint16).reshape(64, 128), bigtiff=True, photometric='minisblack')
        self.verify('big-endian.tif', np.arange(64 * 32, dtype=np.uint16).reshape(32, 64), bigtiff=True, byteorder='>', photometric='minisblack')
        self.verify('big-rgb.tif', np.arange(64 * 32 * 3, dtype=np.uint16).reshape(32, 64, 3), bigtiff=True, photometric='rgb')
        self.verify('deflate.tif', np.arange(64 * 32, dtype=np.uint8).reshape(32, 64), compression='deflate', photometric='minisblack')

    def test_multipage_explicit_selection(self):
        source = self.directory / 'pages.tif'
        first = np.arange(64, dtype=np.uint8).reshape(8, 8)
        second = np.arange(64, dtype=np.uint8).reshape(8, 8) + 70
        with tifffile.TiffWriter(source, bigtiff=True) as writer:
            writer.write(first, photometric='minisblack', metadata=None)
            writer.write(second, photometric='minisblack', metadata=None)
        before = source.read_bytes()
        self.assertEqual(compat.inspect(source)['page_count'], 2)
        with self.assertRaisesRegex(ValueError, 'explicitly choose'):
            compat.prepare(source, self.directory / 'ambiguous')
        self.assertFalse((self.directory / 'ambiguous').exists())
        report = compat.prepare(source, self.directory / 'chosen', page_number=2)
        self.assertEqual(report['selected_page_1_based'], 2)
        self.assertTrue(np.array_equal(tifffile.imread(self.directory / 'chosen' / report['derived']['name']), second))
        self.assertEqual(source.read_bytes(), before)

    def test_signed_float_orientation_rejected(self):
        for name, dtype, tags in [('signed', 'int16', []), ('float', 'float32', []), ('rotated', 'uint8', [(274, 'H', 1, 3, False)])]:
            source = self.directory / (name + '.tif')
            tifffile.imwrite(source, np.ones((8, 8), dtype=dtype), extratags=tags, photometric='minisblack', metadata=None)
            before = source.read_bytes()
            with self.assertRaises(ValueError):
                compat.prepare(source, self.directory / (name + '-out'))
            self.assertEqual(source.read_bytes(), before)
            self.assertFalse((self.directory / (name + '-out')).exists())

    def test_rgba_and_whiteiszero_are_not_model_conversion(self):
        for name, pixels, options in [
            ('alpha', np.arange(8 * 8 * 4, dtype=np.uint8).reshape(8, 8, 4), {'photometric': 'rgb', 'extrasamples': ['unassalpha']}),
            ('white', np.arange(64, dtype=np.uint8).reshape(8, 8), {'photometric': 'miniswhite'}),
        ]:
            source = self.directory / (name + '.tif')
            tifffile.imwrite(source, pixels, metadata=None, **options)
            with self.assertRaisesRegex(ValueError, 'model runner'):
                compat.prepare(source, self.directory / (name + '-rejected'))
            report = compat.prepare(source, self.directory / (name + '-display'), display_only=True)
            self.assertTrue(report['display_only'])
            self.assertIn('Not established', report['model_compatibility'])
            self.assertTrue(np.array_equal(tifffile.imread(self.directory / (name + '-display') / report['derived']['name']), pixels))
        source = self.directory / 'white16.tif'
        tifffile.imwrite(source, np.ones((8, 8), dtype=np.uint16), photometric='miniswhite', metadata=None)
        with self.assertRaisesRegex(ValueError, '16-bit WhiteIsZero'):
            compat.prepare(source, self.directory / 'white16-out', display_only=True)

    def test_capacity_fails_before_pixel_decode(self):
        with self.assertRaisesRegex(ValueError, '128 MiB'):
            compat.supported(SimpleNamespace(imagewidth=6000, imagelength=6000, samplesperpixel=3, dtype=np.dtype('uint16')))
        with self.assertRaisesRegex(ValueError, '40 million'):
            compat.supported(SimpleNamespace(imagewidth=6500, imagelength=6500, samplesperpixel=1, dtype=np.dtype('uint8')))
        source = self.directory / 'overlong.tif'
        tifffile.imwrite(source, np.ones((40001, 1), dtype=np.uint8), photometric='minisblack', metadata=None)
        before = source.read_bytes()
        with self.assertRaisesRegex(ValueError, '32767'):
            compat.prepare(source, self.directory / 'overlong-out')
        self.assertEqual(source.read_bytes(), before)
        self.assertFalse((self.directory / 'overlong-out').exists())

    def test_existing_output_never_overwritten(self):
        source = self.directory / 'source.tif'
        tifffile.imwrite(source, np.ones((8, 8), dtype=np.uint8), metadata=None)
        output = self.directory / 'existing'
        output.mkdir()
        marker = output / 'keep.txt'
        marker.write_text('Existing user result')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            compat.prepare(source, output)
        self.assertEqual(marker.read_text(), 'Existing user result')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            compat.prepare(source, source)

    def test_resolution_preserved_and_changed_source_abort(self):
        report = self.verify('resolution.tif', np.ones((8, 8), dtype=np.uint8), resolution=((400, 3), (500, 7)), resolutionunit='CENTIMETER')
        target = self.directory / 'resolution.tif-out' / report['derived']['name']
        with tifffile.TiffFile(target) as image:
            self.assertEqual(image.pages[0].tags['XResolution'].value, (400, 3))
            self.assertEqual(image.pages[0].tags['YResolution'].value, (500, 7))
        source = self.directory / 'resolution.tif'
        with mock.patch.object(compat, 'file_hash', side_effect=['1' * 64, '2' * 64]):
            with self.assertRaisesRegex(ValueError, 'original changed'):
                compat.prepare(source, self.directory / 'changed')
        self.assertFalse((self.directory / 'changed').exists())


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(CompatibilityTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    report = {'pass': result.wasSuccessful(), 'synthetic_data': True, 'tests': result.testsRun,
              'numpy': np.__version__, 'tifffile': tifffile.__version__,
              'scope': 'Explicit TIFF container/page copy; exact pixels/source bytes; strict browser reader compatibility; no model validity assertion'}
    destination = ROOT / 'qa/tiff-compatibility-report.json'
    destination.write_text(json.dumps(report, indent=2) + '\n')
    raise SystemExit(0 if result.wasSuccessful() else 1)
