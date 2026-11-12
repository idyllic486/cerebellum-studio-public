# Prepare a large local atlas PDF

An atlas PDF larger than 1 GB can stay on the Mac. This local helper indexes its pages and exports only explicitly selected pages into transfer ZIPs of **at most 24 MiB each**. It does not require uploading the complete PDF, installing an atlas-specific viewer, or running any installer supplied with the atlas. Python and PyMuPDF are the only dependencies of this preparation step.

The current cloud workspace has not inspected the user's original atlas PDF. The supplied descriptions of hover definitions, navigation and image resolutions do not establish the actual page content, anatomical coordinate conventions or image calibration. The helper's tests use synthetic PDFs only. The existing lower-resolution PDF also exceeds the current 32 MiB file-transfer tool limit; calling it “low resolution” does not make it transferable through that limit.

## Run on the Mac

Save `prepare_atlas_pdf.py` and `requirements-atlas-pdf.txt` into the same local working folder, open Terminal in that folder, and create a Python environment:

```bash
python3 -m venv .venv-atlas
source .venv-atlas/bin/activate
python -m pip install -r requirements-atlas-pdf.txt
```

Start with the index. Replace the example input with the actual local PDF path; dragging the PDF into Terminal after `--input` can insert its path. The output must be a **new folder**.

```bash
python prepare_atlas_pdf.py \
  --input '/Volumes/金/郭永貴/atlas.pdf' \
  --output "$HOME/Desktop/atlas-index" \
  --index-only
```

This reads one PDF page at a time, using the source pathname rather than reading the whole file into a Python byte array. The source SHA-256 is calculated in 1 MiB chunks. No page images are rendered in index-only mode. The native PDF library still needs working memory for PDF structures and each processed page, so this is not a fixed-RAM guarantee for every possible PDF.

Share `preparation-report.json` and the ZIPs in `atlas-index/packs/`. These contain the page index, text and inert annotation metadata needed to identify useful pages without transferring the complete high-resolution PDF. Each pack has its own source hash and file checksums. The number of a PDF page is **one-based**, and may differ from printed plate numbers or PDF labels; the index records all three where extractable.

After identifying the relevant PDF page numbers, export those pages into another new folder:

```bash
python prepare_atlas_pdf.py \
  --input '/Volumes/金/郭永貴/atlas.pdf' \
  --output "$HOME/Desktop/atlas-selected-pages" \
  --pages '128,140,150'
```

The example page numbers are placeholders, not confirmed cerebellum pages. Comma-separated lists and ascending ranges such as `128-132,140` are accepted, up to 500 selected pages per run. Every run indexes the entire document so extraction can be checked against the original page correspondence.

Optional display previews require an explicit resolution:

```bash
python prepare_atlas_pdf.py \
  --input '/Volumes/金/郭永貴/atlas.pdf' \
  --output "$HOME/Desktop/atlas-previews" \
  --pages '128,140,150' \
  --dpi 120
```

To request a display crop, also provide its rectangle in **PDF display-page points**, using the indexed `display_rect_points` as the valid range. One PDF point is 1/72 inch of page layout; it is not a measurement of brain tissue. This example rectangle is illustrative and must fit each selected page:

```bash
python prepare_atlas_pdf.py \
  --input '/Volumes/金/郭永貴/atlas.pdf' \
  --output "$HOME/Desktop/atlas-crop" \
  --pages '128' \
  --dpi 200 \
  --crop '100,100,500,600'
```

Cropping affects only the explicitly requested PNG preview. The static page PDF remains the full selected page. There is no automatic lower-resolution fallback. An out-of-page crop stops the run instead of silently changing its bounds.

## What is preserved and what is unknown

The original PDF is never rewritten. Its byte count, streamed SHA-256 and page count are recorded. Its size and modification time are checked again after processing; a detected source change stops preparation. Source access is read-only. Output folders and files are created without overwriting existing files; a failed or interrupted run can leave a partial folder, so choose a new folder when restarting.

For every page, the index records:

- PDF page number/index, PDF label, media box, crop box, displayed rectangle and rotation;
- extractable text strings and their page-layout rectangles;
- inert annotation subtype, rectangle, content, subject and title, including hover definitions where the PDF exposes them;
- inert widget type, rectangle, field name, label and value where available;
- absent or unsupported extraction states and any metadata truncation.

The index keeps text and coordinate labels as **uninterpreted strings**. It does not infer Bregma coordinates, units, section intervals, registration transforms or tissue calibration. A text or annotation rectangle is the location of a label on the page, **not an anatomical ROI boundary**. The calibration and anatomical-coordinate fields stay `null` until a separate, documented interpretation is supplied.

Extracted PDFs copy original page graphics, text and image content without rasterising or resampling it. They are newly written PDF containers, not byte-identical pieces of the source file. Links, annotations, widgets, document navigation and actions are omitted from these static PDFs. Consequently, annotation/widget appearances and hover functionality are not displayed in them. Their inert metadata is retained in the source-page index where extractable. Omitted features are explicitly listed in each page's provenance. The original file remains available for authorised inspection in an appropriate viewer.

PyMuPDF reads the PDF without executing its JavaScript or following its links. The helper does not run JavaScript, launch external documents, retrieve URLs or install a proprietary viewer. It does not expose PDF action scripts in the index. Embedded images are decoded only for explicitly requested PNG previews, not to create anatomy or a segmentation.

Text and inert metadata have a combined 256 KiB string budget per page, and at most 512 items per metadata type. Truncation is reported as `metadata_truncated: true`; unavailable extraction has an explicit status/error. A scanned page without extractable text is `absent_or_not_extractable`; no OCR result or anatomical interpretation is invented. PDF text extraction order is not necessarily human reading order.

## Bounded transfer and large single pages

`packs/atlas-pack-0001.zip`, etc., use stored ZIP entries so the maximum output size can be calculated before writing. The actual archive size is checked again. Each `pack-manifest.json` records the original source identifier and every included file's size and SHA-256. Individual page PDFs, page provenance and index chunks can be placed in different packs; provenance links them by source hash and original page number.

If **one complete extracted page** cannot fit into a 24 MiB pack, it is reported as `unsplittable_under_pack_limit`; that oversized derived page is removed. The original source stays intact. No JPEG conversion, downsampling or anatomical crop is silently substituted. The report suggests an explicitly requested DPI/crop preview as a way to inspect a smaller portion, while clearly distinguishing it from the full source. Preview PNGs must also fit a bounded pack. Rendering is limited to 64 million pixels per requested preview; larger requests are reported and skipped rather than automatically rescaled.

The report distinguishes selected pages from successfully exported static PDFs and PNG previews. Review `omissions` before assuming all selected material is present. Local processing temporarily needs disk space for one extracted page plus the prepared files and their ZIP copies; the original >1 GB PDF is not duplicated wholesale.

Output layout:

```text
preparation-report.json       summary, source hash, exported counts, omissions, pack checksums
source.json                  source/preparation metadata, also included in a pack
index/page-index-0001.jsonl   per-page metadata, split into bounded chunks
pages/page-000128.pdf        full static selected page, if it fits
pages/page-000128.json       exact source/page correspondence and extraction provenance
previews/page-000128.png     only when explicitly requested and within bounds
packs/atlas-pack-0001.zip    transferable pack, at most 24 MiB
```

This preparer is separate from `prepare_atlas.py`, which converts explicitly labelled NIfTI volumes into reference surfaces. A PDF atlas, even at high resolution, is not automatically a complete segmented 3D volume. Page selection, verified physical coordinates, compatible species/age/strain, contour interpretation and registration remain separate research work.

## Dependency and validation

`requirements-atlas-pdf.txt` pins PyMuPDF 1.26.6. PyMuPDF/MuPDF uses AGPL/commercial licensing; check the applicable terms before bundling it into redistributed or hosted software. This helper uses it as a locally installed dependency and does not change the ownership or publication rights of the atlas. Upload only extracts you are authorised to share.

Run `python qa/check_atlas_pdf.py` from the repository root. Synthetic tests cover multipage correspondence, printed-coordinate strings remaining uninterpreted, PDF dimensions/rotation, hover annotation and widget metadata, absent text/calibration, static page render equivalence with interactive appearances omitted, original-byte/hash preservation, explicit preview/crop dimensions, no overwrite, multiple bounded ZIP packs with checksums, and explicit rejection of a single oversized page without automatic downsampling. These tests do not claim that the real atlas has been inspected or biologically interpreted.
