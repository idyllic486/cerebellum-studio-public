#!/usr/bin/env python3
"""Resolve an original-data root using only the selected folder and its ancestors."""
from __future__ import annotations
import argparse
from datetime import datetime
from pathlib import Path
import sys
import uuid

from prepare_training_sources import read_plan, source_path, REFS


def plain_directory(value):
    p = Path(value).expanduser().absolute()
    if '..' in p.parts or any(item.is_symlink() for item in (p, *p.parents)):
        raise ValueError('연결된 폴더(심볼릭 링크)나 상위 이동 경로는 사용하지 않습니다. 실제 원본 폴더를 선택하세요.')
    if not p.is_dir():
        raise ValueError('선택한 폴더를 찾을 수 없습니다.')
    return p.resolve()


def resolve_root(plan_path, selected):
    plan, _ = read_plan(plan_path)
    selected = plain_directory(selected)
    references = [section[key] for section in plan['sections'] for key in REFS]
    matches = []
    closest = (0, None, None)
    for candidate in (selected, *selected.parents):
        found, first_error = 0, None
        for ref in references:
            try:
                path = source_path(candidate, ref['path'])
                if path.stat().st_size != ref['bytes']:
                    raise ValueError('Source size changed: ' + ref['path'])
                found += 1
            except (ValueError, OSError) as error:
                if first_error is None:
                    first_error = str(error)
        if found == len(references):
            matches.append(candidate)
        if found > closest[0]:
            closest = (found, candidate, first_error)
    if len(matches) > 1:
        raise ValueError('원본 연결표에 맞는 상위 폴더가 여러 개입니다. 중복 원본을 구분한 뒤 다시 실행하세요.')
    if not matches:
        detail = (f' 가장 가까운 위치: {closest[1]}. {closest[2]}' if closest[1] else '')
        raise ValueError('선택한 폴더와 상위 폴더에서 전체 연결표에 맞는 원본을 찾지 못했습니다. '
                         '다섯 마리 자료가 있는 연구 폴더를 선택하세요.' + detail)
    return matches[0]


def output_path(root, parent):
    root, parent = plain_directory(root), plain_directory(parent)
    if parent == root or root in parent.parents:
        raise ValueError('결과 저장 위치는 원본 연구 폴더 바깥이어야 합니다.')
    name = 'Cerebellum-Auto-ROI-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:6]
    result = parent / name
    if result.exists():
        raise ValueError('결과 위치가 이미 있습니다. 기존 결과를 덮어쓰지 않습니다.')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('resolve'); p.add_argument('--plan', required=True); p.add_argument('--selected', required=True)
    p = commands.add_parser('output'); p.add_argument('--root', required=True); p.add_argument('--parent', required=True)
    args = parser.parse_args()
    try:
        result = resolve_root(args.plan, args.selected) if args.command == 'resolve' else output_path(args.root, args.parent)
        print(result)
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
