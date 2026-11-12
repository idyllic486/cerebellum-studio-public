/* Opt-in approximations. Native maps remain immutable, local evidence. */
'use strict';
importScripts('./browser_model_core.js','./auto_roi_model_bundle.js','./raster_candidate_core.js');
let started=false;
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
self.onmessage=async({data:request})=>{
 if(started)return;started=true;
 try{
  const {source,maps,modelFile,reference,blockSize,blockSizes,minimumRegionPixels=0,sharedTissueGrid=false,includePL}=request;
  if(!source||!Number.isInteger(source.width)||!Number.isInteger(source.height)||source.width<1||source.height<1||source.width*source.height>80000000||!modelFile||modelFile.size>BrowserModelCore.LIMITS.modelBytes)throw Error('Invalid candidate source or model evidence.');
  const modelBytes=await modelFile.arrayBuffer(),modelHash=await hash(modelBytes),document=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(modelBytes)),identity=AutoROIModelBundle.validate(document),expected=AutoROIModelBundle.heads(document).map(([head])=>head).sort();
  if(!Array.isArray(maps)||maps.length!==expected.length||maps.map(r=>r.metadata?.head||'primary').sort().join(',')!==expected.join(','))throw Error('All fitted model maps must be retained after bundle contour failure.');
  // Automatic drafts try the finer grid first; a failure publishes nothing from that grid.
  const sizes=Array.isArray(blockSizes)&&blockSizes.length?blockSizes:[blockSize];let rois,heads,lastError=null;
  for(const size of sizes){
   try{
    rois=[];heads=[];let shared=null;
    const ordered=sharedTissueGrid?[...maps].sort((a,b)=>(a.metadata.head==='layers'?0:1)-(b.metadata.head==='layers'?0:1)):maps;
    for(const map of ordered){
     const m=map.metadata,head=m.head||'primary',fitted=AutoROIModelBundle.modelForHead(document,m.head);
     if(m.schema!=='cerebellum-label-map/1'||m.source?.sha256!==source.sha256||m.source.width!==source.width||m.source.height!==source.height||m.source.name!==source.name||m.model?.weights_sha256!==modelHash||m.model.id!==identity.id||m.model.version!==identity.version||JSON.stringify(m.classes)!==JSON.stringify(fitted.classes)||!(map.labels instanceof Blob)||map.labels.size!==source.width*source.height)throw Error('Native label-map evidence is invalid.');
     const labels=new Uint8Array(await map.labels.arrayBuffer());if(await hash(labels)!==m.label_sha256)throw Error('Native label-map pixels do not match their evidence hash.');
     const withPL=includePL===true&&JSON.stringify(m.classes)===JSON.stringify(['background','ML','GL','WM']);
     const result=RasterCandidateCore.create(labels,source.width,source.height,m.classes,{blockSize:size,minimumRegionPixels,sharedGrid:shared,includePL:withPL,onProgress:progress=>postMessage({progress})});
     // The CB outline follows the cleaned layer grid, so tissue ROIs cannot leave CB.
     if(sharedTissueGrid&&head==='layers'&&!shared)shared=result.grid.map(value=>value?1:0);
     rois.push(...result.rois.map(r=>({...r,id:head+'-'+r.id})),...(result.pl_candidate?.rois||[]).map(r=>({...r,id:head+'-'+r.id})));
     heads.push({head,classes:m.classes,native_label_sha256:m.label_sha256,candidate:result.processing,...(result.pl_candidate?{pl_candidate:{...result.pl_candidate,rois:undefined}}:{})});
    }
    if(rois.length>BrowserModelCore.LIMITS.rois||rois.reduce((n,r)=>n+r.paths.reduce((m,p)=>m+p.length,0),0)>BrowserModelCore.LIMITS.vertices)throw Error('Combined model heads exceed the native contour vertex limit. No model head or contour was discarded.');
    lastError=null;break;
   }catch(error){if(/evidence/.test(error.message))throw error;lastError=error;}
  }
  if(lastError)throw lastError;
  postMessage({result:{schema:'cerebellum-prediction/1',source,model:{id:identity.id,version:identity.version,weights_sha256:modelHash,family:identity.family||'experimental-pixel-forest',training_animals:identity.training_animals,training_sources:identity.training_sources},reference,rois,processing:{adapter:'cerebellum-block-majority-candidates',version:RasterCandidateCore.VERSION,status:'unreviewed',approximate:true,heads,counts_not_additive:true,scope:'Explicit approximate review candidates, not exact native predictions. Original maps remain evidence. PL is only an optional ML–GL interface; cortical regions exclude unannotated WM.',measurement:'Candidate geometry in original pixel coordinates. Human review and calibration required.'}}});
 }catch(error){postMessage({error:error.message||String(error)});}
};
