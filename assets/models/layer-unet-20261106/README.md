# Built-in tissue-layer model (2026-11-06)

`auto-roi-unet.json` is the tissue-layer network the site offers as "Use the built-in model". It draws drafts of CB, ML, GL and WM on a Nissl-stained sagittal section of mouse cerebellum. A draft is a starting point for a person to correct; it is not a measurement.

| | |
|---|---|
| Model | `layer-unet-9e3c3a68822e`, schema `cerebellum-auto-roi-unet/1` |
| File | 10,496,980 bytes, SHA-256 `7fa8ae009cf5f3b09c301b5d33ac5dcfc16a89ac7d10a6352f81ee6c554ea722` |
| Trained on | 41 sections of 3 animals, with the outlines a person drew |
| Checked on | whole images of 2 other animals |
| Declared whole-image Dice | CB 0.947, ML 0.914, GL 0.949, WM 0.841 |

The file itself lists which animals and sections it was trained and checked on. The site shows those names only in the "Model details" window; work screens show counts.

What is not established: anatomical accuracy, calibrated confidence, performance on other stains, scanners, ages or genotypes, and independence of the checking animals (they were looked at more than once while the tools were developed). The model was trained on tissue from one laboratory with one staining and imaging protocol.

Licence of the weights: Creative Commons Attribution 4.0 International (CC BY 4.0). Credit them as "Cerebellum Studio tissue-layer model (2026), Kim Min Seong". They are published by the researcher's decision of 2026-11-12; see `NOTICE.md`.
