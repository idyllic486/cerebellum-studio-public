# Import a physical reference atlas

The Study pipeline accepts a separately identified reference mesh. It does not replace the specimen's contours or measured volumes. A complete reference surface is not proof of complete individual anatomy, and a PDF atlas alone is not a calibrated three-dimensional label volume.

## Convert a licensed label volume

The optional local converter accepts a 3D, integer-labelled NIfTI `.nii` or `.nii.gz` with an explicit qform or sform. Choose the cerebellar label IDs from that atlas's own lookup table; this project supplies no atlas volume or label-number assumptions.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r scripts/requirements-atlas.txt
.venv/bin/python scripts/prepare_atlas.py \
  --input /path/to/licensed-atlas.nii.gz --labels 7 \
  --license-note "Source, version and applicable permission for this local use" \
  --output cerebellum-reference.json
```

`7` is an example, not a known cerebellum label. The converter records the original SHA-256, selected labels, affine, units, sampling stride and licence note. The note records the operator's declaration; it does not verify rights. Existing output paths are never overwritten.

The converter maps voxel-cell boundary faces through the NIfTI affine into µm, retaining cavities and disconnected components. It applies no smoothing, template fitting or specimen-volume measurement. Stride 1 retains the selected voxel boundaries. An explicit `--stride 2` through `--stride 16` makes a nearest-neighbour reference approximation that can lose small structures. No stride change is applied silently. Unknown spatial units require a verified `--unit`; contradictory units are rejected.

Limits: 2 GiB input, 128 million voxels, 512 MiB decoded labels, 300,000 surface vertices and 600,000 triangles. An oversized surface fails with an actionable message; preserve the source and choose an explicit approximation if appropriate.

## Inspect and align in the site

1. Open **My research → Study pipeline → Physical 3D**. Build a specimen model from reviewed contours and actual XY/Z calibration.
2. Under the atlas details, choose **Open atlas JSON**. It is initially an unregistered reference in its own physical frame.
3. Save the landmark template and supply at least three non-collinear corresponding points in µm: `source` in the atlas and `target` in the specimen. The file declares `direction: atlas_to_specimen`.
4. Fit the rigid alignment. Inspect the residuals and geometry, then export the transform and landmark provenance. The fit uses rotation and translation only; it cannot silently normalize away a WT–KO size difference.

Coplanar points cannot establish all aspects of three-dimensional correspondence. A low landmark residual is not an independent anatomical validation. No nonlinear registration or inference of missing individual tissue is claimed.

## Verification

`python qa/check_atlas_converter.py` checks analytic voxel fixtures, anisotropic calibration, handedness, holes/components, explicit stride, invalid metadata and acceptance by the browser's atlas schema. These are numerical checks, not a test on a real cerebellar atlas.
