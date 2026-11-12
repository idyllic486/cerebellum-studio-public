#!/usr/bin/env python3
"""Record the actual local tool environment and optional input/model hashes."""
from pathlib import Path
import argparse
import hashlib
import importlib.metadata
import json
import platform
import sys


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def describe(lock_dir=None):
    lock_dir = Path(lock_dir or Path(__file__).resolve().parent / 'locks')
    registry = json.loads((lock_dir / 'manifest.json').read_text())
    system, machine = platform.system(), platform.machine().lower()
    target = ('linux-x86_64-cp312' if system == 'Linux' and machine in ['x86_64', 'amd64'] else
              'macos-arm64-cp312' if system == 'Darwin' and machine == 'arm64' else None)
    boundary = sys.version_info[:2] == (3, 12)
    if system == 'Linux':
        libc, version = platform.libc_ver()
        try:
            boundary = boundary and libc == 'glibc' and tuple(map(int, version.split('.')[:2])) >= (2, 28)
        except ValueError:
            boundary = False
    if system == 'Darwin':
        try:
            boundary = boundary and int(platform.mac_ver()[0].split('.')[0]) >= 13
        except ValueError:
            boundary = False
    packages = []
    lock_match = bool(target and boundary)
    if target:
        spec = registry['targets'][target]
        lock_match = lock_match and sha256(lock_dir / spec['lock']) == spec['sha256']
        for package in spec['packages']:
            try:
                version = importlib.metadata.version(package['name'])
            except importlib.metadata.PackageNotFoundError:
                version = None
            match = version == package['version']
            lock_match = lock_match and match
            packages.append({'name': package['name'], 'expected': package['version'],
                             'installed': version, 'version_matches': match})
    return {'schema': 'cerebellum-execution-environment/1', 'python': sys.version,
            'platform': platform.platform(), 'machine': machine,
            'target_lock': target, 'target_boundary_met': bool(target and boundary),
            'lock_manifest_sha256': sha256(lock_dir / 'manifest.json'),
            'all_locked_versions_installed': bool(lock_match), 'packages': packages,
            'scope': 'Installed-version and platform record. Wheel hashes are enforced by pip --require-hashes during installation; this does not validate biological performance or Safari.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--input', type=Path, action='append', default=[])
    parser.add_argument('--model', type=Path, action='append', default=[])
    parser.add_argument('--verify-lock', action='store_true')
    args = parser.parse_args()
    result = describe()
    result['inputs'] = [{'path': str(p), 'bytes': p.stat().st_size, 'sha256': sha256(p)} for p in args.input]
    result['models'] = [{'path': str(p), 'bytes': p.stat().st_size, 'sha256': sha256(p)} for p in args.model]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
    if args.verify_lock and not result['all_locked_versions_installed']:
        raise SystemExit('Environment does not match its locked platform and package versions; see output manifest.')


if __name__ == '__main__':
    main()
