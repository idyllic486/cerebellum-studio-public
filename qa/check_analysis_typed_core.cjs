/* Synthetic contract regressions, not anatomical accuracy or model validation. */
'use strict';
const assert=require('node:assert/strict');
globalThis.crypto ||= require('node:crypto').webcrypto;
const C=require('../src/analysis_core.js'),R=require('../src/research_core.js'),CSV=require('../src/analysis_csv_core.js');
const copy=structuredClone,source={name:'synthetic.tif',sha256:'a'.repeat(64),width:100,height:100};
const file={name:'mixed.zip',sha256:'b'.repeat(64),size:100};
const square=[[0,0],[10,0],[10,10],[0,10]];
const area=(id,paths=[square],extra={})=>({id,label:'OTHER',kind:'area',closed:true,paths,...extra});
const input=rois=>C.createFromROIs(rois.map(r=>({...r,source_file:file.name,source_sha256:file.sha256})),source,{kind:'imagej',files:[file]});
async function approved(state){let s=C.setMetadata(state,{animal_id:'synthetic',section_id:'one',single_section_confirmed:true,um_per_pixel_x:2,um_per_pixel_y:3});if(C.qualityFlags(s).length)s=C.acknowledgeQC(s,'Synthetic geometry relationships inspected; no anatomical claim.');return C.approve(s,{reviewer:'Synthetic reviewer',protocol:'Typed geometry mechanics only',checked:true,coordinatesChecked:true});}
const near=(a,b)=>assert(Math.abs(a-b)<1e-7,`${a} != ${b}`);

(async()=>{
  const line={id:'pl',name:'PL_original',label:'PL',type:'polyline',kind:'polyline',closed:false,region:'lobule IV',paths:[[[1.25,2.5],[4.25,6.5],[10.25,6.5]]],style:{stroke_width_px:10,stroke_color_argb:0xff112233,fill_color_argb:0x80112233}};
  const point={id:'landmark',name:'LANDMARK_original',label:'LANDMARK',type:'point',kind:'point',closed:false,paths:[[[5.25,6.5],[8.75,10.5]]]};
  const s=input([area('generic',[square],{name:'GL+WM',type:'polygon'}),line,point]);
  const measured=C.measure(s.rois[1],{um_per_pixel_x:2,um_per_pixel_y:3});
  assert.equal(measured.length_px,11);near(measured.length_um,Math.hypot(6,12)+12);
  for(const key of ['area_px2','area_um2','perimeter_px','perimeter_um','point_count'])assert.equal(measured[key],null);
  const pointMeasure=C.measure(s.rois[2]);assert.equal(pointMeasure.point_count,2);for(const key of ['area_px2','area_um2','perimeter_px','perimeter_um','length_px','length_um'])assert.equal(pointMeasure[key],null);
  assert.deepEqual(C.measure({...s.rois[1],style:{stroke_width_px:100}}),C.measure(s.rois[1]));
  assert.equal(C.measure(s.rois[0]).area_px2,100);assert.equal(C.measure(s.rois[0]).length_px,null);
  const out=await C.exportApproved(await approved(s));
  assert.deepEqual(out.report.measurements[2].point_coordinates_px,point.paths[0]);assert.deepEqual(out.report.measurements[2].point_coordinates_um,[[10.5,19.5],[17.5,31.5]]);
  const csv=R.parseCSV(out.csv);assert.deepEqual(JSON.parse(csv.rows[2][csv.headers.indexOf('point_coordinates_px')]),point.paths[0]);
  for(let i=0;i<s.rois.length;i++){const raw=out.files[i].bytes,parsed=R.parseROI(raw,out.files[i].name);assert.equal(parsed.kind,s.rois[i].kind);assert.equal(parsed.name,s.rois[i].name);assert.deepEqual(parsed.paths,s.rois[i].paths);}
  const styleBytes=new DataView(out.files[1].bytes.buffer),h2=styleBytes.getInt32(60);assert.equal(styleBytes.getFloat32(h2+36),10);assert.equal(styleBytes.getUint32(40),0xff112233);assert.equal(styleBytes.getUint32(44),0x80112233);
  assert.equal(out.files[1].bytes[6],5);assert.equal(out.files[2].bytes[6],10);
  assert.equal(out.report.measurements[0].label,'OTHER');assert.equal(out.report.measurements[0].original_name,'GL+WM');
  assert.equal(out.report.measurements[1].region,'lobule IV');
  // Selected downloads remain a view of the current full approval, without
  // changing the state or summing overlapping parent/layer areas.
  const approvedMixed=await approved(s),prior=JSON.stringify(approvedMixed);
  const lineOnly=await C.exportApproved(approvedMixed,{roiIds:['pl']});
  assert.equal(JSON.stringify(approvedMixed),prior);assert.deepEqual(lineOnly.report.export_scope.roi_ids,['pl']);
  assert.equal(lineOnly.report.analysis.rois.length,3);assert.equal(lineOnly.report.measurements.length,1);
  assert.equal(lineOnly.files.length,1);assert.equal(R.parseROI(lineOnly.files[0].bytes).kind,'polyline');
  assert.deepEqual(R.parseROI(lineOnly.files[0].bytes).paths,line.paths);
  const result=R.parseCSV(lineOnly.resultCSV),value=name=>result.rows[0][result.headers.indexOf(name)];
  assert.equal(value('metric'),'open_length');assert.equal(value('value'),'11');assert.equal(value('unit'),'px');
  assert.equal(value('physical_unit'),'um');near(Number(value('physical_value')),Math.hypot(6,12)+12);
  assert.equal(value('source_sha256'),source.sha256);assert.equal(value('approval_fingerprint'),approvedMixed.approval.fingerprint);
  const missingScale=await C.approve(C.setMetadata(approvedMixed,{um_per_pixel_x:null,um_per_pixel_y:null}),{reviewer:'r',protocol:'Unknown physical scale retained',checked:true,coordinatesChecked:true});
  const missingResult=R.parseCSV((await C.exportApproved(missingScale,{roiIds:['pl']})).resultCSV);
  assert.equal(missingResult.rows[0][missingResult.headers.indexOf('physical_value')],'');assert.equal(missingResult.rows[0][missingResult.headers.indexOf('physical_unit')],'');
  for(const roiIds of [[],['missing'],['pl','pl']])await assert.rejects(C.exportApproved(approvedMixed,{roiIds}),/existing, distinct/);
  const modified=copy(approvedMixed);modified.rois[0].paths[0][0][0]=1;await assert.rejects(C.exportApproved(modified,{roiIds:['pl']}),/approval/);
  const text='Name,length_px,Length (µm),point_count,Length\nPL_original,11,25.41640786499874,,11\nLANDMARK_original,,,2,0\n';
  const reference=CSV.parse(text,{name:'source.csv',sha256:'c'.repeat(64),size:text.length});
  const compared=CSV.compare(reference,out.report.analysis,C.measure);assert.equal(compared[0].status,'compared');assert.equal(compared[0].values.length,3);assert.equal(compared[0].values[0].difference,0);near(compared[0].values[1].difference,0);assert.equal(compared[1].values[2].difference,0);
  const excluded=await approved(C.setExclusion(s,'landmark',true,'Synthetic exclusion'));const excludedOut=await C.exportApproved(excluded);assert.equal(excludedOut.files.length,2);assert.equal(excludedOut.report.measurements[2].point_coordinates_px,null);assert.equal(excludedOut.report.measurements[2].point_count,null);
  const excludedOnly=await C.exportApproved(excluded,{roiIds:['landmark']});assert.equal(excludedOnly.files.length,0);assert.equal(excludedOnly.report.measurements[0].status,'excluded');const excludedResult=R.parseCSV(excludedOnly.resultCSV);assert.equal(excludedResult.rows[0][excludedResult.headers.indexOf('value')],'');
  assert.throws(()=>C.create({schema:C.PREDICTION_SCHEMA,source,model:{id:'fixture',version:'1',weights_sha256:'d'.repeat(64)},rois:[line]},source),/Prediction labels/);
  assert.throws(()=>C.create({schema:C.PREDICTION_SCHEMA,source,model:{id:'fixture',version:'1',weights_sha256:'d'.repeat(64)},rois:[{...area('cb'),label:'CB',geometry_profile:'imagej-evenodd\/1'}]},source),/geometry profile/);
  for(const label of ['PL','FISSURE','LANDMARK'])await assert.rejects(approved(input([area('bad-role',[square],{label})])),/Correct the geometry label/);
  await assert.rejects(approved(input([{...line,label:'CB'}])),/Correct the geometry label/);
  assert.throws(()=>C.createFromROIs([area('too-many',[Array.from({length:5001},(_,i)=>[50+20*Math.cos(i*2*Math.PI/5001),50+20*Math.sin(i*2*Math.PI/5001)])])],source),/at most 5000/);

  // Exact even-odd areas for source contours: touching, crossing and retraced
  // paths retain all coordinates, unlike a repair or polygon simplification.
  const cases=[
    {name:'bowtie',paths:[[[0,0],[10,10],[0,10],[10,0]]],expected:50},
    {name:'touching',paths:[[[0,0],[10,0],[10,10],[0,10],[0,0],[0,20],[10,20],[10,10],[0,10]]],expected:200},
    {name:'hole',paths:[square,[[2,2],[8,2],[8,8],[2,8]]],expected:64},
    {name:'duplicate',paths:[square,square],expected:0},
    {name:'closing',paths:[[...square,square[0]]],expected:100},
    {name:'overlap',paths:[square,[[5,0],[15,0],[15,10],[5,10]]],expected:100},
  ];
  for(const fixture of cases){const state=input([area(fixture.name,fixture.paths,{type:'composite',name:fixture.name})]);assert.deepEqual(state.rois[0].paths,fixture.paths);near(C.measure(state.rois[0]).area_px2,fixture.expected);const result=await C.exportApproved(await approved(state));const parsed=R.parseROI(result.files[0].bytes);assert.deepEqual(parsed.paths,fixture.paths);const reloaded=input([{...parsed,id:fixture.name,label:'OTHER'}]);near(C.measure(reloaded.rois[0]).area_px2,fixture.expected);}
  // An edited rectangle may no longer be a rectangle despite the same corners.
  const crossed=input([area('edited',[cases[0].paths[0]],{type:'rectangle',name:'edited'})]);const crossedOut=await C.exportApproved(await approved(crossed));assert(crossedOut.files[0].bytes[36]||new DataView(crossedOut.files[0].bytes.buffer).getInt32(36)>0);assert.deepEqual(R.parseROI(crossedOut.files[0].bytes).paths,cases[0].paths);
  const collision=input([area('id1',[square],{name:'x'}),area('id2',[square],{name:'x_id3'}),area('id3',[square],{name:'x'}),area('id4',[square],{name:'X'})]);const collidingOut=await C.exportApproved(await approved(collision));assert.equal(new Set(collidingOut.files.map(f=>f.name.toLowerCase())).size,4);assert.deepEqual(collidingOut.files.map(f=>R.parseROI(f.bytes).name),['x','x_id3','x','X']);

  const cb=input([area('cb1',[square],{label:'CB'}),area('cb2',[[[5,0],[15,0],[15,10],[5,10]]],{label:'CB'})]);assert(C.qualityFlags(cb).some(f=>f.code==='cb_overlap'));const nested=input([area('cb1',[square],{label:'CB'}),area('ml',[[[2,2],[8,2],[8,8],[2,8]]],{label:'ML'})]);assert(!C.qualityFlags(nested).length);
  const complete=copy(await approved(s));complete.approval=null;complete.history=Array.from({length:1000},(_,i)=>({type:'retained_fixture',at:'2026-11-04T00:00:00Z',detail:{sequence:i}}));
  let restored=C.importDraft(complete,source);assert.deepEqual(restored.history_checkpoints[0].events,complete.history);assert.equal(restored.history.at(-1).type,'reopen_draft');restored=await approved(restored);const retained=await C.exportApproved(restored);assert.deepEqual(retained.report.analysis.history_checkpoints[0].events,complete.history);
  const corrupt=copy(restored);corrupt.history_checkpoints[0].events[0].detail.sequence=999;await assert.rejects(C.exportApproved(corrupt),/approval/);
  const many=copy(complete);many.history_checkpoints=Array.from({length:100},()=>({at:'2026-11-04T00:00:00Z',events:[{type:'retained',detail:{}}]}));assert.equal(C.importDraft(many,source).history_checkpoints.length,101);

  const original=copy(s.original_prediction);assert.throws(()=>C.removeSourceFile(s,{...file,roi_ids:['pl']}),/all ROIs/);
  let removed=C.deleteROI(C.attachMeasurementCSV(s,reference),'landmark','Synthetic prior deletion');removed=C.removeSourceFile(removed,{...file,roi_ids:['generic','pl','landmark']});assert.equal(removed.rois.length,0);assert.equal(removed.editor.past.length,0);assert.deepEqual(removed.original_prediction,original);assert.deepEqual(removed.measurement_reference,reference);assert.throws(()=>C.undo(removed),/No edit/);
  const invalidDetached=copy(s);invalidDetached.detached_sources=[{name:file.name,sha256:file.sha256,roi_ids:[]}];assert.throws(()=>C.importDraft(invalidDetached,source),/active derived/);
  // Extended coordinate count is native ImageJ encoding, never a downsample.
  const points=Array.from({length:65536},(_,i)=>[i%100,Math.floor(i/100)%100]);const large=input([{...point,paths:[points]}]);const largeOut=await C.exportApproved(await approved(large));assert.equal(new DataView(largeOut.files[0].bytes.buffer).getUint16(16),0);assert.equal(new DataView(largeOut.files[0].bytes.buffer).getInt32(18),65536);assert.deepEqual(R.parseROI(largeOut.files[0].bytes).paths,[points]);
  console.log('PASS: mixed area/line/point contracts, anisotropic open lengths and point coordinates, native ImageJ types/styles/names, exact even-odd source geometry, collision-safe files, explicit CSV roles, CB overlap, complete checkpoint history and source detachment. Synthetic only.');
})().catch(error=>{console.error(error);process.exitCode=1;});
