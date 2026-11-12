#!/usr/bin/env python3
"""Build the site and run the checks that need nothing outside this repository."""
from pathlib import Path
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    subprocess.run([sys.executable, 'build_site.py'], cwd=ROOT, check=True)
    checks = json.loads((ROOT / 'qa/public-checks.json').read_text())
    failed = []
    for number, command in enumerate(checks, 1):
        command = [sys.executable if part == 'python3' else part for part in command]
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
        print('%3d/%d %s %s' % (number, len(checks), 'ok  ' if result.returncode == 0 else 'FAIL', ' '.join(command[1:])), flush=True)
        if result.returncode:
            failed.append(command)
            print((result.stderr or result.stdout)[-1500:])
    print('%d checks, %d failed' % (len(checks), len(failed)))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
