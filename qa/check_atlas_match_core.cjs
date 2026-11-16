/* The browser port of the atlas match recovers a known plane and a known movement, and agrees with itself. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const M=require('../src/atlas_match_core.js'),root=path.resolve(__dirname,'..');
assert.deepEqual(M.sectionLobules([{name:'GL_4-5Cb_part1'},{name:'ML_4-5Cb_part1'},{name:'PL_FI_part1'},{name:'GL_TOTAL'},{name:'FISSURE_icf'},{name:'GL_Sim_part2'}]),['4/5Cb','Fl','Sim']);
assert.deepEqual(M.plateLobules({labels:['4/5Cb','psf','Med','Sim','IntA'].map(text=>({text}))}),['4/5Cb','Sim']);
assert.equal(M.jaccard(['a','b'],['b','c']),1/3);assert.equal(M.jaccard([],[]),0);
const line=M.resample([[0,0],[100,0]],10,false);assert.equal(line.length,20);assert.ok(Math.abs(line[6]-30)<1e-9&&line[7]===0);assert.equal(M.resample([[0,0],[10,0],[10,10],[0,10]],5,true).length,16);
const atlas=JSON.parse(fs.readFileSync(path.join(root,'assets/atlas-open/ccfv3-bbp-25/sagittal-planes.json'),'utf8'));
// A section made from one atlas plane: turned 37 degrees, shrunk to 0.93, moved, then written in pixels (y down).
function sectionFrom(index,mirror){const src=atlas.plates[index],ppm=1.4,angle=37*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),scale=.93;
 const px=points=>points.map(p=>{const x=mirror?-p[0]:p[0],y=p[1];return[((x*c-y*s)*scale+900)*ppm,-((x*s+y*c)*scale-400)*ppm];});
 const comps=src.paths.filter(p=>p.role==='published_compartment'),big=comps.reduce((a,b)=>b.points.length>a.points.length?b:a);
 return[{name:'CB',closed:true,paths:[px(big.points)]},...comps.filter(p=>p!==big).map(p=>({name:'GL',closed:true,paths:[px(p.points)]}))];}
const few={parameters:{}},near=index=>({unit:'um',plates:atlas.plates.slice(index-2,index+3)});
for(const[index,mirror]of[[10,false],[24,true]]){const outlines=sectionFrom(index,mirror),found=M.match(outlines,1/1.4,near(index),few);
 assert.equal(found.best.figure,atlas.plates[index].figure,'The plane the section was made from is found');assert.equal(found.candidates_tried,5);assert.equal(found.names_used,false);
 assert.ok(found.best.distance_um<25,'Outlines land on the plane: '+found.best.distance_um);assert.ok(Math.abs(found.best.scale-1/.93)<.03,'The size change is undone: '+found.best.scale);
 assert.equal(found.best.mirror,mirror,'A mirrored section is turned back');assert.ok(found.margin_um>0&&found.runner_up);
 // The placed outline lies on the plane's own outline
 const fixed=M.platePoints(atlas.plates[index],found.parameters),cb=found.placed.Cb.paths[0];let worst=0;
 for(const p of cb){let best=Infinity;for(let i=0;i<fixed.length;i+=2){const d=Math.hypot(fixed[i]-p[0],fixed[i+1]-p[1]);if(d<best)best=d;}if(best>worst)worst=best;}
 assert.ok(worst<120,'Placed outline is back on the plane: '+worst);
 assert.deepEqual(M.match(outlines,1/1.4,near(index),few).best,found.best,'The same outlines give the same answer');}
assert.throws(()=>M.match([{name:'GL',closed:true,paths:[[[0,0],[1,0],[1,1]]]}],1,atlas),/Cb/);assert.throws(()=>M.match(sectionFrom(10,false),0,atlas),/pixel size/);
console.log('Atlas match core: names, sampling, a known plane recovered with and without mirroring, placed outline on the plane, refusals.');
