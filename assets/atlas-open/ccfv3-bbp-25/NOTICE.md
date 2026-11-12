# Atlas outlines in this folder

`sagittal-planes.json` holds outlines of the mouse cerebellum cut from a published annotation volume. They are **not** covered by the MIT licence of this project's code.

| | |
|---|---|
| Source | Piluso S, Veraszto C, Carey H, Delattre E, L'Yvonnet T, Colnot E, Romani A, Bjaalie JG, Keller D. "An extended and improved CCFv3 annotation and Nissl atlas of the entire mouse brain." Imaging Neuroscience, 2025. doi:10.1162/imag_a_00565 |
| Obtained from | Zenodo, doi:10.5281/zenodo.15176439, files `annotv3a_bbp_25.nrrd` and `hierarchy_bbp_atlas_pipeline.json` |
| Licence stated on the record | Creative Commons Attribution 4.0 International (CC BY 4.0) |
| Built on | Allen Mouse Brain Common Coordinate Framework v3. Wang Q, Ding S-L, Li Y, et al. Cell 181:936-953, 2020. © Allen Institute for Brain Science. The Allen Institute terms of use allow use, distribution and derivative works for research and other non-commercial purposes and ask for written permission before commercial redistribution |
| What was changed | Sagittal planes were cut every 100 µm from one hemisphere; molecular layer, granular layer and white matter (with the deep nuclei) were outlined along voxel edges and simplified; lobule names were rewritten in the short form used by this project. Made with `scripts/atlas_from_volume.py`; the file records its parameters and the hashes of the source files |

Anyone who redistributes this file should keep this notice, credit the sources above, and check the Allen Institute terms before any commercial use. This notice describes the project's understanding; it is not legal advice.
