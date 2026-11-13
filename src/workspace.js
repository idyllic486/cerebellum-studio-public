/* Focused navigation over the existing tools. Hiding a pane never resets its inputs or data. */
(() => {'use strict';
const $=id=>document.getElementById(id),root=$('researchView');
if(!root||!$('workspaceNav'))return;
// Presentation-only motion. No DOM snapshots, cloned canvases or delayed state changes.
const reduceMotion=matchMedia('(prefers-reduced-motion: reduce)'),animations=new Map();
function cancelMotion(element){const animation=animations.get(element);if(animation){animations.delete(element);animation.cancel();}}
function cancelAllMotion(){for(const element of [...animations.keys()])cancelMotion(element);}
function enterMotion(element,{distance=8,duration=360}={}){
 if(!element)return;cancelMotion(element);
 if(reduceMotion.matches||!element.animate||!element.getClientRects().length)return;
 const animation=element.animate([{opacity:.35,transform:'translateY('+distance+'px)'},{opacity:1,transform:'translateY(0)'}],{duration,easing:'cubic-bezier(.2,.75,.25,1)'});
 animations.set(element,animation);
 const clear=()=>{if(animations.get(element)===animation)animations.delete(element);};
 animation.finished.then(clear,clear);
}
reduceMotion.addEventListener('change',()=>{if(reduceMotion.matches)cancelAllMotion();});
// Native animated <details> content can remain non-focusable for its first
// rendering frame. Retry only this navigation's focus, never a later user action.
let focusTicket=0,pendingFocus=null;
function cancelDeferredFocus(){focusTicket++;pendingFocus=null;}
document.addEventListener('pointerdown',cancelDeferredFocus,true);
document.addEventListener('keydown',cancelDeferredFocus,true);
document.addEventListener('focusin',event=>{if(pendingFocus&&event.target!==pendingFocus)cancelDeferredFocus();},true);
function focusAfterReveal(element,{isCurrent=()=>true,scroll=false,scrollTarget=element,block='center'}={}){
 const ticket=++focusTicket,expires=performance.now()+1000;pendingFocus=element;
 const finish=()=>{if(ticket===focusTicket)pendingFocus=null;};
 const attempt=()=>{
  if(ticket!==focusTicket||!isCurrent()||!element?.isConnected||element.disabled||element.closest('[hidden],.hidden')||element.parentElement?.closest('details:not([open])')){finish();return;}
  if(element.getClientRects().length)element.focus({preventScroll:true});
  if(document.activeElement===element){if(scroll)scrollTarget?.scrollIntoView({block,behavior:'auto'});finish();return;}
  if(performance.now()<expires)requestAnimationFrame(attempt);else finish();
 };
 requestAnimationFrame(()=>requestAnimationFrame(attempt));
}
window.CerebellumMotion=Object.freeze({enter:enterMotion,cancel:cancelMotion,cancelAll:cancelAllMotion,activeCount:()=>animations.size,focusAfterReveal,cancelDeferredFocus});
const modes=['home','image','observations','study','tools'];
const summaries={home:'See the path your research follows here, from one section to a finished study.',image:'Review one original section, edit its boundaries and approve a traceable result.',observations:'Register source images, ROI files and measurements as observed sections.',study:'Carry reviewed sections into calibrated 3D and animal-level comparison.',tools:'Explore reconstruction assumptions in experiments kept separate from your source data.'};
const can={'home':'Read the three stages, then move with the menu below. Back up your workspaces at the end of this page.', 'image':'Open a TIFF, draw or import ROIs, let the built-in model draft them, correct the boundaries and set the pixel size.', 'observations':'Match each image with its ROI file and measurement CSV, record exclusions and look at the sections together.', 'study':'Add reviewed sections to animals, enter position, thickness and group, then align and compare.', 'tools':'Change the interpolation method, spacing and noise on copies of the data and compare the outcomes.'},get={'home': 'A clear order of work, with your files kept on this computer throughout.', 'image': 'Approved ROIs, a measurement table and a review record to download.', 'observations': 'Observed sections with their sources linked, ready to go into a study.', 'study': 'A 3D stack for each animal and comparison tables at the level of animals.', 'tools': 'A view of how much a reconstruction depends on those assumptions. Your sources stay untouched.'};
const targets={home:'workspaceHome',image:'analysisPanel',observations:'researchInputTitle',study:'studyPanel',tools:'methodsPanel'};
let current='home',tool='methods',navigation=0;
function identify(target){const id=String(target||'').replace(/^#/,'');if(['researchView','workspaceHome','workspaceHeader','workspaceTitle'].includes(id))return{mode:'home',target:'workspaceHome'};const node=$(id);if(!node||!root.contains(node))return null;const pane=node.closest('[data-workspace-pane]');if(!pane)return null;const mode=pane.dataset.workspacePane;if(!modes.includes(mode))return null;let selectedTool;if(mode==='tools')selectedTool=node.closest('#spatialPanel')?'spatial':node.closest('#labPanel')?'lab':'methods';return{mode,target:id,tool:selectedTool};}
function toolsView(){const panel=$('methodsPanel');if(!panel)return;for(const node of panel.children){const shared=node.getAttribute('aria-labelledby')==='methodsSetupTitle',kind=node.id==='labPanel'?'lab':node.id==='spatialPanel'?'spatial':'methods';node.classList.toggle('workspace-tool-hidden',!shared&&kind!==tool);}const pane=$('workspaceTools');pane.dataset.workspaceToolActive=tool;document.querySelectorAll('[data-workspace-tool]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.workspaceTool===tool)));}
function updateHash(target,replace=false){const hash='#'+target;if(location.hash===hash)return;try{history[replace?'replaceState':'pushState'](null,'',location.pathname+location.search+hash);}catch{/* Navigation still works when a host restricts browser history. */}}
function refreshViews(){window.dispatchEvent(new Event('resize'));window.dispatchEvent(new CustomEvent('cerebellum-workspace-open',{detail:{mode:current,tool:current==='tools'?tool:null}}));}
function open(mode,options={}){const previousMode=current,previousTool=tool;if(!modes.includes(mode))throw Error('Unknown workspace mode: '+mode);window.CerebellumFocusCards?.closeAllDetails();cancelDeferredFocus();const selected=options.target?identify(options.target):null;if(selected&&selected.mode===mode&&selected.tool)tool=selected.tool;if(options.tool&&['methods','lab','spatial'].includes(options.tool))tool=options.tool;current=mode;const ticket=++navigation;
 if(root.classList.contains('hidden'))document.querySelector('.site-header [data-tab="research"]')?.click();
 root.dataset.workspaceMode=mode;root.querySelectorAll('[data-workspace-pane]').forEach(pane=>{cancelMotion(pane);pane.hidden=pane.dataset.workspacePane!==mode;});$('workspaceToolsNav').hidden=mode!=='tools';$('workspaceModeSummary').textContent=summaries[mode];$('workspaceModeCan').textContent=can[mode];$('workspaceModeGet').textContent=get[mode];document.querySelectorAll('#workspaceNav [data-workspace-mode]').forEach(button=>{const active=button.dataset.workspaceMode===mode;if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});toolsView();
 let target=selected?.mode===mode?selected.target:mode==='tools'?(tool==='methods'?'methodsPanel':tool==='lab'?'labPanel':'spatialPanel'):targets[mode];const element=$(target),studyPage=element?.closest('.study-step-page');if(studyPage&&mode==='study')$('studyTab'+studyPage.id.replace('studyPage',''))?.click();
 if(element){for(let parent=element.parentElement;parent&&parent!==root;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;}
 if(options.history!==false)updateHash(mode==='home'?'researchView':target,options.replace===true);
 requestAnimationFrame(()=>{if(ticket!==navigation)return;if(previousMode!==mode||previousTool!==tool)enterMotion(root.querySelector('[data-workspace-pane="'+mode+'"]'));refreshViews();const focusTarget=element&&element.getClientRects().length?element:mode==='home'?$('workspaceStartTitle'):$(targets[mode]);const scrollTarget=mode==='tools'&&options.target?focusTarget:$('workspaceHeader');if(options.focus!==false&&focusTarget){if(!focusTarget.hasAttribute('tabindex')&&!focusTarget.matches('button,input,select,textarea,a[href]'))focusTarget.tabIndex=-1;focusAfterReveal(focusTarget,{isCurrent:()=>ticket===navigation,scroll:options.scroll!==false,scrollTarget,block:'start'});}else if(options.scroll!==false)scrollTarget?.scrollIntoView({block:'start',behavior:'auto'});});
 return{mode:current,tool:current==='tools'?tool:null};
}
function routeHash(){let id;try{id=decodeURIComponent(location.hash.slice(1));}catch{return;}const route=identify(id);if(route)open(route.mode,{...route,history:false,focus:false,scroll:true});}
document.addEventListener('click',event=>{if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;const button=event.target.closest('[data-workspace-open],#workspaceNav [data-workspace-mode],[data-workspace-tool]');if(button){const mode=button.dataset.workspaceOpen||button.dataset.workspaceMode||'tools';if(!modes.includes(mode))return;event.preventDefault();/* Pressed in the menu itself: the menu stays exactly where it is on screen, the page does not jump to the top of the workspace. */const nav=button.closest('#workspaceNav'),before=nav?nav.getBoundingClientRect().top:0;open(mode,{target:button.dataset.workspaceTarget,tool:button.dataset.workspaceTool,scroll:nav?false:undefined});if(nav){const after=nav.getBoundingClientRect().top;if(Math.abs(after-before)>.5)window.scrollBy({top:after-before,behavior:'instant'});}return;}const link=event.target.closest('a[href]');if(!link||link.hasAttribute('download')||link.target==='_blank')return;let url;try{url=new URL(link.href,location.href);}catch{return;}if(url.origin!==location.origin||url.pathname!==location.pathname||url.search!==location.search||!url.hash)return;let id;try{id=decodeURIComponent(url.hash.slice(1));}catch{return;}const route=identify(id);if(route){event.preventDefault();open(route.mode,route);}},true);
$('workspaceNav').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;const buttons=[...$('workspaceNav').querySelectorAll('[data-workspace-mode]')],index=buttons.indexOf(document.activeElement);if(index<0)return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:buttons.length-1))%buttons.length;buttons[next].focus();});
document.querySelectorAll('.site-header [data-tab="research"]').forEach(button=>button.addEventListener('click',()=>requestAnimationFrame(refreshViews)));window.addEventListener('hashchange',routeHash);window.addEventListener('popstate',routeHash);
const guide=$('workspaceGuide'),guideToggle=$('workspaceGuideToggle'),guideCards=[...guide.querySelectorAll('[data-workspace-guide-card]')];let guideStep=0;
function renderGuide(direction=0){guideCards.forEach((card,index)=>card.hidden=index!==guideStep);$('workspaceGuideProgress').textContent=`${guideStep+1} / ${guideCards.length}`;$('workspaceGuidePrevious').disabled=guideStep===0;$('workspaceGuideNext').textContent=guideStep===guideCards.length-1?'Finish guide':'Next';guide.querySelector('.focus-card-content').scrollTop=0;if(direction)window.CerebellumFocusCards?.slide(guideCards[guideStep],direction);window.CerebellumI18n?.refresh(guide);}
guideToggle.addEventListener('click',()=>{guideStep=0;renderGuide();window.CerebellumFocusCards.open(guide,guideToggle);guideToggle.setAttribute('aria-expanded','true');});
$('workspaceGuideClose').addEventListener('click',()=>window.CerebellumFocusCards.close(guide));
$('workspaceGuidePrevious').addEventListener('click',()=>{if(guideStep>0){guideStep--;renderGuide(-1);}});
$('workspaceGuideNext').addEventListener('click',()=>{if(guideStep===guideCards.length-1){window.CerebellumFocusCards.close(guide);return;}guideStep++;renderGuide(1);});
guide.addEventListener('close',()=>guideToggle.setAttribute('aria-expanded','false'));
window.CerebellumWorkspace=Object.freeze({open,snapshot:()=>({mode:current,tool:current==='tools'?tool:null})});
// Initial rendering must not navigate away from Explore unless the URL names a workspace tool.
root.dataset.workspaceMode='home';toolsView();const initial=identify(location.hash.slice(1));if(initial)open(initial.mode,{...initial,history:false,focus:false});
})();
