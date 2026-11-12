/* Local TIFF worker. No network uploads; only local vendored decoder scripts. */
'use strict';
importScripts('../vendor/pako.min.js','../vendor/UTIF.js','./research_image.js');
self.onmessage=async event=>{
 try{
  const {file,buffer,maxPreview,returnBytes}=event.data;
  const inputSize=file?file.size:buffer?.byteLength;if(!Number.isSafeInteger(inputSize)||inputSize<1||inputSize>ResearchImage.LIMITS.fileBytes)throw Error('TIFF is missing or exceeds the 256 MiB original-file limit.');
  postMessage({progress:'Reading original TIFF bytes…'});
  const bytes=new Uint8Array(file?await file.arrayBuffer():buffer);
  if(bytes.length>ResearchImage.LIMITS.fileBytes)throw Error('TIFF exceeds the 256 MiB original-file limit.');
  postMessage({progress:'Validating TIFF layout and pixel limits…'});
  const native=ResearchImage.openNativeTIFF(bytes);let preview;
  if(native){postMessage({progress:'Reading bounded native pixel windows for display; original coordinates stay unchanged…'});preview=native.preview(maxPreview);}
  else{const page=ResearchImage.validateTIFF(bytes);postMessage({progress:'Decoding original pixels in a background worker…'});ResearchImage.decodeTIFF(bytes,page);postMessage({progress:'Preparing a display preview; original coordinates stay unchanged…'});preview=ResearchImage.previewTIFF(page,maxPreview);page.data=null;}
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  const sha256=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
  const result={...preview,sha256,bytes:returnBytes?bytes:null,preview_method:'Nearest source pixel at each preview-pixel centre; original pixels retained separately.'};
  const transfer=[preview.rgba.buffer];if(returnBytes)transfer.push(bytes.buffer);
  postMessage({result},transfer);
 }catch(error){postMessage({error:error.message||String(error)});}
};
