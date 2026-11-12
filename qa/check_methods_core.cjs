const assert=require('node:assert/strict');
const M=require('../src/methods_core.js');
const square=(x=0,y=0,w=10,h=w)=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
const section=(id,z,paths=[square()])=>({id,order:z,z,paths});
const same={unit:'index',sections:[section('a',0),section('b',2),section('c',4)]};
const frozen=JSON.stringify(same),result=M.run(same,{includeFoldMasks:true});
assert.equal(JSON.stringify(same),frozen,'The observed source must not be mutated.');
assert.equal(result.folds.length,1);assert.equal(result.folds[0].held_out,'b');
assert.deepEqual(result.folds[0].training_ids,['a','c']);
for(const name of ['sdf','affine']){assert.equal(result.folds[0].scores[name].dice,1);assert.equal(result.folds[0].scores[name].iou,1);assert.equal(result.folds[0].scores[name].area_error,0);}
assert.equal(result.candidates.length,2);assert.deepEqual(result.candidates.map(c=>c.z),[1,3]);
for(const c of result.candidates){assert.equal(c.disagreement,0);assert.equal(c.score,c.gap*.25);assert.deepEqual(c.masks.sdf,c.masks.affine);}
for(const o of result.observations){assert.ok(o.area_interval[0]<o.area);assert.ok(o.area<o.area_interval[1]);assert.equal(o.boundary_perturbation.interpretation,'parameter_sensitivity_not_confidence_interval');}
assert.deepEqual(M.run(same,{includeFoldMasks:true}),result,'Results must be deterministic.');

const changed=structuredClone(same);changed.sections[1].paths=[square(30)];
const outside=M.run(changed,{targetZ:[],includeFoldMasks:true}).folds[0];
assert.equal(outside.prediction_fingerprint,result.folds[0].prediction_fingerprint,'Held-out position must not change the prediction checksum.');
assert.deepEqual(outside.grid,result.folds[0].grid);assert.deepEqual(outside.masks,result.folds[0].masks);
assert.equal(outside.scores.sdf.dice,0);assert.equal(outside.scores.sdf.iou,0);
assert.ok(outside.truth_outside_count>0);assert.equal(outside.scores.sdf.false_negative,outside.scores.sdf.truth_count);
changed.sections[1].paths=[square(100000)];
const unscorable=M.run(changed,{targetZ:[]}).folds[0];
assert.equal(unscorable.prediction_fingerprint,result.folds[0].prediction_fingerprint);
assert.equal(unscorable.status,'unscorable');assert.equal(unscorable.scores,null);assert.match(unscorable.reason,/evaluation_grid/);

const unequal={unit:'um',sections:[{...section('a',0,[square()]),order:0},{...section('b',1,[square(1)]),order:1},{...section('c',10,[square(10)]),order:2}]};
const uneven=M.run(unequal,{targetZ:[2.5],includeFoldMasks:true});
assert.equal(uneven.folds[0].fraction,.1);assert.ok(uneven.folds[0].scores.affine.dice>.95);
assert.equal(uneven.candidates[0].fraction,(2.5-1)/(10-1));
const scaled={unit:'index',sections:[section('a',0,[square(-3,-6,6,12)]),section('b',2,[square(-6,-4.5,12,9)]),section('c',4,[square(-9,-3,18,6)])]};
const scaling=M.run(scaled,{targetZ:[],includeFoldMasks:true});
assert.ok(scaling.folds[0].scores.affine.dice>.95,'Axis-scale interpolation should recover the analytic graded rectangle.');
// Independent brute-force distances verify the optimized EDT interpolation,
// rather than only checking the trivial identical-mask case.
const varying={unit:'index',sections:[section('a',0,[square(0,0,8)]),section('b',2,[square(1,1,9)]),section('c',6,[square(4,2,10)])]};
const vf=M.run(varying,{gridSize:32,targetZ:[],includeFoldMasks:true}).folds[0],vg=vf.grid;
const rectMask=(x,y,w)=>Array.from({length:32*32},(_,i)=>{const xx=vg.origin[0]+(i%32+.5)*vg.spacing,yy=vg.origin[1]+(Math.floor(i/32)+.5)*vg.spacing;return xx>=x&&xx<x+w&&yy>=y&&yy<y+w?1:0;});
const va=rectMask(0,0,8),vb=rectMask(4,2,10);
function brute(mask,i){let d=Infinity;for(let j=0;j<mask.length;j++)if(mask[j]!==mask[i])d=Math.min(d,(i%32-j%32)**2+(Math.floor(i/32)-Math.floor(j/32))**2);return Math.sqrt(d)*(mask[i]?1:-1);}
assert.deepEqual(vf.masks.sdf,va.map((_,i)=>(1-vf.fraction)*brute(va,i)+vf.fraction*brute(vb,i)>=0?1:0),'Optimized SDF must equal independent brute-force Euclidean distances.');

const donut={unit:'index',sections:[0,2,4].map((z,i)=>section('d'+i,z,[square(),square(3,3,4)]))};
const hole=M.run(donut,{includeFoldMasks:true});
assert.equal(hole.observations[0].topology.holes,1);
assert.equal(hole.candidates[0].topology.sdf.holes,1);
assert.equal(hole.folds[0].scores.sdf.dice,1);
const union={unit:'index',sections:[0,2,4].map((z,i)=>({id:'u'+i,order:z,z,rois:[{paths:[square()]},{paths:[square(5)]}]}))};
const merged=M.run(union,{includeFoldMasks:true});const g=merged.folds[0].grid;
const x=Math.floor((7.5-g.origin[0])/g.spacing),y=Math.floor((5-g.origin[1])/g.spacing);
assert.equal(merged.folds[0].truth_mask[y*g.width+x],1,'Overlapping separate ROIs are unioned, never XORed.');
assert.equal(merged.folds[0].scores.affine.dice,1);

assert.throws(()=>M.run({...same,sections:same.sections.slice(0,2)}),/3–24/);
assert.throws(()=>M.run(same,{gridSize:128}),/32–96/);
assert.throws(()=>M.run(same,{targetZ:[-1]}),/Extrapolation/);
assert.throws(()=>M.run(same,{targetZ:[1.5]}),/integer/);
assert.throws(()=>M.run(same,{targetZ:[2]}),/unobserved/);
const duplicate=structuredClone(same);duplicate.sections[1].z=0;assert.throws(()=>M.run(duplicate),/unique/);
const nullPhysical=structuredClone(unequal);nullPhysical.sections[1].z=null;assert.throws(()=>M.run(nullPhysical),/missing/);
const zero={unit:'index',sections:[0,2,4].map((z,i)=>section('z'+i,z,[[[0,0],[1,0],[2,0]]]))};assert.throws(()=>M.run(zero),/zero area/);
const touching={unit:'index',sections:[0,1,2].map((z,i)=>section('t'+i,z))};assert.equal(M.run(touching).candidates.length,0,'Adjacent integer indices have no unobserved integer candidate.');
const tiny={unit:'index',sections:[0,2,4].map((z,i)=>section('tiny'+i,z,[square(0,0,1e-170)]))};assert.throws(()=>M.run(tiny),/numerical range/);
const clipped={unit:'index',sections:[{id:'l',order:0,z:0,rois:[{paths:[square(0,0,20)]},{paths:[square(50,0,2)]}]},section('m',2,[square(0,0,100)]),section('r',4,[square(0,0,100)])]};
const clip=M.run(clipped,{gridSize:96,targetZ:[1]});assert.ok(clip.candidates[0].flags.includes('aligned_source_outside_prediction_grid'),'Clipped affine source must be explicit even if the final mask misses the grid edge.');
console.log('MethodsCore: deterministic SDF/affine, no held-out geometry leakage, outside-grid false negatives/unscorable limit, uneven z, holes/ROI unions, perturbation intervals and limits passed.');
