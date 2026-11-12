# Paired contour validation

Stage 3 compares supplied predictions with separately supplied reference annotations from the **same original image**. The browser Worker computes CB, ML, GL and WM overlap, area error and boundary distance, checks declared animal splits, and exports the exact inputs, settings and a SHA-256 fingerprint in a reproducible JSON report. It does not train or run a segmentation model and never passes reference contours into a prediction operation.

This is a working evaluator, not evidence that an independently validated Nissl model exists. Reference contours are comparison annotations, not an error-free anatomical ground truth. Model metadata is a declaration; these checks cannot authenticate the actual training history. The original example measurements, exclusions, missing values and 20 historical hold-out scores are separate and unchanged.

## Scientific conditions

- Freeze a model and boundary protocol before evaluating held-out animals. Supply the model ID, version, weights SHA-256, complete training animal IDs and a completeness declaration. Missing provenance produces `unverified`, not a pass. Known training/evaluation animal overlap produces `blocked`, even when provenance is incomplete.
- Split at the animal level. Multiple sections of one animal are not independent animals. Duplicate animal IDs, assignment of one animal to multiple splits, or identical source-image hashes assigned to different animals block the split check. A shared staining/acquisition batch produces a warning: the evaluation does not test external-batch generalisation.
- Keep annotations used for training, validation/model selection, and final testing separate. Freeze final-test annotations before looking at model output. This evaluator can detect declared conflicts; it cannot recover undisclosed training data or prove that a human did not see a test annotation elsewhere.
- Use all geometry in original-image XY pixel coordinates. Prediction and reference each carry an explicit original-image SHA-256 link. Both must equal `source.sha256`. SHA links are declarations in this JSON interface; the evaluator has no original image bytes to rehash. The image import workflow must compute these hashes from the files.
- State the boundary protocol in `protocol_id`. Record reviewer identity, annotation version and protocol detail as additional input metadata where available; they are preserved and fingerprinted. No automatic anatomical correspondence or registration is inferred between annotation sets.
- Keep model drafts and human-corrected results in separate reports. `prediction_stage` records `model_draft`, `human_corrected`, or `unknown`. A bundle permits one exact model metadata object and one prediction stage; unknown stage remains explicitly unknown.
- Physical calibration is optional but never invented. Both positive `um_per_pixel_x` and `um_per_pixel_y` are required for physical area and boundary distance. Pixel-coordinate metrics remain available without physical calibration.

## Numerical definition and limits

The longer axis of the original source image is represented by **128 or 256 cells**; the shorter axis is rounded to preserve the image aspect ratio. The grid covers the complete declared image rectangle, including background. Grid origin, dimensions, XY spacing, fill rule and domain are reported. Coordinates outside the source image cause an error with the number of outside vertices; nothing is silently cropped. A successful grid reports `outside_vertex_count: 0`.

Rasterisation uses scanline intersections at cell centres. Rings within one ROI use the even-odd rule, preserving represented holes; selected ROIs are combined by union, preserving represented disconnected components without double counting overlapping ROIs. This is a coarse approximation for large montage images. Small components or holes can disappear. A contour declared present that samples to an empty mask is `unscorable`, not tissue absence. Increasing the grid from 128 to 256 is a sensitivity check, not proof of convergence or native-resolution accuracy.

Let `P` and `R` be the predicted and reference foreground cell sets. Dice is `2 |P∩R| / (|P|+|R|)`; IoU is `|P∩R| / |P∪R|`. Area equals foreground cell count times original-pixel cell area. Signed relative area error is `100 × (area(P)−area(R)) / area(R)`; absolute relative area error is its absolute value. Physical areas additionally multiply by the declared X and Y pixel scales. These are **common-grid approximations, not ImageJ measurements**.

Boundary cells are foreground cells with at least one background or out-of-image four-neighbour. Distances are Euclidean distances between boundary cell centres, calculated by a separable distance transform using the grid's XY spacing. The reported mean is the mean of the pooled bidirectional nearest-boundary distances; HD95 is their pooled linear 95th percentile. Anisotropic physical pixel scales are applied separately to X and Y. This explicitly defined HD95 convention is not interchangeable with every other library's HD95 implementation. A distance is undefined if either foreground mask is empty.

Missingness is preserved independently by layer and annotation set:

| Declaration | Result |
| --- | --- |
| A selected area contour exists | `present` by default |
| No annotation and no absence declaration | `unassessed`; no zero mask or score substituted |
| Explicit `absent`, with no selected contour | Empty foreground mask allowed |
| Both sides explicitly absent | `both_absent`; Dice and IoU are `null`, not 1 |
| One side explicitly absent | Dice and IoU are 0 when the other side samples present |
| Reference explicitly absent | Relative area error is undefined because its denominator is zero |
| Present contour vanishes on the grid | `unscorable`; score and area are `null` |

The default layer selection prefers a unique `CB_TOTAL`/`ML_TOTAL`/`GL_TOTAL`/`WM_TOTAL` ROI, then an exact layer name, then explicitly labelled components. Multiple local name-only regions are not assumed to form an exhaustive partition; supply `prediction_layer_selection` and `reference_layer_selection` to select their exact ROI names. Excluded ROIs remain in the input but cannot be explicitly selected. Lines, points and open contours cannot be scored as areas.

For each layer, section metrics are averaged **within each animal**, then animal means are averaged without weighting by section count. The report exposes animal count, section count, scored/unassessed/unscorable/both-absent section counts and separate section and animal denominators for Dice, IoU, relative area error and physical boundary distance. Missing calibration therefore cannot silently change the denominator of another metric. There are no p-values, confidence intervals or claims of established external generalisation.

Work is bounded to 500 pairs, 5,000 ROI records per annotation set, one million vertices per pair, two million vertices per bundle and a 64 MiB JSON input. Image dimensions may be up to one million pixels per axis because no full-resolution pixel buffer is allocated. Optional mask previews are limited to four pairs. The Worker keeps computation off the main UI thread; terminate it to cancel a run. This JSON size limit is separate from the original TIFF loader's size limits.

## Input JSON

This complete synthetic example compares identical squares. The hash is a fixture identifier, not a real image; `model: null` correctly yields an unverified independence status. Replace the geometry and hash links with values from a real, reviewed image before research use.

```json
{
  "schema": "cerebellum-validation/1",
  "protocol_id": "example-boundary-protocol-v1",
  "pairs": [
    {
      "animal_id": "example-animal",
      "section_id": "section-1",
      "source": {
        "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "width": 128,
        "height": 128
      },
      "prediction_source_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "reference_source_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "prediction_rois": [
        {"name": "CB", "kind": "area", "paths": [[[16, 16], [48, 16], [48, 48], [16, 48]]]}
      ],
      "reference_rois": [
        {"name": "CB", "kind": "area", "paths": [[[16, 16], [48, 16], [48, 48], [16, 48]]]}
      ],
      "coverage": {
        "prediction": {"CB": "present", "ML": "unassessed", "GL": "unassessed", "WM": "unassessed"},
        "reference": {"CB": "present", "ML": "unassessed", "GL": "unassessed", "WM": "unassessed"}
      },
      "calibration": {"um_per_pixel_x": null, "um_per_pixel_y": null},
      "prediction_stage": "unknown",
      "evaluation_split": "test",
      "model": null
    }
  ]
}
```

Optional model declaration, using actual values rather than these descriptions:

```js
model: {
  id: 'actual-model-id',
  version: 'actual-frozen-version',
  weights_sha256: '<actual 64-character lowercase hexadecimal SHA-256>',
  training_animals: ['actual-training-animal-id'],
  training_provenance_complete: true
}
```

Use per-side selection objects such as `prediction_layer_selection: {CB: ['CB_TOTAL']}`. Optional `review_time` accepts `manual_minutes`, `assisted_minutes`, and `same_protocol: true`. A paired comparison requires both actual operator-recorded durations and explicit same-protocol confirmation. Missing times remain missing. The reported subtraction and percentage are arithmetic summaries of recorded metadata, not automatically measured or causally established time savings.

An optional top-level `study` may be a `cerebellum-study/1` animal manifest. Every pair must match its animal's declared split, section ID, source hash and source dimensions. Contradictory paired metadata is rejected. `checkSplits` can also inspect `{splits: {train: [...], validation: [...], test: [...]}, model: ...}` directly; lists contain animal IDs, not section IDs.

## API and report

`src/validation_core.js` exports `ValidationCore` in a browser and CommonJS in Node:

```js
ValidationCore.checkSplits(studyOrSplitManifest);
ValidationCore.evaluatePair(pair, {grid: 128, layers: ['CB', 'ML', 'GL', 'WM']});
ValidationCore.aggregate(pairReports);
await ValidationCore.evaluateBundle(bundle, {grid: 256});
await ValidationCore.fingerprint(jsonValue);
```

`evaluatePair` is the low-level synchronous metric operation. The import path should use `evaluateBundle`, which validates and copies JSON, checks duplicate pairs/source images and frozen model/stage consistency, applies optional study checks and produces the fingerprinted export. Do not pool arbitrary edited reports with `aggregate`; reproduce results from the original paired inputs.

Worker messages:

```js
worker.postMessage({id: 'run-1', operation: 'evaluate', bundle, options: {grid: 128}});
worker.postMessage({id: 'split-1', operation: 'splits', study});
// Replies: {id, result} or {id, error}; errors do not become successful reports.
```

The report schema is `cerebellum-validation-report/1`. It contains `version`, `input`, `input_sha256`, `conditions`, `pairs`, `summary`, `split_check` and `warnings`. Pair results contain `grid`, per-layer metrics and missingness, model provenance, prediction stage, review-time metadata and independence status. The export preserves the original input annotation arrays and metadata without rewriting source coordinates.

`input_sha256` hashes a deterministic, key-sorted JSON object containing the entire copied input bundle and normalized options. Changing geometry, calibration, exclusions, source links, provenance, split assignment, recorded times, protocol ID or resolution changes this fingerprint. The UI must clear a displayed report when input or settings change; an old report cannot establish the validity of edited data. Hash equality detects input equality under this convention, not scientific correctness or authorship.

Reproduction:

```js
const reproduced = await ValidationCore.evaluateBundle(report.input, {
  grid: report.conditions.grid,
  layers: report.conditions.layers,
  includeMasks: report.conditions.includeMasks
});
if (reproduced.input_sha256 !== report.input_sha256) throw Error('Input/settings mismatch');
// Also record/compare implementation version and metrics when comparing releases.
```

## Verification and remaining evidence

Run `node qa/check_validation_core.cjs`. The tests exercise identical and translated analytical squares, known intersection/union/area values, anisotropic boundary distances, holes, disconnected and overlapping components, full-image edge coverage, missing labels, explicit empty masks, grid vanishing, source mismatches, outside coordinates, exclusions, ambiguous local ROI selection, provenance leaks, animal-balanced aggregation, per-metric denominators, metadata-sensitive fingerprints and the actual Worker message handler.

Synthetic analytical tests establish implementation behaviour under those inputs. They do **not** establish biological accuracy. Still required for a scientific validation claim: independently reviewed annotations from additional animals, verified training provenance, prespecified train/validation/test splits, protocol agreement between reviewers, native-resolution comparison/sensitivity where needed, and recorded human review times. A single animal with many sections cannot supply independent biological sample size. Public atlas completeness or an attractive 3D reconstruction does not supply these missing observations.
