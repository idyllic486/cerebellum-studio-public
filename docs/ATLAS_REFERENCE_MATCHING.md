# Optional calibrated atlas reference comparison

`src/atlas_reference_core.js` cuts supplied atlas geometry in physical coordinates and compares candidate reference cuts with an observed outline. The result is a shape-overlap proposal for human review. It is not automatic biological identification, a validated lobule assignment, or a probability that a specimen section corresponds to a particular atlas plate.

## Available evidence and missing material

The full atlas PDF at the user-provided Mac path `/Volumes/金/郭永貴/the mouse brain` remains on the Mac. A subsequent transfer supplied its complete metadata index and four vector diagrams with their four corresponding Nissl plate PDFs. [The pilot](ATLAS_PILOT.md) establishes native curve availability and drawing-grid fits, while identifying two partially captured Nissl fields. These materials do not yet establish a calibrated, labelled, complete 3D atlas. The engine does not treat the extracted drawing strokes or candidate filled compartments as approved anatomical ROIs.

A full reference view requires an actual licence-compatible volumetric atlas or an independently prepared 3D surface. Lobule outlines require explicitly named regional meshes or reviewed, physically calibrated vector contours. Raster images, a PDF page number, and visual similarity alone are insufficient. Neither the base mesh nor a region name certifies that the supplied anatomy is complete or correctly labelled.

## Input and provenance

The module is an optional wrapper around `ReconstructionCore`; the original reconstruction schema and measurement code are unchanged. Existing `cerebellum-atlas/1` meshes remain compatible. The extension is `regions`:

```js
{
  schema: 'cerebellum-atlas/1',
  unit: 'um',
  source: {
    name: 'Actual reference name and version',
    sha256: '64 hexadecimal characters from the actual source',
    license_note: 'Applicable licence and provenance information'
  },
  mesh: { positions: [/* flat physical xyz */], indices: [/* triangles */] },
  landmarks: [{ id: 'named-landmark', position: [0, 0, 0] }],
  regions: [{
    id: 'CB',
    name: 'Name explicitly supplied by this reference',
    mesh: { positions: [/* flat physical xyz */], indices: [/* triangles */] }
  }, {
    id: 'region-with-calibrated-plates',
    name: 'Another supplied region name',
    contours: [{
      id: 'reference-plate-identifier',
      z_um: 125,
      paths: [[[0, 0], [100, 0], [100, 80], [0, 80]]]
    }]
  }, {
    id: 'unavailable-region',
    name: 'Known name without supplied boundary geometry'
  }]
}
```

Regions and contour plates may supply their own `source` with the same required fields; otherwise the parent source is inherited. Original names and declared source information are retained. All geometry uses the same atlas coordinate system and unit. Within a region, contour IDs and Z values must be unique. Missing geometry stays unavailable rather than becoming an empty segmentation. A queried but undeclared region has `name: null` and `reason: 'label_not_supplied'`.

The wrapper also accepts a missing/null base `mesh` for a genuinely contour-only calibrated reference. That input can support comparisons of the actual supplied vector plates; it cannot supply a complete 3D base view and is not accepted by the original mesh-only `ReconstructionCore.validateAtlas`. This distinction avoids requiring a fabricated mesh to use valid 2D evidence.

`__reference__` is a reserved region ID for the whole supplied base mesh. Its display name is “Whole supplied reference mesh”; it is not automatically labelled cerebellum or CB. A region ID such as `CB` must actually exist in the input. The matching caller is responsible for selecting the appropriate explicit reference region for the observed CB outline. The program never substitutes another region when that label is missing.

Validation requires names, units, finite physical coordinates, valid triangle indices, nondegenerate triangle geometry and source identity fields. It does not verify a source hash against an unavailable file, establish licence validity, prove anatomical correctness, or certify a closed/manifold mesh. Geometry, metadata, native specimen ROIs and measurements are not mutated.

## Physical cuts

```js
const fit = ReconstructionCore.fitRigid(atlasLandmarks, specimenLandmarks);
const cut = AtlasReferenceCore.cutReference(reference, specimenZ_um, {
  transform: fit,
  regionIds: ['__reference__', 'CB', 'explicit-lobule-id'],
  tolerance_um: 1e-6
});
```

An explicit proper rigid atlas-to-specimen transform is required, even when it is an explicitly declared identity. Scaling, reflection and nonorthogonal transformations are rejected. Registration residuals and landmark metadata from the supplied fit are retained. They are evidence for review, not proof of anatomical correspondence.

The module first transforms atlas geometry into the specimen frame, then intersects its triangles with `Z = specimenZ_um`. Deduplicated segments are joined into closed loops. Nested loops support holes through an even-odd fill. Open or branched cuts remain available as display segments but have no usable area paths and cannot receive a shape score. Meshes that do not intersect the plane return `status: 'empty'`, with `reason: 'no_mesh_intersection'`; these do not receive a false perfect-match score. No intersection is not evidence that a missing biological region was measured as zero.

Cut tolerance is recorded and must be between 0.0000001 and 1 µm. It controls plane/segment numerical matching. It does not license cropping geometry outside the declared comparison field. The defaults are numerical implementation settings, not biological resolution claims.

If a region provides both a mesh and calibrated contours, its mesh supplies arbitrary physical cuts. A contour-only region is available only when exactly one supplied contour plate lies on the requested transformed horizontal plane within tolerance. The module does not interpolate between contour plates. A tilted transformed 2D plate does not provide an enclosed area on an arbitrary horizontal cut and remains unavailable for that cut.

The result has `unit: 'um'`, `coordinate_frame: 'specimen'`, `z_um`, `transform`, `source`, `tolerance_um` and a `regions` array. Each region returns its original ID/name, availability/reason, `paths`, `segments`, source identity and geometry source. Mesh loops are model-derived reference boundaries, not newly observed specimen boundaries.

For repeated UI cuts, validate and transform once:

```js
const prepared = AtlasReferenceCore.prepareReference(reference, { transform: fit });
const cut = AtlasReferenceCore.cutPrepared(prepared, specimenZ_um, {
  regionIds: ['CB']
});
```

## Ranking candidate reference cuts

```js
const result = AtlasReferenceCore.rankCandidateCuts(
  reference,
  {
    unit: 'um',
    z_um: observedSectionZ_um,
    rois: [{ kind: 'area', closed: true, paths: calibratedObservedCBPaths }]
  },
  [
    { id: 'candidate-1', name: 'Reference cut A', z_um: 100 },
    { id: 'candidate-2', name: 'Reference cut B', z_um: 125 }
  ],
  {
    transform: fit,
    regionId: 'CB',
    grid: { origin: [-5000, -5000], spacing_um: 25, width: 400, height: 400 }
  }
);
```

All candidate Z values are explicit physical depths **after** transformation into specimen coordinates. `observed.z_um` is retained as evidence; it is not overwritten with a suggested reference depth. The observed outline is compared with candidate XY shapes under the same supplied transformation. The algorithm does not search for translations, normalize sizes, rescale bounding boxes, alter native ROI coordinates or silently align each candidate. Wrong registration can therefore lower similarity, as it should.

These are candidate cuts of a reference, which may be virtual slices of a 3D atlas. They are not automatically the nearest original PDF plates. A nonparallel rigid rotation changes which native atlas plane corresponds to a specimen plane. A genuine calibrated plate identity is preserved only when such a contour was actually supplied and is available on that cut.

The complete XY comparison field must be declared: physical origin, positive pixel spacing, width and height. Masks sample pixel centres; paths within one ROI use even-odd fill, and separate observed ROIs are combined by union. Both observed and reference outlines must fit completely inside this field. This prevents a candidate from receiving an inflated score through an independently cropped bounding box or truncated foreground. Structures below the grid resolution remain unscored instead of being treated as a perfect empty match.

For observed mask A and reference mask B over that same grid:

- Dice = `2 × intersection_pixels / (observed_pixels + reference_pixels)`.
- IoU = `intersection_pixels / union_pixels`.

No true-negative count increases these scores, and no confidence probability is estimated. Candidate output contains the full reference cut, Dice/IoU, pixel counts, status and an unscored reason when appropriate. Source, transform and grid settings remain in the result so comparisons can be reproduced.

`ranked_candidate_ids` sorts only comparable cuts by Dice. `best_candidate_ids` preserves ties. `proposal_status` is `candidate_only`, `ambiguous`, `no_overlap` or `no_comparable_candidate`. Only a unique positive best score supplies `proposed_candidate_id`, and even that remains an unvalidated proposal among the supplied candidates. `probability` is always null. A high whole-CB shape score does not establish lobule correspondence or guarantee that the correct plate was among the candidates.

## Resource bounds and integration

The base mesh retains the existing 300,000-vertex / 600,000-triangle limits. Combined regional meshes have the same additional limits. Up to 128 named regions, 512 contour plates per region, two million total contour vertices, 64 candidates and a 512 × 512 comparison grid are supported. One rank operation is bounded to 40 million triangle-plane checks and 40 million contour-edge scanline checks. Oversized requests fail with a request to reduce candidates or grid resolution; original contours are never silently simplified.

The module is synchronous and dependency-free apart from `ReconstructionCore`. Run expensive cuts/ranking in a Worker when integrating it into the browser. Load `reconstruction_core.js` before `atlas_reference_core.js`; correlate replies with the active request and invalidate prepared geometry when the atlas or registration changes. This module does not itself run browser UI, fetch atlas files, train a model or approve any result.

## Validation and next evidence

Run `node qa/check_atlas_reference.cjs`. The synthetic fixtures check named frustum cuts, unequal candidate shapes, an exact shape match, a known rigid rotation/translation, endpoint planes, contour-only reference availability, holes, broken surfaces, absent labels, missing observations, complete grid coverage, ties, zero overlap, invalid provenance/geometry and immutable inputs.

The exact synthetic match has Dice/IoU 1. A smaller concentric square has Dice 0.4 and IoU 0.25. These tests verify implementation and counting rules only. They provide no biological accuracy result, validation of actual lobule boundaries or demonstration that the unavailable full atlas PDF can be recovered.

Scientific validation requires the actual atlas source and permitted usage, calibrated labelled reference geometry, independent correspondence landmarks, reviewed specimen contours and held-out sections/animals with known plate or region labels. Reference lobule boundaries should remain visibly identified as reference annotations until a human has reviewed the proposed specimen correspondence. Whole-organ reference context and observed specimen anatomy must remain separately identifiable throughout the interface.
