/* Rigid XY scenario transforms. Observed coordinates and depths remain immutable. */
(function(root){'use strict';
const VERSION='cerebellum-spatial/1',LIMITS=Object.freeze({sections:24,vertices:100000,coordinate:1e7,history:100});
const finite=x=>typeof x==='number'&&Number.isFinite(x),fail=m=>{throw Error(m);};
const copy=value=>structuredClone(value);
function bounds(study){let xmin=Infinity,ymin=Infinity,xmax=-Infinity,ymax=-Infinity,zmin=Infinity,zmax=-Infinity;for(const s of study.sections){zmin=Math.min(zmin,s.z);zmax=Math.max(zmax,s.z);for(const r of s.rois)for(const p of r.paths)for(const [x,y]of p){xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);ymin=Math.min(ymin,y);ymax=Math.max(ymax,y);}}return{xmin,ymin,xmax,ymax,zmin,zmax};}
function validateStudy(study){
 if(!study||!['index','um'].includes(study.unit)||!Array.isArray(study.sections)||!study.sections.length||study.sections.length>LIMITS.sections)fail('The simulation requires 1–24 observed planes with a depth unit.');
 let vertices=0;const ids=new Set(),orders=new Set(),zs=new Set();
 for(const s of study.sections){
  if(!s||typeof s.id!=='string'||!s.id||s.id.length>256||ids.has(s.id))fail('Section IDs must be unique strings of no more than 256 characters.');ids.add(s.id);
  if(!Number.isSafeInteger(s.order)||s.order<0||orders.has(s.order))fail('Section orders must be unique non-negative integers.');orders.add(s.order);
  if(!finite(s.z)||Math.abs(s.z)>1e9||zs.has(s.z)||(study.unit==='index'&&!Number.isSafeInteger(s.z)))fail('Depths must be unique coordinates without missing values. Measured depths are not filled in from order.');zs.add(s.z);
  if(!Array.isArray(s.rois)||!s.rois.length)fail(s.id+': a region ROI is required.');
  for(const r of s.rois){if(!r||!Array.isArray(r.paths)||!r.paths.length||(r.kind!==undefined&&r.kind!=='area'))fail(s.id+': only region contours are supported.');for(const p of r.paths){if(!Array.isArray(p)||p.length<3)fail('A closed contour requires at least three points.');vertices+=p.length;if(vertices>LIMITS.vertices)fail('Total contours are limited to 100,000 points.');for(const q of p)if(!Array.isArray(q)||q.length!==2||!q.every(v=>finite(v)&&Math.abs(v)<=LIMITS.coordinate))fail('XY coordinates must be two finite numbers within the range ±10 million.');}}
 }
 const sorted=[...study.sections].sort((a,b)=>a.order-b.order);for(let i=1;i<sorted.length;i++)if(sorted[i].z<=sorted[i-1].z)fail('Depth must increase with section order.');
 const b=bounds(study),extent=Math.max(b.xmax-b.xmin,b.ymax-b.ymin);if(!finite(extent)||extent<=0)fail('The XY range of all observed contours is zero. Check the region coordinates.');
 return study;
}
const identity=id=>({id,dx:0,dy:0,angle:0,included:true});
function create(study){validateStudy(study);return{version:VERSION,study:copy(study),transforms:study.sections.map(s=>identity(s.id)),history:[],future:[]};}
function sectionOf(state,id){const section=state.study.sections.find(s=>s.id===id);if(!section)fail('Unknown section ID: '+id);return section;}
function center(state,id){const b=bounds({sections:[sectionOf(state,id)]});return[(b.xmin+b.xmax)/2,(b.ymin+b.ymax)/2];}
function validateTransform(t){if(!t||typeof t.id!=='string'||!finite(t.dx)||!finite(t.dy)||Math.abs(t.dx)>LIMITS.coordinate||Math.abs(t.dy)>LIMITS.coordinate||!finite(t.angle)||Math.abs(t.angle)>360||typeof t.included!=='boolean')fail('Translations must be finite within the range ±10 million, angles within ±360°, and inclusion must be true or false.');}
function apply(section,t){
 if(t.dx===0&&t.dy===0&&t.angle===0)return copy(section);
 const b=bounds({sections:[section]}),cx=(b.xmin+b.xmax)/2,cy=(b.ymin+b.ymax)/2,r=t.angle*Math.PI/180;
 let co=Math.cos(r),si=Math.sin(r);if(Math.abs(co)<1e-15)co=0;if(Math.abs(si)<1e-15)si=0;
 return{...copy(section),rois:section.rois.map(roi=>({...copy(roi),paths:roi.paths.map(path=>path.map(([x,y])=>{
  const q=t.angle===0?[x+t.dx,y+t.dy]:[cx+(x-cx)*co-(y-cy)*si+t.dx,cy+(x-cx)*si+(y-cy)*co+t.dy];
  if(q.some(v=>!finite(v)||Math.abs(v)>LIMITS.coordinate))fail('The transformed contour exceeds the permitted coordinate range. Reduce the translation.');return q;
 }))}))};
}
function derive(state){return{...copy(state.study),sections:state.study.sections.filter(s=>state.transforms.find(t=>t.id===s.id).included).map(s=>apply(s,state.transforms.find(t=>t.id===s.id)))};}
function changed(state,transforms){if(JSON.stringify(state.transforms)===JSON.stringify(transforms))return state;return{...state,transforms,history:[...state.history,state.transforms].slice(-LIMITS.history),future:[]};}
function transform(state,id,patch){sectionOf(state,id);if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!['dx','dy','angle','included'].includes(k)))fail('Unsupported transformation field.');const t={...state.transforms.find(t=>t.id===id),...patch};validateTransform(t);apply(sectionOf(state,id),t);return changed(state,state.transforms.map(v=>v.id===id?t:v));}
function undo(state){if(!state.history.length)return state;return{...state,transforms:state.history.at(-1),history:state.history.slice(0,-1),future:[state.transforms,...state.future].slice(0,LIMITS.history)};}
function redo(state){if(!state.future.length)return state;return{...state,transforms:state.future[0],history:[...state.history,state.transforms].slice(-LIMITS.history),future:state.future.slice(1)};}
function reset(state,id){if(id!==undefined)sectionOf(state,id);return changed(state,state.transforms.map(t=>id===undefined||t.id===id?identity(t.id):t));}
function serialize(state){return{schema:VERSION,study:copy(state.study),transforms:copy(state.transforms)};}
function deserialize(value){
 if(!value||value.schema!==VERSION)fail('Unsupported 3D simulation file.');const state=create(value.study);
 if(!Array.isArray(value.transforms)||value.transforms.length!==state.transforms.length)fail('Transformation records are required for all sections.');
 const ids=new Set();for(const t of value.transforms){validateTransform(t);sectionOf(state,t.id);if(ids.has(t.id))fail('Duplicate transformation ID.');ids.add(t.id);if(Object.keys(t).some(k=>!['id','dx','dy','angle','included'].includes(k)))fail('Unsupported transformation record.');apply(sectionOf(state,t.id),t);}
 return{...state,transforms:state.transforms.map(t=>copy(value.transforms.find(v=>v.id===t.id)))};
}
const api=Object.freeze({VERSION,LIMITS,create,center,bounds,transform,derive,undo,redo,reset,serialize,deserialize});root.SpatialCore=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:window);
