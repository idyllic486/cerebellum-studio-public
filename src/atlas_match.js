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
if(save)save.addEventListener('click',()=>{if(!last)return;const url=URL.createObjectURL(new Blob([JSON.stringify(last,null,1)+'\n'],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=(last.section||last.animal||'section').replace(/\.[^.]+$/,'')+'-atlas-match.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});

/* Every included section of one study animal, each matched on its own, then stacked at their matched positions.
   Sections that match the same plane lie on top of each other; nothing is interpolated between them. */
const animalSelect=$('atlasMatchAnimal'),stackRun=$('atlasMatchStackRun'),list=$('atlasMatchStackList');let stackWorkers=[],lastStack=null;
const layerOf=roi=>{const l=roi.label!=null&&roi.label!==''?String(roi.label).toUpperCase():(/^(CB|ML|GL|WM)(?:_|$)/i.exec(roi.name||'')||[])[1]?.toUpperCase();return['CB','GL','WM'].includes(l)?l:null;};
function studyAnimals(){const study=window.CerebellumStudy?.snapshot?.();return study?.animals?.length?study.animals:[];}
function refreshAnimals(){if(!animalSelect)return;const animals=studyAnimals(),keep=animalSelect.value;animalSelect.replaceChildren(...animals.map(a=>{const o=document.createElement('option');o.value=a.id;o.textContent=a.id+(a.group?' · '+a.group:'');o.translate=false;return o;}));
 if(animals.some(a=>a.id===keep))animalSelect.value=keep;animalSelect.disabled=!animals.length;if(stackRun)stackRun.disabled=!animals.length||stackWorkers.length>0;}
function stackBusy(on){if(stackRun)stackRun.disabled=on;run.disabled=on;if(stop)stop.hidden=!on;if(bar){bar.hidden=!on;if(on){bar.value=0;bar.max=1;}}}
function stopStack(){stackWorkers.forEach(w=>w.terminate());stackWorkers=[];stackBusy(false);refreshAnimals();}
if(stackRun)stackRun.addEventListener('click',()=>{const atlas=window.CerebellumAtlasExplorer?.atlas?.(),animal=studyAnimals().find(a=>a.id===animalSelect.value);
 if(!atlas){say('The atlas is still loading. Try again in a moment.');return;}if(!animal){say('Open a study in Study & 3D first.');return;}
 const jobs=[],skipped=[];for(const section of animal.sections){if(section.included===false)continue;const um=section.calibration?.um_per_pixel_x,umY=section.calibration?.um_per_pixel_y;
  const outlines=(section.rois||[]).filter(r=>r.included!==false&&(r.kind||'area')==='area'&&r.paths?.length&&layerOf(r)).map(r=>({name:layerOf(r),closed:true,paths:r.paths}));
  if(!(um>0)||!Number.isFinite(um)||(Number.isFinite(umY)&&umY>0&&Math.abs(umY-um)>um*.001)||!outlines.some(o=>o.name==='CB'))skipped.push(section.id);else jobs.push({id:section.id,outlines,umPerPixel:um});}
 if(!jobs.length){say('No section of this animal has both a whole-cerebellum outline and a pixel size.');return;}
 const sent={unit:atlas.unit,plates:atlas.plates.map(p=>({figure:p.figure,lateral_um:p.lateral_um,labels:p.labels,paths:p.paths.filter(q=>q.role==='boundary_ink'||q.role==='published_compartment').map(q=>({role:q.role,closed:q.closed,points:q.points}))}))};
 const total=jobs.length*atlas.plates.length,done=new Array(jobs.length).fill(0),results=new Array(jobs.length).fill(null);let next=0,failed=null;
 stackBusy(true);say('Comparing each section with every atlas plane. This runs on this computer and takes about half a minute for each section.');
 const finishAll=()=>{stackWorkers.forEach(w=>w.terminate());stackWorkers=[];stackBusy(false);refreshAnimals();if(failed){say(failed);return;}
  const rows=jobs.map((job,i)=>{const r=results[i],best=r.best,range=r.parameters.scale_range,cautions=[];if(r.margin_um!=null&&r.margin_um<best.distance_um*.1)cautions.push('uncertain');if(best.scale<=range[0]*1.001||best.scale>=range[1]*.999)cautions.push('size');
   return{section:job.id,um_per_pixel:job.umPerPixel,cautions,best,runner_up:r.runner_up,margin_um:r.margin_um,placed:r.placed};});
  const sections=rows.map(row=>{const lines={};for(const[name,v]of Object.entries(row.placed))if(['Cb','GL_TOTAL','WM','PL_TOTAL'].includes(name))lines[name]=v.paths.map(p=>v.closed?p.concat([p[0]]):p);return{sample:row.section,z:row.best.lateral_um,rois:lines};});
  window.CerebellumAtlasExplorer?.loadPlaced?.({schema:'cerebellum-atlas-placed-stack/1',unit:'um',coordinate_order:['AP','DV','Lateral'],statement:results[0].statement,atlas_source_sha256:atlas.source?.sha256,animals:{[animal.id]:{group:animal.group||undefined,sections}}});
  if(list){list.replaceChildren(...rows.map(row=>{const tr=document.createElement('tr');for(const text of[row.section,String(row.best.plate_index+1),fmt(row.best.lateral_um/1000,2)+' mm',fmt(row.best.distance_um,0)+' µm',row.margin_um==null?'–':fmt(row.margin_um,0)+' µm']){const td=document.createElement('td');td.textContent=text;td.translate=false;tr.append(td);}
    const flag=document.createElement('td');flag.dataset.cautions=row.cautions.join(' ');flag.textContent=row.cautions.length?'!':'';flag.translate=false;tr.append(flag);if(row.cautions.length)tr.className='is-caution';return tr;}));$('atlasMatchStackTable').hidden=false;}
  if(table)table.hidden=true;for(const id of['atlasMatchUncertain','atlasMatchSize']){const n=$(id);if(n)n.hidden=true;}
  lastStack={schema:'cerebellum-atlas-match/1',statement:results[0].statement,made_in:'browser',animal:animal.id,group:animal.group||null,atlas_source_sha256:atlas.source?.sha256||null,parameters:results[0].parameters,sections_matched:rows.length,sections_skipped:skipped,sections:rows.map(({placed,...row})=>row)};last=lastStack;if(save)save.disabled=false;
  const positions=new Set(rows.map(r=>r.best.plate_index)).size;$('atlasMatchStackCount').textContent=rows.length+' · '+positions+(skipped.length?' · '+skipped.length:'');
  say(rows.some(r=>r.cautions.length)?'The sections are stacked at their closest planes. Rows marked ! are uncertain. These are estimates from shape alone, not measured positions; left and right are not told apart.':'The sections are stacked at their closest planes. These are estimates from shape alone, not measured positions; left and right are not told apart.');};
 const start=()=>{if(failed||next>=jobs.length)return false;const i=next++,w=new Worker('./assets/atlas_match_worker.js');stackWorkers.push(w);
  w.onmessage=event=>{const m=event.data;if(m.progress){done[i]=m.progress[0];if(bar){bar.max=total;bar.value=done.reduce((a,b)=>a+b,0);}return;}
   if(m.error)failed=jobs[i].id+': '+m.error;else results[i]=m.result;w.terminate();stackWorkers=stackWorkers.filter(x=>x!==w);if(failed){finishAll();return;}if(!start()&&results.every(Boolean))finishAll();};
  w.onerror=()=>{failed='The comparison could not be completed in this browser.';finishAll();};w.postMessage({outlines:jobs[i].outlines,umPerPixel:jobs[i].umPerPixel,atlas:sent});return true;};
 for(let k=0;k<Math.max(1,Math.min(4,(navigator.hardwareConcurrency||2)-1,jobs.length));k++)start();});
if(stop)stop.addEventListener('click',()=>{if(stackWorkers.length){stopStack();say('The comparison was stopped. Nothing was changed.');}});
if(animalSelect){refreshAnimals();window.addEventListener('cerebellum-workspace-open',refreshAnimals);document.querySelector('.site-header')?.addEventListener('click',()=>setTimeout(refreshAnimals,0));animalSelect.addEventListener('focus',refreshAnimals);animalSelect.addEventListener('pointerdown',refreshAnimals);new IntersectionObserver(e=>{if(e.some(x=>x.isIntersecting))refreshAnimals();}).observe(animalSelect);}
window.CerebellumAtlasMatch=Object.freeze({snapshot:()=>last?JSON.parse(JSON.stringify(last)):null,busy:()=>!!worker||stackWorkers.length>0,refreshAnimals});
})();
