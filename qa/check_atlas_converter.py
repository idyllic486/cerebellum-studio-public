#!/usr/bin/env python3
"""Synthetic reference-volume conversion tests; no anatomical atlas supplied."""
from pathlib import Path
import importlib.util,json,subprocess,tempfile
import numpy as np
import nibabel as nib
R=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('atlas',R/'scripts/prepare_atlas.py');A=importlib.util.module_from_spec(spec);spec.loader.exec_module(A)
report={'pass':False,'scope':'Synthetic NIfTI affine, topology and reference mesh conversion only. No anatomical registration accuracy evaluated.','checks':[]}
def reject(call,phrase):
    try:call()
    except ValueError as error:assert phrase in str(error),str(error)
    else:raise AssertionError('Expected rejection: '+phrase)
def save(path,data,affine,unit='mm',form=1):
    image=nib.Nifti1Image(data,affine);image.header.set_xyzt_units(unit);image.set_sform(affine,code=form);image.set_qform(affine,code=form);nib.save(image,path)
def volume(mesh):
    p=np.asarray(mesh['positions']).reshape(-1,3);t=np.asarray(mesh['indices']).reshape(-1,3)
    # Translate to eliminate cancellation from absolute atlas origins.
    p=p-p.mean(axis=0)
    return float(np.einsum('ij,ij->i',p[t[:,0]],np.cross(p[t[:,1]],p[t[:,2]])).sum()/6)
def closed(mesh):
    edges={}
    for a,b,c in np.asarray(mesh['indices']).reshape(-1,3):
        for x,y in [(a,b),(b,c),(c,a)]:
            k=tuple(sorted((int(x),int(y))));edges[k]=edges.get(k,0)+1
    assert all(v==2 for v in edges.values())
try:
 with tempfile.TemporaryDirectory(prefix='cerebellum-atlas-') as directory:
    d=Path(directory);data=np.zeros((8,9,10),np.uint16);data[2:4,1:4,2:6]=7
    affine=np.diag([.01,.02,.03,1.]);affine[:3,3]=[1.,2.,3.]
    path=d/'synthetic.nii.gz';save(path,data,affine)
    before=A.file_sha256(path);atlas=A.prepare(path,[7],'Synthetic QA fixture only')
    closed(atlas['mesh']);assert np.isclose(volume(atlas['mesh']),24*10*20*30,rtol=1e-6)
    pos=np.array(atlas['mesh']['positions']).reshape(-1,3);assert np.allclose(pos.min(axis=0),[1015,2010,3045],atol=.001)
    assert np.allclose(pos.max(axis=0),[1035,2070,3165],atol=.001)
    assert atlas['source']['sha256']==before==A.file_sha256(path)
    report['checks'].append('Anisotropic mm affine and translated voxel-centre boundaries preserve calibrated reference geometry')
    mirror=affine.copy();mirror[0,0]*=-1;save(d/'mirror.nii',data,mirror)
    mirrored=A.prepare(d/'mirror.nii',[7],'Synthetic');closed(mirrored['mesh']);assert np.isclose(volume(mirrored['mesh']),144000,rtol=1e-6)
    report['checks'].append('Left-handed affine keeps outward face orientation and positive enclosed volume')
    hollow=np.ones((5,5,5),bool);hollow[1:4,1:4,1:4]=False
    mesh=A.voxel_mesh(hollow,np.eye(4));closed(mesh);assert np.isclose(volume(mesh),98)
    report['checks'].append('Interior cavities retained; surface volume subtracts holes')
    spaced=np.zeros((6,6,6),bool);spaced[0,0,0]=spaced[5,5,5]=True
    mesh=A.voxel_mesh(spaced,np.eye(4));closed(mesh);assert volume(mesh)==2
    report['checks'].append('Disconnected labelled components preserved')
    coarse=A.prepare(path,[7],'Synthetic',stride=2);assert coarse['source']['sample_stride']==2
    assert 'approximation' in coarse['source']['sampling_note']
    report['checks'].append('Explicit coarse sampling recorded without claiming native volume')
    reject(lambda:A.prepare(path,[999],'Synthetic'),'absent')
    reject(lambda:A.prepare(path,[0],'Synthetic'),'positive integer')
    reject(lambda:A.prepare(path,[7],''),'licence')
    reject(lambda:A.prepare(path,[7],'Synthetic',unit_override='um'),'conflicts')
    save(d/'unknown.nii',data,affine,unit='unknown')
    reject(lambda:A.prepare(d/'unknown.nii',[7],'Synthetic'),'unit is unknown')
    save(d/'unregistered.nii',data,affine,form=0)
    reject(lambda:A.prepare(d/'unregistered.nii',[7],'Synthetic'),'sform or qform')
    report['checks'].append('Unknown/conflicting units, absent labels, missing permission record and unregistered coordinate frame rejected')
    outfile=d/'atlas.json';outfile.write_text(json.dumps(atlas))
    core=R/'src/reconstruction_core.js'
    assert core.exists(),'Reconstruction core is required for actual integration validation'
    program="const fs=require('fs');const C=require(process.argv[1]);const a=JSON.parse(fs.readFileSync(process.argv[2]));C.validateAtlas(a);console.log('Reference converter and browser atlas schema interoperate');"
    result=subprocess.run(['node','-e',program,str(core),str(outfile)],capture_output=True,text=True)
    assert result.returncode==0,result.stderr
    report['checks'].append('Generated NIfTI reference passes browser ReconstructionCore atlas validation')
    assert A.main(['--input',str(path),'--labels','7','--license-note','Synthetic','--output',str(outfile)])==2
    assert json.loads(outfile.read_text())==atlas
    report['checks'].append('Existing reference output not overwritten')
 report['pass']=True
finally:
 report['versions']={'numpy':np.__version__,'nibabel':nib.__version__}
 (R/'qa/atlas-converter.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
