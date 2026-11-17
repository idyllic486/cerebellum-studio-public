/* Volumes between matched positions: the integral, shared positions, ranges and refusals. Made-up numbers only. */
'use strict';
const assert=require('node:assert/strict'),V=require('../src/atlas_volume_core.js'),near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,a+' vs '+b);
// The integral is the area under straight lines between the points
near(V.integral([[0,2],[10,2]],0,10),20);near(V.integral([[0,0],[10,10]],0,10),50);near(V.integral([[10,10],[0,0],[20,0]],0,20),100);
near(V.integral([[0,0],[10,10],[20,0]],5,15),75);                                   // a stretch inside the points: 5..10 rises 5 to 10, 10..15 falls back
assert.equal(V.integral([[0,1],[10,1]],0,11),null,'The points must reach the far end');assert.equal(V.integral([[1,1],[10,1]],0,10),null,'and the near end');
assert.equal(V.integral([[0,1]],0,0),null);assert.equal(V.integral([[0,1],[10,1]],5,5),null);
// Three positions; two sections share the middle one and are averaged there
const sections=[{sample:'c',lateral_um:2000,values:{Cb:4,GL_TOTAL:1,WM:.5}},{sample:'a',lateral_um:0,values:{Cb:2,GL_TOTAL:1,WM:.5}},{sample:'b1',lateral_um:1000,values:{Cb:5,GL_TOTAL:2,WM:1}},{sample:'b2',lateral_um:1000,values:{Cb:7,GL_TOTAL:2,WM:null}}];
const made=V.arrange(sections,null);
assert.deepEqual(made.positions_um,[0,1000,2000]);assert.equal(made.sections_sharing_a_position,1);assert.deepEqual(made.range_um,[0,2000]);assert.deepEqual(made.sections.map(s=>s.sample),['a','b1','b2','c']);
assert.deepEqual(made.mean_area_mm2.Cb,[[0,2],[1000,6],[2000,4]]);assert.deepEqual(made.mean_area_mm2.WM,[[0,.5],[1000,1],[2000,.5]],'A section without a value is left out of the mean');
near(made.volume_mm3_own_range.Cb,(2+6)/2+(6+4)/2);near(made.volume_mm3_own_range.GL_TOTAL,1.5+1.5);near(made.volume_mm3_own_range.WM,.75+.75);
assert.deepEqual(made.mean_area_mm2['Cb-GL-WM'],[[0,.5],[1000,2],[2000,2.5]],'The remainder needs all three values of a section');near(made.volume_mm3_own_range['Cb-GL-WM'],1.25+2.25);
assert.equal(made.common_range_um,null);assert.equal(made.volume_mm3_common_range,null);assert.match(made.statement,/not measured volumes/);assert.match(made.statement,/no section thickness/);
// A stated range inside the animal's span, and one that reaches beyond it
const inside=V.arrange(sections,[500,1500]);near(inside.volume_mm3_common_range.Cb,(4+6)/2*.5+(6+5)/2*.5);assert.deepEqual(inside.common_range_um,[500,1500]);
assert.equal(V.arrange(sections,[0,2500]).volume_mm3_common_range.Cb,null,'No volume over a range the sections do not reach');
// One position gives no volume; bad input is refused
assert.equal(V.arrange(sections.slice(2),null).volume_mm3_own_range.Cb,null);
assert.throws(()=>V.arrange([],null),/no placed sections/);assert.throws(()=>V.arrange([{sample:'x',values:{}}],null),/no matched position/);assert.throws(()=>V.arrange(sections,[10,10]),/smaller first/);
// If every match were off by up to one plane: same seed, same answer; the spread brackets what the moves allow
{const planes=[0,100,200,300,400,500],two=[{sample:'a',lateral_um:100,values:{Cb:2,GL_TOTAL:1,WM:null}},{sample:'b',lateral_um:400,values:{Cb:2,GL_TOTAL:1,WM:null}}],one=V.sensitivity(two,planes,null,{draws:3000,seed:7}),again=V.sensitivity(two,planes,null,{draws:3000,seed:7});
 assert.deepEqual(one,again);assert.notDeepEqual(V.sensitivity(two,planes,null,{draws:3001,seed:8}),one);assert.equal(one.status,'proposed');assert.equal(one.moved_by_planes,1);
 // constant area 2 mm2: the volume is 2 x distance, and the distance is 100 to 500 um, 300 most often
 near(one.values.Cb.p2_5,.2);near(one.values.Cb.p97_5,1);near(one.values.Cb.median,.6);assert.equal(one.values.Cb.draws_with_full_range,3000);assert.equal(one.values.WM,null,'No value, no spread');assert.equal(one.values['Cb-GL-WM'],null);
 // two planes apart, about one draw in nine puts both sections on the same plane and has no volume; those draws are left out and counted
 {const close=V.sensitivity([{...two[0]},{...two[1],lateral_um:300}],planes,null,{draws:3000,seed:1}),full=close.values.Cb?close.values.Cb.draws_with_full_range:0;assert.ok(close.values.Cb===null||Math.abs(full/3000-8/9)<.03);}
 assert.equal(V.sensitivity(two,planes,[0,500],{draws:500}).values.Cb,null,'Too few draws reach a range wider than the sections');near(V.sensitivity(two,planes,[200,300],{draws:500}).values.Cb.median,.2);
 const edge=V.sensitivity([{sample:'a',lateral_um:0,values:{Cb:1}},{sample:'b',lateral_um:500,values:{Cb:1}}],planes,null,{draws:2000});assert.ok(edge.values.Cb.p97_5<=.5+1e-12,'A section at the end of the atlas cannot move past it');
 assert.throws(()=>V.sensitivity([{sample:'x',lateral_um:50,values:{Cb:1}}],planes,null),/not on an atlas plane/);}
console.log('Atlas volume core: integral, averaged shared positions, remainder, stated range, refusals, spread when matches are off by one plane.');
