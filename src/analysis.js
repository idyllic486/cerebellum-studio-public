/* Local single-section review. No source image or prediction is uploaded. */
(function(){'use strict';
const $=id=>document.getElementById(id),C=window.AnalysisCore,NS='http://www.w3.org/2000/svg';
if(!$('analysisPanel')||!C)return;
let approvalChanged=false,state=null,source=null,sourceBytes=null,predictionBytes=null,predictionName='',previewURL=null,generation=0,busy=false,selected='',pathIndex=0,vertexIndex=0,view=null,drag=null,imageController=null;
let trainedModelFile=null,trainedModelInfo=null,modelWorker=null,resultModelFile=null,evidenceFiles=[],drawing=null,failedRaster=null,measurementCSVFile=null,predictionSelectionFile=null,reviewDraftFile=null;
let sourceBlob=null,previewBlob=null,pendingReplacement=null,sessionId=null,sessionRevision=0,changeVersion=0,savedVersion=0,recoveryError=null,saveTimer=null,savePromise=null;
const recoveryStore=window.AnalysisRecoveryStore,recoveryRevisions=new Map();
let modelSelectionVersion=0,rasterRenderVersion=0;
const modelDocument=value=>window.AutoROIModelBundle.validate(value);
const modelInfoFor=model=>({id:model.id,version:model.version,animals:model.training_animals,isBundle:!!model.isBundle,hasLobules:!!model.models?.lobules,family:model.family||null});
function automationState(){return {hasSource:!!source,hasModel:!!trainedModelFile,busy,hasDraft:!!state?.rois?.length,hasRaster:!!failedRaster,approved:!!state?.approval&&!dirty.size&&!approvalChanged,modelScope:trainedModelInfo?.isBundle?(trainedModelInfo.hasLobules?'CB, ML, GL, WM · annotated cortical regions':'CB, ML, GL, WM'):trainedModelInfo?'single tissue task':null};}
const dirty=new Set(),colors={CB:'#111111',ML:'#0f766e',GL:'#c2410c',WM:'#6d28d9',PL:'#be123c'};
const metaFields={animal_id:'analysisAnimal',section_id:'analysisSection',um_per_pixel_x:'analysisScaleX',um_per_pixel_y:'analysisScaleY',z_um:'analysisZ',thickness_um:'analysisThickness',sampling_interval_um:'analysisInterval'};
const clone=value=>JSON.parse(JSON.stringify(value));
const raw=(text)=>{const n=document.createElement('span');n.setAttribute('translate','no');n.textContent=text;return n;},rawOption=(text,value)=>{const n=new Option(text,value);n.setAttribute('translate','no');return n;};
let dependency;
async function libraries(){if(!dependency)dependency=(async()=>{for(const [global,name] of [['pako','pako.min.js'],['UTIF','UTIF.js'],['JSZip','jszip.min.js']]){if(window[global])continue;await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='./vendor/'+name;script.onload=resolve;script.onerror=()=>reject(Error('Could not load local image tools.'));document.head.append(script);});}})();try{await dependency;}catch(e){dependency=null;throw e;}}
function status(message,kind='ready'){$('analysisStatus').textContent=message;$('analysisStatus').dataset.state=kind;}
const cancelImage=document.createElement('button');cancelImage.id='analysisCancelImage';cancelImage.type='button';cancelImage.textContent='Cancel image loading';cancelImage.hidden=true;cancelImage.addEventListener('click',()=>imageController?.abort());$('analysisStatus').after(cancelImage);
function roi(){return state?.rois.find(r=>r.id===selected)||null;}
let structureLabel=null,pieceIndex=-1,hoverFrame=0;
function scopedROIs(){const list=state?.rois||[],mode=$('analysisROIScope').value,current=roi(),label=structureLabel||current?.label;return mode==='selected'?list.filter(r=>r.id===selected):mode==='label'?list.filter(r=>r.label===label):list;}
const STRUCTURE_ORDER=['CB','ML','GL','WM','PL'];
const ringArea=path=>{let sum=0;for(let i=0;i<path.length;i++){const a=path[i],b=path[(i+1)%path.length];sum+=a[0]*b[1]-b[0]*a[1];}return Math.abs(sum)/2;};
const roiArea=r=>{const rings=r.paths.map(ringArea),largest=Math.max(...rings);return 2*largest-rings.reduce((total,value)=>total+value,0);};
// Very small separate model pieces are shown for review; nothing is removed without the researcher.
function smallPieces(){if(!state?.model)return[];const list=state.rois.filter(r=>geometry(r)==='area'&&r.included!==false&&STRUCTURE_ORDER.includes(r.label)),largest={};for(const r of list)largest[r.label]=Math.max(largest[r.label]||0,roiArea(r));return list.filter(r=>roiArea(r)<largest[r.label]*.01);}
function renderStructures(){
 const host=$('analysisStructures'),chips=$('analysisLabelChips'),rois=state?.rois||[];host.hidden=!rois.length;if(!rois.length){chips.replaceChildren();return;}
 const labels=[...new Set(rois.map(r=>r.label))].sort((a,b)=>(STRUCTURE_ORDER.indexOf(a)+1||99)-(STRUCTURE_ORDER.indexOf(b)+1||99)),mode=$('analysisROIScope').value,active=mode==='label'?(structureLabel||roi()?.label):mode==='all'?'':null,disabled=!!drawing||!!drag||busy;
 const chip=(value,text,color,count)=>{const b=document.createElement('button');b.type='button';b.className='analysis-label-chip';b.dataset.label=value;b.setAttribute('aria-pressed',String(active===value));b.disabled=disabled;if(color){const dot=document.createElement('span');dot.className='analysis-label-dot';dot.style.background=color;b.append(dot);}b.append(text,' ');const n=document.createElement('span');n.className='analysis-label-count';n.textContent=String(count);b.append(n);return b;};
 chips.replaceChildren(chip('',ui('All'),null,rois.length),...labels.map(label=>chip(label,raw(label),colors[label]||'#111',rois.filter(r=>r.label===label).length)));
 const pieces=smallPieces(),button=$('analysisSmallPieces');button.hidden=!pieces.length;button.disabled=disabled;button.replaceChildren(ui('Check small separate pieces'),' ',raw(String(pieces.length)));
}
function showStructure(label){if(busy||drawing||drag)return;structureLabel=label||null;$('analysisROIScope').value=label?'label':'all';if(label&&roi()?.label!==label){const first=state.rois.find(r=>r.label===label);if(first){selected=first.id;pathIndex=vertexIndex=0;}}render();}
function nextPiece(){const pieces=smallPieces();if(!pieces.length||busy||drawing||drag)return;pieceIndex=(pieceIndex+1)%pieces.length;const r=pieces[pieceIndex];structureLabel=null;$('analysisROIScope').value='all';selected=r.id;pathIndex=vertexIndex=0;const all=r.paths.flat(),xs=all.map(p=>p[0]),ys=all.map(p=>p[1]),x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys),size=Math.max(x1-x0,y1-y0,200)*3;view={...view,x:(x0+x1)/2-size/2,y:(y0+y1)/2-size/2,w:size,h:size};render();status(ui('Small separate piece')+' '+(pieceIndex+1)+' / '+pieces.length+': '+ui('keep it if it is tissue, or choose Exclude this ROI.'),'draft');}
function insideArea(paths,x,y){let inside=false;for(const path of paths)for(let i=0,j=path.length-1;i<path.length;j=i++){const a=path[i],b=path[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside;}
function nearLine(paths,x,y,tolerance){for(const path of paths)for(let i=1;i<path.length;i++){const a=path[i-1],b=path[i],dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/((dx*dx+dy*dy)||1)));if(Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy)<=tolerance)return true;}return false;}
function roiAt(x,y,tolerance){const list=scopedROIs();for(const r of list)if(geometry(r)!=='area'&&nearLine(r.paths,x,y,tolerance))return r;let best=null,bestArea=Infinity;for(const r of list){if(geometry(r)!=='area'||!insideArea(r.paths,x,y))continue;const area=roiArea(r);if(area<bestArea){best=r;bestArea=area;}}return best;}
function hoverLabel(event){const tip=$('analysisHoverLabel');if(!tip||!state||drag||drawing||viewMode()==='original'){if(tip)tip.hidden=true;return;}const point=pointAt(event),matrix=$('analysisCanvas').getScreenCTM(),scale=matrix?Math.hypot(matrix.a,matrix.b):1,r=roiAt(point[0],point[1],6/Math.max(scale,1e-6));if(!r){tip.hidden=true;return;}const name=roiName(r);tip.replaceChildren(raw(r.label),...(name&&name!==r.label?[' · ',raw(name)]:[]),...(r.included===false?[' · ',ui('Excluded')]:[]));tip.hidden=false;const box=$('analysisCanvas').parentElement.getBoundingClientRect(),x=event.clientX-box.left,y=event.clientY-box.top;tip.style.left=Math.min(box.width-tip.offsetWidth-8,x+14)+'px';tip.style.top=Math.max(8,y-tip.offsetHeight-10)+'px';}
function selectedPoint(){return roi()?.paths[pathIndex]?.[vertexIndex]||null;}
const geometry=r=>r?.kind||'area';
const labelGeometry=label=>['PL','FISSURE'].includes(label)?'polyline':label==='LANDMARK'?'point':'area';
const drawingGeometry=(value,current=state)=>value?.kind||(value?.mode==='add'?labelGeometry(value.label):geometry(current?.rois.find(r=>r.id===value?.id)));
const geometryName=r=>({area:'Area',polyline:'Open line',point:'Points'})[geometry(r)];
const ui=text=>window.CerebellumI18n?.t?.(text)||text;
const viewModes=['original','overlay','roi','compare'];
// Side-by-side view: the right pane repeats the same window with the ROIs; its gap is 2% of the window.
function compareShift(){return viewMode()==='compare'&&view?view.w*1.02:0;}
function viewMode(){return viewModes.includes($('analysisViewMode').value)?$('analysisViewMode').value:'overlay';}
function setViewMode(mode){$('analysisViewMode').value=viewModes.includes(mode)?mode:'overlay';$('analysisOverlay').checked=viewMode()!=='original';}
const roiName=r=>r.name||state?.original_prediction.names?.find(n=>n.id===r.id)?.name||r.id;
function syncPicker(id,files=[]){try{const transfer=new DataTransfer();for(const file of files)if(file)transfer.items.add(file);$(id).files=transfer.files;return true;}catch{$(id).value='';return false;}}
function syncAttachmentPickers(){
 syncPicker('analysisImage',sourceBlob&&source?[new File([sourceBlob],source.name,{type:'image/tiff'})]:[]);
 syncPicker('analysisROIImport',evidenceFiles.map(f=>new File([f.bytes],f.name)));
 syncPicker('analysisPrediction',[predictionSelectionFile]);syncPicker('analysisDraft',[reviewDraftFile]);if(!syncPicker('analysisModel',[trainedModelFile]))resetModelSelection();syncPicker('analysisResultModel',[resultModelFile]);syncCSVPicker();
}
function renderAttachments(){
 $('analysisROIFiles').replaceChildren(...evidenceFiles.map(file=>{const row=document.createElement('li'),button=document.createElement('button');button.type='button';button.textContent='Remove file';button.setAttribute('aria-label','Remove ROI source file: '+file.name);button.dataset.sourceFile=file.name;button.disabled=busy||!!drawing||!!dirty.size;button.addEventListener('click',()=>removeROIFile(file));row.append(raw(file.name),button);return row;}));
 $('analysisPredictionSelection').replaceChildren(...(predictionSelectionFile?['Selected prediction: ',raw(predictionSelectionFile.name)]:[state?.model?'No prediction file selected. The current review retains its original prediction evidence.':'No prediction file selected.']));
 $('analysisDraftSelection').replaceChildren(...(reviewDraftFile?['Selected draft: ',raw(reviewDraftFile.name)]:['No review draft file selected.']));
 $('analysisResultModelInfo').replaceChildren(...(resultModelFile?['Verified original model: ',raw(resultModelFile.name),' · SHA-256 matches this result.']:['Attach the exact original weights to retain them with this result. The SHA-256 must match the prediction.']));
}
function markDirty(group){dirty.add(group);$('analysisChecked').checked=false;controls();status('Unapplied fields: apply or discard your changes before approval or export.','draft');}
// Selection changes must not overwrite fields that have not been applied.
function canChangeSelection(){
if(!state||busy||drawing||dirty.has('vertex')||dirty.has('exclusion')||dirty.has('region')){
$('analysisROI').value=selected;$('analysisPath').value=String(pathIndex);$('analysisVertex').value=vertexIndex+1;
if(dirty.has('vertex')||dirty.has('exclusion')||dirty.has('region'))status('Apply or discard the pending boundary or exclusion changes before changing the selection.','draft');
return false;
}
return true;
}
function controls(){$('analysisAcceptReplacement').disabled=busy||!pendingReplacement;$('analysisKeepCurrent').disabled=busy;$('analysisRestoreSession').disabled=busy||!$('analysisRecoveryList').value;$('analysisDeleteSession').disabled=busy||!$('analysisRecoveryList').value;const ready=!!state&&!busy,clean=ready&&!dirty.size&&!drawing;
$('analysisCSVFile').disabled=!state||busy||!!drawing;$('analysisClearCSV').disabled=!state?.measurement_reference||busy||!!drawing;
$('analysisROIImport').disabled=!source||busy;$('analysisManual').disabled=!source||busy;$('analysisClearImage').disabled=!source||busy;$('analysisClearReview').disabled=!state||busy;$('analysisClearPrediction').disabled=!predictionSelectionFile||busy;$('analysisClearDraft').disabled=!reviewDraftFile||busy;$('analysisResultModel').disabled=!state?.model||busy;$('analysisClearResultModel').disabled=!resultModelFile||busy;
$('analysisUndo').disabled=!clean||!state?.editor?.past?.length;$('analysisRedo').disabled=!clean||!state?.editor?.future?.length;
for(const id of ['analysisDrawROI','analysisNewLabel'])$(id).disabled=!clean||!!drawing;
for(const id of ['analysisInsertVertex','analysisDeleteVertex','analysisApplyLabel','analysisRedraw','analysisAddRing','analysisDeleteRing','analysisDeleteROI'])$(id).disabled=!clean||!roi()||!!drawing;
$('analysisInsertVertex').disabled=!clean||!roi()||geometry(roi())==='point'||geometry(roi())==='polyline'&&vertexIndex===roi().paths[pathIndex].length-1;
$('analysisRegion').disabled=!ready||!roi()||!!drawing;$('analysisApplyRegion').disabled=!ready||!roi()||!!drawing;$('analysisAddRing').disabled=!clean||!roi()||geometry(roi())!=='area';$('analysisDeleteRing').disabled=!clean||!roi()||geometry(roi())!=='area'||roi().paths.length<2;for(const button of $('analysisROIFiles').querySelectorAll('button'))button.disabled=!clean;
$('analysisAcknowledgeQC').disabled=!clean;$('analysisCoordinatesChecked').disabled=!ready;
$('analysisDownloadFailedRaster').disabled=busy||!failedRaster;$('analysisManualFallback').disabled=busy||!failedRaster;$('analysisShowFailedRaster').disabled=busy||!failedRaster;if($('analysisRasterHead'))$('analysisRasterHead').disabled=busy||!failedRaster||rasterRecords(failedRaster).length<2;
$('analysisIncludePL').disabled=busy;$('analysisCreateCandidates').disabled=busy||!failedRaster||!!dirty.size||!!drawing;$('analysisCandidateBlock').disabled=busy;
$('analysisModel').disabled=busy;$('analysisClearModel').disabled=busy||!trainedModelFile;$('analysisAutoGenerate').disabled=busy;$('analysisGenerate').disabled=!source||!trainedModelFile||busy||dirty.size>0;
$('analysisPrediction').disabled=!source||busy;$('analysisImage').disabled=busy;$('analysisDraft').disabled=!source||busy;
for(const id of ['analysisROI','analysisPath','analysisVertex','analysisX','analysisY','analysisExcluded','analysisExclusionReason','analysisApplyVertex','analysisApplyExclusion','analysisApplyMetadata','analysisSaveDraft'])$(id).disabled=!ready||!!drawing;
for(const id of [...Object.values(metaFields),'analysisSingle','analysisReviewer','analysisProtocol','analysisChecked'])$(id).disabled=!ready;
for(const id of ['analysisFit','analysisZoomIn','analysisZoomOut','analysisOverlay','analysisViewMode'])$(id).disabled=!source||busy||!!drag;
$('analysisViewMode').disabled=!source||busy||!!drag||!!drawing;
$('analysisApprove').disabled=!clean||!!drawing;$('analysisExport').disabled=!clean||!state?.approval||approvalChanged;$('analysisResetFields').disabled=!ready||(!dirty.size&&!approvalChanged);
$('analysisContinueStudy').disabled=!clean||!state?.approval||approvalChanged;
$('analysisROIScope').disabled=!ready||!!drawing||!!drag;renderStructures();
for(const id of ['analysisExportMeasurement','analysisExportResult','analysisExportROI'])$(id).disabled=!clean||!state?.approval||approvalChanged||!scopedROIs().length;
$('analysisExportROI').disabled=$('analysisExportROI').disabled||!scopedROIs().some(r=>r.included);
$('analysisExportDraftROI').disabled=!clean||!state||!scopedROIs().some(r=>r.included);
$('analysisExportScopeSummary').replaceChildren(ui($('analysisROIScope').selectedOptions[0].textContent),' · ',raw(String(scopedROIs().length)),...($('analysisROIScope').value==='selected'&&roi()?[' · ',raw(roiName(roi()))]:$('analysisROIScope').value==='label'&&roi()?[' · ',raw(roi().label)]:[]));
if(!roi())for(const id of ['analysisROI','analysisPath','analysisVertex','analysisX','analysisY','analysisExcluded','analysisExclusionReason','analysisApplyVertex','analysisApplyExclusion'])$(id).disabled=true;
$('analysisBadge').textContent=busy?'Working…':!source?'No image':!state?'Image ready':dirty.size?'Unapplied changes':approvalChanged?'Review details changed':state.approval?'Approved':'Draft · review required';
$('analysisBadge').dataset.state=state?.approval&&!dirty.size&&!approvalChanged?'approved':'draft';
window.AnalysisWorkflow?.update({sourceKey:source?.sha256||null,hasSource:!!source,hasReview:!!state,roiCount:state?.rois.length||0,approved:!!state?.approval&&!approvalChanged,pending:!!dirty.size||!!drawing,busy,calibrated:Number.isFinite(state?.metadata.um_per_pixel_x)&&state.metadata.um_per_pixel_x>0&&Number.isFinite(state?.metadata.um_per_pixel_y)&&state.metadata.um_per_pixel_y>0,hasZ:Number.isFinite(state?.metadata.z_um),modelReady:!!trainedModelFile,hasCSV:!!state?.measurement_reference});
window.dispatchEvent(new CustomEvent('cerebellum-analysis-state'));
}
function setBusy(value){busy=value;controls();}
function syncMetadata(){if(!state)return;for(const[key,id]of Object.entries(metaFields))$(id).value=state.metadata[key]??'';$('analysisSingle').checked=state.metadata.single_section_confirmed===true;}
function editor(){const r=roi();if(!r){$('analysisPath').replaceChildren();$('analysisX').value='';$('analysisY').value='';$('analysisRegion').value='';$('analysisMeasurement').textContent='No ROI yet. Draw a boundary to begin.';return;}
if(pathIndex>=r.paths.length)pathIndex=0;if(vertexIndex>=r.paths[pathIndex].length)vertexIndex=0;
$('analysisPath').replaceChildren(...r.paths.map((p,i)=>new Option((geometry(r)==='area'?'Contour ':geometry(r)==='polyline'?'Path ':'Point set ')+(i+1)+' · '+p.length+' vertices',String(i))));$('analysisPath').value=String(pathIndex);
$('analysisVertex').max=r.paths[pathIndex].length;$('analysisVertex').value=vertexIndex+1;
const p=selectedPoint();$('analysisX').value=p[0];$('analysisY').value=p[1];$('analysisExcluded').checked=!r.included;$('analysisExclusionReason').value=r.exclusion_reason||'';
if(!dirty.has('region'))$('analysisRegion').value=r.region||'';
const m=C.measure(r,state.metadata),detail=geometry(r)==='area'?format(m.area_px2)+' px² · '+(m.area_um2===null?'Physical area unknown':format(m.area_um2)+' µm²'):geometry(r)==='polyline'?format(m.length_px)+' px · '+(m.length_um===null?'Physical length unknown':format(m.length_um)+' µm'):m.point_count+' points';
$('analysisMeasurement').replaceChildren(raw(roiName(r)),' · ',geometryName(r),' · ',raw(r.label),r.region?raw(' · '+r.region):'','\n'+detail+(r.included?'':' · excluded'));
}
function format(n){return Number(n).toLocaleString('en-US',{maximumSignificantDigits:8});}
function evidence(){if(!state){$('analysisEvidence').replaceChildren(...(source?[raw(source.name),'\n'+source.width+' × '+source.height+' pixels\nSHA-256 '+source.sha256]:[]));return;}
$('analysisEvidence').replaceChildren('Source: ',raw(source.name),'\nDimensions: '+source.width+' × '+source.height+' original pixels\nSource SHA-256: '+source.sha256+'\nModel: ',raw(state.model?.id||state.original_prediction.origin||'Manual review'),' · ',raw(state.model?.version||'No trained model'),'\nWeights SHA-256: '+(state.model?.weights_sha256||'Not applicable')+'\nROIs: '+state.rois.length+' · included '+state.rois.filter(r=>r.included).length+' · excluded '+state.rois.filter(r=>!r.included).length+'\nReview events: '+(state.history.length+(state.history_checkpoints||[]).reduce((n,c)=>n+c.events.length,0))+'\nModel identity is declared by the prediction producer. Anatomical accuracy has not been established here.');}
function render(){if(state){if(!roi())selected=state.rois[0]?.id||'';$('analysisROI').replaceChildren(...state.rois.map(r=>rawOption(roiName(r)+' · '+ui(geometryName(r))+' · '+r.label+(r.region?' · '+r.region:'')+(r.included?'':' · '+ui('excluded')),r.id)));$('analysisROI').value=selected;if(!dirty.has('metadata'))syncMetadata();if(!dirty.has('vertex')&&!dirty.has('exclusion'))editor();}else{selected='';$('analysisROI').replaceChildren();editor();}
evidence();draw();renderQC();renderCSV();renderAttachments();controls();queueRecovery();}
function fit(){if(!source)return;const pad=Math.max(source.width,source.height)*.025;view={x:-pad,y:-pad,w:source.width+2*pad,h:source.height+2*pad};draw();}
function draw(){if(!source||!view)return;const svg=$('analysisCanvas'),mode=viewMode();svg.dataset.viewMode=mode;$('analysisRaster').style.display=mode==='roi'?'none':'';$('analysisFailedRasterPreview').style.display=mode==='overlay'||mode==='roi'&&failedRaster?'':'none';for(const id of ['analysisDrawing','analysisDrawingPoints'])$(id).style.display=mode==='original'?'none':'';const shift=compareShift(),transform=shift?'translate('+shift+' 0)':'';svg.setAttribute('viewBox',[view.x,view.y,view.w+shift,view.h].join(' '));
const twin=$('analysisRasterCompare'),raster=$('analysisRaster');twin.style.display=shift?'':'none';if(shift){for(const name of ['href','width','height'])raster.hasAttribute(name)?twin.setAttribute(name,raster.getAttribute(name)):twin.removeAttribute(name);}
for(const id of ['analysisContours','analysisDrawing','analysisDrawingPoints','analysisVertexMarker'])transform?$(id).setAttribute('transform',transform):$(id).removeAttribute('transform');
if(shift)twin.setAttribute('transform',transform);const group=$('analysisContours');group.replaceChildren();group.style.display=mode==='original'?'none':'';
if(state)for(const r of scopedROIs()){const kind=geometry(r),node=document.createElementNS(NS,kind==='point'?'g':'path'),stroke=r.style?.stroke_color_argb,color=stroke?('#'+(stroke&0xffffff).toString(16).padStart(6,'0')):colors[r.label]||'#111';node.dataset.roi=r.id;node.dataset.geometry=kind;
 if(kind==='point'){const matrix=svg.getScreenCTM(),radius=4/Math.max(matrix?Math.hypot(matrix.a,matrix.b):1,.000001);for(const p of r.paths.flat()){const mark=document.createElementNS(NS,'circle');mark.setAttribute('cx',p[0]);mark.setAttribute('cy',p[1]);mark.setAttribute('r',radius);mark.setAttribute('fill',color);mark.dataset.roi=r.id;node.append(mark);}}
 else{node.setAttribute('d',r.paths.map(p=>'M'+p.map(q=>q.join(',')).join('L')+(kind==='area'?'Z':'')).join(''));node.setAttribute('fill',kind==='area'?color:'none');node.setAttribute('fill-opacity',r.label==='CB'?(r.id===selected?'.08':'0'):r.id===selected?'.3':mode==='roi'?'.2':'.18');node.setAttribute('fill-rule','evenodd');}
 node.setAttribute('stroke',color);node.setAttribute('stroke-width',r.id===selected?'2':'1');node.setAttribute('stroke-linejoin','round');node.setAttribute('vector-effect','non-scaling-stroke');for(const child of node.children)child.setAttribute('vector-effect','non-scaling-stroke');if(!r.included){node.setAttribute('stroke-dasharray','6 4');if(kind==='point')node.setAttribute('opacity','.45');}group.append(node);}
$('analysisDrawing').setAttribute('d',drawing?.points.length&&drawingGeometry(drawing)!=='point'?'M'+drawing.points.map(p=>p.join(',')).join('L'):'');
const drawnPoints=$('analysisDrawingPoints');drawnPoints.replaceChildren();if(drawing&&drawingGeometry(drawing)==='point'){const matrix=svg.getScreenCTM(),radius=4/Math.max(matrix?Math.hypot(matrix.a,matrix.b):1,.000001);for(const p of drawing.points){const mark=document.createElementNS(NS,'circle');mark.setAttribute('cx',p[0]);mark.setAttribute('cy',p[1]);mark.setAttribute('r',radius);mark.setAttribute('fill','#111');drawnPoints.append(mark);}}
marker(drag?.mode==='vertex'?drag.point:selectedPoint());}
function marker(point){const m=$('analysisVertexMarker');if(!point||!$('analysisOverlay').checked){m.setAttribute('visibility','hidden');return;}const matrix=$('analysisCanvas').getScreenCTM(),scale=matrix?Math.hypot(matrix.a,matrix.b):1;m.setAttribute('cx',point[0]);m.setAttribute('cy',point[1]);m.setAttribute('r',5/Math.max(scale,.000001));m.setAttribute('visibility','visible');}
function zoom(factor){if(!view)return;const cx=view.x+view.w/2,cy=view.y+view.h/2;view.w*=factor;view.h*=factor;view.x=cx-view.w/2;view.y=cy-view.h/2;draw();}
function bytesToBase64(bytes){let text='';for(let i=0;i<bytes.length;i+=16384)text+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(text);}
function base64ToBytes(text){if(typeof text!=='string'||text.length>48*1024*1024)throw Error('Invalid draft prediction size.');return Uint8Array.from(atob(text),c=>c.charCodeAt(0));}
const fieldIds=[...Object.values(metaFields),'analysisSingle','analysisX','analysisY','analysisExcluded','analysisExclusionReason','analysisReviewer','analysisProtocol','analysisQCNote','analysisDeleteReason','analysisRegion'];
function recoveryStatus(text,kind){$('analysisRecoveryStatus').textContent=text;$('analysisRecoveryStatus').dataset.state=kind;}
function queueRecovery(){
 if(!source||!sourceBlob)return;
 changeVersion++;recoveryStatus('Saving a recovery copy on this browser…','pending');
 clearTimeout(saveTimer);saveTimer=setTimeout(()=>flushRecovery().catch(()=>{}),350);
}
function recoveryRecord(){
 return {id:sessionId,source:clone(source),sourceBlob,previewBlob,predictionBlob:predictionBytes?new Blob([predictionBytes],{type:'application/json'}):null,predictionName,state:state?clone(state):null,
 fields:Object.fromEntries(fieldIds.map(id=>[id,$(id).type==='checkbox'?$(id).checked:$(id).value])),dirty:[...dirty],approvalChanged,
 selection:{selected,pathIndex,vertexIndex},viewMode:viewMode(),modelFile:trainedModelFile,resultModelFile,evidenceFiles:evidenceFiles.map(f=>({name:f.name,sha256:f.sha256,blob:new Blob([f.bytes])})),drawing:drawing?clone(drawing):null,failedRaster,measurementCSVFile,predictionSelectionFile,reviewDraftFile};
}
async function flushRecovery(){
 clearTimeout(saveTimer);
 if(savePromise){await savePromise;return flushRecovery();}
 if(!source||!sourceBlob||savedVersion===changeVersion)return;
 const task=(async()=>{
  while(source&&savedVersion!==changeVersion){
   const version=changeVersion,id=sessionId,record=recoveryRecord();
   try{const saved=await recoveryStore.save(record,sessionRevision);if(id!==sessionId)return;sessionRevision=saved.revision;savedVersion=version;recoveryError=null;}
   catch(error){recoveryError=error.name||'StorageError';recoveryStatus(error.name==='ConflictError'?'Another tab changed this recovery copy. Download your work before continuing.':'Recovery could not be saved. Keep this tab open, download your work, then free browser storage and retry.','error');throw error;}
  }
  recoveryStatus('Recovery copy saved on this browser. Keep original files and download a backup.','saved');await refreshRecoveryList();
 })();savePromise=task;
 try{await task;}finally{if(savePromise===task)savePromise=null;}
}
async function refreshRecoveryList(){
 try{const records=await recoveryStore.list(),old=$('analysisRecoveryList').value;recoveryRevisions.clear();for(const record of records)recoveryRevisions.set(record.id,record.revision);
 $('analysisRecoveryList').replaceChildren(new Option('Choose a recovery copy',''),...records.map(r=>rawOption(r.source.name+' · '+r.updatedAt,r.id)));
 if(records.some(r=>r.id===old))$('analysisRecoveryList').value=old;
 if(!source)recoveryStatus(records.length?'A previous image analysis is available to restore.':'No recovery copies on this browser.','ready');controls();
 }catch(error){recoveryError=error.name||'StorageError';recoveryStatus('Browser recovery storage is unavailable. Keep this tab open and download your work.','error');}
}
function beginSession(){sessionId=crypto.randomUUID();sessionRevision=0;changeVersion=savedVersion=0;recoveryError=null;}
function stageReplacement(candidate){
 pendingReplacement=candidate;$('analysisReplacement').hidden=false;
 $('analysisReplacementName').replaceChildren(raw(candidate.name));
 $('analysisReplacement').scrollIntoView({block:'nearest'});controls();
 // Loading progress must not remain as the final message once the candidate is waiting for a decision.
 status('A new result is ready. Accept it or keep the current review.','draft');
}
function discardReplacement(){pendingReplacement=null;$('analysisReplacement').hidden=true;syncAttachmentPickers();controls();}
async function preserveCurrent(){if(source){queueRecovery();await flushRecovery();}}
function installReview(next,bytes,name,originalFiles=[],modelFile=null,csvFile=null,selections={}){predictionSelectionFile=selections.predictionSelectionFile||null;reviewDraftFile=selections.reviewDraftFile||null;measurementCSVFile=csvFile;evidenceFiles=originalFiles;resultModelFile=modelFile;drawing=null;$('analysisCoordinatesChecked').checked=false;state=next;if(failedRaster&&state.original_prediction.reference?.label_sha256!==failedRaster.metadata.label_sha256){failedRaster=null;renderFailedRaster();}approvalChanged=false;predictionBytes=bytes;predictionName=name;dirty.clear();selected=state.rois[0]?.id||'';pathIndex=vertexIndex=0;$('analysisChecked').checked=false;syncAttachmentPickers();render();}
function installImage(candidate){predictionSelectionFile=null;reviewDraftFile=null;measurementCSVFile=null;$('analysisCSVFile').value='';failedRaster=null;renderFailedRaster();
 if(previewURL)URL.revokeObjectURL(previewURL);previewBlob=candidate.previewBlob;previewURL=URL.createObjectURL(previewBlob);source=candidate.source;sourceBytes=candidate.bytes;sourceBlob=candidate.sourceBlob;
 state=null;predictionBytes=null;predictionName='';evidenceFiles=[];resultModelFile=null;drawing=null;approvalChanged=false;dirty.clear();selected='';pathIndex=vertexIndex=0;
 for(const id of fieldIds){if($(id).type==='checkbox')$(id).checked=false;else $(id).value='';}
 $('analysisPrediction').value='';$('analysisROIImport').value='';$('analysisDraft').value='';$('analysisResultModel').value='';$('analysisCoordinatesChecked').checked=false;$('analysisChecked').checked=false;$('analysisWorkspace').classList.remove('hidden');$('analysisRaster').setAttribute('href',previewURL);$('analysisRaster').setAttribute('width',source.width);$('analysisRaster').setAttribute('height',source.height);$('analysisROI').replaceChildren();$('analysisMeasurement').textContent='';
 // The picker must describe the actual source after a cancelled replacement or restore.
 try{const transfer=new DataTransfer();transfer.items.add(new File([sourceBlob],source.name,{type:'image/tiff'}));$('analysisImage').files=transfer.files;}catch{ $('analysisImage').value=''; }
 setViewMode('overlay');fit();
}
function installCandidate(candidate){
 beginSession();
 if(candidate.kind==='image'||candidate.kind==='restore')installImage(candidate);
 if(candidate.kind==='review')installReview(candidate.state,candidate.bytes,candidate.name,candidate.evidenceFiles||[],candidate.resultModelFile||null,candidate.measurementCSVFile||null,candidate);
 if(candidate.kind==='restore'){
  setViewMode(candidate.viewMode);
  state=candidate.state;predictionSelectionFile=candidate.predictionSelectionFile||null;reviewDraftFile=candidate.reviewDraftFile||null;predictionBytes=candidate.predictionBytes;predictionName=candidate.predictionName;evidenceFiles=candidate.evidenceFiles||[];resultModelFile=candidate.resultModelFile||null;drawing=candidate.drawing||null;failedRaster=candidate.failedRaster||null;measurementCSVFile=candidate.measurementCSVFile||null;renderFailedRaster();resetModelSelection();
  if(candidate.modelFile){trainedModelFile=candidate.modelFile;trainedModelInfo=candidate.modelInfo;restoreModelDetails(candidate.modelFile);$('analysisModelInfo').replaceChildren(raw(candidate.modelInfo.id),' · ',raw(candidate.modelFile.name));try{const dt=new DataTransfer();dt.items.add(candidate.modelFile);$('analysisModel').files=dt.files;}catch{resetModelSelection();}}
  selected=candidate.selection?.selected||state?.rois[0]?.id||'';pathIndex=Number.isInteger(candidate.selection?.pathIndex)&&candidate.selection.pathIndex>=0?candidate.selection.pathIndex:0;vertexIndex=Number.isInteger(candidate.selection?.vertexIndex)&&candidate.selection.vertexIndex>=0?candidate.selection.vertexIndex:0;
  if(!roi()){selected=state?.rois[0]?.id||'';pathIndex=vertexIndex=0;}if(roi())editor();
  for(const id of fieldIds)if(Object.hasOwn(candidate.fields||{},id)){if($(id).type==='checkbox')$(id).checked=candidate.fields[id]===true;else $(id).value=String(candidate.fields[id]??'');}
  dirty.clear();for(const group of candidate.dirty||[])if(['vertex','exclusion','metadata','region'].includes(group))dirty.add(group);
  approvalChanged=false;$('analysisChecked').checked=false;
 }
 syncAttachmentPickers();render();status(candidate.kind==='restore'?'Recovery restored. Pending fields are retained; review and approve again before export.':candidate.kind==='image'?'Source image ready. Import ImageJ ROIs or start manual review. Model predictions are an optional advanced workflow.':'New draft accepted. The previous review remains in browser recovery copies.','draft');
}
async function acceptReplacement(){
 if(busy||!pendingReplacement)return;const candidate=pendingReplacement;setBusy(true);
 try{await preserveCurrent();installCandidate(candidate);discardReplacement();}
 catch{status('Replacement paused because the current work could not be saved. Keep the current review and retry recovery saving.','error');}
 finally{setBusy(false);}
 if(!pendingReplacement&&candidate.kind==='image'&&trainedModelFile&&$('analysisAutoGenerate').checked)generateDraft();
}
$('analysisAcceptReplacement').addEventListener('click',acceptReplacement);
$('analysisKeepCurrent').addEventListener('click',()=>{if(busy)return;discardReplacement();status('Current image and review retained.');});
$('analysisRetrySave').addEventListener('click',()=>{if(source){queueRecovery();flushRecovery().catch(()=>{});}else refreshRecoveryList();});
$('analysisRecoveryList').addEventListener('change',controls);
$('analysisDeleteSession').addEventListener('click',async()=>{
 if(busy)return;const id=$('analysisRecoveryList').value;if(!id)return;const expectedRevision=recoveryRevisions.get(id);
 if(!confirm(window.CerebellumI18n?.t?.('Delete this browser recovery copy? Original files on your computer are not deleted.')||'Delete this browser recovery copy? Original files on your computer are not deleted.'))return;
 setBusy(true);try{if(id===sessionId)await flushRecovery();const removed=await recoveryStore.remove(id,id===sessionId?sessionRevision:expectedRevision);if(id===sessionId){sessionRevision=removed.revision;savedVersion=-1;recoveryStatus('The recovery copy was deleted. Current work remains open; retry saving to retain it.','pending');}await refreshRecoveryList();}catch{await refreshRecoveryList();recoveryStatus('The recovery copy could not be deleted. It may have changed in another tab.','error');}finally{setBusy(false);}
});
async function prepareImage(file,signal,quiet=false){
 await libraries();const decoded=await ResearchImage.loadTIFF(file,{maxPreview:2048,signal,onProgress:quiet?()=>{}:message=>status(message,'busy')}),{width,height,bytes,sha256}=decoded;
 if(width>32767||height>32767)throw Error('ImageJ review export supports dimensions up to 32767 pixels per axis.');
 const canvas=document.createElement('canvas');canvas.width=decoded.previewWidth;canvas.height=decoded.previewHeight;canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(decoded.rgba.buffer),canvas.width,canvas.height),0,0);
 const preview=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!preview)throw Error('The TIFF preview could not be created.');
 return {kind:'image',name:file.name,source:{name:file.name,sha256,width,height},bytes,sourceBlob:new Blob([bytes],{type:'image/tiff'}),previewBlob:preview};
}
$('analysisRestoreSession').addEventListener('click',async()=>{
 if(busy)return;const id=$('analysisRecoveryList').value;if(!id)return;setBusy(true);
 try{
  const record=await recoveryStore.load(id);if(!record)throw Error('The recovery copy is no longer available.');
  const candidate=await prepareImage(new File([record.sourceBlob],record.source.name,{type:'image/tiff'}));
  if(candidate.source.sha256!==record.source.sha256||candidate.source.width!==record.source.width||candidate.source.height!==record.source.height)throw Error('Recovery source verification failed.');
  const bytes=record.predictionBlob?new Uint8Array(await record.predictionBlob.arrayBuffer()):null;
  if(record.drawing&&(!['add','replace','ring'].includes(record.drawing.mode)||record.drawing.kind!==undefined&&!['area','polyline','point'].includes(record.drawing.kind)||!Array.isArray(record.drawing.points)||record.drawing.points.length>5000||record.drawing.points.some(p=>!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite))))throw Error('Recovery drawing is invalid.');
  if(record.state&&(!bytes||JSON.stringify(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)))!==JSON.stringify(record.state.original_prediction)))throw Error('Recovery prediction verification failed.');
  const next=record.state?await C.importDraft(record.state,candidate.source):null;await verifySelectedFiles(next,bytes,record.predictionSelectionFile,record.reviewDraftFile);const originals=[];for(const f of record.evidenceFiles||[]){const bytes=new Uint8Array(await f.blob.arrayBuffer());if(await ResearchCore.sha256(bytes)!==f.sha256)throw Error('Recovery ROI evidence verification failed.');originals.push({name:f.name,sha256:f.sha256,bytes});}await verifyEvidence(next,originals,record.resultModelFile||null);if(record.state?.measurement_reference)await verifyCSV(record.state,record.measurementCSVFile);if(record.failedRaster)await validateFailedRaster(record.failedRaster,candidate.source);
  let modelInfo=null;if(record.modelFile){const model=modelDocument(JSON.parse(await record.modelFile.text()));modelInfo=modelInfoFor(model);}
  Object.assign(candidate,{kind:'restore',state:next,predictionBytes:bytes,predictionName:record.predictionName,fields:record.fields,dirty:record.dirty,selection:record.selection,viewMode:record.viewMode,modelFile:record.modelFile,modelInfo,evidenceFiles:originals,resultModelFile:record.resultModelFile||null,drawing:record.drawing||null,failedRaster:record.failedRaster||null,measurementCSVFile:record.measurementCSVFile||null,predictionSelectionFile:record.predictionSelectionFile||null,reviewDraftFile:record.reviewDraftFile||null});
  if(source)stageReplacement(candidate);else installCandidate(candidate);
 }catch(error){status(error.message,'error');}finally{setBusy(false);}
});
$('analysisPanel').addEventListener('input',event=>{if(fieldIds.includes(event.target.id))queueRecovery();});
$('analysisPanel').addEventListener('change',event=>{if(['analysisROI','analysisPath','analysisVertex','analysisModel'].includes(event.target.id))queueRecovery();});
window.addEventListener('beforeunload',event=>{if(source&&(busy||pendingReplacement||savedVersion!==changeVersion||recoveryError)){event.preventDefault();event.returnValue='';}});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&source)flushRecovery().catch(()=>{});});
function save(name,bytes,type='application/octet-stream'){const url=URL.createObjectURL(new Blob([bytes],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function apply(operation,message){if(!state||busy)return;try{state=operation(state);$('analysisChecked').checked=false;render();status(message,'draft');}catch(e){status(e.message,'error');controls();}}
async function imageFile(file){
 if(!file||busy)return;const token=++generation;imageController=new AbortController();const signal=imageController.signal;cancelImage.hidden=false;setBusy(true);status('Reading the original TIFF locally…','busy');let installed=false;
 try{if(file.size>ResearchImage.LIMITS.fileBytes)throw Error('TIFF exceeds the original-file size limit.');if(!/\.tiff?$/i.test(file.name))throw Error('Choose a single-page .tif or .tiff source image.');const candidate=await prepareImage(file,signal);if(signal.aborted)throw new DOMException('Image loading cancelled.','AbortError');if(token!==generation)return;if(source)stageReplacement(candidate);else{installCandidate(candidate);installed=true;}}
 catch(error){status(error.message+(source?' Previous image and review retained.':''),error.name==='AbortError'?'ready':'error');syncAttachmentPickers();}
 finally{if(token===generation){imageController=null;cancelImage.hidden=true;setBusy(false);if(installed&&trainedModelFile&&$('analysisAutoGenerate').checked&&!signal.aborted)queueMicrotask(generateDraft);}}
}
async function matchingResultModel(next,file=trainedModelFile){return next?.model&&file&&await ResearchCore.sha256(new Uint8Array(await file.arrayBuffer()))===next.model.weights_sha256?file:null;}
async function predictionFile(file){if(!file||!source||busy)return;const token=++generation,currentSource=source;setBusy(true);status('Checking the prediction against the original TIFF…','busy');try{if(file.size>(C.LIMITS.predictionBytes||8*1024*1024))throw Error('Prediction JSON exceeds 8 MiB.');const bytes=new Uint8Array(await file.arrayBuffer()),prediction=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),next=C.create(prediction,currentSource),modelFile=await matchingResultModel(next);if(token!==generation)return;const candidate={kind:'review',name:file.name,state:next,bytes,resultModelFile:modelFile,predictionSelectionFile:file};if(state||dirty.size||failedRaster)stageReplacement(candidate);else{installReview(next,bytes,file.name,[],modelFile,null,candidate);status('Prediction loaded as a draft. Review the boundaries and enter section metadata before approval.','draft');}}catch(e){if(token===generation){status(e.message+(state?' Previous review retained.':''),'error');syncAttachmentPickers();}}finally{if(token===generation)setBusy(false);}}
async function attachResultModel(file){if(busy||!state?.model||!file)return;setBusy(true);try{if(file.size>BrowserModelCore.LIMITS.modelBytes)throw Error('Result model file exceeds 64 MiB.');if(!await matchingResultModel(state,file))throw Error('This file does not match the result model SHA-256.');await preserveCurrent();beginSession();resultModelFile=file;syncPicker('analysisResultModel',[file]);render();status('Original model bytes verified and attached to this result. Active generation model is unchanged.');}catch(error){syncPicker('analysisResultModel',[resultModelFile]);status(error.message+' Previous model evidence retained.','error');}finally{setBusy(false);}}
$('analysisResultModel').addEventListener('change',event=>attachResultModel(event.target.files[0]));
$('analysisClearResultModel').addEventListener('click',async()=>{if(busy||!resultModelFile)return;setBusy(true);try{await preserveCurrent();beginSession();resultModelFile=null;syncPicker('analysisResultModel');render();status('Result model attachment cleared. The declared model hash and active generation model are retained.');}catch(error){status(error.message,'error');}finally{setBusy(false);}});
const builtInModel=window.CerebellumBoot?.profile.built_in_model||null;let shownModel=null,builtInLoading=false;
const modelPrompt=()=>builtInModel?'Use the built-in model, or choose a model trained with Local Lab.':'Choose a model trained with Local Lab. No pretrained Nissl model is included.';
function resetModelSelection(){modelSelectionVersion++;trainedModelFile=null;trainedModelInfo=null;shownModel=null;$('analysisModel').value='';$('analysisModelInfo').textContent=modelPrompt();$('analysisModelDetails').hidden=true;if($('analysisModelDialog').open)$('analysisModelDialog').close();}
// Work screens show counts; the names a model declares are shown only in this window.
function showModelDetails(){
 const model=shownModel;if(!model)return;const list=$('analysisModelDialogList'),row=(label,...values)=>{const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=ui(label);dd.append(...values);list.append(dt,dd);};
 list.replaceChildren();row('Model',raw(model.id));
 const training=[...(model.training_animals||[])],sources=model.training_sources||[];
 if(training.length)row('Training animals',raw(training.join(', ')));
 if(sources.length){const sections=document.createElement('div');for(const animal of training){const ids=sources.filter(s=>s.animal_id===animal&&s.section_id).map(s=>s.section_id);if(ids.length){const line=document.createElement('div');line.append(raw(ids.join(', ')));sections.append(line);}}row('Training sections',raw(String(sources.length)),sections);}
 const evaluation=model.whole_image_evaluation||model.evaluation;
 if(evaluation?.evaluation_animals?.length)row('Evaluation animals',raw(evaluation.evaluation_animals.join(', ')));
 if(model.whole_image_evaluation)row('Declared whole-image Dice',raw(['CB','ML','GL','WM'].map(name=>name+': '+(100*model.whole_image_evaluation.dice[name]).toFixed(1)+'%').join(' · ')));
 $('analysisModelDialog').showModal();
}
$('analysisModelDetails').addEventListener('click',showModelDetails);$('analysisModelDialogClose').addEventListener('click',()=>$('analysisModelDialog').close());
// Messages go into the model area as well: this button is used inside a card that covers the status line.
function builtInNotice(message,kind){status(message,kind);$('analysisModelInfo').textContent=message;}
function restoreModelDetails(file){if(!file)return;file.text().then(text=>{const model=modelDocument(JSON.parse(text));if(trainedModelFile===file){shownModel=model;$('analysisModelDetails').hidden=false;}}).catch(()=>{});}
async function useBuiltInModel(){
 if(busy||builtInLoading||!builtInModel)return;builtInLoading=true;$('analysisBuiltInModel').disabled=true;const version=modelSelectionVersion,before=$('analysisModelInfo').cloneNode(true);builtInNotice('Loading the built-in model…');
 const keep=message=>{$('analysisModelInfo').replaceWith(before);status(message);};
 try{
  const response=await fetch(builtInModel.url);if(!response.ok)throw Error('The built-in model could not be loaded. Choose a model file instead.');
  const bytes=await response.arrayBuffer();
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(bytes.byteLength!==builtInModel.bytes||digest!==builtInModel.sha256)throw Error('The built-in model file does not match its recorded fingerprint. Choose a model file instead.');
  // A choice made, or work started, while the file was arriving wins over this request.
  if(version!==modelSelectionVersion){keep('The built-in model was not selected because the model choice changed meanwhile.');return;}
  if(busy){keep('The built-in model was not selected because other work is running. Try again when it has finished.');return;}
  builtInLoading=false;$('analysisModelInfo').replaceWith(before);await chooseModel(new File([bytes],builtInModel.url.split('/').pop(),{type:'application/json'}));
 }catch(e){const message=e instanceof TypeError?'The built-in model could not be loaded. Choose a model file instead.':e.message;if(version===modelSelectionVersion&&!trainedModelFile)builtInNotice(message,'error');else keep(message);}
 finally{builtInLoading=false;$('analysisBuiltInModel').disabled=false;}
}
if(builtInModel){$('analysisBuiltInModel').hidden=false;$('analysisBuiltInModel').addEventListener('click',useBuiltInModel);$('analysisModelInfo').textContent=modelPrompt();}
function clearModelSelection(){if(busy)return;resetModelSelection();AutoROIModelBundle.forget().catch(()=>{});controls();queueRecovery();status('Model selection cleared. The image and existing review are retained.');}
$('analysisClearModel').addEventListener('click',clearModelSelection);
function showSelectedModel(model,file,restored=false){
 trainedModelFile=file;trainedModelInfo=modelInfoFor(model);shownModel=model;$('analysisModelDetails').hidden=false;
 // The ML–GL candidate is part of this model's review set; the researcher can still turn it off.
 if(model.family==='experimental-unet'&&!restored)$('analysisIncludePL').checked=true;
 if(model.family==='experimental-unet')$('analysisModelInfo').replaceChildren(raw(model.id),' · ',raw('CB · ML · GL · WM'),' · ',ui('A fitted tissue network generates CB and tissue-layer drafts together. Anatomical accuracy still requires review.'));
 else if(model.isBundle)$('analysisModelInfo').replaceChildren(raw(model.id),' · ',raw(model.models.lobules?'CB · ML · GL · WM · '+model.models.lobules.classes.slice(1).join(' · '):'CB · ML · GL · WM'),' · ',ui(model.models.lobules?'Fitted models generate separate tissue and annotated cortical-region drafts. Anatomical accuracy still requires review.':'Two fitted models generate separate CB and tissue-layer drafts. Anatomical accuracy still requires review.'));
 else $('analysisModelInfo').replaceChildren(raw(model.id),' · '+model.trees.length+' trees · '+model.training_animals.length+' declared training animals. Anatomical accuracy remains unverified.');
 if(model.evaluation){const e=model.evaluation,scores=Object.entries(e.tasks).flatMap(([head,task])=>Object.keys(task.aggregate.per_class).filter(name=>name!=='background').map(name=>[head,name])).map(([head,name])=>name+': '+(e.tasks[head].aggregate.per_class[name].dice_on_sampled_pixels===null?'—':(100*e.tasks[head].aggregate.per_class[name].dice_on_sampled_pixels).toFixed(1)+'%')).join(' · ');$('analysisModelInfo').append(document.createElement('br'),ui('Declared internal evaluation · sampled Dice: '),raw(scores),document.createElement('br'),ui('Evaluation animals: '),raw(String(e.evaluation_animals.length)),' · ',ui('Sampled scores do not establish whole-image boundary accuracy or independent biological validity.'));}
 if(model.whole_image_evaluation){const e=model.whole_image_evaluation;$('analysisModelInfo').append(document.createElement('br'),ui('Declared whole-image Dice: '),raw(['CB','ML','GL','WM'].map(name=>name+': '+(100*e.dice[name]).toFixed(1)+'%').join(' · ')),document.createElement('br'),ui('Evaluation animals: '),raw(String(e.evaluation_animals.length)),' · ',ui('These exploratory scores do not establish independent biological validity.'));}
 if(restored)$('analysisModelInfo').append(' ',ui('The previously selected model was restored from this browser.'));
 syncPicker('analysisModel',[file]);
}
async function chooseModel(file){
 if(busy)return;if(!file){syncPicker('analysisModel',[trainedModelFile]);return;}modelSelectionVersion++;let accepted=false;setBusy(true);
 try{
  if(file.size>BrowserModelCore.LIMITS.modelBytes)throw Error('Model JSON exceeds 64 MiB.');
  const model=modelDocument(JSON.parse(await file.text()));showSelectedModel(model,file);accepted=true;
  if(!resultModelFile&&await matchingResultModel(state,file)){resultModelFile=file;syncPicker('analysisResultModel',[file]);renderAttachments();}
  status('Model ready. New images can generate an unapproved ROI draft locally.');
  try{await AutoROIModelBundle.remember(file);}catch{ $('analysisModelInfo').append(' ',ui('This model could not be saved in this browser. Keep the original model file.')); }
 }catch(e){resetModelSelection();AutoROIModelBundle.forget().catch(()=>{});status(e.message+' Model selection cleared.','error');}
 finally{setBusy(false);queueRecovery();}
 if(accepted&&source&&!state&&trainedModelFile&&$('analysisAutoGenerate').checked)generateDraft();
}
async function restoreRememberedModel(){const version=modelSelectionVersion;try{const file=await AutoROIModelBundle.recalled();if(!file)return;const model=modelDocument(JSON.parse(await file.text()));if(version!==modelSelectionVersion||trainedModelFile||busy||source)return;showSelectedModel(model,file,true);controls();}catch{/* A missing/unavailable cache never replaces an explicit selection or review. */}}

function generateDraft(){if(!source||!sourceBytes||!trainedModelFile||busy||dirty.size)return;let automaticCandidates=false;const token=++generation,currentSource=source,generationModel=trainedModelFile;setBusy(true);status('Generating ROI draft from original pixels…','busy');const worker=new Worker('./assets/browser_model_worker.js');modelWorker=worker;$('analysisCancelModel').hidden=false;$('analysisCancelModel').disabled=false;
const finish=()=>{worker.terminate();if(modelWorker===worker)modelWorker=null;if(token===generation){$('analysisCancelModel').hidden=true;setBusy(false);}};
worker.onerror=e=>{if(token===generation)status((e.message||'The model worker failed.')+' Previous review retained.','error');finish();};
worker.onmessage=async({data})=>{if(token!==generation)return finish();if(data.progress){const p=data.progress;status((p.message||p.stage||'Generating ROI draft')+(p.total?' · '+p.completed+' / '+p.total:''),'busy');return;}if(data.raster){try{const candidate={metadata:data.raster.metadata,labels:new Blob([data.raster.labels]),modelFile:generationModel};if(data.rasters)candidate.additionalRasters=data.rasters.filter(r=>r.metadata.head!==data.raster.metadata.head).map(r=>({metadata:r.metadata,labels:new Blob([r.labels])}));await validateFailedRaster(candidate,currentSource);if(token!==generation)return finish();if(failedRaster){await preserveCurrent();if(token!==generation)return finish();beginSession();}failedRaster=candidate;if(candidate.additionalRasters){$('analysisShowFailedRaster').checked=true;setViewMode('roi');}renderFailedRaster();queueRecovery();status('Native model pixels retained. Review the conversion failure and download the label-map evidence. Existing review is unchanged.','draft');automaticCandidates=trainedModelInfo?.family==='experimental-unet';}catch(error){status(error.message,'error');}finish();if(automaticCandidates)createRasterCandidates({automatic:true});return;}if(data.error){status(data.error+' Previous review retained.','error');return finish();}try{const prediction=data.result,next=C.create(prediction,currentSource);const bytes=new TextEncoder().encode(JSON.stringify(prediction)),name='browser-generated-prediction.json';if(state||failedRaster)stageReplacement({kind:'review',name,state:next,bytes,resultModelFile:generationModel});else{installReview(next,bytes,name,[],generationModel);status('ROI draft generated. Inspect the boundaries, enter the physical scale, and approve before exporting measurements.','draft');}}catch(e){status(e.message+' Previous review retained.','error');}finish();};
// A Blob copy preserves sourceBytes for source verification and the approved archive.
worker.postMessage({file:new File([sourceBytes],currentSource.name,{type:'image/tiff'}),modelFile:generationModel,expectedSourceSha256:currentSource.sha256,sourceName:currentSource.name,includePL:$('analysisIncludePL').checked});
}
$('analysisModel').addEventListener('change',e=>chooseModel(e.target.files[0]));$('analysisGenerate').addEventListener('click',generateDraft);$('analysisCancelModel').addEventListener('click',()=>{if(!modelWorker)return;modelWorker.terminate();modelWorker=null;generation++;$('analysisCancelModel').hidden=true;setBusy(false);status('Generation stopped. Original image and any previous review are retained.');});
$('analysisImage').addEventListener('change',e=>imageFile(e.target.files[0]));$('analysisPrediction').addEventListener('change',e=>predictionFile(e.target.files[0]));
$('analysisFit').addEventListener('click',fit);$('analysisZoomIn').addEventListener('click',()=>zoom(.8));$('analysisZoomOut').addEventListener('click',()=>zoom(1.25));$('analysisOverlay').addEventListener('change',()=>{setViewMode($('analysisOverlay').checked?'overlay':'original');draw();queueRecovery();});$('analysisViewMode').addEventListener('change',()=>{setViewMode(viewMode());draw();queueRecovery();});
$('analysisROIScope').addEventListener('change',()=>{structureLabel=null;draw();controls();});$('analysisLabelChips').addEventListener('click',e=>{const b=e.target.closest('button');if(b)showStructure(b.dataset.label);});$('analysisSmallPieces').addEventListener('click',nextPiece);$('analysisCanvas').addEventListener('pointermove',e=>{if(e.pointerType==='touch')return;cancelAnimationFrame(hoverFrame);const ev=e;hoverFrame=requestAnimationFrame(()=>hoverLabel(ev));});$('analysisCanvas').addEventListener('pointerleave',()=>{cancelAnimationFrame(hoverFrame);$('analysisHoverLabel').hidden=true;});
$('analysisROI').addEventListener('change',()=>{if(!canChangeSelection())return;selected=$('analysisROI').value;pathIndex=vertexIndex=0;dirty.delete('vertex');dirty.delete('exclusion');editor();draw();controls();});
$('analysisPath').addEventListener('change',()=>{if(!canChangeSelection())return;pathIndex=Number($('analysisPath').value);vertexIndex=0;dirty.delete('vertex');editor();draw();controls();});
$('analysisVertex').addEventListener('change',()=>{if(!canChangeSelection())return;const n=Number($('analysisVertex').value);if(!Number.isInteger(n)||n<1||n>roi().paths[pathIndex].length){status('Choose a vertex within the selected contour.','error');$('analysisVertex').value=vertexIndex+1;return;}vertexIndex=n-1;dirty.delete('vertex');editor();draw();controls();});
for(const id of ['analysisX','analysisY'])$(id).addEventListener('input',()=>markDirty('vertex'));
$('analysisApplyVertex').addEventListener('click',()=>apply(s=>{if(!$('analysisX').value.trim()||!$('analysisY').value.trim())throw Error('Both vertex coordinates are required.');const next=C.editVertex(s,selected,pathIndex,vertexIndex,[Number($('analysisX').value),Number($('analysisY').value)]);dirty.delete('vertex');return next;},'Boundary updated. Review and approve the revised result.'));
for(const id of ['analysisExcluded','analysisExclusionReason'])$(id).addEventListener('input',()=>markDirty('exclusion'));
$('analysisApplyExclusion').addEventListener('click',()=>apply(s=>{const next=C.setExclusion(s,selected,$('analysisExcluded').checked,$('analysisExclusionReason').value);dirty.delete('exclusion');return next;},'Inclusion decision saved with the original ROI retained.'));
for(const id of [...Object.values(metaFields),'analysisSingle'])$(id).addEventListener('input',()=>markDirty('metadata'));
$('analysisApplyMetadata').addEventListener('click',()=>apply(s=>{const patch={single_section_confirmed:$('analysisSingle').checked};for(const[key,id]of Object.entries(metaFields)){const value=$(id).value;patch[key]=['animal_id','section_id'].includes(key)?value:value.trim()===''?null:Number(value);}const next=C.setMetadata(s,patch);dirty.delete('metadata');return next;},'Section metadata saved. Unknown values remain missing.'));
$('analysisResetFields').addEventListener('click',()=>{dirty.clear();approvalChanged=false;if(state?.approval){$('analysisReviewer').value=state.approval.reviewer;$('analysisProtocol').value=state.approval.protocol;}syncMetadata();editor();draw();controls();queueRecovery();status('Unapplied fields discarded. Saved geometry and metadata are unchanged.');});
for(const id of ['analysisReviewer','analysisProtocol'])$(id).addEventListener('input',()=>{if(state?.approval){approvalChanged=true;$('analysisChecked').checked=false;controls();status('Reviewer details changed. Confirm the checks and approve again before export.','draft');}});
$('analysisApprove').addEventListener('click',async()=>{if(!state||busy||dirty.size||drawing)return;const token=++generation,current=state;setBusy(true);try{const next=await C.approve(current,{reviewer:$('analysisReviewer').value,protocol:$('analysisProtocol').value,checked:$('analysisChecked').checked,coordinatesChecked:$('analysisCoordinatesChecked').checked});if(token!==generation||state!==current||dirty.size)return;state=next;approvalChanged=false;render();status('Reviewed result approved. Download the archive to retain your work.','approved');}catch(e){if(token===generation)status(e.message,'error');}finally{if(token===generation)setBusy(false);}});
$('analysisExport').addEventListener('click',async()=>{if(!state||busy||dirty.size||drawing||!state.approval||approvalChanged)return;const token=++generation,current=state;setBusy(true);try{await libraries();const result=await C.exportApproved(current);if(!sourceBytes||!predictionBytes)throw Error('Source evidence is unavailable. Reopen the source and prediction before export.');const zip=new JSZip(),roiZip=new JSZip();for(const file of result.files){zip.file('rois/'+file.name,file.bytes);roiZip.file(file.name,file.bytes);}const roiArchive=await roiZip.generateAsync({type:'uint8array',compression:'DEFLATE'});zip.file('rois.zip',roiArchive);zip.file('ROI.zip',roiArchive);zip.file('measurement.csv',result.csv);zip.file('result.csv',result.resultCSV);zip.file('review.json',JSON.stringify(result.report,null,2)+'\n');zip.file('originals/source.tif',sourceBytes);zip.file('originals/prediction.json',predictionBytes);await verifyEvidence(current,evidenceFiles,resultModelFile);const originalEntries=[];for(let i=0;i<evidenceFiles.length;i++){const f=evidenceFiles[i],path='originals/roi-input-'+(i+1)+(f.name.toLowerCase().endsWith('.zip')?'.zip':'.roi');zip.file(path,f.bytes);originalEntries.push({name:f.name,sha256:f.sha256,size:f.bytes.length,archive_path:path});}let modelManifest={status:current.model?'Original model bytes unavailable; prediction declares the model hash.':'Not applicable; no model was used.'};if(resultModelFile){const bytes=new Uint8Array(await resultModelFile.arrayBuffer()),path='originals/model'+(/\.onnx$/i.test(resultModelFile.name)?'.onnx':/\.json$/i.test(resultModelFile.name)?'.json':'.bin');zip.file(path,bytes);modelManifest={name:resultModelFile.name,sha256:await ResearchCore.sha256(bytes),size:bytes.length,archive_path:path,status:'Original bytes retained'};}zip.file('originals/manifest.json',JSON.stringify({source:{...source,archive_path:'originals/source.tif'},prediction:{name:predictionName,sha256:await ResearchCore.sha256(predictionBytes),archive_path:'originals/prediction.json',kind:current.original_prediction.schema},roi_inputs:originalEntries,detached_roi_inputs:(current.detached_sources||[]).map(f=>({...f,status:'Detached from this review. Original bytes are not included; the preceding browser recovery copy retains them.'})),measurement_csv:current.measurement_reference?{...current.measurement_reference.file,archive_path:'originals/measurements.csv'}:null,model:modelManifest},null,2)+'\n');if(current.measurement_reference){await verifyCSV(current,measurementCSVFile);zip.file('originals/measurements.csv',await measurementCSVFile.arrayBuffer());}if(current.original_prediction.reference){const ref=current.original_prediction.reference,available=failedRaster?.metadata.label_sha256===ref.label_sha256;zip.file('reference-label-map.json',JSON.stringify({metadata:ref,original_bytes_included:available,note:'Unreviewed model output was a visual reference only. Approved contours are the researcher-derived polygons.'},null,2));if(available){zip.file('originals/reference-labels.uint8',await failedRaster.labels.arrayBuffer());zip.file('originals/reference-model.json',await failedRaster.modelFile.arrayBuffer());const maps=await appendRasterMaps(zip,failedRaster,'originals/reference-');zip.file('reference-maps.json',JSON.stringify(maps,null,2));}}zip.file('review-draft.json',JSON.stringify(await draftBundle(),null,2)+'\n');const blob=await zip.generateAsync({type:'uint8array',compression:'DEFLATE'});if(token!==generation||state!==current||dirty.size||approvalChanged)return;save('cerebellum-reviewed-results.zip',blob,'application/zip');status('Archive download requested. Confirm the file was saved; the browser recovery copy is retained.','approved');}catch(e){if(token===generation)status(e.message,'error');}finally{if(token===generation)setBusy(false);}});
async function exportSeparate(format){
 if(!state||busy||dirty.size||drawing||!state.approval||approvalChanged)return;
 const token=++generation,current=state,roiIds=scopedROIs().map(r=>r.id);if(!roiIds.length)return;setBusy(true);
 try{const result=await C.exportApproved(current,{roiIds});let bytes,mime,name;
  if(format==='roi'){if(!result.files.length)throw Error('No included ROI in this scope.');await libraries();const zip=new JSZip();for(const file of result.files)zip.file(file.name,file.bytes);bytes=await zip.generateAsync({type:'uint8array',compression:'DEFLATE'});mime='application/zip';name='ROI.zip';}
  else{bytes=format==='measurement'?result.csv:result.resultCSV;mime='text/csv;charset=utf-8';name=format==='measurement'?'measurement.csv':'result.csv';}
  if(token!==generation||state!==current||dirty.size||approvalChanged)return;save(name,bytes,mime);status('File download requested. Confirm the file was saved.','approved');
 }catch(error){if(token===generation)status(error.message,'error');}finally{if(token===generation)setBusy(false);}
}
$('analysisExportMeasurement').addEventListener('click',()=>exportSeparate('measurement'));
$('analysisExportResult').addEventListener('click',()=>exportSeparate('result'));
$('analysisExportROI').addEventListener('click',()=>exportSeparate('roi'));
// The draft, before approval, as polygons a person can correct in ImageJ or Fiji: Cb, GL+WM and WM, one polygon per separate
// part or hole. ImageJ cannot drag the vertices of the traced outlines and composites that the approved export writes.
$('analysisExportDraftROI').addEventListener('click',async()=>{
 if(!state||busy||dirty.size||drawing)return;const token=++generation,current=state;setBusy(true);
 try{const E=window.EditableROICore,included=current.rois.filter(r=>r.included),of=label=>included.filter(r=>r.label===label&&C.kindOf(r)==='area').map(r=>r.paths);
  if(!of('CB').length||!of('GL').length)throw Error('An editable ImageJ file needs a CB and a GL outline in this review.');
  const lines=included.filter(r=>r.label==='PL'&&C.kindOf(r)==='polyline'),x=current.metadata.um_per_pixel_x,y=current.metadata.um_per_pixel_y;
  const made=E.editable({CB:of('CB'),GL:of('GL'),WM:of('WM')},current.source.width,current.source.height,{um2:x>0&&y>0?x*y:null,pl:lines.length===1?lines[0].paths[0].map(p=>[Math.round(p[0]),Math.round(p[1])]):null});
  await libraries();const zip=new JSZip();for(const polygon of made.polygons)zip.file(polygon.name+'.roi',E.encodeROI(polygon.name,polygon.kind,polygon.path));const bytes=await zip.generateAsync({type:'uint8array',compression:'DEFLATE'});
  if(token!==generation||state!==current||dirty.size)return;save('ROI-draft-editable-not-approved.zip',bytes,'application/zip');status('Draft ROI file download requested. It is not an approved result; correct it in ImageJ or Fiji and import it again.','draft');
 }catch(error){if(token===generation)status(error.message,'error');}finally{if(token===generation)setBusy(false);}
});
let lastCombined=null;
async function draftBundle(){return{schema:'cerebellum-review-file/1',state:clone(state),prediction_file:{name:predictionName,base64:bytesToBase64(predictionBytes)},source_original_included:false,measurement_csv_file:measurementCSVFile?{name:measurementCSVFile.name,base64:bytesToBase64(new Uint8Array(await measurementCSVFile.arrayBuffer()))}:null,evidence_files:evidenceFiles.map(f=>({name:f.name,sha256:f.sha256,base64:bytesToBase64(f.bytes)}))};}
$('analysisContinueStudy').addEventListener('click',async()=>{if(!state||busy||dirty.size||drawing||!state.approval||approvalChanged)return;const target=$('studyFromAnalysis');if(!target||target.disabled||!window.CerebellumWorkspace){status('Wait for Study to finish before copying this section.','error');return;}setBusy(true);try{await preserveCurrent();if(target.disabled)throw Error('Wait for Study to finish before copying this section.');window.CerebellumWorkspace.open('study');target.click();}catch(error){status(error.message,'error');}finally{setBusy(false);}});
$('analysisSaveDraft').addEventListener('click',async()=>{if(!state||busy)return;if(dirty.size||approvalChanged||drawing){status('Apply, reapprove or discard pending fields before saving a draft.','error');return;}const current=state;const serialized=JSON.stringify(await draftBundle(),null,2)+'\n';if(state!==current||dirty.size||approvalChanged||drawing)return;if(new TextEncoder().encode(serialized).length>48*1024*1024){status('The draft exceeds 48 MiB. Keep the recovery copy and use the approved evidence archive after review.','error');return;}save('cerebellum-review-draft.json',serialized,'application/json');status('Draft download requested. Confirm the file was saved and keep the matching original TIFF.');});
$('analysisDraft').addEventListener('change',async e=>{const file=e.target.files[0];if(!file||!source||busy)return;const token=++generation;setBusy(true);try{if(file.size>48*1024*1024)throw Error('Review draft exceeds 48 MiB.');const doc=JSON.parse(await file.text());if(doc.schema!=='cerebellum-review-file/1'||!doc.prediction_file||typeof doc.prediction_file.name!=='string'||doc.prediction_file.name.length>1024)throw Error('Invalid review draft file.');const bytes=base64ToBytes(doc.prediction_file.base64),prediction=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(JSON.stringify(prediction)!==JSON.stringify(doc.state.original_prediction))throw Error('Saved prediction bytes do not match the draft’s original prediction.');const next=await C.importDraft(doc.state,source);const originals=[];for(const f of doc.evidence_files||[]){const payload=base64ToBytes(f.base64);if(await ResearchCore.sha256(payload)!==f.sha256)throw Error('Saved ROI evidence hash does not match.');originals.push({name:f.name,sha256:f.sha256,bytes:payload});}const matchedModel=await matchingResultModel(next);await verifyEvidence(next,originals,matchedModel);const csvFile=doc.measurement_csv_file?new File([base64ToBytes(doc.measurement_csv_file.base64)],doc.measurement_csv_file.name,{type:'text/csv'}):null;if(next.measurement_reference)await verifyCSV(next,csvFile);if(token!==generation)return;if(state||dirty.size||failedRaster)stageReplacement({kind:'review',name:doc.prediction_file.name,state:next,bytes,evidenceFiles:originals,measurementCSVFile:csvFile,resultModelFile:matchedModel,reviewDraftFile:file});else{installReview(next,bytes,doc.prediction_file.name,originals,matchedModel,csvFile,{reviewDraftFile:file});status('Draft reopened against the matching TIFF. Previous approval is history; review and approve again.','draft');}}catch(err){if(token===generation){syncAttachmentPickers();status(err.message,'error');}}finally{if(token===generation)setBusy(false);}});
function renderQC(){
 const flags=state?C.qualityFlags(state):[];$('analysisQCFlags').replaceChildren(...flags.map(f=>{const li=document.createElement('li');li.append(f.message+' ',raw(f.roi_ids.join(', ')));return li;}));
 $('analysisQCStatus').textContent=!state?'':flags.length?(state.qc_acknowledgement?'QC review recorded. Any saved change requires another review.':'Inspect the flagged relationships and record your decision before approval.'):'No geometric flags found. This does not establish anatomical correctness.';
 $('analysisCoordinateConfirmation').hidden=state?.original_prediction.origin!=='imagej';
 $('analysisFinishDrawing').hidden=!drawing;$('analysisCancelDrawing').hidden=!drawing;$('analysisUndoDrawing').hidden=!drawing;$('analysisUndoDrawing').disabled=!drawing?.points.length;
}
async function verifySelectedFiles(next,bytes,selectedPrediction,selectedDraft){
 if(selectedPrediction){if(!next||!bytes||selectedPrediction.size>8*1024*1024||await ResearchCore.sha256(new Uint8Array(await selectedPrediction.arrayBuffer()))!==await ResearchCore.sha256(bytes))throw Error('Selected prediction file does not match the current original evidence.');}
 if(selectedDraft){if(!next||selectedDraft.size>48*1024*1024)throw Error('Selected review draft is invalid.');const draft=JSON.parse(await selectedDraft.text());if(draft.schema!=='cerebellum-review-file/1'||JSON.stringify(draft.state?.original_prediction)!==JSON.stringify(next.original_prediction))throw Error('Selected draft file does not match the current original evidence.');}
}
async function verifyEvidence(next,files,modelFile){
 if(!next)return;const active=(next.original_prediction.files||[]).filter(expected=>!next.detached_sources?.some(f=>f.name===expected.name&&f.sha256===expected.sha256));if(files.length!==active.length||new Set(files.map(f=>f.name)).size!==files.length||files.some(file=>!active.some(f=>f.name===file.name&&f.sha256===file.sha256)))throw Error('ROI attachment inventory does not match the active original evidence.');for(const expected of next.original_prediction.files||[]){if(next.detached_sources?.some(f=>f.name===expected.name&&f.sha256===expected.sha256))continue;const file=files.find(f=>f.name===expected.name&&f.sha256===expected.sha256);if(!file||file.bytes.length!==expected.size||await ResearchCore.sha256(file.bytes)!==expected.sha256)throw Error('Original ImageJ file evidence is missing or changed.');}
 if(modelFile&&(!next.model||await ResearchCore.sha256(new Uint8Array(await modelFile.arrayBuffer()))!==next.model.weights_sha256))throw Error('Original model bytes do not match the prediction model hash.');
}
async function beginManual(){if(!source||busy)return;const next=C.createFromROIs([],source,{reference:failedRaster?.metadata||null}),bytes=new TextEncoder().encode(JSON.stringify(next.original_prediction));if(state||dirty.size)stageReplacement({kind:'review',name:'manual-roi-input.json',state:next,bytes});else{installReview(next,bytes,'manual-roi-input.json');status('Manual review ready. Draw a boundary on the original image.','draft');}}
$('analysisManual').addEventListener('click',beginManual);
function imageJStyle(bytes){const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),h2=view.getInt32(60,false);let width=view.getUint16(34,false);if(h2>0&&h2+40<=bytes.length){const precise=view.getFloat32(h2+36,false);if(Number.isFinite(precise)&&precise>0)width=precise;}return{stroke_width_px:width,stroke_color_argb:view.getUint32(40,false),fill_color_argb:view.getUint32(44,false)};}
async function sourceROIIds(file){
 const original=state.original_prediction,known=original.rois.filter(r=>r.source_file===file.name&&(!r.source_sha256||r.source_sha256===file.sha256));if(known.length)return known.map(r=>r.id);
 // Legacy drafts did not record each ROI's parent file. Reconstruct the exact
 // original import order from retained bytes; never guess from duplicate names.
 await libraries();let offset=0;for(const expected of original.files||[]){const retained=evidenceFiles.find(f=>f.name===expected.name&&f.sha256===expected.sha256),detached=state.detached_sources?.find(f=>f.name===expected.name&&f.sha256===expected.sha256);let count;if(retained){count=/\.zip$/i.test(retained.name)?(await ResearchZip.read(retained.bytes)).entries.length:1;}else if(detached)count=detached.roi_ids.length;else throw Error('Original file associations could not be verified.');const ids=original.rois.slice(offset,offset+count).map(r=>r.id);if(expected.name===file.name&&expected.sha256===file.sha256)return ids;offset+=count;}throw Error('Original ROI file association is missing.');
}
async function removeROIFile(file){if(!state||busy||drawing||dirty.size)return;setBusy(true);try{const ids=await sourceROIIds(file),next=C.removeSourceFile(state,{name:file.name,sha256:file.sha256,roi_ids:ids});await preserveCurrent();beginSession();state=next;evidenceFiles=evidenceFiles.filter(f=>f!==file);discardReplacement();$('analysisChecked').checked=false;$('analysisCoordinatesChecked').checked=false;syncAttachmentPickers();render();status('Selected ROI source removed with its associated ROIs. Other attachments and the previous recovery copy are retained.','draft');}catch(error){status(error.message+' Previous review retained.','error');}finally{setBusy(false);}}
$('analysisROIImport').addEventListener('change',async event=>{
 if(!source||busy)return;const chosen=[...event.target.files];if(!chosen.length)return;setBusy(true);const token=++generation;
 try{await libraries();if(chosen.length>64)throw Error('Choose at most 64 original ROI files.');const files=[],rois=[],names=[];let total=0;
 for(const file of chosen){total+=file.size;if(total>16*1024*1024)throw Error('ImageJ source files exceed the 16 MiB review import limit.');const bytes=new Uint8Array(await file.arrayBuffer()),sha256=await ResearchCore.sha256(bytes);if(files.some(f=>f.name===file.name))throw Error('Duplicate ROI source filename.');files.push({name:file.name,sha256,bytes});let entries;if(/\.zip$/i.test(file.name))entries=(await ResearchZip.read(bytes)).entries;else if(/\.roi$/i.test(file.name))entries=[{name:file.name,bytes}];else throw Error('Choose ImageJ .roi or ROI ZIP files.');
 for(const entry of entries){const parsed=ResearchCore.parseROI(entry.bytes,entry.name),id='imagej-'+(rois.length+1),allowed=parsed.kind==='area'?['CB','ML','GL','WM']:C.LABELS,tokens=[...parsed.name.matchAll(/(?:^|[_ .+\/-])(CB|ML|GL|WM|PL|FISSURE|LANDMARK)(?=$|[_ .+\/-])/gi)].map(m=>m[1].toUpperCase()),label=tokens.length&&new Set(tokens).size===1&&allowed.includes(tokens[0])?tokens[0]:'UNASSIGNED';rois.push({...parsed,id,label,source_name:entry.name,source_file:file.name,source_sha256:sha256,region:null,style:imageJStyle(entry.bytes)});names.push({id,name:parsed.name});}}
 // A file of corrected polygons (Cb, GL+WM and WM parts and holes) is put together again: ML is Cb outside GL+WM, GL is GL+WM outside WM.
 let combined=null;
 // Such a file is known by its part names; an ordinary ROI file, which also holds Cb and GL+WM, is left as it is.
 if(rois.some(r=>/^GL\+WM_part\d+$/.test(r.name))&&rois.some(r=>/^Cb_part\d+$/.test(r.name))&&!rois.some(r=>/^(ML|GL)_TOTAL$/.test(r.name))){
  if(files.length!==1)throw Error('Import one file of corrected polygons at a time.');
  const x=state?.metadata?.um_per_pixel_x,y=state?.metadata?.um_per_pixel_y,calibrated=x>0&&x===y;
  const built=window.EditableROICore.rebuild(rois.map(r=>({name:r.name,kind:r.kind,paths:r.paths})),source.width,source.height,{pl_band_width_um:calibrated?20:0,pixels_per_micron:calibrated?1/x:0}),file=files[0];
  rois.length=0;names.length=0;
  for(const [label,name,paths] of [['CB','Cb',built.rings.CB],['ML','ML_TOTAL',built.rings.ML],['GL','GL_TOTAL',built.rings.GL],['WM','WM',built.rings.WM]]){if(!paths.length)continue;const id='imagej-'+(rois.length+1);rois.push({name,kind:'area',type:'composite',paths,id,label,source_name:'combined from corrected polygons',source_file:file.name,source_sha256:file.sha256,region:null});names.push({id,name});}
  if(built.pl){const id='imagej-'+(rois.length+1);rois.push({name:'PL_TOTAL',kind:'polyline',type:'polyline',paths:[built.pl],id,label:'PL',source_name:'PL_TOTAL.roi',source_file:file.name,source_sha256:file.sha256,region:null});names.push({id,name:'PL_TOTAL'});}
  combined={band:calibrated,how:built.how};
 }
 const next=C.createFromROIs(rois,source,{kind:'imagej',files:files.map(f=>({name:f.name,sha256:f.sha256,size:f.bytes.length})),names}),bytes=new TextEncoder().encode(JSON.stringify(next.original_prediction));if(token!==generation)return;const candidate={kind:'review',name:'imagej-roi-input.json',state:next,bytes,evidenceFiles:files};if(state||dirty.size||failedRaster){stageReplacement(candidate);status('New ImageJ files are ready. Accept the replacement or keep the current review.','draft');}else{installReview(next,bytes,candidate.name,files);status('ImageJ ROIs loaded as a draft. Verify alignment, geometry types and labels before approval.','draft');}$('analysisCoordinatesChecked').checked=false;lastCombined=combined;if(combined)status(combined.band?'Corrected polygons were combined into CB, ML, GL and WM, and the 20 µm Purkinje band was taken out of ML. Verify alignment and labels before approval.':'Corrected polygons were combined into CB, ML, GL and WM. The Purkinje band was not taken out of ML because the pixel size is not set. Verify alignment and labels before approval.','draft');
 }catch(error){status(error.message+' Previous review retained.','error');syncAttachmentPickers();}finally{if(token===generation)setBusy(false);}
});
async function clearSelection(image=false){if(!source||busy)return;setBusy(true);try{await preserveCurrent();generation++;discardReplacement();state=null;predictionBytes=null;predictionName='';resultModelFile=null;evidenceFiles=[];drawing=null;measurementCSVFile=null;predictionSelectionFile=null;reviewDraftFile=null;$('analysisCSVFile').value='';dirty.clear();approvalChanged=false;selected='';$('analysisPrediction').value='';$('analysisROIImport').value='';$('analysisDraft').value='';$('analysisChecked').checked=false;$('analysisCoordinatesChecked').checked=false;$('analysisROI').replaceChildren();$('analysisContours').replaceChildren();$('analysisDrawing').setAttribute('d','');if(image){if(previewURL)URL.revokeObjectURL(previewURL);previewURL=null;source=null;sourceBytes=null;sourceBlob=null;previewBlob=null;view=null;failedRaster=null;renderFailedRaster();$('analysisImage').value='';$('analysisRaster').removeAttribute('href');$('analysisWorkspace').classList.add('hidden');}else beginSession();syncAttachmentPickers();render();status(image?'Image selection cleared. The previous image and review remain in browser recovery copies.':'Boundary selection cleared. The TIFF and trained model selection are retained; the previous review remains in browser recovery copies.');}catch{status('Clearing paused because the current work could not be saved. Retry recovery saving first.','error');}finally{setBusy(false);}}
$('analysisClearImage').addEventListener('click',()=>clearSelection(true));$('analysisClearReview').addEventListener('click',()=>clearSelection(false));
$('analysisClearPrediction').addEventListener('click',()=>{if(busy)return;predictionSelectionFile=null;syncPicker('analysisPrediction');renderAttachments();controls();queueRecovery();status('Prediction selection cleared. The existing review retains its original prediction evidence.');});
$('analysisClearDraft').addEventListener('click',()=>{if(busy)return;reviewDraftFile=null;syncPicker('analysisDraft');renderAttachments();controls();queueRecovery();status('Draft selection cleared. The existing review and its source evidence are retained.');});
function editReady(){return state&&!busy&&!dirty.size&&!drawing;}
for(const [id,operation]of [['analysisUndo',C.undo],['analysisRedo',C.redo]])$(id).addEventListener('click',()=>{if(editReady())apply(operation,'Edit history restored. Review and approve again.');});
$('analysisRegion').addEventListener('input',()=>markDirty('region'));
$('analysisApplyRegion').addEventListener('click',()=>{if(!state||busy||drawing)return;apply(s=>{const next=C.setRegion(s,selected,$('analysisRegion').value.trim()||null);dirty.delete('region');return next;},'Region saved. Review and approve again.');});
$('analysisApplyLabel').addEventListener('click',()=>{if(editReady())apply(s=>C.setLabel(s,selected,$('analysisNewLabel').value),'Tissue label updated. Review and approve again.');});
$('analysisDeleteROI').addEventListener('click',()=>{if(editReady())apply(s=>C.deleteROI(s,selected,$('analysisDeleteReason').value),'Derived ROI deleted with its reason retained. Undo is available.');});
$('analysisInsertVertex').addEventListener('click',()=>{if(!editReady()||!roi()||geometry(roi())==='point'||geometry(roi())==='polyline'&&vertexIndex===roi().paths[pathIndex].length-1)return;const path=roi().paths[pathIndex],a=path[vertexIndex],b=path[vertexIndex+1]||path[0];apply(s=>C.insertVertex(s,selected,pathIndex,vertexIndex,[(a[0]+b[0])/2,(a[1]+b[1])/2]),'A midpoint vertex was inserted. Select it to refine the boundary.');});
$('analysisDeleteVertex').addEventListener('click',()=>{if(editReady())apply(s=>C.deleteVertex(s,selected,pathIndex,vertexIndex),'Vertex deleted. Review the revised boundary.');});
$('analysisDeleteRing').addEventListener('click',()=>{if(!editReady()||!roi())return;apply(s=>C.replacePaths(s,selected,roi().paths.filter((_,i)=>i!==pathIndex)),'Contour deleted. Original evidence is retained.');});
function startDrawing(mode){if(!editReady()||(mode!=='add'&&!roi()))return;const label=$('analysisNewLabel').value,kind=mode==='add'?labelGeometry(label):geometry(roi());if(mode==='ring'&&kind!=='area')return;if(viewMode()==='original'||viewMode()==='compare')setViewMode('overlay');drawing={mode,id:selected,label,kind,points:[]};$('analysisDrawingHelp').textContent=kind==='point'?'Click each point, then select Finish boundary.':kind==='polyline'?'Click along the open line, then select Finish boundary. At least two vertices are required.':'Click around the boundary, then select Finish boundary. At least three vertices are required.';draw();renderQC();controls();queueRecovery();}
$('analysisDrawROI').addEventListener('click',()=>startDrawing('add'));$('analysisRedraw').addEventListener('click',()=>startDrawing('replace'));$('analysisAddRing').addEventListener('click',()=>startDrawing('ring'));
$('analysisUndoDrawing').addEventListener('click',()=>{if(!drawing||busy)return;drawing.points.pop();renderQC();draw();queueRecovery();});
$('analysisCancelDrawing').addEventListener('click',()=>{drawing=null;render();status('Drawing cancelled. Saved boundaries are unchanged.');});
$('analysisFinishDrawing').addEventListener('click',()=>{if(!drawing||busy)return;const d=drawing;try{let next;if(d.mode==='add'){const id='manual-'+crypto.randomUUID();next=C.addROI(state,{id,label:d.label,kind:drawingGeometry(d),closed:drawingGeometry(d)==='area',paths:[d.points]});selected=id;}else next=C.replacePaths(state,d.id,d.mode==='ring'?[...state.rois.find(r=>r.id===d.id).paths,d.points]:[d.points]);state=next;drawing=null;$('analysisChecked').checked=false;render();status('Boundary saved. Review and approve the revised result.','draft');}catch(error){status(error.message,'error');}});
$('analysisAcknowledgeQC').addEventListener('click',()=>{if(editReady())apply(s=>C.acknowledgeQC(s,$('analysisQCNote').value),'Geometry screening review recorded.');});
function rasterRecords(value){return [{metadata:value.metadata,labels:value.labels},...(value.additionalRasters||[])];}
async function validateFailedRaster(value,expectedSource){
 if(!value?.modelFile||value.modelFile.size>BrowserModelCore.LIMITS.modelBytes)throw Error('Native label-map model evidence does not match.');
 const modelBytes=new Uint8Array(await value.modelFile.arrayBuffer()),modelHash=await ResearchCore.sha256(modelBytes),document=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(modelBytes)),identity=modelDocument(document);
 if(value.additionalRasters!==undefined&&(!Array.isArray(value.additionalRasters)||value.additionalRasters.length<1||value.additionalRasters.length>2))throw Error('Invalid additional native model maps.');
 const maps=rasterRecords(value),heads=maps.map(r=>r.metadata?.head||'primary');
 const expectedHeads=AutoROIModelBundle.heads(document).map(([head])=>head).sort();
 if(maps.length!==expectedHeads.length||[...heads].sort().join(',')!==expectedHeads.join(','))throw Error('All fitted model maps must be retained after bundle contour failure.');
 for(const item of maps){
  const m=item.metadata;if(m?.schema!=='cerebellum-label-map/1'||m.source?.sha256!==expectedSource.sha256||m.source.name!==expectedSource.name||m.source.width!==expectedSource.width||m.source.height!==expectedSource.height||!(item.labels instanceof Blob)||item.labels.size!==m.source.width*m.source.height||!Array.isArray(m.classes)||m.classes.length<2||m.classes.length>18||typeof m.failure!=='string'||!m.failure||m.failure.length>2000)throw Error('Native label-map evidence is invalid.');
  const bytes=new Uint8Array(await item.labels.arrayBuffer());if(await ResearchCore.sha256(bytes)!==m.label_sha256||bytes.some(x=>x>=m.classes.length))throw Error('Native label-map pixels do not match their evidence hash.');
  const model=AutoROIModelBundle.modelForHead(document,m.head);if(modelHash!==m.model?.weights_sha256||identity.id!==m.model.id||identity.version!==m.model.version||JSON.stringify(model.classes)!==JSON.stringify(m.classes))throw Error('Native label-map model evidence does not match.');
 }
}
async function appendRasterMaps(zip,value,prefix=''){
 const entries=[];for(const [index,map]of rasterRecords(value).entries()){const name=index?'labels-'+map.metadata.head+'.uint8':'labels.uint8';zip.file(prefix+name,await map.labels.arrayBuffer());entries.push({...map.metadata,labels_file:prefix+name});}return entries;
}
async function renderFailedRaster(){
 const renderVersion=++rasterRenderVersion;
 $('analysisRasterFailure').hidden=!failedRaster;$('analysisFailedRasterPreview').setAttribute('visibility','hidden');if(!failedRaster)return;
 const converted=state?.original_prediction?.processing?.approximate===true&&state.model?.family==='experimental-unet';$('analysisRasterFailure').classList.toggle('is-converted',converted);{const panel=$('analysisRasterFailure'),workspace=$('analysisWorkspace'),below=workspace.nextElementSibling===panel;if(converted&&!below)workspace.after(panel);else if(!converted&&below)workspace.before(panel);}$('analysisRasterFailureTitle').textContent=ui(converted?'Original model maps are kept with this draft':'Model pixels are available; ROI conversion needs review');
 const current=failedRaster,maps=rasterRecords(current),selector=$('analysisRasterHead');
 if(selector){const chosen=selector.value;selector.replaceChildren(...maps.map(r=>rawOption(r.metadata.head==='cb'?'CB':r.metadata.head==='layers'?'ML · GL · WM':r.metadata.classes.slice(1).join(' · '),r.metadata.head||'primary')));if(maps.some(r=>(r.metadata.head||'primary')===chosen))selector.value=chosen;selector.disabled=busy||maps.length<2;}
 const map=maps.find(r=>(r.metadata.head||'primary')===selector?.value)||maps[0];$('analysisRasterFailureReason').textContent=converted?ui('The draft is an approximate editable version. These maps stay unchanged as evidence.'):map.metadata.failure;
 const labels=new Uint8Array(await map.labels.arrayBuffer());if(failedRaster!==current||renderVersion!==rasterRenderVersion)return;
 let counts=$('analysisRasterCounts');if(!counts){counts=document.createElement('p');counts.id='analysisRasterCounts';counts.className='mini';$('analysisRasterFailureReason').after(counts);}const totals=new Array(map.metadata.classes.length).fill(0);for(const n of labels)totals[n]++;
 counts.replaceChildren(ui('Unreviewed predicted pixels: '),raw(map.metadata.classes.map((name,i)=>name+': '+totals[i].toLocaleString('en-US')).join(' · ')),' ',ui('These are model classifications, not approved tissue measurements.'));
 draw();if(!$('analysisShowFailedRaster').checked)return;
 const {width,height}=map.metadata.source,scale=Math.min(1,1024/Math.max(width,height)),w=Math.max(1,Math.round(width*scale)),h=Math.max(1,Math.round(height*scale)),canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const context=canvas.getContext('2d'),pixels=context.createImageData(w,h),palette=map.metadata.classes.map((_,i)=>{if(i===0)return [0,0,0,0];const shade=Math.round(25+190*(i-1)/Math.max(1,map.metadata.classes.length-2));return [shade,shade,shade,255];});
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const index=labels[Math.min(height-1,Math.floor(y/scale))*width+Math.min(width-1,Math.floor(x/scale))];pixels.data.set(palette[index],4*(y*w+x));}context.putImageData(pixels,0,0);const image=$('analysisFailedRasterPreview');image.setAttribute('href',canvas.toDataURL('image/png'));image.setAttribute('width',width);image.setAttribute('height',height);image.setAttribute('visibility','visible');
}
$('analysisShowFailedRaster').addEventListener('change',renderFailedRaster);$('analysisRasterHead')?.addEventListener('change',renderFailedRaster);$('analysisManualFallback').addEventListener('click',beginManual);
function createRasterCandidates({automatic=false}={}){
 if(!failedRaster||!source||busy||dirty.size||drawing)return;
 const current=failedRaster,currentSource=source,token=++generation;
 const worker=new Worker('./assets/raster_candidate_worker.js');modelWorker=worker;setBusy(true);
 $('analysisCancelModel').hidden=false;$('analysisCancelModel').disabled=false;
 status('Creating editable candidates from preserved model maps…','busy');
 const finish=()=>{worker.terminate();if(modelWorker===worker)modelWorker=null;if(token===generation){$('analysisCancelModel').hidden=true;setBusy(false);}};
 worker.onerror=e=>{if(token===generation)status(e.message+' Previous review retained.','error');finish();};
 worker.onmessage=({data})=>{
  if(token!==generation||failedRaster!==current)return finish();
  if(data.progress){status(ui('Creating editable candidates from preserved model maps…')+' '+data.progress.completed+' / '+data.progress.total,'busy');return;}
  try{
   if(data.error)throw Error(data.error);
   const prediction=data.result,next=C.create(prediction,currentSource),bytes=new TextEncoder().encode(JSON.stringify(prediction));
   const details=prediction.processing.heads.map(h=>h.head+': '+h.candidate.changed_pixels.toLocaleString('en-US')+' / '+(currentSource.width*currentSource.height).toLocaleString('en-US'));
   const small=prediction.processing.heads.reduce((n,h)=>n+(h.candidate.small_piece_count||0),0);
   $('analysisCandidateSummary').replaceChildren(ui('Changed pixels by model map: '),raw(details.join(' · ')),...(small?[' · ',ui('Small separate pieces left out of the draft: '),raw(String(small))]:[]));
   $('analysisShowFailedRaster').checked=false;setViewMode('roi');
   if(state)stageReplacement({kind:'review',name:'approximate-roi-candidates.json',state:next,bytes,resultModelFile:current.modelFile});
   else{installReview(next,bytes,'approximate-roi-candidates.json',[],current.modelFile);renderFailedRaster();queueRecovery();status('Editable candidates are ready. Original maps are retained; review the changed boundaries before approval.','draft');}
  }catch(error){status(error.message+' Previous review retained.','error');}
  finish();
 };
 // A U-Net map is smooth, so its draft can open directly; approval and every edit stay with the researcher.
 const smooth=automatic||trainedModelInfo?.family==='experimental-unet';
 worker.postMessage({source:currentSource,maps:rasterRecords(current),modelFile:current.modelFile,reference:current.metadata,blockSize:Number($('analysisCandidateBlock').value),...(automatic?{blockSizes:[8,16,32]}:{}),...(smooth?{minimumRegionPixels:4096,sharedTissueGrid:true}:{}),includePL:$('analysisIncludePL').checked});
}
$('analysisCreateCandidates').addEventListener('click',()=>createRasterCandidates());
$('analysisDownloadFailedRaster').addEventListener('click',async()=>{if(!failedRaster||busy)return;setBusy(true);try{await validateFailedRaster(failedRaster,source);await libraries();const zip=new JSZip(),maps=await appendRasterMaps(zip,failedRaster);zip.file('model.json',await failedRaster.modelFile.arrayBuffer());zip.file('source.tif',sourceBytes);zip.file('label-map.json',JSON.stringify({...failedRaster.metadata,files:{labels:'labels.uint8',model:'model.json',source:'source.tif'},maps,preview:'The on-screen nearest-neighbour preview is reduced; every retained map contains one class index per original-resolution pixel.'},null,2));save('cerebellum-unreviewed-label-map.zip',await zip.generateAsync({type:'uint8array',compression:'DEFLATE'}),'application/zip');status('Label-map archive download requested. No approved measurements were generated.');}catch(error){status(error.message,'error');}finally{setBusy(false);}});

function syncCSVPicker(){try{const files=new DataTransfer();if(measurementCSVFile)files.items.add(measurementCSVFile);$('analysisCSVFile').files=files.files;}catch{$('analysisCSVFile').value='';}}
function renderCSV(){
 syncCSVPicker();const reference=state?.measurement_reference,host=$('analysisCSVPreview');host.replaceChildren();if(!reference){$('analysisCSVStatus').textContent='No source measurement CSV attached.';return;}
 const comparison=AnalysisCSVCore.compare(reference,state,C.measure),compared=comparison.filter(r=>r.status==='compared').length;$('analysisCSVStatus').replaceChildren(raw(reference.file.name),' · '+reference.rows.length+' source rows · '+compared+' compared. Empty cells remain empty. Unmatched, ambiguous or uncalibrated rows are not inferred.');
 const shown=reference.rows.slice(0,100),width=Math.max(reference.headers.length,...shown.map(row=>row.length)),table=document.createElement('table'),head=document.createElement('tr');for(const text of [...Array.from({length:width},(_,i)=>reference.headers[i]??''),'ROI comparison']){const th=document.createElement('th');th.append(raw(text));head.append(th);}table.append(head);
 shown.forEach((row,i)=>{const tr=document.createElement('tr');for(let column=0;column<width;column++){const td=document.createElement('td');if(column<row.length)td.append(raw(row[column]));tr.append(td);}const td=document.createElement('td'),r=comparison[i],statusText={compared:'Compared',unmatched:'No exact ROI match',ambiguous:'Ambiguous ROI match',excluded:'Excluded ROI',no_explicit_units:'Units not explicit',missing_or_uncalibrated:'Missing values or calibration'}[r.status];td.append(statusText,' ',raw((r.roi_id?' · '+r.roi_id:'')+r.values.filter(v=>v.difference!==null).map(v=>' · '+v.header+': '+format(v.source_numeric)+' / '+format(v.reviewed_value)+' / '+format(v.difference)+' '+v.unit).join('')));tr.append(td);table.append(tr);});host.append(table);if(reference.rows.length>100){const note=document.createElement('p');note.textContent='Preview shows the first 100 rows. All source rows are retained in the draft and evidence archive.';host.append(note);}
}
async function verifyCSV(next,file){const ref=next.measurement_reference;if(!ref)return;if(!file||file.name!==ref.file.name||file.size!==ref.file.size||await ResearchCore.sha256(new Uint8Array(await file.arrayBuffer()))!==ref.file.sha256)throw Error('Original measurement CSV bytes are missing or changed.');const parsed=AnalysisCSVCore.parse(new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer()),ref.file);if(JSON.stringify(parsed)!==JSON.stringify(ref))throw Error('Source CSV cells do not match their original bytes.');}
async function changeCSV(file){if(!state||busy||drawing)return;setBusy(true);try{let reference=null;if(file){if(file.size>AnalysisCSVCore.LIMITS.bytes)throw Error('Measurement CSV exceeds 2 MiB.');reference=AnalysisCSVCore.parse(new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer()),{name:file.name,size:file.size,sha256:await ResearchCore.sha256(new Uint8Array(await file.arrayBuffer()))});}const next=C.attachMeasurementCSV(state,reference);await preserveCurrent();beginSession();state=next;measurementCSVFile=file||null;if(!file)$('analysisCSVFile').value='';$('analysisChecked').checked=false;render();status('CSV reference updated. Original geometry and calibration are unchanged; review and approve again.','draft');}catch(error){syncCSVPicker();status(error.message+' Previous review and CSV retained.','error');}finally{setBusy(false);}}
$('analysisCSVFile').addEventListener('change',e=>{if(e.target.files[0])changeCSV(e.target.files[0]);});$('analysisClearCSV').addEventListener('click',()=>changeCSV(null));
const svg=$('analysisCanvas');function pointAt(e){const matrix=svg.getScreenCTM();if(!matrix)throw Error('Image preview is not visible.');const p=new DOMPoint(e.clientX,e.clientY).matrixTransform(matrix.inverse()),shift=compareShift();return[shift&&p.x>=view.x+shift-view.w*.01?p.x-shift:p.x,p.y];}
svg.addEventListener('pointerdown',e=>{if(!source||busy||e.button!==0)return;if(drawing){const p=pointAt(e);if(p[0]<0||p[1]<0||p[0]>source.width||p[1]>source.height)return;if(drawing.points.length>=(C.LIMITS.drawnVertices||5000)){status('The drawn contour reached 5000 vertices. Finish or cancel the boundary.','error');return;}drawing.points.push(p);$('analysisUndoDrawing').disabled=false;$('analysisDrawingHelp').textContent=drawing.points.length+' vertices · finish to save the boundary';draw();queueRecovery();return;}const point=pointAt(e),matrix=svg.getScreenCTM(),threshold=14/Math.max(Math.hypot(matrix.a,matrix.b),.000001);let nearest=null,distance=threshold;if(state&&!dirty.size&&$('analysisOverlay').checked){roi()?.paths.forEach((path,p)=>path.forEach((v,i)=>{const d=Math.hypot(v[0]-point[0],v[1]-point[1]);if(d<distance){distance=d;nearest={p,i,point:v.slice()};}}));}if(nearest){pathIndex=nearest.p;vertexIndex=nearest.i;editor();drag={mode:'vertex',point:nearest.point,start:point};dirty.add('vertex');controls();}else drag={mode:'pan',start:point,view:{...view},target:e.target.dataset.roi||null,client:[e.clientX,e.clientY]};svg.setPointerCapture(e.pointerId);});
svg.addEventListener('pointermove',e=>{if(!drag)return;const point=pointAt(e);if(drag.mode==='vertex'){drag.point=[Math.max(0,Math.min(source.width,point[0])),Math.max(0,Math.min(source.height,point[1]))];marker(drag.point);}else{view.x+=drag.start[0]-point[0];view.y+=drag.start[1]-point[1];draw();}});
function finishDrag(e,cancelled=false){if(!drag)return;const current=drag;drag=null;if(current.mode==='vertex'){if(cancelled){dirty.delete('vertex');editor();controls();draw();return;}apply(s=>{const next=C.editVertex(s,selected,pathIndex,vertexIndex,current.point);dirty.delete('vertex');return next;},'Dragged vertex saved. Review and approve the revised boundary.');draw();}else if(!cancelled&&current.target&&Math.hypot(e.clientX-current.client[0],e.clientY-current.client[1])<4&&canChangeSelection()){selected=current.target;pathIndex=vertexIndex=0;dirty.delete('vertex');dirty.delete('exclusion');render();}if(svg.hasPointerCapture(e.pointerId))svg.releasePointerCapture(e.pointerId);}
svg.addEventListener('pointerup',e=>finishDrag(e));svg.addEventListener('pointercancel',e=>finishDrag(e,true));
svg.addEventListener('keydown',e=>{if(!view)return;const movement={ArrowLeft:[-.1,0],ArrowRight:[.1,0],ArrowUp:[0,-.1],ArrowDown:[0,.1]}[e.key];if(movement){e.preventDefault();view.x+=movement[0]*view.w;view.y+=movement[1]*view.h;draw();}else if(e.key==='+'||e.key==='='){e.preventDefault();zoom(.8);}else if(e.key==='-'){e.preventDefault();zoom(1.25);}else if(e.key==='0'){e.preventDefault();fit();}});
window.addEventListener('resize',()=>marker(selectedPoint()));
window.addEventListener('cerebellum-locale-change',()=>{if(state){$('analysisROI').replaceChildren(...state.rois.map(r=>rawOption(roiName(r)+' · '+ui(geometryName(r))+' · '+r.label+(r.region?' · '+r.region:'')+(r.included?'':' · '+ui('excluded')),r.id)));$('analysisROI').value=selected;}});
// Unified workspace backup adapter. Preparation is read-only; imported approvals
// are always moved to history. Binary evidence is content-addressed, not base64.
const BACKUP_SCHEMA='cerebellum-analysis-workspace/1',preparedBackups=new WeakSet();
function currentRecoveryCandidate(){
 if(!source)return null;
 const record=recoveryRecord();return {...record,kind:'restore',name:source.name,bytes:sourceBytes,predictionBytes,modelInfo:trainedModelInfo,evidenceFiles:evidenceFiles.map(f=>({...f})),selection:{selected,pathIndex,vertexIndex},view:view?{...view}:null};
}
function resetWorkspaceDirect(){
 generation++;clearTimeout(saveTimer);if(previewURL)URL.revokeObjectURL(previewURL);previewURL=null;state=null;source=null;sourceBytes=null;sourceBlob=null;previewBlob=null;predictionBytes=null;predictionName='';resultModelFile=null;measurementCSVFile=null;predictionSelectionFile=null;reviewDraftFile=null;evidenceFiles=[];drawing=null;failedRaster=null;dirty.clear();approvalChanged=false;selected='';pathIndex=vertexIndex=0;view=null;sessionId=null;sessionRevision=0;changeVersion=savedVersion=0;recoveryError=null;resetModelSelection();discardReplacement();
 for(const id of ['analysisImage','analysisPrediction','analysisROIImport','analysisDraft','analysisCSVFile'])$(id).value='';
 $('analysisRaster').removeAttribute('href');$('analysisContours').replaceChildren();$('analysisDrawing').setAttribute('d','');$('analysisWorkspace').classList.add('hidden');$('analysisChecked').checked=false;$('analysisCoordinatesChecked').checked=false;renderFailedRaster();render();
}
async function exportWorkspaceBackup(){
 if(busy)throw Error('Wait for image analysis to finish before backing up the workspace.');
 if(!source)return {document:{schema:BACKUP_SCHEMA,empty:true},binaries:new Map(),included:[],missing:trainedModelFile?['A model selection without an image is not an active image analysis.']:[]};
 setBusy(true);
 try{
  const record=recoveryRecord(),binaries=new Map();
  async function add(blob,name){if(!blob)return null;const sha256=await ResearchCore.sha256(new Uint8Array(await blob.arrayBuffer())),original_ref='originals/'+sha256;binaries.set(original_ref,blob);return {name:name||blob.name||'evidence.bin',size:blob.size,sha256,original_ref};}
  const document={schema:BACKUP_SCHEMA,empty:false,source:clone(record.source),state:record.state,fields:record.fields,dirty:record.dirty,approvalChanged:record.approvalChanged,selection:record.selection,viewMode:record.viewMode,drawing:record.drawing,predictionName:record.predictionName,
   source_file:await add(record.sourceBlob,record.source.name),preview_file:await add(record.previewBlob,'preview.png'),prediction_file:await add(record.predictionBlob,record.predictionName),active_model_file:await add(record.modelFile),result_model_file:await add(record.resultModelFile),measurement_csv_file:await add(record.measurementCSVFile),prediction_selection_file:await add(record.predictionSelectionFile),review_draft_file:await add(record.reviewDraftFile),roi_files:[],failed_raster:null};
  for(const f of record.evidenceFiles)document.roi_files.push(await add(f.blob,f.name));
  if(record.failedRaster){document.failed_raster={metadata:clone(record.failedRaster.metadata),labels_file:await add(record.failedRaster.labels,'labels.uint8'),model_file:await add(record.failedRaster.modelFile)};if(record.failedRaster.additionalRasters)document.failed_raster.additional_rasters=await Promise.all(record.failedRaster.additionalRasters.map(async r=>({metadata:clone(r.metadata),labels_file:await add(r.labels,'labels-'+r.metadata.head+'.uint8')})));}
  return {document,binaries,included:['Current source TIFF, ROI/prediction evidence, review history and pending fields','Original model/CSV files and recoverable native label maps when present'],missing:pendingReplacement?['The staged, unaccepted replacement is not part of the active review backup.']:[]};
 }finally{setBusy(false);}
}
async function prepareWorkspaceBackup(document,binaries){
 if(!document||document.schema!==BACKUP_SCHEMA||typeof document.empty!=='boolean'||!(binaries instanceof Map))throw Error('Unsupported image-analysis workspace backup.');
 if(document.empty){const prepared=Object.freeze({empty:true});preparedBackups.add(prepared);return prepared;}
 if(document.viewMode!==undefined&&!viewModes.includes(document.viewMode))throw Error('Invalid saved image display mode.');
 async function get(ref,max){
  if(!ref)return null;
  if(typeof ref.name!=='string'||!ref.name||ref.name.length>1024||!Number.isSafeInteger(ref.size)||ref.size<1||ref.size>max||!/^[a-f0-9]{64}$/.test(ref.sha256)||ref.original_ref!=='originals/'+ref.sha256)throw Error('Invalid image-analysis backup binary reference.');
  const blob=binaries.get(ref.original_ref);if(!(blob instanceof Blob)||blob.size!==ref.size||await ResearchCore.sha256(new Uint8Array(await blob.arrayBuffer()))!==ref.sha256)throw Error('Image-analysis backup binary evidence is missing or changed.');
  return new File([blob],ref.name,{type:blob.type});
 }
 const original=await get(document.source_file,ResearchImage.LIMITS.fileBytes);if(!original||document.source?.name!==original.name)throw Error('Image-analysis backup source identity is missing.');
 await get(document.preview_file,32*1024*1024);if(typeof document.predictionName!=='string'||document.predictionName.length>1024||document.prediction_file&&document.predictionName!==document.prediction_file.name)throw Error('Invalid prediction filename in workspace backup.');
 const candidate=await prepareImage(original,undefined,true);if(candidate.source.sha256!==document.source.sha256||candidate.source.width!==document.source.width||candidate.source.height!==document.source.height)throw Error('Image-analysis backup TIFF identity does not match.');
 const predictionFile=await get(document.prediction_file,48*1024*1024),bytes=predictionFile?new Uint8Array(await predictionFile.arrayBuffer()):null;
 if(document.state&&(!bytes||JSON.stringify(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)))!==JSON.stringify(document.state.original_prediction)))throw Error('Image-analysis backup prediction evidence does not match.');
 const next=document.state?C.importDraft(document.state,candidate.source):null,originalFiles=[];
 const selectedPrediction=await get(document.prediction_selection_file,8*1024*1024),selectedDraft=await get(document.review_draft_file,48*1024*1024);await verifySelectedFiles(next,bytes,selectedPrediction,selectedDraft);
 if(!Array.isArray(document.roi_files)||document.roi_files.length>64)throw Error('Invalid backup ROI file list.');
 let total=0;for(const ref of document.roi_files){const file=await get(ref,16*1024*1024);total+=file.size;if(total>16*1024*1024)throw Error('Backup ROI evidence exceeds 16 MiB.');originalFiles.push({name:file.name,sha256:ref.sha256,bytes:new Uint8Array(await file.arrayBuffer())});}
 const modelFile=await get(document.active_model_file,BrowserModelCore.LIMITS.modelBytes),resultFile=await get(document.result_model_file,BrowserModelCore.LIMITS.modelBytes);let modelInfo=null;
 if(modelFile){const model=modelDocument(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await modelFile.arrayBuffer())));modelInfo=modelInfoFor(model);}
 await verifyEvidence(next,originalFiles,resultFile);
 const csvFile=await get(document.measurement_csv_file,AnalysisCSVCore.LIMITS.bytes);if(next?.measurement_reference)await verifyCSV(next,csvFile);
 let raster=null;if(document.failed_raster){raster={metadata:clone(document.failed_raster.metadata),labels:await get(document.failed_raster.labels_file,BrowserModelCore.LIMITS.nativePixels||BrowserModelCore.LIMITS.pixels),modelFile:await get(document.failed_raster.model_file,BrowserModelCore.LIMITS.modelBytes)};if(document.failed_raster.additional_rasters!==undefined){if(!Array.isArray(document.failed_raster.additional_rasters)||(document.failed_raster.additional_rasters.length<1||document.failed_raster.additional_rasters.length>2))throw Error('Invalid additional native model maps.');raster.additionalRasters=await Promise.all(document.failed_raster.additional_rasters.map(async r=>({metadata:clone(r.metadata),labels:await get(r.labels_file,BrowserModelCore.LIMITS.nativePixels||BrowserModelCore.LIMITS.pixels)})));}await validateFailedRaster(raster,candidate.source);}
 const fields=document.fields;if(!fields||typeof fields!=='object'||Array.isArray(fields)||Object.entries(fields).some(([key,value])=>!fieldIds.includes(key)||!['string','boolean'].includes(typeof value)||typeof value==='string'&&value.length>10000))throw Error('Invalid pending review fields in workspace backup.');
 if(!Array.isArray(document.dirty)||document.dirty.some(k=>!['vertex','exclusion','metadata','region'].includes(k)))throw Error('Invalid pending-field groups in workspace backup.');
 const selection=document.selection;if(!selection||typeof selection.selected!=='string'||selection.selected.length>80||!Number.isSafeInteger(selection.pathIndex)||selection.pathIndex<0||selection.pathIndex>=C.LIMITS.rings||!Number.isSafeInteger(selection.vertexIndex)||selection.vertexIndex<0||selection.vertexIndex>=C.LIMITS.verticesPerROI)throw Error('Invalid review selection in workspace backup.');
 const selectedROI=next?.rois.find(r=>r.id===selection.selected);if(selectedROI&&(selection.pathIndex>=selectedROI.paths.length||selection.vertexIndex>=selectedROI.paths[selection.pathIndex].length))throw Error('Invalid review selection in workspace backup.');
 const drawing=document.drawing;if(drawing&&(!next||!['add','replace','ring'].includes(drawing.mode)||drawing.kind!==undefined&&!['area','polyline','point'].includes(drawing.kind)||!Array.isArray(drawing.points)||drawing.points.length>5000||drawing.points.some(p=>!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||p[0]<0||p[1]<0||p[0]>candidate.source.width||p[1]>candidate.source.height)||![...C.LABELS,'UNASSIGNED'].includes(drawing.label)||drawing.mode!=='add'&&!next.rois.some(r=>r.id===drawing.id)))throw Error('Invalid pending drawing in workspace backup.');
 if(drawing&&drawing.kind!==undefined&&(drawing.kind!==(drawing.mode==='add'?labelGeometry(drawing.label):geometry(next.rois.find(r=>r.id===drawing.id)))||drawing.mode==='ring'&&drawing.kind!=='area'))throw Error('Invalid pending drawing in workspace backup.');
 Object.assign(candidate,{kind:'restore',state:next,predictionBytes:bytes,predictionName:document.predictionName,fields:clone(fields),dirty:[...document.dirty],selection:clone(selection),viewMode:document.viewMode,drawing:drawing?clone(drawing):null,modelFile,modelInfo,resultModelFile:resultFile,measurementCSVFile:csvFile,evidenceFiles:originalFiles,failedRaster:raster,predictionSelectionFile:selectedPrediction,reviewDraftFile:selectedDraft});
 const prepared=Object.freeze({empty:false,candidate});preparedBackups.add(prepared);return prepared;
}
async function checkpointWorkspaceBackup(){
 if(busy)throw Error('Wait for image analysis to finish before replacing the workspace.');
 await preserveCurrent();const prior=currentRecoveryCandidate(),priorApprovalChanged=approvalChanged,priorReplacement=pendingReplacement,priorModel=trainedModelFile,priorModelInfo=trainedModelInfo,ui=Object.fromEntries(['analysisChecked','analysisCoordinatesChecked','analysisOverlay','analysisViewMode','analysisAutoGenerate','analysisShowFailedRaster','analysisNewLabel'].map(id=>[id,$(id).type==='checkbox'?$(id).checked:$(id).value]));
 return {rollback:async()=>{
  if(prior){installCandidate(prior);approvalChanged=priorApprovalChanged;if(prior.view){view={...prior.view};draw();}if(priorReplacement)stageReplacement(priorReplacement);controls();queueRecovery();await flushRecovery();status('Previous image analysis restored after an incomplete workspace import.');}
  else{resetWorkspaceDirect();trainedModelFile=priorModel;trainedModelInfo=priorModelInfo;if(priorModel){restoreModelDetails(priorModel);$('analysisModelInfo').replaceChildren(raw(priorModelInfo.id),' · ',raw(priorModel.name));const files=new DataTransfer();files.items.add(priorModel);$('analysisModel').files=files.files;}controls();}
  for(const[id,value]of Object.entries(ui)){if($(id).type==='checkbox')$(id).checked=value;else $(id).value=value;}draw();renderFailedRaster();controls();
 }};
}
async function commitWorkspaceBackup(prepared){
 if(!preparedBackups.has(prepared))throw Error('Prepare and validate the image-analysis backup before restoring it.');
 if(prepared.empty){resetWorkspaceDirect();return;}
 discardReplacement();installCandidate(prepared.candidate);await flushRecovery();
}
const workspaceBackup=Object.freeze({export:exportWorkspaceBackup,prepare:prepareWorkspaceBackup,checkpoint:checkpointWorkspaceBackup,commit:commitWorkspaceBackup,hasWork:()=>!!source});

window.CerebellumAnalysis=Object.freeze({lastCombined:()=>lastCombined?clone(lastCombined):null,automationState,backup:workspaceBackup,snapshot:()=>state?clone(state):null,recoveryState:()=>({sessionId,revision:sessionRevision,changeVersion,savedVersion,error:recoveryError})});controls();refreshRecoveryList();restoreRememberedModel();
})();
