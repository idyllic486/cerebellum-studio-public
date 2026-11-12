#!/usr/bin/env python3
"""Read a local atlas PDF and prepare bounded, explicitly selected research extracts.

No PDF actions are executed, no links are fetched, and labels are not anatomical ROIs.
The source is opened read-only by pathname; its bytes are hashed in bounded chunks.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys
import zipfile

VERSION = '1.0.0'
PACK_LIMIT = 24 * 1024 * 1024
INDEX_CHUNK_LIMIT = 4 * 1024 * 1024
TEXT_BYTES_PER_PAGE = 256 * 1024
MAX_METADATA_ITEMS = 512
MAX_PREVIEW_PIXELS = 64_000_000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode('utf-8')


def write_json(path, value):
    with Path(path).open('xb') as stream:
        stream.write(json_bytes(value))


def pages_from_string(value, count):
    chosen = set()
    require(isinstance(value, str) and value.strip(), 'Provide --pages with one-based PDF page numbers, for example 128,140,150.')
    for token in value.split(','):
        parts = token.strip().split('-')
        require(len(parts) in (1, 2) and all(x.strip().isdigit() for x in parts), 'Pages must be comma-separated integers or ascending ranges.')
        start, end = int(parts[0]), int(parts[-1])
        require(1 <= start <= end <= count, f'Page range {token!r} is outside this {count}-page PDF.')
        require(end - start < 500, 'Select at most 500 pages per preparation run.')
        chosen.update(range(start, end + 1))
        require(len(chosen) <= 500, 'Select at most 500 pages per preparation run.')
    return sorted(chosen)


def rect_values(rect):
    return [float(rect.x0), float(rect.y0), float(rect.x1), float(rect.y1)]


def index_page(page, source_hash):
    """Extract inert text and locations only, with explicit metadata limits."""
    import fitz
    remaining = TEXT_BYTES_PER_PAGE
    truncated = False

    def bounded(value):
        nonlocal remaining, truncated
        if value is None:
            return None
        data = str(value).encode('utf-8', errors='replace')
        if len(data) > remaining:
            data = data[:remaining]
            truncated = True
        remaining -= len(data)
        return data.decode('utf-8', errors='ignore')

    record = {
        'schema': 'cerebellum-atlas-pdf-page/1', 'source_sha256': source_hash,
        'pdf_page_number': page.number + 1, 'pdf_page_index': page.number,
        'page_label': bounded(page.get_label()),
        'media_box_points': rect_values(page.mediabox), 'crop_box_points': rect_values(page.cropbox),
        'display_rect_points': rect_values(page.rect), 'rotation_degrees': page.rotation,
        'pdf_point_definition': '1/72 inch of page layout; not brain tissue scale',
        'text_coordinate_frame': 'PyMuPDF unrotated page coordinates in PDF points',
        'text_blocks': [], 'annotations': [], 'widgets': [], 'metadata_errors': [],
        'anatomical_coordinates': None, 'physical_tissue_calibration': None,
        'interpretation': 'Text, coordinate labels and abbreviation definitions are uninterpreted source strings. Rectangles locate text/annotations; they are not anatomical contours.',
    }
    try:
        blocks = page.get_text('blocks', flags=fitz.TEXTFLAGS_BLOCKS & ~fitz.TEXT_PRESERVE_IMAGES)
        for block in blocks[:MAX_METADATA_ITEMS]:
            if len(block) > 6 and block[6] != 0:
                continue
            record['text_blocks'].append({'bbox_points': [float(v) for v in block[:4]], 'text': bounded(block[4])})
        if len(blocks) > MAX_METADATA_ITEMS:
            truncated = True
    except Exception as error:
        record['metadata_errors'].append('Text extraction unavailable: ' + str(error)[:500])
    record['text_status'] = 'present' if any(b['text'].strip() for b in record['text_blocks']) else 'absent_or_not_extractable'
    try:
        for number, annotation in enumerate(page.annots() or []):
            if number >= MAX_METADATA_ITEMS:
                truncated = True
                break
            info = annotation.info
            record['annotations'].append({'subtype': bounded(annotation.type[1]), 'bbox_points': rect_values(annotation.rect),
                'text': bounded(info.get('content')), 'subject': bounded(info.get('subject')), 'title': bounded(info.get('title'))})
        record['annotation_status'] = 'present' if record['annotations'] else 'none_found'
    except Exception as error:
        record['annotation_status'] = 'partially_or_not_extractable'
        record['metadata_errors'].append('Annotation metadata unavailable: ' + str(error)[:500])
    try:
        for number, widget in enumerate(page.widgets() or []):
            if number >= MAX_METADATA_ITEMS:
                truncated = True
                break
            record['widgets'].append({'type': bounded(widget.field_type_string), 'bbox_points': rect_values(widget.rect),
                'name': bounded(widget.field_name), 'label': bounded(widget.field_label), 'value': bounded(widget.field_value)})
        record['widget_status'] = 'present' if record['widgets'] else 'none_found'
    except Exception as error:
        record['widget_status'] = 'partially_or_not_extractable'
        record['metadata_errors'].append('Widget metadata unavailable: ' + str(error)[:500])
    record['metadata_truncated'] = truncated
    record['text_budget_bytes'] = TEXT_BYTES_PER_PAGE
    record['actions_executed'] = False
    return record


def file_record(path, output, kind, page=None):
    result = {'path': path.relative_to(output).as_posix(), 'kind': kind,
              'bytes': path.stat().st_size, 'sha256': sha256_file(path)}
    if page is not None:
        result['pdf_page_number'] = page
    return result


def pack_manifest(entries, source, number, limit):
    return {'schema': 'cerebellum-atlas-pdf-pack/1', 'version': VERSION, 'pack_number': number,
            'source': source, 'maximum_pack_bytes': limit, 'files': entries,
            'interpretation': 'PDF reference material and uninterpreted metadata; not segmented anatomy or a volumetric atlas.'}


def zip_size(entries, manifest):
    # All generated archive names are ASCII; ZIP_STORED adds exactly these headers.
    name = 'pack-manifest.json'
    return 22 + len(json_bytes(manifest)) + 76 + 2 * len(name) + sum(e['bytes'] + 76 + 2 * len(e['path'].encode('utf-8')) for e in entries)


def make_packs(entries, source, output, limit):
    groups, current = [], []
    for entry in entries:
        test = current + [entry]
        manifest = pack_manifest(test, source, len(groups) + 1, limit)
        if zip_size(test, manifest) <= limit:
            current = test
            continue
        if current:
            groups.append(current)
            current = []
        require(zip_size([entry], pack_manifest([entry], source, len(groups) + 1, limit)) <= limit,
                'An export cannot fit within one transfer pack: ' + entry['path'])
        current = [entry]
    if current:
        groups.append(current)
    result = []
    for number, group in enumerate(groups, 1):
        path = output / 'packs' / f'atlas-pack-{number:04d}.zip'
        manifest = pack_manifest(group, source, number, limit)
        with zipfile.ZipFile(path, 'x', compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
            for entry in group:
                archive.write(output / entry['path'], entry['path'])
            archive.writestr('pack-manifest.json', json_bytes(manifest))
        require(path.stat().st_size <= limit, 'Unexpected ZIP overhead exceeded the transfer bound.')
        result.append(file_record(path, output, 'transfer_pack'))
    return result


def prepare(input_path, output_path, pages=None, index_only=False, dpi=None, crop=None, pack_limit=PACK_LIMIT):
    import fitz
    source_path, output = Path(input_path).expanduser().resolve(), Path(output_path).expanduser().resolve()
    require(source_path.is_file(), 'The local source PDF was not found.')
    require(not output.exists(), 'Output already exists; choose a new folder. Existing files are never overwritten.')
    require(index_only != (pages is not None), 'Choose exactly one of --index-only or --pages.')
    require(dpi is None or type(dpi) is int and 36 <= dpi <= 600, 'Explicit preview DPI must be an integer from 36 to 600.')
    require(not index_only or dpi is None, 'A preview requires explicit selected --pages.')
    require(crop is None or dpi is not None, '--crop requires an explicit --dpi; crops are display previews only.')
    require(4096 <= pack_limit <= PACK_LIMIT, 'Transfer pack limit must not exceed 24 MiB.')
    if crop is not None:
        require(len(crop) == 4 and all(isinstance(v, (int, float)) and math.isfinite(v) for v in crop) and crop[0] < crop[2] and crop[1] < crop[3], 'Crop must be finite x0,y0,x1,y1 PDF display-page points.')
    initial_stat = source_path.stat()
    source_hash = sha256_file(source_path)
    with fitz.open(str(source_path)) as document:
        require(document.is_pdf and not document.needs_pass, 'Provide an accessible, unencrypted PDF; this tool does not bypass encryption.')
        require(0 < document.page_count <= 100000, 'PDF page count is outside the supported range.')
        chosen = [] if index_only else pages_from_string(pages, document.page_count)
        chosen_set = set(chosen)
        source = {'name': source_path.name, 'bytes': initial_stat.st_size, 'sha256': source_hash, 'pdf_page_count': document.page_count}
        output.mkdir(parents=True, exist_ok=False)
        for name in ('index', 'pages', 'previews', 'packs'):
            (output / name).mkdir()
        entries, omissions, extracted = [], [], []
        index_number, index_bytes, index_stream = 0, 0, None
        index_path = None
        # Leave bounded room for a single-file pack's provenance and ZIP headers.
        index_bound = min(INDEX_CHUNK_LIMIT, pack_limit - 2048)
        try:
            for index in range(document.page_count):
                page = document.load_page(index)
                record = index_page(page, source_hash)
                encoded = json_bytes(record)
                require(len(encoded) <= index_bound, 'A page metadata record exceeds the bounded index chunk. No text was silently dropped to make it fit.')
                if index_stream is None or index_bytes + len(encoded) > index_bound:
                    if index_stream is not None:
                        index_stream.close()
                        entries.append(file_record(index_path, output, 'page_index'))
                    index_number += 1
                    index_path = output / 'index' / f'page-index-{index_number:04d}.jsonl'
                    index_stream = index_path.open('xb')
                    index_bytes = 0
                index_stream.write(encoded)
                index_bytes += len(encoded)
                page_number = index + 1
                if page_number not in chosen_set:
                    continue
                prefix = f'page-{page_number:06d}'
                pdf_path = output / 'pages' / (prefix + '.pdf')
                with fitz.open() as single:
                    single.insert_pdf(document, from_page=index, to_page=index, links=False, annots=False, widgets=False)
                    single.save(str(pdf_path), garbage=0, deflate=False)
                pdf_entry = file_record(pdf_path, output, 'static_page_pdf', page_number)
                provenance = {'schema': 'cerebellum-atlas-pdf-extraction/1', 'version': VERSION, 'source': source,
                    'pdf_page_number': page_number, 'pdf_page_index': index, 'page_label': record['page_label'],
                    'media_box_points': record['media_box_points'], 'crop_box_points': record['crop_box_points'],
                    'display_rect_points': record['display_rect_points'], 'rotation_degrees': page.rotation,
                    'content': 'Original page graphics, text and images copied without rasterisation or resampling; PDF container bytes are newly written.',
                    'omitted_interactive_features': ['links', 'annotations', 'widgets', 'document-level navigation/actions'],
                    'inert_annotation_metadata': 'Preserved where extractable in the indexed source page; bounded/truncated status is explicit.',
                    'source_unchanged': True, 'anatomical_coordinates': None, 'physical_tissue_calibration': None,
                    'preview': None}
                if zip_size([pdf_entry], pack_manifest([pdf_entry], source, 1, pack_limit)) <= pack_limit:
                    entries.append(pdf_entry)
                    provenance['page_pdf'] = pdf_entry
                else:
                    pdf_path.unlink()
                    provenance['page_pdf'] = None
                    omissions.append({'pdf_page_number': page_number, 'kind': 'static_page_pdf', 'bytes': pdf_entry['bytes'],
                        'status': 'unsplittable_under_pack_limit', 'sha256': pdf_entry['sha256'],
                        'reason': 'One losslessly extracted page exceeds one bounded transfer pack. No automatic resampling or crop was applied.',
                        'next_step': 'Request an explicit --dpi preview and optionally --crop x0,y0,x1,y1. Such a preview is not a replacement for the full source.'})
                if dpi is not None:
                    clip = fitz.Rect(crop) if crop is not None else page.rect
                    require(not clip.is_empty and page.rect.contains(clip), f'Crop is outside PDF page {page_number}; no automatic clipping was applied.')
                    pixel_bound = math.ceil(clip.width * dpi / 72 + 2) * math.ceil(clip.height * dpi / 72 + 2)
                    if pixel_bound > MAX_PREVIEW_PIXELS:
                        omissions.append({'pdf_page_number': page_number, 'kind': 'preview', 'status': 'render_bound_exceeded',
                            'estimated_pixels': pixel_bound, 'reason': 'Preview exceeds 64 million pixels. Request a lower DPI or smaller explicit crop.'})
                    else:
                        png_path = output / 'previews' / (prefix + '.png')
                        pixmap = page.get_pixmap(dpi=dpi, clip=clip, alpha=False, annots=False)
                        pixmap.save(str(png_path))
                        preview_entry = file_record(png_path, output, 'display_preview_png', page_number)
                        preview = {'dpi': dpi, 'crop_display_points': rect_values(clip), 'width': pixmap.width, 'height': pixmap.height,
                            'purpose': 'Explicitly rendered display preview; not native image pixels, anatomical coordinates or a physical calibration.'}
                        del pixmap
                        if zip_size([preview_entry], pack_manifest([preview_entry], source, 1, pack_limit)) <= pack_limit:
                            entries.append(preview_entry)
                            provenance['preview'] = {**preview, **preview_entry}
                        else:
                            png_path.unlink()
                            omissions.append({'pdf_page_number': page_number, 'kind': 'preview', 'status': 'unsplittable_under_pack_limit',
                                'bytes': preview_entry['bytes'], 'reason': 'The explicitly requested preview is too large. Request a lower DPI or smaller crop.'})
                provenance_path = output / 'pages' / (prefix + '.json')
                write_json(provenance_path, provenance)
                entries.append(file_record(provenance_path, output, 'page_provenance', page_number))
                extracted.append(page_number)
        finally:
            if index_stream is not None:
                index_stream.close()
        if index_path is not None:
            entries.append(file_record(index_path, output, 'page_index'))
        final_stat = source_path.stat()
        require((initial_stat.st_size, initial_stat.st_mtime_ns) == (final_stat.st_size, final_stat.st_mtime_ns),
                'Source size or modification time changed during preparation; this result must not be used.')
        summary = {'schema': 'cerebellum-atlas-pdf-preparation/1', 'version': VERSION, 'source': source,
            'indexed_pages': document.page_count, 'selected_pages': extracted, 'maximum_pack_bytes': pack_limit,
            'static_page_pdfs_exported': sum(e['kind'] == 'static_page_pdf' for e in entries),
            'preview_pngs_exported': sum(e['kind'] == 'display_preview_png' for e in entries),
            'source_stat_unchanged': True, 'source_access': 'Read-only pathname; SHA-256 streamed in 1 MiB chunks. No source write or installer execution.',
            'omissions': omissions, 'actions_executed': False, 'links_fetched': False,
            'calibration': None, 'anatomical_contours': None,
            'limits': {'page_text_bytes': TEXT_BYTES_PER_PAGE, 'metadata_items_per_type': MAX_METADATA_ITEMS, 'preview_pixels': MAX_PREVIEW_PIXELS},
            'interpretation': 'Preparation of reference pages only. Unknown calibration and uninterpreted labels do not establish a complete 3D anatomical atlas.'}
        source_path_out = output / 'source.json'
        write_json(source_path_out, summary)
        entries.append(file_record(source_path_out, output, 'source_manifest'))
        packs = make_packs(entries, source, output, pack_limit)
        summary['packs'] = packs
        write_json(output / 'preparation-report.json', summary)
        return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, help='Local source PDF, including files larger than the chat upload limit')
    parser.add_argument('--output', required=True, help='New output folder; existing folders are never overwritten')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--index-only', action='store_true', help='Index every page without exporting page PDFs or previews')
    mode.add_argument('--pages', help='One-based PDF page numbers, such as 128,140,150 or 128-132')
    parser.add_argument('--dpi', type=int, help='Explicit optional PNG display-preview resolution (36–600 DPI)')
    parser.add_argument('--crop', help='Optional PNG crop x0,y0,x1,y1 in PDF display-page points; requires --dpi')
    args = parser.parse_args(argv)
    try:
        crop = [float(x) for x in args.crop.split(',')] if args.crop else None
        result = prepare(args.input, args.output, pages=args.pages, index_only=args.index_only, dpi=args.dpi, crop=crop)
        print(json.dumps({'indexed_pages': result['indexed_pages'], 'selected_pages': result['selected_pages'],
            'static_page_pdfs_exported': result['static_page_pdfs_exported'], 'preview_pngs_exported': result['preview_pngs_exported'],
            'packs': len(result['packs']), 'omissions': result['omissions'],
            'report': str(Path(args.output).expanduser().resolve() / 'preparation-report.json')}, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError, RuntimeError) as error:
        print('Atlas preparation stopped: ' + str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
