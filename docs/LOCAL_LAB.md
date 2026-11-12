# Local Lab: source intake, supervised training and resumable research drafts

The website remains the review and study interface. Local Lab is a downloadable CPU companion for jobs that need model training or batch inference. It runs on the researcher's Mac or Linux workstation; it is not a hosted worker or a browser-to-workstation connection. Import the resulting `draft-study.json` into the website and its `queue.json` into the job report viewer. Nothing is uploaded automatically, and every generated section requires human review.

## What is implemented

- Native-resolution single-section TIFF preparation, SHA-256 source identity and display previews, including files larger than 32 MiB.
- Optional original ImageJ ROI ZIP import, original CSV identity preservation and exact ImageJ geometry measurements when an operator supplies an ImageJ jar and pixel calibration.
- Actual supervised random-forest fitting from explicit expert class masks, safe JSON model export, tiled native-resolution prediction, exact predicted pixel-cell contours and a review queue. No trained Nissl weights are supplied.
- Evaluation on an animal-level validation or test split, with native-pixel Dice, IoU and relative area error. Unknown reference pixels are excluded explicitly.
- Checksum-verified resume, immutable result directories, explicit failed jobs and unapproved StudyCore export. Existing exclusions and missing physical values are preserved.

These capabilities provide a working research pipeline, not validated anatomical automation. A small synthetic image checks software mechanics; it cannot establish Nissl accuracy, genotype generalization, review-time savings, calibrated confidence or an anatomically complete organ. The original manually annotated example is not an independent test cohort. Brain-atlas registration, 3D reconstruction and cohort statistics run in the website after explicit physical metadata and review; this CLI does not infer missing anatomy.

## Install

Python 3.10+ on macOS/Linux is supported. Python 3.12 is used in the recorded checks. Java 11+ is optional for exact ImageJ geometry; Java 21 is used in the recorded check. No Java compiler command is required because the helper uses source-file mode.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r scripts/requirements-lab.txt
```

Download the site's Local Lab tools ZIP, or use the private repository's `scripts`, `examples` and `docs` directories. Keep `nissl_lab.py`, `nissl_predict.py`, `imagej_measurements.java` and both requirements files together under `scripts/`. Dependencies are optional for site use; training runs locally. The library license and dataset/model rights must be assessed separately before redistributing weights or source data.

## Declare source identity and missing values

Copy `examples/nissl-lab-manifest.json` to a private working directory and replace its example paths, study/protocol identifiers and animal records. It intentionally supplies no invented genotype, scale, Z or pretrained weights. The example uses RGB uint8; change `input` only to match the actual TIFF and training protocol.

Paths resolve relative to the manifest's directory. Each job has:

- `animal.id`, `group` (`WT`, `KO`, `other`) and `split` (`train`, `validation`, `test`, `unassigned`). Every section from one animal must use the same complete animal metadata and split. Do not split adjacent sections from the same mouse across training and testing. `batch`, `sex` and `age_days` may be supplied explicitly.
- `section.id`, unique within the animal; `section.order`, also unique within the animal; actual `z_um`, `thickness_um` and X/Y `um_per_pixel` calibration or JSON `null`. Order alone is not physical spacing.
- `section.included` and `exclusion_reason`. Excluded sections require a reason, remain in the prepared study and do not enter training or evaluation. No section is automatically approved.
- `single_section: true`, an operator confirmation that the TIFF contains one physical section. A stitched montage of one section is supported; a sheet of several sections is not automatically partitioned.
- `image`, and optional `roi_zip`, `measurement_csv` and expert `labels` paths. Original bytes are read and hashed. They are never overwritten. Hashing a CSV does not establish calibration or relabel its numbers.

Store backups of the source files separately: the queue includes source identities and local paths, not a complete backup of the raw images, ZIPs or CSVs. Do not commit private raw images or generated identifiable paths to a public repository unintentionally.

## TIFF preparation and manual measurement

```sh
.venv/bin/python scripts/nissl_lab.py prepare \
  --manifest study.json --output prepared-v1
```

Preparation requires no model or training mask. It produces a display PNG, source provenance, original ROI geometry when supplied and an unapproved study section per job. Preview subsampling never changes the original measurement grid. uint16 is divided by 256 only for display; source values remain uint16.

The local adapter accepts one-plane top-left-oriented, uncompressed or Deflate TIFF, interleaved BlackIsZero grayscale or RGB, uint8/uint16, with no pyramid/sub-IFD. Bounds are 128 MiB source bytes, 40 million pixels, 128 MiB decoded pixels and 32,767 pixels per axis. BigTIFF may be read within those same bounds; alternate TIFF compression, orientation, planar encoding, pyramids and multi-page sources stop with an explicit error. The site's direct TIFF loader also accepts source files up to 128 MiB, with its separately declared decoder and decoded-size bounds. A chat attachment transfer limit is separate from these site/local image bounds.

For geometry calculated by the actual ImageJ engine:

```sh
.venv/bin/python scripts/nissl_lab.py prepare \
  --manifest calibrated-study.json --output prepared-imagej-v1 \
  --imagej-jar /path/to/ij.jar
```

Set both pixel scales from the verified acquisition calibration first. The ImageJ jar is operator-provided; its SHA-256 and the Java helper's SHA-256 are recorded. ImageJ decodes the original `.roi` bytes and measures on a blank geometry grid with the original width/height and supplied calibration. `area_um2` is emitted for area ROIs only; open lines have a length and an empty area. This does not measure original-image intensity. The output is a new `imagej-measurements.csv`; the source CSV is not edited.

Supported manual ROI shapes are polygon, rectangle, line, freeline, polyline, freehand, traced, point and composite polygon paths with holes. Curves, splines, rounded rectangles, special subtypes and unsupported geometry stop explicitly. ROI ZIPs must contain top-level `.roi` files only, unique names, at most 2,000 entries, 16 MiB compressed, 64 MiB expanded and two million coordinates. Coordinates outside the source grid are rejected.

The website's `pixel-mask/1` measurement counts pixel centres with even-odd filling and explicit unions. ImageJ's rasterization may differ. These are separate measurement profiles; the helper does not claim that the native browser profile reproduces ImageJ or replace historical CSV measurements.

## Expert label masks and training

A label TIFF must be uint8, one plane, exactly the same width/height and orientation as its source image. Class indices must be explicit:

| Class declaration | Mask values |
| --- | --- |
| `background, CB` | 0 background, 1 cerebellum, 255 unannotated |
| `background, ML, GL, WM` | 0 background, 1 molecular layer, 2 granular layer, 3 white matter, 255 unannotated |

Background is an annotation, not a default. Set every unannotated pixel to 255, including unlabeled areas outside sparse expert ROIs. The CLI does not turn thresholded images or sparse ROI complements into ground truth. All declared classes need explicit training examples. CB is not included as a competing class alongside the nested ML/GL/WM labels.

```sh
.venv/bin/python scripts/nissl_lab.py train \
  --manifest study.json --output model-v1
```

Only included sections of `split: train` animals supply fitting pixels. The model samples at most the declared count per class per section, ignores 255, and records sample counts, training animal/source/mask hashes, seed, software versions and manifest identity. Hold out animals before annotation/model selection; use validation animals for tuning, and reserve test animals for a final assessment.

This implementation uses normalized raw channels plus Gaussian local means and standard deviations at sigma 1 and 3 pixels. A 12-pixel halo preserves these features across inference tile boundaries. It fits a CPU random forest and stores bounded arrays of decision nodes and class frequencies as JSON. No pickle is read. Feature sizes are pixel-based, so acquisition magnification and staining variation need external validation. Class frequencies are not calibrated anatomical uncertainty.

Bounds: 1–64 trees, depth 1–16 for training, 10–5,000 samples per class per section and 200,000 requested total samples. Exported models are limited to 100,000 nodes. Oversized or incomplete models fail rather than silently degrading settings. Outputs are a new `model.json` and `training-report.json`.

## Prediction and review queue

Add the generated model identity to a new manifest:

```json
"model": {
  "kind": "pixel-forest-json",
  "path": "./model-v1/model.json",
  "sha256": "COPY model_sha256 FROM training-report.json"
}
```

```sh
.venv/bin/python scripts/nissl_lab.py run \
  --manifest inference.json --output queue-v1
```

Inference uses image pixels and the declared model, never the reference mask. It exports predicted-label TIFF, `cerebellum-prediction/1` JSON, original-pixel ROI contours and a `cerebellum-study/1` draft. Predictions may contain many fragments; no small island is silently removed. The current site adapter's contour limits apply (64 ROIs, 5,000 vertices per ROI, 30,000 total vertices), and incompatible topology/size fails visibly. These limits may need expansion after real data evaluation.

A trained ONNX segmentation model can instead use `kind: onnx`, a verified weight `sha256`, `path` and `manifest` pointing to the existing ONNX adapter manifest. See `NISSL_MODEL_RUNNER.md` for its explicit tensor, class, normalization and tiling requirements. The ONNX adapter owns normalization for that model. ONNX weight provenance and independent validation remain the operator's responsibility; this project supplies no Nissl neural-network weights. The Local Lab `evaluate` command below currently evaluates safe JSON forest models; independent paired-reference evaluation in the website also accepts imported prediction geometry.

Queue states are `queued`, `running`, `needs_review` and `failed`. Source/model/configuration fingerprints and each immutable output's SHA-256/byte count are recorded. Repeating the same command verifies completed outputs before skipping them; changed manifest, source, model or results require a new output directory. Failed jobs are reported with errors, not replaced by empty anatomy. A Mac/Linux OS lock prevents concurrent writers to the same queue. After a process stops, an unfinished job can be retried with identical inputs; a crash precisely after an immutable directory rename but before queue recording fails closed and requires a new output directory.

Missing/oversized input files, identity collisions and invalid global metadata fail before batch launch. A section that fails decoding or inference is marked `failed`, while the remaining valid jobs continue. Importing the queue displays this distinction. `draft-study.json` contains completed jobs only, so it must not be interpreted as a complete study when the queue contains failures. Calibration and depth remain null when unknown; whole-organ coverage is never assumed.

## Held-out evaluation

```sh
.venv/bin/python scripts/nissl_lab.py evaluate \
  --manifest study.json --model model-v1/model.json \
  --split validation --output validation-v1.json

.venv/bin/python scripts/nissl_lab.py evaluate \
  --manifest study.json --model model-v1/model.json \
  --split test --output test-v1.json
```

Training animal IDs and source-image SHA-256 hashes cannot appear in the evaluated split. The inventory also rejects identical images assigned to different animals. These checks depend on truthful identifiers and declared provenance; they cannot discover relabeled near-duplicates or a hidden external training corpus.

Metrics use native pixels where the expert mask is not 255. Both-empty classes have null Dice/IoU, not an invented perfect score; relative area error is null when the reference area is zero. Per-section results retain source/reference identities and ignored counts. Overall Dice averages animal means so mice with more sections do not automatically get greater weight. Reference masks are operator-provided annotations, not assumed error-free truth. The current report does not perform uncertainty calibration, bootstrap confidence intervals, statistical significance, boundary-distance scoring or claims about time saved; those need a designed validation cohort and corresponding analysis.

## Verification

```sh
.venv/bin/python qa/check_nissl_lab.py
IMAGEJ_JAR=/path/to/ij.jar .venv/bin/python qa/check_nissl_lab.py
```

The recorded `qa/nissl-lab.json` distinguishes checks run with the actual ImageJ jar from a skipped optional engine check. The suite fits a real model on synthetic expert masks, tests held-out inference and tile continuity, imports a draft into StudyCore, checks missing values and exclusions, verifies unchanged source hashes and resume/tamper behavior, blocks animal/source leakage, tests explicit failures and prepares an uncompressed RGB TIFF larger than 32 MiB. Synthetic performance is only a software check. Real Nissl generalization remains unverified until suitable independent expert labels and multiple animals are available.
