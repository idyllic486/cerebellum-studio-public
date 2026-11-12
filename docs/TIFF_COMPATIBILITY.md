# Prepare a TIFF without changing its pixels

Cerebellum Studio's browser reader accepts a bounded single-page Classic TIFF. A 32 MB TIFF can still be rejected because its container, number of pages, pixel encoding, orientation or channel interpretation is unsupported. File size alone does not establish compatibility.

This local tool provides a narrow, auditable route for **BigTIFF or explicitly selected multi-page TIFF pages**. It creates a new uncompressed, single-page Classic TIFF and a provenance report. It never overwrites the original, crops, resizes, normalizes intensities, changes orientation, inverts grayscale or removes a channel. Reopened output pixels must equal the selected original page exactly before a result is released.

## On a Mac

1. Download and unzip **cerebellum-tiff-tools.zip**. Keep the folder together.
2. In its `scripts` folder, open `Start-TIFF-Compatibility.command`. If double-click execution is unavailable, open Terminal, type `bash `, drag that `.command` file into Terminal and press Return. Python 3.10 or newer is required.
3. Select the original TIFF. The local tool installs pinned dependencies on first use; it never uploads the image.
4. Enter the page number starting at **1**. For multiple pages, first inspect the original in Fiji/ImageJ and identify the correct anatomical section. The tool cannot decide which page belongs to your ROI.
5. A new Desktop folder opens. Select the new `…-page-0001-classic.tif` in the site. Keep the original and `tiff-compatibility-report.json` together as provenance.

A stopped conversion leaves the original intact. An unsupported pixel type must not be relabeled by changing the filename extension.

## Command-line workflow

Run from the unzipped bundle's root:

```sh
python3 -m venv .venv-tiff
.venv-tiff/bin/python -m pip install -r scripts/requirements-tiff-compatibility.txt
.venv-tiff/bin/python scripts/prepare_tiff_compatibility.py --input /path/to/original.tif --inspect
.venv-tiff/bin/python scripts/prepare_tiff_compatibility.py --input /path/to/original.tif --page 1 --output-directory /path/to/new-output-folder
```

The output directory must not already exist. For a multi-page file, `--page` is mandatory. Inspection writes no image and decodes no pixels. A file with more than 1,000 pages is outside this tool's bounded indexing scope.

## Supported conversion and scientific boundaries

| Item | Behavior |
| --- | --- |
| BigTIFF / multi-page | Writes a new Classic TIFF from the explicitly selected page. Other pages remain in the original; they are not merged or treated as adjacent sections. |
| Pixel types | Unsigned 8-bit or 16-bit BlackIsZero grayscale, or interleaved RGB. |
| Limits | 40 million pixels; 32,767 pixels per dimension; 128 MiB decoded pixels and 128 MiB resulting file including headers. Larger pages are rejected, not reduced. |
| Orientation | Only orientation 1. Rotation/mirroring would require a corresponding ROI transform and is deliberately not inferred. |
| Compression | Decoding must be available in pinned `tifffile` dependencies. Uncompressed and supported Deflate inputs are covered by tests. Some codecs require additional software and fail with a clear message. Output is uncompressed. |
| Sub-IFD / pyramids / planar channels | Rejected as ambiguous or unsupported in this version. |
| Float / signed / 16-bit WhiteIsZero | Rejected. No quantitative pixel conversion is guessed. |
| RGBA / 8-bit WhiteIsZero | The command-line `--display-only` option permits unassociated alpha or WhiteIsZero without changing pixels. These remain **incompatible with the Nissl model runner**. The Mac launcher uses the stricter default. |
| Metadata | TIFF X/Y resolution and resolution unit are copied when present. Vendor, OME and ImageJ descriptions remain in the unchanged original. Verify physical calibration manually; no anatomical coordinate or thickness is inferred. |
| ROI coordinates | Pixel coordinates are unchanged for the chosen page. The researcher must still confirm that the ROI belongs to that exact page and origin. |
| AI compatibility | A readable TIFF is not evidence that a trained Nissl model accepts or has been validated for that stain, channel convention or acquisition protocol. |

The report records original and derived file hashes, selected page, image shape/dtype, canonical decoded-pixel hashes, equality verification, metadata policy and identity coordinate/intensity transforms. A different container produces a different **file hash** even when decoded pixels are identical. Keep the report with the original; do not substitute the derived file for the raw evidence.
