#!/usr/bin/env python3
"""The synthetic example in the repository is what its generator makes, and its picture and ROI file agree."""
from pathlib import Path
import json
import sys
import tempfile

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import make_synthetic_example as M  # noqa: E402
from nissl_lab import read_roi_zip  # noqa: E402
from roi_approve import raster  # noqa: E402

KEPT = ROOT / 'examples/synthetic-section'
ATLAS = ROOT / 'assets/atlas-open/ccfv3-bbp-25/sagittal-planes.json'


def main():
    with tempfile.TemporaryDirectory(prefix='synthetic-example-') as temp:
        out = Path(temp) / 'made'
        assert M.main(['--atlas', str(ATLAS), '--output', str(out)]) == 0
        names = sorted(p.name for p in KEPT.iterdir())
        assert names == sorted(p.name for p in out.iterdir()) == ['README.txt', 'synthetic-section.json', 'synthetic-section.tif', 'synthetic-section_ROIs.zip']
        for name in names:
            assert (KEPT / name).read_bytes() == (out / name).read_bytes(), 'The kept example differs from what the generator makes: ' + name
        assert M.main(['--atlas', str(ATLAS), '--output', str(out)]) == 2          # an existing folder is never touched
    print('ok: the kept example is exactly what the generator makes from the atlas file, and an existing folder is refused')

    record = json.loads((KEPT / 'synthetic-section.json').read_text())
    width, height = record['width'], record['height']
    raw = (KEPT / 'synthetic-section.tif').read_bytes()
    assert raw[:4] == b'II*\x00' and len(raw) > width * height * 3
    image = np.frombuffer(raw[-width * height * 3:], np.uint8).reshape(height, width, 3).astype(int)
    rois, _ = read_roi_zip(KEPT / 'synthetic-section_ROIs.zip')
    masks = {roi['name']: raster(roi, width, height) for roi in rois}
    assert sorted(masks) == ['Cb', 'GL+WM', 'GL_TOTAL', 'ML_TOTAL', 'WM']
    for name, mask in masks.items():
        assert int(mask.sum()) == record['area_px'][name], name
    assert (masks['Cb'] == (masks['ML_TOTAL'] | masks['GL_TOTAL'] | masks['WM'])).all() and (masks['GL+WM'] == (masks['GL_TOTAL'] | masks['WM'])).all()
    assert not (masks['ML_TOTAL'] & masks['GL_TOTAL']).any() and not (masks['GL_TOTAL'] & masks['WM']).any()
    print('ok: the ROI file reads back as five areas whose pixel counts match the record and that nest without overlap')

    colours = M.PARAMETERS['colours']
    for name, key in (('ML_TOTAL', 'ML'), ('GL_TOTAL', 'GL'), ('WM', 'WM')):
        assert np.abs(image[masks[name]] - colours[key]).max() <= 7, name
    assert np.abs(image[~masks['Cb']] - colours['background']).max() <= 7
    print('ok: every pixel of the picture carries the colour of the area its ROI puts it in')

    text = (KEPT / 'README.txt').read_text()
    assert 'NOT tissue' in text and 'CC BY 4.0' in text and 'Piluso' in text and 'Allen' in text
    assert record['atlas_source_sha256'] == json.loads(ATLAS.read_text())['source']['sha256']
    print('ok: the description says it is a drawing and credits the outlines')
    print('Synthetic example checks passed.')


if __name__ == '__main__':
    main()
