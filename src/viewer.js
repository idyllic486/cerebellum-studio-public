(()=>{'use strict';
const $=id=>document.getElementById(id),parse=id=>JSON.parse($(id).textContent);
function fail(e){$('error').textContent='Runtime error: '+(e.message||e);$('error').classList.remove('hidden');}
window.addEventListener('error',e=>{if(/^ResizeObserver loop/.test(e.message||''))return;fail(e.error||e.message);});
try{
const model=parse('model-data'),vol=parse('volume-data'),thumbs=parse('thumbnail-data');
if(matchMedia('(max-width:900px)').matches)$('conditions').open=false;
const state={dataset:'continuous_1_37',position:19,tx:0,ty:0,rx:-.28,ry:-.6,zoom:1.5,tab:'explore',mode:'surface',align:'aligned',depth:1,auto:false,showEndSections:true,layers:{ML:{show:true,opacity:1},GL:{show:true,opacity:1},WM:{show:true,opacity:1},CB:{show:false,opacity:.15}}};
const H=vol.shape_yx[0],W=vol.shape_yx[1],N=W*H,SIZE=440,SPAN=1.36;
function bytes(s){const t=atob(s),a=new Uint8Array(t.length);for(let i=0;i<t.length;i++)a[i]=t.charCodeAt(i);return a;}
const fields=vol.fields.map(f=>({...f,array:new Int16Array(bytes(f.values).buffer)}));
// Presentation palette only: source layer masks, contours and measurements are unchanged.
const tissueColors={ML:0xb5b5b5,GL:0x5c5c5c,WM:0xe6e6e6,CB:0x929292};
const colors={2:[181,181,181],4:[92,92,92],8:[230,230,230]};
const background=[250,250,252];
function color(bits,x,y){
 const count=Number(Boolean(bits&2))+Number(Boolean(bits&4))+Number(Boolean(bits&8));
 if(count>1)return (x+y)%7<3?[218,225,225]:[71,86,96];
 if(bits&2)return colors[2];if(bits&4)return colors[4];if(bits&8)return colors[8];
 return bits&1?[146,146,146]:background;
}
function selected(){return state.dataset==='continuous_1_37'?fields.slice(0,7):fields;}
function zOf(n){
 // Observed planes use the stored (rounded) field depth, including range endpoints.
 // Recomputing it can miss the observation tolerance or put section 37 outside the volume.
 const section=model.sections.find(s=>s.number===n),observed=section&&fields.find(s=>s.id===section.id);
 return observed?observed.z:(n-34)/66*.7;
}
const canvas=$('sliceCanvas'),ctx=canvas.getContext('2d');
const textureCanvas=document.createElement('canvas');textureCanvas.width=textureCanvas.height=SIZE;const texctx=textureCanvas.getContext('2d');
const renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true});renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));renderer.setClearColor(0x000000,0);renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.domElement.setAttribute('aria-label','3D cerebellum and current cutting plane');renderer.domElement.setAttribute('role','img');$('stage').prepend(renderer.domElement);
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(33,1,.25,12);camera.position.z=3.1;
scene.add(new THREE.AmbientLight(0xffffff,1.3));const lamp=new THREE.DirectionalLight(0xffffff,1.6);lamp.position.set(-2,3,4);scene.add(lamp);
const pivot=new THREE.Group(),root=new THREE.Group();scene.add(pivot);pivot.add(root);const meshSets={};
for(const [key,ds] of Object.entries(model.datasets)){
 const group=new THREE.Group();meshSets[key]=group;root.add(group);
 for(const k of ['ML','GL','WM','CB']){const layer=ds.layers[k],g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(layer.vertices.flat(),3));g.setIndex(layer.faces.flat());g.computeVertexNormals();const m=new THREE.MeshStandardMaterial({color:tissueColors[k],roughness:.85,side:THREE.DoubleSide,transparent:false,opacity:1,depthWrite:true,polygonOffset:true,polygonOffsetFactor:0,polygonOffsetUnits:16*['ML','GL','WM','CB'].indexOf(k)});const mesh=new THREE.Mesh(g,m);mesh.userData.layer=k;group.add(mesh);}
}
const tex=new THREE.CanvasTexture(textureCanvas);tex.colorSpace=THREE.SRGBColorSpace;
const plane=new THREE.Mesh(new THREE.PlaneGeometry(SPAN,SPAN),new THREE.MeshBasicMaterial({map:tex,transparent:true,side:THREE.DoubleSide,depthWrite:false}));plane.renderOrder=5;root.add(plane);
const border=new THREE.LineSegments(new THREE.EdgesGeometry(plane.geometry),new THREE.LineBasicMaterial({color:0x555555,transparent:true,opacity:.9,depthTest:false}));plane.add(border);
const axis=new THREE.AxesHelper(.22);axis.position.set(-.58,-.56,0);root.add(axis);
function render(){pivot.rotation.set(state.rx,state.ry,0);camera.position.z=3.1/state.zoom;camera.near=state.tab==='explore'?.25:.01;camera.updateProjectionMatrix();renderer.render(scene,camera);}
function resize(){const w=$('stage').clientWidth,h=$('stage').clientHeight;if(!w||!h)return;renderer.setSize(w,h);camera.aspect=w/h;render();}new ResizeObserver(resize).observe($('stage'));
let drag=null;renderer.domElement.addEventListener('pointerdown',e=>{drag=[e.clientX,e.clientY];renderer.domElement.setPointerCapture(e.pointerId);});renderer.domElement.addEventListener('pointermove',e=>{if(!drag)return;state.ry+=(e.clientX-drag[0])*.008;state.rx+=(e.clientY-drag[1])*.008;drag=[e.clientX,e.clientY];render();});renderer.domElement.addEventListener('pointerup',()=>drag=null);renderer.domElement.addEventListener('pointercancel',()=>drag=null);renderer.domElement.addEventListener('wheel',e=>{e.preventDefault();state.zoom=Math.max(.65,Math.min(2.3,state.zoom*Math.exp(-e.deltaY*.001)));render();},{passive:false});
function bilinear(a,k,gx,gy){const x=Math.floor(gx),y=Math.floor(gy),fx=gx-x,fy=gy-y,i=k*N+y*W+x;return (a[i]*(1-fx)+a[i+1]*fx)*(1-fy)+(a[i+W]*(1-fx)+a[i+W+1]*fx)*fy;}
function basis(){const e=new THREE.Euler(state.tx*Math.PI/180,state.ty*Math.PI/180,0,'XYZ');return {e,u:new THREE.Vector3(1,0,0).applyEuler(e),v:new THREE.Vector3(0,1,0).applyEuler(e)};}
function drawSlice(){
 if(typeof annotationVisibility==='function')annotationVisibility();
 const ss=selected(),{e,u,v}=basis(),z0=zOf(state.position),zmin=ss[0].z,zmax=ss.at(-1).z;
 plane.rotation.copy(e);plane.position.z=z0;root.scale.z=state.depth;root.position.z=-(zmin+zmax)/2*state.depth;
 if(typeof refreshExplorer==='function')refreshExplorer();
 const img=ctx.createImageData(SIZE,SIZE),teximg=texctx.createImageData(SIZE,SIZE);let tissue=0,near=0,cb=0,overlap=0,unknown=0,different=0;
 const showDiff=$('sensitivity').checked;
 for(let py=0;py<SIZE;py++)for(let px=0;px<SIZE;px++){
  const a=((px+.5)/SIZE-.5)*SPAN,b=(.5-(py+.5)/SIZE)*SPAN;
  const x=u.x*a+v.x*b,y=u.y*a+v.y*b,z=z0+u.z*a+v.z*b;
  const gx=(x-vol.origin_xy[0])/vol.step,gy=(y-vol.origin_xy[1])/vol.step;
  let bits=0,nb=0,valid=z>=zmin-1e-9&&z<=zmax+1e-9&&gx>=0&&gy>=0&&gx<W-1&&gy<H-1,close=false;
  if(valid){let hi=1;while(hi<ss.length-1&&ss[hi].z<z)hi++;const lo=hi-1,t=Math.max(0,Math.min(1,(z-ss[lo].z)/(ss[hi].z-ss[lo].z)));close=Math.min(t,1-t)<=.05;
   for(let k=0;k<4;k++){const l=bilinear(ss[lo].array,k,gx,gy),r=bilinear(ss[hi].array,k,gx,gy);if(l*(1-t)+r*t>0)bits|=1<<k;if((t<.5?l:r)>0)nb|=1<<k;}
  }
  const count=Number(Boolean(bits&2))+Number(Boolean(bits&4))+Number(Boolean(bits&8));
  if(bits){tissue++;if(close)near++;}if(bits&1){cb++;if(count>1)overlap++;if(count===0)unknown++;}
  if(valid&&bits!==nb)different++;
  let c=color(bits,px,py);if(showDiff&&valid&&bits!==nb)c=[236,190,99];
  if(!valid)c=(Math.floor(px/9)+Math.floor(py/9))%2?[237,240,244]:[229,233,239];
  const idx=(py*SIZE+px)*4;img.data.set([...c,255],idx);teximg.data.set([...c,bits?240:0],idx);
 }
 ctx.putImageData(img,0,0);texctx.putImageData(teximg,0,0);
 const observed=ss.find(s=>Math.abs(s.z-z0)<1e-7),parallel=state.tx===0&&state.ty===0;
 if(parallel&&observed&&$('overlay').checked){const s=model.sections.find(s=>s.id===observed.id);ctx.lineWidth=.85;ctx.strokeStyle='#30343b';ctx.globalAlpha=.85;for(const k of ['CB','ML','GL','WM'])for(const p of s.contours[k]){ctx.beginPath();p.forEach((v,i)=>{const x=(v[0]/SPAN+.5)*SIZE,y=(.5-v[1]/SPAN)*SIZE;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.closePath();ctx.stroke();}ctx.globalAlpha=1;}
 tex.needsUpdate=true;
 $('positionOut').textContent=state.position.toFixed(1)+'';$('tiltXOut').textContent=state.tx+'°';$('tiltYOut').textContent=state.ty+'°';$('nSections').textContent=ss.length;
 $('sliceTag').textContent=parallel&&observed?'Observed plane':'Inferred section';
 $('supportPct').textContent=tissue?(near/tissue*100).toFixed(1)+'%':'—';$('overlapPct').textContent=cb?(overlap/cb*100).toFixed(2)+'%':'—';$('unknownPct').textContent=cb?(unknown/cb*100).toFixed(2)+'%':'—';
 let msg=parallel&&observed?`<strong>${observed.id} · actual observed-plane position</strong><br>Colours are the rasterised source ROIs. Black lines are the observed contours${$('overlay').checked?'.':', currently hidden.'}`:`<strong>Inferred section · position ${state.position.toFixed(1)} / tilt ${state.tx}°, ${state.ty}°</strong><br>Signed distance fields between actual sections were linearly interpolated. Hatched areas are outside the computed range.`;
 if(showDiff)msg+=`<br>Yellow: locations where classification differs between linear interpolation and the nearest-observed-plane method (${different.toLocaleString()} pixels). This reflects method sensitivity, not a confidence probability.`;
 if(ss.length===12)msg+='<br>Extended range: detached tissue fragments from No. 43 onward retain their positions within the images. Artificial connections may arise.';
 $('sliceStatus').innerHTML=msg;
 const nearest=ss.reduce((a,b)=>Math.abs(a.z-z0)<=Math.abs(b.z-z0)?a:b);$('section').value=observed&&parallel?observed.id:'';$('sourceNote').textContent=`Nearest actual image: ${nearest.id}`;$('sourceThumb').src=thumbs[nearest.id];$('sourceThumb').alt=nearest.id+' downsampled image of actual section';
 render();
}
let scheduled=false;function update(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;drawSlice();});}
function sectionOptions(){const ss=selected();$('section').innerHTML='<option value="">Free-cut position</option>'+ss.map(s=>`<option value="${s.id}">${s.id}</option>`).join('');$('position').max=state.dataset==='continuous_1_37'?37:67;state.position=Math.min(state.position,+$('position').max);$('position').value=state.position;}
for(const [id,key] of [['position','position'],['tiltX','tx'],['tiltY','ty']])$(id).addEventListener('input',ev=>{state[key]=+ev.target.value;update();});
$('dataset').onchange=ev=>{state.dataset=ev.target.value;sectionOptions();update();};
$('section').onchange=ev=>{if(!ev.target.value)return;state.position=+ev.target.value.split('-')[1];state.tx=state.ty=0;$('position').value=state.position;$('tiltX').value=$('tiltY').value=0;update();};
for(const id of ['overlay','context','sensitivity'])$(id).onchange=update;
$('resetPlane').onclick=()=>{state.tx=state.ty=0;$('tiltX').value=$('tiltY').value=0;update();};
$('oblique').onclick=()=>{state.tx=30;state.ty=20;$('tiltX').value=30;$('tiltY').value=20;update();};
$('front').onclick=()=>{state.rx=state.ry=0;render();};$('perspective').onclick=()=>{state.rx=-.35;state.ry=-.7;state.zoom=1;render();};$('zoom').onclick=()=>{state.zoom=state.zoom>=1.8?1:state.zoom+.2;render();};
$('export').onclick=()=>{const out=document.createElement('canvas');out.width=SIZE;out.height=SIZE+118;const c=out.getContext('2d');c.fillStyle='#fafafc';c.fillRect(0,0,out.width,out.height);c.drawImage(canvas,0,0);c.fillStyle='#1d1d1f';c.font='14px sans-serif';c.fillText(window.CerebellumI18n?.format('{0} / v0.4 / section {1} / tilt {2}, {3} deg',model.metadata.mouse,state.position,state.tx,state.ty)??`${model.metadata.mouse} / v0.4 / section ${state.position} / tilt ${state.tx}, ${state.ty} deg`,14,SIZE+24);c.font='12px sans-serif';c.fillText($('sliceTag').textContent+' | '+(window.CerebellumI18n?.t('synthetic depth, no physical volume')??'synthetic depth, no physical volume'),14,SIZE+46);c.fillText(window.CerebellumI18n?.t('ML: light grey   GL: dark grey   WM: pearl   CB: grey')??'ML: light grey   GL: dark grey   WM: pearl   CB: grey',14,SIZE+68);c.fillText(window.CerebellumI18n?.t('Hatching: overlap | checkerboard: outside observed range')??'Hatching: overlap | checkerboard: outside observed range',14,SIZE+88);c.fillText((window.CerebellumI18n?.t('Sensitivity overlay:')??'Sensitivity overlay:')+' '+(window.CerebellumI18n?.t($('sensitivity').checked?'ON (yellow)':'OFF')??($('sensitivity').checked?'ON (yellow)':'OFF')),14,SIZE+108);const a=document.createElement('a');a.download=`${model.metadata.mouse}-v04-section-${state.position}-tilt-${state.tx}-${state.ty}.png`;a.href=out.toDataURL('image/png');a.click();};
function drawBits(c,bits){const cx=c.getContext('2d'),image=cx.createImageData(257,257);for(let i=0;i<bits.length;i++)image.data.set([...color(bits[i],i%257,Math.floor(i/257)),255],i*4);cx.putImageData(image,0,0);}
$('holdSection').innerHTML=vol.holdouts.map((h,i)=>`<option value="${i}">${h.id}</option>`).join('');$('holdSection').value='2';
function hold(){const h=vol.holdouts[+$('holdSection').value],pred=bytes(h.predicted),truth=bytes(h.observed),layer=$('diffLayer').value,k=1<<vol.layer_order.indexOf(layer);drawBits($('predictionCanvas'),pred);
 const cx=$('differenceCanvas').getContext('2d'),image=cx.createImageData(257,257);for(let i=0;i<pred.length;i++){const p=pred[i]&k,t=truth[i]&k,c=p&&t?[122,146,155]:p?[237,184,121]:t?[217,134,187]:background;image.data.set([...c,255],i*4);}cx.putImageData(image,0,0);
 // A shared display crop improves visibility only; stored predictions and scores are unchanged.
 const points=[];for(let i=0;i<pred.length;i++)if(pred[i]||truth[i])points.push(i);
 if(points.length){const xs=points.map(i=>i%257),ys=points.map(i=>Math.floor(i/257));const x=Math.max(0,Math.min(...xs)-12),y=Math.max(0,Math.min(...ys)-12),w=Math.min(257,Math.max(...xs)+13)-x,hh=Math.min(257,Math.max(...ys)+13)-y;const side=Math.max(w,hh);for(const id of ['predictionCanvas','differenceCanvas']){const c=$(id),copy=document.createElement('canvas');copy.width=copy.height=257;copy.getContext('2d').drawImage(c,0,0);const cc=c.getContext('2d');cc.fillStyle='#fafafc';cc.fillRect(0,0,257,257);cc.drawImage(copy,x,y,w,hh,(257-w/side*240)/2,(257-hh/side*240)/2,w/side*240,hh/side*240);}}
 $('holdNeighbors').textContent=h.neighbors.join(' + ')+' → '+h.id+' predicted';$('diceMetrics').innerHTML=vol.layer_order.map(k=>`<div class="metric"><small>${k} · Dice</small><b>${h.metrics[k].dice.toFixed(3)}</b></div>`).join('');
}
$('holdSection').onchange=hold;$('diffLayer').onchange=hold;
function atlas(){const a=vol.atlas[+$('atlasPage').value];$('atlasImage').src=a.image;$('atlasCaption').textContent=`PDF ${a.page} · Figure ${a.figure} · atlas lateral ${a.lateral_mm.toFixed(2)} mm`;$('atlasImage').alt=`Franklin & Paxinos 2007 Figure ${a.figure}, Lateral ${a.lateral_mm} mm sagittal`;}
$('atlasPage').onchange=atlas;
function activateView(tab){state.tab=tab;if(tab==='explore'||tab==='cut'){(tab==='explore'?$('exploreStageHost'):$('cutStageHost')).append($('stage'));resize();drawSlice();}else if(tab==='hold')hold();else if(tab==='atlas')atlas();if(tab!=='explore'&&state.auto){state.auto=false;$('exploreAuto').textContent='Auto-rotate';}}
window.addEventListener('cerebellum-view-change',event=>activateView(event.detail.tab));

__ANNOTATION_ADAPTER__
__STUDIO_EXPLORER__
sectionOptions();hold();atlas();resize();drawSlice();activateView(document.body.dataset.view);
}catch(e){fail(e);throw e;}
})();
