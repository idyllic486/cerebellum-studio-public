/* Paired contour validation and declared animal-split checks.
 * Metrics describe a bounded common raster grid, not anatomical truth or a
 * calibrated probability. No held-out reference is used to construct a prediction.
 */
(function (root) {
  'use strict';
  const SCHEMA = 'cerebellum-validation/1';
  const REPORT_SCHEMA = 'cerebellum-validation-report/1';
  const VERSION = '1.0.0';
  const LAYERS = Object.freeze(['CB', 'ML', 'GL', 'WM']);
  const LIMITS = Object.freeze({pairs:500, rois:5000, verticesPerPair:1000000,
    verticesPerBundle:2000000, imageDimension:1000000, jsonBytes:64*1024*1024});
  const fail = message => { throw Error(message); };
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  const mean = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;
  const own = (object,key) => Object.prototype.hasOwnProperty.call(object,key);
  function object(value,label) {
    if(!value || typeof value !== 'object' || Array.isArray(value)) fail(label+' must be an object.');
  }
  function text(value,label,max=256) {
    if(typeof value !== 'string' || !value.trim() || value.length>max) fail('Invalid '+label+'.');
    return value;
  }
  function hash(value,label) {
    if(typeof value!=='string'||! /^[a-f0-9]{64}$/.test(value)) fail('Invalid SHA-256 for '+label+'.');
    return value;
  }
  function assertJSON(value,depth=0,counter={nodes:0}) {
    if(depth>28 || ++counter.nodes>10000000) fail('Validation input is too deeply nested or complex.');
    if(value===null || typeof value==='boolean' || typeof value==='string') return;
    if(typeof value==='number') { if(!finite(value)) fail('Validation input contains a non-finite number.'); return; }
    if(!value || typeof value!=='object') fail('Validation input must be JSON data.');
    for(const key of Object.keys(value)) {
      if(['__proto__','prototype','constructor'].includes(key)) fail('Unsafe validation input key.');
      assertJSON(value[key],depth+1,counter);
    }
  }
  function jsonCopy(value) {
    assertJSON(value);
    const serialized=JSON.stringify(value);
    if(new TextEncoder().encode(serialized).length>LIMITS.jsonBytes) fail('Validation input exceeds 64 MiB.');
    return JSON.parse(serialized);
  }
  function canonical(value) {
    if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
    if(value && typeof value==='object') return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
    return JSON.stringify(value);
  }
  async function fingerprint(value) {
    assertJSON(value);
    if(!root.crypto?.subtle) fail('SHA-256 requires a secure browser context.');
    const bytes=new TextEncoder().encode(canonical(value));
    const result=await root.crypto.subtle.digest('SHA-256',bytes);
    return [...new Uint8Array(result)].map(v=>v.toString(16).padStart(2,'0')).join('');
  }
  function modelProvenance(model) {
    if(!model || typeof model!=='object' || !Array.isArray(model.training_animals)) return null;
    if(model.training_animals.length>10000 || model.training_animals.some(id=>typeof id!=='string'||!id.trim()||id.length>256)) fail('Invalid model training animal list.');
    if(new Set(model.training_animals).size!==model.training_animals.length) fail('Model training animal IDs must be unique.');
    return model.training_animals;
  }
  function independence(animalId,split,model) {
    const training=modelProvenance(model),issues=[];
    if(!training||model.training_provenance_complete!==true) issues.push('Model training animals and completeness of their provenance are not declared.');
    if(typeof model?.id!=='string'||!model.id.trim()||typeof model?.version!=='string'||!model.version.trim()||typeof model?.weights_sha256!=='string'||! /^[a-f0-9]{64}$/.test(model.weights_sha256)) issues.push('A frozen model ID, version and weights SHA-256 are not declared.');
    if(!['validation','test'].includes(split)) issues.push('This observation is not explicitly assigned to an animal-level validation or test split.');
    const overlap=!!training?.includes(animalId);
    if(overlap) issues.push('This evaluation animal is declared among the model training animals.');
    return {status:overlap?'blocked':issues.length?'unverified':'eligible_under_declared_provenance',
      animal_id:animalId,evaluation_split:split||'unassigned',issues,
      interpretation:'Metadata eligibility only; declarations do not prove training history, anatomical accuracy or external generalisation.'};
  }
  function checkSplits(input) {
    object(input,'Study or split manifest');
    const issues=[],records=[],sourceOwners=new Map(),animalSplits=new Map();
    const issue=(code,severity,message,details={})=>issues.push({code,severity,message,...details});
    if(input.animals!==undefined) {
      if(!Array.isArray(input.animals)||input.animals.length>10000) fail('Invalid animal manifest.');
      for(const animal of input.animals) {
        object(animal,'Animal');text(animal.id,'animal ID');
        const split=animal.split||'unassigned';
        if(!['train','validation','test','unassigned'].includes(split)) fail('Invalid animal split.');
        if(!Array.isArray(animal.sections)) fail('Animal sections must be an array.');
        records.push({...animal,split});
      }
    } else if(input.splits) {
      object(input.splits,'Split manifest');
      for(const [split,ids] of Object.entries(input.splits)) {
        if(!['train','validation','test','unassigned'].includes(split)||!Array.isArray(ids)) fail('Invalid animal split list.');
        for(const id of ids) records.push({id:text(id,'animal ID'),split,sections:[]});
      }
    } else fail('Supply animals or explicit animal split lists.');
    let sectionCount=0,provenanceChecks=0;
    const seen=new Set(),batchSplits=new Map();
    for(const animal of records) {
      if(seen.has(animal.id)) issue('duplicate_animal_id','error','An animal ID occurs more than once.',{animal_id:animal.id});
      seen.add(animal.id);
      if(!animalSplits.has(animal.id)) animalSplits.set(animal.id,new Set());
      animalSplits.get(animal.id).add(animal.split);
      if(animal.split==='unassigned') issue('animal_split_unassigned','warning','An animal has no declared split.',{animal_id:animal.id});
      if(animal.batch!==null && animal.batch!==undefined && animal.batch!=='') {
        text(animal.batch,'batch ID');
        if(!batchSplits.has(animal.batch)) batchSplits.set(animal.batch,new Set());
        batchSplits.get(animal.batch).add(animal.split);
      }
      const localHashes=new Set();
      for(const section of animal.sections) {
        object(section,'Section');text(section.id,'section ID');sectionCount++;
        const source=section.source;
        if(!source?.sha256) issue('source_hash_missing','warning','A section lacks a source-image integrity link.',{animal_id:animal.id,section_id:section.id});
        else {
          hash(source.sha256,'section image');
          if(localHashes.has(source.sha256)) issue('repeated_source_within_animal','warning','The same source image occurs more than once within an animal; it is not an additional independent observation.',{animal_id:animal.id,source_sha256:source.sha256});
          localHashes.add(source.sha256);
          if(!sourceOwners.has(source.sha256)) sourceOwners.set(source.sha256,new Set());
          sourceOwners.get(source.sha256).add(animal.id);
        }
        if(['validation','test'].includes(animal.split)) {
          const state=independence(animal.id,animal.split,section.model||input.model);provenanceChecks++;
          if(state.status!=='eligible_under_declared_provenance') issue(state.status==='blocked'?'evaluation_animal_in_training':'model_training_provenance_missing',state.status==='blocked'?'error':'warning',state.issues.join(' '),{animal_id:animal.id,section_id:section.id});
        }
      }
      if(['validation','test'].includes(animal.split)&&!animal.sections.length) {
        const state=independence(animal.id,animal.split,input.model);provenanceChecks++;
        if(state.status!=='eligible_under_declared_provenance') issue(state.status==='blocked'?'evaluation_animal_in_training':'model_training_provenance_missing',state.status==='blocked'?'error':'warning',state.issues.join(' '),{animal_id:animal.id});
      }
    }
    for(const [id,splits] of animalSplits) if(splits.size>1) issue('animal_split_overlap','error','An animal is assigned to more than one split.',{animal_id:id,splits:[...splits]});
    for(const [digest,owners] of sourceOwners) if(owners.size>1) issue('source_hash_shared_across_animals','error','The same original image is assigned to different animal IDs.',{source_sha256:digest,animal_ids:[...owners]});
    for(const [batch,splits] of batchSplits) if(splits.has('train')&&(splits.has('validation')||splits.has('test'))) issue('batch_shared_with_training','warning','Held-out animals share an acquisition/staining batch with training animals; external-batch generalisation is not tested.',{batch,splits:[...splits]});
    if(!provenanceChecks) issue('no_held_out_animals','warning','No validation/test animal with model provenance was available for independence checks.');
    return {status:issues.some(i=>i.severity==='error')?'blocked':issues.length?'unverified':'eligible_under_declared_provenance',
      independence_established:false,issues,counts:{animals:seen.size,sections:sectionCount,...Object.fromEntries(['train','validation','test','unassigned'].map(split=>[split,new Set(records.filter(a=>a.split===split).map(a=>a.id)).size]))},
      scope:'Declared animal-level split and source-link checks only. This does not certify the actual model training history or independent biological performance.'};
  }
  function config(options={}) {
    const grid=options.grid===undefined?128:options.grid,layers=options.layers===undefined?LAYERS:options.layers;
    if(![128,256,512,1024].includes(grid)) fail('Validation grid must be 128, 256, 512 or 1024 cells along the longer image axis.');
    if(!Array.isArray(layers)||!layers.length||layers.length>4||new Set(layers).size!==layers.length||layers.some(l=>!LAYERS.includes(l))) fail('Select unique CB, ML, GL or WM validation layers.');
    if(options.includeMasks!==undefined&&typeof options.includeMasks!=='boolean') fail('includeMasks must be a boolean.');
    return {grid,layers:[...layers],includeMasks:options.includeMasks===true};
  }
  function labelOf(roi) {
    const explicit=roi.label||roi.tissue||roi.layer;
    if(explicit!==undefined&&explicit!==null&&explicit!=='') return typeof explicit==='string'&&LAYERS.includes(explicit.toUpperCase())?explicit.toUpperCase():null;
    const match=String(roi.name||'').toUpperCase().match(/^(CB|ML|GL|WM)(?:$|[_-])/);
    return match?match[1]:null;
  }
  function validateROIs(rois,source,counter) {
    if(!Array.isArray(rois)||rois.length>LIMITS.rois) fail('ROI lists must contain at most 5000 entries.');
    const names=new Set();let outside=0;
    for(const roi of rois) {
      object(roi,'ROI');const name=roi.name||roi.id;text(name,'ROI name',1024);
      if(names.has(name)) fail('Duplicate ROI name within one annotation set.');names.add(name);
      if(roi.included!==undefined&&typeof roi.included!=='boolean') fail('ROI inclusion must be explicit true or false.');
      if(!Array.isArray(roi.paths)||!roi.paths.length) fail('ROI paths are missing.');
      for(const path of roi.paths) {
        if(!Array.isArray(path)||path.length<(roi.kind==='point'?1:2)) fail('Invalid ROI path.');
        counter.vertices+=path.length;if(counter.vertices>LIMITS.verticesPerPair) fail('A validation pair exceeds one million vertices.');
        for(const point of path) {
          if(!Array.isArray(point)||point.length!==2||!point.every(finite)) fail('ROI coordinates must be finite XY pairs.');
          if(point[0]<0||point[1]<0||point[0]>source.width||point[1]>source.height) outside++;
        }
      }
    }
    if(outside)fail(outside+' ROI vertices lie outside the declared original image. Evaluation stopped rather than cropping them.');
  }
  function selectedROIs(pair,side,layer) {
    const all=pair[side+'_rois'],selection=pair[side+'_layer_selection'];
    if(selection!==undefined) object(selection,side+' layer selection');
    let selected;
    if(selection&&own(selection,layer)) {
      const names=selection[layer];
      if(!Array.isArray(names)||new Set(names).size!==names.length||names.some(n=>typeof n!=='string')) fail('Layer selection must list unique ROI names.');
      selected=names.map(name=>{const roi=all.find(r=>(r.name||r.id)===name);if(!roi) fail('Selected ROI is absent: '+name);if(roi.included===false) fail('An excluded ROI cannot be selected for validation.');return roi;});
    } else {
      const candidates=all.filter(r=>r.included!==false&&labelOf(r)===layer);
      const totals=candidates.filter(r=>String(r.name||r.id).toUpperCase()===layer+'_TOTAL');
      const exact=candidates.filter(r=>String(r.name||r.id).toUpperCase()===layer);
      if(totals.length===1) selected=totals;
      else if(exact.length===1) selected=exact;
      else if(candidates.every(r=>typeof(r.label||r.tissue||r.layer)==='string')) selected=candidates;
      else if(candidates.length<=1) selected=candidates;
      else fail('Select explicit '+side+' '+layer+' ROIs; local regions are not assumed to be an exhaustive partition.');
    }
    for(const roi of selected) if(roi.kind==='polyline'||roi.kind==='point'||roi.closed===false||roi.paths.some(p=>p.length<3)) fail('Validation of '+layer+' requires area contours, not lines or points.');
    for(const roi of selected) if((roi.label||roi.tissue||roi.layer)&&!LAYERS.includes(labelOf(roi))) fail('Selected ROI has an explicit non-tissue label; review and relabel the ROI before validating this layer.');
    return selected;
  }
  function coverage(pair,side,layer,rois) {
    const value=pair.coverage?.[side]?.[layer]??(rois.length?'present':'unassessed');
    if(!['present','absent','unassessed'].includes(value)) fail('Layer coverage must be present, absent or unassessed.');
    if(value==='absent'&&rois.length) fail('A layer declared absent still has selected ROI geometry.');
    if(value==='present'&&!rois.length) fail('A layer declared present needs selected ROI geometry.');
    return value;
  }
  function raster(rois,grid) {
    const mask=new Uint8Array(grid.width*grid.height);
    for(const roi of rois) for(let row=0;row<grid.height;row++) {
      const y=(row+.5)*grid.spacing_y,xs=[];
      for(const path of roi.paths) for(let i=0,j=path.length-1;i<path.length;j=i++) {
        const a=path[j],b=path[i];if((a[1]>y)!==(b[1]>y)) xs.push(a[0]+(y-a[1])*(b[0]-a[0])/(b[1]-a[1]));
      }
      xs.sort((a,b)=>a-b);
      if(xs.length%2) fail('ROI rasterisation found an unpaired intersection.');
      for(let i=0;i<xs.length;i+=2) {
        const from=Math.max(0,Math.ceil(xs[i]/grid.spacing_x-.5)),to=Math.min(grid.width,Math.ceil(xs[i+1]/grid.spacing_x-.5));
        mask.fill(1,row*grid.width+from,row*grid.width+to);
      }
    }
    return mask;
  }
  function count(mask) {let total=0;for(const v of mask)total+=v;return total;}
  function boundaries(mask,width,height) {
    const out=new Uint8Array(mask.length);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
      const i=y*width+x;
      if(mask[i]&&(x===0||x===width-1||y===0||y===height-1||!mask[i-1]||!mask[i+1]||!mask[i-width]||!mask[i+width])) out[i]=1;
    }
    return out;
  }
  // Exact separable squared Euclidean distance transform on this rectangular lattice.
  function edt1(values,n,spacing) {
    const out=new Float64Array(n),v=new Int32Array(n),z=new Float64Array(n+1),a=spacing*spacing;
    let k=0;v[0]=0;z[0]=-Infinity;z[1]=Infinity;
    for(let q=1;q<n;q++) {
      let s;
      do {s=((values[q]+a*q*q)-(values[v[k]]+a*v[k]*v[k]))/(2*a*(q-v[k]));if(s<=z[k])k--;else break;} while(k>=0);
      if(k<0){k=0;v[0]=q;z[0]=-Infinity;z[1]=Infinity;}
      else{k++;v[k]=q;z[k]=s;z[k+1]=Infinity;}
    }
    k=0;for(let q=0;q<n;q++){while(z[k+1]<q)k++;out[q]=a*(q-v[k])**2+values[v[k]];}
    return out;
  }
  function distances(target,width,height,sx,sy) {
    const big=4*((width*sx)**2+(height*sy)**2)+1,tmp=new Float64Array(target.length),out=new Float64Array(target.length);
    let f=new Float64Array(width);
    for(let y=0;y<height;y++){for(let x=0;x<width;x++)f[x]=target[y*width+x]?0:big;tmp.set(edt1(f,width,sx),y*width);}
    f=new Float64Array(height);
    for(let x=0;x<width;x++){for(let y=0;y<height;y++)f[y]=tmp[y*width+x];const d=edt1(f,height,sy);for(let y=0;y<height;y++)out[y*width+x]=Math.sqrt(d[y]);}
    return out;
  }
  function quantile(values,p) {
    const sorted=[...values].sort((a,b)=>a-b),position=(sorted.length-1)*p,lo=Math.floor(position),hi=Math.ceil(position);
    return sorted[lo]+(sorted[hi]-sorted[lo])*(position-lo);
  }
  function boundaryMetrics(a,b,grid,calibration) {
    const p=boundaries(a,grid.width,grid.height),r=boundaries(b,grid.width,grid.height);
    if(!count(p)||!count(r)) return {mean_symmetric_px:null,hd95_px:null,mean_symmetric_um:null,hd95_um:null,
      definition:'Undefined when either foreground mask is empty.'};
    const collect=(sx,sy)=>{
      const toP=distances(p,grid.width,grid.height,sx,sy),toR=distances(r,grid.width,grid.height,sx,sy),values=[];
      for(let i=0;i<p.length;i++){if(p[i])values.push(toR[i]);if(r[i])values.push(toP[i]);}
      return {mean:mean(values),hd95:quantile(values,.95)};
    };
    const px=collect(grid.spacing_x,grid.spacing_y),physical=calibration?collect(grid.spacing_x*calibration.x,grid.spacing_y*calibration.y):null;
    return {mean_symmetric_px:px.mean,hd95_px:px.hd95,mean_symmetric_um:physical?.mean??null,hd95_um:physical?.hd95??null,
      definition:'Pooled symmetric nearest boundary-cell-centre distances, 4-neighbour foreground boundary; HD95 uses the linear 95th percentile. This is a grid approximation.'};
  }
  function pairInfo(pair) {
    object(pair,'Validation pair');text(pair.animal_id,'animal ID');text(pair.section_id,'section ID');object(pair.source,'Source image');
    const source=pair.source;hash(source.sha256,'source image');
    if(!Number.isSafeInteger(source.width)||!Number.isSafeInteger(source.height)||source.width<1||source.height<1||source.width>LIMITS.imageDimension||source.height>LIMITS.imageDimension) fail('Invalid source image dimensions.');
    if(hash(pair.prediction_source_sha256,'prediction source')!==source.sha256||hash(pair.reference_source_sha256,'reference source')!==source.sha256) fail('Prediction and reference must identify the same original image SHA-256.');
    const counter={vertices:0};validateROIs(pair.prediction_rois,source,counter);validateROIs(pair.reference_rois,source,counter);
    const x=pair.calibration?.um_per_pixel_x??null,y=pair.calibration?.um_per_pixel_y??null;
    for(const value of [x,y])if(value!==null&&(!finite(value)||value<=0||value>1e6||value<1e-9)) fail('Physical pixel scales must be positive finite numbers or null.');
    if(pair.evaluation_split!==undefined&&!['train','validation','test','unassigned'].includes(pair.evaluation_split)) fail('Invalid evaluation split.');
    if(pair.prediction_stage!==undefined&&!['model_draft','human_corrected','unknown'].includes(pair.prediction_stage)) fail('Invalid prediction stage.');
    return {source,vertices:counter.vertices,calibration:x!==null&&y!==null?{x,y}:null};
  }
  function evaluatePair(pair,options={}) {
    const cfg=config(options),{source,vertices,calibration}=pairInfo(pair);
    const scale=cfg.grid/Math.max(source.width,source.height),width=Math.max(1,Math.round(source.width*scale)),height=Math.max(1,Math.round(source.height*scale));
    const grid={width,height,origin:[0,0],spacing_x:source.width/width,spacing_y:source.height/height,domain:[0,0,source.width,source.height],outside_vertex_count:0,sampling:'cell centres across the full original image',fill_rule:'even-odd within each ROI; union across explicitly selected ROIs'};
    const cellArea=grid.spacing_x*grid.spacing_y,layers={};
    for(const layer of cfg.layers) {
      const predicted=selectedROIs(pair,'prediction',layer),reference=selectedROIs(pair,'reference',layer),pc=coverage(pair,'prediction',layer,predicted),rc=coverage(pair,'reference',layer,reference);
      const base={status:'unassessed',coverage:{prediction:pc,reference:rc},prediction_roi_names:predicted.map(r=>r.name||r.id),reference_roi_names:reference.map(r=>r.name||r.id),dice:null,iou:null,predicted_area_px2:null,reference_area_px2:null,predicted_area_um2:null,reference_area_um2:null,signed_area_error_px2:null,signed_area_error_um2:null,signed_area_error_pct:null,absolute_area_error_pct:null,boundary:{mean_symmetric_px:null,hd95_px:null,mean_symmetric_um:null,hd95_um:null},warnings:[]};
      if(pc==='unassessed'||rc==='unassessed'){base.warnings.push('An absent annotation is not evidence of absent tissue; no zero mask or score was substituted.');layers[layer]=base;continue;}
      const p=raster(predicted,grid),r=raster(reference,grid),np=count(p),nr=count(r);
      base.grid_counts={prediction:np,reference:nr};
      if((pc==='present'&&!np)||(rc==='present'&&!nr)){base.status='unscorable';base.warnings.push('A present contour vanished at this grid resolution; scores and areas are not reported as tissue absence.');layers[layer]=base;continue;}
      let intersection=0;for(let i=0;i<p.length;i++)intersection+=p[i]&&r[i]?1:0;
      const union=np+nr-intersection,physical=calibration?calibration.x*calibration.y:null;
      base.status=np+nr?'scored':'both_absent';
      base.dice=np+nr?2*intersection/(np+nr):null;base.iou=union?intersection/union:null;
      base.predicted_area_px2=np*cellArea;base.reference_area_px2=nr*cellArea;
      base.predicted_area_um2=physical===null?null:np*cellArea*physical;base.reference_area_um2=physical===null?null:nr*cellArea*physical;
      base.signed_area_error_px2=(np-nr)*cellArea;base.signed_area_error_um2=physical===null?null:(np-nr)*cellArea*physical;
      base.signed_area_error_pct=nr?100*(np-nr)/nr:null;base.absolute_area_error_pct=nr?100*Math.abs(np-nr)/nr:null;
      base.true_positive_cells=intersection;base.false_positive_cells=np-intersection;base.false_negative_cells=nr-intersection;
      base.boundary=boundaryMetrics(p,r,grid,calibration);
      if(!np||!nr)base.warnings.push('Boundary distance is undefined when either mask is empty. Both-empty Dice/IoU are not set to one.');
      base.warnings.push('Areas and distances describe the selected raster grid, not full-resolution masks or ImageJ measurements. Small components and holes can disappear.');
      if(cfg.includeMasks)base.masks={prediction:Array.from(p),reference:Array.from(r)};
      layers[layer]=base;
    }
    let reviewTime=null;
    if(pair.review_time!==undefined&&pair.review_time!==null){
      const t=pair.review_time;object(t,'Review time');
      for(const key of ['manual_minutes','assisted_minutes'])if(t[key]!==null&&t[key]!==undefined&&(!finite(t[key])||t[key]<0||t[key]>1e7))fail('Review times must be nonnegative finite minutes or null.');
      const manual=t.manual_minutes??null,assisted=t.assisted_minutes??null;
      if(manual!==null&&assisted!==null&&t.same_protocol!==true)fail('Paired review-time comparison requires an explicit same_protocol confirmation.');
      reviewTime={manual_minutes:manual,assisted_minutes:assisted,same_protocol:t.same_protocol===true,difference_minutes:manual!==null&&assisted!==null?manual-assisted:null,reduction_pct:manual!==null&&manual>0&&assisted!==null?100*(manual-assisted)/manual:null,basis:'Operator-recorded paired times; not automatically measured, causal proof or established efficiency.'};
    }
    return {animal_id:pair.animal_id,section_id:pair.section_id,source_sha256:source.sha256,vertices,grid,layers,model:pair.model?clone(pair.model):null,prediction_stage:pair.prediction_stage||'unknown',independence:independence(pair.animal_id,pair.evaluation_split,pair.model),review_time:reviewTime,
      warnings:['Reference contours are comparison annotations, not an error-free anatomical ground truth.','Missing physical calibration prevents µm metrics; it is not replaced by a default scale.']};
  }
  function aggregate(reports) {
    if(!Array.isArray(reports)||reports.length>LIMITS.pairs) fail('Invalid validation report list.');
    const ids=[...new Set(reports.map(r=>r.animal_id))],layers={};
    for(const layer of LAYERS) {
      const animals=[];
      for(const animal_id of ids) {
        const rows=reports.filter(r=>r.animal_id===animal_id).map(r=>r.layers[layer]).filter(Boolean),scored=rows.filter(r=>r.status==='scored');
        animals.push({animal_id,sections:rows.length,scored_sections:scored.length,unassessed_sections:rows.filter(r=>r.status==='unassessed').length,unscorable_sections:rows.filter(r=>r.status==='unscorable').length,both_absent_sections:rows.filter(r=>r.status==='both_absent').length,
          metric_section_counts:{dice:scored.filter(r=>finite(r.dice)).length,iou:scored.filter(r=>finite(r.iou)).length,relative_area_error:scored.filter(r=>finite(r.absolute_area_error_pct)).length,boundary_distance_um:scored.filter(r=>finite(r.boundary.mean_symmetric_um)).length},
          mean_dice:mean(scored.map(r=>r.dice).filter(finite)),mean_iou:mean(scored.map(r=>r.iou).filter(finite)),mean_signed_area_error_pct:mean(scored.map(r=>r.signed_area_error_pct).filter(finite)),mean_absolute_area_error_pct:mean(scored.map(r=>r.absolute_area_error_pct).filter(finite)),mean_boundary_distance_um:mean(scored.map(r=>r.boundary.mean_symmetric_um).filter(finite))});
      }
      const eligible=animals.filter(a=>a.mean_dice!==null);
      layers[layer]={animals,scored_animals:eligible.length,metric_animal_counts:{dice:eligible.length,iou:animals.filter(a=>finite(a.mean_iou)).length,relative_area_error:animals.filter(a=>finite(a.mean_absolute_area_error_pct)).length,boundary_distance_um:animals.filter(a=>finite(a.mean_boundary_distance_um)).length},animal_mean_dice:mean(eligible.map(a=>a.mean_dice)),animal_mean_iou:mean(animals.map(a=>a.mean_iou).filter(finite)),animal_mean_absolute_area_error_pct:mean(animals.map(a=>a.mean_absolute_area_error_pct).filter(finite)),animal_mean_boundary_distance_um:mean(animals.map(a=>a.mean_boundary_distance_um).filter(finite))};
    }
    return {animal_count:ids.length,section_count:reports.length,layers,aggregation:'Compute section means within each animal, then an unweighted mean of animal means. Sections are not independent animals.',independence_status:reports.some(r=>r.independence.status==='blocked')?'blocked':reports.some(r=>r.independence.status!=='eligible_under_declared_provenance')?'unverified':'eligible_under_declared_provenance',warnings:['Descriptive results only. No p-value, calibrated uncertainty or external generalisation is established by these summaries.']};
  }
  async function evaluateBundle(input,options={}) {
    const bundle=jsonCopy(input),cfg=config(options);
    if(bundle.schema!==SCHEMA) fail('Unsupported validation bundle; expected '+SCHEMA+'.');
    text(bundle.protocol_id,'validation protocol ID');
    if(!Array.isArray(bundle.pairs)||!bundle.pairs.length||bundle.pairs.length>LIMITS.pairs) fail('Validation requires 1–500 pairs.');
    if(bundle.pairs.length*cfg.grid*cfg.grid*cfg.layers.length>64*1024*1024)fail('Validation work exceeds 64 million layer-grid cells; reduce the bundle or grid size.');
    if(cfg.includeMasks&&bundle.pairs.length>4) fail('Mask previews are limited to four pairs per report.');
    let vertices=0;const pairs=[],ids=new Set(),sources=new Map(),models=new Set(),stages=new Set();
    for(const pair of bundle.pairs) {
      const key=pair.animal_id+'\u0000'+pair.section_id;if(ids.has(key)) fail('Duplicate animal/section validation pair.');ids.add(key);
      if(sources.has(pair.source?.sha256)) fail('The same source image occurs in more than one validation pair; do not count repeated data as additional observations.');sources.set(pair.source?.sha256,key);
      models.add(canonical(pair.model||null));stages.add(pair.prediction_stage||'unknown');
      const report=evaluatePair(pair,cfg);vertices+=report.vertices;if(vertices>LIMITS.verticesPerBundle)fail('Validation bundle exceeds two million vertices.');pairs.push(report);
    }
    if(models.size>1)fail('Evaluate one frozen model provenance at a time; results from different models are not pooled.');
    if(stages.size>1)fail('Model drafts and human-corrected predictions require separate reports.');
    const split_check=bundle.study?checkSplits(bundle.study):null;
    if(bundle.study?.animals)for(const pair of bundle.pairs) {
      const animal=bundle.study.animals.find(a=>a.id===pair.animal_id);
      if(!animal)fail('Evaluation animal is missing from the supplied study.');
      if(animal.split!==pair.evaluation_split)fail('Evaluation split does not match the supplied animal manifest.');
      const section=animal.sections.find(s=>s.id===pair.section_id);
      if(!section)fail('Evaluation section is missing from the supplied study.');
      if(section.source?.sha256!==pair.source.sha256)fail('Evaluation source does not match the supplied study section.');
      if(section.source.width!==pair.source.width||section.source.height!==pair.source.height)fail('Evaluation source dimensions do not match the supplied study section.');
    }
    const result={schema:REPORT_SCHEMA,version:VERSION,input_sha256:await fingerprint({bundle,options:cfg}),input:bundle,conditions:{...cfg,protocol_id:bundle.protocol_id,domain:'full original image; out-of-image geometry rejected',boundary_definition:'4-neighbour foreground boundary cell centres; symmetric nearest distances; linear HD95 quantile',area_definition:'common-grid foreground cell count times cell area; not an ImageJ metric'},pairs,summary:aggregate(pairs),split_check,
      warnings:['These metrics compare supplied contours at the stated grid resolution; they do not establish anatomical ground truth.','Animal splits and training history are declarations, not authenticated model provenance.','The original example measurements and 20 historical hold-out scores remain separate and unchanged.','Reference annotations are never passed to a prediction or training operation by this evaluator.']};
    if(split_check?.status==='blocked')result.summary.independence_status='blocked';
    else if(split_check?.status==='unverified'&&result.summary.independence_status!=='blocked')result.summary.independence_status='unverified';
    if(stages.has('human_corrected'))result.warnings.push('This report measures results after human correction, not the raw model segmentation accuracy.');
    return result;
  }
  async function prepareStudyPairs(predictionInput,referenceInput,options={}){
    let S=root.StudyCore,A=root.AnalysisCore;if(typeof require==='function'){S=S||require('./study_core.js');A=A||require('./analysis_core.js');}
    if(!S||!A)fail('Load StudyCore and AnalysisCore to prepare paired validation.');
    const predicted=await S.importStudy(predictionInput),reference=await S.importStudy(referenceInput),decisions=options.exclusions??[];
    if(!Array.isArray(decisions)||decisions.length>LIMITS.pairs*2)fail('Invalid pairing exclusions.');
    const excluded=new Map();for(const decision of decisions){text(decision.key,'pairing row');text(decision.reason,'pairing exclusion reason',4000);if(excluded.has(decision.key))fail('Duplicate pairing exclusion.');excluded.set(decision.key,decision.reason.trim());}
    const flatten=(study,side)=>study.animals.flatMap(animal=>animal.sections.map(section=>({animal,section,key:JSON.stringify([side,animal.id,section.id])}))),pRows=flatten(predicted,'prediction'),rRows=flatten(reference,'reference');
    if(pRows.length+rRows.length>LIMITS.pairs*2)fail('Pairing supports at most 500 sections per input study.');
    const byHash=rows=>{const result=new Map();for(const row of rows)if(row.section.source){const hash=row.section.source.sha256;if(!result.has(hash))result.set(hash,[]);result.get(hash).push(row);}return result;},pHash=byHash(pRows),rHash=byHash(rRows),usedReferences=new Set(),rows=[],pairs=[],errors=[];
    const validKeys=new Set([...pRows,...rRows].map(row=>row.key));for(const key of excluded.keys())if(!validKeys.has(key))fail('Pairing exclusion refers to an unknown row.');
    if(canonical(predicted.protocol)!==canonical(reference.protocol))errors.push('Prediction and reference studies use different measurement or boundary protocols.');
    if(predicted.protocol.id==='unassigned'||!predicted.protocol.boundary_definition.trim())errors.push('Assign a boundary protocol before paired validation.');
    const registrationFrame=row=>row.section.registration?.reference_frame||row.animal.design?.coordinate_frame||'native_source_image_pixels';
    const animalProtocol=(study,row)=>({id:row.animal.design?.protocol_id||study.protocol.id,version:row.animal.design?.protocol_version||study.protocol.version});
    async function predictionEvidence(row){
      const original=row.section.provenance?.original_prediction;
      if(original?.schema!==A.PREDICTION_SCHEMA||!row.section.source)return {stage:'unknown',model:null,reason:'No preserved model prediction record is available.'};
      try{
        const native=A.validatePrediction(original,row.section.source);if(canonical(original.model)!==canonical(row.section.model))return {stage:'unknown',model:null,reason:'Model provenance differs from the preserved prediction.'};
        const current=row.section.rois.map(roi=>({id:roi.id,label:roi.label,paths:roi.paths,included:roi.included??true,exclusion_reason:roi.exclusion_reason??''}));
        const selectionUnchanged=LAYERS.every(layer=>canonical(native.filter(roi=>roi.included!==false&&roi.label===layer).map(roi=>roi.id).sort())===canonical(selectedROIs({prediction_rois:row.section.rois,prediction_layer_selection:row.section.layer_selection},'prediction',layer).map(roi=>roi.id).sort()));
        const unchanged=canonical(native)===canonical(current)&&selectionUnchanged,reviewed=await S.reviewStatus(predicted,row.animal.id,row.section.id)==='approved'&&S.sectionEvidence(row.section).grade==='source_linked';
        return {stage:unchanged?'model_draft':reviewed?'human_corrected':'unknown',model:clone(original.model),reason:unchanged?'Contours and layer selections match the preserved model prediction.':reviewed?'Reviewed contours or layer selections differ from the preserved model prediction.':'Edited contours or layer selections have not been reviewed.'};
      }catch(error){return {stage:'unknown',model:null,reason:'The preserved prediction record could not be verified: '+error.message};}
    }
    for(const p of pRows){
      const row={key:p.key,side:'prediction',animal_id:p.animal.id,section_id:p.section.id,source_sha256:p.section.source?.sha256??null,status:'unresolved',issues:[],exclusion_reason:null,reference_key:null,prediction_stage:'unknown'};
      if(!p.section.included){row.status='excluded';row.exclusion_reason=p.section.exclusion_reason;row.exclusion_origin='source_study';rows.push(row);continue;}
      const candidates=p.section.source?rHash.get(p.section.source.sha256)??[]:[];
      if(!p.section.source)row.issues.push('Prediction source image is missing.');
      else if((pHash.get(p.section.source.sha256)||[]).length!==1||candidates.length>1)row.issues.push('Repeated image identities make this match ambiguous.');
      else if(!candidates.length)row.issues.push('No reference section has the same source image.');
      const r=candidates.length===1&&(pHash.get(p.section.source?.sha256)||[]).length===1?candidates[0]:null;
      if(r){row.reference_key=r.key;if(r.section.included)usedReferences.add(r.key);
        if(p.animal.id!==r.animal.id||p.section.id!==r.section.id)row.issues.push('Animal or section identifiers differ despite a matching source image.');
        if(!r.section.included)row.issues.push('The reference section is excluded in its source study.');
        if(p.section.source.width!==r.section.source.width||p.section.source.height!==r.section.source.height)row.issues.push('Source image dimensions differ.');
        if(canonical(p.section.calibration)!==canonical(r.section.calibration))row.issues.push('Prediction and reference calibration differ.');
        if(registrationFrame(p)!==registrationFrame(r))row.issues.push('Prediction and reference coordinate frames differ.');
        if(canonical(animalProtocol(predicted,p))!==canonical(animalProtocol(reference,r)))row.issues.push('Prediction and reference animal protocols differ.');
        if(await S.reviewStatus(reference,r.animal.id,r.section.id)!=='approved'||S.sectionEvidence(r.section).grade!=='source_linked')row.issues.push('The reference requires a current source-linked human review.');
        const evidence=await predictionEvidence(p);row.prediction_stage=evidence.stage;row.prediction_evidence=evidence.reason;
        const pair={animal_id:p.animal.id,section_id:p.section.id,source:clone(p.section.source),prediction_source_sha256:p.section.source.sha256,reference_source_sha256:r.section.source.sha256,calibration:clone(p.section.calibration),prediction_rois:clone(p.section.rois),reference_rois:clone(r.section.rois),prediction_layer_selection:clone(p.section.layer_selection),reference_layer_selection:clone(r.section.layer_selection),evaluation_split:p.animal.split,prediction_stage:evidence.stage,model:evidence.model,reference_review:clone(r.section.review),reference_independence:'Researcher-provided reference review; independent annotation is not authenticated.',coordinate_frame:registrationFrame(p)};
        try{pairInfo(pair);for(const side of ['prediction','reference'])for(const layer of LAYERS)selectedROIs(pair,side,layer);}catch(error){row.issues.push(error.message);}
        if(!row.issues.length){row.status='matched';row._pair=pair;}
      }
      const excludeReason=excluded.get(p.key)||(r?excluded.get(r.key):null);if(excludeReason){row.status='excluded';row.exclusion_reason=excludeReason;row.exclusion_origin='pairing_decision';}
      if(row.status==='matched')pairs.push(row._pair);delete row._pair;rows.push(row);
    }
    for(const r of rRows)if(!usedReferences.has(r.key)){
      const reason=!r.section.included?r.section.exclusion_reason:excluded.get(r.key),row={key:r.key,side:'reference',animal_id:r.animal.id,section_id:r.section.id,source_sha256:r.section.source?.sha256??null,status:reason?'excluded':'unresolved',issues:['Reference section has no unique matched prediction.'],exclusion_reason:reason??null,exclusion_origin:!r.section.included?'source_study':reason?'pairing_decision':null};rows.push(row);
    }
    const stages=new Set(pairs.map(pair=>pair.prediction_stage)),models=new Set(pairs.map(pair=>canonical(pair.model)));
    if(stages.size>1)errors.push('Raw, corrected and unknown prediction stages cannot be pooled. Exclude other stages with a reason and evaluate separate reports.');
    if(models.size>1)errors.push('Different model provenance records cannot be pooled. Evaluate one frozen model at a time.');
    const unresolved=rows.filter(row=>row.status==='unresolved').length;if(unresolved)errors.push('Resolve unmatched or ambiguous rows, or exclude each with a recorded reason.');if(!pairs.length)errors.push('At least one eligible matched pair is required.');
    const audit={prediction_study_sha256:await fingerprint(predicted),reference_study_sha256:await fingerprint(reference),rows:clone(rows),pairing_rule:'Exact source SHA-256, animal and section IDs, dimensions, calibration, coordinate frame and boundary protocol; original pixel coordinates retained.',reference_review_limit:'Review integrity is checked; reviewer identity and independent annotation are declarations.'};
    let bundle=errors.length?null:{schema:SCHEMA,protocol_id:predicted.protocol.id,pairs,study:clone(predicted),pairing:audit};
    if(bundle)try{jsonCopy(bundle);if(pairs.reduce((sum,pair)=>sum+pairInfo(pair).vertices,0)>LIMITS.verticesPerBundle)fail('Validation bundle exceeds two million vertices.');}catch(error){errors.push(error.message);bundle=null;}
    return {status:errors.length?'blocked':'ready',matched_pairs:pairs.length,unresolved_rows:unresolved,rows,errors,audit,bundle,scientific_validation:'not_established'};
  }
  function evaluateResolutionSensitivity(pair,options={}) {
    const grids=options.grids??[128,256,512];
    if(!Array.isArray(grids)||grids.length<2||grids.length>4||new Set(grids).size!==grids.length)fail('Choose 2–4 distinct validation resolutions.');
    const reports=grids.map(grid=>evaluatePair(pair,{...options,grid,includeMasks:false})),layers={};
    let S=root.StudyCore;if(!S&&typeof require==='function')S=require('./study_core.js');
    if(!S)fail('Load StudyCore for native pixel-area checks.');
    for(const layer of reports[0].grid?Object.keys(reports[0].layers):[]){
      const native={};
      for(const side of ['prediction','reference']){
        const rois=selectedROIs(pair,side,layer),state=coverage(pair,side,layer,rois);
        if(state==='absent'){native[side]={area_px2:0,status:'declared_absent'};continue;}
        if(state!=='present'){native[side]={area_px2:null,status:'unassessed'};continue;}
        const selected=rois.map((r,i)=>({...clone(r),name:'native-'+i,kind:'area',closed:true}));
        const measured=S.sectionArea({rois:selected,calibration:{um_per_pixel_x:1,um_per_pixel_y:1},layer_selection:{[layer]:selected.map(r=>r.name)}},layer);
        native[side]={area_px2:measured.area_px2,status:measured.reason?'unavailable':'measured',reason:measured.reason};
      }
      const rows=reports.map((report,i)=>({grid:grids[i],...report.layers[layer]})),scores=rows.filter(r=>r.status==='scored').map(r=>r.dice);
      layers[layer]={native_pixel_areas:native,grid_results:rows,dice_range:scores.length?[Math.min(...scores),Math.max(...scores)]:null,
        last_grid_native_area_difference_px2:Object.fromEntries(['prediction','reference'].map(side=>[side,native[side].area_px2===null||rows.at(-1)[side==='prediction'?'predicted_area_px2':'reference_area_px2']===null?null:rows.at(-1)[side==='prediction'?'predicted_area_px2':'reference_area_px2']-native[side].area_px2]))};
    }
    return {kind:'raster_resolution_sensitivity',confidence_interval:false,animal_id:pair.animal_id,section_id:pair.section_id,source_sha256:pair.source.sha256,grids,layers,
      interpretation:'Resolution sensitivity of contour scores, with independent native pixel-centre area checks. Native boundary distances and native-resolution Dice are not supplied. Convergence and biological validity are not established by a small difference.'};
  }
  // Historical reports remain reproducible. Current-workflow completion additionally
  // requires the saved prediction, model, exclusions and complete protocol to match.
  function studyBinding(bundle,study){
    const out={current_input_match:false,current_sources_match:false,issues:[]};
    if(!study?.protocol||!Array.isArray(study.animals)||!Array.isArray(bundle?.pairs)){out.issues.push('Open a study and paired validation inputs before checking their relationship.');return out;}
    try{
    const protocol=bundle.study?.protocol??bundle.protocol;
    if(!protocol||['id','version','boundary_definition','measurement_profile','maximum_gap_um'].some(key=>!own(protocol,key))||canonical(protocol)!==canonical(study.protocol)||bundle.protocol_id!==study.protocol.id)out.issues.push('The saved validation input does not carry the current complete boundary and measurement protocol. Preserve it as historical evidence and rematch current inputs.');
    const annotation=roi=>({name:roi.name||roi.id,id:roi.id??null,label:labelOf(roi),kind:roi.kind??'area',closed:roi.closed??((roi.kind??'area')==='area'),paths:roi.paths,included:roi.included!==false,exclusion_reason:roi.exclusion_reason??''});
    let sourcesMatch=true;
    for(const pair of bundle.pairs){
      if(!pair||!Array.isArray(pair.prediction_rois)){sourcesMatch=false;out.issues.push('A saved validation pair is incomplete; evaluate or prepare valid paired data.');continue;}
      const animal=study.animals.find(a=>a.id===pair.animal_id),section=animal?.sections.find(s=>s.id===pair.section_id),prefix=pair.animal_id+'/'+pair.section_id+': ';
      if(!section||animal.split!==pair.evaluation_split||section.source?.sha256!==pair.source?.sha256||section.source?.width!==pair.source?.width||section.source?.height!==pair.source?.height||canonical(section.calibration)!==canonical(pair.calibration??{um_per_pixel_x:null,um_per_pixel_y:null})){sourcesMatch=false;out.issues.push(prefix+'source identity, calibration or animal split differs from the saved evaluation.');continue;}
      if(section.included!==true)out.issues.push(prefix+'the evaluated section is now excluded; its saved result is historical.');
      if(canonical(section.model??null)!==canonical(pair.model??null))out.issues.push(prefix+'the frozen model/provenance differs from the saved prediction.');
      if(canonical(section.rois.map(annotation))!==canonical(pair.prediction_rois.map(annotation)))out.issues.push(prefix+'prediction geometry, labels or ROI exclusions differ from the saved evaluation.');
      try{for(const layer of LAYERS){const current=selectedROIs({prediction_rois:section.rois,prediction_layer_selection:section.layer_selection},'prediction',layer),saved=selectedROIs(pair,'prediction',layer);if(canonical(current.map(r=>r.name||r.id).sort())!==canonical(saved.map(r=>r.name||r.id).sort()))out.issues.push(prefix+layer+' selection differs from the saved evaluation.');}}catch(error){out.issues.push(prefix+error.message);}
      const savedAnimal=bundle.study?.animals?.find(a=>a.id===pair.animal_id),savedSection=savedAnimal?.sections?.find(s=>s.id===pair.section_id);
      if(savedSection&&(canonical(savedSection.registration??null)!==canonical(section.registration??null)||canonical(savedAnimal.design??null)!==canonical(animal.design??null)))out.issues.push(prefix+'registered coordinate frame or declared study design differs from the saved evaluation.');
    }
    // A paired-study snapshot also binds inclusion and provenance of rows excluded
    // during pairing. Re-enabling such a row must not silently keep the old cohort.
    if(bundle.study?.animals){
      const context=animals=>animals.map(animal=>({id:animal.id,split:animal.split,sections:animal.sections.map(section=>({id:section.id,included:section.included,exclusion_reason:section.exclusion_reason??'',source:section.source,model:section.model??null}))}));
      if(canonical(context(bundle.study.animals))!==canonical(context(study.animals)))out.issues.push('Study section membership, exclusions, source identities or model provenance changed since pairing. Rematch the current prediction study.');
    }
    out.current_sources_match=sourcesMatch&&out.issues.length===0;out.current_input_match=out.current_sources_match;return out;
    }catch(error){out.issues.push('The saved validation input is incomplete or invalid: '+error.message);return out;}
  }
  async function assessReport(report,study,criteria=null){
    const out={status:'unavailable',report_verified:false,current_sources_match:false,current_input_match:false,criteria_met:false,issues:[],scientific_validation:'not_established',limitations:['A recomputed report checks supplied contours and declarations; it does not authenticate training history or establish external generalisation.']};
    if(!report)return out;
    if(report.schema!==REPORT_SCHEMA||!report.input||!report.conditions){out.issues.push('Validation report structure is missing or unsupported.');return out;}
    const recomputed=await evaluateBundle(report.input,report.conditions);
    if(canonical(report)!==canonical(recomputed)){out.status='blocked';out.issues.push('Validation report does not match recomputation from its saved input.');return out;}
    out.report_verified=true;out.report_input_sha256=recomputed.input_sha256;
    const binding=studyBinding(recomputed.input,study);out.current_input_match=binding.current_input_match;
    if(!binding.current_input_match){out.status='historical_or_unbound';out.issues.push(...binding.issues);return out;}
    out.current_sources_match=true;out.status='computed_for_current_sources';
    if(checkSplits(study).status==='blocked'){out.status='blocked';out.issues.push('The current study has duplicate-source or split conflicts.');return out;}
    if(recomputed.summary.independence_status!=='eligible_under_declared_provenance'){out.issues.push('Independent-animal eligibility has not been established under the supplied declarations.');return out;}
    if(recomputed.pairs.some(pair=>pair.prediction_stage!=='model_draft')){out.issues.push('Model validation requires raw model-draft predictions, separate from human-corrected results.');return out;}
    if(!criteria){out.issues.push('No prospectively declared acceptance criteria are attached.');return out;}
    object(criteria,'Validation acceptance criteria');text(criteria.id,'criteria ID');
    if(criteria.registered_before_evaluation!==true){out.issues.push('Acceptance criteria must be declared before evaluation; retrospective selection is not an acceptance test.');return out;}
    if(!Number.isSafeInteger(criteria.minimum_animals)||criteria.minimum_animals<2||criteria.minimum_animals>10000||!finite(criteria.minimum_animal_mean_dice)||criteria.minimum_animal_mean_dice<0||criteria.minimum_animal_mean_dice>1||!Array.isArray(criteria.layers)||!criteria.layers.length||new Set(criteria.layers).size!==criteria.layers.length||criteria.layers.some(l=>!LAYERS.includes(l)))fail('Declare explicit layers, at least two animals, and a Dice threshold from 0 to 1.');
    if(!report.input.acceptance_plan||canonical(report.input.acceptance_plan)!==canonical(criteria)){out.issues.push('The current acceptance plan was not recorded in this evaluation input. Recompute with the frozen plan; retrospective criteria do not complete validation.');return out;}
    out.criteria=clone(criteria);
    for(const layer of criteria.layers){const summary=recomputed.summary.layers[layer];
      if(!summary||summary.scored_animals<criteria.minimum_animals||!finite(summary.animal_mean_dice)||summary.animal_mean_dice<criteria.minimum_animal_mean_dice)out.issues.push(layer+': minimum animal count or animal-mean Dice criterion was not met.');
      if(recomputed.pairs.some(pair=>pair.layers[layer]?.status!=='scored'))out.issues.push(layer+': every evaluated section must have a scored comparison for the declared target layer.');
    }
    out.criteria_met=out.issues.length===0;
    if(out.criteria_met){out.status='criteria_met_under_declared_provenance';out.scientific_validation='measured_against_declared_criteria_only';}
    return out;
  }
  const api=Object.freeze({SCHEMA,REPORT_SCHEMA,VERSION,LAYERS,LIMITS,checkSplits,prepareStudyPairs,evaluatePair,evaluateResolutionSensitivity,aggregate,evaluateBundle,studyBinding,assessReport,fingerprint});
  root.ValidationCore=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:window);
