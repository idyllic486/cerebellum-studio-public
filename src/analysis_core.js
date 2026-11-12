/* Single-section prediction review. Geometry validity is not anatomical validation.
 * Source predictions are immutable evidence; approved measurements use Float32
 * polygon coordinates, matching ImageJ ShapeRoi export without hidden rounding.
 */
(function (root) {
  'use strict';
  const SCHEMA = 'cerebellum-analysis/2', LEGACY_SCHEMA='cerebellum-analysis/1', INPUT_SCHEMA='cerebellum-roi-input/1', PREDICTION_SCHEMA = 'cerebellum-prediction/1';
  const LIMITS = Object.freeze({rois:64, rings:128, verticesPerROI:200000, vertices:500000, drawnVertices:5000, imagePixels:80000000, imageDimension:32767, history:1000, jsonBytes:48*1024*1024,predictionBytes:8*1024*1024,undoSteps:20,undoBytes:8*1024*1024});
  const AREA_LABELS = Object.freeze(['CB','ML','GL','WM']);
  const LOBULE_REGIONS = Object.freeze(['2Cb','3Cb','4-5Cb','6Cb','7Cb','8Cb','9Cb','10Cb','Sim','Crus1','Crus2','PM','Cop','Fl','FI','PFl','PFI']);
  const LABELS = Object.freeze([...AREA_LABELS,'PL','FISSURE','LANDMARK','OTHER']);
  const kindOf = roi => roi.kind??'area';
  function boundsOf(points){const bounds={x:Infinity,y:Infinity,right:-Infinity,bottom:-Infinity};for(const p of points){bounds.x=Math.min(bounds.x,p[0]);bounds.y=Math.min(bounds.y,p[1]);bounds.right=Math.max(bounds.right,p[0]);bounds.bottom=Math.max(bounds.bottom,p[1]);}return {...bounds,width:bounds.right-bounds.x,height:bounds.bottom-bounds.y};}
  function originalEllipse(roi){const b=roi.metadata?.bounds,p=roi.paths[0];return kindOf(roi)==='area'&&roi.type==='oval'&&roi.paths.length===1&&p.length===128&&b&&[b.x,b.y,b.width,b.height].every(finite)&&b.width>0&&b.height>0&&p.every((q,i)=>{const angle=i*2*Math.PI/128;return q[0]===Math.fround(b.x+b.width/2*(1+Math.cos(angle)))&&q[1]===Math.fround(b.y+b.height/2*(1+Math.sin(angle)));})?b:null;}
  const fail = message => { throw Error(message); };
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  function csvCore(){return root.AnalysisCSVCore||(typeof require==='function'?require('./analysis_csv_core.js'):null);}
  const clone = value => JSON.parse(JSON.stringify(value));
  function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
  function object(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(name+' must be an object.'); }
  function text(value, name, max=200, empty=false) { if(typeof value!=='string'||value.length>max||(!empty&&!value.trim()))fail('Invalid '+name+'.'); return value; }
  function digest(value,name) { if(typeof value!=='string'||! /^[a-f0-9]{64}$/.test(value))fail('Invalid SHA-256 for '+name+'.'); return value; }
  function boundedJSON(value) { let serialized; try { serialized=JSON.stringify(value); } catch (_) { fail('Invalid JSON data.'); } if(!serialized||new TextEncoder().encode(serialized).length>LIMITS.jsonBytes)fail('Analysis JSON exceeds 48 MiB. Keep a full workspace backup before starting another record.'); return clone(value); }
  function sourceInfo(source) {
    object(source,'Source'); digest(source.sha256,'source image'); text(source.name,'source filename',1024);
    if(!Number.isInteger(source.width)||!Number.isInteger(source.height)||source.width<1||source.height<1||source.width>LIMITS.imageDimension||source.height>LIMITS.imageDimension||source.width*source.height>LIMITS.imagePixels)fail('Image dimensions exceed the review limits (32767 per axis, 80 million pixels).');
    return {sha256:source.sha256,width:source.width,height:source.height,name:source.name};
  }
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const same=(a,b)=>a[0]===b[0]&&a[1]===b[1];
  function onSegment(a,b,p) { return cross(a,b,p)===0&&p[0]>=Math.min(a[0],b[0])&&p[0]<=Math.max(a[0],b[0])&&p[1]>=Math.min(a[1],b[1])&&p[1]<=Math.max(a[1],b[1]); }
  function intersect(a,b,c,d) {
    const x=cross(a,b,c),y=cross(a,b,d),z=cross(c,d,a),w=cross(c,d,b);
    return ((x>0&&y<0||x<0&&y>0)&&(z>0&&w<0||z<0&&w>0))||(!x&&onSegment(a,b,c))||(!y&&onSegment(a,b,d))||(!z&&onSegment(c,d,a))||(!w&&onSegment(c,d,b));
  }
  function inside(point,path) { let found=false; for(let i=0,j=path.length-1;i<path.length;j=i++) {const a=path[i],b=path[j]; if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])found=!found;}return found; }
  function signedArea(path) { let sum=0; const origin=path[0]; for(let i=1;i<path.length-1;i++)sum+=cross(origin,path[i],path[i+1]);return sum/2; }
  // ImageJ ShapeRoi paths can touch, retrace or intersect. Integrate their
  // even-odd interior without changing a single supplied vertex. Between all
  // vertex/intersection x coordinates, paired edge heights are linear, so their
  // midpoint integral is exact up to Float64 arithmetic (not pixel sampling).
  const sourceAreaCache=new WeakMap();
  function sourceArea(paths){
    if(Object.isFrozen(paths)&&sourceAreaCache.has(paths))return sourceAreaCache.get(paths);
    const edges=[],xs=new Set();let perimeter=0;
    for(const path of paths)for(let i=0;i<path.length;i++){const a=path[i],b=path[(i+1)%path.length];perimeter+=Math.hypot(b[0]-a[0],b[1]-a[1]);xs.add(a[0]);if(a[0]===b[0])continue;const lo=a[0]<b[0]?a:b,hi=a[0]<b[0]?b:a;edges.push({lo,hi,minx:lo[0],maxx:hi[0],miny:Math.min(a[1],b[1]),maxy:Math.max(a[1],b[1]),slope:(hi[1]-lo[1])/(hi[0]-lo[0])});}
    edges.sort((a,b)=>a.minx-b.minx);let comparisons=0,intersections=0;
    for(let i=0;i<edges.length;i++)for(let j=i+1;j<edges.length&&edges[j].minx<edges[i].maxx;j++){
      if(++comparisons>50000000)fail('Exact source-area geometry exceeds the intersection budget. Original coordinates were retained; no area was substituted.');
      const a=edges[i],b=edges[j];if(a.maxy<b.miny||b.maxy<a.miny||a.slope===b.slope)continue;
      const x=(b.lo[1]-a.lo[1]+a.slope*a.minx-b.slope*b.minx)/(a.slope-b.slope);
      if(x>Math.max(a.minx,b.minx)&&x<Math.min(a.maxx,b.maxx)){if(++intersections>200000)fail('Exact source-area geometry has too many intersections. No contour was simplified.');xs.add(x);}
    }
    const coordinates=[...xs].sort((a,b)=>a-b),active=new Set();let start=0,area=0,scanWork=0;
    for(let i=0;i+1<coordinates.length;i++){
      const left=coordinates[i],right=coordinates[i+1];if(right<=left)continue;
      for(const edge of active)if(edge.maxx<=left)active.delete(edge);
      while(start<edges.length&&edges[start].minx<=left){if(edges[start].maxx>left)active.add(edges[start]);start++;}
      if((scanWork+=active.size)>50000000)fail('Exact source-area geometry exceeds the scan budget. No reduced-resolution area was substituted.');
      const middle=(left+right)/2,heights=[...active].map(e=>e.lo[1]+e.slope*(middle-e.minx)).sort((a,b)=>a-b);
      if(heights.length%2)fail('Source area has an unmatched even-odd edge crossing.');
      for(let j=0;j<heights.length;j+=2)area+=(heights[j+1]-heights[j])*(right-left);
    }
    const out={area,perimeter};if(Object.isFrozen(paths))sourceAreaCache.set(paths,out);return out;
  }
  function topology(paths) {
    const edges=[];
    paths.forEach((path,p)=>path.forEach((a,i)=>{const b=path[(i+1)%path.length];if(same(a,b))fail('ROI has a duplicate consecutive vertex.');edges.push({a,b,p,i,n:path.length,minx:Math.min(a[0],b[0]),maxx:Math.max(a[0],b[0]),miny:Math.min(a[1],b[1]),maxy:Math.max(a[1],b[1])});}));
    edges.sort((a,b)=>a.minx-b.minx);
    for(let i=0;i<edges.length;i++)for(let j=i+1;j<edges.length&&edges[j].minx<=edges[i].maxx;j++) {
      const a=edges[i],b=edges[j];if(a.maxy<b.miny||b.maxy<a.miny)continue;
      const adjacent=a.p===b.p&&(Math.abs(a.i-b.i)===1||Math.abs(a.i-b.i)===a.n-1);
      if(adjacent) {
        const common=same(a.a,b.a)||same(a.a,b.b)?a.a:a.b,otherA=same(common,a.a)?a.b:a.a,otherB=same(common,b.a)?b.b:b.a;
        if(cross(common,otherA,otherB)===0&&((otherA[0]-common[0])*(otherB[0]-common[0])+(otherA[1]-common[1])*(otherB[1]-common[1]))>0)fail('ROI boundary doubles back on itself.');
      } else if(intersect(a.a,a.b,b.a,b.b))fail('ROI rings cross or touch; correct the contour before review.');
    }
    return paths.map((path,i)=>({depth:paths.reduce((n,other,j)=>n+(j!==i&&inside(path[0],other)?1:0),0),signed:signedArea(path)}));
  }
  function normalizeROI(roi,source) {
    object(roi,'ROI'); if(typeof roi.id!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(roi.id))fail('ROI ID must contain 1–80 letters, digits, dots, underscores or hyphens.');
    if(![...LABELS,'UNASSIGNED'].includes(roi.label))fail('Unsupported tissue or landmark label.');
    const kind=kindOf(roi),closed=kind==='area',sourceProfile=roi.geometry_profile==='imagej-evenodd/1';
    if(roi.geometry_profile!==undefined&&(!sourceProfile||!closed))fail('Unsupported ROI geometry profile.');
    if(!['area','polyline','point'].includes(kind)||roi.closed!==undefined&&roi.closed!==closed)fail('ROI kind and closed state disagree.');
    if(!Array.isArray(roi.paths)||!roi.paths.length||roi.paths.length>LIMITS.rings||!closed&&roi.paths.length!==1)fail('Area ROIs require 1–128 rings; lines and points require one coordinate path.');
    const minimum=closed?3:kind==='polyline'?2:1;
    let count=0;
    const paths=roi.paths.map(path=>{
      if(!Array.isArray(path)||path.length<minimum)fail('ROI geometry has too few coordinates for its type.');
      count+=path.length;if(count>LIMITS.verticesPerROI)fail('ROI exceeds 200000 original vertices; no geometry was discarded.');
      if(closed&&!sourceProfile&&count>LIMITS.drawnVertices)fail('Editable area contours without ImageJ source geometry support at most 5000 vertices per ROI.');
      const points=path.map(p=>{if(!Array.isArray(p)||p.length!==2||!p.every(finite)||p[0]<0||p[1]<0||p[0]>source.width||p[1]>source.height)fail('ROI coordinates must lie inside the original image.');return p.map(Math.fround);});
      if(closed&&!sourceProfile&&points.length>3&&same(points[0],points[points.length-1]))points.pop();
      if(closed&&!sourceProfile&&Math.abs(signedArea(points))<=1e-10)fail('ROI ring has zero area.');
      if(kind==='polyline'&&!points.some((p,i)=>i&&!same(p,points[i-1])))fail('An open line must have a nonzero path length.');return points;
    });
    if(closed&&!sourceProfile){const rings=topology(paths);rings.forEach((ring,i)=>{if((ring.signed>0)!==(ring.depth%2===0))paths[i].reverse();});}
    const included=roi.included===undefined?true:roi.included;
    if(typeof included!=='boolean')fail('ROI inclusion must be true or false.');
    const reason=roi.exclusion_reason===undefined?'':text(roi.exclusion_reason,'exclusion reason',2000,true);
    if(!included&&!reason.trim())fail('Excluded ROIs require a reason.');
    if(included&&reason.trim())fail('An included ROI cannot retain an active exclusion reason.');
    // Absent kind retains the exact legacy area representation and fingerprint.
    const out={id:roi.id,label:roi.label,paths,included,exclusion_reason:reason};
    if(roi.kind!==undefined||roi.closed!==undefined){out.kind=kind;out.closed=closed;}
    if(sourceProfile)out.geometry_profile='imagej-evenodd/1';
    for(const key of ['name','source_name','source_file'])if(roi[key]!==undefined)out[key]=text(roi[key],key,1024);
    if(roi.source_sha256!==undefined)out.source_sha256=digest(roi.source_sha256,'ROI source');
    if(roi.type!==undefined){if(!['polygon','rectangle','oval','line','freeline','polyline','freehand','traced','angle','point','composite'].includes(roi.type))fail('Unsupported source ROI type.');out.type=roi.type;}
    if(roi.region!==undefined)out.region=roi.region===null?null:text(roi.region,'source region',200,true);
    if(roi.style!==undefined){object(roi.style,'ROI style');out.style={};for(const[key,value]of Object.entries(roi.style)){if(!['stroke_width_px','stroke_color_argb','fill_color_argb'].includes(key))fail('Unsupported ROI style field.');if(value===undefined)continue;if(value!==null&&(key==='stroke_width_px'?(!finite(value)||value<0||value>10000):(!Number.isInteger(value)||value<0||value>0xffffffff)))fail('Invalid ROI display style.');out.style[key]=value;}}
    if(roi.metadata!==undefined){object(roi.metadata,'ROI source metadata');if(new TextEncoder().encode(JSON.stringify(roi.metadata)).length>16384)fail('ROI source metadata is too large.');out.metadata=clone(roi.metadata);}
    return out;
  }
  function normalizeROIs(rois,source,allowEmpty=false) {
    if(!Array.isArray(rois)||(!allowEmpty&&!rois.length)||rois.length>LIMITS.rois)fail('Prediction requires 1–64 ROIs.');
    const ids=new Set();let count=0;
    return rois.map(roi=>{const out=normalizeROI(roi,source);if(ids.has(out.id))fail('Duplicate ROI ID.');ids.add(out.id);count+=out.paths.reduce((n,p)=>n+p.length,0);if(count>LIMITS.vertices)fail('Review exceeds 500000 original vertices.');return out;});
  }
  function validatePrediction(prediction,source) {
    object(prediction,'Prediction');if(prediction.schema!==PREDICTION_SCHEMA)fail('Unsupported prediction schema.');
    const actual=sourceInfo(source),expected=sourceInfo(prediction.source);
    if(actual.sha256!==expected.sha256||actual.width!==expected.width||actual.height!==expected.height)fail('Prediction source hash or dimensions do not match the loaded image.');
    object(prediction.model,'Model');text(prediction.model.id,'model ID');text(prediction.model.version,'model version');digest(prediction.model.weights_sha256,'model weights');
    const corticalRegion=r=>r.label==='OTHER'&&kindOf(r)==='area'&&LOBULE_REGIONS.includes(r.region)&&r.metadata?.model_class==='LOBULE_'+r.region&&r.metadata?.anatomy_scope==='ML+GL annotated cortical subregions; not whole lobule';
    const plCandidate=r=>r.label==='PL'&&kindOf(r)==='polyline'&&r.closed===false&&r.metadata?.derived_from==='ML–GL interface'&&r.metadata?.candidate_only===true&&r.metadata?.purkinje_identity_established===false&&JSON.stringify(r.metadata?.source_classes)===JSON.stringify(['background','ML','GL','WM']);
    if(prediction.rois?.some(r=>!(AREA_LABELS.includes(r.label)&&kindOf(r)==='area')&&!corticalRegion(r)&&!plCandidate(r)))fail('Prediction labels require supported tissue areas, identified cortical regions or explicit ML–GL interface candidates.');
    if(prediction.rois?.some(r=>r.geometry_profile!==undefined))fail('Model predictions cannot use the imported ImageJ geometry profile.');
    if(new TextEncoder().encode(JSON.stringify(prediction)).length>LIMITS.predictionBytes||prediction.rois?.some(r=>r.paths?.reduce((n,p)=>n+p.length,0)>5000)||prediction.rois?.reduce((n,r)=>n+(r.paths?.reduce((m,p)=>m+p.length,0)||0),0)>30000)fail('Model prediction exceeds its 8 MiB/5000 vertices per ROI/30000 total contract. No predicted components were discarded.');
    return normalizeROIs(prediction.rois,actual);
  }
  const initialMetadata=()=>({animal_id:'',section_id:'',single_section_confirmed:false,um_per_pixel_x:null,um_per_pixel_y:null,z_um:null,thickness_um:null,sampling_interval_um:null});
  function metadataInfo(metadata) {
    object(metadata,'Metadata');const out=initialMetadata();
    for(const key of Object.keys(metadata))if(!Object.hasOwn(out,key))fail('Unsupported metadata field: '+key);
    for(const key of ['animal_id','section_id'])out[key]=text(metadata[key],key,120,true);
    if(typeof metadata.single_section_confirmed!=='boolean')fail('Confirm whether the image contains one section.');out.single_section_confirmed=metadata.single_section_confirmed;
    for(const key of ['um_per_pixel_x','um_per_pixel_y','z_um','thickness_um','sampling_interval_um']) {
      const value=metadata[key];if(value!==null&&(!finite(value)||(key!=='z_um'&&value<=0)||Math.abs(value)>1e9||(key!=='z_um'&&value<1e-9)))fail('Invalid '+key+'; unknown values must remain null.');out[key]=value;
    }return out;
  }
  function initialEditor(){return {past:[],future:[]};}
  function create(prediction,source) {
    const original=boundedJSON(prediction),actual=sourceInfo(source),rois=validatePrediction(original,actual);
    return freeze({schema:SCHEMA,source:actual,model:clone(original.model),original_prediction:original,rois,metadata:initialMetadata(),history:[],approval:null,editor:initialEditor(),qc_acknowledgement:null});
  }
  // Imported boundaries and manual work are evidence, never a fabricated model prediction.
  function createFromROIs(rois,source,{kind='manual',files=[],names=[],reference=null}={}) {
    const actual=sourceInfo(source);if(!['manual','imagej'].includes(kind))fail('Unsupported ROI input origin.');
    const normalized=normalizeROIs(kind==='imagej'?rois.map(r=>kindOf(r)==='area'?{...r,geometry_profile:'imagej-evenodd/1'}:r):rois,actual,true);
    if(kind==='imagej'&&!files.length)fail('ImageJ inputs require original file evidence.');
    const original=boundedJSON({schema:INPUT_SCHEMA,source:actual,origin:kind,files:clone(files),names:clone(names),...(reference?{reference:clone(reference)}:{}),rois:normalized});
    const state={schema:SCHEMA,source:actual,model:null,original_prediction:original,rois:normalized,metadata:initialMetadata(),history:[],approval:null,editor:initialEditor(),qc_acknowledgement:null};
    validateState(state);return freeze(state);
  }
  function validateOriginal(input,source) {
    if(input?.schema===PREDICTION_SCHEMA)return validatePrediction(input,source);
    object(input,'Original ROI input');if(input.schema!==INPUT_SCHEMA||!['manual','imagej'].includes(input.origin))fail('Unsupported original ROI evidence.');
    if(input.reference){const r=input.reference;if(r.schema!=='cerebellum-label-map/1'||r.source?.sha256!==source.sha256)fail('Label-map reference does not match the TIFF.');digest(r.label_sha256,'reference label map');digest(r.model?.weights_sha256,'reference model');}
    if(input.reference&&(input.reference.source.width!==source.width||input.reference.source.height!==source.height))fail('Label-map reference dimensions do not match the TIFF.');
    const actual=sourceInfo(input.source);if(actual.sha256!==source.sha256||actual.width!==source.width||actual.height!==source.height)fail('ROI input source does not match the loaded image.');
    if(!Array.isArray(input.files)||input.files.length>64||!Array.isArray(input.names)||input.names.length>64)fail('Invalid ROI file evidence.');
    input.files.forEach(f=>{text(f.name,'ROI filename',1024);digest(f.sha256,'ROI file');if(!Number.isSafeInteger(f.size)||f.size<1||f.size>64*1024*1024)fail('Invalid ROI file size.');});
    input.names.forEach(n=>{text(n.id,'input ROI ID',80);text(n.name,'source ROI name',1024,true);});
    if(input.origin==='imagej'&&!input.files.length)fail('Missing original ImageJ file evidence.');
    return normalizeROIs(input.rois,source,true);
  }
  function validateState(state) {
    object(state,'Analysis');if(![SCHEMA,LEGACY_SCHEMA].includes(state.schema))fail('Unsupported analysis schema.');const source=sourceInfo(state.source);
    const originals=validateOriginal(state.original_prediction,source),rois=normalizeROIs(state.rois,source,state.schema===SCHEMA);
    if(JSON.stringify(state.model)!==JSON.stringify(state.original_prediction.model??null))fail('Model provenance was changed.');
    if(state.schema===LEGACY_SCHEMA&&(rois.length!==originals.length||rois.some((r,i)=>r.id!==originals[i].id||r.label!==originals[i].label)))fail('Prediction ROI identity or labels were changed.');
    metadataInfo(state.metadata);if(state.measurement_reference)csvCore().validate(state.measurement_reference);
    if(!Array.isArray(state.history)||state.history.length>LIMITS.history)fail('Review history exceeds the supported limit.');
    if(state.history_checkpoints!==undefined){if(!Array.isArray(state.history_checkpoints))fail('Invalid retained history checkpoints.');for(const checkpoint of state.history_checkpoints){object(checkpoint,'History checkpoint');if(!Array.isArray(checkpoint.events)||!checkpoint.events.length||checkpoint.events.length>LIMITS.history||typeof checkpoint.at!=='string')fail('Invalid retained history checkpoint.');}}
    if(state.detached_sources!==undefined){if(!Array.isArray(state.detached_sources)||state.detached_sources.length>64)fail('Invalid detached source list.');const detached=new Set();for(const entry of state.detached_sources){text(entry.name,'detached source filename',1024);digest(entry.sha256,'detached source');const key=entry.name+'|'+entry.sha256;if(detached.has(key)||!state.original_prediction.files?.some(f=>f.name===entry.name&&f.sha256===entry.sha256))fail('Detached source does not match original evidence.');detached.add(key);if(!Array.isArray(entry.roi_ids)||entry.roi_ids.some(id=>typeof id!=='string'||id.length>80)||state.rois.some(r=>entry.roi_ids.includes(r.id)||r.source_file===entry.name&&(!r.source_sha256||r.source_sha256===entry.sha256)))fail('Detached ROI source still has active derived geometry.');}}
    if(JSON.stringify(rois)!==JSON.stringify(state.rois))fail('Analysis geometry is not in canonical Float32 form.');
    if(state.schema===SCHEMA){
      object(state.editor,'Undo history');for(const key of ['past','future']){if(!Array.isArray(state.editor[key])||state.editor[key].length>LIMITS.undoSteps)fail('Invalid undo history.');for(const snapshot of state.editor[key]){metadataInfo(snapshot.metadata);if(JSON.stringify(normalizeROIs(snapshot.rois,source,true))!==JSON.stringify(snapshot.rois))fail('Invalid undo geometry.');}}
      if(new TextEncoder().encode(JSON.stringify(state.editor)).length>LIMITS.undoBytes)fail('Undo history exceeds 8 MiB.');
      if(state.qc_acknowledgement!==null){object(state.qc_acknowledgement,'QC acknowledgement');text(state.qc_acknowledgement.note,'QC review note',2000);if(typeof state.qc_acknowledgement.signature!=='string')fail('Invalid QC acknowledgement.');}
    }return state;
  }
  function upgraded(state){const next=clone(state);if(next.schema===LEGACY_SCHEMA){next.schema=SCHEMA;next.editor=initialEditor();next.qc_acknowledgement=null;}return next;}
  function snapshot(state){return {rois:clone(state.rois),metadata:clone(state.metadata)};}
  function trimEditor(editor){for(const key of ['past','future'])while(editor[key].length>LIMITS.undoSteps)editor[key].shift();while(new TextEncoder().encode(JSON.stringify(editor)).length>LIMITS.undoBytes){if(editor.past.length)editor.past.shift();else if(editor.future.length)editor.future.shift();else break;}}
  function retainHistory(next){
    if(!next.history.length)return;
    const at=new Date().toISOString(),events=next.history;next.history_checkpoints=[...(next.history_checkpoints||[]),{at,events}];
    next.history=[{type:'history_checkpoint',at,detail:{checkpoint_index:next.history_checkpoints.length-1,retained_events:events.length,note:'Earlier events remain intact in history_checkpoints; no event was discarded.'}}];
  }
  function action(state,type,detail,modify,remember=true) {
    validateState(state);
    const next=upgraded(state);if(next.history.length>=LIMITS.history)retainHistory(next);if(remember){next.editor.past.push(snapshot(state));next.editor.future=[];trimEditor(next.editor);}
    modify(next);next.approval=null;next.qc_acknowledgement=null;next.history.push({type,at:new Date().toISOString(),detail:clone(detail)});validateState(next);boundedJSON(next);return freeze(next);
  }
  function checkpointHistory(state){return action(state,'checkpoint_history',{},next=>retainHistory(next),false);}
  function attachMeasurementCSV(state,reference){if(reference)csvCore().validate(reference);return action(state,'set_measurement_reference',{before:state.measurement_reference?.file??null,after:reference?.file??null},next=>{next.measurement_reference=reference?clone(reference):null;},false);}
  function addROI(state,roi){return action(state,'add_roi',{roi:clone(roi)},next=>{next.rois=normalizeROIs([...next.rois,roi],next.source,true);});}
  function deleteROI(state,id,reason){text(reason,'ROI deletion reason',2000);const old=state.rois.find(r=>r.id===id);if(!old)fail('Unknown ROI.');return action(state,'delete_roi',{roi:clone(old),reason},next=>{next.rois=next.rois.filter(r=>r.id!==id);});}
  function setLabel(state,id,label){const old=state.rois.find(r=>r.id===id);if(!old)fail('Unknown ROI.');return action(state,'set_label',{roi_id:id,before:old.label,after:label},next=>{next.rois.find(r=>r.id===id).label=label;next.rois=normalizeROIs(next.rois,next.source,true);});}
  function setRegion(state,id,region){const old=state.rois.find(r=>r.id===id);if(!old)fail('Unknown ROI.');if(region!==null)text(region,'source region',200,true);return action(state,'set_region',{roi_id:id,before:old.region??null,after:region},next=>{next.rois.find(r=>r.id===id).region=region;});}
  function removeSourceFile(state,{name,sha256,roi_ids}={}){
    const expected=state.original_prediction.files?.find(f=>f.name===name&&f.sha256===sha256);if(!expected)fail('Unknown original ROI source file.');
    if(state.detached_sources?.some(f=>f.name===name&&f.sha256===sha256))fail('This ROI source file is already detached.');
    const inferred=[...new Set([...state.rois,...state.original_prediction.rois].filter(r=>r.source_file===name&&(!r.source_sha256||r.source_sha256===sha256)).map(r=>r.id))];
    const ids=roi_ids??inferred;if(!Array.isArray(ids)||!ids.length||ids.some(id=>!state.rois.some(r=>r.id===id)&&!state.original_prediction.rois.some(r=>r.id===id))||new Set(ids).size!==ids.length)fail('Identify the derived ROIs belonging to the source file before detaching it.');
    if(inferred.some(id=>!ids.includes(id)))fail('Detach all ROIs associated with this source file together.');
    if(ids.some(id=>{const r=state.rois.find(r=>r.id===id)||state.original_prediction.rois.find(r=>r.id===id);return r.source_file&&r.source_file!==name||r.source_sha256&&r.source_sha256!==sha256;}))fail('ROI attachment identity does not match the requested source.');
    return action(state,'detach_roi_source',{file:clone(expected),roi_ids:ids,note:'Original input metadata and geometry remain immutable evidence. Original bytes and prior edits can be restored from the preceding recovery copy.'},next=>{next.rois=next.rois.filter(r=>!ids.includes(r.id));next.detached_sources=[...(next.detached_sources||[]),{name,sha256,roi_ids:[...ids]}];next.editor=initialEditor();},false);
  }
  function insertVertex(state,id,p,index,point){const r=state.rois.find(r=>r.id===id);if(!r?.paths[p]||!Number.isInteger(index)||index<0||index>=r.paths[p].length)fail('Unknown ROI vertex.');return action(state,'insert_vertex',{roi_id:id,path_index:p,after_vertex:index,point},next=>{next.rois.find(r=>r.id===id).paths[p].splice(index+1,0,point);next.rois=normalizeROIs(next.rois,next.source,true);});}
  function deleteVertex(state,id,p,index){const r=state.rois.find(r=>r.id===id),minimum=kindOf(r||{})==='area'?3:kindOf(r||{})==='polyline'?2:1;if(!r?.paths[p]?.[index]||r.paths[p].length<=minimum)fail('Retain the minimum coordinates required by this ROI type.');return action(state,'delete_vertex',{roi_id:id,path_index:p,vertex_index:index,before:r.paths[p][index]},next=>{next.rois.find(r=>r.id===id).paths[p].splice(index,1);next.rois=normalizeROIs(next.rois,next.source,true);});}
  function replacePaths(state,id,paths){const r=state.rois.find(r=>r.id===id);if(!r)fail('Unknown ROI.');return action(state,'replace_boundary',{roi_id:id,before:r.paths,after:paths},next=>{next.rois.find(r=>r.id===id).paths=clone(paths);next.rois=normalizeROIs(next.rois,next.source,true);});}
  function travel(state,direction){const from=direction==='undo'?'past':'future',to=direction==='undo'?'future':'past';if(!state.editor?.[from]?.length)fail('No edit to '+direction+'.');return action(state,direction,{},next=>{const value=next.editor[from].pop();next.editor[to].push(snapshot(state));next.rois=value.rois;next.metadata=value.metadata;trimEditor(next.editor);},false);}
  const undo=state=>travel(state,'undo'),redo=state=>travel(state,'redo');
  function editVertex(state,id,pathIndex,vertexIndex,point) {
    const roi=state.rois.find(r=>r.id===id);if(!roi||!Number.isInteger(pathIndex)||!Number.isInteger(vertexIndex)||!roi.paths[pathIndex]||!roi.paths[pathIndex][vertexIndex])fail('Unknown ROI vertex.');
    return action(state,'edit_vertex',{roi_id:id,path_index:pathIndex,vertex_index:vertexIndex,before:roi.paths[pathIndex][vertexIndex],after:point},next=>{
      const target=next.rois.find(r=>r.id===id);target.paths[pathIndex][vertexIndex]=point;next.rois=normalizeROIs(next.rois,next.source);
    });
  }
  function setMetadata(state,patch) {
    object(patch,'Metadata patch');return action(state,'set_metadata',{before:state.metadata,patch},next=>{next.metadata=metadataInfo({...next.metadata,...patch});});
  }
  function setExclusion(state,id,excluded,reason='') {
    if(typeof excluded!=='boolean')fail('Exclusion must be true or false.');if(!state.rois.some(r=>r.id===id))fail('Unknown ROI.');
    return action(state,'set_exclusion',{roi_id:id,excluded,reason},next=>{const roi=next.rois.find(r=>r.id===id);roi.included=!excluded;roi.exclusion_reason=excluded?reason:'';next.rois=normalizeROIs(next.rois,next.source);});
  }
  function canonical(value) { if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value); }
  async function sha256(value) {
    if(!root.crypto||!root.crypto.subtle)fail('SHA-256 requires a secure browser context.');
    const bytes=new TextEncoder().encode(value),hash=await root.crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');
  }
  async function fingerprint(state) { validateState(state);const value={schema:state.schema,source:state.source,model:state.model,original_prediction:state.original_prediction,rois:state.rois,metadata:state.metadata,history:state.history};if(state.schema===SCHEMA){value.measurement_reference=state.measurement_reference??null;value.editor=state.editor;value.qc_acknowledgement=state.qc_acknowledgement;}for(const key of ['history_checkpoints','detached_sources'])if(state[key]!==undefined)value[key]=state[key];return sha256(canonical(value)); }
  function pointInROI(point,roi,boundary=true){let value=false;for(const path of roi.paths){for(let i=0;i<path.length;i++)if(onSegment(path[i],path[(i+1)%path.length],point))return boundary;if(inside(point,path))value=!value;}return value;}
  function overlap(a,b,budget){
    for(const pa of a.paths)for(const pb of b.paths)for(let i=0;i<pa.length;i++)for(let j=0;j<pb.length;j++){if(--budget.remaining<0)return null;const u=pa[i],v=pa[(i+1)%pa.length],w=pb[j],z=pb[(j+1)%pb.length];if(cross(u,v,w)*cross(u,v,z)<0&&cross(w,z,u)*cross(w,z,v)<0)return true;}
    for(const [r,other] of [[a,b],[b,a]])for(const path of r.paths)for(let i=0;i<path.length;i++){const p=path[i],q=path[(i+1)%path.length];if((budget.remaining-=other.paths.reduce((n,p)=>n+p.length,0)*5)<0)return null;if(pointInROI(p,other,false))return true;const dx=q[0]-p[0],dy=q[1]-p[1],length=Math.hypot(dx,dy),e=Math.min(.001,length*1e-5);for(const sign of [-1,1]){const m=[(p[0]+q[0])/2-sign*dy/length*e,(p[1]+q[1])/2+sign*dx/length*e];if(pointInROI(m,r,false)&&pointInROI(m,other,false))return true;}}
    return false;
  }
  const qcCache=new WeakMap();
  function qualityFlagsForROIs(rois){
    if(!Array.isArray(rois))fail('Geometry screening requires ROI records.');
    const included=rois.filter(r=>r.included!==false),areas=included.filter(r=>kindOf(r)==='area'),cb=areas.filter(r=>r.label==='CB'),layers=areas.filter(r=>['ML','GL','WM'].includes(r.label)),flags=[];
    for(const r of included)if(r.label==='UNASSIGNED')flags.push({code:'unassigned',roi_ids:[r.id],message:'Assign a tissue label before approval.'});
    for(const r of included)if(['PL','FISSURE'].includes(r.label)&&kindOf(r)!=='polyline'||r.label==='LANDMARK'&&kindOf(r)!=='point'||AREA_LABELS.includes(r.label)&&kindOf(r)!=='area')flags.push({code:'geometry_label_mismatch',roi_ids:[r.id],message:'The recorded label and geometry have different measurement roles. Inspect the source; an area perimeter is not PL path length.'});
    if(layers.length&&!cb.length)flags.push({code:'no_cb',roi_ids:layers.map(r=>r.id),message:'No included CB boundary is available to screen layer containment.'});
    const budget={remaining:500000};let incomplete=false;const cbVertices=cb.reduce((n,c)=>n+c.paths.reduce((m,p)=>m+p.length,0),0);
    for(const r of layers)if(cb.length){let outside=false;outer:for(const path of r.paths)for(let i=0;i<path.length;i++){const p=path[i],q=path[(i+1)%path.length];for(const v of [p,[(p[0]+q[0])/2,(p[1]+q[1])/2]]){if((budget.remaining-=cbVertices)<0){incomplete=true;break outer;}if(!cb.some(c=>pointInROI(v,c))){outside=true;break outer;}}}if(outside)flags.push({code:'outside_cb',roi_ids:[r.id],message:'Layer boundary extends outside the included CB contours; inspect the source image.'});}
    for(const[group,code,message]of [[layers,'layer_overlap','Included layer ROIs overlap; inspect boundaries and avoid double-counting.'],[cb,'cb_overlap','Included CB ROIs overlap; inspect duplicate coverage before adding their areas.']])for(let i=0;i<group.length;i++)for(let j=i+1;j<group.length;j++){const a=group[i],b=group[j],result=overlap(a,b,budget);if(result===null){incomplete=true;break;}if(result)flags.push({code,roi_ids:[a.id,b.id],message});}if(incomplete)flags.push({code:'screening_incomplete',roi_ids:[],message:'The geometric screening budget was reached. Inspect all layer relationships manually; no clean result is implied.'});
    return freeze(flags);
  }
  function qualityFlags(state){
    if(Object.isFrozen(state)&&qcCache.has(state))return qcCache.get(state);validateState(state);const flags=qualityFlagsForROIs(state.rois);if(Object.isFrozen(state))qcCache.set(state,flags);return flags;
  }
  function qcSignature(state){return canonical({rois:state.rois,flags:qualityFlags(state)});}
  function acknowledgeQC(state,note){text(note,'QC review note',2000);const next=clone(action(state,'acknowledge_qc',{note,flags:qualityFlags(state)},()=>{},false));next.qc_acknowledgement={note,signature:qcSignature(next)};return freeze(next);}
  async function approve(state,{reviewer,protocol,checked,coordinatesChecked=false}={}) {
    validateState(state);text(reviewer,'reviewer name',200);text(protocol,'review protocol',4000);if(checked!==true)fail('Explicit source, contours and metadata review confirmation is required.');
    if(!state.metadata.single_section_confirmed)fail('Confirm that this image contains one section before approval.');
    if(!state.metadata.animal_id.trim()||!state.metadata.section_id.trim())fail('Animal and section identifiers are required before approval.');
    if(!state.rois.some(r=>r.included))fail('No included ROIs remain to approve.');
    if(state.original_prediction.origin==='imagej'&&coordinatesChecked!==true)fail('Confirm imported ROI alignment with the original TIFF before approval.');
    const flags=qualityFlags(state);if(flags.some(f=>f.code==='unassigned'))fail('Assign tissue labels to included ROIs before approval.');
    if(flags.some(f=>f.code==='geometry_label_mismatch'))fail('Correct the geometry label before approval: CB, ML, GL and WM require areas; PL and FISSURE require open lines; LANDMARK requires points. Use OTHER for explicitly reviewed generic geometry.');
    if(flags.length&&(!state.qc_acknowledgement||state.qc_acknowledgement.signature!==qcSignature(state)))fail('Review the geometry screening flags and record a QC acknowledgement before approval.');
    const next=clone(action(state,'approve',{reviewer,protocol,...(state.original_prediction.origin==='imagej'?{coordinates_checked:true}:{})},()=>{},false));next.qc_acknowledgement=state.qc_acknowledgement??null;const out=clone(next);
    out.approval={reviewer,protocol,checked:true,at:next.history[next.history.length-1].at,fingerprint:await fingerprint(next),identity:'self-entered; not authenticated'};return freeze(out);
  }
  function measure(roi,metadata=initialMetadata()) {
    const kind=kindOf(roi);let area=null,perimeter=null,physicalPerimeter=null,length=null,physicalLength=null;
    const x=metadata.um_per_pixel_x,y=metadata.um_per_pixel_y,calibrated=finite(x)&&x>0&&finite(y)&&y>0;
    if(kind==='area'){
      const ellipse=originalEllipse(roi);if(ellipse)area=Math.PI*ellipse.width*ellipse.height/4;
      else if(roi.geometry_profile==='imagej-evenodd/1')area=sourceArea(roi.paths).area;
      else{const rings=topology(roi.paths);area=rings.reduce((sum,ring)=>sum+Math.abs(ring.signed)*(ring.depth%2?-1:1),0);}
      perimeter=0;physicalPerimeter=calibrated?0:null;
      for(const path of roi.paths)for(let j=0;j<path.length;j++){const a=path[j],b=path[(j+1)%path.length],dx=b[0]-a[0],dy=b[1]-a[1];perimeter+=Math.hypot(dx,dy);if(calibrated)physicalPerimeter+=Math.hypot(dx*x,dy*y);}
    }else if(kind==='polyline'){
      length=0;physicalLength=calibrated?0:null;
      for(const path of roi.paths)for(let j=1;j<path.length;j++){const a=path[j-1],b=path[j],dx=b[0]-a[0],dy=b[1]-a[1];length+=Math.hypot(dx,dy);if(calibrated)physicalLength+=Math.hypot(dx*x,dy*y);}
    }else if(kind!=='point')fail('Unsupported ROI measurement type.');
    const out={area_px2:area,perimeter_px:perimeter,area_um2:area!==null&&calibrated?area*x*y:null,perimeter_um:physicalPerimeter,length_px:length,length_um:physicalLength,point_count:kind==='point'?roi.paths.reduce((n,p)=>n+p.length,0):null};
    if(Object.values(out).some(v=>v!==null&&!finite(v)))fail('Measurement exceeds the supported numeric range.');return out;
  }
  function imageJROI(roi) {
    // Linear ShapeRoi path commands in absolute image pixels. Winding also
    // supports readers using the nonzero rule; the project uses even-odd fill.
    const kind=kindOf(roi),name=roi.name||roi.label+'_'+roi.id,points=roi.paths.flat();
    const bounds=boundsOf(points),minx=bounds.x,miny=bounds.y,maxx=bounds.right,maxy=bounds.bottom,ellipse=originalEllipse(roi);
    let code=kind==='point'?10:kind==='polyline'?(roi.type==='line'&&points.length===2?3:roi.type==='freeline'?4:roi.type==='angle'&&points.length===3?9:5):1;
    const rectangle=kind==='area'&&roi.type==='rectangle'&&roi.paths.length===1&&(points.length===4||points.length===5&&same(points[0],points[4]))&&new Set(points.map(p=>p.join(','))).size===4&&points.every(p=>[minx,maxx].includes(p[0])&&[miny,maxy].includes(p[1]))&&points.slice(0,4).every((p,i)=>{const q=points[(i+1)%4];return (p[0]===q[0])!==(p[1]===q[1]);});
    if(ellipse)code=2;else if(kind==='area'&&roi.paths.length===1&&['polygon','freehand','traced'].includes(roi.type))code=({polygon:0,freehand:7,traced:8})[roi.type];
    const composite=kind==='area'&&code===1&&!rectangle,commands=composite?roi.paths.flatMap(path=>[0,...path[0],...path.slice(1).flatMap(p=>[1,...p]),4]):null;
    const coordinates=!composite&&![1,2,3].includes(code),header2=64+(composite?commands.length*4:coordinates?points.length*12:0),nameOffset=header2+64;
    const bytes=new Uint8Array(nameOffset+name.length*2),view=new DataView(bytes.buffer);
    bytes.set([73,111,117,116]);view.setUint16(4,228);bytes[6]=code;
    view.setInt16(8,Math.floor(miny));view.setInt16(10,Math.floor(minx));view.setInt16(12,Math.ceil(maxy));view.setInt16(14,Math.ceil(maxx));
    if(composite){view.setInt32(36,commands.length);commands.forEach((v,i)=>view.setFloat32(64+4*i,v));}
    else if(code===3){[...points[0],...points[1]].forEach((n,i)=>view.setFloat32(18+i*4,n));}
    else if(rectangle||ellipse){const b=ellipse||bounds;view.setUint16(50,128);[b.x,b.y,b.width,b.height].forEach((n,i)=>view.setFloat32(18+i*4,n));}
    else if(coordinates){if(points.length>65535)view.setInt32(18,points.length);else view.setUint16(16,points.length);view.setUint16(50,128);points.forEach((p,i)=>{view.setInt16(64+i*2,Math.round(p[0]-Math.floor(minx)));view.setInt16(64+2*points.length+i*2,Math.round(p[1]-Math.floor(miny)));view.setFloat32(64+4*points.length+i*4,p[0]);view.setFloat32(64+8*points.length+i*4,p[1]);});}
    const style=roi.style||{};if(style.stroke_width_px!==null&&style.stroke_width_px!==undefined){view.setUint16(34,Math.round(style.stroke_width_px));view.setFloat32(header2+36,style.stroke_width_px);}if(style.stroke_color_argb!=null)view.setUint32(40,style.stroke_color_argb);if(style.fill_color_argb!=null)view.setUint32(44,style.fill_color_argb);
    view.setInt32(60,header2);view.setInt32(header2+16,nameOffset);view.setInt32(header2+20,name.length);
    for(let i=0;i<name.length;i++)view.setUint16(nameOffset+2*i,name.charCodeAt(i));return bytes;
  }
  function csvCell(value) { if(value===null||value===undefined)return '';let s=String(value);if(typeof value==='string'&&/^[=+@-]/.test(s))s="'"+s;return /[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; }
  function roiFiles(rois) {
    const filenames=new Set();
    return rois.filter(r=>r.included).map(roi=>{const stem=(roi.name||roi.label+'_'+roi.id).replace(/[\\/\u0000-\u001f\u007f]/g,'_').replace(/\.roi$/i,'').slice(0,180)||roi.id;let name=stem+'.roi',suffix=0;while(filenames.has(name.toLowerCase()))name=stem+'_'+roi.id+(suffix++?'_'+suffix:'')+'.roi';filenames.add(name.toLowerCase());return {name,bytes:imageJROI(roi)};});
  }
  // ImageJ ROI files of a review that is not approved, so a draft can be corrected in ImageJ or Fiji and imported again.
  // Nothing here is an approved result: no measurements, no approval identifiers, and the caller names the download as a draft.
  function exportDraftROIs(state, options={}) {
    validateState(state);
    if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>k!=='roiIds'))fail('Invalid ROI export selection.');
    const ids=options.roiIds;
    if(ids!==undefined&&(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!state.rois.some(r=>r.id===id))))fail('Choose existing, distinct ROI identifiers for export.');
    const selected=ids===undefined?null:new Set(ids),files=roiFiles(state.rois.filter(r=>!selected||selected.has(r.id)));
    if(!files.length)fail('No included ROI in this scope.');
    return {files,status:'draft-not-approved',approved:false,source_sha256:state.source.sha256,roi_count:files.length};
  }
  async function exportApproved(state, options={}) {
    validateState(state);const approval=state.approval;
    if(!approval||approval.checked!==true||approval.fingerprint!==await fingerprint(state))fail('A current approval is required; changes invalidate previous approval.');
    const last=state.history[state.history.length-1];
    if(!last||last.type!=='approve'||!last.detail||last.detail.reviewer!==approval.reviewer||last.detail.protocol!==approval.protocol||last.at!==approval.at||approval.identity!=='self-entered; not authenticated')fail('Approval metadata do not match the fingerprint-bound review record.');
    text(approval.reviewer,'reviewer name');text(approval.protocol,'review protocol',4000);
    if(!state.metadata.single_section_confirmed||!state.metadata.animal_id.trim()||!state.metadata.section_id.trim()||!state.rois.some(r=>r.included))fail('Approval metadata are incomplete.');
    if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>k!=='roiIds'))fail('Invalid ROI export selection.');
    const ids=options.roiIds;
    if(ids!==undefined&&(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!state.rois.some(r=>r.id===id))))fail('Choose existing, distinct ROI identifiers for export.');
    const selectedIds=ids===undefined?null:new Set(ids),exportROIs=state.rois.filter(r=>!selectedIds||selectedIds.has(r.id));
    const columns=['animal_id','section_id','roi_id','label','kind','source_type','original_name','source_file','region','status','exclusion_reason','area_px2','perimeter_px','area_um2','perimeter_um','length_px','length_um','point_count','point_coordinates_px','point_coordinates_um','um_per_pixel_x','um_per_pixel_y','z_um','thickness_um','sampling_interval_um','source_sha256','model_weights_sha256','approval_fingerprint'];
    const records=exportROIs.map(roi=>{
      const points=roi.included&&kindOf(roi)==='point'?clone(roi.paths.flat()):null,x=state.metadata.um_per_pixel_x,y=state.metadata.um_per_pixel_y;
      return {animal_id:state.metadata.animal_id,section_id:state.metadata.section_id,roi_id:roi.id,label:roi.label,kind:kindOf(roi),source_type:roi.type??null,original_name:roi.name??null,source_file:roi.source_file??null,region:roi.region??null,status:roi.included?'included':'excluded',exclusion_reason:roi.exclusion_reason,...(roi.included?measure(roi,state.metadata):{area_px2:null,perimeter_px:null,area_um2:null,perimeter_um:null,length_px:null,length_um:null,point_count:null}),point_coordinates_px:points,point_coordinates_um:points&&finite(x)&&x>0&&finite(y)&&y>0?points.map(p=>[p[0]*x,p[1]*y]):null,...Object.fromEntries(['um_per_pixel_x','um_per_pixel_y','z_um','thickness_um','sampling_interval_um'].map(k=>[k,state.metadata[k]])),source_sha256:state.source.sha256,model_weights_sha256:state.model?.weights_sha256??null,approval_fingerprint:approval.fingerprint};
    });
    const csv=[columns,...records.map(row=>columns.map(key=>Array.isArray(row[key])?JSON.stringify(row[key]):row[key]))].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
    // One result row per ROI, never a tissue sum: CB and its constituent layers overlap.
    const resultColumns=['animal_id','section_id','roi_id','label','region','kind','status','metric','value','unit','physical_metric','physical_value','physical_unit','source_sha256','model_weights_sha256','approval_fingerprint'];
    const resultRecords=records.map(row=>{const area=row.kind==='area',line=row.kind==='polyline';return {...row,metric:area?'area':line?'open_length':'point_count',value:area?row.area_px2:line?row.length_px:row.point_count,unit:area?'px^2':line?'px':'count',physical_metric:area?'area':line?'open_length':null,physical_value:area?row.area_um2:line?row.length_um:null,physical_unit:area&&row.area_um2!==null?'um^2':line&&row.length_um!==null?'um':null};});
    const resultCSV=[resultColumns,...resultRecords.map(row=>resultColumns.map(key=>row[key]))].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
    const exportScope={kind:ids===undefined?'all':'selected',roi_ids:exportROIs.map(r=>r.id),included_roi_ids:exportROIs.filter(r=>r.included).map(r=>r.id),total_review_roi_count:state.rois.length,approval_scope:'The approval binds the full unchanged review; this export is a selection from that review.'};
    const files=roiFiles(exportROIs);
    return {csv,resultCSV,files,report:{export_scope:exportScope,schema:'cerebellum-approved-analysis/1',analysis:clone(state),measurements:records,quality_flags:qualityFlags(state),source_measurement_comparison:state.measurement_reference?csvCore().compare(state.measurement_reference,state,measure):null,definition:'Area: continuous Float32 polygon interior under the even-odd rule, or analytic area of an unchanged source ellipse. Closed perimeter: sum of all boundary segments, including holes. Open length: consecutive segments of line ROIs only, including PL when classified as PL. Points: count and coordinates only. Physical coordinates use the image top-left origin and recorded independent x/y scales. No volume is inferred.',limitations:['Human approval records a review, not proven anatomical accuracy.','Reviewer identity is self-entered and not authenticated; hashes provide integrity links, not signatures.','Continuous area is not ImageJ pixel-mask area. Closed segment perimeter is not ImageJ traced-ROI corner-corrected perimeter; original CSV values retain their original definition.','Display stroke width and colors do not contribute scientific area, length or point count. OTHER records have no single-tissue classification and cannot supply CB, ML, GL or WM volume.','Geometric overlap and vertex/midpoint-containment flags are bounded screening aids, not an exact partition or anatomical validation. No automatic repair or tissue filling is performed; per-ROI areas must not be blindly summed.','Unknown calibration and depth remain null; excluded ROIs retain their geometry and reason in this record and have blank measurements.','No biological performance claim is supplied with this workflow, and a model draft is not a validated segmentation.']}};
  }
  function importDraft(saved,source) {
    const state=boundedJSON(saved);validateState(state);const actual=sourceInfo(source);
    if(actual.sha256!==state.source.sha256||actual.width!==state.source.width||actual.height!==state.source.height)fail('Saved analysis does not match this source image.');
    const previous=clone(state.approval);return action(state,'reopen_draft',{previous_approval:previous,note:'Imported records are claims, not authenticated signatures. Fresh local approval is required.'},()=>{},false);
  }
  const api=Object.freeze({SCHEMA,LEGACY_SCHEMA,INPUT_SCHEMA,PREDICTION_SCHEMA,LIMITS,LABELS,AREA_LABELS,kindOf,create,createFromROIs,attachMeasurementCSV,validatePrediction,validateOriginal,addROI,deleteROI,setLabel,setRegion,removeSourceFile,checkpointHistory,insertVertex,deleteVertex,replacePaths,undo,redo,exportDraftROIs,qualityFlags,qualityFlagsForROIs,acknowledgeQC,editVertex,setMetadata,setExclusion,approve,exportApproved,measure,fingerprint,importDraft});
  root.AnalysisCore=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:window);
