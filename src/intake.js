/* Read-only local inventory summary. Never imports files into scientific state. */
(function(){'use strict';
const $=id=>document.getElementById(id),host=$('intakeResults'),input=$('intakeReportFile'),status=$('intakeStatus'),clear=$('intakeClear');
if(!host||!input)return;
// Animal names come from the report itself; the site holds no fixed list.
const animalId=/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/,listed=x=>Array.isArray(x)&&x.length<=64&&new Set(x).size===x.length&&x.every(v=>typeof v==='string'&&animalId.test(v)),byNumber=(a,b)=>a.localeCompare(b,'en',{numeric:true}),countKeys=['section_candidates','unique_image_roi_candidates','structural_bounds_checked','structural_bounds_passed','ambiguous_candidates','missing_image_or_roi','complete_image_roi_csv_candidates','approved_training_pairs'];
const reasons={'ambiguous-file-candidates':'Several files could match this section.','missing-image':'Source image is missing.','missing-roi':'ROI file is missing.','file-inspection-issues':'File inspection needs technical attention.','identical-source-image-across-animals':'The same image bytes appear under different animals.','identical-source-image-across-sections':'The same image bytes appear under different sections.','roi-outside-image-bounds':'ROI coordinates extend outside the image.','coordinate-check-unavailable':'Coordinate checks could not be completed.','image-layout-needs-explicit-preparation':'Image pages or orientation need preparation.','confirm-source-pair-and-metadata':'Confirm the source pair and missing experiment metadata.'};
let ticket=0,summary=null;
const node=(tag,text,raw=false)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text);if(raw){e.setAttribute('translate','no');e.dataset.i18nSkip='true';}return e;};
const fail=()=>{throw Error('This is not a supported readiness report. Run the current local inventory tools again.');};
function validate(d){
 if(!d||Array.isArray(d)||d.schema!=='cerebellum-intake-readiness/1'||d.status!=='requires_source_confirmation'||d.training_ready!==false||d.calibration_verified!==false||d.specific_damaged_sections_inferred!==false||!d.counts||!Array.isArray(d.review_queue)||!Array.isArray(d.animals_with_section_candidates))fail();
 const integer=x=>Number.isSafeInteger(x)&&x>=0&&x<=1000000;
 for(const k of countKeys)if(!integer(d.counts[k]))fail();
 for(const k of ['discovered_files','unresolved_identity_file_count','scan_issue_count'])if(!integer(d[k]))fail();
 const c=d.counts;
 if(c.approved_training_pairs!==0||c.section_candidates!==d.review_queue.length||c.section_candidates>20000||c.unique_image_roi_candidates>c.section_candidates||c.structural_bounds_checked>c.unique_image_roi_candidates||c.structural_bounds_passed>c.structural_bounds_checked||c.complete_image_roi_csv_candidates>c.unique_image_roi_candidates||c.ambiguous_candidates>c.section_candidates||c.missing_image_or_roi>c.section_candidates)fail();
 if(!listed(d.animals_with_section_candidates))fail();
 if(d.animals_expected!==undefined&&(!listed(d.animals_expected)||d.animals_with_section_candidates.some(x=>!d.animals_expected.includes(x))))fail();
 for(const row of d.review_queue){if(!row||!d.animals_with_section_candidates.includes(row.animal_id)||typeof row.section_id!=='string'||!row.section_id.length||row.section_id.length>512||!['ambiguous','missing','needs_preparation','unique_candidate'].includes(row.status)||!['resolve','review'].includes(row.priority)||!Array.isArray(row.reasons)||!row.reasons.length||row.reasons.length>20||row.reasons.some(x=>!Object.hasOwn(reasons,x))||typeof row.csv_available!=='boolean')fail();}
 const found=[...new Set(d.review_queue.map(r=>r.animal_id))].sort();if(JSON.stringify(found)!==JSON.stringify([...d.animals_with_section_candidates].sort()))fail();
 return d;
}
function render(d){
 host.replaceChildren();const heading=node('h3','Source preparation summary'),note=node('p','Counts describe discovered section candidates, not all expected biological sections. Coordinate bounds alone do not establish alignment or anatomy.');
 const counts=node('dl');counts.className='intake-counts';
 for(const [key,label]of [['section_candidates','Discovered section candidates'],['unique_image_roi_candidates','Unique image–ROI candidates'],['structural_bounds_passed','Coordinate bounds passed'],['ambiguous_candidates','Ambiguous candidates'],['missing_image_or_roi','Missing image or ROI'],['complete_image_roi_csv_candidates','Image, ROI and CSV candidates']]){const item=node('div');item.append(node('dt',label),node('dd',d.counts[key],true));counts.append(item);}
 const animals=node('ul');animals.className='intake-animals';for(const id of [...(d.animals_expected||d.animals_with_section_candidates)].sort(byNumber)){const li=node('li');li.append(node('span',id,true),document.createTextNode(' · '),node('span',d.animals_with_section_candidates.includes(id)?'Section candidates found':'No section candidates found'));animals.append(li);}
 const queue=node('ol');queue.className='intake-queue';const ordered=[...d.review_queue].sort((a,b)=>(a.priority==='resolve'?0:1)-(b.priority==='resolve'?0:1));for(const row of ordered.slice(0,100)){const li=node('li');li.append(node('strong',row.section_id,true));for(const reason of row.reasons)li.append(node('p',reasons[reason]));queue.append(li);}
 host.append(heading,note,counts,node('h4','Animal coverage'),animals,node('p','Training is not ready. Technical exceptions are handled by software; the researcher confirms biological identity and missing experiment facts.'),node('h4','Next source checks'),queue);
 if(ordered.length>100)host.append(node('p','Only the first 100 checks are shown. The local review-queue.csv contains the full list.'));
 if(d.unresolved_identity_file_count||d.scan_issue_count){const p=node('p','Additional files or scan issues could not be assigned to sections. Review the local file inventory before assuming this collection is complete.');host.append(p);}
 if(!ordered.length)host.append(node('p','No section candidates were identified. Check the selected source folder and local file inventory.'));
 host.hidden=false;window.CerebellumI18n?.refresh();
}
input.addEventListener('change',async()=>{const id=++ticket,file=input.files?.[0];host.hidden=true;host.replaceChildren();summary=null;clear.disabled=!file;if(!file){status.textContent='No readiness report opened.';return;}status.dataset.state='loading';status.textContent='Reading local readiness report…';try{if(file.size>8*1024*1024)throw Error('Readiness report exceeds 8 MiB. Open a report for a smaller source collection.');const d=validate(JSON.parse(await file.text()));if(id!==ticket)return;summary=d;render(d);status.dataset.state='ready';status.textContent='Local report opened. No files were uploaded or approved.';}catch(error){if(id!==ticket)return;status.dataset.state='error';status.textContent=error instanceof SyntaxError?'This is not a supported readiness report. Run the current local inventory tools again.':error.message;}window.CerebellumI18n?.refresh();});
clear.addEventListener('click',()=>{ticket++;summary=null;input.value='';host.replaceChildren();host.hidden=true;clear.disabled=true;status.dataset.state='ready';status.textContent='No readiness report opened.';});
window.CerebellumIntake=Object.freeze({validate,snapshot:()=>summary?{schema:summary.schema,counts:{...summary.counts},training_ready:false}:null});
})();
