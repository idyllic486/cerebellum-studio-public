/* Atlas view: find the atlas plane that the section open in Image analysis resembles most, show it and lay the section's
   outlines on it. The answer is an estimate from shape alone: not a measured position, and left and right are not told apart. */
(function(){'use strict';
const $=id=>document.getElementById(id),run=$('atlasMatchRun'),stop=$('atlasMatchStop'),save=$('atlasMatchSave'),status=$('atlasMatchStatus'),bar=$('atlasMatchProgress'),table=$('atlasMatchResult');
if(!run||!status)return;
let worker=null,last=null;
const say=text=>{status.textContent=text;};
const fmt=(value,digits)=>Number(value).toLocaleString(document.documentElement.lang||'en',{minimumFractionDigits:digits,maximumFractionDigits:digits});
function section(){const state=window.CerebellumAnalysis?.snapshot?.();if(!state||!state.rois?.length)throw Error('Open a section in Image analysis and get its outlines first.');
 const um=state.metadata?.um_per_pixel_x,umY=state.metadata?.um_per_pixel_y;if(!(um>0)||!Number.isFinite(um))throw Error('Enter the pixel size of the section in Image analysis first.');
 if(Number.isFinite(umY)&&umY>0&&Math.abs(umY-um)>um*.001)throw Error('The section has different pixel sizes along X and Y; the match needs square pixels.');
 const outlines=state.rois.filter(r=>r.included!==false&&['CB','GL','WM'].includes(r.label)&&(r.geometry||'area')==='area'&&r.paths?.length).map(r=>({name:r.label,closed:true,paths:r.paths}));
 if(!outlines.some(o=>o.name==='CB'))throw Error('The section needs a whole-cerebellum outline (CB) to be matched.');
 return{outlines,umPerPixel:um,approved:!!state.approval,name:(document.getElementById('analysisDropName')?.textContent||'section').trim()};}
function busy(on){run.disabled=on;if(stop)stop.hidden=!on;if(bar){bar.hidden=!on;if(on){bar.value=0;bar.max=1;}}}
function finish(){if(worker){worker.terminate();worker=null;}busy(false);}
function show(result,input,atlas){const best=result.best,next=result.runner_up,set=(id,text)=>{const n=$(id);if(n)n.textContent=text;};
 set('atlasMatchPlane',(best.plate_index+1)+' / '+atlas.plates.length);set('atlasMatchLateral',fmt(best.lateral_um/1000,2)+' mm');set('atlasMatchDistance',fmt(best.distance_um,0)+' µm');
 set('atlasMatchNext',next?(next.plate_index+1)+' · '+fmt(next.lateral_um/1000,2)+' mm':'–');set('atlasMatchMargin',result.margin_um==null?'–':fmt(result.margin_um,0)+' µm');
 // Two plain cautions. Both thresholds are proposed values, not validated ones.
 const cautions=[],range=result.parameters.scale_range;if(result.margin_um!=null&&result.margin_um<best.distance_um*.1)cautions.push('uncertain');if(best.scale<=range[0]*1.001||best.scale>=range[1]*.999)cautions.push('size');
 const near=$('atlasMatchUncertain'),size=$('atlasMatchSize');if(near)near.hidden=!cautions.includes('uncertain');if(size)size.hidden=!cautions.includes('size');
 if(table)table.hidden=false;if(save)save.disabled=false;
 const explorer=window.CerebellumAtlasExplorer;explorer?.selectPlane?.(best.plate_index);
 const lines={};for(const[name,v]of Object.entries(result.placed))if(['Cb','GL_TOTAL','WM','PL_TOTAL'].includes(name))lines[name]=v.paths.map(p=>v.closed?p.concat([p[0]]):p);
 explorer?.loadPlaced?.({schema:'cerebellum-atlas-placed-stack/1',unit:'um',coordinate_order:['AP','DV','Lateral'],statement:result.statement,atlas_source_sha256:atlas.source?.sha256,animals:{[input.name||'section']:{sections:[{sample:input.name||'section',z:best.lateral_um,rois:lines}]}}});
 last={schema:result.schema,statement:result.statement,made_in:'browser',cautions,section:input.name,outlines_approved:input.approved,um_per_pixel:input.umPerPixel,atlas_source_sha256:atlas.source?.sha256||null,parameters:result.parameters,names_used:result.names_used,candidates_tried:result.candidates_tried,best:result.best,runner_up:result.runner_up,margin_um:result.margin_um,all:result.all};
 say(input.approved?'The closest plane is shown and the section is laid on it. This is an estimate from shape alone, not a measured position; left and right are not told apart.':'The closest plane is shown and the section is laid on it. These outlines are a draft and are not approved. This is an estimate from shape alone, not a measured position; left and right are not told apart.');}
run.addEventListener('click',()=>{let input,atlas;
 try{input=section();atlas=window.CerebellumAtlasExplorer?.atlas?.();if(!atlas)throw Error('The atlas is still loading. Try again in a moment.');}catch(error){say(error.message);return;}
 busy(true);say('Comparing the section with every atlas plane. This takes up to a minute and runs on this computer.');
 worker=new Worker('./assets/atlas_match_worker.js');
 worker.onmessage=event=>{const m=event.data;if(m.progress){if(bar){bar.max=m.progress[1];bar.value=m.progress[0];}return;}
  finish();if(m.error){say(m.error);return;}try{show(m.result,input,atlas);}catch(error){say(String(error.message||error));}};
 worker.onerror=()=>{finish();say('The comparison could not be completed in this browser.');};
 worker.postMessage({outlines:input.outlines,umPerPixel:input.umPerPixel,atlas:{unit:atlas.unit,plates:atlas.plates.map(p=>({figure:p.figure,lateral_um:p.lateral_um,labels:p.labels,paths:p.paths.filter(q=>q.role==='boundary_ink'||q.role==='published_compartment').map(q=>({role:q.role,closed:q.closed,points:q.points}))}))}});});
if(stop)stop.addEventListener('click',()=>{finish();say('The comparison was stopped. Nothing was changed.');});
if(save)save.addEventListener('click',()=>{if(!last)return;const url=URL.createObjectURL(new Blob([JSON.stringify(last,null,1)+'\n'],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=(last.section||'section').replace(/\.[^.]+$/,'')+'-atlas-match.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
window.CerebellumAtlasMatch=Object.freeze({snapshot:()=>last?JSON.parse(JSON.stringify(last)):null,busy:()=>!!worker});
})();
