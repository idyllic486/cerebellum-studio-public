/* Volumes in the atlas frame from sections placed at their matched lateral positions. A port of the integral and the
   arrangement in scripts/atlas_reconstruct.py, so both give the same numbers for the same sections.

   Sections matched to the same plane share one position; their areas are averaged there. A volume is the trapezoid
   integral of area over the positions, between the smallest and largest matched position of the animal or over a stated
   range. It is a volume in the atlas frame of one side of the cerebellum, built from matches that are themselves
   estimates; it is not a measured volume of the animal, and no section thickness enters it. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AtlasVolumeCore=api;})(typeof self!=='undefined'?self:this,function(){'use strict';
const SCHEMA='cerebellum-atlas-reconstruction/1',VALUES=Object.freeze(['Cb','GL_TOTAL','WM','Cb-GL-WM']);
const STATEMENT='Sections placed at the lateral position of their most similar atlas plane. Positions are estimates in the frame of an average-brain atlas, one side only; volumes are integrals over those positions, not measured volumes; no section thickness enters them; nothing is approved anatomy.';
const known=v=>v!==null&&v!==undefined&&Number.isFinite(v);
/* Trapezoid integral of [position, value] pairs between two positions; null unless the positions reach both ends. */
function integral(points,low,high){const pts=points.slice().sort((a,b)=>a[0]-b[0]);
 if(pts.length<2||pts[0][0]>low||pts[pts.length-1][0]<high||!(low<high))return null;
 const at=x=>{for(let i=1;i<pts.length;i++)if(x<=pts[i][0]){const a=pts[i-1],b=pts[i];return b[0]===a[0]?b[1]:a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0]);}return pts[pts.length-1][1];};
 const grid=[low,...pts.map(p=>p[0]).filter(x=>low<x&&x<high),high],values=grid.map(at);let sum=0;for(let i=0;i<grid.length-1;i++)sum+=(values[i]+values[i+1])/2*(grid[i+1]-grid[i]);return sum;}
/* sections: [{sample, lateral_um, values:{Cb, GL_TOTAL, WM}}] with areas in mm2 (null where not known).
   common: [low, high] in micrometres, or null. Volumes are in mm3. */
function arrange(sections,common){if(!Array.isArray(sections)||!sections.length)throw Error('There are no placed sections.');
 const rows=sections.map((s,order)=>{if(!known(s.lateral_um))throw Error('A section has no matched position.');const v=s.values||{},cb=known(v.Cb)?v.Cb:null,gl=known(v.GL_TOTAL)?v.GL_TOTAL:null,wm=known(v.WM)?v.WM:null;
  return{sample:s.sample,order,lateral_um:s.lateral_um,Cb:cb,GL_TOTAL:gl,WM:wm,'Cb-GL-WM':cb===null||gl===null||wm===null?null:cb-gl-wm};}).sort((a,b)=>a.lateral_um-b.lateral_um||a.order-b.order);
 const positions=[...new Set(rows.map(r=>r.lateral_um))].sort((a,b)=>a-b),mean={};
 for(const name of VALUES){mean[name]=[];for(const p of positions){const here=rows.filter(r=>r.lateral_um===p&&r[name]!==null).map(r=>r[name]);if(here.length)mean[name].push([p,here.reduce((a,b)=>a+b,0)/here.length]);}}
 const volume=(low,high)=>Object.fromEntries(VALUES.map(name=>{const v=integral(mean[name],low,high);return[name,v===null?null:v/1000];}));
 if(common&&!(known(common[0])&&known(common[1])&&common[0]<common[1]))throw Error('Give the range as two positions in micrometres, the smaller first.');
 return{schema:SCHEMA,statement:STATEMENT,sections:rows.map(({order,...r})=>r),positions_um:positions,sections_sharing_a_position:rows.length-positions.length,range_um:[positions[0],positions[positions.length-1]],
  mean_area_mm2:mean,volume_mm3_own_range:volume(positions[0],positions[positions.length-1]),common_range_um:common?[common[0],common[1]]:null,volume_mm3_common_range:common?volume(common[0],common[1]):null};}
/* How much the volumes move when every section's match is off by up to one plane either way: each section is moved,
   independently and evenly, to {one plane medial, as matched, one plane lateral}, and the volumes are integrated again.
   Returns the 2.5th, 50th and 97.5th percentile in mm3 per value, or null for a value when fewer than nine draws in ten
   reach the range. Where a value is null for a stated range, `values_with_ends_carried` gives the same percentiles with
   the outermost area kept up to the end of the range (at most one plane), and says how many draws needed that.
   The method is that of scripts/atlas_reconstruct.py; the random numbers are not, so the two agree
   closely but not digit for digit. `planes` are the lateral positions of the atlas planes. */
function random(seed){let a=seed>>>0;return()=>{a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function percentile(sorted,q){const at=(sorted.length-1)*q,lo=Math.floor(at),hi=Math.ceil(at);return sorted[lo]+(sorted[hi]-sorted[lo])*(at-lo);}
function sensitivity(sections,planes,common,options={}){const draws=options.draws||2000,next=random(options.seed===undefined?20261111:options.seed),positions=planes.slice().sort((a,b)=>a-b),index=new Map(positions.map((p,i)=>[p,i]));
 if(common&&!(known(common[0])&&known(common[1])&&common[0]<common[1]))throw Error('Give the range as two positions in micrometres, the smaller first.');
 const rows=sections.map(s=>{if(!index.has(s.lateral_um))throw Error('A section is not on an atlas plane.');const v=s.values||{},cb=known(v.Cb)?v.Cb:null,gl=known(v.GL_TOTAL)?v.GL_TOTAL:null,wm=known(v.WM)?v.WM:null;return{at:index.get(s.lateral_um),Cb:cb,GL_TOTAL:gl,WM:wm,'Cb-GL-WM':cb===null||gl===null||wm===null?null:cb-gl-wm};});
 /* With `carry`, a draw whose moved sections stop short of the range by no more than one plane keeps its outermost area
    up to the end of the range. That is an assumption about the missing sliver, so it is reported apart. */
 const gap=positions.slice(1).reduce((m,p,i)=>Math.max(m,p-positions[i]),0);
 const over=(points,carry)=>{if(!common)return integral(points,points[0][0],points[points.length-1][0]);if(!carry)return integral(points,common[0],common[1]);
  const first=points[0],last=points[points.length-1];if(first[0]-common[0]>gap||common[1]-last[0]>gap)return null;
  return integral([...(first[0]>common[0]?[[common[0],first[1]]]:[]),...points,...(last[0]<common[1]?[[common[1],last[1]]]:[])],common[0],common[1]);};
 const spread=carry=>{const out={};
  for(const name of VALUES){const used=rows.filter(r=>r[name]!==null),found=[];let carried=0;
   for(let d=0;d<draws;d++){const sum=new Map(),count=new Map();for(const r of used){const i=Math.min(positions.length-1,Math.max(0,r.at+Math.floor(next()*3)-1)),p=positions[i];sum.set(p,(sum.get(p)||0)+r[name]);count.set(p,(count.get(p)||0)+1);}
    const points=[...sum.keys()].sort((a,b)=>a-b).map(p=>[p,sum.get(p)/count.get(p)]);if(!points.length)continue;const value=over(points,carry);if(value===null)continue;found.push(value/1000);
    if(carry&&(points[0][0]>common[0]||points[points.length-1][0]<common[1]))carried++;}
   if(found.length<draws*.9){out[name]=null;continue;}found.sort((a,b)=>a-b);out[name]={p2_5:percentile(found,.025),median:percentile(found,.5),p97_5:percentile(found,.975),...(carry?{draws_used:found.length,draws_with_an_end_carried:carried}:{draws_with_full_range:found.length})};}
  return out;};
 const out=spread(false),short=VALUES.filter(n=>out[n]===null&&rows.some(r=>r[n]!==null));let carried=null;
 if(common&&options.carry_ends!==false&&short.length){carried=spread(true);for(const n of VALUES)if(!short.includes(n))carried[n]=null;}
 return{status:'proposed',moved_by_planes:1,draws,values:out,values_with_ends_carried:carried};}
return Object.freeze({SCHEMA,VALUES,STATEMENT,integral,arrange,sensitivity});
});
