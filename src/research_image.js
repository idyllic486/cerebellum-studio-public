/* Strict raster preflight around UTIF's permissive decoder. No coordinate transforms. */
(function(root){'use strict';
const MAX_FILE=256*1024*1024, MAX_DECODED=128*1024*1024, MAX_PIXELS=40000000, NATIVE_PIXELS=80000000, NATIVE_WINDOW=64*1024*1024, approved=new WeakMap();
const workerURL=typeof document!=='undefined'&&document.currentScript?new URL('image_loader_worker.js',document.currentScript.src).href:null;
const fail=message=>{throw Error(message);};
function bytesOf(input){if(input instanceof ArrayBuffer)return new Uint8Array(input);if(ArrayBuffer.isView(input))return new Uint8Array(input.buffer,input.byteOffset,input.byteLength);return fail('Invalid image byte format.');}
function tiffHeader(input){const bytes=bytesOf(input),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
const check=(o,n)=>{if(!Number.isSafeInteger(o)||!Number.isSafeInteger(n)||o<0||n<0||o+n>bytes.length)fail('TIFF/EXIF metadata are truncated or out of range.');};
check(0,8);const little=bytes[0]===73&&bytes[1]===73;if(!little&&!(bytes[0]===77&&bytes[1]===77))fail('The TIFF/EXIF byte order cannot be read.');
const u16=o=>{check(o,2);return view.getUint16(o,little);},u32=o=>{check(o,4);return view.getUint32(o,little);};
if(u16(2)!==42)fail('Only Classic TIFF is supported. BigTIFF and other TIFF formats are not supported.');
return {bytes,view,check,little,u16,u32};}
function orientation(input){const h=tiffHeader(input),offset=h.u32(4);h.check(offset,2);if(offset<8)fail('Invalid EXIF IFD offset.');const count=h.u16(offset);if(count>512)fail('Too many EXIF entries.');h.check(offset+2,count*12+4);let found=false;
for(let i=0;i<count;i++){const o=offset+2+i*12;if(h.u16(o)!==274)continue;if(found||h.u16(o+2)!==3||h.u32(o+4)!==1)fail('The EXIF orientation tag is ambiguous or invalid.');found=true;if(h.u16(o+8)!==1)fail('The image EXIF orientation is not the default. Export in the same original coordinate orientation as the ROIs.');}return 1;}
function rasterSize(width,height){if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>MAX_PIXELS)fail('Images of up to 40 million pixels are supported. Check the size before decoding.');}
function validateRasterOrientation(input,extension){const b=bytesOf(input),kind=String(extension).toLowerCase().replace(/^.*\./,'');
if(['jpg','jpeg'].includes(kind)){if(b.length<4||b[0]!==255||b[1]!==216)fail('Invalid JPEG signature.');let i=2,hasSize=false;while(i<b.length){if(b[i++]!==255)fail('Invalid JPEG marker.');while(b[i]===255)i++;const marker=b[i++];if(marker===218||marker===217){if(!hasSize)fail('Missing JPEG image size header.');return 1;}if(marker===1||(marker>=208&&marker<=215))continue;if(i+2>b.length)fail('JPEG metadata are truncated.');const n=b[i]*256+b[i+1];if(n<2||i+n>b.length)fail('Invalid JPEG metadata length.');if(marker>=192&&marker<=207&&![196,200,204].includes(marker)){if(n<8||n!==8+3*b[i+7])fail('Invalid JPEG size header length.');rasterSize(b[i+5]*256+b[i+6],b[i+3]*256+b[i+4]);hasSize=true;}if(marker===225&&n>=8&&String.fromCharCode(...b.subarray(i+2,i+8))==='Exif\0\0')orientation(b.subarray(i+8,i+n));i+=n;}fail('Incomplete JPEG header.');}
else if(kind==='png'){const sig=[137,80,78,71,13,10,26,10];if(b.length<8||!sig.every((v,i)=>b[i]===v))fail('Invalid PNG signature.');const v=new DataView(b.buffer,b.byteOffset,b.byteLength);let i=8,hasSize=false;while(i+12<=b.length){const n=v.getUint32(i,false);if(i+12+n>b.length)fail('Invalid PNG chunk length.');const type=String.fromCharCode(...b.subarray(i+4,i+8));if(i===8&&type!=='IHDR')fail('Missing PNG image size header.');if(type==='IHDR'){if(hasSize||n!==13)fail('Invalid PNG size header length.');rasterSize(v.getUint32(i+8,false),v.getUint32(i+12,false));hasSize=true;}if(type==='eXIf')orientation(b.subarray(i+8,i+8+n));i+=12+n;if(type==='IEND'&&hasSize)return 1;}fail('Incomplete PNG header.');}
else fail('Unsupported raster image format.');}

function validateTIFF(input){if(bytesOf(input).byteLength>128*1024*1024)fail('TIFF exceeds the 128 MiB original-file limit.');const h=tiffHeader(input),{bytes,u16,u32,check}=h,offset=u32(4);if(offset<8)fail('Invalid TIFF IFD offset.');check(offset,2);const count=u16(offset);if(count<1||count>512)fail('The number of TIFF IFD entries is outside the supported range.');check(offset+2,count*12+4);
if(u32(offset+2+count*12)!==0)fail('Multi-page TIFF is not supported. Use single-page TIFF per section.');
const fields=new Map(),sizes={1:1,2:1,3:2,4:4,5:8,7:1,8:2,9:4,10:8,11:4,12:8};let metadataBytes=0;
for(let i=0;i<count;i++){const at=offset+2+i*12,tag=u16(at),type=u16(at+2),n=u32(at+4),size=sizes[type];if(fields.has(tag))fail('Duplicate TIFF tags are not supported.');if(!size||!n||n>1000000)fail('TIFF tag type or value count is outside the supported range.');const len=n*size,pos=len<=4?at+8:u32(at+8);check(pos,len);metadataBytes+=len;if(metadataBytes>32*1024*1024)fail('TIFF metadata are too large.');
if([330,34665,50740,37500].includes(tag))fail('TIFFs containing sub-IFD, EXIF or manufacturer metadata are not supported. Export as a single-page image.');
fields.set(tag,{type,n,pos});}
const values=(tag,fallback)=>{const f=fields.get(tag);if(!f)return fallback;if(![3,4].includes(f.type)||f.n>100000)fail('Invalid TIFF image tag data type or size.');return Array.from({length:f.n},(_,i)=>f.type===3?u16(f.pos+2*i):u32(f.pos+4*i));};
const scalar=(tag,fallback)=>{const a=values(tag, fallback===undefined?undefined:[fallback]);if(!a||a.length!==1)fail('Required TIFF image tags are missing or have multiple values: '+tag);return a[0];};
const width=scalar(256),height=scalar(257),photo=scalar(262),compression=scalar(259,1),samples=scalar(277,1),bits=values(258,[1]),sampleFormat=values(339,[1]),predictor=scalar(317,1);
if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>MAX_PIXELS)fail('TIFF images of up to 40 million pixels are supported.');
if(scalar(274,1)!==1)fail('The TIFF orientation tag is not the default. Export an image in the same original coordinates as the ROIs.');
if(scalar(284,1)!==1)fail('Planar-separated TIFF is not supported. Export an image with interleaved channels.');
if(sampleFormat.some(v=>v!==1)||![1,samples].includes(sampleFormat.length))fail('Floating-point and signed TIFFs are not supported. Retain the original and provide an unsigned-integer display image.');
if(![1,5,8,32773].includes(compression))fail('Unsupported TIFF compression scheme: '+compression);
if(![1,2].includes(predictor)||scalar(266,1)!==1)fail('Unsupported TIFF predictor/fill-order.');
const gray=[0,1].includes(photo)&&samples===1&&bits.length===1&&(bits[0]===8||(photo===1&&bits[0]===16));
const rgb=photo===2&&[3,4].includes(samples)&&bits.length===samples&&bits.every(v=>v===bits[0])&&[8,16].includes(bits[0]);
if(!gray&&!rgb)fail('Unsupported TIFF colour/bit format. Use 8-bit gray/RGB or unsigned 16-bit BlackIsZero gray/RGB.');
if(samples===4){const extra=values(338,[]);if(extra.length!==1||extra[0]!==2)fail('RGBA TIFF supports unassociated alpha only. Separate channels in the source data are not interpreted as alpha.');}
const rowBytes=width*samples*bits[0]/8,decodedBytes=rowBytes*height;if(decodedBytes>MAX_DECODED)fail('TIFF decoding exceeds the memory limit (128 MiB).');
const tiled=fields.has(322)||fields.has(323);let expected,maxBlock,totalBytes;
if(tiled){const tw=scalar(322),th=scalar(323);if(!tw||!th||tw>100000||th>100000)fail('Invalid TIFF tile size.');maxBlock=tw*th*samples*bits[0]/8;expected=Math.ceil(width/tw)*Math.ceil(height/th);totalBytes=maxBlock*expected;
if(predictor!==1)fail('Tiled TIFFs with a predictor cannot be displayed accurately by the current decoder. Export as a strip TIFF.');
if(fields.has(273)||fields.has(279))fail('TIFF tile and strip storage information are duplicated.');
}else{const rows=scalar(278,height);if(!rows)fail('TIFF rows-per-strip must be positive.');expected=Math.ceil(height/rows);maxBlock=rowBytes*Math.min(rows,height);totalBytes=decodedBytes;}
if(maxBlock>MAX_DECODED||totalBytes>MAX_DECODED||expected>100000)fail('TIFF tile/strip decoded size exceeds the limit.');
const offsets=values(tiled?324:273),lengths=values(tiled?325:279);if(!offsets||!lengths||offsets.length!==expected||lengths.length!==expected)fail('TIFF tile/strip count or byte length does not match.');
const blockLengths=[];for(let i=0;i<expected;i++){if(lengths[i]<1)fail('TIFF pixel block is empty.');check(offsets[i],lengths[i]);const need=tiled?maxBlock:rowBytes*Math.min(scalar(278,height),height-i*scalar(278,height));blockLengths.push(need);if(compression===1&&lengths[i]!==need)fail('Uncompressed TIFF pixel byte count does not match.');
// UTIF treats an encoded block as raw whenever its byte length equals the target
// buffer. Reject that ambiguous decoder path instead of displaying compressed bytes.
if(compression!==1&&lengths[i]===(tiled?maxBlock:decodedBytes))fail('This TIFF compressed block conflicts with the decoder’s uncompressed determination. Export as an uncompressed TIFF.');}
if(!root.UTIF)fail('Load the TIFF decoder first.');
const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),pages=root.UTIF.decode(buffer);if(pages.length!==1)fail('Not a single-page TIFF.');
approved.set(pages[0],{bytes:bytes.slice(),maxBlock,totalBytes,compression,blockLengths});return pages[0];}

function decodeTIFF(input,page){const bytes=bytesOf(input),config=approved.get(page);if(!config||bytes.length!==config.bytes.length||bytes.some((v,i)=>v!==config.bytes[i]))fail('Unvalidated TIFF pages cannot be decoded.');
const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),pako=root.pako;let original,expanded=0,blockIndex=0;
if(config.compression===8){if(!pako||typeof pako.Inflate!=='function')fail('Load the Deflate TIFF decoder first.');original=pako.inflate;pako.inflate=(source)=>{const inflater=new pako.Inflate({chunkSize:16384}),chunks=[];let size=0;inflater.onData=chunk=>{size+=chunk.length;expanded+=chunk.length;if(size>config.maxBlock||expanded>config.totalBytes)fail('TIFF Deflate decompressed size exceeds the declared image size.');chunks.push(chunk);};inflater.push(source,true);if(inflater.err||!inflater.ended)fail('TIFF Deflate compressed data cannot be read.');if(size!==config.blockLengths[blockIndex++])fail('TIFF Deflate pixel byte count differs from the declared image size.');const out=new Uint8Array(size);let off=0;for(const chunk of chunks){out.set(chunk,off);off+=chunk.length;}return out;};}
try{root.UTIF.decodeImage(buffer,page);}finally{if(original)pako.inflate=original;}
if(!page.data||!page.data.length)fail('TIFF pixels cannot be interpreted.');approved.delete(page);return page;}
// Downsample for display only, after complete validation/decoding. The original
// coordinate grid and source bytes are never resized. Sampling directly from the
// decoded channels avoids allocating a full-size RGBA buffer and canvas.
function previewTIFF(page,maxPreview=2048){
if(!page.data||!Number.isInteger(maxPreview)||maxPreview<1||maxPreview>4096)fail('Invalid decoded page or preview size.');
const width=page.width,height=page.height,ratio=Math.min(1,maxPreview/Math.max(width,height)),w=Math.max(1,Math.round(width*ratio)),h=Math.max(1,Math.round(height*ratio));
const samples=page.t277?page.t277[0]:1,bits=page.t258[0],pixelBytes=samples*bits/8,source=page.data,data=new Uint8Array(w*h*pixelBytes);
for(let y=0;y<h;y++){const sy=Math.min(height-1,Math.floor((y+.5)*height/h));for(let x=0;x<w;x++){const sx=Math.min(width-1,Math.floor((x+.5)*width/w)),from=(sy*width+sx)*pixelBytes,to=(y*w+x)*pixelBytes;for(let c=0;c<pixelBytes;c++)data[to+c]=source[from+c];}}
const rgba=root.UTIF.toRGBA8({...page,width:w,height:h,t256:[w],t257:[h],data});
if(rgba.length!==w*h*4)fail('TIFF preview dimensions do not match.');
return{width,height,previewWidth:w,previewHeight:h,rgba};}
// Native uncompressed 8-bit strips need no full RGB decoder allocation. The
// original file remains evidence; only requested pixel windows are copied.
// Unsupported legacy layouts return null, malformed native layouts fail closed.
function openNativeTIFF(input){
 const bytes=bytesOf(input);if(bytes.length>MAX_FILE)fail('TIFF exceeds the 256 MiB original-file limit.');
 const h=tiffHeader(bytes),{u16,u32,check}=h,offset=u32(4);if(offset<8)fail('Invalid TIFF IFD offset.');check(offset,2);
 const count=u16(offset);if(count<1||count>512)fail('Invalid TIFF IFD entry count.');check(offset+2,count*12+4);
 if(u32(offset+2+count*12)!==0)fail('Multi-page TIFF is not supported.');
 const fields=new Map(),ranges=[[0,8],[offset,offset+2+count*12+4]],sizes={1:1,2:1,3:2,4:4,5:8,7:1,8:2,9:4,10:8,11:4,12:8};let metadata=0;
 for(let i=0;i<count;i++){const at=offset+2+i*12,tag=u16(at),type=u16(at+2),n=u32(at+4),size=sizes[type];
  if(fields.has(tag)||!size||!n||n>1000000)fail('Duplicate or unsupported TIFF metadata.');
  const length=n*size,pos=length<=4?at+8:u32(at+8);check(pos,length);metadata+=length;if(metadata>32*1024*1024)fail('TIFF metadata are too large.');
  if(length>4)ranges.push([pos,pos+length]);fields.set(tag,{type,n,pos});
 }
 const values=(tag,fallback)=>{const f=fields.get(tag);if(!f)return fallback;if(![3,4].includes(f.type)||f.n>100000)fail('Invalid TIFF image tag type/count.');return Array.from({length:f.n},(_,i)=>f.type===3?u16(f.pos+2*i):u32(f.pos+4*i));};
 const scalar=(tag,fallback)=>{const a=values(tag,fallback===undefined?undefined:[fallback]);if(!a||a.length!==1)fail('Missing or repeated TIFF image tag: '+tag);return a[0];};
 const compression=scalar(259,1),channels=scalar(277,1),bits=values(258,[1]),photo=scalar(262);
 if(compression!==1||![1,3].includes(channels)||bits.length!==channels||bits.some(b=>b!==8)||photo!==(channels===1?1:2)||fields.has(322)||fields.has(323))return null;
 const width=scalar(256),height=scalar(257),rows=scalar(278,height),formats=values(339,[1]);
 if(width<1||height<1||width>32767||height>32767||width*height>NATIVE_PIXELS)fail('Native strip TIFF exceeds 80 million pixels or 32767 pixels per axis.');
 if(!rows||scalar(274,1)!==1||scalar(284,1)!==1||scalar(317,1)!==1||scalar(266,1)!==1||formats.some(v=>v!==1)||![1,channels].includes(formats.length))fail('Native strip TIFF requires unsigned interleaved pixels in unchanged top-left orientation.');
 if([330,34665,50740,37500].some(tag=>fields.has(tag)))fail('Nested TIFF metadata are unsupported.');
 const offsets=values(273),lengths=values(279),expected=Math.ceil(height/rows),rowBytes=width*channels;
 if(!offsets||!lengths||expected>100000||offsets.length!==expected||lengths.length!==expected)fail('TIFF strip inventory differs from its image grid.');
 const strips=[];
 for(let i=0;i<expected;i++){const need=Math.min(rows,height-i*rows)*rowBytes;if(lengths[i]!==need)fail('Uncompressed TIFF strip byte count differs.');check(offsets[i],need);const start=offsets[i],end=start+need;if(ranges.some(([a,b])=>start<b&&end>a))fail('TIFF pixels overlap metadata.');strips.push([start,end]);}
 strips.sort((a,b)=>a[0]-b[0]);for(let i=1;i<strips.length;i++)if(strips[i][0]<strips[i-1][1])fail('TIFF pixel strips overlap.');
 function readWindow(x,y,w,hh){
  if(![x,y,w,hh].every(Number.isSafeInteger)||x<0||y<0||w<1||hh<1||x+w>width||y+hh>height||w*hh*channels>NATIVE_WINDOW)fail('Invalid or oversized native TIFF window.');
  const out=new Uint8Array(w*hh*channels);for(let j=0;j<hh;j++){const yy=y+j,strip=Math.floor(yy/rows),start=offsets[strip]+((yy-strip*rows)*width+x)*channels;out.set(bytes.subarray(start,start+w*channels),j*w*channels);}return out;
 }
 function preview(maxPreview=2048){
  if(!Number.isInteger(maxPreview)||maxPreview<1||maxPreview>4096)fail('Invalid preview size.');
  const ratio=Math.min(1,maxPreview/Math.max(width,height)),w=Math.max(1,Math.round(width*ratio)),hh=Math.max(1,Math.round(height*ratio)),rgba=new Uint8Array(w*hh*4);
  for(let y=0;y<hh;y++){const sy=Math.min(height-1,Math.floor((y+.5)*height/hh)),row=readWindow(0,sy,width,1);for(let x=0;x<w;x++){const sx=Math.min(width-1,Math.floor((x+.5)*width/w)),from=sx*channels,to=(y*w+x)*4;rgba[to]=row[from];rgba[to+1]=row[from+(channels===3?1:0)];rgba[to+2]=row[from+(channels===3?2:0)];rgba[to+3]=255;}}
  return{width,height,previewWidth:w,previewHeight:hh,rgba};
 }
 return Object.freeze({width,height,channels,dtype:'uint8',readWindow,preview,windowBytesLimit:NATIVE_WINDOW,method:'native uncompressed TIFF strip windows; no full decoded RGB allocation'});
}
function loadTIFF(input,{maxPreview=2048,signal,onProgress,returnBytes=true}={}){
return new Promise((resolve,reject)=>{if(!workerURL||typeof Worker==='undefined')return reject(Error('This browser cannot run the local TIFF decoder. Use a current desktop browser.'));
const abortError=()=>new DOMException('Image loading cancelled.','AbortError');if(signal?.aborted)return reject(abortError());
const size=input instanceof Blob?input.size:bytesOf(input).byteLength;if(size>MAX_FILE)return reject(Error('TIFF exceeds the 256 MiB original-file limit.'));
const worker=new Worker(workerURL),stop=()=>{worker.terminate();signal?.removeEventListener('abort',abort);},abort=()=>{stop();reject(abortError());};signal?.addEventListener('abort',abort,{once:true});
worker.onerror=e=>{stop();reject(Error(e.message||'The local TIFF decoder failed.'));};
worker.onmessage=e=>{const m=e.data;if(m.progress){if(onProgress)onProgress(m.progress);return;}stop();if(m.error)reject(Error(m.error));else resolve(m.result);};
try{if(input instanceof Blob)worker.postMessage({file:input,maxPreview,returnBytes});else{const view=bytesOf(input),buffer=view.byteOffset===0&&view.byteLength===view.buffer.byteLength?view.buffer:view.slice().buffer;worker.postMessage({buffer,maxPreview,returnBytes},[buffer]);}}catch(e){stop();reject(e);}
});}
const api=Object.freeze({validateTIFF,decodeTIFF,validateRasterOrientation,previewTIFF,openNativeTIFF,loadTIFF,LIMITS:Object.freeze({fileBytes:MAX_FILE,pixels:MAX_PIXELS,decodedBytes:MAX_DECODED,nativePixels:NATIVE_PIXELS,nativeWindowBytes:NATIVE_WINDOW})});root.ResearchImage=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:window);
