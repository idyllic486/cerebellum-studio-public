/* Experimental, local-only inference for explicitly supplied supervised models.
 * Feature semantics match scripts/nissl_lab.py; no pretrained anatomy is bundled.
 */
(function(root){
'use strict';
const VERSION='1.0.0',FEATURES='raw+gaussian_mean_std_sigma1_sigma3_reflect_truncate4/1';
const LIMITS=Object.freeze({modelBytes:64*1024*1024,pixels:40000000,nativePixels:80000000,dimension:32767,decodedBytes:128*1024*1024,trees:64,nodes:100000,rois:64,rings:128,verticesPerROI:5000,vertices:30000,edges:2000000});
const LOBULE_NAMES=Object.freeze(['2Cb','3Cb','4-5Cb','6Cb','7Cb','8Cb','9Cb','10Cb','Sim','Crus1','Crus2','PM','Cop','Fl','FI','PFl','PFI']);
function supportedClasses(classes){if(JSON.stringify(classes)===JSON.stringify(['background','CB'])||JSON.stringify(classes)===JSON.stringify(['background','ML','GL','WM']))return true;return Array.isArray(classes)&&classes.length>=2&&classes.length<=LOBULE_NAMES.length+1&&classes[0]==='background'&&new Set(classes).size===classes.length&&classes.slice(1).every(name=>typeof name==='string'&&name.startsWith('LOBULE_')&&LOBULE_NAMES.includes(name.slice(7)));}
const fail=message=>{throw Error(message);},finite=x=>typeof x==='number'&&Number.isFinite(x),f32=Math.fround;
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function validateModel(model){
 if(!model||typeof model!=='object'||model.schema!=='cerebellum-pixel-forest/1')fail('Use a cerebellum-pixel-forest/1 model trained with Local Lab.');
 if(typeof model.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(model.id)||typeof model.version!=='string'||!model.version||model.version.length>100)fail('Model identity/version is missing or invalid.');
 if(model.features!==FEATURES)fail('The model feature definition is unsupported.');
 if(!supportedClasses(model.classes))fail('Declare supported tissue classes or named cortical-region classes.');
 const input=model.input||{},channels=input.channels==='gray'?1:input.channels==='RGB'?3:0;
 if(!channels||!['uint8','uint16'].includes(input.dtype)||!Array.isArray(input.scale)||input.scale.length!==channels||input.scale.some(x=>!finite(x)||!Number.isFinite(f32(x))||f32(x)<=0))fail('Invalid explicit model input channels, dtype or normalization scale.');
 const animals=model.training_animals,sources=model.training_sources;
 if(!Array.isArray(animals)||!animals.length||animals.length>500||animals.some(x=>typeof x!=='string'||!x||x.length>101)||new Set(animals).size!==animals.length)fail('Training-animal provenance is required.');
 if(!Array.isArray(sources)||!sources.length||sources.length>500||sources.some(s=>!s||!animals.includes(s.animal_id)||!sha(s.source_sha256)||!sha(s.label_sha256))||new Set(sources.map(s=>s.animal_id)).size!==animals.length)fail('Training-source provenance is incomplete.');
 if(!Array.isArray(model.trees)||!model.trees.length||model.trees.length>LIMITS.trees)fail('Invalid model tree count.');
 let total=0;
 for(const tree of model.trees){
  const n=tree?.left?.length;total+=n||0;
  if(!Array.isArray(tree?.left)||!n||total>LIMITS.nodes||['right','feature','threshold','probabilities'].some(k=>!Array.isArray(tree[k])||tree[k].length!==n))fail('Model node limit exceeded or tree arrays differ in length.');
  const seen=new Set(),stack=[[0,0]];
  while(stack.length){
   const [i,depth]=stack.pop();if(seen.has(i)||!Number.isInteger(i)||i<0||i>=n||depth>32)fail('Tree has cycles, shared children, invalid indices or excessive depth.');seen.add(i);
   const l=tree.left[i],r=tree.right[i],feature=tree.feature[i],p=tree.probabilities[i];
   if(![l,r,feature].every(Number.isInteger)||!finite(tree.threshold[i])||!Array.isArray(p)||p.length!==model.classes.length||p.some(x=>!finite(x)||x<0||x>1)||Math.abs(p.reduce((a,b)=>a+b,0)-1)>1e-6)fail('Invalid tree node or class frequencies.');
   if(l===-1){if(r!==-1||feature!==-2)fail('Malformed tree leaf.');}
   else {if(l<0||r<0||l>=n||r>=n||l===r||feature<0||feature>=channels*5)fail('Invalid tree decision.');stack.push([l,depth+1],[r,depth+1]);}
  }
  if(seen.size!==n)fail('Model has unreachable nodes.');
 }
 return model;
}
function validatePixels(pixels,width,height,channels,dtype){
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>LIMITS.dimension||height>LIMITS.dimension||width*height>LIMITS.pixels)fail('Image exceeds 40 million pixels or 32767 pixels per axis.');
 if(![1,3].includes(channels)||!['uint8','uint16'].includes(dtype)||!(dtype==='uint8'?pixels instanceof Uint8Array:pixels instanceof Uint16Array)||pixels.length!==width*height*channels||pixels.byteLength>LIMITS.decodedBytes)fail('Decoded image channels/dtype/size differ from the explicit model input.');
}
function pixelsFromTIFF(page,model){
 validateModel(model);const channels=model.input.channels==='gray'?1:3,dtype=model.input.dtype,bits=dtype==='uint8'?8:16;
 if((page.t277?.[0]||1)!==channels||page.t258?.some(x=>x!==bits)||page.t262?.[0]!== (channels===1?1:2))fail('TIFF differs from model channels/dtype/photometric. No color conversion, alpha removal or inversion is inferred.');
 if(!page.data||page.data.length!==page.width*page.height*channels*(bits/8))fail('Decoded TIFF byte count differs from its image grid.');
 let pixels=new Uint8Array(page.data.buffer,page.data.byteOffset,page.data.byteLength);
 if(bits===16){pixels=new Uint16Array(page.width*page.height*channels);const view=new DataView(page.data.buffer,page.data.byteOffset,page.data.byteLength);for(let i=0;i<pixels.length;i++)pixels[i]=view.getUint16(i*2,true);}
 validatePixels(pixels,page.width,page.height,channels,dtype);return {pixels,width:page.width,height:page.height,channels,dtype};
}
function reflect(i,n){if(n===1)return 0;const period=2*n;i=((i%period)+period)%period;return i<n?i:period-1-i;}
function kernel(sigma){const radius=4*sigma,a=[];let sum=0;for(let i=-radius;i<=radius;i++){const v=Math.exp(-0.5*i*i/(sigma*sigma));a.push(v);sum+=v;}return a.map(x=>x/sum);}
function gaussian(input,width,height,channels,sigma){
 const weights=kernel(sigma),radius=4*sigma,intermediate=new Float32Array(input.length),output=new Float32Array(input.length);
 // scipy.ndimage.gaussian_filter processes Y then X, with float32 after each axis.
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let c=0;c<channels;c++){
  const i=(y*width+x)*channels+c;let sum=weights[radius]*input[i];
  for(let k=1;k<=radius;k++)sum+=weights[radius+k]*(input[(reflect(y-k,height)*width+x)*channels+c]+input[(reflect(y+k,height)*width+x)*channels+c]);
  intermediate[i]=sum;
 }
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let c=0;c<channels;c++){
  const i=(y*width+x)*channels+c;let sum=weights[radius]*intermediate[i];
  for(let k=1;k<=radius;k++)sum+=weights[radius+k]*(intermediate[(y*width+reflect(x-k,width))*channels+c]+intermediate[(y*width+reflect(x+k,width))*channels+c]);
  output[i]=sum;
 }
 return output;
}
function features(pixels,width,height,channels,scale){
 if(!Array.isArray(scale)||scale.length!==channels||scale.some(x=>!finite(x)||!Number.isFinite(f32(x))||f32(x)<=0))fail('Invalid feature normalization.');
 const raw=new Float32Array(pixels.length),square=new Float32Array(pixels.length),out=new Float32Array(pixels.length*5);
 for(let i=0;i<raw.length;i++){raw[i]=pixels[i]/f32(scale[i%channels]);if(!Number.isFinite(raw[i]))fail('Normalization produces nonfinite input features.');square[i]=f32(raw[i]*raw[i]);if(!Number.isFinite(square[i]))fail('Normalization overflows float32 texture features.');}
 for(let p=0;p<width*height;p++)for(let c=0;c<channels;c++)out[p*channels*5+c]=raw[p*channels+c];
 for(let s=0;s<2;s++){
  const mean=gaussian(raw,width,height,channels,s?3:1),moment=gaussian(square,width,height,channels,s?3:1);
  for(let p=0;p<width*height;p++)for(let c=0;c<channels;c++){
   const i=p*channels+c,base=p*channels*5+(1+s*2)*channels+c;
   out[base]=mean[i];out[base+channels]=Math.sqrt(Math.max(0,f32(moment[i]-f32(mean[i]*mean[i]))));
  }
 }
 return out;
}
function infer(model,image,{tileSize=128,onProgress=()=>{}}={}){
 validateModel(model);const {pixels,width,height,channels,dtype}=image;
 validatePixels(pixels,width,height,channels,dtype);
 if(channels!==(model.input.channels==='gray'?1:3)||dtype!==model.input.dtype)fail('Image does not match model input.');
 if(!Number.isInteger(tileSize)||tileSize<8||tileSize>256)fail('Inference tile size must be 8–256 pixels.');
 const labels=new Uint8Array(width*height),total=Math.ceil(width/tileSize)*Math.ceil(height/tileSize),featureCount=channels*5;let done=0;
 const trees=model.trees.map(t=>({left:Int32Array.from(t.left),right:Int32Array.from(t.right),feature:Int16Array.from(t.feature),threshold:Float64Array.from(t.threshold),probabilities:t.probabilities}));
 for(let y=0;y<height;y+=tileSize)for(let x=0;x<width;x+=tileSize){
  const sy=Math.max(0,y-12),sx=Math.max(0,x-12),ex=Math.min(width,x+tileSize+12),ey=Math.min(height,y+tileSize+12),w=ex-sx,h=ey-sy;
  const patch=new pixels.constructor(w*h*channels);for(let py=0;py<h;py++)patch.set(pixels.subarray(((sy+py)*width+sx)*channels,((sy+py)*width+ex)*channels),py*w*channels);
  const values=features(patch,w,h,channels,model.input.scale),votes=new Float64Array(model.classes.length);
  for(let py=y;py<Math.min(height,y+tileSize);py++)for(let px=x;px<Math.min(width,x+tileSize);px++){
   const offset=((py-sy)*w+px-sx)*featureCount;votes.fill(0);
   for(const t of trees){let node=0;while(t.left[node]!==-1)node=values[offset+t.feature[node]]<=t.threshold[node]?t.left[node]:t.right[node];const p=t.probabilities[node];for(let c=0;c<votes.length;c++)votes[c]+=p[c];}
   let label=0;for(let c=1;c<votes.length;c++)if(votes[c]>votes[label])label=c;labels[py*width+px]=label;
  }
  onProgress({stage:'inference',message:'Predicting native pixels locally…',completed:++done,total});
 }
 return {labels,tiles:done};
}
// A native reader supplies small unchanged-coordinate windows; source pixels are
// never replaced by the display preview or an independently padded tile.
function inferNative(model,reader,{tileSize=128,onProgress=()=>{}}={}){
 validateModel(model);const {width,height,channels,dtype}=reader;
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>LIMITS.dimension||height>LIMITS.dimension||width*height>LIMITS.nativePixels||typeof reader.readWindow!=='function')fail('Invalid native image grid or window reader.');
 if(channels!==(model.input.channels==='gray'?1:3)||dtype!==model.input.dtype||dtype!=='uint8')fail('Native TIFF windows do not match the supplied model input.');
 if(!Number.isInteger(tileSize)||tileSize<8||tileSize>256)fail('Inference tile size must be 8–256 pixels.');
 const rawOnly=model.trees.every(t=>t.feature.every(f=>f<channels)),featureCount=channels*(rawOnly?1:5);
 const labels=new Uint8Array(width*height),total=Math.ceil(width/tileSize)*Math.ceil(height/tileSize);let done=0;
 const trees=model.trees.map(t=>({left:Int32Array.from(t.left),right:Int32Array.from(t.right),feature:Int16Array.from(t.feature),threshold:Float64Array.from(t.threshold),probabilities:t.probabilities}));
 for(let y=0;y<height;y+=tileSize)for(let x=0;x<width;x+=tileSize){
  const sy=Math.max(0,y-12),sx=Math.max(0,x-12),ex=Math.min(width,x+tileSize+12),ey=Math.min(height,y+tileSize+12),w=ex-sx,h=ey-sy;
  const patch=reader.readWindow(sx,sy,w,h);if(!(patch instanceof Uint8Array)||patch.length!==w*h*channels)fail('Native TIFF window has the wrong byte count.');
  let values;if(rawOnly){values=new Float32Array(patch.length);for(let i=0;i<patch.length;i++){values[i]=patch[i]/f32(model.input.scale[i%channels]);if(!Number.isFinite(values[i]))fail('Normalization produces nonfinite input features.');if(!Number.isFinite(f32(values[i]*values[i])))fail('Normalization overflows float32 texture features.');}}else values=features(patch,w,h,channels,model.input.scale);
  const votes=new Float64Array(model.classes.length);
  for(let py=y;py<Math.min(height,y+tileSize);py++)for(let px=x;px<Math.min(width,x+tileSize);px++){
   const offset=((py-sy)*w+px-sx)*featureCount;votes.fill(0);
   for(const t of trees){let node=0;while(t.left[node]!==-1)node=values[offset+t.feature[node]]<=t.threshold[node]?t.left[node]:t.right[node];const p=t.probabilities[node];for(let c=0;c<votes.length;c++)votes[c]+=p[c];}
   let label=0;for(let c=1;c<votes.length;c++)if(votes[c]>votes[label])label=c;labels[py*width+px]=label;
  }
  onProgress({stage:'inference',message:'Predicting bounded native TIFF windows locally…',completed:++done,total});
 }
 return{labels,tiles:done};
}
function vectorize(labels,width,height,classes,onProgress=()=>{}){
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>LIMITS.dimension||height>LIMITS.dimension||width*height>LIMITS.nativePixels||!(labels instanceof Uint8Array)||labels.length!==width*height)fail('Invalid or oversized native label grid.');
 if(!supportedClasses(classes))fail('Invalid predicted class mapping.');
 if(labels.some(value=>value>=classes.length))fail('Unknown predicted class index; no label is silently ignored.');
 const visited=new Uint8Array(labels.length),rois=[],counts={};let totalVertices=0;
 for(let c=1;c<classes.length;c++){
  const name=classes[c];let component=0,pixelCount=0;
  for(let index=0;index<labels.length;index++){
   if(labels[index]!==c||visited[index])continue;
   if(rois.length>=LIMITS.rois)fail('More than 64 connected ROIs. No islands were discarded; review the model/noise.');
   const outgoing=new Map(),stack=[index],stride=width+1;let count=0;
   const edge=(x1,y1,x2,y2)=>{const a=y1*stride+x1,b=y2*stride+x2;if(outgoing.has(a))fail('A mask component has a diagonal pinch/touching boundary. No topology was altered.');outgoing.set(a,b);if(outgoing.size>LIMITS.edges)fail('Mask boundary exceeds 2 million pixel edges; no components were discarded.');};
   while(stack.length){
    const current=stack.pop();if(visited[current]||labels[current]!==c)continue;
    const y=Math.floor(current/width);let x=current%width;
    while(x>0&&!visited[y*width+x-1]&&labels[y*width+x-1]===c)x--;
    let above=false,below=false;
    for(;x<width&&!visited[y*width+x]&&labels[y*width+x]===c;x++){
     const at=y*width+x;visited[at]=1;count++;
     const up=y>0&&labels[at-width]===c,down=y+1<height&&labels[at+width]===c;
     if(!up)edge(x,y,x+1,y);if(x+1===width||labels[at+1]!==c)edge(x+1,y,x+1,y+1);if(!down)edge(x+1,y+1,x,y+1);if(x===0||labels[at-1]!==c)edge(x,y+1,x,y);
     const addAbove=up&&!visited[at-width],addBelow=down&&!visited[at+width];
     if(addAbove&&!above)stack.push(at-width);if(addBelow&&!below)stack.push(at+width);above=addAbove;below=addBelow;
     if(stack.length>LIMITS.edges)fail('Mask component traversal exceeds its complexity bound; no components were discarded.');
    }
   }
   const paths=[];let vertices=0,area=0;
   while(outgoing.size){
    const first=outgoing.keys().next().value,points=[first];let next=outgoing.get(first);outgoing.delete(first);
    while(next!==first){points.push(next);if(!outgoing.has(next))fail('Mask boundary is not a simple closed contour.');const value=outgoing.get(next);outgoing.delete(next);next=value;}
    const ring=[];
    for(let i=0;i<points.length;i++){
     const a=points[(i+points.length-1)%points.length],b=points[i],d=points[(i+1)%points.length];
     const ax=a%stride,ay=Math.floor(a/stride),bx=b%stride,by=Math.floor(b/stride),dx=d%stride,dy=Math.floor(d/stride);
     if((bx-ax)*(dy-by)!==(by-ay)*(dx-bx))ring.push([bx,by]);
    }
    if(ring.length<4)fail('Degenerate pixel-cell contour.');vertices+=ring.length;
    if(paths.length>=LIMITS.rings||vertices>LIMITS.verticesPerROI||totalVertices+vertices>LIMITS.vertices)fail('Contour complexity exceeds 128 rings/5000 vertices per ROI/30000 total. No rings or islands were discarded.');
    for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length];area+=(a[0]*b[1]-b[0]*a[1])/2;}
    paths.push(ring);
   }
   if(area!==count)fail('Exported polygon area differs from native predicted pixels.');
   totalVertices+=vertices;pixelCount+=count;const roi={id:name+'-'+String(++component).padStart(3,'0'),label:name,paths};if(name.startsWith('LOBULE_')){const region=name.slice(7);Object.assign(roi,{label:'OTHER',kind:'area',closed:true,region,name:'Lobule '+region+' · annotated cortex '+component,metadata:{anatomy_scope:'ML+GL annotated cortical subregions; not whole lobule',model_class:name}});}rois.push(roi);
   onProgress({stage:'contours',message:'Preserving predicted components and holes…',completed:rois.length,total:null});
  }
  counts[name]=pixelCount;
 }
 if(!rois.length)fail('Model predicted background only. No ROI or approved measurement was fabricated.');
 return {rois,counts};
}
// Geometric review aid only: these shared pixel edges do not establish Purkinje identity.
function plInterface(labels,width,height){
 if(!(labels instanceof Uint8Array)||!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>LIMITS.dimension||height>LIMITS.dimension||labels.length!==width*height||labels.length>LIMITS.nativePixels)fail('Invalid native layer grid for an ML–GL interface candidate.');
 if(labels.some(value=>value>3))fail('ML–GL interface candidates require background/ML/GL/WM class indices.');
 const stride=width+1,edges=[],adj=new Map(),pair=(a,b)=>(a===1&&b===2)||(a===2&&b===1);
 const add=(a,b)=>{if(edges.length>=LIMITS.edges)fail('ML–GL interface exceeds the bounded edge budget; no branches were discarded.');const i=edges.length;edges.push([a,b]);for(const p of [a,b]){if(!adj.has(p))adj.set(p,[]);adj.get(p).push(i);}};
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*width+x;if(x+1<width&&pair(labels[i],labels[i+1]))add(y*stride+x+1,(y+1)*stride+x+1);if(y+1<height&&pair(labels[i],labels[i+width]))add((y+1)*stride+x,(y+1)*stride+x+1);}
 if(!edges.length)return{rois:[],edge_count:0,total_length_px:0,scope:'ML–GL interface candidate; Purkinje identity is not established.'};
 const visited=new Uint8Array(edges.length),chains=[];let traced=0;
 const trace=(start,first)=>{const chain=[start];let at=start,index=first;while(!visited[index]){visited[index]=1;traced++;const edge=edges[index],next=edge[0]===at?edge[1]:edge[0];chain.push(next);if(next===start||adj.get(next).length!==2)break;const neighbors=adj.get(next);index=neighbors[0]===index?neighbors[1]:neighbors[0];at=next;}if(chain[0]===chain[chain.length-1]){const middle=Math.floor((chain.length-1)/2);chains.push(chain.slice(0,middle+1),chain.slice(middle));}else chains.push(chain);if(chains.length>LIMITS.rois)fail('ML–GL interface has too many separate branches; no branches were discarded.');};
 for(const [node,indices]of adj)if(indices.length!==2)for(const index of indices)if(!visited[index])trace(node,index);
 for(let index=0;index<edges.length;index++)if(!visited[index])trace(edges[index][0],index);
 if(traced!==edges.length)fail('ML–GL interface tracing did not preserve every shared edge.');
 let vertices=0,length=0;
 const rois=chains.map((chain,index)=>{const path=chain.map(point=>[point%stride,Math.floor(point/stride)]).filter((point,i,all)=>i===0||i===all.length-1||(point[0]-all[i-1][0])*(all[i+1][1]-point[1])!==(point[1]-all[i-1][1])*(all[i+1][0]-point[0]));vertices+=path.length;if(path.length>LIMITS.verticesPerROI||vertices>LIMITS.vertices)fail('ML–GL interface exceeds the bounded vertex budget; no path was shortened.');for(let i=1;i<path.length;i++)length+=Math.hypot(path[i][0]-path[i-1][0],path[i][1]-path[i-1][1]);return{id:'pl-interface-'+String(index+1).padStart(3,'0'),label:'PL',kind:'polyline',closed:false,name:'ML–GL interface candidate '+(index+1),paths:[path],metadata:{derived_from:'ML–GL interface',candidate_only:true,purkinje_identity_established:false,source_classes:['background','ML','GL','WM']}};});
 if(length!==edges.length)fail('ML–GL interface length differs from its preserved pixel edges.');
 return{rois,edge_count:edges.length,total_length_px:length,scope:'ML–GL interface candidate; Purkinje identity is not established.'};
}

const api=Object.freeze({VERSION,FEATURES,LIMITS,LOBULE_NAMES,supportedClasses,validateModel,validatePixels,pixelsFromTIFF,features,infer,inferNative,vectorize,plInterface});
root.BrowserModelCore=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:window);
