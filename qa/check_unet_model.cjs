/* Browser-side U-Net execution against PyTorch outputs on a synthetic fixture; not Nissl accuracy. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
globalThis.atob=globalThis.atob||(s=>Buffer.from(s,'base64').toString('binary'));
const Core=require('../src/browser_model_core.js');globalThis.BrowserModelCore=Core;
const Bundle=require('../src/auto_roi_model_bundle.js');globalThis.AutoROIModelBundle=Bundle;
const UNet=require('../src/unet_model_core.js'),Candidates=require('../src/raster_candidate_core.js');
const root=path.resolve(__dirname,'..'),fixture=JSON.parse(fs.readFileSync(path.join(root,'qa/fixtures/unet-synthetic.json'))),checks=[];
const floats=s=>{const b=Buffer.from(s,'base64');return new Float32Array(b.buffer,b.byteOffset,b.length/4);};
const copy=()=>JSON.parse(JSON.stringify(fixture.model)),refused=(mutate,words)=>{const m=copy();mutate(m);assert.throws(()=>Bundle.validate(m),words);};

const checked=Bundle.validate(fixture.model);
assert.equal(checked.family,'experimental-unet');assert.equal(checked.isBundle,true);assert.deepEqual(Object.keys(checked.models).sort(),['cb','layers']);
assert.deepEqual(checked.models.cb.classes,['background','CB']);assert.deepEqual(checked.models.layers.classes,['background','ML','GL','WM']);assert.equal(Bundle.modelForHead(fixture.model,'cb').classes.length,2);
checks.push('The bundle validates and exposes separately named CB and tissue-layer maps');
refused(m=>{delete m.tensors['o.bias'];},/architecture/);
refused(m=>{m.tensors['o.bias'].shape=[5];},/architecture/);
refused(m=>{m.tensors['o.bias'].base64=m.tensors['o.bias'].base64.slice(4);},/architecture/);
refused(m=>{m.architecture.classes=['background','CB'];},/architecture/);
refused(m=>{m.input.channels='gray';},/channels/);
refused(m=>{m.review_required=false;},/review/);
refused(m=>{m.anatomical_accuracy_established=true;},/accuracy/);
refused(m=>{m.training_sources=[];},/provenance/);
refused(m=>{m.inference.keep=m.inference.tile;},/inference/);
refused(m=>{m.evaluation={schema:'cerebellum-declared-whole-image-evaluation/1',evaluation_animals:['SYN'],dice:{CB:1,ML:1,GL:1,WM:1},independent_validation_established:false};},/evaluation/);
refused(m=>{m.evaluation={schema:'cerebellum-declared-whole-image-evaluation/1',evaluation_animals:['X'],dice:{CB:1.2,ML:1,GL:1,WM:1},independent_validation_established:false};},/evaluation/);
const bad=copy();const raw=Buffer.from(bad.tensors['o.bias'].base64,'base64');raw.writeFloatLE(Number.NaN,0);bad.tensors['o.bias'].base64=raw.toString('base64');
assert.throws(()=>UNet.compile(bad).get('o.bias'),/nonfinite/);
checks.push('Missing or misshapen weights, unsupported input, false accuracy declarations and nonfinite values are refused');

const net=UNet.compile(fixture.model);let worstLogit=0,worstProbability=0;
for(const c of fixture.forward_cases){
 const logits=UNet.forward(net,Float32Array.from(floats(c.input)),c.height,c.width),expected=floats(c.logits);assert.equal(logits.length,expected.length);
 for(let i=0;i<logits.length;i++)worstLogit=Math.max(worstLogit,Math.abs(logits[i]-expected[i]));
 const p=UNet.softmax(logits,4,c.height*c.width),q=floats(c.probabilities);for(let i=0;i<p.length;i++)worstProbability=Math.max(worstProbability,Math.abs(p[i]-q[i]));
}
assert.ok(worstLogit<2e-3,'logit difference '+worstLogit);assert.ok(worstProbability<2e-3,'probability difference '+worstProbability);
checks.push('Forward logits and probabilities match PyTorch on even, odd and minimum sizes (worst logit difference '+worstLogit.toExponential(2)+')');

const {height,width}=fixture.native,pixels=new Uint8Array(Buffer.from(fixture.native.image,'base64'));
const reader={width,height,channels:3,dtype:'uint8',readWindow(x,y,w,h){const out=new Uint8Array(w*h*3);for(let j=0;j<h;j++)out.set(pixels.subarray(((y+j)*width+x)*3,((y+j)*width+x+w)*3),j*w*3);return out;}};
const predicted=UNet.predict(fixture.model,reader),expected=new Uint8Array(Buffer.from(fixture.native.labels,'base64'));
let different=0;for(let i=0;i<expected.length;i++)if(predicted.layers[i]!==expected[i])different++;
assert.ok(different/expected.length<1e-3,'native label differences '+different);
for(let i=0;i<expected.length;i++)assert.equal(predicted.cb[i],predicted.layers[i]?1:0);
assert.throws(()=>UNet.predict(fixture.model,{...reader,channels:1}),/8-bit RGB/);
assert.throws(()=>UNet.predict(fixture.model,{...reader,width:40,height:40}),/too small/);
assert.throws(()=>UNet.predict(fixture.model,{...reader,readWindow:()=>new Uint8Array(3)}),/byte count/);
checks.push('Tiled native labels match the PyTorch reference ('+different+' of '+expected.length+' pixels differ); the CB map is exactly the union of tissue classes');

// Region cleanup on a hand-made map.
const W=64,H=64,labels=new Uint8Array(W*H);const fill=(x0,y0,x1,y1,v)=>{for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)labels[y*W+x]=v;};
fill(0,0,32,64,1);fill(32,0,64,64,2);fill(8,8,16,16,3);fill(48,48,56,56,0);
const classes=['background','ML','GL','WM'];
const off=Candidates.create(labels,W,H,classes,{blockSize:8});
assert.equal(off.processing.absorbed_region_count,0);assert.equal(off.processing.minimum_region_pixels,0);assert.equal(off.processing.method,'block-majority-then-small-component-removal/1');
const on=Candidates.create(labels,W,H,classes,{blockSize:8,minimumRegionPixels:128});
assert.equal(on.counts.WM,0);assert.ok(on.processing.absorbed_region_count>=2);assert.ok(on.processing.changed_pixels>off.processing.changed_pixels);assert.equal(on.processing.method,'block-majority-then-region-cleanup/1');
const sum=Object.values(on.processing.candidate_pixel_counts).reduce((a,b)=>a+b,0);assert.equal(sum,W*H);
const shared=on.grid.map(v=>v?1:0),cb=Candidates.create(labels.map(v=>v?1:0),W,H,['background','CB'],{blockSize:8,sharedGrid:shared});
assert.equal(cb.processing.shared_grid,true);assert.equal(cb.counts.CB,on.counts.ML+on.counts.GL+on.counts.WM);
assert.throws(()=>Candidates.create(labels,W,H,classes,{blockSize:8,sharedGrid:new Uint8Array(3)}),/shared/);
assert.throws(()=>Candidates.create(labels,W,H,classes,{blockSize:8,minimumRegionPixels:-1}),/region/);
checks.push('Cleanup is opt-in, counts every changed pixel, and the CB outline can follow the cleaned tissue grid');
// A diagonal contact fails unchanged, and becomes valid when cleanup is requested.
const pinch=new Uint8Array(W*H),cell=(cx,cy)=>{for(let y=0;y<8;y++)for(let x=0;x<8;x++)pinch[(cy*8+y)*W+cx*8+x]=1;};for(const[cx,cy]of [[0,0],[1,0],[2,0],[0,1],[0,2],[1,2],[2,1]])cell(cx,cy);
assert.throws(()=>Candidates.create(pinch,W,H,classes,{blockSize:8}),/diagonal/);
const fixed=Candidates.create(pinch,W,H,classes,{blockSize:8,minimumRegionPixels:1});assert.ok(fixed.processing.bridged_diagonal_cells>0);assert.ok(fixed.rois.length>0);
checks.push('Diagonal contacts still fail by default and are bridged only under explicit cleanup');
fs.writeFileSync(path.join(root,'qa/unet-model-check.json'),JSON.stringify({schema:'cerebellum-unet-model-check/1',status:'passed',checks,scope:'Synthetic fixture with random weights; not Nissl accuracy.'},null,2)+'\n');
console.log('U-Net model checks passed:',checks.length);
