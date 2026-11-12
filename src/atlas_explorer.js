/* Source atlas drawings in physical space. No specimen data or measurements are changed. */
(() => {
  'use strict';
  const root=document.getElementById('atlasExplorer');
  if(!root)return;
  const $=id=>document.getElementById(id), url=window.CerebellumBoot?.profile.atlas_reference?.url||'./assets/atlas-open/sagittal-planes.json';
  const SCHEMAS=['cerebellum-atlas-plane-series/1','cerebellum-atlas-drawing-series/1'];
  // The whole-cerebellum outline always shows; the layer outlines can be turned off.
  const isOuter=path=>path.role==='boundary_ink'||path.compartment==='Cb',isDrawn=path=>!path.compartment||['Cb','GL+WM','WM'].includes(path.compartment);
  let data=null, loading=false, ready=false, error=null, selected=0, surfaceAvailable=false;
  let renderer,scene,camera,pivot,geometryRoot,surfaceMesh,center,span=1,boundingRadius=1,observer,resizeObserver;
  const planeGroups=[], pointers=new Map(), placedGroups=new Map();
  let placed=null, placedAnimal='', placedCompare='', recording=false, lastVideo=null;
  const PLACED_COLOURS={Cb:0x2b2f33,GL_TOTAL:0x0097a7,WM:0xef6c00,PL_TOTAL:0xd500a0};
  let drag=null,pinchDistance=null,renderFrame=0;
  const fmt=n=>(n/1000).toFixed(2);
  const controls=['atlasRefPlate','atlasRefPosition','atlasRefPerspective','atlasRefSagittal','atlasRefReset','atlasRefZoomOut','atlasRefZoomIn','atlasRefStack','atlasRefInner'];
  function setControls(enabled){controls.forEach(id=>$(id).disabled=!enabled);}
  setControls(false);
  function validate(value){
    if(!SCHEMAS.includes(value?.schema)||value.unit!=='um'||value.series?.plane!=='sagittal'||value.series?.axis!=='ML')throw Error('This reference does not declare a supported physical sagittal series.');
    if(!Array.isArray(value.plates)||value.plates.length<1||value.plates.length>160)throw Error('The reference has no usable section series.');
    let vertices=0; const ids=new Set(),depths=new Set();
    for(const p of value.plates){
      if(!p.id||ids.has(p.id)||!Number.isFinite(p.lateral_um)||depths.has(p.lateral_um)||!Array.isArray(p.paths))throw Error('A reference plane has invalid or repeated identity/depth.');
      ids.add(p.id);depths.add(p.lateral_um);
      for(const path of p.paths){
        if(!Array.isArray(path.points)||path.points.length<2||!path.points.every(pt=>Array.isArray(pt)&&pt.length===2&&pt.every(Number.isFinite)))throw Error('A source curve contains invalid physical coordinates.');
        vertices+=path.points.length;
      }
    }
    if(vertices>1500000)throw Error('The reference exceeds the display geometry limit.');
    return value;
  }
  async function readJSON(path){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);try{
    const response=await fetch(path,{credentials:'same-origin',signal:controller.signal});
    if(!response.ok)throw Error('Reference could not be loaded ('+response.status+').');
    if(Number(response.headers.get('content-length'))>40*1024*1024)throw Error('Reference is larger than the supported download.');
    const text=await response.text();if(text.length>40*1024*1024)throw Error('Reference is larger than the supported download.');
    return JSON.parse(text);
    }finally{clearTimeout(timer);}
  }
  function render(){if(!renderer||renderFrame)return;renderFrame=requestAnimationFrame(()=>{renderFrame=0;renderer.render(scene,camera);if(pivot)updateAxes();});}
  function updateAxes(){
    [['AP',[1,0,0]],['DV',[0,1,0]],['ML',[0,0,1]]].forEach(([name,v])=>{
      const vector=new THREE.Vector3(...v).applyEuler(pivot.rotation),x=48+vector.x*27,y=43-vector.y*27;
      $('atlasRefAxis'+name).setAttribute('x2',x);$('atlasRefAxis'+name).setAttribute('y2',y);
      const label=$('atlasRefAxis'+name+'Label');label.setAttribute('x',x+(vector.x<-.1?-4:5));label.setAttribute('y',y+(vector.y>.1?-5:9));label.setAttribute('text-anchor',vector.x<-.1?'end':'start');
    });
  }
  function resize(){
    if(!renderer)return;const stage=$('atlasRefStage'),w=stage.clientWidth,h=stage.clientHeight;
    if(!w||!h)return;renderer.setSize(w,h,false);const zoomRatio=camera.position.z/fitDistance(camera.aspect);camera.aspect=w/h;camera.position.z=fitDistance(camera.aspect)*zoomRatio;camera.updateProjectionMatrix();render();
  }
  function fitDistance(aspect){const verticalHalfFOV=camera.fov*Math.PI/360,horizontalHalfFOV=Math.atan(Math.tan(verticalHalfFOV)*aspect);return boundingRadius/Math.sin(Math.min(verticalHalfFOV,horizontalHalfFOV))*1.06;}
  function zoom(factor){if(!ready)return;camera.position.z=Math.max(span*.55,Math.min(span*12,camera.position.z*factor));render();}
  function preset(name){
    if(!pivot)return;
    pivot.position.set(0,0,0);
    if(name==='section')pivot.rotation.set(0,0,0);else pivot.rotation.set(-.22,-.7,.02);
    $('atlasRefPerspective').setAttribute('aria-pressed',String(name!=='section'));
    $('atlasRefSagittal').setAttribute('aria-pressed',String(name==='section'));render();
  }
  function reset(){if(!ready)return;camera.position.set(0,0,fitDistance(camera.aspect));preset('perspective');}
  function updateVisibility(){
    const showStack=$('atlasRefStack').checked, showInner=$('atlasRefInner').checked;
    planeGroups.forEach((group,index)=>{
      group.visible=showStack||index===selected;
      group.children.forEach(line=>{
        const isSelected=index===selected;
        line.visible=showInner||line.userData.outer;
        line.material.color.setHex(isSelected?0xac743a:0x7c93a3);
        line.material.opacity=isSelected?.97:(line.userData.outer?.3:.16);
        line.material.depthTest=!isSelected;
        line.renderOrder=isSelected?3:1;
      });
    });
    if(surfaceMesh)surfaceMesh.visible=$('atlasRefSurface').checked;
    render();
  }
  function selectPlane(index){
    if(!data)return;selected=Math.max(0,Math.min(data.plates.length-1,Math.round(index)));const p=data.plates[selected];
    $('atlasRefPlate').value=String(selected);$('atlasRefPosition').value=String(selected);
    $('atlasRefPositionLabel').textContent=(selected+1)+' / '+data.plates.length;
    $('atlasRefCoordinate').textContent='Lateral '+fmt(p.lateral_um)+' mm';
    $('atlasRefStatus').textContent='Plane '+(selected+1)+' of '+data.plates.length+' · Lateral '+fmt(p.lateral_um)+' mm. Outlines of an annotated average brain, not specimen tissue.';
    updateVisibility();
  }
  function beginView(){
    const T=window.THREE;if(!T)throw Error('The 3D renderer is not available. Reload the page to retry.');
    const coordinates=[];for(const p of data.plates)for(const path of p.paths)for(const xy of path.points)coordinates.push([xy[0]/1000,xy[1]/1000,p.lateral_um/1000]);
    if(!coordinates.length)throw Error('This reference contains no display curves.');
    const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
    for(const point of coordinates)point.forEach((v,i)=>{min[i]=Math.min(min[i],v);max[i]=Math.max(max[i],v);});
    center=min.map((v,i)=>(v+max[i])/2);span=Math.max(...max.map((v,i)=>v-min[i]));
    if(!Number.isFinite(span)||span<=0)throw Error('The reference has no spatial extent.');
    boundingRadius=0;for(const point of coordinates)boundingRadius=Math.max(boundingRadius,Math.hypot(...point.map((v,i)=>v-center[i])));
    renderer=new T.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:false});renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));renderer.setClearColor(0xffffff,0);
    const canvas=renderer.domElement;canvas.tabIndex=0;canvas.setAttribute('aria-label','Atlas 3D view. Arrow keys rotate. Plus and minus zoom. Home resets.');canvas.setAttribute('role','img');
    $('atlasRefStage').prepend(canvas);scene=new T.Scene();camera=new T.PerspectiveCamera(35,1,span*.001,span*50);camera.position.set(0,0,fitDistance(1));
    pivot=new T.Group();scene.add(pivot);geometryRoot=new T.Group();geometryRoot.position.set(-center[0],-center[1],-center[2]);pivot.add(geometryRoot);
    for(const plate of data.plates){
      const group=new T.Group();group.userData.plate=plate.id;geometryRoot.add(group);planeGroups.push(group);
      for(const path of plate.paths){
        if(!isDrawn(path))continue;   // ML and GL rings repeat the Cb, GL+WM and WM outlines
        const pts=path.points.map(([x,y])=>new T.Vector3(x/1000,y/1000,plate.lateral_um/1000));
        const geometry=new T.BufferGeometry().setFromPoints(pts),material=new T.LineBasicMaterial({color:0x7c93a3,transparent:true,opacity:.2,depthWrite:false});
        const line=path.closed?new T.LineLoop(geometry,material):new T.Line(geometry,material);line.userData.role=path.role;line.userData.outer=isOuter(path);line.userData.compartment=path.compartment||null;group.add(line);
      }
    }
    const light=new T.HemisphereLight(0xffffff,0xb8c2cd,1.2);scene.add(light);const key=new T.DirectionalLight(0xffffff,.65);key.position.set(5,8,12);scene.add(key);
    installGestures(canvas);resizeObserver=new ResizeObserver(resize);resizeObserver.observe($('atlasRefStage'));resize();
    renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();$('atlasRefLoadMessage').textContent='The 3D graphics context was interrupted. Reload the page to restore it.';$('atlasRefPlaceholder').hidden=false;});
  }
  function installGestures(canvas){
    canvas.addEventListener('pointerdown',e=>{canvas.focus({preventScroll:true});canvas.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});drag={x:e.clientX,y:e.clientY};if(pointers.size===2){const p=[...pointers.values()];pinchDistance=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);}});
    canvas.addEventListener('pointermove',e=>{
      if(!pointers.has(e.pointerId))return;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(pointers.size===2){const p=[...pointers.values()],distance=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);if(pinchDistance>0&&distance>0)zoom(pinchDistance/distance);pinchDistance=distance;drag={x:e.clientX,y:e.clientY};return;}
      if(!drag||!pivot)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag={x:e.clientX,y:e.clientY};
      if(e.shiftKey){const rate=camera.position.z*.0012;pivot.position.x+=dx*rate;pivot.position.y-=dy*rate;}else{pivot.rotation.y+=dx*.006;pivot.rotation.x+=dy*.006;}
      ['atlasRefPerspective','atlasRefSagittal'].forEach(id=>$(id).setAttribute('aria-pressed','false'));render();
    });
    const finish=e=>{pointers.delete(e.pointerId);drag=null;pinchDistance=null;};['pointerup','pointercancel','lostpointercapture'].forEach(name=>canvas.addEventListener(name,finish));
    canvas.addEventListener('wheel',e=>{e.preventDefault();zoom(Math.exp(Math.max(-100,Math.min(100,e.deltaY))*.002));},{passive:false});
    canvas.addEventListener('keydown',e=>{if(!ready)return;const k=e.key;if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(k)){e.preventDefault();if(k==='ArrowLeft')pivot.rotation.y-=.1;if(k==='ArrowRight')pivot.rotation.y+=.1;if(k==='ArrowUp')pivot.rotation.x-=.1;if(k==='ArrowDown')pivot.rotation.x+=.1;render();}else if(k==='+'||k==='='){e.preventDefault();zoom(.85);}else if(k==='-'){e.preventDefault();zoom(1/.85);}else if(k==='Home'){e.preventDefault();reset();}});
  }
  async function loadSurface(path){
    if(!ready)return false;
    try{
      const value=await readJSON(path),mesh=value.mesh||value;
      if(value.schema!=='cerebellum-atlas-display-surface/1'||value.unit!=='um'||JSON.stringify(value.coordinate_order)!==JSON.stringify(['AP','DV','Lateral'])||!data.source?.sha256||value.source?.sha256!==data.source.sha256)throw Error('The inferred surface does not match this atlas source or physical coordinate frame.');
      if(!Array.isArray(mesh.positions)||mesh.positions.length<9||mesh.positions.length%3||mesh.positions.length>1800000||!mesh.positions.every(Number.isFinite)||!Array.isArray(mesh.indices)||mesh.indices.length<3||mesh.indices.length%3||mesh.indices.length>3600000||!mesh.indices.every(i=>Number.isInteger(i)&&i>=0&&i<mesh.positions.length/3))throw Error('Invalid inferred surface.');
      const T=window.THREE,g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(mesh.positions.map(v=>v/1000),3));g.setIndex(mesh.indices);g.computeVertexNormals();
      const material=new T.MeshStandardMaterial({color:0x9fb1bf,roughness:.65,metalness:.02,transparent:true,opacity:.3,side:T.DoubleSide,depthWrite:false});
      const replacement=new T.Mesh(g,material);replacement.visible=$('atlasRefSurface').checked;geometryRoot.add(replacement);
      if(surfaceMesh){surfaceMesh.removeFromParent();surfaceMesh.geometry.dispose();surfaceMesh.material.dispose();}
      surfaceMesh=replacement;surfaceAvailable=true;
      const previousFit=fitDistance(camera.aspect);
      for(let i=0;i<mesh.positions.length;i+=3)boundingRadius=Math.max(boundingRadius,Math.hypot(mesh.positions[i]/1000-center[0],mesh.positions[i+1]/1000-center[1],mesh.positions[i+2]/1000-center[2]));
      camera.position.z*=fitDistance(camera.aspect)/previousFit;
      const gridSpacing=mesh.grid?.spacing_um;
      $('atlasRefSurfaceNote').textContent='The optional surface is interpolated between published filled-compartment contours. It is a review model, not the complete cerebellum, a tissue measurement or a specimen reconstruction.'+(Number.isFinite(gridSpacing)&&gridSpacing>0?' Display grid spacing: '+gridSpacing.toFixed(2)+' µm. This sampling step is not anatomical accuracy.':'');
      $('atlasRefSurfaceControl').hidden=false;$('atlasRefSurfaceNote').hidden=false;render();return true;
    }catch(reason){$('atlasRefSurfaceNote').hidden=false;$('atlasRefSurfaceNote').textContent='The requested inferred surface could not be loaded. Source curves and any existing reference remain available.';return false;}
  }
  // Sections of a specimen placed in the atlas frame by an offline matching step. The file is chosen by the user and read
  // in this browser only; nothing is fetched or uploaded, and the reference drawings are not changed.
  function validatePlaced(value){
    if(value?.schema!=='cerebellum-atlas-placed-stack/1'||value.unit!=='um'||JSON.stringify(value.coordinate_order)!==JSON.stringify(['AP','DV','Lateral'])||!value.animals||typeof value.animals!=='object')throw Error('unsupported');
    if(!data.source?.sha256||value.atlas_source_sha256!==data.source.sha256)throw Error('other atlas');
    const names=Object.keys(value.animals);if(!names.length||names.length>24)throw Error('animals');
    let vertices=0,sections=0;
    for(const name of names){
      const list=value.animals[name]?.sections;if(!Array.isArray(list)||!list.length||list.length>400)throw Error('sections');
      for(const section of list){
        sections++;if(typeof section.sample!=='string'||!Number.isFinite(section.z)||!section.rois||typeof section.rois!=='object')throw Error('section');
        for(const [roi,lines] of Object.entries(section.rois)){
          if(!(roi in PLACED_COLOURS)||!Array.isArray(lines))throw Error('roi');
          for(const line of lines){if(!Array.isArray(line)||line.length<2||!line.every(pt=>Array.isArray(pt)&&pt.length===2&&pt.every(Number.isFinite)))throw Error('line');vertices+=line.length;}
        }
      }
    }
    if(vertices>1500000)throw Error('size');
    return {value,names:names.sort(),sections,vertices};
  }
  function clearPlaced(keepFileName=false){
    placedGroups.forEach(group=>{group.removeFromParent();group.children.forEach(line=>{line.geometry.dispose();line.material.dispose();});});placedGroups.clear();placed=null;placedAnimal='';placedCompare='';
    $('atlasRefPlacedAnimal').replaceChildren();$('atlasRefPlacedAnimal').disabled=true;$('atlasRefPlacedCompare').replaceChildren();$('atlasRefPlacedCompare').disabled=true;$('atlasRefRecord').disabled=true;$('atlasRefPlacedClear').disabled=true;if(keepFileName!==true)$('atlasRefPlacedFile').value='';
    $('atlasRefPlacedStatus').textContent='No placed sections are loaded. The file is read on this computer and is not uploaded.';render();
  }
  // One animal alone sits on the reference; two animals stand side by side, the first on the left, each moved sideways by
  // the same amount along the anterior-posterior axis. The sideways move is for viewing only and changes no coordinate in the file.
  function showPlaced(name,compare=placedCompare){
    if(!placed)return;if(compare===name)compare='';placedAnimal=name;placedCompare=compare;
    const half=compare?span*.58:0;
    placedGroups.forEach((group,key)=>{group.visible=key===name||key===compare;group.position.x=key===name?-half:key===compare?half:0;});
    $('atlasRefPlacedAnimal').value=name;$('atlasRefPlacedCompare').value=compare;
    const count=key=>placed.value.animals[key].sections.length,label=key=>key+(placed.value.animals[key].group?' ('+placed.value.animals[key].group+')':'');
    $('atlasRefPlacedStatus').textContent=compare?count(name)+' sections of '+label(name)+' on the left and '+count(compare)+' sections of '+label(compare)+' on the right, each at its matched atlas positions. These are estimated positions in the atlas frame, not a measured reconstruction.':count(name)+' sections of '+name+' placed at their matched atlas positions. These are estimated positions in the atlas frame, not a measured reconstruction.';
    if(ready)camera.position.z=fitDistance(camera.aspect)*(compare?1.75:1);
    render();
  }
  // One full turn about the vertical axis, recorded from the 3D canvas itself. The file is made in this browser.
  function videoType(){if(typeof MediaRecorder==='undefined')return null;return ['video/mp4;codecs=avc1','video/mp4','video/webm;codecs=vp9','video/webm'].find(type=>MediaRecorder.isTypeSupported(type))||null;}
  async function recordRotation(seconds=8){
    if(!ready||recording||!placed)return false;
    const type=videoType(),canvas=renderer.domElement;
    if(!type||!canvas.captureStream){$('atlasRefPlacedStatus').textContent='This browser cannot record the 3D view.';return false;}
    // The video is drawn on a second canvas: a white ground, the 3D picture, each animal's name and group above it wherever the
    // rotation has carried it, and one line saying what the picture is. The 3D canvas alone would give no names and a black ground.
    const film=document.createElement('canvas');film.width=canvas.width;film.height=canvas.height;const pen=film.getContext('2d'),unit=film.height/100;
    const tagged=[placedAnimal,placedCompare].filter(Boolean).map(name=>({name,text:name+(placed.value.animals[name].group?' ('+placed.value.animals[name].group+')':''),group:placedGroups.get(name)}));
    const translate=text=>window.CerebellumI18n?.t?.(text)||text,caption=translate('Estimated positions in the atlas frame, not a measured reconstruction.');
    const compose=()=>{pen.fillStyle='#ffffff';pen.fillRect(0,0,film.width,film.height);pen.drawImage(canvas,0,0);pen.textAlign='center';pen.textBaseline='top';pen.fillStyle='#1d1d1f';pen.font='600 '+(3.4*unit).toFixed(1)+'px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
      for(const tag of tagged){const at=pivot.localToWorld(new window.THREE.Vector3(tag.group.position.x,0,0)).project(camera);pen.fillText(tag.text,Math.min(film.width-12*unit,Math.max(12*unit,(at.x+1)/2*film.width)),4*unit);}
      pen.fillStyle='#5b6470';pen.font=(2.2*unit).toFixed(1)+'px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';pen.textBaseline='bottom';pen.fillText(caption,film.width/2,film.height-3*unit);};
    recording=true;$('atlasRefRecord').disabled=true;const before=pivot.rotation.y,chunks=[],stream=film.captureStream(30),recorder=new MediaRecorder(stream,{mimeType:type,videoBitsPerSecond:8000000});
    $('atlasRefPlacedStatus').textContent='Recording one full rotation…';
    try{
      const finished=new Promise((resolve,reject)=>{recorder.onstop=resolve;recorder.onerror=e=>reject(e.error||Error('recording failed'));});
      recorder.ondataavailable=e=>{if(e.data&&e.data.size)chunks.push(e.data);};recorder.start();
      const started=performance.now(),duration=Math.max(1,Math.min(30,seconds))*1000;
      await new Promise(resolve=>{const turn=now=>{const part=Math.min(1,(now-started)/duration);pivot.rotation.y=before+part*Math.PI*2;pivot.updateMatrixWorld(true);renderer.render(scene,camera);compose();updateAxes();if(part<1)requestAnimationFrame(turn);else resolve();};requestAnimationFrame(turn);});
      recorder.stop();await finished;
      const extension=type.startsWith('video/mp4')?'mp4':'webm',blob=new Blob(chunks,{type:type.split(';')[0]}),name='cerebellum-rotation-'+[placedAnimal,placedCompare].filter(Boolean).join('-vs-')+'.'+extension;
      if(!blob.size)throw Error('empty recording');
      const link=document.createElement('a'),href=URL.createObjectURL(blob);link.href=href;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(href),2000);
      lastVideo={name,bytes:blob.size,type:blob.type,seconds:duration/1000,width:film.width,height:film.height,labels:tagged.map(tag=>tag.text),caption};showPlaced(placedAnimal);
      $('atlasRefPlacedStatus').textContent='Video download requested ('+name+'). It shows estimated positions in the atlas frame, not a measured reconstruction.';return true;
    }catch(reason){$('atlasRefPlacedStatus').textContent='This browser cannot record the 3D view.';return false;}
    finally{stream.getTracks().forEach(track=>track.stop());pivot.rotation.y=before;recording=false;$('atlasRefRecord').disabled=!placed;render();}
  }
  function loadPlaced(candidate){
    if(!ready)return false;
    let checked;try{checked=validatePlaced(candidate);}catch(reason){$('atlasRefPlacedStatus').textContent='This file is not a placed-section stack for this atlas. Nothing was changed.';return false;}
    clearPlaced(true);placed=checked;const T=window.THREE;
    for(const name of checked.names){
      const group=new T.Group();group.userData.animal=name;group.visible=false;geometryRoot.add(group);placedGroups.set(name,group);
      for(const section of checked.value.animals[name].sections)for(const [roi,lines] of Object.entries(section.rois))for(const line of lines){
        const geometry=new T.BufferGeometry().setFromPoints(line.map(([x,y])=>new T.Vector3(x/1000,y/1000,section.z/1000)));
        const object=new T.Line(geometry,new T.LineBasicMaterial({color:PLACED_COLOURS[roi],transparent:true,opacity:roi==='Cb'?.8:.6,depthWrite:false}));object.userData.roi=roi;object.userData.sample=section.sample;object.renderOrder=2;group.add(object);
      }
    }
    $('atlasRefPlacedAnimal').replaceChildren(...checked.names.map(name=>{const o=document.createElement('option');o.value=name;o.textContent=name;return o;}));
    const none=document.createElement('option');none.value='';none.textContent='No comparison';
    $('atlasRefPlacedCompare').replaceChildren(none,...checked.names.map(name=>{const o=document.createElement('option');o.value=name;o.textContent=name;return o;}));
    $('atlasRefPlacedAnimal').disabled=false;$('atlasRefPlacedCompare').disabled=checked.names.length<2;$('atlasRefPlacedClear').disabled=false;$('atlasRefRecord').disabled=false;showPlaced(checked.names[0],'');return true;
  }
  async function placedFile(file){
    if(!file||!ready)return;
    if(file.size>24*1024*1024){$('atlasRefPlacedStatus').textContent='This file is not a placed-section stack for this atlas. Nothing was changed.';$('atlasRefPlacedFile').value='';return;}
    let value=null;try{value=JSON.parse(await file.text());}catch(reason){value=null;}
    if(!loadPlaced(value)&&!placed)$('atlasRefPlacedFile').value='';
  }
  async function init(){
    if(ready||loading)return;loading=true;error=null;$('atlasRefRetry').hidden=true;$('atlasRefLoadMessage').textContent='Loading atlas outlines…';
    try{
      data=validate(await readJSON(url));beginView();
      $('atlasRefPlate').replaceChildren(...data.plates.map((p,index)=>{const o=document.createElement('option');o.value=String(index);o.textContent='Plane '+(index+1)+' · Lateral '+fmt(p.lateral_um)+' mm';return o;}));
      $('atlasRefPosition').max=String(data.plates.length-1);$('atlasRefCount').textContent=data.plates.length+' atlas planes · physical coordinates';
      {const credit=$('atlasRefSource');credit.setAttribute('translate','no');credit.dataset.i18nSkip='true';credit.textContent=[data.source?.name,data.source?.citation,data.source?.license,data.source?.obtained_from].filter(Boolean).join(' · ');}
      $('atlasRefCoverage').textContent='Lateral '+fmt(data.plates[0].lateral_um)+' to '+fmt(data.plates[data.plates.length-1].lateral_um)+' mm. One hemisphere of a symmetric annotation is shown.';
      $('atlasRefHash').textContent=data.source?.sha256?'Annotation volume SHA-256: '+data.source.sha256:'';
      ready=true;setControls(true);$('atlasRefPlacedFile').disabled=false;$('atlasRefPlaceholder').hidden=true;selected=Math.min(10,data.plates.length-1);selectPlane(selected);reset();
      if(data.surface?.url)loadSurface(data.surface.url);
    }catch(reason){error=String(reason.message||reason);$('atlasRefLoadMessage').textContent=error;$('atlasRefPlaceholder').hidden=false;$('atlasRefRetry').hidden=false;setControls(false);}
    finally{loading=false;}
  }
  $('atlasRefRetry').onclick=init;$('atlasRefPlate').addEventListener('change',e=>selectPlane(Number(e.target.value)));$('atlasRefPosition').addEventListener('input',e=>selectPlane(Number(e.target.value)));
  ['atlasRefStack','atlasRefInner','atlasRefSurface'].forEach(id=>$(id).addEventListener('change',updateVisibility));
  $('atlasRefPlacedFile').addEventListener('change',e=>placedFile(e.target.files[0]));$('atlasRefPlacedAnimal').addEventListener('change',e=>showPlaced(e.target.value));$('atlasRefPlacedCompare').addEventListener('change',e=>showPlaced(placedAnimal,e.target.value));$('atlasRefRecord').addEventListener('click',()=>recordRotation());$('atlasRefPlacedClear').addEventListener('click',clearPlaced);
  $('atlasRefPerspective').addEventListener('click',()=>preset('perspective'));$('atlasRefSagittal').addEventListener('click',()=>preset('section'));$('atlasRefReset').addEventListener('click',reset);$('atlasRefZoomIn').addEventListener('click',()=>zoom(.85));$('atlasRefZoomOut').addEventListener('click',()=>zoom(1/.85));
  window.CerebellumAtlasExplorer=Object.freeze({open:init,loadSurface,recordRotation,snapshot:()=>({ready,loading,error,placed:placed?{animals:placed.names,shown:placedAnimal,compare:placedCompare,sections:placed.sections,vertices:placed.vertices,lines_shown:placedGroups.get(placedAnimal)?.children.length||0,offsets:placedCompare?[placedGroups.get(placedAnimal).position.x,placedGroups.get(placedCompare).position.x]:[0],video_type:videoType(),recording,last_video:lastVideo}:null,plane_count:data?.plates.length||0,selected_index:selected,selected_plane:data?{id:data.plates[selected].id,figure:data.plates[selected].figure,lateral_um:data.plates[selected].lateral_um,path_count:data.plates[selected].paths.length}:null,show_stack:$('atlasRefStack').checked,show_inner:$('atlasRefInner').checked,surface_available:surfaceAvailable,surface_visible:!!surfaceMesh?.visible,axis_order:['AP','DV','Lateral'],display_unit:'mm',input_unit:'um',uniform_axis_scale:true,source_sha256:data?.source?.sha256||null,path_count:data?.plates.reduce((n,p)=>n+p.paths.length,0)||0,view:pivot?{rotation:pivot.rotation.toArray(),pan:pivot.position.toArray(),camera_z:camera.position.z}:null})});
  // Reference downloads begin only after an explicit request through CerebellumBoot.
})();
