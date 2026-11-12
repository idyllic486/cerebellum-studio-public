#!/usr/bin/env python3
"""Synthetic ONNX/mechanics tests; not Nissl anatomical validation.

Run with the optional runner environment from scripts/requirements-nissl.txt.
"""
from pathlib import Path
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import platform
import onnxruntime
import scipy

import numpy as np
import onnx
from onnx import helper, TensorProto, numpy_helper
import tifffile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('nissl_predict', ROOT / 'scripts/nissl_predict.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
REPORT = {'pass': False, 'scope': 'Synthetic pipeline mechanics only; no Nissl segmentation accuracy evaluated.', 'checks': [], 'versions': {'python': platform.python_version(), 'numpy': np.__version__, 'scipy': scipy.__version__, 'tifffile': tifffile.__version__, 'onnx': onnx.__version__, 'onnxruntime': onnxruntime.__version__}}


def rejects(call, text):
    try:
        call()
    except ValueError as error:
        assert text in str(error), str(error)
    else:
        raise AssertionError('Expected rejection: ' + text)


def model_file(path, channels=1):
    # This is solely a pixel arithmetic test, not a trained tissue classifier.
    nodes = [helper.make_node('Gather', ['input', 'red_index'], ['red'], axis=1)] if channels == 3 else []
    initializers = [numpy_helper.from_array(np.array(.5, dtype=np.float32), 'half')]
    if channels == 3:
        initializers.append(numpy_helper.from_array(np.array([0], dtype=np.int64), 'red_index'))
    graph = helper.make_graph(nodes + [
        helper.make_node('Sub', ['red' if channels == 3 else 'input', 'half'], ['positive']),
        helper.make_node('Neg', ['positive'], ['negative']),
        helper.make_node('Concat', ['negative', 'positive'], ['logits'], axis=1),
    ], 'SYNTHETIC_TEST_ONLY_NOT_A_NISSL_MODEL',
        [helper.make_tensor_value_info('input', TensorProto.FLOAT, [1, channels, 8, 8])],
        [helper.make_tensor_value_info('logits', TensorProto.FLOAT, [1, 2, 8, 8])],
        initializers)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 13)], ir_version=10)
    onnx.checker.check_model(model)
    onnx.save(model, path)


def main():
    checks = REPORT['checks']
    with tempfile.TemporaryDirectory(prefix='cerebellum-synthetic-onnx-') as directory:
        directory = Path(directory)
        model = directory / 'SYNTHETIC_TEST_ONLY.onnx'
        model_file(model)
        image = np.zeros((13, 19), dtype=np.uint8)
        image[1:11, 2:15] = 255
        image[4:8, 5:10] = 0
        image[11:13, 17:19] = 255
        source = directory / 'synthetic.tif'
        tifffile.imwrite(source, image, photometric='minisblack', metadata=None)
        manifest = {
            'schema': 'cerebellum-onnx-model/1',
            'model': {'id': 'SYNTHETIC_TEST_ONLY', 'version': '1', 'weights_sha256': hashlib.sha256(model.read_bytes()).hexdigest()},
            'single_section': True, 'input_layout': 'NCHW', 'output_layout': 'NCHW',
            'input_channels': 'gray', 'input_dtype': 'uint8',
            'normalization': {'offset': [0], 'scale': [255]},
            'tile_size': [8, 8], 'tile_overlap': [3, 3],
            'classes': ['background', 'CB'], 'output_kind': 'logits', 'padding': 'edge',
        }
        manifest_path = directory / 'manifest.json'
        manifest_path.write_text(json.dumps(manifest))
        result = runner.predict(source, model, manifest_path)
        assert result['source']['sha256'] == hashlib.sha256(source.read_bytes()).hexdigest()
        assert result['source']['width'] == 19 and result['source']['height'] == 13
        assert result['processing']['tile_count'] == 8
        assert result['processing']['pixel_counts']['CB'] == int((image > 0).sum()) == 114
        assert len(result['rois']) == 2 and len(result['rois'][0]['paths']) == 2
        assert sum(runner.polygon_area(roi['paths']) for roi in result['rois']) == 114
        checks += ['Actual CPU ONNX inference over 8 overlapping tiles', 'Exact pixel-cell area, holes, components and image-edge padding', 'Source/model/manifest SHA-256 provenance']
        bundle = directory / 'prediction.json'
        bundle.write_text(json.dumps(result))
        core = ROOT / 'src/analysis_core.js'
        assert core.is_file(), 'Browser review core must exist for the interop test.'
        if core.exists():
            completed = subprocess.run(['node', '-e', """const fs=require('fs'),assert=require('assert');globalThis.crypto=require('crypto').webcrypto;
const c=require(process.argv[1]),r=require(process.argv[3]),p=JSON.parse(fs.readFileSync(process.argv[2]));
(async()=>{let state=c.create(p,p.source);state=c.setMetadata(state,{animal_id:'synthetic',section_id:'section-1',single_section_confirmed:true,um_per_pixel_x:2,um_per_pixel_y:3});state=await c.approve(state,{reviewer:'Synthetic test',protocol:'Arithmetic fixture only, no anatomical accuracy',checked:true});const out=await c.exportApproved(state);assert.equal(out.report.measurements.reduce((s,m)=>s+m.area_px2,0),114);assert.equal(out.report.measurements.reduce((s,m)=>s+m.area_um2,0),684);assert.equal(out.files.length,2);out.files.forEach((file,i)=>{const roi=r.parseROI(file.bytes,file.name);assert.deepEqual(roi.paths,state.rois[i].paths);assert.equal(c.measure(roi).area_px2,out.report.measurements[i].area_px2);});console.log('ONNX prediction review, approval, measured CSV and ImageJ bytes interoperate');})().catch(e=>{console.error(e);process.exit(1);});""", str(core), str(bundle), str(ROOT / 'src/research_core.js')], capture_output=True, text=True)
            assert completed.returncode == 0, completed.stderr
            checks.append('ONNX output accepted, approved and exported by browser core; calibrated measurements and ImageJ ROI roundtrip exact')
        labels, _ = runner.infer(image[:, :, None], model, manifest)
        assert np.array_equal(labels, image > 0)
        checks.append('Tiled labels equal untiled known synthetic mask at every pixel')
        for invalid, message in [({'single_section': False}, 'single_section'), ({'classes': ['background', 'PL']}, 'Classes'), ({'tile_overlap': [8, 0]}, 'tile_overlap')]:
            rejects(lambda: runner.validate_manifest({**manifest, **invalid}), message)
        bad_manifest = {**manifest, 'model': {**manifest['model'], 'weights_sha256': '0'*64}}
        bad_manifest_path = directory / 'wrong.json'
        bad_manifest_path.write_text(json.dumps(bad_manifest))
        rejects(lambda: runner.predict(source, model, bad_manifest_path), 'SHA-256')
        rejects(lambda: runner.predict(source, directory / 'missing.onnx', manifest_path), 'not found')
        external_model = directory / 'external.onnx'
        external_graph = onnx.load(model)
        tensor = external_graph.graph.initializer[0]
        tensor.ClearField('raw_data')
        tensor.data_location = TensorProto.EXTERNAL
        tensor.external_data.add(key='location', value='unbound-weights.bin')
        external_model.write_bytes(external_graph.SerializeToString())
        external_manifest = {**manifest, 'model': {**manifest['model'], 'weights_sha256': hashlib.sha256(external_model.read_bytes()).hexdigest()}}
        external_manifest_path = directory / 'external.json'
        external_manifest_path.write_text(json.dumps(external_manifest))
        rejects(lambda: runner.predict(source, external_model, external_manifest_path), 'External ONNX')
        checks.append('Missing weights, wrong digest, external tensor files, unsupported classes and ambiguous montage rejected')
        rotated = directory / 'rotated.tif'
        tifffile.imwrite(rotated, image, extratags=[(274, 'H', 1, 6, False)], metadata=None)
        rejects(lambda: runner.read_image(rotated, manifest), 'orientation')
        multipage = directory / 'multipage.tif'
        with tifffile.TiffWriter(multipage) as tif:
            tif.write(image, metadata=None)
            tif.write(image, metadata=None)
        rejects(lambda: runner.read_image(multipage, manifest), 'one page')
        floating = directory / 'float.tif'
        tifffile.imwrite(floating, image.astype(np.float32), metadata=None)
        rejects(lambda: runner.read_image(floating, manifest), 'dtype')
        checks.append('Rotated, multi-page and wrong-dtype originals rejected')
        small = np.zeros((3, 4, 1), dtype=np.uint8)
        small[0, 0] = 255
        small_labels, tile_count = runner.infer(small, model, manifest)
        assert tile_count == 1 and np.array_equal(small_labels, small[:, :, 0] > 0)
        rejects(lambda: runner.infer(np.zeros((128, 128, 1), dtype=np.uint8), model, {**manifest, 'tile_overlap': [7, 7]}), '10000 tiles')
        sixteen = directory / 'uint16.tif'
        tifffile.imwrite(sixteen, image.astype(np.uint16) * 257, metadata=None)
        sixteen_manifest = {**manifest, 'input_dtype': 'uint16', 'normalization': {'offset': [0], 'scale': [65535]}}
        sixteen_image, _ = runner.read_image(sixteen, sixteen_manifest)
        sixteen_labels, _ = runner.infer(sixteen_image, model, sixteen_manifest)
        assert np.array_equal(sixteen_labels, image > 0)
        rgb_model = directory / 'SYNTHETIC_RGB_TEST_ONLY.onnx'
        model_file(rgb_model, channels=3)
        rgb = np.stack([image, np.zeros_like(image), np.full_like(image, 31)], axis=-1)
        rgb_source = directory / 'rgb.tif'
        tifffile.imwrite(rgb_source, rgb, photometric='rgb', metadata=None)
        rgb_manifest = {**manifest, 'input_channels': 'RGB', 'normalization': {'offset': [0, 10, 30], 'scale': [255, 127, 63]}, 'model': {**manifest['model'], 'weights_sha256': hashlib.sha256(rgb_model.read_bytes()).hexdigest()}}
        rgb_manifest_path = directory / 'rgb.json'
        rgb_manifest_path.write_text(json.dumps(rgb_manifest))
        rgb_result = runner.predict(rgb_source, rgb_model, rgb_manifest_path)
        assert rgb_result['processing']['pixel_counts']['CB'] == 114
        rgb_image, _ = runner.read_image(rgb_source, rgb_manifest)
        rgb_labels, _ = runner.infer(rgb_image, rgb_model, rgb_manifest)
        assert np.array_equal(rgb_labels, image > 0)
        rejects(lambda: runner.read_image(rgb_source, manifest), 'channels')
        checks.append('Sub-tile padding, uint16 normalization, explicit RGB channels and bounded tile count')
        pinch = np.ones((3, 3), dtype=bool)
        pinch[0, 0] = pinch[1, 1] = False
        rejects(lambda: runner.cell_paths(pinch), 'pinch')
        diagonal = np.array([[1, 0], [0, 1]], dtype=np.uint8)
        rois, _ = runner.vectorize(diagonal, ['background', 'CB'])
        assert len(rois) == 2 and all(runner.polygon_area(roi['paths']) == 1 for roi in rois)
        rejects(lambda: runner.vectorize(np.zeros((2, 2), dtype=np.uint8), ['background', 'CB']), 'background only')
        checks.append('Diagonal components retained separately; topology pinches and empty masks rejected')
        output = directory / 'cli-prediction.json'
        assert runner.main(['--image', str(source), '--model', str(model), '--manifest', str(manifest_path), '--output', str(output)]) == 0
        before = output.read_bytes()
        assert runner.main(['--image', str(source), '--model', str(model), '--manifest', str(manifest_path), '--output', str(output)]) == 2
        assert output.read_bytes() == before
        checks.append('CLI preserves existing prediction files')
    REPORT['pass'] = True
    print(json.dumps(REPORT, indent=2))


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        REPORT['error'] = str(error)
        raise
    finally:
        (ROOT / 'qa/nissl-runner.json').write_text(json.dumps(REPORT, indent=2) + '\n')
