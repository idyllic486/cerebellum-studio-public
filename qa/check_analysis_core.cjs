/* Synthetic geometry and workflow checks; these are not Nissl accuracy tests. */
const assert = require('node:assert/strict');
const {webcrypto} = require('node:crypto');
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const C = require('../src/analysis_core.js');
const R = require('../src/research_core.js');
const source = {sha256:'a'.repeat(64),name:'synthetic.tif',width:100,height:80};
const prediction = () => ({schema:C.PREDICTION_SCHEMA,source:{...source},model:{id:'synthetic-only',version:'1',weights_sha256:'b'.repeat(64)},processing:{fixture:true},rois:[
  {id:'outer',label:'CB',paths:[[[10,10],[30,10],[30,30],[10,30]],[[15,15],[20,15],[20,20],[15,20]]]},
  {id:'second',label:'ML',paths:[[[40,10],[50,10],[50,20],[40,20]]]},
]});
const copy = value => JSON.parse(JSON.stringify(value));
const checkInvalid = modify => {const p=prediction();modify(p);assert.throws(()=>C.create(p,source));};
(async()=>{
  const p=prediction(),state=C.create(p,source);
  assert.deepEqual(state.original_prediction,p);assert(Object.isFrozen(state.rois[0].paths[0]));
  assert.equal(state.metadata.um_per_pixel_x,null);assert.equal(state.metadata.z_um,null);
  assert.deepEqual(C.measure(state.rois[0],state.metadata),{area_px2:375,perimeter_px:100,area_um2:null,perimeter_um:null,length_px:null,length_um:null,point_count:null});
  assert.equal(C.measure(state.rois[0],{um_per_pixel_x:2,um_per_pixel_y:3}).area_um2,2250);
  assert.equal(C.measure(state.rois[0],{um_per_pixel_x:2,um_per_pixel_y:3}).perimeter_um,250);
  assert.equal(C.measure(state.rois[0],{um_per_pixel_x:2,um_per_pixel_y:null}).area_um2,null);
  await assert.rejects(C.exportApproved(state),/approval/);
  // The unapproved draft can leave as ImageJ ROI files: the same bytes an approved export writes, without approval or measurements.
  const draftFiles=C.exportDraftROIs(state);assert.equal(draftFiles.approved,false);assert.equal(draftFiles.status,'draft-not-approved');assert.equal(draftFiles.files.length,state.rois.filter(r=>r.included).length);assert.equal(draftFiles.source_sha256,state.source.sha256);
  assert.ok(draftFiles.files.every(f=>/\.roi$/.test(f.name)&&f.bytes.length>64&&String.fromCharCode(...f.bytes.slice(0,4))==='Iout'));assert.deepEqual(Object.keys(draftFiles).sort(),['approved','files','roi_count','source_sha256','status']);
  assert.equal(C.exportDraftROIs(state,{roiIds:[state.rois[0].id]}).files.length,1);assert.throws(()=>C.exportDraftROIs(state,{roiIds:['none']}),/existing/);assert.throws(()=>C.exportDraftROIs(state,{other:1}),/Invalid/);
  await assert.rejects(C.approve(state,{reviewer:'Reviewer',protocol:'Inspect every contour',checked:false}),/confirmation/);
  await assert.rejects(C.approve(state,{reviewer:'Reviewer',protocol:'Inspect every contour',checked:true}),/one section/);
  checkInvalid(x=>x.source.sha256='c'.repeat(64));checkInvalid(x=>x.source.width=101);
  checkInvalid(x=>x.model.weights_sha256='unknown');checkInvalid(x=>x.model.version='');
  checkInvalid(x=>x.rois[1].id='outer');checkInvalid(x=>x.rois[0].label='PL');
  checkInvalid(x=>x.rois[0].paths[0][0]=[-1,10]);checkInvalid(x=>x.rois[0].paths[0][0]=[NaN,10]);
  checkInvalid(x=>x.rois[0].paths=[[[10,10],[30,30],[10,30],[30,10]]]);
  checkInvalid(x=>x.rois[0].paths=[[[10,10],[30,10],[20,10],[30,30],[10,30]]]);
  checkInvalid(x=>x.rois[0].paths[1]=[[10,15],[20,15],[20,20],[10,20]]);
  checkInvalid(x=>x.rois[0].paths[1]=[[20,20],[40,20],[40,40],[20,40]]);
  checkInvalid(x=>x.rois[0].paths[0].push([10,10],[10,10]));
  checkInvalid(x=>x.rois[0].included=false);
  assert.throws(()=>C.setMetadata(state,{thickness_um:0}),/Invalid/);
  assert.throws(()=>C.setMetadata(state,{um_per_pixel_x:-1}),/Invalid/);
  assert.throws(()=>C.setMetadata(state,{z_um:'3'}),/Invalid/);
  assert.throws(()=>C.setMetadata(state,{unknown:'silently ignored'}),/Unsupported/);
  assert.throws(()=>C.setMetadata(state,JSON.parse('{"__proto__":"invalid"}')),/Unsupported/);
  assert.throws(()=>C.setMetadata(state,{toString:'invalid'}),/Unsupported/);
  assert.throws(()=>C.setExclusion(state,'second',true,''),/reason/);
  let reviewed=C.setMetadata(state,{animal_id:'synthetic-1',section_id:'s1',single_section_confirmed:true,um_per_pixel_x:2,um_per_pixel_y:3,z_um:-12.5});
  reviewed=C.setExclusion(reviewed,'second',true,'Torn tissue; excluded by protocol');
  const approved=await C.approve(reviewed,{reviewer:'Fixture reviewer',protocol:'Synthetic contours, metadata and exclusions inspected',checked:true});
  assert.equal(approved.approval.fingerprint,await C.fingerprint(approved));
  const out=await C.exportApproved(approved);
  assert.equal(out.files.length,1);assert.equal(out.files[0].name,'CB_outer.roi');
  const parsed=R.parseROI(out.files[0].bytes,out.files[0].name);
  assert.deepEqual(parsed.paths,approved.rois[0].paths);
  assert.equal(C.measure(parsed,approved.metadata).area_um2,2250);
  const csv=R.parseCSV(out.csv);
  assert.equal(csv.rows.length,2);
  const rows=out.csv.trim().split('\r\n').map(r=>r.split(','));const area=rows[0].indexOf('area_um2'),z=rows[0].indexOf('z_um'),thickness=rows[0].indexOf('thickness_um');
  assert.equal(rows[1][area],'2250');assert.equal(rows[2][area],'');assert.equal(rows[1][z],'-12.5');assert.equal(rows[1][thickness],'');
  assert.equal(out.report.analysis.rois[1].exclusion_reason,'Torn tissue; excluded by protocol');
  assert.deepEqual(out.report.analysis.original_prediction,p);
  const changed=C.editVertex(approved,'outer',0,0,[9.123456789,10]);
  assert.equal(changed.approval,null);assert.equal(changed.rois[0].paths[0][0][0],Math.fround(9.123456789));
  assert.equal(approved.rois[0].paths[0][0][0],10);
  assert.deepEqual(changed.original_prediction,p);
  await assert.rejects(C.exportApproved(changed),/approval/);
  const forged=copy(changed);forged.approval=copy(approved.approval);await assert.rejects(C.exportApproved(forged),/approval/);
  for(const [key,value] of [['reviewer','Impersonated reviewer'],['protocol','Different protocol'],['at','2000-01-01T00:00:00Z'],['identity','Verified institutional identity']]) {
    const tampered=copy(approved);tampered.approval[key]=value;await assert.rejects(C.exportApproved(tampered),/Approval metadata/);
  }
  const changedMetadata=C.setMetadata(approved,{z_um:null});assert.equal(changedMetadata.approval,null);
  const changedExclusion=C.setExclusion(approved,'second',false);assert.equal(changedExclusion.approval,null);assert.equal(changedExclusion.rois[1].exclusion_reason,'');
  const reopened=C.importDraft(copy(approved),source);assert.equal(reopened.approval,null);assert.equal(reopened.history.at(-1).detail.previous_approval.fingerprint,approved.approval.fingerprint);
  assert.throws(()=>C.importDraft(copy(approved),{...source,sha256:'d'.repeat(64)}),/match/);
  const corrupt=copy(approved);corrupt.model.id='changed';assert.throws(()=>C.importDraft(corrupt,source),/provenance/);
  const nested=prediction();nested.rois[0].paths.push([[16,16],[19,16],[19,19],[16,19]]);const island=C.create(nested,source);assert.equal(C.measure(island.rois[0]).area_px2,384);
  const fractional=prediction();fractional.rois[0].paths=[[[1.123456789,2.123456789],[5.987654321,2.123456789],[5.987654321,7.123456789]]];
  let f=C.create(fractional,source);f=C.setMetadata(f,{animal_id:'a',section_id:'b',single_section_confirmed:true});f=C.acknowledgeQC(f,'Synthetic ML outside CB: screening acknowledgement only');f=await C.approve(f,{reviewer:'r',protocol:'p',checked:true});const fe=await C.exportApproved(f),fr=R.parseROI(fe.files[0].bytes);
  assert.deepEqual(fr.paths,f.rois[0].paths);assert.deepEqual(C.measure(fr,f.metadata),C.measure(f.rois[0],f.metadata));
  // Missing scale produces empty physical cells, never zero or invented units.
  assert.equal(fe.report.measurements[0].area_um2,null);assert.equal(fe.report.measurements[0].z_um,null);
  assert.equal(state.history.length,0);assert.equal(state.approval,null);
  console.log('Analysis core passed: original identity, topology/holes, physical units, Float32 ImageJ round-trip, exclusions and approval invalidation (synthetic only).');
})().catch(error=>{console.error(error);process.exitCode=1;});
