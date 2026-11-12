/* Exact synthetic geometry checks, not anatomical validation. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const C=require('../src/browser_model_core.js'),B=require('../src/auto_roi_model_bundle.js');
const checks=[];
function model(classes){return {schema:'cerebellum-pixel-forest/1',id:'test-optional',version:'1.0.0',features:C.FEATURES,input:{channels:'gray',dtype:'uint8',scale:[255]},classes,training_animals:['mouse-training'],training_sources:[{animal_id:'mouse-training',section_id:'mouse-training-1',source_sha256:'a'.repeat(64),label_sha256:'b'.repeat(64)}],trees:[{left:[-1],right:[-1],feature:[-2],threshold:[-2],probabilities:[classes.map((_,i)=>i===1?1:0)]}]};}
const bundle={schema:'cerebellum-auto-roi-models/1',primary:'layers',models:{cb:model(['background','CB']),layers:model(['background','ML','GL','WM'])}};
assert.deepEqual(B.heads(bundle).map(x=>x[0]),['cb','layers']);
assert.throws(()=>B.validate({...bundle,models:{...bundle.models,lobules:null}}));
assert.throws(()=>B.modelForHead(bundle,'lobules'));
bundle.models.lobules=model(['background','LOBULE_3Cb','LOBULE_Crus1','LOBULE_Fl','LOBULE_FI']);
assert.deepEqual(B.heads(bundle).map(x=>x[0]),['cb','layers','lobules']);
assert.deepEqual(B.modelForHead(bundle,'lobules').classes.slice(-2),['LOBULE_Fl','LOBULE_FI']);
const mismatch=structuredClone(bundle);mismatch.models.lobules.training_sources[0].source_sha256='c'.repeat(64);assert.throws(()=>B.validate(mismatch));
for(const classes of [['background','PL'],['background','LOBULE_invented'],['background','LOBULE_3Cb','LOBULE_3Cb'],['background','CB','LOBULE_3Cb']])assert.throws(()=>C.validateModel(model(classes)));
checks.push('Optional head is explicit; absent heads never fabricated; original region spellings and source provenance retained');
const area=C.vectorize(Uint8Array.from([0,0,0,0,0,1,1,0,0,1,1,0,0,0,0,0]),4,4,['background','LOBULE_3Cb']);
assert.equal(area.rois[0].label,'OTHER');assert.equal(area.rois[0].region,'3Cb');assert.equal(area.rois[0].kind,'area');assert.equal(area.rois[0].metadata.model_class,'LOBULE_3Cb');assert.equal(area.counts.LOBULE_3Cb,4);
checks.push('Named cortical cells remain generic areas with exact region and limited anatomical scope, never whole-lobule WM');
for(const [w,h,values,edges]of [[4,3,[1,1,2,2,1,1,2,2,1,1,2,2],3],[2,2,[1,2,2,1],4],[3,3,[1,1,1,1,2,1,1,1,1],4],[2,2,[1,0,3,2],0]]){
 const result=C.plInterface(Uint8Array.from(values),w,h);assert.equal(result.edge_count,edges);assert.equal(result.total_length_px,edges);let length=0;
 for(const roi of result.rois){assert.equal(roi.kind,'polyline');assert.equal(roi.closed,false);assert.equal(roi.metadata.purkinje_identity_established,false);assert.equal(roi.metadata.candidate_only,true);const p=roi.paths[0];assert.notDeepEqual(p[0],p.at(-1));for(let i=1;i<p.length;i++)length+=Math.hypot(p[i][0]-p[i-1][0],p[i][1]-p[i-1][1]);}assert.equal(length,edges);
}
assert.throws(()=>C.plInterface(Uint8Array.of(1,255),2,1));
const noise=Uint8Array.from({length:10000},(_,i)=>(Math.floor(i/100)+i%100)%2+1);assert.throws(()=>C.plInterface(noise,100,100));
checks.push('ML–GL interface candidates preserve all edges/lengths including cycles and branches; limits refuse partial results');
const A=require('../src/analysis_core.js'),source={name:'synthetic.tif',sha256:'a'.repeat(64),width:4,height:4};
const prediction=rois=>({schema:'cerebellum-prediction/1',source,model:{id:'optional-test',version:'1',weights_sha256:'b'.repeat(64)},rois});
const cortex=area.rois[0],pl=C.plInterface(Uint8Array.from([1,1,2,2,1,1,2,2,1,1,2,2,1,1,2,2]),4,4).rois[0];
const state=A.create(prediction([cortex,pl]),source);assert.equal(state.approval,null);assert.equal(state.rois[0].metadata.anatomy_scope,'ML+GL annotated cortical subregions; not whole lobule');assert.equal(state.rois[1].kind,'polyline');
for(const alter of [r=>{delete r.metadata;},r=>{r.region='invented';},r=>{r.metadata.model_class='LOBULE_Crus1';},r=>{r.metadata.anatomy_scope='whole lobule';},r=>{r.kind='polyline';r.closed=false;}]){const r=structuredClone(cortex);alter(r);assert.throws(()=>A.validatePrediction(prediction([r]),source));}
for(const alter of [r=>{delete r.metadata;},r=>{r.metadata.purkinje_identity_established=true;},r=>{r.metadata.candidate_only=false;},r=>{r.metadata.source_classes=['background','PL'];},r=>{r.kind='area';r.closed=true;r.paths=[[[0,0],[2,0],[2,2],[0,2]]];}]){const r=structuredClone(pl);alter(r);assert.throws(()=>A.validatePrediction(prediction([r]),source));}
checks.push('Analysis accepts only explicit cortical-region and PL-interface metadata; altered identity, unsupported regions, generic OTHER and PL-area substitutions are refused');
const report={status:'passed',scope:'Synthetic model contract and geometry only; no anatomical accuracy claim',checks};
fs.writeFileSync(path.join(__dirname,'optional-anatomy.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
