/* Local preparation evidence viewer. Never imports or approves scientific inputs. */
(function(){'use strict';
const $=id=>document.getElementById(id),host=$('trainingPreparationResults'),input=$('trainingPreparationReportFile'),status=$('trainingPreparationStatus'),clear=$('trainingPreparationClear');
if(!host||!input)return;
const phases={running:'Preparation still running',complete:'Requested source preparation completed',partial_failure:'Some sections need technical attention',interrupted:'Preparation was interrupted'};
const sectionPhases={pending:'Not processed',processing:'Processing not yet completed',completed:'Source preparation completed',failed:'Preparation failed',interrupted:'Section preparation interrupted'};
let ticket=0,summary=null;
const node=(tag,text,raw=false)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text);if(raw){e.setAttribute('translate','no');e.dataset.i18nSkip='true';}return e;};
const fail=()=>{throw Error('This is not a supported training-source preparation report. Use the current local tools and keep the original report.');};
function validate(d){
 const integer=(x,max=1000000000000)=>Number.isSafeInteger(x)&&x>=0&&x<=max;
 const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
 if(!object(d)||d.schema!=='cerebellum-training-preparation/1'||!Object.hasOwn(phases,d.status)||d.training_performed!==false||d.independent_validation_established!==false||!object(d.split_assignments)||Object.keys(d.split_assignments).length||!object(d.counts)||!Array.isArray(d.sections)||typeof d.source_hashes_verified!=='boolean')fail();
 const c=d.counts;
 for(const k of ['requested_sections','completed_sections','failed_sections','unprocessed_sections'])if(!integer(c[k],20000))fail();
 if(!integer(c.tiles,100000000)||c.requested_sections!==d.sections.length||c.requested_sections<1)fail();
 let completed=0,failed=0,unprocessed=0,tiles=0,cbUnknown=0,layerUnknown=0;const ids=new Set();
 for(const r of d.sections){
  if(!object(r)||typeof r.animal_id!=='string'||!r.animal_id.length||r.animal_id.length>128||typeof r.section_id!=='string'||!r.section_id.length||r.section_id.length>512||!Object.hasOwn(sectionPhases,r.status)||!integer(r.tile_count,1000000)||typeof r.source_hashes_verified!=='boolean'||![null,'area','polyline'].includes(r.pl_total_kind)||!object(r.qc)||!integer(r.qc.cb_unknown_pixels)||!integer(r.qc.layer_unknown_pixels)||(r.error!==null&&(typeof r.error!=='string'||r.error.length>16000)))fail();
  const id=JSON.stringify([r.animal_id,r.section_id]);if(ids.has(id))fail();ids.add(id);
  if(r.status==='completed'){completed++;tiles+=r.tile_count;cbUnknown+=r.qc.cb_unknown_pixels;layerUnknown+=r.qc.layer_unknown_pixels;if(!integer(cbUnknown)||!integer(layerUnknown)||!r.source_hashes_verified||r.tile_count<1||r.error!==null)fail();}
  else {if(r.status==='failed')failed++;else unprocessed++;if(r.tile_count!==0||r.source_hashes_verified)fail();}
 }
 if(c.completed_sections!==completed||c.failed_sections!==failed||c.unprocessed_sections!==unprocessed||c.tiles!==tiles||c.requested_sections!==completed+failed+unprocessed)fail();
 if(d.source_hashes_verified!==(completed===c.requested_sections))fail();
 if(d.status==='complete'&&completed!==c.requested_sections||d.status==='partial_failure'&&failed===0)fail();
 return d;
}
function render(d){
 host.replaceChildren();const heading=node('h3',phases[d.status]),counts=node('dl');counts.className='training-preparation-counts';
 for(const [key,label]of [['requested_sections','Requested sections'],['completed_sections','Prepared sections'],['failed_sections','Failed sections'],['unprocessed_sections','Unprocessed sections'],['tiles','Prepared image tiles']]){const item=node('div');item.append(node('dt',label),node('dd',d.counts[key],true));counts.append(item);}
 host.append(heading,counts,node('p',d.source_hashes_verified?'The report records verified source hashes for every requested section.':'Source verification is incomplete. Inspect failed or unprocessed sections before using this output.'),node('p','These are preparation results reported by the local tool. This viewer does not re-read the original images, verify tile files or certify the report.'),node('p','No model was trained. Animal splits remain unassigned, and candidate labels still require the declared review and evaluation procedure.'));
 const completed=d.sections.filter(r=>r.status==='completed'),pl=completed.filter(r=>r.pl_total_kind==='area').length;
 const metrics=node('dl');metrics.className='training-preparation-counts';
 for(const [label,value]of [['Prepared sections with area-shaped PL_TOTAL',pl],['Unknown CB pixels',completed.reduce((n,r)=>n+r.qc.cb_unknown_pixels,0)],['Unknown layer pixels',completed.reduce((n,r)=>n+r.qc.layer_unknown_pixels,0)]]){const item=node('div');item.append(node('dt',label),node('dd',value,true));metrics.append(item);}
 host.append(metrics,node('p','Unknown label pixels stay unknown. Area-shaped PL_TOTAL annotations are preserved and are not converted into line length.'));
 const list=node('ol');list.className='training-preparation-sections';const ordered=[...d.sections].sort((a,b)=>(a.status==='completed'?1:0)-(b.status==='completed'?1:0));
 for(const r of ordered.slice(0,100)){const item=node('li');item.append(node('strong',r.section_id,true),document.createTextNode(' · '),node('span',sectionPhases[r.status]));if(r.status==='completed'){const p=node('p');p.append(node('span','Prepared image tiles'),document.createTextNode(': '),node('span',r.tile_count,true));item.append(p);if(r.pl_total_kind==='area')item.append(node('p','PL_TOTAL remains an area annotation; its line length is not inferred.'));}if(r.error)item.append(node('p',r.error,true));list.append(item);}
 host.append(node('h4','Section preparation details'),list);if(ordered.length>100)host.append(node('p','Only the first 100 sections are shown. Keep the full local preparation report and section outputs.'));
 host.hidden=false;window.CerebellumI18n?.refresh();
}
input.addEventListener('change',async()=>{const id=++ticket,file=input.files?.[0];summary=null;host.replaceChildren();host.hidden=true;clear.disabled=!file;if(!file){status.dataset.state='ready';status.textContent='No training-source preparation report opened.';return;}status.dataset.state='loading';status.textContent='Reading local preparation report…';try{if(file.size>8*1024*1024)throw Error('Preparation report exceeds 8 MiB. Open a smaller local preparation report.');const d=validate(JSON.parse(await file.text()));if(id!==ticket)return;summary=d;render(d);status.dataset.state='ready';status.textContent='Preparation report opened locally. No files were uploaded and no model was trained.';}catch(error){if(id!==ticket)return;status.dataset.state='error';status.textContent=error instanceof SyntaxError?'This is not a supported training-source preparation report. Use the current local tools and keep the original report.':error.message;}window.CerebellumI18n?.refresh();});
clear.addEventListener('click',()=>{ticket++;summary=null;input.value='';host.replaceChildren();host.hidden=true;clear.disabled=true;status.dataset.state='ready';status.textContent='No training-source preparation report opened.';});
window.CerebellumTrainingPreparation=Object.freeze({validate,snapshot:()=>summary?{schema:summary.schema,status:summary.status,counts:{...summary.counts},training_performed:false}:null});
})();
