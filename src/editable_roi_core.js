/* ROI polygons a person can correct in ImageJ or Fiji, and the way back. ImageJ lets the vertices of polygons and
   polylines be dragged, but not those of traced outlines or composites. This module writes Cb, GL+WM and WM as one
   simplified polygon per separate part and hole, and rebuilds the layers from corrected polygons: ML is Cb outside
   GL+WM, GL is GL+WM outside WM, and the Purkinje band is taken out of ML. It follows scripts/roi_editable.py step for
   step, so both give the same polygons for the same ROIs. Pure functions; nothing is measured or approved here. */
(function(root){'use strict';
const OUTLINES=Object.freeze(['Cb','GL+WM','WM']);
const PARAMETERS=Object.freeze({status:'proposed',simplify_tolerance_px:1.5,min_part_area_px:16,min_hole_area_px:16,drop_secondary_parts_below_um2:10000});
const LIMITS=Object.freeze({pixels:80000000,polygon_vertices:65535});
function fail(message){throw new Error(message);}
// Pixels whose centre lies inside the paths by the even-odd rule; `bit` is OR-ed into the mask.
function rasterInto(mask,width,height,paths,bit){
 const toggles=new Uint8Array((width+1)*height);
 for(const path of paths){const n=path.length;for(let i=0;i<n;i++){const a=path[i],b=path[(i+1)%n],x0=a[0],y0=a[1],x1=b[0],y1=b[1];
  const first=Math.min(height,Math.max(0,Math.ceil(Math.min(y0,y1)-.5))),last=Math.min(height,Math.max(0,Math.ceil(Math.max(y0,y1)-.5)));
  for(let row=first;row<last;row++){const cross=x0+(row+.5-y0)*(x1-x0)/(y1-y0),column=Math.min(width,Math.max(0,Math.ceil(cross-.5)));toggles[row*(width+1)+column]^=1;}}}
 for(let y=0;y<height;y++){let inside=0;const t=y*(width+1),m=y*width;for(let x=0;x<width;x++){inside^=toggles[t+x];if(inside)mask[m+x]|=bit;}}
}
// Pixel-edge outlines of the pixels where (mask & bits) is set. Each boundary edge is walked with the mask on its right; where
// two pixels meet only at a corner the walk turns right, so 4-connected parts stay separate. Collinear vertices are dropped.
function traceRings(mask,width,height,bits){
 const stride=width+1,on=(x,y)=>x>=0&&y>=0&&x<width&&y<height&&(mask[y*width+x]&bits)!==0,unused=new Set(),starts=[];
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){if(!(mask[y*width+x]&bits))continue;
  if(!on(x,y-1))starts.push((y*stride+x)*4);if(!on(x+1,y))starts.push((y*stride+x+1)*4+1);
  if(!on(x,y+1))starts.push(((y+1)*stride+x+1)*4+2);if(!on(x-1,y))starts.push(((y+1)*stride+x)*4+3);}
 starts.sort((a,b)=>a-b);for(const key of starts)unused.add(key);
 const step=[1,stride,-1,-stride],rings=[];
 for(const first of starts){if(!unused.has(first))continue;const path=[];let key=first,heading=-1;
  for(;;){unused.delete(key);const direction=key&3;let vertex=(key-direction)/4;
   if(direction!==heading){path.push([vertex%stride,Math.floor(vertex/stride)]);heading=direction;}
   vertex+=step[direction];let next=-1;
   for(const turn of [1,0,3]){const candidate=vertex*4+(direction+turn)%4;if(unused.has(candidate)||candidate===first){next=candidate;break;}}
   if(next<0)fail('Mask outline is not closed.');key=next;if(key===first)break;}
  rings.push(path);}
 return rings;
}
function signedArea(path){let sum=0;for(let i=0,n=path.length;i<n;i++){const a=path[i],b=path[(i+1)%n];sum+=a[0]*b[1]-b[0]*a[1];}return sum/2;}
function simplifyOpen(points,tolerance){
 const count=points.length;if(count<=2||tolerance<=0)return points.map(p=>[p[0],p[1]]);
 const keep=new Uint8Array(count);keep[0]=keep[count-1]=1;const stack=[[0,count-1]];
 while(stack.length){const [i,j]=stack.pop();if(j-i<2)continue;const cx=points[j][0]-points[i][0],cy=points[j][1]-points[i][1],square=cx*cx+cy*cy;let best=-1,far=-1;
  for(let k=i+1;k<j;k++){const rx=points[k][0]-points[i][0],ry=points[k][1]-points[i][1];let along=square?(rx*cx+ry*cy)/square:0;along=Math.min(1,Math.max(0,along));const gx=rx-along*cx,gy=ry-along*cy,d=Math.floor(Math.sqrt(gx*gx+gy*gy)*1e6+.5);if(d>far){far=d;best=k;}}   // rounded to a millionth of a pixel, first of equals wins, as in the Python tool
  if(far>tolerance*1e6){keep[best]=1;stack.push([i,best]);stack.push([best,j]);}}
 const out=[];for(let i=0;i<count;i++)if(keep[i])out.push([points[i][0],points[i][1]]);return out;
}
function simplifyClosed(path,tolerance){
 if(path.length<=4||tolerance<=0)return path.map(p=>[p[0],p[1]]);
 let far=0,best=-1;for(let i=0;i<path.length;i++){const dx=path[i][0]-path[0][0],dy=path[i][1]-path[0][1],d=dx*dx+dy*dy;if(d>best){best=d;far=i;}}
 const first=simplifyOpen(path.slice(0,far+1),tolerance),second=simplifyOpen([...path.slice(far),path[0]],tolerance),out=[...first.slice(0,-1),...second.slice(0,-1)];
 return out.length>=3?out:path.map(p=>[p[0],p[1]]);
}
function inside(point,path){let odd=false;const x=point[0],y=point[1];for(let i=0,n=path.length,j=n-1;i<n;j=i++){const a=path[i],b=path[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])odd=!odd;}return odd;}
function boundsOf(path){let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(const p of path){x0=Math.min(x0,p[0]);y0=Math.min(y0,p[1]);x1=Math.max(x1,p[0]);y1=Math.max(y1,p[1]);}return [x0,y0,x1,y1];}
// Separate parts of the pixels where (mask & bits) is set: outer outline and holes, largest first, each simplified.
function split(mask,width,height,bits,parameters,um2){
 const rings=traceRings(mask,width,height,bits).map((path,order)=>({path,order,area:signedArea(path)}));
 const outers=rings.filter(r=>r.area>0).map(r=>({...r,bounds:boundsOf(r.path),holes:[]})),holes=rings.filter(r=>r.area<0);
 for(const hole of holes){const probe=[hole.path[0][0]+.5,hole.path[0][1]-.5];let owner=null;   // a point just outside the hole's top edge, inside the part
  for(const outer of outers)if(inside(probe,outer.path)&&(!owner||outer.area<owner.area))owner=outer;
  if(!owner)fail('A hole belongs to no part.');owner.holes.push(hole);}
 for(const outer of outers)outer.pixels=Math.round(outer.area+outer.holes.reduce((n,h)=>n+h.area,0));
 outers.sort((a,b)=>b.pixels-a.pixels||a.bounds[0]-b.bounds[0]||a.bounds[1]-b.bounds[1]||a.bounds[2]-b.bounds[2]||a.bounds[3]-b.bounds[3]);
 const out=[],dropped={parts:0,part_px:0,holes:0,hole_px:0,small_secondary_parts:0,small_secondary_part_um2:0,largest_left_out_um2:0},limit=parameters.drop_secondary_parts_below_um2||0;
 outers.forEach((part,index)=>{
  if(part.pixels<parameters.min_part_area_px){dropped.parts++;dropped.part_px+=part.pixels;return;}
  if(index&&um2&&part.pixels*um2<limit){dropped.small_secondary_parts++;dropped.small_secondary_part_um2+=part.pixels*um2;dropped.largest_left_out_um2=Math.max(dropped.largest_left_out_um2,part.pixels*um2);return;}
  const sized=part.holes.map(h=>({size:-h.area,path:h.path,order:h.order})).sort((a,b)=>b.size-a.size||a.order-b.order),kept=[];
  for(const hole of sized){if(hole.size<parameters.min_hole_area_px){dropped.holes++;dropped.hole_px+=Math.round(hole.size);continue;}kept.push(simplifyClosed(hole.path,parameters.simplify_tolerance_px));}
  out.push({outer:simplifyClosed(part.path,parameters.simplify_tolerance_px),holes:kept,area_px:part.pixels,vertices_before:part.path.length});});
 return {parts:out,dropped,separate_parts_before:outers.filter(p=>p.pixels>=parameters.min_part_area_px).length};
}
/* layers: {CB:[paths], GL:[paths], WM:[paths]} in original image pixels, even-odd; pl: one open path or null.
   Returns the polygons to write and a summary. */
function editable(layers,width,height,options={}){
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>LIMITS.pixels)fail('The image size is not supported.');
 const parameters={...PARAMETERS,...(options.parameters||{})},um2=options.um2||null,mask=new Uint8Array(width*height);
 if(!layers||!Array.isArray(layers.CB)||!layers.CB.length||!Array.isArray(layers.GL)||!layers.GL.length)fail('A Cb and a GL outline are needed.');
 // A layer is one ROI (a list of rings) or several ROIs (a list of such lists); each ROI is filled on its own and they add up.
 const sets=layer=>!layer||!layer.length?[]:Array.isArray(layer[0][0][0])?layer:[layer];
 for(const [layer,bit] of [[layers.CB,1],[layers.GL,2],[layers.WM,4]])for(const paths of sets(layer))rasterInto(mask,width,height,paths,bit);
 const polygons=[],summary={};
 for(const [name,bits] of [['Cb',1],['GL+WM',6],['WM',4]]){
  const found=split(mask,width,height,bits,parameters,um2);
  found.parts.forEach((part,index)=>{const base=name+'_part'+String(index+1).padStart(2,'0');polygons.push({name:base,kind:'polygon',path:part.outer});
   part.holes.forEach((hole,h)=>polygons.push({name:base+'_hole'+String(h+1).padStart(2,'0'),kind:'polygon',path:hole}));});
  summary[name]={parts:found.parts.length,separate_parts_before:found.separate_parts_before,holes:found.parts.reduce((n,p)=>n+p.holes.length,0),
   vertices_before:found.parts.reduce((n,p)=>n+p.vertices_before,0),vertices_after:found.parts.reduce((n,p)=>n+p.outer.length,0),left_out_as_too_small:found.dropped};
 }
 if(options.pl&&options.pl.length>=2){polygons.push({name:'PL_TOTAL',kind:'polyline',path:options.pl.map(p=>[p[0],p[1]])});summary.PL_TOTAL={kind:'polyline',vertices:options.pl.length};}
 for(const polygon of polygons)if(polygon.path.length>LIMITS.polygon_vertices||!polygon.path.every(p=>Number.isInteger(p[0])&&Number.isInteger(p[1])&&p[0]>=0&&p[1]>=0&&p[0]<=32767&&p[1]<=32767)&&polygon.kind==='polygon')fail('A polygon cannot be written as an ImageJ ROI.');
 return {polygons,summary,parameters};
}
// One ImageJ ROI: polygon (type 0) or polyline (type 5), whole-pixel vertices.
function encodeROI(name,kind,path){
 if(!['polygon','polyline'].includes(kind)||path.length<(kind==='polygon'?3:2)||path.length>LIMITS.polygon_vertices)fail('ROI '+name+' cannot be written.');
 const b=boundsOf(path),left=Math.floor(b[0]),top=Math.floor(b[1]),bytes=new Uint8Array(64+path.length*4+64+name.length*2),view=new DataView(bytes.buffer);
 bytes.set([73,111,117,116]);view.setUint16(4,228);bytes[6]=kind==='polygon'?0:5;
 view.setInt16(8,top);view.setInt16(10,left);view.setInt16(12,Math.ceil(b[3]));view.setInt16(14,Math.ceil(b[2]));view.setUint16(16,path.length);
 path.forEach((p,i)=>{if(!Number.isInteger(p[0])||!Number.isInteger(p[1]))fail('ROI '+name+' needs whole-pixel vertices.');view.setInt16(64+i*2,p[0]-left);view.setInt16(64+path.length*2+i*2,p[1]-top);});
 const second=64+path.length*4;view.setInt32(60,second);view.setInt32(second+16,second+64);view.setInt32(second+20,name.length);
 for(let i=0;i<name.length;i++)view.setUint16(second+64+i*2,name.charCodeAt(i));
 return bytes;
}
// Model ML within `steps` pixels of GL, measured through ML only; growth alternates 4- and 8-neighbour steps.
function purkinjeBand(labels,width,height,steps){
 const reach=new Uint8Array(width*height),band=new Uint8Array(width*height);let any=false,edge=[];
 for(let i=0;i<labels.length;i++)if(labels[i]===2){reach[i]=1;any=true;}
 if(steps<=0||!any||!labels.includes(1))return {band,pixels:0};
 const open=(x,y)=>x>=0&&y>=0&&x<width&&y<height&&labels[y*width+x]===1&&!reach[y*width+x];
 const pending=i=>{const x=i%width,y=(i-x)/width;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if((dx||dy)&&open(x+dx,y+dy))return true;return false;};
 for(let i=0;i<reach.length;i++)if(reach[i]&&pending(i))edge.push(i);
 let pixels=0;
 for(let step=0;step<steps&&edge.length;step++){const eight=step%2===1,added=[];
  for(const i of edge){const x=i%width,y=(i-x)/width;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){if(!(dx||dy)||(!eight&&dx&&dy))continue;if(open(x+dx,y+dy)){const j=(y+dy)*width+x+dx;if(band[j]!==2){band[j]=2;added.push(j);}}}}
  for(const j of added){reach[j]=1;band[j]=1;pixels++;}
  edge=[...edge.filter(pending),...added.filter(pending)];}
 return {band,pixels};
}
/* polygons: [{name, kind:'area'|'polyline', paths:[...]}] as read from a corrected ROI file. Every area named after an outline adds
   to it unless its name says hole. Returns the layer outlines as pixel-edge rings and what was done. */
function rebuild(polygons,width,height,options={}){
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>LIMITS.pixels)fail('The image size is not supported.');
 const add=new Uint8Array(width*height),cut=new Uint8Array(width*height),bit={Cb:1,'GL+WM':2,WM:4},used={Cb:{added:[],holes:[]},'GL+WM':{added:[],holes:[]},WM:{added:[],holes:[]}},ignored=[];let line=null,lines=0;
 for(const roi of polygons){
  if(roi.name==='PL_TOTAL'){lines++;if(roi.kind!=='polyline'||roi.paths.length!==1)fail('A corrected file may hold one PL_TOTAL line.');line=roi.paths[0];continue;}
  const match=/^(Cb|GL\+WM|WM)(?:_.*)?$/.exec(roi.name);if(!match||roi.kind!=='area'){ignored.push(roi.name);continue;}
  const hole=roi.name.toLowerCase().includes('hole');rasterInto(hole?cut:add,width,height,roi.paths,bit[match[1]]);used[match[1]][hole?'holes':'added'].push(roi.name);}
 if(lines>1)fail('A corrected file may hold one PL_TOTAL line.');
 if(!used.Cb.added.length||!used['GL+WM'].added.length)fail('The corrected file needs at least one Cb and one GL+WM polygon.');
 const labels=new Uint8Array(width*height);let outside=0,stray=0;
 for(let i=0;i<labels.length;i++){const have=add[i]&~cut[i],cb=have&1,inner=have&2,white=have&4;
  if(inner&&!cb)outside++;if(white&&!(inner&&cb))stray++;
  labels[i]=cb?(inner?(white?3:2):1):0;}
 const bandPx=Math.round((options.pl_band_width_um||0)*(options.pixels_per_micron||0)),grown=purkinjeBand(labels,width,height,bandPx),layerMask=new Uint8Array(width*height);
 for(let i=0;i<labels.length;i++){const v=labels[i];if(!v)continue;layerMask[i]=8|(v===1&&grown.band[i]!==1?1:0)|(v===2?2:0)|(v===3?4:0);}
 const rings={CB:traceRings(layerMask,width,height,8),ML:traceRings(layerMask,width,height,1),GL:traceRings(layerMask,width,height,2),WM:traceRings(layerMask,width,height,4)};
 const count=value=>{let n=0;for(let i=0;i<labels.length;i++)if(labels[i]===value)n++;return n;};
 return {rings,pl:line,labels,how:{rois_used:used,rois_ignored:ignored,clipped_to_keep_layers_nested:{gl_wm_outside_cb_px:outside,wm_outside_gl_wm_px:stray},
  purkinje_band:{width_um:options.pl_band_width_um||0,pixels:grown.pixels},pixels:{ML:count(1)-grown.pixels,GL:count(2),WM:count(3),CB:count(1)+count(2)+count(3)}}};
}
const api=Object.freeze({OUTLINES,PARAMETERS,LIMITS,editable,rebuild,encodeROI,rasterInto,traceRings,simplifyClosed,purkinjeBand,signedArea});
root.EditableROICore=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:window);
