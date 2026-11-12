#!/usr/bin/env python3
"""Cut sagittal planes out of an annotated mouse-brain volume and write them as an atlas plane series.

The volume is a labelled 3D image in the Allen CCFv3 layout (first axis anterior to posterior, second dorsal to
ventral, third left to right) with a label hierarchy that names, under the cerebellum, a granular and a molecular
layer for each lobule. Each plane becomes one plate: the outline of the whole cerebellum, the outline of granular
layer plus white matter, the three compartments separately, and the names of the lobules present.

What this is: outlines of a published average-brain annotation, for comparing a section's shape with. It is not a
measurement of any animal, the Purkinje layer is not in the volume, the deep nuclei are counted with the white
matter they lie in, and cerebellum voxels that carry no layer are left out. The outlines keep the terms of the atlas they come from; see the `source` block of the output.
"""
import argparse
import gzip
import hashlib
import json
import math
import sys
import zlib
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import roi_draft as D  # noqa: E402
from nissl_lab import require  # noqa: E402
from roi_editable import simplify_closed  # noqa: E402

SCHEMA = 'cerebellum-atlas-plane-series/1'
PARAMETERS = {'status': 'proposed', 'plane_step_um': 100.0, 'simplify_tolerance_voxels': 0.75, 'min_ring_area_voxels': 4,
              'min_lobule_area_voxels': 32, 'hemisphere': 'right'}
# The lobule names the laboratory's ROI files use, for the same structures.
LOBULE_NAMES = {'LING': '1Cb', 'CENT2': '2Cb', 'CENT3': '3Cb', 'CUL4, 5': '4/5Cb', 'DEC': '6Cb', 'FOTU': '7Cb', 'PYR': '8Cb',
                'UVU': '9Cb', 'NOD': '10Cb', 'SIM': 'Sim', 'ANcr1': 'Crus1', 'ANcr2': 'Crus2', 'PRM': 'PM', 'COPY': 'Cop',
                'PFL': 'PFl', 'FL': 'Fl'}
LIMITATIONS = ['Outlines of an average-brain annotation, not of any animal measured here.',
               'The Purkinje layer is not drawn in the volume.',
               'Deep cerebellar nuclei are counted with the white matter that surrounds them.',
               'Cerebellum voxels that carry no layer label are left out of every outline.',
               'Outlines follow voxel edges and are simplified; detail below one voxel is not present.',
               'Islands and holes smaller than min_ring_area_voxels voxels are not drawn, while area_um2 counts every voxel, so the two can differ by those.',
               'The annotation is symmetric; one hemisphere is written and left is not told from right.']


def read_nrrd(path):
    """A gzip-encoded, little-endian, three-dimensional NRRD with an attached header."""
    raw = Path(path).read_bytes()
    require(raw.startswith(b'NRRD'), 'Not an NRRD file.')
    cut = raw.find(b'\n\n')
    require(cut > 0, 'The NRRD header has no end.')
    header = dict(line.split(': ', 1) for line in raw[:cut].decode('ascii', 'replace').split('\n')
                  if ': ' in line and not line.startswith('#'))
    require(header.get('dimension') == '3' and header.get('encoding') in ('gzip', 'gz') and header.get('endian', 'little') == 'little',
            'Only gzip-encoded little-endian 3D volumes are read.')
    kinds = {'uint32': '<u4', 'unsigned int': '<u4', 'uint16': '<u2', 'unsigned short': '<u2', 'uint8': 'u1', 'unsigned char': 'u1'}
    require(header.get('type') in kinds, 'Unsupported voxel type: ' + str(header.get('type')))
    sizes = [int(v) for v in header['sizes'].split()]
    try:
        body = gzip.decompress(raw[cut + 2:])
    except (EOFError, OSError, zlib.error) as error:
        raise ValueError('The volume data is damaged or incomplete.') from error
    data = np.frombuffer(body, dtype=kinds[header['type']])
    require(data.size == sizes[0] * sizes[1] * sizes[2], 'The voxel count does not match the header.')
    spacing = [abs(float(part.strip('()').split(',')[i])) for i, part in enumerate(header['space directions'].split())]
    require(len(set(spacing)) == 1 and spacing[0] > 0, 'Voxels must be cubes.')
    origin = [float(v) for v in header.get('space origin', '(0,0,0)').strip('()').split(',')]
    return data.reshape(sizes, order='F'), spacing[0], origin


def label_roles(tree):
    """Which labels are granular layer, molecular layer and white matter of the cerebellum, and each layer label's lobule."""
    nodes = {}

    def walk(node, parent):
        nodes[node['id']] = {'acronym': node['acronym'], 'name': node['name'], 'parent': parent}
        for child in node.get('children', []):
            walk(child, node['id'])
    require(isinstance(tree, dict), 'The hierarchy is not a labelled tree.')
    roots = tree['msg'] if 'msg' in tree else [tree]
    for root in roots:
        walk(root, None)
    by_acronym = {v['acronym']: i for i, v in nodes.items()}
    require(all(name in by_acronym for name in ('CB', 'arb', 'CBN')), 'The hierarchy has no cerebellum, arbor vitae or cerebellar nuclei.')

    def under(i, top):
        while i is not None:
            if i == top:
                return True
            i = nodes[i]['parent']
        return False
    cerebellum, nuclei = by_acronym['CB'], by_acronym['CBN']
    roles, lobule_of = {by_acronym['arb']: 'WM'}, {}
    for i, v in nodes.items():
        if not under(i, cerebellum):
            continue
        if v['name'].endswith(', granular layer') or v['name'].endswith(', molecular layer'):
            roles[i] = 'GL' if v['name'].endswith(', granular layer') else 'ML'
            lobule_of[i] = nodes[v['parent']]['acronym']
        elif under(i, nuclei):
            roles[i] = 'WM'
        # Cerebellum voxels that carry no layer are left out: they are thin leftovers at the brainstem, not a compartment.
    return roles, lobule_of


def rings(mask, parameters):
    """Simplified closed outlines of a mask, in voxel-corner coordinates (column, row)."""
    out = []
    for path in D.trace_mask(mask):
        pts = np.asarray(path, float)
        area = abs(float(np.dot(pts[:, 0], np.roll(pts[:, 1], -1)) - np.dot(pts[:, 1], np.roll(pts[:, 0], -1)))) / 2
        if area >= parameters['min_ring_area_voxels']:
            out.append(simplify_closed([list(map(int, p)) for p in path], parameters['simplify_tolerance_voxels']))
    return out


def planes(volume, spacing, origin, roles, lobule_of, parameters):
    """One plate per chosen sagittal plane of one hemisphere that holds cerebellum."""
    ids = np.array(sorted(roles))
    lookup = {'ML': [i for i in ids if roles[i] == 'ML'], 'GL': [i for i in ids if roles[i] == 'GL'], 'WM': [i for i in ids if roles[i] == 'WM']}
    width = volume.shape[2]
    middle = (width - 1) / 2
    step = max(1, int(round(parameters['plane_step_um'] / spacing)))
    first = int(np.ceil(middle))
    chosen = range(first, width, step) if parameters['hemisphere'] == 'right' else range(int(np.floor(middle)), -1, -step)

    def to_um(path):                                  # x: anterior positive, y: dorsal positive, in the volume's own frame
        return [[round(-(c * spacing + origin[0] - spacing / 2), 1), round(-(r * spacing + origin[1] - spacing / 2), 1)] for c, r in path]
    plates = []
    for k in chosen:
        plane = volume[:, :, k].T                     # rows dorsal to ventral, columns anterior to posterior
        part = {name: np.isin(plane, members) for name, members in lookup.items()}
        inside = part['ML'] | part['GL'] | part['WM']
        if not inside.any():
            continue
        paths = []
        for name, mask, role in (('Cb', inside, 'published_compartment'), ('GL+WM', part['GL'] | part['WM'], 'published_compartment'),
                                 ('ML', part['ML'], 'layer_compartment'), ('GL', part['GL'], 'layer_compartment'), ('WM', part['WM'], 'layer_compartment')):
            for n, ring in enumerate(rings(mask, parameters)):
                paths.append({'id': 'plane-%d-%s-%d' % (k, name, n), 'compartment': name, 'kind': 'fill', 'role': role, 'closed': True, 'points': to_um(ring)})
        labels = []
        for acronym in sorted(set(lobule_of.values())):
            members = [i for i, a in lobule_of.items() if a == acronym]
            where = np.argwhere(np.isin(plane, members))
            if len(where) >= parameters['min_lobule_area_voxels'] and acronym in LOBULE_NAMES:
                r, c = where.mean(axis=0)
                labels.append({'text': LOBULE_NAMES[acronym], 'atlas_acronym': acronym, 'area_um2': float(len(where) * spacing * spacing),
                               'position': to_um([[c + 0.5, r + 0.5]])[0]})
        if not any(p['compartment'] == 'Cb' for p in paths):
            continue
        plates.append({'id': 'sagittal-plane-%d' % k, 'figure': int(k), 'lateral_um': float(round(abs(k - middle) * spacing, 1)),
                       'area_um2': {name: float(mask.sum() * spacing * spacing) for name, mask in (('Cb', inside), ('ML', part['ML']), ('GL', part['GL']), ('WM', part['WM']))},
                       'paths': paths, 'labels': labels, 'approved_tissue_roi': False})
    return plates


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser(description='Sagittal atlas planes from an annotated mouse-brain volume.')
    parser.add_argument('--volume', required=True, type=Path, help='Annotation volume (NRRD, CCFv3 layout).')
    parser.add_argument('--hierarchy', required=True, type=Path, help='Label hierarchy of the volume (JSON).')
    parser.add_argument('--source', required=True, type=Path, help='JSON describing the atlas: name, citation, licence, where it was obtained.')
    parser.add_argument('--output', required=True, type=Path, help='New file; an existing one is never replaced.')
    parser.add_argument('--plane-step-um', type=float, default=PARAMETERS['plane_step_um'])
    args = parser.parse_args(argv)
    try:
        require(not args.output.exists(), 'The output file already exists.')
        require(math.isfinite(args.plane_step_um) and args.plane_step_um > 0, 'Give the plane spacing as a positive number of micrometres.')
        parameters = dict(PARAMETERS, plane_step_um=args.plane_step_um)
        source = json.loads(args.source.read_text(encoding='utf-8'))
        require(isinstance(source, dict), 'The source description is not a JSON object.')
        require(all(isinstance(source.get(k), str) and source[k] for k in ('name', 'citation', 'license', 'obtained_from')),
                'The source description needs name, citation, license and obtained_from.')
        volume, spacing, origin = read_nrrd(args.volume)
        roles, lobule_of = label_roles(json.loads(args.hierarchy.read_text(encoding='utf-8')))
        # Planes fall on voxels: the spacing actually used is the nearest whole number of voxels, at least one.
        parameters['plane_step_applied_um'] = max(1, int(round(parameters['plane_step_um'] / spacing))) * spacing
        plates = planes(volume, spacing, origin, roles, lobule_of, parameters)
        require(plates, 'No plane of the volume holds cerebellum.')
        result = {'schema': SCHEMA, 'unit': 'um',
                  'source': dict(source, sha256=digest(args.volume), hierarchy_sha256=digest(args.hierarchy), voxel_um=spacing),
                  'series': {'plane': 'sagittal', 'axis': 'ML', 'bilateral_coverage': False, 'hemisphere': parameters['hemisphere'],
                             'coordinate_frame': {'path_x': 'volume anterior-posterior position, positive anterior',
                                                  'path_y': 'volume dorsal-ventral position, positive dorsal',
                                                  'plane_z': 'distance from the midplane of the volume'}},
                  'status': 'derived-from-annotation-volume-unreviewed', 'parameters': parameters,
                  'code_sha256': digest(Path(__file__).resolve()), 'plates': plates, 'limitations': LIMITATIONS,
                  'whole_organ_volume': None, 'histology_registration': None, 'biological_validation': None}
        args.output.write_text(json.dumps(result, separators=(',', ':')) + '\n', encoding='utf-8')
    except (ValueError, OSError, KeyError) as error:
        print('Not converted: ' + str(error), file=sys.stderr)
        return 2
    print(json.dumps({'schema': SCHEMA, 'plates': len(plates), 'lateral_um': [plates[0]['lateral_um'], plates[-1]['lateral_um']]}, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
