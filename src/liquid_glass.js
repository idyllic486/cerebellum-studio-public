/* Liquid Glass touch: a press lands where the pointer is and spreads like a drop on water.
   Sets the press point on the control and a short-lived class the stylesheet animates. Purely visual. */
(function(){'use strict';
const SEL='button,summary,.filebutton,.studio-tool-toggle,.workspace-nav button,.analysis-label-chip,.layer-chip';
function press(event){if(event.button!==0&&event.pointerType==='mouse')return;const el=event.target.closest(SEL);if(!el||el.disabled||el.matches('.primary'))return;const r=el.getBoundingClientRect();el.style.setProperty('--press-x',((event.clientX-r.left)/r.width*100).toFixed(1)+'%');el.style.setProperty('--press-y',((event.clientY-r.top)/r.height*100).toFixed(1)+'%');el.classList.remove('lg-touch');void el.offsetWidth;el.classList.add('lg-touch');clearTimeout(el._lgTimer);el._lgTimer=setTimeout(()=>el.classList.remove('lg-touch'),400);}

/* Buttons that UI 33 styles with white words keep a dark glass fill, whatever their class. */
function light(c){const m=c&&c.match(/[\d.]+/g);if(!m)return false;const [r,g,b]=m.map(Number);return r>200&&g>200&&b>200;}
function markDark(root){for(const el of (root||document).querySelectorAll('[data-liquid] button.lg-dark'))el.classList.remove('lg-dark');for(const el of (root||document).querySelectorAll('button:not(.primary):not(.lg-dark)')){if(el.closest('[hidden]')||el.closest('[data-liquid]'))continue;const cs=getComputedStyle(el);if(light(cs.color)&&(cs.backgroundColor==='rgba(0, 0, 0, 0)'||light(cs.backgroundColor)))el.classList.add('lg-dark');}}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>markDark());else markDark();
window.addEventListener('load',()=>markDark());
window.addEventListener('cerebellum-view-change',()=>setTimeout(()=>markDark(),50));
let darkTimer=0;new MutationObserver(()=>{clearTimeout(darkTimer);darkTimer=setTimeout(()=>markDark(),40);}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','class','aria-pressed','aria-current','disabled']});

/* Rim lensing (after kube.io's physical approach): for each glass element a displacement map is drawn
   whose interior is flat and whose bezel band bends the backdrop toward the edge like a convex lens.
   Encoded as an SVG filter (feImage + feDisplacementMap) used as the element's backdrop-filter.
   Chromium applies SVG filters as backdrops; other engines keep the plain blur fallback. */
const LENS_SUPPORT=CSS.supports('backdrop-filter','url(#x)')||CSS.supports('-webkit-backdrop-filter','url(#x)');
let lensDefs=null,lensSeq=0;
function defs(){if(lensDefs)return lensDefs;const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('aria-hidden','true');svg.setAttribute('width','0');svg.setAttribute('height','0');svg.style.cssText='position:absolute;width:0;height:0;overflow:hidden';lensDefs=document.createElementNS('http://www.w3.org/2000/svg','defs');svg.append(lensDefs);document.body.append(svg);return lensDefs;}
function lensMap(w,h,radius,bezel,o){const c=document.createElement('canvas');c.width=Math.max(2,Math.round(w));c.height=Math.max(2,Math.round(h));const g=c.getContext('2d'),img=g.createImageData(c.width,c.height),d=img.data,r=Math.min(radius,c.width/2,c.height/2),b=Math.min(bezel,r);
 for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const px=x+.5,py=y+.5;
  // signed distance to the rounded-rect edge (inside positive)
  const cx=Math.min(Math.max(px,r),c.width-r),cy=Math.min(Math.max(py,r),c.height-r);let dx=px-cx,dy=py-cy,dist=Math.hypot(dx,dy);let nx=0,ny=0,inside;
  if(dist>0){inside=r-dist;nx=dx/dist;ny=dy/dist;}else{const e=Math.min(px,c.width-px,py,c.height-py);inside=e;if(e===px)nx=-1;else if(e===c.width-px)nx=1;else if(e===py)ny=-1;else ny=1;}
  let m=0;const half=Math.min(c.width,c.height)/2;
  if(inside>=0&&inside<b){const t=inside/b;const slope=Math.sqrt(Math.max(0,1-t*t));m=(slope*slope*(1-t)+(1-t)*.25)*Math.min(1,inside/2);}
  // dome interior: a gentle pull toward the centre magnifies what lies under the drop
  if(inside>=b&&half>b){const u=Math.min(1,(inside-b)/Math.max(1,half-b));m=-o.magnify*(1-u);}
  const i=(y*c.width+x)*4;d[i]=Math.round(128+nx*m*127);d[i+1]=Math.round(128+ny*m*127*(o.vertical==null?.35:o.vertical));d[i+2]=128;d[i+3]=255;}
 g.putImageData(img,0,0);return c.toDataURL('image/png');}
const lensed=new Map();
function attachLens(el,opts){if(!LENS_SUPPORT||!el||lensed.has(el))return;const o=Object.assign({scale:14,bezel:16,radius:980,blur:0,saturate:1.6,magnify:.22},opts||{});const id='lgLens'+(++lensSeq);const ns='http://www.w3.org/2000/svg';const f=document.createElementNS(ns,'filter');f.id=id;f.setAttribute('x','0');f.setAttribute('y','0');f.setAttribute('width','100%');f.setAttribute('height','100%');f.setAttribute('color-interpolation-filters','sRGB');const im=document.createElementNS(ns,'feImage');im.setAttribute('x','0');im.setAttribute('y','0');im.setAttribute('preserveAspectRatio','none');im.setAttribute('result','map');const dm=document.createElementNS(ns,'feDisplacementMap');dm.setAttribute('in','SourceGraphic');dm.setAttribute('in2','map');dm.setAttribute('scale',String(o.scale));dm.setAttribute('xChannelSelector','R');dm.setAttribute('yChannelSelector','G');f.append(im,dm);defs().append(f);
 const state={id,im,dm,o,w:0,h:0,hold:false};lensed.set(el,state);el.classList.add('lg-lit');
 const redraw=()=>{const r=el.getBoundingClientRect();if(r.width<2||r.height<2)return;if(state.hold&&state.w){im.setAttribute('width',String(Math.round(r.width)));im.setAttribute('height',String(Math.round(r.height)));return;}if(Math.abs(r.width-state.w)<1&&Math.abs(r.height-state.h)<1){im.setAttribute('width',String(Math.round(state.w)));im.setAttribute('height',String(Math.round(state.h)));return;}state.w=r.width;state.h=r.height;const radius=Math.min(o.radius,parseFloat(getComputedStyle(el).borderTopLeftRadius)||o.radius);im.setAttribute('width',String(Math.round(r.width)));im.setAttribute('height',String(Math.round(r.height)));im.setAttribute('href',lensMap(r.width,r.height,radius,o.bezel,o));const value='url(#'+id+') '+(o.blur?'blur('+o.blur+'px) ':'')+'saturate('+o.saturate+')';el.style.setProperty('backdrop-filter',value,'important');el.style.setProperty('-webkit-backdrop-filter',value,'important');};
 redraw();new ResizeObserver(()=>redraw()).observe(el);state.redraw=redraw;}
const LENS_TARGETS=[['#studioToolToggle',{scale:40,bezel:22,blur:2,magnify:.3}],['#studioToolPanel',{scale:28,bezel:24,blur:10}],['dialog.focus-card',{scale:30,bezel:26,blur:12}],['#studioLocale',{scale:32,bezel:20,blur:2,magnify:.25}],['#workspaceNav',{scale:30,bezel:20,blur:3,magnify:.12}],['#cutFamilyNav',{scale:30,bezel:20,blur:3,magnify:.12}],['.site-header',{scale:12,bezel:14,blur:12,radius:0}]];
function scanLens(){for(const [sel,o] of LENS_TARGETS)for(const el of document.querySelectorAll(sel))attachLens(el,o);for(const el of document.querySelectorAll('.lg-pill'))attachLens(el,{scale:22,bezel:22,blur:0,saturate:1.4,magnify:.22,vertical:.22});}
window.LiquidLens=Object.freeze({attach:attachLens,supported:LENS_SUPPORT,refresh(){for(const s of lensed.values())s.redraw&&s.redraw();},hold(el,on){const s=lensed.get(el);if(!s)return;s.hold=!!on;if(!on&&s.redraw)s.redraw();},strength(el,k){const s=lensed.get(el);if(s&&s.dm)s.dm.setAttribute('scale',String(Math.round(s.o.scale*k*10)/10));}});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',scanLens);else scanLens();
window.addEventListener('load',scanLens);
let lensTimer=0;new MutationObserver(()=>{clearTimeout(lensTimer);lensTimer=setTimeout(scanLens,80);}).observe(document.documentElement,{childList:true,subtree:true});
document.addEventListener('pointerdown',press,{passive:true,capture:true});
/* Light follows the pointer across glass: a soft specular spot slides over whichever lensed surface
   the pointer is over (or the track whose drop is lensed). */
document.addEventListener('pointermove',e=>{for(const [el] of lensed){const r=el.getBoundingClientRect();if(r.width===0)continue;const inside=e.clientX>=r.left-40&&e.clientX<=r.right+40&&e.clientY>=r.top-40&&e.clientY<=r.bottom+40;if(inside){el.style.setProperty('--lx',((e.clientX-r.left)/r.width*100).toFixed(1)+'%');el.style.setProperty('--ly',((e.clientY-r.top)/r.height*100).toFixed(1)+'%');el.style.setProperty('--lo','1');}else if(el.style.getPropertyValue('--lo')==='1'){el.style.setProperty('--lo','0');}}},{passive:true});
})();
