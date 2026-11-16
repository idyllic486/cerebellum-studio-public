/* Figure export for the section under review: the outlines as they are shown, as a vector SVG or a 300-dpi-class PNG.
   Line weights and textures are fixed to the figure's width, not to the screen zoom, so every export of one section
   looks the same. A scale bar is drawn only when the pixel size is known; nothing is invented when it is not.
   The file records whether the outlines were approved. Everything stays on this computer. */
(function(){'use strict';
const NS='http://www.w3.org/2000/svg',$=id=>document.getElementById(id);
// Kept in step with the colours in analysis.js.
const COLORS={CB:'#2b2b2b',ML:'#8fa9bd',GL:'#6c5b9a',WM:'#8c8c8c',PL:'#a8324a'},INK='#2b2b2b',ORDER=['CB','ML','GL','WM','PL'];
const NAMES={CB:'Cerebellum outline',ML:'Molecular layer',GL:'Granular layer',WM:'White matter',PL:'Purkinje cell layer'};
const FIGURE_UNITS=1000; // line weights below are given for a figure this many units wide
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const num=v=>(Math.round(v*100)/100).toString();
const el=(name,attrs={},text)=>{const n=document.createElementNS(NS,name);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);if(text!=null)n.textContent=text;return n;};
const kindOf=r=>r.geometry||(r.closed===false?'line':'area');
function niceLength(target){const p=Math.pow(10,Math.floor(Math.log10(target)));for(const m of[5,2,1])if(m*p<=target)return m*p;return p;}
function stroke(color){return /^#[0-9a-f]{6}$/i.test(color||'')?color:INK;}

/* Build the figure as an SVG element. `raster` is an optional {href,width,height} already safe to embed. */
function build(state,options){
 const W=options.width,H=options.height,k=W/FIGURE_UNITS,shown=options.shown,rois=state.rois.filter(r=>r.included!==false&&(!shown||shown.has(r.id)));
 const labels=ORDER.filter(l=>rois.some(r=>r.label===l)).concat([...new Set(rois.map(r=>r.label))].filter(l=>!ORDER.includes(l)).sort());
 const row=34*k,pad=24*k,legendH=labels.length?pad+Math.ceil(labels.length/2)*row+pad*.5:0,total=H+legendH;
 const svg=el('svg',{xmlns:NS,viewBox:'0 0 '+num(W)+' '+num(total),width:num(W),height:num(total),'font-family':'Helvetica, Arial, sans-serif'});
 const approved=!!state.approval;
 svg.append(el('title',{},options.title||'Cerebellar section outlines'));
 svg.append(el('desc',{},(approved?'Outlines approved by a reviewer.':'Draft outlines, not approved.')+' Coordinates are source-image pixels.'+(options.um?' Pixel size '+options.um+' µm.':' Pixel size unknown; no scale bar.')));
 const defs=el('defs');svg.append(defs);
 svg.append(el('rect',{x:0,y:0,width:num(W),height:num(total),fill:'#ffffff'}));
 if(options.raster)svg.append(el('image',{x:0,y:0,width:num(W),height:num(H),href:options.raster,preserveAspectRatio:'none'}));
 const made=new Map();
 const paint=(label,color)=>{const kind=label==='ML'?'plain':label==='GL'?'dots':label==='WM'?'solid':'';if(!kind)return null;const id='fig-'+kind+'-'+color.slice(1);if(made.has(id))return id;
  const step=(kind==='dots'?4.5:7)*k,p=el('pattern',{id,patternUnits:'userSpaceOnUse',width:num(step),height:num(step)});
  p.append(el('rect',{width:num(step),height:num(step),fill:color,'fill-opacity':kind==='solid'?'.14':kind==='plain'?'.16':'.12'}));
  if(kind==='dots')p.append(el('circle',{cx:num(step/2),cy:num(step/2),r:num(.7*k),fill:color,'fill-opacity':'.75'}));
  defs.append(p);made.set(id,1);return id;};
 const colorOf=r=>{const argb=r.style?.stroke_color_argb;return argb?'#'+(argb&0xffffff).toString(16).padStart(6,'0'):COLORS[r.label]||INK;};
 const g=el('g',{id:'outlines','stroke-linejoin':'round','stroke-linecap':'round'});svg.append(g);
 // Areas first, largest label last, so thin layers are never hidden under the whole-organ outline
 const order=r=>r.label==='CB'?2:kindOf(r)==='area'?0:1;
 for(const r of[...rois].sort((a,b)=>order(a)-order(b))){const kind=kindOf(r),color=colorOf(r);
  if(kind==='point'){for(const p of r.paths.flat())g.append(el('circle',{cx:num(p[0]),cy:num(p[1]),r:num(3*k),fill:color,'data-label':r.label}));continue;}
  const d=r.paths.map(p=>'M'+p.map(q=>num(q[0])+','+num(q[1])).join('L')+(kind==='area'?'Z':'')).join('');
  const id=kind==='area'?paint(r.label,color):null,own=!!r.style?.stroke_color_argb;
  g.append(el('path',{d,'data-label':r.label,fill:kind!=='area'?'none':id?'url(#'+id+')':r.label==='CB'?'none':color,'fill-opacity':kind==='area'&&!id&&r.label!=='CB'?'.14':'1','fill-rule':'evenodd',
   stroke:kind==='area'&&COLORS[r.label]&&!own?INK:stroke(color),'stroke-width':num((r.label==='CB'?.9:r.label==='PL'?1:.7)*k)}));}
 // Scale bar, bottom right, only with a known pixel size
 if(options.um){const want=W*options.um*.2,um=niceLength(want),len=um/options.um,x1=W-pad-len,y=H-pad;
  const bar=el('g',{id:'scale-bar'});bar.append(el('rect',{x:num(x1-6*k),y:num(y-26*k),width:num(len+12*k),height:num(34*k),fill:'#ffffff','fill-opacity':'.8'}));
  bar.append(el('line',{x1:num(x1),y1:num(y),x2:num(x1+len),y2:num(y),stroke:'#111111','stroke-width':num(2.4*k),'stroke-linecap':'butt'}));
  bar.append(el('text',{x:num(x1+len/2),y:num(y-8*k),'text-anchor':'middle','font-size':num(15*k),fill:'#111111','data-um':um},um>=1000?(um/1000)+' mm':um+' µm'));svg.append(bar);}
 // Legend, two columns under the image
 if(labels.length){const lg=el('g',{id:'legend'});labels.forEach((label,i)=>{const col=i%2,x=pad+col*(W/2),y=H+pad+Math.floor(i/2)*row,color=COLORS[label]||INK,id=paint(label,color),box=22*k;
   lg.append(el('rect',{x:num(x),y:num(y),width:num(box*1.6),height:num(box),fill:id?'url(#'+id+')':label==='CB'||label==='PL'?'#ffffff':color,'fill-opacity':id||label==='CB'||label==='PL'?'1':'.14',stroke:label==='PL'?color:INK,'stroke-width':num((label==='CB'?.9:.7)*k)}));
   lg.append(el('text',{x:num(x+box*1.6+10*k),y:num(y+box*.76),'font-size':num(15*k),fill:'#111111'},label+(NAMES[label]?'  '+NAMES[label]:'')));});svg.append(lg);}
 return{svg,width:W,height:total};
}
const serialize=svg=>'<?xml version="1.0" encoding="UTF-8"?>\n'+new XMLSerializer().serializeToString(svg);

async function embeddedRaster(limit){const image=$('analysisRaster'),href=image?.getAttribute('href');if(!href)return null;
 const picture=new Image();picture.src=href;await picture.decode();const scale=Math.min(1,limit/Math.max(picture.naturalWidth,picture.naturalHeight));
 const canvas=document.createElement('canvas');canvas.width=Math.round(picture.naturalWidth*scale);canvas.height=Math.round(picture.naturalHeight*scale);canvas.getContext('2d').drawImage(picture,0,0,canvas.width,canvas.height);return canvas.toDataURL('image/png');}

async function figure(format){const api=window.CerebellumAnalysis,state=api?.snapshot?.();if(!state||!state.rois?.length)throw Error('There are no outlines to draw yet.');
 const image=$('analysisRaster'),W=Number(image?.getAttribute('width')),H=Number(image?.getAttribute('height'));if(!(W>0&&H>0))throw Error('Open the section image first.');
 const mode=$('analysisViewMode')?.value||'overlay',shown=new Set([...document.querySelectorAll('#analysisContours [data-roi]')].map(n=>n.dataset.roi));
 const sx=state.metadata?.um_per_pixel_x,sy=state.metadata?.um_per_pixel_y,um=Number.isFinite(sx)&&sx>0&&(!Number.isFinite(sy)||Math.abs(sx-sy)<=sx*.001)?sx:null;
 const name=($('analysisDropName')?.textContent||'section').trim().replace(/\.[^.]+$/,'')||'section';
 const raster=mode==='roi'?null:await embeddedRaster(format==='svg'?2400:3600);
 const built=build(state,{width:W,height:H,shown:shown.size?shown:null,um,raster,title:name});
 if(format==='svg')return{name:name+'-figure.svg',blob:new Blob([serialize(built.svg)],{type:'image/svg+xml'}),approved:!!state.approval};
 // PNG: 3000 px wide, about 25 cm at 300 dpi
 const out=3000,scale=out/built.width,canvas=document.createElement('canvas');canvas.width=out;canvas.height=Math.round(built.height*scale);
 const url=URL.createObjectURL(new Blob([serialize(built.svg)],{type:'image/svg+xml'}));
 try{const picture=new Image();picture.src=url;await picture.decode();const pen=canvas.getContext('2d');pen.fillStyle='#ffffff';pen.fillRect(0,0,canvas.width,canvas.height);pen.drawImage(picture,0,0,canvas.width,canvas.height);}finally{URL.revokeObjectURL(url);}
 const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('The picture could not be encoded.')),'image/png'));
 return{name:name+'-figure.png',blob,approved:!!state.approval};
}
function save(name,blob){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

const note=$('analysisFigureNote');
function refresh(){const ready=!!window.CerebellumAnalysis?.snapshot?.()?.rois?.length;for(const id of['analysisFigureSVG','analysisFigurePNG']){const b=$(id);if(b)b.disabled=!ready;}}
for(const[id,format]of[['analysisFigureSVG','svg'],['analysisFigurePNG','png']]){const button=$(id);if(!button)continue;
 button.addEventListener('click',async()=>{button.disabled=true;try{const made=await figure(format);save(made.name,made.blob);if(note)note.textContent=made.approved?'Figure saved.':'Figure saved. These outlines are a draft and are not approved.';}
  catch(e){if(note)note.textContent=e.message;}finally{refresh();}});}
const contours=$('analysisContours');if(contours)new MutationObserver(refresh).observe(contours,{childList:true});
refresh();
window.CerebellumAnalysisFigure=Object.freeze({build,serialize,figure});
})();
