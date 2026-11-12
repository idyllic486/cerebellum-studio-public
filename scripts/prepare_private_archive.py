#!/usr/bin/env python3
"""Export file hashes and Git contribution metadata, never credentials or raw .git.

Does not copy data, create a GitHub repository, or decide distribution rights.
The historical Git bundle is created and verified separately.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
EXPLICIT_FILES = (
    'docs/RIGHTS_REGISTER.md', 'docs/CONTRIBUTIONS.md',
    'docs/PRIVATE_ARCHIVE.md', 'scripts/prepare_private_archive.py',
)


def git(*args: str) -> bytes:
    return subprocess.run(['git', '-C', str(ROOT), *args], check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def sensitive_path(relative: str) -> bool:
    parts = [p.lower() for p in Path(relative).parts]
    return any(p in {'.git', '.ssh', '.aws', '.azure', '.config', '.netrc',
                     '.npmrc', '.pypirc', 'credentials', 'credentials.json',
                     'id_rsa', 'id_ed25519', 'cookies.txt'} or p.startswith('.env')
               or p.endswith(('.pem', '.p12', '.pfx', '.key')) for p in parts)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True,
                        help='New output directory outside the source repository.')
    args = parser.parse_args()
    output = args.output.expanduser().resolve()
    if output == ROOT or ROOT in output.parents:
        parser.error('Output must be outside the source repository.')
    if output.exists():
        parser.error('Output already exists; choose a new directory to avoid overwriting evidence.')
    tracked = {p.decode('utf-8') for p in git('ls-files', '-z').split(b'\0') if p}
    names = tracked | {p for p in EXPLICIT_FILES if (ROOT / p).is_file()}
    files, omitted = [], []
    for name in sorted(names):
        path = ROOT / name
        if sensitive_path(name):
            omitted.append({'path': name, 'reason': 'credential/config path excluded'})
            continue
        if path.is_symlink():
            omitted.append({'path': name, 'reason': 'symlink excluded; target not followed'})
            continue
        resolved = path.resolve()
        if ROOT not in resolved.parents:
            raise ValueError('File escaped repository: ' + name)
        if not path.is_file():
            omitted.append({'path': name, 'reason': 'tracked file absent from working tree'})
            continue
        files.append({'path': name, 'bytes': path.stat().st_size,
                      'sha256': sha256(path), 'git_tracked': name in tracked})
    head = git('rev-parse', 'HEAD').decode().strip()
    main_ref = git('rev-parse', 'refs/heads/main').decode().strip()
    commits = []
    fields = ('sha', 'parents', 'author_name', 'author_email', 'author_date',
              'committer_name', 'committer_email', 'committer_date', 'subject', 'body')
    for commit in git('rev-list', '--reverse', 'refs/heads/main').decode().splitlines():
        raw = git('show', '-s', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%b', commit)
        values = raw.decode('utf-8').rstrip('\n').split('\0', len(fields) - 1)
        record = dict(zip(fields, values, strict=True))
        record['parents'] = record['parents'].split()
        commits.append(record)
    generated = datetime.now(timezone.utc).isoformat()
    # Status contains paths, not file contents or remote URLs. -z avoids quoting paths.
    changes = [item.decode('utf-8') for item in
               git('status', '--porcelain=v1', '-z', '--untracked-files=normal').split(b'\0') if item]
    manifest = {'schema': 'cerebellum-private-inventory/1', 'generated_at': generated,
                'head': head, 'main': main_ref, 'files': files, 'omitted': omitted,
                'working_tree_changes': changes,
                'scope': 'Current tracked working files plus the four explicit archive documentation/tool files; no external Mac files.',
                'rights_register': 'docs/RIGHTS_REGISTER.md',
                'github_upload_performed': False}
    ledger = {'schema': 'cerebellum-contribution-ledger/1', 'generated_at': generated,
              'ref': 'refs/heads/main', 'head': main_ref, 'commits': commits,
              'interpretation': 'Git attribution only; not proof of identity, human authorship, inventorship or ownership.'}
    output.mkdir(parents=True)
    for name, data in [('archive-manifest.json', manifest), ('contribution-ledger.json', ledger)]:
        (output / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Prepared {len(files)} file hashes and {len(commits)} commit records; {len(omitted)} paths omitted.')
    print('No GitHub upload, source-file copy, environment export or Git history mutation performed.')


if __name__ == '__main__':
    main()
