#!/usr/bin/env python3
"""Mechanical synthetic checks; none constitute validation on Nissl tissue."""
import copy
import csv
import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile

import numpy as np
import tifffile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('nissl_lab', ROOT/'scripts/nissl_lab.py')
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)
checks = []


def check(name, assertion=True):
    assert assertion, name
    checks.append(name)


def rejects(name, function, phrase=None):
    try:
        function()
    except (ValueError, FileNotFoundError) as error:
        if phrase:
            assert phrase.lower() in str(error).lower(), (name, str(error))
        checks.append(name)
        return
    raise AssertionError(name+' did not reject')


def write(path, value):
    lab.save_json(path, value)
    return path


def job(identifier, animal, split, image, labels=None):
    return {'id':identifier, 'animal':{'id':animal,'group':'other','split':split,'batch':'synthetic'}, 'section':{'id':'section-1','order':1,'z_um':None,'thickness_um':None,'calibration':{'um_per_pixel_x':None,'um_per_pixel_y':None}}, 'image':image, 'labels':labels, 'roi_zip':None, 'single_section':True}


def rectangle_roi(x=3, y=4, width=10, height=6):
    raw=bytearray(64)
    raw[:4]=b'Iout';struct.pack_into('>H',raw,4,227);raw[6]=1
    for offset,value in [(8,y),(10,x),(12,y+height),(14,x+width)]:struct.pack_into('>H',raw,offset,value)
    return bytes(raw)


def line_roi():
    raw=bytearray(64);raw[:4]=b'Iout';struct.pack_into('>H',raw,4,227);raw[6]=3
    for offset,value in [(18,1),(22,1),(26,4),(30,5)]:struct.pack_into('>f',raw,offset,value)
    struct.pack_into('>H',raw,34,2)
    return bytes(raw)


with tempfile.TemporaryDirectory(prefix='cerebellum-lab-qa-') as directory:
    temp=Path(directory)
    # Both classes explicitly annotated; 255 is unknown, not background.
    train_image=np.full((48,64),18,dtype=np.uint8);train_image[12:36,16:48]=220
    train_labels=(train_image>100).astype(np.uint8);train_labels[:3]=255
    test_image=np.full((56,72),22,dtype=np.uint8);test_image[15:41,20:52]=215
    test_labels=(test_image>100).astype(np.uint8);test_labels[:2]=255
    for name,array in [('train.tif',train_image),('train-labels.tif',train_labels),('test.tif',test_image),('test-labels.tif',test_labels)]:
        tifffile.imwrite(temp/name,array,photometric='minisblack',metadata=None)
    manifest={'schema':'cerebellum-local-lab/1','id':'mechanical-fixture','title':'Synthetic mechanics only','protocol':{'id':'synthetic-fixture','boundary_definition':'Explicit pixel labels; not an anatomical validation'},'input':{'channels':'gray','dtype':'uint8','scale':[255]},'classes':['background','CB'],'model':None,'training':{'seed':17,'samples_per_class_per_section':100,'trees':8,'max_depth':5},'jobs':[job('train-1','train-animal','train','train.tif','train-labels.tif'),job('test-1','test-animal','test','test.tif','test-labels.tif')]}
    manifest_path=write(temp/'manifest.json',manifest)
    source_hashes={name:lab.file_digest(temp/name) for name in ['train.tif','train-labels.tif','test.tif','test-labels.tif']}
    trained=lab.train(manifest_path,temp/'trained')
    model=lab.read_json(temp/'trained/model.json')
    check('Real supervised training uses explicit labels and train animals only',trained['training_animals']==['train-animal'] and trained['validation_or_test_pixels_used']==0 and trained['training_pixels']==200)
    check('Unknown label pixels explicitly retained as ignored',trained['provenance'][0]['unannotated_pixels']==192)
    image,source=lab.read_image(temp/'test.tif',manifest['input'])
    full=lab.features(image,manifest['input']['scale'])
    tiled=np.zeros_like(full)
    for y,x,block in lab.tiles(image,manifest['input'],11):tiled[y:y+block.shape[0],x:x+block.shape[1]]=block
    check('Texture halo reproduces full-resolution features across tile boundaries',np.allclose(full,tiled,atol=1e-7))
    result=lab.forest_predict(model,image,11)
    check('Safe JSON prediction independent of tile size',np.array_equal(result,lab.forest_predict(model,image,256)))
    check('Synthetic held-out rectangle predicted exactly',np.array_equal(result[test_labels!=255],test_labels[test_labels!=255]))
    report=lab.evaluate(manifest_path,temp/'trained/model.json',temp/'evaluation.json')
    check('Evaluation uses a held-out animal and native pixels',report['test_animal_count']==1 and report['sections'][0]['ignored_pixels']==144 and report['overall']['CB']['mean_animal_dice']==1)
    # Test labels can change without affecting model trees: no training leakage.
    tifffile.imwrite(temp/'test-labels.tif',np.zeros_like(test_labels),photometric='minisblack',metadata=None)
    lab.train(manifest_path,temp/'trained-again')
    check('Held-out labels do not affect fitted model trees',model['trees']==lab.read_json(temp/'trained-again/model.json')['trees'])
    tifffile.imwrite(temp/'test-labels.tif',test_labels,photometric='minisblack',metadata=None)
    malformed=copy.deepcopy(model);malformed['trees'][0]['left'][0]=0
    rejects('Cyclic model rejected without executing serialized code',lambda:lab.validate_forest(malformed),'cycles')
    missing=copy.deepcopy(model);missing['training_sources']=[]
    rejects('Missing training provenance blocks purported independent evaluation',lambda:lab.validate_forest(missing),'provenance')
    collision=copy.deepcopy(manifest);collision['jobs'][1]['animal']['id']='train-animal'
    rejects('One animal cannot straddle train and test',lambda:lab.manifest_file(write(temp/'collision.json',collision)),'conflicting')
    duplicate=copy.deepcopy(manifest);duplicate['jobs'][1]['image']='train.tif'
    rejects('Identical TIFF under different animal IDs rejected',lambda:lab.source_inventory(duplicate,manifest_path),'identical')
    reused=copy.deepcopy(manifest);reused['jobs']=[copy.deepcopy(reused['jobs'][0])];reused['jobs'][0]['animal']['split']='test'
    rejects('Known training animal rejected at evaluation',lambda:lab.evaluate(write(temp/'reused.json',reused),temp/'trained/model.json',temp/'invalid-evaluation.json'),'animal leakage')
    no_class=copy.deepcopy(manifest);tifffile.imwrite(temp/'no-class.tif',np.zeros_like(train_labels),metadata=None);no_class['jobs'][0]['labels']='no-class.tif'
    rejects('Missing training class not fabricated',lambda:lab.train(write(temp/'no-class.json',no_class),temp/'no-class-model'),'every declared class')
    manifest['model']={'kind':'pixel-forest-json','path':'trained/model.json','sha256':trained['model_sha256']}
    write(manifest_path,manifest)
    queue=lab.run_queue(manifest_path,temp/'queue')
    check('Batch prediction enters review queue with no automatic approvals',all(j['state']=='needs_review' and j['attempts']==1 and j['outputs'] for j in queue['jobs']))
    study=lab.read_json(temp/'queue/draft-study.json')
    check('Missing physical metadata stays null',all(s['z_um'] is None and s['calibration']['um_per_pixel_x'] is None and s['review'] is None for a in study['animals'] for s in a['sections']))
    check('Model origin, source identity and training animals exported',all(s['origin']=='model' and s['source']['sha256'] and s['model']['training_animals']==['train-animal'] for a in study['animals'] for s in a['sections']))
    # Real browser data contract, not a copy of the Python implementation.
    core=ROOT/'src/study_core.js'
    if core.exists() and shutil.which('node'):
        node=subprocess.run(['node','-e',"const fs=require('fs');global.ResearchCore=require(process.argv[1]);const S=require(process.argv[2]);const x=S.create(JSON.parse(fs.readFileSync(process.argv[3])));const v=S.validate(x);if(v.errors?.length)throw Error(JSON.stringify(v));console.log(x.animals.length);",str(ROOT/'src/research_core.js'),str(core),str(temp/'queue/draft-study.json')],capture_output=True,text=True)
        check('Draft study imports into site StudyCore',node.returncode==0)
    resumed=lab.run_queue(manifest_path,temp/'queue')
    check('Resume verifies checksums and does not recompute completed jobs',all(j['attempts']==1 for j in resumed['jobs']) and resumed['jobs']==queue['jobs'])
    changed=copy.deepcopy(manifest);changed['model']['sha256']='0'*64
    rejects('Wrong model checksum blocks inference',lambda:lab.run_queue(write(temp/'bad-model.json',changed),temp/'bad-model-queue'),'checksum')
    output=temp/'queue'/queue['jobs'][0]['outputs'][0]['path'];output.write_bytes(output.read_bytes()+b'\n')
    rejects('Altered result refuses resume',lambda:lab.run_queue(manifest_path,temp/'queue'),'saved output changed')
    bad=copy.deepcopy(manifest);bad['model']=None;bad['jobs'][1]['image']='malformed.tif';(temp/'malformed.tif').write_bytes(b'not TIFF')
    failures=lab.run_queue(write(temp/'failure.json',bad),temp/'failure-queue','prepare')
    check('Malformed section fails visibly while other jobs complete',[j['state'] for j in failures['jobs']]==['needs_review','failed'] and bool(failures['jobs'][1]['error']))
    # >32 MiB, uncompressed native RGB source: original pixels are never rewritten.
    large=np.zeros((2400,4800,3),dtype=np.uint8);large[:,:,0]=123
    tifffile.imwrite(temp/'large.tif',large,photometric='rgb',metadata=None)
    large_hash=lab.file_digest(temp/'large.tif');large_source_bytes=(temp/'large.tif').stat().st_size
    large_manifest=copy.deepcopy(manifest);large_manifest['model']=None;large_manifest['input']={'channels':'RGB','dtype':'uint8','scale':[255,255,255]};large_manifest['jobs']=[job('large','large-animal','unassigned','large.tif')]
    large_queue=lab.run_queue(write(temp/'large.json',large_manifest),temp/'large-queue','prepare')
    check('TIFF larger than 32 MiB prepares at original 4800×2400 dimensions',(temp/'large.tif').stat().st_size>32*1024**2 and large_queue['jobs'][0]['state']=='needs_review' and large_queue['jobs'][0]['source']['width']==4800)
    check('Large TIFF original bytes remain unchanged',lab.file_digest(temp/'large.tif')==large_hash)
    del large
    # ImageJ geometry is intentionally separate from pixel-mask measurements.
    with zipfile.ZipFile(temp/'rois.zip','w') as z:
        z.writestr('CB_TOTAL.roi',rectangle_roi());z.writestr('fissure.roi',line_roi())
    rois,roi_hash=lab.read_roi_zip(temp/'rois.zip')
    check('Manual closed area and open line retain distinct geometry',[r['kind'] for r in rois]==['area','polyline'] and rois[0]['paths'][0][0]==[3,4])
    with zipfile.ZipFile(temp/'traversal.zip','w') as z:z.writestr('../escape.roi',rectangle_roi())
    rejects('ROI archive path traversal rejected',lambda:lab.read_roi_zip(temp/'traversal.zip'),'top-level')
    manual=copy.deepcopy(manifest);manual['model']=None;manual['jobs']=[copy.deepcopy(manual['jobs'][0])];manual['jobs'][0]['roi_zip']='rois.zip';manual['jobs'][0]['section']['calibration']={'um_per_pixel_x':2,'um_per_pixel_y':3};manual['jobs'][0]['section'].update(included=False,exclusion_reason='Synthetic exclusion preserved')
    (temp/'source-measurements.csv').write_text('name,area\nCB_TOTAL,123\n');manual['jobs'][0]['measurement_csv']='source-measurements.csv';csv_hash=lab.file_digest(temp/'source-measurements.csv')
    jar=Path(os.environ.get('IMAGEJ_JAR','/workspace/cra-environment/lib/ij-1.54p.jar'))
    imagej_available=jar.is_file() and bool(shutil.which('java'))
    manual_queue=lab.run_queue(write(temp/'manual.json',manual),temp/'manual-queue','prepare',jar if imagej_available else None)
    check('Manual ROI preparation succeeds',manual_queue['jobs'][0]['state']=='needs_review')
    manual_study=lab.read_json(temp/'manual-queue/draft-study.json')
    check('CSV identity follows imported study provenance',any(x['role']=='measurement_csv' and x['sha256']==csv_hash for x in manual_study['animals'][0]['sections'][0]['provenance']['source_files']))
    check('Existing exclusions and source CSV preserved',manual_study['animals'][0]['sections'][0]['included'] is False and manual_study['animals'][0]['sections'][0]['exclusion_reason']=='Synthetic exclusion preserved' and lab.file_digest(temp/'source-measurements.csv')==csv_hash)
    if imagej_available:
        csv_output=next(temp/'manual-queue'/x['path'] for x in manual_queue['jobs'][0]['outputs'] if x['path'].endswith('imagej-measurements.csv'))
        rows=list(csv.DictReader(csv_output.open()));area=next(x for x in rows if x['ROI_Name']=='CB_TOTAL');line=next(x for x in rows if x['ROI_Name']=='fissure')
        check('Actual ImageJ engine measures calibrated rectangle area',abs(float(area['area_um2'])-360)<1e-9)
        check('ImageJ open line has no fabricated area',line['area_um2']=='' and abs(float(line['perimeter_or_line_length_um'])-np.hypot(6,12))<1e-9)
    check('All original training/evaluation files retain exact SHA-256',all(lab.file_digest(temp/name)==h for name,h in source_hashes.items()))
report={'passed':True,'scope':'Synthetic mechanical fixtures only; no Nissl anatomical accuracy claim.','checks':checks,'count':len(checks),'imagej_engine_checked':imagej_available,'imagej_jar_sha256':lab.file_digest(jar) if imagej_available else None,'imagej_note':None if imagej_available else 'Not available; set IMAGEJ_JAR to verify the exact ImageJ measurement path.','large_source_bytes':large_source_bytes,'runtime':{'python':sys.version.split()[0],'numpy':np.__version__,'tifffile':tifffile.__version__}}
lab.save_json(ROOT/'qa/nissl-lab.json',report)
print(json.dumps(report,indent=2))
