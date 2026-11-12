/* CSV linkage and unit checks. These compare numbers, not anatomical validity. */
'use strict';
const assert=require('node:assert/strict'),{webcrypto,createHash}=require('node:crypto');globalThis.crypto||=webcrypto;
const C=require('../src/analysis_core.js'),CSV=require('../src/analysis_csv_core.js'),source={name:'synthetic.tif',sha256:'a'.repeat(64),width:100,height:100};
const roi={id:'imagej-1',label:'CB',paths:[[[10,10],[30,10],[30,30],[10,30]]]};
let state=C.createFromROIs([roi],source,{kind:'imagej',files:[{name:'a.roi',sha256:'b'.repeat(64),size:128}],names:[{id:roi.id,name:'Original_CB_name'}]});
function parse(text){return CSV.parse(text,{name:'original.csv',size:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')});}
(async()=>{
 let reference=parse('ROI_Name,area_px2,area_um2,perimeter_um,Area,Note\r\nOriginal_CB_name,390,2400,,999,"=HYPERLINK(1)"\r\nUnknown,,8,4,,\r\n');
 assert.equal(reference.rows[0][3],'');assert.equal(reference.rows[0][5],'=HYPERLINK(1)');assert.equal(reference.rows[1][1],'');
 state=C.attachMeasurementCSV(state,reference);let compared=CSV.compare(reference,state,C.measure);assert.equal(compared[0].roi_id,roi.id);assert.equal(compared[0].values.length,3);assert.equal(compared[0].values[0].difference,10);assert.equal(compared[0].values[1].difference,null);assert.equal(compared[1].status,'unmatched');
 state=C.setMetadata(state,{animal_id:'a',section_id:'s',single_section_confirmed:true,um_per_pixel_x:2,um_per_pixel_y:3});compared=CSV.compare(reference,state,C.measure);assert.equal(compared[0].values[1].difference,0);assert.equal(compared[0].values[2].source_numeric,null);assert.equal(compared[0].values[2].difference,null);
 state=await C.approve(state,{reviewer:'r',protocol:'p',checked:true,coordinatesChecked:true});const exported=await C.exportApproved(state);assert.equal(exported.report.source_measurement_comparison[0].values[0].difference,10);
 const geometry=JSON.stringify(state.rois),original=JSON.stringify(state.original_prediction);state=C.attachMeasurementCSV(state,null);assert.equal(state.approval,null);assert.equal(JSON.stringify(state.rois),geometry);assert.equal(JSON.stringify(state.original_prediction),original);
 const duplicate=parse('Name,area_px2\nOriginal_CB_name,1\nOriginal_CB_name,2\n');assert(CSV.compare(duplicate,state,C.measure).every(r=>r.status==='ambiguous'));
 const generic=parse('Name,Area\nOriginal_CB_name,100\n');assert.equal(CSV.compare(generic,state,C.measure)[0].status,'no_explicit_units');
 const duplicateHeader=parse('Name,Name,area_px2\nOriginal_CB_name,Other,1\n');assert.equal(CSV.compare(duplicateHeader,state,C.measure)[0].status,'ambiguous');
 const absent=parse('Name,area_px2\nOriginal_CB_name\n');assert.equal(absent.rows[0].length,1);assert.equal(CSV.compare(absent,state,C.measure)[0].values[0].source_raw,null);
 const physical=parse('roi_id,Area (µm²),Perimeter (µm)\nimagej-1,2400,200\n');assert.equal(CSV.compare(physical,state,C.measure)[0].values[0].difference,0);
 const foreign=parse('Name,area_px2\nCB,4\n');assert.equal(CSV.compare(foreign,state,C.measure)[0].status,'unmatched');
 const strictID=parse('roi_id,area_px2\nOriginal_CB_name,400\n');assert.equal(CSV.compare(strictID,state,C.measure)[0].status,'unmatched');
 const consistent=parse('roi_id,ROI_Name,area_px2\nimagej-1,Original_CB_name,400\n');assert.equal(CSV.compare(consistent,state,C.measure)[0].values[0].difference,0);
 const second=C.addROI(state,{id:'other',label:'GL',paths:[[[40,40],[43,40],[43,43],[40,43]]]});
 const contradictory=parse('roi_id,ROI_Name,area_px2\nimagej-1,GL_other,9\n');assert.equal(CSV.compare(contradictory,second,C.measure)[0].status,'ambiguous');assert.equal(CSV.compare(contradictory,second,C.measure)[0].values[0].difference,null);
 const duplicateMetric=parse('Name,area_px2,Area (px²)\nOriginal_CB_name,400,400\n');assert(CSV.compare(duplicateMetric,state,C.measure)[0].values.every(v=>v.difference===null&&v.ambiguity==='duplicate_metric_columns'));
 console.log('PASS: exact CSV source cells/missingness, unambiguous ROI linkage, explicit units, no imported geometry override, calibration-aware comparison, ambiguous duplicates, approval invalidation and immutable original ROI evidence.');
})().catch(e=>{console.error(e);process.exitCode=1;});
