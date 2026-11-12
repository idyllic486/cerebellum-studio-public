# Physical 3D reconstruction and atlas reference

`src/reconstruction_core.js` builds a research preview from calibrated, reviewed-or-draft section contours. Its surface is an interpolation of available observations. It does not recover unobserved anatomy, establish whole-organ coverage, or calculate a scientific volume from its display mesh.

## Required evidence and coordinates

The input contains at least two sections in a common physical coordinate system. `StudyCore.toPhysicalSeries(...)` converts native ROI coordinates using explicitly entered per-section X/Y calibration and requires actual section depth in µm. A section number is not a physical depth. An anisotropic pixel calibration must be applied before reconstruction; X, Y and Z then share the same unit.

```js
const series = await StudyCore.toPhysicalSeries(study, animalId, layer, {
  requireApproved: false,
  allowExcludedGapInterpolation: false
});
const mesh = ReconstructionCore.reconstruct(series, {
  gridSize: 64,
  subdivisions: 3,
  endcaps: false
});
```

The physical-series schema is:

```js
{
  unit: 'um',
  sections: [{
    id: 'section-1', order: 0, z_um: 125.5,
    rois: [{
      name: 'region', label: 'CB', kind: 'area', closed: true,
      paths: [[[0, 0], [100, 0], [100, 80], [0, 80]]]
    }],
    source: { /* original source identities supplied by StudyCore */ }
  }, /* at least one further section */],
  provenance: { /* study, animal, calibration, approvals, exclusions */ }
}
```

Inputs are cloned. Original contour coordinates, source references, missing values, exclusions and numerical measurement results are not overwritten. A missing selected ROI is an error, not an area of zero. Section IDs/orders must be unique and Z must increase with order; reversed or duplicate depths are not silently repaired. The core accepts area contours only, without claiming anatomical or self-intersection validation.

`StudyCore` is the authority for selection, exclusion and approval rules. Calling the low-level reconstruction API directly does not establish that a contour has been approved. Draft previews must retain their draft status in the UI. An explicitly permitted gap across an excluded section is still an unobserved interval, never a restored observation.

## Surface algorithm and its limits

1. A common square XY grid covers the complete contour extent with 12% padding on each side. Supported resolutions are 32, 64 or 96 cells per axis. Grid nodes are sampled in physical µm.
2. Paths within one ROI use an even-odd fill, preserving holes when resolved. Separate ROIs are combined by union. This interpretation is specific to the display reconstruction and is not a substitute for the native measurement protocol.
3. A two-pass exact Euclidean distance transform produces a signed distance field from each binary grid mask. It measures distances on the sampled lattice, not exact distances to the original vector outline.
4. Between adjacent observed sections, signed fields are interpolated linearly using the actual physical depth fraction. Unequal section spacing is retained. Marching tetrahedra extracts the zero surface. Components can join, split or disappear during interpolation; those events are model output, not observed biological changes.
5. No geometry is extrapolated before the first or after the last observed Z. Ends remain open by default. Optional end caps close only those endpoint planes and are explicitly tagged as synthetic display geometry.

Fine folia, small components or holes may disappear at a coarse grid. If an entire observed selected region disappears, the operation fails and requests a higher resolution instead of producing an empty observation. Increasing subdivisions adds display sampling within an interval; it does not add experimental information or guarantee anatomical accuracy. No deformable alignment or learned tissue segmentation is performed by this module.

All generated surface triangles are reconstructed geometry, including triangles touching an observed plane. Exact original contour overlays are supplied separately. A continuous display has no visual gaps but does not prove completeness of an individual cerebellum. An atlas PDF alone cannot determine a complete individual 3D specimen: physical 3D reference data, specimen observations, registration evidence and independent validation are needed.

## Mesh, cuts and the Worker contract

The mesh result includes flat `positions` in µm, triangle `indices`, one `triangle_kind` per face (`0` for reconstructed side surface, `1` for synthetic cap), `observedContours`, `planes`, physical `bounds`, `grid`, `provenance` and `warnings`. A renderer may compute vertex normals from positions/indices. The supplied `display_transform` has a center and a **single** uniform scale; applying separate X/Y/Z scales would misrepresent physical shape.

Every generated plane is labelled `observed` or `interpolated` with its source IDs and interpolation fraction. Observation detection uses the exact stored Z coordinate, without decimal rounding. A cut selected at a nearby but unequal depth is interpolated. Intervals carry their actual µm gap and section-order gap, and are labelled `unobserved_interpolation`.

`cut(series, z_um, options)` and `cutPrepared(prepared, z_um)` return a grid mask and 2D contour segments, plus exact original `observed_rois` only at an observed depth. The mask/segments remain grid-derived display data at every depth, with `measurement: false`. Out-of-span cuts are rejected. Three.js clipping planes can support interactive cuts without repeatedly recomputing geometry.

Heavy reconstruction runs in `src/reconstruction_worker.js`:

```js
worker.postMessage({
  request_id: 1,
  operation: 'reconstruct',
  series,
  options: { gridSize: 64, subdivisions: 3, endcaps: false }
});
// Reply: { request_id: 1, result: mesh } or { request_id: 1, error: message }
worker.postMessage({ request_id: 2, operation: 'cut', z_um: 140 });
```

Cuts use the last successful prepared series. A replacement reconstruction clears that cache before preparation, including on error, so a subsequent cut cannot expose stale geometry as a new result. The caller must also discard responses from superseded request IDs and recreate the Worker when changing the active study.

Bounds: 128 sections; 100,000 vertices per ROI; 2,000,000 contour vertices per series; 512 generated planes; 400,000 surface triangles. Coordinates must be finite, with absolute value at most 100,000,000 µm. Limits reject oversized work without silently decimating source contours.

## External atlas and rigid registration

There is no fabricated default atlas. An independently sourced reference mesh must declare physical units, source name, source SHA-256 and a licence/provenance note:

```js
{
  schema: 'cerebellum-atlas/1',
  unit: 'um',
  source: { name: 'Reference name and version', sha256: '64 hex characters',
            license_note: 'Rights and provenance information' },
  mesh: { positions: [/* flat xyz µm */], indices: [/* triangle indexes */] },
  landmarks: [{ id: 'named-landmark', position: [0, 0, 0] }]
}
```

`validateAtlas` clones the input and rejects nonfinite or out-of-range coordinates, invalid indices, repeated-index or zero-area triangles, missing provenance and oversized data. Limits are 300,000 vertices, 600,000 triangles and 100 named landmarks. Validation does not establish licence validity, manifold topology, anatomical correctness, mesh completeness or that a declared source hash matches an independently available source file.

`fitRigid(sourcePoints, targetPoints)` estimates a proper least-squares rigid transform with the Horn quaternion method. The source points are atlas landmarks; corresponding target points are specimen landmarks in the same order. At least three non-collinear paired 3D points are required. Return values include a 3×3 `rotation`, `translation`, a column-major Three.js `matrix`, scale fixed at one, RMS and individual landmark residuals, and review flags. The algorithm permits neither reflection nor scaling. Coplanar landmarks are explicitly flagged because they cannot resolve 3D handedness; use spatially distributed, non-coplanar landmarks to assess it. A high residual flag uses 5% of landmark-cloud radius as a review heuristic, not an experimentally validated accuracy threshold.

`transformAtlas(atlas, fit)` returns a new reference-only mesh and landmarks. It preserves the source identity and original input, checks that the rotation is orthonormal with determinant +1, and preserves lengths and volume under the rigid transformation. It cannot correct tissue tears, section deformation or true genotype-associated shape differences. A mirrored 3D correspondence leaves a residual rather than being silently reflected.

The external reference is contextual anatomy. Registered atlas regions are not additional specimen observations and must not fill missing native measurements. Native animal volume estimation and WT/KO comparisons remain in `StudyCore`, based on the selected measurement protocol, calibration, approval state and actual section spacing. Display mesh volume is never used as their substitute.

## Verification and remaining evidence

Run `node qa/check_reconstruction_core.cjs`. Synthetic cases check a cylinder, an annulus with a hole, separate components, unequal physical Z, exact observation labels, immutable source geometry, no outside-span extrapolation, open ends and explicit caps, physically anisotropic dimensions, a known rigid transform, mirrored/coplanar correspondence behavior, atlas validation, preserved reference-mesh volume and Worker cache invalidation.

At 64-cell XY resolution the synthetic cylinder's closed display-mesh volume differs from the analytic cylinder by about 0.36%; the 96-cell annulus differs by about 0.14%. These are numerical regression checks for these fixtures only. They are not error estimates for an actual cerebellum and do not validate native specimen volume measurements.

Required further evidence includes calibrated serial sections in a common coordinate system, reviewed contours across the sampled depth, a licence-compatible 3D atlas, independent landmark checks, held-out actual sections and an anatomical reconstruction comparison. Whole-organ coverage, deformation recovery, atlas registration accuracy and end-to-end analysis of the user's original TIFF are not established by the synthetic checks in this module.
