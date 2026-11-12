#!/usr/bin/env python3
"""Convert explicitly selected labels of a licensed NIfTI atlas to a reference mesh.

This is an atlas reference, not reconstructed or measured individual anatomy.
Voxel-face geometry retains holes/components; no smoothing or implicit registration.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import sys

MAX_VOXELS = 128_000_000
MAX_DECODED = 512 * 1024 * 1024
MAX_VERTICES = 300_000
MAX_TRIANGLES = 600_000
UNIT_SCALE = {'meter': 1e6, 'mm': 1000.0, 'micron': 1.0, 'um': 1.0}

def require(condition, message):
    if not condition:
        raise ValueError(message)

def file_sha256(path):
    checksum = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(4 * 1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()

def voxel_mesh(mask, affine, stride=1):
    import numpy as np
    require(mask.ndim == 3 and mask.dtype == bool and mask.any(), 'The selected atlas labels are empty or not a 3D mask.')
    require(isinstance(stride, int) and 1 <= stride <= 16, 'Stride must be an integer from 1 to 16.')
    positions, indices, vertices = [], [], {}
    # Integer corner coordinates refer to the sampled grid; NIfTI integer indices
    # refer to voxel centres. Explicit half-cell offsets are applied below.
    corners = {
        (0, -1): [(0,0,0),(0,0,1),(0,1,1),(0,1,0)],
        (0, 1): [(1,0,0),(1,1,0),(1,1,1),(1,0,1)],
        (1, -1): [(0,0,0),(1,0,0),(1,0,1),(0,0,1)],
        (1, 1): [(0,1,0),(0,1,1),(1,1,1),(1,1,0)],
        (2, -1): [(0,0,0),(0,1,0),(1,1,0),(1,0,0)],
        (2, 1): [(0,0,1),(1,0,1),(1,1,1),(0,1,1)],
    }
    reverse = np.linalg.det(affine[:3,:3]) < 0
    for (axis, direction), offsets in corners.items():
        exposed = mask.copy()
        target, neighbour = [slice(None)] * 3, [slice(None)] * 3
        target[axis] = slice(None, -1) if direction == 1 else slice(1, None)
        neighbour[axis] = slice(1, None) if direction == 1 else slice(None, -1)
        exposed[tuple(target)] &= ~mask[tuple(neighbour)]
        count = int(np.count_nonzero(exposed))
        require(len(indices)//3 + count*2 <= MAX_TRIANGLES,
                'Atlas surface exceeds 600000 triangles. Choose a larger explicit --stride; no geometry was silently simplified.')
        for cell in zip(*np.nonzero(exposed)):
            face = []
            for offset in offsets:
                key = tuple(int(cell[i]) + offset[i] for i in range(3))
                index = vertices.get(key)
                if index is None:
                    require(len(vertices) < MAX_VERTICES, 'Atlas surface exceeds 300000 vertices; choose an explicit coarser stride.')
                    index = len(vertices);vertices[key] = index
                    voxel = (np.asarray(key, dtype=float) - .5) * stride
                    world = affine[:3,:3] @ voxel + affine[:3,3]
                    require(np.isfinite(world).all() and np.abs(world).max() <= 1e8, 'Atlas physical coordinates exceed the supported range.')
                    positions.extend(float(x) for x in world)
                face.append(index)
            for triangle in [(face[0],face[1],face[2]),(face[0],face[2],face[3])]:
                indices.extend(triangle[::-1] if reverse else triangle)
    return {'positions':positions, 'indices':indices}

def prepare(path, labels, license_note, stride=1, unit_override=None):
    import numpy as np
    import nibabel as nib
    require(path.is_file(), 'Atlas volume was not found.')
    require(path.name.lower().endswith(('.nii', '.nii.gz')), 'Provide a labelled NIfTI .nii or .nii.gz volume; PDF plates are not a volumetric atlas.')
    require(path.stat().st_size <= 2*1024**3, 'Atlas file exceeds the 2 GiB local converter limit.')
    require(isinstance(license_note,str) and license_note.strip() and len(license_note)<=4000,
            'Record the reference atlas source and your applicable licence/use permission.')
    require(labels and len(labels)<=1024 and all(type(x) is int and x>0 for x in labels) and len(set(labels))==len(labels),
            'Select distinct positive integer atlas label IDs; background 0 is not an anatomical region.')
    require(isinstance(stride,int) and 1<=stride<=16, 'Stride must be from 1 to 16.')
    original_hash=file_sha256(path)
    image=nib.load(str(path), mmap=True)
    require(len(image.shape)==3 and all(0<n<=32767 for n in image.shape), 'Atlas must be a 3D label volume, not a 4D image or probability map.')
    count=int(np.prod(image.shape));dtype=np.dtype(image.get_data_dtype())
    require(count<=MAX_VOXELS and count*dtype.itemsize<=MAX_DECODED, 'Atlas volume exceeds 128 million voxels or 512 MiB decoded data.')
    require(dtype.kind in 'iu', 'Atlas labels must use an integer datatype.')
    require(int(image.header['sform_code'])>0 or int(image.header['qform_code'])>0,
            'NIfTI needs an explicit sform or qform. A guessed coordinate frame is not accepted.')
    slope,inter=image.dataobj.slope,image.dataobj.inter
    require(slope==1 and inter==0, 'Scaled label intensities are unsupported; preserve discrete integer label IDs.')
    source_unit=image.header.get_xyzt_units()[0]
    require(unit_override is None or unit_override in UNIT_SCALE, 'Invalid explicit source coordinate unit.')
    if unit_override is not None and source_unit in UNIT_SCALE:
        require(UNIT_SCALE[source_unit]==UNIT_SCALE[unit_override], 'Explicit unit conflicts with NIfTI metadata.')
    unit=unit_override or source_unit
    require(unit in UNIT_SCALE, 'Atlas spatial unit is unknown. Supply --unit only after checking the source documentation.')
    affine=np.asarray(image.affine,dtype=float).copy()
    require(np.isfinite(affine).all() and np.allclose(affine[3],[0,0,0,1]) and abs(np.linalg.det(affine[:3,:3]))>1e-15,
            'Atlas affine is invalid or singular.')
    affine[:3,:]*=UNIT_SCALE[unit]
    sampled=np.asanyarray(image.dataobj[::stride,::stride,::stride])
    require(sampled.dtype.kind in 'iu', 'Label decoding unexpectedly changed datatype.')
    mask=np.isin(sampled,labels)
    require(mask.any(), 'Selected labels are absent at this sampling stride; no empty reference mesh was produced.')
    mesh=voxel_mesh(mask,affine,stride)
    require(file_sha256(path)==original_hash,'Atlas file changed while it was being read.')
    return {'schema':'cerebellum-atlas/1','unit':'um',
        'source':{'name':path.name,'sha256':original_hash,'license_note':license_note,
                  'format':'NIfTI integer label volume','label_ids':labels,'original_shape':list(image.shape),
                  'source_unit':source_unit,'unit_override':unit_override,'affine_um':affine.tolist(),
                  'sample_stride':stride,'sampled_voxels':int(mask.sum()),
                  'surface_definition':'Boundary faces of sampled labelled voxels; NIfTI indices are centres. No smoothing or individual anatomical reconstruction.',
                  'sampling_note':'Stride 1 retains voxel-cell boundaries. Stride >1 is an explicit nearest-neighbour reference approximation and changes small structures; not a subject volume measurement.',
                  'converter':'cerebellum-atlas/1.0.0'},'mesh':mesh,'landmarks':[]}

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',required=True,type=Path)
    parser.add_argument('--labels',required=True,type=int,nargs='+')
    parser.add_argument('--license-note',required=True)
    parser.add_argument('--stride',default=1,type=int)
    parser.add_argument('--unit',choices=list(UNIT_SCALE))
    parser.add_argument('--output',required=True,type=Path)
    args=parser.parse_args(argv)
    try:
        require(not args.output.exists(),'Output already exists; choose a new path.')
        atlas=prepare(args.input,args.labels,args.license_note,args.stride,args.unit)
        with args.output.open('x',encoding='utf-8') as target:
            json.dump(atlas,target,ensure_ascii=False,separators=(',',':'),allow_nan=False);target.write('\n')
        print(f'Reference atlas saved: {args.output}; {len(atlas["mesh"]["positions"])//3} vertices, {len(atlas["mesh"]["indices"])//3} triangles. This is not individual observed anatomy.')
        return 0
    except Exception as error:
        print('Atlas conversion stopped: '+str(error),file=sys.stderr);return 2

if __name__=='__main__':
    raise SystemExit(main())
