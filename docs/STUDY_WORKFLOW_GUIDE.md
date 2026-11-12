# Study pipeline: six stages with explicit evidence

Open **My research → Study & 3D**. Existing example observations, measurement tables and hold-out scores remain separate. Files imported into the site stay in the browser. Save both the original-source project and the derived study before leaving: a Study JSON contains geometry and source hashes, not the original TIFF bytes.

## Start with a real montage

Use **New image analysis** to open a single-section TIFF, or register the TIFF, matching ImageJ ROI ZIP and CSV together under **Register observation data**. A stitched set of camera tiles covering one section is supported. A sheet containing several physical sections must first be separated with an explicitly reviewed coordinate mapping.

The site reads the file directly from your computer; it does not use the chat attachment transfer service. Single-page TIFF files up to 128 MiB, 40 million pixels and 128 MiB decoded pixels are supported. Decoding and preview generation run in a cancellable Worker. Only the preview is reduced; original coordinates and source bytes are retained. BigTIFF, multipage files and some TIFF variants are explicitly unsupported. File size alone does not determine decoded memory use.

Enter the real laboratory animal ID and choose **Start new study from registered animal**, or use **Use image review**. **Add registered animal** copies another registered animal into the current study while preserving the protocol and earlier reviews; duplicate IDs are rejected. Enter actual animal identity, genotype, training/test assignment, pixel sizes and section depths. An image with no model prediction or manual ROI is an image observation, not an automatic anatomical segmentation. This release does not bundle trained Nissl weights.

## Work through the stages

| Stage | Working capability | Evidence still needed for a research claim |
|---|---|---|
| 1. Data | Hash-linked source intake, original-pixel ROIs, physical metadata and preserved CSV cells | Original image/ROI correspondence, source calibration and explicit boundary protocol |
| 2. Review and model adaptation | Review-specific approval; local supervised training and ONNX inference; generated results imported as unapproved drafts | Real expert label masks, known weights, correction burden and external anatomical checks |
| 3. Validation | Paired prediction/reference metrics in a Worker; animal/source leakage checks; animal-balanced reports | Frozen model and protocol, truthful training provenance and genuinely held-out animals |
| 4. Physical 3D | Native-aspect mesh, observed contours, physical cuts, interactive rotation/pan/zoom and separate atlas alignment | Actual section Z, validated registration, coverage and missing-section sensitivity |
| 5. WT / KO | Reviewed animal-level volumes, group plots and descriptive differences | Comparable coverage and protocol, experimental covariates and sufficient independent animals |
| 6. Batch work | Local job manifest, trained-model execution, failure reports, checksum-verified resume and review queue | Prospective error/time comparison and validated failure detection |

The local training and batch runner are downloaded from **Batch work → Download local lab tools**. Training runs on the researcher's Mac/Linux computer, not inside the hosted page. The site does not secretly launch local Python, upload data or approve results. See [Local Lab](LOCAL_LAB.md).

## Measurements and approval

Choose a protocol and measurement definition before approving sections. The default `pixel-mask/1` counts the union of original-pixel centres inside even-odd contours. The alternative `polygon-native/1` uses continuous polygon area with stricter topology checks. Neither label claims exact ImageJ compatibility. Original CSV values remain preserved as source evidence, and the optional local ImageJ path has its own explicit engine and calibration record.

Unknown values stay blank. Calibration, tissue geometry, protocol, inclusion or metadata changes invalidate affected approvals. Reviewer names are entered by the operator; the hash protects the reviewed content but does not authenticate the person. Source images and original ROIs must be visually reviewed in the image workspace, not inferred from an approval checkbox.

Physical volume integrates selected native areas over actual Z by the trapezoidal rule. Missing calibration/Z/layers, stale approvals and unresolved excluded-section gaps prevent a result. Observed-span results are partial volumes. Whole-organ estimates additionally require declared coverage and zero-area endpoints beyond all known section positions; these are assumptions that must be inspected. A rendered cap is a display assumption, not a measurement of tissue.

The 3D grid affects the displayed reconstructed surface. The volume report uses native area and actual Z rather than triangle volume. Keep observed contours, inferred mesh and [reference atlas](ATLAS_IMPORT.md) distinguishable.

## Validation and limits

The browser's paired contour comparison uses a declared 128/256-cell approximation on the full image extent. Missing annotations never imply absent tissue, and both-empty Dice is undefined. Local expert-mask evaluation uses native pixels and explicitly ignored unannotated pixels. These two methods have different discretization and must not be merged as if identical.

Software tests include synthetic images and geometries. A supplied single-section ROI archive also checks compatibility with large, complex traced contours. The original uploaded TIFF has not been inspected in the cloud because its transfer exceeds the attachment tool limit. No real-image segmentation accuracy, independent-animal generalization, review-time saving or complete individual cerebellum recovery has been established.

The focused workspace keeps image analysis, observed data, study/3D and experiments in separate panes. Switching panes does not reset selected files or unapplied review fields. The browser can run an explicitly supplied Local Lab pixel-forest model; no pretrained anatomical model is bundled. Regional annotations are optional overlays and never remove tissue from the preserved layer TOTAL.
