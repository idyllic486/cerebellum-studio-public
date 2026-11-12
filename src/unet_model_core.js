/* Local CPU execution of an explicitly supplied tissue U-Net. Nothing is uploaded.
 * The network sees block-averaged pixels; class probabilities return to native coordinates.
 */
(function(root){
'use strict';
const VERSION='1.0.0',EPSILON=1e-5;
const fail=message=>{throw Error(message);};
function bundleCore(){return root.AutoROIModelBundle||(typeof require==='function'?require('./auto_roi_model_bundle.js'):null);}
function decode(entry,name){
 if(!entry||!Array.isArray(entry.shape)||typeof entry.base64!=='string')fail('U-Net tensor is missing: '+name);
 const binary=root.atob(entry.base64),bytes=new Uint8Array(binary.length);for(let i=0;i<bytes.length;i++)bytes[i]=binary.charCodeAt(i);
 if(bytes.length%4||bytes.length!==entry.shape.reduce((a,b)=>a*b,4))fail('U-Net tensor byte count differs from its shape: '+name);
 const view=new DataView(bytes.buffer),out=new Float32Array(bytes.length/4);for(let i=0;i<out.length;i++){out[i]=view.getFloat32(i*4,true);if(!Number.isFinite(out[i]))fail('U-Net tensor holds a nonfinite value: '+name);}
 return out;
}
// Zero-padded 3×3 convolution. Rows are visited in fixed order, so results are deterministic.
function conv3(input,height,width,channelsIn,channelsOut,weight,bias){
 const plane=height*width,output=new Float32Array(channelsOut*plane);
 for(let o=0;o<channelsOut;o++){
  const baseOut=o*plane;output.fill(bias[o],baseOut,baseOut+plane);
  for(let c=0;c<channelsIn;c++){
   const k=(o*channelsIn+c)*9,w0=weight[k],w1=weight[k+1],w2=weight[k+2],w3=weight[k+3],w4=weight[k+4],w5=weight[k+5],w6=weight[k+6],w7=weight[k+7],w8=weight[k+8],baseIn=c*plane;
   for(let y=0;y<height;y++){
    const at=baseIn+y*width,up=at-width,down=at+width,hasUp=y>0,hasDown=y+1<height,row=baseOut+y*width;
    // Image edges use the zero padding that the fitted network was trained with.
    for(let x=0;x<width;x++){
     const left=x>0,right=x+1<width;let sum=w4*input[at+x];
     if(left)sum+=w3*input[at+x-1];if(right)sum+=w5*input[at+x+1];
     if(hasUp){sum+=w1*input[up+x];if(left)sum+=w0*input[up+x-1];if(right)sum+=w2*input[up+x+1];}
     if(hasDown){sum+=w7*input[down+x];if(left)sum+=w6*input[down+x-1];if(right)sum+=w8*input[down+x+1];}
     output[row+x]+=sum;
    }
   }
  }
 }
 return output;
}
function conv1(input,plane,channelsIn,channelsOut,weight,bias){
 const output=new Float32Array(channelsOut*plane);
 for(let o=0;o<channelsOut;o++){const baseOut=o*plane;output.fill(bias[o],baseOut,baseOut+plane);for(let c=0;c<channelsIn;c++){const k=weight[o*channelsIn+c],baseIn=c*plane;for(let p=0;p<plane;p++)output[baseOut+p]+=k*input[baseIn+p];}}
 return output;
}
function groupNorm(values,height,width,channels,groups,gamma,beta){
 const plane=height*width,per=channels/groups;
 for(let g=0;g<groups;g++){
  let sum=0,square=0;const start=g*per*plane,end=(g+1)*per*plane,count=end-start;
  for(let i=start;i<end;i++){const v=values[i];sum+=v;square+=v*v;}
  const mean=sum/count,scale=1/Math.sqrt(Math.max(0,square/count-mean*mean)+EPSILON);
  for(let c=g*per;c<(g+1)*per;c++){const a=gamma[c],b=beta[c],from=c*plane,to=from+plane;for(let i=from;i<to;i++)values[i]=(values[i]-mean)*scale*a+b;}
 }
 return values;
}
function relu(values){for(let i=0;i<values.length;i++)if(values[i]<0)values[i]=0;return values;}
// Max pooling floors odd sizes, matching the decoder's later resize to the stored skip size.
function maxPool(input,height,width,channels){
 const h=height>>1,w=width>>1,plane=height*width,out=new Float32Array(channels*h*w);
 for(let c=0;c<channels;c++){const base=c*plane,target=c*h*w;for(let y=0;y<h;y++)for(let x=0;x<w;x++){const a=base+2*y*width+2*x;let m=input[a];if(input[a+1]>m)m=input[a+1];if(input[a+width]>m)m=input[a+width];if(input[a+width+1]>m)m=input[a+width+1];out[target+y*w+x]=m;}}
 return{values:out,height:h,width:w};
}
function resizeAxis(from,to){const low=new Int32Array(to),high=new Int32Array(to),weight=new Float32Array(to),ratio=from/to;for(let i=0;i<to;i++){const center=(i+.5)*ratio-.5,floor=Math.floor(center);low[i]=Math.max(0,floor);high[i]=Math.min(from-1,floor+1);weight[i]=center-floor;}return{low,high,weight};}
function resize(input,height,width,channels,toHeight,toWidth){
 const ys=resizeAxis(height,toHeight),xs=resizeAxis(width,toWidth),plane=height*width,out=new Float32Array(channels*toHeight*toWidth);
 for(let c=0;c<channels;c++){const base=c*plane,target=c*toHeight*toWidth;for(let y=0;y<toHeight;y++){const a=base+ys.low[y]*width,b=base+ys.high[y]*width,t=ys.weight[y],row=target+y*toWidth;for(let x=0;x<toWidth;x++){const l=xs.low[x],r=xs.high[x],s=xs.weight[x];out[row+x]=(1-t)*((1-s)*input[a+l]+s*input[a+r])+t*((1-s)*input[b+l]+s*input[b+r]);}}}
 return out;
}
function compile(document){
 const checked=bundleCore().validate(document);if(checked.family!=='experimental-unet')fail('Choose a cerebellum-auto-roi-unet/1 model.');
 const tensors={},get=name=>tensors[name]??=decode(document.tensors[name],name);
 return{checked,classes:document.architecture.classes,base:document.architecture.base_channels,groups:document.architecture.group_norm_groups,input:document.input,inference:document.inference,get};
}
function block(net,prefix,values,height,width,channelsIn,channelsOut){
 const step=(values,index,a,b)=>relu(groupNorm(conv3(values,height,width,a,b,net.get(prefix+'.'+index+'.weight'),net.get(prefix+'.'+index+'.bias')),height,width,b,net.groups,net.get(prefix+'.'+(index+1)+'.weight'),net.get(prefix+'.'+(index+1)+'.bias')));
 return step(step(values,0,channelsIn,channelsOut),3,channelsOut,channelsOut);
}
function forward(net,input,height,width){
 const channels=[net.base,net.base*2,net.base*4,net.base*8,net.base*16],skips=[];let values=input,h=height,w=width,previous=3;
 for(let i=0;i<5;i++){
  if(i){const pooled=maxPool(values,h,w,previous);values=pooled.values;h=pooled.height;w=pooled.width;}
  values=block(net,'d.'+i,values,h,w,previous,channels[i]);previous=channels[i];skips.push({values,height:h,width:w});
 }
 for(let i=3;i>=0;i--){
  const skip=skips[i],up=resize(values,h,w,previous,skip.height,skip.width),joined=new Float32Array(up.length+skip.values.length);joined.set(up,0);joined.set(skip.values,up.length);
  h=skip.height;w=skip.width;values=block(net,'u.'+i,joined,h,w,previous+channels[i],channels[i]);previous=channels[i];skips.length=i;
 }
 return conv1(values,h*w,previous,net.classes.length,net.get('o.weight'),net.get('o.bias'));
}
function softmax(logits,count,plane){
 const out=new Float32Array(logits.length);
 for(let p=0;p<plane;p++){let max=-Infinity;for(let c=0;c<count;c++){const v=logits[c*plane+p];if(v>max)max=v;}let sum=0;for(let c=0;c<count;c++)sum+=Math.exp(logits[c*plane+p]-max);for(let c=0;c<count;c++)out[c*plane+p]=Math.exp(logits[c*plane+p]-max)/sum;}
 return out;
}
// Reads native windows only; only the reduced image is held in memory.
function blockMean(reader,factor,scale,onProgress=()=>{}){
 const height=Math.floor(reader.height/factor),width=Math.floor(reader.width/factor),channels=reader.channels;
 if(height<16||width<16)fail('The image is too small for this model.');
 if(channels!==3||reader.dtype!=='uint8')fail('This model requires unsigned 8-bit RGB pixels. No conversion is inferred.');
 const out=new Float32Array(3*height*width),plane=height*width,cells=32,chunk=factor*cells,divisor=factor*factor,total=Math.ceil(height/cells)*Math.ceil(width/cells);let done=0;
 for(let cy=0;cy<height;cy+=cells)for(let cx=0;cx<width;cx+=cells){
  const ch=Math.min(cells,height-cy),cw=Math.min(cells,width-cx),patch=reader.readWindow(cx*factor,cy*factor,cw*factor,ch*factor);
  if(!(patch instanceof Uint8Array)||patch.length!==cw*factor*ch*factor*3)fail('Native TIFF window has the wrong byte count.');
  for(let y=0;y<ch;y++)for(let x=0;x<cw;x++)for(let c=0;c<3;c++){
   let sum=0;for(let j=0;j<factor;j++){const row=(y*factor+j)*cw*factor;for(let i=0;i<factor;i++)sum+=patch[(row+x*factor+i)*3+c];}
   out[c*plane+(cy+y)*width+cx+x]=Math.floor(sum/divisor+.5)/scale[c];
  }
  onProgress({stage:'reduce',message:'Reading original pixels through bounded native TIFF windows…',completed:++done,total});
 }
 return{values:out,height,width,chunk};
}
function tiledProbabilities(net,reduced,onProgress=()=>{}){
 const {values,height,width}=reduced,{tile,keep}=net.inference,margin=(tile-keep)/2,count=net.classes.length,plane=height*width,out=new Float32Array(count*plane),total=Math.ceil(height/keep)*Math.ceil(width/keep);let done=0;
 for(let y=0;y<height;y+=keep)for(let x=0;x<width;x+=keep){
  const y0=Math.max(0,y-margin),x0=Math.max(0,x-margin),y1=Math.min(height,y+keep+margin),x1=Math.min(width,x+keep+margin),h=y1-y0,w=x1-x0,tp=h*w,input=new Float32Array(3*tp);
  for(let c=0;c<3;c++)for(let j=0;j<h;j++)input.set(values.subarray(c*plane+(y0+j)*width+x0,c*plane+(y0+j)*width+x1),c*tp+j*w);
  const probabilities=softmax(forward(net,input,h,w),count,tp),ch=Math.min(keep,height-y),cw=Math.min(keep,width-x);
  for(let c=0;c<count;c++)for(let j=0;j<ch;j++)out.set(probabilities.subarray(c*tp+(y-y0+j)*w+(x-x0),c*tp+(y-y0+j)*w+(x-x0)+cw),c*plane+(y+j)*width+x);
  onProgress({stage:'inference',message:'Predicting native pixels locally…',completed:++done,total});
 }
 return out;
}
// Bilinear class probabilities become one native label per pixel. Rows and columns past
// the last whole block were never seen by the network and stay background.
function nativeLabels(probabilities,reduced,nativeWidth,nativeHeight,factor,count){
 const {height,width}=reduced,plane=height*width,labels=new Uint8Array(nativeWidth*nativeHeight),H=height*factor,W=width*factor,ys=resizeAxis(height,H),xs=resizeAxis(width,W),scores=new Float32Array(count);
 for(let y=0;y<H;y++){
  const a=ys.low[y]*width,b=ys.high[y]*width,t=ys.weight[y];
  for(let x=0;x<W;x++){
   const l=xs.low[x],r=xs.high[x],s=xs.weight[x];let best=0;
   for(let c=0;c<count;c++){const base=c*plane;scores[c]=(1-t)*((1-s)*probabilities[base+a+l]+s*probabilities[base+a+r])+t*((1-s)*probabilities[base+b+l]+s*probabilities[base+b+r]);if(scores[c]>scores[best])best=c;}
   labels[y*nativeWidth+x]=best;
  }
 }
 return labels;
}
function predict(document,reader,{onProgress=()=>{}}={}){
 const net=compile(document),factor=net.input.block_mean_factor;
 const reduced=blockMean(reader,factor,net.input.scale,onProgress),probabilities=tiledProbabilities(net,reduced,onProgress);
 const layers=nativeLabels(probabilities,reduced,reader.width,reader.height,factor,net.classes.length),cb=new Uint8Array(layers.length);
 for(let i=0;i<layers.length;i++)cb[i]=layers[i]?1:0;
 return{layers,cb,tiles:Math.ceil(reduced.height/net.inference.keep)*Math.ceil(reduced.width/net.inference.keep)};
}
const api=Object.freeze({VERSION,compile,forward,softmax,blockMean,tiledProbabilities,nativeLabels,predict});
root.UNetModelCore=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:window);
