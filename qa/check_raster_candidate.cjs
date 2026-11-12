/* Synthetic scientific-contract checks for explicit approximate candidates. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const Candidate=require('../src/raster_candidate_core.js'),Analysis=require('../src/analysis_core.js');
const report={passed:false,synthetic_data:true,real_nissl_accuracy_tested:false,checks:[]};
const record=name=>{report.checks.push(name);console.log(name);};
const classes=['background','CB'];
function image(width,height,fn){return Uint8Array.from({length:width*height},(_,i)=>fn(i%width,Math.floor(i/width)));}
function inside(x,y,path){let found=false;for(let i=0,j=path.length-1;i<path.length;j=i++){const a=path[i],b=path[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])found=!found;}return found;}
function verifyGeometry(result,labels,width,height,mapping){
 const prediction={schema:'cerebellum-prediction/1',source:{name:'synthetic.tif',sha256:'1'.repeat(64),width,height},model:{id:'synthetic',version:'1',weights_sha256:'2'.repeat(64)},rois:result.rois};
 Analysis.validatePrediction(prediction,prediction.source);
 const counts=Object.fromEntries(mapping.map(c=>[c,0])),transitions=mapping.map(()=>new Array(mapping.length).fill(0));let changes=0;
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const matches=result.rois.filter(r=>r.paths.reduce((n,p)=>n+Number(inside(x+0.5,y+0.5,p)),0)%2);assert.ok(matches.length<=1,'Candidates from a single exclusive class map overlap.');
  const value=matches.length?mapping.indexOf(matches[0].metadata?.model_class||matches[0].label):0;assert.ok(value>=0);counts[mapping[value]]++;transitions[labels[y*width+x]][value]++;if(labels[y*width+x]!==value)changes++;
 }
 assert.deepEqual(counts,result.processing.candidate_pixel_counts);assert.deepEqual(transitions,result.processing.transition_pixel_counts);assert.equal(changes,result.processing.changed_pixels);
 assert.equal(Object.values(result.processing.source_pixel_counts).reduce((a,b)=>a+b,0),width*height);
 for(let c=0;c<mapping.length;c++)assert.equal(transitions[c].reduce((a,b)=>a+b,0),result.processing.source_pixel_counts[mapping[c]]);
}
try{
 const noisy=image(25,25,(x,y)=>Number(x<24&&y<24&&!(x>=8&&x<16&&y>=8&&y<16)));noisy[1*25+1]=0;noisy[9*25+9]=1;const original=Uint8Array.from(noisy);
 const smooth=Candidate.create(noisy,25,25,classes);assert.deepEqual(noisy,original);assert.equal(smooth.processing.changed_pixels,2);assert.equal(smooth.rois.length,1);assert.equal(smooth.rois[0].paths.length,2);assert.equal(smooth.counts.CB,512);assert.equal(smooth.processing.minimum_component_pixels,0);verifyGeometry(smooth,noisy,25,25,classes);
 record('Explicit approximation retains the hole, records exact changed pixels and leaves native evidence unchanged');
 const edge=image(19,17,()=>1),clipped=Candidate.create(edge,19,17,classes);assert.equal(clipped.counts.CB,323);assert.equal(clipped.processing.changed_pixels,0);assert.ok(clipped.rois[0].paths[0].some(p=>p[0]===19));assert.ok(clipped.rois[0].paths[0].some(p=>p[1]===17));verifyGeometry(clipped,edge,19,17,classes);
 record('Odd-sized edge cells use actual native pixels and clipped native coordinates');
 const ties=image(16,8,(x,y)=>x>=8||y>=4?1:0),tie=Candidate.create(ties,16,8,classes);assert.equal(tie.counts.CB,64);assert.equal(tie.processing.changed_pixels,32);verifyGeometry(tie,ties,16,8,classes);
 const multiclasses=['background','ML','GL','WM'],multi=image(16,8,(x,y)=>x>=8?3:y<4?1:2),multicandidate=Candidate.create(multi,16,8,multiclasses);assert.deepEqual(multicandidate.counts,{ML:64,GL:0,WM:64});assert.equal(multicandidate.processing.changed_pixels,32);verifyGeometry(multicandidate,multi,16,8,multiclasses);
 record('Ties resolve reproducibly to background then declared class order; per-class transitions match geometry');
 const lobuleClasses=['background','LOBULE_Crus1','LOBULE_Crus2'],lobules=image(19,17,x=>x<8?1:2),regions=Candidate.create(lobules,19,17,lobuleClasses);assert.equal(regions.rois[0].metadata.anatomy_scope,'ML+GL annotated cortical subregions; not whole lobule');assert.equal(regions.rois[0].label,'OTHER');assert.equal(regions.rois[0].region,'Crus1');assert.equal(regions.rois[0].metadata.candidate_block_size_px,8);verifyGeometry(regions,lobules,19,17,lobuleClasses);
 record('Optional cortical-region candidates preserve exact region identity and restricted anatomy scope');
 const components=image(24,24,(x,y)=>Number(y<8&&x<16||y>=16&&x>=16)),all=Candidate.create(components,24,24,classes),filtered=Candidate.create(components,24,24,classes,{minComponentPixels:65});assert.equal(all.rois.length,2);assert.equal(all.processing.removed_component_count,0);assert.equal(filtered.rois.length,1);assert.equal(filtered.processing.removed_component_count,1);assert.equal(filtered.processing.removed_component_pixels,64);assert.equal(filtered.processing.changed_pixels,64);assert.equal(filtered.counts.CB,128);verifyGeometry(filtered,components,24,24,classes);
 record('Small components stay by default; opt-in filtering records their count and exact native area');
 for(const blockSize of [8,16,32]){const p=Candidate.create(edge,19,17,classes,{blockSize});assert.equal(p.counts.CB,323);verifyGeometry(p,edge,19,17,classes);}
 record('All supported block sizes preserve units and native image extent');
 const layered=image(19,17,(x,y)=>x<8?1:2),lineCandidate=Candidate.create(layered,19,17,multiclasses,{includePL:true});
 assert.equal(lineCandidate.pl_candidate.rois.length,1);assert.equal(lineCandidate.pl_candidate.edge_count,3);assert.equal(lineCandidate.pl_candidate.total_length_px,17);assert.equal(lineCandidate.pl_candidate.block_size_px,8);assert.equal(lineCandidate.pl_candidate.rois[0].kind,'polyline');assert.equal(lineCandidate.pl_candidate.rois[0].closed,false);assert.equal(lineCandidate.pl_candidate.rois[0].metadata.purkinje_identity_established,false);assert.equal(lineCandidate.pl_candidate.rois[0].metadata.candidate_block_size_px,8);assert.equal(lineCandidate.rois.some(r=>r.label==='PL'),false);assert.equal(Candidate.create(layered,19,17,multiclasses).pl_candidate,null);
 const noInterface=Candidate.create(image(8,8,()=>1),8,8,multiclasses,{includePL:true});assert.equal(noInterface.pl_candidate.rois.length,0);assert.equal(noInterface.pl_candidate.total_length_px,0);assert.match(noInterface.pl_candidate.status,/no ML/);assert.throws(()=>Candidate.create(edge,19,17,classes,{includePL:true}),/require background/);
 const lineSource={name:'synthetic.tif',sha256:'1'.repeat(64),width:19,height:17};Analysis.validatePrediction({schema:'cerebellum-prediction/1',source:lineSource,model:{id:'synthetic',version:'1',weights_sha256:'2'.repeat(64)},rois:[...lineCandidate.rois,...lineCandidate.pl_candidate.rois]},lineSource);
 record('Optional PL review aid remains a separate open ML–GL interface with clipped native lengths and no Purkinje identity claim');
 const pinchGrid=[1,1,1,1,0,1,0,1,1],pinch=image(24,24,(x,y)=>pinchGrid[Math.floor(y/8)*3+Math.floor(x/8)]),before=Uint8Array.from(pinch);assert.throws(()=>Candidate.create(pinch,24,24,classes),/pinch/);assert.deepEqual(pinch,before);
 const islands=image(200,200,(x,y)=>Number(Math.floor(x/8)%2===0&&Math.floor(y/8)%2===0));assert.throws(()=>Candidate.create(islands,200,200,classes),/64 connected/);
 assert.throws(()=>Candidate.create(new Uint8Array(64),8,8,classes),/background only/);assert.throws(()=>Candidate.create(edge,19,17,classes,{blockSize:2}),/8, 16 or 32/);assert.throws(()=>Candidate.create(edge,19,17,classes,{minComponentPixels:-1}),/valid minimum/);assert.throws(()=>Candidate.create(new Uint8Array([2]),1,1,classes),/Unknown native/);
 record('Invalid topology, excessive islands, background-only and unsupported options reject without partial or fabricated ROIs');
 report.passed=true;
}catch(error){report.error=String(error.stack||error);console.error(error);process.exitCode=1;}
finally{fs.writeFileSync(path.join(__dirname,'raster-candidate.json'),JSON.stringify(report,null,2)+'\n');}
