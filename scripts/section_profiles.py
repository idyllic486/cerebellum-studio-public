#!/usr/bin/env python3
"""Mediolateral profiles of section values per animal, and their integral over a stated range of section numbers.

Input is the reference manifest of human-reviewed ROI files (build_reference_manifest.py). Section thickness is not
recorded anywhere, so nothing here is a volume: an integral is in mm2 x section numbers (mm x section numbers for PL
length) and becomes mm3 (mm2) only when multiplied by the thickness of one section in mm. Section numbers are taken
as positions; whether the same number is the same anatomical place in every animal is not checked by this tool.
It describes the animals it is given and tests nothing.
"""
import argparse
import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nissl_lab import file_digest, require  # noqa: E402

SCHEMA = 'cerebellum-section-profiles/1'
VALUES = ('Cb', 'GL_TOTAL', 'WM', 'Cb-GL-WM', 'PL_length')
UNITS = {'Cb': 'mm2', 'GL_TOTAL': 'mm2', 'WM': 'mm2', 'Cb-GL-WM': 'mm2', 'PL_length': 'mm'}
COLOURS = {'WT': ('#1f6feb', '#58a6ff', '#0b3d91'), 'KO': ('#d1242f', '#ff8182')}
STATEMENT = ('Descriptive profiles of human-reviewed ROI values. No volume unless a section thickness is stated, no statistical test, '
             'and no check that equal section numbers are equal anatomical positions.')


def number_of(section_id):
    tail = section_id.rsplit('-', 1)[-1]
    require(tail.isdigit(), 'Section name does not end in a number: ' + section_id)
    return int(tail)


def section_values(section):
    """The values of one manifest section in mm2 and mm; None where the human file does not give the value."""
    v = section['values']
    area = {k: (None if a is None else a / 1e6) for k, a in v['area_um2'].items()}
    rest = None if any(area.get(k) is None for k in ('Cb', 'GL_TOTAL', 'WM')) else area['Cb'] - area['GL_TOTAL'] - area['WM']
    line = v.get('pl_total_geometry') == 'line' and v.get('pl_total_length_um') is not None
    return {'Cb': area.get('Cb'), 'GL_TOTAL': area.get('GL_TOTAL'), 'WM': area.get('WM'), 'Cb-GL-WM': rest,
            'PL_length': v['pl_total_length_um'] / 1e3 if line else None}


def integral(points, low, high):
    """Trapezoid integral of (number, value) points between two section numbers, with straight lines between measured
    sections. None unless measured sections reach both ends of the range."""
    points = sorted(p for p in points if p[1] is not None)
    if len(points) < 2 or points[0][0] > low or points[-1][0] < high:
        return None

    def at(n):
        for (a, va), (b, vb) in zip(points, points[1:]):
            if a <= n <= b:
                return va + (vb - va) * (n - a) / (b - a)

    xs = [low] + [n for n, _ in points if low < n < high] + [high]
    ys = [at(n) for n in xs]
    return sum((ys[i] + ys[i + 1]) / 2 * (xs[i + 1] - xs[i]) for i in range(len(xs) - 1))


def profiles(manifest, low, high):
    animals = {}
    for section in manifest['sections']:
        entry = animals.setdefault(section['animal_id'], {'group': section['group'], 'sections': []})
        require(entry['group'] == section['group'], 'An animal has sections of two groups.')
        entry['sections'].append(dict(number=number_of(section['section_id']), section=section['section_id'], **section_values(section)))
    for entry in animals.values():
        entry['sections'].sort(key=lambda s: s['number'])
        numbers = [s['number'] for s in entry['sections']]
        require(len(set(numbers)) == len(numbers), 'Two sections of one animal have the same number.')
        entry['numbers'] = numbers
        entry['integral'] = {name: integral([(s['number'], s[name]) for s in entry['sections']], low, high) for name in VALUES}
        entry['mean_over_range'] = {name: (None if value is None else value / (high - low)) for name, value in entry['integral'].items()}
    groups = {}
    for name in VALUES:
        for animal, entry in animals.items():
            if entry['integral'][name] is not None:
                groups.setdefault(name, {}).setdefault(entry['group'], {})[animal] = entry['integral'][name]
    summary = {}
    for name, by_group in groups.items():
        summary[name] = {group: {'animals': len(found), 'values': found, 'min': min(found.values()), 'max': max(found.values()),
                                 'mean': sum(found.values()) / len(found)} for group, found in sorted(by_group.items())}
    return animals, summary


def svg(animals, low, high):
    """One small panel per value: a line per animal against section number."""
    width, panel, left, top = 900, 190, 70, 30
    order = sorted(animals, key=lambda a: (animals[a]['group'], a))
    used, colour = {}, {}
    for animal in order:
        group = animals[animal]['group']
        palette = COLOURS.get(group, ('#555555',))
        colour[animal] = palette[used.get(group, 0) % len(palette)]
        used[group] = used.get(group, 0) + 1
    highest = max(n for a in animals.values() for n in a['numbers'])
    x = lambda n: left + (width - left - 160) * (n - 1) / max(1, highest - 1)
    out = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" font-family="sans-serif" font-size="12">' % (width, top + panel * len(VALUES) + 30),
           '<rect width="100%" height="100%" fill="#ffffff"/>']
    for row, name in enumerate(VALUES):
        y0 = top + row * panel
        values = [s[name] for a in animals.values() for s in a['sections'] if s[name] is not None]
        peak = max(values) * 1.08 if values else 1
        y = lambda v: y0 + panel - 40 - (panel - 60) * v / peak
        out.append('<rect x="%.1f" y="%d" width="%.1f" height="%d" fill="#f2f2f2"/>' % (x(low), y0 + 10, x(high) - x(low), panel - 50))
        out.append('<line x1="%d" y1="%.1f" x2="%.1f" y2="%.1f" stroke="#888"/>' % (left, y(0), x(highest), y(0)))
        out.append('<text x="%d" y="%d" font-weight="bold">%s (%s)</text>' % (left, y0 + 8, name, UNITS[name]))
        out.append('<text x="%d" y="%.1f" text-anchor="end">%.2f</text><text x="%d" y="%.1f" text-anchor="end">0</text>' % (left - 6, y(peak / 1.08) + 4, peak / 1.08, left - 6, y(0) + 4))
        for animal in order:
            points = [(s['number'], s[name]) for s in animals[animal]['sections'] if s[name] is not None]
            if points:
                out.append('<polyline fill="none" stroke="%s" stroke-width="2" points="%s"/>' % (colour[animal], ' '.join('%.1f,%.1f' % (x(n), y(v)) for n, v in points)))
                out.extend('<circle cx="%.1f" cy="%.1f" r="2.5" fill="%s"/>' % (x(n), y(v), colour[animal]) for n, v in points)
        if row == len(VALUES) - 1:
            for n in range(1, highest + 1, 12):
                out.append('<text x="%.1f" y="%.1f" text-anchor="middle">%d</text>' % (x(n), y(0) + 16, n))
            out.append('<text x="%.1f" y="%.1f" text-anchor="middle">section number</text>' % ((x(1) + x(highest)) / 2, y(0) + 32))
    for i, animal in enumerate(order):
        out.append('<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="%s" stroke-width="3"/><text x="%d" y="%d">%s %s</text>' % (
            width - 140, top + 20 + 20 * i, width - 115, top + 20 + 20 * i, colour[animal], width - 108, top + 24 + 20 * i, animal, animals[animal]['group']))
    out.append('<text x="%d" y="%d" fill="#555">grey: range %d to %d</text></svg>' % (width - 140, top + 30 + 20 * len(order), low, high))
    return '\n'.join(out)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Mediolateral profiles of section values per animal.')
    parser.add_argument('--manifest', required=True, type=Path, help='reference-manifest.json of build_reference_manifest.py')
    parser.add_argument('--range', required=True, metavar='LOW,HIGH', help='Section numbers between which values are integrated.')
    parser.add_argument('--output', required=True, type=Path, help='New folder; an existing one is never touched.')
    parser.add_argument('--thickness-um', type=float, action='append', help='Thickness of one section in micrometres, as stated by the '
                        'researcher. Repeat it to write volumes for several candidate values. Without it no volume is written.')
    args = parser.parse_args(argv)
    try:
        low, _, high = args.range.partition(',')
        require(low.isdigit() and high.isdigit() and int(low) < int(high), 'Give the range as LOW,HIGH in section numbers.')
        low, high = int(low), int(high)
        output = args.output.resolve()
        require(not output.exists(), 'The output folder already exists.')
        manifest = json.loads(args.manifest.read_text())
        require(isinstance(manifest.get('sections'), list) and manifest['sections'], 'Not a reference manifest.')
        animals, summary = profiles(manifest, low, high)
        options = args.thickness_um or []
        require(all(1 <= t <= 500 for t in options) and len(set(options)) == len(options), 'Section thickness must be between 1 and 500 micrometres, each value once.')
        volumes = None
        if options:
            volumes = {'source': 'thickness stated on the command line; this tool cannot check it, and with several values none is preferred',
                       'assumptions': ['every section of every animal has this thickness', 'no section between two numbers is missing',
                                       'no correction for shrinkage', 'straight lines between measured sections'],
                       'units': {name: ('mm3' if UNITS[name] == 'mm2' else 'mm2') for name in VALUES},
                       'by_section_thickness_um': {('%g' % t): {animal: {name: (None if value is None else value * t / 1000) for name, value in entry['integral'].items()}
                                                                for animal, entry in animals.items()} for t in options}}
        output.mkdir(parents=True)
        result = {'schema': SCHEMA, 'statement': STATEMENT, 'manifest_sha256': file_digest(args.manifest), 'range': [low, high],
                  'integral_unit': 'value unit x section numbers; multiply by the thickness of one section in mm for mm3 (mm2 for PL length)',
                  'units': UNITS, 'animals': animals, 'groups': summary, 'volumes': volumes,
                  'code_sha256': file_digest(Path(__file__).resolve())}
        (output / 'section-profiles.json').write_text(json.dumps(result, indent=1, sort_keys=True) + '\n', encoding='utf-8')
        with open(output / 'section-profiles.csv', 'x', newline='', encoding='utf-8') as handle:
            writer = csv.writer(handle)
            writer.writerow(['Animal', 'Group', 'Section', 'Number'] + ['%s_%s' % (n, UNITS[n]) for n in VALUES])
            for animal in sorted(animals):
                for s in animals[animal]['sections']:
                    writer.writerow([animal, animals[animal]['group'], s['section'], s['number']] + ['' if s[n] is None else '%.4f' % s[n] for n in VALUES])
        (output / 'section-profiles.svg').write_text(svg(animals, low, high), encoding='utf-8')
        if volumes:
            with open(output / 'volumes.csv', 'x', newline='', encoding='utf-8') as handle:
                writer = csv.writer(handle)
                writer.writerow(['Section_Thickness_um', 'Animal', 'Group', 'Range'] + ['%s_%s' % (n, volumes['units'][n]) for n in VALUES])
                for t, found in volumes['by_section_thickness_um'].items():
                    for animal in sorted(found):
                        writer.writerow([t, animal, animals[animal]['group'], '%d-%d' % (low, high)] + ['' if found[animal][n] is None else '%.4f' % found[animal][n] for n in VALUES])
    except (ValueError, OSError) as error:
        print('Not written: ' + str(error), file=sys.stderr)
        return 2
    print(json.dumps({'schema': SCHEMA, 'animals': len(animals), 'range': [low, high]}, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
