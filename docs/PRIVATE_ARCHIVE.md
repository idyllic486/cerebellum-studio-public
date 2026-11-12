# Private backup and restoration

The backup covered by this request comprises the code, deployed data, validation outputs and documents of the current working repository, together with the full Git history of `main`. **The private status of Sites, creation of a local copy and completion of an upload to a private GitHub repository are distinct states.** A report of completed GitHub backup requires the actual repository URL, the `private` setting, the uploaded commit and the result of remote verification. The existence of this document does not mean that the upload has been completed.

## Scope of preservation

| Included | Meaning |
|---|---|
| `src/`, build and validation scripts, `docs/` | Editable code, methods, limitations and contribution records |
| `dist/`, `vendor/`, `qa/` | The current deployed copy; experiment-derived data, images and atlas figures within the repository; licences; validation reports and screenshots |
| `main` Git bundle | Preserves parent relationships and original author metadata from the initial import through interface drafts, recovery and subsequent implementation |
| SHA-256 manifest and contribution ledger | Reconciles the identity of current files, the presence of uncommitted changes and the record of each commit |

Data within the current repository are preserved, together with the unverified statuses in the [rights register](RIGHTS_REGISTER.md). A private backup does not create permission for public redistribution of source data or atlas figures.

Excluded are `.git/config`, authentication tokens, SSH keys, cookies, `.env`, cloud credentials and the process environment. A Git bundle contains Git objects and references but not local settings such as remote URLs or credential helpers. However, if a past commit itself contains a secret, it is also included in the bundle, so inspection of current files is distinguished from inspection of history. Data are not deleted arbitrarily and Git history is not rewritten; any findings are handled separately.

`work/cerebellum-scientific-audit` on the Mac, the original `Montage.tif`, ROI ZIP and original CSV files, and the full set of research documents are not included if they are absent from the current working repository. Mac paths and hashes recorded in the data are not backups of the actual original files. Personal projects and annotations held only in a local browser are likewise not included in this backup unless the user has exported them as files.

## Creating the manifest and contribution ledger

Run from the repository root. The output folder is placed outside the repository, and existing folders are not overwritten.

```sh
python3 scripts/prepare_private_archive.py --output /workspace/cerebellum-private-inventory
```

The tool hashes the files listed by `git ls-files` together with this register, the contribution document, the backup document and the tool itself. It does not collect source data or credentials from other locations and does not export remote URLs or environment variables. `archive-manifest.json` records file paths, sizes, SHA-256 digests, Git tracking status and the current HEAD and `main`; `contribution-ledger.json` records the commits reachable from `main`. Uncommitted changes are listed separately under `working_tree_changes`. The tool is not a scanner that determines whether data files are free of secrets.

## Preservation of the full history and restoration test

After committing the final reviewed changes, create the bundle below in a separate archive folder. The final manifest is regenerated after the final commit.

```sh
git bundle create /workspace/cerebellum-private-history.bundle main
git bundle verify /workspace/cerebellum-private-history.bundle
git clone --branch main /workspace/cerebellum-private-history.bundle /workspace/cerebellum-restore-check
```

`git rev-parse main` in the restored copy must match the original commit SHA, and the number of commits and the hashes of key files must agree. Replacing the bundle with a simple ZIP copy of the source would lose reverted interface versions and past change history. Uncommitted changes remaining in the working folder are not included in the bundle and are therefore indicated separately alongside the file manifest.

## GitHub completion record

After the actual upload, the items below are filled in with actual results. The existence or name of the repository is not assumed.

| Item | Value to record |
|---|---|
| Repository URL / owning account | Value actually created and verified |
| Visibility | `private: true` as confirmed via the GitHub API or settings |
| Preserved commit / reference | SHAs of the original `main` and remote `main` |
| History agreement | Parent relationships and commit count, or results of bundle verification and restoration |
| File identity | Comparison of SHA-256 digests between the remote restored copy and the manifest |
| Exclusions and unverified items | Mac originals not present, browser-local files, unverified rights and restoration constraints |

If GitHub is inaccessible, the local bundle, manifest and restoration results are prepared, and the **GitHub upload is recorded as incomplete**. Saving the Sites source or a successful deployment is not reported as a successful GitHub backup.

## Connection status as of 2026-11-03

The repository supplied by the user is https://github.com/idyllic486/cerebellum-studio, and `visibility: private` and write permission were confirmed through the GitHub connection. Separately from the Sites remote of the current checkout, the full history is retained on `main` of this repository. The results of actual remote restoration verification are recorded in `qa/github-backup.json`.

## Result of remote restoration check

After pushing implementation commit `149661174c58f3f487a296a144a895628bfc3097` and its entire preceding history to the private GitHub repository, the repository was cloned again into a separate folder. The parent graph, the ten commits and the SHA-256 digests of 113 tracked files agreed between the original and the restored copy. `qa/github-backup.json` is the corresponding verification record, and the following commit adds this verification record. Visibility was not changed.
