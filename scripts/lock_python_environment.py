#!/usr/bin/env python3
"""Convert a pip --report dry-run into a reviewed, target-specific hash lock.

The report must come from pip --ignore-installed --only-binary=:all: resolution.
This tool records dependency artifacts; it does not imply runtime validation.
"""
from pathlib import Path
import argparse
import hashlib
import json
from urllib.parse import urlparse, unquote


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--target', choices=['linux-x86_64-cp312', 'macos-arm64-cp312'], required=True)
    parser.add_argument('--output-dir', type=Path, default=Path(__file__).resolve().parent / 'locks')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    report = json.loads(args.report.read_text())
    packages = []
    for entry in report['install']:
        info = entry['download_info']
        name = unquote(Path(urlparse(info['url']).path).name)
        if not name.endswith('.whl'):
            raise ValueError('Only prebuilt wheel artifacts are supported: ' + name)
        packages.append({'name': entry['metadata']['name'], 'version': entry['metadata']['version'],
                         'wheel': name, 'sha256': info['archive_info']['hashes']['sha256'],
                         'direct_requirement': entry.get('requested', False)})
    packages.sort(key=lambda item: item['name'].lower())
    args.output_dir.mkdir(parents=True, exist_ok=True)
    filename = args.target + '.txt'
    lock = '# Generated from reviewed pip resolution. CPython 3.12 target-specific wheels.\n'
    lock += '# Install with --require-hashes --only-binary=:all:. See manifest.json for platform limits.\n'
    lock += ''.join(f"{p['name']}=={p['version']} --hash=sha256:{p['sha256']}\n" for p in packages)
    (args.output_dir / filename).write_text(lock)
    manifest_path = args.output_dir / 'manifest.json'
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {
        'schema': 'cerebellum-python-locks/1',
        'scope': 'Optional local scientific tools; no model weights, TIFFs or atlas media included.',
        'native_safari_validation': 'not-performed', 'targets': {}}
    requirements = ['requirements-nissl.txt', 'requirements-lab.txt', 'requirements-atlas.txt', 'requirements-atlas-pdf.txt']
    manifest['direct_requirements'] = {name: hashlib.sha256((root / 'scripts' / name).read_bytes()).hexdigest() for name in requirements}
    manifest['targets'][args.target] = {
        'lock': filename, 'sha256': hashlib.sha256(lock.encode()).hexdigest(),
        'python': 'CPython 3.12', 'resolver_pip': report['pip_version'],
        'platform': 'Linux x86_64, glibc >= 2.28' if args.target.startswith('linux') else 'macOS >= 13, Apple Silicon arm64',
        'validation': 'resolved-only; execution results must be recorded separately', 'packages': packages}
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')


if __name__ == '__main__':
    main()
