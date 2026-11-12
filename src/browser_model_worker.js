/* Local CPU prediction. Parent cancellation terminates the worker. No network upload. */
'use strict';
importScripts('../vendor/pako.min.js','../vendor/UTIF.js','./research_image.js','./browser_model_core.js','./auto_roi_model_bundle.js','./unet_model_core.js');
let started=false;
const progress=record=>postMessage({progress:record});
const sha256=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
async function bytesFor(file,buffer,max,label){
 const size=file?file.size:buffer?.byteLength;
 if(!Number.isSafeInteger(size)||size<1||size>max)throw Error(label+' is missing or exceeds '+Math.round(max/1024/1024)+' MiB.');
 const bytes=new Uint8Array(file?await file.arrayBuffer():buffer);if(bytes.length!==size)throw Error(label+' byte length changed.');return bytes;
}
self.onmessage=async event=>{
 if(started){postMessage({error:'One inference job per worker is supported. Start a fresh worker.'});return;}started=true;
 try{
  const request=event.data||{};
  progress({stage:'model',message:'Validating the supplied trained model…',completed:0,total:1});
  const modelBytes=await bytesFor(request.modelFile,request.modelBuffer,BrowserModelCore.LIMITS.modelBytes,'Model JSON'),modelHash=await sha256(modelBytes);
  if(request.expectedModelSha256!=null&&request.expectedModelSha256!==modelHash)throw Error('Selected model checksum differs from the expected model.');
  const document=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(modelBytes)),selection=AutoROIModelBundle.validate(document),heads=AutoROIModelBundle.heads(document),model=heads[0][1];
  progress({stage:'source',message:'Validating original TIFF bytes and image identity…',completed:0,total:1});
  const bytes=await bytesFor(request.file,request.buffer,ResearchImage.LIMITS.fileBytes,'Original TIFF'),sourceHash=await sha256(bytes);
  if(request.expectedSourceSha256!=null&&request.expectedSourceSha256!==sourceHash)throw Error('Original TIFF checksum differs from the selected image.');
  const native=ResearchImage.openNativeTIFF(bytes);let image;
  if(native){
   if(native.channels!==(model.input.channels==='gray'?1:3)||native.dtype!==model.input.dtype)throw Error('TIFF channels/dtype/photometric do not match the supplied model. No conversion is inferred.');
   image=native;progress({stage:'decode',message:'Reading original pixels through bounded native TIFF windows…',completed:0,total:1});
  }else{
   const page=ResearchImage.validateTIFF(bytes),channels=model.input.channels==='gray'?1:3,bits=model.input.dtype==='uint8'?8:16;
   if((page.t277?.[0]||1)!==channels||page.t258?.some(x=>x!==bits)||page.t262?.[0]!== (channels===1?1:2))throw Error('TIFF channels/dtype/photometric do not match the supplied model. No conversion is inferred.');
   if(page.t256[0]>BrowserModelCore.LIMITS.dimension||page.t257[0]>BrowserModelCore.LIMITS.dimension)throw Error('Image dimension exceeds the 32767-pixel contour limit.');
   progress({stage:'decode',message:'Decoding full original pixels in the local worker…',completed:0,total:1});ResearchImage.decodeTIFF(bytes,page);image=BrowserModelCore.pixelsFromTIFF(page,model);page.data=null;
  }
  const sourceName=request.sourceName||request.file?.name||'source.tif';if(typeof sourceName!=='string'||!sourceName||sourceName.length>1024)throw Error('Invalid original source filename.');
  const source={name:sourceName,sha256:sourceHash,width:image.width,height:image.height},identity={id:selection.id,version:selection.version,weights_sha256:modelHash},outputs=[];
  // One network supplies both tissue maps, so it runs once; each map keeps its own class list.
  const unet=selection.family==='experimental-unet'?UNetModelCore.predict(document,native||{width:image.width,height:image.height,channels:image.channels,dtype:image.dtype,readWindow(x,y,w,h){const out=new Uint8Array(w*h*3);for(let j=0;j<h;j++)out.set(image.pixels.subarray(((y+j)*image.width+x)*3,((y+j)*image.width+x+w)*3),j*w*3);return out;}},{onProgress:progress}):null;
  for(const [head,fitted]of heads){
   const onProgress=record=>progress({...record,...(selection.isBundle?{head,message:head+' · '+record.message}:{})});
   const prediction=unet?{labels:head==='cb'?unet.cb:unet.layers,tiles:unet.tiles}:native?BrowserModelCore.inferNative(fitted,native,{onProgress}):BrowserModelCore.infer(fitted,image,{onProgress});let geometry=null,failure=null;
   try{geometry=BrowserModelCore.vectorize(prediction.labels,image.width,image.height,fitted.classes,onProgress);}catch(error){failure=error.message;}
   outputs.push({head,model:fitted,prediction,geometry,failure});
  }
  let plCandidate=null;
  if(request.includePL===true){
   const layer=outputs.find(o=>JSON.stringify(o.model.classes)===JSON.stringify(['background','ML','GL','WM']));
   if(layer){try{plCandidate=BrowserModelCore.plInterface(layer.prediction.labels,image.width,image.height);}catch(error){layer.failure=error.message;}}
  }
  let failed=outputs.find(o=>o.failure);
  if(!failed&&outputs.reduce((n,o)=>n+o.geometry.rois.length,plCandidate?.rois.length||0)>BrowserModelCore.LIMITS.rois){failed=outputs[0];failed.failure='Combined model heads exceed 64 connected ROIs. No model head or component was discarded.';}
  if(!failed&&outputs.reduce((n,o)=>n+o.geometry.rois.reduce((m,r)=>m+r.paths.reduce((k,p)=>k+p.length,0),0),plCandidate?.rois.reduce((n,r)=>n+r.paths[0].length,0)||0)>BrowserModelCore.LIMITS.vertices){failed=outputs[0];failed.failure='Combined model heads exceed the native contour vertex limit. No model head or contour was discarded.';}
  if(failed){
   // Preserve every head's native class indices; a failure in one head must not
   // silently erase a successfully inferred second head or manufacture ROIs.
   const rasters=[];
   for(const o of outputs){const metadata={schema:'cerebellum-label-map/1',source,model:identity,classes:o.model.classes,encoding:'uint8 row-major; one original-resolution class index per pixel',label_sha256:await sha256(o.prediction.labels),failure:o.failure||'This head is retained because another model head could not be vectorized: '+failed.head,status:'unreviewed; vectorization failed',adapter_version:BrowserModelCore.VERSION};if(selection.isBundle)metadata.head=o.head;rasters.push({metadata,labels:o.prediction.labels});}
   const raster=rasters[outputs.indexOf(failed)];postMessage(selection.isBundle?{raster,rasters}:{raster},rasters.map(r=>r.labels.buffer));return;
  }
  const rois=outputs.flatMap(o=>o.geometry.rois.map(r=>selection.isBundle?{...r,id:o.head+'-'+r.id}:r)),counts=Object.assign({},...outputs.map(o=>o.geometry.counts));
  const result={schema:'cerebellum-prediction/1',source,model:{...identity,family:selection.family||'experimental-pixel-forest',training_animals:selection.training_animals,training_sources:selection.training_sources},rois,processing:{adapter:unet?'cerebellum-browser-unet':'cerebellum-browser-pixel-forest',version:BrowserModelCore.VERSION,status:'unreviewed',features:model.features,pixel_counts:counts,tiles:outputs.reduce((n,o)=>n+o.prediction.tiles,0),resolution:'Native original pixels; preview is never used for inference.',uncertainty:'Class frequencies are not calibrated anatomical confidence.',scope:'User-supplied experimental model. No Nissl accuracy or automatic approval claim.',measurement:'Exact predicted pixel-cell boundaries; human approval and calibration are still required.'}};
  if(selection.isBundle){result.processing.heads=outputs.map(o=>({head:o.head,classes:o.model.classes,pixel_counts:o.geometry.counts,tiles:o.prediction.tiles}));result.processing.counts_not_additive=true;}
  if(plCandidate){result.rois.push(...plCandidate.rois);result.processing.pl_candidate={...plCandidate,rois:undefined};result.processing.measurement+=' PL is an optional ML–GL interface candidate, not detected Purkinje cells.';}
  postMessage({result});
 }catch(error){postMessage({error:error.message||String(error)});}
};
