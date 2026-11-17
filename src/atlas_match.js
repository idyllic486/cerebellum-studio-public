/* Atlas view: find the atlas plane that the section open in Image analysis resembles most, show it and lay the section's
   outlines on it. The answer is an estimate from shape alone: not a measured position, and left and right are not told apart. */
(function(){'use strict';
const $=id=>document.getElementById(id),run=$('atlasMatchRun'),stop=$('atlasMatchStop'),save=$('atlasMatchSave'),status=$('atlasMatchStatus'),bar=$('atlasMatchProgress'),table=$('atlasMatchResult');
if(!run||!status)return;
let worker=null,last=null;
const say=text=>{status.textContent=text;};
/* How sure a match is. Real sections showed that the second-best plane is almost always within a few micrometres, so the
   margin alone says nothing. What is shown instead is the span of planes that fit about as well as the best one (within
   NEAR_UM of its distance); a span wider than WIDE_UM is marked. Both numbers are proposed values, not validated ones. */
const NEAR_UM=5,WIDE_UM=500;
/* Size change allowed when nothing is known about the animal, and the band around an animal's own typical size change.
   Real sections of one animal need nearly the same size change (spread of a few per cent), while a single section left
   free to shrink can be drawn to the small planes at the lateral end. Both are proposed values, not validated ones. */
const WIDE_SCALE=[.75,1.6],ANIMAL_BAND=.12,ANIMAL_MIN_SECTIONS=3;
function similar(result){const near=result.all.filter(r=>r.distance_um<=result.best.distance_um+NEAR_UM).map(r=>r.lateral_um);return{within_um:NEAR_UM,lateral_um:[Math.min(...near),Math.max(...near)],planes:near.length};}
function cautionsOf(result,span){const best=result.best,range=result.parameters.scale_range,out=[];if(span.lateral_um[1]-span.lateral_um[0]>WIDE_UM)out.push('uncertain');if(best.scale<=range[0]*1.001||best.scale>=range[1]*.999)out.push('size');return out;}
const spanText=span=>span.lateral_um[0]===span.lateral_um[1]?fmt(span.lateral_um[0]/1000,2)+' mm':fmt(span.lateral_um[0]/1000,2)+' – '+fmt(span.lateral_um[1]/1000,2)+' mm';
const fmt=(value,digits)=>Number(value).toLocaleString(document.documentElement.lang||'en',{minimumFractionDigits:digits,maximumFractionDigits:digits});
function section(){const state=window.CerebellumAnalysis?.snapshot?.();if(!state||!state.rois?.length)throw Error('Open a section in Image analysis and get its outlines first.');
 const um=state.metadata?.um_per_pixel_x,umY=state.metadata?.um_per_pixel_y;if(!(um>0)||!Number.isFinite(um))throw Error('Enter the pixel size of the section in Image analysis first.');
 if(Number.isFinite(umY)&&umY>0&&Math.abs(umY-um)>um*.001)throw Error('The section has different pixel sizes along X and Y; the match needs square pixels.');
 const outlines=state.rois.filter(r=>r.included!==false&&['CB','GL','WM'].includes(r.label)&&(r.geometry||'area')==='area'&&r.paths?.length).map(r=>({name:r.label,closed:true,paths:r.paths}));
 if(!outlines.some(o=>o.name==='CB'))throw Error('The section needs a whole-cerebellum outline (CB) to be matched.');
 return{outlines,umPerPixel:um,width:state.source?.width,height:state.source?.height,approved:!!state.approval,name:(document.getElementById('analysisDropName')?.textContent||'section').trim()};}
function busy(on){run.disabled=on;if(stop)stop.hidden=!on;if(bar){bar.hidden=!on;if(on){bar.value=0;bar.max=1;}}}
function finish(){if(worker){worker.terminate();worker=null;}busy(false);}
function show(result,input,atlas){const best=result.best,next=result.runner_up,set=(id,text)=>{const n=$(id);if(n)n.textContent=text;};
 set('atlasMatchPlane',(best.plate_index+1)+' / '+atlas.plates.length);set('atlasMatchLateral',fmt(best.lateral_um/1000,2)+' mm');set('atlasMatchDistance',fmt(best.distance_um,0)+' µm');
 const span=similar(result);set('atlasMatchNext',next?(next.plate_index+1)+' · '+fmt(next.lateral_um/1000,2)+' mm':'–');set('atlasMatchMargin',spanText(span));
 const cautions=cautionsOf(result,span);
 const near=$('atlasMatchUncertain'),size=$('atlasMatchSize');if(near)near.hidden=!cautions.includes('uncertain');if(size)size.hidden=!cautions.includes('size');
 if(table)table.hidden=false;if(save)save.disabled=false;
 const explorer=window.CerebellumAtlasExplorer;explorer?.selectPlane?.(best.plate_index);
 const lines={};for(const[name,v]of Object.entries(result.placed))if(['Cb','GL_TOTAL','WM','PL_TOTAL'].includes(name))lines[name]=v.paths.map(p=>v.closed?p.concat([p[0]]):p);
 explorer?.loadPlaced?.({schema:'cerebellum-atlas-placed-stack/1',unit:'um',coordinate_order:['AP','DV','Lateral'],statement:result.statement,atlas_source_sha256:atlas.source?.sha256,animals:{[input.name||'section']:{sections:[{sample:input.name||'section',z:best.lateral_um,rois:lines}]}}});
 last={schema:result.schema,statement:result.statement,made_in:'browser',cautions,section:input.name,outlines_approved:input.approved,um_per_pixel:input.umPerPixel,atlas_source_sha256:atlas.source?.sha256||null,parameters:result.parameters,names_used:result.names_used,granular_outline:result.granular_outline,candidates_tried:result.candidates_tried,best:result.best,runner_up:result.runner_up,margin_um:result.margin_um,planes_about_as_close:span,caution_rules:{status:'proposed',uncertain_when_span_over_um:WIDE_UM,size_when_scale_at_limit:true},all:result.all};
 say(input.approved?'The closest plane is shown and the section is laid on it. This is an estimate from shape alone, not a measured position; left and right are not told apart.':'The closest plane is shown and the section is laid on it. These outlines are a draft and are not approved. This is an estimate from shape alone, not a measured position; left and right are not told apart.');}
run.addEventListener('click',()=>{let input,atlas;
 try{input=section();atlas=window.CerebellumAtlasExplorer?.atlas?.();if(!atlas)throw Error('The atlas is still loading. Try again in a moment.');}catch(error){say(error.message);return;}
 busy(true);say('Comparing the section with every atlas plane. This takes up to a minute and runs on this computer.');
 worker=new Worker('./assets/atlas_match_worker.js');
 worker.onmessage=event=>{const m=event.data;if(m.progress){if(bar){bar.max=m.progress[1];bar.value=m.progress[0];}return;}
  finish();if(m.error){say(m.error);return;}try{show(m.result,input,atlas);}catch(error){say(String(error.message||error));}};
 worker.onerror=()=>{finish();say('The comparison could not be completed in this browser.');};
 worker.postMessage({outlines:input.outlines,umPerPixel:input.umPerPixel,width:input.width,height:input.height,parameters:{scale_range:WIDE_SCALE},atlas:{unit:atlas.unit,plates:atlas.plates.map(p=>({figure:p.figure,lateral_um:p.lateral_um,labels:p.labels,paths:p.paths.filter(q=>q.role==='boundary_ink'||q.role==='published_compartment').map(q=>({role:q.role,closed:q.closed,points:q.points}))}))}});});
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
  if(!(um>0)||!Number.isFinite(um)||(Number.isFinite(umY)&&umY>0&&Math.abs(umY-um)>um*.001)||!outlines.some(o=>o.name==='CB'))skipped.push(section.id);else jobs.push({id:section.id,outlines,umPerPixel:um,width:section.source?.width,height:section.source?.height});}
 if(!jobs.length){say('No section of this animal has both a whole-cerebellum outline and a pixel size.');return;}
 const sent={unit:atlas.unit,plates:atlas.plates.map(p=>({figure:p.figure,lateral_um:p.lateral_um,labels:p.labels,paths:p.paths.filter(q=>q.role==='boundary_ink'||q.role==='published_compartment').map(q=>({role:q.role,closed:q.closed,points:q.points}))}))};
 const planes=atlas.plates.length,done=new Array(jobs.length).fill(0),results=new Array(jobs.length).fill(null),ranges=new Array(jobs.length).fill(WIDE_SCALE);let queue=jobs.map((_,i)=>i),total=jobs.length*planes,passed=0,second=false,failed=null,animalScale=null;
 const finishAll=()=>{stackWorkers.forEach(w=>w.terminate());stackWorkers=[];stackBusy(false);refreshAnimals();if(failed){say(failed);return;}
  const rows=jobs.map((job,i)=>{const r=results[i],best=r.best,span=similar(r),cautions=cautionsOf(r,span);if(animalScale&&animalScale.rematched.includes(job.id)&&!cautions.includes('size')&&(best.scale<=animalScale.band[0]*1.001||best.scale>=animalScale.band[1]*.999))cautions.push('size');
   const px=r.areas_px2,mm2=n=>px&&px[n]!=null?px[n]*job.umPerPixel*job.umPerPixel/1e6:null;
   return{section:job.id,um_per_pixel:job.umPerPixel,scale_range:r.parameters.scale_range,granular_outline:r.granular_outline,area_mm2:{Cb:mm2('Cb'),GL_TOTAL:mm2('GL_TOTAL'),WM:mm2('WM')},cautions,best,runner_up:r.runner_up,margin_um:r.margin_um,planes_about_as_close:span,placed:r.placed};});
  const sections=rows.map(row=>{const lines={};for(const[name,v]of Object.entries(row.placed))if(['Cb','GL_TOTAL','WM','PL_TOTAL'].includes(name))lines[name]=v.paths.map(p=>v.closed?p.concat([p[0]]):p);return{sample:row.section,z:row.best.lateral_um,rois:lines};});
  window.CerebellumAtlasExplorer?.loadPlaced?.({schema:'cerebellum-atlas-placed-stack/1',unit:'um',coordinate_order:['AP','DV','Lateral'],statement:results[0].statement,atlas_source_sha256:atlas.source?.sha256,animals:{[animal.id]:{group:animal.group||undefined,sections}}});
  if(list){list.replaceChildren(...rows.map(row=>{const tr=document.createElement('tr');for(const text of[row.section,String(row.best.plate_index+1),fmt(row.best.lateral_um/1000,2)+' mm',fmt(row.best.distance_um,0)+' µm',spanText(row.planes_about_as_close)]){const td=document.createElement('td');td.textContent=text;td.translate=false;tr.append(td);}
    const flag=document.createElement('td');flag.dataset.cautions=row.cautions.join(' ');flag.textContent=row.cautions.length?'!':'';flag.translate=false;tr.append(flag);if(row.cautions.length)tr.className='is-caution';return tr;}));$('atlasMatchStackTable').hidden=false;}
  if(table)table.hidden=true;for(const id of['atlasMatchUncertain','atlasMatchSize']){const n=$(id);if(n)n.hidden=true;}
  stacked=rows.map(row=>({sample:row.section,lateral_um:row.best.lateral_um,values:row.area_mm2}));stackedPlanes=atlas.plates.map(p=>p.lateral_um);
  // Model drafts that nobody has reviewed often land on the wrong plane; say so rather than show them as if they were settled.
  const drafts=animal.sections.filter(x=>x.origin==='model'&&!x.review&&jobs.some(j=>j.id===x.id)).map(x=>x.id),draftNote=$('atlasMatchDrafts');if(draftNote)draftNote.hidden=!drafts.length;
  lastStack={schema:'cerebellum-atlas-match/1',statement:results[0].statement,made_in:'browser',animal:animal.id,group:animal.group||null,atlas_source_sha256:atlas.source?.sha256||null,parameters:results[0].parameters,caution_rules:{status:'proposed',uncertain_when_span_over_um:WIDE_UM,size_when_scale_at_limit:true},animal_scale:animalScale,unreviewed_model_drafts:drafts,sections_matched:rows.length,sections_skipped:skipped,sections:rows.map(({placed,...row})=>row)};last=lastStack;showVolumes();if(save)save.disabled=false;
  const positions=new Set(rows.map(r=>r.best.plate_index)).size;$('atlasMatchStackCount').textContent=rows.length+' · '+positions+(skipped.length?' · '+skipped.length:'');
  say(rows.some(r=>r.cautions.length)?'The sections are stacked at their closest planes. Rows marked ! are uncertain. These are estimates from shape alone, not measured positions; left and right are not told apart.':'The sections are stacked at their closest planes. These are estimates from shape alone, not measured positions; left and right are not told apart.');};
 /* After every section has been matched once: the animal's typical size change is the median over the sections that did
    not end at a limit of the wide range. A section outside the band around it is matched again inside the band. */
 const secondPass=()=>{const free=results.map(r=>r.best.scale).filter(v=>v>WIDE_SCALE[0]*1.001&&v<WIDE_SCALE[1]*.999).sort((x,y)=>x-y);
  if(free.length<ANIMAL_MIN_SECTIONS){animalScale={status:'proposed',applied:false,reason:'Fewer than '+ANIMAL_MIN_SECTIONS+' sections fitted away from the limits of the wide range.',wide_range:WIDE_SCALE};return false;}
  const median=free.length%2?free[(free.length-1)/2]:(free[free.length/2-1]+free[free.length/2])/2,band=[median*(1-ANIMAL_BAND),median*(1+ANIMAL_BAND)],again=[];
  results.forEach((r,i)=>{if(r.best.scale<band[0]||r.best.scale>band[1])again.push(i);});
  animalScale={status:'proposed',applied:true,median_scale:median,band,band_fraction:ANIMAL_BAND,wide_range:WIDE_SCALE,from_sections:free.length,rematched:again.map(i=>jobs[i].id),first_pass:again.map(i=>({section:jobs[i].id,lateral_um:results[i].best.lateral_um,scale:results[i].best.scale,distance_um:results[i].best.distance_um}))};
  if(!again.length)return false;for(const i of again){ranges[i]=band;results[i]=null;done[i]=0;}passed=(jobs.length-again.length)*planes;total=passed+again.length*planes;queue=again.slice();second=true;return true;};
 const start=()=>{if(failed||!queue.length)return false;const i=queue.shift(),w=new Worker('./assets/atlas_match_worker.js');stackWorkers.push(w);
  w.onmessage=event=>{const m=event.data;if(m.progress){done[i]=m.progress[0];if(bar){bar.max=total;bar.value=second?passed+ranges.reduce((sum,r,k)=>sum+(r===WIDE_SCALE?0:done[k]),0):done.reduce((x,y)=>x+y,0);}return;}
   if(m.error)failed=jobs[i].id+': '+m.error;else results[i]=m.result;w.terminate();stackWorkers=stackWorkers.filter(x=>x!==w);if(failed){finishAll();return;}
   if(start()||stackWorkers.length||!results.every(Boolean))return;
   if(!second&&secondPass()){for(let k=0;k<lanes;k++)start();return;}finishAll();};
  w.onerror=()=>{failed='The comparison could not be completed in this browser.';finishAll();};w.postMessage({outlines:jobs[i].outlines,umPerPixel:jobs[i].umPerPixel,width:jobs[i].width,height:jobs[i].height,parameters:{scale_range:ranges[i]},atlas:sent});return true;};
 const lanes=Math.max(1,Math.min(4,(navigator.hardwareConcurrency||2)-1,jobs.length));for(let k=0;k<lanes;k++)start();});
/* Volumes between the matched positions of the stacked animal. Over the animal's own span, or over a range typed in, so
   that two animals can be compared over the same stretch. */
let stacked=null,stackedPlanes=null;const low=$('atlasMatchRangeLow'),high=$('atlasMatchRangeHigh');
function showVolumes(){const box=$('atlasMatchVolumes'),core=window.AtlasVolumeCore,note=$('atlasMatchVolumeNote');if(!box||!core||!stacked)return;
 const a=low&&low.value.trim()!==''?Number(low.value):null,b=high&&high.value.trim()!==''?Number(high.value):null,asked=a!==null||b!==null;let made,problem='';
 try{made=core.arrange(stacked,asked&&a!==null&&b!==null&&a<b?[a,b]:null);}catch(error){box.hidden=true;return;}
 if(asked&&!made.common_range_um)problem='Give the range as two positions in micrometres, the smaller first.';
 let volumes=made.volume_mm3_own_range,range=made.range_um;
 if(made.common_range_um){if(made.volume_mm3_common_range.Cb===null)problem="This animal's sections do not reach both ends of that range.";else{volumes=made.volume_mm3_common_range;range=made.common_range_um;}}
 if(!problem&&made.positions_um.length<2)problem='A volume needs at least two different matched positions.';
 const set=(id,v)=>{const n=$(id);if(n)n.textContent=v===null||v===undefined?'–':fmt(v,2)+' mm³';};
 $('atlasMatchVolumeRange').textContent=made.positions_um.length<2?'–':fmt(range[0]/1000,2)+' – '+fmt(range[1]/1000,2)+' mm';
 set('atlasMatchVolumeCb',volumes.Cb);set('atlasMatchVolumeGL',volumes.GL_TOTAL);set('atlasMatchVolumeWM',volumes.WM);set('atlasMatchVolumeRest',volumes['Cb-GL-WM']);
 // The same volumes if every match were off by up to one plane either way
 let spread=null;try{if(made.positions_um.length>=2&&stackedPlanes)spread=core.sensitivity(stacked,stackedPlanes,volumes===made.volume_mm3_common_range?made.common_range_um:null);}catch(error){spread=null;}
 for(const[id,name]of[['atlasMatchSpreadCb','Cb'],['atlasMatchSpreadGL','GL_TOTAL'],['atlasMatchSpreadWM','WM'],['atlasMatchSpreadRest','Cb-GL-WM']]){const n=$(id),v=spread?.values?.[name];if(n)n.textContent=v?fmt(v.p2_5,2)+' – '+fmt(v.p97_5,2):'';}
 const spreadNote=$('atlasMatchSpreadNote');if(spreadNote)spreadNote.hidden=!spread||!Object.values(spread.values).some(Boolean);
 if(note){note.textContent=problem;note.hidden=!problem;}box.hidden=false;
 if(lastStack){lastStack.volumes={schema:made.schema,statement:made.statement,positions_um:made.positions_um,sections_sharing_a_position:made.sections_sharing_a_position,range_um:made.range_um,mean_area_mm2:made.mean_area_mm2,volume_mm3_own_range:made.volume_mm3_own_range,common_range_um:made.common_range_um,volume_mm3_common_range:made.volume_mm3_common_range,if_matches_are_off_by_one_plane:spread};last=lastStack;}}
for(const input of[low,high])if(input)input.addEventListener('input',showVolumes);
if(stop)stop.addEventListener('click',()=>{if(stackWorkers.length){stopStack();say('The comparison was stopped. Nothing was changed.');}});
if(animalSelect){refreshAnimals();window.addEventListener('cerebellum-workspace-open',refreshAnimals);document.querySelector('.site-header')?.addEventListener('click',()=>setTimeout(refreshAnimals,0));animalSelect.addEventListener('focus',refreshAnimals);animalSelect.addEventListener('pointerdown',refreshAnimals);new IntersectionObserver(e=>{if(e.some(x=>x.isIntersecting))refreshAnimals();}).observe(animalSelect);}
window.CerebellumAtlasMatch=Object.freeze({snapshot:()=>last?JSON.parse(JSON.stringify(last)):null,busy:()=>!!worker||stackWorkers.length>0,refreshAnimals});
})();
