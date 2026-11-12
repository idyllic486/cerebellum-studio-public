/* Analytical contours only. This does not measure model or biological accuracy. */
const assert = require('node:assert/strict');
const {webcrypto} = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
globalThis.crypto ||= webcrypto;
const C = require('../src/validation_core.js');
const hash = char => char.repeat(64);
const box = (x=16,y=16,w=32,h=32) => [[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
const roi = (name='CB',paths=[box()],extra={}) => ({name,kind:'area',paths,...extra});
const model = () => ({id:'synthetic-test-model',version:'1',weights_sha256:hash('f'),training_animals:['train-animal'],training_provenance_complete:true});
const pair = () => ({animal_id:'test-animal',section_id:'s1',source:{sha256:hash('a'),width:128,height:128},
  prediction_source_sha256:hash('a'),reference_source_sha256:hash('a'),
  prediction_rois:[roi()],reference_rois:[roi()],calibration:{um_per_pixel_x:2,um_per_pixel_y:3},
  evaluation_split:'test',prediction_stage:'model_draft',model:model()});
const bundle = pairs => ({schema:C.SCHEMA,protocol_id:'synthetic-boundary-protocol-v1',pairs:pairs||[pair()]});
const animal = (id,split,sourceHash,extra={}) => ({id,split,sections:[{id:'s1',source:{sha256:sourceHash,width:128,height:128},model:model()}],...extra});
const close = (actual,expected,tolerance=1e-10) => assert.ok(Math.abs(actual-expected)<=tolerance, `${actual} != ${expected}`);
function mutatedPair(change) {const p=pair();change(p);return p;}
function run(change,options) {return C.evaluatePair(mutatedPair(change),options);}
function rejects(change,pattern) {assert.throws(()=>run(change),pattern);}
function stamp(p,char,section='s1') {p.source.sha256=hash(char);p.prediction_source_sha256=hash(char);p.reference_source_sha256=hash(char);p.section_id=section;return p;}
function bruteBoundaryDistances(masks,grid,sx=1,sy=1) {
  const edge=mask=>{
    const points=[];
    for(let y=0;y<grid.height;y++)for(let x=0;x<grid.width;x++) {
      if(!mask[y*grid.width+x])continue;
      if([[x-1,y],[x+1,y],[x,y-1],[x,y+1]].some(([a,b])=>a<0||b<0||a>=grid.width||b>=grid.height||mask[b*grid.width+a]===0))points.push([x,y]);
    }
    return points;
  };
  const p=edge(masks.prediction),r=edge(masks.reference);
  const directed=(from,to)=>from.map(([x,y])=>Math.min(...to.map(([u,v])=>Math.hypot((x-u)*grid.spacing_x*sx,(y-v)*grid.spacing_y*sy))));
  const values=[...directed(p,r),...directed(r,p)].sort((a,b)=>a-b),at=(values.length-1)*.95;
  return {mean:values.reduce((a,b)=>a+b,0)/values.length,hd95:values[Math.floor(at)]+(values[Math.ceil(at)]-values[Math.floor(at)])*(at-Math.floor(at))};
}

(async()=>{
  const original=pair(),snapshot=structuredClone(original);
  const identical=C.evaluatePair(original,{grid:128,includeMasks:true});
  assert.deepEqual(original,snapshot,'Evaluation must not rewrite original contours or metadata');
  assert.equal(identical.layers.CB.status,'scored');
  assert.equal(identical.layers.CB.dice,1);assert.equal(identical.layers.CB.iou,1);
  assert.equal(identical.layers.CB.predicted_area_px2,1024);assert.equal(identical.layers.CB.reference_area_um2,6144);
  assert.equal(identical.layers.CB.boundary.mean_symmetric_px,0);assert.equal(identical.layers.CB.boundary.hd95_um,0);
  assert.equal(identical.layers.CB.masks.prediction.length,128*128);
  assert.deepEqual(identical.grid.domain,[0,0,128,128]);assert.equal(identical.grid.outside_vertex_count,0);
  assert.equal(identical.independence.status,'eligible_under_declared_provenance');

  const translated=run(p=>p.prediction_rois=[roi('CB',[box(24)])]).layers.CB;
  close(translated.dice,.75);close(translated.iou,.6);assert.equal(translated.signed_area_error_pct,0);
  assert.equal(translated.boundary.hd95_px,8);assert.equal(translated.boundary.hd95_um,16);
  const half=run(p=>p.prediction_rois=[roi('CB',[box(16,16,16,32)])]).layers.CB;
  close(half.dice,2/3);assert.equal(half.iou,.5);assert.equal(half.signed_area_error_pct,-50);assert.equal(half.absolute_area_error_pct,50);
  const enlarged=run(p=>p.prediction_rois=[roi('CB',[box(16,16,64,32)])]).layers.CB;
  assert.equal(enlarged.signed_area_error_pct,100);assert.equal(enlarged.signed_area_error_um2,6144);

  const hole=run(p=>{p.prediction_rois=[roi('CB',[box(),box(24,24,16,16)])];p.reference_rois=structuredClone(p.prediction_rois);}).layers.CB;
  assert.equal(hole.predicted_area_px2,768);assert.equal(hole.dice,1);
  const union=run(p=>{p.prediction_rois=[roi('first',[box()],{label:'CB'}),roi('second',[box(32)],{label:'CB'})];p.reference_rois=[roi('CB',[box(16,16,48,32)])];}).layers.CB;
  assert.equal(union.predicted_area_px2,1536);assert.equal(union.dice,1,'Overlapping components must be a union, not a sum or XOR');
  const islands=run(p=>{p.prediction_rois=[roi('CB',[box(16,16,16,16),box(48,48,16,16)])];p.reference_rois=structuredClone(p.prediction_rois);}).layers.CB;
  assert.equal(islands.predicted_area_px2,512);
  const full=run(p=>{p.prediction_rois=[roi('CB',[box(0,0,128,128)])];p.reference_rois=structuredClone(p.prediction_rois);}).layers.CB;
  assert.equal(full.predicted_area_px2,128*128);assert.equal(full.dice,1,'Right and bottom image borders are valid geometry');
  const aspect=run(p=>{p.source.width=256;},{grid:128});
  assert.equal(aspect.grid.width,128);assert.equal(aspect.grid.height,64);assert.equal(aspect.layers.CB.predicted_area_px2,1024);
  const irregular=run(p=>{
    p.source.width=300;p.source.height=150;
    p.prediction_rois=[roi('CB',[[[20,20],[100,20],[100,45],[60,45],[60,100],[20,100]],box(30,30,10,10)])];
    p.reference_rois=structuredClone(p.prediction_rois);
    for(const path of p.reference_rois[0].paths)for(const pt of path){pt[0]+=7;pt[1]+=3;}
  },{grid:128,includeMasks:true});
  for(const [sx,sy,unit] of [[1,1,'px'],[2,3,'um']]) {
    const independentlyComputed=bruteBoundaryDistances(irregular.layers.CB.masks,irregular.grid,sx,sy);
    close(irregular.layers.CB.boundary['mean_symmetric_'+unit],independentlyComputed.mean,1e-8);
    close(irregular.layers.CB.boundary['hd95_'+unit],independentlyComputed.hd95,1e-8);
  }

  assert.equal(identical.layers.ML.status,'unassessed');assert.equal(identical.layers.ML.dice,null);
  const missing=run(p=>p.reference_rois=[]).layers.CB;
  assert.equal(missing.status,'unassessed');assert.equal(missing.reference_area_px2,null);assert.equal(missing.dice,null);
  const emptyBoth=run(p=>{p.prediction_rois=[];p.reference_rois=[];p.coverage={prediction:{CB:'absent'},reference:{CB:'absent'}};}).layers.CB;
  assert.equal(emptyBoth.status,'both_absent');assert.equal(emptyBoth.dice,null);assert.equal(emptyBoth.iou,null);assert.equal(emptyBoth.reference_area_px2,0);assert.equal(emptyBoth.signed_area_error_pct,null);
  const emptyPrediction=run(p=>{p.prediction_rois=[];p.coverage={prediction:{CB:'absent'}};}).layers.CB;
  assert.equal(emptyPrediction.dice,0);assert.equal(emptyPrediction.false_negative_cells,1024);assert.equal(emptyPrediction.signed_area_error_pct,-100);assert.equal(emptyPrediction.boundary.hd95_px,null);
  const emptyReference=run(p=>{p.reference_rois=[];p.coverage={reference:{CB:'absent'}};}).layers.CB;
  assert.equal(emptyReference.dice,0);assert.equal(emptyReference.signed_area_error_pct,null);assert.equal(emptyReference.false_positive_cells,1024);
  rejects(p=>p.coverage={prediction:{CB:'absent'}},/declared absent/);
  rejects(p=>{p.reference_rois=[];p.coverage={reference:{CB:'present'}};},/needs selected/);
  const vanishing=run(p=>{p.prediction_rois=[roi('CB',[box(16.05,16.05,.1,.1)])];p.reference_rois=structuredClone(p.prediction_rois);}).layers.CB;
  assert.equal(vanishing.status,'unscorable');assert.equal(vanishing.dice,null);assert.equal(vanishing.predicted_area_px2,null);
  const coarse=run(p=>{p.prediction_rois=[roi('CB',[box(16.1,16.1,.3,.3)])];p.reference_rois=structuredClone(p.prediction_rois);});
  const fine=run(p=>{p.prediction_rois=[roi('CB',[box(16.1,16.1,.3,.3)])];p.reference_rois=structuredClone(p.prediction_rois);},{grid:256});
  assert.equal(coarse.layers.CB.status,'unscorable');assert.equal(fine.layers.CB.status,'scored');

  rejects(p=>p.reference_source_sha256=hash('b'),/same original image/);
  rejects(p=>p.prediction_rois[0].paths[0][0][0]=-1,/1 ROI vertices lie outside/);
  rejects(p=>p.prediction_rois[0].paths[0][1][0]=129,/outside/);
  rejects(p=>p.prediction_rois[0].paths[0][0][0]=Infinity,/finite XY/);
  rejects(p=>p.source.width=1.5,/dimensions/);
  rejects(p=>p.calibration.um_per_pixel_x=0,/positive/);
  rejects(p=>p.calibration.um_per_pixel_y=-1,/positive/);
  assert.equal(run(p=>delete p.calibration).layers.CB.predicted_area_um2,null);
  assert.equal(run(p=>p.calibration.um_per_pixel_x=null).layers.CB.boundary.mean_symmetric_um,null);
  rejects(p=>p.prediction_rois[0].kind='polyline',/area contours/);
  rejects(p=>p.prediction_rois[0].closed=false,/area contours/);
  rejects(p=>p.prediction_rois.push(roi()),/Duplicate ROI/);
  rejects(p=>p.prediction_layer_selection={CB:['unknown']},/Selected ROI is absent/);
  rejects(p=>{p.prediction_rois[0].included=false;p.prediction_layer_selection={CB:['CB']};},/excluded/);
  rejects(p=>p.prediction_rois=[roi('CB_I'),roi('CB_II',[box(32)])],/not assumed to be an exhaustive/);
  const explicit=run(p=>{p.prediction_rois=[roi('CB_I'),roi('CB_II',[box(32)])];p.prediction_layer_selection={CB:['CB_I']};});
  assert.equal(explicit.layers.CB.dice,1);
  const total=run(p=>p.prediction_rois=[roi('CB_TOTAL'),roi('CB_I',[box(80)])]);
  assert.equal(total.layers.CB.dice,1);assert.deepEqual(total.layers.CB.prediction_roi_names,['CB_TOTAL']);
  assert.equal(C.evaluatePair(pair(),{grid:512}).grid.width,512);
  assert.throws(()=>C.evaluatePair(pair(),{grid:2048}),/128, 256, 512 or 1024/);
  assert.throws(()=>C.evaluatePair(pair(),{layers:['CB','CB']}),/unique/);

  const declared={animals:[animal('train-animal','train',hash('b')),animal('test-animal','test',hash('a'))]};
  const checked=C.checkSplits(declared);
  assert.equal(checked.status,'eligible_under_declared_provenance');assert.equal(checked.independence_established,false);assert.equal(checked.counts.animals,2);
  const overlap=C.checkSplits({splits:{train:['same-animal'],test:['same-animal']},model:model()});
  assert.equal(overlap.status,'blocked');assert.ok(overlap.issues.some(i=>i.code==='animal_split_overlap'));
  const sharedSource=C.checkSplits({animals:[animal('a','train',hash('a')),animal('b','test',hash('a'))]});
  assert.equal(sharedSource.status,'blocked');assert.ok(sharedSource.issues.some(i=>i.code==='source_hash_shared_across_animals'));
  const missingProvenance=structuredClone(declared);delete missingProvenance.animals[1].sections[0].model;
  assert.equal(C.checkSplits(missingProvenance).status,'unverified');
  assert.equal(run(p=>delete p.model).independence.status,'unverified');
  assert.equal(run(p=>delete p.model.weights_sha256).independence.status,'unverified');
  assert.equal(run(p=>p.model.training_provenance_complete=false).independence.status,'unverified');
  assert.equal(run(p=>p.model.training_animals=['test-animal']).independence.status,'blocked');
  assert.equal(run(p=>{p.model.training_animals=['test-animal'];p.model.training_provenance_complete=false;}).independence.status,'blocked','Known leakage remains blocked when training provenance is incomplete');
  assert.equal(run(p=>p.evaluation_split='train').independence.status,'unverified');
  rejects(p=>p.model.training_animals=['a','a'],/must be unique/);
  const repeatSource=structuredClone(declared);repeatSource.animals[1].sections.push({...repeatSource.animals[1].sections[0],id:'s2'});
  assert.ok(C.checkSplits(repeatSource).issues.some(i=>i.code==='repeated_source_within_animal'));
  const batches=structuredClone(declared);for(const a of batches.animals)a.batch='same-batch';
  assert.equal(C.checkSplits(batches).status,'unverified');
  assert.equal(C.checkSplits({animals:[]}).status,'unverified');

  const reports=[0,1,2].map(i=>C.evaluatePair(stamp(pair(),String(i),String(i))));
  const disjoint=mutatedPair(p=>{p.animal_id='other-animal';p.prediction_rois=[roi('CB',[box(80)])];});
  reports.push(C.evaluatePair(stamp(disjoint,'c')));
  const balanced=C.aggregate(reports);
  assert.equal(balanced.animal_count,2);assert.equal(balanced.section_count,4);assert.equal(balanced.layers.CB.animal_mean_dice,.5,'Three sections must not weight an animal threefold');
  assert.equal(balanced.layers.CB.scored_animals,2);assert.equal(balanced.layers.ML.scored_animals,0);assert.equal(balanced.layers.ML.animal_mean_dice,null);
  const denominators=C.aggregate([identical,C.evaluatePair(mutatedPair(p=>{p.section_id='missing';p.reference_rois=[];}))]);
  assert.equal(denominators.layers.CB.animals[0].scored_sections,1);assert.equal(denominators.layers.CB.animals[0].unassessed_sections,1);assert.equal(denominators.layers.CB.animal_mean_dice,1);
  const partialScale=mutatedPair(p=>{p.animal_id='no-scale';delete p.calibration;});
  const metricDenominators=C.aggregate([identical,C.evaluatePair(partialScale)]).layers.CB;
  assert.equal(metricDenominators.metric_animal_counts.dice,2);assert.equal(metricDenominators.metric_animal_counts.boundary_distance_um,1);
  const absenceDenominators=C.aggregate([C.evaluatePair(mutatedPair(p=>{p.reference_rois=[];p.coverage={reference:{CB:'absent'}};}))]).layers.CB;
  assert.equal(absenceDenominators.metric_animal_counts.dice,1);assert.equal(absenceDenominators.metric_animal_counts.relative_area_error,0);
  assert.equal(absenceDenominators.animals[0].metric_section_counts.boundary_distance_um,0);

  assert.equal(identical.review_time,null);
  const recorded=run(p=>p.review_time={manual_minutes:12,assisted_minutes:8,same_protocol:true}).review_time;
  assert.equal(recorded.difference_minutes,4);close(recorded.reduction_pct,100/3);
  assert.equal(run(p=>p.review_time={manual_minutes:12}).review_time.reduction_pct,null);
  assert.equal(run(p=>p.review_time={manual_minutes:0,assisted_minutes:1,same_protocol:true}).review_time.reduction_pct,null);
  rejects(p=>p.review_time={manual_minutes:12,assisted_minutes:8},/same_protocol/);
  rejects(p=>p.review_time={manual_minutes:-1},/nonnegative/);

  const input=bundle(),before=structuredClone(input),evaluated=await C.evaluateBundle(input,{grid:128});
  assert.deepEqual(input,before);assert.deepEqual(evaluated.input,before);assert.notEqual(evaluated.input,input);
  assert.equal(evaluated.schema,C.REPORT_SCHEMA);assert.match(evaluated.input_sha256,/^[a-f0-9]{64}$/);
  assert.equal(evaluated.summary.independence_status,'eligible_under_declared_provenance');
  assert.equal((await C.evaluateBundle(input,{grid:128})).input_sha256,evaluated.input_sha256);
  assert.notEqual((await C.evaluateBundle(input,{grid:256})).input_sha256,evaluated.input_sha256);
  input.pairs[0].review_time={manual_minutes:12};
  assert.notEqual((await C.evaluateBundle(input)).input_sha256,evaluated.input_sha256,'Changed metadata invalidates report fingerprint');
  const changed=bundle();changed.pairs[0].prediction_rois[0].paths[0][0][0]+=1;
  assert.notEqual((await C.evaluateBundle(changed)).input_sha256,evaluated.input_sha256,'Changed original geometry invalidates report fingerprint');
  assert.equal(await C.fingerprint({b:2,a:1}),await C.fingerprint({a:1,b:2}),'Key ordering is canonical');
  assert.equal(await C.fingerprint({a:1,b:2}),'43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
  await assert.rejects(()=>C.evaluateBundle(bundle([pair(),pair()])),/Duplicate animal\/section/);
  const repeated=pair();repeated.section_id='s2';
  await assert.rejects(()=>C.evaluateBundle(bundle([pair(),repeated])),/same source image/);
  const different=stamp(pair(),'b','s2');different.model.version='2';
  await assert.rejects(()=>C.evaluateBundle(bundle([pair(),different])),/one frozen model/);
  const corrected=stamp(pair(),'b','s2');corrected.prediction_stage='human_corrected';
  await assert.rejects(()=>C.evaluateBundle(bundle([pair(),corrected])),/separate reports/);
  assert.ok((await C.evaluateBundle(bundle([corrected]))).warnings.some(w=>w.includes('not the raw model')));
  await assert.rejects(()=>C.evaluateBundle({...bundle(),schema:'wrong'}),/Unsupported/);
  await assert.rejects(()=>C.evaluateBundle({...bundle(),protocol_id:''}),/protocol ID/);
  await assert.rejects(()=>C.evaluateBundle(bundle([])),/1–500/);
  const prototype=JSON.parse('{"schema":"cerebellum-validation/1","__proto__":{}}');
  await assert.rejects(()=>C.evaluateBundle(prototype),/Unsafe/);
  await assert.rejects(()=>C.fingerprint({bad:NaN}),/non-finite/);
  const withStudy=bundle();withStudy.study=declared;
  assert.equal((await C.evaluateBundle(withStudy)).split_check.status,'eligible_under_declared_provenance');
  const inconsistent=structuredClone(withStudy);inconsistent.pairs[0].evaluation_split='train';
  await assert.rejects(()=>C.evaluateBundle(inconsistent),/split does not match/);
  inconsistent.pairs[0].evaluation_split='test';inconsistent.pairs[0].animal_id='unknown';
  await assert.rejects(()=>C.evaluateBundle(inconsistent),/animal is missing/);
  const wrongSource=structuredClone(withStudy);wrongSource.study.animals[1].sections[0].source.sha256=hash('c');
  await assert.rejects(()=>C.evaluateBundle(wrongSource),/source does not match/);

  // Execute the actual worker message handler without a DOM or hand-written duplicate evaluator.
  const replies=[],context=vm.createContext({importScripts:path=>assert.equal(path,'./validation_core.js'),ValidationCore:C,self:{postMessage:message=>replies.push(message)}});
  vm.runInContext(fs.readFileSync(require.resolve('../src/validation_worker.js'),'utf8'),context);
  await context.self.onmessage({data:{id:'run',operation:'evaluate',bundle:bundle(),options:{grid:128}}});
  assert.equal(replies[0].id,'run');assert.equal(replies[0].result.pairs[0].layers.CB.dice,1);
  await context.self.onmessage({data:{id:'split',operation:'splits',study:declared}});
  assert.equal(replies[1].result.status,'eligible_under_declared_provenance');
  await context.self.onmessage({data:{id:'error',operation:'bad'}});
  assert.match(replies[2].error,/Unsupported validation operation/);
  console.log('Validation core: analytical contours, grid caveats, missingness, leakage, animal denominators, fingerprints and Worker contract passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
