#!/usr/bin/env python3
"""Synthetic PDF preparation checks; no real or licensed atlas is claimed tested."""
import hashlib
import importlib.util
import json
from pathlib import Path
import random
import tempfile
import zipfile
import fitz

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('atlas_pdf_preparation', ROOT / 'scripts' / 'prepare_atlas_pdf.py')
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)


def rejects(function, expected):
    try:
        function()
    except ValueError as error:
        assert expected in str(error), str(error)
    else:
        raise AssertionError('Expected rejection: ' + expected)


def index_records(output):
    return [json.loads(line) for path in sorted((output / 'index').glob('*.jsonl')) for line in path.read_text().splitlines()]


def validate_packs(output, result, limit):
    files = []
    for entry in result['packs']:
        path = output / entry['path']
        assert path.stat().st_size <= limit
        assert P.sha256_file(path) == entry['sha256']
        with zipfile.ZipFile(path) as archive:
            assert archive.testzip() is None
            manifest = json.loads(archive.read('pack-manifest.json'))
            assert manifest['source']['sha256'] == result['source']['sha256']
            for record in manifest['files']:
                raw = archive.read(record['path'])
                assert len(raw) == record['bytes']
                assert hashlib.sha256(raw).hexdigest() == record['sha256']
                files.append(record['path'])
    assert len(files) == len(set(files)), 'A prepared file must occur in exactly one pack'
    return files


with tempfile.TemporaryDirectory() as temporary:
    folder = Path(temporary)
    source = folder / 'synthetic-atlas.pdf'
    with fitz.open() as document:
        page = document.new_page(width=300, height=200)
        page.insert_text((30, 40), 'Plate 128; AP -6.12 mm; Cb')
        note = page.add_text_annot((170, 60), 'Cb = Cerebellum (hover definition)')
        note.set_info(subject='Abbreviation', title='Synthetic author')
        note.update()
        widget = fitz.Widget()
        widget.field_name = 'Atlas-region-name'
        widget.field_label = 'Uninterpreted structure name'
        widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
        widget.field_value = 'Cerebellum'
        widget.rect = fitz.Rect(30, 120, 180, 145)
        widget.script = 'app.alert("THIS MUST NOT EXECUTE")'
        page.add_widget(widget)
        page.insert_link({'kind': fitz.LINK_URI, 'from': fitz.Rect(20, 20, 40, 40), 'uri': 'https://example.invalid/never-fetch'})
        second = document.new_page(width=400, height=220)
        second.insert_text((50, 70), 'Plate 140; AP -7.00 mm')
        second.set_rotation(90)
        document.new_page(width=250, height=250)
        document.set_page_labels([{'startpage': 0, 'prefix': 'Atlas-', 'style': 'D', 'firstpagenum': 128}])
        document.save(source)
    original_hash = P.sha256_file(source)
    original_bytes = source.read_bytes()
    output = folder / 'prepared'
    report = P.prepare(source, output, pages='1,2', dpi=72, pack_limit=12000)
    assert report['indexed_pages'] == 3 and report['selected_pages'] == [1, 2]
    assert report['source']['sha256'] == original_hash
    assert report['actions_executed'] is False and report['links_fetched'] is False
    assert report['calibration'] is None and report['anatomical_contours'] is None
    assert source.read_bytes() == original_bytes and P.sha256_file(source) == original_hash
    records = index_records(output)
    assert [record['pdf_page_number'] for record in records] == [1, 2, 3]
    assert records[0]['page_label'] == 'Atlas-128'
    assert records[0]['media_box_points'] == [0.0, 0.0, 300.0, 200.0]
    assert any('AP -6.12 mm' in block['text'] for block in records[0]['text_blocks'])
    assert records[0]['anatomical_coordinates'] is None
    assert records[0]['physical_tissue_calibration'] is None
    assert records[0]['annotations'][0]['text'] == 'Cb = Cerebellum (hover definition)'
    assert records[0]['annotations'][0]['subject'] == 'Abbreviation'
    assert records[0]['widgets'][0]['name'] == 'Atlas-region-name'
    assert records[0]['widgets'][0]['label'] == 'Uninterpreted structure name'
    assert records[0]['widgets'][0]['value'] == 'Cerebellum'
    assert 'script' not in records[0]['widgets'][0]
    assert records[1]['rotation_degrees'] == 90
    assert records[1]['display_rect_points'] == [0.0, 0.0, 220.0, 400.0]
    assert records[2]['text_status'] == 'absent_or_not_extractable'
    assert records[2]['annotation_status'] == 'none_found'
    assert records[2]['widget_status'] == 'none_found'
    files = validate_packs(output, report, 12000)
    assert len(report['packs']) > 1
    assert 'pages/page-000001.pdf' in files and 'pages/page-000002.pdf' in files
    assert not (output / 'pages' / 'page-000003.pdf').exists()
    with fitz.open(source) as original:
        for page_number in [1, 2]:
            with fitz.open(output / 'pages' / f'page-{page_number:06d}.pdf') as copied:
                assert len(copied) == 1
                expected_text = original[page_number - 1].get_text()
                if page_number == 1:
                    expected_text = expected_text.replace('Cerebellum\n', '')  # Widget appearance is explicitly omitted.
                assert copied[0].get_text() == expected_text
                assert copied[0].mediabox == original[page_number - 1].mediabox
                assert copied[0].rotation == original[page_number - 1].rotation
                assert list(copied[0].annots() or []) == [] and list(copied[0].widgets() or []) == []
                assert copied[0].get_links() == []
                # Original page display with annotation/widget appearances omitted.
                expected = original[page_number - 1].get_pixmap(dpi=72, annots=False)
                observed = copied[0].get_pixmap(dpi=72, annots=False)
                assert expected.width == observed.width and expected.height == observed.height
                assert expected.samples == observed.samples
        before_limit = P.TEXT_BYTES_PER_PAGE
        P.TEXT_BYTES_PER_PAGE = 12
        truncated = P.index_page(original[0], original_hash)
        P.TEXT_BYTES_PER_PAGE = before_limit
        assert truncated['metadata_truncated'] is True
    provenance = json.loads((output / 'pages' / 'page-000001.json').read_text())
    assert provenance['pdf_page_number'] == 1 and provenance['source']['sha256'] == original_hash
    assert provenance['preview']['width'] == 300 and provenance['preview']['height'] == 200
    assert provenance['preview']['dpi'] == 72
    assert 'annotations' in provenance['omitted_interactive_features']
    assert provenance['physical_tissue_calibration'] is None
    rejects(lambda: P.prepare(source, output, index_only=True), 'never overwritten')
    rejects(lambda: P.prepare(source, folder / 'invalid-page', pages='4'), 'outside')
    rejects(lambda: P.prepare(source, folder / 'no-mode'), 'exactly one')
    rejects(lambda: P.prepare(source, folder / 'invalid-crop', pages='1', crop=[0, 0, 10, 10]), 'requires')
    rejects(lambda: P.prepare(source, folder / 'invalid-dpi', pages='1', dpi=0), 'DPI')
    assert P.pages_from_string('1,2-3,1', 3) == [1, 2, 3]
    rejects(lambda: P.pages_from_string('3-1', 3), 'outside')
    index_only = folder / 'indexed'
    indexed = P.prepare(source, index_only, index_only=True)
    assert indexed['selected_pages'] == []
    assert not list((index_only / 'pages').iterdir()) and not list((index_only / 'previews').iterdir())
    validate_packs(index_only, indexed, P.PACK_LIMIT)
    cropped = folder / 'cropped'
    cropped_result = P.prepare(source, cropped, pages='1', dpi=144, crop=[10, 20, 110, 70])
    cropped_provenance = json.loads((cropped / 'pages' / 'page-000001.json').read_text())
    assert cropped_provenance['preview']['width'] == 200 and cropped_provenance['preview']['height'] == 100
    assert cropped_provenance['preview']['crop_display_points'] == [10.0, 20.0, 110.0, 70.0]
    with fitz.open(cropped / 'pages' / 'page-000001.pdf') as full_page:
        assert full_page[0].rect.width == 300, 'Preview crop must not crop the original static PDF page'
    validate_packs(cropped, cropped_result, P.PACK_LIMIT)

    noisy = folder / 'synthetic-image-page.pdf'
    with fitz.open() as document:
        image_page = document.new_page(width=300, height=300)
        pixels = random.Random(7).randbytes(120 * 120 * 3)
        pixmap = fitz.Pixmap(fitz.csRGB, 120, 120, pixels, False)
        image_page.insert_image(image_page.rect, pixmap=pixmap)
        document.save(noisy)
    oversized = folder / 'oversized'
    oversized_result = P.prepare(noisy, oversized, pages='1', pack_limit=12000)
    assert oversized_result['omissions'][0]['status'] == 'unsplittable_under_pack_limit'
    assert not list((oversized / 'pages').glob('*.pdf'))
    assert not list((oversized / 'previews').glob('*.png')), 'Oversize must not silently trigger a preview/downsample'
    assert json.loads((oversized / 'pages' / 'page-000001.json').read_text())['page_pdf'] is None
    validate_packs(oversized, oversized_result, 12000)

print('Atlas PDF preparation: synthetic page correspondence, inert hover metadata, unknown calibration, source integrity, explicit previews and bounded packs passed.')

Path(__file__).with_name('atlas-pdf.json').write_text(json.dumps({'pass':True,'synthetic_data':True,'actual_user_atlas_tested':False,'mac_launcher_executed':False,'pymupdf_version':fitz.VersionBind,'checks':['Original byte/hash preservation','Exact selected static-page correspondence','Inert annotation and widget metadata retained without execution','Unknown calibration remains unknown','Explicit DPI and crop provenance','Bounded 24 MiB transfer packaging and checksums','Oversized page reported without silent downsampling']},indent=2)+'\n')
