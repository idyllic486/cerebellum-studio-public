#!/usr/bin/env python3
"""Verify a current release against measured source, output and validation hashes."""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIRS = ('src', 'scripts', 'config', 'assets', 'vendor', 'examples', 'docs', 'server', '.github')
SOURCE_ROOT_FILES = ('build_site.py', 'package.json', 'package-lock.json', 'README.md', '.openai/hosting.json')


def sha256(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def source_snapshot(root=ROOT):
    root = Path(root)
    paths = {root / name for name in SOURCE_ROOT_FILES if (root / name).is_file()}
    for directory in SOURCE_DIRS:
        paths.update(p for p in (root / directory).rglob('*') if p.is_file()
                     and '__pycache__' not in p.parts and p.suffix != '.pyc')
    paths.update(p for p in (root / 'qa').rglob('*') if p.suffix in ['.py', '.cjs', '.js', '.mjs'])
    entries = {str(p.relative_to(root)): sha256(p) for p in sorted(paths)}
    fingerprint = hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return {'sha256': fingerprint, 'files': entries}


def verify_build(root=ROOT, output='dist'):
    folder = Path(root) / output
    manifest_path = folder / 'build-manifest.json'
    manifest = json.loads(manifest_path.read_text())
    expected = {entry['path']: entry['sha256'] for entry in manifest['files']}
    if len(expected) != len(manifest['files']):
        raise ValueError('Duplicate manifest output path.')
    if any(p.is_symlink() for p in folder.rglob('*')):
        raise ValueError('Deployment outputs must not contain symbolic links.')
    actual = {str(p.relative_to(folder)) for p in folder.rglob('*') if p.is_file()}
    if actual != set(expected) | {'build-manifest.json'}:
        raise ValueError('Build output file set differs from the current manifest.')
    for name, digest in expected.items():
        if sha256(folder / name) != digest:
            raise ValueError('Build output hash differs: ' + name)
    return {'path': output + '/build-manifest.json', 'sha256': sha256(manifest_path),
            'profile': manifest['profile'], 'file_count': len(expected)}


def write_index(report_path, root=ROOT):
    root = Path(root)
    report = json.loads(Path(report_path).read_text())
    try:
        build = verify_build(root)
    except (ValueError, FileNotFoundError, KeyError) as error:
        build = {'verified': False, 'error': str(error)}
    index = {'schema': 'cerebellum-release-index/1',
             'status': 'passed' if report['pass'] and build.get('sha256') else 'failed',
             'validation': {'path': str(Path(report_path).relative_to(root)), 'sha256': sha256(report_path)},
             'source_commit': report['source_commit'], 'source_sha256': report['source_end']['sha256'],
             'build': build, 'run_started_utc': report['started_utc'], 'run_finished_utc': report['finished_utc'],
             'evidence_policy': 'Only the linked fresh validation run is current. Other qa reports remain historical unless explicitly listed in that run.',
             'scope': report['scope'], 'external_gates': [
                 'Native Safari and real Mac large TIFF execution not established by Linux Chromium tests.',
                 'Independent-animal model/segmentation accuracy and expert atlas/lobule validation remain required.',
                 'Publication rights and original-source archive completeness require owner evidence.']}
    (root / 'qa/release-index.json').write_text(json.dumps(index, indent=2, sort_keys=True) + '\n')
    return index


def verify_index(path, root=ROOT):
    root = Path(root)
    index = json.loads(Path(path).read_text())
    if index['status'] != 'passed':
        raise ValueError('The canonical validation run did not pass.')
    report_path = root / index['validation']['path']
    if sha256(report_path) != index['validation']['sha256']:
        raise ValueError('Validation report changed or was replaced.')
    report = json.loads(report_path.read_text())
    if not report['pass'] or not report.get('checks') or any(c['exit_code'] != 0 for c in report['checks']):
        raise ValueError('Validation report has no complete passing check list.')
    if len(report['checks']) != report.get('expected_check_count'):
        raise ValueError('Validation did not execute the full declared check list.')
    if index['source_sha256'] != report['source_end']['sha256']:
        raise ValueError('Release index source differs from the linked validation report.')
    if report['source_start']['sha256'] != report['source_end']['sha256']:
        raise ValueError('Sources changed during validation.')
    if source_snapshot(root)['sha256'] != index['source_sha256']:
        raise ValueError('Current source differs from the validated source fingerprint.')
    build = verify_build(root)
    if build['sha256'] != index['build']['sha256']:
        raise ValueError('Current build differs from the validated output fingerprint.')
    return index


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify', type=Path, default=ROOT / 'qa/release-index.json')
    args = parser.parse_args()
    result = verify_index(args.verify)
    print('Current release evidence verified:', result['source_sha256'])


if __name__ == '__main__':
    main()
