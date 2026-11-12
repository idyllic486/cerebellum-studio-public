# Local Nissl model runner

This optional CPU adapter connects an **externally supplied, trained ONNX segmentation model** to Cerebellum Studio's single-section review workflow. It produces an **unapproved prediction JSON**, bound to the exact source TIFF, model weights and inference manifest by SHA-256. It does not include trained tissue weights, run a browser/cloud AI service, or establish Nissl segmentation accuracy.

The first supported task is either whole-cerebellum segmentation (`background`, `CB`) or mutually exclusive layer segmentation (`background`, `ML`, `GL`, `WM`). The layer model does **not** generate an additional CB outline. PL, fissures, lobule labels, atlas registration, uncertainty calibration and biological WT/KO comparisons are outside this adapter's scope.

## Install and run

Use a local Python 3.12 environment. On macOS or Linux, from the repository root:

```sh
python3 -m venv .venv-nissl
.venv-nissl/bin/python -m pip install -r scripts/requirements-nissl.txt
```

Copy `examples/nissl-model-manifest.json` to a new file and replace its example fields with the **actual model's training/export configuration**. The example intentionally does not run: its checksum is a placeholder and `single_section` is false. The example tile size, normalization and channels are illustrations, not recommended values for an unknown model.

```sh
.venv-nissl/bin/python -c "import hashlib,pathlib; print(hashlib.sha256(pathlib.Path('trained-model.onnx').read_bytes()).hexdigest())"
.venv-nissl/bin/python scripts/nissl_predict.py \
  --image montage.tif \
  --model trained-model.onnx \
  --manifest my-model-manifest.json \
  --output specimen-section.prediction.json
```

The output path must be new. The runner does not overwrite a previous result or alter the source TIFF. It makes no network calls during inference. Python dependency installation is a separate network operation.

Open **My research → Image to measurements** on the site, load the same TIFF and the resulting prediction JSON, then inspect the original image and every proposed ROI. Correct vertices or exclude a proposed ROI with a reason, enter the animal/section IDs and known calibration, and record the reviewer and review protocol. Only a current approval permits the measurement/ROI export; an edit invalidates that approval. Human approval is a recorded review, not an anatomical accuracy guarantee.

Keep source TIFFs, manifests and model weights under the laboratory's ownership/access policy. The export hashes provide integrity links, not authenticated author signatures.

## Supported model and source contract

- One anatomical section per TIFF. A montage stitched from fields of one section is appropriate. A montage containing multiple anatomical sections must first be separated with a documented coordinate mapping; the adapter does not guess their identity/order. `single_section=true` records this operator assertion.
- Classic TIFF, one page, original top-left orientation, uncompressed or Deflate, unsigned 8/16-bit BlackIsZero grayscale or interleaved RGB. No inferred inversion, channel conversion, image rotation, resizing or calibration. Original filename, byte hash and image dimensions enter the prediction. Decoding uses the same byte buffer that was hashed.
- Up to 128 MiB per source TIFF, 40 million pixels, 32767 pixels per axis and 128 MiB decoded source pixels. These limits match or are narrower than the review UI. BigTIFF, pyramidal/sub-IFD, planar, signed/float, RGBA, multi-page and unsupported compressed input are rejected. Some metadata-rich TIFFs can still be rejected by the browser's stricter TIFF preflight; retain the original and any conversion/mapping provenance if producing a compatible single-plane file.
- One float32 **NCHW** input and one float32 **NCHW logits** output at the same resolution. Batch size is one; fixed dimensions must match the manifest. Input pixels are transformed exactly by `(raw - offset[channel]) / scale[channel]` and transposed to NCHW. The channel count and original uint8/uint16 dtype must match the manifest.
- `classes` is exactly `["background","CB"]` or `["background","ML","GL","WM"]`; list order defines output class indices. No probability threshold, temperature, softmax calibration, confidence percentage or class remapping is invented.
- `tile_size` is `[height,width]`, each 8–2048 pixels; `tile_overlap` is nonnegative and smaller than the respective dimension. Incomplete small images are edge-padded on bottom/right. Tile coverage includes the last row/column. Runs exceeding 10000 tiles stop explicitly. Overlapping **logits are averaged**, then argmax selects a label; a tie selects the first class index. Models that require a different padding/normalization/overlap policy are unsupported until explicitly adapted and tested.
- All model tensor data must be embedded in the ONNX file so its recorded checksum covers every weight. External tensor sidecars are rejected. Model size is limited to 512 MiB. The exact hashed model bytes are supplied to ONNX Runtime. Logit blending uses temporary disk-backed arrays (up to about 800 MB at the image limit), which are deleted after inference. Only the CPU execution provider is selected.

These checks establish a reproducible adapter contract; they do not establish compatibility with arbitrary segmentation models. A model's accuracy, required tile context, receptive-field edge artifacts, staining robustness and out-of-distribution behavior need separate animal-level evaluation.

## Masks, contours and measurement meaning

The runner labels four-connected foreground components independently. Each component becomes an ROI; all holes are retained. It traces **exact pixel-cell edges**, with integer pixel-edge coordinates and the original top-left image origin. Only exact collinear vertices are removed. For unedited output, the sum of signed ring areas equals the predicted foreground pixel count; the adapter checks that equality.

No island, hole or class is silently removed. A mask with a diagonal pinch/touching boundary inside one connected component is rejected because it cannot be represented as the review core's simple, non-touching rings without a topological decision. Two diagonal-only foreground components remain separate ROIs. More than 64 ROIs, 128 rings or 5000 vertices per ROI, 30000 total vertices, or two million raw boundary edges per component triggers an explicit stop. A background-only prediction also stops rather than inventing empty measurements.

These limits are protective boundaries, not a denoising algorithm. If a model produces excessive fragments or pinches, investigate the model or create a separately documented, explicitly reviewed correction; do not claim that an omitted fragment is measured tissue.

The review UI measures the **reviewed Float32 contour geometry**, including holes. After human edits, it can differ from the original mask's pixel count. Exported ImageJ ShapeRoi coordinates use the same Float32 geometry as the measurements. Perimeter is the contour boundary length (including hole boundaries); the initial pixel-cell perimeter is grid-dependent and is not an unbiased estimate of a smooth anatomical boundary. Calibration is entered independently for X and Y. Missing calibration/depth remains missing; a single image provides no organ volume.

The prediction's `processing` object records the manifest, manifest hash, runtime versions, tile count, class pixel counts, contour definition and unreviewed status. It supplies no calibrated uncertainty or anatomical performance result. Keep experimental drafts separate from existing example research data.

## Mechanical validation

From the full repository (the standalone runner download does not include the QA suite):

```sh
.venv-nissl/bin/python qa/check_nissl_runner.py
```

The test creates a tiny **synthetic arithmetic ONNX graph**, uses synthetic TIFFs and runs actual CPU inference. It is not a trained Nissl model and is never shipped as a production model. Checks cover overlapping tiling, padding, exact source/model hashes, holes/components, mask-to-polygon area, unsupported input rejection, external-weight rejection, no-overwrite behavior, and interoperability with the browser approval and ImageJ exporter. The interop check requires Node and the repository's `src/analysis_core.js` and `src/research_core.js`.

Passing these checks means the pipeline mechanics work on the stated fixtures. It does **not** measure tissue Dice, boundary accuracy, inter-rater agreement, time saved, robustness to damaged sections, or generalization to independent WT/KO animals. Those require real source TIFFs, agreed annotation rules, reviewed labels and held-out animals/batches. The existing example validation remains a separate regression baseline.
