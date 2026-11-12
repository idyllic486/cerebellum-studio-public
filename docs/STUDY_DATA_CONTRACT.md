# Study pipeline data contract

Schema `cerebellum-study/1`. Unknown physical values are JSON `null`; original ROI coordinates remain pixels. Animal IDs are unique and each animal belongs to one split. Importing a file does not establish authenticated identity or anatomical accuracy.

```json
{
  "schema": "cerebellum-study/1",
  "id": "study-1",
  "title": "My cerebellum study",
  "created_at": "2026-11-03T00:00:00.000Z",
  "protocol": {
    "id": "unassigned", "version": "1",
    "measurement_profile": "pixel-mask/1",
    "boundary_definition": "", "maximum_gap_um": null
  },
  "animals": [{
    "id": "animal-1", "group": "other", "split": "unassigned",
    "sex": null, "age_days": null, "batch": null,
    "coverage": {"kind":"observed_span","start_um":null,"end_um":null,"confirmed":false},
    "sections": [{
      "id":"section-1","order":1,"z_um":null,"thickness_um":null,
      "included":true,"exclusion_reason":"",
      "source": null,
      "calibration":{"um_per_pixel_x":null,"um_per_pixel_y":null},
      "rois":[],"model":null,"origin":"manual","review":null,
      "layer_selection":{}
    }]
  }],
  "history": []
}
```

`source`, when available, is `{name,sha256,width,height}`. Its SHA-256 identifies original source bytes. `rois` use ResearchCore objects `{name,kind:'area'|'polyline'|'point',closed,paths:[[[x,y],...]],...}`; metadata and other original fields are preserved. Predicted ROI objects with `{id,label,paths}` are accepted by `create` and receive an explicit name/kind/closed representation. `model` is null or declared model metadata, including weight digest and training-animal IDs when known. `origin` is `manual` or `model`.

`layer_selection` optionally maps `CB`, `ML`, `GL`, `WM` to an array of exact ROI names. Without an explicit choice, a unique `<layer>_TOTAL` or exact layer name is used. Local fragments are never silently assumed to form an exhaustive layer. Explicit multiple ROIs are measured as a union, not a sum, under `pixel-mask/1`.

`pixel-mask/1` counts native pixel centres using even-odd filling within each ROI and union across explicitly selected ROIs. It retains holes and supports touching image-derived contours. This is a declared sampling convention, not a claim of matching ImageJ's polygon rasterisation. `polygon-native/1` computes continuous area only for a single ROI with strict simple-ring topology; it does not silently fall back to a raster method. Neither profile replaces the source CSV. ImageJ measurements and this derived measurement remain separate.

Whole-organ coverage requires `coverage.kind:'whole_organ'`, explicit `start_um`/`end_um` outside all known section positions (including excluded sections), and `confirmed:true`. Zero area at these endpoints is an explicit reconstruction assumption, retained in the result. Otherwise volume is only the trapezoidal integral over the observed section span. Missing layer/calibration/Z prevents a volume result. A skipped interior section or interval over `maximum_gap_um` requires explicit `allowExcludedGapInterpolation:true` in the calculation options; gaps are always reported.

Approval is a self-entered reviewer decision tied to source, geometry, exclusions, calibration, actual Z, animal metadata and the protocol by SHA-256. Changes invalidate affected approvals. Imported approvals are integrity-checked but are not authenticated signatures. The numerical analysis requires current approvals; a draft physical-series preview is separately labelled.

Public API: `create`, `validate`, async `importStudy`/`exportStudy`, `patchAnimal`, `patchSection`, `setProtocol`, `addAnimal`, `addSection`, async `approveSection`, `sectionFingerprint`, `reviewStatus`, `fromResearch`, `fromAnalysis`, `selectLayerROIs`, `sectionArea`, `physicalContours`, async `toPhysicalSeries`, `analyzeAnimal`, `compareGroups`, `stageReadiness`. API result shapes are documented alongside the implementation. Missing values remain missing; no automatic genotype, calibration, physical depth, image identity or review approval is inferred.

## Integration calls and reports

```js
let study = StudyCore.create({id, title, protocol, animals});
study = StudyCore.patchSection(study, animalId, sectionId, {z_um: 120});
study = await StudyCore.approveSection(study, animalId, sectionId, {
  reviewer: 'Entered reviewer name', protocol: 'What was inspected', checked: true
});
const volume = await StudyCore.analyzeAnimal(study, animalId, 'CB', {
  allowExcludedGapInterpolation: false
});
const comparison = await StudyCore.compareGroups(study, 'CB');
const physical = await StudyCore.toPhysicalSeries(study, animalId, 'CB', {
  requireApproved: true, allowExcludedGapInterpolation: false
});
const saved = await StudyCore.exportStudy(study);
const restored = await StudyCore.importStudy(JSON.stringify(saved));
```

All edits return a new frozen study; the input remains intact. `patchAnimal` accepts group, split, sex, age_days, batch and coverage; `patchSection` accepts order, z_um, thickness_um, included, exclusion_reason, source, calibration, rois, model, origin and layer_selection. Changing animal metadata invalidates its section approvals. Changing protocol invalidates every approval. Changing a section invalidates that section's approval. Neither import bridge grants approval. Supplied protocol IDs identify the user's declared protocol, not an externally certified procedure.

`sectionArea(section, layer, {profile})` returns `{value_um2, area_px2, reason, roi_names, profile}`. Failed/missing measurements have null numeric fields and an explicit reason. Measurement is at original-coordinate resolution, bounded to 32,768 pixels of extent per axis and 40 million scanline-edge intersections. Full geometry remains stored if a calculation exceeds this budget; no simplification is substituted. Two million source ROI vertices and 96 MiB study JSON are supported. Original image bytes are kept in the research project/source files rather than embedded into the study JSON.

`analyzeAnimal` returns `{available, animal_id, group, layer, profile, volume_um3, coverage, span_um, sections, excluded_sections, intervals, reasons, warnings}`. A failed volume has `available:false` and `volume_um3:null`. Section entries contain original physical Z, area, selected ROI names and approval status. Intervals contain their endpoints, actual spacing, excluded section IDs and gap flag. Interval values on a blocked report are diagnostic candidate integrals, not an approved aggregate. Thickness is retained as metadata but is never substituted for the measured distance between observations. `CB` and cortical layers are separate outputs and must not be added together as independent tissue volumes.

`compareGroups` returns `{available, layer, profile, animals, groups:{WT,KO}, difference_um3, percent_difference, reasons, interpretation}`. Each group has `{n, mean_um3, sd_um3, values}`. `n` counts animals; sections are not biological replicates. Every animal assigned WT or KO participates, and unavailable animals prevent the aggregate from being marked available. Partial spans must have identical physical endpoints, and partial/whole-organ estimates cannot mix. The caller must ensure the physical frame and anatomical boundary protocol correspond across animals. Small cohorts yield descriptive estimates only; no p-value is created.

`toPhysicalSeries` returns `{unit:'um', sections:[{id,order,z_um,rois,source}], provenance}`. ROI XY coordinates in this derived copy are multiplied by the two entered pixel scales. Provenance records approvals, protocol, excluded sections and explicit gap interpolation. The reconstruction module may use these contours for display; its grid interpolation and surface are not a replacement for the native measurement profile. There is no physical 3D result when actual Z or calibration is missing.

`stageReadiness` returns `{counts, stages:[{number,title,status,reasons}]}`. Stage 1 can become ready when source identity and the measurement contract are recorded. Each stage separately reports input readiness, execution for the current inputs, and scientific evidence. Included source-linked manual sections can complete the review stage without a model. Current calculation results can complete execution; a validation report must match the current model, geometry, exclusions and full protocol and satisfy declared criteria to affect validation readiness. The presence of software functions, reviewer names or a ready input status does not establish model accuracy, independent validation, anatomical completeness or prospective automation performance.

`fromResearch` preserves original ROI metadata, exclusions, source image identity when provided, original calibration/Z, source CSV cells and file descriptors. It never converts display-order depth to micrometres. A stripped research snapshot that lacks image identity leaves `source:null`. `fromAnalysis` retains source/model, original prediction, original metadata, prior review and history as provenance, but requires a fresh Study review. Both bridges preserve unknown fields as missing and never relabel manually registered observation data as model predictions.

Approval hashes detect stale edits relative to the record; someone who rewrites a file and recomputes all hashes can create another self-entered record. This is not a digital signature, identity provider, access-control system or proof of anatomical correctness.
