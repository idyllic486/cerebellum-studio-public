# Browser inference from a supplied Local Lab model

Cerebellum Studio can execute a **trained `cerebellum-pixel-forest/1` JSON model directly in a browser worker**, using the original TIFF pixels. After selecting a compatible trained model, researchers can generate ROI candidates from a new TIFF in the website, inspect/edit the candidates and approve measurements. No Python runtime is required for this inference step. Training this model and independently validating its performance remain separate tasks, described in `LOCAL_LAB.md`.

One tissue-layer network trained on the project's reviewed sections is published with the site as a built-in model (see `assets/models/`); no other pretrained weights are bundled. The built-in model is loaded through the same path as a model file a researcher chooses, after its fingerprint is checked. The adapter does not substitute thresholds, an atlas outline or the existing example annotations for a trained model. Its outputs are experimental, unreviewed predictions. The implemented software pathway is not evidence of anatomical accuracy, performance across stains/genotypes or a complete unattended laboratory workflow.

## User workflow and research limits

1. Fit a model using explicit expert masks and an animal-level training split in Local Lab. Reserve other animals for validation/testing. Record the annotation protocol, acquisition scale and staining conditions.
2. Select the resulting `model.json` in the website and select the original single-section TIFF with matching channels/dtype. A montage assembled from several camera tiles is supported when it depicts one physical section.
3. Run local prediction. Progress describes model validation, original source validation, decoding, native-pixel inference and contour export. Cancellation terminates the worker; the caller must retain the previous reviewed state and ignore any response belonging to a replaced job.
4. Review the ROI candidates. Provide verified calibration before physical measurements. No approval, scale, depth, genotype, missing section or atlas correspondence is inferred.

The model uses pixel-scale texture features, so magnification changes and staining variation may affect results. Raw tree frequencies are not calibrated uncertainty. Report validation on appropriately independent animals before using predictions to support WT/KO conclusions. Training-animal and image-hash provenance is declared by the model author; it is not an authenticated guarantee or an automatic check against a hidden training corpus.

## Native pixel support

The existing vetted `ResearchImage` TIFF preflight/decoder is reused. Original-file limit: 128 MiB. Native image limits: 40 million pixels, 128 MiB decoded bytes and 32,767 pixels per axis. The adapter accepts only model-matched unsigned uint8/uint16 BlackIsZero grayscale or three-channel interleaved RGB, top-left orientation and one section/page. It does not invert WhiteIsZero grayscale, drop alpha, change channels, resize an image or infer calibration. The browser decoder's Classic TIFF/compression/storage restrictions still apply; see its existing image-loader documentation and errors. BigTIFF is not supported in the browser.

The TIFF is fully decoded in a worker. Feature generation and forest inference use bounded tiles with a 12-pixel halo. There is no full-resolution canvas or preview-based segmentation. Gray/RGB uint16 retains its native integer values for normalization; any display conversion is separate. The vendored TIFF decoder normalizes 16-bit decoded bytes to little endian; model extraction reads that defined representation and does not alter original TIFF bytes.

Large images and complex forests can take substantial CPU time. The main UI remains responsive, and the user can cancel. These bounds are not a guarantee that every supported image/model finishes quickly on every device; training or batch inference on the local companion remains useful for large workloads.

## Model and mathematical definition

The safe JSON schema is the same one exported by `scripts/nissl_lab.py`. Validation bounds models to 64 MiB, 64 trees, 100,000 total nodes, depth 32 for imported trees, declared class mapping and complete declared training-source/animal provenance. Cycles, shared child nodes, unreachable nodes, invalid frequencies, invalid feature indices and unsupported normalizations are rejected. No pickle or executable model code is loaded.

Supported exclusive class lists:

- `background, CB`
- `background, ML, GL, WM`

Features are `raw+gaussian_mean_std_sigma1_sigma3_reflect_truncate4/1`, with channels interleaved inside each feature group. Normalized raw input is float32. Gaussian filtering processes the Y axis and then X, writes float32 after each axis, uses half-sample symmetric reflection and radii 4 and 12 for sigma 1 and 3. Local standard deviation is `sqrt(max(E[x²]−E[x]²,0))` with the same float32 intermediate arithmetic as Python. Inference averages the forest's leaf frequencies through a double-precision sum and takes the first class in a tie. No probability threshold or unrequested postprocessing is applied.

The native label mask is converted to exact pixel-cell boundaries using four-connected components. Holes and separate components are preserved. Collinear grid-edge steps may be represented by their shared straight segment, which preserves the exact boundary and area; there is no approximate contour smoothing or geometric simplification. Every exported component's signed polygon area must equal its predicted pixel count.

The current review limits are 64 ROIs, 128 rings and 5,000 vertices per ROI, 30,000 total vertices, and two million boundary edges per component. Excessive fragmentation, a diagonal boundary pinch within a component, an unsupported contour or background-only output stops ROI conversion with an explicit reason. The worker retains every original-resolution class index. The image workspace offers an unreviewed label preview and a ZIP containing `labels.uint8`, the exact TIFF and model, class mapping, dimensions and SHA-256 hashes. No island is silently discarded, and no empty approved measurement is fabricated.

The preview uses nearest-neighbour sampling at a reduced display resolution; `labels.uint8` is one byte per original pixel in row-major order. Model pixels are a reference for drawing manual ROIs or reviewing imported ImageJ boundaries. Starting a manual review retains the label-map provenance, while the manual contours remain a separate researcher-derived result with no invented model identity. Existing reviewed contours are retained after conversion failure. Recovery copies retain the raw map and model; the approved archive includes the reference map/model while those original bytes are available. A reopened JSON draft retains the reference hashes but does not embed these potentially large reference binaries, so keep the label-map archive or full workspace backup as well. No automatic mask cleaning or biological validity is claimed.

## Integration API

Place `browser_model_core.js` and `browser_model_worker.js` beside the existing asset scripts. The worker imports only local vendored `pako.min.js`, `UTIF.js`, `research_image.js` and its core. It makes no upload requests.

Create a fresh worker for every job:

```js
const worker = new Worker('assets/browser_model_worker.js');
worker.postMessage({
  file: originalTiffFile,       // File, or supply buffer: ArrayBuffer
  sourceName: originalTiffFile.name,
  modelFile: trainedModelFile, // File, or supply modelBuffer: ArrayBuffer
  expectedSourceSha256,        // optional known original-image digest
  expectedModelSha256          // optional independently recorded model digest
});
```

Each original file/model is SHA-256 hashed from the same bytes used for processing. A supplied expected digest must match. One job per worker is supported; do not reuse a worker after success or failure. The caller terminates it for cancellation and associates responses with the current job before updating application state.

Responses are:

```js
{ progress: { stage, message, completed, total } }
{ result: prediction }
{ raster: { metadata, labels: Uint8Array } } // inference succeeded; ROI conversion failed
{ error: 'explicit failure reason' }
```

`total` is null for contour progress where the final component count is not yet known. The prediction is `cerebellum-prediction/1` and includes:

- `source: {name, sha256, width, height}`, bound to the original TIFF bytes and grid.
- `model: {id, version, weights_sha256, family, training_animals, training_sources}`, bound to the exact supplied model file bytes.
- `rois: [{id, label, paths}]`, compatible with `AnalysisCore.validatePrediction`.
- `processing`, including native pixel counts, tile count, adapter version, feature definition and `status: 'unreviewed'`.

No approval or calibration is returned. The UI must validate the returned prediction against the active source before importing it into the review workflow. The caller retains original source/model evidence for export; the worker does not return the raw files or persist data on a server.

The raster response metadata uses `cerebellum-label-map/1` and includes source identity, model identity/hash, class mapping, native label hash, encoding and the conversion failure. The caller verifies the label bytes and class mapping against the original model before preview, recovery or export. Browser-generated approved results retain the exact original model in `originals/model.json`. Imported prediction JSON may declare a model whose bytes were never supplied; its archive reports that absence instead of implying a reproducible model artifact.

Core APIs are exposed as `BrowserModelCore` in a worker/browser and through CommonJS for numerical checks:

```js
validateModel(model)
pixelsFromTIFF(validatedAndDecodedPage, model)
features(pixels, width, height, channels, scale)
infer(model, {pixels, width, height, channels, dtype}, {tileSize, onProgress})
vectorize(labels, width, height, classes, onProgress)
```

`infer` returns `{labels: Uint8Array, tiles}`. `vectorize` returns `{rois, counts}`. The default inference tile size is 128; supported test/adapter tile sizes are 8–256. Public numerical APIs perform no web I/O.

## Verification and limits of the evidence

```sh
NISSL_LAB_PYTHON=/path/to/lab/venv/bin/python node qa/check_browser_model.cjs
```

The test generates a real fitted forest using synthetic expert masks through the Python Local Lab training code. Temporary fixtures are removed afterward; they are not shipped as Nissl weights. `qa/browser-model.json` records results.

The recorded checks establish:

- Exact float32 feature agreement with Python for the tested grayscale/RGB uint8/uint16 fixtures, including native little-/big-endian TIFF reads without changing original bytes.
- Equal native label masks at four tile sizes and exact Python-compatible contours including holes.
- Explicit rejection of malformed models, missing provenance, unknown labels, topology failures, excessive components and input bounds.
- Actual browser Worker output accepted by AnalysisCore, with original source/model identity and an unreviewed state.
- A 34,560,224-byte RGB TIFF reaches native inference while the main thread stays responsive; terminating its worker returns no stale result. This particular large-image check cancels after the first inference tile, so it does not establish full-image runtime or accuracy.
- No external data requests or browser errors during the tests.

These tests do not measure performance or anatomical segmentation quality on the user's actual Nissl TIFF. Cross-language equality on these fixtures is evidence for this implementation, not a formal proof for all models, pixel values or JavaScript engines. Independent biological validation, model calibration, reproducible protocol selection and clinical/research interpretation remain separate requirements.

## Tissue U-Net bundle

The image workspace also accepts a `cerebellum-auto-roi-unet/1` bundle exported by `scripts/export_unet_bundle.py`. One network produces the CB and ML/GL/WM maps in a local Worker with no added dependency: original pixels are block-averaged, tiles run on the CPU, and probabilities return to the native grid. The native maps are retained, then converted automatically to editable block candidates with recorded changes. Approval stays with the researcher. Weights are never bundled with the site. Measured results and limits: [whole-image evaluation](WHOLE_IMAGE_EVALUATION_2026-11-06.md).
