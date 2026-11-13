/* Liquid Glass selection on bar menus. One drop of glass rests on the current tab. It is a small
   soft body, not an eased box: two edges with mass, joined by surface tension, integrated at a fixed
   240 Hz step. When the selection changes the leading edge is pulled to the new tab, the rest of the
   drop is dragged after it by its own tension, overshoots and wobbles to rest; volume is conserved, so
   a stretched drop thins and a compressed one swells. Pressing a tab attracts the drop before the
   click lands, and it can be picked up and swiped along the bar. Purely visual: the real buttons keep
   their behaviour and accessibility. */
(function(){'use strict';
const TRACKS=[
 {selector:'#workspaceNav',active:'[aria-current="page"]',tone:'light'},
 {selector:'#workspaceToolsNav',active:'[aria-pressed="true"]',tone:'light'},
 {selector:'.analysis-label-chips',active:'[aria-pressed="true"]',tone:'light'},
 {selector:'#studySteps',active:'[aria-selected="true"]',tone:'light'},
 {selector:'#cutFamilyNav,.family-nav',active:'.active',tone:'light'},
 {selector:'#studioLocaleMenu',active:'[aria-selected="true"]',tone:'light',axis:'y'},
 {selector:'#analysisViewBar',active:'.is-lead',tone:'light',lead:true},
 {selector:'#analysisRasterBar',active:'.is-lead',tone:'light',items:'summary,button',lead:true},
 {selector:'#analysisMoreBar',active:'.is-lead',tone:'light',items:'summary,button',lead:true},
 {selector:'#heroBar',active:'.is-lead',tone:'light',items:'button,a',lead:true}
];
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
// Unit mass. lead: pull of the target on the leading edge. tension: surface tension that drags the
// trailing edge to one rest-width behind the leader. anchor: weak pull of the trailing edge to its own
// place. couple: share of the tension the leader feels in return. edge: both edges when the drop only
// changes size. Damping ratios are below 1 on purpose: the drop arrives, overshoots a little, settles.
const P={lead:{k:340,c:26},tension:{k:210,c:18},anchor:40,couple:.12,edge:{k:300,c:19},y:{k:320,c:34},lift:{k:260,c:20},drag:2.4};
const H=1/240;
function setup(track,cfg){
 if(track.dataset.liquid)return;track.dataset.liquid=cfg.tone;
 // An action bar has no selected item: the drop rests on the first action and stays there.
 if(cfg.lead){const items=()=>[...track.querySelectorAll(cfg.items||'button')].filter(x=>x.getBoundingClientRect().width>0&&!x.disabled);const lead=x=>{for(const n of track.querySelectorAll('.is-lead'))if(n!==x)n.classList.remove('is-lead');if(x&&!x.classList.contains('is-lead'))x.classList.add('is-lead');};const home=()=>{const now=track.querySelector('.is-lead');if(!now||!items().includes(now))lead(items()[0]);};home();new MutationObserver(home).observe(track,{attributes:true,subtree:true,attributeFilter:['hidden','disabled','style']});/* A bar that was hidden when the page loaded finds its first action once it has a size. */new ResizeObserver(home).observe(track);/* Choosing an action carries the drop to it, by pointer or by keyboard. */const pick=e=>{const x=e.target.closest&&e.target.closest(cfg.items||'button');if(x&&track.contains(x)&&!x.disabled&&!x.closest('dialog'))lead(x);};track.addEventListener('pointerdown',pick,true);track.addEventListener('focusin',e=>{if(e.target.matches&&e.target.matches(':focus-visible'))pick(e);});}
 const pill=document.createElement('span');pill.className='lg-pill lg-pill-'+cfg.tone;pill.setAttribute('aria-hidden','true');track.append(pill);
 const lens=window.LiquidLens;if(lens)lens.attach(pill,{scale:24,bezel:13,blur:0,saturate:1,magnify:0,vertical:.4,physical:true});
 let current=null,drag=null,suppressClick=0,placed=false,raf=0,last=0,acc=0,dir=0,stiff=1,lift=0,liftV=0,liftT=0,shownA=-1;
 const b={l:0,r:0,vl:0,vr:0,y:0,vy:0,h:0,vh:0},t={l:0,r:0,y:0,h:0},lean={l:0,r:0};
 const buttons=()=>[...track.querySelectorAll(cfg.items||'button')].filter(x=>x.getBoundingClientRect().width>0);
 const rectOf=x=>{const o=track.getBoundingClientRect(),r=x.getBoundingClientRect();return{x:r.left-o.left,y:r.top-o.top,w:r.width,h:r.height};};
 const restWidth=()=>Math.max(1,(t.r+lean.r)-(t.l+lean.l));
 function paint(){
  const w=Math.max(10,b.r-b.l),W=restWidth(),squash=reduced.matches?1:Math.max(.78,Math.min(1.2,Math.sqrt(W/w))),h=Math.max(4,b.h*squash*(1+lift));
  pill.style.transform='translate3d('+b.l.toFixed(2)+'px,'+(b.y+(b.h-h)/2).toFixed(2)+'px,0)';pill.style.width=w.toFixed(2)+'px';pill.style.height=h.toFixed(2)+'px';
  // Optics follow the motion: a moving, stretched drop bends more light and lifts off the bar
  const a=Math.min(1,Math.abs(b.vl+b.vr)/2200+Math.abs(w-W)/W*.8+Math.max(0,lift)*3),q=Math.round(a*20)/20;
  if(q!==shownA){shownA=q;pill.style.setProperty('--lg-a',String(q));if(lens&&lens.strength)lens.strength(pill,1+q*.9);}
 }
 function substep(dt){
  const tl=t.l+lean.l,tr=t.r+lean.r,W=tr-tl,ks=stiff,cs=Math.sqrt(stiff);
  if(dir===0){
   b.vl+=(P.edge.k*ks*(tl-b.l)-P.edge.c*cs*b.vl)*dt;b.vr+=(P.edge.k*ks*(tr-b.r)-P.edge.c*cs*b.vr)*dt;
  }else{
   const fwd=dir>0,xl=fwd?b.r:b.l,xt=fwd?b.l:b.r,vl=fwd?b.vr:b.vl,vt=fwd?b.vl:b.vr,stretch=(xl-dir*W)-xt;
   const al=P.lead.k*ks*((fwd?tr:tl)-xl)-P.lead.c*cs*vl-P.couple*P.tension.k*stretch;
   const at=P.tension.k*ks*stretch-P.tension.c*cs*vt+P.anchor*((fwd?tl:tr)-xt);
   if(fwd){b.vr+=al*dt;b.vl+=at*dt;}else{b.vl+=al*dt;b.vr+=at*dt;}
  }
  b.l+=b.vl*dt;b.r+=b.vr*dt;
  if(b.r-b.l<10){const m=(b.l+b.r)/2;b.l=m-5;b.r=m+5;const v=(b.vl+b.vr)/2;b.vl=b.vr=v;}
  b.vy+=(P.y.k*(t.y-b.y)-P.y.c*b.vy)*dt;b.y+=b.vy*dt;b.vh+=(P.y.k*(t.h-b.h)-P.y.c*b.vh)*dt;b.h+=b.vh*dt;
  liftV+=(P.lift.k*(liftT-lift)-P.lift.c*liftV)*dt;lift+=liftV*dt;
 }
 const resting=()=>Math.abs(b.vl)<1.2&&Math.abs(b.vr)<1.2&&Math.abs(b.vy)<1.2&&Math.abs(b.vh)<1.2&&Math.abs(liftV)<.02&&Math.abs(t.l+lean.l-b.l)<.3&&Math.abs(t.r+lean.r-b.r)<.3&&Math.abs(t.y-b.y)<.3&&Math.abs(t.h-b.h)<.3&&Math.abs(liftT-lift)<.004;
 function snap(){if(raf)cancelAnimationFrame(raf);raf=0;b.l=t.l+lean.l;b.r=t.r+lean.r;b.y=t.y;b.h=t.h;b.vl=b.vr=b.vy=b.vh=0;lift=liftT;liftV=0;if(!drag)dir=0;paint();if(lens&&lens.hold)lens.hold(pill,false);}
 function frame(now){
  acc+=Math.min(.05,Math.max(0,(now-last)/1000));last=now;let n=0;while(acc>=H&&n<16){substep(H);acc-=H;n++;}
  if(resting()){snap();return;}
  paint();raf=requestAnimationFrame(frame);
 }
 function kick(){if(reduced.matches){snap();return;}if(raf)return;last=performance.now();acc=H;if(lens&&lens.hold)lens.hold(pill,true);raf=requestAnimationFrame(frame);}
 function aim(r){t.l=r.x;t.r=r.x+r.w;t.y=r.y;t.h=r.h;}
 function retarget(button,animate){
  const r=rectOf(button);if(r.w<1){placed=false;return;}
  const from=(b.l+b.r)/2;aim(r);
  if(!placed||!animate||reduced.matches){placed=true;snap();return;}
  const d=(t.l+t.r)/2-from;if(Math.abs(d)>6)dir=d>0?1:-1;
  kick();
 }
 function sync(){const next=track.querySelector((cfg.items||'button').split(',').map(x=>x.trim()+cfg.active).join(','));if(next===current)return;current=next;lean.l=lean.r=0;if(!next){pill.style.opacity='0';placed=false;return;}pill.style.opacity='1';retarget(next,true);}
 function relayout(){if(!current||drag)return;const r=rectOf(current);if(r.w<1){placed=false;return;}if(raf&&placed)aim(r);else retarget(current,false);}
 const vertical=cfg.axis==='y';
 function nearestY(y){let best=null,d=Infinity;for(const o of buttons()){const r=rectOf(o),dd=Math.abs(r.y+r.h/2-y);if(dd<d){d=dd;best=o;}}return best;}
 function nearest(x){let best=null,d=Infinity;for(const o of buttons()){const r=rectOf(o),dd=Math.abs(r.x+r.w/2-x);if(dd<d){d=dd;best=o;}}return best;}
 // Press: the drop is drawn toward the tab under the finger before the click lands; pressing the
 // drop itself flattens it. A sideways move picks it up.
 track.addEventListener('pointerdown',e=>{/* A bar of separate actions has nothing to slide between: its drop stays put. */if(cfg.lead)return;if(e.button!==0||!current||!placed)return;
  drag={id:e.pointerId,startX:e.clientX,startY:e.clientY,moved:false,vx:0,lastX:e.clientX,lastT:performance.now(),c0:(t.l+t.r)/2,cy0:t.y+t.h/2};
  if(reduced.matches)return;
  const btn=e.target.closest&&e.target.closest(cfg.items||'button');
  if(btn&&btn!==current&&track.contains(btn)){const r=rectOf(btn),d=r.x+r.w/2-(t.l+t.r)/2,amt=Math.min(18,Math.abs(d)*.14);dir=d>0?1:-1;if(d>0){lean.l=amt*.25;lean.r=amt;}else{lean.l=-amt;lean.r=-amt*.25;}}
  else{lean.l=-3;lean.r=3;liftT=-.05;}
  kick();
 },{passive:true});
 track.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;const dx=e.clientX-drag.startX;
  // A list that runs downwards is dragged downwards: the drop follows the pointer's height and takes the row it is over.
  if(vertical){const dy=e.clientY-drag.startY;if(!drag.moved){if(Math.abs(dy)<6)return;drag.moved=true;try{track.setPointerCapture(e.pointerId);}catch(_){}track.classList.add('lg-dragging');lean.l=lean.r=0;liftT=.1;stiff=P.drag;}
   const o=track.getBoundingClientRect(),cy=drag.cy0+dy,under=nearestY(cy),ur=under?rectOf(under):{x:t.l,y:t.y,w:t.r-t.l,h:t.h},y=Math.max(0,Math.min(o.height-ur.h,cy-ur.h/2));
   aim({x:ur.x,y:y,w:ur.w,h:ur.h});for(const k of buttons())k.classList.toggle('lg-under',k===under);kick();return;}
  if(!drag.moved){if(Math.abs(dx)<6)return;drag.moved=true;try{track.setPointerCapture(e.pointerId);}catch(_){}track.classList.add('lg-dragging');lean.l=lean.r=0;liftT=.1;stiff=P.drag;}
  const now=performance.now();drag.vx=(e.clientX-drag.lastX)/Math.max(1,now-drag.lastT)*1000;drag.lastT=now;drag.lastX=e.clientX;
  // The drop takes the width of the tab it is passing over and chases the pointer
  const o=track.getBoundingClientRect(),centre=drag.c0+dx,under=nearest(centre),ur=under?rectOf(under):{x:t.l,y:t.y,w:t.r-t.l,h:t.h},x=Math.max(0,Math.min(o.width-ur.w,centre-ur.w/2));
  aim({x:x,y:ur.y,w:ur.w,h:ur.h});if(Math.abs(drag.vx)>120)dir=drag.vx>0?1:-1;
  for(const k of buttons())k.classList.toggle('lg-under',k===under);
  kick();
 });
 const end=e=>{if(!drag||drag.id!==e.pointerId)return;const d=drag;drag=null;lean.l=lean.r=0;liftT=0;stiff=1;track.classList.remove('lg-dragging');for(const k of buttons())k.classList.remove('lg-under');
  if(!d.moved){if(current)aim(rectOf(current));kick();return;}
  try{track.releasePointerCapture(e.pointerId);}catch(_){}
  const target=vertical?nearestY(t.y+t.h/2):nearest((t.l+t.r)/2);
  // Released: the drop keeps the speed of the hand and falls into the nearest tab
  if(!reduced.matches&&!vertical){b.vl+=d.vx*.35;b.vr+=d.vx*.35;}
  if(target&&target!==current){current=null;target.click();if(current!==target){current=target;retarget(target,true);}}
  else if(current)retarget(current,true);
  if(e.type==='pointerup')suppressClick=performance.now();
 };
 track.addEventListener('pointerup',end);track.addEventListener('pointercancel',end);
 track.addEventListener('click',e=>{if(performance.now()-suppressClick<300){e.stopPropagation();e.preventDefault();}},true);
 new MutationObserver(()=>sync()).observe(track,{attributes:true,subtree:true,attributeFilter:['aria-current','aria-pressed','aria-selected','hidden','class']});
 // A track whose items are rebuilt loses the drop with them: put it back and place it again.
 new MutationObserver(()=>{if(!pill.isConnected){track.append(pill);current=null;sync();}}).observe(track,{childList:true});
 // A track that opens with an animation was measured while still growing: measure again once it has settled.
 track.addEventListener('animationend',e=>{if(e.target===track&&current&&!drag){retarget(current,false);}});
 new ResizeObserver(relayout).observe(track);
 window.addEventListener('resize',relayout);
 sync();
}
function scan(){for(const cfg of TRACKS)for(const track of document.querySelectorAll(cfg.selector))if(track.querySelector(cfg.items||'button'))setup(track,cfg);}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',scan);else scan();
window.addEventListener('load',scan);
let timer=0;new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(scan,60);}).observe(document.documentElement,{childList:true,subtree:true});
window.addEventListener('cerebellum-view-change',()=>setTimeout(scan,80));
})();
