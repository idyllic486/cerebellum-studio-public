/* Consistent postcards. Existing research nodes keep their identity and ancestry. */
(() => {
  'use strict';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)'), animations = new Map(), origins = new WeakMap(), managed = new Set(), disclosures = new Map();
  const $ = id => document.getElementById(id);
  function usableOrigin(node) {
    if (!(node instanceof HTMLElement) || node===document.body || node===document.documentElement || !node.isConnected || !node.getClientRects().length || node.closest('[hidden],.hidden')) return false;
    const style=getComputedStyle(node);if(style.visibility==='hidden'||style.visibility==='collapse'||style.display==='none')return false;
    // CSS clipping can leave non-empty rectangles on descendants of a closed
    // details element. Its direct summary remains a valid, visible trigger.
    for(let parent=node.parentElement;parent;parent=parent.parentElement){
      if(parent.tagName==='DETAILS'&&!parent.open){
        const summary=[...parent.children].find(child=>child.tagName==='SUMMARY');
        if(!summary?.contains(node))return false;
      }
    }
    return true;
  }
  function restoreFocus(node) {
    node.focus({preventScroll:true});
    const rect=node.getBoundingClientRect();
    if(rect.top<0||rect.left<0||rect.bottom>innerHeight||rect.right>innerWidth)node.scrollIntoView({block:'nearest',inline:'nearest',behavior:'auto'});
  }
  function cancel(element) { const animation = animations.get(element); if (animation) { animations.delete(element); animation.cancel(); } }
  function animate(element, frames, duration) {
    cancel(element);
    if (reduced.matches || !element.animate) return;
    const animation = element.animate(frames, {duration, easing:'cubic-bezier(.2,.75,.25,1)'});
    animations.set(element, animation);
    const clear = () => { if (animations.get(element) === animation) animations.delete(element); };
    animation.finished.then(clear, clear);
  }
  function syncLock() { document.body.classList.toggle('focus-card-open', [...managed].some(dialog => dialog.open)); }
  function prepare(dialog) {
    if (managed.has(dialog)) return;
    managed.add(dialog);
    dialog.classList.add('focus-card');
    // Keep keyboard traversal within the postcard even in engines which send
    // native dialog boundary tabs to browser chrome rather than wrapping.
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab' || !dialog.open) return;
      const items=[...dialog.querySelectorAll('button,input,select,textarea,a[href],summary,[tabindex]')].filter(node => node.tabIndex>=0 && !node.disabled && !node.closest('[hidden],[inert]') && node.getClientRects().length && getComputedStyle(node).visibility!=='hidden');
      const index=items.indexOf(document.activeElement);
      if (!items.length) { event.preventDefault(); dialog.focus({preventScroll:true}); return; }
      if (index<0 || (event.shiftKey ? index===0 : index===items.length-1)) {
        event.preventDefault(); items[event.shiftKey ? items.length-1 : 0].focus({preventScroll:true});
      }
    });
    let downOutside = false;
    const outside = event => { const r=dialog.getBoundingClientRect(); return event.clientX<r.left || event.clientX>r.right || event.clientY<r.top || event.clientY>r.bottom; };
    dialog.addEventListener('pointerdown', event => { downOutside = event.target===dialog && outside(event); });
    dialog.addEventListener('click', event => { if (downOutside && event.target===dialog && outside(event)) dialog.close(); downOutside=false; });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(dialog); });
    dialog.addEventListener('close', () => {
      cancel(dialog); for (const node of dialog.querySelectorAll('*')) cancel(node);
      syncLock();
      const origin=origins.get(dialog); origins.delete(dialog);
      // Other close listeners first restore the original nodes and open state.
      // A newer modal or an explicitly focused route target keeps its focus.
      queueMicrotask(()=>{
        const active=document.activeElement,top=[...document.querySelectorAll('dialog:modal')].at(-1);
        if(active!==document.body&&active!==document.documentElement&&active!==origin&&!dialog.contains(active))return;
        if(usableOrigin(origin)&&(!top||top.contains(origin)))restoreFocus(origin);
      });
    });
  }
  function open(dialog, trigger=document.activeElement, motion=true) {
    if (!dialog || dialog.open) return;
    prepare(dialog);
    const originRect=trigger?.getBoundingClientRect?.(),from=originRect?.width&&originRect?.height?originRect:null;
    origins.set(dialog, trigger);
    dialog.showModal(); syncLock();
    const to=dialog.getBoundingClientRect();
    const dx=from ? from.left+from.width/2-to.left-to.width/2 : 0;
    const dy=from ? from.top+from.height/2-to.top-to.height/2 : 16;
    const sx=from ? Math.max(.18,Math.min(1,from.width/to.width)) : .96;
    const sy=from ? Math.max(.12,Math.min(1,from.height/to.height)) : .96;
    if(motion)animate(dialog,[{transform:`translate(${dx}px,${dy}px) scale(${sx},${sy})`,opacity:0},{transform:'translate(0,0) scale(1)',opacity:1}],260);
  }
  function close(dialog) { if (dialog?.open) dialog.close(); }
  function slide(element) { cancel(element); const dialog=element?.closest("dialog"); if(dialog)cancel(dialog); }
  reduced.addEventListener('change', () => { if (reduced.matches) for (const element of [...animations.keys()]) cancel(element); });
  let disclosureId=0;
  function noteDetails(details) { return details.matches('#autoROIWorkflow .auto-roi-details'); }
  function summaryOf(details) { return [...details.children].find(node=>node.tagName==='SUMMARY'); }
  function siblingDetails(details) { return [...details.parentElement.children].filter(node=>node.tagName==='DETAILS' && summaryOf(node) && !node.hidden); }
  function restoreDetails(details) {
    const record=disclosures.get(details); if(!record)return;
    disclosures.delete(details);
    const retained=record.dialog.parentElement===details && record.summary.parentElement===details;
    // Real nodes return to precisely the same parent, in their existing order.
    // Nothing is serialized, cloned, re-created or detached from its form.
    for(const node of [...record.heading.childNodes])record.summary.append(node);
    record.label.remove();
    if(retained)for(const node of [...record.content.childNodes])details.insertBefore(node,record.dialog);
    record.dialog.remove(); managed.delete(record.dialog);
    details.classList.remove('focus-details-open');
    if(retained){details.open=record.wasOpen;record.summary.setAttribute('aria-expanded',String(record.wasOpen));}
    syncLock();
  }
  function closeDetails(details) { const record=disclosures.get(details); if(record)close(record.dialog); }
  function closeAllDetails() {
    for(const [details,record] of [...disclosures]){
      // Route activation restores real nodes before route target lookup/focus.
      // Its old trigger must not reclaim focus after the new view is selected.
      origins.delete(record.dialog);close(record.dialog);restoreDetails(details);
    }
  }
  function openDetails(details, trigger=summaryOf(details), motion=true) {
    if(!details || noteDetails(details) || disclosures.has(details))return;
    const summary=summaryOf(details); if(!summary)return;
    const wasOpen=details.open,group=siblingDetails(details),index=group.indexOf(details);
    const dialog=document.createElement('dialog');dialog.className='studio-dialog focus-card focus-details-dialog';
    dialog.dataset.focusDetails=details.id || `disclosure-${++disclosureId}`;
    const top=document.createElement('div');top.className='dialog-top';
    const closeButton=document.createElement('button');closeButton.type='button';closeButton.textContent='Close';closeButton.setAttribute('aria-label','Close');top.append(closeButton);
    const heading=document.createElement('h2');heading.id=`focusDetailsTitle${++disclosureId}`;heading.className='focus-details-title';
    dialog.setAttribute('aria-labelledby',heading.id);
    // Move original title nodes too: their locale records remain authoritative.
    // The inert trigger gets a plain temporary label, removed on restoration.
    const label=document.createElement('span');label.textContent=summary.textContent;
    heading.append(...summary.childNodes);summary.append(label);
    const viewport=document.createElement('div');viewport.className='focus-card-content';viewport.tabIndex=0;
    const content=document.createElement('div');content.className='focus-details-body';
    for(const node of [...details.childNodes])if(node!==summary)content.append(node);
    viewport.append(heading,content);
    const actions=document.createElement('div');actions.className='dialog-actions';
    const previous=document.createElement('button'),next=document.createElement('button');previous.type=next.type='button';previous.textContent='Previous';next.textContent='Next';next.className='primary';previous.disabled=index<=0;next.disabled=index<0||index===group.length-1;actions.append(previous,next);
    dialog.append(top,viewport,actions);details.append(dialog);details.open=true;details.classList.add('focus-details-open');
    summary.setAttribute('aria-haspopup','dialog');summary.setAttribute('aria-expanded','true');
    const record={dialog,summary,heading,content,wasOpen,label};disclosures.set(details,record);
    prepare(dialog);dialog.addEventListener('close',()=>restoreDetails(details),{once:true});
    closeButton.addEventListener('click',()=>close(dialog));
    function change(step){const target=group[index+step];if(!target)return;close(dialog);restoreDetails(details);openDetails(target,summaryOf(target),false);}
    previous.addEventListener('click',()=>change(-1));next.addEventListener('click',()=>change(1));
    const visibleTrigger=usableOrigin(trigger)?trigger:summary;
    window.CerebellumI18n?.refresh(dialog);open(dialog,visibleTrigger,motion);
  }
  function inventory() {
    return [...document.querySelectorAll('details')].map((details,index)=>{
      const summary=summaryOf(details);return {index,id:details.id||null,title:summary?.textContent?.trim()||'',mode:summary?(noteDetails(details)?'manual-note-deck':'details-modal'):'no-summary',visible:!!summary?.getClientRects().length,open:details.open,active:disclosures.has(details)};
    });
  }
  document.addEventListener('click',event=>{
    if(event.defaultPrevented || event.button!==0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)return;
    const route=event.target.closest('a[href],[data-workspace-open],[data-workspace-mode],[data-workspace-tool],[data-tab],[data-project-go]');
    if(route && route.closest('.focus-details-dialog')){
      let navigates=route.matches('[data-workspace-open],[data-workspace-mode],[data-workspace-tool],[data-tab],[data-project-go]');
      if(route.matches('a[href]') && !route.hasAttribute('download')){
        try{const url=new URL(route.href,location.href);navigates=url.origin===location.origin&&url.pathname===location.pathname&&!!url.hash;}catch{/* A malformed link is left to the browser. */}
      }
      if(navigates)closeAllDetails();
    }
  },true);
  document.addEventListener('click',event=>{
    if(event.defaultPrevented || event.button!==0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)return;
    const summary=event.target.closest('summary');if(!summary || event.target.closest('button,a,input,select,textarea') || summary.parentElement.tagName!=='DETAILS')return;
    const details=summary.parentElement;if(noteDetails(details))return;
    event.preventDefault();openDetails(details,summary);
  });
  // Dynamic scientific results may create new disclosures after initial load.
  // Activation is delegated, so their live content receives identical treatment.
  function markSummaries() {
    for(const details of document.querySelectorAll('details')){
      const summary=summaryOf(details);if(summary)summary.setAttribute('aria-haspopup','dialog');
    }
  }
  markSummaries();
  const disclosureObserver=new MutationObserver(()=>{
    markSummaries();
    for(const [details,record] of disclosures){
      const hidden=details.closest('[hidden],.hidden,.workspace-tool-hidden');
      if(!details.isConnected || !record.dialog.isConnected || hidden){
        if(record.dialog.open)record.dialog.close();restoreDetails(details);
      }
    }
  });
  disclosureObserver.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','class']});
  window.CerebellumFocusCards=Object.freeze({open,close,slide,openDetails,closeDetails,closeAllDetails,inventory,activeCount:()=>animations.size});
  for (const id of ['workspaceGuide','guideDialog']) { const dialog=$(id); if(dialog)prepare(dialog); }

  // Enhance only the three read-only training/review notes. Native details remain
  // the fallback; no live form, control, canvas or scientific state is copied.
  // Keep canonical source copy independent of the current locale and the
  // translator's bounded reverse-translation cache. Each newly rendered text
  // node starts in English, then receives the selected interface translation.
  const noteCopy=[
    {title:'Setup details', paragraphs:[
      'Run Start-Auto-ROI.command on your Mac. It checks the source files, trains CB and tissue-layer models, and evaluates sampled pixels from held-out animals. Your original images stay on your computer.',
      'After the tool finishes, keep auto-roi-models.json. This is the model file to open in step 2.'
    ]},
    {title:'Workflow guide', paragraphs:[
      'Reuse your reviewed sections to train once. For each new montage, let the model draw a draft, inspect its boundaries and correct what needs attention.',
      'Open auto-roi-models.json, then select one new section TIFF. Automatic draft generation is enabled when you enter this workflow.'
    ]},
    {title:'Review guidance', paragraphs:[
      'Inspect the draft with or without the image. Correct uncertain boundaries, confirm scale when known, then approve and export or continue to Study.'
    ]}
  ];
  const notes=[...document.querySelectorAll('#autoROIWorkflow .auto-roi-details')].slice(0,noteCopy.length);
  if (!notes.length) return;
  const info=document.createElement('dialog'); info.id='focusInfoDialog'; info.className='studio-dialog focus-card'; info.setAttribute('aria-labelledby','focusInfoTitle');
  info.innerHTML='<div class="dialog-top"><span class="eyebrow">Workflow guide</span><button type="button" id="focusInfoClose" aria-label="Close guide">Close</button></div><div class="focus-card-content" tabindex="0"><p id="focusInfoProgress" class="focus-card-progress" aria-live="polite"></p><h2 id="focusInfoTitle"></h2><div id="focusInfoBody"></div></div><div class="dialog-actions"><button type="button" id="focusInfoPrevious">Previous</button><button type="button" id="focusInfoNext" class="primary">Next</button></div>';
  document.body.append(info); let note=0;
  function render(direction=0) {
    const source=noteCopy[note]; $('focusInfoTitle').textContent=source.title;
    $('focusInfoProgress').textContent=`${note+1} / ${notes.length}`;
    $('focusInfoBody').replaceChildren(...source.paragraphs.map(text=>{const paragraph=document.createElement('p');paragraph.textContent=text;return paragraph;}));
    $('focusInfoPrevious').disabled=note===0; $('focusInfoNext').textContent=note===notes.length-1?'Finish guide':'Next';
    info.querySelector('.focus-card-content').scrollTop=0;
    window.CerebellumI18n?.refresh(info); if(direction)slide($('focusInfoBody'),direction);
  }
  notes.forEach((details,index) => {
    const summary=details.querySelector('summary'); summary.setAttribute('aria-haspopup','dialog'); summary.setAttribute('aria-controls','focusInfoDialog');
    summary.addEventListener('click', event => { event.preventDefault(); note=index; render(); open(info,summary); });
  });
  $('focusInfoClose').addEventListener('click',()=>close(info));
  $('focusInfoPrevious').addEventListener('click',()=>{if(note>0){note--;render(-1);}});
  $('focusInfoNext').addEventListener('click',()=>{if(note===notes.length-1){close(info);return;}note++;render(1);});
})();
