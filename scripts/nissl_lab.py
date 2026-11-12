#!/usr/bin/env python3
"""Local supervised Nissl workbench: explicit labels, safe models, resumable drafts.

No production weights are bundled. A model prediction never constitutes approval.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
from contextlib import contextmanager
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile

VERSION = '1.0.0'
MAX_FILE_BYTES = 128 * 1024 * 1024
MAX_PIXELS = 40_000_000
MAX_DECODED = 128 * 1024 * 1024
ROOT = Path(__file__).resolve().parent
# Preserve original cohort annotation spellings; FI/Fl and PFI/PFl are not silently merged.
LOBULE_NAMES = ('2Cb', '3Cb', '4-5Cb', '6Cb', '7Cb', '8Cb', '9Cb', '10Cb', 'Sim', 'Crus1', 'Crus2', 'PM', 'Cop', 'Fl', 'FI', 'PFl', 'PFI')

def supported_forest_classes(classes):
    if classes in [['background', 'CB'], ['background', 'ML', 'GL', 'WM']]:
        return True
    return (isinstance(classes, list) and 2 <= len(classes) <= len(LOBULE_NAMES)+1
            and all(isinstance(name, str) for name in classes)
            and classes[0] == 'background' and len(set(classes)) == len(classes)
            and all(name in ['LOBULE_'+region for region in LOBULE_NAMES] for name in classes[1:]))


def require(value, message):
    if not value:
        raise ValueError(message)


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def file_digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def read_json(path, limit=8 * 1024 * 1024):
    require(path.is_file() and path.stat().st_size <= limit, f'JSON missing or exceeds {limit} bytes: {path}')
    return json.loads(path.read_text(encoding='utf-8'))


def read_verified_json(path, expected, limit=64 * 1024 * 1024):
    require(path.is_file() and path.stat().st_size <= limit, 'Model JSON missing or oversized.')
    raw = path.read_bytes()
    require(digest(raw) == expected, 'Model changed during loading; checksum no longer matches.')
    return json.loads(raw)


def save_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + '\n', encoding='utf-8')


def atomic_json(path, value):
    with tempfile.NamedTemporaryFile('w', dir=path.parent, prefix='.queue-', suffix='.tmp', delete=False, encoding='utf-8') as stream:
        temp = Path(stream.name)
        json.dump(value, stream, indent=2, ensure_ascii=False, allow_nan=False)
        stream.write('\n')
    temp.replace(path)


def identifier(value, label):
    require(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,100}', value), f'Invalid {label}; use letters, digits, dots, underscores or hyphens.')
    return value


def finite_number(value, label, positive=False):
    require(type(value) in (float, int) and math.isfinite(value) and (not positive or value > 0), f'Invalid {label}.')
    return value


def manifest_file(path):
    manifest = read_json(path)
    require(isinstance(manifest, dict) and manifest.get('schema') == 'cerebellum-local-lab/1', 'Unsupported local lab manifest.')
    identifier(manifest.get('id'), 'manifest ID')
    require(isinstance(manifest.get('title'), str) and 0 < len(manifest['title']) <= 256, 'A study title is required.')
    cfg = manifest.get('input', {})
    require(cfg.get('channels') in ('gray', 'RGB') and cfg.get('dtype') in ('uint8', 'uint16'), 'Declare TIFF channels and dtype explicitly.')
    channels = 1 if cfg['channels'] == 'gray' else 3
    require(isinstance(cfg.get('scale'), list) and len(cfg['scale']) == channels, 'input.scale needs one divisor per channel.')
    for x in cfg['scale']:
        finite_number(x, 'normalization scale', True)
    require(manifest.get('classes') in [['background', 'CB'], ['background', 'ML', 'GL', 'WM']], 'Declare exclusive background/CB or background/ML/GL/WM classes.')
    protocol = manifest.get('protocol', {})
    require(isinstance(protocol, dict) and isinstance(protocol.get('id'), str) and bool(protocol['id'].strip()), 'A measurement/annotation protocol ID is required.')
    jobs = manifest.get('jobs')
    require(isinstance(jobs, list) and 1 <= len(jobs) <= 500, 'Manifest needs 1–500 jobs.')
    ids, section_ids, section_orders, animals = set(), set(), set(), {}
    for job in jobs:
        identifier(job.get('id'), 'job ID')
        require(job['id'] not in ids, 'Duplicate job ID.')
        ids.add(job['id'])
        animal, section = job.get('animal', {}), job.get('section', {})
        identifier(animal.get('id'), 'animal ID')
        identifier(section.get('id'), 'section ID')
        require(animal.get('group') in ('WT', 'KO', 'other'), 'Declare animal group WT, KO or other.')
        require(animal.get('split') in ('train', 'validation', 'test', 'unassigned'), 'Declare animal split.')
        if animal['id'] in animals:
            require(animals[animal['id']] == animal, 'An animal has conflicting metadata or split assignments.')
        animals[animal['id']] = animal
        pair = (animal['id'], section['id'])
        require(pair not in section_ids, 'Duplicate animal/section identity.')
        section_ids.add(pair)
        require(type(section.get('order')) is int and section['order'] >= 0, 'Section order must be a nonnegative integer.')
        require((animal['id'], section['order']) not in section_orders, 'Duplicate section order for one animal.')
        section_orders.add((animal['id'], section['order']))
        require(type(section.get('included', True)) is bool, 'Section included must be true or false.')
        require(isinstance(section.get('exclusion_reason', ''), str), 'Invalid exclusion reason.')
        require(section.get('included', True) or section.get('exclusion_reason', '').strip(), 'Excluded sections need a recorded reason.')
        require(job.get('single_section') is True, 'Confirm single_section=true for every source image; multi-section sheets are not inferred.')
        for key in ('z_um', 'thickness_um'):
            if section.get(key) is not None:
                finite_number(section[key], key, key == 'thickness_um')
        calibration = section.get('calibration', {})
        require(isinstance(calibration, dict), 'Calibration must be an object.')
        for key in ('um_per_pixel_x', 'um_per_pixel_y'):
            if calibration.get(key) is not None:
                finite_number(calibration[key], key, True)
        for key in ('image', 'labels', 'roi_zip', 'measurement_csv'):
            name = job.get(key)
            if key == 'image' or name is not None:
                require(isinstance(name, str) and 0 < len(name) <= 4096, f'Invalid {key} path.')
    return manifest


def resolve(manifest_path, value):
    p = Path(value).expanduser()
    return p.resolve() if p.is_absolute() else (manifest_path.parent / p).resolve()


def read_image(path, cfg):
    import numpy as np
    import tifffile
    require(path.suffix.lower() in ('.tif', '.tiff'), 'Use a TIFF source image.')
    require(path.is_file() and path.stat().st_size <= MAX_FILE_BYTES, 'TIFF missing or exceeds 128 MiB.')
    raw = path.read_bytes()
    with tifffile.TiffFile(io.BytesIO(raw)) as tif:
        require(len(tif.pages) == 1, 'One physical section per TIFF is required.')
        page = tif.pages[0]
        require(not page.subifds and int(page.planarconfig or 1) == 1, 'Pyramidal/sub-IFD and planar TIFF are unsupported.')
        require(not page.tags.get('Orientation') or page.tags['Orientation'].value == 1, 'TIFF orientation must be top-left; no rotation is inferred.')
        channels = 1 if cfg['channels'] == 'gray' else 3
        require(page.samplesperpixel == channels and page.dtype.name == cfg['dtype'], 'Image channels/dtype differ from the explicit model input.')
        require(int(page.photometric) == (1 if channels == 1 else 2), 'Use BlackIsZero gray or RGB; no inversion/color conversion is inferred.')
        require(0 < page.imagewidth <= 32767 and 0 < page.imagelength <= 32767 and page.imagewidth * page.imagelength <= MAX_PIXELS, 'Image exceeds 40 million pixels or 32767 pixels per axis.')
        require(page.imagewidth * page.imagelength * channels * page.dtype.itemsize <= MAX_DECODED, 'Decoded image exceeds 128 MiB.')
        require(int(page.compression) in (1, 8), 'Local Lab accepts uncompressed/Deflate TIFF; unsupported compression is not silently converted.')
        image = page.asarray()
    if channels == 1:
        image = image[:, :, None]
    require(image.ndim == 3 and image.shape[2] == channels and image.dtype in (np.uint8, np.uint16), 'Unsupported decoded image shape.')
    return image, {'name': path.name, 'sha256': digest(raw), 'width': image.shape[1], 'height': image.shape[0]}


def read_labels(path, shape, class_count):
    import numpy as np
    import tifffile
    require(path.is_file() and path.stat().st_size <= MAX_FILE_BYTES, 'Label TIFF missing or oversized.')
    raw = path.read_bytes()
    with tifffile.TiffFile(io.BytesIO(raw)) as tif:
        require(len(tif.pages) == 1 and not tif.pages[0].subifds, 'Labels require one TIFF plane.')
        page = tif.pages[0]
        require(not page.tags.get('Orientation') or page.tags['Orientation'].value == 1, 'Label TIFF orientation must match source.')
        require(page.dtype == np.dtype('uint8') and page.shape == tuple(shape), 'Label mask must be uint8 and exactly match source height/width.')
        labels = page.asarray()
    values = np.unique(labels)
    require(all(int(x) == 255 or 0 <= int(x) < class_count for x in values), 'Unknown label ID; use declared indices and 255 for unannotated pixels.')
    require((labels != 255).any(), 'Label mask contains no annotated pixels.')
    return labels, digest(raw)


def source_inventory(manifest, manifest_path):
    inventory, owners = {}, {}
    for job in manifest['jobs']:
        path = resolve(manifest_path, job['image'])
        require(path.is_file() and path.stat().st_size <= MAX_FILE_BYTES, f'Source TIFF missing or exceeds 128 MiB: {path}')
        h = file_digest(path)
        owner = job['animal']['id']
        if h in owners:
            require(owners[h] == owner, 'Identical source image appears under different animals; independent splitting is invalid.')
        owners[h] = owner
        inventory[job['id']] = {'image': h}
        for key in ('labels', 'roi_zip', 'measurement_csv'):
            if job.get(key):
                p = resolve(manifest_path, job[key])
                require(p.is_file() and p.stat().st_size <= MAX_FILE_BYTES, f'{key} missing or oversized.')
                inventory[job['id']][key] = file_digest(p)
    return inventory


def features(image, scale):
    import numpy as np
    from scipy.ndimage import gaussian_filter
    x = image.astype(np.float32) / np.asarray(scale, dtype=np.float32)[None, None, :]
    out = [x]
    for sigma in (1.0, 3.0):
        mean = gaussian_filter(x, sigma=(sigma, sigma, 0), mode='reflect', truncate=4.0)
        square = gaussian_filter(x*x, sigma=(sigma, sigma, 0), mode='reflect', truncate=4.0)
        out.extend([mean, np.sqrt(np.maximum(square-mean*mean, 0))])
    return np.concatenate(out, axis=2)


def tiles(image, cfg, tile_size=256):
    height, width = image.shape[:2]
    halo = 12
    for y in range(0, height, tile_size):
        for x in range(0, width, tile_size):
            y1, x1 = min(height, y+tile_size), min(width, x+tile_size)
            sy, sx = max(0, y-halo), max(0, x-halo)
            patch = image[sy:min(height, y1+halo), sx:min(width, x1+halo)]
            block = features(patch, cfg['scale'])[y-sy:y1-sy, x-sx:x1-sx]
            yield y, x, block


def train(manifest_path, output):
    import numpy as np
    from sklearn.ensemble import RandomForestClassifier
    import sklearn
    manifest = manifest_file(manifest_path)
    inventory = source_inventory(manifest, manifest_path)
    train_jobs = [j for j in manifest['jobs'] if j['animal']['split'] == 'train' and j['section'].get('included', True)]
    require(train_jobs and all(j.get('labels') for j in train_jobs), 'Every training section requires an explicit class-label TIFF; 255 means unknown.')
    require(not output.exists(), 'Training output exists; choose a new directory to version the model.')
    settings = manifest.get('training', {})
    seed = settings.get('seed', 17)
    count = settings.get('samples_per_class_per_section', 1000)
    trees, depth = settings.get('trees', 32), settings.get('max_depth', 12)
    require(type(seed) is int and 0 <= seed <= 2**32-1, 'Invalid deterministic seed.')
    require(type(count) is int and 10 <= count <= 5000, 'Training sample count must be 10–5000 per class per section.')
    require(type(trees) is int and 1 <= trees <= 64 and type(depth) is int and 1 <= depth <= 16, 'Use 1–64 trees and depth 1–16.')
    require(len(train_jobs) * len(manifest['classes']) * count <= 200000, 'Requested training samples exceed 200000; lower the explicit sample count.')
    rng = np.random.default_rng(seed)
    rows, targets, provenance = [], [], []
    for job in train_jobs:
        image, source = read_image(resolve(manifest_path, job['image']), manifest['input'])
        require(source['sha256'] == inventory[job['id']]['image'], 'Source changed during training.')
        labels, mask_hash = read_labels(resolve(manifest_path, job['labels']), image.shape[:2], len(manifest['classes']))
        require(mask_hash == inventory[job['id']]['labels'], 'Labels changed during training.')
        chosen = []
        for k in range(len(manifest['classes'])):
            indices = np.flatnonzero(labels.reshape(-1) == k)
            if len(indices):
                chosen.extend(rng.choice(indices, size=min(count, len(indices)), replace=False).tolist())
        chosen = np.asarray(chosen, dtype=np.int64)
        yy, xx = chosen // image.shape[1], chosen % image.shape[1]
        for y, x, block in tiles(image, manifest['input']):
            selected = (yy >= y) & (yy < y+block.shape[0]) & (xx >= x) & (xx < x+block.shape[1])
            if selected.any():
                rows.append(block[yy[selected]-y, xx[selected]-x])
                targets.append(labels[yy[selected], xx[selected]])
        provenance.append({'animal_id': job['animal']['id'], 'section_id': job['section']['id'], 'source_sha256': source['sha256'], 'label_sha256': mask_hash, 'sampled_pixels': len(chosen), 'unannotated_pixels': int((labels == 255).sum())})
    x, y = np.concatenate(rows), np.concatenate(targets)
    require(set(np.unique(y).tolist()) == set(range(len(manifest['classes']))), 'Every declared class needs explicit training labels; no class is fabricated.')
    forest = RandomForestClassifier(n_estimators=trees, max_depth=depth, min_samples_leaf=2, random_state=seed, n_jobs=1, class_weight='balanced')
    forest.fit(x, y)
    exported = []
    for estimator in forest.estimators_:
        t = estimator.tree_
        probabilities = t.value[:, 0, :]
        probabilities = probabilities / probabilities.sum(axis=1, keepdims=True)
        exported.append({'left': t.children_left.tolist(), 'right': t.children_right.tolist(), 'feature': t.feature.tolist(), 'threshold': t.threshold.tolist(), 'probabilities': probabilities.tolist()})
    model = {'schema': 'cerebellum-pixel-forest/1', 'id': manifest['id']+'-pixel-forest', 'version': VERSION, 'created_at': now(), 'input': manifest['input'], 'classes': manifest['classes'], 'features': 'raw+gaussian_mean_std_sigma1_sigma3_reflect_truncate4/1', 'trees': exported, 'training_animals': sorted({j['animal']['id'] for j in train_jobs}), 'training_sources': provenance, 'training_manifest_sha256': file_digest(manifest_path), 'settings': {'seed': seed, 'trees': trees, 'max_depth': depth, 'samples_per_class_per_section': count}, 'runtime': {'numpy': np.__version__, 'sklearn': sklearn.__version__}, 'scope': 'Experimental supervised pixel classifier. No Nissl anatomical accuracy or calibrated probability claim.'}
    validate_forest(model)
    output.mkdir(parents=True)
    save_json(output/'model.json', model)
    report = {'model_sha256': file_digest(output/'model.json'), 'training_animals': model['training_animals'], 'training_pixels': int(len(y)), 'class_samples': {name: int((y == i).sum()) for i, name in enumerate(model['classes'])}, 'validation_or_test_pixels_used': 0, 'status': 'trained_unvalidated', 'provenance': provenance}
    save_json(output/'training-report.json', report)
    return report


def validate_forest(model):
    require(isinstance(model, dict) and model.get('schema') == 'cerebellum-pixel-forest/1', 'Unsupported safe model schema; pickle files are never loaded.')
    require(model.get('features') == 'raw+gaussian_mean_std_sigma1_sigma3_reflect_truncate4/1', 'Unsupported feature definition.')
    require(supported_forest_classes(model.get('classes')), 'Unsupported model class mapping.')
    cfg = model.get('input', {})
    require(cfg.get('channels') in ('gray','RGB') and cfg.get('dtype') in ('uint8','uint16'), 'Invalid model input.')
    channels = 1 if cfg['channels'] == 'gray' else 3
    require(isinstance(cfg.get('scale'), list) and len(cfg['scale']) == channels, 'Invalid normalization.')
    for value in cfg['scale']:
        finite_number(value, 'model scale', True)
    identifier(model.get('id'), 'model ID')
    require(isinstance(model.get('version'), str) and model['version'], 'Model version is required.')
    require(isinstance(model.get('training_animals'), list) and 0 < len(model['training_animals']) <= 500 and len(set(model['training_animals'])) == len(model['training_animals']) and all(isinstance(x, str) and x for x in model['training_animals']), 'Training-animal provenance is required.')
    sources = model.get('training_sources')
    require(isinstance(sources, list) and 0 < len(sources) <= 500, 'Training source provenance is required.')
    for source in sources:
        require(isinstance(source, dict) and source.get('animal_id') in model['training_animals'], 'Unknown training-source animal.')
        for key in ('source_sha256', 'label_sha256'):
            require(isinstance(source.get(key), str) and re.fullmatch('[0-9a-f]{64}', source[key]), 'Training-source digest is required.')
    require(set(model['training_animals']) == {s['animal_id'] for s in sources}, 'Training-animal/source provenance is incomplete.')
    require(isinstance(model.get('trees'), list) and 1 <= len(model['trees']) <= 64, 'Invalid tree count.')
    total = 0
    for tree in model['trees']:
        require(isinstance(tree, dict), 'Invalid tree.')
        n = len(tree.get('left', []));total += n
        require(n > 0 and total <= 100000 and all(isinstance(tree.get(k),list) and len(tree[k]) == n for k in ['right','feature','threshold','probabilities']), 'Model exceeds 100000 nodes or arrays differ in length.')
        seen = set();stack = [(0,0)]
        while stack:
            index, depth = stack.pop()
            require(index not in seen and 0 <= index < n and depth <= 32, 'Tree contains cycles, shared children or invalid depth/index.')
            seen.add(index)
            left, right, f = tree['left'][index], tree['right'][index], tree['feature'][index]
            require(type(left) is int and type(right) is int and type(f) is int, 'Invalid tree indices.')
            finite_number(tree['threshold'][index], 'tree threshold')
            p = tree['probabilities'][index]
            require(isinstance(p,list) and len(p) == len(model['classes']) and all(type(v) in (float,int) and math.isfinite(v) and 0 <= v <= 1 for v in p) and abs(sum(p)-1) < 1e-6, 'Invalid tree class frequencies.')
            if left == -1:
                require(right == -1 and f == -2, 'Malformed leaf.')
            else:
                require(0 <= f < channels*5 and 0 <= left < n and 0 <= right < n and left != right, 'Invalid decision node.')
                stack.extend([(left,depth+1),(right,depth+1)])
        require(len(seen) == n, 'Model contains unreachable nodes.')
    return model


def forest_predict(model, image, tile_size=256):
    import numpy as np
    validate_forest(model)
    labels = np.empty(image.shape[:2], dtype=np.uint8)
    for y, x, block in tiles(image, model['input'], tile_size):
        flat = block.reshape(-1, block.shape[2]);votes = np.zeros((len(flat),len(model['classes'])),dtype=np.float64)
        for tree in model['trees']:
            stack=[(0,np.arange(len(flat)))]
            while stack:
                node,indices=stack.pop()
                if not len(indices):continue
                if tree['left'][node] == -1:
                    votes[indices] += tree['probabilities'][node]
                else:
                    mask=flat[indices,tree['feature'][node]] <= tree['threshold'][node]
                    stack.extend([(tree['left'][node],indices[mask]),(tree['right'][node],indices[~mask])])
        labels[y:y+block.shape[0],x:x+block.shape[1]]=votes.argmax(axis=1).reshape(block.shape[:2])
    return labels


def runner_module():
    path=ROOT/'nissl_predict.py'
    require(path.is_file(), 'nissl_predict.py must be present beside nissl_lab.py.')
    spec=importlib.util.spec_from_file_location('cerebellum_onnx_runner',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def model_configuration(manifest, manifest_path, required=False):
    item=manifest.get('model')
    if item is None:
        require(not required, 'Run requires a trained model; use prepare for image/manual-ROI intake without inference.')
        return None
    require(isinstance(item,dict) and item.get('kind') in ('pixel-forest-json','onnx'), 'Invalid model kind.')
    p=resolve(manifest_path,item.get('path',''))
    require(p.is_file() and p.stat().st_size <= 512*1024*1024, 'Model missing or oversized.')
    actual=file_digest(p)
    require(isinstance(item.get('sha256'),str) and actual == item['sha256'], 'Model checksum does not match manifest.')
    if item['kind'] == 'pixel-forest-json':
        m=validate_forest(read_verified_json(p,actual))
        require(m['input'] == manifest['input'] and m['classes'] == manifest['classes'], 'Model input/classes differ from manifest.')
        return {'kind':item['kind'],'path':p,'sha256':actual,'model':m}
    onnx_manifest=resolve(manifest_path,item.get('manifest',''))
    config=runner_module().validate_manifest(read_json(onnx_manifest))
    require(config['model']['weights_sha256']==actual, 'ONNX model and adapter manifest checksums differ.')
    require(config['classes']==manifest['classes'] and config['input_channels']==manifest['input']['channels'] and config['input_dtype']==manifest['input']['dtype'], 'ONNX adapter input/classes differ from lab manifest.')
    return {'kind':'onnx','path':p,'sha256':actual,'manifest':onnx_manifest,'manifest_sha256':file_digest(onnx_manifest),'config':config}


def predict_image(image, source, path, model, manifest):
    if model['kind']=='pixel-forest-json':
        labels=forest_predict(model['model'],image)
        rois,counts=runner_module().vectorize(labels,manifest['classes'])
        identity={'id':model['model']['id'],'version':model['model']['version'],'weights_sha256':model['sha256'],'training_animals':model['model']['training_animals'],'family':'experimental-pixel-forest'}
        return {'schema':'cerebellum-prediction/1','source':source,'model':identity,'rois':rois,'processing':{'adapter':'cerebellum-local-lab','version':VERSION,'pixel_counts':counts,'status':'unreviewed','features':model['model']['features'],'uncertainty':'No calibrated confidence is asserted.','measurement':'Exact predicted pixel-cell contours; human edits remain separate.'}},labels
    prediction=runner_module().predict(path,model['path'],model['manifest'])
    require(prediction['source']==source,'ONNX source differs from prepared image.')
    return prediction,None


def decode_roi(raw, filename):
    require(len(raw)>=64 and raw[:4]==b'Iout','Invalid ImageJ ROI signature.')
    u=lambda o:struct.unpack_from('>H',raw,o)[0]
    i=lambda o:struct.unpack_from('>i',raw,o)[0]
    f=lambda o:struct.unpack_from('>f',raw,o)[0]
    short=lambda o:(lambda v:v+65536 if v < -5000 else v)(struct.unpack_from('>h',raw,o)[0])
    code,version,options,shape=raw[6],u(4),u(50),i(36)
    require(u(48)==0 and not(options&1),'Special or spline ROI requires an explicit compatible decoder; it was not approximated.')
    names={0:'polygon',1:'rectangle',3:'line',4:'freeline',5:'polyline',7:'freehand',8:'traced',10:'point'}
    require(code in names,'Unsupported ROI type; original remains unchanged.')
    name=Path(filename).stem;h2=i(60)
    if h2:
        require(h2>=64 and h2+24<=len(raw),'Invalid ROI secondary header.')
        start,size=i(h2+16),i(h2+20)
        require(0<=size<=4096 and 0<=start<=len(raw) and start+size*2<=len(raw),'Invalid ROI name.')
        if size:name=raw[start:start+size*2].decode('utf-16-be')
    paths=[]
    if shape:
        require(code==1 and 0<shape<=6000000 and 64+4*shape<=len(raw),'Invalid composite ROI.')
        values=struct.unpack_from('>'+str(shape)+'f',raw,64);j=0;p=None
        while j<len(values):
            command=values[j];j+=1
            if command in (0,1):
                require(j+2<=len(values),'Truncated ROI path.')
                if command==0:
                    require(p is None,'Unclosed ROI path.');p=[]
                require(p is not None,'Path has no start.')
                p.append([values[j],values[j+1]]);j+=2
            else:
                require(command==4 and p is not None and len(p)>=3,'Curved or malformed ROI is not approximated.')
                paths.append(p);p=None
        require(p is None,'Unclosed ROI path.')
    elif code==1:
        require(u(54)==0,'Rounded rectangles are unsupported.')
        x,y,w,h=short(10),short(8),short(14)-short(10),short(12)-short(8)
        if version>=223 and options&128:x,y,w,h=f(18),f(22),f(26),f(30)
        require(w>0 and h>0,'Empty rectangle.');paths=[[[x,y],[x+w,y],[x+w,y+h],[x,y+h]]]
    elif code==3:paths=[[[f(18),f(22)],[f(26),f(30)]]]
    else:
        n=u(16) or i(18);subpixel=version>=222 and options&128
        require(0<n<=2000000 and 64+n*(12 if subpixel else 4)<=len(raw),'Invalid coordinate count.')
        if subpixel:paths=[[[f(64+4*n+4*j),f(64+8*n+4*j)] for j in range(n)]]
        else:
            require(all(short(64+2*j)>=0 and short(64+2*n+2*j)>=0 for j in range(n)), 'Negative relative ROI coordinate requires ImageJ-specific correction; not approximated.')
            paths=[[[short(10)+short(64+2*j),short(8)+short(64+2*n+2*j)] for j in range(n)]]
    kind='point' if code==10 else 'polyline' if code in (3,4,5) else 'area'
    require(paths and all(len(p)>=(3 if kind=='area' else 2 if kind=='polyline' else 1) for p in paths),'Empty ROI.')
    require(all(math.isfinite(v) and abs(v)<=1e7 for p in paths for q in p for v in q),'Nonfinite/out-of-range ROI coordinates.')
    return {'name':name,'kind':kind,'closed':kind=='area','type':'composite' if shape else names[code],'paths':paths,'source_name':filename,'metadata':{'version':version,'options':options,'stroke_width_px':u(34),'coordinate_system':'original image pixels','original_member_sha256':digest(raw)}}


def read_roi_zip(path, extraction=None):
    require(path.is_file() and path.stat().st_size<=16*1024*1024,'ROI ZIP missing or larger than 16 MiB.')
    raw=path.read_bytes();rois=[];total=0;names=set()
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        require(len(archive.infolist())<=2000,'ROI ZIP exceeds 2000 entries.')
        for member in archive.infolist():
            require(not member.flag_bits&1,'Encrypted ZIP unsupported.')
            if member.is_dir():continue
            require(Path(member.filename).name==member.filename and member.filename.lower().endswith('.roi'),'ZIP must contain top-level .roi files only; no path traversal or hidden extras.')
            require(member.filename not in names,'Duplicate ROI member.');names.add(member.filename)
            total+=member.file_size
            require(member.file_size<=16*1024*1024 and total<=64*1024*1024,'Expanded ROI data exceed limits.')
            b=archive.read(member);roi=decode_roi(b,member.filename);roi['source_file']=path.name;rois.append(roi)
            if extraction is not None:(extraction/member.filename).write_bytes(b)
    require(rois and len({r['name'] for r in rois})==len(rois),'No ROIs or duplicate ROI names.')
    require(sum(len(p) for r in rois for p in r['paths'])<=2000000,'ROI ZIP exceeds two million coordinates.')
    return rois,digest(raw)


def imagej_measure(job, source, roi_path, target, jar):
    require(jar.is_file() and jar.suffix=='.jar','Provide the ImageJ jar explicitly.')
    cal=job['section'].get('calibration',{})
    require(cal.get('um_per_pixel_x') and cal.get('um_per_pixel_y'),'ImageJ physical measurements require both explicit pixel scales.')
    helper=ROOT/'imagej_measurements.java'
    require(helper.is_file(),'ImageJ source helper missing.')
    with tempfile.TemporaryDirectory(prefix='cerebellum-imagej-') as directory:
        directory=Path(directory);read_roi_zip(roi_path,directory)
        result=subprocess.run(['java','-Djava.awt.headless=true','--class-path',str(jar),str(helper),str(directory),str(source['width']),str(source['height']),str(cal['um_per_pixel_x']),str(cal['um_per_pixel_y'])],capture_output=True,text=True,timeout=120)
        require(result.returncode==0,'ImageJ measurement failed: '+result.stderr[-2000:])
        (target/'imagej-measurements.csv').write_text(result.stdout)
    save_json(target/'imagej-provenance.json',{'engine':'ImageJ','jar_sha256':file_digest(jar),'helper_sha256':file_digest(helper),'coordinate_image':'Blank geometry grid; original image intensity was not measured.','calibration':cal,'source_sha256':source['sha256'],'roi_zip_sha256':file_digest(roi_path),'line_area':None,'definition':'ImageJ area for area ROIs; getLength for perimeter/open lines. Source CSV never overwritten.'})


def preview(image, output):
    import numpy as np
    from PIL import Image
    stride=max(1,math.ceil(max(image.shape[:2])/1536))
    small=image[::stride,::stride]
    pixels=(small//256).astype(np.uint8) if image.dtype==np.uint16 else small
    if pixels.shape[2]==1:pixels=pixels[:,:,0]
    Image.fromarray(pixels).save(output)
    return {'name':output.name,'width':int(small.shape[1]),'height':int(small.shape[0]),'sampling_stride':stride,'coordinate_mapping':'Preview only; ROI coordinates remain in full-resolution source pixels.','tone_mapping':'uint16 divided by 256 for display only; no source pixel alteration.' if image.dtype==np.uint16 else 'Original uint8 values; nearest subsampling for display only.'}


def output_records(directory, root):
    return [{'path':str(p.relative_to(root)),'bytes':p.stat().st_size,'sha256':file_digest(p)} for p in sorted(directory.rglob('*')) if p.is_file()]


def verified_outputs(job, root):
    require(job.get('outputs'),'Saved job lacks output evidence.')
    for item in job['outputs']:
        p=(root/item['path']).resolve()
        require(root.resolve() in p.parents,'Saved job output escapes queue directory.')
        require(p.is_file() and p.stat().st_size==item['bytes'] and file_digest(p)==item['sha256'],'Saved output changed; do not resume into altered evidence. Choose a new output directory.')


def assemble_study(manifest, queue, output):
    animals={}
    for item in queue['jobs']:
        if item['state']!='needs_review':continue
        verified_outputs(item,output)
        entry=next(x for x in item['outputs'] if x['path'].endswith('/study-section.json'))
        record=read_json(output/entry['path'],64*1024*1024)
        a=record['animal'];animal=animals.setdefault(a['id'],{**a,'coverage':{'kind':'observed_span','start_um':None,'end_um':None,'confirmed':False},'sections':[]})
        animal['sections'].append(record['section'])
    study={'schema':'cerebellum-study/1','id':manifest['id'],'title':manifest['title'],'created_at':queue['created_at'],'protocol':{'id':manifest['protocol']['id'],'version':str(manifest['protocol'].get('version','1')),'measurement_profile':'pixel-mask/1','boundary_definition':manifest['protocol'].get('boundary_definition',''),'maximum_gap_um':manifest['protocol'].get('maximum_gap_um')},'animals':list(animals.values()),'history':[]}
    atomic_json(output/'draft-study.json',study)


@contextmanager
def queue_lock(output):
    # OS-released advisory lock also permits recovery after a stopped process.
    import fcntl
    output.parent.mkdir(parents=True, exist_ok=True)
    with (output.parent / ('.' + output.name + '.nissl-lab.lock')).open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError('Another process owns this queue; wait for it to finish.') from error
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def run_queue(manifest_path, output, operation='run', imagej_jar=None):
    with queue_lock(output):
        return _run_queue(manifest_path, output, operation, imagej_jar)


def _run_queue(manifest_path, output, operation='run', imagej_jar=None):
    import numpy as np
    import tifffile
    manifest=manifest_file(manifest_path);manifest_sha=file_digest(manifest_path)
    inventory=source_inventory(manifest,manifest_path)
    model=model_configuration(manifest,manifest_path,required=operation=='run') if operation=='run' else None
    if output.exists():
        require((output/'queue.json').is_file(),'Output directory exists without a Local Lab queue; choose a new directory.')
        queue=read_json(output/'queue.json')
        require(queue.get('schema')=='cerebellum-job-queue/1' and queue.get('manifest_sha256')==manifest_sha and queue.get('operation')==operation,'Manifest or operation changed. Use a new output directory; existing evidence is preserved.')
    else:
        output.mkdir(parents=True)
        queue={'schema':'cerebellum-job-queue/1','manifest_id':manifest['id'],'manifest_sha256':manifest_sha,'created_at':now(),'updated_at':now(),'operation':operation,'adapter_version':VERSION,'review_policy':'Human approval required; no automatic approval','jobs':[{'id':j['id'],'animal_id':j['animal']['id'],'section_id':j['section']['id'],'state':'queued','fingerprint':None,'attempts':0,'error':None,'outputs':[],'source':None} for j in manifest['jobs']]}
    require(isinstance(queue.get('jobs'), list) and len(queue['jobs']) == len(manifest['jobs']), 'Saved queue job count differs from manifest.')
    require(all(j.get('state') in ('queued', 'running', 'needs_review', 'failed') and type(j.get('attempts')) is int and j['attempts'] >= 0 for j in queue['jobs']), 'Malformed saved queue state.')
    atomic_json(output/'queue.json',queue)
    for job,item in zip(manifest['jobs'],queue['jobs']):
        require(item['id']==job['id'],'Queue identity differs from manifest.')
        fp=digest(canonical({'manifest_sha256':manifest_sha,'inputs':inventory[job['id']],'model_sha256':model['sha256'] if model else None,'onnx_manifest_sha256':model.get('manifest_sha256') if model else None,'imagej_jar_sha256':file_digest(imagej_jar) if imagej_jar else None,'adapter_version':VERSION,'adapter_sha256':file_digest(Path(__file__)), 'onnx_adapter_sha256':file_digest(ROOT/'nissl_predict.py') if operation=='run' else None, 'imagej_helper_sha256':file_digest(ROOT/'imagej_measurements.java') if imagej_jar else None,'operation':operation}))
        require(item.get('fingerprint') in (None,fp),'Inputs/model changed since prior queue run; choose a new output directory.')
        if item['state']=='needs_review':
            verified_outputs(item,output)
            continue
        item.update(state='running',fingerprint=fp,attempts=item['attempts']+1,error=None,outputs=[])
        queue['updated_at']=now();atomic_json(output/'queue.json',queue)
        temp=Path(tempfile.mkdtemp(prefix='.job-',dir=output))
        try:
            path=resolve(manifest_path,job['image']);image,source=read_image(path,manifest['input'])
            require(source['sha256']==inventory[job['id']]['image'],'Source changed during processing.')
            item['source']=source
            source_info={'source':source,'input_path':str(path),'original_read_only':True,'input_hashes':inventory[job['id']],'preview':preview(image,temp/'preview.png')}
            save_json(temp/'source-provenance.json',source_info)
            rois=[];identity=None;origin='manual';selection={}
            if operation=='run':
                prediction,labels=predict_image(image,source,path,model,manifest)
                save_json(temp/'prediction.json',prediction)
                identity=prediction['model'];origin='model'
                rois=[{'name':r['label']+'_'+r['id'],'kind':'area','closed':True,'paths':r['paths'],'label':r['label'],'source_name':r['id']} for r in prediction['rois']]
                selection={label:[r['name'] for r in rois if r['label']==label] for label in manifest['classes'][1:] if any(r['label']==label for r in rois)}
                if labels is not None:tifffile.imwrite(temp/'predicted-labels.tif',labels,photometric='minisblack',metadata=None)
            elif job.get('roi_zip'):
                roi_path=resolve(manifest_path,job['roi_zip']);rois,roi_hash=read_roi_zip(roi_path)
                require(roi_hash==inventory[job['id']]['roi_zip'],'ROI archive changed during processing.')
                require(all(0 <= q[0] <= source['width'] and 0 <= q[1] <= source['height'] for roi in rois for ring in roi['paths'] for q in ring), 'ROI coordinate falls outside source image grid.')
                if imagej_jar:imagej_measure(job,source,roi_path,temp,imagej_jar)
            section={**job['section'],'z_um':job['section'].get('z_um'),'thickness_um':job['section'].get('thickness_um'),'included':job['section'].get('included',True),'exclusion_reason':job['section'].get('exclusion_reason',''),'source':source,'calibration':{'um_per_pixel_x':job['section'].get('calibration',{}).get('um_per_pixel_x'),'um_per_pixel_y':job['section'].get('calibration',{}).get('um_per_pixel_y')},'rois':rois,'model':identity,'origin':origin,'review':None,'layer_selection':selection}
            section['provenance']={'source_files':[{'role':key, 'name':resolve(manifest_path,job[key]).name, 'sha256':value} for key,value in inventory[job['id']].items()], 'original_files_retained_at_local_source_paths':True, 'operation':operation, 'adapter_version':VERSION, 'job_fingerprint':fp}
            save_json(temp/'study-section.json',{'animal':job['animal'],'section':section})
            save_json(temp/'job-provenance.json',{'job_id':job['id'],'fingerprint':fp,'input_hashes':inventory[job['id']],'operation':operation,'status':'needs_review','approval':None,'label_masks_used_for_inference':False,'measurement_definition':'Study uses explicit pixel-mask profile; optional ImageJ output is a separate profile, never silently substituted.'})
            final=output/'jobs'/job['id']/fp[:16];final.parent.mkdir(parents=True,exist_ok=True)
            require(not final.exists(),'Immutable result directory already exists but was not a verified completed job; choose a new output directory.')
            temp.rename(final)
            item.update(state='needs_review',outputs=output_records(final,output),error=None)
        except Exception as error:
            item.update(state='failed',error=str(error),outputs=[])
            if temp.exists():shutil.rmtree(temp)
        queue['updated_at']=now();atomic_json(output/'queue.json',queue)
    assemble_study(manifest,queue,output)
    return queue


def evaluate(manifest_path, model_path, output, split='test'):
    import numpy as np
    manifest=manifest_file(manifest_path);source_inventory(manifest,manifest_path)
    model_sha=file_digest(model_path)
    model=validate_forest(read_verified_json(model_path,model_sha))
    require(model['input']==manifest['input'] and model['classes']==manifest['classes'],'Evaluation input/classes differ from model.')
    require(split in ('validation','test'),'Evaluation split must be validation or test.')
    jobs=[j for j in manifest['jobs'] if j['animal']['split']==split and j['section'].get('included',True)]
    require(jobs and all(j.get('labels') for j in jobs),'Selected evaluation split needs explicit reference masks.')
    require(not output.exists(),'Evaluation output already exists; choose a new file.')
    training_hashes={r['source_sha256'] for r in model.get('training_sources',[])}
    results=[]
    for job in jobs:
        require(job['animal']['id'] not in model['training_animals'],'Animal leakage: evaluation animal was used for training.')
        image,source=read_image(resolve(manifest_path,job['image']),manifest['input'])
        require(source['sha256'] not in training_hashes,'Image leakage: evaluation source was used for training.')
        reference,reference_hash=read_labels(resolve(manifest_path,job['labels']),image.shape[:2],len(model['classes']))
        prediction=forest_predict(model,image);valid=reference!=255;metrics=[]
        for k,label in enumerate(model['classes'][1:],1):
            p=(prediction==k)&valid;t=(reference==k)&valid
            intersection=int((p&t).sum());pc=int(p.sum());tc=int(t.sum());union=pc+tc-intersection
            metrics.append({'label':label,'reference_pixels':tc,'prediction_pixels':pc,'dice':2*intersection/(pc+tc) if pc+tc else None,'iou':intersection/union if union else None,'relative_area_error':(pc-tc)/tc if tc else None,'both_absent':pc+tc==0})
        results.append({'animal_id':job['animal']['id'],'section_id':job['section']['id'],'source':source,'reference_sha256':reference_hash,'evaluated_pixels':int(valid.sum()),'ignored_pixels':int((~valid).sum()),'metrics':metrics})
    animals={}
    for row in results:
        animals.setdefault(row['animal_id'],[]).append(row)
    means=[]
    for animal,rows in animals.items():
        metrics=[]
        for label in model['classes'][1:]:
            values=[m['dice'] for row in rows for m in row['metrics'] if m['label']==label and m['dice'] is not None]
            metrics.append({'label':label,'mean_section_dice':sum(values)/len(values) if values else None,'scored_sections':len(values)})
        means.append({'animal_id':animal,'section_count':len(rows),'metrics':metrics})
    report={'schema':'cerebellum-local-evaluation/1','created_at':now(),'split':split,'model_sha256':model_sha,'training_animals':model['training_animals'],'test_animal_count':len(animals),'section_count':len(results),'independence_checks_passed':True,'reference_status':'Operator-supplied annotation; not assumed error-free anatomical truth.','resolution':'Native source pixels; 255-labelled reference pixels excluded explicitly.','sections':results,'animals':means,'overall':{label:{'mean_animal_dice':float(np.mean([m['mean_section_dice'] for a in means for m in a['metrics'] if m['label']==label and m['mean_section_dice'] is not None])) if any(m['label']==label and m['mean_section_dice'] is not None for a in means for m in a['metrics']) else None} for label in model['classes'][1:]},'limitations':['Animal-level split checks are software guards, not evidence of external-laboratory generalization.','No confidence calibration, significance test or review-time saving is inferred.','Performance on synthetic fixtures is not Nissl performance.']}
    save_json(output,report);return report


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest='command',required=True)
    for name in ('prepare','run','train'):
        p=commands.add_parser(name);p.add_argument('--manifest',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
        if name=='prepare':p.add_argument('--imagej-jar',type=Path)
    p=commands.add_parser('evaluate');p.add_argument('--manifest',type=Path,required=True);p.add_argument('--model',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--split',choices=['validation','test'],default='test')
    args=parser.parse_args(argv)
    try:
        if args.command=='train':result=train(args.manifest.resolve(),args.output.resolve());print(json.dumps(result,indent=2));return 0
        if args.command=='evaluate':result=evaluate(args.manifest.resolve(),args.model.resolve(),args.output.resolve(),args.split);print(json.dumps({'animals':result['test_animal_count'],'sections':result['section_count'],'overall':result['overall']},indent=2));return 0
        result=run_queue(args.manifest.resolve(),args.output.resolve(),args.command,args.imagej_jar.resolve() if getattr(args,'imagej_jar',None) else None)
        counts={state:sum(j['state']==state for j in result['jobs']) for state in ['queued','running','needs_review','failed']};print(json.dumps(counts,indent=2));return 2 if counts['failed'] else 0
    except Exception as error:
        if isinstance(error,ImportError):print('Install optional dependencies: python -m pip install -r scripts/requirements-lab.txt',file=sys.stderr)
        print('Local Lab stopped: '+str(error),file=sys.stderr);return 2


if __name__=='__main__':
    raise SystemExit(main())
