# Supplied atlas material: intake and interpretation

Three supplied auxiliary files were read locally: `HowToInstallTheAtlas.rtf`, `MouseAbbreviationListMaker.pdf` and `List_of_Abbreviations.xls`. Their hashes and byte counts are in `qa/atlas-materials-intake.json`. The XLS contains 836 abbreviation/name rows. The one-page PDF is an interactive abbreviation-list helper, not anatomical plate geometry. Its embedded program was not executed.

The installation note describes alternative PDF image resolutions, clickable plate navigation and hover explanations. Those are useful metadata sources for the local PDF preparation tool. The note does not establish calibrated three-dimensional region surfaces.

The supplied `MouseBrainAtlasLoRes.pdf` could not be transferred into the execution environment because it exceeds the attachment tool's 32 MiB limit. The original high-resolution PDF remains on the Mac. Subsequent local preparation provided its complete 351-page metadata index and eight selected original-page extracts; these were inspected without transferring the complete 1.70 GB source. See [high-resolution pilot findings](ATLAS_PILOT.md) for exact coverage, checksums, native-vector extraction and missing image coverage. These findings supersede the earlier auxiliary-only intake status.

## Abbreviations are context-specific

The later 82-page drawing transfer was also received and verified. A 32-plane sagittal subset now powers the [separate 3D reference explorer](ATLAS_EXPLORER.md). Coronal and horizontal drawings remain available for subsequent interpretation; their receipt does not establish a fused complete atlas.

The uploaded atlas dictionary uses `CB` for **cell bridges of the ventral striatum**, `ML` for **medial mammillary nucleus, lateral part**, and `PL` for **paralemniscal nucleus**. These are different from the research project's cerebellum/molecular-layer/Purkinje-line terminology. Consequently, an atlas label must never be assigned by blindly matching those strings to project tissue classes.

Names such as `Sim`, `Crus1`, `Crus2`, `PM` and `Cop` identify atlas structures in the dictionary but do not provide their boundaries. Region names, text locations, contour geometry, anatomical correspondence and human confirmation remain distinct records. Neither a PDF annotation rectangle nor a label's bounding box is an anatomical ROI.

The optional atlas comparison engine accepts explicitly calibrated, named regional geometry and reports candidate overlap, ambiguity and missing data. It does not convert these abbreviations into verified lobule segmentations or invent a complete atlas from the three existing raster references.
