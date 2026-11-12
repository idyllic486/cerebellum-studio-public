/* Physical-coordinate contour interpolation and rigid reference registration.
 * Meshes are parameter-dependent reconstructions, never recovered observations.
 */
(function(root){'use strict';
const VERSION='cerebellum-physical-reconstruction/1';
const LIMITS=Object.freeze({sections:128,roiVertices:100000,vertices:2000000,planes:512,triangles:400000,atlasVertices:300000,atlasTriangles:600000,coordinate:1e8});
const fail=m=>{throw Error(m);},finite=n=>typeof n==='number'&&Number.isFinite(n),copy=x=>JSON.parse(JSON.stringify(x));
const coordinate=n=>finite(n)&&Math.abs(n)<=LIMITS.coordinate;
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],sub=(a,b)=>a.map((v,i)=>v-b[i]),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function normalize(series){
 if(!series||series.unit!=='um'||!Array.isArray(series.sections)||series.sections.length<2||series.sections.length>LIMITS.sections)fail('Physical reconstruction requires 2–128 sections with XY and Z expressed in µm.');
 const ids=new Set(),orders=new Set();let vertices=0;
 const sections=series.sections.map((s,i)=>{const z=s.z_um,order=s.order===undefined?i:s.order;
  if(typeof s.id!=='string'||!s.id||s.id.length>200||ids.has(s.id))fail('Observed section IDs must be unique.');ids.add(s.id);
  if(!Number.isSafeInteger(order)||order<0||orders.has(order)||!coordinate(z))fail('Each section requires a unique order and a finite actual Z in µm.');orders.add(order);
  if(s.included===false)fail('Exclude sections explicitly in the study before preparing the physical series.');
  if(!Array.isArray(s.rois)||!s.rois.length)fail(s.id+': a selected area ROI is missing; absence is not zero.');
  const rois=s.rois.map(r=>{if(!r||r.kind!=='area'||r.closed===false||!Array.isArray(r.paths)||!r.paths.length)fail(s.id+': only closed area ROIs are reconstructed.');let roiVertices=0;
   const paths=r.paths.map(p=>{if(!Array.isArray(p)||p.length<3)fail('An area contour requires at least three points.');roiVertices+=p.length;vertices+=p.length;if(roiVertices>LIMITS.roiVertices)fail('An ROI exceeds 100,000 vertices; originals have not been simplified.');if(vertices>LIMITS.vertices)fail('Physical series exceeds two million vertices; originals have not been simplified.');return p.map(q=>{if(!Array.isArray(q)||q.length!==2||!q.every(coordinate))fail('ROI XY coordinates must be finite physical µm values.');return q.slice();});});
   return {name:typeof r.name==='string'?r.name:'area',label:typeof r.label==='string'?r.label:null,kind:'area',closed:true,paths};});
  return {id:s.id,order,z_um:z,rois,source:s.source?copy(s.source):null};
 }).sort((a,b)=>a.order-b.order);
 for(let i=1;i<sections.length;i++)if(sections[i].z_um<=sections[i-1].z_um)fail('Physical Z must increase with section order. Reversed or duplicate depths are not repaired automatically.');
 return {sections,provenance:series.provenance?copy(series.provenance):{},vertices};
}
function configuration(options={}){const size=options.gridSize===undefined?(options.grid===undefined?64:options.grid):options.gridSize,subdivisions=options.subdivisions===undefined?3:options.subdivisions,endcaps=options.endcaps===undefined?false:options.endcaps;
 if(![32,64,96].includes(size))fail('Reconstruction grid must be 32, 64 or 96 cells per XY axis.');
 if(!Number.isInteger(subdivisions)||subdivisions<1||subdivisions>8)fail('Use 1–8 depth subdivisions per observed interval.');
 if(typeof endcaps!=='boolean')fail('End-cap display must be explicitly true or false.');return{size,subdivisions,endcaps};}
function gridFor(sections,size){let xmin=Infinity,ymin=Infinity,xmax=-Infinity,ymax=-Infinity;
 for(const s of sections)for(const r of s.rois)for(const p of r.paths)for(const [x,y]of p){xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);ymin=Math.min(ymin,y);ymax=Math.max(ymax,y);}
 const extent=Math.max(xmax-xmin,ymax-ymin);if(!(extent>0))fail('Physical contours have no XY extent.');
 const side=extent*1.24,spacing=side/size,origin=[(xmin+xmax-side)/2,(ymin+ymax-side)/2];
 if(!finite(spacing)||spacing<=0||origin.some(v=>v+spacing===v))fail('Coordinates exceed grid numerical precision.');
 return{size,width:size+1,height:size+1,origin,spacing_um:spacing,extent_um:side};}
function raster(rois,grid){const {width,height,origin,spacing_um:spacing}=grid,mask=new Uint8Array(width*height);
 for(const roi of rois)for(let row=0;row<height;row++){const y=origin[1]+row*spacing,xs=[];
  for(const path of roi.paths)for(let i=0,j=path.length-1;i<path.length;j=i++){const a=path[j],b=path[i];if((a[1]>y)!==(b[1]>y))xs.push(a[0]+(y-a[1])*(b[0]-a[0])/(b[1]-a[1]));}
  xs.sort((a,b)=>a-b);for(let i=0;i+1<xs.length;i+=2){const from=Math.max(0,Math.ceil((xs[i]-origin[0])/spacing)),to=Math.min(width,Math.ceil((xs[i+1]-origin[0])/spacing));for(let col=from;col<to;col++)mask[row*width+col]=1;}
 }return mask;}
// Exact squared Euclidean distance transform on the XY sampling lattice.
function edt1(f,n){const d=new Float64Array(n),v=new Int32Array(n),z=new Float64Array(n+1);let k=0;v[0]=0;z[0]=-Infinity;z[1]=Infinity;
 for(let q=1;q<n;q++){let s;do{s=((f[q]+q*q)-(f[v[k]]+v[k]*v[k]))/(2*q-2*v[k]);if(s<=z[k])k--;else break;}while(k>=0);if(k<0){k=0;v[0]=q;z[0]=-Infinity;z[1]=Infinity;}else{k++;v[k]=q;z[k]=s;z[k+1]=Infinity;}}
 k=0;for(let q=0;q<n;q++){while(z[k+1]<q)k++;d[q]=(q-v[k])**2+f[v[k]];}return d;}
function distance(mask,n,target){const temp=new Float64Array(mask.length),out=new Float64Array(mask.length),f=new Float64Array(n);for(let y=0;y<n;y++){for(let x=0;x<n;x++)f[x]=mask[y*n+x]===target?0:1e12;temp.set(edt1(f,n),y*n);}for(let x=0;x<n;x++){for(let y=0;y<n;y++)f[y]=temp[y*n+x];const d=edt1(f,n);for(let y=0;y<n;y++)out[y*n+x]=Math.sqrt(d[y]);}return out;}
function signedField(mask,grid){const n=mask.reduce((a,b)=>a+b,0);if(!n)fail('An observed ROI disappears at this grid resolution. Increase resolution or use a different selected region; it has not been replaced by zero.');const a=distance(mask,grid.width,0),b=distance(mask,grid.width,1);return Float64Array.from(a,(v,i)=>(v-b[i])*grid.spacing_um);}
function prepare(series,options={}){const normalized=normalize(series),config=configuration(options);if((normalized.sections.length-1)*config.subdivisions+1>LIMITS.planes)fail('Reconstruction exceeds 512 depth planes; reduce depth subdivisions.');
 const grid=gridFor(normalized.sections,config.size),observed=normalized.sections.map(s=>{const mask=raster(s.rois,grid);return {...s,mask,field:signedField(mask,grid)};});
 return {version:VERSION,config,grid,sections:normalized.sections,observed,provenance:normalized.provenance,vertices:normalized.vertices};}
function sample(prepared,z){if(!coordinate(z))fail('Cut depth must be a finite physical Z in µm.');const list=prepared.observed,lo=list[0].z_um,hi=list.at(-1).z_um;
 if(z<lo||z>hi)fail('The cut lies outside the observed depth span. Extrapolation is not provided.');
 const exact=list.find(s=>s.z_um===z);if(exact)return {z_um:exact.z_um,kind:'observed',source_ids:[exact.id],fraction:0,field:exact.field,observed_rois:exact.rois};
 let right=list.findIndex(s=>s.z_um>z);if(right<1)fail('A cut needs observed planes on both sides.');const a=list[right-1],b=list[right],t=(z-a.z_um)/(b.z_um-a.z_um);
 return {z_um:z,kind:'interpolated',source_ids:[a.id,b.id],fraction:t,field:Float64Array.from(a.field,(v,i)=>(1-t)*v+t*b.field[i]),observed_rois:null};}
function cutPrepared(prepared,z){const s=sample(prepared,z),g=prepared.grid,segments=[],n=g.width,xy=i=>[g.origin[0]+(i%n)*g.spacing_um,g.origin[1]+Math.floor(i/n)*g.spacing_um];
 for(let y=0;y<n-1;y++)for(let x=0;x<n-1;x++){const a=y*n+x,b=a+1,c=a+n+1,d=a+n;for(const tri of [[a,b,c],[a,c,d]]){const points=[];for(let k=0;k<3;k++){const i=tri[k],j=tri[(k+1)%3],v=s.field[i],w=s.field[j];if((v>=0)!==(w>=0)){const t=v/(v-w),p=xy(i),q=xy(j);points.push([p[0]+t*(q[0]-p[0]),p[1]+t*(q[1]-p[1])]);}}if(points.length===2&&Math.hypot(points[0][0]-points[1][0],points[0][1]-points[1][1])>1e-12)segments.push(points);}}
 return{version:VERSION,unit:'um',z_um:s.z_um,kind:s.kind,source_ids:s.source_ids,fraction:s.fraction,grid:copy(g),mask:Array.from(s.field,v=>v>=0?1:0),segments,observed_rois:s.observed_rois?copy(s.observed_rois):null,measurement:false,interpretation:'Grid-derived section for display; exact original contours are supplied separately at observed depths.'};}
const TETRA=[[0,1,2,6],[0,2,3,6],[0,3,7,6],[0,7,4,6],[0,4,5,6],[0,5,1,6]];
function meshPrepared(prepared){const {grid:g,config,observed}=prepared,n=g.width,planeSize=n*n,planes=[];
 for(let i=0;i<observed.length-1;i++)for(let j=0;j<config.subdivisions;j++){const z=j===0?observed[i].z_um:observed[i].z_um+(observed[i+1].z_um-observed[i].z_um)*j/config.subdivisions;planes.push(sample(prepared,z));}planes.push(sample(prepared,observed.at(-1).z_um));
 const positions=[],indices=[],triangle_kind=[],cache=new Map();
 const position=i=>{const p=Math.floor(i/planeSize),q=i%planeSize;return[g.origin[0]+(q%n)*g.spacing_um,g.origin[1]+Math.floor(q/n)*g.spacing_um,planes[p].z_um];};
 const value=i=>planes[Math.floor(i/planeSize)].field[i%planeSize];
 function vertex(i,j){const a=value(i),b=value(j),t=a/(a-b),key=t===0?'n'+i:t===1?'n'+j:i<j?i+':'+j:j+':'+i;if(cache.has(key))return cache.get(key);const p=position(i),q=position(j),index=positions.length/3;positions.push(p[0]+t*(q[0]-p[0]),p[1]+t*(q[1]-p[1]),p[2]+t*(q[2]-p[2]));cache.set(key,index);return index;}
 function node(i){const key='n'+i;if(cache.has(key))return cache.get(key);const index=positions.length/3;positions.push(...position(i));cache.set(key,index);return index;}
 const at=i=>positions.slice(3*i,3*i+3);
 function triangle(a,b,c,inside,kind=0,outward=null){if(a===b||b===c||a===c)return;const pa=at(a),pb=at(b),pc=at(c),normal=cross(sub(pb,pa),sub(pc,pa));if(dot(normal,normal)<=1e-24)return;
  const direction=outward||sub(pa,inside);if(dot(normal,direction)<0)[b,c]=[c,b];if(triangle_kind.length>=LIMITS.triangles)fail('Mesh exceeds 400,000 triangles. Reduce resolution or subdivisions; source contours are retained.');indices.push(a,b,c);triangle_kind.push(kind);}
 for(let p=0;p<planes.length-1;p++)for(let y=0;y<n-1;y++)for(let x=0;x<n-1;x++){
  const a=p*planeSize+y*n+x,b=a+planeSize,cube=[a,a+1,a+n+1,a+n,b,b+1,b+n+1,b+n],signs=cube.map(i=>value(i)>=0);if(signs.every(Boolean)||signs.every(v=>!v))continue;
  for(const t of TETRA){const positive=t.filter(i=>signs[i]).map(i=>cube[i]),negative=t.filter(i=>!signs[i]).map(i=>cube[i]);if(!positive.length||!negative.length)continue;const inside=[0,0,0];for(const i of positive){const pt=position(i);for(let k=0;k<3;k++)inside[k]+=pt[k]/positive.length;}
   if(positive.length===1){const ids=negative.map(i=>vertex(positive[0],i));triangle(...ids,inside);}
   else if(positive.length===3){const ids=positive.map(i=>vertex(i,negative[0]));triangle(...ids,inside);}
   else{const[a,b]=positive,[c,d]=negative,ac=vertex(a,c),ad=vertex(a,d),bc=vertex(b,c),bd=vertex(b,d);triangle(ac,ad,bd,inside);triangle(ac,bd,bc,inside);}
  }
 }
 if(config.endcaps)for(const p of [0,planes.length-1])for(let y=0;y<n-1;y++)for(let x=0;x<n-1;x++){
  const a=p*planeSize+y*n+x,b=a+1,c=a+n+1,d=a+n;
  for(const tri of [[a,b,c],[a,c,d]]){const polygon=[];for(let k=0;k<3;k++){const i=tri[k],j=tri[(k+1)%3];if(value(i)>=0)polygon.push(node(i));if((value(i)>=0)!==(value(j)>=0))polygon.push(vertex(i,j));}for(let k=1;k<polygon.length-1;k++)triangle(polygon[0],polygon[k],polygon[k+1],null,1,[0,0,p===0?-1:1]);}
 }
 if(!indices.length)fail('No surface was generated at this resolution.');
 const min=[Infinity,Infinity,observed[0].z_um],max=[-Infinity,-Infinity,observed.at(-1).z_um];for(let i=0;i<positions.length;i+=3)for(let k=0;k<3;k++){min[k]=Math.min(min[k],positions[i+k]);max[k]=Math.max(max[k],positions[i+k]);}
 const intervals=observed.slice(1).map((s,i)=>({left:observed[i].id,right:s.id,z_min_um:observed[i].z_um,z_max_um:s.z_um,gap_um:s.z_um-observed[i].z_um,interior:'unobserved_interpolation',order_gap:s.order-observed[i].order}));
 return{version:VERSION,unit:'um',positions,indices,triangle_kind,observedContours:prepared.sections.map(s=>({id:s.id,order:s.order,z_um:s.z_um,rois:s.rois,source:s.source})),planes:planes.map(({field,observed_rois,...s})=>s),grid:copy(g),bounds:{min,max},display_transform:{center_um:min.map((v,k)=>(v+max[k])/2),uniform_scale:1/Math.max(...max.map((v,k)=>v-min[k]))},provenance:{...copy(prepared.provenance),method:'linear signed-distance interpolation + marching tetrahedra',grid_size:config.size,subdivisions:config.subdivisions,endcaps:config.endcaps?'synthetic display closure at observed endpoints':'none; ends remain open',native_volume_from_mesh:false,intervals,observed_vertex_count:prepared.vertices},warnings:['All mesh triangles are reconstructed geometry; original observations remain separate contour overlays.','No geometry is extrapolated outside the first and last observed depths.','Small structures and holes may disappear at the selected XY resolution.','XY and Z use the same physical unit; use one uniform scale for display.','The mesh is not a validated anatomical recovery or a volume measurement.',...(config.endcaps?['End caps are synthetic display closure, not evidence that the full organ was sampled.']:[])]};
}
// Observed non-area annotations stay traces/points; they do not imply tissue thickness or a surface.
function observedStructure(series){
 if(!series||series.unit!=='um'||!Array.isArray(series.sections)||series.sections.length<2||series.sections.length>LIMITS.sections)fail('At least two physical sections in µm are required.');
 const sections=copy(series.sections).sort((a,b)=>a.order-b.order),ids=new Set(),orders=new Set(),kinds=new Set(),min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];let count=0;
 for(let i=0;i<sections.length;i++){const s=sections[i];if(typeof s.id!=='string'||!s.id||ids.has(s.id)||!Number.isSafeInteger(s.order)||s.order<0||orders.has(s.order)||!coordinate(s.z_um)||i&&s.z_um<=sections[i-1].z_um)fail('Observed sections need unique IDs, unique order and increasing measured Z.');ids.add(s.id);orders.add(s.order);
  if(!Array.isArray(s.rois)||!s.rois.length)fail('A selected observed structure is missing.');
  for(const r of s.rois){if(!['polyline','point'].includes(r.kind)||r.closed!==false||!Array.isArray(r.paths)||!r.paths.length)fail('Observed-only structure requires open polylines or points.');kinds.add(r.kind);let roiCount=0;for(const path of r.paths){if(!Array.isArray(path)||path.length<(r.kind==='polyline'?2:1))fail('Observed structure path has too few vertices.');roiCount+=path.length;count+=path.length;if(roiCount>LIMITS.roiVertices||count>LIMITS.vertices)fail('Observed structure exceeds vertex limits; originals have not been simplified.');for(const p of path){if(!Array.isArray(p)||p.length!==2||!p.every(coordinate))fail('Observed structure needs finite XY coordinates in µm.');[...p,s.z_um].forEach((v,k)=>{min[k]=Math.min(min[k],v);max[k]=Math.max(max[k],v);});}}}
 }
 if(kinds.size!==1)fail('Observed structure types must be consistent across sections.');
 return {version:VERSION,unit:'um',positions:[],indices:[],triangle_kind:[],observedContours:sections.map(s=>({id:s.id,order:s.order,z_um:s.z_um,rois:s.rois,source:s.source??null})),planes:sections.map(s=>({z_um:s.z_um,kind:'observed',source_ids:[s.id],fraction:0})),bounds:{min,max},provenance:{...copy(series.provenance||{}),method:'observed physical annotations only',native_volume_from_mesh:false,interpolation:false,geometry_kind:[...kinds][0],observed_vertex_count:count},warnings:['Only measured section annotations are shown. Lines and points are not converted into tissue area or volume.','No connection, thickness or surface is inferred between these observed annotations.','XY and Z use the same physical unit; use one uniform scale for display.']};
}
function observedCSV(result){
 if(result?.unit!=='um'||!Array.isArray(result.observedContours))fail('Physical observed contours are required.');
 const cell=value=>'"'+String(value??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"',lines=[],encoder=new TextEncoder();let bytes=0;
 const row=values=>{const line=values.map(value=>typeof value==='number'?String(value):cell(value)).join(',')+'\r\n';bytes+=encoder.encode(line).byteLength;if(bytes>64*1024*1024)fail('Observed contour CSV exceeds 64 MiB. Select a smaller structure; no partial file was exported.');lines.push(line);};
 row(['animal_id','structure','section_id','source_sha256','roi_name','geometry_kind','path_index','vertex_index','x_um','y_um','z_um','evidence','review_status','anatomy_scope']);
 for(const plane of result.observedContours)for(const roi of plane.rois)roi.paths.forEach((path,j)=>path.forEach(([x,y],k)=>{if(![x,y,plane.z_um].every(coordinate))fail('Observed contour coordinates are invalid.');row([result.provenance?.animal_id,result.provenance?.structure_selection?.name??result.provenance?.structure_selection?.region??result.provenance?.layer,plane.id,plane.source?.sha256,roi.name,roi.kind,j,k,x,y,plane.z_um,'observed_section',result.provenance?.approval_states?.find(state=>state.id===plane.id)?.status??'unknown',result.provenance?.structure_selection?.anatomy_scope??'selected annotated ROI; completeness not established']);}));
 return lines.join('');
}
function surfaceOBJ(result){
 if(result?.unit!=='um'||!Array.isArray(result.positions)||result.positions.length%3||!result.positions.length||!result.positions.every(coordinate)||!Array.isArray(result.indices)||!result.indices.length||result.indices.length%3||result.indices.length/3>LIMITS.triangles||result.indices.some(i=>!Number.isSafeInteger(i)||i<0||i>=result.positions.length/3))fail('An inferred physical surface mesh is required.');
 const lines=['# Cerebellum Studio: inferred surface; units micrometres (um).','# Observed contours are exported separately. Mesh geometry is not a native volume measurement.','# '+JSON.stringify({animal_id:result.provenance?.animal_id,structure_selection:result.provenance?.structure_selection,method:result.provenance?.method,source_sections:result.observedContours?.map(s=>({id:s.id,z_um:s.z_um,sha256:s.source?.sha256??null}))}),'o inferred_surface'];
 for(let i=0;i<result.positions.length;i+=3)lines.push('v '+result.positions.slice(i,i+3).join(' '));for(let i=0;i<result.indices.length;i+=3)lines.push('f '+result.indices.slice(i,i+3).map(n=>n+1).join(' '));return lines.join('\n')+'\n';
}
function reconstruct(series,options={}){return meshPrepared(prepare(series,options));}
function cut(series,z,options={}){return cutPrepared(prepare(series,options),z);}
function pointCloud(points,label){if(!Array.isArray(points)||points.length<3||points.length>100||points.some(p=>!Array.isArray(p)||p.length!==3||!p.every(coordinate)))fail(label+' requires 3–100 finite 3D landmarks in µm.');return points.map(p=>p.slice());}
function noncollinear(points){const first=points[0];let far=1;for(let i=2;i<points.length;i++)if(dot(sub(points[i],first),sub(points[i],first))>dot(sub(points[far],first),sub(points[far],first)))far=i;const u=sub(points[far],first),scale=dot(u,u);if(scale<=1e-20)return false;return points.some(p=>dot(cross(u,sub(p,first)),cross(u,sub(p,first)))>scale*scale*1e-16);}
function coplanar(points){const first=points[0];let u=null,normal=null;for(let i=1;i<points.length&&!normal;i++){const candidate=sub(points[i],first);if(!u&&dot(candidate,candidate)>1e-20)u=candidate;else if(u){const n=cross(u,candidate);if(dot(n,n)>dot(u,u)*dot(candidate,candidate)*1e-14)normal=n;}}if(!normal)return true;const scale=Math.max(...points.map(p=>Math.sqrt(dot(sub(p,first),sub(p,first)))));return points.every(p=>Math.abs(dot(normal,sub(p,first)))<=Math.sqrt(dot(normal,normal))*scale*1e-8);}
function maxEigenvector(matrix){const a=matrix.map(r=>r.slice()),v=Array.from({length:4},(_,i)=>Array.from({length:4},(_,j)=>i===j?1:0));
 for(let iter=0;iter<80;iter++){let p=0,q=1,big=Math.abs(a[0][1]);for(let i=0;i<4;i++)for(let j=i+1;j<4;j++)if(Math.abs(a[i][j])>big){p=i;q=j;big=Math.abs(a[i][j]);}if(big<=Math.max(1,...a.map((r,i)=>Math.abs(r[i])))*1e-14)break;
  const angle=.5*Math.atan2(2*a[p][q],a[q][q]-a[p][p]),c=Math.cos(angle),s=Math.sin(angle),app=a[p][p],aqq=a[q][q],apq=a[p][q];
  for(let k=0;k<4;k++)if(k!==p&&k!==q){const kp=a[k][p],kq=a[k][q];a[k][p]=a[p][k]=c*kp-s*kq;a[k][q]=a[q][k]=s*kp+c*kq;}
  a[p][p]=c*c*app-2*s*c*apq+s*s*aqq;a[q][q]=s*s*app+2*s*c*apq+c*c*aqq;a[p][q]=a[q][p]=0;
  for(let k=0;k<4;k++){const vp=v[k][p],vq=v[k][q];v[k][p]=c*vp-s*vq;v[k][q]=s*vp+c*vq;}
 }let k=0;for(let i=1;i<4;i++)if(a[i][i]>a[k][k])k=i;const out=v.map(r=>r[k]),norm=Math.hypot(...out);return out.map(n=>n/norm);}
function fitRigid(sourcePoints,targetPoints){const source=pointCloud(sourcePoints,'Source'),target=pointCloud(targetPoints,'Target');if(source.length!==target.length)fail('Landmark lists must have equal lengths and matching correspondence order.');if(!noncollinear(source)||!noncollinear(target))fail('At least three non-collinear landmarks are required in each coordinate system.');
 const center=points=>[0,1,2].map(k=>points.reduce((n,p)=>n+p[k],0)/points.length),a=center(source),b=center(target),h=Array.from({length:3},()=>[0,0,0]);for(let k=0;k<source.length;k++){const p=sub(source[k],a),q=sub(target[k],b);for(let i=0;i<3;i++)for(let j=0;j<3;j++)h[i][j]+=p[i]*q[j];}
 const [[xx,xy,xz],[yx,yy,yz],[zx,zy,zz]]=h,trace=xx+yy+zz,q=maxEigenvector([[trace,yz-zy,zx-xz,xy-yx],[yz-zy,xx-yy-zz,xy+yx,zx+xz],[zx-xz,xy+yx,-xx+yy-zz,yz+zy],[xy-yx,zx+xz,yz+zy,-xx-yy+zz]]),[w,x,y,z]=q;
 const rotation=[[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],[2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],[2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]],translation=b.map((v,i)=>v-dot(rotation[i],a)),apply=p=>rotation.map((r,i)=>dot(r,p)+translation[i]),residuals=source.map((p,i)=>Math.hypot(...sub(apply(p),target[i]))),rms=Math.sqrt(residuals.reduce((n,v)=>n+v*v,0)/residuals.length),span=Math.max(...target.map(p=>Math.hypot(...sub(p,b)))),flags=[];
 if(coplanar(source)||coplanar(target))flags.push('coplanar_landmarks_do_not_resolve_3D_handedness');if(rms>Math.max(1e-8,span*.05))flags.push('large_landmark_residual_review_correspondence_or_nonrigid_difference');
 const matrix=[rotation[0][0],rotation[1][0],rotation[2][0],0,rotation[0][1],rotation[1][1],rotation[2][1],0,rotation[0][2],rotation[1][2],rotation[2][2],0,...translation,1];
 return{version:'cerebellum-rigid-registration/1',unit:'um',rotation,translation,matrix,quaternion_wxyz:q,scale:1,determinant:1,landmarks:source.length,rms_error_um:rms,max_error_um:Math.max(...residuals),residuals_um:residuals,source_landmarks:source,target_landmarks:target,flags,interpretation:'Proper rigid least-squares fit only; no scaling, reflection, anatomical validation or modification of native ROI measurements.'};
}
function validateAtlas(atlas){if(!atlas||atlas.schema!=='cerebellum-atlas/1'||atlas.unit!=='um')fail('Atlas must use cerebellum-atlas/1 and physical µm coordinates.');const s=atlas.source;if(!s||typeof s.name!=='string'||!s.name.trim()||s.name.length>1024||typeof s.sha256!=='string'||! /^[a-f0-9]{64}$/i.test(s.sha256)||typeof s.license_note!=='string'||!s.license_note.trim()||s.license_note.length>4000)fail('Atlas source name, SHA-256 and licence/provenance note are required.');const m=atlas.mesh;if(!m||!Array.isArray(m.positions)||!m.positions.length||m.positions.length%3||m.positions.length/3>LIMITS.atlasVertices||!m.positions.every(coordinate)||!Array.isArray(m.indices)||!m.indices.length||m.indices.length%3||m.indices.length/3>LIMITS.atlasTriangles)fail('Invalid or oversized atlas mesh.');const n=m.positions.length/3;if(m.indices.some(i=>!Number.isInteger(i)||i<0||i>=n))fail('Atlas triangle indices are invalid.');for(let i=0;i<m.indices.length;i+=3){const[a,b,c]=m.indices.slice(i,i+3);if(a===b||b===c||a===c)fail('Atlas contains a degenerate triangle.');const pa=m.positions.slice(3*a,3*a+3),pb=m.positions.slice(3*b,3*b+3),pc=m.positions.slice(3*c,3*c+3);if(dot(cross(sub(pb,pa),sub(pc,pa)),cross(sub(pb,pa),sub(pc,pa)))<=1e-24)fail('Atlas contains a zero-area triangle.');}
 const landmarks=atlas.landmarks===undefined?[]:atlas.landmarks;if(!Array.isArray(landmarks)||landmarks.length>100)fail('Atlas landmarks exceed the supported count.');const ids=new Set();for(const p of landmarks){if(typeof p.id!=='string'||!p.id||p.id.length>200||ids.has(p.id)||!Array.isArray(p.position)||p.position.length!==3||!p.position.every(coordinate))fail('Invalid or duplicate atlas landmark.');ids.add(p.id);}
 return{schema:atlas.schema,unit:'um',source:copy(s),mesh:{positions:m.positions.slice(),indices:m.indices.slice()},landmarks:copy(landmarks)};
}
function validateRigid(t){if(!t||t.scale!==1||!Array.isArray(t.rotation)||t.rotation.length!==3||t.rotation.some(r=>!Array.isArray(r)||r.length!==3||!r.every(finite))||!Array.isArray(t.translation)||t.translation.length!==3||!t.translation.every(coordinate))fail('A proper rigid transform with scale exactly one is required.');const r=t.rotation;for(let i=0;i<3;i++)for(let j=0;j<3;j++)if(Math.abs(dot(r[i],r[j])-(i===j?1:0))>1e-8)fail('Registration rotation is not orthonormal.');if(Math.abs(dot(r[0],cross(r[1],r[2]))-1)>1e-8)fail('Reflection transforms are not supported.');return t;}
function transformAtlas(atlas,transform){const out=validateAtlas(atlas),t=validateRigid(transform),apply=p=>{const q=t.rotation.map((r,i)=>dot(r,p)+t.translation[i]);if(!q.every(coordinate))fail('Transformed atlas coordinates exceed supported bounds.');return q;};for(let i=0;i<out.mesh.positions.length;i+=3){const p=apply(out.mesh.positions.slice(i,i+3));for(let j=0;j<3;j++)out.mesh.positions[i+j]=p[j];}out.landmarks=out.landmarks.map(p=>({...p,position:apply(p.position)}));out.registration={rotation:copy(t.rotation),translation:t.translation.slice(),scale:1,scope:'Reference display only; native study geometry and volumes are unchanged.'};return out;}
const api=Object.freeze({VERSION,LIMITS,prepare,reconstruct,observedStructure,observedCSV,surfaceOBJ,cut,meshPrepared,cutPrepared,validateAtlas,fitRigid,transformAtlas});root.ReconstructionCore=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:window);
