// Inside the existing viewer closure: annotations share the source-plane transform.
const annotationGroup=new THREE.Group();root.add(annotationGroup);const sourceGroup=new THREE.Group();root.add(sourceGroup);let sourceSection=null;
const annotationReference=JSON.parse($('annotation-data').textContent);
const annotationColors={unverified:'#a86b00',candidate:'#0071e3',confirmed:'#087c64'};
const annotationNote=document.createElement('div');annotationNote.className='stageTop';annotationNote.style.top='38px';$('stage').append(annotationNote);
// Review markers are an opt-in display layer. Seed proposals and user records stay intact.
const showAnnotations=$('showReviewAnnotations');
function disposeAnnotation(object){object.traverse(c=>{c.geometry?.dispose();if(c.material){c.material.map?.dispose();c.material.dispose();}});}
function annotationVisibility(){const ss=selected(),closest=ss.reduce((a,b)=>Math.abs(a.z-zOf(state.position))<=Math.abs(b.z-zOf(state.position))?a:b);sourceGroup.visible=state.tab!=='explore'&&sourceSection===closest.id;let count=0;for(const g of annotationGroup.children){g.visible=state.tab==='cut'&&Boolean(showAnnotations?.checked)&&g.userData.section_id===closest.id;if(g.visible)count++;}annotationNote.textContent=count?`${closest.id} · annotations: ${count} / yellow: unverified · blue: candidate · mint: observation-confirmed`:'';}
showAnnotations?.addEventListener('change',()=>{annotationVisibility();render();});
document.addEventListener('annotations:changed',ev=>{
 for(const old of [...annotationGroup.children]){annotationGroup.remove(old);disposeAnnotation(old);}
 for(const a of ev.detail){if(a.deleted)continue;const s=model.sections.find(s=>s.id===a.section_id);if(!s)continue;const g=new THREE.Group();g.userData.section_id=a.section_id;g.userData.annotationId=a.id;annotationGroup.add(g);const pts=a.points_px.map(p=>{const xy=AnnotationCore.toDisplay(p,s,4956);return new THREE.Vector3(xy[0],xy[1],s.z);});const col=annotationColors[a.status];
  for(const p of pts){const dot=new THREE.Mesh(new THREE.SphereGeometry(.005,8,6),new THREE.MeshBasicMaterial({color:col,depthTest:false}));dot.position.copy(p);dot.renderOrder=15;g.add(dot);}
  if(a.geometry!=='point'){const ps=a.geometry==='polygon'?[...pts,pts[0]]:pts;const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(ps),new THREE.LineBasicMaterial({color:col,depthTest:false}));line.renderOrder=15;g.add(line);}
  // Names remain available in Annotate; 3D uses point/path geometry without billboard labels.
 }
 annotationVisibility();render();
});
document.addEventListener('annotations:focus',ev=>{const s=model.sections.find(s=>s.id===ev.detail.section_id);if(!s)return;if(showAnnotations)showAnnotations.checked=true;state.dataset=s.number>37?'all_1_67':'continuous_1_37';$('dataset').value=state.dataset;state.position=s.number;state.tx=state.ty=0;$('position').value=s.number;$('tiltX').value=$('tiltY').value=0;sectionOptions();document.querySelector('[data-tab="cut"]').click();drawSlice();});

document.addEventListener('sources:3d',ev=>{const f=ev.detail,s=model.sections.find(s=>s.id===f.section_id);sourceSection=f.section_id;for(const old of [...sourceGroup.children]){sourceGroup.remove(old);disposeAnnotation(old);}for(const path of f.paths_px){const ps=path.map(p=>{const xy=AnnotationCore.toDisplay(p,s,4956);return new THREE.Vector3(xy[0],xy[1],s.z);});if(f.kind==='area')ps.push(ps[0].clone());const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(ps),new THREE.LineBasicMaterial({color:'#b47700',depthTest:false}));line.renderOrder=19;sourceGroup.add(line);}annotationVisibility();render();});
