const contourSets={};
for(const align of ['aligned','raw']){const group=new THREE.Group();contourSets[align]=group;root.add(group);for(const section of model.sections){const sg=new THREE.Group();sg.userData.section_id=section.id;for(const k of ['ML','GL','WM','CB'])for(const p of (align==='raw'?section.raw_contours:section.contours)[k]){const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(p.map(v=>new THREE.Vector3(...v))),new THREE.LineBasicMaterial({color:{ML:'#b5b5b5',GL:'#5c5c5c',WM:'#777777',CB:'#929292'}[k],transparent:true,opacity:.6}));line.userData.layer=k;sg.add(line);}group.add(sg);}}
// Actual first/last observations make the observed range legible without inventing a closure.
// The mask uses the same stored field and XY rasterisation as the observed-plane viewer.
const observedEnds=new THREE.Group(),observedEndMeshes=new Map();observedEnds.name='Observed end sections';root.add(observedEnds);
function observedEnd(field,mask){
 let entry=observedEndMeshes.get(field.id);
 if(!entry){const image=document.createElement('canvas');image.width=image.height=SIZE;const texture=new THREE.CanvasTexture(image);texture.colorSpace=THREE.SRGBColorSpace;texture.minFilter=THREE.LinearFilter;
  const material=new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide,transparent:false,alphaTest:.5,depthWrite:true,polygonOffset:true,polygonOffsetFactor:0,polygonOffsetUnits:-64});
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(SPAN,SPAN),material);mesh.position.z=field.z;mesh.userData.observedSection=field.id;mesh.userData.sourceDepth=field.z;observedEnds.add(mesh);entry={mesh,image,texture,mask:null};observedEndMeshes.set(field.id,entry);
 }
 if(entry.mask!==mask){const context=entry.image.getContext('2d'),image=context.createImageData(SIZE,SIZE);
  for(let py=0;py<SIZE;py++)for(let px=0;px<SIZE;px++){const gx=(((px+.5)/SIZE-.5)*SPAN-vol.origin_xy[0])/vol.step,gy=((.5-(py+.5)/SIZE)*SPAN-vol.origin_xy[1])/vol.step;let bits=0;
   if(gx>=0&&gy>=0&&gx<W-1&&gy<H-1)for(let k=0;k<4;k++)if((mask&(1<<k))&&bilinear(field.array,k,gx,gy)>0)bits|=1<<k;
   image.data.set([...color(bits,px,py),bits?255:0],(py*SIZE+px)*4);
  }
  context.putImageData(image,0,0);entry.texture.needsUpdate=true;entry.mask=mask;
 }
 return entry.mesh;
}
function refreshObservedEnds(exploring,ss){
 observedEnds.visible=exploring&&state.mode!=='observed'&&state.showEndSections;
 for(const entry of observedEndMeshes.values())entry.mesh.visible=false;
 if(!observedEnds.visible)return;
 const mask=(state.layers.CB.show?1:0)|(state.layers.ML.show?2:0)|(state.layers.GL.show?4:0)|(state.layers.WM.show?8:0);
 for(const field of [ss[0],ss.at(-1)])observedEnd(field,mask).visible=true;
}
function refreshExplorer(){const exploring=state.tab==='explore',ss=selected(),ids=new Set(ss.map(s=>s.id));plane.visible=state.tab==='cut';axis.visible=state.tab==='cut';annotationGroup.visible=!exploring;refreshObservedEnds(exploring,ss);
 for(const [key,group] of Object.entries(meshSets)){group.visible=key===state.dataset&&(exploring?state.mode!=='observed':$('context').checked);for(const mesh of group.children){const k=mesh.userData.layer;mesh.visible=exploring?state.layers[k].show:['CB','WM'].includes(k);const material=mesh.material,opacity=exploring?state.layers[k].opacity:k==='CB'?.10:.20;
  // Sorted blending cannot order intersecting tissue surfaces consistently during rotation.
  // Opaque surfaces and optional hashed coverage use the depth buffer without changing geometry.
  // Sub-pixel depth bias resolves exactly coincident source triangles in a fixed layer order.
  const hashed=exploring&&opacity<1,transparent=!exploring;
  if(material.alphaHash!==hashed||material.transparent!==transparent){material.alphaHash=hashed;material.transparent=transparent;material.needsUpdate=true;}
  material.opacity=opacity;material.depthWrite=exploring;material.polygonOffset=exploring;}}
 for(const [align,group] of Object.entries(contourSets)){group.visible=exploring&&state.mode!=='surface'&&align===state.align;for(const sg of group.children){sg.visible=ids.has(sg.userData.section_id);for(const line of sg.children){line.visible=state.layers[line.userData.layer].show;line.material.opacity=state.layers[line.userData.layer].opacity;}}}
 $('datasetExplore').value=state.dataset;$('exploreAlign').disabled=state.mode!=='observed';if(state.mode!=='observed'){$('exploreAlign').value='aligned';state.align='aligned';}
 $('exploreStatus').textContent=`${ss.length} observed planes · ${{surface:'Inferred surface',observed:'Observed contours',both:'Observed + inferred'}[state.mode]}`;
}
for(const k of ['ML','GL','WM','CB']){$('layer-'+k).onchange=e=>{state.layers[k].show=e.target.checked;refreshExplorer();render();};$('opacity-'+k).oninput=e=>{state.layers[k].opacity=+e.target.value;refreshExplorer();render();};}
if($('exploreEndSections'))$('exploreEndSections').onchange=e=>{state.showEndSections=e.target.checked;refreshExplorer();render();};
$('datasetExplore').onchange=e=>{state.dataset=e.target.value;$('dataset').value=state.dataset;sectionOptions();drawSlice();};
$('exploreMode').onchange=e=>{state.mode=e.target.value;refreshExplorer();render();};$('exploreAlign').onchange=e=>{state.align=e.target.value;refreshExplorer();render();};
$('exploreDepth').oninput=e=>{state.depth=+e.target.value;$('exploreDepthOut').textContent=state.depth.toFixed(1)+'×';drawSlice();};
$('exploreLeft').onclick=()=>{state.ry-=.25;render();};$('exploreRight').onclick=()=>{state.ry+=.25;render();};$('exploreFront').onclick=()=>{state.rx=state.ry=0;render();};
for(const [id,f] of [['exploreZoomIn',1.15],['exploreZoomOut',1/1.15]])$(id).onclick=()=>{state.zoom=Math.max(.65,Math.min(2.3,state.zoom*f));render();};
$('exploreReset').onclick=()=>{state.rx=-.28;state.ry=-.6;state.zoom=1.5;render();};
let autoTime=0;function rotateFrame(now){if(!state.auto||state.tab!=='explore')return;state.ry+=(autoTime?Math.min(60,now-autoTime):16)*.00022;autoTime=now;render();requestAnimationFrame(rotateFrame);}
$('exploreAuto').onclick=()=>{state.auto=!state.auto;$('exploreAuto').textContent=state.auto?'Stop rotation':'Auto-rotate';$('exploreAuto').setAttribute('aria-pressed',String(state.auto));if(state.auto){autoTime=0;requestAnimationFrame(rotateFrame);}};
document.addEventListener('visibilitychange',()=>{if(document.hidden&&state.auto){state.auto=false;$('exploreAuto').textContent='Auto-rotate';$('exploreAuto').setAttribute('aria-pressed','false');}});
for(const b of document.querySelectorAll('[data-go]'))b.onclick=()=>document.querySelector(`[data-tab="${b.dataset.go}"]`).click();
