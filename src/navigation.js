/* Navigation and floating controls delegate to the existing scientific tools.
   No source, file-input, model or review state is copied or reconstructed here. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const header = document.querySelector('.site-header');
  const navigation = header?.querySelector('nav');
  if (!navigation || $('studioNavigationPanel')) return;
  const destination = (title, description, route) => ({title, description, route});
  const menus = {
    explore: {title:'Explore the evidence.', intro:'Move between specimen observations and the atlas reference.', links:[destination('Example in 3D','Inspect observed contours and inferred surfaces.','tab:explore'),destination('Atlas reference','Browse the atlas planes.','atlas'),destination('How to use Studio','A short introduction to the workflow.','guide')]},
    cut: {title:'See it section by section.', intro:'Compare the source planes with what is inferred between them.', links:[destination('Virtual sections','Move and tilt the cutting plane.','tab:cut'),destination('Hold-out validation','Compare predictions with an omitted observation.','tab:hold'),destination('Atlas comparison','Look at specimen and reference evidence.','tab:atlas')]},
    annotate: {title:'Keep the evidence in view.', intro:'Inspect source images, record observations and retain review history.', links:[destination('Review example annotations','Add and inspect source-linked review records.','tab:annotate'),destination('Review your own image','Edit draft boundaries before approval.','workspace:image'),destination('Source measurements','Trace each value back to its ROI.','tab:source')]},
    source: {title:'Make the numbers traceable.', intro:'Inspect source measurements and compare recorded observations.', links:[destination('Example source data','Find a region and inspect its original evidence.','tab:source'),destination('Specimen comparison','Compare available measurements across animals.','tab:cohort'),destination('Research experiments','Test reconstruction assumptions and sensitivity.','workspace:tools')]},
    research: {title:'Start with what you have.', intro:'Images, existing contours or a saved study. Choose one path.', links:[destination('A new TIFF image','Draw or import boundaries and review measurements. No model is needed to begin.','workspace:image'),destination('Existing ROI / CSV','Bring observed sections into a 3D workspace.','workspace:observations'),destination('A saved study','Continue review, physical 3D and group comparison.','workspace:study')]},
    project: {title:'Why Cerebellum Studio exists.', intro:'Purpose, people, progress and the work still ahead.', links:[destination('Purpose and people','Who it serves, what it delivers and where it is going.','tab:project'),destination('Quick guide','Find the right starting point.','guide'),destination('Share feedback','Save a local feedback record.','feedback')]}
  };
  const panel = document.createElement('section');
  panel.id = 'studioNavigationPanel'; panel.className = 'studio-navigation-panel';
  panel.hidden = true; panel.setAttribute('aria-label','Explore Studio features');
  panel.innerHTML = '<div class="studio-navigation-inner"><div class="studio-navigation-intro"><span class="studio-overline">CEREBELLUM STUDIO</span><h2 id="studioNavigationTitle"></h2><p id="studioNavigationIntro"></p></div><div id="studioNavigationLinks" class="studio-navigation-links"></div><button type="button" class="studio-navigation-close" aria-label="Close navigation">Close</button></div>';
  header.append(panel);
  let activeMenu = null, activeTrigger = null, opening = 0, closing = 0;
  const triggers = [];
  // Scrolling or a layout change can slide a menu item under a pointer that is not moving; the browser
  // then reports pointerenter without any pointermove. Hover opens a menu only after the pointer itself moved
  // (or, when no pointer position is known yet, after the first real pointermove on the item).
  let pointerX = NaN, pointerY = NaN;
  const trackPointer = event => { pointerX = event.clientX; pointerY = event.clientY; };
  document.addEventListener('pointermove', trackPointer, true); document.addEventListener('pointerdown', trackPointer, true);
  const pointerMovedFrom = (event, x, y) => Math.abs(event.clientX - x) >= 1 || Math.abs(event.clientY - y) >= 1;
  function clearTimers() { clearTimeout(opening); clearTimeout(closing); }
  function closeMenu(restore = false) {
    clearTimers(); const previous = activeTrigger;
    window.CerebellumMotion?.cancel(panel);panel.hidden = true; activeMenu = null; activeTrigger = null;
    document.body.classList.remove('studio-navigation-open');
    triggers.forEach(button => button.setAttribute('aria-expanded','false'));
    if (restore) previous?.focus({preventScroll:true});
  }
  function go(route) {
    closeMenu();
    if (route.startsWith('tab:')) document.querySelector(`[data-tab="${route.slice(4)}"]`)?.click();
    else if (route.startsWith('workspace:')) window.CerebellumWorkspace?.open(route.slice(10));
    else if (route === 'atlas') {
      document.querySelector('.site-header [data-tab="explore"]')?.click();
      window.CerebellumBoot?.loadAtlas().catch(()=>{});
      requestAnimationFrame(() => { $('atlasExplorer')?.scrollIntoView({block:'start',behavior:'auto'}); });
    } else document.querySelector(route === 'feedback' ? '[data-feedback-open]' : '[data-guide-open]')?.click();
  }
  function openMenu(key, trigger, focus = false) {
    clearTimers();
    const config = menus[key]; if (!config) return;
    activeMenu = key; activeTrigger = trigger;
    $('studioNavigationTitle').textContent = config.title;
    $('studioNavigationIntro').textContent = config.intro;
    const links = $('studioNavigationLinks'); links.replaceChildren();
    config.links.forEach(item => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'studio-navigation-link';
      const title = document.createElement('strong'), description = document.createElement('span');
      title.textContent = item.title; description.textContent = item.description;
      if(window.CerebellumBoot?.profile.example_data_available===false&&/^tab:(cut|hold|atlas|annotate|source|cohort)$/.test(item.route))button.disabled=button.hidden=true;if(window.CerebellumBoot?.profile.atlas_reference_available===false&&item.route==='atlas')button.disabled=button.hidden=true;
      button.append(title, description); button.addEventListener('click', () => go(item.route)); links.append(button);
    });
    panel.hidden = false;
    window.CerebellumMotion?.enter(panel,{distance:-6,duration:220});
    document.body.classList.add('studio-navigation-open');
    triggers.forEach(button => button.setAttribute('aria-expanded',String(button === trigger)));
    if (focus) links.querySelector('button')?.focus();
  }
  for (const button of [...navigation.querySelectorAll('[data-tab]')]) {
    const key = button.dataset.tab; if (!menus[key]) continue;
    const group = document.createElement('span'); group.className = 'studio-nav-item';
    button.before(group); group.append(button);
    button.setAttribute('aria-controls',panel.id); button.setAttribute('aria-expanded','false');
    triggers.push(button);
    let resting = null;
    const hoverOpen = () => { resting = null; clearTimers(); opening = setTimeout(() => openMenu(key,button),180); };
    group.addEventListener('pointerenter', event => { if (event.pointerType !== 'mouse' || matchMedia('(max-width: 760px)').matches) return; if (pointerMovedFrom(event,pointerX,pointerY)) hoverOpen(); else resting = {x:event.clientX,y:event.clientY,first:Number.isNaN(pointerX)}; });
    group.addEventListener('pointermove', event => { if (resting && event.pointerType === 'mouse' && (resting.first || pointerMovedFrom(event,resting.x,resting.y))) hoverOpen(); });
    group.addEventListener('pointerleave', () => {resting = null; clearTimeout(opening); closing = setTimeout(() => closeMenu(),250);});
    button.addEventListener('click', () => {resting = null; closeMenu();});
    button.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); openMenu(key,button,true); } });
  }
  panel.addEventListener('pointerenter', clearTimers);
  panel.addEventListener('pointerleave', event => {if(event.pointerType === 'mouse') closing = setTimeout(() => closeMenu(),250);});
  panel.querySelector('.studio-navigation-close').addEventListener('click', () => closeMenu(true));
  header.addEventListener('focusout', () => setTimeout(() => { if(!header.contains(document.activeElement)) closeMenu(); },0));
  document.addEventListener('pointerdown', event => {if(!header.contains(event.target)) closeMenu();});
  document.addEventListener('keydown', event => {if(event.key === 'Escape' && activeMenu) {event.preventDefault(); closeMenu(true);}});

  // A small viewport companion, with an explicit handle and a keyboard move path.
  const dock = document.createElement('section');
  dock.id = 'studioToolDock'; dock.className = 'studio-tool-dock'; dock.setAttribute('aria-label','Floating workspace tools');
  dock.innerHTML = '<div id="studioToolPanel" class="studio-tool-panel" hidden><div class="studio-tool-heading"><button type="button" id="studioToolMove" class="studio-tool-move" aria-label="Move tool panel. Drag or use arrow keys. Home resets position." title="Drag to move · arrow keys when focused"><span id="studioToolTitle">3D tools</span><span class="studio-tool-move-hint">Move</span></button><button type="button" id="studioToolClose" class="studio-tool-close" aria-label="Collapse tool panel">Hide</button></div><p id="studioToolDescription" class="studio-tool-description"></p><div id="studioToolActions" class="studio-tool-actions"></div><div id="studioToolLayers" class="studio-tool-layers"></div><div class="studio-tool-footer"><button type="button" id="studioToolHelp">Quick guide</button><button type="button" id="studioToolReset">Reset position</button></div></div><button type="button" id="studioToolToggle" class="studio-tool-toggle" aria-expanded="false" aria-controls="studioToolPanel"><span id="studioToolToggleText">3D tools</span></button>';

  document.body.append(dock);
  const toggle = $('studioToolToggle'), content = $('studioToolPanel');
  let context = '', moved = false, dragging = null, scrollFrame = 0;
  const bindings = [], watched = new WeakSet();
  const stateObserver = new MutationObserver(() => sync());
  function sync() {
    for (const binding of bindings) {
      const source = $(binding.source); if (!source) continue;
      const disabled = source.disabled === true || !!source.closest('[inert]');
      if (binding.node.disabled !== disabled) binding.node.disabled = disabled;
      if (binding.checkbox) binding.node.setAttribute('aria-pressed',String(source.checked));
    }
  }
  function watch(source) {
    if(source && !watched.has(source)) {watched.add(source); stateObserver.observe(source,{attributes:true,attributeFilter:['disabled']});}
  }
  function original(id) {
    const source = $(id); if (!source || source.disabled || source.closest('[inert]')) return;
    source.click(); sync();
  }
  const contexts = {
    explore:{title:'Example · 3D tools',short:'3D tools',description:'Rotate the model. Choose a tissue layer.',actions:[['Front view','exploreFront'],['Reset view','exploreReset'],['Zoom in','exploreZoomIn'],['Zoom out','exploreZoomOut']],layers:['ML','GL','WM']},
    atlas:{title:'Atlas · view tools',short:'Atlas tools',description:'Browse atlas planes in the coordinates of the annotation volume.',actions:[['3D view','atlasRefPerspective'],['Section view','atlasRefSagittal'],['Zoom in','atlasRefZoomIn'],['Reset view','atlasRefReset']]},
    cut:{title:'Section · view tools',short:'Section tools',description:'Adjust the view without changing source measurements.',actions:[['Front view','front'],['Perspective','perspective'],['Parallel cut','resetPlane'],['Save image','export']]},
    image:{title:'Image · review tools',short:'Review tools',description:'Inspect the image and its draft boundaries before approval.',actions:[['Fit image','analysisFit'],['Zoom in','analysisZoomIn'],['Zoom out','analysisZoomOut'],['Save draft','analysisSaveDraft']]},
    observations:{title:'Observation tools',short:'Section tools',description:'Keep source images and contours together.',actions:[['Add section','researchAddSection'],['View in 3D','researchBuild'],['Fit all planes','researchFit'],['Save project','researchExport']]},
    study:{title:'Study tools',short:'Study tools',description:'Move between review and physical reconstruction.',actions:[['Section review','studyTab2'],['Physical 3D','studyTab4'],['WT / KO','studyTab5'],['Save study','studySave']]},
    source:{title:'Source · review tools',short:'Source tools',description:'Trace a region back to its image and review record.',actions:[['Next review','sourceNext'],['View on image','sourceInspect'],['Annotate','sourceReview'],['Measurement CSV','sourceRegionCSV']]},
    general:{title:'Your workspace',short:'Workspace',description:'Choose a task. Your existing inputs stay in place.',routes:[['New image','workspace:image'],['Existing ROI / CSV','workspace:observations'],['Continue study','workspace:study'],['Atlas reference','atlas']]}
  };
  function currentContext() {
    const view = document.body.dataset.view;
    if(view === 'explore') {const rect=$('atlasExplorer')?.getBoundingClientRect();return rect && rect.top < innerHeight * .55 && rect.bottom > 140 ? 'atlas' : 'explore';}
    if(view === 'research') {const mode=window.CerebellumWorkspace?.snapshot().mode;return contexts[mode] ? mode : 'general';}
    return contexts[view] ? view : 'general';
  }
  function refresh() {
    const next = currentContext(); if(context === next) {sync();return;}
    context = next; const config=contexts[next]; bindings.length=0;
    $('studioToolTitle').textContent=config.title; $('studioToolToggleText').textContent=config.short; $('studioToolDescription').textContent=config.description;
    const actions=$('studioToolActions'); actions.replaceChildren();
    for(const [label,id] of config.actions || []) {
      const source=$(id); if(!source)continue;
      const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.toolSource=id;
      button.addEventListener('click',()=>original(id));actions.append(button);bindings.push({node:button,source:id});watch(source);
    }
    for(const [label,route] of config.routes || []) {const button=document.createElement('button');button.type='button';button.textContent=label;button.addEventListener('click',()=>go(route));actions.append(button);}
    const layers=$('studioToolLayers');layers.replaceChildren();layers.hidden=!config.layers;
    for(const layer of config.layers || []) {
      const button=document.createElement('button');button.type='button';button.textContent=layer;button.setAttribute('aria-label',({ML:'Molecular layer',GL:'Granular layer',WM:'White matter'})[layer]);button.className='studio-tool-layer studio-tool-layer-'+layer;
      button.addEventListener('click',()=>original('layer-'+layer));layers.append(button);bindings.push({node:button,source:'layer-'+layer,checkbox:true});
    }
    sync();if(moved)requestAnimationFrame(clamp);
  }
  function clamp() {
    if(!moved)return;
    const rect=dock.getBoundingClientRect(),margin=12;
    dock.style.left=Math.max(margin,Math.min(rect.left,innerWidth-rect.width-margin))+'px';
    dock.style.top=Math.max(margin,Math.min(rect.top,innerHeight-rect.height-margin))+'px';
    dock.style.right='auto';dock.style.bottom='auto';
  }
  function expand(open) {
    const rect=dock.getBoundingClientRect();
    window.CerebellumMotion?.cancel(content);content.hidden=!open;if(open)window.CerebellumMotion?.enter(content,{distance:6,duration:220});toggle.setAttribute('aria-expanded',String(open));dock.classList.toggle('is-open',open);
    if(moved){dock.style.top=Math.max(12,rect.bottom-dock.getBoundingClientRect().height)+'px';clamp();}
    if(!open && content.contains(document.activeElement))toggle.focus({preventScroll:true});
    sync();
  }
  function resetPosition() {moved=false;dock.style.left='';dock.style.top='';dock.style.right='';dock.style.bottom='';}
  toggle.addEventListener('click',()=>expand(content.hidden));
  $('studioToolClose').addEventListener('click',()=>expand(false));
  $('studioToolReset').addEventListener('click',resetPosition);
  $('studioToolHelp').addEventListener('click',()=>go('guide'));
  dock.addEventListener('keydown',event=>{if(event.key==='Escape'&&!content.hidden){event.preventDefault();expand(false);}});
  const handle=$('studioToolMove');
  handle.addEventListener('pointerdown',event=>{if(event.button!==0)return;const rect=dock.getBoundingClientRect();dragging={id:event.pointerId,x:event.clientX,y:event.clientY,left:rect.left,top:rect.top};handle.setPointerCapture(event.pointerId);dock.classList.add('is-dragging');event.preventDefault();});
  handle.addEventListener('pointermove',event=>{if(!dragging||dragging.id!==event.pointerId)return;moved=true;dock.style.left=dragging.left+event.clientX-dragging.x+'px';dock.style.top=dragging.top+event.clientY-dragging.y+'px';dock.style.right='auto';dock.style.bottom='auto';clamp();});
  const endDrag=()=>{dragging=null;dock.classList.remove('is-dragging');};handle.addEventListener('pointerup',endDrag);handle.addEventListener('pointercancel',endDrag);
  handle.addEventListener('keydown',event=>{if(event.key==='Home'){event.preventDefault();resetPosition();return;}if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const rect=dock.getBoundingClientRect(),step=event.shiftKey?50:20;moved=true;dock.style.left=rect.left+(event.key==='ArrowRight'?step:event.key==='ArrowLeft'?-step:0)+'px';dock.style.top=rect.top+(event.key==='ArrowDown'?step:event.key==='ArrowUp'?-step:0)+'px';dock.style.right='auto';dock.style.bottom='auto';clamp();});
  let animatedView=document.body.dataset.view;
  window.addEventListener('cerebellum-view-change',()=>{
    const view=document.body.dataset.view;if(view===animatedView)return;
    window.CerebellumMotion?.cancel($(animatedView+'View'));animatedView=view;
    // Workspace subviews have their own navigation animation; animate their
    // outer view only when the top-level destination actually changes.
    window.CerebellumMotion?.enter($(view+'View'));
  });
  new MutationObserver(refresh).observe(document.body,{attributes:true,attributeFilter:['data-view']});
  window.addEventListener('cerebellum-workspace-open',refresh);window.addEventListener('cerebellum-demo-ready',refresh);
  window.addEventListener('resize',()=>{clamp();refresh();});
  window.addEventListener('scroll',()=>{if(scrollFrame)return;scrollFrame=requestAnimationFrame(()=>{scrollFrame=0;refresh();});},{passive:true});
  document.addEventListener('change',sync);
  window.CerebellumNavigation=Object.freeze({close:()=>closeMenu(),snapshot:()=>({menu:activeMenu,context,dock_open:!content.hidden,moved}),resetPosition});
  refresh();
})();
