/* UI-only suggestions and optional local timing. Never changes ROI or approval. */
(function(){'use strict';
const C=window.AnalysisWorkflowCore,$=id=>document.getElementById(id),host=$('analysisWorkflow');
if(!C||!host)return;
let context={},signature='',clock=C.createClock(),sourceKey=null;
const previous=[];
const element=(tag,text,className)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(className)n.className=className;return n;};
const heading=element('h3','Suggested next steps'),note=element('p','Suggestions use the current inputs. They do not establish anatomical correctness.','mini');
heading.id='analysisWorkflowTitle';host.setAttribute('aria-labelledby',heading.id);host.className='analysis-workflow';
const cards=element('div',null,'analysis-workflow-cards'),timing=element('details',null,'help-detail analysis-workflow-timing');
timing.append(element('summary','Optional work timer'),element('p','Record foreground review time for this image. Recording pauses during processing, outside this view, in hidden tabs and after 60 seconds without interaction. This is a time estimate, not evidence of time savings.','mini'));
const readout=element('output','00:00');readout.id='analysisWorkElapsed';readout.setAttribute('aria-label','Recorded review time');readout.setAttribute('translate','no');
const timerState=element('span','Timer paused');timerState.id='analysisWorkTimerState';
const actions=element('div',null,'analysis-actions'),start=element('button','Start timer'),pause=element('button','Pause timer'),download=element('button','Download timing record');
start.id='analysisWorkTimerStart';pause.id='analysisWorkTimerPause';download.id='analysisWorkTimerDownload';
for(const b of [start,pause,download])b.type='button';
actions.append(start,pause,download);timing.append(readout,timerState,actions,element('p','Timing stays in this open page and is separate from ROI approval and browser recovery. Download the record before closing or reloading.','mini'));host.append(heading,note,cards,timing);
function panelVisible(){return !document.hidden&&!!$('analysisPanel')?.getClientRects().length&&!$('analysisPanel')?.closest('[hidden]');}
function block(){clock.block(!!context.busy||!panelVisible()||!context.hasSource);}
function renderTimer(){block();const s=clock.snapshot(),seconds=Math.floor(s.elapsed_ms/1000);readout.textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');const text=!s.recording?'Timer paused':s.active?'Recording review time':'Recording paused automatically';if(timerState.dataset.source!==text){timerState.textContent=text;timerState.dataset.source=text;}start.disabled=!context.hasSource||!!context.busy||s.recording;pause.disabled=!s.recording;download.disabled=!s.elapsed_ms&&!previous.length;}
function focusTarget(id){const trigger=document.activeElement;window.CerebellumFocusCards?.closeAllDetails();const target=$(id);if(!target)return;const detail=target.parentElement?.closest('details');for(let parent=target.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS'&&parent!==detail)parent.open=true;if(!target.matches('button,input,select,textarea,a[href]'))target.tabIndex=-1;if(detail)window.CerebellumFocusCards?.openDetails(detail,trigger);window.CerebellumMotion.focusAfterReveal(target,{isCurrent:()=>window.CerebellumWorkspace?.snapshot().mode==='image',scroll:true,block:'center'});}
function renderCards(){const data=C.suggestions(context),next=JSON.stringify(data);if(signature===next)return;signature=next;cards.replaceChildren(...data.map(card=>{const item=element('article',null,'analysis-workflow-card');item.dataset.task=card.id;item.append(element('h4',card.title),element('p',card.detail,'mini'));if(card.target){const button=element('button','Go to this step');button.type='button';button.disabled=!card.available;button.dataset.target=card.target;button.addEventListener('click',()=>focusTarget(card.target));item.append(button);}else item.append(element('span','Development step','mini'));return item;}));}
function update(value){
 const next=value||{};if(sourceKey!==next.sourceKey){clock.pause();const old=clock.snapshot();if(sourceKey&&old.elapsed_ms)previous.push({source_sha256:sourceKey,...old,ended_at:new Date().toISOString()});clock=C.createClock();sourceKey=next.sourceKey||null;}
 context={...next};renderCards();renderTimer();
}
start.addEventListener('click',()=>{block();clock.start();renderTimer();});pause.addEventListener('click',()=>{clock.pause();renderTimer();});
download.addEventListener('click',()=>{const current=clock.snapshot(),record={schema:'cerebellum-review-timing/1',created_at:new Date().toISOString(),method:'Opt-in foreground interaction time; processing, other views, hidden tabs and inactivity after 60 seconds excluded. This is not validated labor time or demonstrated savings.',records:[...previous,...(sourceKey&&current.elapsed_ms?[{source_sha256:sourceKey,...current}]:[])]},url=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)+'\n'],{type:'application/json'})),a=element('a');a.href=url;a.download='cerebellum-review-timing.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
for(const name of ['pointerdown','pointermove','keydown','input','wheel'])$('analysisPanel')?.addEventListener(name,event=>{if(!event.isTrusted)return;block();clock.activity();},{passive:true});
document.addEventListener('visibilitychange',renderTimer);window.addEventListener('cerebellum-workspace-open',renderTimer);window.addEventListener('cerebellum-view-change',renderTimer);window.addEventListener('pagehide',()=>clock.pause());
setInterval(renderTimer,1000);
window.AnalysisWorkflow=Object.freeze({update,timing:()=>({...clock.snapshot(),source_sha256:sourceKey}),suggestions:()=>C.suggestions(context)});update({});
})();
