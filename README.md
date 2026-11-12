# Cerebellum Studio

A browser tool for outlining and measuring the layers of the mouse cerebellum on Nissl-stained sagittal sections. It draws a first draft of the regions of interest (ROIs), lets a person correct it, here or in ImageJ/Fiji, and keeps a record of what was reviewed and approved.

Everything runs in the browser. Images and ROI files you open stay on your computer; nothing is uploaded.

## What it does

- **Draft ROIs for a new section.** Open a montage TIFF and use the built-in tissue-layer model to get a draft of the whole cerebellum (CB), molecular layer (ML), granular layer (GL) and white matter (WM).
- **Correct in ImageJ/Fiji.** Download the draft as an ROI ZIP whose outlines are ordinary polygons you can drag in Fiji, then import the corrected file; the layers are worked out again from it.
- **Review and approve.** Edit boundaries in the browser, enter the pixel size, and export approved ROIs with a measurement table and a review record that carries file fingerprints.
- **Study and 3D.** Put approved sections of several animals together with their position and thickness, compare groups, and look at the stack in 3D.
- **Atlas view.** Browse sagittal planes of an openly licensed mouse-brain annotation, load sections that were placed on it, view two animals side by side and record a rotation video.
- **Five interface languages.** English, Korean, Japanese, Traditional and Simplified Chinese.

A synthetic example (a drawing with its ROI file, not tissue) can be downloaded from the automatic ROI card to try the steps.

## What it is not

- **A draft is not a measurement.** The model's outlines must be checked by a person. On 25 sections of two animals that were not used for training, the median overlap with the outlines a person drew (Dice) was 0.95 for CB, 0.92 to 0.93 for ML, 0.96 for GL and 0.82 to 0.88 for WM, but the area of a single section was off by between −12 % and +38 %. Those two animals were looked at more than once while the tool was developed, so they are not a clean independent test.
- **One laboratory, one protocol.** The built-in model was trained on 41 sections of three animals from a single laboratory, with one staining and imaging protocol. How it behaves on other tissue is not known.
- **The Purkinje layer is not detected.** The tool can trace the ML–GL interface as a line and can open a band of a chosen width along it; it does not find Purkinje cells.
- **Atlas positions are estimates.** Matching a section to an atlas plane says which plane it resembles most. It is not a measured position, and within about 1.1 mm of the midline neighbouring planes look alike, so the position there is poorly determined.
- **No conclusion about any group difference is offered.** The tool measures; it does not test hypotheses.

## Run it

```bash
python3 build_site.py
python3 -m http.server 8000 --directory dist
```

Then open `http://localhost:8000`. Python 3.10 or newer is enough to build; there is no server component.

## Checks

```bash
npm ci
npx playwright install chromium
python3 -m pip install -r scripts/requirements-lab.txt -r scripts/requirements-atlas.txt -r scripts/requirements-atlas-pdf.txt -r scripts/requirements-tiff-compatibility.txt torch
python3 qa/run_public_checks.py
```

The checks use made-up shapes and images. They establish that the mechanics work as described (file formats, geometry, review records, the round trip with ImageJ ROIs); they say nothing about anatomical accuracy.

## Licences and credits

| Part | Terms |
|---|---|
| Source code | MIT, see `LICENSE` |
| Built-in model weights (`assets/models/`) | CC BY 4.0. Credit: "Cerebellum Studio tissue-layer model (2026), Kim Min Seong" |
| Atlas outlines (`assets/atlas-open/`) | CC BY 4.0 as stated by their source: Piluso et al., *Imaging Neuroscience* 2025, doi:10.1162/imag_a_00565, built on the Allen Mouse Brain Common Coordinate Framework v3 (Wang et al., *Cell* 2020). The Allen Institute terms allow non-commercial use and ask for written permission before commercial redistribution. See the notice in that folder |
| Libraries under `vendor/` and Three.js | Their own licences, kept beside each file |

`NOTICE.md` has the details.

## How it was made

Written by Kim Min Seong with substantial help from AI coding assistants. The research images and the outlines a person drew, which the model was trained on, are not part of this repository.
