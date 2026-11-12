# Reproducible builds, execution and release evidence

## Build profiles

`python3 build_site.py` builds the private research distribution from `src`, `vendor`, documented tools and immutable `assets/baseline` inputs. It does not read the old `dist` directory. The nine historical scientific exports and Three.js/license are byte-preserved explicit inputs with hashes in `config/build-inputs.json`.

The builder verifies those hashes before staging, prepares an exact file allowlist and `build-manifest.json`, and replaces the previous output only after a successful build. Failure leaves the previous distribution intact. Unknown old output files disappear on a successful clean build. Rebuilding the same inputs produces identical file bytes, including the downloadable ZIP files. Filesystem mtimes are not part of that promise.

`python3 build_site.py --profile public-safe` creates **dist-public-safe**, without the example data exports, atlas derivative JSON, or atlas-preparation download. Its embedded deployment profile tells the application that the demo and bundled atlas are unavailable. Personal-data tools can remain usable. This is a technical data-exclusion profile, **not legal authorization to publish**: code ownership/public licensing and rights in other included materials still require owner review. The private profile must never be represented as cleared public data.

## Supported dependency lock targets

Full optional-tool environments (Nissl inference/training, atlas volumes, PDF preparation) have transitive wheel hashes in `scripts/locks/`:

- `linux-x86_64-cp312.txt`: CPython 3.12, Linux x86_64, glibc 2.28 or newer. CI uses Ubuntu 24.04.
- `macos-arm64-cp312.txt`: CPython 3.12, Apple Silicon, macOS 13 or newer. Resolution is recorded; native execution requires a separate Mac test.

Other Python versions, Intel Macs, Windows, ARM Linux and older macOS are not covered by these locks. A platform lock is not proof of native Safari support. The direct requirements remain readable development specifications; locked installation is the reproducible path.

Create an isolated Python 3.12 virtual environment, activate it, then install the lock appropriate to that machine:

```sh
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install --require-hashes --only-binary=:all: -r scripts/locks/linux-x86_64-cp312.txt
python scripts/environment_manifest.py --verify-lock --output execution-environment.json
```

On the covered Mac replace the lock filename with `macos-arm64-cp312.txt`. Optional `--input Montage.tif --model model.onnx` arguments add exact file hashes to the execution manifest. This does not inspect biological accuracy or establish ownership of those files. Packages are not bundled into the website. PyMuPDF/MuPDF remains an optional dependency with AGPL/commercial licensing considerations.

Lock updates are deliberate: resolve with `pip install --dry-run --ignore-installed --only-binary=:all: --report ...` for the explicit Python/platform target, convert using `scripts/lock_python_environment.py`, and rerun the synthetic numerical and tool checks in a new environment. Do not edit hashes to bypass an installation error.

## Current versus historical validation

`python3 qa/run_validation.py` records only checks actually executed in this invocation. It fingerprints sources before/after execution, rejects changes during validation, and writes:

- `qa/validation-run.json`: complete command, exit status, timing, environment, source and output evidence for this run.
- `qa/release-index.json`: canonical pointer with the report hash, source fingerprint, build fingerprint, scope and unresolved external gates.

`python3 scripts/release_provenance.py` verifies the index against the files currently present. A different commit may contain identical source bytes; the source fingerprint, not a commit label alone, is the identity check. A build, source or report mutation invalidates the index. Historical `qa/*.json` files are retained and never silently reclassified as fresh success. GitHub Actions evidence must identify the actual run/commit; local success does not claim a remote Actions result.

The source fingerprint covers source modules, build scripts, dependency locks, explicit inputs, manifests, docs, examples, CI and QA executable files. Generated QA reports and `dist` are excluded from the source fingerprint and verified separately. The build manifest and file hashes establish output integrity, not a cryptographic signature or legal chain of custody.

## Evidence that remains outside the repository

`config/source-evidence.json` distinguishes original source files from derived exports and records unknown hashes as `null`. Preserved ROI/measurement exports and reconstructed volumes cannot stand in for original TIFFs, full atlas PDFs, the Mac scientific-audit directory or institutional permission. `config/rights-manifest.json` records known owners/terms separately from unresolved authorization. Original archives and rights evidence must be supplied or verified before calling the whole research archive reproducible or public-ready.
