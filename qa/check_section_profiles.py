#!/usr/bin/env python3
"""Checks of the section profile tool on made-up numbers with known integrals. No biological claim."""
from pathlib import Path
import json
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import section_profiles as P  # noqa: E402


def close(a, b):
    return abs(a - b) <= 1e-9 * max(1, abs(b))


def section(animal, group, number, cb, gl, wm, pl, geometry='line'):
    return {'animal_id': animal, 'group': group, 'section_id': '%s-%d' % (animal, number),
            'values': {'area_um2': {'Cb': cb * 1e6, 'GL_TOTAL': gl * 1e6, 'WM': wm * 1e6}, 'pl_total_geometry': geometry,
                       'pl_total_length_um': None if pl is None else pl * 1e3}}


def main():
    assert close(P.integral([(1, 2.0), (7, 2.0), (13, 4.0)], 1, 13), 2 * 6 + 3 * 6)
    assert close(P.integral([(1, 2.0), (7, 2.0), (13, 4.0)], 4, 10), 2 * 3 + (2 + 3) / 2 * 3)     # ends between measured sections
    assert P.integral([(7, 2.0), (13, 4.0)], 1, 13) is None and P.integral([(1, 2.0), (7, 2.0)], 1, 13) is None  # range not covered
    assert close(P.integral([(1, 2.0), (7, None), (13, 4.0)], 1, 13), 3 * 12)                      # a missing value is bridged
    manifest = {'sections': [section('A', 'WT', n, 4.0, 1.0, 1.0, 10.0) for n in (13, 1, 7)] +
                            [section('B', 'KO', 1, 2.0, 0.5, 0.5, 5.0), section('B', 'KO', 13, 4.0, 1.5, 0.5, None, 'area')]}
    animals, summary = P.profiles(manifest, 1, 13)
    assert animals['A']['numbers'] == [1, 7, 13] and close(animals['A']['integral']['Cb'], 48) and close(animals['A']['integral']['Cb-GL-WM'], 24)
    assert close(animals['A']['mean_over_range']['Cb'], 4.0) and close(animals['B']['integral']['Cb'], 36) and close(animals['B']['integral']['GL_TOTAL'], 12)
    assert animals['B']['integral']['PL_length'] is None and animals['B']['sections'][1]['PL_length'] is None
    assert summary['Cb'] == {'KO': {'animals': 1, 'values': {'B': 36.0}, 'min': 36.0, 'max': 36.0, 'mean': 36.0},
                             'WT': {'animals': 1, 'values': {'A': 48.0}, 'min': 48.0, 'max': 48.0, 'mean': 48.0}}
    assert set(summary['PL_length']) == {'WT'}
    with tempfile.TemporaryDirectory() as temporary:
        folder = Path(temporary)
        (folder / 'm.json').write_text(json.dumps(manifest))
        assert P.main(['--manifest', str(folder / 'm.json'), '--range', '1,13', '--output', str(folder / 'out')]) == 0
        written = json.loads((folder / 'out' / 'section-profiles.json').read_text())
        assert written['range'] == [1, 13] and 'No volume' in written['statement'] and str(folder) not in json.dumps(written)
        assert written['volumes'] is None
        assert P.main(['--manifest', str(folder / 'm.json'), '--range', '1,13', '--thickness-um', '20', '--thickness-um', '40', '--output', str(folder / 'vol')]) == 0
        volumes = json.loads((folder / 'vol' / 'section-profiles.json').read_text())['volumes']
        by = volumes['by_section_thickness_um']
        assert set(by) == {'20', '40'} and close(by['20']['A']['Cb'], 48 * 0.020) and close(by['40']['A']['Cb'], 48 * 0.040)
        assert volumes['units']['Cb'] == 'mm3' and volumes['units']['PL_length'] == 'mm2' and by['20']['B']['PL_length'] is None
        assert len((folder / 'vol' / 'volumes.csv').read_text().splitlines()) == 5 and not (folder / 'out' / 'volumes.csv').exists()
        assert P.main(['--manifest', str(folder / 'm.json'), '--range', '1,13', '--thickness-um', '0', '--output', str(folder / 'no')]) == 2
        assert P.main(['--manifest', str(folder / 'm.json'), '--range', '1,13', '--thickness-um', '20', '--thickness-um', '20', '--output', str(folder / 'no')]) == 2
        (folder / 'two.json').write_text(json.dumps({'sections': manifest['sections'] + [section('A', 'KO', 19, 1, 1, 1, 1)]}))
        assert P.main(['--manifest', str(folder / 'two.json'), '--range', '1,13', '--output', str(folder / 'no')]) == 2
    print('Section profile checks passed on made-up numbers.')


main()
