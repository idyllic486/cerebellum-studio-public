#!/usr/bin/env python3
"""Generate synthetic cross-language fixtures using a fitted Local Lab forest."""
import importlib.util
import json
from pathlib import Path
import sys
import numpy as np
import tifffile

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('nissl_lab',ROOT/'scripts/nissl_lab.py');lab=importlib.util.module_from_spec(spec);spec.loader.exec_module(lab)
out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
train=np.full((48,64),18,dtype=np.uint8);train[10:38,12:52]=220;train[18:30,24:40]=18
mask=(train>100).astype(np.uint8);mask[:2]=255
test=np.full((35,49),22,dtype=np.uint8);test[4:30,5:43]=215;test[12:22,15:33]=22
tifffile.imwrite(out/'train.tif',train,metadata=None);tifffile.imwrite(out/'labels.tif',mask,metadata=None);tifffile.imwrite(out/'source.tif',test,metadata=None)
manifest={'schema':'cerebellum-local-lab/1','id':'browser-mechanical-fixture','title':'Synthetic mechanics only','protocol':{'id':'synthetic-expert-mask'},'input':{'channels':'gray','dtype':'uint8','scale':[255]},'classes':['background','CB'],'model':None,'training':{'seed':17,'samples_per_class_per_section':200,'trees':8,'max_depth':5},'jobs':[{'id':'train','animal':{'id':'synthetic-train-animal','group':'other','split':'train'},'section':{'id':'section-1','order':1},'image':'train.tif','labels':'labels.tif','single_section':True}]}
lab.save_json(out/'manifest.json',manifest);lab.train(out/'manifest.json',out/'trained');model=lab.read_json(out/'trained/model.json')
labels=lab.forest_predict(model,test[:,:,None],8);labels.tofile(out/'labels.bin')
rois,counts=lab.runner_module().vectorize(labels,manifest['classes']);lab.save_json(out/'expected-geometry.json',{'rois':rois,'counts':counts})
features=[]
def feature_fixture(name,pixels,cfg):
    channels=pixels.shape[2];height,width=pixels.shape[:2]
    for endian in ('<','>') if pixels.dtype==np.uint16 else ('<',):
        suffix='-be' if endian=='>' else ''
        tifffile.imwrite(out/(name+suffix+'.tif'),pixels[:,:,0] if channels==1 else pixels,photometric='minisblack' if channels==1 else 'rgb',byteorder=endian,metadata=None)
    pixels.astype(pixels.dtype.newbyteorder('<')).tofile(out/(name+'.pixels'))
    lab.features(pixels,cfg['scale']).astype('<f4').tofile(out/(name+'.features'))
    features.append({'name':name,'width':width,'height':height,'channels':channels,'input':cfg})
feature_fixture('gray8',test[:,:,None],manifest['input'])
rng=np.random.default_rng(71)
for name,shape,dtype,scale in [('gray16',(13,19,1),'uint16',[65535]),('rgb8',(17,21,3),'uint8',[255,255,255]),('rgb16',(13,19,3),'uint16',[65535,65535,65535])]:
    pixels=rng.integers(0,256 if dtype=='uint8' else 65536,shape,dtype=dtype)
    feature_fixture(name,pixels,{'channels':'gray' if shape[2]==1 else 'RGB','dtype':dtype,'scale':scale})
# A second genuinely fitted RGB fixture model permits large-RGB decoder/cancel checks.
rgb=np.repeat(train[:,:,None],3,axis=2);tifffile.imwrite(out/'train-rgb.tif',rgb,photometric='rgb',metadata=None)
manifest['input']={'channels':'RGB','dtype':'uint8','scale':[255,255,255]};manifest['jobs'][0]['image']='train-rgb.tif';lab.save_json(out/'manifest-rgb.json',manifest);lab.train(out/'manifest-rgb.json',out/'trained-rgb')
large=np.zeros((2400,4800,3),dtype=np.uint8);large[:,:,0]=123;tifffile.imwrite(out/'large.tif',large,photometric='rgb',metadata=None)
lab.save_json(out/'fixtures.json',{'features':features,'source':{'width':49,'height':35,'sha256':lab.file_digest(out/'source.tif')},'model_sha256':lab.file_digest(out/'trained/model.json'),'large_bytes':(out/'large.tif').stat().st_size,'scope':'Synthetic mechanical fixtures; no Nissl accuracy claim.'})
print(json.dumps({'generated':str(out),'features':len(features),'large_bytes':(out/'large.tif').stat().st_size}))
