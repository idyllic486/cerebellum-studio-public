# Study recovery and preserved versions

## Scope and status

The Study workspace now persists browser-local recovery copies independently of
Image analysis and Observations. Implementation targets audit DATA-01 and DATA-02
for Study, and the Study portion of DATA-11. Recovery is not cloud backup,
authenticated collaboration, model validation, or proof that a download reached
disk.

| Item | Implemented behavior | Evidence / remaining scope |
| --- | --- | --- |
| DATA-01: Study autosave | Debounced IndexedDB autosave, including unapplied metadata and protocol fields; independent unload warning for pending, failed or busy work | `qa/check_study_recovery.cjs`; 12 synthetic browser groups pass |
| DATA-02: replacement | Open study, synthetic example, image review, registered-animal start and recovery restore require an explicit stay/switch choice. Prior and incoming copies are committed before switching. Add-animal preserves the prior version without treating addition as replacement. | Cancel, all replacement routes, pending edits and additive evidence tested |
| DATA-11: downloads | UI says download requested, asks user to check the file and retains browser recovery | Downloaded JSON reopened in a fresh browser context |
| UX-09: mixed status | Study tabs describe input readiness; separate input/computation/scientific-evidence values use the core readiness result; computed volume and group design limitations remain visible | Core scientific-policy tests and full built-site integration are separate from recovery tests |
| UX-08: advanced contracts | Recovery requires no manual JSON editing. Review scope is explicit: source-linked or geometry-only. | Full nontechnical preparation of validation, atlas and local-runner contracts is outside this recovery change; do not mark all UX-08 complete based on it |

## What is saved

Schema: `cerebellum-study-recovery/1`. Each record contains the complete existing
`cerebellum-study/1` document, pending field values (including blanks), pending
metadata/protocol flags, selected animal/section/layer/stage, imported paired
validation data, atlas/landmark resources, queue snapshot and available derived
results. Study source names, hashes, coordinates, missing values, exclusions,
protocol, self-entered approvals and history are retained unchanged.

Study does **not** embed original TIFF, ImageJ ROI ZIP or CSV bytes. Those must be
retained separately or in the originating Observations/Image analysis archive.
A recorded source hash is an identity link; recovery does not reverify absent
source bytes or turn a declaration into independent scientific evidence.

Restore validates the Study schema and approval fingerprints. It restores
unapplied fields without applying them. The review confirmation checkbox resets
to unchecked. Existing valid approval records remain existing records; restore
creates no new approvals. Saved derived result data remain in the retained old
record and downloaded package, but the live workspace requires recomputation.
Atlas transforms are recomputed from saved, validated physical landmark pairs.

## Storage behavior and failures

- Database: `cerebellum-study-recovery`, object store `sessions`, version 1.
- Atomic compare-and-swap revisions prevent stale tabs from overwriting newer
  versions. Explicit removal also checks the revision shown in the version list.
- Maximum 20 versions and 256 MiB JSON per version. No automatic eviction.
  Existing records can still update at the record-count limit. The browser may
  impose a lower quota; writes report the actual failure.
- Database open and transaction operations time out after five seconds.
  Quota, unavailable storage, blocked database, timeouts and conflicts never
  report a successful save.
- A switch first commits current work, then creates a distinct incoming record.
  Any failed commit leaves the current workspace open. On a stale-tab conflict,
  a confirmed switch preserves the local branch in a new conflict-copy record
  before restoring the chosen copy; it never overwrites the other tab's record.
- The active version cannot be removed through the UI. Old versions require
  explicit confirmation. A failed or cancelled download does not remove copies.
- Browser storage belongs to this origin and browser profile. Clearing site
  data, private-mode lifecycle and storage eviction can remove it. Cross-device
  backup requires downloading a workspace recovery file and retaining originals.

## Operations

Open **Study recovery → Recovery options** to save immediately, keep a separate
current version, download/open a workspace recovery file, or restore/download/
remove older versions. Restoring makes a new active record and keeps the selected
saved version. A study-only download remains a standard interoperable Study JSON;
workspace recovery is a separate file with UI state and supporting resources.

`CerebellumStudy.applyScienceChange(transform, message)` provides a guarded
integration path for scientific tools. It rejects unapplied fields, validates
the resulting Study, retains a prior recovery copy, commits the new record,
clears derived results and preserves current selection. Core changes remain
responsible for invalidating affected approvals. The `cerebellum-study-change`
event announces a refreshed Study view.

## Verification

Run `node qa/check_study_recovery.cjs` with Chromium and loopback networking.
The source-only harness exercises the actual Study panel, Study code and real
IndexedDB in Chromium. Its data and quota failures are explicitly synthetic;
there is no anatomical or Nissl model accuracy claim. The report is
`qa/study-recovery.json`. Existing `qa/check_study_browser.cjs` now explicitly
confirms replacement dialogs instead of relying on silent replacement.

The focused test covers approval/history and blank-field preservation, reload,
all replacement entry points, additive animal import, quota rollback, unload
warning, multi-tab CAS and branch preservation, workspace download and fresh
context restore, 20-version capacity without eviction, stale deletion,
unavailable storage and open timeout. Full built-site, five-language and
scientific baseline verification are performed by the coordinating release task.
