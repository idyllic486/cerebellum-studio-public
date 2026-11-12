/* The JavaScript editable-ROI core against the Python tool: same polygons, same rebuilt layers. Synthetic only. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const E=require('../src/editable_roi_core.js'),R=require('../src/research_core.js');
const f=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/editable-roi-reference.json'),'utf8'));
for(const [name,expected] of Object.entries(f.export)){
 const made=E.editable(f.layers,f.width,f.height,{parameters:expected.parameters,um2:expected.um2,pl:f.pl});
 assert.deepEqual(made.polygons.map(p=>p.name),expected.polygons.map(p=>p.name),name+': polygon names');
 assert.deepEqual(made.polygons,expected.polygons,name+': polygon vertices');
 for(const [outline,summary] of Object.entries(expected.summary))for(const [key,value] of Object.entries(summary))assert.equal(made.summary[outline][key],value,name+' '+outline+' '+key);
}
const all=E.editable(f.layers,f.width,f.height,{parameters:f.export.all.parameters,um2:f.export.all.um2,pl:f.pl});
// The bytes are ImageJ polygons and polylines that the site's own reader takes back unchanged.
for(const polygon of all.polygons){const bytes=E.encodeROI(polygon.name,polygon.kind,polygon.path);assert.equal(bytes[6],polygon.kind==='polygon'?0:5);
 const back=R.parseROI(bytes,polygon.name+'.roi');assert.equal(back.name,polygon.name);assert.equal(back.kind,polygon.kind==='polygon'?'area':'polyline');assert.deepEqual(back.paths,[polygon.path]);}
assert.throws(()=>E.encodeROI('x','polygon',[[0,0],[1,1]]),/cannot be written/);assert.throws(()=>E.encodeROI('x','polygon',[[0,0],[1.5,1],[2,2]]),/whole-pixel/);
for(const [name,expected] of Object.entries(f.rebuild)){
 const made=E.rebuild(f.edited,f.width,f.height,{pl_band_width_um:expected.pl_band_width_um,pixels_per_micron:f.pixels_per_micron});
 assert.equal(made.how.purkinje_band.pixels,expected.band_pixels,name+': band pixels');assert.deepEqual(made.how.pixels,expected.areas_px,name+': layer pixels');
 assert.deepEqual(made.how.clipped_to_keep_layers_nested,expected.clipped);assert.deepEqual(made.rings,expected.rings,name+': layer outlines');assert.deepEqual(made.pl,f.pl);
}
// A person deletes a part, adds a hole and draws outside the nesting; unknown names are ignored and reported.
const box=(name,x0,y0,x1,y1)=>({name,kind:'area',paths:[[[x0,y0],[x1,y0],[x1,y1],[x0,y1]]]});
const changed=E.rebuild([...f.edited.filter(r=>!['Cb_part02','GL+WM_part02','PL_TOTAL'].includes(r.name)),box('Cb_hole_new',200,40,220,60),box('WM_far',20,140,30,150),box('scale bar',0,0,5,5)],f.width,f.height,{});
assert.deepEqual(changed.how.rois_ignored,['scale bar']);assert.equal(changed.pl,null);assert.ok(changed.how.rois_used.Cb.holes.includes('Cb_hole_new'));
assert.equal(changed.how.clipped_to_keep_layers_nested.wm_outside_gl_wm_px,100);
const base=E.rebuild(f.edited,f.width,f.height,{});assert.ok(changed.how.pixels.CB<base.how.pixels.CB);
for(let y=40;y<60;y++)for(let x=200;x<220;x++)assert.equal(changed.labels[y*f.width+x],0);
assert.throws(()=>E.rebuild(f.edited.filter(r=>!r.name.startsWith('GL+WM')),f.width,f.height,{}),/at least one/);
assert.throws(()=>E.rebuild([...f.edited,{name:'PL_TOTAL',kind:'polyline',paths:[[[0,0],[5,5]]]}],f.width,f.height,{}),/one PL_TOTAL/);
assert.throws(()=>E.editable({CB:[],GL:[]},10,10),/needed/);assert.throws(()=>E.editable(f.layers,20000,20000),/not supported/);
console.log('Editable ROI core matches the Python tool on the synthetic reference: '+Object.keys(f.export).length+' exports, '+Object.keys(f.rebuild).length+' rebuilds.');
